# Flutter Compositing 与 Layer Tree 深入

[toc]

## 概念总览

`paint()` 方法把绘制指令记录到 `Picture` 里，但这并不意味着每一帧都要从头到尾重新画一遍。Flutter 引入 Layer Tree（图层树）和 Compositing（合成）机制，让"哪些东西变了需要重画"和"哪些东西没变可以复用"之间的界限变得清晰可控。

可以先记住一句话：

> Paint 产生绘制指令，Layer Tree 把这些指令组织成有层级的合成图，Raster 线程负责把最终结果光栅化到屏幕上。

理解 Compositing 需要把从 `RenderObject.paint()` 到屏幕像素的完整链路串起来：

```text
RenderObject.paint()
    ↓ 通过 PaintingContext 记录绘制指令
Picture（绘制指令记录，底层为 DisplayList 格式）
    ↓ 组织成 Layer Tree
Layer Tree
    ↓ SceneBuilder 序列化
Scene
    ↓ Raster 线程消费
LayerTree（C++）
    ↓ Skia / Impeller 渲染
GPU 帧缓冲 → 屏幕像素
```

这篇文章就沿着这条链路，逐层拆解 Compositing 的原理、Layer 的类型体系、`RepaintBoundary` 的合成隔离机制、`SaveLayer` 的性能代价、`SceneBuilder` 的工作方式，以及 Raster 线程的渲染管线。

> 补充一个背景：Dart 侧看到的 `Picture` 来自 `PictureRecorder` 的 `endRecording()`，在现行引擎中它的底层实现统一是 DisplayList（Impeller 的录制/回放格式）。早期文档里说的 `SkPicture` 可以理解为它的旧称呼，本文在讲 Skia 后端时仍会沿用这个习惯叫法。

---

## 一、为什么需要 Compositing（合成）

### 1.1 从 Paint 到屏幕的完整链路

在 Flutter 里，一个 `RenderObject` 的 `paint()` 方法执行时，它并不是直接往屏幕上画像素，而是把绘制指令记录到一个 `Picture` 对象里。这个 `Picture` 本质上是一段"录制好的绘制脚本"——你告诉它"先画个矩形，再画段文字，再画张图片"，但它不会立刻执行。

真正让这些指令变成像素的，是后面一条长长的链路：

```text
┌─────────────────────────────────────────────────────┐
│  UI Thread (Dart)                                    │
│                                                      │
│  RenderObject.paint()                                │
│       ↓ 通过 PaintingContext 录制                     │
│  Picture（绘制指令集合）                                │
│       ↓ 组织成树状结构                                 │
│  Layer Tree                                          │
│       ↓ SceneBuilder.build()                         │
│  Scene                                               │
└─────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│  Raster Thread (C++)                                 │
│                                                      │
│  LayerTree（Scene 的 C++ 表示）                        │
│       ↓ 遍历每个 Layer                                │
│  SkPicture / DisplayList 回放                         │
│       ↓                                              │
│  GPU 执行渲染命令                                      │
│       ↓                                              │
│  帧缓冲区（Frame Buffer）                              │
└─────────────────────────────────────────────────────┘
                       ↓
                  屏幕像素
```

这条链路的关键特点是：**UI 线程负责"决定画什么"，Raster 线程负责"真正画出来"**。两者通过 `Scene` 对象交接。

### 1.2 如果没有合成层会怎样

假设整个屏幕只有一个图层。屏幕上有一个正在播放的视频、一个不断闪烁的光标、一段静态文字和一个正在旋转的动画图标。

现在光标闪烁了一下——哪怕只是改变了一个像素——整个屏幕的所有内容都必须重新经过 Paint → Raster → GPU 这条链路。视频帧、文字渲染、动画图标，全部重新来一遍。

这就是"没有合成"的代价：**任何局部变化都会触发全局重绘**。

把它想成一个 Photoshop 文件：

- **单层模式**：所有东西都画在同一层上，改一个光标的大小就要重画整个画面
- **图层模式**：光标单独一层，改光标只需要重画光标那一层，其他层直接复用上次的结果

合成层的核心价值就在于：**让独立变化的部分可以独立重绘，互不影响**。

### 1.3 合成的核心价值

合成机制解决的是"重绘粒度"的问题。具体来说：

- **隔离脏区域**：一个 `RepaintBoundary` 以下的子树被标记为脏时，只有这个边界以内的内容需要重新 paint 和 raster，不影响其他部分
- **复用已合成的 Layer 子树**：内容没变的 Layer 子树可以通过 EngineLayer 直接"保留"（retained rendering），UI 线程不再重新提交它的指令，Raster 线程也不再重新光栅化；在旧的 Skia 后端里，复杂 Picture 还会被 RasterCache 缓存为 GPU 纹理再复用（Impeller 已移除 RasterCache，改为依赖更便宜的重放）
- **高效合成**：Raster 线程只需要对变化了的 Layer 重新光栅化，然后和其他未变化的 Layer 一起合成到屏幕上

用一个类比来理解：

> 就像 Photoshop 的图层。每个图层独立编辑，修改文字图层不会影响背景图层。最终"合并可见图层"就是合成。在 Flutter 里，这个"合并"不是在 CPU 上做的，而是在 GPU 上通过合成管线完成的。

### 1.4 在一帧中的位置

一帧的流水线由 `SchedulerBinding` 的 `handleDrawFrame()` 驱动（build → layout → paint → composite），Compositing 处于 `drawFrame` 的最后阶段：

```text
handleDrawFrame()
    ↓
build（重建 Widget / Element 树）
    ↓
layout（约束传递 + 尺寸计算）
    ↓
paint（记录绘制指令 → Layer Tree）
    ↓
compositing（SceneBuilder → Scene → 交给 Raster 线程）
    ↓
post-frame callbacks
```

`paint` 和 `compositing` 之间的关系是：paint 构建 Layer Tree，compositing 把 Layer Tree 转换成 Scene 交给 Raster 线程。理解了这条链路，后面每一节的内容都会变得清晰。

---

## 二、Layer 类型体系

### 2.1 `Layer` 基类

Flutter 的 Layer 体系有一个清晰的继承结构。`Layer` 是所有图层的基类，定义在 `package:flutter/rendering.dart` 中。

```dart
// flutter/lib/src/rendering/layer.dart
abstract class Layer extends AbstractNode with DiagnosticableTreeMixin {
  // 被添加到 Layer 树时的回调
  @mustCallSuper
  void attach(covariant Object owner) { ... }

  // 从 Layer 树移除时的回调
  @mustCallSuper
  void detach() { ... }

  // 将自身及其子层添加到 SceneBuilder 中
  // 这是抽象方法，每个子类必须实现
  @protected
  void addToScene(ui.SceneBuilder builder);

  // 查找注解（用于语义、辅助功能等）
  @nonVirtual
  bool findAnnotations<S extends Object>(
    AnnotationResult<S> result,
    Offset localPosition, {
    required bool onlyFirst,
  }) { ... }

  // 引擎层的句柄：addToScene 时由 SceneBuilder 的 push* 方法返回，
  // 下一帧可以作为 oldLayer 传入，或用 addRetained 整棵复用
  @protected
  ui.EngineLayer? get engineLayer => _engineLayer;
  ui.EngineLayer? _engineLayer;

  @protected
  set engineLayer(ui.EngineLayer? value) {
    _engineLayer?.dispose();
    _engineLayer = value;
    // 子层换了 engineLayer，父层也必须重新 addToScene
    if (!alwaysNeedsAddToScene && parent != null) {
      parent!.markNeedsAddToScene();
    }
  }

  // 是否每帧都需要重新 addToScene（true 会禁用 retained rendering 复用）
  // 默认 false，只有 LeaderLayer / FollowerLayer 这类"被动跟随外部变化"的层才为 true
  @protected
  bool get alwaysNeedsAddToScene => false;

  // 标记此 Layer 需要重新 addToScene
  @protected
  void markNeedsAddToScene() { ... }

  // 保留渲染：内容没变时直接把上一帧的 engineLayer 塞回 Scene，
  // 不再递归调用子层的 addToScene
  void _addToSceneWithRetainedRendering(ui.SceneBuilder builder) {
    if (!_needsAddToScene && _engineLayer != null) {
      builder.addRetained(_engineLayer!);   // ← 复用的关键
      return;
    }
    addToScene(builder);
    _needsAddToScene = false;
  }
}
```

几个关键点：

- **`addToScene(SceneBuilder)`**：这是 Layer 最核心的方法。每个 Layer 子类通过重写这个方法，把自己的渲染效果"编码"到 `SceneBuilder` 中。`SceneBuilder` 收集完所有 Layer 的指令后，调用 `build()` 生成 `Scene`
- **`attach` / `detach`**：Layer 被挂载到 Layer 树或从树中移除时的生命周期回调。子类可以在这里做初始化或清理工作
- **`engineLayer`**：指向 Engine 侧（C++）对应的图层对象，由 `SceneBuilder` 的 `push*` 方法返回。它的复用有两条路径：一是下一帧作为 `oldLayer` 参数传回 `push*` 方法，让 Engine 更新而不是重建；二是当整棵子树都没变时（`_needsAddToScene == false`），通过 `addRetained` 直接把上一帧的 engineLayer 重新挂进 Scene——这就是"retained rendering"，未变化的子树完全跳过重新提交和重新光栅化
- **`_needsAddToScene`**：一个布尔标志，记录"这棵 Layer 子树自上次合成以来是否变过"。`markNeedsAddToScene()` 把它置 true；每次 `buildScene` 开始前会先递归做 `updateSubtreeNeedsAddToScene()`，把子树的变化向上汇聚
- **`alwaysNeedsAddToScene`**：某些 Layer 无论内容是否变化，每帧都必须重新 `addToScene`（比如跟随外部 `LayerLink` 变化的 `FollowerLayer`），它会禁用 retained rendering 复用。默认是 `false`

### 2.2 Layer 继承体系

```text
Layer
├── ContainerLayer
│   ├── OffsetLayer          ← 给子层添加偏移（最常用的容器层）
│   │   ├── TransformLayer   ← 应用矩阵变换（缩放/旋转/倾斜）
│   │   ├── OpacityLayer     ← 半透明层
│   │   └── ImageFilterLayer ← 图像滤镜
│   ├── ClipRectLayer        ← 矩形裁剪
│   ├── ClipRRectLayer       ← 圆角矩形裁剪
│   ├── ClipRSuperellipseLayer ← 超椭圆（连续圆角）裁剪
│   ├── ClipPathLayer        ← 路径裁剪
│   ├── ColorFilterLayer     ← 颜色滤镜
│   ├── BackdropFilterLayer  ← 背景滤镜
│   ├── ShaderMaskLayer      ← 着色器遮罩
│   ├── LeaderLayer / FollowerLayer ← CompositedTransformTarget/Follower 使用
│   └── AnnotatedRegionLayer ← 注解区域（语义、手势命中）
├── PictureLayer             ← 持有 Picture（绘制指令记录）的叶子层
├── TextureLayer             ← 外部纹理层（视频、相机等）
├── PlatformViewLayer        ← 平台视图层（iOS UIView 嵌入）
└── PerformanceOverlayLayer  ← 性能叠加层（性能分析浮层）
```

> 注意 `TransformLayer`、`OpacityLayer`、`ImageFilterLayer` 并不是 `ContainerLayer` 的直接子类，而是继承自 `OffsetLayer`——它们在施加效果之外还自带一个偏移量，这也是为什么"根 Layer 可以是 TransformLayer、RepaintBoundary 的 Layer 必须是 OffsetLayer"这类约束能够成立。

**`ContainerLayer` vs `Layer`**：

- `Layer` 是叶子节点（如 `PictureLayer`），没有子 Layer
- `ContainerLayer` 是容器节点，可以管理一组子 Layer（`firstChild` / `lastChild` / `nextSibling` / `previousSibling`），形成一棵树

大部分 Layer 类型都是 `ContainerLayer` 的子类，因为它们既需要施加某种效果（裁剪、变换、透明度等），又需要包含子 Layer。

### 2.3 `OffsetLayer`

`OffsetLayer` 是最常用的容器层。它的作用很简单：给所有子层施加一个二维平移偏移。

```dart
class OffsetLayer extends ContainerLayer {
  OffsetLayer({ Offset offset = Offset.zero }) : _offset = offset;

  Offset get offset => _offset;
  Offset _offset;

  void set offset(Offset value) {
    if (value != _offset) {
      markNeedsAddToScene();
    }
    _offset = value;
  }

  @override
  void addToScene(ui.SceneBuilder builder) {
    // Skia 对"仅平移"的矩阵拼接有快速路径，所以平移层开销很低。
    // 保留渲染时不希望把 offset 下推到每个叶子节点，否则高层
    // offset 的变化会波及太多叶子层。
    engineLayer = builder.pushOffset(
      offset.dx,
      offset.dy,
      oldLayer: _engineLayer as ui.OffsetEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}
```

**为什么 `OffsetLayer` 如此重要？**

因为 `RenderRepaintBoundary`（也就是 `RepaintBoundary` Widget 对应的 RenderObject）使用的就是 `OffsetLayer`——框架甚至通过 `assert(_layerHandle.layer is OffsetLayer)` 强制约束这一点。此外，整棵 Layer Tree 的根由 `RenderView.prepareInitialFrame()` 创建，是一个携带设备像素比变换的 `TransformLayer`（3.x 早期版本曾是 `OffsetLayer` + `setTransform` 的组合，现已改为根 `TransformLayer`），所有子 Layer 的坐标最终都相对于这个根 Layer。`OffsetLayer` 在 Layer Tree 中的角色就像 DOM 中的 `div`——无处不在，提供位置定位。

### 2.4 `TransformLayer`

`TransformLayer` 比 `OffsetLayer` 更通用：它可以施加任意 4x4 矩阵变换（包括缩放、旋转、倾斜、透视等）。

```dart
class TransformLayer extends OffsetLayer {
  TransformLayer({ Matrix4? transform, super.offset }) : _transform = transform;

  Matrix4? get transform => _transform;
  Matrix4? _transform;   // 可变属性，setter 会 markNeedsAddToScene

  @override
  void addToScene(ui.SceneBuilder builder) {
    _lastEffectiveTransform = transform;
    if (offset != Offset.zero) {
      // offset 在 Dart 侧先并入变换矩阵，再整体传给引擎
      _lastEffectiveTransform = Matrix4.translationValues(offset.dx, offset.dy, 0.0)
        ..multiply(_lastEffectiveTransform!);
    }
    engineLayer = builder.pushTransform(
      _lastEffectiveTransform!.storage,
      oldLayer: _engineLayer as ui.TransformEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}
```

**`TransformLayer` 和 `OffsetLayer` 的区别**：

| 特性 | `OffsetLayer` | `TransformLayer` |
|------|--------------|-----------------|
| 变换类型 | 仅平移（dx, dy） | 任意 4x4 矩阵 |
| 性能开销 | 低（Engine 优化路径） | 稍高（通用矩阵计算） |
| `engineLayer` 类型 | `ui.OffsetEngineLayer` | `ui.TransformEngineLayer` |
| 使用场景 | 布局偏移 | 缩放、旋转、3D 变换 |

在 Flutter 中，当你使用 `Transform` Widget 时，如果变换不是纯平移，底层就会创建 `TransformLayer`。

### 2.5 裁剪层：`ClipRectLayer` / `ClipRRectLayer` / `ClipPathLayer`

这三种裁剪层分别对应三种裁剪形状：

```dart
// 矩形裁剪（默认 clipBehavior 为 Clip.hardEdge）
class ClipRectLayer extends ContainerLayer {
  ClipRectLayer({ Rect? clipRect, this.clipBehavior = Clip.hardEdge });

  Rect? get clipRect => _clipRect;
  Rect? _clipRect;         // 可变属性，setter 会 markNeedsAddToScene
  Clip clipBehavior;

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushClipRect(
      clipRect!,
      clipBehavior: clipBehavior,
      oldLayer: _engineLayer as ui.ClipRectEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}

// 圆角矩形裁剪（默认 clipBehavior 为 Clip.antiAlias）
class ClipRRectLayer extends ContainerLayer {
  ClipRRectLayer({ RRect? clipRRect, this.clipBehavior = Clip.antiAlias });

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushClipRRect(
      clipRRect!,
      clipBehavior: clipBehavior,
      oldLayer: _engineLayer as ui.ClipRRectEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}

// 路径裁剪
class ClipPathLayer extends ContainerLayer {
  ClipPathLayer({ Path? clipPath, this.clipBehavior = Clip.antiAlias });

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushClipPath(
      clipPath!,
      clipBehavior: clipBehavior,
      oldLayer: _engineLayer as ui.ClipPathEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}
```

注意 `clipBehavior` 参数：

- `Clip.none`：不裁剪也不创建 Layer。`PaintingContext.pushClipRect` 等方法遇到 `Clip.none` 会直接执行 painter 回调，`ClipRectLayer` 构造函数也通过 `assert(clipBehavior != Clip.none)` 禁止传入
- `Clip.hardEdge`：硬边裁剪，性能最好，`ClipRectLayer` 的默认值
- `Clip.antiAlias`：抗锯齿裁剪，`ClipRRectLayer` / `ClipPathLayer` 的默认值
- `Clip.antiAliasWithSaveLayer`：抗锯齿 + SaveLayer，当裁剪区域内部有半透明内容时使用，性能最差

**当 `clipBehavior` 为 `antiAliasWithSaveLayer` 时，Engine 会在裁剪区域内创建一个离屏缓冲区**（这就是 [第五节](#五savelayer-的性能代价) 要讲的 SaveLayer 的触发场景之一）。

### 2.6 `OpacityLayer`

`OpacityLayer` 用于给子层添加半透明效果。它是性能讨论中最常被提及的 Layer 类型，因为它底层会触发 SaveLayer。

```dart
class OpacityLayer extends OffsetLayer {
  OpacityLayer({ int? alpha, super.offset });

  int? get alpha => _alpha;
  int? _alpha;   // 可变属性，setter 会 markNeedsAddToScene

  @override
  void addToScene(ui.SceneBuilder builder) {
    // 没有子层时直接跳过，不产生任何引擎层
    if (firstChild == null) {
      engineLayer = null;
      return;
    }

    final int realizedAlpha = alpha!;
    if (realizedAlpha < 255) {
      engineLayer = builder.pushOpacity(
        realizedAlpha,
        offset: offset,
        oldLayer: _engineLayer as ui.OpacityEngineLayer?,
      );
    } else {
      // alpha == 255 时完全不需要混合，退化为普通的平移层
      engineLayer = builder.pushOffset(
        offset.dx,
        offset.dy,
        oldLayer: _engineLayer as ui.OffsetEngineLayer?,
      );
    }
    addChildrenToScene(builder);
    builder.pop();
  }
}
```

**关键点**：`alpha` 使用 0-255 的整数，对应 `Opacity` Widget 中的 `0.0-1.0` 浮点值。当 `alpha` 为 255 时，框架层（不是 Engine 层）就会做优化——不再 `pushOpacity`，而是退化为 `pushOffset`，完全跳过混合操作；没有子层时这个 Layer 甚至不会提交给 Engine。

> 当你在 Flutter 中使用 `Opacity(opacity: 0.5, child: ...)` 时，底层就是创建了一个 `OpacityLayer(alpha: 128)`。如果 `child` 很复杂（比如一个包含大量内容的列表），这个 SaveLayer 的代价可能非常高。
>
> 替代方案：如果只是想让子组件变透明，且子组件有纯色背景，可以直接修改子组件的背景色透明度，避免触发 SaveLayer。

### 2.7 滤镜层：`ColorFilterLayer` / `ImageFilterLayer` / `BackdropFilterLayer`

这三种滤镜层分别对应不同的视觉效果：

```dart
// 颜色滤镜：改变颜色的色相、饱和度、亮度等
class ColorFilterLayer extends ContainerLayer {
  ColorFilterLayer({ ColorFilter? colorFilter });

  ColorFilter? get colorFilter => _colorFilter;   // 注意字段名是 colorFilter

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushColorFilter(
      colorFilter!,
      oldLayer: _engineLayer as ui.ColorFilterEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}

// 图像滤镜：模糊、矩阵变换等（继承自 OffsetLayer，自带 offset）
class ImageFilterLayer extends OffsetLayer {
  ImageFilterLayer({ ui.ImageFilter? imageFilter, super.offset });

  ui.ImageFilter? get imageFilter => _imageFilter;   // 注意字段名是 imageFilter

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushImageFilter(
      imageFilter!,
      offset: offset,
      oldLayer: _engineLayer as ui.ImageFilterEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}

// 背景滤镜：对 Layer 下方已渲染的内容施加滤镜（毛玻璃效果）
class BackdropFilterLayer extends ContainerLayer {
  BackdropFilterLayer({
    ui.ImageFilter? filter,
    this.blendMode = BlendMode.srcOver,
  });

  ui.ImageFilter? get filter;
  BlendMode blendMode;   // 滤镜结果叠加回背景时使用的混合模式

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushBackdropFilter(
      filter!,
      blendMode: blendMode,
      oldLayer: _engineLayer as ui.BackdropFilterEngineLayer?,
      backdropId: _backdropKey?._key,  // 同组滤镜可共享一次背景采样
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}
```

**`BackdropFilterLayer` 的特殊性**：

它不是对自己内部的子内容施加滤镜，而是对**自身下方已经渲染到屏幕上的内容**施加滤镜。这就是"毛玻璃效果"的实现原理：

```dart
// 毛玻璃效果
BackdropFilter(
  filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
  child: Container(
    color: Colors.white.withOpacity(0.3),  // 半透明白色覆盖
    child: ...,
  ),
)
```

这里 `BackdropFilter` 读取它"背后"的内容，进行高斯模糊，然后子组件的半透明白色叠加在模糊后的内容上，形成毛玻璃效果。

**所有这三种滤镜层在 Engine 侧都会触发 SaveLayer**，所以它们的性能代价不可忽视（详见 [第五节](#五savelayer-的性能代价)）。

### 2.8 `PictureLayer`

`PictureLayer` 是真正的"叶子节点"——它不包含子 Layer，而是直接持有一个 `Picture` 对象。

```dart
class PictureLayer extends Layer {
  /// 构造时传入的是"画布范围估计"（canvasBounds），不是偏移量。
  /// 它只用于调试和剔除优化（帮助引擎裁掉屏幕外的绘制指令），
  /// 不影响实际绘制位置。
  PictureLayer(this.canvasBounds);

  final Rect canvasBounds;

  /// 录制完成后通过 setter 赋值；赋值会 markNeedsAddToScene
  ui.Picture? get picture;
  ui.Picture? _picture;
  set picture(ui.Picture? picture) {
    markNeedsAddToScene();
    _picture?.dispose();
    _picture = picture;
  }

  /// 提示引擎"本层内容复杂，值得缓存"
  bool isComplexHint;
  /// 提示引擎"本层内容下一帧就会变，别缓存"
  bool willChangeHint;

  @override
  void addToScene(ui.SceneBuilder builder) {
    assert(picture != null);
    builder.addPicture(
      Offset.zero,   // 偏移在录制时已经折算进 Picture 坐标系
      picture!,
      isComplexHint: isComplexHint,
      willChangeHint: willChangeHint,
    );
  }
}
```

**`PictureLayer` 的特殊之处**：

- 它是 `Layer` 的子类，不是 `ContainerLayer` 的子类——它是叶子节点，没有子 Layer
- 它没有重写 `alwaysNeedsAddToScene`：`Picture` 没变、位置没变时，整层可以参与 retained rendering 复用；需要重绘时，框架会创建新的 `Picture` 并通过 `picture` setter 触发 `markNeedsAddToScene`
- `isComplexHint` / `willChangeHint` 是给引擎的缓存提示（`CustomPainter.isComplex` / `willChange` 最终会走到这里），在 Skia 后端会影响 RasterCache 的决策
- 一个 `PictureLayer` 可以包含大量的绘制指令（画路径、画文字、画图片等），这些指令都记录在 `Picture` 中

**整棵 Layer Tree 最终就是由大量的 `PictureLayer`（持有实际绘制内容）和各种 `ContainerLayer`（施加变换、裁剪、滤镜等效果）组成的**。

### 2.9 `ShaderMaskLayer`

`ShaderMaskLayer` 用一个着色器（Shader）来遮罩其子层的内容。

```dart
class ShaderMaskLayer extends ContainerLayer {
  Shader? shader;      // 着色器，可变属性
  Rect? maskRect;      // 着色器只在这个矩形内生效，且以它的左上角为原点
  BlendMode? blendMode;

  @override
  void addToScene(ui.SceneBuilder builder) {
    engineLayer = builder.pushShaderMask(
      shader!,
      maskRect!,
      blendMode!,
      oldLayer: _engineLayer as ui.ShaderMaskEngineLayer?,
    );
    addChildrenToScene(builder);
    builder.pop();
  }
}
```

使用场景：渐变遮罩、噪点纹理叠加等。和滤镜层一样，它也会触发 SaveLayer。

### 2.10 `TextureLayer`

`TextureLayer` 不持有 `Picture`，而是持有一个外部纹理的 ID。它用于显示来自 Engine 外部的图像数据。

```dart
class TextureLayer extends Layer {
  TextureLayer({
    required this.rect,          // 用一个 Rect 描述位置和大小
    required this.textureId,
    this.freeze = false,
    this.filterQuality = ui.FilterQuality.low,
  });

  final Rect rect;               // 纹理在父坐标系中的包围矩形
  final int textureId;           // 后端纹理 ID
  final bool freeze;             // 为 true 时不再接收新帧（用于 Android 视图调整大小的过渡期）
  final ui.FilterQuality filterQuality;

  @override
  void addToScene(ui.SceneBuilder builder) {
    // 注意：叶子层用的是 addTexture（add*），不是 push*
    builder.addTexture(
      textureId,
      offset: rect.topLeft,
      width: rect.width,
      height: rect.height,
      freeze: freeze,
      filterQuality: filterQuality,
    );
  }
}
```

> 这里有一个容易混淆的命名约定：`SceneBuilder` 上对**容器型效果**用 `push*`（push 之后必须 `pop`），对**叶子内容**用 `add*`（`addPicture`、`addTexture`、`addPlatformView`、`addRetained`），后者不需要配对的 `pop()`。

**使用场景**：

- **视频播放**：视频解码器输出纹理 ID，`TextureLayer` 把它合成到 Flutter 画面中
- **Platform View（Android）**：通过 Texture Layer Hybrid Composition 等模式，原生控件渲染到独立纹理，经 `TextureLayer` 嵌入 Flutter 视图层级（iOS 上的 `UIView` 嵌入则使用专门的 `PlatformViewLayer`）
- **相机预览**：相机采集的画面作为纹理合成到 Flutter UI 中

### 2.11 Layer 树结构示意

一个典型的 Flutter 界面，其 Layer Tree 大致如下：

```text
TransformLayer (root，携带设备像素比变换)
├── OffsetLayer
│   └── TransformLayer (Transform widget)
│       └── OffsetLayer
│       ├── ClipRRectLayer (Card)
│       │   └── OffsetLayer
│       │       ├── PictureLayer (文字)
│       │       └── PictureLayer (图标)
│       └── OpacityLayer (Opacity widget)
│           └── OffsetLayer
│               └── PictureLayer (半透明图片)
├── BackdropFilterLayer (毛玻璃)
│   └── OffsetLayer
│       └── PictureLayer (叠加内容)
└── OffsetLayer (列表区域)
    ├── PictureLayer (列表项 1)
    ├── PictureLayer (列表项 2)
    └── ...
```

每一个 `RenderObject` 在 `paint()` 方法中，通过 `PaintingContext` 的各种 `push*` 方法向这棵 Layer Tree 添加节点。下一节就来讲这个创建过程。

---

## 三、PaintingContext 与 Layer 的创建

### 3.1 `PaintingContext` 的角色

`PaintingContext` 是 `RenderObject.paint()` 和 Layer Tree 之间的桥梁。它提供了一组 `push*` 方法（以及懒启动的 `canvas` 录制），`RenderObject` 用它们声明"我需要裁剪 / 变换 / 透明度等效果"，`PaintingContext` 负责决定用哪种方式实现。

可以这样理解：

> `PaintingContext` 是一个"Layer 建造器"——`RenderObject` 通过调用它的方法来声明"我需要一个裁剪层"、"我需要一个变换层"，`PaintingContext` 负责创建这些 Layer 并维护它们之间的父子关系。

**关键认知：`push*` 不一定真的创建 Layer**。以 `pushClipRect` 为例，它的第一个参数是 `needsCompositing`：

- `needsCompositing == true`：创建 `ClipRectLayer`，通过 `pushLayer` 压入 Layer 树
- `needsCompositing == false`：直接在当前 `Canvas` 上调用 `clipRect`（省去建层开销），根本不产生新的 Layer

`needsCompositing` 来自 `RenderObject.needsCompositing`，它的值由"子树中是否存在 `isRepaintBoundary` 节点或 `alwaysNeedsCompositing` 节点"向上汇聚而来。换句话说：**只有当子树确实需要合成时，框架才用真正的 Layer 实现裁剪，否则一律走廉价的 Canvas 裁剪**。（例外：`pushOpacity`、`pushColorFilter` 这类效果没有 Canvas 等价实现，无论何时都会建 Layer。）

### 3.2 核心方法一览

```dart
class PaintingContext extends ClipContext {
  /// 画一个子 RenderObject（最基础的方法）
  void paintChild(RenderObject child, Offset offset) {
    // 调用子节点的 paint 方法
    child.paint(this, offset);
  }

  /// 当前录制的画布：首次访问时懒启动一段新录制
  Canvas get canvas {
    if (_canvas == null) {
      _startRecording();  // 创建 PictureLayer + PictureRecorder + Canvas
    }
    return _canvas!;
  }

  /// 压入一个裁剪矩形层（needsCompositing 为 false 时走 Canvas 裁剪）
  ClipRectLayer? pushClipRect(
    bool needsCompositing,
    Offset offset,
    Rect clipRect,
    PaintingContextCallback painter, {
    Clip clipBehavior = Clip.hardEdge,
    ClipRectLayer? oldLayer,
  }) { ... }

  /// 压入一个圆角矩形裁剪层
  ClipRRectLayer? pushClipRRect(
    bool needsCompositing,
    Offset offset,
    Rect bounds,
    RRect clipRRect,
    PaintingContextCallback painter, {
    Clip clipBehavior = Clip.antiAlias,
    ClipRRectLayer? oldLayer,
  }) { ... }

  /// 压入一个路径裁剪层
  ClipPathLayer? pushClipPath(
    bool needsCompositing,
    Offset offset,
    Rect bounds,
    Path clipPath,
    PaintingContextCallback painter, {
    Clip clipBehavior = Clip.antiAlias,
    ClipPathLayer? oldLayer,
  }) { ... }

  /// 压入一个透明度层（总是创建 Layer，无 Canvas 等价实现）
  OpacityLayer pushOpacity(
    Offset offset,
    int alpha,
    PaintingContextCallback painter, {
    OpacityLayer? oldLayer,
  }) { ... }

  /// 压入一个变换层（needsCompositing 为 false 时走 Canvas 矩阵变换）
  TransformLayer? pushTransform(
    bool needsCompositing,
    Offset offset,
    Matrix4 transform,
    PaintingContextCallback painter, {
    TransformLayer? oldLayer,
  }) { ... }

  /// 压入一个颜色滤镜层
  ColorFilterLayer pushColorFilter(
    Offset offset,
    ColorFilter colorFilter,
    PaintingContextCallback painter, {
    ColorFilterLayer? oldLayer,
  }) { ... }

  // 注意：PaintingContext 并没有 pushImageFilter / pushBackdropFilter。
  // 图像滤镜和背景滤镜由对应的 RenderObject（RenderImageFilter、
  // RenderBackdropFilter）在 paint() 中直接创建 Layer，
  // 再调用 pushLayer 压入，例如：
  //   layer ??= BackdropFilterLayer();
  //   layer!.filter = effectiveFilter;
  //   context.pushLayer(layer!, super.paint, offset);

  /// 通用方法：压入任意 ContainerLayer
  @protected
  void pushLayer(
    ContainerLayer childLayer,
    PaintingContextCallback painter,
    Offset offset, {
    Rect? childPaintBounds,
  }) {
    // 复用旧 Layer 时先清空其子层
    // 若正在录制则先 stopRecordingIfNeeded
    // 把 childLayer append 到当前容器层
    // 为新 Layer 创建子 PaintingContext 并执行 painter 回调
    // 回调结束后停止子 context 的录制
  }
}
```

两个容易忽略的细节：

- **`oldLayer` 参数**：`push*` 方法都接受上一帧创建的同类型 Layer，本帧直接修改它的属性复用（还记得 2.1 节的 `engineLayer` / retained rendering 吗？这正是 Dart 侧的配合机制）
- **`canvas` 是懒启动的**：`RenderObject` 直接画（`context.canvas.drawRect`）时，`PaintingContext` 才创建 `PictureLayer` + `PictureRecorder` 并开始录制；所以一个只 `push*` 不直接画的 `RenderObject` 不会产生多余的 `PictureLayer`

### 3.3 `pushLayer` 的工作机制

`pushLayer` 是所有 `push*` 方法的底层实现。它的核心逻辑：

```dart
void pushLayer(
  ContainerLayer childLayer,
  PaintingContextCallback painter,
  Offset offset, {
  Rect? childPaintBounds,
}) {
  // 如果是复用的旧 Layer（还带着上一帧的子层），先清空
  if (childLayer.hasChildren) {
    childLayer.removeAllChildren();
  }
  if (isRecording) {
    stopRecordingIfNeeded();
  }

  appendLayer(childLayer);

  final PaintingContext childContext = createChildContext(
    childLayer,
    childPaintBounds ?? estimatedBounds,
  );
  painter(childContext, offset);
  childContext.stopRecordingIfNeeded();
}
```

这段代码的关键步骤：

1. **`removeAllChildren()`**：如果传入的是上一帧复用的 Layer（还挂着旧子层），先清空，让 painter 重建本帧需要的子层
2. **`stopRecordingIfNeeded()`**：如果当前正在录制绘制指令（说明当前 `PictureRecorder` 中已经有内容），先停止录制——已录制的 `Picture` 会赋给早已挂到树上的 `PictureLayer`（见 3.4 节）
3. **`appendLayer(childLayer)`**：将新 Layer 添加到当前容器层
4. **`createChildContext(childLayer, bounds)`**：为新 Layer 创建一个子 `PaintingContext`，后续的绘制指令将记录到这个新 context 中
5. **`painter(childContext, offset)`**：执行传入的绘制回调（`painter`），回调中会继续调用 `push*` 方法或直接绘制
6. **`stopRecordingIfNeeded()`**：绘制回调执行完毕后，停止子 context 的录制

这个过程形成了一个递归的"压栈"结构——每次 `push*` 都把当前的绘制上下文切换到新的 Layer，回调执行完毕后再回到上一层的上下文。

### 3.4 `_startRecording` / `stopRecordingIfNeeded` 与 `PictureRecorder`

`PictureRecorder` 是 dart:ui 提供的录制对象。`PaintingContext` 惰性地持有"一个 `PictureLayer` + 一个 `PictureRecorder` + 一个 `Canvas`"的三件套：第一次访问 `canvas` 时开始录制，`pushLayer` 或 paint 结束时收尾。

```dart
// 开始录制：首次访问 canvas 时触发
void _startRecording() {
  _currentLayer = PictureLayer(estimatedBounds);   // 1. 先创建 PictureLayer
  _recorder = RendererBinding.instance.createPictureRecorder();  // 2. 创建录制器
  _canvas = RendererBinding.instance.createCanvas(_recorder!);   // 3. 包装出 Canvas
  _containerLayer.append(_currentLayer!);          // 4. 立即挂到当前容器层
}

@protected
void stopRecordingIfNeeded() {
  if (!_isRecording) {
    return;
  }
  // ...debug 模式下在这里画重绘彩虹边框（见 4.8 节）...
  _currentLayer!.picture = _recorder!.endRecording();  // 5. 结束录制，Picture 赋给 PictureLayer
  _currentLayer = null;
  _recorder = null;
  _canvas = null;
}
```

注意一个和旧版本（Flutter 3.10 之前）不同的细节：**`PictureLayer` 在开始录制时就已经 append 到 Layer 树上**，结束录制时只是把生成好的 `Picture` 通过 setter 赋进去（setter 内部会 `markNeedsAddToScene`），而不是结束时才创建并追加 `PictureLayer`。

**流程图**：

```text
RenderObject.paint(context, offset)
    │
    ├── context.canvas.drawRect(...)    ← 首次访问 canvas：_startRecording
    │                                       创建 PictureLayer 并开始录制
    ├── context.canvas.drawText(...)    ← 继续记录到同一个 PictureRecorder
    │
    ├── context.pushClipRect(needsCompositing, offset, rect,
    │       clipBehavior: Clip.antiAlias, painter: (ctx, _) {
    │       ctx.canvas.drawCircle(...)  ← 在新的 Layer 上录制（新的三件套）
    │       ctx.pushOpacity(offset, 128, painter: (ctx, _) {
    │           ctx.canvas.drawImage(...) ← 在更深的 Layer 上录制
    │       })                            ← 停止录制，Picture 赋给 PictureLayer
    │   })                                ← 停止录制，Picture 赋给 PictureLayer
    │
    ├── context.canvas.drawLine(...)     ← 回到原始 Layer，懒启动新的一段录制
    │
    └── paint 结束 → stopRecordingIfNeeded() → 最后一段录制也收尾成 PictureLayer
```

### 3.5 `RenderObject` 的 `paint()` 如何创建 Layer 树

来看一个具体的例子。假设有一个自定义的 `RenderObject`，需要在绘制内容之前先做圆角裁剪：

```dart
class CustomRenderBox extends RenderBox {
  @override
  bool get alwaysNeedsCompositing => true;  // 子树里有真正的 Layer，需要合成

  @override
  void paint(PaintingContext context, Offset offset) {
    // 第 1 步：直接在当前 Layer 上画背景
    //   首次访问 canvas 会懒启动录制（创建 PictureLayer + Recorder）
    context.canvas.drawRect(
      offset & size,
      Paint()..color = Colors.blue,
    );

    // 第 2 步：pushClipRect 会触发 stopRecordingIfNeeded
    //   → 之前的绘制内容收尾成 PictureLayer 的 picture
    //   → 创建一个新的 ClipRectLayer 并压入
    //   → 在新 Layer 上执行 painter 回调
    context.pushClipRect(
      true,                       // needsCompositing：true 时才真正建 Layer
      offset,                     // 调用者的坐标系偏移
      size.toRect(Offset.zero),   // 裁剪区域（不含 offset，方法内部会 shift）
      painter: (PaintingContext innerContext, Offset innerOffset) {
        // 在裁剪层内部画内容
        innerContext.canvas.drawCircle(
          center + innerOffset,
          20,
          Paint()..color = Colors.red,
        );
      },
      clipBehavior: Clip.antiAlias,
    );

    // 第 3 步：pushClipRect 返回后，又回到原始 Layer
    // 继续画其他内容（重新懒启动一段录制）
    context.canvas.drawRect(
      Rect.fromLTWH(offset.dx + 50, offset.dy + 50, 30, 30),
      Paint()..color = Colors.green,
    );
  }
}
```

对应的 Layer 树结构：

```text
OffsetLayer (父节点提供)
├── PictureLayer (蓝色背景 + 绿色矩形)
└── ClipRectLayer (裁剪)
    └── PictureLayer (红色圆形)
```

### 3.6 `ContainerRenderObjectMixin` 的 `paint` 模式

对于有多个子节点的容器（如 `RenderFlex`、`RenderStack`），`paint()` 方法通常是这样的：

```dart
// RenderStack 的简化 paint 逻辑
@override
void paint(PaintingContext context, Offset offset) {
  defaultPaint(context, offset);
}

// defaultPaint 的实现（来自 box.dart 中的 ContainerBoxParentDataMixin）
void defaultPaint(PaintingContext context, Offset offset) {
  ChildType? child = firstChild;
  while (child != null) {
    final ParentDataType childParentData = child.parentData! as ParentDataType;
    // 子节点在自己的坐标系里绘制，父级把两级 offset 叠加后传入
    context.paintChild(child, childParentData.offset + offset);
    child = childParentData.nextSibling;
  }
}
```

`paintChild` 直接调用子节点的 `paint()` 方法，子节点在自己的 `paint()` 中通过 `PaintingContext` 创建新的 Layer。这就是 Layer Tree 递归构建的过程。

---

## 四、RepaintBoundary 与合成层

### 4.1 `RepaintBoundary` 的本质

`RepaintBoundary` Widget 对应的 `RenderObject` 是 `RenderRepaintBoundary`，它继承自 `RenderProxyBox`：

```dart
class RepaintBoundary extends SingleChildRenderObjectWidget {
  const RepaintBoundary({ super.key, super.child });

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderRepaintBoundary();
  }
}

class RenderRepaintBoundary extends RenderProxyBox {
  @override
  bool get isRepaintBoundary => true;

  // ... 省略部分实现
}
```

**核心只有一行**：`isRepaintBoundary => true`。

`isRepaintBoundary` 是 `RenderObject` 的一个属性，默认为 `false`。当它为 `true` 时，这个节点就成为了合成层边界。

### 4.2 `isRepaintBoundary` 的作用机制

要理解 `isRepaintBoundary`，需要回到 `markNeedsPaint()` 的传播逻辑：

```dart
// RenderObject 中的 markNeedsPaint 逻辑（简化）
void markNeedsPaint() {
  if (_needsPaint) return;

  _needsPaint = true;

  if (isRepaintBoundary && _wasRepaintBoundary) {
    // 如果自己就是重绘边界，不需要继续向上传播
    // 只标记自己需要重绘（它的 layer 必须是 OffsetLayer）
    assert(_layerHandle.layer is OffsetLayer);
    if (owner != null) {
      owner!._nodesNeedingPaint.add(this);
      owner!.requestVisualUpdate();
    }
  } else if (parent != null) {
    // 否则向上传播，直到遇到一个 isRepaintBoundary 的祖先
    parent!.markNeedsPaint();
  } else {
    // 树根且不是重绘边界：直接请求更新（RenderView 本身是重绘边界，不走这里）
    owner?.requestVisualUpdate();
  }
}
```

这段逻辑的含义：

- **没有 `RepaintBoundary` 时**：`markNeedsPaint()` 一直向上传播，直到 `RenderView`（根节点，它本身 `isRepaintBoundary = true`）。整棵树的 paint 都会被触发
- **有 `RepaintBoundary` 时**：`markNeedsPaint()` 在 `RepaintBoundary` 节点就停止传播。只有 `RepaintBoundary` 以内的子树需要重新 paint

**流程对比**：

```text
// 没有 RepaintBoundary
RenderView
└── Column
    ├── Text("静态标题")         ← 也被重绘
    ├── AnimatedIcon(...)       ← 变化源
    └── Text("静态描述")         ← 也被重绘

// 有 RepaintBoundary 包裹动画
RenderView
└── Column
    ├── Text("静态标题")         ← 不受影响
    ├── RepaintBoundary         ← 脏标记在此停止
    │   └── AnimatedIcon(...)   ← 只有这里被重绘
    └── Text("静态描述")         ← 不受影响
```

### 4.3 `RepaintBoundary` 如何创建合成层

`RepaintBoundary` 不只是阻止脏标记传播，它还会创建一个独立的 `OffsetLayer` 作为合成边界。

当 `RenderRepaintBoundary` 被 paint 时（由 `PaintingContext.repaintCompositedChild` 驱动），它会复用或创建一个 `OffsetLayer`（3.x 中通过 `updateCompositedLayer(oldLayer: ...)` 返回），子树的所有 Layer 都挂在这个 `OffsetLayer` 下面。只要这棵子树的内容没变，合成阶段它就通过 `addRetained` 整体复用上一帧的 `engineLayer`——Dart 侧不再重新提交它的指令，Raster 线程也不再重新光栅化它。

```text
Layer Tree（无 RepaintBoundary）

OffsetLayer/TransformLayer (root)
├── PictureLayer (标题)
├── PictureLayer (动画图标，每帧都在变)
└── PictureLayer (描述)

→ 每一帧，整个 Layer Tree 都需要重新 raster


Layer Tree（有 RepaintBoundary）

OffsetLayer/TransformLayer (root)
├── PictureLayer (标题)          ← 不变，addRetained 复用
├── OffsetLayer (合成边界)        ← 子树未变时整体 retained
│   └── PictureLayer (动画图标)  ← 只有这里重新 paint + raster
└── PictureLayer (描述)          ← 不变，addRetained 复用
```

### 4.4 隔离后的 paint → raster → 合成

被 `RepaintBoundary` 隔离的子树，其工作流程是独立的：

1. **paint**：只有 `RepaintBoundary` 以内的子树重新执行 `paint()`，生成新的 Layer 子树
2. **raster**：只有新的 Layer 子树需要被光栅化
3. **合成**：Raster 线程把新 raster 的结果和复用的旧 engineLayer 子树一起合成到屏幕上

未变化的部分在这一帧中通过 retained rendering 完全跳过了 paint 和 raster（补充说明：在旧的 Skia 后端中，稳定且复杂的 Picture 还会被 RasterCache 缓存成纹理；Impeller 移除了 RasterCache，未变化子树的复用主要靠这里说的 retained rendering）。

### 4.5 适用场景

`RepaintBoundary` 不是万能的性能优化手段，它只在特定场景下有显著收益：

**推荐使用的场景**：

- **视频播放器**：视频帧每秒更新 24-60 次，但视频周围的 UI 通常不变
- **复杂动画**：一个持续变化的动画组件，但其他区域是静态的
- **Canvas 自定义绘制**：频繁更新的 `CustomPainter`，如进度条、图表
- **频繁更新的独立区域**：如计时器显示、实时数据监控面板
- **Flutter 页面截图**：`toImage()` 方法需要 `RepaintBoundary` 才能截取特定区域

**不推荐使用的场景**：

- 整个页面都在频繁变化（没有隔离的收益）
- 极其简单的组件（创建 Layer 的开销可能比直接重绘更大）
- 已经在其他 `RepaintBoundary` 内部的子组件（多余的边界层没有额外收益）

### 4.6 性能收益与成本

**收益**：

- 跳过不需要重绘的子树的 `paint()` 执行
- 跳过不需要重新光栅化的 Layer 的 raster 工作
- 减少 GPU 渲染指令的数量

**成本**：

- 每个 `RepaintBoundary` 都会创建一个额外的 `OffsetLayer`，增加 Layer 树的节点数和遍历/合成开销
- 边界内的内容会被独立成一层参与合成；在 Skia 后端，RasterCache 可能把复杂层缓存为 GPU 纹理（占用显存），Impeller 下则主要是合成时的额外处理开销
- `RepaintBoundary` 边界本身有少量 CPU 开销（脏标记聚合、`updateSubtreeNeedsAddToScene` 树遍历）

**经验法则**：

> 只有当被隔离区域的变化频率明显高于整体时，`RepaintBoundary` 才有正向收益。对于偶尔变化一次的内容，加 `RepaintBoundary` 的开销可能比收益还大。

### 4.7 用 DevTools 观察合成层

Flutter DevTools 的 Performance 面板可以可视化 Layer Tree：

1. 打开 DevTools → Performance 面板
2. 录制一段包含动画的操作
3. 在帧详情中选择 "Layer Tree" 视图
4. 每个 `RepaintBoundary` 会显示为一个独立的合成层块
5. 可以看到哪些层被缓存复用，哪些被重新 raster

### 4.8 用 `debugRepaintRainbowEnabled` 验证隔离效果

Flutter 提供了一个调试工具，可以可视化重绘区域：

```dart
void main() {
  debugRepaintRainbowEnabled = true;  // 启用重绘彩虹
  runApp(MyApp());
}
```

启用后，每次 `stopRecordingIfNeeded()` 收尾一段录制时，框架会在刚重绘的区域外画一个彩虹色描边边框，边框颜色沿色相环逐帧旋转（每帧色相 +2 度）。如果 `RepaintBoundary` 工作正常，你应该看到：

- 只有 `RepaintBoundary` 内部的区域在持续变换边框颜色（说明只有它在重绘）
- `RepaintBoundary` 外部的区域边框颜色保持不变（说明没有被重绘）

### 4.9 代码示例：自定义 `RepaintBoundary` 使用

```dart
// 一个频繁更新的自定义绘制组件
class AnimatedChart extends LeafRenderObjectWidget {
  @override
  RenderObject createRenderObject(BuildContext context) {
    return _AnimatedChartRender();
  }
}

class _AnimatedChartRender extends RenderBox {
  AnimationController? _controller;

  void attach(PipelineOwner owner) {
    super.attach(owner);
    // 通过 ticker 驱动动画
    _controller = AnimationController(vsync: ...)
      ..addListener(markNeedsPaint)
      ..repeat();
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    final canvas = context.canvas;
    // 画一个随时间变化的柱状图
    for (int i = 0; i < 10; i++) {
      final height = (math.sin(_controller!.value * 2 * math.pi + i) + 1) * 50;
      canvas.drawRect(
        Rect.fromLTWH(offset.dx + i * 30, offset.dy + 100 - height, 25, height),
        Paint()..color = Colors.blue,
      );
    }
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    return Size(300, 100);
  }
}

// 使用时包裹 RepaintBoundary
class MyPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          Text('这里是静态标题，不应该被重绘'),
          RepaintBoundary(         // ← 合成边界
            child: AnimatedChart(), // ← 频繁更新，被隔离
          ),
          Text('这里是静态描述，不应该被重绘'),
        ],
      ),
    );
  }
}
```

### 4.10 不当使用 `RepaintBoundary` 的反模式

**反模式 1：给每个 Widget 都包 `RepaintBoundary`**

```dart
// 错误：过度使用
Column(
  children: [
    RepaintBoundary(child: Text('A')),
    RepaintBoundary(child: Text('B')),
    RepaintBoundary(child: Text('C')),
    RepaintBoundary(child: Text('D')),
    RepaintBoundary(child: Text('E')),
  ],
)
```

这种用法会产生大量不必要的 Layer，每个 Layer 都占用显存，反而增加 GPU 合成的开销。

**反模式 2：在动画内部嵌套 `RepaintBoundary`**

```dart
// 通常无意义：动画组件内部嵌套 RepaintBoundary
RepaintBoundary(
  child: AnimatedContainer(
    duration: Duration(seconds: 1),
    child: RepaintBoundary(  // ← 这个是多余的
      child: Text('Hello'),
    ),
  ),
)
```

外层的 `RepaintBoundary` 已经隔离了动画变化，内层的没有额外收益。

**反模式 3：给一个完全静态的组件包 `RepaintBoundary`**

```dart
// 无意义：静态内容不需要隔离
RepaintBoundary(
  child: Text('我永远不变'),
)
```

没有任何变化的内容，不需要合成隔离。

---

## 五、SaveLayer 的性能代价

### 5.1 什么是 SaveLayer

`SaveLayer` 是 Skia 提供的一个 API（对应 Dart 中的 `Canvas.saveLayer`），它的工作原理是：

1. 在 GPU 上创建一个**离屏缓冲区**（offscreen buffer / framebuffer object）
2. 在这个离屏缓冲区上执行后续的绘制指令
3. 当 `restore` 时，把离屏缓冲区的内容绘制回主画面上

```text
主画面
    │
    ├── saveLayer  ← 创建离屏缓冲区
    │       │
    │       ├── drawRect(...)
    │       ├── drawCircle(...)
    │       └── drawImage(...)
    │
    └── restore   ← 把离屏缓冲区的内容合并回主画面
```

为什么要这样做？因为某些视觉效果需要在"所有内容都画完后"才能一次性应用。例如：

- **半透明**：先把所有子内容画好，再整体乘以透明度。不能每个子内容单独乘透明度，否则重叠部分的透明度会累加
- **颜色滤镜**：先把所有子内容画好，再整体应用色相/饱和度变换
- **图像滤镜（如模糊）**：先画好所有内容，再做整体模糊

### 5.2 哪些操作会触发 SaveLayer

在 Flutter 中，以下操作会在 Engine 层面触发 SaveLayer：

| Flutter Widget / API | 底层 Layer | 触发 SaveLayer |
|---------------------|-----------|---------------|
| `Opacity(opacity < 1.0)` | `OpacityLayer` | 是 |
| `ColorFiltered` | `ColorFilterLayer` | 是 |
| `ImageFiltered` | `ImageFilterLayer` | 是 |
| `BackdropFilter` | `BackdropFilterLayer` | 是 |
| `ShaderMask` | `ShaderMaskLayer` | 是 |
| `Clip.antiAliasWithSaveLayer` | `ClipRectLayer` 等 | 是 |
| `Canvas.saveLayer` | - | 是 |

**注意**：不是所有裁剪都触发 SaveLayer。只有 `clipBehavior` 设置为 `Clip.antiAliasWithSaveLayer` 时才会。Flutter 默认使用 `Clip.hardEdge` 或 `Clip.antiAlias`，不会触发。

### 5.3 SaveLayer 的性能代价

SaveLayer 的性能代价来自三个方面：

**1. 额外的 GPU 内存分配**

每个 SaveLayer 都需要分配一个离屏缓冲区。缓冲区的大小取决于裁剪区域或绘制区域的尺寸。如果这个区域很大（比如接近全屏），那么分配的缓冲区也非常大。

```
一张 1080x2400 RGBA8888 纹理 ≈ 1080 × 2400 × 4 bytes ≈ 10MB
```

一次 SaveLayer 就可能消耗 10MB 的 GPU 内存。如果嵌套了多个 SaveLayer，或者 SaveLayer 区域很大，内存开销会迅速累积。

**2. 额外的渲染 Pass**

SaveLayer 至少增加一次渲染 pass：

- 先在离屏缓冲区上渲染所有子内容（pass 1）
- 再把离屏缓冲区合并回主画面（pass 2）

如果嵌套了多层 SaveLayer，pass 数量会成倍增加。

**3. 纹理合成开销**

最终的合并操作（从离屏缓冲区拷贝到主画面）本身也是一个 GPU 操作，涉及纹理采样和混合。

### 5.4 常见的 SaveLayer 触发场景

**场景 1：半透明 Container**

```dart
Opacity(
  opacity: 0.5,
  child: Container(
    child: Column(
      children: [
        Image.asset('large_image.png'),   // 大量绘制指令
        ListView.builder(itemCount: 100), // 更多的绘制指令
      ],
    ),
  ),
)
```

这里整个子树（大图 + 100 个列表项）都被包在一个 SaveLayer 里，代价极高。

**替代方案**：如果 Container 有纯色背景，直接修改背景色的透明度：

```dart
Container(
  color: Colors.white.withOpacity(0.5),  // 修改背景色，不触发 SaveLayer
  child: Column(...),
)
```

**场景 2：BackdropFilter（毛玻璃效果）**

```dart
BackdropFilter(
  filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
  child: Container(
    color: Colors.white.withOpacity(0.3),
    child: content,
  ),
)
```

BackdropFilter 本身就需要读取背景内容并做模糊处理，再加一个半透明的 Overlay，至少两层 SaveLayer。

**场景 3：ShaderMask**

```dart
ShaderMask(
  shaderCallback: (bounds) => LinearGradient(...).createShader(bounds),
  blendMode: BlendMode.dstIn,
  child: content,
)
```

着色器遮罩需要先画完所有内容，再应用 Shader，必然触发 SaveLayer。

### 5.5 替代方案与优化策略

**策略 1：用 `RepaintBoundary` 隔离 SaveLayer 影响范围**

```dart
// 不好：SaveLayer 覆盖整个页面
Scaffold(
  body: Opacity(
    opacity: 0.5,
    child: Column(
      children: [
        Header(),       // 静态内容
        ListView(...),  // 复杂列表
        Footer(),       // 静态内容
      ],
    ),
  ),
)

// 更好：缩小 SaveLayer 的范围
Scaffold(
  body: Column(
    children: [
      Header(),
      Opacity(
        opacity: 0.5,
        child: RepaintBoundary(
          child: ListView(...),  // SaveLayer 只覆盖列表部分
        ),
      ),
      Footer(),
    ],
  ),
)
```

**策略 2：避免使用 `Opacity`，用替代方式实现半透明**

```dart
// 方式 1：修改颜色透明度（适用于纯色背景）
Container(
  color: Colors.blue.withOpacity(0.5),
  child: content,
)

// 方式 2：使用 Icon 的 color 属性
Icon(Icons.star, color: Colors.red.withOpacity(0.7))

// 方式 3：使用 Image 的 colorBlendMode
Image.asset('image.png', color: Colors.white.withOpacity(0.5), colorBlendMode: BlendMode.modulate)
```

**策略 3：避免 `Clip.antiAliasWithSaveLayer`**

默认的 `Clip.antiAlias` 在大多数场景下效果足够好，不需要使用 `antiAliasWithSaveLayer`：

```dart
// 不好
ClipRect(clipper: ..., clipBehavior: Clip.antiAliasWithSaveLayer, child: ...)

// 更好（默认值）
ClipRect(clipper: ..., child: ...)
```

**策略 4：用 `canvas.saveLayer` 最小化 SaveLayer 区域**

如果必须使用 `saveLayer`，尽量让它只覆盖必要的最小区域：

```dart
@override
void paint(PaintingContext context, Offset offset) {
  final canvas = context.canvas;

  // 只对一小块区域使用 saveLayer
  canvas.saveLayer(
    Rect.fromLTWH(offset.dx, offset.dy, 100, 100),  // 最小区域
    Paint(),
  );
  // ... 在这个小区域内绘制 ...
  canvas.restore();
}
```

### 5.6 Impeller 对 SaveLayer 的优化

Impeller 是 Flutter 的新一代渲染引擎（自 Flutter 3.27 起在 iOS 和 Android API 29+ 上默认启用，iOS 上已是唯一后端；Web 仍使用 Skia）。它对 SaveLayer 有一套自己的优化策略。

**Skia 的问题**：

Skia 的 SaveLayer 会在 GPU 上创建一个新的纹理（framebuffer object），开销较大。如果一帧中有多个 SaveLayer，就会创建多个临时纹理；且 Skia 在运行时编译 shader，可能带来额外的卡顿。

**Impeller 的优化策略**（依据 [Impeller 官方文档](https://docs.flutter.dev/perf/impeller)与引擎源码 `impeller/entity/save_layer_utils.cc`）：

- **按最小覆盖区域分配离屏纹理**：Impeller 会先计算 SaveLayer 内容的实际覆盖范围（`ComputeSaveLayerCoverage`，考虑内容 bounds、裁剪和滤镜），只分配刚好够用的最小纹理，而不是想当然地开一块全屏纹理
- **子通道折叠（subpass collapse / opacity peephole）**：当 SaveLayer 的子内容简单（比如只是不重叠的几个图元，或纯透明度叠加）时，Impeller 可以省掉离屏缓冲，直接画到父层上——有些 `Opacity` 场景在 Impeller 下实际上没有发生离屏渲染
- **预计算 SaveLayer 边界**：DisplayList 在录制阶段就算好每个 SaveLayer 的 bounds，光栅化时不再事后修补
- **Shader 全部构建期预编译**：所有管线状态对象（PSO）在引擎构建时就编译好，运行时只做切换，消除了 Skia 的 shader 编译卡顿（这是 Impeller 的立项初衷）

```text
Skia 的做法：
SaveLayer → 按调用方给的（常常过大的）bounds 分配纹理 → 离屏渲染 → 合并回主画面
每个 SaveLayer 一次独立的纹理分配和渲染 pass

Impeller 的做法：
先计算实际 coverage → 分配最小纹理 → 简单场景直接折叠掉离屏 pass
能省的 SaveLayer 直接省，省不掉的也尽量开小
```

另外要注意：**Impeller 移除了 Skia 时代的 RasterCache**（Skia 会把"复杂且稳定"的 Picture 缓存为纹理，但其启发式命中率不佳、显存占用可观，Flutter 团队决定不把它带到 Impeller）。Impeller 的思路是让"直接重放绘制指令"足够便宜，未变化子树的复用交给 Layer 树的 retained rendering 完成。

> 实际测试中，Impeller 对包含多个 `Opacity` 和 `BackdropFilter` 的复杂 UI，帧率通常比 Skia 更稳定。但这不代表你可以随意使用这些 Widget——Impeller 减少了代价，但没有消除代价：离屏 pass 的带宽消耗、`BackdropFilter` 读回帧缓冲的开销依然存在。

---

## 六、SceneBuilder 与 Scene

### 6.1 `SceneBuilder` 的角色

`SceneBuilder` 是 Dart 层和 Engine 层之间的"序列化器"。它负责把 Dart 层的 Layer Tree 转换成 Engine 可以消费的 `Scene` 对象。

```dart
// dart:ui 中的 SceneBuilder（节选，均含 oldLayer 复用参数）
class SceneBuilder extends NativeFieldWrapperClass1 {
  SceneBuilder();

  // ---- 容器型效果：push* / pop 成对出现 ----

  // 压入一个平移（对应 OffsetLayer；等价于仅平移的 pushTransform）
  OffsetEngineLayer pushOffset(double dx, double dy, { OffsetEngineLayer? oldLayer });

  // 压入一个变换（对应 TransformLayer）
  TransformEngineLayer pushTransform(Float64List matrix4, { TransformEngineLayer? oldLayer });

  // 压入一个裁剪矩形（对应 ClipRectLayer）
  ClipRectEngineLayer pushClipRect(Rect rect, { Clip clipBehavior = Clip.antiAlias, ClipRectEngineLayer? oldLayer });

  // 压入一个裁剪圆角矩形
  ClipRRectEngineLayer pushClipRRect(RRect rrect, { Clip clipBehavior = Clip.antiAlias, ClipRRectEngineLayer? oldLayer });

  // 压入一个裁剪路径
  ClipPathEngineLayer pushClipPath(Path path, { Clip clipBehavior = Clip.antiAlias, ClipPathEngineLayer? oldLayer });

  // 压入一个透明度层（对应 OpacityLayer）
  OpacityEngineLayer pushOpacity(int alpha, { Offset? offset = Offset.zero, OpacityEngineLayer? oldLayer });

  // 压入一个颜色滤镜
  ColorFilterEngineLayer pushColorFilter(ColorFilter filter, { ColorFilterEngineLayer? oldLayer });

  // 压入一个图像滤镜
  ImageFilterEngineLayer pushImageFilter(ImageFilter filter, { Offset offset = Offset.zero, ImageFilterEngineLayer? oldLayer });

  // 压入一个背景滤镜（blendMode/backdropId 用于分组复用背景采样）
  BackdropFilterEngineLayer pushBackdropFilter(ImageFilter filter, {
    BlendMode blendMode = BlendMode.srcOver,
    BackdropFilterEngineLayer? oldLayer,
    int? backdropId,
  });

  // 压入一个着色器遮罩（注意参数顺序：shader、maskRect、blendMode）
  ShaderMaskEngineLayer pushShaderMask(Shader shader, Rect maskRect, BlendMode blendMode, {
    ShaderMaskEngineLayer? oldLayer,
    FilterQuality filterQuality = FilterQuality.low,
  });

  // 弹出当前层
  void pop();

  // ---- 叶子内容：add*，无需 pop ----

  // 添加一张 Picture（对应 PictureLayer）
  void addPicture(Offset offset, Picture picture, { bool isComplexHint = false, bool willChangeHint = false });

  // 添加一个外部纹理（对应 TextureLayer）
  void addTexture(int textureId, { Offset offset = Offset.zero, double width = 0.0, double height = 0.0, bool freeze = false, FilterQuality filterQuality = FilterQuality.low });

  // 添加一个平台视图（iOS UIView，对应 PlatformViewLayer）
  void addPlatformView(int viewId, { Offset offset = Offset.zero, double width = 0.0, double height = 0.0 });

  // 添加一个性能叠加层
  void addPerformanceOverlay(int enabledOptions, Rect bounds);

  // 复用上一帧已光栅化的引擎层子树（retained rendering）
  void addRetained(EngineLayer retainedLayer);

  // 构建最终的 Scene 对象
  Scene build();
}
```

> 注意：现行版本的 `SceneBuilder` 已没有 `setTransform` 方法——根变换不再通过 builder 设置，而是由 `RenderView` 的根 `TransformLayer`（携带设备像素比矩阵）在 `addToScene` 时以 `pushTransform` 的方式生效。

### 6.2 `addToScene` 与 `SceneBuilder` 方法的对应关系

每个 Dart 层的 `Layer` 子类在 `addToScene` 中调用 `SceneBuilder` 的对应方法：

| Dart Layer | `addToScene` 调用 | SceneBuilder 方法 |
|-----------|-------------------|------------------|
| `PictureLayer` | `builder.addPicture(Offset.zero, picture)` | `addPicture` |
| `OffsetLayer` | `builder.pushOffset(dx, dy)` | `pushOffset` |
| `TransformLayer` | `builder.pushTransform(matrix.storage)` | `pushTransform` |
| `ClipRectLayer` | `builder.pushClipRect(rect)` | `pushClipRect` |
| `ClipRRectLayer` | `builder.pushClipRRect(rrect)` | `pushClipRRect` |
| `ClipPathLayer` | `builder.pushClipPath(path)` | `pushClipPath` |
| `OpacityLayer` | `builder.pushOpacity(alpha)` | `pushOpacity` |
| `ColorFilterLayer` | `builder.pushColorFilter(filter)` | `pushColorFilter` |
| `ImageFilterLayer` | `builder.pushImageFilter(filter)` | `pushImageFilter` |
| `BackdropFilterLayer` | `builder.pushBackdropFilter(filter)` | `pushBackdropFilter` |
| `ShaderMaskLayer` | `builder.pushShaderMask(shader, maskRect, blendMode)` | `pushShaderMask` |
| `TextureLayer` | `builder.addTexture(textureId, ...)` | `addTexture` |
| `PlatformViewLayer` | `builder.addPlatformView(viewId, ...)` | `addPlatformView` |
| （内容未变的任意子树） | `builder.addRetained(engineLayer)` | `addRetained` |

再次强调表格末尾透露的规律：**容器型效果用 `push*`/`pop`，叶子内容用 `add*`，复用旧帧用 `addRetained`**。

**`push*` 和 `pop` 的配对**：

每个 `ContainerLayer` 的 `addToScene` 都遵循"push → addChildren → pop"的模式：

```dart
// 以 ClipRectLayer 为例
@override
void addToScene(SceneBuilder builder) {
  engineLayer = builder.pushClipRect(clipRect, ...);
  addChildrenToScene(builder);   // 递归调用子 Layer 的 addToScene
  builder.pop();                  // 弹出当前层
}
```

`SceneBuilder` 内部维护了一个栈结构，`push*` 压栈，`pop` 弹栈。栈中的每一层对应一个渲染效果。

### 6.3 从 `flushPaint` 到 `RenderView.compositeFrame()` 的完整链路

在讲 `compositeFrame` 之前，先补上它前面的一环——Layer Tree 是怎么在 paint 阶段被更新的：

```dart
// PipelineOwner.flushPaint()（简化）
void flushPaint() {
  final List<RenderObject> dirtyNodes = _nodesNeedingPaint;
  _nodesNeedingPaint = <RenderObject>[];

  // 按深度从深到浅排序，保证子节点先于父节点重绘
  for (final node in dirtyNodes..sort((a, b) => b.depth - a.depth)) {
    if (node._needsPaint && node.owner == this) {
      // 每个 RepaintBoundary 节点从这里开始重绘自己的子树
      PaintingContext.repaintCompositedChild(node);
    }
  }
}

// PaintingContext.repaintCompositedChild 的核心逻辑（简化）
static void _repaintCompositedChild(RenderObject child, ...) {
  var childLayer = child._layerHandle.layer as OffsetLayer?;
  if (childLayer == null) {
    // 第一次：为这个 RepaintBoundary 创建 OffsetLayer
    childLayer = child.updateCompositedLayer(oldLayer: null);
  } else {
    // 后续帧：复用同一个 OffsetLayer，只清空子层
    childLayer.removeAllChildren();
    child.updateCompositedLayer(oldLayer: childLayer);
  }
  // 用这个 OffsetLayer 作为容器，重新 paint 整棵子树
  final childContext = PaintingContext(childLayer, child.paintBounds);
  child._paintWithContext(childContext, Offset.zero);
  childContext.stopRecordingIfNeeded();
}
```

注意"从脏节点往下、而不是从根往下"这个特点：`flushPaint` 只处理被标记的 `RepaintBoundary` 节点，每个节点以自己的 `OffsetLayer` 为根重新 paint 子树，子树内未变化的 Layer（比如下一级的 `RepaintBoundary`）会被原样保留——这就是脏标记传播被截断之后，重绘范围得以收敛的执行机制。

paint 阶段结束后，`RenderView.compositeFrame()` 负责把整棵 Layer Tree 序列化成 `Scene`（以下为 Flutter 3.4x 的实现，简化后）：

```dart
void compositeFrame() {
  FlutterTimeline.startSync('COMPOSITING');
  try {
    // 1. 创建 SceneBuilder（经 RendererBinding.createSceneBuilder，便于定制/测试）
    final ui.SceneBuilder builder = RendererBinding.instance.createSceneBuilder();

    // 2. 以根 Layer 为起点构建 Scene：
    //    内部先 updateSubtreeNeedsAddToScene()（汇聚子树脏标记），
    //    再 addToScene(builder)（递归序列化，未变子树走 addRetained），
    //    最后 builder.build() 生成 Scene
    final ui.Scene scene = layer!.buildScene(builder);

    // 3. 交给当前 FlutterView 渲染（Engine → Raster 线程）
    _view.render(scene, size: configuration.toPhysicalSize(size));

    // 4. 释放 Scene 资源
    scene.dispose();
  } finally {
    FlutterTimeline.finishSync();
  }
}
```

和旧版本（3.10 之前）的两个显著区别：一是根变换（设备像素比）已经放在根 `TransformLayer` 里，不再调用 `builder.setTransform`；二是渲染入口从已废弃的 `ui.window.render(scene)` 换成了 `FlutterView.render(scene, size: ...)`，多 View 场景下每个 `RenderView` 对应自己的 view。

完整链路：

```text
drawFrame()
    │
    ├── flushPaint()                       // paint 阶段
    │       └── PaintingContext.repaintCompositedChild(node)
    │               └── child._paintWithContext(...)   // 更新 Layer 子树
    │
    └── RenderView.compositeFrame()         // compositing 阶段
            │
            ├── SceneBuilder()
            ├── layer.buildScene(builder)
            │       │
            │       ├── updateSubtreeNeedsAddToScene()
            │       ├── addToScene(builder)
            │       │       ├── builder.pushTransform(...)      // 根 TransformLayer（DPR）
            │       │       │       ├── builder.pushClipRect(...)
            │       │       │       │       ├── builder.addPicture(...)   // PictureLayer
            │       │       │       │       └── builder.pop()
            │       │       │       ├── builder.pushOpacity(...)
            │       │       │       │       ├── builder.addPicture(...)
            │       │       │       │       └── builder.pop()
            │       │       │       ├── builder.addRetained(...)  // 未变子树直接复用
            │       │       │       └── builder.pop()
            │       │       └── ...（其余 Layer 递归）
            │       └── builder.build() → Scene
            │
            ├── view.render(scene)          // 交给 Raster 线程
            └── scene.dispose()
```

### 6.4 C++ 层面 Scene 的工作方式

`Scene` 被 Engine 接收后，在 C++ 层面经历以下转换：

```text
Dart: Scene
    ↓ 通过 FFI 传递句柄
C++: flutter::Scene
    ↓ 转换为
C++: flutter::LayerTree
    ↓ 交给 Raster 线程
C++: flutter::Rasterizer::DrawToSurface()
    ↓ 遍历 LayerTree
C++: 每个 flutter::Layer → Skia / Impeller API 调用
    ↓
GPU: 执行渲染命令 → 帧缓冲
```

**`flutter::LayerTree`** 是 Engine 层面对 Layer 树的表示。它和 Dart 层的 Layer Tree 不是同一份数据，而是通过 `SceneBuilder` 序列化后在 Engine 侧重建的。

`flutter::LayerTree` 中的每个节点也有对应的类型：

- `flutter::TransformLayer`
- `flutter::ClipRectLayer`
- `flutter::OpacityLayer`
- `flutter::PictureLayer`
- `flutter::TextureLayer`
- ...

这些 C++ 对象持有 Skia/Impeller 可以直接消费的数据（如 `SkPicture`、变换矩阵、纹理 ID 等）。

### 6.5 Platform View 的合成

Platform View（原生控件）的合成是一个特殊的场景。原生控件（如 Android 的 `View`、iOS 的 `UIView`）无法直接渲染到 Flutter 的 `Picture` 中，因为它们由各自的平台渲染管线管理。

Flutter 的解决方案按平台有所不同：Android 上（Virtual Display / TLHC 等模式）把原生控件的内容写入共享纹理，Dart 侧使用 `TextureLayer`；iOS 上则直接用 `PlatformViewLayer`（对应 `SceneBuilder.addPlatformView`）把 `UIView` 作为一个独立的合成参与者交给合成器：

```text
┌─────────────────────────────────────────────┐
│ Flutter Layer Tree                           │
│                                              │
│ OffsetLayer                                  │
│ ├── PictureLayer (Flutter UI)                │
│ ├── TextureLayer(textureId: 42)  ← Platform  │
│ │   └── [原生控件渲染到纹理 42]    View       │
│ └── PictureLayer (更多 Flutter UI)           │
│                                              │
└─────────────────────────────────────────────┘
          ↓
    Raster 线程合成时：
    Flutter Layer → Skia/Impeller 渲染
    TextureLayer → 从纹理 42 采样 → 合成到画面中
```

**实现细节**：

1. 原生控件在自己的渲染管线中渲染（Android 的 `Surface` / iOS 的 `CALayer`）
2. 原生控件把渲染结果写入一个共享纹理（通过 `SurfaceTexture` / `IOSurface` 等平台 API）
3. Flutter Engine 获得这个纹理的 ID
4. Dart 层创建 `TextureLayer(textureId: id)`
5. Raster 线程在合成时，把这个外部纹理当作普通图片纹理处理

在 Impeller 下，这个过程更加高效：Impeller 可以直接引用外部纹理，无需额外的拷贝或格式转换。

---

## 七、Raster 线程与合成

### 7.1 Raster 线程如何消费 Scene

Raster 线程（也叫 GPU 线程）是 Flutter 的核心渲染线程之一。它的工作是接收 UI 线程构建好的 `Scene`（在 Engine 中表示为 `LayerTree`），然后遍历这棵树，对每个 Layer 调用 Skia 或 Impeller 的渲染 API。

```text
Raster 线程的工作流程：

1. 从 UI 线程接收 LayerTree
2. 开始一帧渲染
3. 遍历 LayerTree 的每个节点
    ├── PictureLayer → 回放 Picture（Skia 下为 SkPicture，Impeller 下为 DisplayList）
    ├── TransformLayer → 设置变换矩阵
    ├── ClipRectLayer → 设置裁剪区域
    ├── OpacityLayer → 设置透明度
    ├── TextureLayer → 绑定外部纹理
    └── ...
4. 所有命令提交到 GPU
5. GPU 执行渲染，输出到帧缓冲
6. 等待 VSync，交换缓冲区
```

### 7.2 `Picture` 的回放（SkPicture / DisplayList）

`Picture` 是一个"录制好的绘制脚本"。在 `paint()` 阶段，Dart 层通过 `Canvas` 的各种 `draw*` 方法把指令记录进去；Raster 线程在处理 `PictureLayer` 时，会"回放"这份脚本——Skia 后端回放的是 `SkPicture`，Impeller 后端回放的是 DisplayList（Dart 侧的 `ui.Picture` 在现行引擎中底层统一是 DisplayList 格式）：

```text
Picture 中记录的指令（示例）：

0: save
1: clipRect(0, 0, 300, 600)
2: drawRect(10, 10, 50, 50, paint_blue)
3: drawText("Hello", 20, 80, paint_black)
4: drawImage(image_1, 0, 100)
5: drawCircle(150, 300, 20, paint_red)
6: restore

Raster 线程回放时：
→ 按顺序逐条执行，直接操作 GPU
→ drawRect → GPU 画矩形
→ drawText → GPU 画文字（字形从字形图集纹理采样）
→ drawImage → GPU 画纹理
→ drawCircle → GPU 画圆形
```

**回放的优化**：

- 未变化的 Layer 子树在 UI 线程合成时走 `addRetained`，Scene 里根本不含它的回放指令，Raster 线程天然跳过——复用发生在"提交之前"，而不是回放时再做判断
- Picture 内部维护了空间索引（Skia 的 BBH / DisplayList 的 RTree），配合裁剪矩形可以只回放与可见区域相交的指令，屏幕外的绘制直接被剔除
- `isComplexHint` / `willChangeHint`（`CustomPainter.isComplex` / `willChange` 传下来的提示）影响引擎的缓存决策（仅 Skia 后端的 RasterCache 在用）

### 7.3 Impeller 的渲染管线

Impeller 使用现代化的渲染管线设计，和 Skia 的即时模式渲染有本质区别。

**Impeller 的核心概念**：

- **Pipeline State Object (PSO)**：Impeller 为每种渲染操作预编译一个 GPU 管线状态。运行时只需要切换 PSO，不需要重新编译 shader
- **Command Buffer**：渲染指令被记录到命令缓冲区中，最后一次性提交给 GPU
- **显式缓存**：纹理、渲染目标等资源的缓存由引擎显式控制（不再有 Skia 那种不透明的启发式 RasterCache）

**Impeller 的渲染流程**：

```text
1. 接收 LayerTree
2. 创建 CommandBuffer
3. 遍历 LayerTree：
    ├── PictureLayer（DisplayList 回放）
    │   ├── 查找/创建对应的 PSO（如 FillRectPSO、DrawImagePSO）
    │   ├── 从纹理缓存获取/上传纹理
    │   ├── 设置 Uniform（变换矩阵、颜色等）
    │   └── 向 CommandBuffer 追加 Draw 命令
    ├── TransformLayer
    │   └── 更新当前变换矩阵（通过 Uniform）
    └── ...
4. 提交 CommandBuffer 到 GPU
5. GPU 执行所有命令
```

**Impeller vs Skia 的关键区别**：

| 方面 | Skia | Impeller |
|------|------|----------|
| Shader 编译 | 运行时 JIT 编译 GLSL → 导致首帧卡顿 | 构建期预编译全部 shader（AOT）→ 无 shader 编译卡顿 |
| 管线切换 | 每次绘制可能重新编译/切换 shader | PSO 预构建，运行时快速切换 |
| SaveLayer | 离屏纹理 + 多次渲染 pass | 按最小 coverage 分配纹理，简单场景折叠掉离屏 pass |
| 图片层缓存 | RasterCache 启发式地把复杂 Picture 缓存为纹理 | 移除 RasterCache，靠便宜的重放 + retained rendering |
| 目标 | 通用 2D 渲染库 | 针对 Flutter 负载定制的渲染运行时 |

### 7.4 线程模型：UI 线程 → Raster 线程 → GPU

Flutter 的渲染模型是双线程的：

```text
┌────────────────────────┐     ┌────────────────────────┐     ┌──────────┐
│    UI Thread (Dart)    │     │  Raster Thread (C++)   │     │   GPU    │
│                        │     │                        │     │          │
│ 1. Build Widget Tree   │     │                        │     │          │
│ 2. Layout              │     │                        │     │          │
│ 3. Paint               │     │                        │     │          │
│ 4. Layer Tree →        │────→│ 5. 消费 LayerTree      │     │          │
│    SceneBuilder →      │     │ 6. 遍历 Layer          │     │          │
│    Scene →             │     │ 7. Picture 回放 /      │────→│ 8. 执行   │
│    window.render()     │     │    Impeller 命令执行   │     │    渲染   │
│                        │     │                        │     │    命令   │
│ 9. 继续处理下一帧       │     │ 9. 等待 VSync          │     │ 9. 输出到 │
│    的 UI 事件           │     │    交换缓冲区          │←────│    屏幕   │
│                        │     │                        │     │          │
└────────────────────────┘     └────────────────────────┘     └──────────┘
```

**关键点**：

- **UI 线程和 Raster 线程并行工作**：当 Raster 线程在 raster 第 N 帧时，UI 线程可能在构建第 N+1 帧的 Layer Tree
- **流水线效应**：如果 UI 线程的 build/layout/paint 耗时较长，Raster 线程可能出现"等活干"的情况（GPU 利用率不高）
- **如果 Raster 线程 raster 耗时较长**：UI 线程生成的 Scene 会排队等待，导致 UI 线程的后续帧也被阻塞

这就是为什么 Flutter Performance Overlay 中有两条线：

- **UI 线程帧时间**（蓝色）：build + layout + paint + compositing
- **Raster 线程帧时间**（绿色）：遍历 LayerTree + Picture 回放 + GPU 执行

如果绿色线频繁超过 16ms（60fps），说明合成/raster 是瓶颈，需要优化 Layer 数量、SaveLayer、纹理大小等。

---

## 八、实战：合成性能排查

### 8.1 用 DevTools Performance 面板观察合成层

**步骤**：

1. 打开 DevTools → Performance
2. 点击录制按钮，操作包含动画或频繁更新的 UI
3. 停止录制，选择一帧查看
4. 在帧图表下方选择 "Layer Tree" 标签
5. 可以看到：

```text
Layer Tree 视图中的信息：
- 每个层的类型（PictureLayer、OpacityLayer、ClipRectLayer 等）
- 每个层的大小和复杂度（complexity 指示器）
- 哪些层被缓存复用（cached 标记）
- 每个层的光栅化耗时
```

**重点关注**：

- `OpacityLayer` 的数量和覆盖范围
- `BackdropFilterLayer` 的数量
- 被标记为 `complex` 的 `PictureLayer`（包含大量绘制指令）
- 没有被缓存但也没有变化的层

### 8.2 调试工具与标记

**`debugPrintMarkNeedsPaintStacks`**

```dart
void main() {
  debugPrintMarkNeedsPaintStacks = true;
  runApp(MyApp());
}
```

启用后，每次 `markNeedsPaint()` 被调用时，会打印调用栈。这有助于发现"谁在不必要地触发重绘"。

**`debugPrintMarkNeedsLayoutStacks`**

```dart
void main() {
  debugPrintMarkNeedsLayoutStacks = true;
  runApp(MyApp());
}
```

同理，用于发现不必要的布局重计算。

**`debugRepaintRainbowEnabled`**

```dart
void main() {
  debugRepaintRainbowEnabled = true;
  runApp(MyApp());
}
```

如 [4.8 节](#48-用-debugrepaintrainbowenabled-验证隔离效果) 所述，可视化重绘区域。

**`debugProfilePaintsEnabled`**

```dart
void main() {
  debugProfilePaintsEnabled = true;
  runApp(MyApp());
}
```

在 Performance 面板中为每个 `paint()` 调用添加时间标记，方便在时间轴上查看哪个 RenderObject 的 paint 最耗时。

### 8.3 常见合成性能问题

**问题 1：过多 SaveLayer**

症状：
- Raster 线程帧时间（绿色线）频繁超过 16ms
- DevTools Layer Tree 中有大量 `OpacityLayer`、`BackdropFilterLayer`、`ColorFilterLayer`

排查方法：
- 在 Performance Overlay 中观察 raster 线程时间
- 在 Layer Tree 中数 SaveLayer 的数量

解决方案：
- 用 5.5 节的替代方案减少 `Opacity` 的使用
- 用 `RepaintBoundary` 缩小 SaveLayer 的覆盖范围
- 避免嵌套的 `BackdropFilter`

**问题 2：缺少 RepaintBoundary**

症状：
- 某个局部区域频繁变化（如动画、计时器），但整个页面都在重绘
- `debugRepaintRainbowEnabled` 显示整页都在变色

排查方法：
- 启用 `debugRepaintRainbowEnabled`
- 在 Performance 面板中观察 paint 时间线

解决方案：
- 在变化区域的外围添加 `RepaintBoundary`
- 特别注意 `AnimationController` 驱动的自定义绘制组件

**问题 3：超大纹理**

症状：
- 即使没有复杂动画，Raster 线程仍然很慢
- 低端设备上尤为明显
- GPU 内存占用过高

排查方法：
- DevTools Memory 面板查看 GPU 内存使用
- 检查是否有全屏 SaveLayer
- 检查图片是否有 `cached_network_image` 并指定了正确的尺寸

解决方案：
- 给网络图片指定 `width` / `height`，避免解码超大图
- 缩小 SaveLayer 的范围
- 使用 `ResizeImage` 限制图片解码尺寸

**问题 4：频繁重建 Layer**

症状：
- UI 线程帧时间（蓝色线）很高
- Layer Tree 每帧都在变化

排查方法：
- 检查 Widget 树是否有不必要的 `rebuild`
- 检查 `CustomPainter.shouldRepaint` 是否正确实现
- 检查动画是否使用了 `const` 构造函数

解决方案：
- 用 `const` Widget 避免不必要的重建
- `CustomPainter.shouldRepaint` 在内容没变时返回 `false`
- 使用 `AnimatedBuilder` 限制动画重建范围

**问题 5：深层嵌套的 Transform / Clip**

症状：
- 复杂的布局容器（Stack、Transform、Clip 叠加）导致 Layer 树很深
- 每次 paint 需要创建大量 Layer 对象

排查方法：
- DevTools Layer Tree 观察深度
- 检查是否有不必要的 Transform/Clip 嵌套

解决方案：
- 合并相邻的相同类型 Layer
- 移除不影响最终视觉效果的额外 Clip

### 8.4 最佳实践总结

**Do**：

- 在频繁变化的独立区域使用 `RepaintBoundary`
- 用 `debugRepaintRainbowEnabled` 验证重绘范围
- `CustomPainter.shouldRepaint` 必须正确实现
- 给图片指定精确尺寸，避免超大纹理
- 使用 `const` 构造函数减少不必要的 Widget 重建
- 用 `RepaintBoundary` 缩小 SaveLayer 的影响范围

**Don't**：

- 不要给每个 Widget 都包 `RepaintBoundary`
- 不要滥用 `Opacity` Widget——优先用颜色透明度替代
- 不要在性能敏感的 UI 中使用 `BackdropFilter`（毛玻璃效果代价极高）
- 不要使用 `Clip.antiAliasWithSaveLayer` 除非确实需要
- 不要在 `build()` 方法中创建昂贵的对象（如 `Paint`、`Path`）
- 不要让 `SaveLayer` 覆盖过大的区域

**一句话原则**：

> 合成优化的核心是"让变化最小化、让复用最大化"。`RepaintBoundary` 是缩小变化范围，`SaveLayer` 的优化是减少变化的代价。两者结合使用，才能达到最佳的性能表现。

---

## 参考链接

- 官方 API：[`Layer`](https://api.flutter.dev/flutter/rendering/Layer-class.html)
- 官方 API：[`ContainerLayer`](https://api.flutter.dev/flutter/rendering/ContainerLayer-class.html)
- 官方 API：[`PictureLayer`](https://api.flutter.dev/flutter/rendering/PictureLayer-class.html)
- 官方 API：[`OffsetLayer`](https://api.flutter.dev/flutter/rendering/OffsetLayer-class.html)
- 官方 API：[`TransformLayer`](https://api.flutter.dev/flutter/rendering/TransformLayer-class.html)
- 官方 API：[`OpacityLayer`](https://api.flutter.dev/flutter/rendering/OpacityLayer-class.html)
- 官方 API：[`RepaintBoundary`](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html)
- 官方 API：[`RenderRepaintBoundary`](https://api.flutter.dev/flutter/rendering/RenderRepaintBoundary-class.html)
- 官方 API：[`PaintingContext`](https://api.flutter.dev/flutter/rendering/PaintingContext-class.html)
- 官方 API：[`SceneBuilder`](https://api.flutter.dev/flutter/dart-ui/SceneBuilder-class.html)
- 官方文档：[Flutter architectural overview（含渲染管线）](https://docs.flutter.dev/resources/architectural-overview)
- 官方文档：[Flutter performance best practices](https://docs.flutter.dev/perf/best-practices)
- 官方文档：[Performance profiling](https://docs.flutter.dev/perf/rendering-performance)
- 官方文档：[Impeller rendering engine](https://docs.flutter.dev/perf/impeller)
- 官方文档：[Impeller FAQ（shader 预编译、与 Skia 的关系）](https://github.com/flutter/flutter/blob/main/docs/engine/impeller/docs/faq.md)
- 源码：[flutter/…/rendering/layer.dart](https://github.com/flutter/flutter/blob/main/packages/flutter/lib/src/rendering/layer.dart)
- 源码：[flutter/…/rendering/object.dart（PaintingContext、markNeedsPaint、flushPaint）](https://github.com/flutter/flutter/blob/main/packages/flutter/lib/src/rendering/object.dart)
- 源码：[flutter/…/rendering/view.dart（RenderView.compositeFrame）](https://github.com/flutter/flutter/blob/main/packages/flutter/lib/src/rendering/view.dart)
- 源码：[engine/…/impeller/entity/save_layer_utils.cc（SaveLayer coverage 计算）](https://github.com/flutter/flutter/blob/main/engine/src/flutter/impeller/entity/save_layer_utils.cc)
