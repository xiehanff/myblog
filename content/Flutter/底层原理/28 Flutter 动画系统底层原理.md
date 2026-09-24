# Flutter 动画系统底层原理

## 一、动画系统架构总览

### 核心组件

Flutter 动画系统由四个核心角色协同工作：

| 组件 | 职责 | 类比 |
|------|------|------|
| `AnimationController` | 驱动时间，管理动画生命周期 | 发动机 |
| `Curve` | 对时间做非线性变换 | 变速器 |
| `Tween` | 将归一化值映射到目标类型和范围 | 齿轮比 |
| `Animation` | 对外暴露当前值，供 UI 订阅 | 仪表盘 |

用一个现实世界的类比来理解：

- **AnimationController（发动机）**：产生动力，驱动时间从 0 流向 1（或反向）
- **Curve（变速器）**：改变时间的流速——起步慢、中间快、结尾弹一下，都是它的事
- **Tween（齿轮比）**：把 0~1 的范围映射到你需要的值域——比如把 0~1 映射成 `Color(0xFF000000)` 到 `Color(0xFFFFFFFF)`
- **Animation（仪表盘）**：最终输出一个值，UI 每帧过来看一眼，根据值渲染画面

### 四者协作关系

完整的数值流动链路：

```text
Ticker（VSync 信号）
    ↓ 每帧回调
AnimationController._tick()
    ↓ 计算 value ∈ [0.0, 1.0]
AnimationController.value 变化
    ↓ 通知 listener
CurvedAnimation（如果使用了 Curve）
    ↓ curve.transform(parent.value)
变换后的值 ∈ [0.0, 1.0]
    ↓
Tween.evaluate(animation)
    ↓ lerp(begin, end, t)
最终输出值（Color / Size / double / ...）
    ↓ 通知 listener
AnimatedBuilder / AnimatedWidget
    ↓ markNeedsBuild / markNeedsPaint
RenderObject 更新 → 画面变化
```

关键点：**不是所有动画都需要四个角色全部登场**。

- 最简形式：`AnimationController` 本身就是 `Animation<double>`，可以直接驱动需要 0.0~1.0 值的场景
- 需要 0~1 之外的值域时：加 `Tween`
- 需要非匀速运动时：加 `Curve`
- 隐式动画把这些全部封装进 Widget，开发者只改属性值

### 继承关系

```text
Listenable（通知接口）
    └── Animation<T>（动画值接口，持有 value + status）
            └── AnimationController（具体实现，管理时间与状态）

Animatable<T>（插值接口，输入 0.0~1.0 输出 T）
    └── Tween<T>（线性插值）
    └── TweenSequence<T>（多段插值）
    └── CurveTween（应用一条 Curve）

ParametricCurve<T>（参数曲线接口，与 Animatable 是平行的两套接口）
    └── Curve（曲线变换，本质 ParametricCurve<double>，映射 [0,1] → [0,1]）

Animation<double>（可以是 Controller，也可以是 CurvedAnimation）
    └── CurvedAnimation（代理模式，套一层 Curve 变换）
```

注意 `Curve` 不是 `Animatable` 的子类——两者都提供 `transform(double t)` 方法，但分属 `ParametricCurve` 和 `Animatable` 两个独立接口。要把 `Curve` 接入 `Animatable` 体系，用的是 `CurveTween`（它内部持有一条 `Curve` 并实现 `Animatable<double>`）。

## 二、AnimationController 深入

### 类定义与继承

`AnimationController` 同时继承了 `Animation<double>` 和 `AnimationLocalListenersMixin`、`AnimationLocalStatusListenersMixin`，是一个完整的动画控制器。

```dart
// 简化后的继承关系
class AnimationController extends Animation<double>
    with AnimationEagerListenerMixin, AnimationLocalListenersMixin,
         AnimationLocalStatusListenersMixin {
  // ...
}
```

它的核心定位是：**管理一个在 `[lowerBound, upperBound]` 范围内随时间变化的 `double` 值**。

### 与 Ticker 的绑定

`AnimationController` 自身不直接和帧系统打交道，而是通过 `Ticker` 间接实现：

```dart
// 创建 Controller 时需要传入 TickerProvider
final controller = AnimationController(
  vsync: this, // SingleTickerProviderStateMixin 或 TickerProviderStateMixin
  duration: const Duration(seconds: 2),
);

// TickerProvider mixin 的核心方法（简化自 widgets/ticker_provider.dart）
mixin SingleTickerProviderStateMixin<T extends StatefulWidget> on State<T>
    implements TickerProvider {
  Ticker? _ticker;

  @override
  Ticker createTicker(TickerCallback onTick) {
    assert(() {
      if (_ticker == null) {
        return true;
      }
      // 只允许创建一个 Ticker，第二次调用直接报错
      throw FlutterError(
        '$runtimeType is a SingleTickerProviderStateMixin but multiple tickers were created.',
      );
    }());
    _ticker = Ticker(onTick, debugLabel: kDebugMode ? 'created by $this' : null);
    _updateTickerModeNotifier(); // 监听子树的 TickerMode
    return _ticker!;
  }

  @override
  void dispose() {
    assert(() {
      if (_ticker == null || !_ticker!.isActive) {
        return true;
      }
      // 关键机制：dispose 时 Ticker 仍在运行 → 抛错提醒泄漏
      throw FlutterError('$this was disposed with an active Ticker.');
    }());
    _tickerModeNotifier?.removeListener(_updateTicker);
    super.dispose();
  }
}
```

`TickerProvider` 是一个工厂接口，`AnimationController` 通过它创建 `Ticker`。注意一个关键分工：**mixin 并不负责 dispose Ticker**——Ticker 的释放由它的使用者（`AnimationController.dispose()` 内部调用 `_ticker.dispose()`）完成；mixin 只在 `dispose()` 时**检查** Ticker 是否仍处于激活状态，若仍在运行就抛出 `FlutterError`，强制开发者意识到泄漏。这把"Ticker 必须被停掉"变成了一个开发期就会爆炸的约束，而不是默默浪费帧回调。

### 核心属性

```dart
class AnimationController extends Animation<double> with ... {
  // 值域边界（final，构造时确定）
  final double lowerBound; // 默认 0.0
  final double upperBound; // 默认 1.0

  // 动画时长（运行中可修改，didUpdateWidget 里同步就是改它们）
  Duration? duration;         // 正向时长
  Duration? reverseDuration;  // 反向时长（不设置则与 duration 相同）

  // 当前值
  double get value => _value;
  double _value;

  // 动画状态
  AnimationStatus get status => _status;

  // 运行方向
  _AnimationDirection get _direction => ...;
}
```

### 核心方法

```dart
// 正向播放
TickerFuture forward({ double? from });

// 反向播放
TickerFuture reverse({ double? from });

// 根据 status 自动选择 forward/reverse
TickerFuture toggle({ double? from });

// 循环播放
TickerFuture repeat({
  double? min,
  double? max,
  bool reverse = false,
  Duration? period,
  int? count, // 指定后播放 count 轮即停止；否则无限循环
});

// 重置到下界
void reset();

// 停止动画
void stop({ bool canceled = true });

// 动画到指定值
TickerFuture animateTo(double target, {
  Duration? duration,
  Curve curve = Curves.linear,
});

// 反向动画到指定值
TickerFuture animateBack(double target, {
  Duration? duration,
  Curve curve = Curves.linear,
});

// 用物理模拟（弹簧）抛掷动画
TickerFuture fling({
  double velocity = 1.0,
  SpringDescription? springDescription, // 默认临界阻尼弹簧（stiffness 500）
  AnimationBehavior? animationBehavior,
});

// 直接挂载一个自定义 Simulation 驱动
TickerFuture animateWith(Simulation simulation);
```

每个方法都会返回一个 `TickerFuture`（`Future<void>` 的自定义实现）：动画正常播完时它会 complete；动画被取消（中断、dispose）时它**永远不会 complete**，对应的 `orCancel` 派生 Future 则会抛出 `TickerCanceled`。所以 `await controller.forward()` 会一直等到动画真正结束。

### `_tick(Duration elapsed)` 内部逻辑

这是 `AnimationController` 每一帧被调用的核心方法。`Ticker` 在每帧回调时传入的 `elapsed` 是**从 Ticker 启动开始累计的总时长**（不是距上一帧的时间差），Controller 把它交给当前的 `_simulation` 换算出 value：

```dart
// AnimationController._tick() 简化逻辑
void _tick(Duration elapsed) {
  // 1. elapsed：自动画开始以来累计的时间
  _lastElapsedDuration = elapsed;
  final double elapsedInSeconds =
      elapsed.inMicroseconds.toDouble() / Duration.microsecondsPerSecond;

  // 2. 用 Simulation 把时间映射为值，再夹到 [lowerBound, upperBound]
  //    forward/reverse 用 _InterpolationSimulation，repeat 用 _RepeatingSimulation，
  //    fling 用 SpringSimulation——统一都走这一条路径
  _value = clampDouble(_simulation!.x(elapsedInSeconds), lowerBound, upperBound);

  // 3. 到达终点：更新状态并停止（stop(canceled: false) 会让 TickerFuture complete）
  if (_simulation!.isDone(elapsedInSeconds)) {
    _status = (_direction == _AnimationDirection.forward)
        ? AnimationStatus.completed
        : AnimationStatus.dismissed;
    stop(canceled: false);
  }

  // 4. 先通知 value listener（UI 更新）
  notifyListeners();

  // 5. 再检查状态是否变化，通知 status listener
  _checkStatusChanged();
}
```

`_simulation.x(t)` 怎么算？以 `forward()` 为例，内部会构造一个 `_InterpolationSimulation`：

```dart
// _InterpolationSimulation.x()（简化）
double x(double timeInSeconds) {
  final double t = clampDouble(timeInSeconds / _durationInSeconds, 0.0, 1.0);
  return switch (t) {
    0.0 => _begin,
    1.0 => _end,
    _   => _begin + (_end - _begin) * _curve.transform(t), // curve 默认 linear
  };
}
```

也就是说：**Controller 每帧都根据"总 elapsed / 总时长"从头算出当前值，而不是在旧值上做增量累加**。这个设计让 repeat、fling、animateTo 都能统一成"给一个 Simulation，按时间取值"的模式。

简化后的核心流程：

```text
Ticker 收到 VSync
    ↓ 计算 elapsed = 当前帧时间戳 - 启动时间戳（累计值）
Controller._tick(elapsed)
    ↓ simulation.x(elapsed / duration) = 当前比例对应的值
    ↓ value = clamp(value, lowerBound, upperBound)
    ↓ notifyListeners()  → UI 更新
    ↓ simulation.isDone(elapsed) ?  更新 status + stop(canceled: false)
    ↓ _checkStatusChanged()  → notifyStatusListeners()  → 状态回调
```

### AnimationStatus 状态流转

`AnimationStatus` 描述动画当前处于生命周期的哪个阶段：

```text
dismissed ──forward()──→ forward ──到达 upperBound──→ completed
    ↑                                                         │
    │                    reverse()                           │
    │                                                        ↓
    ←────── reverse ←──── 到达 lowerBound ←──────
```

各状态的含义：

| 状态 | 条件 | value |
|------|------|-------|
| `dismissed` | 动画在起点（下界），且不在播放 | `lowerBound` |
| `forward` | 动画正在从下界向上界运动 | `[lowerBound, upperBound)` |
| `completed` | 动画到达终点（上界） | `upperBound` |
| `reverse` | 动画正在从上界向下界运动 | `(lowerBound, upperBound]` |

`_direction` 与状态的关系：

- `_direction.forward`：value 在增大，当前 status 为 `forward`（未到达上界时）或 `completed`（到达上界时）
- `_direction.reverse`：value 在减小，当前 status 为 `reverse`（未到达下界时）或 `dismissed`（到达下界时）

### dispose 释放 Ticker

`AnimationController.dispose()` 内部会调用 `Ticker.dispose()`，把注册到 `SchedulerBinding` 的帧回调取消掉：

```dart
// AnimationController.dispose()（简化）
@override
void dispose() {
  _ticker!.dispose();       // 取消帧回调；若仍在运行，还会 cancel 掉 TickerFuture
  _ticker = null;
  clearStatusListeners();
  clearListeners();
  super.dispose();
}

// Ticker.dispose()（简化）
@mustCallSuper
void dispose() {
  if (_future != null) {
    // 仍在运行：取消已注册的帧回调，并把 future 置为 canceled
    final TickerFuture localFuture = _future!;
    _future = null;
    unscheduleTick();
    localFuture._cancel(this);
  }
}
```

注意 `Ticker.dispose()` 并不会抛错——它只是安静地取消帧回调。真正"忘了停掉动画就报错"的防线在 `SingleTickerProviderStateMixin` / `TickerProviderStateMixin` 的 `dispose()` 断言里（见上一节）。如果连 Controller 都忘了 dispose，Ticker 会继续接收帧回调，AnimationController 也会持续计算和通知——这是最常见的动画内存泄漏根源。

## 三、Ticker 帧驱动本质

### Ticker 是什么

`Ticker` 的职责非常单一：**将引擎的 VSync 信号转化为每个动画帧的回调**。

```dart
class Ticker {
  Ticker(this._onTick, { this.debugLabel });

  // 核心回调
  final TickerCallback _onTick;

  // 时间是否在流逝（start 后、stop 前为 true；muted 不影响它）
  bool get isActive => _future != null;

  // 是否被静默（由 TickerMode 控制）
  bool get muted => _muted;
  bool _muted = false;

  // 是否真正在回调：活跃 + 未静默 + 帧可用
  bool get isTicking { ... }

  // 是否需要注册下一帧回调
  @protected
  bool get shouldScheduleTick => !muted && isActive && !scheduled;
}
```

Ticker 本身不管理值、不管理状态、不知道动画方向——它唯一的任务就是：**"我在运行中时，每帧告诉你一次当前的时间戳"**。

### 创建与回调注册

```dart
// Ticker 的构造
Ticker(TickerCallback onTick, {String? debugLabel});

// onTick 的签名
typedef TickerCallback = void Function(Duration elapsed);
```

`elapsed` 是从 Ticker 启动后累计的时长，不是绝对时间戳。

### Ticker 的生命周期

```text
createTicker(onTick)     ← AnimationController 通过 TickerProvider 创建
    ↓
start()                  ← forward() / repeat() 等方法触发
    │
    │  ┌──→ SchedulerBinding.scheduleFrameCallback()
    │  │       ↓
    │  │    VSync 到来
    │  │       ↓
    │  │    _tick(Duration timestamp)
    │  │       ↓
    │  │    计算 elapsed = timestamp - _startTime
    │  │       ↓
    │  │    _onTick(elapsed)  →  AnimationController._tick(elapsed)
    │  │       ↓
    │  │    再次 scheduleFrameCallback()  ← 注册下一帧
    │  └───┘
    ↓
stop()                   ← 动画完成或被手动停止
    │
    │    取消帧回调
    ↓
dispose()                ← 永久停止，不可重启
```

#### `Ticker.start()` 源码

```dart
// Ticker.start() 简化
TickerFuture start() {
  assert(_startTime == null);
  // 1. 创建与本次运行绑定的 TickerFuture
  _future = TickerFuture._();
  // 2. 注册帧回调——这才是和帧系统对接的关键
  if (shouldScheduleTick) {
    scheduleTick();
  }
  // 3. 若是在帧的中间阶段（build/layout/paint）启动，
  //    用当前帧时间戳作为起点；否则留给首次 tick 时回填
  if (SchedulerBinding.instance.schedulerPhase.index > SchedulerPhase.idle.index &&
      SchedulerBinding.instance.schedulerPhase.index < SchedulerPhase.postFrameCallbacks.index) {
    _startTime = SchedulerBinding.instance.currentFrameTimeStamp;
  }
  return _future!;
}

void scheduleTick({ bool rescheduling = false }) {
  assert(!scheduled);
  assert(shouldScheduleTick);
  // 让 SchedulerBinding 安排下一帧（scheduleFrame）
  SchedulerBinding.instance.scheduleFrame();
  // 注册 transient callback——这正是动画回调在 handleBeginFrame 阶段执行的原因
  _animationId = SchedulerBinding.instance.scheduleFrameCallback(
    _tick,
    rescheduling: rescheduling,
  );
}
```

#### `Ticker._tick()` 源码

```dart
// Ticker._tick() 简化
void _tick(Duration timeStamp) {
  // 清除当前帧的回调标记（下一帧会重新注册）
  _animationId = null;

  // 首帧兜底：start 时若拿不到帧时间戳，在这里回填
  _startTime ??= timeStamp;

  // 计算"从启动到现在"的累计时间，交给回调
  _onTick(timeStamp - _startTime!);

  // 回调里可能已经 stop/start（重新调度过），确认后注册下一帧回调
  if (shouldScheduleTick) {
    scheduleTick(rescheduling: true);
  }
}
```

注意这个重新注册的模式：**每帧 tick 完成后，再注册下一帧**。这样当 `stop()` 被调用后，不会注册新的回调，动画自然停止。

### TickerMode：控制 Ticker 是否激活

`TickerMode` 是一个 Widget，通过 `InheritedWidget` 机制控制子树中所有 Ticker 的 `muted` 状态：

```dart
// 简化逻辑（widgets/ticker_provider.dart）
class _TickerModeState extends State<TickerMode> {
  // 有效开关 = 祖先 TickerMode 的值 && 自己的值（任何一层为 false 都静默）
  final ValueNotifier<bool> _effectiveMode = ValueNotifier<bool>(true);

  void _updateEffectiveMode() {
    _effectiveMode.value = _ancestorTickerMode && widget.enabled;
  }

  @override
  Widget build(BuildContext context) {
    // 用 InheritedWidget 把 ValueNotifier 向下分发，
    // TickerProviderStateMixin 等通过 TickerMode.getValuesNotifier(context) 订阅它
    return _EffectiveTickerMode(
      enabled: _effectiveMode.value,
      notifier: _effectiveMode,
      child: widget.child,
    );
  }
}
```

当子树处于 `TickerMode(enabled: false)` 中时（`Visibility(maintainState: true, maintainAnimation: false)` 与 Overlay 都会这样包一层）：

- TickerProvider mixin 收到通知，把 Ticker 的 `muted` 设为 `true`
- 已注册的帧回调被取消（`unscheduleTick()`），`shouldScheduleTick` 返回 `false`
- `onTick` 不再被调用
- 但 Ticker 仍然处于 `isActive` 状态

一个容易误解的点：**muted 是"静默"而不是"暂停"**。Ticker 的时间基准 `_startTime` 没有变，时间照常流逝，恢复 enabled 后动画会直接跳到"当前时刻应该所处的值"，而不是从静默处继续。框架的 `Overlay` 就利用这一机制：当一条路由被完全遮挡时，它用 `TickerMode` 让下层路由的动画静默，避免无意义的每帧计算（详见 [TickerMode 类文档](https://api.flutter.dev/flutter/widgets/TickerMode-class.html)）。

### `_tickerFuture` 与 `TickerFuture`

`TickerFuture` 是 `Future<void>` 的一个自定义实现，与 Ticker 的一次"运行"绑定（`start()` 时创建、`stop()` 时终结）：

```dart
class TickerFuture implements Future<void> {
  // Ticker 正常 stop（canceled: false）时调用：future 正常 complete
  void _complete() { ... }

  // Ticker 被 stop(canceled: true) 或未停止就被 dispose 时调用：
  // 主 future 永不 complete，只让 orCancel 的派生 future 抛 TickerCanceled
  void _cancel(Ticker ticker) { ... }

  // 获取一个在取消时抛 TickerCanceled 的派生 Future
  Future<void> get orCancel;

  // 无论正常结束还是取消都会回调
  void whenCompleteOrCancel(VoidCallback callback) { ... }
}
```

使用场景：

```dart
// forward() 返回的 TickerFuture 在动画正常播完（内部 stop(canceled: false)）时 complete
await controller.forward();
print('动画完成');

// 如果动画被中断，上面的 await 永远不会返回；
// 想感知"中断"，要用 orCancel——它会在取消时抛出 TickerCanceled
try {
  await controller.forward().orCancel;
} on TickerCanceled {
  // 动画被打断（通常是 State 被 dispose）
}
```

### TickerProviderStateMixin vs SingleTickerProviderStateMixin

```dart
// 支持多个 Ticker（简化自 widgets/ticker_provider.dart）
mixin TickerProviderStateMixin<T extends StatefulWidget> on State<T>
    implements TickerProvider {
  Set<Ticker>? _tickers;

  @override
  Ticker createTicker(TickerCallback onTick) {
    _tickers ??= <_WidgetTicker>{};
    // 每个都由独立的 _WidgetTicker 承载，创建时就套上当前的 TickerMode 状态
    final result = _WidgetTicker(onTick, this,
            debugLabel: kDebugMode ? 'created by $this' : null)
        ..muted = !_tickerModeNotifier!.value.enabled;
    _tickers!.add(result);
    return result;
  }

  // _WidgetTicker.dispose() 时会把自己从 _tickers 中移除——
  // 所以集合里始终是"还活着的 Ticker"
  void _removeTicker(_WidgetTicker ticker) {
    _tickers!.remove(ticker);
  }

  @override
  void dispose() {
    assert(() {
      if (_tickers != null) {
        for (final Ticker ticker in _tickers!) {
          if (ticker.isActive) {
            // 任何一个 Ticker 仍在运行都在开发期报错
            throw FlutterError('$this was disposed with an active Ticker.');
          }
        }
      }
      return true;
    }());
    super.dispose();
  }
}

// 只支持一个 Ticker（见前文第二章的完整版）
mixin SingleTickerProviderStateMixin<T extends StatefulWidget> on State<T>
    implements TickerProvider {
  Ticker? _ticker;
  // ...
}
```

区别：

| 特性 | `SingleTickerProviderStateMixin` | `TickerProviderStateMixin` |
|------|------|------|
| Ticker 数量 | 最多 1 个 | 无限制（每个 createTicker 一个） |
| 内存开销 | 更小 | 略大（维护 Set） |
| 适用场景 | 只有一个动画的 Widget | 有多个动画的 Widget |
| 创建第二个时 | 抛 FlutterError | 正常返回新 Ticker |
| dispose 时有 active Ticker | 抛 FlutterError | 抛 FlutterError |

两者的防泄漏机制是一样的：**Ticker 的所有权跟着 createTicker 走**——谁调用 `vsync.createTicker()`（通常是 `AnimationController` 的构造函数），谁就负责在 `dispose()` 里停掉它。mixin 只做"记账 + 验尸"：记录自己发出去的 Ticker，在 State dispose 时逐个检查是否仍有 active 的，有就在 debug 模式直接抛错，把泄漏扼杀在开发期（错误信息与完整机制见 [TickerProviderStateMixin 类文档](https://api.flutter.dev/flutter/widgets/TickerProviderStateMixin-class.html)）。所以规范写法永远是 `AnimationController.dispose()`（它会停掉并释放 Ticker），而不是自己去操作 Ticker。

如果只有一个 `AnimationController`，用 `Single` 更高效也更安全。

### 自定义 Ticker 观察帧回调

```dart
import 'package:flutter/scheduler.dart';

class FrameObserver extends StatefulWidget {
  const FrameObserver({super.key});

  @override
  State<FrameObserver> createState() => _FrameObserverState();
}

class _FrameObserverState extends State<FrameObserver>
    with SingleTickerProviderStateMixin {
  late Ticker _ticker;
  int _frameCount = 0;
  Duration? _lastElapsed;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((Duration elapsed) {
      setState(() {
        _frameCount++;
        _lastElapsed = elapsed;
      });
    });
    _ticker.start();
  }

  @override
  void dispose() {
    _ticker.dispose(); // 必须释放
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Text(
      '帧数: $_frameCount, 累计时间: ${_lastElapsed?.inMilliseconds ?? 0}ms',
    );
  }
}
```

## 四、Tween 与插值器

### Animatable 基类

`Animatable<T>` 是所有插值器的基类：

```dart
abstract class Animatable<T> {
  // 核心方法：根据动画值计算结果
  T transform(double t);

  // 便捷方法：直接从 Animation 对象取值并计算
  T evaluate(Animation<double> animation) => transform(animation.value);

  // 返回一个新的 Animation，内部监听 parent 的变化并实时计算
  Animation<T> animate(Animation<double> parent) {
    return _AnimatedEvaluation<T>(parent, this);
  }
}
```

`Animatable` 本身不是动画，它只是一个"值变换器"——输入一个 `double`，输出一个 `T`。

### Tween 的工作原理

`Tween<T>` 的核心就是 **线性插值（Linear Interpolation, lerp）**：

```dart
class Tween<T extends Object?> extends Animatable<T> {
  Tween({ this.begin, this.end });

  T? begin;
  T? end;

  // 默认实现用 +、-、* 运算符做插值：begin + (end - begin) * t
  // 所以 Tween<double> 等支持算术运算的类型可以直接用；
  // 不支持这些运算符的类型（Color、Rect 等）要子类化并重写 lerp
  @protected
  T lerp(double t) {
    ...
    return (begin as dynamic) + ((end as dynamic) - (begin as dynamic)) * t as T;
  }

  @override
  T transform(double t) {
    if (t == 0.0) return begin as T;
    if (t == 1.0) return end as T;
    return lerp(t);
  }
}
```

关键：`t` 的范围是 `[0.0, 1.0]`，`t=0` 返回 `begin`，`t=1` 返回 `end`，中间值做线性映射。

#### 具体类型 Tween 的 lerp 实现

```dart
// ColorTween
class ColorTween extends Tween<Color?> {
  @override
  Color? lerp(double t) => Color.lerp(begin, end, t);
}

// SizeTween
class SizeTween extends Tween<Size?> {
  @override
  Size? lerp(double t) => Size.lerp(begin, end, t);
}

// IntTween
class IntTween extends Tween<int?> {
  @override
  int? lerp(double t) => (begin! + (end! - begin!) * t).round();
}

// RectTween
class RectTween extends Tween<Rect?> {
  @override
  Rect? lerp(double t) => Rect.lerp(begin, end, t);
}
```

### `Tween.animate(parent)` 的内部类

当调用 `tween.animate(controller)` 时，返回的是 `_AnimatedEvaluation<T>`：

```dart
class _AnimatedEvaluation<T> extends Animation<T>
    with AnimationWithParentMixin<double> {
  _AnimatedEvaluation(this.parent, this._evaluatable);

  // 通过 AnimationWithParentMixin 暴露 parent，
  // 自身的 listener/status 转发也都由该 mixin 代理给 parent
  @override
  final Animation<double> parent;

  final Animatable<T> _evaluatable;

  @override
  T get value => _evaluatable.evaluate(parent);
}
```

它是一个 `Animation<T>` 对象，每帧通过读取 `parent.value`（即 AnimationController 的当前值），再调用 `_evaluatable.transform(value)` 来计算最终值。当 parent 的 value 变化时，这个 Animation 的 value 也会变化，从而触发它自身的 listener。

### 常见 Tween 类型

| Tween 类型 | 输出类型 | 内部 lerp |
|-----------|---------|-----------|
| `Tween<double>` | `double` | 算术线性插值 |
| `IntTween` | `int` | 线性插值 + round |
| `ColorTween` | `Color?` | `Color.lerp()`（ARGB 通道分别插值） |
| `SizeTween` | `Size?` | `Size.lerp()`（width、height 分别插值） |
| `RectTween` | `Rect?` | `Rect.lerp()` |
| `AlignmentTween` | `Alignment?` | `Alignment.lerp()` |
| `EdgeInsetsTween` | `EdgeInsets?` | `EdgeInsets.lerp()` |
| `BorderRadiusTween` | `BorderRadius?` | `BorderRadius.lerp()` |
| `TextStyleTween` | `TextStyle?` | `TextStyle.lerp()` |

### TweenSequence：多段 Tween 的连续插值

当一个动画需要分阶段变化时，使用 `TweenSequence`：

```dart
final animation = AnimationController(
  vsync: this,
  duration: const Duration(seconds: 3),
);

final colorAnimation = TweenSequence<Color?>(
  [
    // 前 25%：透明 → 红色
    TweenSequenceItem(
      tween: ColorTween(begin: Colors.transparent, end: Colors.red),
      weight: 25.0,
    ),
    // 中间 50%：红色 → 蓝色
    TweenSequenceItem(
      tween: ColorTween(begin: Colors.red, end: Colors.blue),
      weight: 50.0,
    ),
    // 最后 25%：蓝色 → 绿色
    TweenSequenceItem(
      tween: ColorTween(begin: Colors.blue, end: Colors.green),
      weight: 25.0,
    ),
  ],
).animate(animation);
```

`weight` 表示该段占总时长的权重比例。内部实现中，`TweenSequence.transform(t)` 会根据权重找到当前所在的区间，再做对应的插值。

### 自定义 Tween：实现弹簧效果

```dart
// 弹簧插值器——不使用内置 SpringSimulation，纯 Tween 实现
class SpringTween extends Tween<double> {
  SpringTween({
    double? begin,
    double? end,
    this.stiffness = 100.0,
    this.damping = 10.0,
  }) : super(begin: begin, end: end);

  final double stiffness;
  final double damping;

  @override
  double lerp(double t) {
    // 弹簧函数：使用阻尼正弦波模拟弹簧效果
    final double omega = math.sqrt(stiffness);
    final double beta = damping / (2 * omega);
    final double t1 = math.exp(-beta * omega * t);

    final double beginVal = begin ?? 0.0;
    final double endVal = end ?? 1.0;
    final double delta = endVal - beginVal;

    if (beta < 1.0) {
      // 欠阻尼：会振荡
      final double omegaD = omega * math.sqrt(1 - beta * beta);
      return beginVal + delta * (1 - t1 * (math.cos(omegaD * t) + beta * math.sin(omegaD * t)));
    } else {
      // 过阻尼/临界阻尼：无振荡
      return beginVal + delta * (1 - t1 * (1 + beta * omega * t));
    }
  }
}
```

## 五、Curve 曲线系统

### Curve 基类

`Curve` 是 `ParametricCurve<double>` 的子类（注意不是 `Animatable` 的子类），接收一个 `double`（`[0.0, 1.0]`），输出一个变换后的 `double`：

```dart
abstract class Curve extends ParametricCurve<double> {
  const Curve();

  // Curve 自己重写了 transform：
  // 端点 t=0.0/1.0 直接原样返回，保证任何曲线都映射 0→0、1→1
  @override
  double transform(double t) {
    if (t == 0.0 || t == 1.0) {
      return t;
    }
    return super.transform(t);
  }

  // 曲线反转（把 easeIn 变 easeOut 用）
  Curve get flipped => FlippedCurve(this);
}
```

`ParametricCurve<T>` 定义了通用的参数曲线接口：

```dart
abstract class ParametricCurve<T> {
  const ParametricCurve();

  T transform(double t) {
    assert(t >= 0.0 && t <= 1.0);
    return transformInternal(t);
  }

  @protected
  T transformInternal(double t) {
    throw UnimplementedError(); // 子类必须重写
  }
}
```

### 内置曲线族

Flutter 通过 `Curves` 类提供了大量预定义曲线：

```dart
abstract final class Curves {
  static const Curve linear = _Linear._();
  static const Curve decelerate = _DecelerateCurve._();

  // ease 家族都是三次贝塞尔曲线（Cubic），四个数是两个控制点
  static const Cubic ease = Cubic(0.25, 0.1, 0.25, 1.0);
  static const Cubic easeIn = Cubic(0.42, 0.0, 1.0, 1.0);
  static const Cubic easeOut = Cubic(0.0, 0.0, 0.58, 1.0);
  static const Cubic easeInOut = Cubic(0.42, 0.0, 0.58, 1.0);
  static const Cubic fastOutSlowIn = Cubic(0.4, 0.0, 0.2, 1.0);

  // 弹性曲线：ElasticXxxCurve 是公开类，period 默认 0.4
  static const ElasticInCurve elasticIn = ElasticInCurve();
  static const ElasticOutCurve elasticOut = ElasticOutCurve();
  static const ElasticInOutCurve elasticInOut = ElasticInOutCurve();

  // 弹跳曲线
  static const Curve bounceIn = _BounceInCurve._();
  static const Curve bounceOut = _BounceOutCurve._();
  static const Curve bounceInOut = _BounceInOutCurve._();
}
```

视觉效果描述：

| 曲线 | 速度特征 | 典型场景 |
|------|---------|---------|
| `linear` | 匀速 | 进度条、旋转 |
| `easeIn` | 起步慢，越来越快 | 元素离开屏幕 |
| `easeOut` | 起步快，越来越慢 | 元素进入屏幕 |
| `easeInOut` | 慢 → 快 → 慢 | 通用过渡 |
| `elasticOut` | 超出目标后弹回 | 趣味性交互反馈 |
| `bounceOut` | 反弹效果 | 拖拽释放 |

### 曲线的数学原理

#### `easeInCubic` — 用贝塞尔曲线近似幂函数

`Curves.easeIn` 本身是一条三次贝塞尔曲线 `Cubic(0.42, 0.0, 1.0, 1.0)`。而 `easeIn` 家族里的 `Curves.easeInCubic`（`Cubic(0.55, 0.055, 0.675, 0.19)`）是用贝塞尔去**逼近**幂函数 `f(t) = t³`：

```dart
// 幂函数原型：easeInCubic 想要的形状
double _easeInCubic(double t) {
  return t * t * t; // t³
}
```

值从 0.0 开始，增速越来越快（因为导数 `3t²` 从 0 增长到 3）。Flutter 用贝塞尔而不是直接算幂函数，是为了与 CSS 的 `cubic-bezier()` 语义保持一致。

#### `elasticOut` — 正弦函数 + 指数衰减

```dart
// Curves.elasticOut 的实现（ElasticOutCurve，period 默认 0.4）
double _elasticOut(double t, { double period = 0.4 }) {
  final double s = period / 4;
  return math.pow(2, -10 * t) * math.sin((t - s) * (2 * math.pi) / period) + 1;
}
```

指数衰减 `2^(-10t)` 让振幅越来越小，正弦函数提供振荡。输出值会超过 1.0 再弹回来。

#### `bounceOut` — 分段二次函数

```dart
// 简化：弹跳缓出
double _bounceOut(double t) {
  // 将 [0, 1] 分成 4 段，每段是一段抛物线
  if (t < 1 / 2.75) {
    return 7.5625 * t * t;
  } else if (t < 2 / 2.75) {
    t -= 1.5 / 2.75;
    return 7.5625 * t * t + 0.75;
  } else if (t < 2.5 / 2.75) {
    t -= 2.25 / 2.75;
    return 7.5625 * t * t + 0.9375;
  } else {
    t -= 2.625 / 2.75;
    return 7.5625 * t * t + 0.984375;
  }
}
```

每一段是 `at² + c` 的形式（抛物线），模拟小球从地上弹起又落下的轨迹。

### CurvedAnimation：将 Curve 应用到 Animation 上

`CurvedAnimation` 是一个代理 `Animation<double>`，在值的基础上应用 Curve 变换：

```dart
class CurvedAnimation extends Animation<double>
    with AnimationWithParentMixin<double> {
  CurvedAnimation({
    required this.parent,
    required this.curve,
    this.reverseCurve,
  }) {
    // 构造时就订阅了 parent 的状态，用于判断当前该用哪条曲线
    _updateCurveDirection(parent.status);
    parent.addStatusListener(_updateCurveDirection);
  }

  final Animation<double> parent;
  Curve curve;
  Curve? reverseCurve;

  // 曲线方向只在到达端点（dismissed/completed）时才重置
  AnimationStatus? _curveDirection;

  bool get _useForwardCurve {
    return reverseCurve == null ||
        (_curveDirection ?? parent.status) != AnimationStatus.reverse;
  }

  // 不要忘记释放（它会移除挂在 parent 上的 status listener）
  void dispose() {
    isDisposed = true;
    parent.removeStatusListener(_updateCurveDirection);
  }

  @override
  double get value {
    final Curve? activeCurve = _useForwardCurve ? curve : reverseCurve;
    final double t = parent.value;
    if (activeCurve == null) {
      return t;
    }
    // 端点恒等：0.0 映射 0.0、1.0 映射 1.0，
    // 保证 dismissed/completed 状态下取到的就是端点值
    if (t == 0.0 || t == 1.0) {
      return t;
    }
    return activeCurve.transform(t);
  }
}
```

这里有个精巧的设计值得注意：`_curveDirection` 决定当前用 `curve` 还是 `reverseCurve`，但它**只在动画到达端点时才更新**。如果动画正向播到一半被 `reverse()` 打断，CurvedAnimation 不会立刻切换到 reverseCurve——那样同一点上两条曲线的输出值往往不同，画面会瞬间跳变；它会沿用同一条曲线倒着走，直到下一次到达 dismissed/completed 才切换。这也是官方建议把带 reverseCurve 的 CurvedAnimation 存成 State 成员、不要每次 build 新建的原因——切换逻辑依赖对象内部状态。

使用方式：

```dart
final controller = AnimationController(
  vsync: this,
  duration: const Duration(seconds: 1),
);

// 给 controller 套一层曲线
final curvedAnimation = CurvedAnimation(
  parent: controller,
  curve: Curves.easeInOut,
  reverseCurve: Curves.easeOut, // 反向播放时使用不同曲线
);

// 再用 Tween 做值域映射
final colorAnimation = ColorTween(
  begin: Colors.blue,
  end: Colors.red,
).animate(curvedAnimation);
```

### Interval 曲线：限定动画在特定区间内有效

`Interval` 让动画只在 `[begin, end]` 区间内生效，常用于多个动画的编排：

```dart
// opacity 在前 50% 完成，translate 在后 50% 完成
final opacityAnimation = CurvedAnimation(
  parent: controller,
  curve: const Interval(0.0, 0.5, curve: Curves.easeOut),
);

final translateAnimation = CurvedAnimation(
  parent: controller,
  curve: const Interval(0.5, 1.0, curve: Curves.easeIn),
);
```

内部实现：

```dart
class Interval extends Curve {
  const Interval(this.begin, this.end, { this.curve = Curves.linear });

  final double begin;
  final double end;
  final Curve curve;

  @override
  double transformInternal(double t) {
    // 先把 [begin, end] 之外的 t 夹到边界：t <= begin → 0.0，t >= end → 1.0
    t = clampDouble((t - begin) / (end - begin), 0.0, 1.0);
    // 端点直接返回（0.0/1.0），中间值交给内部 curve 变换
    if (t == 0.0 || t == 1.0) {
      return t;
    }
    return curve.transform(t);
  }
}
```

### 自定义 Curve

```dart
// 自定义阶梯曲线——离散型动画
class StepCurve extends Curve {
  const StepCurve({this.steps = 5});

  final int steps;

  @override
  double transformInternal(double t) {
    return (t * steps).floor() / steps;
  }
}

// 自定义脉冲曲线——先快速到达目标，再微微回落
class PulseCurve extends Curve {
  const PulseCurve({this.overshoot = 0.1});

  final double overshoot;

  @override
  double transformInternal(double t) {
    if (t < 0.5) {
      // 快速到达 1 + overshoot
      return (1 + overshoot) * (t / 0.5);
    } else {
      // 回落到 1.0
      return 1 + overshoot - overshoot * ((t - 0.5) / 0.5);
    }
  }
}
```

## 六、隐式动画 vs 显式动画

### 6.1 显式动画（Explicit Animation）

显式动画是指**开发者手动控制 AnimationController 的生命周期**：什么时候开始、什么时候停止、往哪个方向播放。

#### AnimatedBuilder 的工作原理

`AnimatedBuilder` 是显式动画最常用的 Widget，它的继承链：

```text
AnimatedBuilder
    └── ListenableBuilder
            └── AnimatedWidget
                    └── StatefulWidget
```

`AnimatedWidget` 的核心实现：

```dart
abstract class AnimatedWidget extends StatefulWidget {
  const AnimatedWidget({super.key, required this.listenable});

  final Listenable listenable;

  @override
  State<AnimatedWidget> createState() => _AnimatedState();

  // 子类实现
  @protected
  Widget build(BuildContext context);
}

class _AnimatedState extends State<AnimatedWidget> {
  @override
  void initState() {
    super.initState();
    // 监听 listenable（通常是 AnimationController）
    widget.listenable.addListener(_handleChange);
  }

  @override
  void didUpdateWidget(AnimatedWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.listenable != oldWidget.listenable) {
      oldWidget.listenable.removeListener(_handleChange);
      widget.listenable.addListener(_handleChange);
    }
  }

  void _handleChange() {
    if (!mounted) {
      return; // 回调晚于 dispose 到达时直接忽略
    }
    setState(() {
      // 触发 rebuild
    });
  }

  @override
  void dispose() {
    widget.listenable.removeListener(_handleChange);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.build(context);
}
```

`AnimatedBuilder` 在 3.x 中改为继承 `ListenableBuilder`（两者实现完全相同，只是命名语义不同：动画场景用前者，普通 `Listenable` 用后者）：

```dart
class ListenableBuilder extends AnimatedWidget {
  const ListenableBuilder({
    super.key,
    required super.listenable,
    required this.builder,
    this.child,
  });

  final TransitionBuilder builder;
  final Widget? child;

  @override
  Widget build(BuildContext context) => builder(context, child);
}

class AnimatedBuilder extends ListenableBuilder {
  const AnimatedBuilder({
    super.key,
    required Listenable animation, // 注意：参数名是 animation
    required super.builder,
    super.child,
  }) : super(listenable: animation);

  Listenable get animation => super.listenable;
}
```

核心机制：**AnimationController 的 value 每帧变化 → 触发 listener → `setState()` → rebuild → 调用 `builder`**。

#### 典型使用模式

```dart
class ExplicitAnimationDemo extends StatefulWidget {
  const ExplicitAnimationDemo({super.key});

  @override
  State<ExplicitAnimationDemo> createState() => _ExplicitAnimationDemoState();
}

class _ExplicitAnimationDemoState extends State<ExplicitAnimationDemo>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _sizeAnimation;
  late Animation<Color?> _colorAnimation;

  @override
  void initState() {
    super.initState();

    // 1. 创建 Controller（发动机）
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    );

    // 2. 创建 CurvedAnimation（变速器）
    final curvedAnimation = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeInOut,
    );

    // 3. 创建 Tween 并绑定（齿轮比 → 仪表盘）
    _sizeAnimation = Tween<double>(begin: 100, end: 250).animate(curvedAnimation);
    _colorAnimation = ColorTween(begin: Colors.blue, end: Colors.red).animate(curvedAnimation);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        if (_controller.status == AnimationStatus.completed) {
          _controller.reverse();
        } else {
          _controller.forward();
        }
      },
      child: AnimatedBuilder(
        animation: _controller,
        // child 参数：不会随动画重建的子树
        child: const Text('点击我'),
        builder: (context, child) {
          return Container(
            width: _sizeAnimation.value,
            height: _sizeAnimation.value,
            color: _colorAnimation.value,
            alignment: Alignment.center,
            child: child,
          );
        },
      ),
    );
  }
}
```

### 6.2 隐式动画（Implicit Animation）

隐式动画是指**开发者只需设置目标值，框架自动创建 Controller 并执行过渡**。

#### 核心类层次

```text
ImplicitlyAnimatedWidget（抽象基类）
    ├── AnimatedContainer
    ├── AnimatedOpacity
    ├── AnimatedPositioned
    ├── AnimatedPadding
    ├── AnimatedDefaultTextStyle
    ├── AnimatedAlign
    ├── AnimatedScale
    ├── AnimatedRotation
    ├── AnimatedSlide
    ├── AnimatedSize
    └── ...
```

所有隐式动画 Widget 都继承自 `ImplicitlyAnimatedWidget`，它本身继承自 `StatefulWidget`。

#### `ImplicitlyAnimatedWidgetState` 的内部实现

每个 `ImplicitlyAnimatedWidget` 对应一个 `ImplicitlyAnimatedWidgetState`（`AnimatedContainer` 等需要每帧 rebuild 的子类再继承 `AnimatedWidgetBaseState`），内部自动管理 `AnimationController`：

```dart
abstract class ImplicitlyAnimatedWidget extends StatefulWidget {
  const ImplicitlyAnimatedWidget({
    super.key,
    this.curve = Curves.linear,
    required this.duration, // 注意：duration 是必填项
    this.onEnd,
  });

  final Curve curve;
  final Duration duration;
  final VoidCallback? onEnd;
}

abstract class ImplicitlyAnimatedWidgetState<T extends ImplicitlyAnimatedWidget>
    extends State<T> with SingleTickerProviderStateMixin<T> {
  // 自动创建 Controller（late final，首次访问时初始化）
  @protected
  late final AnimationController controller = AnimationController(
    duration: widget.duration,
    debugLabel: kDebugMode ? widget.toStringShort() : null,
    vsync: this,
  );

  // 自动创建 CurvedAnimation
  late CurvedAnimation _animation = _createCurve();

  @override
  void initState() {
    super.initState();
    // 监听动画完成 → 回调 onEnd
    controller.addStatusListener((AnimationStatus status) {
      if (status.isCompleted) {
        widget.onEnd?.call();
      }
    });
    _constructTweens(); // 首次构建所有 Tween（begin = 当前属性值）
    didUpdateTweens();  // 子类钩子：更新依赖 Tween 的成员
  }

  @override
  void didUpdateWidget(T oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.curve != oldWidget.curve) {
      _animation.dispose();
      _animation = _createCurve();
    }
    controller.duration = widget.duration;

    // 核心逻辑：_constructTweens 会检测目标值是否变化，
    // 变了才返回 true，然后更新所有 Tween 并从头播放
    if (_constructTweens()) {
      forEachTween((tween, targetValue, constructor) {
        return tween
          ?..begin = tween.evaluate(_animation) // 新 begin = 当前实际值
          ..end = targetValue;                  // 新 end = 新目标值
      });
      controller.forward(from: 0.0);
      didUpdateTweens();
    }
  }

  // 子类重写：声明哪些属性参与动画
  @protected
  void forEachTween(TweenVisitor<dynamic> visitor);

  @override
  void dispose() {
    _animation.dispose();
    controller.dispose();
    super.dispose();
  }
}
```

#### `didUpdateWidget` 的关键逻辑

当 Widget 的属性变化时（比如 `AnimatedContainer` 的 `color` 被改了），`didUpdateWidget` 会：

1. `_constructTweens()` 遍历所有可动画属性，比较目标值与 Tween 的 `end`（首次还会用 `constructor` 创建 Tween）
2. 如果任何一个属性的值变了，用**当前动画实际值**作为 `begin`，新值作为 `end` 更新 Tween
3. 调用 `controller.forward(from: 0.0)` 从头开始播放

`forEachTween` 是一个模板方法，子类用它遍历所有需要动画化的属性：

```dart
// AnimatedContainer 的 State（简化）
@override
void forEachTween(TweenVisitor<dynamic> visitor) {
  // 每个可动画属性都经过 visitor 检查
  _alignment = visitor(_alignment, widget.alignment,
      (dynamic value) => AlignmentGeometryTween(begin: value as AlignmentGeometry));
  _padding = visitor(_padding, widget.padding,
      (dynamic value) => EdgeInsetsGeometryTween(begin: value as EdgeInsetsGeometry));
  _decoration = visitor(_decoration, widget.decoration,
      (dynamic value) => DecorationTween(begin: value as Decoration));
  // ... constraints、margin、transform 等其他属性
}
```

`TweenVisitor` 的定义与框架侧的检查逻辑：

```dart
typedef TweenConstructor<T extends Object> = Tween<T> Function(T targetValue);
typedef TweenVisitor<T extends Object> =
    Tween<T>? Function(Tween<T>? tween, T targetValue, TweenConstructor<T> constructor);

// _constructTweens() 传给 forEachTween 的 visitor（简化）
Tween<dynamic>? visitor(Tween<dynamic>? tween, dynamic targetValue, constructor) {
  if (targetValue != null) {
    tween ??= constructor(targetValue); // 首次：创建 Tween（只有 begin）
    if (targetValue != (tween.end ?? tween.begin)) {
      shouldStartAnimation = true;      // 目标值变了 → 需要播放动画
    }
  }
  return tween;
}
```

#### Tween.begin vs Tween.end 的更新逻辑

隐式动画中 `begin` 的值有特殊处理：

- **首次构建**：`begin` = Widget 的初始属性值（此时 `end` 为 null）
- **属性变化时**：`begin` = `tween.evaluate(_animation)`，即**用当前曲线实时计算出的视觉值**；`end` = Widget 的新属性值

用"当前实际值"而不是"上一次的 end"作为新起点，意味着：即使上一次过渡还没播完就被新的目标值打断，动画也会从画面当前呈现的状态平滑继续，不会跳变。

#### 隐式动画的限制

隐式动画只能做**单向过渡**——从旧值到新值。它不能像显式动画那样自由控制 forward/reverse/repeat。

这是因为隐式动画的 Controller 是内部管理的，每次 `didUpdateWidget` 只会调用 `forward()`，不会 `reverse()`。如果需要反向播放或循环动画，必须使用显式动画。

#### 显式动画 vs 隐式动画对比

| 维度 | 显式动画 | 隐式动画 |
|---|---|---|
| 控制权 | 开发者手动控制 | 框架自动管理 |
| Controller | 开发者创建 | 内部自动创建 |
| 使用方式 | forward/reverse/stop | 改属性值即可 |
| 动画类型 | 任意（循环、反弹等） | 仅 A→B 过渡 |
| 典型 Widget | AnimatedBuilder | AnimatedContainer 等 |
| 代码复杂度 | 较高 | 较低 |
| 适用场景 | 复杂动画编排 | 简单属性过渡 |

## 七、动画系统与渲染管线的协作

### 从 value 变化到画面更新

动画的核心价值就是**驱动 UI 更新**，而这条路径涉及 Widget、Element、RenderObject 三棵树的协作：

```text
AnimationController._tick() 更新 value
    ↓ notifyListeners()
AnimatedWidget._AnimatedState._handleChange()
    ↓ setState()
Element.markNeedsBuild()
    ↓ 加入 dirty 列表
下一帧 buildScope
    ↓ rebuild
Widget.build() → 返回新的 Widget 树
    ↓ Element.update()
RenderObject.update() → 新的布局/绘制参数
    ↓ markNeedsLayout() / markNeedsPaint()
后续的 layout / paint 阶段
    ↓
画面更新
```

### AnimatedBuilder 的 child 参数

`AnimatedBuilder` 接受一个 `child` 参数，它不会随动画变化而重建：

```dart
AnimatedBuilder(
  animation: _controller,
  // child 在外部创建，不会因动画重建
  child: const ExpensiveWidget(),
  builder: (context, child) {
    // 只在这里做动画相关的变化
    return Container(
      width: _sizeAnimation.value,
      // 直接复用传入的 child
      child: child,
    );
  },
)
```

原理：`AnimatedWidget` 的 `build()` 方法每次调用 `builder(context, child)`，`child` 是 `AnimatedBuilder` 自己缓存的外部 Widget。只要 `AnimatedBuilder` 的 `child` 属性没变（来自父 Widget 的同一个对象），就不会被重建。

这在动画频繁触发 rebuild 的场景中可以显著减少开销。

### addStatusListener 在动画完成时清理资源

```dart
_controller.addStatusListener((status) {
  if (status == AnimationStatus.completed) {
    // 动画完成后执行清理
    _cleanup();
  } else if (status == AnimationStatus.dismissed) {
    // 动画回到起点
    _reset();
  }
});
```

`addStatusListener` 在状态变化时触发，适合处理"动画结束后的逻辑"，比如：
- 移除过渡遮罩层
- 回收动画资源
- 触发下一个动画
- 更新业务状态

### RepaintBoundary 与动画的组合

`RepaintBoundary` 可以隔离动画的重绘范围：

```dart
RepaintBoundary(
  child: AnimatedBuilder(
    animation: _controller,
    builder: (context, child) {
      return CustomPaint(
        painter: MyAnimationPainter(_controller.value),
      );
    },
  ),
)
```

当 `RepaintBoundary` 内部的内容因为动画需要重绘时，边界外的区域不受影响。这在有多个独立动画区域时尤其重要。

### AnimatedWidget vs addListener + setState 的性能差异

两种方式都能实现动画，但机制不同：

```dart
// 方式 1：AnimatedBuilder
AnimatedBuilder(
  animation: _controller,
  builder: (context, child) => Container(width: _controller.value * 200),
)

// 方式 2：addListener + setState（效果相同，但手写）
@override
void initState() {
  super.initState();
  _controller.addListener(() {
    setState(() {}); // 每次 tick 都 setState
  });
}
```

两者在性能上基本等价——都是通过 `setState` 触发 rebuild。`AnimatedBuilder` 的优势是代码更简洁、职责更清晰，且天然处理了 listener 的注册和注销。

但如果只需要在 `CustomPainter` 中使用动画值（不涉及 Widget 树重建），可以用更轻量的方式：

```dart
class MyPainter extends CustomPainter {
  final Animation<double> animation;

  MyPainter(this.animation) : super(repaint: animation);
  // repaint 参数直接让 CustomPainter 监听 animation
  // 当 animation.value 变化时，自动触发 repaint
  // 不需要 setState，不触发 Widget rebuild

  @override
  void paint(Canvas canvas, Size size) {
    // 直接使用 animation.value
  }
}
```

这是高性能动画的关键技巧：**动画值只在绘制层消费时，直接用 `CustomPainter` + `repaint` 参数，完全绕过 Widget rebuild**。

## 八、常见动画陷阱与最佳实践

### 陷阱 1：Ticker 未 dispose 导致内存泄漏

```dart
// 错误：State dispose 时没有释放 Controller
class _BadState extends State<Widget>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    _controller = AnimationController(vsync: this, duration: ...);
    _controller.repeat(); // 持续运行
    // 忘记 dispose！
  }
  // Ticker 和 Controller 都在内存中持续运行
}
```

修复：

```dart
@override
void dispose() {
  _controller.dispose(); // 释放 Ticker 和 listener
  super.dispose();
}
```

### 陷阱 2：setState 在动画回调中过度触发重建

```dart
// 反模式：每帧 setState 重建整个页面
_controller.addListener(() {
  setState(() {
    // 整个 State 的 build 都会重新执行
  });
});
```

如果只有一小部分 UI 依赖动画，应该缩小重建范围：

```dart
// 方式 1：用 AnimatedBuilder 局部重建
AnimatedBuilder(
  animation: _controller,
  builder: (context, child) {
    return Container(color: ColorTween(...).evaluate(_controller));
  },
)

// 方式 2：用 CustomPainter 完全避免 rebuild
CustomPaint(
  painter: MyPainter(_controller),
)
```

### 陷阱 3：AnimatedContainer 的性能陷阱

`AnimatedContainer` 在任何属性变化时都会启动动画，这意味着：

```dart
// 每次 rebuild（即使 color 没变）都可能触发比较和可能的动画启动
AnimatedContainer(
  duration: const Duration(milliseconds: 300),
  color: isDark ? Colors.black : Colors.white,
  width: 200,
  height: 200,
  // 其他属性...
  child: VeryExpensiveChildWidget(), // 整个子树每帧都在 build 中被评估
)
```

优化建议：

- 如果只需要动画化 1~2 个属性，考虑用显式动画替代
- 使用 `const` 构造函数标记不变的子 Widget
- 将昂贵的子 Widget 放到不会因动画频繁重建的位置

### 最佳实践 1：ValueNotifier + CustomPainter 实现高性能动画

```dart
class HighPerformanceAnimation extends StatefulWidget {
  const HighPerformanceAnimation({super.key});

  @override
  State<HighPerformanceAnimation> createState() => _HighPerformanceAnimationState();
}

class _HighPerformanceAnimationState extends State<HighPerformanceAnimation>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 5),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // build 只执行一次，后续由 CustomPainter 的 repaint 驱动
    return CustomPaint(
      painter: ParticlePainter(_controller),
      size: Size.infinite,
    );
  }
}

class ParticlePainter extends CustomPainter {
  ParticlePainter(this.animation) : super(repaint: animation);
  final Animation<double> animation;

  @override
  void paint(Canvas canvas, Size size) {
    final t = animation.value;
    // 直接在 Canvas 上绘制，不经过 Widget 树
    final paint = Paint()
      ..color = Color.lerp(Colors.blue, Colors.red, t)!;

    // 绘制粒子...
    for (int i = 0; i < 100; i++) {
      final offset = Offset(
        size.width * (i / 100 + t * 0.1) % size.width,
        size.height * (math.sin(t * math.pi * 2 + i) * 0.5 + 0.5),
      );
      canvas.drawCircle(offset, 3, paint);
    }
  }

  @override
  bool shouldRepaint(covariant ParticlePainter oldDelegate) => false;
}
```

这种方式完全绕过 Widget rebuild，每帧只执行 `paint()`，适合大量粒子和高频更新场景。

### 最佳实践 2：AnimationController 与 ScrollController 联动

```dart
class ScrollLinkedAnimation extends StatefulWidget {
  const ScrollLinkedAnimation({super.key});

  @override
  State<ScrollLinkedAnimation> createState() => _ScrollLinkedAnimationState();
}

class _ScrollLinkedAnimationState extends State<ScrollLinkedAnimation>
    with SingleTickerProviderStateMixin {
  late ScrollController _scrollController;
  late AnimationController _opacityController;

  @override
  void initState() {
    super.initState();
    _scrollController = ScrollController();
    _opacityController = AnimationController(
      vsync: this,
      duration: Duration.zero, // 只做"值容器"用，不会用它驱动时间动画
      value: 1.0,
    );

    _scrollController.addListener(_onScroll);
  }

  void _onScroll() {
    // 根据滚动位置更新动画值
    final offset = _scrollController.offset;
    final maxOffset = _scrollController.position.maxScrollExtent;
    final progress = (offset / maxOffset).clamp(0.0, 1.0);

    // 不需要 Ticker 驱动，直接设置 value
    _opacityController.value = 1.0 - progress;
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _opacityController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacityController,
      child: ListView.builder(
        controller: _scrollController,
        itemCount: 100,
        itemBuilder: (context, index) => ListTile(title: Text('Item $index')),
      ),
    );
  }
}
```

直接设置 `controller.value` 不会激活 Ticker，所以不会请求帧回调——值变化只会通知 listener，由 Flutter 的常规渲染机制处理。这是"用动画系统做状态驱动 UI"的经典模式。

### 最佳实践 3：多个动画的编排

Flutter 提供了多个工具来组合和编排多个动画：

#### Interval 编排时序

```dart
final controller = AnimationController(
  vsync: this,
  duration: const Duration(seconds: 2),
);

// 前 40%：透明度变化
final opacity = CurvedAnimation(
  parent: controller,
  curve: const Interval(0.0, 0.4, curve: Curves.easeOut),
);

// 20%~60%：位移变化
final slide = CurvedAnimation(
  parent: controller,
  curve: const Interval(0.2, 0.6, curve: Curves.easeInOut),
);

// 50%~100%：缩放变化
final scale = CurvedAnimation(
  parent: controller,
  curve: const Interval(0.5, 1.0, curve: Curves.elasticOut),
);
```

#### AnimationMean / AnimationMax / AnimationMin

这三个类都继承自 `CompoundAnimation`，每次**组合两个**动画（要组合更多可以嵌套着用）：

```dart
// 取两个动画的均值（left/right 命名参数）
final combined = AnimationMean(left: _anim1, right: _anim2);

// 取两个动画的最大值（AnimationMin 同理，取最小值）
final maxOpacity = AnimationMax(_fadeInOpacity, _hoverOpacity);

// 组合三个：先合并前两个，再和第三个合并
final meanOfThree = AnimationMean(
  left: AnimationMean(left: _anim1, right: _anim2),
  right: _anim3,
);
```

这些组合类本身也是 `Animation<double>`，可以直接传入 `AnimatedBuilder` 或作为 `CurvedAnimation` 的 parent。

### 完整示例：高性能粒子动画

```dart
class ParticleSystem extends StatefulWidget {
  const ParticleSystem({super.key});

  @override
  State<ParticleSystem> createState() => _ParticleSystemState();
}

class _ParticleSystemState extends State<ParticleSystem>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  final List<Particle> _particles = [];

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 10),
    )..repeat();

    // 初始化粒子
    for (int i = 0; i < 50; i++) {
      _particles.add(Particle(
        x: math.Random().nextDouble(),
        y: math.Random().nextDouble(),
        speed: 0.01 + math.Random().nextDouble() * 0.03,
        size: 2 + math.Random().nextDouble() * 4,
        phase: math.Random().nextDouble() * math.pi * 2,
      ));
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: CustomPaint(
        painter: ParticlePainter(_controller, _particles),
        size: Size.infinite,
      ),
    );
  }
}

class Particle {
  final double x;
  final double y;
  final double speed;
  final double size;
  final double phase;

  Particle({
    required this.x,
    required this.y,
    required this.speed,
    required this.size,
    required this.phase,
  });
}

class ParticlePainter extends CustomPainter {
  ParticlePainter(this.animation, this.particles) : super(repaint: animation);

  final Animation<double> animation;
  final List<Particle> particles;

  @override
  void paint(Canvas canvas, Size size) {
    final t = animation.value;

    for (final particle in particles) {
      // 根据时间和粒子参数计算位置
      final dx = (particle.x + t * particle.speed) % 1.0;
      final dy = particle.y + math.sin(t * math.pi * 2 + particle.phase) * 0.05;

      final paint = Paint()
        ..color = Color.lerp(
          Colors.blue.withOpacity(0.3),
          Colors.purple.withOpacity(0.8),
          math.sin(t * math.pi * 2 + particle.phase) * 0.5 + 0.5,
        )!
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2);

      canvas.drawCircle(
        Offset(dx * size.width, dy * size.height),
        particle.size,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant ParticlePainter oldDelegate) => false;
}
```

这个示例展示了高性能动画的完整模式：

- `AnimationController` + `Ticker` 驱动帧
- `CustomPainter` + `repaint` 绕过 Widget rebuild
- `RepaintBoundary` 隔离重绘范围
- 数学计算驱动粒子运动（正弦函数控制轨迹）

一句话总结：Flutter 动画的本质是 **Ticker 把 VSync 变成时间、AnimationController 把时间变成 0~1 的值、Curve 和 Tween 把值变成你想要的任何东西、AnimatedBuilder/CustomPainter 把这个值画到屏幕上**——理解了这条链路，所有动画 API 都只是它的封装变体。

## 参考

### 官方文档

- [Flutter 动画概览（docs.flutter.dev）](https://docs.flutter.dev/ui/animations/overview)
- [Flutter 动画教程（docs.flutter.dev）](https://docs.flutter.dev/ui/animations/tutorial)
- [AnimationController](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [AnimationStatus](https://api.flutter.dev/flutter/animation/AnimationStatus.html)
- [Ticker](https://api.flutter.dev/flutter/scheduler/Ticker-class.html)
- [TickerFuture](https://api.flutter.dev/flutter/scheduler/TickerFuture-class.html)
- [TickerMode](https://api.flutter.dev/flutter/widgets/TickerMode-class.html)
- [TickerProviderStateMixin](https://api.flutter.dev/flutter/widgets/TickerProviderStateMixin-class.html)
- [SingleTickerProviderStateMixin](https://api.flutter.dev/flutter/widgets/SingleTickerProviderStateMixin-class.html)
- [Tween](https://api.flutter.dev/flutter/animation/Tween-class.html)
- [Curve](https://api.flutter.dev/flutter/animation/Curve-class.html)
- [Curves](https://api.flutter.dev/flutter/animation/Curves-class.html)
- [CurvedAnimation](https://api.flutter.dev/flutter/animation/CurvedAnimation-class.html)
- [Interval](https://api.flutter.dev/flutter/animation/Interval-class.html)
- [AnimatedBuilder](https://api.flutter.dev/flutter/widgets/AnimatedBuilder-class.html)
- [ListenableBuilder](https://api.flutter.dev/flutter/widgets/ListenableBuilder-class.html)
- [ImplicitlyAnimatedWidget](https://api.flutter.dev/flutter/widgets/ImplicitlyAnimatedWidget-class.html)
- [AnimatedContainer](https://api.flutter.dev/flutter/widgets/AnimatedContainer-class.html)
