# 53 基础布局组件：Center 与 Row 与 Column 的装配链路

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/basic.dart`（8573 行）、`packages/flutter/lib/src/widgets/framework.dart`（7455 行）、`packages/flutter/lib/src/rendering/shifted_box.dart`（1629 行）、`packages/flutter/lib/src/rendering/flex.dart`（1505 行）、`packages/flutter/lib/src/rendering/binding.dart`（932 行）

## 一、问题

`Center` 和 `Row` / `Column` 大概是写 Flutter 时敲得最多的三个布局组件。它们的问题不在"怎么用"，而在**用错了没人报错，只是没效果**。

最小复现：一行里放一个孩子，想让它水平居中。

```dart
Row(children: <Widget>[Center(child: Text('居中'))])              // 孩子贴在左边
Row(children: <Widget>[Expanded(child: Center(child: Text('居中')))])  // 孩子真的居中了
```

同一个 `Center`，只是外面多套一层 `Expanded`，结果完全不同。围绕这个现象有两类常见错误直觉：

- **直觉一：`Center` 是一个独立的居中组件，`Align` 只是它的"可配置版"。** 方向反了。`Center` 是 `Align` 的子类（`widgets/basic.dart:2550`），它连 `alignment` 字段都没有，用的是 `Align` 在 `:2468` 声明的默认值 `Alignment.center`。渲染树里没有什么"Center 专属节点"，只有 `Align` 一直在用的 `RenderPositionedBox`。
- **直觉二：`Flexible` / `Expanded` 是会占位的布局容器，它们会创建自己的渲染对象把空间撑开。** 也不对。它们是 `ParentDataWidget`（`widgets/basic.dart:6044`），**不产生任何 RenderObject**：渲染树里 `Row > Flexible > child` 会直接变成 `RenderFlex > child`，`Flexible` 的全部作用是在某个时刻往孩子的 `FlexParentData` 里写两个数字（`flex`、`fit`）。

本文只追一件事：**这些 widget 上的参数，最后变成了渲染层能吃的什么配置**。约束怎么向下传、尺寸怎么向上报，是第 33 篇；`RenderFlex` 怎么分配空间、怎么判溢出，是第 34 篇；三棵树怎么挂起来，是第 44 篇。本文是这三篇的"接口层"：把 widget 参数逐跳跟到 render 字段。

> `Center` / `Row` / `Column` 这一族 widget 本身几乎不含逻辑——`Center` 的类体只有一行构造函数，`Row` / `Column` 的类体只差一个 `Axis`。它们的工作是**把公开 API 翻译成 render 层的字段与 `ParentData`**。理解这一层，才能解释"为什么这么写没效果"。

## 二、最小 Demo

### 2.1 三个组件各摆一次

```dart
import 'package:flutter/widgets.dart';

void main() => runApp(const BasicLayoutLab());

class BasicLayoutLab extends StatelessWidget {
  const BasicLayoutLab({super.key});

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      // 1. 给一个确定的父盒子，才能看出 Center 的尺寸是被约束决定的
      child: Center(
        child: SizedBox(
          width: 320,
          height: 80,
          // 2. Row 是水平 Flex：孩子沿主轴（水平）排，交叉轴（垂直）默认居中
          child: Row(
            mainAxisSize: MainAxisSize.max, // 3. 默认值：吃满 320
            children: <Widget>[
              const SizedBox(width: 60, height: 20, child: ColoredBox(color: Color(0xFF90CAF9))),
              const SizedBox(width: 20),
              // 4. Column 是垂直 Flex：主轴变竖直，其余规则完全一样
              const Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  SizedBox(width: 40, height: 10, child: ColoredBox(color: Color(0xFFFFB74D))),
                  SizedBox(width: 40, height: 10, child: ColoredBox(color: Color(0xFF81C784))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

这个例子里四件事一次看到：`Center` 把 320×80 的盒子放在屏幕中央、把自己撑满可用空间、把 `SizedBox` 的孩子居中；`Row` 横向排；`Column` 纵向排；`SizedBox` 在这两个 Flex 眼里都只是"一个固定尺寸的普通孩子"。

### 2.2 对照实验：只改一行，结果完全不同

把 2.1 的 `Row` 换成下面这段，用一个开关切两次：

```dart
class CenterInRowLab extends StatelessWidget {
  const CenterInRowLab({super.key, required this.useExpanded});

  final bool useExpanded;

  @override
  Widget build(BuildContext context) {
    // 5. 唯一变量：这个 Center 外面有没有 Expanded
    final Widget inner = Center(
      child: const SizedBox(width: 40, height: 20, child: ColoredBox(color: Color(0xFF90CAF9))),
    );
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: SizedBox(
          width: 320,
          height: 80,
          child: Row(
            children: <Widget>[useExpanded ? Expanded(child: inner) : inner],
          ),
        ),
      ),
    );
  }
}
```

把 `useExpanded` 从 `false` 改成 `true`，蓝色的孩子就从贴左边变成水平居中。第六节给出这两个版本的实际尺寸与偏移——差值全部来自 `Expanded` 写进孩子的 `flex` / `fit` 两个字段。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/basic.dart:2462` | `class Align`，`alignment` 的默认值 `Alignment.center` 在 `:2468`，`createRenderObject` 在 `:2504` |
| `widgets/basic.dart:2550` | `class Center extends Align`，类体只有一个空参数转发的构造函数 |
| `widgets/basic.dart:5408` | `class Flex`，默认值在 `:5421` 起的构造函数里，`createRenderObject` 在 `:5575` |
| `widgets/basic.dart:5809` | `class Row extends Flex`（`Column` 在 `:6001`，两者只差传给 `super` 的一个 `Axis`） |
| `widgets/basic.dart:6044` | `class Flexible extends ParentDataWidget<FlexParentData>`，`applyParentData` 在 `:6067` |
| `widgets/basic.dart:6135` | `class Expanded extends Flexible`，构造函数在 `:6139` 把 `fit` 钉死成 `FlexFit.tight` |
| `rendering/shifted_box.dart:397` | `class RenderPositionedBox`；`alignChild` 在 `:370`（由 `:294` 的 `RenderAligningShiftedBox` 提供） |
| `rendering/flex.dart:412` | `class RenderFlex`，孩子数据类型 `FlexParentData` 在 `:126`，`_computeSizes` 在 `:1205` |

这张表就是本文的全部结论：`Align` 与 `Center` 共用一个渲染类，`Flex` / `Row` / `Column` 共用一个渲染类，`Flexible` / `Expanded` 一个渲染类都没有。行号会漂移，"哪个 widget 对应哪个 RenderObject"不会。

## 四、调用链

### 4.1 三跳就够：参数 → RenderObject → parentData

第 44 篇已经把 `RenderObjectElement` 的完整生命周期讲透了，这里只取三个和本文相关的调用点，不重复三棵树。

```dart
// widgets/framework.dart:6784-6803（节选）
@override
void mount(Element? parent, Object? newSlot) {
  super.mount(parent, newSlot);
  _renderObject = (widget as RenderObjectWidget).createRenderObject(this); // 1. 第一跳：建渲染对象
  ...
  attachRenderObject(newSlot);                                            // 2. 挂上去
}

// widgets/framework.dart:6916-6946（节选）
@override
void attachRenderObject(Object? newSlot) {
  _ancestorRenderObjectElement = _findAncestorRenderObjectElement();
  _ancestorRenderObjectElement?.insertRenderObjectChild(renderObject, newSlot); // 3. 挂进父的渲染树
  final List<ParentDataElement<ParentData>> parentDataElements =
      _findAncestorParentDataElements();                                        // 4. 向上收集 ParentDataWidget
  for (final parentDataElement in parentDataElements) {
    _updateParentData(parentDataElement.widget as ParentDataWidget<ParentData>); // 5. 写 parentData
  }
}
```

- **第一跳**（`:6790`）：`createRenderObject(this)` 把 widget 的字段抄进一个新 render 对象。`Align` 在这里抄 4 个字段，`Flex` 在这里抄 9 个。
- **第三跳**（`:6941`）：`insertRenderObjectChild` 决定这个 render 对象挂到渲染树的哪个位置——`Flexible` 的孩子在这一步直接挂到 `RenderFlex` 身上。
- **第五跳**（`:6945`）：`_updateParentData` 把祖先链上每个 `ParentDataWidget` 的数据写进 `renderObject.parentData`。**`Expanded` 的 `flex` / `fit` 首次挂载时就在这一步出现**，它自己没有渲染对象可挂。后续 widget 更新不再走挂载路径，而是 `ProxyElement.update`（`framework.dart:6143`）→ `updated`（`:6158`）→ `ParentDataElement.notifyClients`（`:6246`）→ `_applyParentData`（`:6193`）→ `RenderObjectElement._updateParentData` → `ParentDataWidget.applyParentData`（详见 4.4 节）。

widget 第二次构建之后走的是另一条路：`updateRenderObject`（`basic.dart:5590`）把新参数拷进**已有的** `RenderFlex`。所以"改配置"和"建对象"是两个方法，`Flex` 必须把 9 个字段在两边都写一遍——`createRenderObject` 少抄一个字段，运行时的表现就是"改了没反应"。

### 4.2 Center：从 `Alignment` 到 `BoxParentData.offset`

`Center` 的全部源码如下：

```dart
// widgets/basic.dart:2550-2553
class Center extends Align {
  /// Creates a widget that centers its child.
  const Center({super.key, super.widthFactor, super.heightFactor, super.child});
}
```

它没有 override 任何方法，也没碰 `alignment`；`Align` 的构造函数（`:2466`）里那句 `this.alignment = Alignment.center`（`:2468`）就是它的默认对齐方式。于是 `Center(child: x)` 与 `Align(alignment: Alignment.center, child: x)` 走的是同一段代码：

```dart
// widgets/basic.dart:2504-2520（节选）
@override
RenderPositionedBox createRenderObject(BuildContext context) {
  return RenderPositionedBox(
    alignment: alignment,                 // 1. AlignmentGeometry 原样传下去
    widthFactor: widthFactor,
    heightFactor: heightFactor,
    textDirection: Directionality.maybeOf(context), // 2. 方向敏感的 alignment 要靠它 resolve
  );
}

@override
void updateRenderObject(BuildContext context, RenderPositionedBox renderObject) {
  renderObject
    ..alignment = alignment
    ..widthFactor = widthFactor
    ..heightFactor = heightFactor
    ..textDirection = Directionality.maybeOf(context);
}
```

render 层的落点是 `RenderPositionedBox.performLayout`（`rendering/shifted_box.dart:478`）：

```dart
// rendering/shifted_box.dart:478-492（节选）
void performLayout() {
  final BoxConstraints constraints = this.constraints;
  final bool shrinkWrapWidth = _widthFactor != null || constraints.maxWidth == double.infinity;   // 1.
  final bool shrinkWrapHeight = _heightFactor != null || constraints.maxHeight == double.infinity; // 2.

  if (child != null) {
    child!.layout(constraints.loosen(), parentUsesSize: true);                                     // 3. 孩子先布局
    size = constraints.constrain(
      Size(
        shrinkWrapWidth ? child!.size.width * (_widthFactor ?? 1.0) : double.infinity,             // 4. 自己再定尺寸
        shrinkWrapHeight ? child!.size.height * (_heightFactor ?? 1.0) : double.infinity,
      ),
    );
    alignChild();                                                                                  // 5. 最后才摆孩子
  }
  ...
}
```

第 4 步的 `double.infinity` 是理解 `Center` 的钥匙：**某根轴上"不 shrink-wrap"时，它把自己撑到父约束允许的最大值**；只有当父约束在那根轴上本来就是无限，或者传了 `widthFactor` / `heightFactor`，它才退化成"和孩子一样大"。第 5 步的 `alignChild`（`:370`）全文只有一行有效代码：

```dart
// rendering/shifted_box.dart:376
childParentData.offset = resolvedAlignment.alongOffset(size - child!.size as Offset);
```

`size - child!.size` 是**剩余空间**，`alongOffset` 把它按对齐系数映射成一个偏移，写进孩子的 `BoxParentData.offset`——这正是第 12 篇讲的"对齐是一个函数"。`Center` 在这里的特殊之处只有一个：`Alignment.center` 让两个方向的系数都是 `0.0`，偏移恒等于剩余空间的一半。

`Center` 是 `alignment` 被写死成 `center` 的 `Align`，并不是"独立组件家族"；它对自己的孩子能做的**只有一件事**——在**自己的盒子内部**算一个偏移量。它管不到自己的盒子有多大，也管不到自己在父级里排第几个。4.5 节那个"没效果"的坑，根因就在这里。

### 4.3 Row 与 Column：同一个 Flex 的两个方向

```dart
// widgets/basic.dart:5809-5832（节选）
class Row extends Flex {
  const Row({
    super.key,
    super.mainAxisAlignment,
    super.mainAxisSize,
    super.crossAxisAlignment,
    ...
  }) : super(direction: Axis.horizontal);
}

// widgets/basic.dart:6001-6022（节选）
class Column extends Flex {
  const Column({ ... }) : super(direction: Axis.vertical);
}
```

两个类都没有 `createRenderObject` / `updateRenderObject`，这两个方法由 `Flex` 提供，产出物是同一个 `RenderFlex`（`rendering/flex.dart:412`）。所以"`Row` 和 `Column` 是两套布局机制"是错觉：它们是**同一个渲染对象**在不同 `Axis` 下的两种叫法，连默认值都来自同一处。

```dart
// widgets/basic.dart:5421-5432（节选）
const Flex({
  super.key,
  required this.direction,                              // 唯一必填：Row / Column 已经替你填好
  this.mainAxisAlignment = MainAxisAlignment.start,     // 1. 主轴默认贴起始边
  this.mainAxisSize = MainAxisSize.max,                 // 2. 主轴默认吃满可用空间
  this.crossAxisAlignment = CrossAxisAlignment.center,  // 3. 交叉轴默认居中
  this.textDirection,
  this.verticalDirection = VerticalDirection.down,
  this.textBaseline, // NO DEFAULT: we don't know what the text's baseline should be
  this.clipBehavior = Clip.none,
  this.spacing = 0.0,
  super.children,
}) : ...
```

这 9 个配置都会在 `createRenderObject`（`:5575`）里传给 `RenderFlex`（`rendering/flex.dart:421`），但两边并不是逐字对应。`direction` 在 Widget 层是 `required`，由 `Row` / `Column` 显式固定成 `Axis.horizontal` / `Axis.vertical`；`textDirection` 则先经过 `getEffectiveTextDirection(context)`（`:5570`）解析——只在需要文本方向时回退到环境 `Directionality`，否则传 `null`。`RenderFlex` 那侧另外声明了一套可选配置的默认值（`direction = Axis.horizontal`、`mainAxisSize = MainAxisSize.max`、`crossAxisAlignment = CrossAxisAlignment.center`、`clipBehavior = Clip.none`、`spacing = 0.0` 等），只在有人绕过 widget 直接构造它时才生效。

`RenderFlex` 每个字段的 setter 都长这样（以 `direction` 为例）：

```dart
// rendering/flex.dart:448-453（节选）
Axis get direction => _direction;
Axis _direction;
set direction(Axis value) {
  if (_direction != value) {   // 1. 值没变直接返回
    _direction = value;
    markNeedsLayout();         // 2. 变了才标脏（第 32 篇）
  }
}
```

这一条决定了高频重建场景的行为：`Row(crossAxisAlignment: ...)` 每次 build 都产生新 widget，但只要值没变，`updateRenderObject` 里的 9 次赋值全部走第一条分支返回，一次 `markNeedsLayout` 都不会触发。

### 4.4 Flexible 与 Expanded：不产生 RenderObject 的 ParentDataWidget

```dart
// widgets/basic.dart:6044-6047
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
}

// widgets/basic.dart:6135-6139（节选）
class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

`Expanded` 相对 `Flexible` 只多了一件事：把 `fit` 从默认的 `FlexFit.loose` 改成 `FlexFit.tight`。`fit` 会影响孩子拿到的 `min` 约束，那是第 34 篇的 `_constraintsForFlexChild`（`rendering/flex.dart:901`）；本文关心的是这两个字段**怎么进到 render 层**：

```dart
// widgets/basic.dart:6067-6085（节选）
@override
void applyParentData(RenderObject renderObject) {
  assert(renderObject.parentData is FlexParentData);     // 1. debug 下的类型断言
  final parentData = renderObject.parentData! as FlexParentData;
  var needsLayout = false;

  if (parentData.flex != flex) {
    parentData.flex = flex;                              // 2. 写进孩子的 parentData
    needsLayout = true;
  }
  if (parentData.fit != fit) {
    parentData.fit = fit;
    needsLayout = true;
  }
  if (needsLayout) {
    renderObject.parent?.markNeedsLayout();              // 3. 标脏的是父（RenderFlex），不是孩子
  }
}
```

三个细节值得记住：

1. **写的是孩子的 `parentData`，标脏的是孩子的 `parent`**。`flex` 是"父级切蛋糕时的权重"，它改变的是父级的空间分配，所以脏标记必须往上打。
2. **`parentData` 由父级准备**。`RenderFlex.setupParentData`（`rendering/flex.dart:705`）在孩子被加进来时执行 `child.parentData = FlexParentData()`（`:707`）；`RenderFlex` 读回的入口是 `_getFlex`（`:814`，缺省 0）和 `_getFit`（`:819`，缺省 `FlexFit.tight`）。
3. **`Flexible` 只在 `parentData` 变化时才标脏**。同一个 `Row` 反复重建、`flex` 不变时，`applyParentData` 什么都不做——这也是它能安全地跑在每次挂载路径上的原因。

`FlexParentData` 里最终落下的就是三个字段，它的 `toString` 顺手把 flex / fit 打印出来，这是第六节实验能一眼看出装配结果的依据：

```dart
// rendering/flex.dart:145
String toString() => '${super.toString()}; flex=$flex; fit=$fit';
```

> `Flexible` / `Expanded` 是"给孩子的 `ParentData` 打标签"的 widget，不是布局容器。渲染树里没有它们的节点——`Row > Expanded > child` 挂出来就是 `RenderFlex > child`。`Expanded` 不会在渲染树中留下 `RenderObject`；在挂载时，以及后续 widget 更新触发 `ProxyElement.update` → `ParentDataElement.notifyClients` → `_applyParentData` 时，`ParentDataElement` 都可能调用 `applyParentData`，把 `flex` / `fit` 写到孩子的 `FlexParentData`（第六节实验 3 的 dump 里那一行 `parentData: ...; flex=1; fit=FlexFit.tight` 就是它的产物）。

打标签这件事必须打对人，所以框架在 debug 下会先验一次类型（`widgets/framework.dart:6876`）：

```dart
// widgets/framework.dart:6876-6899（节选）
void _updateParentData(ParentDataWidget<ParentData> parentDataWidget) {
  var applyParentData = true;
  assert(() {
    try {
      if (!parentDataWidget.debugIsValidRenderObject(renderObject)) {   // 1. renderObject.parentData is T？
        applyParentData = false;
        throw FlutterError.fromParts(<DiagnosticsNode>[
          ErrorSummary('Incorrect use of ParentDataWidget.'),           // 2. 报错原文（第六节实验 4）
          ...
        ]);
      }
    } on FlutterError catch (e) {
      _reportException(ErrorSummary('while applying parent data.'), e, e.stackTrace);
    }
    return true;
  }());
  if (applyParentData) {
    parentDataWidget.applyParentData(renderObject);
  }
}
```

判定条件就是 `ParentDataWidget<T>.debugIsValidRenderObject`（`framework.dart:1604`）里的那一句 `return renderObject.parentData is T;`。`Flexible` 的 `T` 是 `FlexParentData`，而只有 `RenderFlex` 会准备 `FlexParentData`——这就是"`Expanded` 必须放在 `Row` / `Column` / `Flex` 的后代路径上"的全部机制。注意时序：debug 下 `attachRenderObject` 的 `_updateParentData` 先校验 `parentData` 类型，不匹配时把局部变量 `applyParentData` 置为 `false` 并构造一个 `FlutterError`；这个错误随即被同层的 `on FlutterError catch (e)` 捕获、经 `_reportException` 报告出来，所以它不是直接向外抛出的异常。校验失败还意味着 `Flexible.applyParentData` 那一跳根本不会执行，里面的断言与强制转换也就无从触发。只有绕过这层 debug 校验（例如 release），紧随 `assert(renderObject.parentData is FlexParentData)` 的 `as FlexParentData` 才会直接暴露类型错误——**这条规则不能当成"只在 debug 会抱怨的警告"**。

### 4.5 主轴与交叉轴：为什么 `Row` 里套 `Center` 没用

`RenderFlex.performLayout`（`rendering/flex.dart:1316`）在算完尺寸之后，只做两轮写操作：先按 `mainAxisAlignment` 求出两个间距，再循环把孩子的位置写进 `FlexParentData.offset`。

```dart
// rendering/flex.dart:1339-1347（节选）
final double remainingSpace = math.max(0.0, sizes.mainAxisFreeSpace);          // 1. 主轴剩余空间
final (double leadingSpace, double betweenSpace) = mainAxisAlignment._distributeSpace(
  remainingSpace,
  childCount,
  flipMainAxis,
  spacing,
);

// rendering/flex.dart:1385-1390（节选）
final childParentData = child.parentData! as FlexParentData;
childParentData.offset = switch (direction) {                                   // 2. 位置写进 parentData
  Axis.horizontal => Offset(childMainPosition, childCrossPosition),
  Axis.vertical => Offset(childCrossPosition, childMainPosition),
};
```

`MainAxisAlignment._distributeSpace`（`rendering/flex.dart:228`）是一张纯 switch 表，`center` 分支就是 `(freeSpace / 2.0, spacing)`（`:257`）。**主轴的居中从头到尾由 `RenderFlex` 完成，和 `Center` 没有关系。**

那为什么裸 `Center` 在主轴上完全动不了？看非 flex 孩子拿到的约束：

```dart
// rendering/flex.dart:881-899（节选）
BoxConstraints _constraintsForNonFlexChild(BoxConstraints constraints) {
  final bool fillCrossAxis = switch (crossAxisAlignment) {
    CrossAxisAlignment.stretch => true,
    CrossAxisAlignment.start || CrossAxisAlignment.center ||
    CrossAxisAlignment.end || CrossAxisAlignment.baseline => false,
  };
  return switch (_direction) {
    Axis.horizontal =>
      fillCrossAxis
          ? BoxConstraints.tightFor(height: constraints.maxHeight)
          : BoxConstraints(maxHeight: constraints.maxHeight),   // ← 只限高，宽度不限
    Axis.vertical => ...
  };
}
```

`BoxConstraints(maxHeight: constraints.maxHeight)` 的 `maxWidth` 是构造函数的默认值 `double.infinity`。把这个约束交给 `RenderPositionedBox.performLayout`，于是 `shrinkWrapWidth = (_widthFactor != null || constraints.maxWidth == double.infinity)` **为真**——`Center` 直接缩成"和孩子一样宽"，主轴方向剩余空间为 0，`alignChild` 算出来的偏移只能是 0。

换成 `Expanded(child: Center(...))` 后，`Expanded` 把 `fit = FlexFit.tight` 写进孩子的 `parentData`，`_constraintsForFlexChild`（`rendering/flex.dart:908`）就给出：

```dart
// rendering/flex.dart:908-911
final double minChildExtent = switch (_getFit(child)) {
  FlexFit.tight => maxChildExtent,   // ← min = max，孩子在那根轴上被钉死成一个确定的槽位
  FlexFit.loose => 0.0,
};
```

`Center` 拿到的 `maxWidth` 不再是无限，`shrinkWrapWidth` 变假，它把自己撑成整份槽位，`size - child!.size` 终于非 0，偏移生效。

`Row` 里的 `Center` 只能影响**交叉轴**。想在主轴上居中只有两条路：给 `Row` 设 `mainAxisAlignment`（由 `RenderFlex` 分配剩余空间），或者给 `Center` 外面套 `Expanded`（让 `Center` 先拿到一份确定的主轴槽位，再在槽位内居中）。

交叉轴这条路上还有一次容易忽略的"白干"：`Flex` 的 `crossAxisAlignment` 默认就是 `CrossAxisAlignment.center`（`basic.dart:5426`），此时 `Center` 在交叉轴上算出来的偏移和 `RenderFlex` 自己算的一模一样。只有把 `crossAxisAlignment` 改成 `start` / `end` / `baseline` / `stretch` 时，`Center` 才可能改变孩子的位置——第六节实验 2 给了这两组数。其中 `stretch` 的机制与另外三个不同：`_constraintsForNonFlexChild`（`rendering/flex.dart:881`）把 `CrossAxisAlignment.stretch => true`（`:883`），水平 `Row` 下返回 `BoxConstraints.tightFor(height: constraints.maxHeight)`（`:892`），先把 `Center` 自己的交叉轴槽位钉成一个确定高度；`RenderPositionedBox` 拿到有限的 `maxHeight` 后 `shrinkWrapHeight` 为假（`rendering/shifted_box.dart:481`），于是它撑满整条槽位，再用 `constraints.loosen()` 布局孩子并 `alignChild()`（`:484`、`:491`）——孩子保持自身高度、被居中放在槽位里，和"不套 `Center` 时 `RenderFlex` 直接把孩子拉满交叉轴"的结果并不一样。

## 五、核心对象：`RenderPositionedBox` vs `RenderFlex`

| | `RenderPositionedBox`（`rendering/shifted_box.dart:397`） | `RenderFlex`（`rendering/flex.dart:412`） |
|---|---|---|
| 对应 widget | `Align`（`basic.dart:2462`）/ `Center`（`:2550`） | `Flex`（`:5408`）/ `Row`（`:5809`）/ `Column`（`:6001`） |
| 继承来源 | `RenderAligningShiftedBox`（`:294`）→ `RenderShiftedBox`（`:32`） | `RenderBox` + `ContainerRenderObjectMixin` + `DebugOverflowIndicatorMixin` |
| 孩子数量 | 1（`RenderObjectWithChildMixin`） | N（`ContainerRenderObjectMixin`） |
| 孩子 parentData | `BoxParentData`，只有一个 `offset` | `FlexParentData`（`:126`），`offset` + `flex` + `fit` |
| 自己的尺寸怎么定 | 该轴无限（或给了 factor）就 shrink-wrap，否则吃满父约束（`:480-481`、`:486-489`） | 主轴由 `mainAxisSize` 与 `_computeSizes` 决定，交叉轴取孩子最大值 |
| 孩子的位置谁定 | `alignChild`（`:370`）一行：`resolvedAlignment.alongOffset(size - child!.size)`（`:376`） | `performLayout` 末尾循环写 `childParentData.offset`（`:1386`） |
| 能影响主轴的排布吗 | 不能，它只在**自己的盒子内**工作 | 能，`mainAxisAlignment` + 每个孩子的 `flex` / `fit` |
| 溢出怎么办 | 不管，孩子照样画到盒子外面 | `_overflow` + `DebugOverflowIndicatorMixin` 报警（第 34 篇） |

表格之外只需要一句话：**`RenderPositionedBox` 管"在我自己的盒子里摆在哪个位置"，`RenderFlex` 管"把父级给的主轴切几份、每份给谁"。** `Row` 里的 `Center` 是前者，所以它管不到后者的事——这就是第一节那个"没效果"的全部原因。

## 六、源码实验

四组实验都在临时 widget test（`flutter test`）里跑，用例统一用下面这个 `wrap` 把被测 `Row` 放进一个 320 × 80 的确定盒子里；尺寸取 `RenderBox.size`，偏移取孩子相对 `Row` 原点的 `localToGlobal` 差值。实验代码是临时的，不进仓库测试。

```dart
Widget wrap(Widget child) => Directionality(
  textDirection: TextDirection.ltr,
  child: Center(child: SizedBox(width: 320, height: 80, child: child)),
);
```

### 实验 1：`Row` 里裸 `Center` —— 主轴方向没有任何偏移

```dart
await tester.pumpWidget(
  wrap(
    Row(
      children: <Widget>[
        Center(key: const Key('center'), child: const SizedBox(key: Key('inner'), width: 40, height: 20)),
      ],
    ),
  ),
);
```

**预测**：`Center` 会在主轴方向上把自己撑开，好让孩子居中。

**实际**（输出）：

```text
LAB-A row=Size(320.0, 80.0) centerSize=Size(40.0, 80.0) innerSize=Size(40.0, 20.0)
LAB-A centerTopLeft(inRow)=Offset(0.0, 0.0)
LAB-A innerTopLeft(inRow)=Offset(0.0, 30.0)
LAB-A centerConstraints=BoxConstraints(0.0<=w<=Infinity, 0.0<=h<=80.0)
```

**说明**：`centerConstraints` 那行直接给出了根因——它拿到的 `maxWidth` 是 `Infinity`，正是 `_constraintsForNonFlexChild`（`flex.dart:881`）那句 `BoxConstraints(maxHeight: constraints.maxHeight)` 的默认 `maxWidth`。于是 `centerSize` 的宽度只有 40（跟孩子一样），主轴剩余空间为 0，孩子的 x 恒为 0。交叉轴相反：`maxHeight` 是 80，`Center` 撑满 80 高，孩子在内部被居中到 y=30。

### 实验 2：`Expanded(child: Center(...))` —— 先拿到槽位，偏移才有意义

```dart
await tester.pumpWidget(
  wrap(
    Row(
      children: <Widget>[
        Expanded(child: Center(key: const Key('center'), child: const SizedBox(key: Key('inner'), width: 40, height: 20))),
      ],
    ),
  ),
);
```

**预测**：`Expanded` 会给 `Center` 一个确定的槽位，`Center` 在槽位内居中。

**实际**（输出）：

```text
LAB-B row=Size(320.0, 80.0) centerSize=Size(320.0, 80.0) innerSize=Size(40.0, 20.0)
LAB-B innerTopLeft(inRow)=Offset(140.0, 30.0)
LAB-B centerConstraints=BoxConstraints(w=320.0, 0.0<=h<=80.0)
```

**说明**：`centerConstraints` 从 `0.0<=w<=Infinity` 变成 `w=320.0`（min = max），`centerSize` 随之变成 320 宽，`alignChild` 的剩余空间变成 280，偏移 `(320 - 40) / 2 = 140` 出现。同一组用例里再改 `crossAxisAlignment`，还能看出交叉轴上那个 `Center` 什么时候是白干的：

```text
LAB-A2 crossAxisAlignment.start 不套 Center：innerTopLeft(inRow)=Offset(0.0, 0.0)
LAB-A2 crossAxisAlignment.start 套 Center  ：innerTopLeft(inRow)=Offset(0.0, 30.0) centerSize=Size(40.0, 80.0)
LAB-A3 crossAxisAlignment 默认(center)      ：innerTopLeft(inRow)=Offset(140.0, 30.0) centerSize=Size(40.0, 80.0)
```

`LAB-A3` 是"`Row(mainAxisAlignment: center)` + 裸 `Center`"：y=30 由 `Center` 和 `RenderFlex` 的默认 `crossAxisAlignment` 同时给出（所以这一层 `Center` 是可删的），x=140 则完全来自 `Row` 的 `mainAxisAlignment`。**同一个 `Center`，在主轴上是零作用，在交叉轴上取决于父级怎么配。**

### 实验 3：`debugDumpRenderTree` 看 `FlexParentData`

按计划给出 `flex` 与 `fit` 不同的两个孩子：

```dart
await tester.pumpWidget(
  wrap(
    Row(
      children: <Widget>[
        Flexible(flex: 2, child: Container(key: const Key('flex2'), width: 10)),
        Expanded(flex: 1, child: Container(key: const Key('exp1'))),
      ],
    ),
  ),
);
debugDumpRenderTree();   // rendering/binding.dart:709
```

**预测**：渲染树里看不到 `Flexible` / `Expanded` 的节点，但孩子的 `parentData` 里会带上 `flex` / `fit`，`offset` 已经被 `RenderFlex` 写好。

**实际**（输出，只截 `RenderFlex` 以下）：

```text
     └─child: RenderFlex#9e884
       │ creator: Row ← SizedBox ← Center ← Directionality ← ...
       │ constraints: BoxConstraints(w=320.0, h=80.0)
       │ size: Size(320.0, 80.0)
       │ direction: horizontal
       │ mainAxisAlignment: start
       │ mainAxisSize: max
       │ crossAxisAlignment: center
       │ textDirection: ltr
       │ verticalDirection: down
       │ spacing: 0.0
       │
       ├─child 1: RenderConstrainedBox#f3ceb relayoutBoundary=up1
       │ │ creator: ConstrainedBox ← Container-[<'flex2'>] ← Flexible ← Row ← SizedBox ← ...
       │ │ parentData: offset=Offset(0.0, 0.0); flex=2; fit=FlexFit.loose
       │ │   (can use size)
       │ │ constraints: BoxConstraints(0.0<=w<=213.3, 0.0<=h<=80.0)
       │ │ size: Size(10.0, 80.0)
       │ │
       │ └─child: RenderLimitedBox#50c5a relayoutBoundary=up2
       │   │ ...
       │
       └─child 2: RenderLimitedBox#377b1 relayoutBoundary=up1
         │ creator: LimitedBox ← Container-[<'exp1'>] ← Expanded ← Row ← SizedBox ← ...
         │ parentData: offset=Offset(10.0, 0.0); flex=1; fit=FlexFit.tight
         │   (can use size)
         │ constraints: BoxConstraints(w=106.7, 0.0<=h<=80.0)
         │ size: Size(106.7, 80.0)
         │
         └─child: RenderConstrainedBox#dedce relayoutBoundary=up2
             ...
```

**说明**：三件事一次确认。第一，`creator` 链里能看到 `Flexible` / `Expanded`（那是 widget 的创建链），但渲染树上 `RenderFlex` 的"child 1 / child 2"**直接就是** `Container` 产出的 `RenderConstrainedBox` / `RenderLimitedBox`——两个 ParentDataWidget 确实没有留下渲染节点。第二，`parentData` 那两行里的 `flex=2; fit=FlexFit.loose` 与 `flex=1; fit=FlexFit.tight` 正是 `Flexible` / `Expanded` 写进去的值（`FlexParentData.toString`，`flex.dart:145`），同时 `offset` 已经被 `RenderFlex.performLayout` 写好（第二个孩子 x=10，紧接第一个孩子的实际宽度）。第三，约束那两行是第 34 篇 `spacePerFlex` 机制的现场证据：`flex: 2` 的孩子拿到 `0.0<=w<=213.3`、`flex: 1` 的拿到 `w=106.7`（320 / 3 的 2 份与 1 份），**第一个孩子实际只用了 10，第二个孩子的份额并没有因此变大**——分配算法本身在第 34 篇，这里只作为"`fit` 真的到达了 render 层"的旁证。

### 实验 4：`Expanded` 放错父级

把 `Expanded` 塞进 `Padding` 里（`Padding` 不产生 `FlexParentData`）：

```dart
await tester.pumpWidget(
  wrap(
    Column(
      children: <Widget>[
        Padding(padding: const EdgeInsets.all(8), child: Expanded(child: Container())),
      ],
    ),
  ),
);
```

**预测**：debug 下会有一条指名道姓的诊断，指出 `Expanded` 的位置不对。

**实际**（输出，节选）：

```text
The following assertion was thrown while applying parent data.:
Incorrect use of ParentDataWidget.
The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type FlexParentData to a
RenderObject, which has been set up to accept ParentData of incompatible type BoxParentData.
Usually, this means that the Expanded widget has the wrong ancestor RenderObjectWidget. Typically,
Expanded widgets are placed directly inside Flex widgets.
The offending Expanded is currently placed inside a Padding widget.
The ownership chain for the RenderObject that received the incompatible parent data was:
  LimitedBox ← Container ← Expanded ← Padding ← Column ← SizedBox ← Center ← Directionality ← ...
```

堆栈里的三帧点明了它发生的时刻：

```text
#0  RenderObjectElement._updateParentData.<anonymous closure> (framework.dart:6882:11)
#1  RenderObjectElement._updateParentData (framework.dart:6899:6)
#2  RenderObjectElement.attachRenderObject (framework.dart:6945:7)
#3  RenderObjectElement.mount (framework.dart:6801:5)
```

**说明**：报错发生在**挂载时的 `attachRenderObject`**（4.1 的第五跳），不在 build 阶段。校验内容是 `renderObject.parentData is FlexParentData`：`Padding` 的渲染对象只准备了默认的 `BoxParentData`，所以这里判定失败，诊断里"wants to apply ... to ... incompatible type `BoxParentData`"就是这句比较的结果。注意诊断的措辞是"the wrong ancestor RenderObjectWidget"、"placed directly inside Flex widgets"——**`Flexible` 自己并没有失败，失败的是"它要写的 `ParentData` 类型和这个渲染对象不匹配"**。判断能不能放，看的是"从 `Flexible` 到最近的 `Flex` 之间有没有别的 `RenderObjectWidget`"（第 44 篇的 `_findAncestorParentDataElements` 会把祖先链上的 ParentDataWidget 全部收集起来，逐个写）。

## 七、结论

1. **`Center` 不是独立家族，它是 `alignment` 写死成 `Alignment.center` 的 `Align`；`Row` / `Column` 也不是两套机制，它们是同一个 `Flex` 在两个方向上的别名。** `Center` 的类体只有一行构造函数（`basic.dart:2550`），`Row` / `Column` 的类体只差一个 `Axis`（`:5831` / `:6021`），五个类最后只落到两个渲染对象：`RenderPositionedBox`（`shifted_box.dart:397`）与 `RenderFlex`（`flex.dart:412`）。
2. **`Flexible` / `Expanded` 一个渲染对象都不产生，它们只往孩子的 `FlexParentData` 里写 `flex` 与 `fit`，然后往父级打脏标记。** 渲染树上 `Row > Expanded > child` 就是 `RenderFlex > child`（实验 3 的 dump 可见）。这也解释了它们为什么只能待在 `Flex` 的后代路径上：`parentData` 的类型由父级渲染对象准备，类型不匹配时，框架在 `attachRenderObject` 阶段的 `_updateParentData` 里校验失败、跳过 `applyParentData`，并把 `Incorrect use of ParentDataWidget.` 作为错误报告出来（debug 下经 `_reportException`，见实验 4）。
3. **`Center` 只在自己的盒子里算偏移，盒子的尺寸由父级给的约束决定，所以"`Row` 里套 `Center` 没效果"是约束作用下的必然结果，并不是 bug。** `Row` 给非 flex 孩子的主轴 `maxWidth` 是无限（`flex.dart:881`），`RenderPositionedBox` 在这根轴上就 shrink-wrap，剩余空间为 0（实验 1：`centerSize=Size(40.0, 80.0)`、x=0）。想让 `Center` 在主轴上生效，得先给它一个确定的槽位——`Expanded`（实验 2：`centerSize=Size(320.0, 80.0)`、x=140），或者干脆把主轴的居中交给 `RenderFlex` 的 `mainAxisAlignment`（`_distributeSpace`，`flex.dart:228`）。

**`Center` 只会"在自己的盒子里摆孩子"，`Row` / `Column` 才会"切开父级的空间分给孩子"，而 `Flexible` / `Expanded` 不摆也不切，它们的全部工作是把 `flex` 与 `fit` 两个数字写进孩子身上的 `FlexParentData`——首次挂载时经 `attachRenderObject` 的 `_updateParentData` 写入，后续 widget 更新经 `ProxyElement.update` → `ParentDataElement.notifyClients` → `_applyParentData` 再写一次——这把同一行代码的布局结果完全交到了父级 `RenderFlex` 手里。**

## 八、边界声明

- **约束模型本身**（`BoxConstraints` 的字段语义、`loosen` / `tight` / `constrain` 的含义、约束向下尺寸向上）是第 33 篇，本文只用"`maxWidth == infinity` 会让 `RenderPositionedBox` shrink-wrap"这一条结论。
- **flex 的空间分配算法与溢出判定**是第 34 篇：`spacePerFlex` 只算一次、`Flexible` 省下的空间不会给后面的 `Expanded`、`_overflow` 与 `DebugOverflowIndicatorMixin` 的"只报一次"，本文只在实验 3 里引用了一组数据当旁证，不重讲推导。
- **三棵树与装配链路**是第 44 篇：`slot` 不是下标、`insertRenderObjectChild` 的三种 child 模型、`owner` 的继承、`ParentDataElement` 为什么会是复数，本文只截取 `mount` / `attachRenderObject` / `_updateParentData` 三个调用点。
- **`Alignment` 的映射数学**（`alongOffset` / `alongSize` / `withinRect` / `inscribe`、`AlignmentDirectional` 的 resolve）是第 12 篇，本文只用到 `alignChild` 里那一行。
- 本文不展开：`CrossAxisAlignment.baseline` 的基线对齐细节、`mainAxisSize` 与 `computeDryLayout` / intrinsic 尺寸、`spacing` 对尺寸的影响、`Wrap` / `Stack` / `CustomMultiChildLayout` 这类其他多孩子布局、`RenderFlex` 的裁剪与黄黑条纹绘制、以及 SDK 源码里没有的 engine 与 GPU 部分。
- `RenderPositionedBox` 的其他子类（`RenderConstrainedOverflowBox`、`RenderSizedOverflowBox` 等，`shifted_box.dart:635` 起）与 `OverflowBox` / `FractionallySizedBox` 一族不在本文范围内，需要时按类名单独读。
