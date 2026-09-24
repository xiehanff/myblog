# Flutter Sliver / Scroll / Viewport 原理

> 这篇笔记聚焦滚动体系里最容易混淆的几件事：`RenderViewport` 怎么驱动 `RenderSliver`、`SliverConstraints` / `SliverGeometry` 怎么对话、`SliverList` 为什么是懒加载、`keepAlive` 和 `cacheExtent` 到底分别解决什么问题。

## 概念总览

Flutter 的滚动渲染不是“Viewport 直接摆放一堆普通控件”，而是“Viewport 和 Sliver 按一套专门的滚动协议协作”。

### 先记住三个核心名词

- `RenderViewport`：滚动渲染的核心容器，负责把当前滚动位置映射成“哪些 sliver 需要布局、哪些需要绘制”。
- `RenderSliver`：滚动协议下的渲染对象，接收 `SliverConstraints`，回传 `SliverGeometry`。
- `RenderBox`：普通盒模型渲染对象，接收 `BoxConstraints`，回传 `Size`。

### Sliver 协议和 Box 协议的差别

| 维度 | Box 协议 | Sliver 协议 |
| --- | --- | --- |
| 约束输入 | `BoxConstraints` | `SliverConstraints` |
| 结果输出 | `Size` | `SliverGeometry` |
| 核心关注点 | 这个控件有多大 | 这个内容在滚动轴上占多少、画多少、缓存多少 |
| 适用场景 | 普通布局 | 滚动视口、列表、吸顶、懒加载 |

`RenderBox` 只描述“我最终有多大”，而 `RenderSliver` 还必须描述：

- 当前滚动到哪了
- 前面已经消耗了多少滚动距离
- 视口还剩多少可见空间
- 还要预留多少缓存区
- 是否需要滚动修正

这就是为什么 `RenderViewport` 不能直接容纳 `RenderBox`，只能直接容纳 `RenderSliver`。两者的布局协议不一样，Viewport 需要的是“滚动语义”，不是单纯的尺寸结果。

### 盒子内容怎么放进滚动体系

如果你手上是普通 box widget，需要通过适配器接入 sliver 世界，比如：

- `SliverToBoxAdapter`
- `SliverPadding` 只是 sliver 层的间距包装，不是 box 适配器

它们本质上都是在 sliver 协议里包装 box 内容，而不是让 `RenderViewport` 直接认识 `RenderBox`。

## 核心流程

### 1. 滚动位置变化

用户滚动时，`ScrollPosition` / `ViewportOffset` 会变化。这个变化不会直接“改像素”，而是触发 viewport 重新布局。

### 2. RenderViewport 计算当前视口信息

`RenderViewport` 会根据当前滚动偏移、视口大小、缓存范围，生成第一批 `SliverConstraints`，然后顺序交给子 sliver。

常见关键信息包括：

- `scrollOffset`：当前 sliver 需要从哪里开始看
- `precedingScrollExtent`：前面所有 sliver 已经消耗掉的滚动距离
- `remainingPaintExtent`：当前还剩多少可见绘制空间
- `remainingCacheExtent`：当前还剩多少缓存布局空间
- `viewportMainAxisExtent`：视口主轴长度
- `crossAxisExtent`：视口交叉轴长度
- `cacheOrigin`：缓存区起点相对滚动偏移的位置
- `overlap`：前一个 sliver 在视觉上与当前 sliver 重叠的部分

### 3. 每个 Sliver 按需布局

`RenderSliver` 收到约束后，不是先算一个 `Size`，而是先决定：

- 需要布局哪些子节点
- 当前能画出来多少
- 当前滚动轴上总共占多少
- 是否有视觉溢出
- 是否需要修正滚动偏移

这一步是“懒”的关键。以列表为例，sliver 不会无脑把所有 child 都创建完，而是只创建当前可见区和缓存区需要的那部分。

### 4. Sliver 回传几何信息

sliver 会回传 `SliverGeometry`，viewport 再根据这个结果决定下一段 sliver 的约束。

常见字段理解：

- `scrollExtent`：这个 sliver 在滚动轴上总共占了多长（估算值，列表类 sliver 不必数完所有 child 就要先给出）
- `paintExtent`：当前真正能画出来多少（受 `remainingPaintExtent` 限制）
- `layoutExtent`：参与布局消耗的那部分空间（默认等于 `paintExtent`，决定下一个 sliver 从哪里接续）
- `maxPaintExtent`：假如绘制空间无限，总共能画多长（主要供 shrink-wrap 类 viewport 估算尺寸）
- `cacheExtent`：在缓存区里额外消耗了多少空间
- `scrollOffsetCorrection`：需要 viewport 重新校正滚动偏移时使用
- `hasVisualOverflow`：是否存在视觉溢出（决定 viewport 是否需要裁剪）

### 5. viewport 继续推进下一个 sliver

`RenderViewport` 会把前一个 sliver 的几何结果累加起来，再给后续 sliver 派发新的 `SliverConstraints`。整个过程就像“沿着滚动轴切片前进”。

### 6. offscreen child 的去留

子项离开可视区后，可能出现三种情况：

- 直接销毁，后面需要时重新 build
- 被放入 keepAlive 区域，保留状态
- 在缓存区内继续保留布局结果，等待下次快速进入视口

这也是列表性能、内存占用、状态保留三者之间的平衡点。

### 一个典型的组合

```dart
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Header(),
    ),
    SliverList(
      delegate: SliverChildBuilderDelegate(
        (context, index) => ListTile(title: Text('Item $index')),
        childCount: 100,
      ),
    ),
    SliverFixedExtentList(
      itemExtent: 56,
      delegate: SliverChildBuilderDelegate(
        (context, index) => ListTile(title: Text('Fixed $index')),
        childCount: 100,
      ),
    ),
  ],
);
```

## 关键对象/接口

### `RenderViewport` / `RenderViewportBase`

- 滚动视口的核心渲染对象。
- 负责把滚动偏移转成 sliver 约束，并顺序布局子 sliver。
- `cacheExtent` 决定可视区域前后要额外缓存多少内容。
- `cacheExtentStyle` 决定缓存单位是像素还是视口倍率。

### `RenderSliver`

- sliver 协议的基础类。
- 文档里把它描述成“viewport 里的滚动切片”。
- 每次布局都要根据 `SliverConstraints` 计算自己的 `SliverGeometry`。

### `SliverConstraints`

可以把它理解成“Viewport 发给 Sliver 的滚动上下文”。

重点字段：

- `scrollOffset`
- `precedingScrollExtent`
- `overlap`
- `remainingPaintExtent`
- `remainingCacheExtent`
- `viewportMainAxisExtent`
- `crossAxisExtent`
- `cacheOrigin`

它和 `BoxConstraints` 最大的不同是：它不仅关心尺寸，还关心“当前在滚动链条里的位置”。

### `SliverGeometry`

可以把它理解成“Sliver 回给 Viewport 的布局结果”。

最重要的不是某一个值，而是这些值一起表达了：

- 这段内容总长多少
- 当前可见多少
- 当前占用多少布局消耗
- 当前缓存区消耗多少
- 是否需要重算滚动位置

### `SliverList`

- 典型的可变高度列表。
- 适合不知道每个 item 主轴尺寸的场景。
- 依赖 child delegate 懒加载子项。
- 当列表很长时，只有当前需要的孩子会被 build / layout。

### `SliverFixedExtentList`

- 每个 item 主轴尺寸固定的列表。
- 比 `SliverList` 更高效，因为它不需要先测量子项主轴尺寸。
- 固定高度列表优先用它，滚动偏移估算和布局都会更直接。

### `keepAlive`

Flutter 的 lazy list 里，离开视口的子项不一定马上销毁。

关键点：

- `SliverChildBuilderDelegate` 和 `SliverChildListDelegate` 默认支持 `addAutomaticKeepAlives`
- `KeepAlive` 表示这个 child 即使滚出视口，也要保留状态
- `AutomaticKeepAlive` 会根据通知自动包一层 `KeepAlive`

适合 keepAlive 的场景：

- 输入框、草稿表单
- 视频播放器
- 成本较高的状态型子项
- 需要记住局部交互状态的 item

不适合 keepAlive 的场景：

- 普通纯展示 item
- 数量特别多、状态很轻的长列表

### `cacheExtent`

`cacheExtent` 解决的是“提前把即将进入视口的内容布局出来”。

它和 keepAlive 不是一回事：

- `cacheExtent` 管的是“提前布局多远”
- `keepAlive` 管的是“离屏后还保不保留状态”

在 viewport 层面，`cacheExtent` 会把可视区域前后扩展成缓存区，缓存区内的 item 会被布局，即使它们还没真正显示在屏幕上。`CustomScrollView.cacheExtent` 不传时，默认取 `RenderAbstractViewport.defaultCacheExtent`（250 逻辑像素）；直接用 `Viewport` widget 时还可以通过 `cacheExtentStyle` 把单位换成视口倍率。

在 sliver 层面，`SliverGeometry.cacheExtent` 表示这个 sliver 在 `remainingCacheExtent` 上消耗了多少。

如果 `cacheExtent` 过大：

- 预布局更多，内存占用更高
- 首次布局和滚动期间的计算量更大

如果 `cacheExtent` 过小：

- 视口边缘内容来得太晚
- 快速滑动时更容易出现卡顿或白边感

## 常见误区

### 误区 1：Viewport 里面可以直接放任意 RenderObject

不行。`RenderViewport` 的子节点协议就是 sliver 协议，直接吃的是 `RenderSliver`，不是 `RenderBox`。

### 误区 2：SliverList 就是 ListView

不是。`ListView` 只是更高层的封装，本质上还是滚动视图 + sliver 列表。

如果你要混合头部、列表、吸顶、底部占位等内容，应该直接用 `CustomScrollView + slivers`，而不是一直套 `ListView`。

### 误区 3：keepAlive 和 cacheExtent 是同一个东西

不是。

- keepAlive 关注状态是否继续活着
- cacheExtent 关注布局是否提前做

一个是“保状态”，一个是“预布局”。

### 误区 4：SliverFixedExtentList 只是语法糖

不是。它对性能有实际意义，因为固定主轴尺寸能减少测量和估算成本。

### 误区 5：`SliverGeometry.paintExtent` 就是总长度

不是。

- `scrollExtent` 才是总滚动长度
- `paintExtent` 是当前画得出来的部分
- `layoutExtent` 是参与布局消耗的部分
- `cacheExtent` 是缓存区消耗的部分

### 误区 6：列表离屏后一定会立即销毁

不一定。

是否销毁取决于：

- 是否进入 keepAlive bucket
- delegate 是否启用自动保活
- 当前缓存和复用策略

## 面试问法/性能点

### 常见面试问法

1. `RenderViewport` 为什么不能直接装 `RenderBox`？
2. `SliverConstraints` 和 `BoxConstraints` 的根本区别是什么？
3. `SliverGeometry` 里 `scrollExtent`、`paintExtent`、`layoutExtent` 分别表示什么？
4. `SliverList` 为什么能做到懒加载？
5. `SliverFixedExtentList` 为什么通常比 `SliverList` 更省？
6. `keepAlive` 和 `cacheExtent` 有什么区别？
7. 什么场景应该优先用 `CustomScrollView`？

### 列表性能重点

- 能固定高度就固定高度，优先 `SliverFixedExtentList`
- item 尺寸能提前稳定估算时，滚动体验会更平滑
- 纯展示 item 不要滥用 keepAlive
- `cacheExtent` 不是越大越好，要在“预加载”和“内存/布局成本”之间找平衡
- 尽量把复杂子树拆小，避免每个 item 都持有过重状态
- 需要混合头部、列表、吸顶、瀑布流时，直接考虑 sliver 组合，而不是外层嵌套多个滚动容器

### 回收 / 复用怎么理解

Flutter 的“复用”重点不在于传统意义上的 view holder 池，而在于：

- `Element` 是否能通过 `canUpdate` 复用
- child 是否被保留在 keepAlive bucket
- 视口滚动时是否只重新 build 必要部分

所以在 Flutter 里，性能优化通常不是“手动回收 widget”，而是“让框架少建、少测、少画、少重排”。

### 一句面试总结

> `RenderViewport` 通过 sliver 协议把滚动视口切成一段一段的 `RenderSliver`，每个 sliver 用 `SliverConstraints` 接收滚动上下文，用 `SliverGeometry` 回传布局结果；列表性能来自懒加载、固定高度估算、合理的 `keepAlive` 和 `cacheExtent` 控制。

## 参考

### Flutter 官方文档

- [`RenderViewport`](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html)
- [`RenderSliver`](https://api.flutter.dev/flutter/rendering/RenderSliver-class.html)
- [`SliverConstraints`](https://api.flutter.dev/flutter/rendering/SliverConstraints-class.html)
- [`SliverGeometry`](https://api.flutter.dev/flutter/rendering/SliverGeometry-class.html)
- [`RenderViewportBase.cacheExtent`](https://api.flutter.dev/flutter/rendering/RenderViewportBase/cacheExtent.html)
- [`SliverList`](https://api.flutter.dev/flutter/widgets/SliverList-class.html)
- [`SliverFixedExtentList`](https://api.flutter.dev/flutter/widgets/SliverFixedExtentList-class.html)
- [`KeepAlive`](https://api.flutter.dev/flutter/widgets/KeepAlive-class.html)
- [`CustomScrollView.slivers`](https://api.flutter.dev/flutter/widgets/CustomScrollView/slivers.html)
- [docs.flutter.dev：使用 custom sliver 创建滚动效果](https://docs.flutter.dev/ui/layout/scrolling/slivers)

---

## 补充一：center sliver 与 anchor 机制

### center 参数：视口的锚心

`RenderViewport` 的 `center` 参数指定了哪个 sliver 是视口的"中心轴心"。Viewport 在计算滚动偏移时，一切布局都围绕这个 center sliver 展开——center 之前的 sliver 向上布局，center 之后的 sliver 向下布局。

```dart
// RenderViewport 构造函数（简化）
RenderViewport({
  // ...
  this.center,
  this.anchor = 0.0,
}) {
  assert(anchor >= 0.0 && anchor <= 1.0);
}
```

关键点：

- widget 层 `Viewport.center` / `CustomScrollView.center` 的类型是 `Key?`，传的是某个 sliver 的 key；Element 层再按 key 找到对应 child，把它的 `RenderSliver` 设为 render 层的 `RenderViewport.center`
- `RenderViewport.center` 的类型是 `RenderSliver?`
- 它不是"视觉居中"，而是**滚动轴心**——viewport 用它来锚定"当前滚动到哪里了"

### 为什么需要 center

想象一个 `CustomScrollView` 包含 `SliverAppBar` + `SliverList`：

```dart
CustomScrollView(
  slivers: [
    const SliverAppBar(
      expandedHeight: 200,
      floating: true,
      pinned: true,
      flexibleSpace: FlexibleSpaceBar(title: Text('Title')),
    ),
    SliverList(
      delegate: SliverChildBuilderDelegate(
        (context, index) => ListTile(title: Text('Item $index')),
        childCount: 100,
      ),
    ),
  ],
);
```

用户向上滚动时，`SliverAppBar` 从展开状态（200px）收起到 pin 住状态（约 56px）。问题来了：

- SliverAppBar 高度在变化，它消耗的滚动距离也在变
- 列表内容需要跟着移动，但"移动多少"取决于 AppBar 收起了多少
- 这个"以谁为基准来计算偏移"的锚点，就是 center

如果没有 center，viewport 不知道该以哪个 sliver 的滚动偏移为主。AppBar 在变化高度时，列表的位置就会混乱。

### center 的默认值

`CustomScrollView` 构建时会把 `center` 参数透传给 `Viewport`，默认是 `null`：

```dart
// widgets/scroll_view.dart（简化）
Widget buildViewport(
  BuildContext context, ViewportOffset offset,
  AxisDirection axisDirection, List<Widget> slivers,
) {
  return Viewport(
    // center 默认是 null
    center: center,
    anchor: anchor,
    // ...
  );
}
```

key 为 `null` 时的回退发生在 Element 层。`_ViewportElement` 在 mount/update 时解析 center，找不到指定 key 就取第一个 child：

```dart
// widgets/viewport.dart（简化）
void _updateCenter() {
  final viewport = widget as Viewport;
  if (viewport.center != null) {
    for (final Element e in children) {
      if (e.widget.key == viewport.center) {
        renderObject.center = e.renderObject as RenderSliver?;
        break;
      }
    }
  } else if (children.isNotEmpty) {
    // center 为 null → 默认取第一个 sliver
    renderObject.center = children.first.renderObject as RenderSliver?;
  } else {
    renderObject.center = null;
  }
}
```

这意味着：大多数情况下，你不需要手动指定 center，默认行为就是以第一个 sliver 为锚点。

### anchor 参数：滚动锚点

`anchor` 控制的是"center sliver 的哪个位置对齐到视口的哪个位置"：

```dart
// RenderViewport
final double anchor; // 0.0 ~ 1.0，默认 0.0
```

- `anchor = 0.0`（默认）：center sliver 的起始位置对齐到视口顶部
- `anchor = 1.0`：center sliver 的末尾对齐到视口底部
- `anchor = 0.5`：center sliver 的中间对齐到视口中央

在 `performLayout` 中，anchor 直接影响 center sliver 的布局起点：

```dart
// rendering/viewport.dart（简化）
@override
void performLayout() {
  offset.applyViewportDimension(size.height);
  final double mainAxisExtent = size.height;
  final double crossAxisExtent = size.width;
  final double centerOffsetAdjustment = center!.centerOffsetAdjustment;
  // 每个子 sliver 最多允许 10 轮修正
  final int maxLayoutCycles = _maxLayoutCyclesPerChild * childCount;

  double correction;
  var count = 0;
  do {
    // 注意：_attemptLayout 不接收 anchor 参数，
    // anchor 在其内部参与计算 centerOffset
    correction = _attemptLayout(
      mainAxisExtent,
      crossAxisExtent,
      offset.pixels + centerOffsetAdjustment,
    );
    if (correction != 0.0) {
      // 子 sliver 报告了 scrollOffsetCorrection → 修正后整轮重排
      offset.correctBy(correction);
    } else {
      if (offset.applyContentDimensions(
        math.min(0.0, _minScrollExtent + mainAxisExtent * anchor),
        math.max(0.0, _maxScrollExtent - mainAxisExtent * (1.0 - anchor)),
      )) {
        break;
      }
    }
    count += 1;
  } while (count < maxLayoutCycles);
}
```

### ViewportOffset 与 center 的协作

`ViewportOffset`（实际类型通常是 `ScrollPosition`）持有了"用户滚到了哪"这个核心状态。但这个像素值需要和 center sliver 协调才能真正布局。

`centerOffsetAdjustment` 是这个协作的关键：

```dart
// rendering/sliver.dart — RenderSliver
double get centerOffsetAdjustment => 0.0;
```

注意它定义在 `RenderSliver` 上（不是 viewport 上）。默认返回 0，框架内部没有覆盖者，是留给自定义 center sliver 的扩展点——比如一个想在"scrollOffset 为 0 时出现在视口中间"的 sliver，可以通过覆盖它来平移自己的锚定位置。

在 `_attemptLayout` 中，center sliver 收到的 `scrollOffset` 并不直接等于 `offset.pixels`，而是经过 anchor 换算：

```dart
// rendering/viewport.dart（简化）
double _attemptLayout(double mainAxisExtent, double crossAxisExtent,
    double correctedOffset) {
  // correctedOffset = offset.pixels + centerOffsetAdjustment

  // centerOffset：视口前缘到"绝对零滚动点"（forward 与 reverse 的分界线）的距离
  final double centerOffset = mainAxisExtent * anchor - correctedOffset;

  // center sliver 的 scrollOffset = max(0.0, -centerOffset)
  // 即 centerOffset 为负（零滚动点被滚出视口顶部）时，center 已经被滚过一段距离
  return layoutChildSequence(
    child: center,
    scrollOffset: math.max(0.0, -centerOffset),
    overlap: leadingNegativeChild == null ? math.min(0.0, -centerOffset) : 0.0,
    remainingPaintExtent: forwardDirectionRemainingPaintExtent,
    remainingCacheExtent: forwardDirectionRemainingCacheExtent,
    cacheOrigin: clampDouble(centerOffset, -_calculatedCacheExtent!, 0.0),
    growthDirection: GrowthDirection.forward,
    // ...
  );
}
```

### 源码分析：performLayout 中如何使用 center

`RenderViewport.performLayout()` 的完整布局流程（简化版）：

```dart
@override
void performLayout() {
  if (center == null) {
    // 没有 center（即没有任何 child）→ 空视口
    offset.applyContentDimensions(0.0, 0.0);
    return;
  }
  final double mainAxisExtent = size.height;   // 主轴长度
  final double crossAxisExtent = size.width;   // 交叉轴长度
  // ...
  double correction;
  var count = 0;
  do {
    // 第一步：布局 center 之前的 sliver（reverse 增长方向，向 leading 推进）
    // 第二步：布局 center 自身，以及 center 之后的 sliver（forward 增长方向）
    // 这两步都在 _attemptLayout 内完成
    correction = _attemptLayout(
      mainAxisExtent,
      crossAxisExtent,
      offset.pixels + center!.centerOffsetAdjustment,
    );
    // ...
  } while (count < maxLayoutCycles);
}
```

`_attemptLayout` 的内部流程：

```dart
double _attemptLayout(double mainAxisExtent, double crossAxisExtent,
    double correctedOffset) {

  // 1. 计算零滚动点：视口前缘到 center sliver 布局起点的距离
  final double centerOffset = mainAxisExtent * anchor - correctedOffset;
  // 2. 前后两个方向各自剩余的可见绘制空间
  final double reverseDirectionRemainingPaintExtent =
      clampDouble(centerOffset, 0.0, mainAxisExtent);
  final double forwardDirectionRemainingPaintExtent =
      clampDouble(mainAxisExtent - centerOffset, 0.0, mainAxisExtent);

  // 3. 缓存区总量：视口前后各扩展 cacheExtent，所以是 + 2 倍
  final double fullCacheExtent = mainAxisExtent + 2 * _calculatedCacheExtent!;
  final double centerCacheOffset = centerOffset + _calculatedCacheExtent!;

  // 4. 先向 leading（reverse 方向）布局 center 之前的 sliver
  final RenderSliver? leadingNegativeChild = childBefore(center!);
  if (leadingNegativeChild != null) {
    final double result = layoutChildSequence(
      child: leadingNegativeChild,
      scrollOffset: math.max(mainAxisExtent, centerOffset) - mainAxisExtent,
      growthDirection: GrowthDirection.reverse, // 反向增长
      remainingPaintExtent: reverseDirectionRemainingPaintExtent,
      remainingCacheExtent: reverseDirectionRemainingCacheExtent,
      cacheOrigin: clampDouble(mainAxisExtent - centerOffset,
          -_calculatedCacheExtent!, 0.0),
      // ...
    );
    if (result != 0.0) {
      return -result; // 交给 performLayout 的 correctBy 重试
    }
  }

  // 5. 再向 trailing（forward 方向）布局 center 及其之后的 sliver
  return layoutChildSequence(
    child: center,
    scrollOffset: math.max(0.0, -centerOffset),
    growthDirection: GrowthDirection.forward, // 正向增长
    remainingPaintExtent: forwardDirectionRemainingPaintExtent,
    remainingCacheExtent: forwardDirectionRemainingCacheExtent,
    cacheOrigin: clampDouble(centerOffset, -_calculatedCacheExtent!, 0.0),
    // ...
  );
}
```

`layoutChildSequence` 内部才是真正给每个 sliver 派发约束的地方：

```dart
// rendering/viewport.dart（简化）
while (child != null) {
  final sliverScrollOffset = scrollOffset <= 0.0 ? 0.0 : scrollOffset;
  // cacheOrigin 不会超过 -scrollOffset：不让 sliver 提供自己零点之前的内容
  final double correctedCacheOrigin =
      math.max(cacheOrigin, -sliverScrollOffset);
  final double cacheExtentCorrection = cacheOrigin - correctedCacheOrigin;

  child.layout(
    SliverConstraints(
      scrollOffset: sliverScrollOffset,
      precedingScrollExtent: precedingScrollExtent,
      overlap: maxPaintOffset - layoutOffset,
      remainingPaintExtent: math.max(
          0.0, remainingPaintExtent - layoutOffset + initialLayoutOffset),
      crossAxisExtent: crossAxisExtent,
      viewportMainAxisExtent: mainAxisExtent,
      remainingCacheExtent: math.max(
          0.0, remainingCacheExtent + cacheExtentCorrection),
      cacheOrigin: correctedCacheOrigin,
      // ...
    ),
    parentUsesSize: true,
  );
  // 消耗当前 sliver，推进到下一个
  scrollOffset -= child.geometry!.scrollExtent;
  precedingScrollExtent += child.geometry!.scrollExtent;
  layoutOffset += child.geometry!.layoutExtent;
  remainingCacheExtent -= child.geometry!.cacheExtent;
  cacheOrigin = math.min(
      correctedCacheOrigin + child.geometry!.cacheExtent, 0.0);
  // 若 child 回传了 scrollOffsetCorrection，立即向上返回触发整轮重排
  if (child.geometry!.scrollOffsetCorrection != null) {
    return child.geometry!.scrollOffsetCorrection!;
  }
  child = advance(child);
}
```

### 自定义 center sliver 的效果

默认情况下 center 是第一个 sliver。如果你想**以列表为中心、让 AppBar 在列表上方浮动**，可以手动指定 center：

```dart
import 'package:flutter/material.dart';

class CenterSliverDemo extends StatelessWidget {
  const CenterSliverDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        center: const _ListSliverKey(), // 指定列表为中心
        slivers: [
          SliverPersistentHeader(
            pinned: true,
            delegate: _StickyHeaderDelegate(),
          ),
          const SliverList(
            key: _ListSliverKey(),
            delegate: SliverChildBuilderDelegate(
              (context, index) => ListTile(
                title: Text('Center Item $index'),
                subtitle: Text('以这个列表为中心轴心'),
              ),
              childCount: 50,
            ),
          ),
        ],
      ),
    );
  }
}

class _StickyHeaderDelegate extends SliverPersistentHeaderDelegate {
  @override
  double get minExtent => 56;

  @override
  double get maxExtent => 120;

  @override
  Widget build(
      BuildContext context, double shrinkOffset, bool overlapsContent) {
    return Container(
      color: Colors.blue.shade100,
      child: Padding(
        padding: EdgeInsets.all(16 + (maxExtent - shrinkOffset - minExtent) * 0.1),
        child: const Text('Floating Header',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
      ),
    );
  }

  @override
  bool shouldRebuild(covariant _StickyHeaderDelegate oldDelegate) => false;
}

class _ListSliverKey extends GlobalObjectKey {
  const _ListSliverKey() : super('center_sliver');
}
```

### SliverAppBar + FlexibleSpaceBar 的底层实现原理

`SliverAppBar` 本质上是一个 `SliverPersistentHeader`，它利用了 center sliver 机制：

1. **SliverAppBar 继承链**：`SliverAppBar` → `StatefulWidget` → 渲染为 `RenderSliverPersistentHeader` 的子类（pinned 用 `RenderSliverPinnedPersistentHeader`，floating 用 `RenderSliverFloatingPersistentHeader`）
2. **FlexibleSpaceBar**：通过 `FlexibleSpaceBarSettings` 把当前 `shrinkOffset` 传递给子树
3. **与 center 的关系**：
   - 当 SliverAppBar 是第一个 sliver 时，它就是 center
   - 它的 `scrollExtent` 恒为 `maxExtent`（expandedHeight），滚动中变化的是 `paintExtent` / `layoutExtent`
   - 这些几何值会反映到后续 sliver 的 `precedingScrollExtent` 与滚动范围，驱动列表跟随移动

关键源码片段——pinned header 的布局（`RenderSliverPinnedPersistentHeader`）：

```dart
// rendering/sliver_persistent_header.dart（简化）
@override
void performLayout() {
  final SliverConstraints constraints = this.constraints;
  // 1. 收起量：scrollOffset 越大收得越多，最多收到 maxExtent
  //    layoutChild 内部：shrinkOffset = math.min(scrollOffset, maxExtent)
  layoutChild(constraints.scrollOffset, maxExtent,
      overlapsContent: constraints.overlap > 0.0);

  // 2. child 的主轴约束：收起时下限是 minExtent（tool bar 高度）
  //    layoutChild 内部：constraints.asBoxConstraints(
  //        maxExtent: math.max(minExtent, maxExtent - shrinkOffset))
  final double layoutExtent = clampDouble(
    maxExtent - constraints.scrollOffset, // 布局占位随滚动递减
    0.0,
    effectiveRemainingPaintExtent,
  );
  // 3. pinned 的关键：paintExtent 取 childExtent（>= minExtent），
  //    而 layoutExtent 可以收缩到 0 —— "画着不占位"就是吸顶的本质
  geometry = SliverGeometry(
    scrollExtent: maxExtent,          // 总滚动长度始终是 maxExtent
    paintOrigin: constraints.overlap,
    paintExtent: math.min(childExtent, effectiveRemainingPaintExtent),
    layoutExtent: layoutExtent,
    maxPaintExtent: maxExtent,
    maxScrollObstructionExtent: minExtent, // 吸顶时对滚动范围的占用量
    hasVisualOverflow: true,
  );
  // shrinkOffset 会经 updateChild → FlexibleSpaceBarSettings 传给子树
}
```

注意 pinned 效果不是靠"把绘制起点上移"实现的：sliver 的布局位置确实跟着滚动上移（`layoutExtent` 收缩到 0），但 `paintExtent` 始终保持 `childExtent`（至少 `minExtent`）——即 header 在视口顶部持续画出一个不小于 `minExtent` 的区域，配合 `maxScrollObstructionExtent: minExtent` 告诉 viewport "吸顶状态下有 minExtent 的区域不可被内容滚动覆盖"。floating 版本则不同：`layoutExtent` 与 `paintExtent` 都随 `maxExtent - scrollOffset` 收缩，完全收起后不占绘制与布局空间，再次下拉时凭 `_effectiveScrollOffset` 与 `userScrollDirection` 判断要不要重新浮现。

---

## 补充二：ScrollPhysics 协商机制

### ScrollPhysics 的角色

`ScrollPhysics` 是 Flutter 滚动行为的"物理引擎"，定义了：

- 弹性/边界行为（滚过头了怎么办）
- 惯性模拟（松手后怎么减速）
- 是否允许滚动
- 惯性动画的衰减曲线

```dart
// widgets/scroll_physics.dart
@immutable
class ScrollPhysics {
  const ScrollPhysics({this.parent});

  final ScrollPhysics? parent;

  // 1. 构建惯性模拟（松手后的减速/回弹动画）
  Simulation? createBallisticSimulation(
      ScrollMetrics position, double velocity) {
    return parent?.createBallisticSimulation(position, velocity);
  }

  // 2. 边界条件：返回"应当被挡掉（不允许应用）的偏移量"，默认 0 = 不挡
  double applyBoundaryConditions(ScrollMetrics position, double value) {
    return parent?.applyBoundaryConditions(position, value) ?? 0.0;
  }

  // 3. 物理特性继承：把 ancestor 挂到自己的 parent 链末端
  ScrollPhysics applyTo(ScrollPhysics? ancestor) {
    return ScrollPhysics(parent: buildParent(ancestor));
  }

  // 4. 惯性模拟的容差（速度/距离小于容差就视作停止）
  Tolerance toleranceFor(ScrollMetrics metrics) {
    return parent?.toleranceFor(metrics) ??
        Tolerance(
          velocity: 1.0 / (0.050 * metrics.devicePixelRatio),
          distance: 1.0 / metrics.devicePixelRatio,
        );
  }

  // 5. 是否应该接受用户拖动
  bool shouldAcceptUserOffset(ScrollMetrics position) {
    if (!allowUserScrolling) {
      return false;
    }
    if (parent == null) {
      // 默认：有偏移或内容可滚时才接受
      return position.pixels != 0.0 ||
          position.minScrollExtent != position.maxScrollExtent;
    }
    return parent!.shouldAcceptUserOffset(position);
  }

  // 6. 携带动量到下一个可滚动（iOS 连续 fling 加速）
  double carriedMomentum(double existingVelocity) {
    return parent?.carriedMomentum(existingVelocity) ?? 0.0;
  }

  // 7. 惯性模拟使用的弹簧参数
  SpringDescription get spring => parent?.spring ?? _kDefaultSpring;

  // 8. 拖动手势启动阈值（iOS 上用于抵消抬手误触）
  double? get dragStartDistanceMotionThreshold =>
      parent?.dragStartDistanceMotionThreshold;
}
```

### applyTo()：父子 physics 的继承链

`applyTo()` 实现了类似 CSS 的"继承覆盖"机制。当你给 `ScrollView` 设置 `physics` 时，它会和父级 physics 进行合并：

```dart
// 示例：BouncingScrollPhysics 继承了父级
final physics = BouncingScrollPhysics(parent: ClampingScrollPhysics());
// 效果：边界行为用 Bouncing 的弹性，但其他属性（如 tolerance）可能从 Clamping 继承
```

`applyTo` 的典型用法是组合默认 physics：

```dart
// 示例：给默认 physics 套一层"始终可滚动"
final physics = const AlwaysScrollableScrollPhysics()
    .applyTo(const ClampingScrollPhysics());
// 效果：是否可滚用 Always 的规则，边界行为、惯性模拟用 Clamping 的规则
```

每个具体实现会选择性覆盖某些属性，其余属性则委托给 parent：

```dart
class BouncingScrollPhysics extends ScrollPhysics {
  const BouncingScrollPhysics({super.parent});

  @override
  BouncingScrollPhysics applyTo(ScrollPhysics? ancestor) {
    return BouncingScrollPhysics(parent: buildParent(ancestor));
  }

  // 只覆盖了边界条件，其余委托给 parent
}
```

### applyBoundaryConditions()：边界条件

这里有一个非常容易误解的点：**`applyBoundaryConditions` 返回的不是"修正后的位置"，而是"应当被挡掉的偏移量"（overscroll）**。消费方是 `ScrollPosition.setPixels`：

```dart
// widgets/scroll_position.dart（简化）
double setPixels(double newPixels) {
  if (newPixels != pixels) {
    final double overscroll = applyBoundaryConditions(newPixels);
    // 真正落位的位置 = 期望位置 - 被挡掉的部分
    _pixels = newPixels - overscroll;
    // ...
    if (overscroll.abs() > precisionErrorTolerance) {
      didOverscrollBy(overscroll); // 由此发出 OverscrollNotification
    }
  }
  return 0.0;
}
```

`ClampingScrollPhysics` 的实现——返回越界的差值，让 `pixels` 停在边界上：

```dart
// ClampingScrollPhysics（简化）
@override
double applyBoundaryConditions(ScrollMetrics position, double value) {
  // 已经在顶（或底），还想继续往外滚 → 差值全部挡掉
  if (value < position.pixels && position.pixels <= position.minScrollExtent) {
    return value - position.pixels; // underscroll
  }
  if (position.maxScrollExtent <= position.pixels && position.pixels < value) {
    return value - position.pixels; // overscroll
  }
  // 从范围内滚向边界 → 只挡越界那一截
  if (value < position.minScrollExtent && position.minScrollExtent < position.pixels) {
    return value - position.minScrollExtent; // hit top edge
  }
  if (position.pixels < position.maxScrollExtent && position.maxScrollExtent < value) {
    return value - position.maxScrollExtent; // hit bottom edge
  }
  return 0.0; // 正常范围内 → 不挡
}
```

```dart
// BouncingScrollPhysics 的实现
@override
double applyBoundaryConditions(ScrollMetrics position, double value) => 0.0;
```

对比一下就能看出两种风格的差异：Clamping 报告"挡掉了多少"，`pixels` 因此停在边界；Bouncing 一律返回 0，`pixels` 跟着手指越界，过滚动状态交给 `applyPhysicsToUserOffset`（拖动阻尼）和松手后的回弹 `Simulation` 处理。

### 常见 ScrollPhysics 实现对比

| Physics | 边界行为 | 是否始终可滚动 | 惯性处理 | 典型场景 |
| --- | --- | --- | --- | --- |
| `BouncingScrollPhysics` | 弹性回弹，允许过滚动 | 取决于内容高度 | 摩擦减速 + 弹簧回弹 | iOS 风格 |
| `ClampingScrollPhysics` | 硬边界，不允许过滚动 | 取决于内容高度 | 摩擦减速 | Android 风格 |
| `AlwaysScrollableScrollPhysics` | 委托给 parent | **始终可滚动** | 委托给 parent | 内容不满一屏也要滚 |
| `NeverScrollableScrollPhysics` | 不允许 | **禁止滚动** | 无 | 禁止手势滚动 |
| `PageScrollPhysics` | 委托给 parent | 委托给 parent | 分页吸附 | PageView |
| `FixedExtentScrollPhysics` | 委托给 parent | 委托给 parent | 固定项数吸附 | Wheel/Picker |
| `RangeMaintainingScrollPhysics` | 委托给 parent | 委托给 parent | 维持惯性范围 | 列表项高度变化 |

`NeverScrollableScrollPhysics` 的实现非常简单粗暴：

```dart
class NeverScrollableScrollPhysics extends ScrollPhysics {
  const NeverScrollableScrollPhysics({super.parent});

  @override
  NeverScrollableScrollPhysics applyTo(ScrollPhysics? ancestor) {
    return NeverScrollableScrollPhysics(parent: buildParent(ancestor));
  }

  // 直接关掉用户滚动开关，基类的 shouldAcceptUserOffset
  // 检查到它之后就会返回 false
  @override
  bool get allowUserScrolling => false;

  // 隐式滚动（如焦点请求 showOnScreen 带动滚动）也一并拒绝
  @override
  bool get allowImplicitScrolling => false;
}
```

通过关掉 `allowUserScrolling`，`shouldAcceptUserOffset` 对所有用户手势返回 false，连边界条件都不需要处理。

### ScrollSimulation：松手后的惯性模拟

当用户松手后，`ScrollPhysics.createBallisticSimulation()` 创建一个 `Simulation` 对象来模拟惯性滚动。

`ClampingScrollPhysics` 的版本——越界时先弹回边界，否则按速度决定是否产生惯性：

```dart
// ClampingScrollPhysics（简化）
@override
Simulation? createBallisticSimulation(
    ScrollMetrics position, double velocity) {
  final Tolerance tolerance = toleranceFor(position);

  // 已经越界（比如内容缩短导致 pixels 越界）→ 弹簧拉回最近边界
  if (position.outOfRange) {
    double? end;
    if (position.pixels > position.maxScrollExtent) {
      end = position.maxScrollExtent;
    }
    if (position.pixels < position.minScrollExtent) {
      end = position.minScrollExtent;
    }
    return ScrollSpringSimulation(spring, position.pixels, end!,
        math.min(0.0, velocity), tolerance: tolerance);
  }
  // 速度太小 → 不需要惯性
  if (velocity.abs() < tolerance.velocity) {
    return null;
  }
  // 正朝边界外滚 → 也不会有惯性
  if (velocity > 0.0 && position.pixels >= position.maxScrollExtent) {
    return null;
  }
  if (velocity < 0.0 && position.pixels <= position.minScrollExtent) {
    return null;
  }
  // 摩擦减速到停止
  return ClampingScrollSimulation(
    position: position.pixels,
    velocity: velocity,
    tolerance: tolerance,
  );
}
```

`BouncingScrollPhysics` 的版本则非常短——速度快或已越界都交给同一个 `BouncingScrollSimulation`，它在内部自己处理"摩擦减速 → 撞到边界 → 弹簧回弹"的完整过程：

```dart
// BouncingScrollPhysics（简化）
@override
Simulation? createBallisticSimulation(
    ScrollMetrics position, double velocity) {
  final Tolerance tolerance = toleranceFor(position);
  if (velocity.abs() >= tolerance.velocity || position.outOfRange) {
    return BouncingScrollSimulation(
      spring: spring,
      position: position.pixels,
      velocity: velocity,
      leadingExtent: position.minScrollExtent,
      trailingExtent: position.maxScrollExtent,
      tolerance: tolerance,
      // BouncingScrollSimulation 内部：
      // 范围内用 FrictionSimulation 摩擦减速，
      // 冲出边界后切换为 ScrollSpringSimulation 回弹
    );
  }
  return null;
}
```

`PageScrollPhysics` 的惯性会吸附到最近的页边界，速度方向会决定多滚或少滚半页：

```dart
// PageScrollPhysics（简化）
class PageScrollPhysics extends ScrollPhysics {
  const PageScrollPhysics({super.parent});

  double _getPage(ScrollMetrics position) {
    return position.pixels / position.viewportDimension;
  }

  double _getTargetPixels(
      ScrollMetrics position, Tolerance tolerance, double velocity) {
    double page = _getPage(position);
    if (velocity < -tolerance.velocity) {
      page -= 0.5; // 快速向前翻 → 目标多走半页再取整
    } else if (velocity > tolerance.velocity) {
      page += 0.5; // 快速向后翻
    }
    return page.roundToDouble() * position.viewportDimension;
  }

  @override
  Simulation? createBallisticSimulation(
      ScrollMetrics position, double velocity) {
    // 已越界且朝外 → 交给 parent（父链负责拉回边界）
    if ((velocity <= 0.0 && position.pixels <= position.minScrollExtent) ||
        (velocity >= 0.0 && position.pixels >= position.maxScrollExtent)) {
      return super.createBallisticSimulation(position, velocity);
    }
    final Tolerance tolerance = toleranceFor(position);
    final double target = _getTargetPixels(position, tolerance, velocity);
    if (target != position.pixels) {
      // 用弹簧动画滑到目标页
      return ScrollSpringSimulation(
        spring, position.pixels, target, velocity,
        tolerance: tolerance,
      );
    }
    return null;
  }
}
```

### 嵌套滚动的 physics 协商

`ScrollableState` 在创建 `ScrollPosition` 时，会把 widget 传入的 physics 和环境默认 physics 合并：

```dart
// widgets/scrollable.dart（简化）
void _updatePosition() {
  // 1. 环境 physics：沿树向上找 ScrollConfiguration，
  //    找不到就用平台默认的 ScrollBehavior（Android→Clamping，iOS→Bouncing）
  _configuration = widget.scrollBehavior ?? ScrollConfiguration.of(context);
  // 2. widget 自己声明的 physics 优先
  final ScrollPhysics? physicsFromWidget =
      widget.physics ?? widget.scrollBehavior?.getScrollPhysics(context);
  // 3. applyTo 构建继承链：widget 的意见盖在环境默认之上
  _physics = _configuration.getScrollPhysics(context);
  _physics = physicsFromWidget?.applyTo(_physics) ?? _physics;
  // 4. 用最终 physics 创建 ScrollPosition
  _position = _effectiveScrollController
      .createScrollPosition(_physics!, this, oldPosition);
}
```

注意向上查找的是 `ScrollConfiguration`（不是 `Scrollable`）。如果祖先树上放了 `ScrollConfiguration`，它的 `ScrollBehavior.getScrollPhysics` 会成为默认 physics，再被子树的 `ScrollView.physics` 通过 `applyTo` 覆盖：

```
ScrollConfiguration（提供默认 physics）
  → 某层 ScrollView.physics.applyTo(默认)
    → 更内层 ScrollView.physics.applyTo(上一层)
      → 最终 physics
```

### NotificationListener 与 physics 的交互

`NotificationListener<ScrollNotification>` 和 physics 之间不是直接交互，而是通过共享的 `ScrollPosition` 间接关联：

1. `ScrollPosition` 驱动物理模拟（持有 current velocity、pixels）
2. 物理模拟每帧更新 `ScrollPosition.pixels`
3. 偏移变化触发 `ScrollUpdateNotification`
4. Notification 冒泡到 `NotificationListener`

```dart
NotificationListener<ScrollNotification>(
  onNotification: (notification) {
    if (notification is ScrollUpdateNotification) {
      // notification.metrics.pixels → 当前偏移
      // notification.metrics.extentBefore/maxScrollExtent → 可用范围
      // notification.scrollDelta → 本帧滚动距离
    }
    return false; // false = 继续冒泡；true = 拦截
  },
  child: ListView(...),
);
```

### 代码示例：自定义 ScrollPhysics（阻尼滚动 + snap 效果）

```dart
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';

/// 自定义阻尼滚动物理
class DampedScrollPhysics extends ScrollPhysics {
  final double dampingFactor;

  const DampedScrollPhysics({
    this.dampingFactor = 0.9,
    super.parent,
  });

  @override
  DampedScrollPhysics applyTo(ScrollPhysics? ancestor) {
    return DampedScrollPhysics(
      dampingFactor: dampingFactor,
      parent: buildParent(ancestor),
    );
  }

  // 阻尼边界：允许过滚动，但增加阻尼
  @override
  double applyBoundaryConditions(ScrollMetrics position, double value) {
    // 不硬挡，允许弹性，但 simulation 会快速衰减
    return value;
  }

  // 阻尼惯性模拟：速度更快衰减
  @override
  Simulation? createBallisticSimulation(
      ScrollMetrics position, double velocity) {
    final Tolerance tolerance = toleranceFor(position);
    // 过滚动时用弹性回弹
    if (position.outOfRange) {
      return BouncingScrollSimulation(
        position: position.pixels,
        velocity: velocity,
        leadingExtent: position.minScrollExtent,
        trailingExtent: position.maxScrollExtent,
        tolerance: tolerance,
        spring: SpringDescription.withDampingRatio(
          mass: 1.0,
          stiffness: 200.0, // 更硬的弹簧 → 更快回弹
          ratio: 0.8,
        ),
      );
    }

    // 正常范围：用自定义阻尼模拟
    if (velocity.abs() < tolerance.velocity) return null;
    return _DampedFrictionSimulation(
      drag: 0.2 / dampingFactor, // dampingFactor 越小，阻力越大
      position: position.pixels,
      velocity: velocity,
      tolerance: tolerance,
    );
  }
}

/// 自定义阻尼摩擦模拟：速度按指数衰减（阻尼越大衰减越快）
class _DampedFrictionSimulation extends Simulation {
  final double _drag;
  final double _position;
  final double _velocity;
  final Tolerance _tolerance;
  Duration _lastTimeStamp = Duration.zero;

  _DampedFrictionSimulation({
    required double drag,
    required double position,
    required double velocity,
    required Tolerance tolerance,
  })  : _drag = drag,
        _position = position,
        _velocity = velocity,
        _tolerance = tolerance;

  // 位移 = p0 + v0 * (1 - e^(-drag*t)) / drag（对速度积分的结果）
  @override
  double x(double timeInSeconds) =>
      _position + _velocity * (1 - math.exp(-_drag * timeInSeconds)) / _drag;

  // 速度 = v0 * e^(-drag*t)
  @override
  double dx(double timeInSeconds) => _velocity * math.exp(-_drag * timeInSeconds);

  @override
  bool isDone(double timeInSeconds) {
    return dx(timeInSeconds).abs() < _tolerance.velocity;
  }

  @override
  String toString() =>
      '_DampedFrictionSimulation(${_position.toStringAsFixed(1)}, '
      '${_velocity.toStringAsFixed(1)})';
}

/// 带吸附功能的物理
class SnapScrollPhysics extends ScrollPhysics {
  final double snapSize;

  const SnapScrollPhysics({
    this.snapSize = 80.0,
    super.parent,
  });

  @override
  SnapScrollPhysics applyTo(ScrollPhysics? ancestor) {
    return SnapScrollPhysics(
      snapSize: snapSize,
      parent: buildParent(ancestor),
    );
  }

  @override
  Simulation? createBallisticSimulation(
      ScrollMetrics position, double velocity) {
    final ScrollPhysics? ancestor = parent;
    final Simulation? simulation =
        ancestor?.createBallisticSimulation(position, velocity);
    if (simulation != null) return simulation;

    // 吸附到最近的 snapSize 倍数
    final double target = (position.pixels / snapSize).round() * snapSize;
    if ((target - position.pixels).abs() <
        toleranceFor(position).distance) {
      return null;
    }

    return ScrollSpringSimulation(
      SpringDescription.withDampingRatio(
        mass: 1.0,
        stiffness: 150.0,
        ratio: 1.0, // 临界阻尼 → 不振荡
      ),
      position.pixels,
      target,
      velocity,
    );
  }
}

// 使用示例
class CustomPhysicsDemo extends StatelessWidget {
  const CustomPhysicsDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('自定义 ScrollPhysics')),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              // 阻尼滚动
              physics: const DampedScrollPhysics(dampingFactor: 0.7),
              itemCount: 50,
              itemBuilder: (context, index) => ListTile(
                title: Text('阻尼滚动 Item $index'),
                subtitle: const Text('松手后惯性更快衰减'),
              ),
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: ListView.builder(
              // 吸附滚动（每 80px 一个吸附点）
              physics: const SnapScrollPhysics(snapSize: 80.0),
              itemCount: 50,
              itemBuilder: (context, index) => ListTile(
                title: Text('吸附滚动 Item $index'),
                subtitle: const Text('松手后吸附到最近 80px 倍数'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
```

---

## 补充三：ScrollNotification 冒泡与 ScrollPosition 监听链

### ScrollNotification 的类型体系

Flutter 的滚动通知体系是一个完整的类继承树：

```
Notification
  └── LayoutChangedNotification
        └── ScrollNotification（+ ViewportNotificationMixin 提供 depth）
              ├── ScrollStartNotification    // 开始滚动（拖动/惯性/动画启动时）
              ├── ScrollUpdateNotification   // 滚动更新（每帧偏移变化时）
              ├── ScrollEndNotification      // 滚动结束（拖动和惯性都停下来后）
              ├── OverscrollNotification     // 过滚动（被边界挡掉的那部分）
              └── UserScrollNotification     // 用户滚动方向变化
```

每个通知都携带了关键的滚动信息：

```dart
// widgets/scroll_notification.dart（简化）
abstract class ScrollNotification extends LayoutChangedNotification
    with ViewportNotificationMixin {
  ScrollNotification({
    required this.metrics,
    required this.context,
  });

  final ScrollMetrics metrics;     // 滚动位置、范围、方向等
  final BuildContext? context;     // 发出通知的 Scrollable 的 context

  // ViewportNotificationMixin 提供：
  // int get depth —— 通知已穿过几层 viewport（0 = 最近的那个 Scrollable）
}

// scrollDelta 是 ScrollUpdateNotification 的字段，不是基类的：
class ScrollUpdateNotification extends ScrollNotification {
  final double? scrollDelta;       // 本帧滚动距离
  // ...
}

// direction 是 UserScrollNotification 的字段：
class UserScrollNotification extends ScrollNotification {
  final ScrollDirection direction; // 用户滚动方向变化
  // ...
}
```

`depth` 字段在嵌套滚动里特别有用：`NotificationListener` 会收到所有后代 `Scrollable` 的通知，用 `notification.depth == 0` 就能过滤出离监听者最近的那个。

### 冒泡机制

`ScrollNotification` 继承自 `Notification`，使用 Flutter 标准的**冒泡机制**：

1. `ScrollPosition.setPixels` 改变 `pixels` 后调用 `didUpdateScrollPositionBy(delta)`
2. 它委托当前的 `ScrollActivity` 构造 `ScrollUpdateNotification` 并 `dispatch()`
3. `dispatch()` 沿 Element 树向上冒泡（从发出通知的 context 到根）
4. 每个节点上的 `NotificationListener` 有机会拦截

```dart
// widgets/scroll_position.dart（简化）
@override
double setPixels(double newPixels) {
  // ... 落位 _pixels = newPixels - overscroll 之后：
  notifyListeners();                     // 通道一：通知 controller 等直接 listener
  didUpdateScrollPositionBy(pixels - oldPixels);
  return 0.0;
}

// Called by [setPixels] to report a change to the [pixels] position.
void didUpdateScrollPositionBy(double delta) {
  // 通道二：构造通知并冒泡（activity 是当前的 ScrollActivity）
  activity!.dispatchScrollUpdateNotification(
      copyWith(), context.notificationContext!, delta);
}
```

`ScrollActivity.dispatchScrollUpdateNotification` 的实现就是创建通知并派发：

```dart
// widgets/scroll_activity.dart（简化）
void dispatchScrollUpdateNotification(
    ScrollMetrics metrics, BuildContext context, double scrollDelta) {
  ScrollUpdateNotification(
    metrics: metrics,
    context: context,
    scrollDelta: scrollDelta,
  ).dispatch(context);
}
```

冒泡的关键特性：

- **从内向外**：从发出通知的 `Scrollable` 向上传递到所有祖先 `NotificationListener`
- **可拦截**：任何 `NotificationListener` 返回 `true` 就会停止继续冒泡
- **不区分类型**：`NotificationListener<ScrollNotification>` 会接收所有子类型通知
- **Element 树级别**：冒泡沿着 Element 树，不是 Widget 树（虽然通常一致）

### NotificationListener 的工作原理

```dart
// widgets/notification_listener.dart（简化）
class NotificationListener<T extends Notification> extends ProxyWidget {
  const NotificationListener({
    super.key,
    required super.child,
    this.onNotification,
  });

  // 回调仅在通知类型是 T 的子类型时被调用
  final NotificationListenerCallback<T>? onNotification;

  @override
  Element createElement() {
    return _NotificationElement<T>(this);
  }
}

// 冒泡的入口在 Notification 上：dispatch(context) → context.dispatchNotification
class _NotificationElement<T extends Notification> extends ProxyElement
    with NotifiableElementMixin {
  _NotificationElement(NotificationListener<T> super.widget);

  // 通知冒泡经过本 Element 时被 framework 调用
  @override
  bool onNotification(Notification notification) {
    final listener = widget as NotificationListener<T>;
    if (listener.onNotification != null && notification is T) {
      return listener.onNotification!(notification);
      // true = 拦截，false = 继续冒泡
    }
    return false; // 类型不匹配，不拦截
  }
}
```

使用模式：

```dart
NotificationListener<ScrollNotification>(
  onNotification: (notification) {
    switch (notification) {
      case ScrollStartNotification():
        print('开始滚动: ${notification.metrics.pixels}');
      case ScrollUpdateNotification():
        // 每帧触发，注意性能
        print('滚动更新: ${notification.scrollDelta}');
      case ScrollEndNotification():
        print('滚动结束');
      case OverscrollNotification():
        print('过滚动: ${notification.overscroll}');
      case UserScrollNotification():
        print('方向变化: ${notification.direction}');
    }
    return false; // 不拦截，继续冒泡
  },
  child: ListView(...),
);
```

### ScrollPosition 与 ScrollController 的关系

`ScrollController` 和 `ScrollPosition` 的关系是**一对多**：

```
ScrollController
  ├── ScrollPosition #1（绑定到 ListView A）
  ├── ScrollPosition #2（绑定到 ListView B）
  └── ScrollPosition #3（绑定到 CustomScrollView C）
```

核心源码：

```dart
// widgets/scroll_controller.dart（简化）
class ScrollController extends ChangeNotifier {
  final List<ScrollPosition> _positions = <ScrollPosition>[];

  // 绑定一个 ScrollPosition（Scrollable 创建 position 时调用）
  @protected
  void attach(ScrollPosition position) {
    assert(!_positions.contains(position));
    _positions.add(position);
    // 关键：position 的每次 pixels 变化都会通知 controller
    // notifyListeners 是从 ChangeNotifier 继承来的
    position.addListener(notifyListeners);
  }

  // 解绑一个 ScrollPosition
  @protected
  void detach(ScrollPosition position) {
    assert(_positions.contains(position));
    position.removeListener(notifyListeners);
    _positions.remove(position);
  }

  // 便捷属性：如果有多个 position，只返回第一个
  double get offset => position.pixels;

  // 如果只绑定了一个 position，直接返回；否则断言
  ScrollPosition get position {
    assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
    assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
    return _positions.single;
  }

  // 获取所有 position
  Iterable<ScrollPosition> get positions => _positions;
}
```

一个 `ScrollController` 可以绑定多个 `Scrollable`，但要注意：`offset` / `position` 属性只在绑定一个 position 时可用。绑定多个时需要用 `positions` 遍历。

### PrimaryScrollController 场景

`WidgetsApp` / `MaterialApp` 会在 Navigator 之上注入一棵 `PrimaryScrollController`，让页面上的"主滚动视图"能拿到同一个 controller（移动平台上默认是竖向滚动的那个），方便外部控制或读取主滚动位置：

```dart
// widgets/primary_scroll_controller.dart（简化）
class PrimaryScrollController extends InheritedWidget {
  const PrimaryScrollController({
    super.key,
    required ScrollController this.controller,
    // 默认只在移动平台的竖向滚动上自动继承
    this.automaticallyInheritForPlatforms = _kMobilePlatforms,
    this.scrollDirection = Axis.vertical,
    required super.child,
  });

  final ScrollController? controller;

  // 找不到时返回 null
  static ScrollController? maybeOf(BuildContext context) {
    final PrimaryScrollController? result =
        context.dependOnInheritedWidgetOfExactType<PrimaryScrollController>();
    return result?.controller;
  }

  // 找不到时断言报错，而不是静默新建一个
  static ScrollController of(BuildContext context) {
    final ScrollController? controller = maybeOf(context);
    assert(() {
      if (controller == null) {
        throw FlutterError(
          'PrimaryScrollController.of() was called with a context that does '
          'not contain a PrimaryScrollController widget.\n...',
        );
      }
      return true;
    }());
    return controller!;
  }
}
```

`ScrollView` 未显式传 `controller` 且 `primary` 未设置时，会通过 `PrimaryScrollController.shouldInherit(context, scrollDirection)` 判断要不要自动继承它（当前平台在 `automaticallyInheritForPlatforms` 集合里、且滚动方向匹配 `scrollDirection` 才继承）。桌面/网页平台默认不继承，避免多个滚动视图抢同一个 controller。

### addListener vs NotificationListener 的区别

| 维度 | `addListener` | `NotificationListener` |
| --- | --- | --- |
| 监听层级 | `ScrollPosition` 级别 | Element 树冒泡 |
| 回调频率 | 每帧一次 | 每帧一次（但类型更丰富） |
| 可获取信息 | 只有 `pixels` 变化 | 有完整的 `ScrollMetrics` + 类型信息 |
| 位置要求 | 需要 `ScrollController` 引用 | 只需在 Widget 树上方 |
| 可拦截冒泡 | 不适用 | 返回 `true` 可拦截 |
| 生命周期 | 需手动 `dispose` | 随 Widget 自动管理 |
| 适用场景 | 直接控制滚动、动画联动 | 监听多层嵌套滚动、拦截通知 |

```dart
// addListener 方式：需要 controller 引用
final controller = ScrollController();
controller.addListener(() {
  print('当前偏移: ${controller.offset}');
});

// NotificationListener 方式：不需要 controller 引用
NotificationListener<ScrollUpdateNotification>(
  onNotification: (notification) {
    print('偏移: ${notification.metrics.pixels}');
    print('本帧滚动距离: ${notification.scrollDelta}');
    return false;
  },
  child: ListView(...),
);
```

### ScrollPosition 的生命周期

```dart
// ScrollableState 创建 position 时，委托给 controller 的工厂方法：
// _position = _effectiveScrollController.createScrollPosition(
//     _physics!, this, oldPosition);

// 该方法定义在 ScrollController 上（widgets/scroll_controller.dart）
@protected
ScrollPosition createScrollPosition(
  ScrollPhysics physics,
  ScrollContext context,
  ScrollPosition? oldPosition,
) {
  return ScrollPositionWithSingleContext(
    physics: physics,
    context: context,             // 这里的 context 是 ScrollableState
    initialPixels: initialScrollOffset,
    keepScrollOffset: keepScrollOffset,
    oldPosition: oldPosition,
    debugLabel: debugLabel,
  );
}

// ScrollPosition attach 到 controller
// → controller._positions 列表更新
// → position.addListener(controller.notifyListeners) 被注册

// Scrollable dispose 时
// → ScrollPosition.detach 从 controller 移除
// → position.removeListener 被调用
```

自定义 `createScrollPosition` 的场景：当你需要完全控制滚动行为时（继承 `ScrollController` 并返回自己的 `ScrollPosition` 子类）。

### ScrollController 是怎么"收到"滚动的

这里要澄清一个常见误解：`ScrollController` 并不通过 `ScrollNotification` 收通知。它的通道更直接——`attach` 时给 `ScrollPosition` 加 listener（`position.addListener(notifyListeners)`），而 `ScrollPosition` 本身是 `ChangeNotifier`，`pixels` 一变就 `notifyListeners`。

`ScrollNotification` 的冒泡通道服务的是另一类消费者——树上的 `NotificationListener`，以及框架里的 `ScrollNotificationObserver`：

```dart
// widgets/scroll_notification_observer.dart（简化）
// 一个全局观察者 widget：不经 NotificationListener 也能收到
// 子树里所有 ScrollNotification（Scaffold 用它实现 SliverAppBar
// 的 floating 吸顶联动）
class ScrollNotificationObserver extends StatefulWidget {
  const ScrollNotificationObserver({super.key, required this.child});

  final Widget child;

  static ScrollNotificationObserverState of(BuildContext context) {
    final ScrollNotificationObserverState? result = context
        .findAncestorStateOfType<ScrollNotificationObserverState>();
    assert(result != null, '...');
    return result!;
  }
  // ...
}
```

两条通道互不干扰：直接 listener 通道拿得到 `ScrollPosition` 对象本身，冒泡通道拿得到通知类型与 `ScrollMetrics` 快照。

### Scrollable.of(context)

`Scrollable.of(context)` 沿 Element 树向上查找最近的 `ScrollableState`（拿到它之后再取 `position`）：

```dart
// widgets/scrollable.dart（简化）
static ScrollableState? maybeOf(BuildContext context, {Axis? axis}) {
  // 沿 _ScrollableScope（Scrollable 向上暴露的 InheritedWidget）链查找
  InheritedElement? element =
      context.getElementForInheritedWidgetOfExactType<_ScrollableScope>();
  while (element != null) {
    final ScrollableState scrollable =
        (element.widget as _ScrollableScope).scrollable;
    // axis 不匹配就跳过这层，继续向外找
    if (axis == null ||
        axisDirectionToAxis(scrollable.axisDirection) == axis) {
      return scrollable;
    }
    context = scrollable.context;
    element = context
        .getElementForInheritedWidgetOfExactType<_ScrollableScope>();
  }
  return null;
}

static ScrollableState of(BuildContext context, {Axis? axis}) {
  final ScrollableState? scrollableState = maybeOf(context, axis: axis);
  assert(() {
    if (scrollableState == null) {
      throw FlutterError(
        'Scrollable.of() was called with a context that does not '
        'contain a Scrollable widget.\n...',
      );
    }
    return true;
  }());
  return scrollableState!;
}
```

注意：`Scrollable.of()` 找到的是**最近的** `Scrollable`，在嵌套滚动场景中可能不是你想要的那个；可选参数 `axis` 可以跳过主轴方向不匹配的外层滚动。

### 代码示例一：嵌套 ScrollView 中精确监听特定 ScrollView

```dart
import 'package:flutter/material.dart';

/// 嵌套 ScrollView 场景中，精确监听内层 ListView 的滚动
class NestedScrollListenDemo extends StatelessWidget {
  const NestedScrollListenDemo({super.key});

  @override
  Widget build(BuildContext context) {
    // 方案一：给目标 ListView 绑定独立的 ScrollController
    final innerController = ScrollController();

    return Scaffold(
      appBar: AppBar(title: const Text('精确监听嵌套滚动')),
      body: NotificationListener<ScrollNotification>(
        // 外层监听：接收所有嵌套 Scrollable 的通知
        onNotification: (notification) {
          // 通过 notification.context 判断来源
          // 注意 context 是可空的（BuildContext?）
          final sourceWidget =
              notification.context?.findAncestorWidgetOfExactType<Widget>();
          print('收到通知: ${notification.runtimeType}, '
              '偏移: ${notification.metrics.pixels}');
          return false;
        },
        child: Column(
          children: [
            Expanded(
              // 内层 ListView 用独立 controller
              child: ListView.builder(
                controller: innerController,
                itemCount: 20,
                itemBuilder: (context, index) => ListTile(
                  title: Text('外层 Item $index'),
                ),
              ),
            ),
            const Divider(height: 1),
            // 内层有自己独立的 Scrollable
            Expanded(
              child: ListView.builder(
                controller: ScrollController(), // 独立 controller
                itemCount: 20,
                itemBuilder: (context, index) => ListTile(
                  title: Text('内层 Item $index'),
                  tileColor: Colors.blue.shade50,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 方案二：用 Key 标识不同 Scrollable，在通知回调中区分来源
/// GlobalKey 没有接受 value 的公开构造，这里用 GlobalObjectKey
class ScrollSourceKey extends GlobalObjectKey {
  const ScrollSourceKey(super.value);
}

class KeyedScrollDemo extends StatelessWidget {
  const KeyedScrollDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const listAKey = ScrollSourceKey('listA');
    const listBKey = ScrollSourceKey('listB');

    return Scaffold(
      body: NotificationListener<ScrollNotification>(
        onNotification: (notification) {
          // 通过 notification.context 查找是否包含特定 Key
          // 注意 context 是可空的（BuildContext?）
          final isFromListA = notification.context
                  ?.findAncestorWidgetOfExactType<RepaintBoundary>()
                  ?.key ==
              listAKey;

          if (isFromListA) {
            print('List A 滚动: ${notification.metrics.pixels}');
          }
          return false;
        },
        child: Row(
          children: [
            Expanded(
              child: RepaintBoundary(
                key: listAKey,
                child: ListView.builder(
                  itemCount: 30,
                  itemBuilder: (context, index) =>
                      ListTile(title: Text('A: $index')),
                ),
              ),
            ),
            Expanded(
              child: RepaintBoundary(
                key: listBKey,
                child: ListView.builder(
                  itemCount: 30,
                  itemBuilder: (context, index) =>
                      ListTile(title: Text('B: $index')),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
```

### 代码示例二：自定义 ScrollController 实现分页加载

```dart
import 'package:flutter/material.dart';

/// 支持自动分页加载的 ScrollController
class PagingScrollController extends ScrollController {
  PagingScrollController({
    required this.onLoadMore,
    this.threshold = 200.0,
  });

  /// 当距离底部小于 threshold 时触发加载
  final VoidCallback onLoadMore;
  final double threshold;

  bool _isLoading = false;
  bool _hasMore = true;

  /// 标记没有更多数据
  void markNoMoreData() => _hasMore = false;

  /// 标记加载完成
  void markLoadComplete() => _isLoading = false;

  /// 重置状态（用于刷新场景）
  void reset() {
    _hasMore = true;
    _isLoading = false;
  }

  @override
  void attach(ScrollPosition position) {
    super.attach(position);
    // 对已绑定的 position 添加滚动监听
    position.isScrollingNotifier.addListener(_onScrollingChanged);
  }

  @override
  void detach(ScrollPosition position) {
    position.isScrollingNotifier.removeListener(_onScrollingChanged);
    super.detach(position);
  }

  void _onScrollingChanged() {
    // 只在非滚动状态时检查（滚动惯性结束后）
    if (positions.any((p) => p.isScrollingNotifier.value)) return;
    _checkLoadMore();
  }

  void _checkLoadMore() {
    if (_isLoading || !_hasMore || !hasClients) return;

    for (final position in positions) {
      final maxScroll = position.maxScrollExtent;
      final currentScroll = position.pixels;
      // 距离底部不足 threshold → 触发加载
      if (maxScroll - currentScroll <= threshold) {
        _isLoading = true;
        onLoadMore();
        break;
      }
    }
  }
}

/// 使用示例
class PagingListDemo extends StatefulWidget {
  const PagingListDemo({super.key});

  @override
  State<PagingListDemo> createState() => _PagingListDemoState();
}

class _PagingListDemoState extends State<PagingListDemo> {
  late final PagingScrollController _pagingController;
  final List<String> _items = List.generate(20, (i) => 'Item $i');
  int _page = 1;

  @override
  void initState() {
    super.initState();
    _pagingController = PagingScrollController(
      onLoadMore: _loadMore,
      threshold: 200.0,
    );
    // 实时监听滚动位置（用于显示滚动百分比等 UI）
    _pagingController.addListener(_onScroll);
  }

  void _loadMore() {
    // 模拟网络请求
    Future.delayed(const Duration(seconds: 1), () {
      if (!mounted) return;
      setState(() {
        final newItems = List.generate(20, (i) => 'Item ${_page * 20 + i}');
        _items.addAll(newItems);
        _page++;
      });
      _pagingController.markLoadComplete();
      if (_page >= 5) _pagingController.markNoMoreData();
    });
  }

  void _onScroll() {
    if (!mounted) return;
    final position = _pagingController.position;
    final progress = position.pixels / (position.maxScrollExtent > 0
        ? position.maxScrollExtent
        : 1);
    // 可以在这里更新 UI 显示滚动进度
    print('滚动进度: ${(progress * 100).toStringAsFixed(1)}%');
  }

  @override
  void dispose() {
    _pagingController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('分页加载 (第 $_page 页, 共 ${_items.length} 条)'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              _pagingController.jumpTo(0);
              _pagingController.reset();
              setState(() {
                _items.clear();
                _items.addAll(List.generate(20, (i) => 'Item $i'));
                _page = 1;
              });
            },
          ),
        ],
      ),
      body: ListView.builder(
        controller: _pagingController,
        itemCount: _items.length + 1,
        itemBuilder: (context, index) {
          if (index >= _items.length) {
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            );
          }
          return ListTile(
            title: Text(_items[index]),
            subtitle: Text('index: $index'),
          );
        },
      ),
    );
  }
}
```

### 代码示例三：ScrollNotification 冒泡路径验证

```dart
import 'package:flutter/material.dart';

/// 验证 ScrollNotification 冒泡路径
/// 在 Widget 树的不同层级放置 NotificationListener，观察通知传递顺序
class NotificationBubbleDemo extends StatelessWidget {
  const NotificationBubbleDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('ScrollNotification 冒泡路径')),
      // 层级 1：最外层
      body: NotificationListener<ScrollNotification>(
        onNotification: (notification) {
          debugPrint('[层级1 - Scaffold Body] '
              '${notification.runtimeType} → '
              'pixels: ${notification.metrics.pixels.toStringAsFixed(1)}');
          return false; // 不拦截，继续冒泡
        },
        child: Column(
          children: [
            // 层级 2：Column 内
            NotificationListener<ScrollNotification>(
              onNotification: (notification) {
                debugPrint('[层级2 - Column] '
                    '${notification.runtimeType}');
                return false;
              },
              child: Expanded(
                // 层级 3：Expanded 内
                child: NotificationListener<ScrollNotification>(
                  onNotification: (notification) {
                    debugPrint('[层级3 - Expanded] '
                        '${notification.runtimeType}');
                    // 拦截 ScrollEndNotification
                    if (notification is ScrollEndNotification) {
                      debugPrint(
                          '[层级3] 拦截了 ScrollEndNotification，不再冒泡');
                      return true; // 拦截！
                    }
                    return false;
                  },
                  child: ListView.builder(
                    itemCount: 50,
                    itemBuilder: (context, index) => ListTile(
                      title: Text('Item $index'),
                      subtitle: Text(
                          '滚动时观察控制台输出，验证冒泡顺序'),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/*
预期输出（滚动时）：

  [层级3 - Expanded] ScrollStartNotification
  [层级2 - Column] ScrollStartNotification
  [层级1 - Scaffold Body] ScrollStartNotification → pixels: 0.0

  [层级3 - Expanded] ScrollUpdateNotification
  [层级2 - Column] ScrollUpdateNotification
  [层级1 - Scaffold Body] ScrollUpdateNotification → pixels: 3.5

  [层级3 - Expanded] ScrollUpdateNotification
  [层级2 - Column] ScrollUpdateNotification
  [层级1 - Scaffold Body] ScrollUpdateNotification → pixels: 7.2

  ...（持续更新）

  [层级3 - Expanded] ScrollEndNotification
  [层级3] 拦截了 ScrollEndNotification，不再冒泡
  （层级 2 和层级 1 收不到 ScrollEndNotification！）
*/
```

### 监听链完整架构图

```
用户手指滑动
    ↓
GestureRecognizer (Scrollable 内部)
    ↓
DragUpdate → ScrollPosition.setPixels(newPixels)
    ↓
_pixels = newPixels - applyBoundaryConditions(newPixels)  // 落位
    ↓
ScrollPosition.notifyListeners()  （ScrollPosition 是 ChangeNotifier）
    ├── 通道一（直接监听）：attach 时注册的 controller.notifyListeners
    │       └── → ScrollController.addListener 的回调们
    └── 通道二（通知冒泡）：didUpdateScrollPositionBy(delta)
            └── → activity.dispatchScrollUpdateNotification(...)
                    └── → ScrollUpdateNotification.dispatch(context)
                            ├── → NotificationListener<ScrollNotification>（层级3）
                            ├── → NotificationListener<ScrollNotification>（层级2）
                            └── → NotificationListener<ScrollNotification>（层级1）
                                    └── → 返回 true → 停止冒泡
```

两条监听通道并行工作：
1. **直接监听通道**：`ScrollController.addListener` → 精确绑定到特定 `ScrollPosition`
2. **冒泡通道**：`NotificationListener` → 沿 Element 树冒泡，可拦截、可区分来源

选择建议：
- 只需要监听一个已知 `Scrollable` → 用 `ScrollController.addListener`
- 需要监听嵌套中任意 `Scrollable` → 用 `NotificationListener`
- 需要拦截通知不让继续传播 → 用 `NotificationListener` 返回 `true`
- 需要精确知道通知类型 → 用 `NotificationListener` 配合 `switch` 类型匹配

---

## 参考补充

### Flutter 源码文件（相对 `packages/flutter/lib/src/`）

- [`rendering/viewport.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/rendering/viewport.dart) — `RenderViewport`、center/anchor 布局、`layoutChildSequence`
- [`rendering/sliver.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/rendering/sliver.dart) — `SliverConstraints`、`SliverGeometry`、`RenderSliver`
- [`rendering/sliver_list.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/rendering/sliver_list.dart) — `RenderSliverList` 的增量布局算法
- [`rendering/sliver_multi_box_adaptor.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/rendering/sliver_multi_box_adaptor.dart) — `collectGarbage`、leading/trailing garbage
- [`rendering/sliver_persistent_header.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/rendering/sliver_persistent_header.dart) — `SliverAppBar` 的底层实现（pinned/floating）
- [`widgets/scroll_position.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scroll_position.dart) — `ScrollPosition` 滚动状态管理
- [`widgets/scroll_physics.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scroll_physics.dart) — `ScrollPhysics` 及各子类实现
- [`widgets/scroll_simulation.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scroll_simulation.dart) — `BouncingScrollSimulation`、`ClampingScrollSimulation`
- [`widgets/scroll_controller.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scroll_controller.dart) — `ScrollController` 实现
- [`widgets/scrollable.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scrollable.dart) — `Scrollable`、physics 组装、`Scrollable.of`
- [`widgets/scroll_activity.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scroll_activity.dart) — 各类 `ScrollActivity` 与通知分发
- [`widgets/primary_scroll_controller.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/primary_scroll_controller.dart) — `PrimaryScrollController`
- [`widgets/notification_listener.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/notification_listener.dart) — `NotificationListener`
- [`widgets/scroll_notification.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/scroll_notification.dart) — `ScrollNotification` 类型体系

### 官方文档

- [`ScrollPhysics`](https://api.flutter.dev/flutter/widgets/ScrollPhysics-class.html)
- [`ScrollController`](https://api.flutter.dev/flutter/widgets/ScrollController-class.html)
- [`ScrollPosition`](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html)
- [`ScrollNotification`](https://api.flutter.dev/flutter/widgets/ScrollNotification-class.html)
- [`NotificationListener`](https://api.flutter.dev/flutter/widgets/NotificationListener-class.html)
- [`PrimaryScrollController`](https://api.flutter.dev/flutter/widgets/PrimaryScrollController-class.html)
- [`ScrollConfiguration`](https://api.flutter.dev/flutter/widgets/ScrollConfiguration-class.html)
- [`Viewport`](https://api.flutter.dev/flutter/widgets/Viewport-class.html)
- [docs.flutter.dev：Scrolling 专题](https://docs.flutter.dev/ui/layout/scrolling)
- [docs.flutter.dev：Using slivers to achieve fancy scrolling](https://docs.flutter.dev/ui/layout/scrolling/slivers)
- [Flutter 博客：Slivers, Demystified](https://blog.flutter.dev/slivers-demystified-6ff68ab0296f)
