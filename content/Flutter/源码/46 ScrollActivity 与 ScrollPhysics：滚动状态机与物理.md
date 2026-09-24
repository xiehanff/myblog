# 46 ScrollActivity 与 ScrollPhysics：滚动状态机与物理

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/scroll_activity.dart`（810 行）、`scroll_physics.dart`（983 行）、`scroll_simulation.dart`、`scroll_position_with_single_context.dart`（293 行）

## 一、问题

观测一次滚动，会看到一个说不通的现象：手指抬起之后，列表还会继续滑一段并慢慢停住。**这段时间没有人在调 `jumpTo`**。

第一次读源码时的直觉是"physics 就是驱动者"：既然是物理决定滑多远，那大概是 physics 每一帧算出一个新位置。顺着这个直觉去读 `ScrollPhysics`，会发现它根本没有"帧"的概念——没有 `tick`、没有 `Timer`、没有 `AnimationController`：

```dart
// scroll_physics.dart:88-89
class ScrollPhysics {
  const ScrollPhysics({this.parent});
```

它的方法全是**纯函数**，吃进状态、吐出参数：

```dart
Simulation? createBallisticSimulation(ScrollMetrics position, double velocity); // :407
double applyBoundaryConditions(ScrollMetrics position, double value);            // :308
double applyPhysicsToUserOffset(ScrollMetrics position, double offset);          // :204
```

真正"逐帧驱动"的是另一个东西——`ScrollActivity`。它持有 `AnimationController`：

```dart
// scroll_activity.dart:584-603（节选）
class BallisticScrollActivity extends ScrollActivity {
  BallisticScrollActivity(super.delegate, Simulation simulation, TickerProvider vsync, this.shouldIgnorePointer) {
    _controller = AnimationController.unbounded(...)
      ..addListener(_tick)              // ← 每帧回调
      ..animateWith(simulation)          // ← physics 的产物在这里被执行
        .whenComplete(_end);             // ← 结束后再问一次 physics
  }
```

`ScrollActivity` 与 `ScrollPhysics` 的分工是：**`ScrollActivity` 回答"现在处于什么状态、谁来推这个帧"，`ScrollPhysics` 回答"在这个状态下，给定速度和位置，下一段轨迹应该是什么"**。一个是有状态的驱动器，一个是无状态的参数工厂。把它们混为一谈，是读滚动源码时最常出的错。

## 二、最小 Demo

两个能直接看出分工的用法。

### 2.1 自定义 physics：只做"松手后怎么衰减"

```dart
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';

/// 松手后衰减得更快：保留所有边界行为，只改摩擦力。
class FastFrictionScrollPhysics extends ScrollPhysics {
  const FastFrictionScrollPhysics({super.parent});

  // 1. applyTo 是框架拼装物理链的唯一入口，必须实现
  @override
  FastFrictionScrollPhysics applyTo(ScrollPhysics? ancestor) {
    return FastFrictionScrollPhysics(parent: buildParent(ancestor));
  }

  // 2. 只覆写"惯性衰减"这一段：给定初速度，给出一个 Simulation
  @override
  Simulation? createBallisticSimulation(ScrollMetrics position, double velocity) {
    // 3. 越界或速度足够大时，才需要交给 physics
    if (position.outOfRange) {
      return super.createBallisticSimulation(position, velocity);
    }
    final Tolerance tolerance = toleranceFor(position);
    if (velocity.abs() < tolerance.velocity) {
      return null; // 4. 返回 null 表示"立刻静止"，调用方会 goIdle()
    }
    return FrictionSimulation(0.2, position.pixels, velocity, tolerance: tolerance);
  }
}

// 用法：
// ListView.builder(physics: const FastFrictionScrollPhysics(), ...)
```

`FrictionSimulation` 来自 `physics/friction_simulation.dart:35`。注意这段代码里**没有一个地方需要"每帧调用"**——它只是把"初速度"映射成"一条可求值的曲线"，逐帧求值由 `BallisticScrollActivity` 做。

### 2.2 观察 activity 的运行时类型

```dart
final ScrollableState state = Scrollable.of(context)!;
// activity 是 @visibleForTesting 的，测试里可以直接读
debugPrint('${state.position.activity.runtimeType}');
debugPrint('${state.position.isScrollingNotifier.value}');
```

第六节的实验就是靠这一行把状态机的每次切换打出来的。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/scroll_activity.dart:35` | `abstract class ScrollActivityDelegate`，activity 与 position 之间的唯一接口（5 个方法） |
| `widgets/scroll_activity.dart:67` | `abstract class ScrollActivity`，状态基类 |
| `widgets/scroll_activity.dart:181` | `IdleScrollActivity`，什么也不做，`isScrolling = false` |
| `widgets/scroll_activity.dart:221` | `HoldScrollActivity`，按住但未成拖拽 |
| `widgets/scroll_activity.dart:256` | `ScrollDragController implements Drag`，拖拽的实际执行者 |
| `widgets/scroll_activity.dart:476` | `DragScrollActivity`，拖拽期间的状态 |
| `widgets/scroll_activity.dart:584` | `BallisticScrollActivity`，持有 `AnimationController`，逐帧驱动之一（`goBallistic` 且 physics 给出非 null `Simulation` 时进入，惯性/弹回走它） |
| `widgets/scroll_activity.dart:695` | `DrivenScrollActivity`，被 `animateTo` 使用，另一个逐帧驱动的 activity（内部同样是 `AnimationController.unbounded` + ticker，`:708`） |
| `widgets/scroll_physics.dart:88` | `class ScrollPhysics`，无状态参数工厂 |
| `widgets/scroll_physics.dart:127` | `ScrollPhysics? buildParent(ScrollPhysics? ancestor)` |
| `widgets/scroll_physics.dart:186` | `ScrollPhysics applyTo(ScrollPhysics? ancestor)` |
| `widgets/scroll_physics.dart:204` | `applyPhysicsToUserOffset`，手指拖动时的位移变换 |
| `widgets/scroll_physics.dart:308` | `applyBoundaryConditions`，越界量的唯一算法 |
| `widgets/scroll_physics.dart:407` | `createBallisticSimulation`，状态 → 轨迹的转换点 |
| `widgets/scroll_physics.dart:678` / `836` | `BouncingScrollPhysics` / `ClampingScrollPhysics` |
| `widgets/scroll_configuration.dart:243` | `ScrollBehavior.getScrollPhysics`，平台默认物理的出口 |
| `widgets/scroll_position_with_single_context.dart:135` / `149` | `goIdle` / `goBallistic`，状态机的主要入口 |

## 四、调用链

### 4.1 `ScrollActivityDelegate`：activity 只认识 5 个方法

```dart
// scroll_activity.dart:35-55（节选）
abstract class ScrollActivityDelegate {
  AxisDirection get axisDirection;
  double setPixels(double pixels);      // 写入位置，返回未消化的越界量
  void applyUserOffset(double delta);   // 用户手势造成的位移（会过 physics）
  void goIdle();                        // 结束当前 activity
  void goBallistic(double velocity);    // 以给定速度进入惯性阶段
}
```

这 5 个方法就是"滚动状态机"的全部能力边界。注意**这里没有 `physics`、没有 `AnimationController`、没有 `TickerProvider`**——activity 完全不知道物理是什么，它只会在需要时喊一声 `goBallistic(velocity)`。反过来，`ScrollPosition` 也不需要知道 activity 内部用什么驱动。

实现这个接口的是 `ScrollPositionWithSingleContext`：

```dart
// scroll_position_with_single_context.dart:46
class ScrollPositionWithSingleContext extends ScrollPosition implements ScrollActivityDelegate {
```

`ScrollActivityDelegate` 的存在让"状态机"和"位置存储"解耦。第 45 篇里 `ScrollableState._position` 的类型是 `ScrollPosition`，但手势回调打到的 `hold` / `drag` 只在 `ScrollPositionWithSingleContext` 上有实现——这也是为什么实际被创建的类永远是它。

### 4.2 状态机的六个状态与切换条件

| 状态 | 何时进入 | `isScrolling` | `velocity` 来源 |
|---|---|---|---|
| `IdleScrollActivity` | 初始、任何活动结束 | false | 0 |
| `HoldScrollActivity` | 指针按下、拖拽还没被竞技场裁决 | false | 0 |
| `DragScrollActivity` | 拖拽被手势竞技场接受 | true | `ScrollDragController.velocity` |
| `BallisticScrollActivity` | `goBallistic(v)` 且 physics 返回了非 null 的 `Simulation` | true | `_controller.velocity` |
| `DrivenScrollActivity` | `animateTo` | true | 由 `Curve` + duration 派生 |
| （`ScrollDragController`） | 不是 `ScrollActivity`，是 `Drag` 实现，被 `DragScrollActivity` 持有 | — | — |

状态的切换**只发生在一个方法里**：

```dart
// scroll_position.dart:1011-1037（节选）
void beginActivity(ScrollActivity? newActivity) {
  if (newActivity == null) {
    return;                    // 传 null 是"不做任何事"，不是"变成 idle"
  }
  if (_activity != null) {
    oldIgnorePointer = _activity!.shouldIgnorePointer;
    wasScrolling = _activity!.isScrolling;
    if (wasScrolling && !newActivity.isScrolling) {
      didEndScroll();          // 发 ScrollEndNotification
    }
    _activity!.dispose();      // 1. 旧 activity 一定被 dispose
  }
  _activity = newActivity;
  isScrollingNotifier.value = activity!.isScrolling;   // 2. 状态公布
  if (!wasScrolling && _activity!.isScrolling) {
    didStartScroll();              // 3. 只按 isScrolling 的边沿发 start
  }
}
```

四个要点：

1. **`ScrollStartNotification` / `ScrollEndNotification` 不是按状态发的，是按 `isScrolling` 的边沿发的。** `Idle → Hold` 不会发 start（两个都是 `isScrolling = false`），`Hold → Drag` 才会发。
2. `shouldIgnorePointer` 决定要不要给滚动内容套一层 `IgnorePointer`。`BallisticScrollActivity` 的构造参数就是它（`scroll_activity.dart:594`），`IdleScrollActivity` 和 `HoldScrollActivity` 都返回 false（`:191`、`:230`）。
3. 旧 activity **无条件 `dispose`**。所以自定义 activity 一定要实现 `dispose` 并在里面释放自己持有的 `AnimationController`。
4. 注释里那句"If the argument is null, this method has no effect"很关键——**`goIdle()` 不是 `beginActivity(null)`**，它是一个显式构造：

```dart
// scroll_position_with_single_context.dart:135-137
void goIdle() {
  beginActivity(IdleScrollActivity(this));
}
```

### 4.3 一次拖拽的完整生命周期

```text
① 指针按下
   RawGestureDetector.onDown → ScrollableState._handleDragDown     scrollable.dart:862-865
     └─ _hold = position.hold(_disposeHold)                        scrollable.dart:865
          └─ spsc.hold() → beginActivity(HoldScrollActivity(...))  scroll_position_with_single_context.dart:253

② 拖拽被手势竞技场接受
   ScrollableState._handleDragStart                                scrollable.dart:868
     └─ _drag = position.drag(details, _disposeDrag)               scrollable.dart:873
     └─ if (_hold != null) _disposeHold();                          scrollable.dart:877
          └─ spsc.drag() → beginActivity(DragScrollActivity(...))  scroll_position_with_single_context.dart:264

③ 每次移动
   ScrollableState._handleDragUpdate                                scrollable.dart:881
     └─ _drag.update(details)                                      scroll_activity.dart:397
          └─ delegate.applyUserOffset(delta)                       scroll_position_with_single_context.dart:129
               ├─ updateUserScrollDirection(delta > 0 ? forward : reverse)
               └─ setPixels(pixels - physics.applyPhysicsToUserOffset(this, delta))

④ 松手
   ScrollableState._handleDragEnd                                   scrollable.dart:887
     └─ _drag.end(details)
          └─ delegate.goBallistic(velocity)                        scroll_position_with_single_context.dart:149
               ├─ physics.createBallisticSimulation(this, velocity)
               ├─ simulation != null → beginActivity(BallisticScrollActivity(...))
               └─ simulation == null → goIdle()
```

第 ③ 步有一个容易读错的地方：

```dart
// scroll_position_with_single_context.dart:129-132
void applyUserOffset(double delta) {
  updateUserScrollDirection(delta > 0.0 ? ScrollDirection.forward : ScrollDirection.reverse);
  setPixels(pixels - physics.applyPhysicsToUserOffset(this, delta));
}
```

注意是 `pixels - ...`：手势的 `delta` 与滚动偏移量的方向**相反**（往下拖，内容往下走，偏移量减小）。`applyPhysicsToUserOffset` 的默认实现还会在越界时压缩位移（往下拖过头时越拖越"硬"），这是"橡皮筋阻尼"的来源之一：

```dart
// scroll_physics.dart:204-216（节选）
double applyPhysicsToUserOffset(ScrollMetrics position, double offset) {
  if (!position.outOfRange) {
    return offset;
  }
  ... // 越界时按位置与边界距离做非线性压缩
}
```

### 4.4 `goBallistic`：两个对象在这里交接

```dart
// scroll_position_with_single_context.dart:149-158
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

这一共 8 行是整篇的核心。它把三件事按顺序串起来：

1. **问 physics 要轨迹**：`createBallisticSimulation(this, velocity)`。`this` 是 `ScrollPosition`，它 `with ScrollMetrics`，所以 physics 能读到 `pixels` / `minScrollExtent` / `maxScrollExtent` / `outOfRange`。**physics 是只读的**，它改不了位置。
2. **把轨迹交给 activity 执行**：`BallisticScrollActivity(this, simulation, context.vsync, ...)`。`context.vsync` 来自 `ScrollableState`（它 `with TickerProviderStateMixin`），`AnimationController.unbounded` 用它申请帧。
3. **null 表示"立刻静止"**（physics 的显式结论，而非"没算出来"）：速度低于 `tolerance.velocity`、或者已经贴边且朝边外滑，都返回 null（`scroll_physics.dart:911`、`:914`、`:917`）。基类 `ScrollPhysics.createBallisticSimulation`（`:407-409`）本身只做一件事：`return parent?.createBallisticSimulation(position, velocity);`——**链尾没有 parent 时它自然返回 null**。返回 null 就走 `goIdle()`，状态直接收敛。

`BallisticScrollActivity` 的每帧只做一件事：

```dart
// scroll_activity.dart:619-641（节选）
void _tick() {
  if (!applyMoveTo(_controller.value)) {
    delegate.goIdle();        // 有越界量没消化掉 → 状态机回到 idle
  }
}

bool applyMoveTo(double value) => delegate.setPixels(value).abs() < precisionErrorTolerance;

void _end() {
  if (!_isDisposed) {
    delegate.goBallistic(0.0); // 动画结束再问一次 physics，避免停在越界位置
  }
}
```

`_end()` 里的 `goBallistic(0.0)` 是一个**闭环**：动画跑完 → 以速度 0 再问一次 physics → 如果还在越界位置，physics 会返回一个弹回边界的 `ScrollSpringSimulation` → 又产生一个新的 `BallisticScrollActivity`。这就是"越界后弹回来"不需要任何专门代码的原因。

### 4.5 `applyBoundaryConditions`：越界量到底怎么算

```dart
// scroll_physics.dart:847-874（ClampingScrollPhysics，节选）
double applyBoundaryConditions(ScrollMetrics position, double value) {
  if (value < position.pixels && position.pixels <= position.minScrollExtent) {
    return value - position.pixels;            // Underscroll
  }
  if (position.maxScrollExtent <= position.pixels && position.pixels < value) {
    return value - position.pixels;            // Overscroll
  }
  if (value < position.minScrollExtent && position.minScrollExtent < position.pixels) {
    return value - position.minScrollExtent;   // Hit top edge
  }
  if (position.pixels < position.maxScrollExtent && position.maxScrollExtent < value) {
    return value - position.maxScrollExtent;   // Hit bottom edge
  }
  return 0.0;                                  // 完全在范围内
}
```

返回值是"必须被丢掉的那部分位移"。回到第 45 篇那行 `_pixels = newPixels - overscroll`（`scroll_position.dart:387`），就能算出 Clamping 的语义：**`applyBoundaryConditions` 返回的正好是越界的全部量，所以 `_pixels` 被钉在边界上，一点都动不了**。

Bouncing 覆盖了它：

```dart
// scroll_physics.dart:751
double applyBoundaryConditions(ScrollMetrics position, double value) => 0.0;
```

返回恒为 0，等于"从不丢弃位移"——**越界量被完整写进 `_pixels`**。这是 iOS 越界回弹的全部秘密：不是靠额外的状态，只是把边界检查关掉，然后让 `createBallisticSimulation` 在 `position.outOfRange` 时返回弹簧。

`applyBoundaryConditions` 的返回值有两个含义，名称上是"越界量"，实际用法上是"需要忽略的位移量"。两种物理的差异全在这一处：Clamping 返回真实越界量（吞掉），Bouncing 返回 0（不吞）。

### 4.6 physics 的组合：`parent` 是一条链，不是一棵树

```dart
// scroll_physics.dart:127
ScrollPhysics? buildParent(ScrollPhysics? ancestor) => parent?.applyTo(ancestor) ?? ancestor;
```

每个子类的 `applyTo` 都长一个样：

```dart
// scroll_physics.dart:842-845
ClampingScrollPhysics applyTo(ScrollPhysics? ancestor) {
  return ClampingScrollPhysics(parent: buildParent(ancestor));
}
```

于是"平台默认 + widget 覆写"是这样叠起来的（对应 `scrollable.dart:619-623`）：

```text
widget.physics.applyTo( 平台默认 )
  → 例：FastFrictionScrollPhysics(parent: ClampingScrollPhysics(parent: RangeMaintainingScrollPhysics()))
```

查找规则是**外层优先、逐级下探**：每个方法的默认实现末尾都写

```dart
return parent!.xxx(...);   // 自己没有定制时，交给 parent
```

平台默认值在 `ScrollConfiguration.getScrollPhysics`：

```dart
// scroll_configuration.dart:243-256（节选）
ScrollPhysics getScrollPhysics(BuildContext context) {
  switch (getPlatform(context)) {
    case TargetPlatform.iOS:    return _bouncingPhysics;
    case TargetPlatform.macOS:  return _bouncingDesktopPhysics;
    case TargetPlatform.android:
    case TargetPlatform.fuchsia:
    case TargetPlatform.linux:
    case TargetPlatform.windows: return _clampingPhysics;
  }
}
```

三个常量都是"Bouncing/Clamping 包一层 RangeMaintaining"：

```dart
// scroll_configuration.dart:227-236
static const ScrollPhysics _bouncingPhysics = BouncingScrollPhysics(
  parent: RangeMaintainingScrollPhysics(),
);
static const ScrollPhysics _bouncingDesktopPhysics = BouncingScrollPhysics(
  decelerationRate: ScrollDecelerationRate.fast,
  parent: RangeMaintainingScrollPhysics(),
);
static const ScrollPhysics _clampingPhysics = ClampingScrollPhysics(
  parent: RangeMaintainingScrollPhysics(),
);
```

`RangeMaintainingScrollPhysics`（`:567`）是那个"内容变长时把偏移量顶住"的角色：它覆写 `adjustPositionForNewDimensions`（`:577`），在 `applyContentDimensions` 期间决定要不要调用 `correctPixels`。

## 五、核心对象：`ScrollActivity` vs `ScrollPhysics`

| | `ScrollActivity` | `ScrollPhysics` |
|---|---|---|
| 声明位置 | `scroll_activity.dart:67` | `scroll_physics.dart:88` |
| 有状态吗 | 有（`_controller`、`_isDisposed`、`_delegate`） | **无状态**，`const` 构造 |
| 是否需要 vsync | 需要（`BallisticScrollActivity` / `DrivenScrollActivity` 要 `TickerProvider`） | 不需要 |
| 是否逐帧 | 是（`AnimationController.addListener`） | 否（纯函数，调用即返回） |
| 能否改位置 | 能（通过 `delegate.setPixels`） | **不能**，只能读 `ScrollMetrics` |
| 主要输入 | `delegate` + `Simulation` / `Curve` | `ScrollMetrics` + `velocity` |
| 主要输出 | `setPixels` 调用、`isScrolling`、`velocity` | `Simulation?`、`double`（越界量 / 变换后位移） |
| 生命周期 | 每次状态切换都换新并 `dispose` | 随 widget 配置存在，长期复用（`const` 实例） |
| 数量关系 | 任一时刻恰好 1 个 | 一条 `parent` 链，链上每个节点都可能被问一次 |

选择标准：**要"滚动过程本身的行为"改 `ScrollActivity`（少见）；要"松手后怎么衰减、越界怎么处理"改 `ScrollPhysics`（常见）。**

### Clamping vs Bouncing 的行为对照

| | `ClampingScrollPhysics`（`:836`） | `BouncingScrollPhysics`（`:678`） |
|---|---|---|
| `applyBoundaryConditions` | 返回真实越界量（`:847`，被 `setPixels` 扣掉） | 恒返回 0（`:751`，越界量全部写进 `pixels`） |
| 越界时 `createBallisticSimulation` | `ScrollSpringSimulation` 弹回边界（`:892-910`） | `BouncingScrollSimulation`（`:754`） |
| 边界外静止 | 不可能（`pixels` 被钉住） | 可能（`outOfRange` 为 true） |
| 惯性段 Simulation | `ClampingScrollSimulation`（`scroll_simulation.dart:164`） | `BouncingScrollSimulation`（`scroll_simulation.dart:18`） |
| 触发 fling 的速度门槛 | `kMinFlingVelocity` | `kMinFlingVelocity * 2.0`（`:777`） |
| 桌面差异 | 所有平台共用 | macOS 走 `decelerationRate: fast`（`:689`） |

## 六、源码实验

### 实验 1：把状态机的每次切换打出来

在临时工程里对 `ScrollableState.position.activity` 取 `runtimeType`（`activity` 是 `@visibleForTesting`，测试里可直接访问）。

**实际**：

```text
LAB9 idle=IdleScrollActivity isScrolling=false dir=ScrollDirection.idle
LAB9 afterDown=DragScrollActivity isScrolling=true
LAB9 dragging=DragScrollActivity isScrolling=true pixels=60.0 dir=ScrollDirection.reverse
LAB9 afterUp=IdleScrollActivity
LAB9 settled=IdleScrollActivity pixels=60.0
```

**说明**：两点与预测不同。

第一，`afterDown` 不是 `HoldScrollActivity` 而是 `DragScrollActivity`。原因是手势竞技场：测试里只有一个拖拽识别器，没有竞争者，指针按下时竞技场立刻裁决并通过，`onStart` 与 `onDown` 几乎同时发出，`_handleDragStart` 里的 `_disposeHold()`（`scrollable.dart:877`）把刚建立的 Hold 顶掉了。真实 App 里如果有横向 `PageView` 或 `TabBarView` 在竞争，Hold 状态会持续几帧直到裁决完成——**Hold 是"还没决定要不要滚"，不是"按住不动"**。

第二，`afterUp` 直接是 `IdleScrollActivity` 而不是 `BallisticScrollActivity`。因为这是 `moveBy` 的慢速拖动，松手速度低于 `tolerance.velocity`，`createBallisticSimulation` 返回 null（`scroll_physics.dart:911-912`），于是 `goBallistic` 走了 `goIdle()` 分支。**"松手即停"和"松手后滑一段"是同一个方法的两条分支，差别只在 velocity。**

### 实验 2：`jumpTo` 与 `animateTo` 落到的状态

```text
LAB10 afterJumpTo=IdleScrollActivity pixels=500.0
LAB10 animating=DrivenScrollActivity
LAB10 afterAnim=IdleScrollActivity pixels=900.0
```

**说明**：`jumpTo` 的实现（`scroll_position_with_single_context.dart:197`）是 `goIdle()` → `forcePixels` → `goBallistic(0.0)`，所以状态上它是"idle → idle"，**不产生 `BallisticScrollActivity`**。`animateTo`（`scroll_position_with_single_context.dart:177`）建成 `DrivenScrollActivity`，动画结束后 `_end()` 里的 `goBallistic(0.0)` 同样返回 null 而落到 idle。

源码里还有一条与直觉冲突的注释（`scroll_activity.dart:688-690`）：

> Unlike a [BallisticScrollActivity], if a [DrivenScrollActivity] is in progress when the scroll metrics change, the activity will continue with its original animation.

`animateTo` **不理会**布局变化，`BallisticScrollActivity` 则会（`applyNewDimensions` 重跑 `goBallistic`，`scroll_activity.dart:615-616`）。这是两者最实质的区别。

### 实验 3：同一段越界手势，两种物理的数字

在列表顶部往下拖 120 像素：

```text
LAB11 ClampingScrollPhysics physicsType=ClampingScrollPhysics
LAB11 ClampingScrollPhysics overPixels=0.0
LAB11 ClampingScrollPhysics afterUp=IdleScrollActivity
LAB11 BouncingScrollPhysics physicsType=BouncingScrollPhysics
LAB11 BouncingScrollPhysics overPixels=-120.0
LAB11 BouncingScrollPhysics afterUp=BallisticScrollActivity
```

**说明**：这一组数字把 4.5 节的两行源码坐实了。

- Clamping：`pixels` 停在 **0.0**——120 像素位移被 `applyBoundaryConditions` 全额返回、被 `setPixels` 全额扣掉。松手后甚至没有进入 ballistic，因为位置没有越界、速度又低。
- Bouncing：`pixels = -120.0`——负号是因为"往下拖 = 偏移量减小"，且 120 像素**一点没丢**（`applyBoundaryConditions` 恒返回 0）。松手后立刻是 `BallisticScrollActivity`，由 `BouncingScrollSimulation` 弹回 0。

**代价与收益**：Clamping 的代价是"边界处手感和物理世界不一致"（位移被吃掉，手指在动但内容不动），收益是永不需要弹簧、永不会停在越界位置。Bouncing 反过来——内容忠实跟随手指，代价是引入了"可能长期停留在越界位置"这个状态，所有下游（`outOfRange`、`extentBefore/After` 可能为负、`cacheOrigin`）都必须容忍它。

### 实验 4：确认 physics 家族在源码里的分布

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn "extends ScrollPhysics\b" --include="*.dart" .
```

**实际**：`widgets/scroll_physics.dart` 里有 5 个公开子类（`RangeMaintainingScrollPhysics:567`、`BouncingScrollPhysics:678`、`ClampingScrollPhysics:836`、`AlwaysScrollableScrollPhysics:946`、`NeverScrollableScrollPhysics:969`），另有 4 个散落在别处：`FixedExtentScrollPhysics`（`list_wheel_scroll_view.dart:479`）、`PageScrollPhysics`（`page_view.dart:564`）、`CarouselScrollPhysics`（`material/carousel.dart:1501`）、`_NeverUserScrollableScrollPhysics`（`editable_text.dart:6174`）。

**说明**：`PageScrollPhysics` 与 `CarouselScrollPhysics` 正是 4.6 节那条 `parent` 链的实际使用者——它们把"翻页吸附"这个行为插在平台物理**之前**，平台的越界行为仍然生效。这也是为什么 `parent` 链要按"外层优先、逐级下探"来设计，而不是做成一个可替换的单值。

## 七、结论

1. `ScrollActivity` 是**有状态、需要 vsync、逐帧驱动**的那一层；`ScrollPhysics` 是**无状态纯函数**，只把"位置 + 速度"映射成 `Simulation` 或一个数值。逐帧驱动的 activity 有两个：`BallisticScrollActivity`（`scroll_activity.dart:584`，由 `goBallistic(v)` 且 physics 返回非 null `Simulation` 时进入——松手惯性、越界弹回走它）和 `DrivenScrollActivity`（`:695`，由 `animateTo` 进入）；两者内部都是 `AnimationController.unbounded` + ticker 逐帧求值（`:597`、`:708`）。其余 activity 不自驱逐帧：Idle/Hold 静止，DragScrollActivity 由指针事件驱动。
2. 状态切换只有一个入口：`ScrollPosition.beginActivity`（`scroll_position.dart:1011`）。`ScrollStartNotification` / `ScrollEndNotification` 按 `isScrolling` 的**边沿**发出，不按具体状态发；传 `null` 是"什么都不做"，`goIdle()` 才是"变成 idle"。
3. 两种平台物理的差异集中在 `applyBoundaryConditions` 的一处返回值：Clamping 返回真实越界量（`scroll_physics.dart:847`，位移被吞掉，`pixels` 被钉在边界），Bouncing 恒返回 0（`:751`，位移全进 `pixels`，靠 `outOfRange` 时的弹簧 Simulation 收回）。

**Activity 管"现在在做什么"，Physics 管"松手后该往哪走"；前者要帧，后者只要一次调用。**

## 八、边界声明

- `ClampingScrollSimulation` / `BouncingScrollSimulation` 的**数值积分与摩擦公式**不在这里展开，它是第 2 卷篇 09（`09 一次抛滑的数值过程：ClampingScrollSimulation 与 SpringSimulation.md`）的内容。本文只说明"physics 产出 Simulation、activity 执行 Simulation"这个交界，涉及的类声明位置是 `physics/friction_simulation.dart:35`、`physics/spring_simulation.dart:204`、`physics/spring_simulation.dart:271`（`ScrollSpringSimulation`）。
- 手势竞技场如何裁决出 `DragStart`、`touch slop` 从哪来，属于第 6 卷 `gestures` 层；本文只从 `ScrollableState._handleDragDown` 开始追。
- `ScrollNotification` 家族的完整字段与冒泡规则、`NotificationListener` 的定位，这个系列不单独展开。
- `NestedScrollView` 如何用 `_NestedScrollCoordinator` 代理多个 position 的 activity，本文不展开。
- `DraggableScrollableSheet` 里的 `ClampingScrollSimulation` 用法（`draggable_scrollable_sheet.dart:962`）属于同一机制的复用，不展开。
