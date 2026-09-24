# 05 ValueNotifier 与 ObserverList：两种观察者容器

> 版本锚点：Flutter 3.44.8 (058e0af2c2)
> 源码路径 `foundation/change_notifier.dart`（569 行）、`foundation/observer_list.dart`（161 行）

## 一、问题

`ValueNotifier` 看起来是"带值的 `ChangeNotifier`"，实现只有 26 行：

```dart
class ValueNotifier<T> extends ChangeNotifier implements ValueListenable<T> {
  ...
  set value(T newValue) {
    if (_value == newValue) {
      return;
    }
    _value = newValue;
    notifyListeners();
  }
}
```

那问题来了：**这行 `==` 判断会造成哪些实际后果？**

多数人只知道"值不变不会刷新"，但它还意味着另外两件事，而且都很容易在业务里踩到：

- `ValueNotifier<List<int>>` 原地 `add` 数据，**不会通知**
- `ValueNotifier<double>` 反复赋 `NaN`，**每次都通知**

两个后果来自同一个 `==`。这一篇把这行判断的四个后果讲全，再顺便看清框架内部那套**另一种**观察者容器 `ObserverList`。

## 二、最小 Demo

```dart
import 'package:flutter/foundation.dart';

void main() {
  // 1. 普通值
  final ValueNotifier<int> count = ValueNotifier<int>(0);
  count.addListener(() => debugPrint('count = ${count.value}'));
  count.value = 0;   // 不通知
  count.value = 1;   // 通知

  // 2. 容器：原地修改不算变化
  final ValueNotifier<List<int>> list = ValueNotifier<List<int>>(<int>[]);
  list.addListener(() => debugPrint('list = ${list.value}'));
  list.value.add(1);            // 不通知
  list.value = <int>[1];        // 通知

  // 3. NaN：不等于自己
  final ValueNotifier<double> nan = ValueNotifier<double>(double.nan);
  nan.addListener(() => debugPrint('nan 通知了'));
  nan.value = double.nan;       // 通知
  nan.value = double.nan;       // 又通知
}
```

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `change_notifier.dart:62` | `abstract class Listenable`，只有 `addListener` / `removeListener` |
| `change_notifier.dart:74` | `factory Listenable.merge(...) = _MergingListenable;` |
| `change_notifier.dart:94` | `abstract class ValueListenable<T>`，加一个 `value` getter |
| `change_notifier.dart:542` | `class ValueNotifier<T> extends ChangeNotifier` |
| `change_notifier.dart:558-564` | `set value`，本篇的核心四行 |
| `observer_list.dart:27` | `class ObserverList<T> extends Iterable<T>` |
| `observer_list.dart:61-73` | `contains`，按元素数切换实现的分叉点 |
| `observer_list.dart:108` | `class HashedObserverList<T>`，用计数表示重复 |

## 四、调用链

### 4.1 三层接口的分工

```text
Listenable                      只有 addListener / removeListener
   ↑
ValueListenable<T>              多一个 value getter
   ↑
ValueNotifier<T>                可写实现
Animation<T>                    另一个实现（值由 Ticker 驱动）
```

`Listenable` 是"能被监听"的最小契约；`ValueListenable<T>` 是"能被监听，且有一个当前值"；`ValueNotifier<T>` 是前者唯一可变的内置实现。

**关键认知**：`Animation<T>` 也实现了 `ValueListenable<T>`，这才是 `ListenableBuilder` 和 `ValueListenableBuilder` 能互换使用的原因——它们消费的是接口，不是具体类型。

另外注意 `Listenable` 是个 **`abstract class` 而不是 `mixin`**，并且它有一个工厂构造：

```dart
// change_notifier.dart:62-74（节选）
abstract class Listenable {
  const Listenable();

  factory Listenable.merge(Iterable<Listenable?> listenables) = _MergingListenable;

  void addListener(VoidCallback listener);
  void removeListener(VoidCallback listener);
}
```

`Listenable.merge` 把增删转发给一组子对象（`change_notifier.dart:495-518`）。它**不做去重**：同一个监听者会被注册到每一个子对象上，任一子对象触发就调用它一次。

### 4.2 `set value` 的四个后果

```dart
// change_notifier.dart:558-564
set value(T newValue) {
  if (_value == newValue) {
    return;
  }
  _value = newValue;
  notifyListeners();
}
```

| 输入 | `_value == newValue` | 结果 |
|---|---|---|
| 相同 `int` / `String` | `true` | 不通知 |
| `List` 原地修改后重新赋同一个实例 | `true` | 不通知 |
| 新 `List<int>[1]` 与旧 `List<int>[1]` | `false`（`List` 的 `==` 是身份比较） | 通知 |
| `double.nan` 与 `double.nan` | `false`（NaN 不等于自己） | **通知** |

第三条解释了为什么下面两种写法效果完全不同：

```dart
// 写法 A：不通知
final ValueNotifier<List<int>> items = ValueNotifier<List<int>>(<int>[]);
items.value.add(1);

// 写法 B：通知
items.value = <int>[...items.value, 1];
```

第四条是纯粹的语言特性副作用，但会真实出现——比如配合动画时：

```dart
// 每帧都把进度写进去，动画停止在某个状态时可能出现
final ValueNotifier<double> progress = ValueNotifier<double>(0.0);
// 如果某次计算结果是 NaN，之后每次写 NaN 都会触发通知
```

源码的类文档（`change_notifier.dart:520-541`）明确提醒了第二条，并给出结论：

> Notifications are triggered based on **equality (`==`)**, not on mutations within the value itself. ... Because of this behavior, `ValueNotifier` is best used with immutable data types. For mutable data types, consider extending `ChangeNotifier` directly and calling `notifyListeners` manually when changes occur.

**关键认知**：`ValueNotifier` 只负责"值变了就叫"，它不判断"值内容变了"。可变数据结构要配 `ChangeNotifier` + 手动 `notifyListeners`。

### 4.3 `ObserverList`：框架内部的另一套观察者容器

`ChangeNotifier` 是给业务用的，`ObserverList` 是给框架自己用的。它把"观察者名单"当成一个**可迭代集合**，而不是一对增删方法：

```dart
// observer_list.dart:27-31
class ObserverList<T> extends Iterable<T> {
  final List<T> _list = <T>[];
  bool _isDirty = false;
  late final HashSet<T> _set = HashSet<T>();
}
```

它的核心优化在 `contains`：

```dart
// observer_list.dart:61-73
bool contains(Object? element) {
  if (_list.length < 3) {
    return _list.contains(element);
  }

  if (_isDirty) {
    _set.addAll(_list);
    _isDirty = false;
  }

  return _set.contains(element);
}
```

**三个或以上元素时改用 `HashSet` 做查找**，索引是惰性建立的（`_isDirty` 标记 + 首次 `contains` 时重建）。文档里给了适用场景的判据：当 `contains` 的调用次数远超 `add` / `remove` 时，用 `ObserverList` 代替 `List`。

**关键认知**：惰性索引带来一个必须知道的约束——**`hashCode` 必须与 `==` 保持一致，而且不能在对象进入列表后被改变**。因为索引一旦建好就不会重建，改变 `hashCode` 会让该对象在集合里"消失"。第六节的实验会演示这个失效过程。

### 4.4 `HashedObserverList`：用计数代替列表项

```dart
// observer_list.dart:108-134（节选）
class HashedObserverList<T> extends Iterable<T> {
  final Map<T, int> _map = <T, int>{};

  void add(T item) {
    _map[item] = (_map[item] ?? 0) + 1;    // 计数 +1
  }

  bool remove(T item) {
    final int? value = _map[item];
    if (value == null) {
      return false;
    }
    if (value == 1) {
      _map.remove(item);
    } else {
      _map[item] = value - 1;              // 计数 -1
    }
    return true;
  }
}
```

`remove` 是 O(1)（`ObserverList.remove` 是 O(N)），代价是迭代语义变了：

| 行为 | `ObserverList` | `HashedObserverList` |
|---|---|---|
| 同一元素 `add` 两次 | 迭代中出现**两次** | 迭代中出现**一次** |
| `remove` 一次 | 还剩一项，仍出现 | 计数减到 1，仍出现 |
| 需要 `remove` 几次才消失 | 与 `add` 次数相同 | 与 `add` 次数相同 |
| 迭代顺序 | 加入顺序（含重复） | **首次**加入的顺序 |
| `remove` 复杂度 | O(N) | O(1) |

**两者在"要移除同样次数"这一点上是一致的**，区别在迭代结果。框架自己的选择也能说明适用场景：

| 类 | 框架内的使用者 |
|---|---|
| `ObserverList` | `animation/listener_helpers.dart`、`material/ink_well.dart`、`widgets/actions.dart`、`widgets/router.dart` |
| `HashedObserverList` | `widgets/focus_manager.dart` |

焦点管理里注册量可能很大（每个可聚焦节点都算），所以选了 O(1) 的版本。

## 五、核心对象：四种"通知"的角色对比

| | `ChangeNotifier` | `ValueNotifier<T>` | `Animation<T>` | `ObserverList<T>` |
|---|---|---|---|---|
| 层 | foundation | foundation | animation | foundation |
| 对外契约 | `Listenable` | `ValueListenable<T>` | `ValueListenable<T>` | `Iterable<T>` |
| 值的持有者 | 子类字段 | `_value` | 计算得出 | 无（只管名单） |
| 通知时机 | 子类决定 | `set value` 且 `!=` 旧值 | 每帧 tick | 无通知，只有增删 |
| 典型使用者 | Controller 家族 | 简单状态 | 动画 | 框架内部 |

注意最后两列：`ObserverList` **根本没有"通知"这个概念**。它只解决"名单怎么存、怎么查"；什么时候通知、怎么通知，由持有它的类自己决定（`AnimationController` 就是自己拿着 `ObserverList` 再自己决定何时调用）。

## 六、源码实验

### 实验 1：`ValueNotifier` 的相等判断

```dart
final ValueNotifier<int> notifier = ValueNotifier<int>(1);
int calls = 0;
notifier.addListener(() => calls++);

notifier.value = 1;
debugPrint('$calls');   // 0
notifier.value = 2;
debugPrint('$calls');   // 1
```

### 实验 2：原地修改容器不通知

```dart
final ValueNotifier<List<int>> notifier = ValueNotifier<List<int>>(<int>[]);
int calls = 0;
notifier.addListener(() => calls++);

notifier.value.add(1);
debugPrint('$calls  ${notifier.value}');   // 0  [1]

notifier.value = <int>[1];
debugPrint('$calls');                      // 1
```

**说明**：注意第一行的 `calls` 是 0，但 `notifier.value` 已经是 `[1]` 了——**数据变了，通知没发**。这是 `ValueNotifier` 配可变容器时最危险的组合。

### 实验 3：NaN 每次都通知

```dart
final ValueNotifier<double> notifier = ValueNotifier<double>(double.nan);
int calls = 0;
notifier.addListener(() => calls++);

notifier.value = double.nan;
notifier.value = double.nan;
debugPrint('$calls');   // 2
```

**预测**：既然"值相同时不通知"，两次赋 NaN 应该只通知 0 次。

**实际**：2 次。因为 `NaN == NaN` 在 IEEE 754 里是 `false`，相等判断拦不住。

### 实验 4：`ObserverList` 的索引会失效

```dart
class MutableIdObserver {
  MutableIdObserver(this.id);
  int id;

  @override
  bool operator ==(Object other) => other is MutableIdObserver && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

void main() {
  // 2 个元素：走 List.contains，只看 ==
  final ObserverList<MutableIdObserver> small = ObserverList<MutableIdObserver>();
  final MutableIdObserver a = MutableIdObserver(1);
  small.add(a);
  small.add(MutableIdObserver(99));
  a.id = 2;
  debugPrint('${small.contains(a)}');   // true

  // 3 个元素：走 HashSet.contains，先算 hashCode
  final ObserverList<MutableIdObserver> big = ObserverList<MutableIdObserver>();
  final MutableIdObserver b = MutableIdObserver(1);
  big.add(b);
  big.add(MutableIdObserver(99));
  big.add(MutableIdObserver(100));

  big.contains(MutableIdObserver(-1));  // 查一个不存在的元素，触发索引建立
  b.id = 2;
  debugPrint('${big.contains(b)}');     // false
}
```

**预测**：`a` 和 `b` 的情况看起来一样——都是"加入后改了 `id`，然后 `contains` 自己"——结果应该相同。

**实际**：第一个是 `true`，第二个是 `false`。

**说明**：差别在于**索引是否已经建好**。

- 第一个列表只有 2 个元素，`_list.length < 3` 成立，直接用 `List.contains`，每次都用当前的 `==` 比较，所以能命中。
- 第二个列表有 3 个元素，但 `contains` 时 `_isDirty` 仍为 `true`，会先 `_set.addAll(_list)` 重建索引——**这次重建用的是 `id == 1` 时的 `hashCode`**。之后 `b.id` 改成 2，`contains` 用新 `hashCode` 去查，桶位对不上，直接返回 `false`，连 `==` 都不会执行。

这就是 4.3 节那条约束的具体形态：**不要用可变对象做 `ObserverList` 的元素，除非能保证 `hashCode` 不变。**

### 实验 5：两种列表的迭代语义差异

```dart
const NamedObserver a = NamedObserver('a');

final ObserverList<NamedObserver> plain = ObserverList<NamedObserver>();
plain.add(a);
plain.add(a);
debugPrint('${plain.toList().length}');       // 2

final HashedObserverList<NamedObserver> hashed = HashedObserverList<NamedObserver>();
hashed.add(a);
hashed.add(a);
debugPrint('${hashed.toList().length}');      // 1

hashed.remove(a);
debugPrint('${hashed.toList().length}');      // 1，计数减到 1
hashed.remove(a);
debugPrint('${hashed.isEmpty}');              // true
```

## 七、结论

1. `ValueNotifier` 的全部逻辑就是 `if (_value == newValue) return;`。这一个 `==` 带来四个后果：相同值不通知、原地修改可变容器不通知、换成相等的新实例要通知、`NaN` 每次都通知。
2. `Listenable` → `ValueListenable<T>` → `ValueNotifier<T>` 是三层接口递进；`Animation<T>` 也实现了 `ValueListenable<T>`，这是各种 Builder 能互换消费的原因。
3. `ObserverList` 在元素数达到 3 时把 `contains` 切到惰性构建的 `HashSet` 索引上，因此要求元素的 `hashCode` 稳定；`HashedObserverList` 用计数换 O(1) 的 `remove`，代价是重复项在迭代中只出现一次。

一句话总结：**`ValueNotifier` 用 `==` 决定要不要通知，`ObserverList` 用 `hashCode` 决定能不能查到。**

## 八、边界声明

- `ValueListenableBuilder` / `ListenableBuilder` 的 Widget 层实现（三处监听的配对、`setState` 的触发）留到第九卷。
- `Animation<T>` 的 `value` 如何由 Ticker 驱动，留到第五卷篇 21。
- `InheritedNotifier` 把 `Listenable` 接到 `InheritedWidget` 依赖体系上的机制，与第九卷的 `InheritedWidget` 篇一起看。
- `ObserverList` 在 `Material` 的 `InkWell` 里承担什么角色（水波纹的监听者名单）不在本系列展开。
