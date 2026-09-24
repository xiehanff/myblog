# 35 Layer 树与合成：RepaintBoundary 什么时候真的省事

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/layer.dart`（3029 行）、`rendering/object.dart`、`rendering/proxy_box.dart`

## 一、问题

`RepaintBoundary` 是 Flutter 性能话题里出现频率最高的 Widget。问题是：**它什么时候真的省事，什么时候只是多一层？**

错误直觉有三个，都很常见：

1. **"`RepaintBoundary` 是位图缓存"** —— 框架层能保证的不是位图，而是**独立的 display list**。`RenderRepaintBoundary` 的文档原话是 "Creates a separate display list for its child"（`proxy_box.dart:3461`），收益描述是 "when the child does not repaint but its parent does, we can re-use the display list we recorded previously"（`proxy_box.dart:3465-3467`）。**省的是"重新录制绘制指令"，不是"重新光栅化"**——后者是引擎侧的行为，框架不做承诺。
2. **"加了就一定更快"** —— 每个边界都有固定成本：一个 `OffsetLayer`、一次 `removeAllChildren`、一次 layer 树的挂载/卸载、以及 `_compositeChild` 的一次额外分支。只有当"父重画而子不需要重画"（或反之）**真的频繁发生**时，这些成本才被赚回来。
3. **"页面上只有我写的那些 `RepaintBoundary`"** —— 本地实测 grep 全 SDK，共有 **14 处** `bool get isRepaintBoundary => true`，分布在 11 个文件里。`RenderView`、`RenderViewport`、`RenderEditable`、`RenderFlow`、`RenderPlatformView`、`RenderTexture` 全都是边界。**`ListView` 的视口天然就是一层边界**，在 `ListView` 里再套 `RepaintBoundary` 往往是多余的。

**关键认知**：框架自己给这个问题留了量化工具。`RenderRepaintBoundary` 会统计"父与子同时重画"（`debugSymmetricPaintCount`）和"只有一方重画"（`debugAsymmetricPaintCount`）的次数（`proxy_box.dart:3635` / `3651`），并在 `debugDumpRenderTree()` 的输出里直接给出结论——从"this is an outstandingly useful repaint boundary and should definitely be kept"到"this repaint boundary is astoundingly ineffectual and should be removed"（`proxy_box.dart:3691-3703`）。**"什么时候真的省事"这个问题，框架给了一个可运行的判据。**

## 二、最小 Demo

用两个自定义 RenderObject 直接观测"边界有没有挡住重画"：

```dart
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';

/// 一个每帧都把自己标脏的叶子，模拟动画。
class RenderTickerBox extends RenderProxyBox {
  @override
  void paint(PaintingContext context, Offset offset) {
    // 1. 每帧结束时标脏自己，下一帧就会重画
    SchedulerBinding.instance.addPostFrameCallback((_) => markNeedsPaint());
    super.paint(context, offset);
  }
}

/// 一个只负责数自己被 paint 了几次的透传节点。
class RenderPaintCounter extends RenderProxyBox {
  int paintCount = 0;

  @override
  void paint(PaintingContext context, Offset offset) {
    paintCount += 1;
    super.paint(context, offset);
  }
}
```

把这两个 RenderBox 各配一个 `SingleChildRenderObjectWidget`（`createRenderObject` 返回对应实例），再跑同一个布局两次，唯一差别是第二个孩子外面有没有 `RepaintBoundary`：

```dart
Column(
  children: <Widget>[
    const TickerBox(child: SizedBox(width: 20, height: 20)),
    // 2. 改这一行：加或不加 RepaintBoundary
    RepaintBoundary(child: PaintCounter(child: const SizedBox(width: 20, height: 20))),
  ],
)
```

本地实测同一个探针跑 5 帧的结果：

```text
无 RepaintBoundary: 5 帧后 subject 重画次数增量 = 5
有 RepaintBoundary: 5 帧后 subject 重画次数增量 = 0
```

`TickerBox` 每帧重画，把没有边界保护的兄弟节点一起拖下水；加了边界之后，兄弟节点的 `paint` **一次都没有被调用**。这就是"省事"的准确含义。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering/layer.dart:144` | `abstract class Layer with DiagnosticableTreeMixin` |
| `rendering/layer.dart:824` | `class PictureLayer extends Layer`（唯一装着绘制指令的叶子层） |
| `rendering/layer.dart:1077` | `class ContainerLayer extends Layer` |
| `rendering/layer.dart:1118` | `ui.Scene buildScene(ui.SceneBuilder builder)`，合成的入口 |
| `rendering/layer.dart:1459` | `class OffsetLayer extends ContainerLayer`，repaint boundary 专用 |
| `rendering/object.dart:3066` | `bool get isRepaintBoundary => false;` |
| `rendering/object.dart:3194` | `markNeedsCompositingBitsUpdate()`，会在边界处停下 |
| `rendering/object.dart:3326` | `markNeedsPaint()`，判据是 `isRepaintBoundary && _wasRepaintBoundary` |

表中只列追这条链的主入口；其余锚点随第四、六节的正文就近给出，不重复列。

## 四、调用链

### 4.1 Layer 树的三种角色

`Layer` 的继承链很短，但职责划分很清楚：

| 类 | 位置 | 角色 |
|---|---|---|
| `Layer` | `layer.dart:144` | 抽象基类：父子链、owner、`_needsAddToScene`、`addToScene` |
| `PictureLayer` | `layer.dart:824` | 叶子层，持有一个 `ui.Picture`（一段 display list） |
| `ContainerLayer` | `layer.dart:1077` | 有孩子，负责把孩子的层按顺序加进 Scene |
| `OffsetLayer` | `layer.dart:1459` | `ContainerLayer` + 一个 `Offset`，**repaint boundary 专用** |
| `ClipRectLayer` / `TransformLayer` / `OpacityLayer` | `:1601` / `:2038` / `:2138` | 分别加 clip / transform / alpha |

**关键认知**：`PictureLayer` 是唯一"装着绘制指令"的层，`ContainerLayer` 家族只做结构和变换。而 repaint boundary 自己持有的层是 `OffsetLayer`——一个**容器层**：`_repaintCompositedChild` 为它创建并挂上 `OffsetLayer`（`object.dart:150-152`，且断言 `child._layerHandle.layer is OffsetLayer`，`:173`），`PaintingContext` 再以这个 `OffsetLayer` 为容器开始录制，`_startRecording` 才在其中新建一个 `PictureLayer` 并 append 进去（`object.dart:360-365`）。所以"一个 `RepaintBoundary` 省了一次重画"的物理含义是：**它的子树绘制被录进它自己的 `OffsetLayer` 下属的一个 `PictureLayer`；boundary 不需要重画时，整个 `OffsetLayer` 连同子层原样复用，重画时 `removeAllChildren` 清掉的是子层（`PictureLayer` 会重录），`OffsetLayer` 实例本身保留。**

Layer 也有 owner 与 `attached`（`layer.dart:506` / `513`），并且 `layer.dart:504` 的注释说明 owner "Typically the owner is a [RenderView]"——**Layer 树的 owner 是 RenderView，不是 PipelineOwner**。这是 Layer 与 RenderObject 归属体系的关键差异。

### 4.2 Layer 的所有权：`LayerHandle` 的引用计数

`RenderObject` 不直接持有 `ContainerLayer`，而是持有一个 `LayerHandle`：

```dart
// rendering/object.dart:3159
final LayerHandle<ContainerLayer> _layerHandle = LayerHandle<ContainerLayer>();
```

`LayerHandle` 的设置在幕后做了引用计数——先 `_layer?._unref()` 给旧层减引用，再 `_layer!._refCount += 1` 给新层加引用（`layer.dart:799-812`）。而 `Layer._unref()`（`layer.dart:277-283`）在计数归零时**自动 dispose 自己**：

```dart
// rendering/layer.dart:277-283（节选）
void _unref() {
  assert(_refCount > 0);
  _refCount -= 1;
  if (_refCount == 0) {
    dispose();
  }
}
```

**关键认知**：这个引用计数解释了一个容易踩的坑——**图层不是"谁 new 谁负责 dispose"，而是"谁持有 handle 谁负责置空"**。注意 `_layerHandle` 的类型是 `LayerHandle<ContainerLayer>`（`object.dart:3159`），`PictureLayer` 不是 `ContainerLayer`，类型上就进不了它；可能同时被 `_layerHandle` 和父 `ContainerLayer` 孩子链持有的是 `ClipRectLayer` / `OpacityLayer` 这类专门层——非边界节点在 `needsCompositing` 时 `layer = context.pushClipRect(...)`（如 `proxy_box.dart:1644`），`pushLayer` 把新层 append 进父容器层的同时，RenderObject 也用 `_layerHandle` 持有它。`layer.dart:1189-1200` 的 `ContainerLayer.attach/detach` 会递归处理孩子链的引用，所以只有当所有持有者都放手，图层才会被真正销毁。

`object.dart:3149` 的 setter 有一条重要断言：`assert(!isRepaintBoundary, 'Attempted to set a layer to a repaint boundary render object. ...')`。

**`RepaintBoundary` 的图层不能自己设**——框架在 `repaintCompositedChild` 里创建并赋值（走的是 `_layerHandle.layer = childLayer` 这条私有路径，`object.dart:152`）。只有非边界的节点（如 `RenderOpacity`、`RenderClipRect`）才能通过 `layer` setter 自己管理图层。

### 4.3 paint 阶段：图层是怎么产生的

`paintChild` 是所有绘制都必须经过的岔路口：

```dart
// rendering/object.dart:249-267
void paintChild(RenderObject child, Offset offset) {
  if (child.isRepaintBoundary) {
    stopRecordingIfNeeded();
    _compositeChild(child, offset);              // 1. 子是边界 → 走合成路径
  } else if (child._wasRepaintBoundary) {        // 2. 曾经是边界、现在不是
    assert(child._layerHandle.layer is OffsetLayer);
    child._layerHandle.layer = null;             //    归还图层
    child._paintWithContext(this, offset);
  } else {
    child._paintWithContext(this, offset);       // 3. 普通情况：画进当前 PictureLayer
  }
}
```

第 2 个分支是"边界身份被撤掉"的清理点（`object.dart:258-259` 的注释："the framework managed layer is automatically disposed"），与 32 篇 `markNeedsCompositingBitsUpdate` 的 `!_wasRepaintBoundary || !isRepaintBoundary` 判据配套。

真正产生图层的是 `_compositeChild` → `repaintCompositedChild`（`object.dart:269-292`）：需要重画就 `repaintCompositedChild(child, debugAlsoPaintedParent: true)`，否则最多 `updateLayerProperties(child)`；最后 `childOffsetLayer.offset = offset` 由框架赋值，再 `appendLayer` 挂进父的图层树。

`markNeedsCompositedLayerUpdate`（`object.dart:3386`）让一个边界**只更新图层自身的属性**（比如 `RenderOpacity` 的 alpha、`RenderTransform` 的矩阵），而**不重画孩子**。这是比 `RepaintBoundary` 更省的一档：

```dart
// rendering/object.dart:3386-3405（节选）
void markNeedsCompositedLayerUpdate() {
  _needsCompositedLayerUpdate = true;
  if (isRepaintBoundary && _wasRepaintBoundary) {
    owner!._nodesNeedingPaint.add(this);         // ← 进的是同一张 paint 脏表
    owner!.requestVisualUpdate();
  } else {
    markNeedsPaint();                            // 不是边界 → 退化成完整重画
  }
}
```

**关键认知**：`_needsCompositedLayerUpdate` 和 `_needsPaint` 共用 `_nodesNeedingPaint`，`flushPaint` 靠 `if (node._needsPaint) repaintCompositedChild else updateLayerProperties`（`object.dart:1324-1328`）分派。所以"只更新图层属性"与"完整重画"的区别不在脏表，而在消费方式。

### 4.4 复用图层：`updateCompositedLayer` 与"必须复用实例"

边界重画时会走 `updateCompositedLayer`：

```dart
// rendering/object.dart:3112-3115
OffsetLayer updateCompositedLayer({required covariant OffsetLayer? oldLayer}) {
  assert(isRepaintBoundary);
  return oldLayer ?? OffsetLayer();
}
```

默认实现就是"有旧的就用旧的，没有就新建"。`_repaintCompositedChild` 里对返回值有硬性校验：

```dart
// rendering/object.dart:160-168（节选）
childLayer.removeAllChildren();
final OffsetLayer updatedLayer = child.updateCompositedLayer(oldLayer: childLayer);
assert(
  identical(updatedLayer, childLayer),
  '$child created a new layer instance $updatedLayer instead of reusing the '
  'existing layer $childLayer. See the documentation of RenderObject.updateCompositedLayer '
  'for more information on how to correctly implement this method.',
);
assert(debugOldOffset == updatedLayer.offset);
```

**关键认知**：两件事被断言钉死。第一，**重画时必须复用同一个 `OffsetLayer` 实例**（不能换成新实例）；第二，**`offset` 不能被 `updateCompositedLayer` 改动**（`object.dart:168`），因为它由框架在 `_compositeChild` 里赋值（`object.dart:290`）。这解释了 `object.dart:3102-3103` 的文档警告："The [OffsetLayer.offset] property will be managed by the framework and must not be updated by this method."

`childLayer.removeAllChildren()`（`object.dart:160`）是重画前必做的一步：**清空该边界之下的子树图层，但 `OffsetLayer` 实例本身保留**。所以边界重画时，它下面的所有图层都会被重建（除非子层本身也是边界且不需要重画，此时 `_compositeChild` 会走 else 分支把子层的 layer 重新 append 回来）。

### 4.5 合成：`buildScene` 与 `_needsAddToScene`

图层树的最终出口在 `RenderView.compositeFrame`：

```dart
// rendering/view.dart:347-359（节选）
void compositeFrame() {
  assert(layer != null, 'call prepareInitialFrame before calling compositeFrame');
  final ui.SceneBuilder builder = RendererBinding.instance.createSceneBuilder();
  final ui.Scene scene = layer!.buildScene(builder);
  ...
}
```

`buildScene` 在 `ContainerLayer` 上（`layer.dart:1118-1130`）：先 `updateSubtreeNeedsAddToScene()` 汇总"要不要重录"，再 `addToScene(builder)` 递归把每个层加进 `SceneBuilder`，**最后**才 `_needsAddToScene = false`（注释说明必须在 `addToScene` 之后清，因为 `addToScene` 调孩子的同名方法时可能反过来标脏自己），然后 `builder.build()` 出 Scene。

单层的汇总规则在 `layer.dart:493-497`：

```dart
// rendering/layer.dart:493-497（节选）
void updateSubtreeNeedsAddToScene() {
  _needsAddToScene = _needsAddToScene || alwaysNeedsAddToScene;
}
```

**这就是 `RepaintBoundary` 收益的第二层机制**：`_needsAddToScene` 是**从下往上 OR** 的（`ContainerLayer` 的覆盖版在 `layer.dart:1160-1168` 里遍历孩子后 `_needsAddToScene = _needsAddToScene || child._needsAddToScene`）。如果一片子树完全没有变化，它的 `_needsAddToScene` 保持 false，`addToScene` 在那一支上就退化成"复用引擎已有的层"，不会重新提交绘制指令。

**关键认知**：`RepaintBoundary` 的完整收益链是"paint 阶段不重新录制 display list" → "`_needsAddToScene` 保持 false" → "合成阶段复用引擎层"。三个环节都成立才省钱；中间任何一环破了（比如父重画导致边界也被标脏），收益就没了。

### 4.6 `markNeedsPaint` 与 `needsCompositing`：两条不同的传播

paint 的脏标记传播在第 32 篇已展开，这里只需要记住它的**边界判据是 `isRepaintBoundary && _wasRepaintBoundary`**（`object.dart:3335`）。另外两条与合成相关但容易混的机制：

**第一，`markNeedsCompositingBitsUpdate` 的传播会在边界处停下。** 判据是 `(!_wasRepaintBoundary || !isRepaintBoundary) && !parent.isRepaintBoundary`（`object.dart:3206`），含义是"自己是普通节点且父也普通时才继续往上"。所以 repaint boundary 同时是 compositing bits 的传播屏障。

**第二，`needsCompositing` 的语义是"我或我的后代里有图层"。** 它是 `_updateCompositingBits()` 从孩子向上汇总出来的（`object.dart:3228-3242`），核心两行是：

```dart
// rendering/object.dart:3228-3242（节选）
_needsCompositing = false;
visitChildren((RenderObject child) {
  child._updateCompositingBits();
  if (child.needsCompositing) { _needsCompositing = true; }
});
if (isRepaintBoundary || alwaysNeedsCompositing) {
  _needsCompositing = true;        // ← "边界及其所有祖先必为 true"的源码依据
}
```

这个位被大量绘制 API 当作分支开关用：

```dart
// rendering/object.dart:584-593（节选）
if (needsCompositing) {
  final ClipRectLayer layer = oldLayer ?? ClipRectLayer();
  layer..clipRect = offsetClipRect..clipBehavior = clipBehavior;
  pushLayer(layer, painter, offset, childPaintBounds: offsetClipRect);
  return layer;
} else {
  clipRectAndPaint(offsetClipRect, clipBehavior, offsetClipRect, () => painter(this, offset));
  return null;                          // ← 不需要合成：直接用 canvas 裁剪，不建层
}
```

**关键认知**：`needsCompositing` 为 false 时，`pushClipRect` **根本不创建 `ClipRectLayer`**，而是直接在 canvas 上 `clipRectAndPaint`。所以"一个 `ClipRect` 会不会产生一个图层"取决于它上面是否有 repaint boundary——**有边界就会，没有就不会**。这是"边界改变的不只是重画范围，还有整条子树的图层结构"。

### 4.7 回答标题：什么时候省事

把上面的机制合起来，判据只有一条：**父与子的重画时机是否不同**。

| 场景 | 边界的作用 | 结论 |
|---|---|---|
| 动画区域旁边有静态大子树 | 动画帧里静态子树 `paint` 完全不执行 | 省事（本地实测 5 帧 → 0 次重画） |
| 静态子树旁边有动画区域 | 静态区域变化时动画区域的图层可复用 | 省事 |
| 父子总是同时变化（如整个页面随同一个 `AnimationController` 变） | 每帧两边都重画，边界白付成本 | 只是多一层 |
| 子树在 `ListView` / `ScrollView` 内 | 视口本身已是边界（`viewport.dart:752`） | 通常多余 |
| 子树在 `RepaintBoundary` 内又套一层 | 外层已拦截 | 通常多余 |
| 子树需要单独导出图像（`toImage`） | 必须有边界 | 不是性能问题，是功能需求 |

框架给的量化口径是**非对称重画比例**：

```dart
// rendering/proxy_box.dart:3667-3676
@override
void debugRegisterRepaintBoundaryPaint({bool includedParent = true, bool includedChild = false}) {
  assert(() {
    if (includedParent && includedChild) {
      _debugSymmetricPaintCount += 1;      // 父子一起重画 → 边界冗余
    } else {
      _debugAsymmetricPaintCount += 1;     // 只有一方重画 → 边界有价值
    }
    return true;
  }());
}
```

调用点只有两处（`object.dart:136` 和 `object.dart:283`），而诊断文本直接给出结论（`proxy_box.dart:3691-3703`）：比例 > 0.9 是 "outstandingly useful"，< 0.1 是 "not very effective and should probably be removed"，重画次数少于 5 次则 "insufficient data to draw conclusion"。

## 五、核心对象：四组对比

| | `RenderObject` 树 | `Layer` 树 |
|---|---|---|
| 节点数 | 与 Element 数量同量级 | 远少（只有边界 + 需要合成的节点） |
| owner | `PipelineOwner`（从根下发） | `RenderView`（`layer.dart:504` 注释） |
| 谁创建节点 | `createRenderObject` | paint 阶段的 `pushLayer` / `updateCompositedLayer` |
| 是否每帧重建 | 否（常驻） | 是（`removeAllChildren` 后重建子树） |
| 是否可导出图像 | 否 | 是（`OffsetLayer.toImage`） |
| 排序用途 | `depth` 决定 layout/paint 顺序 | 孩子链顺序 = 绘制顺序 |

| | `PictureLayer` | `OffsetLayer` |
|---|---|---|
| 位置 | `layer.dart:824` | `layer.dart:1459` |
| 有无孩子 | 无（叶子） | 有（`ContainerLayer` 子类） |
| 内容 | 一个 `ui.Picture`（display list） | 孩子链 + 一个 `Offset` |
| 谁持有 | 没有任何 RenderObject 直接持有它——`PaintingContext` 录制时创建并 append 给当前容器层（`object.dart:360-365`） | **只有 repaint boundary**（框架在 `_repaintCompositedChild` 里创建，`object.dart:150-152`） |
| 能否被 `RenderObject.layer` 设 | 不能（`set layer` 的参数类型是 `ContainerLayer?`，`PictureLayer` 不是 `ContainerLayer` 子类） | 不能（`object.dart:3150` 断言） |

| | `_needsPaint` 的消费 | `_needsCompositedLayerUpdate` 的消费 |
|---|---|---|
| 触发 | `markNeedsPaint()` | `markNeedsCompositedLayerUpdate()` |
| 脏表 | `_nodesNeedingPaint` | 同一张 `_nodesNeedingPaint` |
| 消费方式 | `repaintCompositedChild`（重录子树） | `updateLayerProperties`（只改图层属性） |
| 是否重画孩子 | 是（`removeAllChildren` 后重建） | **否** |
| 非边界上调用时 | 向上传播 | 退化成 `markNeedsPaint` |

| | `relayoutBoundary` | `repaintBoundary` |
|---|---|---|
| 判据 | `_isRelayoutBoundary`（layout 时算） | `isRepaintBoundary`（类级别 getter） |
| 粒度 | 几乎每个节点都可能是 | 只有显式声明 true 的类 |
| 脏表 | `_nodesNeedingLayout` | `_nodesNeedingPaint` |
| 是否产生图层 | 否 | 是（一个 `OffsetLayer`） |
| 给谁省钱 | CPU 布局计算 | 绘制指令录制与合成 |

## 六、源码实验

### 实验 1：数一数框架里有多少个 repaint boundary

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn --include="*.dart" "bool get isRepaintBoundary => true" . | sort
```

**预测**：应该只有 `RenderRepaintBoundary` 一处（`RepaintBoundary` Widget 的唯一实现）。

**实际**：14 条命中，11 个文件：

```text
cupertino/text_selection_toolbar.dart:243
rendering/editable.dart:2749        RenderEditable
rendering/flow.dart:267             RenderFlow
rendering/list_wheel_viewport.dart:511
rendering/platform_view.dart:152 / 329 / 738
rendering/proxy_box.dart:3491       RenderRepaintBoundary
rendering/texture.dart:86
rendering/view.dart:315             RenderView
rendering/viewport.dart:752         RenderViewport
widgets/single_child_scroll_view.dart:429
widgets/two_dimensional_viewport.dart:807
```

**说明**：`RenderViewport` 是边界这一条最实用。**任何 `ListView` / `GridView` / `SingleChildScrollView` / `CustomScrollView` 的滚动视口本身就是一层边界**，所以在列表项里加 `RepaintBoundary` 时，要问的是"这个列表项的重画时机是否和它的兄弟不同"，而不是"我要不要防止整页重画"——视口已经拦住了。

### 实验 2：边界挡住重画（实测）

用第二节的两个 RenderObject，`TickerBox` 每帧标脏自己，`PaintCounter` 统计自己 `paint` 的次数，跑 5 帧：

```text
无 RepaintBoundary: 5 帧后 subject 重画次数增量 = 5
有 RepaintBoundary: 5 帧后 subject 重画次数增量 = 0
```

**预测**：加边界后应该减少，但可能还有零星几次（比如首帧）。

**实际**：5 → 0，完全归零。

**说明**：为什么无边界时是 5 而不是更多？因为 `TickerBox.markNeedsPaint()` 走到最近的 repaint boundary（测试环境里是 `RenderView`），由那个边界带整棵子树重画一次——**每个脏节点只贡献"一次"父边界的重画**。这也是"为什么宁可多设边界"的直觉来源：一条链上只要有一个节点脏，它到最近边界之间的整片子树都要重画。

### 实验 3：框架自己的诊断指标（实测）

构造一棵树：外层 `RepaintBoundary`，内层 `RepaintBoundary`，中间夹一个每帧标脏的 `TickerBox`，内层再放一个可选的"每帧标脏"的孩子。跑 20 帧后读两组计数：

```text
innerTicks=false outerBoundary=false  inner(sym=0,asym=20)
innerTicks=true  outerBoundary=false  inner(sym=0,asym=20)
innerTicks=false outerBoundary=true   inner(sym=0,asym=20)  outer(sym=1,asym=30)
innerTicks=true  outerBoundary=true   inner(sym=0,asym=20)  outer(sym=1,asym=30)
```

**预测**：`outerBoundary=true` 且内外都重画时，`symmetric` 应该明显上升（父子同时重画 = 边界冗余）。

**实际**：四种配置下 `inner` 的 `symmetric` 全是 0、`asymmetric` 全是 20；只有外层边界在 `outerBoundary=true` 时出现 1 次 `symmetric`。

**说明**：这里只给机制与一组观测值，不做归因结论。机制上 `symmetric` 只在 `_compositeChild` 走 `repaintCompositedChild(debugAlsoPaintedParent: true)` 那一支时才加（`object.dart:136` + `object.dart:275`），即"父边界重画时正好把子边界一起画掉"。观测值表明这个条件比文档语气暗示的更苛刻，要下更稳的结论需要更多配置的对照实验。

### 实验 4：`needsCompositing` 决定要不要建层

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
sed -n '579,594p' object.dart      # pushClipRect 的两个分支
grep -n "isRepaintBoundary || alwaysNeedsCompositing" object.dart
```

**预测**：`pushClipRect` 应该总是创建一个 `ClipRectLayer`（毕竟名字里就有 Clip）。

**实际**：`object.dart:579-582` 是 `Clip.none` 直接画并返回 null；`object.dart:584-590` 是 `needsCompositing` 为 true 时建层；`object.dart:592` 是 `needsCompositing` 为 false 时走 `clipRectAndPaint`（canvas 裁剪）**并返回 null**。而 `object.dart:3240` 是那行 `if (isRepaintBoundary || alwaysNeedsCompositing)`。

**说明**：一个 `ClipRect` 是否产生图层，取决于它上面有没有 repaint boundary。所以**加 `RepaintBoundary` 会改变子树的图层结构，不只是重画范围**。这也是"边界加多了反而可能变慢"的一条具体路径：图层多了，合成阶段的工作量也上去了。

### 实验 5：图层实例必须复用

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
sed -n '160,169p' object.dart
sed -n '3112,3115p' object.dart
```

**预测**：重画一个边界时，新建一个 `OffsetLayer` 也不影响正确性。

**实际**：`object.dart:162-167` 是一条 `identical(updatedLayer, childLayer)` 断言，失败会抛 "created a new layer instance ... instead of reusing the existing layer"。`object.dart:168` 还有一条 `assert(debugOldOffset == updatedLayer.offset)`。而 `updateCompositedLayer` 的默认实现（`object.dart:3112-3115`）就是 `return oldLayer ?? OffsetLayer();`。

**说明**：**自定义 repaint boundary（重写 `isRepaintBoundary` 为 true）时必须重写 `updateCompositedLayer` 并复用传入的 `oldLayer`**，否则 debug 模式直接崩。同时不能碰 `offset`——它由 `_compositeChild` 的 `childOffsetLayer.offset = offset`（`object.dart:290`）管理。

## 七、结论

1. `RepaintBoundary` 的收益是**独立的 display list**（`proxy_box.dart:3461`），链条是"paint 阶段不重录 → `_needsAddToScene` 保持 false → `buildScene` 时复用引擎层"（`layer.dart:1118` / `1160`）。它省的是绘制指令的录制，不是光栅化。本地实测：动画兄弟每帧重画时，被边界保护的子树 5 帧内 `paint` 调用次数从 5 降到 0。
2. **判断"值不值得"的判据是父子重画时机是否不同**，框架把它量化为 `debugAsymmetricPaintCount / (symmetric + asymmetric)`（`proxy_box.dart:3635` / `3651`），并在 `debugDumpRenderTree()` 里给出从 "outstandingly useful" 到 "astoundingly ineffectual and should be removed" 的直接结论（`proxy_box.dart:3691-3703`）。另外要注意框架自带 14 个边界（`RenderView`、`RenderViewport`、`RenderEditable` 等），`ListView` 里的额外边界通常多余。
3. 边界不是免费的：它要一个 `OffsetLayer`（引用计数管理，`layer.dart:277` / `794`），重画时要 `removeAllChildren` 后重建子树图层（`object.dart:160`），而且它把 `needsCompositing` 强制为 true（`object.dart:3240`），使子树的 `pushClipRect` / `pushTransform` 等从"canvas 操作"升级为"建层"。**自定义边界还必须重写 `updateCompositedLayer` 并复用实例**（`object.dart:3112`）。

一句话总结：**`RepaintBoundary` 买的是"子树的重画时机独立"，只有当父与子真的不同步重画时才划算；框架已经把"划算不划算"的量化指标放在 `debugDumpRenderTree` 里了。**

## 八、边界声明

- 本篇不展开引擎侧的光栅化缓存、`ui.Picture` 的内部结构、Impeller / Skia 的图层合并策略。框架层的承诺到 `ui.Scene` 生成为止。
- `TransformLayer` / `OpacityLayer` / `BackdropFilterLayer` 等专门图层的绘制数学不在本篇展开，只做角色定位。
- `Layer.findAnnotations`、`Layer.addCompositionCallback`、`AnnotatedRegionLayer` 不在本卷展开。
- 平台视图（`RenderPlatformView` / `RenderTexture`）为什么必须是边界，只在锚点表列出，留给平台集成相关篇目。
- `renderObject.layer` 与 `paintChild` 的三个分支已在 31 篇的 paint 契约里出现过，本篇补的是"分支之后层是怎么被创建、复用、合成的"。
- 本篇聚焦框架自带的量化诊断指标、`_needsAddToScene` 的向上汇总规则、`LayerHandle` 引用计数，以及"框架自己有 14 个边界"这条清单。
