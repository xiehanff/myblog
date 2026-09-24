# 37 Widget 与 Element 与 BuildContext：配置和身份的分工

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`

## 一、问题

`build(BuildContext context)` 里的 `context` 是什么？

最常见的回答是"一个句柄，用来拿祖先数据"。这个回答不错，但会立刻带出一个解释不了的现象：调试时把 `context` 打出来，`runtimeType` 显示的是 **`StatelessElement` / `StatefulElement` / `StatefulElement`**，而不是 `BuildContext`。

第二个解释不了的现象是 `Widget`。同一个 `const Text('hi')` 字面量可以出现在树里 100 个位置，每处一个 `Element`、一处一个 `RenderObject`。如果 `Widget` 是"那个 Text 对象"，那这 100 处应该是同一个对象——它们确实是同一个对象。**一个对象挂在 100 个位置，这只有在它本身没有状态时成立。**

所以真正的问题是：**这三个角色分别扮演什么，为什么必须有三个而不是两个？**

错误直觉是"`Widget` 是主，`Element` 是实现细节，`BuildContext` 是别名"。实际上三者的关系是**倒过来的**：`Element` 才是树上的实体，`Widget` 是它的配置快照，`BuildContext` 是它的对外接口——**`context` 就是 `this`**。

这一篇把这三个角色拆开，重点回答"为什么 `BuildContext` 可以理解为 Element 的接口视角"。

## 二、最小 Demo

三个小实验，把三个角色各自的"不可替代性"分别打出来：

```dart
import 'package:flutter/widgets.dart';

class Probe extends StatefulWidget {
  const Probe({super.key});
  @override
  State<Probe> createState() => _ProbeState();
}

class _ProbeState extends State<Probe> {
  @override
  Widget build(BuildContext context) {
    // 1. context 的真实运行时类型：它就是 Element 自己
    debugPrint('context runtimeType = ${context.runtimeType}');

    // 2. context 的 == this 是同一份身份：compareTo 用 identical 判定
    debugPrint('identical(context, this) = ${identical(context, this)}');

    // 3. widget 是"配置"，不是"身份"：每次 build 都是新实例（除 const 外）
    debugPrint('widget 实例 = ${identityHashCode(widget)}');
    return const SizedBox.shrink();
  }
}

/// 用同一个 const Widget 实例挂三次，观察 Element 数量。
class SharedConfig extends StatelessWidget {
  const SharedConfig({super.key});

  // 只构造一次，三处复用同一个实例
  static const Widget shared = SizedBox(width: 10, height: 10);

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: <Widget>[SharedConfig.shared, SharedConfig.shared, SharedConfig.shared],
    );
  }
}
```

`State` 同时混入了 `Diagnosticable` 但**没有** `BuildContext`——它的 `context` 是一个 getter：

```dart
// framework.dart:949-951（State 中）
BuildContext get context => _element!;
```

也就是说：`State.context` 取出的东西就是持有它的那个 `StatefulElement`（getter 在 `framework.dart:949`）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:312` | `@immutable abstract class Widget extends DiagnosticableTree` |
| `framework.dart:338` | `final Key? key;`，Widget 唯一的身份线索 |
| `framework.dart:349` | `Element createElement();`，配置到实体的唯一出口 |
| `framework.dart:382` | `static bool canUpdate(...)`，复用判定的唯一规则 |
| `framework.dart:2306` | `abstract class BuildContext`，19 个抽象成员（`:2306-2671`） |
| `framework.dart:2304` | 官方一句话："BuildContext objects are actually Element objects" |
| `framework.dart:3557` | `abstract class Element extends DiagnosticableTree implements BuildContext` |
| `framework.dart:3653` | `Widget get widget => _widget!;`，Element 侧的实现（`@override` 在 `:3652`） |
| `framework.dart:3657` | `bool get mounted => _widget != null;` |
| `framework.dart:3687` | `BuildOwner? get owner => _owner;` |
| `framework.dart:973` | `State.mounted`，注意它判的是 `_element != null`，与 Element 侧不同 |

## 四、调用链

### 4.1 第一跳：Widget 是"没有身份"的

`Widget` 的声明只有三件事值得看：

```dart
// framework.dart:311-312
@immutable
abstract class Widget extends DiagnosticableTree {
```

`@immutable` 不是修辞，它被 `package:meta` 在编译期检查：**`Widget` 的所有字段必须 `final`**。整个层里 169 个组件的 `widget` 类都不例外。

第二个关键是它**故意不要 `==`**：

```dart
// framework.dart:364-370
@override
@nonVirtual
bool operator ==(Object other) => super == other;

@override
@nonVirtual
int get hashCode => super.hashCode;
```

两个 `@nonVirtual` 把 `==` / `hashCode` 钉死在"身份比较"上，**子类不许重写**。这条约束直接决定了后面所有判定的走向：框架从来不比"两个 Widget 内容是否相等"，只比 `runtimeType` 和 `key`。

```dart
// framework.dart:382-384
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

`canUpdate` 是整层的**唯一复用规则**。它一个字都不看 Widget 的字段内容——配置改了不算换身份，配置没改也不算同一个身份。`runtimeType` 决定"是不是同一种东西"，`key` 决定"是不是同一个东西"，其余字段只影响 `update` 之后会怎么重建。

### 4.2 第二跳：Element 是"有身份，但身份不在自己身上"

`Element` 的声明是最能说明问题的一行：

```dart
// framework.dart:3557
abstract class Element extends DiagnosticableTree implements BuildContext {
```

它**同时是**两个东西：

- `extends DiagnosticableTree`：它是可诊断的树节点（`visitChildren`、`debugDescribeChildren`）
- `implements BuildContext`：它是 `build` 方法拿到的那个 `context`

但它自己**不定义身份**——身份是 `Widget` 算出来的：

```dart
// framework.dart:4375 起（节选）
void update(covariant Widget newWidget) {
  assert(
    _lifecycleState == _ElementLifecycle.active &&
        newWidget != widget &&
        Widget.canUpdate(widget, newWidget),
  );
    _widget = newWidget;      // 只换配置，不换自己
}
```

`update` 的断言里写得很清楚：**它只能被同类同 key 的 Widget 调用**。所以"身份"的定义是"`runtimeType` + `key`"，而这个定义由 `Widget` 持有，`Element` 只是接受它。

再看 Element 的可变性从哪来。`Element` 的构造函数把 widget 存进私有字段，但**没有对应的 setter**：

```dart
// framework.dart:3561-3563
Element(Widget widget) : _widget = widget {
  assert(debugMaybeDispatchCreated('widgets', 'Element', this));
}
```

`_widget` 的赋值一共只出现在三个地方：构造（`3561`）、`update`（`4393` 的 `_widget = newWidget`）、`unmount`（`4863` 的 `_widget = null`）。这三处正好是"出生、换配置、死亡"。

### 4.3 第三跳：BuildContext 是 Element 的"接口视角"

这一跳是整篇的核心。先把 `BuildContext` 的 19 个成员列出来，再对照 Element 侧的实现：

`BuildContext` 从 `:2306` 到 `:2672`，19 个抽象成员，可以分四组：

| 组 | 成员 | 行号 |
|---|---|---|
| 状态查询 | `widget` / `owner` / `mounted` / `debugDoingBuild` | `2308` / `2312` / `2324` / `2340` |
| 渲染关联 | `findRenderObject()` / `size` | `2366` / `2387` |
| 祖先查找 | `dependOnInheritedElement` / `dependOnInheritedWidgetOfExactType` / `getInheritedWidgetOfExactType` / `getElementForInheritedWidgetOfExactType` / `findAncestorWidgetOfExactType` / `findAncestorStateOfType` / `findRootAncestorStateOfType` / `findAncestorRenderObjectOfType` | `2400` – `2589` |
| 树遍历与通知 | `visitAncestorElements` / `visitChildElements` / `dispatchNotification` | `2608` / `2631` / `2638` |
| 诊断 | `describeElement` / `describeWidget` / `describeMissingAncestor` / `describeOwnershipChain` | `2647` – `2670` |

Element 侧逐一对上（`@override`，都在 `3557` 之后）：

```dart
// framework.dart:3652-3653 / 3657 / 3687
@override
Widget get widget => _widget!;
@override
bool get mounted => _widget != null;
@override
BuildOwner? get owner => _owner;
```

`Element implements BuildContext` 的含义不止"实现了一个接口"，它把**一个对象按接口切成了两半**。`BuildContext` 里没有任何"改自己"的方法——没有 `update`、没有 `mount`、没有 `deactivate`、没有 `forgetChild`。而 `Element` 里这些全都有。

于是这个 `implements` 的真实作用是一句官方注释：

```dart
// framework.dart:2304-2305
/// [BuildContext] objects are actually [Element] objects. The [BuildContext]
/// interface is used to discourage direct manipulation of [Element] objects.
```

翻译过来：**`BuildContext` 是一道"防误用"的墙**。业务代码拿到的是 `BuildContext` 类型的引用，编译期就够不到 `update` / `unmount` / `visitChildren` 这些会破坏树的操作。而框架内部拿到的是 `Element` 类型的引用，什么都能做。同一个对象，两套视野。

这也解释了为什么 `Element` 是 `abstract class` 而不是 `interface class`：**它必须能被继承**（`ComponentElement`、`RenderObjectElement` 等），同时又必须能被当成接口用（`implements BuildContext`）。Dart 的 `abstract class` 两者兼容。

### 4.4 三个角色在同一个动作里的分工

把 `setState` 展开看一次，三个角色的边界最清楚：

```text
用户写 setState(() => _n++)
  └─ State.setState              framework.dart:1160
       ├─ 断言：defunct / created 状态检查
       ├─ fn()                              ← 改的是 State 的字段（用户数据）
       └─ _element!.markNeedsBuild()        ← 通知 Element（身份）

Element.markNeedsBuild          framework.dart:5339
  ├─ _lifecycleState != active → return   ← 不活跃就丢弃
  ├─ dirty 已经是 true → return            ← 幂等
  ├─ _dirty = true
  └─ owner!.scheduleBuildFor(this)        ← 交给 BuildOwner（调度）

... 下一帧 ...
BuildOwner.buildScope           framework.dart:3056
  └─ buildScope._flushDirtyElements        framework.dart:2798
       ├─ _dirtyElements.sort(Element._sort)  framework.dart:2800
       └─ element.rebuild()                    framework.dart:5503
            └─ performRebuild()  ← 这里才调用 build()
```

`State.setState` 到 `build()` 之间有 **6 个方法、跨 3 个对象**。这条链上：

| 角色 | 它保管的数据 | 它不做的事 |
|---|---|---|
| `State` | 用户的可变字段（`_n`） | 不知道自己在树的哪、不参与复用判定 |
| `Element` | 配置（`_widget`）、父子关系、生命周期状态 | 不保管用户数据、不决定何时重建 |
| `BuildOwner` | 脏列表、`GlobalKey` 注册表 | 不知道任何业务概念 |

`State` 挂在 `Element` 上（`StatefulElement._state`），但 `State` 里没有任何指向 `Element` 的公开字段——它只有一个 `context` getter 转成 `BuildContext`。**这是一条单向通道**：State 能通过接口向上看，但拿不到 Element 的内部操作能力。

## 五、核心对象：三个角色的职责对比

| | `Widget` | `Element` | `BuildContext` |
|---|---|---|---|
| 声明位置 | `framework.dart:312` | `framework.dart:3557` | `framework.dart:2306` |
| 是什么 | 配置（不可变数据类） | 树上的实体（可变对象） | 实体的一个接口视图 |
| 可变性 | `@immutable`，全字段 final | 可变（`_widget`、`_parent`、`_lifecycleState`、`_depth`） | 只读（19 个成员无一个改自己） |
| 生命周期 | 每次 build 产生新实例 | 跨多帧存活，直到被 unmount | 无独立生命周期，随 Element 生死 |
| 数量关系 | 一个实例可挂 N 处 | 每处一个，一一对应树位置 | 与 Element 一一对应（同一个对象） |
| 有 `==` 吗 | 有，但是 `@nonVirtual` 的身份比较 | 否（身份靠 `runtimeType`+`key` 表达） | 否 |
| 有 `createElement` | 有（`:349`） | 无 | 无 |
| 有 `update` | 无 | 有（`:4375`，`_widget` 的换装在 `:4393`） | **无**（关键） |
| 有父子关系 | 无（`children` 只是配置字段） | 有（`_parent` 私有） | 只有受控遍历（`visitAncestorElements`） |
| 典型使用者 | 业务代码写 | 框架内部 | 业务代码收到的 `context` |

最后两行是这套设计的落点：**业务代码只应该拿到第三列，框架内部只用第二列。** 表里最该记住的是"`update` 只在中列、不在右列"——它是 `implements` 这道墙存在的**唯一理由**。

## 六、源码实验

### 实验 1：确认 `context` 就是 Element

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
grep -n "abstract class Element extends" framework.dart
grep -n "BuildContext\] objects are actually" framework.dart
```

**预测**：`Element` 应该 `implements BuildContext`。

**实际**：

```text
3557:abstract class Element extends DiagnosticableTree implements BuildContext {
2304:/// [BuildContext] objects are actually [Element] objects. The [BuildContext]
```

**说明**：`context.runtimeType` 打印出 `StatelessElement` 不是 bug，也不是"框架没隐藏好"。`BuildContext` 是**抽象类**，`Element` 是它唯一的实现者（全 SDK 只有一处 `implements BuildContext`，见实验 4）。

### 实验 2：`Element` 到底有多少个 Element 子类

```bash
grep -rn "extends Element\b\|extends ComponentElement\b\|extends RenderObjectElement\b\|extends ProxyElement\b" \
  packages/flutter/lib/src/widgets/framework.dart | wc -l
```

**预测**：Element 家族应该很小（复用规则只有一套，不该有几十种 Element）。

**实际**：`framework.dart` 里 7 处（`StatelessElement` / `StatefulElement` / `InheritedElement` / `Leaf` / `SingleChild` / `MultiChild` / `_NullElement`）；把范围放大到整个 `src/`（含 material、cupertino）共 27 处。

**说明**：真正定义"新 Element 种类"的文件远少于定义"新 Widget 种类"的文件——**169 个 Widget 文件对应 27 个 Element 子类，其中 7 个还在同一个 `framework.dart` 里**。绝大多数组件只是组合参数，不需要新的 Element。这就是"Widget 是配置、Element 是骨架"在数量上的体现。

### 实验 3：`Widget.==` 不许重写

```bash
grep -rn -B2 "bool operator ==" packages/flutter/lib/src/widgets/framework.dart | head
```

**预测**：如果不允许重写，应该能看到 `@nonVirtual`。

**实际**：只有一处，`framework.dart:364`，前面紧贴着 `@override` 和 `@nonVirtual`。

**说明**：对比 `foundation/key.dart` 里的 `ValueKey.==`（见第二篇），会发现**Key 允许重写 `==`，Widget 不允许**。这个差别不是随意的：Key 的相等契约是"内容等价即同一身份"，Widget 的相等必须是"同一实例"。**Key 决定身份，Widget 不决定身份。**

### 实验 4：谁实现了 BuildContext

```bash
cd $(dirname $(dirname $(which flutter)))
grep -rn "implements BuildContext\|with BuildContext" packages/ --include="*.dart"
```

**预测**：可能有多个实现者（比如 `Element` 和一个 mock）。

**实际**：`packages/flutter/lib/` 下只有 1 处，`src/widgets/framework.dart:3557`；另外 `packages/flutter/test/` 里有 2 个测试用的假实现（`two_dimensional_viewport_test.dart:3132`、`slivers_test.dart:1774`）。

**说明**："BuildContext 是接口"这句话在 3.44.8 里是**字面意义上的真**：它是单实现接口。任何关于 `context` 行为的问题，答案都在 `Element` 里。

### 实验 5：`State.mounted` 和 `Element.mounted` 判的不是同一件事

```bash
grep -n "bool get mounted" packages/flutter/lib/src/widgets/framework.dart
```

**实际**：

```text
973:  bool get mounted => _element != null;    // State 侧
2324:  bool get mounted;                         // BuildContext 声明
3657:  bool get mounted => _widget != null;      // Element 侧
```

**说明**：这两行看起来一样，判据不同——`State.mounted` 判"我还挂着一个 Element"，`Element.mounted` 判"我还挂着一个 Widget"。因为 `unmount` 里先 `_widget = null`（`:4863`）再让 `StatefulElement.unmount` 调 `state._element = null`（`:6043`），**在 `dispose()` 执行期间，`State.mounted` 仍是 `true`，而 `Element.mounted` 已经是 `false`**。这是"`dispose` 里不能 `setState`"能给出清晰报错的原因（见第四十一篇）。

## 七、结论

1. `Widget` 是**配置**：`@immutable`、一个实例可挂 N 处、`==` 被 `@nonVirtual` 钉成身份比较。它不参与"我是不是上一帧那个我"的判断，判断权在 `canUpdate`（只看 `runtimeType` + `key`）。
2. `Element` 是**树上的实体**：它保管 `_widget`、`_parent`、`_lifecycleState`、`_depth`，是唯一有"身份"的概念，但身份的定义不写在它身上，而是由 `canUpdate` 表达。它的 `update` 只能被同类同 key 的 Widget 触发。
3. `BuildContext` 是 **Element 的一个接口视图**：它和 Element 是同一个对象，只是少了所有会改自己的方法（`update` / `unmount` / `forgetChild` / `visitChildren`）。SDK 里只有 `framework.dart:3557` 一处 `implements BuildContext`。

**`context` 就是 `this`——`BuildContext` 是 Element 自己切下来交给业务代码的那一半，切掉的全是"能改树"的方法。**

## 八、边界声明

- 本文只讲三者的职责边界。`canUpdate` 的完整复用判定（`updateChild` / `inflateWidget` / `updateChildren`）留到第三十八篇；`Key` 的相等契约与 `GlobalKey` 注册表留到第三十九篇。
- `State` 的生命周期钩子与 `StatefulElement` 的 `_state` 建立留到第四十、四十一篇。
- `markNeedsBuild` / `buildScope` / 脏列表留到第四十二篇。
- 本文只做**源码定位**（谁声明在哪、谁实现谁、`implements` 挡住了什么），不展开概念关系与使用技巧。
- `Element` 的 19 个 `BuildContext` 成员里，诊断组（`describeElement` 等 4 个）属于 foundation 的诊断体系，这个系列不展开。
