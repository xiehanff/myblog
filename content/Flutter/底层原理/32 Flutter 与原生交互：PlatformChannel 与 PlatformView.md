# Flutter PlatformChannel / PlatformView / Texture：和原生交互的底层机制

[toc]

## 概念总览

Flutter 和原生交互，实际上是两条不同的链路：

1. **消息链路**：传数据、传命令、收事件，典型入口是 `MethodChannel`、`EventChannel`、`BasicMessageChannel`
2. **合成链路**：把原生视图或原生产出的像素放进 Flutter 的渲染树里，典型入口是 `PlatformView`、`TextureLayer`、`TextureRegistry`

可以先记一个总原则：

- **Channel 解决“怎么通信”**
- **PlatformView / Texture 解决“怎么被画出来”**

这两类能力经常一起出现，但它们解决的问题不同。

| 能力 | 本质 | 典型用途 | 主要代价 |
| --- | --- | --- | --- |
| `MethodChannel` | 异步方法调用 | 一次性请求原生能力 | 序列化、线程切换、等待回包 |
| `EventChannel` | 异步事件流 | 传感器、位置、状态变化 | 订阅生命周期管理 |
| `BasicMessageChannel` | 异步消息收发 | 自定义协议、半结构化数据 | 编解码一致性 |
| `PlatformView` | 原生视图合成 | 地图、WebView、播放器、表单控件 | 合成成本、输入和层级权衡 |
| `TextureLayer` | 纹理到图层的映射 | 视频帧、相机帧、截图占位 | 只是像素，不是原生控件 |
| `TextureRegistry` | 后端纹理注册表 | 管理纹理 id 和生命周期 | 需要手动对齐释放与刷新 |

理解这两条链路，只需要对 Flutter 的分层渲染（Widget → Element → RenderObject → Layer）有基本印象即可，下文会从消息传递开始完整讲一遍。

---

## 核心流程

### 1. Dart 到原生：消息如何序列化和异步传递

Flutter 的消息通道底层都绕不开 `BinaryMessenger`：

```text
Dart 对象
  -> codec 编码
  -> BinaryMessenger 发送二进制消息
  -> 原生侧 handler 解码
  -> 异步执行平台逻辑
  -> 编码回包 / 推送事件
  -> Dart 侧 Future 或 Stream 完成
```

关键点有三个：

- **先编码成二进制**，再跨边界传输
- **再按 codec 解码回对象**
- **回包是异步的，不是同步函数调用**

这也是为什么平台通道并非“直接调 Java/OC 方法”，它实际是“把一个二进制消息交给另一侧处理，再等结果回来”。

### 2. `MethodChannel`：请求 - 响应

`MethodChannel` 用来发起一次性方法调用。

流程可以理解为：

1. Dart 侧调用 `invokeMethod`
2. 方法名、参数通过 `MethodCodec` 编码
3. 消息经 `BinaryMessenger` 发到原生侧
4. 原生侧 `setMethodCallHandler` / `handleMethodCall` 收到并处理
5. 原生侧返回成功结果、错误结果或未实现
6. Dart 侧的 `Future` 完成

官方文档明确了几点：

- `MethodChannel` 是**异步方法调用**
- 默认 codec 是 `StandardMethodCodec`
- 通道有**FIFO 顺序保证**
- 参数和返回值只能使用 codec 支持的值

### 3. `EventChannel`：事件流

`EventChannel` 适合持续事件，不适合一次性请求。

流程通常是：

1. Dart 侧第一次监听时，建立 broadcast stream
2. 框架向原生侧发送 `listen`
3. 原生侧 `onListen` 注册传感器、监听器、回调源
4. 原生侧通过 `EventSink` 持续推送事件
5. Dart 侧收到 data event 或 error event
6. 当最后一个监听者取消时，框架发送 `cancel`
7. 原生侧 `onCancel` 注销资源

这一点很重要：

- `EventChannel` 是**广播流**
- 只有监听数从 `0 -> 1` 才会激活
- 只有监听数从 `1 -> 0` 才会停掉

所以它天然带有“订阅 - 退订”的生命周期语义。

### 4. `BasicMessageChannel`：双向基础消息

`BasicMessageChannel` 更像一个通用消息管道，适合字符串、JSON、二进制和自定义半结构化消息。

它的特点是：

- **双向**
- **异步**
- **由 `MessageCodec` 决定消息格式**
- **同样有 FIFO 顺序保证**

和 `MethodChannel` 的区别在于：

- `MethodChannel` 强调“方法调用 + 结果”
- `BasicMessageChannel` 强调“消息收发 + 自定义编解码”

### 5. `PlatformView`：不是“嵌入控件”这么简单

`PlatformView` 要处理的是把**原生视图树**放进 Flutter 的**合成链路**里，而不只是把原生控件塞进来。

它要解决的是：

- 原生视图如何出现在 Flutter 页面里
- 层级怎么和 Flutter 内容一起排
- 输入事件怎么和原生焦点/手势一起处理
- 原生视图与 Flutter 内容如何做裁剪、透明度、变换和遮罩

因此，`PlatformView` 更接近“合成策略”，而不是“普通 Widget”。

### 6. `Texture` / `TextureLayer`：把像素接进 Flutter

`Texture` 这条路解决的是“原生已经产出了像素，Flutter 怎么把这些像素画出来”。

流程可以理解为：

1. 原生侧创建并注册后端纹理
2. `TextureRegistry` 返回一个纹理 id
3. Flutter 侧用 `Texture` / `TextureLayer` 引用这个 id
4. 后端每次有新帧时通知 Flutter
5. `TextureLayer` 在图层树里被重新合成

`TextureLayer` 和 `PlatformView` 的差异非常关键：

- `TextureLayer` 只是一个**纹理图层**
- `PlatformView` 是一个**原生视图参与合成**

前者更像“贴一张会动的图”，后者更像“真的把原生视图放进来”。

---

## 关键对象/接口

### `BinaryMessenger`

`BinaryMessenger` 是通道底层的消息管道，负责二进制消息收发。

官方文档有几个要点：

- 它以**二进制消息**做异步传递
- 同一个实例应尽量保持**单线程使用**
- 支持后台 `TaskQueue`
- 可以缓存尚未注册 handler 时收到的消息

这意味着：

- `BinaryMessenger` 不是业务 API，但它决定了通道的实际传输方式
- handler 的线程模型不能随意乱切

还有两个线程相关的关键事实（见[官方线程说明](https://docs.flutter.dev/platform-integration/platform-channels#channels-and-platform-threading)）：

- **原生侧的回调发生在平台主线程**：Android 是主线程（main looper），iOS 是主线程（main thread / main dispatch queue）。所以原生 handler 里不要做耗时操作，需要时就切到原生工作线程，再异步回包
- **后台 isolate 不能直接用普通通道**：普通 channel 绑定在 root isolate 上；如果你在 `Isolate.spawn` 出来的 isolate 里要与平台通信，需要用 [`BackgroundIsolateBinaryMessenger`](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html)

### `MethodChannel`

适合“问一次、答一次”的场景，比如：

- 获取设备信息
- 调原生能力
- 触发一次相机/定位/文件操作

注意点：

- `invokeMethod<T>` 返回的是 `Future<T?>`
- 支持的参数和返回值受 `StandardMessageCodec` 约束
- 不支持随便塞任意 Dart 对象
- 复杂集合通常要先转成可编码结构，再在 Dart 侧显式 cast

### `StandardMethodCodec` / `StandardMessageCodec`

这两个是消息序列化的核心。

可以这么理解：

- `StandardMethodCodec` 负责“方法调用 + 返回包裹”
- `StandardMessageCodec` 负责“值怎么编码成二进制”

`StandardMessageCodec` 支持的典型值包括：

- `null`
- `bool`
- 数字
- `String`
- `Uint8List` / `Int32List` / `Int64List` / `Float32List` / `Float64List`
- `List`
- `Map`

官方文档也提醒了一个常见坑：

- 解码出来的容器通常是泛型不确定的 `List<Object?>` / `Map<Object?, Object?>`
- 不要指望它自动变成你写死的 `Map<String, String>`

### `EventChannel`

适合持续推送事件，比如：

- 传感器
- 网络状态
- 音频播放状态
- 原生播放器进度

它的核心是“管理一个可订阅流”，而不只是“发消息”。

要点：

- `receiveBroadcastStream()` 返回广播流
- 第一个监听者触发原生 `listen`
- 最后一个取消触发原生 `cancel`
- 原生侧应该在 `onListen` 注册资源，在 `onCancel` 释放资源

### `BasicMessageChannel`

适合你想自己定义协议的时候。

比如：

- 发送 JSON
- 发送字符串命令
- 发送二进制块
- 传递半结构化数据

它和 `MethodChannel` 的区别：

- `MethodChannel` 更像“接口调用”
- `BasicMessageChannel` 更像“消息总线”

### `PlatformView` / `PlatformViewFactory` / `PlatformViewRegistry`

平台视图的典型结构是：

- Dart 侧创建平台视图 Widget（Android 是 `AndroidView`，iOS 是 `UiKitView`，或用更底层的 `PlatformViewLink` 按需创建和复用原生 view controller）
- 原生侧注册 view factory
- factory 创建具体原生视图
- 视图进入 Flutter 的合成体系

这里的重点在下面这些，而不在“谁创建了一个控件”：

- 这个控件如何和 Flutter 的层级一起合成
- 它会不会挡住 Flutter 内容
- 它会不会抢输入焦点
- 它的刷新和销毁是否和生命周期对齐

### `TextureRegistry`

`TextureRegistry` 是原生侧管理后端纹理的注册表。

它的作用是：

- 创建或注册纹理
- 返回一个纹理 id
- 让 Flutter 用这个 id 去渲染
- 管理纹理的生命周期和内存压力回调

官方文档里有几个要点值得记住：

- 纹理 id 只在当前 Flutter view 范围内有效
- deregister 之后，id 可能被复用
- 纹理更新后要通知 Flutter
- 纹理和 `TextureLayer` 是配套的

落到具体 API 上（以 Android 为例）：

- `createSurfaceTexture()` 返回一个 `SurfaceTextureEntry`，其中就包含要交给 Dart 侧的纹理 id
- 每帧像素就绪后，调用 entry 的 `markFrameAvailable()`，通知 Flutter 这块纹理有新帧可合成
- 不再使用时调用 `release()` 释放原生资源

iOS 侧对应的是让提供帧的对象实现 `FlutterTexture` 协议：新帧就绪时调用 `textureFrameAvailable`，引擎再通过协议方法取走像素数据。两端的共同模式都是“**原生产出像素 + 主动通知，Flutter 只负责把纹理画出来**”。

### `TextureLayer`

`TextureLayer` 是 Flutter 渲染树里的纹理层。

它的关键特征：

- 把一个后端纹理映射到一个矩形区域
- 一旦进入 layer tree，纹理层可以由后端自主刷新
- 通常不需要 Dart 继续参与每一帧
- 它是 layer tree 的叶子节点

这也是它和 `PlatformView` 的根本差异之一：

- `TextureLayer` 只负责“显示纹理”
- `PlatformView` 负责“嵌入原生视图并参与合成”

---

## 常见误区

### 1. 把 `PlatformView` 等同于“原生控件嵌入”

这是最常见的简化说法，但不完整。

更准确的说法是：

- `PlatformView` 是把原生视图纳入 Flutter 的合成链路
- 它涉及层级、输入、裁剪、透明度、z-order 和性能权衡

如果只把它理解成“嵌个原生控件”，很容易低估它的合成成本。

### 2. 把 `Texture` 当成 `PlatformView`

两者不是一回事。

- `Texture` 只是一块会被 Flutter 画出来的像素源
- `PlatformView` 是一个真实原生视图参与合成

如果你只需要视频帧、相机预览、截图占位，`Texture` 往往比 `PlatformView` 更轻。

### 3. 认为所有通道都能直接传任意对象

不行。

消息能传什么，取决于 codec。

典型问题包括：

- 自定义对象没有先转成可编码结构
- 以为 `Map<String, String>` 可以直接作为通用返回类型
- 没处理 `PlatformException` / `MissingPluginException`

### 4. 认为 `EventChannel` 可以替代 `MethodChannel`

不对。

- 要一次返回结果，用 `MethodChannel`
- 要持续推送数据，用 `EventChannel`

前者是请求 - 响应，后者是订阅 - 退订。

### 5. 不释放平台侧资源

`EventChannel` 和 `PlatformView` 都有明显的生命周期压力。

常见遗漏包括：

- 监听器只注册不注销
- `PlatformView` 销毁时不释放原生对象
- 纹理注销晚于视图销毁
- 页面退出后还继续推送事件

### 6. 低估平台视图的性能代价

平台视图不是免费的。

特别是 Android 端：

- 原生视图和 Flutter 内容需要额外合成，不同模式代价不同（详见后文“能不能随便叠加”）
- Texture Layer 模式下原生视图要渲染进纹理再上传给 Flutter 合成，快速滚动时容易抖动
- Hybrid Composition 模式下 raster 线程要与平台线程合并执行，Flutter 自身的渲染 FPS 会直接下降
- 一些变换、裁剪、叠加效果会有约束

如果页面里有复杂动画、快速滚动或大面积透明叠加，平台视图很容易暴露成本。

---

## 补充：用 Pigeon 生成类型安全的通道代码

手写 `MethodChannel` 有一个长期痛点：方法名是字符串，参数和返回值靠两侧人工对齐，改了一边漏了另一边，往往要到运行时才暴露。

官方对此给出的方案是 [Pigeon](https://pub.dev/packages/pigeon)：用 Dart 的一个子集写一份“只含声明”的协议文件，由它生成 Dart、Kotlin、Swift 等语言的通道代码。生成的代码底层仍走 `StandardMessageCodec`，但调用变成了类型安全的方法签名，不再需要手工匹配字符串，官方文档把它作为平台通道 API 的推荐替代（见 [Writing custom platform-specific code](https://docs.flutter.dev/platform-integration/platform-channels)）。

它值得引入的信号很明确：

- 通道数量多、参数结构复杂（嵌套对象、多端共享的数据模型）
- 多人协作，字符串协议容易失去同步
- 需要同时支持 Android / iOS（乃至 macOS / Windows）

如果只是两三个简单调用，手写 `MethodChannel` 仍然是最直接的方案，不必为单次使用引入代码生成流程。

---

## 面试问法/性能点

### 1. `MethodChannel`、`EventChannel`、`BasicMessageChannel` 怎么选？

可以这样答：

- 一次性请求原生结果，用 `MethodChannel`
- 原生持续推事件，用 `EventChannel`
- 想自己定义收发协议，用 `BasicMessageChannel`

### 2. Dart 到原生的消息为什么是异步的？

因为通道底层走的是二进制消息传递，不是同步函数调用。

消息要经过：

- codec 编码
- `BinaryMessenger` 发送
- 原生侧 handler 处理
- 再异步回包

所以 Dart 侧天然是 `Future` / `Stream` 模型。

### 3. 为什么 `PlatformView` 会拖慢性能？

核心原因在**合成代价**，跟“原生慢”没关系：

- Flutter 原本可以把自己的内容在独立渲染链路里高效合成
- 平台视图把原生世界带进来后，层级和合成边界变复杂
- Android 不同实现会引入额外纹理、缓冲或线程参与
- 大量平台视图会直接放大帧率波动

面试里可以补一句：

> 复杂动画期间，如果原生视图不需要实时交互，可以考虑用截图或占位纹理替代实时 `PlatformView`。

这也是官方文档给出的常见缓解思路。

### 4. `TextureLayer` 为什么通常比 `PlatformView` 轻？

因为它只是“像素到层”的映射：

- 不需要真实原生视图参与层级合成
- 不需要处理原生控件的复杂输入和焦点链路
- 后端刷新后，Flutter 直接重绘对应纹理层即可

### 5. `TextureRegistry` 的作用是什么？

**它负责在原生侧注册后端纹理，并把纹理 id 暴露给 Flutter 侧使用。**

这个 id 和当前 Flutter view 的生命周期绑定，不是全局永久的。

### 6. 能不能把平台视图和 Flutter 视图随便叠加？

不能。

能不能叠、怎么叠，取决于具体实现。按 [Android Platform Views 官方文档](https://docs.flutter.dev/platform-integration/android/platform-views)（截至 2026 年）：

- **Texture Layer Hybrid Composition（TLHC）** 是默认行为（`AndroidView` / `PlatformViewsService.initAndroidView`）：原生视图渲染成纹理后交给 Flutter 合成，Flutter 性能好、各种变换都生效；代价是快速滚动时可能抖动，`SurfaceView` 会丢失无障碍支持
- **Hybrid Composition（HC）** 用 `PlatformViewLink` + `AndroidViewSurface`（`initExpensiveAndroidView` / `initSurfaceAndroidView`）：原生视图直接进 Android 视图树，Flutter 内容画进 `ImageReader` 支撑的 `FlutterImageView` 里由系统合成，保真度和无障碍最好；代价是 raster 线程与平台线程合并，拉低 Flutter FPS
- **Hybrid Composition++（HCPP）** 是 Flutter 3.44 起的实验性新模式：Flutter 与原生视图各自渲染到系统 Surface，由 Android 的 SurfaceFlinger 直接合成，兼顾保真度与性能；要求 Android API 34+、Vulkan 和 Impeller，通过 `--enable-hcpp` 或 manifest 配置开启，条件不满足时自动回退
- 更早的 **Virtual Display** 模式已不再是官方文档列出的推荐路径，仅作为旧设备上的回退存在
- iOS 目前是 hybrid composition 语义，某些变换、透明度、遮罩、裁剪和无障碍行为同样有局限

### 7. 真正的性能点应该怎么看？

建议优先关注这几个维度：

- **序列化成本**：消息是否频繁且 payload 是否过大
- **线程切换成本**：是否在 UI 线程、平台线程之间来回跳
- **合成成本**：是否引入了平台视图边界
- **刷新成本**：纹理是否高频更新，是否阻塞主链路
- **生命周期成本**：注册、监听、销毁是否严格对齐

---

## 参考

### 官方文档

- [MethodChannel](https://api.flutter.dev/flutter/services/MethodChannel-class.html)
- [invokeMethod](https://api.flutter.dev/flutter/services/MethodChannel/invokeMethod.html)
- [EventChannel](https://api.flutter.dev/flutter/services/EventChannel/receiveBroadcastStream.html)
- [BasicMessageChannel](https://api.flutter.dev/flutter/services/BasicMessageChannel-class.html)
- [StandardMethodCodec](https://api.flutter.dev/flutter/services/StandardMethodCodec-class.html)
- [StandardMessageCodec](https://api.flutter.dev/flutter/services/StandardMessageCodec-class.html)
- [BinaryMessenger (Dart)](https://api.flutter.dev/flutter/services/BinaryMessenger-class.html)
- [BackgroundIsolateBinaryMessenger](https://api.flutter.dev/flutter/services/BackgroundIsolateBinaryMessenger-class.html)
- [Writing custom platform-specific code - Flutter docs](https://docs.flutter.dev/platform-integration/platform-channels)
- [TextureLayer](https://api.flutter.dev/flutter/rendering/TextureLayer-class.html)
- [TextureRegistry (Android)](https://api.flutter.dev/javadoc/io/flutter/view/TextureRegistry.html)
- [Android Platform Views - Flutter docs](https://docs.flutter.dev/platform-integration/android/platform-views)
- [iOS Platform Views - Flutter docs](https://docs.flutter.dev/platform-integration/ios/platform-views)
- [Pigeon - pub.dev](https://pub.dev/packages/pigeon)
- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
