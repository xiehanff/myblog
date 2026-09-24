# 56 NestedScrollView：内外两套 ScrollPosition 的协调

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/nested_scroll_view.dart`（2081 行）；本文另引用 `packages/flutter/lib/src/rendering/sliver_persistent_header.dart`、`packages/flutter/lib/src/rendering/sliver_fill.dart`

## 一、问题

一句话问题：一次手指拖动，为什么能让"外层 Header 折叠"和"内层列表滚动"这两件看起来分属两个控件的事同时发生？

最自然的错误直觉是**事件冒泡**：`NestedScrollView` 里套了一个 `ListView`，`ListView` 滚到头之后，多余的滚动事件往上冒给外层 `ScrollView`。顺着这个直觉会得出三个错误推论：

1. inner 是 outer 的"子滚动组件"，两者存在父子关系；
2. 只有 inner 到达边界时，outer 才会动；
3. 谁在滚动可以用"事件传到了谁"来判断。

三条都错。真实模型是：**`NestedScrollView` 只创建了一个外层 viewport，body 中每个 `Scrollable` 都会有自己的 `ScrollPosition`，但只有实际继承并 attach 到 NestedScrollView 注入的 innerController 的 position 才进入 coordinator 的 innerPositions（常见的是 body 中未显式指定 controller 的纵向 primary `Scrollable`）；`_NestedScrollCoordinator` 同时持有 outer 与这组 inner position，把用户手势的 `delta` 在它们之间分配。** 整个文件里没有任何"把滚动通知往上冒"的机制，分配由 coordinator 在**每次拖动更新回调**中主动完成，惯性阶段则交给 ballistic activity 的逐帧回调继续驱动坐标换算。

```dart
// nested_scroll_view.dart:614
class _NestedScrollCoordinator implements ScrollActivityDelegate, ScrollHoldController {
```

注意这个 `implements`：coordinator **自己就是** `ScrollActivityDelegate`。第 46 篇里 `ScrollDragController` 的 `delegate` 会拿到 `applyUserOffset`，在普通的 `Scrollable` 里这个 delegate 是 position（`ScrollPositionWithSingleContext`）；在 `NestedScrollView` 里它被换成了 coordinator。手势识别器根本没换，换的是"谁接这个 delta"。

而两套位置仍然是第 45 篇的结论：居民是 `ScrollPosition`，这次的具体类型是：

```dart
// nested_scroll_view.dart:1203
class _NestedScrollPosition extends ScrollPosition implements ScrollActivityDelegate {
```

**关键认知**：这里存在 **1 个 outer position + N 个 inner position**，N 是同一时刻实际 attach 到 inner controller 上的 position 数量，而不是 body 里 `Scrollable` 的总数：只有继承并 attach 到注入的 inner controller 的那些才算，常见来源是 body 中未显式指定 controller 的纵向 primary `Scrollable`（`TabBarView` / `PageView` 里每个满足条件的页面各算一个）。"内外是父子"的直觉之所以错，是因为 inner 与 outer 之间**没有 parent 指针**，它们只共享一个 coordinator。

**关键认知**：`NestedScrollView.controller` 不是"另一个 controller"。coordinator 在构造时把它的 `initialScrollOffset` 读走（`nested_scroll_view.dart:622`），随后通过 `updateParent` 把 **outer position 挂到这个 controller 上**：

```dart
// nested_scroll_view.dart:1125-1127
void updateParent() {
  _outerPosition?.setParent(_parent ?? PrimaryScrollController.maybeOf(_state.context));
}
```

`_NestedScrollPosition.setParent`（`nested_scroll_view.dart:1228`）做的事就是 `_parent?.attach(this)`。所以 `NestedScrollView.controller` 与 `state.outerController` 共享**同一个** outer position 对象，读到的是同一个 `pixels`。

## 二、最小 Demo

下面这段代码的目的不是做出好看的页面，而是把"几套 position、各自多少 pixels、当前什么 activity"打出来。

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) =>
      const MaterialApp(home: Scaffold(body: NestedDemo()));
}

class NestedDemo extends StatefulWidget {
  const NestedDemo({super.key});

  @override
  State<NestedDemo> createState() => _NestedDemoState();
}

class _NestedDemoState extends State<NestedDemo> {
  // 1. 只有通过 GlobalKey 拿到 State，才能读到 inner / outer 两个 controller
  final GlobalKey<NestedScrollViewState> nestedKey = GlobalKey<NestedScrollViewState>();

  @override
  void initState() {
    super.initState();
    // 2. 必须等第一帧：确保 position 已完成 viewport/layout，dimensions 与 pixels 可读
    //    （position 本身在 Scrollable 的 didChangeDependencies → _updatePosition 中就会创建并 attach）
    WidgetsBinding.instance.addPostFrameCallback((_) => _watch());
  }

  void _watch() {
    final NestedScrollViewState? state = nestedKey.currentState;
    if (state == null) {
      return;
    }
    // 3. 两个 controller 互相独立，各自监听自己的那批 position
    state.outerController.addListener(() => _dump('outer', state.outerController));
    state.innerController.addListener(() => _dump('inner', state.innerController));
    _dump('outer', state.outerController);
    _dump('inner', state.innerController);
  }

  void _dump(String tag, ScrollController controller) {
    // 4. inner 侧可能挂着多个 position，所以要遍历而不是取 single
    for (final ScrollPosition p in controller.positions) {
      debugPrint(
        '[57] $tag pixels=${p.pixels.toStringAsFixed(1)} '
        'range=${p.minScrollExtent.toStringAsFixed(1)}..${p.maxScrollExtent.toStringAsFixed(1)} '
        'viewport=${p.viewportDimension.toStringAsFixed(1)} '
        'activity=${p.activity.runtimeType}',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return NestedScrollView(
      key: nestedKey,
      scrollDirection: Axis.vertical,
      // 5. pinned + expanded 的 SliverAppBar：可折叠距离 = expandedHeight - toolbarHeight
      // primary: false 关掉状态栏 padding 的自动补偿，让第六节手算出的 56 / 200 有确定前提
      headerSliverBuilder: (BuildContext context, bool innerBoxIsScrolled) => <Widget>[
        SliverOverlapAbsorber(
          handle: NestedScrollView.sliverOverlapAbsorberHandleFor(context),
          sliver: const SliverAppBar(
            pinned: true,
            primary: false,
            expandedHeight: 200,
            title: Text('57'),
          ),
        ),
      ],
      // 6. body 里是一个完整的 CustomScrollView，它自带一套独立的 ScrollPosition
      body: Builder(
        builder: (BuildContext context) => CustomScrollView(
          slivers: <Widget>[
            // 7. 把 header 吸收掉的重叠量在内层补回来，否则首项会被 pinned 表头压住
            SliverOverlapInjector(
              handle: NestedScrollView.sliverOverlapAbsorberHandleFor(context),
            ),
            SliverList.builder(
              itemCount: 100,
              itemBuilder: (BuildContext context, int index) =>
                  ListTile(title: Text('item $index')),
            ),
          ],
        ),
      ),
    );
  }
}
```

三个观察点，后面第六节会用：

- `_dump` 的 `tag` 会打出两个不同的 controller，但 `pixels` 一直在变的那一个会随拖动阶段切换；
- 本 Demo 的 `innerController.positions.length` 应为 1（body 只有一个 `CustomScrollView`）；若 body 用 `TabBarView` / `PageView`，且多个页面的纵向 Scrollable 同时 attach 到 inner controller，才可能大于 1。`outerController.positions` 恒为 1——源码里写死了 `.single`；
- `activity` 的类型能看出"现在是拖动还是惯性"，例如 `DragScrollActivity` / `_NestedOuterBallisticScrollActivity`。

## 三、入口锚点

| 锚点 | 职责 |
|---|---|
| `widgets/nested_scroll_view.dart:183` / `:393` | `NestedScrollView`（`StatefulWidget`）与 `NestedScrollViewState`：参数定义与 coordinator 的创建者 |
| `widgets/nested_scroll_view.dart:522` / `:557` / `:566` | `_NestedScrollViewCustomScrollView`（换成 Nested viewport）、`_InheritedNestedScrollView`（传 State）、`_NestedScrollMetrics`（合并坐标系） |
| `widgets/nested_scroll_view.dart:614` | `_NestedScrollCoordinator`：**本篇主角**，同时实现 `ScrollActivityDelegate` 与 `ScrollHoldController` |
| `widgets/nested_scroll_view.dart:1143` / `:1203` | `_NestedScrollController`（创建/attach/detach 的桥）与 `_NestedScrollPosition`（真正持有 pixels） |
| `widgets/nested_scroll_view.dart:1607` / `:1684` / `:1720` | `SliverOverlapAbsorberHandle` / `SliverOverlapAbsorber` / `RenderSliverOverlapAbsorber`：把重叠量写进 handle |
| `widgets/nested_scroll_view.dart:1833` / `:1869` | `SliverOverlapInjector` / `RenderSliverOverlapInjector`：把 handle 里的量在内层列表顶部占回来 |
| `widgets/nested_scroll_view.dart:1990` / `:2043` | `NestedScrollViewViewport` / `RenderNestedScrollViewViewport`：会被标记重排时反过来通知 handle |
| `widgets/nested_scroll_view.dart:698`、`:729`、`:794`、`:1057`、`:1379` | coordinator 的 activity 统一入口、outer/inner 惯性创建、合并坐标映射、**拖动 delta 分配**、position 反向委托 |

## 四、调用链

### 4.1 build：谁创建了这两套位置

`NestedScrollViewState.initState` 里只做一件事：

```dart
// nested_scroll_view.dart:431-439（节选）
void initState() {
  super.initState();
  _coordinator = _NestedScrollCoordinator(
    this,
    widget.controller,
    _handleHasScrolledBodyChanged,
    widget.floatHeaderSlivers,
  );
}
```

coordinator 的构造函数立刻造出**两个** `_NestedScrollController`：

```dart
// nested_scroll_view.dart:622-628
final double initialScrollOffset = _parent?.initialScrollOffset ?? 0.0;
_outerController = _NestedScrollController(
  this,
  initialScrollOffset: initialScrollOffset,
  debugLabel: 'outer',
);
_innerController = _NestedScrollController(this, debugLabel: 'inner');
```

两者都是 `_NestedScrollController`（`nested_scroll_view.dart:1143`），区别只在 `debugLabel` 与 `initialScrollOffset`。`createScrollPosition` 被覆写，返回的一定是 `_NestedScrollPosition`（`nested_scroll_view.dart:1148-1162`）。

然后 `build` 把两个 controller 分派到两个方向上：

```dart
// nested_scroll_view.dart:497-515（节选）
return _NestedScrollViewCustomScrollView(
  physics: scrollPhysics,
  controller: _coordinator!._outerController,          // 外层用 outer
  slivers: widget._buildSlivers(
    context,
    _coordinator!._innerController,                    // body 里注入 inner
    _lastHasScrolledBody!,
  ),
  handle: _absorberHandle,
  clipBehavior: widget.clipBehavior,
);
```

`_buildSlivers` 是全局里唯一把 inner controller 交出去的地方：

```dart
// nested_scroll_view.dart:349-364（节选）
return <Widget>[
  ...headerSliverBuilder(context, bodyIsScrolled),
  SliverFillRemaining(
    child: PrimaryScrollController(
      // 在所有平台都继承，不跟随平台差异
      automaticallyInheritForPlatforms: TargetPlatform.values.toSet(),
      controller: innerController,
      child: body,
    ),
  ),
];
```

**关键认知**：`body` 不在外面额外套滚动组件时，它被放进**外层 viewport 的一个 sliver**（`SliverFillRemaining`）。所以严格说 body 既是"内层滚动组件"，又是"外层内容的一部分"——这两重身份正是 overlap 传递要解决的问题（见 4.5）。同时 `PrimaryScrollController` 把 inner controller 注入 body 子树，body 里的 `ListView` / `CustomScrollView` 只要不显式传 controller、且滚动方向是默认的纵向 primary，就会自动接到这个 inner controller 上（`PrimaryScrollController.scrollDirection` 未设置，因此被限制在 `Axis.vertical`）。

最后外层 viewport 被换成 `NestedScrollViewViewport`：

```dart
// nested_scroll_view.dart:540-553（节选）
Widget buildViewport(
  BuildContext context,
  ViewportOffset offset,
  AxisDirection axisDirection,
  List<Widget> slivers,
) {
  assert(!shrinkWrap);
  return NestedScrollViewViewport(
    axisDirection: axisDirection,
    offset: offset,
    slivers: slivers,
    handle: handle,        // ← _absorberHandle，与 Absorber/Injector 同一个对象
    clipBehavior: clipBehavior,
  );
}
```

这个 viewport 只多了一个行为：自己被标记重排时，顺手通知 handle（`nested_scroll_view.dart:2071-2074`）。

### 4.2 一次手势：delta 到 coordinator

手指按下时，`_NestedScrollPosition` 把请求转给 coordinator：

```dart
// nested_scroll_view.dart:1484-1487，_NestedScrollPosition
@override
Drag drag(DragStartDetails details, VoidCallback dragCancelCallback) {
  return coordinator.drag(details, dragCancelCallback);   // 见 :1041
}
```

注意是 **position 转发给 coordinator**，不是 coordinator 转发给 position。coordinator 随后用 `beginActivity` 同时给 outer 和每个 inner 换上新的 activity：

```dart
// nested_scroll_view.dart:698-712（节选）
void beginActivity(
  ScrollActivity newOuterActivity,
  _NestedScrollActivityGetter innerActivityGetter,
) {
  _outerPosition!.beginActivity(newOuterActivity);
  bool scrolling = newOuterActivity.isScrolling;
  for (final _NestedScrollPosition position in _innerPositions) {
    final ScrollActivity newInnerActivity = innerActivityGetter(position);
    position.beginActivity(newInnerActivity);
    scrolling = scrolling && newInnerActivity.isScrolling;
  }
  ...
}
```

**关键认知**：activity 是**成组切换**的。一次拖动会让 outer 与所有 inner 同时进入 `DragScrollActivity`（`nested_scroll_view.dart:1047-1050`），但它们共用**同一个** `ScrollDragController` 对象（存在 `_currentDrag`）。所以"哪个 position 在动"不是由 activity 决定的，而是由下面的分配算法决定的。

### 4.3 分配：`_NestedScrollCoordinator.applyUserOffset`

这是本篇最该逐行读的方法（`nested_scroll_view.dart:1057`）。它的形状是三分支：

```dart
// nested_scroll_view.dart:1057-1061（节选）
void applyUserOffset(double delta) {
  updateUserScrollDirection(delta > 0.0 ? ScrollDirection.forward : ScrollDirection.reverse);
  assert(delta != 0.0);
  if (_innerPositions.isEmpty) {
    _outerPosition!.applyFullDragUpdate(delta);      // 分支 A：没有 body，全给 outer
  } else if (delta < 0.0) { ... } else { ... }
}
```

**分支 B：`delta < 0.0`（源码注释写作 Dragging "up"，即把内容往上推、露出下方内容）**

```dart
// nested_scroll_view.dart:1062-1085（节选）
} else if (delta < 0.0) {
  var outerDelta = delta;
  for (final _NestedScrollPosition position in _innerPositions) {
    if (position.pixels < 0.0) {
      // inner 此刻处于负越界，先把它收回来
      final double potentialOuterDelta = position.applyClampedDragUpdate(delta);
      outerDelta = math.max(outerDelta, potentialOuterDelta);
    }
  }
  if (outerDelta.abs() > precisionErrorTolerance) {
    final double innerDelta = _outerPosition!.applyClampedDragUpdate(outerDelta);
    if (innerDelta != 0.0) {
      for (final _NestedScrollPosition position in _innerPositions) {
        position.applyFullDragUpdate(innerDelta);   // outer 吃不下的，按原始 delta 给 inner
      }
    }
  }
}
```

三跳很清楚：**先处理 inner 负数越界 → 再让 outer 用 `applyClampedDragUpdate` 吃掉它能吃的 → 剩余的用 `applyFullDragUpdate` 交给每个 inner**。所以"向上拖先折叠 header"的确是优先级顺序，但准确表述是"outer 先吃，而不是 inner 先吃"。

这里两个方法名必须分清，它们是两种不同的消费语义：

- `applyClampedDragUpdate`（`nested_scroll_view.dart:1254`）**不会通过自身新引入 overscroll**，源码注释明确写着 "we cannot, via applyClampedDragUpdate, _enter_ an overscroll situation"；但它会按当前 pixels 设定边界，允许已有越界被收回、或继续停留在已有越界状态；返回值是**没吃完的 delta**。
- `applyFullDragUpdate`（`nested_scroll_view.dart:1304`）走完整物理：先 `physics.applyPhysicsToUserOffset` 施加摩擦，再 `applyBoundaryConditions` 判越界，越界量通过 `didOverscrollBy` 发出去；返回值是**overscroll 量**。

**分支 C：`delta > 0.0`（Dragging "down"，把内容往下拉）**

```dart
// nested_scroll_view.dart:1088-1115（节选）
} else {
  var innerDelta = delta;
  if (_floatHeaderSlivers) {
    innerDelta = _outerPosition!.applyClampedDragUpdate(delta);   // 只有开了浮动才让 outer 先吃
  }
  if (innerDelta != 0.0) {
    var outerDelta = 0.0;
    final overscrolls = <double>[];
    final List<_NestedScrollPosition> innerPositions = _innerPositions.toList();
    for (final position in innerPositions) {
      final double overscroll = position.applyClampedDragUpdate(innerDelta);
      outerDelta = math.max(outerDelta, overscroll);
      overscrolls.add(overscroll);
    }
    if (outerDelta != 0.0) {
      outerDelta -= _outerPosition!.applyClampedDragUpdate(outerDelta);
    }
    for (var i = 0; i < innerPositions.length; ++i) {
      final double remainingDelta = overscrolls[i] - outerDelta;
      if (remainingDelta > 0.0) {
        innerPositions[i].applyFullDragUpdate(remainingDelta);
      }
    }
  }
}
```

默认顺序与"向上"相反：**inner 先吃到顶，溢出的部分（`overscrolls`）汇总给 outer**。多个 inner 同时溢出时用 `math.max` 取最大值——注释解释了原因：只要有一个 inner 已经把 outer 顶上去了，就不要再重复顶。剩下的 `remainingDelta` 再逐个还给"确实溢出的那个" inner，避免多个 inner 位置不一致。

`floatHeaderSlivers: true` 时唯一的变化是**最前面插入一跳**：让 outer 先吃，这样浮动表头能立刻响应。这就是该参数的全部语义（`nested_scroll_view.dart:302` 的文档也这么写），它不改 inner/outer 的像素记账方式。

**关键认知**：`_NestedScrollCoordinator.setPixels` 是**死代码**：

```dart
// nested_scroll_view.dart:1023-1026
double setPixels(double newPixels) {
  assert(false);
  return 0.0;
}
```

它存在只是因为 coordinator `implements ScrollActivityDelegate`，必须凑齐接口。真正的写入路径是 `_NestedScrollPosition` 内部的 `forcePixels` + `didUpdateScrollPositionBy`（`nested_scroll_view.dart:1254`、`:1304` 内），**绕过了第 45 篇讲的 `setPixels`**，也就绕过了 `setPixels` 里那条"禁止在 layout 期间改偏移量"的断言。这是"coordinator 要在自己算好的时机写 pixels"的必要条件。

### 4.4 松手：两根轴被拼成一根

松手后 `ScrollDragController` 调 `goBallistic(velocity)`，落到 coordinator：

```dart
// nested_scroll_view.dart:729-731
void goBallistic(double velocity) {
  beginActivity(createOuterBallisticScrollActivity(velocity), (_NestedScrollPosition position) {
    return createInnerBallisticScrollActivity(position, velocity);
  });
}
```

`createOuterBallisticScrollActivity`（`:735`）先要**挑一个"代表性 inner"**——源码注释承认这是"有点随意的选择"：如果有速度，就挑离目标无穷远最远的那个（`velocity > 0` 时取 `pixels` 最小的）。没有 inner position、或 `velocity == 0.0` 时 `innerPosition` 才保持 `null`，走 `independent` 模式退回普通的 `BallisticScrollActivity`；只要 `velocity` 非 0 且存在至少一个 inner position（包括只有一个），就会选出代表性 inner 并走合并度量。

挑到了就构造合并度量：

```dart
// nested_scroll_view.dart:794 起（节选），_getMetrics
return _NestedScrollMetrics(
  minScrollExtent: _outerPosition!.minScrollExtent,
  maxScrollExtent:
      _outerPosition!.maxScrollExtent +
      innerPosition.maxScrollExtent -
      innerPosition.minScrollExtent +
      extra,
  pixels: pixels,
  viewportDimension: _outerPosition!.viewportDimension,
  minRange: minRange,
  maxRange: maxRange,
  correctionOffset: correctionOffset,
  ...
);
```

**关键认知**：`maxScrollExtent` 是 outer 与 inner 的**相加**——这就是"把两段滚动拼成一根轴"的具体含义。随后：

- outer 的 activity 是 `_NestedOuterBallisticScrollActivity`（`nested_scroll_view.dart:1522`），它的 `applyMoveTo` 把 Simulation 给出的值先夹到 `[metrics.minRange, metrics.maxRange]`，再加上 `metrics.correctionOffset` 才交给 `super.applyMoveTo`——**`correctionOffset` 就是把"合并轴坐标"平移回"outer 局部坐标"的修正量**；
- inner 的 activity 是 `_NestedInnerBallisticScrollActivity`（`nested_scroll_view.dart:1492`），它的 `applyMoveTo` 只做一次 `coordinator.nestOffset(value, delegate)`。

两个方向的坐标换算写在 coordinator 里（`nested_scroll_view.dart:873` / `:883`）：

```dart
// nested_scroll_view.dart:883-893
double nestOffset(double value, _NestedScrollPosition target) {
  if (target == _outerPosition) {
    return clampDouble(value, _outerPosition!.minScrollExtent, _outerPosition!.maxScrollExtent);
  }
  if (value < _outerPosition!.minScrollExtent) {
    return value - _outerPosition!.minScrollExtent + target.minScrollExtent;
  }
  if (value > _outerPosition!.maxScrollExtent) {
    return value - _outerPosition!.maxScrollExtent + target.minScrollExtent;
  }
  return target.minScrollExtent;
}
```

读法很短：**合并轴坐标落在 outer 的范围内时归 outer，超出去的部分减掉 outer 的范围就是 inner 的坐标**。中间那段"两个 min 之间"的缝隙统一返回 `target.minScrollExtent`，所以那种情况下 inner 停在起点，由 outer 独占这段。

### 4.5 命令式滚动：`jumpTo` 也走 coordinator

`state.innerController.jumpTo(x)` 与 `state.outerController.jumpTo(x)` 都不是"直接改自己"：

```dart
// nested_scroll_view.dart:1437-1445（节选），_NestedScrollPosition
@override
void jumpTo(double value) {
  return coordinator.jumpTo(coordinator.unnestOffset(value, this));
}

@override
void pointerScroll(double delta) {
  return coordinator.pointerScroll(delta);
}
```

`unnestOffset` 把"某一个 position 的局部坐标"翻译成合并轴坐标，coordinator 再对 outer 与每个 inner 分别 `nestOffset` 回去：

```dart
// nested_scroll_view.dart:935-943（节选）
void jumpTo(double to) {
  goIdle();
  _outerPosition!.localJumpTo(nestOffset(to, _outerPosition!));
  for (final _NestedScrollPosition position in _innerPositions) {
    position.localJumpTo(nestOffset(to, position));
  }
  goBallistic(0.0);
}
```

这解释了 `NestedScrollViewState` 的文档为什么说"操作 inner controller 会把 outer 推到 `maxScrollExtent`"（`nested_scroll_view.dart:399-402`）：合并轴上的值一旦超出 outer 的范围，`nestOffset` 给 outer 的结果就会被 `clampDouble` 夹到 `maxScrollExtent`。`animateTo`（`nested_scroll_view.dart:916`）同理，只是改用 `DrivenScrollActivity` 并 `Future.wait` 等所有 activity 结束。

### 4.6 overlap：几何传递，不是事件传递

内层列表要和 pinned 表头对齐，靠的是一对 sliver，而不是任何滚动逻辑：

```dart
// nested_scroll_view.dart:1771-1784（节选），RenderSliverOverlapAbsorber.performLayout
child!.layout(constraints, parentUsesSize: true);
final SliverGeometry childLayoutGeometry = child!.geometry!;
geometry = childLayoutGeometry.copyWith(
  scrollExtent:
      childLayoutGeometry.scrollExtent - childLayoutGeometry.maxScrollObstructionExtent,
  layoutExtent: math.max(
    0,
    childLayoutGeometry.paintExtent - childLayoutGeometry.maxScrollObstructionExtent,
  ),
);
handle._setExtents(
  childLayoutGeometry.maxScrollObstructionExtent,
  childLayoutGeometry.maxScrollObstructionExtent,
);
```

Absorber 做两件事：**从 child 的 `scrollExtent` 中扣除 `maxScrollObstructionExtent`；它上报的 `layoutExtent` 则由 child 的 `paintExtent` 减去该 obstruction 后取非负值（`math.max(0, ...)`）**，并把扣除的这个量写进 handle。另一端：

```dart
// nested_scroll_view.dart:1935-1940（节选），RenderSliverOverlapInjector.performLayout
geometry = SliverGeometry(
  scrollExtent: _currentLayoutExtent!,
  paintExtent: math.max(0.0, clampedPaintExtent),
  layoutExtent: math.max(0.0, clampedLayoutExtent),
  maxPaintExtent: _currentMaxExtent!,
);
```

Injector 用 handle 里的值**造出一段和它一样大的几何**，占在内层列表的最前面。

**关键认知**：这对组件传的是 `SliverGeometry` 里的**数字**（`nested_scroll_view.dart:1607` 的 `SliverOverlapAbsorberHandle` 只有 `_layoutExtent` / `_scrollExtent` 两个 double 字段），传递方向是"渲染期几何"。它和手势、和事件冒泡毫无关系。下一节会看到这两个数字在数值上意味着什么。

## 五、核心对象：`_NestedScrollCoordinator` vs `_NestedScrollPosition`

| | `_NestedScrollCoordinator` | `_NestedScrollPosition` |
|---|---|---|
| 声明位置 | `nested_scroll_view.dart:614` | `nested_scroll_view.dart:1203` |
| 父类/接口 | `implements ScrollActivityDelegate, ScrollHoldController`（**不是** `ChangeNotifier`） | `extends ScrollPosition implements ScrollActivityDelegate` |
| 持有 pixels | 否 | 是（继承自 `ScrollPosition._pixels`，第 45 篇） |
| 数量关系 | 1 个 coordinator ↔ 1 个 outer + N 个 inner | 每个 viewport 一个，outer 与 inner 通用同一个类 |
| 手势入口 | `applyUserOffset`（`:1057`），**真正的分配算法** | `applyUserOffset` 直接 `assert(false)`（`:1364`） |
| 命令入口 | `jumpTo`（`:935`）/ `animateTo`（`:916`）/ `pointerScroll`（`:944`） | 全部转给 coordinator（`:1429`、`:1438`、`:1443`） |
| activity | `beginActivity`（`:698`）一次性换掉 outer + 全部 inner | `goIdle`（`:1371`）/ `goBallistic`（`:1379`）只在被委托时执行 |
| 坐标 | 维护合并轴：`nestOffset` / `unnestOffset`（`:883` / `:873`） | 只认自己的局部 pixels |
| 越界处理 | 决定"谁先吃、吃多少、剩多少" | 提供两种消费语义：`applyClampedDragUpdate`（`:1254`）/ `applyFullDragUpdate`（`:1304`） |

一句话分工：**coordinator 是调度器（有几套位置、delta 怎么分、activity 怎么切、坐标怎么换算），position 是执行器（pixels 存哪、越界怎么算、通知怎么发）。**

夹在两者中间的 `_NestedScrollController`（`nested_scroll_view.dart:1143`）只做桥接，它**不持有任何偏移量**——这一点与第 45 篇对 `ScrollController` 的结论一致：

```dart
// nested_scroll_view.dart:1194-1196
Iterable<_NestedScrollPosition> get nestedPositions {
  return positions.cast<_NestedScrollPosition>();
}
```

它的额外职责只有两条：在 `attach` 时把新 position 注册成"影子状态"的监听源（`nested_scroll_view.dart:1170`），以及把 `updateShadow` 推迟到帧后执行（`:1183-1192`，原因是 `setState` 不能发生在帧中）。正因为有这个 `_scheduleUpdateShadow`，`headerSliverBuilder` 的 `innerBoxIsScrolled` 参数才会有"延后一帧"的观感延迟——这是设计取舍，不是 bug。

## 六、源码实验

### 实验 1：delta 的消费点全部在 coordinator 里

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
# 1. 谁在调用两个消费方法？
grep -n "applyClampedDragUpdate\|applyFullDragUpdate" widgets/nested_scroll_view.dart
# 2. position 自己的 applyUserOffset / setPixels 是什么样？
grep -n -A3 "void applyUserOffset(double delta)" widgets/nested_scroll_view.dart
grep -n -A2 "double setPixels(double newPixels)" widgets/nested_scroll_view.dart
```

**预测**：如果"内层滚完冒泡给外层"成立，应该能在 position 里找到分配逻辑。

**实际输出**（现场核对）：消费点只有 8 处，且全部落在 coordinator 的 `applyUserOffset` 体内——`:1061`、`:1070`、`:1078`、`:1081`、`:1090`、`:1101`、`:1106`、`:1113`；方法定义在 `:1254` 与 `:1304`。而 position 的两个接口是：

```text
1057:  void applyUserOffset(double delta) {
1058-    updateUserScrollDirection(delta > 0.0 ? ScrollDirection.forward : ScrollDirection.reverse);
1059-    assert(delta != 0.0);
...
1023:  double setPixels(double newPixels) {
1024-    assert(false);
1025-    return 0.0;
1026-  }
```

（第一条是 coordinator 的方法，第二条是 coordinator 的 `setPixels`。position 侧的 `applyUserOffset` 在 `:1364-1367`，同样是 `assert(false); return 0.0;`。）

**说明**：两处 `assert(false)` 是最硬的证据——框架自己在断言里写死了"这个对象不该被要求消费 delta"。position 提供的是两种会实际修改自身 pixels 并发送通知的消费原语（内部走 `forcePixels` + `didUpdateScrollPositionBy`，`applyFullDragUpdate` 还可能调用 `didOverscrollBy`），它们同时返回未消费的 delta / overscroll；这些返回值如何继续分配给其他 position，由 coordinator 决定。

### 实验 2：Absorber 到底改了什么数字（可手算）

取 Demo 里的配置：视口高 600，`SliverAppBar(pinned: true, primary: false, expandedHeight: 200)`，默认 `toolbarHeight` 为 56。Demo 里显式写 `primary: false` 是本节能按定值手算的前提：`_SliverAppBarState.build` 用 `final double topPadding = widget.primary ? MediaQuery.paddingOf(context).top : 0.0`（`material/app_bar.dart:2091`）算出 `collapsedHeight`（其中带 `topPadding`），`minExtent` 直接取它（`app_bar.dart:1339`），`maxExtent` 则是 `topPadding + expandedHeight`（`app_bar.dart:1342-1344`）。`primary: true`（默认值）时这两个数都随设备状态栏高度走，`maxScrollObstructionExtent` 就不再是 56。先确认两个前提数字：

```text
rendering/sliver_persistent_header.dart:441   maxScrollObstructionExtent: minExtent    （pinned 时 minExtent = toolbarHeight）
rendering/sliver_fill.dart:153                 scrollExtent: constraints.viewportMainAxisExtent   （RenderSliverFillRemainingWithScrollable）
```

于是外层 viewport 的内容长度是：

```text
带 Absorber：
  header 的 scrollExtent = 200 - 56 = 144    （:1774-1775）
  SliverFillRemaining    = 600
  内容总长 = 744  →  maxScrollExtent = 744 - 600 = 144   ← 恰好等于可折叠距离

不带 Absorber：
  header 的 scrollExtent = 200
  SliverFillRemaining    = 600
  内容总长 = 800  →  maxScrollExtent = 800 - 600 = 200
```

**预测**：Absorber 的作用是把 outer 的可滚动范围从 200 缩到 144；少掉的 56 应该在内层被补回来（否则这段重叠量凭空消失）。

**实际（按源码公式代入）**：`handle._setExtents` 写入的正是 56（`nested_scroll_view.dart:1781-1784`），Injector 再把这个 56 变成自己几何的 `scrollExtent` / `layoutExtent` / `maxPaintExtent`（`:1935-1940`）。所以 56 这个量是"从 outer 的滚动范围搬到 inner 列表顶部"，一减一加，总量守恒。

**说明**：不带 Absorber 时 outer 会比应有值多出 56 像素的可滚动范围。折叠距离在 144 处就用完了，用户继续拖的这 56 像素两边都不动，直到 outer 到达 200，inner 才开始滚——这就是"折叠到顶后内容愣一下才动"的来源。而两个都去掉更糟：inner 拿不到那 56 的顶部间隙，pinned 表头会直接压在内层首项上，源码注释的原话是"the nested inner scroll view below can end up under the `SliverAppBar` even when the inner scroll view thinks it has not been scrolled"（`nested_scroll_view.dart:147-149`）。只留 Injector、去掉 Absorber 则是直接失败：

```dart
// nested_scroll_view.dart:1918-1926
assert(
  _currentLayoutExtent != null && _currentMaxExtent != null,
  'SliverOverlapInjector has found no absorbed extent to inject.\n '
  'The SliverOverlapAbsorber must be an earlier descendant of a common '
  'ancestor Viewport, so that it will always be laid out before the '
  'SliverOverlapInjector during a particular frame.\n',
);
```

这就是"必须成对"的确切含义：**Injector 读的是 Absorber 在同一帧更早写进 handle 的值**。顺序由 sliver 布局顺序保证——Absorber 是 header 里的 sliver，先被外层 viewport 布局；inner viewport 是在 `SliverFillRemaining` 布局时才被布局的（`rendering/sliver_fill.dart:145`）。

### 实验 3：合并轴在数值上长什么样

不跑 App，直接把 `_getMetrics`（`nested_scroll_view.dart:794`）的公式代入实验 2 的读数。取 `outer.maxScrollExtent = 144`、`outer.pixels = 144`（header 已折叠到顶）、inner 的 `minScrollExtent = 0`、`maxScrollExtent = 500`、`pixels = 0`，松手速度为 2000（继续上滑）。

**预测**：这个分支（`innerPosition.pixels == innerPosition.minScrollExtent`）走的是 `_getMetrics` 的第一段，应该得到 `pixels = 144`、`minRange = 0`、`maxRange = 144`、`correctionOffset = 0`。

**实际（按源码公式代入）**：

```text
pixels          = clampDouble(144, 0, 144)      = 144
minRange        = outer.minScrollExtent         = 0
maxRange        = outer.maxScrollExtent         = 144
correctionOffset                                = 0
maxScrollExtent = 144 + (500 - 0) + 0           = 644
```

再验一次坐标换算：Simulation 算出合并轴上的 300，`nestOffset(300, inner)` 因为 `300 > outer.maxScrollExtent(144)`，结果是 `300 - 144 + 0 = 156`，即 inner 应滚到 156。用 `unnestOffset(156, inner)` 反算回去：`156 - 0 + 144 = 300`，一致。

**说明**：合并轴就是 `[0, 144]`（outer 段）+ `[144, 644]`（inner 段）首尾相连。`correctionOffset` 是"Simulation 只知道合并轴，而 `super.applyMoveTo` 只认 outer 局部坐标"这个落差所需的平移量。这也解释了为什么 `_NestedOuterBallisticScrollActivity.applyMoveTo` 里要先夹范围再加 `correctionOffset`（`nested_scroll_view.dart:1552-1575`）。

跑第二节的 Demo 时，`[57]` 打印的顺序应当是：拉动过程中 `outer pixels` 从 0 涨到 144 而 `inner pixels` 保持 0；越过 144 之后 `outer pixels` 不再变化，`inner pixels` 开始增长。松手瞬间两个 position 的 `activity` 会同时变成 `_NestedOuterBallisticScrollActivity` / `_NestedInnerBallisticScrollActivity`，而不是普通的 `BallisticScrollActivity`——这正是 `beginActivity` 成组切换的可见证据。

## 七、结论

1. `NestedScrollView` 不是"能嵌套滚动的 ScrollView"，而是**一个 outer viewport + 一组 inner position + 一个 `_NestedScrollCoordinator`**（`nested_scroll_view.dart:614`）。outer position 只有一个（源码写死 `.single`，`:648`），inner position 可以有很多（`:651`、`:1194`），它们之间没有父子关系，只共享 coordinator。
2. 用户手势的 `delta` 由 `_NestedScrollCoordinator.applyUserOffset`（`:1057`）在每次拖动更新回调中分配：`delta < 0` 时 outer 先用 `applyClampedDragUpdate` 吃，剩余给 inner；`delta > 0` 时默认 inner 先吃、溢出量汇总给 outer，`floatHeaderSlivers` 只负责把 outer 提到最前。分配过程**绕过了 `setPixels`**（coordinator 的 `setPixels` 是 `assert(false)`，`:1023`），改用 `forcePixels` + `didUpdateScrollPositionBy`。
3. inner 与 outer 的对齐不是靠事件，而是靠几何：`RenderSliverOverlapAbsorber.performLayout`（`:1774`）从 child 的 `scrollExtent` 里扣掉 `maxScrollObstructionExtent`、并以 child 的 `paintExtent` 减去该 obstruction 作为上报的 `layoutExtent`（取非负），一并写进 handle，`RenderSliverOverlapInjector.performLayout`（`:1915`）把这个数字在内层列表顶部占回来；少任何一半，56 像素的表头高度就会记错账。

一句话总结：**`NestedScrollView` 的 inner 与 outer 是两个各自持有 `pixels` 的 `_NestedScrollPosition`，由 `_NestedScrollCoordinator` 在每次手势中分配 delta、在松手后把它们拼成一根坐标轴再拆回去，而两者的视觉对齐靠 Absorber / Injector 传递 extent 完成。**

## 八、边界声明

- 滚动位置与 controller 的一般关系（`ScrollController` 只是广播站、`_pixels` 在 `ScrollPosition` 里）在第 45 篇，本篇只引用不重讲。
- `ScrollActivity` 的状态机与 `ScrollPhysics` 的衰减参数在第 46 篇；本篇只关心"activity 被成组切换"和"Simulation 跑在哪根轴上"。
- `SliverConstraints` / `SliverGeometry` / `RenderViewport` 的分发协议在第 47 篇；本篇用到的 `maxScrollObstructionExtent` 语义就在该篇的几何字段表里，这里只做数值代入。
- 懒加载与 `cacheExtent` 在第 48 篇；本篇不解释 inner 列表建多少个 child。
- 吸顶、`SliverAppBar` 折叠、`PageStorage` 保留各 tab 滚动位置等实战写法，交给同仓库 `MarkDown笔记/flutter/底层原理/39 Flutter NestedScrollView 源码解读：外层 Header 与内层列表如何协同.md`，本篇不重复。
- `NestedScrollView` 自身的两个已知限制（outer 不支持同时 floating + snapping、不支持 `SliverAppBar.stretch`）源码注释已给结论（`nested_scroll_view.dart:164-173`），成因在 `Snapping` / `StretchConfiguration` 那一侧，本篇不追。
- 通知的 `depth` 与 `NotificationListener` 如何区分内外层，属于通知分发话题，本系列不单独展开；`pointerScroll`（`:944`）的独立分配规则与 `applyUserOffset` 高度同构，本文不逐行重复。
