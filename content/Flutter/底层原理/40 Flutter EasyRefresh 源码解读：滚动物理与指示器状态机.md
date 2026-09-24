# Flutter EasyRefresh 源码解读：滚动物理与指示器状态机

> 对应源码: easy_refresh 3.5.1，官方发布提交 `de53826b004c486b2f176f49cf624d5c2ab45c17`（2026-06-14）
> 核对日期: 2026-08-28；本文结论锁定 easy_refresh 3.5.1，不用 pub.dev `latest` 的内容替代该版本
> 源码边界: 本仓库的 `flutter_doc_test` 未声明 `easy_refresh`，也没有 `lib/widgets/ym_easy_refresh.dart`；文中的三方包摘录来自本机 pub 缓存和官方 3.5.1 发布提交，不能直接在该验证工程中 import
> 关联项目封装（不在本仓库）: `lib/widgets/ym_easy_refresh.dart`
> 前置阅读: [39 NestedScrollView 源码解读](39 Flutter NestedScrollView 源码解读：外层 Header 与内层列表如何协同.md) · 后续案例: [41 刷新闪烁 Bug 排障复盘](41 从下拉刷新闪烁 Bug 到滚动体系：一次 Flutter 排障复盘.md)

EasyRefresh 表面上是一个“下拉刷新、上拉加载”的容器，内部实际做了三件事：

1. 给 ScrollView 注入自定义 `_ERScrollPhysics`；
2. 用 `HeaderNotifier` 和 `FooterNotifier` 记录越界位移与任务状态；
3. 用 Stack 把 Header/Footer 的视觉组件叠加在滚动内容上。

因此，EasyRefresh 的 Bug 往往不是一个 loading widget 的问题，而是滚动物理、异步任务和动画生命周期交叉后的时序问题。

## 本章目标与完成标准

阅读后应当能够：

1. 沿 `EasyRefresh → _ERScrollPhysics → IndicatorNotifier` 画出一次刷新的调用链；
2. 区分 `triggerOffset`、`offset`、`overExtent` 和 `processedDuration` 的职责；
3. 解释 `clamping` Header 为什么可能让指示器移动而列表位置基本不变；
4. 在 `NestedScrollView` 中保留 EasyRefresh Footer，同时把 Header 交给系统 `RefreshIndicator`；
5. 从 Flutter 3.44.8 源码推导系统刷新阈值，说明为什么修改 `displacement` 不会缩短触发距离。

版本证据来自两处：本机 pub 缓存中的包元数据与源码版本为 3.5.1，官方 `v3` 分支的发布提交 `de53826b004c486b2f176f49cf624d5c2ab45c17`（2026-06-14）也明确发布了 `easy_refresh@3.5.1`。当前仓库的 `flutter_doc_test` 没有该依赖，因此不把它的 `pubspec.lock` 或 `.dart_tool/package_config.json` 当作 EasyRefresh 的验证证据。

---

## 一、从公开 API 看到内部结构

`EasyRefresh` 有普通 child 构造和 builder 构造：

下面是删去非核心参数后的简化声明，不是可以直接复制的完整构造函数签名。`childBuilder` 只把最终的 `ScrollPhysics` 交给调用方，源码明确说明这套 physics 不会自动向子树作用域传播。

```dart
EasyRefresh({
  required Widget child,
  Header? header,
  Footer? footer,
  FutureOr Function()? onRefresh,
  FutureOr Function()? onLoad,
});

EasyRefresh.builder({
  required ERChildBuilder childBuilder,
  Header? header,
  Footer? footer,
  FutureOr Function()? onRefresh,
  FutureOr Function()? onLoad,
});
```

普通构造适合单一 ScrollView；`builder` 用于 NestedScrollView 等需要把生成的 physics 显式传给 outer/inner 的场景。`isNested` 只改变 notifier 对 NestedScrollView 坐标的处理，不会替调用方把 physics 接到两个 position 上。

项目封装 `YMEasyRefresh.nested` 做了三件额外工作：

- `isNested: true`
- `triggerAxis: Axis.vertical`
- 在 `childBuilder` 中把传入的 physics 交给 `NestedScrollView` 和内层列表

这三项决定了它不是一个普通的“包裹组件”，而是进入了滚动系统内部。

---

## 二、`_EasyRefreshState` 的初始化

EasyRefresh 的 State 创建两套 notifier：

下面只摘出它们之间的依赖关系，省略了 `EasyRefreshData.userOffsetNotifier`、`onCanRefresh`、`onCanLoad`、`canProcessAfterNoMore` 和等待策略等必需或非核心参数；它是源码阅读片段，不是可直接粘贴的构造代码。

```dart
_data = EasyRefreshData(
  headerNotifier: HeaderNotifier(
    header: _header,
    userOffsetNotifier: userOffsetNotifier,
    vsync: this,
    onRefresh: _onRefresh,
    isNested: widget.isNested,
    triggerAxis: widget.triggerAxis,
  ),
  footerNotifier: FooterNotifier(
    footer: _footer,
    userOffsetNotifier: userOffsetNotifier,
    vsync: this,
    onLoad: widget.onLoad,
    isNested: widget.isNested,
    triggerAxis: widget.triggerAxis,
  ),
);
```

两者共享一个 `userOffsetNotifier`。它不是指针事件的完整状态，而是由 physics 更新的阶段信号：`applyPhysicsToUserOffset` 开始处理用户 delta 时设为 `true`，`createBallisticSimulation` 开始处理释放/回弹时设为 `false`。因此外部 `jumpTo`、`goBallistic(0)` 或 activity 切换也可能改变它观察到的时序：

| 值 | 语义 |
| --- | --- |
| `true` | 当前正在处理用户拖动 delta |
| `false` | 已进入 physics 的释放/ballistic 处理；不等同于“当前一定处于 idle” |

状态机是否立即触发任务、是否进入 ready、是否启动回弹，都依赖这个值。任何外部 `jumpTo`、`goBallistic(0)` 或 activity 切换，都可能改变它观察到的时序。

### Header/Footer 的默认替换

当 `onRefresh == null` 时，EasyRefresh 会先使用显式传入的 `notRefreshHeader`；没有传入时才创建一个复制部分配置的 `NotRefreshHeader`。下面只展示后一个 fallback 分支：

```dart
Header get _header {
  if (widget.onRefresh == null) {
    final h = widget.header ?? EasyRefresh._defaultHeader;
    return NotRefreshHeader(
      clamping: h.clamping,
      position: h.position,
      spring: h.spring,
      frictionFactor: h.frictionFactor,
      hitOver: h.hitOver,
      maxOverOffset: h.maxOverOffset,
    );
  }
  return widget.header ?? EasyRefresh._defaultHeader;
}
```

`NotRefreshHeader` 不构建视觉内容，也没有刷新 task；由于 task 为空，notifier 会保持 `inactive`，`overExtent` 也返回 0。不过它的 `clamping`、`hitOver` 和 `maxOverOffset` 仍会影响 `_ERScrollPhysics` 的边界路径。要实现“只保留上拉加载”，仍要确认 Header 没有 task、没有可见 locator，并观察它对 overscroll 的影响。

---

## 三、`_ERScrollPhysics` 是核心

`_ERScrollPhysics` 继承 `BouncingScrollPhysics`，默认 parent 是 `AlwaysScrollableScrollPhysics`：

```dart
class _ERScrollPhysics extends BouncingScrollPhysics {
  _ERScrollPhysics({
    super.parent = const AlwaysScrollableScrollPhysics(),
    required this.userOffsetNotifier,
    required this.headerNotifier,
    required this.footerNotifier,
  });
}
```

它覆盖了三个决定交互的入口：

- `applyPhysicsToUserOffset`
- `applyBoundaryConditions`
- `createBallisticSimulation`

### 3.1 `applyPhysicsToUserOffset`

用户拖动时，physics 先判断是否已经越界，或者 Header/Footer 是否处于 clamping 越界状态：

`applyPhysicsToUserOffset` 会先把 `userOffsetNotifier` 设为 `true`，再决定是否应用摩擦系数；它返回的是本次手势实际消费的 delta，不是直接写入 `ScrollPosition.pixels`。

```dart
if (!(position.outOfRange ||
      (headerNotifier.clamping && headerNotifier.outOfRange) ||
      (footerNotifier.clamping && footerNotifier.outOfRange))) {
  return offset;
}
```

如果正在越界，就按摩擦系数缩小手指位移；如果 Header 是 clamping 模式，还会把 Header 自己已经消费的位移加回计算坐标：

```dart
if (headerNotifier.clamping && headerNotifier.outOfRange) {
  pixels = position.pixels - headerNotifier._offset;
}
```

这解释了一个视觉现象：Header 在变，列表的 `pixels` 却不一定变。位移被 Header notifier 消费了。

### 3.2 `applyBoundaryConditions`

顶部 `clamping == true` 的分支是关键：

下面只保留命中顶部边界的主分支，实际源码还包含 NestedScrollView 在 `userOffsetNotifier == false` 时的特殊条件。

```dart
if (value < position.minScrollExtent &&
    position.minScrollExtent < position.pixels) {
  _updateIndicatorOffset(position, 0, value);
  return value - position.minScrollExtent;
}
```

`ScrollPosition.setPixels` 会把 physics 返回的 boundary 值从目标值中扣除。因而 `return value - minScrollExtent` 表示这段越界被 physics 接管，实际 `pixels` 仍停在 `minScrollExtent`，随后 `_updateIndicatorOffset` 更新 Header 位移；它不只是一个“收到越界通知”的回调。

当 Header 已经有 offset，且没有进入 modeLocked 时，EasyRefresh 还会继续把变化拦住：

```dart
else if (headerNotifier._offset > 0 &&
         !(headerNotifier.modeLocked || headerNotifier.secondaryLocked)) {
  bounds = value - position.pixels;
}
```

这就是“指示器覆盖在列表上方，但列表没有被推下来”的物理来源。

### 3.3 `createBallisticSimulation`

松手或外部 activity 结束后，EasyRefresh 会先通知 Header/Footer：

```dart
headerNotifier._updateBySimulation(position, velocity);
footerNotifier._updateBySimulation(position, velocity);
```

然后使用组合后的越界范围创建 `BouncingScrollSimulation`：

```dart
simulation = BouncingScrollSimulation(
  spring: spring,
  position: position.pixels,
  velocity: mVelocity,
  leadingExtent: position.minScrollExtent - headerNotifier.overExtent,
  trailingExtent: position.maxScrollExtent + footerNotifier.overExtent,
  tolerance: tolerance,
);
```

`overExtent` 不是对 `ScrollPosition.min/maxScrollExtent` 的永久修改，而是传给 `BouncingScrollSimulation` 的额外 leading/trailing extent。只有存在 task 且满足可处理条件时，它才会返回 `actualTriggerOffset`；典型情况是 `ready`、`processing`/`processed`（`modeLocked`）或启用 `infiniteOffset`。`noMoreLocked` 还要分情况：当 `infiniteOffset == null` 时，getter 会提前返回 0；只有配置了 `infiniteOffset`，它才会进入返回 `actualTriggerOffset` 的分支。`done` 本身不属于 `modeLocked`，不能写成“进入 done 就一定返回触发距离”。

真正创建 simulation 还受 velocity、tolerance、当前位置和 indicator 状态快照等条件控制，文章中的代码只展示了构造参数。

---

## 四、IndicatorNotifier 状态机

Header 和 Footer 共享 `IndicatorNotifier` 的大部分实现。忽略 secondary 功能的 `secondaryArmed/secondaryReady/secondaryOpen/secondaryClosing` 分支后，普通刷新主路径是：

```text
inactive       没有越界
drag           越界但未达到触发距离
armed          达到触发距离, 等待释放
ready          已释放, 准备触发任务
processing     异步任务执行中
processed      任务已完成, 等待结束动画
done           结束动画完成
```

源码比较的是 `actualTriggerOffset`，它等于 `triggerOffset + safeOffset`；开启 safe area 时，屏幕边缘的安全区会计入实际触发距离。

### 4.1 拖动阶段

`_updateOffset` 先计算当前越界位移，再调用 `_updateMode`：

```dart
_offset = _calculateOffset(position, value);
_updateMode(oldOffset);
```

拖动阶段中，`_offset < actualTriggerOffset` 时进入 `drag`；达到或超过阈值且手指仍按住时，未开启 `triggerWhenReach` 会进入 `armed`，开启后会直接进入 `processing`；释放后的等值分支见 4.2。

### 4.2 松手阶段

`userOffsetNotifier` 从 true 变成 false 后，`_updateBySimulation` 会根据 `_releaseOffset` 和 `triggerWhenRelease` 选择：

- `ready`：先回弹到触发距离，再进入 processing
- `processing`：松手立即启动任务
- `done`：`triggerWhenReleaseNoWait` 特殊路径

下面只展示 `_offset > actualTriggerOffset` 且已经释放后的分支；`_updateMode` 外层还会分别处理小于、等于阈值的情况。

源码中的分支：

```dart
if (_releaseOffset > actualTriggerOffset) {
  if (_indicator.triggerWhenReleaseNoWait) {
    Future.sync(_task!);
    _mode = IndicatorMode.done;
  } else if (_indicator.triggerWhenRelease) {
    _mode = IndicatorMode.processing;
  } else {
    _mode = IndicatorMode.ready;
  }
}
```

上面的 `if` 只展示释放位移超过阈值的分支。完整状态判断是：`_offset < actualTriggerOffset` 时通常是 `drag`；恰好等于阈值时，手指仍按住会进入 `armed`（开启 `triggerWhenReach` 时例外），释放后会进入 `processing`；超过阈值但 `_releaseOffset` 没超过阈值时仍保持 `armed`。`triggerWhenReleaseNoWait` 会启动 task 但不等待其 Future，随后直接把 mode 置为 `done`，适用于不需要异步完成通知的场景。

### 4.3 任务完成阶段

当 `_waitTaskResult == true`（默认值）时，`_onTask` 等待刷新或加载 Future：

```dart
final res = await Future.sync(_task!);
if (res is IndicatorResult) {
  _result = res;
} else {
  _result = IndicatorResult.success;
}
_setMode(IndicatorMode.processed);
```

如果 `EasyRefreshController.controlFinishRefresh` 或 `controlFinishLoad` 为 `true`，对应 notifier 的 `_waitTaskResult` 会变为 `false`。这时 `_onTask` 只启动 task，不等待 Future；业务代码必须调用 `finishRefresh`/`finishLoad`，由 `_finishTask` 设置结果并推进到 `processed`。因此“Future 完成后进入 processed”只适用于默认等待路径。

`processed` 并不是“已经收起”。它会等待 `processedDuration`，然后进入 `done`：

```dart
void _scheduleProcessedCompletion(IndicatorMode oldMode) {
  if (processedDuration == Duration.zero) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _completeProcessedMode(oldMode);
    });
    return;
  }
  Future.delayed(processedDuration, () {
    _completeProcessedMode(oldMode);
  });
}
```

`_completeProcessedMode` 会先把 mode 设为 `done`；如果 offset 已经是 0，还会立即进入 `inactive`。只有 `oldMode == processing` 且用户已经释放时，才调用 `_resetBallistic()`，让 ScrollPosition 有机会再次创建收起动画，并非所有完成路径都会无条件调用它。

---

## 五、为什么 `clamping` 容易出时序 Bug

`clamping == true` 时，IndicatorNotifier 会创建一个独立的 `AnimationController`：

```dart
_clampingAnimationController = AnimationController.unbounded(vsync: vsync);
```

动画 tick 中持续根据 ScrollPosition 的 pixels 计算 Header offset：

```dart
final mOffset = calculateOffsetWithPixels(position, controller.value);
_offset = mOffset;
_updateMode();
notifyListeners();
```

`_startClampingAnimation` 又有一个互斥保护：

```dart
if (_offset <= 0 || _clampingAnimationController!.isAnimating) {
  return;
}
```

于是可能出现下面的竞争：

```text
手指松开
  ↓
_updateBySimulation
  ↓
clamping animation A 开始回弹
  ↓
网络请求快速完成
  ↓
processed → done
  ↓
_resetBallistic 尝试启动收起动画 B
  ↓
animation A 仍 isAnimating, B 被 return 掉
  ↓
offset 停在触发距离, 状态无法回到 inactive
```

如果 `processedDuration` 为零，完成态在下一帧就会执行；如果请求又很快完成，A/B 两个动画竞争的时间窗口更大。把 processedDuration 改大或改小只能改变概率，不能消除两个动画控制器之间的竞争。

这类 Bug 的特征通常是：

- 指示器某一帧突然消失
- 屏幕进入一段时间静止
- 下次下拉暂时无法触发
- 再次松手或下一轮滚动后状态“自愈”

---

## 六、NestedScrollView 场景为什么更敏感

在 NestedScrollView 中，EasyRefresh 的 `_ERScrollPhysics` 会被传给 outer 和 inner。Flutter 的 `_NestedScrollCoordinator` 在手势、activity 和 ballistic 阶段同时操作两类 position。

EasyRefresh 通过这两个扩展判断位置：

```dart
bool get isNestedOuter =>
    this is ScrollPosition &&
    (this as ScrollPosition).debugLabel == 'outer';

bool get isNestedInner =>
    this is ScrollPosition &&
    (this as ScrollPosition).debugLabel == 'inner';
```

`isNested` 为 true 时，HeaderNotifier 会根据 outer/inner 的 viewport 和位置选择不同的计算路径。一个外部 `jumpTo` 不只是移动一个列表，NestedScrollCoordinator 可能同时调用 outer 与多个 inner 的 `localJumpTo`，最后再 `goBallistic(0)`。

因此要特别警惕这些操作出现在刷新 Future 期间：

- 列表数据替换
- 依据旧 pixels 的滚动锚定
- Tab 切换后恢复位置
- 动态改变 Header 高度

这些操作都可能让 EasyRefresh 误判“用户已经松手”，或让 clamping 动画重新开始。

---

## 七、Footer-only 模式的正确理解

当页面只希望 EasyRefresh 负责上拉加载时，关键不是把 Header 颜色设透明，而是让 Header 没有刷新任务：

```dart
EasyRefresh.builder(
  isNested: true,
  notRefreshHeader: const NotRefreshHeader(),
  footer: BuilderFooter(
    triggerOffset: 1,
    clamping: false,
    infiniteOffset: 70,
    safeArea: false,
    maxOverOffset: 0,
    builder: (_, __) => const SizedBox(),
  ),
  onLoad: _onLoad,
  childBuilder: (context, physics) => ...,
)
```

`BuilderFooter.position` 在 3.5.1 中是可选参数，默认值为 `IndicatorPosition.above`，因此上面的简化示例可以编译。若要明确表达“Footer 只参与 notifier/physics，不由 EasyRefresh 构建视觉组件”，可以显式设置 `position: IndicatorPosition.custom`；这不会改变 `onLoad` 和 Footer 状态机的职责。

下拉刷新由系统组件处理：

```dart
RefreshIndicator(
  onRefresh: _onRefresh,
  child: NestedScrollView(
    physics: physics,
    ...,
  ),
)
```

系统刷新和 EasyRefresh 的 load notifier 不共用 Header 状态机，但仍共用 NestedScrollView 的滚动物理，所以必须验证：

1. 顶部 overscroll 能被系统 RefreshIndicator 收到；
2. 底部 overscroll 仍能被 EasyRefresh Footer 收到；
3. 刷新后 Footer 的 `noMore` 状态被清理。

EasyRefresh 原本在自己的 `_onRefresh` 中执行：

```dart
if (widget.resetAfterRefresh) {
  _footerNotifier._reset();
}
```

一旦刷新改由系统 RefreshIndicator 触发，这段代码不会执行。项目侧需要保留一个 `EasyRefreshController`，在系统刷新完成后调用：

```dart
_easyRefreshController.resetFooter();
```

这是混合方案容易遗漏的状态同步点。

---

## 八、系统 RefreshIndicator 的阈值为什么仍然很长

拆掉 EasyRefresh Header 后，闪烁消失了，但同城页先后暴露出两个新问题：

1. inner 列表通知在该页面到达外层时 `depth == 2`，系统默认谓词只接受 `depth == 0`，导致指示器和回调不能完整响应；
2. 放开通知后，小距离下拉能看到指示器，松手却只会收回，必须拖很远才调用 `onRefresh`。

第二个问题不能通过减小 `displacement` 解决。Flutter 3.44.8 对它的定义是“刷新中指示器最终停靠的位置”，没有参与触发阈值计算。

### 8.1 触发距离来自 viewportDimension

`refresh_indicator.dart` 中有两个常量：

```dart
const double _kDragContainerExtentPercentage = 0.25;
const double _kDragSizeFactorLimit = 1.5;
```

拖动更新进入 `_checkDragOffset`：

```dart
double newValue =
    _dragOffset! /
    (containerExtent * _kDragContainerExtentPercentage);
_positionController.value = clampDouble(newValue, 0.0, 1.0);
```

指示器在较短距离时就开始显现；继续拖动后会进入 `armed`。松手处理还有第二道检查：

```dart
case RefreshIndicatorStatus.armed:
  if (_positionController.value < 1.0) {
    _dismiss(RefreshIndicatorStatus.canceled);
  } else {
    _show();
  }
```

所以 Flutter 3.44.8 普通 Material `RefreshIndicator` 的有效释放距离由 `viewportDimension * 0.25` 控制。600 逻辑像素高的 viewport 约需累计 150 逻辑像素 `_dragOffset`；圆环提前出现，不代表松手已经可以刷新。这正对应“短拉能看到指示器，但松手收回”的真机现象。

### 8.2 为什么不能改系统私有常量

这些常量和 `_checkDragOffset` 都是 SDK 私有实现。复制整份 `RefreshIndicator` 或修改 Flutter SDK 会带来维护分叉；只调 `edgeOffset`/`displacement` 又改变不了阈值。

项目保留系统绘制、吸附和完成动画，只补一条较短的公开触发路径：

1. `Listener` 记录手指向下的逻辑像素距离；
2. 内层 `NotificationListener` 确认拖动从页面顶部开始；
3. 达到与原 EasyRefresh 一致的 70px 后，在 `ScrollEndNotification` 冒泡到系统监听器之前调用 `RefreshIndicatorState.show()`；
4. `show()` 是 Flutter 公开 API，仍由系统执行 `snap → refresh → done` 和 `onRefresh` Future。

核心结构：

```dart
const refreshTriggerOffset = 70.0;
final refreshIndicatorKey = GlobalKey<RefreshIndicatorState>();

RefreshIndicator(
  key: refreshIndicatorKey,
  notificationPredicate: (notification) =>
      notification.metrics.axis == Axis.vertical &&
      notification.depth <= 2,
  onRefresh: onRefresh,
  child: Listener(
    // PointerDown/Move 记录向下拖动距离
    child: NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        // 仅在页面顶部开始拖动；ScrollEnd 时达到 70px 才调用 show()
        return false;
      },
      child: NestedScrollView(...),
    ),
  ),
)
```

`NotificationListener` 必须位于 `RefreshIndicator.child` 内部。通知从内向外冒泡，它先收到 `ScrollEndNotification` 并调用 `show()`，系统外层监听器随后看到刷新已经进入 snap/refresh 流程，不会再按原阈值取消。

普通 `RefreshIndicator` 构造函数在 3.44.8 中把 `onStatusChange` 固定为 `null`；只有 `RefreshIndicator.noSpinner` 暴露该参数。项目要保留系统圆形指示器，因此使用公开 `show()`，并自行跟踪“从顶部开始拖动”这一个最小状态。

---

## 九、阅读源码后的调试方法

不要只打印“刷新开始/刷新结束”。至少记录：

```text
header.mode
header.offset
header.result
footer.mode
footer.offset
userOffsetNotifier.value
position.debugLabel
position.pixels
position.min/maxScrollExtent
position.activity.runtimeType
```

然后按时间轴对齐：

| 时刻 | 观察重点 |
| --- | --- |
| 手指下拉 | offset 是否增长，pixels 是否变化 |
| 达到阈值 | mode 是 armed 还是 processing |
| 松手 | userOffset 是否切 false，是否启动 ballistic |
| 请求完成 | processed 何时发生，动画是否仍 isAnimating |
| 收起结束 | mode 是否 inactive，offset 是否归零 |
| 再次下拉 | Header/Footer 是否仍可 process |

如果屏幕只“闪一下”，先确认是 widget 重建还是 notifier offset 改变。逐帧录屏与状态日志对齐后，通常能区分：

- 视觉层重建
- 滚动坐标跳变
- 指示器状态机跳转
- 数据替换造成的布局变化

---

## 十、工程结论

1. EasyRefresh 是滚动物理扩展，不只是一个 loading UI。
2. `clamping` Header 会消费越界位移，并通过独立 AnimationController 控制回弹。
3. `processedDuration`、`triggerWhenRelease` 影响时序，但不是所有死锁的根治点。
4. NestedScrollView 中 outer/inner 的 activity 必须和 EasyRefresh notifier 一起分析。
5. 下拉与上拉可以拆成两个组件，但要明确谁拥有哪一段 overscroll，以及谁负责状态复位。
6. 当一个三方组件同时接管顶部和底部时，先读它的 physics，再决定是否只保留其中一个方向。

7. Flutter `RefreshIndicator.displacement` 控制停靠位置，不控制触发距离；3.44.8 的默认触发距离来自 viewport 比例。

8. 嵌套滚动中看到指示器但没有回调，要分别验证通知 depth 和释放阈值，不能把它们当成同一个问题。

---

## 十一、Flutter 与 Dart 对照：同步手势和异步任务

| 阶段 | Flutter 侧 | Dart 侧 |
| --- | --- | --- |
| 手指拖动 | `ScrollPhysics` 同步计算本次 delta 和 boundary | 普通方法调用，必须在当前事件内返回数值 |
| 松手回弹 | `Simulation` + `AnimationController` 按帧推进 | Ticker 驱动回调，状态可能跨多帧变化 |
| 网络刷新 | Indicator 进入 `processing` | `await Future.sync(_task!)` 等待异步结果 |
| 完成收起 | `processed → done` 后重新 ballistic | `Future.delayed` 或 post-frame callback 改变执行时序 |

“请求已经 await 完成”和“收起动画已经结束”是两件事。EasyRefresh 闪烁正发生在异步任务完成与 Flutter 帧动画交接处。

---

## 十二、常见误区

### 误区 1：减小 displacement 就会更容易刷新

`displacement` 只控制刷新中圆环最终停在哪里。触发阈值在 `_checkDragOffset` 中按 viewportDimension 计算。

### 误区 2：把 Header 做透明就等于 Footer-only

透明 Header 仍可能参与 physics 和 notifier 状态机。Footer-only 应让 `onRefresh` 为 null，并显式使用 `NotRefreshHeader`。

### 误区 3：系统刷新后不需要管 EasyRefresh Footer

系统回调不会进入 EasyRefresh 的 `_onRefresh` 包装，自然不会执行 `resetAfterRefresh`。刷新成功后要主动 `resetFooter()`。

### 误区 4：给普通 RefreshIndicator 传 onStatusChange

Flutter 3.44.8 的普通/自适应构造函数没有这个命名参数，只有 `RefreshIndicator.noSpinner` 暴露它。

---

## 十三、检查题与答案

### 1. EasyRefresh 的 Header offset 为什么可以变化，而 ScrollPosition.pixels 基本不变？

`clamping` 分支在 `applyBoundaryConditions` 中更新 HeaderNotifier offset，并把越界差值作为 boundary 返回，越界没有继续写入普通内容位置。

### 2. 为什么把 onRefresh 交给系统后还要保留 EasyRefreshController？

上拉加载仍由 EasyRefresh Footer 管理；系统刷新完成后需要通过 controller 清除 Footer 的 noMore 等锁定状态。

### 3. 600px viewport 下，Flutter 3.44.8 的默认有效拖动阈值大约是多少？

`600 * 0.25 = 150` 逻辑像素。具体手指移动距离还会受到滚动物理和 overscroll 摩擦影响，所以真机体感可能更长。

### 4. 为什么 70px 方案在 ScrollEnd 调用 show，而不是到达 70px 立即调用？

这样保持“达到阈值、松手才刷新”的交互语义；同时内部 NotificationListener 先于外层 RefreshIndicator 收到 ScrollEnd，可避免系统按默认阈值把本次拖动取消。

---

## 十四、参考源码与 API

- [`easy_refresh.dart`（3.5.1 发布提交）](https://github.com/xuelongqy/flutter_easy_refresh/blob/de53826b004c486b2f176f49cf624d5c2ab45c17/packages/easy_refresh/lib/src/easy_refresh.dart)
- [`scroll_physics.dart`（3.5.1 发布提交）](https://github.com/xuelongqy/flutter_easy_refresh/blob/de53826b004c486b2f176f49cf624d5c2ab45c17/packages/easy_refresh/lib/src/physics/scroll_physics.dart)
- [`indicator_notifier.dart`（3.5.1 发布提交）](https://github.com/xuelongqy/flutter_easy_refresh/blob/de53826b004c486b2f176f49cf624d5c2ab45c17/packages/easy_refresh/lib/src/notifier/indicator_notifier.dart)
- [`refresh_indicator.dart`（Flutter 3.44.8）](https://github.com/flutter/flutter/blob/3.44.8/packages/flutter/lib/src/material/refresh_indicator.dart)
- [`EasyRefreshController`](https://pub.dev/documentation/easy_refresh/latest/easy_refresh/EasyRefreshController-class.html)
- [`RefreshIndicator`](https://api.flutter.dev/flutter/material/RefreshIndicator-class.html)

## 十五、总结

一句话总结：EasyRefresh 的刷新体验由“滚动边界 + notifier 状态机 + ballistic 动画”共同决定，任何只调整颜色、位移或展示时长的方案，都应先证明没有绕过这三层。
