# 41 State 生命周期：钩子由谁在何时调用

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`

## 一、问题

`State` 有九个可重写的钩子：

```text
initState            didChangeDependencies   didUpdateWidget
build                deactivate              activate
dispose              reassemble              setState
```

几乎每篇教程都给出了它们的顺序图。但顺序图有一个说不清的地方：**"在什么情况下框架会去调这个钩子"**。

例如 `didChangeDependencies` 的触发条件，常见说法是"依赖的 `InheritedWidget` 变化时"。这句话漏掉了两个更重要的触发点：

- **首次挂载**时它一定会被调一次——哪怕没有任何依赖存在。
- **`GlobalKey` 搬运回来**时它会被补调一次——因为祖先链变了，旧依赖全部作废。

再例如 `deactivate` 和 `dispose` 的相对顺序：常见说法是"deactivate 然后 dispose"。但在 `GlobalKey` 搬运的场景里，**`deactivate` 之后不会出现 `dispose`，紧接着走的是 `activate`**。

所以这一篇不再画顺序图，改给一张**调用点对照表**：每个钩子，分别由 `StatefulElement` 的哪个方法、在代码的哪一行调用。有了这张表，"什么时候会被调"就不需要背了——看谁调它。

## 二、最小 Demo

一个把所有钩子都打上日志、并且能被"搬运"和"销毁"两条路径分别驱动的 `State`：

```dart
import 'package:flutter/widgets.dart';

class Flow extends StatefulWidget {
  const Flow({super.key, this.label = 'A'});
  final String label;

  @override
  State<Flow> createState() => _FlowState();
}

class _FlowState extends State<Flow> {
  @override
  void initState() {
    debugPrint('1. initState           widget=${widget.label}');
    super.initState();
  }

  @override
  void didChangeDependencies() {
    debugPrint('2. didChangeDependencies  widget=${widget.label}');
    super.didChangeDependencies();
  }

  @override
  void didUpdateWidget(Flow oldWidget) {
    // oldWidget 是旧配置，widget 已经是新配置
    debugPrint('3. didUpdateWidget     ${oldWidget.label} → ${widget.label}');
    super.didUpdateWidget(oldWidget);
  }

  @override
  void deactivate() {
    debugPrint('4. deactivate          mounted=$mounted');
    super.deactivate();
  }

  @override
  void activate() {
    debugPrint('5. activate            mounted=$mounted');
    super.activate();
  }

  @override
  void dispose() {
    debugPrint('6. dispose             mounted=$mounted');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('   build               widget=${widget.label}');
    return Text(widget.label, textDirection: TextDirection.ltr);
  }
}
```

用它做三个实验（每条路径对应一组日志）：

| 操作 | 日志 |
|---|---|
| 换成 `Flow(label: 'B')` | `3. didUpdateWidget A → B` → `build` |
| 换成 `SizedBox()`（换 runtimeType） | `4. deactivate` → `6. dispose` |
| 用 `GlobalKey` 在两个父之间搬 | `4. deactivate` → `5. activate` → `build` |

第三行是这张表最能说明问题的地方：`deactivate` 出现了，`dispose` 没有，取而代之的是 `activate`。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:916` | `abstract class State<T extends StatefulWidget> with Diagnosticable` |
| `framework.dart:926` / `927` | `T get widget => _widget!;` / `T? _widget;`，State 持有的配置镜像 |
| `framework.dart:949` | `BuildContext get context`，返回 `_element!` |
| `framework.dart:962` | `StatefulElement? _element;` |
| `framework.dart:973` | `bool get mounted => _element != null;` |
| `framework.dart:1008` | `void initState()` |
| `framework.dart:1036` | `void didUpdateWidget(covariant T oldWidget)` |
| `framework.dart:1051` | `void reassemble()` |
| `framework.dart:1250` | `void deactivate()` |
| `framework.dart:1284` | `void activate()` |
| `framework.dart:1334` | `void dispose()` |
| `framework.dart:1479` | `void didChangeDependencies()` |
| `framework.dart:805` | `enum _StateLifecycle`，调试用状态机 |
| `framework.dart:933` | `_StateLifecycle _debugLifecycleState = _StateLifecycle.created;` |

## 四、调用链

### 4.1 九个钩子分别在 `StatefulElement` 的哪一行被调

这是本文的核心表。左边是 `State` 的钩子，右边是**唯一（或全部）调用它的位置**：

| `State` 钩子 | 调用它的 `StatefulElement` 方法 | 代码行 | 触发条件 |
|---|---|---|---|
| `initState` | `_firstBuild` | `5950` | Element 首次 `mount`，一生一次 |
| `didChangeDependencies` | `_firstBuild` | `5968` | 首次挂载（**无条件调一次**） |
| `didChangeDependencies` | `performRebuild` | `5979` | `_didChangeDependencies` 为真（`:6114` 的延迟标志） |
| `didUpdateWidget` | `update` | `5991` | 父组件传下同类型同 key 的新 Widget |
| `deactivate` | `deactivate` | `6023` | Element 离开树（进 `_inactiveElements`） |
| `activate` | `activate` | `6013` | Element 被 `GlobalKey` 认领回树 |
| `dispose` | `unmount` | `6030` | 帧末真正销毁（一生一次） |
| `reassemble` | `reassemble` | `5943` | 热重载 |
| `build` | `ComponentElement.performRebuild` | `5817` | 通过 `StatefulElement.build`（`:5938`）转发 |
| `setState` | 用户代码调用 | — | `→ Element.markNeedsBuild`（`:5386`） |

**这张表能直接回答三类常见疑问：**

1. **`initState` 与 `didChangeDependencies` 为什么总是连着出现？** 因为它们都在 `StatefulElement._firstBuild`（`:5948`）这一个方法体里，中间只隔着一个 debug 状态机推进（`:5965`）和另一个 debug 断言块（`:5967`）。
2. **`didChangeDependencies` 为什么有时候"连着好多次"？** 因为它有**两个**独立调用点：`_firstBuild:5968` 和 `performRebuild:5979`。前者只发生一次，后者由 `_didChangeDependencies` 标志驱动（下面 4.3 展开）。
3. **`deactivate` 之后紧跟着的一定是 `dispose` 吗？** 不是。`deactivate` 的调用方是 `StatefulElement.deactivate`（`:6022`），而 `dispose` 的调用方是 `StatefulElement.unmount`（`:6028`）。这两个方法之间隔着一整个帧——中间如果发生搬运，走的是 `activate`（`:6011`）而不是 `unmount`。

### 4.2 `_firstBuild`：前两个钩子

```dart
// framework.dart:5947-5974（节选）
@override
void _firstBuild() {
  assert(state._debugLifecycleState == _StateLifecycle.created);
  final Object? debugCheckForReturnedFuture = state.initState() as dynamic;   // 5950 initState
  assert(() { /* 返回 Future 就抛错 */ }());
  assert(() {
    state._debugLifecycleState = _StateLifecycle.initialized;                // 5965
    return true;
  }());
  state.didChangeDependencies();                                             // 5968 第一次
  assert(() {
    state._debugLifecycleState = _StateLifecycle.ready;                       // 5970
    return true;
  }());
  super._firstBuild();                                                       // 5975 → rebuild
}
```

两次 `_debugLifecycleState` 推进的位置很关键：`initState` **之前**断言是 `created`，之后置为 `initialized`；`didChangeDependencies` 之后置为 `ready`。

`State.setState` 里有一条检查依赖这个状态：

```dart
// framework.dart:1186-1197（节选）
if (_debugLifecycleState == _StateLifecycle.created && !mounted) {
  throw FlutterError.fromParts(<DiagnosticsNode>[
    ErrorSummary('setState() called in constructor: $this'),
    ...
  ]);
}
```

在 `initState` 里调 `setState` 是**合法**的（此时状态已经是 `initialized`，而且 `State` 本来就脏）；在**构造函数**里调才会报错。两者的差别就是 `_debugLifecycleState` 是 `created` 还是 `initialized`。第二段检查里的 `!mounted` 说明还有个补充条件——`_element` 为 null，即 `State` 还没被绑到 Element 上。

`_debugLifecycleState` 的初值在 `:933`，四个状态在 `:805` 的 `enum _StateLifecycle` 里。

### 4.3 `didChangeDependencies` 的两条半路径

这是全篇最绕的一处。`Element.didChangeDependencies` 和 `State.didChangeDependencies` **不是**直接调用的关系：

```dart
// framework.dart:5189-5194
@mustCallSuper
void didChangeDependencies() {
  assert(_lifecycleState == _ElementLifecycle.active);
  assert(_debugCheckOwnerBuildTargetExists('didChangeDependencies'));
  markNeedsBuild();                          // 只做这一件事
}
```

`StatefulElement` 把它重写成"记账"：

```dart
// framework.dart:6116-6120
@override
void didChangeDependencies() {
  super.didChangeDependencies();             // → markNeedsBuild
  _didChangeDependencies = true;              // 记一笔：真正 build 时要补调 State 钩子
}
```

然后由 `performRebuild` 兑现：

```dart
// framework.dart:5976-5982
@override
void performRebuild() {
  if (_didChangeDependencies) {
    state.didChangeDependencies();            // 5979 兑现
    _didChangeDependencies = false;
  }
  super.performRebuild();
}
```

`Element.didChangeDependencies` 出现的次数和 `State.didChangeDependencies` 出现的次数**可以不一样**。Element 侧可能被调多次（每次 `markNeedsBuild` 幂等），但 State 侧因为 `_didChangeDependencies` 是布尔量，**一帧内最多兑现一次**。这就是为什么日志里 `didChangeDependencies` 和 `build` 永远相邻——它就贴在 `super.performRebuild()` 之前。

`Element.didChangeDependencies` 有四个调用者：

| 调用者 | 行号 | 场景 |
|---|---|---|
| `StatefulElement._firstBuild`（通过 `state.didChangeDependencies` 间接） | `5968` | 首次挂载 |
| `StatefulElement.performRebuild` | `5979` | 延迟兑现 |
| `Element.activate` | `4771` | `GlobalKey` 搬运回树，且**原来有依赖** |
| `InheritedElement.notifyDependent` | `6373` | 依赖的 `InheritedWidget` 变了（第四十三篇） |

第三条要单独看：

```dart
// framework.dart:4754-4773（节选）
void activate() {
  final bool hadDependencies =
      (_dependencies?.isNotEmpty ?? false) || _hadUnsatisfiedDependencies;   // 搬运前先看有没有依赖
  _lifecycleState = _ElementLifecycle.active;
  _dependencies?.clear();                    // 依赖全部作废（换了祖先链）
  _hadUnsatisfiedDependencies = false;
  _updateInheritance();                      // 重建继承查找表
  attachNotificationTree();
  if (_dirty) {
    owner!.scheduleBuildFor(this);
  }
  if (hadDependencies) {
    didChangeDependencies();                 // 4771：只有"原来有依赖"才补这一刀
  }
}
```

`hadDependencies` 这个局部变量只为了这一处判断而生。

### 4.4 `deactivate` / `activate` / `dispose`：三个转折点

```dart
// framework.dart:6021-6026
@override
void deactivate() {
  state.deactivate();      // 6023：先给 State
  super.deactivate();      // 再给 Element（真正的状态机推进在 _ensureDeactivated 里）
}
```

```dart
// framework.dart:6010-6020（节选）
@override
void activate() {
  super.activate();
  state.activate();        // 6013：Element 先活，State 后活
  markNeedsBuild();        // 6018：State 可能已释放资源，强制重建一次
}
```

```dart
// framework.dart:6027-6052（节选）
@override
void unmount() {
  super.unmount();
  state.dispose();                                            // 6030
  assert(() {
    if (state._debugLifecycleState == _StateLifecycle.defunct) {
      return true;
    }
    throw FlutterError.fromParts(<DiagnosticsNode>[
      ErrorSummary('${state.runtimeType}.dispose failed to call super.dispose.'),
      ...
    ]);
  }());
  state._element = null;                                      // 6043
  _state = null;                                              // 6046
}
```

三处顺序差异值得记住：

| 方法 | 先给谁 | 为什么 |
|---|---|---|
| `deactivate` | State 先，Element 后 | State 需要在"还能用 `context`"时先做清理 |
| `activate` | Element 先，State 后 | `state.activate()` 里可能需要读 `widget` / `context`，要等 Element 状态就绪 |
| `unmount` | Element 先，State 后 | `super.unmount()` 会清 `_widget`，之后 `state._element = null` 让 `mounted` 变 false |

`dispose` 里为什么 `mounted` 还是 `true`？因为 `state._element = null` 在 `:6043`，**在** `state.dispose()`（`:6030`）**之后**。所以在整个 `dispose()` 期间，`State.mounted`（`:973` 的 `_element != null`）仍然是 `true`——这也解释了为什么 `dispose` 里调 `setState` 会得到"setState() called after dispose()"这条报错（`:1162` 检查 `_debugLifecycleState == defunct`）而不是"State 未挂载"。

`unmount` 里那条 `dispose failed to call super.dispose()` 的断言也值得注意：它判的是 `state._debugLifecycleState == _StateLifecycle.defunct`，而这个状态是 `State.dispose`（`:1334`）自己设的。**所以 `super.dispose()` 是必需的**——不调它这个断言就会抛。

### 4.5 `didUpdateWidget` 的两个细节

```dart
// framework.dart:5985-6010（节选）
@override
void update(StatefulWidget newWidget) {
  super.update(newWidget);                                   // 1. Element._widget 换成新的
  final StatefulWidget oldWidget = state._widget!;            // 2. 取旧配置（此时还是旧的）
  state._widget = widget as StatefulWidget;                   // 3. State 侧镜像换成新的
  final Object? debugCheckForReturnedFuture =
      state.didUpdateWidget(oldWidget) as dynamic;            // 4. 钩子，参数是旧配置
  ...
  rebuild(force: true);                                       // 5. 重建
}
```

- **第 2 步必须在第 3 步之前**，否则 `oldWidget` 会取到新值。
- **第 4 步里读 `widget` 已经是新的**（第 3 步已完成），所以 `didUpdateWidget` 提供了"新旧对比"的窗口——这是它的签名带 `oldWidget` 参数的意义。

### 4.6 `setState` 与 `mounted`

```dart
// framework.dart:1160-1225（节选）
void setState(VoidCallback fn) {
  assert(() {
    if (_debugLifecycleState == _StateLifecycle.defunct) {
      throw FlutterError.fromParts(<DiagnosticsNode>[
        ErrorSummary('setState() called after dispose(): $this'),
        ...
      ]);
    }
    if (_debugLifecycleState == _StateLifecycle.created && !mounted) {
      throw FlutterError.fromParts(<DiagnosticsNode>[
        ErrorSummary('setState() called in constructor: $this'),
        ...
      ]);
    }
    return true;
  }());
  final Object? result = fn() as dynamic;                  // 先执行用户回调
  assert(() {
    if (result is Future) {
      throw FlutterError.fromParts(<DiagnosticsNode>[
        ErrorSummary('setState() callback argument returned a Future.'),
        ...
      ]);
    }
    return true;
  }());
  _element!.markNeedsBuild();                              // 最后才是标脏
}
```

三个断言的顺序就是三条常见错误的检测顺序：`dispose` 之后调 → 构造函数里调 → 回调是 `async`。**第三段在 `fn()` 之后检查返回值**，所以 `setState(() async { ... })` 不会在调用时立刻报错，而是在回调返回 `Future` 的那一刻报。

`setState` 的全部效果就是"执行回调 + `markNeedsBuild`"。它**不重建、不刷新屏幕**，只是把一个 Element 加进脏列表并请求一帧。完整链路见第四十二篇。

## 五、核心对象：`State` 与 `StatefulElement` 的职责划分

| | `State<T>` | `StatefulElement` |
|---|---|---|
| 声明位置 | `framework.dart:916` | `framework.dart:5900` |
| 谁创建谁 | `StatefulElement` 通过 `widget.createState()` 创建 State（`:5902`） | — |
| 持有对方的引用 | `StatefulElement? _element`（`:962`，私有） | `State<StatefulWidget>? _state`（`:5939`） |
| 业务代码能拿到对方吗 | 只能拿到 `context`（`:949`，转成 `BuildContext`） | 不对外暴露（`state` getter 是 `@protected` 语义） |
| 谁保管用户数据 | **State** | 不保管 |
| 谁保管配置 | `T? _widget`（`:927`） | `Widget? _widget`（`:3654`） |
| 谁有生命周期状态机 | `_StateLifecycle _debugLifecycleState`（`:933`，仅 debug） | `_ElementLifecycle _lifecycleState`（`:3881`，release 下也是真的） |
| 钩子由谁调用 | 被调用者 | **调用者**（第 4.1 节那张表） |
| `mounted` 的判据 | `_element != null`（`:973`） | `_widget != null`（`:3657`） |
| `dispose` 时 `mounted` | 仍为 `true`（`:6043` 在其后） | 已为 `false`（`:4863` 在其前） |

最后一行是全表最实用的差异：**同一个时刻，两者的 `mounted` 可能不一致**。`StatefulElement.unmount` 里 `super.unmount()`（清 `_widget`）在前、`state._element = null` 在后，所以 `dispose()` 执行期间 Element 已 `mounted == false`、State 仍 `mounted == true`。

## 六、源码实验

### 实验 1：数一数每个钩子有几个调用点

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
for h in initState didChangeDependencies didUpdateWidget deactivate activate dispose reassemble; do
  printf '%-24s %s\n' "$h" "$(grep -cn "state\.$h()" framework.dart)"
done
```

**预测**：每个钩子应该只有一处调用（除了 `didChangeDependencies`）。

**实际**：

```text
initState                1
didChangeDependencies    2      ← 唯一有两个调用点的
didUpdateWidget          1
deactivate               1
activate                 1
dispose                  1
reassemble               1
```

**说明**：`didChangeDependencies` 是唯一"可以在一次生命周期里出现多次"的钩子，因为它有两个调用点（`:5968` 的首次、`:5979` 的延迟兑现）。其余钩子都严格一生一次或每帧一次。

### 实验 2：确认 `didChangeDependencies` 首帧无条件被调

在 Demo 的 `_FlowState.build` 里**不注册任何依赖**，直接跑起来。

**预测**：既然没有依赖，`didChangeDependencies` 不应该被调。

**实际**：第一帧的日志是 `1. initState` → `2. didChangeDependencies` → `build`。**没有依赖也调了。**

**说明**：因为调用点在 `StatefulElement._firstBuild:5968`，它是无条件的。这也是为什么"在 `didChangeDependencies` 里注册依赖"这个写法能工作——首次挂载时它一定会被执行一次。

### 实验 3：搬运时不调 `dispose`，但会调 `didChangeDependencies`

用第三十九篇的 `ReparentLab`（把 `Leaf` 换成这里的 `Flow`），并且让 `Flow` 的 `didChangeDependencies` 里注册一个 `InheritedWidget` 依赖。

**预测**：`deactivate` → `activate` → `didChangeDependencies` → `build`。

**实际日志**：

```text
4. deactivate          mounted=true
5. activate            mounted=true
2. didChangeDependencies  widget=A
   build               widget=A
```

**说明**：`dispose` 一次都没出现，但 `didChangeDependencies` 出现了——因为 `Element.activate:4771` 那行 `if (hadDependencies) didChangeDependencies();` 命中了。这次的调用链是 `didChangeDependencies` → `markNeedsBuild` + `_didChangeDependencies = true` → `performRebuild` → `state.didChangeDependencies`，**两处调用点都走了**。

### 实验 4：`dispose` 里 `State.mounted` 还是 `true`，但 `context.widget` 已经不能读

在 `dispose` 里打印两个 `mounted`，并试着从 `context` 读 widget：

```dart
@override
void dispose() {
  debugPrint('dispose: State.mounted=$mounted');
  try {
    // 试着从 context 读 widget
    debugPrint('dispose: widget=${context.widget.runtimeType}');
  } catch (error) {
    debugPrint('dispose: 读 context.widget 抛了 ${error.runtimeType}');
  }
  super.dispose();
}
```

**预测**：`State.mounted` 应该是 `false`（"已经从树上移除了"），`context.widget` 应该能正常读到。

**实际输出**：

```text
dispose: State.mounted=true
dispose: 读 context.widget 抛了 _TypeError
```

**说明**：两个预测都错了，而两个错误都能从调用顺序推出来。

`StatefulElement.unmount`（`:6028`）的顺序是：

```dart
void unmount() {
  super.unmount();      // 1. Element.unmount：把 _widget 置空、_lifecycleState 设为 defunct
  state.dispose();      // 2. 才轮到 State.dispose
  ...
  state._element = null;   // 3. 最后才断开 State → Element
  _state = null;
}
```

而 `Element.unmount`（`:4851`）里会执行 `_widget = null`（`:4863`），`Element.widget` 的实现又是 `Widget get widget => _widget!;`（`:3653`）——所以第 2 步里读 `context.widget` 会得到 `Null check operator used on a null value`。

反过来，`State.mounted` 的判据是 `_element != null`（`:973`），而 `state._element = null` 要到第 3 步才执行，所以 `dispose` 期间 `State.mounted` 仍是 `true`。

`dispose` 里 `context` 只是作为一个对象引用还存在，**不能再用它做任何查找**——查祖先（`findAncestorStateOfType` / `findAncestorWidgetOfExactType` / `visitAncestorElements` 等）和读 `InheritedWidget`（`dependOnInheritedWidgetOfExactType` / `getInheritedWidgetOfExactType`）都会被 `_debugCheckStateIsActiveForAncestorLookup`（`:5046`）的断言拦下，抛出 `FlutterError`："Looking up a deactivated widget's ancestor is unsafe."（该断言只在 debug 模式生效）。原因：第 1 步 `super.unmount()` 已经把 Element 的 `_lifecycleState` 置成 `defunct`（`:4865`），这条断言判的正是 `_lifecycleState != active`。此时 `State.mounted` 仍是 `true`，只是 `_element` 要到第 3 步才置空的副作用，**不代表 `context` 还能用**。要在 `dispose` 里用 widget 的字段，必须在之前把它存进 State 自己的字段（比如 `initState` 或 `didUpdateWidget` 里），这是很常见的写法：

```dart
class _MyState extends State<MyWidget> {
  late final ScrollController _controller;   // 自己持有，不依赖 widget 引用

  @override
  void initState() {
    super.initState();
    _controller = ScrollController();
  }

  @override
  void dispose() {
    _controller.dispose();   // 只需要自己的字段
    super.dispose();
  }
}
```

## 七、结论

1. `State` 的九个钩子里，`didChangeDependencies` 是唯一有**两个**调用点的（`_firstBuild:5968` 首次、`performRebuild:5979` 延迟兑现），其余各只有一个。首次挂载时它**无条件被调一次**，与有没有依赖无关。
2. `Element.didChangeDependencies`（`:5190`）只做 `markNeedsBuild()`，**不直接调 `State.didChangeDependencies`**。`StatefulElement` 用一个布尔标志 `_didChangeDependencies`（`:6114`）把调用延迟到 `performRebuild` 开头，这使日志上 `didChangeDependencies` 与 `build` 永远相邻，且一帧内最多兑现一次。
3. `deactivate` 与 `dispose` 之间隔着一帧，中间可能插入 `activate`（搬运场景）。且三个方法的"先给谁"顺序不同：`deactivate` 是 State 先、`activate` 是 Element 先、`unmount` 是 Element 先——**结果是 `dispose()` 执行期间 `State.mounted` 仍为 `true` 而 `Element.mounted` 已经是 `false`**。

**不用背钩子顺序，记住谁调它——`_firstBuild` 管 `initState` + 首次 `didChangeDependencies`，`performRebuild` 管延迟的 `didChangeDependencies`，`update` 管 `didUpdateWidget`，`deactivate`/`activate`/`unmount` 各管一个。**

## 八、边界声明

- 本文只做**调用点对照**，不展开生命周期各阶段的语义解释。
- `setState` 的完整链路（`markNeedsBuild` → `scheduleBuildFor` → `buildScope`）见**第四十二篇**。
- `dependOnInheritedElement` 如何注册依赖、`notifyDependent` 何时被调，见**第四十三篇**。
- `didUpdateWidget` 之前的 `updateChild` 判定见**第三十八篇**；`activate` 前的认领流程见**第三十九篇**。
- `_StateLifecycle` 的四个状态（`:805`）与 `_debugLifecycleState` 的状态机只讲了 `created` / `initialized` / `ready` / `defunct` 与两个断言的对应关系，不展开 `debugMaybeDispatchCreated` 之类的调试辅助。
- **Flutter 3.44.8 的源码与常见说法不一致之一**：常见说法是"`initState` 里 `context` 不可用、`didChangeDependencies` 里才可以"。Flutter 3.44.8 的源码里，`initState` 里 `context` **可用**（`_element` 在 `StatefulElement` 构造函数里就已经赋值，`:5919`），但 `dependOnInheritedWidgetOfExactType` 会因为 `StatefulElement.dependOnInheritedElement` 里那条 `state._debugLifecycleState == created` 断言（`:6050-6054`，断言在 `:6053`）而抛错。
- **不一致之二**：`StatefulElement` 的文档注释（`:5941-5942`）说 `State` 是在 `mount` 里创建的，实际是在构造函数里（`:5902`），与第四十篇指出的同一处过时注释。
