# 17 scheduler 层地图与 SchedulerPhase

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/scheduler`

## 一、问题

scheduler 这一层只有 5 个文件、2183 行，其中 `binding.dart` 一个文件就占 1470 行。打开它第一眼看到的是 `SchedulerPhase` 枚举和一堆 `addXxxCallback`，第二眼看到的是 `Priority`、`scheduleTask`、`handleEventLoopCallback`。

于是问题变成：**这层的主体是"帧回调的登记处"，还是"任务优先级队列"？**

常见错误直觉是后者——"scheduler 就是框架内的任务调度器，负责按优先级跑任务"。因为在别的系统里，scheduler 这个词几乎总是那个意思。

但把 2183 行按职责切开会看到：任务队列（`scheduleTask` + `Priority` + `defaultSchedulingStrategy`）只占大约 100 行，**整个 framework 里只有一个真实调用者**；剩下 2000 行全部在回答另一个问题：一帧开始前、一帧中、一帧后，分别有哪些回调要被调用，它们存在哪张表里，谁能注销它们。

**关键认知**：`SchedulerBinding` 的主体不是"调度器"，而是**四张回调表的持有者**。`SchedulerPhase` 这个枚举值之所以存在，是为了让回调在被调用时能问一句"我现在处在帧的哪个阶段"。

## 二、最小 Demo

scheduler 层可以完全脱离 Widget 使用。下面这段不建任何 Widget 树，直接向 binding 注册四类回调，并在每个回调里读出当前的 `SchedulerPhase`：

```dart
import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();   // 0. binding 必须先初始化
  final SchedulerBinding sb = SchedulerBinding.instance;

  // 1. 常驻回调：注册一次，此后每帧都调用；注册后无法注销
  sb.addPersistentFrameCallback((Duration ts) {
    debugPrint('persistent  : ${sb.schedulerPhase}');
  });

  // 2. 瞬态回调：帧开始时调用，返回值是 id，可凭 id 注销
  sb.scheduleFrameCallback((Duration ts) {
    debugPrint('transient   : ${sb.schedulerPhase}');
    // 3. 瞬态回调里排一个 microtask，它落在下一个阶段
    scheduleMicrotask(() => debugPrint('microtask   : ${sb.schedulerPhase}'));
  });

  // 4. 帧后回调：只调用一次，不排帧，也不能注销
  sb.addPostFrameCallback((Duration ts) {
    debugPrint('post-frame  : ${sb.schedulerPhase}');
  });

  // 5. 帧与帧之间的任务：带优先级，与帧无关
  sb.scheduleTask<void>(() => debugPrint('task        : ${sb.schedulerPhase}'), Priority.idle);

  sb.scheduleFrame();   // 6. 上面第 4、5 步都不排帧，这里显式排一帧
}

// 单帧处理完后进程不会退出（引擎还在等 vsync），Ctrl-C 结束即可。
```

跑起来会看到四类回调各自打印出当前的 phase，而且**每一行都是不同的值**——这正是这层最核心的可观测现象（第六节给出实测输出）。第 5 行的任务可能落在帧内也可能落在帧外，取决于 `defaultSchedulingStrategy` 当时看到的 `transientCallbackCount`。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `scheduler/binding.dart:250` | `mixin SchedulerBinding on BindingBase`，整层的主体 |
| `scheduler/binding.dart:160` | `enum SchedulerPhase`，五个阶段（`idle`/`transientCallbacks`/`midFrameMicrotasks`/`persistentCallbacks`/`postFrameCallbacks`） |
| `scheduler/binding.dart:608` | `scheduleFrameCallback`，瞬态回调的注册口，返回可注销的 id |
| `scheduler/binding.dart:781` | `addPersistentFrameCallback`，"不能注销"的那类回调 |
| `scheduler/binding.dart:818` | `addPostFrameCallback`，"不排帧、只调用一次"的那类回调 |
| `scheduler/binding.dart:466` | `scheduleTask`，与帧无关的优先级任务 |
| `scheduler/binding.dart:888` | `ensureFrameCallbacksRegistered`，把 `_handleBeginFrame` 接到引擎 |
| `scheduler/binding.dart:1226` / `1338` | `handleBeginFrame` / `handleDrawFrame`，两半帧的唯一入口（第 18 篇展开） |
| `scheduler/ticker.dart:43` | `abstract class TickerProvider`，vsync 的接口定义（第 19 篇展开） |
| `scheduler/ticker.dart:78` | `class Ticker`，帧回调的最小使用者 |
| `scheduler/priority.dart:12` | `class Priority`，三个常量与 ±10000 的钳制 |
| `scheduler/debug.dart:39` | `debugPrintBeginFrameBanner`，看清帧边界的开关 |
| `scheduler/service_extensions.dart:16` | `enum SchedulerServiceExtensions`，只有 `timeDilation` 一项 |

## 四、调用链

### 4.1 五个文件的分量

```text
binding.dart              1470 行   四张回调表 + 两半帧的驱动 + 任务队列
ticker.dart                545 行   帧回调的"订阅者"，不直接碰引擎
debug.dart                  87 行   4 个调试开关
priority.dart               54 行   优先级常量
service_extensions.dart     27 行   一个枚举，暴露 timeDilation
```

这是一层"几乎没有算法"的层。除了 `Priority` 的钳制和 `_adjustForEpoch` 的时间戳折算，全部代码都是**表的增删**和**调用顺序**。

### 4.2 它是怎么被接上引擎的

`SchedulerBinding` 不是引擎的调用者，它是被调用的一方。接线只有一行：

```dart
// scheduler/binding.dart:888-891
@protected
void ensureFrameCallbacksRegistered() {
  platformDispatcher.onBeginFrame ??= _handleBeginFrame;
  platformDispatcher.onDrawFrame ??= _handleDrawFrame;
}
```

`ensureFrameCallbacksRegistered` 由 `scheduleFrame`（`:946`）和 `scheduleForcedFrame`（`:981`）调用。**所以"注册引擎回调"这件事只在第一次请求帧的时候发生一次**，此后 `??=` 命中已有值直接跳过。

请求帧的三种方式，语义不同：

| 方法 | 锚点 | 是否看生命周期 | 用途 |
|---|---|---|---|
| `scheduleFrame` | `:946` | 看（`framesEnabled` 为 false 时直接 return） | 常规请求下一帧 |
| `scheduleForcedFrame` | `:981` | 不看 | 屏幕熄灭/后台也要推帧，耗电 |
| `scheduleWarmUpFrame` | `:1037` | 完全不经过 vsync | 启动与热重载时抢跑一帧（第 18 篇展开） |

**关键认知**：`platformDispatcher.scheduleFrame()` 是"请求引擎在下次 vsync 叫我"，而 `_hasScheduledFrame` 只是一个去重开关（`:947` 的 `if (_hasScheduledFrame ...) return;`）。框架里任何地方调用 `scheduleFrame` 一百次，引擎也只会收到一次通知。

### 4.3 四类回调存在哪

这是本篇真正的地图。四类回调对应三个不同的容器加一条完全独立的队列：

```dart
// scheduler/binding.dart:563-564
Map<int, _FrameCallbackEntry> _transientCallbacks = <int, _FrameCallbackEntry>{};
final Set<int> _removedIds = HashSet<int>();

// scheduler/binding.dart:761
final List<FrameCallback> _persistentCallbacks = <FrameCallback>[];

// scheduler/binding.dart:785
final List<FrameCallback> _postFrameCallbacks = <FrameCallback>[];

// scheduler/binding.dart:439-441
final PriorityQueue<_TaskEntry<dynamic>> _taskQueue = HeapPriorityQueue<_TaskEntry<dynamic>>(_taskSorter);
```

三种帧回调的差异不在"什么时候跑"，而在**谁拥有它们的生命周期**：

| | 瞬态 transient | 常驻 persistent | 帧后 post-frame |
|---|---|---|---|
| 注册口 | `scheduleFrameCallback`（`:608`） | `addPersistentFrameCallback`（`:781`） | `addPostFrameCallback`（`:818`） |
| 容器 | `Map<int, _FrameCallbackEntry>` | `List<FrameCallback>` | `List<FrameCallback>` |
| 有没有 id | 有，返回 `int` | 无 | 无 |
| 能注销吗 | 能，`cancelFrameCallbackWithId`（`:631`） | **不能** | **不能** |
| 调用次数 | 每次注册调用一次，想继续要在回调里重新注册 | 每帧都调，直到进程结束 | 只调一次 |
| 注册时排帧吗 | 默认排（`scheduleNewFrame: true`） | 不排 | 不排 |
| 典型使用者 | `Ticker` | `RendererBinding` 的 `drawFrame` | 布局后测量、`ScrollController` 对齐 |

表格最后一行是理解这层用途的关键：**框架自己只注册了两条 persistent 回调**：

```bash
grep -rn "addPersistentFrameCallback" packages/flutter/lib/src --include="*.dart"
```

在 3.44.8 里，"非注释"的命中只有三处：定义处 `scheduler/binding.dart:781`，加上两个注册点——

| 注册点 | 回调 | 作用 |
|---|---|---|
| `rendering/binding.dart:61` | `_handlePersistentFrameCallback`（`:508`） | 每帧驱动 build/layout/paint，**这是 UI 的主动脉** |
| `widgets/widget_inspector.dart:1078` | `_onFrameStart` | 调试模式下的 Inspector 帧首钩子 |

也就是说，"每帧驱动渲染管线"这件事，从头到尾只通过一条 persistent 回调实现（第 18 篇展开这条链）；第二条只在调试工具里出现。

### 4.4 与 `SchedulerPhase` 的关系

`SchedulerPhase` 是这层对外的唯一"状态量"。它的定义处写得很清楚：

```dart
// scheduler/binding.dart:153-155
/// The values of this enum are ordered in the same order as the phases occur,
/// so their relative index values can be compared to each other.
```

这个"顺序可比"不是修辞，有代码在依赖它：`Ticker.start`（`ticker.dart:202`）用 `phase.index > SchedulerPhase.idle.index && phase.index < SchedulerPhase.postFrameCallbacks.index` 判断"当前是否在一帧内部"，从而决定 `_startTime` 取什么。**如果谁把枚举顺序改了，Ticker 的 elapsed 计算会静默出错。**

**关键认知**：`SchedulerPhase` 的五个值里，有四个是"正在执行某类回调"，第五个 `midFrameMicrotasks` 描述的却是一段**没有代码的间隙**——`handleBeginFrame` 在 `finally` 里把 phase 设成它然后返回，引擎随后才会调用 `handleDrawFrame`。这一段之所以要单独命名，是因为它是唯一允许"帧内排出的 microtask"执行的窗口（第 18 篇展开）。

### 4.5 任务队列：与帧无关的那 100 行

`scheduleTask` 把任务塞进一个按优先级排序的堆，然后只在一个条件下立刻尝试执行：

```dart
// scheduler/binding.dart:472-478
final bool isFirstTask = _taskQueue.isEmpty;
final entry = _TaskEntry<T>(task, priority.value, debugLabel, flow);
_taskQueue.add(entry);
if (isFirstTask && !locked) {
  _ensureEventLoopCallback();
}
return entry.completer.future;
```

`locked` 来自 `BindingBase`（`foundation/binding.dart:643` 的 `bool get locked => _lockCount > 0;`）。**关键认知**：任务队列不是被帧驱动的，而是被 `Timer.run` 驱动的（`:501`）。锁住事件（`lockEvents`，`foundation/binding.dart:661`）时只会拦住"启动"，队列里已有的任务在 `unlocked()`（`:482`）里被重新拉起：

```dart
// scheduler/binding.dart:481-487
@override
void unlocked() {
  super.unlocked();
  if (_taskQueue.isNotEmpty) {
    _ensureEventLoopCallback();
  }
}
```

优先级门禁在 `defaultSchedulingStrategy` 里，实现只有三行：

```dart
// scheduler/binding.dart:1465-1469
bool defaultSchedulingStrategy({required int priority, required SchedulerBinding scheduler}) {
  if (scheduler.transientCallbackCount > 0) {
    return priority >= Priority.animation.value;   // 100000
  }
  return true;
}
```

也就是说：**只要还有瞬态帧回调挂着（通常意味着有动画在跑），低于 `Priority.animation` 的任务一律不执行。** 而且被拒绝时 `handleEventLoopCallback` 返回的是 `true` 而不是 `false`：

```dart
// scheduler/binding.dart:557-559
      return _taskQueue.isNotEmpty;
    }
    return true;   // 优先级不够，不是"没任务"
```

返回值 `true` 让 `_runTasks`（`:507`）继续排下一次 `Timer.run`。这就是"任务被跳过但不会被丢弃、动画结束后接着跑"的实现方式。

## 五、核心对象：四类回调的职责对比

| | 瞬态回调 | 常驻回调 | 帧后回调 | 优先级任务 |
|---|---|---|---|---|
| 驱动源 | 引擎 `onBeginFrame` → `handleBeginFrame` | 引擎 `onDrawFrame` → `handleDrawFrame` | 同左，紧随常驻回调 | `Timer.run`，与帧无关 |
| 跨帧存活 | 否（每帧清空重注册） | 是 | 否 | 否 |
| 能注销 | 是 | 否 | 否 | 否（已入队就一定会跑，除非被优先级跳过） |
| 有执行顺序保证 | 按插入顺序（`Map` 保持插入序） | 按注册顺序 | 按注册顺序 | 按优先级，同优先级按 `PriorityQueue` 内部序 |
| 注册时排帧 | 默认排 | 不排 | 不排 | 不排 |
| 框架内使用者 | `Ticker` 等 6 处（见实验 3'） | `RendererBinding` + `WidgetInspector`（两个注册点） | 很多，分散在各层 | `material/about.dart`（唯一调用点） |
| 对应 `SchedulerPhase` | `transientCallbacks` | `persistentCallbacks` | `postFrameCallbacks` | `idle`（也可能落在任意阶段） |

最后一行需要特别说明：**`scheduleTask` 的任务不绑定任何 phase**。它由事件循环驱动，落点可能是 `idle`，也可能正好插在两帧之间而读到别的值。而 `transientCallbacks` 与 `persistentCallbacks` 中间隔着的 `midFrameMicrotasks`，是被"返回"这个动作制造出来的，没有对应的注册接口——你无法"注册一个 mid-frame microtask 回调"，只能从瞬态回调里 `scheduleMicrotask` 间接进入这个阶段。

## 六、源码实验

### 实验 1：确认这层不依赖任何其它层

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -n "^import '\.\./" scheduler/*.dart
```

**预测**：如果 scheduler 是"第一层"，它不该出现 `../xxx` 形式的相对跨层引用。

**实际**：零命中。五个文件的 import 只有 `dart:async`、`dart:collection`、`dart:developer`、`dart:ui`、`package:collection` 和 `package:flutter/foundation.dart`。

**说明**：scheduler 的唯一 framework 依赖是 foundation。`package:collection` 提供 `PriorityQueue`——**框架宁愿引 pub 包，也不自己写堆**。这也是本层唯一的外部依赖。

### 实验 2：四类回调各自看到的 phase

用第二节的 Demo 改造后实测（临时工程已删除），输出如下：

```text
before pump         : SchedulerPhase.idle          ← 帧外
transient callback  : SchedulerPhase.transientCallbacks
mid-frame microtask : SchedulerPhase.midFrameMicrotasks
persistent callback : SchedulerPhase.persistentCallbacks
post-frame callback : SchedulerPhase.postFrameCallbacks
after pump          : SchedulerPhase.idle
```

**预测**：四类回调能读到四种不同的 phase，且 microtask 落在 `transientCallbacks` 与 `persistentCallbacks` 之间。

**实际**：与预测一致，且帧外读到的永远是 `idle`。

**说明**：这段输出可以直接当"这层的行为规范"用。任何时候你的回调读到 `persistentCallbacks`，就说明它在渲染管线内部（此时改 Element 树是危险的）；读到 `postFrameCallbacks`，说明管线已经结束。

### 实验 3：`scheduleTask` 的真实使用者

```bash
grep -rn "scheduleTask" packages/flutter/lib/src --include="*.dart" | grep -v "scheduler/binding.dart"
```

**预测**：作为"按优先级调度的核心能力"，应该有不少框架内部使用者。

**实际**：只有注释性质的命中（`foundation/isolates.dart:33`、`foundation/licenses.dart:127`、`foundation/binding.dart:658` 的文档），**真实调用只有一处**：`material/about.dart:1027-1032`，用来把解析 License 段落的重活排到动画不忙的时候：

```dart
// material/about.dart:1026-1032（原样照抄）
      final List<LicenseParagraph> paragraphs = await SchedulerBinding.instance
          .scheduleTask<List<LicenseParagraph>>(
            license.paragraphs.toList,
            Priority.animation,
            debugLabel: 'License',
          );
```

**说明**：这是整层最反直觉的一点。`scheduleTask` + `Priority` + `schedulingStrategy` 三件套加起来不到 100 行，却几乎是纯 API 面积——框架自己基本不用它。**读这层时不要在任务队列上花太多时间，它服务的是"应用作者想插后台活"的场景。**

### 实验 3'：瞬态回调不止 Ticker 一个使用者

```bash
grep -rn "\.scheduleFrameCallback(" packages/flutter/lib/src --include="*.dart"
```

**预测**：既然 `Ticker` 是"动画的驱动者"，瞬态回调可能只有它一个使用者。

**实际**：6 处命中，`Ticker` 只是其中之一：

| 调用点 | 用途 |
|---|---|
| `scheduler/ticker.dart:298` | 动画的每帧回调 |
| `painting/image_stream.dart:1121` | 逐帧推进 GIF 等动图 |
| `rendering/object.dart:4712` | `RenderObject` 的一次性帧内回调（如 `showOnScreen` 的延迟处理） |
| `widgets/layout_builder.dart:144` | `LayoutBuilder` 在 layout 前拿一次约束 |
| `widgets/scroll_aware_image_provider.dart:98` | 滚动中推迟昂贵图片解码 |
| `widgets/overlay.dart:2875` | `Overlay` 的入场时机 |

**说明**：瞬态回调是"帧开始时的钩子"这条通用能力，Ticker 只是最大的消费者。它同时是**唯一会被大量重复注册**的一类——一个界面里跑 10 个 `AnimationController`，就有 10 个瞬态回调；这也是 `transientCallbackCount` 能被 `defaultSchedulingStrategy` 拿来当"是否有动画在跑"的判据的原因。

### 实验 4：`hasScheduledFrame` 与 `framesEnabled` 的关系

```bash
grep -n "framesEnabled" packages/flutter/lib/src/scheduler/binding.dart
grep -n "_setFramesEnabledState" packages/flutter/lib/src/scheduler/binding.dart
```

**预测**：如果 `scheduleFrame` 只看 `_hasScheduledFrame`，那么应用切到后台后再调 `scheduleFrame` 应该仍然能排帧。

**实际**：`scheduleFrame` 在 `:947` 同时检查两个条件——`if (_hasScheduledFrame || !framesEnabled) return;`。而 `framesEnabled` 由 `handleAppLifecycleStateChanged`（`:414`）根据 `AppLifecycleState` 设置：`resumed`/`inactive` 为 true，`hidden`/`paused`/`detached` 为 false。从 false 变回 true 时会主动补一帧（`:880-882` 的 `if (enabled) scheduleFrame();`）。

**说明**：`Ticker.isTicking`（`ticker.dart:148`）会读这个值。**"应用在后台时动画不 tick，但时长照算"这条行为，源头就是 `framesEnabled` 这个布尔值，而不是 Ticker 自己的判断。**

## 七、结论

1. scheduler 层 2183 行里，主体是**四张回调表**（瞬态 / 常驻 / 帧后 / 任务），不是任务调度器。任务队列只占约 100 行，且 framework 内只有 `material/about.dart` 一个真实调用者。
2. 三种帧回调的差异不在执行时刻（它们的时刻由第 18 篇的顺序决定），而在**生命周期归属**：瞬态回调有 id 可注销、每帧要重注册；常驻回调只能加不能减；帧后回调只调一次。
3. `SchedulerPhase` 的顺序有语义：`Ticker.start`（`ticker.dart:202`）用 `index` 比较判断"是否在一帧内部"。五个值里 `midFrameMicrotasks` 是唯一没有注册接口的阶段，只能从瞬态回调里排 microtask 进入。

一句话总结：**scheduler 是四张回调表的持有者，`SchedulerPhase` 是给回调用的"我在帧的哪一段"的自检标尺。**

## 八、边界声明

- 本篇不展开一帧内部的执行顺序与时间戳折算。`handleBeginFrame` / `handleDrawFrame` / `_warmUpFrame` / `_removedIds` 全部交给第 18 篇。
- `Ticker`、`TickerFuture`、`muted`、`forceFrames` 交给第 19 篇。
- `PriorityQueue` 的堆实现属于 `package:collection`，本系列不展开。
- `Priority` 的 ±10000 钳制（`priority.dart:33` 的 `kMaxOffset`）只是防御性设计，framework 内没有任何地方使用相对偏移，不做展开。
- `addTimingsCallback`（`:321`）与 `_executeTimingsCallbacks`（`:340`）是引擎的 `onReportTimings` 通道，与帧回调无关，只在第 18 篇末尾提一句"它是另一条独立通路"。
- `requestPerformanceMode` / `PerformanceModeRequestHandle`（`:213`、`:1287`）是 DevTools 的性能档位请求，与调度顺序无关，不展开。
