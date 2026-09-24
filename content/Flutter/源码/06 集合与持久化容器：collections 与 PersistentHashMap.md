# 06 集合与持久化容器：collections 与 PersistentHashMap

> 版本锚点：Flutter 3.44.8 (058e0af2c2)
> 源码路径 `foundation/collections.dart`（359 行）、`foundation/persistent_hash_map.dart`（417 行）

## 一、问题

`PersistentHashMap` 是 foundation 里最"重"的数据结构——417 行实现了一个 HAMT（hash array mapped trie）。

但它的公开 API **只有两个方法**：

```dart
PersistentHashMap<K, V> put(K key, V value);
V? operator [](K key);
```

没有 `remove`、没有 `keys`、没有 `length`、没有 `containsKey`。类文档也直说了这是刻意的：

> Unlike `Map`, this class does not support `null` as a key value and implements only a functionality needed for a specific use case at the core of the framework.

那么问题就是：**什么场景值得为它写 417 行，却只用得上两个方法？**

答案是 `InheritedElement` —— 框架里最核心、也最容易被写错的机制之一。这一篇把 `collections.dart` 里的工具函数和这个"专用容器"一起看清，重点是**为什么它必须不可变**。

## 二、最小 Demo

```dart
import 'package:flutter/foundation.dart';

void main() {
  // 1. 集合相等都是浅比较
  debugPrint('${listEquals(<int>[1, 2], <int>[1, 2])}');                    // true
  debugPrint('${listEquals<List<int>>(<List<int>>[<int>[1]], <List<int>>[<int>[1]])}'); // false

  // 2. 稳定排序：31 和 40 个元素走到不同的分支
  final List<int> keys = <int>[for (var i = 0; i < 40; i++) i % 3];
  debugPrint('${stableOrderAfterSortByKey(keys).take(6).toList()}');

  // 3. 持久化 Map：每次 put 都产生一个新版本
  final PersistentHashMap<Type, String> v1 =
      const PersistentHashMap<Type, String>.empty().put(int, 'int');
  final PersistentHashMap<Type, String> v2 = v1.put(String, 'String');

  debugPrint('${v1[int]} ${v1[String]}');   // int null   ← 旧版本看不到新数据
  debugPrint('${v2[int]} ${v2[String]}');   // int String ← 新版本保留旧数据
}
```

```dart
/// 排序稳定性实验：把 (排序键, 原始序号) 一起排序，
/// 稳定性表现为「相同排序键的项保持原始序号递增」。
List<int> stableOrderAfterSortByKey(List<int> keys) {
  final List<(int, int)> pairs = <(int, int)>[
    for (var i = 0; i < keys.length; i++) (keys[i], i),
  ];
  mergeSort<(int, int)>(pairs, compare: ((int, int) a, (int, int) b) => a.$1 - b.$1);
  return <int>[for (final (int, int) pair in pairs) pair.$2];
}
```

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `collections.dart:25` / `58` / `91` | `setEquals` / `listEquals` / `mapEquals` |
| `collections.dart:113` | `binarySearch` |
| `collections.dart:133` | `const int _kMergeSortLimit = 32;` 插入排序的阈值 |
| `collections.dart:156` | `mergeSort`，稳定性与阈值分叉 |
| `persistent_hash_map.dart:26` | `class PersistentHashMap<K extends Object, V>` |
| `persistent_hash_map.dart:37-43` | `put`：结构未变时直接 `return this` |
| `persistent_hash_map.dart:48-51` | `operator []` |
| `persistent_hash_map.dart:60` | `hashBitsPerLevel = 5`，每层用 5 bit 索引 |
| `persistent_hash_map.dart:85` | `_FullNode`（未压缩节点） |
| `persistent_hash_map.dart:120` | `_CompressedNode`（位图压缩节点） |
| `widgets/framework.dart:5042` | `PersistentHashMap<Type, InheritedElement>? _inheritedElements;` |
| `widgets/framework.dart:6259-6264` | `InheritedElement._updateInheritance`，真实使用点 |

## 四、调用链

### 4.1 三个相等函数：为什么框架不用 `==`

Dart 里 `List` / `Map` / `Set` 的 `==` 是**身份比较**，两个内容相同的列表永远不相等。所以框架自带三个浅比较函数：

```dart
// collections.dart:58-74（节选）
bool listEquals<T>(List<T>? a, List<T>? b) {
  if (a == null) {
    return b == null;
  }
  if (b == null || a.length != b.length) {
    return false;
  }
  if (identical(a, b)) {
    return true;      // 先做一次廉价的身份短路
  }
  for (var index = 0; index < a.length; index += 1) {
    if (a[index] != b[index]) {
      return false;
    }
  }
  return true;
}
```

三个函数的骨架完全一致：**null 检查 → 长度检查 → `identical` 短路 → 逐项 `==`**。

**关键认知**：`identical` 短路不是修辞，是性能优化。框架内部大量比较发生在"同一个实例被复用"的场景，这一步能直接跳过整轮遍历。

另一个必须记住的点是**浅比较**：元素如果是集合类型，比的是它们的 `==`（即身份），不做深比较。文档里明确推荐需要深比较时用 `package:collection` 的 `DeepCollectionEquality`。

```text
listEquals([1,2], [1,2])                          → true
listEquals([[1]], [[1]])                          → false  内层是两个不同实例
final inner = [1]; listEquals([inner], [inner])   → true   内层是同一个实例
```

### 4.2 `mergeSort`：为什么框架要自带排序

`dart:core` 的 `List.sort` 用的是 introsort，**不保证稳定**。而框架里有需要稳定排序的地方，最典型的是 `widgets/focus_traversal.dart`（焦点遍历顺序必须可预测）。

```dart
// collections.dart:156-182（节选）
void mergeSort<T>(List<T> list, {int start = 0, int? end, int Function(T, T)? compare}) {
  end ??= list.length;
  compare ??= _defaultCompare<T>();

  final int length = end - start;
  if (length < 2) {
    return;
  }
  if (length < _kMergeSortLimit) {          // 133 行定义的 32
    _insertionSort<T>(list, compare: compare, start: start, end: end);
    return;
  }
  // ... 归并
}
```

两个设计点：

1. **稳定性**：归并排序天然稳定；`_insertionSort` 也是稳定的（用二分找插入点，相等元素不跨越）。
2. **阈值退化**：少于 32 个元素时改用插入排序。文档给的理由是"For short lists the many moves have less impact than the simple algorithm"，即小列表下移动元素的代价低于归并的额外空间分配。

**关键认知**：`mergeSort` 需要约一倍列表大小的额外空间（注释里写了 "requires extra space of about the same size as the list being sorted"）。这是它不如 `List.sort` 通用的原因，也是它只被少数地方使用的原因。

`binarySearch` 则是一个前置条件很强的工具：**列表必须已经有序**，否则返回 `-1` 只代表"没找到"，不代表"不存在"。

### 4.3 `PersistentHashMap`：不可变，但便宜

```dart
// persistent_hash_map.dart:26-43
class PersistentHashMap<K extends Object, V> {
  const PersistentHashMap.empty() : this._(null);

  const PersistentHashMap._(this._root);

  final _TrieNode? _root;

  PersistentHashMap<K, V> put(K key, V value) {
    final _TrieNode newRoot = (_root ?? _CompressedNode.empty).put(0, key, key.hashCode, value);
    if (newRoot == _root) {
      return this;      // ← 结构没变，复用原实例
    }
    return PersistentHashMap<K, V>._(newRoot);
  }

  V? operator [](K key) {
    return _root?.get(0, key, key.hashCode) as V?;
  }
}
```

它就是**函数式数据结构**（persistent data structure）：`put` 不修改自身，返回一个新版本。`_CompressedNode.put` 内部是"路径复制"——只复制从根到改动点的那一条路径，其余子树整体复用（`identical(newNode, node) ? this : _copy(descendants)`）。

结构上的两个关键参数：

```dart
// persistent_hash_map.dart:59-67
static const int hashBitsPerLevel = 5;
static const int hashBitsPerLevelMask = (1 << hashBitsPerLevel) - 1;

static int trieIndex(int hash, int bitIndex) {
  return (hash >>> bitIndex) & hashBitsPerLevelMask;
}
```

每层用 5 bit（32 路）索引 `hashCode`，所以 32 位 hash 最多需要 7 层。两种节点：

| 节点 | 何时出现 | 特点 |
|---|---|---|
| `_FullNode`（`:85`） | 某个位置的分支数变多时 | 完整 32 元素数组，查表 O(1)，但复制成本高 |
| `_CompressedNode`（`:120`） | 稀疏位置 | 位图 `occupiedIndices` + 紧凑数组 `keyValuePairs`，省内存 |

`_CompressedNode` 的紧凑表示是 HAMT 的核心技巧：用一个 `int` 的 32 个 bit 标记哪些槽位被占用，再用一个长度等于"占用位数"的数组存实际内容，通过 `_compressedIndex(bit)` 在两者间换算。

**关键认知**：`put` 的复杂度是 O(log₃₂ n) 且**返回新实例**。这听起来昂贵，但因为路径复制，新旧版本共享绝大部分节点——所以"每次修改都产生一个新版本"在内存上是可接受的。这正是 `==` 判断在 `put` 里的作用：**没有任何改动时直接返回 `this`，连一次分配都不做。**

### 4.4 真实用途：`InheritedElement` 的继承链查找表

`PersistentHashMap` 在框架里只有一个使用者：

```dart
// widgets/framework.dart:5042
PersistentHashMap<Type, InheritedElement>? _inheritedElements;

// widgets/framework.dart:6259-6264
@override
void _updateInheritance() {
  assert(_lifecycleState == _ElementLifecycle.active);
  final PersistentHashMap<Type, InheritedElement> incomingWidgets =
      _parent?._inheritedElements ?? const PersistentHashMap<Type, InheritedElement>.empty();
  _inheritedElements = incomingWidgets.put(widget.runtimeType, this);
}
```

这段代码的含义需要翻译一下：

每个 `InheritedElement` 都持有**一张从自己往上直到根的完整查找表**（key 是祖先的 `runtimeType`，value 是对应的 `InheritedElement`）。当 `dependOnInheritedWidgetOfExactType<T>()` 要向上找最近的 `InheritedWidget` 时，它不需要沿父链逐级爬——**直接从当前 Element 的这张表里 O(log₃₂ n) 取出**。

用普通 `HashMap` 做这件事的代价是：每次 `mount` 都要把整张表复制一份，N 个节点的树就是 O(N × 表大小)。用 `PersistentHashMap` 之后，子节点的新表与父节点的表**共享绝大部分结构**，每次 `mount` 只付出 O(log₃₂ n) 的路径复制成本。

**关键认知**：这就是"为什么上层那行代码看起来莫名其妙"的答案。在 `framework.dart:6263` 里，"每个 Element 存一份完整查找表"和"每次 put 都新建一个 Map"这两个看起来极昂贵的操作，靠底层持久化数据结构变得便宜。**上层敢这么写，是因为下层先解决了代价问题**——这正是从下往上读源码的价值所在。

## 五、核心对象：`Map` vs `PersistentHashMap`

| | `Map<K, V>` | `PersistentHashMap<K, V>` |
|---|---|---|
| 修改语义 | 原地修改 | 返回新版本（原版本不变） |
| 公开 API | 完整（`remove` / `keys` / `length` / ...） | 只有 `put` 和 `[]` |
| null key | 允许 | **不允许**（文档明确说明） |
| 查询复杂度 | 平均 O(1) | O(log₃₂ n) |
| 修改成本 | 平均 O(1) 摊还 | O(log₃₂ n) + 路径复制 |
| 能否安全共享 | 否（谁改谁负责） | 能（不可变，任意共享） |
| 典型用途 | 通用 | "每个节点持有一份快照"的场景 |

选择标准只有一句：**需要"每个节点都持有一份自己的版本"并且要能安全共享时，才用它。**

## 六、源码实验

### 实验 1：浅比较的边界

```dart
debugPrint('${listEquals(<int>[1, 2], <int>[2, 1])}');   // false  顺序敏感

final List<int> inner = <int>[1];
debugPrint('${listEquals<List<int>>(<List<int>>[inner], <List<int>>[inner])}');  // true  同一实例
debugPrint('${listEquals<List<int>>(<List<int>>[<int>[1]], <List<int>>[<int>[1]])}'); // false 不同实例
```

**预测**：两个 `[[1]]` 内容完全一样，应该相等。

**实际**：`false`。内层 `List` 的 `==` 是身份比较，两个不同的 `[1]` 实例不相等。

**说明**：这解释了框架里一个高频写法——比较配置对象的列表之前，元素类型必须自己重写 `==`（比如 `TextStyle`、`ShapeBorder` 都重写了）。

### 实验 2：验证 `mergeSort` 的稳定性阈值

用第二节的 `stableOrderAfterSortByKey`，分别传 31 和 40 个元素（阈值是 32）：

```dart
for (final int size in <int>[31, 40]) {
  final List<int> keys = <int>[for (var i = 0; i < size; i++) i % 3];
  final List<int> order = stableOrderAfterSortByKey(keys);
  final Map<int, List<int>> byKey = <int, List<int>>{};
  for (final int originalIndex in order) {
    byKey.putIfAbsent(keys[originalIndex], () => <int>[]).add(originalIndex);
  }
  // 每个键对应的原始下标序列必须是递增的
  for (final List<int> indices in byKey.values) {
    debugPrint('size=$size 稳定=${indices.toString() == (List<int>.of(indices)..sort()).toString()}');
  }
}
```

**预测**：两个规模走的是不同算法分支（`_insertionSort` 与归并），稳定性表现可能不一致。

**实际**：两个规模都稳定。两条分支都刻意保证了稳定性。

### 实验 3：`put` 的三种返回值形态

```dart
final PersistentHashMap<Type, String> v1 =
    const PersistentHashMap<Type, String>.empty().put(int, 'int');

// 1. 写回完全相同的键值对
final PersistentHashMap<Type, String> v2 = v1.put(int, 'int');
debugPrint('${identical(v1, v2)}');    // true  ← 直接返回 this

// 2. 同一个键写不同的值
final PersistentHashMap<Type, String> v3 = v1.put(int, 'num');
debugPrint('${identical(v1, v3)}');    // false
debugPrint('${v1[int]} ${v3[int]}');   // int num  ← 旧版本不受影响

// 3. 写一个新的键
final PersistentHashMap<Type, String> v4 = v1.put(String, 'String');
debugPrint('${v1[String]} ${v4[String]}');   // null String
```

**说明**：第 1 种情况返回 `identical` 的实例，是 `put` 里那行 `if (newRoot == _root) return this;` 的直接效果。这一优化对 `_updateInheritance` 尤其重要：**当 Element 的 `runtimeType` 没变（绝大多数 rebuild 场景），整张继承表原封不动地复用**。

### 实验 4：确认唯一使用点

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src
grep -rn "PersistentHashMap" --include="*.dart" . | grep -v "foundation/persistent_hash_map.dart"
```

**实际**：只有两处命中，都在 `widgets/framework.dart`：字段声明 `:5042` 与 `_updateInheritance` 里的 `:6261-6262`。

**说明**：这是"专用容器"的字面意义——417 行实现，服务一个场景。

## 七、结论

1. `listEquals` / `setEquals` / `mapEquals` 都是**浅比较**，骨架为 "null 检查 → 长度检查 → `identical` 短路 → 逐项 `==`"；元素是集合类型时比的是身份，不是内容。
2. `mergeSort` 之所以存在，是因为 `List.sort` 不保证稳定；它在元素数少于 32 时退化为插入排序，两者都保证稳定，代价是需要约一倍列表大小的额外空间。
3. `PersistentHashMap` 是函数式（持久化）数据结构：`put` 返回新版本、路径复制使新旧版本共享结构、结构未变时返回 `this`。它的唯一用途是 `InheritedElement` 的继承链查找表——**让"每个 Element 持有一份完整祖先表"从 O(N × 表大小) 降到 O(log₃₂ n)**。

一句话总结：**上层敢在每次 mount 时新建一张完整的继承表，是因为下层的 `PersistentHashMap` 让"新建"变得便宜。**

## 八、边界声明

- 本篇不展开 `_CompressedNode` / `_FullNode` 的完整节点分裂与冲突解决算法（`_resolveCollision` 等）。需要时按类名读，`persistent_hash_map.dart:120-416` 是完整的 HAMT 实现。
- `dependOnInheritedWidgetOfExactType` 如何用这张表做依赖注册与通知，留到第九卷的 `InheritedWidget` 篇。
- `collections.dart` 里的 `_movingInsertionSort` / `_merge` 等私有辅助函数属于归并排序的标准实现，不做逐行讲解。
- `binarySearch` 的调用者、`unicode.dart`、`stack_frame.dart` 等其他 C 区工具不展开。
