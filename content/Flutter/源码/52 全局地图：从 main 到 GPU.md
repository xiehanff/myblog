# 52 全局地图：从 main 到 GPU

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · Dart 3.12.2 · Engine revision 0cd610717b
> 源码路径 `packages/flutter/lib/src`（framework，本文只用锚点）；`bin/cache/pkg/sky_engine/lib/ui/`（dart:ui 的 Dart 侧声明，随 SDK 分发）

## 一、问题

前面 51 篇把 framework 从 `foundation` 一路读到了 `material`。但把它们拼起来时，会撞上一个很实际的问题：

**`main()` 里的第一行到最后屏幕上的第一个像素之间，到底有多少段？每段归谁管？哪一段这个系列讲过了、哪一段本地根本没有源码？**

最常见的两种错误直觉：

第一种是把 `dart:ui` 当成"引擎的黑盒"。实际上 `dart:ui` 的**Dart 侧声明是随 SDK 一起分发的本地文件**（`bin/cache/pkg/sky_engine/lib/ui/`，19 个文件），里面写着完整的类、方法、文档；只有方法的**实现**是 `@Native` 外部函数，指向引擎 C++。

第二种是把"从 `runApp` 到 GPU"当成一条直线。实际它有**两个转折点**：`runApp` 之后并不立刻建树（走的是 `Timer.run`），而"一帧"不是由 framework 自己循环驱动的（由引擎回调 `onBeginFrame` / `onDrawFrame` 触发）。这两处转折决定了"什么时候树才存在"和"动画为什么能驱动重绘"。

本文只给地图和指路。第 45–51 篇已经把每一段的机制讲完了，这一篇的价值是**把段与段之间的接口写清楚**，以及**明确哪些段在本地磁盘上不存在**。

## 二、最小 Demo

一条能打印出"我走到了哪一段"的最小程序。它同时在三个位置打点：

```dart
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

void main() {
  // 1. 段 1：binding 建立（一次性，7 个 mixin 的 initInstances 依次跑）
  final WidgetsBinding binding = WidgetsFlutterBinding.ensureInitialized();
  debugPrint('1 binding ready: ${binding.runtimeType}');

  // 2. 段 2：根 Element 是否已存在？（runApp 之后也是 false，因为挂根走 Timer）
  debugPrint('2 rootElement=${binding.rootElement}');

  // 3. 段 3：一帧的两半 —— onBeginFrame 与 onDrawFrame 是引擎回调
  binding.addPersistentFrameCallback((Duration t) {
    debugPrint('3 persistent, phase=${SchedulerBinding.instance.schedulerPhase}');
  });
  binding.addPostFrameCallback((Duration t) {
    debugPrint('4 postFrame done, phase=${SchedulerBinding.instance.schedulerPhase}');
    // 5. 段 5：Scene 已经交给引擎了（这一步之后 framework 无法再观测）
    final RenderView view = binding.renderViews.first;
    debugPrint('5 renderView layer=${view.layer.runtimeType}');
  });

  binding.scheduleAttachRootWidget(
    // 6. 挂根前必须先包一层 View —— runApp 内部就是 wrapWithDefaultView(app)，
    //    不包的话第一个 RenderObjectElement 找不到渲染树根，挂载即报错（见第六节实验 2 的坑）
    binding.wrapWithDefaultView(
      Builder(
        builder: (BuildContext context) {
          debugPrint('0 build! phase=${SchedulerBinding.instance.schedulerPhase}');
          return const SizedBox.shrink();
        },
      ),
    ),
  );
  binding.scheduleWarmUpFrame();
}
```

这段程序的两个问题是这一篇的核心，答案都在第六节的实验里：

1. **第 2 步打印的 `rootElement` 是 null 吗？** 是（实验 2）。`scheduleAttachRootWidget` 内部是 `Timer.run`，`runApp` 返回时树还不存在。
2. **`build` 与第 3 步注册的 persistent callback 谁先跑？** build 先（实验 3）。因为 `buildScope` 是 `drawFrame` 的第一步，而 `drawFrame` 由 `RendererBinding.initInstances` 注册的第一个 persistent callback 触发，我们注册的排在它后面。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `packages/flutter/lib/src/foundation/binding.dart:148` | `abstract class BindingBase`，所有 binding 的基类 |
| `packages/flutter/lib/src/foundation/binding.dart:100` | `initInstances` 的文档示例，说明"每个 mixin 覆写它" |
| `packages/flutter/lib/src/widgets/binding.dart:2128` | `class WidgetsFlutterBinding extends BindingBase with ...`，7 个 mixin 的组合点 |
| `packages/flutter/lib/src/widgets/binding.dart:2149` | `static WidgetsBinding ensureInitialized()` |
| `packages/flutter/lib/src/widgets/binding.dart:1883` | `void runApp(Widget app)` |
| `packages/flutter/lib/src/widgets/binding.dart:1948` | `void _runWidget(...)`，`scheduleAttachRootWidget` + `scheduleWarmUpFrame` |
| `packages/flutter/lib/src/widgets/binding.dart:1657` | `scheduleAttachRootWidget`，`Timer.run` 里挂根 |
| `packages/flutter/lib/src/widgets/binding.dart:2005` | `RootWidget.attach`，第一棵 Element 树的诞生 |
| `packages/flutter/lib/src/scheduler/binding.dart:888` | `ensureFrameCallbacksRegistered`，`platformDispatcher.onBeginFrame = _handleBeginFrame` |
| `packages/flutter/lib/src/scheduler/binding.dart:1226` | `handleBeginFrame`，transient callbacks |
| `packages/flutter/lib/src/scheduler/binding.dart:1338` | `handleDrawFrame`，persistent + post-frame |
| `packages/flutter/lib/src/widgets/binding.dart:1536` | `WidgetsBinding.drawFrame`，build 与 layout 的接缝 |
| `packages/flutter/lib/src/rendering/binding.dart:642` | `RendererBinding.drawFrame`（被上一条 `super` 调用） |
| `packages/flutter/lib/src/rendering/view.dart:347` | `RenderView.compositeFrame`，Layer 树 → Scene |
| `packages/flutter/lib/src/rendering/layer.dart:1118` | `ContainerLayer.buildScene(ui.SceneBuilder builder)` |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:878` | `void scheduleFrame() => _scheduleFrame();`（dart:ui 侧） |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:880` | `@Native<...>(symbol: 'PlatformConfigurationNativeApi::ScheduleFrame')`，**边界外的入口名** |
| `bin/cache/pkg/sky_engine/lib/ui/window.dart:380` | `void render(Scene scene, {Size? size})`（`FlutterView`，dart:ui 侧） |
| `bin/cache/pkg/sky_engine/lib/ui/window.dart:389` | `@Native<...>(symbol: 'PlatformConfigurationNativeApi::Render')`，**边界外的另一个入口名** |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:422` / `440` | `set onBeginFrame` / `set onDrawFrame`，引擎回调的注册处 |

## 四、调用链

### 4.1 总图：从 `main()` 到 GPU

<figure class="diagram-scroll"><img src="./52 全局地图：从 main 到 GPU.assets/main-to-gpu-complete.svg" alt="从 main 到 GPU 的完整调用链：framework 与 engine 双泳道、挂根和 warm-up 分支、三个跨边界点及 drawFrame 全部阶段"></figure>

图里只有三处"跨边界"：
1. `platformDispatcher.scheduleFrame()` → `PlatformConfigurationNativeApi::ScheduleFrame`（要帧）
2. `PlatformDispatcher.onBeginFrame` / `onDrawFrame` 被引擎调用（**帧从外面来**）
3. `_view.render(scene, ...)` → `PlatformConfigurationNativeApi::Render`（交画面）

常规 vsync 帧由引擎回调驱动——framework **不驱动帧**，它只是"要求一帧"然后"等引擎叫它"。所有"每 16.7ms 跑一次"的说法都要落在这条线上：是引擎在 vsync 信号后回调 `onBeginFrame` / `onDrawFrame`，framework 在回调里跑 build/layout/paint。`scheduleFrame()` 只是"告诉引擎下次 vsync 请叫我"。启动/热重载的 warm-up frame 是例外：它由 framework 的 `scheduleWarmUpFrame`（`scheduler/binding.dart:1037`）直接触发 `handleBeginFrame` / `handleDrawFrame`，不等待 vsync（调用点：启动 `widgets/binding.dart:1952`、热重载 `rendering/binding.dart:670`）。

### 4.2 段 1：binding 的建立（一次，不可逆）

```dart
// widgets/binding.dart:2128-2136
class WidgetsFlutterBinding extends BindingBase
    with
        GestureBinding,
        SchedulerBinding,
        ServicesBinding,
        PaintingBinding,
        SemanticsBinding,
        RendererBinding,
        WidgetsBinding {
```

这里"7 个 mixin"不是修辞——每个 mixin 的 `initInstances` 都会在自己的构造函数链里跑一次，**顺序等于 `with` 子句的顺序**（子句靠后的先被覆写、构造时从基类往上跑）。所以 `WidgetsFlutterBinding()` 这一句会依次完成：

| 顺序 | mixin | 干了什么 | 展开位置 |
|---|---|---|---|
| 1 | `GestureBinding` | 接管平台指针事件、`hitTest` 入口 | 卷 6（23–25） |
| 2 | `SchedulerBinding` | 定义 `onBeginFrame` / `onDrawFrame` 的接线、三个回调列表 | 卷 4（17–19） |
| 3 | `ServicesBinding` | `defaultBinaryMessenger`、平台通道、`LifecycleState` | 卷 7（26–29） |
| 4 | `PaintingBinding` | `ImageCache`、`ShaderWarmUp` | 卷 3（10–16） |
| 5 | `SemanticsBinding` | 语义开关、`AccessibilityFeatures` | 卷 7（26–29） |
| 6 | `RendererBinding` | 建 `PipelineOwner`、注册驱动一帧的 persistent frame callback（`rendering/binding.dart:61`；另一个注册点 `widget_inspector.dart:1078` 仅 debug 生效） | 卷 8（30–35） |
| 7 | `WidgetsBinding` | 建 `BuildOwner`、`runApp`、`RootWidget` / `RootElement` | 卷 9（36–44）+ 本篇 50 |

第 6 步注册的那个 callback 是这个系列的一个关键锚点：

```dart
// rendering/binding.dart:61
addPersistentFrameCallback(_handlePersistentFrameCallback);
// rendering/binding.dart:508-511
void _handlePersistentFrameCallback(Duration timeStamp) {
  drawFrame();
  _scheduleMouseTrackerUpdate();
}
```

**整条 build→layout→paint 流水线，全部发生在这一个 callback 里。**

### 4.3 段 2：`runApp` 之后树还不存在

```dart
// widgets/binding.dart:1657-1661
void scheduleAttachRootWidget(Widget rootWidget) {
  Timer.run(() {
    attachRootWidget(rootWidget);
  });
}
```

这是全篇最容易踩的一个时序陷阱。完整的"树如何诞生"链条是：

```text
runApp(app)
 └─ wrapWithDefaultView(app)             widgets/binding.dart:1628
      └─ View(view: implicitView, child: app)     ← 唯一会创建 RenderView 的 widget
 └─ _runWidget(...)                      widgets/binding.dart:1948
      ├─ scheduleAttachRootWidget  →  Timer.run(attachRootWidget)
      └─ scheduleWarmUpFrame       →  立刻跑一帧（不等 vsync）
 └─ Timer 触发
      └─ attachRootWidget → attachToBuildOwner(RootWidget(...))   :1672 / :1685
           └─ RootWidget.attach(buildOwner, null)                  :2005
                ├─ owner.lockState(() => element.assignOwner(owner))
                ├─ owner.buildScope(element, () => element.mount(null, null))
                └─ 树建成，_rootElement != null
```

所以：**`runApp` 返回时 `rootElement == null`，`View` 已经建好了 `RenderView`（它注册进了 `RendererBinding.renderViews`），而 Element 树要等一个 Timer。** `scheduleWarmUpFrame` 之所以存在，是为了让首帧不必等 vsync 信号——否则启动会额外多花一帧的时间。

### 4.4 段 3–4：一帧的两半（引擎的两次回调）

```dart
// scheduler/binding.dart:888-891
void ensureFrameCallbacksRegistered() {
  platformDispatcher.onBeginFrame ??= _handleBeginFrame;
  platformDispatcher.onDrawFrame ??= _handleDrawFrame;
}
```

这两行是 framework 与引擎之间**唯一**的"帧入口"接线。之后：

- `handleBeginFrame`（`:1226`）→ `SchedulerPhase.transientCallbacks` → 跑完所有 Ticker 的 tick。动画推进位置、`AnimationController` 通知 listener、listener 里可能 `setState` 或 `markNeedsPaint`。
- `handleDrawFrame`（`:1338`）→ `SchedulerPhase.persistentCallbacks` → 跑 `drawFrame`；然后 `SchedulerPhase.postFrameCallbacks` → 跑收尾。

**为什么要分成两半**？因为"改状态"和"渲染状态"必须分开：transient 阶段允许 `setState`（此时还没开始 build），persistent 阶段不允许（`setPixels` 里的断言就是为此）。第 4 卷第 18 篇已完整展开这五个阶段，本文只标出它在整条链上的位置。

### 4.5 段 5：八个步骤，两次"跨层"

```dart
// widgets/binding.dart:1569-1580（节选）
try {
  if (rootElement != null) {
    buildOwner!.buildScope(rootElement!);   // ① widgets：重建脏 Element
  }
  super.drawFrame();                        // ② → RendererBinding.drawFrame
  buildOwner!.finalizeTree();               // ⑧ widgets：卸载本帧 deactivate 的 Element
} finally { ... }
```

```dart
// rendering/binding.dart:642-654
void drawFrame() {
  rootPipelineOwner.flushLayout();          // ③ 布局（在这里 markNeedsPaint 会登记脏对象）
  rootPipelineOwner.flushCompositingBits(); // ④ 合成位
  rootPipelineOwner.flushPaint();           // ⑤ 绘制 → 产出 Layer 树
  if (sendFramesToEngine) {
    for (final RenderView renderView in renderViews) {
      renderView.compositeFrame();          // ⑥ Layer 树 → Scene → 引擎
    }
    rootPipelineOwner.flushSemantics();      // ⑦ 语义交给平台
    _firstFrameSent = true;
  }
}
```

八个步骤里有**两次跨层**：

| 步骤 | 层 | 产物 | 数据结构 |
|---|---|---|---|
| ① `buildScope` | widgets | 更新后的 Element 树 + 脏 RenderObject 列表 | `Element` 树 / `_dirtyElements` |
| ② → ③ `flushLayout` | rendering | 每个 RenderObject 的 `size` / `offset` | `RenderObject` 树 |
| ④ `flushCompositingBits` | rendering | 每个 RenderObject 的 `needsCompositing` | 同上 |
| ⑤ `flushPaint` | rendering | **Layer 树** | `Layer`（`rendering/layer.dart`） |
| ⑥ `compositeFrame` | rendering → dart:ui | **`ui.Scene`** | `Scene`（引擎持有 native 资源） |
| ⑦ `flushSemantics` | rendering → 平台 | `SemanticsUpdate` | 语义树 |
| ⑧ `finalizeTree` | widgets | 卸载被 deactivate 的 Element | `_inactiveElements` |

**两次跨层**是：
- **① → ③**：widgets 层的 build 产出"哪些 RenderObject 脏了"，交给 rendering 层处理。这一步没有显式数据传递，靠 `PipelineOwner` 的脏队列。
- **⑤ → ⑥**：rendering 层的 `Layer` 树转成 `ui.Scene`。这一步是**一次真实的类型转换**：

```dart
// rendering/view.dart:352-361（节选）
final ui.SceneBuilder builder = RendererBinding.instance.createSceneBuilder();
final ui.Scene scene = layer!.buildScene(builder);      // 1. Layer 树 → Scene
_view.render(scene, size: configuration.toPhysicalSize(size));   // 2. 交给引擎
scene.dispose();                                        // 3. Scene 有 native 生命周期
```

`Layer` 和 `Scene` 是两种不同的东西，不能当作同一个概念的两种叫法。`Layer` 是 Dart 对象，可以在帧之间复用（`LayerHandle`、`markNeedsAddToScene` 都是为复用服务的）；`Scene` 是一次性的成品，构建后立刻 `dispose()`。**它们的边界就是 framework 与 dart:ui 的边界。**

### 4.6 边界：`dart:ui` 的 Dart 侧在本地，实现在引擎里

这是本文最需要说清的一件事。`dart:ui` 也有本地可见的一半：

```bash
ls /Users/hax/fvm/default/bin/cache/pkg/sky_engine/lib/ui/
# annotations.dart  channel_buffers.dart  compositing.dart  geometry.dart  hooks.dart
# isolate_name_server.dart  key.dart  lerp.dart  math.dart  natives.dart  painting.dart
# platform_dispatcher.dart  platform_isolate.dart  plugins.dart  pointer.dart
# semantics.dart  text.dart  ui.dart  window.dart
```

19 个文件，随 SDK 分发，**有完整的类声明与文档**。例如：

```dart
// bin/cache/pkg/sky_engine/lib/ui/window.dart:380-391
void render(Scene scene, {Size? size}) {
  _render(viewId, scene as _NativeScene, size?.width ?? physicalSize.width, ...);
}

@Native<Void Function(Int64, Pointer<Void>, Double, Double)>(
  symbol: 'PlatformConfigurationNativeApi::Render',
)
external static void _render(int viewId, _NativeScene scene, double width, double height);
```

```dart
// bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:878-881
void scheduleFrame() => _scheduleFrame();

@Native<Void Function()>(symbol: 'PlatformConfigurationNativeApi::ScheduleFrame')
external static void _scheduleFrame();
```

**边界的位置非常精确**：本地能看到"调用了哪个 native 符号"（`PlatformConfigurationNativeApi::Render`），看不到这个符号背后的实现。

**边界之外有什么（本地磁盘上没有源码）**：

```bash
ls /Users/hax/fvm/default/bin/cache/artifacts/engine/darwin-x64/
# flutter_tester  font-subset  gen_snapshot_arm64  gen_snapshot_x64
# icudtl.dat  const_finder.dart.snapshot  frontend_server_aot.dart.snapshot  ...
```

`bin/cache/artifacts/engine/` 下只有**预编译产物**：`FlutterMacOS.xcframework`、`flutter_tester`、`gen_snapshot_*`、`const_finder.dart.snapshot`、`icudtl.dat`。没有 `.cc` / `.h`，没有 `source/` 目录。

| 边界之外的东西 | 作用 | 本地有源码吗 |
|---|---|---|
| `PlatformConfigurationNativeApi`（引擎 C++） | `Render` / `ScheduleFrame` / `FlutterView` 等 API 的实现 | **没有** |
| Shell / Animator（C++） | 与平台窗口系统对接、vsync、帧调度 | **没有** |
| Impeller / Skia | 把 `LayerTree` 光栅化成 GPU 命令 | **没有**。源码能确认的只有"双后端并存、运行时可查"：`sky_engine` 里有由引擎写入的 `_impellerEnabled` 标志（`ui/natives.dart:130`）与查询扩展 `ext.ui.window.impellerEnabled`（`:100`），`widgets/stretch_effect.dart:119` 标注"仅 Impeller 支持"。默认后端及平台覆盖范围不在 framework 源码可证明范围内，本文不下结论 |
| Dart VM（GC / JIT / AOT） | 执行 Dart 代码 | **没有**（`gen_snapshot_*` 是它的 AOT 编译器） |
| 平台 SDK（UIKit / Android View / Win32） | 呈现最终的 surface | **没有** |
| `sky_engine/lib/ui/` 的 Dart 声明 | 上述所有能力的类型化外壳 | **有**（19 个文件） |

读源码时遇到 `dart:ui`，正确做法是**把它当接口读，不当实现读**。`SceneBuilder`、`PictureRecorder`、`Canvas`、`Path`、`Paragraph` 这些类型的**用法**全部在本地可见（卷 3 painting 就是读它们），只是"像素最终怎么算出来"要出界。

## 五、核心对象：每一段在哪一篇展开

### 5.1 分段全景

| 段 | 内容 | 关键锚点 | 展开位置 |
|---|---|---|---|
| 1 | `main()` → binding 建立 | `widgets/binding.dart:2128` | 卷 1 篇 07（`BindingBase`）+ 本篇 50 |
| 2 | `runApp` → 包 `View` → 挂根 Element | `widgets/binding.dart:1883` / `:2005` | 本篇 50 |
| 3 | 要帧：`scheduleFrame` → 引擎 | `scheduler/binding.dart:946` | 卷 4 篇 18 |
| 4 | 引擎回调 → `handleBeginFrame` | `scheduler/binding.dart:1226` | 卷 4 篇 18 |
| 5 | `handleDrawFrame` → persistent callbacks | `scheduler/binding.dart:1338` | 卷 4 篇 18 + 本篇 50 |
| 6 | `buildScope`：Element 重建 | `widgets/framework.dart:3056` | 卷 9 篇 36–44 |
| 7 | `flushLayout` | `rendering/object.dart:1137` | 卷 8 篇 30–35 |
| 8 | `flushCompositingBits` | `rendering/object.dart:1239` | 卷 8 篇 30–35 |
| 9 | `flushPaint` → Layer 树 | `rendering/object.dart:1293` | 卷 8 篇 30–35 |
| 10 | `compositeFrame`：Layer → Scene | `rendering/view.dart:347` | 本篇（只到边界） |
| 11 | `_view.render(scene)` → 引擎 | `ui/window.dart:380` | **出界** |
| 12 | `flushSemantics` | `rendering/object.dart:1451` | 卷 7 篇 26–29 |
| 13 | `finalizeTree` | `widgets/framework.dart:3339` | 卷 9 |

### 5.2 按卷的阅读顺序与本文位置

| 卷 | 篇号 | 主题 | 在地图的哪一段 |
|---|---|---|---|
| 00 | 00 | 导读 | — |
| 01 | 01–07 | foundation 地基 | 段 1（`BindingBase` 与 `initInstances`） |
| 02 | 08–09 | physics：抛滑与弹簧 | 段 9 的输入（`Simulation`） |
| 03 | 10–16 | painting 与 dart:ui 边界 | 段 10–11 之间的另一侧（`Canvas` / `Path` / `TextPainter`） |
| 04 | 17–19 | scheduler：一帧的五个阶段、Ticker | 段 3–5 |
| 05 | 20–22 | animation：`AnimationController` / `Curve` | 段 4（transient callbacks 里跑的正是它） |
| 06 | 23–25 | gestures：hitTest / GestureArena | 段 5 之外的输入路径（指针事件不在一帧内） |
| 07 | 26–29 | services 与 semantics | 段 12 |
| 08 | 30–35 | rendering：三棵树、脏传播、Layer | 段 7–9、段 10 |
| 09 | 36–44 | widgets 构建协议 | 段 6、段 13 |
| 10 | 45–50 | widgets 应用协议（滚动 / 导航 / 一帧） | 全部落在段 5–6（build 与 layout 的边界上） |
| 11 | 51–52 | 收尾与地图 | 本篇 51（material 抽样）、52（本图）；手册任务对照与扩充计划在 ../源码计划/ |
| 12 | 53–57 | 常用组件精读 | 第 53 篇 Center/Row/Column（承接第 34 篇）；第 54 篇 SingleChildScrollView、第 55 篇 CustomScrollView、第 56 篇 NestedScrollView、第 57 篇 RefreshIndicator（承接第 45–48 篇） |
| 13 | 58–60 | 留白补全 | 第 58 篇 Gradient/ShapeDecoration；第 59 篇焦点系统；第 60 篇 RenderSliverGrid/RenderTable |

### 5.3 三次"数据结构转换"的位置

整条链上只有三次真正换数据结构，记住这三次就记住了地图：

| 转换 | 从 | 到 | 代码位置 | 谁做 |
|---|---|---|---|---|
| 第一次 | `Widget`（每次 build 都换新） | `Element`（长期存活） | `Element.updateChild` / `inflateWidget` | 卷 9 篇 36–41 |
| 第二次 | `Element`（有 build 逻辑） | `RenderObject`（只管 layout/paint） | `RenderObjectElement.mount` | 卷 9 篇 44 |
| 第三次 | `RenderObject`（有 layout/paint 方法） | `Layer`（只有绘制内容） | `RenderObject.paint` → `PaintingContext` | 卷 8 篇 35 |

外加一次出界的：`Layer` → `ui.Scene`（`ContainerLayer.buildScene`，`rendering/layer.dart:1118`）。

## 六、源码实验

### 实验 1：确认边界位置（本地有什么、没什么）

```bash
# 1. dart:ui 的 Dart 侧在本地，几个文件？
ls /Users/hax/fvm/default/bin/cache/pkg/sky_engine/lib/ui/ | wc -l

# 2. 边界有多宽？数一数 @Native 声明
grep -c "@Native" /Users/hax/fvm/default/bin/cache/pkg/sky_engine/lib/ui/*.dart

# 3. 引擎 C++ 源码在本地吗？
find /Users/hax/fvm/default -name "*.cc" | wc -l

# 4. 引擎产物目录里有什么？
ls /Users/hax/fvm/default/bin/cache/artifacts/engine/darwin-x64/
```

**预测**：Dart 侧声明应该在本地；C++ 应该只有二进制。

**实际**：

```text
1) 19                                    ← ui/ 下 19 个 dart 文件

2) channel_buffers.dart:1     compositing.dart:22        geometry.dart:2
   isolate_name_server.dart:3  painting.dart:137         platform_isolate.dart:2
   text.dart:29                natives.dart:6            platform_dispatcher.dart:18
   window.dart:2               semantics.dart:8
   → 合计 230 条 @Native 声明

3) 0                                     ← 一个 .cc 文件都没有

4) FlutterMacOS.xcframework  flutter_tester  font-subset
   gen_snapshot_arm64  gen_snapshot_x64  icudtl.dat
   const_finder.dart.snapshot  frontend_server_aot.dart.snapshot
```

**说明**：第 2 条的数字就是"边界的宽度"——230 个 `@Native` 声明，每一个都是一处"这里出界"。分布很集中：`painting.dart`（137）与 `text.dart`（29）占了七成，因为 `Canvas` / `Paint` / `Path` / `Paragraph` 这类绘制原语绝大多数操作都要落到引擎。`window.dart` 只有 2 条——**整个"把画面交出去"的动作只有两个 native 调用**（`Render` 与另一个），这也是为什么 4.5 节可以说"边界很窄"。

### 实验 2：`rootElement` 确实是异步出现的

不能直接用 `runApp`（它要求一个真实的 `FlutterView`），但可以复刻它的两步：

```dart
final WidgetsBinding binding = WidgetsFlutterBinding.ensureInitialized();
debugPrint('before schedule: rootElement=${binding.rootElement}');
binding.scheduleAttachRootWidget(binding.wrapWithDefaultView(const SizedBox.shrink()));
debugPrint('immediately after schedule: rootElement=${binding.rootElement}');
await Future<void>.delayed(const Duration(milliseconds: 30));
debugPrint('after 30ms: rootElement=${binding.rootElement}');
```

**实际输出**：

```text
LAB17 before schedule: rootElement=null
LAB17 immediately after schedule: rootElement=null
LAB17 after 30ms: rootElement=[root]
```

**说明**：这是 4.3 节"`runApp` 返回时树还不存在"的直接证据。**第二行是关键**——`scheduleAttachRootWidget` 已经调用过了，`rootElement` 仍是 null，因为真正的 `attachRootWidget` 在 `Timer.run` 里。

顺带一个必须记住的坑：如果调用 `scheduleAttachRootWidget` 时不包 `wrapWithDefaultView`，会直接抛错——

```text
The render object for SizedBox.shrink cannot find ancestor render object to attach to.
The ownership chain for the RenderObject in question was:
  SizedBox.shrink ← [root]
Try wrapping your widget in a View widget or any other widget that is backed by a
RenderTreeRootElement to serve as the root of the render tree.
```

**说明**：这条错误把 `wrapWithDefaultView` 的存在理由写清楚了——`RenderObjectWidget` 不能直接当渲染树的根，根必须是 `RenderTreeRootElement`（也就是 `View` 内部的 `_RawViewElement`，`widgets/view.dart:449`）。所以 `runApp` 里那层 `View` 是**渲染树能存在的前提**，不能省略。

### 实验 3：一帧内的打印顺序

在 `testWidgets` 里注册一个自己的 persistent callback 和一个 post-frame callback，并在 `build` 里打点：

```text
LAB16 build, phase=SchedulerPhase.persistentCallbacks
LAB16 persistent, phase=SchedulerPhase.persistentCallbacks
LAB16 postFrame, phase=SchedulerPhase.postFrameCallbacks
LAB16 renderView.layer=TransformLayer
```

**说明**：三点。

第一，**`build` 排在自己的 persistent callback 之前**。因为 `WidgetsBinding.drawFrame` 是第一个 persistent callback（由 `RendererBinding.initInstances` 注册），我们注册的排在它后面——所以"我的 persistent callback 跑时，本帧的 build 已经做完了"。

第二，`build` 里的 phase 是 `persistentCallbacks`，与第 50 篇实验 1 一致。

第三，**`RenderView.layer` 的实际类型是 `TransformLayer`，不是 `Layer`**。它是 `RenderView` 持有的根层，整棵 Layer 树挂在它下面。这也说明 `Layer` 是抽象基类，实际根层由 `RenderView` 自己决定。

### 实验 4：确认 `onBeginFrame` / `onDrawFrame` 只有一处接线

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn --include="*.dart" -E "(onBeginFrame|onDrawFrame) ?[?]?=" .
```

**实际**：唯一一条真正的赋值是

```text
scheduler/binding.dart:889:    platformDispatcher.onBeginFrame ??= _handleBeginFrame;
scheduler/binding.dart:890:    platformDispatcher.onDrawFrame ??= _handleDrawFrame;
```

其余命中全是文档注释里的引用（`rendering/binding.dart:595`、`widgets/binding.dart:1480` 的 method doc）。测试框架 `TestWidgetsFlutterBinding` 会走另一条路（它自己驱动帧）。

**说明**：**"一帧从哪来"这个问题在 framework 里只有这一个答案**。`??=` 还说明框架不会覆盖已有的注册——这也是测试框架能替换帧来源的关键（它先注册，框架就不会再抢）。

### 实验 5：确认 `Scene` 的一次性

```bash
grep -n "scene.dispose()" packages/flutter/lib/src/rendering/view.dart
grep -n "abstract class Scene\|base class _NativeScene" bin/cache/pkg/sky_engine/lib/ui/compositing.dart
```

**实际**：`rendering/view.dart:362` 是 `scene.dispose();`；`ui/compositing.dart:12` 是 `abstract class Scene`，`:37` 是 `base class _NativeScene extends NativeFieldWrapperClass1 implements Scene`。

**说明**：`Scene` 的实现在 `dart:ui` 里是 `_NativeScene`，继承自 `NativeFieldWrapperClass1`（**持有 native 指针的 Dart 包装类**）。这就是"必须手工 dispose"的原因，也是"这里已经是 native 资源"的信号。`Layer` 不需要 dispose（`LayerHandle` 只是引用计数），`Element` / `RenderObject` 由框架管理生命周期。

## 七、结论

1. 从 `main()` 到 GPU 只有**三个跨边界点**：`scheduleFrame()` → `PlatformConfigurationNativeApi::ScheduleFrame`、引擎回调 `PlatformDispatcher.onBeginFrame` / `onDrawFrame`、`FlutterView.render(scene)` → `PlatformConfigurationNativeApi::Render`。**常规 vsync 帧由引擎回调驱动，framework 通过 `scheduleFrame` 请求下一帧、被帧驱动；启动/热重载的 warm-up frame 则可由 `scheduleWarmUpFrame` 直接触发，不等待 vsync。**
2. framework 内部的关键结构是**一条 mixin 覆写链 + 一个驱动一帧的 persistent callback**：`RendererBinding.initInstances` 注册第一个、也是 release/profile 下唯一生效的 `_handlePersistentFrameCallback`（`rendering/binding.dart:61`；debug 模式下 `WidgetInspectorService` 还会注册一个只记帧号的 `_onFrameStart`，`widgets/widget_inspector.dart:1078`），它调 `drawFrame()`；由于 `WidgetsBinding` 在 `with` 子句最后（`widgets/binding.dart:2128`），虚调用先落到它，再由 `super.drawFrame()` 回到 rendering 层。八步顺序（buildScope → super.drawFrame（内部依次 flushLayout → flushCompositingBits → flushPaint → compositeFrame → flushSemantics）→ finalizeTree）全在这条链上。
3. 边界之外（引擎 C++、Impeller、Dart VM、平台 SDK）**本地磁盘没有源码**：`bin/cache/artifacts/engine/` 下只有 `FlutterMacOS.xcframework` / `flutter_tester` / `gen_snapshot_*` / `*.snapshot` / `icudtl.dat`，`find` 出来 0 个 `.cc` 文件。而边界**以内**的 `dart:ui` Dart 侧是本地可见的 19 个文件（`bin/cache/pkg/sky_engine/lib/ui/`），每个 `@Native` 标记就是一个出界点。

**framework 能自己决定的只有"把三棵树在同一个回调里按固定顺序更新完，最后交出一个 `Scene`"；帧从哪来、像素怎么出来，都在边界之外。**

## 八、边界声明

本文的第八节按约定放宽：把"不追什么 + 交给哪一篇"合并成一张对照表。

| 不追的段 | 原因 | 去哪一篇/哪一卷 |
|---|---|---|
| `transientCallbacks` 里 Ticker 怎么推进动画 | 已完整展开 | 卷 4 篇 18–19、卷 5 篇 20–22 |
| `flushLayout` 的脏传播与 relayout boundary | 已完整展开 | 卷 8 篇 30–35 |
| `flushPaint` 如何产出 Layer、`RepaintBoundary` 的作用 | 已完整展开 | 卷 8 篇 35 |
| `flushSemantics` 的语义树构建 | 已完整展开 | 卷 7 篇 26–29 |
| `finalizeTree` 的卸载细节 | 已完整展开 | 卷 9 篇 41 |
| 指针事件如何走到 `GestureBinding`（不在一帧内） | 已完整展开 | 卷 6 篇 23–25 |
| `dart:ui` 的 `Canvas` / `Path` / `TextPainter` / `ImageProvider` 用法 | 已完整展开 | 卷 3 篇 10–16 |
| `PlatformConfigurationNativeApi` 的实现 | **本地无源码** | 出界；只能读引擎仓库（这个系列不引用） |
| Impeller / Skia 的光栅化管线 | **本地无源码** | 出界 |
| Dart VM 的 GC / JIT / AOT（`gen_snapshot_*` 是它的产物） | **本地无源码** | 出界 |
| 平台侧（UIKit / Android View / Win32）的呈现 | 不在本 SDK 内 | 出界 |
| 31 个动手任务与系列篇目的对照 | 本卷下一篇 | 卷 11 篇 53 |

