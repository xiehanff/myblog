# 59 焦点系统：FocusNode 树与 FocusManager 的注册分发

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets/focus_manager.dart`（2406 行）、`packages/flutter/lib/src/widgets/focus_scope.dart`（956 行）、`packages/flutter/lib/src/widgets/focus_traversal.dart`（2474 行）

## 一、问题

一句话问题：`Focus.of(context).requestFocus()` 调完之后 `hasFocus` 为什么不是立刻变 true，而 Tab 键走出来的顺序和 widget 树里写的顺序也对不上？

先拆掉两个最自然、也最耽误事的错误直觉。

**直觉一：焦点就是"当前被选中的那个 widget"。** 于是"焦点存在 widget 树 / Element 树上，谁被选中谁就有焦点"成了默认心智模型。源码给出的答案相反：焦点根本不存在 widget 树里，它是一棵**与 Element 树并行的 `FocusNode` 树**。整棵树只有一个根 `FocusManager.rootScope`（`focus_manager.dart:1842`），当前被选中的那个位置叫 `FocusManager.primaryFocus`（`:1845`）——它是一个 `FocusNode`，不是 widget，也不是 Element。

```dart
// focus_manager.dart:1842-1846
final FocusScopeNode rootScope = FocusScopeNode(debugLabel: 'Root Focus Scope');

/// The node that currently has the primary focus.
FocusNode? get primaryFocus => _primaryFocus;
```

这棵树是**稀疏**的：只有通过 `Focus` widget（或自己 `attach`）接入的节点才存在，中间隔着多少层普通 widget 都不影响焦点树上的父子关系。它又是**持久**的：`FocusNode` 的生命周期由持有者管理，外部传入的节点 widget 重建多少次都是同一个对象（`focus_scope.dart:603-611` 的 `dispose` 只释放内部节点）。

**直觉二：Tab 顺序等于 widget 树里写的顺序。** 于是"把按钮换个位置 Tab 顺序就变了"或者反过来"我明明没动布局，Tab 顺序怎么变了"都归因于树序。源码里的默认策略是 `ReadingOrderTraversalPolicy`（`focus_traversal.dart:1566`），它按每个节点的**屏幕几何矩形**排序：先按 `rect.top` 找最靠上的一行，同一水平 band 内再按 `Directionality` 决定从左还是从右开始（`:1636-1700`）。也就是说 Tab 顺序由**渲染后的几何位置**决定，和 widget 树序是两回事——两列布局、`Row` 里套 `Column`、`Directionality` 翻转都会让两者分道扬镳。

> 关键认知：焦点 = 一棵并行的 `FocusNode` 树 + 一个统一提交变更的 `FocusManager`。`Focus` widget 只是往这棵树上挂节点的语法糖；Tab 顺序 = 遍历策略对候选节点按几何排序的结果。

### 焦点究竟存在哪里

把三层分开看，每一层管的事不同：

```text
widget / Element 层   FocusScope ─ FocusTraversalGroup ─ Focus(debugLabel: 'A') ─ MyButton
                        （只是适配器：创建节点、attach、reparent，不持有焦点状态）

FocusNode 树          rootScope ─ FocusScopeNode ─ FocusNode('A') ─ FocusNode('A 的输入框')
                        （真正的焦点状态：primaryFocus、focusedChild、能力开关都在这层）

FocusManager          持有 rootScope 与 primaryFocus，延迟统一提交焦点变更
```

`Focus` widget 是 `StatefulWidget`（`focus_scope.dart:123`），它的 `_FocusState` 在生命周期里干三件事：`initState` 里 `attach`（`:580`）、`didChangeDependencies` / `build` 里 `reparent`（`:618`、`:713`）、`dispose` 里 `detach`（`:603-609`）。节点本身的状态——`hasFocus`、`canRequestFocus`、`focusedChild` 历史——全在 `FocusNode` 上，widget 层一个都不存。

### 为什么需要单独的 FocusManager

如果焦点只是"树上一个指针"，那 `FocusNode` 自己就能改。问题是焦点变更会牵动一串人：旧焦点链上的每个祖先要收通知、新焦点链上的每个祖先要收通知、`FocusManager` 自己还有监听者（`FocusManager.instance` 是 `ChangeNotifier`，`focus_manager.dart:1636`）。这些通知不能在 `requestFocus()` 调用栈里同步发——那样 build 期间请求焦点就会炸——所以源码把"请求"和"生效"拆开：请求只标记 `_markedForFocus`，真正的提交延迟到一个 microtask 里统一做（`:1920-1933`、`:1951`）。这正是本篇标题里"注册分发"的"分发"半边。

至于"注册"半边，先给一个会颠覆直觉的事实：**`FocusManager` 上没有任何公开的 `register(FocusNode)` API**。节点接入 manager 靠的是 `FocusAttachment.reparent` → `_reparent` → `_updateManager` 这条链把 manager 引用写进子树的每个节点（`focus_manager.dart:265`、`:1044`、`:1034`）；而 `registerGlobalHandlers`（`:1685`）注册的是另一件完全不同的事——全局键盘输入 handler。两个"注册"在第四节分开讲清楚。

### 一个版本差异注记

在 3.44.8 的本地源码里，`FocusNode`、`FocusScopeNode`、`FocusManager` **同在 `widgets/focus_manager.dart` 一个文件里**，`widgets/` 目录下并不存在独立的 `focus_node.dart`（`ls` 只能看到 `focus_manager.dart` / `focus_scope.dart` / `focus_traversal.dart` 三个文件）。同理，本地源码里**没有**名为 `FocusTraversal` 的类，遍历策略的基类叫 `FocusTraversalPolicy`（`focus_traversal.dart:185`，abstract）。按旧教程的文件名和类名去找代码会一无所获。

## 二、最小 Demo

### 2.1 最小可运行版本

下面这个例子把本篇要观察的三层全部摆出来：一个 `FocusScope`（作用域）、一个 `FocusTraversalGroup`（遍历分组）、三个带 `debugLabel` 的 `Focus` 节点，外加三个**移出实验组**的观察按钮（显式请求、遍历下一项、dump 焦点树）。不需要接物理键盘——`requestFocus` / `nextFocus` 就是 Tab 键最终会走到的那两个入口，把键盘事件挡在了门外。

```dart
import 'package:flutter/material.dart';

void main() => runApp(const FocusLabApp());

class FocusLabApp extends StatelessWidget {
  const FocusLabApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      // 1. MaterialApp 内部会引入默认的 FocusTraversalGroup 与根 FocusScope
      home: FocusLabPage(),
    );
  }
}

class FocusLabPage extends StatefulWidget {
  const FocusLabPage({super.key});

  @override
  State<FocusLabPage> createState() => _FocusLabPageState();
}

class _FocusLabPageState extends State<FocusLabPage> {
  // 2. 显式持有 A 的节点：观察按钮从节点本身发起请求，不依赖 context 向上找
  final FocusNode aNode = FocusNode(debugLabel: 'A');

  @override
  void dispose() {
    aNode.dispose(); // 外部传入的节点由持有方释放，Focus 只释放内部节点
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // 3. 实验组：显式作用域 + 遍历分组，遍历默认困在这个 scope 里（closedLoop）
          FocusScope(
            debugLabel: 'Lab Scope',
            child: FocusTraversalGroup(
              // 4. 不传 policy，默认就是 ReadingOrderTraversalPolicy
              child: Column(
                children: [
                  // 5. 三个接入焦点树的节点；中间夹的普通 widget 不影响焦点树父子关系
                  Focus(focusNode: aNode, child: const Text('节点 A')),
                  const SizedBox(height: 20),
                  Focus(debugLabel: 'B', child: const Text('节点 B')),
                  const SizedBox(height: 20),
                  Focus(debugLabel: 'C', child: const Text('节点 C')),
                ],
              ),
            ),
          ),
          const SizedBox(height: 40),
          // 6. 观察控件整体移出实验组：不在 Lab Scope 后代里，不是这组遍历的候选
          Focus(
            canRequestFocus: false,
            skipTraversal: true,
            child: Column(
              children: [
                FilledButton(
                  onPressed: () => aNode.requestFocus(),
                  child: const Text('requestFocus'),
                ),
                FilledButton(
                  onPressed: () => aNode.nextFocus(),
                  child: const Text('nextFocus'),
                ),
                FilledButton(
                  onPressed: () => debugDumpFocusTree(),
                  child: const Text('dump tree'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
```

这段代码有两个刻意的设计，都来自源码约束。其一，观察按钮不能写 `Focus.of(context)`：build 的 context 位于自定义 `FocusScope` 之上，沿 Element 向上找到的最近节点是路由的 FocusScope 而不是 A 所在的 `Focus`，`maybeOf` 在 `scopeOk: false` 时遇到 scope 直接返回 null（`focus_scope.dart:460-462`），`Focus.of` 的断言随即抛 `Focus.of() was called with a context that does not contain a Focus widget`（`:404-410`）——所以改成显式持有的 `aNode` 直接调 `requestFocus()` / `nextFocus()`。其二，`FilledButton` 对焦点树不是"透明"的：`ButtonStyleButton` 会把焦点配置传给 `InkWell`（`material/button_style_button.dart:561-562`），`InkWell` 再构造自己的 `Focus` 节点（`material/ink_well.dart:1390`），按钮会接入焦点树。观察按钮若留在实验组内，遍历候选就不止 A/B/C；把它们移出 `Lab Scope` 之外，就不再是这组遍历的候选，不干扰本实验组内 A/B/C 的 `nextFocus`。但“不干扰”只对这一组成立：外层的 `Focus(canRequestFocus: false, skipTraversal: true)` 只约束包装节点自身，`FilledButton` 内部自动创建的节点仍是外层组的候选；要让整棵子树都不参与，得显式设置 `descendantsAreFocusable: false` / `descendantsAreTraversable: false`（祖先版开关见 5.4）。

### 2.2 可观察版本

把注意力集中到三个观察点上（预期行为，按源码推演，未逐行运行）：

1. **`debugDumpFocusTree()`**（`focus_manager.dart:2401`）：往控制台打印整棵焦点树。三个 `Focus` 节点应当以 `debugLabel` 出现在 `Lab Scope` 之下；`Lab Scope` 之上不是直接接 `Root Focus Scope`——MaterialApp 还会引入 Navigator、路由等中间 `FocusScope`（见下一条）；当前焦点节点带 `PRIMARY FOCUS` 标记，它的祖先带 `IN FOCUS PATH` 标记（这两个标记来自 `FocusNode.debugFillProperties`，`focus_manager.dart:1255-1298`）。
2. **`WidgetsBinding.instance.focusManager.primaryFocus`**（`widgets/binding.dart:850`）：打印当前主焦点。刚进页面时它不是 `Root Focus Scope`：`WidgetsApp` 的 Navigator 分支自带 `FocusScope(debugLabel: 'Navigator Scope', autofocus: true)`（`widgets/app.dart:1692-1695`），待处理的 autofocus 会先于 rootScope 回退逻辑被消费（`focus_manager.dart:1960-1963`）；只有没有任何待处理 autofocus 且无人请求过焦点时，`applyFocusChangesIfNeeded` 才回退到 rootScope（`:1965-1969`）。
3. **`requestFocus` 与 `hasFocus` 的时间差**：在 `onPressed` 里先 `aNode.requestFocus()` 再立刻读 `aNode.hasFocus`，读到的是旧值；把读取挪到 `scheduleMicrotask` 或下一帧才读到新值。原因在第四节：通知被延迟到 microtask 里统一提交（`focus_manager.dart:1951`）。

想看几何排序如何压倒树序，把实验组里的 `Column` 换成 `Row`（A、B、C 横排）再按 `nextFocus`，或在 `MaterialApp` 外层包一个 `Directionality(textDirection: TextDirection.rtl)`：候选集没变，顺序变了——因为排序读的是 `FocusNode.rect`（`:853`，从 `RenderObject` 取屏幕矩形）而不是树的位置。

## 三、入口锚点

| 位置 | 是什么 | 一句话职责 |
|---|---|---|
| `widgets/focus_manager.dart:195` | `FocusAttachment` | host 与 node 之间的附件：`attach` 的返回物，管 `reparent` / `detach` |
| `widgets/focus_manager.dart:448` | `FocusNode` | 焦点树普通节点：状态 + `requestFocus` / `nextFocus` |
| `widgets/focus_manager.dart:1346` | `FocusScopeNode` | 作用域节点：额外记 `focusedChild` 历史与边界行为 |
| `widgets/focus_manager.dart:1636` | `FocusManager` | 每树一个的管理器：`rootScope` + `primaryFocus` + 延迟提交 |
| `widgets/focus_scope.dart:123` | `Focus` | widget 层适配器：attach / reparent / detach 的语法糖 |
| `widgets/focus_scope.dart:795` | `FocusScope` | `Focus` 的子类，节点换成 `FocusScopeNode` |
| `widgets/focus_traversal.dart:185` | `FocusTraversalPolicy`（abstract） | 遍历策略基类：`next` / `previous` / `inDirection` / `sortDescendants` |
| `widgets/focus_traversal.dart:2039` | `FocusTraversalGroup` | 遍历分组 widget：给子树指定一个 policy |

写进正文前用到的默认值也都现场核对过：`FocusNode` 构造默认 `skipTraversal = false`、`canRequestFocus = true`、`descendantsAreFocusable = true`、`descendantsAreTraversable = true`（`focus_manager.dart:463-466`）；`Focus` 的 `autofocus = false`、`includeSemantics = true`（`focus_scope.dart:130`、`:142`）；`FocusScopeNode` 的 `traversalEdgeBehavior` 默认 `closedLoop`、`directionalTraversalEdgeBehavior` 默认 `stop`（`focus_manager.dart:1360-1361`）；`FocusTraversalGroup` 未传 policy 时落回 `ReadingOrderTraversalPolicy()`（`focus_traversal.dart:2048`）。

## 四、调用链

### 4.1 第 0 跳：整棵树从哪来——`BuildOwner` 构造 `FocusManager`

焦点树的根不在 `main()` 里，而在 `BuildOwner` 的构造函数：

```dart
// widgets/framework.dart:2909-2910
BuildOwner({this.onBuildScheduled, FocusManager? focusManager})
  : focusManager = focusManager ?? (FocusManager()..registerGlobalHandlers());
```

`FocusManager` 构造时把唯一的根 `rootScope` 认作自己的树（`focus_manager.dart:1655`，`rootScope._manager = this`），随后 `registerGlobalHandlers()`（`:1685`）挂上全局输入 handler。平时拿 manager 走 `WidgetsBinding.instance.focusManager`（`widgets/binding.dart:850`）——`WidgetsBinding` 只是转发 `BuildOwner` 的持有，这条装配链属于第 50 篇，这里只需要知道"每棵 widget 树对应一个 `FocusManager`"。

### 4.2 第 1 跳：`Focus` widget 把节点 attach 到 Element 上

`Focus` 是 `StatefulWidget`，`_FocusState.initState` 调 `_initNode`（`focus_scope.dart:567`）：先把 widget 上的能力开关同步到节点，再把自己注册为监听者，最后 attach——

```dart
// focus_scope.dart:580-584
_focusAttachment = focusNode.attach(
  context,
  onKeyEvent: widget.onKeyEvent,
  onKey: widget.onKey,
);
```

`FocusNode.attach`（`focus_manager.dart:1099`）只做三件事：记下 `_context`、记下按键回调、new 出一个 `FocusAttachment` 返回。注意 `attach` **不建父子关系**——此刻节点在焦点树上还是没有父亲的光杆节点。`Focus.of(context)` 能找到它，靠的是 build 末尾包的 `_FocusInheritedScope`（`focus_scope.dart:900`，一个 `InheritedNotifier<FocusNode>`）：

```dart
// focus_scope.dart:731（_FocusState.build 的返回值）
return _FocusInheritedScope(node: focusNode, child: child);
```

`Focus.of`（`:398`）与 `FocusScope.of`（`:827`）都是沿 InheritedWidget 向上找最近的节点，后者取其 `nearestScope`，找不到就回落到 `rootScope`。

节点的所有权也要在这里分清：外部传入的 `focusNode` 由调用方 `dispose`；`Focus` 自己创建的内部节点（`_internalNode`）由 `_FocusState.dispose` 释放（`focus_scope.dart:603-611`）。所以同一个 `FocusNode` 实例可以穿越 widget 重建而保住焦点状态——这正是"持久"的含义。

### 4.3 第 2 跳：reparent——焦点树的父子关系在每次 build 时修补

`attach` 只登记 context，真正把节点挂进树的是 `reparent`，它在两个时机被调：

```dart
// focus_scope.dart:616-618（依赖变化时）
void didChangeDependencies() {
  super.didChangeDependencies();
  _focusAttachment?.reparent();

// focus_scope.dart:712-713（每次 build）
Widget build(BuildContext context) {
  _focusAttachment!.reparent(parent: widget.parentNode);
```

`FocusAttachment.reparent`（`focus_manager.dart:265`）找父节点的顺序是：显式传的 `parent` 参数 → `Focus.maybeOf(context, scopeOk: true)` 沿 Element 向上找最近焦点节点 → 兜底 `rootScope`：

```dart
// focus_manager.dart:268-269
parent ??= Focus.maybeOf(_node.context!, scopeOk: true);
parent ??= _node.context!.owner!.focusManager.rootScope;
```

> 关键认知：父子关系不是 `attach` 建的，是**每次 build / didChangeDependencies 重新对齐**的。所以用 GlobalKey 把子树搬到另一个 scope 下面，下一次 build 的 `reparent` 就会自动改挂——不需要手动迁移焦点状态。

找到父节点后进入 `FocusNode._reparent`（`focus_manager.dart:1044`）：

```dart
// focus_manager.dart:1064-1068（节选）
child._parent?._removeChild(child, removeScopeFocus: oldScope != nearestScope);
_children.add(child);
child._parent = this;
child._ancestors = null;
child._updateManager(_manager);
```

把 child 加进 `_children`、写 `_parent`、失效祖先缓存，然后 `_updateManager`（`:1034`）递归把 `_manager` 引用写给整棵子树。这就是"节点接入 manager"的全部真相——没有中心化的注册表，manager 引用是随树形挂接扩散的。

两个补充分支：widget 被 `deactivate`（比如 GlobalKey 搬家途中）时，`_FocusState` 会先 `reparent` 把节点临时停靠到 rootScope，保留焦点状态等下一次 `didChangeDependencies` 再挂回去（`focus_scope.dart:630-639` 的注释把这套"停车"逻辑写得很清楚）；真正销毁时 `FocusAttachment.detach`（`focus_manager.dart:216`）先 `unfocus`、再让 manager `_markDetached` 清掉 `primaryFocus` 引用、最后从 `_children` 摘除。

### 4.4 第 3 跳：`requestFocus`——一次焦点请求的延迟提交

现在看"分发"。显式请求焦点的调用链：

```text
FocusNode.requestFocus(node)            focus_manager.dart:1153
  └─ node._doRequestFocus()             :1169
       ├─ !canRequestFocus → 直接返回    :1170-1175
       ├─ _parent == null → 记 _requestFocusWhenReparented，等下次挂树再试  :1179-1182
       └─ _setAsFocusedChildForScope()  :1216  沿祖先 scope 记 focusedChild 历史
            └─ _markNextFocus(this)     :991   节点级：转交 manager
                 └─ FocusManager._markNextFocus   :1901  只写 _markedForFocus
                      └─ _markNeedsUpdate         :1920  scheduleMicrotask(applyFocusChangesIfNeeded)
```

注意 `requestFocus` 的文档注释（`:1151-1152`）明说了：节点在**一个 microtask 之后**才收到获得主焦点的通知，通知可能滞后请求最多一帧。真正的提交在 `applyFocusChangesIfNeeded`（`:1951`）：

```dart
// focus_manager.dart:1974-2001（节选）
final Set<FocusNode> previousPath = previousFocus?.ancestors.toSet() ?? <FocusNode>{};
final Set<FocusNode> nextPath = _markedForFocus!.ancestors.toSet();
_dirtyNodes.addAll(nextPath.difference(previousPath));   // 新进入焦点链的祖先
_dirtyNodes.addAll(previousPath.difference(nextPath));   // 离开焦点链的祖先
_primaryFocus = _markedForFocus;
_markedForFocus = null;
...
for (final FocusNode node in _dirtyNodes) {
  node._notify();                                        // 逐个触发 ChangeNotifier
}
if (previousFocus != _primaryFocus) {
  notifyListeners();                                     // manager 自身的监听者
}
```

这套"旧/新路径差集"的写法解释了 `hasFocus` 与 `hasPrimaryFocus` 的分工（`:766`、`:783`）：`hasPrimaryFocus` 只在链尾那个节点上为 true；链上的所有祖先 `hasFocus` 为 true（`IN FOCUS PATH`）。scope 节点还有第三个概念 `focusedChild`（`:1395`）——`_focusedChildren` 列表的末位（`:1406`），记录"这个 scope 上次聚焦的是谁"，`FocusScopeNode._doRequestFocus` 的覆写（`:1495`）会顺着它下钻，让一个 scope 重新获得焦点时恢复到上次的叶节点。

> 关键认知：`requestFocus` 是"提交申请"，不是"生效"。生效只发生在 microtask 的 `applyFocusChangesIfNeeded` 里，而且必须不在 build 阶段（`:1952-1955` 的断言）。

### 4.5 第 4 跳：`nextFocus`——Tab 顺序由谁决定

遍历的入口出乎意料地薄：

```dart
// focus_manager.dart:1239
bool nextFocus() => FocusTraversalGroup.of(context!).next(this);
```

`FocusNode` 自己完全不懂顺序，它转手问"我所在的 `FocusTraversalGroup` 用的是什么策略"。`FocusTraversalGroup.of`（`focus_traversal.dart:2141`）沿 Element 向上找 policy（找不到就断言报错，因为 `WidgetsApp` 一族总会引入默认 policy）。接下来：

```text
FocusTraversalPolicy.next(currentNode)         focus_traversal.dart:389
  └─ _moveFocus(currentNode, forward: true)     :590
       ├─ focusedChild == null → findFirstFocus/findLastFocus 兜底   :594-608
       └─ _sortAllDescendants(nearestScope, focusedChild)            :609
            ├─ _findGroups：按 _FocusTraversalGroupNode 分组          :452
            │    ├─ 组内过滤：node.canRequestFocus && !node.skipTraversal  :488
            │    └─ 每组调各自 policy.sortDescendants(members, currentNode)  :514-519
            └─ 递归展开组的成员列表，再过滤一遍不可遍历节点              :521-545
```

`_sortAllDescendants`（`:503`）是理解"Tab 顺序"的心脏，它做了三件事：

1. **分组**：`_findGroups`（`:452`）把 scope 的后代按各自所属的 `_FocusTraversalGroupNode`（`FocusTraversalGroup` 的 state 内部建的节点，`:2197`）归类。`FocusTraversalGroup` 的 build 很克制：只是包了一个 `Focus(canRequestFocus: false, skipTraversal: true, ...)`（`:2240-2248`）——组节点自身不参与聚焦和遍历，纯粹当分组的锚点。
2. **组内排序**：每个组用它自己的 policy 调 `sortDescendants`（abstract 声明在 `:435`）。组没传 policy 就用构造时兜底的 `ReadingOrderTraversalPolicy()`（`:2048`）；连 scope 本身都不在组里时，`_findGroups` 再兜一次底（`:457-458`）。
3. **候选过滤**：`_canRequestTraversalFocus`（`:437-438`）只放行 `canRequestFocus && !skipTraversal` 的节点；当前焦点节点即使不满足条件也留在列表里，否则算法找不到"从谁开始"。

三个内置策略的 `sortDescendants` 差异一眼见底：

```dart
// focus_traversal.dart:1384-1385 —— WidgetOrder：什么也不做
Iterable<FocusNode> sortDescendants(Iterable<FocusNode> descendants, FocusNode currentNode) =>
    descendants;

// focus_traversal.dart:1708-1710 —— ReadingOrder：全量按几何重排
Iterable<FocusNode> sortDescendants(Iterable<FocusNode> descendants, FocusNode currentNode) =>
    sort(descendants);
```

`WidgetOrderTraversalPolicy`（`:1377`）返回的才是"widget 树序"——但它是**可选策略**，不是默认值。默认的 `ReadingOrderTraversalPolicy.sort`（`:1574`）循环调用 `_pickNext`（`:1636`）：先用 `mergeSort` 按 `rect.top` 找最靠上的候选（`:1638-1643`），再用一个"水平 band"（`Rect.fromLTRB(-∞, top, +∞, bottom)`，`:1646-1660`）收拢所有与它在垂直方向重叠的候选，band 内按 `commonDirectionalityOf` 找到的公共书写方向决定左右次序（`:1676-1700`）。`rect` 来自 `FocusNode.rect`（`focus_manager.dart:853`），从节点 context 的 `RenderObject` 做 `getTransformTo(null)` 后取 `semanticBounds`——是全局坐标下的屏幕矩形。

选定目标后，回到 `_requestTabTraversalFocus` → 默认回调 `defaultTraversalRequestFocusCallback`（`:205-220`）：`node.requestFocus()` 加 `Scrollable.ensureVisible(...)`——所以 Tab 到列表外的节点时列表会自动滚动把它露出来。最终又回到 4.4 的延迟提交链。

> 关键认知：Tab 顺序 = 「分组（FocusTraversalGroup）→ 组内 policy 排序（默认 ReadingOrder，按屏幕几何）→ 过滤（canRequestFocus && !skipTraversal）」三步的合成结果。widget 树序只在显式选择 `WidgetOrderTraversalPolicy` 时才生效。

### 4.6 第 5 跳：走到头了怎么办——`traversalEdgeBehavior`

`_moveFocus` 在当前焦点是排序列表的最后一项（forward）或第一项（backward）时进入边界分支（`focus_traversal.dart:612`、`:642`）：

```dart
// focus_traversal.dart:613（forward 分支）
switch (nearestScope.traversalEdgeBehavior) {
  case TraversalEdgeBehavior.leaveFlutterView: // 放弃焦点，交给外层（浏览器地址栏等）
  case TraversalEdgeBehavior.parentScope:      // 跳出当前 scope，去父 scope 的下一项
  case TraversalEdgeBehavior.closedLoop:       // 绕回首项（默认）
  case TraversalEdgeBehavior.stop:             // 停住不动
}
```

`TraversalEdgeBehavior` 是个四值枚举（`:113`）。默认值来自 `FocusScopeNode` 构造：Tab 遍历 `closedLoop`（到尾绕回头）、方向键遍历 `stop`（到边停住）（`focus_manager.dart:1360-1361`）。`FocusTraversalGroup` 不是 scope，它的分组只影响排序，不影响这个边界语义——想让 Tab 走出某个区域，要么用 `FocusScope`，要么把 scope 的 `traversalEdgeBehavior` 改成 `parentScope`。

## 五、核心对象

### 5.1 节点层：`FocusNode` vs `FocusScopeNode` vs `FocusManager`

| | `FocusNode`（`:448`） | `FocusScopeNode`（`:1346`） | `FocusManager`（`:1636`） |
|---|---|---|---|
| 数量 | 树上任意多个 | 作用域处各一个 | 每棵 widget 树一个 |
| 持有状态 | 自身能力开关、按键回调、context | 继承全部 + `_focusedChildren` 历史 | `rootScope`、`primaryFocus`、`_markedForFocus`、`_dirtyNodes` |
| 核心方法 | `attach` / `requestFocus` / `nextFocus` / `unfocus` | 覆写 `_doRequestFocus`（沿 `focusedChild` 下钻）、`autofocus`（`:1473`） | `_markNeedsUpdate` / `applyFocusChangesIfNeeded` |
| 谁创建 | `Focus` 或调用方 | `FocusScope` / Route | `BuildOwner` 构造（`framework.dart:2910`） |

### 5.2 widget 层：`Focus` vs `FocusScope` vs `FocusTraversalGroup`

| | `Focus`（`focus_scope.dart:123`） | `FocusScope`（`:795`） | `FocusTraversalGroup`（`focus_traversal.dart:2039`） |
|---|---|---|---|
| 是什么 | `StatefulWidget` 适配器 | `Focus` 的子类，节点换成 scope | `StatefulWidget`，包一个不可聚焦的 `Focus` |
| 对焦点树做的事 | attach + reparent 一个节点 | attach + reparent 一个 scope 节点 | 插入 `_FocusTraversalGroupNode` 作分组锚点 |
| 影响顺序吗 | 不影响 | 影响（遍历默认困在 scope 内） | 影响（子树的 policy 由它决定） |
| 典型用途 | 给子树一个可聚焦节点 | Dialog / Route 的焦点隔离 | 自定义排序、禁用整组（`descendantsAreFocusable`） |

### 5.3 "有焦点"的四种说法

| 表达式 | 定义处 | 为 true 的范围 |
|---|---|---|
| `hasPrimaryFocus` | `focus_manager.dart:783` | 只有 `primaryFocus` 本尊 |
| `hasFocus` | `:766` | 主焦点节点 + 它的全部祖先 |
| `focusedChild` | `:1395` | scope 视角的"我上次聚焦的是谁" |
| `primaryFocus` | `:1845` | manager 全局唯一，可为 null（回退 rootScope） |

### 5.4 四个能力开关：管"能不能"还是管"参不参与"

| 开关 | 定义处 | 拦住谁 | 对应的祖先版 |
|---|---|---|---|
| `canRequestFocus` | `focus_manager.dart:536` | 显式 `requestFocus`（`:1170`）与遍历候选（`focus_traversal.dart:437`） | `descendantsAreFocusable`（`:580`） |
| `skipTraversal` | `:489` | 只拦遍历候选，显式请求仍可聚焦 | `descendantsAreTraversable`（`:616`） |

这里有个容易被忽略的联动（写代码时最常踩）：`canRequestFocus` 的 getter 是 `_canRequestFocus && ancestors.every(_allowDescendantsToBeFocused)`（`:536`）——祖先的 `descendantsAreFocusable = false` 会让**整棵子树**的 `canRequestFocus` 读作 false；同理 `skipTraversal` 的 getter 会检查祖先的 `descendantsAreTraversable`（`:489-495`）。`ExcludeFocus`（`focus_scope.dart:916`）就是 `Focus(canRequestFocus: false, skipTraversal: true, descendantsAreFocusable: !excluding)` 的现成封装。`traversalChildren` / `traversalDescendants`（`:683`、`:721`）则是这两个开关作用在集合上的版本。

## 六、源码实验

以下三个实验都基于 2.1 的骨架改，"实际"列是按源码条件推演的预期（本篇未接模拟器运行，标记为推演）。

### 实验 1：`debugDumpFocusTree` 看三层结构

**改什么**：给 `FocusScope`、每个 `Focus` 都设 `debugLabel`，用 Demo 里的 dump 按钮触发 `debugDumpFocusTree()`（`focus_manager.dart:2401`）；要拿字符串就用 `debugDescribeFocusTree()`（`:2388`）。

**预测**：树上每个节点一行，缩进表达父子；A/B/C 挂在 `Lab Scope` 下，`Lab Scope` 之上还有 MaterialApp 引入的 Navigator、路由等中间 `FocusScope`，直到 `Root Focus Scope`；被聚焦的节点带 `PRIMARY FOCUS`，其祖先带 `IN FOCUS PATH`。

**实际（推演）**：进页面后按 dump，初始 `primaryFocus` 不是 rootScope——`WidgetsApp` 的 Navigator 分支自带 `FocusScope(debugLabel: 'Navigator Scope', autofocus: true)`（`widgets/app.dart:1692-1695`），每个 modal route 还有自己的 `FocusScopeNode`（`widgets/routes.dart:1095`），而 `applyFocusChangesIfNeeded` 先消费 `_pendingAutofocuses`、之后才在无人请求焦点时回退 rootScope（`focus_manager.dart:1960-1963`、`:1965-1969`），所以初始焦点落在带 autofocus 的 scope 上。对 A 调 `requestFocus` 后再 dump，A 带 `PRIMARY FOCUS`，各级祖先 scope 带 `IN FOCUS PATH`；`focusedChild` 的写入是链式的——A 只进最近一层 scope 的历史，更高层记录的是它下面那个 scope，而不是直接记录 A（`_setAsFocusedChildForScope` 的循环，`:1216`）。

**说明**：中间的 `SizedBox`、`Column` 完全不出现——它们从未 attach，焦点树天然稀疏。这个 dump 是检查"节点到底挂没挂上、挂给了谁"的第一工具。

### 实验 2：四个开关分别拦住什么

**改什么**：包住 B 的 `Focus` 分别只改一个参数——(a) `canRequestFocus: false`；(b) `skipTraversal: true`；(c) 外面再包一层 `Focus(descendantsAreFocusable: false)`；(d) `Focus(descendantsAreTraversable: false)`。每次改完做三个动作：显式 `requestFocus` B、从 A `nextFocus`、dump 树。

**预测**：(a) 显式请求被 `_doRequestFocus` 的第一道门挡住（`focus_manager.dart:1170-1175`），B 上有 `NOT FOCUSABLE` 标记，也不出现在遍历里；(b) 显式请求**成功**，B 可聚焦，但 `nextFocus` 永远跳过它（`focus_traversal.dart:437-438`）；(c) B 的 `canRequestFocus` getter 读作 false（`:536` 的祖先检查），显式与遍历都进不去；(d) B 仍可显式聚焦，但 `skipTraversal` getter 因祖先返回 true（`:489-495`），遍历跳过它。

**实际（推演）**：四个 case 的差异恰好两两成对——(a)(c) 拦显式，(b)(d) 只拦遍历；(c)(d) 是祖先版，作用整棵子树。dump 里对应能看到 `NOT FOCUSABLE` / `DESCENDANTS UNFOCUSABLE` / `DESCENDANTS UNTRAVERSABLE` 标记（`debugFillProperties`，`focus_manager.dart:1255-1298`）。

**说明**：这张对照表就是日常"为什么 Tab 到不了这个按钮 / 为什么 requestFocus 没反应"的排查地图——先分清是"不能聚焦"还是"不参与遍历"，再看开关设在自身还是祖先。

### 实验 3：自定义 policy 反转 Tab 顺序

**改什么**：写一个只覆写 `sortDescendants` 的策略（`inDirection` 由 `DirectionalFocusTraversalPolicyMixin` 提供，方向键的几何算法不在本篇展开），套在 `FocusTraversalGroup` 上：

```dart
class ReverseTraversalPolicy extends FocusTraversalPolicy
    with DirectionalFocusTraversalPolicyMixin {
  ReverseTraversalPolicy({super.requestFocusCallback});

  @override
  Iterable<FocusNode> sortDescendants(
    Iterable<FocusNode> descendants,
    FocusNode currentNode,
  ) {
    // 1. 先按默认阅读序排好（静态方法，focus_traversal.dart:1574）
    final List<FocusNode> ordered =
        ReadingOrderTraversalPolicy.sort(descendants).toList();
    // 2. 整体反转，得到稳定且确定的反向顺序
    return ordered.reversed.toList();
  }
}
```

```dart
// 3. 换掉分组的策略
FocusTraversalGroup(
  policy: ReverseTraversalPolicy(),
  child: /* A/B/C 三节点 */,
)
```

从 A 开始连续 `nextFocus`，每次记 `primaryFocus.debugLabel`。

**预测**：默认（不传 policy）顺序是 A→B→C（候选只有实验组内的三个节点，观察按钮已在组外），到 C 再 next 绕回 A（closedLoop，`focus_manager.dart:1360`）；换 `ReverseTraversalPolicy` 后 A→C→B→A——同一棵焦点树、同样的候选过滤，顺序完全由组内 policy 决定。

**实际（推演）**：两次运行唯一的差别是 `sortDescendants` 的返回序列（`focus_traversal.dart:514-519` 每组调它）。策略拿到的是过滤后的成员列表，返回什么顺序，`_moveFocus` 就按什么顺序找相邻项。

**说明**：覆写 `sortDescendants` 是定制 Tab 顺序的正规入口；基类文档（`:429-433`）提醒排序要用稳定排序（`mergeSort`），本实验用"先 ReadingOrder 再反转"回避了这个问题。需要完全手工指定顺序时，官方路径是 `OrderedTraversalPolicy`（`:1882`）配 `FocusTraversalOrder` / `NumericFocusOrder`（`:1943`、`:1787`），同样是喂给 `sortDescendants` 的另一套比较逻辑。

## 七、结论

1. **焦点是一棵并行的 `FocusNode` 树，不是 widget 的选中态**。`Focus` widget 只是适配器：`initState` 里 `attach`（`focus_scope.dart:580`）拿到 `FocusAttachment`，每次 `didChangeDependencies` / `build` 里 `reparent`（`:618`、`:713`）经 `Focus.maybeOf` 找父、`_reparent` → `_updateManager` 把 manager 引用写进子树（`focus_manager.dart:1044`、`:1034`）。不存在公开的"节点注册"API；`registerGlobalHandlers`（`:1685`）注册的是全局输入 handler，是另一件事。3.44.8 里 `FocusNode` / `FocusScopeNode` / `FocusManager` 同在 `focus_manager.dart`，也没有名为 `FocusTraversal` 的类，基类是 `FocusTraversalPolicy`（`focus_traversal.dart:185`）。
2. **焦点变更走"申请—延迟提交"两段式**。`requestFocus`（`:1153`）只标记 `_markedForFocus` 并 `scheduleMicrotask`，`applyFocusChangesIfNeeded`（`:1951`）在 microtask 里更新 `primaryFocus`、按旧/新祖先路径差集收集 `_dirtyNodes` 逐个 `_notify`，最后 `notifyListeners`。所以 `requestFocus` 后立刻读 `hasFocus` 读到的是旧值，且该流程禁止在 build 阶段执行。
3. **Tab 顺序是"分组 + 策略排序 + 过滤"的合成结果，默认的 `ReadingOrderTraversalPolicy` 不等于 widget 树序**。`nextFocus`（`:1239`）转手给所在组的 policy，`_sortAllDescendants`（`focus_traversal.dart:503`）按 `FocusTraversalGroup` 分组、组内调 `sortDescendants`（默认 `ReadingOrderTraversalPolicy` 按 `rect.top` 的水平 band 加 `Directionality` 排序，`:1636-1700`），候选过滤 `canRequestFocus && !skipTraversal`（`:437-438`），到边界按 scope 的 `traversalEdgeBehavior`（默认 closedLoop）处理。显式使用 `WidgetOrderTraversalPolicy`（`:1377`）或其他有序策略时，遍历顺序可以依赖节点/构建顺序——它的 `sortDescendants` 原样返回传入的节点序列（`:1384-1385`），树序是可选项，不是默认值。

一句话总结：**焦点系统 = 一棵由 `reparent` 在每次 build 时沿 widget/Element 上下文修补挂接的稀疏 `FocusNode` 树，加一个把所有焦点请求延迟到 microtask 统一提交的 `FocusManager`，默认 Tab 顺序则是遍历策略对过滤后的候选按屏幕几何排出的序列——树怎么挂由 widget 上下文决定，默认怎么排由几何决定。**

## 八、边界声明

- 键盘事件的完整分发（`HardwareKeyboard` / `KeyEvent` / `FocusNode.onKeyEvent` 的传播与 `KeyEventResult`）是另一条线，本篇只在两个位置碰到它：`attach` 顺带登记回调（`focus_manager.dart:1099-1113`）与 `registerGlobalHandlers`（`:1685`）挂全局 handler，到此为止。
- `FocusScope` 与 `Navigator` 的关系（每个 Route 自动创建 FocusScope、Dialog 的焦点隔离）交给第 49 篇；本篇只讲 scope 节点自身的 `focusedChild` 历史与 `traversalEdgeBehavior`，不重讲 Overlay。
- 三棵树分工、`BuildContext` 与 `RenderObjectElement` 的装配协议分别在 37/44 篇与 30/31 篇；本篇用到 `FocusNode.rect` 从 `RenderObject` 取几何（`:853`）时只引用结论。
- `WidgetsBinding` 如何在启动时构造并持有 `BuildOwner` / `FocusManager` 属于第 50 篇；本篇只需 `framework.dart:2910` 这一行装配事实。
- `FocusHighlightMode`（触摸屏不显示焦点环的那套机制，`focus_manager.dart:1546` 起）与 `DirectionalFocusTraversalPolicyMixin` 的方向键几何算法（找"哪个候选在方向上最近"）不展开；实验 3 里 mixin 只作为让子类可实例化的配件出现。
- `Semantics` 如何消费 `Focus` 的 `includeSemantics`（`focus_scope.dart:715-730`）、`TextField` / IME 与文本输入焦点的关系，本系列暂不单开一篇，需要时按 `EditableText` 内部的 `FocusNode` 用法自查。
- 本篇三个实验的"实际"列均为按本地源码推演的预期，未接模拟器运行；结论以 3.44.8 源码为准。

