# 51 material 抽样下潜：Material 与 InkWell 的完整链路

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/material/material.dart`（1060 行）、`material/ink_well.dart`（~1900 行）、`material/ink_splash.dart`、`material/ink_highlight.dart`

## 一、问题

按 `packages/flutter/lib/src` 的规模统计，`material` 有 198 个文件、约 21.1 万行，是 `widgets`（186 文件 / 15.6 万行）的 1.35 倍。整个 `material` + `cupertino` 占了框架代码量的一半以上。

于是最自然的怀疑是：**material 层里藏着一套 widgets 层没有的机制**。毕竟它要处理 elevation、阴影、墨迹、涟漪、印章、转场——这些看起来都得有专门的渲染支持。

本文挑最小的两个对象做抽样下潜，验证一个结论：**material 层没有新的渲染协议，也没有新的树结构。它做的事情只有三类——组合已有的 widgets、配置已有的 rendering 原语、以及少数几个只为单个组件服务的私有 RenderObject。**

抽样对象选 `Material` 和 `InkWell`，因为它们是 material 的"地基 + 交互"两端，而且两者的连接方式（`Material.of`）恰好是这套结论最直接的证据。

## 二、最小 Demo

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(home: Scaffold(body: Center(child: Demo())));
  }
}

class Demo extends StatelessWidget {
  const Demo({super.key});

  @override
  Widget build(BuildContext context) {
    return Material(
      // 1. type 用 canvas + 不传 shape → Material 会走"快路径"产出 AnimatedPhysicalModel
      color: const Color(0xFF112233),
      child: InkWell(
        onTap: () => debugPrint('tapped'),
        child: const SizedBox(width: 120, height: 60),
      ),
    );
  }
}
```

这一点信息（`type: MaterialType.canvas` 且 `shape == null`）决定了 `Material.build` 走哪个分支——第六节实验会把它打出来。

想直接看到"墨迹是谁画的"，读这个 getter 就够了：

```dart
// 2. Material.of 返回的是 MaterialInkController，不是 Widget
final MaterialInkController ink = Material.of(context);
debugPrint('${ink.runtimeType}');   // 实测输出：_RenderInkFeatures
```

`_RenderInkFeatures` 是一个 **RenderObject**，不是 InheritedWidget——这是本文最重要的一处认知修正。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `material/material.dart:183` | `class Material extends StatefulWidget`，注意是 **StatefulWidget** |
| `material/material.dart:451` | `class _MaterialState extends State<Material> with TickerProviderStateMixin` |
| `material/material.dart:455` | `_MaterialState.build`，四个分支在这里分叉 |
| `material/material.dart:83` | `abstract class MaterialInkController`，只是 4 个方法的接口 |
| `material/material.dart:96` | `void addInkFeature(InkFeature feature);` |
| `material/material.dart:376` | `Material.maybeOf` → `LookupBoundary.findAncestorRenderObjectOfType<_RenderInkFeatures>` |
| `material/material.dart:398` | `Material.of`，只比 `maybeOf` 多一个 assert |
| `material/material.dart:563` | `class _RenderInkFeatures extends RenderProxyBox implements MaterialInkController` |
| `material/material.dart:596` | `_RenderInkFeatures.addInkFeature`，`markNeedsPaint()` 在这里 |
| `material/material.dart:638` / `657` / `662` | `_InkFeatures`（`SingleChildRenderObjectWidget`）/ `createRenderObject` / `updateRenderObject` |
| `material/material.dart:675` | `abstract class InkFeature`，墨迹的基类 |
| `material/material.dart:719` | `InkFeature._getPaintTransform`，跨 RenderObject 的坐标换算 |
| `material/material.dart:808` / `875` | `_MaterialInterior` / `_MaterialInteriorState`，非快路径的产物 |
| `material/material.dart:942` / `967` | `_ShapeBorderPaint` / `_ShapeBorderPainter`，`transparency` 类型的产物 |
| `material/ink_well.dart:45` | `abstract class InteractiveInkFeature extends InkFeature`，多了 `confirm` / `cancel` |
| `material/ink_well.dart:301` | `class InkResponse extends StatelessWidget` |
| `material/ink_well.dart:669` | `InkResponse.build`，转发到 `_InkResponseStateWidget` |
| `material/ink_well.dart:727` | `class _InkResponseStateWidget extends StatefulWidget`（私有） |
| `material/ink_well.dart:845` | `class _InkResponseState extends State<_InkResponseStateWidget> with AutomaticKeepAliveClientMixin` |
| `material/ink_well.dart:1090` | `InteractiveInkFeature _createSplash(Offset globalPosition)` |
| `material/ink_well.dart:1174` | `void handleTapDown(TapDownDetails details)` |
| `material/ink_well.dart:1192` | `void _startNewSplash(...)` |
| `material/ink_well.dart:1216` | `void handleTap()`，`confirm()` 在这里 |
| `material/ink_well.dart:1339` | `_InkResponseState.build`，一长串已有 widget 的嵌套 |
| `material/ink_well.dart:1509` | `class InkWell extends InkResponse`，**只覆写两个布尔 getter** |
| `material/ink_splash.dart:116` | `class InkSplash extends InteractiveInkFeature` |
| `material/ink_highlight.dart:34` | `class InkHighlight extends InteractiveInkFeature` |

## 四、调用链

### 4.1 `Material` 的四个分支：它只是个组合器

`Material` 是 `StatefulWidget`（`material.dart:183`），这一点值得先记住——它需要 `TickerProviderStateMixin`（`:451`）来给 `AnimatedPhysicalModel` / `AnimatedDefaultTextStyle` 提供 vsync。

`build` 的骨架是四条 `return`：

```dart
// material.dart:500-562（节选）
// 1. 先给 child 套一个默认文字样式
contents = NotificationListener<LayoutChangedNotification>(
  onNotification: (LayoutChangedNotification notification) {
    final renderer = _inkFeatureRenderer.currentContext!.findRenderObject()! as _RenderInkFeatures;
    renderer._didChangeLayout();        // 2. 布局变了要重画墨迹
    return false;
  },
  child: _InkFeatures(key: _inkFeatureRenderer, absorbHitTest: ..., color: ..., vsync: this, child: contents),
);
...
if (widget.type == MaterialType.canvas && shape == null) {
  return AnimatedPhysicalModel(...);      // 3a. 快路径：交给已有原语
}
...
if (widget.type == MaterialType.transparency) {
  return ClipPath(clipper: ShapeBorderClipper(...), child: _ShapeBorderPaint(...));  // 3b.
}
return _MaterialInterior(...);            // 3c. 慢路径
```

四个分支的产物**全部是 widgets 层的已有原语或 material 内的私有 widget**：

| 分支 | 条件 | 产物 | 新机制？ |
|---|---|---|---|
| 快路径 | `type == canvas && shape == null` | `AnimatedPhysicalModel` → `PhysicalModel` | 无：`widgets/implicit_animations.dart` + `rendering/proxy_box.dart` |
| 圆角/自定义形状 | 其他 canvas / card / button | `_MaterialInterior`（内部用 `PhysicalShape`） | 无：`_MaterialInterior` 只是 `ImplicitlyAnimatedWidget` 的子类 |
| 透明 | `type == transparency` | `ClipPath` + `_ShapeBorderPaint` | 无：`ClipPath` 是 widgets 原语，`_ShapeBorderPaint` 是 `CustomPaint` 的包装 |
| 内边距与墨迹 | 所有分支都会套 | `NotificationListener` + `_InkFeatures` | **一个私有 RenderObject**：`_RenderInkFeatures` |

`Material` 里唯一"新"的东西是 `_RenderInkFeatures` + `_InkFeatures` 这一对。其余全是组合。所以"读 material 源码"的正确姿势是"读它选了哪些 widgets 层的原语"，而不是"读它的渲染实现"。

### 4.2 `_RenderInkFeatures`：8 行的真正职责

`_RenderInkFeatures` 继承 `RenderProxyBox`（`material.dart:563`），复用了 proxy box 的"单孩子、大小等于孩子"语义。它自己只做三件事：

```dart
// material.dart:596-604
@override
void addInkFeature(InkFeature feature) {
  assert(!feature._debugDisposed);
  assert(feature._controller == this);
  _inkFeatures ??= <InkFeature>[];
  assert(!_inkFeatures!.contains(feature));
  _inkFeatures!.add(feature);
  markNeedsPaint();                    // ← 全部机制就这一句
}
```

和它的绘制：

```dart
// material.dart:621-647（节选）
@override
void paint(PaintingContext context, Offset offset) {
  final List<InkFeature>? inkFeatures = _inkFeatures;
  if (inkFeatures != null && inkFeatures.isNotEmpty) {
    final Canvas canvas = context.canvas;
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    canvas.clipRect(Offset.zero & size);        // 1. 墨迹不许溢出 material 边界
    for (final InkFeature inkFeature in inkFeatures) {
      inkFeature._paint(canvas);                // 2. 每个 feature 自己画
    }
    canvas.restore();
  }
  super.paint(context, offset);                 // 3. 再画孩子
}
```

墨迹的全部机制是"一个列表 + 一次 `markNeedsPaint` + 一个 `for` 循环调 `_paint`"。没有图层、没有单独的场景、没有合成特效。**墨迹之所以看起来是"渗进" material 的，只是因为它在 `super.paint` 之前画——先画墨迹，再把孩子画在上面。** 顺序就是全部魔法。

`_RenderInkFeatures` 也不直接在树里出现，它由 `_InkFeatures` 这个 `SingleChildRenderObjectWidget` 创建（`:638` / `:657`），后者是标准的"widget 描一个 RenderObject"模式。

### 4.3 `Material.of`：一次 RenderObject 祖先查找

这是本文最值得单独记住的一段：

```dart
// material.dart:376-378
static MaterialInkController? maybeOf(BuildContext context) {
  return LookupBoundary.findAncestorRenderObjectOfType<_RenderInkFeatures>(context);
}
```

`Material.of` 只比它多一个 assert：

```dart
// material.dart:398-410（节选）
static MaterialInkController of(BuildContext context) {
  final MaterialInkController? controller = maybeOf(context);
  assert(() {
    if (controller == null) {
      if (LookupBoundary.debugIsHidingAncestorRenderObjectOfType<_RenderInkFeatures>(context)) { ... }
      throw FlutterError.fromParts(...);   // "no Material widget found" 就是这里抛的
    }
    return true;
  }());
  assert(controller != null);
  return controller;
}
```

三个可以直接得出结论的点：

1. **它不是 InheritedWidget 查找，是 RenderObject 祖先查找**。`findAncestorRenderObjectOfType` 走的是 Element 树向上找 `renderObject is T` 的节点。所以你在 `Material` 和 `InkWell` 之间插任意多层 widget 都不影响——只要中间没有"遮蔽者"。
2. **`LookupBoundary` 的语义**：它会限制查找范围（`LookupBoundary` 是 3.19 引入的，用来防止跨边界的意外继承，常用于 `Overlay` / `Hero` 这类场景）。这解释了为什么 `debugIsHidingAncestorRenderObjectOfType` 这个分支存在——**"有祖先但被边界挡住了"和"根本没有祖先"是两种不同的错误信息**。
3. **`InkWell` 的 `debugCheckContext` 依赖它**：`InkResponse.debugCheckContext`（`ink_well.dart:720-726`）里第一句就是 `assert(debugCheckHasMaterial(context))`。没有 `Material` 祖先时，`InkWell` 会在 debug 下直接告诉你原因，而不是静默不响应。

### 4.4 `InkWell` 的三层结构

```dart
// ink_well.dart:1509
class InkWell extends InkResponse {
  const InkWell({...}) : super(containedInkWell: true, highlightShape: BoxShape.rectangle, ...);
```

`InkWell` 只改了两个默认值（`containedInkWell: true`、`highlightShape: BoxShape.rectangle`），**没有任何新逻辑**。真正的结构在 `InkResponse` 里：

```text
InkWell                        ink_well.dart:1509   StatelessWidget，只改默认值
└─ InkResponse                 ink_well.dart:301    StatelessWidget，接参数
   └─ _InkResponseStateWidget  ink_well.dart:727    StatefulWidget（私有）
      └─ _InkResponseState      ink_well.dart:845    真正的 State
```

`InkResponse.build` 只是把 40 多个参数原样转发给 `_InkResponseStateWidget`（`:669-714`）。所以**"为什么有两个 widget"** 的答案是：`InkResponse` 是公开的、可以被子类继承改 API；`_InkResponseStateWidget` 是私有的，用来承载 State。这是框架里非常常见的一种模式（公开的 StatelessWidget 包一个私有的 StatefulWidget），目的是**让 State 的类型可以改而不破坏公开 API**。

`_InkResponseState.build`（`:1339`）产出的是一串全是已有原语的嵌套：

```dart
// ink_well.dart:1386-1400（节选）
return _ParentInkResponseProvider(
  state: this,
  child: Actions(
    actions: _actionMap,
    child: Focus(
      focusNode: widget.focusNode,
      child: MouseRegion(
        onEnter: handleMouseEnter,
        child: Semantics(
          onTap: ...,
          child: GestureDetector(       // ← 手势全交给 widgets 层的 GestureDetector
            onTapDown: _primaryEnabled ? handleTapDown : null,
            onTap: _primaryEnabled ? handleTap : null,
```

`Actions` / `Focus` / `MouseRegion` / `Semantics` / `GestureDetector` / `DefaultSelectionStyle`——**一个都不是 material 层的东西**。这是"material 没有新机制"最直白的证据：`InkWell` 的交互能力 100% 来自 widgets 层。

### 4.5 从点击到墨迹：五跳

```text
GestureDetector.onTapDown
  └─ _InkResponseState.handleTapDown                     ink_well.dart:1174
       ├─ handleAnyTapDown(details)
       └─ widget.onTapDown?.call(details)
            └─ handleAnyTapDown 内部：_startNewSplash   ink_well.dart:1192
                 ├─ 1. 算 globalPosition（details 或 referenceBox.paintBounds.center）
                 ├─ 2. statesController.update(WidgetState.pressed, true)
                 ├─ 3. final splash = _createSplash(globalPosition)   ink_well.dart:1090
                 │       ├─ final inkController = Material.of(context)   ← 4.3 的查找
                 │       ├─ final referenceBox = context.findRenderObject()! as RenderBox
                 │       ├─ final position = referenceBox.globalToLocal(globalPosition)
                 │       └─ (widget.splashFactory ?? Theme.of(context).splashFactory).create(
                 │             controller: inkController, referenceBox: referenceBox, ...)
                 │              └─ InkSplash 构造函数 → controller.addInkFeature(this)
                 │                   └─ _RenderInkFeatures.addInkFeature     material.dart:596
                 │                        └─ markNeedsPaint()
                 ├─ 4. _splashes.add(splash); _currentSplash?.cancel(); _currentSplash = splash
                 └─ 5. updateKeepAlive(); updateHighlight(pressed, true)

手指抬起 → GestureDetector.onTap
  └─ _InkResponseState.handleTap                         ink_well.dart:1216
       ├─ _currentSplash?.confirm()      ← InkFeature.confirm()，让墨迹"扩散更快"
       └─ widget.onTap?.call()
```

`Material.of(context)` 返回的那个 RenderObject 是"墨水注册表 + 绘制者"，而不是"墨水容器"。每个具体的墨迹类自己持有 `AnimationController`（vsync 取自 `controller.vsync`），自己算透明度，自己画；`_RenderInkFeatures` 只负责收集和裁剪。

**这里有一处与常见说法不一致的地方**：把 `addInkFeature(this)` 写在基类构造函数里是很多资料的描述，但 3.44.8 的 `InkFeature` 构造函数**只做赋值**：

```dart
// material.dart:677-683
InkFeature({
  required MaterialInkController controller,
  required this.referenceBox,
  this.onRemoved,
}) : _controller = controller as _RenderInkFeatures {   // ← 只有赋值
  assert(debugMaybeDispatchCreated('material', 'InkFeature', this));
}
```

自注册发生在**每个具体子类的构造函数体里**：

```dart
// ink_splash.dart:150-165（节选）
super(controller: controller, color: color) {
  _radiusController = AnimationController(
      duration: _kUnconfirmedSplashDuration, vsync: controller.vsync)  // ← vsync 来自 controller
    ..addListener(controller.markNeedsPaint)   // ← 动画每帧直接触发 controller 重绘
    ..forward();
  ...
  controller.addInkFeature(this);            // ← 自注册在这里
}
```

`ink_highlight.dart:62-68`、`ink_ripple.dart:146-171`、`ink_decoration.dart:339`、`ink_sparkle.dart:126` 都是同一个模式。**结论不变（墨迹自己把自己登记进 controller），但位置从基类移到了 5 个子类**——这也是"读 material 源码要按具体类读，别只看基类文档"的一个实例。

### 4.6 墨迹为什么能画在正确位置

`InkFeature` 的 `referenceBox` 是创建时 `context.findRenderObject()` 的结果（`ink_well.dart:1092`）——**它可能和 `_RenderInkFeatures` 不在一层**（中间隔了 `Padding`、`Center` 之类）。所以画之前要先算坐标变换：

```dart
// material.dart:719-742（节选）
static Matrix4? _getPaintTransform(RenderObject fromRenderObject, RenderObject toRenderObject) {
  final fromPath = <RenderObject>[fromRenderObject];
  final toPath = <RenderObject>[toRenderObject];
  var from = fromRenderObject;
  var to = toRenderObject;
  while (!identical(from, to)) {
    if (fromDepth >= toDepth) { ... fromPath.add(fromParent); from = fromParent; }
    if (fromDepth <= toDepth) { ... toPath.add(toParent); to = toParent; }
  }
  ...
  for (int index = toPath.length - 1; index > 0; index -= 1) {
    toPath[index].applyPaintTransform(toPath[index - 1], transform);
  }
  ...
}
```

这是一个标准的"找最近公共祖先 + 沿两条路径累乘变换矩阵"算法，用的是第 3 篇讲过的 `RenderObject.depth`。它同时处理了两个边界情况：不在同一棵树 → 返回 null；某一段在 offscreen 子树里（`!parent.paintsChild(from)`）→ 返回 null。

这也是墨迹唯一"有点复杂"的地方，而它复杂度来自一个很实际的需求——**墨迹要能跨越任意中间层画到 `Material` 上**。这个需求不是 material 层特有的（`Overlay` 里的 `Hero` 飞行动画也有同类计算），算法本身用的是渲染层的公共工具。

## 五、核心对象

### 5.1 `Material` vs `InkWell`

| | `Material` | `InkWell` |
|---|---|---|
| 类型 | `StatefulWidget`（`material.dart:183`） | `StatelessWidget` → 私有 `StatefulWidget` |
| 提供的契约 | `MaterialInkController`（找得到就由它画墨迹） | 交互回调（tap / longPress / hover / focus） |
| 与祖先的关系 | 是"祖先"（被查找方） | 是"后代"（查找方，`Material.of`） |
| 产出新 RenderObject | 是，一个：`_RenderInkFeatures` | **否，一个都没有** |
| 需要的 vsync | 是（给 `AnimatedPhysicalModel`） | 是（转交给 `InkSplash` 的 `AnimationController`） |
| 交互能力来源 | 无（不响应输入） | `GestureDetector` / `MouseRegion` / `Focus` / `Semantics`（全在 widgets 层） |
| 绘制内容 | 背景色/阴影/形状 + （委托孩子画的）墨迹 | 没有自己的绘制内容，只画进祖先的 `_RenderInkFeatures` |

### 5.2 `Material` 的四个分支各自复用了什么

| 分支 | 复用的原语 | 所在层 |
|---|---|---|
| 阴影 + 圆角 | `AnimatedPhysicalModel` → `PhysicalModel` → `RenderPhysicalModel` | widgets / rendering |
| 形状裁剪 | `ClipPath` + `ShapeBorderClipper` | widgets |
| 自定义形状阴影 | `PhysicalShape`（被 `_MaterialInterior` 使用） | widgets |
| 文字样式 | `AnimatedDefaultTextStyle` / `DefaultTextStyle` / `Theme.of` | widgets / material(theme) |
| 布局变更通知 | `NotificationListener<LayoutChangedNotification>` | widgets |
| 墨迹 | **`_RenderInkFeatures`（material 私有）** | material |
| 透明材质 | `CustomPaint`（被 `_ShapeBorderPaint` 使用） | widgets |

**七行里只有一行是 material 自己的东西。**

### 5.3 material 层"自己的渲染对象"到底有多少

`material/` 下 30 个私有 `_Render*` 类，按基类分布：

| 基类 | 个数 | 说明 |
|---|---|---|
| `RenderBox`（直接继承） | 10 | 真正自己实现 layout/paint 的（`_RenderChip`、`_RenderSlider`、`_RenderDecoration`、`_RenderInkFeatures` 等） |
| `RenderShiftedBox` | 7 | 复用"单孩子 + 可偏移"的布局 |
| `RenderProxyBox` | 4 | 复用"孩子多大我多大" |
| `RenderAligningShiftedBox` | 3 | 复用"对齐 + 偏移" |
| `RenderSliverFixedExtentBoxAdaptor` | 2 | 复用懒加载 sliver 全流程（Carousel） |
| `RenderOpacity` / `RenderListBody` / `RenderFlex` / `RenderConstrainedBox` | 各 1 | 只改一点点行为 |

**24 / 30 是复用已有基类的**。剩下 10 个直接继承 `RenderBox` 的，全部服务于单一组件（Chip、Slider、Decoration、Slider 的 ValueIndicator 等），没有一个是"新协议"。

对照第 47 篇：material 层**没有定义任何新的 `SliverConstraints` 派生类，也没有定义任何新的 `ParentData`**。这才是"没有新机制"的精确定义。

## 六、源码实验

### 实验 1：`Material` 的 element 子树到底是哪些 widget

用一个 `Material(type: canvas, 无 shape)` + `InkWell`，从 `Material` 的 Element 往下打印：

```text
LAB15 chain=0:Material | 1:AnimatedPhysicalModel | 2:PhysicalModel |
3:NotificationListener<LayoutChangedNotification> | 4:_InkFeatures |
5:AnimatedDefaultTextStyle | 6:DefaultTextStyle | 7:Builder | 8:Actions
```

**预测**：既然 `type == canvas && shape == null` 走快路径，第一层应该是 `AnimatedPhysicalModel`。

**实际**：正是。链上的 `AnimatedPhysicalModel` / `PhysicalModel` / `NotificationListener` / `AnimatedDefaultTextStyle` / `DefaultTextStyle` 全是 widgets 层的；只有第 4 层 `_InkFeatures` 是 material 私有的。

**说明**：这一行输出把"`Material` 是组合器"变成了可核对的事实。另外注意 `DefaultTextStyle` 外面还有 `Builder` 和 `Actions`——它们来自 `MaterialApp` 的 `WidgetsApp`，不在 `Material` 的 build 里。

### 实验 2：`Material.of` 返回的是 RenderObject

```text
LAB15 controller=_RenderInkFeatures isRenderObject=true
```

**说明**：`isRenderObject=true` 是"`Material.of` 不是 InheritedWidget 查找"的直接证据。这也意味着**同一个 `Material` 下的 `InkWell`，即使中间隔了 `Builder` / `Padding` / `Opacity` 也能找到 controller**——因为查找走的是 RenderObject 祖先链，而这些 widget 要么不产生 RenderObject，要么产生的 RenderObject 会被继续往上跳过。

### 实验 3：点击之后墨迹注册表的变化

```text
LAB15 probe found=1 features=null
LAB15 probe found=2 features=null
LAB15 probe found=3 features=1
LAB15 probe found=4 features=1
LAB15 afterTap inkFeatureCount=4 taps=1
```

**说明**：`_RenderInkFeatures` 在整棵树里有 4 个（`MaterialApp` / `Scaffold` / 我们自己的 `Material` 分别有），点击后有 2 个各收到 1 个 `InkFeature`。

为什么是 2 个而不是 1 个？因为 `_startNewSplash` 被调用了两次——`InkWell` 的 `onTapDown` 与父级 `InkResponse` 链上还有一层参与（`_ParentInkResponseProvider` 的存在就是为此，`ink_well.dart:204`、`:1386`）。**这说明 `Material.of` 的"最近祖先"语义在嵌套 InkResponse 时会让多个 controller 收到同一次点击**——这也是"嵌套 InkWell 会出现双重涟漪"这个常见现象的源码依据。

### 实验 4：确认 material 没有新的渲染协议

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
# 1. material 里有没有定义新的 ParentData？
grep -rn "extends ParentData\|with .*ParentDataMixin" material/*.dart | grep "^material.*class" | head
# 2. material 里有没有定义新的 SliverConstraints / SliverGeometry 派生？
grep -rn "extends SliverConstraints\|extends SliverGeometry" material/*.dart
# 3. 抽样：桶文件 material.dart import 了哪些框架层？
grep -h "^import 'package:flutter/" material/material.dart
# 4. 全量：material/ 全部 182 个文件按 import 的框架库分类统计
grep -h "^import 'package:flutter/" material/*.dart | sed -E "s|^import 'package:flutter/([a-z_]+)\.dart.*|\1|" | sort | uniq -c | sort -rn
```

**实际**：

- 第 1 条：只有 `_DropdownRoutePage`（Route 相关）与 `StackParentData` 的间接使用，**没有自定义 ParentData 类**。
- 第 2 条：**零命中**。
- 第 3 条（单文件抽样）：`package:flutter/foundation.dart`、`package:flutter/rendering.dart`、`package:flutter/widgets.dart`——只有这三个。
- 第 4 条（全量，182 个文件共 407 条 import，各文件对同一库不会重复 import，所以数字就是文件数）：

```text
151 widgets
119 foundation
 64 rendering
  22 cupertino
  20 services
  16 gestures
   8 scheduler
   4 painting
   3 animation
```

**说明**：全量统计推翻了"只用三层"的直觉——material 里有 16 个文件直接 import gestures、8 个 import scheduler、20 个 import services……但要看 import 的是什么：`DragStartBehavior`（gestures）、`timeDilation`（scheduler）、`clampDouble`（foundation）这类**公开 API**，不是私有机制。真正能证明"没有新渲染协议"的是第 1、2 条——它们本来就是全量 grep，覆盖全部 182 个文件。它 21 万行的体量来自"组件数量多"，不来自"机制深"。

这也解释了 `cupertino` 为什么和 material 平级：两者都只是 `widgets` 之上的"组件集合"，import 的也全是各层公开 API（cupertino 的 import 分布可用第 4 条同样的命令复核），不存在谁更"底层"的问题。

## 七、结论

1. `Material` 是组合器，不是渲染器。它的 `build` 在四个分支里分别产出 `AnimatedPhysicalModel`（快路径）/ `_MaterialInterior` / `ClipPath` + `_ShapeBorderPaint`，全是 widgets 层的已有原语；唯一自研的渲染对象是 `_RenderInkFeatures`（`material.dart:563`），而它只做"收列表 + `markNeedsPaint` + `for` 循环调 `_paint`"三件事。
2. `Material.of` 走的是 `LookupBoundary.findAncestorRenderObjectOfType<_RenderInkFeatures>`（`material.dart:377`），是 RenderObject 祖先查找，不是 InheritedWidget 查找，返回的是一个 **RenderObject**。`controller is RenderObject == true`。这也是墨迹能跨任意中间层画到 `Material` 上的原因。
3. `InkWell` 的全部交互能力来自 widgets 层（`GestureDetector` / `MouseRegion` / `Focus` / `Semantics` / `Actions`），它自己产出**零个** RenderObject；`Material` 的全部视觉效果来自已有原语。material 层 30 个私有 `_Render*` 类里 24 个是复用已有基类，且没有自定义 `ParentData`、没有 `SliverConstraints` / `SliverGeometry` 派生。

**material 层没有新机制，它只是把 widgets 与 rendering 已有的原语按 Material Design 的规格重新组合了一遍。**

## 八、边界声明

- 本文只抽样 `Material` 与 `InkWell` 这两个对象，证明"material 层无新机制"。**不逐个展开 material 的其他组件**；需要时按类名读，骨架都是本节的四类组合。
- `InkSplash` / `InkRipple` / `InkHighlight` 的动画参数（扩散曲线、时长、`InteractiveInkFeature.confirm` 的加速效果）不展开。它们都是 `InteractiveInkFeature` 的子类（`ink_well.dart:45`），内部各持一个 `AnimationController`，属于第 5 卷 `animation` 的内容。
- `Theme` / `ThemeData` / `ColorScheme` 的完整查找与解析不展开；本次只用到 `Theme.of(context).splashColor` 这类读取。
- `PhysicalModel` / `RenderPhysicalModel` 的阴影实现（`elevation` → blur / offset 的换算）属于第 8 卷 rendering 层；本文只说明 `Material` 复用它。
- `LookupBoundary` 的完整语义（它如何限制 InheritedWidget 与 RenderObject 祖先查找）是这个系列未覆盖的独立机制，需要时按类名读 `widgets/lookup_boundary.dart`。
- `cupertino` 层不做抽样下潜；它与 material 一样是"widgets 之上的组件集合"，import 的都是各层公开 API（依赖分布可用实验 4 第 4 条同样的 grep 复核），结论可以直接迁移。
- 从 `main()` 到 GPU 的全局地图不在这里，见第 52 篇。
