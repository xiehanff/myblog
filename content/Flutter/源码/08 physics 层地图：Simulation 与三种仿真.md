# 08 physics 层地图：Simulation 与三种仿真

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/physics`

## 一、问题

`physics` 层只有 893 行、7 个文件，是分层地图里最小的一层。打开目录的第一眼会觉得它没什么可读的——都是些高中物理公式。

但它承担了一件别处替代不了的事：**把一个"速度、位移、时间"的连续物理过程，变成一个每次传时间戳就能求值的纯函数**。上层动画系统一帧调用一次 `x(elapsed)`，就能得到当前位置。

于是本节的问题是：**这 7 个文件里，哪些是"接口"，哪些是"实现"，哪些只是数值工具？**

错误直觉是"`physics` 就是弹簧和摩擦力"。实际上弹簧、摩擦、重力只是**三个示范实现**；这一层真正定下来的是 `Simulation` 这个三方法接口，以及"仿真是有状态的、只能单调向前查询"这条使用约束（`simulation.dart:23-31`）。

## 二、最小 Demo

`physics` 层只用得上 `package:flutter/physics.dart`，不需要任何 Widget：

```dart
import 'package:flutter/physics.dart';

void main() {
  // 1. 三种仿真：各自描述一种受力模型
  final Simulation friction = FrictionSimulation(0.135, 0.0, 5000.0);
  final Simulation spring = SpringSimulation(
    const SpringDescription(mass: 1.0, stiffness: 300.0, damping: 15.0),
    0.0, // 起点
    300.0, // 终点
    0.0, // 初速度
  );
  final Simulation gravity = GravitySimulation(
    9.8, // 加速度
    0.0, // 起点
    400.0, // 到 400 就算结束
    0.0, // 初速度
  );

  // 2. 统一接口：传秒数，拿位移和速度
  for (final (String name, Simulation s) in <(String, Simulation)>[
    ('friction', friction),
    ('spring', spring),
    ('gravity', gravity),
  ]) {
    final StringBuffer line = StringBuffer();
    for (final double t in <double>[0.0, 0.1, 0.2, 0.5]) {
      line.write('x($t)=${s.x(t).toStringAsFixed(1)} ');
    }
    debugPrint('$name: $line done(0.5)=${s.isDone(0.5)}');
  }

  // 3. 数值工具：只有两个函数，判断"够不够近"
  debugPrint('${nearZero(0.0005, 0.001)} ${nearEqual(1.0, 1.0005, 0.001)}'); // true true
}
```

`debugPrint` 需要 `package:flutter/foundation.dart`，两个 import 都加即可。

这段代码说明：`physics` 的公开面就是 **1 个接口（`Simulation`）+ 5 个实现 + 2 个工具函数**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `physics.dart:11-17` | 整个层的对外面，7 行 export 对应 7 个文件（无遗漏、无私有文件） |
| `simulation.dart:36` | `abstract class Simulation`，本层唯一的接口 |
| `simulation.dart:23-31` | "仿真原则上无状态、实践中可能有状态"的完整说明（本文最重要的一段文档） |
| `tolerance.dart:9` / `:23` | `Tolerance` 与 `defaultTolerance` |
| `utils.dart:10` / `:21` | `nearEqual` / `nearZero`，整个文件只有 21 行 |
| `friction_simulation.dart:35` / `:172` | `FrictionSimulation` 与有界子类 `BoundedFrictionSimulation` |
| `spring_simulation.dart:204` / `:271` | `SpringSimulation` 与滚动专用的 `ScrollSpringSimulation` |
| `spring_simulation.dart:291-295` | 用 `damping² - 4mk` 的正负号分派三种解 |
| `physics/clamped_simulation.dart:28` | `ClampedSimulation`，装饰器：给别的仿真加边界 |
| `animation/animation_controller.dart:827` | `animateWith(Simulation)`，本层唯一的驱动入口 |

## 四、调用链

### 4.1 它依赖谁：一层都不依赖

```bash
cd packages/flutter/lib/src
grep -rn "^import" physics/*.dart
```

实际输出里只有两种 import：`package:flutter/foundation.dart`（7 个文件全有）和文件之间的相互引用。**没有 `dart:ui`，没有 `dart:async`，只有一个 `dart:math`**（`friction_simulation.dart:5`、`spring_simulation.dart:8`）。

`physics` 比 `painting`、`gestures`、`services` 都更"低"，因为它是**纯数学**。它不知道像素、不知道时间戳、不知道 Canvas。单位是什么由调用方约定（`simulation.dart:33-35` 明确写了 "Simulations do not specify units"）。

这也是为什么 `physics.dart` 只有 17 行、7 个 export，而且文件与 export 一一对应——没有条件导入、没有平台分叉、没有下划线私有文件。

### 4.2 接口：三个方法，一条约束

整个层的契约只有三个方法：

```dart
// simulation.dart:36-47
abstract class Simulation {
  Simulation({this.tolerance = Tolerance.defaultTolerance});

  double x(double time);      // 位置
  double dx(double time);     // 速度
  bool isDone(double time);   // 是否结束
}
```

`x` / `dx` 这个命名不是缩写习惯问题：`dx` 是数学上的 `dx/dt`，即速度。同一命名习惯贯穿整个 SDK。

真正重要的是构造函数上面那一段文档（`simulation.dart:23-31`），它是本层的使用约束：

> In principle, simulations can be stateless, and thus can be queried with arbitrary times. In practice, however, some simulations are not, and calling any of these functions will advance the simulation to the given time. As a general rule, therefore, a simulation should only be queried using times that are equal to or greater than all times previously used for that simulation.

翻译过来：**接口看起来是纯函数（`x` 只依赖 `time`），但实现可以是"查一次就往前走一步"的有状态对象，所以只能单调向前查询**。

`Simulation` 是"看起来无状态、实际可能有序"的接口。凡是见到把它当成可反复从 0 重放的纯函数来用的代码，都要回头确认它的实现是否有状态。本层的 `BouncingScrollSimulation`（在 `widgets/scroll_simulation.dart`）就是有状态的——它的 `_simulation(time)` 内部会改写 `_timeOffset`（`scroll_simulation.dart:107-117`）。

### 4.3 `Tolerance`：什么时候算"停"

`isDone` 不能靠 `== 0` 判断。渐近曲线（`FrictionSimulation`、`SpringSimulation`）理论上永远不到终点，所以需要"看起来停了就算停"：

```dart
// tolerance.dart:9-23
class Tolerance {
  const Tolerance({
    this.distance = _epsilonDefault,   // 1e-3
    this.time = _epsilonDefault,
    this.velocity = _epsilonDefault,
  });
  static const double _epsilonDefault = 1e-3;
  static const Tolerance defaultTolerance = Tolerance();
}
```

默认三个方向都是 ±0.001。真正有意思的是**上层会按设备像素比重算它**：

```dart
// widgets/scroll_physics.dart:439-445
Tolerance toleranceFor(ScrollMetrics metrics) {
  return parent?.toleranceFor(metrics) ??
      Tolerance(
        velocity: 1.0 / (0.050 * metrics.devicePixelRatio), // logical pixels per second
        distance: 1.0 / metrics.devicePixelRatio, // logical pixels
      );
}
```

`distance = 1/dpr` 的含义是：**物理上 1 个物理像素**。高 dpr 屏上这个值更小，滚动会停得更精确。而 `time` 保持默认的 1e-3 没被覆盖。

### 4.4 `nearEqual` / `nearZero`：本层的全部分值工具

`utils.dart` 整个文件只有 21 行，两个函数：

```dart
// utils.dart:10-16
bool nearEqual(double? a, double? b, double epsilon) {
  assert(epsilon >= 0.0);
  if (a == null || b == null) {
    return a == b;      // null 只与 null 近等
  }
  return (a > (b - epsilon)) && (a < (b + epsilon)) || a == b;
}
```

两个细节：`epsilon` 是**开区间**（差值正好等于 `epsilon` 时不算近等，靠 `|| a == b` 兜住边界）；**null 不是 0**，`nearEqual(null, 0.0, 0.001)` 返回 `false`。`nearZero(a, eps)` 就是 `nearEqual(a, 0.0, eps)`。

### 4.5 三种仿真：受力模型不同，接口相同

| 实现 | 物理模型 | `x(time)` | `isDone` 条件 |
|---|---|---|---|
| `GravitySimulation` | 匀加速（牛二） | `x₀ + v₀t + ½at²` | 位置绝对值超过阈值 |
| `FrictionSimulation` | 流体阻力 `v = v₀·D^t` | `x₀ + v₀·D^t/lnD - v₀/lnD - (c/2)t²` | 速度小于 `tolerance.velocity` |
| `SpringSimulation` | 胡克定律 + 阻尼 | 由三种解分派 | 位移与速度同时近零 |
| `ClampedSimulation` | 无（装饰器） | `clamp(内层.x(time), xMin, xMax)` | **直接转发内层的 `isDone`** |

`GravitySimulation` 的公式在源码里就是一行（`gravity_simulation.dart:84`）：

```dart
@override
double x(double time) => _x + _v * time + 0.5 * _a * time * time;
```

`FrictionSimulation` 复杂得多，因为它的模型是**指数衰减速度**，位移要积分：

```dart
// friction_simulation.dart:117-126
@override
double x(double time) {
  if (time > _finalTime) {
    return finalX;    // 超过终止时间后冻结在终点
  }
  return _x +
      _v * math.pow(_drag, time) / _dragLog -
      _v / _dragLog -
      ((_constantDeceleration / 2) * time * time);
}
```

`_finalTime` 是构造时用牛顿法求出来的（`friction_simulation.dart:51-57`）：解 `dx(t) = 0`，即"速度降到零的时刻"。这个字段只在 `constantDeceleration != 0` 时有意义；注释（`:93-96`）说明纯摩擦模型的加速度天然衰减到零，本来就有停机点。

`_newtonsMethod` 本身极短：

```dart
// friction_simulation.dart:15-27
double _newtonsMethod({
  required double initialGuess,
  required double target,
  required double Function(double) f,
  required double Function(double) df,
  required int iterations,
}) {
  var guess = initialGuess;
  for (var i = 0; i < iterations; i++) {
    guess = guess - (f(guess) - target) / df(guess);
  }
  return guess;
}
```

固定迭代 10 次，**不做收敛判断**。`timeAtX`（`:147`）也用它，用来求"到达某个位置需要多久"——这是弹簧接力的关键：`BouncingScrollSimulation` 用它算摩擦段什么时候到边界（`scroll_simulation.dart:60`）。

### 4.6 弹簧：一个构造函数里藏着三个类

`SpringSimulation` 的构造函数只做一件事：

```dart
// spring_simulation.dart:219-228
SpringSimulation(
  SpringDescription spring,
  double start,
  double end,
  double velocity, {
  bool snapToEnd = false,
  super.tolerance,
}) : _endPosition = end,
     _solution = _SpringSolution(spring, start - end, velocity),
     _snapToEnd = snapToEnd;
```

注意传进去的初始位移是 `start - end` 而不是 `start`——**弹簧的坐标系原点在终点**。所以 `x(time)` 要加回终点：

```dart
// spring_simulation.dart:241-247
double x(double time) {
  if (_snapToEnd && isDone(time)) {
    return _endPosition;
  } else {
    return _endPosition + _solution.x(time);
  }
}
```

`_SpringSolution` 是个工厂（`:285-296`），按判别式的符号选实现：

```dart
return switch (spring.damping * spring.damping - 4 * spring.mass * spring.stiffness) {
  > 0.0 => _OverdampedSolution(spring, initialPosition, initialVelocity),
  < 0.0 => _UnderdampedSolution(spring, initialPosition, initialVelocity),
  _ => _CriticalSolution(spring, initialPosition, initialVelocity),
};
```

三个私有类就是二阶常系数线性齐次方程的三个解分支：

| 类 | 判别式 | 解的形式 | `SpringType` |
|---|---|---|---|
| `_CriticalSolution`（`:303`） | `= 0` | `(c₁ + c₂t)·e^{rt}` | `criticallyDamped` |
| `_OverdampedSolution`（`:330`） | `> 0` | `c₁e^{r₁t} + c₂e^{r₂t}` | `overDamped` |
| `_UnderdampedSolution`（`:362`） | `< 0` | `e^{rt}(c₁cos ωt + c₂sin ωt)` | `underDamped` |

`SpringDescription` 还提供两个更直观的入口：`withDampingRatio({mass, stiffness, ratio = 1.0})`（`:40`，`damping = ratio * 2 * sqrt(mass*stiffness)`）和 `withDurationAndBounce({duration = 500ms, bounce = 0.0})`（`:70`，从"视觉时长 + 弹跳感"反推物理参数）。

`isDone` 是位移和速度都要近零（`:259-262`）：

```dart
bool isDone(double time) {
  return nearZero(_solution.x(time), tolerance.distance) &&
      nearZero(_solution.dx(time), tolerance.velocity);
}
```

注意这里是**与**，不是或。欠阻尼弹簧每次过零点时速度最大，所以不会被误判为结束。

### 4.7 谁在用它

本层的直接消费者一共 13 个文件、15 处 import/export：

```bash
cd packages/flutter/lib/src
grep -rn "package:flutter/physics.dart" --include="*.dart" .
```

按用途分类：

| 用途 | 文件 | 引用的是什么 |
|---|---|---|
| **驱动仿真** | `animation/animation_controller.dart:12` | `Simulation`（`animateWith` 的参数） |
| **取容差** | `widgets/scrollable.dart:46`、`widgets/scrollable_helpers.dart:27` | `Tolerance`（只 export） |
| **造滚动仿真** | `widgets/scroll_physics.dart:21`、`widgets/scroll_position.dart:20`、`widgets/scroll_position_with_single_context.dart:15`、`widgets/scroll_simulation.dart:11` | `Simulation` / `SpringDescription` / `ScrollSpringSimulation` |
| **弹簧动效** | `cupertino/menu_anchor.dart:14`、`cupertino/route.dart:23`、`cupertino/sliding_segmented_control.dart:14`、`widgets/overscroll_indicator.dart:17` | `SpringDescription` + `SpringSimulation` |
| **摩擦/惯性** | `widgets/interactive_viewer.dart:14`、`widgets/list_wheel_scroll_view.dart:15` | `FrictionSimulation` 等 |

`animation/curves.dart` **不在这个名单里**——它和 `physics` 没有任何关系（见第八节）。

`animation_controller.dart` 是唯一的**驱动入口**：

```dart
// animation/animation_controller.dart:861-866
TickerFuture _startSimulation(Simulation simulation) {
  assert(!isAnimating);
  _simulation = simulation;
  _lastElapsedDuration = Duration.zero;
  _value = clampDouble(simulation.x(0.0), lowerBound, upperBound);
  final TickerFuture result = _ticker!.start();
  ...
}
```

以及每帧的 `_tick`：

```dart
// animation/animation_controller.dart:941-952（节选）
void _tick(Duration elapsed) {
  _lastElapsedDuration = elapsed;
  final double elapsedInSeconds = elapsed.inMicroseconds.toDouble() / Duration.microsecondsPerSecond;
  _value = clampDouble(_simulation!.x(elapsedInSeconds), lowerBound, upperBound);
  if (_simulation!.isDone(elapsedInSeconds)) {
    _status = ...;
    stop(canceled: false);
  }
  ...
}
```

`AnimationController` 是 `Simulation` 与时间轴之间的唯一桥梁。`Simulation` 自己要的输入是"从开始算起经过了多少秒"，而 `Ticker` 给的是"从 Ticker 启动算起的累计时长"——两者能直接对齐，是因为 `_startSimulation` 里 `_ticker!.start()` 把计时归零了。这个对齐关系是第九篇整条链的起点。

## 五、核心对象：`Simulation` 的四种角色

| | 作用 | 典型代表 | 是否有状态 |
|---|---|---|---|
| **接口** | 定义 `x` / `dx` / `isDone` | `Simulation` | — |
| **参数对象** | 只描述配置，不含公式 | `SpringDescription`、`Tolerance` | 无（`const`） |
| **物理实现** | 一种受力模型算到底 | `Gravity` / `Friction` / `Spring` | `FrictionSimulation` 构造时算 `_finalTime`（一次性） |
| **装饰/组合** | 不改物理，只改输出或拼接两段 | `ClampedSimulation`、`BoundedFrictionSimulation`、`ScrollSpringSimulation` | `ClampedSimulation` 无；组合类通常有 |

三处容易被忽略的差异：

- `ClampedSimulation` 只夹 `x` 和 `dx`，**不夹 `isDone`**（`clamped_simulation.dart:65` 直接转发）。类文档（`:26-27`）明确写了 "The isDone logic is unaffected by the clamping"。
- `ClampedSimulation` 夹 `x` 之后，`x` 的变化率会和 `dx` 报出来的值对不上。文档在 `:23-24` 主动写明这一点，不是 bug。
- `BoundedFrictionSimulation` 与 `ClampedSimulation` 的差别：前者**还改了 `isDone`**（`friction_simulation.dart:191-196`，贴到边界也算结束），后者不改。

## 六、源码实验

### 实验 1：确认 physics 是本层里最封闭的一层

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src

# 1. 有文件碰 dart:ui 吗？
grep -rl "dart:ui" physics/ | wc -l

# 2. 哪些文件需要 dart:math？
grep -rln "dart:math" physics/*.dart

# 3. 层内依赖长什么样？
grep -rn "^import" physics/*.dart
```

**预测**：第 1 条应该是 0；第 2 条应该只有用到指数/对数的那几个文件；第 3 条应该只有 `foundation` + 同目录文件。

**实际**（输出）：

```text
# 1
0
# 2
physics/friction_simulation.dart
physics/spring_simulation.dart
# 3
physics/clamped_simulation.dart:5:import 'package:flutter/foundation.dart';
physics/clamped_simulation.dart:7:import 'simulation.dart';
physics/gravity_simulation.dart:8:import 'package:flutter/foundation.dart';
physics/gravity_simulation.dart:10:import 'simulation.dart';
physics/friction_simulation.dart:5:import 'dart:math' as math;
physics/friction_simulation.dart:7:import 'package:flutter/foundation.dart';
physics/friction_simulation.dart:9:import 'simulation.dart';
physics/spring_simulation.dart:8:import 'dart:math' as math;
physics/spring_simulation.dart:10:import 'package:flutter/foundation.dart';
physics/spring_simulation.dart:12:import 'simulation.dart';
physics/spring_simulation.dart:13:import 'utils.dart';
physics/simulation.dart:5:import 'package:flutter/foundation.dart';
physics/simulation.dart:7:import 'tolerance.dart';
physics/tolerance.dart:5:import 'package:flutter/foundation.dart';
```

**说明**：三条都符合预测。第 3 条完整列出了整个层的依赖结构，只有 13 行——这是 7 个文件、893 行的全部依赖关系。

其中两个细节值得记住：

- **`utils.dart` 一行 import 都没有**。它只有两个纯数学函数，连 `foundation` 都不需要。
- **`dart:math` 只被两个文件需要**（`friction_simulation.dart` 用 `log` / `pow`，`spring_simulation.dart` 用 `e^rt` / `cos` / `sin`）。`GravitySimulation` 因为公式是多项式（`x₀ + v₀t + ½at²`），一行 `dart:math` 都不需要。

### 实验 2：临界阻尼几乎命中不了

```dart
for (final c in <double>[5.0, 28.0, 28.284271247461902, 40.0]) {
  final s = SpringSimulation(
    SpringDescription(mass: 1.0, stiffness: 200.0, damping: c), 0.0, 100.0, 0.0);
  print('c=$c -> ${s.type}');
}
print('withDampingRatio(ratio:1) -> '
    '${SpringSimulation(SpringDescription.withDampingRatio(mass: 1.0, stiffness: 200.0, ratio: 1.0), 0.0, 100.0, 0.0).type}');
```

**预测**：判别式是 `c² - 4mk = c² - 800`。`c=5` 与 `c=28` 应落 `underDamped`（28 < √800 ≈ 28.2843），`c=40` 应落 `overDamped`；把 `c` 精确设为 `√800` 应该拿到 `criticallyDamped`。

**实际**（输出）：

```text
c=5.0 -> SpringType.underDamped
c=28.0 -> SpringType.underDamped
c=28.284271247461902 -> SpringType.overDamped
c=40.0 -> SpringType.overDamped
withDampingRatio(ratio:1) -> damping=28.284271247461902 type=SpringType.overDamped
```

前四行符合预测，**第五行是意外**：`SpringDescription.withDampingRatio(ratio: 1.0)` 算出的 `damping` 是 `2 * sqrt(1 * 200) = 28.284271247461902`，但它的 `type` 是 `overDamped`。

**说明**：判别式的第三个 case 是 `_`（即 `== 0`）。`28.284271247461902²` 在双精度下是 `800.0000000000001`，比 `4mk = 800` 大一点点，于是落到 `> 0.0` 分支。**浮点误差让"正好临界"这个 case 在通过 `withDampingRatio` 构造时几乎无法命中**——`_CriticalSolution` 实际上是"只有手写 damping 且恰好舍入正确"才会走到的分支。

**实用结论**：想要临界阻尼的**视觉效果**，接受 `ratio: 1.0` 给的 `overDamped` 即可（两者都是单调不振荡收敛）；但不要依赖 `SpringType` 的返回值去断言它是 `criticallyDamped`。

### 实验 3：`ClampedSimulation` 的 `x` 和 `dx` 会自相矛盾

```dart
final inner = GravitySimulation(9.8, 0.0, 1e9, 0.0);   // 初速度 0，加速度 9.8
final clamped = ClampedSimulation(inner, xMax: 100.0);
print('x(10)=${clamped.x(10)} dx(10)=${clamped.dx(10)}');
final springy = ClampedSimulation(inner, xMax: 100.0);
print('isDone(10)=${springy.isDone(10)} inner.isDone(10)=${inner.isDone(10)}');
```

**预测**：如果"钳制"是完整的位置约束，位置停在 100 时速度应该是 0；另外 `isDone` 说好了"不受钳制影响"，所以两个 `isDone` 应该相同。

**实际**（输出）：

```text
x(10)=100.0
dx(10)=98.0
isDone(10)=false inner.isDone(10)=false
```

**说明**：`x` 被夹到 100，但 `dx` 原样返回 `9.8 × 10 = 98.0`；`isDone` 与内层完全一致（都是 `false`，因为 `endDistance = 1e9` 还没到）。三点确认：

1. 两个夹子（`x` 与 `dx`）**互相独立**，它不知道"位置被夹住时速度应该归零"。
2. `isDone` 确实纯转发（`clamped_simulation.dart:65`）。
3. **`x` 和 `dx` 可以不一致**，这是类文档 `:23-24` 主动承认的行为，不是 bug。

所以它适合"只关心越界表现"的场景（比如 overscroll 的视觉钳制），不适合需要速度一致性的场景——后者要用 `BoundedFrictionSimulation` 这类还改了 `isDone` 的专用子类。

### 实验 4：`ScrollSpringSimulation` 为什么必须存在

```dart
const spring = SpringDescription(mass: 1.0, stiffness: 300.0, damping: 15.0);
final plain = SpringSimulation(spring, 0.0, 100.0, 0.0);
final scroll = ScrollSpringSimulation(spring, 0.0, 100.0, 0.0);
for (final t in <double>[1.0, 2.0, 3.0]) {
  print('t=$t plain=${plain.x(t)} (done=${plain.isDone(t)}) '
        'scroll=${scroll.x(t)} (done=${scroll.isDone(t)})');
}
```

**预测**：`ScrollSpringSimulation.x` 在 `isDone` 为真时返回精确终点（`spring_simulation.dart:279-280`），而 `SpringSimulation` 返回解析解本身——后者应该差一点点。

**实际**（输出）：

```text
t=1.0 plain=100.05252390740185 (done=false) scroll=100.05252390740185 (done=false)
t=2.0 plain=99.99997275449516 (done=true)   scroll=100.0 (done=true)
t=3.0 plain=100.0000000139337 (done=true)   scroll=100.0 (done=true)
```

**说明**：三点都印证了源码。

① `isDone` 为假时两者**完全相同**（t=1.0 那一行）——`ScrollSpringSimulation` 的覆写只在结束时生效，不改变运动过程。

② 进入 `isDone` 后差异立刻出现：`99.99997275449516` vs 精确的 `100.0`（**差 2.7e-5**）。

③ t=3.0 更说明问题：`SpringSimulation` 的解析解已经**超过**终点（`100.0000000139337`）——欠阻尼弹簧会过冲再回来，所以"什么时候采样"决定了它报 99.9999 还是 100.0000000；而 `ScrollSpringSimulation` 从判定结束那一刻起恒为 100。

**这就是它存在的唯一理由**：滚动位置是有语义的（内容边界、`maxScrollExtent`）。如果最后一帧停在 `99.99997`，滚动条会显示"差一点到底"。它是"精度收尾"，不是新的物理模型。

## 七、结论

1. `physics` 层的对外面是 **1 个接口 + 5 个实现 + 2 个工具函数**，7 个文件与 7 个 export 一一对应。它不依赖 `dart:ui`、不依赖任何其它层，是这个系列里唯一"纯数学"的一层。
2. `Simulation` 的契约只有 `x(time)` / `dx(time)` / `isDone(time)` 三个方法，但**不保证幂等**——文档明确允许实现有状态，只要求按时间单调向前查询。这条约束在第九篇的滚动链里会真实生效。
3. 弹簧的三个分支（临界/过阻尼/欠阻尼）只是**一个判别式的三个 case**（`damping² - 4mk` 与 0 的关系），由 `_SpringSolution` 工厂在构造时分派。`SpringType` 只是结果，不是输入。

**physics 层把"受力"抽象成了 `x(t)`，于是动画系统只需要每帧问一次时间——剩下的都交给这三个方法。**

## 八、边界声明

- `ClampingScrollSimulation` 不在本层。它住在 `packages/flutter/lib/src/widgets/scroll_simulation.dart:164`，和 `BouncingScrollSimulation`（同文件 `:18`）一起。它们是"滚动这个具体场景的仿真"，不是通用物理，所以被放在 `widgets`。本文只给位置，第九篇展开。
- `Curve` 与本层无关。`animation/curves.dart` 定义的是 `ParametricCurve<T>`（把 `t∈[0,1]` 映射到 `[0,1]`），它不需要物理模型，也不需要初速度。`Curve` 与 `Simulation` 的关系是"上层二选一"，不是继承关系——第二十篇展开。
- `FrictionSimulation.through` 的参数推导（`_dragFor` 用 `e^((v0-v1)/(x0-x1))` 反解阻力系数，`friction_simulation.dart:107-115`）本文只给锚点，不展开代数推导。
- `AnimationController` 与 `Ticker` 的接线细节留到第五卷（`animation`）第二十一篇；本文只用到 `animateWith` 和 `_tick` 两个落点。
- 参数单位与数值稳定性（`_kDecelerationRate`、`_physicalCoeff` 这些常数从哪来）留到第九篇，因为在通用层里它们不出现。
