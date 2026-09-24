# 21 AnimationController：从 _tick 到 value

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/animation/animation_controller.dart`（1061 行）

## 一、问题

`AnimationController` 的公开语义是"一个 0.0 到 1.0 之间随时间变化的 `double`"。那么一个具体问题是：**这个 `double` 是谁算出来的？**

常见错误直觉有两个。一是 **"`value` 就是 `elapsed / duration`"**——这只在默认的线性动画里成立，真实公式是 `value = clamp(simulation.x(elapsed), lowerBound, upperBound)`，一个可插拔的 `Simulation` 决定一切；`animateTo(curve:)` 的曲线不是在外层"修正"比例，而是**直接构成 simulation 的内部定义**（第 22 篇）。二是 **"`controller.isAnimating` 就是 `controller.status.isAnimating`"**——实测 `c.value = 0.5` 之后 `status` 仍是 `forward`（`status.isAnimating` 为 `true`），而 ticker 从未启动（`isAnimating` 为 `false`）。

**关键认知**：`AnimationController` 是**状态机的持有者 + 一个 Simulation 的执行器**。它自己不产生任何数值，只做四件事：把时间喂给 simulation、把结果 clamp 进边界、在 `isDone` 时收尾、把变化广播出去。

## 二、最小 Demo

一个 100ms 的动画，故意让 `Curves.easeIn` 的解析值与 `controller.value` 正面对撞。`TestVSync` 在 `flutter_test` 里，观察 value 变化要有真实的帧推进，所以放进 `testWidgets`：

```dart
import 'package:flutter/animation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('50ms 后 value 等于曲线值', (WidgetTester tester) async {
    final AnimationController c = AnimationController(
      vsync: const TestVSync(),
      duration: const Duration(milliseconds: 100),   // 1. 时长在这里给
    );

    debugPrint('${c.value} ${c.status} ${c.isAnimating}');
    // 2. animateTo 的 curve 直接进 simulation，不是在外部修正
    c.animateTo(1.0, curve: Curves.easeIn);
    debugPrint('${c.value} ${c.status}');            // 3. 还没跑帧，value 仍是 0.0
    // 4. 让时间走 50ms（= 时长的一半）；在 App 里就是等两帧
    await tester.pump();                                    // 第一帧（elapsed = 0）
    await tester.pump(const Duration(milliseconds: 50));    // 第二帧（elapsed = 50ms）
    // 5. 50ms 之后 value 应等于 Curves.easeIn.transform(0.5)
    debugPrint('${c.value} ${Curves.easeIn.transform(0.5)}');
    // 6. 再推进一拍让动画收尾：isDone 用的是 >，正好 100ms 时还差一帧
    await tester.pump(const Duration(milliseconds: 51));
  });
}
```

第六节给出的实测结果是：50ms 后 `value == Curves.easeIn.transform(0.5) == 0.31640625`。**这个等号就是本篇的全部结论**——`controller.value` 是 `simulation.x(elapsed)`，而 `animateTo` 场景下这个 `x` 的定义里嵌着曲线。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `animation_controller.dart:221` | `class AnimationController extends Animation<double>` |
| `animation_controller.dart:245` | 默认构造：`value` / `duration` / `lowerBound` / `upperBound` / `vsync` |
| `animation_controller.dart:253` / `257` | `required TickerProvider vsync` → `_ticker = vsync.createTicker(_tick)` |
| `animation_controller.dart:258` | `_internalSetValue(value ?? lowerBound)`，初值 |
| `animation_controller.dart:337` | `Simulation? _simulation`，**唯一的"值生成器"字段** |
| `animation_controller.dart:372` | `set value`，设值会先 `stop()` |
| `animation_controller.dart:410` | `_internalSetValue`，**由值反推 status** |
| `animation_controller.dart:442` | `isAnimating => _ticker != null && _ticker!.isActive` |
| `animation_controller.dart:640` | `_animateToInternal`，时长折算与 simulation 构造 |
| `animation_controller.dart:777` | `fling`，`SpringSimulation` |
| `animation_controller.dart:861` | `_startSimulation`，把 simulation 装上并启动 ticker |
| `animation_controller.dart:941` | `_tick`，每帧唯一入口 |
| `animation_controller.dart:973` | `class _InterpolationSimulation`（第 22 篇主线） |

## 四、调用链

### 4.1 构造：status 是值的从属变量

```dart
// animation/animation_controller.dart:254-259（节选）
  }) : assert(upperBound >= lowerBound),
       _direction = _AnimationDirection.forward {
    // ...
    _ticker = vsync.createTicker(_tick);
    _internalSetValue(value ?? lowerBound);
  }
```

构造里只有两件事：拿到 ticker、设初值。`status` 不单独初始化，而是由 `_internalSetValue` 反推：

```dart
// animation/animation_controller.dart:410-422
void _internalSetValue(double newValue) {
  _value = clampDouble(newValue, lowerBound, upperBound);
  if (_value == lowerBound) {
    _status = AnimationStatus.dismissed;
  } else if (_value == upperBound) {
    _status = AnimationStatus.completed;
  } else {
    _status = switch (_direction) {          // ← 值在中间时，status 由方向决定
      _AnimationDirection.forward => AnimationStatus.forward,
      _AnimationDirection.reverse => AnimationStatus.reverse,
    };
  }
}
```

**关键认知**：**值在中间 → status 只反映方向，不反映"是否在跑"。** 这就是 4.6 节那个分裂的根源。`_direction` 是一个只在 `forward`/`reverse`/`animateTo`/`animateBack`/`fling`/`toggle` 里被赋值的私有枚举，与"有没有在 tick"完全无关。

### 4.2 `forward` / `reverse` / `animateTo`：时长怎么折算

三个入口最终都汇到 `_animateToInternal`：

```dart
// animation/animation_controller.dart:640-673（节选）
TickerFuture _animateToInternal(double target, {Duration? duration, Curve curve = Curves.linear}) {
  final double scale = switch (animationBehavior) {
    // 框架无法处理零时长动画，所以用 5% 时长把它压到单帧
    AnimationBehavior.normal when SemanticsBinding.instance.disableAnimations => 0.05,
    AnimationBehavior.normal || AnimationBehavior.preserve => 1.0,
  };
  var simulationDuration = duration;
  if (simulationDuration == null) {
    final double range = upperBound - lowerBound;
    final double remainingFraction = range.isFinite ? (target - _value).abs() / range : 1.0;
    final Duration directionDuration =
        (_direction == _AnimationDirection.reverse && reverseDuration != null)
        ? reverseDuration! : this.duration!;
    simulationDuration = directionDuration * remainingFraction;    // ← 按剩余比例折算
  } else if (target == value) {
    simulationDuration = Duration.zero;                            // ← 已经在目标上
  }
  stop();
  if (simulationDuration == Duration.zero) {
    // 直接跳到目标值，不发车（但依然会 notifyListeners + status 切换）
  }
```

三个设计点：

| 代码 | 含义 |
|---|---|
| `remainingFraction = (target - _value).abs() / range` | 从 0.5 动画到 1.0，时长只有一半。**`forward()` 不会因为起点不是 0 而跑满整个 `duration`** |
| `directionDuration` 三元选择 | 反向且有 `reverseDuration` 时用它，否则用 `duration` |
| `scale` 的 0.05 | 无障碍"减少动画"开启时把时长压到 5%，注释写明理由：框架无法处理零时长动画，而"无限重复动画"模式在零时长下会变成死循环 |

`stop()` 在构造 simulation **之前**调用，这保证了 `assert(!isAnimating)` 在 `_startSimulation` 里成立。**`animateTo` 会先取消上一个动画**——包括上一次调用返回的 `TickerFuture`。

`scale` 最终不是乘在时间戳上，而是折进了 simulation 的时长：

```dart
// animation/animation_controller.dart:974-976
  _InterpolationSimulation(this._begin, this._end, Duration duration, this._curve, double scale)
    : assert(duration.inMicroseconds > 0),
      _durationInSeconds = (duration.inMicroseconds * scale) / Duration.microsecondsPerSecond;
```

### 4.3 `_startSimulation`：装弹与发车

```dart
// animation/animation_controller.dart:861-872
TickerFuture _startSimulation(Simulation simulation) {
  assert(!isAnimating);
  _simulation = simulation;
  _lastElapsedDuration = Duration.zero;
  _value = clampDouble(simulation.x(0.0), lowerBound, upperBound);   // ← t=0 的取值
  final TickerFuture result = _ticker!.start();
  _status = (_direction == _AnimationDirection.forward)
      ? AnimationStatus.forward
      : AnimationStatus.reverse;
  _checkStatusChanged();
  return result;
}
```

四件事的先后很讲究：`_simulation = simulation`（之后所有 `value` 都由它算）→ `_value = clamp(simulation.x(0.0))`（**没跑任何帧之前，值已经是新 simulation 在 t=0 的值**；所以从 0.5 起步的 `animateTo` 之后立刻读 `value` 会看到 0.5 而不是 0）→ `_ticker!.start()`（开始排帧，第 19 篇）→ 强设 `status` 并 `_checkStatusChanged`。最后一步意味着 **status 的变化是同步发生的，早于第一帧**：实测里 `animateTo` 之后还没跑帧，`status` 已经是 `forward`。

### 4.4 `_tick`：value 的最终来源

```dart
// animation/animation_controller.dart:941-955
void _tick(Duration elapsed) {
  _lastElapsedDuration = elapsed;
  final double elapsedInSeconds =
      elapsed.inMicroseconds.toDouble() / Duration.microsecondsPerSecond;
  assert(elapsedInSeconds >= 0.0);
  _value = clampDouble(_simulation!.x(elapsedInSeconds), lowerBound, upperBound);   // ← 唯一的值计算
  if (_simulation!.isDone(elapsedInSeconds)) {
    _status = (_direction == _AnimationDirection.forward)
        ? AnimationStatus.completed
        : AnimationStatus.dismissed;
    stop(canceled: false);                    // ← 收尾，future 正常完成
  }
  notifyListeners();
  _checkStatusChanged();
}
```

**这就是"从 _tick 到 value"的完整答案：一行。**

五个步骤中两个容易读漏：

- **`stop(canceled: false)`**：正常结束时 future 要**完成**而不是取消。对比用户主动 `stop()`（默认 `canceled: true`）——那时 future 永不完成。
- **`notifyListeners()` 与 `_checkStatusChanged()` 的顺序**：先通知值监听者，再通知状态监听者。在达到终点的这一帧里，值监听者看到的 `status` 已经是最终值（`completed`/`dismissed`），因为 `_status` 在上面就改了。

`velocity` 走的也是同一个 simulation：

```dart
// animation/animation_controller.dart:401-408
double get velocity {
  if (!isAnimating) {
    return 0.0;
  }
  return _simulation!.dx(
    lastElapsedDuration!.inMicroseconds.toDouble() / Duration.microsecondsPerSecond,
  );
}
```

注意 `_InterpolationSimulation.dx` 是**中心差分**（`animation_controller.dart:994-997`），它算的是"曲线化之后"的变化率，不是 `(end-begin)/duration`。实测中 easeIn 在 t=0.5 处的 `velocity` 是 `10.29`，而线性情况应是 `(1-0)/0.1 = 10.0`——**曲线让瞬时速度偏离了平均速度**。

### 4.5 status 的四个写入点

追踪 `_status` 的所有赋值，会看到它被四类地方改写，这解释了为什么单看 `status` 很难推断动画在做什么：

| 写入点 | 何时 | 写成什么 |
|---|---|---|
| `_internalSetValue`（`:410`） | 构造、`value =`、`reset()` | 两端 → `dismissed`/`completed`；中间 → 按 `_direction` |
| `_startSimulation`（`:867`） | 启动任何 simulation | 按 `_direction` |
| `_tick`（`:948`） | `simulation.isDone` 时 | 按 `_direction` → `completed`/`dismissed` |
| `_directionSetter`（`:747`） | **`_RepeatingSimulation` 每帧回调** | 按传入方向，并立刻 `_checkStatusChanged()` |

最后一行是 `repeat(reverse: true)` 能"来回切换 status"的机制：`_RepeatingSimulation.x()` 内部会根据当前处在第几个周期调用 `directionSetter`（`:1043-1048`），于是**读 `value` 这个动作本身会改写 `status`**。

而 `_checkStatusChanged`（`:933-939`）自己做了去重：它把"上次广播出去的值"存在单独的字段 `_lastReportedStatus`（`:932`）里，只有 `_status` 与它不同才 `notifyStatusListeners`。两个字段必须分开——`_status` 会被反复写成同一个值，而状态监听者只想收到真实的跃迁。

### 4.6 分裂：`isAnimating` vs `status.isAnimating`

```dart
// animation/animation_controller.dart:442
bool get isAnimating => _ticker != null && _ticker!.isActive;
```

`Animation` 基类对这个成员的解释是"默认等于 `status.isAnimating`，但 `AnimationController` 覆写了它"（`animation.dart:246-251`）。覆写的理由是：**`status` 描述"值在路径上的位置和意图方向"，`isAnimating` 描述"ticker 是否在跑"**。

实测里三种组合都出现了：

| 操作 | `value` | `status` | `isAnimating` | `status.isAnimating` |
|---|---|---|---|---|
| 构造完成 | 0.0 | `dismissed` | false | false |
| `animateTo(1.0)` 后（未跑帧） | 0.0 | `forward` | **true** | true |
| 跑完 | 1.0 | `completed` | false | false |
| `c.value = 0.5`（ticker 未启动） | 0.5 | `forward` | false | **true** |

最后一行是关键证据：**ticker 完全没跑，`status` 却报 `forward`**。所以"用 `status.isAnimating` 判断动画是否真的在跑"是错的，必须用 `controller.isAnimating`。

### 4.7 `fling`：默认弹簧其实不是"临界阻尼"

```dart
// animation/animation_controller.dart:40-45
final SpringDescription _kFlingSpringDescription = SpringDescription.withDampingRatio(
  mass: 1.0,
  stiffness: 500.0,
);
const Tolerance _kFlingTolerance = Tolerance(velocity: double.infinity, distance: 0.01);

// animation/animation_controller.dart:782-803（节选）
    springDescription ??= _kFlingSpringDescription;
    _direction = velocity < 0.0 ? _AnimationDirection.reverse : _AnimationDirection.forward;
    final double target = velocity < 0.0
        ? lowerBound - _kFlingTolerance.distance      // ← 目标超出边界一点点
        : upperBound + _kFlingTolerance.distance;
    // ...
    final simulation = SpringSimulation(springDescription, value, target, velocity * scale)
      ..tolerance = _kFlingTolerance;
    assert(
      simulation.type != SpringType.underDamped,     // ← 不允许欠阻尼
      // ...
    );
    stop();
    return _startSimulation(simulation);
```

两个细节：

- **`target` 故意超出边界**（`upperBound + 0.01`）：这样弹簧的"静止点"在边界之外，动画会一直往边界推，靠 `clampDouble` 和 `isDone` 收尾。这让 fling 的末段有"顶着边界"的物理手感。
- **`Tolerance(velocity: double.infinity, distance: 0.01)`**：速度无穷大意味着**只以距离为判据**——只要离目标距离小于 0.01 就算结束。

`fling` 的文档说"By default, a `SpringType.criticallyDamped` spring is used"，但**实测这个默认弹簧的类型是 `overDamped`**（`probe.type=SpringType.overDamped`）。原因是 `SpringDescription.withDampingRatio` 用公式 `damping = ratio * 2 * sqrt(mass * stiffness)` 反推阻尼（`physics/spring_simulation.dart:44`），而类型判定是拿 `damping² - 4·mass·stiffness` 与 0 直接比较（`:291-294`）。浮点误差让 `(2·√500)² - 2000` 等于 `2.27e-13` 而不是 0（实测：stiffness 取 100/1000 时差值为 0.0 判为 `criticallyDamped`，取 300/500 时差值都是该正数判为 `overDamped`）。

**关键认知**：`SpringType` 的判定是**严格数值比较**，没有 epsilon。`ratio: 1.0` 只在浮点恰好算出 0 时才会给出 `criticallyDamped`。这解释了一个常见困惑："我明明用了 damping ratio 1.0，为什么 `simulation.type` 不是 criticallyDamped？"——不是 bug，是浮点。

### 4.8 `repeat`：相位与收尾

`repeat`（`:717-745`）只做参数兜底（`min`/`max` 默认取上下界、`period` 默认取 `duration`），然后 `stop()` 并启动 `_RepeatingSimulation`。它用取模把一个无限长的 `t` 折进周期：

```dart
// animation/animation_controller.dart:1036-1050（节选）
  double x(double timeInSeconds) {
    final double totalTimeInSeconds = timeInSeconds + _initialT;
    final double t = (totalTimeInSeconds / _periodInSeconds) % 1.0;
    final bool isPlayingReverse = (totalTimeInSeconds ~/ _periodInSeconds).isOdd;

    if (reverse && isPlayingReverse) {
      directionSetter(_AnimationDirection.reverse);
      return ui.lerpDouble(max, min, t)!;
    } else {
      directionSetter(_AnimationDirection.forward);
      return ui.lerpDouble(min, max, t)!;
    }
  }
```

`_initialT`（`:1016-1019`）把当前值折算成"周期里已经过了多少"，所以 `repeat()` 会从当前位置平滑接入，而不是跳到 `min`。`isDone` 只在给了 `count` 时才可能为真：

```dart
// animation/animation_controller.dart:1033 / 1056-1060
  late final double _exitTimeInSeconds = (count! * _periodInSeconds) - _initialT;
  // ...
  bool isDone(double timeInSeconds) {
    return count != null && (timeInSeconds >= _exitTimeInSeconds);
  }
```

**这里有一个实测出来的坑**：`t = (totalTime / period) % 1.0` 在**整数周期边界上等于 0.0**，此时返回值是 `min`，而 `_tick` 紧接着发现 `isDone` 为真并写入 `completed`。于是：

| 调用 | 收尾时的 `value` | 收尾时的 `status` |
|---|---|---|
| `repeat(count: 1)` | **0.0** | `completed` |
| `repeat(count: 2)` | **0.0** | `completed` |
| `repeat(count: 3)` | 0.4999…（浮点没正好落在边界） | `completed` |

**关键认知**：`repeat(count: N)` 的收尾值与 `N` 有关，**不一定是最大值**。上面 count 为 1、2 的结果是 0.0（下界）——这与"跑 N 遍之后应该停在终点"的直觉完全相反，原因是"最后一帧刚好落在周期边界"时取模给出 0。count=3 之所以停在中间，是因为 `3 * 0.1` 在 double 下是 `0.30000000000000004`，`isDone(0.3)` 为 false，动画多跑了一帧到 0.35s 才停。

### 4.9 `stop` / `dispose` / `resync`

```dart
// animation/animation_controller.dart:891-900
void stop({bool canceled = true}) {
  // ... assert _ticker != null ...
  _simulation = null;                 // 1. 丢掉值生成器
  _lastElapsedDuration = null;        // 2. velocity 因此返回 0
  _ticker!.stop(canceled: canceled);  // 3. 停 ticker
}
```

`stop` 故意**不发任何通知**——`value` 和 `status` 都保持原样；而 `value = x`（`:372`）内部先 `stop()`，再 `_internalSetValue` + `notifyListeners` + `_checkStatusChanged`。`dispose`（`:909`）额外清空两类监听者。`resync`（`:331`）换 `TickerProvider` 时用 `absorbTicker` 接管旧 ticker 的 `_future` 与 `_startTime`，**保证 `TickerFuture` 身份不变**——正在 `await controller.forward()` 的代码不会因为换 provider 而永久挂起。

## 五、核心对象：三个角色的分工

| | `AnimationController` | `Ticker` | `Simulation` |
|---|---|---|---|
| 知道时间吗 | 只知道"每帧过了多少" | 知道（它就是时间来源） | 不知道（被喂 `t`） |
| 知道值吗 | 知道（`_value`） | 完全不知道 | 知道（`x(t)`） |
| 知道曲线吗 | 不直接知道，除非在 simulation 里 | 不知道 | 知道（`_InterpolationSimulation` 持有 `_curve`） |
| 知道 status 吗 | 知道并广播 | 不知道 | 不知道 |
| 生命周期 | 跟随 `State` | 跟随 controller | 跟随一次动画（`stop` 即丢） |
| 每帧的职责 | clamp + isDone + 广播 | 提供 `elapsed`、排下一帧 | 算出 `x(elapsed)` |

一个容易混的推论：**`muted` 不影响 `isAnimating`**。`TickerMode(enabled: false)` 之下 ticker 仍然 `isActive`，只是不排 tick，所以 `controller.isAnimating` 依然是 true，而 `status` 照常演变。要判断"现在是否真的在出帧"，得看 `Ticker.isTicking`（第 19 篇）。

## 六、源码实验

### 实验 1：`animateTo(curve:)` 之后 50ms 的 value 精确等于曲线值

```dart
final AnimationController c = AnimationController(
  vsync: const TestVSync(), duration: const Duration(milliseconds: 100));
c.animateTo(1.0, curve: Curves.easeIn);
await tester.pump();                                    // 第一帧（elapsed = 0）
await tester.pump(const Duration(milliseconds: 50));    // 第二帧（elapsed = 50ms）
```

**预测**：如果 `value` 是"线性比例"，50ms 时应是 `0.5`；如果曲线在 simulation 里，应是 `Curves.easeIn.transform(0.5)`。

**实际**（实测输出）：

```text
init value=0.0 status=AnimationStatus.dismissed isAnimating=false
after animateTo (no frame yet): value=0.0 status=AnimationStatus.forward isAnimating=true
after first pump (elapsed=0): value=0.0 lastElapsed=0:00:00.000000
after +50ms: value=0.31640625 lastElapsed=0:00:00.050000
      Curves.easeIn.transform(0.5)=0.31640625
      velocity=10.293521918356419
```

**说明**：`0.31640625` 与 `Curves.easeIn.transform(0.5)` **逐位相等**，而线性值应为 `0.5`。这一条实测直接证明了 `animateTo` 的 `curve` 进入了 simulation 内部（第 22 篇展开这段代码），而不是在外层做修正。

另外两行同样重要：`animateTo` 之后 `status` 同步变成 `forward`（不用等帧），以及 `velocity` 是 `10.29` 而非线性的 `10.0`。

### 实验 2：不传 duration 时，时长按剩余比例折算

```dart
c.value = 0.5;                       // 从一半开始
c.animateTo(1.0);                    // duration 用构造时的 100ms
await tester.pump();                 // elapsed = 0
await tester.pump(const Duration(milliseconds: 25));
```

**预测**：`forward()` 应该总是跑满 `duration`（100ms），所以 25ms 时值是 0.625（线性插值 0.5 → 1.0 走了 1/4）。

**实际**（实测输出）：`+25ms` 时 `value=0.75`，`+30ms` 时 `value=1.0, status=completed`。

**说明**：`value = 0.75` 说明 25ms 已经走完了一半路程，也就是**总时长被折算成了 50ms**（100ms × 剩余比例 0.5）。这正是 `_animateToInternal` 里 `remainingFraction` 的效果（`:663`）。**所有 `forward`/`reverse`/`animateTo` 的时长都是"剩余距离所需的时间"，不是固定值。**

### 实验 3：`status` 与 `isAnimating` 的分裂

```dart
c.value = 0.5;
debugPrint('status=${c.status} isAnimating=${c.isAnimating} status.isAnimating=${c.status.isAnimating}');
```

**实际**（实测输出）：

```text
set value=0.5: status=AnimationStatus.forward isAnimating=false status.isAnimating=true
```

**说明**：ticker 从来没启动过（`isAnimating` 为 false），但 `status` 报 `forward`，所以 `status.isAnimating` 是 `true`。原因在 `_internalSetValue`（`:417-420`）——值在中间时 `status` 只按 `_direction` 填写，而 `_direction` 的初值是 `forward`。**判断"动画是否在跑"必须用 `controller.isAnimating`，不能用 `status.isAnimating`。**

### 实验 4：默认 fling 弹簧被判定为 `overDamped`

把 `_kFlingSpringDescription` 的构造参数（`mass: 1.0, stiffness: 500.0`，`ratio` 用默认 1.0）原样喂给 `SpringSimulation`，读 `probe.type`。

**实际**（实测输出 + 单独算浮点差值）：

```text
type=SpringType.overDamped
damping^2 - 4*m*k = 2.2737367544323206e-13   （stiffness=500, ratio=1.0）
```

**说明**：`ratio: 1.0` 在数学上是临界阻尼，但 `damping` 是通过 `ratio * 2.0 * math.sqrt(mass * stiffness)`（`physics/spring_simulation.dart:44`）反算的，而类型判定是 `damping*damping - 4*mass*stiffness` 与 0 直接比较（`:291-294`）。浮点让差值落在 `+2.27e-13`，于是走 `_OverdampedSolution` 分支。**`fling` 的文档（`animation_controller.dart:765`）说默认是 `criticallyDamped`，源码实际给的是 `overDamped`。**

### 实验 5：`repeat(count: N)` 的收尾值不一定是终点

**做法**：对 `count` 取 1、2、3，各自 `repeat(count: count)` 后连续 `pump(50ms)` 八次，记录收尾时的 `value` / `status`。

**实际**（实测输出，节选）：

```text
count=1 +100ms value=0.0 status=AnimationStatus.completed isAnimating=false
count=2 +200ms value=0.0 status=AnimationStatus.completed isAnimating=false
count=3 +300ms value=0.9999999999999996 status=AnimationStatus.forward isAnimating=true
count=3 +350ms value=0.49999999999999956 status=AnimationStatus.completed isAnimating=false
```

**说明**：count 为 1 和 2 时动画停在 `value == 0.0`（下界）却报 `completed`。原因有两层——`x()` 在周期边界上取模得 0 所以返回 `min`（`:1040`），而 `_tick` 紧接着按 `_direction` 把 status 写成 `completed`（`:948`）。count=3 则因为 `3 * 0.1 == 0.30000000000000004` 使 `isDone(0.3)` 为 false，多跑一帧后停在 0.5。**同一个 API 的收尾值取决于 `count` 与浮点，不能假设它停在 `max`。**

## 七、结论

1. `value` 的唯一来源是 `_tick` 里的 `_value = clampDouble(_simulation!.x(elapsedInSeconds), lowerBound, upperBound)`（`animation_controller.dart:946`）。实测 `animateTo(1.0, curve: Curves.easeIn)` 走 50/100ms 时 `value == Curves.easeIn.transform(0.5) == 0.31640625`，证明曲线在 simulation 内部而不是外层修正。`velocity` 是同一个 simulation 的中心差分（`dx`），所以曲线化之后的瞬时速度会偏离线性值。
2. `status` 与 `isAnimating` 是两套独立状态。`status` 在值位于中间时只反映 `_direction`，有四个写入点（`_internalSetValue` / `_startSimulation` / `_tick` / `_directionSetter`）；`isAnimating` 只看 `_ticker.isActive`。实测 `c.value = 0.5` 之后 `status == forward`（`status.isAnimating == true`）而 `isAnimating == false`。
3. 时长不是固定的：`forward`/`reverse`/`animateTo` 都会把 `duration` 乘以剩余比例（实测从 0.5 到 1.0 只需一半时长），无障碍"减少动画"时再乘 0.05。收尾也不总是终点：`repeat(count: N)` 在整数周期边界上停在 `min` 却报告 `completed`，而默认 `fling` 弹簧的类型是 `overDamped` 而非文档所说的 `criticallyDamped`（浮点差值 `+2.27e-13`）。

一句话总结：**`AnimationController` 不产生值，它只是把 `elapsed` 喂给一个 Simulation，再决定什么时候收尾——曲线、弹簧、重复节拍全都藏在那个 Simulation 里。**

## 八、边界声明

- 本篇不展开 `_InterpolationSimulation` 内部的插值公式与 `Curve.transform` 的桥接。这是第 22 篇的全部主题。
- `SpringSimulation` / `FrictionSimulation` / `GravitySimulation` 的数值解法属于第二卷（physics，篇 08–09），本篇只用它们的 `type` 与 `x`/`dx`/`isDone` 三个接口。
- `AnimationBehavior.preserve` 与 `SemanticsBinding.instance.disableAnimations` 的无障碍语义只做原理说明，不展开 `SemanticsBinding` 的实现。
- `resync` / `absorbTicker` / `TickerFuture` / `orCancel` / `TickerCanceled` 只给锚点，语义见第 19 篇。
- 本篇补充 `value` 的确切来源、`status` 的四个写入点、时长折算与 `fling` 类型判定。
