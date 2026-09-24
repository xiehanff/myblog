# 58 Gradient 与 ShapeDecoration：装饰如何变成 Shader 与笔刷

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/gradient.dart`（1179 行）、`painting/shape_decoration.dart`（482 行）、`painting/box_decoration.dart`（591 行）、`painting/decoration.dart`（256 行）、`painting/borders.dart`（963 行）；另引用 `rendering/proxy_box.dart`、`widgets/implicit_animations.dart`

## 一、问题

一句话问题：`BoxDecoration(gradient: LinearGradient(...))` 里的渐变，从"一段参数描述"变成"屏幕上的颜色过渡"，中间到底发生了什么——为什么容器尺寸变了，渐变不会拉伸错位？

先拆两个错误直觉。

**直觉一：渐变是画出来的一张图。** 顺着这个直觉会推出"`BoxDecoration` 持有一张渐变位图，画的时候贴上去"，进而疑惑"尺寸变了贴图怎么自己跟着变"。源码给出的答案是：`Gradient` 是一个**不可变的参数描述**（`painting/gradient.dart:157`），它唯一的产出方法是

```dart
// painting/gradient.dart:225
Shader createShader(Rect rect, {TextDirection? textDirection});
```

`Shader` 在 **paint 当场**按**当时的 rect** 求值，塞进 `Paint.shader` 才参与绘制。求值输入有三个：rect、textDirection、transform。rect 变了不按新 rect 重新 `createShader`，画出来的就是旧几何的错位结果——后文 4.4 会看到 painter 的缓存全部以 rect 为 key，原因就在这。

**直觉二：`ShapeDecoration` 是 `BoxDecoration` 的通用版。** 这个直觉半对半错：`ShapeDecoration` 确实能描述任意 `ShapeBorder`，但两者是 `Decoration` 的**平级实现**（`decoration.dart:33` 的两个主要子类，此外还有 `FlutterLogoDecoration` 等特殊实现），能力集互有缺口——`BoxDecoration` 有 `borderRadius` + `boxShadow` + `backgroundBlendMode` 但形状只有 circle/rectangle 两种；`ShapeDecoration` 接受任意形状，却没有 `borderRadius`、`backgroundBlendMode` 的位置，且 `color` 与 `gradient` 直接被断言禁止同时出现（`shape_decoration.dart:75-76`）。4.5 节展开。

与第 14 篇的分工：第 14 篇已经讲过 `Decoration`/`BoxPainter` 的两半契约、`RenderDecoratedBox.paint` 的懒创建、`BoxDecoration` 的四步绘制顺序、`_getBackgroundPaint` 缓存条件与 `Decoration.lerp` 的 0.5 兜底，本文一律不重讲。本文聚焦三件事：**Gradient 如何求值成 Shader、装饰何时失效、lerp 怎么参与动画**。

## 二、最小 Demo

绕开 `BoxDecoration`，直接把 `Gradient` 当画笔原料用——这能看清"求值"发生在哪一刻：

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(home: ShaderDemo());
}

class ShaderDemo extends StatefulWidget {
  const ShaderDemo({super.key});

  @override
  State<ShaderDemo> createState() => _ShaderDemoState();
}

class _ShaderDemoState extends State<ShaderDemo> {
  bool _wide = false;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: GestureDetector(
        // 1. 每次点击在 100x100 与 240x80 两个尺寸之间切换
        onTap: () => setState(() => _wide = !_wide),
        child: AnimatedSize(
          duration: const Duration(milliseconds: 400),
          child: CustomPaint(
            size: _wide ? const Size(240, 80) : const Size(100, 100),
            painter: GradientRectPainter(
              // 2. 同一个 LinearGradient 对象贯穿两个尺寸，从不重建
              gradient: const LinearGradient(
                colors: <Color>[Color(0xFF2196F3), Color(0xFFFFC107)],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class GradientRectPainter extends CustomPainter {
  const GradientRectPainter({required this.gradient});

  final Gradient gradient;

  @override
  void paint(Canvas canvas, Size size) {
    // 3. rect 是 paint 当场的尺寸，不是创建 gradient 时的尺寸
    final Rect rect = Offset.zero & size;
    // 4. createShader(rect) 按当前矩形求值 → Shader 进 Paint.shader
    final Paint paint = Paint()
      ..shader = gradient.createShader(rect, textDirection: TextDirection.ltr);
    canvas.drawRect(rect, paint);
  }

  // 5. painter 实例不变、gradient 不变，尺寸变化照样按新 rect 求值
  @override
  bool shouldRepaint(GradientRectPainter oldDelegate) => false;
}
```

把 `CustomPaint` 换成 `DecoratedBox(decoration: BoxDecoration(gradient: ...))` 是等价的——框架只是把第 3、4 步挪进了 `_BoxDecorationPainter`（`box_decoration.dart:419-421`）。

渐变不在"配置时"变成像素。`LinearGradient` 默认的 `begin = Alignment.centerLeft`、`end = Alignment.centerRight`（`gradient.dart:382-383`）描述的是"任意矩形的左中点 / 右中点"这种**比例语义**，而不是两个固定像素点——它靠 `AlignmentGeometry.withinRect(rect)`（`painting/alignment.dart:435-439`）在求值时落成具体坐标（`Alignment` 是函数，见第 12 篇）。同一个 `Gradient` 对象可以复用在任何尺寸上，代价是每次 rect 变化都要重新求值。

## 三、入口锚点

| 锚点 | 职责 |
|---|---|
| `painting/gradient.dart:157` / `painting/gradient.dart:225` | `Gradient` 抽象类与唯一的产出方法 `createShader(Rect rect, {TextDirection? textDirection})` |
| `painting/gradient.dart:432` / `painting/gradient.dart:722` / `painting/gradient.dart:1032` | Linear / Radial / Sweep 三个子类的 `createShader`：rect 如何进入各自几何参数 |
| `painting/gradient.dart:76` / `painting/gradient.dart:330` | `GradientTransform` 抽象与 `_resolveTransform`：transform 只作用于 shader |
| `painting/box_decoration.dart:407-425` | `_getBackgroundPaint`：以 rect 为 key 缓存背景 Paint 与 shader |
| `painting/shape_decoration.dart:65` / `painting/shape_decoration.dart:309` | `ShapeDecoration` 与 `_precache`：rect + textDirection 双 key 的整组缓存 |
| `rendering/proxy_box.dart:2411-2419` / `rendering/proxy_box.dart:2473` | `RenderDecoratedBox` 的 decoration setter（失效路径）与 paint（求值现场） |
| `painting/gradient.dart:312-329` | `Gradient.lerp`：同族插值与跨族兜底的总入口 |
| `widgets/implicit_animations.dart:73-84` / `widgets/implicit_animations.dart:829` | `DecorationTween.lerp` 与 `_AnimatedContainerState.build` 每帧求值 |

## 四、调用链

### 4.1 `Gradient` 的抽象契约：求值输入有三个

```dart
// painting/gradient.dart:157-239（结构）
abstract class Gradient {
  const Gradient({required this.colors, this.stops, this.transform});

  final List<Color> colors;              // 至少两个颜色，构造时不校验
  final List<double>? stops;             // 可空；为 null 时均匀分布
  final GradientTransform? transform;    // 只作用于 shader，不作用于 canvas

  List<double> _impliedStops() { ... }   // gradient.dart:207

  @factory
  Shader createShader(Rect rect, {TextDirection? textDirection});  // gradient.dart:225

  Gradient scale(double factor);         // gradient.dart:236  供 lerp 兜底用（见 4.7）
  Gradient withOpacity(double opacity);  // gradient.dart:239
}
```

两个容易被忽略的契约细节：

1. **参数合法性推迟到求值时才校验**。`colors` 至少两个、`stops` 与 `colors` 等长，这些在构造注释里写明 "the length is not verified until the `createShader` method is called"（`gradient.dart:160-164`）。所以一个配置错误的 `Gradient` 可以安静地通过 build，直到第一次 paint 才炸。
2. **`stops` 为 null 时均匀分布**是 `_impliedStops`（`gradient.dart:207-214`）算出来的：`index * (1.0 / (colors.length - 1))`。三个子类的 `createShader` 和 `lerp` 都走它。

### 4.2 三个子类：rect 怎么进入各自的几何参数

三个子类都是"参数映射器"：把 rect + 自身参数翻译成 `dart:ui` 的 `ui.Gradient.*` 构造参数。差异全在"哪些参数吃 rect"：

| 子类 | 几何参数与默认值 | rect 的参与方式 | 交给 dart:ui 的 |
|---|---|---|---|
| `LinearGradient`（`gradient.dart:377`） | `begin = centerLeft`、`end = centerRight`、`tileMode = clamp` | 两端点 `resolve(textDirection).withinRect(rect)` | `ui.Gradient.linear`（`gradient.dart:432-440`） |
| `RadialGradient`（`gradient.dart:644`） | `center = center`、`radius = 0.5`、`focal = null`、`focalRadius = 0.0`、`tileMode = clamp` | 圆心 `withinRect(rect)`；半径 `radius * rect.shortestSide` | `ui.Gradient.radial`（`gradient.dart:722-733`） |
| `SweepGradient`（`gradient.dart:957`） | `center = center`、`startAngle = 0.0`、`endAngle = 2π`、`tileMode = clamp` | 只有圆心 `withinRect(rect)`；角度与 rect 无关 | `ui.Gradient.sweep`（`gradient.dart:1032-1041`） |

```dart
// painting/gradient.dart:432-440（LinearGradient.createShader）
@override
Shader createShader(Rect rect, {TextDirection? textDirection}) {
  return ui.Gradient.linear(
    begin.resolve(textDirection).withinRect(rect),   // begin 落到当前矩形
    end.resolve(textDirection).withinRect(rect),
    colors,
    _impliedStops(),
    tileMode,
    _resolveTransform(rect, textDirection),
  );
}
```

`withinRect` 的实现值得抄一遍，它是"比例语义"的落点：

```dart
// painting/alignment.dart:435-439
Offset withinRect(Rect rect) {
  final double halfWidth = rect.width / 2.0;
  final double halfHeight = rect.height / 2.0;
  return Offset(rect.left + halfWidth + x * halfWidth, rect.top + halfHeight + y * halfHeight);
}
```

所以 `Alignment.centerLeft`（`x = -1.0`）在 100x100 的矩形上是 `(0, 50)`，在 240x80 的矩形上是 `(0, 40)`——**同一个 Gradient、同一个 alignment，不同 rect 求值出不同的 shader**。`RadialGradient.radius` 的语义是"最短边的比例"（`gradient.dart:675-680` 文档：100x200 的盒子上 `radius = 1.0` 外圈是 100px），同样随 rect 变化。`SweepGradient` 是唯一"角度不吃 rect"的子类，但圆心仍吃。

`textDirection` 的作用点也在这：`AlignmentDirectional`（如 `centerStart`）的 `resolve(textDirection)` 决定 start 是左还是右。这就是 `createShader` 签名里带 `TextDirection?` 的原因——不带它，方向相关的渐变无法求值。

### 4.3 `GradientTransform`：只转 shader，不转 canvas

```dart
// painting/gradient.dart:76-88
abstract class GradientTransform {
  const GradientTransform();

  Matrix4? transform(Rect bounds, {TextDirection? textDirection});
}
```

类文档第一句就划清了边界（`gradient.dart:69-71`）："Base class for transforming gradient shaders **without applying the same transform to the entire canvas**."。`_resolveTransform`（`gradient.dart:330-333`）把矩阵转成 `Float64List` 传给 `ui.Gradient.*` 构造——矩阵挂在 **shader 内部**，canvas 上其他绘制不受影响。

> `GradientRotation(math.pi / 4)` 转的是渐变的采样坐标系（绕 `bounds.center` 旋转 45 度），而不是"把画布转 45 度"。对比 `canvas.rotate`：后者影响后续所有绘制。`GradientRotation.transform` 的实现（`gradient.dart:114-124`）自己算平移量把旋转凑到 bounds 中心，也印证了它拿到的只有 `bounds`，碰不到 canvas。

### 4.4 装饰何时失效：主要路径（衔接第 14 篇）

第 14 篇讲过 `RenderDecoratedBox.paint` 的懒创建（`_painter ??= _decoration.createBoxPainter(markNeedsPaint)`，`rendering/proxy_box.dart:2474`）和 `configuration.copyWith(size: size)`（`rendering/proxy_box.dart:2475`）。本节补"什么会触发下一次 paint"——与本文求值直接相关的主要前三条，configuration / position 是容易被漏掉的另外两条入口：

**路线一：Decoration 值变化，走 setter。** `DecoratedBox.updateRenderObject`（`widgets/container.dart:91-98`）把新 decoration 塞进 setter：

```dart
// rendering/proxy_box.dart:2411-2419
set decoration(Decoration value) {
  if (value == _decoration) {
    return;                   // 1. == 短路：Decoration 的 == 是缓存守门人（第 14 篇）
  }
  _painter?.dispose();        // 2. 旧 painter 释放（onChanged 从此不再回调）
  _painter = null;            // 3. 置空 → 下一次 paint 重新 createBoxPainter
  _decoration = value;
  markNeedsPaint();           // 4. 真正触发重绘的调用
}
```

这把 `==` 落到渐变上比较的是**值**而不是对象：`BoxDecoration` 的 `operator ==` 逐字段比较（`box_decoration.dart:319-335`），其中 `other.gradient == gradient`（`box_decoration.dart:332`）调用的是三个子类各自的值相等实现——先比 `runtimeType`，再比几何参数、tileMode、transform、colors/stops：`LinearGradient` 比 begin/end（`gradient.dart:522-535`）、`RadialGradient` 另加 center/radius/focal/focalRadius（`gradient.dart:818-833`）、`SweepGradient` 比 center/startAngle/endAngle（`gradient.dart:1124-1138`）。据此可以精确判定 lerp 中间帧何时过不了这道门：跨族动画（Linear → Radial）在 `runtimeType` 上就必不等，逐帧重建 painter；两端渐变值相同、只是 color 在动的动画，中间帧的 gradient 与旧值字段级相等，`==` 能否短路取决于其余字段。

**路线二：尺寸变化，不换 painter。** layout 之后框架会隐式让该节点 repaint（`rendering/object.dart:3271-3275` 文档："the `markNeedsPaint` method is implicitly called by the framework after a render object is laid out"）。painter 还是旧实例，靠 4.6 的缓存 key 发现 rect 变了、重新求值 shader。

**路线三：异步资源完成，走 onChanged。** `DecorationImage` 加载完图片后回调 `BoxPainter.onChanged`——它就是 paint 时传入的 `markNeedsPaint`（`proxy_box.dart:2474`），所以图片到位后自动重画一次。`detach` 时 painter 被 dispose 并 `markNeedsPaint`（`proxy_box.dart:2449-2461`），保证重新挂载后能重建订阅（动画 GIF 靠这条续命）。

**路线四：configuration / position 变化，走各自的 setter。** `RenderDecoratedBox` 还有两个独立的重绘入口：`set position`（`proxy_box.dart:2424-2430`，前后景切换）与 `set configuration`（`proxy_box.dart:2440-2446`，`ImageConfiguration` 变化——`DecoratedBox.updateRenderObject`（`widgets/container.dart:92-97`）每次都把 `createLocalImageConfiguration(context)` 塞进去，`Directionality` 变化时 textDirection 跟着变）。这两条不属于前三类：setter 不碰 `_painter`（painter 不重建）、尺寸也不变，只是 `markNeedsPaint`；shader 会不会按新 textDirection 重新求值，取决于 4.6 的缓存 key——这正是 `BoxDecoration` 与 `ShapeDecoration` 行为分叉的地方（见 4.6 末尾）。

### 4.5 两个平级 painter：`BoxDecoration` vs `ShapeDecoration`

推翻"通用版"直觉的最好方式是把两个 painter 的绘制结构并排看：

```dart
// box_decoration.dart:571-585（第 14 篇已讲顺序，此处只列骨架）
void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
  final Rect rect = offset & configuration.size!;
  _paintShadows(canvas, rect, textDirection);          // 阴影：_paintBox 复用形状逻辑
  _paintBackgroundColor(canvas, rect, textDirection);  // 纯色/渐变：_getBackgroundPaint
  _paintBackgroundImage(canvas, rect, configuration);  // 图片
  _decoration.border?.paint(canvas, rect, ...);        // 边框
}
```

```dart
// shape_decoration.dart:472-480
@override
void paint(Canvas canvas, Offset offset, ImageConfiguration configuration) {
  assert(configuration.size != null);
  final Rect rect = offset & configuration.size!;
  final TextDirection? textDirection = configuration.textDirection;
  _precache(rect, textDirection);                        // 先整组缓存（见 4.6）
  _paintShadows(canvas, rect, textDirection);            // 阴影
  _paintInterior(canvas, rect, textDirection);           // 纯色/渐变
  _paintImage(canvas, configuration);                    // 图片
  _decoration.shape.paint(canvas, rect, textDirection: textDirection);  // 边框
}
```

顺序相同（阴影 → 背景 → 图片 → 边框），差异在**每一步怎么落到 canvas**：

| | `_BoxDecorationPainter` | `_ShapeDecorationPainter` |
|---|---|---|
| 形状来源 | `shape` 字段只有 `circle` / `rectangle` 两种（`box_decoration.dart:217`） | 任意 `ShapeBorder`（`shape_decoration.dart:172`） |
| 背景绘制 | `_paintBox` 直发专用指令：`drawCircle` / `drawRect` / `drawRRect`（`box_decoration.dart:429-447`） | 按 `shape.preferPaintInterior` 分两路（见下） |
| 阴影 | 每个阴影现造 `Paint`，`_paintBox(bounds, paint)` 画（`box_decoration.dart:448-471`） | 预计算 bounds 或 `getOuterPath`，缓存后循环画 |
| 图片裁剪 | 按 shape 手工构造 `clipPath`（圆或 RRect，`box_decoration.dart:536-563`） | `_innerPath = shape.getInnerPath(rect)`（`shape_decoration.dart:359`） |
| color 与 gradient | 可同时非空；`_getBackgroundPaint` 里先后把 `color` 与 `shader` 设进同一只 `Paint`（`box_decoration.dart:416-421`），但 gradient 字段文档写明 "If this is specified, [color] has no effect."（`box_decoration.dart:189-194`）——非空 gradient 时 color 不生效 | 断言互斥：`assert(!(color != null && gradient != null))`（`shape_decoration.dart:75-76`） |
| 没有的能力 | 无：形状只能是两种、不能换任意 ShapeBorder | 无：`borderRadius`、`backgroundBlendMode`、非均匀 `Border` 的直接入口 |

`preferPaintInterior` 的两路是 `ShapeDecoration` 泛化成本的核心：

```dart
// painting/borders.dart:638 / painting/borders.dart:608
bool get preferPaintInterior => false;   // ShapeBorder 默认走 path
```

- `preferPaintInterior == true`：形状自己实现了 `paintInterior`（`borders.dart:608`），能直发专用指令——`CircleBorder`（`circle_border.dart:91-100`）调 `drawCircle`、`RoundedRectangleBorder`（`rounded_rectangle_border.dart:112-121`）调 `drawRRect`；
- `false`：`ShapeDecoration` 只能 `getOuterPath(rect)` 构造 `Path`，再 `canvas.drawPath`（`shape_decoration.dart:428-437` 的 `_paintInterior`）。

> `BoxDecoration` 把"圆 / 矩形"硬编码进了每一步（背景、阴影、图片裁剪三处都要 switch shape）；`ShapeDecoration` 把形状抽成参数 `ShapeBorder`，代价是每一步都退化成"问 ShapeBorder 要 path 或要专用画法"。这就是"平级实现、能力集不同"的准确含义：`BoxDecoration` 窄而固定（形状只有两种、每步直发专用指令），`ShapeDecoration` 宽而通用（任意 `ShapeBorder`、每步经它中转）。`ShapeDecoration.fromBoxDecoration`（`shape_decoration.dart:81-107`）是单向桥——把 `BoxDecoration` 翻译成 `ShapeDecoration`（circle → `CircleBorder`，rectangle+radius → `RoundedRectangleBorder`），反方向没有对应工厂。

### 4.6 rect、缓存与失效：两组 key

**`BoxDecoration`：一把 key（rect，不含 textDirection），只缓存背景 Paint。**

```dart
// box_decoration.dart:407-425（第 14 篇已讲存在性，此处看条件）
Paint _getBackgroundPaint(Rect rect, TextDirection? textDirection) {
  if (_cachedBackgroundPaint == null ||
      (_decoration.gradient != null && _rectForCachedBackgroundPaint != rect)) {
    final paint = Paint();
    if (_decoration.color != null) {
      paint.color = _decoration.color!;
    }
    if (_decoration.gradient != null) {
      paint.shader = _decoration.gradient!.createShader(rect, textDirection: textDirection);
      _rectForCachedBackgroundPaint = rect;        // 只有带渐变时才记录 key
    }
    _cachedBackgroundPaint = paint;
  }
  return _cachedBackgroundPaint!;
}
```

注意条件的另一半：**无渐变时缓存无条件复用**——纯色 `Paint` 不依赖 rect。有渐变时，`_rectForCachedBackgroundPaint != rect` 就整只 Paint 重建（不是只换 shader），重新走一次 `createShader(rect)`。另外第 14 篇提过的一个细节在这里有了完整语境：`_paintBackgroundColor`（`box_decoration.dart:472-478`）绘制用收缩后的 `adjustedRect`、求 shader 用原始 `rect`——渐变必须按原始矩形求值，否则起止点会跟着边框宽度抖动。

> **注意 textDirection 不在这把 key 里**。缓存条件（`box_decoration.dart:410-411`）只比较 rect；shader 求值时用的 textDirection（`box_decoration.dart:419-420`）不进 key。于是同 rect 下切换 `Directionality`：`configuration` setter 只做 `_configuration = value; markNeedsPaint();`（`proxy_box.dart:2440-2446`），painter 不清、rect 没变，`_getBackgroundPaint` 直接复用旧 Paint——用 `AlignmentDirectional` 渐变时，可能继续用按旧方向求值的 shader。这是 3.44.8 的实际缓存行为；"方向变化也重新求值"的保证只在 `ShapeDecoration` 成立（`_precache` 的 key 含 textDirection）。

**`ShapeDecoration`：两把 key（rect + textDirection），缓存一整组。**

```dart
// shape_decoration.dart:309-312
void _precache(Rect rect, TextDirection? textDirection) {
  if (rect == _lastRect && textDirection == _lastTextDirection) {
    return;                       // 双 key 都没变 → 整组复用，直接返回
  }
  ...
```

变了就要重建的清单（`shape_decoration.dart:316-364`）：

| 缓存 | 依赖 | 重建动作 |
|---|---|---|
| `_interiorPaint.shader` | rect、textDirection | `gradient.createShader(rect, textDirection: ...)`（`shape_decoration.dart:324-328`） |
| `_shadowBounds` 或 `_shadowPaths` | rect、textDirection、每个 shadow 的 offset/spreadRadius | `rect.shift(offset).inflate(spread)` 或对其 `getOuterPath`（`shape_decoration.dart:330-353`） |
| `_outerPath` | rect、textDirection | `shape.getOuterPath(rect)`（`shape_decoration.dart:354-357`） |
| `_innerPath` | rect、textDirection | `shape.getInnerPath(rect)`（`shape_decoration.dart:358-360`，有图片才需要） |

`_precache` 开头那两行短路，就是"装饰求值必须跟 rect 走"在 `ShapeDecoration` 里的全部实现。`textDirection` 之所以也是 key，是因为 `AlignmentDirectional` 渐变、`BorderDirectional` 的 path 都随它变——`Directionality` 变化会走 `configuration` setter（`proxy_box.dart:2440-2446`）触发 `markNeedsPaint`，下一帧 `_precache` 发现 key 变了、整组重建。这正是 `BoxDecoration` 缺失的那把 key：同样的 Directionality 切换，两个 painter 一个重建、一个复用。

### 4.7 lerp → 新 Decoration → 重绘：动画的每一帧

隐式动画里渐变怎么动起来？以 `AnimatedContainer(decoration: ...)` 为例，每个动画帧的完整路径：

```text
animation clock（每帧 t 前进）
  → _AnimatedContainerState.build（implicit_animations.dart:826-830）
    → decoration: _decoration?.evaluate(animation)        // implicit_animations.dart:829
      → Animatable.evaluate（animation/tween.dart:71）= transform(animation.value)
        → DecorationTween.lerp（implicit_animations.dart:83）
          → Decoration.lerp(begin, end, t)                 // decoration.dart:138-157
            → t=0/t=1 直接返回端点对象（decoration.dart:148-152），中间帧产出新的 Decoration 值
  → Container → DecoratedBox → updateRenderObject
    → RenderDecoratedBox.decoration setter（proxy_box.dart:2411）
      → == 不成立才：dispose 旧 painter、markNeedsPaint
        → 下一帧 paint：createBoxPainter → 按当前 rect 求 shader
```

`forEachTween`（`implicit_animations.dart:779-785`）负责把新旧两个 decoration 装进 `DecorationTween`：旧值是 `begin`，新目标值是 `end`——所以动画过程中 `widget.decoration`（新值）与 `evaluate` 出来的中间值是两回事，`RenderDecoratedBox` 看到的是 lerp 的产物（中间帧是新对象，t=0/t=1 帧可能是端点原对象）。

三个 lerp 实现的差异值得逐个记：

**`Gradient.lerp`（`gradient.dart:312-329`）**：先试 `b.lerpFrom(a, t)`，再试 `a.lerpTo(b, t)`，都不行走兜底 `t < 0.5 ? a.scale(1.0 - (t * 2.0)) : b.scale((t - 0.5) * 2.0)`（`gradient.dart:327`）——**跨族渐变（Linear → Radial）没有形变插值，只有"前半段淡出、后半段淡入"**。同族插值的底座是 `_interpolateColorsAndStops`（`gradient.dart:45-68`）：把两边的 stops 并集排序（`SplayTreeSet`），每个 stop 处各采样一次再 `Color.lerp`。而 `tileMode` 和 `transform` **不插值**，`t < 0.5` 选 a、否则选 b（三个子类 lerp 的共同写法，如 `gradient.dart:516-517` 的 TODO 注释所言 "interpolate tile mode" 是没做的事）。

**`BoxDecoration.lerp`（`box_decoration.dart:291-316`）**：中间帧构造（`box_decoration.dart:307-315`）插值 color、image、border、borderRadius、boxShadow、gradient 六项，`shape: t < 0.5 ? a.shape : b.shape`（`box_decoration.dart:314`）——**circle ↔ rectangle 之间不做形变**。另一个坑是 `backgroundBlendMode`：它不在中间帧的构造参数里（`box_decoration.dart:307-315` 只传了上述六项加 shape），两端 blend mode 不同的动画，中间帧会退回 null（默认混合模式）而不是被插值或保留任一端，直到端点帧（t=0/t=1 直接返回端点对象）才恢复；而 `BoxDecoration` 自己的 `==` 是比较 backgroundBlendMode 的（`box_decoration.dart:333`）。文档（`box_decoration.dart:273-275`）明确指了出路："To interpolate the shape, consider using a [ShapeDecoration]"。

**`ShapeDecoration.lerp`（`shape_decoration.dart:219-238`）**：color / gradient / image / shadows / shape 逐项插值，其中 `shape: ShapeBorder.lerp(a?.shape, b?.shape, t)`。但 `ShapeBorder.lerp`（`borders.dart:512-517`）只是个分发器：先试 `b?.lerpFrom(a, t)`，再试 `a?.lerpTo(b, t)`，任一返回非 null 就用它；两端都没实现对方，才落到 `t < 0.5 ? a : b` 的分段兜底。**形状能否连续形变，取决于两端 `ShapeBorder` 类型有没有实现相互的 `lerpFrom`/`lerpTo`，不是 `ShapeDecoration` 自身的功劳。**本地 3.44.8 的两个对照例：`RoundedRectangleBorder` 侧专门实现了对 `CircleBorder` 的跨类型插值（`rounded_rectangle_border.dart:59-66` / `rounded_rectangle_border.dart:78-85`，返回 `_RoundedRectangleToCircleBorder`，circularity 随 t 连续变化），所以这一对能形变；`CircleBorder`（`circle_border.dart:60` / `circle_border.dart:71` 只认同类型）↔ `BeveledRectangleBorder`（`beveled_rectangle_border.dart:46` / `beveled_rectangle_border.dart:57` 也只认同类型）两边都返回 null，只能在 t=0.5 前后直接切换形状。它的 `lerpFrom`/`lerpTo`（`shape_decoration.dart:184-201`）还处理了混合端点：对端是 `BoxDecoration` 时先 `ShapeDecoration.fromBoxDecoration` 翻译再插值——所以 `AnimatedContainer` 的两端分别是 `BoxDecoration` 和 `ShapeDecoration` 也能动。

## 五、核心对象

| | `Gradient` | `Shader` |
|---|---|---|
| 是什么 | 不可变的参数描述（colors/stops/transform + 几何参数） | dart:ui 对象：`createShader` 的返回值、`Paint.shader` 的取值（采样语义在引擎侧，本文不展开） |
| 数量级 | 一份配置全局可复用 | 每次 `createShader` 新建，随 rect/textDirection 不同而不同 |
| 生命周期 | 与 `Decoration` 同频，被 `==` / `lerp` 消费 | 挂在 `Paint` 上，随 painter 缓存，rect 变即重建 |
| 知道尺寸吗 | 不知道，只存比例参数 | 知道，构造时把 rect 折算进了坐标 |
| 参与 hitTest 吗 | 不参与 | 不参与 |

| | `_BoxDecorationPainter` | `_ShapeDecorationPainter` |
|---|---|---|
| 缓存 key | `_rectForCachedBackgroundPaint`（单 key，且有渐变才记） | `_lastRect` + `_lastTextDirection`（双 key，永远记） |
| 缓存内容 | 背景一只 `Paint` | interiorPaint、outerPath、innerPath、shadow bounds/paths/paints 整组 |
| 形状指令 | 硬编码 `drawCircle` / `drawRect` / `drawRRect` | `preferPaintInterior` 决定：专用指令或 `drawPath` |
| 阴影与图片裁剪 | 按 shape 手工构造 | 复用 `getOuterPath` / `getInnerPath` 的结果 |
| `isComplex` | `boxShadow != null`（`box_decoration.dart:252`） | `shadows != null`（`shape_decoration.dart:181`） |
| 适合谁 | 矩形 / 圆形 / 圆角矩形的常见盒子 | 任意形状；形状 lerp 是否连续取决于两端 `ShapeBorder` 是否互相实现 `lerpFrom`/`lerpTo` |

## 六、源码实验

三组实验共用的渐变与两个目标 rect（沿用第二节的 painter 结构，差异只写在 painter 里）：

```dart
const Gradient kGradient = LinearGradient(
  colors: <Color>[Color(0xFF2196F3), Color(0xFFFFC107)],
);
const Rect kSquare = Rect.fromLTWH(0, 0, 100, 100);
const Rect kWide = Rect.fromLTWH(0, 0, 240, 80);
```

### 实验 1：改 rect，正确重建 shader vs 错误复用旧 shader

```dart
/// 正确版：每次 paint 按当前 rect 求值（框架内部的写法）
class CorrectPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final Rect rect = Offset.zero & size;
    // 1. 每次 paint 都 createShader(rect)
    final Paint paint = Paint()..shader = kGradient.createShader(rect);
    canvas.drawRect(rect, paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}

/// 错误版：把"渐变当一张图"的直觉写进代码——shader 只求值一次
class StalePainter extends CustomPainter {
  StalePainter() {
    // 2. 只在构造时求值一次，之后 rect 再变也不重建
    _paint = Paint()..shader = kGradient.createShader(kSquare);
  }

  late final Paint _paint;

  @override
  void paint(Canvas canvas, Size size) {
    final Rect rect = Offset.zero & size;
    // 3. 画的是新 rect，用的却是旧 shader
    canvas.drawRect(rect, _paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}
```

在 240x80 的 `CustomPaint` 里分别跑两个 painter。

**预测**：正确版的渐变端点按 240x80 求值，参数域覆盖整个宽度；错误版的端点按 100x100 的 kSquare 求值，绘制 240 宽矩形时 x > 100 的区域落在端点之外——framework 侧能证明的只有 tileMode 被原样传给 `ui.Gradient.linear`（`gradient.dart:432-440`），那块区域具体显示什么颜色是 `clamp` 的引擎采样语义，不在本文源码证据范围内。

**实际（按源码路径推演）**：shader 的端点坐标在 `createShader(kSquare)` 时已经折算完成——`begin.resolve(ltr).withinRect(kSquare)` 落在 `(0, 50)`、`end` 落在 `(100, 50)`（`alignment.dart:435-439` 的 `withinRect` 是纯算术，可以手算）。用它绘制 240 宽矩形时，超出 `[0, 100]` 的区域如何取色是 dart:ui 行为，本文只能推到这里。验证方式：把两个 painter 并排放进同一个 `Row`，肉眼对比右侧颜色分布。

**说明**：这正是 `_getBackgroundPaint` 的缓存条件（`box_decoration.dart:410-411`）和 `_precache` 的双 key 短路（`shape_decoration.dart:310-312`）要防的错。框架的 painter 之所以跨尺寸存活却不出错，靠的是"key 变了就重建"，而不是"shader 能自己适配"。

### 实验 2：lerp 动画中每帧产生一个新 Decoration

```dart
class _DemoState extends State<Demo> {
  bool _on = false;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: GestureDetector(
        onTap: () => setState(() => _on = !_on),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 500),
          width: 240,
          height: 80,
          // 1. 两端同族：中间帧是逐色插值的 LinearGradient
          decoration: _on
              ? const BoxDecoration(gradient: kGradient)
              : const BoxDecoration(color: Color(0xFF37474F)),
        ),
      ),
    ),
  );
}
```

**预测**：中间帧是"`BoxDecoration.lerp` 的产物对象"——`color` 与 `gradient` 各自向对方方向插值（`Color.lerp` 与 `Gradient.lerp`，`box_decoration.dart:308-314`）。换成两端异族渐变（`LinearGradient` → `RadialGradient`）时，前半程是 a 的透明化、后半程是 b 的不透明化（`gradient.dart:327` 的兜底），视觉上先淡出再淡入。

**实际（按源码路径推演）**：中间帧 `DecorationTween.lerp` → `Decoration.lerp` 产出新的 `BoxDecoration` 实例（`decoration.dart:148-152` 在 t=0/t=1 直接返回端点对象，不新建）；中间帧实例与上一帧 `==` 不成立（字段在插值），setter 这才 `dispose` 旧 painter、`markNeedsPaint`（`proxy_box.dart:2413-2418`）——每次都先经过 `==` 短路，值没变就不重建。验证方式：在两端之间插一个自定义 `Decoration` 子类，在 `createBoxPainter` 里 `debugPrint`，动画期间应看到中间帧逐帧一条日志（首尾端点帧不必然有）。

**说明**：动画中间帧的 painter 是**逐帧一换**的（端点帧例外：lerp 返回端点对象、`==` 短路后 painter 原地不动），4.6 的缓存只在单帧内起作用（同一帧里同一 rect 只求值一次）。这也解释了为什么 `Gradient.lerp` 的产物宁可新建对象也不做 mutable 复用——`Decoration` 的不可变性让"中间帧新值 + setter 比对"这条链路足够便宜。

### 实验 3：`isComplex` 到底做了什么

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn "get isComplex" painting/decoration.dart painting/box_decoration.dart painting/shape_decoration.dart
grep -n "decoration.isComplex\|setIsComplexHint" rendering/proxy_box.dart
grep -n "isComplexHint" rendering/layer.dart
```

**预测**：`isComplex` 会触发某种缓存或 RepaintBoundary 的自动创建。

**实际**：消费链只有三跳，且与 RepaintBoundary 无关：

```text
Decoration.isComplex（decoration.dart:72，默认 false）
  → RenderDecoratedBox.paint 里 if (decoration.isComplex) context.setIsComplexHint()
    （proxy_box.dart:2508-2510 / proxy_box.dart:2515-2517，background 与 foreground 各一处）
  → PaintingContext.setIsComplexHint（rendering/object.dart:433）给当前 PictureLayer 打标
    → PictureLayer.isComplexHint = true（rendering/layer.dart:859-865）
```

三个实现各只有一行：`Decoration` 默认 `false`（`decoration.dart:72`）、`BoxDecoration => boxShadow != null`（`box_decoration.dart:252`）、`ShapeDecoration => shadows != null`（`shape_decoration.dart:181`）。

**说明**：`isComplexHint` 是写给合成器的**提示**——`object.dart:425-427` 的文档说 "the compositor will apply its own heuristics"（不设提示时合成器自己猜），设了只是替它把猜测定下来。它**不创建 RepaintBoundary、不保证缓存任何东西**，而且按 `setIsComplexHint` 的文档（`object.dart:429-431`）只作用于当前 canvas，新 layer 之后不传播。渐变（哪怕很贵）默认不设这个提示——只有阴影设。RepaintBoundary 什么时候真的省事，见第 35 篇；两者的分工是：`isComplex` 建议"这层值得缓存"，`RepaintBoundary` 才真正划定"重画能停在哪"。

## 七、结论

1. `Gradient` 是不可变参数描述，`createShader(rect)` 在 paint 当场按当前 rect、textDirection、transform 求值出 `Shader` 塞进 `Paint.shader`。rect 是求值输入不是配置输入——alignment 参数是矩形比例语义（`withinRect`），所以同一个 `Gradient` 可复用于任何尺寸，代价是 rect 变化必须重新求值：`BoxDecoration` 以 `_rectForCachedBackgroundPaint` 单 key（key 不含 textDirection，同 rect 的 Directionality 切换会复用旧背景 Paint）重建背景 Paint，`ShapeDecoration` 以 rect + textDirection 双 key 在 `_precache` 里整组重建 shader / path / 阴影 bounds——"方向变化也重新求值"的保证只属于后者。
2. `BoxDecoration` 与 `ShapeDecoration` 是 `Decoration` 的平级实现，不是通用版与特例版。前者把 circle/rectangle 硬编码进每一步（背景、阴影、裁剪三处 switch），直发 `drawCircle`/`drawRect`/`drawRRect` 专用指令；后者把形状抽象成 `ShapeBorder` 参数，按 `preferPaintInterior` 分"专用指令"与"`getOuterPath` + `drawPath`"两路。形状 lerp 走 `ShapeBorder.lerp` 分发：两端类型实现了相互的 `lerpFrom`/`lerpTo` 才有连续形变（如 `RoundedRectangleBorder` ↔ `CircleBorder`），否则在 t=0.5 前后分段切换（如 `CircleBorder` ↔ `BeveledRectangleBorder`）；另一回报是 `lerpFrom`/`lerpTo` 里 `fromBoxDecoration` 的单向桥。
3. 与本文求值相关的主要失效路径有三条：值变化（setter 的 `==` 短路 → dispose → `markNeedsPaint`）、尺寸变化（layout 后隐式 repaint，painter 不换、缓存 key 换）、异步资源完成（`onChanged` 即 `markNeedsPaint`）；此外 configuration（含 textDirection）与 position 变化走各自的 setter 独立 `markNeedsPaint`（`proxy_box.dart:2424-2430`、`proxy_box.dart:2440-2446`），不属于前三类。动画走的是第一条：`AnimatedContainer` 的中间帧由 `DecorationTween.lerp` 产出新 `Decoration` 实例（t=0/t=1 直接返回端点对象），setter 在值确实变化且 `==` 不成立时才重建 painter；`Gradient.lerp` 同族逐色插值但 tileMode/transform 在 t=0.5 处二选一，跨族只有淡出淡入兜底。

**渐变在每次 paint 时按当前矩形现场求值成 Shader，而不是一张画好的图——装饰框架的全部缓存设计，都是在保证"求值跟着 rect 走"这件事不出错。**

## 八、边界声明

- `ui.Gradient.linear/radial/sweep` 之后的事（shader 在引擎侧如何被采样、光栅化）是 dart:ui 与引擎的地盘，3.44.8 的 SDK 里没有这部分源码，不展开；painting 层的边界到 `Paint.shader` 为止。
- `Decoration`/`BoxPainter` 两半契约、`RenderDecoratedBox.paint` 的懒创建与 saveCount 断言、`Decoration.lerp` 的 0.5 兜底语义，第 14 篇已讲，本文只引用不重讲。
- `DecorationImage` 与 `ImageProvider` 的解码、缓存、`onChanged` 的完整接线是第 16 篇的内容；`TextPainter` 是第 15 篇。
- `RepaintBoundary`、`PictureLayer` 复用与合成器的缓存策略在第 35 篇；本文的 `isComplex` 只到 `isComplexHint` 落在 layer 上为止。
- `BoxBorder`（`Border`/`BorderDirectional`）的四边绘制与 `_CompoundBorder` 合并规则、`StarBorder` 等具体形状的路径构造，不做逐行讲解。

