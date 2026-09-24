# 19 Ticker 与 vsync：帧回调的注册与注销

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/scheduler/ticker.dart`（545 行）

## 一、问题

`AnimationController` 的构造参数里有个必填项 `required TickerProvider vsync`。几乎所有入门材料都会说："vsync 就是垂直同步信号，Ticker 会跟着屏幕刷新率每帧回调一次。"

那么一个具体的问题：**如果 vsync 是信号，`TickerProvider` 为什么是一个对象、一个接口、一个 `State` 混入的 mixin？**

答案在 `ticker.dart` 里可以直接验证——**这个文件里 `vsync` 一词出现 0 次**（`grep -in "vsync" ticker.dart` 无输出），也没有任何一行代码接触 `platformDispatcher`、`onBeginFrame` 或刷新率。

**关键认知**：在这一层，"vsync" 不是信号，而是**一个能生产 Ticker 的对象**。Ticker 拿它只做一件事：`vsync.createTicker(_tick)`。此后 Ticker 的全部工作就是往 `SchedulerBinding` 的瞬态回调表里放一个回调、被调用、再放回去。真正订阅 vsync 信号的是 `SchedulerBinding`（第 17、18 篇），Ticker 只是它的一个消费者。

第二个常见错误直觉是"`muted` 会暂停时钟"。源码正好相反：`muted` 只是**不再排 tick**，`_startTime` 不动、时间照常流逝，解除静音后 `elapsed` 会直接跳过一个或多个帧的间隔（第六节有实测）。

## 二、最小 Demo

`Ticker` 可以脱离 `AnimationController` 直接用。`SchedulerBinding.instance` 要求 binding 已初始化，且观察 `elapsed` 变化必须有真实的帧推进——所以放进 `testWidgets`，用 `tester.pump(Duration(...))` 逐帧走：

```dart
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('muted 期间时钟不停', (WidgetTester tester) async {
    // 1. onTick 的参数是「距离 start 的时长」，不是绝对时间戳
    late final Ticker ticker;                 // 2. 回调里要读 ticker 自身，先声明后赋值
    ticker = Ticker((Duration elapsed) {
      debugPrint('tick elapsed=$elapsed isActive=${ticker.isActive} isTicking=${ticker.isTicking}');
    }, debugLabel: 'demo');

    // 3. start() 返回 TickerFuture；不主动 stop 就永远不完成
    final TickerFuture future = ticker.start();
    future.whenComplete(() => debugPrint('ticker future 完成（正常 stop）'));

    await tester.pump(const Duration(milliseconds: 16));   // 第 1 帧：elapsed=0
    await tester.pump(const Duration(milliseconds: 16));   // 第 2 帧：elapsed=16ms

    ticker.muted = true;    // 4. 静音：时钟继续走，但回调不再被调用
    await tester.pump(const Duration(milliseconds: 16));   // 静音期间：没有任何 tick 输出

    ticker.muted = false;   // 5. 解除静音：scheduleTick 补排一次 tick
    await tester.pump(const Duration(milliseconds: 16));   // 恢复：elapsed 从 16ms 跳到 48ms

    // 6. stop() 默认 canceled = false → TickerFuture 正常完成
    //    若传 canceled: true → future 永不完成，orCancel 抛 TickerCanceled
    ticker.stop();
  });
}
```

实测输出（节选）：

```text
tick elapsed=0:00:00.000000 isActive=true isTicking=true
tick elapsed=0:00:00.016000 isActive=true isTicking=true
tick elapsed=0:00:00.048000 isActive=true isTicking=true
ticker future 完成（正常 stop）
```

`ticker.muted = true` 期间**不会**有任何 `tick` 行输出；解除静音后的第一行 `elapsed` 从 16ms 直接跳到 48ms——比上一个 tick 大出了静音那一帧加上恢复等待的那一帧（`_startTime` 从未重置，时间如实流逝）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `scheduler/ticker.dart:43` | `abstract class TickerProvider`，vsync 的全部接口面：只有 `createTicker` |
| `scheduler/ticker.dart:78` | `class Ticker`，整个类不引用 `platformDispatcher` |
| `scheduler/ticker.dart:106` / `119` | `muted` 的 getter / setter |
| `scheduler/ticker.dart:141` | `isTicking`，三个否定条件 + 一个豁免 |
| `scheduler/ticker.dart:184` | `start()` |
| `scheduler/ticker.dart:230` | `stop({bool canceled = false})` |
| `scheduler/ticker.dart:271` | `_tick`，帧回调的本体 |
| `scheduler/ticker.dart:290` | `scheduleTick`，`scheduleFrame` + `scheduleFrameCallback` 两个动作 |
| `scheduler/ticker.dart:312` | `unscheduleTick`，唯一的注销路径 |
| `scheduler/ticker.dart:478` | `orCancel`，取消才能观察到的派生 future |
| `widgets/ticker_provider.dart:25` | `class TickerMode`，muted 的**上游决策者** |
| `widgets/ticker_provider.dart:317` | `SingleTickerProviderStateMixin` |

## 四、调用链

### 4.1 接口在 scheduler，实现在 widgets

`TickerProvider` 本体只有 11 行：

```dart
// scheduler/ticker.dart:43-53
abstract class TickerProvider {
  const TickerProvider();

  /// Creates a ticker with the given callback.
  ///
  /// The kind of ticker provided depends on the kind of ticker provider.
  @factory
  Ticker createTicker(TickerCallback onTick);
}
```

而它的**全部实现都在 widgets 层**：

| 实现 | 位置 | 能产几个 Ticker | muted 的来源 |
|---|---|---|---|
| `SingleTickerProviderStateMixin` | `widgets/ticker_provider.dart:317` | 1 个（第二次调用直接抛错） | `TickerMode.getValuesNotifier(context)` |
| `TickerProviderStateMixin` | `widgets/ticker_provider.dart:442` | 任意多个 | 同上，广播给所有 ticker |
| `TestVSync` | `flutter_test/lib/src/test_vsync.dart:14` | 任意多个 | 无（永远不 muted） |

**关键认知**：这就是"vsync 是一个对象"的实际含义——`SingleTickerProviderStateMixin` 把「这个 State 所在的子树是否启用了动画」这件事变成了一个可监听的 `ValueListenable`，然后在它变化时去改 `ticker.muted`：

```dart
// widgets/ticker_provider.dart:386-391
void _updateTicker() {
  final TickerModeData values = _tickerModeNotifier!.value;
  if (_ticker != null) {
    _ticker!.muted = !values.enabled;
    _ticker!.forceFrames = values.forceFrames;
  }
}
```

**`TickerMode` 是 muted 的唯一决策者**，而它生活在 widget 树里。所以"把某个子树里的动画全部暂停"这个常见需求，实现方式是：

```dart
TickerMode(enabled: false, child: ...)   // 不碰任何 AnimationController
```

### 4.2 `AnimationController` 怎么拿到 Ticker

```dart
// animation/animation_controller.dart:257（构造里）
_ticker = vsync.createTicker(_tick);
```

注意传给 `createTicker` 的是 `AnimationController._tick`（`animation_controller.dart:941`）——**Ticker 只知道"每帧叫我一次，告诉我过了多久"，完全不知道 Simulation、Curve 或 value 的存在**。这个分层是第 21 篇的主题。

### 4.3 `start()`

```dart
// scheduler/ticker.dart:184-207（节选）
TickerFuture start() {
  // ... assert 已经 active 就抛 "A ticker was started twice." ...
  assert(_startTime == null);
  _future = TickerFuture._();
  if (shouldScheduleTick) {
    scheduleTick();
  }
  if (SchedulerBinding.instance.schedulerPhase.index > SchedulerPhase.idle.index &&
      SchedulerBinding.instance.schedulerPhase.index < SchedulerPhase.postFrameCallbacks.index) {
    _startTime = SchedulerBinding.instance.currentFrameTimeStamp;
  }
  return _future!;
}
```

两个分支值得记清：

| `start()` 被调用的时机 | `_startTime` | 第一次 `_tick` 的 `elapsed` |
|---|---|---|
| 帧外（`idle`）或 `postFrameCallbacks` 阶段 | 保持 `null` | **0**（由 `_tick` 里的 `_startTime ??= timeStamp` 兜底） |
| 帧内（`transientCallbacks` / `midFrameMicrotasks` / `persistentCallbacks`） | 立刻取 `currentFrameTimeStamp` | 本帧剩余时间（下一帧的 timestamp 减去本帧 timestamp） |

第二种情况的用意是：在一个已经在进行的帧里启动动画时，把"当前帧已过的时间"也算进动画时长，避免动画凭空多出一帧。

下面这行判断本身也值得一提——它用 `SchedulerPhase` 的**索引做区间比较**：

```dart
// scheduler/ticker.dart:202-203
    if (SchedulerBinding.instance.schedulerPhase.index > SchedulerPhase.idle.index &&
        SchedulerBinding.instance.schedulerPhase.index < SchedulerPhase.postFrameCallbacks.index) {
```

**关键认知**：这依赖 `SchedulerPhase` 的枚举顺序（`scheduler/binding.dart:153-155` 明确说过顺序即语义）。枚举顺序一旦变动，这段判断会静默地把动画多算或少算一帧，不会有任何编译错误。

### 4.4 `scheduleTick`：为什么用 `scheduleNewFrame: false`

```dart
// scheduler/ticker.dart:290-303
void scheduleTick({bool rescheduling = false}) {
  assert(!scheduled);
  assert(shouldScheduleTick);
  if (forceFrames) {
    SchedulerBinding.instance.scheduleForcedFrame();
  } else {
    SchedulerBinding.instance.scheduleFrame();
  }
  _animationId = SchedulerBinding.instance.scheduleFrameCallback(
    _tick,
    rescheduling: rescheduling,
    scheduleNewFrame: false,
  );
}
```

两个动作被刻意拆成"先排帧、再登记回调"，并把 `scheduleNewFrame` 设成 `false`：

- `scheduleFrame()`：告诉引擎"下次 vsync 请叫我"。
- `scheduleFrameCallback(..., scheduleNewFrame: false)`：只登记回调，**不再触发一次排帧**。

如果直接用默认的 `true`，`scheduleFrameCallback` 内部也会调一次 `scheduleFrame`。虽然 `scheduleFrame` 有 `_hasScheduledFrame` 去重（`scheduler/binding.dart:947`）不会真的排两次帧，但会把 `debugPrintScheduleFrameStacks` 的调用栈打印多一份，并且让"谁排的帧"变得难以追踪。**显式拆开是为了让排帧这件事只有一个来源。**

`rescheduling: true` 只在 `_tick` 尾部使用。它的唯一作用是让 `_FrameCallbackEntry` 保留**第一次注册时**的栈（`scheduler/binding.dart:111-137`），这样 `debugPrintTransientCallbackRegistrationStack()` 打出来的是"谁最初启动了这个动画"，而不是"上一帧谁又注册了一次"。

### 4.5 `_tick`：elapsed 从哪来

```dart
// scheduler/ticker.dart:271-284
void _tick(Duration timeStamp) {
  assert(isTicking);
  assert(scheduled);
  _animationId = null;              // 1. 先清 id，表示"已消费"

  _startTime ??= timeStamp;          // 2. 帧外 start 的情况在这里兜底
  _onTick(timeStamp - _startTime!);  // 3. 唯一一次回调

  // onTick 里可能已经 stop + start，所以这里要重新判断
  if (shouldScheduleTick) {
    scheduleTick(rescheduling: true);  // 4. 自续期
  }
}
```

四行代码，每行都有对应的边界：

1. `_animationId = null` 必须在回调**之前**。否则回调里调用 `stop()` 时，`unscheduleTick` 会试图取消一个已经正在执行的回调 id。
2. `_startTime ??= timeStamp`：这就是"帧外 `start()` 的第一次 tick，`elapsed` 是 0"的来源。
3. `_onTick` 的实参是**相对时长**，而 `SchedulerBinding` 框架回调收到的是**本 epoch 内的绝对时间戳**。Ticker 是这两者的转换点。
4. `if (shouldScheduleTick)` 而不是无条件续期：这一句让"回调里 `stop()`"和"回调里 `muted = true`"都能在**本帧就生效**，不会多跑一帧。

### 4.6 三条注销路径

注销只有一处实现：

```dart
// scheduler/ticker.dart:312-318
void unscheduleTick() {
  if (scheduled) {
    SchedulerBinding.instance.cancelFrameCallbackWithId(_animationId!);
    _animationId = null;
  }
  assert(!shouldScheduleTick);
}
```

末尾的断言很关键：**只要 `shouldScheduleTick` 还会返回 true，调用 `unscheduleTick` 就是逻辑错误**。所以三条调用路径都必须先让 `shouldScheduleTick` 变成 false：

| 路径 | 位置 | 先做了什么 | 结果 |
|---|---|---|---|
| `muted = true` | `:119-129` | 先把 `_muted = true`（于是 `shouldScheduleTick` 为 false） | 取消等待中的 tick，但 `_future` 保持不动 → **isActive 仍为 true** |
| `stop()` | `:230-249` | 先把 `_future = null`、`_startTime = null` | 取消 tick，并按 `canceled` 参数完成或取消 future |
| `dispose()` | `:362-378` | 先把 `_future` 取走并置 null | 取消 tick 并 `_cancel`；**future 永不完成**（除非 `orCancel`） |

`shouldScheduleTick` 的定义把三个前提写在一起：

```dart
// scheduler/ticker.dart:269
bool get shouldScheduleTick => !muted && isActive && !scheduled;
```

**关键认知**：`muted` 与 `stop` 的区别在 `_future` 上——`muted` 不动 `_future`，所以 `isActive` 依然为 true、动画的"逻辑进度"还在；`stop` 清掉 `_future`，动画彻底结束。**这就是"静音"和"停止"的语义分界线。**

### 4.7 `isTicking` 与 `isActive`

```dart
// scheduler/ticker.dart:141-155
bool get isTicking {
  if (_future == null) {
    return false;                        // 没启动，或已 stop/dispose
  }
  if (muted) {
    return false;                        // 静音
  }
  if (SchedulerBinding.instance.framesEnabled) {
    return true;                         // 应用可见 → 真的会 tick
  }
  if (SchedulerBinding.instance.schedulerPhase != SchedulerPhase.idle) {
    return true;                         // 应用不可见但正在帧内（warm-up / forced frame）
  }
  return false;
}
```

| | `isActive` | `isTicking` |
|---|---|---|
| 定义 | `_future != null` | 上面四个条件的组合 |
| 受 `muted` 影响 | 否 | 是 |
| 受 `framesEnabled` 影响 | 否 | 是 |
| 受 `schedulerPhase` 影响 | 否 | 是 |
| 用途 | "动画是否处于运行状态" | "下一帧它会不会真的被调用" |

`AnimationController` 覆写了 `isAnimating`，用的是 `isActive` 的等价物：

```dart
// animation/animation_controller.dart:442
bool get isAnimating => _ticker != null && _ticker!.isActive;
```

**所以 `controller.isAnimating` 为 true 时，回调不一定在被调用**——`TickerMode(enabled: false)` 下面就是这样：动画在"跑"，但一帧都没画（第 21 篇展开它与 `status.isAnimating` 的分裂）。

### 4.8 `TickerFuture`：为什么"取消"要单独造一个 future

它内部有**两个** `Completer`：`_primaryCompleter`（`:439`）加上懒创建的 `_secondaryCompleter`（`:440`），并用一个 `bool? _completed`（`null` 未结束 / `true` 完成 / `false` 取消）记录终局。`_complete()`（`:443`）同时完成两个；`_cancel(ticker)`（`:450`）只给 `_secondaryCompleter` 传错误。

设计上有两条规则值得单独记住：

1. **被取消时主 future 不完成，也不报错。** 取消走的是 `_secondaryCompleter`（也就是 `orCancel`），主 `Completer` 永远悬着。这正是文档里那句"if the animation is canceled, the future never completes"的实现。
2. **`orCancel` 是延迟创建的。** 如果从头到尾没访问过 `orCancel`，`_secondaryCompleter` 是 null，`_cancel` 里的 `completeError` 就什么都不做——**取消不会产生未捕获异常**。一旦访问过，取消就会让 `orCancel` 抛出：

`orCancel` 的 getter（`:478-489`）里有一个 `if (_completed != null)` 分支：**在 ticker 已经被取消之后才第一次访问 `orCancel`，会立刻拿到 `TickerCanceled` 错误**（且它的 `ticker` 字段是 null，因为没有人把它传进来）。这是"迟到观察"路径。

`whenCompleteOrCancel`（`:462`）是这条规则之上的糖：它通过给 `orCancel` 注册异常处理器，把"正常完成"和"被取消"合并成一个 `VoidCallback`，同时避免了未捕获异常。

## 五、核心对象：三方职责与两种"停"

| | `TickerProvider` | `Ticker` | `SchedulerBinding` |
|---|---|---|---|
| 类型 | 抽象接口（1 个方法） | 具体类 | mixin |
| 关心 vsync 信号 | 否 | **否** | 是（`platformDispatcher.onBeginFrame`） |
| 关心 `AnimationController` | 否 | 只认得一个 `TickerCallback` | 否 |
| 关心 `TickerMode` | **是**（实现类里） | 只接受 `muted` 布尔值 | 否 |
| 持有回调容器 | 否 | 只持有 `int? _animationId` | 持有整张瞬态回调表 |
| 生命周期 | 跟随 `State` | 跟随 `AnimationController` | 跟随进程 |

`muted` 与 `stop` 的对比是这一篇最该记住的一张表：

| | `muted = true` | `stop()` |
|---|---|---|
| `isActive` | **true（不变）** | false |
| `isTicking` | false | false |
| `_future` | 保持（动画逻辑仍在进行） | 完成（`canceled: false`）或取消（`canceled: true`） |
| `_startTime` | 保持 | 清空 |
| 时间是否继续流逝 | **是** | 否（`_future` 已空，`isActive` 为 false） |
| 谁能触发 | `TickerProvider`（`TickerMode` 驱动） | `Ticker` 的使用者（`AnimationController`） |
| 恢复后 `elapsed` | 接着原来的 `_startTime` 算，**会跳变** | 下一次 `start()` 从 0 重来 |

## 六、源码实验

### 实验 1：`elapsed` 的第一次是 0，静音期间时钟不停

```dart
late final Ticker ticker;
ticker = Ticker((Duration e) => log.add('tick elapsed=$e isTicking=${ticker.isTicking}'));
ticker.start();
log.add('after start: isActive=${ticker.isActive} isTicking=${ticker.isTicking}');
await tester.pump(const Duration(milliseconds: 16));   // 第 1 帧
await tester.pump(const Duration(milliseconds: 16));   // 第 2 帧
ticker.muted = true;
log.add('muted=true: isActive=${ticker.isActive} isTicking=${ticker.isTicking}');
await tester.pump(const Duration(milliseconds: 16));   // 静音期间
ticker.muted = false;
log.add('muted=false: isActive=${ticker.isActive} isTicking=${ticker.isTicking}');
await tester.pump(const Duration(milliseconds: 16));
```

**预测**：`start()` 之后立刻 `isActive` 为 true；第一次 `elapsed` 是 16ms（距 start 过了一帧）；静音后 `isTicking` 变 false 但 `isActive` 不变。

**实际**（实测输出）：

```text
after start: isActive=true isTicking=true
tick elapsed=0:00:00.000000 isTicking=true     ← 第一次是 0，不是 16ms
tick elapsed=0:00:00.016000 isTicking=true
muted=true: isActive=true isTicking=false
muted=false: isActive=true isTicking=true
tick elapsed=0:00:00.048000 isTicking=true     ← 从 16ms 直接跳到 48ms
after stop: isActive=false futureCompleted=true
```

**说明**：三处都与预测不符或需要修正，全部能在源码里找到原因：

1. **第一次 `elapsed` 是 0**。因为 `start()` 在帧外调用，`schedulerPhase` 是 `idle`，`:202` 的条件不成立，`_startTime` 保持 null；第一次 `_tick` 里 `_startTime ??= timeStamp` 把它设成了"本帧的时间戳"，于是 `elapsed = timeStamp - _startTime = 0`。**动画的时长是从第一次 tick 开始算的，不是从 `start()` 开始算的。**
2. **`muted` 期间 `isActive` 保持 true、`isTicking` 变 false**（`:141-155` 的前两个分支）。
3. **解除静音后 `elapsed` 从 16ms 直接跳到 48ms**：静音跨越了一个完整的 pump 间隔，`_startTime` 没有变，所以跳变被如实反映出来。这直接证明"静音 ≠ 暂停时钟"。

### 实验 2：`stop(canceled: true)` 与 `orCancel`

```dart
final TickerFuture future = ticker.start();
future.whenComplete(() => primaryDone = true);
future.orCancel.catchError((Object e) { cancelError = e; return null; });
ticker.stop(canceled: true);
```

**实际**（实测输出）：

```text
canceled: primaryCompleted=false orCancelError=TickerCanceled
cancelError=This ticker was canceled: Ticker()
```

**说明**：主 future **没有完成**（`primaryDone` 一直是 false），只有 `orCancel` 抛了错。这验证了 4.8 的两条规则。反面对照：`ticker.stop()`（默认 `canceled: false`）时实测 `futureCompleted=true`。

**实际使用中的意义**：`await controller.forward()` 在动画被中途取消时会**永久挂起**，而 `await controller.forward().orCancel` 会抛出 `TickerCanceled`。`AnimationController` 的文档示例（`animation_controller.dart:182-193`）正是用后者配合 `on TickerCanceled` 来写的。

### 实验 3：Ticker 与引擎之间没有任何直接联系

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/scheduler
grep -in "vsync" ticker.dart            # 0 命中
grep -n "platformDispatcher" ticker.dart  # 0 命中
grep -n "SchedulerBinding" ticker.dart    # 13 命中（4 条是文档注释，其余只在 6 个调用/属性上）
```

**预测**：Ticker 会读引擎的刷新率或 vsync 周期。

**实际**：`ticker.dart` 里 `vsync`、`platformDispatcher`、`onBeginFrame`、刷新率相关标识全部零命中。

**说明**：Ticker 对外的全部依赖就是 `SchedulerBinding` 的四个方法——`scheduleFrame`（`:296`）、`scheduleForcedFrame`（`:294`）、`scheduleFrameCallback`（`:298`）、`cancelFrameCallbackWithId`（`:314`），加上读 `framesEnabled`/`schedulerPhase`/`currentFrameTimeStamp` 三个属性。**"跟着刷新率"这个性质不在 Ticker 里，而在引擎给 `SchedulerBinding` 的 vsync 里。**

### 实验 4：`TickerMode` 如何变成 `muted`

```bash
grep -rn "\.muted = " packages/flutter/lib/src --include="*.dart"
```

**实际**：`lib/src` 里写 `muted` 的地方只有三处，全在同一个文件：

```text
widgets/ticker_provider.dart:389      _ticker!.muted = !values.enabled;        // Single. 的 _updateTicker
widgets/ticker_provider.dart:460          ..muted = !values.enabled            // TickerProviderStateMixin.createTicker
widgets/ticker_provider.dart:487        ticker.muted = muted;                  // TickerProviderStateMixin._updateTickers
```

**说明**：按 `ticker.dart:62-70` 的约定，`muted` 由"创建这个 Ticker 的 `TickerProvider`"控制，而 `start`/`stop` 由"消费 tick 的对象"控制。**framework 严格遵守了这条分工**——`AnimationController` 从头到尾没有写过 `_ticker.muted`，它只读（`animation_controller.dart:960` 的 `toStringDetails` 里读一次）。

## 七、结论

1. "vsync" 在 scheduler 层不是信号，而是 `TickerProvider` 这个只含一个 `createTicker` 方法的接口。接口定义在 scheduler，全部实现在 widgets（`TickerMode` 驱动 muted）和 flutter_test。Ticker 自己对引擎的依赖是零——它只用 `SchedulerBinding` 的四个方法。
2. `elapsed` 的起点是"第一次 tick"，不是 `start()`。帧外 `start()` 时第一次 `elapsed` 恒为 0（由 `_startTime ??= timeStamp` 兜底）；帧内 `start()` 时会立刻取 `currentFrameTimeStamp`，把本帧已过的时间算进去。这个判断依赖 `SchedulerPhase` 的枚举顺序，比较方式是索引而不是相等。
3. `muted` 与 `stop` 的分界线是 `_future`：`muted` 不动 future（`isActive` 仍为 true，时间继续流逝，恢复后 `elapsed` 会跳变），`stop` 清掉 future。`TickerFuture` 被取消时主 future 永不完成，错误只出现在 `orCancel` 上，且 `orCancel` 未访问过时取消不产生任何异常。

一句话总结：**Ticker 是"帧回调的订阅者"，vsync 只是它订阅时用来登记 `muted` 的对象；真正订阅屏幕刷新的是 SchedulerBinding。**

## 八、边界声明

- 本篇不展开 `AnimationController` 如何把 `elapsed` 变成 `value`。`_tick`、Simulation、Curve 交给第 21、22 篇。
- `TickerMode` 的 InheritedWidget 细节（`_EffectiveTickerMode`、`TickerMode.getValuesNotifier` 的依赖注册）属于 widgets 层的 InheritedWidget 主题，留到第九卷。
- `TickerProviderStateMixin` 的 dispose 断言、`_WidgetTicker` 的回登记属于 widgets 层细节，本篇只给出锚点。
- `rescheduling` 参数对 `debugStack` 的影响只做原理说明；`_FrameCallbackEntry` 的完整调试栈机制见第 18 篇。
- 本篇聚焦 Ticker 的层内定位、注销路径与 vsync 接口，不展开使用方式与常见异常场景。
