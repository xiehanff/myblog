# Flutter State 详解

[toc]

本文解释 `State<T extends StatefulWidget>` 中各个成员的含义、调用时机和实际用法。内容基于 Flutter 框架中 `State` 的源码设计（本机 Flutter `3.41.9`，`packages/flutter/lib/src/widgets/framework.dart`），并与官方文档 [State class](https://api.flutter.dev/flutter/widgets/State-class.html) 对照。

## 1. State 是什么

`State` 是 `StatefulWidget` 的可变状态对象。

`StatefulWidget` 本身是不可变的，每次父组件 rebuild 时，Flutter 都可能创建一个新的 Widget 配置对象。但只要新旧 Widget 的 `runtimeType` 和 `key` 相同，Flutter 会复用原来的 `State` 对象，只更新 `State.widget` 指向的新 Widget。

核心理解：

```dart
class CounterPage extends StatefulWidget {
  const CounterPage({super.key, required this.title});

  final String title;

  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    return Text('${widget.title}: $count');
  }
}
```

`widget.title` 来自当前 Widget 配置。

`count` 存在于 `State` 中，可以在 Widget 多次 rebuild 后继续保留。

## 2. 泛型 T 的含义

源码：

```dart
abstract class State<T extends StatefulWidget> with Diagnosticable
```

`T` 表示这个 `State` 绑定的具体 `StatefulWidget` 类型。

例如：

```dart
class _CounterPageState extends State<CounterPage>
```

这里的 `T` 就是 `CounterPage`，所以在 State 内部，`widget` 的类型就是 `CounterPage`。

这样可以直接访问：

`widget.title`

而不需要手动类型转换。

## 3. widget 属性

源码：

```dart
T get widget => _widget!;
T? _widget;
```

`widget` 是当前 `State` 对应的 Widget 配置对象。

它由 Flutter 框架在调用 `initState` 前初始化。业务代码不要手动修改 `_widget`。

调用时机：

- `initState` 中可以访问 `widget`
- `build` 中可以访问 `widget`
- `didUpdateWidget` 中可以比较新旧 widget
- `dispose` 中 getter 本身仍可用（框架要到 `dispose()` 返回后才切断与 Element 的连接，`_widget` 也不会被置空），但它已经是“最后一份配置”，不建议再依赖它驱动复杂逻辑

示例：

```dart
@override
void initState() {
  super.initState();
  loadData(widget.userId);
}
```

当父组件传入新参数，并且 `runtimeType` 和 `key` 没变时：

```dart
old widget -> didUpdateWidget(oldWidget) -> new widget -> build
```

示例：

```dart
@override
void didUpdateWidget(covariant UserPage oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId == widget.userId) return;

  loadData(widget.userId);
}
```

## 4. _debugLifecycleState

源码：

```dart
_StateLifecycle _debugLifecycleState = _StateLifecycle.created;
```

这是 Flutter 在 debug 模式下使用的生命周期状态字段。

它主要用于断言，帮助开发者发现错误调用。

常见状态可以理解为（与源码 `_StateLifecycle` 枚举的文档注释一致）：

- `created`：State 已创建，`initState` 在这个阶段被调用
- `initialized`：`initState` 已返回，但还不能 build，`didChangeDependencies` 在这个阶段被调用
- `ready`：可以正常 build 和 `setState`，且 `dispose` 还没被调用
- `defunct`：已经 `dispose`，不可再使用

业务代码不能访问这个字段，它是框架内部调试用的。

典型作用：

```dart
setState() called after dispose()
```

这类报错就是 `setState` 内部对 `_debugLifecycleState` 的断言：`defunct` 阶段调用会报 `setState() called after dispose()`；`created` 阶段且尚未挂载时调用会报 `setState() called in constructor`（详见下文 `setState` 一节）。

## 5. _debugTypesAreRight

源码：

```dart
bool _debugTypesAreRight(Widget widget) => widget is T;
```

它用于 debug 模式下校验 `State` 和 `Widget` 的类型是否匹配。

例如：

```dart
class APage extends StatefulWidget {
  @override
  State<APage> createState() => _BPageState();
}

class _BPageState extends State<BPage> {
  ...
}
```

这种类型不匹配会被 Flutter 检查出来。

业务代码不需要调用它。

## 6. context 属性

源码：

```dart
BuildContext get context {
  assert(() {
    if (_element == null) {
      throw FlutterError(...);
    }
    return true;
  }());
  return _element!;
}
```

`context` 表示当前 State 在 Widget 树中的位置。

`State.context` 实际上就是内部的 `StatefulElement`。

重点：

- `context` 在 `initState` 前已经绑定
- 一个 `State` 生命周期内，`context` 对象不会变
- 但这个 `context` 所在的位置可以因为 `GlobalKey` 等机制移动
- `dispose` 后，`context` 不再可用

常见用法：

```dart
Theme.of(context);
Navigator.of(context).push(...);
MediaQuery.of(context).size;
```

注意：不要在 `initState` 中调用会建立依赖关系的方法：

```dart
Theme.of(context);
context.dependOnInheritedWidgetOfExactType();
```

更推荐放到 `didChangeDependencies` 中：

```dart
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final theme = Theme.of(context);
}
```

如果只是读取 `context` 做不依赖 InheritedWidget 的操作，通常可以在 `initState` 中使用。但很多场景仍建议延迟到首帧后执行。

```dart
@override
void initState() {
  super.initState();

  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final size = MediaQuery.of(context).size;
  });
}
```

## 7. _element

源码：

```dart
StatefulElement? _element;
```

`_element` 是框架内部把 `State` 挂载到 Element 树上的对象。

Widget、Element、State 的关系：

```text
StatefulWidget  描述 UI 配置，不可变
StatefulElement 管理 Widget 和 State 的连接
State           保存可变状态，负责 build
```

业务代码不会直接访问 `_element`。

`context` 实际就是 `_element`：

```dart
BuildContext get context => _element!;
```

`mounted` 也是根据 `_element` 判断的：

```dart
bool get mounted => _element != null;
```

## 8. mounted

源码：

```dart
bool get mounted => _element != null;
```

`mounted` 表示这个 State 是否还在 Widget 树中。

生命周期：

```text
createState
  -> mounted = true
  -> initState
  -> build
  -> ...
  -> dispose
  -> mounted = false
```

`setState` 只能在 `mounted == true` 时调用。

异步场景必须注意：

```dart
Future<void> loadData() async {
  final data = await api.getData();

  if (!mounted) return;

  setState(() {
    _data = data;
  });
}
```

更好的做法是：能取消异步任务、定时器、监听器时，在 `dispose` 中取消，而不是只依赖 `mounted`。

```dart
Timer? _timer;

@override
void initState() {
  super.initState();

  _timer = Timer.periodic(const Duration(seconds: 1), (_) {
    if (!mounted) return;

    setState(() {
      _count++;
    });
  });
}

@override
void dispose() {
  _timer?.cancel();
  super.dispose();
}
```

## 9. initState

源码：

```dart
@protected
@mustCallSuper
void initState() {
  assert(_debugLifecycleState == _StateLifecycle.created);
  ...
}
```

`initState` 在 State 第一次插入树时调用，并且只调用一次。

官方文档：[State.initState](https://api.flutter.dev/flutter/widgets/State/initState.html)。

适合做：

- 初始化本地变量
- 创建 `AnimationController`
- 创建 `TextEditingController`
- 添加监听
- 发起首次数据请求
- 根据 `widget.xxx` 初始化状态

标准写法：

```dart
@override
void initState() {
  super.initState();
  _controller = TextEditingController(text: widget.initialText);
  _controller.addListener(_onTextChanged);
}
```

不适合做：

- 调用 `dependOnInheritedWidgetOfExactType`
- 直接依赖 `Theme.of(context)`、`Localizations.of(context)` 等会注册依赖的方法
- 直接弹窗、跳转等需要首帧完成后的操作

首帧后执行：

```dart
@override
void initState() {
  super.initState();

  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    showDialog(...);
  });
}
```

`@mustCallSuper` 表示子类重写时必须调用：

```dart
super.initState();
```

## 10. didUpdateWidget

源码：

```dart
@mustCallSuper
@protected
void didUpdateWidget(covariant T oldWidget) { }
```

当父组件 rebuild，并且当前位置的新旧 Widget 可以复用同一个 State 时，Flutter 会：

```text
更新 State.widget
调用 didUpdateWidget(oldWidget)
调用 build
```

可以复用 State 的条件：

```dart
oldWidget.runtimeType == newWidget.runtimeType
oldWidget.key == newWidget.key
```

适合做：

- 比较新旧参数
- 参数变化时重新订阅对象
- 参数变化时重新请求数据
- 参数变化时启动动画

示例：参数变化重新加载数据。

```dart
@override
void didUpdateWidget(covariant UserDetailPage oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId == widget.userId) return;

  _loadUser(widget.userId);
}
```

示例：监听对象变化时重新订阅。

```dart
@override
void didUpdateWidget(covariant CounterView oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.counter == widget.counter) return;

  oldWidget.counter.removeListener(_onCounterChanged);
  widget.counter.addListener(_onCounterChanged);
}
```

注意：

`didUpdateWidget` 后一定会调用 `build`，所以通常不需要在里面调用 `setState`。

如果你只是为了让 UI 更新：

```dart
@override
void didUpdateWidget(covariant Demo oldWidget) {
  super.didUpdateWidget(oldWidget);
  setState(() {});
}
```

这通常是冗余的。

## 11. reassemble

源码：

```dart
@protected
@mustCallSuper
void reassemble() { }
```

`reassemble` 主要用于 Flutter 热重载。

Hot Reload 时框架会调用它，并保证之后会重新调用 `build`（因此大多数 widget 不需要在 `reassemble` 里做任何事，重建本身会顺带完成）。框架自带的 `Image` 就是用它实现热重载后重新加载图片的。

触发条件要明确：热重载只存在于开发期（命令行按 `r`、IDE 触发，或 VM service 发出的 reassemble 信号），release 构建不会触发 `reassemble`。所以不要把正式业务逻辑放进它。

业务中很少重写，适合少数特殊场景：

- 调试期间重置某些缓存
- 开发环境下刷新某些调试状态

示例：

```dart
@override
void reassemble() {
  super.reassemble();

  assert(() {
    _debugCache.clear();
    return true;
  }());
}
```

## 12. setState

源码核心（`framework.dart` 中 `State.setState`，省略了冗长的报错文案）：

```dart
@protected
void setState(VoidCallback fn) {
  assert(() {
    if (_debugLifecycleState == _StateLifecycle.defunct) {
      throw FlutterError(...); // setState() called after dispose()
    }
    if (_debugLifecycleState == _StateLifecycle.created && !mounted) {
      throw FlutterError(...); // setState() called in constructor
    }
    return true;
  }());
  final Object? result = fn() as dynamic;
  assert(() {
    if (result is Future) {
      throw FlutterError(...); // setState() callback argument returned a Future.
    }
    return true;
  }());
  _element!.markNeedsBuild();
}
```

`setState` 的作用是：

1. 同步执行你传入的状态修改函数
2. 通知当前 Element 需要 rebuild
3. 下一帧重新调用当前 State 的 `build`

示例：

```dart
setState(() {
  _count++;
});
```

等价理解：

```text
修改 State 中的数据
标记当前 State 对应的 Element 为 dirty
Flutter 在合适时机重新 build
```

### 12.1 setState 的检查链

debug 模式下，`setState` 在真正做事之前会依次过三道断言：

1. `_debugLifecycleState == defunct`：`dispose()` 已经执行过，抛出 `setState() called after dispose()`。
2. `_debugLifecycleState == created && !mounted`：State 还在构造期、尚未插入树，抛出 `setState() called in constructor`。此时 State 本来就默认是脏的，首次 build 必然发生，根本不需要 `setState`。
3. 回调返回值是 `Future`：说明回调被标成了 `async`，抛出 `setState() callback argument returned a Future.`。

通过之后才执行 `_element!.markNeedsBuild()`。注意这里没有显式的 `mounted` 判断：unmount 之后 debug 模式会被第 1 条拦住；release 模式没有这些断言，会直接在 `_element!` 上抛空断言错误。两种模式下“dispose 后调用 setState”都是崩溃，只是报错信息不同。

两个由此推出的细节：

- `initState` 里调用 `setState` 是合法的（此时生命周期还是 `created`，但 `mounted` 已经是 `true`，不命中第 2 条），只是完全多余。
- 异步回调里先判 `mounted` 再 `setState`，防的就是第 1 条断言在 debug 期把问题暴露出来。

官方文档：[State.setState](https://api.flutter.dev/flutter/widgets/State/setState.html)，其中 Design discussion 一节解释了为什么这个 API 从早期的 `markNeedsBuild` 改成带回调的形式。

### 12.2 setState 的 callback 不能是 async

错误写法：

```dart
setState(() async {
  _loading = true;
  await api.getData();
});
```

原因：

`setState` 要求状态修改是同步完成的。`async` 会返回 `Future`，框架无法判断状态到底什么时候改完。

正确写法：

```dart
Future<void> loadData() async {
  setState(() {
    _loading = true;
  });

  final data = await api.getData();

  if (!mounted) return;

  setState(() {
    _loading = false;
    _data = data;
  });
}
```

### 12.3 setState 中只放状态修改

不推荐：

```dart
setState(() {
  _count++;
  saveCountToDisk(_count);
});
```

推荐：

```dart
setState(() {
  _count++;
});

saveCountToDisk(_count);
```

因为 `setState` 里的代码应该尽量短，只负责改变影响 UI 的状态。

### 12.4 不要重复 setState

不推荐：

```dart
setState(() {
  _a = 1;
});

setState(() {
  _b = 2;
});
```

推荐：

```dart
setState(() {
  _a = 1;
  _b = 2;
});
```

同一个 State 在一帧内多次 `setState` 没有收益，反而增加闭包和调度成本。

### 12.5 setState 后 rebuild 的范围

`setState` 会让当前 `State` 的 `build` 重新执行。

当前 State build 出来的子树也可能跟着更新、布局、绘制。

所以应控制 State 的粒度：

```dart
class Page extends StatelessWidget {
  const Page({super.key});

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: [
        HeaderView(),
        CounterView(),
        FooterView(),
      ],
    );
  }
}

class CounterView extends StatefulWidget {
  const CounterView({super.key});

  @override
  State<CounterView> createState() => _CounterViewState();
}
```

让频繁变化的状态只影响小组件，避免整个页面反复 rebuild。

## 13. deactivate

源码：

```dart
@protected
@mustCallSuper
void deactivate() { }
```

当 State 从树中移除时，Flutter 会先调用 `deactivate`。

但此时它不一定会被永久销毁。

原因是某些场景下，State 可能被移动到树的其他位置，例如使用 `GlobalKey` 的子树迁移。

生命周期可能是：

```text
deactivate -> activate -> build
```

也可能是：

```text
deactivate -> dispose
```

适合做：

- 暂时断开和父级、祖先节点的某些连接
- 清理依赖 Element 位置的临时关系

大多数业务代码不需要重写 `deactivate`。

如果释放资源一般放到 `dispose`，不要过早放到 `deactivate`，因为 State 可能马上被重新插入。

标准写法：

```dart
@override
void deactivate() {
  // 清理和树位置相关的临时关系
  super.deactivate();
}
```

注意：Flutter 文档建议 `deactivate` 中 `super.deactivate()` 放最后。

## 14. activate

源码：

```dart
@protected
@mustCallSuper
void activate() { }
```

当一个已经 `deactivate` 的 State 被重新插入树中时调用。

常见于 `GlobalKey` 移动子树。

生命周期：

```text
deactivate -> activate -> build
```

适合做：

- 重新建立在 `deactivate` 中暂时释放的资源
- 处理 State 被移动位置后的恢复逻辑

大多数业务很少重写。

标准写法：

```dart
@override
void activate() {
  super.activate();
  // 重新建立临时连接
}
```

## 15. dispose

源码：

```dart
@protected
@mustCallSuper
void dispose() {
  assert(_debugLifecycleState == _StateLifecycle.ready);
  ...
}
```

`dispose` 表示这个 State 被永久移除，不会再 build。

调用后：

```dart
mounted == false
```

并且不能再调用：

```dart
setState(...)
```

适合释放：

- `TextEditingController`
- `ScrollController`
- `AnimationController`
- `FocusNode`
- `Timer`
- `StreamSubscription`
- `ChangeNotifier` 监听
- `EventBus` 监听
- 原生通道回调

示例：

```dart
late final TextEditingController _controller;

@override
void initState() {
  super.initState();
  _controller = TextEditingController();
}

@override
void dispose() {
  _controller.dispose();
  super.dispose();
}
```

监听器示例：

```dart
@override
void initState() {
  super.initState();
  widget.notifier.addListener(_onChanged);
}

@override
void dispose() {
  widget.notifier.removeListener(_onChanged);
  super.dispose();
}
```

注意：

`dispose` 中 `super.dispose()` 一般放最后，因为你通常要先释放自己的资源，再让父类完成销毁。

还有一个容易被忽视的边界：`dispose` 并不保证在“应用退出”时被调用。进程被系统直接回收、用户直接划掉应用时，框架没有机会执行 unmount 流程，`dispose` 不会运行。所以“必须执行的持久化”不要只寄托在 `dispose` 里，应在状态变化时就落盘；需要感知应用生命周期（包括退出消息），使用 [`AppLifecycleListener`](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html)。

## 16. build

源码：

```dart
@protected
Widget build(BuildContext context);
```

`build` 用于描述当前 State 对应的 UI。

它会在很多场景下被调用：

- `initState` 后
- `didUpdateWidget` 后
- `setState` 后
- `didChangeDependencies` 后
- `deactivate` 后又 `activate` 时
- 父组件 rebuild 时

核心规则：

`build` 必须尽量是纯函数，不要放副作用。

不推荐：

```dart
@override
Widget build(BuildContext context) {
  api.loadData();
  return const Text('data');
}
```

因为 build 可能频繁调用，这会导致重复请求。

推荐：

```dart
@override
void initState() {
  super.initState();
  _loadData();
}

@override
Widget build(BuildContext context) {
  return Text(_data?.name ?? '');
}
```

### 16.1 为什么 build 放在 State 中

Flutter 源码文档解释了一个关键原因：避免闭包捕获旧的 Widget 实例。

假设 build 在 Widget 上：

```dart
class MyButton extends StatefulWidget {
  const MyButton({super.key, required this.color});

  final Color color;

  Widget build(BuildContext context) {
    return SpecialWidget(
      handler: () {
        print(color);
      },
    );
  }
}
```

如果父组件把 `color` 从蓝色改成绿色，旧闭包可能仍然捕获旧 Widget，打印旧颜色。

Flutter 实际设计是 build 在 State 上：

```dart
class _MyButtonState extends State<MyButton> {
  @override
  Widget build(BuildContext context) {
    return SpecialWidget(
      handler: () {
        print(widget.color);
      },
    );
  }
}
```

闭包捕获的是稳定存在的 `State`，而 `State.widget` 会被框架更新为最新 Widget，所以能拿到新颜色。

## 17. didChangeDependencies

源码：

```dart
@protected
@mustCallSuper
void didChangeDependencies() { }
```

当 State 依赖的 InheritedWidget 发生变化时调用。

它也会在 `initState` 后立即调用一次。

适合做：

- 依赖 `Theme`
- 依赖 `MediaQuery`
- 依赖 `Localizations`
- 依赖 `InheritedWidget`
- 依赖 `Provider`、`InheritedModel` 等基于 InheritedWidget 的对象
- 依赖变化后触发较重的计算或请求

示例：

```dart
Locale? _locale;

@override
void didChangeDependencies() {
  super.didChangeDependencies();

  final newLocale = Localizations.localeOf(context);
  if (_locale == newLocale) return;

  _locale = newLocale;
  _loadLocalizedData(_locale!);
}
```

和 `build` 的区别：

`build` 可能非常频繁，不适合做昂贵工作。

`didChangeDependencies` 只在依赖变化时调用，更适合处理依赖变化后的业务。

## 18. debugFillProperties

源码：

```dart
@override
void debugFillProperties(DiagnosticPropertiesBuilder properties) {
  super.debugFillProperties(properties);
  ...
}
```

这是 Flutter 调试诊断系统使用的方法。

它会为 DevTools、错误日志、Widget Inspector 提供更多状态信息。

业务组件也可以重写它，帮助调试。

示例：

```dart
@override
void debugFillProperties(DiagnosticPropertiesBuilder properties) {
  super.debugFillProperties(properties);
  properties.add(IntProperty('count', _count));
  properties.add(FlagProperty(
    'loading',
    value: _loading,
    ifTrue: 'loading',
    ifFalse: 'idle',
  ));
}
```

普通业务不一定需要重写，但复杂组件库、基础 UI 组件可以使用它提升可调试性。

## 19. 完整生命周期顺序

### 19.1 首次创建

```text
StatefulWidget.createState
State 绑定 context 和 widget
initState
didChangeDependencies
build
```

### 19.2 父组件更新参数，State 被复用

```text
父组件 rebuild
创建新的 StatefulWidget
runtimeType 和 key 相同
更新 State.widget
didUpdateWidget(oldWidget)
build
```

### 19.3 当前 State 内调用 setState

```text
setState callback 同步执行
Element.markNeedsBuild
下一帧 build
```

### 19.4 依赖的 InheritedWidget 改变

```text
didChangeDependencies
build
```

### 19.5 临时移除又重新插入

```text
deactivate
activate
build
```

### 19.6 永久移除

```text
deactivate
dispose
mounted = false
```

## 20. 订阅对象的标准模式

Flutter 文档特别强调：如果 State 依赖一个会变化的对象，例如 `ChangeNotifier`、`Stream`、`AnimationController`，要在三个位置处理。

规则：

- `initState`：订阅
- `didUpdateWidget`：如果对象变化，取消旧订阅，订阅新对象
- `dispose`：取消订阅

示例：

```dart
class CounterView extends StatefulWidget {
  const CounterView({
    super.key,
    required this.counter,
  });

  final ValueNotifier<int> counter;

  @override
  State<CounterView> createState() => _CounterViewState();
}

class _CounterViewState extends State<CounterView> {
  @override
  void initState() {
    super.initState();
    widget.counter.addListener(_onCounterChanged);
  }

  @override
  void didUpdateWidget(covariant CounterView oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.counter == widget.counter) return;

    oldWidget.counter.removeListener(_onCounterChanged);
    widget.counter.addListener(_onCounterChanged);
  }

  @override
  void dispose() {
    widget.counter.removeListener(_onCounterChanged);
    super.dispose();
  }

  void _onCounterChanged() {
    if (!mounted) return;

    setState(() {
      // counter value changed
    });
  }

  @override
  Widget build(BuildContext context) {
    return Text('${widget.counter.value}');
  }
}
```

## 21. setState after dispose 的根因和修复

常见错误：

```text
setState() called after dispose()
```

原因：

State 已经从树中移除，但异步回调、定时器、动画、流订阅、网络请求回调仍然持有这个 State，并调用了 `setState`。

错误示例：

```dart
@override
void initState() {
  super.initState();

  Timer.periodic(const Duration(seconds: 1), (_) {
    setState(() {
      _count++;
    });
  });
}
```

修复：

```dart
Timer? _timer;

@override
void initState() {
  super.initState();

  _timer = Timer.periodic(const Duration(seconds: 1), (_) {
    if (!mounted) return;

    setState(() {
      _count++;
    });
  });
}

@override
void dispose() {
  _timer?.cancel();
  super.dispose();
}
```

最佳实践是取消触发源：

- Timer 要 cancel
- StreamSubscription 要 cancel
- AnimationController 要 dispose
- TextEditingController 要 dispose
- FocusNode 要 dispose
- ChangeNotifier listener 要 remove

`mounted` 是防线，不是资源管理的替代品。

## 22. context 在 initState 中的注意点

可以：

```dart
@override
void initState() {
  super.initState();
  debugPrint(context.toString());
}
```

不建议：

```dart
@override
void initState() {
  super.initState();
  final theme = Theme.of(context);
}
```

因为 `Theme.of(context)` 底层依赖 InheritedWidget，会建立依赖关系。

推荐：

```dart
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final theme = Theme.of(context);
}
```

如果需要首帧之后拿页面尺寸、弹窗、跳转：

```dart
@override
void initState() {
  super.initState();

  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    Navigator.of(context).push(...);
  });
}
```

## 23. key 对 State 复用的影响

Flutter 判断是否复用 State 的核心条件：

```dart
Widget.canUpdate(oldWidget, newWidget)
```

本质：

```dart
oldWidget.runtimeType == newWidget.runtimeType &&
oldWidget.key == newWidget.key
```

示例：

```dart
CounterView(key: ValueKey(userId))
```

当 `userId` 变化时，key 变化，旧 State 会 dispose，新 State 会创建。

这适合希望完全重置内部状态的场景。

如果不加 key，只是参数变化：

```dart
CounterView(userId: userId)
```

同类型 Widget 默认会复用 State，此时应该在 `didUpdateWidget` 中处理参数变化。

选择方式：

- 想保留内部状态：不要改 key，使用 `didUpdateWidget`
- 想完全重建状态：使用不同 key

## 24. State 和 GetX 的关系

在 Flutter 项目中，`State` 是框架级基础能力。

GetX、Provider、Riverpod、Bloc 等状态管理方案，本质上都是在不同粒度上组织状态和刷新。

对于 GetX：

```dart
GetBuilder<UserController>(
  id: 'profile',
  builder: (controller) {
    return Text(controller.userName);
  },
)
```

`GetBuilder` 内部也需要借助 Flutter 的 Element、State、rebuild 机制完成 UI 更新。

实际项目建议：

- 页面级业务状态：可以用 GetX Controller 管理
- 复杂子组件内部状态：可以用 StatefulWidget 管理
- 高频局部 UI 状态：尽量缩小 StatefulWidget 或 GetBuilder 的刷新范围
- 自研大型 UI 组件库：优先使用 Flutter 自带机制，如 `ChangeNotifier`、`ValueListenableBuilder`、`InheritedWidget`

## 25. 常见实践建议

### 25.1 StatefulWidget 中只放配置

推荐：

```dart
class UserCard extends StatefulWidget {
  const UserCard({
    super.key,
    required this.userId,
  });

  final String userId;

  @override
  State<UserCard> createState() => _UserCardState();
}
```

不要在 Widget 中放可变业务状态。

### 25.2 State 中放可变状态

```dart
class _UserCardState extends State<UserCard> {
  bool _loading = false;
  UserInfo? _userInfo;
}
```

### 25.3 build 中不做副作用

不要在 build 中：

- 发网络请求
- 写数据库
- 上报埋点
- 弹窗
- 跳转
- 创建需要 dispose 的 controller

### 25.4 controller 成对释放

```dart
late final ScrollController _scrollController;

@override
void initState() {
  super.initState();
  _scrollController = ScrollController();
}

@override
void dispose() {
  _scrollController.dispose();
  super.dispose();
}
```

### 25.5 参数变化要处理

```dart
@override
void didUpdateWidget(covariant ProductPage oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.productId == widget.productId) return;

  _reloadProduct();
}
```

### 25.6 异步回来先判断 mounted

```dart
Future<void> _load() async {
  final result = await repository.load();

  if (!mounted) return;

  setState(() {
    _result = result;
  });
}
```

### 25.7 用小组件隔离刷新范围

不推荐把所有状态都放在一个巨大页面 State 里。

推荐拆分：

```text
Page
  HeaderView
  FilterPanel
  ResultList
  BottomActionBar
```

哪个区域变化，就让哪个区域独立维护状态或独立监听 Controller。

## 26. 一个完整示例

```dart
class UserDetailPage extends StatefulWidget {
  const UserDetailPage({
    super.key,
    required this.userId,
  });

  final String userId;

  @override
  State<UserDetailPage> createState() => _UserDetailPageState();
}

class _UserDetailPageState extends State<UserDetailPage> {
  bool _loading = false;
  UserInfo? _userInfo;

  @override
  void initState() {
    super.initState();
    _loadUser();
  }

  @override
  void didUpdateWidget(covariant UserDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.userId == widget.userId) return;

    _loadUser();
  }

  Future<void> _loadUser() async {
    setState(() {
      _loading = true;
    });

    final userInfo = await UserRepository.instance.getUser(widget.userId);

    if (!mounted) return;

    setState(() {
      _loading = false;
      _userInfo = userInfo;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    final userInfo = _userInfo;
    if (userInfo == null) {
      return const Center(child: Text('暂无数据'));
    }

    return UserInfoView(userInfo: userInfo);
  }
}
```

这个示例覆盖了：

- `initState` 首次加载
- `didUpdateWidget` 响应参数变化
- `setState` 更新 UI
- 异步后检查 `mounted`
- `build` 只描述 UI
- 通过 early return 简化分支

## 27. 总结

`State` 的核心职责是保存可变状态，并通过 `build` 把状态转换成 UI。

最重要的几个点：

- `widget` 是当前 Widget 配置，父组件更新时会变化
- `context` 是当前 State 在树中的位置，dispose 后不可用
- `mounted` 判断 State 是否还在树中
- `initState` 只调用一次，适合初始化和订阅
- `didUpdateWidget` 处理父组件传参变化
- `didChangeDependencies` 处理 InheritedWidget 依赖变化
- `setState` 同步修改状态，并标记当前 State 需要 rebuild
- `deactivate` 是临时移除，`dispose` 是永久销毁
- `dispose` 必须释放 controller、listener、timer、subscription
- `build` 不应该包含副作用
- 高频变化的状态要缩小刷新范围

```text
Widget 是配置，Element 是连接，State 是状态，setState 是通知 Flutter 重新根据状态构建 UI。
```
