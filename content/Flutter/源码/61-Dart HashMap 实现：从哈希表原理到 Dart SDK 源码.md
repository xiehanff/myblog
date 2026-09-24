---
title: 61-Dart HashMap 实现：从哈希表原理到 Dart SDK 源码
date: 2026-09-24
tags: [Dart, Flutter, 数据结构, 哈希表, 源码分析]
---
# 61-Dart HashMap 的实现：从哈希表原理到 Dart SDK 源码

很多 Dart 教程会把 `Map` 直接当作“字典”使用：

```dart
final scores = <String, int>{'Alice': 90};
print(scores['Alice']);
```

但如果继续追问三个问题，普通用法就不够了：

1. `Map`、`HashMap` 和 `LinkedHashMap` 到底是什么关系？
2. Dart 的哈希表是拉链法还是开放寻址？
3. `hashCode` 算出来之后，SDK 怎样定位、比较、插入、删除和扩容？

这篇文章以本机验证的 Dart SDK 3.12.2 为基线。先给结论：**Dart SDK 没有一个对所有后端都完全相同的 HashMap 实现。** 在 Dart SDK 3.12.2 的 Native VM 实现中，普通 `HashMap` 的核心是“桶数组 + 桶内单链表”，也就是拉链法；默认 `Map` 实际上是插入有序的 `LinkedHashMap`，其 VM 实现使用“索引数组 + 紧凑数据数组 + 开放寻址”。Web、Wasm 等后端还可能使用不同的内部表示。下面涉及初始容量、扩容阈值和探测细节的内容，均属于该版本的实现观察，不是 Dart API 的永久保证。

因此，学习 Dart HashMap 有两个层次：

- 先掌握所有哈希表都必须满足的抽象不变量；
- 再读清 Dart 工厂构造器如何选择实现，以及不同后端的具体布局。

本文中的教学实现故意采用接近 Native VM `HashMap` 的拉链法，但它不是 SDK 的复制品，也不包含类型检查、常量对象、快照、编译器内联和所有 `Map` API。

<!-- GFM-TOC -->
* [一、先区分 Map、HashMap 和 LinkedHashMap](#一先区分-maphashmap-和-linkedhashmap)
* [二、哈希表的核心模型](#二哈希表的核心模型)
* [三、为什么必须同时保存 hashCode 和 key](#三为什么必须同时保存-hashcode-和-key)
* [四、Dart Native VM 的 HashMap：拉链法](#四dart-native-vm-的-hashmap拉链法)
  * [4.1 工厂构造器如何选择实现](#41-工厂构造器如何选择实现)
  * [4.2 entry 节点和桶数组](#42-entry-节点和桶数组)
  * [4.3 查询与覆盖](#43-查询与覆盖)
  * [4.4 插入与冲突](#44-插入与冲突)
  * [4.5 删除](#45-删除)
  * [4.6 扩容与重新散列](#46-扩容与重新散列)
* [五、默认 Map 为什么不是 HashMap](#五默认-map-为什么不是-hashmap)
  * [5.1 LinkedHashMap 的两个数组](#51-linkedhashmap-的两个数组)
  * [5.2 开放寻址与线性探测](#52-开放寻址与线性探测)
  * [5.3 如何同时保留查找效率和插入顺序](#53-如何同时保留查找效率和插入顺序)
  * [5.4 删除标记和重新散列](#54-删除标记和重新散列)
* [六、从零实现一个教学版 Dart HashMap](#六从零实现一个教学版-dart-hashmap)
* [七、hashCode、== 与可变键](#七hashcode与-与可变键)
* [八、复杂度：为什么只能说期望 O(1)](#八复杂度为什么只能说期望-o1)
* [九、平台差异与阅读源码的方法](#九平台差异与阅读源码的方法)
* [十、常见误区与使用建议](#十常见误区与使用建议)
* [参考资料](#参考资料)
<!-- GFM-TOC -->

## 一、先区分 Map、HashMap 和 LinkedHashMap

`Map<K, V>` 是抽象接口，表达“一个键对应一个值”。它不承诺具体的存储结构。Dart SDK 中常见的三种实现可以这样区分：

| 类型 | 查找方式 | 遍历顺序 | 典型用途 |
|---|---|---|---|
| `HashMap<K, V>` | 哈希表 | 不保证顺序 | 只关心按键查找，不需要插入顺序 |
| `LinkedHashMap<K, V>` | 哈希表 | 键的插入顺序 | 大多数业务 Map、Map 字面量 |
| `SplayTreeMap<K, V>` | 平衡搜索树变体 | 按比较结果排序 | 需要有序遍历、范围查询 |

非 `const` 的 Map 字面量和 `Map()` 默认创建的是 `LinkedHashMap`，不是 `HashMap`：

```dart
final a = <String, int>{};
final b = Map<String, int>();

// 两者都按键的插入顺序迭代。
a['first'] = 1;
a['second'] = 2;
print(a.keys.toList()); // [first, second]
```

如果明确不需要顺序，可以写：

```dart
import 'dart:collection';

final unordered = HashMap<String, int>();
```

这里的“无序”不是说每次迭代都一定随机，而是 API 不承诺稳定的语义顺序。某次运行中观察到一个顺序，不能把它当作业务协议的一部分。

另一个容易忽略的事实是：`HashMap` 在 Dart 源码中是抽象的、不可直接由普通 Dart 类体实现的接口风格类；它的 factory constructor 由各运行时通过 patch 绑定到具体实现。看到 `hash_map.dart` 里没有完整的数组和节点代码，并不表示 Dart 没有实现，而是实现被拆到了运行时专用文件。

## 二、哈希表的核心模型

假设我们有一组键值对：

```text
("Alice", 90)
("Bob", 80)
("Carol", 95)
```

如果每次查询都从头遍历所有键，时间复杂度是 `O(n)`。哈希表的目标是把键转换成数组位置：

```text
hash = hashCode(key)
index = reduce(hash, capacity)
```

其中 `capacity` 是桶数组或槽位数组的长度。查询时先通过 `index` 缩小范围，再用键相等性确认是否真的是同一个键。

哈希表必须维护的核心不变量是：

> 如果两个键按照当前映射的相等规则相等，那么它们必须产生相同的哈希值；哈希值相同的两个键不一定相等。

因此查找不是：

```text
hashCode 相同 => 找到了
```

而是：

```text
hashCode 相同 && equals(key1, key2) => 找到了
```

哈希值只是筛选器，`==` 或自定义 `equals` 才是最终裁判。

当桶数量是 2 的幂时，Dart Native VM 可以用位运算取桶下标：

```dart
final index = hashCode & (bucketCount - 1);
```

例如桶数为 8，`bucketCount - 1` 是二进制 `0b111`，这个表达式等价于取哈希值的低 3 位。它通常比 `% bucketCount` 更直接，但前提是桶数量必须是 2 的幂。

## 三、为什么必须同时保存 hashCode 和 key

一个 entry 至少需要保存：

```text
key       原始键，用于最终相等比较
value     关联的值
hashCode  插入时计算出的哈希值
next      冲突链中的下一个 entry
```

查找时先比较保存的 `hashCode`，再比较 `key`：

```text
if (candidate.hashCode == queryHash && candidate.key == queryKey) {
  return candidate.value;
}
```

保存哈希值有两个好处：

1. 同一个桶中存在多个键时，可以先用整数比较快速跳过明显不可能相等的节点；
2. 扩容时不必重新调用键的 `hashCode`，只需用已经保存的哈希值重新计算桶位置。

注意，保存的哈希值并没有让可变键变得安全。如果一个键进入 Map 后改变了参与 `==` 或 `hashCode` 的字段，表里保存的是旧哈希值，而查询时计算的是新哈希值，键就可能落入另一个桶。

## 四、Dart Native VM 的 HashMap：拉链法

### 4.1 工厂构造器如何选择实现

Native VM 中，`HashMap` 的 factory 会根据构造参数选择不同内部类。逻辑可以概括为：

```text
没有自定义 equals/hashCode/isValidKey
    -> 默认 _HashMap

equals 和 hashCode 使用 identical/identityHashCode
    -> 身份 HashMap

提供自定义比较或哈希函数
    -> _CustomHashMap
```

这解释了为什么 `HashMap.identity()` 不只是一个普通布尔选项：它使用 `identical` 判断键是否是同一个对象，并使用 `identityHashCode`，而不是调用对象自己重写的 `==` 和 `hashCode`。

如果传入自定义 `equals` 或 `hashCode`，通常应该成对传入。比如只改变相等规则、不改变哈希规则，会直接破坏哈希表的定位前提。

### 4.2 entry 节点和桶数组

Native VM 的普通 `_HashMap` 可以抽象成下面的结构：

```text
_buckets
 ├── null
 ├── Entry(key=A, value=1, hash=17, next=null)
 ├── Entry(key=B, value=2, hash=10, next=Entry(...))
 ├── null
 └── ...
```

官方实现的初始桶数是 8，桶数组中的每个元素可以指向一条单链表。entry 的关键字段类似：

```dart
// 示意伪代码：节点字段对应 SDK 的内部结构，省略运行时专用类型。
class _HashMapEntry {
  final Object? key;
  Object? value;
  final int hashCode;
  _HashMapEntry? next;

  _HashMapEntry(this.key, this.value, this.hashCode, this.next);
}
```

新 entry 通常插入到桶链表头部。因此同一个桶内的遍历顺序不表示插入顺序，这也是 `HashMap` 不承诺顺序的原因之一。

### 4.3 查询与覆盖

Native VM 中 `containsKey` 和 `operator []` 的核心流程可以写成伪代码：

```dart
// 示意伪代码：展示普通 HashMap 的查询路径。
V? operator [](Object? key) {
  final hash = key.hashCode;
  final index = hash & (_buckets.length - 1);

  var entry = _buckets[index];
  while (entry != null) {
    if (hash == entry.hashCode && entry.key == key) {
      return entry.value as V;
    }
    entry = entry.next;
  }
  return null;
}
```

赋值操作的关键区别是：找到相等键时只更新 value，不增加元素数量，也不增加一个重复键：

```dart
// 示意伪代码：展示普通 HashMap 的覆盖/插入分支。
void operator []=(K key, V value) {
  final hash = key.hashCode;
  final index = hash & (_buckets.length - 1);

  var entry = _buckets[index];
  while (entry != null) {
    if (hash == entry.hashCode && entry.key == key) {
      entry.value = value;
      return;
    }
    entry = entry.next;
  }

  _addEntry(index, key, value, hash);
}
```

所以这段代码的长度仍然是 1：

```dart
final map = <String, int>{};
map['a'] = 1;
map['a'] = 2;
assert(map.length == 1);
assert(map['a'] == 2);
```

### 4.4 插入与冲突

假设 `a` 和 `b` 的哈希值被映射到同一个桶：

```text
bucket[3] -> Entry(b) -> Entry(a) -> null
```

这不是错误，而是拉链法处理冲突的正常状态。新增 entry 时只需要把它挂到链表头：

```dart
// 示意伪代码：展示把新节点挂到桶头的动作。
void _addEntry(int index, K key, V value, int hash) {
  _buckets[index] = _HashMapEntry(
    key,
    value,
    hash,
    _buckets[index],
  );
  _elementCount++;
}
```

如果哈希函数分布较好，平均每条链很短，查询的期望成本接近常数；如果所有键都返回相同哈希值，所有 entry 会落到同一条链，查询退化为线性扫描。

### 4.5 删除

拉链法的删除比开放寻址简单：找到目标 entry 后，把前驱节点的 `next` 指向目标的 `next`。删除头节点时，直接更新桶头：

```dart
// 示意伪代码：展示拉链法删除，不是可直接粘贴的 SDK 源码。
V? remove(Object? key) {
  final hash = key.hashCode;
  final index = hash & (_buckets.length - 1);
  var entry = _buckets[index];
  _HashMapEntry? previous;

  while (entry != null) {
    if (hash == entry.hashCode && entry.key == key) {
      if (previous == null) {
        _buckets[index] = entry.next;
      } else {
        previous.next = entry.next;
      }
      _elementCount--;
      return entry.value;
    }
    previous = entry;
    entry = entry.next;
  }
  return null;
}
```

这里不需要墓碑标记，因为链表中的断开不会影响其他桶内 entry 的定位。墓碑是开放寻址删除时才必须重点处理的问题。

### 4.6 扩容与重新散列

Dart SDK 3.12.2 Native VM 的 `_HashMap` 在非空条目超过桶数组的 75% 时扩容。旧容量为 `8` 时，新增到第 7 个元素后会触发容量变为 `16` 的扩容。

扩容不能只把旧桶复制到新桶：

```text
旧位置 = oldHash & (8 - 1)
新位置 = oldHash & (16 - 1)
```

桶数量变化后，低位掩码变了，entry 可能需要进入不同桶。正确流程是：

```text
1. 创建两倍大的新桶数组
2. 遍历旧桶中的每个 entry
3. 使用保存的 hashCode 重新计算新下标
4. 把 entry 重新挂到新桶
5. 用新数组替换旧数组
```

值得注意的是，SDK 可以复用原来的 entry 节点，只修改 `next` 指针，而不是为每个键值对重新分配一个节点。扩容单次是 `O(n)`，但容量按倍数增长，所以连续插入的总搬迁量是 `O(n)`，平均到每次插入是均摊 `O(1)`。

## 五、默认 Map 为什么不是 HashMap

### 5.1 LinkedHashMap 的两个数组

默认 Map 需要同时满足两个要求：

1. 按键查找要接近期望 `O(1)`；
2. 遍历时要保持键的插入顺序。

在 Dart SDK 3.12.2 的 Native VM 中，`LinkedHashMap` 使用一种紧凑的哈希结构，可以抽象成两个数组：

```text
_data:  [key0, value0, key1, value1, key2, value2, ...]
          └──────── 按插入顺序保存 ────────┘

_index: [探测信息, 探测信息, 探测信息, ...]
          └────── 用于从哈希定位到 _data ──────┘
```

`_data` 负责顺序，`_index` 负责查找。查找索引和实际键值数据分开，避免为了查找而打乱插入顺序。

### 5.2 开放寻址与线性探测

`LinkedHashMap` 的索引数组使用开放寻址。冲突时不创建链表节点，而是继续检查下一个槽位。核心探测序列类似：

```text
slot = firstProbe(hash)
while slot 已占用且不是目标键:
  slot = (slot + 1) & (index.length - 1)
```

该版本 VM 源码的第一次探测还做了一个轻量级扰动：先对哈希低位做乘 3 的混合，再进入线性探测，用来缓和某些连续整数哈希造成的聚簇。

开放寻址的优点是：

- 不需要为每个冲突节点分配链表对象；
- 索引数组连续，缓存局部性通常更好；
- 可以把键值数据紧凑地放在连续数组中。

它的代价是：

- 槽位不能全部占满，否则查找可能没有终点；
- 删除不能简单清空槽位；
- 负载因子过高或墓碑过多时，探测次数会增加。

### 5.3 如何同时保留查找效率和插入顺序

插入新键时，`LinkedHashMap` 做两件事：

```text
1. 在 _index 中通过探测找到空槽
2. 把 key/value 追加到 _data 尾部，并在空槽记录 _data 的位置
```

因此迭代器不需要扫描哈希槽位，也不需要按照槽位顺序输出。它只需要按 `_data` 的 `key0, key1, key2...` 顺序读取。

更新已有键的 value 时，`_data` 中的键位置不变，所以迭代顺序不变。删除后重新插入同一个键时，它会追加到 `_data` 尾部，因此会变成最后一个键。这正是官方 API 所描述的插入顺序语义。

### 5.4 删除标记和重新散列

开放寻址中，假设三个键形成探测链：

```text
slot 3: A
slot 4: B
slot 5: C
```

如果删除 `B` 后直接把 slot 4 变成“空”，查询 `C` 时从 slot 3 开始，检查到 slot 4 的空位就可能误以为 `C` 不存在。

所以删除后的槽位必须标记为“曾经有元素但现在被删除”，也就是墓碑：

```text
slot 3: A
slot 4: DELETED
slot 5: C
```

查询遇到墓碑要继续探测；插入时可以优先复用墓碑。墓碑过多会让查询路径越来越长，因此实现需要重新散列，把有效元素重新放入干净的索引数组。

该版本 Native VM 的紧凑哈希实现通过特殊标记表示未使用和已删除状态，并在数据数组已满或删除项比例过高时重新构建索引。`_data` 的存储顺序可以保留，而 `_index` 可以重新计算。

## 六、从零实现一个教学版 Dart HashMap

下面的实现使用拉链法，刻意模拟 Native VM `HashMap` 的主要思路：

- 桶数组长度保持为 2 的幂；
- 每个 entry 保存 key、value、hashCode 和 next；
- 冲突通过桶内链表解决；
- 负载因子超过 0.75 时扩容；
- 扩容时复用 entry，并按新容量重新挂链。

它没有实现完整的 `Map<K, V>` 接口，也没有处理所有 SDK 边界，只用于理解实现：

```dart
class TeachingHashMap<K, V> {
  static const int _initialCapacity = 8;
  static const double _maxLoadFactor = 0.75;

  List<_Entry<K, V>?> _buckets =
      List<_Entry<K, V>?>.filled(_initialCapacity, null);
  int _size = 0;

  int get length => _size;

  int _bucketIndexFromHash(int hash) {
    // _buckets.length 始终是 2 的幂，因此可以用位掩码取下标。
    return hash & (_buckets.length - 1);
  }

  V? operator [](Object? key) {
    final hash = key.hashCode;
    final index = _bucketIndexFromHash(hash);

    var entry = _buckets[index];
    while (entry != null) {
      if (entry.hashCode == hash && entry.key == key) {
        return entry.value;
      }
      entry = entry.next;
    }
    return null;
  }

  bool containsKey(Object? key) {
    final hash = key.hashCode;
    final index = _bucketIndexFromHash(hash);

    var entry = _buckets[index];
    while (entry != null) {
      if (entry.hashCode == hash && entry.key == key) return true;
      entry = entry.next;
    }
    return false;
  }

  void operator []=(K key, V value) {
    final hash = key.hashCode;
    final index = _bucketIndexFromHash(hash);

    var entry = _buckets[index];
    while (entry != null) {
      if (entry.hashCode == hash && entry.key == key) {
        // 相等键只更新值，不新增 entry。
        entry.value = value;
        return;
      }
      entry = entry.next;
    }

    _buckets[index] = _Entry(key, value, hash, _buckets[index]);
    _size++;

    if (_size / _buckets.length > _maxLoadFactor) {
      _resize();
    }
  }

  V? remove(Object? key) {
    final hash = key.hashCode;
    final index = _bucketIndexFromHash(hash);

    var entry = _buckets[index];
    _Entry<K, V>? previous;
    while (entry != null) {
      if (entry.hashCode == hash && entry.key == key) {
        if (previous == null) {
          _buckets[index] = entry.next;
        } else {
          previous.next = entry.next;
        }
        _size--;
        return entry.value;
      }
      previous = entry;
      entry = entry.next;
    }
    return null;
  }

  void clear() {
    _buckets = List<_Entry<K, V>?>.filled(_initialCapacity, null);
    _size = 0;
  }

  void _resize() {
    final oldBuckets = _buckets;
    final newBuckets =
        List<_Entry<K, V>?>.filled(oldBuckets.length * 2, null);

    for (final oldHead in oldBuckets) {
      var entry = oldHead;
      while (entry != null) {
        final next = entry.next;
        final newIndex = entry.hashCode & (newBuckets.length - 1);

        entry.next = newBuckets[newIndex];
        newBuckets[newIndex] = entry;
        entry = next;
      }
    }
    _buckets = newBuckets;
  }
}

class _Entry<K, V> {
  final K key;
  V value;
  final int hashCode;
  _Entry<K, V>? next;

  _Entry(this.key, this.value, this.hashCode, this.next);
}

class _CollidingKey {
  const _CollidingKey(this.value);

  final String value;

  @override
  bool operator ==(Object other) =>
      other is _CollidingKey && other.value == value;

  @override
  int get hashCode => 7;
}

void main() {
  final map = TeachingHashMap<_CollidingKey, int>();
  for (var i = 0; i < 100; i++) {
    map[_CollidingKey('$i')] = i;
  }
  assert(map.length == 100);
  assert(map[_CollidingKey('0')] == 0);
  assert(map[_CollidingKey('99')] == 99);

  map[_CollidingKey('50')] = 500;
  assert(map.length == 100);
  assert(map[_CollidingKey('50')] == 500);

  assert(map.containsKey(_CollidingKey('20')));
  assert(map.remove(_CollidingKey('20')) == 20);
  assert(!map.containsKey(_CollidingKey('20')));
  assert(map.length == 99);

  map.clear();
  assert(map.length == 0);
  assert(map[_CollidingKey('50')] == null);
}
```

这段代码最值得逐行理解的不是语法，而是三个不变量：

1. `_bucketIndexFromHash` 和 `_resize` 使用同一套下标规则；
2. 链表中的每个 entry 都位于由它的保存哈希值计算出的桶中；
3. 更新、删除和查找都必须同时检查哈希值与键相等性。

如果只改动其中一个操作，就可能得到“插入后查不到”“删除了错误键”或“扩容后数据消失”等问题。

上面的 `V? operator []` 仍然有 Dart Map 的经典限制：当 `V` 允许 `null` 时，`map[key] == null` 既可能表示键不存在，也可能表示键存在但值就是 `null`。需要区分时必须调用 `containsKey`。

## 七、hashCode、== 与可变键

自定义键最重要的规则是：

```text
a == b  =>  a.hashCode == b.hashCode
```

反过来不成立：相同哈希值只是冲突，不能说明两个键相等。

推荐把参与相等判断的字段和参与哈希计算的字段保持完全一致：

```dart
class Point {
  const Point(this.x, this.y);

  final int x;
  final int y;

  @override
  bool operator ==(Object other) {
    return other is Point && other.x == x && other.y == y;
  }

  @override
  int get hashCode => Object.hash(x, y);
}
```

不要把 `hashCode` 当作唯一 ID。不同对象可以合法拥有相同哈希值，哈希表本来就依靠 `==` 处理这种冲突。

更危险的是可变键：

```dart
class UserKey {
  UserKey(this.id);
  int id;

  @override
  bool operator ==(Object other) => other is UserKey && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

final key = UserKey(1);
final map = <UserKey, String>{key: 'data'};
key.id = 2;

// key 仍然可能在内部结构中，但按当前 hashCode 已经无法可靠定位它。
```

因此，放进 `HashMap` 或 `LinkedHashMap` 后，键的相等性和哈希值在整个存放期间都应该保持不变。需要按对象身份做键时，使用 `HashMap.identity()` 或 `LinkedHashMap.identity()`，不要依赖对象内容相等。

自定义 `HashMap` 还可以传入 `isValidKey`。它的用途是：`operator []`、`remove` 和 `containsKey` 接受的是 `Object?`，但自定义哈希函数可能只接受特定类型。`isValidKey` 可以先过滤掉不适合参与比较的对象，避免错误调用自定义函数。

## 八、复杂度：为什么只能说期望 O(1)

设有效键数量为 `n`，桶数量为 `m`，负载因子为：

```text
α = n / m
```

对于拉链法，如果哈希分布近似均匀，桶内平均链长约为 `α`。当实现让 `α` 保持在常数范围内时：

| 操作 | 期望复杂度 | 单次最坏情况 |
|---|---:|---:|
| 查找 | `O(1)` | `O(n)` |
| 插入 | `O(1)` 摊销 | `O(n)`，可能包含扩容 |
| 更新 | `O(1)` | `O(n)` |
| 删除 | `O(1)` | `O(n)` |
| 遍历 | `O(n)` | `O(n)` |

最坏情况来自两个方向：

1. 恶意或糟糕的哈希函数让大量键进入同一个桶；
2. 一次扩容需要重新安放所有 entry。

所以面试中说“HashMap 查询是 `O(1)`”时，完整说法应该是：

> 在哈希分布合理、负载因子有界的前提下，查找的期望复杂度为 `O(1)`；最坏情况仍可能退化到 `O(n)`，扩容的单次成本是 `O(n)`，但倍增扩容使连续插入的均摊成本接近 `O(1)`。

开放寻址也遵循同样的边界，只是成本更直接地表现为探测次数。负载因子越接近 1，空槽越少，未命中查询和插入需要检查的槽位就越多；墓碑过多也会产生类似效果。

## 九、平台差异与阅读源码的方法

不要把某个后端的内部类名写成 Dart 语言层面的永久承诺。以 Dart SDK 3.12.2 为例，源码组织大致体现了这样的分层：

```text
dart:core / dart:collection
        │ 公开 API、抽象接口、文档契约
        ▼
运行时 patch
        │ 根据 VM、Wasm、JavaScript 等后端绑定实现
        ▼
具体数据结构
        │ 链地址法、紧凑开放寻址、JavaScript 对象/Map 等
        ▼
编译器和运行时优化
```

阅读源码时推荐按这个顺序：

1. 先看 `Map`、`HashMap`、`LinkedHashMap` 的公开文档，确认顺序、相等性和可变键契约；
2. 再看 factory constructor，确认普通构造器实际选择哪个内部类；
3. 找 `operator []`、`operator []=`、`remove`、`_resize` 等核心操作；
4. 最后看迭代器、并发修改检测和常量 Map 等附加机制。

当前源码中可以观察到的代表性差异是：

- Dart SDK 3.12.2 Native VM 的普通 `HashMap` 使用桶数组和 `_HashMapEntry` 链表；
- Dart SDK 3.12.2 Native VM 的 `LinkedHashMap` 使用 `_index` 和 `_data`，用开放寻址定位、用数据数组保留插入顺序；
- Dart SDK 3.12.2 的 Wasm 紧凑哈希实现也有索引数组、数据数组、线性探测和删除标记，但底层数组类型和编码方式不同；
- JavaScript 后端可能借助 JavaScript 对象、字典或其他运行时结构来满足 Dart 的 Map 语义。

因此，文章或面试回答最好区分“抽象保证”和“当前实现观察”：复杂度、键契约和顺序语义属于 API 层；初始容量、具体探测扰动、内部哨兵值等属于实现层，可能随 SDK 版本和目标后端变化。

## 十、常见误区与使用建议

### 误区一：`Map` 就是 `HashMap`

错。普通 Map 字面量默认是 `LinkedHashMap`，它保留插入顺序。只有显式使用 `HashMap()` 才是无序哈希表。

### 误区二：哈希值相同就代表键相同

错。哈希冲突是正常情况，必须继续调用 `==` 或自定义 equality。

### 误区三：重写 `==` 不重写 `hashCode` 也可以

错。相等键必须拥有相同哈希值，否则两个逻辑相等的对象可能落入不同桶。

### 误区四：Map 查不到键时一定是没有这个键

不一定。如果值类型允许 `null`，`map[key] == null` 无法区分“键缺失”和“值为 null”。使用 `containsKey`。

### 误区五：删除开放寻址元素后直接清空槽位

错。这样会截断后续元素的探测链。需要墓碑或局部重排，定期重新散列清除墓碑。

### 误区六：可以在遍历 Map 时随便增删键

不应该这样做。Dart SDK 会通过修改计数或校验和检测结构变化，并可能抛出 `ConcurrentModificationError`。如果需要筛选，使用 `removeWhere` 或先复制键列表。

### 实际选择建议

- 业务代码默认使用 `<K, V>{}`，因为插入顺序通常更符合可读性和序列化预期；
- 只需要按键查找、明确不关心顺序时，可以使用 `HashMap<K, V>`；
- 需要排序遍历或范围查询时，考虑 `SplayTreeMap<K, V>`；
- 需要对象身份作为键时，使用 identity 构造器；
- 自定义对象做键时，优先使用不可变字段，并同时实现兼容的 `==` 与 `hashCode`；
- 不要依赖哈希表的内部遍历顺序，也不要把哈希值持久化为跨运行稳定的业务标识。

## 参考资料

- [R1] [Dart API：HashMap](https://api.dart.dev/dart-collection/HashMap-class.html) — `HashMap` 的无序语义、键相等性和构造器契约，核查日期：2026-09。
- [R2] [Dart API：LinkedHashMap](https://api.dart.dev/dart-collection/LinkedHashMap-class.html) — 插入顺序、哈希表语义和自定义 equality/hashCode，核查日期：2026-09。
- [R3] [Dart SDK 3.12.2：`hash_map.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/collection/hash_map.dart) — 公开 `HashMap` factory、identity map 和自定义函数说明。
- [R4] [Dart SDK 3.12.2：Native VM `collection_patch.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/_internal/vm_shared/lib/collection_patch.dart) — `_HashMap` 的桶数组、entry 链表、删除和 75% 扩容逻辑。
- [R5] [Dart SDK 3.12.2：Native VM `compact_hash.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/_internal/vm_shared/lib/compact_hash.dart) — `LinkedHashMap` 的紧凑数据布局、开放寻址、线性探测和删除重散列。
- [R6] [Dart SDK 3.12.2：Wasm `compact_hash.dart`](https://github.com/dart-lang/sdk/blob/3.12.2/sdk/lib/_internal/wasm/common/compact_hash.dart) — 说明不同后端可以使用不同的紧凑哈希实现。
- [R7] [Hello 算法 Dart 版：哈希表](https://www.hello-algo.com/chapter_hashing/hash_map/) — 通用哈希表、冲突和复杂度的入门材料；它不是 Dart SDK 源码解析。

> **一句话总结：** 在 Dart SDK 3.12.2 Native VM 中，`HashMap` 可以理解为“哈希值定位桶、桶内链表处理冲突、75% 负载触发倍增扩容”；默认 `Map` 则是保持插入顺序的 `LinkedHashMap`，其实现使用另一套紧凑的开放寻址结构。这里的容量、阈值和内部探测细节属于实现观察，不是 API 承诺。
