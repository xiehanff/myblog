# 从下拉刷新闪烁 Bug 到滚动体系：一次 Flutter 排障复盘

> 项目场景: 部落 Tab、同城帖子流
> 技术栈: Flutter 3.44.8（revision `058e0af2c2`）、NestedScrollView、EasyRefresh 3.5.1、GetX
> 核对日期: 2026-08-28；最终方案的真机结果来自外部业务项目记录，源码结论按项目锁定版本复核
> 证据边界: 业务页面源码、真机录屏、日志和临时回归测试不在本仓库；本仓库只能重核 Flutter 3.44.8 与 EasyRefresh 3.5.1 的通用源码，不能直接重跑本文的项目特例
> 配套原理: [39 NestedScrollView 源码解读](39 Flutter NestedScrollView 源码解读：外层 Header 与内层列表如何协同.md) · [40 EasyRefresh 源码解读](40 Flutter EasyRefresh 源码解读：滚动物理与指示器状态机.md)

一个“下拉刷新时闪了一下”的问题，最容易被当成 UI 重建、颜色闪烁或动画时长不合适。这个案例最后证明：闪烁只是结果，真正的问题发生在滚动物理、NestedScrollView 协调器和 EasyRefresh 状态机之间。

这次排障的价值不只在于改掉一个页面，而在于建立一套可以迁移到其他滚动 Bug 的方法：先记录事实，再读调用链；先区分视觉层、位置层、状态层，再决定是调参数还是拆职责。

## 本章目标与完成标准

完成本章后，应当可以独立完成下面四件事：

1. 用录屏、通知日志和状态日志区分“视觉闪烁”“滚动跳位”“状态机提前结束”；
2. 从项目锁定版本的 Flutter/EasyRefresh 源码验证假设，不用最新分支替代实际运行代码；
3. 将下拉刷新和上拉加载拆给不同组件，并补齐被拆掉的状态同步；
4. 复现并解释两个后续回归：默认 notification depth 导致无法刷新，以及系统 viewport 阈值导致必须长距离拖动。

---

## 一、第一眼看到的现象

真机录屏中，部落 Tab 的竖向列表下拉刷新大致经历了以下时间线：

| 阶段 | 画面 | 初步直觉 |
| --- | --- | --- |
| 下拉 | 白色圆形指示器压在列表卡片上方 | Header 位置不对 |
| 回弹 | 指示器逐渐上移 | 回弹动画异常 |
| 回弹结束 | 指示器一帧内完全消失 | 刷新完成了？ |
| 等待请求 | 约 3 秒画面没有任何指示 | loading 丢失 |
| 请求完成 | 列表和数据一帧替换 | 数据更新导致闪烁 |

逐帧对比发现：指示器消失的时间点早于请求完成，数据替换是另一个跳变，不能把两者归为同一个 build 问题。

判断“屏幕没有新帧”也很有用。screenrecord 只在画面变化时写帧，等待期没有新帧意味着屏幕确实没有重绘，不是播放器漏显示某个 loading 帧。

---

## 二、先确认 EasyRefresh 到底负责什么

页面有四个分类，最初的直觉是“既然用了 EasyRefresh，上拉和下拉都由它负责”。源码走读后，职责实际是：

| 列表 | 下拉刷新 | 上拉加载 |
| --- | --- | --- |
| 生肖部落 | EasyRefresh Header | 页面 `NotificationListener` |
| 其他部落 | EasyRefresh Header | 页面 `NotificationListener` |
| 姓氏部落 | EasyRefresh Header | 页面 `NotificationListener` + 越界切字母 |
| 同城帖子流 | EasyRefresh Header | EasyRefresh Footer |

部落 Tab 的 Footer 没有传 `onLoad`，只是一个闲置配置；同城帖子流则确实依赖 EasyRefresh 的 Footer。

这个确认改变了修复策略：

- 部落 Tab 可以把整个下拉 Header 换成 Flutter 原生 `RefreshIndicator`。
- 同城帖子流不能直接删除 EasyRefresh，只能让它退化为 Footer-only 模式。

如果不先做这一步，容易为了修复一个 Header Bug，误删页面实际依赖的分页触发逻辑。

---

## 三、错误方向：只改位移或展示时长

EasyRefresh 封装暴露了 `headerTopOffset`，内部实现是：

```dart
Header _topOffsetHeader(Header inner, double topOffset) {
  return BuilderHeader(
    builder: (context, state) => Transform.translate(
      offset: Offset(0, topOffset),
      child: inner.build(context, state),
    ),
    // 其余 Header 参数透传
  );
}
```

它只影响 Header widget 的 paint/layout 位置，不会改变：

- `_ERScrollPhysics.applyBoundaryConditions`
- `HeaderNotifier._calculateOffset`
- `IndicatorNotifier._updateMode`
- `AnimationController.isAnimating`
- `NestedScrollCoordinator.goBallistic`

同样，调小 `processedDuration` 只会改变 `processed` 状态停留多久。它可以缩短白色完成态残留，但不能修复 Header 位移与 ballistic 动画竞争。

参数调优不是错，前提是先证明问题只发生在视觉参数层。只要日志里出现了 mode/offset 不符合预期，就应该停止调颜色和位移，转向状态机。

---

## 四、源码定位：闪烁的根因是状态机失去了收起动画

EasyRefresh 3.5.1 的刷新路径可以抽象成：

```text
手指拖动
  ↓
_ERScrollPhysics.applyBoundaryConditions
  ↓
HeaderNotifier._updateOffset
  ↓
drag / armed
  ↓ 松手
_ERScrollPhysics.createBallisticSimulation
  ↓
HeaderNotifier._updateBySimulation
  ↓
ready / processing
  ↓ 请求 Future 完成
processed
  ↓ processedDuration
done
  ↓
_completeProcessedMode → _resetBallistic
  ↓
inactive
```

问题出在最后三步并不只有一条动画：

1. 松手时，clamping Header 启动回弹动画 A，把指示器送到触发距离；
2. 请求完成后进入 `processed`，随后 `done` 尝试启动收起动画 B；
3. `_startClampingAnimation` 如果发现已有 AnimationController 正在动画，直接 return；
4. B 被跳过，A 可能停在触发距离，Header 进入 `done + offset > 0` 的异常组合；
5. 下一次状态更新命中“done 且仍有 offset，保持当前状态”的分支，表现为消失、卡住或再次下拉无效。

`processedDuration` 为零时，`_completeProcessedMode` 通过 `addPostFrameCallback` 尽快执行；请求很快完成、拉动距离较大、NestedScrollView 又正在切换 activity 时，竞争窗口更容易出现。

### 4.1 为什么列表内容没有跟着指示器移动

`MaterialHeader(clamping: true)` 的顶部边界逻辑会：

```dart
_updateIndicatorOffset(position, 0, value);
return value - position.minScrollExtent;
```

返回值把越界部分交给 EasyRefresh，ScrollPosition 的内容不会同样向下移动。Header offset 在变，列表卡片 y 坐标基本不变，于是白色圆形指示器看起来像“压在卡片上”。

这是 EasyRefresh 的设计使然，与 Flutter 绘制错位无关。想要“内容被推下来”的交互，需要使用 behind/locator 或另一种 Header/physics 策略，不能靠 `Transform.translate` 补救。

---

## 五、部落 Tab 的修复：原生下拉、通知上拉

部落列表的 EasyRefresh 只有 Header 价值，因此替换成：

```dart
RefreshIndicator(
  color: context.ymColors.primary,
  backgroundColor: context.ymColors.surface,
  onRefresh: () async {
    final minDisplayTime = Future<void>.delayed(
      const Duration(milliseconds: 1200),
    );
    await onRefresh();
    await minDisplayTime;
  },
  child: ListView.separated(
    physics: const BouncingScrollPhysics(
      parent: AlwaysScrollableScrollPhysics(),
    ),
    ...,
  ),
)
```

空态和失败态使用 `CustomScrollView + SliverFillRemaining`，同样配置 `AlwaysScrollableScrollPhysics`，避免“没有内容所以不能刷新”。生肖/其他部落的底部加载 `NotificationListener` 原样保留。

姓氏部落根据交互要求使用 `AlwaysScrollableScrollPhysics`，不额外开启 Bouncing；它的 `OverscrollNotification` 仍由自有逻辑累计，用于“继续上拉切换下一字母”。

这次拆分真正做的是把顶部刷新状态机从页面的 EasyRefresh physics 中移除，而不只是换一个视觉组件。

---

## 六、同城帖子流的难点：不能删除 EasyRefresh

同城帖子流是 `NestedScrollView + TabBarView + 两个 inner CustomScrollView`，并且分页确实由 EasyRefresh Footer 负责。

正确做法是让 EasyRefresh 只保留 Footer：

```dart
EasyRefresh.builder(
  controller: _easyRefreshController,
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
  childBuilder: (context, physics) => RefreshIndicator(
    key: _refreshIndicatorKey,
    edgeOffset: statusBarHeight,
    displacement: statusBarHeight + 40,
    notificationPredicate: (notification) =>
        notification.metrics.axis == Axis.vertical &&
        notification.depth <= 2,
    onRefresh: _onRefresh,
    child: NestedScrollView(
      physics: physics,
      ...,
    ),
  ),
)
```

这里的 `BuilderFooter` 配置是项目代码的裁剪片段。EasyRefresh 3.5.1 中 `BuilderFooter.position` 是可选参数，默认值为 `IndicatorPosition.above`；由于 builder 返回空 widget，示例仍可编译。若要明确表示 Footer 只参与 notifier/physics，可以额外设置 `position: IndicatorPosition.custom`。

### 6.1 为什么要用 `EasyRefresh.builder`

官方 EasyRefresh 文档对 NestedScrollView 的推荐方式，是通过 `childBuilder` 拿到 EasyRefresh 生成的 physics，再显式传给 outer 和 inner：

```dart
childBuilder: (context, physics) {
  return NestedScrollView(
    physics: physics,
    body: ListView(physics: physics),
  );
}
```

这不是形式要求。outer 和 inner 只有使用同一套 physics，Footer 才能观察到正确的底部边界。

### 6.2 为什么要手动 `resetFooter`

EasyRefresh 内部只有自己的 `onRefresh` 完成时，才会按 `resetAfterRefresh` 调用：

```dart
if (widget.resetAfterRefresh) {
  _footerNotifier._reset();
}
```

现在刷新由系统 `RefreshIndicator.onRefresh` 触发，不会进入 EasyRefresh 的 `_onRefresh`。如果不手动：

```dart
_easyRefreshController.resetFooter();
```

当上一次加载返回 `IndicatorResult.noMore` 后，Footer 可能保持 `noMoreLocked`，下一次刷新拿到新数据后仍无法加载下一页。

这是混合组件方案最容易漏掉的状态同步点。

### 6.3 第一次回归：指示器和 onRefresh 都无法触发

`RefreshIndicator` 默认使用 `defaultScrollNotificationPredicate`，只接受 `notification.depth == 0`。外部业务项目的临时日志和 widget 测试记录显示，同城页面在 `NestedScrollView + ExtendedTabBarView + inner CustomScrollView` 结构下，inner 的关键 overscroll 通知以 `depth == 2` 到达外层。本仓库现有的 NestedScrollView 测试没有覆盖这条页面路径，因此不能把该数字当作通用常量。

修复的做法是限定竖向轴和该页面验证过的层级，而不是把谓词改成无条件 true：

```dart
bool _isRefreshScrollNotification(ScrollNotification notification) {
  return notification.metrics.axis == Axis.vertical &&
      notification.depth <= 2;
}
```

这个数字属于当前 widget 树，不是 NestedScrollView 的通用常量。页面结构变化后应重新记录通知。

### 6.4 第二次回归：短拉能看到圆环，松手却不刷新

最先尝试的是减小 `displacement`。Flutter 官方 API 对它的定义是“指示器刷新时最终停靠的距离”，它没有进入阈值计算，因此手感几乎不变。

Flutter 3.44.8 源码的阈值链路是：

```dart
const double _kDragContainerExtentPercentage = 0.25;

double newValue =
    _dragOffset! /
    (containerExtent * _kDragContainerExtentPercentage);
_positionController.value = clampDouble(newValue, 0.0, 1.0);
```

松手时，即使状态已经开始显现或进入 armed，只要 `_positionController.value < 1.0`，仍会进入 canceled 并收回。有效 `_dragOffset` 大约要达到 viewport 高度的 25%。这解释了用户反馈：小距离已经看到指示器，却必须继续拖很远才触发 `onRefresh`。

### 6.5 最终修复：保留系统动画，单独缩短释放阈值

复制 SDK 私有实现会制造长期维护分叉。项目采用 70 逻辑像素作为产品阈值，与原 EasyRefresh `MaterialHeader(triggerOffset: 70)` 对齐：

```text
PointerDown
  ↓ 记录起点
PointerMove
  ↓ 累计最大向下距离
ScrollStart
  ↓ 确认手势从整个页面顶部开始
ScrollEnd
  ├── 距离 < 70px：交给系统取消并收回
  └── 距离 ≥ 70px：RefreshIndicatorState.show()
                         ↓
                    snap → refresh → done
```

实现使用 `GlobalKey<RefreshIndicatorState>` 调用公开 `show()`。`NotificationListener` 放在 `RefreshIndicator.child` 内部，因此会先收到向外冒泡的 `ScrollEndNotification`；达到 70px 时先进入系统刷新流程，外层系统监听器随后不会再按原 viewport 阈值取消。

还要检查 outer controller 是否处于 `minScrollExtent`，防止 Header 已折叠或列表在中间位置时误触发。普通 `RefreshIndicator` 构造函数没有开放 `onStatusChange` 参数，所以项目只维护“当前指针距离”和“是否从页面顶部开始拖动”两个必要状态。

外部业务项目的临时回归测试在相同 viewport 下验证了三组对照；本仓库不含该页面和依赖，下面的数值不能在这里直接重跑：

| 配置 | 拖动距离 | onRefresh |
| --- | ---: | --- |
| 系统默认阈值 | 80px | 不触发 |
| 项目 70px 阈值 | 50px | 不触发 |
| 项目 70px 阈值 | 80px | 触发一次 |

---

## 七、从“看起来闪”到“可以证明闪”的取证方法

### 7.1 录屏不是结论，逐帧才是证据

一次可复用的取证流程：

```bash
adb shell screenrecord --time-limit 6 --bit-rate 12000000 /sdcard/refresh.mp4
adb shell input swipe 600 900 600 2000 350
adb pull /sdcard/refresh.mp4 /tmp/refresh.mp4
```

将视频转成序列帧后，至少记录：

- Header 是否出现
- Header 的中心点和列表首项坐标
- 数据内容是否已经替换
- 相邻两帧是否发生整块跳变
- 是否存在长时间无新帧

如果 Header 消失时列表内容不变，优先查 Header 状态机；如果列表首项也跳了，继续查数据替换和 NestedScrollCoordinator。

### 7.2 日志和帧时间轴必须对齐

只打印网络请求开始/结束不够。应该在状态变化处记录：

```text
t=...
source=outer|inner
mode=drag|armed|ready|processing|processed|done|inactive
offset=...
pixels=...
activity=DragScrollActivity|BallisticScrollActivity|IdleScrollActivity
userOffset=true|false
```

然后把日志时间戳和视频帧时间对齐。这样能回答“是状态先变、位置先变，还是数据先变”。

### 7.3 widget 测试如何复现状态机问题

`pumpAndSettle` 不适合 processing 状态，因为旋转进度动画永远不会静止。更可靠的办法是：

1. 用 `TestGesture` 分多帧 `moveBy` 模拟慢拖；
2. 松手后按 100ms 步进 `pump`；
3. 每一帧读取 Header notifier 的 mode 和 offset；
4. 断言最终必须是 `inactive + offset == 0`；
5. 再执行第二次下拉，确认状态机没有锁死。

测试应该验证状态转移，而不是只查屏幕上有没有某个文字。列表项可能因为 `cacheExtent` 没有 build，`find.text` 不能代表真实滚动位置。

---

## 八、一次排障中的假设迭代

### 假设一：数据更新导致列表重建闪烁

逐帧证据显示指示器在网络请求结束前就消失，排除“数据更新是唯一原因”。数据更新仍会造成最后一帧跳变，但不是前半段闪烁的根因。

### 假设二：`processedDuration` 太短

调节时长改变了视觉概率，却无法保证 mode 回到 inactive。说明它是放大因素，不是结构性根因。

### 假设三：NestedScrollView 的外层/内层位置切换触发了异常

源码确认 `_NestedScrollCoordinator.goBallistic(0)` 会同时为 outer 和所有 inner 创建 activity。数据锚定中的 `jumpTo` 确实可能放大竞争，但即使没有数据更新，EasyRefresh clamping Header 的动画竞争仍可复现。

### 第一阶段结论：双重状态机拥有同一段顶部越界

EasyRefresh Header 和 NestedScrollView 都在决定“顶部越界如何回弹、何时结束”。状态归属不清时，参数只能缓解，拆分职责才是稳定方案。

### 第二阶段假设：系统指示器无法触发是 physics 不兼容

通知日志显示 inner overscroll 确实产生，但到达外层时 depth 为 2；默认谓词把它过滤。放开经过验证的 depth 后，系统指示器和回调链恢复，说明首个回归是通知选择问题。

### 第三阶段假设：减小 displacement 可以缩短触发距离

官方文档和 3.44.8 源码都表明 displacement 只控制停靠位置。真正阈值来自 `_dragOffset / (viewportDimension * 0.25)`，所以该修改无法解决长距离拖动。

### 最终结论：分离所有权后，还要补齐通知和交互语义

在该项目的回归中，顶部刷新与底部加载拆分解决了 EasyRefresh Header 的闪烁和状态竞争；`notificationPredicate` 修复了嵌套通知接入；70px + `RefreshIndicatorState.show()` 恢复了原产品手感。三个修改分别处理状态所有权、事件路由和触发阈值，不能互相替代。

---

## 九、验证清单从功能到时序

修复不能只验证“能不能刷新”。至少分成四层：

| 层级 | 检查项 |
| --- | --- |
| 触发 | 顶部下拉能触发，底部加载能触发，空态也能下拉 |
| 手感 | 小于 70px 松手收回，达到 70px 后松手刷新，不需要拖到 viewport 的 25% |
| 视觉 | 指示器持续可见，收起有过渡，没有白色容器残留 |
| 状态 | `processing → processed → done → inactive`，最终 offset 归零 |
| 通知 | outer/inner 的竖向通知可达，横向 Tab 通知不会误触发 |
| 组合 | noMore 后刷新能恢复加载，Tab 切换不串位置，惯性中数据更新不崩溃 |

同城帖子流还要区分两个 Tab，分别验证推荐游标分页和最新页码分页。刷新当前 Tab 后，另一个 Tab 的 Footer 状态不能被错误重置或锁定。

---

## 十、从实践到体系的迁移方法

以后遇到类似问题，可以按下面的顺序：

1. **划分责任**：谁处理顶部 overscroll，谁处理底部 overscroll，谁拥有回弹动画。
2. **列出状态**：把“看起来在转圈”翻译成可观测的 mode、offset、pixels、activity。
3. **画调用链**：从手势到 physics，再到 notifier、Future 和完成动画。
4. **建立最小复现**：先去掉网络和数据更新，判断纯手势是否仍能复现。
5. **做对照实验**：切换 clamping、triggerWhenRelease、processedDuration，观察概率而不是凭感觉下结论。
6. **减少状态机数量**：如果两个组件争抢同一段滚动边界，拆掉其中一个方向的控制权。
7. **补偿被拆掉的同步点**：例如 Footer 的 `resetFooter`、Tab 的位置恢复、空态的可滚动 physics。
8. **真机复检**：模拟器能验证状态，真机才能验证帧率、触摸采样、系统回弹和视觉残留。

9. **版本固化**：记录 Flutter revision、三方包锁定版本和对应源码提交；升级后重新检查私有阈值与状态分支。

这套方法可以迁移到吸顶 Header 跳动、分页重复触发、Tab 切换位置错乱、滚动中数据刷新断言等问题。

---

## 十一、Flutter 与 Dart 对照：事件链和 Future 链

| 观察对象 | Flutter 事件链 | Dart Future 链 |
| --- | --- | --- |
| 起点 | Pointer/gesture 产生 ScrollStart、Update、Overscroll | `onRefresh` 被调用后创建 Future |
| 中间状态 | physics、position、indicator animation 按帧更新 | controller 请求、数据解析、状态更新依次 await |
| 结束 | ScrollEnd 后 snap/refresh/done 动画结束 | Future 完成只表示业务刷新完成 |
| 典型误判 | 圆环消失就认为请求结束 | Future 完成就认为所有动画已收起 |

排障日志要给两条时间线使用同一个时间基准。只记录网络 Future，会丢失手势和动画先于请求结束发生的异常。

---

## 十二、常见错误

### 1. 只验证“圆环出现”

出现、armed、松手触发和 Future 完成是不同阶段。必须断言 `onRefresh` 次数，并验证完成动画。

### 2. 用 main 分支源码解释锁定版本

Flutter 与 EasyRefresh 都会演进。本文以 Flutter 3.44.8 revision `058e0af2c2`、EasyRefresh 3.5.1 发布提交 `de53826b...` 为证据，网页 latest 只用于确认当前公开 API，没有替代项目锁定的 3.44.8 源码。

### 3. 把 depth 当成组件类型

depth 只描述通知到监听器之间穿过的 viewport 数。复制 `depth <= 2` 到另一个页面可能接入过多或过少通知。

### 4. 在达到 70px 时立即刷新

这会把“松手触发”改成“拖动中触发”。当前实现只记录已达到阈值，在 ScrollEnd 时调用系统 `show()`。

### 5. 忘记 Footer 的 noMore 生命周期

系统刷新和 EasyRefresh Footer 是两个状态机。新数据恢复分页能力后，要主动 `resetFooter()`。

---

## 十三、检查题与答案

### 1. 为什么减小 `displacement` 没有改善触发距离？

它控制指示器刷新中的停靠位置；Flutter 3.44.8 的有效触发进度按 `_dragOffset / (viewportDimension * 0.25)` 计算。

### 2. 为什么最终方案仍可称为“系统原生刷新”？

项目只决定何时调用公开的 `RefreshIndicatorState.show()`；圆环绘制、snap、执行 `onRefresh`、等待 Future 和 done 收起仍由 Flutter `RefreshIndicatorState` 完成。

### 3. 为什么 NotificationListener 要放在 RefreshIndicator 的 child 内？

ScrollNotification 从内向外冒泡。内部监听器先处理 ScrollEnd 并调用 `show()`，随后系统监听器不会把达到产品阈值的拖动按默认阈值取消。

### 4. 本次修复为什么分成三个层次？

Footer-only 处理状态所有权，`notificationPredicate` 处理事件路由，70px 阈值处理交互语义。缺少任何一层都会留下不同表现的 Bug。

---

## 十四、参考资料

- [Flutter `NestedScrollView` API](https://api.flutter.dev/flutter/widgets/NestedScrollView-class.html)
- [Flutter `NestedScrollView` 源码（3.44.8）](https://github.com/flutter/flutter/blob/3.44.8/packages/flutter/lib/src/widgets/nested_scroll_view.dart)
- [Flutter `RefreshIndicator` 源码（3.44.8）](https://github.com/flutter/flutter/blob/3.44.8/packages/flutter/lib/src/material/refresh_indicator.dart)
- [EasyRefresh 官方仓库](https://github.com/xuelongqy/flutter_easy_refresh)
- [EasyRefresh 3.5.1 API 文档](https://pub.dev/documentation/easy_refresh/3.5.1/)
- [EasyRefresh 3.5.1 `scroll_physics.dart`（发布提交）](https://github.com/xuelongqy/flutter_easy_refresh/blob/de53826b004c486b2f176f49cf624d5c2ab45c17/packages/easy_refresh/lib/src/physics/scroll_physics.dart)
- [EasyRefresh 3.5.1 `indicator_notifier.dart`（发布提交）](https://github.com/xuelongqy/flutter_easy_refresh/blob/de53826b004c486b2f176f49cf624d5c2ab45c17/packages/easy_refresh/lib/src/notifier/indicator_notifier.dart)
- 项目源码: `lib/widgets/ym_easy_refresh.dart`
- 项目源码: `lib/app/modules/tribe/home/tribe_circle/tribe_tabbar_view.dart`
- 项目源码: `lib/app/modules/tribe/sub_pages/target_city_post_flow/target_city_post_flow_view.dart`

## 十五、总结

真正稳定的刷新修复，在于让每一个滚动方向只有一个明确的状态机负责，而不是把指示器挪到一个看起来合适的位置。
