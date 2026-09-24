# 22 Curve 与 Simulation 的桥接：动画曲线如何变成物理仿真

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `animation/animation_controller.dart`（973–1001 行）、`animation/curves.dart`、`animation/tween.dart`、`physics/simulation.dart`

## 一、问题

两个接口看起来毫无关系：

```dart
// animation/curves.dart:26 附近
abstract class ParametricCurve<T> {
  T transform(double t);          // 纯函数：t → 值
}

// physics/simulation.dart:36 附近
abstract class Simulation {
  double x(double time);          // 位置
  double dx(double time);         // 速度
  bool isDone(double time);       // 是否结束
}
```

一个是"把 `t` 映射成值"，一个是"给定时间给出位置/速度"。那么问题就是：**`AnimationController.animateTo(1.0, curve: Curves.easeIn)` 这一行里，`Curves.easeIn` 是怎么跑到 `Simulation` 里去的？**

常见错误直觉是：**"`CurveTween` 是把 `Curve` 送进 `AnimationController` 的通道。"**

源码给出的答案是：**这里根本没有 `CurveTween`。**

```bash
cd packages/flutter/lib/src/animation
grep -c "CurveTween" animation_controller.dart    # → 0
grep -n "Curve" animation_controller.dart | grep -v "///"
```

实际只有四处：`export 'curves.dart' show Curve;`（`:24`）、两个方法的 `Curve curve = Curves.linear` 默认参数（`:582`、`:619`）、`_animateToInternal` 的同名参数（`:643`），以及 simulation 的字段 `final Curve _curve;`（`:981`）。

**关键认知**：Flutter 里有**两条互不相干**的路径，它们只是数值上等价：

| | 路径 A：进 Simulation | 路径 B：纯映射 |
|---|---|---|
| 入口 | `animateTo(curve:)` / `forward` / `reverse` / `animateBack` | `controller.drive(CurveTween(curve: ...))` |
| 中间对象 | **没有** `CurveTween`，`Curve` 被直接塞进 `_InterpolationSimulation` | `CurveTween` → `_AnimatedEvaluation` |
| 曲线在哪被求值 | `_InterpolationSimulation.x(t)` 内部 | `_AnimatedEvaluation.value` 内部 |
| 与时钟的关系 | 每帧被 `_tick(elapsed)` 驱动 | 与时钟无关，只在被读 `.value` 时计算 |
| 结果 | `controller.value` 本身 | 一个新的 `Animation<double>` |
| 走过的接口 | `Simulation.x/dx/isDone` | `Animatable.transform/evaluate` |

`CurveTween` 是**路径 B 的适配器**：它把 `Curve` 这个"不是 `Animatable` 的类"包装成 `Animatable<double>`，好让它能参与 `chain` 和 `drive`。而 `animateTo(curve:)` 走的是路径 A，根本不需要这个适配器——`_InterpolationSimulation` 直接接受一个 `Curve` 参数。

## 二、最小 Demo

同一个 controller，两条路径各算一次，再和曲线本身对撞：

```dart
import 'package:flutter/animation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';   // TestVSync 在 flutter_test 里

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final AnimationController c = AnimationController(
    vsync: const TestVSync(),
    duration: const Duration(milliseconds: 100),
  );

  // 路径 A：curve 进入 controller 内部的 simulation
  c.animateTo(1.0, curve: Curves.easeIn);
  // 路径 B：curve 留在外部，包成一个新的 Animation
  final Animation<double> driven = c.drive(CurveTween(curve: Curves.easeIn));

  // 手动把进度推到 0.5（不需要跑帧）
  c.value = 0.5;

  debugPrint('A: controller.value              = ${c.value}');       // 0.5
  debugPrint('B: drive(CurveTween).value       = ${driven.value}');  // 0.31640625
  debugPrint('C: Curves.easeIn.transform(0.5)  = ${Curves.easeIn.transform(0.5)}');
  debugPrint('D: Curves.easeIn.flipped(0.5)    = ${Curves.easeIn.flipped.transform(0.5)}');
  debugPrint('E: Curves.easeOut(0.5)           = ${Curves.easeOut.transform(0.5)}');
}
```

注意 `c.value = 0.5` 这一行是**手动设值**，它会把当前动画 `stop()` 掉。此时路径 A 的曲线已经失效（`_simulation` 被清空），但路径 B 的 `driven` 依然给出正确的曲线值——因为它只依赖 `parent.value`。

**这正好说明两条路径的本质差别**：路径 A 把曲线"烧"进了一个只会被时间驱动的对象里；路径 B 把曲线留在外面，随时可读。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `animation/curves.dart:40` | `transform`：唯一做端点断言的地方，然后转交 `transformInternal` |
| `animation/curves.dart:75` | `abstract class Curve extends ParametricCurve<double>` |
| `animation/curves.dart:92` | `Curve.transform` 覆写：**钉死 0→0、1→1** |
| `animation/tween.dart:554` | `class CurveTween extends Animatable<double>`（路径 B 的适配器） |
| `animation/tween.dart:562` | `CurveTween.transform`，含端点断言 |
| `animation/animation_controller.dart:582` / `619` | `animateTo` / `animateBack` 的 `Curve curve` 参数 |
| `animation/animation_controller.dart:688` | `_InterpolationSimulation(_value, target, simulationDuration, curve, scale)` |
| `animation/animation_controller.dart:973` | `class _InterpolationSimulation extends Simulation` |
| `animation/animation_controller.dart:984` / `989` | `x(t)`：归一化，`_curve.transform(t)` 参与插值 |
| `animation/animation_controller.dart:946` | controller 每帧唯一的求值点 `_simulation!.x(elapsedInSeconds)` |
| `physics/simulation.dart:36` / `41` / `44` / `47` | `Simulation` / `x` / `dx` / `isDone` |
| `physics/spring_simulation.dart:204` | `class SpringSimulation extends Simulation`，与插值仿真同居一个接口 |
| `physics/gravity_simulation.dart:56` | `class GravitySimulation` |

## 四、调用链

### 4.1 `ParametricCurve`：为什么要分成 `transform` 和 `transformInternal`

```dart
// animation/curves.dart:40-50
T transform(double t) {
  assert(t >= 0.0 && t <= 1.0, 'parametric value $t is outside of [0, 1] range.');
  return transformInternal(t);
}

@protected
T transformInternal(double t) {
  throw UnimplementedError();
}
```

`transform` 是**公开入口 + 校验**，`transformInternal` 是**子类实现**。这个两段式设计的作用是：校验逻辑（区间断言）写一次，所有子类白拿；而子类只需要关心数学本身。文档把这条约定写得很直白（`animation/curves.dart:37-40`）："It is recommended that subclasses override `transformInternal` instead of this function"。

`Curve` 再覆写一次 `transform`，钉死端点：

```dart
// animation/curves.dart:92-97
double transform(double t) {
  if (t == 0.0 || t == 1.0) {
    return t;
  }
  return super.transform(t);
}
```

**关键认知**：`Curve` 的端点契约（0→0、1→1）是**在这里强制**的，不是靠子类自觉。这也是为什么 `Curves.bounceOut.transform(0.0)` 不会因为 `_BounceOutCurve` 的公式而算出别的值。类文档（`animation/curves.dart:64`）把它写成硬性要求："A `Curve` must map t=0.0 to 0.0 and t=1.0 to 1.0."

### 4.2 `Curve.flipped` 与 `Curves.easeOut` 的巧合

```dart
// animation/curves.dart:111
Curve get flipped => FlippedCurve(this);

// animation/curves.dart:1238
double transformInternal(double t) => 1.0 - curve.transform(1.0 - t);
```

`flipped` 不是新曲线，是一个**包装**：`FlippedCurve` 的 `transformInternal` 把 `t` 折回来、把值折回去。

而 `CurveTween` 的适配器实现只有 7 行：

```dart
// animation/tween.dart:561-568
@override
double transform(double t) {
  if (t == 0.0 || t == 1.0) {
    assert(curve.transform(t).round() == t);
    return t;
  }
  return curve.transform(t);
}
```

这里的 `assert(curve.transform(t).round() == t)` 是**对曲线端点契约的运行时检查**：如果你自定义的曲线在 0/1 处返回了 0.3，`CurveTween` 会直接炸（而直接用 `curve:` 参数的路径 A 不会检查这个）。**这是两条路径行为差异的一个真实例子。**

### 4.3 路径 A：`curve` 怎么一路走到 `_InterpolationSimulation`

```dart
// animation/animation_controller.dart:582-600（节选）
TickerFuture animateTo(double target, {Duration? duration, Curve curve = Curves.linear}) {
  // ... assert duration != null / _ticker != null ...
  _direction = _AnimationDirection.forward;
  return _animateToInternal(target, duration: duration, curve: curve);
}
```

`_animateToInternal` 里，`curve` 被原样传给 simulation 的构造：

```dart
// animation/animation_controller.dart:685-690
    assert(simulationDuration > Duration.zero);
    assert(!isAnimating);
    return _startSimulation(
      _InterpolationSimulation(_value, target, simulationDuration, curve, scale),
    );
```

然后 `_startSimulation` 只做三件事（`:861-872`）：把 simulation 存进 `_simulation`、取 `x(0.0)` 作为当前值、启动 ticker。**从这里开始，`curve` 的唯一去处就是 `_InterpolationSimulation._curve`。**

### 4.4 `_InterpolationSimulation`：曲线与物理接口的接缝

```dart
// animation/animation_controller.dart:973-1001
class _InterpolationSimulation extends Simulation {
  _InterpolationSimulation(this._begin, this._end, Duration duration, this._curve, double scale)
    : assert(duration.inMicroseconds > 0),
      _durationInSeconds = (duration.inMicroseconds * scale) / Duration.microsecondsPerSecond;

  final double _durationInSeconds;
  final double _begin;
  final double _end;
  final Curve _curve;

  @override
  double x(double timeInSeconds) {
    final double t = clampDouble(timeInSeconds / _durationInSeconds, 0.0, 1.0);
    return switch (t) {
      0.0 => _begin,
      1.0 => _end,
      _ => _begin + (_end - _begin) * _curve.transform(t),
    };
  }

  @override
  double dx(double timeInSeconds) {
    final double epsilon = tolerance.time;
    return (x(timeInSeconds + epsilon) - x(timeInSeconds - epsilon)) / (2 * epsilon);
  }

  @override
  bool isDone(double timeInSeconds) => timeInSeconds > _durationInSeconds;
}
```

**这 29 行就是本篇要讲的全部内容。** 三件事值得逐个拆开：

| 行 | 做的事 |
|---|---|
| `t = clampDouble(time / _durationInSeconds, 0, 1)` | 把"绝对秒数"归一化成曲线要的 `t`。`clampDouble` 让超出时长的时间也落在 `[0,1]` |
| `_begin + (_end - _begin) * _curve.transform(t)` | **线性插值，但插值参数是曲线化之后的 `t`**。这就是"曲线怎么变成值"的那一行 |
| `0.0 => _begin, 1.0 => _end` | 端点短路：`t` 正好是 0 或 1 时直接返回端点。**这保证了 `value` 不会被曲线的小数误差污染**（例如 `Curves.bounceOut` 在 t=1 附近的值并不精确等于 1） |

`dx` 用**中心差分**（`tolerance.time` 是 `Tolerance` 的时间步长）而不是解析导数——因为 `Curve` 只承诺"给我 `t` 返回值"，没有承诺导数存在。用差分可以在不增加 `Curve` 接口的前提下拿到速度。

`isDone` 用的是 `>` 而**不是** `>=`：

```dart
bool isDone(double timeInSeconds) => timeInSeconds > _durationInSeconds;
```

这一点在第 21 篇的 `repeat(count:)` 实验里能看到实际后果：`elapsed` 正好落在边界时 `isDone` 为 false，动画会多跑一帧。

### 4.5 为什么这算"接缝"：三种 Simulation 共用一个接口

`_InterpolationSimulation` 不是特例。`physics` 层的四个 simulation 实现的是**完全相同的接口**：

| Simulation | `x(t)` 是什么 | `dx(t)` 是什么 | `isDone(t)` 判据 |
|---|---|---|---|
| `_InterpolationSimulation`（`animation_controller.dart:973`） | `begin + (end-begin)·curve(t/duration)` | 中心差分 | `t > duration` |
| `_RepeatingSimulation`（`animation_controller.dart:1005`） | `lerp(min, max, t % 1)` | `(max-min)/period` | `count != null && t >= exitTime` |
| `SpringSimulation`（`spring_simulation.dart:204`） | 弹簧解析解（临界/过/欠阻尼三选一） | 解析解的导数 | 容差判定 |
| `FrictionSimulation`（`friction_simulation.dart:35`） | 指数衰减 | 指数衰减的导数 | 容差判定 |
| `GravitySimulation`（`gravity_simulation.dart:56`） | `x₀ + v₀t + ½at²` | `v₀ + at` | `|x(t)| >= end` |

`AnimationController` 对它们**一视同仁**：

```dart
// animation/animation_controller.dart:946-947（_tick 里）
    _value = clampDouble(_simulation!.x(elapsedInSeconds), lowerBound, upperBound);
    if (_simulation!.isDone(elapsedInSeconds)) {
```

**关键认知**：这就是 animation 与 physics 两层之间唯一真实的接缝——不是"曲线被转换成物理参数"，而是**"曲线被包装成一个实现了 `x`/`dx`/`isDone` 的对象，从而和弹簧、摩擦、重力挤进同一个插槽"**。`AnimationController` 从头到尾不知道它驱动的是曲线还是弹簧。

### 4.6 一个必须澄清的点：这不是"数值积分"

`AnimationController._tick` 收到的是 **Ticker 传来的累积 `elapsed`**（第 19 篇），然后调用 `_simulation!.x(elapsedInSeconds)`——**每帧都用"从起点算起的总时长"重新求一次闭式解，而不是把上一帧的值加上增量**。

```text
第 1 帧：value = x(0.016)
第 2 帧：value = x(0.032)      ← 不是 x(0.016) + Δ
第 3 帧：value = x(0.048)
...
第 60 帧：value = x(1.000)     ← 无论中间掉了多少帧
```

这个性质带来两个后果：

1. **帧率无关**：掉帧不会让动画"变慢"或累积误差，只会让轨迹采样变稀。第 3 帧用 `x(0.048)` 而不是"上一帧值 + 增量"，所以从第 1 帧直接跳到第 3 帧得到的结果和逐帧走完全一致。
2. **它是有代价的**：曲线求值每帧都要重做一次。`Cubic.transformInternal`（`animation/curves.dart:403`）是一个最多 10 次迭代的二分查找，每帧都要跑；`dx` 是中心差分，等于一帧内求两次 `x`。

`Simulation` 的文档把这件事说得很中性（`physics/simulation.dart:23-31`）：

> In principle, simulations can be stateless, and thus can be queried with arbitrary times. In practice, however, some simulations are not, and calling any of these functions will advance the simulation to the given time. As a general rule, therefore, a simulation should only be queried using times that are equal to or greater than all times previously used for that simulation.

**"有些 simulation 不是无状态的，查询会推进它自身"**——这句话是给 `Simulation` 这个接口的契约留的余地，也说明了为什么 `AnimationController` 必须**单调递增**地喂时间（`_tick` 里的 `assert(elapsedInSeconds >= 0.0)`，`animation_controller.dart:945`）。**这层接口是"闭式求解"与"状态推进"两种实现的共同超集，`_InterpolationSimulation` 只是选了前者。**

## 五、核心对象：四方职责对比

| | `Curve` | `CurveTween` | `_InterpolationSimulation` | `Simulation`（抽象） |
|---|---|---|---|---|
| 声明位置 | `animation/curves.dart:75` | `tween.dart:554` | `animation_controller.dart:973` | `physics/simulation.dart:36` |
| 所在层 | animation | animation | animation | **physics** |
| 父类 | `ParametricCurve<double>` | `Animatable<double>` | `Simulation` | 无 |
| 核心方法 | `transform(double)` | `transform(double)` | `x(t)` / `dx(t)` / `isDone(t)` | 同左 |
| 知道时间吗 | 不知道（只有 `t`） | 不知道 | 知道（有 `_durationInSeconds`） | 不知道（被喂 `t`） |
| 有状态吗 | 否（不可变、`@immutable`） | 否 | 否（全 `final`） | 不承诺 |
| 能独立使用吗 | 能（纯函数） | 只能通过 `animate`/`drive`/`chain` | 不能（私有类） | — |
| 参与 `_tick` | 否 | **否** | 是 | 是（被 controller 调用） |

再把两条路径并排：

| | 路径 A（`animateTo(curve:)`） | 路径 B（`drive(CurveTween(...))`） |
|---|---|---|
| `Curve` 参数类型 | `Curve`（`animation_controller.dart:582`） | `CurveTween` 内部的 `Curve` |
| 需要 `CurveTween` | **不需要**（`grep -c` 结果为 0） | 必须 |
| 曲线求值点 | `_InterpolationSimulation.x`（`:989`） | `_AnimatedEvaluation.value` → `CurveTween.transform` |
| 端点检查 | 无 | `assert(curve.transform(t).round() == t)`（`tween.dart:564`） |
| 结果落在哪 | `controller.value` 本身 | 一个新的 `Animation<double>` |
| 能否与别的 `Animatable` 复合 | 不能（只能一条曲线） | 能（`chain`，见 `sliding_segmented_control.dart:1427` 的 `Interval` 用法） |
| 手动设 `value` 之后 | 曲线失效（simulation 被 `stop()` 清空） | 依然有效（只依赖 parent） |
| 框架内使用量 | 只有 `animateTo`/`animateBack` 的两个默认参数 | `grep -rn "CurveTween(" packages/flutter/lib/src` 共 86 处 |

最后一行说明了为什么很多人会误以为 `CurveTween` 是"给 controller 用的"——**它在 widgets 层的使用次数远多于 `animateTo(curve:)`**，但那是路径 B（`AnimatedBuilder`、隐式动画、`Transition` 系列的惯用手法），跟 controller 内部的时钟没有任何关系。

## 六、源码实验

### 实验 1：路径 A 的曲线确实进了 simulation，且数值等于曲线值

```dart
final c = AnimationController(vsync: const TestVSync(), duration: const Duration(milliseconds: 100));
c.animateTo(1.0, curve: Curves.easeIn);
await tester.pump();                                  // elapsed = 0
await tester.pump(const Duration(milliseconds: 50));  // elapsed = 50ms → t = 0.5
debugPrint('value=${c.value}  curve(0.5)=${Curves.easeIn.transform(0.5)}');
```

**预测**：如果曲线在 simulation 内部，两者应完全相等；如果是线性动画，`value` 应是 `0.5`。

**实际**（实测输出）：

```text
after +50ms: value=0.31640625 lastElapsed=0:00:00.050000
      Curves.easeIn.transform(0.5)=0.31640625
```

**说明**：`0.31640625` 逐位相等。`_InterpolationSimulation` 的公式 `_begin + (_end - _begin) * _curve.transform(t)`（`:989`）里 `_begin=0`、`_end=1`，于是 `value == curve.transform(0.5)`。**这就是"曲线变成仿真"的确切位置。**

### 实验 2：`CurveTween` 没有出现在 `animation_controller.dart` 里

```bash
cd packages/flutter/lib/src/animation
grep -c "CurveTween" animation_controller.dart              # → 0
grep -n "Curve" animation_controller.dart | grep -v "///"
```

**实际**：

```text
24:export 'curves.dart' show Curve;
582:  TickerFuture animateTo(double target, {Duration? duration, Curve curve = Curves.linear}) {
619:  TickerFuture animateBack(double target, {Duration? duration, Curve curve = Curves.linear}) {
643:    Curve curve = Curves.linear,
981:  final Curve _curve;
```

**说明**：控制器的代码里只有 `Curve` 这个类型，没有 `CurveTween`。`CurveTween` 是**给"想在 controller 外面造一个新 Animation"的人用的**适配器。把这两者混为一谈，是理解动画分层时最常见的一个偏差。

### 实验 3：两条路径数值相同

```dart
c.value = 0.5;
final Animation<double> driven = c.drive(CurveTween(curve: Curves.easeIn));
debugPrint('${driven.value} ${Curves.easeIn.transform(c.value)}');
```

**实际**（实测输出）：

```text
0.31640625 0.31640625
```

**说明**：数值相同，但机制不同。注意这里 `c` 已经被手动设值（`stop()` 被调用，`_simulation` 为 null），`driven` 依然工作——因为路径 B 的实现是 `_evaluatable.evaluate(parent)` → `CurveTween.transform(parent.value)`（`tween.dart:71`），它只读 `parent.value`，不碰任何 simulation。

### 实验 4：`Curves.easeOut` 就是 `Curves.easeIn.flipped` 的数值镜像

```dart
debugPrint('${Curves.easeIn.transform(0.5)} ${Curves.easeIn.flipped.transform(0.5)} ${Curves.easeOut.transform(0.5)}');
```

**实际**（实测输出）：

```text
0.31640625 0.68359375 0.68359375
```

**说明**：`flipped(0.5) == easeOut(0.5)` 不是巧合，可以在常数表里对上：

```dart
// animation/curves.dart:1520
static const Cubic easeIn  = Cubic(0.42, 0.0, 1.0, 1.0);
// animation/curves.dart:1623
static const Cubic easeOut = Cubic(0.0, 0.0, 0.58, 1.0);
```

`FlippedCurve` 的公式是 `1 - curve.transform(1 - t)`（`animation/curves.dart:1238`），对应到三次贝塞尔控制点的镜像变换是 `Cubic(a,b,c,d) → Cubic(1-c, 1-d, 1-a, 1-b)`。代入 `easeIn` 得 `(1-1.0, 1-1.0, 1-0.42, 1-0.0) = (0.0, 0.0, 0.58, 1.0)`，**与 `easeOut` 的常数逐位相同**。所以 `Curves.easeOut` 就是 `Curves.easeIn.flipped`（实测 `flipped` 的 `runtimeType` 是 `FlippedCurve`，`toString` 会显示它是包装而非 `Cubic`）。

`Curves.linear` 也可以顺手验证：`transform(0.0)=0.0`、`transform(1.0)=1.0`、`transform(0.5)=0.5`（`_Linear.transformInternal` 就是 `return t;`，`animation/curves.dart:121`）。

### 实验 5：`_InterpolationSimulation` 与 `SpringSimulation` 的接口完全一致

```bash
grep -n "double x(double time\|double dx(double time\|bool isDone(double time" \
  packages/flutter/lib/src/physics/*.dart packages/flutter/lib/src/animation/animation_controller.dart
```

（注意模式末尾不闭合括号，这样 `x(double timeInSeconds)` 也能命中。）

**预测**：曲线仿真可能是"特殊的一个"，接口与物理仿真不同。

**实际**：`simulation.dart:41/44/47` 定义接口；`clamped_simulation.dart:59/62/65`、`gravity_simulation.dart:84/87/90`、`spring_simulation.dart:241/250/259`、`friction_simulation.dart:118/129/158` 与同文件的 `BoundedFrictionSimulation`（`:187`/`:192`），以及 `animation_controller.dart:984/994/1000`（插值）与 `1036/1053/1056`（重复）—— **每一个都是同一组三个签名**。

**说明**：`ClampedSimulation` 这类"装饰器仿真"的存在进一步说明这个接口是可组合的。`AnimationController` 只认识这三个方法名，因此"曲线动画"和"弹簧动画"在它眼里没有区别——**这就是接缝的位置，也是它唯一需要的位置。**

### 实验 6：`CurveTween` 的端点断言会拦住不合规的曲线

`CurveTween.transform`（`animation/tween.dart:562-568`）在 `t` 为 0/1 时执行 `assert(curve.transform(t).round() == t)`。实测 `Curves.bounceOut.transform(0.0)` 返回 0.0，断言通过——因为 `Curve.transform`（`animation/curves.dart:92-94`）在端点上直接短路返回 `t`，让绝大多数曲线"自动合规"。**断言真正拦的是绕过 `transform` 直接重写它的子类**（`Split` 就自己重写了 `transform`，见 `:238`）。这也解释了为什么 `Curve` 的端点契约写得那么强硬——它是 `CurveTween` 这个适配器的前置条件。

## 七、结论

1. `Curve` 进入 `AnimationController` 的路径是 `animateTo(curve:)` → `_animateToInternal` → `_InterpolationSimulation(_curve: curve)`，**全程没有 `CurveTween`**（`grep -c "CurveTween" animation_controller.dart` 为 0）。曲线在 `x(t)` 里被调用（`animation_controller.dart:989`），实测 `animateTo(1.0, curve: Curves.easeIn)` 走 50/100ms 时 `controller.value == Curves.easeIn.transform(0.5) == 0.31640625`。
2. `CurveTween` 服务的是另一条路径：把 `Curve` 适配成 `Animatable<double>`，从而能 `chain` 到 `Tween` 上、能被 `drive` 成一个新的 `Animation`。它只在读 `.value` 时求值，与时钟和 simulation 都无关；框架里有 86 处使用，全在 widgets/cupertino 的派生动画里。
3. 两个层的真实接缝是 `Simulation` 的三个方法（`x`/`dx`/`isDone`）。`_InterpolationSimulation` 与 `SpringSimulation`、`FrictionSimulation`、`GravitySimulation`、`ClampedSimulation` 实现同一组签名，`AnimationController._tick` 对它们一视同仁。**这不是"曲线被翻译成物理参数"，而是"曲线被包装成物理仿真的形状"**。另外要澄清：这里没有数值积分——`_tick` 每帧用累积的 `elapsed` 重新求闭式解，所以掉帧不累积误差。

一句话总结：**曲线不是被"转换"成仿真的，是被 `_InterpolationSimulation` 包成了仿真的形状——`x(t)` 里那一行 `_curve.transform(t)` 就是两层的接缝。**

## 八、边界声明

- 本篇不展开 `Cubic.transformInternal` 的二分求值细节、`ThreePointCubic` 的两段拼接、`CatmullRomSpline`/`Curve2D` 的采样算法。需要时读 `animation/curves.dart:403-414`（`Cubic`）与 `:706-922`（`CatmullRomSpline`）。
- `SpringSimulation` 的三种阻尼解析解（`_CriticalSolution` / `_OverdampedSolution` / `_UnderdampedSolution`）属于第二卷（physics，篇 08–09），本篇只用它们的接口。
- `Tolerance` 的 `time` 步长对中心差分精度的影响不展开，见 `physics/tolerance.dart`。
- `_RepeatingSimulation` 的相位折算只在第 21 篇讲过结论，本篇只列接口对比。
- `Curve2D` 与 `Curve2DSample` 是二维曲线族，不参与 `AnimationController` 的驱动（它们不实现 `Simulation`），本系列不展开。
- `CurvedAnimation` 的 `reverseCurve`（正反不同曲线）见第 20 篇；它属于路径 B 的变体，同样不进 simulation。
