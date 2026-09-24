# 60 RenderSliverGrid 与 RenderTable：两种网格的布局算法

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/sliver_grid.dart`（729 行）、`packages/flutter/lib/src/rendering/table.dart`（1595 行）、`packages/flutter/lib/src/widgets/table.dart`（508 行）、`packages/flutter/lib/src/widgets/sliver.dart`（1924 行）、`packages/flutter/lib/src/widgets/scroll_view.dart`（2235 行）

## 一、问题

rendering 层有两种"不是列表"的多子布局：滚动的 Sliver 网格（`RenderSliverGrid`）与不滚动的表格（`RenderTable`）。本文只追一个问题：**格子的大小和位置是谁算出来的、按什么顺序算的。** sliver 协议本身是第 47 篇，懒加载与回收是第 48 篇，flex 分配是第 34 篇，这三块一律只引用结论。

### 先拆掉两个错误直觉

**直觉一："GridView 是多个列表拼起来的"，或者"每个格子先量一下再摆"。** 两个说法都不对。`GridView` 的核心 `buildChildLayout` 只创建**一个** `SliverGrid`（render 对象即 `rendering/sliver_grid.dart:561` 的 `RenderSliverGrid`），不会按列拆成多个列表，不存在"几列就是几个列表"；若设置了 `padding`（或 MediaQuery 带来了 padding），`BoxScrollView.buildSlivers` 还会在它外面再包一层 `SliverPadding`（`scroll_view.dart:898-932`），但核心网格自始至终只有这一个 sliver。格子的尺寸也不来自对孩子的测量：`SliverGridDelegate.getLayout` 拿当前 `SliverConstraints` 换算出一组等差参数（列数、主轴步长、交叉轴步长、两个格子边长，`sliver_grid.dart:392-407`），之后 `SliverGridRegularTileLayout.getGeometryForChildIndex` 用 `index % crossAxisCount` 和 `index ~/ crossAxisCount` 两条整数公式直接算出任意格子的位置（`:246-254`），孩子拿到的是 tight 约束（`:80-86`），自己说了不算。还有一种更细的误会——"delegate 离线算好一张 geometry 表，渲染时按索引查表"。3.44.8 里没有这张表，也没有 `getGeometryForTileIndex` 这样的 API；`SliverGridLayout` 是一个**按索引现算的公式对象**（`sliver_grid.dart:130`），每次调用 `getGeometryForChildIndex` 都是当场用除法和取余求值，从不物化成数组。

**直觉二："Table 等价于 Column 嵌套 Row"。** 结构上就不等价。`RenderTable` 是单个 `RenderBox`（`rendering/table.dart:361`），孩子以行优先的一维数组存放（`:402`）；它先对**全部列**统一解一次列宽（`_computeColumnWidths`，`:1068`），再用同一组列宽给每个 cell 发 `BoxConstraints.tightFor(width: ...)`（`:1382`）。嵌套 Flex 是每行各自求解、行与行之间互不知情，列边界天然对不齐；Table 的列边界天然对齐，因为宽度是全表一次求出来的。行高也一样：在 `performLayout` 的逐行循环里**内联**求出（max cell 高，或 baseline 对齐时的 before/after 距离之和，`:1410-1415`）——3.44.8 里没有独立的"行高求解方法"，也没有 `computeRowHeights` 这样的方法。

> SliverGrid 用一组 stride 参数按索引现算格子，child 的宽高和位置由 geometry/tight 约束固定；RenderTable 用一次全表列宽求解统一决定 cell 的 x 和列宽，但 cell 仍可决定高度，其高度/基线会参与行高和垂直 offset 的求解——孩子被固定的范围，SliverGrid 是全部，RenderTable 只有横向。

## 二、最小 Demo

### 2.1 网格：切换 childAspectRatio，看孩子拿到什么约束

```dart
import 'package:flutter/material.dart';

class GridGeometryPage extends StatefulWidget {
  const GridGeometryPage({super.key});

  @override
  State<GridGeometryPage> createState() => _GridGeometryPageState();
}

class _GridGeometryPageState extends State<GridGeometryPage> {
  double _aspectRatio = 2.0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('childAspectRatio = $_aspectRatio')),
      body: SizedBox(
        // 1. 固定交叉轴宽度，公式才有可预期的整数解（此处 300 / 3 列 = 每格宽 100）
        width: 300,
        child: GridView.builder(
          // 2. 固定列数 delegate：间距全 0、宽高比可切换
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            childAspectRatio: _aspectRatio,
          ),
          itemCount: 9,
          itemBuilder: (BuildContext context, int index) {
            return LayoutBuilder( // 3. 读孩子实际拿到的约束：tight 还是有余地
              builder: (BuildContext context, BoxConstraints constraints) {
                debugPrint('index=$index constraints=$constraints');
                return ColoredBox(
                  color: Colors.teal[100 * ((index % 9) + 1)],
                  child: Center(child: Text('$index')),
                );
              },
            );
          },
        ),
      ),
      floatingActionButton: FloatingActionButton(
        // 4. 切换宽高比 2.0 ↔ 0.5：格子高、行距、总滚动长度应一起变
        onPressed: () => setState(() {
          _aspectRatio = _aspectRatio == 2.0 ? 0.5 : 2.0;
        }),
        child: const Icon(Icons.swap_vert),
      ),
    );
  }
}
```

### 2.2 表格：三种列宽算法混合 + baseline 对齐

```dart
import 'package:flutter/material.dart';

class TablePage extends StatelessWidget {
  const TablePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Table(
          // 1. 三列三种算法：固定宽 / 按内容 / 弹性
          columnWidths: const <int, TableColumnWidth>{
            0: FixedColumnWidth(80),
            1: IntrinsicColumnWidth(),
            2: FlexColumnWidth(),
          },
          // 2. baseline 对齐必须显式给 textBaseline，否则构造断言直接失败
          defaultVerticalAlignment: TableCellVerticalAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          border: TableBorder.all(),
          children: const <TableRow>[
            TableRow(children: <Widget>[
              Text('固定 80'),
              Text('按内容'),
              Padding(padding: EdgeInsets.all(24), child: Text('弹性')),
            ]),
            // 3. 每行列数必须一致，否则构造断言抛 Table contains irregular row lengths.
            TableRow(children: <Widget>[Text('A'), Text('BB'), Text('CCC')]),
          ],
        ),
      ),
    );
  }
}
```

第二个 Demo 有两个可观察点：第一行第三列的 `Padding` 会使第一行前两格按共同 baseline 下移——基线距离是**逐行重置、行内跨列**统一收集后再放置的（`table.dart:1366-1368`）；第二行重新独立收集自己的 baseline，第一行的 `Padding` 不会改变第二行 cell 的对齐。把 `Table` 换进横向 `SingleChildScrollView`（实验 2）还能看到 `FlexColumnWidth` 整列塌成 0。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering/sliver_grid.dart:41` | `SliverGridGeometry`：单个格子的四元组（scrollOffset / crossAxisOffset / mainAxisExtent / crossAxisExtent），`getBoxConstraints:80` |
| `rendering/sliver_grid.dart:130` / `:171` | `SliverGridLayout`（abstract，索引↔几何的契约，四个方法 `:136-148`）/ framework 里唯一的规则实现 `SliverGridRegularTileLayout` |
| `rendering/sliver_grid.dart:294` / `:346` / `:445` | `SliverGridDelegate`（abstract，`getLayout:300`、`shouldRelayout:308`）与两个现成实现 `WithFixedCrossAxisCount` / `WithMaxCrossAxisExtent` |
| `rendering/sliver_grid.dart:561` | `RenderSliverGrid`，`performLayout:594`；parentData 是 `SliverGridParentData:536`（比列表多一个 `crossAxisOffset:543`） |
| `rendering/table.dart:361` | `RenderTable`；列宽统一求解 `_computeColumnWidths:1068`、整体布局 `performLayout:1328`、孩子一维化入口 `setFlatChildren:809` |
| `rendering/table.dart:43` | `TableColumnWidth` 契约：`minIntrinsicWidth` / `maxIntrinsicWidth` / `flex` 三个方法；`IntrinsicColumnWidth:94`、`FixedColumnWidth:136`、`FlexColumnWidth:197` 等同文件 |
| `widgets/table.dart:118` / `:279` | `Table`（RenderObjectWidget）/ `_TableElement`（按行列 slot inflate 后整体扁平化） |
| `widgets/sliver.dart:733` / `widgets/scroll_view.dart:1964` | widget 层入口 `SliverGrid` / `GridView`（`GridView.builder:2031`、`GridView.count:2113`；`SliverGrid.builder:762`、`SliverGrid.count:793`） |

行号会漂移，类名与调用关系不会：要记住的是两条链的形状——网格是"约束 → 布局参数对象 → 索引公式"，表格是"全表列宽 → 逐行行高"。

## 四、调用链

### 4.1 widget 入口：从 GridView 到 RenderSliverGrid 只有两跳

`GridView extends BoxScrollView`（`scroll_view.dart:1964`），外壳与 `ListView` 完全同源（第 55 篇）。它实现的 hook 永远只返回一个 sliver：

```dart
// scroll_view.dart:2232-2234
Widget buildChildLayout(BuildContext context) {
  return SliverGrid(delegate: childrenDelegate, gridDelegate: gridDelegate);
}
```

`SliverGrid` 是 `SliverMultiBoxAdaptorWidget`（`sliver.dart:733`），装配只有一跳：

```dart
// widgets/sliver.dart:890-893
RenderSliverGrid createRenderObject(BuildContext context) {
  final element = context as SliverMultiBoxAdaptorElement;
  return RenderSliverGrid(childManager: element, gridDelegate: gridDelegate);
}
```

widget 重建时 `updateRenderObject` 只做一件事：`renderObject.gridDelegate = gridDelegate`（`sliver.dart:896-898`）。setter 里先比引用，再让新 delegate 的 `shouldRelayout` 判断字段是否真的变了，变了才 `markNeedsLayout`（`rendering/sliver_grid.dart:577-585`）——所以每帧传一个字段相同的新 delegate 不会触发重排。

### 4.2 第一跳：delegate 把约束换算成布局参数（getLayout）

`SliverGridDelegate` 只有两个方法（`sliver_grid.dart:300`、`:308`）：`getLayout(SliverConstraints) → SliverGridLayout` 与 `shouldRelayout`。两个现成实现的 `getLayout` 是全篇的公式源头。固定列数版：

```dart
// rendering/sliver_grid.dart:392-407（节选）
SliverGridLayout getLayout(SliverConstraints constraints) {
  final double usableCrossAxisExtent = math.max(
    0.0,
    constraints.crossAxisExtent - crossAxisSpacing * (crossAxisCount - 1), // 1. 先扣掉列间空隙
  );
  final double childCrossAxisExtent = usableCrossAxisExtent / crossAxisCount; // 2. 均分得到格子宽
  final double childMainAxisExtent = mainAxisExtent ?? childCrossAxisExtent / childAspectRatio; // 3. 主轴尺寸：显式值优先，否则由宽高比反推
  return SliverGridRegularTileLayout(
    crossAxisCount: crossAxisCount,
    mainAxisStride: childMainAxisExtent + mainAxisSpacing,  // 4. 步长 = 格子 + 间距
    crossAxisStride: childCrossAxisExtent + crossAxisSpacing,
    childMainAxisExtent: childMainAxisExtent,
    childCrossAxisExtent: childCrossAxisExtent,
    reverseCrossAxis: axisDirectionIsReversed(constraints.crossAxisDirection),
  );
}
```

注意三件事。第一，四个参数的默认值：`mainAxisSpacing`、`crossAxisSpacing` 默认 `0.0`，`childAspectRatio` 默认 `1.0`，`mainAxisExtent` 默认 `null`（`:353-358`；最大横轴版同款默认在 `:452-457`）。第二，`childAspectRatio` **不是**唯一的高度来源——它只是 `mainAxisExtent` 为 null 时的回退公式；给 `mainAxisExtent` 赋值后宽高比完全失效，高度不再随交叉轴宽度变。第三，产出的 `SliverGridRegularTileLayout` 只有六个数：列数、两个 stride、两个格子边长、交叉轴是否反向。**一次 `getLayout` 到此为止，没有任何 per-child 的工作。**

最大横轴版唯一的区别在列数怎么来：

```dart
// rendering/sliver_grid.dart:504-508
int crossAxisCount = (constraints.crossAxisExtent / (maxCrossAxisExtent + crossAxisSpacing))
    .ceil();
crossAxisCount = math.max(1, crossAxisCount); // 窗口为 0 时至少保住 1 列
```

之后的公式与固定列数版逐字相同（`:509-514`）。所以"`maxCrossAxisExtent: 150`、视口宽 500"会得到 `ceil(500/150) = 4` 列、每列 125——这正是类文档里的例子。

### 4.3 第二跳：索引公式（SliverGridRegularTileLayout）

`SliverGridLayout` 的契约是四个方法（`sliver_grid.dart:136-148`）：给定 scroll offset 求首/尾索引，给定索引求 geometry，给定 childCount 求总长度。规则实现的答案全是整数运算：

```dart
// rendering/sliver_grid.dart:246-254
SliverGridGeometry getGeometryForChildIndex(int index) {
  final double crossAxisStart = (index % crossAxisCount) * crossAxisStride; // 1. 余数 → 列槽位
  return SliverGridGeometry(
    scrollOffset: (index ~/ crossAxisCount) * mainAxisStride,              // 2. 商 → 行号 × 主轴步长
    crossAxisOffset: _getOffsetFromStartInCrossAxis(crossAxisStart),       // 3. 反向时镜像
    mainAxisExtent: childMainAxisExtent,
    crossAxisExtent: childCrossAxisExtent,
  );
}
```

- `index % crossAxisCount` 决定交叉轴槽位，`index ~/ crossAxisCount` 决定主轴行号——**格子位置只由索引和六个参数决定**，与孩子内容无关；
- `reverseCrossAxis`（来自 `crossAxisDirection`，RTL 或反向交叉轴时为 true）只在 `_getOffsetFromStartInCrossAxis`（`:235-243`）里做一次镜像；
- `getMinChildIndexForScrollOffset` / `getMaxChildIndexForScrollOffset`（`:220-234`）是逆运算：用 `scrollOffset ~/ mainAxisStride` 与 `.ceil()` 把 scroll 区间换算成索引区间；
- `computeMaxScrollOffset`（`:257-266`）按行数算总滚动长度，并减掉末尾那一格不该有的 spacing：`mainAxisStride * 行数 - (mainAxisStride - childMainAxisExtent)`。

geometry 变成孩子约束只有一步，而且是 tight 的：

```dart
// rendering/sliver_grid.dart:80-86
BoxConstraints getBoxConstraints(SliverConstraints constraints) {
  return constraints.asBoxConstraints(
    minExtent: mainAxisExtent,   // min = max：主轴尺寸没有商量余地
    maxExtent: mainAxisExtent,
    crossAxisExtent: crossAxisExtent,
  );
}
```

### 4.4 第三跳：RenderSliverGrid.performLayout 只处理一个索引区间

`performLayout`(`sliver_grid.dart:594-727`)的骨架与 `RenderSliverList` 同构(第 48 篇 4.3),差异只在“每个孩子多大”从测量换成了按索引算公式：

1. `final SliverGridLayout layout = _gridDelegate.getLayout(constraints);`（`:605`）——每次布局现场调一次 `getLayout`；
2. 用 `getMinChildIndexForScrollOffset(scrollOffset)` 和 `getMaxChildIndexForScrollOffset(targetEndScrollOffset)` 算出本帧需要的索引区间（`:607-610`），区间由 `remainingCacheExtent` 决定，垃圾回收、keepAlive 沿用第 48 篇的多 box 机制，不重讲；
3. 首孩子拿 `layout.getGeometryForChildIndex(firstIndex)`（`:621`）；一个孩子都没有时直接用 `computeMaxScrollOffset(childCount)` 当 `scrollExtent` 上报（`:626`）；
4. 向前补齐（`:638-648`）与向后推进（`:663-682`）两个循环里，每个索引都是同一套三步：`getGeometryForChildIndex(index)` → `getBoxConstraints(constraints)` → `child.layout(...)`，然后把 `layoutOffset` 与 `crossAxisOffset` 写进 `SliverGridParentData`（`:536`，比列表 parentData 多的就是这个交叉轴偏移字段 `:543`；绘制时由 `childCrossAxisPosition` 读回，`:588-591`）；
5. 总长度估计（`:690-698`）：滚到头用 `trailingScrollOffset`，否则问 `childManager.estimateMaxScrollOffset`。这一问会走到 `SliverGrid` widget 的覆写（`widgets/sliver.dart:901-916`）：children delegate 给不出估计时，回退到 `gridDelegate.getLayout(constraints).computeMaxScrollOffset(estimatedChildCount)`——**滚动条的总长度也是同一套公式的产物**；`itemCount` 为 null（无限网格）时 element 层直接返回 `double.infinity`（`widgets/sliver.dart:1147-1150`）。

### 4.5 Table 侧：widget 层先把二维行结构压成一维

`Table extends RenderObjectWidget`（`widgets/table.dart:118`），自己不 build，直接造 render 对象：`createRenderObject` 把首行长度当列数、行数当 `rows`（`:246-261`）。构造函数里有三条断言：baseline 默认对齐必须配 `textBaseline`（`:129-131`）、每行列数必须一致（`:146-160`）、cell 的 key 全表不许重复——因为 cells 会被**压平**。

压平发生在 `_TableElement`。`mount` 对每一行每一列调 `inflateWidget(child, _TableSlot(columnIndex++, rowIndex))`（`widgets/table.dart:290-307`），然后在 `_updateRenderObjectChildren` 里一次性摊平：

```dart
// widgets/table.dart:401-411（节选）
void _updateRenderObjectChildren() {
  renderObject.setFlatChildren(
    _children.isNotEmpty ? _children[0].children.length : 0,
    _children.expand<RenderBox>((_TableElementRow row) {
      return row.children.map<RenderBox>((Element child) => child.renderObject! as RenderBox);
    }).toList(),
  );
}
```

`RenderTable.setFlatChildren`（`rendering/table.dart:809-873`）整批 adopt/drop/move 孩子，最后 `markNeedsLayout`。所以渲染层看到的孩子是一个行优先的一维数组，而不是"行的列表"（`:402` 的注释原文 `Children are stored in row-major order.`），`xy = x + y * columns` 是全文件反复出现的下标公式。**这就是"表格不是 Column 嵌套 Row"在数据结构上的落地：没有中间的行容器，列宽才可能全表一次求解。**

### 4.6 RenderTable.performLayout：先全表列宽，再逐行行高

`performLayout`（`rendering/table.dart:1328-1447`）分四步：

1. **列宽**：`final List<double> widths = _computeColumnWidths(constraints);`（`:1340`）。四阶段算法见 5.2 的表，这里只强调：所有行共享这一组 `widths`。
2. **列起点**：按 `textDirection` 前缀和出每列的 x 起点，LTR 从左累加、RTL 从右累加（`:1342-1357`）。
3. **逐行两遍循环**(`:1362-1444`):第一遍对 baseline、top、middle、bottom、intrinsicHeight 的 cell 发 `BoxConstraints.tightFor(width: widths[x])` 布局(`:1382`、`:1403`),`fill` 的 cell 例外--第一遍直接 `break` 跳过(`:1405`),第二遍才按行高以 tight width/height 补布局;同时收集行高--普通对齐取 `max(rowHeight, child.size.height)`,baseline 对齐额外用 `getDistanceToBaseline(textBaseline!, onlyReal: true)` 收集 `beforeBaselineDistance` / `afterBaselineDistance`(`:1383-1392`),行高最终取 `max(rowHeight, before + after)`（`:1410-1415`）。第二遍按对齐方式放置每个 cell 的 offset：

```dart
// rendering/table.dart:1422-1439（节选，第二遍循环的 switch）
case TableCellVerticalAlignment.baseline:
  childParentData.offset = Offset(
    positions[x],
    rowTop + beforeBaselineDistance - baselines[x], // 1. 把各 cell 自己的基线抬到共同基线上
  );
case TableCellVerticalAlignment.top:
  childParentData.offset = Offset(positions[x], rowTop);
case TableCellVerticalAlignment.middle:
  childParentData.offset = Offset(positions[x], rowTop + (rowHeight - child.size.height) / 2.0);
case TableCellVerticalAlignment.bottom:
  childParentData.offset = Offset(positions[x], rowTop + rowHeight - child.size.height);
case TableCellVerticalAlignment.fill:
case TableCellVerticalAlignment.intrinsicHeight:
  child.layout(BoxConstraints.tightFor(width: widths[x], height: rowHeight)); // 2. 补一次 tight 重布局
  childParentData.offset = Offset(positions[x], rowTop);
```

4. **尺寸**：`size = constraints.constrain(Size(_tableWidth, rowTop));`（`:1446`）——表格的 size 就是全部内容排完的总尺寸，没有 paintExtent 与 scrollExtent 之分。

`computeDryLayout`（`:1288`）复用 `_computeColumnWidths` 与行高累加，但遇到 baseline 对齐会声明算不了：`debugCannotComputeDryLayout(reason: 'TableCellVerticalAlignment.baseline requires a full layout for baseline metrics to be available.')` 并返回 `Size.zero`（`:1303-1310`）——基线只有真实 `layout` 后才存在。

## 五、核心对象

### 5.1 两种 SliverGridDelegate：列数从哪来

| 维度 | `SliverGridDelegateWithFixedCrossAxisCount`（`:346`） | `SliverGridDelegateWithMaxCrossAxisExtent`（`:445`） |
|---|---|---|
| 列数来源 | 构造参数直接指定 | 现场推：`(crossAxisExtent / (maxCrossAxisExtent + crossAxisSpacing)).ceil()`，至少 1（`:504-508`） |
| 格子交叉轴尺寸 | `(crossAxisExtent - crossAxisSpacing*(列数-1)) / 列数`（`:394-398`） | 同一公式，列数换成推出来的（`:509-513`） |
| 格子主轴尺寸 | `mainAxisExtent ?? 交叉轴 / childAspectRatio`（`:399`） | 同（`:514`） |
| 参数默认值 | spacing 均 0.0、aspectRatio 1.0、mainAxisExtent null（`:353-358`） | 同（`:452-457`） |
| `shouldRelayout` 逐字段比 | 列数/两 spacing/aspectRatio/mainAxisExtent（`:410-416`） | maxCrossAxisExtent/两 spacing/aspectRatio/mainAxisExtent（`:525-531`） |
| 适用场景 | 明确"就是 N 列" | 明确"每列别超过多宽"，列数随屏幕宽自适应 |

两者产出的都是同一个 `SliverGridRegularTileLayout`——等大等距的规则网格。要不等大的格子（如"hero 格"），路线是自定义 `SliverGridLayout`——实现 4.3 那四个索引/几何方法；再写一个自定义 `SliverGridDelegate`，由它的 `getLayout`（`:300`）返回这个 layout，delegate 自身还需实现 `shouldRelayout`（`:308`）。

### 5.2 RenderTable 与 Column 嵌套 Row：两套求解顺序

| 维度 | `RenderTable`（`rendering/table.dart:361`） | Column 嵌套 Row（两层 `RenderFlex`） |
|---|---|---|
| 列宽 | 全表一次求解：`_computeColumnWidths` 四阶段（`:1068-1229`），所有行共享一组 widths | 每行各自求解：外层只给每行一个 maxWidth，各行 Row 独立分配，列边界互不对齐 |
| cell 约束 | `BoxConstraints.tightFor(width: widths[x])`，宽度强制（`:1382`） | 取决于 flex / fit，非 Expanded 孩子通常拿到 loose 约束 |
| 行高 | 逐行内联求：max cell 高或 baseline 的 before+after（`:1410-1415`），无独立行高方法 | 每行 Row 的主轴尺寸，再由 Column 顺排 |
| 垂直对齐 | 六种 `TableCellVerticalAlignment`（`:333`），baseline 跨列共线（`:1422-1426`） | baseline 只在单个 Row 内部成立，跨行没有通道 |
| 孩子管理 | 一维数组 + `setFlatChildren` 整批替换（`:402`、`:809`） | 常规多子树逐个挂 |
| 构建范围 | mount 时全部 inflate（`widgets/table.dart:290-307`），无懒加载 | 同样全量，除非自己套滚动容器 |

`_computeColumnWidths` 的四阶段（注释原文在 `:1070-1078`）：

1. **收集理想宽度**（`:1080-1120`）：逐列调 `columnWidths[x] ?? defaultColumnWidth` 的 `maxIntrinsicWidth` / `minIntrinsicWidth` / `flex`，同时累计 tableWidth 与 totalFlex；
2. **flex 增长**（`:1122-1151`）：有 flex 列且 tableWidth 小于目标宽度时，把剩余宽度按 flex 比例分给 flex 列（只增不减）。目标宽度在 `maxWidth` 有限时取 `maxWidth`，**无限时改取 `minWidth`**（`:1127-1132`）——这是实验 2 里"横向滚动中 Flex 列塌成 0"的直接原因；
3. **无 flex 补宽**（`:1152-1160`）：一个 flex 列都没有、总宽又小于 minWidth 时，差额平摊给所有列（与第 2 步互斥）；
4. **超宽收缩**（`:1164-1229`）：总宽超过 maxWidth 时先按 flex 比例收缩、收到 minWidth 为止（`:1185`），仍有缺口就对所有"还没到 minWidth"的列等量轮削（`:1207`）——源码注释里那个"flex 1000 的 1px 列"的反例解释了为什么不能只按 flex 收。

## 六、源码实验

### 实验 1：固定列数下切换 childAspectRatio

**改什么**：跑 2.1 的 Demo——交叉轴固定 300、`crossAxisCount: 3`、间距全 0、`itemCount: 9`，在 `childAspectRatio: 2.0` 与 `0.5` 之间切换，看 `LayoutBuilder` 打印的约束与滚动长度。

**预测**（按 `:392-407` 的公式推）：2.0 时格子宽 `300/3 = 100`、高 `100/2.0 = 50`，两个 stride 都是 50，`computeMaxScrollOffset(9) = 50*3 - 0 = 150`；0.5 时高 `100/0.5 = 200`，总长 `200*3 = 600`。孩子的约束应为 tight：`BoxConstraints(w=100.0, h=50.0)` 与 `BoxConstraints(w=100.0, h=200.0)`。

**实际**（源码层面）：这些数值由公式唯一确定，没有孩子的参与。链路是 `getLayout`（`:605`，每次 performLayout 现场调用）→ 每索引 `getGeometryForChildIndex`（`:246-254`）→ `getBoxConstraints` 的 `minExtent = maxExtent = mainAxisExtent`（`:80-86`）→ tight 约束。`SliverGridParentData` 里 `layoutOffset` 随行号按 0/50/100（或 0/200/400）递增、`crossAxisOffset` 随列槽位按 0/100/200 递增；切换 aspectRatio 后 `shouldRelayout` 返回 true（`:410-416`），scrollExtent 的估计走 `computeMaxScrollOffset`（`widgets/sliver.dart:915`），从 150 变 600。Demo 的 `debugPrint` 就是核对这些数字的窗口。

**说明**："改 `childAspectRatio` 会同时改变格子高、行距、总滚动长度"是同一组参数被改掉的三个投影，不是三处独立逻辑。反过来，若把 `childAspectRatio` 换成 `mainAxisExtent: 50`，交叉轴 300 与 400 两种屏幕下格子高都恒为 50——因为 `mainAxisExtent ?? ...` 里显式值优先（`:399`）。

### 实验 2：Table 混合列宽遇上无限横向约束

**改什么**：把 2.2 的 `Table` 包进 `SingleChildScrollView(scrollDirection: Axis.horizontal)`；列 0 `FixedColumnWidth(80)`、列 1 `IntrinsicColumnWidth()`、列 2 `FlexColumnWidth()`。

**预测**：有界宽度（如 360）下列 2 吃掉剩余宽度；无限宽度下 Flex 列塌成 0，整列不可见；Fixed 与 Intrinsic 两列不受影响。

**实际**（源码层面）：横向 `SingleChildScrollView` 给孩子发的是 `constraints.heightConstraints()`——`minWidth: 0.0`、`maxWidth: double.infinity`（`widgets/single_child_scroll_view.dart:455-460`，viewport 细节在第 54 篇）。于是 `_computeColumnWidths` 第 2 阶段：`maxWidthConstraint.isFinite` 为 false，`targetWidth = minWidthConstraint = 0.0`（`rendering/table.dart:1127-1132`），`tableWidth < 0` 不成立，flex 增长整段跳过；`FlexColumnWidth` 的两个 intrinsic 恒返回 `0.0`（`:207-214`），所以该列宽度就停在 0。Fixed 列的理想宽就是常量（`:143-151`），Intrinsic 列按 cell 内容求值、不看 containerWidth（`:105-121`），都不受影响。widget 层文档对同一个坑的提醒原文：`If wrapping a Table in a horizontal [ScrollView], choose a different [TableColumnWidth], such as [FixedColumnWidth].`（`widgets/table.dart:106-110`）。

**说明**：`Table` 的默认 `defaultColumnWidth` 就是 `const FlexColumnWidth()`（`widgets/table.dart:124`），所以"默认配置的 Table 直接横向滚"必踩这个坑。这是"flex 需要'剩余空间'，而剩余空间依赖有限 maxWidth"的又一种表现形式，与第 34 篇 `RenderFlex` 在无界主轴下的行为同源。

### 实验 3：GridView.builder 与 Table 的构建/布局次数

**改什么**：`itemCount: 1000` 的 `GridView.builder` 与 1000 行的 `Table` 并排，各自在 cell 构造处计数（builder 里 `_count++`；Table 的 cell widget 构造函数里同样累加）。

**预测**：首帧 GridView.builder 只构建可见区加缓存区的十几个；Table 一次构建全部 1000 行。

**实际**（源码层面）：`RenderSliverGrid.performLayout` 只对 `[firstIndex, targetLastIndex]` 区间要孩子（`rendering/sliver_grid.dart:607-610`、`:663-682`），区间由 `remainingCacheExtent` 决定（第 48 篇）；滚动后只补新区间、回收旧区间。Table 这边，`_TableElement.mount` 对 `children` 无条件逐行逐列 `inflateWidget`（`widgets/table.dart:290-307`），`setFlatChildren` 全量替换后 `markNeedsLayout`（`rendering/table.dart:809-873`），`performLayout` 的 y 循环跑满全部行（`:1362`）。widget 重建时 `_TableElement.update` 走 keyed/无 key 两路 diff 复用 element（`:338-399`，复用规则是第 38、39 篇的 `updateChildren`），但"只构建看得见的行"这件事不存在。

**说明**：Table 是 `RenderBox`，一次解全部是它的设计前提——列宽求解需要扫每列全部 cell 的 intrinsic 值，行高需要每行全部 cell 的实测高度，结构上就没有懒加载的位置。两种网格的孩子策略是两极：公式驱动的懒加载 vs 全量求解的一次性布局。

## 七、结论

1. **SliverGrid 的几何是公式，不是测量**。`getLayout` 把当前约束换算成六个布局参数（`sliver_grid.dart:392-407`、`:502-514`），索引公式决定每个格子的位置（`:246-254`），孩子拿 tight 约束（`:80-86`），总滚动长度也由 `computeMaxScrollOffset` 的行数公式外推（`:257-266`、`widgets/sliver.dart:908-915`）。改 `childAspectRatio` 改的是同一组参数，所以格子尺寸、行距、滚动长度一起变；`mainAxisExtent` 显式给出时宽高比失效（`:399`）。
2. **RenderTable 是"先全表列宽、再逐行行高"的一次性求解**。列宽四阶段所有行共享（`table.dart:1068-1229`），行高在 `performLayout` 的行循环里内联求出、没有独立的行高求解方法（`:1410-1415`）；baseline 对齐通过跨列收集 `before/after` 距离实现共线（`:1383-1392`、`:1422-1426`），dry layout 对它直接声明无法计算（`:1303-1310`）。widget 层先把二维行结构压成一维数组（`widgets/table.dart:401-411`），这是全表求解得以成立的数据结构前提。
3. **两者的默认值就是高频坑的入口**。网格侧 spacing 默认 0、`childAspectRatio` 默认 1.0，格子是"宽高相等的方格"而非"自适应内容"；表格侧默认列宽是 `FlexColumnWidth`（`widgets/table.dart:124`）、默认垂直对齐是 `top`、`textBaseline` 无默认（`:127-128`）——横向无限约束下默认列宽塌 0，baseline 对齐少传 `textBaseline` 直接断言失败（`:129-131`）。

**SliverGrid 用一组 stride 参数按索引现算格子，child 的宽高和位置由 geometry/tight 约束固定；RenderTable 用一次全表列宽求解统一决定 cell 的 x 和列宽，但 cell 仍可决定高度，其高度/基线会参与行高和垂直 offset 的求解。**

## 八、边界声明

- **`SliverConstraints` / `SliverGeometry` 的字段语义与 viewport 的串行往返是第 47 篇**；本文只用到"约束进、geometry 出"这一层结论。
- **懒加载、`cacheExtent`、`collectGarbage`、keepAlive 桶是第 48 篇**；本文只引用"区间由 `remainingCacheExtent` 决定"。
- **`RenderFlex` 的空间分配与 overflow 判定是第 34 篇**；5.2 的对照表只引用它的求解顺序，不重讲 `spacePerFlex`。
- `GridView` / `CustomScrollView` 的 widget 外壳（`ScrollView` → `BoxScrollView` → `buildChildLayout`）是第 55 篇；`SingleChildScrollView` 的 viewport 是第 54 篇，滚动位置与物理是第 45、46 篇。
- `_TableElement.update` 的 keyed 行 diff 细节基于 `updateChildren` 的复用规则，是第 38、39 篇的内容。
- `TableBorder` 的绘制、`rowDecorations`、表格在 Semantics 树上的角色（`_TableSlot` 只做身份）不在本文展开。
- 自定义不等大网格（hero 格）只给了路线（实现 `SliverGridLayout` 的四个方法），不写示例；`TwoDimensionalScrollView` 的二维滚动是另一条正交分支，这个系列不单独展开；后续扩充候选见 `../源码计划/源码阅读系列后续扩充计划.md`。
