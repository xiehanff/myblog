# Flutter State 与 Element 关系详解

## 1. 核心结论

在 Flutter 中，`StatefulElement` 和 `State` 之间确实存在一种近似“相互引用”的绑定关系。

更准确地说：

```text
StatefulElement 持有 State
State 通过 _element 持有对应 Element 引用
State 通过 _widget 持有当前 Widget 配置引用
```

运行时关系大致是：

```text
StatefulElement
  ├── _state  ───────────────→ State
  └── widget  ───────────────→ 当前 StatefulWidget 配置

State
  ├── _element ──────────────→ StatefulElement
  └── _widget  ──────────────→ 当前 StatefulWidget 配置
```

所以结论是：

> `StatefulElement` 和 `State` 本质上是一种双向绑定关系。  
> 但 Flutter 对外隐藏了很多内部字段，开发者通常只能通过 `widget`、`context`、`mounted` 等受控 API 间接访问。

这一关系可以在官方文档中交叉验证：

- [StatefulElement 类文档](https://api.flutter.dev/flutter/widgets/StatefulElement-class.html)：Element 与 State 一一对应，Element 持有 State。
- [State 类文档](https://api.flutter.dev/flutter/widgets/State-class.html)：State 通过 `context` 关联到所在的 Element。
- [Flutter 架构总览](https://docs.flutter.dev/resources/architectural-overview)：Widget / Element / RenderObject 三棵树的整体关系。

下文引用的源码均出自 `packages/flutter/lib/src/widgets/framework.dart`。

---

## 2. StatefulElement 和 State 是否相互引用？

答案是：**是的，可以认为它们存在相互引用。**

以一个简单组件为例：

```dart
class MyPage extends StatefulWidget {
  final int id;

  const MyPage({
    super.key,
    required this.id,
  });

  @override
  State<MyPage> createState() => _MyPageState();
}

class _MyPageState extends State<MyPage> {
  @override
  Widget build(BuildContext context) {
    return Text('id = ${widget.id}');
  }
}
```

第一次进入树时，大致发生：

```text
1. 创建 MyPage Widget
2. MyPage.createElement()
3. 创建 StatefulElement
4. StatefulElement 调用 MyPage.createState()
5. 创建 _MyPageState
6. StatefulElement._state = _MyPageState
7. _MyPageState._element = StatefulElement
8. _MyPageState._widget = MyPage
9. 调用 initState
10. 调用 didChangeDependencies
11. 调用 build
```

也就是说：

```text
StatefulElement 持有 State
State 持有 StatefulElement
```

这是一种非常紧密的运行时绑定关系，并不松散。

可以理解为：

```text
StatefulElement 是运行时节点
State 是这个节点上的可变状态对象
```

---

## 3. State 持有的 context 到底是什么？

在 `State` 中可以访问：

```dart
context
```

这里的 `context` 实际上就是 `State` 内部的 `_element`。

这不是概念上的类比，`State.context` 在 framework.dart 中的真实实现就是返回 `_element`：

```dart
BuildContext get context {
  assert(() {
    if (_element == null) {
      throw FlutterError(
        'This widget has been unmounted, so the State no longer has a context '
        '(and should be considered defunct). ...',
      );
    }
    return true;
  }());
  return _element!;
}
```

也就是说：

```text
State.context == 当前 State 绑定的 StatefulElement
```

所以：

```text
State 持有 context 引用
```

本质上就是：

```text
State 持有 Element 引用
```

只不过 Flutter 对外暴露的是 `BuildContext` 类型，而不是 `Element` 类型。这是为了限制开发者直接操作 Element 的内部生命周期。

---

## 4. State 持有的 widget 到底是什么？

在 `State` 中经常写：

```dart
widget.id
```

这个 `widget` 不是创建 State 时的那个旧 Widget 永远不变。

它表示：

> 当前 State 绑定的 Element 正在使用的最新 Widget 配置。

第一次初始化时：

```text
State._widget = MyPage(id: 1)
```

父组件 rebuild 后，如果新旧 Widget 可以复用同一个 Element：

```dart
MyPage(id: 1)
```

变成：

```dart
MyPage(id: 2)
```

Flutter 复用已有的 State，接着：

```text
1. StatefulElement.update(newWidget)
2. oldWidget = State._widget
3. State._widget = newWidget
4. State.didUpdateWidget(oldWidget)
5. State.build()
```

所以在 `didUpdateWidget` 中：

```dart
@override
void didUpdateWidget(covariant MyPage oldWidget) {
  super.didUpdateWidget(oldWidget);

  print(oldWidget.id); // 旧值
  print(widget.id);    // 新值
}
```

此时：

```text
oldWidget.id == 1
widget.id == 2
```

关键点：

```text
State 对象没变
Element 对象没变
State._widget 引用变了
Element.widget 引用也变了
```

---

## 5. State 和 Element 的绑定关系是否会变化？

正常生命周期内，`State` 和 `Element` 的绑定关系基本不变。

更严谨地说：

> 一个 `State` 对象一旦被创建并挂到树上，它的 `context`，也就是对应的 `Element`，绑定关系在整个生命周期内不会改变。

也就是说：

```text
State A 绑定 Element A
```

之后不会变成：

```text
State A 绑定 Element B
```

这个关系是稳定的。

官方 [State.context 文档](https://api.flutter.dev/flutter/widgets/State/context.html)的原话正是这个意思：

> The association is permanent: the State object will never change its BuildContext. However, the BuildContext itself can be moved around the tree.

但是要注意区分：

```text
State 绑定的 Element 不变
但 Element 在树中的位置可能变化
```

典型场景是 `GlobalKey` 移动子树。

所以可以这样理解：

```text
State 与 Element 对象的绑定关系是稳定的；
但这个 Element 可以因为 GlobalKey 被移动到树中的其他位置。
```

---

## 6. Element 的生命周期和 State 是否一致？

对于 `StatefulElement` 和它持有的 `State` 来说：

> 生命周期高度一致，但不是概念上完全同一个东西。

在普通场景下，它们是一对一同生共死的关系：

```text
StatefulElement 创建
↓
State 创建
↓
StatefulElement mount
↓
State initState
↓
State build
↓
StatefulElement update / rebuild 多次
↓
State didUpdateWidget / build 多次
↓
StatefulElement deactivate
↓
State deactivate
↓
StatefulElement unmount
↓
State dispose
```

工程上可以记成：

```text
一个 StatefulElement 对应一个 State
这个 State 生命周期基本跟这个 StatefulElement 绑定
```

但两者职责不同：

```text
Element 管树的位置、更新、复用、dirty 标记、父子关系
State 管业务状态、Controller、订阅、资源释放
```

---

## 7. 生命周期对应关系

| 阶段 | Element | State |
|---|---|---|
| 创建 Widget | 还没有 Element | 还没有 State |
| inflate Widget | 创建 `StatefulElement` | 调用 `createState` 创建 State |
| 绑定 | Element 持有 State | State 持有 Element / Widget |
| mount | Element 插入树 | State 进入 mounted 状态 |
| 初始化 | Element 执行首次 build 流程 | `initState`、`didChangeDependencies` |
| rebuild | Element 被标记 dirty 并 rebuild | `build` 被调用 |
| 父组件配置更新 | `Element.update(newWidget)` | `didUpdateWidget(oldWidget)` |
| 临时移除 | `Element.deactivate` | `State.deactivate` |
| 重新插入 | `Element.activate` | `State.activate()`；若之前有 InheritedWidget 依赖，`didChangeDependencies` 会再次触发，随后 `build` |
| 最终移除 | `Element.unmount` | `State.dispose` |
| 销毁后 | Element defunct | State unmounted |

---

## 8. StatefulElement 和 State 是一对一吗？

绝大多数情况下，是一对一。

```text
StatefulElement 1 ─── State 1
StatefulElement 2 ─── State 2
StatefulElement 3 ─── State 3
```

但一个 `StatefulWidget` 实例不一定只对应一个 State，因为 Widget 是配置对象。

例如：

```dart
final child = MyCounter();

Column(
  children: [
    child,
    child,
  ],
)
```

这不是推荐写法，但从概念上说，同一个 Widget 配置对象被使用在两个位置。

运行时会产生：

```text
同一个 MyCounter Widget 实例
        │
        ├── StatefulElement A ─── State A
        │
        └── StatefulElement B ─── State B
```

所以要区分：

```text
Widget 和 State：不是一对一
Element 和 State：对 StatefulElement 来说基本是一对一
```

---

## 9. 为什么相互引用不会导致内存泄漏？

`Element → State`、`State → Element` 是循环引用，但在 Dart 这类现代 GC 语言里：

> 循环引用本身不会导致内存泄漏。

垃圾回收判断的核心在于：

> 从 GC Roots 出发，这些对象是否仍然可达。

如果一个页面被移除后：

```text
根对象
  无法再访问到 Element
  无法再访问到 State
```

即使它们互相引用：

```text
Element ↔ State
```

也会被 GC 回收。

真正会导致泄漏的是外部长生命周期对象持有 State。

例如：

```dart
timer = Timer.periodic(..., (_) {
  setState(() {});
});
```

如果 `dispose` 里没有：

```dart
timer.cancel();
```

可能形成：

```text
全局 Timer 系统
   ↓
Timer callback
   ↓
State
   ↓
Element
```

这时 State 仍然可达，就无法回收。

再比如：

```dart
someNotifier.addListener(_onChanged);
```

如果不 remove：

```dart
someNotifier.removeListener(_onChanged);
```

也可能导致：

```text
全局 / 上层 Notifier
   ↓
listener closure
   ↓
State
```

所以真正要注意的是：

```text
Element 和 State 互相引用不是问题
外部长生命周期对象持有 State 才是问题
```

---

## 10. State.widget 会变，但 State.context 不变

这是最关键的区别。

### 10.1 widget 会变

父组件从：

```dart
UserPanel(userId: 1)
```

更新成：

```dart
UserPanel(userId: 2)
```

如果 Element / State 被复用：

```text
State.widget 从 UserPanel(userId: 1)
变成 UserPanel(userId: 2)
```

所以：

```dart
widget.userId
```

会变。

### 10.2 context 不变

但是：

```dart
context
```

也就是：

```text
State._element
```

不变。

因为当前 State 仍然绑定原来的 Element。

所以可以记成：

```text
State 的 widget 引用会随着父组件更新而改变
State 的 context / element 绑定关系在生命周期内不变
```

---

## 11. Element 位置会不会变？

会，但需要非常准确地理解：

```text
State 绑定的 Element 对象不变
但这个 Element 在树中的位置可能变化
```

典型场景：`GlobalKey`。

```dart
final globalKey = GlobalKey();

Column(
  children: [
    if (onTop) MyPanel(key: globalKey),
    const Spacer(),
    if (!onTop) MyPanel(key: globalKey),
  ],
)
```

当 `onTop` 变化时，Flutter 可能把同一个 Element 从一个位置移动到另一个位置。

此时：

```text
State 对象不变
Element 对象不变
State.context 仍然是那个 Element
Element.parent / slot 可能变化
```

---

## 12. deactivate 为什么不等于 dispose？

因为 Element / State 可能只是暂时离开树。

流程：

```text
Element 从 active 树移除
↓
Element.deactivate
↓
State.deactivate
↓
进入 inactive 状态
↓
如果同一帧内被重新插入
    Element.activate
    State 继续使用
否则
    Element.unmount
    State.dispose
```

重新插入这一步展开看，`StatefulElement.activate()` 依次做三件事（对应源码顺序）：

```text
Element.activate()
↓
State.activate()     // State 的回调（框架早期版本就已存在，并非新 API）
↓
markNeedsBuild()     // 强制 rebuild，让 State 按新位置重新 build
```

另外，`Element.activate()` 内部会检查这个 Element 之前是否注册过 InheritedWidget 依赖，如果有，会触发一次 `didChangeDependencies`，让 State 有机会感知新位置上的环境变化（比如新位置的 `Theme` 不同）。

所以：

```dart
@override
void deactivate() {
  super.deactivate();
}
```

不应该用来释放最终资源。

最终资源释放应该放在：

```dart
@override
void dispose() {
  controller.dispose();
  subscription.cancel();
  timer.cancel();
  super.dispose();
}
```

原因是：

```text
deactivate 后 State 可能还会回来
dispose 后 State 永远不会回来
```

---

## 13. mounted 到底表示什么？

在 `State` 中：

```dart
mounted
```

表示：

```text
当前 State 是否仍然绑定着一个 Element
```

framework.dart 中的实现一字不差：

```dart
bool get mounted => _element != null;
```

生命周期中：

```text
createState 后，Element 绑定 State
↓
mounted = true
↓
initState
↓
build 多次
↓
dispose
↓
State 解绑 Element
↓
mounted = false
```

所以异步中经常写：

```dart
Future<void> loadData() async {
  final result = await api.fetch();

  if (!mounted) return;

  setState(() {
    data = result;
  });
}
```

意思是：

```text
异步回来时，如果 State 已经 dispose，就不要再 setState。
```

如果不检查，`setState` 内部的 debug 断言会抛出
`setState() called after dispose(): ...`（`State.setState` 源码）。dispose 是终态，官方文档明确说明 State 一旦 dispose 就无法重新挂载（there is no way to remount a State object that has been disposed）。

---

## 14. 父组件更新时，Element / State / Widget 到底谁变？

假设原来是：

```dart
UserPanel(userId: 1)
```

后来父组件 rebuild 返回：

```dart
UserPanel(userId: 2)
```

且 key 没变。

运行时变化：

```text
Widget：变了，新的 UserPanel 对象替换旧配置
Element：没变，复用原 StatefulElement
State：没变，复用原 _UserPanelState
State.widget：变了，指向新的 UserPanel
State.context：没变，仍然指向原 StatefulElement
```

可以总结为：

```text
变的是 Widget 配置
不变的是 Element 节点和 State 状态
```

所以 `didUpdateWidget` 存在的意义就是：

```text
State 没变
但 State 关联的 widget 配置变了
所以给 State 一个机会比较 oldWidget 和 widget
```

---

## 15. key 改变时，Element / State / Widget 谁变？

原来：

```dart
UserPanel(
  key: ValueKey(1),
  userId: 1,
)
```

后来：

```dart
UserPanel(
  key: ValueKey(2),
  userId: 2,
)
```

因为 key 变了，不能复用。

运行时变化：

```text
旧 Widget：被替换
旧 Element：deactivate → unmount
旧 State：deactivate → dispose

新 Widget：创建
新 Element：createElement → mount
新 State：createState → initState
```

总结：

```text
Widget 变
Element 变
State 也变
```

因此不会调用旧 State 的：

```dart
didUpdateWidget
```

新 State 则会走：

```text
createState → initState → didChangeDependencies → build
```

---

## 16. 为什么 didUpdateWidget 后一定会 build？

因为父组件已经返回了新的 Widget 配置。

旧 State 的 `widget` 引用已经换成了新的 Widget。

所以 Flutter 必须让这个 State 根据新配置重新生成子树。

流程：

```text
StatefulElement.update(newWidget)
↓
oldWidget = state.widget
↓
state._widget = newWidget
↓
state.didUpdateWidget(oldWidget)
↓
rebuild
↓
state.build(context)
```

因此在 `didUpdateWidget` 里通常不需要：

```dart
setState(() {});
```

因为 build 本来就会发生。

---

## 17. 更贴近源码的关系模型

可以用伪代码理解 `StatefulElement`：

```dart
class StatefulElement extends ComponentElement {
  State<StatefulWidget> _state;

  StatefulElement(StatefulWidget widget)
      : _state = widget.createState(),
        super(widget) {
    _state._element = this;
    _state._widget = widget;
  }

  @override
  void update(StatefulWidget newWidget) {
    final oldWidget = _state._widget;

    super.update(newWidget);

    _state._widget = newWidget;
    _state.didUpdateWidget(oldWidget);

    rebuild(force: true);
  }

  @override
  void unmount() {
    super.unmount();
    _state.dispose();
    _state._element = null;
  }
}
```

注意：这只是帮助理解的伪代码，不是完整源码。真实 `unmount` 的执行顺序正是 `super.unmount()` → `state.dispose()` → `state._element = null`，最后还会把 `_state` 置 null 以便尽早释放引用。

从这个模型看：

```text
StatefulElement._state → State
State._element → StatefulElement
State._widget → 当前 Widget
```

确实是强绑定关系。

---

## 18. 用日志验证 State 和 Element 是否稳定

可以写一个示例观察 `State` 对象是否变化。

```dart
class IdentityDemo extends StatefulWidget {
  final int id;

  const IdentityDemo({
    super.key,
    required this.id,
  });

  @override
  State<IdentityDemo> createState() => _IdentityDemoState();
}

class _IdentityDemoState extends State<IdentityDemo> {
  late final int stateHash = identityHashCode(this);

  @override
  void initState() {
    super.initState();
    debugPrint(
      'initState: stateHash=$stateHash, '
      'contextHash=${identityHashCode(context)}, '
      'widget.id=${widget.id}',
    );
  }

  @override
  void didUpdateWidget(covariant IdentityDemo oldWidget) {
    super.didUpdateWidget(oldWidget);

    debugPrint(
      'didUpdateWidget: stateHash=$stateHash, '
      'contextHash=${identityHashCode(context)}, '
      'old=${oldWidget.id}, new=${widget.id}',
    );
  }

  @override
  void dispose() {
    debugPrint(
      'dispose: stateHash=$stateHash, '
      'contextHash=${identityHashCode(context)}, '
      'widget.id=${widget.id}',
    );

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    debugPrint(
      'build: stateHash=$stateHash, '
      'contextHash=${identityHashCode(context)}, '
      'widget.id=${widget.id}',
    );

    return Text('id = ${widget.id}');
  }
}
```

父组件使用稳定 key：

```dart
IdentityDemo(
  key: const ValueKey('stable'),
  id: id,
)
```

当 `id` 改变，会看到：

```text
stateHash 不变
contextHash 不变
widget.id 变化
didUpdateWidget 被调用
```

如果改成：

```dart
IdentityDemo(
  key: ValueKey(id),
  id: id,
)
```

当 `id` 改变，会看到：

```text
旧 state dispose
新 state initState
stateHash 变化
contextHash 变化
```

这能直观看到：

```text
稳定 key：Element / State 复用
变化 key：Element / State 重建
```

---

## 19. 最终结论

### 19.1 “这难道不是相互引用？”

是的。

更准确说：

```text
StatefulElement 持有 State
State 持有 StatefulElement 的引用，也就是 context
State 还持有当前 Widget 配置引用
```

所以它们之间存在运行时双向绑定。

但这不是问题，因为 Dart GC 可以处理循环引用。

真正要警惕的是：

```text
Timer / Stream / ChangeNotifier / 全局单例 / Controller
这些更长生命周期对象持有 State 回调，导致 State 无法释放。
```

---

### 19.2 “State 和 Element 绑定关系是否不变？”

基本不变。

一个 `State` 创建后，会永久绑定到一个 `BuildContext`，也就是一个 `Element`。

```text
State._element 在生命周期内不换成另一个 Element
```

但是：

```text
这个 Element 在树中的位置可能因为 GlobalKey 发生移动
```

所以更准确地说：

```text
State 与 Element 对象的绑定不变
Element 在树中的 parent / slot 可能变化
```

---

### 19.3 “Element 的生命周期和 State 是否一致？”

对于 `StatefulElement` 和它持有的 `State`：

```text
生命周期高度一致
基本是一对一同生共死
```

但不是同一个概念：

```text
Element 管树结构、更新、dirty、复用、挂载卸载
State 管业务状态、资源、订阅、Controller
```

普通场景下：

```text
StatefulElement mount
↓
State initState
↓
State build 多次
↓
StatefulElement update 多次
↓
State didUpdateWidget 多次
↓
StatefulElement deactivate
↓
State deactivate
↓
StatefulElement unmount
↓
State dispose
```

所以可以实用地记成：

> 一个 `StatefulElement` 拥有一个 `State`；这个 `State` 的 `context` 就是这个 `StatefulElement`；它们在整个生命周期中绑定稳定，直到最终 `unmount / dispose`。

再补一句最关键的：

```text
Widget 会频繁换
Element 通常尽量复用
State 跟着 Element 存活
```

这就是 Flutter 生命周期和状态保留机制的核心。
