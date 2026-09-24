# 49 Navigator 与 Route 与 Overlay：页面为什么能叠起来

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/navigator.dart`（6224 行）、`widgets/routes.dart`（2434 行）、`widgets/overlay.dart`（2812 行）、`widgets/pages.dart`、`material/page.dart`

## 一、问题

`Navigator.push` 之后，新页面出现在旧页面之上，旧页面还能从边缘滑回来。最自然的解释是：**Navigator 就是一个页面栈，栈顶的页面画在上面。**

这个解释在"谁负责画"上错了。`NavigatorState.build` 里没有任何 `Stack`、没有 Z 序、没有偏移量：

```dart
// navigator.dart:5908-5946（节选）
Widget build(BuildContext context) {
  return HeroControllerScope.none(
    child: NotificationListener<NavigationNotification>(
      child: Listener(
        child: AbsorbPointer(
          child: FocusTraversalGroup(
            child: Focus(
              child: UnmanagedRestorationScope(
                bucket: bucket,
                child: Overlay(                          // ← 唯一的渲染能力来自这里
                  key: _overlayKey,
                  clipBehavior: widget.clipBehavior,
                  initialEntries: overlay == null
                      ? _allRouteOverlayEntries.toList(growable: false)
                      : const <OverlayEntry>[],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
```

**Navigator 不画页面。它把 `Route` 产出的 `OverlayEntry` 交给 `Overlay`，由 Overlay 负责堆叠。** Navigator 的角色是"状态机 + 编排"：决定哪些 route 在场、什么时候进场出场、谁拿到 `didChangeNext`，然后把结果翻译成"往 Overlay 里插/删/移哪些 entry"。

于是 "页面栈" 的准确说法是：**`_history` 是一个路由状态列表，`OverlayState._entries` 才是真正的绘制顺序列表**。两者由 `_flushHistoryUpdates` 同步，而不是同一个东西。

## 二、最小 Demo

不写 `Navigator.push`，手动往 Overlay 里塞两个 entry，就能看出"叠"是怎么回事：

```dart
import 'package:flutter/material.dart';

class OverlayLayers extends StatefulWidget {
  const OverlayLayers({super.key});

  @override
  State<OverlayLayers> createState() => _OverlayLayersState();
}

class _OverlayLayersState extends State<OverlayLayers> {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      // 1. builder 拿到的 context 在 Navigator 之下、Overlay 之上
      builder: (BuildContext context, Widget? navigator) {
        return Overlay(
          initialEntries: <OverlayEntry>[
            // 2. 第 1 层：Navigator 本体（它自己也是一个 entry）
            OverlayEntry(builder: (BuildContext context) => navigator!),
            // 3. 第 2 层：叠加在上面的浮层，位置由自己决定
            OverlayEntry(
              builder: (BuildContext context) => const Positioned(
                left: 24,
                top: 120,
                child: Material(
                  elevation: 8,
                  child: Padding(
                    padding: EdgeInsets.all(16),
                    child: Text('我是 OverlayEntry，不是 Route'),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}
```

这个 Demo 说明两件事：

- **`Overlay` 本身没有任何"页面"概念**，它只认识 `OverlayEntry`。
- **`Navigator` 也是被塞进 Overlay 的一层**（`WidgetsApp` 里就是这么做的）。所以"overlay 之上再加浮层"不需要 Navigator 参与。

再看自动化的那一半——`MaterialPageRoute` 到底往 Overlay 里放了什么：

```dart
// routes.dart:2350-2358
Iterable<OverlayEntry> createOverlayEntries() {
  return <OverlayEntry>[
    _modalBarrier = OverlayEntry(builder: _buildModalBarrier),   // 1. 遮挡层
    _modalScope = OverlayEntry(
      builder: _buildModalScope,                                 // 2. 页面内容
      maintainState: maintainState,
      canSizeOverlay: opaque,
    ),
  ];
}
```

**两个页面 = 四条 entry**。这就是第六节实验里"单页面 `_OverlayEntryWidget` 数量是 2、push 之后变成 3"的来源——第 4 条（被覆盖页面的 barrier）因为 `maintainState: false` 根本没被构建。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/navigator.dart:161` | `abstract class Route<T> extends _RoutePlaceholder`，路由契约 |
| `widgets/navigator.dart:247` | `List<OverlayEntry> get overlayEntries => const <OverlayEntry>[];`，**默认是空的** |
| `widgets/navigator.dart:2309` | `static Future<T?> push<T>(BuildContext context, Route<T> route)`，`context` 版本 |
| `widgets/navigator.dart:3715` | `class NavigatorState extends State<Navigator>` |
| `widgets/navigator.dart:3717` | `final _History _history = _History();`，**路由状态列表**（不是 Overlay 列表） |
| `widgets/navigator.dart:3646` | `class _History extends Iterable<_RouteEntry> with ChangeNotifier` |
| `widgets/navigator.dart:4124` | `Iterable<OverlayEntry> get _allRouteOverlayEntries`，history → overlay 的投影 |
| `widgets/navigator.dart:3215` / `3222` | `_RouteEntry.handleAdd` / `handlePush`，状态机的两个入口动作 |
| `widgets/navigator.dart:4423` | `void _flushHistoryUpdates({bool rearrangeOverlay = true})`，**核心同步点** |
| `widgets/navigator.dart:5027` / `5079` | `NavigatorState.push` / `_pushEntry` |
| `widgets/navigator.dart:5908` | `NavigatorState.build`，只产出一个 `Overlay` |
| `widgets/routes.dart:55` | `abstract class OverlayRoute<T> extends Route<T>` |
| `widgets/routes.dart:61` | `Iterable<OverlayEntry> createOverlayEntries();`，**子类必须实现** |
| `widgets/routes.dart:68` | `OverlayRoute.install`，把 `createOverlayEntries()` 的结果收进 `_overlayEntries` |
| `widgets/routes.dart:111` | `abstract class TransitionRoute<T> extends OverlayRoute<T>` |
| `widgets/routes.dart:324` / `337` | `TransitionRoute.install` / `didPush`，动画控制器的接线点 |
| `widgets/routes.dart:1266` | `abstract class ModalRoute<T> extends TransitionRoute<T>` |
| `widgets/routes.dart:2350` | `ModalRoute.createOverlayEntries`，产出门闸 + 页面两个 entry |
| `widgets/pages.dart:23` | `abstract class PageRoute<T> extends ModalRoute<T>` |
| `material/page.dart:35` | `class MaterialPageRoute<T> extends PageRoute<T>` |
| `widgets/overlay.dart:109` | `class OverlayEntry implements Listenable` |
| `widgets/overlay.dart:650` / `651` | `OverlayState` / `final List<OverlayEntry> _entries` |
| `widgets/overlay.dart:742` / `758` | `insert` / `insertAll` |
| `widgets/overlay.dart:888` | `OverlayState.build`，把 `_entries` 按 opacity 切成 onstage / offstage |
| `widgets/overlay.dart:983` / `1194` | `_Theater` / `_RenderTheater`（私有渲染细节，本篇只提结论） |

## 四、调用链

### 4.1 一次 `push` 的物理链路

```text
Navigator.push(context, MaterialPageRoute(builder: ...))
  └─ Navigator.of(context).push(route)                    navigator.dart:2309
       └─ NavigatorState.push(route)                      navigator.dart:5027
            ├─ _RouteEntry(route, pageBased: false, initialState: _RouteLifecycle.push)
            ├─ _pushEntry(entry)                          navigator.dart:5079
            │    ├─ _history.add(entry)                   ← 只是加进自己的列表
            │    ├─ _flushHistoryUpdates()                ← 真正干活的地方
            │    └─ _afterNavigation(entry.route)         ← 发 Flutter.Navigation 事件
            └─ return route.popped                        ← 返回 Future<T?>
```

注意 `push` 只做两件事：**造一个 `_RouteEntry` 塞进 `_history`，然后调 `_flushHistoryUpdates`**。所有真正的动作（install route、建 OverlayEntry、插入 Overlay、启动动画）都在 `_flushHistoryUpdates` 里，由 `_RouteEntry.currentState` 决定。

```dart
// navigator.dart:5027-5030
Future<T?> push<T extends Object?>(Route<T> route) {
  _pushEntry(_RouteEntry(route, pageBased: false, initialState: _RouteLifecycle.push));
  return route.popped;                 // Future 在 route 被 pop 时完成
}
```

### 4.2 `_flushHistoryUpdates`：状态机与 Overlay 的同步点

这是全篇最长的一个方法（`navigator.dart:4423` 起，约 300 行），它的形状是一个 `while` 从栈顶往下扫，按每个 entry 的 `currentState` 分支：

```dart
// navigator.dart:4434-4458（节选）
var canRemoveOrAdd = false;   // 顶层已有全不透明 route，可以静默增删下层
while (index >= 0) {
  switch (entry!.currentState) {
    case _RouteLifecycle.add:
      entry.handleAdd(navigator: this, previousPresent: ...);
      assert(entry.currentState == _RouteLifecycle.adding);
      continue;
    case _RouteLifecycle.push:
      entry.handlePush(navigator: this, previous: previous?.route, isNewFirst: next == null);
    case _RouteLifecycle.idle:
      ...
      canRemoveOrAdd = true;
  }
}
```

`handlePush` 是"从状态到画面"的关键一跳：

```dart
// navigator.dart:3222-3260（节选）
void handlePush({required NavigatorState navigator, required bool isNewFirst, ...}) {
  currentState = _RouteLifecycle.pushing;
  route._navigator = navigator;
  route.install();                       // 1. 让 route 产出 OverlayEntry
  assert(route.overlayEntries.isNotEmpty);
  if (currentState == _RouteLifecycle.push || currentState == _RouteLifecycle.pushReplace) {
    final TickerFuture routeFuture = route.didPush();    // 2. 启动进场动画
    currentState = _RouteLifecycle.pushing;
    routeFuture.whenCompleteOrCancel(() {
      if (currentState == _RouteLifecycle.pushing) {
        currentState = _RouteLifecycle.idle;             // 3. 动画结束 → idle
        navigator._flushHistoryUpdates();                // 4. 再同步一次
      }
    });
  }
}
```

`handlePush` 里"动画结束了要再调一次 `_flushHistoryUpdates`"这一点很重要：**`push` 不是一个瞬间完成的动作，它跨了三帧以上**（push → pushing → idle），每次状态变化都要重跑同步。这也是为什么 `_history` 需要一个 `_RouteLifecycle` 状态机而不是一个 bool。

`install()` 定义在 `OverlayRoute` 上——**"route 产出 OverlayEntry"这一步是 `OverlayRoute` 独有的**：

```dart
// routes.dart:68-72
void install() {
  assert(_overlayEntries.isEmpty);
  _overlayEntries.addAll(createOverlayEntries());
  super.install();
}
```

然后 Navigator 把这些 entry 交出去：

```dart
// navigator.dart:4124-4126
Iterable<OverlayEntry> get _allRouteOverlayEntries {
  return <OverlayEntry>[for (final _RouteEntry entry in _history) ...entry.route.overlayEntries];
}
```

**关键认知**：Navigator 与 Overlay 之间**没有专门的"插入"协议**，只有两条路径——

- **初始**：`Overlay(initialEntries: _allRouteOverlayEntries)`（`navigator.dart:5944-5947`）。只有 `overlay == null`（Overlay 还没建）时才用。
- **后续**：`_RouteEntry.didAdd`（`navigator.dart:3376`）里调 `route.install()` + `route.didAdd()`，由 route 与 `Overlay` 完成插入。看 `OverlayRoute` 基类里那个很直白的说明（`routes.dart:563`）：

> This method should not remove its [overlayEntries] from the [Overlay].

也就是说 **route 只负责"产出"entry，插删由 `_RouteEntry` 做**。这个分工是 `_RouteEntry` 存在的理由。

### 4.3 `Route` → `OverlayEntry` 的继承链

```text
Route<T>                          navigator.dart:161   ← 只有 popped / didPush / didPop 等契约
└─ OverlayRoute<T>                routes.dart:55       ← 加了 createOverlayEntries / overlayEntries
   └─ TransitionRoute<T>          routes.dart:111      ← 加了 AnimationController（进场出场动画）
      └─ ModalRoute<T>            routes.dart:1266     ← 加了 barrier / _ModalScope / canPop
         └─ PageRoute<T>          pages.dart:23        ← 加上全屏语义（opaque/barrierDismissible）
            └─ MaterialPageRoute  material/page.dart:35
```

每一层加的东西很清楚：

| 层 | 新增的概念 | 关键成员 |
|---|---|---|
| `Route` | 生命周期契约 | `didPush` / `didPop` / `didReplace`、`overlayEntries`（返回空列表） |
| `OverlayRoute` | **和 Overlay 的接口** | `createOverlayEntries`、`install`、`finishedWhenPopped` |
| `TransitionRoute` | 动画 | `_animationController`、`install`（`routes.dart:324`）、`didPush`（`:337`） |
| `ModalRoute` | 遮挡与作用域 | `_modalBarrier`、`_modalScope`、`_scopeKey`、`canPop` |
| `PageRoute` | 页面语义 | `opaque => true`、`barrierDismissible`、`canTransitionTo` |
| `MaterialPageRoute` | Material 转场 | `MaterialRouteTransitionMixin`（一个 mixin，不是新机制） |

**关键认知**：`Route` 基类的 `overlayEntries` 返回的是 `const <OverlayEntry>[]`（`navigator.dart:247`）。所以**一个不继承 `OverlayRoute` 的 route 永远不会被画出来**——它能进 `_history`，但 `handlePush` 里的 `assert(route.overlayEntries.isNotEmpty)` 会直接失败。这就是"Route 与 OverlayEntry 是两个层次"的硬证据。

### 4.4 Overlay 侧：`_entries` 是绘制顺序，`opaque` 是剪刀

`OverlayState` 只维护一个列表：

```dart
// overlay.dart:650-651
class OverlayState extends State<Overlay> with TickerProviderStateMixin {
  final List<OverlayEntry> _entries = <OverlayEntry>[];
```

`insert` 的唯一决策是"插在哪个下标"：

```dart
// overlay.dart:742-748
void insert(OverlayEntry entry, {OverlayEntry? below, OverlayEntry? above}) {
  assert(_debugVerifyInsertPosition(above, below));
  assert(_debugCanInsertEntry(entry));
  entry._overlay = this;
  setState(() {
    _entries.insert(_insertionIndex(below, above), entry);
  });
}
```

`build` 则把列表**倒着**扫一遍，用 `opaque` 切出"在上面的（onstage）"和"被盖住的（offstage）"：

```dart
// overlay.dart:888-918（节选）
Widget build(BuildContext context) {
  final children = <_OverlayEntryWidget>[];
  var onstage = true;
  var onstageCount = 0;
  for (final OverlayEntry entry in _entries.reversed) {   // 1. 从栈顶往下扫
    if (onstage) {
      onstageCount += 1;
      children.add(_OverlayEntryWidget(key: entry._key, overlayState: this, entry: entry));
      if (entry.opaque) {
        onstage = false;      // 2. 遇到不透明层，下面的全部退出 onstage
      }
    } else if (entry.maintainState) {
      children.add(_OverlayEntryWidget(..., tickerEnabled: false));  // 3. 保留但不激活
    }
  }
  return _Theater(skipCount: children.length - onstageCount);  // 4. 前 N 个是 offstage
}
```

三个结论都能从这 30 行读出来：

1. **`opaque` 是能不能"盖住"的唯一判据。** 它由 entry 自己声明（`OverlayEntry(opaque: ...)`，`:117`）；`ModalRoute` 里 `_modalScope` 的 `canSizeOverlay: opaque` 也来自 `Route.opaque`。
2. **`maintainState` 决定被盖住的 entry 是否还留在 widget 树里。** `ModalRoute._modalScope` 传的就是 `maintainState`（`routes.dart:2355`），而 `MaterialPageRoute` 默认 `maintainState: true`（`material/page.dart:41`）。
3. **`_Theater` 的 `skipCount` 不是"不创建"，只是"标为 offstage"**。`skipCount` 的语义在 `_RenderTheater` 里（`overlay.dart:1194`），它让 offstage 的孩子不参与 layout 的 paint 部分但仍然存在。

### 4.5 `_History` 为什么也继承 `ChangeNotifier`

```dart
// navigator.dart:3646-3656
class _History extends Iterable<_RouteEntry> with ChangeNotifier {
  _History() {
    if (kFlutterMemoryAllocationsEnabled) {
      ChangeNotifier.maybeDispatchObjectCreation(this);
    }
  }

  final List<_RouteEntry> _value = <_RouteEntry>[];

  void add(_RouteEntry element) {
    _value.add(element);
    notifyListeners();               // ← 任何增删都通知
  }
```

这不是为了页面重绘，是为了**通知外界"能不能 pop"变了**：

```dart
// navigator.dart:3743-3749（节选）
void _handleHistoryChanged() {
  final bool navigatorCanPop = canPop();
  ...
  final notification = NavigationNotification(canHandlePop: navigatorCanPop || routeBlocksPop);
```

`NavigationNotification` 是给**系统返回手势**用的（Android 的 predictive back、iOS 的边缘手势）。所以 `_History` 是个 `ChangeNotifier` 的原因是"栈的变化需要广播给 Navigator 之外的订阅者"。

## 五、核心对象：三层的职责边界

| | `NavigatorState` | `Route` | `OverlayState` |
|---|---|---|---|
| 声明位置 | `navigator.dart:3715` | `navigator.dart:161` | `overlay.dart:650` |
| 持有的数据 | `_History _history`（`_RouteEntry` 列表） | 自己产出的 `_overlayEntries` | `List<OverlayEntry> _entries` |
| 知道"页面"吗 | 知道（`Route` + 生命周期） | 知道自己 | **完全不知道**，只认识 entry |
| 知道 Z 序吗 | 不直接知道 | 不知道 | 知道（`_entries` 的顺序） |
| 会画东西吗 | 不会，只 build 一个 `Overlay` | 不会，只 build 出 child widget | 不会，真正的绘制在 `_RenderTheater` |
| 谁创建 OverlayEntry | 不创建 | `OverlayRoute.createOverlayEntries` | 不创建 |
| 谁插入 OverlayEntry | `_RouteEntry`（间接） | 不插（`routes.dart:563` 明确写了） | `insert` / `insertAll` / `rearrange` |
| 动画归属 | 不持有 | `TransitionRoute` 持有 `AnimationController` | `tickerEnabled` 由 Overlay 传给 entry widget |
| 状态机 | `_RouteLifecycle`（10 个状态，`navigator.dart:3109`） | 无 | 无 |

**三句话记住分工**：`Route` 是"页面这份数据长什么样、怎么进场出场"，`OverlayEntry` 是"一块可以被堆叠的渲染内容"，`Navigator` 是"按什么顺序把前者变成后者"。

### `MaterialPageRoute` 到底比 `PageRoute` 多了什么

| | `PageRoute`（`pages.dart:23`） | `MaterialPageRoute`（`material/page.dart:35`） |
|---|---|---|
| 转场 | 无（`buildTransitions` 由子类实现） | `with MaterialRouteTransitionMixin<T>` |
| 新增机制 | 无 | **无**，只是一个 mixin 提供 `buildTransitions` |
| `buildContent` | 抽象 | `builder(context)` |
| `debugLabel` | `runtimeType` | `'$runtimeType(${settings.name})'` |

`MaterialPageRoute` 是"material 层没有新机制"最干净的例子：它只多了一个 mixin（提供平台自适应的 `buildTransitions`）和一个 `builder` 字段。第 51 篇会用同样的方法解剖 `Material` 与 `InkWell`。

## 六、源码实验

### 实验 1：一个 route 到底产生几条 OverlayEntry

`MaterialApp(home: ...)`，然后 push 一个 `MaterialPageRoute`：

```text
LAB4 overlayWidgets=1 barriers=1
LAB4 _OverlayEntryWidget=2
LAB4 renderObject=_RenderTheater renderChildren=2
LAB4 after push renderChildren=3 _OverlayEntryWidget=3 barriers(onstage)=1 barriers(all)=1
LAB4 home onstage=0 home any=1
```

**预测**：两个页面应该产生 4 个 entry（每页 barrier + scope）。

**实际**：push 之后只有 **3** 个 `_OverlayEntryWidget`、`_RenderTheater` 的 render child 也是 3。

**说明**：按 4.4 节那段 `build` 的逻辑推演就能对上：`_entries` 从底到顶是

```text
[route1.barrier, route1.scope, route2.barrier, route2.scope]
```

倒着扫：`route2.scope`（onstage，且 `opaque == true` → `onstage` 置 false）、`route2.barrier`（已 offstage，`maintainState` 为 false → **不加**）、`route1.scope`（offstage 但 `maintainState` 为 true → 加，`tickerEnabled: false`）、`route1.barrier`（不加）。所以是 3 个。

`barriers(all)=1` 也就顺理成章：**第 1 个页面的 ModalBarrier 根本没有被构建**，不是"构建了但不可见"。

`home any=1` 则说明第 1 个页面的**内容**还在树上（`maintainState: true` 保留），只是 `find.text('home')` 默认跳过 offstage 所以找不到。**如果你想让被覆盖页面的 widget 彻底不构建，把 `MaterialPageRoute(maintainState: false)`**，代价是回去时状态全丢。

### 实验 2：确认 Navigator 只是一个普通 widget，可以被塞进任何 Overlay

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src
grep -n "Overlay(" widgets/navigator.dart | head
grep -n "Overlay(" widgets/app.dart | head
```

**实际**：`navigator.dart:5939` 是 `NavigatorState.build` 里那个唯一的 `Overlay(`；`widgets/app.dart` 里 `WidgetsApp` 也用 `Overlay` 把 Navigator 与 debug banner 叠在一起。

**说明**：`Navigator` 与 `Overlay` 都是普通 widget，没有"必须由框架创建"的特权。这也是 `MaterialApp.builder` 能拿到 `navigator` 参数再自己包一层的原因（第二节的 Demo 就是照这个写的）。

### 实验 3：确认 `Route` 默认不产出任何 entry

```bash
grep -n "List<OverlayEntry> get overlayEntries" widgets/navigator.dart widgets/routes.dart
```

**实际**：`navigator.dart:247` 是 `=> const <OverlayEntry>[]`；`routes.dart:64` 是 `=> _overlayEntries`（`OverlayRoute` 的覆写）。

**说明**：两行代码把继承链的必要性说清了——**想被画出来就必须经过 `OverlayRoute`**。这也解释了 `_RouteEntry.handlePush` 里那句 `assert(route.overlayEntries.isNotEmpty)`（`navigator.dart:3242`）为什么放在 `install()` 之后立刻执行：它是在检查"你确实是 OverlayRoute 的后代"。

### 实验 4：观察 `_RouteLifecycle` 的 10 个状态

```bash
grep -n "enum _RouteLifecycle" widgets/navigator.dart
sed -n '3109,3145p' widgets/navigator.dart
```

**实际**：`navigator.dart:3109` 起是 `_RouteLifecycle`，包含 `add` / `adding` / `push` / `pushReplace` / `replace` / `pushing` / `idle` / `pop` / `popping` / `remove` / `dispose` / `complete` 等取值。

**说明**：这个状态机的分支数（十几个）远多于"push / pop"两个动作的直觉。多出来的状态主要是两类：**动画进行中**（`pushing` / `popping`）与**静默增删**（`add` / `remove` / `complete`，被 `canRemoveOrAdd` 控制）。`_flushHistoryUpdates` 里那个 `canRemoveOrAdd` 变量的作用是：**一旦在栈顶遇到"完全遮住下面的 route"，它下面的 route 的增删就不需要播放动画了**——这是"从深层页面直接跳回首页"能瞬时的原因。

## 七、结论

1. `Navigator` 不绘制任何页面。它的 `build` 只有一个 `Overlay`（`navigator.dart:5944`），页面的堆叠完全由 `Overlay` 按 `_entries` 的顺序决定。真正的绘制在 `_RenderTheater`（`overlay.dart:1194`）。
2. `Route` 的价值是"从生命周期契约生成 `OverlayEntry`"：基类 `Route.overlayEntries` 返回空列表（`navigator.dart:247`），只有 `OverlayRoute` 及其后代才通过 `createOverlayEntries`（`routes.dart:61`）产出 entry，而 `ModalRoute` 一次产出**两个**（barrier + scope，`routes.dart:2350`）。Route 负责产出，插删由 `_RouteEntry` 与 `OverlayState` 做。
3. `OverlayState.build`（`overlay.dart:888`）用两个布尔量决定"构建哪些 entry"：`opaque` 切断 onstage 传播，`maintainState` 决定被盖住的 entry 是否保留在树上。实测一个 `MaterialPageRoute` 覆盖另一个时，`_RenderTheater` 只有 3 个 render child（4 条 entry 里第 1 页的 barrier 没被构建），而被覆盖页面的内容**仍在树上、只是 offstage**。

一句话总结：**Navigator 是路由状态的编排者，Route 是 `OverlayEntry` 的生产者，只有 Overlay 知道谁叠在谁上面。**

## 八、边界声明

- 本篇只讲"页面为什么能叠起来"这条链（Navigator → Route → Overlay）。**`MaterialApp` 如何组装 Router / Navigator、`onGenerateRoute` 与命名路由的解析规则，属于 widget 组合层**，按类名读即可。
- `Router` / `RouteInformationParser` / `RouterDelegate` 这套声明式 API 与 `Navigator` 的关系（`Navigator(pages:)` 走的是 `_updatePages`，`navigator.dart:4130`）不展开；它复用同一套 `_flushHistoryUpdates`。
- `TransitionRoute` 的 `AnimationController` 细节、`ModalRoute` 的 `barrierDismissible` / `popGesture` / `LocalHistoryEntry` 都不展开。转场动画的数值过程属于第 5 卷 `animation` 层。
- `_Theater` / `_RenderTheater` / `_OverlayEntryLocation` 的私有实现（`overlay.dart:983-1680`、`:2152`）不展开；本篇只用到 `skipCount` 这一个结论。
- `OverlayPortal`（`overlay.dart:1868`）与 `_DeferredLayout` 属于同文件的另一套机制，不展开。
- 页面返回值的 `Future<T?>`、`WillPopScope` / `PopScope` 的拦截链不展开。