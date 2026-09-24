# Flutter 显式动画教程：从零理解 AnimationController、Ticker、Tween 与 AnimatedBuilder

> 这是一篇教学式教程，面向有 Flutter 基础但还没真正搞懂动画体系的开发者。我会带你从"为什么需要动画框架"开始，一步步理解每个角色的设计动机、工作原理和实战用法，最终你能独立写出可靠的显式动画代码。

---

## 目录

- [1. 动画到底在做什么](#1-动画到底在做什么)
- [2. 为什么不能直接用 Timer](#2-为什么不能直接用-timer)
- [3. 整体架构：四个问题的回答](#3-整体架构四个问题的回答)
- [4. Ticker：动画的心跳](#4-ticker动画的心跳)
- [5. vsync 与 TickerProvider：让动画和页面生命周期绑定](#5-vsync-与-tickerprovider让动画和页面生命周期绑定)
- [6. AnimationController：时间轴控制器](#6-animationcontroller时间轴控制器)
- [7. Tween：把进度翻译成业务值](#7-tween把进度翻译成业务值)
- [8. Curve：让动画不再是匀速](#8-curve让动画不再是匀速)
- [9. Animation：值的抽象接口](#9-animation值的抽象接口)
- [10. AnimatedBuilder：只重建该重建的部分](#10-animatedbuilder只重建该重建的部分)
- [11. 完整链路：从 forward() 到屏幕刷新](#11-完整链路从-forward-到屏幕刷新)
- [12. 第一个完整示例：缩放淡入](#12-第一个完整示例缩放淡入)
- [13. 进阶实战一：点赞弹跳按钮](#13-进阶实战一点赞弹跳按钮)
- [14. 进阶实战二：交错入场动画](#14-进阶实战二交错入场动画)
- [15. 进阶实战三：单 Controller 多阶段编排](#15-进阶实战三单-controller-多阶段编排)
- [16. 进阶实战四：CustomPainter 高性能动画](#16-进阶实战四custompainter-高性能动画)
- [17. 显式动画 vs 隐式动画：什么时候用哪个](#17-显式动画-vs-隐式动画什么时候用哪个)
- [18. AnimationController 与状态管理（GetX / Riverpod / BLoC）](#18-animationcontroller-与状态管理getx--riverpod--bloc)
- [19. 生命周期与常见报错](#19-生命周期与常见报错)
- [20. 性能优化要点](#20-性能优化要点)
- [21. 源码阅读路线](#21-源码阅读路线)
- [22. 一句话记忆](#22-一句话记忆)

---

## 1. 动画到底在做什么

在 Flutter 里，动画不是"让某个 Widget 自己动起来"。

准确地说，Flutter 动画做的是这样一件事：

> **在一段时间内，按照屏幕刷新节奏不断计算一个变化的值，然后用这个值重新构建或绘制 UI。**

拿一个按钮渐显来举例，它背后发生的是：

1. 一个控制器在 300ms 内让值从 `0.0` 变到 `1.0`。
2. 每一帧产生一个新值。
3. UI 用这个值设置 `Opacity` 的 opacity 参数。
4. Flutter 重新绘制这块区域。
5. 用户看到"渐显"效果。

所以动画的本质是**值驱动 UI**，这和 Flutter 声明式 UI 的理念完全一致——你不需要命令式地操作 view，只需要让状态值变化，UI 自然跟着变。

---

## 2. 为什么不能直接用 Timer

你可能会想：我自己写个定时器不就行了？

```dart
Timer.periodic(const Duration(milliseconds: 16), (timer) {
  setState(() {
    value += 0.01;
  });
});
```

这确实能让东西动起来，但问题很快就会暴露：

- **不跟随屏幕刷新率**：60Hz 和 120Hz 设备上表现完全不同。
- **页面不可见时还在跑**：切到别的 tab、路由弹出、App 进后台，Timer 不会停。
- **动画时间不精确**：容易丢帧、抖动，因为 Timer 的回调时机不保证和渲染帧对齐。
- **无法统一暂停**：Flutter 有 `TickerMode` 机制可以一键关闭子树动画，Timer 不吃这套。
- **不和 Flutter 帧管线协同**：即使你在 Timer 回调里 setState，也可能和 Flutter 自身的 build/layout/paint 时机错位。

所以 Flutter 提供了 `Ticker`——一个和帧调度系统绑定的回调机制。它是整个动画体系的基石。

---

## 3. 整体架构：四个问题的回答

Flutter 显式动画体系可以归纳为四个问题：

| 问题 | 负责回答的角色 |
|---|---|
| 时间怎么走？ | `Ticker` |
| 值怎么变？ | `AnimationController` |
| 值怎么映射到 UI 属性？ | `Tween` / `Curve` |
| UI 怎么刷新？ | `AnimatedBuilder` / 各种 Transition |

它们的关系是这样的：

```text
TickerProvider（通常是 State）
    ↓ 创建
Ticker（每帧回调 elapsed 时间）
    ↓ 驱动
AnimationController（根据 elapsed 计算 0.0~1.0 进度）
    ↓ 经过 Curve 调整节奏
    ↓ 经过 Tween 映射成具体值
Animation<T>（对外暴露当前值和状态）
    ↓ 被 AnimatedBuilder 监听
只重建局部 UI
```

如果你理解了这条链路，后面所有的类就不再神秘——它们只是在链路的不同位置做自己的事。

---

## 4. Ticker：动画的心跳

### 4.1 Ticker 做了什么

`Ticker` 的作用很简单：**在每一帧回调时告诉你"距离动画开始已经过去了多少时间"**。

简化版伪代码长这样：

```dart
Ticker((Duration elapsed) {
  // elapsed 是从 ticker 启动到当前帧经过的时间
  // 你可以根据这个时间计算当前动画值
});
```

它的回调频率取决于屏幕刷新率：60Hz 设备上大约每 16.67ms 一次，120Hz 上大约每 8.33ms 一次。掉帧时间隔也会变大。

所以动画不能假设"每帧固定增加某个值"，而应该根据真实的 elapsed 时间来计算进度——这正是 AnimationController 帮你做的事。

> 官方文档：[Ticker class](https://api.flutter.dev/flutter/scheduler/Ticker-class.html)，其中明确了静音（muted）期间时间仍然流逝、回调不再触发的语义。

### 4.2 Ticker 不是渲染线程

Ticker 运行在 Flutter framework 侧，它不是 GPU、不是 Skia、也不是独立线程。它只是在 Flutter 的帧管线里注册了一个回调：

```text
handleBeginFrame（引擎通知 framework：新帧来了）
    ↓ 执行 transient callbacks（包括 Ticker 的 _tick）
handleDrawFrame（同一帧的绘制阶段）
    ↓ build → layout → paint → compositing
    ↓ rasterization（光栅化，由 raster 线程异步完成）
```

Ticker 的角色是"提醒者"：下一帧来了，你的动画值该更新了。真正的渲染还是要走 Flutter 的完整管线。

### 4.3 Ticker 和 Timer 的核心区别

| 对比项 | Ticker | Timer.periodic |
|---|---|---|
| 与 Flutter 帧调度绑定 | 是 | 否 |
| 适合驱动 UI 动画 | 是 | 不推荐 |
| 感知 TickerMode | 是 | 否 |
| 页面不可见时自动暂停 | 是（配合官方 provider） | 需手动处理 |
| 时间模型 | 基于 frame elapsed | 基于计时器回调 |
| 适合业务倒计时 | 不推荐 | 可以 |

简单记：**驱动 UI 动画用 Ticker，驱动业务逻辑用 Timer**。

---

## 5. vsync 与 TickerProvider：让动画和页面生命周期绑定

### 5.1 vsync 不是布尔值

你写 AnimationController 时一定见过这个：

```dart
AnimationController(
  vsync: this,   // 这是什么？
  duration: const Duration(milliseconds: 300),
);
```

这里的 `vsync` 类型是 `TickerProvider`——一个能创建 Ticker 的对象，不是布尔值，也不是屏幕刷新率本身。

"vsync"这个名字来自图形领域的垂直同步（vertical synchronization），意思是让画面更新和屏幕刷新节奏对齐。在 Flutter 里，传入 vsync 的目的是：

1. 让动画由 Flutter 的帧调度驱动（而不是自己起 Timer）。
2. 当页面不可见或 `TickerMode` 关闭时，ticker 可以自动暂停。
3. 避免后台无意义消耗资源。
4. 让调试工具能追踪 ticker 来源。

### 5.2 为什么不能直接 new 一个 Ticker

理论上你可以 `Ticker(callback)` 直接创建，但不推荐。因为官方的 mixin 会把 Ticker 和当前 State 的生命周期、TickerMode、调试信息全部关联起来。绕开它们，你很容易遇到：

- 页面不可见但动画还在跑
- 路由切走后仍消耗资源
- dispose 后 ticker 还 active
- 调试时定位不到 ticker 泄漏

### 5.3 两个 TickerProvider mixin

**SingleTickerProviderStateMixin**——一个 State 只创建一个 AnimationController 时用：

```dart
class _MyPageState extends State<MyPage> with SingleTickerProviderStateMixin {
  late final AnimationController controller;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 300));
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }
}
```

**TickerProviderStateMixin**——一个 State 需要多个 AnimationController 时用：

```dart
class _MyPageState extends State<MyPage> with TickerProviderStateMixin {
  late final AnimationController fadeController;
  late final AnimationController scaleController;

  @override
  void initState() {
    super.initState();
    fadeController = AnimationController(vsync: this, duration: const Duration(milliseconds: 300));
    scaleController = AnimationController(vsync: this, duration: const Duration(milliseconds: 500));
  }

  @override
  void dispose() {
    fadeController.dispose();
    scaleController.dispose();
    super.dispose();
  }
}
```

选择原则很简单：**一个 controller 用 Single，多个用普通版**。Single 版会在 debug 模式下帮你发现意外创建多个 ticker 的问题。

> 官方文档：[SingleTickerProviderStateMixin](https://api.flutter.dev/flutter/widgets/SingleTickerProviderStateMixin-mixin.html)、[TickerProviderStateMixin](https://api.flutter.dev/flutter/widgets/TickerProviderStateMixin-mixin.html)。

### 5.4 TickerMode 的作用

`TickerMode` 可以控制子树内所有 ticker 是否启用：

```dart
TickerMode(
  enabled: isCurrentTab,
  child: animatedContent,
)
```

注意：TickerMode 不是把 controller 暂停在原地，而是让 ticker 静音。控制器的时间概念还在走，只是不再主动发帧回调。这就是为什么界面切到不可见区域后，动画不会继续吃 UI 刷新资源。

还要注意一个容易被忽略的后果：静音期间 Ticker 内部的起始时间戳不会被重置，所以恢复可见后，动画**不会从暂停处平滑继续**，而是直接跳到"当前时刻本应到达"的进度。官方文档的原话是："Animations driven by such tickers are not paused, they just don't call their callbacks. Time still elapses."

> 官方文档：[TickerMode class](https://api.flutter.dev/flutter/widgets/TickerMode-class.html)。

---

## 6. AnimationController：时间轴控制器

`AnimationController` 是显式动画的核心。它本身继承自 `Animation<double>`，所以它既是一个控制器，也是一个动画对象。（官方文档：[AnimationController class](https://api.flutter.dev/flutter/animation/AnimationController-class.html)）

### 6.1 它负责什么

从使用者角度，AnimationController 负责：

1. 定义动画时长
2. 定义动画值范围（默认 0.0 ~ 1.0）
3. 控制开始、停止、反向、重置
4. 暴露当前动画值 `value`
5. 暴露动画状态 `status`
6. 通知监听者当前值变化
7. 绑定 Ticker 来跟随每一帧更新

它的核心不是"值本身"，而是"值怎么走"。它接收 vsync 后，内部会从 TickerProvider 那里拿到 ticker，再用每一帧的回调去推进当前值。

### 6.2 最常见的构造方式

```dart
AnimationController(
  vsync: this,
  duration: const Duration(milliseconds: 300),
);
```

默认值范围是 `lowerBound: 0.0`、`upperBound: 1.0`。`forward()` 会让 value 从 0.0 走到 1.0。

你也可以自定义范围：

```dart
controller = AnimationController(
  vsync: this,
  duration: const Duration(seconds: 1),
  lowerBound: 100,
  upperBound: 300,
);
```

但工程上更推荐保持 controller 为 0~1，然后用 Tween 做映射——这样职责更清晰：controller 管时间进度，Tween 管数值映射。

### 6.3 播放控制 API

这些方法语义不同，用对场景很重要：

| 方法 | 语义 | 要点 |
|---|---|---|
| `forward()` | 正向播放 | 从当前值向 upperBound 走；传 `from: 0` 可以从起点开始 |
| `reverse()` | 反向播放 | 从当前值向 lowerBound 走 |
| `repeat()` | 循环播放 | `reverse: true` 可以往返；`min`/`max` 可以限制区间；`period` 指定单圈时长 |
| `stop()` | 停在当前值 | 保留 value 和 status，不会回起点 |
| `reset()` | 回到起点 | value 设为 lowerBound，status 回到 dismissed |
| `animateTo(target)` | 动画到指定值 | 可指定 duration 和 curve |
| `animateBack(target)` | 反向动画到指定值 | 类似 animateTo 但方向相反 |
| `fling()` | 物理惯性动画 | 适合手势释放后的惯性效果 |
| `dispose()` | 释放资源 | 之后不可再使用 |

**stop() 和 reset() 的区别经常被混淆**：stop 只是停住，reset 会回到起点并改变状态。

**forward() 如果没有设 duration 会报错**——这说明控制器只负责执行，具体跑多久必须先定义清楚。

### 6.4 动画状态（AnimationStatus）

```dart
AnimationStatus.dismissed   // 在起点，未开始或已被 reset
AnimationStatus.forward     // 正在正向播放
AnimationStatus.reverse     // 正在反向播放
AnimationStatus.completed   // 到达终点
```

value 告诉你"现在是多少"，status 告诉你"走到哪一步了"。动画代码里常常两个都要看，尤其是需要在完成时触发下一步逻辑的时候。

### 6.5 reverseDuration

如果正向和反向播放节奏不同，可以单独设置 `reverseDuration`：

```dart
AnimationController(
  vsync: this,
  duration: const Duration(milliseconds: 600),
  reverseDuration: const Duration(milliseconds: 350),
);
```

这在回弹、折返、进出场节奏不同的交互中很好用。

### 6.6 unbounded 构造

`AnimationController.unbounded` 不限制上下界，适合物理模拟这类不需要卡在 0~1 区间的运动。

---

## 7. Tween：把进度翻译成业务值

AnimationController 默认只给你一个 double，通常是 0.0~1.0。但 UI 需要的值各种各样：

- 宽度：100.0 ~ 300.0
- 透明度：0.0 ~ 1.0
- 颜色：Colors.red ~ Colors.blue
- 偏移：Offset.zero ~ Offset(100, 0)
- 圆角：0 ~ 20

这时候需要 `Tween`。

### 7.1 Tween 的本质

`Tween<T>` 是值映射器。它的职责是插值，不是驱动播放。

```dart
final animation = Tween<double>(begin: 100, end: 300).animate(controller);
```

当 controller.value 变化时，animation.value 的对应关系：

| controller.value | animation.value |
|---:|---:|
| 0.0 | 100 |
| 0.25 | 150 |
| 0.5 | 200 |
| 0.75 | 250 |
| 1.0 | 300 |

**Tween 本身不是 Animation**，调用 `animate()` 后才会接到一个 Animation<double> 上，得到一个真正随时间变化的 Animation<T>。

### 7.2 常用 Tween 类型

- `Tween<double>`：通用数值插值
- `ColorTween`：颜色插值
- `SizeTween`：尺寸插值
- `RectTween`：矩形插值
- `Tween<Offset>`：偏移插值（注意 framework 没有 `OffsetTween` 这个类，直接用泛型 Tween 即可）
- `BorderRadiusTween`：圆角插值

### 7.3 TweenSequence：分段插值

如果一个动画需要拆成多个阶段（比如先放大再缩小），用 `TweenSequence`：

```dart
final scale = TweenSequence<double>([
  TweenSequenceItem(
    tween: Tween<double>(begin: 1.0, end: 1.35).chain(CurveTween(curve: Curves.easeOut)),
    weight: 45,
  ),
  TweenSequenceItem(
    tween: Tween<double>(begin: 1.35, end: 1.0).chain(CurveTween(curve: Curves.easeIn)),
    weight: 55,
  ),
]).animate(controller);
```

`weight` 决定每段占总时长的比例。

---

## 8. Curve：让动画不再是匀速

线性动画看起来很机械。Curve 的作用是**不改变最终范围，只改变中间过程**。

线性进度：`0.0 → 0.1 → 0.2 → 0.3 → ... → 1.0`

缓出进度：`0.0 → 0.19 → 0.36 → 0.51 → ... → 1.0`

### 8.1 两种写法

**方式一：CurvedAnimation**——包装现成 Animation，还能分别设正向和反向曲线：

```dart
final curved = CurvedAnimation(
  parent: controller,
  curve: Curves.easeOut,
  reverseCurve: Curves.easeIn,  // 反向播放可以用不同曲线
);

final width = Tween<double>(begin: 100, end: 300).animate(curved);
```

**方式二：CurveTween + chain / drive**——适合链式组合：

```dart
final animation = Tween<double>(begin: 100, end: 300)
    .chain(CurveTween(curve: Curves.easeOut))
    .animate(controller);
```

或者用 `drive`：

```dart
final animation = controller
    .drive(CurveTween(curve: Curves.easeInOut))
    .drive(Tween<double>(begin: 0, end: 300));
```

两种写法效果接近，区别在于 CurvedAnimation 更适合包装现成动画，CurveTween 更适合串在链路里。一般习惯：先把时间节奏调顺，再把进度翻译成目标值。

### 8.2 Interval：时间切片

`Interval(begin, end)` 是一种特殊的 Curve，表示只在整个动画的某个区间内生效：

```dart
CurvedAnimation(
  parent: controller,
  curve: const Interval(0.2, 0.75, curve: Curves.easeOutCubic),
)
```

意思是：

- controller 进度 0.0~0.2：这个动画保持开始值
- controller 进度 0.2~0.75：这个动画运行
- controller 进度 0.75~1.0：这个动画保持结束值

适合做分段动画编排——用一个 controller 同时驱动多个错开时间的动画。

---

## 9. Animation：值的抽象接口

`Animation<T>` 是整条链路对外的统一接口。

它表示一个会随时间变化的值，提供：

- `value`：当前值
- `status`：当前状态（dismissed / forward / reverse / completed）
- `addListener()`：监听值变化（每帧触发）
- `addStatusListener()`：监听状态变化（状态切换时触发）

### 9.1 关键认知

- `AnimationController` 本身就是一个 `Animation<double>`
- `CurvedAnimation` 也是一个 `Animation<double>`
- `Tween.animate()` 返回的也是 `Animation<T>`

所以你面向的对象不是"某个控制器"，而是"一个会变化的值源"。这让代码更容易组合。

### 9.2 Animation 不负责播放

这是一个容易写偏的点：`Animation` 只是承载变化结果，真正决定怎么动的是 `AnimationController`。

### 9.3 两种监听的区别

| 对比项 | addListener | addStatusListener |
|---|---|---|
| 触发频率 | 每次数值变化（每帧） | 状态变化时 |
| 适合做 UI 刷新 | 可以，但推荐 AnimatedBuilder | 不适合 |
| 适合做流程控制 | 不推荐 | 推荐（如完成后触发下一步） |

典型的状态监听——动画完成后反向播放：

```dart
controller.addStatusListener((status) {
  if (status == AnimationStatus.completed) {
    controller.reverse();
  }
});
```

---

## 10. AnimatedBuilder：只重建该重建的部分

最原始的刷新 UI 写法：

```dart
controller.addListener(() {
  setState(() {});
});
```

这能用，但每一帧都会触发整个 State 的 build 重新执行。如果 build 里有复杂子树，开销很大。

### 10.1 AnimatedBuilder 做了什么

`AnimatedBuilder` 的核心价值不是"能做动画"，而是：

> **把动画监听和局部 rebuild 封装起来，并允许你把不变子树通过 child 缓存下来。**

```dart
AnimatedBuilder(
  animation: controller,
  builder: (context, child) {
    return Opacity(
      opacity: controller.value,
      child: child,
    );
  },
  child: const ExpensiveChild(),  // 这个不会每帧重建
)
```

`child` 参数不是装饰——只要 builder 里有一部分内容跟动画无关，就应该把它提到 child 里。这样 builder 里拿到的 child 可以直接复用，不会跟着每帧一起重建。

### 10.2 AnimatedBuilder 监听的是 Listenable

名字虽然叫 AnimatedBuilder，但 `animation` 参数的类型是 `Listenable`。所以它也能监听 `ChangeNotifier`、`ValueNotifier`。如果你只是监听非动画类型的 Listenable，`ListenableBuilder` 在语义上更直观，能力上没区别。（官方文档：[AnimatedBuilder class](https://api.flutter.dev/flutter/widgets/AnimatedBuilder-class.html)）

### 10.3 AnimatedWidget：封装可复用动画组件

如果需要封装通用动画组件，可以用 `AnimatedWidget`：

```dart
class FadeBox extends AnimatedWidget {
  const FadeBox({
    super.key,
    required Animation<double> opacity,
    required this.child,
  }) : super(listenable: opacity);

  final Widget child;

  Animation<double> get opacity => listenable as Animation<double>;

  @override
  Widget build(BuildContext context) {
    return Opacity(opacity: opacity.value, child: child);
  }
}
```

`AnimatedBuilder` 更灵活适合页面内局部使用，`AnimatedWidget` 更适合封装通用组件。

### 10.4 不要把多个不同节奏的动画硬塞进一个 AnimatedBuilder

如果多个动画值共享同一个时间轴，放在一个 AnimatedBuilder 里没问题。但如果它们的播放节奏本来就不同，最好拆开，不然后面调节节奏时会很别扭。

---

## 11. 完整链路：从 forward() 到屏幕刷新

当你调用 `controller.forward()`，背后发生了什么？

```text
controller.forward()
    ↓
创建插值模拟，启动内部 Ticker
    ↓
Ticker 通过 SchedulerBinding 注册下一帧回调
    ↓
屏幕下一次 vsync 信号到来
    ↓
handleBeginFrame(timeStamp)
    ↓
Ticker 收到 tick(elapsed)
    ↓
AnimationController 根据 elapsed 计算 value
    ↓
notifyListeners()
    ↓
AnimatedBuilder / Transition / CustomPainter 响应变化
    ↓
build / layout / paint
    ↓
屏幕显示新画面
```

### AnimationController 如何计算 value？

假设 duration = 300ms，lowerBound = 0.0，upperBound = 1.0，当 elapsed = 150ms：

```
progress = elapsed / duration = 150 / 300 = 0.5
value = lowerBound + (upperBound - lowerBound) * progress = 0.0 + 1.0 * 0.5 = 0.5
```

一个容易误解的细节：源码里 `_animateToInternal` 会把动画时长乘以**剩余路程比例**——`simulationDuration = directionDuration * (target - value).abs() / (upperBound - lowerBound)`。也就是说，如果 value 已经在 0.5 时调用 `forward()`，实际只会跑 150ms 而不是完整的 300ms；上面的公式之所以成立，是因为从起点出发时剩余比例恰好是 1。反向播放时 `directionDuration` 会优先用 `reverseDuration`。

实际源码里还会涉及 simulation、方向、bounded/unbounded、tolerance 等，但理解上可以先认为：**AnimationController 是一个基于 elapsed 时间计算当前 value 的控制器**。

---

## 12. 第一个完整示例：缩放淡入

这是一个可以直接运行的最小示例，包含所有关键要素：

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: AnimationControllerBasicPage()));
}

class AnimationControllerBasicPage extends StatefulWidget {
  const AnimationControllerBasicPage({super.key});

  @override
  State<AnimationControllerBasicPage> createState() =>
      _AnimationControllerBasicPageState();
}

class _AnimationControllerBasicPageState
    extends State<AnimationControllerBasicPage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _scale;
  late final Animation<double> _opacity;

  @override
  void initState() {
    super.initState();

    // 1. 创建 controller，绑定 vsync
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );

    // 2. 用 Curve 调整节奏
    final curved = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOutBack,
    );

    // 3. 用 Tween 映射成业务值
    _scale = Tween<double>(begin: 0.6, end: 1.0).animate(curved);
    _opacity = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();  // 4. 必须释放
    super.dispose();
  }

  void _toggle() {
    if (_controller.status == AnimationStatus.completed) {
      _controller.reverse();
    } else {
      _controller.forward();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('AnimationController Basic')),
      body: Center(
        child: AnimatedBuilder(
          animation: _controller,  // 5. 用 AnimatedBuilder 局部重建
          builder: (context, child) {
            return Opacity(
              opacity: _opacity.value,
              child: Transform.scale(scale: _scale.value, child: child),
            );
          },
          child: Container(       // 6. 静态子树放进 child
            width: 160,
            height: 160,
            decoration: BoxDecoration(
              color: Colors.blue,
              borderRadius: BorderRadius.circular(24),
            ),
            alignment: Alignment.center,
            child: const Text('Hello', style: TextStyle(color: Colors.white, fontSize: 24)),
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _toggle,
        child: const Icon(Icons.play_arrow),
      ),
    );
  }
}
```

### 这个示例覆盖了什么

1. **SingleTickerProviderStateMixin** 提供了 vsync
2. **AnimationController** 管理时间进度
3. **CurvedAnimation** 调整节奏（easeOutBack 让缩放有弹性感）
4. **Tween** 把 0~1 映射成缩放值和透明度
5. **AnimatedBuilder** 只重建动画相关部分
6. **child** 缓存不变子树
7. **dispose** 释放 controller
8. **status 检查** 控制正向/反向切换

不要写成 `_controller.addListener(() { setState(() {}); })`——这会让整个页面每帧重建。

---

## 13. 进阶实战一：点赞弹跳按钮

业务中经常需要点击时做弹性缩放动画。这里用 `TweenSequence` 实现一个两阶段动效：先放大再缩回。

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: LikeDemoPage()));
}

class LikeDemoPage extends StatefulWidget {
  const LikeDemoPage({super.key});

  @override
  State<LikeDemoPage> createState() => _LikeDemoPageState();
}

class _LikeDemoPageState extends State<LikeDemoPage> {
  bool liked = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Like Bounce Button')),
      body: Center(
        child: LikeBounceButton(
          liked: liked,
          onChanged: (value) => setState(() => liked = value),
        ),
      ),
    );
  }
}

class LikeBounceButton extends StatefulWidget {
  const LikeBounceButton({
    super.key,
    required this.liked,
    required this.onChanged,
  });

  final bool liked;
  final ValueChanged<bool> onChanged;

  @override
  State<LikeBounceButton> createState() => _LikeBounceButtonState();
}

class _LikeBounceButtonState extends State<LikeBounceButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _scale;

  @override
  void initState() {
    super.initState();

    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 260),
    );

    // 两阶段：1.0 → 1.35 → 1.0
    _scale = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween<double>(begin: 1.0, end: 1.35)
            .chain(CurveTween(curve: Curves.easeOut)),
        weight: 45,
      ),
      TweenSequenceItem(
        tween: Tween<double>(begin: 1.35, end: 1.0)
            .chain(CurveTween(curve: Curves.easeIn)),
        weight: 55,
      ),
    ]).animate(_controller);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _handleTap() async {
    widget.onChanged(!widget.liked);  // 先切换图标
    await _controller.forward(from: 0);  // 再播动画
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.liked ? Colors.red : Colors.grey;
    final icon = widget.liked ? Icons.favorite : Icons.favorite_border;

    return GestureDetector(
      onTap: _handleTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: AnimatedBuilder(
          animation: _scale,
          builder: (context, child) => Transform.scale(scale: _scale.value, child: child),
          child: Icon(icon, color: color, size: 64),
        ),
      ),
    );
  }
}
```

### 设计要点

- **TweenSequence** 把动画拆成两段，比简单 Tween 更符合点赞弹跳的自然手感
- **onChanged 先执行**：UI 图标先切换成实心红色，然后执行弹跳。如果希望动画结束后再切换，把两行换位置即可
- **组件封装**：LikeBounceButton 把动画逻辑完全封装，外部只需要传 `liked` 和 `onChanged`

---

## 14. 进阶实战二：交错入场动画

列表 item 入场时常见的做法是让每个 item 自己管理 controller，通过延迟启动实现交错效果。

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: AnimatedListItemDemoPage()));
}

class AnimatedListItemDemoPage extends StatelessWidget {
  const AnimatedListItemDemoPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('List Item Entrance Animation')),
      body: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: 30,
        itemBuilder: (context, index) {
          return EntranceListItem(
            index: index,
            child: Card(
              child: ListTile(
                leading: CircleAvatar(child: Text('$index')),
                title: Text('Item $index'),
                subtitle: const Text('Entrance animation demo'),
              ),
            ),
          );
        },
      ),
    );
  }
}

class EntranceListItem extends StatefulWidget {
  const EntranceListItem({
    super.key,
    required this.index,
    required this.child,
  });

  final int index;
  final Widget child;

  @override
  State<EntranceListItem> createState() => _EntranceListItemState();
}

class _EntranceListItemState extends State<EntranceListItem>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _opacity;
  late final Animation<Offset> _offset;

  @override
  void initState() {
    super.initState();

    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 420),
    );

    final curved = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOutCubic,
    );

    _opacity = Tween<double>(begin: 0, end: 1).animate(curved);
    _offset = Tween<Offset>(
      begin: const Offset(0, 0.12),
      end: Offset.zero,
    ).animate(curved);

    // 按 index 延迟启动，形成交错效果
    Future<void>.delayed(Duration(milliseconds: widget.index * 40), () {
      if (!mounted) return;  // 必须检查 mounted
      _controller.forward();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacity,
      child: SlideTransition(position: _offset, child: widget.child),
    );
  }
}
```

### 关键点

- `Future.delayed` 后**必须**检查 `mounted`，否则 item 在延迟期间被回收后再操作 controller 会出错
- 几十个 item 的一次性入场动画通常可接受；如果是大量持续循环动画，要考虑只给可见区域做动画
- 这里用了 `FadeTransition` 和 `SlideTransition` 而不是 AnimatedBuilder，它们是封装好的 Transition Widget，内部已经处理了动画监听

---

## 15. 进阶实战三：单 Controller 多阶段编排

复杂页面经常需要一组动画按时间编排：标题先淡入，卡片跟着上滑，按钮最后出现。用一个 controller + 多个 Interval 就能实现。

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: StaggeredAnimationPage()));
}

class StaggeredAnimationPage extends StatefulWidget {
  const StaggeredAnimationPage({super.key});

  @override
  State<StaggeredAnimationPage> createState() => _StaggeredAnimationPageState();
}

class _StaggeredAnimationPageState extends State<StaggeredAnimationPage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _titleOpacity;
  late final Animation<Offset> _cardOffset;
  late final Animation<double> _buttonOpacity;
  late final Animation<double> _backgroundScale;

  @override
  void initState() {
    super.initState();

    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    );

    // 标题：0%~35% 区间淡入
    _titleOpacity = CurvedAnimation(
      parent: _controller,
      curve: const Interval(0.0, 0.35, curve: Curves.easeOut),
    );

    // 卡片：20%~75% 区间上滑
    _cardOffset = Tween<Offset>(
      begin: const Offset(0, 0.16),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: const Interval(0.2, 0.75, curve: Curves.easeOutCubic),
    ));

    // 按钮：65%~100% 区间淡入
    _buttonOpacity = CurvedAnimation(
      parent: _controller,
      curve: const Interval(0.65, 1.0, curve: Curves.easeOut),
    );

    // 背景：全程轻微缩放
    _backgroundScale = Tween<double>(begin: 1.08, end: 1.0).animate(
      CurvedAnimation(
        parent: _controller,
        curve: const Interval(0.0, 1.0, curve: Curves.easeOutCubic),
      ),
    );

    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          return Stack(
            fit: StackFit.expand,
            children: [
              Transform.scale(
                scale: _backgroundScale.value,
                child: Container(color: Colors.blueGrey.shade900),
              ),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Opacity(
                        opacity: _titleOpacity.value,
                        child: const Text(
                          'Flutter Animation',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 32,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                      const SizedBox(height: 32),
                      SlideTransition(
                        position: _cardOffset,
                        child: Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(24),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(24),
                          ),
                          child: const Text(
                            '一个 controller 可以通过 Interval 拆分成多个阶段动画。',
                            style: TextStyle(fontSize: 18),
                          ),
                        ),
                      ),
                      const Spacer(),
                      Opacity(
                        opacity: _buttonOpacity.value,
                        child: SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: () => _controller.forward(from: 0),
                            child: const Text('Replay'),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
```

### Interval 的意义

`Interval(0.2, 0.75)` 表示 controller 进度在 0.0~0.2 时保持开始值，0.2~0.75 时运行动画，0.75~1.0 时保持结束值。这让你用一条时间轴编排多个错开时间的动画，而不需要多个 controller。

---

## 16. 进阶实战四：CustomPainter 高性能动画

如果动画涉及大量粒子、波形、雷达扫描、图表变化，与其让很多 Widget 重建，不如直接在 Canvas 上画。

```text
AnimationController
    ↓ repaint: animation
CustomPainter
    ↓ 只触发 paint，不触发 widget build
```

```dart
import 'dart:math' as math;
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(home: RadarPainterDemoPage()));
}

class RadarPainterDemoPage extends StatefulWidget {
  const RadarPainterDemoPage({super.key});

  @override
  State<RadarPainterDemoPage> createState() => _RadarPainterDemoPageState();
}

class _RadarPainterDemoPageState extends State<RadarPainterDemoPage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Radar Painter Animation')),
      body: Center(
        child: RepaintBoundary(
          child: CustomPaint(
            size: const Size(260, 260),
            painter: RadarPainter(progress: _controller),
          ),
        ),
      ),
    );
  }
}

class RadarPainter extends CustomPainter {
  RadarPainter({required this.progress}) : super(repaint: progress);

  final Animation<double> progress;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = math.min(size.width, size.height) / 2;

    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.green.withValues(alpha: 0.35);

    final sweepPaint = Paint()
      ..style = PaintingStyle.fill
      ..shader = SweepGradient(
        colors: [
          Colors.green.withValues(alpha: 0.0),
          Colors.green.withValues(alpha: 0.45),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: radius));

    for (int i = 1; i <= 4; i++) {
      canvas.drawCircle(center, radius * i / 4, ringPaint);
    }

    final angle = progress.value * math.pi * 2;

    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.rotate(angle);
    canvas.translate(-center.dx, -center.dy);

    final path = Path()
      ..moveTo(center.dx, center.dy)
      ..arcTo(
        Rect.fromCircle(center: center, radius: radius),
        -math.pi / 10,
        math.pi / 5,
        false,
      )
      ..close();

    canvas.drawPath(path, sweepPaint);
    canvas.restore();

    final dotPaint = Paint()..color = Colors.greenAccent;
    canvas.drawCircle(center + Offset(radius * 0.45, -radius * 0.25), 4, dotPaint);
    canvas.drawCircle(center + Offset(-radius * 0.25, radius * 0.35), 3, dotPaint);
  }

  @override
  bool shouldRepaint(covariant RadarPainter oldDelegate) {
    return oldDelegate.progress != progress;
  }
}
```

### 为什么性能更好

关键在构造函数里：

```dart
RadarPainter({required this.progress}) : super(repaint: progress);
```

`super(repaint: progress)` 让 painter 直接监听 animation。动画变化时只触发 paint，不触发 widget build。

如果你的动画主要是 Canvas 绘制，应该优先考虑这种方式。

`RepaintBoundary` 把动画重绘区域隔离出来，减少对周围 UI 的影响。但不要滥用，它自身也有成本——适合动画区域独立、周围 UI 复杂但不变的场景。

---

## 17. 显式动画 vs 隐式动画：什么时候用哪个

Flutter 动画分两大类：

**隐式动画**：`AnimatedContainer`、`AnimatedOpacity`、`AnimatedPositioned`、`TweenAnimationBuilder` 等

```dart
AnimatedContainer(
  duration: const Duration(milliseconds: 300),
  width: selected ? 200 : 100,
  color: selected ? Colors.blue : Colors.grey,
)
```

优点：简单、声明式、不需要手动 controller、生命周期由组件内部管理
缺点：控制能力弱，不方便暂停/反向/串联，不适合手势驱动

**显式动画**：`AnimationController` + `Animation` + `Tween`

优点：可控性强，可暂停/反向/重复/跳转，可配合手势和物理模拟，可做复杂编排
缺点：代码更多，必须管理生命周期，容易忘记 dispose

### 选型原则

| 场景 | 推荐 | 原因 |
|---|---|---|
| 单个属性从 A 到 B，没有控制需求 | 隐式动画 | 代码更短，不必自己管理控制器 |
| 需要暂停、反向、循环、分段播放 | 显式动画 | 时间轴要自己控制 |
| 需要跟手势/拖拽联动 | 显式动画 | 你要能接管进度 |
| 多个属性共享同一时间轴 | 显式动画 | 一个 controller 驱动多个 Tween |
| 只想让某个局部值变化时重建 | `ValueListenableBuilder` | 不必引入完整动画链路 |
| 高性能绘制动画 | controller + CustomPainter | 跳过 widget build |

**显式动画的价值不是"能写更多代码"，而是"动画状态被你掌握"。** 一旦页面里有拖拽、手势驱动、分阶段进入、同一条时间轴同时驱动多个属性，这个差异就会变得很明显。

---

## 18. AnimationController 与状态管理（GetX / Riverpod / BLoC）

### 核心原则

`AnimationController` 需要 vsync，vsync 来自 State，说明它是 **UI 生命周期对象**。

```text
业务状态（是否点赞、当前 tab）→ 放在 GetX / Riverpod / BLoC
动画控制器 → 放在 State
```

### 不推荐的做法

```dart
class MyController extends GetxController {
  late AnimationController animationController; // 不推荐
}
```

AnimationController 和 Widget tree、TickerMode、页面生命周期强相关，不适合随意放入全局单例或业务 Controller。

### 推荐的做法

业务状态和动画分离：

```dart
// 业务状态层
class LikeController extends GetxController {
  final liked = false.obs;
  void toggle() => liked.value = !liked.value;
}

// 动画层放在 Widget State
class LikeViewState extends State<LikeView> with SingleTickerProviderStateMixin {
  late final AnimationController animationController;

  @override
  void initState() {
    super.initState();
    animationController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 260),
    );
  }

  @override
  void dispose() {
    animationController.dispose();
    super.dispose();
  }
}
```

### 什么时候可以把 controller 放到外部

可以，但要满足条件：
1. 外部对象生命周期和页面严格绑定
2. 能安全传入 TickerProvider
3. 能保证 dispose 时机
4. 团队明确这种架构约束

---

## 19. 生命周期与常见报错

### 生命周期标准流程

```text
State.initState
    ↓ 创建 AnimationController
    ↓ 创建 Tween / CurvedAnimation
    ↓ forward / repeat / reverse
    ↓ 动画运行中每帧通知 listener
    ↓ 页面销毁
    ↓ controller.dispose()
    ↓ State.dispose()
```

### 为什么必须在 initState 创建

如果在 build 里创建 controller，每次 build 都会产生新 controller，老 controller 未释放，导致内存泄漏、Ticker 泄漏、动画状态丢失。

### 为什么必须 dispose

AnimationController 内部持有 Ticker。不 dispose 的话，Ticker 可能继续被调度，debug 下会报错。

dispose 顺序：先释放自己创建的 controller，再调用 `super.dispose()`。

### 常见报错与根因

**① "... was disposed with an active Ticker"**

实际报错形如 `_MyPageState#00000(❤️) was disposed with an active Ticker.`，来自 TickerProviderStateMixin / SingleTickerProviderStateMixin 的 dispose 检查。

原因：controller 没有 dispose / dispose 顺序错（super.dispose() 之后才释放 controller）/ 延迟任务触发动画但 State 已销毁

解决：确保在 `super.dispose()` 之前释放 controller，异步回调前检查 `mounted`

**② SingleTickerProviderStateMixin can only be used as a TickerProvider once**

原因：用了 Single mixin 却创建了多个 controller

解决：换成 `TickerProviderStateMixin`

**③ setState() called after dispose()**

原因：异步延迟动画没检查 mounted

```dart
// 错误
Future.delayed(const Duration(seconds: 1), () {
  setState(() {});
});

// 正确
Future.delayed(const Duration(seconds: 1), () {
  if (!mounted) return;
  setState(() {});
});
```

**④ AnimationController.forward() called after dispose()**

原因：controller 已释放后又被调用（网络请求回来、Stream 回调、页面 pop 后事件仍传回）

解决：异步回调前检查 `mounted`，并在 dispose 中取消外部订阅

**⑤ 动画不动**

排查顺序：
1. 有没有调用 `forward()`
2. duration 是否为 null
3. controller value 是不是已经在 upperBound
4. TickerMode 是否 disabled
5. UI 是否在监听 animation（AnimatedBuilder 的 animation 参数有没有传）

调试方法：`print(_controller.value)` 和 `print(_controller.status)`

### didUpdateWidget 里处理动画参数更新

当动画参数来自父组件、父组件可能更新参数时，需要在 didUpdateWidget 里同步 controller：

```dart
@override
void didUpdateWidget(covariant ProgressBar oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.progress != widget.progress) {
    animation = Tween<double>(
      begin: oldWidget.progress,
      end: widget.progress,
    ).animate(CurvedAnimation(parent: controller, curve: Curves.easeOut));
    controller.forward(from: 0);
  }
}
```

关键：controller 只创建一次，Tween 可以在参数变化时重建。

---

## 20. 性能优化要点

动画性能问题通常不在 AnimationController 本身，而在每帧触发后你做了什么。

### 避免每帧重建大子树

```dart
// 不推荐：整个页面每帧 rebuild
controller.addListener(() { setState(() {}); });

// 推荐：只重建动画相关部分
AnimatedBuilder(
  animation: controller,
  child: const HeavyWidget(),  // 静态子树
  builder: (context, child) => Transform.scale(scale: controller.value, child: child),
)
```

### 优先用 Transition Widget

FadeTransition、ScaleTransition、SlideTransition、RotationTransition 等已经封装了动画监听逻辑，比自己写 AnimatedBuilder 更简洁。

### 注意 Opacity 的成本

Opacity 某些情况会触发离屏缓冲（saveLayer）。简单组件可以接受，大面积复杂透明动画要注意。替代思路：FadeTransition、缩小透明动画区域、加 RepaintBoundary。

### 动画期间不做重计算

```dart
// 错误：每帧都重算
AnimatedBuilder(
  animation: _controller,
  builder: (context, child) {
    final data = heavyCalculate();  // 不要这样
    return Chart(data: data);
  },
)
```

### 管理大量循环动画的可见性

```dart
// 用 TickerMode 控制子树动画
TickerMode(
  enabled: isCurrentTab,
  child: child,
)
```

列表里很多 item 都有循环动画时，要考虑：
- 滑出屏幕后是否暂停
- 页面切后台是否暂停
- 是否可以合并为一个全局 controller

---

## 21. 源码阅读路线

如果想深入源码，建议按这个顺序：

### 第一层：Animation 抽象

看 `Animation<T>`、`Listenable`、`AnimationStatus`。理解 Animation 是可监听值，不知道 UI，有 value 和 status。

### 第二层：AnimationController

看 `forward`、`reverse`、`repeat`、`animateTo`、`fling`、`_tick`。理解 controller 如何启动 ticker、如何根据 elapsed 更新 value、如何 notifyListeners。

### 第三层：Ticker

看 `start`、`stop`、`scheduleTick`、`_tick`、`muted`。理解 Ticker 如何注册 frame callback、如何避免重复调度、muted 后如何表现。

### 第四层：TickerProvider mixin

看 `SingleTickerProviderStateMixin`、`TickerProviderStateMixin`。理解 State 如何创建 ticker、TickerMode 如何影响 ticker。

### 第五层：SchedulerBinding

看 `scheduleFrameCallback`、`handleBeginFrame`、`handleDrawFrame`。理解 Flutter 如何接收 engine 的 frame 信号、transient callback 是什么、animation tick 在 frame pipeline 的哪个阶段执行。

源码位置（也可在 [flutter/flutter 仓库](https://github.com/flutter/flutter/tree/main/packages/flutter/lib/src/animation) 在线阅读）：
```
packages/flutter/lib/src/animation/
packages/flutter/lib/src/scheduler/ticker.dart
packages/flutter/lib/src/widgets/ticker_provider.dart
```

---

## 22. 一句话记忆

> **Ticker 跟着帧走，AnimationController 跟着时间算值，Curve 调整节奏，Tween 把进度翻译成业务值，AnimatedBuilder 只重建该重建的部分。**

如果你记住了这条链路和每个角色的分工，Flutter 显式动画就不再神秘。
