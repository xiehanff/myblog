# 57 RefreshIndicator：material 层的下拉刷新状态机

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/material/refresh_indicator.dart`（709 行）；本文另引用 `packages/flutter/lib/src/widgets/scroll_notification.dart`、`packages/flutter/lib/src/widgets/notification_listener.dart`、`packages/flutter/lib/src/widgets/scroll_activity.dart`、`packages/flutter/lib/src/widgets/scroll_position.dart`、`packages/flutter/lib/src/material/progress_indicator.dart`

## 一、问题

一句话问题：圆环明明已经被拉出来了，为什么一松手它又缩回去，`onRefresh` 一次都没跑？

先拆掉两个最自然、也最耽误事的错误直觉。

**直觉一：`RefreshIndicator` 自己识别下拉手势。** 它会跟着手指动、随拖动变大变小，看起来就是个手势驱动的控件。但在整个 `refresh_indicator.dart` 里找不到任何一个 `GestureRecognizer`、`onPanUpdate`、`ScrollActivity` 或 `ScrollPhysics`。真实结构只有一个：`RefreshIndicator` 在 build 时把自己包在 `child` 外面，并在 `child` **内侧**插了一层监听器。

```dart
// refresh_indicator.dart:619-620
final Widget child = NotificationListener<ScrollNotification>(
  onNotification: _handleScrollNotification,
```

滚动这件事从头到尾由 `Scrollable` / `ScrollPosition` / `ScrollActivity` 完成（第 45、46 篇），`RefreshIndicator` 只是坐在通知向上冒泡的路径上收集结果。

**直觉二：下拉刷新距离由 `displacement` 决定。** 于是"`displacement` 调小一点就更容易触发"成了最常见的误用。源码给出的答案相反：`_checkDragOffset` 里没有任何一处读 `widget.displacement`，触发阈值用的是

```dart
// refresh_indicator.dart:519
double newValue = _dragOffset! / (containerExtent * _kDragContainerExtentPercentage);
```

`containerExtent` 来自通知里的 `notification.metrics.viewportDimension`，比例常量 `_kDragContainerExtentPercentage` 是 `0.25`（`material/refresh_indicator.dart:21`）。而 `displacement` 在整文件里只被使用了两次，全在 build 的布局代码里：

```dart
// refresh_indicator.dart:654-655
? EdgeInsets.only(top: widget.displacement)
: EdgeInsets.only(bottom: widget.displacement),
```

它决定的是"刷新中圆环最后停在哪"，不是"拉多远才算数"。

### 源码给出的真实分工

把两条直觉合起来看，`RefreshIndicator` 的角色很朴素：

> **`RefreshIndicator` 不产生滚动，也不识别手势；它是插在 scrollable 与其外祖先之间的一层通知消费者，把 `ScrollUpdateNotification` / `OverscrollNotification` 里的位移累积成私有量 `_dragOffset`，再用它驱动一个 0→1 的位置动画和一个六状态的小状态机。**

两个边界条件顺便在这里记下，它们不由这里的算法决定，而由滚动侧决定：

- 只能用于垂直方向：`_start` 对 `AxisDirection.left` / `right` 直接 `return false`（`material/refresh_indicator.dart:505-509`），类文档也写明 "A `RefreshIndicator` can only be used with a vertical scroll view."（`:126`）。
- 内容不超出视口就拉不出来：Troubleshooting 一节的原话是"无论内容是否放得下都想让它出现，就把 physics 设成 `AlwaysScrollableScrollPhysics`"（`:111-121`）。原因在第 46 篇：没有可越界空间，就没有 `OverscrollNotification` 可发。

## 二、最小 Demo

### 2.1 最小可运行版本

```dart
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: RefreshIndicator(
        // 1. 刷新动作：返回的 Future 完成之前，指示器会一直转
        onRefresh: () async {
          await Future<void>.delayed(const Duration(seconds: 2));
        },
        // 2. child 必须自带一个垂直 Scrollable；RefreshIndicator 自己不创建它
        child: ListView.builder(
          // 3. 内容不足一屏时，靠 physics 强制留下可越界的空间
          physics: const AlwaysScrollableScrollPhysics(),
          itemCount: 30,
          itemBuilder: (BuildContext context, int index) => ListTile(title: Text('item $index')),
        ),
      ),
    ),
  );
}
```

配置项只有这些：`onRefresh` 给刷新动作，`child` 给滚动内容，`physics` 决定能不能越界。其余默认值是 `displacement = 40.0`（`:151`）、`edgeOffset = 0.0`（`:152`）、`triggerMode = RefreshIndicatorTriggerMode.onEdge`（`:160`）、`notificationPredicate = defaultScrollNotificationPredicate`（`:156`）。

注意 `RefreshIndicator` 的定位：**它包在 `ListView` 外面，但监听器插在 `ListView` 里面**。所以包住的永远是"一个已经能滚动的 child"，而不是"一个需要被赋予滚动能力的容器"。

### 2.2 可观察版本

要看状态机的每次切换，得把 `onStatusChange` 露出来。可它只在 `RefreshIndicator.noSpinner` 这个构造上公开——普通构造和 `RefreshIndicator.adaptive` 都写死 `onStatusChange = null`（`:164` / `:198`）：

```dart
class ObservableDemo extends StatefulWidget {
  const ObservableDemo({super.key});

  @override
  State<ObservableDemo> createState() => _ObservableDemoState();
}

class _ObservableDemoState extends State<ObservableDemo> {
  @override
  Widget build(BuildContext context) => Scaffold(
    body: RefreshIndicator.noSpinner(
      // 1. noSpinner 是唯一暴露 onStatusChange 的构造（:205-212）
      onStatusChange: (RefreshIndicatorStatus? status) => debugPrint('[58] status=$status'),
      onRefresh: () async {
        debugPrint('[58] onRefresh 被调用');
        await Future<void>.delayed(const Duration(seconds: 1));
      },
      child: ListView.builder(
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: 30,
        itemBuilder: (BuildContext context, int index) => ListTile(title: Text('item $index')),
      ),
    ),
  );
}
```

noSpinner 构造把 `displacement` / `edgeOffset` / `color` / `backgroundColor` / `strokeWidth` 全部写死（`:219-223`）：没有圆环可停靠，它只关心"拖够了没有"，所以 `[58] status=...` 更能看清状态机；要看圆环位置就换回普通构造。

## 三、入口锚点

| 锚点 | 职责 |
|---|---|
| `material/refresh_indicator.dart:21` | `_kDragContainerExtentPercentage = 0.25`：触发阈值的唯一比例常量 |
| `material/refresh_indicator.dart:25` / `:29` | `_kDragSizeFactorLimit = 1.5`：位置因子上限，同时是 snap 目标的分母；`_kIndicatorSnapDuration = 150ms` |
| `material/refresh_indicator.dart:44` / `:65` | `RefreshIndicatorStatus`（drag / armed / snap / refresh / done / canceled）与 `RefreshIndicatorTriggerMode`（anywhere / onEdge） |
| `material/refresh_indicator.dart:138` / `:151` / `:160` | `RefreshIndicator` 本体与两个关键默认值：`displacement = 40.0`、`triggerMode = onEdge` |
| `material/refresh_indicator.dart:325` / `:337` | `RefreshIndicatorState` 与 `_dragOffset`：状态量只有这一处来源 |
| `material/refresh_indicator.dart:405` / `:421` | `_shouldStart`（起始条件）与 `_handleScrollNotification`（通知总入口，返回值恒为 false） |
| `material/refresh_indicator.dart:497` / `:517` | `_start`（复位 `_dragOffset` 与位置动画）与 `_checkDragOffset`（阈值算法在 `:519`） |
| `material/refresh_indicator.dart:532` / `:562` / `:605` | `_dismiss`（收起）、`_show`（snap→refresh）、公开的 `show({atTop})` |
| `material/refresh_indicator.dart:619-620` / `:621-622` | 两个 `NotificationListener`：外层听 `ScrollNotification`，内层听 `OverscrollIndicatorNotification` |

## 四、调用链

### 4.1 第 0 跳：通知从 `ScrollPosition` 发出，起点是 `Scrollable`

滚动侧每次位置变化，`ScrollPosition` 都会调用自己的四个 `didXxx`（`widgets/scroll_position.dart:1041` / `:1046` / `:1053` / `:1064`），它们把活转给当前 activity，再由 activity dispatch 出去：

```dart
// scroll_position.dart:1064-1067
void didOverscrollBy(double value) {
  assert(activity!.isScrolling);
  activity!.dispatchOverscrollNotification(copyWith(), context.notificationContext!, value);
}
```

`context.notificationContext` 就是那个 `Scrollable` 的 Element。**通知从 `Scrollable` 的位置开始往上冒，不是从 `RefreshIndicator` 往下传。** 这是理解后面一切的前提，也解释了为什么监听器必须插在 `child` 内侧。

### 4.2 第 1 跳：冒泡机制，以及"会不会被截断"

`Notification.dispatch` 只有一句 `target?.dispatchNotification(this)`（`widgets/notification_listener.dart:67-68`），真正的遍历在 `framework.dart`：

```dart
// widgets/framework.dart:3494-3498
void dispatchNotification(Notification notification) {
  if (current?.onNotification(notification) ?? true) {
    return;   // 返回 true 就终止冒泡
  }
  parent?.dispatchNotification(notification);
}
```

规则是：从 dispatch 的起点开始逐级问祖先 Element，任何一个节点返回 true 就立刻停下。`NotificationListener` 的元素实现是：

```dart
// notification_listener.dart:132-136
bool onNotification(Notification notification) {
  final listener = widget as NotificationListener<T>;
  if (listener.onNotification != null && notification is T) {
    return listener.onNotification!(notification);
  }
  return false;
}
```

`RefreshIndicator` 用 `NotificationListener<ScrollNotification>` 接住这个类型（`refresh_indicator.dart:619-620`），而它的 handler 结尾是 `return false`（`:483`）。**所以内置监听器不会截断任何通知**，`RefreshIndicator` 之外的祖先（比如你自己在外层套的监听器）照样能收到完整序列。

这里有个容易混淆的邻居：紧贴内层还有 `NotificationListener<OverscrollIndicatorNotification>`（`:621-622`），管的是 Material 的边缘辉光。`_handleIndicatorNotification` 在拖动期间会调 `notification.disallowIndicator()` 并**返回 true**（`:486-495`）。它拦的是辉光而不是 `ScrollNotification`；把 `:622` 当成 `ScrollNotification` 的监听点是最常见的锚点错误。

### 4.3 第 2 跳：过滤 —— `notificationPredicate` 与 `_shouldStart`

`_handleScrollNotification` 做的第一件事是谓词过滤：

```dart
// refresh_indicator.dart:421-424
bool _handleScrollNotification(ScrollNotification notification) {
  if (!widget.notificationPredicate(notification)) {
    return false;
  }
```

默认谓词只有一行 `return notification.depth == 0;`（`widgets/scroll_notification.dart:372-374`）。`depth` 由 `ViewportElementMixin.onNotification` 每经过一个 viewport 就 `+1`（`widgets/scroll_notification.dart:52-56`）。所以 `depth == 0` 的含义是"这个通知还没穿过任何 viewport"，也就是本层滚动。嵌在 `NestedScrollView` 里时，内层列表的通知会先穿过外层 viewport 使 `depth` 变成 1，默认谓词就会把它挡掉——这正是 `notificationPredicate` 这个参数存在的理由（`refresh_indicator.dart:276-281`）。

过滤之后进入起始判定：

```dart
// refresh_indicator.dart:405-418（节选）
bool _shouldStart(ScrollNotification notification) {
  return ((notification is ScrollStartNotification && notification.dragDetails != null) ||
          (notification is ScrollUpdateNotification &&
              notification.dragDetails != null &&
              widget.triggerMode == RefreshIndicatorTriggerMode.anywhere)) &&
      ((notification.metrics.axisDirection == AxisDirection.up &&
              notification.metrics.extentAfter == 0.0) ||
          (notification.metrics.axisDirection == AxisDirection.down &&
              notification.metrics.extentBefore == 0.0)) &&
      _status == null &&
      _start(notification.metrics.axisDirection);
}
```

四个条件同时成立才启动，缺一不可：

1. **必须是人手拖动**：`dragDetails != null`。`ScrollController.jumpTo` 或惯性滚动发出的通知 `dragDetails` 是 null（源码注释在 `:406-408`），一开始就被排除；而 `ScrollDragActivity` 派发 `ScrollStartNotification` 时会断言 `dragDetails` 一定是 `DragStartDetails`（`widgets/scroll_activity.dart:484-491`）。
2. **必须处于 leading edge**：向下滚的列表要求 `extentBefore == 0.0`（已经到顶），向上滚的要求 `extentAfter == 0.0`（已经到底）。注意这个条件是对**每一条通知各自的 metrics 快照**求值，而不是只在起手时判一次——这正是 `triggerMode` 差异的前提。
3. **只在空闲时启动一次**：`_status == null`。
4. **`_start` 必须返回 true**：垂直方向才返回 true，并顺手把 `_dragOffset = 0.0`、`_scaleController.value = 0.0`、`_positionController.value = 0.0` 复位（`:511-513`）。

启动成功后进入 `drag`：

```dart
// refresh_indicator.dart:425-430
if (_shouldStart(notification)) {
  setState(() {
    _status = RefreshIndicatorStatus.drag;
    widget.onStatusChange?.call(_status);
  });
  return false;
}
```

**`triggerMode` 的差别只落在第 1 个条件里。** `onEdge`（默认）只允许 `ScrollStartNotification` 启动，即必须在起手那一瞬间就已经在 leading edge；`anywhere` 额外允许 `ScrollUpdateNotification` 启动，即拖动过程中列表到达 leading edge 也算。两种模式的第 2 个条件完全相同——所以 `anywhere` 是"允许在拖动中途补上边界条件"，而不是"从任意位置立即生效"，第六节实验 2 会把这一点打出来。

### 4.4 第 3 跳：累积 —— `_dragOffset`

拖动期间两种通知都会累积 `_dragOffset`，代码结构完全对称：

```dart
// refresh_indicator.dart:440-447（节选）
} else if (notification is ScrollUpdateNotification) {
  if (_status == RefreshIndicatorStatus.drag || _status == RefreshIndicatorStatus.armed) {
    if (notification.metrics.axisDirection == AxisDirection.down) {
      _dragOffset = _dragOffset! - notification.scrollDelta!;
    } else if (notification.metrics.axisDirection == AxisDirection.up) {
      _dragOffset = _dragOffset! + notification.scrollDelta!;
    }
    _checkDragOffset(notification.metrics.viewportDimension);
```

```dart
// refresh_indicator.dart:455-462（节选）
} else if (notification is OverscrollNotification) {
  if (_status == RefreshIndicatorStatus.drag || _status == RefreshIndicatorStatus.armed) {
    if (notification.metrics.axisDirection == AxisDirection.down) {
      _dragOffset = _dragOffset! - notification.overscroll;
    } else if (notification.metrics.axisDirection == AxisDirection.up) {
      _dragOffset = _dragOffset! + notification.overscroll;
    }
    _checkDragOffset(notification.metrics.viewportDimension);
```

三条要点：

- 两种通知带的是不同的量：`ScrollUpdateNotification` 用 `scrollDelta`（实际移动量），`OverscrollNotification` 用 `overscroll`（被边界拦下的量）。平台物理不同，走的路径也不同：`ClampingScrollPhysics` 会把超出部分拦下来发 `OverscrollNotification`；`BouncingScrollPhysics` 允许越界，于是走 `scrollDelta` 为负的 `ScrollUpdateNotification`。两条路进同一个累加器，所以 `RefreshIndicator` 不需要知道平台差异。
- **只有 `drag` / `armed` 两个状态才累加。** 惯性滚动期间 `BallisticScrollActivity` 也会发 `OverscrollNotification`（`widgets/scroll_activity.dart:646-657`），但那时 `_status` 是 null，直接被这一层挡掉。
- 每一步都立刻调 `_checkDragOffset(notification.metrics.viewportDimension)`——**阈值算的是 viewport 高度，不是手指位移**。

### 4.5 第 4 跳：阈值 —— `_checkDragOffset` 与 armed

```dart
// refresh_indicator.dart:517-529
void _checkDragOffset(double containerExtent) {
  assert(_status == RefreshIndicatorStatus.drag || _status == RefreshIndicatorStatus.armed);
  double newValue = _dragOffset! / (containerExtent * _kDragContainerExtentPercentage);
  if (_status == RefreshIndicatorStatus.armed) {
    newValue = math.max(newValue, 1.0 / _kDragSizeFactorLimit);
  }
  _positionController.value = clampDouble(newValue, 0.0, 1.0); // This triggers various rebuilds.
  if (_status == RefreshIndicatorStatus.drag &&
      _valueColor.value!.alpha == _effectiveValueColor.alpha) {
    _status = RefreshIndicatorStatus.armed;
    widget.onStatusChange?.call(_status);
  }
}
```

这段是整个组件的核心，读懂它要抓住"一个量、两条线"。

**一个量：`_positionController.value`。** 它被夹在 `[0, 1]`，同时驱动三样东西——`_positionFactor`（`_kDragSizeFactorLimitTween`，0→1.5，`:354`）、`_value`（`_threeQuarterTween`，0→0.75，`:357`）、`_valueColor`（透明度渐变，`:387-401`）。指示器的大小、进度值、颜色深浅都是这同一个值的不同映射。

**第一条线（armed）**：`_valueColor.value!.alpha == _effectiveValueColor.alpha`。颜色的 tween 是 `ColorTween(...).chain(CurveTween(curve: Interval(0.0, 1.0 / _kDragSizeFactorLimit)))`（`:400`），也就是位置值到 `1/1.5 ≈ 0.667` 时颜色才完全不透明。代入阈值公式，armed 的门槛是 `_dragOffset >= 0.667 × 0.25 × viewportDimension ≈ viewportDimension / 6`。**armed 的含义只是"圆环已经不透明了"**，枚举注释写得很直白："Dragged far enough that an up event will run the onRefresh callback."（`:48-49`）。

**第二条线（可以刷新）**：`_positionController.value` 达到 `1.0`，也就是 `_dragOffset >= viewportDimension × 0.25`。

> `0.25` 是"有效释放距离"的比例，`1.5` 是"视觉拖拽上限"的比例，两个数不能混。`0.25` 只出现在 `_checkDragOffset` 的除法里（`:519`）；`1.5` 只出现在两处——`_positionFactor` 的上限（`_positionController.value` 被夹在 1.0，乘上因子后可视上限就是 1.5），以及 armed 之后对 `newValue` 的下限保护（`:520-522`，防止拖动中值回落导致圆环缩小）。

`1.5` 还决定 snap 目标：`_show` 里 `animateTo(1.0 / _kDragSizeFactorLimit)`（`:569-571`），位置值停在 `1/1.5`，乘上因子后 `sizeFactor` 正好是 1.0——圆环从"被拖出来的高度"收回标准尺寸，再由 `Padding(top: widget.displacement)` 决定它停在离顶边 40 逻辑像素处。**这就是 `displacement` 的全部作用。** 静态注释也把这条写死了："max displacement = _kDragSizeFactorLimit * displacement"（`:23-25`）。

顺带一个边界：如果 `color` 的 alpha 是 0，`_setupColorTween` 会退化成 `AlwaysStoppedAnimation`（`:391-393`），两个 alpha 都是 0，armed 会在第一次 `_checkDragOffset` 时立刻成立。它只影响 armed 这个中间状态，动不了第二条线的判定。

### 4.6 第 5 跳：松手 —— 两道门

```dart
// refresh_indicator.dart:464-471（节选）
} else if (notification is ScrollEndNotification) {
  switch (_status) {
    case RefreshIndicatorStatus.armed:
      if (_positionController.value < 1.0) {
        _dismiss(RefreshIndicatorStatus.canceled);
      } else {
        _show();
```

松手发出的 `ScrollEndNotification` 是唯一的分叉点，而 armed 之后**还有第二道门**：`_positionController.value < 1.0` 一样要缩回去。这正是开篇那个现象的来源——圆环可见（已 armed）和松手真的刷新（`value >= 1.0`）是两个不同门槛，前者约在 viewport 的 1/6 处，后者在 1/4 处。

还有两个次要分支：

- **iOS 弹回**：armed 状态下如果收到 `dragDetails == null` 的 `ScrollUpdateNotification`，会直接 `_show()`（`:449-453`）。源码注释说明这是回弹路径——它不是手势直接驱动的，但此时已经 armed，就顺势进入刷新。
- **方向翻转**：拖动中途 `axisDirection` 变化会让 `_isIndicatorAtTop` 变化，于是立刻 `_dismiss(canceled)`（`:432-439`）。

### 4.7 第 6 跳：`_show` → snap → refresh → done

```dart
// refresh_indicator.dart:562-585（节选）
void _show() {
  assert(_status != RefreshIndicatorStatus.refresh);
  assert(_status != RefreshIndicatorStatus.snap);
  final completer = Completer<void>();
  _pendingRefreshFuture = completer.future;
  _status = RefreshIndicatorStatus.snap;
  widget.onStatusChange?.call(_status);
  _positionController
      .animateTo(1.0 / _kDragSizeFactorLimit, duration: _kIndicatorSnapDuration)
      .then<void>((void value) {
        if (mounted && _status == RefreshIndicatorStatus.snap) {
          setState(() {
            // Show the indeterminate progress indicator.
            _status = RefreshIndicatorStatus.refresh;
          });
          final Future<void> refreshResult = widget.onRefresh();
          refreshResult.whenComplete(() {
            if (mounted && _status == RefreshIndicatorStatus.refresh) {
              completer.complete();
              _dismiss(RefreshIndicatorStatus.done);
            }
          });
        }
      });
}
```

顺序是死的，而且是**串行**的：

1. `snap`：先把位置动画到 `1/1.5`，时长 `_kIndicatorSnapDuration = 150ms`（`:29`）。这 150ms 里 `onRefresh` 还没被调用。
2. `refresh`：动画结束、`mounted` 且状态仍是 `snap` 时才调 `widget.onRefresh()`（`:578`），进度环同时切成不确定态（`showIndeterminateIndicator`，`:637-638`）。
3. `done`：`onRefresh` 返回的 Future 完成后 `_dismiss(done)`（`:581-582`）。

`_dismiss` 负责真正的收起，它的参数只有两种合法值：

```dart
// refresh_indicator.dart:532-559（节选）
Future<void> _dismiss(RefreshIndicatorStatus newMode) async {
  await Future<void>.value();
  assert(newMode == RefreshIndicatorStatus.canceled || newMode == RefreshIndicatorStatus.done);
  setState(() {
    _status = newMode;
    widget.onStatusChange?.call(_status);
  });
  switch (_status!) {
    case RefreshIndicatorStatus.done:
      await _scaleController.animateTo(1.0, duration: _kIndicatorScaleDuration);
    case RefreshIndicatorStatus.canceled:
      await _positionController.animateTo(0.0, duration: _kIndicatorScaleDuration);
    ...
  if (mounted && _status == newMode) {
    _dragOffset = null;
    _isIndicatorAtTop = null;
    setState(() {
      _status = null;
    });
  }
}
```

两条收起路径用的是**不同的动画**：`done` 动画 `_scaleController`（`_scaleFactor` 走 `_oneToZeroTween`，缩放着淡出），`canceled` 动画 `_positionController`（位置归零，圆环缩回去）。两者时长都是 `_kIndicatorScaleDuration = 200ms`（`:33`）。而开头那一行 `await Future<void>.value()` 是刻意的让步：把重置推迟一拍，避免在 `ScrollEndNotification` 的分发过程中嵌套 `setState`。

三个状态量在 `_status` 归 null 的同时一起清空，build 里那段 assert 就是在守这条不变式——**`_status` 非空时 `_dragOffset` 与 `_isIndicatorAtTop` 必须同时非空**（`:626-635`）。

### 4.8 第 7 跳：程序化的 `show()`

```dart
// refresh_indicator.dart:605-613
Future<void> show({bool atTop = true}) {
  if (_status != RefreshIndicatorStatus.refresh && _status != RefreshIndicatorStatus.snap) {
    if (_status == null) {
      _start(atTop ? AxisDirection.down : AxisDirection.up);
    }
    _show();
  }
  return _pendingRefreshFuture;
}
```

它跳过"累积位移"这件事，直接把状态机推到 `snap`：

- 当前是 `null` 就先 `_start` 复位三个状态量；当前已经处于 `drag` / `armed` 就沿用现有状态直接 `_show()`；
- 当前正在 `refresh` 或 `snap` 时**什么都不做，静默返回同一个 Future**——这是文档里 "If this method is called while the refresh callback is running, it quietly does nothing." 的实现（`:590-591`）；
- 它与任何真实 Scrollable 无关，`atTop` 只决定指示器挂上边还是下边（`:602-604`）。

返回值的语义也要注意：`_pendingRefreshFuture` 是 `_show` 里那个 completer 的 future，它在 `onRefresh` 的 Future 完成后、`_dismiss` 之前被 `completer.complete()` 触发（`:581`），**不等收起动画结束**。所以 `await state.show()` 之后圆环可能还在淡出。

## 五、核心对象：`RefreshIndicator` vs `RefreshIndicatorState`

| | `RefreshIndicator` | `RefreshIndicatorState` |
|---|---|---|
| 声明位置 | `material/refresh_indicator.dart:138` | `material/refresh_indicator.dart:325` |
| 类型 | `StatefulWidget`（**不可变配置**） | `State<RefreshIndicator> with TickerProviderStateMixin` |
| 持有量 | 只有 `final` 字段：`displacement` / `edgeOffset` / `triggerMode` / `onRefresh` / `child` 等 | `_status`、`_dragOffset`、`_isIndicatorAtTop`、两个 `AnimationController`（`:333-337`） |
| 是否参与判定 | 否，只是被读取的常量 | 是，`_shouldStart` / `_checkDragOffset` 全在这里 |
| 生命周期 | 每次 rebuild 重建也不影响运行状态 | 一个实例贯穿"手势 → 刷新 → 收起"整个周期 |
| 对外入口 | `onRefresh`（拖动触发）；`onStatusChange` 只有 noSpinner 构造有 | `show({atTop})`（程序化触发，`:605`） |

一句话分工：**`RefreshIndicator` 是配置单（下拉多远算数、圆环停在哪、刷新时做什么），`RefreshIndicatorState` 是状态机（现在处于六个状态中的哪一个、累积了多少位移、动画跑到哪）。** 读这份源码时要随时区分这两类字段。

状态量这一侧还有一个必须分开的对比：

| | `_dragOffset` | `displacement` |
|---|---|---|
| 类型 | `double?`，运行时状态 | `final double`，构造配置 |
| 谁写 | `_handleScrollNotification` 从通知里加减累积（`:443` / `:445` / `:458` / `:460`） | 调用方一次给定，`:151` 默认 `40.0` |
| 用途 | 除以 `viewportDimension × 0.25` 得到触发判定（`:519`） | 作为 `Padding` 的 top / bottom（`:654-655`） |
| 归零时机 | `_dismiss` 结束时置 null（`:553`） | 永不变化 |

## 六、源码实验

三组实验只换被测参数，共用的部分先集中写好，下面各段直接引用 `_refresh` / `_list`，差异全部留在配置上：

```dart
// 三组实验共用的刷新动作：返回的 Future 完成前指示器一直转
Future<void> _refresh() async {
  await Future<void>.delayed(const Duration(seconds: 1));
}

// 三组实验共用的滚动内容
final Widget _list = ListView.builder(
  physics: const AlwaysScrollableScrollPhysics(),
  itemCount: 30,
  itemBuilder: (BuildContext context, int index) => ListTile(title: Text('item $index')),
);
```

### 实验 1：监听器放在 `child` 内 vs 放在 `RefreshIndicator` 外

```dart
// 版本 A：放在 child 内部 —— 自建监听器比 RefreshIndicator 内置的离 Scrollable 更近
RefreshIndicator(
  onRefresh: _refresh,
  child: NotificationListener<ScrollNotification>(
    onNotification: (ScrollNotification n) {
      debugPrint('[inside] ${n.runtimeType} depth=${n.depth}');
      return false; // 不截断
    },
    child: ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      itemCount: 30,
      itemBuilder: (BuildContext context, int index) => ListTile(title: Text('item $index')),
    ),
  ),
)

// 版本 B：放在 RefreshIndicator 外层 —— 自建监听器是内置监听器的祖先
NotificationListener<ScrollNotification>(
  onNotification: (ScrollNotification n) {
    debugPrint('[outside] ${n.runtimeType} depth=${n.depth}');
    return false;
  },
  child: RefreshIndicator(
    onRefresh: _refresh,
    child: ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      itemCount: 30,
      itemBuilder: (BuildContext context, int index) => ListTile(title: Text('item $index')),
    ),
  ),
)
```

**预测**：`Notification.dispatch` 从 `Scrollable` 的 context 出发沿祖先链逐级向上（`widgets/framework.dart:3494-3498`）。版本 A 里自建监听器离 `Scrollable` 更近，应该**先于**内置监听器收到；版本 B 里它离得更远，应该**后于**内置监听器收到。

**实际（按源码路径推演）**：每次拖动产生的序列是 `ScrollStartNotification → 若干 ScrollUpdateNotification / OverscrollNotification → ScrollEndNotification`。两个版本都收到完整序列，因为两处 handler 都返回 `false`（内置那处在 `refresh_indicator.dart:483`）。

**说明**：三点。第一，`RefreshIndicator` 无法看到任何它自己"没收到"的通知——它和用户监听器处在同一条冒泡链上，不存在"被截断"。第二，`depth` 全程是 0（普通 `ListView` 只有一层 viewport），这解释了默认谓词为什么够用。第三，这也解释了监听器为什么必须写在 `child` 内侧（`refresh_indicator.dart:619-625`）而不是包在 `RefreshIndicator` 外面：**只有插在 `child` 与其 `Scrollable` 之间，才能接住从 `Scrollable` 冒上来的通知**；包在外面不仅收得更晚，还失去"通知先到我这"的机会。

### 实验 2：`triggerMode: anywhere` 到底多做了什么

```dart
// 同一棵子树，只换 triggerMode，从列表中部（不是顶部）开始向下拖
RefreshIndicator.noSpinner(
  triggerMode: RefreshIndicatorTriggerMode.anywhere, // 换成 onEdge 再跑一次
  onStatusChange: (RefreshIndicatorStatus? s) => debugPrint('[trigger] $s'),
  onRefresh: _refresh,
  child: ListView.builder(
    physics: const AlwaysScrollableScrollPhysics(),
    itemCount: 30,
    itemBuilder: (BuildContext context, int index) => ListTile(title: Text('item $index')),
  ),
)
```

**预测**：如果 `anywhere` 是"从任意位置立即开始刷新"，那从列表中部起手时它应该立刻 armed，甚至直接 refresh。

**实际（按 `_shouldStart` 的四个条件推演，`:405-418`）**：从列表中部（`extentBefore > 0`）起手时，第一个 `ScrollStartNotification` 的 `extentBefore != 0`，**两种模式都不启动**。差别只出现在之后：继续向下拖、列表回到顶部使 `extentBefore` 变成 `0.0` 的那一帧，`onEdge` 已经没有可用起点（`ScrollStartNotification` 早已过去），而 `anywhere` 会拿这个 `ScrollUpdateNotification` 当起点，`_status` 从 null 变成 `drag`。

**说明**：`anywhere` 的语义是"允许在拖动中途补上 leading-edge 条件"，而不是"忽略位置条件"。它的第 1 个条件里依然写着 `triggerMode == RefreshIndicatorTriggerMode.anywhere` 必须与 `ScrollUpdateNotification` 同时命中（`:409-412`），第 2 个条件（`extentBefore == 0.0`）一个字都没放宽。所以它让"先滚到顶、再继续下拉"这类连续动作能被识别，代价是拖动中的 `ScrollUpdateNotification` 也可能成为起点。

### 实验 3：把 `displacement` 改大改小，看阈值变不变

```dart
// 三次运行，其余参数完全一致（viewport 高 600 逻辑像素）
RefreshIndicator(displacement: 10,  onRefresh: _refresh, child: _list) // 运行 1
RefreshIndicator(displacement: 40,  onRefresh: _refresh, child: _list) // 运行 2（默认值）
RefreshIndicator(displacement: 200, onRefresh: _refresh, child: _list) // 运行 3
```

**预测**：如果"下拉刷新距离由 `displacement` 决定"成立，三次的触发距离应该分别接近 10 / 40 / 200 逻辑像素。按第四节的推演，三次的触发阈值应该完全相同，只有圆环停靠位置不同。

**实际（按源码公式代入）**：`_checkDragOffset` 里没有任何一处引用 `widget.displacement`——全文件只有 `:654-655` 两处使用，都在 build 的 `Padding` 里。阈值计算是

```text
触发条件：_positionController.value >= 1.0
      即  _dragOffset >= viewportDimension * 0.25
      取  viewportDimension = 600  ->  _dragOffset >= 150（逻辑像素）

armed 条件：_valueColor 完全不透明，即位置值 >= 1 / 1.5 ≈ 0.667
      即  _dragOffset >= 600 * 0.25 * 0.667 = 100（逻辑像素）
```

**说明**：150 这个数只和 `viewportDimension` 有关，`displacement` 取 10 还是 200 都不动它。三次运行真正的差异在两处：拖动过程中圆环能被拖出的最大偏移是 `displacement × 1.5`（因为 `_positionFactor` 的上限是 1.5，见 `:23-25` 的注释），snap 后的停靠位置是 `displacement`（`:654-655`）。同一组数字也解释了开篇那个体感：拖动量在 100～150 之间时已经是 armed（圆环完全不透明），但松手仍走 `_dismiss(canceled)`。

（这里的 100 / 150 / 600 是按源码公式代入的数值。真机上手指实际移动距离还要经过 physics 的越界变换，所以会略大于 `_dragOffset`。同仓库 `MarkDown笔记/flutter/底层原理/40 Flutter EasyRefresh 源码解读：滚动物理与指示器状态机.md` 给出的 `viewportDimension * 0.25` 结论，与 Flutter 3.44.8 的 `_checkDragOffset`（`material/refresh_indicator.dart:519`）和常量 `:21` 一致。）

## 七、结论

1. `RefreshIndicator` 不实现手势、不实现滚动：它在 build 时把监听器插在 `child` 内侧——外层听 `ScrollNotification`（`refresh_indicator.dart:619-620`），内层听 `OverscrollIndicatorNotification`（`:621-622`）。通知总入口是 `_handleScrollNotification`（`:421`），并且**始终返回 false**（`:483`），不截断冒泡。手势与 activity 属于第 46 篇的主题，这里只追"通知进来之后发生了什么"。
2. 触发阈值来自 viewport，不来自 `displacement`：`_checkDragOffset`（`:517`）用 `_dragOffset / (viewportDimension × 0.25)`（`:519`，常量在 `:21`）驱动 `_positionController`；armed 的视觉门槛是颜色完全不透明（约 viewport 的 1/6），松手后还要过 `_positionController.value < 1.0` 这道门（`:467`）才会 `_show()`，对应 viewport 的 1/4。`displacement` 只出现在 `Padding`（`:654-655`）里，决定圆环停靠位置。
3. 六态串行推进：`drag → armed`（`_checkDragOffset`）→ `snap`（150ms 收拢动画，`:29` / `:569`）→ `refresh`（此时才调 `onRefresh`，`:578`）→ `done` 或 `canceled`（`_dismiss`，`:532`），最后 `_status` / `_dragOffset` / `_isIndicatorAtTop` 一起清空。`show({atTop})`（`:605`）跳过位移累积直接进 `snap`，且在 `refresh` / `snap` 期间静默不重复启动。

**`RefreshIndicator` 是插在 scrollable 内部的 Material 层通知消费者——它把 `ScrollUpdateNotification` / `OverscrollNotification` 累积成 `_dragOffset`，用 `viewportDimension × 0.25` 判定是否够格刷新，用 `displacement` 决定圆环停在哪，两者互不相干。**

## 八、边界声明

- 滚动位置的持有者与 `ScrollController` 的广播角色在第 45 篇；这里只用到"通知从 `ScrollPosition` 的 `context.notificationContext` 发出"这一点（`scroll_position.dart:1041-1067`）。
- `ScrollActivity` / `ScrollPhysics` 的状态机与松手后的衰减在第 46 篇。`ClampingScrollPhysics` 为什么发 `OverscrollNotification`、`BouncingScrollPhysics` 为什么发 `scrollDelta` 为负的 `ScrollUpdateNotification`，这里只作为"两条累加路径"引用，不展开物理公式。
- `viewportDimension` 由 viewport 的几何产生，`SliverConstraints` / `SliverGeometry` 协议在第 47 篇；`ListView.builder` 如何懒加载这些 child 在第 48 篇。
- 通知分发的完整机制（`LayoutChangedNotification`、`Notification.dispatch` 如何找到 `Element`、`NotifiableElementMixin` 的挂载）这里不单独展开，只覆盖 `RefreshIndicator` 用到的部分。
- 手势识别器、`GestureArena`、`DragUpdateDetails` 的产生过程在第 23～25 篇；这里只把 `dragDetails` 当作"这次滚动是否来自手指"的标志位使用。
- 第三方下拉刷新实现（`EasyRefresh` 等）的对照不在本文范围；`底层原理/40` 已从"业务实现 vs 系统实现"的角度比较过，只在实验 3 里把它当作 `0.25` 这个数值的交叉核对。
- `material` 层的抽样下潜在第 51 篇；`RefreshProgressIndicator` 的绘制细节不追，它只是被 `_indicatorType` 选出来的一层壳（`material/progress_indicator.dart:1302`）。
- 没有真机/模拟器运行，第六节三组实验的"实际"部分是按 Flutter 3.44.8 源码的条件与公式推演的结果，100 / 150 这些数值是代入值而非实测读数。
