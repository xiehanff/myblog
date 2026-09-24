# 27 MethodChannel 与 MessageCodec：一次方法调用穿过的层

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `services/platform_channel.dart`（741 行）、`services/message_codec.dart`（215 行）、`services/message_codecs.dart`（663 行）、`services/binary_messenger.dart`（83 行）

## 一、问题

`MethodChannel.invokeMethod('getVersion')` 是一行代码。它到原生之间隔着几层？

错误直觉是"`MethodChannel` 直接和原生通信"，或者"`invokeMethod` 是一个系统调用"。这两种理解会带来一个具体的麻烦：**当参数类型不对、返回值类型不对、插件没实现、原生抛异常这四种情况发生时，你分不清是哪一层在报错**——它们分别抛 `ArgumentError` / `TypeError` / `MissingPluginException` / `PlatformException`，来自完全不同的位置。

真实的层次是：**`MethodChannel`（语义）→ `MethodCodec`（结构）→ `BinaryMessenger`（字节）→ `PlatformDispatcher`（边界）**。四层各管一件事，而且每层都只有很少的方法。

## 二、最小 Demo

用 `flutter_test` 的 mock messenger 假扮原生端，把整条链跑通，然后逐层观察字节：

```dart
import 'dart:typed_data';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('一次 invokeMethod 的四层', (tester) async {
    // 1. 假扮原生端：直接接在二进制层（ByteData 进 ByteData 出）
    tester.binding.defaultBinaryMessenger.setMockMessageHandler('probe/version', (
      ByteData? message,
    ) async {
      // 2. 二进制层收到的就是标准编码的字节
      debugPrint('raw bytes: ${message!.buffer.asUint8List().take(12).toList()}');
      // 3. 用同一个 codec 解出方法调用，看看原生端"看到"了什么
      const StandardMethodCodec codec = StandardMethodCodec();
      debugPrint('decoded: ${codec.decodeMethodCall(message)}');
      // 4. 用成功信封编码回复
      return codec.encodeSuccessEnvelope('9.9.9');
    });

    const MethodChannel channel = MethodChannel('probe/version');
    final String? version = await channel.invokeMethod<String>('getVersion', <String, Object?>{
      'detail': true,
    });
    debugPrint('result: $version');
  });
}
```

输出（实测）：

```text
raw bytes: [7, 10, 103, 101, 116, 86, 101, 114, 115, 105, 111, 110]
decoded: MethodCall(getVersion, {detail: true})
result: 9.9.9
```

首字节 `7` 是"字符串"标签，`10` 是方法名的长度，后面十个字节 `103 101 116 …` 就是 `getVersion` 的 ASCII。这段代码把四层同时暴露了出来：`MethodChannel` 只出现了两次（通道名 + `invokeMethod`），mock handler 挂在**二进制层**，而 `codec` 是手动调用的——**因为 codec 在正常情况下是被 `MethodChannel` 藏起来的**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `services/platform_channel.dart:292` | `class MethodChannel`，语义层 |
| `services/platform_channel.dart:300-305` | 构造函数：`name` + `codec`（默认 `StandardMethodCodec()`）+ 可选 `binaryMessenger` |
| `services/platform_channel.dart:318` | `binaryMessenger` getter：未显式传入时调 `_findBinaryMessenger()` |
| `services/platform_channel.dart:175` | `_findBinaryMessenger()`：按上下文选 `ServicesBinding` 或后台 isolate 的 messenger |
| `services/platform_channel.dart:351` | `_invokeMethod<T>`：四层都在这个方法里被调了一次 |
| `services/platform_channel.dart:538` | `invokeMethod<T>`：`missingOk: false` 的薄包装 |
| `services/platform_channel.dart:587` | `setMethodCallHandler`：入向注册，断言 binding 已初始化 |
| `services/platform_channel.dart:601` | `_handleAsMethodCall`：入向的三分支（成功 / `PlatformException` / 其他异常） |
| `services/platform_channel.dart:627` | `class OptionalMethodChannel extends MethodChannel` |
| `services/platform_channel.dart:632` | `OptionalMethodChannel.invokeMethod`：`missingOk: true` |
| `services/platform_channel.dart:202` | `class BasicMessageChannel<T>`：不包装方法调用的裸消息通道 |
| `services/platform_channel.dart:240` | `BasicMessageChannel.send`：一行 `codec.decodeMessage(await messenger.send(...))` |
| `services/platform_channel.dart:253` | `BasicMessageChannel.setMessageHandler` |
| `services/platform_channel.dart:651` | `class EventChannel`：用 `MethodChannel` 承载流 |
| `services/platform_channel.dart:693` | `EventChannel.receiveBroadcastStream`：`listen` / `cancel` + `setMessageHandler` 的组合 |
| `services/platform_channel.dart:54` | `_ProfiledBinaryMessenger`：性能剖析时的装饰器 |
| `services/binary_messenger.dart:22` | `abstract class BinaryMessenger`，3 个方法 |
| `services/binary_messenger.dart:69` | `Future<ByteData?>? send(String channel, ByteData? message)` |
| `services/binary_messenger.dart:79` | `void setMessageHandler(String channel, MessageHandler? handler)` |
| `services/message_codec.dart:20` | `abstract class MessageCodec<T>`：`encodeMessage` / `decodeMessage` |
| `services/message_codec.dart:35` | `class MethodCall`：`method` + `arguments` |
| `services/message_codec.dart:66` | `abstract class MethodCodec`：5 个方法（编解码 + 信封） |
| `services/message_codec.dart:108` | `class PlatformException` |
| `services/message_codec.dart:205` | `class MissingPluginException` |
| `services/message_codecs.dart:260` | `class StandardMessageCodec`：类型标签表 + `writeValue` / `readValue` |
| `services/message_codecs.dart:307-321` | 15 个类型标签常量 |
| `services/message_codecs.dart:383` | `writeValue`：`else if` 链，最后 `throw ArgumentError.value(value)` |
| `services/message_codecs.dart:485` | `readValueOfType`：标签 → Dart 值；未知标签走 `default`（`:532-533`）抛 `FormatException('Message corrupted')` |
| `services/message_codecs.dart:577` | `class StandardMethodCodec`：信封格式 |
| `services/message_codecs.dart:635` | `StandardMethodCodec.decodeEnvelope`：首字节 0 = 成功 |
| `services/message_codecs.dart:118` | `class JSONMethodCodec` |
| `services/message_codecs.dart:89` | `class JSONMessageCodec` |
| `services/message_codecs.dart:28` / `44` | `BinaryCodec` / `StringCodec`，两个不做任何变换的 codec |
| `services/binding.dart:624` | `_DefaultBinaryMessenger.send`：字节层的终点，**边界在这里** |

## 四、调用链

### 4.1 四层一览

一次 `invokeMethod('getVersion', {'detail': true})` 的完整路径：

```text
① MethodChannel.invokeMethod(String, [dynamic])            platform_channel.dart:538
      ↓  missingOk: false
② MethodChannel._invokeMethod<T>(method, {missingOk, arguments})   platform_channel.dart:351
      ↓  codec.encodeMethodCall(MethodCall(method, arguments))
③ MethodCodec（StandardMethodCodec）→ ByteData             message_codecs.dart:597
      ↓  binaryMessenger.send(name, input)
④ BinaryMessenger.send(String, ByteData?)                   binary_messenger.dart:69
      ↓  ui.PlatformDispatcher.instance.sendPlatformMessage(...)
⑤ PlatformDispatcher → __sendPlatformMessage（@Native）      platform_dispatcher.dart:657 / 677
      ↓
   ────────────── 边界：以下是引擎的 C++，本地无源码 ──────────────
```

返回方向沿着同一条链往回：字节 → `codec.decodeEnvelope(result)` → `T`。

**关键认知**：`_invokeMethod` 只有 15 行，但它把一个通道通信需要做的**全部四件事**都放在了同一个方法里——编码、发送、判空、解码。读这一方法等于读完了整层的骨架：

```dart
// platform_channel.dart:351-369
Future<T?> _invokeMethod<T>(String method, {required bool missingOk, dynamic arguments}) async {
  final ByteData input = codec.encodeMethodCall(MethodCall(method, arguments));     // 编码
  final ByteData? result = shouldProfilePlatformChannels
      ? await (binaryMessenger as _ProfiledBinaryMessenger).sendWithPostfix(
          name, '#$method', input)
      : await binaryMessenger.send(name, input);                                    // 发送
  if (result == null) {
    if (missingOk) {
      return null;                                                                  // 可选通道
    }
    throw MissingPluginException('No implementation found for method $method on channel $name');
  }
  return codec.decodeEnvelope(result) as T?;                                        // 解码
}
```

### 4.2 `MethodCall` 的组装与 `MissingPluginException` 的判定

`MethodCall` 是一个 `@immutable` 值对象（`message_codec.dart:33-54`），只有 `method` 和 `arguments` 两个字段。它的文档专门提醒了一句：`arguments` 是 `dynamic` 而不是 `Object?`，**访问它时跳过类型检查**（`message_codec.dart:47-49`），所以框架建议拿到后先 cast 成 `Object?` 再处理。

`result == null` 是 `MissingPluginException` 的**唯一**判定条件——注意它判的是"回复的字节是不是 null"，不是"原生有没有注册 handler"。在引擎侧，未注册 handler 的通道会被回复一个 null，所以这个判断成立；`OptionalMethodChannel`（`platform_channel.dart:627`）就是把这个 null 变成返回值而不是异常：

```dart
// platform_channel.dart:632-635
@Override
Future<T?> invokeMethod<T>(String method, [dynamic arguments]) async {
  return super._invokeMethod<T>(method, missingOk: true, arguments: arguments);
}
```

**关键认知**：`MethodChannel` 和 `OptionalMethodChannel` 的**唯一区别**就是 `missingOk`。`SystemChannels` 里的内建通道大量使用 `OptionalMethodChannel`（`system_channels.dart:181` 起的 `platform`、`statusBar`、`textInput`、`navigation` …），因为这些通道在部分平台上没有实现，框架不希望这种"平台不支持"变成异常。

### 4.3 `MethodCodec`：只有 5 个方法

```dart
// message_codec.dart:66-93（节选）
abstract class MethodCodec {
  ByteData encodeMethodCall(MethodCall methodCall);
  MethodCall decodeMethodCall(ByteData? methodCall);
  dynamic decodeEnvelope(ByteData envelope);
  ByteData encodeSuccessEnvelope(Object? result);
  ByteData encodeErrorEnvelope({required String code, String? message, Object? details});
}
```

**抽象协议和具体实现被拆在两个文件名只差一个 `s` 的文件里**：`message_codec.dart`（215 行，只放 `MessageCodec` / `MethodCall` / `MethodCodec` / `PlatformException` / `MissingPluginException`）与 `message_codecs.dart`（663 行，放 `BinaryCodec` / `StringCodec` / `JSONMessageCodec` / `JSONMethodCodec` / `StandardMessageCodec` / `StandardMethodCodec`）。两者都被 `services.dart` 导出（`:31`、`:32`），所以从 `package:flutter/services.dart` 看是一个整体；但按路径搜索时如果只打开了 `message_codec.dart`，会以为 `StandardMethodCodec` 不存在。

这 5 个方法体现了"方法调用"这个语义的最小结构：**两次编码（请求 / 回复）+ 两次解码 + 一次错误编码**。信封（envelope）的引入是因为回复有三种可能：成功、失败、没实现。`StandardMethodCodec` 用**首字节区分**：

```dart
// message_codecs.dart:617-631（节选）
ByteData encodeSuccessEnvelope(Object? result) {
  final buffer = WriteBuffer();
  buffer.putUint8(0);                       // 0 = 成功
  messageCodec.writeValue(buffer, result);
  return buffer.done();
}

ByteData encodeErrorEnvelope({required String code, String? message, Object? details}) {
  final buffer = WriteBuffer();
  buffer.putUint8(1);                       // 非 0 = 错误
  messageCodec.writeValue(buffer, code);
  messageCodec.writeValue(buffer, message);
  messageCodec.writeValue(buffer, details);
  return buffer.done();
}
```

而 `JSONMethodCodec` 用的是**列表长度**区分（`message_codecs.dart:194-196`）：`[result]` 是成功，`[code, message, details]` 或 `[code, message, details, stacktrace]` 是错误。解码时两种 codec 都会在错误信封上抛 `PlatformException`，把 `code` / `message` / `details` / `stacktrace` 四个字段填好（`message_codecs.dart:653-661`）。

**关键认知**：`decodeEnvelope` 是**抛异常的解码器**，不是返回状态码的解码器。`invokeMethod` 的返回值里不会出现"错误对象"，只会有"结果"或"抛出的异常"。这就是为什么业务代码通常这么写：

```dart
try {
  await channel.invokeMethod<void>('doSomething');
} on PlatformException catch (e) {
  // 原生端主动报错
} on MissingPluginException {
  // 根本没有实现
}
```

### 4.4 `StandardMessageCodec` 的类型集合

`StandardMessageCodec` 是"什么类型能过通道"这个问题的唯一答案。它先把类型编号：

```dart
// message_codecs.dart:307-321
static const int _valueNull = 0;
static const int _valueTrue = 1;
static const int _valueFalse = 2;
static const int _valueInt32 = 3;
static const int _valueInt64 = 4;
static const int _valueLargeInt = 5;
static const int _valueFloat64 = 6;
static const int _valueString = 7;
static const int _valueUint8List = 8;
static const int _valueInt32List = 9;
static const int _valueInt64List = 10;
static const int _valueFloat64List = 11;
static const int _valueList = 12;
static const int _valueMap = 13;
static const int _valueFloat32List = 14;
```

**标签 5（`_valueLargeInt`）是"只能解不能编"的**：`writeValue` 永远不会用它，`readValueOfType` 却接受它（`message_codecs.dart:499-501`，和 `_valueString` 走同一条分支）。源码注释解释了这个不对称（`message_codecs.dart:376-382`）：它是给自定义编解码器留的扩展位——type byte 后跟一个十六进制 ASCII 字符串，Android 侧会转成 `java.math.BigInteger`。而 `_valueFloat32List` 是后加的（编号 14，排在 `_valueMap` 之后），也说明**标签编号不等于类型顺序**。

`writeValue` 的检查顺序里有一个必须记住的坑：

```dart
// message_codecs.dart:383-405（节选）
void writeValue(WriteBuffer buffer, Object? value) {
  if (value == null) {
    buffer.putUint8(_valueNull);
  } else if (value is bool) {
    ...
  } else if (value is double) {
    // Double precedes int because in JS everything is a double.
    // Therefore in JS, both `is int` and `is double` always
    // return `true`. If we check int first, we'll end up treating
    // all numbers as ints and attempt the int32/int64 conversion,
    // which is wrong. This precedence rule is irrelevant when
    // decoding because we use tags to detect the type of value.
    buffer.putUint8(_valueFloat64);
    buffer.putFloat64(value);
    // ignore: avoid_double_and_int_checks, JS code always goes through the `double` path above
  } else if (value is int) {
    if (-0x7fffffff - 1 <= value && value <= 0x7fffffff) {
      buffer.putUint8(_valueInt32);
      buffer.putInt32(value);               // 32 位放得下 → 用 3
    } else {
      buffer.putUint8(_valueInt64);
      buffer.putInt64(value);               // 否则用 4
    }
  } else if (value is String) {
    ...
  } else if (value is Uint8List) {
    ...
```

**关键认知**：`double` 的判断必须在 `int` 之前，且这条规则的唯一理由是 **Web 平台上 `3 is int` 和 `3 is double` 同时为真**。源码的注释把这件事写得很直白。所以在 Web 上，整数会被编成标签 6（Float64）；解码侧则不依赖顺序，只按标签还原。**这就是"同一个方法在 Web 和移动端收到的参数类型可能不同"的根因之一**（Web 上收到的是 `double`，移动端收到的是 `int`）。

`String` 的编码还有一个小优化：先按 ASCII 逐字符试，遇到第一个非 ASCII 字符才切到 `utf8.encode`（`message_codecs.dart:407-429`）。所以纯 ASCII 字符串走的是零额外开销的路径。

支持的完整类型集合（按 `writeValue` 的 `else if` 链，`message_codecs.dart:383-464`）：

| Dart 类型 | 标签 | 编码方式 |
|---|---|---|
| `null` / `bool` | 0 / 1,2 | 1 字节标签 |
| `double` | 6 | 标签 + 8 字节 IEEE754 |
| `int` | 3 或 4 | 标签 + 4 字节（32 位内）或 8 字节 |
| `String` | 7 | 长度前缀 + ASCII 快路径 / UTF-8 |
| `Uint8List` | 8 | 长度前缀 + 原始字节 |
| `Int32List` / `Int64List` / `Float32List` / `Float64List` | 9 / 10 / 14 / 11 | 定长类型数组 |
| `List` | 12 | 长度前缀 + 递归 |
| `Map` | 13 | 长度前缀 + key/value 递归 |

**其它任何类型都会走到最后一行并抛异常**：

```dart
} else {
  throw ArgumentError.value(value);
}
```

也就是说，`DateTime`、`Duration`、自定义对象、`Set`、`Map<Object, String>` 里的对象键，**统统不支持**。第 6 节实验 2 会给出实测的异常类型。

### 4.5 入向：`setMethodCallHandler` 的三分支

出向是"编码 → 发送 → 解码"，入向则是"解码 → 调用 → 编码回复"：

```dart
// platform_channel.dart:601-614
Future<ByteData?> _handleAsMethodCall(
  ByteData? message,
  Future<dynamic> Function(MethodCall call) handler,
) async {
  final MethodCall call = codec.decodeMethodCall(message);
  try {
    return codec.encodeSuccessEnvelope(await handler(call));
  } on PlatformException catch (e) {
    return codec.encodeErrorEnvelope(code: e.code, message: e.message, details: e.details);
  } on MissingPluginException {
    return null;                                    // 回复 null = 没实现
  } catch (error) {
    return codec.encodeErrorEnvelope(code: 'error', message: error.toString());
  }
}
```

四个分支对应四种结果：

| handler 的表现 | 回复的字节 | 原生端看到 |
|---|---|---|
| 正常返回 | 成功信封 | 结果值 |
| 抛 `PlatformException` | 错误信封（保留 code/message/details） | 错误 + 原始错误码 |
| 抛 `MissingPluginException` | **`null`** | 未实现 |
| 抛其它异常 | 错误信封，code 固定为 `'error'` | 错误 + `toString()` |

**关键认知**：`MissingPluginException` 在入向被翻译成"回复 null"，而出向看到"回复 null"又翻译成 `MissingPluginException`。**同一个异常类型在管子的两端互为对方的编码**——这是这套协议里唯一一处"异常充当协议信号"的设计。

### 4.6 三个通道类的分工

`platform_channel.dart` 有三个类，它们的关系不是继承而是**组合**：

| | `BasicMessageChannel<T>` | `MethodChannel` | `EventChannel` |
|---|---|---|---|
| 声明位置 | `:202` | `:292` | `:651` |
| 抽象的东西 | 一条"消息" | 一次"方法调用" | 一条"事件流" |
| 使用的 codec | `MessageCodec<T>` | `MethodCodec` | `MethodCodec` |
| 发送 | `send(T message)`（`:240`） | `invokeMethod` 家族 | **不需要主动发** |
| 接收 | `setMessageHandler`（`:253`） | `setMethodCallHandler`（`:587`） | `receiveBroadcastStream`（`:693`） |
| 内部是否有 channel | 是（自己就是） | 是 | **是——它内部 new 了一个 `MethodChannel`** |

`EventChannel.receiveBroadcastStream` 是最能说明"分层组合"价值的一段代码：

```dart
// platform_channel.dart:693-741（节选）
Stream<dynamic> receiveBroadcastStream([dynamic arguments]) {
  final methodChannel = MethodChannel(name, codec);          // 1. 借用一个 MethodChannel
  late StreamController<dynamic> controller;
  controller = StreamController<dynamic>.broadcast(
    onListen: () async {
      binaryMessenger.setMessageHandler(name, (ByteData? reply) async {   // 2. 先挂事件监听
        if (reply == null) {
          await controller.close();                                      // 3. null = 流结束
        } else {
          try {
            controller.add(codec.decodeEnvelope(reply));                 // 4. 事件是"回复信封"
          } on PlatformException catch (e) {
            controller.addError(e);
          }
        }
        return null;                                                     // 5. 事件不回复
      });
      await methodChannel.invokeMethod<void>('listen', arguments);        // 6. 再告诉原生端开始发
    },
    onCancel: () async {
      binaryMessenger.setMessageHandler(name, null);                     // 7. 摘掉监听
      await methodChannel.invokeMethod<void>('cancel', arguments);
    },
  );
  return controller.stream;
}
```

**关键认知**：`EventChannel` 没有自己的协议——它把"方法调用"和"裸消息"两个原语组合成了"流"：`listen` / `cancel` 是方法调用，事件是原生端主动发过来的**裸消息**，而且事件的字节格式就是方法调用的**回复信封**（所以能复用 `decodeEnvelope`，并顺带支持 `PlatformException` 作为流上的错误）。**"null 消息 = 流结束"也是在这个文件里定的**（`:700-702`）。

## 五、核心对象：两组对比

**第一组：两套 codec 各管一层。**

| | `MessageCodec<T>` | `MethodCodec` |
|---|---|---|
| 声明位置 | `message_codec.dart:20` | `message_codec.dart:66` |
| 方法数 | 2（`encodeMessage` / `decodeMessage`） | 5 |
| 认识"方法"吗 | 不认识，只管单个值 | 认识 `MethodCall` 和信封 |
| 谁使用 | `BasicMessageChannel`、`SystemChannels` 的消息通道 | `MethodChannel`、`EventChannel` |
| 典型实现 | `StandardMessageCodec`、`JSONMessageCodec`、`StringCodec`、`BinaryCodec` | `StandardMethodCodec`、`JSONMethodCodec` |
| 泛型 | 有（`T`），因为要还原成具体类型 | 无，返回值是 `dynamic` |

**第二组：`StandardMethodCodec` 与 `JSONMethodCodec` 的差别。**

| | `StandardMethodCodec` | `JSONMethodCodec` |
|---|---|---|
| 声明位置 | `message_codecs.dart:577` | `message_codecs.dart:118` |
| 底层 codec | `StandardMessageCodec` | `JSONMessageCodec` |
| `MethodCall` 的形状 | `[method, args]` 两个值顺序写（`:597-603`） | `{"method": ..., "args": ...}` |
| 成功信封 | 首字节 `0` + 值 | `[result]`（长度 1） |
| 错误信封 | 首字节非 0 + code/message/details(/stacktrace) | `[code, message, details(, stacktrace)]`（长度 3 或 4） |
| `int` 精度 | 32 / 64 位分标签，不丢精度 | 解码端用 `json.decode`（`message_codecs.dart:106-110`）：整数字面量（无 `.` / `e`）还原为 `int`，带小数点或指数才是 `double`；但 JSON 里 `1` 和 `1.0` 是不同文本，原生端把它写成 `1.0` 框架就拿到 `double`——类型由**发送方的写法**决定，超出 int64 的整数字面量会退化为 `double` |
| 谁在用 | **插件**（`MethodChannel` 的默认值） | **引擎内建通道**（`SystemChannels`） |

"谁在用"这一行是最有实用价值的一条：`MethodChannel('music')` 不传 codec 时默认是 `StandardMethodCodec`；而 `SystemChannels.platform` 显式传了 `JSONMethodCodec()`（`system_channels.dart:181-184`）。**两种 codec 的字节完全不兼容**，因此不能用一个 codec 解另一个的字节（第 6 节实验 3 有实测的失败信息）。

`int` 精度那一行可以当场验：`json.decode('1')` 返回 `int 1`，`json.decode('1.0')` 与 `json.decode('1e2')` 返回 `double`——Dart 的 JSON 解码**按字面量**决定数字类型，不存在"JSON 数字统一变 double"。真正的坑在发送端：原生侧把整数序列化成 `1.0` 这样的文本，框架就只能拿到 `double`。

**第三组：`BinaryMessenger` 的三个方法。**

| 方法 | 方向 | 参数 | 返回 |
|---|---|---|---|
| `send(channel, message)` | 出向 | 通道名 + 字节 | `Future<ByteData?>?`（**可空 Future**） |
| `setMessageHandler(channel, handler)` | 入向注册 | 通道名 + `MessageHandler` | `void` |
| `handlePlatformMessage(channel, data, callback)` | 入向（已废弃） | 三个参数 | `Future<void>` |

`send` 返回的是**可空 Future** 而不是 `Future<ByteData?>`，这个细节有实际意义：`Future<ByteData?>?` 为 null 表示"这条消息根本发不出去"（例如后台 isolate 未初始化），而 `Future<ByteData?>` 为 `Future.value(null)` 表示"发出去了但没有回复"。`_invokeMethod` 用的是 `await binaryMessenger.send(...)`，两者都会被折叠成 `null` 并走向 `MissingPluginException`——**从 `invokeMethod` 的视角分不出这两种情况**。

## 六、源码实验

### 实验 1：一次调用的字节与出入向对称

**改什么**：用第 2 节的 Demo，在 mock handler 里打印原始字节并用同一个 codec 解码。

**实际**（实测输出）：

```text
raw bytes: [7, 1, 103, 101, 116, ...]
decoded: MethodCall(getVersion, {detail: true})
result: 9.9.9
```

**说明**：首字节 `7` 是 `_valueString`，第 2 字节 `10` 是方法名长度，接着是 `getVersion` 的 ASCII。**入向处理（`_handleAsMethodCall`）的第一步就是把这段字节解回 `MethodCall`**——所以出向和入向共用同一个 `codec`，字节格式天然对称。

**一个测量上的坑**：这里用 `message.buffer.asUint8List()` 打印，它返回的是**底层 buffer 的全部内容**，会忽略 `ByteData` 自己的 offset/length 窗口，所以尾部会带上未使用的容量字节；要看真实报文长度应该用 `message.lengthInBytes` 或 `Uint8List.sublistView(message)`。下面的实验 4 就会看到这种现象。

### 实验 2：类型标签与不支持的类型的报错

**改什么**：用 `StandardMethodCodec` 编码一个含 `int` 1、`int 0x100000000`、`null` 的 `MethodCall`，打印前 16 个字节并解码回来；再尝试编码一个 `Object()`。

**预测**：编码一个任意对象应该抛 `TypeError` 或 `NoSuchMethodError`。

**实际**（实测输出）：

```text
BYTES: [7, 5, 112, 114, 111, 98, 101, 13, 3, 7, 1, 97, 3, 1, 0, 0]
DECODED: MethodCall(probe, {a: 1, b: 4294967296, c: null})
UNSUPPORTED: ArgumentError Invalid argument: Instance of 'Object'
```

**说明**：字节逐段对应源码 —— `7` + 长度 `5` + `probe`（方法名）；`13` = `_valueMap`，`3` = 3 个键值对；`7 1 'a'` 是 key `"a"`；`3` = `_valueInt32`，后面 4 字节是 `1`；`0` = `_valueNull`（`c` 的值）。

不支持的类型的**实际行为是抛 `ArgumentError`**（来自 `message_codecs.dart:464` 的 `throw ArgumentError.value(value)`），不是 `TypeError`。`ArgumentError` 在发布版本里同样会抛（它不是 assert），所以这是一个**运行时才发现的、且只在调用方一侧发生的错误**——原生端根本收不到任何消息。

### 实验 3：两种 MethodCodec 互不兼容

**改什么**：用 `JSONMethodCodec` 和 `StandardMethodCodec` 分别编码同一个 `MethodCall`，打印字节；再用 `JSONMethodCodec` 去解 `StandardMethodCodec` 的字节。

**实际**（实测输出）：

```text
JSON:     [123, 34, 109, 101, 116, 104, 111, 100, 34, 58, 34, 109, 34, 44, ...]
STANDARD: [7, 1, 109, 13, 2, 7, 1, 100, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
JSON 解 STANDARD 字节失败: FormatException FormatException: Invalid UTF-8 byte (at offset 22)
```

**说明**：JSON 版的前四个字节 `123 34 109 101` 就是 `{"me` 的 ASCII —— **`JSONMethodCodec` 的字节是可读的 JSON 文本**，`{"method":"m","args":...}`。标准版是二进制标签流。两种 codec 用错时的错误信息很有特征：解 JSON 报 `Invalid UTF-8`，解标准版会先撞上 `readValue` 的 `!buffer.hasRemaining` 判断（`message_codecs.dart:473-475`）报 `Message corrupted`，读下去再撞上 `readValueOfType` 的 `default`（`:532-533`）报同一条信息。

注意标准版里 `d: 1.5` 被编成标签 `6`（`_valueFloat64`）+ 8 字节；而 `i: 1` 也是标签 `3` + 4 字节。**同一个 `Map` 里 `int` 和 `double` 的标签不同**，解码后类型也能还原——这是标准 codec 比 JSON codec 强的一点。

### 实验 4：`decodeEnvelope` 的三种信封

**改什么**：用 `StandardMethodCodec` 分别生成成功信封和错误信封，再用 `decodeEnvelope` 解。

**预测**：错误信封应该返回一个"错误对象"。

**实际**（实测输出）：

```text
ok bytes:  [0, 3, 42, 0, 0, 0, 0, ...]     ← 0=成功，3=Int32，42
err bytes: [1, 7, 2, 69, 49, 7, 3, 98, 97, 100, 12, 1, 3, 1, 0, 0, 0]
err decoded -> PlatformException PlatformException(E1, bad, [1], null)
empty -> FormatException FormatException: Expected envelope, got nothing
```

逐段读 `err bytes`：`1` = 非 0（错误）；`7 2 'E' '1'` = 字符串 `"E1"`（code）；`7 3 'b' 'a' 'd'` = 字符串 `"bad"`（message）；`12` = `_valueList`，`1` = 长度 1；`3 1 0 0 0` = Int32 值 1（details 是 `[1]`）。

**说明**：成功信封解出原值；错误信封**抛 `PlatformException`**，`toString` 里四个字段依次是 code / message / details / stacktrace。空字节抛 `FormatException('Expected envelope, got nothing')`。

`decodeEnvelope` 的签名是 `dynamic decodeEnvelope(ByteData envelope)`（`message_codec.dart:83`），但它的行为是"要么返回结果、要么抛异常"——**没有任何"返回错误"的分支**。这是本层协议的一个硬约束：错误不走返回值。这也是为什么业务代码里 `try` 的 `on PlatformException` 和 `on MissingPluginException` 必须分开写。

顺带一个反面例子：把字节 `[1, 99]` 直接当信封解（`1` 表示错误，`99` 不是任何合法标签），得到的是 `FormatException('Message corrupted')`——**这是 `readValueOfType` 的 `default` 分支**（`message_codecs.dart:532-533`）。两个格式错误的信息不同，可以据此定位是"信封坏了"还是"值坏了"。

## 七、结论

1. 一次 `invokeMethod` 穿过四层：**`MethodChannel`（语义）→ `MethodCodec`（结构）→ `BinaryMessenger`（字节，只有 3 个方法）→ `PlatformDispatcher.sendPlatformMessage`（边界，`@Native`）**。分层的方式是"每层只加一种信息"，所以每层的 API 都很小。
2. `StandardMessageCodec` 支持的类型是**封闭的 15 种标签**（`message_codecs.dart:307-321`），不支持的类型在 `writeValue` 最后一行抛 `ArgumentError`。`double` 必须在 `int` 之前判断，唯一原因是 Web 上 `3 is int` 和 `3 is double` 同时为真——**这直接导致 Web 与移动端收到的整数类型可能不同**。
3. 回复的三种可能被"信封"表达：成功、错误（`PlatformException`）、未实现（回复 `null` → 调用侧 `MissingPluginException`）。`decodeEnvelope` **不返回错误**，错误一律抛异常，所以业务代码必须用 `try` 区分 `PlatformException` 与 `MissingPluginException`。

一句话总结：**`MethodChannel` 是"方法调用"的语法糖，`MethodCodec` 把它压成字节，`BinaryMessenger` 只管搬运字节，而字节出了 `@Native` 那一行就不在本地源码里了。**

## 八、边界声明

- **边界之外是引擎**：`ui.PlatformDispatcher.sendPlatformMessage`（`bin/cache/pkg/sky_engine/lib/ui/platform_dispatcher.dart:657`）最终调到 `external static String? __sendPlatformMessage(...)`（同文件 `:677`），带 `@Native` 注解，`symbol` 指向 `PlatformConfigurationNativeApi::SendPlatformMessage`。**这个方法的实现是引擎的 C++（`flutter/engine` 仓库），本地 SDK 里没有源码。** 同理，Kotlin/Swift 侧的 `MethodChannel` 实现也不在本地。
- `bin/cache/pkg/sky_engine/lib/ui/` 是 dart:ui 的 **Dart 侧接口**，随 SDK 缓存分发；它不是 `packages/flutter` 的一部分，也不是引擎实现本身。本篇引用它只是为了让"边界在哪一行"可核对。
- `WriteBuffer` / `ReadBuffer`（`foundation/serialization.dart`）的二进制读写细节留给 foundation 容器的相关篇章（第六篇的边界声明里已标出）。
- `BasicMessageChannel` 的 `send` / `setMessageHandler` 只做了对比，没有逐行走链；它与 `MethodChannel` 在同一层，差别只在于"是否包装成方法调用"。
- `_ProfiledBinaryMessenger`（`platform_channel.dart:54`）与 `debugProfilePlatformChannels` 只标出位置，不展开。
- 各插件的原生实现（Kotlin/Swift/C++）不在本系列范围内；本篇聚焦源码链与 codec 的字节格式。
