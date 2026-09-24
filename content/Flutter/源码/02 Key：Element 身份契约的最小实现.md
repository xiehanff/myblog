# 02 Key：Element 身份契约的最小实现

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/foundation/key.dart`（全文 117 行）

## 一、问题

`Key` 是全框架最小的类之一：117 行的文件里有一个抽象类、三个实现类，没有任何一个方法涉及"比较两个 Widget"或"查找 Element"。

那它凭什么能决定"列表交换顺序后 State 会不会错位"？

错误直觉是：**`Key` 是一种给框架看的"标签"，框架靠它找到对应的 Widget。**

不是。`Key` 只做一件事——**提供 `==` 和 `hashCode`**。至于谁来比、在什么时候比、比出来不一样会怎样，全部发生在别的文件里（`widgets/framework.dart`）。本文先把契约看清，把"谁在用"留到第九卷。

## 二、最小 Demo

```dart
import 'package:flutter/foundation.dart';

/// 1. 直接用的三种 Key
const Key simplest = Key('a');            // 工厂构造，实际类型是 ValueKey<String>
const ValueKey<String> named = ValueKey<String>('a');
final UniqueKey unique = UniqueKey();     // 不能用 const

/// 2. 子类化 ValueKey：只改类型，不改值
class TagKey extends ValueKey<String> {
  const TagKey(super.value);
}

void main() {
  debugPrint('${simplest == named}');           // true
  debugPrint('${const TagKey('a') == named}');  // false，尽管 value 都是 'a'
  debugPrint('$simplest');                      // [<'a'>]
}
```

第三行的 `false` 就是这个文件最重要的设计：**同名 value 不会跨类型碰撞**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `key.dart:29` | `abstract class Key`，整个体系的根 |
| `key.dart:33` | `const factory Key(String value) = ValueKey<String>;`，唯一的重定向工厂 |
| `key.dart:40` | `const Key.empty()`，给子类的默认构造 |
| `key.dart:51` | `abstract class LocalKey`，同父作用域有效的分支 |
| `key.dart:61` / `key.dart:68` | `UniqueKey` 与它"故意不能 const"的构造 |
| `key.dart:88` | `class ValueKey<T>`，实际使用最多的实现 |
| `key.dart:96-101` | `operator ==`，先比 runtimeType 再比 value |
| `key.dart:107-113` | `toString`，三种 Key 的三种打印形态 |
| `key.dart:116` | `typedef _TypeOf<T> = T;`，`toString` 里用来做类型相等判断的辅助 |

## 四、调用链

### 4.1 Key 自己的调用链：只有一层

`Key` 不参与任何调度。它的全部行为就是被问到"你和它相等吗"时作答，而这个问题的发起方是 `Widget.canUpdate`：

```dart
// widgets/framework.dart:382-384
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

完整链路在 `Element.updateChild` 里收口：

```text
Element.updateChild(oldChild, newWidget, newSlot)        // framework.dart:3982
      ↓
Widget.canUpdate(oldWidget, newWidget)                   // framework.dart:382
      ↓ runtimeType 相同 且 key ==
      ↓
   true  → oldChild.update(newWidget)     复用 Element，State 保留
   false → deactivateChild(oldChild)
           inflateWidget(newWidget, slot)  新建 Element，State 重建
```

`Key` 的作用范围由**谁去做那个 `==` 比较**决定，并不由 `Key` 自己声明。`LocalKey` 只在"同一个父节点的孩子列表"里被比较（`updateChild` 的调用点），所以文档才说"Key 在同一个 parent 下必须唯一"；`GlobalKey` 之所以能跨位置移动 Element，不是因为 `GlobalKey` 的 `==` 特殊，而是因为它被登记进了 `BuildOwner` 的全局注册表，由另一套代码处理。

### 4.2 `ValueKey.==` 里那一行 runtimeType

```dart
// key.dart:96-101
bool operator ==(Object other) {
  if (other.runtimeType != runtimeType) {
    return false;
  }
  return other is ValueKey<T> && other.value == value;
}
```

这行 `runtimeType` 判断看起来是多余的（Dart 的泛型会在运行时检查 `is ValueKey<T>`），但它决定了三件事：

| 比较 | 结果 | 原因 |
|---|---|---|
| `ValueKey<String>('a') == ValueKey<String>('a')` | `true` | 类型同、值同 |
| `ValueKey<int>(1) == ValueKey<num>(1)` | `false` | `runtimeType` 不同：`ValueKey<int>` 与 `ValueKey<num>` |
| `TagKey('a') == ValueKey<String>('a')` | `false` | `runtimeType` 不同：`TagKey` 与 `ValueKey<String>` |
| `ValueKey<int>(1) == ValueKey<String>('1')` | `false` | 类型不同 |

第三行才是这个设计的价值：**你可以用私有子类给 Key 划一个命名空间**，同一个字符串在这个空间里不会和别处碰撞。这是 `ValueKey` 文档（`key.dart:79-83`）明确推荐的用法。

### 4.3 `UniqueKey` 为什么要"故意不能 const"

```dart
// key.dart:67-68
// ignore: prefer_const_constructors_in_immutables , never use const for this class
UniqueKey();
```

`UniqueKey` 没有重写 `==`，所以它沿用 `Object` 的**身份相等**。如果允许 `const UniqueKey()`，Dart 会把所有 `const UniqueKey()` 规范化成同一个实例——那所有 `UniqueKey` 就互相相等了，这个类也就失去了意义。所以源码用一行 `ignore` 注释把这个设计意图钉在代码里。

看 `toString` 也能看出它的身份语义：`UniqueKey().toString()` 输出 `[#32b4f]`，用的是 `shortHash(this)`（基于对象身份），而不是值。

### 4.4 `toString` 的三种形态

```dart
// key.dart:107-113
String toString() {
  final valueString = T == String ? "<'$value'>" : '<$value>';
  if (runtimeType == _TypeOf<ValueKey<T>>) {
    return '[$valueString]';
  }
  return '[$T $valueString]';
}
```

`_TypeOf<T> = T` 这个 typedef 的用途是让 `runtimeType == ValueKey<T>` 这个判断能通过静态检查。三种形态的输出如下：

| Key | 输出 | 走哪个分支 |
|---|---|---|
| `ValueKey<String>('a')` | `[<'a'>]` | 直接类型，String 加引号 |
| `ValueKey<int>(1)` | `[<1>]` | 直接类型，非 String |
| `ValueKey<num>(1)` | `[<1>]` | 直接类型，非 String |
| `TagKey('a')` | `[String <'a'>]` | 子类，多打印一层 `T` |

只有子类才会打印出类型名。所以你在调试输出里看到 `[String <'a'>]` 这种带类型前缀的 Key，说明它是一个 `ValueKey<String>` 的子类，而不是 `ValueKey<String>` 本身。

## 五、核心对象：三个类的职责对比

| | `Key` | `LocalKey` | `GlobalKey` |
|---|---|---|---|
| 定义位置 | `key.dart:29` | `key.dart:51` | `widgets/framework.dart:159` |
| 是否有行为 | 无，只有构造函数 | 无 | 有：注册表、`currentState`、`currentContext` |
| 相等语义 | 由子类决定 | 由子类决定 | 看子类：`GlobalKey` 本体是身份相等；`GlobalObjectKey`（`framework.dart:245`）按 `identical(value)` 比较 |
| 唯一性范围 | — | 同一个 parent 的 children 之间 | 整个 App |
| 能否跨位置搬 Element | 不能 | 不能 | 能 |

`GlobalKey` 家族里有一个容易漏掉的例外：`GlobalObjectKey`（`framework.dart:245`）重写了 `==`，相等性是 `identical(value)`——两个持有**同一个对象**的 `GlobalObjectKey` 相等。所以"GlobalKey 一律身份相等"并不成立，描述时要区分本体与 `GlobalObjectKey`。

`LocalKey` 与 `ValueKey` / `UniqueKey` 的关系是"抽象基类 + 两个策略"：

```text
Key
 ├── LocalKey
 │    ├── ValueKey<T>   相等性委托给 value
 │    └── UniqueKey     相等性就是身份
 └── GlobalKey          相等性就是身份 + 全局注册表
```

`LocalKey` 本身不提供任何功能，它存在的唯一目的是：**让"这个 Key 只在局部有效"这件事在类型上可以被表达**。框架里凡是要接收 Key 的地方，如果它只打算做局部的孩子匹配，就可以要求参数是 `LocalKey`。

## 六、源码实验

### 实验 1：验证相等契约

```dart
debugPrint('${const Key('a') == const ValueKey<String>('a')}');  // true
debugPrint('${const ValueKey<int>(1) == const ValueKey<num>(1)}'); // false
debugPrint('${const TagKey('a') == const ValueKey<String>('a')}'); // false
```

**预测**：第二个比较，`ValueKey<int>(1)` 和 `ValueKey<num>(1)` 的 `value` 都是 `1`，如果不看 `runtimeType` 就会相等。

**实际**：`false`。`runtimeType` 是 `ValueKey<int>` 与 `ValueKey<num>`，第一行判断直接返回。

### 实验 2：State 到底跟着谁走

下面这段代码把"Key 决定身份"变成肉眼可见的现象。计数存在 `State` 里，所以它的归属就是 `State` 的归属：

```dart
import 'package:flutter/widgets.dart';

class CounterChip extends StatefulWidget {
  const CounterChip({super.key, required this.label});

  final String label;

  @override
  State<CounterChip> createState() => _CounterChipState();
}

class _CounterChipState extends State<CounterChip> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => setState(() => count += 1),   // 1. 只改本地计数
      child: Text('${widget.label}:$count'),     // 2. label 来自 Widget，count 来自 State
    );
  }
}

/// 同一批子 Widget，按 [reverse] 决定顺序；[withKeys] 决定是否带 ValueKey。
class ReorderLab extends StatelessWidget {
  const ReorderLab({super.key, required this.reverse, required this.withKeys});

  final bool reverse;
  final bool withKeys;

  @override
  Widget build(BuildContext context) {
    final List<String> labels =
        reverse ? const <String>['b', 'a'] : const <String>['a', 'b'];
    return Column(
      children: <Widget>[
        for (final String label in labels)
          if (withKeys)
            CounterChip(key: ValueKey<String>(label), label: label)
          else
            CounterChip(label: label),
      ],
    );
  }
}
```

操作步骤（用 `flutter run` 或 widget 测试均可）：

1. 进入 `withKeys: true`：点击 `a:0`，它会变成 `a:1`
2. 把 `reverse` 改为 `true` 并重建页面
3. 观察

**预测**：交换顺序后，`a:1` 应该还在——因为它有 Key，`canUpdate` 在旧列表里能匹配到 key 为 `'a'` 的那个 Element。

**实际**：`withKeys: true` 时，屏幕上仍是 `a:1` 和 `b:0`，计数跟着标签走了；`withKeys: false` 时，屏幕上变成 `b:1` 和 `a:0`，计数留在原来的位置上，只是标签换成了 `b`。

**说明**：这就是 `Widget.canUpdate` 那两行代码的全部后果。不带 Key 时两个 `CounterChip` 的 `key` 都是 `null`，`null == null` 成立，`runtimeType` 也相同，于是位置 0 的新 Widget 被判定为"可以更新位置 0 的旧 Element"——复用了 Element，也就复用了它里面的 `State`。

### 实验 3：去看锚点行号，确认版本

```bash
sed -n '96,101p' packages/flutter/lib/src/foundation/key.dart
```

**说明**：源码是注释量极大的代码库，一个 117 行的文件里实际逻辑不到 10 行。**读源码时先找这些"不到 10 行"的地方**，它们才是契约本体。

## 七、结论

1. `Key` 本身不查找、不注册、不比较 Widget，只提供 `==` 和 `hashCode`；谁比较、什么时候比较，由 `Element.updateChild` → `Widget.canUpdate`（`framework.dart:382`）决定。
2. `ValueKey.==` 先比 `runtimeType` 再比 `value`，这让"私有子类"成为 Key 的命名空间，同名 value 不会跨来源碰撞。
3. `UniqueKey` 故意去掉 `const` 构造，因为 const 规范化会让所有 `UniqueKey()` 变成同一个实例，从而互相相等。

**Key 是 Element 复用判定的输入，它唯一的产品是相等性，并不充当标签。**

## 八、边界声明

- 本文只讲 `foundation/key.dart`。`GlobalKey` 的注册表、`_retakeInactiveElement` 的跨位置搬运、`Element.updateChild` 的多孩子匹配算法（含 `updateChildren` 的 key 扫描）留到第九卷篇 39。
- Key 在列表/动画/表单场景的选型（什么时候用 `ValueKey`、什么时候必须 `GlobalKey`）属于应用层话题，本文不展开。
- 这个系列不写单元测试，本文实验用 `debugPrint` 观察即可。
