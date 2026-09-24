# Flutter RenderObject 深度解析：源码机制、布局协议与自定义 RenderObject 实战

> 面向 Flutter 程序员的系统化长文：从 Flutter 渲染体系、源码调用链、布局协议、绘制流程、命中测试、自定义 `RenderObject`、性能优化与工程实践等角度，完整理解 Flutter UI 最底层的核心机制，而不只是介绍 `RenderObject` 是什么。

---

## 目录

1. [为什么必须理解 RenderObject](#1-为什么必须理解-renderobject)
2. [Flutter 三棵树：Widget / Element / RenderObject](#2-flutter-三棵树widget--element--renderobject)
3. [RenderObject 的基本概念](#3-renderobject-的基本概念)
4. [RenderObject 在 Flutter 渲染管线中的位置](#4-renderobject-在-flutter-渲染管线中的位置)
5. [从 setState 到 RenderObject 更新的完整链路](#5-从-setstate-到-renderobject-更新的完整链路)
6. [RenderObject 的核心职责](#6-renderobject-的核心职责)
7. [RenderObject、RenderBox、RenderSliver 的区别](#7-renderobjectrenderboxrendersliver-的区别)
8. [Box 布局协议：Constraints go down, Sizes go up](#8-box-布局协议constraints-go-down-sizes-go-up)
9. [RenderBox 布局源码机制](#9-renderbox-布局源码机制)
10. [performLayout 与 computeDryLayout](#10-performlayout-与-computedrylayout)
11. [父子 RenderObject 如何通信](#11-父子-renderobject-如何通信)
12. [ParentData 的作用与源码理解](#12-parentdata-的作用与源码理解)
13. [绘制流程：paint、PaintingContext 与 Layer](#13-绘制流程paintpaintingcontext-与-layer)
14. [合成层：什么时候会产生 Layer](#14-合成层什么时候会产生-layer)
15. [命中测试：hitTest 与事件分发](#15-命中测试hittest-与事件分发)
16. [语义系统：Semantics 与无障碍](#16-语义系统semantics-与无障碍)
17. [RenderObject 生命周期](#17-renderobject-生命周期)
18. [markNeedsLayout / markNeedsPaint / markNeedsCompositingBitsUpdate](#18-markneedslayout--markneedspaint--markneedscompositingbitsupdate)
19. [自定义 RenderObject 的三种入口](#19-自定义-renderobject-的三种入口)
20. [示例一：自定义单子节点 RenderBox](#20-示例一自定义单子节点-renderbox)
21. [示例二：自定义多子节点 RenderBox](#21-示例二自定义多子节点-renderbox)
22. [示例三：自定义绘制型 RenderBox](#22-示例三自定义绘制型-renderbox)
23. [示例四：自定义布局型 RenderBox](#23-示例四自定义布局型-renderbox)
24. [示例五：自定义命中测试区域](#24-示例五自定义命中测试区域)
25. [自定义 RenderObject 的常见 bug](#25-自定义-renderobject-的常见-bug)
26. [RenderObject 与 CustomPainter 的区别](#26-renderobject-与-custompainter-的区别)
27. [RenderObject 与 Flow / Stack / LayoutBuilder 的区别](#27-renderobject-与-flow--stack--layoutbuilder-的区别)
28. [RenderObject 性能优化实践](#28-renderobject-性能优化实践)
29. [Flutter 源码阅读路线](#29-flutter-源码阅读路线)
30. [开源项目与源码参考](#30-开源项目与源码参考)
31. [相关概念清单](#31-相关概念清单)
32. [总结](#32-总结)

---

# 1. 为什么必须理解 RenderObject

在日常 Flutter 开发中，大多数时候我们只接触 `Widget`：

```dart
Container(
  width: 100,
  height: 100,
  color: Colors.red,
)
```

看起来 Flutter UI 是由 Widget 构成的，但严格来说：

> Widget 只是配置描述，真正参与布局、绘制、命中测试、语义构建的是 RenderObject。

也就是说，Flutter 屏幕上真正“有尺寸、有位置、能绘制、能响应事件”的对象是 `RenderObject`，而不是 `Widget`。

理解 RenderObject 能解决以下问题：

1. 为什么 `Container` 只是语法糖？
2. 为什么父组件 `setState` 后，子组件可能只是更新 Widget，而不是销毁 State？
3. 为什么有些布局报错是 `RenderBox was not laid out`？
4. 为什么 `Expanded` 只能放在 `Flex` 里面？
5. 为什么 `ListView`、`CustomScrollView` 使用的是 Sliver 布局体系？
6. 为什么有些动画很流畅，有些动画会触发大量 layout？
7. 为什么 `CustomPainter` 适合绘制，但不适合复杂布局？
8. 如何写一个真正高性能、自定义布局、自定义绘制、自定义命中测试的组件？

如果只停留在 Widget 层，很多 Flutter 的问题只能靠经验猜测；一旦理解 RenderObject，很多问题就能从渲染管线和源码机制上得到解释。

---

# 2. Flutter 三棵树：Widget / Element / RenderObject

Flutter 运行时最重要的是三棵树：

```text
Widget Tree       配置树，不可变，描述 UI 应该是什么样
Element Tree      实例树，可变，连接 Widget 和 RenderObject
RenderObject Tree 渲染树，可变，负责布局、绘制、命中测试
```

## 2.1 Widget Tree

Widget 是不可变配置对象：

```dart
class Text extends StatelessWidget {
  final String data;

  const Text(this.data, {super.key});
}
```

Widget 本身不负责真正绘制文字。

它只是描述：

```text
这里应该有一个 Text，内容是 xxx，样式是 yyy。
```

## 2.2 Element Tree

Element 是 Widget 的运行时实例。

它负责：

1. 持有当前 Widget；
2. 维护父子关系；
3. 管理生命周期；
4. 负责 Widget diff；
5. 决定复用还是销毁；
6. 把 Widget 配置同步给 RenderObject。

典型关系：

```text
Widget  createElement()  Element
Element mount/update/rebuild
Element 持有 Widget
Element 可持有 RenderObject
```

## 2.3 RenderObject Tree

RenderObject 是渲染树节点。

它负责：

1. layout：计算尺寸和位置；
2. paint：绘制内容；
3. compositing：合成层；
4. hitTest：命中测试；
5. semantics：无障碍语义；
6. coordinate transform：坐标转换；
7. dirty 标记和刷新调度。

不是每一个 Widget 都对应一个 RenderObject。

例如：

```dart
StatelessWidget
StatefulWidget
InheritedWidget
Builder
Theme
MediaQuery
```

这些通常不直接创建 RenderObject。

真正创建 RenderObject 的 Widget 通常是：

```dart
RenderObjectWidget
├── LeafRenderObjectWidget
├── SingleChildRenderObjectWidget
└── MultiChildRenderObjectWidget
```

---

# 3. RenderObject 的基本概念

`RenderObject` 是 Flutter 渲染体系中的抽象基类。

简化理解：

```dart
abstract class RenderObject extends AbstractNode with DiagnosticableTreeMixin {
  void layout(Constraints constraints, {bool parentUsesSize = false});
  void paint(PaintingContext context, Offset offset);
  bool hitTest(...);
  void markNeedsLayout();
  void markNeedsPaint();
}
```

真实源码更复杂，但核心职责就是这些。

RenderObject 本身并不限定使用哪种布局协议。

Flutter 中最常见的两大 RenderObject 分支是：

```text
RenderObject
├── RenderBox       二维盒模型布局，常规 Widget 使用
└── RenderSliver    滚动视口中的 Sliver 布局，ListView / CustomScrollView 使用
```

## 3.1 RenderObject 不是 Widget

Widget 是描述：

```text
我要一个宽 100、高 100 的红色盒子。
```

RenderObject 是执行者：

```text
我收到父节点约束后，计算出自己的 size，然后在画布上画一个红色矩形。
```

## 3.2 RenderObject 不是 Element

Element 负责管理树和生命周期。

RenderObject 负责渲染。

Element 是 Widget 与 RenderObject 的桥梁。

```text
Widget 更新
  ↓
Element 判断是否复用
  ↓
Element.updateRenderObject
  ↓
RenderObject 更新字段
  ↓
必要时 markNeedsLayout / markNeedsPaint
```

---

# 4. RenderObject 在 Flutter 渲染管线中的位置

Flutter 一帧大致经历以下阶段：

```text
输入事件 / setState / animation tick
        ↓
build 阶段
        ↓
layout 阶段
        ↓
paint 阶段
        ↓
compositing bits 阶段
        ↓
semantics 阶段
        ↓
composite frame
        ↓
GPU rasterization
```

RenderObject 主要参与：

```text
layout
paint
compositing
hitTest
semantics
```

Widget 主要参与：

```text
build
configuration diff
```

Element 主要参与：

```text
mount
update
rebuild
lifecycle
RenderObject 绑定
```

RenderObject 的 dirty 机制是 Flutter 高性能渲染的重要基础。

当某个 RenderObject 的尺寸需要重新计算时，不需要整棵树全部 layout，而是标记对应节点：

```dart
markNeedsLayout();
```

当某个 RenderObject 的绘制内容变了，但尺寸没变，只需要：

```dart
markNeedsPaint();
```

这两个方法是自定义 RenderObject 时最重要的性能边界。

---

# 5. 从 setState 到 RenderObject 更新的完整链路

假设有如下代码：

```dart
class DemoPage extends StatefulWidget {
  const DemoPage({super.key});

  @override
  State<DemoPage> createState() => _DemoPageState();
}

class _DemoPageState extends State<DemoPage> {
  double width = 100;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: width,
        height: 100,
        color: Colors.blue,
      ),
    );
  }
}
```

当调用：

```dart
setState(() {
  width = 200;
});
```

大致链路如下：

```text
setState
  ↓
StatefulElement.markNeedsBuild
  ↓
BuildOwner.scheduleBuildFor
  ↓
下一帧 buildScope
  ↓
调用 State.build
  ↓
产生新的 Widget Tree
  ↓
Element.updateChild 做 diff
  ↓
复用可复用的 Element / RenderObject
  ↓
RenderObjectElement.updateRenderObject
  ↓
RenderConstrainedBox / RenderDecoratedBox 等更新属性
  ↓
如果尺寸约束相关属性变了：markNeedsLayout
  ↓
如果颜色等绘制属性变了：markNeedsPaint
  ↓
PipelineOwner.flushLayout / flushPaint
  ↓
屏幕更新
```

注意：

> setState 不等于立即 layout，也不等于立即 paint。它只是把 Element 标记为需要 rebuild。

真正的 layout / paint 会在后续 pipeline flush 阶段统一执行。

---

# 6. RenderObject 的核心职责

RenderObject 的职责可以分为五类。

## 6.1 布局 layout

布局阶段决定：

1. 自己多大；
2. 子节点多大；
3. 子节点放在哪里。

在 RenderBox 中，布局结果是：

```dart
Size size;
```

父节点通过 constraints 限制子节点。

子节点通过 size 告诉父节点自己最终大小。

## 6.2 绘制 paint

绘制阶段决定：

1. 画什么；
2. 画在哪里；
3. 是否使用 layer；
4. 是否裁剪、变换、透明、缓存。

典型方法：

```dart
@override
void paint(PaintingContext context, Offset offset) {
  final Canvas canvas = context.canvas;
  canvas.drawRect(offset & size, paint);
}
```

## 6.3 命中测试 hitTest

命中测试决定指针事件是否落在当前节点或子节点上。

典型方法：

```dart
@override
bool hitTestSelf(Offset position) => true;
```

如果返回 true，当前 RenderObject 可以成为事件命中目标。

## 6.4 合成 compositing

有些渲染效果需要独立 layer：

1. opacity；
2. transform；
3. clip；
4. backdrop filter；
5. platform view；
6. repaint boundary。

RenderObject 会参与合成位计算。

## 6.5 语义 semantics

语义阶段用于无障碍能力，例如：

1. 屏幕阅读器；
2. 可点击区域描述；
3. 文本语义；
4. 按钮角色；
5. slider 取值。

自定义 RenderObject 如果需要无障碍支持，应实现语义相关方法。

---

# 7. RenderObject、RenderBox、RenderSliver 的区别

## 7.1 RenderObject

`RenderObject` 是抽象基类，不规定具体布局协议。

它只定义渲染节点的通用能力。

## 7.2 RenderBox

`RenderBox` 是 Flutter 最常用的二维盒模型。

它使用：

```dart
BoxConstraints
Size
Offset
```

布局协议为：

```text
父节点向子节点传递 BoxConstraints
子节点在约束内选择一个 Size
父节点决定子节点 Offset
```

常见 RenderBox：

```text
RenderPadding
RenderConstrainedBox
RenderFlex
RenderStack
RenderPositionedBox
RenderDecoratedBox
RenderParagraph
RenderImage
```

绝大多数普通 Widget 最终都是 RenderBox。

## 7.3 RenderSliver

`RenderSliver` 用于滚动视口。

它不使用普通的 `Size` 作为主要布局结果，而是使用：

```dart
SliverConstraints
SliverGeometry
```

它关心：

1. 滚动方向；
2. 当前滚动偏移；
3. 可见区域；
4. 缓存区域；
5. 最大滚动范围；
6. 当前 paint extent。

常见 RenderSliver：

```text
RenderSliverList
RenderSliverGrid
RenderSliverToBoxAdapter
RenderSliverPadding
RenderSliverAppBar 相关实现
```

`ListView` 底层走的是 Sliver 体系，并非简单的 Column。

想系统了解如何编写 RenderObject / RenderBox 子类，官方类文档中的 "Writing a subclass" 章节是最权威的指南：[RenderObject](https://api.flutter.dev/flutter/rendering/RenderObject-class.html)、[RenderBox](https://api.flutter.dev/flutter/rendering/RenderBox-class.html)。

---

# 8. Box 布局协议：Constraints go down, Sizes go up

Flutter Box 布局最经典的一句话：

```text
Constraints go down. Sizes go up. Parent sets position.
```

翻译为：

```text
约束向下传递。
尺寸向上传递。
父节点决定子节点位置。
```

官方教程 [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) 用大量交互示例讲解了这套约束体系，是理解布局报错的必读材料。

## 8.1 BoxConstraints

`BoxConstraints` 包含四个值：

```dart
class BoxConstraints extends Constraints {
  final double minWidth;
  final double maxWidth;
  final double minHeight;
  final double maxHeight;
}
```

它表达的是一个范围：

```text
minWidth  <= width  <= maxWidth
minHeight <= height <= maxHeight
```

## 8.2 常见约束类型

### tight constraint

紧约束：最小值等于最大值。

```dart
BoxConstraints.tight(Size(100, 100))
```

含义：

```text
你必须是 100 x 100。
```

### loose constraint

松约束：最小值为 0，最大值有限。

```dart
BoxConstraints.loose(Size(300, 300))
```

含义：

```text
你最大不能超过 300 x 300，但可以更小。
```

### unbounded constraint

无界约束：最大值为 infinity。

```text
maxHeight = double.infinity
```

常见于滚动方向。

例如：

```dart
SingleChildScrollView(
  child: Column(...),
)
```

垂直滚动时，子节点在垂直方向可能获得无限高度约束。

## 8.3 为什么会出现 RenderBox was not laid out

典型错误：

```text
RenderBox was not laid out
```

本质通常是：

```text
某个 RenderBox 在 layout 阶段没有设置 size。
```

自定义 RenderBox 中，如果 `performLayout` 没有写：

```dart
size = ...;
```

就会报错。

另外，如果父子约束协议不成立，也可能导致子节点没有合法 layout。

---

# 9. RenderBox 布局源码机制

RenderBox 的布局入口通常是：

```dart
child.layout(constraints, parentUsesSize: true);
```

`layout` 方法的大致逻辑可以抽象为（对照 3.41 源码 `rendering/object.dart`）：

```dart
void layout(Constraints constraints, {bool parentUsesSize = false}) {
  // 1. 先更新 relayout boundary 判定（详见 9.3 节）
  _isRelayoutBoundary =
      !parentUsesSize || sizedByParent || constraints.isTight || parent == null;

  // 2. 不脏且约束没变，直接早退：同一帧内不会重复布局
  if (!_needsLayout && constraints == _constraints) {
    return;
  }
  _constraints = constraints;

  // 3. sizedByParent 为 true 时，先只根据约束确定尺寸
  if (sizedByParent) {
    performResize();
  }

  // 4. 真正布局：layout 子节点、设置 size / child offset
  performLayout();

  _needsLayout = false;

  // 5. 布局结果变了，必然连带重绘
  markNeedsPaint();
}
```

真实源码更复杂（异常捕获、timeline、debug 断言等），但主流程是：

```text
先更新 relayout boundary 判定
constraints 没变且 _needsLayout 为 false 则早退
sizedByParent 时先 performResize 再 performLayout
结束后清除 _needsLayout 并 markNeedsPaint
```

注意第 2 步：`_needsLayout` 去重加上“constraints 相同就早退”，保证了同一个 child 在一帧内即使被 layout 多次也只真正计算一次；而 constraints 变了就必然重新布局。

## 9.1 sizedByParent

`sizedByParent` 表示：

```text
当前 RenderObject 的 size 是否只由父节点给的 constraints 决定。
```

如果为 true，必须遵守一条约定：尺寸只能在 `performResize` 里确定，`performLayout` 不得再修改尺寸。

在 3.41 中，`RenderBox.performResize` 的默认实现就是调用 dry layout：

```dart
@override
void performResize() {
  // default behavior for subclasses that have sizedByParent = true
  size = computeDryLayout(constraints);
  assert(size.isFinite);
}
```

所以现在的惯用写法是只覆写 `computeDryLayout`，连 `performResize` 都不必覆写：

```dart
@override
bool get sizedByParent => true;

@override
Size computeDryLayout(BoxConstraints constraints) {
  return constraints.biggest;
}
```

适合：

1. 固定填满父约束；
2. 不需要根据子节点尺寸决定自己尺寸；
3. 尺寸计算非常简单。

## 9.2 performLayout

大多数自定义 RenderBox 都会重写：

```dart
@override
void performLayout() {
  // 1. layout child
  // 2. set own size
  // 3. set child offset
}
```

例如：

```dart
@override
void performLayout() {
  if (child == null) {
    size = constraints.smallest;
    return;
  }

  child!.layout(constraints.loosen(), parentUsesSize: true);
  size = constraints.constrain(child!.size);
}
```

必须注意：

> 只要 `parentUsesSize: true`，父节点就表示自己的布局依赖子节点 size。

这会直接影响 relayout boundary 判定和后续 dirty layout 传播（见 9.3）。

## 9.3 relayoutBoundary：布局脏标记的隔离边界

`layout` 伪代码第 1 步的那行判定，是 Flutter 布局性能的核心机制之一。对照 3.41 源码：

```dart
_isRelayoutBoundary =
    !parentUsesSize || sizedByParent || constraints.isTight || parent == null;
```

只要满足四个条件之一，当前节点就是自己的 relayout boundary（重布局边界）：

1. 父节点布局不依赖自己的 size（`parentUsesSize` 为 false）；
2. 自己的尺寸只由约束决定（`sizedByParent` 为 true）；
3. 约束是紧约束（`constraints.isTight`），自己根本没有尺寸可选；
4. 自己是根节点（`parent == null`）。

relayout boundary 的意义在 `markNeedsLayout` 的传播路径上（3.41 源码，省略了 assert 与 debug 日志）：

```dart
void markNeedsLayout() {
  if (_needsLayout) {
    return;
  }
  _needsLayout = true;
  if (owner case final PipelineOwner owner? when (_isRelayoutBoundary ?? false)) {
    // 自己就是边界：加入待布局列表，请求新帧
    owner._nodesNeedingLayout.add(this);
    owner.requestVisualUpdate();
  } else if (parent != null) {
    // 不是边界：逐级向上标记父节点
    markParentNeedsLayout();
  }
}
```

整理成流程：

```text
markNeedsLayout()
  ↓
自己是 relayout boundary？
  ├─ 是：把自己加入 PipelineOwner 的待布局列表，请求新帧
  └─ 否：markParentNeedsLayout() → 父节点 markNeedsLayout()
        → 一路向上，直到某个祖先 boundary 为止
```

也就是说：某个节点尺寸变化时，脏标记会向上传播；但传播到最近的 relayout boundary 就会停止，boundary 之外的祖先不会被牵连重排。这就是“子节点脏了不会导致整棵树重排”的机制保证。

这里也把 `parentUsesSize` 的语义闭环了：父节点调用 `child.layout` 时传 `parentUsesSize: false`，等于声明“子节点尺寸变化与我无关”，因此子节点自己就是 boundary；反之，子节点的脏必须先弄脏父节点。这正是前文“读了 child.size 却没传 parentUsesSize”这类 bug 的根源——协议被破坏后，子节点尺寸变了却没人负责重新布局父节点。

---

# 10. performLayout 与 computeDryLayout

## 10.1 performLayout

`performLayout` 是真实布局，会改变 RenderObject 状态。

它可以：

1. 调用 child.layout；
2. 设置 size；
3. 设置 child parentData.offset；
4. 更新布局缓存。

示例：

```dart
@override
void performLayout() {
  child?.layout(constraints, parentUsesSize: true);
  size = child?.size ?? constraints.smallest;
}
```

## 10.2 computeDryLayout

`computeDryLayout` 是“干布局”。

它用于在不真正修改布局状态的情况下，询问一个 RenderBox 在某个约束下会有多大。

典型特征：

```dart
@override
Size computeDryLayout(BoxConstraints constraints) {
  return constraints.constrain(const Size(100, 100));
}
```

它不能产生副作用：

```text
不能修改 size
不能修改 child offset
不能依赖真实 layout 状态
```

框架调用它的公共入口是 `getDryLayout(constraints)`（3.41 中该方法还会按约束缓存结果，同一约束不会重复计算）。如果 dry layout 依赖子节点的尺寸，必须调用子节点的 `getDryLayout`，而不是去读子节点上一次真实布局留下的 `size`：

```dart
@override
Size computeDryLayout(BoxConstraints constraints) {
  // 1. 子节点的“假想尺寸”也用 dry 方式获取
  final Size? childSize = child?.getDryLayout(constraints.loosen());
  // 2. 再套上自己的约束
  return constraints.constrain(childSize ?? Size.zero);
}
```

## 10.3 为什么需要 dry layout

Flutter 中很多布局需要提前测量尺寸，例如：

1. IntrinsicWidth / IntrinsicHeight 的自适应测量；
2. baseline 计算；
3. 父节点进行布局决策时的预估；
4. 框架内部组件（RenderFlex、AnimatedSize、RotatedBox 等都会调用 getDryLayout）。

如果自定义 RenderBox 不覆写 `computeDryLayout`，3.41 的默认实现会在 debug 模式报告 "The xxx class does not implement computeDryLayout"，然后返回 `Size.zero`（见 `rendering/box.dart`）——不会直接崩溃，但所有依赖 dry 测量的调用方都会拿到错误（零）尺寸，进而引发布局异常。

另外注意区分：IntrinsicWidth / IntrinsicHeight 走的是另一套 intrinsic 协议（`computeMinIntrinsicWidth` 等方法），与 dry layout 是并列的两套“只测量、不落地”的协议，自定义时常常需要一并实现。

---

# 11. 父子 RenderObject 如何通信

父子 RenderObject 通信主要通过三种方式。

## 11.1 constraints

父节点通过 constraints 告诉子节点：

```text
你能多大。
```

```dart
child.layout(
  BoxConstraints.tight(const Size(100, 100)),
  parentUsesSize: true,
);
```

## 11.2 size

子节点通过 size 告诉父节点：

```text
我最终多大。
```

```dart
final Size childSize = child.size;
```

前提是父节点调用 layout 时传入：

```dart
parentUsesSize: true
```

## 11.3 ParentData

父节点通过 `ParentData` 存储子节点相关的父级布局数据。

例如：

```dart
final BoxParentData childParentData = child.parentData! as BoxParentData;
childParentData.offset = const Offset(10, 20);
```

子节点本身不决定自己在父节点中的位置。

> 子节点决定自己的 size，父节点决定子节点的 offset。

---

# 12. ParentData 的作用与源码理解

`ParentData` 是 Flutter RenderObject 体系中非常关键，但容易被忽略的概念。

它表示：

```text
父 RenderObject 需要附加在子 RenderObject 上的布局数据。
```

## 12.1 BoxParentData

最常见的是：

```dart
class BoxParentData extends ParentData {
  Offset offset = Offset.zero;
}
```

它保存子节点在父坐标系中的偏移。

例如 `RenderStack` 会给每个 child 使用更复杂的 ParentData：

```dart
class StackParentData extends ContainerBoxParentData<RenderBox> {
  double? top;
  double? right;
  double? bottom;
  double? left;
  double? width;
  double? height;
}
```

这解释了为什么：

```dart
Positioned(
  left: 10,
  top: 20,
  child: Text('A'),
)
```

必须放在 `Stack` 里面。

因为 `Positioned` 本质上是一个 `ParentDataWidget`，它要把 `left/top/right/bottom` 写入 `StackParentData`。

如果父节点不是 Stack，对应的 ParentData 类型不对，就会报错。

## 12.2 Expanded 为什么必须放在 Flex 中

`Expanded` 也是 `ParentDataWidget`。

它写入的是：

```dart
FlexParentData
```

其中包含：

```dart
int? flex;
FlexFit? fit;
```

所以：

```dart
Expanded(
  child: Text('A'),
)
```

只能放在 `Row`、`Column`、`Flex` 内部。

否则父 RenderObject 不是 RenderFlex，子节点 parentData 类型不是 FlexParentData，就会出现典型错误。

---

# 13. 绘制流程：paint、PaintingContext 与 Layer

RenderObject 布局完成后，会进入绘制阶段。

核心方法：

```dart
void paint(PaintingContext context, Offset offset)
```

参数含义：

```text
context：绘制上下文，封装 canvas、layer、repaint boundary 等能力
offset：当前 RenderObject 在父坐标系中的绘制偏移
```

## 13.1 基础绘制示例

```dart
@override
void paint(PaintingContext context, Offset offset) {
  final Canvas canvas = context.canvas;
  final Paint paint = Paint()..color = Colors.red;

  canvas.drawRect(offset & size, paint);
}
```

这里：

```dart
offset & size
```

等价于：

```dart
Rect.fromLTWH(offset.dx, offset.dy, size.width, size.height)
```

## 13.2 绘制 child

如果当前 RenderObject 有 child，需要显式绘制 child：

```dart
@override
void paint(PaintingContext context, Offset offset) {
  if (child != null) {
    final BoxParentData childParentData = child!.parentData! as BoxParentData;
    context.paintChild(child!, offset + childParentData.offset);
  }
}
```

注意：

> 子节点不会自动绘制。父节点必须在 paint 中调用 `context.paintChild`。

## 13.3 PaintingContext 的作用

`PaintingContext` 不只是 Canvas 包装。

它还负责：

1. 管理绘制栈；
2. 创建 layer；
3. 处理 repaint boundary；
4. 调用子节点 paint；
5. 维护 compositing 状态。

一个容易踩坑的地方：

> `context.canvas` 不是一直不变的。绘制 child 的过程中，前后绘制指令可能被分别记录到不同的合成 layer 上，canvas 对象可能随时更换。

因此不要把 canvas 缓存到成员变量，也不要跨 `context.paintChild(...)` 调用继续使用之前拿到的 canvas 引用。这就是 `paint` 方法里总是就地 `final Canvas canvas = context.canvas;` 的原因：

```dart
@override
void paint(PaintingContext context, Offset offset) {
  final Canvas canvas = context.canvas;
  canvas.drawRect(offset & size, _backgroundPaint);

  // 画 child：此后 canvas 可能已经更换，必须重新获取
  context.paintChild(child!, offset);

  final Canvas canvas2 = context.canvas;
  canvas2.drawRect(offset & size, _borderPaint);
}
```

这一约定在源码（`rendering/object.dart` 的 PaintingContext 文档：don't hold a reference to the canvas across operations that might paint child render objects）和 [RenderBox 官方文档](https://api.flutter.dev/flutter/rendering/RenderBox-class.html) 中都有明确说明。

---

# 14. 合成层：什么时候会产生 Layer

Flutter 最终可能产生多个 Layer，并不会把所有内容直接画到一个大 Canvas 上。

常见 Layer：

```text
OffsetLayer
TransformLayer
OpacityLayer
ClipRectLayer
ClipRRectLayer
ClipPathLayer
PictureLayer
PlatformViewLayer
```

## 14.1 RepaintBoundary

`RepaintBoundary` 会在 RenderObject 树上创建重绘边界（其机制与 9.3 节的 relayoutBoundary 类似，只是作用对象从布局换成了绘制：`markNeedsPaint` 的脏标记向上传播到 repaint boundary 即停止）。

它的价值是：

```text
子树重绘时，不必连带父级一起重绘。
```

适合：

1. 复杂静态背景；
2. 高频变化局部区域；
3. 列表中的复杂 item；
4. 动画区域隔离。

但不能滥用。

滥用会带来：

1. layer 增多；
2. 显存占用上升；
3. 合成成本增加；
4. 某些场景反而变慢。

详细说明见 [RepaintBoundary 官方文档](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html)。

## 14.2 needsCompositing

RenderObject 中有一个重要概念：

```dart
needsCompositing
```

它表示当前节点或子树是否需要合成层。

当合成状态变化时，需要：

```dart
markNeedsCompositingBitsUpdate();
```

---

# 15. 命中测试：hitTest 与事件分发

Flutter 指针事件经过 RenderObject 的 hitTest 分发，而不是直接从 Widget 层下发。

大致流程：

```text
PointerDownEvent
  ↓
GestureBinding.hitTest
  ↓
RendererBinding.hitTestInView（多视图场景下按 viewId 定位 RenderView）
  ↓
RenderView.hitTest
  ↓
RenderObject tree hitTest
  ↓
HitTestResult 收集命中路径
  ↓
事件沿命中路径分发
  ↓
GestureRecognizer 竞争手势竞技场
```

## 15.1 RenderBox 的 hitTest

RenderBox 中常见方法：

```dart
bool hitTest(BoxHitTestResult result, {required Offset position})
bool hitTestSelf(Offset position)
bool hitTestChildren(BoxHitTestResult result, {required Offset position})
```

常见写法：

```dart
@override
bool hitTestSelf(Offset position) => true;
```

表示当前 RenderBox 自己可以被命中。

## 15.2 子节点命中测试

如果有 child，需要测试 child：

```dart
@override
bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
  if (child == null) return false;

  final BoxParentData childParentData = child!.parentData! as BoxParentData;
  return result.addWithPaintOffset(
    offset: childParentData.offset,
    position: position,
    hitTest: (BoxHitTestResult result, Offset transformed) {
      return child!.hitTest(result, position: transformed);
    },
  );
}
```

## 15.3 paint 区域和 hitTest 区域可以不同

RenderObject 可以做到：

1. 画得很小，点击区域很大；
2. 画得很大，只允许部分区域点击；
3. 非矩形点击区域；
4. 子节点视觉位置和命中位置一致或不一致。

这也是自定义 RenderObject 比普通 Widget 更底层、更灵活的地方。

---

# 16. 语义系统：Semantics 与无障碍

Flutter 的语义系统用于辅助功能。

例如：

1. iOS VoiceOver；
2. Android TalkBack；
3. 可访问性工具；
4. 自动化测试中的语义查找。

自定义 RenderObject 可以重写：

```dart
@override
void describeSemanticsConfiguration(SemanticsConfiguration config) {
  super.describeSemanticsConfiguration(config);
  config.label = '自定义按钮';
  config.isButton = true;
  config.onTap = _handleTap;
}
```

如果你写的是一个真正可交互组件，而不是纯装饰性组件，应该考虑语义支持。

---

# 17. RenderObject 生命周期

RenderObject 的生命周期大致如下：

```text
createRenderObject
  ↓
attach
  ↓
layout
  ↓
paint
  ↓
semantics
  ↓
updateRenderObject
  ↓
reassemble hot reload
  ↓
detach
  ↓
dispose
```

## 17.1 createRenderObject

由 `RenderObjectWidget` 创建：

```dart
@override
RenderObject createRenderObject(BuildContext context) {
  return RenderMyBox(color: color);
}
```

## 17.2 updateRenderObject

Widget 配置变化时，Element 会调用：

```dart
@override
void updateRenderObject(BuildContext context, RenderMyBox renderObject) {
  renderObject.color = color;
}
```

RenderObject 属性 setter 中决定是否触发：

```dart
markNeedsLayout();
markNeedsPaint();
```

## 17.3 attach / detach

RenderObject attach 到 PipelineOwner 时调用：

```dart
@override
void attach(PipelineOwner owner) {
  super.attach(owner);
}
```

离开渲染树时：

```dart
@override
void detach() {
  super.detach();
}
```

如果 RenderObject 内部持有 animation、ticker、listener、stream subscription，需要在 attach/detach 或 dispose 中谨慎管理。

## 17.4 dispose

释放资源：

```dart
@override
void dispose() {
  // release resources
  super.dispose();
}
```

---

# 18. markNeedsLayout / markNeedsPaint / markNeedsCompositingBitsUpdate

这是自定义 RenderObject 最重要的三个方法。

## 18.1 markNeedsLayout

当属性变化会影响尺寸或子节点位置时，调用：

```dart
markNeedsLayout();
```

调用后节点进入待布局状态；如果它不是 relayout boundary，脏标记会通过 markParentNeedsLayout 逐级向上传播，直到最近的 boundary（机制见 9.3 节）。

例如：

1. width；
2. height；
3. padding；
4. alignment；
5. spacing；
6. child layout constraints；
7. 子节点 offset。

示例：

```dart
double get spacing => _spacing;
double _spacing;
set spacing(double value) {
  if (_spacing == value) return;
  _spacing = value;
  markNeedsLayout();
}
```

## 18.2 markNeedsPaint

当属性变化只影响绘制，不影响布局时，调用：

```dart
markNeedsPaint();
```

例如：

1. color；
2. strokeWidth 不影响 size 时；
3. gradient；
4. shadow；
5. decoration；
6. 绘制路径。

示例：

```dart
Color get color => _color;
Color _color;
set color(Color value) {
  if (_color == value) return;
  _color = value;
  markNeedsPaint();
}
```

## 18.3 markNeedsCompositingBitsUpdate

当属性变化影响是否需要合成层时，调用：

```dart
markNeedsCompositingBitsUpdate();
```

例如：

1. opacity 从 1.0 变成 0.5；
2. 是否开启 clip；
3. 是否需要 layer；
4. transform 相关变化。

## 18.4 markNeedsSemanticsUpdate

当语义信息变化时，调用：

```dart
markNeedsSemanticsUpdate();
```

例如：

1. label 变化；
2. enabled 变化；
3. checked 变化；
4. value 变化。

---

# 19. 自定义 RenderObject 的三种入口

Flutter 提供三类 RenderObjectWidget：

```text
LeafRenderObjectWidget
SingleChildRenderObjectWidget
MultiChildRenderObjectWidget
```

## 19.1 LeafRenderObjectWidget

没有 child。

适合：

1. 自定义绘制图形；
2. 自定义进度条；
3. 自定义仪表盘；
4. 自定义点击区域；
5. 高性能 Canvas 绘制组件。

## 19.2 SingleChildRenderObjectWidget

一个 child。

适合：

1. 自定义 Padding；
2. 自定义 Align；
3. 自定义 Transform；
4. 自定义布局容器；
5. 自定义点击区域包装器。

## 19.3 MultiChildRenderObjectWidget

多个 child。

适合：

1. 自定义 Row / Column；
2. 自定义 Wrap；
3. 自定义 Stack；
4. 瀑布流布局；
5. 标签布局；
6. 时间轴布局。

这三个基类的职责与 `createRenderObject` / `updateRenderObject` 约定，见 [RenderObjectWidget 官方文档](https://api.flutter.dev/flutter/widgets/RenderObjectWidget-class.html)。

---

# 20. 示例一：自定义单子节点 RenderBox

目标：实现一个简化版 `Padding`。

## 20.1 Widget 层

```dart
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

class MyPadding extends SingleChildRenderObjectWidget {
  const MyPadding({
    super.key,
    required this.padding,
    super.child,
  });

  final EdgeInsets padding;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderMyPadding(padding: padding);
  }

  @override
  void updateRenderObject(BuildContext context, RenderMyPadding renderObject) {
    renderObject.padding = padding;
  }
}
```

## 20.2 RenderObject 层

```dart
class RenderMyPadding extends RenderShiftedBox {
  RenderMyPadding({
    required EdgeInsets padding,
    RenderBox? child,
  })  : _padding = padding,
        super(child);

  EdgeInsets _padding;

  EdgeInsets get padding => _padding;

  set padding(EdgeInsets value) {
    if (_padding == value) return;
    _padding = value;
    markNeedsLayout();
  }

  @override
  void performLayout() {
    final BoxConstraints innerConstraints = constraints.deflate(padding);

    if (child == null) {
      size = constraints.constrain(Size(
        padding.horizontal,
        padding.vertical,
      ));
      return;
    }

    child!.layout(innerConstraints, parentUsesSize: true);

    final Size childSize = child!.size;

    size = constraints.constrain(Size(
      childSize.width + padding.horizontal,
      childSize.height + padding.vertical,
    ));

    final BoxParentData childParentData = child!.parentData! as BoxParentData;
    childParentData.offset = Offset(padding.left, padding.top);
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    if (child == null) return;

    final BoxParentData childParentData = child!.parentData! as BoxParentData;
    context.paintChild(child!, offset + childParentData.offset);
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    if (child == null) return false;

    final BoxParentData childParentData = child!.parentData! as BoxParentData;

    return result.addWithPaintOffset(
      offset: childParentData.offset,
      position: position,
      hitTest: (BoxHitTestResult result, Offset transformed) {
        return child!.hitTest(result, position: transformed);
      },
    );
  }
}
```

## 20.3 使用方式

```dart
class MyPaddingDemo extends StatelessWidget {
  const MyPaddingDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: MyPadding(
          padding: EdgeInsets.all(24),
          child: ColoredBox(
            color: Colors.blue,
            child: SizedBox(width: 100, height: 80),
          ),
        ),
      ),
    );
  }
}
```

## 20.4 机制分析

这个组件的核心流程：

```text
父节点给 MyPadding constraints
  ↓
MyPadding deflate constraints，扣除 padding
  ↓
用 innerConstraints 布局 child
  ↓
读取 child.size
  ↓
自己的 size = child.size + padding
  ↓
设置 child offset
  ↓
paint 时把 child 画到 offset + padding 位置
```

---

# 21. 示例二：自定义多子节点 RenderBox

目标：实现一个简单的水平布局 `MyRow`。

它不支持 flex，只是把所有子节点从左到右排列。

## 21.1 Widget 层

```dart
class MySimpleRow extends MultiChildRenderObjectWidget {
  const MySimpleRow({
    super.key,
    super.children,
    this.spacing = 0,
  });

  final double spacing;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderMySimpleRow(spacing: spacing);
  }

  @override
  void updateRenderObject(BuildContext context, RenderMySimpleRow renderObject) {
    renderObject.spacing = spacing;
  }
}
```

## 21.2 ParentData

多子节点 RenderBox 通常需要：

```dart
class MySimpleRowParentData extends ContainerBoxParentData<RenderBox> {}
```

`ContainerBoxParentData` 已经包含：

1. previousSibling；
2. nextSibling；
3. offset。

## 21.3 RenderObject 层

```dart
class RenderMySimpleRow extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, MySimpleRowParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, MySimpleRowParentData> {
  RenderMySimpleRow({required double spacing}) : _spacing = spacing;

  double _spacing;

  double get spacing => _spacing;

  set spacing(double value) {
    if (_spacing == value) return;
    _spacing = value;
    markNeedsLayout();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! MySimpleRowParentData) {
      child.parentData = MySimpleRowParentData();
    }
  }

  @override
  void performLayout() {
    double dx = 0;
    double maxHeight = 0;

    RenderBox? child = firstChild;

    while (child != null) {
      final MySimpleRowParentData childParentData =
          child.parentData! as MySimpleRowParentData;

      child.layout(
        BoxConstraints(
          minWidth: 0,
          maxWidth: constraints.maxWidth,
          minHeight: 0,
          maxHeight: constraints.maxHeight,
        ),
        parentUsesSize: true,
      );

      childParentData.offset = Offset(dx, 0);

      dx += child.size.width;
      maxHeight = math.max(maxHeight, child.size.height);

      if (childParentData.nextSibling != null) {
        dx += spacing;
      }

      child = childParentData.nextSibling;
    }

    size = constraints.constrain(Size(dx, maxHeight));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    defaultPaint(context, offset);
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    return defaultHitTestChildren(result, position: position);
  }
}
```

需要导入：

```dart
import 'dart:math' as math;
import 'package:flutter/rendering.dart';
```

## 21.4 使用方式

```dart
class MySimpleRowDemo extends StatelessWidget {
  const MySimpleRowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: MySimpleRow(
          spacing: 12,
          children: [
            ColoredBox(
              color: Colors.red,
              child: SizedBox(width: 60, height: 60),
            ),
            ColoredBox(
              color: Colors.green,
              child: SizedBox(width: 80, height: 40),
            ),
            ColoredBox(
              color: Colors.blue,
              child: SizedBox(width: 50, height: 100),
            ),
          ],
        ),
      ),
    );
  }
}
```

## 21.5 工程注意点

上面实现是教学版，真实 Row 复杂得多。

真实 `RenderFlex` 要处理：

1. flex；
2. Expanded；
3. Flexible；
4. mainAxisSize；
5. mainAxisAlignment；
6. crossAxisAlignment；
7. textDirection；
8. verticalDirection；
9. baseline；
10. overflow；
11. debug overflow indicator。

---

# 22. 示例三：自定义绘制型 RenderBox

目标：实现一个不依赖 CustomPainter 的自定义进度条。

## 22.1 Widget 层

```dart
class RenderProgressBar extends LeafRenderObjectWidget {
  const RenderProgressBar({
    super.key,
    required this.progress,
    this.height = 8,
    this.backgroundColor = const Color(0xFFE0E0E0),
    this.foregroundColor = Colors.blue,
  });

  final double progress;
  final double height;
  final Color backgroundColor;
  final Color foregroundColor;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderProgressBarBox(
      progress: progress,
      height: height,
      backgroundColor: backgroundColor,
      foregroundColor: foregroundColor,
    );
  }

  @override
  void updateRenderObject(
    BuildContext context,
    RenderProgressBarBox renderObject,
  ) {
    renderObject
      ..progress = progress
      ..barHeight = height
      ..backgroundColor = backgroundColor
      ..foregroundColor = foregroundColor;
  }
}
```

## 22.2 RenderObject 层

```dart
class RenderProgressBarBox extends RenderBox {
  RenderProgressBarBox({
    required double progress,
    required double height,
    required Color backgroundColor,
    required Color foregroundColor,
  })  : _progress = progress.clamp(0.0, 1.0),
        _barHeight = height,
        _backgroundColor = backgroundColor,
        _foregroundColor = foregroundColor;

  double _progress;
  double _barHeight;
  Color _backgroundColor;
  Color _foregroundColor;

  double get progress => _progress;
  set progress(double value) {
    final double next = value.clamp(0.0, 1.0);
    if (_progress == next) return;
    _progress = next;
    markNeedsPaint();
  }

  double get barHeight => _barHeight;
  set barHeight(double value) {
    if (_barHeight == value) return;
    _barHeight = value;
    markNeedsLayout();
  }

  Color get backgroundColor => _backgroundColor;
  set backgroundColor(Color value) {
    if (_backgroundColor == value) return;
    _backgroundColor = value;
    markNeedsPaint();
  }

  Color get foregroundColor => _foregroundColor;
  set foregroundColor(Color value) {
    if (_foregroundColor == value) return;
    _foregroundColor = value;
    markNeedsPaint();
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    return constraints.constrain(Size(constraints.maxWidth, barHeight));
  }

  @override
  void performLayout() {
    size = computeDryLayout(constraints);
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    final Canvas canvas = context.canvas;

    final Rect backgroundRect = offset & size;
    final RRect backgroundRRect = RRect.fromRectAndRadius(
      backgroundRect,
      Radius.circular(size.height / 2),
    );

    final Paint backgroundPaint = Paint()..color = backgroundColor;
    canvas.drawRRect(backgroundRRect, backgroundPaint);

    final Rect foregroundRect = Rect.fromLTWH(
      offset.dx,
      offset.dy,
      size.width * progress,
      size.height,
    );

    final RRect foregroundRRect = RRect.fromRectAndRadius(
      foregroundRect,
      Radius.circular(size.height / 2),
    );

    final Paint foregroundPaint = Paint()..color = foregroundColor;
    canvas.drawRRect(foregroundRRect, foregroundPaint);
  }
}
```

## 22.3 使用方式

```dart
class ProgressDemo extends StatefulWidget {
  const ProgressDemo({super.key});

  @override
  State<ProgressDemo> createState() => _ProgressDemoState();
}

class _ProgressDemoState extends State<ProgressDemo> {
  double progress = 0.3;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              RenderProgressBar(progress: progress),
              const SizedBox(height: 24),
              Slider(
                value: progress,
                onChanged: (value) {
                  setState(() => progress = value);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

## 22.4 为什么 progress 改变只 markNeedsPaint

`progress` 只影响前景绘制宽度，不影响组件自身 size，也不影响父子布局。

所以：

```dart
markNeedsPaint();
```

即可。

如果错误调用：

```dart
markNeedsLayout();
```

也能工作，但会造成不必要的布局开销。

---

# 23. 示例四：自定义布局型 RenderBox

目标：实现一个 `BadgeLayout`：child 正常布局，badge 贴到右上角。

## 23.1 Widget 层

```dart
class MyBadge extends MultiChildRenderObjectWidget {
  MyBadge({
    super.key,
    required Widget child,
    required Widget badge,
  }) : super(children: [child, badge]);

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderMyBadge();
  }
}
```

## 23.2 ParentData

```dart
class MyBadgeParentData extends ContainerBoxParentData<RenderBox> {}
```

## 23.3 RenderObject 层

```dart
class RenderMyBadge extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, MyBadgeParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, MyBadgeParentData> {
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! MyBadgeParentData) {
      child.parentData = MyBadgeParentData();
    }
  }

  RenderBox? get contentChild => firstChild;

  RenderBox? get badgeChild {
    final RenderBox? first = firstChild;
    if (first == null) return null;
    final MyBadgeParentData parentData = first.parentData! as MyBadgeParentData;
    return parentData.nextSibling;
  }

  @override
  void performLayout() {
    final RenderBox? content = contentChild;
    final RenderBox? badge = badgeChild;

    if (content == null) {
      size = constraints.smallest;
      return;
    }

    content.layout(constraints, parentUsesSize: true);

    size = constraints.constrain(content.size);

    final MyBadgeParentData contentParentData =
        content.parentData! as MyBadgeParentData;
    contentParentData.offset = Offset.zero;

    if (badge != null) {
      badge.layout(constraints.loosen(), parentUsesSize: true);

      final MyBadgeParentData badgeParentData =
          badge.parentData! as MyBadgeParentData;

      badgeParentData.offset = Offset(
        size.width - badge.size.width / 2,
        -badge.size.height / 2,
      );
    }
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    defaultPaint(context, offset);
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    return defaultHitTestChildren(result, position: position);
  }
}
```

## 23.4 使用方式

```dart
class BadgeDemo extends StatelessWidget {
  const BadgeDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: MyBadge(
          child: const Icon(Icons.notifications, size: 64),
          badge: Container(
            width: 24,
            height: 24,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: Colors.red,
              shape: BoxShape.circle,
            ),
            child: const Text(
              '3',
              style: TextStyle(color: Colors.white, fontSize: 12),
            ),
          ),
        ),
      ),
    );
  }
}
```

## 23.5 这个例子的意义

这个例子展示：

1. 多 child RenderObject 如何管理 child 链表；
2. 如何区分第一个 child 和第二个 child；
3. 如何给 child 设置不同 offset；
4. 如何让 badge 超出 content 区域绘制；
5. 为什么 paint 和 hitTest 要与 offset 保持一致。

---

# 24. 示例五：自定义命中测试区域

目标：实现一个视觉大小为 40x40，但点击区域扩展为 80x80 的组件。

## 24.1 Widget 层

```dart
class ExpandedHitBox extends SingleChildRenderObjectWidget {
  const ExpandedHitBox({
    super.key,
    required this.expandBy,
    super.child,
  });

  final double expandBy;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderExpandedHitBox(expandBy: expandBy);
  }

  @override
  void updateRenderObject(
    BuildContext context,
    RenderExpandedHitBox renderObject,
  ) {
    renderObject.expandBy = expandBy;
  }
}
```

## 24.2 RenderObject 层

```dart
class RenderExpandedHitBox extends RenderProxyBox {
  RenderExpandedHitBox({
    required double expandBy,
    RenderBox? child,
  })  : _expandBy = expandBy,
        super(child);

  double _expandBy;

  double get expandBy => _expandBy;

  set expandBy(double value) {
    if (_expandBy == value) return;
    _expandBy = value;
    markNeedsPaint();
  }

  @override
  bool hitTest(BoxHitTestResult result, {required Offset position}) {
    final Rect expandedBounds = Rect.fromLTWH(
      -expandBy,
      -expandBy,
      size.width + expandBy * 2,
      size.height + expandBy * 2,
    );

    if (!expandedBounds.contains(position)) {
      return false;
    }

    if (child != null) {
      final bool hitChild = child!.hitTest(result, position: position);
      if (hitChild) return true;
    }

    result.add(BoxHitTestEntry(this, position));
    return true;
  }

  @override
  bool hitTestSelf(Offset position) => true;
}
```

## 24.3 使用方式

```dart
class HitBoxDemo extends StatelessWidget {
  const HitBoxDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: GestureDetector(
          onTap: () {
            debugPrint('hit');
          },
          child: const ExpandedHitBox(
            expandBy: 20,
            child: Icon(Icons.close, size: 40),
          ),
        ),
      ),
    );
  }
}
```

## 24.4 注意

这个示例展示的是底层机制。

实际业务中更简单的做法通常是：

```dart
GestureDetector(
  behavior: HitTestBehavior.translucent,
  child: Padding(
    padding: EdgeInsets.all(20),
    child: Icon(Icons.close),
  ),
)
```

但当你需要视觉位置、布局尺寸、点击区域三者解耦时，自定义 RenderObject 更灵活。

---

# 25. 自定义 RenderObject 的常见 bug

## 25.1 performLayout 没有设置 size

错误示例：

```dart
@override
void performLayout() {
  child?.layout(constraints);
}
```

正确示例：

```dart
@override
void performLayout() {
  child?.layout(constraints, parentUsesSize: true);
  size = child?.size ?? constraints.smallest;
}
```

## 25.2 读取 child.size 却没有 parentUsesSize

错误示例：

```dart
child.layout(constraints);
final childSize = child.size;
```

正确示例：

```dart
child.layout(constraints, parentUsesSize: true);
final childSize = child.size;
```

## 25.3 属性变化后调用错 dirty 方法

如果 spacing 改变会影响 child offset：

```dart
markNeedsLayout();
```

如果 color 改变只影响绘制：

```dart
markNeedsPaint();
```

## 25.4 忘记绘制 child

错误示例：

```dart
@override
void paint(PaintingContext context, Offset offset) {
  // draw self only
}
```

如果有 child，需要：

```dart
context.paintChild(child!, offset + childOffset);
```

## 25.5 忘记处理 hitTestChildren

如果组件有 child，但没有正确转发命中测试，子组件可能无法点击。

## 25.6 ParentData 类型不匹配

多子节点自定义 RenderObject 必须实现：

```dart
@override
void setupParentData(RenderBox child) {
  if (child.parentData is! MyParentData) {
    child.parentData = MyParentData();
  }
}
```

否则 child parentData 可能不是你需要的类型。

## 25.7 无限约束处理错误

错误场景：

```dart
size = constraints.biggest;
```

如果 `constraints.biggest.height` 是 infinity，就会出问题。

更安全：

```dart
size = constraints.constrain(const Size(100, 100));
```

---

# 26. RenderObject 与 CustomPainter 的区别

`CustomPainter` 很常用，但它和自定义 RenderObject 不是一个层级。

## 26.1 CustomPainter 适合什么

适合纯绘制：

1. 图表；
2. 背景；
3. 装饰；
4. 路径；
5. 波浪线；
6. 简单交互绘制。

示例：

```dart
CustomPaint(
  painter: MyPainter(),
  child: ...,
)
```

## 26.2 RenderObject 适合什么

适合底层能力：

1. 自定义布局；
2. 自定义绘制；
3. 自定义 hitTest；
4. 自定义语义；
5. 管理 child；
6. 极致性能优化；
7. 替代复杂 Widget 组合。

## 26.3 对比表

| 能力 | CustomPainter | RenderObject |
|---|---:|---:|
| 自定义绘制 | 支持 | 支持 |
| 自定义布局 | 不适合 | 支持 |
| 管理多个 child | 不适合 | 支持 |
| 自定义命中测试 | 有限 | 强 |
| 自定义语义 | 有限 | 强 |
| 接近 Flutter 底层 | 否 | 是 |
| 学习成本 | 低 | 高 |
| 性能控制粒度 | 中 | 高 |

## 26.4 选择建议

优先选择顺序：

```text
普通 Widget 组合
  ↓ 不够
CustomPaint / CustomPainter
  ↓ 不够
Flow / Stack / LayoutBuilder
  ↓ 不够
自定义 RenderObject
```

不要一上来就写 RenderObject。

RenderObject 是强工具，但也是高复杂度工具。

---

# 27. RenderObject 与 Flow / Stack / LayoutBuilder 的区别

## 27.1 Stack

适合已知规则的层叠布局。

例如：

```dart
Stack(
  children: [
    child,
    Positioned(...),
  ],
)
```

如果只是简单叠加，不需要自定义 RenderObject。

## 27.2 Flow

`Flow` 可以在 paint 阶段控制 child 的位置。

优点：

1. 避免频繁 layout；
2. 适合动画位置变换；
3. child 尺寸稳定时很高效。

缺点：

1. 布局语义不如 RenderObject 清晰；
2. 命中测试和语义可能更复杂；
3. 不适合所有布局。

## 27.3 LayoutBuilder

`LayoutBuilder` 能拿到父约束，然后返回不同 Widget。

适合响应式布局。

但它仍然在 Widget build 层处理问题。

如果你需要控制底层 layout / paint / hitTest，LayoutBuilder 不够。

## 27.4 自定义 RenderObject

适合真正需要重写布局协议或绘制协议的场景。

例如：

1. 高性能瀑布流；
2. 复杂文本/图形混排；
3. 自定义虚拟列表；
4. 非矩形 hitTest；
5. child 位置和视觉绘制强绑定；
6. 大量节点时减少 Widget 层开销。

---

# 28. RenderObject 性能优化实践

## 28.1 尽量区分 layout 和 paint

属性变化时，准确选择：

```dart
markNeedsLayout(); // 尺寸/位置变化
markNeedsPaint();  // 只绘制变化
```

错误地把绘制变化升级为 layout，会导致额外布局成本。

## 28.2 避免在 paint 中创建大量对象

不推荐：

```dart
@override
void paint(PaintingContext context, Offset offset) {
  final Paint paint = Paint()..color = color;
  final Path path = Path();
}
```

如果 paint 高频执行，可以缓存：

```dart
final Paint _paint = Paint();

@override
void paint(PaintingContext context, Offset offset) {
  _paint.color = color;
  context.canvas.drawRect(offset & size, _paint);
}
```

## 28.3 谨慎使用 saveLayer

`canvas.saveLayer` 很昂贵。

它可能触发离屏渲染。

常见高成本效果：

1. opacity layer；
2. blur；
3. shader mask；
4. backdrop filter；
5. complex clip + antiAliasWithSaveLayer。

## 28.4 合理使用 RepaintBoundary

适合：

```text
局部高频重绘，父级不变。
```

不适合：

```text
大量小组件无脑包 RepaintBoundary。
```

## 28.5 避免 Intrinsic 布局

Intrinsic 测量可能导致额外布局成本。

例如：

```dart
IntrinsicHeight
IntrinsicWidth
```

在复杂列表中尤其要谨慎。

## 28.6 列表中自定义 RenderObject 要控制复杂度

如果自定义 RenderObject 用在大量列表 item 中，要注意：

1. 对象分配；
2. paint 成本；
3. layout 成本；
4. layer 数量；
5. 是否能复用缓存；
6. 是否引入 intrinsic 测量。

---

# 29. Flutter 源码阅读路线

理解 RenderObject 建议按以下源码阅读。

## 29.1 基础类

```text
packages/flutter/lib/src/rendering/object.dart
packages/flutter/lib/src/rendering/box.dart
packages/flutter/lib/src/rendering/sliver.dart
```

重点看：

```text
RenderObject
RenderBox
Constraints
BoxConstraints
PipelineOwner
PaintingContext
```

## 29.2 Element 与 RenderObject 连接

```text
packages/flutter/lib/src/widgets/framework.dart
```

重点看：

```text
RenderObjectWidget
RenderObjectElement
SingleChildRenderObjectElement
MultiChildRenderObjectElement
ParentDataWidget
```

## 29.3 常见 RenderBox 实现

```text
packages/flutter/lib/src/rendering/proxy_box.dart
packages/flutter/lib/src/rendering/shifted_box.dart
packages/flutter/lib/src/rendering/flex.dart
packages/flutter/lib/src/rendering/stack.dart
packages/flutter/lib/src/rendering/paragraph.dart
packages/flutter/lib/src/rendering/image.dart
```

建议阅读顺序：

```text
RenderProxyBox
  ↓
RenderPadding
  ↓
RenderPositionedBox
  ↓
RenderFlex
  ↓
RenderStack
  ↓
RenderParagraph
```

## 29.4 绘制与合成

```text
packages/flutter/lib/src/rendering/layer.dart
packages/flutter/lib/src/rendering/proxy_box.dart
packages/flutter/lib/src/rendering/view.dart
```

重点看：

```text
OffsetLayer
PictureLayer
TransformLayer
OpacityLayer
ClipRectLayer
RenderRepaintBoundary
```

## 29.5 手势与命中测试

```text
packages/flutter/lib/src/rendering/box.dart
packages/flutter/lib/src/gestures/binding.dart
packages/flutter/lib/src/gestures/hit_test.dart
```

重点看：

```text
HitTestResult
HitTestEntry
BoxHitTestResult
RenderBox.hitTest
```

---

# 30. 开源项目与源码参考

以下方向适合阅读或参考。

## 30.1 Flutter Framework 源码

最重要的参考永远是 Flutter 官方源码。

重点目录：

```text
flutter/packages/flutter/lib/src/rendering
flutter/packages/flutter/lib/src/widgets
```

## 30.2 extended_nested_scroll_view

该类项目通常涉及复杂滚动、Sliver、NestedScrollView 修复与渲染层处理。

适合学习：

1. Sliver 布局；
2. 滚动协调；
3. NestedScrollView 的复杂边界；
4. RenderSliver 相关思维。

## 30.3 flutter_staggered_grid_view

瀑布流 / 交错网格布局类项目。

适合学习：

1. 自定义布局算法；
2. SliverGrid 体系；
3. 大量 child 的性能管理；
4. grid delegate 设计。

## 30.4 flutter_layout_grid

CSS Grid 风格布局。

适合学习：

1. 多子节点布局；
2. grid track sizing；
3. intrinsic measurement；
4. ParentData 使用。

## 30.5 super_editor

复杂富文本编辑器项目。

适合学习：

1. 文本布局；
2. selection；
3. overlay；
4. hitTest；
5. 自定义编辑体验。

## 30.6 flutter_hooks / provider / getx 等状态库

这些库不一定直接写 RenderObject，但理解它们如何触发 Widget rebuild，有助于你理解：

```text
状态变化如何最终传导到 RenderObject 的 layout / paint。
```

---

# 31. 相关概念清单

理解 RenderObject 时，建议一起掌握以下概念。

## 31.1 Flutter 树结构相关

```text
Widget Tree
Element Tree
RenderObject Tree
Layer Tree
Semantics Tree
```

## 31.2 Widget 类型相关

```text
StatelessWidget
StatefulWidget
InheritedWidget
RenderObjectWidget
LeafRenderObjectWidget
SingleChildRenderObjectWidget
MultiChildRenderObjectWidget
ParentDataWidget
ProxyWidget
```

## 31.3 Element 类型相关

```text
Element
ComponentElement
StatelessElement
StatefulElement
RenderObjectElement
SingleChildRenderObjectElement
MultiChildRenderObjectElement
InheritedElement
```

## 31.4 RenderObject 类型相关

```text
RenderObject
RenderBox
RenderSliver
RenderProxyBox
RenderShiftedBox
RenderFlex
RenderStack
RenderParagraph
RenderImage
RenderCustomPaint
RenderRepaintBoundary
```

## 31.5 布局相关

```text
Constraints
BoxConstraints
SliverConstraints
Size
Offset
ParentData
BoxParentData
ContainerBoxParentData
FlexParentData
StackParentData
performLayout
performResize
computeDryLayout
Intrinsic dimensions
Baseline
```

## 31.6 绘制相关

```text
Canvas
Paint
Path
Picture
PaintingContext
Layer
PictureLayer
OffsetLayer
TransformLayer
OpacityLayer
ClipRectLayer
ClipPathLayer
RepaintBoundary
saveLayer
```

## 31.7 事件相关

```text
PointerEvent
HitTestResult
HitTestEntry
BoxHitTestResult
GestureRecognizer
GestureArena
Listener
GestureDetector
MouseRegion
```

## 31.8 调度相关

```text
SchedulerBinding
WidgetsBinding
RendererBinding
PipelineOwner
BuildOwner
Frame callback
flushLayout
flushCompositingBits
flushPaint
flushSemantics
```

---

# 32. 总结

RenderObject 是 Flutter UI 系统中真正执行渲染工作的核心对象。

```text
Widget 负责描述，Element 负责管理，RenderObject 负责布局、绘制、命中测试和语义。
```

进一步说：

```text
Widget 是声明式配置。
Element 是运行时挂载点。
RenderObject 是渲染执行体。
Layer 是合成产物。
Canvas 是绘制接口。
Engine 最终负责光栅化。
```

理解 RenderObject 后，很多 Flutter 问题会变得清晰：

1. `didUpdateWidget` 为什么会触发；
2. `canUpdate` 为什么只看 runtimeType 和 key；
3. `Expanded` 为什么必须放在 `Flex` 中；
4. `Positioned` 为什么必须放在 `Stack` 中；
5. `RenderBox was not laid out` 的根源是什么；
6. `markNeedsLayout` 和 `markNeedsPaint` 的边界在哪里；
7. 为什么 CustomPainter 不能解决所有布局问题；
8. 为什么 Sliver 是滚动性能的核心；
9. 为什么复杂 UI 最终要理解渲染树；
10. 如何写出比普通 Widget 组合更底层、更高性能的组件。

对 Flutter 程序员来说，RenderObject 不是每天都要写，但一定值得理解。

因为它是 Flutter 从声明式 UI 走向屏幕像素的关键路径。

当你能从 RenderObject 角度看 Flutter 时，你对布局、性能、动画、事件、滚动、源码的理解会进入另一个层级。

---

# 附录 A：完整可运行示例入口

你可以把前文示例放入一个 Flutter 项目中运行。

示例入口：

```dart
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

void main() {
  runApp(const MaterialApp(home: RenderObjectDemoHome()));
}

class RenderObjectDemoHome extends StatelessWidget {
  const RenderObjectDemoHome({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('RenderObject Demo')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: const [
          Text('MyPadding Demo'),
          SizedBox(height: 12),
          Center(
            child: MyPadding(
              padding: EdgeInsets.all(24),
              child: ColoredBox(
                color: Colors.blue,
                child: SizedBox(width: 100, height: 80),
              ),
            ),
          ),
          SizedBox(height: 32),
          Text('MySimpleRow Demo'),
          SizedBox(height: 12),
          MySimpleRow(
            spacing: 12,
            children: [
              ColoredBox(color: Colors.red, child: SizedBox(width: 60, height: 60)),
              ColoredBox(color: Colors.green, child: SizedBox(width: 80, height: 40)),
              ColoredBox(color: Colors.blue, child: SizedBox(width: 50, height: 100)),
            ],
          ),
        ],
      ),
    );
  }
}
```

由于文档中示例分散展示，实际复制到工程时，请确保：

1. 所有类在同一个 Dart 文件或正确 import；
2. 已导入 `dart:math`；
3. 已导入 `package:flutter/rendering.dart`；
4. 已导入 `package:flutter/material.dart`；
5. 如果使用 `Colors`，必须依赖 material。

---

# 附录 B：学习路线建议

如果你是从业务 Flutter 开发逐步深入 RenderObject，建议路线如下：

```text
第一阶段：理解 Widget / Element / State / RenderObject 的分工
第二阶段：理解 BoxConstraints 和常见布局错误
第三阶段：阅读 RenderPadding / RenderPositionedBox / RenderProxyBox
第四阶段：实现 SingleChildRenderObjectWidget
第五阶段：实现 MultiChildRenderObjectWidget
第六阶段：理解 ParentDataWidget，例如 Expanded / Positioned
第七阶段：理解 paint / hitTest / semantics
第八阶段：阅读 RenderFlex / RenderStack
第九阶段：理解 SliverConstraints / SliverGeometry
第十阶段：尝试实现自定义 Sliver
```

不要一开始就读 `RenderFlex`。

更好的顺序是：

```text
RenderProxyBox → RenderPadding → RenderPositionedBox → RenderStack → RenderFlex
```

这样理解成本会低很多。

---

# 附录 C：常见面试级问题

## C.1 Widget 和 RenderObject 是一一对应的吗？

不是。

很多 Widget 不创建 RenderObject，例如：

```text
StatelessWidget
StatefulWidget
InheritedWidget
Builder
Theme
MediaQuery
```

只有 `RenderObjectWidget` 体系会创建 RenderObject。

## C.2 为什么 Widget 是不可变的，RenderObject 是可变的？

因为 Widget 作为配置对象，用于快速重建和 diff。

RenderObject 承载真实渲染状态，如果每次 build 都销毁重建，成本太高。

所以 Flutter 的策略是：

```text
频繁创建轻量 Widget
尽量复用重量级 Element / RenderObject
```

## C.3 父节点能不能直接决定子节点 size？

在 Box 协议中，父节点不能直接写子节点 size。

父节点只能给 constraints。

子节点必须在 constraints 范围内选择自己的 size。

但父节点可以通过 tight constraints 间接强制子节点大小。

## C.4 子节点能不能决定自己位置？

通常不能。

子节点决定自己的 size。

父节点通过 ParentData 决定子节点 offset。

## C.5 为什么 RenderObject 中很多地方要 parentUsesSize？

因为父节点是否依赖子节点 size，会影响 layout dirty 传播。

如果父节点读取 child.size，就应该传：

```dart
parentUsesSize: true
```

否则 Flutter 无法准确维护布局依赖关系。

## C.6 markNeedsLayout 会不会触发 build？

不会。

`markNeedsLayout` 标记的是渲染树布局脏。

它不会让 Widget 重新 build。

反过来，`setState` 会触发 build，build 后可能更新 RenderObject 属性，再间接触发 layout 或 paint。

## C.7 markNeedsPaint 会不会触发 layout？

不会。

`markNeedsPaint` 只标记需要重绘。

如果尺寸和位置不变，只调用它即可。

## C.8 CustomPainter 和 RenderObject 哪个性能更好？

不能简单比较。

如果只是绘制，CustomPainter 足够且更简单。

如果需要自定义布局、命中测试、语义、子节点管理，RenderObject 能提供更底层控制。

性能关键不在于名字，而在于：

1. 是否减少不必要 layout；
2. 是否减少不必要 paint；
3. 是否避免 saveLayer；
4. 是否合理使用 RepaintBoundary；
5. 是否控制对象分配；
6. 是否避免昂贵 intrinsic 测量。

---

# 附录 D：RenderObject 调试技巧

## D.1 debugDumpRenderTree

可以打印 RenderObject 树：

```dart
debugDumpRenderTree();
```

## D.2 debugPaintSizeEnabled

显示布局边界：

```dart
import 'package:flutter/rendering.dart';

void main() {
  debugPaintSizeEnabled = true;
  runApp(const MyApp());
}
```

## D.3 Flutter Inspector

Flutter Inspector 可以查看：

1. Widget tree；
2. RenderObject 信息；
3. constraints；
4. size；
5. repaint rainbow；
6. layout boundary。

## D.4 Performance Overlay

可以观察：

1. UI thread；
2. raster thread；
3. frame budget；
4. 是否掉帧。

## D.5 Repaint Rainbow

可以观察哪些区域正在重绘。

如果某个静态区域一直闪，说明它可能被不必要地 repaint。

---

# 附录 E：最小实现模板

## E.1 LeafRenderObjectWidget 模板

```dart
class MyLeaf extends LeafRenderObjectWidget {
  const MyLeaf({super.key, required this.color});

  final Color color;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderMyLeaf(color: color);
  }

  @override
  void updateRenderObject(BuildContext context, RenderMyLeaf renderObject) {
    renderObject.color = color;
  }
}

class RenderMyLeaf extends RenderBox {
  RenderMyLeaf({required Color color}) : _color = color;

  Color _color;

  Color get color => _color;
  set color(Color value) {
    if (_color == value) return;
    _color = value;
    markNeedsPaint();
  }

  @override
  void performLayout() {
    size = constraints.constrain(const Size(100, 100));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    context.canvas.drawRect(offset & size, Paint()..color = color);
  }
}
```

## E.2 SingleChildRenderObjectWidget 模板

```dart
class MySingleChild extends SingleChildRenderObjectWidget {
  const MySingleChild({super.key, super.child});

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderMySingleChild();
  }
}

class RenderMySingleChild extends RenderProxyBox {
  RenderMySingleChild({RenderBox? child}) : super(child);

  @override
  void performLayout() {
    if (child == null) {
      size = constraints.smallest;
      return;
    }

    child!.layout(constraints, parentUsesSize: true);
    size = child!.size;
  }
}
```

## E.3 MultiChildRenderObjectWidget 模板

```dart
class MyMultiChild extends MultiChildRenderObjectWidget {
  const MyMultiChild({super.key, super.children});

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderMyMultiChild();
  }
}

class MyMultiParentData extends ContainerBoxParentData<RenderBox> {}

class RenderMyMultiChild extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, MyMultiParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, MyMultiParentData> {
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! MyMultiParentData) {
      child.parentData = MyMultiParentData();
    }
  }

  @override
  void performLayout() {
    double dy = 0;
    double maxWidth = 0;

    RenderBox? child = firstChild;
    while (child != null) {
      final MyMultiParentData childParentData =
          child.parentData! as MyMultiParentData;

      child.layout(constraints.loosen(), parentUsesSize: true);
      childParentData.offset = Offset(0, dy);

      dy += child.size.height;
      maxWidth = math.max(maxWidth, child.size.width);

      child = childParentData.nextSibling;
    }

    size = constraints.constrain(Size(maxWidth, dy));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    defaultPaint(context, offset);
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    return defaultHitTestChildren(result, position: position);
  }
}
```

---

# 结束语

RenderObject 是 Flutter 中最值得深入的主题之一。

它并不适合所有业务场景，但它解释了 Flutter UI 的真正运行方式。

当你能理解：

```text
Widget 如何变成 Element
Element 如何持有 RenderObject
RenderObject 如何 layout / paint / hitTest
Layer 如何参与合成
Engine 如何最终栅格化
```

你就不再只是“使用 Flutter 写页面”，而是在理解 Flutter 如何把声明式 UI 转换为真实屏幕像素。

这也是 Flutter 高阶开发者和普通业务开发者之间的重要分水岭。

