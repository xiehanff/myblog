# 第一章：Flutter `didUpdateWidget` 的触发时机与核心用法

## 1. `didUpdateWidget` 是什么？

`didUpdateWidget` 是 Flutter 中 `State<T extends StatefulWidget>` 的一个生命周期方法。

它的核心作用是：

> 当当前 `State` 对象没有被销毁，但它对应的 `Widget` 配置对象被父组件替换成了一个新的同类型 Widget 时，Flutter 会调用 `didUpdateWidget(oldWidget)`。

换句话说：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);
}
```

表示：

> 当前 StatefulWidget 被父组件重新创建了一份新的配置对象，但 Flutter 认为它和旧 Widget 是“同一个位置上的同一个组件”，所以复用了原来的 State，并把旧 Widget 通过 `oldWidget` 传进来。

> 官方文档：[State.didUpdateWidget](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html)

---

## 2. `didUpdateWidget` 的触发条件

`didUpdateWidget` 触发的核心条件是：

```dart
oldWidget.runtimeType == newWidget.runtimeType
&&
oldWidget.key == newWidget.key
```

也就是说，Flutter 会判断新旧 Widget 是否可以复用同一个 Element 和 State。

这个判断在框架源码里就是一个静态方法 `Widget.canUpdate`（位于 `packages/flutter/lib/src/widgets/framework.dart`）：

```dart
// 1. 判断依据只有两个：runtimeType 和 key
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType
      && oldWidget.key == newWidget.key;
}
```

此外还有一个容易被忽略的前提：`canUpdate` 成立并不一定触发 `didUpdateWidget`，还要求父 rebuild 前后拿到的是**不同的 Widget 实例**。`Element.updateChild` 在真正比较类型和 key 之前，会先做一次短路判断：

```dart
// 2. 新旧 widget 是同一个实例（== 相等）时，直接复用，不走 update
if (hasSameSuperclass && child.widget == newWidget) {
  // ...直接返回旧 child，didUpdateWidget 不会被调用
}
```

典型场景是 `const` 构造：

```dart
// 父组件 build 中写 const：两次 rebuild 拿到的是同一个实例
const Badge(text: 'new')  // didUpdateWidget 不触发

// 参数是变量：每次 rebuild 都是新实例
Badge(text: label)        // 走 update，didUpdateWidget 触发
```

注意两者的区别：`const` 写法是"参数完全没变，框架连 `didUpdateWidget` 都不调用"；普通写法是"即使参数没变，只要实例是新的，`didUpdateWidget` 照样触发"。这也是后文强调要在 `didUpdateWidget` 里自己比较 `oldWidget.xxx != widget.xxx` 的原因之一。

如果满足：

```text
runtimeType 相同
key 相同
```

那么 Flutter 不会销毁旧的 State，而是复用旧 State，然后调用：

```dart
didUpdateWidget(oldWidget)
```

例如：

```dart
UserPanel(userId: 1)
```

父组件 rebuild 后变成：

```dart
UserPanel(userId: 2)
```

如果它们在 Widget 树中的位置相同，并且 key 没变，那么 `_UserPanelState` 不会销毁，而是触发：

```dart
didUpdateWidget(oldWidget)
```

---

## 3. 生命周期顺序

### 3.1 第一次创建 StatefulWidget 时

```text
createState
↓
initState
↓
didChangeDependencies
↓
build
```

注意：首次挂载走的是 `Element.mount` 路径，**不会**触发 `didUpdateWidget`。`didUpdateWidget` 只属于“更新”路径——它回答的是“配置换了怎么办”，而第一次挂载时不存在旧配置。

---

### 3.2 父组件更新当前 StatefulWidget 配置时

```text
父组件 setState / Obx / GetBuilder / Provider / Riverpod 等触发 rebuild
↓
父组件创建新的 MyWidget(...)
↓
Flutter 判断新旧 Widget 能不能复用同一个 Element
↓
如果 runtimeType 相同、key 相同
↓
复用原来的 State
↓
更新 state.widget 指向新的 widget
↓
didUpdateWidget(oldWidget)
↓
build
```

---

### 3.3 StatefulWidget 被销毁时

```text
deactivate
↓
dispose
```

---

### 3.4 特殊情况：deactivate 后又被重新插入

有一种容易混淆的情况：`StatefulWidget` 带着 `GlobalKey` 被从树上的一个位置移到另一个位置（例如切换布局、拖拽重排列表）。这时子树整体被搬走而不是销毁，流程是：

```text
旧位置 deactivate
↓
新位置 activate
↓
build
```

这个过程**不会**触发 `didUpdateWidget`。原因是 `State` 对应的 Widget 配置对象并没有被换成新的一份，走的也不是 `update` 路径——源码里 `StatefulElement.activate` 只做了 `state.activate()` 加 `markNeedsBuild()`，即“重新激活并安排一次 build”。

但如果它在移出期间依赖的 `InheritedWidget` 发生了变化，重新激活后会先触发 `didChangeDependencies`，然后才 `build`。

简单记忆：

```text
配置换了（同一个位置） → didUpdateWidget
位置换了（同一份配置） → deactivate → activate → build
```

---

## 4. `oldWidget` 和 `widget` 的区别

在 `didUpdateWidget` 中：

```dart
@override
void didUpdateWidget(covariant UserPanel oldWidget) {
  super.didUpdateWidget(oldWidget);

  print(oldWidget.userId);
  print(widget.userId);
}
```

含义是：

```dart
oldWidget
```

表示旧的 Widget 配置。

```dart
widget
```

表示新的 Widget 配置。

例如父组件从：

```dart
UserPanel(userId: 1)
```

更新成：

```dart
UserPanel(userId: 2)
```

那么在 `didUpdateWidget` 中：

```dart
oldWidget.userId == 1
widget.userId == 2
```

注意：

> 当 `didUpdateWidget` 被调用时，`State` 对象内部的 `widget` 属性已经指向新的 Widget 了。

所以我们通常会写：

```dart
@override
void didUpdateWidget(covariant UserPanel oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId != widget.userId) {
    // 外部传入的 userId 发生变化
  }
}
```

---

## 5. `didUpdateWidget` 不是什么？

`didUpdateWidget` 不是普通 rebuild 的回调。

很多人容易误以为：

> 只要当前页面 rebuild，就会触发 didUpdateWidget。

这是不准确的。

例如：

```dart
class CounterPage extends StatefulWidget {
  const CounterPage({super.key});

  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  int count = 0;

  @override
  void didUpdateWidget(covariant CounterPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    print('didUpdateWidget');
  }

  @override
  Widget build(BuildContext context) {
    print('build');

    return Scaffold(
      body: Center(
        child: Text('$count'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () {
          setState(() {
            count++;
          });
        },
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

点击按钮时，当前 State 自己调用了 `setState`。

这会触发：

```text
build
```

但不会触发：

```text
didUpdateWidget
```

原因是：

> 当前 State 自己 setState，只是当前 State 内部状态变化，并不是父组件用一个新的 Widget 配置对象更新当前 Widget。

---

## 6. 典型触发场景一：父组件传入参数发生变化

下面是一个完整示例。

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
  int userId = 1;

  @override
  Widget build(BuildContext context) {
    print('Parent build, userId = $userId');

    return Scaffold(
      appBar: AppBar(title: const Text('didUpdateWidget 示例')),
      body: UserPanel(
        userId: userId,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () {
          setState(() {
            userId++;
          });
        },
        child: const Icon(Icons.add),
      ),
    );
  }
}

class UserPanel extends StatefulWidget {
  final int userId;

  const UserPanel({
    super.key,
    required this.userId,
  });

  @override
  State<UserPanel> createState() => _UserPanelState();
}

class _UserPanelState extends State<UserPanel> {
  @override
  void initState() {
    super.initState();
    print('UserPanel initState, userId = ${widget.userId}');
  }

  @override
  void didUpdateWidget(covariant UserPanel oldWidget) {
    super.didUpdateWidget(oldWidget);

    print(
      'UserPanel didUpdateWidget: '
      'oldUserId = ${oldWidget.userId}, '
      'newUserId = ${widget.userId}',
    );
  }

  @override
  Widget build(BuildContext context) {
    print('UserPanel build, userId = ${widget.userId}');

    return Center(
      child: Text(
        '当前 userId: ${widget.userId}',
        style: const TextStyle(fontSize: 24),
      ),
    );
  }
}
```

点击按钮后，大致输出：

```text
Parent build, userId = 2
UserPanel didUpdateWidget: oldUserId = 1, newUserId = 2
UserPanel build, userId = 2
```

这里 `UserPanel` 没有被销毁。

它的 `State` 仍然是原来的 `_UserPanelState`。

只是父组件重新创建了一个新的：

```dart
UserPanel(userId: 2)
```

然后 Flutter 用这个新的 Widget 配置更新原来的 State。

---

## 7. 典型触发场景二：监听对象发生变化，需要重新订阅

这是 `didUpdateWidget` 最重要、最专业的用途之一。

如果 `build` 依赖某个自身会变化的对象，例如：

```text
ChangeNotifier
ValueNotifier
Stream
Animation
TextEditingController
FocusNode
VideoPlayerController
```

那么通常需要：

```text
initState 中订阅初始对象
didUpdateWidget 中判断对象是否变化
如果变化，取消旧订阅，订阅新对象
dispose 中取消订阅
```

示例：

```dart
import 'package:flutter/material.dart';

class UserNotifier extends ChangeNotifier {
  UserNotifier(this.name);

  String name;

  void updateName(String value) {
    name = value;
    notifyListeners();
  }
}

class UserNameView extends StatefulWidget {
  final UserNotifier notifier;

  const UserNameView({
    super.key,
    required this.notifier,
  });

  @override
  State<UserNameView> createState() => _UserNameViewState();
}

class _UserNameViewState extends State<UserNameView> {
  @override
  void initState() {
    super.initState();

    widget.notifier.addListener(_onUserChanged);
  }

  @override
  void didUpdateWidget(covariant UserNameView oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.notifier != widget.notifier) {
      oldWidget.notifier.removeListener(_onUserChanged);
      widget.notifier.addListener(_onUserChanged);
    }
  }

  @override
  void dispose() {
    widget.notifier.removeListener(_onUserChanged);
    super.dispose();
  }

  void _onUserChanged() {
    setState(() {
      // notifier 自己变化后，需要手动刷新 UI
    });
  }

  @override
  Widget build(BuildContext context) {
    return Text(widget.notifier.name);
  }
}
```

这里的关键是：

```dart
if (oldWidget.notifier != widget.notifier) {
  oldWidget.notifier.removeListener(_onUserChanged);
  widget.notifier.addListener(_onUserChanged);
}
```

如果父组件传入了一个新的 `notifier`，但你没有在 `didUpdateWidget` 中重新订阅，就会出现几个问题：

```text
1. 新对象变化，UI 不更新
2. 旧对象还被监听，可能造成错误更新
3. 旧对象无法释放，可能造成内存泄漏
```

---

## 8. 典型触发场景三：根据外部参数变化启动动画

例如一个组件接收外部传入的 `progress`：

```dart
class ProgressBar extends StatefulWidget {
  final double progress;

  const ProgressBar({
    super.key,
    required this.progress,
  });

  @override
  State<ProgressBar> createState() => _ProgressBarState();
}
```

当父组件把 `progress` 从 `0.2` 改成 `0.8` 时，希望内部动画从旧值平滑过渡到新值。

```dart
class _ProgressBarState extends State<ProgressBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late Animation<double> _animation;

  double _currentProgress = 0.0;

  @override
  void initState() {
    super.initState();

    _currentProgress = widget.progress;

    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 300),
    );

    _animation = AlwaysStoppedAnimation<double>(_currentProgress);
  }

  @override
  void didUpdateWidget(covariant ProgressBar oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.progress != widget.progress) {
      _animation = Tween<double>(
        begin: _currentProgress,
        end: widget.progress,
      ).animate(
        CurvedAnimation(
          parent: _controller,
          curve: Curves.easeOutCubic,
        ),
      );

      _controller
        ..reset()
        ..forward();

      _currentProgress = widget.progress;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final value = _animation.value;

        return LinearProgressIndicator(
          value: value,
          minHeight: 8,
        );
      },
    );
  }
}
```

这里 `didUpdateWidget` 的意义是：

```dart
if (oldWidget.progress != widget.progress)
```

检测外部传入的目标值是否变化。

如果变化，就启动内部动画。

---

## 9. `didUpdateWidget` 和 `build` 的关系

一个重要原则：

> `didUpdateWidget` 执行之后，Flutter 一定会执行 `build`。

这不是经验总结，而是框架的硬性行为。`State` 类的文档注释原话是：

> The framework always calls [build] after calling [didUpdateWidget], which means any calls to [setState] in [didUpdateWidget] are redundant.

（即：框架在调用 `didUpdateWidget` 后总会调用 `build`，因此其中任何 `setState` 都是多余的。见[官方文档](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html)。后文第 18 节会给出对应的源码依据。）

所以在 `didUpdateWidget` 中，通常不需要调用 `setState`。

例如下面这种写法通常是多余的：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.title != widget.title) {
    setState(() {
      _title = widget.title;
    });
  }
}
```

更合理的写法是：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.title != widget.title) {
    _title = widget.title;
  }
}
```

因为后面马上会执行 `build`。

但是注意：

如果你是在异步回调、监听器、定时器、动画回调中修改 State 内部状态，那么仍然需要 `setState`。

例如：

```dart
void _onChanged() {
  setState(() {
    _count++;
  });
}
```

这个和 `didUpdateWidget` 不是一回事。

---

## 10. `didUpdateWidget` 不能写成 `async`

不要这样写：

```dart
@override
Future<void> didUpdateWidget(covariant MyWidget oldWidget) async {
  super.didUpdateWidget(oldWidget);

  await loadData();
}
```

这是错误思路。

`didUpdateWidget` 应该是一个同步的 `void` 方法。

这一点也不只靠约定：框架在 debug 模式下会主动检查 `didUpdateWidget` 的返回值，如果发现它返回了 `Future`，会直接抛出 `FlutterError`，错误信息就是：

```text
State.didUpdateWidget() must be a void method without an `async` keyword.
```

正确写法：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId != widget.userId) {
    _loadUser();
  }
}

Future<void> _loadUser() async {
  final userId = widget.userId;

  final result = await fetchUser(userId);

  if (!mounted) return;

  // 防止异步回来时 userId 已经变了
  if (widget.userId != userId) return;

  setState(() {
    _user = result;
  });
}
```

这里有两个关键判断：

```dart
if (!mounted) return;
```

防止组件已经被销毁。

```dart
if (widget.userId != userId) return;
```

防止异步请求乱序。

例如：

```text
userId = 1 发起请求
↓
userId = 2 发起请求
↓
userId = 2 先返回
↓
userId = 1 后返回
```

如果不判断，旧请求可能覆盖新数据。

---

## 11. `key` 对 `didUpdateWidget` 的影响

### 11.1 没有 key：同位置、同类型，复用 State

```dart
UserPanel(userId: 1)
```

变成：

```dart
UserPanel(userId: 2)
```

由于类型一样，key 都是 `null`，Flutter 会复用原来的 State。

因此会触发：

```dart
didUpdateWidget
```

---

### 11.2 key 相同：复用 State

```dart
UserPanel(
  key: const ValueKey('user-panel'),
  userId: 1,
)
```

变成：

```dart
UserPanel(
  key: const ValueKey('user-panel'),
  userId: 2,
)
```

类型一样，key 一样。

会触发：

```dart
didUpdateWidget
```

---

### 11.3 key 不同：销毁旧 State，创建新 State

```dart
UserPanel(
  key: const ValueKey(1),
  userId: 1,
)
```

变成：

```dart
UserPanel(
  key: const ValueKey(2),
  userId: 2,
)
```

此时 key 不同，Flutter 不会认为它们是同一个组件。

生命周期会变成：

```text
旧 UserPanel deactivate
旧 UserPanel dispose
新 UserPanel createState
新 UserPanel initState
新 UserPanel didChangeDependencies
新 UserPanel build
```

不会触发旧 State 的：

```dart
didUpdateWidget
```

所以：

```text
如果希望参数变了但保留内部状态，不要随便改 key。
如果希望参数变了就重建整个 State，可以故意给不同 key。
```

---

## 12. 常见应用场景总结

### 12.1 父组件传参变化后，子组件同步内部状态

例如：

```dart
class NameEditor extends StatefulWidget {
  final String initialName;

  const NameEditor({
    super.key,
    required this.initialName,
  });

  @override
  State<NameEditor> createState() => _NameEditorState();
}
```

内部有一个 `TextEditingController`：

```dart
class _NameEditorState extends State<NameEditor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();

    _controller = TextEditingController(text: widget.initialName);
  }

  @override
  void didUpdateWidget(covariant NameEditor oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.initialName != widget.initialName) {
      _controller.text = widget.initialName;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _controller,
    );
  }
}
```

为什么不能只在 `initState` 里写？

因为 `initState` 只执行一次。

如果父组件后来传入新的 `initialName`，`initState` 不会再次执行。

所以需要在 `didUpdateWidget` 中同步。

---

### 12.2 父组件切换数据源，子组件重新加载数据

```dart
class ArticleDetail extends StatefulWidget {
  final String articleId;

  const ArticleDetail({
    super.key,
    required this.articleId,
  });

  @override
  State<ArticleDetail> createState() => _ArticleDetailState();
}
```

```dart
class _ArticleDetailState extends State<ArticleDetail> {
  bool _loading = false;
  String? _content;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _loadArticle();
  }

  @override
  void didUpdateWidget(covariant ArticleDetail oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.articleId != widget.articleId) {
      _loadArticle();
    }
  }

  Future<void> _loadArticle() async {
    final articleId = widget.articleId;

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final content = await Future<String>.delayed(
        const Duration(milliseconds: 500),
        () => '文章内容：$articleId',
      );

      if (!mounted) return;
      if (widget.articleId != articleId) return;

      setState(() {
        _content = content;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      if (widget.articleId != articleId) return;

      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(child: Text('加载失败：$_error'));
    }

    return Center(
      child: Text(_content ?? '暂无内容'),
    );
  }
}
```

这种模式在以下场景中非常常见：

```text
视频详情页
文章详情页
用户详情页
商品详情页
播放器资源切换
评论列表切换
分页 query 切换
```

---

### 12.3 父组件传入 Stream 变化，重新监听

```dart
import 'dart:async';
import 'package:flutter/material.dart';

class MessageView extends StatefulWidget {
  final Stream<String> stream;

  const MessageView({
    super.key,
    required this.stream,
  });

  @override
  State<MessageView> createState() => _MessageViewState();
}

class _MessageViewState extends State<MessageView> {
  StreamSubscription<String>? _subscription;
  String _latestMessage = '';

  @override
  void initState() {
    super.initState();
    _subscribe(widget.stream);
  }

  @override
  void didUpdateWidget(covariant MessageView oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.stream != widget.stream) {
      _subscription?.cancel();
      _subscribe(widget.stream);
    }
  }

  void _subscribe(Stream<String> stream) {
    _subscription = stream.listen((message) {
      if (!mounted) return;

      setState(() {
        _latestMessage = message;
      });
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Text(_latestMessage);
  }
}
```

标准模式：

```text
initState：订阅初始对象
didUpdateWidget：如果对象换了，取消旧订阅，订阅新对象
dispose：取消订阅
```

---

## 13. `didUpdateWidget` 和 `didChangeDependencies` 的区别

这两个方法经常被混淆。

### 13.1 `didUpdateWidget`

关注的是：

```text
父组件传给当前 Widget 的配置参数变了
```

例如：

```dart
UserPanel(userId: 1)
```

变成：

```dart
UserPanel(userId: 2)
```

---

### 13.2 `didChangeDependencies`

关注的是：

```text
当前 State 依赖的 InheritedWidget 变了
```

例如：

```dart
Theme.of(context)
MediaQuery.of(context)
Localizations.of(context)
DefaultTextStyle.of(context)
Provider.of<T>(context)
```

如果这些依赖变化，可能会触发：

```dart
didChangeDependencies
```

例如：

```text
系统字体大小变化
主题变化
语言变化
上层 Provider 变化
MediaQuery 变化
```

---

### 13.3 对比表

| 方法 | 触发原因 | 常见用途 |
|---|---|---|
| `initState` | State 第一次创建 | 初始化 Controller、订阅初始数据源 |
| `didChangeDependencies` | 依赖的 InheritedWidget 变化 | 读取 `Theme`、`MediaQuery`、`Provider` 等上下文依赖 |
| `didUpdateWidget` | 父组件传入了新的 Widget 配置，但 State 被复用 | 对比新旧参数，更新订阅、动画、Controller、数据请求 |
| `build` | UI 需要重新构建 | 根据当前状态描述 UI |
| `dispose` | State 被销毁 | 释放 Controller、取消订阅、关闭 Timer |

---

## 14. 和 GetX 场景结合理解

假设你有：

```dart
class VideoPage extends StatefulWidget {
  final String videoId;

  const VideoPage({
    super.key,
    required this.videoId,
  });

  @override
  State<VideoPage> createState() => _VideoPageState();
}
```

如果你是重新 push 一个新页面：

```dart
Get.to(() => VideoPage(videoId: '2'));
```

这通常是一个新的 route、新的页面实例、新的 State。

它不一定触发旧页面的：

```dart
didUpdateWidget
```

但是，如果你是在同一个页面位置切换参数，例如：

```dart
Obx(() {
  return VideoPage(
    videoId: controller.currentVideoId.value,
  );
})
```

当：

```dart
controller.currentVideoId.value = '2';
```

父级 `Obx` rebuild，重新创建：

```dart
VideoPage(videoId: '2')
```

如果类型和 key 没变，那么旧的 `_VideoPageState` 会被复用，于是触发：

```dart
didUpdateWidget
```

此时可以写：

```dart
@override
void didUpdateWidget(covariant VideoPage oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.videoId != widget.videoId) {
    _switchVideo(widget.videoId);
  }
}
```

---

## 15. 常见错误写法

### 15.1 错误一：在 `initState` 里读取 widget 参数后，再也不更新

错误写法：

```dart
class _UserPageState extends State<UserPage> {
  late int _userId;

  @override
  void initState() {
    super.initState();
    _userId = widget.userId;
  }

  @override
  Widget build(BuildContext context) {
    return Text('$_userId');
  }
}
```

如果父组件传入新的：

```dart
UserPage(userId: 2)
```

`_userId` 不会自动变。

可以补上：

```dart
@override
void didUpdateWidget(covariant UserPage oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId != widget.userId) {
    _userId = widget.userId;
  }
}
```

但如果 `_userId` 没有独立存在的必要，更推荐直接使用：

```dart
Text('${widget.userId}')
```

不要额外复制一份状态。

---

### 15.2 错误二：无脑在 `didUpdateWidget` 里调用 `setState`

错误写法：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  setState(() {
    _title = widget.title;
  });
}
```

通常没必要。

更推荐：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.title != widget.title) {
    _title = widget.title;
  }
}
```

因为 `didUpdateWidget` 后面一定会执行 `build`。

---

### 15.3 错误三：没有判断新旧值是否变化

错误写法：

```dart
@override
void didUpdateWidget(covariant ArticlePage oldWidget) {
  super.didUpdateWidget(oldWidget);

  _loadArticle();
}
```

这会导致父组件任何 rebuild 都重新请求。

正确写法：

```dart
@override
void didUpdateWidget(covariant ArticlePage oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.articleId != widget.articleId) {
    _loadArticle();
  }
}
```

---

### 15.4 错误四：忘记取消旧监听

错误写法：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.notifier != widget.notifier) {
    widget.notifier.addListener(_listener);
  }
}
```

这样旧的 notifier 还在监听。

正确写法：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.notifier != widget.notifier) {
    oldWidget.notifier.removeListener(_listener);
    widget.notifier.addListener(_listener);
  }
}
```

---

## 16. 完整可运行示例：切换用户并重新加载详情

下面这段可以直接复制到 `main.dart` 运行。

```dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MaterialApp(
    debugShowCheckedModeBanner: false,
    home: UserHostPage(),
  ));
}

class UserHostPage extends StatefulWidget {
  const UserHostPage({super.key});

  @override
  State<UserHostPage> createState() => _UserHostPageState();
}

class _UserHostPageState extends State<UserHostPage> {
  int _userId = 1;

  @override
  Widget build(BuildContext context) {
    debugPrint('Host build, userId = $_userId');

    return Scaffold(
      appBar: AppBar(
        title: const Text('didUpdateWidget Demo'),
      ),
      body: UserDetailPanel(
        userId: _userId,
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () {
          setState(() {
            _userId++;
          });
        },
        label: const Text('切换用户'),
        icon: const Icon(Icons.swap_horiz),
      ),
    );
  }
}

class UserDetailPanel extends StatefulWidget {
  final int userId;

  const UserDetailPanel({
    super.key,
    required this.userId,
  });

  @override
  State<UserDetailPanel> createState() => _UserDetailPanelState();
}

class _UserDetailPanelState extends State<UserDetailPanel> {
  bool _loading = false;
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();

    debugPrint('UserDetailPanel initState, userId = ${widget.userId}');
    _loadUser();
  }

  @override
  void didUpdateWidget(covariant UserDetailPanel oldWidget) {
    super.didUpdateWidget(oldWidget);

    debugPrint(
      'UserDetailPanel didUpdateWidget, '
      'old = ${oldWidget.userId}, new = ${widget.userId}',
    );

    if (oldWidget.userId != widget.userId) {
      _loadUser();
    }
  }

  Future<void> _loadUser() async {
    final int requestUserId = widget.userId;

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final String result = await FakeUserApi.fetchUserName(requestUserId);

      if (!mounted) return;

      if (widget.userId != requestUserId) {
        debugPrint(
          '丢弃过期请求: requestUserId = $requestUserId, '
          'currentUserId = ${widget.userId}',
        );
        return;
      }

      setState(() {
        _name = result;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;

      if (widget.userId != requestUserId) {
        return;
      }

      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('UserDetailPanel build, userId = ${widget.userId}');

    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(),
      );
    }

    if (_error != null) {
      return Center(
        child: Text('加载失败：$_error'),
      );
    }

    return Center(
      child: Text(
        'userId = ${widget.userId}\nname = ${_name ?? '-'}',
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 24),
      ),
    );
  }
}

class FakeUserApi {
  static Future<String> fetchUserName(int userId) async {
    await Future<void>.delayed(const Duration(milliseconds: 600));
    return '用户 $userId';
  }
}
```

点击按钮后，控制台大致输出：

```text
UserDetailPanel initState, userId = 1
UserDetailPanel build, userId = 1

点击切换用户

Host build, userId = 2
UserDetailPanel didUpdateWidget, old = 1, new = 2
UserDetailPanel build, userId = 2
```

---

## 17. 什么时候应该使用 `didUpdateWidget`？

### 17.1 应该使用的场景

#### 1. 父组件传入参数变化，当前 State 需要响应

例如：

```dart
oldWidget.videoId != widget.videoId
oldWidget.userId != widget.userId
oldWidget.initialValue != widget.initialValue
```

#### 2. 父组件传入的依赖对象变化，需要重新订阅

例如：

```text
ChangeNotifier
Stream
ValueNotifier
Animation
TextEditingController
FocusNode
TabController
VideoPlayerController
```

#### 3. 外部配置变化，需要更新内部资源

例如：

```text
图片 URL 变化
视频 URL 变化
播放器配置变化
主题配置变化
动画目标值变化
分页 query 变化
```

---

### 17.2 不应该使用的场景

#### 1. 普通 UI rebuild

普通 rebuild 直接写在 `build` 里。

#### 2. 初始化逻辑

初始化逻辑放在：

```dart
initState
```

#### 3. 依赖 `InheritedWidget` 的变化

例如：

```dart
Theme.of(context)
MediaQuery.of(context)
Provider.of(context)
```

更适合放在：

```dart
didChangeDependencies
```

或者直接在：

```dart
build
```

中处理。

#### 4. 无脑同步所有字段

如果一个值可以直接从 `widget.xxx` 读取，就不要复制到 `_xxx`。

不推荐：

```dart
late String _title;

@override
void initState() {
  super.initState();
  _title = widget.title;
}

@override
Widget build(BuildContext context) {
  return Text(_title);
}
```

推荐：

```dart
@override
Widget build(BuildContext context) {
  return Text(widget.title);
}
```

只有当你需要“内部可变副本”时，才复制。

例如：

```dart
TextEditingController(text: widget.initialValue)
```

这种场景才需要配合 `didUpdateWidget`。

---

## 18. `didUpdateWidget` 与 Element 更新机制

可以这样理解 Flutter 的三层结构：

```text
Widget 是配置
Element 是树上的节点
State 是状态对象
```

当父组件 rebuild 时，Flutter 会生成一棵新的 Widget 树。

然后 Flutter 会拿新 Widget 和旧 Element 当前持有的旧 Widget 做匹配。

如果满足：

```dart
oldWidget.runtimeType == newWidget.runtimeType
&&
oldWidget.key == newWidget.key
```

那么旧 Element 不销毁，旧 State 也不销毁。

更新过程可以理解为：

```text
Element.update(newWidget)
↓
State.widget = newWidget
↓
State.didUpdateWidget(oldWidget)
↓
State.build()
```

这不是类比，就是 `StatefulElement.update` 的真实执行顺序（`packages/flutter/lib/src/widgets/framework.dart`，省略了断言和 debug 检查）：

```dart
@override
void update(StatefulWidget newWidget) {
  super.update(newWidget);                  // 1. Element 换上新 widget
  final StatefulWidget oldWidget = state._widget!;
  state._widget = widget as StatefulWidget; // 2. State.widget 指向新 widget
  state.didUpdateWidget(oldWidget);         // 3. 把旧 widget 交给开发者处理
  rebuild(force: true);                     // 4. 强制重新 build
}
```

最后一行的 `rebuild(force: true)` 正是“`didUpdateWidget` 之后必然执行 `build`、无需手动 `setState`”的源码依据。

---

## 19. 最终记忆版

### 19.1 `didUpdateWidget` 一句话总结

```text
当 StatefulWidget 的配置被父组件换成了一个新的配置，但 Flutter 仍然复用原来的 State 时，didUpdateWidget 会被调用。
```

### 19.2 `didUpdateWidget` 标准写法

```dart
@override
void didUpdateWidget(covariant XxxWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.someValue != widget.someValue) {
    // 处理外部参数变化
  }
}
```

### 19.3 生命周期记忆

```text
initState：处理第一次进入
didUpdateWidget：处理父组件传入配置变化
didChangeDependencies：处理上下文依赖变化
dispose：处理资源释放
build：根据当前状态生成 UI
```

### 19.4 订阅类对象的标准模式

```dart
@override
void initState() {
  super.initState();
  _subscribe(widget.source);
}

@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.source != widget.source) {
    _unsubscribe(oldWidget.source);
    _subscribe(widget.source);
  }
}

@override
void dispose() {
  _unsubscribe(widget.source);
  super.dispose();
}
```
