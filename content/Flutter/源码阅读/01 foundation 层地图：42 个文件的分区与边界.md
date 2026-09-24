# 01 foundation 层地图：42 个文件的分区与边界

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/foundation`

## 一、问题

`foundation` 是最底层，所以"应该先读它"。但打开目录一看是 42 个文件、11.4k 行，`diagnostics.dart` 一个文件就 3707 行。

于是问题变成：**这里面哪些是"机制"，哪些只是"工具"？如果只读 20%，该读哪 20%？**

错误直觉是"底层 = 基础 = 都要细读"。实际上 foundation 里真正的机制只有三块：**身份契约、通知机制、平台绑定**。其余是容器算法和诊断工具。

## 二、最小 Demo

foundation 可以脱离任何 Widget 单独使用。下面这段只 import foundation：

```dart
import 'package:flutter/foundation.dart';

void main() {
  // 1. 观察者机制：不需要任何 Widget 参与
  final ValueNotifier<int> count = ValueNotifier<int>(0);
  count.addListener(() => debugPrint('count = ${count.value}'));
  count.value = 1;

  // 2. 集合算法：纯粹的工具函数
  debugPrint('${listEquals(<int>[1, 2], <int>[1, 2])}'); // true

  // 3. 平台判断：框架认为自己在哪运行
  debugPrint('$defaultTargetPlatform kIsWeb=$kIsWeb');
}
```

这段代码说明了一件事：foundation 里大部分东西**和 UI 无关**。它是"如果不依赖 dart:ui 就该放在这里的那些东西"。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `foundation.dart:1-55` | 整个层的对外面，55 行、30 个 export |
| `foundation.dart:30` | `binding.dart`，唯一深入 dart:ui 的入口 |
| `foundation.dart:33` | `change_notifier.dart`，观察者机制 |
| `foundation.dart:41` | `key.dart`，身份契约 |
| `foundation.dart:44` | `node.dart`，已废弃的树骨架（第三篇展开） |
| `foundation.dart:47` | `persistent_hash_map.dart`，上层用得很重（第六篇展开） |

## 四、依赖方向与条件导入

### 4.1 它依赖谁

`foundation.dart` 只有 55 行，全是 export。打开 `foundation.dart` 的第一段可以看到它先把 `package:meta` 的一部分重新导出（`@protected`、`@mustCallSuper`、`@visibleForTesting` 等），再逐个导出 `src/foundation/` 下的文件。

把 `src/foundation` 里所有 import 归类后，依赖分三种：

**第一种：Dart 核心库。** 绝大多数文件只依赖这些。

```text
dart:async        Future / Zone / scheduleMicrotask
dart:collection   HashSet / ListBase
dart:convert      json
dart:developer    postEvent / registerExtension / TimelineTask
dart:io           仅 _io 实现里用，如 exit(0)
```

**第二种：`dart:ui`，只有 5 个文件用。** 这个数字很重要——它决定了 foundation 能不能"几乎与渲染无关"：

| 文件 | 为什么需要 dart:ui |
|---|---|
| `change_notifier.dart` | 只要一个 `VoidCallback` 类型别名，`import 'dart:ui' show VoidCallback` |
| `debug.dart` | 读 `debugBrightnessOverride`、`platformDispatcher` |
| `diagnostics.dart` | 用 `Brightness` 等类型做诊断信息 |
| `memory_allocations.dart` | 泄漏追踪的创建/释放事件 |
| `binding.dart` | 整个 `BindingBase` 就是给 `PlatformDispatcher` 做接线的 |

`binding.dart` 里紧跟着这行 import 的一句注释很能说明框架的态度：

```dart
// binding.dart:19
import 'dart:ui' as ui show Brightness, PlatformDispatcher, SingletonFlutterWindow, window;

// Before adding any more dart:ui imports, please read the README.
```

**第三种：其它层，只有 1 处。** `_error_dumper_web.dart:7` 引用了 `../web.dart`，而这是 Web 平台的错误打印实现，不算真正的层间依赖。

**关键认知**：foundation 是唯一一个"删除其它所有层之后仍然能编译"的层。这不是巧合，是它能承载 `Key`、`Listenable` 这类跨层契约的原因——它们必须在所有层都能被引用，就不能反过来依赖任何层。

### 4.2 条件导入：一个 API，两份实现

foundation 里有 13 个以下划线开头的文件，它们在 `foundation.dart` 里一个都没被导出。它们的存在方式是**条件导入**：

```dart
// platform.dart:9
import '_platform_io.dart' if (dart.library.js_interop) '_platform_web.dart' as platform;
```

这行代码在编译期做选择：如果目标平台有 `dart.library.js_interop`（即编译到 Web），就换成 `_platform_web.dart`。同样的模式出现在 6 处：

| 门面文件 | 实现文件 | 分叉原因 |
|---|---|---|
| `platform.dart` | `_platform_io` / `_platform_web` | 原生用 `dart:io Platform`，Web 用 `navigator.userAgent` |
| `capabilities.dart` | `_capabilities_io` / `_capabilities_web` | CanvasKit / Skwasm 只有 Web 才有 |
| `bitfield.dart` | `_bitfield_io` / `_bitfield_web` | 位运算实现不同 |
| `isolates.dart` | `_isolates_io` / `_isolates_web` | Web 没有真正的 Isolate |
| `timeline.dart` | `_timeline_io` / `_timeline_web` | Web 用 `performance` API |
| `error_dumper.dart` | `_error_dumper_io` / `_error_dumper_web` | 错误输出通道不同 |

**关键认知**：条件导入是 framework 处理平台差异的标准手法。你在上层看到 `defaultTargetPlatform`、`isCanvasKit` 这类"读起来很普通"的 getter，背后都藏着一对文件。遇到这类 getter 想看实现，先看门面文件里的 `if (dart.library...)`，再决定打开哪一个实现——否则你会以为自己读漏了代码。

### 4.3 对外面：42 个文件中只有 29 个被导出

`foundation.dart` 一共 30 个 export，其中 1 个指向 `package:meta`，29 个指向 `src/foundation/`。42 减 13（条件导入的实现文件）正好是 29。

**关键认知**：`src/foundation/` 下的文件分成两类——**门面**（被 export，上层可见）和**实现**（下划线开头，只在编译期被条件导入选中）。判断一个文件是否属于公开 API，看 `foundation.dart` 里有没有它，不要看它在不在 `src` 下。

## 五、核心对象：五个分区与各自的分量

把 42 个文件按职责分成五区。下面这张表就是本篇的结论——**加粗的是机制，其余是工具**。

### A 区：身份与契约（≈683 行）

| 文件 | 行数 | 内容 |
|---|---|---|
| **`key.dart`** | 117 | `Key` / `LocalKey` / `ValueKey` / `UniqueKey`，Element 身份判定的最小契约（第二篇） |
| `node.dart` | 161 | `AbstractNode`，已 `@Deprecated`，框架零引用（第三篇） |
| `annotations.dart` | 119 | `@Category`、`@DocumentationIcon` 等文档注解 |
| `basic_types.dart` | 267 | `ValueChanged`、`ValueGetter`、`AsyncCallback` 等函数类型别名 |
| `object.dart` | 19 | 极小的类型辅助 |

A 区是"上层要共同遵守的契约"。`Key` 是其中唯一有实际算法含义的。

### B 区：通知与观察者（≈1066 行）

| 文件 | 行数 | 内容 |
|---|---|---|
| **`change_notifier.dart`** | 569 | `Listenable` / `ChangeNotifier` / `ValueNotifier`（第四、五篇） |
| `observer_list.dart` | 161 | `ObserverList` / `HashedObserverList`，框架自用的观察者容器（第五篇） |
| `memory_allocations.dart` | 336 | 对象创建/释放事件，DevTools 与 leak_tracker 的数据源 |

B 区是 foundation 最常被上层引用的部分：`ScrollController`、`AnimationController`、`TextEditingController`、`PageController` 全都是 `ChangeNotifier` 的子类。

### C 区：容器与算法（≈2144 行）

| 文件 | 行数 | 内容 |
|---|---|---|
| `collections.dart` | 359 | `listEquals` / `mapEquals` / `setEquals` / `mergeSort` / `binarySearch`（第六篇） |
| **`persistent_hash_map.dart`** | 417 | HAMT 实现，`InheritedElement` 的继承链查找表（第六篇） |
| `bitfield.dart` | 49 | 位集合，跨平台条件导入 |
| `unicode.dart` | 98 | 字符处理辅助 |
| `stack_frame.dart` | 323 | 解析 `StackTrace` 文本，把 `#0 ...` 变成结构化对象 |
| `serialization.dart` | 273 | `WriteBuffer` / `ReadBuffer`，给 codec 用的二进制读写 |
| `consolidate_response.dart` | 136 | 把 HTTP 响应体拼成完整字节流 |
| `synchronous_future.dart` | 68 | 已经完成的 Future，`ImageProvider.resolve` 用它省一次异步跳转 |
| `isolates.dart` | 84 | `compute()` 的门面，条件导入 |
| `licenses.dart` | 337 | `LicenseRegistry`，`about` 弹窗的数据源 |

C 区是"框架自己需要但 dart:core 没提供"的东西。它们的共同特征是**不带 UI 概念**，所以能落在最底层。

### D 区：诊断与断言（≈5822 行，占本层一半）

| 文件 | 行数 | 内容 |
|---|---|---|
| `diagnostics.dart` | 3707 | `DiagnosticsNode`、`DiagnosticableTree`、树形文本渲染 |
| `assertions.dart` | 1305 | `FlutterError`、`FlutterErrorDetails`、错误上报与 stack filter |
| `timeline.dart` | 418 | `Timeline` 打点，DevTools Timeline 的数据来源 |
| `print.dart` | 219 | `debugPrint`，限速输出，避免被日志压垮 |
| `debug.dart` | 172 | 各种 `debugXxx` 开关 |

**关键认知**：D 区占了本层一半代码量，**但它不是本系列的主干**。读上层代码时，凡是撞见 `assert(...)`、`FlutterError.fromParts(...)`、`debugFillProperties`、`toString`、`informationCollector`，都可以先整块跳过——它们负责"把错误讲清楚"，不负责"什么时候出错"。

只有两处值得回头细看：一是错误文案本身（它常常是理解机制的最快入口，第七篇会示范），二是 `assert` 限定的前置条件（它往往精确描述了这个方法对调用者的要求）。

### E 区：绑定与平台（≈1310 行）

| 文件 | 行数 | 内容 |
|---|---|---|
| **`binding.dart`** | 993 | `BindingBase`，所有 binding mixin 的基类（第七篇） |
| `platform.dart` | 114 | `TargetPlatform`、`defaultTargetPlatform`、调试覆盖开关 |
| `constants.dart` | 96 | `kReleaseMode` / `kIsWeb` / `precisionErrorTolerance` |
| `capabilities.dart` | 23 | `isCanvasKit` / `isSkwasm`，只有 Web 有意义 |
| `service_extensions.dart` | 84 | `ext.flutter.*` 的名字常量枚举 |

E 区是 foundation 里唯一"向上为主"的部分：它自己不产生机制，只负责把 `dart:ui` 和平台底层接到框架里。

### 分区小结

```text
D 诊断与断言   ≈5822 行   占一半，但基本可以跳过
C 容器与算法   ≈2144 行   需要时当工具查
E 绑定与平台   ≈1310 行   理解"框架如何启动"必读
B 通知与观察者 ≈1066 行   上层引用最频繁，最该先读
A 身份与契约   ≈ 683 行   行数最少，但决定了 Element 的更新行为
```

**这份地图本身能用**：以后在 foundation 里迷路时，先看这个文件属于哪一区，再决定现在读它还是先跳过它。

## 六、源码实验

### 实验 1：确认 foundation 的封闭性

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src

# 1. foundation 里碰 dart:ui 的文件有几个？
grep -rl "import 'dart:ui'" foundation | sort

# 2. foundation 里引用其它层的文件有几个？
grep -rn "^import '\.\./" foundation | sort
```

**预测**：跨越 `dart:ui` 的应该是个位数，跨层的应该几乎没有。

**实际**：第 1 条输出 5 个文件（`binding` / `change_notifier` / `debug` / `diagnostics` / `memory_allocations`），第 2 条输出 1 个文件（`_error_dumper_web.dart`，Web 专用）。

**说明**：这个封闭性是"最底层"这个身份的定义，不是描述。

### 实验 2：确认导出面比文件数小

```bash
grep -c "^export" packages/flutter/lib/foundation.dart   # 30
find packages/flutter/lib/src/foundation -name '*.dart' | wc -l   # 42
```

差额 12，减去 1 个指向 `package:meta` 的 export，正好对应 13 个条件导入的实现文件。**能被上层 import 到的只是那 29 个**。

### 实验 3：找一找本层被引用最多的文件

```bash
cd packages/flutter/lib/src
for f in foundation/*.dart; do
  n=$(basename "$f" .dart)
  grep -rl "foundation/$n.dart" --include="*.dart" . | grep -v "^./foundation" | wc -l
done | sort -rn | head
```

**说明**：这个方法只能看到相对路径形式的引用。更实用的做法是记住结论——上层最常引用的 foundation 成员是 `ChangeNotifier` 家族、`diagnostics` 家族和 `binding` 家族，正好对应 B / D / E 三区。

## 七、结论

1. foundation 的真正机制只有三块：**身份契约（A）、通知机制（B）、平台绑定（E）**。C 区是工具，D 区占一半篇幅但读上层时可以整块跳过。
2. foundation 的封闭性是可以验证的事实：42 个文件里只有 5 个碰 `dart:ui`，只有 1 个跨出目录。这让它能承载跨层契约。
3. 面对 `defaultTargetPlatform`、`isCanvasKit`、`compute` 这类 getter/函数时，先看门面文件里的 `if (dart.library...)` 条件导入，再决定打开哪份实现。

一句话总结：**foundation 里只有 Key、Listenable、Binding 三件事是机制，其余都是它们和上层要用的工具。**

## 八、边界声明

- 本篇只做分区，不展开任何机制。`Key`、`AbstractNode`、`ChangeNotifier`、容器、`BindingBase` 分别在第二到第七篇展开。
- D 区的诊断体系（`DiagnosticsNode` 的树形渲染、`FlutterErrorDetails` 的组装）本系列不做专题。它是独立的一条线，需要时按类名查即可。
- 平台双实现里的 Web 分支（`_platform_web.dart`、`_capabilities_web.dart` 等）不在本系列展开，只在第七篇给出分叉点。
