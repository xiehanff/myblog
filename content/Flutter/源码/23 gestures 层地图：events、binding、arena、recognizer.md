# 23 gestures 层地图：events、binding、arena、recognizer

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/gestures`（27 文件 14.3k 行）

## 一、问题

`gestures` 只有 27 个文件，比 `foundation`（42 个）还少，但它自己内部的分量极不均匀：`events.dart` 一个文件 2606 行，占全层 18%；而"某个具体手势怎么判断"的实现——`tap_and_drag.dart` 1486 行、`monodrag.dart` 1103 行、`multitap.dart` 1048 行、`long_press.dart` 882 行、`scale.dart` 860 行、`multidrag.dart` 601 行——加起来 7.3k 行，占全层一半以上。

于是问题变成：**这层里哪些是"机制"，哪些只是"某个手势的算法实现"？**

错误直觉是"手势识别 = 各种 Recognizer 的算法"。按照这个直觉去读，你会从 `tap.dart` 开始逐行啃 `_checkUp`、`_checkCancel`，然后发现自己始终搞不清**这些回调是被谁在什么时候调起来的**——因为答案不在 `tap.dart` 里。

`gestures` 的真正机制只有四件事：**事件的形状（events）、事件从哪来（converter）、事件送到谁手里（hit_test + binding）、多个候选者怎么分出胜负（arena）**。识别算法是这四件事的消费方。

## 二、最小 Demo

`gestures` 可以完全脱离 Widget 层使用——识别器本身只需要 `package:flutter/gestures.dart`；但 `GestureBinding.instance` 要求 binding 已初始化，所以 Demo 的外壳放进 `testWidgets`，手写一个识别器并把它塞进竞技场：

```dart
import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// 一个最小的"任意点击"识别器：不做算法，只演示识别器与竞技场的接线。
class LoggingTapRecognizer extends OneSequenceGestureRecognizer {
  // 1. 指针被允许时，登记路由 + 加入竞技场（父类一步做完）
  @override
  void addAllowedPointer(PointerDownEvent event) {
    super.addAllowedPointer(event); // 内部会调用 startTrackingPointer
    // 2. 立刻声明"我要赢"，成为 eager winner
    resolve(GestureDisposition.accepted);
  }

  // 3. 路由过来的每一个事件都走这里
  @override
  void handleEvent(PointerEvent event) {
    debugPrint('${event.runtimeType} pointer=${event.pointer} local=${event.localPosition}');
  }

  @override
  void didStopTrackingLastPointer(int pointer) => debugPrint('last pointer $pointer stopped');

  @override
  String get debugDescription => 'logging tap';
}

void main() {
  // GestureBinding.instance 需要 binding 已初始化，放进 testWidgets 最省事
  testWidgets('识别器与竞技场', (WidgetTester tester) async {
    // 4. 手动走一遍"识别器收到 down"这一步
    final LoggingTapRecognizer recognizer = LoggingTapRecognizer();
    recognizer.addPointer(const PointerDownEvent(pointer: 1, position: Offset(10, 20)));
    debugPrint('arena members: ${GestureBinding.instance.gestureArena}');
    recognizer.dispose();
  });
}
```

这段代码值得注意的地方：识别器**没有自己去监听引擎**，它只是调了一次 `addPointer`，剩下的接线（`pointerRouter.addRoute` 和 `gestureArena.add`）全在父类里完成。这正是本层的分层方式——**识别算法只描述"我怎么判断"，接线和仲裁由 binding / router / arena 负责**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `lib/gestures.dart:10-36` | 本层对外面，27 个 export，与 27 个文件一一对应 |
| `gestures/events.dart:251` | `abstract class PointerEvent`，所有事件的基类 |
| `gestures/events.dart:543` | `PointerEvent transformed(Matrix4? transform)`，坐标系变换的抽象方法 |
| `gestures/events.dart:1500` | `PointerDownEvent`，唯一会触发 hit test 的事件之一 |
| `gestures/events.dart:2181` | `PointerPanZoomStartEvent`，触控板的"按下" |
| `gestures/converter.dart:54` | `abstract final class PointerEventConverter`，dart:ui 数据 → 框架事件的转换表 |
| `gestures/converter.dart:62` | `PointerEventConverter.expand`，物理像素 → 逻辑像素的换算点 |
| `gestures/hit_test.dart:111` | `HitTestResult`，命中路径 + 每个 entry 的变换矩阵 |
| `gestures/binding.dart:276` | `mixin GestureBinding on BindingBase implements HitTestable, HitTestDispatcher, HitTestTarget` |
| `gestures/binding.dart:281` | `platformDispatcher.onPointerDataPacket = _handlePointerDataPacket;` 唯一入口 |
| `gestures/binding.dart:346` | `final PointerRouter pointerRouter = PointerRouter();` |
| `gestures/binding.dart:350` | `final GestureArenaManager gestureArena = GestureArenaManager();` |
| `gestures/arena.dart:117` | `class GestureArenaManager`，仲裁器本体 |
| `gestures/arena.dart:59` | `class _GestureArena`，单个指针的竞技场状态 |
| `gestures/pointer_router.dart:17` | `class PointerRouter`，按 pointer 分发的路由表 |
| `gestures/recognizer.dart:129` | `abstract class GestureRecognizer extends GestureArenaMember` |
| `gestures/recognizer.dart:387` | `OneSequenceGestureRecognizer`，把"路由 + 竞技场"打包的中间层 |
| `gestures/recognizer.dart:594` | `PrimaryPointerGestureRecognizer`，加 slop 和 deadline |
| `gestures/tap.dart:202` | `abstract class BaseTapGestureRecognizer extends PrimaryPointerGestureRecognizer` |
| `gestures/team.dart:139` | `class GestureArenaTeam`，把多个识别器当一个人参赛 |
| `widgets/gesture_detector.dart:1433` | `RawGestureDetectorState`，识别器的持有者（消费方） |
| `widgets/gesture_detector.dart:1557` | `_handlePointerDown`，把 down 转交给每一个识别器 |

## 四、调用链

### 4.1 四段流水线

一次 PointerDown 从引擎到 `onTap` 回调，穿过四段。下面把每段的负责人写出来，后面三篇各展开一段。

**第一段：形状转换（converter）。** 引擎送来的是 `dart:ui.PointerDataPacket`，里面是**物理像素**和 `PointerChange` 枚举。`PointerEventConverter.expand` 把它变成框架的 `PointerEvent` 对象，并顺手做两件容易忽略的事：

```dart
// converter.dart:74-76
final Offset position = Offset(datum.physicalX, datum.physicalY) / devicePixelRatio;
final Offset delta =
    Offset(datum.physicalDeltaX, datum.physicalDeltaY) / devicePixelRatio;
```

```dart
// converter.dart:21-29（节选）
int _synthesiseDownButtons(int buttons, PointerDeviceKind kind) {
  switch (kind) {
    case PointerDeviceKind.touch:
    case PointerDeviceKind.stylus:
    ...
      return buttons == 0 ? kPrimaryButton : buttons;
```

第二件事是"补按钮位"：触屏的 down 事件引擎可能报 `buttons == 0`，框架在这里补成 `kPrimaryButton`。所以 `PointerDownEvent.buttons` 在触屏上**不是**引擎原值。

**第二段：命中测试（hit_test + binding）。** `GestureBinding._handlePointerEventImmediately` 对 down / signal / hover 做一次 hit test，结果按 pointer 缓存进 `_hitTests`。

**第三段：分发（binding.dispatchEvent）。** 沿命中路径逐 entry 调用 `entry.target.handleEvent(event.transformed(entry.transform), entry)`，并调用 `pointerRouter.route(event)`。

**第四段：仲裁（recognizer + arena）。** 识别器在 `handleEvent` 里更新自己的状态，用 `resolve(GestureDisposition.xxx)` 把决定交给 `GestureArenaManager`。

### 4.2 三段之间的顺序是被"路径位置"决定的

`GestureBinding` 扮演了三个角色（`HitTestable` / `HitTestDispatcher` / `HitTestTarget`），其中 `hitTestInView` 的实现只有一行：

```dart
// binding.dart:444-446
void hitTestInView(HitTestResult result, Offset position, int viewId) {
  result.add(HitTestEntry(this));
}
```

它是被 `RendererBinding` 在**做完渲染树命中之后**才调用的：

```dart
// rendering/binding.dart:675-678
void hitTestInView(HitTestResult result, Offset position, int viewId) {
  _viewIdToRenderView[viewId]?.hitTest(result, position: position);
  super.hitTestInView(result, position, viewId);   // → GestureBinding，把自己追加到末尾
}
```

因为 `HitTestResult.path` 的顺序是"最具体的在前"，而 binding 被追加在**最后**，所以 `dispatchEvent` 遍历到 binding 时，所有 widget 层的 `handleEvent` 都已经跑完了。

`gestureArena.close(pointer)` 能保证"在全部识别器都注册之后"执行，靠的是 **`GestureBinding` 把自己放在命中路径的末尾**这个位置关系，而不是额外的调度。这条链路里没有任何"等一帧"或"延时"的代码——顺序是结构决定的。

### 4.3 消费方：`RawGestureDetector` 做了什么

`GestureDetector` 本身是 `StatelessWidget`（`widgets/gesture_detector.dart:223`），真正的状态在 `RawGestureDetectorState`（同文件 `:1433`）里：它持有 `Map<Type, GestureRecognizer> _recognizers`，在 `build` 里铺一个 `Listener`，把 down 转给每个识别器：

```dart
// widgets/gesture_detector.dart:1557-1562
void _handlePointerDown(PointerDownEvent event) {
  assert(_recognizers != null);
  for (final GestureRecognizer recognizer in _recognizers!.values) {
    recognizer.addPointer(event);
  }
}
```

`Listener` 的 `handleEvent` 在 `rendering/proxy_box.dart:3265`（`RenderPointerListener.handleEvent`），用一个 `switch` 把事件类型派发到 `onPointerDown` / `onPointerMove` / … 上。

`GestureDetector` 本身没有"识别手势"的能力，它只是**识别器的容器 + 事件的转发点**。所有判断逻辑都在 `gestures` 层的识别器里，而识别器的胜负由 `arena` 决定。理解这条分工，就不会再去 `GestureDetector` 里找"为什么点击没反应"的答案。

## 五、核心对象：四类角色的职责对比

| | 形态 | 职责 | 有无状态 |
|---|---|---|---|
| `PointerEvent` 家族 | 不可变值对象（`@immutable`） | 描述"发生了什么"：位置、按键、时间戳 | 无（每次事件都是新对象） |
| `PointerRouter` | 路由表 `Map<int, Map<PointerRoute, Matrix4?>>` | 按 pointer 把事件送给订阅者，附带变换 | 有（路由集合） |
| `GestureArenaManager` | `Map<int, _GestureArena>` | 仲裁"哪个识别器赢" | 有（每个 pointer 一个 `_GestureArena`） |
| `GestureRecognizer` | 可复用对象，由 widget 持有 | 判断"这串事件算不算我的手势" | 有（`_state`、`_trackedPointers`、`_entries`） |

再把这四个角色和"谁创建它们"对上：

| 角色 | 谁创建 | 生命周期 |
|---|---|---|
| `PointerEvent` | `PointerEventConverter.expand` | 单个事件，dispatch 完即弃 |
| `PointerRouter` | `GestureBinding`（`binding.dart:346`，`final` 字段） | 整个 App |
| `GestureArenaManager` | `GestureBinding`（`binding.dart:350`） | 整个 App |
| `GestureRecognizer` | `RawGestureDetectorState._syncAll` | 跟随 widget，`_recognizers` 里复用 |

`events.dart` 与其余文件的体裁差别也从这里能看出来：**它是纯数据定义**。2606 行里绝大部分是"一个事件类 + 它自己的 `_TransformedXxxEvent` 子类 + `copyWith` + `debugFillProperties`"的四件套重复，没有任何算法。读它只需要看基类 `PointerEvent`（`:251`）和两个关键方法（`transformed` `:543`、`removePerspectiveTransform` `:626`）。

## 六、源码实验

### 实验 1：确认本层分量分布

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src
wc -l gestures/*.dart | sort -rn
```

**预测**：如果"手势 = 识别算法"，算法文件应该占大头。

**实际**：总计 14275 行。前几名依次是 `events.dart` 2606、`tap_and_drag` 1486、`monodrag` 1103、`multitap` 1048、`long_press` 882、`scale` 860。

把 27 个文件按体裁分成两组：

```text
机制（事件形状 / 转换 / 命中 / 分发 / 仲裁 / 识别器基类）≈ 5.8k 行
  events 2606 · recognizer 844 · binding 639 · converter 323 · arena 304
  hit_test 294 · pointer_router 144 · team 163 · 其余小文件 ≈ 500
具体手势算法 ≈ 7.3k 行
  tap_and_drag 1486 · monodrag 1103 · multitap 1048 · long_press 882
  scale 860 · multidrag 601 · velocity_tracker 469 · force_press 372
  其余 drag_details 256 · lsq_solver 204 · …
```

**说明**：机制部分里，`recognizer.dart`（844 行）和 `events.dart`（2606 行）占了七成——前者是识别器的公共协议，后者是数据定义，**两者都不是某个手势的算法**。真正需要逐行读的"仲裁与分发"只有 `binding` + `arena` + `hit_test` + `pointer_router` 共 1381 行，不到本层的 10%。

### 实验 2：确认导出面等于文件数

```bash
grep -c "^export" packages/flutter/lib/gestures.dart   # 27
ls packages/flutter/lib/src/gestures/*.dart | wc -l    # 27
```

**实际**：两个数字都是 27。

**说明**：这一层没有"门面 / 实现"之分（对比 `foundation` 的 42 文件对 29 export）。27 个文件全部是公开面，所以**没有任何一个文件是"内部实现细节可以跳过"**——这也意味着不能用"忽略下划线文件"的省事办法筛读。

### 实验 3：`PointerEvent` 家族有多大

```bash
cd packages/flutter/lib/src
grep -c "^class Pointer[A-Za-z]*Event" gestures/events.dart    # 15
grep -c "^class _TransformedPointer" gestures/events.dart       # 15
grep -c "^mixin _CopyPointer" gestures/events.dart              # 15
```

**实际**：公开事件类 15 个、`_TransformedXxxEvent` 15 个、`_CopyXxxEvent` mixin 15 个，三者严格一一对应。

**说明**：**"每个事件类都配一个 transformed 子类和一个 copy mixin"是本层的类数量陷阱**——`events.dart` 里 45 个类型声明，实际只有 15 种事件语义。看到 `_TransformedPointerDownEvent` 不要以为是另一种事件，它只是"带局部坐标缓存的 `PointerDownEvent`"。`PointerEvent.transformed` 的文档（`events.dart:527-542`）写明了它可以返回同一个实例（变换无效果时），也可以返回子类实例。

### 实验 4：`transformed` 是惰性的

读 `events.dart:746-770`（`_TransformedPointerEvent`）：

```dart
// events.dart:761
int get pointer => original.pointer;
```

**预测**：transformed 事件应该在构造时就把 `localPosition` 算好。

**实际**：`_TransformedPointerEvent` 把绝大多数属性直接委托给 `original`，`localPosition` 与 `localDelta` 在首次使用时才按 `transform` 计算并缓存。

**说明**：这解释了为什么一次事件的 `path` 上每个 entry 的 `transform` 不同、但事件对象本身不重复展开——**每一跳只做一次坐标换算，且只在真的读了 `localPosition` 才做**。第 24 篇的实验 3 会给出实测对比。

## 七、结论

1. `gestures` 层的机制只有四块：**事件形状（`events.dart`）、形状转换（`converter.dart`）、命中与分发（`hit_test.dart` + `binding.dart`）、仲裁（`arena.dart` + `pointer_router.dart`）**；加上识别器基类共约 5.8k 行。其余 7k+ 行是各手势的识别算法，是按需查阅的消费方。
2. 本层 27 个文件全部被导出（27 export 对 27 文件），没有"下划线实现文件"。所以筛读时不能按可见性筛，只能按"机制 / 算法"筛。
3. 四类角色的创建者各不相同：`PointerEvent` 每次新建、`PointerRouter` 与 `GestureArenaManager` 是 `GestureBinding` 上的 `final` 单例、`GestureRecognizer` 由 `RawGestureDetectorState` 跟随 widget 复用。**记住谁持有谁，就看懂了这一层的对象图。**

**`gestures` 的机制只有"事件从哪来、送到谁、谁赢"三件，`events.dart` 的 2606 行是数据不是算法。**

## 八、边界声明

- 本文只做分区与角色定位，不展开任何一条链。命中与分发见第 24 篇，竞技场与 `TapGestureRecognizer` 见第 25 篇，`PointerEventConverter` 的坐标换算细节见第 24 篇实验 3。
- 各手势的识别算法（`monodrag`、`scale`、`long_press`、`multitap`、`tap_and_drag`、`force_press`）不做专题。它们是本层的消费方，按类名查即可。
- `velocity_tracker.dart`（速度估计的最小二乘拟合）与 `lsq_solver.dart` 属于数值算法，不展开。
- `resampler.dart` 与 `GestureBinding` 里的 `_Resampler`（指针事件重采样）不在本文展开，只在第 24 篇标出它在 `handlePointerEvent` 里是一个前置分支。
- `eager.dart`（`EagerGestureRecognizer`）作为 `AndroidView` 抢事件的实现，属于 platform_views 的边界，不展开。
- 本文只给出 gestures 层的分层定位，不展开用户视角的事件响应流程。
