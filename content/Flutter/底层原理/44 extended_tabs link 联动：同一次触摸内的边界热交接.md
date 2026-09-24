# extended_tabs link 联动：同一次触摸内的边界热交接

> 对应源码: sync_scroll_library 1.1.0 `lib/src/link/link_scroll_state.dart`、`lib/src/link/link_controller.dart`；extended_tabs 5.0.0 `lib/src/extended/tabs.dart`（pub 缓存，行号以此版本为准）
> 核对日期: 2026-08-28；extended_tabs 5.0.0 为 pub.dev 当前最新版
> 业务源码边界: `lib/app/modules/tribe/` 属于外部 slsw 项目，本仓库不包含该目录；本文的 link 结论来自三方包源码与通用嵌套模型，项目层级需在业务工程中另行验证
> 关联实践: slsw 部落首页两层 TabBarView 嵌套（`lib/app/modules/tribe/`）

## 本章目标

读完本章，以下标准应当全部达成：

1. 能写出 `linkActivedParent` 的边界判定条件（delta 方向与 `extentBefore`/`extentAfter` 的对应关系），并解释 RTL 下的差异；
2. 能说清"热交接"补发的两个调用及其必要性；
3. 能解释 fling 速度如何随 `DragEndDetails` 透传给父级，以及一次手势不回切的设计取舍；
4. 能按 `LinkScrollState` 的接入姿势为一个普通横滑组件（如横向列表）接入 ExtendedTabBarView 联动，并说出封装型轮播组件（Swiper）接不进去的原因。

本篇分析源码位置：

- `sync_scroll_library/lib/src/link/link_scroll_state.dart`（父子链建立、delta 入口）
- `sync_scroll_library/lib/src/link/link_controller.dart`（转发与边界判定核心）
- `extended_tabs/lib/src/extended/tabs.dart:136`（类型限定的 linkParent）

## 机制三件套

`link` 机制由三部分组成，按数据流顺序：

```
① 建链   didChangeDependencies → linkParent → findAncestorStateOfType
              内层 controller 持有最近的 ExtendedTabBarView 祖先的 controller
② 判界   每次 drag update → linkActivedParent(delta)
              自己在边界且父级有余量 → 激活父级
③ 转发   激活后的后续 update/end 先转发给父级，再结束当前 controller 的 drag
```

## ① 建链：findAncestorStateOfType 找爸爸

`sync_scroll_library/lib/src/link/link_scroll_state.dart:66`：

```dart
@override
@mustCallSuper
void didChangeDependencies() {
  linkParent();
  super.didChangeDependencies();
}

@mustCallSuper
void linkParent<S extends StatefulWidget, T extends LinkScrollState<S>>() {
  linkScrollController.unlinkParent();
  if (link) {
    linkScrollController.linkParent<S, T>(context);
  }
}
```

`sync_scroll_library/lib/src/link/link_controller.dart:74`：

```dart
void linkParent<S extends StatefulWidget, T extends LinkScrollState<S>>(
    BuildContext context) {
  _parent = context.findAncestorStateOfType<T>()?.linkScrollController;
}
```

`ExtendedTabBarViewState` 对类型做了限定（`extended_tabs/lib/src/extended/tabs.dart:136`）：

```dart
@override
void linkParent<S extends StatefulWidget, T extends LinkScrollState>() {
  super.linkParent<ExtendedTabBarView, ExtendedTabBarViewState>();
}
```

要点：

- 建链发生在 `didChangeDependencies`（依赖变化、页面结构变化时重建），不发生在 build，避免每帧查找；
- `findAncestorStateOfType<ExtendedTabBarViewState>()` 从当前 context 向上找**最近的** `ExtendedTabBarViewState`。中间隔多少普通 widget 都不影响；三层嵌套自然形成链表（C 的 parent 是 B，B 的 parent 是 A），`_findParent` 沿链递归；
- 类型限定意味着：**父级必须是 ExtendedTabBarView**。向上最近一层若是普通 `TabBarView`，查找会跳过它继续向上，可能挂到一个"更外层"的 ExtendedTabBarView 上，中间那层普通 TabBarView 不参与联动。

用户还可以不走隐式查找，直接通过 `LinkPageController(parent: 外层controller)` 显式指定父级（`link_controller.dart:65`：`_internalParent => parent ?? _parent`，显式优先）。

## ② 判界：每次增量都要过一遍边界检查

拖动增量到达时的路径，`link_scroll_state.dart:88`：

```dart
@override
void handleDragUpdate(DragUpdateDetails details) {
  _handleParentController(details);
  super.handleDragUpdate(details);   // 自己照常滚（DragHoldController）
}

void _handleParentController(DragUpdateDetails details) {
  if (linkScrollController.parentIsNotNull) {
    final double delta = scrollDirection == Axis.horizontal
        ? details.delta.dx
        : details.delta.dy;

    linkScrollController.linkActivedParent(
      delta,
      details,
      textDirection ?? TextDirection.ltr,
    );
  }
}
```

先记两个事实，判定逻辑就自明了：

- `DragUpdateDetails.delta.dx` 是**手指**位移：向左滑为负，向右滑为正；
- `ScrollPosition` 的 `extentBefore` 是当前页之前还剩多少可滚（第一页时为 0），`extentAfter` 是之后还剩多少（最后一页时为 0）。

`link_controller.dart:160` 的判定核心：

```dart
void linkActivedParent(
  double delta,
  DragUpdateDetails details,
  TextDirection textDirection,
) {
  if (_activedLinkParent != null) {
    return;                                  // 已激活，不再重复判定
  }
  LinkScrollControllerMixin? activedParent;
  if (textDirection == TextDirection.rtl) {
    delta = -delta;                          // RTL 下方向语义取反
  }

  if (delta < 0 && _extentAfter == 0) {
    // 向左滑（想看下一页），自己已是最后一页
    activedParent = _findParent(
        (LinkScrollControllerMixin parent) => parent._extentAfter != 0);
  } else if (delta > 0 && _extentBefore == 0) {
    // 向右滑（想看上一页），自己已是第一页
    activedParent = _findParent(
        (LinkScrollControllerMixin parent) => parent._extentBefore != 0);
  }

  if (activedParent != null) {
    _activedLinkParent = activedParent;
    activedParent.handleDragDown(null);      // ┐
    activedParent.handleDragStart(           // │ 热交接：补发按下与开始
      DragStartDetails(                      // │
        globalPosition: details.globalPosition,
        localPosition: details.localPosition,
        sourceTimeStamp: details.sourceTimeStamp,
      ),
    );                                       // ┘
  }
}
```

`_findParent` 沿父子链递归上溯（`link_controller.dart:148`），跳过"同样在边界"的祖先，找到第一个**对应方向还有余量**的 controller——三层嵌套时最内层可以直接把滚动交给最外层，中间层不够滑就跳过它。

需要注意：`handleDragUpdate` 先做父级判界，再进入 `super` 的常规处理；触发交接的这个 update 会被直接用于启动父级，不能把代码中的 `super.handleDragUpdate` 解读成"子级一定先完整消费本次 delta"。如果上一帧才刚跨过边界，物理层已经丢掉的越界余量也不会由 link 追溯补回。

一个 controller 可以挂载多个 position：同步层会把 update 广播给它们，但 `_extentBefore`/`_extentAfter` 的边界代表和 attach 时的像素校正取的是 `keys.first`。因此这里的"自己已在边界"是当前实现选出的代表 position，不应理解为每个已挂载 position 都逐一通过了边界检查。

## ③ 转发：激活后的增量与结束事件交给父级

`link_controller.dart:94`：

```dart
@override
void handleDragUpdate(DragUpdateDetails details) {
  if (_activedLinkParent != null && _activedLinkParent!.hasDrag) {
    _activedLinkParent!.handleDragUpdate(details);   // 转发给父级
  } else {
    _syncHandler.handleDragUpdate(details);          // 自己滚
  }
}

@override
void handleDragEnd(DragEndDetails details) {
  _activedLinkParent?.handleDragEnd(details);        // 速度随 details 透传
  _syncHandler.handleDragEnd(details);
}
```

三个细节：

1. **`hasDrag` 防御**：父级页面若在中途被 dispose（快速切页导致 controller 分离），drag 句柄消失，转发条件失效，delta 落回自己这边，不会崩溃或丢事件；
2. **速度透传**：`DragEndDetails.velocity` 由手势识别器根据手势的位移时间曲线算出，转发时不做加工。父级先收到 `handleDragEnd(details)`，用同一个速度结束自己的 drag 并创建 ballistic；当前 controller 随后也会结束自己的全部 position，因此不能概括成"速度全部归父级"；
3. **单向性**：`_activedLinkParent` 一旦设定，直到 `handleDragCancel`/`forceCancel` 才清空，**一次手势内不会从父级切回子级**。反向滑时父级滚回自己的边界后顶住，需要抬手再滑。这是有意取舍：若允许来回切换，边界附近的手指微抖会导致子↔父反复抢夺滚动权，画面抖动。牺牲"一次手势反向跨层"换取边界稳定，收益远大于损失。

## 完整时序

```
手指                内层 ExtendedTabBarView                    外层 ExtendedTabBarView
 │                        │                                        │
 │ down ────────────────► │ position.hold()（按停上一场惯性）        │
 │ start ───────────────► │ position.drag()                        │
 │ update(dx=-10) ──────► │ ├ 自己 update(-10)：正常滚动             │
 │                        │ └ 判界：extentAfter > 0，不动作           │
 │        …内层滚到最后一页，extentAfter == 0…                        │
 │ update(dx=-15) ──────► │ ├ 自己 update(-15)：顶在边界             │
 │                        │ └ 判界：extentAfter==0，向上找           │
 │                        │   外层 extentAfter != 0 → 命中           │
 │                        │ ════════ 热交接 ════════                 │
 │                        │ handleDragDown(null) ──────────────►   │ position.hold()
 │                        │ handleDragStart(当前坐标/时间) ──────►   │ position.drag()
 │                        │ _activedLinkParent = 外层               │
 │ update(dx=-20) ──────► │ 转发 ──────────────────────────────►   │ drag().update(-20)
 │                        │                                        │ 外层翻页开始
 │ end(v=-1800) ────────► │ 转发(带速度) ───────────────────────►   │ drag().end(v)
 │                        │                                        │ ballistic → snap 整页
```

交接发生在**检测到边界后的 update** 上；从交接点开始不需要新的 down/start，后续 update 和 end 仍属于同一次触摸。若边界前某个 update 已被 Clamping 物理层丢弃，其越界余量不会被 link 事后补回，所以"连续"指手势生命周期连续，不保证每一个物理 delta 都无损。

## 官方竞技场与 link 机制对照

| 交接动作 | 竞技场机制（官方） | link 机制（extended_tabs） |
|---|---|---|
| 滚动权转移时机 | 不存在转移，胜者通吃 | 拖动过程中按边界条件触发 |
| 手指是否抬起 | 必须抬手重新发起手势 | 全程不抬手 |
| delta 连续性 | 断裂，新手势重新计 touch slop | 触摸生命周期不重启，触发交接后的 update 原样转发；边界前已被物理层丢弃的余量不会补回 |
| fling 惯性传递 | 无法传递，速度归零重来 | 父级收到同一个 `DragEndDetails`，随后当前 controller 也结束自己的 drag |
| 跨层交接 | 无 | _findParent 沿链上溯，可跳过同样在边界的中间层 |

## 扩展接入：让任意横滑组件参与联动

建链的类型限定是 `ExtendedTabBarViewState`，TabBarView 之外的横滑组件（banner 轮播、横向列表）滑到边界后仍会被自己的 physics 钳住——它们的手势走竞技场、delta 出不去，与原生嵌套卡顿同构。

`LinkScrollState` 是 sync_scroll_library 留给任意组件的扩展基类，其源码顶部文档注释给出了官方接入姿势（`link_scroll_state.dart:8-54`）：

```dart
/// class _MyWidgetState extends LinkScrollState<MyWidget> {
///   @override
///   Widget build(BuildContext context) {
///     return buildGestureDetector(child: Container());
///   }
///
///   @override
///   LinkScrollControllerMixin get linkScrollController =>
///       throw UnimplementedError();
///
///   @override
///   ScrollPhysics? get physics => throw UnimplementedError();
///
///   @override
///   Axis get scrollDirection => throw UnimplementedError();
///
///   @override
///   void didChangeDependencies() {
///     // to something
///     // call super after linkScrollController is ready
///     super.didChangeDependencies();
///   }
///
///   @override
///   bool get link => true;
///
///   // must override this method
///   @override
///   void linkParent<S extends StatefulWidget, T extends LinkScrollState<S>>() {
///     // link parent base on your case
///     super.linkParent<ExtendedTabBarView, ExtendedTabBarViewState>();
///   }
/// }
```

接入的本质：把 ExtendedTabBarView 内部的"手势接管→建链→判界→转发"搬到自定义组件上，需要满足三个条件：

1. controller 换成 `LinkScrollController`（列表类）/ `LinkPageController`（翻页类），传给内部滚动组件，使其 attach 到真实 ScrollPosition；
2. 内部滚动组件的 physics 设为 NeverScrollable 链（手势上死，滚动与边界物理保留）；
3. State 继承 `LinkScrollState`，覆写 `linkScrollController` / `physics` / `scrollDirection` / `link` 与 `linkParent`（指向 `ExtendedTabBarView, ExtendedTabBarViewState`），build 用 `buildGestureDetector` 包裹。

依赖侧无额外成本：extended_tabs 的库文件完整转出了 sync_scroll_library 的公开符号（`export 'package:sync_scroll_library/sync_scroll_library.dart'`），业务工程 import extended_tabs 即可使用。

slsw 的落地组件（横向列表场景，`lib/widgets/ym_link_horizontal_scroll.dart`，`dart analyze` 零告警）：

```dart
/// 作者: Hax | 日期: 2026-08-28
/// 类描述: 可与 ExtendedTabBarView 联动的横向滚动容器。
/// 基于 sync_scroll_library 的 LinkScrollState 实现手势接管:
/// 内部 SingleChildScrollView 禁用手势(NeverScrollable 链, 滚动物理保留),
/// 由外层 RawGestureDetector 统一驱动; 滑到边界后把余量拖动连同 fling
/// 速度热交接给 widget 树上最近的 ExtendedTabBarView 祖先(如部落首页外层大 Tab)。
class YMLinkHorizontalScroll extends StatefulWidget {
  const YMLinkHorizontalScroll({required this.child, super.key});

  final Widget child;

  @override
  State<YMLinkHorizontalScroll> createState() => _YMLinkHorizontalScrollState();
}

class _YMLinkHorizontalScrollState
    extends LinkScrollState<YMLinkHorizontalScroll> {
  /// late final 惰性初始化: linkParent 在 didChangeDependencies 触发时
  /// 才会经 linkScrollController 访问, 满足"controller 先于 super 就绪"的时序要求。
  late final LinkScrollController _controller = LinkScrollController();

  @override
  bool get link => true;

  @override
  LinkScrollControllerMixin get linkScrollController => _controller;

  /// null = 可拖动, 供外层手势识别器判定 canDrag 与 fling 阈值。
  @override
  ScrollPhysics? get physics => null;

  @override
  Axis get scrollDirection => Axis.horizontal;

  @override
  void linkParent<S extends StatefulWidget, T extends LinkScrollState<S>>() {
    // 挂入 ExtendedTabBarView 的父子链, 获得边界联动能力
    super.linkParent<ExtendedTabBarView, ExtendedTabBarViewState>();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return buildGestureDetector(
      child: SingleChildScrollView(
        controller: _controller,
        scrollDirection: Axis.horizontal,
        // 手势上死(不参与竞技场)、动画与边界物理保留(到边即停),
        // 同时屏蔽 EasyRefresh 下发的 Bouncing 弹簧
        physics: NeverScrollableScrollPhysics()
            .applyTo(const ClampingScrollPhysics()),
        child: widget.child,
      ),
    );
  }
}
```

四个关键点：

- **controller 时序**：`LinkScrollState.didChangeDependencies` 会先调 `linkParent()`，其中访问 `linkScrollController`。controller 用 `late final` 声明处赋值、惰性初始化，恰好满足"controller 先于 super 就绪"的时序要求（文档注释原话 call super after linkScrollController is ready）。
- **两份 physics 分工**：State 的 `physics` getter 是给外层手势识别器的（null = 可拖，用于 canDrag 判定与 fling 阈值）；`SingleChildScrollView` 的 physics 才作用于内部 Scrollable（NeverScrollable 链 = 手势上死）。与 ExtendedTabBarView 的双 physics 结构同构。
- **建链方向**：组件位于 NestedScrollView 的 headerSliver 中时，与内层子 tab（body 分支）是兄弟关系，向上找到的最近 `ExtendedTabBarViewState` 祖先是外层大 tab——滑到边界联动切外层大 tab，与子 tab 到边界后的行为方向一致。要联动特定层，改用 `LinkPageController(parent: 目标controller)` 显式指定（显式优先于隐式查找）。
- **点击共存**：detector 只注册 `HorizontalDragGestureRecognizer`，与 child 里 InkWell 的 tap 识别器在竞技场按位移是否超过 touch slop 消歧——横滑归 drag、轻点归 tap，互不吞事件。

局限：封装型轮播组件（如 flutter_swiper_view 的 Swiper）不暴露 physics、也不接受外部 PageController（其 SwiperController 是私有封装），上述两个接入条件都不满足；此类组件要参与联动，只能用 `ExtendedPageView + LinkPageController` 同款骨架自建翻页组件替换。无法接入时的体验兜底是开启 Swiper 的循环轮播（`loop: true`）：滑到最后一张继续滑会回绕到第一张，消除"到底卡住"的感受。flutter_swiper_view 内部对 loop 做了真实 index 的取模归一化（`_getRenderIndexFromRealIndex`），`itemBuilder` 回调拿到的仍是业务 index，点击取值与指示器都不需要改；单条数据（`itemCount <= 1`）时库会自动降级为非循环，无需额外防护。slsw 的 banner、热聊话题、问答求助三处 Swiper 均采用此策略。

## 实际执行过程

在嵌套 demo 中，外层和内层都使用 `ExtendedTabBarView`，再把内层 `link: false` 改为 `link: true`。如果外层仍是普通 `TabBarView`，隐式 `findAncestorStateOfType<ExtendedTabBarViewState>()` 不会建立这条 link，需要改用显式 `LinkPageController(parent: ...)`：

```dart
Expanded(
  child: ExtendedTabBarView(
    link: true,
    children: const [
      Center(child: Text('推荐')),
      Center(child: Text('最新')),
      Center(child: Text('问答')),
    ],
  ),
)
```

逐项验证：

1. **右滑跨层**：停在内层"推荐"页（子 tab 第一个），按住向右滑——内层顶住边界的同时，外层"关注"大 tab 开始翻页，中间无停顿；
2. **左滑跨层**：滑到内层"问答"页（最后一个），继续向左滑——外层向"发现"大 tab 翻页；
3. **惯性交接**：在内层最后一页快速甩动（fling）——外层以惯性速度翻页并 snap 吸附，速度无衰减感；
4. **单向性**：跨层后（外层接管中）不抬手反向滑——外层滚回边界后顶住，不再交还内层，抬手后恢复常规操作。

## 常见错误

**错误一：以为需要把外层 controller 传给内层来建立关联。**
隐式建链靠 `findAncestorStateOfType` 自动完成。只有当父子在 widget 树上不构成祖先后代关系（如用 Stack 叠放）时，才需要 `LinkPageController(parent: ...)` 显式指定。

**错误二：父级用普通 `TabBarView`，期望 link 生效。**
建链的类型是 `ExtendedTabBarViewState`，普通 TabBarView 的 State 类型不匹配，会被查找跳过。参与联动的每一层都必须是 ExtendedTabBarView。

**错误三：给参与联动的 TabBarView 传 `BouncingScrollPhysics`。**
Bouncing 允许 position 暂时超出边界，子级可能在父级开始接管后继续创建自己的回弹 ballistic。Flutter 3.44.8 的 `ScrollMetrics.extentBefore/extentAfter` 会把结果截断为不小于 0，因此问题不是简单的"extentAfter 变负"，而是越界期间的边界时序与 Clamping 不同，联动行为更难预测。extended_tabs 默认使用 Clamping 正是为了让边界状态确定可判；参与联动的层保持默认 physics。

**错误四：期望一次手势内"滑出去再滑回来"。**
`_activedLinkParent` 激活后不回切（防抖动取舍）。跨层后反向只能先滑回父级边界、抬手、再滑。业务上若有强烈的反向跨层需求，应重新审视 tab 层级设计，而非对抗这个机制。

## 检查题

**Q1：`linkActivedParent` 中 `delta < 0` 与 `delta > 0` 分别检查哪个 extent？为什么？**

答：在水平 LTR 场景中，`delta < 0`（手指向左滑，想看下一页）检查自己的 `_extentAfter == 0`（是否已是最后一页）；`delta > 0`（向右滑，想看上一页）检查自己的 `_extentBefore == 0`（是否已是第一页）。RTL 下源码会先对传入 delta 取反再套用判断；这套左右解释不能直接套到纵向场景。

**Q2：热交接时补发了哪两个调用？为什么必须补发？**

答：向父级 controller 补发 `handleDragDown(null)` 与 `handleDragStart(DragStartDetails)`。父级此前未参与本次触摸，其 DragHoldController 还没有 hold/drag 句柄；不补发，后续转发的 update 在父级侧没有可驱动的 drag 活动，滚动无法开始。补发用的坐标与时间戳取自当前 update 事件，保证时间线连续。

**Q3：`handleDragEnd` 转发给父级有什么意义？不转会怎样？**

答：`DragEndDetails` 携带手势速度（velocity），父级先收到同一个 `DragEndDetails`，以该速度结束自己的 drag 并进入 ballistic；当前 controller 随后也会结束自己的 drag。不转发的话父级的 drag 活动收不到 end，跨层甩动会失去父级惯性，甚至留下未结束的 drag 状态。

**Q4：内层第三层嵌套、中间层也在边界时，滚动交给谁？**

答：`_findParent` 沿链递归上溯，逐个检查 `_extentAfter != 0`（或 Before），跳过同样在边界的中间层，把滚动交给第一个对应方向还有余量的祖先，可能是最外层。

**Q5：一个横向 SingleChildScrollView 要接入 link 联动，需要满足哪三个条件？**

答：controller 换成 `LinkScrollController` 并传给滚动组件（attach 到真实 ScrollPosition）；内部 physics 设 NeverScrollable 链禁掉自身手势；外层 State 继承 `LinkScrollState`，覆写 `linkScrollController` / `physics` / `scrollDirection` / `link` 与 `linkParent`（指向 `ExtendedTabBarViewState`），build 用 `buildGestureDetector` 包裹接管手势。

**Q6：为什么 flutter_swiper_view 的 Swiper 无法用 LinkScrollState 接入？**

答：接入要求把 LinkController attach 到组件内部的 ScrollPosition，并把内部 physics 设为 NeverScrollable；Swiper 不暴露 physics 参数、不接受外部 PageController（SwiperController 是它私有的封装），两个条件都无法满足。要接入只能自建翻页组件替换。

## 总结


link 机制的完整闭环：建链（`findAncestorStateOfType` 自动形成父子链）→ 判界（每个 update 检查 `extentBefore/After == 0`，沿链找到有余量的祖先）→ 热交接（补发 down/start 让父级"按下"）→ 转发（后续增量与同一个 `DragEndDetails` 交给父级，同时结束当前 controller）。交接发生在同一次触摸内，但不保证边界前已被物理层丢弃的越界余量可恢复；代价是一次手势不回切，换来边界防抖。`LinkScrollState` 是机制对任意组件开放的出口——slsw 以 `YMLinkHorizontalScroll` 为横滑列表接入了边界联动，封装型轮播（Swiper）则因不暴露 physics/PageController 接不进去。
