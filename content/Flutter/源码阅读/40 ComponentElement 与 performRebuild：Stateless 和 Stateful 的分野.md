# 40 ComponentElement 与 performRebuild：Stateless 和 Stateful 的分野

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`

## 一、问题

`StatelessWidget` 和 `StatefulWidget` 的差别，通常被说成"一个没有状态，一个有状态"。

这句话对，但它没有回答一个更具体的问题：**为什么两者不能是同一个 Element 类？** 反正 `build(context)` 的签名完全一样，Element 只要负责"调 build、把结果接到孩子上"就行了。

答案是：**两者的 Element 在"什么时候需要 rebuild"上完全不同**。

- `StatelessElement` 只在 `update` 被调用时 rebuild——因为对它来说，唯一能让输出变化的就是"配置换了"。
- `StatefulElement` 除了 `update`，还要在 `didChangeDependencies`（来自 `InheritedWidget`）、`activate`（`GlobalKey` 搬运回来）、`setState`（`markNeedsBuild`）这三条路径上处理**额外的生命周期钩子**，而且它**持有一个 `State` 对象**。

常见错误直觉是"`StatefulWidget` 比 `StatelessWidget` 多一个 `State` 字段而已"。实际上两者的 Element 差在**四个重写方法**上：`_firstBuild`、`performRebuild`、`update`、`unmount`（还有 `activate` / `deactivate`）。这一篇把这四个重写点逐一对齐。

## 二、最小 Demo

一个"同一条调用链，两种不同钩子顺序"的对照：

```dart
import 'package:flutter/widgets.dart';

class Trace extends StatelessWidget {
  const Trace({super.key});

  @override
  Widget build(BuildContext context) {
    debugPrint('Stateless.build     ← 只有 build，没有钩子');
    return const SizedBox.shrink();
  }
}

class TraceStateful extends StatefulWidget {
  const TraceStateful({super.key});
  @override
  State<TraceStateful> createState() => _TraceStatefulState();
}

class _TraceStatefulState extends State<TraceStateful> {
  @override
  void initState() {
    debugPrint('initState            ← _firstBuild 里，build 之前');
    super.initState();
  }

  @override
  void didChangeDependencies() {
    debugPrint('didChangeDependencies ← _firstBuild 里，initState 之后；之后每次都跟着 build');
    super.didChangeDependencies();
  }

  @override
  void didUpdateWidget(TraceStateful oldWidget) {
    debugPrint('didUpdateWidget      ← update 里，build 之前');
    super.didUpdateWidget(oldWidget);
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('Stateful.build       ← 上面三个钩子之后');
    return const SizedBox.shrink();
  }
}

/// 父组件：切换子组件类型 + 换配置，两种操作分别触发不同路径。
class TraceLab extends StatefulWidget {
  const TraceLab({super.key});
  @override
  State<TraceLab> createState() => _TraceLabState();
}

class _TraceLabState extends State<TraceLab> {
  int _n = 0;

  @override
  Widget build(BuildContext context) {
    debugPrint('--- 第 $_n 帧 ---');
    return GestureDetector(
      // 1. setState 让父重建，子组件收到新配置
      onTap: () => setState(() => _n++),
      // 2. const 子组件：父重建时它的实例不变
      child: const Column(
        children: <Widget>[
          Trace(),
          TraceStateful(),
        ],
      ),
    );
  }
}
```

第一次挂载会看到 `initState` → `didChangeDependencies` → `build`。点一下 `setState`，会看到**什么都没打印**——因为两个子组件都是 `const`，第三十八篇实验 1 的"出口 2"（`child.widget == newWidget`）直接短路，连 `build` 都不调。

去掉 `const` 之后再点，`Trace` 打一行 `build`，`TraceStateful` 打两行：`didUpdateWidget` → `build`。**这就是分野的最小可见形式。**

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:5775` | `abstract class ComponentElement extends Element` |
| `framework.dart:5789` | `ComponentElement.mount`，唯一调用 `_firstBuild` 的地方（`@override` 在 `:5788`） |
| `framework.dart:5797` | `ComponentElement._firstBuild`，只做一件事：`rebuild()` |
| `framework.dart:5810` | `ComponentElement.performRebuild`，`build()` + `updateChild` 的所在 |
| `framework.dart:5866` | `Widget build();`，抽象方法，两个子类的分岔口 |
| `framework.dart:5884` | `class StatelessElement extends ComponentElement` |
| `framework.dart:5889` | `StatelessElement.build` → `(widget as StatelessWidget).build(this)` |
| `framework.dart:5892` | `StatelessElement.update`，**唯一的重写** |
| `framework.dart:5900` | `class StatefulElement extends ComponentElement` |
| `framework.dart:5902` | `StatefulElement` 的构造函数，`_state = widget.createState()` |
| `framework.dart:5938` | `StatefulElement.build` → `state.build(this)` |
| `framework.dart:5948` | `StatefulElement._firstBuild`，补 `initState` / `didChangeDependencies` |
| `framework.dart:5977` | `StatefulElement.performRebuild`，补延迟的 `didChangeDependencies` |
| `framework.dart:5986` | `StatefulElement.update`，补 `didUpdateWidget` |
| `framework.dart:6028` | `StatefulElement.unmount`，补 `dispose`（第四十一篇展开） |

## 四、调用链

### 4.1 基类先划好框：`rebuild` 与 `performRebuild` 的分工

`ComponentElement` 和它的子类都不重写 `rebuild`。这一个方法是框架自己的（`:5503`），它管**条件**：

```dart
// framework.dart:5503-5506
void rebuild({bool force = false}) {
  assert(_lifecycleState != _ElementLifecycle.initial);
  if (_lifecycleState != _ElementLifecycle.active || (!_dirty && !force)) {
    return;                          // 不活跃、或既没脏也不强制 → 什么都不做
  }
  ...
  performRebuild();                  // 条件满足才交给子类
}
```

**关键认知**：`force` 这个参数是为 `update` 准备的。`update` 的调用时机是"父组件重建时"，此时这个 Element 自己**不一定脏**——它的 Widget 换了，但它没被 `markNeedsBuild`。所以要 `rebuild(force: true)` 明确要求重建。反过来，`setState` 走的是 `markNeedsBuild` → `scheduleBuildFor` → 帧末 `rebuild()`（不带 force），靠 `_dirty` 通过检查。**两条路径最终落在同一个 `performRebuild`。**

### 4.2 `_firstBuild`：唯一的重写机会

`mount` 只做一件事，就是把控制权交给 `_firstBuild`：

```dart
// framework.dart:5788-5795
@override
void mount(Element? parent, Object? newSlot) {
  super.mount(parent, newSlot);
  assert(_child == null);
  assert(_lifecycleState == _ElementLifecycle.active);
  _firstBuild();                    // 只有这里会调它
  assert(_child != null);           // 挂完之后必须已经有孩子
}
```

基类的 `_firstBuild` 只有一行：

```dart
// framework.dart:5797-5800
void _firstBuild() {
  // StatefulElement overrides this to also call state.didChangeDependencies.
  rebuild(); // This eventually calls performRebuild.
}
```

注释直接点明了它的用途：**它就是一个给 `StatefulElement` 留的钩子**。`StatelessElement` 不重写，`StatefulElement` 重写：

```dart
// framework.dart:5947-5975（节选）
@override
void _firstBuild() {
  assert(state._debugLifecycleState == _StateLifecycle.created);
  final Object? debugCheckForReturnedFuture = state.initState() as dynamic;   // 1. initState
  assert(() { /* initState 返回 Future 就抛错 */ }());
  assert(() {
    state._debugLifecycleState = _StateLifecycle.initialized;                // 2. 状态机推进
    return true;
  }());
  state.didChangeDependencies();                                             // 3. 首次依赖回调
  assert(() {
    state._debugLifecycleState = _StateLifecycle.ready;                       // 4. 进入 ready
    return true;
  }());
  super._firstBuild();                                                       // 5. 才轮到 rebuild
}
```

**顺序是有讲究的**：`initState` 在最前（此时 `context` 已可用但依赖还没注册——这正是 `initState` 里不能调 `dependOnInheritedWidgetOfExactType` 的原因），`didChangeDependencies` 紧随其后（此时可以注册依赖了），最后才 `build`。

`_debugLifecycleState` 在 `initState` 前后被推进两次（`initialized` → `ready`），这是 `State.setState` 里那条 `_debugLifecycleState == created && !mounted` 检查的依据。

### 4.3 `performRebuild`：`build` 的落地

`ComponentElement.performRebuild` 是整层的"心脏"。它比想象中长，因为要处理 `build` 抛异常：

```dart
// framework.dart:5810 起（节选）
void performRebuild() {
  Widget built;
  try {
    assert(() { _debugDoingBuild = true; return true; }());   // 1. 打开"正在 build"标记
    built = build();                                          // 2. 调用户代码
    assert(() { _debugDoingBuild = false; return true; }());
    debugWidgetBuilderValue(widget, built);
  } catch (e, stack) {
    _debugDoingBuild = false;
    built = ErrorWidget.builder(                                // 3. 抛异常就换成红色错误块
      _reportException(ErrorDescription('building $this'), e, stack, ...),
    );
  } finally {
    // We delay marking the element as clean until after calling build() so
    // that attempts to markNeedsBuild() during build() will be ignored.
    super.performRebuild();                                     // 4. 清 dirty 标记
  }
  try {
    _child = updateChild(_child, built, slot);                  // 5. 接上新孩子（第三十八篇）
    assert(_child != null);
  } catch (e, stack) {
    built = ErrorWidget.builder(_reportException(...));
    try { _child?.deactivate(); } catch (_) {}
    _child = updateChild(null, built, slot);                     // 6. 兜底：换孩子失败也降级到 ErrorWidget
  }
}
```

`_debugDoingBuild` 是 `BuildContext.debugDoingBuild`（`:2340`）的实现（`ComponentElement` 侧在 `:5783`）。它存在的意义是把 `dependOnInheritedElement` 限定在 `build` 期间（第四十三篇会用到这条）。

**关键认知**：第 4 步"清 dirty 放在 finally 里，且注释说明是**故意延后**到 `build()` 之后"——因为在 `build()` 里调 `setState` 时，`markNeedsBuild` 会因为 `dirty` 已经是 `true` 而直接返回（`:5386` 的 `if (dirty) { return; }`）。如果提前清零，`build` 里的 `setState` 就会在同一个元素上重复入队。这个"延后清零"是"`build` 里 setState 会被静默忽略而不是报错"的真正原因。

**`StatefulElement` 只在 `build` 之前插一段**：

```dart
// framework.dart:5976-5984
@override
void performRebuild() {
  if (_didChangeDependencies) {
    state.didChangeDependencies();      // 补一次被延迟的 didChangeDependencies
    _didChangeDependencies = false;
  }
  super.performRebuild();
}
```

`_didChangeDependencies` 这个布尔量（`:6114`）是"`didChangeDependencies` 请求了，但当前不打算 build"时留下的欠账：

```dart
// framework.dart:6116-6120
@override
void didChangeDependencies() {
  super.didChangeDependencies();     // → markNeedsBuild()
  _didChangeDependencies = true;     // 记账：真正 build 时要补调 State 的钩子
}
```

**关键认知**：`Element.didChangeDependencies`（`:5190`）只做 `markNeedsBuild()`，**不调 `State.didChangeDependencies`**。State 侧的钩子是靠这个布尔量**延迟到 `performRebuild` 开头**才被调用的。这个延迟设计解决了一个顺序问题：`didChangeDependencies` 可能在 Element 已经不活跃、或本帧不会被 build 的时候被触发，那就没必要惊动 State。第四十一篇的调用点对照表会用到这个事实。

### 4.4 `update`：两个子类的差异

```dart
// framework.dart:5891-5897
@override
void update(StatelessWidget newWidget) {
  super.update(newWidget);
  assert(widget == newWidget);
  rebuild(force: true);                    // 只做这一件事
}
```

```dart
// framework.dart:5985-6010（节选）
@override
void update(StatefulWidget newWidget) {
  super.update(newWidget);
  assert(widget == newWidget);
  final StatefulWidget oldWidget = state._widget!;      // 1. 先存下旧 Widget
  state._widget = widget as StatefulWidget;              // 2. 换 State 侧的配置镜像
  final Object? debugCheckForReturnedFuture = state.didUpdateWidget(oldWidget) as dynamic;  // 3. 钩子
  assert(() { /* 返回 Future 就抛错 */ }());
  rebuild(force: true);                                  // 4. 再 rebuild
}
```

三处差异：

| | `StatelessElement.update` | `StatefulElement.update` |
|---|---|---|
| 调用行数 | 3 行 | 15 行（含断言） |
| 有没有钩子 | 无 | `didUpdateWidget(oldWidget)` |
| 钩子拿到的参数 | — | **旧 Widget**（`oldWidget`） |
| `state._widget` 的更新时机 | — | 在钩子**之前**（所以 `didUpdateWidget` 里读 `widget` 已经是新的） |
| 是否 `rebuild(force: true)` | 是 | 是 |

**关键认知**：`didUpdateWidget` 的参数是**旧** Widget，但方法体里 `widget` 已经是**新**的。这是框架刻意给出的对比窗口——你能同时看到前后两个配置。这也是为什么 `didUpdateWidget` 的签名是 `didUpdateWidget(covariant T oldWidget)`。

### 4.5 全链对照

把四条入口（首次挂载 / 配置更新 / 依赖变化 / 状态变化）在两个子类身上的钩子序列并排：

| 入口 | `StatelessElement` | `StatefulElement` |
|---|---|---|
| 首次挂载（`mount` → `_firstBuild`） | `build` | `initState` → `didChangeDependencies` → `build` |
| 配置更新（`update`） | `build` | `didUpdateWidget` → `build`（如果 `_didChangeDependencies` 为真，`build` 前再补一次 `didChangeDependencies`） |
| 依赖变化（`didChangeDependencies`） | 无 State 侧钩子 | `_didChangeDependencies = true`，下次 `performRebuild` 前补调 `didChangeDependencies` |
| 状态变化（`setState`） | 不适用 | `markNeedsBuild` → 帧末 `rebuild()` → `build` |
| 被 `GlobalKey` 搬回（`activate`） | 无额外动作 | `activate` → `markNeedsBuild`（`:6011`） |
| 卸载（`unmount`） | 无额外动作 | `dispose`（`:6028`） |

`StatelessElement` 那一列有 5 个空格——这就是"多一个 State 字段"的真实体量。

## 五、核心对象：`StatelessElement` vs `StatefulElement`

| | `StatelessElement` | `StatefulElement` |
|---|---|---|
| 声明位置 | `framework.dart:5884` | `framework.dart:5900` |
| 持有物 | 无额外字段 | `State<StatefulWidget>? _state`（`:5939`）、`bool _didChangeDependencies`（`:6114`） |
| `State` 何时创建 | — | **构造函数里**（`:5902` 的初始化列表，不是 `mount`） |
| `build()` 实现 | `(widget as StatelessWidget).build(this)`（`:5889`） | `state.build(this)`（`:5938`） |
| 重写 `_firstBuild` | 否 | 是（`:5948`） |
| 重写 `performRebuild` | 否 | 是（`:5977`） |
| 重写 `update` | 是（`:5892`） | 是（`:5986`） |
| 重写 `activate` / `deactivate` / `unmount` | 否 | 全重写（`:6011` / `:6022` / `:6028`） |
| 重写 `reassemble`（热重载） | 否 | 是（`:5941`） |
| 额外的 debug 断言 | 无 | `state._debugLifecycleState` 的状态机（`created` → `initialized` → `ready` → `defunct`） |
| 能拿到 `State` 吗 | 不能 | `element.state`（getter 在 `:5938`） |

**一句话区分**：`StatelessElement` 是 `ComponentElement` 的**零重写版**（只补了 `build` 和 `update`）；`StatefulElement` 在**每一个生命周期转折点**上都要多插一段代码。

## 六、源码实验

### 实验 1：确认 `_firstBuild` 只有两个实现

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
grep -rn "_firstBuild" framework.dart
```

**预测**：既然它是给 `StatefulElement` 留的钩子，实现数应该很少。

**实际**（实测，共 4 处）：

```text
5797:  void _firstBuild() {                              ← ComponentElement 的定义
5800:    rebuild(); // This eventually calls performRebuild.
5930:    // StatefulElement overrides this to also call state.didChangeDependencies.  ← 文档注释引用
5948:  void _firstBuild() {                              ← StatefulElement 的重写
```

调用点只有一处：`5789` 那个 `mount` 方法体里的 `_firstBuild()`。

**说明**：`grep` 命中 4 行但只有 2 个定义 + 1 个调用 + 1 个注释。**整个框架里只有 `mount` 会调 `_firstBuild`**，也就是说"首次构建"这件事在 3.44.8 里只有一个入口。`ComponentElement.performRebuild` 会被 `rebuild()` 反复调用，而 `_firstBuild` 一生只调一次。

### 实验 2：验证 `build` 抛异常时的降级

把 `TraceLab` 里换成 `_Boom()`，它的 `build` 直接 `throw StateError('boom')`：

```dart
class Boom extends StatelessWidget {
  const Boom({super.key});
  @override
  Widget build(BuildContext context) => throw StateError('boom');
}
```

**预测**：异常会向上冒泡，整个 app 崩掉。

**实际**：屏幕上出现红色错误块，控制台打印完整的 `FlutterErrorDetails`（含 `building Boom` 的描述），**app 继续运行**。

**说明**：这是 `performRebuild` 里 `try/catch` + `ErrorWidget.builder` 的效果：第一段 `try` 在 `:5812`，`catch` 在 `:5824`，`ErrorWidget.builder` 在 `:5826`。注意它捕获的范围只包住 `build()`，**不包住 `updateChild`**——后者有自己的一段 `try`（`:5840`）/ `catch`（`:5843`），因为"孩子挂不上去"和"build 抛异常"是两类不同的故障。

### 实验 3：`_didChangeDependencies` 的延迟

在 Demo 的 `TraceStateful` 外面套一个 `InheritedWidget`，然后只在祖先侧 `setState`：

```dart
// 祖先每帧换一个 data 值
class Ancestor extends InheritedWidget {
  const Ancestor({super.key, required this.data, required super.child});
  final int data;

  // 每次 data 变都通知依赖者
  @override
  bool updateShouldNotify(Ancestor oldWidget) => data != oldWidget.data;
}
```

在 `_TraceStatefulState.build` 里加一行 `context.dependOnInheritedWidgetOfExactType<Ancestor>();`（注册依赖）。

**预测**：祖先的 `data` 变了，`didChangeDependencies` 会立即在祖先重建的过程中被调。

**实际**：`Element.didChangeDependencies`（`:5190`）在祖先重建时被调用，但它只 `markNeedsBuild()` 并置 `_didChangeDependencies = true`；`State.didChangeDependencies` 的日志出现在**本帧晚些时候**，由 `StatefulElement.performRebuild`（`:5977`）补调，紧接着才是 `build`。

**说明**：这个"请求"与"兑现"分离的设计，让 `didChangeDependencies` 可以安全地在一个 Element 处于不活跃状态时被触发（那时它不会 build，也就不会惊动 `State`）。日志上的表现是 `didChangeDependencies` 和 `build` **永远成对相邻**，中间不会插入别的东西。

### 实验 4：`StatelessElement` 其实**没有** `performRebuild`

```bash
awk '/^class StatelessElement/,/^}/' packages/flutter/lib/src/widgets/framework.dart | grep -n "performRebuild\|_firstBuild"
```

**预测**：既然 `StatelessElement` 也要 build，它应该有 `performRebuild`。

**实际**（实测）：无输出。`StatelessElement` 类体里**既没有 `performRebuild` 也没有 `_firstBuild`**，只有 `build` 和 `update` 两个成员（外加构造函数）。

**说明**：这是本篇最省事的结论——**读 `StatelessElement` 只需要读 4 行有效代码**。它的全部内容就是"`build` 转发给 widget""`update` 强制 rebuild"。所有真正的工作都在 `ComponentElement` 里。

## 七、结论

1. `ComponentElement` 把"构建"拆成了两半：`rebuild`（管条件：活跃 + 脏/强制）和 `performRebuild`（管动作：`build()` + `updateChild`）。`_firstBuild` 是 `mount` 到 `rebuild` 之间唯一留给子类插手的钩子，全框架只有 `mount` 会调它。
2. `StatelessElement` 是 `ComponentElement` 的**零重写版**，只补了 `build` 和 `update`（4 行有效代码）。`StatefulElement` 在**六个**生命周期转折点上重写：`_firstBuild`（插 `initState` / `didChangeDependencies`）、`performRebuild`（补延迟的 `didChangeDependencies`）、`update`（插 `didUpdateWidget`）、`activate` / `deactivate` / `unmount`。
3. `State.didChangeDependencies` **不是**在 `Element.didChangeDependencies` 里被调的。后者只 `markNeedsBuild()` 并置 `_didChangeDependencies = true`，真正的调用被延迟到 `StatefulElement.performRebuild` 开头。所以日志上 `didChangeDependencies` 与 `build` 永远成对相邻。

一句话总结：**`StatelessElement` 只回答"配置变了就重画"，`StatefulElement` 在每一个生命周期转折点上都要多插一段——这多插的六个点就是它存在的全部理由。**

## 八、边界声明

- 本篇只讲 Element 侧的分工，不逐条讲 `State` 的钩子语义与调用点对照表，那是**第四十一篇**的内容。
- `updateChild` / `inflateWidget` 的复用判定见**第三十八篇**；`canUpdate` 与 `GlobalKey` 见**第三十九篇**。
- `markNeedsBuild` / 脏列表 / `rebuild` 的调度时机见**第四十二篇**。
- `dependOnInheritedElement` 的注册与 `notifyClients` 的触发见**第四十三篇**。
- 与本节无关但同家族的 `ProxyElement`（`:6135`）在第四十三篇里作为 `InheritedElement` 的父类出现；`RenderObjectElement`（`:6611`）是第四十四篇。
- **本地源码与常见说法不一致**：`StatefulElement` 的文档注释（`framework.dart:5941-5942`）写"The `State` objects are created by `StatefulElement` in `mount`"，但代码里 `_state` 是在**构造函数**（`:5902`）里通过 `widget.createState()` 创建的。构造函数在 `inflateWidget` 调 `createElement` 时就执行了，早于 `mount`。这篇注释是过时的。
- 本篇给出**`ComponentElement` 里两个子类的重写点清单**，以及 `_didChangeDependencies` 这个延迟标志的存在。
