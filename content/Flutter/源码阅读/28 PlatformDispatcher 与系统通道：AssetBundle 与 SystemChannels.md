# 28 PlatformDispatcher 与系统通道：AssetBundle 与 SystemChannels

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `services/asset_bundle.dart`（418 行）、`services/system_channels.dart`（617 行）、`bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart`、`bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart`

## 一、问题

`SystemChannels` 里定义了 20 多个通道常量，名字都是 `flutter/xxx`。这些通道是给谁用的？

错误直觉是"`SystemChannels` 是给业务代码用的，我想发平台消息就从这里找个通道"，或者反过来"这些通道太底层了，框架内部才用得到"。

两种都不准。真实情况是：**`SystemChannels` 里的通道分两类，用法完全不同**。

- 第一类是**引擎内建通道**（`flutter/platform`、`flutter/lifecycle`、`flutter/system`、`flutter/accessibility`、`flutter/keyevent`、`flutter/textinput` …）：这些是引擎侧已经实现了对应 handler 的通道，框架用它们驱动系统行为（剪贴板、震动、状态栏、生命周期）。`ServicesBinding.initInstances` 会给其中四条挂 handler（第 26 篇 4.3）。
- 第二类是**约定通道**（`flutter/assets`、`flutter/navigation`、`flutter/menu`、`flutter/deferredcomponent` …）：这些没有统一的引擎实现，而是"框架和某个具体组件之间的约定"。

而且最有教学价值的一条链是：**`rootBundle.load()` 走的就是一个平台通道**（`flutter/assets`）。它是"通道机制"最简单、最容易被忽略的用户，也是理解"为什么读一个本地文件也是异步的"的答案。

## 二、最小 Demo

```dart
import 'dart:typed_data';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 1. rootBundle 是一个 AssetBundle 实例，它背后是一个平台通道
  try {
    final ByteData data = await rootBundle.load('assets/config.json');
    debugPrint('loaded ${data.lengthInBytes} bytes');
  } on FlutterError catch (e) {
    debugPrint('asset 不存在: ${e.message}');
  }

  // 2. 用 SystemChannels.navigation 驱动系统级行为（引擎侧已实现）
  await SystemNavigator.pop();
}
```

外层看起来只是"读个资源"，但第 1 步内部会把 key 编码后通过 `flutter/assets` 通道发给引擎——**这正是第 27 篇那条四层链的另一个入口**。

再看"平台 → 框架"这一侧的最小操作：

```dart
// 3. 手动投递一条生命周期消息（等价于引擎侧发来了一条）
ServicesBinding.instance.channelBuffers.push(
  SystemChannels.lifecycle.name,
  SystemChannels.lifecycle.codec.encodeMessage('AppLifecycleState.paused'),
  (ByteData? reply) => debugPrint('reply: $reply'),
);
```

这段代码在 `flutter_test` 里就是"模拟系统把 App 切到后台"的标准做法（`ServicesBinding.channelBuffers` 的文档，`services/binding.dart:126-140` 明确推荐）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `services/asset_bundle.dart:57` | `abstract class AssetBundle`，四个方法 |
| `services/asset_bundle.dart:67` | `load(String key)`：唯一的抽象方法 |
| `services/asset_bundle.dart:91` | `loadString`：`load` + UTF-8 解码，解码放在 `compute` 里 |
| `services/asset_bundle.dart:103` | `_utf8decode`：真正的解码函数 |
| `services/asset_bundle.dart:133` | `evict(String key)`：基类是**空实现** |
| `services/asset_bundle.dart:146` | `class NetworkAssetBundle`：用 `dart:io` 的 HTTP，**不走通道** |
| `services/asset_bundle.dart:185` | `abstract class CachingAssetBundle`：三张缓存表（字符串 / 结构化数据 / 结构化二进制） |
| `services/asset_bundle.dart:191` | `loadString` 覆写：`_stringCache.putIfAbsent` |
| `services/asset_bundle.dart:303` | `CachingAssetBundle.evict`：清三张表 |
| `services/asset_bundle.dart:324` | `class PlatformAssetBundle extends CachingAssetBundle` |
| `services/asset_bundle.dart:326` | `load`：key 先做 URI 编码，再走 `flutter/assets` 通道 |
| `services/asset_bundle.dart:349` | `loadBuffer`：非 Web 分支会用 `dart:io` 直接读文件（**绕过通道**） |
| `services/asset_bundle.dart:381` | `_initRootBundle()`：返回 `PlatformAssetBundle()` |
| `services/asset_bundle.dart:418` | `final AssetBundle rootBundle = _initRootBundle();` |
| `services/system_channels.dart:76` | `navigation`：`OptionalMethodChannel` + 默认 `StandardMethodCodec` |
| `services/system_channels.dart:181` | `platform`：`OptionalMethodChannel('flutter/platform', JSONMethodCodec())` |
| `services/system_channels.dart:293` | `textInput`：引擎内建，JSON codec |
| `services/system_channels.dart:370` | `keyEvent`：`BasicMessageChannel<Object?>` + `JSONMessageCodec` |
| `services/system_channels.dart:385` | `lifecycle`：`BasicMessageChannel<String?>` + `StringCodec` |
| `services/system_channels.dart:401` | `system`：`BasicMessageChannel<Object?>` + `JSONMessageCodec` |
| `services/system_channels.dart:413` | `accessibility`：`BasicMessageChannel<Object?>` + `StandardMessageCodec` |
| `services/system_channels.dart:423` | `platform_views`：普通 `MethodChannel`（不是 Optional） |
| `services/system_channels.dart:478` | `restoration`：`OptionalMethodChannel` |
| `services/binding.dart:61` | `SystemChannels.platform.setMethodCallHandler(_handlePlatformMessage)` |
| `services/binding.dart:586` | `initializationComplete`：框架启动完成的信号 |
| `services/clipboard.dart:36` | `Clipboard.setData` 走 `SystemChannels.platform.invokeMethod` |
| `services/system_navigator.dart:81` | `SystemNavigator` 走 `SystemChannels.navigation` |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:657` | `sendPlatformMessage`（Dart 侧声明） |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:677` | `__sendPlatformMessage`：`@Native`，**边界** |
| `bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:804` | `_dispatchPlatformMessage`：引擎 → 框架的入口 |
| `bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:341` | `ChannelBuffers.push` |
| `bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:380` | `ChannelBuffers.setListener` |
| `bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:319` | `kDefaultBufferSize = 1` |

## 四、调用链

### 4.1 `rootBundle` 是什么

```dart
// asset_bundle.dart:381-383
AssetBundle _initRootBundle() {
  return PlatformAssetBundle();
}

// asset_bundle.dart:418
final AssetBundle rootBundle = _initRootBundle();
```

**关键认知**：`rootBundle` 是一个**顶层 `final` 变量**，不是单例 getter。它在库加载时就被初始化成 `PlatformAssetBundle()`——**也就是说它的存在不依赖任何 binding**。这解释了为什么 `rootBundle` 可以在 `WidgetsFlutterBinding.ensureInitialized()` 之前就被引用，但**真正调用 `load` 时**必须已经有 binding（因为它内部要用 `ServicesBinding.instance.defaultBinaryMessenger`，见下）。

### 4.2 `AssetBundle` 的三个实现，只有一个是通道

| | `AssetBundle`（抽象） | `NetworkAssetBundle` | `CachingAssetBundle`（抽象） | `PlatformAssetBundle` |
|---|---|---|---|---|
| 声明位置 | `:57` | `:146` | `:185` | `:324` |
| `load` 的实现 | 抽象 | HTTP GET（`dart:io`） | 抽象 | **`defaultBinaryMessenger.send('flutter/assets', ...)`** |
| 是否走平台通道 | — | **否** | — | **是** |
| 缓存什么 | — | 不缓存 | 字符串 + 结构化数据 + 结构化二进制 | 同左 |
| `evict` | 空实现（`:133`） | 不覆写（有 TODO，`:171`） | 清三张表（`:303`） | 同左 |
| `loadBuffer` | `load` + `ImmutableBuffer.fromUint8List` | 继承 | 继承 | **非 Web 走 `dart:io` 直接读文件**（`:349`） |

**关键认知**：**`AssetBundle` 只有 `load` 一个抽象方法**（`:67`），其余都是有默认实现的具体方法。所以自定义 `AssetBundle` 的最小代价就是实现一个 `load`——`NetworkAssetBundle` 和 `PlatformAssetBundle` 都只做了这件事。

另一个值得记住的点：`loadBuffer`（`:73`）在非 Web 平台会**绕过通道**，用 `dart:io` 直接读应用包里的文件，只在 Web 上回退到 `load`（`asset_bundle.dart:349-355`）。这是"通道不是唯一的数据来源"的例子——**性能敏感的路径上框架会选择直接读文件**。

### 4.3 `flutter/assets` 的请求编码

`PlatformAssetBundle.load` 一共 20 行，但有两处细节：

```dart
// asset_bundle.dart:326-336（节选）
Future<ByteData> load(String key) {
  final Uint8List encoded = utf8.encode(Uri(path: Uri.encodeFull(key)).path);   // ① 编码 key
  final Future<ByteData>? future = ServicesBinding.instance.defaultBinaryMessenger
      .send('flutter/assets', ByteData.sublistView(encoded))                    // ② 走通道
      ?.then((ByteData? asset) { ... });
  if (future == null) { ... }                                                   // ③ send 可能返回 null Future
  return future;
}
```

① 的 `Uri(path: Uri.encodeFull(key)).path` 值得单独记：它不是 `utf8.encode(key)`，而是**先把 key 当成 URI 路径做百分号编码，再取 `.path`，最后才 UTF-8 编码**。第 6 节实验 1 会看到实际效果：`'assets/demo .txt'` 里的空格变成了 `%20`。**key 里的空格、中文、`#` 等字符会先被转义再发出去。**

② 的载荷是**裸 UTF-8 字节**，不是 `StandardMessageCodec` 编码的结构——因为通道的另一端（引擎）只期望一个路径字符串。

③ 的 `?.then(...)` 是处理 `send` 返回**可空 Future**（`ByteData?` 的 Future 本身可能为 null）的写法，第 27 篇 5.3 已说明这个签名差异。

### 4.4 `SystemChannels` 的两类通道

```bash
cd packages/flutter/lib/src/services
grep -n "static const" system_channels.dart
```

把 20 多个常量按类型分组，会得到一张很清晰的表：

| 类别 | 通道 | 具体类型 | codec | 谁用 |
|---|---|---|---|---|
| **引擎内建，双向** | `platform` | `OptionalMethodChannel` | `JSONMethodCodec` | `Clipboard` / `HapticFeedback` / `SystemChrome` / `SystemNavigator` / `ServicesBinding` |
| 引擎内建，入向 | `lifecycle` | `BasicMessageChannel<String?>` | `StringCodec` | `WidgetsBindingObserver.didChangeAppLifecycleState` |
| 引擎内建，入向 | `system` | `BasicMessageChannel<Object?>` | `JSONMessageCodec` | `handleSystemMessage`（内存压力等） |
| 引擎内建，入向 | `accessibility` | `BasicMessageChannel<Object?>` | `StandardMessageCodec` | `SemanticsEvent` 上报 |
| 引擎内建，入向 | `keyEvent` | `BasicMessageChannel<Object?>` | `JSONMessageCodec` | `HardwareKeyboard` |
| 引擎内建，双向 | `textInput` | `OptionalMethodChannel` | `JSONMethodCodec` | `TextInput` |
| 引擎内建，双向 | `platform_views` / `platform_views_2` | `MethodChannel`（**非 Optional**） | 默认 `StandardMethodCodec` | `PlatformViewsService` |
| 约定通道 | `assets`（**不在 `SystemChannels` 里**） | 由 `PlatformAssetBundle` 硬编码字符串 | **无 codec** | `AssetBundle` |
| 约定通道 | `navigation` | `OptionalMethodChannel` | 默认 `StandardMethodCodec` | `SystemNavigator` |
| 约定通道 | `restoration` / `deferredComponent` / `localization` | `OptionalMethodChannel` | 默认或显式 | 各子系统 |
| 约定通道 | `menu` / `contextMenu` / `sensitiveContent` / `spellCheck` / `scribe` / `processText` / `backGesture` / `mouseCursor` | `OptionalMethodChannel`，部分带显式 codec | 默认 / `JSONMethodCodec` | 各子系统 |

三点值得单独指出：

1. **`flutter/assets` 不在 `SystemChannels` 里**。它是 `PlatformAssetBundle.load` 里的一个**硬编码字符串**（`asset_bundle.dart:329`）。所以想"从 `SystemChannels` 里找到 assets 通道"是找不到的——这是本章最容易踩的一个坑。
2. **`platform_views` 用的是普通 `MethodChannel` 而不是 `OptionalMethodChannel`**（`system_channels.dart:423`）。语义上是对的：PlatformView 在支持的平台上必须有实现，不支持时应该明确报错。
3. **`platform` 用 `JSONMethodCodec` 而不是默认的 `StandardMethodCodec`**（第 26 篇实验 3 有实测）。`navigation` / `restoration` 等则用默认值（`StandardMethodCodec`）。所以 `SystemChannels` 里**两种 codec 混用**，跨通道传递数据时不能想当然。

### 4.5 出向的终点：`PlatformDispatcher.sendPlatformMessage`

`_DefaultBinaryMessenger.send`（`services/binding.dart:624`）之后，链路进入 dart:ui：

```dart
// bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:657-679（节选）
void sendPlatformMessage(String name, ByteData? data, PlatformMessageResponseCallback? callback) {
  final String? error = _sendPlatformMessage(
    name,
    _zonedPlatformMessageResponseCallback(callback),
    data,
  );
  if (error != null) {
    throw Exception(error);        // 同步错误：通道名不合法（如含 U+0000）等
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

注意 `sendPlatformMessage` 的返回值是 `void`，但内部把 `_sendPlatformMessage` 返回的 `String?` 错误**同步抛成异常**。也就是说，**有些错误在 `await` 之前就会以同步异常的形式抛出**——这意味着 `try { await channel.invokeMethod(...) } catch` 里的 `catch` 能捕获它，但**如果调用方在 `send` 之前就把 Future 存起来了而不 await，异常会变成一个未处理的同步异常**。

**关键认知**：`__sendPlatformMessage` 就是本篇的边界。它带 `@Native` 注解，`symbol` 指向引擎的 `PlatformConfigurationNativeApi::SendPlatformMessage`。**本地 SDK 只到这一行；它的实现是引擎里的 C++（`flutter/engine` 仓库），不在本地。** `bin/cache/pkg/sky_engine/lib/ui/` 只是 dart:ui 的 **Dart 侧接口**，随 SDK 缓存分发。

### 4.6 入向：引擎如何把消息交进来

`_dispatchPlatformMessage` 有三个分支，正常路径是第三个：

```dart
// bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:804-826（节选）
void _dispatchPlatformMessage(String name, ByteData? data, int responseId) {
  if (name == ChannelBuffers.kControlChannelName) {
    try {
      channelBuffers.handleMessage(data!);          // 控制通道：直接处理
    } finally {
      _respondToPlatformMessage(responseId, null);
    }
  } else if (onPlatformMessage != null) {
    ...                                             // 已废弃的兼容路径
  } else {
    channelBuffers.push(name, data, (ByteData? responseData) {
      _respondToPlatformMessage(responseId, responseData);   // 回复走专用 API
    });
  }
}
```

**关键认知**：**回复不走大通道**。请求从 `channelBuffers.push` 进来，而回复通过 `_respondToPlatformMessage(responseId, data)` 出去（`platform_dispatcher.dart:773-780`，最终是 `@Native ... RespondToPlatformMessage`）。所以"平台 → 框架"的往返有两条不同的路径：**请求走 `ChannelBuffers`，回复走 `responseId`**。`responseId` 是引擎分配的一个整数，用来把回复和请求对上。

`ChannelBuffers.push` 在有 listener 时把消息交给 `_Channel.push`，后者立即调用 listener（`channel_buffers.dart:341-360` → `:133-141`），而 listener 是 `_DefaultBinaryMessenger.setMessageHandler` 注册的（`services/binding.dart:653-676`）：

```dart
// bin/cache/pkg/sky_engine/lib/ui/channel_buffers.dart:380-397（节选）
void setListener(String name, ChannelCallback callback) {
  final _Channel channel = _channels.putIfAbsent(name, () => _Channel());
  channel.setListener(callback);
  sendChannelUpdate(name, listening: true);        // 通知引擎"我在听了"
}

void clearListener(String name) {
  final _Channel? channel = _channels[name];
  if (channel != null) {
    channel.clearListener();
    sendChannelUpdate(name, listening: false);
  }
}
```

**`sendChannelUpdate` 是这条链里最容易被忽略的一环**：框架每次 `setMessageHandler` / `setMethodCallHandler` 都会向引擎报告订阅状态，引擎据此决定是否转发该通道的消息。所以 `setMethodCallHandler(null)` 不只是本地取消注册，还会让引擎停止转发——**"先注册 handler 再让原生发消息"这个顺序要求在源码层是有强约束的**，不是习惯问题。

## 五、核心对象：两组的对比

**第一组：`AssetBundle` 家族。**

| | 抽象基类 `AssetBundle` | `CachingAssetBundle` | `PlatformAssetBundle` |
|---|---|---|---|
| 抽象方法 | `load` | 继承了 `load` 的抽象 | 实现 `load` |
| 缓存 | 无 | 字符串 / 结构化数据 / 结构化二进制（3 张表） | 继承 |
| 通道 | 不涉及 | — | 用 `flutter/assets` |
| `evict` | 空实现 | 清 3 张表 | 继承 |
| 二进制资源是否缓存 | — | **否**（文档明确说明，`:184`） | 同左 |

"二进制资源不缓存"这一条很重要：`rootBundle.load('a.png')` 每次调用都会**真的走一次通道**，只有 `loadString` / `loadStructuredData` 才命中缓存。要看图/资源是否重复加载，不能指望 `rootBundle` 的缓存。

**第二组：三种通道类型的分工。**

| | `MethodChannel` | `OptionalMethodChannel` | `BasicMessageChannel<T>` |
|---|---|---|---|
| 抽象的东西 | 方法调用（有 `method` 名） | 同左 | 裸消息 |
| 平台未实现时 | 抛 `MissingPluginException` | **返回 null** | 返回 null（无此概念） |
| `SystemChannels` 里的例子 | `platform_views` | `platform` / `navigation` / `restoration` … | `lifecycle` / `system` / `accessibility` / `keyEvent` |
| 泛型 | 无（`invokeMethod<T>` 在方法上） | 无 | **有**（类上） |

`SystemChannels.keyEvent` 是 `BasicMessageChannel<Object?>`：**原始按键数据（JSON Map）直接过通道**，框架侧不把它包装成方法调用。这是"方法调用"和"裸消息"两种抽象的使用边界——**引擎只发数据、不发方法名时，就用 `BasicMessageChannel`**。

## 六、源码实验

### 实验 1：`flutter/assets` 的通道名与 key 编码

**改什么**：给 `flutter/assets` 装一个 mock handler，记录收到的字节，然后 `rootBundle.load('assets/demo .txt')`（注意 key 里有个空格）。

**预测**：通道名应该是 `SystemChannels` 里的某个常量；key 应该原样发出去。

**实际**（实测输出）：

```text
CHANNEL: [assets/demo%20.txt]
LOADED:  [104, 105]
```

**说明**：两点与预测不符：
1. **`flutter/assets` 不在 `SystemChannels` 里**，它是 `PlatformAssetBundle.load` 硬编码的字符串（`asset_bundle.dart:329`）；
2. **key 里的空格被编码成了 `%20`**。这就是 `Uri(path: Uri.encodeFull(key)).path` 的效果（`asset_bundle.dart:327`）。所以"引擎侧收到的 asset key"和"你传给 `load` 的字符串"可能不同——**带特殊字符的资源名出错时，要检查编码这一步，而不是怀疑通道**。

`LOADED: [104, 105]` 是 mock 返回的两个字节 `hi`，说明 `load` 返回的就是**通道回复的原始字节**，`rootBundle` 不做任何解码。

### 实验 2：`SystemChannels` 的名字与 codec 全表

**改什么**：遍历几个常用 `SystemChannels` 常量，打印名字、codec 类型和运行时类型。

**实际**（实测输出）：

```text
CHANNEL flutter/platform      -> JSONMethodCodec      (OptionalMethodChannel)
CHANNEL flutter/lifecycle     -> StringCodec          (BasicMessageChannel<String?>)
CHANNEL flutter/system        -> JSONMessageCodec     (BasicMessageChannel<Object?>)
CHANNEL flutter/accessibility -> StandardMessageCodec (BasicMessageChannel<Object?>)
CHANNEL flutter/keyevent      -> JSONMessageCodec     (BasicMessageChannel<Object?>)
CHANNEL flutter/textinput     -> JSONMethodCodec      (OptionalMethodChannel)
CHANNEL flutter/navigation    -> JSONMethodCodec      (OptionalMethodChannel)
```

**说明**：**`SystemChannels` 里两种 MethodCodec 混用**——引擎内建的方法通道（`platform` / `textinput` / `navigation`）用 `JSONMethodCodec`，而 `platform_views`（`method_codecs` 的默认值）用 `StandardMethodCodec`。`is OptionalMethodChannel` 为 true 且 `is MethodChannel` 也为 true，说明 `OptionalMethodChannel` 是 `MethodChannel` 的子类（`platform_channel.dart:627`）。

### 实验 3：入向消息的接收链

**改什么**：给一个自定义通道 `setMethodCallHandler`，用 `channelBuffers.push` 投递一条编码过的 `MethodCall`，在 push 之后同步、以及 pump 一帧之后各打印一次收到的参数和回复。

**实际**（实测输出）：

```text
push 之后同步: received=[] reply=null
pump 之后:     received=[{n: 7}] reply=pong
```

**说明**：`push` 在有 listener 时是**同步 invoke listener**（`channel_buffers.dart:133-141`，`_Channel.push`），但 listener 本身是 `async` 的（`services/binding.dart:657-676` 那段 `await handler(data)`），所以 handler 的结果要等微任务。在 `flutter_test` 的 `FakeAsync` 里必须 `pump()` 才能推进。

**这条实验对应的是"平台发消息给框架"的完整路径**：`channelBuffers.push` → listener → `MethodCodec.decodeMethodCall` → 你的 handler → `codec.encodeSuccessEnvelope` → `callback(response)` → 引擎的 `_respondToPlatformMessage`。**环节里没有"请求也走 `responseId`"的对称性**——只有回复走 `responseId`。

### 实验 4：`kDefaultBufferSize = 1` 的含义

```bash
grep -n "kDefaultBufferSize" /path/to/sky_engine/lib/ui/channel_buffers.dart
```

**实际**：

```text
319:  static const int kDefaultBufferSize = 1;
```

**说明**：**没有 listener 的通道默认只能缓冲 1 条消息**，第 2 条会触发 `_dropOverflowMessages`（`channel_buffers.dart:160`），旧消息被丢掉且它的 callback 会收到 `null`。这就是"插件在框架注册 listener 之前发消息会丢"的机制。要改这个容量，插件需要往控制通道 `dev.flutter/channel-buffers`（`ChannelBuffers.kControlChannelName`，`channel_buffers.dart:325`）发消息——这也是 `_dispatchPlatformMessage` 里那条特殊分支存在的原因（`platform_dispatcher.dart:805-810`）。

### 实验 5：`loadBuffer` 在非 Web 上绕过通道

```bash
grep -n "kIsWeb" packages/flutter/lib/src/services/asset_bundle.dart
```

**实际**：命中 `PlatformAssetBundle.loadBuffer`（`asset_bundle.dart:350`）与紧随其后的注释。

**说明**：读源码会看到 `loadBuffer` 开头就是 `if (kIsWeb) { ... return await load(key) 的结果 }`，之后才走 `dart:io` 直接读文件的路径。**同一份逻辑在 Web 和非 Web 上走两条完全不同的路**：非 Web 绕开平台通道直接读应用包内的文件，Web 回退到 `flutter/assets` 通道（因为 Web 上没有文件系统）。这是"通道不是唯一数据来源"的最好的例子，也提醒我们：**"资源加载慢"不能一概归因于通道开销**。

## 七、结论

1. `SystemChannels` 里的通道分两类：**引擎内建**（`platform` / `lifecycle` / `system` / `accessibility` / `keyevent` / `textinput` / `platform_views`，引擎侧有实现）和**约定通道**（`navigation` / `restoration` / `menu` …）。`ServicesBinding.initInstances`（`services/binding.dart:47-66`）只挂前一类中的四条。
2. `rootBundle` 是 `PlatformAssetBundle` 实例（`asset_bundle.dart:418`），它的 `load` 走 `flutter/assets` 通道——**而这个通道名是硬编码字符串（`:329`），不在 `SystemChannels` 里**。key 在发出前会做 URI 编码（空格 → `%20`），二进制资源不缓存。
3. 出向终点是 `PlatformDispatcher.sendPlatformMessage` → `__sendPlatformMessage`（`@Native`，**边界**）；入向唯一入口是 `channelBuffers.push`，**回复则走另一条路**（`_respondToPlatformMessage(responseId, ...)`）。每次 `setMessageHandler` 都会通过 `sendChannelUpdate` 向引擎报告订阅状态。

一句话总结：**`AssetBundle` 是通道机制最朴素的用户，`SystemChannels` 是框架与引擎之间的"已注册通道清单"，而这两条链的最后一步都是同一个 `@Native` 声明。**

## 八、边界声明

- **边界之外是引擎**：`platform_dispatcher.dart:677` 的 `external static String? __sendPlatformMessage(...)`（`@Native`，`symbol: 'PlatformConfigurationNativeApi::SendPlatformMessage'`）与 `channel_buffers.dart:401-403` 的 `_sendChannelUpdate`（`symbol: 'PlatformConfigurationNativeApi::SendChannelUpdate'`）。它们的实现都在引擎的 C++ 里，**本地 SDK 没有源码**。Kotlin / Swift 侧对各通道的实现（如 `flutter/platform` 的 `Clipboard.getData`）同样不在本地。
- `bin/cache/pkg/sky_engine/lib/ui/` 是 dart:ui 的 Dart 侧接口，随 SDK 缓存分发，不是引擎实现本身。本篇引用它只为把"边界在哪一行"写清楚。
- `SystemChrome` / `SystemNavigator` / `Clipboard` / `HapticFeedback` / `RestorationManager` 等"使用通道的子系统"只标出调用位置（如 `clipboard.dart:36`、`system_navigator.dart:81`），不展开各自语义。
- `SystemChannels.textInput`（IME 协议）与 `SystemChannels.platform_views` 属于独立子系统，本篇不展开。
- `AssetManifest` / `AssetManifest.bin`（`services/asset_manifest.dart`）与 `font_loader.dart` 的字体加载预热不展开。
- 通道的字节格式、codec 类型标签、信封规则在第 27 篇；`ServicesBinding` 的四条内建通道注册在第 26 篇 4.3。
