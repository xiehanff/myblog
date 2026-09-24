# 26 services 层地图与 ServicesBinding

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/services`（52 文件 30.2k 行）

## 一、问题

`services` 是 framework 里最大的层：52 个文件、30.2k 行，比 `gestures` 大一倍还多。

但它自己内部的分布比 `gestures` 更极端：`keyboard_key.g.dart`（5604 行）和 `keyboard_maps.g.dart`（3204 行）两个**自动生成**的文件就占了 8808 行，接近全层 30%。真正"框架与平台之间那根管子"的实现，加起来不到 2000 行。

于是问题变成：**30.2k 行里，哪一部分是"平台通道机制"，哪一部分只是"某类平台数据的模型"？**

错误直觉是"`services` = 平台通道"，于是从 `platform_channel.dart` 开始读，读完却仍然答不出：**framework 自己用哪些通道？谁在什么时候注册了 handler？为什么我的 App 没设置任何 handler，`WidgetsFlutterBinding` 也已经能收到生命周期回调了？** 因为答案在 `ServicesBinding.initInstances` 里，而不在 `platform_channel.dart` 里。

## 二、最小 Demo

`ServicesBinding` 初始化时会往四条内建通道挂 handler。下面这段代码从外部观察它挂上了什么，以及"平台主动发消息"这条反向路径：

```dart
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  // 1. 任何用到 binding 的代码之前，先把它初始化出来
  final WidgetsBinding binding = WidgetsFlutterBinding.ensureInitialized();

  // 2. defaultBinaryMessenger 是框架发消息 / 收消息的统一出口
  debugPrint('messenger: ${ServicesBinding.instance.defaultBinaryMessenger.runtimeType}');

  // 3. channelBuffers 是"平台 → 框架"的入口（来自 dart:ui）
  debugPrint('buffers: ${ServicesBinding.instance.channelBuffers.runtimeType}');

  // 4. 框架自己用的内建通道都有固定的名字和 codec
  debugPrint('lifecycle -> ${SystemChannels.lifecycle.name} / '
      '${SystemChannels.lifecycle.codec.runtimeType}');
  debugPrint('system    -> ${SystemChannels.system.name} / '
      '${SystemChannels.system.codec.runtimeType}');

  // 5. 反向：手动模拟"平台发了一条生命周期消息给框架"
  //    WidgetsBinding 已经在 initInstances 里注册了 listener，
  //    所以这条消息会走完整的接收链。
  ServicesBinding.instance.channelBuffers.push(
    SystemChannels.lifecycle.name,
    SystemChannels.lifecycle.codec.encodeMessage('AppLifecycleState.resumed'),
    (ByteData? reply) => debugPrint('reply: $reply'),
  );
}
```

第 5 步是这个 Demo 的重点：**框架没有"轮询平台"的机制，平台消息只能从 `channelBuffers` 进来**。这也是写测试时模拟平台消息的官方手段（`ServicesBinding.channelBuffers` 的文档，`services/binding.dart:126-140` 明确推荐了这个用法）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `lib/services.dart:13-62` | 本层对外面，50 个 export |
| `services/binding.dart:45` | `mixin ServicesBinding on BindingBase, SchedulerBinding` |
| `services/binding.dart:47-66` | `initInstances`：四条内建通道 + 键盘 + 许可 + 首帧初始化全在这里 |
| `services/binding.dart:50` | `_defaultBinaryMessenger = createBinaryMessenger();` |
| `services/binding.dart:54-61` | 四条通道的 handler 注册（system / accessibility / lifecycle / platform） |
| `services/binding.dart:93` | `_initKeyboard`：键盘状态同步完成后才挂 `onKeyData` |
| `services/binding.dart:110` | `defaultBinaryMessenger` getter |
| `services/binding.dart:142` | `ui.ChannelBuffers get channelBuffers => ui.channelBuffers;` |
| `services/binding.dart:152` | `createBinaryMessenger()`，默认返回 `_DefaultBinaryMessenger` |
| `services/binding.dart:163` | `handleMemoryPressure`：清 `rootBundle` 缓存 |
| `services/binding.dart:246` | `initServiceExtensions`：注册 `ext.flutter.evict` 等 |
| `services/binding.dart:277` | `evict`：hot reload 时清资源缓存 |
| `services/binding.dart:409` | `_handlePlatformMessage`：处理 `flutter/platform` 上的**入向**方法调用 |
| `services/binding.dart:586` | `initializationComplete`：`SystemChannels.platform.invokeMethod('System.initializationComplete')` |
| `services/binding.dart:611` | `class _DefaultBinaryMessenger extends BinaryMessenger` |
| `services/binding.dart:624` | `_DefaultBinaryMessenger.send`：全框架唯一走到 `sendPlatformMessage` 的地方 |
| `services/binding.dart:653` | `_DefaultBinaryMessenger.setMessageHandler`：转成 `channelBuffers.setListener` |
| `services/binding.dart:615` | `_DefaultBinaryMessenger.handlePlatformMessage`：转成 `channelBuffers.push` |
| `services/binary_messenger.dart:22` | `abstract class BinaryMessenger`，只有 3 个方法 |
| `services/system_channels.dart:181` | `SystemChannels.platform`（`OptionalMethodChannel` + `JSONMethodCodec`） |
| `services/system_channels.dart:370` | `keyEvent`（`BasicMessageChannel<Object?>` + `JSONMessageCodec`） |
| `services/system_channels.dart:385` | `lifecycle`（`BasicMessageChannel<String?>` + `StringCodec`） |
| `services/system_channels.dart:401` | `system`（`BasicMessageChannel<Object?>` + `JSONMessageCodec`） |
| `services/system_channels.dart:413` | `accessibility`（`BasicMessageChannel<Object?>` + `StandardMessageCodec`） |
| `services/system_channels.dart:293` | `textInput`（`OptionalMethodChannel` + `JSONMethodCodec`） |
| `bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:311` | `class ChannelBuffers`（dart:ui 侧，**不在 `packages/flutter` 里**） |
| `bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:319` | `kDefaultBufferSize = 1` |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:804` | `_dispatchPlatformMessage`：引擎 → 框架的落点 |

## 四、调用链

### 4.1 30.2k 行的实际分布

先做一个分区，再决定读什么：

| 分区 | 代表文件 | 行数 | 是否机制 |
|---|---|---|---|
| **通道机制** | `binding` 705、`platform_channel` 741、`message_codecs` 663、`system_channels` 617、`asset_bundle` 418、`message_codec` 215、`binary_messenger` 83 | ≈3442 | 是 |
| 键盘模型 | `keyboard_key.g` 5604、`keyboard_maps.g` 3204、`hardware_keyboard` 1392、`raw_keyboard` 1135 + 5 个平台实现、`text_formatter` 602 | ≈12900 | 数据模型 |
| 文本输入 | `text_input` 3415、`text_editing` 257、`text_editing_delta` 515 | ≈4187 | 独立子系统 |
| PlatformView | `platform_views` 1645 | 1645 | 独立子系统 |
| 其它平台服务 | `restoration` 1018、`mouse_cursor` 926、`autofill` 892、`system_chrome` 799、`live_text`、`spell_check` 等 | ≈6000+ | 单项服务 |
| 二进制桥接 | `lsq`… 无 | — | — |

`services` 里真正的"机制"只有 **通道机制（≈3.4k 行）**。`keyboard_key.g.dart` 之类是"把所有平台的按键码表生成成 Dart 常量"，读它没有任何信息量；`text_input` / `platform_views` / `restoration` 各自是独立子系统，有各自的专题价值但没有共同机制。

所以本层要读的只有 7 个文件：`binding` / `platform_channel` / `message_codec` / `message_codecs` / `binary_messenger` / `system_channels` / `asset_bundle`。其中 `asset_bundle` 是"通道机制的样板用户"（第 28 篇）。

### 4.2 两个文件名的坑

```bash
cd packages/flutter/lib/src/services
ls message_codec*.dart
# message_codec.dart   message_codecs.dart
```

**两个文件同时存在**，而且分工不是"旧 / 新"，是**按内容切开**：

| 文件 | 行数 | 里面有什么 | 导出行 |
|---|---|---|---|
| `message_codec.dart` | 215 | `MessageCodec<T>`、`MethodCodec`、`MethodCall`、`PlatformException`、`MissingPluginException` | `services.dart:31` |
| `message_codecs.dart` | 663 | `BinaryCodec`、`StringCodec`、`JSONMessageCodec`、`JSONMethodCodec`、`StandardMessageCodec`、`StandardMethodCodec` | `services.dart:32` |

两个都被导出，所以从 `package:flutter/services.dart` 看是一个整体；但按路径搜的时候很容易只打开一个。**要读 `StandardMessageCodec` 却打开了 `message_codec.dart`，会以为这个类不存在。**

### 4.3 `ServicesBinding.initInstances`：框架自己用了哪些通道

```dart
// services/binding.dart:47-66（节选）
void initInstances() {
  super.initInstances();
  _instance = this;
  _defaultBinaryMessenger = createBinaryMessenger();
  _restorationManager = createRestorationManager();
  _initKeyboard();
  initLicenses();
  SystemChannels.system.setMessageHandler(                        // :54
    (dynamic message) => handleSystemMessage(message as Object),
  );
  SystemChannels.accessibility.setMessageHandler(                 // :57
    (dynamic message) => _handleAccessibilityMessage(message as Object),
  );
  SystemChannels.lifecycle.setMessageHandler(_handleLifecycleMessage);   // :60
  SystemChannels.platform.setMethodCallHandler(_handlePlatformMessage);  // :61
  platformDispatcher.onViewFocusChange = handleViewFocusChanged;
  TextInput.ensureInitialized();
  readInitialLifecycleStateFromNativeWindow();
  initializationComplete();
}
```

注意这四条通道的**方向不一致**，而且 `initInstances` 里还间接注册了第五条（`TextInput.ensureInitialized()` 给 `flutter/textinput` 挂方法调用 handler）：

| 通道 | 注册方式 | 方向 | 谁先说 |
|---|---|---|---|
| `flutter/system` | `BasicMessageChannel.setMessageHandler` | 平台 → 框架（框架从不主动 `send`） | 平台 |
| `flutter/accessibility` | `BasicMessageChannel.setMessageHandler` | 平台 → 框架为主（出向仅 `SemanticsService` 的 `send`） | 平台 |
| `flutter/lifecycle` | `BasicMessageChannel.setMessageHandler` | 平台 → 框架 | 平台 |
| `flutter/platform` | `MethodChannel.setMethodCallHandler` | **双向**：框架可以调 `System.initializationComplete`，平台也可以调 `SystemChrome.systemUIChange` 等 | 双向 |
| `flutter/textinput` | `MethodChannel.setMethodCallHandler`（`services/text_input.dart:1969`） | **双向**：框架调 `TextInput.setClient` / `TextInput.show`，平台调 `TextInputClient.updateEditingState` 等 | 双向 |

双向的内建通道**不止 `SystemChannels.platform` 一条**。`flutter/platform` 双向是因为既有"框架调平台"的需求（`SystemChrome`、`Clipboard`、`SystemNavigator`），也有"平台调框架"的需求（`SystemChrome.systemUIChange`、`System.requestAppExit`、`ContextMenu.*`）——`_handlePlatformMessage`（`services/binding.dart:409`）就是它的入向处理，`switch` 里能看到全部四种入向方法名。`flutter/textinput` 是另一条典型的双向通道：框架大量 `invokeMethod`（`TextInput.setClient` / `TextInput.show` 等，`services/text_input.dart:2645` 起），平台也主动调框架（`TextInputClient.updateEditingState` / `TextInputClient.performAction` 等），入向 handler 在 `text_input.dart:1969` 注册。此外 `flutter/navigation`（框架 `SystemNavigator.pop` ↔ 平台 `pushRoute` / `popRoute`，`widgets/binding.dart:479`）、`flutter/restoration`、`flutter/platform_views` 同样是"有出向调用 + 有入向 handler"的双向通道；真正只收不发的内建通道是 `flutter/system` / `flutter/lifecycle` / `flutter/keyevent` 这几个只有 `setMessageHandler` 的。

### 4.4 出向：`send` 这一段

`_DefaultBinaryMessenger.send` 是整个 framework **唯一**触碰 `PlatformDispatcher.sendPlatformMessage` 的地方：

```dart
// services/binding.dart:623-641（节选）
@override
Future<ByteData?> send(String channel, ByteData? message) {
  final completer = Completer<ByteData?>();
  ui.PlatformDispatcher.instance.sendPlatformMessage(channel, message, (ByteData? reply) {
    try {
      completer.complete(reply);
    } catch (exception, stack) { /* 上报 */ }
  });
  return completer.future;
}
```

这里有一个值得记住的细节：**它直接用 `ui.PlatformDispatcher.instance`，不走 `ServicesBinding.instance.platformDispatcher`**。源码里的注释解释了原因（`services/binding.dart:626-631`）：这个方法可能在**任何 binding 初始化之前**就被调用，如果经过 `ServicesBinding.instance` 会抛异常。

再往外一层是 dart:ui 的声明：

```dart
// bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:657-679（节选）
void sendPlatformMessage(String name, ByteData? data, PlatformMessageResponseCallback? callback) {
  final String? error = _sendPlatformMessage(
    name,
    _zonedPlatformMessageResponseCallback(callback),
    data,
  );
  if (error != null) {
    throw Exception(error);
  }
}

@Native<Handle Function(Handle, Handle, Handle)>(
  symbol: 'PlatformConfigurationNativeApi::SendPlatformMessage',
)
external static String? __sendPlatformMessage(
  String name,
  PlatformMessageResponseCallback? callback,
  ByteData? data,
);
```

**这里就是边界。** `__sendPlatformMessage` 是一个 `external` 声明，带 `@Native` 标注，`symbol` 指向引擎的 `PlatformConfigurationNativeApi::SendPlatformMessage`。它的实现是引擎里的 C++，**SDK 缓存里只到这一行为止**，再往下没有可读的 Dart 源码。（`bin/cache/pkg/sky_engine/lib/ui/` 是 dart:ui 的 **Dart 侧接口**，随 SDK 缓存一起分发；引擎的 C++ 实现不在其中。）

还有一个常被忽略的细节：`_zonedPlatformMessageResponseCallback`（`platform_dispatcher.dart:784-800`）会把回调包一层 `Zone.current.runUnaryGuarded`。所以**回复回调的执行 Zone 是"调用 `send` 时的 Zone"**，不是"回复到达时的 Zone"。这在自定义 Zone（例如 `runZonedGuarded` 包住的业务代码）里很关键。

### 4.5 入向：`channelBuffers` 是怎么被喂满的

平台的入向消息由引擎调用 dart:ui 的 `_dispatchPlatformMessage`：

```dart
// bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:804-826（节选）
void _dispatchPlatformMessage(String name, ByteData? data, int responseId) {
  if (name == ChannelBuffers.kControlChannelName) {
    try {
      channelBuffers.handleMessage(data!);
    } finally {
      _respondToPlatformMessage(responseId, null);
    }
  } else if (onPlatformMessage != null) {
    _invoke3<String, ByteData?, PlatformMessageResponseCallback>(
      onPlatformMessage, _onPlatformMessageZone, name, data,
      (ByteData? responseData) {
        _respondToPlatformMessage(responseId, responseData);
      },
    );
  } else {
    channelBuffers.push(name, data, (ByteData? responseData) {
      _respondToPlatformMessage(responseId, responseData);
    });
  }
}
```

正常情况下走第三条分支：**消息被 push 进 `channelBuffers`**，回复通过 `_respondToPlatformMessage` 送回引擎。第二条分支是给已废弃的 `PlatformDispatcher.onPlatformMessage` 留的兼容路径（该 API 在 `platform_dispatcher.dart:766-767` 标了废弃）。

然后 `channelBuffers.push` 在**有 listener 时立即调用 listener**：

```dart
// bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:411-427（节选，_Channel.push）
bool push(_StoredMessage message) {
  if (!_draining && _channelCallbackRecord != null) {
    assert(_queue.isEmpty);
    _channelCallbackRecord!.invoke(message.data, message.invoke);   // 立即
    return false;
  }
  if (_capacity <= 0) {
    return debugEnableDiscardWarnings;
  }
  final bool result = _dropOverflowMessages(_capacity - 1);
  _queue.addLast(message);
  return result;
}
```

listener 是谁注册的？就是 `ServicesBinding` 的 `setMessageHandler`：

```dart
// services/binding.dart:652-678（节选）
@override
void setMessageHandler(String channel, MessageHandler? handler) {
  if (handler == null) {
    ui.channelBuffers.clearListener(channel);
  } else {
    ui.channelBuffers.setListener(channel, (
      ByteData? data,
      ui.PlatformMessageResponseCallback callback,
    ) async {
      ByteData? response;
      try {
        response = await handler(data);
      } catch (exception, stack) { /* 上报 */ }
      finally {
        callback(response);
      }
    });
  }
}
```

这条链把三样东西串起来了——`MethodChannel.setMethodCallHandler` / `BasicMessageChannel.setMessageHandler` 最终都落到 `channelBuffers.setListener`；`channelBuffers.push` 是消息的唯一入口；`callback(response)` 把回复送回引擎。**框架侧没有"消息队列轮询"，也没有第二个入口。**

### 4.6 `kDefaultBufferSize = 1` 与 `sendChannelUpdate`

`ChannelBuffers` 里有两个容易被忽略的数字 / 调用：

```dart
// bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:319
static const int kDefaultBufferSize = 1;
```

**没有 listener 的通道默认只能缓冲 1 条消息**，第 2 条会走 `_dropOverflowMessages`（`channel_buffers.dart:160`），把旧消息丢掉并给它的 callback 传 `null`，同时在 debug 下打印一段警告（`ChannelBuffers.push` 里的 `_printDebug`，`channel_buffers.dart:341-360`）。这就是"插件在框架还没注册 listener 之前发消息会丢"的机制来源，也是官方建议"注册 handler 要早"的原因。

另一个是 `setListener` / `clearListener` 里的 `sendChannelUpdate`：

```dart
// bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:380-397（节选）
void setListener(String name, ChannelCallback callback) {
  final _Channel channel = _channels.putIfAbsent(name, () => _Channel());
  channel.setListener(callback);
  sendChannelUpdate(name, listening: true);      // 通知引擎
}

void clearListener(String name) {
  final _Channel? channel = _channels[name];
  if (channel != null) {
    channel.clearListener();
    sendChannelUpdate(name, listening: false);
  }
}
```

`sendChannelUpdate` 最终调到 `@Native ... PlatformConfigurationNativeApi::SendChannelUpdate`（`channel_buffers.dart:401-403`）。**框架每次 `setMessageHandler` 都会向引擎报告"这个通道我现在有人在听了"**，引擎据此决定是否把该通道的消息转发过来。所以 `MethodChannel.setMethodCallHandler(null)` 不只是"本地取消注册"，也会通知引擎停止转发。

## 五、核心对象：三个层次的分工

| | `BinaryMessenger` | `ChannelBuffers` | `MethodChannel` / `BasicMessageChannel` |
|---|---|---|---|
| 声明位置 | `services/binary_messenger.dart:22` | dart:ui（`channel_buffers.dart:311`） | `services/platform_channel.dart:292` / `202` |
| 抽象层级 | 二进制：`ByteData` 进 `ByteData` 出 | 二进制 + 缓冲 + 通道订阅状态 | 语义：方法调用 / 类型化消息 |
| 方法数 | **3**（`send` / `setMessageHandler` / `handlePlatformMessage`） | `push` / `setListener` / `clearListener` 等 | 各 3～5 个 |
| 谁实现 | `_DefaultBinaryMessenger`（框架）+ `TestDefaultBinaryMessenger`（测试）+ `BackgroundIsolateBinaryMessenger`（后台 isolate） | dart:ui 提供，框架不实现 | 框架提供，业务直接用 |
| 是否认识 codec | 不认识 | 不认识 | **认识**（持有一个 `MethodCodec` / `MessageCodec`） |
| 方向 | 出向 `send` / 入向 `setMessageHandler` | 入向 `push` / 出向由 `_dispatchPlatformMessage` 处理 | 双向 |

**`BinaryMessenger` 只有 3 个方法，这是本层最值得记住的数字**（`binary_messenger.dart:22-83`，整个文件 83 行）。它刻意不认识"方法调用"、"参数"、"返回值"这些概念，只搬字节。`MethodChannel` 那一层的存在意义就是给字节加上"方法名 / 参数 / 成功信封 / 错误信封"的结构，第 27 篇展开。

再看三个 `BinaryMessenger` 实现的差别：

| 实现 | 何时用 | 关键差异 |
|---|---|---|
| `_DefaultBinaryMessenger` | 主 isolate 默认 | `send` 走 `ui.PlatformDispatcher.instance.sendPlatformMessage` |
| `TestDefaultBinaryMessenger` | `flutter_test` | 额外维护 `_inboundHandlers` / `_outboundHandlers` 两张表，可 mock 双向消息 |
| `BackgroundIsolateBinaryMessenger` | 后台 isolate | 通过 `RootIsolateToken` 换到根 isolate 的 messenger；`platform_channel.dart:11` 附近的条件导入做平台分叉 |

`MethodChannel` 的 `binaryMessenger` getter（`platform_channel.dart:318-331`，`_findBinaryMessenger` 定义在 `:175`）在**没有显式传入 messenger 时**会调 `_findBinaryMessenger()`，它在不同上下文里返回上面三个之一。所以"同一个 `MethodChannel` 在 isolate 里行为不同"不是 bug，是这层的刻意设计。

## 六、源码实验

### 实验 1：本层的分量分布与"生成文件"

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src
wc -l services/*.dart | sort -rn | head -12
ls services/*.g.dart
```

**实际**：总计 30150 行。前两名是 `keyboard_key.g.dart`（5604）与 `keyboard_maps.g.dart`（3204），两个都是生成文件，合计 8808 行，占 29%。第 3～7 名是 `text_input` 3415、`platform_views` 1645、`hardware_keyboard` 1392、`raw_keyboard` 1135、`restoration` 1018。

**说明**：**看到 `.g.dart` 一律跳过。** 剩下 21.3k 行里还有 text_input（3415）+ platform_views（1645）+ 5 个 `raw_keyboard_*` 平台实现（≈2100）是"平台数据的模型层"，最后真正是通道机制的约 3.4k 行。

### 实验 2：导出面比文件数少 2，差额是条件导入

```bash
cd packages/flutter/lib
grep -c '^export' services.dart          # 50
ls src/services/*.dart | wc -l           # 52
grep -rn "if (dart.library" src/services/*.dart
```

**实际**：50 个 export 对 52 个文件；条件导入命中 `platform_channel.dart:11` 和 `:20`，两个分支指向 `_background_isolate_binary_messenger_web.dart` 与 `_background_isolate_binary_messenger_io.dart`。

**说明**：差额正好是这两个下划线文件——和 `foundation` 里"门面 / 实现"的配对模式完全一样（见第一篇 4.2）。**判断一个文件是否属于公开 API，看 `services.dart` 有没有它，不要看它在不在 `src` 下。**

### 实验 3：内建通道的名字与 codec

**改什么**：遍历 `SystemChannels` 的几个常量，打印它们的运行时类型和 codec。

**预测**：既然 `flutter/platform` 处理的是方法调用，它应该用 `StandardMethodCodec`（框架的默认选择）。

**实际**（输出）：

```text
flutter/platform      -> JSONMethodCodec         (OptionalMethodChannel)
flutter/lifecycle     -> StringCodec             (BasicMessageChannel<String?>)
flutter/system        -> JSONMessageCodec        (BasicMessageChannel<Object?>)
flutter/accessibility -> StandardMessageCodec    (BasicMessageChannel<Object?>)
flutter/keyevent      -> JSONMessageCodec        (BasicMessageChannel<Object?>)
flutter/textinput     -> JSONMethodCodec         (OptionalMethodChannel)
flutter/navigation    -> JSONMethodCodec         (OptionalMethodChannel)
```

**说明**：预测错了。**`flutter/platform` 用的是 `JSONMethodCodec` 而不是 `StandardMethodCodec`**（`system_channels.dart:181-184`）。原因是这条通道要和引擎的内建实现（C++/Kotlin/Swift 侧）对齐，而引擎内建通道历史上统一用 JSON；`StandardMethodCodec` 是给**插件**用的。看到 `obscured` 类型差异、`int` / `double` 在 JSON 里变成同一个 `num` 之类的现象，根因就在这里。

同时可见 `OptionalMethodChannel extends MethodChannel`（所以 `SystemChannels.platform is MethodChannel` 为 true），它的唯一差别是"平台没有实现时返回 null 而不抛 `MissingPluginException`"（`platform_channel.dart:627-635`）。

### 实验 4：`channelBuffers.push` 的接收链

**改什么**：给一个自定义通道注册 handler，然后直接用 `ui.channelBuffers.push` 投递一条编码过的 `MethodCall`，并在 push 之后立刻、以及 pump 一帧之后各打印一次结果。

**预测**：`push` 之后 handler 应该已经被调用了（`_Channel.push` 在有 listener 时是同步 invoke）。

**实际**（输出）：

```text
push 之后同步: received=[] reply=null
pump 之后:     received=[{n: 7}] reply=pong
```

**说明**：预测错了。原因不在 `ChannelBuffers`，而在 **listener 回调本身是 `async` 的**（`services/binding.dart:657-676` 那一段）：它 `await handler(data)`，而 `handler` 又是 `MethodChannel._handleAsMethodCall`（`platform_channel.dart:601`），里面还有一次 `await`。所以在 `flutter_test` 的 `FakeAsync` 里，这些微任务要 `pump()` 才推进。**"push 是同步进入回调"和"handler 的返回值何时可用"是两件事**，判断后者要看 handler 自己是不是 async。

### 实验 5：`ServicesBinding.handlePlatformMessage` 已经不存在

```bash
cd packages/flutter/lib/src
grep -rn "handlePlatformMessage" services/
```

**实际**：只有 3 处命中：

```text
services/binary_messenger.dart:59   （抽象类上的 @Deprecated 方法）
services/binding.dart:615           （_DefaultBinaryMessenger 的 @override）
services/binding.dart:620           （注释里的说明文字）
```

**说明**：`ServicesBinding.handlePlatformMessage` **在 3.44.8 已经不存在**。老资料里常见的"`ServicesBinding.handlePlatformMessage` 用于模拟平台消息"是过时描述：现在 `ServicesBinding` 上只有 `channelBuffers`（getter），而 `handlePlatformMessage` 是 `BinaryMessenger` 接口上的一个已废弃方法，其默认实现（`services/binding.dart:611-622`）只是 `ui.channelBuffers.push(channel, message, callback)`——**它已经从"接收路径"退化成了 `push` 的语法糖**。写测试时应该用 `channelBuffers.push` 或 `TestDefaultBinaryMessenger.handlePlatformMessage`，源码注释（`binary_messenger.dart:53-58`）也是这么推荐的。

## 七、结论

1. `services` 的 30.2k 行里，**通道机制只有约 3.4k 行（7 个文件）**；8808 行是两个 `.g.dart` 生成文件，其余的 `text_input` / `platform_views` / `restoration` / 键盘模型各自是独立子系统，没有共同机制。
2. `ServicesBinding.initInstances`（`services/binding.dart:47-66`）负责注册 `flutter/system`、`flutter/accessibility`、`flutter/lifecycle`、`flutter/platform`，并通过 `TextInput.ensureInitialized()` 接入 `flutter/textinput`；这是 services binding 的初始化清单，不是整个 framework 的内建通道总表。`system` / `lifecycle` 只收不发，`accessibility` 主要接收平台消息，`platform` 与 `textinput` 双向；`navigation`、`restoration`、`platform_views` 等通道还在各自子系统注册。**这里建立的 handler 会在应用代码运行前注册好**。
3. 出向与入向各只有一条路径：出向是 `_DefaultBinaryMessenger.send` → `ui.PlatformDispatcher.instance.sendPlatformMessage` → `__sendPlatformMessage`（`@Native`，**边界**）；入向是引擎 `_dispatchPlatformMessage` → `channelBuffers.push` → `setListener` 注册的回调。`BinaryMessenger` 只有 3 个方法，是本层最稳定的契约。

**`services` 里只有七个文件是"管子"，管子的一端是 `BinaryMessenger` 的三个方法，另一端是引擎的 `@Native` 声明。**

## 八、边界声明

- 本文只到"通道机制"这一层。`MethodChannel.invokeMethod` 具体穿过哪几层、codec 怎么编解码，见第 27 篇；`AssetBundle` 与 `SystemChannels` 作为通道的用户，见第 28 篇。
- `text_input.dart`（3415 行）是独立的文本输入子系统（IME 交互、`TextInputClient` 协议），有单独专题价值，这个系列不展开；本文只做分层定位。
- `platform_views.dart`、`restoration.dart`、`autofill.dart`、`system_chrome.dart`、`mouse_cursor.dart` 等单项服务不展开。
- `raw_keyboard_*.dart` 五个平台实现与 `hardware_keyboard.dart` 的键盘状态机不在这个系列展开。
- `.g.dart` 生成文件的生成方式（`flutter tool` 的 `gen_keycodes`）不展开。
- `BackgroundIsolateBinaryMessenger` 与后台 isolate 的消息路由只标出位置，不展开。
