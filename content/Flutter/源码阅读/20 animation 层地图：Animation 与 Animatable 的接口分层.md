# 20 animation 层地图：Animation 与 Animatable 的接口分层

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/animation`（8 文件 5210 行）

## 一、问题

`Animation<double>` 这个名字很容易让人以为它就是"动画"——一个会随时间长出不同值的对象。

于是有两个常见错误直觉：

1. **"`Animation` 自己会动。"** 实际上 `Animation` 的接口里**没有任何时间概念**：没有 `duration`、没有 `elapsed`、没有 `Ticker`，只有 `value`、`status` 和四个监听方法。它是一个"值可能变化的 `Listenable`"，至于值为什么变、什么时候变，它不关心。
2. **"`Curve` 是一种 `Animatable`。"** `Curve` 不是 `Animatable` 的子类，两者没有继承关系。`Animatable<T>` 是"把 `double` 映射成 `T`"，`Curve` 是"把 `double` 映射成 `double`"——它们只是方法签名长得像（都是 `transform(double t)`），血缘上没有任何关系。

那么这一层 5210 行到底在分什么？答案是**按"是否持有时间"把 8 个文件切成六区**，而真正持有时间的只有一个类：`AnimationController`（第 21 篇）。

**关键认知**：`animation` 是一个**纯函数式**的层。8 个文件里除了 `AnimationController`，没有任何一处引用 `Ticker`、`Simulation` 或 `SchedulerBinding`。其余 7 个文件全部在做"给定一个 `t`，算出另一个值"的映射工作。

## 二、最小 Demo

同一个 `AnimationController`，用四种方式变换它。观察每一行输出的类型：

```dart
import 'package:flutter/animation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';   // TestVSync 在 flutter_test 里

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final AnimationController c = AnimationController(
    vsync: const TestVSync(),                    // 1. 只有 controller 需要 vsync
    duration: const Duration(milliseconds: 300),
  );

  // 2. Tween.animate：Animatable → Animation（会产生一个新的 Animation 对象）
  final Animation<Offset> a = Tween<Offset>(begin: Offset.zero, end: const Offset(1, 0)).animate(c);

  // 3. Animation.drive：语义相同，主语反过来
  final Animation<Offset> b = c.drive(Tween<Offset>(begin: Offset.zero, end: const Offset(1, 0)));

  // 4. chain：Animatable → Animatable（不产生 Animation，读 value 时才逐层算）
  final Animatable<Offset> chained = Tween<Offset>(begin: Offset.zero, end: const Offset(1, 0))
      .chain(CurveTween(curve: Curves.easeIn));
  final Animation<Offset> d = chained.animate(c);

  // 5. CurvedAnimation：Animation → Animation（CurveTween 的另一种写法）
  final Animation<double> e = CurvedAnimation(parent: c, curve: Curves.easeIn);

  c.value = 0.5;                                 // 6. 手动把进度推到一半，不需要跑帧
  debugPrint('a=${a.value}');
  debugPrint('b=${b.value}');
  debugPrint('d=${d.value}');
  debugPrint('e=${e.value}   Curves.easeIn.transform(0.5)=${Curves.easeIn.transform(0.5)}');
}
```

**这段 Demo 说明的是分层的核心事实**：`c.value = 0.5` 这一行既没有排帧、也没有等时间，但四个派生动画的 `value` 立刻都是对的。因为除了 `c` 之外，其他对象都是**纯映射**——它们不产生时间，只消费 `c` 给出的 `t`。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `animation/animation.dart:145` | `abstract class Animation<T> extends Listenable implements ValueListenable<T>` |
| `animation/animation.dart:22` | `enum AnimationStatus`，四个值 + 三个派生 getter |
| `animation/animation.dart:345` | `Animation.drive`，`Animation → Animatable` 方向的入口 |
| `animation/tween.dart:34` | `abstract class Animatable<T>`，四个方法 |
| `animation/tween.dart:267` | `class Tween<T>`，`Animatable` 的主力实现 |
| `animation/tween.dart:554` | `class CurveTween extends Animatable<double>`，Curve 的包装（第 22 篇主线） |
| `animation/animations.dart:133` | `mixin AnimationWithParentMixin`，"转发给 parent"这一族的公共骨架 |
| `animation/animations.dart:174` / `273` / `379` | `ProxyAnimation` / `ReverseAnimation` / `CurvedAnimation` |
| `animation/curves.dart:26` | `abstract class ParametricCurve<T>`，`transform` / `transformInternal` 的分工 |
| `animation/curves.dart:75` | `abstract class Curve extends ParametricCurve<double>`，端点契约 |
| `animation/animation_style.dart:30` | `class AnimationStyle`，只是把 curve/duration 打包成 `Diagnosticable` |
| `animation/animation_controller.dart:221` | `class AnimationController`，**本层唯一持有时间的类** |

## 四、调用链

### 4.1 八个文件的分区

按"是否持有时间"和"映射什么"来切，这层分成六区：

| 区 | 文件 | 行数 | 职责 | 有状态吗 |
|---|---|---|---|---|
| A 接口与枚举 | `animation.dart` | 412 | `Animation` 抽象、`AnimationStatus` | 无 |
| A' 监听实现 | `listener_helpers.dart` | 268 | 四个 mixin，提供 `addListener` 的两种策略 | 有（监听者计数 / 列表） |
| B 驱动 | `animation_controller.dart` | 1061 | 唯一会 tick、唯一持有 `Simulation` 的类 | **有（时间）** |
| C 派生包装 | `animations.dart` | 730 | 包住别的 `Animation` 再暴露成 `Animation` | 少（多数只转发） |
| D 值映射 | `tween.dart` | 572 | `Animatable` / `Tween`，`double → T` | 无（纯函数） |
| D' 分段映射 | `tween_sequence.dart` | 163 | 按权重把 `t` 分到不同 `Tween` | 无 |
| E 曲线 | `curves.dart` | 1895 | `ParametricCurve` / `Curve` / 40 余条曲线 | 无（纯函数） |
| F 样式载体 | `animation_style.dart` | 109 | 把 curve + duration 打包给 widget 层用 | 无 |

E 区占了 1895 行——**这是整层最大的文件，但它没有一个可变字段**。`Cubic`、`ThreePointCubic`、`CatmullRomCurve` 都是不可变对象，`transform` 是纯粹的数学计算。

**关键认知**：行数分布会骗人。`curves.dart` 占 36% 的篇幅，但它对理解动画机制几乎没有帮助；真正的机制在 412 行的 `animation.dart`（接口）和 1061 行的 `animation_controller.dart`（驱动）。**读这层应该按 A → D → B → C 的顺序，E 区当查表用。**

### 4.2 `Animation` 的全部接口面

把 `animation.dart` 里的抽象成员抽出来，一共只有 6 个：

```dart
// animation/animation.dart:208-238（去掉文档后）
void addListener(VoidCallback listener);
void removeListener(VoidCallback listener);
void addStatusListener(AnimationStatusListener listener);
void removeStatusListener(AnimationStatusListener listener);
AnimationStatus get status;
T get value;
```

全部派生成员都是从这 6 个里算出来的（`isDismissed`、`isCompleted`、`isForwardOrCompleted` 走 `status`，`isAnimating` 默认也走 `status`），唯一的例外是 `drive`（`:345`），它是一行语法糖：

```dart
// animation/animation.dart:345-348
Animation<U> drive<U>(Animatable<U> child) {
  assert(this is Animation<double>);
  return child.animate(this as Animation<double>);
}
```

**注意那个 `assert(this is Animation<double>)`**：`drive` 声明在 `Animation<T>` 上而不是 `Animation<double>` 上，但只有 `double` 类型的动画才能被驱动。类型系统表达不了这个约束，只能用断言。**这是这一层最不"类型安全"的地方**，也是读代码时容易困惑的点：为什么 `Animation<Color>` 也有 `drive` 方法？答案是"有，但一用就炸"。

### 4.3 两条派生路径：包装 Animation，还是包装 Animatable

这层有两个方向的"组合"：

**路径 1：`Animation` 包 `Animation`**（`animations.dart` 全族）。它们都是 `Animation` 的子类，持有另一个 `Animation` 作为 `parent`，并把监听转发出去：

```dart
// animation/animations.dart:133-165（节选）
mixin AnimationWithParentMixin<T> {
  Animation<T> get parent;

  void addListener(VoidCallback listener) => parent.addListener(listener);
  void removeListener(VoidCallback listener) => parent.removeListener(listener);
  void addStatusListener(AnimationStatusListener listener) => parent.addStatusListener(listener);
  void removeStatusListener(AnimationStatusListener listener) => parent.removeStatusListener(listener);
  AnimationStatus get status => parent.status;
}
```

这个 mixin 故意**只实现 6 个成员中的 5 个**，把 `T get value` 留给子类。文档把原因写在注释里（`animations.dart:129`）："to mix in this class, implement [parent], and implement `T get value`"。于是每个派生动画只需要写一行 `value`：

| 类 | `value` 是什么 | 它改变的是 |
|---|---|---|
| `CurvedAnimation`（`:379`） | `activeCurve.transform(parent.value)` | 值的形状（曲线） |
| `ReverseAnimation`（`:273`） | `1.0 - parent.value`（同族） | 值的方向 + status 反转 |
| `ProxyAnimation`（`:174`） | `_parent!.value`，`parent` **可写** | 值来自谁（可中途换源） |
| `TrainHoppingAnimation`（`:493`） | 在两条动画之间按条件切换 | 值的来源 + 无缝换向 |
| `CompoundAnimation`（`:624`） | 子类决定（`AnimationMean` 取均值等） | 多个动画的合成 |
| `AlwaysStoppedAnimation`（`:91`） | 构造时传入的常数 | 什么都不变（空对象） |

`ProxyAnimation` 与 `TrainHoppingAnimation` 都用 `AnimationLazyListenerMixin`：只有在**外部真的挂了监听**时才去监听 parent。相反，`AnimationController` 用的是 `AnimationEagerListenerMixin`（`animation_controller.dart:223`），它的 `didRegisterListener` 是空实现——因为 controller 的 tick 由 `start()` 决定，与有没有监听者无关。

**关键认知**：`Lazy` 与 `Eager` 的分界是"谁决定是否运行"。派生动画的运行由 parent 决定，所以它们不需要常驻监听（Lazy）；`AnimationController` 的运行由 `start()` 决定，所以监听者计数对它没有意义（Eager）。

**路径 2：`Animatable` 包 `Animatable`，最后才变成 `Animation`**（`tween.dart`）：

```dart
// animation/tween.dart:83-99
Animation<T> animate(Animation<double> parent) {
  return _AnimatedEvaluation<T>(parent, this);
}

Animatable<T> chain(Animatable<double> parent) {
  return _ChainedEvaluation<T>(parent, this);
}
```

两者的差别很具体：

| | `animate` | `chain` |
|---|---|---|
| 返回类型 | `Animation<T>` | `Animatable<T>` |
| 产生的对象 | `_AnimatedEvaluation`（`tween.dart:114`） | `_ChainedEvaluation`（`tween.dart:136`） |
| 内部结构 | 持有一个 `Animation` + 一个 `Animatable` | 持有两个 `Animatable` |
| 何时计算 | 读 `.value` 时 `evaluate(parent)` → `transform(parent.value)` | 读 `.transform(t)` 时从最外层往里逐层套 |
| 监听 | 直接把 parent 当自己的 parent（混入 `AnimationWithParentMixin`） | 没有监听概念，因为它不是 `Animation` |

**为什么要有 `chain`**：`Tween.chain(CurveTween(...))` 把"曲线"和"插值"合成一个 `Animatable`，最后只 `animate` 一次。如果反过来写成 `CurveTween(...).animate(c).drive(Tween(...))`，中间会多出一个 `Animation<double>` 对象，并且每读一次 `value` 都会多走过一层监听链。`tween.dart:158-166` 的文档把收益写得很直白："avoids creating Animation objects for the intermediate results"。

### 4.4 分层里的"时间"只有一个入口

```bash
cd packages/flutter/lib/src/animation
for f in animation.dart animations.dart curves.dart listener_helpers.dart tween.dart tween_sequence.dart; do
  echo -n "$f: "; grep -c "Ticker\|Simulation" $f
done
```

**实际**：六个文件全部是 0。`animation.dart` 里唯一两处 `Ticker` 出现在文档注释（`:93`、`:106`）。

也就是说，从 `Animation` 到 `Tween` 到 `Curve` 到 `Animations` 全族，**没有一行代码知道时间的存在**。它们只接受一个 `double t`。

**关键认知**：这就是为什么 `c.value = 0.5` 能让整条链立刻算出正确结果（第二节的 Demo）。整个 `animation` 层是"t 的纯函数"，`t` 从哪来完全是 `AnimationController` 的内部事务。

### 4.5 依赖边

```bash
grep -rn "^import" packages/flutter/lib/src/animation/*.dart
```

汇总后是四条边加一条特殊的回指：

| 依赖 | 出现在 | 用途 |
|---|---|---|
| `package:flutter/foundation.dart` | 7 个文件 | `Listenable` / `ValueListenable` / `ObserverList` / `Diagnosticable` |
| `package:flutter/physics.dart` | 仅 `animation_controller.dart:12` | `Simulation`（第 21、22 篇主线） |
| `package:flutter/scheduler.dart` | 仅 `animation_controller.dart:13` | `TickerProvider` / `TickerFuture` |
| `package:flutter/semantics.dart` | 仅 `animation_controller.dart:14` | `SemanticsBinding.instance.disableAnimations`（无障碍"减少动画"开关） |
| `package:flutter/cupertino.dart` | 仅 `animation/curves.dart:11` | **代码里零使用**，只为注释里的 `[CupertinoPageRoute]` 链接 |

最后一行值得单独说：`curves.dart` 是整层最大的文件，也是最底层（曲线数学）的文件，却 import 了最顶层之一的 `cupertino`。用 grep 验证：

```bash
grep -in "cupertino" packages/flutter/lib/src/animation/curves.dart
```

**实际**：只有两行——`:11` 的 import 和 `:1491` 的一处 dartdoc 引用。**这条边是一份文档依赖，不是代码依赖**。上一层的 material/cupertino 反过来依赖整个 animation，所以这里形成了一个真实的 import 环（README 里提到的"少量反向引用"就包括这一条）。

## 五、核心对象：三个核心接口的职责对比

| | `Animation<T>` | `Animatable<T>` | `Curve` |
|---|---|---|---|
| 声明位置 | `animation/animation.dart:145` | `animation/tween.dart:34` | `animation/curves.dart:75` |
| 父类型 | 无（`extends Listenable`） | 无 | `extends ParametricCurve<double>` |
| 核心成员 | `value` / `status` + 4 个监听方法 | `transform(double)` | `transform(double)` / `transformInternal(double)` |
| 输入 | 无（自己就是值源） | `double t` | `double t` |
| 输出 | `T` | `T` | `double` |
| 有状态吗 | 有（值会变，且能发通知） | 无 | 无 |
| 能监听吗 | 能 | 不能 | 不能 |
| 能变成对方吗 | 可以通过 `drive(Animatable)` 生成 `Animation<U>` | 通过 `animate(Animation<double>)` 变成 `Animation<T>` | 通过 `CurveTween` 变成 `Animatable<double>`，再走 `animate` |
| 端点契约 | 无 | 无 | **有**：`transform` 在 `t` 为 0/1 时必须返回 0/1 |
| 子类举例 | `AnimationController`、`CurvedAnimation`、`ProxyAnimation` | `Tween`、`CurveTween`、`TweenSequence` | `Cubic`、`Interval`、`FlippedCurve` |

最后三行的关系是本层最容易记混的地方，可以用一句"接口方向"来记：

```text
Curve         --(CurveTween 包装)--> Animatable<double>
Animatable<T> --(animate / drive)--> Animation<T>
Animation<T>  --(drive(Animatable<U>))--> Animation<U>
```

**关键认知**：`Animatable` 是这一层的**中间货币**。它既不是"能发通知的东西"，也不是"有形状的东西"，而是"一个纯映射函数被对象化"的结果。整个 animation 层的组合能力，都建立在"任何映射都可以被 `chain` 起来"这一点上。

## 六、源码实验

### 实验 1：只有 `AnimationController` 知道时间

```bash
cd packages/flutter/lib/src/animation
grep -ln "Ticker\|Simulation\|SchedulerBinding" *.dart
```

**预测**：`Animation` 这个名字暗示它应该与时间有关，那么 `animation.dart` 和 `animations.dart` 里应该会出现时间相关的东西。

**实际**：命中两个文件——`animation.dart` 与 `animation_controller.dart`。但把 `animation.dart` 的命中打出来看：

```bash
grep -n "Ticker" animation.dart
# 93:/// each frame, driven by a [Ticker].
# 106:/// created by a [State] that implements [TickerProvider].
```

两处都在 `///` 文档注释里，**代码路径零使用**。再把这三个词分开验一次：

```bash
grep -ln "SchedulerBinding" *.dart     # 只输出 animation_controller.dart
grep -c "Ticker\|Simulation" animations.dart curves.dart listener_helpers.dart tween.dart tween_sequence.dart
# 每个文件都是 0
```

**说明**：这条命令可以直接当"这层的分层结论"来用。**`Animation` 是值源，不是时间源**；把时间引进来的唯一入口是 `AnimationController` 构造时的 `vsync.createTicker(_tick)`。

### 实验 2：`Animation` 的接口只有 6 个成员

```bash
sed -n '203,255p' packages/flutter/lib/src/animation/animation.dart | grep -n "void \|get "
```

**实际**：`addListener` / `removeListener` / `addStatusListener` / `removeStatusListener` / `status` / `value` 六个，其余都是基于 `status` 计算的派生 getter。

**说明**：接口小是刻意的——正因为它只有"值 + 状态 + 监听"三件事，`Animation` 才能同时被 `AnimationController`（真值源）、`CurvedAnimation`（转发 + 变换）、`AlwaysStoppedAnimation`（常数）实现，而消费者（`FadeTransition`、`SlideTransition`、`AnimatedBuilder`）完全不需要知道背后是哪一个。

### 实验 3：`Curve` 不是 `Animatable`

```bash
grep -n "class Curve extends\|abstract class Animatable" packages/flutter/lib/src/animation/curves.dart packages/flutter/lib/src/animation/tween.dart
```

**预测**：既然 `Curve.transform(double t)` 和 `Animatable.transform(double t)` 长得一样，`Curve` 可能是 `Animatable<double>` 的子类。

**实际**：`animation/curves.dart:75` 是 `abstract class Curve extends ParametricCurve<double>`；`tween.dart:34` 是 `abstract class Animatable<T>`。两者没有任何继承关系。

**说明**：这是一个典型的"鸭子类型巧合"。`Curve` 和 `Animatable` 都能"给定 t 返回值"，但它们的语义不同——`Curve` 有**端点契约**（0→0、1→1）和后向兼容的 `transformInternal` 分层，`Animatable` 没有这些。要在它们之间搭桥，必须有 `CurveTween` 这个适配器（第 22 篇）。**这也是框架里"两个接口长得像但不共用父类"时，通常意味着它们的契约不同**的一个例子。

### 实验 4：`drive(CurveTween)` 与 `CurvedAnimation` 数值等价

```dart
final Animation<double> viaTween = c.drive(CurveTween(curve: Curves.easeIn));
final Animation<double> viaWidget = CurvedAnimation(parent: c, curve: Curves.easeIn);
c.value = 0.5;
debugPrint('${viaTween.value} ${viaWidget.value} ${Curves.easeIn.transform(0.5)}');
```

**实际**（实测输出，`c.value == 0.5` 时）：

```text
0.31640625 0.31640625 0.31640625
```

**说明**：三条路径给出同一个数，但它们的能力不同——`CurvedAnimation` 额外支持**正反向使用不同曲线**（`reverseCurve`，由 `animations.dart:423-425` 的 `_useForwardCurve` 选择），并且会通过 `_updateCurveDirection`（`:419`）记住方向以免中途换向时值跳变；`CurveTween` 只有一个曲线，但它能被 `chain` 到别的 `Animatable` 上（`tween_sequence.dart:26-31` 的文档示例就是这么用的）。**要"曲线"选 `CurveTween`，要"正反向不同曲线"选 `CurvedAnimation`。**

### 实验 5：常数动画的 `status` 是什么

```dart
debugPrint(kAlwaysCompleteAnimation.status.toString());   // AnimationStatus.completed
debugPrint(kAlwaysDismissedAnimation.status.toString());   // AnimationStatus.dismissed
debugPrint(const AlwaysStoppedAnimation<double>(0.5).status.toString()); // AnimationStatus.forward
```

**实际**：三者分别输出 `completed` / `dismissed` / `forward`。

**说明**：`AlwaysStoppedAnimation` 的 `status` 是 `forward` 而不是 `completed`（`animations.dart:117`），尽管它永远停在同一个值上。这是**空对象模式的副作用**：它必须挑一个"不表示结束"的状态，否则依赖 `status == completed` 做收尾逻辑的 widget 会在第一帧就误判动画结束。`kAlwaysCompleteAnimation` 则相反——它就是要伪装成"已完成"。**名字里已经写明了期望的 `status`，选择哪一个取决于你希望消费方怎么理解这个动画。**

## 七、结论

1. `Animation` 的接口只有 6 个成员（4 个监听方法 + `status` + `value`），其中没有时间。整层 8 个文件里只有 `AnimationController` 引用 `Ticker` / `Simulation` / `SchedulerBinding`；其余 7 个文件全部是"给定 `t` 算出值"的纯映射。
2. `Animatable` 是这层的中间货币：`Curve` 经 `CurveTween` 变成 `Animatable<double>`，任何 `Animatable` 经 `animate` / `drive` 变成 `Animation`，`chain` 则在不产生中间 `Animation` 的前提下做函数复合。`Curve` 与 `Animatable` 没有继承关系，只是方法签名巧合。
3. `animation` 层的依赖只有 foundation，加上三条只出现在 `animation_controller.dart` 里的边（physics / scheduler / semantics）。`animation/curves.dart:11` 对 cupertino 的 import 是**纯文档依赖**——代码零使用，仅为解析 `:1491` 的 dartdoc 链接；但它确实构成了一条反向 import 边。

一句话总结：**animation 层是"`t` 的纯函数"集合，`Animation` 是值源而不是时间源——时间的唯一入口是 `AnimationController` 手里的那个 Ticker。**

## 八、边界声明

- 本篇只做分区与接口分层。`AnimationController` 如何把 `elapsed` 变成 `value`，交给第 21 篇；`Curve` 如何进入 `Simulation`，交给第 22 篇。
- `curves.dart` 里 40 余条曲线的具体数学（`Cubic` 的二分求值、`CatmullRomSpline` 的采样、`ThreePointCubic` 的两段拼接）不做逐条讲解，只在第 22 篇用到 `Cubic.transformInternal` 与 `FlippedCurve` 时展开。
- `TrainHoppingAnimation` 的换源条件与 `CompoundAnimation` 的子类族只列锚点，不展开——它们属于"组合动画"的应用层技巧。
- `listener_helpers.dart` 的 `HashedObserverList` / `ObserverList` 是 foundation 的容器，其差异见已有笔记第六篇与 `05 ValueNotifier 与 ObserverList`。
- `animation_style.dart` 只是数据载体（`curve` / `duration` / `reverseCurve` / `reverseDuration` 四个可空字段 + `Diagnosticable`），它的消费者在 material/widgets 层，本系列不展开。
- 本篇只做接口分层与依赖边，不展开动画系统的整体机制。
