# 38 inflateWidget 与 updateChild：Element 复用判定

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`

## 一、问题

父组件 rebuild 之后，`build()` 返回了一棵**全新的 Widget 树**。上一帧那些 Element 怎么办？

- 全扔掉重建？那 `State` 就丢了，输入框里的光标、滚动位置、动画进度全没了。
- 全留下复用？那 Widget 换了类型、换了 key、换了位置，复用出来的东西就是错的。

常见错误直觉是"**`Widget` 变了就重建，没变就复用**"。这句话在字面上就对不上：`build()` 每次返回的 Widget 实例都是新的（除非 `const`），所以"没变"几乎从不发生。

真正在比较的不是 Widget 的实例，而是**两个 Widget 的 `runtimeType` 和 `key`**（第三十七篇讲过 `Widget.canUpdate`）。这一篇要讲的是这条判定被**用在了哪两个位置**，以及"不复用"时那个旧 Element 到底被丢到哪里去了。

答案是 `updateChild`（`:3982`）和 `inflateWidget`（`:4556`）这一对函数，加上一个叫 `_inactiveElements` 的暂存区。

## 二、最小 Demo

一个能同时演示"复用""新实例快速路径""不复用"三种结果的最小例子。核心是一个会打日志的叶子：

```dart
import 'package:flutter/widgets.dart';

/// 打日志的叶子：只看 Element 是被复用了还是被换了。
class Probe extends StatefulWidget {
  const Probe({super.key});
  @override
  State<Probe> createState() => _ProbeState();
}

class _ProbeState extends State<Probe> {
  @override
  void initState() {
    debugPrint('initState        ← Element 是新建的');
    super.initState();
  }

  @override
  void didUpdateWidget(Probe oldWidget) {
    debugPrint('didUpdateWidget  ← 同一个 Element 换了新配置');
    super.didUpdateWidget(oldWidget);
  }

  @override
  void deactivate() {
    debugPrint('deactivate       ← 已进 _inactiveElements，还没销毁');
    super.deactivate();
  }

  @override
  void dispose() {
    debugPrint('dispose          ← 帧末真正销毁');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox(width: 10, height: 10);
}

/// 父组件：按 _mode 决定往**同一个 slot** 放什么。
class SwapLab extends StatefulWidget {
  const SwapLab({super.key});
  @override
  State<SwapLab> createState() => _SwapLabState();
}

class _SwapLabState extends State<SwapLab> {
  int _mode = 0;
  final GlobalKey _gkey = GlobalKey();

  // 接一个按钮，手动调用切换形态
  void next() => setState(() => _mode = (_mode + 1) % 5);

  @override
  Widget build(BuildContext context) {
    // 1. 五种形态，分别命中 updateChild 的五个出口
    final Widget child = switch (_mode) {
      0 => Probe(),                     // 每次 build 都是新实例，非 const
      1 => const Probe(),               // 与上一帧实例完全相同（const 规范化）
      2 => const SizedBox(width: 10, height: 10),  // 换 runtimeType
      3 => Probe(key: _gkey),           // 带 GlobalKey
      _ => Probe(),                     // 去掉 GlobalKey
    };
    return Directionality(textDirection: TextDirection.ltr, child: child);  // 2. 同一个 slot
  }
}
```

按下 `next()` 依次切换，会看到五种不同的配对：

| `_mode` 变化 | 传下去的 Widget | 日志 |
|---|---|---|
| 0 → 0（再 pump 一次） | `Probe()` → `Probe()` | `didUpdateWidget`。两个是不同的实例，但 `runtimeType` 与 `key` 都相同，`canUpdate` 命中（出口 3） |
| 0 → 1 | `Probe()` → `const Probe()` | **什么都不打**。`const Probe()` 是编译期规范化的实例，恰好等于上一帧那个（出口 2 的 `child.widget == newWidget` 短路） |
| 1 → 2 | `const Probe()` → `Padding` | `deactivate`，帧末 `dispose`。`runtimeType` 不同，`Padding` 建新 Element（出口 4） |
| 2 → 3 | `Padding` → `Probe(key: _gkey)` | `initState`。新建 `Probe` 的 Element，并在 `mount` 里登记 `_gkey` |
| 3 → 4 | `Probe(key: _gkey)` → `Probe()` | `deactivate` + 帧末 `dispose`。**key 从 `_gkey` 变成 null，`canUpdate` 为假**；旧 Element 虽然还挂在 `_gkey` 上，但新 Widget 没有 key，没人去认领它 |

第 0 → 1 行和 0 → 0 行是两个最容易搞混的对比：**内容完全一样的两个 Widget，一个走"深度复用"，一个走"实例相同快速路径"**，区别只在于是不是 `const`。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:3982` | `Element? updateChild(Element? child, Widget? newWidget, Object? newSlot)`，单孩子复用判定 |
| `framework.dart:4125` | `List<Element> updateChildren(...)`，多孩子列表的 key 扫描 |
| `framework.dart:4143-4172` | `updateChildren` 六步算法的原文注释，本层最有价值的一段文档 |
| `framework.dart:4556` | `Element inflateWidget(Widget newWidget, Object? newSlot)`，新建或搬运 |
| `framework.dart:4481` | `_retakeInactiveElement`，GlobalKey 认领 inactive 元素（第三十九篇展开） |
| `framework.dart:4632` | `deactivateChild`，把旧 Element 送进暂存区 |
| `framework.dart:4375` | `Element.update(covariant Widget newWidget)`，复用的落地动作 |
| `framework.dart:2916` | `final _InactiveElements _inactiveElements = _InactiveElements();` |
| `framework.dart:2099` | `class _InactiveElements`，暂存区实现 |
| `framework.dart:3339` | `BuildOwner.finalizeTree`，帧末把暂存区清空 |

## 四、调用链

### 4.1 `updateChild`：四种出口

`updateChild` 是每个 Element 更新孩子时的必经之路。它的文档里有一张判定表，源码里就是这张表的实现：

| | `newWidget == null` | `newWidget != null` |
|---|---|---|
| `child == null` | 返回 `null` | 返回新 `Element` |
| `child != null` | 旧孩子被移除，返回 `null` | 能更新就更新，返回原孩子或新 `Element` |

把源码按出口切一遍：

```dart
// framework.dart:3982 起（节选）
Element? updateChild(Element? child, Widget? newWidget, Object? newSlot) {
  if (newWidget == null) {                     // 出口 1：孩子被删了
    if (child != null) deactivateChild(child);
    return null;
  }
  final Element newChild;
  if (child != null) {
    var hasSameSuperclass = true;
    assert(() {                                // 只算一次，release 下整块消失
      hasSameSuperclass = Element._debugConcreteSubtype(child) ==
          Widget._debugConcreteSubtype(newWidget);
      return true;
    }());
    if (hasSameSuperclass && child.widget == newWidget) {   // 出口 2：实例完全相同
      if (child.slot != newSlot) updateSlotForChild(child, newSlot);
      newChild = child;
    } else if (hasSameSuperclass && Widget.canUpdate(child.widget, newWidget)) {
      if (child.slot != newSlot) updateSlotForChild(child, newSlot);   // 出口 3：复用
      child.update(newWidget);
      newChild = child;
    } else {                                   // 出口 4：不复用
      deactivateChild(child);
      newChild = inflateWidget(newWidget, newSlot);
    }
  } else {
    newChild = inflateWidget(newWidget, newSlot);   // 出口 5：本来就没孩子
  }
  return newChild;
}
```

四处细节值得单独说：

**出口 2 的 `child.widget == newWidget` 不是内容比较。** 第三十七篇确认过 `Widget.==` 被 `@nonVirtual` 钉死在 `super == other` 上，也就是身份比较。所以这里的语义是"**这一帧传下来的就是上一帧那个 Widget 实例**"——只有 `const` Widget 或缓存的 Widget 字段才会命中。命中后的动作只有"可能需要挪 slot"，连 `update` 都不调，这是最省的一条路径。

**`hasSameSuperclass` 只为热重载存在。** 它的注释写得很明确：热重载把 `StatefulWidget` 改成 `StatelessWidget` 时，树里会留下一个引用着 `StatelessWidget` 的 `StatefulElement`；如果这时去读 `StatelessElement.widget` 的 cast getter 就会抛 `TypeError`。所以这个断言算出的 `false` 会短路掉后面两个 `canUpdate` 检查，直接走到"不复用"分支，把这个错配的 Element 温和地请出去。**它在 release 下不存在**（整个 assert 块被消除），此时 `hasSameSuperclass` 恒为 `true`。

**`slot` 变化要单独处理。** 三种出口里都有 `if (child.slot != newSlot) updateSlotForChild(child, newSlot)`。这不是可选的清理——`slot` 是 RenderObject 在兄弟链表里的插入位置，Element 复用了但位置变了，必须把 RenderObject 也挪过去。第四十四篇展开 `slot` 的三件套。

**返回值的语义是"这个位置现在由谁占"。** 它可能是原来的 child（复用），也可能是新建的 Element，还可能是 `null`（孩子被删）。调用者必须用返回值替换自己的孩子指针——`ComponentElement.performRebuild` 里就是 `_child = updateChild(_child, built, slot)`。

### 4.2 `updateChildren`：多孩子列表的六步扫描

单孩子只有"对/不对"两种判断；多孩子还要处理**顺序变化和中间插入**。`updateChildren` 的源码上方有一段 16 行的注释，是整层最值得逐字读的文档：

```text
// framework.dart:4143-4172
// The general approach is to sync the entire new list backwards, as follows:
// 1. Walk the lists from the top, syncing nodes, until you no longer have
//    matching nodes.
// 2. Walk the lists from the bottom, without syncing nodes, until you no
//    longer have matching nodes. We'll sync these nodes at the end. We
//    don't sync them now because we want to sync all the nodes in order
//    from beginning to end.
// At this point we narrowed the old and new lists to the point
// where the nodes no longer match.
// 3. Walk the narrowed part of the old list to get the list of
//    keys and sync null with non-keyed items.
// 4. Walk the narrowed part of the new list forwards:
//     * Sync non-keyed items with null
//     * Sync keyed items with the source if it exists, else with null.
// 5. Walk the bottom of the list again, syncing the nodes.
// 6. Sync null with any items in the list of keys that are still
//    mounted.
```

六步在代码里的对应：

| 步 | 代码位置 | 做什么 |
|---|---|---|
| 1 | `4184` 起 `while` + `canUpdate` | 从**头**逐个同步，直到碰到不匹配 |
| 2 | `4204` 起 `while` | 从**尾**逐个跳过（只减下标，不 `updateChild`） |
| 3 | `4216` 起 | 中间段的老孩子按 key 收进 `Map<Key, Element> oldKeyedChildren`；**无 key 的直接 `deactivateChild`** |
| 4 | `4235` 起 | 中间段的新孩子：有 key 就去 Map 里取，取到且可复用才算匹配（`4243` 的 `canUpdate`）；无 key 的 `oldChild` 传 `null` |
| 5 | `4279` 起 | 回到尾部，这时才真正 `updateChild` |
| 6 | `4299` 起 | `oldKeyedChildren` 里剩下的（新列表里已没有）全部 `deactivateChild` |

**关键认知**：步骤 2 只"扫描"不"同步"，是为了**让所有孩子都按从头到尾的顺序 `updateChild`**——因为 `updateChild` 要往 `newSlot` 里写"前一个兄弟"，顺序必须单调。如果步骤 2 就同步尾部，尾部孩子会被先更新，`IndexedSlot` 里的 `previousChild` 就乱了。

**"从中间开始同步"到底省了什么。** 考虑 `[A, B, C, D]` → `[A, B, X, C, D]`：步骤 1 同步 `A, B` 就卡住（`C` vs `X` 不匹配）；步骤 2 从尾往前跳过 `D`、`C`；此时中间段老列表只剩 `[]`（`oldChildrenTop > oldChildrenBottom`），新列表中间段是 `[X]`。步骤 4 直接 `inflateWidget(X)`。**结果：2 次头部同步 + 1 次新建 + 2 次尾部同步，没有任何老 Element 被销毁。** 如果是朴素的"按下标逐个比"，就会得到 `C` vs `X` 不匹配 → 销毁并重建 `C`、`D` vs `C` 不匹配 → 销毁并重建 `D`、最后还要新建一个收尾——**一次中间插入导致后面全部重建**。这就是头部/尾部两次扫描的价值：**它把"一次插入"带来的 Element 新建/销毁**数量**从 O(n) 降到 O(1)**（key 命中的老 Element 直接复用）。但降为常数的只有"新建/销毁数"这一项：整个列表仍要被头尾两遍扫描，存活的每个孩子也仍要各走一次 `updateChild`（本例 `A`、`B` 在步骤 1，`C`、`D` 在步骤 5），所以 `updateChildren` 的总工作量仍是 O(n)。

代价是：**无 key 的老孩子在中间段一律被丢弃**（步骤 3 的 `else` 分支）。所以列表顺序会变、或会在中间增删时，必须给每个孩子一个 key。

### 4.3 `deactivateChild`：不是销毁，是"挂起"

不复用时旧 Element 的去向：

```dart
// framework.dart:4632 起（节选）
void deactivateChild(Element child) {
  assert(child._parent == this);
  child._parent = null;                     // 1. 先断父子关系
  child.detachRenderObject();               // 2. 把 RenderObject 从渲染树摘掉
  owner!._inactiveElements.add(child);      // 3. 送进暂存区（内部会调 deactivate）
}
```

三个动作的顺序很讲究：

1. **`_parent = null` 必须在最前**，因为 `_InactiveElements.add` 里有 `assert(element._parent == null)`。
2. **`detachRenderObject` 是"离开屏幕"**，不是销毁。RenderObject 只是从父的 child 链表里摘掉，对象本身还活着。
3. **`_inactiveElements.add` 内部会递归 `deactivate`** 整个子树。

`_InactiveElements` 只是一个 `HashSet<Element>` 加一个锁：

```dart
// framework.dart:2099-2101
class _InactiveElements {
  bool _locked = false;
  final Set<Element> _elements = HashSet<Element>();
```

它**只存子树的根**，不存后代——`add` 里的 `_deactivateRecursively` 会把整个子树都标成 `inactive`，但只有根进 Set：

```dart
// framework.dart:2148 起（节选）
void add(Element element) {
  assert(!_locked);
  assert(element._parent == null);
  switch (element._lifecycleState) {
    case _ElementLifecycle.active:
      _deactivateRecursively(element);   // 递归把整棵子树变成 inactive
      _elements.add(element);            // 只把根收进 Set
    case _ElementLifecycle.inactive:
      _elements.add(element);            // 已经挂起的，直接收
    case _ElementLifecycle.initial || _ElementLifecycle.failed || _ElementLifecycle.defunct:
      assert(false, '$element must not be deactivated when in ${element._lifecycleState} state.');
  }
}
```

**关键认知**：`_inactiveElements` 是一个**一帧有效的等待区**。`deactivate` 之后 Element 仍然完整（`_widget` 还在、`State` 还在、RenderObject 还在），只是不在树上了。它有两种命运：

- **被同一个 `GlobalKey` 认领**：`inflateWidget` 会把它从 Set 里 `remove` 出来，重新 `_activateWithParent`（第三十九篇）；
- **没人认领**：帧末 `BuildOwner.finalizeTree`（`:3339`）调 `_inactiveElements._unmountAll()`，把它们真正 `unmount`。

`_unmountAll` 的顺序也值得看一眼——它按 `depth` 排序后**倒序**处理，而 `_unmount` 自己又是**先递归孩子再 `unmount` 自己**：

```dart
// framework.dart:2121-2131（节选）
void _unmountAll() {
  _locked = true;
  final List<Element> elements = _elements.toList()..sort(Element._sort);
  _elements.clear();
  try {
    elements.reversed.forEach(_unmount);   // 深的先，浅的后
  } finally { ... }
}

// framework.dart:2103-2116（节选）
static void _unmount(Element element) {
  element.visitChildren((Element child) {
    assert(child._parent == element);
    _unmount(child);          // 孩子先
  });
  element.unmount();          // 自己后
}
```

所以 `dispose()` 的调用顺序是**子先于父**，与 `build` 的方向相反。

### 4.4 `inflateWidget`：新建，或者搬运一个旧的

最后一块拼图。`updateChild` 决定"不复用"之后，一切交给 `inflateWidget`：

```dart
// framework.dart:4556 起（节选）
Element inflateWidget(Widget newWidget, Object? newSlot) {
  final Key? key = newWidget.key;
  final Element? inactiveChild = key is GlobalKey
      ? _retakeInactiveElement(key, newWidget)     // 1. 有 GlobalKey 就先试试能不能认领
      : null;
  final Element newChild = inactiveChild ?? newWidget.createElement();   // 2. 认不到就新建

  if (inactiveChild != null) {
    inactiveChild._activateWithParent(this, newSlot);   // 3a. 搬运：改父、重算 depth、重挂 RenderObject
    final Element? updatedChild = updateChild(inactiveChild, newWidget, newSlot);
    return updatedChild!;
  } else {
    newChild.mount(this, newSlot);                      // 3b. 新建：mount
    return newChild;
  }
}
```

两条路的分工：

| | 新建（`inactiveChild == null`） | 搬运（`inactiveChild != null`） |
|---|---|---|
| Element 来源 | `newWidget.createElement()` | `_retakeInactiveElement` 从注册表拿到 |
| 生命周期跃迁 | `initial` → `active`（`mount`） | `inactive` → `active`（`_activateWithParent`） |
| 此后还做什么 | 无 | 再走一遍 `updateChild`，让新 Widget 落到它身上 |
| 状态 | 全新 | **保留**（`State`、`RenderObject`、`depth` 都还在） |

注意搬运路径里那句 `assert(inactiveChild == updatedChild)`：`updateChild` 在搬运后**必须**返回同一个 Element。如果这里返回了新的，说明 `canUpdate` 在第二次判定时反悔了——那意味着有两个不同的 Element 同时持有同一个 GlobalKey，树上出问题了。

**关键认知**：`inflateWidget` 不判断"该不该复用"，它只负责"**既然决定不复用，那我去哪拿一个 Element 给你**"。判断在 `updateChild`，取货在 `inflateWidget`。把这两件事分在两个方法里，是因为 `inflateWidget` 还会被一些 Element 直接调用（跳过 `updateChild`）——`MultiChildRenderObjectElement.mount`（`:7270` 方法体里的 `:7279`）就是逐个子孩子直接 `inflateWidget`，因为它此时没有"老孩子"可比较。

## 五、核心对象：`updateChild` vs `inflateWidget`

| | `updateChild` | `inflateWidget` |
|---|---|---|
| 声明位置 | `framework.dart:3982` | `framework.dart:4556` |
| 问的问题 | "这个位置该由谁占？" | "给我一个 Element" |
| 会返回原来的 child 吗 | 会（两条复用分支） | 会（搬运时返回 `inactiveChild`） |
| 会读 GlobalKey 吗 | 只在 debug 断言里（`_debugReserveGlobalKeyFor`） | 是核心逻辑（`_retakeInactiveElement`） |
| 会调 `createElement` 吗 | 间接触发（走 `inflateWidget`） | 直接调用 |
| 会调 `mount` 吗 | 间接触发 | 直接调用（`:4587`） |
| 会调 `deactivateChild` 吗 | 会（两条"不复用"分支） | 不会 |
| 谁调用它 | 各个 Element 的 `performRebuild` / `mount` | `updateChild`（`:4053`、`:4059`）以及 `MultiChildRenderObjectElement.mount`（`:7279`） |
| 与 Widget 的关系 | 用 `canUpdate` **判定** | 用 `createElement` **兑现** |

一句话区分：**`updateChild` 是裁判，`inflateWidget` 是采购。**

## 六、源码实验

### 实验 1：`canUpdate` 在哪些地方被当作判定用

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
grep -n "Widget.canUpdate" framework.dart
```

**预测**：`canUpdate` 只在 `updateChild` 里出现一次。

**实际**（实测，共 12 处命中）：

```text
382:  static bool canUpdate(...) {            ← 定义
545:  /// ...as determined by calling [Widget.canUpdate].      ← 文档注释
1363:  /// ...as determined by calling [Widget.canUpdate].     ← 文档注释
3952:  /// to the existing child (as determined by [Widget.canUpdate]) ← 文档注释
4007:  // the `Widget.canUpdate` check once `hasSameSuperclass` is false.  ← 注释
4022:      } else if (hasSameSuperclass && Widget.canUpdate(child.widget, newWidget)) {  ← 判定 1
4188:      if (oldChild == null || !Widget.canUpdate(oldChild.widget, newWidget)) {     ← 判定 2
4208:      if (oldChild == null || !Widget.canUpdate(oldChild.widget, newWidget)) {     ← 判定 3
4243:            if (Widget.canUpdate(oldChild.widget, newWidget)) {                     ← 判定 4
4254:      assert(oldChild == null || Widget.canUpdate(oldChild.widget, newWidget));    ← 断言
4284:      assert(Widget.canUpdate(oldChild.widget, newWidget));                        ← 断言
4381:          Widget.canUpdate(widget, newWidget),                                     ← update 的前置断言
4492:    if (!Widget.canUpdate(element.widget, newWidget)) {                            ← 判定 5
```

**说明**：真正的判定只有 5 处——`4022`（单孩子）、`4188` / `4208` / `4243`（多孩子列表的头扫 / 尾扫 / 中间建表匹配）、`4492`（GlobalKey 认领前的资格检查）。**规则只有一份，判定点散在三条路上**：

| 路径 | 判定在哪 |
|---|---|
| 单孩子（`ComponentElement` / `SingleChildRenderObjectElement`） | `updateChild:4022` |
| 多孩子列表（`MultiChildRenderObjectElement`） | `updateChildren:4188/4208/4243`，自身不做二次 `updateChild` 判定 |
| GlobalKey 搬运 | `_retakeInactiveElement:4492` |

还有个 grep 本身的教训：`updateChild` 里那次判定写在同一行的 `hasSameSuperclass && Widget.canUpdate(...)` 上，所以确实被这条命令扫到了；但**"grep 得到的是这一行有，不是这个调用只有这些"**——`updateChildren` 内部还会通过 `updateChild` 再走一遍判定，那些是间接的。

### 实验 2：观察 `deactivate` 与 `dispose` 的间隔

用第二节 Demo 里的 `Probe`（已经带了 `deactivate` / `dispose` 日志），把 `_mode` 从 0 切到 2（`Probe` → `SizedBox`），看日志顺序。

**预测**：换掉这个 Widget 时，`deactivate` 和 `dispose` 会紧接着前后脚被调用。

**实际**：`deactivate` 在父的 `performRebuild` 过程中（`updateChild` → `deactivateChild` → `_inactiveElements.add` → `_deactivateRecursively`）立即被调用；`dispose` 要等到**这一帧的 `drawFrame` 末尾** `buildOwner.finalizeTree()` 才被调用。中间隔着整个 layout / paint 阶段。

**说明**：这就是"`deactivate` 时可以等一等，`dispose` 时必须真释放"的由来。如果有人在本帧内用 `GlobalKey` 把这个 Element 认领回去（`_retakeInactiveElement` → `_inactiveElements.remove`），`dispose` 就永远不会被调用——`State` 完整地跟着走了。

### 实验 3：`_inactiveElements` 只存子树的根

```bash
grep -n "_elements.add\|_elements.remove\|_elements.clear\|_elements = " \
  packages/flutter/lib/src/widgets/framework.dart
```

**预测**：既然 `deactivate` 是递归的，Set 里应该装了整个子树的所有 Element。

**实际**（实测）：`add` 里只有两处 `_elements.add(element)`，参数都是 `add` 收到的那个 `element`——也就是子树根。后代只被 `_deactivateRecursively` 改了 `_lifecycleState`，没有进 Set。

**说明**：这个设计省内存，也让 `_unmountAll` 的顺序处理变简单（只需对"根"排序，`_unmount` 自己递归）。但它带来一个必须记住的结论：**`_inactiveElements` 里找得到的是子树根；想找后代得走 `visitChildren`。**

### 实验 4：验证步骤 2 只扫不同步

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
sed -n '4203,4214p' framework.dart
```

**预测**：尾部扫描应该和头部扫描长得差不多。

**实际**（实测输出）：

```dart
    // Scan the bottom of the list.
    while ((oldChildrenTop <= oldChildrenBottom) && (newChildrenTop <= newChildrenBottom)) {
      final Element? oldChild = replaceWithNullIfForgotten(oldChildren[oldChildrenBottom]);
      final Widget newWidget = newWidgets[newChildrenBottom];
      assert(oldChild == null || oldChild._lifecycleState == _ElementLifecycle.active);
      if (oldChild == null || !Widget.canUpdate(oldChild.widget, newWidget)) {
        break;
      }
      oldChildrenBottom -= 1;
      newChildrenBottom -= 1;
    }
```

**说明**：对比头部扫描（`4183-4198`），尾部循环里**没有 `updateChild` 调用**，也没有 `updateSlotForChild` 和 `previousChild = newChild`。差异就是注释里那句 "we don't sync them now" 的具体含义——**只缩小范围，不同步**。同步留到步骤 5（`4279`）统一做，保证 `updateChild` 的调用顺序严格从头到尾。

## 七、结论

1. "Widget 变了就重建"是错的说法。真正的判定是 `Widget.canUpdate`（只看 `runtimeType` + `key`），并且它只在三处被用来做**列表级**判定：`updateChild`（单孩子）、`updateChildren` 的头部/尾部扫描（多孩子）、`_retakeInactiveElement`（GlobalKey 认领）。还有一条"完全相同实例"的快速路径 `child.widget == newWidget`，它靠 `const` Widget 命中。
2. **不复用 ≠ 销毁**。旧 Element 被 `deactivateChild` 送进 `BuildOwner._inactiveElements`（只存子树根），在那里**等一整帧**。这一帧内若被 `GlobalKey` 认领就能带着 `State` 复活；否则帧末 `finalizeTree` → `_unmountAll` 才真正 `unmount`，且 `dispose()` 的顺序是**子先于父**。
3. `updateChildren` 的六步扫描是"**头扫 + 尾扫 + 中间按 key 建表**"。头尾两次扫描让"中间插入一个"的 Element 新建/销毁数从 O(n) 降到 O(1)（列表扫描与每个存活孩子的 `updateChild` 调用仍是 O(n)）；代价是**中间段无 key 的老孩子一律被丢弃**，所以顺序会变或会在中间增删的列表必须给 key。

一句话总结：**`updateChild` 判"能不能接着用"，`inflateWidget` 判"不能用时去哪找一个"——找得到就用 `_activateWithParent` 搬过来，找不到才 `createElement` + `mount`。**

## 八、边界声明

- 本篇只讲单孩子与多孩子的复用判定。`GlobalKey` 的注册表、`_retakeInactiveElement` 的完整搬运流程、`_activateWithParent` 里的 `_updateDepth` 留到第三十九篇（`_updateDepth` 的细节已在第三篇讲过）。
- `slot` 的含义、`insertRenderObjectChild` / `moveRenderObjectChild` / `removeRenderObjectChild` 三件套留到第四十四篇。
- `performRebuild` 里 `_child = updateChild(...)` 那一跳的主语（`ComponentElement` / `StatelessElement` / `StatefulElement`）留到第四十篇。
- `markNeedsBuild` / 脏列表 / `buildScope` 留到第四十二篇；`finalizeTree` 的调用时机已在第三十六篇 4.3 的 `drawFrame` 三跳里给过锚点。
- 本篇重点给出**六步扫描算法的逐步对照**和 **`_inactiveElements` 的一帧暂存语义**。
