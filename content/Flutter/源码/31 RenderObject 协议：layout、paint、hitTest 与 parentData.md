# 31 RenderObject 协议：layout、paint、hitTest 与 parentData

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/object.dart`（6773 行）、`rendering/box.dart`（3388 行）

## 一、问题

写自定义 `RenderBox` 时，官方示例里总会出现这几个方法：`performLayout`、`paint`、`hitTest`、`setupParentData`。问题是：**它们各自由谁调用、约定是什么？**

错误直觉有两个：

1. **"我要自己管孩子的位置"** —— 于是把子节点的偏移存在自己的字段里。但框架依赖 `parentData` 来遍历孩子（`ContainerRenderObjectMixin` 的兄弟链就在 `BoxParentData` 里），自己另存一套会和框架失联。
2. **"`paint` 的 `offset` 是我算出来的"** —— 其实 `paint` 的 `offset` **是父传给你的**（父已经知道你在哪），你只负责"在 `offset` 处画自己，并把 `offset + 子偏移` 传给子"。

`RenderObject` 对子类只有三个契约，加上一个数据槽：

| 契约 | 谁调用 | 你返回什么 |
|---|---|---|
| `layout(Constraints, {parentUsesSize})` | 父 | 无返回，副作用是设置自己的尺寸并布局子 |
| `paint(PaintingContext, Offset)` | 父（或 `PaintingContext.repaintCompositedChild`） | 无返回，副作用是往 context 里画东西 |
| `hitTest(BoxHitTestResult, {position})` | 父 | `bool`，是否命中 |
| `parentData` | — | 不是契约，是父写子读的数据槽 |

第三个契约在 `RenderObject` 基类里**根本没有声明**——本节第四部分会证明这一点，它是"协议"而非"接口"。

## 二、最小 Demo

一个把孩子放在右下角的自定义容器。它把三件事都做全了：

```dart
import 'package:flutter/rendering.dart';

class RenderBottomRight extends RenderBox with RenderObjectWithChildMixin<RenderBox> {
  RenderBottomRight({RenderBox? child}) {
    this.child = child;   // 1. RenderObjectWithChildMixin 的 setter 内部会走 adoptChild
  }

  // 2. parentData 契约：声明"我的孩子用什么 parentData"
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! BoxParentData) {
      child.parentData = BoxParentData();
    }
  }

  @override
  bool get sizedByParent => true;   // 3. 尺寸只由约束决定，省掉一次往返
  @override
  Size computeDryLayout(BoxConstraints constraints) => constraints.biggest;

  @override
  void performLayout() {
    final BoxConstraints constraints = this.constraints;
    child?.layout(BoxConstraints.loose(size), parentUsesSize: true);  // 4. 约束向下传
    if (child != null) {
      final BoxParentData pd = child!.parentData! as BoxParentData;
      // 5. 位置由父决定：父把偏移写进孩子的 parentData
      pd.offset = Offset(size.width - child!.size.width, size.height - child!.size.height);
    }
  }

  @override
  void paint(PaintingContext context, Offset offset) {   // 6. offset 由父传入
    if (child != null) {
      final BoxParentData pd = child!.parentData! as BoxParentData;
      context.paintChild(child!, offset + pd.offset);    // 7. 叠加自己的偏移再传下去
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    if (child == null) {
      return false;
    }
    final BoxParentData pd = child!.parentData! as BoxParentData;
    // 8. 把父坐标系里的 position 转换到子坐标系，再问子是否命中
    return result.addWithPaintOffset(
      offset: pd.offset,
      position: position,
      hitTest: (BoxHitTestResult result, Offset transformed) {
        return child!.hitTest(result, position: transformed);
      },
    );
  }
}
```

`paint` 与 `hitTestChildren` 里那两行 `pd.offset` 是**同一个值**，一处用来画、一处用来命中。这就是 `parentData` 的核心作用——**让"子在哪"这件事只有一个真相来源**，且这个真相由父维护。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering/object.dart:2794` | `void layout(Constraints constraints, {bool parentUsesSize = false})`，唯一入口 |
| `rendering/object.dart:2847` | `_isRelayoutBoundary = !parentUsesSize \|\| sizedByParent \|\| constraints.isTight \|\| parent == null;` |
| `rendering/object.dart:2955` | `bool get sizedByParent => false;` 默认值 |
| `rendering/object.dart:2972` / `3001` | `void performResize();` / `void performLayout();` 两个抽象方法 |
| `rendering/object.dart:3612` | `void paint(PaintingContext context, Offset offset) {}` 空实现（文档在 `:3595`） |
| `rendering/object.dart:3964-3979` | hitTest 的**注释版协议**（基类里只有注释，没有方法） |
| `rendering/object.dart:2100` | `ParentData? parentData;` 字段本身 |
| `rendering/object.dart:2106` / `2175` | `setupParentData` 的定义与 `adoptChild` 里的调用点 |

表中只列追这条链的主入口；其余锚点随第四、六节的正文就近给出，不重复列。

## 四、调用链

### 4.1 layout：三段式

`RenderObject.layout` 不是简单调 `performLayout`。它按顺序做四件事：

```dart
// rendering/object.dart:2847-2867（节选）
_isRelayoutBoundary = !parentUsesSize || sizedByParent || constraints.isTight || parent == null;
if (!_needsLayout && constraints == _constraints) {
  return;                       // 1. 短路：不脏 + 约束没变 → 什么都不做
}
_constraints = constraints;     // 2. 记录本次约束
if (sizedByParent) {
  performResize();              // 3. 可选：只用约束算尺寸（不能碰孩子）
}
performLayout();                // 4. 主阶段：算尺寸 + 布局孩子
_needsLayout = false;
markNeedsPaint();               // 5. 布局完必然要重画
```

第 2 步的 `_constraints = constraints` 正是第 33 篇"约束向下"的落点；第 1 步的短路条件 `constraints == _constraints` 依赖 `BoxConstraints` 重写了 `==`（`box.dart:642`），逐字段比较四个值。

`sizedByParent = true` 时，`performResize` 里**绝对不能读孩子的尺寸**——因为此时孩子还没被布局。这条约束在 debug 下由 `size` getter 用 `_DebugSize` 检查（`box.dart:2250`），违反会直接报"RenderBox.size accessed beyond the scope of resize, layout, or permitted parent access"。

`layout` 的 `parentUsesSize` 参数是**父对子的声明**："我读了你的尺寸"。它的作用是决定脏传播的边界，这一点 32 篇展开。这里只需要记住：**调 `child.layout` 时读了 `child.size` 就必须传 `parentUsesSize: true`**，否则 debug 模式下 `child.size` 的 getter 会拒绝被父读取。

### 4.2 paint：offset 是父给的

基类里的 `paint` 是空实现：

```dart
// rendering/object.dart:3612
void paint(PaintingContext context, Offset offset) {}
```

注释里紧跟着说明它的定位（`object.dart:3595-3611`）：**`offset` 是从父坐标系原点指向自己坐标系原点的向量**。所以子类做的是"把 `offset` 当作自己的左上角，在此处画"。

孩子不能自己 `context.canvas` 直接画——必须通过 `context.paintChild(child, offset)`，因为这一步会做"是否需要新建 layer"的分支判断（`object.dart:249-267`）：

```dart
// rendering/object.dart:249-267（节选）
void paintChild(RenderObject child, Offset offset) {
  if (child.isRepaintBoundary) {
    stopRecordingIfNeeded();
    _compositeChild(child, offset);      // 子是 repaint boundary → 给它自己的 layer
  } else if (child._wasRepaintBoundary) {
    child._layerHandle.layer = null;     // 曾经是边界，现在不是 → 释放 layer
    child._paintWithContext(this, offset);
  } else {
    child._paintWithContext(this, offset);  // 普通情况：画进当前 PictureLayer
  }
}
```

`paint` 的契约里有一条隐含要求——**不要持有 `context.canvas` 跨过 `paintChild` 调用**。因为画孩子时 canvas 可能换掉（这正是第 35 篇的主题）。这个约束写在 `PaintingContext` 的类文档里（`object.dart:86-90`）。

### 4.3 hitTest：基类里只有注释

这一步最反直觉。`RenderObject` 基类里**没有** `hitTest` 方法，只有一段注释形式的协议：

```dart
// rendering/object.dart:3962-3979（节选）
// HIT TESTING
// RenderObject subclasses are expected to have a method like the following
// (with the signature being whatever passes for coordinates for this
// particular class):
//
// bool hitTest(HitTestResult result, { required Offset position }) {
//   // If the given position is not inside this node, then return false.
//   // Otherwise:
//   // For each child that intersects the position, in z-order starting from
//   // the top, call hitTest() for that child, passing it /result/, and the
//   // coordinates converted to the child's coordinate origin, and stop at
//   // the first child that returns true.
//   // Then, add yourself to /result/, and return true.
// }
```

三个信息量很大的点：

1. **签名由子协议决定**。注释里写的是"with the signature being whatever passes for coordinates for this particular class"——`RenderBox` 用 `Offset`，`RenderSliver` 用 `SliverHitTestResult`，所以基类无法统一定义。
2. **坐标转换的责任在父不在子**。"The caller is responsible for transforming `position`" 这句话写在 `RenderBox.hitTest` 的文档里（`box.dart:2899-2901`）。
3. **"add 自己但返回 false"是合法的**。注释末尾说这意味着"你会收到事件，但你下面的对象也会"，这是 `RenderOpacity` 透明度为 0 时仍参与命中的实现方式。

`RenderBox.hitTest` 的实现短到只有五行有效代码：

```dart
// rendering/box.dart:2952-2958
if (_size!.contains(position)) {
  if (hitTestChildren(result, position: position) || hitTestSelf(position)) {
    result.add(BoxHitTestEntry(this, position));
    return true;
  }
}
return false;
```

三个 `hitTest*` 的分工要用表说清：

| 方法 | 默认返回值 | 何时重写 |
|---|---|---|
| `hitTest` | 上面那段逻辑 | 极少重写；重写后必须自己处理 `result.add` |
| `hitTestChildren` | `false`（`box.dart:3001`） | 有孩子且孩子可命中时 |
| `hitTestSelf` | `false`（`box.dart:2975`） | 自己没有孩子但仍要响应事件（如 `RenderPointerListener`） |

`hitTestChildren(result, ...) || hitTestSelf(position)` 用的是 `||`，**短路求值**。所以当孩子命中时 `hitTestSelf` 根本不会被调用。这与 `paintChild` 的顺序无关：绘制是"从前到后"（`defaultPaint`，`box.dart:3364`），命中是"从后到前"（`defaultHitTestChildren`，`box.dart:3337` 从 `lastChild` 开始）。两者方向相反，因为"后画的在上面、应该先被点到"。

### 4.4 parentData 的生命周期

`parentData` 不是子的属性，是**父为子分配、父写子读**的槽位。它的完整生命周期只有三步：

```dart
// rendering/object.dart:2164-2184（adoptChild，节选）
void adoptChild(RenderObject child) {
  ...
  setupParentData(child);            // 1. 成为孩子时：父为子分配 parentData
  markNeedsLayout();
  markNeedsCompositingBitsUpdate();
  markNeedsSemanticsUpdate();
  child._parent = this;
  ...
}

// rendering/object.dart:2192-2201（dropChild，节选）
void dropChild(RenderObject child) {
  ...
  child.parentData!.detach();        // 2. 离开孩子列表时：parentData 自己清理
  child.parentData = null;           // 3. 槽位置空
  child._parent = null;
  ...
}
```

第 1 步走的是**可重写的 `setupParentData`**，并不直接 new。基类版本只保证"有 parentData 就行"：

```dart
// rendering/object.dart:2106-2111
void setupParentData(covariant RenderObject child) {
  assert(_debugCanPerformMutations);
  if (child.parentData is! ParentData) {
    child.parentData = ParentData();
  }
}
```

注意条件 `is! ParentData`：**已经是对的类型的父节点不会换掉 parentData**。这个细节很重要——`RenderFlex` 里"把一个孩子从 `Row` 挪到 `Stack`"（GlobalKey 搬运）时，孩子会带着旧的 `FlexParentData` 先被 `dropChild`（里面 `parentData = null`），再被新父 `adoptChild` 分配新的，所以类型冲突不会发生。

`ContainerRenderObjectMixin.insert` 用一条 assert 显式依赖了这条链路：

```dart
// rendering/object.dart:4495-4511（节选）
void insert(ChildType child, {ChildType? after}) {
  ...
  adoptChild(child);                  // ← 内部会调 setupParentData
  assert(
    child.parentData is ParentDataType,
    'A child of $runtimeType has parentData of type ${child.parentData.runtimeType}, '
    'which does not conform to $ParentDataType. Class using ContainerRenderObjectMixin '
    'should override setupParentData() to set parentData to type $ParentDataType.',
  );
  _insertIntoChildList(child, after: after);
}
```

`ContainerRenderObjectMixin` 的兄弟链存在 `ContainerBoxParentData` 里（`box.dart:976`），所以"重写了 `setupParentData` 却没设成 `ParentDataType` 的子类"会在这条 assert 上崩掉。写自定义多孩子 RenderObject 时，`setupParentData` 是必须重写的，不是可选的。

## 五、核心对象：三个契约方法的职责对比

| | `layout` | `paint` | `hitTest` |
|---|---|---|---|
| 定义位置 | `object.dart:2794`（基类有实现） | `object.dart:3612`（基类空实现） | 基类**只有注释**（`object.dart:3964`） |
| 谁调用 | 父 | 父或 `repaintCompositedChild` | 父 |
| 谁负责坐标转换 | 不涉及 | 父算好 `offset` 传进来 | **父**把 position 转成子坐标系 |
| 输入 | `Constraints` | `PaintingContext` + `Offset` | `BoxHitTestResult` + `Offset` |
| 输出 | 自己的 `size` + 孩子的位置 | 画进 context 的指令 | `bool` |
| 是否可跳过 | 可（约束未变且不脏时短路） | 可（未标脏则不重画） | 不可（每次事件都要走） |
| 前置要求 | 无 | 必须先完成 layout | 必须先完成 layout（不能依赖 paint） |
| 触发脏标记 | 结束时 `markNeedsPaint` | 无 | 无 |

`parentData` 的层级关系则是一张伞形表：

| 类 | 定义位置 | 提供什么 | 典型使用方 |
|---|---|---|---|
| `ParentData` | `object.dart:57` | 只有一个可重写的 `detach()` | 所有协议 |
| `BoxParentData` | `box.dart:963` | `Offset offset` | 所有单孩子 box |
| `ContainerBoxParentData` | `box.dart:976` | `BoxParentData` + `previousSibling`/`nextSibling` | 多孩子 box |
| `FlexParentData` | `flex.dart:126` | 继承上者，加 `flex` / `fit` | `RenderFlex` |
| `StackParentData` | `stack.dart:204` | 继承上者，加 `top/right/bottom/left/width/height` | `RenderStack` |

`BoxParentData` 只有 `offset` 一个字段。这说明 box 协议对"孩子在哪"的表达能力就到此为止——`FlexParentData` 的 flex 是**布局阶段的输入**，不是位置；布局完成后它就不再被读。位置信息统一归 `offset`。

## 六、源码实验

### 实验 1：证明 `hitTest` 只是协议而非接口

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -n "bool hitTest" object.dart
```

**预测**：如果基类声明了 `hitTest`，应该能看到一行 `bool hitTest(HitTestResult result, ...);`。

**实际**：唯一命中是 `object.dart:3968`，位于一段 `//` 注释里（`// bool hitTest(HitTestResult result, { required Offset position }) {`）。

**说明**：这是"协议 vs 接口"的教科书案例。**框架无法用类型系统强制你实现 `hitTest`**——因为签名由子协议（box / sliver）决定。同样的模式还有 `applyPaintTransform`，它在基类里是空实现（`object.dart:3627`），在 `RenderBox` 里也是空实现（`box.dart:3014`），只有真正应用变换的子类（如 `RenderTransform`）才重写。

### 实验 2：`setupParentData` 是被重写最多的"协议方法"

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn --include="*.dart" "void setupParentData(" . | wc -l    # 37
grep -rn --include="*.dart" "setupParentData(" . | grep -v "void setupParentData("
```

**预测**：37 个重写很多，但"谁调用它"应该只有少数几处。

**实际**：调用点只有 3 处——

```text
rendering/object.dart:2175   adoptChild 里（框架唯一的主调用点）
rendering/object.dart:4509   一条 assert 的错误消息文本里（提到名字，不是调用）
widgets/table.dart:316       renderObject.setupParentData(child)（Table 的手动预分配）
```

**说明**：`rendering/object.dart:2106` 的注释里提到的"可以在孩子加入前先调 `setupParentData`"，在框架内只有 `widgets/table.dart:316` 一处真的这么用。**结论：写自定义 RenderObject 时不需要手动调 `setupParentData`，`adoptChild` 会调。**

### 实验 3：验证 paint 与 hitTest 的方向相反

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -n "ChildType? child = lastChild" box.dart    # defaultHitTestChildren
grep -n "ChildType? child = firstChild" box.dart   # defaultPaint
```

**预测**：一个从 `lastChild` 开始，一个从 `firstChild` 开始。

**实际**：`box.dart:3338` 是 `ChildType? child = lastChild;`（hitTest），`box.dart:3365` 是 `ChildType? child = firstChild;`（paint）。

**说明**：这两个方法在 `box.dart` 里相隔 27 行，正好是"从后往前命中、从前往后绘制"的对照。如果你的自定义 RenderObject 重写了 `paint`（比如改变了绘制顺序），就**必须同步重写 `hitTestChildren`**，否则点到的对象和看到的对象不一致。

### 实验 4：确认 `offset` 的真相来源是父

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -n "parentData! as BoxParentData" box.dart proxy_box.dart | head -8
```

**预测**：如果子节点自己管位置，应该能在子的 `paint` 里看到写 `offset` 的代码。

**实际**：命中的都是 `parentData!.offset` 的**读**操作，集中在 `defaultPaint`、`defaultHitTestChildren`、`RenderShiftedBox` 的子类里（`shifted_box.dart:94` 的 `paint`、`shifted_box.dart:103` 的 `hitTestChildren`）；写操作只出现在各父节点的 `performLayout` 中（如 `stack.dart:565` 的 `childParentData.offset = Offset(x, y);`、`flex.dart:1386`）。

**说明**：这就是第 33 篇结论"位置由父决定"的源码依据——`offset` 的**唯一写方**是父的 `performLayout`，读方是 `paint` 和 `hitTestChildren`。

## 七、结论

1. `RenderObject` 对子类只有三个契约：`layout`（父调用、你设置尺寸）、`paint`（父调用并传入 `offset`）、`hitTest`（父调用并做坐标转换）。其中 `hitTest` 在基类里**只有注释没有方法**，因为它的签名由 box / sliver 子协议各自决定。
2. `parentData` 是**父为子分配、父写、可能被读**的数据槽。它在 `adoptChild` 里通过可重写的 `setupParentData` 分配（`object.dart:2106` / `2175`），在 `dropChild` 里 `detach()` 并置空（`object.dart:2192-2201`）。`BoxParentData` 只表达 `offset` 一件事，位置信息因此只有一个真相来源。
3. 同一个 `offset` 被 `paint` 和 `hitTestChildren` 共用，但遍历方向相反：绘制从 `firstChild` 到 `lastChild`（`box.dart:3365`），命中从 `lastChild` 到 `firstChild`（`box.dart:3338`）。重写了其中一个就必须检查另一个。

**RenderObject 的协议是"父给约束与偏移、子还尺寸与绘制"，`parentData` 是这条协议上唯一的数据通道。**

## 八、边界声明

- `adoptChild` / `dropChild` / `redepthChild` 的树骨架细节已在 03 篇讲透，本文只讲 `setupParentData` 在其中的位置，不重复展开。
- `layout` 的 `parentUsesSize` 如何形成 `relayoutBoundary`、`markNeedsLayout` 如何向上传播，交给 32 篇。
- `BoxConstraints` 各方法的语义交给 33 篇；本文 Demo 里用到的 `constraints.biggest` / `loose` 只按字面使用。
- paint 如何生成 Layer、`paintChild` 里那三个分支的意义，交给 35 篇。
- `applyPaintTransform` 与坐标变换矩阵（`Matrix4`）的数学细节不展开，只在 35 篇讲 `TransformLayer` 时提及。
- 本文只补充 RenderObject 协议的定义位置、调用者与源码坐标，不展开自定义 RenderObject 的实战写法。
