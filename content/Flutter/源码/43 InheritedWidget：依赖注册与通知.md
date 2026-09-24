# 43 InheritedWidget：依赖注册与通知

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`

## 一、问题

`InheritedWidget` 的常见介绍是"祖先放数据，后代用 `dependOnInheritedWidgetOfExactType<T>()` 取"。

这句话解释不了两件事：

1. **为什么"取"这个动作会建立依赖？** 一个 getter 读一下就注册进来了——这在一般的观察者模式里很少见。如果我只想读一次、不想被通知呢？
2. **数据变了之后，是"立刻重建后代"还是"标脏等下一帧"？** 如果是后者，那它和 `setState` 走的是不是同一条路？

还有第三个更少被问、但源码里很显眼的问题：**依赖是存在哪里的？** 是"父存一份孩子名单"，还是"孩子存一份父名单"，还是都有？

答案是**都有，而且两张表的用途完全不同**：

- **父侧** `InheritedElement._dependents`（`:6256`）是一张 `Map<Element, Object?>`，用于**遍历通知**；
- **子侧** `Element._dependencies`（`:5043`）是一个 `Set<InheritedElement>`，用于**退订**。

少任何一张表，机制都不完整。这一篇把这两张表怎么同步讲清。

## 二、最小 Demo

一个能观察"注册"和"通知"两侧动作的最小例子：

```dart
import 'package:flutter/widgets.dart';

/// 1. 祖先放数据。updateShouldNotify 决定"这次变化要不要通知"。
class Tick extends InheritedWidget {
  const Tick({super.key, required this.count, required super.child});

  final int count;

  @override
  bool updateShouldNotify(Tick oldWidget) {
    debugPrint('updateShouldNotify: ${oldWidget.count} → $count');
    return count != oldWidget.count;    // 2. 只有真变了才通知
  }
}

/// 3. 后代读数据。这一读就注册了依赖。
class Reader extends StatelessWidget {
  const Reader({super.key});

  @override
  Widget build(BuildContext context) {
    final Tick? tick = context.dependOnInheritedWidgetOfExactType<Tick>();
    debugPrint('Reader.build tick=${tick?.count}');
    return Text('${tick?.count}', textDirection: TextDirection.ltr);
  }
}

/// 4. 不想被通知的后代：用 getInheritedWidgetOfExactType，只读不注册。
class SilentReader extends StatelessWidget {
  const SilentReader({super.key});

  @override
  Widget build(BuildContext context) {
    // 这个方法不建立依赖，所以 Tick 变了它不会 rebuild
    final Tick? tick = context.getInheritedWidgetOfExactType<Tick>();
    debugPrint('SilentReader.build tick=${tick?.count}');
    return Text('${tick?.count}', textDirection: TextDirection.ltr);
  }
}

class Host extends StatefulWidget {
  const Host({super.key});
  @override
  State<Host> createState() => _HostState();
}

class _HostState extends State<Host> {
  int _n = 0;

  @override
  Widget build(BuildContext context) {
    return Tick(
      count: _n,
      child: GestureDetector(
        onTap: () => setState(() => _n++),
        child: Column(
          // 注意这里不能写 const Column(...)：const 子树每次 build 是同一个实例，
          // updateChild 会走"新旧 Widget 是同一实例"的快速路径，
          // SilentReader 就不会被父链带下来重建，Demo 现象与下文描述对不上
          children: <Widget>[Reader(), SilentReader()],
        ),
      ),
    );
  }
}
```

点一下的输出：

```text
updateShouldNotify: 0 → 1          ← 祖先的 update 里被调
Reader.build tick=1                ← 依赖者被标脏后重建
SilentReader.build tick=1          ← 注意：它没有依赖，是被 Column 的父链强制重建带下来的（见第六节实验 2）
```

**关键认知**：`Reader` 和 `SilentReader` 的差别不在"能不能读到数据"（两者都读到了），而在**读完之后有没有被登记进依赖表**。这就是"读一次"和"订阅"的分界。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:1853` | `abstract class InheritedWidget extends ProxyWidget` |
| `framework.dart:1859` | `InheritedElement createElement() => InheritedElement(this);` |
| `framework.dart:1874` | `bool updateShouldNotify(covariant InheritedWidget oldWidget);` |
| `framework.dart:6252` | `class InheritedElement extends ProxyElement` |
| `framework.dart:6256` | `final Map<Element, Object?> _dependents = HashMap<Element, Object?>();`，父侧表 |
| `framework.dart:6259` | `InheritedElement._updateInheritance`，把 `this` 写进继承链表 |
| `framework.dart:5042` | `Element._inheritedElements`，子侧的祖先查找表（第六篇） |
| `framework.dart:5043` | `Element._dependencies`，子侧的退订表 |
| `framework.dart:5074` | `Element.dependOnInheritedElement`，注册动作的实现 |
| `framework.dart:5081` | `Element.dependOnInheritedWidgetOfExactType`，注册动作的入口 |
| `framework.dart:6351` | `InheritedElement.updateDependencies`，注册的父侧半程（`@protected` 在 `:6350`） |
| `framework.dart:6372` | `InheritedElement.notifyDependent`，通知的落地动作 |
| `framework.dart:6396` | `InheritedElement.updated`，`updateShouldNotify` 的调用点 |
| `framework.dart:6414` | `InheritedElement.notifyClients`，遍历 `_dependents` |
| `framework.dart:6143` | `ProxyElement.update`，`updated` 的调用者 |
| `framework.dart:6385` | `InheritedElement.removeDependent`，退订 |
| `framework.dart:4808` | `Element._ensureDeactivated`，退订的触发点 |

## 四、调用链

### 4.1 注册：两次写表，一次返回

```dart
// framework.dart:5081-5089（节选）
T? dependOnInheritedWidgetOfExactType<T extends InheritedWidget>({Object? aspect}) {
  assert(_debugCheckStateIsActiveForAncestorLookup());
  final InheritedElement? ancestor = _inheritedElements?[T];   // 1. 查自己的祖先表
  if (ancestor != null) {
    return dependOnInheritedElement(ancestor, aspect: aspect) as T;   // 2. 命中就注册
  }
  _hadUnsatisfiedDependencies = true;                          // 3. 没找到：记账
  return null;
}
```

```dart
// framework.dart:5074-5078
InheritedWidget dependOnInheritedElement(InheritedElement ancestor, {Object? aspect}) {
  (_dependencies ??= HashSet<InheritedElement>()).add(ancestor);   // 写子侧表
  ancestor.updateDependencies(this, aspect);                       // 写父侧表
  return ancestor.widget as InheritedWidget;                       // 返回 widget 本体
}
```

`dependOnInheritedElement` 只有三行，但把整套机制的骨架都摆出来了：

| 行 | 动作 | 写的是哪张表 |
|---|---|---|
| 1 | `_dependencies.add(ancestor)` | **子侧**：一个 `Set<InheritedElement>`，只记"我依赖了谁"，不记值 |
| 2 | `ancestor.updateDependencies(this, aspect)` | **父侧**：`_dependents[this] = null`（默认实现） |
| 3 | `return ancestor.widget as InheritedWidget` | 不写表，返回数据 |

**关键认知**：第 1 步是"我依赖谁"，第 2 步是"谁依赖我"。**两张表的方向相反，缺一不可**：通知时从父往子走（需要父侧表），撤销依赖时从子往父走（需要子侧表）。这就是为什么 `dependOnInheritedElement` 必须写两次表。

第 3 步也值得注意：返回值是 **`ancestor.widget`**，即当前那一帧的 Widget 实例。所以 `dependOnInheritedWidgetOfExactType<T>()` 返回的 `T` 不是 Element，而是 Widget——数据字段在 Widget 上（`@immutable`），不在 Element 上。

### 4.2 查找靠的是一张预建的哈希表，不是父链爬行

第 1 步的 `_inheritedElements?[T]` 看起来像一次普通的 Map 查找。它的建立方式在 `InheritedElement._updateInheritance` 里：

```dart
// framework.dart:6258-6264
@override
void _updateInheritance() {
  assert(_lifecycleState == _ElementLifecycle.active);
  final PersistentHashMap<Type, InheritedElement> incomingWidgets =
      _parent?._inheritedElements ?? const PersistentHashMap<Type, InheritedElement>.empty();
  _inheritedElements = incomingWidgets.put(widget.runtimeType, this);
}
```

而 `Element._updateInheritance` 只是一行"继承父节点的表"：

```dart
// framework.dart:5116-5119
void _updateInheritance() {
  assert(_lifecycleState == _ElementLifecycle.active);
  _inheritedElements = _parent?._inheritedElements;
}
```

**为什么普通 Element 只是复制引用，而 `InheritedElement` 要 `put` 一次？** 因为普通 Element 不需要在表里留下自己，只有 `InheritedElement` 才是"可被依赖的对象"。所以每个 `InheritedElement` 都会把自己插入表里，key 是 `widget.runtimeType`，value 是 `this`。

**底层结构见第六篇**——那里讲了为什么用 `PersistentHashMap` 而不是普通 `Map`（"每个 Element 持有一份完整祖先表"这件事靠路径复制才便宜）。本篇不重复。

**关键认知**：`_inheritedElements` 的 key 是 `Type`，也就是 `widget.runtimeType`。所以 `dependOnInheritedWidgetOfExactType<Tick>()` 里的 `T` **必须精确匹配祖先的 `runtimeType`**。写 `dependOnInheritedWidgetOfExactType<InheritedWidget>()` 是查不到的——这也解释了方法名里 "ExactType" 的含义。

### 4.3 通知：父的 `update` 里走出来的一整条链

数据变化不是通过 `setState` 传播的，而是**祖先自己 rebuild 时**顺手通知：

```dart
// framework.dart:6142-6152（节选）
@override
void update(ProxyWidget newWidget) {
  final oldWidget = widget as ProxyWidget;   // 1. 先存旧 Widget
  assert(widget != newWidget);
  super.update(newWidget);                   // 2. Element._widget 换成新的
  assert(widget == newWidget);
  updated(oldWidget);                        // 3. 交给子类（关键分岔）
  rebuild(force: true);                      // 4. 自己 rebuild
}
```

`InheritedElement` 重写 `updated`，在这里插入 `updateShouldNotify`：

```dart
// framework.dart:6395-6399
@override
void updated(InheritedWidget oldWidget) {
  if ((widget as InheritedWidget).updateShouldNotify(oldWidget)) {
    super.updated(oldWidget);                // → ProxyElement.updated → notifyClients
  }
}
```

```dart
// framework.dart:6157-6160
@protected
void updated(covariant ProxyWidget oldWidget) {
  notifyClients(oldWidget);                  // ProxyElement 的默认实现，只做转发
}
```

```dart
// framework.dart:6413-6436（节选）
@override
void notifyClients(InheritedWidget oldWidget) {
  assert(_debugCheckOwnerBuildTargetExists('notifyClients'));
  for (final Element dependent in _dependents.keys) {      // 遍历父侧表
    assert(() {
      // check that it really is our descendant
      Element? ancestor = dependent._parent;
      while (ancestor != this && ancestor != null) {
        ancestor = ancestor._parent;
      }
      return ancestor == this;
    }());
    // check that it really depends on us
    assert(dependent._dependencies!.contains(this));
    notifyDependent(oldWidget, dependent);                 // 逐个通知
  }
}
```

```dart
// framework.dart:6371-6374
@protected
void notifyDependent(covariant InheritedWidget oldWidget, Element dependent) {
  dependent.didChangeDependencies();                       // 默认：无差别通知
}
```

**关键认知**：`notifyDependent` 的最后落点是 `dependent.didChangeDependencies()`，而 `Element.didChangeDependencies`（`:5190`）只做 `markNeedsBuild()`（第四十、四十一篇已确认）。所以**"通知"的全部效果就是"把依赖者标脏"**——不是立刻重建，也不是同步调用后代的 `build`。它和 `setState` 走的是**同一条脏列表链路**（第四十二篇）。

这解释了一个常见疑问："为什么改了 `InheritedWidget` 里的数据，后代的 `build` 不会立刻执行？"因为通知只到 `markNeedsBuild` 为止，`build` 要等下一帧 `buildScope` 的冲刷。

**`_dependents.keys` 的遍历顺序是 `HashMap` 的顺序**，不稳定。所以 `notifyClients` 不保证按树序通知——不过这不重要，因为最终都只是标脏，真正的 build 顺序由 `Element._sort`（`:3616`）按 `depth` 决定（第四十二篇）。

### 4.4 通知只能被"覆盖"，不能被"追加"

`updateShouldNotify` 的默认实现不存在——它是抽象方法：

```dart
// framework.dart:1873-1874
@protected
bool updateShouldNotify(covariant InheritedWidget oldWidget);
```

`InheritedElement.updated` 里的调用形式是 `if (updateShouldNotify(oldWidget)) super.updated(...)`，也就是**要么通知全部依赖者，要么一个都不通知**。

想做"只通知一部分"（比如按 aspect 过滤），需要重写 `updateDependencies` / `notifyDependent`：

```dart
// framework.dart:6350-6353（默认实现）
@protected
void updateDependencies(Element dependent, Object? aspect) {
  setDependencies(dependent, null);       // 默认就是把值记成 null
}
```

```dart
// framework.dart:6323-6326
@protected
void setDependencies(Element dependent, Object? value) {
  _dependents[dependent] = value;         // 写父侧表的值
}
```

所以 `_dependents` 的 value 类型是 `Object?`——默认全是 `null`，子类可以用它存"这个依赖者关心的 aspect"。`InheritedModel` 就是这么做的（`inherited_model.dart:224` 的 `updateDependencies`、`:239` 的 `notifyDependent`）。

**关键认知**：这就是 `aspect` 参数的用途。`dependOnInheritedWidgetOfExactType<T>({Object? aspect})` 里的 `aspect` 不会进入子侧的 `_dependencies`（那只是个 `Set`），它被 `updateDependencies` 交给父侧存起来，供 `notifyDependent` 决定要不要通知。**默认实现把它丢掉了**（存 `null`），所以 `aspect` 只对重写过这两个方法的子类有意义。

### 4.5 退订：两张表都要清

```dart
// framework.dart:4808-4823（节选）
void _ensureDeactivated() {
  if (_dependencies case final Set<InheritedElement> dependencies? when dependencies.isNotEmpty) {
    for (final dependency in dependencies) {
      dependency.removeDependent(this);      // 4811 通知每个父：把我删掉
    }
    // For expediency, we don't actually clear the list here, even though it's
    // no longer representative of what we are registered with. If we never
    // get re-used, it doesn't matter. If we do, then we'll clear the list in
    // activate(). The benefit of this is that it allows Element's activate()
    // implementation to decide whether to rebuild based on whether we had
    // dependencies here.
  }
  _inheritedElements = null;                 // 清掉自己的祖先表
  _lifecycleState = _ElementLifecycle.inactive;
}
```

```dart
// framework.dart:6382-6387
@protected
@mustCallSuper
void removeDependent(Element dependent) {
  _dependents.remove(dependent);             // 清父侧表
}
```

三件事值得看：

1. **退订发生在 `_ensureDeactivated` 而不是 `deactivate`**。因为 `deactivate` 可能抛异常（`_ensureDeactivated` 在 `finally` 语义下被调），而"清依赖"必须尽力完成。
2. **`_dependencies` 故意不清**。注释写明了原因：`activate()` 会用它判断"原本有没有依赖"，从而决定要不要补调 `didChangeDependencies`（第四十一篇 4.3）。真正的清空在 `Element.activate:4762`（`_dependencies?.clear()`）。
3. **`_inheritedElements = null` 立刻清掉**。因为祖先表反映的是"当前祖先链"，一旦离树就作废——不能留到 `activate` 再用（搬运后祖先链可能完全不同，`activate` 里会重新 `_updateInheritance()`）。

这是一个典型的"**两张表清理时机不同**"的设计：

| 表 | 清理时机 | 为什么 |
|---|---|---|
| `Element._dependencies`（子侧） | `deactivate` 时**不清**，`activate` 时清 | `activate` 要用它判断 `hadDependencies` |
| `Element._inheritedElements`（子侧查找表） | `deactivate` 时立刻清 | 离树后祖先链作废 |
| `InheritedElement._dependents`（父侧） | `deactivate` 时立刻清（逐个 `removeDependent`） | 父必须立刻停止给离树的孩子发通知 |

### 4.6 `didChangeDependencies` 之后发生了什么

第四节 4.3 已经确认：`notifyDependent` → `didChangeDependencies` → `markNeedsBuild`。对 `StatefulElement` 还多一步（第四十一篇）：

```text
InheritedElement.notifyClients                     :6414
  └─ notifyDependent                               :6372
       └─ dependent.didChangeDependencies()        :5190
            ├─ markNeedsBuild()                    :5193   ← Stateful 和 Stateless 都有
            └─ [StatefulElement 重写] :6117
                 └─ _didChangeDependencies = true  :6119
                      ↓ 下一帧 performRebuild
                      └─ state.didChangeDependencies()    :5979
                           └─ [用户代码] → super → markNeedsBuild
```

**关键认知**：对 `StatelessElement` 来说，`didChangeDependencies` 就是 `markNeedsBuild`，仅此而已。对 `StatefulElement` 它还会点亮 `_didChangeDependencies`，从而在 `performRebuild` 开头多调一次 `State.didChangeDependencies`。**所以"依赖变化"对两种 Element 的可见效果不同：Stateless 只是重 build，Stateful 还会多收到一个回调。**

## 五、核心对象：两张依赖表

| | `Element._dependencies`（子侧） | `InheritedElement._dependents`（父侧） |
|---|---|---|
| 声明位置 | `framework.dart:5043` | `framework.dart:6256` |
| 类型 | `Set<InheritedElement>?` | `Map<Element, Object?>` |
| 初值 | `null`（**懒初始化**，第一次注册才建 Set） | `HashMap()` （立即建，空表） |
| key 是什么 | — | 依赖它的 Element |
| value 是什么 | — | `aspect` 的值，默认 `null` |
| 方向 | 子 → 父 | 父 → 子 |
| 谁写 | `dependOnInheritedElement:5076` | `updateDependencies` → `setDependencies:6325` |
| 谁读 | `_ensureDeactivated:4811`（退订）、`activate:4757`（判断 `hadDependencies`） | `notifyClients:6416`（遍历通知） |
| 谁删 | `activate:4762` 整体 clear | `removeDependent:6386` |
| 清空时机 | 离树时**不清**，回树时清 | 离树时立刻清 |
| 缺了它会怎样 | 无法退订，父的通知表会留着死 Element | 无法通知，依赖形同虚设 |

**一句话区分**：**子侧表用于退订，父侧表用于通知。**`dependOnInheritedElement` 那三行里有两行就是在同时维护这两张表。

## 六、源码实验

### 实验 1：确认 `_inheritedElements` 的 key 是 `runtimeType`

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
grep -n "_inheritedElements = \|_inheritedElements?\[" framework.dart
```

**实际**（实测）：

```text
5042:  PersistentHashMap<Type, InheritedElement>? _inheritedElements;
5083:    final InheritedElement? ancestor = _inheritedElements?[T];      ← 用 T（泛型 Type）查
5118:    _inheritedElements = _parent?._inheritedElements;               ← 普通 Element 只继承
6263:    _inheritedElements = incomingWidgets.put(widget.runtimeType, this);  ← InheritedElement 插入自己
```

**说明**：`5083` 的 `T` 是调用方传的泛型实参，`6263` 的 key 是 `widget.runtimeType`。两者必须精确相等。所以给 `InheritedWidget` 加一层子类（`class MyTick extends Tick`）会让 `dependOnInheritedWidgetOfExactType<Tick>()` **查不到**——表里的 key 是 `MyTick`。这是 `InheritedWidget` 最常见的踩坑点之一，而且**没有回退到父类的逻辑**。

### 实验 2：区分"自己依赖"和"被父带下来"

在第二节 Demo 里给 `SilentReader` 外面包一层 `Builder`，并把 `Column` 的 `const` 去掉：

```dart
child: Column(
  children: <Widget>[
    const Reader(),                      // 有依赖
    Builder(builder: (BuildContext c) => const SilentReader()),  // 无依赖
  ],
),
```

**预测**：`SilentReader` 没有依赖，`Tick` 变化时它的 `build` 不该再执行。

**实际**：`SilentReader.build` **仍然执行了**。

**说明**：因为 `Column` 的父链（`Tick` → `GestureDetector` → `Column`）里，`Tick` 的 `rebuild(force: true)` 会让 `ProxyElement.build` 返回 `widget.child`——也就是那个 `Column`。于是 `updateChild` 发现 `Column` 的 runtimeType/key 都没变，走"复用 + `update`"，`Column` 又 `rebuild(force: true)`，把新的 `Builder` 传下去……**整条链都被 `force: true` 强制重建了**（第四十篇 4.1 的 `rebuild` 条件里 `force` 会绕过 `_dirty`）。

所以 `SilentReader` 重建的原因是"祖先强制重建"，不是"依赖通知"。**`getInheritedWidgetOfExactType` 省掉的只是"多一次 `markNeedsBuild`"，不是"跳过重建"。** 想让一个子树真正不重建，得用 `const`（Widget 实例不变，让 `updateChild` 走实例相同的快速路径）、拆分 Widget 缩小重建范围、或精确 `setState` 这类手段——**`RepaintBoundary` 不在此列：它隔离的是重绘（paint），不隔离 rebuild**。这也是 `dependOnInheritedWidgetOfExactType` 真正省下来的东西：**祖先 rebuild 时，只有依赖者会被"额外"标脏一次（于是它的 `depth` 排序位置更靠前、更早被 build）；而真正省掉重建的机制是 `const`。** 实测这条结论时，"去掉 `Column` 的 const" 是关键——如果保留 `const Column`，第三十八篇出口 2 的实例相同快速路径会让整棵子树全部跳过。

### 实验 3：`updateShouldNotify` 返回 `false` 时什么都不发生

把 Demo 里的 `updateShouldNotify` 改成恒返回 `false`：

```dart
@override
bool updateShouldNotify(Tick oldWidget) => false;
```

**预测**：`Reader` 不重建，但 `_dependents` 表应该也出问题了。

**实际**：`Reader` 不再因为依赖而重建（但仍会被祖先的 `force: true` 带下来重建，见实验 2）。`_dependents` 表**完好无损**——依赖关系还在。

**说明**：`updateShouldNotify` 只影响 `notifyClients` 要不要执行（`:6397` 那个 `if`），**不影响注册**。依赖表是持久的，一次注册终身有效（直到 `deactivate`）。所以"`updateShouldNotify` 返回 `false`"= "这次数据变化不通知"，而不是"取消依赖"。

### 实验 4：`deactivate` 之后通知表里还有它吗

给 `InheritedElement` 打日志不方便（它是框架类），改用间接观察：让 `Reader` 只在某些帧挂上（用一个 `if` 切换），对比 `Tick.count` 变化时它是否收到通知。

**预测**：不挂着的 `Reader` 应该已经退订了。

**实际**：它确实不再收到通知——`Element._ensureDeactivated`（`:4808`）在它离树时遍历 `_dependencies`，逐个调 `removeDependent`（`:6386`）把父侧表清掉。

**说明**：这验证了两张表的**同步性**：子侧表虽然"故意不清"（`:4812-4820` 的注释），但父侧表已经被精确清空了。所以 `activate` 里 `_dependencies?.clear()` 清的是**一份已经过期的本地记录**，不会造成父侧残留。

## 七、结论

1. **依赖注册要写两张方向相反的表**：子侧 `_dependencies`（`Set<InheritedElement>`，`:5043`，用于退订）和父侧 `_dependents`（`Map<Element, Object?>`，`:6256`，用于通知）。`dependOnInheritedElement`（`:5074`）的三行里前两行就是在写这两张表。
2. **通知的终点是 `markNeedsBuild`，不是 `build`**。链路是 `ProxyElement.update:6143` → `updated:6396` → `updateShouldNotify:1874` → `notifyClients:6414` → `notifyDependent:6372` → `dependent.didChangeDependencies():5190` → `markNeedsBuild()`。所以"改数据"和 `setState` 最终走同一条脏列表链路，都要等下一帧。
3. **两张查找表的清理时机不同**：父侧 `_dependents` 在 `deactivate` 时立刻精确清空（`removeDependent:6386`）；子侧 `_dependencies` 故意留到 `activate`（`:4762`）才清，因为 `activate` 要用它判断 `hadDependencies`，从而决定是否补调 `didChangeDependencies`。子侧的 `_inheritedElements` 则在 `deactivate` 时立刻置 `null`（祖先链作废）。

一句话总结：**`dependOnInheritedWidgetOfExactType` 一次调用做三件事——查祖先表、往子侧表加一项、往父侧表加一项；所谓的"通知"只是沿父侧表把每个依赖者 `markNeedsBuild` 一遍。**

## 八、边界声明

- `PersistentHashMap` 为什么被用在 `_inheritedElements` 上（路径复制、`put` 未变时返回 `this`）见本地系列**第六篇**，本篇只引用结论不重复。
- `Element.activate` 里 `hadDependencies` 与补调 `didChangeDependencies` 的细节见**第四十一篇 4.3**。
- `markNeedsBuild` / 脏列表 / `buildScope` 的完整链路见**第四十二篇**。
- `InheritedModel` 如何用 `updateDependencies` / `notifyDependent` 实现 aspect 过滤（`inherited_model.dart:121` 是类、`:219` 是它的 Element、`:224` / `:239` 是两个重写点）本篇只在 4.4 提一句，不展开。
- `InheritedNotifier`、`InheritedTheme` 这些子类（`inherited_notifier.dart:135`、`inherited_theme.dart:158`）不展开。
- `debugDoingBuild` 对 `dependOnInheritedElement` 的调用时机限制（`StatefulElement.dependOnInheritedElement:6050` 的断言）见**第四十一篇 4.6** 与**第四十篇 4.3**。
- 本篇补充**调度点行号对照**（哪个方法在哪一行被谁调）、**`notifyClients` 的遍历前提断言**、以及**两张表清理时机不同**这三个源码层事实。
