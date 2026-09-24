# 第二章：`covariant MyWidget oldWidget` 中的 `covariant` 详解

## 1. 问题背景

在 Flutter 里，经常看到：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.userId != widget.userId) {
    // ...
  }
}
```

其中：

```dart
covariant MyWidget oldWidget
```

意思是：

> 允许子类在重写父类方法时，把参数类型从父类声明的更宽泛类型，收窄成当前 Widget 的具体类型。

---

## 2. `didUpdateWidget` 在父类中的定义

Flutter 的 `State` 是泛型类（SDK 源码 `packages/flutter/lib/src/widgets/framework.dart`）：

```dart
abstract class State<T extends StatefulWidget> with Diagnosticable {
```

`didUpdateWidget` 在这个基类里的真实声明是：

```dart
@protected
@mustCallSuper
void didUpdateWidget(covariant T oldWidget) {}
```

注意：`covariant` 是标在**基类**的泛型参数 `T` 上的，这一点是理解后文的关键。

（[State.didUpdateWidget API 文档](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html)）

如果你的 State 是：

```dart
class _MyWidgetState extends State<MyWidget>
```

那么这里的 `T` 就是：

```dart
MyWidget
```

所以在你的子类中：

```dart
void didUpdateWidget(covariant T oldWidget)
```

就可以理解为：

```dart
void didUpdateWidget(covariant MyWidget oldWidget)
```

---

## 3. 为什么需要 `covariant`？

先看一个普通 Dart 例子。

```dart
class Animal {}

class Cat extends Animal {}

class Dog extends Animal {}
```

父类方法：

```dart
class AnimalHandler {
  void handle(Animal animal) {
    print('handle animal');
  }
}
```

如果子类想这样重写：

```dart
class CatHandler extends AnimalHandler {
  @override
  void handle(Cat cat) {
    print('handle cat');
  }
}
```

这段代码**无法通过编译**。Dart 分析器会报 `invalid_override` 错误。

Dart 的重写规则是：

> 子类重写方法时，参数类型必须与父类相同，或者是它的父类型（更宽泛），不允许收窄成子类型。

为什么禁止收窄？看父类 `AnimalHandler` 的契约：

```dart
void handle(Animal animal)
```

意思是：

```text
你给我任何 Animal，我都能处理。
```

但是子类 `CatHandler` 改成了：

```dart
void handle(Cat cat)
```

意思变成：

```text
我只能处理 Cat。
```

这就把参数范围收窄了。

例如：

```dart
AnimalHandler handler = CatHandler();

handler.handle(Dog());
```

从静态类型看，`handler` 是 `AnimalHandler`，所以传 `Dog` 好像合法。

但实际对象是 `CatHandler`，它只能处理 `Cat`。

这就会产生运行时风险。所以 Dart 干脆在编译期就禁止这种收窄。

如果你确实需要收窄，就明确写：

```dart
class CatHandler extends AnimalHandler {
  @override
  void handle(covariant Cat cat) {
    print('handle cat');
  }
}
```

含义是：

> 我知道我在子类中收窄了参数类型。我允许 Dart 在运行时帮我做类型检查。如果传进来的不是 `Cat`，就抛出类型错误。

写上 `covariant` 后，静态检查按父类声明的 `Animal` 放行，编译器会在调用点插入运行时类型检查。例如通过父类引用传入 `Dog()`，运行时会抛出：

```text
TypeError: type 'Dog' is not a subtype of type 'Cat' of 'cat'
```

（规则出处：Dart 官方类型系统文档 [covariant 关键字](https://dart.dev/language/type-system#covariant-keyword) 一节）

所以 `covariant` 的本质是：

```text
允许重写方法时收窄参数类型，并让运行时负责检查类型安全。
```

---

## 4. 为什么 Flutter 的 `didUpdateWidget` 常写 `covariant MyWidget oldWidget`？

假设你的 State 是：

```dart
class _UserPanelState extends State<UserPanel>
```

那么：

```dart
T == UserPanel
```

所以在当前 State 里：

```dart
widget
```

的类型就是：

```dart
UserPanel
```

而 `oldWidget` 也应该是：

```dart
UserPanel
```

所以可以写：

```dart
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
  void didUpdateWidget(covariant UserPanel oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (oldWidget.userId != widget.userId) {
      print('userId changed');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Text('${widget.userId}');
  }
}
```

这样就可以直接访问：

```dart
oldWidget.userId
```

而不需要强转：

```dart
(oldWidget as UserPanel).userId
```

---

## 5. 不写 `covariant` 可以吗？

很多 Flutter 代码里，你可能看到：

```dart
@override
void didUpdateWidget(UserPanel oldWidget) {
  super.didUpdateWidget(oldWidget);
}
```

也可能看到：

```dart
@override
void didUpdateWidget(covariant UserPanel oldWidget) {
  super.didUpdateWidget(oldWidget);
}
```

在日常 Flutter 开发中，更推荐保留：

```dart
@override
void didUpdateWidget(covariant UserPanel oldWidget)
```

原因有两个：

```text
1. 它和基类声明 didUpdateWidget(covariant T oldWidget) 的风格保持一致。
2. 它明确说明：oldWidget 就是当前具体 Widget 类型，这是刻意为之的类型声明。
```

---

## 6. `covariant` 在这里解决的实际问题

反过来，如果把参数类型声明得比实际可用的更宽（比如偷懒直接写 `StatefulWidget`），就只能手动强转：

```dart
@override
void didUpdateWidget(covariant StatefulWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  final old = oldWidget as UserPanel; // 参数声明太宽，想用具体字段必须强转

  if (old.userId != widget.userId) {
    // ...
  }
}
```

这样不优雅，而且需要手动强转。

有了：

```dart
@override
void didUpdateWidget(covariant UserPanel oldWidget)
```

就可以直接写：

```dart
if (oldWidget.userId != widget.userId) {
  // ...
}
```

代码更自然，类型也更明确。

---

## 7. `covariant` 和泛型 `T` 的关系

你的 State 是：

```dart
class _UserPanelState extends State<UserPanel>
```

这意味着：

```dart
T == UserPanel
```

父类方法：

```dart
void didUpdateWidget(covariant T oldWidget)
```

在你的子类中就可以理解为：

```dart
void didUpdateWidget(covariant UserPanel oldWidget)
```

这里要澄清一个容易误解的点：**让 `oldWidget` 类型变精确的，是泛型实例化本身**。`State<UserPanel>` 在继承 `didUpdateWidget` 时，参数类型就已经确定是 `UserPanel` 了，所以你重写时不写 `covariant` 也完全合法。

`covariant` 真正发挥作用的时刻在框架一侧：`StatefulElement` 内部持有 State 的静态类型是 `State<StatefulWidget>`，它调用 `didUpdateWidget` 时，传入的 oldWidget 静态类型也只是 `StatefulWidget`。正因为基类把参数声明成了 `covariant T`，这个调用才能通过编译，并且由运行时类型检查兜底，保证实际传入的是当前 State 对应的具体 Widget 类型。

还有一个语言规则值得知道：`covariant` 标在基类参数上后，这个语义会被所有子类重写**自动继承**——Dart 官方文档说明 `covariant` 可以标在父类或子类任意一侧，并且推荐标在父类。所以你在重写里写的 `covariant`，只是重复了 `State` 基类已经给出的标记，写不写行为完全一样。

---

## 8. `covariant` 的直观理解

你可以把：

```dart
void didUpdateWidget(covariant UserPanel oldWidget)
```

理解成：

```text
Flutter 框架会传给我一个 oldWidget。
我声明：这个 oldWidget 在当前 State 里应该就是 UserPanel。
如果运行时传错了类型，让 Dart 做类型检查。
```

在正常 Flutter 生命周期中，只要你的 State 声明正确：

```dart
class _UserPanelState extends State<UserPanel>
```

Flutter 不会传错类型。

所以日常开发中不用担心 `covariant` 本身带来的运行时错误。

---

## 9. `covariant` 完整示例

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
  int count = 1;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('covariant demo'),
      ),
      body: CountPanel(
        count: count,
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

class CountPanel extends StatefulWidget {
  final int count;

  const CountPanel({
    super.key,
    required this.count,
  });

  @override
  State<CountPanel> createState() => _CountPanelState();
}

class _CountPanelState extends State<CountPanel> {
  @override
  void didUpdateWidget(covariant CountPanel oldWidget) {
    super.didUpdateWidget(oldWidget);

    debugPrint(
      'old count = ${oldWidget.count}, new count = ${widget.count}',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        'count = ${widget.count}',
        style: const TextStyle(fontSize: 32),
      ),
    );
  }
}
```

点击按钮时，父组件重新构建，`CountPanel` 的新旧 `count` 发生变化，于是会打印：

```text
old count = 1, new count = 2
old count = 2, new count = 3
old count = 3, new count = 4
```

这里的：

```dart
covariant CountPanel oldWidget
```

让你可以直接访问：

```dart
oldWidget.count
```

---

## 10. `covariant` 的常见误区

### 10.1 误区一：`covariant` 是 Flutter 特有语法

不是。

`covariant` 是 Dart 语言的关键字。

Flutter 只是大量使用了它。

---

### 10.2 误区二：`covariant` 表示“协程”或“异步”

不是。

`covariant` 和：

```dart
async
await
Future
Stream
```

没有直接关系。

它是类型系统概念，中文通常翻译为：

```text
协变
```

在这里主要表示：

```text
允许子类方法参数类型更具体。
```

---

### 10.3 误区三：`covariant` 会改变 `didUpdateWidget` 的触发时机

不会。

`covariant` 只影响参数类型检查，不影响生命周期触发时机。

`didUpdateWidget` 是否触发，仍然取决于：

```dart
oldWidget.runtimeType == newWidget.runtimeType
&&
oldWidget.key == newWidget.key
```

这正是 `Widget.canUpdate` 的实现（framework.dart）：

```dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType
      && oldWidget.key == newWidget.key;
}
```

（[Widget.canUpdate API 文档](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)）

---

## 11. `covariant` 小结

```text
covariant 允许子类在重写父类方法时，把参数类型收窄成更具体的类型，并由 Dart 在运行时做必要的类型检查。
```

在 Flutter 中：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget)
```

可以理解为：

```text
oldWidget 是旧的 MyWidget 配置。
widget 是新的 MyWidget 配置。
covariant 让 oldWidget 可以直接使用 MyWidget 的字段和方法。
```

---

## 12. 和 `didUpdateWidget` 合起来理解

`didUpdateWidget` 和 `covariant` 可以分别这样理解：

```text
didUpdateWidget：
父组件重新创建了当前 Widget 的新配置，但 Flutter 复用了旧 State，于是给你一个机会比较 oldWidget 和 widget。

covariant：
允许 oldWidget 的参数类型写成当前具体 Widget 类型，方便你直接访问旧 Widget 的字段。
```

最终写法：

```dart
@override
void didUpdateWidget(covariant MyWidget oldWidget) {
  super.didUpdateWidget(oldWidget);

  if (oldWidget.value != widget.value) {
    // 响应父组件传入参数变化
  }
}
```

这就是 Flutter 中 `didUpdateWidget` 最常见、最正确、最工程化的使用方式之一。
