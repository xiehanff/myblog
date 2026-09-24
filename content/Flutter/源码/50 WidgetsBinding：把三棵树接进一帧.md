# 50 WidgetsBinding：把三棵树接进一帧

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/binding.dart`（2155 行）、`packages/flutter/lib/src/rendering/binding.dart`（~900 行）、`packages/flutter/lib/src/scheduler/binding.dart`、`foundation/binding.dart`、`widgets/framework.dart`

## 一、问题

"一帧里 build → layout → paint" 是常识。但顺着这个常识往下问三层就会卡住：

1. build 是谁触发的？答"`setState`"——但 `setState` 只是标记脏，谁在什么时候把脏 Element 收拢起来跑？
2. layout / paint 是由谁触发的？和 build 在同一个函数里吗？
3. 这两段（widgets 层的 build 与 rendering 层的 layout/paint）**必须在同一次回调里**——是谁规定的这个顺序？

错误直觉是"框架有个主循环，依次调用 build、layout、paint"。实际结构里**没有主循环函数**，只有一层层 mixin 的 `drawFrame` 覆写链，以及一个非常不显眼的关键行：

```dart
// widgets/binding.dart:1569-1572（在 WidgetsBinding.drawFrame 里）
try {
  if (rootElement != null) {
    buildOwner!.buildScope(rootElement!);   // 1. widgets 层的全部 build 都在这里
  }
  super.drawFrame();                        // 2. 转到 RendererBinding.drawFrame
```

`super.drawFrame()` 这一行就是"三棵树接进一帧"的接缝。`WidgetsBinding` 是最后一个 mixin（`widgets/binding.dart:2128-2136`），所以它的 `drawFrame` 覆写了 `RendererBinding.drawFrame`：

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

**关键认知**：build 与 layout/paint 的顺序不是某段代码规定的，是**mixin 的线性化顺序**规定的。`WidgetsBinding` 写在最后 → 它的 `drawFrame` 先执行 → 它调 `super.drawFrame()` → 才轮到 `RendererBinding.drawFrame`。想改这个顺序，只能改 `with` 子句的顺序。

## 二、最小 Demo

不需要 `runApp`，直接用 binding 手动观察一帧的各阶段：

```dart
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

void main() {
  // 1. 手动初始化 binding（runApp 内部也是先做这一步）
  final WidgetsBinding binding = WidgetsFlutterBinding.ensureInitialized();

  // 2. 注册一个 persistent frame callback：它和 drawFrame 在同一个阶段执行
  binding.addPersistentFrameCallback((Duration timeStamp) {
    debugPrint('[persistent] phase=${SchedulerBinding.instance.schedulerPhase}');
  });

  // 3. 注册一个 post-frame callback：本帧布局绘制结束后才跑
  binding.addPostFrameCallback((Duration timeStamp) {
    debugPrint('[postFrame] phase=${SchedulerBinding.instance.schedulerPhase}');
  });

  // 4. 挂上根 widget —— 注意 runApp 内部走的就是这两步：
  //    先 wrapWithDefaultView 包一层 View（它是渲染树的根，不包会在挂载时报错），再挂根
  binding.scheduleAttachRootWidget(binding.wrapWithDefaultView(const SizedBox.shrink()));
  binding.scheduleWarmUpFrame();
}
```

输出顺序固定为 `[persistent] phase=SchedulerPhase.persistentCallbacks` → `[postFrame] phase=SchedulerPhase.postFrameCallbacks`。**这两行输出就是 `handleDrawFrame` 的两段循环**（`scheduler/binding.dart:1338`）。

再看一个更贴近业务的：在 `build` 里读 `schedulerPhase`，会得到 `SchedulerPhase.persistentCallbacks`（第六节实测）。**这证明 build 确实发生在 persistent callbacks 阶段内部，而不是在它之前。**

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/binding.dart:455` | `mixin WidgetsBinding on BindingBase, ServicesBinding, SchedulerBinding, GestureBinding, RendererBinding, SemanticsBinding` |
| `widgets/binding.dart:464` | `WidgetsBinding.initInstances`，创建 `BuildOwner` 并接上 `onBuildScheduled` |
| `widgets/binding.dart:1536` | `WidgetsBinding.drawFrame`，**本篇主角** |
| `widgets/binding.dart:1628` | `Widget wrapWithDefaultView(Widget rootWidget)`，`runApp` 用它包一层 `View` |
| `widgets/binding.dart:1657` | `void scheduleAttachRootWidget(Widget rootWidget)`，`Timer.run` 里挂根 |
| `widgets/binding.dart:1672` | `void attachRootWidget(Widget rootWidget)` |
| `widgets/binding.dart:1685` | `void attachToBuildOwner(RootWidget widget)`，创建 `rootElement` |
| `widgets/binding.dart:1883` | `void runApp(Widget app)` |
| `widgets/binding.dart:1948` | `void _runWidget(Widget app, WidgetsBinding binding, String debugEntryPoint)` |
| `widgets/binding.dart:1983` | `class RootWidget extends Widget` |
| `widgets/binding.dart:2005` | `RootElement attach(BuildOwner owner, [RootElement? element])`，**树的诞生点** |
| `widgets/binding.dart:2036` | `class RootElement extends Element with RootElementMixin` |
| `widgets/binding.dart:2128` | `class WidgetsFlutterBinding extends BindingBase with ...`，mixin 顺序决定一帧顺序 |
| `rendering/binding.dart:44` | `mixin RendererBinding` |
| `rendering/binding.dart:53` | `RendererBinding.initInstances`，注册 `_handlePersistentFrameCallback` |
| `rendering/binding.dart:508` | `void _handlePersistentFrameCallback(Duration timeStamp)`，只做两件事 |
| `rendering/binding.dart:642` | `RendererBinding.drawFrame`，layout / paint / composite / semantics |
| `rendering/object.dart:1137` / `1239` / `1293` / `1451` | `PipelineOwner.flushLayout` / `flushCompositingBits` / `flushPaint` / `flushSemantics` |
| `widgets/framework.dart:2901` | `class BuildOwner` |
| `widgets/framework.dart:3056` | `BuildOwner.buildScope` |
| `widgets/framework.dart:3339` | `BuildOwner.finalizeTree` |
| `scheduler/binding.dart:1226` | `SchedulerBinding.handleBeginFrame` |
| `scheduler/binding.dart:1338` | `SchedulerBinding.handleDrawFrame` |
| `scheduler/binding.dart:888` | `ensureFrameCallbacksRegistered`，`onBeginFrame` / `onDrawFrame` 的接线点 |
| `scheduler/binding.dart:160` | `enum SchedulerPhase` |
| `rendering/view.dart:347` / `361` | `RenderView.compositeFrame` / `_view.render(...)`，**交给引擎的最后一步** |

## 四、调用链

### 4.1 `runApp` 做的四件事

```dart
// widgets/binding.dart:1883-1886
void runApp(Widget app) {
  final WidgetsBinding binding = WidgetsFlutterBinding.ensureInitialized();
  _runWidget(binding.wrapWithDefaultView(app), binding, 'runApp');
}

// widgets/binding.dart:1948-1953
void _runWidget(Widget app, WidgetsBinding binding, String debugEntryPoint) {
  assert(binding.debugCheckZone(debugEntryPoint));
  binding
    ..scheduleAttachRootWidget(app)    // 1. 排一个 Timer 去挂根 widget
    ..scheduleWarmUpFrame();           // 2. 立刻要来一帧
}
```

两个动作都值得展开：

**`wrapWithDefaultView`** 会把用户 widget 包进一个 `View`：

```dart
// widgets/binding.dart:1644-1649
return View(
  view: platformDispatcher.implicitView!,
  deprecatedDoNotUseWillBeRemovedWithoutNoticePipelineOwner: pipelineOwner,
  deprecatedDoNotUseWillBeRemovedWithoutNoticeRenderView: renderView,
  child: rootWidget,
);
```

`View` 是这条链上唯一负责"创建 `RenderView`"的 widget（`widgets/view.dart:407` 的 `_RawViewInternal.createRenderObject` → `RenderView(view: view)`，`:441`）。**`RenderView` 是整个渲染树的根**，没有它就没有 `PipelineOwner.rootNode`，layout/paint 全都没有起点。

**`scheduleAttachRootWidget` 用的是 `Timer.run`**：

```dart
// widgets/binding.dart:1657-1661
void scheduleAttachRootWidget(Widget rootWidget) {
  Timer.run(() {
    attachRootWidget(rootWidget);
  });
}
```

**关键认知**：`runApp` 里挂根 widget 不是同步的，而是排到一个 Timer 里。所以 `runApp` 返回时 `rootElement` 可能还是 null。这解释了为什么"在 `main()` 里 `runApp` 之后就 `Scrollable.of(context)`"必然失败——树还没建。

### 4.2 树的诞生：`RootWidget.attach` → `mount` → `buildScope`

```dart
// widgets/binding.dart:1672-1674
void attachRootWidget(Widget rootWidget) {
  attachToBuildOwner(RootWidget(debugShortDescription: '[root]', child: rootWidget));
}

// widgets/binding.dart:1685-1692
void attachToBuildOwner(RootWidget widget) {
  final isBootstrapFrame = rootElement == null;
  _readyToProduceFrames = true;
  _rootElement = widget.attach(buildOwner!, rootElement as RootElement?);
  if (isBootstrapFrame) {
    SchedulerBinding.instance.ensureVisualUpdate();   // 首帧要来一次
  }
}
```

`RootWidget.attach` 是"第一棵 Element 树"的具体诞生过程：

```dart
// widgets/binding.dart:2005-2021（节选）
RootElement attach(BuildOwner owner, [RootElement? element]) {
  if (element == null) {
    owner.lockState(() {
      element = createElement();
      element!.assignOwner(owner);       // 1. 给根 Element 指定 owner
    });
    owner.buildScope(element!, () {
      element!.mount(/* parent */ null, /* slot */ null);   // 2. 在 buildScope 里 mount
    });
  } else {
    element._newWidget = this;           // 3. 已存在：只当一次更新
    element.markNeedsBuild();
  }
  return element!;
}
```

注意第 2 步：**`mount` 被包在 `buildScope` 里执行**。同一个 `buildScope` 会在 `drawFrame` 里被调用（`widgets/binding.dart:1571`），两者是同一个机制——`buildScope` 的语义是"这一段代码里做的 mark dirty 会立刻被处理完"。

`RootElement.mount` 里调 `_rebuild()`，然后 `super.performRebuild()`（`widgets/binding.dart:2057-2065`），从此 `attachToBuildOwner` 返回的 `_rootElement` 是一棵完整的 Element 树。

**关键认知**：`attachRootWidget` 与 `drawFrame` 都会调 `buildOwner.buildScope`，但前者是"建树"，后者是"重建脏节点"。它们共用同一个方法是因为 `BuildOwner.buildScope` 的契约是**"进入时收集脏 Element，退出前把它们全部重建完，且期间禁止重入"**（`widgets/framework.dart:3056`）。首次 mount 也是一次 build，走同一条路径最省事。

### 4.3 一帧的两半：`handleBeginFrame` 与 `handleDrawFrame`

引擎通过两个回调把帧交给框架，接线点在：

```dart
// scheduler/binding.dart:888-891
void ensureFrameCallbacksRegistered() {
  platformDispatcher.onBeginFrame ??= _handleBeginFrame;
  platformDispatcher.onDrawFrame ??= _handleDrawFrame;
}
```

`_handleBeginFrame` / `_handleDrawFrame`（`:1168` / `:1180`）只是包了一层时间戳处理，真正的实现在 `handleBeginFrame` / `handleDrawFrame`。**这两个方法的名字就是 scheduler 对外的"一帧有两半"的声明。**

```dart
// scheduler/binding.dart:1226-1272（节选）
void handleBeginFrame(Duration? rawTimeStamp) {
  assert(schedulerPhase == SchedulerPhase.idle);
  _hasScheduledFrame = false;
  try {
    _schedulerPhase = SchedulerPhase.transientCallbacks;
    final Map<int, _FrameCallbackEntry> callbacks = _transientCallbacks;
    _transientCallbacks = <int, _FrameCallbackEntry>{};
    callbacks.forEach((int id, _FrameCallbackEntry callbackEntry) {
      if (!_removedIds.contains(id)) {
        _invokeFrameCallback(callbackEntry.callback, _currentFrameTimeStamp!, ...);
      }
    });
    _removedIds.clear();
  } finally {
    _schedulerPhase = SchedulerPhase.midFrameMicrotasks;
  }
}
```

`handleBeginFrame` **只做一件事**：把当帧的 transient callbacks 全部跑掉。这些 callback 是谁注册的？**动画**——`Ticker.scheduleTick` 会把自己注册成 transient callback。所以"动画在 build 之前更新"这件事的实现位置就在这 20 行里（第 4 卷第 18 篇展开过这五个阶段，第 5 卷第 20 篇展开 `Ticker`）。

`handleDrawFrame` 负责剩下两段：

```dart
// scheduler/binding.dart:1338-1360（节选）
void handleDrawFrame() {
  assert(_schedulerPhase == SchedulerPhase.midFrameMicrotasks);
  try {
    _schedulerPhase = SchedulerPhase.persistentCallbacks;
    for (final callback in List<FrameCallback>.of(_persistentCallbacks)) {
      _invokeFrameCallback(callback, _currentFrameTimeStamp!);     // 1. build/layout/paint
    }
    _schedulerPhase = SchedulerPhase.postFrameCallbacks;
    final localPostFrameCallbacks = List<FrameCallback>.of(_postFrameCallbacks);
    _postFrameCallbacks.clear();
    for (final callback in localPostFrameCallbacks) {
      _invokeFrameCallback(callback, _currentFrameTimeStamp!);     // 2. 收尾
    }
  } finally {
    _schedulerPhase = SchedulerPhase.idle;
  }
}
```

**关键认知**：`handleDrawFrame` 里的 `_persistentCallbacks` 是**复数循环**——框架允许多个 persistent callback。谁注册了它们？框架内有两个注册点。驱动一帧的是 `RendererBinding.initInstances`（所有模式都会注册）：

```dart
// rendering/binding.dart:60-61
addPersistentFrameCallback(_handlePersistentFrameCallback);
// rendering/binding.dart:508-511
void _handlePersistentFrameCallback(Duration timeStamp) {
  drawFrame();                       // 1. 到 WidgetsBinding.drawFrame
  _scheduleMouseTrackerUpdate();     // 2. 鼠标追踪的帧末检查
}
```

所以"一帧的 build/layout/paint"全部发生在**这一个 persistent callback** 里。`SchedulerPhase.persistentCallbacks` 这个枚举值指的就是"这段代码正在跑"。

另一个注册点是 `WidgetInspectorService.initServiceExtensions` 里的 `_onFrameStart`（`widgets/widget_inspector.dart:1078`）——它只记录帧号与时间戳供 inspector 用，不参与 build/layout/paint。而且调用它的那行在 `WidgetsBinding.initServiceExtensions` 的 `assert` 块里（`widgets/binding.dart:811`），所以它只在 debug 模式注册；release/profile 下 `_persistentCallbacks` 里只有 RendererBinding 这一个。

### 4.4 `WidgetsBinding.drawFrame`：build 与 layout 的接缝

```dart
// widgets/binding.dart:1569-1580（节选，跳过首帧上报部分）
try {
  if (rootElement != null) {
    buildOwner!.buildScope(rootElement!);   // 1. 全部脏 Element 在这里重建
  }
  super.drawFrame();                        // 2. → RendererBinding.drawFrame
  buildOwner!.finalizeTree();               // 3. 清理被 deactivate 的 Element
} finally {
  assert(() {
    debugBuildingDirtyElements = false;
    return true;
  }());
}
```

`super.drawFrame()` 落到 rendering 层：

```dart
// rendering/binding.dart:642-654
void drawFrame() {
  rootPipelineOwner.flushLayout();
  rootPipelineOwner.flushCompositingBits();
  rootPipelineOwner.flushPaint();
  if (sendFramesToEngine) {
    for (final RenderView renderView in renderViews) {
      renderView.compositeFrame();   // this sends the bits to the GPU
    }
    rootPipelineOwner.flushSemantics();   // this sends the semantics to the OS.
    _firstFrameSent = true;
  }
}
```

**这就是完整的一次帧内流水线**：

```text
WidgetsBinding.drawFrame
├─ buildOwner.buildScope(rootElement)      ← widgets 层：Element 重建
│    └─ 期间可能 setState / markNeedsBuild → 脏 RenderObject 被登记
├─ super.drawFrame()  = RendererBinding.drawFrame
│    ├─ rootPipelineOwner.flushLayout()          ← rendering 层：layout
│    ├─ rootPipelineOwner.flushCompositingBits() ← 合成位
│    ├─ rootPipelineOwner.flushPaint()           ← paint，产出 Layer 树
│    ├─ renderView.compositeFrame()              ← Layer → Scene → 引擎
│    └─ rootPipelineOwner.flushSemantics()       ← 语义树
└─ buildOwner.finalizeTree()                ← 卸载本帧被 deactivate 的 Element
```

三处顺序细节：

1. **`buildScope` 先于 `flushLayout`**。所以"layout 期间不应该改状态"这条规则是靠 `setPixels` 里那个 `schedulerPhase != persistentCallbacks` 断言实现的（第 45 篇 4.3 节），而不是靠"layout 阶段禁止 setState"——事实上 `buildScope` 也在 `persistentCallbacks` 里，两者共享同一个 phase 值。
2. **`finalizeTree` 在 `drawFrame` 之后**，不在 `flushLayout` 之前。意味着本帧被 deactivate 的 Element 会活到帧末才 `unmount`——这正是第 48 篇"回收的 child 的 `dispose` 时机是本帧末尾"的来源。
3. **`compositeFrame` 有 `sendFramesToEngine` 开关**。前面几段（layout/paint）在"这一帧不发到引擎"时也会照跑。

### 4.5 从这里到引擎：`compositeFrame` 的三步

```dart
// rendering/view.dart:347-361（节选）
void compositeFrame() {
  try {
    assert(layer != null, 'call prepareInitialFrame before calling compositeFrame');
    final ui.SceneBuilder builder = RendererBinding.instance.createSceneBuilder();
    final ui.Scene scene = layer!.buildScene(builder);          // 1. Layer 树 → Scene
    if (automaticSystemUiAdjustment) {
      _updateSystemChrome();
    }
    _view.render(scene, size: configuration.toPhysicalSize(size));   // 2. 交给 FlutterView
    scene.dispose();                                            // 3. Scene 是手工管理的
  } finally { ... }
}
```

第 1 步的 `buildScene` 定义在 `ContainerLayer` 上（`rendering/layer.dart:1118`），它把整棵 Layer 树"录"进 `SceneBuilder`。第 2 步之后就是 **framework 的边界**：`FlutterView.render` 在 `dart:ui` 里，而 `dart:ui` 的实现是 `@Native` 外部函数（详见第 52 篇的边界说明）。

**关键认知**：framework 到引擎之间传递的**不是一棵 Layer 树、也不是绘图命令，而是一个 `ui.Scene` 对象**。`SceneBuilder` 是构建器，`Scene` 是不可变的成品，`scene.dispose()` 说明它持有 native 资源、需要显式释放。之所以要 `assert(scene.dispose)` 这一行，是因为 `Scene` 不是普通 Dart 对象。

### 4.6 一帧是怎么被"要来"的

`drawFrame` 不会自己触发。触发链有三条，最终都汇到 `scheduleFrame`：

```dart
// widgets/binding.dart:1430-1433
void _handleBuildScheduled() {
  assert(() { debugBuildingDirtyElements = true; return true; }());
  ensureVisualUpdate();
}

// scheduler/binding.dart:906-912（节选）
void ensureVisualUpdate() {
  switch (schedulerPhase) {
    case SchedulerPhase.idle:
    case SchedulerPhase.postFrameCallbacks:
      scheduleFrame();          // 不在帧中就排一帧
    case SchedulerPhase.transientCallbacks:
    case SchedulerPhase.midFrameMicrotasks:
    case SchedulerPhase.persistentCallbacks:
      return;                   // 已在帧中，不用排
  }
}
```

三条触发源：

| 触发源 | 谁调 | 走到哪 |
|---|---|---|
| `setState` / `markNeedsBuild` | `Element.markNeedsBuild` → `owner.onBuildScheduled` | `widgets/binding.dart:1430` → `ensureVisualUpdate` |
| `markNeedsLayout` / `markNeedsPaint` | `RenderObject` → `owner.requestVisualUpdate` | `rendering/binding.dart:842`（`_BindingPipelineManifold.requestVisualUpdate`）→ `ensureVisualUpdate` |
| 动画 | `Ticker.scheduleTick` | `scheduleFrameCallback` → `scheduleFrame` |

`ensureVisualUpdate` 里那个 `switch` 是关键：**它按当前 phase 决定要不要再排一帧**。在 `persistentCallbacks` / `transientCallbacks` 期间调的 `setState` 不会额外排帧，因为这一帧本来就会把脏节点处理完。

## 五、核心对象：`WidgetsBinding` vs `RendererBinding`

| | `WidgetsBinding`（`widgets/binding.dart:455`） | `RendererBinding`（`rendering/binding.dart:44`） |
|---|---|---|
| 所在层 | widgets | rendering |
| 覆写了谁 | 覆写 `RendererBinding.drawFrame` 并调 `super` | 覆写 `BindingBase.drawFrame` |
| `drawFrame` 里做什么 | `buildScope` → `super.drawFrame()` → `finalizeTree` | `flushLayout` → `flushCompositingBits` → `flushPaint` → `compositeFrame` → `flushSemantics` |
| 持有的 owner | `BuildOwner _buildOwner` | `PipelineOwner _rootPipelineOwner` |
| 树的根 | `Element? _rootElement` / `RootElement` | `RenderView`（由 `View` widget 创建，注册到 `renderViews`） |
| 一帧内的角色 | 上半场：重建 Element | 下半场：布局、绘制、合成、语义 |
| 谁注册 persistent callback | 不注册（借用 RendererBinding 注册的那个） | `initInstances` 里注册 `_handlePersistentFrameCallback`（`:61`） |
| 脏对象队列 | `BuildOwner._dirtyElements` | `PipelineOwner._nodesNeedingLayout` / `_nodesNeedingPaint` |
| 脏对象如何排序 | 按 `depth` 排序（第 3 篇的 `Element._sort`） | 按加入顺序 + `_nodesNeedingLayout` 的排序 |

**两者共享同一个"一帧"**：`RendererBinding` 注册驱动一帧的那个 persistent callback（另一个注册点 `widget_inspector.dart:1078` 仅 debug 生效、只做帧号记账），在这个 callback 里调 `drawFrame()`；由于 `WidgetsBinding` 是最后一个 mixin，虚调用落到 `WidgetsBinding.drawFrame`，再由它 `super` 回 `RendererBinding.drawFrame`。**这是一条"向上覆写、向下调用"的链**，不是两个独立回调。

### binding mixin 各管什么

| mixin | 一帧里的职责 | 声明位置 |
|---|---|---|
| `GestureBinding` | 把平台指针事件派发进命中测试（不在一帧内） | `gestures/binding.dart` |
| `SchedulerBinding` | 一帧两半：transient / persistent / postFrame 回调与 phase | `scheduler/binding.dart` |
| `ServicesBinding` | 平台通道与消息 | `services/binding.dart` |
| `PaintingBinding` | `ImageCache`、`ShaderWarmUp` | `painting/binding.dart` |
| `SemanticsBinding` | 语义开关与 `AccessibilityFeatures` | `semantics/binding.dart` |
| `RendererBinding` | layout / paint / composite / semantics | `rendering/binding.dart:44` |
| `WidgetsBinding` | build（`BuildOwner`）、根 Element、`runApp` | `widgets/binding.dart:455` |

`initInstances` 的执行顺序是**从上到下**（`super.initInstances()` 在最前面），所以 `WidgetsBinding.initInstances` 里那行注释才成立：

```dart
// widgets/binding.dart:473-476
// Initialization of [_buildOwner] has to be done after
// [super.initInstances] is called, as it requires [ServicesBinding] to
// properly setup the [defaultBinaryMessenger] instance.
_buildOwner = BuildOwner();
```

**关键认知**：mixin 的 `initInstances` 是"从基类往上"执行的，`with` 子句里靠后的 mixin 后执行。所以第 7 篇讲的"`WidgetsFlutterBinding.ensureInitialized()` 一次性把所有 binding 都建好"是真的——`WidgetsFlutterBinding()` 的构造函数链路会依次穿过这 7 个 `initInstances`。

## 六、源码实验

### 实验 1：确认 build 发生在 `persistentCallbacks` 阶段

在 `build` 里读 `SchedulerBinding.instance.schedulerPhase`：

```text
LAB6 schedulerPhaseDuringBuild=persistentCallbacks
```

**预测**：既然 build 由 `drawFrame` 触发，而 `drawFrame` 是 persistent callback，phase 就应该是 `persistentCallbacks`。

**实际**：正是。

**说明**：这条输出把"build 和 layout 在同一 phase 里"这件事确认了。所以**不能靠 `schedulerPhase` 区分"我在 build 还是 layout"**——框架自己也需要别的信号（`debugBuildingDirtyElements`、`_debugDoingLayout` 等）。第 45 篇 `setPixels` 里那个断言用 `!= persistentCallbacks` 而不是"不能是 layout"，原因就在这里。

### 实验 2：一帧内 postFrame 一定晚于 persistent

用第二节的 Demo，输出顺序固定：

```text
[persistent] phase=SchedulerPhase.persistentCallbacks
[postFrame] phase=SchedulerPhase.postFrameCallbacks
```

**说明**：`handleDrawFrame` 里两段是顺序 `for` 循环，且 postFrame 的列表在遍历前先 `clear()` 复制了一份（`scheduler/binding.dart:1350-1351`）。**所以在 postFrame 回调里再 `addPostFrameCallback` 不会导致本帧死循环**——它影响的是下一帧。

### 实验 3：确认 `RootWidget` 是唯一的根

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -rn "RootWidget(" --include="*.dart" .
grep -n "class RootElement\|class RootWidget" widgets/binding.dart
```

**实际**：构造点只有两处——`attachRootWidget` 内部（`widgets/binding.dart:1673`）与测试框架的 `restartAndRestore` 用法；声明在 `:1983`（`RootWidget`）与 `:2036`（`RootElement`）。

**说明**：`RootWidget` 在 3.44 里带了一个 `debugShortDescription` 字段（`:1985` / `:1993`），这是给 `debugDumpApp` 的树形输出用的标记，不影响结构。

### 实验 4：3.44 里 `attachRootWidget` 被拆成了两层

```bash
grep -n "void attachRootWidget\|void attachToBuildOwner" widgets/binding.dart
```

**实际**（实测命令输出）：

```text
1672:  void attachRootWidget(Widget rootWidget) {
1685:  void attachToBuildOwner(RootWidget widget) {
```

**说明**：这是本地源码与旧资料的一处不一致。旧版（以及大量翻译文章）里 `attachRootWidget` 直接 `widget.attach(buildOwner!, rootElement as RootElement?)`；3.44 里多了一层 `attachToBuildOwner`，源码注释给出的理由是可以"用旧的 `RootWidget` 恢复元素树"（`widgets/binding.dart:1681-1684`），`WidgetTester.restartAndRestore` 就靠它。**所以看到"`attachRootWidget` 里创建 rootElement"的说法时要按版本核对。**

## 七、结论

1. 一帧的完整顺序由 `handleDrawFrame` 的两段循环决定（`scheduler/binding.dart:1338`）：**persistent callbacks → post-frame callbacks**。驱动一帧的 persistent callback 由 `RendererBinding.initInstances` 注册（`rendering/binding.dart:61`，它调 `drawFrame()`）；框架内还有第二个注册点 `widgets/widget_inspector.dart:1078`（`_onFrameStart`，仅 debug 生效，只做帧号记账），不参与 build/layout/paint。
2. `build` 与 `layout/paint` 的分界线是 `WidgetsBinding.drawFrame` 里的 `super.drawFrame()`（`widgets/binding.dart:1571`）。顺序之所以是"先 build 后 layout"，是因为 `WidgetsBinding` 写在 `WidgetsFlutterBinding` 的 `with` 子句**最后**（`widgets/binding.dart:2128`），虚调用先落到它。`buildScope` → `flushLayout` → `flushCompositingBits` → `flushPaint` → `compositeFrame` → `flushSemantics` → `finalizeTree`，七步全在一次函数调用链里。
3. 一帧由三条路径要来：`markNeedsBuild`（`widgets/binding.dart:1430`）、`markNeedsPaint`/`markNeedsLayout`（经 `PipelineManifold.requestVisualUpdate`）、`Ticker.scheduleTick`。三者都汇到 `SchedulerBinding.ensureVisualUpdate`，由它按当前 `schedulerPhase` 决定要不要真的排帧。

一句话总结：**没有"主循环"，只有一条 mixin 覆写链；`WidgetsBinding.drawFrame` 里那一行 `super.drawFrame()` 就是把 Widget 树和渲染树缝进同一帧的那一针。**

## 八、边界声明

- 本篇只讲"一帧怎么被组织起来"（binding 链 + drawFrame 顺序 + 触发源）。**`handleBeginFrame` / `handleDrawFrame` 的五个阶段与 `SchedulerPhase` 的完整语义第 4 卷第 18 篇已经讲过**，本篇只补它在 binding 链里的位置。
- **`runApp` → GPU 的完整全景地图是第 52 篇**，本篇只负责其中 `WidgetsBinding` 这一段。
- 脏对象的具体传播算法（`BuildOwner._dirtyElements` 的排序批处理、`PipelineOwner._nodesNeedingLayout` 的 relayout boundary）不展开：Element 侧见第 9 卷 `setState 与 buildScope` 篇，RenderObject 侧见第 8 卷脏传播篇。
- `Ticker` / `TickerProvider` / `vsync` 的接线留到第 4 卷第 19 篇与第 5 卷；本篇只说明"transient callbacks 由动画占用"。
- `flushCompositingBits` / `flushSemantics` 的算法不展开；它们是第 8 卷（Layer 与合成）与第 7 卷（Semantics）的内容。
- `renderView.compositeFrame()` 之后（`ui.SceneBuilder` → `FlutterView.render` → 引擎）属于第 52 篇的边界之外，本篇只给三步。
- `View` widget 的多视图机制（`ViewCollection` / `RawView` / `_RawViewElement`）不在本篇展开。
