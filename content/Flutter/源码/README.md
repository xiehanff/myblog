# Flutter 源码详解系列

以**Flutter 3.44.8 SDK 源码**为唯一准绳，从 framework 最底层逐层向上读的源码教程。61 篇正文（第 00～60 篇），全部完成；手册 31 任务的对照与后续扩充计划在 `../源码计划/源码阅读系列后续扩充计划.md`。

## 版本锚定

这个系列所有结论、行号、类名都来自下面这一份源码，不引用 GitHub main/master：

```text
Flutter: 3.44.8   channel: stable
Dart:    3.12.2
Framework revision: 058e0af2c2b57e369d905a03ac9748b0ebf543c6
Engine revision:    0cd610717bde95fd88343c64f81c11ba4e5c0010
SDK 路径: /Users/hax/fvm/default
Framework 源码根: packages/flutter/lib/src
```

**SDK 升级后如何复核锚点**：文中每个锚点都写成 `文件:行号`，直接 grep 核对即可。

```bash
# 例：复核 setState 的入口
grep -n "void setState" packages/flutter/lib/src/widgets/framework.dart

# 例：复核某个类的位置
grep -rn --include="*.dart" -E "^(abstract )?class RenderFlex\b" packages/flutter/lib/src
```

行号会漂移，**类名和调用关系不会**。所以这个系列主张记角色、记链路，行号只用来快速定位。

## 分层地图

下面这张表是把 `packages/flutter/lib/src` 下全部 681 个文件的 import 扫一遍得到的真实依赖，不是凭印象排的（括号内为引用次数）：

| 层 | 依赖的其它层 | 规模 |
|---|---|---|---|
| foundation | 无（最底层） | 42 文件 / 11.4k 行 |
| physics | foundation | 7 文件 / 0.9k 行 |
| scheduler | foundation | 5 文件 / 2.2k 行 |
| gestures | foundation, scheduler | 27 文件 / 14.3k 行 |
| painting | foundation, services, scheduler, gestures | 48 文件 / 24.9k 行 |
| animation | foundation, physics, scheduler, semantics | 8 文件 / 5.2k 行 |
| services | foundation, gestures, scheduler | 52 文件 / 30.2k 行 |
| semantics | foundation, services, painting, scheduler | 5 文件 / 7.8k 行 |
| rendering | foundation, semantics, animation, gestures, services, scheduler, painting | 48 文件 / 52.0k 行 |
| widgets | foundation, rendering, services, gestures, scheduler, painting, physics, animation, semantics | 186 文件 / 156.3k 行 |
| material / cupertino | widgets 及其余各层 | 250 文件 / 259.1k 行 |

第一层内部没有互相引用：`painting` 依赖 `services` 与 `gestures`，但都是单向的（`services`、`gestures` 都不回头依赖 `painting`），所以六个层之间是一张 DAG。全图唯一的技术性环来自 `animation/curves.dart:11`——为 dartdoc 链接而 `import 'package:flutter/cupertino.dart'`，代码零使用。阅读顺序按依赖强度和必要性排：

```text
foundation
    ↓
physics → painting → scheduler → animation → gestures → services → semantics
    ↓
rendering
    ↓
widgets
    ↓
material / cupertino
```

## 篇目总表

| 卷 | 篇 | 标题 | 核心内容 |
|---|---|---|---|
| 00 导读 | 00 | [导读：为什么从 foundation 往上读](00%20导读：为什么从%20foundation%20往上读.md) | 阅读顺序的动机、分层地图的来源与核心对象预告 |
| 01 foundation | 01 | [foundation 层地图：42 个文件的分区与边界](01%20foundation%20层地图：42%20个文件的分区与边界.md) | foundation 五分区职责、条件导入与依赖方向 |
| 01 foundation | 02 | [Key：Element 身份契约的最小实现](02%20Key：Element%20身份契约的最小实现.md) | Key 只提供相等性，比较由 canUpdate 决定 |
| 01 foundation | 03 | [树骨架协议：AbstractNode 废弃后 depth 与 owner 去了哪](03%20树骨架协议：AbstractNode%20废弃后%20depth%20与%20owner%20去了哪.md) | AbstractNode 废弃后 depth 与 owner 落到三份树协议上 |
| 01 foundation | 04 | [ChangeNotifier：通知模型与重入防御](04%20ChangeNotifier：通知模型与重入防御.md) | 通知模型与重入、重入中删除的防御 |
| 01 foundation | 05 | [ValueNotifier 与 ObserverList：两种观察者容器](05%20ValueNotifier%20与%20ObserverList：两种观察者容器.md) | 两种观察者容器的去重与通知判据 |
| 01 foundation | 06 | [集合与持久化容器：collections 与 PersistentHashMap](06%20集合与持久化容器：collections%20与%20PersistentHashMap.md) | 集合工具与 PersistentHashMap 的结构共享 |
| 01 foundation | 07 | [BindingBase 与平台常量：框架认为自己在哪运行](07%20BindingBase%20与平台常量：框架认为自己在哪运行.md) | BindingBase 把单槽位 dart:ui 接口变成多监听者服务 |
| 02 physics | 08 | [physics 层地图：Simulation 与三种仿真](08%20physics%20层地图：Simulation%20与三种仿真.md) | Simulation 接口与三种仿真的职责分工 |
| 02 physics | 09 | [一次抛滑的数值过程：ClampingScrollSimulation 与 SpringSimulation](09%20一次抛滑的数值过程：ClampingScrollSimulation%20与%20SpringSimulation.md) | 抛滑在构造函数里算完，每帧只代入时间 |
| 03 painting | 10 | [painting 层地图与 dart:ui 边界](10%20painting%20层地图与%20dart:ui%20边界.md) | painting 六分区与 dart:ui 边界上的转发与遮挡 |
| 03 painting | 11 | [EdgeInsets 与几何代数：方向解耦的四边距](11%20EdgeInsets%20与几何代数：方向解耦的四边距.md) | 方向解耦的四边距与 resolve 时机 |
| 03 painting | 12 | [Alignment：对齐是一个函数](12%20Alignment：对齐是一个函数.md) | 对齐是「剩余空间怎么分」的函数 |
| 03 painting | 13 | [Color 与颜色管线：ColorSpace 与颜色合成](13%20Color%20与颜色管线：ColorSpace%20与颜色合成.md) | ColorSpace 换算与颜色组织成色板 |
| 03 painting | 14 | [Decoration 与 BoxPainter：绘制的最小契约](14%20Decoration%20与%20BoxPainter：绘制的最小契约.md) | Decoration 与 BoxPainter 的两半绘制契约 |
| 03 painting | 15 | [TextPainter 与 Paragraph：文本如何变成可布局对象](15%20TextPainter%20与%20Paragraph：文本如何变成可布局对象.md) | 可变门面与不可变成品之间的两层缓存 |
| 03 painting | 16 | [ImageProvider 与 ImageStream：一次异步解码的全过程](16%20ImageProvider%20与%20ImageStream：一次异步解码的全过程.md) | 配置变 key、去重、推送、排帧的四类分工 |
| 04 scheduler | 17 | [scheduler 层地图与 SchedulerPhase](17%20scheduler%20层地图与%20SchedulerPhase.md) | 四张回调表与 SchedulerPhase 自检标尺 |
| 04 scheduler | 18 | [一帧的五个阶段：handleBeginFrame 到 handleDrawFrame](18%20一帧的五个阶段：handleBeginFrame%20到%20handleDrawFrame.md) | 引擎给的两个阶段与 framework 自切的三段 |
| 04 scheduler | 19 | [Ticker 与 vsync：帧回调的注册与注销](19%20Ticker%20与%20vsync：帧回调的注册与注销.md) | 帧回调的注册注销、mute 与两种「停」 |
| 05 animation | 20 | [animation 层地图：Animation 与 Animatable 的接口分层](20%20animation%20层地图：Animation%20与%20Animatable%20的接口分层.md) | Animation 是值源而非时间源的接口分层 |
| 05 animation | 21 | [AnimationController：从 _tick 到 value](21%20AnimationController：从%20_tick%20到%20value.md) | elapsed 喂 Simulation 与收尾判定 |
| 05 animation | 22 | [Curve 与 Simulation 的桥接：动画曲线如何变成物理仿真](22%20Curve%20与%20Simulation%20的桥接：动画曲线如何变成物理仿真.md) | `_InterpolationSimulation` 把曲线裹成仿真 |
| 06 gestures | 23 | [gestures 层地图：events、binding、arena、recognizer](23%20gestures%20层地图：events、binding、arena、recognizer.md) | 事件从哪来、送到谁、谁赢 |
| 06 gestures | 24 | [GestureBinding 与 hitTest：一次 PointerDown 的完整路径](24%20GestureBinding%20与%20hitTest：一次%20PointerDown%20的完整路径.md) | PointerDown 的单位换算、建 path 与逐 entry 派发 |
| 06 gestures | 25 | [GestureArena 与 TapGestureRecognizer：从原始事件到 onTap](25%20GestureArena%20与%20TapGestureRecognizer：从原始事件到%20onTap.md) | 竞技场数票与 onTap 的产生 |
| 07 services | 26 | [services 层地图与 ServicesBinding](26%20services%20层地图与%20ServicesBinding.md) | BinaryMessenger 三个方法与 @Native 的管子 |
| 07 services | 27 | [MethodChannel 与 MessageCodec：一次方法调用穿过的层](27%20MethodChannel%20与%20MessageCodec：一次方法调用穿过的层.md) | 方法调用被压成字节后穿过的层 |
| 07 services | 28 | [PlatformDispatcher 与系统通道：AssetBundle 与 SystemChannels](28%20PlatformDispatcher%20与系统通道：AssetBundle%20与%20SystemChannels.md) | AssetBundle 与 SystemChannels 两条链的同一处 @Native |
| 07 semantics | 29 | [Semantics 树：配置如何从 RenderObject 生成](29%20Semantics%20树：配置如何从%20RenderObject%20生成.md) | 语义树作为渲染树的投影与 isSemanticBoundary |
| 08 rendering | 30 | [rendering 层地图与三棵树总览](30%20rendering%20层地图与三棵树总览.md) | PipelineOwner 入口、三棵树与 Layer 输出 |
| 08 rendering | 31 | [RenderObject 协议：layout、paint、hitTest 与 parentData](31%20RenderObject%20协议：layout、paint、hitTest%20与%20parentData.md) | layout、paint、hitTest 与 parentData 数据通道 |
| 08 rendering | 32 | [脏传播：markNeedsLayout 与 relayoutBoundary](32%20脏传播：markNeedsLayout%20与%20relayoutBoundary.md) | 三张脏表、三个边界判据与处理方向 |
| 08 rendering | 33 | [BoxConstraints 模型与约束向下尺寸向上](33%20BoxConstraints%20模型与约束向下尺寸向上.md) | 约束区间与 enforce、tighten、deflate 的让步关系 |
| 08 rendering | 34 | [RenderFlex：flex 分配与 overflow 判定](34%20RenderFlex：flex%20分配与%20overflow%20判定.md) | 两趟 `_computeSizes` 的份额分配与 paint 期 overflow 报告 |
| 08 rendering | 35 | [Layer 树与合成：RepaintBoundary 什么时候真的省事](35%20Layer%20树与合成：RepaintBoundary%20什么时候真的省事.md) | RepaintBoundary 的收益条件与量化指标 |
| 09 widgets 构建协议 | 36 | [widgets 层地图：186 个文件的分区](36%20widgets%20层地图：186%20个文件的分区.md) | 17 个协议文件与 169 个翻译官的分区 |
| 09 widgets 构建协议 | 37 | [Widget 与 Element 与 BuildContext：配置和身份的分工](37%20Widget%20与%20Element%20与%20BuildContext：配置和身份的分工.md) | 配置与身份的分工，context 就是 this |
| 09 widgets 构建协议 | 38 | [inflateWidget 与 updateChild：Element 复用判定](38%20inflateWidget%20与%20updateChild：Element%20复用判定.md) | 复用判定与失配后的搬迁 |
| 09 widgets 构建协议 | 39 | [Key 与 Element identity：canUpdate 与 GlobalKey 注册表](39%20Key%20与%20Element%20identity：canUpdate%20与%20GlobalKey%20注册表.md) | canUpdate 与 GlobalKey 注册表的搬运 |
| 09 widgets 构建协议 | 40 | [ComponentElement 与 performRebuild：Stateless 和 Stateful 的分野](40%20ComponentElement%20与%20performRebuild：Stateless%20和%20Stateful%20的分野.md) | Stateless 与 Stateful 的重建路径分野 |
| 09 widgets 构建协议 | 41 | [State 生命周期：钩子由谁在何时调用](41%20State%20生命周期：钩子由谁在何时调用.md) | 九个生命周期钩子的调用者与时机 |
| 09 widgets 构建协议 | 42 | [setState 与 BuildOwner：脏列表与 buildScope](42%20setState%20与%20BuildOwner：脏列表与%20buildScope.md) | 脏列表所属的 BuildScope 与 buildScope 冲刷时机 |
| 09 widgets 构建协议 | 43 | [InheritedWidget：依赖注册与通知](43%20InheritedWidget：依赖注册与通知.md) | 依赖注册的三件事与 markNeedsBuild 通知 |
| 09 widgets 构建协议 | 44 | [RenderObjectElement：Widget 树挂上 RenderObject 树](44%20RenderObjectElement：Widget%20树挂上%20RenderObject%20树.md) | `_ancestorRenderObjectElement` 与 attachRenderObject 收敛点 |
| 10 widgets 应用协议 | 45 | [Scrollable 与 ScrollPosition：滚动位置的真正持有者](45%20Scrollable%20与%20ScrollPosition：滚动位置的真正持有者.md) | 位置持有者与 controller 的广播站角色 |
| 10 widgets 应用协议 | 46 | [ScrollActivity 与 ScrollPhysics：滚动状态机与物理](46%20ScrollActivity%20与%20ScrollPhysics：滚动状态机与物理.md) | 状态机要帧、物理只要一次调用 |
| 10 widgets 应用协议 | 47 | [Viewport 与 Sliver 协议：SliverConstraints 与 SliverGeometry](47%20Viewport%20与%20Sliver%20协议：SliverConstraints%20与%20SliverGeometry.md) | SliverConstraints 向下、SliverGeometry 向上的一次往返 |
| 10 widgets 应用协议 | 48 | [懒加载：SliverMultiBoxAdaptor 与 cacheExtent](48%20懒加载：SliverMultiBoxAdaptor%20与%20cacheExtent.md) | cacheExtent 算出的偏移区间与 keepAlive 回收 |
| 10 widgets 应用协议 | 49 | [Navigator 与 Route 与 Overlay：页面为什么能叠起来](49%20Navigator%20与%20Route%20与%20Overlay：页面为什么能叠起来.md) | 三层的职责边界与叠放顺序 |
| 10 widgets 应用协议 | 50 | [WidgetsBinding：把三棵树接进一帧](50%20WidgetsBinding：把三棵树接进一帧.md) | mixin 覆写链与 super.drawFrame 的缝合点 |
| 11 收尾 | 51 | [material 抽样下潜：Material 与 InkWell 的完整链路](51%20material%20抽样下潜：Material%20与%20InkWell%20的完整链路.md) | Material 与 InkWell 在已有原语上的重组 |
| 11 收尾 | 52 | [全局地图：从 main 到 GPU](52%20全局地图：从%20main%20到%20GPU.md) | framework 能决定的部分与边界之外的帧和像素 |
| 12 常用组件精读 | 53 | [基础布局组件：Center 与 Row 与 Column 的装配链路](53%20基础布局组件：Center%20与%20Row%20与%20Column%20的装配链路.md) | Center/Align 与 Flex 两套摆法，Expanded 只写 ParentData |
| 12 常用组件精读 | 54 | [SingleChildScrollView：最朴素的滚动容器](54%20SingleChildScrollView：最朴素的滚动容器.md) | box 视口一次性铺开与借用 Scrollable 的代价 |
| 12 常用组件精读 | 55 | [CustomScrollView：把 sliver 组装权交给调用方](55%20CustomScrollView：把%20sliver%20组装权交给调用方.md) | slivers 组装权与 ShrinkWrappingViewport 的选择 |
| 12 常用组件精读 | 56 | [NestedScrollView：内外两套 ScrollPosition 的协调](56%20NestedScrollView：内外两套%20ScrollPosition%20的协调.md) | 两套 `_NestedScrollPosition` 的 delta 分配与 extent 传递 |
| 12 常用组件精读 | 57 | [RefreshIndicator：material 层的下拉刷新状态机](57%20RefreshIndicator：material%20层的下拉刷新状态机.md) | 通知累积成 `_dragOffset`、0.25 阈值与 displacement 的各自作用 |
| 13 留白补全 | 58 | [Gradient 与 ShapeDecoration：装饰如何变成 Shader 与笔刷](58%20Gradient%20与%20ShapeDecoration：装饰如何变成%20Shader%20与笔刷.md) | 渐变按当前 rect 现场求值成 Shader 与两个平级 Decoration 的能力分界 |
| 13 留白补全 | 59 | [焦点系统：FocusNode 树与 FocusManager 的注册分发](59%20焦点系统：FocusNode%20树与%20FocusManager%20的注册分发.md) | 并行 FocusNode 树、延迟提交的 FocusManager 与按几何排序的 Tab 顺序 |
| 13 留白补全 | 60 | [RenderSliverGrid 与 RenderTable：两种网格的布局算法](60%20RenderSliverGrid%20与%20RenderTable：两种网格的布局算法.md) | 索引公式现算的网格几何与全表一次解列宽的表格求解 |

扩充计划不占文章编号：后续想补什么、已补到哪，统一放在 [../源码计划/源码阅读系列后续扩充计划.md](../源码计划/源码阅读系列后续扩充计划.md)，编号正文只写内容本体。

## 版本差异速查

写作过程中反复撞到"流传很广的说法"与 3.44.8 源码不一致的地方，按篇号列在这里，便于单独核对：

| 篇 | 发现 |
|---|---|
| 03 | `AbstractNode` 已 `@Deprecated`，且整个 SDK 只有它自己的文件提到它——"Element 和 RenderObject 都继承 AbstractNode"已是过时信息 |
| 08 | `physics/` 里没有 `clamping_scroll_simulation.dart`；`ClampingScrollSimulation` 住在 `widgets/scroll_simulation.dart:164` |
| 10 | `painting/colors.dart` 里既没有 `Color` 也没有 `Colors`——只有 `HSVColor` / `HSLColor` / `ColorSwatch` |
| 16 | `MemoryImage.==` 按 `Uint8List` 的**身份**比较，不是按字节内容；而 `FileImage` 比的是路径字符串——同类 API 的相等策略并不统一 |
| 19 | `scheduler/ticker.dart` 里没有 "vsync"：vsync 不是一种信号，`Ticker` 只用 `SchedulerBinding` 的四个方法 |
| 21 | `fling` 的默认弹簧是 `overDamped`，与源码注释写的 `criticallyDamped` 相反（浮点误差导致类型判定落进另一个分支） |
| 22 | `animateTo(curve:)` 的曲线**不经过** `CurveTween`（`animation_controller.dart` 里没有 `CurveTween`） |
| 23 / 24 | `_PointerState` 在整个仓库里不存在；3.44.8 的 `PointerEventConverter` 是无状态的 |
| 26 / 27 | `ChannelBuffers` 来自 `dart:ui`，framework 里没有 `services/channel_buffers.dart`；`ServicesBinding.handlePlatformMessage` 已废弃 |
| 28 | `flutter/assets` 通道名是 `PlatformAssetBundle` 里的硬编码字符串，不在 `SystemChannels` 里 |
| 31 | `RenderProxyBox` 不分配 `BoxParentData`（源码注释写明"避免这次分配"），所以"所有 box 孩子都有 `BoxParentData`"不成立 |
| 33 | `BoxConstraints` 没有 `inflate`（只有 `deflate`）；`hasInfiniteWidth` 不等于"宽度无上界" |
| 34 | `RenderFlex` 的 overflow 报错一辈子只打印一次，只有热重载（`reassemble`）才会重置 |
| 41 | `dispose` 里读 `context.widget` 会抛异常——`Element.unmount` 先把 `_widget` 置空，而 `State.mounted` 仍是 `true` |
| 42 | `_dirtyElements` 不在 `BuildOwner` 上，而在 3.44.8 新增的 `BuildScope` 上 |
| 45 | `cacheExtent` / `cacheExtentStyle` 在 3.44.8 已 `@Deprecated`，替代品是单个 `scrollCacheExtent` |
| 48 | `ListView.builder` 传了 `itemExtent` 时用的是 `SliverFixedExtentList`，**不继承** `RenderSliverList`；`RenderSliver` 没有 `size` 字段 |
| 53 | `Center` 不是独立组件：它是 `Align` 的子类（`basic.dart:2550`），类体只有一行构造函数，渲染树里只有 `Align` 一直在用的 `RenderPositionedBox`；`Row` / `Column` 也只是同一个 `Flex` 换了 `Axis` 的别名，不是两套机制 |
| 53 | `Flexible` / `Expanded` 是 `ParentDataWidget`，**不产生任何 RenderObject**——渲染树里 `Row > Expanded > child` 就是 `RenderFlex > child`，它们的全部工作是把 `flex` / `fit` 写进孩子的 `FlexParentData` |
| 54 | `SingleChildScrollView` 是 `StatelessWidget`，但滚动位置机制与 `ListView` 完全共用（`Scrollable` → `ScrollPosition`）；内容侧是 `RenderBox` 视口 `_RenderSingleChildViewport`，文件里没有 `cacheExtent`——"无状态所以位置一定在外部"与"它也能省着建"两头都不成立 |
| 55 | 往 `CustomScrollView.slivers` 里塞 `Container` **不会**编译失败：这个字段的静态类型就是 `List<Widget>`（`scroll_view.dart:845`），拒绝它的是渲染树装配时的 debug 断言，不是类型检查 |
| 55 | `NeverScrollableScrollPhysics` 只禁止用户拖动（`scroll_physics.dart:979`），不改变构建范围；`shrinkWrap: true` 选中的 `ShrinkWrappingViewport` 在外层给出无界主轴约束时反而会把内容全部构建——"两个开关合起来就等于取消懒加载"不成立 |
| 56 | `_NestedScrollCoordinator` 的 `setPixels` 是 `assert(false)`（`nested_scroll_view.dart:1023`）：delta 分配不走 `setPixels`，而走 `forcePixels` + `didUpdateScrollPositionBy` |
| 57 | 下拉刷新的触发阈值与 `displacement` 无关：`_checkDragOffset`（`refresh_indicator.dart:517`）读的是 `viewportDimension × 0.25`（`:519`），`displacement` 只在 build 的 `Padding` 里出现（`:654-655`），它决定的是圆环停靠位置 |
| 57 | `_handleScrollNotification` 结尾固定 `return false`（`:483`）：`RefreshIndicator` 内置的监听器不截断任何通知冒泡，外层自己套的监听器照样能收到完整序列 |
| 58 | 渐变不是"画出来的一张图"：`Gradient` 是不可变的参数描述，`createShader(rect)` 在 paint 当场按当前 rect 求值出 `Shader`；`BoxDecoration` 与 `ShapeDecoration` 是 `Decoration` 的平级实现、能力集互有缺口，不是"通用版 vs 特例版" |
| 59 | 3.44.8 的 `widgets/` 下没有 `focus_node.dart`：`FocusNode` / `FocusScopeNode` / `FocusManager` 同在 `focus_manager.dart`；也不存在名为 `FocusTraversal` 的类，遍历策略基类叫 `FocusTraversalPolicy` |
| 59 | `requestFocus` 是"申请—延迟提交"：请求只标记 `_markedForFocus`，microtask 里 `applyFocusChangesIfNeeded` 才统一生效，调用后立刻读 `hasFocus` 拿到的是旧值；`FocusManager` 上也没有公开的节点注册 API，`registerGlobalHandlers` 注册的是全局输入 handler，是另一件事 |
| 60 | `GridView` 的核心只有**一个** `SliverGrid`，"几列就是几个列表"不成立；格子位置由 `index % crossAxisCount` 与 `index ~/ crossAxisCount` 两条整数公式现算（没有预物化的查表 API），孩子拿到的是 tight 约束 |
| 60 | `Table` 不等价于 Column 嵌套 Row：`RenderTable` 是单个 RenderBox、孩子按行优先一维存放，先全表一次解列宽、再在 `performLayout` 里内联求行高（没有 `computeRowHeights`），dry layout 直接声明无法计算 |

## 单篇结构

正文篇通常固定八节，读的时候可以跳读，写的时候不许省：

```text
一、问题        一句话问题 + 一个常见错误直觉
二、最小 Demo   可运行代码（带步骤编号注释）
三、入口锚点    file:line 表，3～8 个
四、调用链      逐跳展开，每跳写清谁调用谁、传了什么、返回什么
五、核心对象    只做 A vs B 的职责对比
六、源码实验    改什么 → 预测 → 实际 → 说明
七、结论        3 条结论 + 小结
八、边界声明    今天不追什么，交给哪一卷
```

第八节是刻意的。源码阅读最重要的能力是**控制研究边界**，模板把这件事固化下来。

## 三条写作约定

1. **只写 3.44.8 源码能证明的结论。** 每个行为判断都能在 SDK 源码里找到依据；"源码依据"与"实测"分开标注，没有跑过的就不写"实测"。
2. **按分层组织内容。** 对每个主题聚焦层内定位与调用链，避免重复展开相同结论。
3. **这个系列不写单元测试。** 源码教程的结论依据是 SDK 源码本身，不靠单元测试兜底；`flutter_doc_test` 的验证流程不适用于这个系列。文中的 Demo 用于动手对照调用栈，不是测试用例。
