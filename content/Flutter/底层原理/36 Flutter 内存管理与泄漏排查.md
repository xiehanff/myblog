# Flutter 内存管理与泄漏排查

[toc]

## 概念总览

Flutter 应用的内存分为两层：**Dart 堆内存**和 **Native（C/C++）内存**。Dart 堆由虚拟机的垃圾回收器（GC）自动管理，开发者通常不需要手动 `malloc` / `free`；Native 层内存则通过 `dart:ffi` 或 Engine 内部分配，需要手动释放或借助 `Finalizer` 自动管理。

大部分 Flutter 内存问题不是 GC 的算法问题，而是**对象引用链没有被打断**——某个本该被回收的对象被意外持有，GC 无法触及它，导致内存持续增长。这类问题叫"逻辑泄漏"（Logical Leak），也是本文的核心排查对象。

要理解泄漏排查，先要理解 Dart 的内存模型和 GC 策略。只要记住三棵树（Widget / Element / RenderObject）中真正持有状态的是 Element 与 State，本文的泄漏链路分析就都能对上号。

## 一、Dart 内存模型基础

### 1.1 Dart 的内存管理方式

Dart 采用**自动垃圾回收**（Garbage Collection），开发者不需要像 C/C++ 那样手动管理内存。Dart 的 GC 是**分代 + 并发**的设计：新生代用停顿极短的并行复制算法回收；老年代的标记和清除大部分与应用代码**并发执行**，只在标记的起止等少数环节短暂停顿（STW），因此对 UI 帧的干扰被控制在很小的窗口内（见第二节）。

核心规则：

- 所有通过 `new` / 构造函数创建的对象都在**堆**（Heap）上
- **值类型**（`int`、`double`、`bool`、`null`）和**不可变小对象**在 Dart VM 内部有优化，可能不走常规 GC 路径
- 闭包（Closure）捕获的变量会逃逸到堆上，生命周期由 GC 管理
- `dart:ffi` 分配的 Native 内存不受 Dart GC 管理

### 1.2 栈内存 vs 堆内存

Dart VM 内存布局分为三个区域：

| 区域 | 存放内容 | 释放方式 |
|---|---|---|
| 栈内存 (Stack) | 局部变量、函数参数、函数返回地址、值类型副本 | 函数返回后自动释放 |
| 堆内存 (Heap) | `new` 创建的对象、String / List / Map、Widget / Element / State、自定义类实例 | 由 GC 管理 |
| Native 内存 | Skia 图片解码缓冲区、`dart:ffi` malloc 分配的 C 内存、Platform Channel 传输的二进制数据 | 手动释放或 Finalizer |

**栈内存**的特征：

- 分配和释放极快，只需移动栈指针
- 大小固定（Dart VM 有栈大小限制）
- 不产生内存碎片
- 局部变量和函数参数存在栈上

```dart
void example() {
  // localValue 在栈上
  int localValue = 42;

  // person 对象在堆上，栈上的 personRef 是指向堆的引用
  Person personRef = Person('Alice');

  // 函数返回后，栈帧被弹出，localValue 和 personRef 自动失效
  // 但 Person 对象仍在堆上，由 GC 决定何时回收
}
```

**堆内存**的特征：

- 分配由 GC 管理的分配器完成
- 空间较大，但分配/回收有成本
- 长期存活的对象会从 New Space 晋升到 Old Space
- 可能产生内存碎片

### 1.3 Dart 对象在堆上的布局

每个 Dart 对象在堆上的布局分两部分：

| 区域 | 内容 | 大小 |
|---|---|---|
| 对象头 (Object Header) | 类型信息指针 (classId / tags)、GC 标记位 (mark bit)、对象大小 / 哈希码、其他 VM 内部元数据 | 通常 1-2 个机器字 |
| 实例字段 (Fields) | field_1、field_2、...、field_n，按声明顺序排列，引用类型字段占 1 个 word（64 位系统上为 8 字节） | 取决于字段数量 |

VM 可能为了对齐添加 padding。

一个 `String` 对象的简化布局：

```dart
// Dart VM 内部简化结构
class _StringImpl {
  // 对象头
  final int classId;       // 标识 String 类型
  final int tags;          // 包含 GC 标记位、是否 one-byte string 等
  final int hash;          // 缓存的哈希值

  // 实例字段
  final int length;        // 字符串长度
  external Uint8List _data; // 指向实际字符数据的指针
}
```

### 1.4 通过 VM Service 读取内存统计

Dart SDK 并没有在 `dart:developer` 里直接暴露堆统计 API——想拿到 Dart 堆的使用量，标准途径是 **VM Service 协议**（DevTools 的 Memory 面板正是基于它实现的）。

第一步，用 `dart:developer` 的 `Service.getInfo()` 拿到 VM Service 的连接地址：

```dart
import 'dart:developer';

Future<void> printServiceInfo() async {
  final ServiceProtocolInfo info = await Service.getInfo();
  print('协议版本: v${info.majorVersion}.${info.minorVersion}');
  print('Service URI: ${info.serverUri}');            // 未开启时为 null
  print('WebSocket URI: ${info.serverWebSocketUri}'); // 如 ws://127.0.0.1:xxx/xxx/ws
}
```

第二步，用 `package:vm_service` 连上该地址，调用 `getMemoryUsage` 等 RPC 读取统计：

```dart
// pubspec.yaml: dependencies 中添加 vm_service
import 'package:vm_service/vm_service.dart';
import 'package:vm_service/vm_service_io.dart';

Future<void> printMemoryUsage() async {
  final info = await Service.getInfo();
  final wsUri = info.serverWebSocketUri;
  if (wsUri == null) return; // 需要在 debug/profile 模式下运行

  final vmService = await vmServiceConnectUri(wsUri.toString());

  // 1. 先拿到 isolate id
  final vm = await vmService.getVM();
  final isolateId = vm.isolates!.first.id!;

  // 2. 读取内存统计
  final usage = await vmService.getMemoryUsage(isolateId);
  print('堆已使用: ${usage.heapUsage} bytes');
  print('堆容量: ${usage.heapCapacity} bytes');
  print('外部内存: ${usage.externalUsage} bytes');
}
```

在日常排查中，这些数据直接在 DevTools 的 Memory 面板以图表形式查看更方便（见第五节）。

## 二、Dart GC 分代策略详解

### 2.1 分代假说与 Dart GC 架构

Dart GC 的设计基于**分代假说**（Generational Hypothesis）：

> 大多数对象都是"朝生夕死"的——它们在创建后很快就不再被使用。只有少部分对象会长期存活。

基于这个假说，Dart 把堆分为两个区域：

![Dart Heap](./36%20Flutter%20内存管理与泄漏排查.assets/ig_0a47e9c9d2837b2c0169f369ecf94081919325c9599fe8c047-17775607093808.png)

> 图中 Old Space 把回收算法简写为 "Mark-Sweep-Compact"，这是教学上的简化：Dart VM 的老年代实际以**并发 Mark-Sweep** 为主，Compact 是按需执行的可选阶段，详见下文 2.3 节。

### 2.2 Scavenge（新生代 GC）

Scavenge 采用 **Cheney 半空间算法**（Semi-space Copying）：

![Scavenge 过程](./36%20Flutter%20内存管理与泄漏排查.assets/ig_0a47e9c9d2837b2c0169f36a2305148191b3c13bdfc9437020-17775607030256.png)

**Scavenge 的完整流程：**

```
1. 检查根集合（Root Set）：
   · 栈上的局部变量
   · 全局变量
   · 持久句柄（PersistentHandle）

2. 从根集合出发，遍历引用链：
   · 标记可达对象
   · 将可达对象从 from-space 复制到 to-space
   · 更新引用指针（指向 to-space 中的新地址）

3. 清空 from-space（整体释放）

4. 交换 from 和 to 的角色

5. 检查存活次数：
   · 存活次数 ≥ 晋升阈值 → 移动到 Old Space
   · 否则继续留在 New Space
```

**Scavenge 的关键特性：**

| 特性 | 说明 |
|------|------|
| 算法 | Cheney 半空间复制，**并行执行**（多个 GC 工作线程分摊复制工作） |
| 停顿类型 | STW（Stop-The-World）：整个新生代回收期间应用暂停 |
| 耗时 | 停顿与存活对象数量成正比，通常在毫秒级以内（New Space 很小） |
| 碎片 | 无碎片（复制算法天然消除碎片） |
| 分配方式 | Bump pointer 指针递增分配（TLAB，线程本地分配缓冲区，O(1)） |

> 官方实现描述见 Dart VM 源码仓库的 [GC 设计文档](https://github.com/dart-lang/sdk/blob/main/runtime/docs/gc.md)："The new generation is collected by a parallel, stop-the-world semispace scavenger."

### 2.3 老年代 GC：并发 Mark-Sweep（必要时 Mark-Compact）

当 Old Space 使用率接近上限时，Dart 触发老年代回收。它与新生代最大的不同是：**大部分标记和清除工作与应用代码并发执行**，只在标记的起止环节短暂停顿，因此不会像纯 STW 回收器那样一次卡住几十毫秒。

![Mark-Sweep-Compact 经典过程（示意）](./36%20Flutter%20内存管理与泄漏排查.assets/ig_0a47e9c9d2837b2c0169f36b2dc0648191892580a37bbe0714-17775606880174.png)

> 上图是经典算法的教学示意，把 Compact 画成固定第三步；Dart VM 的实际行为以上文为准——老年代以**并发 Mark-Sweep** 为主，Compact（滑动压缩）只在碎片化严重或需要收缩堆时按需执行。

**两个主要阶段：**

1. **Mark（标记）——大部分并发**：标记线程与应用同时运行，从根集合出发标记可达对象。写入屏障（write barrier）负责捕获并发期间应用新写入的引用，保证不漏标。只在标记开始（扫描根）和结束（最终确认）时有短暂 STW 停顿。
2. **Sweep（清除）——并发执行**：遍历 Old Space，把未被标记对象的内存放回**空闲链表（free list）**供后续分配复用；如果某整页对象全部死亡，则把整页归还给操作系统。

**Compact（压缩）是可选的第三步，不是每次回收都执行**：Dart VM 内置滑动压缩器（sliding compactor），只在碎片化严重或需要收缩堆时，才会执行"并发标记 + 并行压缩"这一组合，把存活对象滑移到连续区域并更新所有引用。这也是 VM Service 中 GC 事件会出现 `compact` 类型的原因。

**老年代 GC 的关键特性：**

| 特性 | 说明 |
|------|------|
| 触发条件 | Old Space 使用率超过阈值 |
| 并发性 | 标记、清除均与应用并发，仅短暂 STW（标记起止等环节） |
| 碎片处理 | 常规回收不做移动（用 free list 复用内存）；需要时才执行压缩 |
| 影响 | 常规回收停顿很小；并发标记本身会与 UI 线程争抢 CPU，极端情况下可能造成 jank |

### 2.4 对象晋升到 Old Space 的条件

对象从 New Space 晋升到 Old Space 的条件：

```
对象生命周期
    │
    ├─ 创建 ──► 分配在 New Space (from-space)
    │
    ├─ 第 1 次 Scavenge ──► 存活，复制到 to-space
    │                        (存活计数 +1)
    │
    ├─ 第 2 次 Scavenge ──► 存活，存活计数 ≥ 晋升阈值
    │                        ──► 提升到 Old Space
    │
    └─ 特殊情况：
        · 大对象（超过 New Space 半空间大小）直接分配到 Old Space
        · 闭包捕获的长生命周期对象可能被提前提升
```

> **注意**：具体的晋升策略由 Dart VM 内部决定，会根据运行时状态动态调整（例如触发"提前晋升"）。一般而言，对象在 New Space 中经历**两次** Scavenge 仍存活，就会被提升到 Old Space。

### 2.5 GC 的触发时机

```
┌──────────────────────────────────────────────────┐
│                  GC 触发时机                       │
├──────────────────────────────────────────────────┤
│                                                   │
│  1. New Space 分配失败                             │
│     └─► Scavenge                                  │
│                                                   │
│  2. Old Space 使用率超过阈值                       │
│     └─► 并发 Mark-Sweep（必要时 Mark-Compact）     │
│                                                   │
│  3. 开发者手动触发                                  │
│     └─► getAllocationProfile(isolateId, gc: true) │
│         或 DevTools Memory 面板的 "GC" 按钮        │
│                                                   │
│  4. 帧间隙的空闲时间                                │
│     └─► Dart VM 可能利用空闲时间提前执行 GC          │
│                                                   │
└──────────────────────────────────────────────────┘
```

手动触发 GC 的代码：

```dart
import 'dart:developer';
import 'package:vm_service/vm_service.dart';
import 'package:vm_service/vm_service_io.dart';

// VM Service 协议没有独立的 collectGarbage RPC。
// 惯用做法是调用 getAllocationProfile 并传 gc: true：
// VM 会"尝试"先执行一次 GC，再返回分配统计（不保证一定执行了 GC）。
Future<void> forceGC() async {
  final info = await Service.getInfo();
  final wsUri = info.serverWebSocketUri;
  if (wsUri == null) return;

  final vmService = await vmServiceConnectUri(wsUri.toString());
  final vm = await vmService.getVM();
  final isolateId = vm.isolates!.first.id!;

  await vmService.getAllocationProfile(isolateId, gc: true);
}
```

更简单的方式是直接点 DevTools Memory 面板中的 "GC" 按钮。

### 2.6 监听 GC 事件

`dart:developer` 没有直接暴露 GC 事件流；要拿到 GC 事件，需要通过 VM Service 协议订阅 **GC 流**（DevTools 也是这样实现的）：

```dart
import 'dart:developer';
import 'package:vm_service/vm_service.dart';
import 'package:vm_service/vm_service_io.dart';

Future<void> listenGCEvents() async {
  final info = await Service.getInfo();
  final wsUri = info.serverWebSocketUri;
  if (wsUri == null) return; // debug/profile 模式下才有

  final vmService = await vmServiceConnectUri(wsUri.toString());

  // 1. 订阅 GC 流
  await vmService.streamListen(EventStreams.kGC);

  // 2. 消费 GC 事件
  vmService.onGCEvent.listen((Event event) {
    // gcType 表示本次 GC 的类型，如 scavenger / mark-sweep / mark-compact
    print('GC 事件: ${event.gcType} @ ${event.timestamp}');
  });
}
```

GC 事件的关键字段：

| 字段 | 说明 |
|------|------|
| `gcType` | 本次 GC 的操作类型（scavenger、mark-sweep、mark-compact 等） |
| `timestamp` | 事件时间戳（毫秒，epoch 起） |
| `isolate` | 触发 GC 的 Isolate 引用（`isolate.id` 为其 ID） |

> 如果只关心"GC 发生了几次、耗时多少"，用 DevTools 的 Memory / Performance 面板看 GC 标记更直观；想看每轮 GC 前后的堆用量变化，可轮询 `getMemoryUsage` 或 `getAllocationProfile`。

## 三、Finalizer 与 WeakReference API

### 3.1 `WeakReference<T>`

`WeakReference<T>` 持有对象的**弱引用**——它不会阻止 GC 回收被引用的对象。当对象被回收后，`target` 属性返回 `null`。

> **关键认知**：弱引用的 target 必须是有稳定身份的对象。`num`、`String`、`bool`、`null`、record 以及 `dart:ffi` 指针等**不能**作为 `WeakReference` 的目标（与 `Expando` 的 key 限制一致），构造时会直接抛错——因为这类值随时可以由字面量重新创建出恒等实例，弱引用语义无从谈起。另外官方语义明确：即使 target 只剩弱引用，也不保证弱引用一定会被清除，不要依赖它做关键逻辑。

```
强引用 vs 弱引用：

强引用链（对象不会被 GC）：
Root ──► Object A ──► Object B
                        │
                      Object C  (可达，不会被回收)

弱引用（不阻止 GC）：
Root ──► Object A ──┐
                       ▼
                  WeakReference
                      │
              .target → Object B (如果 B 没有其他强引用，可被回收)
```

代码示例：

```dart
import 'dart:developer';

class CacheEntry {
  final String key;
  final String value;

  CacheEntry({required this.key, required this.value});
}

class WeakCache {
  final List<WeakReference<CacheEntry>> _entries = [];

  void put(CacheEntry entry) {
    _entries.add(WeakReference(entry));
  }

  CacheEntry? get(String key) {
    // 遍历时顺便清理已被回收的条目
    _entries.removeWhere((ref) => ref.target == null);

    for (final ref in _entries) {
      final entry = ref.target;
      if (entry?.key == key) {
        return entry;
      }
    }
    return null;
  }

  int get count => _entries.where((ref) => ref.target != null).length;
}

void main() {
  final cache = WeakCache();

  cache.put(CacheEntry(key: 'user:1', value: 'Alice'));
  cache.put(CacheEntry(key: 'user:2', value: 'Bob'));

  print('缓存数量: ${cache.count}'); // 2

  // 触发 GC 后，如果 CacheEntry 没有其他强引用，
  // 它们可能被回收，WeakReference.target 返回 null
  print('user:1 = ${cache.get('user:1')}?.value'); // Alice 或 null
}
```

### 3.2 `Expando<T>`

`Expando<T>` 是以对象为 key 的 Map，但 key 是**弱引用**。当 key 对象被 GC 回收时，对应的条目自动移除。

```dart
import 'dart:developer';

// Expando：给对象附加额外数据，不阻止回收

class User {
  final String name;
  User(this.name);
}

// 给 User 对象附加缓存数据
final Expando<List<String>> _userCache = Expando<List<String>>();

List<String> getCachedPermissions(User user) {
  return _userCache[user] ?? computePermissions(user);
}

List<String> computePermissions(User user) {
  final permissions = ['read', 'write']; // 模拟计算
  _userCache[user] = permissions; // 附加到 user 对象
  return permissions;
}

void expandoExample() {
  final user = User('Alice');
  final permissions = getCachedPermissions(user);
  print('${user.name}: $permissions'); // Alice: [read, write]

  // user 被回收后，_userCache 中对应的条目自动移除
  // 不会造成内存泄漏
}
```

`Expando` vs `Map<Object, T>` 的关键区别：

| 特性 | `Expando<T>` | `Map<Object, T>` |
|------|-------------|-----------------|
| Key 的引用类型 | 弱引用 | 强引用 |
| Key 被 GC 回收后 | 条目自动移除 | 条目保留，内存泄漏 |
| 适用场景 | 对象附加数据 | 需要精确控制生命周期 |
| 性能 | 略低于 Map | O(1) 查找 |

### 3.3 `Finalizer<T>`（Dart 2.17+）

`Finalizer<T>` 在对象被 GC 回收时执行回调，类似 Java 的 `PhantomReference` + `Cleaner`。这是管理 Native 资源的推荐方式。

```dart
import 'dart:ffi';
import 'dart:io';
import 'dart:developer';

// 模拟 Native 资源管理

// 定义 Native 函数签名
typedef NativeFreeFunc = Void Function(Pointer<Void>);
typedef DartFreeFunc = void Function(Pointer<Void>);

// Finalizer 管理器（全局单例）
class NativeResourceFinalizer {
  // attach 时传入的 detach token 与 target 对象绑定
  // 用 FinalizerEntry 存储 detach token 和 resource 的映射
  static final Finalizer<NativeResource> _finalizer = Finalizer(
    (resource) {
      // 当持有该 resource 的 Dart 对象被 GC 回收时，执行此回调
      print('[Finalizer] 释放 Native 资源: ${resource.pointer}');
      resource.free();
    },
  );

  static void attach(Object owner, NativeResource resource) {
    _finalizer.attach(
      owner,
      resource,
      detach: resource, // 用 resource 本身作为 detach token
    );
  }

  static void detach(NativeResource resource) {
    _finalizer.detach(resource);
  }
}

// Native 资源包装
class NativeResource {
  final Pointer<Void> pointer;
  bool _freed = false;

  NativeResource(this.pointer);

  void free() {
    if (!_freed) {
      _freed = true;
      // 调用 Native free 函数
      // nativeFree(pointer);
      print('Native 内存已释放');
    }
  }

  bool get isFreed => _freed;
}

// Dart 层包装
class NativeImage {
  final NativeResource _resource;
  final int width;
  final int height;

  NativeImage._(this._resource, this.width, this.height);

  factory NativeImage.fromFile(String path) {
    // 模拟从文件加载图片到 Native 内存
    // final pointer = nativeLoadImage(path);
    final pointer = Pointer<Void>.fromAddress(0x12345678); // 模拟地址
    final resource = NativeResource(pointer);

    final image = NativeImage._(resource, 800, 600);

    // 注册 Finalizer：image 被 GC 回收时，释放 resource
    NativeResourceFinalizer.attach(image, resource);

    return image;
  }

  // 如果需要提前释放
  void dispose() {
    NativeResourceFinalizer.detach(_resource);
    _resource.free();
  }
}
```

**`Finalizer` 使用注意事项：**

```
┌──────────────────────────────────────────────────────────┐
│              Finalizer 注意事项                            │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  1. 回调执行时机不确定                                      │
│     · 规范不保证回调一定会执行（No promises are made         │
│       that the callback will ever be called）              │
│     · 回调作为"事件"执行（类似 Timer 事件，不是 microtask），  │
│       绑定到创建 Finalizer 的 zone，在所属 isolate 的        │
│       事件循环中运行——不会跑在别的线程上，但可能有明显延迟      │
│     · 不能依赖回调时序来保证正确性，资源要尽量显式释放          │
│                                                           │
│  2. 回调参数是 token，不是被监控的 target 本身                │
│     · token 会被 Finalizer 强持有直到回调执行                │
│     · 因此 token 不能引用 target——否则 target 永远可达，     │
│       回调永远不触发                                        │
│     · Finalizer 自身必须保持可达（如 static final），         │
│       否则它连同未触发的回调一起被 GC                         │
│                                                           │
│  3. 回调中不能抛出异常                                      │
│     · 规范明确要求 "Finalization callbacks must not throw" │
│                                                           │
│  4. detach 后 Finalizer 不再触发                            │
│     · 用 detach(detachToken) 取消关联                       │
│     · 适用于资源需要提前释放的场景                            │
│                                                           │
│  5. 同一个对象可以被多次 attach                             │
│     · 每个 attachment 独立计数，对象不可达时                  │
│       每个活跃 attachment 至多触发一次回调                    │
│     · detach 按 detach token 精确移除对应 attachment        │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

`Finalizer` 的典型应用场景：

| 场景 | 说明 |
|------|------|
| dart:ffi Native 内存 | `malloc` 分配的内存需要 `free` |
| 文件句柄 | 通过 FFI 打开的文件需要 `close` |
| 数据库连接 | Native 数据库驱动需要释放连接 |
| 图片解码缓冲区 | Native 解码器分配的像素缓冲区 |
| OpenGL 纹理 | 需要调用 `glDeleteTextures` |

## 四、Flutter 中常见的内存泄漏场景

### 4.1 StreamController / Timer 未 dispose

这是最常见的内存泄漏场景之一。`StreamSubscription` 和 `Timer` 在后台持有对回调闭包的引用，而闭包可能捕获了 `State` 或 `BuildContext`。

**泄漏示例：**

```dart
// ❌ 泄漏：StreamSubscription 未取消
class _BadStreamPageState extends State<BadStreamPage> {
  late StreamSubscription<int> _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = Stream.periodic(
      const Duration(seconds: 1),
      (count) => count,
    ).listen((data) {
      // 闭包捕获了 this（State），阻止 State 被 GC
      print('收到数据: $data');
    });
    // 忘记在 dispose 中取消订阅
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('流泄漏')),
      body: Center(child: Text('当前时间: ${DateTime.now()}')),
    );
  }
  // ❌ 缺少 dispose！
}
```

**修复方案：**

```dart
// ✅ 正确：在 dispose 中取消订阅
class _GoodStreamPageState extends State<GoodStreamPage> {
  StreamSubscription<int>? _subscription;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _subscription = Stream.periodic(
      const Duration(seconds: 1),
      (count) => count,
    ).listen(_onData);

    _timer = Timer.periodic(
      const Duration(seconds: 2),
      _onTimer,
    );
  }

  void _onData(int data) {
    if (!mounted) return; // 安全检查
    setState(() {
      // 更新 UI
    });
  }

  void _onTimer(Timer timer) {
    if (!mounted) return;
    setState(() {
      // 更新 UI
    });
  }

  @override
  void dispose() {
    _subscription?.cancel(); // 取消流订阅
    _timer?.cancel();         // 取消定时器
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      appBar: AppBar(title: Text('流正确处理')),
      body: Center(child: Text('OK')),
    );
  }
}
```

**使用 `StreamController` 的完整示例：**

```dart
class MessageBus {
  final StreamController<String> _controller = StreamController<String>.broadcast();

  Stream<String> get messages => _controller.stream;

  void send(String message) {
    _controller.add(message);
  }

  void dispose() {
    _controller.close();
  }
}

class _MessagePageState extends State<MessagePage> {
  final MessageBus _bus = MessageBus();
  StreamSubscription<String>? _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = _bus.messages.listen((message) {
      if (!mounted) return;
      // 处理消息
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _bus.dispose(); // 关闭 controller
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const SizedBox.shrink();
  }
}
```

### 4.2 AnimationController 未 dispose

`AnimationController` 内部持有 `Ticker`，而 `Ticker` 会向 `SchedulerBinding` 注册持续回调。如果不 dispose，`Ticker` 会持续驱动，即使 Widget 已被移除。

**泄漏示例：**

```dart
// ❌ 泄漏：AnimationController 未 dispose
class _BadAnimationState extends State<BadAnimationWidget>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    )..repeat(); // 持续循环动画
    // ❌ 忘记在 dispose 中释放
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Transform.rotate(
          angle: _controller.value * 2 * 3.14159,
          child: child,
        );
      },
      child: const Icon(Icons.star, size: 100),
    );
  }
  // ❌ 缺少 dispose！Ticker 持续运行，持有 State 引用
}
```

**修复方案：**

```dart
// ✅ 正确：dispose AnimationController
class _GoodAnimationState extends State<GoodAnimationWidget>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose(); // 释放 Ticker 和 AnimationController
    // dispose() 内部会：
    // 1. 停止动画
    // 2. 从 SchedulerBinding 取消 Ticker 注册
    // 3. 释放监听器列表
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Transform.rotate(
          angle: _controller.value * 2 * 3.14159,
          child: child,
        );
      },
      child: const Icon(Icons.star, size: 100),
    );
  }
}
```

**多个 AnimationController 的场景：**

```dart
class _MultiAnimationState extends State<MultiAnimationWidget>
    with TickerProviderStateMixin { // 注意：多个 controller 用 TickerProviderStateMixin
  late final AnimationController _fadeController;
  late final AnimationController _slideController;

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      duration: const Duration(milliseconds: 500),
      vsync: this,
    );
    _slideController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
  }

  @override
  void dispose() {
    _fadeController.dispose();
    _slideController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const SizedBox.shrink();
  }
}
```

### 4.3 TextEditingController / ScrollController 未 dispose

Controller 持有监听器列表，而监听器通常是持有 `State` 引用的闭包。如果不 dispose，Controller 会通过监听器间接持有 State。

**泄漏链路分析：**

```
TextEditingController
  └── _listeners (List<VoidCallback>)
        └── 闭包（捕获了 State 的 this）
              └── State
                    └── Element
                          └── RenderObject
```

**泄漏示例：**

```dart
// ❌ 泄漏：Controller 未 dispose
class _BadControllerState extends State<BadControllerPage> {
  final TextEditingController _textController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    _textController.addListener(() {
      // 闭包捕获 this → State 无法被 GC
      print('文本变化: ${_textController.text}');
    });
    _scrollController.addListener(() {
      // 同理
      print('滚动位置: ${_scrollController.offset}');
    });
  }
  // ❌ 缺少 dispose！Controller 的 _listeners 持有 State 引用
}
```

**修复方案：**

```dart
// ✅ 正确：dispose 所有 Controller
class _GoodControllerState extends State<GoodControllerPage> {
  late final TextEditingController _textController;
  late final ScrollController _scrollController;

  @override
  void initState() {
    super.initState();
    _textController = TextEditingController();
    _scrollController = ScrollController();

    _textController.addListener(_onTextChanged);
    _scrollController.addListener(_onScroll);
  }

  void _onTextChanged() {
    if (!mounted) return;
    print('文本变化: ${_textController.text}');
  }

  void _onScroll() {
    if (!mounted) return;
    print('滚动位置: ${_scrollController.offset}');
  }

  @override
  void dispose() {
    // 方式 1：先移除监听器再 dispose（可选但更安全）
    _textController.removeListener(_onTextChanged);
    _scrollController.removeListener(_onScroll);

    // 方式 2：直接 dispose（dispose 会清空监听器列表）
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Controller 管理')),
      body: Column(
        children: [
          TextField(controller: _textController),
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              itemBuilder: (context, index) => ListTile(
                title: Text('Item $index'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
```

### 4.4 闭包捕获 context / state

闭包（Closure）会隐式捕获外部作用域中的变量。如果闭包捕获了 `BuildContext` 或 `State`，并且闭包的生命周期超过了 Widget 本身，就会导致泄漏。

**常见场景：**

```dart
// ❌ 场景 1：async 回调中引用 context
class _BadAsyncState extends State<BadAsyncPage> {
  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: () async {
        final result = await fetchData(); // 耗时操作
        // context 可能已经失效！Widget 可能已被移除
        // 但闭包持有 context 的引用，阻止 Element 被 GC
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('结果: $result')),
        );
      },
      child: const Text('加载数据'),
    );
  }
}

// ✅ 修复：使用 mounted 检查
class _GoodAsyncState extends State<GoodAsyncPage> {
  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: () async {
        final result = await fetchData();
        if (!mounted) return; // Widget 已被移除，直接返回
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('结果: $result')),
        );
      },
      child: const Text('加载数据'),
    );
  }
}
```

```dart
// ❌ 场景 2：在 State 中缓存 context
class _BadCachedContextState extends State<BadCachedContextPage> {
  BuildContext? _cachedContext; // ❌ 不应该在 State 中缓存 context

  @override
  Widget build(BuildContext context) {
    _cachedContext = context; // ❌ 缓存的 context 可能过期
    return ElevatedButton(
      onPressed: () {
        // 使用缓存的 context，可能指向已卸载的 Element
        Navigator.of(_cachedContext!).pop();
      },
      child: const Text('返回'),
    );
  }
}

// ✅ 修复：不要缓存 context，在需要时使用当前的 context
class _GoodNoCachedContextState extends State<GoodNoCachedContextPage> {
  @override
  Widget build(BuildContext context) {
    return Builder(builder: (context) {
      return ElevatedButton(
        onPressed: () {
          // 使用 Builder 提供的最新 context
          Navigator.of(context).pop();
        },
        child: const Text('返回'),
      );
    });
  }
}
```

```dart
// ❌ 场景 3：静态回调中持有 State 引用
class _BadStaticCallbackState extends State<BadStaticCallbackPage> {
  static void Function()? _callback; // 静态变量持有闭包

  @override
  void initState() {
    super.initState();
    // ❌ 闭包捕获 this（State），存入静态变量 → 永远不会被 GC
    _callback = () {
      print('State: $this');
    };
  }

  @override
  void dispose() {
    _callback = null; // ✅ 必须在 dispose 中清除
    super.dispose();
  }
}
```

### 4.5 GlobalKey 持有 Element

`GlobalKey` 在整个应用中唯一标识一个 `Element`。Framework 内部由 `BuildOwner` 维护一张全局注册表 `_globalKeyRegistry`（`Map<GlobalKey, Element>`），`GlobalKey.currentContext` / `currentState` 就是从这张表查出对应的 Element 和 State。

```
GlobalKey 的内部结构（简化，对应 Flutter 3.x framework.dart）：

class BuildOwner {
  // 全局注册表：所有 GlobalKey → Element 的映射
  final Map<GlobalKey, Element> _globalKeyRegistry = {};
}

abstract class GlobalKey<T extends State<StatefulWidget>> extends Key {
  // 通过注册表取当前 Element
  Element? get _currentElement =>
      WidgetsBinding.instance.buildOwner!._globalKeyRegistry[this];

  BuildContext? get currentContext => _currentElement;
  // currentState 则从查到的 StatefulElement 上取
}
```

> **先澄清一个常见误解**：注册表条目在 `Element.mount` 时写入、`Element.unmount` 时移除（源码中是 `owner!._unregisterGlobalKey(key, this)`）。页面被正常弹出、Element 完成卸载后，**static GlobalKey 本身并不会把 Element 一直钉在注册表里**。真正的泄漏来自下面几种用法。

**泄漏模式 1：把 `currentState` / `currentContext` 缓存到长生命周期对象**

```dart
// ❌ 泄漏：把 GlobalKey 拿到的 State 存进 static 集合
class PageStore {
  // ❌ static 列表持有 State 强引用
  static final List<State> _states = [];

  static void remember(State state) => _states.add(state);
}

// 在页面里：
// PageStore.remember(_pageKey.currentState!);
// 页面被 Navigator 弹出后，static 列表仍然持有 State
// → Element、State、RenderObject 全部无法被 GC
```

**泄漏模式 2：static `GlobalObjectKey` 强持有 value 对象**

```dart
// ❌ GlobalObjectKey 的身份来自 value，内部强引用 value
class _MyKey extends GlobalObjectKey {
  const _MyKey(super.value);
}

// static final _key = _MyKey(someBigObject);
// 即使页面退出，someBigObject 也随 static key 一起活到应用结束
```

**泄漏模式 3：跨页面复用 key 导致 State 残留**

用 static GlobalKey 在多个页面间"搬运"同一棵子树（reparent），会让旧页面的 State 被新页面继续持有，页面生命周期与 State 生命周期脱钩，排查问题时极易被误导。

**修复方案：**

```dart
// ✅ 方案 1：使用局部 GlobalKey（随 Widget 一起销毁）
class GoodGlobalKeyPage extends StatefulWidget {
  const GoodGlobalKeyPage({super.key});

  @override
  State<GoodGlobalKeyPage> createState() => _GoodGlobalKeyPageState();
}

class _GoodGlobalKeyPageState extends State<GoodGlobalKeyPage> {
  // GlobalKey 是 State 的实例变量，随 State 一起销毁
  final GlobalKey _formKey = GlobalKey<FormState>();

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _formKey,
      child: Column(
        children: [
          TextFormField(validator: (v) => v?.isEmpty ?? true ? '必填' : null),
          ElevatedButton(
            onPressed: () {
              if (_formKey.currentState?.validate() ?? false) {
                // 提交表单
              }
            },
            child: const Text('提交'),
          ),
        ],
      ),
    );
  }
  // Element unmount 时 framework 会自动调用 _unregisterGlobalKey
  // 移除注册表条目；key 作为 State 的实例字段也随 State 一起回收
}
```

```dart
// ✅ 方案 2：需要全局 Key 时，及时清理
class GlobalKeyManager {
  static final Map<String, GlobalKey> _keys = {};

  static GlobalKey getKey(String id) {
    return _keys.putIfAbsent(id, () => GlobalKey());
  }

  static void removeKey(String id) {
    _keys.remove(id);
  }
}

// 使用时在 dispose 中清理
class PageWithManagedKey extends StatefulWidget {
  const PageWithManagedKey({super.key});

  @override
  State<PageWithManagedKey> createState() => _PageWithManagedKeyState();
}

class _PageWithManagedKeyState extends State<PageWithManagedKey> {
  late final GlobalKey _key;

  @override
  void initState() {
    super.initState();
    _key = GlobalKeyManager.getKey('my-page');
  }

  @override
  void dispose() {
    GlobalKeyManager.removeKey('my-page');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(key: _key);
  }
}
```

### 4.6 静态变量持有 Widget / State 引用

静态变量的生命周期与应用一样长。如果静态变量持有了 Widget、State 或 Element 的引用，这些对象永远不会被 GC 回收。

```dart
// ❌ 泄漏：全局缓存 Widget 实例
class WidgetCache {
  // ❌ 全局 Map 持有 Widget 引用 → Widget 永远不会被回收
  static final Map<String, Widget> _cache = {};

  static Widget get(String key) {
    return _cache[key] ?? const SizedBox.shrink();
  }

  static void put(String key, Widget widget) {
    _cache[key] = widget; // Widget 可能持有 context、theme 等
  }
}

// ✅ 修复：用 WeakReference 或只缓存配置数据
class SafeWidgetCache {
  // ✅ 缓存的是配置数据（值类型），不是 Widget 实例
  static final Map<String, Map<String, dynamic>> _configCache = {};

  static Widget buildFromCache(String key) {
    final config = _configCache[key];
    if (config == null) return const SizedBox.shrink();

    // 根据配置动态创建 Widget（每次创建新实例）
    return _buildWidget(config);
  }

  static Widget _buildWidget(Map<String, dynamic> config) {
    return Container(
      color: config['color'] as Color?,
      child: Text(config['text'] as String? ?? ''),
    );
  }
}
```

```dart
// ❌ 泄漏：静态 Map 缓存 State
class _LeakingState extends State<LeakingWidget> {
  static final Map<int, State> _stateRegistry = {};

  @override
  void initState() {
    super.initState();
    // ❌ State 被注册到全局 Map → 永远不会被回收
    _stateRegistry[identityHashCode(this)] = this;
  }

  @override
  void dispose() {
    _stateRegistry.remove(identityHashCode(this)); // ✅ 必须清理
    super.dispose();
  }
}
```

### 4.7 Native 资源未释放（FFI 场景）

通过 `dart:ffi` 分配的 C 内存不受 Dart GC 管理。如果忘记 `free`，就会导致 Native 层内存泄漏——DevTools 的 Memory 图表只能看到 external 内存在涨（VM 会计入 external 统计），但**看不到这些对象在 Dart 堆中的引用链与分配栈**，精确定位需要用平台级工具（Android Perfetto、Xcode Instruments 等）。

```dart
import 'dart:ffi';
import 'dart:io';
import 'dart:developer';

// ❌ 泄漏：malloc 后未 free
DynamicLibrary _nativeLib = DynamicLibrary.open('native_lib.so');

// Native 函数
typedef NativeMalloc = Pointer<Void> Function(Uint64 size);
typedef DartMalloc = Pointer<Void> Function(int size);

typedef NativeFree = Void Function(Pointer<Void>);
typedef DartFree = void Function(Pointer<Void>);

final Pointer<Void> Function(int) nativeMalloc =
    _nativeLib.lookupFunction<NativeMalloc, DartMalloc>('malloc');

final void Function(Pointer<Void>) nativeFree =
    _nativeLib.lookupFunction<NativeFree, DartFree>('free');

class NativeBuffer {
  final Pointer<Void> pointer;
  final int size;

  NativeBuffer(this.size) : pointer = nativeMalloc(size);

  // ❌ 缺少 free 方法
}

void badExample() {
  final buffer = NativeBuffer(1024 * 1024); // 分配 1MB
  // 使用 buffer...
  // 函数返回后，buffer 对象被 GC，但 Native 内存没有释放
  // 每次调用都泄漏 1MB
}
```

**使用 Finalizer 修复：**

```dart
// ✅ 使用 Finalizer 自动管理 Native 内存
class SafeNativeBuffer {
  final Pointer<Void> pointer;
  final int size;

  SafeNativeBuffer(this.size) : pointer = nativeMalloc(size) {
    // 注册 Finalizer
    _finalizer.attach(this, pointer, detach: pointer);
  }

  // 手动释放（可选）
  void free() {
    _finalizer.detach(pointer);
    nativeFree(pointer);
  }

  // Finalizer 回调
  static final Finalizer<Pointer<Void>> _finalizer = Finalizer((ptr) {
    nativeFree(ptr);
    print('Native 内存已通过 Finalizer 释放');
  });
}
```

## 五、DevTools Memory 面板使用

### 5.1 Memory 面板核心功能

Dart DevTools 的 Memory 面板是排查内存问题的主要工具，提供以下核心功能：

```
┌──────────────────────────────────────────────────────────────┐
│                    DevTools Memory 面板                      │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────────────────────────────────────────────┐     │
│  │           内存使用趋势图 (Expandable Chart)          │     │
│  │                                                      │     │
│  │   MB  ┤                                            │     │
│  │       │          ╱╲    ╱╲    ╱╲                     │     │
│  │       │         ╱  ╲  ╱  ╲  ╱  ╲   ╱               │     │
│  │       │        ╱    ╲╱    ╲╱    ╲ ╱                │     │
│  │       │   ╱╲──╱                         ╱           │     │
│  │       │──╱                                 ╱──↑ 泄漏  │     │
│  │       └──────────────────────────────────────→ 时间   │     │
│  │                                                      │     │
│  │   ↑ 每次进出页面后           GC 后基线持续上升        │     │
│  │     GC 没有回到基线                                │     │
│  └────────────────────────────────────────────────────┘     │
│                                                               │
│  ┌────────────────┐  ┌────────────────┐                      │
│  │  快照对比        │  │  实例追踪        │                      │
│  │  (Diff          │  │  (Trace         │                      │
│  │   Snapshots)    │  │   Instances)    │                      │
│  │  操作前后堆对比   │  │  对象分配调用栈  │                      │
│  └────────────────┘  └────────────────┘                      │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**三种核心工具的对比：**

| 工具 | 作用 | 使用时机 |
|------|------|---------|
| 内存趋势图（Expandable Chart） | 观察内存随时间变化的趋势 | 发现是否有泄漏（持续上升） |
| Diff Snapshots（快照对比） | 对操作前后的堆快照做差量 | 找到具体哪些对象没被释放 |
| Trace Instances（实例追踪） | 追踪指定类的实例及其分配调用栈 | 定位泄漏对象的创建位置 |

> 当前 DevTools Memory 面板的标签为 Profile Memory（按类查看当前分配）、Diff Snapshots（快照对比）和 Trace Instances（实例追踪），见官方文档 [Use the Memory view](https://docs.flutter.dev/tools/devtools/memory)。

### 5.2 使用快照对比（Diff Snapshots）排查泄漏

**标准排查流程：**

```
步骤 1：操作应用
  ──► 进入目标页面
  ──► 执行操作（如加载数据、启动动画）
  ──► 退出页面

步骤 2：手动触发 GC
  ──► 在 DevTools Memory 面板点击 "GC" 按钮
  ──► 等待 GC 完成

步骤 3：拍摄快照 A（基线）
  ──► 在 Diff Snapshots 标签点击 "Snapshot" 按钮

步骤 4：重复进入退出页面 N 次（如 5 次）

步骤 5：再次触发 GC + 拍摄快照 B

步骤 6：对比快照 A 和快照 B
  ──► 查找数量异常增长的对象类型
  ──► 关注 Retained Size（保留大小）

步骤 7：分析引用链
  ──► 选中可疑对象 → 查看 "Retainers" 面板
  ──► 找到持有引用的对象
  ──► 定位泄漏根因
```

**Retained Size vs Shallow Size：**

```
Shallow Size（自身大小）：
  对象自身占用的内存，不包含引用的其他对象。

Retained Size（保留大小）：
  如果回收该对象，总共能释放的内存。
  包括该对象本身 + 只有通过该对象才能到达的其他对象。

示例：
  Object A (16 bytes)
    └──► Object B (32 bytes)
          └──► Object C (64 bytes)

  A 的 Shallow Size = 16 bytes
  A 的 Retained Size = 16 + 32 + 64 = 112 bytes

  如果 B 还有另一个引用者 D：
  A 的 Retained Size = 16 bytes（回收 A 不影响 B 和 C）
```

### 5.3 使用实例追踪（Trace Instances）

Trace Instances 可以追踪指定类的实例及其分配位置，帮助你找到泄漏对象是在哪里被创建的。

```
使用步骤：

1. 在 DevTools Memory 面板切换到 "Trace Instances" 标签
2. 选择要追踪的类（如 "_MyPageState"、"Element" 相关类型）
3. 点击 "Start Recording" 开始记录
4. 操作应用（进入/退出页面、滚动列表等）
5. 点击 "Stop Recording" 停止记录
6. 查看记录到的实例：
   - 实例数量随操作次数线性增长 → 有泄漏嫌疑
   - 点开实例可查看分配位置的调用栈（Allocation Stack）
7. 结合 Diff Snapshots 确认这些实例是否真的没有被回收
```

### 5.4 内存泄漏的特征

**特征 1：锯齿形上升曲线**

```
正常 GC 行为：
  内存 ┤    ╱╲    ╱╲    ╱╲    ╱╲
        │   ╱  ╲  ╱  ╲  ╱  ╲  ╱  ╲
        │──╱    ╲╱    ╲╱    ╲╱    ╲──
        └──────────────────────────────→ 时间
        ↑ GC 后回到大致相同的基线

内存泄漏：
  内存 ┤           ╱╲    ╱╲
        │      ╱╲╱  ╲  ╱  ╲
        │  ╱╲╱      ╲╱    ╲
        │╱                  ╲──────→ 持续上升
        └──────────────────────────────→ 时间
        ↑ 每次操作后基线都更高
```

**特征 2：重复操作后对象数量增长**

```
正常情况：
  进入页面 → State 实例: 1
  退出页面 → State 实例: 0（被 GC）
  进入页面 → State 实例: 1
  退出页面 → State 实例: 0

泄漏情况：
  进入页面 → State 实例: 1
  退出页面 → State 实例: 1（没有被 GC！）
  进入页面 → State 实例: 2
  退出页面 → State 实例: 2
  进入页面 → State 实例: 3
  ...持续增长
```

### 5.5 Dart DevTools 命令行工具

```bash
# 启动 DevTools（会输出一个可在浏览器打开的地址）
dart devtools

# 指定端口
dart devtools --port=9100
```

日常开发中通常不需要手动启动：`flutter run` 会自动拉起 DevTools 并在终端输出地址。

在代码中获取 VM Service URL：

```dart
import 'dart:developer';

Future<void> main() async {
  // debug/profile 模式下查询 VM Service 地址
  final info = await Service.getInfo();
  print('DevTools 可通过该地址连接: ${info.serverUri}');

  runApp(const MyApp());
}
```

也可以在终端运行 `flutter run` 时查看输出的 DevTools URL。

## 六、代码级别的内存排查技巧

### 6.1 `debugDumpApp()` 打印 Widget / Element / RenderObject 树

```dart
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

void dumpApp() {
  // 打印 Widget 树
  debugDumpApp();

  // 打印 Element 树（通过 RenderObject 的 debug 输出）
  debugDumpRenderTree();

  // 打印特定 RenderObject 的层级
  // debugDumpLayerTree();
}
```

这在排查"为什么某个 Widget 没有被销毁"时很有用——如果 Widget 树中仍然能看到它，说明有引用链阻止了它的回收。

### 6.2 调试标志位

```dart
void main() {
  // 标记布局脏节点时打印调用栈
  debugPrintMarkNeedsLayoutStacks = true;

  // 标记绘制脏节点时打印调用栈
  debugPrintMarkNeedsPaintStacks = true;

  // 打印每帧实际参与布局的脏 RenderObject
  debugPrintLayouts = true;

  runApp(const MyApp());
}
```

### 6.3 leak_tracker：官方测试泄漏检测

Flutter 官方提供了 **leak_tracker** 系列包（`flutter_test` 已内置依赖 `leak_tracker_flutter_testing`），能在 widget 测试中自动检测"未 dispose / 未被 GC"的对象。Framework 内部的 `ChangeNotifier`、`AnimationController` 等都做了插桩，所以页面里忘记 dispose 的控制器会在测试结束时直接报泄漏。

**在 widget 测试中启用（推荐）：**

```yaml
# pubspec.yaml
dev_dependencies:
  flutter_test:
    sdk: flutter
  # 版本号由 Flutter SDK 决定，写 any 即可（可选，通常无需手动添加）
  leak_tracker_flutter_testing: any
```

```dart
// test/flutter_test_config.dart（对整个测试包生效，自动被执行）
import 'dart:async';
import 'package:leak_tracker_flutter_testing/leak_tracker_flutter_testing.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  // 1. 必须显式开启：LeakTesting 默认是关闭的（leak_tracker_testing 中 _enabled = false），
  //    只设置 settings 不会启动检测
  LeakTesting.enable();
  // 2. 按需忽略已知无害的泄漏
  LeakTesting.settings = LeakTesting.settings.withIgnored(
    classes: ['SomeKnownLeakyClass'], // 按类名忽略
  );
  await testMain();
}

// enable 之后，testWidgets 才会自动检测两类泄漏：
// 1. not disposed：对象创建后从未 dispose（如 AnimationController）
// 2. not GCed：对象 dispose 后仍未被 GC（说明有引用链没断）
// 检测到泄漏时，测试会失败并列出泄漏对象与创建时的调用栈
// 注意：包只提供 enable()，没有公开的 disable()；单个测试想暂停检测
// 用 LeakTesting.settings = LeakTesting.settings.withIgnoredAll()
```

**在运行中的应用里检测（实验性）：**

```dart
import 'package:flutter/foundation.dart';
import 'package:leak_tracker/leak_tracker.dart';

void main() {
  // 把 Flutter 框架对象的创建/销毁事件喂给 leak_tracker
  FlutterMemoryAllocations.instance.addListener(
    (ObjectEvent event) => LeakTracking.dispatchObjectEvent(event.toMap()),
  );
  LeakTracking.start();

  runApp(const MyApp());
  // debug 模式下运行并操作应用，控制台会周期性输出：
  // leak_tracker: N memory leak(s): not disposed: N, ...
}
```

详细用法见官方文档：[Detect Memory Leaks](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/DETECT.md)。

> 补充一个通用调试技巧：设置 `FlutterError.onError` 可以集中捕获 dispose 阶段抛出的异常（例如对已 dispose 的对象重复操作），这类错误往往就是泄漏的伴随症状。

### 6.4 自定义内存日志

在开发和调试阶段，可以添加对象创建/销毁日志来追踪生命周期：

```dart
class TrackedState<T extends StatefulWidget> extends State<T> {
  static int _instanceCounter = 0;
  final int _instanceId;

  TrackedState() : _instanceId = ++_instanceCounter {
    // 注意用 runtimeType（实例类型）而不是 T.runtimeType
    // T.runtimeType 拿到的是 Type 对象自身的类型，只会打印 "Type"
    debugPrint('[Lifecycle] ${runtimeType} #$_instanceId created');
  }

  @override
  void initState() {
    super.initState();
    debugPrint('[Lifecycle] ${runtimeType} #$_instanceId initState');
  }

  @override
  void dispose() {
    debugPrint('[Lifecycle] ${runtimeType} #$_instanceId dispose');
    super.dispose();
  }
}

// 使用
class MyPageState extends TrackedState<MyPage> {
  @override
  Widget build(BuildContext context) {
    return const SizedBox.shrink();
  }
}
```

### 6.5 引用计数与 `WeakReference` 监控

用 `Expando` / `WeakReference` 可以在开发期监控对象是否被正确释放，但有两个陷阱必须先说清楚：

> **陷阱 1：Expando 的 value 是强引用。** Expando 对 key（被监控对象）是弱引用，但对 value 是强持有。如果写成 `_expando[object] = object`，检测器自己就把对象"钉"在了内存里——对象永远显示存活，监控形同虚设。value 必须是独立的哨兵对象。
>
> **陷阱 2：不能在捕获了对象的闭包里探活。** 比如 `Future.delayed(3 秒, () => _expando[object] != null)`——这个闭包本身就是 object 的强引用者，回调执行时对象必然可达，结果永远是"存活"。探活必须通过不引用对象本身的第三方结构（如 WeakReference 列表）来做，而且要等到 GC 发生之后。

规避掉这两个陷阱后，最小可用的监控器长这样：

```dart
import 'dart:developer';

/// 泄漏检测器（简化版：弱引用列表 + 手动探活）
class LeakDetector<T extends Object> {
  final String name;

  // 1. 列表里只放弱引用，不阻止对象被回收
  final List<WeakReference<T>> _tracked = [];
  int _created = 0;

  LeakDetector(this.name);

  /// 注册一个对象，开始监控
  void track(T object) {
    _created++;
    _tracked.add(WeakReference(object));
    debugPrint('[LeakDetector] $name: 创建 #$_created');
  }

  /// 在触发过 GC 之后调用，统计仍存活的对象数
  int get aliveCount {
    // 2. 顺手清理已被回收的条目
    _tracked.removeWhere((ref) => ref.target == null);
    return _tracked.length;
  }

  void report() {
    final alive = aliveCount;
    debugPrint('[LeakDetector] $name: 总创建 $_created, 当前存活 $alive'
        '${alive > 0 ? '（可能泄漏）' : '（无泄漏）'}');
  }
}

// 使用：
// 1. initState 里 detector.track(this)
// 2. 页面退出后，先触发一次 GC（DevTools 的 GC 按钮或 getAllocationProfile(gc: true)）
// 3. 再调用 detector.report() 查看存活数量
```

注意 `aliveCount` 的结果依赖"GC 已经跑过"这个前提——GC 没跑，WeakReference 不会清空，存活数偏高不代表泄漏。下一节给出可直接复用、带测试断言的完整版本。

### 6.6 完整的 `LeakDetector` 工具类

以下是一个更实用的泄漏检测工具类，适用于开发和测试环境：

```dart
import 'dart:async';
import 'dart:developer';

/// 内存泄漏检测工具
///
/// 用法：
/// ```dart
/// final detector = LeakDetector<StatefulWidget>('MyWidget');
///
/// // 在 initState 中注册
/// detector.track(this);
///
/// // 在测试中验证
/// await detector.expectNoLeaks();
/// ```
class LeakDetector<T extends Object> {
  static final Map<String, LeakDetector> _detectors = {};

  final String name;
  final Map<int, WeakReference<T>> _tracked = {};
  final Expando<int> _instanceIds = Expando<int>();
  int _nextId = 0;
  int _totalCreated = 0;

  LeakDetector._(this.name);

  /// 获取或创建指定名称的检测器
  factory LeakDetector(String name) {
    return _detectors.putIfAbsent(
      name,
      () => LeakDetector<T>._(name),
    );
  }

  /// 注册要监控的对象
  void track(T object) {
    _totalCreated++;
    final id = _nextId++;
    _instanceIds[object] = id;
    _tracked[id] = WeakReference(object);
    debugPrint('[LeakDetector:$name] +$id 已注册 (共 $_totalCreated)');
  }

  /// 获取当前仍存活的对象数量
  int get aliveCount {
    _tracked.removeWhere((id, ref) => ref.target == null);
    return _tracked.length;
  }

  /// 获取总创建数量
  int get totalCreated => _totalCreated;

  /// 打印当前状态
  void report() {
    final alive = aliveCount;
    debugPrint('''
[LeakDetector:$name] 报告:
  总创建: $_totalCreated
  当前存活: $alive
  ${alive > 0 ? '⚠️  可能有泄漏！' : '✅ 无泄漏'}
''');
  }

  /// 等待并验证是否有泄漏
  ///
  /// 延迟指定时间后检查，给 GC 足够的时间回收对象
  Future<void> expectNoLeaks({
    Duration delay = const Duration(seconds: 2),
    int maxAllowedAlive = 0,
  }) async {
    await Future.delayed(delay);
    final alive = aliveCount;
    if (alive > maxAllowedAlive) {
      throw AssertionError(
        '[LeakDetector:$name] 检测到 $alive 个可能泄漏的对象 '
        '（最大允许: $maxAllowedAlive）',
      );
    }
  }

  /// 清除所有追踪数据
  void reset() {
    _tracked.clear();
    _totalCreated = 0;
    _nextId = 0;
  }
}
```

**在测试中使用 LeakDetector：**

```dart
testWidgets('MyWidget 不应该泄漏', (tester) async {
  final detector = LeakDetector<_MyWidgetState>('MyWidget');

  // 构建并渲染 Widget
  await tester.pumpWidget(
    MaterialApp(
      home: MyWidget(),
    ),
  );

  // 触发 dispose
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(); // 额外 pump 一帧让 dispose 执行

  // 验证无泄漏
  await detector.expectNoLeaks();
  detector.report();
});
```

## 七、最佳实践总结

### 7.1 Dispose 清单

`State.dispose()` 中必须释放的资源清单：

```dart
@override
void dispose() {
  // 1. 取消流订阅
  _subscription?.cancel();
  _subscription = null;

  // 2. 释放动画控制器
  _animationController?.dispose();

  // 3. 释放文本控制器
  _textEditingController?.dispose();

  // 4. 释放滚动控制器
  _scrollController?.dispose();

  // 5. 释放焦点节点
  _focusNode?.dispose();

  // 6. 移除 ChangeNotifier 监听
  _notifier?.removeListener(_listener);
  // 注意：通常不 dispose notifier（除非是自己创建的）

  // 7. 取消定时器
  _timer?.cancel();

  // 8. 关闭 StreamController
  _streamController?.close();

  // 9. 取消全局回调注册
  _globalCallback = null;

  // 10. 释放 Native 资源（FFI）
  _nativeResource?.dispose();

  super.dispose(); // 始终最后调用
}
```

### 7.2 异步回调中的 `mounted` 检查

在任何异步操作完成后访问 `State` 或 `BuildContext` 之前，必须检查 `mounted`：

```dart
Future<void> _loadData() async {
  final data = await api.fetchData();

  // ✅ 检查 mounted
  if (!mounted) return;

  setState(() {
    _data = data;
  });
}
```

### 7.3 使用 `const` 构造函数减少对象创建

```dart
// ❌ 每次 build 都创建新实例
Widget build(BuildContext context) {
  return Container(
    padding: const EdgeInsets.all(16), // const 好的
    child: Text(
      'Hello',
      style: TextStyle(fontSize: 16), // ❌ 每次 build 创建新的 TextStyle
    ),
  );
}

// ✅ 使用 const
Widget build(BuildContext context) {
  return Container(
    padding: const EdgeInsets.all(16),
    child: const Text(
      'Hello',
      style: TextStyle(fontSize: 16), // ✅ const TextStyle
    ),
  );
}
```

### 7.4 避免在 State 中缓存 `context`

```dart
// ❌ 缓存 context
class _BadState extends State<Widget> {
  BuildContext? _savedContext;

  @override
  Widget build(BuildContext context) {
    _savedContext = context; // ❌ context 可能过期
    return const SizedBox.shrink();
  }
}

// ✅ 使用 Builder 或直接传参
class _GoodState extends State<Widget> {
  @override
  Widget build(BuildContext context) {
    return Builder(builder: (context) {
      // 使用 Builder 提供的最新 context
      return ElevatedButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('返回'),
      );
    });
  }
}
```

### 7.5 图片缓存管理

Flutter 的 `ImageCache` 默认缓存 1000 张图片和 100MB 像素数据。可以根据需要调整：

```dart
void main() {
  final imageCache = PaintingBinding.instance.imageCache;

  // 调整缓存数量
  imageCache.maximumSize = 500; // 最多缓存 500 张

  // 调整缓存大小（字节）
  imageCache.maximumSizeBytes = 50 * 1024 * 1024; // 50MB

  // 清除缓存
  imageCache.clear();

  // 清除指定图片
  imageCache.evict(imageProvider);

  runApp(const MyApp());
}
```

在页面退出时清除图片缓存（适用于包含大量大图的页面）：

```dart
class _ImageHeavyPageState extends State<ImageHeavyPage> {
  @override
  void dispose() {
    // 注意：clear() 清空的是整个应用的全局图片缓存，不是"本页面的缓存"，
    // 会让其他页面的图片也重新解码。更精准的做法是只 evict 本页面用过的 provider：
    // PaintingBinding.instance.imageCache.evict(myImageProvider);
    PaintingBinding.instance.imageCache.clear();
    super.dispose();
  }
}
```

### 7.6 列表优化

```dart
ListView.builder(
  itemCount: items.length,
  // 关闭不需要的特性可以减少内存占用
  addAutomaticKeepAlives: false, // 不保留已滚出屏幕的项
  addRepaintBoundaries: false,   // 不为每项创建重绘边界
  itemBuilder: (context, index) {
    return ListTile(title: Text(items[index]));
  },
);
```

### 7.7 使用 `RepaintBoundary` 隔离重绘

```dart
// 高频更新的区域用 RepaintBoundary 隔离
RepaintBoundary(
  child: AnimatedCounter(), // 这个 Widget 频繁重绘
);
// 父 Widget 不会被触发重绘
```

### 7.8 常见内存问题排查速查表

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| 内存曲线持续上升 | 对象泄漏 | Heap Snapshot 对比 |
| 特定页面退出后内存不降 | Controller/Stream 未 dispose | 检查 State.dispose() |
| 滚动列表后内存增长 | 图片缓存过大 | 调整 ImageCache 参数 |
| 应用长时间运行后变卡 | Old Space 碎片化 | 在 DevTools Memory 观察 GC 与 compact 频率 |
| DevTools Memory 看不到增长但 OS 报告增长 | Native 内存泄漏（FFI） | 使用系统工具（Instruments、Perfetto） |
| 热重载后内存增长 | 旧 Widget 未被完全回收 | 重启应用验证 |

## 参考

- Dart VM 官方 GC 设计文档：[Garbage Collection (runtime/docs/gc.md)](https://github.com/dart-lang/sdk/blob/main/runtime/docs/gc.md)
- Dart VM Service 协议规范：[service.md](https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md)
- 官方文档：[WeakReference](https://api.dart.dev/stable/dart-core/WeakReference-class.html)
- 官方文档：[Finalizer](https://api.dart.dev/stable/dart-core/Finalizer-class.html)
- 官方文档：[Expando](https://api.dart.dev/stable/dart-core/Expando-class.html)
- DevTools 文档：[Use the Memory view](https://docs.flutter.dev/tools/devtools/memory)
- 官方泄漏检测工具：[leak_tracker - Detect Memory Leaks](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/DETECT.md)、[leak_tracker_flutter_testing](https://pub.dev/packages/leak_tracker_flutter_testing)
- Flutter API：[ImageCache](https://api.flutter.dev/flutter/painting/ImageCache-class.html)
- Flutter API：[vm_service（VM Service 的 Dart 客户端）](https://pub.dev/packages/vm_service)
