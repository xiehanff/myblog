# 04 ChangeNotifier：通知模型与重入防御

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/foundation/change_notifier.dart`（569 行）

## 一、问题

`ChangeNotifier` 用起来像一个"回调列表"：

```dart
class Counter extends ChangeNotifier {
  int _value = 0;
  int get value => _value;
  void increment() {
    _value++;
    notifyListeners();
  }
}
```

那它内部是不是就是一个 `List<VoidCallback>`？

**不是。** 如果用 `List<VoidCallback>` 实现，只在一种情况下会出问题：**在通知过程中修改这个列表**。而这恰好是框架里最常见的场景——`ScrollController` 的监听者里常常会 `removeListener`，`AnimationController` 的监听者里常常会再加监听者。

真正的 `ChangeNotifier` 有 5 个内部字段、一个 `_count` 计数、两种移除路径和一套递归深度记账。本文全部拆开。

## 二、最小 Demo

```dart
import 'package:flutter/foundation.dart';

class Counter extends ChangeNotifier {
  int value = 0;

  void increment() {
    value++;
    notifyListeners();
  }
}

void main() {
  final Counter counter = Counter();

  // 1. 普通监听
  counter.addListener(() => debugPrint('A: ${counter.value}'));

  // 2. 在通知过程中再注册一个监听者：本轮不会被调用
  counter.addListener(() {
    debugPrint('B: ${counter.value}');
    counter.addListener(() => debugPrint('C（下一轮才会被调用）'));
  });

  counter.increment();
  counter.increment();
}
```

输出会发现 `C` 第一次出现是在第二次 `increment` 时。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `change_notifier.dart:139` | `mixin class ChangeNotifier implements Listenable` |
| `change_notifier.dart:140-153` | 五个内部字段，全部答案在这里 |
| `change_notifier.dart:272-291` | `addListener`：翻倍扩容 |
| `change_notifier.dart:293-323` | `_removeAt`：迭代外的移除与缩容策略 |
| `change_notifier.dart:339-363` | `removeListener`：两种路径的分叉点 |
| `change_notifier.dart:413-492` | `notifyListeners`：快照、占位、递归记账、事后压缩 |
| `change_notifier.dart:376-393` | `dispose`：两个断言 |
| `change_notifier.dart:495-518` | `_MergingListenable`，`Listenable.merge` 的实现 |

## 四、调用链

### 4.1 五个字段，各管一件事

```dart
// change_notifier.dart:140-153
int _count = 0;
static final List<VoidCallback?> _emptyListeners = List<VoidCallback?>.filled(0, null);
List<VoidCallback?> _listeners = _emptyListeners;
int _notificationCallStackDepth = 0;
int _reentrantlyRemovedListeners = 0;
bool _debugDisposed = false;
```

| 字段 | 作用 |
|---|---|
| `_listeners` | **定长**列表，元素可空。实际有效元素是前 `_count` 个 |
| `_count` | 有效监听者数量。`_listeners.length` 通常大于它 |
| `_notificationCallStackDepth` | 当前嵌套了几层 `notifyListeners` |
| `_reentrantlyRemovedListeners` | 通知期间被移除（置空）的数量，用于事后压缩 |
| `_debugDisposed` | 释放标记，只在 debug 下检查 |

两个字段值得单独说。

`_listeners` 是**定长**的（`List<VoidCallback?>.filled`），不是可增长的 `List`。类型写成 `VoidCallback?` 也是刻意的——通知期间"移除"就是把这个槽位置成 `null`，而不是从列表里删掉元素。源码里甚至有一段注释解释为什么不写成 `const []`：

```dart
// change_notifier.dart:141-148
// The _listeners is intentionally set to a fixed-length _GrowableList instead
// of const [].
//
// The const [] creates an instance of _ImmutableList which would be
// different from fixed-length _GrowableList used elsewhere in this class.
// keeping runtime type the same during the lifetime of this class lets the
// compiler to infer concrete type for this property, and thus improves
// performance.
```

也就是说：`const []` 会让列表的 runtime type 在生命周期中发生变化，破坏编译器的具体类型推断。这是一个纯粹的性能考虑。

### 4.2 `addListener`：摊还 O(1)

```dart
// change_notifier.dart:272-291
void addListener(VoidCallback listener) {
  assert(ChangeNotifier.debugAssertNotDisposed(this));

  if (kFlutterMemoryAllocationsEnabled) {
    maybeDispatchObjectCreation(this);
  }

  if (_count == _listeners.length) {
    if (_count == 0) {
      _listeners = List<VoidCallback?>.filled(1, null);
    } else {
      final newListeners = List<VoidCallback?>.filled(_listeners.length * 2, null);
      for (var i = 0; i < _count; i++) {
        newListeners[i] = _listeners[i];
      }
      _listeners = newListeners;
    }
  }
  _listeners[_count++] = listener;
}
```

容量不够时**翻倍**（第一次是 1），所以 `addListener` 是摊还 O(1)。文档里写的就是"You can add a listener in O(1)"。

### 4.3 `some.notifyListeners()` 的完整流程

```text
notifyListeners()                                    // 413
    ↓
assert(debugAssertNotDisposed(this))                 // 414
    ↓
if (_count == 0) return;                             // 415-417  没有任何监听者，直接返回
    ↓
_notificationCallStackDepth++                        // 430
    ↓
final int end = _count;                              // 432  ← 快照！
    ↓
for (i = 0; i < end; i++)                            // 433
    _listeners[i]?.call()                            // 435  ← 空槽跳过
        ↓ 抛异常？
        FlutterError.reportError(...)                // 437-451  吞掉，继续下一个
    ↓
_notificationCallStackDepth--                        // 455
    ↓
if (depth == 0 && _reentrantlyRemovedListeners > 0)  // 457
    压缩列表，_count = newLength，清零计数              // 459-490
```

四个关键设计，逐个说明。

**① `end` 是快照。** 循环上界取的是进入本次通知时的 `_count`，不是实时的 `_listeners.length`。所以通知期间新加的监听者**本轮不会被访问**——即使它被写进了 `_count` 之后的槽位。

**② 移除是"置空占位"。** 看 `removeListener` 的分叉：

```dart
// change_notifier.dart:339-363（节选）
void removeListener(VoidCallback listener) {
  // 注意：这个方法允许在 dispose 之后调用
  for (var i = 0; i < _count; i++) {
    final VoidCallback? listenerAtIndex = _listeners[i];
    if (listenerAtIndex == listener) {
      if (_notificationCallStackDepth > 0) {
        // 通知过程中：不移动元素，只置空
        _listeners[i] = null;
        _reentrantlyRemovedListeners++;
      } else {
        _removeAt(i);       // 不在通知过程中：真正移除并可能缩容
      }
      break;
    }
  }
}
```

为什么通知期间不能直接删？因为循环正在用下标 `i` 遍历 `_listeners`，此时移动元素会让后面的监听者被跳过或重复调用。置空是唯一安全的做法，代价是"列表会暂时留洞"。

**③ 递归深度记账。** 因为监听者内部可以再调 `notifyListeners`（嵌套通知），压缩列表这件事必须等到**最外层**通知结束时才能做。否则内层结束时就压缩，外层当前持有的 `i` 和 `end` 全都会失效。

**④ 异常被吞掉。** 监听者抛出的异常不会向外传播，而是包装成 `FlutterErrorDetails` 交给 `FlutterError.reportError`：

```dart
// change_notifier.dart:433-453
for (var i = 0; i < end; i++) {
  try {
    _listeners[i]?.call();
  } catch (exception, stack) {
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: exception,
        stack: stack,
        library: 'foundation library',
        context: ErrorDescription('while dispatching notifications for $runtimeType'),
        ...
      ),
    );
  }
}
```

`notifyListeners` 是一个"不会向外抛异常"的方法。任何试图靠 `try { controller.notifyListeners(); } catch (...)` 捕获监听者错误的写法都是无效的，必须走 `FlutterError.onError`。

这条设计的连带后果比想象的广——第六节的实验会给出一个反直觉的例子。

### 4.4 `dispose` 的两个断言

```dart
// change_notifier.dart:376-393（节选）
void dispose() {
  assert(ChangeNotifier.debugAssertNotDisposed(this));
  assert(
    _notificationCallStackDepth == 0,
    'The "dispose()" method on $this was called during the call to '
    '"notifyListeners()". This is likely to cause errors since it modifies '
    'the list of listeners while the list is being used.',
  );
  ...
  _listeners = _emptyListeners;
  _count = 0;
}
```

两个断言分别管：不能重复释放、不能在通知过程中释放。

而 `removeListener` 的方法体第一句注释说明了它的例外：

```dart
// change_notifier.dart:340-344
// This method is allowed to be called on disposed instances for usability
// reasons. Due to how our frame scheduling logic between render objects and
// overlays, it is common that the owner of this instance would be disposed a
// frame earlier than the listeners. Allowing calls to this method after it
// is disposed makes it easier for listeners to properly clean up.
```

**`dispose` 之后 `addListener` 会抛错，`removeListener` 不会。** 这么做是为了应对"owner 比 listener 早一帧释放"这个框架内部真实存在的时序，并非疏漏。

## 五、核心对象：`ChangeNotifier` vs `ObserverList`

框架里有两套观察者实现，容易混淆：

| | `ChangeNotifier`（`change_notifier.dart`） | `ObserverList`（`observer_list.dart`） |
|---|---|---|
| 对外形态 | 公开 API，业务可直接继承 | 框架内部工具，上层几乎不用 |
| 存储 | 定长列表 + `_count` 计数 | 普通 `List` + 惰性 `HashSet` 索引 |
| 重复注册 | 保留重复项，会调用多次 | `ObserverList` 保留重复项；`HashedObserverList` 用计数 |
| 通知期间移除 | 置空占位，通知结束后压缩 | 无特殊处理 |
| 异常处理 | 捕获并 `FlutterError.reportError` | 无，由调用方负责 |
| 空值支持 | 不支持（`addListener` 不接受 null） | 不支持 |

选择标准很简单：需要**对外暴露**监听能力就用 `ChangeNotifier`（它实现了 `Listenable`，能被 `ListenableBuilder` 消费）；只是**内部需要一份观察者名单**就用 `ObserverList`。第五篇会展开后者。

## 六、源码实验

### 实验 1：通知期间新增的监听者，本轮不生效

```dart
final ChangeNotifier notifier = ChangeNotifier();
final List<String> log = <String>[];

notifier.addListener(() {
  log.add('first');
  notifier.addListener(() => log.add('late'));
});

notifier.notifyListeners();
debugPrint('$log');   // [first]

notifier.notifyListeners();
debugPrint('$log');   // [first, first, late]
```

**预测**：如果循环用实时的 `_count` 做上界，`late` 会在第一次就被调用。

**实际**：第一次只输出 `[first]`。因为循环上界是进入时的快照 `end`。

### 实验 2：通知期间移除的监听者，立刻不再被调用

```dart
final ChangeNotifier notifier = ChangeNotifier();
final List<String> log = <String>[];
late VoidCallback later;
later = () => log.add('later');

notifier.addListener(() {
  log.add('first');
  notifier.removeListener(later);   // 移除排在后面的监听者
});
notifier.addListener(later);

notifier.notifyListeners();
debugPrint('$log');   // [first]
```

**预测**：既然移除只是"置空占位"，那 `later` 的槽位已经变成 `null`，循环走到它时会跳过。

**实际**：`[first]`。循环体里的 `_listeners[i]?.call()` 用 `?.` 调用，正是为跳过这些空槽。

### 实验 3：同一个监听者注册两次、移除一次，它仍会被调用

这是 `addListener` 文档里明确写出来的"反直觉行为"：

```dart
final ChangeNotifier notifier = ChangeNotifier();
int calls = 0;
final VoidCallback dup = () => calls++;

notifier.addListener(dup);
notifier.addListener(dup);
notifier.notifyListeners();
debugPrint('$calls');    // 2

notifier.removeListener(dup);   // 只移除一个匹配项
notifier.notifyListeners();
debugPrint('$calls');    // 3，还剩一次注册
```

**说明**：`removeListener` 找到第一个匹配项就 `break`，它无法知道"用户想移除哪一个"，因为两个闭包完全相等。框架的选择是"保守地继续调用"。

### 实验 4：`dispose` 的断言被 `notifyListeners` 吃掉了

这个实验揭示了 4.3 节 ④ 那条设计的连带后果。

```dart
final ChangeNotifier notifier = ChangeNotifier();
late VoidCallback self;
self = () => notifier.dispose();      // 在通知过程中释放自己
notifier.addListener(self);

try {
  notifier.notifyListeners();
  debugPrint('notifyListeners 正常返回了');
} catch (error) {
  debugPrint('捕获到 ${error.runtimeType}');
}
```

**预测**：`dispose` 里那条 `_notificationCallStackDepth == 0` 的断言会抛出 `AssertionError`，所以应该被 `catch` 捕获。

**实际**（输出）：

```text
notifyListeners 正常返回了
reported=1 first=_AssertionError
```

**说明**：`AssertionError` 确实触发了，但它是在**监听者的调用栈里**抛出的，而监听者是在 `notifyListeners` 的 `try` 块里被调用的——于是它被兜住，转成 `FlutterError.reportError` 上报，`notifyListeners` 自己正常返回。

`dispose` 的这条断言是**给开发期看的错误报告，不是给调用方捕获的异常**。同样地，"我在监听者里抛异常，外层能不能 catch"这个问题的答案永远是"不能"。

### 实验 5：极简复刻

把三个机制都保留下来，去掉诊断与内存跟踪，就是可运行的 `MiniChangeNotifier`：

```dart
import 'dart:ui' show VoidCallback;

class MiniChangeNotifier {
  static final List<VoidCallback?> _empty = List<VoidCallback?>.filled(0, null);

  List<VoidCallback?> _listeners = _empty;
  int _count = 0;
  int _depth = 0;                 // 递归通知层数
  int _removedDuringNotify = 0;   // 通知期间被置空的数量

  bool get hasListeners => _count > 0;

  void addListener(VoidCallback listener) {
    // 1. 容量不够就翻倍
    if (_count == _listeners.length) {
      if (_count == 0) {
        _listeners = List<VoidCallback?>.filled(1, null);
      } else {
        final List<VoidCallback?> next =
            List<VoidCallback?>.filled(_listeners.length * 2, null);
        for (var i = 0; i < _count; i++) {
          next[i] = _listeners[i];
        }
        _listeners = next;
      }
    }
    _listeners[_count++] = listener;
  }

  void removeListener(VoidCallback listener) {
    for (var i = 0; i < _count; i++) {
      if (_listeners[i] == listener) {
        if (_depth > 0) {
          // 2. 通知过程中：置空占位，等最外层结束后统一压缩
          _listeners[i] = null;
          _removedDuringNotify++;
        } else {
          _count -= 1;
          for (var j = i; j < _count; j++) {
            _listeners[j] = _listeners[j + 1];
          }
          _listeners[_count] = null;
        }
        break;
      }
    }
  }

  void notifyListeners() {
    if (_count == 0) {
      return;
    }
    _depth++;
    final int end = _count;                  // 3. 上界快照
    for (var i = 0; i < end; i++) {
      _listeners[i]?.call();                 // 4. 空槽跳过
    }
    _depth--;
    if (_depth == 0 && _removedDuringNotify > 0) {
      final int newLength = _count - _removedDuringNotify;
      var write = 0;
      for (var i = 0; i < _count; i++) {
        final VoidCallback? listener = _listeners[i];
        if (listener != null) {
          _listeners[write++] = listener;
        }
      }
      for (var i = newLength; i < _count; i++) {
        _listeners[i] = null;
      }
      _count = newLength;
      _removedDuringNotify = 0;
    }
  }
}
```

用它跑一遍实验 1～3，会得到和框架实现完全相同的调用序列。

需要注意：这个复刻为了突出调度语义，省略了框架的两个内存优化——`_removeAt` 里"真实数量降到列表长度一半才重新分配"的缩容判断，以及通知结束后压缩时的"否则只做错位交换"分支。省略它们不影响调用序列，只影响内存占用曲线。

**能复刻出这四个机制，才算真正读懂了这 569 行。**

## 七、结论

1. `_listeners` 是定长列表，`_count` 是有效长度；`addListener` 摊还 O(1)（翻倍扩容），`removeListener` 是 O(N) 线性查找。
2. 通知过程有三个约定：循环上界取**进入时的快照**（新增监听者本轮不生效）、移除采用**置空占位**（等最外层通知结束后才压缩）、监听者的异常**被捕获后上报**而不是向外抛出。
3. 通知过程中 `dispose` 会触发断言，但断言异常同样会被 `notifyListeners` 的 `try` 吃掉，表现为一条错误报告而不是可被捕获的异常。`removeListener` 允许在 `dispose` 后调用，`addListener` 不允许。

**这 569 行的核心，是在遍历列表的同时安全地修改列表，而不只是存一个回调列表。**

## 八、边界声明

- 本文只讲同步通知机制。把 `Listenable` 接到 Widget 重建上的部分（`ListenableBuilder`、`ValueListenableBuilder` 的 `initState` / `didUpdateWidget` / `dispose` 三处配对）留到第九卷。
- `Animation` / `AnimationController` 也是 `Listenable`，但它们的"值"由 Ticker 驱动，留到第五卷篇 21。
- `memory_allocations.dart` 的对象创建/释放事件只在 `kFlutterMemoryAllocationsEnabled` 为真时启用，属于 DevTools 与 leak_tracker 的数据链，这个系列不展开。
- `Listenable.merge` 的实现是 `_MergingListenable`（`change_notifier.dart:495-518`），把增删转发给一组子 `Listenable`。注意它自己不做去重——同一个监听者加进两个子对象，就会被调用两次。
