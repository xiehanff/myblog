# 34 RenderFlex：flex 分配与 overflow 判定

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/flex.dart`（1505 行）、`rendering/debug_overflow_indicator.dart`（342 行）

## 一、问题

`Row` / `Column` 是写得最多的 Widget，`RenderFlex` 也是 `rendering` 里被读得最多的 RenderObject。但有两个问题很少有人能答准：

1. **`Flexible` 用不完自己那份空间时，剩下的空间会给后面的 `Expanded` 吗？**
2. **"RenderFlex overflowed by XX pixels" 里的 XX 是怎么算出来的？为什么有时改了布局错误却不打印了？**

错误直觉：

- 第一个问题的答案是**不会**。`_computeSizes` 里 `spacePerFlex` 只算一次（`flex.dart:1259`），之后每个 flex 孩子的份额都是 `spacePerFlex * flex`（`flex.dart:1267`），**不随前面孩子实际用掉多少而重算**。`Flexible` 省下的空间变成 `mainAxisFreeSpace`，交给 `mainAxisAlignment` 去分配，而不是给后面的 `Expanded`。
- 第二个问题的答案是**溢出量不在 `performLayout` 里报，而在 `paint` 里报**（`debug_overflow_indicator.dart:285` → `_reportOverflow`）。而且 `_overflowReportNeeded` 一旦被消费就置 false，**直到热重载（`reassemble`）才会重置**（`debug_overflow_indicator.dart:338`）。所以同一个 RenderFlex 的溢出错误**一辈子只打印一次**。

`RenderFlex` 的 `performLayout` 只算出尺寸和位置，**一行错误信息都不打印**。溢出量的计算只是 `_overflow = math.max(0.0, -sizes.mainAxisFreeSpace)`（`flex.dart:1337`）这一句，真正测量并报告发生在 `paint` 阶段。

## 二、最小 Demo

```dart
import 'package:flutter/widgets.dart';

/// 观察 Flexible 省下的空间去哪了。
class FlexFreeSpaceLab extends StatelessWidget {
  const FlexFreeSpaceLab({super.key});

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: SizedBox(
          width: 300,
          height: 50,
          child: Row(
            // 1. 把 spaceBetween 打开，就能从第二个孩子的位置看出剩余空间
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              // 2. Flexible 默认 flex = 1、fit = loose：份额 150，但只用了 20
              Flexible(child: SizedBox(width: 20, height: 10)),
              // 3. Expanded 是 fit = tight、flex = 1：份额 150，全部用满
              Expanded(child: SizedBox(height: 10)),
            ],
          ),
        ),
      ),
    );
  }
}
```

这个布局的运行结果：

```text
两个孩子宽度  = [20.0, 150.0]
两个孩子偏移  = [0.0, 150.0]      // spaceBetween 把 130 的剩余空间全塞到中间
Row 自己的尺寸 = Size(300.0, 50.0)
```

**如果剩余空间会重新分配，第二个孩子应该拿到 280 宽。实际是 150。** 溢出实验只需要一个 `Row` 加两个固定宽孩子：`SizedBox(width: 150, height: 50, child: Row(children: [SizedBox(width: 100, height: 10), SizedBox(width: 100, height: 10)]))`，控制台输出 `A RenderFlex overflowed by 50 pixels on the right.`

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering/flex.dart:412` | `class RenderFlex extends RenderBox with ... DebugOverflowIndicatorMixin` |
| `rendering/flex.dart:126` | `class FlexParentData`，`flex` / `fit` 两个字段（`:133` / `:142`） |
| `rendering/flex.dart:1205` | `_computeSizes`，**全文的主角**，两趟分配 |
| `rendering/flex.dart:1258` | `final double flexSpace = math.max(0.0, maxMainSize - accumulatedSize.mainAxisExtent);` |
| `rendering/flex.dart:1267` | `final double maxChildExtent = spacePerFlex * flex;` |
| `rendering/flex.dart:1337` | `_overflow = math.max(0.0, -sizes.mainAxisFreeSpace);` |
| `rendering/flex.dart:1400` | `paint`，溢出的分支都在这 |
| `rendering/debug_overflow_indicator.dart:261` | `FlutterError('A $runtimeType overflowed by $overflowText.')` |

表中只列追这条链的主入口；其余锚点随第四、六节的正文就近给出，不重复列。

## 四、调用链

### 4.1 两趟分配：`_computeSizes` 的结构

`_computeSizes`（`flex.dart:1205`）被三处调用：`performLayout`、`computeDryLayout`、`computeDryBaseline`。所以它是"纯计算"，不产生副作用。它的骨架是两趟遍历加一步收敛：

```dart
// rendering/flex.dart:1212-1229（节选）
final double maxMainSize = _getMainSize(constraints.biggest);   // 主轴最大可用
final bool canFlex = maxMainSize.isFinite;                      // 主轴无限则不能 flex
final BoxConstraints nonFlexChildConstraints = _constraintsForNonFlexChild(constraints);
var totalFlex = 0;
RenderBox? firstFlexChild;
// Initially, accumulatedSize is the sum of the spaces between children in the main axis.
var accumulatedSize = _AxisSize._(Size(spacing * (childCount - 1), 0.0));   // ← 先记上所有间距
```

**第一趟**（`flex.dart:1230-1250`）按 child list 顺序遍历：`canFlex && _getFlex(child) > 0` 时只累加 `totalFlex`（**不布局**）并记下 `firstFlexChild`；否则用 `nonFlexChildConstraints` 布局它并把尺寸累加进 `accumulatedSize`。

`accumulatedSize` 的初值是 `spacing * (childCount - 1)`——**`spacing` 从一开始就被算进"已占用空间"**，这解释了 `flex.dart:682-690` 文档里说的"spacing 非零时布局尺寸会大于孩子尺寸之和"。

**第二趟**（`flex.dart:1257-1286`）：

```dart
// rendering/flex.dart:1257-1277（节选）
// The second pass distributes free space to flexible children.
final double flexSpace = math.max(0.0, maxMainSize - accumulatedSize.mainAxisExtent);   // 1. 剩余空间
final double spacePerFlex = flexSpace / totalFlex;                                      // 2. 每份 flex 值多少像素
for (var child = firstFlexChild; child != null && totalFlex > 0; child = childAfter(child)) {
  final int flex = _getFlex(child);
  if (flex == 0) {
    continue;
  }
  totalFlex -= flex;                                                                    // 3. 只服务于循环条件
  assert(spacePerFlex.isFinite);
  final double maxChildExtent = spacePerFlex * flex;                                    // 4. 份额固定
  final BoxConstraints childConstraints = _constraintsForFlexChild(child, constraints, maxChildExtent);
  final childSize = _AxisSize.fromSize(size: layoutChild(child, childConstraints), direction: direction);
  accumulatedSize += childSize;                                                         // 5. 实际用量
}
```

第 3 步 `totalFlex -= flex` **看起来像"重新计算 `spacePerFlex`"**，但它后面并没有再除一次——第 4 步用的是**第二趟开始前算好的 `spacePerFlex`**。所以这个自减只服务于循环条件 `totalFlex > 0`，**不产生任何重新分配**。

这条细节决定了两个高频现象的答案：

| 现象 | 原因 |
|---|---|
| `Flexible` 用不完的空间不会给后面的 `Expanded` | 份额在第二趟开始前就分好了 |
| `Row` 的总占用可能明显小于自身宽度 | 差额变成 `mainAxisFreeSpace`，交给 `mainAxisAlignment` |

### 4.2 `fit` 的差异只在"min 是否为 0"

`Flexible` 和 `Expanded` 的区别只有一行——`FlexFit.loose` vs `FlexFit.tight`。这个差异体现在 `_constraintsForFlexChild` 里：

```dart
// rendering/flex.dart:901-933（节选）
BoxConstraints _constraintsForFlexChild(RenderBox child, BoxConstraints constraints, double maxChildExtent) {
  final double minChildExtent = switch (_getFit(child)) {
    FlexFit.tight => maxChildExtent,       // ← tight：min = max，孩子被钉死在这个尺寸
    FlexFit.loose => 0.0,                  // ← loose：min = 0，孩子可以更小
  };
  // 交叉轴是否 tight 由 crossAxisAlignment == stretch 决定，与 fit 无关
  final bool fillCrossAxis = crossAxisAlignment == CrossAxisAlignment.stretch;
  return switch (_direction) {
    Axis.horizontal => BoxConstraints(
      minWidth: minChildExtent,            // ← 主轴只有这一个字段随 fit 变化
      maxWidth: maxChildExtent,
      minHeight: fillCrossAxis ? constraints.maxHeight : 0.0,
      maxHeight: constraints.maxHeight,
    ),
    Axis.vertical => ...                   // 宽高互换，结构相同
  };
}
```

同一个 300 宽的 `Row` 里 `[Flexible(child: SizedBox(width: 20)), Expanded(child: SizedBox(width: 20))]`：

```text
孩子宽度 = [20.0, 150.0]
```

第一项：`Flexible` 是 loose，min = 0，所以 `SizedBox` 的 20 生效（份额 150 没用满）。
第二项：`Expanded` 是 tight，min = max = 150，`SizedBox(width: 20)` 被强制拉到 150。

`Expanded` 里的 `SizedBox(width: 20)` 是**完全失效的**，因为 tight 约束下 `enforce` 会把 20 夹成 150（这正是 33 篇实验 6 的机制）。想让 `Expanded` 里的孩子在某个范围内自由选尺寸，要改用 `Flexible`。

**另一个必须知道的点**：`_constraintsForFlexChild` 同时保留了 `maxWidth: maxChildExtent`，但 **`crossAxisAlignment` 只控制交叉轴是否 tight，不控制主轴**。主轴方向永远由 `minChildExtent` 决定松紧。

### 4.3 非 flex 孩子的约束：只约束交叉轴

`_constraintsForNonFlexChild`（`flex.dart:881-899`）的结构很简单：

```dart
// rendering/flex.dart:881-899（节选）
BoxConstraints _constraintsForNonFlexChild(BoxConstraints constraints) {
  final bool fillCrossAxis = crossAxisAlignment == CrossAxisAlignment.stretch;
  return switch (_direction) {
    Axis.horizontal => fillCrossAxis
        ? BoxConstraints.tightFor(height: constraints.maxHeight)   // 交叉轴 tight
        : BoxConstraints(maxHeight: constraints.maxHeight),        // 交叉轴 loose
    Axis.vertical => ... ,                                          // 宽高互换
  };
}
```

**主轴方向完全没有约束**（min = 0，max = ∞）。所以 `Row` 的普通孩子"想要多宽就多宽"，`Row` 事后按实际宽度累加。这就是"`Row` 里的 `Text` 不会被自动换行"的原因——它拿到的主轴约束是无限的，于是按一整行排版。

`CrossAxisAlignment.stretch` 时交叉轴变成 `tightFor`，孩子被强制撑满交叉轴。

### 4.4 主轴无限：`canFlex` 的防御

`canFlex = maxMainSize.isFinite`（`flex.dart:1213-1214`）。主轴无界时（例如把 `Row` 放进横向 `ListView`），第一趟里 `flex > 0` 的孩子因为 `canFlex` 为 false 而走 `else` 分支、用 `nonFlexChildConstraints` 布局——**`Expanded` 的 `flex` 被完全忽略，退化成普通孩子**。`flex.dart:1253-1255` 有一条 assert 钉住这件事（`firstFlexChild == null || canFlex`），保证 `firstFlexChild` 非空时主轴必定有限，所以 `spacePerFlex` 永远不会是 NaN。

把 `Expanded` 放进主轴无界的容器里不会崩，但 `Expanded` 不生效。这就是"`Expanded` 在 `ListView` 里被忽略"的源码依据。

### 4.5 尺寸收敛：`MainAxisSize` 与 `applyConstraints`

第二趟结束后：

```dart
// rendering/flex.dart:1298-1312（节选）
final double idealMainSize = switch (mainAxisSize) {
  MainAxisSize.max when maxMainSize.isFinite => maxMainSize,     // max + 有限 → 撑满
  MainAxisSize.max || MainAxisSize.min => accumulatedSize.mainAxisExtent,   // 否则按孩子实际
};

final _AxisSize constrainedSize = _AxisSize(
  mainAxisExtent: idealMainSize,
  crossAxisExtent: accumulatedSize.crossAxisExtent,
).applyConstraints(constraints, direction);                       // ← 最后过一遍约束

return _LayoutSizes(
  axisSize: constrainedSize,
  mainAxisFreeSpace: constrainedSize.mainAxisExtent - accumulatedSize.mainAxisExtent,
  baselineOffset: accumulatedAscentDescent.baselineOffset,
  spacePerFlex: firstFlexChild == null ? null : spacePerFlex,
);
```

三个细节：

1. **`MainAxisSize.max` 在主轴有限时才撑满**。主轴无限时退回 `accumulatedSize`。所以一个横向无界的 `Row(mainAxisSize: max)` 不会变成无限宽。
2. **`applyConstraints` 是最后一道关**（`flex.dart:40-46`），把 `_AxisSize` 过一遍 `constraints.constrain`。所以 `Column(mainAxisSize: min)` 在父给的 tight 高度下仍会被拉到父的高度。
3. **`mainAxisFreeSpace` 可以是负数**。它的定义是 `final - accumulated`，负数表示溢出。`flex.dart:91-93` 的注释写得很明确："A negative value indicates the RenderFlex overflows along the main axis."

### 4.6 摆放：`_distributeSpace`、`spacing` 与溢出时的对齐抹平

```dart
// rendering/flex.dart:1336-1347（节选）
size = sizes.axisSize.toSize(direction);
_overflow = math.max(0.0, -sizes.mainAxisFreeSpace);                   // ← 溢出量的唯一来源
final double remainingSpace = math.max(0.0, sizes.mainAxisFreeSpace);  // ← 用 max 抹掉负数
final (double leadingSpace, double betweenSpace) = mainAxisAlignment._distributeSpace(
  remainingSpace, childCount, _flipMainAxis, spacing,                  // → 起始留白 + 孩子间隔
);
```

`_distributeSpace`（`flex.dart:228`）返回一对值：**起始留白** + **孩子之间的间隔**。核心公式：

| `mainAxisAlignment` | `leadingSpace` | `betweenSpace` |
|---|---|---|
| `start` | `0` | `spacing` |
| `center` | `freeSpace / 2` | `spacing` |
| `end` | `freeSpace` | `spacing` |
| `spaceBetween`（≥2 个孩子） | `0` | `freeSpace / (itemCount - 1) + spacing` |
| `spaceAround`（≥1 个孩子） | `freeSpace / itemCount / 2` | `freeSpace / itemCount + spacing` |
| `spaceEvenly` | `freeSpace / (itemCount + 1)` | `freeSpace / (itemCount + 1) + spacing` |

`[20, 150]` 那两个孩子在 `spaceBetween` 下的偏移是 `[0.0, 150.0]`——`betweenSpace = 130 / 1 + 0 = 130`，第二个孩子在 `20 + 130 = 150`，公式对得上。`spaceBetween` / `spaceAround` 还有**退化保护**（`flex.dart:244` / `250`）：孩子少于 2 个（或 0 个）时委托给 `start`，避免除零。

`remainingSpace` 用 `math.max(0.0, ...)`，`_overflow` 用 `math.max(0.0, -...)`，同一个数的两种取法，**保证溢出时 `remainingSpace` 为 0**——溢出时不做任何对齐。所以 `Row` 溢出时永远从 `start` 开始排、末尾那个孩子被截，`center` / `end` 全部失效。

### 4.7 溢出判定与报告：分离在两个阶段，并且只报一次

`performLayout` 只算出 `_overflow`；判定与报告都在 `paint`：

```dart
// rendering/flex.dart:1400-1418（节选）
void paint(PaintingContext context, Offset offset) {
  if (!_hasOverflow) {
    defaultPaint(context, offset);         // 不溢出 → 普通绘制，零额外开销
    return;
  }
  if (size.isEmpty) {
    return;
  }
  _clipRectLayer.layer = context.pushClipRect(
    needsCompositing, offset, Offset.zero & size, defaultPaint,
    clipBehavior: clipBehavior, oldLayer: _clipRectLayer.layer,
  );
  ...
}
```

判定带 epsilon（`flex.dart:623-626`），`precisionErrorTolerance` 是 `1e-10`（`foundation/constants.dart:71`）：

```dart
double _overflow = 0;
bool get _hasOverflow => _overflow > precisionErrorTolerance;
```

报告通过一个**假的 childRect** 传给 `paintOverflowIndicator`：

```dart
// rendering/flex.dart:1445-1456（节选）
final Rect overflowChildRect = switch (_direction) {
  Axis.horizontal => Rect.fromLTWH(0.0, 0.0, size.width + _overflow, 0.0),
  Axis.vertical => Rect.fromLTWH(0.0, 0.0, 0.0, size.height + _overflow),
};
paintOverflowIndicator(context, offset, Offset.zero & size, overflowChildRect,
    overflowHints: debugOverflowHints);
```

注意注释原话——"This child rect is never used for drawing, just for determining the overflow location and amount"。`debug_overflow_indicator.dart:292` 用 `RelativeRect.fromRect(containerRect, childRect)` 算出四条边的溢出量，**所以 `RenderFlex` 自己不知道"哪条边溢出"，只知道多了多少像素**，方向由这个假矩形和 `_direction` 共同决定。

报告侧有一道去重（`debug_overflow_indicator.dart:327-328`）：`if (_overflowReportNeeded) { _overflowReportNeeded = false; _reportOverflow(...); }`，而 `_overflowReportNeeded` 只在 `reassemble()`（热重载）里被重置为 true（`debug_overflow_indicator.dart:335-339`）。

同一棵树下连续三帧把溢出量从 0.5 加到 2.0，`FlutterError.onError` **只被触发一次**；热重载后才能再报。这条机制解释了"改了代码让溢出变严重，控制台却不再打印"——不是没溢出，是报告已被消费。

整段报告代码还包在 `assert(() { ... }())` 里（`flex.dart:1420-1457`），所以 **release 构建里没有黄黑条纹也没有报告**。但 `_overflow` / `_hasOverflow` 仍会计算，`pushClipRect`（`flex.dart:1411`）仍会执行——而 `clipBehavior` 默认是 `Clip.none`，`pushClipRect` 遇到它直接画完返回 null（`object.dart:579-582`），所以默认情况下溢出内容是**画出去但不裁剪**的。要裁掉得显式设 `clipBehavior`。

## 五、核心对象：三组对比

| | flex 孩子（`flex > 0`） | 非 flex 孩子（`flex == 0` / null） |
|---|---|---|
| 何时布局 | 第二趟 | 第一趟 |
| 主轴约束 | `[minChildExtent, spacePerFlex * flex]` | **无约束**（min 0，max ∞） |
| 交叉轴约束 | 由 `crossAxisAlignment` 决定 | 同左 |
| 尺寸决定权 | 父给份额，孩子在其中选（loose）或被钉死（tight） | 孩子自己说了算 |
| 是否影响 `totalFlex` | 是 | 否 |
| 主轴无限时 | 退化为非 flex 孩子（`canFlex = false`） | 不变 |

| | `FlexFit.tight`（`Expanded`） | `FlexFit.loose`（`Flexible`） |
|---|---|---|
| `minChildExtent` | `maxChildExtent` | `0.0` |
| 孩子最终尺寸 | 等于份额 | `clamp(自身愿望, 0, 份额)` |
| 孩子的 `SizedBox` | **失效**（被 `enforce` 夹掉） | 生效（只要不超过份额） |
| 用不完的份额 | 不可能 | 变成 `mainAxisFreeSpace`，交给 `mainAxisAlignment` |
| 默认 | 是（`flex.dart:821` 的 `?? FlexFit.tight`） | 需显式 `Flexible(fit: FlexFit.loose)` 或直接用 `Flexible` |

| | `performLayout` 阶段 | `paint` 阶段 |
|---|---|---|
| 溢出相关动作 | 算 `_overflow`（`flex.dart:1337`） | 判 `_hasOverflow`、裁剪、报告 |
| 是否受 `kReleaseMode` 影响 | 否 | 报告部分仅在 debug（assert 包裹） |
| 是否每帧执行 | 只在脏时 | 只在脏时，但报告有"只报一次"去重 |
| 是否有额外开销 | 无 | 不溢出时零开销（`defaultPaint` 直通） |

## 六、源码实验

### 实验 1：`spacePerFlex` 只算一次，剩余空间不重分配

```dart
SizedBox(
  width: 300, height: 50,
  child: Row(
    mainAxisAlignment: MainAxisAlignment.spaceBetween,
    children: <Widget>[
      Flexible(child: SizedBox(width: 20, height: 10)),
      Expanded(child: SizedBox(width: 20, height: 10)),
    ],
  ),
)
```

用 `tester.renderObject<RenderFlex>(find.byType(Row))` 读出孩子尺寸与偏移。

**预测**：`Flexible` 只用了 20，省下 130，`Expanded` 应该拿到 150 + 130 = 280；第二个 `SizedBox(width: 20)` 应该也保持 20。

**实际**：

```text
widths=[20.0, 150.0]
offsets=[0.0, 150.0]
row size=Size(300.0, 50.0)
```

**说明**：三个结论一次拿到。

1. `Expanded` 拿到的是 **150**（= `spacePerFlex(150) * flex(1)`），不是 280。省下的 130 全部落到 `betweenSpace`（`spaceBetween` 把它塞到两个孩子之间，所以第二个孩子偏移 150）。**"`Flexible` 让出的空间会被后面的 `Expanded` 吃掉"是错的。**
2. `Expanded` 里的 `SizedBox(width: 20)` **被强制拉到 150**——tight 约束下 `min = max`，`SizedBox` 的 20 被 `enforce` 夹掉（机制在 33 篇）。
3. `Flexible` 里的 `SizedBox` 保持 20——loose 约束下 `min = 0`，`SizedBox` 的 tight 20 生效。

### 实验 2：溢出量怎么算出来的

```dart
SizedBox(width: 150, height: 50, child: Row(children: <Widget>[
  SizedBox(width: 100, height: 10),
  SizedBox(width: 100, height: 10),
]))
```

**预测**：控制台输出 `overflowed by 50 pixels`。

**实际**：

```text
row size=Size(150.0, 50.0)
ERROR: A RenderFlex overflowed by 50 pixels on the right.
```

**说明**：`_overflow = max(0, -mainAxisFreeSpace) = max(0, -(150 - 200)) = 50`。`Row` 的**自身尺寸仍然是 150（不溢出增长）**——`applyConstraints` 把 `idealMainSize` 夹回了约束。溢出只体现在 `_overflow` 这个字段和报告文本里，不影响 `size`。同一段代码竖过来变成 `Column` 时，输出是 `overflowed by 30 pixels on the bottom.`，单位与方向随 `_direction` 变。

### 实验 3：epsilon 与"只报一次"

```dart
// 溢出量 1e-11（小于 precisionErrorTolerance = 1e-10）
SizedBox(width: 100, height: 20, child: Row(children: <Widget>[
  SizedBox(width: 100, height: 10),
  SizedBox(width: 1e-11, height: 10),
]))
```

再用同一棵树下连续 pump 三帧，把溢出量从 0.5 加到 2.0，统计 `FlutterError.onError` 的触发次数。

**预测**：三个溢出量应该各报一次，共 3 次。

**实际**：

```text
over=1e-11         -> overflow errors=0        // 被 epsilon 吃掉
over=0.5           -> overflow errors=1
frames: after1=1 after2=1 after3=1             // 同一棵树三帧只报 1 次
```

**说明**：两个结论。第一，`_hasOverflow` 用 `_overflow > precisionErrorTolerance`（`flex.dart:626`），所以 1e-11 级别的主轴超额**不算溢出**，不会有黄黑条纹也不报错。第二，`_overflowReportNeeded`（`debug_overflow_indicator.dart:127`）在首次报告后置 false，之后即使溢出加剧也不再打印，**只有 `reassemble()`（热重载）会重置**（`debug_overflow_indicator.dart:338`）。

### 实验 4：溢出时的对齐被抹平

```dart
SizedBox(width: 150, height: 50, child: Row(
  mainAxisAlignment: MainAxisAlignment.center,
  children: <Widget>[
    SizedBox(width: 100, height: 10),
    SizedBox(width: 100, height: 10),
  ],
))
```

**预测**：`center` 应该让内容向中间溢出（两边各露一部分）。

**实际**：`mainAxisFreeSpace` 是 `150 - 200 = -50`，`remainingSpace = math.max(0.0, -50) = 0`（`flex.dart:1339`），所以 `_distributeSpace` 收到 0，`leadingSpace = 0`（源码依据：`flex.dart:1336-1347`）。运行结果印证：

```text
row size=Size(150.0, 50.0)
offsets=[0.0, 100.0]              // 第一个孩子在 0（若 center 生效，这里应该是 -25）
ERROR: A RenderFlex overflowed by 50 pixels on the right.
```

**说明**：这是"溢出时只能往右下溢出"的源码依据与实测依据。`Row` 溢出时永远是末尾那个孩子被截，不会两边对称溢出。

## 七、结论

1. `_computeSizes` 是两趟遍历：第一趟布局非 flex 孩子并累加 `totalFlex`（`accumulatedSize` 初值已含 `spacing * (childCount - 1)`），第二趟按 `spacePerFlex * flex` 给每个 flex 孩子分配份额。**`spacePerFlex` 在第二趟开始前算定，之后不重算**（`flex.dart:1259` / `1267`），所以 `Flexible` 没用的份额会变成 `mainAxisFreeSpace` 交给 `mainAxisAlignment`，**不会补给后面的 `Expanded`**。
2. `Expanded` 与 `Flexible` 的差异只在 `_constraintsForFlexChild` 里的 `minChildExtent`（`flex.dart:908-911`）：tight 时 `min = max`，loose 时 `min = 0`。`Expanded` 里的 `SizedBox` / `ConstrainedBox` 会被 `enforce` 完全夹掉，所以"想给 `Expanded` 里的孩子设尺寸"必须改用 `Flexible`。
3. 溢出量是 `_overflow = math.max(0.0, -sizes.mainAxisFreeSpace)`（`flex.dart:1337`）一行算出来的，判定用 `_overflow > 1e-10`（`flex.dart:626`），**报告发生在 `paint` 而不是 `performLayout`**，并且整个报告代码包在 `assert` 里。`_overflowReportNeeded` 让同一个 `RenderFlex` 的溢出错误**一辈子只打印一次**，直到热重载（`debug_overflow_indicator.dart:127` / `338`）。

**flex 的份额是"先算好再发"的，溢出是"先算好再画"的——两件事都不在布局阶段完成。**

## 八、边界声明

- 本文只讲 `RenderFlex` 的主轴分配，交叉轴只讲 `CrossAxisAlignment` 对约束松紧的影响，不展开 baseline 对齐的完整实现（`_AscentDescent` 的聚合与 `baselineOffset` 的使用）。
- `spacing` 是 3.44 新增的参数，本文只讲它进入 `accumulatedSize` 初值和 `_distributeSpace`，不对比旧版本行为。
- 内在尺寸（`_getIntrinsicSize`，`flex.dart:711`）与 `computeDryLayout` / `computeDryBaseline` 复用 `_computeSizes` 的部分不在本文展开。
- `RenderWrap`（`wrap.dart`）、`RenderStack`（`stack.dart`）的多孩子分配不在本卷展开，它们的协议与 `RenderFlex` 不同。
- `debug_overflow_indicator.dart` 里的黄黑条纹绘制细节（`_calculateOverflowRegions`、`_OverflowRegionData`）只讲到"报告"为止，不展开绘制实现。
- "`Expanded` 里的 `SizedBox` 不生效"与"`Expanded` 在无界主轴里失效"这两种现象，与 33 篇的 `enforce` 语义互为因果，可对照阅读。
