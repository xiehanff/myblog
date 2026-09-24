# 07 BindingBase 与平台常量：框架认为自己在哪运行

> 版本锚点：Flutter 3.44.8 (058e0af2c2)
> 源码路径 `foundation/binding.dart`（993 行）、`foundation/platform.dart`（114 行）、`foundation/constants.dart`（96 行）

## 一、问题

`dart:ui` 给出的接口有一个共同特征：**很多能力只有一个回调槽位**。

```dart
platformDispatcher.onReportTimings = ...;   // 只能有一个
```

而框架里有多个模块都想听帧耗时：性能面板要听、`SchedulerBinding` 要听、业务埋点也想听。一个槽位显然不够。

于是需要有人做**多路复用**，并且这个"人"必须是全进程唯一的。这就是 binding。

错误直觉是：`WidgetsFlutterBinding.ensureInitialized()` 是一句"初始化 Flutter"的仪式性代码，可有可无。实际上它决定了整个框架能不能工作——这一篇讲清 binding 的约定、启动顺序，以及框架是如何知道自己"跑在什么平台、什么构建模式"的。

## 二、最小 Demo

按 `binding.dart:92-146` 文档给出的官方写法，自己写一个 binding mixin 和对应的 binding 类：

```dart
import 'package:flutter/widgets.dart';

/// 1. binding mixin：必须做两件事——把 _instance 指向自己、暴露 instance
mixin LoggingBinding on BindingBase {
  @override
  void initInstances() {
    super.initInstances();          // 必须调用，否则链断了
    _instance = this;
    debugPrint('LoggingBinding 初始化完成');
  }

  static LoggingBinding get instance => BindingBase.checkInstance(_instance);
  static LoggingBinding? _instance;

  void logFrame(String message) => debugPrint('[frame] $message');
}

/// 2. binding 类：把 mixin 组合起来，并提供 ensureInitialized
class LoggingFlutterBinding extends WidgetsFlutterBinding with LoggingBinding {
  static LoggingBinding ensureInitialized() {
    if (LoggingBinding._instance == null) {
      LoggingFlutterBinding();
    }
    return LoggingBinding.instance;
  }
}

void main() {
  // 3. 必须在 runApp 之前，因为 binding 只能构造一次
  LoggingFlutterBinding.ensureInitialized();
  LoggingBinding.instance.logFrame('第一帧之前');
  runApp(const SizedBox.shrink());
}
```

注意第 3 步：如果先 `runApp()` 再调 `ensureInitialized()`，`WidgetsBinding._instance` 已经非空，你的 `LoggingFlutterBinding` 永远不会被构造——`LoggingBinding.instance` 随后会抛错。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `binding.dart:148` | `abstract class BindingBase` |
| `binding.dart:155-179` | 构造函数：四步 + 四个断言 |
| `binding.dart:291-298` | `initInstances` 的默认实现，只做 debug 记账 |
| `binding.dart:312-404` | `checkInstance`，四种失败形态的错误文案 |
| `binding.dart:249` | `platformDispatcher` getter，可有可无的间接层 |
| `binding.dart:643-699` | `locked` / `lockEvents` / `unlocked`，事件锁 |
| `binding.dart:931-983` | `registerServiceExtension`，`ext.flutter.*` 的实现 |
| `platform.dart:51` | `TargetPlatform get defaultTargetPlatform` |
| `platform.dart:104-113` | `debugDefaultTargetPlatformOverride` 的 getter / setter |
| `constants.dart:25` / `40` / `64` | `kReleaseMode` / `kProfileMode` / `kDebugMode` |
| `constants.dart:71` | `precisionErrorTolerance` |
| `constants.dart:83` / `95` | `kIsWeb` / `kIsWasm` |
| `widgets/binding.dart:2128` | `class WidgetsFlutterBinding`，mixin 的组合清单 |
| `widgets/binding.dart:2149-2155` | `ensureInitialized` |

## 四、调用链

### 4.1 `BindingBase()` 构造函数：四步与四个断言

```dart
// binding.dart:155-179（节选）
BindingBase() {
  if (!kReleaseMode) {
    FlutterTimeline.startSync('Framework initialization');
  }
  assert(() {
    _debugConstructed = true;
    return true;
  }());

  assert(_debugInitializedType == null, 'Binding is already initialized to $_debugInitializedType');
  initInstances();
  assert(_debugInitializedType != null);

  assert(!_debugServiceExtensionsRegistered);
  initServiceExtensions();
  assert(_debugServiceExtensionsRegistered);

  if (!kReleaseMode) {
    developer.postEvent('Flutter.FrameworkInitialization', <String, String>{});
    FlutterTimeline.finishSync();
  }
}
```

四个断言各自守卫一件事：

| 断言 | 守卫什么 |
|---|---|
| `_debugInitializedType == null` | **binding 全进程只能初始化一次** |
| `_debugInitializedType != null` | 子类必须调用 `super.initInstances()` |
| `!_debugServiceExtensionsRegistered` | 不能重复注册 service extension |
| `_debugServiceExtensionsRegistered` | 子类必须调用 `super.initServiceExtensions()` |

中间两个是最有价值的设计：**它把"你忘了调 super"从一个难以定位的运行时问题，变成了一条明确的断言失败消息。**

**关键认知**：所有 binding mixin 的 `initInstances` 都必须 `super.initInstances()` 打头。mixin 组合链正是靠这一步串起来的——少了它，链上后面的 mixin 的 `initInstances` 全部不会执行，而失败现象会出现在很远的地方。

### 4.2 mixin 链：`WidgetsFlutterBinding` 的组装方式

```dart
// widgets/binding.dart:2128-2135
class WidgetsFlutterBinding extends BindingBase
    with
        GestureBinding,
        SchedulerBinding,
        ServicesBinding,
        PaintingBinding,
        SemanticsBinding,
        RendererBinding,
        WidgetsBinding {
```

**这个 `with` 顺序不是随意的**。每个 mixin 都声明了 `on` 约束，比如：

```dart
mixin SchedulerBinding on BindingBase                                    // scheduler/binding.dart:250
mixin ServicesBinding on BindingBase, SchedulerBinding                   // services/binding.dart:45
mixin PaintingBinding on BindingBase, ServicesBinding                    // painting/binding.dart:23
mixin GestureBinding on BindingBase implements HitTestable, ...          // gestures/binding.dart:276
mixin RendererBinding on ...                                            // rendering/binding.dart:44
```

`on` 约束要求"混入这个 mixin 的类必须已经实现了那些能力"，所以顺序必须满足依赖。而 `initInstances` 的执行顺序由链式 `super` 决定，大致对应"从底层能力到上层能力"。

**`BindingBase.platformDispatcher` 这个间接层的意义**：

```dart
// binding.dart:249
ui.PlatformDispatcher get platformDispatcher => ui.PlatformDispatcher.instance;
```

实现体只是转手，看起来毫无价值。但文档解释了它的用途：`TestWidgetsFlutterBinding` 可以**重写这个 getter** 返回一个假的 `PlatformDispatcher`。所有 binding 都通过这里拿 dispatcher，于是测试可以替换掉整个平台层。这是一处典型的"为可测试性预留的接缝"。

### 4.3 `checkInstance`：把错误信息写成文档

这是 foundation 里最值得读的一段错误处理代码。它按四种失败形态分别给出指引（`binding.dart:312-404`）：

| 失败形态 | 错误摘要 | 提示的根因 |
|---|---|---|
| binding 从未初始化 | `Binding has not yet been initialized.` | 调 `WidgetsFlutterBinding.ensureInitialized()` 或 `runApp()` |
| mixin 没被混入 | `Binding mixin instance is null but bindings are already initialized.` | 自定义 binding 类忘了 mix in 这个 mixin |
| 没调 `super.initInstances()` | `Binding initialized without calling initInstances.` | `initInstances` 里没调 super |
| 用 `implements` 而非 `extends` | `Binding does not extend BindingBase` | 具体 binding 类必须 extends / with `BindingBase` |

每一条都带 `ErrorHint`，比如：

```dart
ErrorHint(
  'Typically, this is done by calling "WidgetsFlutterBinding.ensureInitialized()" or "runApp()" (the '
  'latter calls the former). Typically this call is done in the "void main()" method. The "ensureInitialized" method '
  'is idempotent; calling it multiple times is not harmful. After calling that method, the "instance" getter will '
  'return the binding.',
),
```

**关键认知**：**错误信息是框架里最容易被忽略、但信息密度最高的文档。** 它回答的不是"哪里出错了"，而是"这个 API 的契约是什么"。第七节的实验会给出一个反例：这段精心写的文案，在 debug 模式下其实走不到。

### 4.4 平台常量：全部是编译期常量

```dart
// constants.dart:25, 40, 64, 71, 83, 95
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
const double precisionErrorTolerance = 1e-10;
const bool kIsWeb = bool.fromEnvironment('dart.library.js_interop');
const bool kIsWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

全部是 `const`，而且是 `bool.fromEnvironment` 这种**编译期可求值**的形式。这一点很关键：

```dart
// 这类写法在 release 构建里整块被 tree shake 掉
if (!kReleaseMode) {
  registerStringServiceExtension(name: ..., getter: ..., setter: ...);
}
```

`binding.dart` 里的 `initServiceExtensions` 正是这么用的，所以源码注释反复强调："要保证 tree shaker 能删掉这段代码"。

`kDebugMode` 的定义方式也值得注意——它**不是**从环境读第三个标志，而是由另外两个推导：

```dart
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

这样三个值永远自洽，不可能出现"debug 和 release 同时为真"的矛盾状态。

`precisionErrorTolerance = 1e-10` 是另一个高频常量。浮点比较用它：

```dart
// 框架内到处可见的写法
if ((a - b).abs() < precisionErrorTolerance) { ... }
```

**这提醒你：框架内部比较浮点尺寸时用的是"接近"而不是"相等"。** 自己写 RenderObject 或做布局计算时应该沿用这个约定。

### 4.5 `defaultTargetPlatform` 与它的调试覆盖

```dart
// platform.dart:51
@pragma('vm:platform-const-if', !kDebugMode)
TargetPlatform get defaultTargetPlatform => platform.defaultTargetPlatform;

// platform.dart:104-113
TargetPlatform? get debugDefaultTargetPlatformOverride => _debugDefaultTargetPlatformOverride;

set debugDefaultTargetPlatformOverride(TargetPlatform? value) {
  assert(() {
    if (kReleaseMode) {
      throw FlutterError('Cannot modify debugDefaultTargetPlatformOverride in non-debug builds.');
    }
    return true;
  }());
  _debugDefaultTargetPlatformOverride = value;
}

TargetPlatform? _debugDefaultTargetPlatformOverride;
```

三个细节：

1. **取值走条件导入**（`platform.dart:9` 的 `if (dart.library.js_interop)`），原生用 `dart:io Platform`，Web 用浏览器信息。
2. **setter 的守卫写在 `assert` 里**，所以 release 构建下整个检查会被删除，写入操作变成空操作——但 `_debugDefaultTargetPlatformOverride` 已经没人在乎了，因为 `defaultTargetPlatform` 在 release 下走的是 `vm:platform-const-if` 的编译期常量路径。
3. **测试环境固定返回 `TargetPlatform.android`**，与宿主平台无关。这条在 `platform.dart:22-28` 的文档里写明，理由是"测试最初是按 Android 行为写的，后来才加的 iOS 适配"。

所以"想让测试跑 iOS 行为"必须显式覆盖：

```dart
debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
// ... 测试代码
debugDefaultTargetPlatformOverride = null;
```

### 4.6 service extension：`ext.flutter.*` 的注册与"出帧"处理

```dart
// binding.dart:931-982（节选）
void registerServiceExtension({required String name, required ServiceExtensionCallback callback}) {
  final methodName = 'ext.flutter.$name';
  developer.registerExtension(methodName, (String method, Map<String, String> parameters) async {
    ...
    // 关键：把回调推到"外层事件循环"
    await debugInstrumentAction<void>('Wait for outer event loop', () {
      return Future<void>.delayed(Duration.zero);
    });

    late Map<String, dynamic> result;
    try {
      result = await callback(parameters);
    } catch (exception, stack) {
      FlutterError.reportError(...);
      return developer.ServiceExtensionResponse.error(...);
    }
    result['type'] = '_extensionType';
    result['method'] = method;
    return developer.ServiceExtensionResponse.result(json.encode(result));
  });
}
```

`await Future.delayed(Duration.zero)` 那一步的源码注释解释得很清楚：VM service 的扩展消息是"带外"处理的（out of band），**可能在 microtask 循环中间、甚至在一帧的中间被执行**，这会打断框架的许多断言。所以这里刻意把回调推到外层事件循环，等当前帧/当前 microtask 批次结束再执行。

**关键认知**：框架连"什么时候执行调试命令"都要管。这是一个很好的例子——**框架里几乎没有一个 `await` 是随手写的**，每一个延迟调度都有它要避开的时序问题。

### 4.7 事件锁

```dart
// binding.dart:643-699（节选）
bool get locked => _lockCount > 0;

Future<void> lockEvents(Future<void> Function() callback) {
  ...
  _lockCount += 1;
  final Future<void> future = callback();
  future.whenComplete(() {
    _lockCount -= 1;
    if (!locked) {
      ...
      unlocked();     // 冲掉锁期间排队的事件
    }
  });
  return future;
}
```

`lockEvents` 用计数器而不是布尔值，因为可能嵌套。它有两个使用者：`reassembleApplication()`（热重载）和 `SchedulerBinding.scheduleWarmUpFrame()`（首帧预热）：

```text
reassembleApplication()                  // binding.dart:719
    ↓
lockEvents(performReassemble)            // 热重载期间不接受输入事件
    ↓
performReassemble()                      // binding.dart:735，各 binding 重写
    ↓
FlutterError.resetErrorCount()
```

```text
scheduleWarmUpFrame()                    // scheduler/binding.dart:1037
    ↓
lockEvents(() async { await endOfFrame; })   // :1074，首帧完成前不接受输入事件
```

`GestureBinding` 会检查 `locked`，锁期间把指针事件排队；`SchedulerBinding.scheduleTask` 也会等 `locked` 为假才启动任务。**这就是热重载时（以及首帧预热期间）界面短暂不响应触摸的原因**——不是卡住了，是刻意锁住的。

## 五、核心对象：常量 vs 运行期值

这一层里最需要分清的是"哪些是编译期就定死的，哪些运行期可改"：

| 值 | 性质 | 能否在运行期改变 |
|---|---|---|
| `kReleaseMode` / `kProfileMode` / `kDebugMode` | `const`，编译期确定 | 不能，写代码时就知道 |
| `kIsWeb` / `kIsWasm` | `const`，编译期确定 | 不能 |
| `precisionErrorTolerance` | `const` 纯量 | 不能（也不该改） |
| `defaultTargetPlatform` | getter，release 下走平台常量路径 | debug 下可通过 `debugDefaultTargetPlatformOverride` 覆盖 |
| `BindingBase.debugBindingType()` | debug 专用 | release 下恒返回 `null` |
| `TargetPlatform` 枚举值 | 编译期常量 | 新增平台需要在 `_platform_io` / `_platform_web` 里加判定规则 |

`platform.dart:39-45` 有一段注释说明新增平台时**必须**同时改两个实现文件，并且不允许让新平台"默认退化成其它平台的行为"——理由是那样会永远困在模拟里，以后想给它做专属行为就变成破坏性变更。

## 六、源码实验

### 实验 1：确认框架自认的运行环境

```dart
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('bindingType         = ${BindingBase.debugBindingType()}');
  debugPrint('defaultTargetPlatform = $defaultTargetPlatform');
  debugPrint('kIsWeb=$kIsWeb kIsWasm=$kIsWasm');
  debugPrint('kDebugMode=$kDebugMode kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  debugPrint('precisionErrorTolerance = $precisionErrorTolerance');
}
```

在 `flutter test` 里运行，**实际输出**：

```text
bindingType            = TestWidgetsFlutterBinding
defaultTargetPlatform  = TargetPlatform.android
kIsWeb=false kIsWasm=false
kDebugMode=true kProfileMode=false kReleaseMode=false
precisionErrorTolerance = 1e-10
```

**说明**：`bindingType` 是 `TestWidgetsFlutterBinding` 而不是 `WidgetsFlutterBinding`——`WidgetsFlutterBinding.ensureInitialized` 的文档专门提醒了这一点（`widgets/binding.dart:2143-2148`）。默认平台是 `android` 而非宿主平台，也是文档写明的前提。

### 实验 2：覆盖目标平台

```dart
debugPrint('$defaultTargetPlatform');                    // TargetPlatform.android

final TargetPlatform? previous = debugDefaultTargetPlatformOverride;
debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
debugPrint('$defaultTargetPlatform');                    // TargetPlatform.iOS
debugDefaultTargetPlatformOverride = previous;
debugPrint('$defaultTargetPlatform');                    // TargetPlatform.android
```

**说明**：这个开关的实际用途是让同一套测试代码能跑多平台行为（配合 `TargetPlatformVariant`）。注意必须在 `finally` 里还原，否则会污染同一进程里后续的测试。

### 实验 3：binding 只能构造一次

```dart
import 'package:flutter/foundation.dart';

class ProbeBinding extends BindingBase {}

void main() {
  // 在 flutter test 环境下，测试 binding 已经初始化过了
  ProbeBinding();   // 抛 AssertionError
}
```

**实际现象**：抛出 `AssertionError`，消息形如 `Binding is already initialized to TestWidgetsFlutterBinding`。

**说明**：这个断言是 binding 的"单例"语义的直接体现。它同时解释了为什么自定义 binding **必须**在 `runApp()` 之前构造（第二节 Demo 的第 3 步）。

### 实验 4：那段精心写的错误文案，在 debug 下走不到

```dart
try {
  // ignore: invalid_use_of_protected_member
  BindingBase.checkInstance<WidgetsBinding>(null);
} catch (error) {
  debugPrint('${error.runtimeType}');
  debugPrint('${error.toString().split('\n').first}');
}
```

**预测**：会抛出 `FlutterError`，消息里包含 `Binding mixin instance is null but bindings are already initialized.`

**实际**（实测输出）：

```text
_AssertionError
'package:flutter/src/foundation/binding.dart': Failed assertion: line 337 pos 16: '_debugInitializedType == null': is not true.
```

**说明**：`checkInstance` 在 `instance == null` 分支里，第一句就是：

```dart
// binding.dart:336-338
if (instance == null) {
  assert(_debugInitializedType == null);
  throw FlutterError.fromParts(<DiagnosticsNode>[ ... ]);
```

在测试（binding 已初始化）环境下，`_debugInitializedType` 非空，于是**断言先于那条 `throw` 触发**。也就是说：这段为"bindings 已初始化但 instance 为 null"准备的详细指引，在 debug 构建下不可达，只在 release（断言被剥除）时才会输出。

**这不算 bug，但足够说明一件事**：读错误处理代码时必须区分"debug 下会发生什么"和"release 下会发生什么"。`assert` 会在 debug 下改变控制流——这是读 Flutter 源码时最容易被误导的一类地方。

### 实验 5：确认平台常量是编译期常量

```bash
grep -n "bool.fromEnvironment" packages/flutter/lib/src/foundation/constants.dart
```

**实际输出**：`kReleaseMode`、`kProfileMode`、`kIsWeb`、`kIsWasm` 四项都是 `bool.fromEnvironment(...)`，`kDebugMode` 则由前两者推导。

**说明**：`bool.fromEnvironment` 是编译期常量，所以 `if (!kReleaseMode)` 这类分支能在编译时被消除。这解释了为什么框架里大量代码用 `assert(() { ... }())` 而不是 `if (kDebugMode)` **或者** 反过来用 `if (!kReleaseMode)`——两者的删除时机不同：`assert` 在 release 下整体消失，`!kReleaseMode` 在 release 下被判定为真而保留代码。想同时保留给 profile 模式用的代码，必须用后者。

## 七、结论

1. binding 的契约是"全进程唯一 + mixin 链式初始化"：构造函数用四个断言把"忘了调 super""重复初始化""用错继承方式"这几类错误变成明确的失败信息，所有 mixin 的 `initInstances` 必须 `super.initInstances()` 打头。
2. `BindingBase.platformDispatcher` 这样的"零逻辑转发"是为了给测试留替换点；`WidgetsFlutterBinding` 的 `with` 顺序受各 mixin 的 `on` 约束限制，不能随意调换。
3. 平台与构建模式全部是编译期常量（`kIsWeb` / `kReleaseMode` / ...），`defaultTargetPlatform` 在 release 下走编译期常量路径、在 debug 下可被 `debugDefaultTargetPlatformOverride` 覆盖，测试环境固定为 `android`。读错误处理分支时必须区分 debug 与 release——`assert` 会改变控制流。

一句话总结：**binding 就是"把 dart:ui 的单槽位接口变成多监听者服务"的那个全进程唯一对象。**

## 八、边界声明

- 本篇只讲 foundation 层的 binding。`SchedulerBinding` 的帧调度、`ServicesBinding` 的消息通道、`RendererBinding` 的布局绘制编排分别在第四卷、第七卷、第八卷展开。
- `reassembleApplication` 与热重载的完整链路（谁触发、各 binding 如何响应）不在本系列展开。
- `lockEvents` 与手势事件的排队交互，留到第六卷 gestures。
- 各平台 `_platform_io.dart` / `_platform_web.dart` 的判定规则不逐行展开，需要时按 `platform.dart:39-45` 的注释指引读。
