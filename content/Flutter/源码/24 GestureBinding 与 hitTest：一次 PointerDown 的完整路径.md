# 24 GestureBinding 与 hitTest：一次 PointerDown 的完整路径

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `gestures/binding.dart`（639 行）、`gestures/hit_test.dart`（294 行）、`gestures/converter.dart`（323 行）

## 一、问题

`Listener(onPointerDown: ...)` 的回调是谁调起来的？

错误直觉是"引擎直接把触摸事件交给 `Listener`"，或者"`Listener` 注册了一个系统级回调"。这两种理解都会导致一个具体后果：**当你需要解释"为什么 move 事件还在发给已经移出范围的 widget"、"为什么两条路径上的 widget 收到的 `localPosition` 不一样"、"为什么 `onTap` 比 `onPointerDown` 晚**时，找不到可以查的地方。

真实路径是一条被 `GestureBinding` 显式编排的四跳流水线，而且其中的顺序关系由**命中路径里的位置**保证，调度并不参与。

## 二、最小 Demo

一个 `Listener` 加一条全局路由，就能把"谁先谁后"和"坐标系不一致"两件事同时看出来：

```dart
import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';

void main() {
  runApp(
    Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.only(left: 60, top: 40), // 1. 故意制造非零偏移
          child: Listener(
            behavior: HitTestBehavior.opaque,                  // 2. 让自己能被命中
            onPointerDown: (PointerDownEvent e) {
              // 3. 同一时刻两个坐标：全局 / 局部
              debugPrint('listener  global=${e.position} local=${e.localPosition}');
            },
            child: const SizedBox(width: 200, height: 200),
          ),
        ),
      ),
    ),
  );

  // 4. 全局路由：它的回调时机比 widget 回调晚
  GestureBinding.instance.pointerRouter.addGlobalRoute((PointerEvent event) {
    debugPrint('router    ${event.runtimeType}');
  });
}
```

在屏幕中央点一下，输出顺序是：

```text
listener  global=Offset(400.0, 300.0) local=Offset(70.0, 80.0)
router    PointerDownEvent
router    PointerMoveEvent
```

两件事被这一小段代码钉死了：**`Listener` 的回调先于全局路由**（顺序），**`global` 与 `local` 差一个 (330, 220)**（坐标系）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `gestures/binding.dart:276` | `mixin GestureBinding on BindingBase implements HitTestable, HitTestDispatcher, HitTestTarget` |
| `gestures/binding.dart:278-282` | `initInstances` 里挂 `platformDispatcher.onPointerDataPacket`，全层唯一入口 |
| `gestures/binding.dart:300` | `_handlePointerDataPacket`：转换 → 入队 |
| `gestures/binding.dart:305` | `PointerEventConverter.expand(packet.data, _devicePixelRatioForView)` |
| `gestures/binding.dart:322` | `_devicePixelRatioForView`：按 viewId 取 dpr，物理像素在这里被除 |
| `gestures/binding.dart:337` | `_flushPointerEventQueue`：出队逐条 `handlePointerEvent` |
| `gestures/binding.dart:370` | `final Map<int, HitTestResult> _hitTests`：down 时算一次，后续复用 |
| `gestures/binding.dart:382` | `handlePointerEvent`：`resamplingEnabled` 分支在这里 |
| `gestures/binding.dart:397` | `_handlePointerEventImmediately`：按事件类型决定"要不要重新命中" |
| `gestures/binding.dart:444` | `hitTestInView`：只做一件事——`result.add(HitTestEntry(this))` |
| `gestures/binding.dart:467` | `dispatchEvent`：沿 path 逐 entry 调 `handleEvent(event.transformed(...))` |
| `gestures/binding.dart:527` | `handleEvent`：`pointerRouter.route` + `gestureArena.close` / `sweep` |
| `gestures/hit_test.dart:20` | `HitTestable`，只有一个 `hitTestInView` |
| `gestures/hit_test.dart:34` | `HitTestDispatcher`，只有 `dispatchEvent` |
| `gestures/hit_test.dart:40` | `HitTestTarget`，只有 `handleEvent` |
| `gestures/hit_test.dart:50` | `HitTestEntry<T>`：`target` + `_transform` |
| `gestures/hit_test.dart:111` | `HitTestResult`：`_path` + `_transforms` + `_localTransforms` |
| `gestures/hit_test.dart:177` | `HitTestResult.add`：把当前变换快照写给 entry |
| `gestures/hit_test.dart:212` / `251` / `269` | `pushTransform` / `pushOffset` / `popTransform` |
| `rendering/binding.dart:675` | `RendererBinding.hitTestInView`：先渲染树，再 `super`（进 GestureBinding） |
| `rendering/view.dart:308` | `RenderView.hitTest`：`child?.hitTest(BoxHitTestResult.wrap(result), ...)` |
| `rendering/box.dart:716` | `BoxHitTestResult`，命中结果的具体子类 |
| `rendering/box.dart:942` | `BoxHitTestEntry`，`HitTestEntry<RenderBox>` |
| `rendering/proxy_box.dart:3265` | `RenderPointerListener.handleEvent`：事件类型 → 回调的 switch |
| `widgets/gesture_detector.dart:1557` | `RawGestureDetectorState._handlePointerDown` |

## 四、调用链

### 4.1 第一跳：物理像素 → 逻辑像素

```dart
// binding.dart:300-309（节选）
void _handlePointerDataPacket(ui.PointerDataPacket packet) {
  try {
    _pendingPointerEvents.addAll(
      PointerEventConverter.expand(packet.data, _devicePixelRatioForView), // :305
    );
    if (!locked) {
      _flushPointerEventQueue();
    }
  } catch (error, stack) { /* 上报 */ }
}
```

`PointerEventConverter.expand` 是 `Iterable<PointerEvent>` 的惰性映射（`converter.dart:62`），换算只有一行：

```dart
// converter.dart:69-76
final double? devicePixelRatio = devicePixelRatioForView(datum.viewId);
if (devicePixelRatio == null) {
  return null;                     // 视图已经不存在，丢弃这条数据
}
final Offset position = Offset(datum.physicalX, datum.physicalY) / devicePixelRatio;
final Offset delta =
    Offset(datum.physicalDeltaX, datum.physicalDeltaY) / devicePixelRatio;
```

dpr 是**按 `viewId` 分别查的**，不是全局一个。多视图（多窗口 / 多引擎，或嵌入其它 App 的 Add-to-App 场景）时同一个 dpr 变量值可能不同。另外注意这里还有一条 `_synthesiseDownButtons`（`converter.dart:21`）：触屏 down 事件如果 `buttons == 0`，框架会补成 `kPrimaryButton`——**你在 `onPointerDown` 里读到的 `buttons` 不一定是引擎原值。**

`_pendingPointerEvents` 是一个队列而不是直接分发，目的是配合 `locked`：如果当前正在处理某个事件且期间又有新包到达，先入队，等 `unlocked()`（`binding.dart:293`）再统一 flush。这避免了"事件处理过程中重入分发"。

### 4.2 第二跳：命中测试，以及"什么时候不重算"

```dart
// binding.dart:397-429（节选）
void _handlePointerEventImmediately(PointerEvent event) {
  HitTestResult? hitTestResult;
  if (event is PointerDownEvent ||
      event is PointerSignalEvent ||
      event is PointerHoverEvent ||
      event is PointerPanZoomStartEvent) {
    hitTestResult = HitTestResult();
    hitTestInView(hitTestResult, event.position, event.viewId);       // :408
    if (event is PointerDownEvent || event is PointerPanZoomStartEvent) {
      _hitTests[event.pointer] = hitTestResult;                       // :410 缓存
    }
  } else if (event is PointerUpEvent ||
      event is PointerCancelEvent ||
      event is PointerPanZoomEndEvent) {
    hitTestResult = _hitTests.remove(event.pointer);                  // :421 取出并清掉
  } else if (event.down || event is PointerPanZoomUpdateEvent) {
    hitTestResult = _hitTests[event.pointer];                          // :428 复用缓存
  }
  if (hitTestResult != null || event is PointerAddedEvent || event is PointerRemovedEvent) {
    dispatchEvent(event, hitTestResult);
  }
}
```

`_hitTests` 的文档（`binding.dart:356-369`）把设计意图写得很清楚：

> This hit test result will be used throughout the entire pointer interaction; that is, the pointer is seen as pointing to the same place even if it has moved away until pointer goes up.

一次触摸交互里 **hit test 只做一次**（在 down 时）。之后的 move / up / cancel 都复用那份结果，哪怕指针已经移出 widget 的范围。这是刻意设计，为了匹配"按住按钮后手指滑出去，按钮仍然认为自己在被按住"的物理直觉；也是为了让不支持 hover 的设备尽量少做命中测试。

### 4.3 第三跳：分发，以及每个 entry 一份变换

```dart
// binding.dart:496-498
for (final HitTestEntry entry in hitTestResult.path) {
  try {
    entry.target.handleEvent(event.transformed(entry.transform), entry);
  } catch (exception, stack) { /* FlutterErrorDetailsForPointerEventDispatcher */ }
}
```

三个细节：

1. **顺序**：`path` 的第一个元素是"最具体的"（叶子），最后一个是最外层。所以事件从叶子往外冒。
2. **变换**：`entry.transform` 是**每个 entry 各自的**矩阵。`GestureBinding` 把自己追加在末尾（`binding.dart:445`），所以它的 `transform` 是单位矩阵，事件送进来时不带任何变换。
3. **异常隔离**：单个 target 抛异常不会中断整条路径的分发，只上报 `FlutterError`。

### 4.4 为什么 `pointerRouter.route` 排在 widget 回调之后

`GestureBinding` 是命中路径的最后一个 entry，所以它自己的 `handleEvent` 最后被调用：

```dart
// binding.dart:526-536
@override // from HitTestTarget
void handleEvent(PointerEvent event, HitTestEntry entry) {
  pointerRouter.route(event);
  if (event is PointerDownEvent || event is PointerPanZoomStartEvent) {
    gestureArena.close(event.pointer);
  } else if (event is PointerUpEvent || event is PointerPanZoomEndEvent) {
    gestureArena.sweep(event.pointer);
  } else if (event is PointerSignalEvent) {
    pointerSignalResolver.resolve(event);
  }
}
```

这段代码里的三个动作，语义上都需要"所有 widget 都已经看过这个事件了"：
- `pointerRouter.route` 要把事件送给识别器，而识别器是在 widget 的 `_handlePointerDown` 里通过 `addPointer` → `startTrackingPointer` → `addRoute` 才注册的；
- `gestureArena.close` 要保证"没有识别器还能再加入竞技场"；
- `sweep` 要在 up 事件被所有识别器看过之后才能强判胜负。

它们能成立，**只因为 `GestureBinding` 在命中路径的末尾**。这条依赖关系没有任何断言或注释保护，是纯位置约定——第 25 篇的实验会从输出上确认它。

### 4.5 命中路径是怎么建起来的

`GestureBinding.hitTestInView` 自己只加一个 entry，真正的树遍历在渲染层：

```dart
// rendering/binding.dart:675-678
@override
void hitTestInView(HitTestResult result, Offset position, int viewId) {
  _viewIdToRenderView[viewId]?.hitTest(result, position: position);   // 先渲染树
  super.hitTestInView(result, position, viewId);                      // 再 GestureBinding
}
```

```dart
// rendering/view.dart:308-310
bool hitTest(HitTestResult result, {required Offset position}) {
  child?.hitTest(BoxHitTestResult.wrap(result), position: position);
  ...
}
```

`BoxHitTestResult.wrap` 让子类共享同一个 `_path`（`hit_test.dart:124-127`），所以渲染层往里加的东西会直接出现在 `GestureBinding` 拿到的那个 `result` 里。

变换的记法值得单独记一句。`HitTestResult` 内部维护"全局化矩阵栈 + 局部变换栈"两个结构（`hit_test.dart:137-150`），`add` 时把当前有效变换快照写进 entry：

```dart
// hit_test.dart:177-181
void add(HitTestEntry entry) {
  assert(entry._transform == null);
  entry._transform = _lastTransform;
  _path.add(entry);
}
```

`entry.transform` 的方向是"**从全局坐标到 target 的局部坐标**"，它等于从根一路走下来的**逆**变换累积。文档在 `pushTransform` 的注释里写得很明确（`hit_test.dart:190-196`）：它来自 `RenderObject.applyPaintTransform` 的逆，再用 `PointerEvent.removePerspectiveTransform` 去掉透视分量。

## 五、核心对象：四个接口的分工

`hit_test.dart` 里的三个接口加起来只有 3 个方法，它们把"命中 — 分发 — 处理"切成三件事：

| 接口 | 方法 | 谁实现 | 职责 |
|---|---|---|---|
| `HitTestable` | `hitTestInView(result, position, viewId)` | `RendererBinding`、`RenderBox`、`RenderSliver` | 往 `result` 里填 entry |
| `HitTestDispatcher` | `dispatchEvent(event, result)` | `GestureBinding`（唯一实现） | 决定把事件发给谁 |
| `HitTestTarget` | `handleEvent(event, entry)` | `RenderPointerListener`、`GestureBinding`、`MouseTracker` 等 | 真的处理事件 |

再看两个容易混的对象对：

| | `HitTestResult` | `BoxHitTestResult` |
|---|---|---|
| 声明位置 | `gestures/hit_test.dart:111` | `rendering/box.dart:716` |
| 里面的 entry 类型 | `HitTestEntry`（`T extends HitTestTarget`） | `BoxHitTestEntry`（`HitTestEntry<RenderBox>`） |
| 额外能力 | `pushTransform` / `pushOffset` / `popTransform`（`@protected`） | `addWithPaintTransform` / `addWithPaintOffset` / `addWithOutOfBandPosition` 等公开包装 |
| 谁用 | `GestureBinding` 直接 new | 渲染层，通过 `HitTestResult.wrap` 共享同一个 `_path` |

| | `HitTestTarget.handleEvent` | `HitTestDispatcher.dispatchEvent` |
|---|---|---|
| 调用者 | `dispatchEvent` 里的 for 循环 | `GestureBinding._handlePointerEventImmediately` |
| 调用次数 | 每个 entry 一次 | 每个事件一次 |
| 见到的事件 | 已经 `transformed(entry.transform)` | 全局坐标的原始事件 |
| 抛异常时 | 被 catch 并上报，继续下一个 entry | 被 catch 并上报，含 `event` + `hitTestEntry` 两项上下文 |

`FlutterErrorDetailsForPointerEventDispatcher`（`binding.dart:611`）就是为后者准备的：它比普通 `FlutterErrorDetails` 多带 `event` 和 `hitTestEntry` 两个字段，**出错时能精确告诉你是哪个 widget 在处理哪个事件时炸的**。

## 六、源码实验

### 实验 1：命中路径的组成与末尾位置

**改什么**：在测试里直接调 `GestureBinding.instance.hitTestInView`，打印 `result.path` 每一项的 `target.runtimeType` 与 `transform`。

```dart
final HitTestResult result = HitTestResult();
GestureBinding.instance.hitTestInView(
  result, tester.getCenter(find.byKey(const ValueKey<String>('target'))), tester.view.viewId,
);
for (final HitTestEntry entry in result.path) {
  print('PATH: ${entry.target.runtimeType} transform=${entry.transform}');
}
```

**预测**：如果"引擎直接给 Listener 发事件"，路径里应该只有 Listener 一个 target。

**实际**（输出，`GestureDetector` 包一个 `SizedBox`）：

```text
PATH: RenderPointerListener      transform=[0][1,0,0,-350.0][1][0,1,0,-250.0]...
PATH: RenderSemanticsGestureHandler transform=[0][1,0,0,-350.0][1][0,1,0,-250.0]...
PATH: RenderPositionedBox        transform=[1,0,0,0][0,1,0,0][0,0,1,0][0,0,0,1]
PATH: _ReusableRenderView        transform=单位矩阵
PATH: AutomatedTestWidgetsFlutterBinding transform=单位矩阵   ← 就是 GestureBinding
```

**说明**：三件事同时被证实：
1. 路径是**从叶子到根**排列的；
2. `RenderPointerListener` 与 `RenderSemanticsGestureHandler` 共享同一个 `-350,-250` 平移（`Center` 把 100×100 的子节点摆到屏幕中心后，子节点原点相对屏幕是 `(350, 250)`），而更外层、铺满整屏的 `RenderPositionedBox` 是单位矩阵；
3. **`GestureBinding` 是最后一个 entry**，实验 4.4 里的顺序依赖成立。

### 实验 2：`debugPrintHitTestResults` 给出的完整路径

**改什么**：把 `debugPrintHitTestResults` 置为 true，然后跑一次 tap。

```dart
debugPrintHitTestResults = true;   // gestures/debug.dart:20
```

**预测**：应该只打印几个 widget。

**实际**（输出，节选）：

```text
PointerDownEvent#0fb0f(position: Offset(400.0, 300.0), pointer: 1, kind: touch, buttons: 1, down: true):
HitTestResult(
  _RenderColoredBox#178e0@Offset(30.0, 30.0),
  RenderConstrainedBox#530c0@Offset(30.0, 30.0),
  RenderPointerListener#33847@Offset(30.0, 30.0),
  RenderSemanticsGestureHandler#772c3@Offset(30.0, 30.0),
  RenderPositionedBox#98050@Offset(400.0, 300.0),
  ...
  _RenderTheater#81682@Offset(400.0, 300.0),
  ...
  HitTestEntry<HitTestTarget>#7ea73(_ReusableRenderView#2848f),
  HitTestEntry<HitTestTarget>#3bd07(<AutomatedTestWidgetsFlutterBinding>))
```

**说明**：命中路径在真实 App 里会很长（MaterialApp 一层层包裹会带进 `_RenderTheater`、`RenderAnimatedOpacity`、`RenderOffstage` 等几十个节点）。`@Offset(...)` 是每个 entry 的**局部坐标**——可以看到最内层是 `(30, 30)`，而 `RenderPositionedBox` 之后突然变成 `(400, 300)`，因为那之后坐标系回到屏幕全局。**读这份输出是排查"为什么某 widget 收不到事件"最快的手段**：如果它不在这个列表里，它就不会收到任何指针事件。

### 实验 3：同一事件的两种坐标，以及回调时序

**改什么**：用第 2 节的 Demo，在 `Listener.onPointerDown` 里同时打印 `position` 与 `localPosition`，并注册一条全局路由。

**预测**：如果 `localPosition` 是框架"顺手算的"，它应该和 `position` 一致或至少同源。

**实际**（输出）：

```text
listener.down global=Offset(400.0, 300.0) local=Offset(70.0, 80.0)
router:PointerDownEvent
router:PointerMoveEvent
listener.up
router:PointerUpEvent
```

**说明**：`global` 与 `local` 相差 `(330, 220)`，等于 `Center` 布局偏移 `(50, 20)` 加上 `Padding` 的 `(60, 40)`。这个换算就是 `entry.transform` 那一行 —— `event.transformed(entry.transform)` 的结果。注意 `PointerEvent.transformed` 是**惰性**的（`events.dart:527-542` 说明它按需计算并缓存 `localPosition`），所以不读 `localPosition` 的 entry 不会付出换算成本。

时序上，`listener.down` 出现在 `router:PointerDownEvent` **之前**——这就是实验 1 里"binding 在路径末尾"的直接后果。

### 实验 4：down 的命中结果被 move 复用

**改什么**：在屏幕中央放一个 100×100 的 `Listener`，按下后把指针移到屏幕下方（远在 100×100 之外）再抬起。

**预测**：如果每次 move 都重新命中，移出后 `onPointerMove` 就不该再被调用。

**实际**（输出）：

```text
LOG: [down local=Offset(50.0, 50.0), move local=Offset(50.0, 250.0), up local=Offset(50.0, 250.0)]
```

**说明**：move 和 up **照样**送到了那个 `Listener`，而且 `localPosition` 仍在用 down 时那份 entry 的变换计算（`(400,500)` 减去 Listener 原点 `(350,250)` 得到 `(50,250)`）。这直接验证了 `_hitTests` 的缓存语义。

**代价与收益**：代价是"指针明明已经不在 widget 上，widget 仍然收到事件"，业务侧要自己判断；收益是省掉每次 move 一次全树命中，并且让"按下后滑出再松开"仍然算一次完整交互。

### 实验 5：一个已经被删掉的类——`_PointerState`

```bash
cd $(dirname $(dirname $(which flutter)))
grep -rn "_PointerState" packages/ --include="*.dart"   # 0 条
```

**实际**：0 条命中。

**说明**：老资料里描述 `PointerEventConverter` 时会提到一个 `_PointerState` 内部类（用来记录每个 pointer 的上一次位置、推导 delta 等）。在 3.44.8 里**这个类已经从整个仓库消失**：`PointerEventConverter` 现在是一个无状态的 `abstract final class`（`converter.dart:54`），delta 直接来自 `dart:ui.PointerData.physicalDeltaX/Y`，不再由框架自己差分计算。看到仍以 `_PointerState` 讲解转换器的资料，要意识到它对应的不是这个版本。

## 七、结论

1. 指针事件只有一条入口：`GestureBinding.initInstances` 里的 `platformDispatcher.onPointerDataPacket`（`binding.dart:281`）。之后是**转换（converter）→ 命中（hitTest）→ 分发（dispatchEvent）→ 路由与仲裁（handleEvent）** 四段。
2. **一次触摸交互只做一次 hit test**，结果按 `pointer` 缓存在 `_hitTests` 里（`binding.dart:370`），move / up / cancel 全部复用；这是"滑出范围仍收事件"的根源。
3. `GestureBinding` 作为 `HitTestable`/`HitTestDispatcher`/`HitTestTarget` 三合一，把自己追加在命中路径的**末尾**，因此 `pointerRouter.route` 与 `gestureArena.close/sweep` 必然发生在所有 widget 回调之后——**顺序由位置保证，不由调度保证**。

**`PointerDown` 的路径是"converter 换单位 → 渲染树建 path → 逐 entry 送带变换的事件 → 最后才轮到 binding 关竞技场"。**

## 八、边界声明

- 本文只讲"从引擎到 `handleEvent`"这一段。竞技场内部如何仲裁、`TapGestureRecognizer` 如何从 move / up 推出 `onTap`，留给第 25 篇。
- `pushTransform` / `pushOffset` 在渲染层被包装成 `BoxHitTestResult.addWithPaintTransform` 等 API 的过程，以及 `RenderBox.hitTest` 的 `hitTestChildren` / `hitTestSelf` 组合，属于渲染层命中，留给第八卷渲染管线相关篇章。
- `_Resampler`（`binding.dart:62`，指针重采样）只在 `handlePointerEvent` 处标出分支，不展开其采样算法。
- `PointerSignalEvent` 的 `pointerSignalResolver`（`binding.dart:354`）与鼠标滚轮抢占，以及 `MouseTracker` 的 hover 命中（它会忽略本层的 `_hitTests` 缓存），不在这个系列展开。
- `locked` / `unlocked` 与 `BindingBase` 的关系，已在第七篇 `BindingBase 与平台常量` 中给出结论，本文只使用它。
- 本文从源码层定位事件响应的调用链。
