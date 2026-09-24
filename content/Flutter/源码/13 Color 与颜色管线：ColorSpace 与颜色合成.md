# 13 Color 与颜色管线：ColorSpace 与颜色合成

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/colors.dart`（515 行）
> 边界源码 `sky_engine/lib/ui/painting.dart`（= `bin/cache/pkg/sky_engine/lib/ui/painting.dart`）（`Color` / `ColorSpace` / `ColorFilter` 在 dart:ui）

## 一、问题

`painting/colors.dart` 有 515 行。打开之后最常被问到的问题是：**`Color` 在哪？`Colors` 在哪？**

答案是：**两个都不在这个文件里。**

- `Color` 在 `dart:ui`（`sky_engine/lib/ui/painting.dart:108`）。它不是 painting 层的类。
- `Colors`（`red`、`blue` 那一堆）在 `material/colors.dart`，`MaterialColor` 在 `material/colors.dart:104`。
- `painting/colors.dart` 里只有三个东西：`HSVColor`、`HSLColor`、`ColorSwatch`，外加一个诊断用的 `ColorProperty`。

错误直觉是"颜色是一组 RGBA 整数"。在 3.44.8 里 `Color` **已经改成浮点分量 + 色彩空间**：

```dart
// dart:ui painting.dart:219
final ColorSpace colorSpace;
```

`Color` 的 r/g/b 现在是 `double`（可以超出 `[0, 1]`），并带一个 `colorSpace` 标签。于是本节的问题是：**painting 层在颜色这件事上到底负责什么？**

答案是两件事：**色彩空间之间的换算（HSL/HSV）**，以及**给"一个颜色 + 若干变体"提供基类（`ColorSwatch`）**。真正的颜色类型与合成规则都在 `dart:ui`。

## 二、最小 Demo

```dart
import 'dart:ui';
import 'package:flutter/painting.dart';

void main() {
  // 1. Color 是 dart:ui 的：分量是 double，不再是 0..255 的 int
  const Color c = Color(0xFF3366FF);
  debugPrint('space=${c.colorSpace} a=${c.a} r=${c.r} g=${c.g} b=${c.b}');
  debugPrint('toARGB32=${c.toARGB32().toRadixString(16)}');

  // 2. painting 层提供的：色彩空间换算
  debugPrint('${HSVColor.fromColor(c)}');  // HSVColor(1.0, 225.0, 0.8, 1.0)
  debugPrint('${HSLColor.fromColor(c)}');  // HSLColor(1.0, 225.0, 1.0, 0.6)

  // 3. painting 层提供的：色板基类，用 int 主键索引变体
  const ColorSwatch<int> swatch = ColorSwatch<int>(
    0xFF3366FF,
    <int, Color>{0xFF003366: Color(0xFF003366), 0xFF66AAFF: Color(0xFF66AAFF)},
  );
  debugPrint('${swatch[0xFF66AAFF]}');   // 取到变体
  debugPrint('${swatch[0xFF000000]}');   // null —— 不是主色也不是变体

  // 4. 合成规则也在 dart:ui
  debugPrint('${Color.alphaBlend(const Color(0x80FF0000), const Color(0xFF0000FF))}');
}
```

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `painting/colors.dart:9` | `import 'dart:ui' show Color, lerpDouble;`——**只引两个名字** |
| `painting/colors.dart:68` / `:236` / `:410` | `HSVColor` / `HSLColor` / `ColorSwatch`，**没有 `Color`** |
| `sky_engine/lib/ui/painting.dart:108` | `class Color`，真正的颜色类型 |
| `sky_engine/lib/ui/painting.dart:219` / `:307` | `final ColorSpace colorSpace` 与 `withValues` |
| `sky_engine/lib/ui/painting.dart:1801` | `enum ColorSpace { sRGB, extendedSRGB, displayP3 }` |
| `sky_engine/lib/ui/painting.dart:4051-4081` | `_getColorTransform(source, destination)`，九个 case |
| `sky_engine/lib/ui/painting.dart:388` / `:468` | `computeLuminance` / `Color.alphaBlend`，都断言拒绝 `extendedSRGB` |
| `material/colors.dart:104` | `MaterialColor`——`Colors` 系列其实在这里，不在 painting 层 |
| `painting/box_decoration.dart:407-427` | `_getBackgroundPaint`，`blendMode` 与着色来源（`color` / `shader`）同置一个 `Paint` 的实例 |

## 四、调用链

### 4.1 分界线：`Color` 在 `dart:ui`，`colors.dart` 只引两个名字

```dart
// painting/colors.dart:8-11
import 'dart:math' as math;
import 'dart:ui' show Color, lerpDouble;

import 'package:flutter/foundation.dart';
```

整个文件只从 `dart:ui` 取 `Color` 和 `lerpDouble` 两个名字。所以 `colors.dart` 的存在意义可以精确表述为：

**在 `dart:ui.Color` 之上补两类东西——色彩空间换算，和"色板"这种容器。**

| 名字 | 在哪 | 是什么 |
|---|---|---|
| `Color` / `ColorSpace` / `ColorFilter` / `BlendMode` | `dart:ui` | 颜色本体与合成规则 |
| `HSVColor`、`HSLColor` | `painting/colors.dart` | 色彩空间**换算器**（不是 `Color` 的子类） |
| `ColorSwatch<T>` | `painting/colors.dart` | "主色 + 变体"容器，**是** `Color` 的子类 |
| `ColorProperty` | `painting/colors.dart` | 诊断输出 |
| `Colors`、`MaterialColor`、`MaterialAccentColor` | `material/colors.dart` | Material 设计规范的调色板 |

`HSVColor` 和 `HSLColor` **不是 `Color` 的子类**（源码依据：`painting/colors.dart:68` 与 `:236` 都是 `class HSVColor`，没有 `extends`）。它们是独立的不可变值对象，通过 `fromColor` / `toColor` 与 `Color` 互转。原因是：HSV/HSL 只用于**计算**（旋转色相、调亮度），不适合在渲染管线里流通——渲染要的是 RGB 三刺激值，不是色相角度。

### 4.2 `Color` 的分量模型：double + ColorSpace

`Color` 在 3.44.8 里有一个 `ColorSpace` 字段和四个 double 分量：

```dart
// sky_engine/lib/ui/painting.dart:200-219（节选）
const Color._fromRGBOC(int r, int g, int b, double opacity, this.colorSpace)
    : a = opacity,
      r = r / 0xFF,
      g = g / 0xFF,
      b = b / 0xFF;
...
final ColorSpace colorSpace;
```

两个后果：

1. **分量可以超出 `[0, 1]`**。`extendedSRGB` 就是用越界值表示超出 sRGB 色域的颜色（`ColorSpace` 的文档在 `sky_engine/lib/ui/painting.dart:1810-1814` 明确说明这点，并指出要看得到这些越界值必须用 `ImageByteFormat.rawExtendedRgba128` 之类的格式）。
2. **旧的 `int get value` 已被废弃**：

```dart
// sky_engine/lib/ui/painting.dart:228-230
@Deprecated('Use component accessors like .r or .g, or toARGB32 for an explicit conversion')
int get value => toARGB32();
```

`toARGB32()` 的文档（`:256`）还加了一句"the returned value is not guaranteed to be stable"。这是颜色模型从整数迁移到浮点的直接痕迹。

### 4.3 色彩空间转换：九个 case，三个"恒等"

```dart
// sky_engine/lib/ui/painting.dart:4051-4081（节选，只留 sRGB 与 extendedSRGB 两个源空间）
_ColorTransform _getColorTransform(ColorSpace source, ColorSpace destination) {
  switch (source) {
    case ColorSpace.sRGB:
      switch (destination) {
        case ColorSpace.sRGB:
          return const _IdentityColorTransform();
        case ColorSpace.extendedSRGB:
          return const _IdentityColorTransform();     // ← 注意：也是 identity
        case ColorSpace.displayP3:
          return const _SrgbToP3Transform();
      }
    case ColorSpace.extendedSRGB:
      switch (destination) {
        case ColorSpace.sRGB:
          return const _ClampTransform(_IdentityColorTransform());
        case ColorSpace.extendedSRGB:
          return const _IdentityColorTransform();
        case ColorSpace.displayP3:
          return const _ClampTransform(_SrgbToP3Transform());
      }
    // displayP3 作为源空间的三个 case 与上面同构，略
  }
}
```

九种组合分三类：

| 类型 | 做什么 | 用在哪 |
|---|---|---|
| `_IdentityColorTransform` | 原样返回（**连 `colorSpace` 都不改**） | sRGB↔sRGB、sRGB→extendedSRGB、extendedSRGB↔extendedSRGB、displayP3↔displayP3 |
| `_ClampTransform` | 分量 `clampDouble` 到 `[0,1]` 并**重标** `colorSpace` | extendedSRGB→sRGB、extendedSRGB→displayP3、displayP3→sRGB |
| `_SrgbToP3Transform` / `_P3ToSrgbTransform` | EOTF 解码 → 3×3 矩阵 → OETF 编码 | sRGB↔displayP3 |

`sRGB → extendedSRGB` 用的是**恒等变换**（`sky_engine/lib/ui/painting.dart:4057-4058`）。理论上没错——sRGB 是 extendedSRGB 的子集，分量不用动。但 `_IdentityColorTransform.transform` 的实现是

```dart
// sky_engine/lib/ui/painting.dart:3913-3917
class _IdentityColorTransform implements _ColorTransform {
  const _IdentityColorTransform();
  @override
  Color transform(Color color, ColorSpace resultColorSpace) => color;
}
```

**它直接返回传入的 color，忽略了 `resultColorSpace` 参数**。所以 `someSrgbColor.withValues(colorSpace: ColorSpace.extendedSRGB)` 的返回结果仍然带 `colorSpace: ColorSpace.sRGB`。这既与 `withValues` 的文档描述（"transforming them to the provided ColorSpace"）不一致，也与 `_ClampTransform` 会重标空间的行为不对称。**这是源码里的一处内部不一致**（见第六节实验 3），使用时不要依赖"换 `colorSpace` 一定生效"。

### 4.4 两个断言：不是所有空间都支持所有操作

`computeLuminance`（`sky_engine/lib/ui/painting.dart:388-389`）与 `alphaBlend`（`:468-470`）都挂了断言：

```dart
// sky_engine/lib/ui/painting.dart:468-470
static Color alphaBlend(Color foreground, Color background) {
  assert(foreground.colorSpace == background.colorSpace);
  assert(foreground.colorSpace != ColorSpace.extendedSRGB);
```

`computeLuminance`：

```dart
double computeLuminance() {
  assert(colorSpace != ColorSpace.extendedSRGB);
```

原因不难推：亮度公式与 alpha 合成公式都是按 `[0, 1]` 归一化分量的定义推导的，`extendedSRGB` 允许越界值，公式就失去意义。

`alphaBlend` 的**两个断言**很关键：

1. **前景与背景必须同色域**——它不做隐式转换。跨色域合成必须调用方先手动 `withValues(colorSpace: ...)`。
2. **不允许 `extendedSRGB`**。

而 `alphaBlend` 的公式本身是标准的 SRC over DST（`:471-499`）：alpha 为 0 直接返回背景（短路）；背景不透明时走简化式；否则走通用式。

### 4.5 合成发生在哪：`Paint` 与 `BlendMode`

`alphaBlend` 只是"两个纯色预先算出一个合成色"的性能优化。真正的合成发生在 `Paint`：

```dart
// painting/box_decoration.dart:407-427（节选）
Paint _getBackgroundPaint(Rect rect, TextDirection? textDirection) {
  if (_cachedBackgroundPaint == null ||
      (_decoration.gradient != null && _rectForCachedBackgroundPaint != rect)) {
    final paint = Paint();
    if (_decoration.backgroundBlendMode != null) {
      paint.blendMode = _decoration.backgroundBlendMode!;   // ← 合成模式
    }
    if (_decoration.color != null) {
      paint.color = _decoration.color!;
    }
    if (_decoration.gradient != null) {
      paint.shader = _decoration.gradient!.createShader(rect, textDirection: textDirection);
    }
    _cachedBackgroundPaint = paint;
  }
  return _cachedBackgroundPaint!;
}
```

颜色的三个层次在这里一次出现：

| 层次 | 类型 | 位置 |
|---|---|---|
| 纯色 | `Color` | `paint.color` |
| 渐变 | `Gradient` → `ui.Gradient`（`Shader`） | `paint.shader` |
| 合成规则 | `BlendMode` | `paint.blendMode` |

这三个字段**不是互斥三选一**。真正的关联只存在于 `color` 与 `shader` 之间——它们争的是同一个"着色来源"槽位：`dart:ui` 对 `Paint.shader` 的文档写得很直白，"When this is null, the `[color]` is used instead"（`sky_engine/lib/ui/painting.dart:1622-1624`）；`color` 的文档反向引用说 "`[shader]`, which overrides `[color]` with more elaborate effects"（`:1411`）。换句话说，**`color` 相当于一个纯色 shader 的快捷方式**：不设 `shader` 时由它给形状着色，设了 `shader` 就整体接管。而 `blendMode` 与这两者**正交**：它不是着色来源，而是"这次画出来的源颜色如何与底下的目标颜色合成"的规则——文档明确源是"正在绘制的形状或图层（经 `colorFilter` 处理后）"、目标是"背景"，默认 `BlendMode.srcOver`（`:1437-1447`）。所以 `blendMode` 与 `color` 或 `shader` 任意组合都合法，`_getBackgroundPaint` 里 `backgroundBlendMode` 与 `color` / `gradient` 本来就是同时设置的。真正会同时盖住 `color` 和 `shader` 的是另一个字段 `colorFilter`（`:1657`："When a shape is being drawn, `[colorFilter]` overrides `[color]` and `[shader]`"）。

`BoxDecoration._getBackgroundPaint` 的缓存条件（`gradient != null && rect 变了`）与字段间的覆盖无关，原因在 shader 的构造参数：纯色可以跨尺寸复用 `Paint`，渐变不行——`createShader(rect, ...)` 把矩形烘焙进了 `Shader`。

### 4.6 `ColorSwatch`：唯一继承 `Color` 的类

```dart
// painting/colors.dart:410 起
class ColorSwatch<T> extends Color {
  const ColorSwatch(super.primary, this._swatch);
  final Map<T, Color> _swatch;

  Color? operator [](T key) => _swatch[key];
  ...
}
```

要点：

1. 它**是** `Color`（`extends Color`），主色就是构造函数的第一个参数。所以 `MaterialColor` 可以直接当作 `Color` 用在任何需要颜色的地方。
2. `ColorSwatch<int>(0xFFFF0000, {...})` 要求 key 的下标值和主色一致——这是 `MaterialColor` 的约定：`Colors.red[500]` 就是主色，`Colors.red[700]` 是深一档。`operator []` 直接查 `Map`，不做任何默认返回，查不到就是 `null`。
3. `ColorSwatch.lerp`（`:466`）**只插值主色**，忽略变体表。文档说法是变体表在插值中被丢弃——这是它在动画中"变了一半就丢失 shades"的原因。

`MaterialColor` / `MaterialAccentColor` 是 `ColorSwatch<int>` 的子类，定义在 `material/colors.dart:104`/`:156`。**它们不在 painting 层**，因为"500 是标准、700 是深一档"是 Material 设计规范的约定，不是框架机制。

### 4.7 HSV / HSL：两个换算器

```dart
// painting/colors.dart:13-28
double _getHue(double red, double green, double blue, double max, double delta) {
  late double hue;
  if (max == 0.0) {
    hue = 0.0;
  } else if (max == red) {
    hue = 60.0 * (((green - blue) / delta) % 6);
  } else if (max == green) {
    hue = 60.0 * (((blue - red) / delta) + 2);
  } else if (max == blue) {
    hue = 60.0 * (((red - green) / delta) + 4);
  }
  /// Set hue to 0.0 when red == green == blue.
  hue = hue.isNaN ? 0.0 : hue;
  return hue;
}
```

HSV 与 HSL 都基于**同一个色相函数**（HSL 复用 `_getHue`），差别只在明度/亮度的定义。两者各有 `fromColor` / `toColor` / `withXxx` / `lerp`。

两个容易踩的点：

- **`lerp` 是在各自的空间里插值，不是在 RGB 里**。`HSVColor.lerp(a, b, t)` 会绕过 360° 的那条路径（从 350° 到 10° 走 20°，不是走 340°）。
- **色相是角度，范围 `[0, 360]`，且 `fromColor` 在灰色上返回 0**。源码里那个 `hue.isNaN ? 0.0 : hue`（`:26`）处理的就是"R=G=B 时除零"。

## 五、核心对象：四个容易混淆的名字

| | `Color` | `HSVColor` / `HSLColor` | `ColorSwatch<T>` | `Colors` / `MaterialColor` |
|---|---|---|---|---|
| 所在层 | `dart:ui` | painting | painting | material |
| 是 `Color` 吗 | 本体 | **否**（独立值对象） | **是**（`extends Color`） | 是（`extends ColorSwatch<int>`） |
| 分量空间 | RGB + `ColorSpace` | 色相/饱和/明度或亮度 | 继承自 `Color` 的主色 | 同左 |
| 主要用途 | 一切渲染 | 色相旋转、明暗计算 | "主色 + 变体"容器 | Material 调色板 |
| 能否直接给 `Paint` 用 | 能 | **不能**（要先 `toColor()`） | 能（主色部分） | 能 |
| 动画插值 | `Color.lerp`（RGB 线性） | 各自空间的 `lerp` | 只插主色 | 同左 |

**选择标准**：需要在 RGB 空间混合（渐变、淡入淡出）用 `Color`；需要按人眼感知调整（变亮、换色相）用 HSV/HSL，调完立刻 `toColor()`；需要"一个颜色带几档深浅"用 `ColorSwatch`。

## 六、源码实验

### 实验 1：`Color` 的浮点分量与 `extendedSRGB` 的越界值（实测）

```dart
const c = Color(0xFF3366FF);
print('space=${c.colorSpace} a=${c.a} r=${c.r} g=${c.g} b=${c.b}');
print('toARGB32=${c.toARGB32().toRadixString(16)}');

final ext = const Color.from(
  alpha: 1.0, red: 1.2, green: -0.2, blue: 0.5, colorSpace: ColorSpace.extendedSRGB);
print('ext=$ext');
print('toARGB32=${ext.toARGB32().toRadixString(16)}');
```

**预测**：`0x33/0xFF` 与 `0x66/0xFF` 应该给出 `0.2` 和 `0.4`；`extendedSRGB` 允许 `r=1.2` 这种越界值；`toARGB32()` 必须把越界值压回 `[0,255]`。

**实际**（输出）：

```text
space=ColorSpace.sRGB a=1.0 r=0.2 g=0.4 b=1.0
toARGB32=ff3366ff
ext=Color(alpha: 1.0000, red: 1.2000, green: -0.2000, blue: 0.5000, colorSpace: ColorSpace.extendedSRGB) space=ColorSpace.extendedSRGB r=1.2 g=-0.2 b=0.5
toARGB32=ffff0080
```

**说明**：`0x33/0xFF = 0.2`、`0x66/0xFF = 0.4`，与源码 `r = r / 0xFF` 一致。第二段是关键：`r=1.2` `g=-0.2` 被原样保留（`extendedSRGB` 的目标就是表达色域外颜色），而 `toARGB32()` 输出 `ffff0080`——`1.2 → 0xFF`、`−0.2 → 0x00`、`0.5 → 0x80`（128）。**越界值在转成 32 位整数时被静默钳制，没有警告**。

### 实验 2：`extendedSRGB` 上的 `computeLuminance` 与 `alphaBlend` 会断言失败（实测）

```dart
final ext = const Color.from(
  alpha: 1.0, red: 1.2, green: -0.2, blue: 0.5, colorSpace: ColorSpace.extendedSRGB);
try { print(ext.computeLuminance()); } catch (e) { print('THREW: ${e.runtimeType}'); }
try { Color.alphaBlend(ext, ext); } catch (e) { print('alphaBlend THREW: ${e.runtimeType}'); }
```

**预测**：源码里有 `assert(colorSpace != ColorSpace.extendedSRGB)`，debug 模式下应该抛异常。

**实际**（输出）：

```text
THREW: _AssertionError
alphaBlend THREW: _AssertionError
```

**说明**：两个都抛了 `_AssertionError`，证实断言存在且生效（`flutter test` 默认开断言）。含义是：**`extendedSRGB` 的颜色只能参与绘制，不能参与计算**。要在业务代码里用宽色域颜色做亮度计算，必须先 `withValues(colorSpace: ColorSpace.sRGB)` 压回 sRGB。

### 实验 3：`sRGB → extendedSRGB` 不会改写 `colorSpace`（实测，源码内部不一致）

```dart
final retag = const Color(0xFF3366FF).withValues(colorSpace: ColorSpace.extendedSRGB);
print('space=${retag.colorSpace}');

final ext = const Color.from(alpha: 1.0, red: 1.2, green: -0.2, blue: 0.5,
    colorSpace: ColorSpace.extendedSRGB);
final clamped = ext.withValues(colorSpace: ColorSpace.sRGB);
print('space=${clamped.colorSpace} r=${clamped.r} g=${clamped.g} b=${clamped.b}');
```

**预测**：`withValues` 的文档说"the component values are updated before transforming them to the provided `ColorSpace`"，所以两次返回的 `colorSpace` 都应该是目标值。

**实际**（输出）：

```text
sRGB->extendedSRGB retag space=ColorSpace.sRGB
to sRGB=Color(alpha: 1.0000, red: 1.0000, green: 0.0000, blue: 0.5000, colorSpace: ColorSpace.sRGB) r=1.0 g=0.0 b=0.5
```

第一行是 `ColorSpace.sRGB`——**没有换成 `extendedSRGB`**；第二行确实换成了 `sRGB` 并做了钳制（`1.2→1.0`、`−0.2→0.0`）。

**说明**：这就是 §4.3 里那条 `_IdentityColorTransform.transform => color` 的直接后果。

| 转换方向 | 用的 transform | `colorSpace` 是否被改写 |
|---|---|---|
| `extendedSRGB → sRGB` | `_ClampTransform(_IdentityColorTransform())` | **是**（`_ClampTransform` 把 `resultColorSpace` 传下去了） |
| `sRGB → extendedSRGB` | `_IdentityColorTransform()` | **否**（`_IdentityColorTransform` 直接返回原 color） |
| `displayP3 → sRGB` | `_ClampTransform(_P3ToSrgbTransform())` | 是 |
| `sRGB → displayP3` | `_SrgbToP3Transform()` | 是 |

**源码依据**：`sky_engine/lib/ui/painting.dart:4057-4058`（sRGB→extendedSRGB 走 identity）与 `:3913-3917`（identity 忽略 `resultColorSpace`）。

**这是否算 bug**：从"值不变"的角度看没错（sRGB 的数值在 extendedSRGB 里含义相同）；从"返回值的 `colorSpace` 应该等于你请求的那个"角度看是错的。**实用结论：不要指望 `withValues(colorSpace:)` 一定改标签，需要确定的标签就用 `Color.from(..., colorSpace: ...)` 直接构造。** 这一点值得在升级 SDK 后重新核对。

### 实验 4：`HSVColor` / `HSLColor` 是双向可逆的换算器（实测）

```dart
final hsv = HSVColor.fromColor(const Color(0xFF3366FF));
print('$hsv back=${hsv.toColor()}');
final hsl = HSLColor.fromColor(const Color(0xFF3366FF));
print('$hsl back=${hsl.toColor()}');
print('hsv.withHue(0)=${hsv.withHue(0)}');
```

**预测**：`fromColor` 之后 `toColor` 应该回到原色；`withHue` 只改色相，其它三项不变。

**实际**（输出）：

```text
HSVColor=HSVColor(1.0, 225.0, 0.8, 1.0)  back=Color(alpha: 1.0000, red: 0.2000, green: 0.4000, blue: 1.0000, colorSpace: ColorSpace.sRGB)
HSLColor=HSLColor(1.0, 225.0, 1.0, 0.6)  back=Color(alpha: 1.0000, red: 0.2000, green: 0.4000, blue: 1.0000, colorSpace: ColorSpace.sRGB)
hsv.withHue(0)=HSVColor(1.0, 0.0, 0.8, 1.0)
```

**说明**：往返精确回到 `(0.2, 0.4, 1.0)`。`#3366FF` 是两个换算空间的绝佳例子：HSV 给 `(h=225°, s=0.8, v=1.0)`，HSL 给 `(h=225°, s=1.0, l=0.6)`——**同一根颜色的 s 和 v/l 数值完全不同**（0.8 vs 1.0），这是 HSV 与 HSL 的定义差异，不是精度问题。`withHue(0)` 只改了第一个分量，其余保持，符合"不可变值对象 + `withXxx` 返回新实例"的模式。

### 实验 5：`ColorSwatch` 的 `operator []` 不做默认回退（实测）

```dart
const sw = ColorSwatch<int>(0xFF000000, <int, Color>{
  0xFF000000: Color(0xFF000000), 0xFFFF0000: Color(0xFFFF0000)});
print('${sw[0xFFFF0000]}');
print('${sw[0x123456]}');
```

**实际**（输出）：

```text
sw[0xFFFF0000]=Color(alpha: 1.0000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
sw[0x123456]=null
```

**说明**：查不到 key 返回 `null`，不返回主色、不抛异常。所以 `Colors.red[123]` 这样的写法不会崩，但会得到一个 `null`，渲染时表现为"颜色为 null"——需要自己兜底。

## 七、结论

1. **painting 层不管颜色本体**。`Color`、`ColorSpace`、`BlendMode`、`ColorFilter` 全在 `dart:ui`；`painting/colors.dart` 只从 `dart:ui` 引 `Color` 和 `lerpDouble` 两个名字，然后补上 HSV/HSL 换算与 `ColorSwatch` 容器。`Colors` / `MaterialColor` 在 `material/colors.dart`，不在 painting 层。
2. `Color` 已经迁到**浮点分量 + `ColorSpace`**（`sRGB` / `extendedSRGB` / `displayP3`）。`extendedSRGB` 允许 `[0,1]` 之外的分量，代价是**不能参与计算**——`computeLuminance` 与 `alphaBlend` 都有断言拒绝它。
3. 色彩空间转换由 `_getColorTransform` 的九个 case 决定：跨 sRGB/displayP3 走矩阵，`extendedSRGB` 方向额外套一层 `_ClampTransform`。**`sRGB → extendedSRGB` 走的是恒等变换，且因为 `_IdentityColorTransform` 忽略目标参数，返回值的 `colorSpace` 不会变**（与 `withValues` 文档描述不一致）。

**颜色类型和合成规则都在 `dart:ui`，painting 层只负责"在色彩空间之间换算"和"把颜色组织成色板"这两件事。**

## 八、边界声明

- `Canvas.drawRect`、`Paint` 的 `blendMode` / `colorFilter` 在引擎里的实际合成顺序属于 `dart:ui` 与引擎，这个系列不展开；本文只到 `Paint` 字段这一层。
- `Gradient` 系列（`LinearGradient` / `RadialGradient` / `SweepGradient`，`painting/gradient.dart` 1179 行）本文只用它证明 `Paint.shader` 的优先级，不展开 `GradientTransform` 与插值策略。
- `ColorFilter`（`ui.ColorFilter.mode` / `.matrix` / `.linearToSrgbGamma`）与 `ImageFilter` 不做专题，属于引擎图像处理范畴。
- `dynamic_color` / `CupertinoDynamicColor`（`cupertino/colors.dart:1240` 是 framework 里唯一读 `ColorSpace` 的地方）留到第十一卷 material/cupertino 抽样篇。
- 第五个实验发现的 `sRGB → extendedSRGB` 标签问题只是**记录事实**，不判断是否为缺陷；升级 SDK 后请按 §六 实验 3 的代码重新核对。
