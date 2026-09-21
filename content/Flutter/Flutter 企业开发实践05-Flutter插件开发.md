---
title: Flutter 企业开发实践05-Flutter插件开发
date: 2026-05-18
tags:
  - Flutter
  - 插件开发
  - Platform Channel
  - Pigeon
  - FFI
  - 面试
---

# Flutter 插件开发

## 概述

Flutter 插件解决的核心问题就一个：**Dart 代码没法直接访问平台原生 API**。你要调蓝牙、相机、支付 SDK、推送这些平台能力，就得靠插件在 Dart 和原生代码之间搭一座桥。

要是只把它当成"怎么写 Channel"的技术题，那方向就偏了。这是个工程决策：什么时候该写插件、什么时候写包？通信方式挑哪种？跨版本兼容怎么保证？这几个决定直接影响团队的开发效率和应用的稳定性。

## 核心内容

### 1. 插件还是包，怎么选

**包（Package）**：纯 Dart 代码，不碰平台原生实现。如 `provider`、`dio`、`get`。

**插件（Plugin）**：Dart API 加平台原生实现（Android Kotlin/Java、iOS Swift/ObjC），中间通过 Platform Channel 通信。如 `camera`、`shared_preferences`。

选型决策树：

```
需要调用平台原生 API？
├── 是 → 插件（Plugin）
│   ├── 已有成熟插件？→ 直接用，评估维护活跃度
│   └── 无成熟插件？→ 自研插件
└── 否 → 包（Package）
    ├── 纯逻辑/数据层？→ 纯 Dart 包
    └── UI 组件？→ 纯 Dart 包（可能依赖 Flutter SDK）
```

**为什么不全部写成包？** 包突破不了 Dart VM 的沙箱限制。比如你要拿设备电量，Dart 里就没这个 API，必须走原生。硬用包去做，要么做不了，要么还得再依赖一个插件绕一圈，那还不如直接写插件。

**什么时候该写插件、什么时候写包？**

- 要访问平台硬件能力（传感器、蓝牙、NFC）
- 要集成平台 SDK（微信支付、极光推送、地图）
- 要用平台特有的 UI 组件（WebView、视频播放器）
- 性能敏感，要原生计算（图像处理、加密）

### 2. Platform Channel 三种方式

Platform Channel 是 Dart 和原生之间传消息的机制，底层是异步消息队列。三种 Channel 类型，各有各的适用场景：

#### MethodChannel

用得最多，**一次请求一次响应**，跟 RPC 调用差不多。

```dart
// Dart 端
class BatteryPlugin {
  static const _channel = MethodChannel('com.example/battery');

  Future<int> getBatteryLevel() async {
    final level = await _channel.invokeMethod<int>('getBatteryLevel');
    return level!;
  }
}
```

```kotlin
// Android 端 [Android]
class BatteryPlugin : FlutterPlugin, MethodCallHandler {
  private lateinit var channel: MethodChannel

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel = MethodChannel(binding.binaryMessenger, "com.example/battery")
    channel.setMethodCallHandler(this)
  }

  // FlutterPlugin 接口的另一个抽象方法，与 onAttachedToEngine 成对，
  // 引擎销毁时必须清理 handler（缺了它 Kotlin 下无法编译）
  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel.setMethodCallHandler(null)
  }

  override fun onMethodCall(call: MethodCall, result: Result) {
    when (call.method) {
      "getBatteryLevel" -> {
        val level = getBatteryLevelFromSystem()
        result.success(level)
      }
      else -> result.notImplemented()
    }
  }
}
```

**适用场景**：绝大多数插件 API，比如取数据、执行操作、返回结果。

#### EventChannel

**持续的事件流**，基于 `Stream`，原生端一直往 Dart 推数据。

```dart
// Dart 端
class AccelerometerPlugin {
  static const _channel = EventChannel('com.example/accelerometer');

  Stream<AccelerometerEvent> get events {
    return _channel.receiveBroadcastStream().map((event) {
      final list = event as List;
      return AccelerometerEvent(list[0], list[1], list[2]);
    });
  }
}
```

```swift
// iOS 端 [iOS]
class AccelerometerStreamHandler: NSObject, FlutterStreamHandler {
  private var motionManager: CMMotionManager?

  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    motionManager = CMMotionManager()
    motionManager?.accelerometerUpdateInterval = 1.0 / 60.0
    motionManager?.startAccelerometerUpdates(to: .main) { data, _ in
      guard let data = data else { return }
      events([data.acceleration.x, data.acceleration.y, data.acceleration.z])
    }
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    motionManager?.stopAccelerometerUpdates()
    motionManager = nil
    return nil
  }
}
```

**适用场景**：传感器数据、GPS 位置更新、WebSocket 消息推送、进度回调。

**为什么不用 MethodChannel 模拟事件流？** 反复调 MethodChannel 当然也行，但那就得让 Dart 端轮询，延迟高还费 CPU。EventChannel 是原生端主动推，实时性更好，也更省资源。

#### BasicMessageChannel

**双向消息传递**，编解码器可以自己定。不必非要是请求-响应，也不必是单向流。

```dart
// Dart 端 - 自定义消息协议
class MessagePlugin {
  static const _channel = BasicMessageChannel<String>(
    'com.example/message',
    StringCodec(),
  );

  Future<String> sendMessage(String message) async {
    final reply = await _channel.send(message);
    return reply ?? '';
  }
}
```

**适用场景**：
- 得双向通信的场景（如 IM SDK 的消息收发）
- 要自定义二进制协议（用 `BinaryCodec` 或 `StandardMessageCodec`）
- 通信协议不是简单的请求-响应模式

#### 三种 Channel 对比

| 维度 | MethodChannel | EventChannel | BasicMessageChannel |
|------|---------------|--------------|---------------------|
| 通信模式 | 请求-响应 | 单向流 | 双向消息 |
| 返回类型 | `Future<T>` | `Stream<T>` | `Future<T>`（单次） |
| 编解码 | StandardMethodCodec | StandardMethodCodec | 可自定义 |
| 典型场景 | 调用方法 | 事件监听 | 双向通信 |
| 内部实现 | 基于 BasicMessageChannel | 基于 MethodChannel | 底层实现 |

### 3. Pigeon：用代码生成代替手写

手写 Platform Channel 最大的问题是**类型不安全**。方法名是字符串，参数类型得手动对，返回值得强转。原生端一改签名，Dart 端编译不报错，跑起来才崩。

Pigeon 走的是**接口定义生成代码**这条路，把类型不安全这个坑直接填掉。

```dart
// pigeon/input_api.dart
import 'package:pigeon/pigeon.dart';

@HostApi()
abstract class InputApi {
  @async
  InputResult processInput(InputRequest request);

  @async
  List<String> getSupportedTypes();
}

class InputRequest {
  InputRequest({required this.type, required this.data, this.options});
  String type;
  String data;
  Map<String?, String?>? options;
}

class InputResult {
  InputResult({required this.success, this.result, this.errorCode});
  bool success;
  String? result;
  int? errorCode;
}
```

跑一下代码生成：

```bash
# 生成 Dart 端
dart run pigeon --input pigeon/input_api.dart \
  --dart_out lib/src/input_api.g.dart

# 生成 Android 端 [Android]
dart run pigeon --input pigeon/input_api.dart \
  --kotlin_out android/app/src/main/kotlin/InputApi.g.kt

# 生成 iOS 端 [iOS]
dart run pigeon --input pigeon/input_api.dart \
  --swift_out ios/Runner/InputApi.g.swift
```

Dart 端这么用：

```dart
// 自动生成的代码，类型安全
class InputPlugin {
  final InputApi _api = InputApi();

  Future<InputResult> process(String type, String data) async {
    final request = InputRequest(type: type, data: data);
    return await _api.processInput(request);
  }
}
```

**Pigeon 比手写 Channel 好在哪？**

| 维度 | 手写 Channel | Pigeon |
|------|-------------|--------|
| 类型安全 | 否，运行时崩溃 | 是，编译期检查 |
| 方法签名一致性 | 靠人工保证 | 自动生成，强一致 |
| 重构友好 | 改一处忘改另一处 | 改接口定义，重新生成 |
| 代码量 | 多，样板代码重复 | 少，只写接口定义 |
| 学习成本 | 低 | 需要理解 Pigeon 语法 |
| 灵活性 | 高，可随意定制 | 受限于支持的特性 |

**什么时候不用 Pigeon？** 通信场景极度复杂的时候（比如自定义二进制协议），或者非要用 BasicMessageChannel 做双向通信。Pigeon 现在主要支持两种模式：`@HostApi`（Dart 调原生）和 `@FlutterApi`（原生调 Dart）。

### 4. FFI（dart:ffi）适用场景

FFI（Foreign Function Interface）让 Dart 直接调 C/C++ 动态库，**绕过 Platform Channel**，不走消息队列，直接在内存里调。

```dart
import 'dart:ffi';
import 'package:ffi/ffi.dart';

// 加密库示例
typedef NativeEncrypt = Pointer<Utf8> Function(Pointer<Utf8> data, Pointer<Utf8> key);
typedef DartEncrypt = Pointer<Utf8> Function(Pointer<Utf8> data, Pointer<Utf8> key);

class CryptoFFI {
  late final DynamicLibrary _lib;
  late final DartEncrypt _encrypt;

  CryptoFFI() {
    _lib = Platform.isAndroid
        ? DynamicLibrary.open('libcrypto.so')
        : DynamicLibrary.process(); // iOS: 静态链接 [双端]
    _encrypt = _lib.lookupFunction<NativeEncrypt, DartEncrypt>('encrypt');
  }

  String encrypt(String data, String key) {
    final dataPtr = data.toNativeUtf8();
    final keyPtr = key.toNativeUtf8();
    try {
      final resultPtr = _encrypt(dataPtr, keyPtr);
      return resultPtr.toDartString();
    } finally {
      calloc.free(dataPtr);
      calloc.free(keyPtr);
    }
  }
}
```

**FFI 和 Platform Channel 怎么选：**

| 维度 | Platform Channel | FFI |
|------|-----------------|-----|
| 通信方式 | 异步消息队列 | 同步内存调用 |
| 性能 | 有序列化/反序列化开销 | 接近原生调用 |
| 平台 API 访问 | 通过平台 SDK 间接访问 | 不支持，只能调 C/C++ |
| 适用语言 | Kotlin/Swift/ObjC | C/C++ |
| 调试 | 有日志栈 | 较难调试，需 GDB/LLDB |
| 内存安全 | 由平台 GC 管理 | 手动管理，易内存泄漏 |

**什么时候用 FFI？**
- 现成的 C/C++ 库要在多个平台复用（加密算法、图像处理、音视频编解码）
- 计算性能要求极高（想避开 Channel 的序列化开销）
- 需要同步调用（Channel 只能异步）

**什么时候不用 FFI？**
- 要调的是 Java/Kotlin/Swift API（FFI 调不了）
- 团队没人写过 C/C++（维护成本极高）
- 只是拿个简单的平台能力（杀鸡用牛刀）

### 5. 插件发布流程

#### 发布到 pub.dev

```bash
# 1. 检查包规范
dart pub publish --dry-run

# 2. 发布（需要 Google 账号授权）
dart pub publish
```

发布前把这些过一遍：
- `pubspec.yaml` 填写完整：description、homepage/repository、platforms
- `README.md` 包含使用说明和示例
- `CHANGELOG.md` 记录版本变更
- `example/` 目录提供完整示例
- 通过 `dart format` 和 `dart analyze` 检查
- 许可证文件（`LICENSE`）

#### 私有仓库发布

企业内部的代码一般不想公开，那就得走私有仓库：

**方案一：Git 仓库引用**

```yaml
# pubspec.yaml
dependencies:
  my_plugin:
    git:
      url: https://git.company.com/flutter/my_plugin.git
      ref: v1.2.0  # 或 main / commit hash
```

**方案二：自建 pub server**

```bash
# 使用 unpub 搭建私有 pub 仓库
dart pub global activate unpub
unpub --database=mongodb://localhost:27017/dart_pub --port=4000

# 发布到私有仓库
dart pub publish --server=http://pub.company.com
```

```yaml
# pubspec.yaml 引用
dependencies:
  my_plugin:
    hosted:
      name: my_plugin
      url: https://pub.company.com
    version: ^1.2.0
```

**企业里的建议**：Git 仓库引用适合小团队（<10 个包）；自建 pub server 适合内部包很多的中大团队，代价是还得多维护一套 CI/CD 集成和版本管理。

### 6. 插件开发最佳实践

#### 线程安全

Platform Channel 的回调是在**平台主线程**上跑的。耗时操作必须切线程：

```kotlin
// Android: 耗时操作必须切到后台线程 [Android]
override fun onMethodCall(call: MethodCall, result: Result) {
  when (call.method) {
    "heavyProcess" -> {
      thread {
        val output = doHeavyWork(call.arguments as String)
        // 回到主线程返回结果
        handler.post { result.success(output) }
      }
    }
    else -> result.notImplemented()
  }
}
```

```swift
// iOS: 同理 [iOS]
func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
  switch call.method {
  case "heavyProcess":
    DispatchQueue.global(qos: .userInitiated).async {
      let output = self.doHeavyWork(call.arguments as! String)
      DispatchQueue.main.async {
        result(output)
      }
    }
  default:
    result(FlutterMethodNotImplemented)
  }
}
```

**不切线程会怎样？** 原生端把主线程卡住，UI 就冻住，Android 上直接 ANR，iOS 上就是卡顿。反过来也不行，在后台线程直接调 `result.success()` 会抛异常。

#### 生命周期管理

FlutterPlugin 接口带了生命周期钩子，资源得在 `onDetachedFromEngine` 里清掉：

```kotlin
class MyPlugin : FlutterPlugin, MethodCallHandler, ActivityAware {
  private var channel: MethodChannel? = null
  private var activity: Activity? = null
  private var sensorManager: SensorManager? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel = MethodChannel(binding.binaryMessenger, "my_plugin")
    channel?.setMethodCallHandler(this)
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel?.setMethodCallHandler(null)
    channel = null
    sensorManager = null
    // 释放所有原生资源
  }

  // ActivityAware 生命周期：接口共 4 个抽象方法，一个都不能少，
  // Kotlin 下缺任何一个都无法编译（Java 下则是必须补 @Override 的抽象方法）
  override fun onAttachedToActivity(binding: ActivityPluginBinding) {
    activity = binding.activity
  }

  // 配置变更（旋转屏幕等）导致 Activity 重建时，先走这里 detach
  override fun onDetachedFromActivityForConfigChanges() {
    activity = null
  }

  // 重建后的新 Activity 走这里重新 attach
  override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
    activity = binding.activity
  }

  // 引擎与 Activity 彻底分离（页面销毁）时走这里
  override fun onDetachedFromActivity() {
    activity = null
  }
}
```

**不清理会怎样？** 内存泄漏。最常见的就是 EventChannel 的 StreamHandler 拿着 Context 引用，引擎都销毁了，Context 还释放不掉。

#### 向后兼容

插件 API 改动要保证向后兼容，别让使用方一升级就崩：

```dart
// 好的做法：新增参数给默认值，不破坏已有调用
@HostApi()
abstract class PaymentApi {
  // v1.0: processPayment(String orderId)
  // v2.0: 新增 currency 参数，但旧版本不传也能用
  @async
  PaymentResult processPayment(PaymentRequest request);
}

class PaymentRequest {
  PaymentRequest({required this.orderId, this.currency = 'CNY'});
  String orderId;
  String currency; // 新增字段有默认值
}
```

版本策略：
- 遵循 SemVer：破坏性变更升大版本号
- 新增方法不影响旧方法
- 新增参数都给默认值
- 废弃方法标记 `@Deprecated`，至少保留一个大版本周期
- 在 CHANGELOG 明确标注 Breaking Changes

#### Federated Plugin 架构

大型插件推荐上联邦架构（Federated Plugin），把接口和实现拆开：

```
my_plugin/              ← Dart API（面向用户）
  lib/
    my_plugin.dart
    src/
      method_channel_my_plugin.dart  ← 默认 MethodChannel 实现

my_plugin_platform_interface/  ← 平台接口定义
  lib/
    my_plugin_platform_interface.dart

my_plugin_android/      ← Android 实现（可选）
my_plugin_ios/          ← iOS 实现（可选）
my_plugin_web/          ← Web 实现（可选）
```

**为什么这么拆？** 平台实现能独立替换。用户可以在 `pubspec.yaml` 里覆盖默认实现，换成自己写的，不用 fork 整个插件。Web、Desktop 这些新平台也能各加各的。

## 常见坑

### 1. Channel 名称冲突

多个插件用了同一个 Channel 名称，handler 就会互相覆盖。**前缀一定要用域名反转**：`com.company.plugin/method`。

### 2. 数据类型限制

Platform Channel 能自动序列化的类型就这些：

- 基本类型：`bool`、`int`、`double`、`String`
- 集合：`List`、`Map`
- `Uint8List`（二进制数据）

**不支持**：自定义对象、`DateTime`、枚举。要传自定义对象，得自己转 Map；用 Pigeon 的话，序列化代码它会自动生成。

### 3. 编解码性能

`StandardMethodCodec` 序列化大数组、大 Map 是有开销的。数据量大、传得又频繁，就得考虑：
- 用 `BasicMessageChannel` + `BinaryCodec` 传原始二进制
- 用 FFI 直接共享内存

### 4. 插件注册顺序

Flutter 3.0+ 走 `FlutterPlugin` 自动注册（`GeneratedPluginRegistrant`），不用再手动在 `MainActivity` 里注册。不过你要是用了 `ActivityAware`，得保证 `onAttachedToActivity` 在业务调用之前跑完，不然拿不到 Activity。

### 5. iOS 最低版本

插件在 `podspec` 里声明的最低 iOS 版本必须 ≤ 宿主 App 的最低版本，不然 `pod install` 直接报错。推荐声明 `s.ios.deployment_target = '13.0'`（注意这是 podspec 语法；`platform :ios, '13.0'` 是宿主 Podfile 的写法）。版本背景：Flutter 3.22 只是把插件模板最低提到 12.0；**iOS 13 门槛是 3.32 宣布弃用 iOS 12、3.35 正式生效**，2026 年新插件按 13 声明。

## 面试追问

### 什么时候该写插件、什么时候写包？

要访问平台原生能力就写插件，纯 Dart 逻辑就写包。判断标准其实就一条：Dart SDK 里有没有对应的能力？没有、也没法用纯 Dart 实现，那就写插件。典型场景：硬件访问、平台 SDK 集成、平台特有 UI。

### Pigeon 比手写 Channel 好在哪？

核心优势是**类型安全**。手写 Channel 时方法名和参数类型都是字符串、动态类型，原生端改了签名，Dart 端编译不报错。Pigeon 从接口定义生成两端的代码，签名能对齐，编译期就能发现不一致。顺带还有两个好处：样板代码少了，重构也安全。

### FFI 什么时候用？和 Platform Channel 怎么选？

FFI 适合调 C/C++ 库的场景：现成的加密、图像、音视频库要复用，性能要求高到需要同步调用，或者想避开 Channel 的序列化开销。Platform Channel 适合调平台 SDK（Java/Kotlin/Swift API）的场景。两者不冲突，一个插件可以两种一起用。

### Federated Plugin 架构解决了什么问题？

把 Dart API、平台接口定义、平台实现这三块解耦了。好处：平台实现能独立替换（用户可覆盖默认实现）；新平台支持能单独加（Web/Desktop 都不影响主包）；不同平台的实现还能各自发版。代价是包结构更复杂、维护成本更高，简单插件用不上这套。

### 如何设计一个高性能的 Platform Channel 通信方案？

1. 优先上 Pigeon，保证类型安全，手写也少出错
2. 大数据传输用 `BasicMessageChannel` + `BinaryCodec`，避开 StandardMethodCodec 的序列化开销
3. 高频数据流用 EventChannel，别去轮询 MethodChannel
4. 极端性能场景就考虑 FFI 或 Isolate 共享内存
5. 原生端耗时操作一律异步，别堵主线程
6. 批量操作合成一次 Channel 调用，少通信几次

## 参考资源

- [Flutter 官方：开发 Packages 和 Plugins](https://docs.flutter.dev/packages-and-plugins/developing-packages)
- [Pigeon 官方文档](https://pub.dev/packages/pigeon)
- [dart:ffi 官方文档](https://dart.dev/guides/libraries/c-interop)
- [Federated Plugins 设计](https://docs.flutter.dev/packages-and-plugins/developing-packages#federated-plugins)
- [Platform Channel 源码解读](https://github.com/flutter/flutter/tree/master/packages/flutter/lib/src/services)
