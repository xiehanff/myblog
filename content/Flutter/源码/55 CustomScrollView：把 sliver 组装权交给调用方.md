# 55 CustomScrollView：把 sliver 组装权交给调用方

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/scroll_view.dart`（2235 行）、`packages/flutter/lib/src/widgets/sliver.dart`（1924 行）、`packages/flutter/lib/src/widgets/basic.dart`（8573 行）、`packages/flutter/lib/src/rendering/viewport.dart`（2261 行）、`packages/flutter/lib/src/rendering/object.dart`（6773 行）

## 一、问题

### CustomScrollView 到底解决哪一层问题

一个页面里同时要有：顶部一块自定义 header、中间一条长列表、下面一片三列网格，三者共用同一根滚动轴，一起上下滚。

用 `ListView` 拼不出来：它的孩子是 box，塞 `GridView` 进去只会得到两个各自独立滚动的区域；要让它看起来像一整块，通常得给内层加 `shrinkWrap: true` 加 `NeverScrollableScrollPhysics`。这两个开关各管一段，不能合起来当"取消懒加载"用：`NeverScrollableScrollPhysics` 只禁止用户拖动（`widgets/scroll_physics.dart:979`，`allowUserScrolling => false`），不改变构建范围；`shrinkWrap: true` 才会改用 `ShrinkWrappingViewport`（`scroll_view.dart:480-487`）。而 `ShrinkWrappingViewport` 从外层 sliver 拿到的 box 约束，主轴是**无界**的——外层 `SliverList` 用 `constraints.asBoxConstraints()` 给孩子发约束（`rendering/sliver_list.dart:56`），这个方法的主轴 `maxExtent` 默认就是 `double.infinity`（`rendering/sliver.dart:483-486`）；`RenderShrinkWrappingViewport.performLayout` 遇到主轴无限时源码写得很直白：`If mainAxisExtent is infinite, it builds everything anyway, so we don't need any extra cache.`，并把 cache 置零（`rendering/viewport.dart:2153-2157`）。**所以这种嵌套写法可能失去懒加载**：外层 sliver 给出无界主轴约束时，内层会把内容全部构建；只有主轴有界（例如外层换成传 `minExtent = maxExtent = extent` 的 `SliverFixedExtentList`，`rendering/sliver_fixed_extent_list.dart:270`）时，才回到由 `remainingCacheExtent`（`rendering/viewport.dart:2170`，`mainAxisExtent + 2 * _calculatedCacheExtent!`）与缓存区决定生成范围（第 48 篇）。

`CustomScrollView` 回答的问题只有一个：**这个视口里放哪些 sliver、按什么顺序排，由调用方自己决定。** 它不解决"内容多长""怎么懒加载""松手后怎么衰减"——那些在第 47、48 篇。

### 先拆掉两个错误直觉

**直觉一：`CustomScrollView` 是 `ListView` 的高级版。** 反了。两者不是版本关系，而是同一个父类的两个分支：`CustomScrollView extends ScrollView`（`scroll_view.dart:718`），`ListView` 则走 `ListView extends BoxScrollView`（`:1288`）→ `BoxScrollView extends ScrollView`（`:867`）。共同的外壳是 `ScrollView`（`:95`），分叉点是 `BoxScrollView`。`CustomScrollView` 没有新增任何字段——翻遍它的类体，只多了一个 `final List<Widget> slivers;`（`:845`），其余的滚动方向、physics、controller 全部来自 `super`。

**直觉二：往 `slivers` 里放 `Container` 会导致编译不通过。** 也不会。`slivers` 的静态类型就是 `List<Widget>`：

```dart
// scroll_view.dart:845
final List<Widget> slivers;
```

`Container` 是 `Widget`，类型检查这一关过得去。真正拒绝它的是渲染树装配时的 debug 断言——那是运行期的事，第六节给出断言原文。

> **关键认知**：`CustomScrollView` 不新增机制。`ScrollPosition`、`ScrollActivity`、`ScrollPhysics`（第 45、46 篇）它一个都没有自己的版本，sliver 协议（第 47 篇）也不是它定义的。它做的事只有一件：把"组装 slivers"这件事从框架手里交回调用方。

## 二、最小 Demo

### 2.1 三个 sliver 串成一个滚动视图

```dart
import 'package:flutter/material.dart';

class FeedPage extends StatelessWidget {
  const FeedPage({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: <Widget>[
        // 1. 组装外层 sliver：一个普通 box 被包成 sliver，放在最前面
        const SliverToBoxAdapter(
          child: SizedBox(
            height: 120,
            child: ColoredBox(color: Colors.blue),
          ),
        ),
        // 2. 列表：SliverPadding 本身是 sliver，被 padding 的那个 sliver 从 sliver 参数进去
        SliverPadding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          sliver: SliverList.builder(
            itemCount: 20,
            itemBuilder: (BuildContext context, int index) {
              return ListTile(title: Text('item $index'));
            },
          ),
        ),
        // 3. 网格：与上面的列表平级，先后顺序完全由这个 List 决定
        SliverGrid.count(
          crossAxisCount: 3,
          children: List<Widget>.generate(
            9,
            (int index) => ColoredBox(color: Colors.green, child: Center(child: Text('$index'))),
          ),
        ),
      ],
    );
  }
}
```

三个 sliver 依次排进同一个 `slivers` 列表：`SliverToBoxAdapter`、`SliverPadding`、`SliverGrid` 是 `CustomScrollView` 的顶层 slivers，顶层顺序由 `slivers` 列表决定；但 `SliverPadding` 通过 `sliver` 参数包住 `SliverList`（`basic.dart:3962`），因此这一对存在一层 sliver 父子嵌套。"谁在谁上面"完全由列表顺序表达——这正是"组装权在调用方"的字面含义。

三个类型都属于同一族：`SliverToBoxAdapter` / `SliverPadding` 在 `basic.dart:3939` / `:3960`，`SliverList` / `SliverGrid` 在 `sliver.dart:167` / `:733`。共同点是它们的 `createRenderObject` 返回的都是 `RenderSliver` 子类（`basic.dart:3944`、`:3968`、`sliver.dart:381`、`:890`）。

### 2.2 故意放错一个 Container

```dart
// 能编译；debug 模式运行到这一帧时抛断言
CustomScrollView(
  slivers: <Widget>[
    Container(height: 120, color: Colors.blue),
  ],
)
```

字面上这段代码的问题是"`Container` 不是 sliver"，但源码给出的理由要更精确：`Container` 最外层生成的是 `RenderBox` 子类（`Container` 在 `build` 的末尾才把 `constraints` 包上去，`widgets/container.dart:433-435`），而 viewport 只收 `RenderSliver`。这条边界写在渲染层，不写在 widget 层。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/scroll_view.dart:95` | `abstract class ScrollView extends StatelessWidget`，三种滚动视图的共同外壳 |
| `widgets/scroll_view.dart:440` | `List<Widget> buildSlivers(BuildContext context);`，子类唯一必须实现的 hook |
| `widgets/scroll_view.dart:503` | `ScrollView.build`：先调 `buildSlivers`，再把结果闭进 `Scrollable.viewportBuilder` |
| `widgets/scroll_view.dart:718` / `:845` / `:848` | `class CustomScrollView` / `final List<Widget> slivers;` / `buildSlivers => slivers`，原样透传 |
| `widgets/scroll_view.dart:867` / `:898` | `abstract class BoxScrollView` / 它的 `buildSlivers` 返回**单元素** `List<Widget>`，分叉点在这里 |
| `widgets/scroll_view.dart:1288` / `:1964` | `class ListView extends BoxScrollView` / `class GridView extends BoxScrollView` |
| `widgets/basic.dart:3939` / `:3960` | `SliverToBoxAdapter`（把一个 box 包成 sliver）/ `SliverPadding`（把 padding 套在另一个 sliver 上） |
| `rendering/viewport.dart:410` | `RenderViewportBase` 混入 `ContainerRenderObjectMixin<RenderSliver, ParentDataClass>`，孩子类型在渲染层被钉死 |

行号会漂移，类名与调用关系不会：真正要记住的是 `ScrollView` → `CustomScrollView` / `BoxScrollView` 这个"一个外壳、两个分支"的形状。

## 四、调用链

### 4.1 共同外壳：`ScrollView.build` 先取 slivers，再造 `Scrollable`

`CustomScrollView` 与本篇相关的代码只有两行（`:718`、`:845`），剩下的都在基类里。基类的 `build` 是整个系列最整齐的一段：

```dart
// scroll_view.dart:503-528（节选）
Widget build(BuildContext context) {
  final List<Widget> slivers = buildSlivers(context);   // 1. 先拿到 slivers
  final AxisDirection axisDirection = getDirection(context);
  // ...
  final scrollable = Scrollable(
    // ...
    viewportBuilder: (BuildContext context, ViewportOffset offset) {
      return buildViewport(context, offset, axisDirection, slivers);  // 2. 闭进 builder
    },
    clipBehavior: clipBehavior,
  );
```

两个 hook 的分工非常清楚：

- `buildSlivers`（`:440`）返回 `List<Widget>`，是**本篇的主题**；
- `buildViewport`（`:456-500`）拿到 `ViewportOffset` 和上面那份 slivers，负责把它们放进一个 viewport widget。

注意 `buildSlivers` 是**在 `Scrollable` 之前**调用的：slivers 是普通 widget 列表，先建好，再作为闭包的一部分交给 `Scrollable` 在需要时构建 viewport。

### 4.2 分叉一：`CustomScrollView` 只是把 slivers 原样交出去

```dart
// scroll_view.dart:848
List<Widget> buildSlivers(BuildContext context) => slivers;
```

整个方法体就是字段名。这里是全篇最值得盯着看的一行：**`CustomScrollView` 对 sliver 列表不做任何加工**——不排序、不包装、不补 padding、不按 MediaQuery 缩进。列表里写的是什么，viewport 的孩子就是什么。

### 4.3 分叉二：`BoxScrollView` 把单个 box 子树包成一个 sliver

`BoxScrollView` 走的是另一条路。它自己实现 `buildSlivers`，把子类给的"一个 box 布局模型"包成 sliver，然后**返回只含一个元素的列表**：

```dart
// scroll_view.dart:898-932（节选）
List<Widget> buildSlivers(BuildContext context) {
  Widget sliver = buildChildLayout(context);   // 子类给一个 widget（其实是 sliver）
  EdgeInsetsGeometry? effectivePadding = padding;
  if (padding == null) {
    final MediaQueryData? mediaQuery = MediaQuery.maybeOf(context);
    if (mediaQuery != null) {
      // 主轴方向的 padding 交给 SliverPadding，交叉轴方向留给 MediaQuery
      effectivePadding = scrollDirection == Axis.vertical
          ? mediaQueryVerticalPadding
          : mediaQueryHorizontalPadding;
      sliver = MediaQuery(data: /* 只留交叉轴 padding */, child: sliver);
    }
  }
  if (effectivePadding != null) {
    sliver = SliverPadding(padding: effectivePadding, sliver: sliver);
  }
  return <Widget>[sliver];                     // ← 单元素列表
}
```

子类要实现的 hook 换成了 `buildChildLayout`（`:937`），语义是"给我一个布局模型"。`ListView` 的实现按参数选了四种 `SliverList` 家族之一：

```dart
// scroll_view.dart:1696-1707
Widget buildChildLayout(BuildContext context) {
  if (itemExtent != null) {
    return SliverFixedExtentList(delegate: childrenDelegate, itemExtent: itemExtent!);
  } else if (itemExtentBuilder != null) {
    return SliverVariedExtentList(delegate: childrenDelegate, itemExtentBuilder: itemExtentBuilder!);
  } else if (prototypeItem != null) {
    return SliverPrototypeExtentList(delegate: childrenDelegate, prototypeItem: prototypeItem!);
  }
  return SliverList(delegate: childrenDelegate);
}
```

`GridView` 更短，永远只建一个：

```dart
// scroll_view.dart:2232-2233
Widget buildChildLayout(BuildContext context) {
  return SliverGrid(delegate: childrenDelegate, gridDelegate: gridDelegate);
}
```

**所以就 widget 层的产物而言，`ListView` 和 `GridView` 都是一条 `slivers` 列表，长度恒为 1。** 这就是源码文档里那句话的依据：`A ListView is basically a CustomScrollView with a single SliverList in its CustomScrollView.slivers property.`（`scroll_view.dart:1145-1146`，`GridView` 的同款说法在 `:1750-1751`）。

至于 `itemExtent` 选出的 `SliverFixedExtentList` 为什么更省事，那是懒加载的估计问题，在第 48 篇。

### 4.4 第三跳：`Viewport` 的 children 就是 slivers，串行发生在 `RenderViewport`

`buildViewport`（`:456-500`）默认只做一件事——按 `shrinkWrap` 二选一：

```dart
// scroll_view.dart:480-499（节选）
if (shrinkWrap) {
  return ShrinkWrappingViewport(axisDirection: axisDirection, offset: offset, slivers: slivers, ...);
}
return Viewport(axisDirection: axisDirection, offset: offset, slivers: slivers, ...);
```

`Viewport` widget 里，这份列表被直接当成 `children`：

```dart
// widgets/viewport.dart:60-83（节选）
Viewport({
  // ...
  List<Widget> slivers = const <Widget>[],
}) : assert(...),
     super(children: slivers);
```

接着在渲染层，viewport 的父类声明了自己的孩子类型：

```dart
// rendering/viewport.dart:410-413（节选）
abstract class RenderViewportBase<ParentDataClass extends ContainerParentDataMixin<RenderSliver>>
    extends RenderBox
    with ContainerRenderObjectMixin<RenderSliver, ParentDataClass>
    implements RenderAbstractViewport {
```

到这里链路闭合：**调用方组装的 `slivers` 列表，最终变成 `RenderViewport` 的 `RenderSliver` 孩子链**。串行布局在这里发生——`RenderViewport` 把 `layoutChildSequence`（`rendering/viewport.dart:785`）沿孩子链走一遍，每个孩子拿到一份 `SliverConstraints`、交回一份 `SliverGeometry`，累积量再传给下一个（`rendering/viewport.dart:821-874`）。协议字段本身在第 47 篇，这里只确认一件事：**viewport 是按顺序处理的，所以 `slivers` 的顺序就是布局顺序。**

### 4.5 一句话把两条分支合起来看

```text
ScrollView.build (:503)
  └─ buildSlivers (:440)                       ← 唯一的分叉点
       ├─ CustomScrollView: return slivers      (:848)   列表原样上交
       └─ BoxScrollView:    return [sliver]     (:898)   单个 box 子树被包成 sliver
  └─ buildViewport (:456) → Viewport/ShrinkWrappingViewport
       └─ RenderViewport 的孩子链：逐个 sliver 下发 SliverConstraints、读回 SliverGeometry (:785)
```

## 五、核心对象

| 维度 | `CustomScrollView`（`:718`） | `BoxScrollView`（`:867`） |
|---|---|---|
| `buildSlivers` 行为 | 把 `slivers` 字段原样返回（`:848`） | 调 `buildChildLayout` 拿一个 widget，必要时包 `SliverPadding` / `MediaQuery`，返回单元素列表（`:898-932`） |
| sliver 数量 | 调用方写几个就是几个 | 恒为 1 |
| 顺序由谁决定 | 调用方（列表顺序） | 无顺序可言，只有一个 |
| 子类要实现什么 | 什么都不用实现，直接给 `slivers` | 实现 `buildChildLayout`（`:937`），返回单个布局模型 |
| 谁负责自动补 padding | 不补。源码文档明说 `CustomScrollView`s don't automatically avoid obstructions from `MediaQuery` like `ListView`s do（`:1174-1175`） | 用 `SliverPadding` 吃掉主轴 padding，把交叉轴 padding 留在 `MediaQuery` 里 |
| 代表 | `CustomScrollView` | `ListView`（`:1288`）、`GridView`（`:1964`） |

两者共享的行：`ScrollView` 的 `scrollDirection=Axis.vertical`、`reverse=false`、`shrinkWrap=false`、`anchor=0.0`、`clipBehavior=Clip.hardEdge`、`paintOrder=SliverPaintOrder.firstIsTop`（`:107-130`），以及 `buildViewport` 里 `shrinkWrap` 二选一那段（`:480-499`）。

> **关键认知**：`BoxScrollView` 的"顺带加工"是一种便利，不是机制。`ListView` 的 padding 能自动避开刘海，是因为 `BoxScrollView` 替它包了 `SliverPadding` 和 `MediaQuery`；`CustomScrollView` 把这些让给你自己，代价是自己接住。

## 六、源码实验

### 实验 1：把 `Container` 塞进 `slivers`（断言原文）

**改什么**：按 2.2 写 `slivers: <Widget>[Container(height: 120, color: Colors.blue)]`。

**预测**：Dart 类型检查通过；debug 运行期在渲染树装配时报错。

**实际**：报错点在 `MultiChildRenderObjectElement.insertRenderObjectChild`（`widgets/framework.dart:7189-7194`），它插入孩子前先断言：

```dart
// widgets/framework.dart:7192
assert(renderObject.debugValidateChild(child));
```

走进去是 `ContainerRenderObjectMixin.debugValidateChild`（`rendering/object.dart:4411`），失败时抛的 `FlutterError` 里，`ErrorSummary` 的原文是一句模板：

```text
A $runtimeType expected a child of type $ChildType but received a child of type ${child.runtimeType}.
```

放到这条链上，三个占位分别填：`$runtimeType` = `RenderViewport`、`$ChildType` = `RenderSliver`、`${child.runtimeType}` = 那个 box widget 最外层生成的 `RenderBox` 子类名。紧随其后的 `ErrorDescription` 把原因讲得很直白：

```text
RenderObjects expect specific types of children because they coordinate with their children during layout and paint. For example, a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.
```

（两段原文都在 `rendering/object.dart:4178-4187`；`ContainerRenderObjectMixin` 那份同款实现在 `:4415-4424`，viewport 的 slivers 走的正是这一份。）

**说明**：这两句和"`Container` 不是 sliver"是同一个事实的两种说法。断言之所以必须存在，是因为两套协议不兼容：box 协议是 `BoxConstraints` 向下、`Size` 存在对象自己的 `size` 里；sliver 协议是 `SliverConstraints` 向下、结论存在 `geometry` 里，`RenderSliver` 根本没有 `size` 字段（第 47 篇）。`RenderViewportBase` 的 mixin 参数把 `ChildType` 钉成 `RenderSliver`，这个检查只在 debug 打开（`ContainerRenderObjectMixin` 那一份的 `rendering/object.dart:4408-4412` 写明 `Does nothing if assertions are disabled.`；`:4170-4172` 是 `RenderObjectWithChildMixin` 的同名通用实现，不是 viewport 走的路径）；release 下 assertions 被禁用时，这个 `debugValidateChild` 校验不会执行，本篇不进一步推断非法 `RenderObject` 后续会以何种形式失败。

### 实验 2：数一数 `ListView` / `GridView` 各自生成了几个 sliver

**改什么**：读 `BoxScrollView.buildSlivers` 的返回值。

**预测**：不管 `ListView.builder` 里传了多少 `itemCount`，viewport 的孩子只有一个。

**实际**：`return <Widget>[sliver];`（`scroll_view.dart:932`）。`ListView` 走 `buildChildLayout` 的四路分支（`:1696-1707`）选出一个 `SliverList` 家族成员，`GridView` 恒定返回 `SliverGrid(delegate: ..., gridDelegate: ...)`（`:2232-2233`）。两条路径都只产出**一个** sliver。

**说明**：这解释了 `ListView` 与 `CustomScrollView` 的关系不是"能力差一档"，而是"组装权在谁手里"。`CustomScrollView` 里放一个 `SliverList`，效果与 `ListView` 等价；放三个 `SliverList`，就是三条各自独立的列表共享同一根滚动轴——不需要 `shrinkWrap`，也不会因为嵌套丢掉懒加载，因为它压根只有一层 viewport。

### 实验 3：核对 `CustomScrollView` 的构造参数默认值

**改什么**：逐行读 `ScrollView` 与 `CustomScrollView` 的构造函数。

**预测**：`CustomScrollView` 自己只声明 `slivers`。

**实际**：`CustomScrollView` 的构造列表（`:722-747`）里，除 `this.slivers = const <Widget>[]`（`:740`）之外全是 `super.xxx`；默认值来自 `ScrollView`（`:107-130`）：`scrollDirection = Axis.vertical`、`reverse = false`、`shrinkWrap = false`、`anchor = 0.0`、`clipBehavior = Clip.hardEdge`。缓存相关的 `cacheExtent` 已被标 `@Deprecated`（`:733-737`，注释写 "Use scrollCacheExtent instead. This feature was deprecated after v3.41.0-0.0.pre."），取而代之的是 `scrollCacheExtent`（`:369`）。`buildViewport` 里还留着兼容分支：`scrollCacheExtent ?? (cacheExtent != null ? ScrollCacheExtent.pixels(cacheExtent!) : null)`（`:478-479`）。

**说明**：**新写代码直接用 `scrollCacheExtent`，不要再写 `cacheExtent` + `cacheExtentStyle` 那一对。** 这是本地源码与大量现有资料不一致的一处，第 47 篇给过同一结论的渲染层锚点。

## 七、结论

1. `CustomScrollView` 与 `ListView` / `GridView` 同属 `ScrollView`（`scroll_view.dart:95`、`:718`、`:1288`、`:1964`）。分叉点是 `BoxScrollView`（`:867`）：`CustomScrollView` 把 `slivers` 原样返回（`:848`），`BoxScrollView` 把单个 box 布局模型包成 sliver 并返回单元素列表（`:898-932`）。`CustomScrollView` 没有自己的 `ScrollPosition`、`ScrollActivity`、`ScrollPhysics`，也不定义 sliver 协议。
2. `ScrollView.build` 的顺序固定：先 `buildSlivers`，再把结果闭进 `Scrollable.viewportBuilder`，由 `buildViewport` 决定用 `Viewport` 还是 `ShrinkWrappingViewport`（`:503-528`、`:456-500`）。`Viewport` 把这份列表直接交给 `super(children: slivers)`（`widgets/viewport.dart:83`），于是 widget 层的一个 `List<Widget>` 变成 `RenderViewport` 的 `RenderSliver` 孩子链（`rendering/viewport.dart:410-413`）。
3. 真正的串行布局在 `layoutChildSequence`（`rendering/viewport.dart:785`）里：约束沿链向下、几何沿链向上，累积量传给下一个 sliver。**所以 `slivers` 的顺序就是布局顺序**，而"往里塞 box 会失败"只是这条链在 `insertRenderObjectChild`（`widgets/framework.dart:7192`）上做的类型守卫，根因是 `BoxConstraints`/`Size` 与 `SliverConstraints`/`SliverGeometry` 两套协议不通用。

一句话总结：**`CustomScrollView` 不新增任何滚动机制，它只是把"这个视口里放哪些 sliver、按什么顺序"的组装权交回调用方，剩下的串联工作由 viewport 按 `slivers` 的顺序逐个执行。**

## 八、边界声明

- 本篇只追"谁组装 slivers、`ScrollView` 怎么把它们交给 viewport、viewport 怎么按顺序串起来"。**`SliverConstraints` / `SliverGeometry` 的字段语义、`layoutChildSequence` 里累积量的逐个变化，是第 47 篇。**
- **懒加载（`SliverMultiBoxAdaptor`、`cacheExtent` 决定建几个 child、`keepAlive` 桶）是第 48 篇**；本篇只说明 `ListView` 选中了哪个 sliver 类，不展开它的布局算法。
- `ScrollPosition` 怎么持有偏移、`ScrollController` 为什么只是广播站，是第 45 篇；`ScrollActivity` 与 `ScrollPhysics` 是第 46 篇。本篇不重讲。
- `SliverGrid` / `SliverFillRemaining` / `SliverPersistentHeader` 各自的布局与外推算法不展开；需要时按类名读，它们的 `performLayout` 都是第 47 篇 4.5 那套骨架。
- `NestedScrollView` 如何用 `_NestedScrollCoordinator` 协调 inner / outer 两套 position，是第 56 篇；它内部那个 `_NestedScrollViewCustomScrollView` 只是本篇机制的一个使用者。
- `RenderShrinkWrappingViewport`（`rendering/viewport.dart:2003`）的 `maxPaintExtent` 反推算法不在本篇范围内，这里只交代 `shrinkWrap: true` 会选它。
- `TwoDimensionalScrollView`（`ScrollView` 类文档的 See also 里列出，`scroll_view.dart:93`）是另一条正交的分支，本系列不单独展开。
