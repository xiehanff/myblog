# 15 TextPainter 与 Paragraph：文本如何变成可布局对象

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/text_painter.dart`（1841 行）、`text_span.dart`（599 行）、`text_style.dart`（1774 行）
> 边界源码 `bin/cache/pkg/sky_engine/lib/ui/text.dart`（`Paragraph` / `ParagraphBuilder` 在 dart:ui）

## 一、问题

`Text('hello')` 从 Widget 到底层要经过 `Text` → `RichText` → `RenderParagraph` → `TextPainter` → `ui.ParagraphBuilder` → `ui.Paragraph`。其中 `TextPainter` 是**painting 层唯一允许上层碰的文本对象**，`ui.Paragraph` 是引擎的产物。

于是本节的问题是：**painting 层在文本这件事上到底有哪些对象？各自归谁所有？谁负责释放？**

错误直觉是"`TextPainter` 就是 `Paragraph` 的薄包装"。实际上两者差异很大：

- `ui.Paragraph` 是**内容的固化物**：文本与样式在 `ParagraphBuilder.build()` 那一刻定死，没有任何修改 API，用完必须 `dispose`。但它**不是只能 `layout()` 一次**——类文档明确说它 "can be efficiently resized"（`sky_engine/lib/ui/text.dart:3003-3004`），同一个实例可以用新的 `ParagraphConstraints` 再次 `layout`，重算的只是断行与字形位置。
- `TextPainter` 是**可变配置的门面**：改任何属性都不会立刻重建 `Paragraph`，而是先标记脏；真正的重建推迟到 `layout()` 或 `paint()`。而且它为了**避免重排**专门维护了两层缓存。

这一篇不谈字形如何栅格化，只谈**painting 层内部这几个对象的分工与所有权**。

## 二、最小 Demo

```dart
import 'dart:ui' as ui;
import 'package:flutter/painting.dart';

void main() {
  // 1. 描述层：不可变的树形文本 + 样式
  const TextSpan span = TextSpan(
    style: TextStyle(fontSize: 20),
    children: <InlineSpan>[
      TextSpan(text: 'Hello '),
      TextSpan(text: '世界', style: TextStyle(fontWeight: FontWeight.bold)),
    ],
  );

  // 2. 度量 + 执行层：可变、有状态、要 dispose
  final TextPainter painter = TextPainter(
    text: span, textDirection: TextDirection.ltr, maxLines: 2, ellipsis: '…',
  );

  // 3. layout 之前不能取尺寸
  try { debugPrint('${painter.size}'); } catch (e) { debugPrint('before layout: ${e.runtimeType}'); }

  // 4. layout：这一步才会真正构造 ui.Paragraph
  painter.layout(minWidth: 0, maxWidth: 120);
  debugPrint('size=${painter.size} exceeded=${painter.didExceedMaxLines}');

  // 5. 命中测试
  final TextPosition pos = painter.getPositionForOffset(const Offset(40, 10));
  debugPrint('offset(40,10) -> $pos');

  // 6. 画出来（必须在 layout 之后，否则抛 StateError）
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  painter.paint(Canvas(recorder), Offset.zero);
  recorder.endRecording().dispose();

  // 7. 释放：TextPainter 自己持有 ui.Paragraph
  painter.dispose();
}
```

第 3 步和第 7 步是这一层的两条硬规则：**没 layout 不能读尺寸，用完必须 `dispose`**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `inline_span.dart:219` / `text_span.dart:74` | `InlineSpan` 与最常用的 `TextSpan` |
| `text_span.dart:286-322` | `TextSpan.build(ui.ParagraphBuilder, ...)`，描述层的唯一出口 |
| `text_style.dart:466` | `class TextStyle with Diagnosticable`，全部文字属性 |
| `text_style.dart:1333` / `:1388` | `getTextStyle` / `getParagraphStyle`，painting → dart:ui 的两个出口 |
| `text_style.dart:1450` | `RenderComparison compareTo(TextStyle other)`，成本分级协议 |
| `text_painter.dart:589` | `class TextPainter`，painting 层的门面 |
| `text_painter.dart:781-790` / `:802-827` | `markNeedsLayout` 与 `text` setter 的脏标记 |
| `text_painter.dart:1201-1210` / `:1221-1292` | `_createParagraph` 与两层缓存的 `layout` |
| `text_painter.dart:426-529` | `_TextPainterLayoutCacheWithOffset` 与 `_resizeToFit` |
| `text_painter.dart:1819-1831` | `dispose()`，释放两处 `ui.Paragraph` |
| `rendering/paragraph.dart:326` / `:387` | `RenderParagraph` 与它的 `final TextPainter _textPainter` |

## 四、调用链

### 4.1 描述层：`InlineSpan.build` 是唯一出口

文本描述是一棵不可变的树，从 `InlineSpan`（`inline_span.dart:219`）出发，最常见的实现是 `TextSpan`（`text_span.dart:74`）。这棵树**不携带任何度量信息**，也没有 `layout` 方法。它只有一个和 `dart:ui` 打交道的出口：

```dart
// text_span.dart:286-322（节选，省略参数列表）
void build(ui.ParagraphBuilder builder, {TextScaler textScaler, dimensions}) {
  final hasStyle = style != null;
  if (hasStyle) {
    builder.pushStyle(style!.getTextStyle(textScaler: textScaler));   // 1. 压入 ui.TextStyle
  }
  if (text != null) {
    try {
      builder.addText(text!);                                          // 2. 追加纯文本
    } on ArgumentError catch (exception, stack) {
      FlutterError.reportError(FlutterErrorDetails(...));
      builder.addText('\uFFFD');                                       // 3. 非法文本替换
    }
  }
  for (final InlineSpan child in children ?? const <InlineSpan>[]) {
    child.build(builder, textScaler: textScaler, dimensions: dimensions);  // 4. 递归
  }
  if (hasStyle) {
    builder.pop();                                                     // 5. 配对弹出
  }
}
```

**关键认知**：`build` 的模式是**深度优先的 push / addText / pop**，与 `TextSpan` 的树结构一一对应。这一次遍历是"painting 的样式描述"和"dart:ui 的样式栈"之间唯一的翻译点。第 3 步那个 `\uFFFD` 替换字符是框架对非法文本的兜底——**不抛异常给用户，而是把坏字符替换成"�"并静默上报**。

### 4.2 `TextStyle` 的两个降级出口

`painting/TextStyle` 有 1774 行、三十多个字段；`ui.TextStyle` 只有字符级样式。两者的映射就是 `getTextStyle`：

```dart
// text_style.dart:1333-1377（节选）
ui.TextStyle getTextStyle({
  double textScaleFactor = 1.0,
  TextScaler textScaler = TextScaler.noScaling,
}) {
  final double? fontSize = switch (this.fontSize) {
    null => null,
    final double size when textScaler == TextScaler.noScaling => size * textScaleFactor,
    final double size => textScaler.scale(size),
  };
  return ui.TextStyle(
    color: color, decoration: decoration, fontWeight: fontWeight, ...
    fontSize: fontSize, letterSpacing: letterSpacing, height: height,
    background: switch ((background, backgroundColor)) {
      (final Paint paint, _) => paint,
      (_, final Color color) => Paint()..color = color,
      _ => null,
    },
  );
}
```

两个要点：

1. **缩放发生在这一层**。`textScaler.scale(size)` 把"逻辑字号"算成"实际字号"后才交给 `dart:ui`。所以 `ui.TextStyle.fontSize` 是**已缩放**的值，`painting/TextStyle.fontSize` 是未缩放的设计值。
2. `background` 字段有**两种输入形态**：`Paint` 或 `Color`。源码用 Dart 3 的 `switch` 表达式统一：给 `Paint` 就直接用，给 `Color` 就包一个 `Paint()`。

另一个出口 `getParagraphStyle`（`:1388`）负责**段落级**样式：`textAlign` / `textDirection` / `maxLines` / `ellipsis` / `locale` 直接透传，而 `fontWeight` / `fontStyle` / `fontFamily` / `fontSize` / `height` 用 `?? this.xxx` 兜底。它的注释里有一句关键说明：

```dart
// Here, we establish the contents of this TextStyle as the paragraph's default font
// unless an override is passed in.
```

**`TextSpan` 的根 `style` 会被当作整个段落的默认字体**。这也解释了 `TextPainter._createParagraphStyle` 为什么要读 `_text?.style`：

```dart
// text_painter.dart:1084-1099（节选）
ui.ParagraphStyle _createParagraphStyle([TextAlign? textAlignOverride]) {
  assert(textDirection != null, 'TextPainter.textDirection must be set to a non-null value...');
  final TextStyle baseStyle = _text?.style ?? const TextStyle();
  return baseStyle.getParagraphStyle(
    textAlign: textAlignOverride ?? textAlign,
    textDirection: textDirection,
    textScaler: textScaler,
    maxLines: _maxLines,
    textHeightBehavior: _textHeightBehavior,
    ellipsis: _ellipsis,
    locale: _locale,
    strutStyle: _strutStyle,
  );
}
```

**关键认知**：段落的默认样式来自 `TextPainter.text` 这棵树的**根节点样式**，不是来自 `TextPainter` 自己的某个 `style` 字段。`TextPainter` 没有 `style` 属性——样式全部在 `InlineSpan` 树里。

### 4.3 组装 `ui.Paragraph` 只需要三行

```dart
// text_painter.dart:1201-1210
ui.Paragraph _createParagraph(InlineSpan text) {
  final builder = ui.ParagraphBuilder(_createParagraphStyle());
  text.build(builder, textScaler: textScaler, dimensions: _placeholderDimensions);
  assert(() {
    _debugMarkNeedsLayoutCallStack = null;
    return true;
  }());
  _rebuildParagraphForPaint = false;
  return builder.build();
}
```

`ParagraphBuilder`（段落级）→ `InlineSpan.build`（字符级样式栈 + 文本）→ `build()`（固化成 `Paragraph`）。**`ui.Paragraph` 固化的是内容**——文本与样式在 `build()` 那一刻就固定了，没有任何 API 能改它们，改内容只能重建。`layout(ParagraphConstraints)` 不受这个限制：断行结果随约束走，同一个 Paragraph 可以被新约束再次 layout。`TextPainter.layout` 自己就这么干——`maxWidth` 为无穷时它会先按 `double.infinity` 布局一次，再按 `maxIntrinsicLineExtent` 对**同一个** Paragraph 调第二次 `layout`（`text_painter.dart:1266-1283`），源码注释还专门说明 "Call layout again... This is not as expensive as it seems, line breaking is relatively cheap as compared to shaping"。

**关键认知**：正因为 `ui.Paragraph` 的内容不可变，`TextPainter` 才需要"标记脏 + 延迟重建"。这就是下一节两层缓存的由来。

### 4.4 两层缓存：先试 `_resizeToFit`，失败才重排

```dart
// text_painter.dart:1221-1232（节选）
void layout({double minWidth = 0.0, double maxWidth = double.infinity}) {
  assert(!maxWidth.isNaN);
  assert(!minWidth.isNaN);
  assert(() { _debugNeedsRelayout = false; return true; }());

  final _TextPainterLayoutCacheWithOffset? cachedLayout = _layoutCache;
  if (cachedLayout != null && cachedLayout._resizeToFit(minWidth, maxWidth, textWidthBasis)) {
    return;   // ← 第一层缓存命中，连 Paragraph 都不重建
  }
  ...
```

`_resizeToFit` 的判定逻辑：

```dart
// text_painter.dart:504-515（节选）
final double maxIntrinsicWidth = paragraph.maxIntrinsicWidth;
// Skip line breaking if the input width remains the same, of there will be no soft breaks.
final bool skipLineBreaking =
    maxWidth == layoutMaxWidth                                       // 输入宽度没变
    ||
    ((paragraph.width - maxIntrinsicWidth) > -precisionErrorTolerance &&
        (maxWidth - maxIntrinsicWidth) > -precisionErrorTolerance);  // 宽度够大，不会软换行
```

它成立的前提写在上面那段注释里（`:474-484`）：**只要可用宽度不小于"最长一行的自然宽度"，再加宽就不会改变换行结果**——只会改变非左对齐时的绘制偏移。所以这种情况不需要重排，只改 `contentWidth`，剩下的交给 `paintOffset`：

```dart
// text_painter.dart:459
final double dx = textAlignment * (contentWidth - paragraph.width);
```

`textAlignment` 是 `[0, 1]` 的对齐系数（左对齐 0、右对齐 1，由 `_computePaintOffsetFraction` 从 `TextAlign` + `TextDirection` 推出）。

**关键认知**：**居中 / 右对齐的文字不靠重新排版实现，而是靠一个绘制偏移实现**。这就是 `TextPainter.paint` 的落点是 `offset + layoutCache.paintOffset`（`text_painter.dart:1358`）而不是 `offset` 的原因，也是 `_resizeToFit` 命中时不需要重建 `Paragraph` 的原因——段落本身没变，变的只是贴在哪个位置。

### 4.5 第二层缓存：`_rebuildParagraphForPaint`

`text` setter 用 `RenderComparison` 三分支（`text_painter.dart:802-827`）：

```dart
// text_painter.dart:802-827（节选）
set text(InlineSpan? value) {
  ...
  final RenderComparison comparison = value == null
      ? RenderComparison.layout
      : _text?.compareTo(value) ?? RenderComparison.layout;

  _text = value;
  _cachedPlainText = null;

  if (comparison.index >= RenderComparison.layout.index) {
    markNeedsLayout();                                  // 需要重排：销毁缓存
  } else if (comparison.index >= RenderComparison.paint.index) {
    // Don't invalid the _layoutCache just yet. It still contains valid layout information.
    _rebuildParagraphForPaint = true;                    // 只需重画：保留布局
  }
  // Neither relayout or repaint is needed.
}
```

`RenderComparison`（`basic_types.dart:86`）的四个值按成本递增排列：`identical` < `paint` < `layout` < `layoutAndPaint`。

**关键认知**：这个分支的含义是"**改颜色不重排**"。颜色的改动只会让 `comparison` 落到 `paint`，于是 `_layoutCache` 被保留（布局信息仍有效），只设一个 `_rebuildParagraphForPaint` 标志，等到真正 `paint` 时才兑现：

等到真正 `paint` 时，`_rebuildParagraphForPaint` 才兑现（`text_painter.dart:1335-1352`）：重建 `Paragraph`、按原 `layoutMaxWidth` 重新 `layout`、`dispose` 旧的。那段代码里有一句注释是整篇最诚实的：

```dart
// Unfortunately even if we know that there is only paint changes, there's
// no API to only make those updates so the paragraph has to be recreated
// and re-laid out.
```

**即使只知道有绘制变化，也没有 API 只更新那些，所以 `Paragraph` 必须重建并重新布局。** 两个 `assert`（重建后宽度必须一致、尺寸必须与之前读到的一致）是这段判断的自检。

**关键认知**：`RenderComparison` 给 `TextPainter` 省下的不是"重建 Paragraph"，而是**"读取到错误尺寸"**——`layout` 阶段给出的 `size` 在新旧 `Paragraph` 交替前后必须相等，`assert` 守住了这个不变量。

### 4.6 `_layoutTemplate`：只为一行高度存在

```dart
// text_painter.dart:1103-1129（节选）
ui.Paragraph _createLayoutTemplate() {
  final builder = ui.ParagraphBuilder(_createParagraphStyle(TextAlign.left));
  // direction doesn't matter, text is just a space
  final ui.TextStyle? textStyle = text?.style?.getTextStyle(textScaler: textScaler);
  if (textStyle != null) {
    builder.pushStyle(textStyle);
  }
  builder.addText(' ');
  return builder.build()..layout(const ui.ParagraphConstraints(width: double.infinity));
}

ui.Paragraph _getOrCreateLayoutTemplate() => _layoutTemplate ??= _createLayoutTemplate();

double get preferredLineHeight => _getOrCreateLayoutTemplate().height;
```

为了回答"一行有多高"，它专门建了一个**只含一个空格的 Paragraph**。注释解释了为什么只需要空格："direction doesn't matter, text is just a space"。模板只在 `text` 的 `style` 变化时被销毁（`text_painter.dart:807-810`）。

**关键认知**：`TextPainter` 一共持有**两处 `ui.Paragraph`**——`_layoutCache.paragraph`（真实布局）和 `_layoutTemplate`（量一行高度）。释放的责任因此分成两档：

```dart
// text_painter.dart:781-790（markNeedsLayout：只丢布局缓存，保留模板）
_layoutCache?.paragraph.dispose();
_layoutCache = null;

// text_painter.dart:1819-1831（dispose：两处都释放）
_layoutTemplate?.dispose();
_layoutTemplate = null;
_layoutCache?.paragraph.dispose();
_layoutCache = null;
_text = null;
```

`markNeedsLayout` 不丢模板，是因为模板只依赖样式，不依赖内容。**判断一个类持有哪些引擎资源，最可靠的方法是看它的 `dispose`。**

### 4.7 `RenderParagraph` 只是转发，但转发两层

```dart
// rendering/paragraph.dart:326 / :387
class RenderParagraph extends RenderBox ... {
  final TextPainter _textPainter;
```

`RenderParagraph` **不自己实现任何文本属性**，全部转发给 `TextPainter`。它的 `text` setter 用**同一个 `RenderComparison`** 决定自己该做什么：

```dart
// rendering/paragraph.dart:417-433（节选）
InlineSpan get text => _textPainter.text!;
set text(InlineSpan value) {
  switch (_textPainter.text!.compareTo(value)) {
    case RenderComparison.identical:
      return;                            // 什么都不做
    case RenderComparison.paint:
      _textPainter.text = value;         // 只重画
      ...
    case RenderComparison.layout:
      _textPainter.text = value;         // 重排
      ...
```

所以这个"成本分级"协议被 **`TextPainter` 用一次、`RenderParagraph` 再用一次**——一次属性比较，两级消费者，各自决定自己能省掉哪一步。布局与绘制的落点分别在 `_layoutTextWithConstraints`（`rendering/paragraph.dart:877`）里的 `_textPainter.layout(...)`，和 `:1043` 的 `_textPainter.paint(context.canvas, offset)`。

**关键认知**：`RenderParagraph` 与 `TextPainter` 之间是**一对一独占**关系。`_textPainter` 是 `final` 字段，并在 `RenderParagraph.dispose` 里被释放（`rendering/paragraph.dart:565`）。上层代码不应持有这个实例——**要自己排版就自己 new 一个 `TextPainter`，别复用别人的**。

## 五、核心对象：五个角色与所有权

| 对象 | 所在库 | 可变性 | 是否持有 `ui.Paragraph` | 需要 `dispose` | 主要职责 |
|---|---|---|---|---|---|
| `InlineSpan` / `TextSpan` | painting | 不可变 | 否 | 否 | 描述文本与样式树，`compareTo` 给成本分级 |
| `TextStyle` / `StrutStyle` | painting | 不可变 | 否 | 否 | 样式配置，两个方法降级到 `ui.TextStyle` / `ui.ParagraphStyle` |
| `TextPainter` | painting | **可变** | **是（两处）** | **是** | 门面：缓存、脏标记、命中测试、绘制 |
| `_TextLayout` | painting（私有） | 内部可变（`_paragraph` 可替换） | 是（`_layoutCache` 里那个） | 由 `TextPainter` 负责 | 把 `ui.Paragraph` 的全部度量转发成 painting 的 API |
| `ui.Paragraph` | dart:ui | 内容**不可变**；`layout` 可用新约束**重复调用** | — | **是** | 引擎里的排版结果，度量与绘制的唯一来源 |

三处最容易搞错的边界：

1. **`painting/TextStyle` 与 `ui.TextStyle` 是两个类**（同名）。前者是配置，后者是给 `ParagraphBuilder` 的样式栈元素；转换发生在 `getTextStyle` 里，且**顺势完成字号缩放**。
2. **`TextPainter` 与 `ui.Paragraph` 是一对多持有**（两处），所以 `dispose` 有两行。绕过 `TextPainter` 直接用 `ui.ParagraphBuilder` 的代码要自己管 `Paragraph` 的生命周期。
3. **`_TextLayout.width` 与 `TextPainter.width` 不是同一个东西**。前者是 `ui.Paragraph.width`（段落实际宽度），后者是 `contentWidth`——按 `TextWidthBasis` 决定的"应该上报的宽度"。

```dart
// text_painter.dart:414-419
double _contentWidthFor(double minWidth, double maxWidth, TextWidthBasis widthBasis) {
  return switch (widthBasis) {
    TextWidthBasis.longestLine => clampDouble(longestLine, minWidth, maxWidth),
    TextWidthBasis.parent => clampDouble(maxIntrinsicLineExtent, minWidth, maxWidth),
  };
}
```

两个分支用的是**两个不同的度量**（都来自 `_TextLayout`）：

| `TextWidthBasis` | 度量来源 | 含义 |
|---|---|---|
| `parent` | `_paragraph.maxIntrinsicWidth`（`text_painter.dart:334`） | "不再换行所需的最小宽度"，含尾随空格 |
| `longestLine` | `_paragraph.longestLine`（`text_painter.dart:338`） | 最左字形到最右字形的实际距离，不含尾随空格 |

两者都再 `clampDouble(..., minWidth, maxWidth)` 到约束区间。所以**上报宽度永远落在 `[minWidth, maxWidth]` 内**——短文本报 `maxIntrinsicLineExtent`（不会硬撑到 `maxWidth`），长文本报被夹住的 `maxWidth`。**同一个 `ui.Paragraph`，两种上报宽度**，这是 `TextPainter` 相对 `Paragraph` 多出来的东西之一。

## 六、源码实验

### 实验 1：`layout` 之前读尺寸与直接绘制，两条错误通道（实测）

```dart
final painter = TextPainter(
  text: const TextSpan(text: 'hi'), textDirection: TextDirection.ltr);
try { print(painter.size); } catch (e) { print('size before layout: ${e.runtimeType}'); }
try { painter.paint(Canvas(ui.PictureRecorder()), Offset.zero); }
catch (e) { print('paint before layout: ${e.runtimeType}'); }
```

**预测**：`size` 走断言（`text_painter.dart:1169` 的 `assert(_debugAssertTextLayoutIsValid)`），`paint` 走显式异常，两者的异常类型应该不同。

**实际**（实测输出）：

```text
size before layout: FlutterError
paint before layout: StateError
```

**说明**：两条通道确实不同，但 `size` 抛的是 `FlutterError` 而不是裸 `AssertionError`——因为 `_debugAssertTextLayoutIsValid` 自己调 `FlutterError.reportError` 并把断言失败包装成框架错误（`text_painter.dart:1169` 引用的那个 getter）。`paint` 走的是显式检查：

```dart
// text_painter.dart:1324-1329
if (layoutCache == null) {
  throw StateError(
    'TextPainter.paint called when text geometry was not yet calculated.\n'
    'Please call layout() before paint() to position the text before painting it.',
  );
}
```

**实用结论**：`paint` 的 `StateError` 在 release 下也存在，而 `size` 的检查只在 debug 下生效（release 下会读到 `null` 并抛 `Null check operator used on a null value`）。**顺序约定是"先 `layout`，再读任何东西，最后 `paint`"**，没有例外。

### 实验 2：居中 / 右对齐靠 `paintOffset` 平移，不重排（实测）

```dart
for (final align in <TextAlign>[TextAlign.left, TextAlign.center, TextAlign.right]) {
  for (final minW in <double>[0.0, 200.0]) {
    final p = TextPainter(
      text: const TextSpan(text: 'hi', style: TextStyle(fontSize: 20)),
      textDirection: TextDirection.ltr,
      textAlign: align,
    );
    p.layout(minWidth: minW, maxWidth: 200);
    final boxes = p.getBoxesForSelection(const TextSelection(baseOffset: 0, extentOffset: 2));
    print('$align minWidth=$minW painter.width=${p.width} boxes=${boxes.map((b) => 'L${b.left}').toList()}');
    p.dispose();
  }
}
```

**预测**：如果居中通过"用框宽重排"实现，`ui.Paragraph.width` 会等于 200，文字框会从 0 开始。如果通过 `paintOffset` 实现，`contentWidth` 会是 200（`minWidth` 撑起来的）而段落本身仍是 40 宽，文字框会被平移。

**实际**（实测输出）：

```text
TextAlign.left   minWidth=0.0   painter.width=40.0  boxes=[L0.0]
TextAlign.left   minWidth=200.0 painter.width=200.0 boxes=[L0.0]
TextAlign.center minWidth=0.0   painter.width=40.0  boxes=[L0.0]
TextAlign.center minWidth=200.0 painter.width=200.0 boxes=[L80.0]
TextAlign.right  minWidth=200.0 painter.width=200.0 boxes=[L160.0]
```

**说明**：三点结论。

① `minWidth = 0` 时三种对齐的 `boxes` **都是 `L0.0`**——因为 `contentWidth`（40）与段落宽（40）相等，`dx = textAlignment × 0 = 0`。**"居中"在容器恰好等于文本宽时是看不出来的**，这是 `paintOffset` 机制的直接表现。

② `minWidth = 200` 时 `painter.width` 变成 200，而段落宽仍是 40，于是 `dx` 非零：center 得到 `L80.0 = (200−40)/2`，right 得到 `L160.0 = 200−40`。这正是 `text_painter.dart:459` 的 `dx = textAlignment * (contentWidth - paragraph.width)`。

③ 平移落在 `getBoxesForSelection` 上，是因为该 API 会做 `_shiftTextBox`：

```dart
// text_painter.dart:1049-1052
if (offset.dx == 0.0) {
  return rawBoxes;
}
return rawBoxes.map((TextBox box) => _shiftTextBox(box, offset)).toList(growable: false);
```

**关键认知**：**对齐是"画到哪"的问题，不是"排成什么"的问题**。所以 `_resizeToFit` 在宽度够大时可以不重建 `Paragraph`——它只需要把 `contentWidth` 更新，`paintOffset` 会自己重算。

### 实验 3：`preferredLineHeight` 不需要 `layout`（实测）

```dart
final painter = TextPainter(
  text: const TextSpan(text: '一段很长的文本', style: TextStyle(fontSize: 20)),
  textDirection: TextDirection.ltr,
);
print('preferredLineHeight=${painter.preferredLineHeight}');  // 不需要 layout
```

**预测**：`preferredLineHeight` 是 `_getOrCreateLayoutTemplate().height`（`text_painter.dart:1129`），而模板是一个**只含一个空格**的段落在 `width: double.infinity` 下布局出来的高度。因此在没有任何 `layout()` 调用的前提下它也应该可用。

**实际**（实测输出）：

```text
preferredLineHeight=20.0
size after layout(maxWidth:1e9)=Size(140.0, 20.0)
```

`preferredLineHeight` 在**完全没有调用 `layout()`** 的情况下返回了 `20.0`（等于 `fontSize: 20`），与后续真实布局出来的行高一致。

**说明**：`RenderParagraph` 也暴露了同名属性并注明"does not require the layout to be updated"（`rendering/paragraph.dart:794-798`）。这是"配置可以独立于布局被查询"的一个例子——**行高只取决于样式（字号、`height`、`StrutStyle`），不取决于内容**，所以能用空格模板算。

## 七、结论

1. 文本在 painting 层分成**描述（`InlineSpan`/`TextStyle`）→ 门面（`TextPainter`）→ 引擎产物（`ui.Paragraph`）** 三段。描述层不可变、无度量；`TextPainter` 可变、有状态、要 `dispose`；`ui.Paragraph` 的**内容**不可变（文本与样式在 `build()` 时固化，改内容必须重建），但 `layout` 可以带着新约束重复调用，代价只是重算断行，远低于重新 shaping。两者之间的翻译只有 `InlineSpan.build` + `TextStyle.getTextStyle`/`getParagraphStyle` 这几处。
2. `TextPainter` 的核心不是"包装 `Paragraph`"，而是**两层缓存避免重排**：第一层 `_TextPainterLayoutCacheWithOffset._resizeToFit` 判断"宽度变宽了但不会引起换行变化"，命中则连 `Paragraph` 都不重建；第二层 `_rebuildParagraphForPaint` 应对"只有绘制属性变了"的情况，保留布局、推迟重建。中心 / 右对齐靠 `paintOffset` 平移而非重排实现。
3. `RenderComparison` 是 painting 层对外提供的**成本分级协议**（`identical` < `paint` < `layout` < `layoutAndPaint`）。它在 `TextStyle.compareTo` / `TextSpan.compareTo` 里产生，被 `TextPainter` 用一次决定是否丢缓存，被 `RenderParagraph` 再用一次决定 `markNeedsPaint` 还是 `markNeedsLayout`。

一句话总结：**`TextPainter` 是文本的可变门面，`ui.Paragraph` 是内容不可变的成品——painting 层在两者之间加了两层缓存，只为了少重建几次成品。**

## 八、边界声明

- 字形如何栅格化、`Paragraph` 内部如何断行与 shaping、字体回退策略都是引擎（libtxt / SkParagraph）的事。本篇只到 `ui.ParagraphBuilder.build()` 为止。
- `InlineSpan` 的命中测试与手势（`TextSpan.recognizer`、`HitTestTarget`、`MouseTrackerAnnotation`）属于 `gestures` 与 `rendering` 的交界，留到第六卷。
- `WidgetSpan` / `PlaceholderSpan` 如何嵌入 Widget（`_placeholderDimensions`、`setPlaceholderDimensions`、`RenderParagraph.layoutInlineChildren`）本篇只给锚点，完整流程留到第八卷 RenderParagraph 篇。
- `StrutStyle`（`strut_style.dart` 686 行）与 `TextHeightBehavior` / `TextLeadingDistribution` 的行高分配规则不做专题，需要时按类名读。
- `TextScaler`（`text_scaler.dart` 166 行）的非线性缩放策略留到第十卷 `MediaQuery.textScalerOf` 篇；本篇只用它说明"缩放发生在 `getTextStyle` 里"。
- `TextPainter` 的命中测试 API（`getPositionForOffset`、`getOffsetForCaret`、`getBoxesForSelection`、`getWordBoundary`）属于 `TextLayoutMetrics` 协议，本篇只给锚点。
