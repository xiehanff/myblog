# 11 EdgeInsets 与几何代数：方向解耦的四边距

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/edge_insets.dart`（1075 行）

## 一、问题

`EdgeInsets` 看起来是 painting 层里最普通的类：四个 double，加上一堆 `+ - * /`。

但打开文件第一行就会发现它有两套坐标：`EdgeInsets` 用 left/top/right/bottom，`EdgeInsetsDirectional` 用 start/top/end/bottom。而且**两者不能直接相减、也不能直接比较**。

于是本节的问题是：**为什么不能只留一套？这两套之间是靠什么统一的？**

错误直觉是"`EdgeInsetsDirectional` 只是 `EdgeInsets` 的语法糖，最后会被自动转成 left/right"。实际相反：

- `EdgeInsetsDirectional` **不是糖**，它是一等类型，**最典型的解析点**是布局链路终点的 `RenderPadding`（`rendering` 层），但不是唯一。
- `resolve` 需要一个 `TextDirection`，这个值**不是只在 rendering 层才有**：布局链路从 `RenderObject.textDirection`（来自 `Directionality`）拿；painting 层的边框与装饰绘制把它当**方法参数**传进来当场 resolve——`painting/box_border.dart:226` 的 `BoxBorder.getInnerPath` 里就有 `dimensions.resolve(textDirection).deflateRect(rect)`，同构的 `BorderRadiusGeometry` 在 `painting/box_decoration.dart:556` 也提前解析；widgets 层的 `ScrollbarPainter` 甚至在构造函数和 setter 里就 resolve 完并缓存（`widgets/scrollbar.dart:126/:201/:315`）。所以准确的说法是：`EdgeInsetsGeometry` 把方向语义保留到**使用者拿到 `TextDirection` 的那一刻**——多数布局路径上是 `rendering` 层，绘制路径上往往更早。
- 而且它可以**停留在未解耦状态**：`EdgeInsets.only(left:10).add(EdgeInsetsDirectional.only(start:5))` 返回的是第三种类型 `_MixedEdgeInsets`，它同时持有两套坐标，在 `resolve` 时相加。

## 二、最小 Demo

```dart
import 'dart:ui';
import 'package:flutter/painting.dart';

void main() {
  // 1. 方向语义：同一条声明，两个方向解出两个结果
  const EdgeInsetsGeometry g = EdgeInsetsDirectional.only(start: 12, end: 4);
  debugPrint('ltr = ${g.resolve(TextDirection.ltr)}'); // EdgeInsets(12.0, 0.0, 4.0, 0.0)
  debugPrint('rtl = ${g.resolve(TextDirection.rtl)}'); // EdgeInsets(4.0, 0.0, 12.0, 0.0)

  // 2. 字面语义：resolve 是 no-op，两个方向一样
  const EdgeInsetsGeometry l = EdgeInsets.only(left: 12, right: 4);
  debugPrint('ltr = ${l.resolve(TextDirection.ltr)}');
  debugPrint('rtl = ${l.resolve(TextDirection.rtl)}'); // 与上面完全相同

  // 3. 混合：两套坐标相加，方向仍然要等到 resolve 才能定
  final EdgeInsetsGeometry mixed =
      const EdgeInsets.only(left: 10).add(const EdgeInsetsDirectional.only(start: 5));
  debugPrint('${mixed.runtimeType}');                       // _MixedEdgeInsets
  debugPrint('ltr = ${mixed.resolve(TextDirection.ltr)}');  // EdgeInsets(15.0, 0.0, 0.0, 0.0)
  debugPrint('rtl = ${mixed.resolve(TextDirection.rtl)}');  // EdgeInsets(10.0, 0.0, 5.0, 0.0)

  // 4. 几何代数：一个 EdgeInsets 可以作用在 Rect / Size / RRect 上
  const Rect rect = Rect.fromLTWH(10, 10, 50, 50);
  debugPrint('${const EdgeInsets.only(left: 1, top: 2, right: 3, bottom: 4).inflateRect(rect)}');
}
```

第 3 段是本篇的核心：**`add` 之后方向语义没有被消掉，而是被推迟了**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `edge_insets.dart:31` | `abstract class EdgeInsetsGeometry`，整个几何代数的抽象 |
| `edge_insets.dart:76-81` | 六个抽象 getter（两套坐标共存的地方） |
| `edge_insets.dart:106` | `horizontal => _left + _right + _start + _end`，四个横向分量直接相加 |
| `edge_insets.dart:171` / `:193` / `:206` | `subtract` / `add` / `clamp`，三个都返回 `_MixedEdgeInsets` |
| `edge_insets.dart:297` | `EdgeInsets resolve(TextDirection? direction)`，方向解耦的唯一出口 |
| `edge_insets.dart:717` / `:956-962` | `EdgeInsets.resolve` 是 no-op；`EdgeInsetsDirectional.resolve` 做 start↔end 互换 |
| `edge_insets.dart:976` / `:1068-1074` | `_MixedEdgeInsets` 与它把两套坐标相加的 `resolve` |
| `edge_insets.dart:519` / `:566` | `inflateRect` / `inflateRRect`，几何算子的代表 |
| `rendering/shifted_box.dart:126` / `:139-141` | `RenderPadding` 与它的 `_resolvedPaddingCache` |

## 四、调用链

### 4.1 六个 getter 撑起一套代数

`EdgeInsetsGeometry` 的把戏是：**声明六个私有 getter，让每个子类把不用的那一半返回 0**。

```dart
// edge_insets.dart:76-81
double get _bottom;
double get _end;
double get _left;
double get _right;
double get _start;
double get _top;
```

于是所有代数都能写成统一的六个分量运算，不用 instanceof 分派：

```dart
// edge_insets.dart:106-109
double get horizontal => _left + _right + _start + _end;
double get vertical => _top + _bottom;
```

三个子类对这套 getter 的填充方式：

| 子类 | `_left`/`_right` | `_start`/`_end` | `horizontal` 的语义 |
|---|---|---|---|
| `EdgeInsets`（`:390`） | 真实值 | **恒为 0**（`:484-487`） | 物理左右之和 |
| `EdgeInsetsDirectional`（`:742`） | **恒为 0**（`:843-846`） | 真实值 | 逻辑首尾之和 |
| `_MixedEdgeInsets`（`:976`） | 真实值 | 真实值 | **两套之和** |

**关键认知**：`horizontal` 对 `_MixedEdgeInsets` 是"left + right + start + end"，它**已经包含了两个方向的可能性**。所以 `_MixedEdgeInsets.horizontal = 15`（来自 §二 第 3 段）在 ltr 下解出 15，在 rtl 下也是 15——这个数字在方向确定前就已经是最终宽度了。`collapsedSize` 同理。

### 4.2 三个"保方向"的运算

`add` / `subtract` / `clamp` 都在抽象基类里实现，**都返回 `_MixedEdgeInsets`**：

```dart
// edge_insets.dart:193-215（节选）
EdgeInsetsGeometry add(EdgeInsetsGeometry other) {
  return _MixedEdgeInsets.fromLRSETB(
    _left + other._left,
    _right + other._right,
    _start + other._start,
    _end + other._end,
    _top + other._top,
    _bottom + other._bottom,
  );
}
```

**六个分量各自独立相加，不做任何方向上的归一化**。这就是"方向被推迟"的实现方式。

而具体子类会在能确定结果类型时短路：

```dart
// edge_insets.dart:611-624（EdgeInsets 的覆写）
EdgeInsetsGeometry subtract(EdgeInsetsGeometry other) {
  if (other is EdgeInsets) {
    return this - other;      // 同类型 → 直接用 EdgeInsets 的 - 运算符
  }
  return super.subtract(other);   // 混类型 → 落到 _MixedEdgeInsets
}

EdgeInsetsGeometry add(EdgeInsetsGeometry other) {
  if (other is EdgeInsets) {
    return this + other;
  }
  return super.add(other);
}
```

`EdgeInsets` 还提供了**更强类型的运算符**（`:637` 及之后），它们接收 `EdgeInsets` 参数并返回 `EdgeInsets`：

```dart
// edge_insets.dart:637-644
EdgeInsets operator -(EdgeInsets other) {
  return EdgeInsets.fromLTRB(
    left - other.left, top - other.top, right - other.right, bottom - other.bottom,
  );
}
```

**关键认知**：这正是"两种 API 同存"的原因。`operator -` 类型安全、不需要 `resolve`，但它**只能用于两个同类型操作数**；`subtract` 通用，但返回类型退化成 `EdgeInsetsGeometry`，要拿具体值必须 `resolve`。文档在 `:184-192` 把这条权衡写得很直接："If you know you are adding two `EdgeInsets` ... consider using the `+` operator instead, which always returns an object of the same type"。

### 4.3 `resolve`：两条分支，一个方向

```dart
// edge_insets.dart:955-962
@override
EdgeInsets resolve(TextDirection? direction) {
  assert(debugCheckCanResolveTextDirection(direction, '$EdgeInsetsDirectional'));
  return switch (direction!) {
    TextDirection.rtl => EdgeInsets.fromLTRB(end, top, start, bottom),
    TextDirection.ltr => EdgeInsets.fromLTRB(start, top, end, bottom),
  };
}
```

只有两行，但这两行是整个"方向解耦"的全部内容：**rtl 时 start↔end 互换到 right↔left**。

`_MixedEdgeInsets` 的版本就是把两套坐标相加（`:1067-1074`）：

```dart
EdgeInsets resolve(TextDirection? direction) {
  assert(debugCheckCanResolveTextDirection(direction, '$_MixedEdgeInsets'));
  return switch (direction!) {
    TextDirection.rtl => EdgeInsets.fromLTRB(_end + _left, _top, _start + _right, _bottom),
    TextDirection.ltr => EdgeInsets.fromLTRB(_start + _left, _top, _end + _right, _bottom),
  };
}
```

`EdgeInsets.resolve` 直接返回自己（`:717`）：

```dart
@override
EdgeInsets resolve(TextDirection? direction) => this;
```

**关键认知**：`resolve` 不是"转换"，是**语义绑定**。它的存在意义是：在 `painting` 层可以只表态"我要首侧 12"，把"首侧是哪侧"这个问题推迟到有 `TextDirection` 的地方再回答。`EdgeInsets.resolve` 之所以是 no-op，正是因为"左"这个语义不需要任何额外信息。

### 4.4 谁提供 `TextDirection`

**最典型的解析点**在 `rendering` 层：`RenderPadding` 把 `padding` 存成 `EdgeInsetsGeometry`，只在真正需要数值时才 `resolve`，并且**缓存结果**：

```dart
// rendering/shifted_box.dart:126-147（节选）
class RenderPadding extends RenderShiftedBox {
  RenderPadding({..., required EdgeInsetsGeometry padding, ...});

  EdgeInsets? _resolvedPaddingCache;
  EdgeInsets get _resolvedPadding {
    final EdgeInsets returnValue = _resolvedPaddingCache ??= padding.resolve(textDirection);
    return returnValue;
  }
  ...
  void _markNeedsResolution() {
    _resolvedPaddingCache = null;
    markNeedsLayout();
  }
}
```

`resolve` 被调用的时机是 `performLayout`，而 `textDirection` 是 `RenderObject` 从 `Directionality`（一个 `InheritedWidget`）拿到的：

```dart
// rendering/shifted_box.dart:376
childParentData.offset = resolvedAlignment.alongOffset(size - child!.size as Offset);
```

（这一行属于第二篇要讲的 `Alignment`，但它紧挨着 `RenderPadding`，展示了同一个模式：**存抽象值 → 用 `textDirection` resolve → 缓存 → 方向变化时清缓存**。）

**关键认知**：`paint` 阶段的 `RenderPadding` 还用到几何代数的另一半——裁剪：

```dart
// rendering/shifted_box.dart:278
child != null ? _resolvedPaddingCache!.deflateRect(outerRect) : null,
```

也就是 `EdgeInsetsGeometry.deflateRect`。所以一个 `EdgeInsetsGeometry` 在 rendering 层同时承担三种角色：**布局时算子元素位置、绘制时算裁剪矩形、尺寸变化时算收缩后的可用尺寸**。

但解析点不止 `RenderPadding` 这一处。painting 层的 `ShapeBorder` 家族在 `getInnerPath` / `paint` 里以**方法参数**的形式拿到 `textDirection`，当场 resolve 自己的 `dimensions`（也是一个 `EdgeInsetsGeometry`）：`BoxBorder.getInnerPath`（`painting/box_border.dart:226`）就是 `dimensions.resolve(textDirection).deflateRect(rect)`，`_CompoundBorder.paint`（`painting/borders.dart:834`）逐层 `resolve + deflateRect`，`LinearBorder`（`painting/linear_border.dart:256/:267`）同理；同构的 `BorderRadiusGeometry` 也在 `BoxDecoration` 绘制时提前 resolve（`painting/box_decoration.dart:556`）。widgets 层的 `ScrollbarPainter` 更早——构造函数与 `textDirection` / `padding` 的 setter 里就 resolve 并缓存（`widgets/scrollbar.dart:126/:201/:315`）。也就是说：**`resolve` 永远是那个唯一出口，但"什么时候拿到 `TextDirection`"由调用链决定**——布局路径通常等到 `RenderObject`，绘制路径常作为参数提前到手。

### 4.5 几何代数：inflate 与 deflate 在圆角上的差异

`Size` 上的两个版本极简，而且**都不做下限保护**：

```dart
// edge_insets.dart:135-153
Size inflateSize(Size size) {
  return Size(size.width + horizontal, size.height + vertical);
}

Size deflateSize(Size size) {
  return Size(size.width - horizontal, size.height - vertical);
}
```

`deflateSize` 的文档（`:142-143`）明确写了：**"If the argument is smaller than `collapsedSize`, then the resulting size will have negative dimensions."** 也就是说在 `EdgeInsetsGeometry` 这一层，"收缩过头变成负数"是被允许的，下限保护留给调用方。

`RRect` 版本复杂得多，因为圆角半径也要跟着变：

```dart
// edge_insets.dart:566-577
RRect inflateRRect(RRect rect) {
  return RRect.fromLTRBAndCorners(
    rect.left - left,
    rect.top - top,
    rect.right + right,
    rect.bottom + bottom,
    topLeft: (rect.tlRadius + Radius.elliptical(left, top)).clamp(minimum: Radius.zero),
    topRight: (rect.trRadius + Radius.elliptical(right, top)).clamp(minimum: Radius.zero),
    bottomRight: (rect.brRadius + Radius.elliptical(right, bottom)).clamp(minimum: Radius.zero),
    bottomLeft: (rect.blRadius + Radius.elliptical(left, bottom)).clamp(minimum: Radius.zero),
  );
}
```

两点值得注意：

1. `Radius.elliptical(left, top)`——**圆角半径是水平方向和垂直方向分别加上去的**。左上角加 `(left, top)`，右上角加 `(right, top)`，依此类推。
2. **这里做了 `clamp(minimum: Radius.zero)`**。与 `deflateSize` 允许负尺寸不同，圆角半径不允许为负（`Radius` 的语义不容许）。`deflateRRect` 相减后同样 `clamp` 到 `Radius.zero`（`:597` 起）。

**关键认知**：`EdgeInsets` 不只是"padding 的载体"，它是一套**可以作用在 `Size` / `Rect` / `RRect` 上的几何算子**。这解释了为什么它住在 `painting` 层而不是 `widgets` 层——`rendering` 的裁剪（`deflateRect`）、`BorderRadius` 与 `Border` 的圆角计算（`inflateRRect`）都要用它。也解释了为什么"下限保护"在这套 API 里是不一致的：`Size` 允许负值（调用方自己判），`Radius` 不允许（clamp 掉）。

### 4.6 `flipped` 与方向无关

```dart
// edge_insets.dart:122-124
EdgeInsetsGeometry get flipped =>
    _MixedEdgeInsets.fromLRSETB(_right, _left, _end, _start, _bottom, _top);
```

**`flipped` 永远返回 `_MixedEdgeInsets`，即使调用方是 `EdgeInsets`。** 这意味着 `EdgeInsets.only(left: 10).flipped` 的类型不再是 `EdgeInsets`，要拿具体值得 `resolve`。

这是一个刻意的保守选择：`flipped` 交换的是**物理方向**（left↔right），而 `EdgeInsetsDirectional` 的 start/end 是逻辑方向——把 `EdgeInsets` 的 left 换到 right 后，结果已经与"物理左右"和"逻辑首尾"都有关，无法再确定用哪一套表示。

## 五、核心对象：三种具体类型的职责

| | `EdgeInsets` | `EdgeInsetsDirectional` | `_MixedEdgeInsets` |
|---|---|---|---|
| 声明位置 | `edge_insets.dart:390` | `edge_insets.dart:742` | `edge_insets.dart:976` |
| 是否公开 | 是 | 是 | **否**（私有，只作中间结果） |
| 主要构造参数 | `left/top/right/bottom` | `start/top/end/bottom` | 六个都有 |
| `resolve` 复杂度 | `=> this` | rtl 时 start↔end | 两套相加 |
| 从哪来 | 手写 | 手写 | `add`/`subtract`/`clamp`/`flipped`/`lerp` 的返回值 |
| 能否用 `+` / `-` | 能（类型安全） | 能（同类型） | 不能（没有运算符） |
| 相等语义 | 与同类比较 | 与同类比较 | 与任何 `EdgeInsetsGeometry` 比六个分量 |
| 典型使用者 | `MediaQuery.padding`、`Container.padding` | 主题里写"首侧留白" | 框架内部，业务代码几乎见不到 |

最后一行值得单独说：**`_MixedEdgeInsets` 是公有的"输出类型"，却不是公有的"输入类型"**。它没有公开构造函数，你只能通过运算间接得到它。这是一种"只出现在表达式中段"的类型设计。

## 六、源码实验

### 实验 1：`resolve` 的方向语义（实测）

```dart
const g = EdgeInsetsDirectional.only(start: 12, end: 4, top: 1, bottom: 2);
print('ltr=${g.resolve(TextDirection.ltr)}');
print('rtl=${g.resolve(TextDirection.rtl)}');
const l = EdgeInsets.only(left: 12, right: 4, top: 1, bottom: 2);
print('ltr=${l.resolve(TextDirection.ltr)}');
print('rtl=${l.resolve(TextDirection.rtl)}');
print('horizontal=${g.horizontal} collapsedSize=${g.collapsedSize}');
```

**预测**：`EdgeInsetsDirectional` 在两个方向下 left/right 数值互换；`EdgeInsets` 两个方向输出完全相同；`g.horizontal` 应该是 16（12+4）。

**实际**（实测输出）：

```text
directional ltr=EdgeInsets(12.0, 1.0, 4.0, 2.0)
directional rtl=EdgeInsets(4.0, 1.0, 12.0, 2.0)
literal ltr=EdgeInsets(12.0, 1.0, 4.0, 2.0)
literal rtl=EdgeInsets(12.0, 1.0, 4.0, 2.0)
directional horizontal=16.0 collapsedSize=Size(16.0, 3.0)
```

**说明**：全部符合预测。关键是第 3、4 行：**字面语义下 `TextDirection` 被完全忽略**，`resolve` 是恒等。所以"给一个 `EdgeInsets` 传错方向"不会有任何报错——但给 `EdgeInsetsDirectional` 传 `null` 会（`debugCheckCanResolveTextDirection` 断言）。

### 实验 2：`add` 的返回类型与两套坐标的共存（实测）

```dart
final sum = const EdgeInsets.only(left: 10).add(const EdgeInsetsDirectional.only(start: 5));
print('${sum.runtimeType}');
print('ltr=${sum.resolve(TextDirection.ltr)} rtl=${sum.resolve(TextDirection.rtl)}');
print('horizontal=${sum.horizontal}');

final diff = const EdgeInsets.only(left: 10).subtract(const EdgeInsets.all(3));
print('${diff.runtimeType} ${diff.resolve(TextDirection.ltr)}');

final same = const EdgeInsets.only(left: 10) + const EdgeInsets.all(3);
print('${same.runtimeType}');
```

**预测**：`add` 混合类型应该返回 `_MixedEdgeInsets`；`subtract` 同类型应该走短路返回 `EdgeInsets`；ltr 下 left 应为 10+5=15，rtl 下应为 10 与 right 5。

**实际**（实测输出）：

```text
add runtimeType=_MixedEdgeInsets
  ltr=EdgeInsets(15.0, 0.0, 0.0, 0.0) rtl=EdgeInsets(10.0, 0.0, 5.0, 0.0)
  horizontal=15.0
subtract runtimeType=EdgeInsets resolve=EdgeInsets(7.0, -3.0, -3.0, -3.0)
EdgeInsets.only(left:10) + EdgeInsets.all(3) runtimeType=EdgeInsets
```

**说明**：三点确认。① 混合 `add` 确实返回私有类型 `_MixedEdgeInsets`。② 它的 `horizontal` 是 15，ltr 下 left 也是 15——**横向总量与方向无关，只有分配方式与方向有关**。③ `subtract` 因为参数是 `EdgeInsets`，走了 `is EdgeInsets` 短路，返回 `EdgeInsets(7, -3, -3, -3)`（`10-3=7`，`0-3=-3`）。注意 `subtract` 允许出现负数——它不做 `clamp`。

### 实验 3：相等语义会给出"反直觉"的结果（实测）

```dart
print(const EdgeInsets.only(left: 12) == const EdgeInsets.only(left: 12));                     // true
print(const EdgeInsetsDirectional.only(start: 12) == const EdgeInsets.only(left: 12));         // ?
print(const EdgeInsets.only(left: 12).resolve(TextDirection.ltr)
    == const EdgeInsetsDirectional.only(start: 12).resolve(TextDirection.ltr));                // ?
```

**预测**：既然 ltr 下两者 `resolve` 出来的数值完全一样，那它们应该"相等"——至少第二行可能是 true。

**实际**（实测输出）：

```text
Equality: true
Directional != Literal even when resolved equal: false
```

第二行是 `false`。

**说明**：`EdgeInsetsGeometry.operator ==`（`edge_insets.dart:330-339`）比较的是六个私有分量：

```dart
bool operator ==(Object other) {
  return other is EdgeInsetsGeometry &&
      other._left == _left && other._right == _right &&
      other._start == _start && other._end == _end &&
      other._top == _top && other._bottom == _bottom;
}
```

`EdgeInsets.only(left:12)` 的 `_start` 是 0，`EdgeInsetsDirectional.only(start:12)` 的 `_left` 是 0，所以不等。第三行则是 true（两个 `resolve` 的结果都是普通 `EdgeInsets`）。

**关键认知**：`==` 比的是**未解耦的原始分量**，不是 `resolve` 之后的效果。所以判断两个 `EdgeInsetsGeometry` 是否"视觉等价"，必须先把方向定下来再比——直接 `==` 会把"ltr 下等价"和"rtl 下等价"之外的情况全部判为不等。

### 实验 4：混合类型 `lerp` 的行为（实测）

```dart
final mid = EdgeInsetsGeometry.lerp(
  const EdgeInsets.only(left: 10),
  const EdgeInsetsDirectional.only(start: 20),
  0.5,
)!;
print('${mid.runtimeType} ltr=${mid.resolve(TextDirection.ltr)} rtl=${mid.resolve(TextDirection.rtl)}');
```

**预测**：如果 `lerp` 会先把两端 `resolve` 成同一类型，那 `mid` 应该是 `EdgeInsets` 且结果在两个方向下相同。

**实际**（实测输出）：

```text
lerp runtimeType=_MixedEdgeInsets
  ltr=EdgeInsets(15.0, 0.0, 0.0, 0.0) rtl=EdgeInsets(5.0, 0.0, 10.0, 0.0)
```

**说明**：`lerp` **不 resolve**，而是分别对六个分量各做一次插值（`edge_insets.dart:275-285`），返回 `_MixedEdgeInsets`。所以 `mid` 在两个方向下仍然不同。这正是动画里一个常见现象的来源：**从一个 `EdgeInsets` 动画到一个 `EdgeInsetsDirectional`，中间帧的 left 和 right 会以不同速率变化**（ltr 下 left 从 10 涨到 15，right 从 0 涨到 5；rtl 下则相反）。

## 七、结论

1. `EdgeInsetsGeometry` 用**六个私有 getter** 把两套坐标系塞进同一套代数：`EdgeInsets` 让 start/end 恒为 0，`EdgeInsetsDirectional` 让 left/right 恒为 0，私有类 `_MixedEdgeInsets` 六个都有。所有运算因此不需要 instanceof 分派。
2. **方向语义只在 `resolve` 一处被解开**，`resolve` 需要 `TextDirection`。最典型的解析点是布局链路的 `RenderPadding._resolvedPadding`（`rendering/shifted_box.dart:139-141`，带缓存），但不是唯一：painting 层的边框与装饰绘制以方法参数形式拿到方向后当场 resolve（`painting/box_border.dart:226`、`painting/box_decoration.dart:556`），widgets 层的 `ScrollbarPainter` 在构造与 setter 里就解析缓存（`widgets/scrollbar.dart:126/:201/:315`）。`EdgeInsetsDirectional` 在布局路径上会完整穿过 painting 层落到 `RenderPadding`，在绘制路径上则可能在 painting 层内部就被 resolve。
3. `EdgeInsets` 不只是"外边距容器"，它是一套作用在 `Size` / `Rect` / `RRect` 上的几何算子。这套算子在几何层**不做**下限保护：`deflateSize`（`edge_insets.dart:151`）与 `deflateRect`（`:541`）收缩过头会直接给出负尺寸（文档明确说明），`deflateRRect`（`:597` 起）也只把圆角半径 clamp 到 `Radius.zero`。真正的下限保护在**约束层**——`BoxConstraints.deflate`（`rendering/box.dart:200-213`）用 `math.max(0.0, …)` 把 min 收在 0、max 收在 min，收缩后的约束永不为负。

一句话总结：**painting 层不猜方向，它只把"首侧"这个语义原样传递，谁先拿到 `TextDirection` 谁来 resolve——布局路径上通常是 rendering 层；而在拿到方向之前，四个边距里有两个一直是 0。**

## 八、边界声明

- `BorderRadius` / `BorderRadiusGeometry`（`border_radius.dart`，944 行）与 `EdgeInsetsGeometry` 是**同构设计**（同样的六个 getter、同样的 `resolve`、同样的 `_MixedBorderRadius`）。本篇不重复讲，需要时按同一套模式读即可。
- `EdgeInsetsDirectional.resolve` 里的 `debugCheckCanResolveTextDirection` 属于 foundation 的诊断设施（第一卷 D 区），本篇只给锚点，不展开断言文案。
- 方向信息的来源（`Directionality` 这个 `InheritedWidget` 如何把 `TextDirection` 传到 `RenderObject`）留到第九卷 `InheritedWidget` 篇。
- `RenderPadding` 的完整 `performLayout` / `computeDryLayout` / 内在尺寸计算属于 `rendering` 层，留到第八卷 RenderObject 协议篇。
- `EdgeInsets` 与 `MediaQuery` 的关系（`MediaQuery.paddingOf` 为什么不用直接读 `FlutterView` 的 `viewPadding`）留到第十卷。
