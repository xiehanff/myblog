# Flutter Hot Reload 与 Hot Restart 底层原理探究

Flutter 的热重载（Hot Reload）和热重启（Hot Restart）能显著提升开发效率，但两者在底层流程与可生效的变更范围上差异明显。

## Hot Reload 底层原理

### 1. 核心工作流程

当开发者触发 Hot Reload 时，以下步骤会依次执行：

1. **代码增量编译**：
   - Flutter 编译器只编译自上次编译后发生变化的 Dart 代码
   - 生成更新后的内核二进制文件（kernel binary file）

2. **发送更新代码**：
   - 更新的代码通过 VM Service 协议发送到正在运行的 Dart VM

3. **代码重新加载**：
   - Dart VM 重新加载更新后的类定义
   - 原有类被新的类定义替换，但类实例保持不变

4. **重建界面**：
   - Flutter 框架调用所有 Element/State 的 `reassemble()` 方法
   - 随后触发 Widget 树的重建
   - 状态（State）对象保持不变，其数据被保留

### Hot Reload 的运行时行为

- **增量编译技术**：利用 Dart VM 的 JIT（即时编译）能力
- **类型复用**：保留已有对象，仅替换类定义
- **无需重启 VM**：整个过程在相同的 Dart VM 实例中完成
- **原子性操作**：代码更新是原子性的，要么全部成功，要么全部失败

## Hot Reload 的 Engine 层实现

### 源码层视角下的重载过程

下面这段是为了帮助理解而整理的源码层流程；官方公开文档更高层的描述是：更新后的 Dart 代码会被加载进 VM 或浏览器运行时，随后 Flutter 重建 widget tree。

从源码层视角看，整个流程可以概括为：

1. **VM Service RPC 调用**：Flutter 工具通过 WebSocket 协议向 VM Service 发送 `reloadSources` RPC 请求。VM Service 是 Dart VM 内置的调试服务，主服务 WebSocket 地址形如 `ws://127.0.0.1:<port>/ws`（也可以连接到某个 Isolate 专属的 `ws://127.0.0.1:<port>/<isolate-id>/ws`）。

2. **Dart VM 解析增量编译产物**：VM Service 收到 `reloadSources` 请求后，将增量编译产物（`.dill` 格式的 Kernel Snapshot）传递给 Dart VM。Dart VM 解析 `.dill` 文件，提取其中包含的变更类定义。

3. **Isolate 中替换类定义**：Dart VM 在目标 Isolate 中执行类定义替换。替换内容包括：
   - 字段布局（field layout）
   - 方法体（method body）
   - 常量（constants）

4. **原子性保证**：替换是原子操作——要么全部类定义替换成功，要么全部回滚。如果任何一个类的替换失败，整个 Reload 操作回滚，Isolate 保持原状。

```
// VM Service 协议层面的调用示例（简化）
{
  "jsonrpc": "2.0",
  "method": "reloadSources",
  "params": {
    "isolateId": "isolates/1234567890",
    "force": false,
    "pause": false
  },
  "id": 1
}

// 响应
{
  "jsonrpc": "2.0",
  "result": {
    "type": "ReloadReport",
    "success": true,
    "details": { ... }
  },
  "id": 1
}
```

### 增量编译流程（frontend_server）

`frontend_server` 是 Dart SDK 中的编译前端，负责将 Dart 源码编译为 Kernel IR（中间表示）。在 Hot Reload 场景下，它的工作模式如下：

1. **以持久进程运行，通过 stdin 接收编译指令**：`flutter run` 启动时，`frontend_server` 作为持久进程运行。注意它**不自己监听文件系统**——文件变更是由 Flutter 工具（终端中按 `r` 键、IDE 保存触发等）感知的，随后 Flutter 工具把 `recompile <入口> <key>` 这样的编译指令写入 `frontend_server` 进程的 stdin。

2. **增量编译**：收到 `recompile` 指令后，`frontend_server` 只重新编译受影响的库（library），而非全量编译。编译器内部维护着完整的编译状态（import/export 依赖关系），可以精确判断哪些库需要重新编译。

3. **输出增量 .dill**：编译完成后，`frontend_server` 生成增量 `.dill` 文件（增量 Kernel Snapshot），只包含变更的部分，体积远小于全量编译产物。Flutter 工具还会通过 `accept`/`reject` 指令告诉它这次编译结果是否被 VM 接受——被 `reject` 时（如 reload 失败），下次会基于旧状态重编。

4. **通过 VM Service 发送**：Flutter CLI 工具将增量 `.dill` 通过 VM Service 的 `reloadSources` RPC 发送给目标 Isolate。

```
文件变更 → frontend_server 感知 → 增量编译 → 增量 .dill
         → VM Service reloadSources RPC → Dart VM 执行类定义替换
         → Element.reassemble() → Widget 树重建
```

### 类定义替换的规则

Dart VM 的 isolate reload 遵循明确的规则，变更要么整体生效、要么整体拒绝（原子性）。以下结论依据 Dart SDK 官方文档 [Hot reload（VM 层规范）](https://github.com/dart-lang/sdk/blob/main/runtime/docs/hot-reload.md)：

**可以被接受的变更：**

- 修改方法体（最常用的场景，如修改 `build()` 中的 UI 代码）
- 添加新的方法、新的类
- 添加或删除实例字段：VM 会按**字段名**把旧实例的值迁移到新布局上（类型不匹配时值会装箱迁移），新增字段如果没有初始化器则为 `null`/零值，**有初始化器则会针对存量实例重新运行初始化器**
- 修改已有字段的类型：VM 并不直接拒绝（字段按名字迁移、忽略类型），但旧值与新类型不匹配时后续行为可能不一致
- 修改类的继承关系（`extends`/`with`）：VM 支持并会更新类型层次，但已有的 `is` 判断结果、被缓存的旧实例可能出现前后不一致

**会被 VM 拒绝的变更（ReloadReport 返回失败，改动完全不生效）：**

- 普通类、枚举、typedef 之间的互相转换（`class C {}` <=> `enum C {}` <=> `typedef void C()`）
- 修改类的类型参数数量（`class C` <=> `class C<T, S>`，即泛型参数个数变化）
- 修改带有 `deferred as` 延迟导入的库（此场景在 VM 中尚未实现）
- 修改 native 字段包装类的字段数量（如 `NativeFieldWrapperClass1` 改为 `Class2`）

> **关键认知**：官方拒绝清单只有上面这几类。很多资料声称"修改字段类型、删除字段、修改继承关系会导致 reload 失败"，这与当前 Dart VM 的实际实现不符——这些变更会被接受，只是**可能带来新旧状态不一致**。工程实践中如果改动了类结构（字段类型、继承关系），仍然建议 Hot Restart，理由是保证行为确定性，而不是 reload 会报错。

> **关于字段重命名**：VM 无法把"重命名"识别为"同一个字段"，它只会看到"删了一个字段、加了一个无关字段"，因此重命名后旧值不会被迁移到新名字上。

### const 与 final 的处理

这是最容易记反的一组规则。Flutter 官方文档的结论是：**对 `const` 字段值的修改总是会被热重载**——Dart VM 在概念上把 `const` 当作"别名"而不是状态；而 `final`/普通全局变量被当作状态，初始化器不会重跑：

- **`const` 变量**：修改值（如 `const foo = 1` 改为 `const foo = 2`）后，新代码中引用 `foo` 会取到新值。`const` 对象在 VM 中是规范化的（canonicalized）——相同参数的 `const` 构造只产生一个实例，reload 后新的常量值会被正确建立。
- **`final` 变量（含 top-level/static `final`）**：作为状态保留当前值，初始化器不会重新执行。典型坑：`const foo = 1; final bar = foo;` 修改 `foo` 后，`bar` 仍保留旧的 `1`。
- **已经捕获的旧实例**：如果旧 `const`/`final` 实例被保存进了其他状态（局部变量、字段、集合），这些引用不会自动替换。

```dart
const foo = 1;
final bar = foo; // final 保留了旧值
void onClick() {
  print(foo); // 修改 foo 为 2 后 Hot Reload：打印 2（const 当作别名，总是更新）
  print(bar); // 仍打印 1（final 是状态，初始化器不重跑）
}

// 官方建议的两种修复方式：
const foo = 1;
const bar = foo; // 方式一：bar 也改成 const
// 或
int get bar => foo; // 方式二：改成 getter，每次取值时求值
```

## static field 与全局变量的处理逻辑

### static field 在 Hot Reload 时的行为

理解 static field 在 Hot Reload 中的行为，对于避免开发中的困惑至关重要：

1. **类定义被替换，static field 的值保留**：Hot Reload 替换的是类的定义（方法体、字段布局等），但不会重置 static field 的值。类定义和 static field 的存储是分离的——类定义存在 VM 的类表中，static field 的值存在 Isolate 的堆上。

2. **static 计数器不会归零**：这是最常见的现象。例如一个记录点击次数的 `static int count`，Hot Reload 后 `count` 的当前值被完整保留。

3. **static const 会被重新编译**：`static const` 是编译时常量，存储在 Kernel Snapshot 的常量表中。Hot Reload 时新的常量值会被写入常量表，后续代码引用会获取到新值。但**已存在**的引用（如之前捕获到局部变量中的值）不会自动更新。

```dart
class Counter {
  static int clickCount = 0;  // Hot Reload 后值保留
  static const String label = 'Old Label'; // Hot Reload 后新代码引用获取新值

  void increment() {
    clickCount++;
    print('$label: $clickCount');
  }
}
// Hot Reload 修改 label 为 'New Label' 后：
// - clickCount 保持当前值（如 5）
// - 新的 increment() 调用会打印 "New Label: 6"
```

### 全局变量的处理

1. **全局函数可以修改**：top-level function 的方法体会被替换，行为与实例方法一致。

2. **全局变量的值保留**：top-level variable 的当前值在 Hot Reload 后保持不变，行为与 static field 一致。

3. **全局 const 变量可能不被更新**：与 `static const` 类似，已存在引用保持旧值，新引用获取新值。

### reassemble() 的作用

Hot Reload 触发 `reassemble()` 的调用链如下（依据 Flutter 3.41 framework 源码）：

```
热重载成功后
  → Flutter 工具通过 VM Service 调用 "ext.flutter.reassemble" 服务扩展
    （该扩展由 BindingBase.initServiceExtensions() 在 Dart 侧注册）
      → BindingBase.reassembleApplication()
        → lockEvents(performReassemble)（锁定事件，避免重载期间处理输入）
          → WidgetsBinding.performReassemble()
            → buildOwner.reassemble(rootElement)（BuildOwner）
              → 从根 Element 递归调用每个 Element.reassemble()
                → Element.reassemble() 内部 markNeedsBuild() 标记整棵树重建
                  → StatefulElement.reassemble() 调用 State.reassemble()
```

关键细节：
- `State.reassemble()` 的**默认实现为空**（不做任何事），开发者可以重写它来响应 Hot Reload。
- `Element.reassemble()` 会先 `markNeedsBuild()` 再递归子元素，因此 **reassemble 的直接后果就是整棵 Element 树被标记重建**，随后在下一帧全部重新 build。
- `reassemble()` 不会影响 static field 或全局变量的值，它只是一个通知机制。
- 部分 Flutter 内置组件会重写 `reassemble()` 做专项刷新，例如 `Image`（`_ImageState.reassemble` 会重新解析图片流，使换图后的热重载立即生效）。
- 如果需要在 Hot Reload 后执行自定义逻辑（如重新获取数据、重建动画），可以重写 `reassemble()`。

```dart
class MyState extends State<MyWidget> {
  @override
  void reassemble() {
    super.reassemble();
    // Hot Reload 后重新初始化动画控制器等
    _animationController?.dispose();
    _animationController = AnimationController(
      vsync: this,
      duration: Duration(seconds: 1),
    );
    // 重新加载需要的数据
    _loadData();
  }
}
```

## 官方文档里的特殊场景补充

### Web 平台

Flutter 官方文档目前明确说明：Flutter Web 已支持 hot reload 和 hot restart。

- 热重载会把改动后的 Dart 代码加载到 VM 或浏览器运行时里，并重新构建 widget tree。
- 热重启会重新启动应用，但不一定需要完整页面刷新。
- 早期版本中 Web 热重载是实验特性，需要 `--web-experimental-hot-reload` 开关开启；在正式支持后该开关已从 Flutter 工具中移除（本地 Flutter 3.41 的 `flutter run --help` 中已无此参数）。

### 代码变更限制

官方文档列出的典型限制如下：

- 枚举和普通类互相转换时，hot reload 不工作。
- 修改泛型类型声明时，hot reload 不工作。
- 修改原生代码（Kotlin、Java、Swift、Objective-C）时，需要 full restart。
- `main()` 和 `initState()` 不会因为 hot reload 重新执行。
- static fields 和 global variables 会被当成状态，不会在 hot reload 中重新初始化。

### 构建模式限制

Hot Reload 和 Hot Restart 只在 debug mode 下可用。

- release mode 不支持。
- profile mode 的目标是性能分析，不是热重载工作模式。

## Hot Reload 失败的排查

### 官方排查顺序

遇到 Hot Reload 没生效时，优先按官方文档的几个典型场景判断：

1. **先看代码变更类型**：如果改的是 `main()`、`initState()`、枚举和普通类互换、泛型声明，通常就不是 hot reload 能覆盖的范围。
2. **再看运行模式**：确保是在 debug mode 下运行。release mode 不支持 hot reload，也不支持 hot restart。
3. **再看原生代码**：如果改到了 Kotlin、Java、Swift 或 Objective-C，必须 full restart。
4. **最后看控制台输出**：如果是编译错误，Flutter CLI / IDE 会直接提示对应的 Dart 语法或类型问题。

### 常见无效场景

| 场景 | 官方结论 |
|------|----------|
| 枚举和普通类互换 | hot reload 不工作 |
| 泛型类型声明修改 | hot reload 不工作 |
| 原生代码修改 | 需要 full restart |
| `main()` 修改 | hot reload 不会重新执行 |
| `initState()` 修改 | hot reload 不会重新执行 |
| static field / global variable 修改初始化值 | 不会在 hot reload 中重新初始化 |

### Hot Reload 后"UI 没更新"的排查

即使 Hot Reload 报告成功，UI 也可能"看起来没变化"。常见原因：

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| `final`/静态字段值不更新 | 它们被当作状态，初始化器不重跑 | 改用 `const` 或 getter，或使用 Hot Restart |
| static 计数器不归零 | static field 值保留 | 这是预期行为，或使用 Hot Restart |
| initState 中的修改无效 | State 已创建，initState 不会重跑 | Hot Restart，或在 `reassemble()` 中处理 |
| build 方法外缓存的数据未更新 | 缓存在字段或闭包中的旧数据 | 在 `reassemble()` 中清除缓存 |

### 代码示例：验证各种 Hot Reload 场景

以下代码可以用来系统地验证 Hot Reload 的行为：

```dart
import 'package:flutter/material.dart';

// 场景 1：static field 值保留
class StaticTest {
  static int counter = 0;
}

// 场景 2：const 值修改会被热重载（const 被当作"别名"而非状态）
const String constLabel = 'Original';

// 场景 3：全局变量值保留
int globalCounter = 0;

// 场景 4：修改方法体 —— 支持热重载
String getGreeting() {
  return 'Hello'; // 改为 'Hi' 后 Hot Reload 生效
}

// 场景 5：添加/删除字段 —— VM 支持（按字段名迁移值，新字段有初始化器会重跑）
class Person {
  String name = 'Alice';
  // 添加 int age = 0;  —— 支持
}

// 场景 6：字段类型修改（String name → int name）—— VM 不会拒绝，
// 但旧实例迁移过来的值与新类型不匹配时行为可能不一致，建议 Hot Restart

class HotReloadDemo extends StatefulWidget {
  const HotReloadDemo({super.key});

  @override
  State<HotReloadDemo> createState() => _HotReloadDemoState();
}

class _HotReloadDemoState extends State<HotReloadDemo> {
  int _buildCount = 0; // 追踪 build 被调用的次数

  @override
  void initState() {
    super.initState();
    print('initState called — Hot Reload 不会重新调用这里');
  }

  @override
  void reassemble() {
    super.reassemble();
    print('reassemble called — 每次 Hot Reload 都会调用');
    // 可以在这里重置需要重置的状态
  }

  @override
  Widget build(BuildContext context) {
    _buildCount++;
    return Scaffold(
      appBar: AppBar(title: const Text('Hot Reload 验证')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Build 次数: $_buildCount'),
            Text('static counter: ${StaticTest.counter}'),
            Text('全局计数器: $globalCounter'),
            Text(constLabel), // const 值修改后 Hot Reload 会更新（当作别名处理）
            Text(getGreeting()),
            ElevatedButton(
              onPressed: () {
                setState(() {
                  StaticTest.counter++;
                  globalCounter++;
                });
              },
              child: const Text('增加计数器'),
            ),
          ],
        ),
      ),
    );
  }
}
```

## Hot Restart 与 Hot Reload 的深度对比

### 完整技术差异对比

| 特性 | Hot Reload | Hot Restart |
|------|-----------|-------------|
| **编译方式** | 增量编译（`frontend_server`，stdin 下发 `recompile` 指令） | 增量编译（与 Hot Reload 相同，`frontend_server` 状态不重置） |
| **编译产物** | 增量 `.dill` 文件 | 更新后的主 `.dill`（kernel）文件 |
| **VM 处理** | 在现有 Isolate 中重新加载代码 | 重建 Isolate（引擎销毁并重建 UI Isolate） |
| **状态保留** | State 对象保留、static field 值保留、全局变量值保留 | 全部清空，从 `main()` 重新开始 |
| **速度** | ~0.5-1 秒（大型项目可能 2-3 秒） | ~1-3 秒（同步代码 + Isolate 重建 + 重跑 `main()`） |
| **const / final 对象** | `const` 值更新、`final` 值保留 | 全部重新创建 |
| **引擎实例** | 保留 | 保留 |
| **渲染管线** | 不变 | 不变 |
| **字体/图片缓存** | 保留 | 引擎层字体缓存保留；framework 层 `ImageCache` 随 Isolate 清空 |
| **原生通道** | 保留（Platform Channel 连接不变） | 重新注册（Dart 端 handler 随 `main()` 重新注册） |
| **initState** | 不重跑 | 重跑 |
| **dispose** | 不调用 | 不调用（Isolate 直接重建，不走正常的 unmount 流程） |
| **reassemble()** | 调用 | 不调用（因为 State 被销毁重建） |

### Hot Restart 的 Engine 层详细流程

Hot Restart 的执行过程比 Hot Reload 更重量级，但**它并不重置增量编译器**。依据 Flutter 3.41 的 `flutter_tools` 源码（`run_hot.dart` 的 `_restartFromSources`），具体步骤如下：

1. **同步代码**：如果有未编译的改动，先做一次增量编译并更新主 `.dill`（kernel）文件；随后调用 `generator.accept()` 让 `frontend_server` 的编译状态继续保留——**不是从头全量编译**。

2. **清理调试状态**：移除所有断点、恢复 Isolate 运行，避免重启过程被暂停卡住。

3. **重建 Isolate**：Flutter 工具通过 VM Service 的私有 RPC `_flutter.runInView` 通知引擎——由引擎负责销毁并重建它管理的 UI Isolate（应用自己 `spawn` 的子 Isolate 则被直接 kill）。旧 Isolate 中的所有 Dart 对象（State、static field、全局变量、framework 层的 `ImageCache`）随之清空。

4. **重跑 main()**：新 Isolate 从主 `.dill` 重新执行 `main()`，整个应用重新初始化。注意这个过程**不会调用任何 `dispose()`**——Isolate 是直接重建的，不走正常的 Element unmount 流程。

5. **引擎实例保留**：关键点——Flutter Engine 实例（C++ 层）**不会**被销毁和重建。这意味着：
       - 渲染引擎保持运行，无需重新初始化。
   - 引擎层字体缓存（字形缓存等）保留，无需重新解析字体文件。
   - GPU 上下文保留，无需重新分配 GPU 资源。
   - Platform Channel 的原生端保持不变（但 Dart 端的方法调用处理器需要随 `main()` 重新注册）。

```
Hot Restart 流程图：

[Flutter Engine (C++)] ──────── 保持不变 ──────────→ [Flutter Engine (C++)]
       │                                                  ▲
       ▼                                                  │
[Dart VM Isolate (旧)]  → 重建（_flutter.runInView）  →  [新 Isolate]  → 执行 main()
       │                                                （从主 .dill 重新运行）
       └── State/static/global/ImageCache
           全部随旧 Isolate 清空
```

### Engine 实例保留的意义

Engine 实例保留是 Hot Restart 能在几秒内完成（而非几十秒）的关键：

- **避免重新初始化渲染引擎**：渲染引擎的初始化涉及 GPU 上下文创建、Shader 编译等耗时操作，保留引擎可以跳过这些步骤。
- **引擎层字体缓存**：字形缓存等位于引擎侧的数据被保留，减少了重启后的文本渲染开销（注意 framework 层与资源加载相关的缓存仍会随 Isolate 重建而清空）。
- **原生桥接**：Platform Channel 的 Method Channel、Event Channel 的原生端实现无需重新加载。

这也是为什么 Hot Restart 比"Stop & Re-run"快得多——后者需要重新启动整个 Flutter 引擎进程。

## Hot Restart 底层原理

### 1. 工作流程

Hot Restart 的执行步骤：

1. **同步最新代码**：
   - 如有未编译的改动，先增量编译并更新主代码包
   - 仍复用 `frontend_server` 的增量编译状态，不做全量重编

2. **重置运行时**：
   - Flutter 引擎实例不重启，但 Dart VM Isolate 被重建
   - 清空应用内存中的状态与单例

3. **重新运行应用**：
   - 以全新状态重新执行 `main()` 函数
   - 从头构建整个 Widget 树

### 2. 技术实现细节

- **状态重置**：应用的所有状态都被重置
- **复用 Flutter 引擎**：不需要重启设备或模拟器
- **重的是运行时而非编译**：耗时主要在 Isolate 重建与重跑 `main()`，而不是重新编译全部源码

## 两者关键区别
| 特性     | Hot Reload         | Hot Restart              |
| -------- | ------------------ | ------------------------ |
| 速度     | 更快（通常<1秒）   | 较慢（几秒钟）           |
| 状态保留 | 保留应用状态       | 重置所有状态             |
| 编译范围 | 增量编译           | 增量编译（不重置编译器） |
| Isolate  | 保留现有 Isolate   | 重建 Isolate（引擎保留） |
| 适用场景 | UI修改、小逻辑改动 | 状态逻辑修改、深层次变更 |

## 技术限制

**Hot Reload 的局限性**：
- 不能处理全局变量和静态字段的初始化变更（static field 值保留，initializer 不会重跑）
- 普通类/枚举/typedef 互转、泛型参数数量变化会被 VM 直接拒绝（详见"类定义替换的规则"）
- 改动类结构（字段类型、继承关系）虽不会被 VM 拒绝，但可能造成新旧状态不一致，建议改用 Hot Restart
- 不适用于 `main()` 函数的变更（需要 Hot Restart）
- `main()` 和 `initState()` 中的代码不会因 Hot Reload 重新执行
- 某些代码变更可能导致状态不一致（如 static field 保存了旧类实例的引用）

**两者共有的限制**：
- 无法处理原生代码（Android/iOS）的变更
- 插件代码变更需要完全重启应用
- 仅在 Debug 模式下可用，Release 模式不支持

## 常见现象与排查建议

> 详细的错误排查流程和代码示例请参考上方"Hot Reload 失败的排查"章节。

1. **UI 不更新**：检查是否为 `const` Widget（const 对象不重建）、或未触发 `build`
2. **状态异常**：热重载保留 `State`，需要手动重置或改为热重启
3. **静态字段不变**：静态初始化不会重跑，需热重启（这是 `static field` 值保留的预期行为）
4. **debug-only**：热重载/热重启仅在 Debug 环境可用，Release 不支持
5. **修改了类结构导致失败**：检查是否修改了字段类型、删除了字段、或修改了继承关系
6. **Web 平台**：Web 端也支持 hot reload / hot restart，但具体表现以当前 Flutter 官方文档和所用版本为准

Flutter 团队通过不断优化这两种机制，使开发者能在保持应用状态的同时快速迭代，或在需要时完全重置应用状态，大大提高了开发效率。从 Engine 层面看，Hot Reload 的增量编译 + 原子性类替换 + `reassemble()` 通知机制构成了一个高效的开发闭环，而 Hot Restart 的 Isolate 重建 + Engine 实例保留则平衡了状态重置的需求和重启速度。

## 附录：VM Service 协议中的 Hot Reload 相关 RPC

了解 VM Service 协议有助于深入理解 Hot Reload 的底层通信机制。以下是与热重载相关的核心 RPC：

### reloadSources

Hot Reload 的核心 RPC，用于将增量编译产物发送给目标 Isolate。它的参数只有三个（`isolateId`、`force`、`pause`），增量 `.dill` 的内容由 Flutter 工具通过 DevFS 上传后在 `entryPath` 中指定：

```json
// 请求参数（依据 flutter_tools 中对该 RPC 的实际封装）
{
  "method": "reloadSources",
  "params": {
    "isolateId": "isolates/<id>",  // 目标 Isolate ID
    "force": false,                 // 是否强制重载（忽略某些检查）
    "pause": false                  // 重载后是否暂停 Isolate
  }
}

// 成功响应（ReloadReport）
{
  "result": {
    "type": "ReloadReport",
    "success": true,
    "notices": [],           // 警告/拒绝原因列表
    "details": {
      "loadedLibraryCount": 1,   // 本次重新加载的库数量
      "finalLibraryCount": 448   // 程序中的库总数
    }
  }
}

// 失败响应
{
  "result": {
    "type": "ReloadReport",
    "success": false,
    "notices": [
      {
        "message": "Hot reload was rejected"
      }
    ]
  }
}
```

终端里看到的 `Reloaded 1 of 448 libraries in 978ms.` 就是用 `details` 里的这两个计数值拼出来的。

### ext.flutter.reassemble

Flutter 框架自定义的服务扩展，用于通知所有 Element 执行 `reassemble()`：

```json
{
  "method": "ext.flutter.reassemble",
  "params": {}
}
```

该扩展**不是由引擎 C++ 注册的**，而是由 Dart 侧 framework 注册：`BindingBase.initServiceExtensions()` 在初始化服务扩展时注册 `ext.flutter.reassemble`，回调最终走到 `reassembleApplication()` → `WidgetsBinding.performReassemble()`，再由 `BuildOwner.reassemble()` 从根 Element 递归触发整棵树的 `reassemble()`（详见前文"reassemble() 的作用"一节）。

### _flutter.runInView（Hot Restart 的实际入口）

Hot Restart 的底层实现是"销毁旧 Isolate、创建新 Isolate"。在 Flutter 3.41 的 `flutter_tools` 源码中，这是通过 VM Service 的私有 RPC `_flutter.runInView` 完成的——它通知引擎销毁并重建 UI Isolate，然后从指定的主 `.dill` 重新执行入口函数：

```json
{
  "method": "_flutter.runInView",
  "params": {
    "viewId": "_viewId/<id>",
    "main": "<主 dill 的 URI，如 main.dart.dill>",
    "assetsDirectory": "<资源目录的 URI>"
  }
}
```

注意 `_flutter.runInView` 是下划线开头的私有方法，属于 Flutter 工具与引擎之间的内部协议，不是对外承诺的公开 API；VM Service 协议本身并没有名为 `restartIsolate` 的公开 RPC。

## 附录：实际开发中的 Hot Reload 最佳实践

### 何时使用 Hot Reload vs Hot Restart

| 开发场景 | 推荐操作 | 原因 |
|---------|---------|------|
| 修改 `build()` 中的 UI 代码 | Hot Reload | 方法体替换，State 保留 |
| 修改业务逻辑方法 | Hot Reload | 方法体替换 |
| 添加新的 Widget 或类 | Hot Reload | 新定义可以被加载 |
| 修改了 `initState` | Hot Restart | `initState` 不会重跑 |
| 修改了 `static final` 初始化值 | Hot Restart | static field 值保留 |
| 修改了类的继承关系 | Hot Restart | 类结构变更虽可 reload，但易出现状态不一致 |
| 添加了新的依赖（pubspec.yaml） | 完全重启 | 需要重新解析依赖 |
| 修改了原生代码（Android/iOS） | 完全重启 | 原生代码需要重新编译 |
| `const` 值被复制进了 `final` 状态（`final bar = foo`） | 改成 `const`/getter，或 Hot Restart | `final` 保留旧值 |

### 利用 reassemble() 优化开发体验

对于需要在 Hot Reload 后重新初始化资源的场景，重写 `reassemble()` 是推荐做法：

```dart
class MyListState extends State<MyList> {
  late ScrollController _scrollController;

  @override
  void initState() {
    super.initState();
    _scrollController = ScrollController();
  }

  @override
  void reassemble() {
    super.reassemble();
    // 滚动位置可能因列表项变化而无意义，重置到顶部
    _scrollController.jumpTo(0);
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      controller: _scrollController,
      itemBuilder: (context, index) => ListTile(
        title: Text('Item $index'),
      ),
    );
  }
}
```

### Hot Reload 的性能监控

在大型项目中，可以监控 Hot Reload 的耗时来定位性能瓶颈：

```dart
// 在 reassemble() 中记录时间
@override
void reassemble() {
  final stopwatch = Stopwatch()..start();
  super.reassemble();
  stopwatch.stop();
  print('reassemble() 耗时: ${stopwatch.elapsedMilliseconds}ms');
}
```

Flutter CLI 也会输出 Hot Reload 的耗时信息：
```
Reloaded x of y libraries in xxxms
```

其中各阶段耗时含义：
- **编译时间**：`frontend_server` 增量编译耗时
- **传输时间**：增量 `.dill` 通过 WebSocket 发送到设备的时间
- **VM Reload 时间**：Dart VM 重新加载代码的耗时
- **UI 重建时间**：`reassemble()` + Widget 树重建的时间

## 参考

- [Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [Hot reload（Dart VM 层规范，含 reload 拒绝清单）](https://github.com/dart-lang/sdk/blob/main/runtime/docs/hot-reload.md)
- [Flutter build modes](https://docs.flutter.dev/testing/build-modes)
- [Building a web application with Flutter](https://docs.flutter.dev/platform-integration/web/building)
