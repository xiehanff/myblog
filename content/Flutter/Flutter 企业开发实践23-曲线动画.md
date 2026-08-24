---
title: Flutter 企业开发实践23-曲线动画
date: 2026-08-22
tags: [Flutter, 面试, 组件封装, 动画, 样条曲线, CustomPainter, AnimationController, 状态建模, 性能]
---

# 从 0 封装一套可复用的 Flutter 曲线动画组件

曲线动画表面上只是“画一条线，再让一个圆点移动”，可复用组件真正需要解决的是几何数据、时间进度、Widget 生命周期、尺寸适配和公开 API 的边界。

本章从零实现 `EnterpriseSpline`，示例包名使用 `enterprise_spline`，读者可以把它放入任意 Flutter 工程中验证。

实现不依赖业务路由、外部状态管理包或任何外部控制器。宿主可以不创建任何对象就使用动画；需要按钮控制时，再传入一个只转发命令的 `SplineHandle`。

文中的代码片段省略了不影响结构的 import 和样式参数（示意伪代码）；组件的完整实现可参照文末组件结构，自行在示例工程中补齐后运行。

## 1. 先写使用契约

最小使用方式：

```dart
EnterpriseSpline(
  points: const [
    Offset(0.05, 0.78),
    Offset(0.25, 0.22),
    Offset(0.52, 0.68),
    Offset(0.78, 0.18),
  ],
  handle: handle, // 可选，只发送命令
  duration: const Duration(milliseconds: 2200),
  autoplay: true,
  onStateChanged: logState,
)
```

契约先确定四件事：

| 维度 | 约定 |
| --- | --- |
| 坐标 | 支持 0..1 归一化坐标，也支持 750 设计稿坐标；绘制时映射到当前尺寸 |
| 状态 | `idle`、`playing`、`paused`、`completed` 四个互斥阶段 |
| 控制 | Widget 内部创建和释放 `AnimationController`，句柄只转发有限命令 |
| 依赖 | 只使用 Flutter SDK，宿主不必安装状态管理包 |

使用者只关心“给点、播放、观察状态”，不需要知道采样密度、曲线端点和帧回调。

### 1.1 从 750 设计稿 JSON 到闭合路径

设计稿导出的点通常是 `{ "x": 365, "y": 1071 }` 这样的笛卡尔坐标。组件的对外约定是：**宿主直接传原始点 + 用 `coordinateSpace` 声明坐标空间**，归一化由组件内部完成——不要让页面在每一帧临时换算：

```dart
final points = decodedJson.map((item) {
  return Offset(
    (item['x'] as num).toDouble(),
    (item['y'] as num).toDouble(),
  );
}).toList(growable: false);

EnterpriseSpline(
  points: points,
  coordinateSpace: SplineCoordinateSpace.design750,
  closed: true,
  autoplay: true,
);
```

组件内部据此选择路径工厂：`design750` 空间走 `SplinePath.fromDesign750(points)`（把 `x / 750`、`y / 750` 归一化），`normalized` 空间走 `SplinePath.fromPoints(points)`（输入必须已是 0..1，见 3.3 的校验）。绘制时两个轴都按当前组件宽度还原，保留设计稿的比例关系。闭合路径会去掉 JSON 中重复的末点，再用首尾相邻控制点补齐 Catmull-Rom 段，最后调用 `Path.close()`。

宿主如果需要脱离 Widget 单独用几何层（比如把圆点位置同步给原生层），取归一化点再自行乘尺寸：

```dart
final path = SplinePath.fromDesign750(points, closed: true);
final p = path.pointAt(0.65);            // 归一化坐标，见 3.1
final pixel = Offset(p.dx * size.width, p.dy * size.width);
```

百分比不是控制点索引。路径生成阶段会计算每个采样点之间的累计距离，`pointAt(0.65)` 查找总弧长 65% 的位置，因此点的疏密不会让动画在短线段停留过久。采样密度仍是可调的性能参数。

## 2. 按职责建立包结构

```text
your_spline_package/
├── lib/
│   ├── enterprise_spline.dart
│   └── src/
│       ├── spline_geometry.dart
│       └── spline_widget.dart
└── test/
    └── spline_geometry_test.dart
```

入口文件只导出稳定 API：

```dart
library enterprise_spline;

export 'src/spline_geometry.dart';
export 'src/spline_widget.dart';
```

几何层不引用 `State`，Widget 层不重新实现曲线数学。以后更换 Catmull-Rom、增加 Bézier 或增加不同绘制器时，公开入口可以保持不变。

## 3. 第一步：先做纯几何层

### 3.1 不可变路径对象

```dart
@immutable
class SplinePath {
  const SplinePath._({
    required this.controlPoints,
    required this.samples,
    required this.totalLength,
  });

  final List<Offset> controlPoints;
  final List<Offset> samples;
  final double totalLength;

  Offset pointAt(double progress) {
    // 实际实现按累计弧长查找，而不是按 samples 下标查找。
    final distance = progress.clamp(0.0, 1.0) * totalLength;
    return _interpolateByDistance(distance);
  }
}
```

`controlPoints` 用于调试和重新生成，`samples` 用于播放时 O(1) 查找。播放过程中不反复求解曲线方程，路径采样只在配置变化时发生。

### 3.2 Catmull-Rom 采样

每一段使用四个相邻点，端点重复，保证首尾都有完整输入：

```dart
Offset catmullRom(
  Offset p0,
  Offset p1,
  Offset p2,
  Offset p3,
  double t,
) {
  final t2 = t * t;
  final t3 = t2 * t;
  return Offset(
    0.5 * (2 * p1.dx + (-p0.dx + p2.dx) * t +
        (2 * p0.dx - 5 * p1.dx + 4 * p2.dx - p3.dx) * t2 +
        (-p0.dx + 3 * p1.dx - 3 * p2.dx + p3.dx) * t3),
    0.5 * (2 * p1.dy + (-p0.dy + p2.dy) * t +
        (2 * p0.dy - 5 * p1.dy + 4 * p2.dy - p3.dy) * t2 +
        (-p0.dy + 3 * p1.dy - 3 * p2.dy + p3.dy) * t3),
  );
}
```

每段默认采样 24 次，再追加最终点。采样密度是性能参数，应通过目标设备的视觉误差和帧耗时来调整，而不是当成数学常量。

### 3.3 构造阶段校验

```dart
if (points.length < 2) {
  throw ArgumentError.value(points.length, 'points', 'at least 2 points');
}
for (final point in points) {
  if (point.dx.isNaN || point.dy.isNaN ||
      point.dx < 0 || point.dx > 1 ||
      point.dy < 0 || point.dy > 1) {
    throw ArgumentError.value(point, 'points', 'must be normalized');
  }
}
```

错误在组件创建处暴露，比动画运行后出现错误坐标更容易定位。上面的校验针对归一化输入；`fromDesign750` 会先把设计稿坐标除以 750，再复用同一套有限值校验。生成的列表使用不可变视图，避免宿主在播放期间修改路径。

## 4. 第二步：用枚举表达播放状态

```dart
enum SplineStatus { idle, playing, paused, completed }

@immutable
class SplineState {
  const SplineState({
    required this.status,
    required this.progress,
    required this.position,
  });

  final SplineStatus status;
  final double progress;
  final Offset position;
}
```

播放阶段是互斥集合，不需要同时维护 `isPlaying`、`isPaused`、`isCompleted` 和 `hasStarted`。`SplineState` 是对外通知值，宿主可在状态或手动进度变化时展示进度，却拿不到内部的动画资源。

## 5. 第三步：用可选句柄发送命令

```dart
class SplineHandle {
  VoidCallback? _play;
  VoidCallback? _pause;
  VoidCallback? _restart;
  void Function(double percent)? _setProgress;

  void play() => _play?.call();
  void pause() => _pause?.call();
  void restart() => _restart?.call();
  void setProgress(double percent) => _setProgress?.call(percent);

  void attach({
    required VoidCallback play,
    required VoidCallback pause,
    required VoidCallback restart,
    required void Function(double percent) setProgress,
  }) {
    _play = play;
    _pause = pause;
    _restart = restart;
    _setProgress = setProgress;
  }

  void detach() {
    _play = null;
    _pause = null;
    _restart = null;
    _setProgress = null;
  }
}
```

句柄没有任何状态字段，真正的状态仍归 Widget 的 State 所有。页面按钮可以调用 `handle.pause()` 或 `handle.setProgress(0.65)`，但不会接管 `AnimationController` 的创建、复用和销毁。调用 `setProgress` 后，`0.65`（65%）会成为下一次播放的目标终点；普通暂停则从当前帧继续。

## 6. 第四步：Widget 内部拥有动画生命周期

先补齐 Widget 壳的完整字段（`coordinateSpace` 是 1.1 节对外约定的入口，必须有落点）：

```dart
enum SplineCoordinateSpace { design750, normalized }

class EnterpriseSpline extends StatefulWidget {
  const EnterpriseSpline({
    super.key,
    required this.points,
    this.coordinateSpace = SplineCoordinateSpace.normalized,
    this.closed = false,
    this.duration = const Duration(seconds: 3),
    this.handle,
    this.autoplay = false,
  });

  final List<Offset> points;
  final SplineCoordinateSpace coordinateSpace;
  final bool closed;
  final Duration duration;
  final SplineHandle? handle;
  final bool autoplay;

  @override
  State<EnterpriseSpline> createState() => _EnterpriseSplineState();
}
```

```dart
class _EnterpriseSplineState extends State<EnterpriseSpline>
    with SingleTickerProviderStateMixin {
  late AnimationController _animation;
  late SplinePath _path;
  SplineStatus _status = SplineStatus.idle;
  double _targetProgress = 1;

  @override
  void initState() {
    super.initState();
    _path = _buildPath(widget);
    _animation = AnimationController(
      vsync: this,
      duration: widget.duration,
    )..addStatusListener(_onAnimationStatus);
    _attachHandle(widget.handle);
    if (widget.autoplay) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _play());
    }
  }

  /// 坐标空间归组件管：design750 走工厂归一化，normalized 要求输入已是 0..1
  SplinePath _buildPath(EnterpriseSpline w) {
    return w.coordinateSpace == SplineCoordinateSpace.design750
        ? SplinePath.fromDesign750(w.points)
        : SplinePath.fromPoints(w.points);
  }

  void _attachHandle(SplineHandle? handle) {
    handle?.attach(
      play: _play,
      pause: _pause,
      restart: _restart,
      setProgress: _setProgress,
    );
  }

  @override
  void dispose() {
    widget.handle?.detach();
    _animation.dispose();
    super.dispose();
  }
}
```

生命周期责任是单向的：

1. `initState` 创建路径和动画；
2. `didUpdateWidget` 响应新路径或新时长；
3. `dispose` 解绑句柄并释放动画；
4. 宿主只传配置，不负责初始化顺序。

动画完成时把状态设置为 `completed`。百分比选择是本次播放的目标终点：例如先设置 65%，再点击播放，动画从起点运行到 65% 后完成；暂停则保留当前进度并继续到该目标。需要播放完整路径时把目标设置为 100%。

## 7. 第五步：静态路径与动态圆点分开绘制

```dart
final yScale = coordinateSpace == SplineCoordinateSpace.design750
    ? size.width
    : size.height;

Stack(
  children: [
    RepaintBoundary(
      child: CustomPaint(
        painter: _SplinePainter(
          path: _path,
          strokeColor: color,
        ),
        // CustomPaint 无 child 时必须显式给尺寸，否则非定位子节点
        // 在 Stack 里尺寸为零、路径画不出来（Size.infinite 交给外层约束裁剪）
        size: Size.infinite,
      ),
    ),
    Positioned(
      left: point.dx * size.width - radius,
      top: point.dy * yScale - radius,
      child: dot,
    ),
  ],
)
```

`_SplinePainter` 只绘制静态路径，`AnimatedBuilder` 每帧只更新圆点位置。路径映射在绘制时完成：

```dart
Path toPath(Size size) {
  final yScale = coordinateSpace == SplineCoordinateSpace.design750
      ? size.width
      : size.height;
  final path = Path()
    ..moveTo(samples.first.dx * size.width,
        samples.first.dy * yScale);
  for (final point in samples.skip(1)) {
    path.lineTo(point.dx * size.width, point.dy * yScale);
  }
  if (closed) path.close();
  return path;
}
```

对于 750 设计稿坐标，`toPath` 和圆点位置使用同一套坐标空间映射；路径和圆点不会因为组件宽高比例变化而产生两套缩放规则。

圆点定位也必须使用同一个 `yScale`。这样同一组数据可以在手机、平板和嵌套容器中复用，750 设计稿不会出现路径和圆点纵向比例不一致。只在静态曲线层使用 `RepaintBoundary`，避免把整个页面隔离成无意义的重绘边界。

## 8. 第六步：正确处理配置更新

```dart
@override
void didUpdateWidget(covariant EnterpriseSpline oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (!listEquals(oldWidget.points, widget.points) ||
      oldWidget.coordinateSpace != widget.coordinateSpace) {
    _path = _buildPath(widget);
    _restart();
  }
  if (oldWidget.duration != widget.duration) {
    _animation.duration = widget.duration;
  }
  // 句柄被替换：先解绑旧句柄，再挂新句柄——
  // 否则旧句柄仍持有本 State 的回调，页面按钮会控制一个已换掉的组件
  if (widget.handle != oldWidget.handle) {
    oldWidget.handle?.detach();
    _attachHandle(widget.handle);
  }
}
```

切换路线要重新采样并从起点播放；只改时长则保留当前路径。`restart` 从起点播放到当前目标百分比，完整重播把目标设置为 100%。配置变化和用户命令分别处理，问题定位时能知道一次重播究竟由什么触发。

## 9. 第七步：先测试纯逻辑，再测 Widget

```dart
test('samples a normalized path at both endpoints', () {
  final path = SplinePath.fromPoints(const [
    Offset(0, 0),
    Offset(0.5, 1),
    Offset(1, 0),
  ]);

  expect(path.pointAt(0), const Offset(0, 0));
  expect(path.pointAt(1), const Offset(1, 0));
  expect(path.pointAt(0.5).dy, greaterThan(0.5));
});
```

最低测试集：

- 控制点少于两个时抛出参数错误；
- 越界进度被限制到 0..1；
- 起点和终点稳定；
- 路径数据不可变；
- Widget 卸载后句柄不会调用旧回调。

验证命令：

```bash
flutter analyze
flutter test
```

静态分析和几何测试应在读者自己的 Flutter 工程中执行。设备上的动画流畅度、热重载和屏幕适配需要手动运行验证。

## 10. 手动运行和日志

示例页在状态回调中输出：

```text
[enterprise_spline] SplineState(status: SplineStatus.playing, ...)
[enterprise_spline] SplineState(status: SplineStatus.completed, ...)
```

点击“暂停”“播放”“重播”时，应分别看到 `paused`、`playing`、`idle/playing` 的状态转移。手动验证命令：

```bash
flutter devices
flutter run -d <device-id> -v 2>&1 | tee /tmp/enterprise_spline.log
```

排查问题时，设备信息、操作步骤和完整终端日志比「最后一行报错」有用得多——状态转移和 dispose 日志通常在报错之前。组件不要求宿主注册额外控制器或生命周期回调。

将组件放入独立路由后，重复执行“打开曲线页面 → 等待播放 → 系统返回”至少 10 次，观察以下两类日志都出现：

```text
[enterprise_spline] disposed label=curve-page
[lab] SplineDemoPage dispose
```

这两个日志分别对应组件 State 和页面 State 的销毁。若返回后仍有动画帧日志，说明仍有 Ticker 或动画回调没有在 `dispose` 中释放。

## 11. 完成标准

曲线组件从“能画出来”进入可复用状态，需要同时满足：

1. 坐标模型与 Widget 尺寸解耦；
2. 播放状态用枚举表达；
3. 动画资源由组件创建和释放；
4. 命令接口可选，不强迫宿主创建控制器；
5. 静态曲线不随每一帧进度重复计算；
6. 几何层可脱离设备运行测试；
7. 示例页能展示状态转移并输出诊断日志。

曲线组件的难点不是公式本身，而是把数据、时间、绘制和控制分成可以独立验证的边界。

## 面试追问

### 为什么使用归一化坐标？

路径数据不绑定屏幕像素，绘制时根据当前 `Size` 映射，旋转、分屏和不同容器尺寸不需要重新维护控制点。

### 为什么不暴露 AnimationController？

它同时承担时间、资源和生命周期责任。公开后宿主可能在 Widget 已销毁后继续操作；命令句柄只允许有限动作，状态仍由组件拥有。

### 为什么不用多个布尔值？

播放阶段是互斥集合，用枚举直接表达合法状态，避免出现“播放中且已完成”这类组合。

### 采样点越多越好吗？

不是。采样点越多，缓存和绘制工作越大；应结合目标设备和视觉误差测试选择采样密度。

## 官方技术文档

- [AnimationController API](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [CatmullRomSpline API](https://api.flutter.dev/flutter/animation/CatmullRomSpline-class.html)
- [CustomPainter API](https://api.flutter.dev/flutter/rendering/CustomPainter-class.html)
- [Path API](https://api.flutter.dev/flutter/dart-ui/Path-class.html)
- [AnimatedBuilder API](https://api.flutter.dev/flutter/widgets/AnimatedBuilder-class.html)
- [RepaintBoundary API](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html)
- [Widget 生命周期](https://api.flutter.dev/flutter/widgets/State-class.html)

## 样条曲线参考

Wikipedia 将样条曲线定义为由多个区间上的多项式片段组成的曲线，并在片段连接处施加连续性约束。它的关键价值是局部控制：调整某个控制点时，通常只影响相邻片段，不需要重新求解整条高阶多项式。

本文采用的 Catmull-Rom 是参数样条的一种：曲线经过给定控制点，再利用相邻点估计每个片段的切线。闭合路径额外把最后一个唯一控制点和第一个控制点连接起来，并使用循环邻居生成首尾片段。Flutter 官方的 `CatmullRomSpline` API 可用于理解同类样条在动画曲线中的参数化方式；本文的绘制实现使用自有几何采样层，以便支持二维路径、闭合路径和按弧长百分比定位。

- [Wikipedia：Spline (mathematics)](https://en.wikipedia.org/wiki/Spline_(mathematics))
- [Wikipedia：Spline interpolation](https://en.wikipedia.org/wiki/Spline_interpolation)
