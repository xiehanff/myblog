# 30 rendering 层地图与三棵树总览

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering`

## 一、问题

`rendering` 是 framework 里最核心的一层，也是最大的一层：**48 个文件、51955 行**（用 `wc -l` 数得），比 foundation 大 4.5 倍。

问题不是"它太大"，而是：**Widget / Element / RenderObject 这三棵树，到底谁负责什么？RenderObject 挂在哪棵树上？**

错误直觉是"Widget 树 = 界面结构，Element 树 = 中间产物，RenderObject 树 = 同样的结构再存一份"。按这个直觉，你会以为三者是同一棵树的三个副本、节点一一对应。

实际上三者的**节点数量不对应**：`Container`、`StatelessWidget` / `StatefulWidget` 这类**组合型** Widget 会有自己的 Element，但**不单独创建 RenderObject**（`Container` 只是把 `Padding` / `DecoratedBox` / `ConstrainedBox` 等组合起来，RenderObject 由叶子上的那些 RenderObjectWidget 各自创建）。注意 `Padding` 和 `Center` **不属于**这一类——它们虽然看起来"只是影响约束"，实际上都是 `SingleChildRenderObjectWidget`：`Padding` 创建 `RenderPadding`（`widgets/basic.dart:2309`），`Center` 继承 `Align`（`:2550`）、经 `Align.createRenderObject` 创建 `RenderPositionedBox`（`:2504`）。反过来一个 `RenderFlex` 会同时产生一个 RenderObject 和 N 个 `FlexParentData`。

**关键认知**：三棵树的分工是"配置 / 身份 / 计算"。Widget 是配置（不可变、每次 build 都可能换新），Element 是身份（常驻、决定复用谁），RenderObject 是计算（持有 size、offset、layer，真正干活）。前两者在 `widgets` 层，第三者在本层——而这正是 rendering 存在的理由：**它不关心你的 Widget 怎么写，只关心"给我约束、我给你尺寸"**。

## 二、最小 Demo

`rendering` 层可以脱离 Widget 单独用。下面这段不 import `widgets.dart`，只用手写 RenderBox 画出两个色块：

```dart
import 'package:flutter/rendering.dart';

// 1. 一个只负责画自己、不接收孩子的叶子节点
class RenderDot extends RenderBox {
  RenderDot({required this.color, required this.radius});

  final Color color;
  final double radius;

  // 2. 叶子节点尺寸只由约束决定 → sizedByParent 让 layout 免去一次 performLayout 往返
  @override
  bool get sizedByParent => true;

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    // 3. 尺寸 = 约束和自己想要的尺寸取交，这就是"约束向下"
    return constraints.constrain(Size.square(radius * 2));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    // 4. offset 由父决定，自己只管在 offset 处画 → "位置由父决定"
    context.canvas.drawCircle(offset + Offset(radius, radius), radius, Paint()..color = color);
  }
}
```

把它挂到一个 `RenderView` 上需要手动建 `PipelineOwner`，代码量偏大；更常见的做法是给它写一个 `RenderObjectWidget`，然后用普通 App 跑起来。本系列后续几篇的 Demo 都走这条更短的路。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering.dart:38-85` | 整个层的对外面：48 行 export，**把 48 个文件全部导出** |
| `rendering/object.dart:2003` | `abstract class RenderObject with DiagnosticableTreeMixin implements HitTestTarget` |
| `rendering/object.dart:1019` | `base class PipelineOwner`，脏节点收集者 |
| `rendering/object.dart:902` | `abstract class Constraints`，layout 的输入契约 |
| `rendering/box.dart:100` | `class BoxConstraints extends Constraints` |
| `rendering/box.dart:1572` | `abstract class RenderBox extends RenderObject` |
| `rendering/layer.dart:144` | `abstract class Layer with DiagnosticableTreeMixin`，合成树 |
| `rendering/binding.dart:642` | `drawFrame()`，一帧里 layout / 合成位 / paint 的顺序 |

表中只列追这条链的主入口；其余锚点随第四、六节的正文就近给出，不重复列。

## 四、调用链

### 4.1 48 个文件怎么分区

先把地图建起来。按职责分五区（行数是本地实测）：

```text
骨架        11 文件  15965 行   object / box / layer / binding / view / debug ...
盒子族      17 文件  15762 行   proxy_box / shifted_box / flex / stack / wrap / table ...
sliver 族   16 文件  11675 行   sliver / viewport / sliver_grid / sliver_list ...
文本与编辑   3 文件   7703 行   paragraph / editable / selection
平台视图     1 文件    850 行   platform_view
```

**关键认知**：骨架区只有 11 个文件，但它是**唯一必须顺序读的部分**。盒子族和 sliver 族是"骨架的两个具体协议"——前者假设尺寸是 `Size`，后者假设尺寸是 `SliverGeometry`。文本与编辑占 15% 的行数，但它是 `RenderBox` 协议的一个特例，不影响主干。

两个数字值得记住：`object.dart` 6773 行、`box.dart` 3388 行，两者合计 10161 行，占本层 20%，但**本卷 30–35 篇有 5 篇在讲这两个文件**。

### 4.2 RenderObject 的诞生与挂载

RenderObject **不是** Widget 直接 new 出来的。链路的起点在 `RenderObjectElement.mount`：

```dart
// widgets/framework.dart:6784-6801（节选）
void mount(Element? parent, Object? newSlot) {
  super.mount(parent, newSlot);                                  // 1. Element 先入树（03 篇的 depth/owner）
  _debugDoingBuild = true;
  _renderObject = (widget as RenderObjectWidget).createRenderObject(this);  // 2. 造 RenderObject
  _debugDoingBuild = false;
  attachRenderObject(newSlot);                                   // 3. 挂进 render 树
  super.performRebuild();
}
```

第 3 步 `attachRenderObject` 分两条路：如果当前 Element 是 render 树的根（`RawView` 的 `_RawViewElement`），就直接把 RenderObject 设成 `PipelineOwner.rootNode`；否则找到最近的 `RenderObjectElement` 祖先，由它把新的 RenderObject 插进自己的 RenderObject 的孩子列表（列表插入最终会走到 `adoptChild`）:

```dart
// widgets/view.dart:499-505（节选，render 树的根）
void mount(Element? parent, Object? newSlot) {
  super.mount(parent, newSlot);
  _effectivePipelineOwner.rootNode = renderObject;   // ← 根节点在这里挂上 owner
  _attachView();
  _updateChild();
  renderObject.prepareInitialFrame();                 // ← 调度第一次 layout + paint
}
```

`rootNode` 的 setter 只有三行，但它决定了整棵树的归属：

```dart
// rendering/object.dart:1079-1086
set rootNode(RenderObject? value) {
  if (_rootNode == value) return;
  _rootNode?.detach();      // 老根脱开
  _rootNode = value;
  _rootNode?.attach(this);  // 新根连带整棵子树 attach(this)
}
```

**关键认知**：`RenderObject.owner` 不是自己去申请来的，是**从根往下递归传下去的**。`attach(PipelineOwner owner)` 把 `_owner` 设为传入值，子类重写时再对每个孩子调 `child.attach(owner)`（如 `RenderObjectWithChildMixin.attach`，`object.dart:4223`）。所以"同一棵 render 树上的所有节点，owner 一定是同一个对象"是结构保证，不是约定。

### 4.3 一帧的顺序

`RendererBinding.drawFrame` 是整个渲染管线的顺序声明，只有 4 行有效代码：

```dart
// rendering/binding.dart:642-653
void drawFrame() {
  rootPipelineOwner.flushLayout();            // 1. 布局：脏 RenderObject 重算 size/offset
  rootPipelineOwner.flushCompositingBits();   // 2. 合成位：重算 needsCompositing
  rootPipelineOwner.flushPaint();             // 3. 绘制：生成 Layer 树
  if (sendFramesToEngine) {
    for (final RenderView renderView in renderViews) {
      renderView.compositeFrame();            // 4. 合成：Layer 树 → Scene → GPU
    }
    rootPipelineOwner.flushSemantics();       // 5. 语义：生成 SemanticsNode 树
  }
}
```

顺序不能换：布局必须发生在绘制之前（否则画的是过期尺寸），合成位必须发生在绘制之前（否则 `paintChild` 会走错分支），绘制必须发生在合成之前（否则 Scene 里没有内容）。第 32 篇和第 35 篇分别展开 1/2/3 步的细节。

**关键认知**：这 5 步是**全局的阶段顺序**，不是"每个 View 各自跑完整条链路"。`drawFrame` 只调 `rootPipelineOwner` 的 `flushXxx`；每个 `flushXxx` 先清完**自己**的脏表，末尾才 `for (final PipelineOwner child in _children) child.flushXxx();` 递归子 owner（`object.dart:1186` / `:1250` / `:1334` / `:1652`）。所以多 View 场景恰恰是**"所有 View 的 layout 都做完（root 及其全部子 owner），才开始 compositing bits；所有 compositing bits 做完才开始 paint"**——阶段之间由 `drawFrame` 切换，owner 树只决定同一阶段内的处理顺序（root 先、子 owner 后）。子 owner 树由 `View` 建立：`_RawViewElement._attachView` 用 `View.pipelineOwnerOf(context)` 找到父 owner（无 `View` 祖先时是 `rootPipelineOwner`）并 `adoptChild`（`widgets/view.dart:198` / `:512-517`）。唯一不走 owner 递归的是第 4 步 `compositeFrame`——它按 `renderViews` 列表逐个 View 把 Layer 树交给引擎。

### 4.4 Widget 树的 build 与 render 树的 layout 谁先谁后

一帧里 `WidgetsBinding.drawFrame` 先调 `buildOwner.buildScope`，再调 `super.drawFrame()`（即上面的 `RendererBinding.drawFrame`）。所以顺序是：

```text
build（Widget → Element → 可能更新 RenderObject 配置）
   ↓
layout（RenderObject 算尺寸）
   ↓
compositing bits → paint（RenderObject 生成 Layer）
   ↓
composite（Layer → Scene）
```

这解释了一个高频困惑："为什么在 `build` 里读不到 `RenderBox.size`？"——因为 build 阶段 layout 还没发生，此时 `size` 是上一帧的值甚至是空。

## 五、核心对象：三棵树与两个 owner

| | Widget | Element | RenderObject |
|---|---|---|---|
| 定义位置 | `widgets/framework.dart` | `widgets/framework.dart` | `object.dart:2003` |
| 可变性 | 不可变（配置） | 可变（持有状态与生命周期） | 可变（持有 size / offset / layer） |
| 数量 | 每次 build 换新 | 常驻 | 可能少于 Element |
| 父指针 | 无 | 私有 `_parent`（03 篇） | 公开 `parent` |
| 归属 | 无 owner 概念 | `BuildOwner` | `PipelineOwner` |
| 数量与 Element 的关系 | 1 Widget → 0/1/N Element | — | 1 Element → 0/1/N RenderObject |
| 谁创建 | 业务代码 | `inflateWidget` | `RenderObjectElement.createRenderObject` |

两个 owner 的分工也必须分清：

| | `BuildOwner`（widgets 层） | `PipelineOwner`（本层） |
|---|---|---|
| 收集什么 | 脏 `Element` | 脏 `RenderObject` |
| 脏列表 | `_dirtyElements` | `_nodesNeedingLayout` / `_nodesNeedingPaint` / ... |
| 排序依据 | `Element._sort` 按 `depth` | 按 `depth`（layout 升序、paint 降序） |
| 驱动阶段 | build | layout / compositing bits / paint / semantics |

**关键认知**：两张 owner 表不是"同一个机制的两份实现"。`BuildOwner` 的脏表是用来**重建 Widget 配置**的，`PipelineOwner` 的脏表是用来**重算几何**的。二者之间靠 `RenderObjectElement.update` 里"读取新 Widget 的字段、写入 RenderObject"这一步连接。

## 六、源码实验

### 实验 1：确认 rendering 没有"隐藏文件"

```bash
cd /Users/hax/fvm/default/packages/flutter/lib
find src/rendering -name '*.dart' | wc -l          # 48
grep -c "^export 'src/rendering/" rendering.dart   # 48
grep -c "^export" rendering.dart                   # 51
```

**预测**：如果 rendering 像 foundation 那样有"门面 / 实现"之分，导出行数应该明显小于文件数。

**实际**：48 对 48，**完全相等**。另外 3 行 export 分别指向 `foundation`（只挑 5 个符号）、`semantics` 和 `vector_math_64`。

**说明**：这是 rendering 与 foundation 的一个结构性差异（对比 01 篇的实验 2：foundation 42 个文件只有 29 个被导出）。rendering 是"全部公开"的层——因为自定义 RenderObject 是用户会直接做的事，而 foundation 的下划线文件是平台分叉的实现细节。

### 实验 2：`isRepaintBoundary` 是类级别属性，框架自己就在用

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn --include="*.dart" "bool get isRepaintBoundary => true" .
```

**预测**：如果"RepaintBoundary 是用户手动加的"，那这条 grep 应该只命中 `proxy_box.dart` 里的 `RenderRepaintBoundary`。

**实际**：14 条命中，分布在 11 个文件里：

```text
rendering/view.dart:315              RenderView
rendering/proxy_box.dart:3491        RenderRepaintBoundary
rendering/viewport.dart:752          RenderViewport
rendering/editable.dart:2749         RenderEditable
rendering/list_wheel_viewport.dart:511
rendering/flow.dart:267
rendering/platform_view.dart:152 / 329 / 738
rendering/texture.dart:86
widgets/single_child_scroll_view.dart:429
widgets/two_dimensional_viewport.dart:807
cupertino/text_selection_toolbar.dart:243
```

**说明**：`RenderViewport`（也就是所有 `ListView` / `SingleChildScrollView` 的视口）**自带 repaint boundary**。所以"页面上除了我写的 `RepaintBoundary` 之外没有别的边界"是错的——滚动区域天然就是边界。这条结论直接决定了第 35 篇要回答的问题（在 `ListView` 里再加一层 `RepaintBoundary` 往往只是多一层）。

### 实验 3：`owner` 的传播是"父递归传给孩子"

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -rn --include="*.dart" "\.attach(owner)" . | wc -l    # 31
grep -rn --include="*.dart" "child.attach(owner)" . | head
```

**预测**：如果 owner 是由每个节点自己去申请/查表的，源码里应该出现类似 `findOwner()` 的调用。

**实际**：31 处 `attach(owner)` 命中，全是 `super.attach(owner)` 和 `child.attach(owner)` 两种形态。单孩子版本的 `RenderObjectWithChildMixin` 最短，只有三行：

```dart
// rendering/object.dart:4222-4226
@override
void attach(PipelineOwner owner) {
  super.attach(owner);
  _child?.attach(owner);
}
```

**说明**：整个 SDK 里没有"向上找 owner"的代码。`owner` 是**从 `rootNode` 向下推**的（`object.dart:1085` 的 `_rootNode?.attach(this)` 是起点），所以同树同 owner 是结构保证。若发现两个同树节点的 `owner` 不同，唯一可能是中间隔着一个 `View`——`widgets/view.dart:513` 的 `_attachView` 会为新 `PipelineOwner` 调 `adoptChild`，形成 owner 的父子树。

## 七、结论

1. 三棵树的分工是**配置 / 身份 / 计算**：Widget 是每次 build 都可能换新的配置，Element 是决定复用谁的身份，RenderObject 是持有 size / offset / layer 的计算者。三者节点数量不对应——组合型 Widget（`Container`、`StatelessWidget` / `StatefulWidget`）有 Element 但不单独创建 RenderObject；`Padding`、`Center` 这类 RenderObjectWidget 则是 Element 与 RenderObject 一一对应（`RenderPadding` / `RenderPositionedBox`）。
2. `RenderObject` 由 `RenderObjectElement.mount` 里的 `createRenderObject` 创建（`widgets/framework.dart:6790`），`owner` 从 render 树的根开始通过 `attach(PipelineOwner)` 递归下发。因此"同一棵 render 树的节点共用一个 `PipelineOwner`"是结构保证。
3. `RendererBinding.drawFrame`（`rendering/binding.dart:642`）写死了一帧的 5 步顺序：layout → compositing bits → paint → composite → semantics。每个 `flushXxx` 会先处理自己的脏表，再递归处理子 `PipelineOwner`。

一句话总结：**rendering 层是"给我约束、还你尺寸和图层"的计算层，它的入口是 `PipelineOwner`，它的输出是 Layer 树。**

## 八、边界声明

- 本篇只做分区和总览。RenderObject 的 layout / paint / hitTest 三个契约在 31 篇，脏传播在 32 篇，约束模型在 33 篇，`RenderFlex` 在 34 篇，Layer 与合成在 35 篇。
- `element` / `depth` / `owner` 的树骨架细节已在 03 篇讲透，本篇不重复。
- sliver 族（`sliver.dart` 2119 行、`viewport.dart` 2261 行）本篇只做分区，不展开；`Scrollable` / `Viewport` / 懒加载留到第十卷。
- 文本与编辑（`paragraph.dart` / `editable.dart` / `selection.dart`，合计 7703 行）不在本卷展开，它依赖 `painting` 层的 `TextPainter`。
- 引擎侧（`ui.SceneBuilder` 之后的部分、Impeller / Skia）不追，只在 35 篇讲到 Scene 生成为止。
- 本篇只给出 `PipelineOwner` 在 rendering 层内的坐标，机制细节交给 32 篇。
