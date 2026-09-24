# Flutter：父组件 setState、didUpdateWidget、StatefulElement 与 State 生命周期详解

> 本文整理自一组围绕 Flutter 生命周期机制的连续讨论，重点解释：
>
> - 父组件 `setState` 后，子组件是否一定走 `didUpdateWidget`
> - `StatefulElement` 与 `State` 的真实关系
> - `Widget.canUpdate` 到底判断什么
> - 为什么非 `const StatefulWidget` 参数没变也可能触发 `didUpdateWidget`
> - 为什么说 `StatefulElement` 和 `State` 生命周期“基本一致”，但不是完全等价
>
> 这份文档适合已经写过 Flutter 页面、但希望深入理解运行时机制、Element Tree、生命周期和性能模型的开发者阅读。

---

# 一、先给总览结论

## 1. 父组件 `setState`，子组件不一定走 `didUpdateWidget`

父组件调用：

```dart
setState(() {
  count++;
});
```

只能确定一件事：

```text
当前父 State 对应的 Element 会被标记为 dirty，
然后在下一帧重新执行父组件的 build。
```

但是这不代表所有子组件都会走：

```dart
didUpdateWidget()
```

子组件是否走 `didUpdateWidget`，取决于：

```text
1. 子组件是否是 StatefulWidget
2. 父组件重新 build 后，是否生成了新的子 Widget 配置
3. 旧 Element 是否可以被新 Widget 更新
4. 旧 State 是否被复用
5. 子组件或其祖先是否被 const / cached 短路
```

---

## 2. `didUpdateWidget` 的本质

`didUpdateWidget` 不表示：

```text
父组件刷新了，所以通知子组件。
```

它真正表示的是：

```text
当前 State 没有被销毁，
当前 StatefulElement 没有被替换，
但是 State 绑定的 widget 配置对象换成了新的 Widget。
```

也就是：

```text
Element 没变
State 没变
Widget 配置对象变了
```

因此，`didUpdateWidget` 的语义是：

```text
同一个 State，接收到了新的 Widget 配置。
```

---

## 3. `StatefulElement` 与 `State` 的一句话关系

> `StatefulElement` 是运行时挂在 Element Tree 上的节点；`State` 是这个节点创建并持有的状态对象。

更具体地说：

```text
StatefulWidget
    ↓ createElement()
StatefulElement
    ↓ createState()
State
```

运行时关系可以理解为：

```text
StatefulElement 持有 State
State 持有 StatefulElement 引用
State 持有当前 Widget 配置引用
```

---

## 4. `Widget.canUpdate` 判断的不是实例相等

Flutter 判断旧 Element 能不能被新 Widget 更新，核心规则是：

```dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType
      && oldWidget.key == newWidget.key;
}
```

> 该方法的最新实现与语义说明见官方文档：[Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)。

也就是说，它判断的是：

```text
类型是否相同
key 是否相同
```

不是判断：

```text
是不是同一个 Widget 对象实例
字段值是否完全相同
```

---

# 二、父组件 setState 后，子组件一定走 didUpdateWidget 吗？

答案：**不一定。**

## 1. 父组件 setState 只保证父组件重新 build

例如：

```dart
class ParentPage extends StatefulWidget {
  const ParentPage({super.key});

  @override
  State<ParentPage> createState() => _ParentPageState();
}

class _ParentPageState extends State<ParentPage> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    debugPrint('Parent build');

    return Column(
      children: [
        Text('count = $count'),
        ElevatedButton(
          onPressed: () {
            setState(() {
              count++;
            });
          },
          child: const Text('add'),
        ),
      ],
    );
  }
}
```

点击按钮后，父组件会重新执行：

```dart
ParentState.build()
```

但是子组件是否更新，要看子组件所在的 Widget 子树是否进入了更新流程。

---

## 2. 如果子组件是 StatefulWidget，并且 type/key 相同，通常会走 didUpdateWidget

示例：

```dart
class ParentPage extends StatefulWidget {
  const ParentPage({super.key});

  @override
  State<ParentPage> createState() => _ParentPageState();
}

class _ParentPageState extends State<ParentPage> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    debugPrint('Parent build');

    return Scaffold(
      body: Column(
        children: [
          Text('Parent count: $count'),

          ChildWidget(value: count),

          ElevatedButton(
            onPressed: () {
              setState(() {
                count++;
              });
            },
            child: const Text('父组件 setState'),
          ),
        ],
      ),
    );
  }
}

class ChildWidget extends StatefulWidget {
  final int value;

  const ChildWidget({
    super.key,
    required this.value,
  });

  @override
  State<ChildWidget> createState() => _ChildWidgetState();
}

class _ChildWidgetState extends State<ChildWidget> {
  @override
  void initState() {
    super.initState();
    debugPrint('Child initState');
  }

  @override
  void didUpdateWidget(covariant ChildWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    debugPrint(
      'Child didUpdateWidget: old=${oldWidget.value}, new=${widget.value}',
    );
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('Child build');
    return Text('Child value: ${widget.value}');
  }
}
```

第一次进入页面可能输出：

```text
Parent build
Child initState
Child build
```

点击按钮后可能输出：

```text
Parent build
Child didUpdateWidget: old=0, new=1
Child build
```

原因是：

```text
旧 Widget：ChildWidget(value: 0)
新 Widget：ChildWidget(value: 1)

runtimeType 相同
key 相同，都是 null
```

所以：

```dart
Widget.canUpdate(oldWidget, newWidget) == true
```

于是复用旧的 `StatefulElement` 和旧的 `State`，调用：

```dart
didUpdateWidget(oldWidget)
```

---

## 3. 如果子组件是 StatelessWidget，不存在 didUpdateWidget

```dart
class ChildWidget extends StatelessWidget {
  final int value;

  const ChildWidget({
    super.key,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    debugPrint('Child build');
    return Text('Child value: $value');
  }
}
```

`StatelessWidget` 没有 `State`，因此也没有：

```dart
didUpdateWidget()
```

父组件重新 build 时，它可能重新 build，但不会触发 `didUpdateWidget`。

---

## 4. 如果子组件类型变了，不会走 didUpdateWidget

例如：

```dart
showA ? const ChildA() : const ChildB()
```

当 `ChildA` 切换成 `ChildB` 时：

```text
oldWidget.runtimeType != newWidget.runtimeType
```

所以：

```dart
Widget.canUpdate(oldWidget, newWidget) == false
```

结果不是 `didUpdateWidget`，而是：

```text
旧 State dispose
新 State initState
```

示例：

```dart
class ParentPage extends StatefulWidget {
  const ParentPage({super.key});

  @override
  State<ParentPage> createState() => _ParentPageState();
}

class _ParentPageState extends State<ParentPage> {
  bool showA = true;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        showA ? const ChildA() : const ChildB(),
        ElevatedButton(
          onPressed: () {
            setState(() {
              showA = !showA;
            });
          },
          child: const Text('切换子组件类型'),
        ),
      ],
    );
  }
}

class ChildA extends StatefulWidget {
  const ChildA({super.key});

  @override
  State<ChildA> createState() => _ChildAState();
}

class _ChildAState extends State<ChildA> {
  @override
  void dispose() {
    debugPrint('ChildA dispose');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const Text('ChildA');
  }
}

class ChildB extends StatefulWidget {
  const ChildB({super.key});

  @override
  State<ChildB> createState() => _ChildBState();
}

class _ChildBState extends State<ChildB> {
  @override
  void initState() {
    super.initState();
    debugPrint('ChildB initState');
  }

  @override
  Widget build(BuildContext context) {
    return const Text('ChildB');
  }
}
```

切换时输出类似：

```text
ChildB initState
ChildA dispose
```

顺序值得注意：旧 `ChildA` 被替换时立刻发生的是 `deactivate`，新 `ChildB` 随即 `initState`，而旧 `ChildA` 的 `dispose` 要等到这一帧结束时，由 `BuildOwner.finalizeTree` 统一执行。所以新组件的 `initState` 日志反而会排在旧组件的 `dispose` 之前。

---

## 5. 如果 key 变了，也不会走 didUpdateWidget

例如：

```dart
ChildWidget(
  key: ValueKey(count),
  value: count,
)
```

第一次：

```dart
ChildWidget(
  key: ValueKey(0),
  value: 0,
)
```

第二次：

```dart
ChildWidget(
  key: ValueKey(1),
  value: 1,
)
```

类型虽然相同：

```text
runtimeType 相同
```

但是 key 不同：

```text
ValueKey(0) != ValueKey(1)
```

所以：

```dart
Widget.canUpdate(oldWidget, newWidget) == false
```

结果：

```text
旧 State deactivate（帧末才 dispose）
新 State initState
```

不会走：

```dart
didUpdateWidget()
```

---

# 三、重新实例化为什么不等于 canUpdate 为 false？

这是本次讨论中最关键的点之一。

你问过：

```dart
// 注意：不是 const
ChildWidget(value: 100),
```

既然父组件重新 build 时会重新实例化 `ChildWidget(value: 100)`，为什么 `canUpdate` 不是 false？为什么还会走 `didUpdateWidget`？

答案是：

> 重新实例化不等于 `canUpdate == false`。  
> `canUpdate` 判断的不是是不是同一个对象实例，而是 type 和 key 是否相同。

---

## 1. 两个不同实例，也可以 canUpdate 为 true

父组件第一次 build：

```dart
final oldWidget = ChildWidget(value: 100);
```

父组件第二次 build：

```dart
final newWidget = ChildWidget(value: 100);
```

它们不是同一个对象：

```dart
identical(oldWidget, newWidget) == false
```

通常：

```dart
oldWidget == newWidget // false
```

但是：

```dart
oldWidget.runtimeType == newWidget.runtimeType // true
oldWidget.key == newWidget.key                 // true，都是 null
```

所以：

```dart
Widget.canUpdate(oldWidget, newWidget) == true
```

因此 Flutter 会：

```text
复用旧 StatefulElement
复用旧 State
更新 State.widget
调用 didUpdateWidget
调用 build
```

---

## 2. Flutter 为什么这样设计？

因为 Flutter 的性能模型是：

```text
Widget 可以廉价频繁创建
Element / State 尽量复用
```

父组件每次 build 重新创建 Widget 对象，这是 Flutter 的常态，不是性能问题。

Flutter 真正关心的是：

```text
这个新的 Widget 能不能更新旧的 Element？
```

如果可以更新，就复用旧 Element 和 State。

如果不可以更新，才销毁旧节点并创建新节点。

---

## 3. `didUpdateWidget` 不代表字段真的变了

例如：

```dart
ChildWidget(value: 100)
```

每次父组件 build 都重新创建一个新的 `ChildWidget`。

虽然：

```dart
oldWidget.value == widget.value // true
```

但仍然可能触发：

```dart
didUpdateWidget(oldWidget)
```

因为 Flutter 并不会自动逐字段比较：

```text
oldWidget.value == newWidget.value
oldWidget.controller == newWidget.controller
oldWidget.title == newWidget.title
```

它只判断（按顺序）：

```text
1. 新旧 Widget 是否是同一个对象实例（同一实例则直接短路，不继续更新）
2. runtimeType 和 key 是否满足 canUpdate 条件
```

所以在 `didUpdateWidget` 中应该自己做字段差异判断：

```dart
@override
void didUpdateWidget(covariant ChildWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.value != widget.value) {
    // 只有 value 真的变化时才执行同步逻辑
  }
}
```

---

# 四、为什么说“非 const StatefulWidget，参数没变，可能会走 didUpdateWidget”？

你追问了一个很细的问题：

```text
子组件是非 const StatefulWidget，参数没变，可能会。

为什么是可能？
```

答案是：

> “非 const” 并不等价于每次 build 一定产生新的 Widget 实例。  
> “参数没变” 也不等价于 Flutter 一定跳过更新。  
> 是否走 `didUpdateWidget` 取决于这次更新流程中，新旧 Widget 是否是同一对象，以及旧 Element 是否被新 Widget 更新。

---

## 1. 通常会走的情况：直接在 build 里创建

```dart
@override
Widget build(BuildContext context) {
  return Column(
    children: [
      Text('$count'),

      // 非 const，每次 build 重新创建一个新的 Widget 实例
      ChildWidget(value: 100),
    ],
  );
}
```

父组件 setState 后：

```text
oldWidget == newWidget 为 false
runtimeType 相同
key 相同
canUpdate 为 true
```

所以通常会走：

```dart
didUpdateWidget(oldWidget)
```

---

## 2. 不一定会走的情况：非 const，但被缓存了

例如：

```dart
class _ParentPageState extends State<ParentPage> {
  int count = 0;

  late final Widget child = ChildWidget(value: 100);

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text('$count'),

        // 注意：不是 const，但每次返回的是同一个 Widget 实例
        child,
      ],
    );
  }
}
```

这里的 `child` 虽然不是 `const`，但它只创建一次。

父组件每次 build 返回的都是同一个 Widget 实例。

于是：

```dart
oldWidget == newWidget // true
```

Flutter 会直接短路，不继续更新该 child。

因此不会走：

```dart
didUpdateWidget()
```

---

## 3. const 情况：通常也不会走 didUpdateWidget

例如：

```dart
const ChildWidget(value: 100)
```

如果参数都是编译期常量，Dart 可能复用同一个 canonical instance。

于是：

```dart
oldWidget == newWidget // true
```

Flutter 发现新旧 Widget 是同一个对象，就直接跳过更新。

所以通常不会走：

```dart
didUpdateWidget()
```

---

## 4. 更新子节点的简化伪代码

Flutter 更新子节点时，可以简化理解为：

```dart
Element? updateChild(
  Element? oldChild,
  Widget? newWidget,
) {
  if (newWidget == null) {
    oldChild?.deactivate();
    return null;
  }

  if (oldChild != null) {
    final oldWidget = oldChild.widget;

    // 情况一：完全同一个 Widget 对象，直接跳过
    if (oldWidget == newWidget) {
      return oldChild;
    }

    // 情况二：不是同一个对象，但 type/key 相同，复用 Element
    if (Widget.canUpdate(oldWidget, newWidget)) {
      oldChild.update(newWidget);
      return oldChild;
    }

    // 情况三：type/key 不同，销毁旧 Element
    oldChild.deactivate();
  }

  return inflateWidget(newWidget);
}
```

所以：

```text
非 const、参数没变、直接写在 build 里：
oldWidget == newWidget false
canUpdate true
通常走 didUpdateWidget

非 const、参数没变、但被缓存：
oldWidget == newWidget true
直接短路
不会走 didUpdateWidget
```

---

## 5. 对照表

| 场景 | 是否新 Widget 实例 | `oldWidget == newWidget` | `canUpdate` | 是否走 `didUpdateWidget` |
|---|---:|---:|---:|---:|
| `ChildWidget(value: 100)` 直接写在 build 里 | 是 | false | true | 通常会 |
| `const ChildWidget(value: 100)` | 通常不是 | true | 不进入判断 | 通常不会 |
| `late final child = ChildWidget(value: 100)` | 否 | true | 不进入判断 | 通常不会 |
| `ChildWidget(key: ValueKey(count), value: 100)` | 是 | false | false | 不会，销毁重建 |
| `show ? ChildWidget() : OtherWidget()` | 是 | false | false | 不会，销毁重建 |

---

# 五、StatefulElement 和 State 的关系

## 1. 基本结构

对于：

```dart
class CounterPage extends StatefulWidget {
  const CounterPage({super.key});

  @override
  State<CounterPage> createState() => _CounterPageState();
}
```

Flutter 在运行时会形成：

```text
CounterPage Widget
        ↓ createElement()
StatefulElement
        ↓ createState()
_CounterPageState
```

三者职责不同：

```text
StatefulWidget：
不可变配置对象

StatefulElement：
运行时节点，挂在 Element Tree 上

State：
可变状态对象，保存业务状态与生命周期逻辑
```

---

## 2. StatefulWidget：配置对象

`StatefulWidget` 通常只保存外部传入的配置：

```dart
class UserCard extends StatefulWidget {
  final String userId;

  const UserCard({
    super.key,
    required this.userId,
  });

  @override
  State<UserCard> createState() => _UserCardState();
}
```

`userId` 是配置。

`StatefulWidget` 本身不应该保存可变状态。

---

## 3. State：可变状态与业务逻辑

```dart
class _UserCardState extends State<UserCard> {
  bool loading = false;
  String? username;

  @override
  void initState() {
    super.initState();
    _loadUser();
  }

  Future<void> _loadUser() async {
    setState(() {
      loading = true;
    });

    // 请求数据...
  }

  @override
  Widget build(BuildContext context) {
    return Text(username ?? 'loading...');
  }
}
```

`State` 负责：

```text
保存可变状态
响应生命周期
调用 setState
管理 controller / listener / subscription
构建 UI
释放资源
```

---

## 4. StatefulElement：运行时协调者

`StatefulElement` 负责：

```text
持有 StatefulWidget
创建并持有 State
把 State 和 Element 绑定起来
调用 State.initState
调用 State.didChangeDependencies
调用 State.build
在父组件更新时调用 State.didUpdateWidget
在销毁时调用 State.dispose
调度 rebuild
维护 Element Tree 位置
维护 InheritedWidget 依赖关系
```

平时业务开发很少直接操作 `StatefulElement`，但它是 Flutter 运行时机制的核心。

---

## 5. State.context 本质是什么？

Flutter 中：

```dart
abstract class Element extends DiagnosticableTree implements BuildContext
```

所以：

```text
BuildContext 本质上就是 Element 的接口。
```

对于 `StatefulWidget` 来说：

```dart
State.context
```

本质上就是：

```text
当前 State 绑定的 StatefulElement。
```

这也是为什么：

```dart
Theme.of(context)
Navigator.of(context)
MediaQuery.of(context)
```

都依赖 `context` 所在的树位置。

`context` 不是普通上下文对象，而是当前组件在 Element Tree 中的位置句柄。

---

## 6. State.widget 本质是什么？

在 `State` 里访问：

```dart
widget.userId
```

实际上是在读取当前 `State` 绑定的最新 `StatefulWidget` 配置对象。

例如：

```dart
ChildPage(title: 'A')
```

更新成：

```dart
ChildPage(title: 'B')
```

如果 type/key 相同：

```text
StatefulElement 不变
State 不变
State.widget 从旧 Widget 更新为新 Widget
```

然后调用：

```dart
didUpdateWidget(oldWidget)
```

---

## 7. StatefulElement 和 State 是不是相互引用？

可以近似理解为是。

概念上：

```text
StatefulElement → State
State → StatefulElement
```

伪代码：

```dart
class StatefulElement extends ComponentElement {
  late State<StatefulWidget> _state;
}

abstract class State<T extends StatefulWidget> {
  StatefulElement? _element;
  T? _widget;

  T get widget => _widget!;
  BuildContext get context => _element!;
}
```

这是一组强绑定关系。

但是这种双向绑定不是内存泄漏问题，因为 Flutter 在卸载时会清理引用。

---

# 六、setState 到底作用在谁身上？

你在 `State` 里调用：

```dart
setState(() {
  count++;
});
```

表面上是修改 `State`。

本质上是：

```text
先执行状态修改函数
然后通知当前 State 绑定的 Element：
我脏了，请下一帧重新 build。
```

简化伪代码：

```dart
void setState(VoidCallback fn) {
  fn();
  _element.markNeedsBuild();
}
```

因此：

```text
State 保存业务状态
StatefulElement 负责进入 dirty 队列
BuildOwner 负责统一调度 rebuild
```

---

## 1. setState 到 build 的链路

```text
State.setState
    ↓
StatefulElement.markNeedsBuild
    ↓
BuildOwner.scheduleBuildFor
    ↓
下一帧
    ↓
BuildOwner.buildScope
    ↓
StatefulElement.performRebuild
    ↓
StatefulElement.build
    ↓
State.build(context)
    ↓
产生新的 Widget 子树
    ↓
Element.updateChild
    ↓
更新子 Element
    ↓
必要时更新 RenderObject
    ↓
layout / paint
```

所以：

```text
State 改状态
Element 管重建
Widget 描述 UI
RenderObject 负责布局绘制
```

一个版本细节：在较新的 Flutter（3.x）中，dirty 列表由 [`BuildScope`](https://api.flutter.dev/flutter/widgets/BuildScope-class.html) 管理。`BuildOwner.scheduleBuildFor` 会把 dirty Element 放进它所属 `BuildScope` 的 `_dirtyElements` 列表；`WidgetsBinding.drawFrame` 中通过 `buildOwner.buildScope(rootElement)` 统一按深度顺序（祖先在前、子孙在后）flush。绝大多数 Element 与父级共享同一个 `BuildScope`，少数特例（如 `LayoutBuilder`）会建立自己的隔离作用域，保证约束未知时不允许后代提前 rebuild。

---

# 七、StatefulElement 和 State 的生命周期是否一致？

之前说：

> 对于普通 `StatefulWidget` 来说，`StatefulElement` 和 `State` 的生命周期基本一致。

这句话要严谨理解。

---

## 1. “基本一致”是什么意思？

普通情况下，一个 `StatefulElement` 创建时，会创建并绑定一个 `State`。

```text
StatefulElement 创建
    ↓
State 创建
    ↓
State 绑定 Element
    ↓
initState
    ↓
didChangeDependencies
    ↓
build
```

组件更新时，如果 type/key 相同：

```text
StatefulElement 复用
State 复用
widget 配置更新
didUpdateWidget
build
```

组件最终移除时：

```text
Element.deactivate（StatefulElement 覆写为先调 State.deactivate）
    ↓
本帧结束时仍未被重新激活（BuildOwner.finalizeTree）
    ↓
StatefulElement.unmount（内部先完成 Element 层清理，再调用 State.dispose）
    ↓
State._element 与 Element 中的 State 引用互相解除绑定
```

所以从普通业务角度看：

```text
StatefulElement 和 State 是一组同生共死的运行时对象。
```

---

## 2. 为什么不能说“完全一致”？

因为它们不是同一个生命周期主体。

```text
StatefulElement：
Element Tree 上的运行时节点，负责树位置、active/inactive 状态、依赖、重建、挂载、卸载。

State：
业务状态对象，负责状态、生命周期回调、资源管理、build 方法。
```

二者强绑定，但语义不同。

---

# 八、不一致或容易误解的情况

这里的“不一致”不一定是说：

```text
Element 死了，State 还活着。
```

更准确地说，是：

```text
Element 的树位置生命周期、active/inactive 状态、可见性状态，比 State 暴露出来的生命周期更细。
```

---

## 1. deactivate 之后不一定 dispose

`deactivate()` 表示：

```text
当前 Element 暂时离开树上的活动位置。
```

`dispose()` 表示：

```text
State 生命周期彻底结束。
```

两者不是一回事。

普通移除：

```text
deactivate
    ↓
dispose
```

但某些情况下：

```text
deactivate
    ↓
activate
```

---

## 2. GlobalKey 移动：deactivate → activate，而不是 dispose

`GlobalKey` 可以让 Flutter 识别同一个组件从一个位置移动到另一个位置。

这时不会销毁 State，而是迁移同一个 Element/State。

示例：

```dart
class GlobalKeyMoveDemo extends StatefulWidget {
  const GlobalKeyMoveDemo({super.key});

  @override
  State<GlobalKeyMoveDemo> createState() => _GlobalKeyMoveDemoState();
}

class _GlobalKeyMoveDemoState extends State<GlobalKeyMoveDemo> {
  bool putLeft = true;

  final GlobalKey childKey = GlobalKey(debugLabel: 'movable-child');

  @override
  Widget build(BuildContext context) {
    final movableChild = MovableChild(key: childKey);

    return Scaffold(
      body: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: putLeft ? movableChild : const Text('left empty'),
              ),
              Expanded(
                child: putLeft ? const Text('right empty') : movableChild,
              ),
            ],
          ),
          ElevatedButton(
            onPressed: () {
              setState(() {
                putLeft = !putLeft;
              });
            },
            child: const Text('move child'),
          ),
        ],
      ),
    );
  }
}

class MovableChild extends StatefulWidget {
  const MovableChild({super.key});

  @override
  State<MovableChild> createState() => _MovableChildState();
}

class _MovableChildState extends State<MovableChild> {
  @override
  void initState() {
    super.initState();
    debugPrint('MovableChild initState');
  }

  @override
  void activate() {
    super.activate();
    debugPrint('MovableChild activate');
  }

  @override
  void deactivate() {
    debugPrint('MovableChild deactivate');
    super.deactivate();
  }

  @override
  void dispose() {
    debugPrint('MovableChild dispose');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('MovableChild build');
    return const Text('MovableChild');
  }
}
```

移动时可能输出：

```text
MovableChild deactivate
MovableChild activate
MovableChild build
```

不会输出：

```text
MovableChild dispose
MovableChild initState
```

说明：

```text
State 没死
Element 没死
只是 Element 从旧位置移动到了新位置
```

---

## 3. deactivate 阶段，mounted 仍然是 true

`State.mounted` 本质上可以理解为：

```dart
bool get mounted => _element != null;
```

清空 `_element` 只发生在一个地方：`StatefulElement.unmount`。而 `deactivate` 之后 `unmount` 最早也要等到本帧结束（`BuildOwner.finalizeTree`）才会执行，所以 `deactivate` 阶段 `mounted` 必然还是 true。

所以：

```dart
@override
void deactivate() {
  debugPrint('mounted in deactivate = $mounted');
  super.deactivate();
}
```

输出：

```text
mounted in deactivate = true
```

> **注意：** 这是 Flutter 的实现细节，不建议在 `deactivate` 中依赖 `mounted` 的值来判断是否可以安全使用 `context`。即使 `mounted == true`，在 `deactivate` 阶段使用 `context`（如 `Navigator.of(context)`、`Theme.of(context)` 等）也可能产生意外行为，因为 Element 已暂时脱离树。

只有 `dispose()` 之后，`mounted` 才会变成 false。

---

## 4. reassemble：Hot Reload 触发

`reassemble()` 在开发期间由 Hot Reload 触发，用于重新加载代码变更。

```text
Hot Reload
    ↓
BindingBase.reassembleApplication
    ↓
WidgetsBinding.performReassemble
    ↓
BuildOwner.reassemble(rootElement)
    ↓
Element.reassemble（自根向下递归整棵树）
    ↓
StatefulElement.reassemble → State.reassemble，随后 markNeedsBuild
```

在 `reassemble` 中可以重新绑定依赖、重置动画等：

```dart
@override
void reassemble() {
  super.reassemble();
  // 重新订阅 InheritedWidget 等
}
```

普通业务开发很少需要重写 `reassemble`，但了解它有助于理解 Hot Reload 的运行时行为。

> **注意：** `reassemble` 只在开发模式下由 Hot Reload 触发，生产环境中不会调用。

---

## 5. Offstage / IndexedStack 隐藏不等于 dispose

例如：

```dart
Offstage(
  offstage: true,
  child: ChildPage(),
)
```

或者：

```dart
IndexedStack(
  index: currentIndex,
  children: const [
    PageA(),
    PageB(),
    PageC(),
  ],
)
```

这些场景下：

```text
页面可能不可见
但 Element 仍在树上
State 仍然存在
不会 dispose
```

所以：

```text
不可见 != 生命周期结束
隐藏 != dispose
```

---

## 6. Navigator push 新页面，旧页面通常不会 dispose

例如：

```dart
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (_) => const DetailPage(),
  ),
);
```

从 `HomePage` push 到 `DetailPage` 后：

```text
HomePage 通常还在 Navigator 栈中
HomePage 的 Element 还在
HomePage 的 State 还在
HomePage 不会 dispose
```

只有当页面被 pop、replace、remove 或清栈时，对应 State 才会 dispose。

所以：

```text
页面被遮住 != 页面被销毁
不在顶层路由 != dispose
```

---

## 7. AutomaticKeepAlive 保活

在 `PageView`、`TabBarView`、`ListView` 等场景中，如果使用：

```dart
AutomaticKeepAliveClientMixin
```

子页面或列表项滑出视野后，可能不会 dispose。

示例：

```dart
class KeepAliveTabPage extends StatefulWidget {
  final String title;

  const KeepAliveTabPage({
    super.key,
    required this.title,
  });

  @override
  State<KeepAliveTabPage> createState() => _KeepAliveTabPageState();
}

class _KeepAliveTabPageState extends State<KeepAliveTabPage>
    with AutomaticKeepAliveClientMixin {
  int count = 0;

  @override
  bool get wantKeepAlive => true;

  @override
  void dispose() {
    debugPrint('${widget.title} dispose');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);

    return Center(
      child: Text('${widget.title}: $count'),
    );
  }
}
```

切换出去不一定 dispose，因为：

```text
Element 和 State 都被保活
只是当前不可见或不在当前 viewport 中
```

---

## 8. State 对象被外部引用，dispose 后内存还可能暂时存在

如果你把 State 存到全局变量中：

```dart
_MyPageState? globalState;

class MyPage extends StatefulWidget {
  const MyPage({super.key});

  @override
  State<MyPage> createState() => _MyPageState();
}

class _MyPageState extends State<MyPage> {
  @override
  void initState() {
    super.initState();
    globalState = this;
  }

  @override
  void dispose() {
    globalState = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const Text('demo');
  }
}
```

如果没有清理引用，可能出现：

```text
State 已经 dispose
mounted == false
但 Dart 对象仍被外部变量引用，暂时不能 GC
```

这不是生命周期还有效，只是内存对象尚未回收。

要区分：

```text
对象还在内存里
```

和：

```text
State 生命周期仍然有效
```

---

# 九、State 和 Element 生命周期的三个层次

很多误解来自把这三个概念混在一起。

## 1. 对象生命周期

```text
Dart 对象是否还在内存里
是否仍被引用
是否能被 GC 回收
```

---

## 2. Flutter 挂载生命周期

```text
Element 是否 active / inactive / defunct
State.mounted 是否 true
State 是否已经 dispose
```

---

## 3. 业务可见生命周期

```text
页面是否在屏幕上可见
Tab 是否当前选中
Route 是否在栈顶
ListView item 是否在 viewport 中
```

这三者不是一回事。

例如：

```text
页面不可见，但 State 可能仍然 mounted。
State dispose 后，如果被外部引用，Dart 对象仍可能暂时存在。
Element deactivate 后，State 可能还会 activate。
```

---

# 十、didUpdateWidget 应该怎么用？

## 1. 不要把 didUpdateWidget 当成“父组件刷新监听器”

错误理解：

```text
父组件 setState 了，所以子组件 didUpdateWidget 一定执行。
```

正确理解：

```text
父组件 setState 后，子 StatefulWidget 是否 didUpdateWidget，
取决于旧 Element 是否被新 Widget 更新，并且 State 是否复用。
```

---

## 2. didUpdateWidget 中必须做字段差异判断

不推荐：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  reloadData();
}
```

因为父组件重新 build，即使参数没变，也可能触发 `didUpdateWidget`。

推荐：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId != widget.userId) {
    reloadData(widget.userId);
  }
}
```

> 官方文档同样强调：`didUpdateWidget` 收到的参数是旧 widget，且框架保证它之后一定会调用 `build`，见 [State.didUpdateWidget](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html)。

---

## 3. 典型用途一：根据父组件参数变化更新内部状态

```dart
class ChildCounter extends StatefulWidget {
  final int initialValue;

  const ChildCounter({
    super.key,
    required this.initialValue,
  });

  @override
  State<ChildCounter> createState() => _ChildCounterState();
}

class _ChildCounterState extends State<ChildCounter> {
  late int localValue;

  @override
  void initState() {
    super.initState();
    localValue = widget.initialValue;
  }

  @override
  void didUpdateWidget(covariant ChildCounter oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.initialValue != widget.initialValue) {
      localValue = widget.initialValue;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Text('localValue: $localValue');
  }
}
```

注意：

```text
如果你在 initState 中读取 widget.xxx 并保存到本地变量，
后续父组件传入新值时，本地变量不会自动更新。
```

这时候就需要 `didUpdateWidget`。

---

## 4. 典型用途二：父组件传入 controller 变了，重新绑定 listener

```dart
class MyInput extends StatefulWidget {
  final TextEditingController controller;

  const MyInput({
    super.key,
    required this.controller,
  });

  @override
  State<MyInput> createState() => _MyInputState();
}

class _MyInputState extends State<MyInput> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
  }

  @override
  void didUpdateWidget(covariant MyInput oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onTextChanged);
      widget.controller.addListener(_onTextChanged);
    }
  }

  void _onTextChanged() {
    debugPrint('text changed: ${widget.controller.text}');
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: widget.controller);
  }
}
```

这是 `didUpdateWidget` 最经典的应用场景之一。

---

## 5. 典型用途三：ValueNotifier / ChangeNotifier / Stream 变了

```dart
class UserPanel extends StatefulWidget {
  final ValueNotifier<String> usernameNotifier;

  const UserPanel({
    super.key,
    required this.usernameNotifier,
  });

  @override
  State<UserPanel> createState() => _UserPanelState();
}

class _UserPanelState extends State<UserPanel> {
  late String username;

  @override
  void initState() {
    super.initState();

    username = widget.usernameNotifier.value;
    widget.usernameNotifier.addListener(_onUsernameChanged);
  }

  @override
  void didUpdateWidget(covariant UserPanel oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.usernameNotifier != widget.usernameNotifier) {
      oldWidget.usernameNotifier.removeListener(_onUsernameChanged);

      username = widget.usernameNotifier.value;
      widget.usernameNotifier.addListener(_onUsernameChanged);
    }
  }

  void _onUsernameChanged() {
    setState(() {
      username = widget.usernameNotifier.value;
    });
  }

  @override
  void dispose() {
    widget.usernameNotifier.removeListener(_onUsernameChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Text(username);
  }
}
```

这类逻辑一般遵守：

```text
initState：绑定初始对象
didUpdateWidget：对象变了就解绑旧对象、绑定新对象
dispose：释放当前对象关系
```

---

# 十一、didUpdateWidget 后是否还会 build？

对于 `StatefulWidget`，`didUpdateWidget` 调用后，通常会继续调用：

```dart
build()
```

所以在 `didUpdateWidget` 中，一般不需要再写：

```dart
setState(() {});
```

例如：

```dart
@override
void didUpdateWidget(covariant ChildWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.value != widget.value) {
    localValue = widget.value;
  }

  // 通常不需要 setState
}
```

因为后面马上会 build。

只有当你启动异步任务、动画回调、延迟回调，并且这些回调后才修改状态时，才需要考虑 `setState`。

---

# 十二、完整验证示例

下面这个示例可以验证：

```text
1. 非 const 直接创建：参数没变也可能 didUpdateWidget
2. const child：通常短路
3. cached non-const child：虽然不是 const，但也可能短路
```

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(
    home: ParentPage(),
  ));
}

class ParentPage extends StatefulWidget {
  const ParentPage({super.key});

  @override
  State<ParentPage> createState() => _ParentPageState();
}

class _ParentPageState extends State<ParentPage> {
  int count = 0;

  late final Widget cachedNonConstChild = ChildWidget(
    label: 'cached non-const child',
    value: 100,
  );

  @override
  Widget build(BuildContext context) {
    debugPrint('-------------------------');
    debugPrint('Parent build: count = $count');

    return Scaffold(
      appBar: AppBar(
        title: const Text('didUpdateWidget demo'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text('Parent count: $count'),

            const SizedBox(height: 16),

            // 情况一：非 const，每次 build 重新创建
            ChildWidget(
              label: 'new non-const child',
              value: 100,
            ),

            const SizedBox(height: 16),

            // 情况二：const，可能被 canonicalized
            const ChildWidget(
              label: 'const child',
              value: 100,
            ),

            const SizedBox(height: 16),

            // 情况三：非 const，但被手动缓存
            cachedNonConstChild,

            const SizedBox(height: 24),

            ElevatedButton(
              onPressed: () {
                setState(() {
                  count++;
                });
              },
              child: const Text('Parent setState'),
            ),
          ],
        ),
      ),
    );
  }
}

class ChildWidget extends StatefulWidget {
  final String label;
  final int value;

  const ChildWidget({
    super.key,
    required this.label,
    required this.value,
  });

  @override
  State<ChildWidget> createState() => _ChildWidgetState();
}

class _ChildWidgetState extends State<ChildWidget> {
  @override
  void initState() {
    super.initState();
    debugPrint('[${widget.label}] initState, value = ${widget.value}');
  }

  @override
  void didUpdateWidget(covariant ChildWidget oldWidget) {
    super.didUpdateWidget(oldWidget);

    debugPrint(
      '[${widget.label}] didUpdateWidget, '
      'old=${oldWidget.value}, new=${widget.value}',
    );
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('[${widget.label}] build, value = ${widget.value}');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      color: Colors.blueGrey.withValues(alpha: 0.08),
      child: Text('${widget.label}: ${widget.value}'),
    );
  }
}
```

首次进入页面，三个子组件都会初始化：

```text
Parent build: count = 0
[new non-const child] initState
[new non-const child] build
[const child] initState
[const child] build
[cached non-const child] initState
[cached non-const child] build
```

点击按钮后，通常只有第一个走：

```text
Parent build: count = 1
[new non-const child] didUpdateWidget, old=100, new=100
[new non-const child] build
```

而这两个通常不会：

```text
[const child] didUpdateWidget
[cached non-const child] didUpdateWidget
```

---

# 十三、完整生命周期对照表

| 场景 | Element 是否复用 | State 是否复用 | 是否走 didUpdateWidget | 是否 dispose |
|---|---:|---:|---:|---:|
| 父组件 setState，子组件 type/key 不变 | 是 | 是 | 是 | 否 |
| 父组件 setState，子组件 key 改变 | 否 | 否 | 否 | 旧 State dispose |
| 父组件 setState，子组件 runtimeType 改变 | 否 | 否 | 否 | 旧 State dispose |
| 非 const child 直接写在 build 中，参数没变 | 是 | 是 | 通常是 | 否 |
| const child 参数不变 | 是 | 是 | 通常否，可能短路 | 否 |
| cached non-const child | 是 | 是 | 通常否，可能短路 | 否 |
| `if(show)` 移除子组件 | 否 | 否 | 否 | 是 |
| GlobalKey 移动位置 | 是，但位置改变 | 是 | 不一定 | 否，deactivate → activate |
| Offstage 隐藏 | 是 | 是 | 不一定 | 否 |
| IndexedStack 切换 | 是 | 是 | 不一定 | 否 |
| Navigator push 新页面，旧页面被遮住 | 是 | 是 | 否 | 否 |
| Navigator pop 当前页面 | 否 | 否 | 否 | 是 |
| AutomaticKeepAlive 保活 | 是 | 是 | 不一定 | 否 |

---

# 十四、源码级心智模型

## 1. Widget Tree、Element Tree、RenderObject Tree

Flutter 有三棵关键树：

```text
Widget Tree：
描述 UI 配置，轻量、可频繁创建

Element Tree：
运行时节点树，负责生命周期、更新、依赖、调度

RenderObject Tree：
负责 layout、paint、hitTest 等渲染工作
```

对应关系：

```text
Widget Tree
    ↓ inflate / update
Element Tree
    ↓ createRenderObject / updateRenderObject
RenderObject Tree
```

对于 StatefulWidget：

```text
StatefulWidget
    ↓
StatefulElement
    ↓ 持有
State
    ↓ build 返回新的 Widget 子树
```

---

## 2. StatefulElement 的简化实现模型

以下不是完整源码，只是帮助理解：

```dart
class StatefulElement extends ComponentElement {
  StatefulElement(StatefulWidget widget) : super(widget) {
    state = widget.createState();

    state._element = this;
    state._widget = widget;
  }

  late State state;

  @override
  Widget build() {
    return state.build(this);
  }

  @override
  void update(StatefulWidget newWidget) {
    final StatefulWidget oldWidget = state.widget;

    super.update(newWidget);

    state._widget = newWidget;

    state.didUpdateWidget(oldWidget);

    // force: true 表示无论 Element 是否 dirty 都会执行 rebuild
    rebuild(force: true);
  }

  @override
  void unmount() {
    super.unmount(); // 先完成 Element 层清理
    state.dispose();
    state._element = null;
    // 真实源码还会把 Element 持有的 _state 也置 null，尽早释放引用
  }
}
```

重点是：

```text
StatefulElement 创建 State
StatefulElement 持有 State
StatefulElement 调用 State.build
StatefulElement 更新 State.widget
StatefulElement 调用 State.didUpdateWidget
StatefulElement 销毁 State
```

对照真实源码，还有两个细节值得补充。

第一，`didUpdateWidget` 并不写在 `performRebuild` 里，而是写在 `StatefulElement.update()` 中：`updateChild` 判定 `canUpdate` 成立后调用 `child.update(newWidget)`，`update()` 先把 `State._widget` 换成新 widget，再把旧 widget 作为参数调用 `state.didUpdateWidget(oldWidget)`，最后 `rebuild(force: true)` 强制重建。这就是"先 `didUpdateWidget`、后 `build`"这一顺序的来源。

第二，`StatefulElement.performRebuild()` 开头会检查 `_didChangeDependencies` 标志：当依赖的 InheritedWidget 变化时，`InheritedElement` 只调用 `Element.didChangeDependencies()`（`Element` 的默认实现是 `markNeedsBuild()`，`StatefulElement` 覆写为同时置位该标志），等真正 rebuild 时才在 `performRebuild` 里调用 `State.didChangeDependencies()`。这样可以把回调推迟到确实会重建的时候，避免通知一个已不再参与构建的 State。

---

# 十五、常见误区总结

## 误区一：StatefulWidget 本身保存状态

不严谨。

`StatefulWidget` 是配置对象，真正保存状态的是：

```dart
State
```

---

## 误区二：父组件 setState 会重新创建子 State

通常不会。

只要 type/key 相同，子 `State` 会复用。

---

## 误区三：重新实例化 Widget 就意味着 canUpdate false

错误。

`canUpdate` 判断的是：

```text
runtimeType 是否相同
key 是否相同
```

不是判断是否同一个对象实例。

---

## 误区四：didUpdateWidget 表示字段值变化

错误。

`didUpdateWidget` 表示：

```text
State 被复用，但 widget 配置对象更新了。
```

字段是否变化需要你自己判断。

---

## 误区五：build 执行就代表 State 重建

错误。

`build` 可以执行很多次，但 `State` 仍然是同一个对象。

---

## 误区六：页面不可见就等于 dispose

错误。

`Offstage`、`IndexedStack`、`Navigator.push`、`KeepAlive` 都可能让页面不可见但不销毁。

---

## 误区七：deactivate 就等于 dispose

错误。

`deactivate` 之后可能：

```text
activate
```

而不是：

```text
dispose
```

尤其是 `GlobalKey` 移动场景。

---

# 十六、实战建议

## 1. 展示型子组件优先用 StatelessWidget

如果子组件只是展示父组件传入的数据：

```dart
class UserNameText extends StatelessWidget {
  final String name;

  const UserNameText({
    super.key,
    required this.name,
  });

  @override
  Widget build(BuildContext context) {
    return Text(name);
  }
}
```

这种最简单、最稳定。

---

## 2. 只有内部有状态或资源时，才用 StatefulWidget

典型资源包括：

```text
AnimationController
TextEditingController
ScrollController
FocusNode
StreamSubscription
ValueNotifier listener
TabController
VideoPlayerController
```

这些场景要认真处理：

```text
initState
didUpdateWidget
dispose
```

---

## 3. didUpdateWidget 里不要盲目执行昂贵逻辑

不推荐：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  fetchData();
}
```

推荐：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId != widget.userId) {
    fetchData(widget.userId);
  }
}
```

---

## 4. 不要在 deactivate 里释放 controller

不推荐：

```dart
@override
void deactivate() {
  controller.dispose();
  super.deactivate();
}
```

因为 `deactivate` 后可能 `activate`。

推荐：

```dart
@override
void dispose() {
  controller.dispose();
  super.dispose();
}
```

---

## 5. 异步之后使用 context 前检查 mounted

因为 `context` 本质是 Element，异步过程中 Element 可能已经不再有效。

```dart
Future<void> loadData() async {
  await Future.delayed(const Duration(seconds: 1));

  if (!mounted) return;

  Navigator.of(context).pop();
}
```

---

# 十七、最终总结

可以用下面几句话建立完整心智模型。

```text
1. 父组件 setState 只保证父组件重新 build，不保证所有子组件都 didUpdateWidget。

2. 子 StatefulWidget 是否 didUpdateWidget，取决于旧 Element 是否被新 Widget 更新。

3. Widget.canUpdate 判断的是 runtimeType 和 key，不判断对象实例是否相同，也不判断字段值是否相同。

4. 非 const Widget 直接写在 build 里，通常每次都会创建新实例；只要 type/key 相同，就会复用 Element/State，并触发 didUpdateWidget。

5. const Widget 或手动 cached Widget 可能因为 oldWidget == newWidget 被短路，因此不走 didUpdateWidget。

6. StatefulElement 是运行时节点，State 是它持有的业务状态对象。

7. State.context 本质是 Element，State.widget 是当前最新的 Widget 配置。

8. setState 本质是让 State 绑定的 StatefulElement 标记为 dirty，等待下一帧 rebuild。

9. StatefulElement 和 State 在普通业务场景下基本同生共死，但 Element 的树位置生命周期更细，例如 deactivate 后可能 activate，GlobalKey 可移动 Element/State。

10. didUpdateWidget 是处理“State 复用但 Widget 配置变了”的地方，不是普通刷新监听器。

11. dispose 才是 State 生命周期真正结束的地方，deactivate 不是。

12. 页面不可见、被遮住、滑出 viewport，不等于 State 已销毁。
```

最终可以记成一句话：

> **Widget 是配置，Element 是运行时位置，State 是可变状态。父组件 setState 会生成新的 Widget 配置，Flutter 用 type/key 决定是否复用旧 Element 和 State；如果复用并更新了 StatefulWidget 配置，就会调用 didUpdateWidget。**
