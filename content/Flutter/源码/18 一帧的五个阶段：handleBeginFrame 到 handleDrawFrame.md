# 18 一帧的五个阶段：handleBeginFrame 到 handleDrawFrame

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/scheduler/binding.dart`（1470 行）

## 一、问题

引擎只有两个回调：`onBeginFrame` 和 `onDrawFrame`。但 `SchedulerPhase` 有五个值（`idle`、`transientCallbacks`、`midFrameMicrotasks`、`persistentCallbacks`、`postFrameCallbacks`）。

多出来的三个阶段从哪来？

常见错误直觉有两个：一是"一帧就是 `drawFrame`"（这只对应第三、四个阶段，它之前有整段动画回调，之后还有 post-frame 回调）；二是"`handleBeginFrame` 和 `handleDrawFrame` 是两个独立事件"——它们其实**必须严格交替**，中间的 `midFrameMicrotasks` 不是回调，而是"`handleBeginFrame` 返回、`handleDrawFrame` 还没被调用"这段**函数调用的间隙**。

Flutter 的一帧是"两次引擎调用 + 一次函数返回"，并不是"一个函数"。五个阶段里唯一没有代码可读的那个（`midFrameMicrotasks`），恰恰是唯一允许帧内 microtask 执行的窗口。

## 二、最小 Demo

在四类回调里各打印一次 `schedulerPhase`，就能把五个阶段全部点亮。`SchedulerBinding.instance` 要求 binding 已初始化，且测试环境里没有引擎 vsync——所以直接放进 `testWidgets`，用 `pump` 推进帧：

```dart
import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('一帧的五个阶段', (WidgetTester tester) async {
    final SchedulerBinding sb = SchedulerBinding.instance;

    // 1. 帧外：读到 idle
    debugPrint('before       : ${sb.schedulerPhase}');

    // 2. 常驻回调：每帧都跑，不需要重新注册
    sb.addPersistentFrameCallback((Duration ts) {
      debugPrint('persistent   : ${sb.schedulerPhase}');
    });

    // 3. 瞬态回调：帧最开始跑；下一次帧要重新注册
    sb.scheduleFrameCallback((Duration ts) {
      debugPrint('transient    : ${sb.schedulerPhase}');
      // 4. 从瞬态回调里排 microtask —— 这是进入 midFrameMicrotasks 的唯一方式
      scheduleMicrotask(() => debugPrint('microtask    : ${sb.schedulerPhase}'));
      // 5. 在瞬态回调里再注册一个瞬态回调：它会落到「下一帧」
      sb.scheduleFrameCallback((Duration ts2) {
        debugPrint('transient#2  : ${sb.schedulerPhase}');
      });
    });

    // 6. 帧后回调：本帧最末尾跑一次
    sb.addPostFrameCallback((Duration ts) {
      debugPrint('post-frame   : ${sb.schedulerPhase}');
    });

    await tester.pump();   // 第 1 帧：transient → microtask → persistent → post-frame
    await tester.pump();   // 第 2 帧：transient#2 在这里出现
  });
}
```

输出顺序就是这一帧的真实时间线：`transient → microtask → persistent → post-frame → idle`，`transient#2` 只在第二帧出现。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `scheduler/binding.dart:888` | `ensureFrameCallbacksRegistered`，把下面两个私有方法接到 `PlatformDispatcher` |
| `scheduler/binding.dart:1168` | `_handleBeginFrame`，引擎 `onBeginFrame` 的落点，含 warm-up 拦截 |
| `scheduler/binding.dart:1180` | `_handleDrawFrame`，引擎 `onDrawFrame` 的落点，含"热重载补帧"逻辑 |
| `scheduler/binding.dart:1226` | `handleBeginFrame`，阶段 1 的实体 |
| `scheduler/binding.dart:1338` | `handleDrawFrame`，阶段 3、4 的实体 |
| `scheduler/binding.dart:1339` | `assert(_schedulerPhase == SchedulerPhase.midFrameMicrotasks)`，两半帧的咬合点 |
| `scheduler/binding.dart:1255-1273` | 瞬态回调的"换表再遍历"与 `_removedIds` 过滤 |
| `scheduler/binding.dart:1037` | `scheduleWarmUpFrame`，绕过 vsync 的另一条入口 |
| `rendering/binding.dart:61` | `addPersistentFrameCallback(_handlePersistentFrameCallback)`，persistent 阶段的唯一 UI 入口 |
| `rendering/binding.dart:642` | `RendererBinding.drawFrame`，五个 flush 步骤 |
| `widgets/binding.dart:1536` | `WidgetsBinding.drawFrame`，build 与 finalize |
| `widgets/binding.dart:1477-1532` | 框架自己写的"一帧 10 个阶段"文档（与这里的 5 个阶段是**两个视角**） |

## 四、调用链

### 4.1 第一跳：引擎 → 私有包装

引擎只会调用注册在 `platformDispatcher` 上的两个回调，而它们不是 `handleBeginFrame` 本身：

```dart
// scheduler/binding.dart:888-891
void ensureFrameCallbacksRegistered() {
  platformDispatcher.onBeginFrame ??= _handleBeginFrame;
  platformDispatcher.onDrawFrame ??= _handleDrawFrame;
}
```

中间隔一层私有包装，是为了处理 warm-up 帧与引擎帧的竞争：

```dart
// scheduler/binding.dart:1168-1178
void _handleBeginFrame(Duration rawTimeStamp) {
  if (_warmUpFrame) {
    // "begin frame" 与 "draw frame" 必须严格交替，所以这里
    // _rescheduleAfterWarmUpFrame 不可能已经是 true。
    assert(!_rescheduleAfterWarmUpFrame);
    _rescheduleAfterWarmUpFrame = true;
    return;                       // ← 直接把引擎帧这一半丢掉
  }
  handleBeginFrame(rawTimeStamp);
}
```

`_handleDrawFrame`（`:1180`）是它的对偶：如果之前丢掉了 begin，就把 draw 也丢掉，改为在 post-frame 回调里补排一帧，并在补排前把 `_hasScheduledFrame` 清零（`:1193`）——否则 `scheduleFrame` 会被去重逻辑挡住。

`_warmUpFrame` 期间引擎帧会被**成对丢弃**而不是排队。这就是热重载时"没看到明显卡顿但状态已经刷新"的原因：warm-up 帧把 build/layout/paint 都做完了一次，真正的引擎帧只是把它发到 GPU。

### 4.2 阶段 1：`handleBeginFrame`

```dart
// scheduler/binding.dart:1226-1254（节选）
void handleBeginFrame(Duration? rawTimeStamp) {
  _frameTimelineTask?.start('Frame');
  _firstRawTimeStampInEpoch ??= rawTimeStamp;
  _currentFrameTimeStamp = _adjustForEpoch(rawTimeStamp ?? _lastRawTimeStamp);
  if (rawTimeStamp != null) {
    _lastRawTimeStamp = rawTimeStamp;
  }
  // ... 调试 banner ...
  assert(schedulerPhase == SchedulerPhase.idle);   // 1253
  _hasScheduledFrame = false;                      // 1254
```

三件事按顺序发生：

1. **时间戳折算**：`_adjustForEpoch`（`:1116`）把引擎的原始时间戳换成"本 epoch 内、且按 `timeDilation` 缩放"的值。`timeDilation` 改变时会触发 `resetEpoch`（`:1103`），保证回调看到的时间戳永远单调递增。
2. **清去重开关**：`_hasScheduledFrame = false`。这一行必须在这里——帧已经开始了，再去重就会挡住本帧内新提出的排帧请求。
3. **断言 phase 是 idle**：如果上一帧没把 phase 复位就再次进来，这里会直接炸。

然后进入瞬态阶段：

```dart
// scheduler/binding.dart:1255-1273
  try {
    // TRANSIENT FRAME CALLBACKS
    _frameTimelineTask?.start('Animate');
    _schedulerPhase = SchedulerPhase.transientCallbacks;
    final Map<int, _FrameCallbackEntry> callbacks = _transientCallbacks;
    _transientCallbacks = <int, _FrameCallbackEntry>{};   // ← 换表
    callbacks.forEach((int id, _FrameCallbackEntry callbackEntry) {
      if (!_removedIds.contains(id)) {
        _invokeFrameCallback(callbackEntry.callback, _currentFrameTimeStamp!, callbackEntry.debugStack);
      }
    });
    _removedIds.clear();
  } finally {
    _schedulerPhase = SchedulerPhase.midFrameMicrotasks;   // 1272
  }
```

这里有三个设计点，每一个都能单独当考点：

| 代码 | 为什么这么写 |
|---|---|
| 先 `callbacks = _transientCallbacks` 再 `_transientCallbacks = {}` | 遍历过程中回调会重新注册自己（`Ticker._tick` 就是这么做的）。如果直接遍历原表，新注册的回调会在**同一帧**被再次执行，形成死循环。换表之后，遍历的是快照，新注册的落在新表里，只能等下一帧 |
| `_removedIds.contains(id)` | 回调 A 可能在回调 B 之前执行并取消 B。此时 B 已经不在 `_transientCallbacks` 里了（表早被换成空表），`remove` 是无效操作。所以需要一个"本帧已取消 id"的集合把 B 从快照里筛掉 |
| `finally` 里设 `midFrameMicrotasks` | 即使某个瞬态回调抛异常（`_invokeFrameCallback` 会捕获并上报，所以实际上不会向上抛），phase 也一定会推进到下一阶段 |

### 4.3 阶段 2：`midFrameMicrotasks`——没有代码的那一段

`handleBeginFrame` 一返回，引擎（在测试里是 `pump`）就会调用 `handleDrawFrame`。**这两次调用之间没有任何框架代码**，但 Dart 的事件循环会在这个空隙里把微任务队列跑干。

`handleDrawFrame` 的第一行就是这段空隙的"收据"：

```dart
// scheduler/binding.dart:1338-1340
void handleDrawFrame() {
  assert(_schedulerPhase == SchedulerPhase.midFrameMicrotasks);
  _frameTimelineTask?.finish(); // end the "Animate" phase
```

`midFrameMicrotasks` 这个阶段没有注册接口，也没有容器。你无法"注册一个 mid-frame microtask 回调"——只能从瞬态回调里 `scheduleMicrotask` 或 `await` 一个已经完成的 Future 来间接进入。它存在的意义是把"帧内排出的微任务"与"帧外的微任务"区分开：前者会在本帧的 layout/paint 之前跑掉。

**这也是一个陷阱来源**：在瞬态回调里 `await` 一个 Future，续体一定在 persistent 回调**之前**执行。很多"为什么我的 `setState` 在这一帧就生效了"的问题，答案就在这个阶段。

### 4.4 阶段 3、4、5：`handleDrawFrame`

```dart
// scheduler/binding.dart:1341-1376（节选）
  try {
    // PERSISTENT FRAME CALLBACKS
    _schedulerPhase = SchedulerPhase.persistentCallbacks;
    for (final callback in List<FrameCallback>.of(_persistentCallbacks)) {
      _invokeFrameCallback(callback, _currentFrameTimeStamp!);
    }

    // POST-FRAME CALLBACKS
    _schedulerPhase = SchedulerPhase.postFrameCallbacks;
    final localPostFrameCallbacks = List<FrameCallback>.of(_postFrameCallbacks);
    _postFrameCallbacks.clear();                      // ← 先清空再遍历
    // ...
    for (final callback in localPostFrameCallbacks) {
      _invokeFrameCallback(callback, _currentFrameTimeStamp!);
    }
  } finally {
    _schedulerPhase = SchedulerPhase.idle;            // 阶段 5
    _frameTimelineTask?.finish(); // end the Frame
    // ... 调试 banner ...
    _currentFrameTimeStamp = null;
  }
```

两个"复制一份再遍历"（`List.of`）与瞬态阶段的"换表"是同一个目的：**遍历期间对容器的修改不影响本次遍历**。但 post-frame 用了比瞬态更强的动作——直接 `clear()`：

| | 瞬态 | 常驻 | 帧后 |
|---|---|---|---|
| 遍历前动作 | 换一张空表 | `List.of` 复制 | `List.of` 复制 **+ `clear()`** |
| 遍历中新增的回调 | 落到下一帧 | **本帧不执行**（复制品已定），下一帧执行 | 落到下一帧 |
| 遍历中取消 | 靠 `_removedIds` | 无取消接口 | 无取消接口 |

`_persistentCallbacks` 的 `List.of` 复制意味着：如果你在 persistent 回调里再 `addPersistentFrameCallback`，它从下一帧开始生效。而 post-frame 的 `clear()` 会把这个新回调留在 `_postFrameCallbacks` 里等下一帧。

### 4.5 谁在 persistent 阶段干活

persistent 阶段在 framework 里只有一个真正的注册点：

```dart
// rendering/binding.dart:61
addPersistentFrameCallback(_handlePersistentFrameCallback);

// rendering/binding.dart:508-511
void _handlePersistentFrameCallback(Duration timeStamp) {
  drawFrame();
  _scheduleMouseTrackerUpdate();
}
```

`RendererBinding.drawFrame`（`rendering/binding.dart:642-652`）是五个动作的固定顺序：`flushLayout` → `flushCompositingBits` → `flushPaint` → 每个 `RenderView.compositeFrame()`（把 layer 树交给 GPU）→ `flushSemantics()`（把语义树交给操作系统）。而 `WidgetsBinding.drawFrame`（`widgets/binding.dart:1536`）在它外面又包了一圈：

```dart
// widgets/binding.dart:1570-1578（节选）
      if (rootElement != null) {
        buildOwner!.buildScope(rootElement!);   // 1. build
      }
      super.drawFrame();                        // 2. layout/paint/composite
      buildOwner!.finalizeTree();               // 3. 卸载本帧被移除的 Element
```

调度层的"一帧五阶段"与 widgets 层文档里的"一帧 10 个阶段"（`widgets/binding.dart:1477-1532`）是**同一段代码的两个切面**，并不矛盾：后者把 persistent 阶段内部又切成 8 步，其中第 10 步"finalization phase in the scheduler layer"就是本层的 post-frame 阶段。

### 4.6 旁路：`scheduleWarmUpFrame`

```dart
// scheduler/binding.dart:1037-1056（节选）
void scheduleWarmUpFrame() {
  if (_warmUpFrame || schedulerPhase != SchedulerPhase.idle) {
    return;
  }
  _warmUpFrame = true;
  // ...
  final bool hadScheduledFrame = _hasScheduledFrame;
  PlatformDispatcher.instance.scheduleWarmUpFrame(
    beginFrame: () {
      assert(_warmUpFrame);
      handleBeginFrame(null);          // ← 时间戳传 null
    },
    drawFrame: () {
      assert(_warmUpFrame);
      handleDrawFrame();
      resetEpoch();                    // 见下
      _warmUpFrame = false;
      if (hadScheduledFrame) {
        scheduleFrame();
      }
    },
  );
  // 锁住事件，避免触摸事件插进 warm-up 帧之间
  lockEvents(() async {
    await endOfFrame;
    // ...
  });
}
```

四个细节值得逐个记住：

1. **`handleBeginFrame(null)`**：时间戳是 null，于是 `rawTimeStamp ?? _lastRawTimeStamp` 会复用上一帧的时间戳（首帧则复用 `Duration.zero`）。调试 banner 在这种情况下打印 `(warm-up frame)` 而不是时间。
2. **`resetEpoch()`**：warm-up 帧用的往往是上一帧的旧时间戳（可能差几百毫秒）。不重置 epoch，热重载后第一帧会出现时间跳变，隐式动画会"跳过所有中间帧直接结束"。
3. **`lockEvents` + `await endOfFrame`**：整个 warm-up 帧期间锁住输入事件。`endOfFrame`（`:847`）内部就是注册一个 post-frame 回调来完成一个 `Completer`。
4. **`hadScheduledFrame` 的抄底**：warm-up 期间如果已经有一个真帧被排了，`scheduleFrame` 的去重会让它被跳过（`_hasScheduledFrame` 已在 `handleBeginFrame` 里清成 false，但 warm-up 用的是 `handleBeginFrame` 里那段逻辑……所以这里要显式补排）。

`PlatformDispatcher.scheduleWarmUpFrame` 在 dart:ui 里只是两个 `Timer.run`：

```dart
// dart:ui platform_dispatcher.dart:905-910
void scheduleWarmUpFrame({required VoidCallback beginFrame, required VoidCallback drawFrame}) {
  // We use timers here to ensure that microtasks flush in between.
  Timer.run(beginFrame);
  Timer.run(() {
    drawFrame();
    _endWarmUpFrame();
  });
}
```

**这就是 `midFrameMicrotasks` 阶段在 warm-up 帧里也成立的原因**：两次 `Timer.run` 之间必然插着一次微任务清空。

## 五、核心对象：五个阶段的对照

| 阶段 | 谁触发 | 期间有哪些代码在跑 | 这期间能安全做什么 | 这期间不该做什么 |
|---|---|---|---|---|
| `idle` | 没有帧 | 任意（事件、Timer、`scheduleTask` 的任务） | 任何事 | 读 `currentFrameTimeStamp`（会断言失败） |
| `transientCallbacks` | `handleBeginFrame` 开头 | `Ticker._tick` 及其调用者（`AnimationController._tick`） | 改动画状态、注册新的瞬态回调（下一帧生效） | 依赖"本帧新注册的回调也会跑" |
| `midFrameMicrotasks` | `handleBeginFrame` 的 `finally` | **框架没有代码**，只有 Dart 运行时在清微任务队列 | 帧内 `await` 的续体 | 假设它一定能被观察到（窗口极短，见实验 4） |
| `persistentCallbacks` | `handleDrawFrame` | `WidgetsBinding.drawFrame` / `RendererBinding.drawFrame` 全流程 | 由 `State.setState` 经 `markNeedsBuild` 触发的脏标记 | 直接改 Element 树结构（会把本帧的一致性搞乱） |
| `postFrameCallbacks` | `handleDrawFrame` 的中间段 | 布局后测量、`ScrollController` 对齐、`endOfFrame` 的完成 | 读本帧的最终几何信息、再排一帧 | 假设这次回调之后还有别的帧后回调会看到你的修改 |

**这五个阶段的顺序不是设计选择，是被"两次引擎调用"这个物理事实逼出来的**：`onBeginFrame` 与 `onDrawFrame` 之间的返回动作天然提供了一次微任务窗口，而 `onDrawFrame` 之后已经没有第三次调用可用，所以"帧后"的东西只能挤在 `handleDrawFrame` 的尾段。

## 六、源码实验

### 实验 1：五个阶段的实测时间线

用第二节的 Demo 改造后运行，输出如下：

```text
before pump         : SchedulerPhase.idle
transient callback  : SchedulerPhase.transientCallbacks
mid-frame microtask : SchedulerPhase.midFrameMicrotasks
persistent callback : SchedulerPhase.persistentCallbacks
post-frame callback : SchedulerPhase.postFrameCallbacks
after pump          : SchedulerPhase.idle
nested transient    : SchedulerPhase.transientCallbacks
persistent callback : SchedulerPhase.persistentCallbacks
```

**预测**：四类回调读到四种 phase；`midFrameMicrotasks` 能被 microtask 观察到；在瞬态回调里注册的瞬态回调落到下一帧。

**实际**：全部与预测一致。`nested transient` 出现在第二帧，且读到的 phase 依然是 `transientCallbacks`。

**说明**：这里有一个反直觉点——**microtask 确实观察到了 `midFrameMicrotasks`**。也就是说这个"没有框架代码"的阶段并非不可观测，只要你在瞬态回调里排微任务就一定落在这里。

### 实验 2：`_removedIds` 到底防住了什么

```dart
// 先注册「取消者」（拿到更小的 id），确保它先执行
late int victimId;
sb.scheduleFrameCallback((Duration ts) {
  sb.cancelFrameCallbackWithId(victimId);      // victimId == 2
  debugPrint('frame1 transient#1: 已取消 $victimId');
});
victimId = sb.scheduleFrameCallback((Duration ts) {
  debugPrint('victim 执行了（说明 _removedIds 没拦住）');
});
await tester.pump();
```

**预测**：既然 `cancelFrameCallbackWithId` 会 `_transientCallbacks.remove(id)`，而表在遍历前已经被换成空表，这个 `remove` 应该无效，victim 照样执行。

**实际**（输出）：

```text
frame1 transient#1: 已取消 2
```

`victim 执行了` 一行**没有出现**。

**说明**：`remove` 对快照确实无效（快照是局部变量 `callbacks`），真正起作用的是下一行的 `_removedIds.add(id)` 加上遍历时的 `if (!_removedIds.contains(id))`。第一次做这个实验时我把顺序写反了（先注册 victim 再注册取消者），victim 就正常执行了——这也说明**注册顺序决定了同一帧内谁先跑**。

### 实验 3：post-frame 回调分别在哪个阶段注册

**做法**：在第一个 post-frame 回调内部再注册第二个 post-frame 回调，并打印注册时的 `hasScheduledFrame`。

**预测**：两者都会在"下一帧"执行。

**实际**（输出）：

```text
frame1 transient#1: cancelFrameCallbackWithId(2)
postFrame 注册于 transient 阶段 → 本帧执行
  此刻 hasScheduledFrame=false（addPostFrameCallback 不排帧）
--- frame 1 结束, hasScheduledFrame=false ---
--- 未排帧的 pump 结束 ---
postFrame 注册于 postFrame 阶段 → 需要下一帧
--- frame 2 结束 ---
```

**说明**：三条结论都从这段输出里得到：

1. 在 persistent 阶段之前注册的 post-frame 回调，**本帧就跑**（因为 `List.of` 复制发生在 persistent 之后）。
2. 在 post-frame 阶段内部注册的回调，要等下一个**排了帧**的时刻——注意中间那次 `pump` 什么都没发生。
3. `addPostFrameCallback` 不排帧。这是 `flutter_test` 的 `pump` 里 `if (hasScheduledFrame)` 前置判断的直接后果（`flutter_test/lib/src/binding.dart:2256`）。

### 实验 4：间隔极短的阶段需要"制造"出来

```bash
grep -n "handleBeginFrame\|handleDrawFrame" packages/flutter_test/lib/src/binding.dart | head
```

**预测**：测试框架会像引擎一样调用这两个方法。

**实际**：这条命令会返回十几行，其中与本节相关的是 `flutter_test/lib/src/binding.dart:2256-2261`：

```dart
// flutter_test/lib/src/binding.dart:2256-2261
      if (hasScheduledFrame) {
        _currentFakeAsync!.flushMicrotasks();
        handleBeginFrame(Duration(microseconds: _clock!.now().microsecondsSinceEpoch));
        _currentFakeAsync!.flushMicrotasks();
        handleDrawFrame();
      }
```

**说明**：**两次 `flushMicrotasks()` 是测试框架替引擎补的**。真实引擎里这一段由 Dart 事件循环自然完成；在测试里必须显式刷新，否则 `midFrameMicrotasks` 阶段的回调永远不会执行，所有 `await` 后面写的东西都会"消失"。这也解释了为什么测试里 `pump()` 之后立刻能看到异步续体的结果。

顺带一个发现：同一个文件里还有一处**强制"两半帧必须交替"的守卫**——`flutter_test/lib/src/binding.dart:2788` 与 `:2806` 分别在 `handleBeginFrame` / `handleDrawFrame` 里检查配对，不配对时抛 `StateError`（"called before previous handleDrawFrame()"）。这正是 4.1 节那句引擎约束在测试框架里的镜像。

### 实验 5：`timeDilation` 会重置 epoch

```bash
grep -n "resetEpoch" packages/flutter/lib/src/scheduler/binding.dart
```

**实际**：`timeDilation` 的 setter（`:45`）在赋值前调用 `SchedulerBinding._instance?.resetEpoch();`，`resetEpoch`（`:1103`）把 `_epochStart` 设成"当前已换算的时间"并清空 `_firstRawTimeStampInEpoch`。

**说明**：不这么做的话，把 `timeDilation` 从 10 调回 1 会让时间戳突然倒退，而所有帧回调都假设时间戳单调递增。`_epochStart` 的文档（`:1086-1102`）是本层最好的"为什么需要 epoch"说明，值得整段读。

## 七、结论

1. 一帧是"两次引擎调用 + 一次函数返回"：`handleBeginFrame`（阶段 1）→ 返回（阶段 2，微任务窗口）→ `handleDrawFrame`（阶段 3、4）→ `idle`（阶段 5）。`midFrameMicrotasks` 没有注册接口，只能从瞬态回调里 `scheduleMicrotask` 间接进入，且它在测试环境里要靠测试框架显式 `flushMicrotasks` 才能被观察到。
2. 三个回调容器的遍历前处理各不相同——瞬态**换表**（新注册落下一帧）、常驻**复制**（新注册从下一帧起生效）、帧后**复制并清空**（注册时机决定落在本帧还是下一帧）。`_removedIds` 只在瞬态阶段存在，因为只有瞬态回调有 id 和取消接口。
3. `_warmUpFrame` 是绕过 vsync 的完整旁路：时间戳传 `null` 复用上一帧、用两次 `Timer.run` 制造微任务窗口、期间 `lockEvents` 挡住输入、结束时 `resetEpoch` 防止热重载后的时间跳变；同时它会**成对丢弃**期间到来的引擎帧，并用 `_rescheduleAfterWarmUpFrame` 补排一帧。

**五个阶段里只有两个是引擎给的，另外三个是 framework 用"返回动作"和"函数内的顺序"自己切出来的。**

## 八、边界声明

- 本文只讲到 persistent 阶段"谁被调用"（`RendererBinding` → `WidgetsBinding`），不展开 `flushLayout` / `flushPaint` / `compositeFrame` 的内部。这条链属于第八卷（rendering）篇 30–35。
- `widgets/binding.dart:1477-1532` 那份"10 个阶段"的文档，本文只用来做对照；build/layout/semantics 各自怎么做，交给第九卷与第八卷。
- `PlatformDispatcher.onReportTimings` 与 `addTimingsCallback`（`scheduler/binding.dart:321`）是**与帧回调完全独立的第三条通路**（引擎按约 1 秒批量上报 `FrameTiming`），这个系列不展开，需要时读 `_executeTimingsCallbacks`（`:340`）与 `_profileFramePostEvent`（`:1378`）。
- `lockEvents` / `unlocked` 的完整语义属于 foundation，见第七篇与 `foundation/binding.dart:661`。
- `Ticker` 为什么能在瞬态阶段被正确驱动、`_startTime` 怎么取，交给第 19 篇。
