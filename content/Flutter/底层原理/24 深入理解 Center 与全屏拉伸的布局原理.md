# 深入理解 Flutter 组件全屏拉伸与 Center 组件的布局原理

[toc]

## 前言

在 Flutter 开发中，几乎所有初学者都会遇到一个经典的困惑：**明明给 Widget 设置了固定的 width 和 height，它却被强制拉伸填满了整个屏幕；而只要用 Center 组件包裹一下，宽高就立刻生效了**。

这个现象并非 Flutter 的 “bug”，而是其**约束驱动（Constraint-Driven）** 布局模型的必然结果。本文将从底层原理出发，彻底拆解这个现象的本质，帮你彻底掌握 Flutter 布局的核心逻辑。

## 一、Flutter 布局的核心黄金法则

Flutter 的整个布局体系，都围绕着一条官方定义的**黄金三原则**运行，这是理解所有布局行为的根基：

> 1. **约束向下传递（Constraints go down）**：父组件向子组件传递约束规则（BoxConstraints），子组件必须遵守该规则
> 2. **尺寸向上传递（Sizes go up）**：子组件在父级约束范围内确定自身最终尺寸，并将该尺寸回传给父组件
> 3. **父级决定位置（Parent sets position）**：子组件无法决定自己在屏幕中的位置，最终位置由父组件决定

简单来说：**父组件说了算 “你能长多大”，子组件说了算 “我具体长多大”，最终位置还是父组件说了算**。子组件设置的宽高，永远无法脱离父组件传递的约束单独生效。

而承载约束规则的核心，就是`BoxConstraints`类，它包含 4 个核心属性：

| 属性        | 含义                 |
| :---------- | :------------------- |
| `minWidth`  | 子组件允许的最小宽度 |
| `maxWidth`  | 子组件允许的最大宽度 |
| `minHeight` | 子组件允许的最小高度 |
| `maxHeight` | 子组件允许的最大高度 |

## 二、紧约束 vs 松约束：核心概念拆解

Flutter 中所有的布局异常，几乎都源于对**紧约束（Tight Constraints）** 和**松约束（Loose Constraints）** 的理解偏差，这也是解释 “全屏拉伸” 现象的核心钥匙。

### 2.1 紧约束（Tight Constraints）

**定义**：当`minWidth == maxWidth` 且 `minHeight == maxHeight`时，该约束为紧约束。

**人话翻译**：父组件给子组件下达了 “死命令”—— 你必须刚好长这么大，没有任何选择空间。

**核心特点**：子组件设置的任何宽高都将失效，只能严格按照父级给定的固定尺寸渲染。

最典型的紧约束，就是根 RenderView 给根 Widget（`runApp`传入的 Widget）传递的约束：**minWidth = maxWidth = 屏幕宽度，minHeight = maxHeight = 屏幕高度**（约束数值源自引擎提供的屏幕尺寸，普通全屏场景下 min 与 max 相等）。

### 2.2 松约束（Loose Constraints）

**定义**：当`minWidth == 0` 且 `minHeight == 0`，仅限制最大宽高时，该约束为松约束。

**人话翻译**：父组件给子组件划定了 “上限”—— 你可以长到任意大小，但不能超过我给的最大尺寸，最小可以是 0。

**核心特点**：子组件可以自由决定自身的尺寸，只要不超过父级给定的最大值，自身设置的宽高可以正常生效。

### 2.3 核心区别对照表

| 约束类型 | 核心规则               | 子组件宽高是否生效     | 典型场景                               |
| :------- | :--------------------- | :--------------------- | :------------------------------------- |
| 紧约束   | 固定尺寸，必须严格遵守 | 完全失效               | 根布局、SizedBox.expand、全屏 PageView |
| 松约束   | 仅限制上限，尺寸自由   | 在最大值范围内完全生效 | Center、Align、Scaffold 的 body 区域   |

## 三、为什么组件会被强制拉伸到屏幕尺寸？

理解了紧约束的概念，这个问题的答案就非常清晰了：**你的组件被父级传递了**屏幕尺寸的紧约束 **，只能被迫填满整个屏幕 **。

下面我们拆解最常见的 3 种场景，看清楚约束传递的完整链路。

### 3.1 场景 1：根布局直接传入带固定宽高的 Widget

这是初学者最常踩的坑，示例代码：

```dart
import 'package:flutter/material.dart';

void main() {
  // 直接给runApp传入设置了100x100宽高的Container
  runApp(Container(width: 100, height: 100, color: Colors.red));
}
```

**运行结果**：Container 完全填满了整个屏幕，100x100 的宽高完全失效。

**约束传递链路解析**：

1. 渲染树根节点 RenderView 给根 Widget（Container）传递了**屏幕尺寸的紧约束**：`BoxConstraints(minWidth=屏幕宽, maxWidth=屏幕宽, minHeight=屏幕高, maxHeight=屏幕高)`
2. Container 收到了这个紧约束，哪怕自身设置了 100x100 的宽高，也必须遵守父级的 “死命令”，只能被迫填满整个屏幕
3. Container 将自己的最终尺寸（屏幕尺寸）回传给引擎，完成布局

### 3.2 场景 2：父组件传递了全屏紧约束

除了根布局，很多容器组件也会给子组件传递紧约束，比如：

```dart
SizedBox.expand(
  // 这里的SizedBox.expand会给子Container传递全屏紧约束
  child: Container(width: 100, height: 100, color: Colors.blue),
)
```

`SizedBox.expand`相当于把 width/height 设为 double.infinity，它对应的 RenderConstrainedBox 会把 `BoxConstraints.tightFor(width: infinity, height: infinity)` 用`enforce`夹到父级约束范围内（源码：`child!.layout(_additionalConstraints.enforce(constraints), ...)`）。只要父级约束有界，结果就是"min = max = 父级最大尺寸"的紧约束，因此子 Container 依然会被强制拉伸，无法使用自身设置的宽高。

### 3.3 场景 3：Row/Column 交叉轴的紧约束（CrossAxisAlignment.stretch）

Row 和 Column（Flex 组件）给子组件传递的约束，由 `crossAxisAlignment` 决定：

- Column（垂直布局）：默认的 `CrossAxisAlignment.center`（以及 `start`/`end`）在交叉轴（水平方向）传递的是**松约束**（0 ~ Column 宽度），子组件的宽度设置可以生效；只有设置 `CrossAxisAlignment.stretch` 时，才会传递 `minWidth = maxWidth = Column 宽度` 的**紧约束**，强制子组件撑满整个交叉轴
- Row（水平布局）：同理，`CrossAxisAlignment.stretch` 会让交叉轴（垂直方向）传递 `minHeight = maxHeight = Row 高度` 的紧约束

示例代码：

```dart
void main() {
  runApp(
    Column(
      // stretch让交叉轴（水平）给Container传递屏幕宽度的紧约束
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(width: 100, height: 100, color: Colors.green),
      ],
    )
  );
}
```

**运行结果**：Container 的高度 100 生效了，但宽度被拉伸到了整个屏幕宽度，就是因为 Column 交叉轴在 stretch 模式下的紧约束（对应源码 `RenderFlex._constraintsForNonFlexChild` 中 `BoxConstraints.tightFor(width: constraints.maxWidth)` 分支）。

## 四、为什么 Center 包裹后就能解决问题？

Center 组件的核心作用，就是**打破父级的紧约束链条，给子组件传递松约束**，让子组件可以自由决定自身的尺寸。

### 4.1 Center 的本质与布局行为

Center 是`Align`组件的子类，是一个专门用于居中布局的特化组件，它的核心布局逻辑分为两步：

1. **自身尺寸处理**：Center 会先遵守父级传递的约束，尽可能撑满父级给的空间（比如父级给了全屏紧约束，Center 就会填满整个屏幕）
2. **约束传递处理**：Center 给子组件传递的是**松约束**——`BoxConstraints(minWidth=0, maxWidth=父级最大宽度, minHeight=0, maxHeight=父级最大高度)`

### 4.2 完整约束链路解析（核心）

我们用最经典的示例，看清楚 Center 包裹前后的约束变化：

```dart
void main() {
  runApp(
    Center(
      child: Container(width: 100, height: 100, color: Colors.red),
    )
  );
}
```

**约束传递完整链路**：

1. 渲染树根节点 RenderView 给根 Widget（Center）传递**屏幕尺寸的紧约束**：必须填满整个屏幕
2. Center 遵守父级约束，将自身尺寸设为屏幕大小，同时给子 Container 传递**松约束**：你可以长到任意大小，但不能超过屏幕尺寸
3. Container 收到松约束后，自身设置的 100x100 宽高完全在约束范围内，因此最终尺寸就是 100x100
4. Container 将 100x100 的尺寸回传给 Center
5. Center 收到子组件的尺寸后，按照自身的`alignment: Alignment.center`规则，将 Container 放在屏幕的正中心
6. 布局完成，Container 正常显示 100x100 的尺寸，不会被拉伸

这就是 Center 能解决全屏拉伸问题的核心本质：**它自己扛下了父级的紧约束，给子组件开放了松约束的自由空间**。

### 4.3 Center 的关键特性补充

- 当`widthFactor`或`heightFactor`不为 null 时，Center 的尺寸会跟随子组件变化：比如`widthFactor: 2`，Center 的宽度会是子组件宽度的 2 倍
- Center 不会修改父级传递的约束上限，子组件如果设置的尺寸超过屏幕大小，依然会被限制在屏幕范围内
- Center 和 Align 的唯一区别，就是`alignment`属性固定为`Alignment.center`，其余布局逻辑完全一致

## 五、常见场景实战案例与代码解析

### 案例 1：根布局 Container 全屏拉伸问题

**错误代码**（全屏拉伸）：

```dart
runApp(Container(width: 200, height: 200, color: Colors.red));
```

**修复代码**（Center 包裹，宽高生效）：

```dart
runApp(Center(
  child: Container(width: 200, height: 200, color: Colors.red),
));
```

### 案例 2：Column 交叉轴拉伸问题

**错误代码**（crossAxisAlignment 为 stretch 时宽度被拉伸到全屏）：

```dart
runApp(Column(
  // stretch模式下，交叉轴给子组件传递屏幕宽度的紧约束
  crossAxisAlignment: CrossAxisAlignment.stretch,
  children: [
    Container(width: 100, height: 100, color: Colors.blue),
  ],
));
```

**修复代码 1**（Center 包裹子组件，限制宽度）：

```dart
runApp(Column(
  crossAxisAlignment: CrossAxisAlignment.stretch,
  children: [
    Center(
      child: Container(width: 100, height: 100, color: Colors.blue),
    ),
  ],
));
```

**修复代码 2**（去掉 stretch，让交叉轴传递松约束）：

```dart
runApp(Column(
  // center/start/end（默认center）在交叉轴都传递松约束，只有stretch传紧约束
  crossAxisAlignment: CrossAxisAlignment.start,
  children: [
    Container(width: 100, height: 100, color: Colors.blue),
  ],
));
```

### 案例 3：ListView 内组件尺寸失效问题

ListView 会给子组件传递**宽度方向的紧约束**（和 ListView 宽度一致），因此子组件的宽度设置会失效，解决方案是用 Center/Align 包裹：

```dart
ListView(
  children: [
    // 直接写Container，宽度会被拉伸到ListView全屏宽度
    Center(
      // Center包裹后，Container的200宽度正常生效
      child: Container(width: 200, height: 100, color: Colors.green),
    )
  ],
)
```

## 六、同类布局组件对比与避坑指南

### 6.1 常用松约束传递组件对比

| 组件             | 核心作用         | 约束传递特点                           | 适用场景                                         |
| :--------------- | :--------------- | :------------------------------------- | :----------------------------------------------- |
| Center           | 子组件居中       | 传递松约束，固定居中对齐               | 绝大多数需要固定宽高、居中显示的场景             |
| Align            | 子组件自定义对齐 | 传递松约束，可自定义对齐方式           | 需要子组件居左 / 居右 / 居下等非居中场景         |
| UnconstrainedBox | 完全解除父级约束 | 传递无上限的松约束，允许子组件超出父级 | 需要子组件突破父级尺寸限制的场景（会有溢出警告） |
| ConstrainedBox   | 自定义约束范围   | 给子组件叠加自定义的约束规则           | 需要限制子组件最大 / 最小宽高的场景              |

### 6.2 常见紧约束传递组件

这些组件会给子组件传递紧约束，使用时需要注意子组件的宽高失效问题：

- `SizedBox.expand()` / `SizedBox.shrink()`（后者给子组件传递 0x0 的紧约束）
- `ListView` / `PageView` / `GridView` 等滚动组件（滚动方向上子组件会撑满视口的交叉轴）
- 设置了`crossAxisAlignment: CrossAxisAlignment.stretch`的 Column/Row（交叉轴紧约束；注意 `mainAxisSize` 只影响 Flex 自身在主轴占多大，不影响传给子组件的约束）
- 根布局下未设置 alignment/constraints 的 Container（Container 本身不改变约束，它会把父级的紧约束原样透传给子组件）

### 6.3 核心避坑指南

1. **永远先看父级约束，再看子组件宽高**：子组件的宽高永远无法脱离父级约束生效，这是 Flutter 布局的第一准则
2. **不要滥用 Center**：理解了约束原理后，优先通过调整父组件的对齐方式和约束规则解决问题，而不是无脑套 Center
3. **紧约束下，子组件的宽高设置完全无效**：遇到尺寸失效，第一时间排查父级是否传递了紧约束
4. **根布局永远是紧约束**：`runApp`传入的根组件，永远会收到屏幕尺寸的紧约束，因此根组件直接设置宽高永远不会生效
5. **不要在无界约束里用 double.infinity 撑满**：在横向 ListView、未设置弹性收缩的 Column 等主轴无界的父组件里，给子组件设置 `width: double.infinity` 会让布局抛出 `<RenderObject 类型> object was given an infinite size during layout.`（例如 `RenderConstrainedBox object was given an infinite size during layout.`），"撑满"只能作用在有界约束的方向上，官方排查指引见 https://flutter.dev/to/unbounded-constraints

## 七、总结

1. 组件被强制拉伸到屏幕尺寸的**核心原因**：父组件给子组件传递了**屏幕尺寸的紧约束**，子组件没有选择空间，只能被迫填满屏幕，自身设置的宽高完全失效。
2. Center 能解决问题的**核心原理**：Center 自身遵守父级的紧约束填满屏幕，同时给子组件传递**松约束**，让子组件可以在屏幕范围内自由决定自身尺寸，固定宽高正常生效。
3. 掌握 Flutter 布局的核心，就是理解**约束向下传递，尺寸向上传递，父级决定位置**的黄金法则，所有布局问题都可以通过拆解约束传递链路找到根源。

## 附录：相关官方文档链接

- [Flutter 官方中文文档：深入理解 Flutter 布局约束](https://flutter.cn/docs/ui/layout/constraints)
- [Center 组件官方 API 文档](https://api.flutter.dev/flutter/widgets/Center-class.html)
- [BoxConstraints 类官方 API 文档](https://api.flutter.dev/flutter/rendering/BoxConstraints-class.html)
- [RenderPositionedBox 类（Center/Align 对应的渲染对象）](https://api.flutter.dev/flutter/rendering/RenderPositionedBox-class.html)
- [SizedBox 类官方 API 文档](https://api.flutter.dev/flutter/widgets/SizedBox-class.html)
- [RenderObject 类（layout/performLayout 布局协议）](https://api.flutter.dev/flutter/rendering/RenderObject-class.html)

---

# Flutter 约束体系的底层控制核心原理

## 核心结论先行

Flutter 中**真正确定约束的底层控制核心，是`RenderObject`渲染对象体系的布局协议**，具体由`PipelineOwner`驱动的渲染管线 Layout 阶段统一调度，最终通过父`RenderObject`重写的`performLayout`方法，定义给子节点传递的约束规则，同时由`BoxConstraints`完成约束的合法性校验与强制合规。

我们日常使用的`Center`、`Row`、`Column`、`SizedBox`等布局组件，都只是这套底层协议的上层封装；Widget/Element 仅作为配置与桥接层，不参与任何约束的计算与传递。

---

## 一、先纠正核心认知误区

很多开发者会误以为 “Widget 控制了约束”，这是对 Flutter 三棵树体系的典型误解：

1. **Widget 层**：仅为不可变的 UI 配置描述，只负责声明布局规则，不执行任何布局计算、约束传递，它的核心作用是通过`createRenderObject`方法创建对应的`RenderObject`实例。
2. **Element 层**：Widget 与 RenderObject 之间的桥接层，负责组件生命周期管理、Widget 配置的同步更新，不参与约束计算与布局流程。
3. **RenderObject 层**：唯一负责布局计算、约束传递、尺寸确定、位置分配的核心层，Flutter 整个约束体系的底层逻辑，全部在这一层实现。

你看到的所有布局行为，包括 “组件被强制拉伸到全屏”、“Center 包裹后宽高生效”，本质都是对应 RenderObject 的底层布局逻辑执行的结果。

---

## 二、约束体系的顶层驱动：渲染管线与 PipelineOwner

约束的计算与传递，不是随机执行的，而是严格遵循 Flutter 的渲染流水线，在固定阶段统一调度执行。

### 2.1 渲染流水线的 Layout 阶段

Flutter 每帧的渲染流程固定为：

```
动画阶段 → build阶段 → layout阶段 → paint阶段 → 合成阶段
```

**约束的完整传递与计算，100% 发生在 layout 阶段**，这个阶段的核心工作，就是完成整棵渲染树的 “约束向下传递，尺寸向上反馈” 的闭环。

### 2.2 布局调度核心：PipelineOwner

`PipelineOwner`是 Flutter 渲染管线的调度核心，是约束体系的顶层入口，它的核心职责：

1. 收集所有标记为`needsLayout`的脏 RenderObject（布局需要更新的节点）
2. 在每帧的 layout 阶段，通过`flushLayout()`方法，把脏节点按**深度从浅到深**排序（源码为`dirtyNodes.sort((a, b) => a.depth - b.depth)`），靠近根部的节点先布局，再逐层向下驱动
3. 维护渲染树的布局依赖关系，确保子节点布局更新后，依赖它的父节点能正确触发重布局

渲染树的根节点是`RenderView`，它由 RendererBinding 创建并注册到渲染管线，引擎会把屏幕的物理尺寸（ViewConstraints）、设备像素比交给 Framework，由`ViewConfiguration.fromView`换算成逻辑约束传给 RenderView，这就是根布局永远会收到全屏紧约束的底层源头。

---

## 三、约束传递的核心入口：RenderObject.layout () 方法

所有 RenderObject 的布局执行，唯一入口是`layout()`方法，这是 "约束向下传递" 的唯一通道，也是父节点向子节点传递约束的底层实现。

### 3.1 方法核心签名与作用

```dart
void layout(Constraints constraints, { bool parentUsesSize = false })
```

- `constraints`：父节点传递给子节点的约束规则，子节点**必须严格遵守**该约束
- `parentUsesSize`：标记父节点的布局是否依赖子节点的尺寸。如果为 true，子节点尺寸变化时，会自动标记父节点为脏，触发父节点重布局
- 官方强制规范：子类**禁止重写 layout 方法**，只能重写`performResize`和`performLayout`，layout 方法会统一处理布局缓存、脏标记校验、依赖管理，然后把实际布局工作委托给这两个方法。

### 3.2 约束传递的底层链路

父节点要完成子节点的布局，**必须调用子节点的 layout 方法**，并把约束规则通过参数传递进去。

整棵渲染树的约束传递，就是从根 RenderView 开始，父节点调用子节点的 layout 方法，一层一层向下递归，直到叶子节点，形成完整的约束传递链路。

举个最基础的例子：

```dart
// 根RenderView → 调用Center的layout方法，传递全屏紧约束
// Center → 调用Container的layout方法，传递松约束
// Container → 完成自身尺寸计算，向上反馈最终尺寸
```

这就是 “约束向下传递” 的本质，没有任何魔法，就是一层一层的方法调用与参数传递。

---

## 四、约束规则的最终定义者：performLayout () 方法

`performLayout()`是**真正确定约束的底层核心方法**，你看到的所有布局组件的约束行为，包括 Center 的松约束传递、SizedBox 的紧约束传递、Row/Column 的弹性约束，全部通过重写这个方法实现。

### 4.1 方法的核心职责

每个 RenderObject 子类，都必须通过重写`performLayout`完成 3 件核心事：

1. 遵守父节点传递的约束，确定自身的最终尺寸
2. 为每个子节点定义并传递约束规则（调用子节点的 layout 方法）
3. 为每个子节点分配最终的显示位置（通过`parentData`存储偏移量）

### 4.2 核心源码示例：解开你最初的困惑

我们直接看两个最核心的 RenderObject 实现，就能彻底明白 “全屏拉伸” 和 “Center 生效” 的底层原理。

#### 示例 1：根节点 RenderView 的 performLayout（全屏约束的源头）

以下为 Flutter 3.41 中 `rendering/view.dart` 的实际实现：

```dart
@override
void performLayout() {
  assert(_rootTransform != null);
  final bool sizedByChild = !constraints.isTight;
  // 给唯一的子节点原样传递 configuration.logicalConstraints
  child?.layout(constraints, parentUsesSize: sizedByChild);
  _size = sizedByChild && child != null ? child!.size : constraints.smallest;
  assert(size.isFinite);
  assert(constraints.isSatisfiedBy(size));
}
```

这里的 `constraints` 来自 `RenderView.constraints`，它直接返回 `configuration.logicalConstraints`——由引擎提供的屏幕物理约束（`ViewConstraints`）除以设备像素比换算而来（见 `ViewConfiguration.fromView`）。普通全屏场景下该约束就是 `min == max == 屏幕逻辑尺寸` 的**紧约束**，RenderView 又把它原样传给唯一子节点。

这就是为什么`runApp(Container(width: 100, height: 100))`会被全屏拉伸：根 RenderView 直接给 Container 传递了**全屏紧约束**，Container 没有任何选择空间，只能被迫填满屏幕。

#### 示例 2：Center 对应的 RenderPositionedBox 的 performLayout

```dart
@override
void performLayout() {
  final BoxConstraints constraints = this.constraints;
  // 1. 先遵守父节点的约束，确定自身尺寸（父给全屏紧约束，就填满屏幕）
  final bool shrinkWrapWidth = _widthFactor != null || constraints.maxWidth == double.infinity;
  final bool shrinkWrapHeight = _heightFactor != null || constraints.maxHeight == double.infinity;

  if (child != null) {
    // 2. 给子节点调用layout，传递松约束！
    child!.layout(constraints.loosen(), parentUsesSize: true);
    // 3. 确定自身尺寸
    size = constraints.constrain(Size(
      shrinkWrapWidth ? child!.size.width * (_widthFactor ?? 1.0) : double.infinity,
      shrinkWrapHeight ? child!.size.height * (_heightFactor ?? 1.0) : double.infinity,
    ));
    // 4. 把子节点居中定位
    alignChild();
  } else {
    // 无子节点时，自身尺寸遵守父约束
    size = constraints.constrain(Size(
      shrinkWrapWidth ? 0.0 : double.infinity,
      shrinkWrapHeight ? 0.0 : double.infinity,
    ));
  }
}
```

核心关键就在这一行：`child!.layout(constraints.loosen(), parentUsesSize: true);`

- `constraints.loosen()`会把父节点传递的紧约束，转换为**松约束**：minWidth/minHeight 设为 0，maxWidth/maxHeight 保留父级的最大值
- 子节点收到松约束后，就可以在 0~ 父级最大尺寸范围内，自由使用自身设置的宽高，这就是 Center 包裹后，组件不会被拉伸的底层本质。

Center 自己扛下了父级的全屏紧约束，给子节点开放了松约束的自由空间，这就是它的核心作用。

---

## 五、约束的合法性强制校验：BoxConstraints 底层实现

`BoxConstraints`是约束的载体，它不仅是 4 个数值的容器，更是约束合法性的底层校验者，决定了子节点的尺寸是否有效，也是 “紧约束下宽高失效” 的底层核心。

### 5.1 约束的核心校验规则

BoxConstraints 定义了 4 个核心属性：`minWidth`、`maxWidth`、`minHeight`、`maxHeight`，并提供了核心校验方法`bool isSatisfiedBy(Size size)`，规则如下：

```dart
// 只有满足这个条件，Size才是合法的，否则会被强制修正
minWidth <= size.width <= maxWidth
minHeight <= size.height <= maxHeight
```

同时约束本身必须满足：`0 <= minWidth <= maxWidth <= infinity`，`0 <= minHeight <= maxHeight <= infinity`。

### 5.2 紧约束与松约束的底层定义

- **紧约束**：`minWidth == maxWidth && minHeight == maxHeight`，此时`isSatisfiedBy`只接受唯一的 Size 值，子节点设置的任何宽高都会失效，只能使用父级指定的固定尺寸。
- **松约束**：`minWidth == 0 && minHeight == 0`，仅限制最大尺寸，子节点可以在 0~max 范围内自由设置尺寸，自身宽高完全生效。

### 5.3 强制合规的底层逻辑

子节点在 performLayout 中计算出自身尺寸后，必须通过`constraints.constrain(Size size)`方法进行合规修正，这个方法会强制把 Size 调整到约束允许的范围内。

比如父级传递了紧约束`BoxConstraints.tight(Size(360, 780))`（屏幕尺寸），子节点就算传入`Size(100, 100)`，`constrain`方法也会强制返回`Size(360, 780)`，这就是宽高失效的底层实现。

---

## 六、尺寸计算的底层控制：performResize 与 sizedByParent

除了 performLayout，Flutter 还提供了`performResize`方法和`sizedByParent`属性，作为尺寸计算的底层补充控制，也是紧约束的重要实现细节。

### 6.1 sizedByParent 属性

`sizedByParent`是 RenderObject 的布尔属性，标记了**当前节点的尺寸是否完全由父级约束决定，与子节点无关**。

- 当`sizedByParent = true`时：节点的尺寸只能在`performResize`中计算，且只能基于父级的约束，不能依赖子节点的尺寸，performLayout 中禁止修改自身尺寸。
- 当`sizedByParent = false`时：节点的尺寸在 performLayout 中计算，可以依赖子节点的尺寸，自由调整。

### 6.2 performResize 方法

该方法仅在`sizedByParent = true`时被`layout()`调用，核心作用是基于父级约束，计算自身的最终尺寸。

需要特别注意：`sizedByParent`是子类**静态重写的 getter**，不会随运行时约束动态变化。SizedBox 对应的 RenderConstrainedBox 并没有重写它（保持默认的 false），其尺寸是在 performLayout 中通过`child.layout(_additionalConstraints.enforce(constraints), ...)`确定的。真正重写`sizedByParent => true`的是那些尺寸完全由父约束决定、与子节点无关的渲染对象，例如 RenderTextureBox、RenderPerformanceOverlay、RenderEditable 等——它们只需在 performResize 中算出尺寸，performLayout 里就不再改自身尺寸。

---

## 七、引擎层的边界：约束计算完全在 Framework 层

很多开发者会好奇，Flutter 引擎是否参与了约束的计算？答案是：**完全不参与**。

Flutter 引擎（C++ 层、Skia 渲染引擎）在约束体系中，只做两件事：

1. 给根 RenderView 提供屏幕的物理尺寸、设备像素比等基础信息，作为初始约束的输入
2. 拿到 Framework 层计算完成的最终布局信息（尺寸、位置、绘制指令），执行光栅化与上屏渲染

整个约束的计算、传递、校验逻辑，100% 在 Dart 层的 Flutter Framework 中实现，完全可自定义、可溯源。

---

## 最终总结

1. **约束的最终控制者**：父 RenderObject 的`performLayout`方法，它完全定义了给子节点传递的约束规则，是所有布局行为的底层源头。
2. **约束的传递通道**：`RenderObject.layout()`方法，父节点通过调用子节点的该方法，完成约束的向下传递。
3. **约束的顶层调度**：`PipelineOwner`驱动的渲染管线 Layout 阶段，统一管理整棵渲染树的布局执行。
4. **约束的合法性保障**：`BoxConstraints`的`isSatisfiedBy`与`constrain`方法，强制子节点的尺寸必须符合父级约束，这是紧约束下宽高失效的核心。
5. **Center 生效的本质**：它对应的 RenderPositionedBox，在 performLayout 中把父级的紧约束转换为松约束传递给子节点，让子节点可以自由设置尺寸。