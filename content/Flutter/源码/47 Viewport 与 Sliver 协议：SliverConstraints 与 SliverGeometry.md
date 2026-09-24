# 47 Viewport 与 Sliver 协议：SliverConstraints 与 SliverGeometry

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/viewport.dart`（689 行）、`packages/flutter/lib/src/rendering/viewport.dart`（2261 行）、`packages/flutter/lib/src/rendering/sliver.dart`（2119 行）

## 一、问题

`CustomScrollView` 的 `slivers:` 参数只接受 `Widget`，但如果你往里塞一个 `Container`，会直接编译不过——`RenderViewport` 的孩子必须是 `RenderSliver`。于是有两个可能踩的坑：

第一，把 sliver 理解成"能滚的 widget"，于是以为 `SliverToBoxAdapter` 的作用是"把普通 widget 变成能滚的"。

第二，把 viewport 理解成"负责裁剪的容器"，于是以为滚动的计算发生在 viewport 里。

**真实的模型是：viewport 是一个"约束分发器"，它把可用空间切成 constraints 发给每个孩子；孩子各自算完，把结论写成 geometry 交回来；viewport 再用这些结论决定下一个孩子拿到多少空间。** 谁的孩子有多少空间是**链式串行**决定的，不是一次性算好的。

这也是"sliver 不能是 `Container`"的真正原因：`Container` → `RenderPadding` / `RenderConstrainedBox` 实现的是**盒约束协议**（`BoxConstraints` 进、`Size` 出），而 viewport 的孩子实现的是**sliver 协议**（`SliverConstraints` 进、`SliverGeometry` 出）。两套协议的唯一差别就在"进去的是什么、出来的算什么"——但**结果存在哪里**也不同：

```dart
// rendering/sliver.dart:1399-1406
Rect get paintBounds {
  switch (constraints.axis) {
    case Axis.horizontal:
      return Rect.fromLTWH(0.0, 0.0, geometry!.paintExtent, constraints.crossAxisExtent);
    case Axis.vertical:
      return Rect.fromLTWH(0.0, 0.0, constraints.crossAxisExtent, geometry!.paintExtent);
  }
}
```

注意它读的是 `geometry!.paintExtent`，**不是 `size`**——`RenderSliver` 根本没有 `size` 字段。`RenderBox` 把结论存在对象自己的 `size` 里，`RenderSliver` 把结论存在 `geometry` 里，这是两套协议最硬的区别。

sliver 协议是**一次布局往返**——`SliverConstraints` 向下、`SliverGeometry` 向上。viewport 不"测量"孩子，它读孩子的自述。

## 二、最小 Demo

下面是一个**手写的 sliver**，只做一件事：占 40 像素高，画出蓝色。它把协议的两半都写出来了。

```dart
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// 协议最小实现：一个固定高度的 sliver。
class RenderSliverBanner extends RenderSliver {
  RenderSliverBanner({required double extent}) : _extent = extent;

  final double _extent;

  @override
  void performLayout() {
    // 1. constraints 是上游发下来的，必须从这里读可用空间
    final SliverConstraints constraints = this.constraints;
    // 2. sliver 没有 size 字段，尺寸只能通过 geometry 上报
    // 3. 基类提供"我占的区间 → 真正可见区间"的换算
    final double paintExtent = calculatePaintOffset(constraints, from: 0.0, to: _extent);
    final double cacheExtent = calculateCacheOffset(constraints, from: 0.0, to: _extent);
    // 4. layoutExtent 省略时会默认等于 paintExtent（sliver.dart:662）
    geometry = SliverGeometry(
      scrollExtent: _extent,      // 我贡献给"总滚动长度"的量
      paintExtent: paintExtent,   // 我这一段里当前可见多少
      maxPaintExtent: _extent,    // 给我无限空间时我最多能画多少
      cacheExtent: cacheExtent,   // 含缓存区在内我要提供多少内容
      hasVisualOverflow: paintExtent < _extent,
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    // 5. offset 的坐标原点是自己的 paintOrigin（默认为自己的布局位置）
    context.canvas.drawRect(
      offset & Size(constraints.crossAxisExtent, geometry!.paintExtent),
      Paint()..color = const Color(0xFF2196F3),
    );
  }
}

class SliverBanner extends LeafRenderObjectWidget {
  const SliverBanner({super.key, required this.extent});

  final double extent;

  @override
  RenderSliverBanner createRenderObject(BuildContext context) => RenderSliverBanner(extent: extent);
}

// 用法：
// CustomScrollView(slivers: <Widget>[const SliverBanner(extent: 40), ...])
```

对照着看一个现成的 sliver，会发现结构完全一样：`SliverToBoxAdapter` 的 `RenderSliverToBoxAdapter`（`rendering/sliver.dart:2087`）也是这样——`performLayout` 里读 `constraints`、调 `child.layout(constraints.asBoxConstraints())`、把结果换算成 `SliverGeometry`。**`SliverToBoxAdapter` 本身就是一个 sliver，并没有"把 box 变成 sliver 的魔法"，只是它的"内容"恰好是一个 box 而已。**

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/viewport.dart:55` | `class Viewport extends MultiChildRenderObjectWidget` |
| `widgets/viewport.dart:65` / `122` | `required this.offset` / `final ViewportOffset offset;`，viewport 只知道 offset 不知道 ScrollPosition |
| `widgets/viewport.dart:221` | `RenderViewport createRenderObject(...)` |
| `widgets/viewport.dart:268` | `_ViewportElement`，负责把 sliver 的孩子和 `center` 的插槽对上 |
| `rendering/viewport.dart:410` | `abstract class RenderViewportBase<ParentDataClass>`，协议的实际执行者 |
| `rendering/viewport.dart:1556` | `class RenderViewport extends RenderViewportBase<SliverPhysicalContainerParentData>` |
| `rendering/viewport.dart:2003` | `RenderShrinkWrappingViewport`，`shrinkWrap: true` 时使用 |
| `rendering/viewport.dart:785` | `double layoutChildSequence({...})`，**协议在这里逐孩子下发** |
| `rendering/viewport.dart:1693` | `RenderViewport.performLayout`，layout 循环（`do...while` + 校正） |
| `rendering/viewport.dart:1767` | `_attemptLayout`，算 `centerOffset` / `remainingPaintExtent` / `remainingCacheExtent` |
| `rendering/viewport.dart:1243` | `computeAbsolutePaintOffset`，`layoutOffset` + `growthDirection` → 绘制坐标 |
| `rendering/viewport.dart:1334` | `Offset paintOffsetOf(RenderSliver child);`（抽象）→ 实现见 `:1875` |
| `rendering/viewport.dart:186` | `abstract interface class RenderAbstractViewport` |
| `rendering/viewport.dart:280` / `289` | `getOffsetToReveal`（"滚到某个 widget"的反向计算）/ `defaultCacheExtent = 250.0` |
| `rendering/sliver.dart:197` | `class SliverConstraints extends Constraints`，向下传的约束 |
| `rendering/sliver.dart:641` | `class SliverGeometry with Diagnosticable`，向上报的结论 |
| `rendering/sliver.dart:864` | `SliverGeometry.debugAssertIsValid`，协议的不变式检查 |
| `rendering/sliver.dart:1310` | `abstract class RenderSliver extends RenderObject` |
| `rendering/sliver.dart:1335` / `1347` | `constraints` / `geometry` 两个 getter |
| `rendering/sliver.dart:1446` | `void performResize() { assert(false); }`，sliver 不能靠 resize 定尺寸 |
| `rendering/sliver.dart:1573` / `1597` | `calculatePaintOffset` / `calculateCacheOffset`，供 sliver 换算 extent |

## 四、调用链

### 4.1 从 `Viewport` widget 到 `RenderViewportBase`

```dart
// widgets/viewport.dart:55-66（节选）
class Viewport extends MultiChildRenderObjectWidget {
  Viewport({
    this.axisDirection = AxisDirection.down,
    this.anchor = 0.0,
    required this.offset,          // ← 第 45 篇的 ScrollPosition
    this.center,
    this.scrollCacheExtent,        // ← 新 API；cacheExtent 已弃用
    this.paintOrder = SliverPaintOrder.firstIsTop,
    this.clipBehavior = Clip.hardEdge,
    List<Widget> slivers = const <Widget>[],
  })
```

`RenderViewportBase` 的构造参数里有一项值得单独看：

```dart
// rendering/viewport.dart:421
required ViewportOffset offset,
// rendering/viewport.dart:528
ViewportOffset get offset => _offset;
```

**viewport 拿到的是 `ViewportOffset`，不是 `ScrollPosition`。** 它整段布局里只会调用 offset 上的这几个方法：`pixels`、`applyViewportDimension`、`applyContentDimensions`、`correctBy`、`userScrollDirection`（`rendering/viewport.dart:1698`、`:1708`、`:1730`、`:1732`）。`RenderViewport` 不知道 `ScrollPhysics`、不知道 `ScrollActivity`、不知道 `ScrollController`。这是能在渲染层单独讲清 viewport 的原因。

### 4.2 `RenderViewport.performLayout`：一个会重试的 layout 循环

```dart
// rendering/viewport.dart:1697-1744（节选）
void performLayout() {
  offset.applyViewportDimension(mainAxisExtent);  // 1. 先告诉 offset 视口多长
  do {
    correction = _attemptLayout(mainAxisExtent, crossAxisExtent,
        offset.pixels + centerOffsetAdjustment);
    if (correction != 0.0) {
      offset.correctBy(correction);   // 2. sliver 要求校正 → 改偏移量后重做
    } else if (offset.applyContentDimensions(   // 3. 把最终边界交给 offset
      math.min(0.0, _minScrollExtent + mainAxisExtent * anchor),
      math.max(0.0, _maxScrollExtent - mainAxisExtent * (1.0 - anchor)))) {
      break;                          // offset 认可 → 布局结束
    }
  } while (count++ < maxLayoutCycles);
```

三个顺序要点：

1. **先给 viewportDimension，再给 contentDimensions**。源码注释明确说明这是约定（`scroll_position.dart:617-619`："If this is called, you can rely on applyContentDimensions being called soon afterwards in the same layout phase"）。
2. **`correction != 0` 表示"我想改偏移量，请重做"**。sliver 通过 `SliverGeometry(scrollOffsetCorrection: x)` 要求这件事（`rendering/sliver.dart:830`），`layoutChildSequence` 会把第一个非 null 的 correction 直接返回（`rendering/viewport.dart:848`）。典型场景：`SliverList` 发现"本应在第一个位置的 child 已经被回收了"。
3. **重试上限**是 `_maxLayoutCyclesPerChild * childCount`，超过就抛 `A RenderViewport exceeded its maximum number of layout cycles`（`rendering/viewport.dart:1745`）。这条错误信息本身把"可能死循环的三种原因"写全了，值得读一遍。

### 4.3 `_attemptLayout`：把可用空间切成三段

```dart
// rendering/viewport.dart:1781-1799（节选）
final double centerOffset = mainAxisExtent * anchor - correctedOffset;
final double forwardDirectionRemainingPaintExtent =
    clampDouble(mainAxisExtent - centerOffset, 0.0, mainAxisExtent);
final double fullCacheExtent = mainAxisExtent + 2 * _calculatedCacheExtent!;
final double centerCacheOffset = centerOffset + _calculatedCacheExtent!;
final double forwardCacheExtent =
    clampDouble(fullCacheExtent - centerCacheOffset, 0.0, fullCacheExtent);
```

这段是"viewport 到底有多少空间可以发"的全部算术。四个值两组：`paint` 侧不含缓存区，`cache` 侧含；`reverse` 是 center 之前的 sliver 可用量，`forward` 是 center 及其之后的量。

`anchor` 决定"zero scroll offset 在视口的第几个像素"。默认 `anchor = 0.0`，即第一条 sliver 的起点贴视口顶边；`anchor = 0.5`（`center` 与 `anchor` 配合）会让 center sliver 居中。这就是 `NestedScrollView` 的 `innerScrollable` 与 `SliverAppBar` 的 `pinned` 能共存的基础——不在同一侧，用的是不同的 remaining 预算。

`cacheExtent` 在 3.44.8 里换了 API：

```dart
// rendering/viewport.dart:42-58（节选）
sealed class ScrollCacheExtent {
  const factory ScrollCacheExtent.pixels(double pixels) = _PixelScrollCacheExtent;
  const factory ScrollCacheExtent.viewport(double value) = _ViewportScrollCacheExtent;
  double _calculateCacheOffset(double mainAxisExtent);
  CacheExtentStyle get style;
  double get value;
}
```

`Viewport.cacheExtent` 与 `Viewport.cacheExtentStyle` 都已标 `@Deprecated`（`widgets/viewport.dart:67-77`，注释写 "Use scrollCacheExtent instead. This feature was deprecated after v3.41.0-0.0.pre."），替代品是单个 `ScrollCacheExtent` 对象。**这是 3.44.8 的源码与大量现有资料不一致的一处**：老资料里 `cacheExtent: 500` / `cacheExtentStyle: CacheExtentStyle.viewport` 两个参数配对的写法，在 3.44.8 已被 `scrollCacheExtent: ScrollCacheExtent.pixels(500)` 取代。

### 4.4 `layoutChildSequence`：协议逐孩子下发

这是全篇最核心的一段，它把 `SliverConstraints` 组装出来喂给孩子，再读回 `SliverGeometry`：

```dart
// rendering/viewport.dart:811-824（节选）
final sliverScrollOffset = scrollOffset <= 0.0 ? 0.0 : scrollOffset;
// cacheOrigin 永远不超过 -scrollOffset：sliver 不会被要求在"自己起点之前"提供内容
final double correctedCacheOrigin = math.max(cacheOrigin, -sliverScrollOffset);
final double cacheExtentCorrection = cacheOrigin - correctedCacheOrigin;

child.layout(SliverConstraints(
  scrollOffset: sliverScrollOffset,
  precedingScrollExtent: precedingScrollExtent,
  overlap: maxPaintOffset - layoutOffset,   // 前面 sliver 压在头上的量
  remainingPaintExtent: remainingPaintExtent - layoutOffset + initialLayoutOffset,
  cacheOrigin: correctedCacheOrigin,
  remainingCacheExtent: remainingCacheExtent + cacheExtentCorrection,
  // ... 其余字段：axisDirection / growthDirection / crossAxisExtent 等
), parentUsesSize: true);
```

然后就是"消费 geometry"的部分，五行里能看出每一个字段被用在哪：

```dart
// rendering/viewport.dart:862-874（节选）
final double effectiveLayoutOffset = layoutOffset + childLayoutGeometry.paintOrigin;
maxPaintOffset = math.max(effectiveLayoutOffset + childLayoutGeometry.paintExtent, maxPaintOffset);
scrollOffset -= childLayoutGeometry.scrollExtent;
precedingScrollExtent += childLayoutGeometry.scrollExtent;
layoutOffset += childLayoutGeometry.layoutExtent;
if (childLayoutGeometry.cacheExtent != 0.0) {
  remainingCacheExtent -= childLayoutGeometry.cacheExtent - cacheExtentCorrection;
  cacheOrigin = math.min(correctedCacheOrigin + childLayoutGeometry.cacheExtent, 0.0);
}
```

对照 4.3 节的输入就能看出协议的**方向性**：

| geometry 字段 | 影响下一个孩子的哪个 constraints 字段 |
|---|---|
| `scrollExtent` | `scrollOffset`（减掉）、`precedingScrollExtent`（累加） |
| `layoutExtent` | `layoutOffset` → 间接影响 `remainingPaintExtent`、`overlap` |
| `paintExtent` / `paintOrigin` | `maxPaintOffset` → 下一个孩子的 `overlap` |
| `cacheExtent` | `remainingCacheExtent`（减掉）、`cacheOrigin`（抬到最多 0） |

这就是"链式串行"的确切含义。每个孩子只知道"前面所有孩子一共吃掉了多少"，不知道后面还有谁；viewport 用一个 `while` 循环把这四组累积量一直往下传。所以 sliver 的 `performLayout` 是**顺序相关**的——同一条链上换个顺序，每个孩子拿到的 `scrollOffset` 都会变。

### 4.5 sliver 侧：`RenderSliver` 的接口

```dart
// rendering/sliver.dart:1310-1349（节选）
abstract class RenderSliver extends RenderObject {
  @override
  SliverConstraints get constraints => super.constraints as SliverConstraints;

  SliverGeometry? get geometry => _geometry;
  SliverGeometry? _geometry;
  set geometry(SliverGeometry? value) { ... }   // 1349

  @override
  void performResize() {
    assert(false);     // 1446
  }
}
```

两处设计约束：

1. **`constraints` 是窄化过的**：`RenderObject.constraints` 被 `as` 成 `SliverConstraints`。所以 sliver 的 `performLayout` 里写 `this.constraints` 就自动是 sliver 版本，不需要额外的类型转换。
2. **`performResize` 直接 `assert(false)`**。`RenderBox` 有"只依赖 constraints 的尺寸可以走 `sizedByParent` 快路径"这套机制，sliver 不用。sliver 的"尺寸"不是一个 `Size`，而是 `SliverGeometry` 里那六七个 extent，必须在 `performLayout` 里算出来。这也是为什么上面的 Demo 里 `RenderSliverBanner` 连 `size` 都写不了。

### 4.6 绘制：`paintOffsetOf` 与 `growthDirection`

```dart
// rendering/viewport.dart:1243-1256
Offset computeAbsolutePaintOffset(RenderSliver child, double layoutOffset, GrowthDirection growthDirection) {
  assert(hasSize);
  assert(child.geometry != null);
  return switch (applyGrowthDirectionToAxisDirection(axisDirection, growthDirection)) {
    AxisDirection.up    => Offset(0.0, size.height - layoutOffset - child.geometry!.paintExtent),
    AxisDirection.left  => Offset(size.width - layoutOffset - child.geometry!.paintExtent, 0.0),
    AxisDirection.right => Offset(layoutOffset, 0.0),
    AxisDirection.down  => Offset(0.0, layoutOffset),
  };
}
```

```dart
// rendering/viewport.dart:996-1001
void _paintContents(PaintingContext context, Offset offset) {
  for (final RenderSliver child in childrenInPaintOrder) {
    if (child.geometry!.visible) {
      context.paintChild(child, offset + paintOffsetOf(child));
    }
  }
}
```

`visible` 是 `SliverGeometry` 里的一个 bool（`:807`），默认取 `paintExtent > 0.0`（`:665`）。**viewport 就是靠它跳过被滚出视口的 sliver 的**——不是靠坐标判断。也就是说，"我已经滚出去的 sliver 不要浪费 paint"这件事，是孩子自己声明的，不是父亲推断的。

## 五、核心对象：两个方向的结构体，字段语义对照

### 5.1 向下：`SliverConstraints`（`rendering/sliver.dart:197`）

| 字段 | 声明行 | 语义 | 谁最在意 |
|---|---|---|---|
| `axisDirection` | `:256` | 主轴正方向（`down` / `up` / `left` / `right`） | 所有 sliver（决定坐标朝向） |
| `growthDirection` | `:281` | 相对 `axisDirection` 的"增长方向"，center 之前的 sliver 是 `reverse` | 双向 sliver、`SliverAppBar` |
| `scrollOffset` | `:331` | 本 sliver 的起点已被滚过多少（**只在 `scrollOffset > 0` 时有意义**） | `SliverList`（决定从第几个 child 开始） |
| `precedingScrollExtent` | `:356` | 前面所有 sliver 的 `scrollExtent` 之和；前有懒加载 sliver 时可能是 `double.infinity` | `SliverPersistentHeader`（是否进入 floating/pinned） |
| `overlap` | `:368` | 前面 sliver 的 `paintExtent` 超出其 `layoutExtent` 的部分——本 sliver 的"头顶被压住多少" | `pinned` / `floating` sliver |
| `remainingPaintExtent` | `:381` | 从本 sliver 起点往下，还能画多少像素；可能为 0 | 所有 sliver（决定画多少） |
| `crossAxisExtent` | `:386` | 交叉轴长度（竖列表里就是宽度） | 所有 sliver |
| `crossAxisDirection` | `:392` | 交叉轴正方向（`LTR` / `RTL`） | 需要处理镜像的 sliver |
| `viewportMainAxisExtent` | `:397` | 视口在主轴上有多长（= 视口高度 / 宽度） | `SliverAppBar`（算收缩比） |
| `cacheOrigin` | `:420` | 缓存区从哪开始，**恒 ≤ 0 且不会越过 `-scrollOffset`** | `SliverList`（决定要不要在前面多建 child） |
| `remainingCacheExtent` | `:439` | 从 `cacheOrigin` 起要提供多少内容；**恒 ≥ `remainingPaintExtent`** | 懒加载 sliver |

`cacheOrigin` 与 `remainingCacheExtent` 的关系值得单独记一句（源码注释 `rendering/sliver.dart:413-415`）：

> The [cacheOrigin] is always negative or zero and will never exceed -[scrollOffset]. In other words, a sliver is never asked to provide content before its zero [scrollOffset].

"永远不会被要求在 `scrollOffset` 之前提供内容"——这一句就是第 45 篇实验 4 里 `cacheOrigin` 在列表顶部变成 0 的原因。

### 5.2 向上：`SliverGeometry`（`rendering/sliver.dart:641`）

| 字段 | 声明行 | 语义 | 消费方 |
|---|---|---|---|
| `scrollExtent` | `:718` | 本 sliver 贡献给"总滚动长度"的量。它**不等于可见高度**，是"我有多长" | `RenderViewport._minScrollExtent` / `_maxScrollExtent` |
| `paintOrigin` | `:744` | 第一个可见像素相对布局位置的偏移，可为负（`pinned` 就靠它） | `effectiveLayoutOffset`、下一个 sliver 的 `overlap` |
| `paintExtent` | `:764` | 本 sliver 当前实际画了多少 | `paintBounds`、下一个 sliver 的 `overlap` |
| `layoutExtent` | `:777` | "下一个 sliver 的布局起点"相对本 sliver 起点的距离；**默认等于 `paintExtent`**（`:662`）；**不得大于 `paintExtent`**（`:882`） | `layoutOffset` → 下一个 sliver 的 `remainingPaintExtent` |
| `maxPaintExtent` | `:785` | 若 `remainingPaintExtent` 无限，最多能画多少 | `RenderShrinkWrappingViewport` |
| `maxScrollObstructionExtent` | `:795` | pinned 时最多吃掉多少可滚动区域（AppBar 用） | 语义 / scrollbar |
| `hitTestExtent` | `:801` | 从 `paintOrigin` 起多远范围内接受命中；默认 `paintExtent` | `hitTest` |
| `visible` | `:807` | 当前是否参与绘制；默认 `paintExtent > 0.0`（`:665`） | `_paintContents` |
| `hasVisualOverflow` | `:814` | 是否需要裁剪（内容超出可视区域） | viewport 的 `pushClipRect` 决策 |
| `scrollOffsetCorrection` | `:830` | 非 null 时：请把偏移量改成这个值并重做布局（**不得为 0**，`:661`） | `RenderViewport.performLayout` 的 `do...while` |
| `cacheExtent` | `:843` | 含缓存区在内共提供多少内容；默认 `layoutExtent ?? paintExtent`（`:664`） | 下一个 sliver 的 `remainingCacheExtent` |

### 5.3 最容易混的三个 extent

| | `scrollExtent` | `paintExtent` | `layoutExtent` |
|---|---|---|---|
| 回答的问题 | 我"有多长"（对总滚动长度的贡献） | 我"现在画了多少" | 我"给下一个 sliver 让出多少位置" |
| 滚动时变化 | **不变**（对固定内容） | 变化（0 ↔ 视口高度） | 变化，通常与 `paintExtent` 同步 |
| `pinned` 场景下的值 | 头部完整高度 | 收缩后的剩余高度 | **0**（不占位，所以下面的内容能顶上来） |
| 送进 `_min/maxScrollExtent` | 是 | 否 | 否 |
| 决定下一个 sliver 的起点 | 否 | 否 | 是 |

一句话记忆：**`scrollExtent` 管"总长"，`paintExtent` 管"画多少"，`layoutExtent` 管"让位多少"**。默认三者相等，只有特殊效果（pinned / floating / 覆盖）才让它们分叉。

## 六、源码实验

### 实验 1：pinned 头部把 `layoutExtent` 与 `paintExtent` 拆开

代码：`CustomScrollView` = `SliverPersistentHeader(pinned: true, maxExtent: 120, minExtent: 60)` + `SliverList(itemExtent: 100)`，分别打印 t0 与 `jumpTo(150)` 之后每个 sliver 的 constraints / geometry。

**实际**（输出）：

```text
LAB8[t0]   _RenderSliverPinnedPersistentHeaderForWidgets
  C(scrollOffset=0.0, overlap=0.0, preceding=0.0, remainingPaint=600.0, cacheOrigin=0.0, remainingCache=850.0)
  G(scroll=120.0, paint=120.0, layout=120.0, maxPaint=120.0, cache=120.0, visible=true)
LAB8[t0]   RenderSliverList
  C(scrollOffset=0.0, overlap=0.0, preceding=120.0, remainingPaint=480.0, cacheOrigin=0.0, remainingCache=730.0)
  G(scroll=10000.0, paint=480.0, layout=480.0, maxPaint=10000.0, cache=730.0, visible=true)

LAB8[t150] _RenderSliverPinnedPersistentHeaderForWidgets
  C(scrollOffset=150.0, overlap=0.0, preceding=0.0, remainingPaint=600.0, cacheOrigin=-150.0, remainingCache=1000.0)
  G(scroll=120.0, paint=60.0, layout=0.0, maxPaint=120.0, cache=0.0, visible=true)
LAB8[t150] RenderSliverList
  C(scrollOffset=30.0, overlap=60.0, preceding=120.0, remainingPaint=600.0, cacheOrigin=-30.0, remainingCache=880.0)
  G(scroll=10000.0, paint=600.0, layout=600.0, maxPaint=10000.0, cache=880.0, visible=true)
```

**说明**：这一组数字把第五节所有字段都串起来了。

- **t0**：头部 `scrollExtent = paintExtent = layoutExtent = 120`；列表拿到的 `precedingScrollExtent = 120`、`remainingPaintExtent = 600 - 120 = 480`，`overlap = 0`。三者相等，是默认关系。
- **t150**：头部被"钉住"了。它自己 `scrollOffset = 150`（起点已被滚过 150），但 `paintExtent = 60`（收缩到 `minExtent`）而 **`layoutExtent = 0`**——它不占位了。于是：
  - 列表的 `remainingPaintExtent` 回到 **600**（整个视口），不再被扣掉 120；
  - 列表的 `overlap = 60`，正好等于头部的 `paintExtent`（`maxPaintOffset = 0 + 60`，而列表的 `layoutOffset` 还是 0）——**"有 60 像素压在你头上"这件事是通过 `overlap` 告诉下一个 sliver 的**；
  - 列表的 `scrollOffset = 30`，因为 `150 - 120 = 30`（`scrollExtent` 是 120，与是否 pinned 无关）；
  - `precedingScrollExtent` 仍是 120（`scrollExtent` 累加，与 `layoutExtent` 无关）。
- **注意头部有两个渲染对象**（`SliverPersistentHeader` 内部有两个 sliver 包着 `SliverPersistentHeaderDelegate`），它们的数字完全相同。

**结论**：`scrollExtent` ≠ `layoutExtent` 就是 pinned 效果的全部原理，源码依据是 `sliver.dart:777`（"The distance from the first visible part of this sliver to the first visible part of the next sliver"）与 `sliver.dart:718`（`scrollExtent` 描述的是"总长"）。

### 实验 2：手写 sliver 的往返值

用第二节的 `RenderSliverBanner`（高度 40）放在 `SliverList` 前，打印 t0 与拖动 300 之后的值。

```text
LAB12 RenderSliverBanner C(scrollOffset=0.0, remainingPaint=600.0, crossAxis=800.0) G(scroll=40.0, paint=40.0, layout=40.0)
LAB12 RenderSliverList   C(scrollOffset=0.0, remainingPaint=560.0, crossAxis=800.0) G(scroll=10000.0, paint=560.0, layout=560.0)
LAB12 after drag:
LAB12 RenderSliverBanner C(scrollOffset=300.0, cacheOrigin=-250.0) G(paint=0.0, visible=false)
LAB12 RenderSliverList   C(scrollOffset=260.0, cacheOrigin=-250.0) G(paint=600.0, visible=true)
```

**说明**：三处验证。

1. **`reminingPaintExtent` 链式递减**：banner 拿 600，list 拿 560，正是 `600 - layoutExtent(40)`。
2. **`cacheOrigin` 被压**：t0 时 banner 的 `cacheOrigin = 0.0`，滚过之后才变成 `-250.0`。与第 45 篇实验 4 一致。
3. **`visible = paintExtent > 0`**：滚动后 banner 的 `paintExtent` 由 `calculatePaintOffset` 算出 0，`visible` 自动变成 false，viewport 就不再 paint 它——**我作为 sliver 作者没有写任何"可见性判断"**。

### 实验 3：`layoutExtent` 不得大于 `paintExtent`（一次真实的失败）

第一版 Demo 里我把 `layoutExtent` 写成 `math.min(_extent, constraints.remainingPaintExtent)`（即恒定 40），而 `paintExtent` 用 `calculatePaintOffset` 算（滚出后为 0）。滚出去之后框架立刻抛出：

```text
SliverGeometry is not valid: The "layoutExtent" exceeds the "paintExtent".
The paintExtent is 0.0, but the layoutExtent is 40.0.
#0  SliverGeometry.debugAssertIsValid.<anonymous closure>.verify (package:flutter/src/rendering/sliver.dart:870:9)
#3  RenderViewportBase.layoutChildSequence (package:flutter/src/rendering/viewport.dart:843:34)
```

**说明**：这是 `SliverGeometry.debugAssertIsValid`（`rendering/sliver.dart:864`）里的第 36 行检查（`:882`）。它同时把 `layoutChildSequence` 的调用位置（`rendering/viewport.dart:843`）打印出来了——**读这类断言信息比读文档快**：它告诉你不只是"值不对"，还告诉你是哪个调用点在做校验。

去掉 `layoutExtent` 参数（让它默认等于 `paintExtent`，`:662`）后一切正常。这也说明这条不变式的含义：**sliver 不能让下一个 sliver 的起点落到自己"根本没画"的区域里**——否则 `layoutOffset` 会一直累加，后面的内容会被推到看不见的地方。

### 实验 4：`cacheExtent` 的 API 已换代

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -n "Deprecated" -A3 widgets/viewport.dart | grep -n "cacheExtent" 
grep -n "sealed class ScrollCacheExtent" rendering/viewport.dart
```

**实际**：`widgets/viewport.dart:67-77` 的 `this.cacheExtent` 与 `this.cacheExtentStyle` 都带 `@Deprecated('Use scrollCacheExtent instead. This feature was deprecated after v3.41.0-0.0.pre.')`；`rendering/viewport.dart:42` 是 `sealed class ScrollCacheExtent`，两个工厂 `ScrollCacheExtent.pixels`（`:46`）与 `ScrollCacheExtent.viewport`（`:55`）。

**说明**：`RenderViewportBase.cacheExtent` 的 getter/setter（`rendering/viewport.dart:554` / `:560`）反而**没有**被弃用——弃用的是 `Viewport` widget 上那一对参数。3.41 起推荐的写法是：

```dart
CustomScrollView(
  scrollCacheExtent: const ScrollCacheExtent.viewport(2.0), // 缓存区 = 视口高度的 2 倍
  slivers: <Widget>[...],
)
```

## 七、结论

1. sliver 协议是一次**有方向的往返**：`SliverConstraints`（`sliver.dart:197`）向下描述"你能用多少空间、你前面已经滚过多少"，`SliverGeometry`（`:641`）向上描述"你有多长、画了多少、让位多少、要不要校正偏移量"。`RenderSliver` 没有 `size`，它的尺寸结论就存在 `geometry` 里（`:1399`）。
2. viewport 不测量孩子，它**读孩子的自述**并把累积量往下传（`rendering/viewport.dart:855-874`）：`scrollExtent` 累加进 `scrollOffset` / `precedingScrollExtent`，`layoutExtent` 累加进 `layoutOffset`，`paintExtent` 影响下一个孩子的 `overlap`，`cacheExtent` 影响 `remainingCacheExtent`。所以同一条链上的 sliver 是顺序相关的。
3. `scrollExtent` / `paintExtent` / `layoutExtent` 三个 extent 默认相等，**只有特殊效果才让它们分叉**：pinned 头部让 `layoutExtent` 变成 0（不占位）而 `paintExtent` 保留收缩后的高度，于是下一个 sliver 的 `overlap` 变成 60、`remainingPaintExtent` 回到满值。这是 3.44.8 的源码能精确支撑的解释。

**viewport 是约束分发器，sliver 是自述型孩子；`SliverConstraints` 向下、`SliverGeometry` 向上，一次往返决定链上每一个 sliver 的空间。**

## 八、边界声明

- 本文只讲协议本身（字段语义 + 一次往返 + 绘制偏移）。**懒加载 sliver 怎么用 `remainingCacheExtent` 决定建几个 child、`keepAlive` 桶怎么工作，是第 48 篇。**
- `SliverPersistentHeader` 的 `pinned` / `floating` / `snap` 三种模式的完整实现、`SliverAppBar` 的收缩算法，本文不展开；这里只从协议角度解释"为什么 pinned 能成立"。
- `CustomScrollView` / `NestedScrollView` 的 widget 组合与协调逻辑，本文不展开。
- `SliverGrid` / `SliverFillRemaining` / `SliverCrossAxisGroup` 等具体 sliver 的布局算法不展开；需要时按类名读，它们的 `performLayout` 都是本节 4.5 那套骨架。
- `RenderShrinkWrappingViewport`（`rendering/viewport.dart:2003`）的 `maxPaintExtent` 用法只在第五节表格里提一句，不做线程级展开。
- `RenderAbstractViewport.getOffsetToReveal`（`:1057`）是怎么"反向求偏移量"的（`ensureVisible` / `Scrollable.ensureVisible` 的底层），留给需要时按方法名读；它属于同一套 extent 算术的逆运算。
