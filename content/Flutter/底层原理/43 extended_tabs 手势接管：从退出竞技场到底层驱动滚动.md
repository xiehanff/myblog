# extended_tabs 手势接管：从退出竞技场到底层驱动滚动

> 对应源码: extended_tabs 5.0.0 `lib/src/extended/tabs.dart`、`page_view.dart`、`scrollable.dart`；sync_scroll_library 1.1.0 `lib/src/gesture/gesture_state_mixin.dart`、`lib/src/drag_hold_controller.dart`（pub 缓存，行号以此版本为准）
> 核对日期: 2026-08-28；`NeverScrollableScrollPhysics` 的 `allowUserScrolling` 分层按项目 fvm Flutter 3.44.8 SDK 源码核对
> 业务源码边界: `lib/app/modules/tribe/` 属于外部 slsw 项目，本仓库不包含该目录；本文只核对三方包与 Flutter SDK 的通用实现
> 关联实践: slsw 部落首页两层 TabBarView 嵌套（`lib/app/modules/tribe/`）

## 本章目标

读完本章，以下标准应当全部达成：

1. 能说出 `ExtendedTabBarView` 让内部 PageView "手势上死、动画上活"的具体手段（physics 链的构造）；
2. 能解释为什么绕开竞技场后，`ScrollPosition.drag()/hold()` 依然可以驱动一个 physics 为 `NeverScrollableScrollPhysics` 的 Scrollable；
3. 能对照官方 `TabBarView` 画出两套手势链路的差异。

本篇分析源码位置：

- `extended_tabs/lib/src/extended/tabs.dart`
- `extended_tabs/lib/src/extended/page_view.dart`
- `sync_scroll_library/lib/src/gesture/gesture_state_mixin.dart`
- `sync_scroll_library/lib/src/drag_hold_controller.dart`

## 解法总览

原生嵌套卡顿的根因：竞技场只保留一个拖动回调拥有者 + 物理层没有跨 Scrollable 的边界 delta 交接。extended_tabs 的解法分两步，本篇讲第一步——**让包层识别器接管滚动调度**：

```
ExtendedTabBarView
 └─ RawGestureDetector（HorizontalDragGestureRecognizer）   ← 手势由它捕获、由它调度
     └─ NotificationListener（滚动通知/光晕）
         └─ ExtendedPageView
             └─ ExtendedScrollable
                 └─ Viewport（ScrollPosition：physics = NeverScrollable 链）  ← 不注册手势，只负责滚
```

每个 `ExtendedTabBarView` 都是这样一座"手势孤岛"：内部 Scrollable 不参加竞技场，包层 detector 负责参赛。嵌套时包层 detector 之间仍会参加同一个竞技场，通常由命中路径更内侧的 detector 获胜；获胜者手里有 link 父子链，可以在代码里转发 delta，而竞技场本身做不到这件事。

## 第一步：physics 链——手势上死，动画上活

`extended_tabs/lib/src/extended/tabs.dart:8` 与 `:126`：

```dart
const ScrollPhysics _defaultScrollPhysics = NeverScrollableScrollPhysics();

@override
ScrollPhysics? getScrollPhysics() {
  return _defaultScrollPhysics.applyTo(
    widget.physics == null
        ? const PageScrollPhysics().applyTo(const ClampingScrollPhysics())
        : const PageScrollPhysics().applyTo(widget.physics),
  );
}
```

`getScrollPhysics()` 返回的关键 physics 片段是：

```
NeverScrollableScrollPhysics
  └─ parent: PageScrollPhysics
       └─ parent: ClampingScrollPhysics
```

要理解这行代码的分量，需要先看 `ScrollPhysics` 承担的两项互不相干的职责：

| 职责 | 相关 API | 谁在调用 |
|---|---|---|
| 手势准入：允不允许用户拖 | `allowUserScrolling` → `shouldAcceptUserOffset()` | Scrollable 更新拖动识别器准入，也会影响 pointer-signal 等路径 |
| 滚动手感：snap 吸附、边界钳制、fling 减速曲线 | `createBallisticSimulation()`、`applyBoundaryConditions()` 等 | ScrollPosition 在滚动/动画时 |

手势准入在 Flutter 3.44 里是两层结构（本地 SDK `scroll_physics.dart` 验证）：`NeverScrollableScrollPhysics` 覆写 `allowUserScrolling` 恒为 `false`；基类的 `shouldAcceptUserOffset()` 先检查 `allowUserScrolling`，为 false 直接返回 false。更早的 Flutter 版本没有 `allowUserScrolling` 分层，`NeverScrollableScrollPhysics` 直接覆写 `shouldAcceptUserOffset()` 方法——效果完全一致。而 `createBallisticSimulation` 等滚动动画方法未被它覆写，仍会沿 parent 链计算；但它还会把 `allowImplicitScrolling` 设为 `false`，不能概括成“所有行为都不变”。另外，`ExtendedPageView` 最终还可能追加自己的 physics 包装层，下面的链图只表达这一段源码的核心关系。

- **手势上死**：position 重新计算尺寸时，`ScrollPositionWithSingleContext.applyNewDimensions()` 调用 `context.setCanDrag(physics.shouldAcceptUserOffset(this))`，再由 `ScrollableState.setCanDrag()` 根据结果清空手势识别器；得到 `false` 后，内部 PageView 不再注册自己的拖动识别器；
- **动画上活**：`createBallisticSimulation` 仍沿 `PageScrollPhysics`（翻页吸附到整数页）和 `ClampingScrollPhysics`（到边即停）计算。点击 TabBar 切 tab 时，`TabController.animateTo` 的程序化翻页通常不受 `allowUserScrolling` 这一拖动准入开关影响，但最终效果仍取决于完整 physics 链及其他 activity。

对照"给内层加 `NeverScrollableScrollPhysics`"的失败方案：它失败的原因是把手势让出去之后**没有人接手**。extended_tabs 保留了"让出去"这半步，补上了"自己接"的另半步。

## 第二步：RawGestureDetector——自己参赛，自己赢

`sync_scroll_library/lib/src/gesture/gesture_state_mixin.dart:65` 起：

```dart
void initGestureRecognizers() {
  if (canDrag) {
    switch (scrollDirection) {
      case Axis.horizontal:
        _gestureRecognizers = <Type, GestureRecognizerFactory>{
          HorizontalDragGestureRecognizer:
              GestureRecognizerFactoryWithHandlers<HorizontalDragGestureRecognizer>(
            () => HorizontalDragGestureRecognizer(),
            (HorizontalDragGestureRecognizer instance) {
              instance
                ..onDown = handleDragDown
                ..onStart = handleDragStart
                ..onUpdate = handleDragUpdate
                ..onEnd = handleDragEnd
                ..onCancel = handleDragCancel
                ..minFlingDistance = _physics?.minFlingDistance
                ..minFlingVelocity = _physics?.minFlingVelocity
                ..maxFlingVelocity = _physics?.maxFlingVelocity;
            },
          ),
        };
        break;
      // Axis.vertical 同理，注册 VerticalDragGestureRecognizer
    }
  } else {
    _gestureRecognizers = const <Type, GestureRecognizerFactory>{};
    forceCancel();
  }
}

Widget buildGestureDetector({required Widget child}) {
  if (_gestureRecognizers == null) {
    return child;
  }
  return RawGestureDetector(
    gestures: _gestureRecognizers!,
    behavior: HitTestBehavior.opaque,
    child: child,
  );
}
```

`extended_tabs/lib/src/extended/tabs.dart:168` 把整个 TabBarView 包了进去：

```dart
@override
Widget build(BuildContext context) {
  // ... 断言、NotificationListener、ExtendedPageView 组装
  return buildGestureDetector(child: result);
}
```

三个设计点：

1. **使用 `HorizontalDragGestureRecognizer`**。不自定义识别器、不 hack 竞技场，并从 physics 链同步 `minFlingDistance`、`minFlingVelocity` 等部分参数；这让核心识别路径接近原生，但不代表 velocity tracker、supported devices、手势设置等所有细节都完全相同；
2. **`behavior: HitTestBehavior.opaque`**。保证空白区域（页面留白处）也命中本 detector，拖动无处可逃；
3. **回调进入同步状态层**。`onDown/onStart/onUpdate/onEnd/onCancel` 会先经过 `SyncScrollState` / `LinkScrollState`，由它们决定当前 position、父级 link 和取消时机，最终再调用各 position 的 `DragHoldController`；不是简单地把回调直通某一个 controller。

## 第三步：DragHoldController——用框架的底层 API 驱动滚动

手势赢了之后怎么让 PageView 滚起来？`sync_scroll_library/lib/src/drag_hold_controller.dart`：

```dart
class DragHoldController {
  DragHoldController(this.position);
  final ScrollPosition position;
  Drag? _drag;
  ScrollHoldController? _hold;

  void handleDragDown(DragDownDetails? details) {
    _hold = position.hold(_disposeHold);          // 按下：先按停惯性动画
  }

  void handleDragStart(DragStartDetails details) {
    _drag = position.drag(details, _disposeDrag); // 开始：拿到 Drag 句柄
  }

  void handleDragUpdate(DragUpdateDetails details) {
    _drag?.update(details);                       // 移动：增量驱动
  }

  void handleDragEnd(DragEndDetails details) {
    _drag?.end(details);                          // 抬手：交出速度，进入 ballistic
  }
  // handleDragCancel / forceCancel 略
}
```

这四个方法调用的是框架 `Scrollable` 内部也会使用的 API。`position.drag()` 返回的 `ScrollDragController` 内部会走 `applyUserOffset → setPixels`，抬手时 `end(details)` 把 `DragEndDetails` 里的速度交给 physics 的 `createBallisticSimulation` 做 fling；因此拖动、边界和惯性共享核心路径，但包层识别器的参数同步并不完整，不能承诺与原生 `TabBarView` 每个细节完全一致。

这里的要害是一个框架行为：`physics.shouldAcceptUserOffset()` 参与 Scrollable 是否注册拖动识别器的判断，也会影响 pointer-signal 路径；`sync_scroll_library` 的 `GestureStateMixin` 也会读取类似准入状态。另一方面，`ScrollPosition.drag()/hold()` 是位于其下的底层 API，本身不再做这项 physics 准入检查。所以一个"用户不可拖动"（NeverScrollable 链）的 Scrollable，依然可以被包层代码用 `drag().update()` 逐帧驱动。extended_tabs 的手势调度建立在这两条路径的分离上。

`handleDragDown` 里的 `position.hold()` 也有讲究：用户按下瞬间，上一场滚动的 ballistic 惯性动画可能还在跑，`hold()` 会立即按停它——手指按下内容即停，这是原生滚动的标准手感。

## 附：多 position 的像素与惯性同步

`sync_scroll_library/lib/src/sync/sync_controller.dart:80` 的 `SyncScrollHandler.attach()` 中有一段保活场景的补偿逻辑：

```dart
void attach(ScrollPosition position) {
  if (_positionToListener.isNotEmpty) {
    final ScrollPosition otherScrollPosition = _positionToListener.keys.first;
    final double pixels = otherScrollPosition.pixels;
    if (position.pixels != pixels) {
      position.correctPixels(pixels);
      position.applyViewportDimension(otherScrollPosition.viewportDimension);
      position.applyContentDimensions(
        otherScrollPosition.minScrollExtent,
        otherScrollPosition.maxScrollExtent,
      );
    }
    final ScrollActivity? activity = otherScrollPosition.activity;
    if (activity != null && activity.isScrolling && activity is BallisticScrollActivity) {
      position.activity?.delegate.goBallistic(activity.velocity);
    }
  }
  _positionToListener[position] = DragHoldController(position);
}
```

同一个 controller 新 attach 一个 position（页面保活后重建）时：把像素、视口尺寸、内容边界校正成与现存 position 一致；若旧 position 正处于惯性滚动，则让新 position 以相同速度调用 `goBallistic`，各自创建新的 ballistic simulation，并不是加入同一个 simulation。这是包名里 "sync" 的含义——尽量让共用 controller 的多个滚动体保持同步。

## 官方实现与 extended_tabs 实现对照

| 环节 | 官方 TabBarView | ExtendedTabBarView |
|---|---|---|
| 手势捕获者 | 内部 PageView 的 Scrollable | 外包的 RawGestureDetector |
| 内部 Scrollable | 注册 HorizontalDrag，参加竞技场 | NeverScrollable 链，不注册任何识别器 |
| 竞技场参与者（嵌套时） | 内外两层的 Scrollable 互斗，当前结构下通常内层赢 | 各层只派包层 detector 参赛，嵌套时仍会竞争，通常由内层 detector 赢 |
| 滚动驱动 | Scrollable → position.drag() | DragHoldController → position.drag()（同一 API） |
| 翻页 snap / fling | PageScrollPhysics ballistic | 同左（physics 链完整保留） |
| delta 的可调度性 | 锁死在胜者内部 | 赢者可按需转发 |

## 实际执行过程

在嵌套 demo 工程 `nested_tabs_demo`（官方 TabBarView 两层嵌套）中引入本篇改动。`pubspec.yaml`：

```yaml
dependencies:
  extended_tabs: ^5.0.0
```

把 `InnerTabs` 中的内层 `TabBarView` 换成 `ExtendedTabBarView`，`link` 暂时关闭：

```dart
import 'package:extended_tabs/extended_tabs.dart';

// InnerTabs.build 内：
Expanded(
  child: ExtendedTabBarView(
    link: false, // 本篇先验证手势接管本身，不开启联动
    children: const [
      Center(child: Text('推荐')),
      Center(child: Text('最新')),
      Center(child: Text('问答')),
    ],
  ),
)
```

运行验证：

1. 内层三个子 tab 左右滑动、fling、snap 吸附——拖动与惯性共享原生的 `position.drag` 与 `PageScrollPhysics` 核心路径，整体手感应接近原生，但不是所有识别器细节都相同；
2. 点击 TabBar 切换子 tab——翻页动画正常（证明 NeverScrollable 链没有影响 animateTo 路径）；
3. 在子 tab 边界继续滑——依然卡住（符合预期：手势接管只是地基，边界移交由 link 机制解决，见后续篇章）。

## 常见错误

**错误一：认为 `NeverScrollableScrollPhysics` 会连 `animateTo` 一起禁掉。**
它主要改变手势准入（覆写 `allowUserScrolling` 为 false，经 `shouldAcceptUserOffset` 生效），`createBallisticSimulation` 仍沿 parent 链计算；但 `allowImplicitScrolling` 等属性也可能改变语义/隐式滚动行为，不能概括成所有程序化路径都完全不受影响。

**错误二：接管手势后用 `controller.jumpTo(controller.offset + delta)` 驱动滚动。**
`jumpTo` 每帧瞬移，绕开了 `ScrollDragController.update()` 的拖动 activity、用户位移物理和速度积累；它不会走同一套 `drag().update()/end()` 的连续拖动语义，滑动手感容易断裂且无自然 fling。必须走 `position.drag().update()/end()`。

**错误三：省略 `handleDragDown` 里的 `position.hold()`。**
按下瞬间上一场 ballistic 动画仍在跑，会出现"按下后内容又蹿一段"的错乱。hold 是原生滚动的固定开场动作。

**错误四：给 RawGestureDetector 用默认 `behavior`（deferToChild）。**
页面空白处（child 未覆盖的区域）不参与命中，拖空白滑不动。必须 `HitTestBehavior.opaque`。

## 检查题

**Q1：`NeverScrollableScrollPhysics.applyTo(PageScrollPhysics())` 组成的 physics 链，`shouldAcceptUserOffset` 与 `createBallisticSimulation` 分别表现如何？**

答：手势准入上，链首 NeverScrollable 覆写 `allowUserScrolling` 为 false（Flutter 3.44 分层；更早版本直接覆写 `shouldAcceptUserOffset` 方法），基类 `shouldAcceptUserOffset` 检查该值后返回 false（手势上禁）；`createBallisticSimulation` 未被覆写，委托 parent 链的 PageScrollPhysics/ClampingScrollPhysics 执行（动画上保留翻页吸附与边界钳制）。

**Q2：physics 为 NeverScrollable 链的 Scrollable，为什么还能被 extended_tabs 拖动？**

答：`shouldAcceptUserOffset`（读取 `allowUserScrolling`）参与 Scrollable 注册/更新手势识别器的准入判断，并可能影响 pointer-signal 等路径；`ScrollPosition.drag()/hold()` 是其下的底层 API，本身不重复执行这项准入检查。extended_tabs 的 RawGestureDetector 赢得竞技场后，经同步状态层和 DragHoldController 调用这两个 API 驱动滚动。

**Q3：接管手势后，extended_tabs 靠什么保证滑动手感与原生 TabBarView 一致？**

答：三件事：识别层使用框架 `HorizontalDragGestureRecognizer` 并同步部分 fling 参数；驱动层调用与 Scrollable 内部相同的 `position.hold()/drag().update()/end()` 核心路径；物理层保留 `PageScrollPhysics` 的 snap 与 ballistic。它们保证核心行为接近原生，不等于完整复制所有手势配置。

**Q4：`SyncScrollHandler.attach` 在新 position 挂载时做了哪两类同步？**

答：像素同步——`correctPixels` + 视口/内容尺寸校正，保证新旧 position 位置一致；惯性同步——旧 position 处于 BallisticScrollActivity 时，让新 position 以相同速度调用 `goBallistic`，各自创建新的 ballistic simulation。

## 总结

extended_tabs 解法的第一步是把手势裁决权收回来：用 `NeverScrollable` 链让内部 PageView 退出竞技场（手势上死、动画上活），用一层原味 `HorizontalDragGestureRecognizer` 的 RawGestureDetector 自己参赛，赢得手势后经 `DragHoldController` 调用框架底层 `position.drag()` 驱动滚动——手感与原生同源。此时每个 ExtendedTabBarView 已是一座可自由调度手势的孤岛，剩下的问题只有：内层滑到边界后，delta 如何交给父级——这正是 link 机制的全部内容。
