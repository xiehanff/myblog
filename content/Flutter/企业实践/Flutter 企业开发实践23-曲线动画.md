---
title: Flutter 企业开发实践23-曲线动画
date: 2026-08-22
tags: [Flutter, 面试, 组件封装, 动画, 样条曲线, CustomPainter, AnimationController, 状态建模, 性能]
---

# 从 0 封装一套可复用的 Flutter 曲线动画组件

曲线动画看着就是“画一条线，再让一个圆点动起来”，但做成能复用的组件，要处理的是几何数据、时间进度、Widget 生命周期、尺寸适配、公开 API 这几块边界。

这篇从零实现一个 `EnterpriseSpline`，示例包名用 `enterprise_spline`，你把它丢进任意 Flutter 工程里都能验证。

这套实现不碰业务路由，不依赖外部状态管理包，也没有任何外部控制器。宿主一个对象都不用建就能放动画；要按钮控制的时候，再传一个只转发命令的 `SplineHandle` 进来。

下面的代码片段省掉了不影响结构的 import 和样式参数（示意伪代码）；完整实现照着文末的组件结构，自己在示例工程里补齐就能跑。

## 1. 先写使用契约

先看最小用法：

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

契约要先把这四件事定下来：

| 维度 | 约定 |
| --- | --- |
| 坐标 | 0..1 归一化坐标能传，750 设计稿坐标也能传；绘制时映射到当前尺寸 |
| 状态 | `idle`、`playing`、`paused`、`completed` 四个阶段，互斥 |
| 控制 | `AnimationController` 在 Widget 内部创建、释放，句柄只转发有限的几个命令 |
| 依赖 | 只用 Flutter SDK，宿主不用装状态管理包 |

用的人只管三件事：给点、播放、看状态。采样密度、曲线端点、帧回调这些不用知道。

### 1.1 750 设计稿导出的 JSON 怎么变成闭合路径

设计稿导出来的点一般是 `{ "x": 365, "y": 1071 }` 这种笛卡尔坐标。组件对外的约定是：**宿主把原始点直接传进来 + 用 `coordinateSpace` 说明是什么坐标空间**，归一化在组件内部做，别让页面每一帧去临时换算：

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

组件内部根据这个参数选路径工厂：`design750` 走 `SplinePath.fromDesign750(points)`（把 `x / 750`、`y / 750` 归一化），`normalized` 走 `SplinePath.fromPoints(points)`（传进来的必须已经是 0..1，校验在 3.3 节）。绘制时两个轴都按当前组件宽度还原，设计稿的比例关系就保住了。闭合路径会先去掉 JSON 里重复的末点，再用首尾相邻控制点把 Catmull-Rom 段补齐，最后调 `Path.close()`。

宿主要是想脱离 Widget 单独用几何层（比如把圆点位置同步给原生层），取归一化点，自己乘尺寸就行：

```dart
final path = SplinePath.fromDesign750(points, closed: true);
final p = path.pointAt(0.65);            // 归一化坐标，见 3.1
final pixel = Offset(p.dx * size.width, p.dy * size.width);
```

百分比不是控制点索引。路径生成的时候会算出每个采样点之间的累计距离，`pointAt(0.65)` 找的是总弧长 65% 那个位置，所以点疏点密都不会让动画在短线段上卡太久。采样密度还是那个可调的性能参数。

## 2. 包结构按职责分

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

入口文件只导出稳定的 API：

```dart
library enterprise_spline;

export 'src/spline_geometry.dart';
export 'src/spline_widget.dart';
```

几何层不引用 `State`，Widget 层也不重新实现一遍曲线数学。以后想换掉 Catmull-Rom、加 Bézier、加别的绘制器，对外的入口都不用动。

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
    // 实际实现按累计弧长查，不按 samples 下标查。
    final distance = progress.clamp(0.0, 1.0) * totalLength;
    return _interpolateByDistance(distance);
  }
}
```

`controlPoints` 拿来调试和重新生成，`samples` 负责播放时 O(1) 查找。播放过程中不会反复去解曲线方程，采样只在配置变了的时候做一次。

### 3.2 Catmull-Rom 采样

每一段用四个相邻点，端点重复一下，首尾就都有完整输入：

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

每段默认采样 24 次，最后再补一个终点。采样密度是个性能参数，得拿目标设备上的视觉误差和帧耗时去调，别把它当数学常量。

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

错误在组件创建的时候就抛出来，比动画跑着跑着冒出个错误坐标好定位得多。上面这段校验针对归一化输入；`fromDesign750` 先把设计稿坐标除以 750，再复用同一套有限值校验。生成的列表用不可变视图包了一层，免得宿主在播放期间把路径改掉。

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

播放阶段是互斥的，没必要同时维护 `isPlaying`、`isPaused`、`isCompleted` 和 `hasStarted` 四个布尔值。`SplineState` 是对外通知用的值，状态变了或者手动改了进度，宿主拿它展示进度就行，内部的动画资源拿不到。

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

句柄里没有任何状态字段，真正的状态还是归 Widget 的 State。页面按钮可以调 `handle.pause()` 或者 `handle.setProgress(0.65)`，但 `AnimationController` 的创建、复用和销毁都不归它管。调完 `setProgress`，`0.65`（65%）就是下一次播放的目标终点；普通暂停就从当前帧接着往下走。

## 6. 第四步：动画生命周期归 Widget 内部

先把 Widget 壳的字段补全（`coordinateSpace` 是 1.1 节对外约定的入口，字段总得有个落点）：

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

生命周期上的责任是单向的：

1. `initState` 创建路径和动画；
2. `didUpdateWidget` 响应新路径或新时长；
3. `dispose` 解绑句柄并释放动画；
4. 宿主只管传配置，不用操心初始化顺序。

动画跑完就把状态置成 `completed`。百分比选的是本次播放的目标终点：比如先设 65%，再点播放，动画就从起点跑到 65% 停；暂停的话保留当前进度，接着往这个目标走。想播完整条路径，把目标设成 100%。

## 7. 第五步：静态路径和动态圆点分开画

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
        // CustomPaint 没有 child 的时候必须显式给尺寸，否则非定位子节点
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

`_SplinePainter` 只画静态路径，`AnimatedBuilder` 每帧只更新圆点的位置。路径映射放在绘制的时候做：

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

750 设计稿坐标下，`toPath` 和圆点位置用的是同一套坐标空间映射；组件宽高比例怎么变，路径和圆点也不会变成两套缩放规则。

圆点定位也得用同一个 `yScale`。这样同一组数据在手机、平板、嵌套容器里都能复用，750 设计稿不会出现路径和圆点纵向比例对不上的情况。`RepaintBoundary` 只加在静态曲线层，免得把整个页面隔成一个没意义的重绘边界。

## 8. 第六步：配置更新怎么处理

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
  // 句柄被替换：先解绑旧句柄，再挂新句柄，
  // 否则旧句柄还留着本 State 的回调，页面按钮会控制一个已换掉的组件
  if (widget.handle != oldWidget.handle) {
    oldWidget.handle?.detach();
    _attachHandle(widget.handle);
  }
}
```

换了路线就得重新采样、从起点播；只改时长就保留当前路径。`restart` 是从起点播到当前的目标百分比，想完整重播就把目标设成 100%。配置变化和用户命令分开处理，出了问题能判断这次重播到底是谁触发的。

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

至少要测这几条：

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

静态分析和几何测试你在自己的 Flutter 工程里跑就行。设备上的动画流畅度、热重载和屏幕适配，得手动跑起来看。

## 10. 手动运行和日志

示例页在状态回调中输出：

```text
[enterprise_spline] SplineState(status: SplineStatus.playing, ...)
[enterprise_spline] SplineState(status: SplineStatus.completed, ...)
```

点“暂停”“播放”“重播”的时候，应该分别看到 `paused`、`playing`、`idle/playing` 的状态转移。手动验证用这几条命令：

```bash
flutter devices
flutter run -d <device-id> -v 2>&1 | tee /tmp/enterprise_spline.log
```

排查问题的时候，设备信息、操作步骤和整份终端日志，比只看「最后一行报错」有用得多。状态转移和 dispose 的日志一般都在报错之前。组件不需要宿主注册额外的控制器或者生命周期回调。

把组件放进独立路由，重复“打开曲线页面 → 等待播放 → 系统返回”至少 10 次，看下面这两类日志是不是都出现了：

```text
[enterprise_spline] disposed label=curve-page
[lab] SplineDemoPage dispose
```

这两条日志一个是组件 State 销毁，一个是页面 State 销毁。返回以后要是还有动画帧日志，说明还有 Ticker 或者动画回调没在 `dispose` 里释放掉。

## 11. 完成标准

曲线组件要从“能画出来”变成“能复用”，说白了就是这几条得同时满足：

1. 坐标模型跟 Widget 尺寸解耦；
2. 播放状态用枚举表达；
3. 动画资源由组件自己创建、自己释放；
4. 命令接口是可选的，不强迫宿主建控制器；
5. 静态曲线不会跟着每一帧进度重复算；
6. 几何层脱离设备也能跑测试；
7. 示例页能把状态转移展示出来，还能输出诊断日志。

曲线组件真正难的地方，是把数据、时间、绘制和控制分成几块能各自独立验证的边界。公式本身倒是次要的。

## 面试追问

### 为什么用归一化坐标？

路径数据不绑屏幕像素，绘制的时候按当前 `Size` 映射，旋转、分屏、换个容器尺寸，控制点都不用重新维护。

### 为什么不暴露 AnimationController？

时间、资源、生命周期三件事都压在它身上。公开出去，宿主可能在 Widget 已经销毁之后还去操作它；命令句柄只放开有限的几个动作，状态还是归组件。

### 为什么不用多个布尔值？

播放阶段本来就是互斥的，枚举直接把合法状态列出来，就不会出现“播放中且已完成”这种组合。

### 采样点越多越好吗？

不是。采样点越多，缓存和绘制的工作量越大；采样密度得结合目标设备和视觉误差测试来定。

## 官方技术文档

- [AnimationController API](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [CatmullRomSpline API](https://api.flutter.dev/flutter/animation/CatmullRomSpline-class.html)
- [CustomPainter API](https://api.flutter.dev/flutter/rendering/CustomPainter-class.html)
- [Path API](https://api.flutter.dev/flutter/dart-ui/Path-class.html)
- [AnimatedBuilder API](https://api.flutter.dev/flutter/widgets/AnimatedBuilder-class.html)
- [RepaintBoundary API](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html)
- [Widget 生命周期](https://api.flutter.dev/flutter/widgets/State-class.html)

## 样条曲线参考

Wikipedia 对样条曲线的定义是：由多个区间上的多项式片段拼起来、并在片段连接处加连续性约束的曲线。它最大的价值是局部控制：动某个控制点时通常只影响相邻片段，不用把整条高阶多项式重新解一遍。

这篇用的是 Catmull-Rom，参数样条里的一种：曲线穿过给定的控制点，再用相邻点估每个片段的切线。闭合路径多一步，把最后一个唯一控制点和第一个控制点接上，首尾片段用循环邻居来生成。Flutter 官方的 `CatmullRomSpline` API 可以用来理解同类样条在动画曲线里是怎么参数化的；这篇的绘制走的是自己写的几何采样层，这样才能支持二维路径、闭合路径，还有按弧长百分比定位。

- [Wikipedia：Spline (mathematics)](https://en.wikipedia.org/wiki/Spline_(mathematics))
- [Wikipedia：Spline interpolation](https://en.wikipedia.org/wiki/Spline_interpolation)
