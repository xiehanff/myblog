# 45 Scrollable 与 ScrollPosition：滚动位置的真正持有者

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/scrollable.dart`（2553 行）、`scroll_controller.dart`（445 行）、`scroll_position.dart`（1183 行）、`scroll_position_with_single_context.dart`（293 行）、`packages/flutter/lib/src/rendering/viewport_offset.dart`（327 行）

## 一、问题

写业务时最常见的两行代码：

```dart
final ScrollController controller = ScrollController();
// ...
debugPrint('${controller.offset}');
```

`controller.offset` 能读到当前滚动位置，`controller.jumpTo(100)` 能改它。于是最自然的推断是：**滚动位置存在 `ScrollController` 里**。顺着这个推断往下走，会得出两个错误结论——"两个 `ListView` 共用一个 controller 就等于共用一份滚动位置"，以及"controller 不挂在树上时，它的 offset 仍然是上次的值"。

两个都错。`ScrollController` 里**没有任何一个字段表示偏移量**：

```dart
// scroll_controller.dart:72
class ScrollController extends ChangeNotifier {
```

它继承 `ChangeNotifier`，说明它是**广播者**；它持有的是一个列表：

```dart
// scroll_controller.dart:151-156
/// The currently attached positions.
Iterable<ScrollPosition> get positions => _positions;
final List<ScrollPosition> _positions = <ScrollPosition>[];
```

真正的偏移量 `pixels` 是字段存在 `ScrollPosition` 里的：

```dart
// scroll_position.dart:264
double get pixels => _pixels!;
double? _pixels;
```

**关键认知**：这个关系是**一对多**的。一个 `ScrollController` 可以同时挂在 N 个 `ScrollPosition` 上（`_positions` 是个 List），滚动位置有 N 份而不是一份。`ScrollController` 只做三件事：记住初始偏移、把 N 个 position 的变更广播出去、把命令转发给 N 个 position。这就是它继承 `ChangeNotifier` 而不是继承某个"状态对象"的原因。

## 二、最小 Demo

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: TwoLists(),
      ),
    );
  }
}

class TwoLists extends StatefulWidget {
  const TwoLists({super.key});

  @override
  State<TwoLists> createState() => _TwoListsState();
}

class _TwoListsState extends State<TwoLists> {
  // 1. 一个 controller，故意同时喂给两个列表
  final ScrollController controller = ScrollController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        // 2. 两个 Scrollable 各自创建一个 ScrollPosition，挂在同一个 controller 上
        Expanded(
          child: ListView.builder(
            controller: controller,
            itemCount: 1000,
            itemBuilder: (BuildContext context, int index) =>
                ListTile(title: Text('左 $index')),
          ),
        ),
        Expanded(
          child: ListView.builder(
            controller: controller,
            itemCount: 1000,
            itemBuilder: (BuildContext context, int index) =>
                ListTile(title: Text('右 $index')),
          ),
        ),
        // 3. 这里能读到，但 controller 自己并不知道"读的是哪一个"
        TextButton(
          onPressed: () {
            // ignore: avoid_print
            print('positions = ${controller.positions.length}');
            // 4. controller.offset 只在一个 position 时合法，两个会直接断言失败
            controller.jumpTo(200);
          },
          child: const Text('跳转 200'),
        ),
      ],
    );
  }
}
```

跑起来会看到两件事，后面第五节和第六节会逐个解释：

- `positions = 2`——**同一份偏移量概念，实际存了 2 份**；
- 点按钮调 `jumpTo(200)`，两个列表**同时**跳到 200，因为 `jumpTo` 是一个 for 循环（`scroll_controller.dart:230`）。

如果此时去读 `controller.offset`，会在 debug 下抛断言：`ScrollController attached to multiple scroll views.`（`scroll_controller.dart:172`）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/scrollable.dart:121` | `class Scrollable extends StatefulWidget`，滚动行为的 Widget 层入口 |
| `widgets/scrollable.dart:538` | `_ScrollableScope`，把 `ScrollableState` 和 `ScrollPosition` 一起放进 InheritedWidget |
| `widgets/scrollable.dart:560` | `class ScrollableState extends State<Scrollable>`，`ScrollContext` 的实现者 |
| `widgets/scrollable.dart:617` | `void _updatePosition()`，**ScrollPosition 唯一的生产者** |
| `widgets/scrollable.dart:613` | `ScrollController? _fallbackScrollController;`，没传 controller 时框架自己造一个 |
| `widgets/scroll_controller.dart:72` | `class ScrollController extends ChangeNotifier` |
| `widgets/scroll_controller.dart:241` / `252` | `attach` / `detach`，`_positions` 的唯一增删入口 |
| `widgets/scroll_controller.dart:293` | `ScrollPosition createScrollPosition(...)`，子类（如 `PageController`）的定制点 |
| `widgets/scroll_position.dart:189` | `abstract class ScrollPosition extends ViewportOffset with ScrollMetrics` |
| `widgets/scroll_position.dart:366` | `double setPixels(double newPixels)`，偏移量变化的唯一出口 |
| `widgets/scroll_position.dart:1011` | `void beginActivity(ScrollActivity?)`，第 46 篇的主角 |
| `widgets/scroll_position_with_single_context.dart:46` | `ScrollPositionWithSingleContext`，**实际被创建的具体类** |
| `rendering/viewport_offset.dart:100` | `abstract class ViewportOffset extends ChangeNotifier`，viewport 侧看到的接口 |
| `widgets/scroll_metrics.dart:50` | `mixin ScrollMetrics`，只读的度量视图 |

## 四、调用链

### 4.1 谁造出 ScrollPosition：`_updatePosition` 是唯一入口

`ScrollableState` 里只有一个地方会 new 出 position：

```dart
// scrollable.dart:617-635（节选）
void _updatePosition() {
  _configuration = widget.scrollBehavior ?? ScrollConfiguration.of(context);
  _physics = _configuration.getScrollPhysics(context);
  _physics = widget.physics?.applyTo(_physics!) ?? _physics;   // 1. 合并物理
  final ScrollPosition? oldPosition = _position;
  if (oldPosition != null) {
    _effectiveScrollController.detach(oldPosition);            // 2. 先摘
    // 旧 position 不能立刻 dispose，viewport 还要先摘掉它的监听
    scheduleMicrotask(oldPosition.dispose);
  }
  _position = _effectiveScrollController.createScrollPosition(// 3. 再造
      _physics!, this, oldPosition);
  _effectiveScrollController.attach(position);                 // 4. 再挂
}
```

这一段的形状很值得记住，它把三件事写在了同一个方法里：

1. **物理合并**：先取平台默认物理（`_configuration.getScrollPhysics`），再用 widget 上传入的 `physics` 包在外面（`applyTo`）。所以 `physics: BouncingScrollPhysics()` 是在"平台物理之上叠一层"，不是替换。
2. **先摘后挂**：`detach(oldPosition)` → `createScrollPosition(..., oldPosition)` → `attach(newPosition)`。这里传入 `oldPosition` 不是给新 position 看的，是给**构造函数**用的——`ScrollPosition` 的构造函数第一步就是 `absorb(oldPosition)`（`scroll_position.dart:200`），把旧位置的 `pixels`、`activity`、甚至正在进行的 drag 都接力过来。
3. **dispose 延后**：`scheduleMicrotask(oldPosition.dispose)`。源码注释交代了原因——viewport 还没机会解绑它的监听，立刻 dispose 会踩到已释放对象。

`_effectiveScrollController` 这行决定了一个容易忽略的事实：

```dart
// scrollable.dart:589-590
ScrollController get _effectiveScrollController =>
    widget.controller ?? _fallbackScrollController!;
```

而 `_fallbackScrollController` 在 `initState` 里被创建：

```dart
// scrollable.dart:666-671
void initState() {
  if (widget.controller == null) {
    _fallbackScrollController = ScrollController();
  }
  super.initState();
}
```

**关键认知**：`Scrollable` **永远**是通过一个 `ScrollController` 来创建 position 的。即使调用方没传 controller，框架也会临时造一个。所以"用不用 controller"影响的只是"外部能不能拿到位置"，不影响内部结构——`ScrollController` 是 position 的必要上游，不是可选配件。

### 4.2 谁持有位置：`ScrollPosition` 的继承关系

```dart
// scroll_position.dart:189
abstract class ScrollPosition extends ViewportOffset with ScrollMetrics {
```

这一行同时说明了两件事：

```text
ScrollPosition
├─ extends ViewportOffset          （rendering/viewport_offset.dart:100）
│    └─ extends ChangeNotifier     （继承自 foundation）
└─ with ScrollMetrics              （widgets/scroll_metrics.dart:50）
     └─ 只提供 extentBefore / extentInside / extentAfter 等只读计算
```

- **`extends ViewportOffset`** 是"给 viewport 用的那一面"。`RenderViewport.performLayout` 只通过 `offset.applyViewportDimension` / `applyContentDimensions` / `correctBy` 这几个方法跟它对话（`rendering/viewport.dart:1698`、`:1730`），完全不知道 `ScrollPosition` 的存在。
- **`with ScrollMetrics`** 是"给业务和物理用的那一面"。`minScrollExtent` / `maxScrollExtent` / `pixels` / `viewportDimension` 由 `ScrollPosition` 实现，`extentBefore` 这类派生值由 mixin 算出来（`scroll_metrics.dart:125-148`）。

所以 `ScrollPosition` 是一个**双面对象**：向上（viewport）表现为一个"可以校正的偏移量"，向下（controller、physics、业务）表现为"一套完整的滚动度量"。

**关键认知**：`ViewportOffset` 是 `ChangeNotifier`。**滚动导致重绘的根因不在 `ScrollableState.setState`，而在 `ScrollPosition.notifyListeners()`**。`Scrollable` 从 `didChangeDependencies` 到 `dispose` 之间几乎不会因为滚动而 rebuild——viewport 监听的是这个 offset 对象。

### 4.3 谁推动位置：`setPixels` 是唯一出口

不管来源是手指拖动、惯性滑动还是 `animateTo`，改偏移量都汇集到一个方法：

```dart
// scroll_position.dart:366-398（节选）
double setPixels(double newPixels) {
  // 断言：禁止在 build / layout / paint 期间改偏移量
  assert(SchedulerBinding.instance.schedulerPhase != SchedulerPhase.persistentCallbacks, ...);
  if (newPixels != pixels) {
    final double overscroll = applyBoundaryConditions(newPixels);
    final double oldPixels = pixels;
    _pixels = newPixels - overscroll;                 // 1. 越界量被就地扣掉
    if (_pixels != oldPixels) {
      notifyListeners();                              // 2. 通知 viewport 重绘
      didUpdateScrollPositionBy(pixels - oldPixels);  // 3. 发 ScrollUpdateNotification
    }
    if (overscroll.abs() > precisionErrorTolerance) {
      didOverscrollBy(overscroll);                    // 4. 发 OverscrollNotification
      return overscroll;
    }
  }
  return 0.0;
}
```

三个细节：

- **越界量被就地扣掉**：`_pixels = newPixels - overscroll`。`overscroll` 由 `ScrollPhysics.applyBoundaryConditions` 算出（下一节），Clamping 物理下它会等于"越界的那一段"。所以"滚到边缘停住"这个效果不是靠拒绝赋值实现的，是靠**赋值前先减掉越界量**。
- **断言禁止在 layout 期间改偏移量**。注释原话是 "otherwise the rendering will be confused"。这也是为什么 `jumpTo` 必须放在 `postFrameCallback` 或事件回调里，而不能在 `build` 里调。
- **返回的 overscroll 又被 `BallisticScrollActivity` 用了一次**：`applyMoveTo` 判断 `delegate.setPixels(value).abs() < precisionErrorTolerance`（`scroll_activity.dart:634`），非零就 `goIdle()`。

`forcePixels`（`scroll_position.dart:490`）是另一条路：它直接写 `_pixels` 且**不通知任何人**，注释里明确说它只适合"布局期间校正"，且是 `ViewportOffset` 提供给渲染层的后门。

### 4.4 谁读位置：`controller.offset` 是一次转发

```dart
// scroll_controller.dart:170-175
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}

// scroll_controller.dart:179
double get offset => position.pixels;
```

两个断言正好把"一对多"的边界画清楚了：`position` 这个便捷 getter **只在恰好一个 position 时合法**。多于一个不会取第一个，而是直接报错——框架不允许你猜。

反过来，controller 也监听 position：

```dart
// scroll_controller.dart:241-246
void attach(ScrollPosition position) {
  assert(!_positions.contains(position));
  _positions.add(position);
  position.addListener(notifyListeners);   // ← position 变，controller 也变
  onAttach?.call(position);
}
```

**关键认知**：`position.addListener(notifyListeners)` 这一行是"`controller.addListener` 能收到滚动事件"的全部原因。`ScrollController` 自己不产生任何通知，它只是把自己注册成 position 的听众，再把通知原样转出去。这就是上一节说的"广播者"的确切含义。

### 4.5 完整链路：从 `ListView(controller: c)` 到一次滚动通知

```text
ListView(controller: c)
  └─ Scrollable(controller: c)
       └─ ScrollableState.initState()            scrollable.dart:666    c == null ? 造 fallback
       └─ ScrollableState.didChangeDependencies() scrollable.dart:669  → _updatePosition()
            └─ c.createScrollPosition(physics, this, old)  scroll_controller.dart:293
                 └─ new ScrollPositionWithSingleContext(...)  scroll_position_with_single_context.dart:58
                      └─ 构造函数末尾 goIdle()        scroll_position_with_single_context.dart:71
            └─ c.attach(position)                   scroll_controller.dart:241
       └─ build(): _ScrollableScope(position: position, ...)  scrollable.dart:1023
            └─ widget.viewportBuilder(context, position)
                 └─ Viewport(offset: position)      widgets/viewport.dart:65
                      └─ RenderViewportBase.offset  rendering/viewport.dart:528

手指拖动
  └─ RawGestureDetector.onUpdate → _handleDragUpdate      scrollable.dart:881
       └─ _drag.update(details)                            scroll_activity.dart:397
            └─ delegate.applyUserOffset(delta)             scroll_position_with_single_context.dart:129
                 └─ setPixels(pixels - physics.applyPhysicsToUserOffset(this, delta))
                      └─ notifyListeners()                 scroll_position.dart:389
                           ├─ RenderViewport 重绘
                           └─ ScrollController.notifyListeners
                                └─ 业务注册的监听器被调用
```

## 五、核心对象：`ScrollController` vs `ScrollPosition`

| | `ScrollController` | `ScrollPosition` |
|---|---|---|
| 声明位置 | `scroll_controller.dart:72` | `scroll_position.dart:189` |
| 父类 | `ChangeNotifier` | `ViewportOffset`（也是 `ChangeNotifier`）+ `ScrollMetrics` |
| 持有偏移量 | **否** | 是（`_pixels`，`scroll_position.dart:265`） |
| 数量关系 | 1 个 controller → N 个 position | 1 个 position → 1 个 `Scrollable` |
| 谁创建 | 调用方，或 `ScrollableState.initState` 造 fallback | `ScrollController.createScrollPosition` |
| 生命周期 | 由调用方 dispose（或随 `ScrollableState` 一起） | 由 `ScrollableState` 管理，`scheduleMicrotask(dispose)` |
| `dispose` 后行为 | `assert`（`_debugDisposed`） | 被替换时延后一个微任务 |
| 保存/恢复偏移 | 通过 `ScrollPosition` 间接做（`keepScrollOffset`） | 直接做（`saveScrollOffset` / `restoreScrollOffset`） |
| 对外角色 | 命令入口 + 通知出口 | 状态本体 + viewport 的对话对象 |

`ScrollController` 的 API 全部是转发，没有一个是"自己算"的：

| controller 方法 | 实际行为 |
|---|---|
| `jumpTo(v)` | 遍历 `_positions`，逐个 `position.jumpTo(v)` |
| `animateTo(v, ...)` | 遍历 `_positions`，逐个 `position.animateTo(...)`，`Future.wait` 等全部完成 |
| `offset` | `position.pixels`（仅单 position 时合法） |
| `positions` | 直接返回 `_positions` |
| `hasClients` | `_positions.isNotEmpty` |

选择标准只有一句：**需要"从外面下命令 / 听滚动事件"时用 `ScrollController`；需要"读/写当前偏移量与边界"时用 `ScrollPosition`。**

## 六、源码实验

### 实验 1：确认 `ScrollPosition` 不持有在 `ScrollController` 里

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
# 1. controller 里有没有名为 offset/pixels 的字段？
grep -n "double _offset\|double _pixels\|double _position" widgets/scroll_controller.dart

# 2. pixels 字段在哪？
grep -n "double? _pixels" widgets/scroll_position.dart
```

**预测**：如果 controller 是持有者，第 1 条应该命中字段声明。

**实际**：第 1 条**零命中**（`scroll_controller.dart` 里唯一带 `offset` 的私有字段是 `_lastUpdatedOffset`，它只服务于 `_NestedScrollController` 的"记住上一次偏移"，`:405`）。第 2 条命中 `widgets/scroll_position.dart:265`。

**说明**：这是"位置在 position 里"最直接的证据。`_lastUpdatedOffset` 这个例外也值得注意——它是 `ScrollController` 里唯一与数值有关的字段，作用是在多个 position 之间做切换时恢复上一次的值，而不是保存主状态。

### 实验 2：观察 position 的数量与身份

在临时工程里跑下面这段（`LAB` 标记为实测输出）：

```dart
final ScrollController controller = ScrollController();
await tester.pumpWidget(/* ListView.builder(controller: controller, itemCount: 100) */);
print('positions=${controller.positions.length} hasClients=${controller.hasClients}');
print('identical=${identical(controller.position, controller.positions.first)}');
print('runtimeType=${controller.position.runtimeType}');
print('is ViewportOffset=${controller.position is ViewportOffset}');
```

**预测**：`positions.length` 为 1；`runtimeType` 可能是 `ScrollPosition`。

**实际**（实测输出）：

```text
LAB positions=1 hasClients=true
LAB identical=true
LAB runtimeType=ScrollPositionWithSingleContext
LAB isAViewportOffset=true
LAB viewportDimension=600.0 max=4400.0
```

**说明**：第二行说明 `position` 这个 getter 真的是"从 `_positions` 里取"，不是另存一份。第三行是本篇第一个"本地源码与常见说法不一致"的点：**实际被创建的具体类是 `ScrollPositionWithSingleContext`，而它根本不在 `scroll_position.dart` 里**，它单独占一个文件 `scroll_position_with_single_context.dart`（293 行）。很多资料写"ScrollPosition 就是滚动位置"，其实 `ScrollPosition` 是抽象类，`RenderViewport` 真正拿到的是 `ScrollPositionWithSingleContext`，`ScrollActivityDelegate` 的接口就是在它身上实现的（`:46`）。同一个文件里还藏着 `hold`（`:253`）和 `drag`（`:264`）——`Scrollable` 的手势回调就是打到这两个方法上的。

### 实验 3：同一份 widget 重建后，position 是不是同一个对象

```text
LAB after-repump identical=true
LAB after-remove hasClients=false length=0
```

**预测**：每次 `build` 都会 `_updatePosition` 造一个新的，所以应该不同。

**实际**：相同。而 `Scrollable` 被从树上摘掉后，`hasClients` 变 false、`_positions` 变空。

**说明**：预测错了，原因是 `didUpdateWidget` 里有一道闸门：

```dart
// scrollable.dart:727
if (_shouldUpdatePosition(oldWidget)) {
  _updatePosition();
}
```

`_shouldUpdatePosition`（`scrollable.dart:677`）只在"behavior / physics / controller / axisDirection / restorationId 变了"时返回 true。widget 只是被重新 `build` 出来的新实例、而这些字段相等时不重造 position。

**代价与收益**：收益是滚动期间（以及任何父级 rebuild 期间）不会反复创建/销毁 position；代价是 **position 一旦建立就与 `ScrollPositionWithSingleContext` 的具体类型绑死**，运行中换 physics 会走 `absorb` 路径而不是重新构造（这也是 `absorb` 存在的原因）。

### 实验 4：`cacheOrigin` 在偏移量 0 处被压成 0

```text
LAB3 geometry scrollExtent=100000.0 paintExtent=600.0 cacheExtent=850.0
LAB3 constraints scrollOffset=0.0 remainingCacheExtent=850.0 cacheOrigin=0.0
```

**说明**：viewport 高 600，默认 `cacheExtent` 是 250（`rendering/viewport.dart:289` 的 `defaultCacheExtent`）。但实测 `remainingCacheExtent` 是 **850** 而不是 1100——因为 `cacheOrigin` 被压成了 0。源码里的规则写在 `rendering/sliver.dart:413-415`：

> The [cacheOrigin] is always negative or zero and will never exceed -[scrollOffset]. In other words, a sliver is never asked to provide content before its zero [scrollOffset].

翻译过来就是：**列表顶部不会往上预建内容**。所以 250 的 cache extent 在顶部只在"向下方向"生效，实际可建范围是 600 + 250 = 850。这一条在第 48 篇会作为"懒加载到底建多少个 child"的输入值再算一次。

## 七、结论

1. `ScrollController` **不持有**滚动位置，它只持有 `List<ScrollPosition> _positions`，并在 `attach` 时把自己注册成每个 position 的监听器（`scroll_controller.dart:244`）。真正的偏移量字段是 `ScrollPosition._pixels`（`scroll_position.dart:265`）。
2. 一个 controller 可以同时挂 N 个 position。`controller.offset` 在 N>1 时**直接断言失败**而不是取第一个（`scroll_controller.dart:172`），`controller.jumpTo` 则是遍历全部并逐个执行。
3. `ScrollableState._updatePosition` 是 position 的唯一生产者，且做到"先 `detach` 旧位置 → 用 `oldPosition` 构造新位置（构造时 `absorb`）→ `attach` 新位置 → 旧位置延后一个微任务 `dispose`"。跑通了这条链，就理解了滚动位置为什么能跨 rebuild、跨 widget 替换地延续下来。

一句话总结：**`ScrollController` 是滚动位置的广播站和指挥部，位置的居民是 `ScrollPosition`（运行时具体类型 `ScrollPositionWithSingleContext`）。**

## 八、边界声明

- 本篇只讲"谁持有位置、怎么创建、怎么转发"。**`pixels` 怎么衰减、用户松手后发生什么，是第 46 篇**（`ScrollActivity` 与 `ScrollPhysics`）。
- `applyViewportDimension` / `applyContentDimensions` 在 viewport 里被谁调用、`SliverConstraints` 怎么组装，是第 47 篇。
- `ScrollNotification` 家族的完整分发规则（`didStartScroll` / `didUpdateScrollPositionBy` / `didEndScroll`）与 `NotificationListener` 的关系，本系列不单独展开。
- 二维滚动（`TwoDimensionalScrollable`、`TwoDimensionalViewport`）在同文件的后半段（`scrollable.dart:1600+`），本篇不展开。
- `PageController` / `FixedExtentScrollController` 是对 `createScrollPosition`（`scroll_controller.dart:293`）的覆写，属于同一机制的应用。
- `Scrollable.ensureVisible`、`RenderAbstractViewport.getOffsetToReveal` 属于"反向求偏移量"，留给第 47 篇的 viewport 部分。
