# 14 Decoration 与 BoxPainter：绘制的最小契约

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/decoration.dart`（256 行）、`box_decoration.dart`（591 行）、`borders.dart`（963 行）、`box_border.dart`（1139 行）

## 一、问题

`Container(decoration: BoxDecoration(...))` 是使用频率最高的 API 之一。但 `BoxDecoration` 只是 `Decoration` 的一个实现——`decoration.dart` 只有 256 行，它定义的是一个**两半的契约**：

```dart
abstract class Decoration { ... }   // 不可变的描述
abstract class BoxPainter { ... }   // 有状态的执行者
```

于是本节的问题是：**为什么装饰要拆成两个类？为什么要一个"不可变 + 一个可变"？**

错误直觉是"`BoxPainter` 只是 `Decoration` 内部的一个实现细节"。实际上拆分的理由是**生命周期**：

- `Decoration` 是配置，会被反复比较（`==`）、参与动画插值（`lerp`）、可以在多个 `RenderObject` 之间共享。所以它必须 `@immutable`。
- `BoxPainter` 会持有 `Paint` 缓存、订阅图片加载（`onChanged`）、需要 `dispose`。所以它**每个绘制目标各持一份**。

`RenderDecoratedBox` 里这两半的对接方式只有两行，但决定了整套绘制契约：

```dart
// rendering/proxy_box.dart:2473-2475
void paint(PaintingContext context, Offset offset) {
  _painter ??= _decoration.createBoxPainter(markNeedsPaint);
  final ImageConfiguration filledConfiguration = configuration.copyWith(size: size);
```

**`createBoxPainter` 只在第一次 `paint` 时调用一次**，之后一直复用，直到 `decoration` 对象被换掉。

## 二、最小 Demo

两半的契约可以脱离 Widget 单独验证：

```dart
import 'dart:ui' as ui;
import 'package:flutter/painting.dart';

/// 1. 最小 Decoration：必须实现 createBoxPainter
class RoundDotDecoration extends Decoration {
  const RoundDotDecoration({required this.color, required this.radius});

  final Color color;
  final double radius;

  // 2. 告诉外层"我的内容要被挤开多少"——契约的一部分，可以返回 0
  @override
  EdgeInsetsGeometry get padding => EdgeInsets.all(radius);

  // 3. 是否复杂到值得缓存（RenderObject 会据此调 setIsComplexHint）
  @override
  bool get isComplex => false;

  // 4. 唯一的抽象方法：产出一个 painter
  @override
  BoxPainter createBoxPainter([VoidCallback? onChanged]) =>
      _RoundDotPainter(this, onChanged);

  // 5. 值对象必须实现 == / hashCode，否则 RenderObject 每次都会重建 painter
  @override
  bool operator ==(Object other) =>
      other is RoundDotDecoration && other.color == color && other.radius == radius;

  @override
  int get hashCode => Object.hash(color, radius);
}

class _RoundDotPainter extends BoxPainter {
  _RoundDotPainter(this.decoration, super.onChanged);

  final RoundDotDecoration decoration;
  Paint? _cached;   // 6. painter 可以有状态：缓存 Paint

  @override
  void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
    final Size size = configuration.size!;
    final TextDirection? direction = configuration.textDirection;
    _cached ??= Paint()..color = decoration.color;
    canvas.drawCircle(offset + size.center(Offset.zero), decoration.radius, _cached!);
  }

  @override
  void dispose() {       // 7. 必须释放持有的资源
    _cached = null;
    super.dispose();
  }
}
```

最后是手工驱动一次绘制——`BoxPainter` 可以脱离 Widget 使用：

```dart
void main() {
  const RoundDotDecoration d = RoundDotDecoration(color: Color(0xFF3366FF), radius: 20);

  // 8. 造 Canvas：用 PictureRecorder 兜住绘制指令
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);

  // 9. 配置里至少要有一个 size（契约要求）
  final ImageConfiguration config = ImageConfiguration.empty.copyWith(
    size: const Size(100, 100),
    textDirection: TextDirection.ltr,
  );

  // 10. 取 painter → 画 → 释放，三步都是调用方的责任
  final BoxPainter painter = d.createBoxPainter();
  painter.paint(canvas, const Offset(10, 10), config);
  painter.dispose();
  recorder.endRecording().dispose();

  // 11. 单独 import painting.dart 时没有 debugPrint（它在 foundation），这里用 print
  print('padding=${d.padding} isComplex=${d.isComplex}');
}
```

代码里 `PictureRecorder` 特意写成 `ui.` 前缀不是风格问题：`painting.dart` 的 `basic_types.dart` 刻意不导出 `Picture`/`PictureRecorder` 这类底层原语（源码注释原话："We use `ui.*` to make it very explicit that these are low-level image APIs"），所以必须自己 `import 'dart:ui' as ui;`。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `decoration.dart:33` | `abstract class Decoration`，`@immutable` |
| `decoration.dart:69` / `:72` / `:174` | `padding` / `isComplex` / `hitTest`，三个有默认实现的成员 |
| `decoration.dart:138-157` | `Decoration.lerp`，null 语义与 0.5 处的兜底 |
| `decoration.dart:181-182` / `:194-198` | `createBoxPainter`（唯一抽象成员）与默认抛异常的 `getClipPath` |
| `decoration.dart:209-255` | `BoxPainter` 的三条：`paint` / `onChanged` / `@mustCallSuper dispose` |
| `box_decoration.dart:571-585` | `_BoxDecorationPainter.paint`，四步固定顺序 |
| `box_decoration.dart:220` / `:252` | `padding => border?.dimensions` 与 `isComplex => boxShadow != null` |
| `borders.dart:367` / `:539` / `:560` | `ShapeBorder` 与它的内外两条路径（另一套抽象） |
| `borders.dart:303` | `strokeInset => width * (1 - (1 + strokeAlign) / 2)` |
| `rendering/proxy_box.dart:2473-2519` | `RenderDecoratedBox.paint`：懒创建 + saveCount 断言 + `setIsComplexHint` |

## 四、调用链

### 4.1 契约的七条

把 `decoration.dart` 的公开成员列完，就得到了这套契约的全貌：

| 成员 | 默认值 | 谁用它 | 为什么在 `Decoration` 上 |
|---|---|---|---|
| `padding` | `EdgeInsets.zero` | `Container` 的 padding 叠加、`RenderDecoratedBox` 无直接使用 | 让"装饰占用的空间"可以被布局知道 |
| `isComplex` | `false` | `RenderDecoratedBox` → `context.setIsComplexHint()` | 提示合成器这一层值得缓存 |
| `lerpFrom` / `lerpTo` | `null` | `Decoration.lerp` | 让两个不同类的装饰之间也能过渡 |
| `hitTest` | `true` | `RenderDecoratedBox.hitTestSelf` | 让"圆形装饰"能只在圆内响应点击 |
| `createBoxPainter` | **抽象** | `RenderDecoratedBox.paint` | 唯一必须实现的方法 |
| `getClipPath` | **抛异常** | `Container.clipBehavior` | 只有部分装饰支持裁剪 |

**关键认知**：六个成员里有**五个有默认实现**。也就是说，写一个可用的 `Decoration` 子类，最少只需要实现 `createBoxPainter` 一个方法；`padding` 默认 0、`hitTest` 默认全部命中、`getClipPath` 默认"不支持裁剪"、`isComplex` 默认不复杂、`lerp` 默认"无法插值"。这是一个**宽接口、窄义务**的契约。

`getClipPath` 的默认实现值得抄下来，因为它示范了框架如何表达"这个子类没这个能力"：

```dart
// decoration.dart:194-198
Path getClipPath(Rect rect, TextDirection textDirection) {
  throw UnsupportedError(
    '${objectRuntimeType(this, 'This Decoration subclass')} does not expect to be used for clipping.',
  );
}
```

### 4.2 `BoxPainter` 的三条

```dart
// decoration.dart:209-255（结构）
abstract class BoxPainter {
  const BoxPainter([this.onChanged]);

  void paint(Canvas canvas, Offset offset, ImageConfiguration configuration);  // 抽象

  final VoidCallback? onChanged;

  @mustCallSuper
  void dispose() {}
}
```

三个细节：

1. **`paint` 的签名里没有 `size`**。尺寸藏在 `configuration.size` 里——因为 painter 需要的不只是尺寸，还有 `textDirection`、`devicePixelRatio`、`bundle`。这就是 `ImageConfiguration` 的作用。文档在 `:217-218` 明确要求 "must, at a minimum, have a non-null `Size`"。
2. **`onChanged` 是给异步资源用的**。`DecorationImage` 加载完图片后调它，`RenderDecoratedBox` 把 `markNeedsPaint` 传了进来（`rendering/proxy_box.dart:2474`）。所以"图片加载好之后自动重绘"这条路是靠 `onChanged` 打通的。
3. **`dispose` 必须 `@mustCallSuper`**。它要中止 `onChanged` 的后续调用——文档在 `:250-253` 明确写了 "The `onChanged` callback will not be invoked after this method has been called"。

### 4.3 `RenderDecoratedBox` 的四个动作

```dart
// rendering/proxy_box.dart:2473-2519（节选）
void paint(PaintingContext context, Offset offset) {
  _painter ??= _decoration.createBoxPainter(markNeedsPaint);      // 1. 懒创建
  final ImageConfiguration filledConfiguration = configuration.copyWith(size: size);  // 2. 补 size
  if (position == DecorationPosition.background) {
    int? debugSaveCount;
    assert(() { debugSaveCount = context.canvas.getSaveCount(); return true; }());
    _painter!.paint(context.canvas, offset, filledConfiguration);  // 3. 画装饰
    assert(() {
      if (debugSaveCount != context.canvas.getSaveCount()) {
        throw FlutterError.fromParts(<DiagnosticsNode>[
          ErrorSummary('${_decoration.runtimeType} painter had mismatching save and restore calls.'),
          ...
        ]);
      }
      return true;
    }());
    if (decoration.isComplex) {
      context.setIsComplexHint();                                 // 4. 标记复杂
    }
  }
  super.paint(context, offset);   // 画孩子
  if (position == DecorationPosition.foreground) {
    _painter!.paint(context.canvas, offset, filledConfiguration);
    if (decoration.isComplex) {
      context.setIsComplexHint();
    }
  }
}
```

其中第 3 步的 `saveCount` 断言值得单独说：

**关键认知**：这条检查的适用范围比看上去窄。它是 `RenderDecoratedBox` 自己的 debug 断言（`rendering/proxy_box.dart:2478-2507`），**只包住 `DecorationPosition.background` 那一次 `_painter!.paint`**——`foreground` 分支（`:2513-2518`）同样调 `paint`，却没有任何 saveCount 检查；`BoxPainter.paint` 的契约文档（`decoration.dart:209-240`）也没有把"save/restore 必须配对"写进去，dart:ui 的 `Canvas` / `PictureRecorder` 在 Dart 侧同样没有这类断言。准确的表述是：**当装饰以 background 位置画进 `DecoratedBox` 时**，每个未配对的 `save()` / `saveLayer()` 会在 debug 下抛出带 `ErrorSummary` + `ErrorDescription` + 两个 `DiagnosticsProperty`（装饰对象和 painter 对象）的完整错误，文案明确写着 "Every call to save() or saveLayer() must be matched by a call to restore()"。配对仍然应当作为纪律遵守——painter 留下未闭合的 canvas 状态会污染后续绘制——但"框架强制检查"只在 background 这一个分支成立。

第 4 步的 `setIsComplexHint` 也不是可选的礼貌：`BoxDecoration.isComplex` 在 `boxShadows != null` 时为真（`box_decoration.dart:252`），阴影的模糊计算贵，加这个提示让渲染管线愿意把这一层缓存成独立 layer。**`isComplex` 的唯一消费者就是这个调用。**

### 4.4 装饰绘制四步：顺序是契约的一部分

```dart
// box_decoration.dart:569-585
@override
void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
  assert(configuration.size != null);
  final Rect rect = offset & configuration.size!;
  final TextDirection? textDirection = configuration.textDirection;
  _paintShadows(canvas, rect, textDirection);       // 1. 阴影在最下
  _paintBackgroundColor(canvas, rect, textDirection); // 2. 纯色 / 渐变
  _paintBackgroundImage(canvas, rect, configuration); // 3. 图片
  _decoration.border?.paint(                      // 4. 边框在最上
    canvas,
    rect,
    shape: _decoration.shape,
    borderRadius: _decoration.borderRadius?.resolve(textDirection),
    textDirection: configuration.textDirection,
  );
}
```

`BoxDecoration` 的类文档（`box_decoration.dart:29-40`）把这条顺序写成了设计约定："The box has a `border`, a body, and may cast a `boxShadow`. ... The `border` paints over the body; the `boxShadow`, naturally, paints below it."

四个绘制步骤各自还有一个隐藏条件：

| 步骤 | 条件 | 出处 |
|---|---|---|
| 阴影 | `boxShadow == null` 就直接 return | `box_decoration.dart:449-451` |
| 背景 | `color != null \|\| gradient != null` 才画 | `box_decoration.dart:472-478` |
| 图片 | `image == null` 就跳过 | `box_decoration.dart:538` 起 |
| 边框 | `border?.paint(...)` 空安全调用 | `box_decoration.dart:578` |

而且第 2 步画背景时会**主动缩小矩形**：

```dart
// box_decoration.dart:472-478
void _paintBackgroundColor(Canvas canvas, Rect rect, TextDirection? textDirection) {
  if (_decoration.color != null || _decoration.gradient != null) {
    // When border is filled, the rect is reduced to avoid anti-aliasing
    // rounding error leaking the background color around the clipped shape.
    final Rect adjustedRect = _adjustedRectOnOutlinedBorder(rect, textDirection);
    _paintBox(canvas, adjustedRect, _getBackgroundPaint(rect, textDirection), textDirection);
  }
}
```

`_adjustedRectOnOutlinedBorder`（`:488`）在边框是实心不透明（`side.color.alpha == 255 && side.style == BorderStyle.solid`）时，按 `strokeInset / 2` 收缩矩形。注释给的理由很实在：**不缩的话抗锯齿的取整误差会让背景色从裁剪形状的边缘漏出来一圈**。

**关键认知**：`paint` 里的 `rect` 与 `_getBackgroundPaint(rect, ...)` 里的 `rect` **不是同一个**——前者是收缩后的（用于绘制），后者是原始的（用于 `createShader`）。渐变必须按原始矩形生成 shader，否则渐变的起止点会跟着边框宽度抖动。

### 4.5 两套抽象：`Decoration` 与 `ShapeBorder`

`shape_decoration.dart` 把两者接在一起：`ShapeDecoration` 是一个 `Decoration`，它的 `createBoxPainter` 返回的 painter 内部**持有**一个 `ShapeBorder` 并调它的 `paint`。

两者的差别是**能力范围**：

| | `Decoration` | `ShapeBorder` |
|---|---|---|
| 声明位置 | `decoration.dart:33` | `borders.dart:367` |
| 核心抽象方法 | `createBoxPainter` | `getOuterPath` + `getInnerPath` + `paint` |
| 必须能描述成两条路径 | **不要求** | **要求**（外沿 + 内沿） |
| `dimensions` / `padding` | `padding`（内容避让） | `dimensions`（边框宽度） |
| 能否裁剪 | `getClipPath` 默认抛异常 | `getOuterPath` 天然可裁剪 |
| 能否做渐变/图片背景 | 能（`BoxDecoration`） | 不能 |
| `lerp` 协议 | `lerpFrom` / `lerpTo` 返回 null 表示"不行" | 同 |
| 典型实现 | `BoxDecoration`、`ShapeDecoration`、`FlutterLogoDecoration` | `Border`、`BorderDirectional`、`CircleBorder`、`RoundedRectangleBorder`、`StadiumBorder`、`StarBorder` |

**关键认知**：判断该用哪一套的标准是**"能不能用内外两条路径描述"**。圆角矩形、圆形、星形都能，所以是 `ShapeBorder`；"带图片背景的盒子"不能，所以只能是 `Decoration`。`ShapeDecoration` 的存在是为了让 `ShapeBorder` 也能当 `Decoration` 用（例如给 `Container` 一个星形背景）——它是两套抽象之间的桥，而不是第三套抽象。

`ShapeBorder` 还多一个能力：`add(other)`（`borders.dart:399`）与 `operator +`，让两个边框能合并。`BoxBorder` 就靠它实现了 `Border + Border` 的十字合并（`borders.dart:722` 起的 `_CompoundBorder`）。

### 4.6 `Decoration.lerp`：0.5 处的兜底

```dart
// decoration.dart:138-157（节选）
return b.lerpFrom(a, t) ??
    a.lerpTo(b, t) ??
    (t < 0.5 ? (a.lerpTo(null, t * 2.0) ?? a) : (b.lerpFrom(null, (t - 0.5) * 2.0) ?? b));
```

最后一行是"两个类互不相识"时的兜底：**把 `[0, 0.5]` 用来把 `a` 收缩到"什么都没有"，`[0.5, 1]` 用来把"什么都没有"展开成 `b`**。文档在 `:134-135` 写的就是这个："If the two values can't directly be interpolated, then the interpolation is done via null (at `t == 0.5`)"。

`BoxDecoration` 提供了这条路径需要的两半——`lerpFrom(null, t) => scale(t)`（`box_decoration.dart:254-259`）与 `scale`（`:238-249`，每个字段都用 `lerp(null, x, factor)` 缩放）。`factor = 0` 时所有字段变成零值（透明色、零宽边框、空阴影），`factor = 1` 时等于原对象。

### 4.7 顺带记住 `strokeInset`

```dart
// borders.dart:299-303
double get strokeInset => width * (1 - (1 + strokeAlign) / 2);
```

默认 `strokeAlign = -1.0`（全部向内），所以 `strokeInset == width`。`BoxDecoration.padding` 走 `border?.dimensions`（`box_decoration.dart:220`），而 `Border.dimensions` 是 `EdgeInsets.all(math.max(side.strokeInset, 0))`（`borders.dart:663`）。

**关键认知**：`BorderSide` 的宽度**不总是等于它占用的布局空间**。`strokeAlign` 为 0 时一个 `width: 8` 的边框只让内容内缩 4；`strokeAlign = 1` 时 `strokeInset` 是负数并被 `math.max(..., 0)` 夹到 0——**边框画在盒子外面、完全不挤压内容**。这是 `strokeAlign` 存在的理由。

## 五、核心对象：两半契约的职责分工

| | `Decoration` | `BoxPainter` |
|---|---|---|
| 可变性 | `@immutable`（`decoration.dart:32`） | 有状态（可缓存 `Paint`、订阅异步资源） |
| 实例数量 | 一份配置可被多个 `RenderObject` 共享 | **每个绘制目标一份** |
| 生命周期 | 与 `Widget` 的 build 同频，随时被换掉 | 由 `RenderDecoratedBox` 持有，换 `decoration` 时 `dispose` |
| 必须实现 | `createBoxPainter` | `paint` |
| 需要 `==` 吗 | **需要**（否则每次 paint 都重建 painter） | 不需要 |
| 有 `dispose` 吗 | 没有 | 有（`@mustCallSuper`） |
| 能碰 `Canvas` 吗 | 不能 | 只能通过 `paint` 的参数 |
| 参与动画 | 通过 `lerp` | 不参与（每帧用新配置重画） |

**关键认知**：这套拆分把"**每帧都会变的东西**"和"**跨帧可以缓存的东西**"分开了。`Decoration` 每帧可能是新的（动画中），但它很便宜；`BoxPainter` 是有状态的、昂贵的（`Paint`、shader、图片订阅），所以它被 `RenderDecoratedBox` 缓存，只在配置真变了才重建。`BoxDecoration.operator ==` 那 9 个字段的比较（`box_decoration.dart:319-335`）就是这条缓存的守门人。

## 六、源码实验

### 实验 1：painter 只创建一次，跨尺寸变更被复用（实测）

```dart
class CountingDecoration extends Decoration {
  CountingDecoration(this.log);
  final List<String> log;
  @override
  BoxPainter createBoxPainter([VoidCallback? onChanged]) {
    log.add('createBoxPainter');
    return CountingPainter(log, onChanged);
  }
  @override
  bool operator ==(Object other) => other is CountingDecoration;   // 内容不变即相等
  @override
  int get hashCode => 0;
}
// CountingPainter 在 paint 里记录 offset 和 configuration.size

await tester.pumpWidget(/* 100x100 的 DecoratedBox */);
print('after first pump: $log');
log.clear();
await tester.pumpWidget(/* 同类型 decoration，尺寸改成 120x100 */);
print('after size change: $log');
```

**预测**：因为 `_painter ??=` 只在 null 时创建（`rendering/proxy_box.dart:2474`），第二次 pump 只应该看到 `paint`，不应该看到 `createBoxPainter`。

**实际**（实测输出）：

```text
after first pump: [createBoxPainter, paint offset=Offset(350.0, 250.0) size=Size(100.0, 100.0)]
after size change (same == decoration): [paint offset=Offset(340.0, 250.0) size=Size(120.0, 100.0)]
```

**说明**：完全符合预测。第二次只有 `paint`，没有 `createBoxPainter`；`size` 从 `(100,100)` 变成 `(120,100)`、`offset` 从 `350` 变成 `340`（因为居中导致左移 10）。**同一份 `BoxPainter` 就这样被复用在两个不同尺寸上**——这也解释了 `_BoxDecorationPainter._getBackgroundPaint` 里那个缓存条件为什么要判 `_rectForCachedBackgroundPaint != rect`：painter 会跨尺寸存活，所以按矩形缓存的东西必须自己检查矩形变了没有。

### 实验 2：painter 里 `save()` 不配对会抛出完整错误（实测）

```dart
class LeakyPainter extends BoxPainter {
  @override
  void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
    canvas.save();   // 故意不 restore
  }
}
```

**预测**：`RenderDecoratedBox.paint` 在装饰前后各取一次 `canvas.getSaveCount()`，应该抛 `FlutterError`。

**实际**（实测）：抛出了 `FlutterError`，错误里包含 `ErrorSummary('LeakyDecoration painter had mismatching save and restore calls.')`、说明 save/restore 必须配对的 `ErrorDescription`、以及 `The decoration was` / `The painter was` 两条诊断属性（`rendering/proxy_box.dart:2483-2507`）。

**说明**：这条断言只在 debug 下存在（包在 `assert(() {...}())` 里），release 下整块被剥除。所以**"忘了 restore 的 painter 在 debug 下会响亮报错，在 release 下会静默污染后续绘制"**。写自定义 `Decoration` 时务必把 `save` / `restore` 成对写。

### 实验 3：`BoxDecoration.getClipPath` 是被覆写过的（实测，反直觉）

```dart
try { print(const BoxDecoration().getClipPath(const Rect.fromLTWH(0, 0, 1, 1), TextDirection.ltr)); }
catch (e) { print('THREW ${e.runtimeType}'); }
print(const BoxDecoration(shape: BoxShape.circle)
    .getClipPath(const Rect.fromLTWH(0, 0, 10, 10), TextDirection.ltr));
```

**预测**：`Decoration.getClipPath` 的默认实现抛 `UnsupportedError`（`decoration.dart:194-198`），`BoxDecoration` 大概没覆写它，应该抛。

**实际**（实测输出）：**两次都返回了 `Path`，没有抛异常。**

**说明**：预测错了。`BoxDecoration` **覆写了** `getClipPath`（`box_decoration.dart:223`），三种 `shape`/`borderRadius` 组合都能给出路径（`:225-235`）。**默认抛异常不等于实现会抛**——判断一个子类支不支持某个能力，要看它有没有覆写。

### 实验 4：不相干的两种 `Decoration` 在 t=0.5 处通过"空"过渡（实测）

```dart
final r = Decoration.lerp(const LeakyDecoration(), const BoxDecoration(color: Color(0xFF000000)), 0.5);
print('${r.runtimeType} $r');
final r0 = Decoration.lerp(const LeakyDecoration(), const BoxDecoration(), 0.0);
print('${r0.runtimeType}');
```

**预测**：两个类互不认识的 `lerp` 会走 `decoration.dart:156` 的兜底；`t = 0.5` 时不满足 `t < 0.5`，所以走 `b.lerpFrom(null, (0.5-0.5)*2.0)` = `b.lerpFrom(null, 0.0)`，即 `BoxDecoration.scale(0.0)`。

**实际**（实测输出）：

```text
lerp(LeakyDecoration, BoxDecoration, 0.5) = BoxDecoration BoxDecoration(color: Color(alpha: 0.0000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB))
lerp at t=0 = LeakyDecoration
```

**说明**：`t = 0.5` 时返回的确实是 `BoxDecoration`，但**所有字段都被缩到零**：颜色是 `alpha: 0.0000` 的全透明黑，边框、阴影、图片都为 null。也就是说"空"在 `BoxDecoration` 里是用"透明黑 + 零边框"表示的，`scale(0.0)` 就是这个状态。`t = 0.0` 时因为 `identical`/`t == 0.0` 短路直接返回 `a`，根本没有调用 `lerpFrom`。

**实用结论**：从 `BoxDecoration` 动画到一个不同类型的 `Decoration`（比如自定义形状）时，中途会经过"完全透明"，视觉上就是淡出再淡入。这不是 bug，是 `Decoration.lerp` 的既定兜底策略。

### 实验 5：`strokeAlign` 决定边框占多少布局空间（实测）

```dart
const d = BoxDecoration(
  border: Border.fromBorderSide(BorderSide(color: Color(0xFF000000), width: 4)),
);
print('padding=${d.padding}');
const side = BorderSide(color: Color(0xFF000000), width: 4);
print('strokeInset=${side.strokeInset} strokeAlign=${side.strokeAlign}');
print('BorderSide(width:0).strokeInset=${const BorderSide(width: 0).strokeInset}');
print(const Border(top: BorderSide(width: 4), left: BorderSide(width: 8)).dimensions);
```

**预测**：默认 `strokeAlign = -1`，`strokeInset` 应等于 `width`；`width: 0` 时应为 0；非均匀边框的 `dimensions` 应逐边不同。

**实际**（实测输出）：

```text
padding=EdgeInsets.all(4.0)
strokeInset=4.0 strokeAlign=-1.0
BorderSide(width:0).strokeInset=0.0
Border dims nonuniform=EdgeInsets(8.0, 4.0, 0.0, 0.0)
```

**说明**：全部符合预测。第 2 行确认 `width: 0` 的"hairline"边框**不占布局空间**——它仍然会画出一条细线（`box_border.dart` 有专门处理），但不会让内容内缩。第 3 行确认 `Border.dimensions` 是**逐边独立**的（top 4、left 8、其余 0），不是统一取最大值。

## 七、结论

1. 装饰被拆成**不可变描述（`Decoration`）+ 有状态执行（`BoxPainter`）**两半。拆分的理由是生命周期：描述要能 `==` / `lerp` / 共享，painter 会缓存 `Paint`、订阅异步资源、需要 `dispose`。`RenderDecoratedBox` 用 `_painter ??=` 让 painter 跨帧、跨尺寸复用，只在配置对象被换掉时重建。
2. `BoxPainter` 契约里有**两条硬约束**：`paint` 拿到的 `configuration.size` 必须非空；`dispose` 之后不能再调 `onChanged`。save/restore 配对不在契约文本里，只有 `RenderDecoratedBox` 在 **background 位置**那条分支上用 debug saveCount 断言强制它（foreground 位置不查）。`Decoration` 那边则是**宽接口窄义务**——六个成员里只有 `createBoxPainter` 是抽象的。
3. `Decoration` 与 `ShapeBorder` 是两套并列抽象，分界标准是**能不能用内外两条路径描述**。`ShapeDecoration` 是两者之间的桥。`BoxDecoration` 的绘制顺序（阴影 → 背景 → 图片 → 边框）和 `_adjustedRectOnOutlinedBorder` 的矩形收缩都是契约的一部分，不是实现细节。

一句话总结：**`Decoration` 是"我想长什么样"，`BoxPainter` 是"谁来画、画完要不要通知我"——前者可以随便丢弃，后者要小心持有。**

## 八、边界声明

- `BoxBorder` / `Border` / `BorderDirectional` 的四条边绘制分支（`paintBorder` 与 `paintNonUniformBorder` 的性能取舍、hairline 处理）`box_border.dart` 有 1139 行，本篇只用到 `dimensions` 与 `strokeInset`，不做逐行讲解。
- `DecorationImage` 与 `ImageProvider` 的接线（`box_decoration.dart:538-561` 的 `_paintBackgroundImage` 如何从 `decoration.image` 造出 `_imagePainter`）留到第十六篇。
- `setIsComplexHint` 到 `Layer` 的路径（`isComplex` 为什么值得独立 layer）属于合成协议；第八卷 Layer 与合成篇会从 `rendering` 侧再走一遍。
- `Decoration.hitTest` 在 `RenderDecoratedBox.hitTestSelf` 里的完整命中链路（`hitTest` → `hitTestChildren` → `hitTestSelf`）留到第八卷 RenderObject 协议篇；第六卷 hitTest 篇会从 `gestures` 侧走一遍。
- `ShapeBorder` 的 `add` / `operator +` / `_CompoundBorder` 合并规则、各具体形状的路径构造（`rounded_rectangle_border.dart` 604 行、`star_border.dart` 706 行等）不做专题。
