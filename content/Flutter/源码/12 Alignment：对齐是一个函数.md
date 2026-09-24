# 12 Alignment：对齐是一个函数

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/alignment.dart`（765 行）

## 一、问题

写 `Center(child: X)` 或 `Align(alignment: Alignment.bottomRight, child: X)` 时，很容易把 `Alignment` 理解成一个**枚举**：九个值，选一个，框架内部 `switch` 一下算出位置。

打开源码会发现完全不是这样：

```dart
// alignment.dart:317
const Alignment(this.x, this.y);
```

**它是一个 `(double, double)` 坐标，而且不限定在 `[-1, 1]`**——`Alignment(2, 0)` 和 `Alignment(-2, 0)` 都是合法的，分别表示"在右边界外一整格"和"在左边界外一整格"。

于是本节的问题是：**`Alignment` 到底描述的是"点"还是"偏移"？九个常量之间是怎么过渡的？**

错误直觉是"`Alignment` 是一个位置，`x=1` 表示右边缘"。实际更准确的说法是：

**`Alignment` 是一个函数，输入是"剩余空间"，输出是"子元素应该放的偏移"。** 所谓 `x = 1` 只是这个函数在"剩余空间宽度"上的系数。这也是同名方法有四个（`alongOffset` / `alongSize` / `withinRect` / `inscribe`）的原因——同一个函数被用在四种不同的输入上。

## 二、最小 Demo

```dart
import 'dart:ui';
import 'package:flutter/painting.dart';

void main() {
  // 1. 对齐作用在"剩余空间"上：框 150x80，子 50x30 → 剩余空间 100x50
  const Offset freeSpace = Offset(100, 50);
  for (final Alignment a in <Alignment>[
    Alignment.topLeft, Alignment.center, Alignment.bottomRight,
  ]) {
    debugPrint('$a -> ${a.alongOffset(freeSpace)}');
  }
  // topLeft -> Offset(0.0, 0.0)
  // center  -> Offset(50.0, 25.0)
  // bottomRight -> Offset(100.0, 50.0)

  // 2. 完全相同的数字，换一种含义：对齐作用在"整块尺寸"上
  for (final Alignment a in <Alignment>[
    Alignment.topLeft, Alignment.center, Alignment.bottomRight,
  ]) {
    debugPrint('$a -> ${a.alongSize(const Size(100, 50))}');
  }
  // 输出与上面一模一样，但含义是"锚点位于整块的什么位置"

  // 3. 超出 [-1,1] 的表达能力：把子元素推到框外
  debugPrint('${const Alignment(2, 0).alongOffset(freeSpace)}');  // Offset(150.0, 25.0)
  debugPrint('${const Alignment(-2, 0).alongOffset(freeSpace)}'); // Offset(-50.0, 25.0)

  // 4. 方向语义：与 EdgeInsets 同一套路，rtl 下 start↔end
  debugPrint('${AlignmentDirectional.topStart.resolve(TextDirection.rtl)}'); // Alignment.topRight
}
```

第 1 段和第 2 段打印出**完全相同的数字**，但语义不同，这正是这一层设计的关键。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `alignment.dart:25` / `:161-165` | `AlignmentGeometry` 与它的三个抽象 getter |
| `alignment.dart:41-159` | 15 个 `static const AlignmentGeometry` 常量（类型是抽象类） |
| `alignment.dart:221-243` | `AlignmentGeometry.lerp`，混合类型时返回私有 `_MixedAlignment` |
| `alignment.dart:253` / `:477` | `resolve`，与 `EdgeInsetsGeometry` 同一协议（`Alignment` 是 no-op） |
| `alignment.dart:315-317` | `class Alignment`，`const Alignment(this.x, this.y)` |
| `alignment.dart:421-456` | `alongOffset` / `alongSize` / `withinRect` / `inscribe`，对齐的四个函数形态 |
| `alignment.dart:509` / `:649-655` | `AlignmentDirectional` 与它 rtl 时把 `x` 取负的 `resolve` |
| `alignment.dart:676` / `:718-724` | `_MixedAlignment` 与它 `_x ± _start` 的 `resolve` |
| `alignment.dart:742` | `class TextAlignVertical`，**不是** `AlignmentGeometry` 的子类 |
| `rendering/shifted_box.dart:376` | `alongOffset(size - child!.size as Offset)`，真实调用点 |

## 四、调用链

### 4.1 一个公式，两个名字

```dart
// alignment.dart:420-432
Offset alongOffset(Offset other) {
  final double centerX = other.dx / 2.0;
  final double centerY = other.dy / 2.0;
  return Offset(centerX + x * centerX, centerY + y * centerY);
}

Offset alongSize(Size other) {
  final double centerX = other.width / 2.0;
  final double centerY = other.height / 2.0;
  return Offset(centerX + x * centerX, centerY + y * centerY);
}
```

把式子改写一下：`centerX + x * centerX = centerX * (1 + x)`。于是：

```text
x = -1  →  0                （贴左边）
x =  0  →  centerX          （居中）
x =  1  →  2 * centerX = other.dx   （贴右边）
x =  2  →  1.5 * other.dx   （推出去半格）
```

`Alignment` 就是**把 `[-1, 1]` 线性映射到 `[0, other]`** 的那个函数。`-1` 对到 0，`1` 对到满量，`0` 对到一半。超出范围时就外推。所谓"九个对齐方式"只是这个函数上的九个采样点。

两个方法用**同一个公式**，差别只在参数类型：

| 方法 | 参数含义 | 返回值含义 |
|---|---|---|
| `alongOffset(Offset other)` | "剩余空间" = 父尺寸 − 子尺寸 | 子元素相对父元素左上角的偏移 |
| `alongSize(Size other)` | "一整块尺寸" | 该对齐的**锚点**在这块尺寸里的位置 |

`alongSize(Size(100,50))` 用 `Alignment.bottomRight` 返回 `Offset(100, 50)`——这就是右下角那个点的坐标。同一个函数，输入语义换了，输出语义也跟着换。

### 4.2 `alongOffset` 的真实调用：剩余空间从哪来

```dart
// rendering/shifted_box.dart:376
childParentData.offset = resolvedAlignment.alongOffset(size - child!.size as Offset);
```

`size - child!.size` 就是**剩余空间**。这一行是 `RenderAligningShiftedBox` 的布局核心，被 `Align`、`Center`、`Stack`（非 positioned 子节点）、`Column`/`Row` 的交叉轴对齐等一大票场景复用。

`RenderObject` 传的是"剩余空间"而不是"父尺寸"，因为子元素尺寸只有在布局完成后才知道。这个签名把"对齐"这件事变成了纯粹的**一维外推**，不需要知道父子的绝对尺寸。

### 4.3 `withinRect` 与 `inscribe`：套到 `Rect` 上

```dart
// alignment.dart:435-456
Offset withinRect(Rect rect) {
  final double halfWidth = rect.width / 2.0;
  final double halfHeight = rect.height / 2.0;
  return Offset(rect.left + halfWidth + x * halfWidth, rect.top + halfHeight + y * halfHeight);
}

Rect inscribe(Size size, Rect rect) {
  final double halfWidthDelta = (rect.width - size.width) / 2.0;
  final double halfHeightDelta = (rect.height - size.height) / 2.0;
  return Rect.fromLTWH(
    rect.left + halfWidthDelta + x * halfWidthDelta,
    rect.top + halfHeightDelta + y * halfHeightDelta,
    size.width,
    size.height,
  );
}
```

两个都可以化归到前面的公式：

- `withinRect(rect)` = `rect.topLeft + alongSize(rect.size)`。
- `inscribe(size, rect)` = **以 `(rect.left, rect.top)` 为原点，对剩余空间 `rect.size - size` 做 `alongOffset`**，再挂上 `size`。

`inscribe` 的两个真实用例：

```dart
// painting/gradient.dart:434-435
begin.resolve(textDirection).withinRect(rect),
end.resolve(textDirection).withinRect(rect),
```

```dart
// rendering/proxy_box.dart:2978-2979
final Rect sourceRect = resolvedAlignment.inscribe(sizes.source, Offset.zero & childSize);
final Rect destinationRect = resolvedAlignment.inscribe(sizes.destination, outputRect);
```

第一处是渐变端点：`LinearGradient.begin/end` 是 `AlignmentGeometry`，`withinRect` 把它变成 `Offset` 坐标。第二处是 `BoxFit` 解出的"源矩形"和"目标矩形"——**同一个 `Alignment` 同时决定图像在源图里切哪块、在目标框里放到哪**。

### 4.4 方向语义：与 `EdgeInsets` 完全同一套协议

```dart
// alignment.dart:648-655
@override
Alignment resolve(TextDirection? direction) {
  assert(debugCheckCanResolveTextDirection(direction, '$AlignmentDirectional'));
  return switch (direction!) {
    TextDirection.rtl => Alignment(-start, y),
    TextDirection.ltr => Alignment(start, y),
  };
}
```

`AlignmentDirectional` 的 `resolve`：**rtl 时把 `start` 取负**。不像 `EdgeInsetsDirectional` 是交换两个分量，这里是取负——因为 `x` 是"从中心往右为正"的**有符号系数**，而 left/right 是**两个非负距离**。

`Alignment.resolve` 是 no-op（`:477`），和 `EdgeInsets.resolve` 一样。

`AlignmentGeometry` 与 `EdgeInsetsGeometry` 的对应关系：

| | `EdgeInsetsGeometry` | `AlignmentGeometry` |
|---|---|---|
| 抽象 getter | 六个（`_left/_right/_start/_end/_top/_bottom`） | 三个（`_x/_start/_y`，`alignment.dart:161-165`） |
| 字面实现 | `EdgeInsets` | `Alignment` |
| 方向实现 | `EdgeInsetsDirectional` | `AlignmentDirectional` |
| 混合实现 | `_MixedEdgeInsets` | `_MixedAlignment` |
| `resolve` 的 rtl 处理 | **交换 start/end 到 right/left** | **把 start 取负** |
| 为什么 | 两个非负距离要互换 | 一个有符号系数要反向 |
| 公开常量类型 | `EdgeInsetsGeometry.zero` / `.infinity` | 15 个 `static const AlignmentGeometry` |

`AlignmentGeometry` 只有三个抽象 getter（`alignment.dart:161-165`）：

```dart
double get _x;      // Alignment → x， AlignmentDirectional → 0.0
double get _start;  // Alignment → 0.0，AlignmentDirectional → start
double get _y;      // 两者都是 y
```

比 `EdgeInsetsGeometry` 的六个少一半，因为纵向没有方向语义——**逻辑坐标只在水平方向存在**。

### 4.5 常量声明的类型选择

15 个常量全部声明成抽象类型：

```dart
// alignment.dart:41-159（节选）
static const AlignmentGeometry topLeft = Alignment.topLeft;
static const AlignmentGeometry topStart = AlignmentDirectional.topStart;
static const AlignmentGeometry center = Alignment.center;
...
```

`Alignment.topStart` 是 `AlignmentDirectional` 的实例，`Alignment.topLeft` 是 `Alignment` 的实例。`Alignment` 这个类名同时是"字面坐标系"的名字和"整个族"的常用简称——源码里用 `AlignmentGeometry` 做常量的静态类型，正是为了让人分清这两件事。在业务代码里写 `alignment: Alignment.topStart` 得到的是一个 `AlignmentDirectional`。

### 4.6 `lerp` 的 null 语义

```dart
// alignment.dart:463-474
static Alignment? lerp(Alignment? a, Alignment? b, double t) {
  if (identical(a, b)) {
    return a;
  }
  if (a == null) {
    return Alignment(ui.lerpDouble(0.0, b!.x, t)!, ui.lerpDouble(0.0, b.y, t)!);
  }
  if (b == null) {
    return Alignment(ui.lerpDouble(a.x, 0.0, t)!, ui.lerpDouble(a.y, 0.0, t)!);
  }
  return Alignment(ui.lerpDouble(a.x, b.x, t)!, ui.lerpDouble(a.y, b.y, t)!);
}
```

null 被当作 `Alignment.center`（即 `(0, 0)`）参与插值。`identical(a, b)` 短路先返回原实例，避免无意义的分配。

`AlignmentGeometry.lerp`（`:221-243`）做类型分派：

```dart
// alignment.dart:221-243（节选）
static AlignmentGeometry? lerp(AlignmentGeometry? a, AlignmentGeometry? b, double t) {
  ...
  if (a is Alignment && b is Alignment) {
    return Alignment.lerp(a, b, t);
  }
  if (a is AlignmentDirectional && b is AlignmentDirectional) {
    return AlignmentDirectional.lerp(a, b, t);
  }
  return _MixedAlignment(
    ui.lerpDouble(a._x, b._x, t)!,
    ui.lerpDouble(a._start, b._start, t)!,
    ui.lerpDouble(a._y, b._y, t)!,
  );
}
```

三条分支与 `EdgeInsetsGeometry.lerp` 完全同构。**混合类型不走 `resolve`，而是三个分量各自插值**，所以中间帧仍然保留方向语义。

### 4.7 `TextAlignVertical` 为什么不在这个族里

```dart
// alignment.dart:742
class TextAlignVertical {
```

它是个独立类，不是 `AlignmentGeometry` 的子类。文档说明它的取值是"相对行高的比例"而不是"相对剩余空间的比例"——`TextAlignVertical(y: -1.0)` 表示行内靠上，`y: 1.0` 表示靠下，**中间值也有效**（`y: 0.5` 是偏下的位置）。它与 `Alignment` 唯一的共同点是"都有一个 y 系数"。

同一个文件里的两个"对齐"概念并不共享基类。判断依据是**输入空间是什么**：`Alignment` 的输入是"剩余空间"，`TextAlignVertical` 的输入是"行高"。这也是本节标题"对齐是一个函数"的另一层含义——**不同的对齐概念对应不同的函数，只是恰好名字相似**。

## 五、核心对象：四个方法的输入输出对比

| 方法 | 输入 | 输出 | 输入空间 | 典型调用方 |
|---|---|---|---|---|
| `alongOffset` | `Offset`（剩余空间） | `Offset`（子元素偏移） | 父减子 | `RenderAligningShiftedBox`（`rendering/shifted_box.dart:376`） |
| `alongSize` | `Size`（整块尺寸） | `Offset`（锚点位置） | 整块 | `cupertino/menu_anchor.dart:1269`、`rendering/list_wheel_viewport.dart:1035` |
| `withinRect` | `Rect`（整块矩形） | `Offset`（锚点位置） | 整块 + 原点 | `Gradient.createShader`（`gradient.dart:434`） |
| `inscribe` | `Size` + `Rect` | `Rect`（对齐后的矩形） | 父减子 + 原点 | `BoxFit` 解矩形（`rendering/proxy_box.dart:2978`） |

四个方法的**数学内核完全一样**：`center + coefficient × center`。差别只在"什么算 center"和"输出了点还是矩形"。

**选择标准**：要一个**偏移量**用 `alongOffset`（布局时算子元素位置）；要一个**点**用 `alongSize`/`withinRect`（比如渐变的起止点）；要一个**矩形**用 `inscribe`（比如图片的裁剪框）。

## 六、源码实验

### 实验 1：`alongOffset` 与 `alongSize` 数值完全一致

```dart
for (final a in <Alignment>[Alignment.topLeft, Alignment.center, Alignment.bottomRight,
                              Alignment(-2, 0), Alignment(2, 0)]) {
  print('$a alongOffset=${a.alongOffset(const Offset(100, 50))} '
        'alongSize=${a.alongSize(const Size(100, 50))}');
}
```

**预测**：两个方法的公式一模一样，只要传入的数值相等，输出就应该逐位相同。

**实际**（输出）：

```text
Alignment.topLeft       alongOffset(100,50)=Offset(0.0, 0.0)     alongSize(100,50)=Offset(0.0, 0.0)
Alignment.center        alongOffset(100,50)=Offset(50.0, 25.0)   alongSize(100,50)=Offset(50.0, 25.0)
Alignment.bottomRight   alongOffset(100,50)=Offset(100.0, 50.0)  alongSize(100,50)=Offset(100.0, 50.0)
Alignment(-2.0, 0.0)    alongOffset(100,50)=Offset(-50.0, 25.0)  alongSize(100,50)=Offset(-50.0, 25.0)
Alignment(2.0, 0.0)     alongOffset(100,50)=Offset(150.0, 25.0)  alongSize(100,50)=Offset(150.0, 25.0)
```

**说明**：五组全部逐位相同，包括超出 `[-1,1]` 的两组。这直接证实了 §4.1 的结论：**`alongOffset` 与 `alongSize` 是同一个函数的两种输入语义**。

`Alignment(2, 0)` 的值 150 = `50 + 2*50`，即"再往右推一格"。`Alignment(-2, 0)` 的值 −50 说明**子元素会被放到父元素左侧外面**——`Align` 不裁剪、不报错，只是照算。

### 实验 2：`inscribe` 允许子比父大

```dart
const rect = Rect.fromLTWH(100, 100, 200, 200);
print(Alignment.center.inscribe(const Size(50, 50), rect));
print(Alignment.topLeft.inscribe(const Size(50, 50), rect));
print(Alignment.bottomRight.inscribe(const Size(50, 50), rect));
print(Alignment.center.inscribe(const Size(300, 300), rect));
```

**预测**：居中的 50×50 应该落在 rect 中心（175,175）；`topLeft` 应贴在 (100,100)；子比父大时结果矩形应该超出 rect。

**实际**（输出）：

```text
center 50x50 -> Rect.fromLTRB(175.0, 175.0, 225.0, 225.0)
topLeft 50x50 -> Rect.fromLTRB(100.0, 100.0, 150.0, 150.0)
bottomRight 50x50 -> Rect.fromLTRB(250.0, 250.0, 300.0, 300.0)
center 300x300 (larger than rect) -> Rect.fromLTRB(50.0, 50.0, 350.0, 350.0)
```

**说明**：全部符合预测。第 4 行是重点：`halfWidthDelta = (200-300)/2 = -50`，于是 left = `100 + (-50) + 0 = 50`，right = `50 + 300 = 350`——**子比父大时剩余空间为负，`inscribe` 照常算，结果矩形比父矩形大一圈**。这正是 `BoxFit.contain` 之外那些模式（如 `BoxFit.cover`）能用同一个 API 表达裁剪矩形的原因。

### 实验 3：`Alignment` 与 `AlignmentDirectional` 的 `resolve` 语义不同

```dart
print(AlignmentDirectional.topStart.resolve(TextDirection.ltr));
print(AlignmentDirectional.topStart.resolve(TextDirection.rtl));
print(AlignmentDirectional.centerStart.resolve(TextDirection.rtl));
print(Alignment.center.resolve(TextDirection.rtl));
print(const Alignment(1, 0).resolve(TextDirection.rtl));
```

**预测**：`topStart` 在 rtl 下应解成"右上"；`Alignment(1,0)` 在 rtl 下**不变**（它是字面坐标）。

**实际**（输出）：

```text
topStart ltr=Alignment.topLeft rtl=Alignment.topRight
centerStart rtl=Alignment.centerRight
Alignment.center.resolve(rtl)=Alignment.center
Alignment(1,0).resolve(rtl)=Alignment.centerRight
```

**说明**：前三条符合预测。最后一条需要解释：`Alignment(1, 0)` 的 `resolve` 是 no-op（返回自身），但它的 `toString()` 打印成 `Alignment.centerRight`——因为 `Alignment.centerRight` 就是 `Alignment(1.0, 0.0)` 的字面值（`alignment.dart:361`）。也就是说**打印出来的名字相同，不代表经过了方向处理**。要区分"经过 rtl 处理"和"本来就是 centerRight"，只能看原始代码写的是哪个类。

### 实验 4：混合 `lerp` 保留方向语义

```dart
final m = AlignmentGeometry.lerp(const Alignment(1, 0), const AlignmentDirectional(-1, 0), 0.5)!;
print('${m.runtimeType} ltr=${m.resolve(TextDirection.ltr)} rtl=${m.resolve(TextDirection.rtl)}');
print('${Alignment.lerp(Alignment.center, Alignment.topRight, 0.5)}');
```

**预测**：如果 `lerp` 会先 `resolve`，两个方向的结果应该相同。

**实际**（输出）：

```text
lerp runtimeType=_MixedAlignment
  ltr=Alignment.center rtl=Alignment.centerRight
Alignment.lerp(c,t)=Alignment(0.5, -0.5)
```

**说明**：`_MixedAlignment` 保留了两套坐标，`resolve` 时**两条分支一个有号一个变号**：

```dart
// alignment.dart:717-724
Alignment resolve(TextDirection? direction) {
  assert(debugCheckCanResolveTextDirection(direction, '$_MixedAlignment'));
  return switch (direction!) {
    TextDirection.rtl => Alignment(_x - _start, _y),
    TextDirection.ltr => Alignment(_x + _start, _y),
  };
}
```

ltr 下 `x=0.5, start=-0.5` → `0.5 + (-0.5) = 0`（居中）；rtl 下同一个 `_start` 变成被减 → `0.5 - (-0.5) = 1`（靠右）。同一个中间对象，两个方向解出两个位置——**方向语义在插值过程中没有丢失**。

## 七、结论

1. 与其把 `Alignment` 当成枚举，不如把它看作**把 `[-1, 1]` 线性映射到 `[0, 剩余空间]` 的函数**（`center + coefficient × center`）。九个常量只是这个函数上的采样点，`Alignment(2, 0)` 这样的外推值是合法输入。
2. `alongOffset` / `alongSize` / `withinRect` / `inscribe` 四个方法的**数学内核相同**，差别只在输入是"剩余空间"还是"整块尺寸"、输出是点还是矩形。`alongOffset` 是布局用的，`inscribe` 是裁剪用的。
3. `AlignmentGeometry` 与 `EdgeInsetsGeometry` 是同构协议（抽象 getter → `resolve(TextDirection)` → 私有混合类型 → `lerp` 三分支），但 rtl 的处理方式不同：**`EdgeInsetsDirectional` 交换两个非负距离，`AlignmentDirectional` 把一个有符号系数取负**。`TextAlignVertical` 虽然名字相似，却不属于这个族。

**`Alignment` 的核心是"剩余空间怎么分"；把它当成"在哪"来理解会绕远——它把一个比例变成一个偏移，仅此而已。**

## 八、边界声明

- `RenderAligningShiftedBox` 的完整布局协议（`performLayout`、`computeDryLayout`、内在尺寸）属于 `rendering` 层，留到第八卷 RenderObject 协议篇。本文只用到 `rendering/shifted_box.dart:376` 这一跳。
- `Stack` 的 `StackFit`、`Positioned` 与 `Alignment` 的组合规则留到第九卷（`widgets` 构建协议）的 `Stack` 篇。
- `FractionalOffset`（`fractional_offset.dart`，187 行）是 `Alignment` 的遗留别名，公式是 `Alignment(2*dx - 1, 2*dy - 1)`。本文不展开，需要时按这个换算关系读。
- 渐变的 `Alignment` 起止点如何变成 `Shader` 参数不在本文展开；本文只用它证明 `withinRect` 的真实用途。
- `Alignment` 与 `EdgeInsetsGeometry` 共用的 `debugCheckCanResolveTextDirection` 属于 foundation 的诊断设施（第一卷 D 区），只给锚点不展开。
