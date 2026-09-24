# 09 一次抛滑的数值过程：ClampingScrollSimulation 与 SpringSimulation

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/scroll_simulation.dart`、`widgets/scroll_physics.dart`、`widgets/scroll_activity.dart`、`physics/`

## 一、问题

手指在列表上快速一划然后抬起。松手那一瞬间，Flutter 只拿到两个数和一次回调：

- 当前位置（逻辑像素）
- 松手速度（逻辑像素/秒）
- 一次 `goBallistic(velocity)` 调用

剩下的一切——滑多远、滑多久、什么时候停、停在整数像素还是带小数——都要在这一层算出来。

错误直觉是"松手后惯性滚动就是速度乘以某个衰减系数"。实际上有两条完全不同的路径：

- **落在内容范围内**：走 `ClampingScrollSimulation`，它**一开始就把总时长和总距离算死**，之后每一帧只是把时间归一化后代进一条幂函数。
- **已经在范围外**（越界回弹）：走 `ScrollSpringSimulation`，它没有终点时间，靠 `Tolerance` 判断"看起来停了"。

本文只追一条链：**一次快速上滑松手后，从这个速度到静止，数值上发生了什么**。

## 二、最小 Demo

不需要滚动视图也能看清这条链的核心——`ClampingScrollSimulation` 的全部数值行为：

```dart
import 'package:flutter/physics.dart';
import 'package:flutter/widgets.dart' show ClampingScrollSimulation;

void main() {
  // 1. 只给起点和速度，构造函数内部就把总时长/总距离算好
  final sim = ClampingScrollSimulation(position: 0.0, velocity: 5000.0);

  // 2. 两个内部端点：用"极大时间"把终点读出来
  debugPrint('total distance = ${sim.x(1e9).toStringAsFixed(3)}');  // 3177.622

  // 3. 逐帧取值：只有 x 和 dx 两个出口
  for (final double t in <double>[0.0, 0.5, 1.0, 1.5, 2.0]) {
    debugPrint(
      't=$t  x=${sim.x(t).toStringAsFixed(3)}  '
      'dx=${sim.dx(t).toStringAsFixed(3)}  done=${sim.isDone(t)}',
    );
  }
}
```

`ClampingScrollSimulation` 在 `widgets` 层而不在 `physics` 层，所以需要 `package:flutter/widgets.dart`（或直接用 `package:flutter/material.dart`）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/scroll_activity.dart:419` / `:441` | `DragScrollActivity.end` 与 `delegate.goBallistic(velocity)`，松手处 |
| `widgets/scroll_position_with_single_context.dart:149` | `goBallistic`：向 physics 要仿真，拿到就开 `BallisticScrollActivity` |
| `widgets/scroll_physics.dart:892-925` | `ClampingScrollPhysics.createBallisticSimulation`，五条出口的分派点 |
| `widgets/scroll_simulation.dart:164-174` | `ClampingScrollSimulation` 本体与构造里算死 `_duration` / `_distance` 的两句 |
| `widgets/scroll_simulation.dart:201` / `:208-215` | `_kDecelerationRate`（≈2.3582）与 `_physicalCoeff` |
| `widgets/scroll_simulation.dart:263` | `isDone(time) => time >= _duration`，**完全不看 tolerance** |
| `widgets/scroll_activity.dart:590-605` | `BallisticScrollActivity` 构造函数，仿真的驱动入口 |
| `animation/animation_controller.dart:861` / `:941-955` | `_startSimulation` 与 `_tick`，每帧一次 `x(elapsed)` + `isDone` |
| `physics/spring_simulation.dart:271-280` | `ScrollSpringSimulation`，保证终点精确落在边界上 |

## 四、调用链

### 4.1 第一跳：松手，速度取反

```dart
// widgets/scroll_activity.dart:418-441（节选）
void end(DragEndDetails details) {
  assert(details.primaryVelocity != null);
  // 手指向下移动 → 内容向上滚，所以取反
  double velocity = -details.primaryVelocity!;
  if (_reversed) {
    velocity = -velocity;
  }
  _lastDetails = details;

  if (_retainMomentum) {
    // 仅 iOS：把上一次抛滑的速度接上（动量保留）
    ...
  }
  delegate.goBallistic(velocity);
}
```

传出去的是**逻辑像素/秒**，方向已经统一成"滚动位置增大的方向"。`_retainMomentum` 是 iOS 专有行为（`BouncingScrollPhysics` 才打开），Android 上是 no-op。

### 4.2 第二跳：向 physics 要一个仿真

```dart
// widgets/scroll_position_with_single_context.dart:148-157
void goBallistic(double velocity) {
  assert(hasPixels);
  final Simulation? simulation = physics.createBallisticSimulation(this, velocity);
  if (simulation != null) {
    beginActivity(BallisticScrollActivity(this, simulation, context.vsync, shouldIgnorePointer));
  } else {
    goIdle();
  }
}
```

`ScrollPosition` 不认识任何具体的仿真类。它只向 `ScrollPhysics` 要一个 `Simulation?`，`null` 的含义是"不需要惯性运动，直接停"。这条分界线把"什么时候该滑"（physics 的策略）和"怎么滑"（simulation 的数学）彻底分开了。

### 4.3 第三跳：五条出口的分派

```dart
// widgets/scroll_physics.dart:892-925（ClampingScrollPhysics，节选）
Simulation? createBallisticSimulation(ScrollMetrics position, double velocity) {
  final Tolerance tolerance = toleranceFor(position);
  if (position.outOfRange) {                       // 出口 1：越界 → 回弹弹簧
    // end 取 max 或 min scrollExtent（两个 if 省去）
    return ScrollSpringSimulation(
      spring, position.pixels, end!, math.min(0.0, velocity), tolerance: tolerance,
    );
  }
  if (velocity.abs() < tolerance.velocity) {        // 出口 2：太慢 → 不滑（:912）
    return null;
  }
  if (velocity > 0.0 && position.pixels >= position.maxScrollExtent) {
    return null;                                    // 出口 3：贴着末端还要往下 → 不滑（:915）
  }
  if (velocity < 0.0 && position.pixels <= position.minScrollExtent) {
    return null;                                    // 出口 4：贴着起点还要往上 → 不滑（:918）
  }
  return ClampingScrollSimulation(                  // 出口 5：正常抛滑
    position: position.pixels, velocity: velocity, tolerance: tolerance,
  );
}
```

三个 `return null`（`scroll_physics.dart:912` / `:915` / `:918`）/ 一个 `ClampingScrollSimulation`，加上越界时的 `ScrollSpringSimulation`；仿真类本体（`scroll_simulation.dart`）里一处 `return null` 都没有，`null` 全部出自 physics 的这一层分派。

注意出口 1 的初速度被写成 `math.min(0.0, velocity)`——这是一个**只看符号、不看越界在哪一侧**的钳制，因此上下边界的行为并不对称：

- **超出下边界**（`pixels > maxScrollExtent`，`end = maxScrollExtent`，回弹方向是负速度）：向外的正速度被清零，向内的负速度原样保留。这一侧确实是"回弹永不带向外的初速"。
- **超出上边界**（`pixels < minScrollExtent`，`end = minScrollExtent`，回弹方向是正速度）：同一个表达式的作用正好反过来——向内的正速度被清零，向外的负速度反而原样保留。

顺带对照 `applyBoundaryConditions`（`scroll_physics.dart:847-888`）：拖动和抛滑写位置走的 `setPixels` 会被它把越界部分全部退回（"Underscroll/Overscroll"两个分支返回整个 delta，"Hit top/bottom edge"两个分支只返回冲出边界的那一段），所以 Clamping 的正常滚动路径根本出不了界，能走进出口 1 的位置基本来自 `jumpTo` → `forcePixels` 这类绕过边界条件的直接设值——随后接的是 `goBallistic(0.0)`，速度为零，上面这个钳制恰好无感知。

`toleranceFor` 已经是按设备像素比算过的（`widgets/scroll_physics.dart:439-445`）：

```dart
Tolerance toleranceFor(ScrollMetrics metrics) {
  return parent?.toleranceFor(metrics) ??
      Tolerance(
        velocity: 1.0 / (0.050 * metrics.devicePixelRatio), // logical pixels per second
        distance: 1.0 / metrics.devicePixelRatio, // logical pixels
      );
}
```

dpr=3 时 `velocity = 6.667`。也就是说松手速度低于 **6.67 逻辑像素/秒**就不启动抛滑。这个默认的 `Tolerance.defaultTolerance.velocity = 0.001` 差了三个数量级——**physics 层的默认容差从来不是滚动用的容差**。

### 4.4 第四跳：构造函数里把总时长和总距离算死

```dart
// widgets/scroll_simulation.dart:166-174
ClampingScrollSimulation({
  required this.position,
  required this.velocity,
  this.friction = 0.015,
  super.tolerance,
}) {
  _duration = _flingDuration();
  _distance = _flingDistance();
}
```

两个私有函数都基于同一套从 Android `SplineOverScroller` 搬来的常数：

```dart
// widgets/scroll_simulation.dart:201-215
static final double _kDecelerationRate = math.log(0.78) / math.log(0.9);  // ≈ 2.35820
static const double _kInflexion = 0.35;
static const double _physicalCoeff =
    9.80665   // g, m/s²
    * 39.37   // 1 m / 1 inch
    * 160.0   // 1 inch / 1 logical pixel
    * 0.84;   // "look and feel tuning"
```

代入 `friction = 0.015` 得到 `referenceVelocity = 0.015 × 51890.20 / 0.35 ≈ 2223.87`。然后：

```dart
// widgets/scroll_simulation.dart:218-230（节选）
double _flingDuration() {
  final double referenceVelocity = friction * _physicalCoeff / _kInflexion;
  final androidDuration =
      math.pow(velocity.abs() / referenceVelocity, 1 / (_kDecelerationRate - 1.0)) as double;
  return _kDecelerationRate * _kInflexion * androidDuration;
}
```

```dart
// widgets/scroll_simulation.dart:234-248（节选）
double _flingDistance() {
  final double distance = velocity * _duration / _kDecelerationRate;
  assert(() {
    // Android 真正用的那个复杂公式，化简后就是这个乘法
    final double referenceVelocity = friction * _physicalCoeff / _kInflexion;
    final double logVelocity = math.log(velocity.abs() / referenceVelocity);
    final double distanceAgain = friction * _physicalCoeff *
        math.exp(logVelocity * _kDecelerationRate / (_kDecelerationRate - 1.0));
    return (distance.abs() - distanceAgain).abs() < tolerance.distance;
  }());
  return distance;
}
```

`_distance` 里那个 `assert` 是整段代码里信息量最大的地方。它是说——**Android 用一长串指数运算算出的滑行距离，等于 `velocity × duration / k` 这个乘法**。这不是近似，是恒等变形；`assert` 在 debug 下每构造一次就跑一遍做校验，release 下整块被剥掉。这也解释了为什么 `_flingDistance` 要接收 `tolerance`：只是为了给这个自检定一个比较精度。

代入几个速度（数值为源码公式直接计算）：

| 松手速度 (px/s) | 总时长 (s) | 总距离 (px) |
|---|---|---|
| 1000 | 0.458231 | 194.314 |
| 3000 | 1.028900 | 1308.921 |
| 5000 | 1.498695 | 3177.622 |
| 10000 | 2.496616 | 10586.950 |

注意：**距离不是线性的**。速度翻三倍（1000→3000），距离涨到 6.7 倍。这正是"滑得越快越刹不住"的数值体现。

### 4.5 第五跳：每一帧只是把时间归一化

```dart
// widgets/scroll_simulation.dart:250-265
@override
double x(double time) {
  final double t = clampDouble(time / _duration, 0.0, 1.0);
  return position + _distance * (1.0 - math.pow(1.0 - t, _kDecelerationRate));
}

@override
double dx(double time) {
  final double t = clampDouble(time / _duration, 0.0, 1.0);
  return velocity * math.pow(1.0 - t, _kDecelerationRate - 1.0);
}

@override
bool isDone(double time) {
  return time >= _duration;
}
```

三处要点：

1. `t = clampDouble(time / _duration, 0.0, 1.0)` —— 超出时长后 `t` 被钉在 1，`x` 自然停在终点。所以 `x(1e9)` 可以安全地读作"总距离"。
2. `isDone` **完全不看 `tolerance`**，只有一次时间和时长的比较。`ClampingScrollSimulation` 是**有限时长**的（`_duration` 是有限值），所以它能给出精确的结束时刻；而 `FrictionSimulation` 和 `SpringSimulation` 是渐近的，必须靠容差。
3. `dx` 的指数是 `_kDecelerationRate - 1.0 ≈ 1.3582`，不是 `_kDecelerationRate`。这是对 `x` 求导的结果，不是独立设计的。

`t = 1` 时 `dx` 正好是 0。也就是说 `ClampingScrollSimulation` 的**终点速度精确为零**，最后一段会明显"刹住"而不是渐近逼近。

### 4.6 第六跳：谁来每帧调用 `x`

```dart
// widgets/scroll_activity.dart:590-605
BallisticScrollActivity(
  super.delegate,
  Simulation simulation,
  TickerProvider vsync,
  this.shouldIgnorePointer,
) {
  _controller =
      AnimationController.unbounded(
          debugLabel: kDebugMode ? objectRuntimeType(this, 'BallisticScrollActivity') : null,
          vsync: vsync,
        )
        ..addListener(_tick)
        ..animateWith(
          simulation,
        ).whenComplete(_end);
}
```

注意这里是 **`AnimationController.unbounded`**。默认的 `AnimationController` 会把 `value` 夹在 `[0, 1]`，而滚动位置是任意像素值，必须用无界版本。

`animateWith` 最终落到 `_startSimulation`：

```dart
// animation/animation_controller.dart:861-872（节选）
TickerFuture _startSimulation(Simulation simulation) {
  assert(!isAnimating);
  _simulation = simulation;
  _lastElapsedDuration = Duration.zero;
  _value = clampDouble(simulation.x(0.0), lowerBound, upperBound);   // 立刻取 t=0
  final TickerFuture result = _ticker!.start();                       // 计时归零
  _status = ...;
  return result;
}
```

然后每帧：

```dart
// animation/animation_controller.dart:941-955（节选）
void _tick(Duration elapsed) {
  _lastElapsedDuration = elapsed;
  final double elapsedInSeconds = elapsed.inMicroseconds.toDouble() / Duration.microsecondsPerSecond;
  _value = clampDouble(_simulation!.x(elapsedInSeconds), lowerBound, upperBound);
  if (_simulation!.isDone(elapsedInSeconds)) {
    _status = (_direction == _AnimationDirection.forward)
        ? AnimationStatus.completed : AnimationStatus.dismissed;
    stop(canceled: false);
  }
  notifyListeners();
  _checkStatusChanged();
}
```

`_ticker!.start()` 把计时归零，于是 `Ticker` 给的 `elapsed` 就是"从仿真开始算起的秒数"。这个对齐是 `Simulation` 能直接用 `Ticker` 时间戳的唯一原因——如果 `Ticker` 的 `elapsed` 是应用启动以来的时长，每个仿真都得自己带一个起点偏移。`BouncingScrollSimulation` 里那个 `_timeOffset`（`widgets/scroll_simulation.dart:107-117`）就是它自己在做这种偏移。

### 4.7 第七跳：把值搬回滚动位置

`AnimationController` 每帧 `notifyListeners()`，`BallisticScrollActivity` 的监听器接住：

```dart
// widgets/scroll_activity.dart:619-635
void _tick() {
  if (!applyMoveTo(_controller.value)) {
    delegate.goIdle();
  }
}

bool applyMoveTo(double value) {
  return delegate.setPixels(value).abs() < precisionErrorTolerance;
}
```

`delegate.setPixels` 返回**越界量**。所以这一行的含义是：把动画值写进滚动位置，如果产生了越界（返回值的绝对值超过浮点误差），说明需要立刻转成别的活动（通常是重新 `goBallistic` 走回弹）。

### 4.8 第八跳：结束

`animateWith` 返回的 `TickerFuture` 完成时触发 `_end`：

```dart
// widgets/scroll_activity.dart:637-643
void _end() {
  // Check if the activity was disposed before going ballistic because _end might be called
  // if _controller is disposed just after completion.
  if (!_isDisposed) {
    delegate.goBallistic(0.0);
  }
}
```

`goBallistic(0.0)` 会再次进 `createBallisticSimulation`，此时 `velocity = 0.0 < tolerance.velocity`，于是命中分支 2 返回 `null` → `goIdle()`。

抛滑结束时**会再绕一次 `createBallisticSimulation`，并不直接 `goIdle`**。这个设计是有意的——如果结束那一刻位置恰好越界，这次绕行会直接接上回弹弹簧而不是停下。整条链的收尾逻辑只有一份，就是 `createBallisticSimulation`。

### 4.9 越界回弹那一条：`ScrollSpringSimulation`

分支 1 用的是 `ScrollSpringSimulation`，它比普通 `SpringSimulation` 多了一行：

```dart
// physics/spring_simulation.dart:279-280
@override
double x(double time) => isDone(time) ? _endPosition : super.x(time);
```

`SpringSimulation` 的解析解是渐近的，`isDone` 判真时 `_solution.x(time)` 可能还剩 `1e-4`。`ScrollSpringSimulation` 直接覆盖成终点值，**保证最后一帧的滚动位置精确落在 `maxScrollExtent` / `minScrollExtent`**。

弹簧参数来自 `ScrollPhysics.spring`（`widgets/scroll_physics.dart:418`，`parent?.spring ?? _kDefaultSpring`）。而 `BouncingScrollPhysics` 会覆写它给出 iOS 的弹簧参数。

## 五、核心对象：两种仿真对比

| | `ClampingScrollSimulation` | `ScrollSpringSimulation` |
|---|---|---|
| 所在层 | `widgets/scroll_simulation.dart:164` | `physics/spring_simulation.dart:271`（父类在 physics） |
| 何时被选中 | 位置在范围内且有足够速度 | `position.outOfRange` |
| 时长 | **有限，构造时算死**（`_duration`） | 无限，靠容差判定 |
| `isDone` 依据 | `time >= _duration` | 位移与速度**同时** `nearZero` |
| 是否受 `Tolerance` 影响 | 否 | 是（`distance` 与 `velocity`） |
| 终点位置 | 精确（`t` 被夹到 1） | 精确（重写了 `x` 做 snap） |
| 终点速度 | 精确为 0 | 由 `_c1/c2` 决定，但 `isDone` 时不显著 |
| 数学形式 | 幂函数 `1-(1-t)^2.3582` | 二阶常系数线性方程的解 |

**两者的共同点比差异更重要**：都只有 `x` / `dx` / `isDone` 三个出口，都由 `AnimationController` 驱动，都通过同一个 `_tick` 把值写回 `setPixels`。上层不需要知道当前用的是哪一个。

## 六、源码实验

### 实验 1：`ClampingScrollSimulation` 的数值全貌

在 `/tmp` 下建临时工程跑一次 `flutter test`（跑完即删）：

```dart
final sim = ClampingScrollSimulation(position: 0.0, velocity: 5000.0);
for (final t in <double>[0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0]) {
  print('t=$t x=${sim.x(t)} dx=${sim.dx(t)} done=${sim.isDone(t)}');
}
```

**预测**：`x` 单调逼近 3177.622，`dx` 单调降到 0；`1.5s` 之后 `isDone` 为 true（因为算出的时长是 1.4987s），之后 `x` 和 `dx` 都不再变化。

**实际输出**：

```text
t=0.0   x=0.0000     dx=5000.0000  done=false
t=0.2   x=910.8507   dx=4116.0588  done=false
t=0.4   x=1649.5936  dx=3279.7091  done=false
t=0.6   x=2226.2654  dx=2496.3878  done=false
t=0.8   x=2652.1693  dx=1773.4829  done=false
t=1.0   x=2940.3925  dx=1121.7981  done=false
t=1.2   x=3106.7921  dx=559.2026   done=false
t=1.5   x=3177.6219  dx=0.0000     done=true
t=2.0   x=3177.6219  dx=0.0000     done=true
```

**说明**：`dx` 的衰减在中段就已经很慢（1.0s 时还有 1121，1.2s 时只剩 559），最后 0.3 秒走完了剩下的 70 像素。这是 `(1-t)^1.3582` 这条曲线的形状：**前段快、后段急剧收尾**。同一次运行还确认了 `t=1.5` 时 `dx` 精确等于 0，验证了 §4.5 第 3 点的推导。

### 实验 2：真正跑一次 fling，逐帧对账

```dart
// Android 平台，200 项列表，每项高 50 → maxScrollExtent = 9400
await tester.fling(find.byType(ListView), const Offset(0, -400), 3000);
for (int i = 0; i < 12; i++) {
  await tester.pump(const Duration(milliseconds: 100));
  print('frame $i pixels=${position.pixels}');
}
```

**预测**：抛滑段的总位移应该等于 `ClampingScrollSimulation(position: x, velocity: 3000)` 的 `x(∞) - x`，即 §4.4 表里的 **1308.921** 像素。

**实际输出**（节选）：

```text
maxScrollExtent=9400.0 toleranceFor=6.666666666666666
rightAfterFling pixels=400.00
frame 1  pixels=680.43
frame 3  pixels=1128.32
frame 6  pixels=1542.68
frame 9  pixels=1699.16
frame 11 pixels=1708.92
afterSettle pixels=1708.92 isScrolling=false
```

`1708.92 - 400.00 = 1308.92`，与公式预测的 `1308.920967` 完全一致。

**说明**：这是一个**端到端对账**——从 `tester.fling` 的手势，到 `DragScrollActivity.end`，到 `goBallistic`，到 `ClampingScrollSimulation` 的幂函数，再到 `setPixels`，最后落回像素位置。中间任何一跳改了公式，这 1308.92 就不再成立。同时也确认了 `toleranceFor` 在 dpr=3 的测试环境下返回 `6.6667`（即 `1/(0.05×3)`）。

### 实验 3：越界回弹走的是另一条路径

```dart
position.jumpTo(position.maxScrollExtent + 300);   // 硬跳到 9700
(position as dynamic).goBallistic(0.0);            // 触发（goBallistic 在 ScrollPositionWithSingleContext 上）
for (int i = 0; i < 12; i++) {
  await tester.pump(const Duration(milliseconds: 50));
  print('t=${(i+1)*50}ms pixels=${position.pixels}');
}
```

**预测**：`position.outOfRange` 为 true，命中分支 1，走 `ScrollSpringSimulation`。位置应该从 9700 指数式收敛到 9400，且**最终精确等于 9400**（因为 `ScrollSpringSimulation` 重写了 `x` 做 snap），活动类型是 `BallisticScrollActivity`。

**实际输出**（节选）：

```text
jumped pixels=9700.0 outOfRange=true
ballistic started, activity=BallisticScrollActivity
t=100ms pixels=9654.208
t=200ms pixels=9523.032
t=350ms pixels=9433.227
t=600ms pixels=9403.465
final pixels=9400.000 activity=IdleScrollActivity
```

**说明**：三点确认。① 同样的 `BallisticScrollActivity` 类，内部装的却是完全不同的仿真——上层确实不区分。② 收敛曲线呈指数型（每 50ms 的增量依次减小），与弹簧解析解一致，而不是 `ClampingScrollSimulation` 那种"最后一段急速收尾"。③ `final pixels` 是 `9400.000` 而不是 `9399.98x`，这是 `ScrollSpringSimulation.x` 那行三元表达式的直接效果。

### 实验 4：`isDone` 不看 `tolerance`

```dart
final loose = ClampingScrollSimulation(
  position: 0.0, velocity: 5000.0,
  tolerance: const Tolerance(distance: 1000.0, time: 1000.0, velocity: 1000.0),
);
final tight = ClampingScrollSimulation(position: 0.0, velocity: 5000.0);
print('${loose.isDone(1.0)} ${tight.isDone(1.0)}');   // 都应是 false
print('${loose.x(1.0)} ${tight.x(1.0)}');             // 应完全相同
```

**预测**：如果 `isDone` 用了容差，把 `tolerance.velocity` 放到 1000 之后，`t=1.0`（此时 `dx=1121.8`）应该被判为已停。

**实际输出**：

```text
loose x(1.0)=2940.3924984425544 done(1.0)=false
tight x(1.0)=2940.3924984425544 done(1.0)=false
```

两者都是 `false`，`x` 也完全相同。

**说明**：`ClampingScrollSimulation.isDone` 只看 `time >= _duration`（源码依据：`widgets/scroll_simulation.dart:263`），`tolerance` 在这个类里**只在 `_flingDistance` 的那个 `assert` 里被用到**。这解释了一个常见困惑：给滚动仿真换一个宽松的 `Tolerance`，抛滑的滑行距离和时长都不会变——它只影响"多慢算停"（`createBallisticSimulation` 的分支 2），不影响已经开始的抛滑。

## 七、结论

1. 一次抛滑的数值过程是**两段式**：构造函数里一次性算死 `_duration` 与 `_distance`（`widgets/scroll_simulation.dart:172-173`），之后每帧只做一次除法、一次 `clampDouble`、一次 `pow`。所谓"物理仿真"在这里退化成了一条闭式幂函数。
2. `ScrollPhysics.createBallisticSimulation` 是**唯一的分派点**，也是整条链唯一知道"该用哪种运动"的地方。它返回 `null` 表示"不需要运动"，这个 `null` 同时承担了三种语义（太慢、已贴边、结束收尾）。
3. `ClampingScrollSimulation` 的 `isDone` 与 `Tolerance` 无关（它时长有限）；`ScrollSpringSimulation` 的 `isDone` 强依赖 `Tolerance`（它渐近）。**同一组 `physics` + `tolerance` 参数在两个分支上的作用完全不同**，这是读这条链最容易混淆的一点。

**松手之后 Flutter 在构造函数里就把答案算完，剩下的每一帧只是把时间代进去，并不会逐帧减小速度。**

## 八、边界声明

- `ScrollPhysics` 的职责分层（`ScrollPhysics` / `ScrollBehavior` / `ScrollConfiguration` 三者关系）、`applyPhysicsToUserOffset` 与 `applyBoundaryConditions` 的区别，留到第十卷（`widgets` 应用协议）的 `Scrollable` 篇。
- iOS 的 `BouncingScrollSimulation`（`widgets/scroll_simulation.dart:18`）本文只给锚点。它的特点是**内部同时持有摩擦段和弹簧段，靠 `_springTime` 做接力**（`widgets/scroll_simulation.dart:107-117`），另开一篇讲更合适。
- `DragScrollController` 的手势层（`_maybeLoseMomentum`、`_adjustForScrollStartThreshold`、iOS 的动量保留）属于 `gestures` 与 `widgets` 的交界，留到第九卷。
- 物理常数为什么是 `0.78/0.9`、`0.84`、`160.0`——这些是从 Android `OverScroller.java` 与 iOS `UIScrollView` 的对齐过程中调出来的，属于"平台观感对齐"而不是框架机制，这个系列不追。
- `Tolerance` 在 `physics` 层里"只是三个 double"，它的构造与默认值已在第八篇讲过，本文只讲它在这里的两处真实用法。
