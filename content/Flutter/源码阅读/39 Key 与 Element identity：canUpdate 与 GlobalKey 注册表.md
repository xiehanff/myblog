# 39 Key 与 Element identity：canUpdate 与 GlobalKey 注册表

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`

## 一、问题

第三十八篇说复用判定是 `runtimeType + key`。`runtimeType` 很好理解，`key` 呢？

`Key` 本身在第二篇已经讲透了（`foundation/key.dart` 只有 117 行，相等契约、`ValueKey` / `ObjectKey` / `UniqueKey` 的分工）。**这一篇只回答一个 Key 在 `widgets` 层引出的问题**：

`Key` 分成两类，`LocalKey` 和 `GlobalKey`。这两类的差别不是"作用域大小"，而是**它们影响的东西根本不同**：

- `LocalKey` 只影响 `canUpdate` 的返回值——**它只在同一个父的兄弟之间比较**，作用范围就是"位置"。
- `GlobalKey` 除了影响 `canUpdate`，还会**被登记到一张全局注册表里**，从而能跨越父子关系把 Element 搬到别处去。

常见错误直觉是"`GlobalKey` 就是全局唯一版的 `ValueKey`"。差得远：`ValueKey` 只是一个 `==` 的实现，而 `GlobalKey` 让框架**改了树的形状**。

这一篇讲清两件事：`LocalKey` 的判定在哪些地方被调用（第三十八篇给过锚点，这里只补它的 Key 侧语义），以及 `GlobalKey` 那一张注册表在什么时候写、什么时候删、什么时候被用来"认领"一个已经离树的 Element。

## 二、最小 Demo

```dart
import 'package:flutter/widgets.dart';

/// GlobalKey 的"跨父搬运"演示：同一个 Element 在两棵子树之间换父。
class ReparentLab extends StatefulWidget {
  const ReparentLab({super.key});
  @override
  State<ReparentLab> createState() => _ReparentLabState();
}

class _ReparentLabState extends State<ReparentLab> {
  bool _left = true;
  // 1. GlobalKey 由 State 持有，绝不放在 build 里新建
  final GlobalKey _leafKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    // 2. 同一个 leaf 实例，放在两棵深度不同的子树里（但任何时刻只在一处）
    final Widget leaf = Leaf(key: _leafKey);
    return Column(
      children: <Widget>[
        _left
            ? Padding(padding: const EdgeInsets.all(4), child: leaf)
            : Padding(
                padding: const EdgeInsets.all(16),
                child: Padding(padding: const EdgeInsets.all(8), child: leaf),
              ),
        // 3. 点它换边：父链长度变了，GlobalKey 依然把同一个 Element 搬过去
        GestureDetector(
          onTap: () => setState(() => _left = !_left),
          child: const SizedBox(width: 20, height: 20),
        ),
      ],
    );
  }
}

class Leaf extends StatefulWidget {
  const Leaf({super.key});
  @override
  State<Leaf> createState() => _LeafState();
}

class _LeafState extends State<Leaf> {
  int _n = 0;

  @override
  void initState() {
    debugPrint('initState        ← 只在第一次挂上时发生');
    super.initState();
  }

  @override
  void activate() {
    debugPrint('activate         ← 被 GlobalKey 认领回来时会走这里');
    super.activate();
  }

  @override
  void deactivate() {
    debugPrint('deactivate       ← 从旧父搬走时会走这里（不是销毁）');
    super.deactivate();
  }

  @override
  void dispose() {
    debugPrint('dispose          ← 只有真的没人认领才走这里');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text('$_n', textDirection: TextDirection.ltr);
}
```

点上那个 20x20 的空方块来回切换，日志会给出：`deactivate` → `activate`，**没有 `initState`、也没有 `dispose`**，而且 `_n` 的值一直保留。这就是"`GlobalKey` 搬运"的完整表现。

**关键认知**：搬运**会**走 `deactivate` 和 `activate`（因为它们对应"离开旧父"和"进入新父"），但**不会**走 `dispose`（因为对象从头到尾没被销毁）。这三者的分工是全篇最实用的一条。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:382` | `Widget.canUpdate`，Key 参与身份判定的唯一入口 |
| `framework.dart:159` | `abstract class GlobalKey<T extends State<StatefulWidget>> extends Key` |
| `framework.dart:173` | `GlobalKey._currentElement`，查注册表的 getter |
| `framework.dart:179` / `185` / `192` | `currentContext` / `currentWidget` / `currentState` |
| `framework.dart:3148` | `final Map<GlobalKey, Element> _globalKeyRegistry = <GlobalKey, Element>{};` |
| `framework.dart:3169` | `int get globalKeyCount => _globalKeyRegistry.length;` |
| `framework.dart:3178` | `BuildOwner._registerGlobalKey` |
| `framework.dart:3190` | `BuildOwner._unregisterGlobalKey` |
| `framework.dart:4356` | `Element.mount` 里的登记点 |
| `framework.dart:4859` | `Element.unmount` 里的注销点 |
| `framework.dart:4481` | `_retakeInactiveElement`，认领流程 |
| `framework.dart:4717` | `_activateWithParent`，搬运的落地动作 |
| `foundation/key.dart:51` / `88` | `LocalKey` / `ValueKey` 在 foundation 侧的定义（第二篇）。**`GlobalKey` 不在 foundation 里**，它在 `widgets/framework.dart:159` |

## 四、调用链

### 4.1 先分清：`canUpdate` 里 key 是怎么被比的

```dart
// framework.dart:382-384
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

这一行里 `key == null == null` 是 `true`——所以**两个都没 key 的同类 Widget 也会被判为可复用**。这解释了第三十八篇 Demo 里 `Probe()` → `Probe()`（都不是 `const`、都没 key）会命中复用分支。

`LocalKey` 的作用就到这里为止：它只是让 `==` 在"两个兄弟"之间区分开。

**关键认知**：`LocalKey` 与 `GlobalKey` 都能让 `canUpdate` 返回 `false`，但只有 `GlobalKey` 会在 `canUpdate` 之外**额外触发注册表查询**。第三十八篇实验 1 已经确认：读 `GlobalKey` 的逻辑在 `inflateWidget`（`:4571`）和 `_retakeInactiveElement`（`:4492`）里，而 `updateChild` 只在 debug 断言里碰它。

### 4.2 注册表：谁在什么时候往里写

**注册表本身只有一行：**

```dart
// framework.dart:3148
final Map<GlobalKey, Element> _globalKeyRegistry = <GlobalKey, Element>{};
```

它是 `BuildOwner` 的字段。全 app 通常只有一个 `BuildOwner`（`WidgetsBinding.initInstances` 里建的，`binding.dart:476`），所以这张表是"全局"的——**这才是 `GlobalKey` 里 "Global" 的真实含义**。

**写第一处：`mount`**

```dart
// framework.dart:4354-4357
final Key? key = widget.key;
if (key is GlobalKey) {
  owner!._registerGlobalKey(key, this);
}
```

**写第二处：`_registerGlobalKey` 自身**

```dart
// framework.dart:3178 起（节选）
void _registerGlobalKey(GlobalKey key, Element element) {
  assert(() {
    if (_globalKeyRegistry.containsKey(key)) {
      final Element oldElement = _globalKeyRegistry[key]!;
      assert(element.widget.runtimeType != oldElement.widget.runtimeType);
      _debugIllFatedElements?.add(oldElement);   // 只记下来，稍后统一报错
    }
    return true;
  }());
  _globalKeyRegistry[key] = element;
}
```

**注意这一行的行为**：重复的 key **不会立刻抛异常**，而是把旧的 Element 记进 `_debugIllFatedElements`，然后**直接覆盖**。报错发生在帧末的 `BuildOwner.finalizeTree`（`:3339` → 内部遍历 `_debugIllFatedElements`，`:3290`）。

**关键认知**：为什么不当场抛？因为 `GlobalKey` 的搬运流程里，**在某一瞬间两个 Element 会同时"看起来"持有同一个 key**。`_retakeInactiveElement` 的注释把这件事说得很清楚（`:4482-4486`，从 `:4482` 的 "The \"inactivity\" of the element being retaken here may be forward-looking" 开始）：被认领的 Element 在旧父那里还没被真正移除（旧父要等到自己 `update` 时才 `forgetChild`）。如果当场抛，正常的搬运就会报错。所以框架用"先覆盖 + 帧末对账"的方式把真正的重复延后到搬运完成之后。

**删除点：`unmount`**

```dart
// framework.dart:4857-4860
final Key? key = _widget?.key;
if (key is GlobalKey) {
  owner!._unregisterGlobalKey(key, this);
}
```

`_unregisterGlobalKey`（`:3190`）里有一句很讲究的保护：

```dart
// framework.dart:3190 起（节选）
void _unregisterGlobalKey(GlobalKey key, Element element) {
  assert(() { ... }());
  if (_globalKeyRegistry[key] == element) {   // 只有"表里现在是我"才删
    _globalKeyRegistry.remove(key);
  }
}
```

如果表里的已经不是自己（说明期间被别的 Element 覆盖了），就不动它——避免把别人的登记误删。

**所以注册表里的条目数与 Element 生命周期是严格对应的**：`mount` 加一条，`unmount` 减一条，`deactivate` **不减**。这也解释了 `globalKeyCount`（`:3169`）为什么能当泄漏指标用。

### 4.3 读注册表：`GlobalKey.currentContext` 走的是哪条路

```dart
// framework.dart:173
Element? get _currentElement => WidgetsBinding.instance.buildOwner!._globalKeyRegistry[this];
```

一行里有三个信息：

1. **它每次都现查**，不缓存。所以 `GlobalKey.currentState` 在 Element 被 unmount 之后会变成 `null`，而不是旧值。
2. **它不走 `_currentElement` 以外任何路径**——`currentContext`（`:179`）、`currentWidget`（`:185`）、`currentState`（`:192`）全是它的包装。
3. **它依赖 `WidgetsBinding.instance`**，也就是必须已经有一个 binding。所以 `currentContext` 不能在 binding 初始化之前调（比如某些 `main()` 早期的代码）。

**关键认知**：`_currentElement` 不只是"给用户查状态用的"。第四十四篇会看到，`currentState` 这类 API 让 `GlobalKey` 成为"隔空操作另一个子树"的唯一合法通道：`globalKey.currentState!.someMethod()`。这条通道之所以安全，是因为注册表里的 Element 一定还活着。

### 4.4 认领流程：`_retakeInactiveElement`

这是 `GlobalKey` 真正的机制。第三十八篇已经给过 `inflateWidget` 的骨架，这里展开认领那一半：

```dart
// framework.dart:4481 起（节选）
Element? _retakeInactiveElement(GlobalKey key, Widget newWidget) {
  final Element? element = key._currentElement;      // 1. 从注册表拿到那个 Element
  if (element == null) return null;                  //    没有 → 认领失败
  if (!Widget.canUpdate(element.widget, newWidget)) {
    return null;                                     // 2. 资格不够 → 认领失败
  }
  final Element? parent = element._parent;
  if (parent != null) {
    assert(() { /* parent == this 就抛"GlobalKey 被用了两次" */ }());
    parent.forgetChild(element);                     // 3. 让旧父先忘掉这个孩子
    parent.deactivateChild(element);                 // 4. 旧父主动把它送进 _inactiveElements
  }
  assert(element._parent == null);
  owner!._inactiveElements.remove(element);          // 5. 立刻从暂存区取回来
  return element;
}
```

五个动作的顺序不能乱换：

| 步 | 动作 | 为什么必须在这一步 |
|---|---|---|
| 1 | `key._currentElement` | 认领的唯一线索来自注册表 |
| 2 | `canUpdate(element.widget, newWidget)` | 同一个 key 换了 `runtimeType` 也不许搬 |
| 3 | `parent.forgetChild(element)` | 先让旧父的 child 指针空出来（**这一步自身不改树**） |
| 4 | `parent.deactivateChild(element)` | 旧父主动走一遍"送进暂存区"的完整流程 |
| 5 | `_inactiveElements.remove(element)` | 把它拿回来——所以它不会活到帧末被 unmount |

第 3 步的 `forgetChild` 是 `@protected @mustCallSuper` 的空实现（`framework.dart:4702`），由各 Element 子类重写。它存在的唯一理由是：**新父不能去改旧父的私有 child 字段**（比如 `ComponentElement._child`），只能请旧父自己忘。

**关键认知**：第 4 步 `deactivateChild` 会调 `deactivate`，第 5 步之后 `inflateWidget` 会调 `_activateWithParent` → `activate`。所以**搬运一定会产生一次 `deactivate` + `activate` 配对**。这就是第二节 Demo 日志的来源，也是 `GlobalKey` 文档里那句"Reparenting ... is relatively expensive"的具体内容（`framework.dart:128`）。

### 4.5 落地：`_activateWithParent` 做了什么

```dart
// framework.dart:4717-4732（节选）
void _activateWithParent(Element parent, Object? newSlot) {
  assert(_lifecycleState == _ElementLifecycle.inactive);
  _parent = parent;
  _owner = parent.owner;
  _updateDepth(_parent!.depth);        // 1. 重算 depth，只增不减（见第三篇）
  _updateBuildScopeRecursively();      // 2. 如果落进了 LayoutBuilder 之类的私有 scope，要改归属
  _activateRecursively(this);          // 3. 整棵子树 activate
  attachRenderObject(newSlot);         // 4. RenderObject 重新挂进新父的渲染树
  assert(_lifecycleState == _ElementLifecycle.active);
}
```

四件事分别对应四条独立的"归属链"：

| 步 | 修的链 | 细节 |
|---|---|---|
| 1 | `depth`（排序令牌） | 只增不减，所以搬浅了 depth 不变（第三篇） |
| 2 | `buildScope`（脏列表归属） | 见第四十二篇 |
| 3 | 生命周期状态 | `_activateRecursively`（`:4734`）递归调 `Element.activate`（本体在 `:4754-4772`） |
| 4 | RenderObject 树 | 见第四十四篇 |

第 2 步 `_updateBuildScopeRecursively`（`:4437`）是 3.44 才有的东西——因为 `BuildScope` 是新增的类。它做的是：

```dart
// framework.dart:4437-4449（节选）
void _updateBuildScopeRecursively() {
  if (identical(buildScope, _parent?.buildScope)) {
    return;                              // 归属没变，整棵子树都不用动
  }
  _inDirtyList = false;                  // 让它可以被加进新 scope 的脏列表
  _parentBuildScope = _parent?.buildScope;
  visitChildren((Element child) {
    child._updateBuildScopeRecursively();
  });
}
```

**关键认知**：搬运一个 `GlobalKey` 子树，不只是"换个父"。它要同时修**四条链**：`depth`、`buildScope`、Element 生命周期、RenderObject 树。`_activateWithParent` 的四行代码就是这四条链的入口——这也是为什么 `GlobalKey` 搬运比 `LocalKey` 贵得多。

### 4.6 `Element.activate` 里还有两件容易忽略的事

```dart
// framework.dart:4754-4773（节选）
void activate() {
  final bool hadDependencies =
      (_dependencies?.isNotEmpty ?? false) || _hadUnsatisfiedDependencies;
  _lifecycleState = _ElementLifecycle.active;
  _dependencies?.clear();            // 1. 依赖列表清空，等下重新注册
  _hadUnsatisfiedDependencies = false;
  _updateInheritance();              // 2. 重建继承查找表（因为换了祖先）
  attachNotificationTree();
  if (_dirty) {
    owner!.scheduleBuildFor(this);   // 3. 如果本来就被标脏了，重新入队
  }
  if (hadDependencies) {
    didChangeDependencies();         // 4. 之前有依赖 → 补一次 didChangeDependencies
  }
}
```

第 4 步是搬运最容易被忽视的副作用：**一个原本依赖了某个 `InheritedWidget` 的子树，搬到新位置后会被强制 `didChangeDependencies`**。因为新位置的祖先链可能完全不同，旧 `InheritedWidget` 的数据不再适用（第三十九篇这里只给结论，机制见第四十三篇）。

## 五、核心对象：`LocalKey` vs `GlobalKey`

| | `LocalKey`（`ValueKey` / `ObjectKey` / `UniqueKey`） | `GlobalKey` |
|---|---|---|
| 声明位置 | `foundation/key.dart:25` | `framework.dart:159` |
| 参与 `canUpdate` 吗 | 参与（靠 `==`） | 参与（靠 `==`，`GlobalKey` 用默认身份相等） |
| 影响范围 | **同一个父的孩子列表内** | 整个 `BuildOwner` 覆盖的范围（全 app） |
| 有注册表吗 | 无 | 有：`BuildOwner._globalKeyRegistry`（`:3148`） |
| 能跨父搬运吗 | **不能** | 能 |
| 会触发 `deactivate` / `activate` 吗 | 不会 | **会** |
| 会触发 `didChangeDependencies` 吗 | 不会 | 可能会（`activate` 里 `hadDependencies`） |
| 有 `currentContext` / `currentState` 吗 | 无 | 有（`:179` / `:192`） |
| 允许重写 `==` 吗 | 允许（`ValueKey` 就重写了） | 不允许（继承 `Key` 的默认身份相等） |
| 存放位置建议 | 列表项里就地 `ValueKey(item.id)` | 由 `State` 持有，绝不在 `build` 里新建 |
| 谁在维护 | 无（纯值对象） | `Element.mount` 登记 / `Element.unmount` 注销 |

一句话区分：**`LocalKey` 是"在兄弟里挑一个"，`GlobalKey` 是"把那个 Element 搬过来"。**

## 六、源码实验

### 实验 1：确认注册表的写点只有两处

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
grep -n "_registerGlobalKey\|_unregisterGlobalKey" framework.dart
```

**预测**：既然是"全局唯一"，注册和注销的调用点应该很少。

**实际**（实测，共 4 处）：

```text
3178:  void _registerGlobalKey(GlobalKey key, Element element) {     ← 定义
3190:  void _unregisterGlobalKey(GlobalKey key, Element element) {   ← 定义
4356:      owner!._registerGlobalKey(key, this);                      ← mount 里唯一写点
4859:      owner!._unregisterGlobalKey(key, this);                    ← unmount 里唯一写点
```

**说明**：注册表的四条"写"路径加起来只有两个调用点。**`deactivate` 不在其中**——这直接证明了"暂存区里的 Element 仍然占着 `GlobalKey`"。如果不这样，搬运就没法通过注册表找到它。

### 实验 2：观察搬运时的钩子序列

用第二节的 Demo，在 `_toggle` 的 `onTap` 里加 `debugPrint('--- 切换 ---')`，然后来回点：

**预测**：既然 `dispose` 没被调用，`initState` 应该也不会——`State` 一直是同一个。

**实际**（日志顺序）：

```text
--- 切换 ---
deactivate       ← 旧父 deactivateChild
activate         ← 新父 _activateRecursively
--- 切换 ---
deactivate
activate
```

**说明**：`initState` 和 `dispose` 一次都没出现。**这是 `GlobalKey` 与"重建"最本质的区别**：重建会走 `initState` + `dispose`，搬运动会走 `deactivate` + `activate`。想在业务代码里区分这两种情况，看日志里是 `initState` 还是 `deactivate` 就够了。

### 实验 3：`_debugIllFatedElements` 的报错时机

把 Demo 里同一个 `_leafKey` 同时挂到两个位置：

```dart
@override
Widget build(BuildContext context) {
  return Column(
    children: <Widget>[
      Leaf(key: _leafKey),      // 同一个 key
      Leaf(key: _leafKey),      // 用了两次
    ],
  );
}
```

**预测**：第二处 `Leaf` 一构造就该抛"GlobalKey 被用了两次"。

**实际**：抛错发生在**帧末**，且报错文案来自 `_retakeInactiveElement` 里那个 `parent == this` 的断言（`:4505-4510`）——"A GlobalKey was used multiple times inside one widget's child list."。如果两个 key 分散在不同父下，则要走 `_debugIllFatedElements` 那条路，在 `finalizeTree` 里由 `_debugVerifyIllFatedPopulation`（`:3287`）报。

**说明**：两种重复的报错路径不同，因为**同一父下的重复是当场可以确定的，跨父的重复要等搬运完成才能确定**。这解释了为什么代码里要维护两套 debug 结构（`_debugGlobalKeyReservations` 和 `_debugIllFatedElements`），第三十六篇把这一层 debug 的 4.6k 行诊断体系列为"可整块跳过"，但这里的两三处断言值得看——它们精确描述了这套机制的前置条件。

### 实验 4：`globalKeyCount` 可以当泄漏指标

```bash
grep -n "globalKeyCount" packages/flutter/lib/src/widgets/framework.dart
```

**实际**（实测）：只有 `:3169` 一处定义，加上驱动它的 debug 服务扩展（在 `binding.dart` 的 service extension 里）。

**说明**：因为注册表条目与 Element 生命周期严格一一对应（实验 1 的结论），`globalKeyCount` 长时间单调上涨就意味着**有 Element 没被 unmount**。这是 DevTools 之外一个很轻的泄漏探针。

## 七、结论

1. `LocalKey` 和 `GlobalKey` 都通过 `Widget.canUpdate`（`:382`）参与身份判定，但**只有 `GlobalKey` 会额外走注册表**。`LocalKey` 的作用范围是"同一个父的孩子列表"，它不改变树的形状。
2. `GlobalKey` 的注册表是 `BuildOwner._globalKeyRegistry`（`:3148`），**只在两个地方被写**：`Element.mount:4356` 登记、`Element.unmount:4859` 注销。`deactivate` 不注销——这正是"暂存区里的 Element 还能被认领"的前提。重复 key 不当场抛，而是记进 `_debugIllFatedElements`，帧末在 `finalizeTree` 里统一报。
3. 搬运的完整代价是**修四条链**：`_activateWithParent`（`:4717`）依次调 `_updateDepth`（depth）、`_updateBuildScopeRecursively`（buildScope）、`_activateRecursively`（生命周期）、`attachRenderObject`（RenderObject 树）。它必定产生一次 `deactivate` + `activate` 配对，且如果原子树有 `InheritedWidget` 依赖，还会补一次 `didChangeDependencies`。

一句话总结：**`LocalKey` 只在兄弟间挑人，`GlobalKey` 有一张 `BuildOwner` 级的注册表，靠它把已经离树的 Element 连同 `State` 一起搬到新父下。**

## 八、边界声明

- `Key` 的相等契约（`ValueKey` / `ObjectKey` / `UniqueKey` 的 `==` 与 `hashCode`）见本地系列**第二篇**，本篇不重复。
- `_activateWithParent` 触发的 `_updateDepth` 只增不减语义见本地系列**第三篇**，本篇不重复。
- `_updateBuildScopeRecursively` 的 `BuildScope` 归属与脏列表见本篇**第四十二篇**。
- `attachRenderObject` / `slot` 的搬运细节见**第四十四篇**。
- `Element.activate` 里 `didChangeDependencies` 补调之后的依赖注册与通知流程见**第四十三篇**。
- `_debugGlobalKeyReservations` / `_debugVerifyGlobalKeyReservation` 的完整对账逻辑（`:3211-3320` 附近）本篇不逐行展开，只给结论。
- 本篇讲的是"`GlobalKey` 的注册表写在哪四处、认领的五个步骤、搬运要修哪四条链"。
