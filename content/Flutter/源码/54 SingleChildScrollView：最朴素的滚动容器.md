# 54 SingleChildScrollView：最朴素的滚动容器

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/single_child_scroll_view.dart`（711 行）、`packages/flutter/lib/src/material/scrollbar.dart`（414 行）

## 一、问题

`SingleChildScrollView` 是"我想让这段内容能滚起来"最短的答案：套一层，给个 `child`，就完了。于是两个问题随之而来。

**问题一**：它是一个 `StatelessWidget`（`single_child_scroll_view.dart:147`）。一个没有 `State` 的组件，滚动位置存在哪？

**问题二**：里面放一个 `Column`，几百行内容照样能滚。那它跟 `ListView` 到底差在哪？

围绕这两个问题，最常见的错误直觉有两条：

- "`StatelessWidget` 没有状态，所以滚动位置一定存在外部对象里，比如 `ScrollController`。"——**位置不在 controller 里**。第 45 篇已经证明：`ScrollController` 只有 `List<ScrollPosition> _positions`（`scroll_controller.dart:155-156`），真正存偏移量的字段是 `ScrollPosition._pixels`（`scroll_position.dart:264-265`）。
- "`Column` 也懒：屏幕放不下就只 build 可见的那几个。"——**`Column` 没有"可见"这个概念**。它一次性布局完所有 `children`，再报一个总高给父级；它完全没有按需回收/创建的机制。

> `SingleChildScrollView` 把「滚动」和「内容」分给了两个完全不同的东西。
> 滚动位置走的是和 `ListView` **一模一样**的那条链——内部的 `Scrollable`（`:261`）接到 `ScrollPosition`；
> 内容侧却只是一个 `RenderBox` 视口 `_RenderSingleChildViewport`（`:347`），它把唯一那个 child **一次性布局完**。
> 所以它的"朴素"之处在内容侧根本没有 sliver 协议，与滚动状态无关。

## 二、最小 Demo

### 2.1 controller + Scrollbar：把内部位置接出来

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: DemoScreen());
}

class DemoScreen extends StatefulWidget {
  const DemoScreen({super.key});

  @override
  State<DemoScreen> createState() => _DemoScreenState();
}

class _DemoScreenState extends State<DemoScreen> {
  // 1. controller 不是位置本体，它是唯一能从外面读到 / 下达命令的把手
  final ScrollController controller = ScrollController();

  @override
  void initState() {
    super.initState();
    // 2. 监听滚动：读到的是 position.pixels（第 45 篇），不是 controller 的字段
    controller.addListener(() {
      if (controller.hasClients) {
        debugPrint('offset=${controller.offset}');
      }
    });
  }

  @override
  void dispose() {
    // 3. controller 由创建者释放：它活得比这个 State 久或短，都不影响 position 的寿命
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Scrollbar(
        controller: controller, // 4. 本 Demo 让 Scrollbar 与滚动容器共用同一个 controller，常驻 thumb 才稳定
        thumbVisibility: true,  // 5. 常驻显示 thumb，方便观察位置变化
        child: SingleChildScrollView(
          controller: controller,
          // 6. 唯一 child：Column 只是这个 box child 的内部结构，它对滚动容器不可见
          child: Column(
            children: List<Widget>.generate(
              60,
              (int i) => SizedBox(height: 48, child: Center(child: Text('第 $i 行'))),
            ),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        // 7. 命令入口：animateTo 由 controller 转发给 position，再由 position 驱动滚动
        onPressed: () => controller.animateTo(
          controller.offset + 300,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        ),
        child: const Icon(Icons.arrow_downward),
      ),
    );
  }
}
```

跑起来能同时看到三件事：thumb 跟着内容走、控制台按帧打印 `offset=`、点按钮时 `offset` 平滑地加到 300。它们分别对应三个不同的对象——`Scrollbar` 是"位置的可视化消费方"，`offset` 是"位置的读取方"，`animateTo` 是"位置的下令方"；而位置本身始终在 `ScrollPosition` 里。

本 Demo 为了让 `Scrollbar` 在 `thumbVisibility: true` 下稳定关联该 position，显式把同一个 controller 传给两者。`Scrollbar` 的 `controller` 本身是可空的（`material/scrollbar.dart:103`）：它要求 `child` 是 `ScrollNotification` 的来源（`:75-76`），controller 为空时默认靠 `PrimaryScrollController` 支持拖拽（`:78-79`），也能凭子树通知更新滚动条；但 `thumbVisibility: true` 需要显式 controller，或祖先提供可用的 `PrimaryScrollController`（`:45-47`）。

### 2.2 别把 `Column` 的孩子当成滚动容器的孩子

```dart
// 结构上没有"列表"这一层：滚动容器只有一个 child
SingleChildScrollView(
  child: Column(children: <Widget>[/* 60 个 item */]),
)

// ListView 走的是另一条路：把"第 index 个孩子怎么造"交给 delegate
ListView.builder(
  itemCount: 60,
  itemBuilder: (BuildContext context, int index) => SizedBox(height: 48, child: Text('第 $index 行')),
)
```

第一段里，`SingleChildScrollView` 眼里只有一个孩子（那个 `Column`），60 个 item 是 `Column` 的家务事；第二段里，"有几个孩子、要造哪几个"是滚动容器自己的事。这个区别就是本文后面所有代价的来源。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/single_child_scroll_view.dart:147` | `class SingleChildScrollView extends StatelessWidget`，**无状态**的公开入口 |
| `widgets/single_child_scroll_view.dart:159` | `this.clipBehavior = Clip.hardEdge,`，公开的默认裁剪策略 |
| `widgets/single_child_scroll_view.dart:261` | `Widget scrollable = Scrollable(`，内部唯一的滚动宿主，位置由它创建 |
| `widgets/single_child_scroll_view.dart:269` | `viewportBuilder:`，把 `ViewportOffset`（即 position）交给内容侧的唯一回调 |
| `widgets/single_child_scroll_view.dart:306` | `class _SingleChildViewport extends SingleChildRenderObjectWidget` |
| `widgets/single_child_scroll_view.dart:342` | `class _SingleChildViewportElement ... with NotifiableElementMixin, ViewportElementMixin` |
| `widgets/single_child_scroll_view.dart:347` | `class _RenderSingleChildViewport extends RenderBox ... implements RenderAbstractViewport` |
| `widgets/single_child_scroll_view.dart:497` | `void performLayout()`，唯一 child 的那一次完整 layout |

锚点里已经埋了本文的全部结论：`StatelessWidget` + 内部 `Scrollable` + 一个 `RenderBox` 视口。行号会漂移，但"类名 + 调用关系"不会。

## 四、调用链

### 4.1 一次 `build`：无状态的组件把位置交给 `Scrollable`

`SingleChildScrollView.build`（`:247`）从头到尾只做四件事，没有一行和"偏移量"有关：

```dart
// single_child_scroll_view.dart:247-259（节选）
Widget build(BuildContext context) {
  final AxisDirection axisDirection = _getDirection(context);
  Widget? contents = child;
  if (padding != null) {
    contents = Padding(padding: padding!, child: contents);   // 1. padding 包在内容外面
  }
  final bool effectivePrimary =
      primary ?? controller == null && PrimaryScrollController.shouldInherit(context, scrollDirection);
  final ScrollController? scrollController = effectivePrimary
      ? PrimaryScrollController.maybeOf(context)
      : controller;                                          // 2. 决定位置挂在哪个 controller 上
```

这里有两点需要分清：

- **`padding` 不是视口的属性**。它被包成最外面的一层 box child（`:249-251`），所以 `padding` 的大小会算进内容总高，滚动到底时最后一段就是这块 padding。
- **`primary` 会劫持 controller 来源**。`primary: true` 或"没传 controller 且祖先提供 `PrimaryScrollController`"时（`:253-255`），用的是继承来的 controller，不是字段里那个。构造函数对此还有一条断言：`controller != null && primary == true` 直接报错（`:163-168`）。

然后是那句关键的构造：

```dart
// single_child_scroll_view.dart:261-276（节选）
Widget scrollable = Scrollable(
  dragStartBehavior: dragStartBehavior,
  axisDirection: axisDirection,
  controller: scrollController,      // ← position 由 Scrollable 的老机制创建（第 45 篇）
  physics: physics,
  restorationId: restorationId,
  clipBehavior: clipBehavior,
  hitTestBehavior: hitTestBehavior,
  viewportBuilder: (BuildContext context, ViewportOffset offset) {
    return _SingleChildViewport(
      axisDirection: axisDirection,
      offset: offset,                // ← 滚动位置从这里进入内容侧
      clipBehavior: clipBehavior,
      child: contents,
    );
  },
);
```

`SingleChildScrollView` 自己**不创建也不持有**滚动位置。它只是把 `physics` / `controller` / `axisDirection` 这些配置转交给 `Scrollable`，由 `ScrollableState._updatePosition`（`scrollable.dart:617`）去造位置（第 45 篇）。这就是"无状态组件也能滚"的全部答案——状态在它下面的 `ScrollableState`（`State` 对象）里；`Scrollable` 是 `StatefulWidget`，但位置引用实际保存在它的 `State` 中。

`build` 的末尾还有两个可选包装，都不影响内容布局：`keyboardDismissBehavior` 为 `onDrag` 时套一层 `NotificationListener<ScrollUpdateNotification>` 用于收起键盘（`:279-296`）；`primary` 生效时返回 `PrimaryScrollController.none(child: scrollable)`（`:298-301`），防止后代再继承同一个 `PrimaryScrollController`。

### 4.2 `viewportBuilder`：内容侧的全部源码只有十来行

`Scrollable` 在 `scrollable.dart:1038` 调用 `widget.viewportBuilder(context, position)`，第二个参数就是 `ScrollPosition`（它是 `ViewportOffset` 的子类，第 45 篇 4.2）。回调返回 `_SingleChildViewport`：

```dart
// single_child_scroll_view.dart:306-345（节选）
class _SingleChildViewport extends SingleChildRenderObjectWidget {
  final AxisDirection axisDirection;   // 默认 AxisDirection.down
  final ViewportOffset offset;         // 只有接口，不知道具体是 ScrollPosition
  final Clip clipBehavior;

  @override
  _RenderSingleChildViewport createRenderObject(BuildContext context) {
    return _RenderSingleChildViewport(
      axisDirection: axisDirection,
      offset: offset,
      clipBehavior: clipBehavior,   // 1. 公开默认值 Clip.hardEdge 从这里传下去（:273 → :319-324）
    );
  }

  @override
  void updateRenderObject(BuildContext context, _RenderSingleChildViewport renderObject) {
    renderObject
      ..axisDirection = axisDirection   // 顺序有依赖：offset setter 要读 axisDirection
      ..offset = offset
      ..clipBehavior = clipBehavior;    // 2. widget 变化时继续同步（:328-334）
  }

  @override
  SingleChildRenderObjectElement createElement() {
    return _SingleChildViewportElement(this);
  }
}

class _SingleChildViewportElement extends SingleChildRenderObjectElement
    with NotifiableElementMixin, ViewportElementMixin {  // 3. 让自己被当成 viewport 对待
  _SingleChildViewportElement(_SingleChildViewport super.widget);
}
```

`_SingleChildViewportElement` 混入的 `ViewportElementMixin`（`scroll_notification.dart:52`）只有一个作用：给经过它的 `ViewportNotificationMixin` 通知加一层深度，让 `ScrollNotification.depth` 算得对。sliver 侧的 `Viewport` 用的也是同一个 mixin（`widgets/viewport.dart:269`）——也就是说在这个通知体系里，一个 box 视口和 sliver 视口被一视同仁。

### 4.3 `performLayout`：唯一 child 的一次完整布局

这是整个组件"朴素"的核心，一共二十行：

```dart
// single_child_scroll_view.dart:497-516
void performLayout() {
  final BoxConstraints constraints = this.constraints;
  if (child == null) {
    size = constraints.smallest;                                          // 1. 没内容就最小尺寸
  } else {
    child!.layout(_getInnerConstraints(constraints), parentUsesSize: true); // 2. 唯一一次 child layout
    size = constraints.constrain(child!.size);                            // 3. 视口尺寸 = 父约束下的 child 尺寸
  }

  if (offset.hasPixels) {                                                 // 4. 越界就就地校正
    if (offset.pixels > _maxScrollExtent) {
      offset.correctBy(_maxScrollExtent - offset.pixels);
    } else if (offset.pixels < _minScrollExtent) {
      offset.correctBy(_minScrollExtent - offset.pixels);
    }
  }

  offset.applyViewportDimension(_viewportExtent);                          // 5. 告诉 position 视口多长
  offset.applyContentDimensions(_minScrollExtent, _maxScrollExtent);       // 6. 告诉 position 内容多长
}
```

第 2 步的约束由 `_getInnerConstraints` 给出（`:455-460`）：

```dart
// single_child_scroll_view.dart:455-460
BoxConstraints _getInnerConstraints(BoxConstraints constraints) {
  return switch (axis) {
    Axis.horizontal => constraints.heightConstraints(),
    Axis.vertical => constraints.widthConstraints(),   // 纵向滚动：宽约束照旧，高度放开
  };
}
```

而 `BoxConstraints.widthConstraints()` 的定义是 `BoxConstraints(minWidth: minWidth, maxWidth: maxWidth)`（`rendering/box.dart:255`）——**`minHeight` 为 0、`maxHeight` 为 Infinity**。

> 纵向 `SingleChildScrollView` 传给唯一 child 的高度约束是**无界**的。
> 这就是"一次性布局"的机制来源：`Column` 拿到无界高度，只能把每个孩子都排一遍，把总高报回来；
> viewport 拿这个总高算出 `maxScrollExtent = child!.size.height - size.height`（`_maxScrollExtent`，`:444-453`）。
> 换句话说，**"能滚多远"在第一次布局时就已经确定了**，而不是滚动过程中慢慢算出来的。

第 5、6 步是 viewport 与 position 的固定对话，`RenderViewport` 用的也是这两个方法（第 45 篇 4.2）。区别只在于：box 视口的这两个值全是本地算的，不涉及任何 sliver 的累加。

### 4.4 滚动时发生什么：只重绘，不重新布局

`_RenderSingleChildViewport` 在 `attach` 时把自己注册成 offset 的监听者（`:417-419`）：

```dart
// single_child_scroll_view.dart:402-404
void _hasScrolled() {
  markNeedsPaint();               // ← 只是重画
  markNeedsSemanticsUpdate();
}
```

对比 `RenderViewport` 注册的是 `markNeedsLayout`（`rendering/viewport.dart:539`、`:688`）。

滚动中的 `SingleChildScrollView` **不会重新布局**。它只改绘制偏移（`_paintOffset`，`:518`；`paint` 里 `context.paintChild(child!, offset + paintOffset)`，`:550`），然后重画自己这一层。代价被提前支付了：内容早就全部建好、全部布局好，只是画在了视口外面。

这也顺带解释了为什么它是 repaint boundary：`_RenderSingleChildViewport` 覆写了 `isRepaintBoundary => true`（`:429`）。滚动引起的重绘被关在这一层里，不会往上传（第 35 篇的结论在这里的具体落点）。

### 4.5 完整链路

```text
SingleChildScrollView(child: Column)         single_child_scroll_view.dart:147
  └─ build()                                  :247
       ├─ padding != null → Padding 包住 contents          :249
       ├─ Scrollable(controller: scrollController,
       │             viewportBuilder: ...)                :261
       │    └─ ScrollableState._updatePosition()          scrollable.dart:617
       │         └─ controller.createScrollPosition(...)  → ScrollPositionWithSingleContext
       │    └─ build(): viewportBuilder(context, position) scrollable.dart:1038
       │         └─ _SingleChildViewport(offset: offset)   :270
       │              └─ createElement() → _SingleChildViewportElement   :337 / :342
       │              └─ createRenderObject() → _RenderSingleChildViewport  :319 / :347
       └─ 其余包装：keyboardDismissBehavior / PrimaryScrollController.none  :279 / :298

第一次 layout
  └─ _RenderSingleChildViewport.performLayout()            :497
       ├─ child!.layout(widthConstraints())  高度无界       :502 / :455
       ├─ size = constraints.constrain(child!.size)         :503
       └─ offset.applyViewportDimension / applyContentDimensions  :514 / :515

滚动（拖拽 / jumpTo / animateTo）
  └─ ScrollPosition.setPixels → notifyListeners()          scroll_position.dart:366
       └─ _RenderSingleChildViewport._hasScrolled()        :402
            └─ markNeedsPaint()  → paint 里换 _paintOffset  :550 / :518
```

## 五、核心对象：box 视口 vs sliver 视口

两者都叫 viewport、都实现 `RenderAbstractViewport`、都拿到了同一个 `ViewportOffset`，但职责完全不同：

| | `_RenderSingleChildViewport`（本文） | `RenderViewport`（第 47 篇） |
|---|---|---|
| 声明 | `extends RenderBox ... implements RenderAbstractViewport`（`:347-349`） | `extends RenderViewportBase`，孩子必须是 `RenderSliver` |
| 孩子数量 | 至多 1 个 `RenderBox`（`child == null` 时为 0 个，`:497-500`） | N 个 sliver |
| 布局输入 | `BoxConstraints` | `SliverConstraints` |
| 布局方式 | 一次 `child!.layout(...)`（`:502`），拿回的总高就是内容长度 | `layoutChildSequence` 逐个下发约束（`rendering/viewport.dart:785`） |
| 内容长度来源 | `child!.size`（`:503`） | 各 sliver 的 `SliverGeometry.scrollExtent` 累加 |
| offset 监听回调 | `_hasScrolled` → `markNeedsPaint`（`:402-404`、`:419`） | `markNeedsLayout`（`rendering/viewport.dart:539`、`:688`） |
| 缓存 / 懒加载 | **没有**：`_RenderSingleChildViewport` 里不存在 `cacheExtent` | `cacheOrigin` + `remainingCacheExtent` 决定建哪些 child（第 48 篇） |
| 裁剪 | 自己判断 `_shouldClipAtPaintOffset`（`:529`）再 `pushClipRect`（`:554`） | 由 sliver 上报的 `SliverGeometry.hasVisualOverflow` 汇总决定是否需裁（`rendering/viewport.dart:1859-1860`），再受 viewport 的 `clipBehavior` 控制（`:973`） |
| 反向求偏移 | 实现了 `getOffsetToReveal`（`:607`） | 同族方法在 `RenderViewportBase` |

一句话概括这张表：**`RenderViewport` 是"约束分发器"（第 47 篇），`_RenderSingleChildViewport` 是"一张会滑动的画布"**。前者把"要建哪些孩子"变成每次布局的输入，后者把"孩子长什么样"当成布局前就定好的既成事实。

## 六、源码实验

三组实验都在临时工程的 widget test 里跑（`flutter test`），输出用 `LAB` 打印。视口统一 400×400。

### 实验 1：内容路径是 `RenderBox`，不是 `RenderSliver`

```dart
// 计数器：每建一个 item 就 +1
int builtItems = 0;

class CountingItem extends StatelessWidget {
  const CountingItem(this.index, {super.key});

  final int index;

  @override
  Widget build(BuildContext context) {
    builtItems++;
    return SizedBox(height: 100, child: Text('item $index'));
  }
}

await tester.pumpWidget(wrap(                     // wrap = Directionality + Center + SizedBox(400, 400)
  SingleChildScrollView(
    controller: controller,
    child: Column(children: List<Widget>.generate(10, (int i) => CountingItem(i))),  // 每项高 100
  ),
));
final RenderObject viewport = tester.allRenderObjects.firstWhere(
  (RenderObject r) => r is RenderAbstractViewport,
);
print('viewport=${viewport.runtimeType} '
    'isRenderBox=${viewport is RenderBox} isRenderSliver=${viewport is RenderSliver} '
    'isRepaintBoundary=${viewport.isRepaintBoundary}');
print('sliverCountInTree=${tester.allRenderObjects.whereType<RenderSliver>().length}');
final RenderFlex column = tester.allRenderObjects.whereType<RenderFlex>().first;
print('columnConstraints=${column.constraints}');
```

**预测**：视口既然是 `RenderBox`，整棵树里应该一个 sliver 也没有。

**实际**（输出）：

```text
LAB1 viewport=_RenderSingleChildViewport isRenderBox=true isRenderSliver=false isRepaintBoundary=true
LAB1 sliverCountInTree=0
LAB1 viewportSize=Size(400.0, 400.0)
LAB1 columnConstraints=BoxConstraints(w=400.0, 0.0<=h<=Infinity)
LAB1 position=ScrollPositionWithSingleContext pixels=0.0 viewportDimension=400.0 max=600.0 controllerPositions=1
```

**说明**：这几行输出对应本文三个结论。`sliverCountInTree=0` 说明 `SingleChildScrollView` 的内容侧完全没有 sliver 参与；`columnConstraints` 的高度上界是 `Infinity`，正是 `_getInnerConstraints`（`:455`）+ `widthConstraints()`（`rendering/box.dart:255`）的直接结果；`position` 那一行说明滚动位置这条链和 `ListView` 是**同一套**（`ScrollPositionWithSingleContext`，第 45 篇实验 2 出现过同一个类型），`max=600` 恰好是内容 1000 减去视口 400。

### 实验 2：同样 200 个 item，两边的 build 次数

A 组用 `SingleChildScrollView + Column`，B 组用 `ListView.builder`，item 数量、item 高度、视口尺寸全部相同，item 里放一个计数器统计 `build` 被调用了几次。

```dart
// A 组：滚动容器只有一个 box child
await tester.pumpWidget(wrap(
  SingleChildScrollView(
    controller: controller,
    child: Column(children: List<Widget>.generate(200, (int i) => CountingItem(i))),
  ),
));

// B 组：200 个孩子由 sliver 按区间请求
await tester.pumpWidget(wrap(
  ListView.builder(
    controller: controller,
    itemCount: 200,
    itemBuilder: (BuildContext context, int i) => CountingItem(i),
  ),
));
```

```text
LAB2 A(SingleChildScrollView + Column) 首次 pump 后 builds=200
LAB2 A(Column) jumpTo(5000) 后 builds=200
LAB2 B(ListView.builder) 首次 pump 后 builds=7
LAB2 B(list builder) jumpTo(5000) 后 builds=57
LAB2 B(list builder) 新增 index 区间 = 7..56（连续 50 个）
```

**预测**：A 组会一次建完所有 item；B 组只建可见的那几个。

**实际**：A 组首次挂载就把 200 个 item 全建了，之后再滚也不增加；B 组首次只建 7 个。

**说明**：A 组的 200 就是本节最贵的那个数字——**"内容总高"必须先知道，而 `Column` 只能靠把每个孩子都量一遍才知道**（`:502`）。B 组首次的 7 个是 `(视口 400 + 默认 cacheExtent 250) / 100 = 6.5` 向上取整的结果（`defaultCacheExtent` 在 `rendering/viewport.dart:289`），完整算法是第 48 篇的 `RenderSliverList.performLayout`（`rendering/sliver_list.dart:46`、`:53-55`），本文不重复。

第四行的 57 需要额外解释，否则很容易读错：`jumpTo(5000)` 时列表里只存在 index 0..6 的 child，而 `RenderSliverList` 是**从当前 anchor 向后逐个 `advance()`** 才能到达 5000 的：

```dart
// rendering/sliver_list.dart:262-263
while (endScrollOffset < scrollOffset) {
  leadingGarbage += 1;
```

所以它从 index 7 一路补建到 56（50 个），累计从 7 变成 57。**"懒"不等于"滚动一定便宜"**：一次跨屏跳转会让 sliver 顺着 index 补建一段再回收，这段代价在第 48 篇的回收机制里才讲得完整；本文只需要它说明一件事——B 组的 build 次数是**随滚动发生**的，A 组的那 200 次是**挂载时就付清**的。

### 实验 3：只有 `Clip.none` 真的关掉了裁剪

`clipBehavior` 有两个容易看错的默认值：**公开的 `SingleChildScrollView` 默认是 `Clip.hardEdge`（`:159`）**，而 render object 里字段的初始化值是 `Clip.none`（`:393`）——后者只是"没人设过它时的兜底"，正常路径一定被 widget 覆盖（`:273` → `:319-324`）。

用同一个内容远超视口的 child（40 个高 50 的色块，总高 2000），只改 `clipBehavior`，数一数层树里的 `ClipRectLayer`：

```text
LAB3 clip=Clip.hardEdge 未滚动 clipLayers=1
LAB3 clip=Clip.hardEdge 滚到 500 clipLayers=1 describeApproximatePaintClip=Rect.fromLTRB(0.0, 0.0, 400.0, 400.0)
LAB3 clip=Clip.none      未滚动 clipLayers=0
LAB3 clip=Clip.none      滚到 500 clipLayers=0 describeApproximatePaintClip=null
```

**预测**：`Clip.none` 时不裁剪，`Clip.hardEdge` 时滚出视口的部分被切掉。

**实际**：`Clip.hardEdge` 下**没滚动时就已经有裁剪层**，且裁剪矩形始终是 `0,0,400,400`。

**说明**：裁剪的判断在 `_shouldClipAtPaintOffset`（`:529-545`）：

```dart
// single_child_scroll_view.dart:529-545（节选）
bool _shouldClipAtPaintOffset(Offset paintOffset) {
  assert(child != null);
  switch (clipBehavior) {
    case Clip.none:
      return false;                                    // 直接放弃裁剪
    case Clip.hardEdge:
    case Clip.antiAlias:
    case Clip.antiAliasWithSaveLayer:
      return paintOffset.dx < 0 ||
          paintOffset.dy < 0 ||
          paintOffset.dx + child!.size.width > size.width ||
          paintOffset.dy + child!.size.height > size.height;
  }
}
```

判据是"**内容是否超出视口 / 偏移是否为负**"，不是"是否正在滚"。所以内容本来就比视口长时，未滚动也满足条件；`Clip.none` 则直接 `return false`，无论溢出多少都不裁，超出的部分照样会被画到视口外面去（`paint` 里的分支：`:553-565`，只有判断为真才 `pushClipRect`）。同一个判断还被 `describeApproximatePaintClip`（`:585`）复用，所以它在 `Clip.none` 下返回 `null`——这就是"没有裁剪"在公开 API 侧的可见表现。

## 七、结论

1. **`SingleChildScrollView` 的"无状态"是真的，但滚动状态一点没少**。它是 `StatelessWidget`（`:147`），`build` 把 `physics` / `controller` / `viewportBuilder` 全转交给内部的 `Scrollable`（`:261`），位置照旧由 `ScrollableState._updatePosition`（`scrollable.dart:617`）造在 `ScrollPosition` 里。滚动位置的机制与 `ListView` 完全共用，第 45 篇讲的每一条都适用于它。
2. **内容侧是一条 `RenderBox` 链，不是 sliver 链**。`_SingleChildViewport`（`:306`）→ `_RenderSingleChildViewport`（`:347`）→ `performLayout` 里的**一次** `child!.layout(_getInnerConstraints(constraints), parentUsesSize: true)`（`:502`）。纵向时这个子约束的高度是 `Infinity`（`:455` + `rendering/box.dart:255`），`Column` 必须把每个孩子排完才能报总高，`maxScrollExtent` 由此定死（`:444-453`）。它也没有任何懒加载开关：`cacheExtent` 在这个类里不存在。
3. **代价换来了简单**：滚动只触发 `markNeedsPaint`（`:402-403`），不重新布局；视口自己是 repaint boundary（`:429`）。反过来，`_RenderSingleChildViewport` 在滚动期间"什么都不用建"，是因为它在挂载时已经全建好了。所以 `SingleChildScrollView + Column` **不等于** `ListView`——前者适合"内容有限、确定要全部存在"的场景，后者适合"数量不明或很大、只需要看得见的部分"的场景。

**`SingleChildScrollView` 是"把整棵 box 子树一次性铺开、再让视口在上面滑动"的最薄实现——滚动的状态机照旧借用 `Scrollable`，代价则在第一次布局时就全部付清。**

## 八、边界声明

- 本文只讲这一个组件的结构、布局代价与裁剪。**`Scrollable` 怎么建 `ScrollPosition`、controller 怎么转发**，第 45 篇已经讲完，这里只引用不重复。
- **`ScrollActivity` 状态机与 `ScrollPhysics` 物理**（谁在松手后衰减、`applyBoundaryConditions` 怎么算越界量）是第 46 篇，本文不展开。
- **sliver 协议本身**（`SliverConstraints` / `SliverGeometry` 的字段语义、`layoutChildSequence`）是第 47 篇，本文只在第五节做 box / sliver 两种视口的职责对照。
- **懒加载**（`SliverMultiBoxAdaptor`、`cacheExtent`、`keepAlive` 桶）是第 48 篇。本文实验 2 里 `ListView.builder` 的那 7 个和 57 个只用来对照"谁在什么时候 build"，算法的完整推导在第 48 篇。
- `Column` 作为唯一的 box child 如何分配主轴空间、overflow 怎么判定，是第 34 篇（`RenderFlex`）的内容，本文只用"它会排完所有孩子"这一个结论。
- 同文件里的 `getOffsetToReveal`（`:607`，`Scrollable.ensureVisible` 的底层）与 `showOnScreen`（`:645`）属于"反向求偏移量"，需要时按方法名读，本文不展开。
- 不展开：`NestedScrollView` 与它的 coordinator、`PageView` / `GridView` 这类同族组件、横向滚动与 `AxisDirection` 的四种取值组合、二维滚动（`TwoDimensionalScrollView`），以及 SDK 里没有源码的 engine 与 Dart VM 部分。
