# 16 ImageProvider 与 ImageStream：一次异步解码的全过程

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/painting/image_provider.dart`（1897 行）、`image_stream.dart`（1158 行）、`image_cache.dart`（649 行）、`binding.dart`（215 行）

## 一、问题

`Image.network('...')` 只有一行，但它触发的是一条**四层接力**的异步链：Widget → `ImageProvider` → `ImageCache` → `ImageStreamCompleter` → `dart:ui` 解码器。中间任何一层都可能"重复请求、缓存命中、提前返回、报错、被释放"。

于是本节的问题是：**`ImageProvider` / `ImageStream` / `ImageStreamCompleter` / `ImageCache` 这四个类各自记住什么？一次解码的字节流从哪进、`ui.Image` 从哪出？**

错误直觉是"`ImageProvider` 负责下载图片"。实际上 `ImageProvider` **只负责两件事**：把配置变成一个 key（`obtainKey`），把 key 变成一个 `ImageStreamCompleter`（`loadImage`）。它**不负责**去重（那是 `ImageCache` 的事）、不负责把图推给监听者（那是 `ImageStreamCompleter` 的事）、不负责多帧动画的排帧（那是 `MultiFrameImageStreamCompleter` 的事）。

`resolve` 的文档把这条边界写得很清楚（`image_provider.dart:367-374`）：

> This is the public entry-point of the [ImageProvider] class hierarchy. Subclasses should implement [obtainKey] and [loadImage], which are used by this method. If they need to change the implementation of [ImageStream] used, they should override [createStream]. If they need to manage the actual resolution of the image, they should override [resolveStreamForKey].

## 二、最小 Demo

用 `MemoryImage` 走完整条链（`ImageCache` 挂在 `PaintingBinding` 上，所以先初始化 binding；放在 `flutter test` 里跑）：

```dart
import 'dart:typed_data';
import 'package:flutter/foundation.dart';    // debugPrint 在这里，painting.dart 不导出它
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // 0. resolve 一路会碰 PaintingBinding.instance.imageCache，binding 不初始化会断言失败
  TestWidgetsFlutterBinding.ensureInitialized();

  test('walk the full chain with MemoryImage', () async {
    // 1. 一张真实的 1x1 不透明蓝 PNG（IHDR + IDAT + IEND，CRC 已含在字节里，
    //    这串字节经 ui.instantiateImageCodec 验证可解出 1x1 帧）
    final Uint8List bytes = Uint8List.fromList(<int>[
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,                          // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,                          // IHDR
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,                          //   宽 1 高 1
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,                    //   8bit RGBA + CRC
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54,                          // IDAT
      0x78, 0x9C, 0x63, 0x60, 0x60, 0xF8, 0xFF, 0x1F, 0x00, 0x03, 0x02, 0x01,  //   zlib(filter 0 +
      0xFF, 0xE6, 0x77, 0x0B, 0xAE,                                            //   像素 0,0,255,255) + CRC
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,  // IEND
    ]);
    final ImageProvider provider = MemoryImage(bytes);

    // 2. resolve 是公开入口：同步返回一个 ImageStream。MemoryImage 的 key 是
    //    SynchronousFuture，返回时 completer 甚至已经挂上了（见 §4.1）
    final ImageStream stream = provider.resolve(ImageConfiguration.empty);

    // 3. 挂监听：首次解码是异步回调；缓存命中路径会收到 synchronousCall=true
    final ImageStreamListener listener = ImageStreamListener(
      (ImageInfo info, bool synchronousCall) {
        debugPrint('image ready ${info.image.width}x${info.image.height} '
            'sync=$synchronousCall bytes=${info.sizeBytes}');
        info.dispose();   // 协议：每个监听者拿到的都是 clone，由持有者负责 dispose
      },
      onError: (Object error, StackTrace? stack) {
        debugPrint('error: $error');   // 解码失败时 completer 是 _ErrorImageCompleter（见 §4.2）
      },
    );
    stream.addListener(listener);

    // 4. 等这条异步链走完（解码在引擎线程，一个真实的 delay 就能等到它）
    await Future<void>.delayed(const Duration(milliseconds: 100));

    // 5. 收尾：先退订（completer 的 _maybeDispose 靠"无监听者"触发），再驱逐缓存
    stream.removeListener(listener);
    await provider.evict();
  });
}
```

第 3 步的 `synchronousCall` 是这一层最容易被忽略的信息：**同一个 `addListener` 调用，可能是同步回调（缓存命中），也可能是以后某帧的异步回调**。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `image_provider.dart:359` | `abstract class ImageProvider<T extends Object>`，key 类型即泛型参数 |
| `image_provider.dart:375-376` | `@nonVirtual ImageStream resolve(ImageConfiguration)`，公开入口 |
| `image_provider.dart:471-505` | `_createErrorHandlerAndKey`，错误守卫与 key 的异步获取 |
| `image_provider.dart:525-565` | `resolveStreamForKey`，走 `ImageCache.putIfAbsent` |
| `image_provider.dart:633` / `:671` | `obtainKey` / `loadImage`，子类必须实现的两个方法 |
| `image_cache.dart:320-444` | `ImageCache.putIfAbsent`，四级查找 + 挂一个追踪 listener |
| `image_stream.dart:324` / `:346` / `:379` | `ImageStream` 与它的 `setCompleter` / `addListener`（暂存与转交） |
| `image_stream.dart:726-749` | `setImage`，唯一的推送出口 |
| `image_stream.dart:949` / `:1072-1114` | `MultiFrameImageStreamCompleter` 与它的单帧/多帧分叉 |
| `painting/binding.dart:143-148` | `instantiateImageCodecWithSize`，**与 `dart:ui` 的唯一接口** |
| `widgets/image.dart:1197` / `:1241` | `_ImageState._resolveImage` 与 `_handleImageFrame`（Widget 侧） |

## 四、调用链

### 4.1 第一跳：`resolve` 只做三件事

```dart
// image_provider.dart:375-412（节选）
@nonVirtual
ImageStream resolve(ImageConfiguration configuration) {
  final ImageStream stream = createStream(configuration);      // 1. 造空 stream
  _createErrorHandlerAndKey(                                  // 2. 要 key（可能异步）
    configuration,
    (T key, ImageErrorListener errorHandler) {
      resolveStreamForKey(configuration, stream, key, errorHandler);   // 3. 用 key 拿 completer
    },
    (T? key, Object exception, StackTrace? stack) async { ... },        // 错误回调
  );
  return stream;                                              // 4. 同步返回
}
```

**关键认知**：`resolve` 的返回类型是 `ImageStream`，**不是 `Future`**。当 key 是普通异步 `Future`（`NetworkImage`、`AssetImage`）时，它在完成"取 key"之前就返回了一个空壳 stream，真正的 completer 稍后通过 `stream.setCompleter` 塞进去——那时 listener 可能已经挂在 stream 上了，这就是 `ImageStream` 需要"暂存 listener 列表"的原因。但**这不是唯一形态**：`MemoryImage`、`FileImage`、`ResizeImage` 的 `obtainKey` 返回 `SynchronousFuture`（`image_provider.dart:1695` / `:1601` / `:1445-1450`），而 `SynchronousFuture.then` 是同步执行的，于是 `resolveStreamForKey` → `putIfAbsent` → `setCompleter` 在 `resolve` 返回之前就跑完了——调用方拿到的 stream **可能已经带着 completer**（用上面 Demo 的 `MemoryImage` 就能验证：`resolve` 返回后立刻读 `stream.completer`，已经非 null）。

### 4.2 第二跳：错误路径也产出 completer

`_createErrorHandlerAndKey`（`image_provider.dart:471-505`）把同步异常和异步异常收进同一个 `handleError`，用 `didError` 保证只报一次。错误回调里有一行必须注意：

```dart
// image_provider.dart:386 起
await null; // wait an event turn in case a listener has been added to the image stream.
...
if (stream.completer == null) {
  stream.setCompleter(_ErrorImageCompleter());
}
```

**`await null` 显式等一个事件轮**：如果 `obtainKey` 同步抛错，`handleError` 会被同步调用，此时调用方还没来得及 `stream.addListener(...)`；等一轮之后 listener 才挂上。而 `_ErrorImageCompleter` 的存在是因为 `stream.setCompleter` 只能调一次（有 `assert(_completer == null)`）——**错误必须伪装成一个 completer 塞进去，不能让 stream 停在"永远不完成"的状态。**

### 4.3 第三跳：`ImageCache.putIfAbsent` 的四级查找

```dart
// image_provider.dart:543-564（节选）
final ImageStreamCompleter? completer = PaintingBinding.instance.imageCache.putIfAbsent(
  key,
  () {
    ImageStreamCompleter result = loadImage(
      key,
      PaintingBinding.instance.instantiateImageCodecWithSize,   // ← 解码回调
    );
    ...
    return result;
  },
  onError: handleError,
);
if (completer != null) {
  stream.setCompleter(completer);
}
```

**`loadImage` 只在缓存未命中时被调用。** 这是整条链里唯一"真的去加载"的位置。

`ImageCache` 内部有三张表：

```dart
// image_cache.dart:87-93
final Map<Object, _PendingImage> _pendingImages = <Object, _PendingImage>{};
final Map<Object, _CachedImage> _cache = <Object, _CachedImage>{};
/// Unlike _cache, the [_CachedImage] for this may have a null byte size.
final Map<Object, _LiveImage> _liveImages = <Object, _LiveImage>{};
```

`putIfAbsent` 按顺序查这四层：

```dart
// image_cache.dart:330-386（节选）
ImageStreamCompleter? result = _pendingImages[key]?.completer;
if (result != null) {
  return result;                    // 1. 正在加载 → 直接复用，不重复请求
}
final _CachedImage? image = _cache.remove(key);
if (image != null) {
  _cache[key] = image;              // 2. 已缓存 → 移到 LRU 头部（remove 再插入）
  return image.completer;
}
final _LiveImage? liveImage = _liveImages[key];
if (liveImage != null) {
  _touch(key, ..., ...);
  return liveImage.completer;       // 3. 有活跃对象在用 → 提升为缓存项
}
try {
  result = loader();                // 4. 未命中 → 真的加载
} catch (error, stackTrace) {
  onError != null ? onError(error, stackTrace) : rethrow;
  return null;
}
```

四级顺序很关键：**`_pendingImages` 优先于 `_cache`**。所以同一张图在解码完成前被第二次请求时，第二个请求拿到的是**同一个 `ImageStreamCompleter` 实例**，不会发起第二次解码。

第 4 级之后它还给新 completer 挂了一个自己的 listener（`image_cache.dart:401-443`）。这个 listener 的 `info.dispose()` 与 `pendingImage.removeListener()` 两行说明了它的性质：**它不是为了给别人用的**，只为在加载完成时拿到 `sizeBytes`，好把缓存项放进 LRU 并做容量淘汰；拿到之后立刻退订。

**关键认知**：`ImageCache` 只是"借看一眼就退订"——因为 `putIfAbsent` 的调用方（`resolveStreamForKey`）随后会把同一个 completer 交给它的 stream，真正的监听者是上层。**`_pendingImages` 这张表存在的唯一理由，就是让"还在解码"这个状态可以被第二次请求看到。**

### 4.4 第四跳：`ImageStream` 的暂存与转交

```dart
// image_stream.dart:346-356（setCompleter）
void setCompleter(ImageStreamCompleter value) {
  assert(_completer == null);
  _completer = value;
  if (_listeners != null) {
    final List<ImageStreamListener> initialListeners = _listeners!;
    _listeners = null;
    _completer!._addingInitialListeners = true;
    initialListeners.forEach(_completer!.addListener);   // 转交暂存的 listener
    _completer!._addingInitialListeners = false;
  }
}

// image_stream.dart:379-385（addListener）
void addListener(ImageStreamListener listener) {
  if (_completer != null) {
    return _completer!.addListener(listener);   // 有 completer 就转发
  }
  (_listeners ??= <ImageStreamListener>[]).add(listener);   // 否则暂存
}
```

`ImageStream` 本身**几乎不做事**：它只是一个 `_completer` 加一个暂存列表。`setCompleter` 只能调一次（`assert(_completer == null)`）。

`_addingInitialListeners` 这个标志参与决定回调的 `synchronousCall` 参数——注意代码里是**取反**：

```dart
// image_stream.dart:511-518
/// Whether the future listeners added to this completer are initial listeners.
///
/// This can be set to true when an [ImageStream] adds its initial listeners to
/// this completer. This ultimately controls the synchronousCall parameter for
/// the listener callbacks. ...
bool _addingInitialListeners = false;

// image_stream.dart:539（ImageStreamCompleter.addListener 里）
listener.onImage(_currentImage!.clone(), !_addingInitialListeners);
```

**关键认知**：方向别搞反。`synchronousCall` 的定义是"回调是否发生在**你自己那次 `addListener` 调用的栈帧里**"（`ImageListener` 的文档，`image_stream.dart:244-249`）。由此分两种情况：

- **直接 `addListener` 到一个已有当前图的 completer**（缓存命中路径，§4.5 的"回灌"）：`_addingInitialListeners` 是默认的 false，`!false = true`，收到 `synchronousCall = true`。
- **`setCompleter` 转交暂存 listener**：转交期间 `_addingInitialListeners` 被设为 true（`image_stream.dart:352-354`），`!true = false`——即使 completer 里已经有图，这批 listener 也收到 `synchronousCall = false`，因为回调发生在稍后的 `setCompleter` 里，不在它们当初调 `addListener` 的那个栈帧里。

`_wasSynchronouslyLoaded`（§4.7）记录的是前一种真正的同步命中，也就是"首帧是否在第一次 build 时就同步可见"——这决定了 Widget 需不需要为尺寸变化做一次额外的布局。

### 4.5 第五跳：`ImageStreamCompleter` 的立即回灌与唯一出口

```dart
// image_stream.dart:534-570（节选）
void addListener(ImageStreamListener listener) {
  _checkDisposed();
  _listeners.add(listener);
  if (_currentImage != null) {
    try {
      listener.onImage(_currentImage!.clone(), !_addingInitialListeners);
      _ephemeralErrorListeners.remove(listener.onError);
    } catch (exception, stack) {
      reportError(...);
    }
  } else if (_currentError != null) {
    ...
  }
}
```

**如果当前已经有图，新 listener 立刻被回调一次**——这个"回灌"是缓存命中路径能同步返回的原因。注意 `_currentImage!.clone()`：**每个 listener 拿到的是自己的 `ImageInfo` 副本**，因为 `ImageInfo` 的契约是"持有者负责 `dispose`"（`image_stream.dart:376-377`）。

而推送新帧只有一个出口：

```dart
// image_stream.dart:723-749（节选）
void setImage(ImageInfo image) {
  _checkDisposed();
  _currentImage?.dispose();          // 1. 先释放旧的
  _currentImage = image;             // 2. 再存新的
  _ephemeralErrorListeners.clear();
  if (_listeners.isEmpty) {
    return;                          // 3. 没有 listener 就到此为止
  }
  // Make a copy to allow for concurrent modification.
  final localListeners = List<ImageStreamListener>.of(_listeners);
  for (final listener in localListeners) {
    try {
      listener.onImage(image.clone(), false);
    } catch (exception, stack) {
      reportError(...);              // 4. 单个 listener 抛错不中断其它
    }
  }
}
```

四个细节：

1. **先释放旧的 `_currentImage`**，再存新的。
2. **`_listeners` 被复制一份再遍历**（"Make a copy to allow for concurrent modification"）——listener 在回调里可能会 `removeListener`。
3. **单个 listener 抛错不会中断其它 listener**，错误被 `reportError` 收走。而且 `setImage` 标了 `@pragma('vm:notify-debugger-on-exception')`——这是让调试器能在异常点暂停的提示。

### 4.6 第六跳：`MultiFrameImageStreamCompleter` 的单帧与多帧分叉

`loadImage` 的实际返回值几乎总是 `MultiFrameImageStreamCompleter`：

`MultiFrameImageStreamCompleter` 的构造函数（`image_stream.dart:968-1003`）只做两件事：把 `codec` 这个 `Future<ui.Codec>` 挂上 `.then(_handleCodecReady)`，以及在有 `chunkEvents` 时订阅加载进度。也就是说**它构造时就发起解码**，完成时进 `_handleCodecReady`（`:1021-1028`）——那里有一句 `if (hasListeners)` 才继续解码，**没有 listener 就不解码**。

解码与发射在 `_decodeNextFrameAndSchedule` 里，单帧与多帧在此分叉：

```dart
// image_stream.dart:1072-1113（节选）
Future<void> _decodeNextFrameAndSchedule() async {
  _nextFrame?.image.dispose();
  _nextFrame = null;
  try {
    _nextFrame = await _codec!.getNextFrame();
  } catch (exception, stack) {
    reportError(context: ErrorDescription('resolving an image frame'), ...);
    return;                       // 解码失败
  }
  if (_codec == null) {
    return;                       // codec 在 getNextFrame 期间被释放
  }
  if (_codec!.frameCount == 1) {
    if (!hasListeners) {
      return;                     // 解码期间 listener 全被移除，不再发射
    }
    _emitFrame(ImageInfo(image: _nextFrame!.image.clone(), scale: _scale, ...));
    _nextFrame!.image.dispose();
    _nextFrame = null;
    _codec?.dispose();            // 单帧：解完就把 codec 释放掉
    _codec = null;
    return;
  }
  _scheduleAppFrame();            // 多帧：继续排下一帧
}
```

发射只有两行（`image_stream.dart:1124-1127`）：`setImage(imageInfo)` 加 `_framesEmitted += 1`。

**关键认知**：**单帧图片解码完就销毁 `Codec`**（`_codec?.dispose(); _codec = null;`），只有 `frameCount > 1` 才会进排帧循环。所以"静态图的 codec 不会长期占内存"不是优化，是这段分叉的必然结果。而 `_emitFrame` 里 `_nextFrame!.image.clone()` 之后立刻 `dispose()` 原图——**cloned 出去的 `ImageInfo` 由 `setImage` 的下游负责释放**。

### 4.7 第七跳：Widget 侧的接线

`Image` Widget 的 `_ImageState` 在 `didChangeDependencies` 里触发 `_resolveImage`：

`_ImageState._resolveImage`（`widgets/image.dart:1197-1211`）做两件事：把 `widget.image` 包进 `ScrollAwareImageProvider`，再用 `createLocalImageConfiguration` 造配置去 `resolve`。两个要点：

1. `ScrollAwareImageProvider` 是 `Image` 自己加的一层装饰——让"正在快速滚动的列表里图片延迟加载"。它不是新的 provider 类型。
2. `createLocalImageConfiguration` 里 `size` **只有在 `width` 和 `height` 都显式给了才填**。这个 `size` 会被 `ResizeImage` 之类的 provider 用来决定解码目标尺寸。

`_updateSourceStream`（`widgets/image.dart:1278-1302`）处理"同 key 就什么都不做"：`_imageStream?.key == newStream.key` 时直接 return，不换 stream、不重设 listener；换 stream（key 变了）时若 `gaplessPlayback` 为 false 会先 `setState` 把旧图清空，并且把 `_frameNumber` 与 `_wasSynchronouslyLoaded` 一并复位（`widgets/image.dart:1293-1297`）。

`_handleImageFrame` 里记录了 `synchronousCall`：

```dart
// widgets/image.dart:1241-1253（节选）
void _handleImageFrame(ImageInfo imageInfo, bool synchronousCall) {
  setState(() {
    _replaceImage(info: imageInfo);
    _loadingProgress = null;
    _lastException = null;
    _lastStack = null;
    _frameNumber = _frameNumber == null ? 0 : _frameNumber! + 1;
    _wasSynchronouslyLoaded = _wasSynchronouslyLoaded | synchronousCall;
  });
  if (_isPaused) {
    _stopListeningToStream(keepStreamAlive: true);
  }
}
```

**`_wasSynchronouslyLoaded` 在单个 stream 的生命周期内是单向累积的**（`_handleImageFrame` 里用 `|` 合并，只升不降），但**换 stream 时会被复位**——`_updateSourceStream` 在 key 变化时把它设回 false（`widgets/image.dart:1296`），新图重新开始判定。它与 §4.4 的同步命中路径串联起来，构成"这张图是不是在这个 stream 上第一次挂监听时就同步拿到"的完整判据，`frameBuilder` 靠它决定要不要跳过淡入（`widgets/image.dart:1437`）。

## 五、核心对象：四个类的职责分工

| | `ImageProvider<T>` | `ImageCache` | `ImageStream` | `ImageStreamCompleter` |
|---|---|---|---|---|
| 声明位置 | `image_provider.dart:359` | `image_cache.dart:86` | `image_stream.dart:324` | `image_stream.dart:480` |
| 身份键 | **key 就是泛型参数 `T`** | 用 `Object key` | 无 | 无 |
| 记得什么 | 无状态（配置从参数来） | 三张表（pending / cache / live） | `_completer` + 暂存 listener 列表 | `_listeners` + `_currentImage` + `_currentError` |
| 谁创建它 | 用户代码 | `PaintingBinding.createImageCache()` | `ImageProvider.createStream` | `ImageProvider.loadImage` |
| 生命周期 | 无（可随意重建，`==` 靠 `obtainKey`） | 全局单例 | 每次 `resolve` 一个 | 由 `ImageCache` 与所有 stream 共享 |
| 负责去重 | **不负责** | **负责** | 不负责 | 不负责 |
| 负责推送 | 不负责 | 不负责 | 转发 | **负责** |
| 必须 `dispose` | 否 | 否（有 `clear()`） | 否 | 是（`maybeDispose`） |
| 子类必须实现 | `obtainKey` + `loadImage` | — | — | `setImage` 的调用时机 |

**关键认知**：`ImageProvider` **无状态**是刻意的——只有无状态，`ImageCache` 才能用 `obtainKey` 的结果作为唯一身份。所以 `ImageProvider` 的相等性由子类决定（`MemoryImage` 比 `bytes`，`NetworkImage` 比 `url` + `scale`）。**两个"看起来一样"的 `ImageProvider` 实例能不能命中同一份缓存，完全取决于 `obtainKey` 是否返回相等的 key。**

一个实用的推论：`Image.network(url)` 每次 build 都新建一个 `NetworkImage`，但因为 `NetworkImage.operator ==` 和 `hashCode` 都基于 `url` 和 `scale`，`resolve` 的整条链上不会重复解码。**`ImageProvider` 的 `==` 就是缓存的命中率。**

## 六、源码实验

### 实验 1：同一张图二次 `resolve` 拿到同一个 completer（实测）

用一张 1x1 的 PNG，先后 `resolve` 两次并各挂一个 listener，再比较两个 stream 的 `completer`。

**预测**：`resolveStreamForKey` 里 `imageCache.putIfAbsent` 返回的是同一个 `ImageStreamCompleter`（`image_cache.dart:330-336` 的 `_pendingImages` 分支或 `:342-352` 的 `_cache` 分支），所以第二个请求不会触发第二次 `loadImage`。

**实际**（实测输出）：

```text
identical completer: true
syncA=false syncB=false
equals provider: true
```

两个 stream 的 `completer` 是同一个实例。`syncA`/`syncB` 都是 `false`——因为两个 listener 都是在**图片还没就绪时**挂上的，之后由 `setImage` 异步回调。

**说明**：这正是"`ImageProvider` 不负责去重"的含义——去重发生在 `ImageCache`，而 `ImageCache` 只认 `key`。所以我补了下面这个反面实验。

### 实验 2：内容相同但实例不同的 `MemoryImage` 会重复解码（实测，反直觉）

```dart
final p1 = MemoryImage(Uint8List.fromList(<int>[1, 2, 3]));
final p2 = MemoryImage(Uint8List.fromList(<int>[1, 2, 3]));   // 内容一样，实例不同
print('p1==p2: ${p1 == p2}');
final s1 = p1.resolve(ImageConfiguration.empty);
final s2 = p2.resolve(ImageConfiguration.empty);
await Future<void>.delayed(const Duration(milliseconds: 50));
print('s1.completer==s2.completer: ${s1.completer == s2.completer}');
```

**预测**：两个 `MemoryImage` 的字节内容完全一样，`MemoryImage` 应该按内容比较，所以 `p1 == p2` 为 true、命中同一份缓存。

**实际**（实测输出）：

```text
p1==p2: false
s1.completer==s2.completer: false
after delay: false
```

**`p1 == p2` 是 `false`，两个 stream 拿到的是两个不同的 completer。**

**说明**：源码依据是 `image_provider.dart:1722-1731`。`operator ==` 的核心一行是 `other is MemoryImage && other.bytes == bytes && other.scale == scale`，`hashCode` 是 `Object.hash(bytes.hashCode, scale)`。

它用的是 **`other.bytes == bytes`，而 `Uint8List` 没有覆写 `==`，走的是身份比较**。所以只有**同一个 `Uint8List` 实例**（或真正的同一个 `MemoryImage`）才相等。`Object.hash(bytes.hashCode, scale)` 同理——`Uint8List.hashCode` 也是身份哈希。

**实用结论**：`MemoryImage(bytes)` 传给两个不同 Widget 时，**必须复用同一个 `Uint8List` 实例**（比如把它存在 `State` 或全局常量里），否则每次 build 都会被认为是一张新图，反复解码。这正是 `ImageProvider` 文档在 `image_provider.dart:223-224` 强调的："It should be immutable and implement the `==` operator and the `hashCode` getter"——**缓存命中率完全由这个 `==` 决定**。

### 实验 3：`ImageStream` 在 `setCompleter` 之前暂存 listener（实测）

```dart
final stream = ImageStream();          // 裸 stream，没有 completer
print('completer=${stream.completer}');
stream.addListener(ImageStreamListener((info, sync) => print('got $info')));
print('after addListener: completer=${stream.completer}');
// 验证：此时 listener 没有被告知任何东西，因为它只是被暂存
```

**预测**：`ImageStream()` 的 `completer` 为 null（`image_stream.dart:334`），`addListener` 走 `_listeners ??= []` 分支（`:383-384`），不会有任何回调。

**实际**（实测输出）：

```text
completer before=null
after addListener: completer=null calls=0
```

两次 `completer` 都是 `null`，`calls = 0` —— listener 只是被放进了 `_listeners` 列表，没有任何回调。

**说明**：这个暂存机制解释了为什么 `ImageProvider.resolve` 可以同步返回 `ImageStream`——调用方拿到的可能是个还没有 completer 的空壳。**"`resolve` 返回了 stream"不等于"图片已经在加载"**：在 `obtainKey` 的 Future 完成之前，`loadImage` 根本还没被调用。

反过来说，`addListener` 的语义因此有两种：**有 completer 时是"订阅"**（可能立即回调），**没有 completer 时是"登记"**（只暂存）。这个差别连 `synchronousCall` 参数都表达不了，只能靠"有没有 completer"来判断。

### 实验 4：`Codec` 与解码都由 listener 驱动

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/painting
grep -n "hasListeners" image_stream.dart
grep -n "_codec?.dispose()\|_codec = null\|_codec!.frameCount" image_stream.dart
```

**预测**：如果 `Codec` 的存活与 listener 无关，这两条 grep 不应该在解码路径上给出有意义的命中。

**实际**（源码依据）：

- `hasListeners` 出现在三处关键路径上——`_handleCodecReady`（`:1025-1027`，没 listener 就不解码）、`_decodeNextFrameAndSchedule` 的单帧分支（`:1098-1100`）、`MultiFrameImageStreamCompleter.addListener`（`:1131-1133`）。
- 单帧分支走完 `_emitFrame` 后连着三行 `_nextFrame!.image.dispose(); _nextFrame = null; _codec?.dispose(); _codec = null;`（`:1106-1110`）；多帧分支只调 `_scheduleAppFrame()`，保留 `_codec`。

其中 `addListener` 的重写解决了一个具体竞态：

```dart
// image_stream.dart:1129-1135
@override
void addListener(ImageStreamListener listener) {
  if (!hasListeners && _codec != null && (_currentImage == null || _codec!.frameCount > 1)) {
    _decodeNextFrameAndSchedule();
  }
  super.addListener(listener);
}
```

**codec 就绪时没有 listener，解码被跳过；后来 listener 来了，必须有地方把解码重新踢起来**——这个重写就是那一脚。

**说明**：两点合起来说明"listener 驱动"不是比喻，是硬条件。**`Codec` 的存活时间还直接与"是不是动图"绑定**：静态图只需要一次 `getNextFrame()`，`Codec` 立刻可丢；动图必须留着它反复取帧。这就是 `MultiFrameImageStreamCompleter` 必须区分 `frameCount == 1` 的原因。

再往下看最后一道闸门：

```dart
// image_stream.dart:678-689
@mustCallSuper
void _maybeDispose() {
  if (_disposed || _listeners.isNotEmpty || _keepAliveHandles != 0) {
    return;
  }
  _ephemeralErrorListeners.clear();
  _currentImage?.dispose();
  _currentImage = null;
  _disposed = true;
  onDisposed();
}
```

**没有 listener、没有 keepAlive 句柄，整个 completer 直接释放**——包括已经解码好的 `_currentImage`。这是"图片内存不会无限增长"的最后一道闸门。

## 七、结论

1. 四个类的职责边界是：`ImageProvider` **只做 key ↔ completer 的翻译**（`obtainKey` + `loadImage`），`ImageCache` **只按 key 去重并管理容量**（四级查找：pending → cache → live → 真加载），`ImageStream` **只是 completer 的占位与暂存区**（`resolve` 必须同步返回），`ImageStreamCompleter` **才是推送方**（`setImage` 是唯一出口，`_currentImage` 就是"已有当前帧"的判据）。

   **这条边界的实际后果是：缓存命中率完全由 `ImageProvider.operator ==` 决定**。`MemoryImage.==` 用的是 `other.bytes == bytes`，而 `Uint8List` 的 `==` 是身份比较（`image_provider.dart:1727`）——所以"内容相同的两个 `Uint8List`"算两张不同的图。同理，`FileImage` 靠 `file.path` + `scale`（`image_provider.dart:1643-1651`），`ExactAssetImage` 靠 `keyName` + `scale` + `bundle`（`:1857-1869`），`AssetImage` 靠 `keyName` + `bundle`（`image_resolution.dart:388-396`），`NetworkImage` 靠 `url` + `scale` + `headers`（`_network_image_io.dart:174-185`，Web 版在 `_network_image_web.dart:242-254`）。**注意 `FileImage` 比的是 `file.path` 字符串而不是 `File` 对象**——同样的路径写两次能命中同一份缓存；而 `MemoryImage` 比的是 `Uint8List` 身份，同样内容写两次命中不了。
2. 这条链的异步性集中在三处：`obtainKey` 返回 `Future`（所以 `resolve` 先返回空 stream）、`codec` 是一个 `Future<ui.Codec>`（所以可以"先挂 listener 后解码"）、`_decodeNextFrameAndSchedule` 用 `await _codec.getNextFrame()`（所以会出现"解码期间 listener 全被移除"的竞态）。每一处都有对应的守卫：`_createErrorHandlerAndKey` 的 `await null`、`hasListeners` 门槛、`if (_codec == null) return`。
3. "listener 驱动"是这一层的内存策略：**没有 listener 就不解码**（`_handleCodecReady`）、**单帧解完就销毁 `Codec`**、**没有 listener 且没有 keepAlive 就释放 `_currentImage`**。图片内存能收敛，靠的是这三道闸门而不是显式的清理调用。

一句话总结：**`ImageProvider` 只负责"配置变 key、key 变加载器"，去重靠 `ImageCache`、推送靠 `ImageStreamCompleter`、排帧靠 `MultiFrameImageStreamCompleter`——四个类各记一件事，这就是异步解码能被拆得这么细的原因。**

## 八、边界声明

- `ui.Image` / `ui.Codec` / `ImmutableBuffer` 的内部实现（解码算法、GPU 上传、`Image.clone` 的引用计数语义）属于引擎。本篇只到 `PaintingBinding.instantiateImageCodecWithSize` 这一跳为止。
- `PaintingBinding` 如何混入 `BindingBase` / `ServicesBinding`（为什么图片加载需要 `AssetBundle`）留到第七卷 `BindingBase` 之后的 services 篇；第一卷第七篇给了 `BindingBase` 的接线。
- `ResizeImage`（`image_provider.dart:1254`）与 `AssetImage` 的多倍图选择（`image_resolution.dart:236`）、`cacheWidth`/`cacheHeight` 的实际解码尺寸计算不做专题；本篇只在 §4.8 指出 `ImageConfiguration.size` 会流到那里。
- `ScrollAwareImageProvider` 的滚动延迟加载策略留到第十卷 `Scrollable` / `Viewport` 懒加载篇。
- `ImageChunkEvent` / `loadingBuilder` 的进度上报、`_network_image_io.dart` 与 `_network_image_web.dart` 的两个平台实现不做专题。
- `ImageCache` 的 LRU 淘汰算法（`_touch`、`_checkCacheSize`、`maximumSize` / `maximumSizeBytes` 的默认值 1000 / 100MB）、`ImageCacheStatus` 的四种状态、`keepAlive` 句柄机制本篇只给锚点，不展开。
