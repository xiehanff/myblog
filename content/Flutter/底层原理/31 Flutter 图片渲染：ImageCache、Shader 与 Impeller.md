# Flutter ImageCache / 图片解码 / Shader / Impeller：首帧与渲染性能

[toc]

> 这篇笔记把“图片为什么慢、首帧为什么慢、动画第一次跑为什么卡”串成一条链路来看。
>
> 阅读前最好对 Flutter 的整体渲染管线（build → layout → paint → raster）和 UI 线程 / raster 线程的分工有基本认识；不熟悉的地方可以先跳过，不影响理解主线。本篇会把链路本身从零讲一遍。

## 概念总览

Flutter 里的图片性能，不是单点问题，而是一条完整链路：

`ImageProvider resolve -> ImageCache 查找 -> 获取/解码图片 -> 得到 ui.Image -> build/layout/paint -> raster -> GPU/屏幕呈现`

这条链路里，最容易拖慢首帧和渲染的，通常是三类事情：

- **图片缓存不命中**：每次都重新走加载和解码
- **解码尺寸过大**：缓存里存的是解压后的像素，内存和首帧都会被放大
- **shader 首次编译**：第一次用到某个 shader 时卡顿，尤其是在动画首次运行时更明显

要注意，`ImageCache`、图片解码、shader 编译和首帧显示，分别属于不同层：

- `ImageCache` 主要是 **框架层内存缓存**
- 图片解码主要是 **ImageProvider / 引擎解码链路**
- shader 编译和绘制主要落在 **raster / GPU 侧**
- Impeller 的核心价值，是把一部分过去会在运行时发生的 shader 工作前移到构建期

## 核心流程

### 1. 图片从 `ImageProvider` 开始解析

`Image` 组件并不是直接拿“图片文件”去画，而是先通过 `ImageProvider` 解析出一个可缓存的 key，再走后续加载流程。

官方文档里，`ImageProvider.resolve` 的流程大致是：

1. 创建 `ImageStream`
2. 调用 `obtainKey`
3. 通过 `resolveStreamForKey`
4. 命中 `ImageCache` 就直接复用
5. 没命中才调用 `loadImage` 取字节并解码

这里最关键的是：**key 的一致性决定缓存命中**。只要 `ImageProvider` 生成的 key 一样，就可以命中同一份缓存，不要求一定是同一个对象实例。

### 2. `ImageCache` 命中后直接复用

`ImageCache` 是一个全局的 LRU 图片缓存，默认大致是：

- 最多 1000 张（`maximumSize`）
- 最多 100 MiB（`maximumSizeBytes`，即 `100 << 20` 字节）

它内部其实是三张表：

- `_cache`：已完成解码的图像，按 LRU 淘汰
- `_pendingImages`：正在加载/解码中的请求，避免同一个 key 被重复发起
- `_liveImages`：仍被 `ImageStream` 监听者持有的图像，普通淘汰不会真正释放它们

常用入口和工具方法：

- `putIfAbsent` 是主要入口
- `containsKey` 可以判断是否已经在缓存里
- `statusForKey` 适合调试
- `clear()` 只清空 `_cache` 里已完成的条目；**不会**移除还在加载中的 pending 请求（它们完成后仍会照常入缓存），也不清 live 引用
- `evict(key)` 才会按 key 逐项移除，pending、缓存条目和（默认含）live 引用都会被清掉
- `clearLiveImages()` 会单独清掉 live 引用

所以，图片慢不一定是“网络慢”，也可能是：

- key 不一致，导致重复解码
- 图片太大，缓存里撑不住
- live 引用太多，释放不及时

### 3. 解码尺寸决定内存峰值

`cacheWidth/cacheHeight` 的作用，核心是 **告诉引擎按目标尺寸解码并存储**，而不是先解码成原图再缩放显示。

这件事很重要，因为 Flutter 图片通常是按 **解压后的像素数据** 占内存的，不是按压缩文件大小占内存。

因此：

- 2000x2000 的图，哪怕屏幕只显示一小块，若按原尺寸解码，内存仍然会很高
- 用 `cacheWidth/cacheHeight` 或 `ResizeImage`，可以显著降低内存峰值
- 它影响的是 **解码尺寸和缓存尺寸**，不是 Widget 的布局尺寸

也就是说，UI 里最终显示多大，和“解码成多大”是两回事。

### 3.1 为什么大图列表会卡：Raster 和 `ResizeImage`

这里的 `Raster`，指的是 Flutter 渲染链路里的 **Raster 线程**，也就是把已经准备好的场景真正“画成像素”的那一段。

它主要负责的不是 `build` 或 `layout`，而是：

- 接收 `LayerTree` / `Scene`
- 执行栅格化，把绘制内容变成 GPU 可提交的像素
- 处理纹理上传、合成和最终帧输出

所以，当网络图片列表里同时出现很多大图时，卡顿通常不是因为 Widget 构建太慢，而是因为：

- 图片解码太大
- 纹理上传太重
- Raster 线程一帧内要处理的像素工作过多

这时就算网络已经下载完了，界面也还是可能卡在“把图真正画出来”这一步。

`ResizeImage` 的作用，就是在 **不改变 UI 显示尺寸** 的前提下，给图片加载链路一个更小的解码目标。

它的核心价值是：

- 让图片按目标尺寸解码，而不是按原图尺寸全量解码
- 降低内存占用
- 降低纹理上传成本
- 减少 Raster 线程每帧要处理的数据量

简单说：

- `ResizeImage` 解决的是“图片该按多大解码”
- 不是“图片在界面上显示多大”

如果列表项只有 80x80，但后端下发的是 2000x2000 的大图，就应该优先让解码尺寸靠近实际展示尺寸。常见写法可以是：

```dart
ResizeImage(
  NetworkImage(url),
  width: 160,
  height: 160,
)
```

或者在 `Image.network` 里使用 `cacheWidth` / `cacheHeight`，本质上也是同一类优化思路。

这类优化最适合：

- 大量网络图片列表
- 固定尺寸缩略图
- 首屏图片墙
- 滚动过程中持续加载图片的场景

不适合的情况是：

- 需要保留原图细节的预览页
- 图片会被放大查看的场景
- 业务后续还要拿原图做二次处理

### 4. 首帧慢不只看 build，还要看 raster

首帧是否真正完成，不能只看 `runApp()` 或 build 是否返回。

更准确地说，要等：

`build -> layout -> paint -> raster`

官方把“第一帧已经被引擎 rasterize”作为一个重要指标，对应 `WidgetsBinding.instance.firstFrameRasterized`。

因此首帧慢常见来源包括：

- `main()` 里做了太多同步工作
- 首屏同时加载了大图
- 首屏触发了首次 shader 编译
- 首屏布局/绘制太重

### 5. Shader 首次使用会造成 jank

当某个 shader 第一次被用到时，运行时可能需要编译。DevTools 的 Performance view 会把这类帧标成深红色。

这就是为什么有些动画“第一次播放最卡，后面就顺了”：

- 不是动画逻辑变快了
- 而是首次 shader 编译的成本已经付过了

这类问题要从 raster 侧看，而不是只盯着 Dart 侧 build。

历史上针对 Skia 后端的缓解手段是 **SkSL warm-up**：在真机上用 `--cache-sksl` 收集应用用到的 shader，打包进应用后在启动时预热。但要注意，**这套机制只对 Skia 有效**——Impeller 不使用 Skia，shader 已在引擎构建期全部预编译，自然也不需要 SkSL 缓存；Flutter 工具链后来干脆移除了 `--cache-sksl`。所以在 Impeller 已默认启用的版本里，官方给出的答案就是“直接用 Impeller”，而不是继续折腾 SkSL 预热（参见 [flutter/flutter#140310](https://github.com/flutter/flutter/issues/140310)）。

### 6. Impeller 的职责

Impeller 不是“某些平台更快的另一个渲染器”这么简单，它的目标是把图形管线做成 **更可预测** 的运行时：

- 在引擎构建期预编译更小、更简单的一组 shader
- 预先构建 pipeline state objects
- 降低运行时首次 shader 编译带来的抖动

按 [Impeller 官方文档](https://docs.flutter.dev/perf/impeller)的当前说明（截至 2026 年）：

- **iOS**：Impeller 是唯一支持的渲染后端，已无法切换回 Skia
- **Android**：自 Flutter 3.27 起默认启用（要求 Vulkan，即 Android API 29+）；更低版本或不支持 Vulkan 的设备会自动回退到 Skia 的 OpenGL 渲染器，无需手动处理
- **macOS / Windows / Linux**：自 Flutter 3.47 起默认启用，官方已预告未来版本将移除关闭选项
- **Web**：仍使用 Skia 渲染（未来可能切换）

所以，Impeller 的重点是 **减少运行时不可预测成本**，尤其是首帧和首次动画阶段的 shader 抖动，而不是简单地“到处都更快”。

## 关键对象/接口

### `ImageCache`

关注点：

- `maximumSize` / `maximumSizeBytes`
- `putIfAbsent`
- `containsKey`
- `statusForKey`
- `clear()`
- `clearLiveImages()`
- `evict()`

理解重点：

- 它是全局内存缓存，不是磁盘缓存
- live image 不会因为普通 eviction 立刻完全释放
- 缓存命中能显著降低重复解码和首屏波动

### `ImageProvider<T>`

关注点：

- `resolve()`
- `obtainKey()`
- `resolveStreamForKey()`
- `loadImage()`

理解重点：

- key 必须稳定、可比较
- key 里通常要包含分辨率、scale、配置等信息
- `resolve()` 会帮你把错误处理和缓存接起来

### `Image`

关注点：

- `Image.asset`
- `Image.network`
- `Image.file`
- `Image.memory`
- `cacheWidth`
- `cacheHeight`

理解重点：

- `cacheWidth/cacheHeight` 会影响解码尺寸
- 它们不改布局尺寸，只影响图片实际解码后占用的内存
- 适合大图缩略、列表头像、首屏封面这类场景

### `ResizeImage`

关注点：

- `ResizeImage.resizeIfNeeded`
- `ResizeImage(...)`

理解重点：

- 只有提供了 `cacheWidth` 或 `cacheHeight`，才会包一层 `ResizeImage`
- 它本质上是把“目标尺寸”传给解码链路

### `WidgetsBinding.instance.firstFrameRasterized`

关注点：

- 用来判断首帧是否已经被引擎 rasterize

理解重点：

- 首帧完成不等于 build 完成
- 真实的首帧指标要看整条渲染链路

### `FrameTiming` 和 DevTools Performance view

关注点：

- `buildDuration`
- `rasterDuration`
- shader compilation 标记

理解重点：

- build 慢通常是 Dart/UI 侧问题
- raster 慢通常是图片、shader、合成、阴影、clip、opacity 等问题
- 首次动画卡顿，优先怀疑 shader 编译和 raster 压力

## 常见误区

- **误区 1：ImageCache 是磁盘缓存**
  - 不是。这里讨论的是框架侧内存缓存。

- **误区 2：`cacheWidth/cacheHeight` 只是“显示时缩放”**
  - 不是。它们会影响解码后的缓存尺寸，直接关系到内存。

- **误区 3：同一个 `ImageProvider` 实例才会命中缓存**
  - 不是。关键是 key 一致。

- **误区 4：图片加载慢就一定是网络慢**
  - 不一定。也可能是解码太大、缓存策略不合适、或首帧链路被别的工作阻塞。

- **误区 5：shader 卡顿只会出现在复杂图形页**
  - 不一定。首次出现某种效果时，简单动画也可能因为 shader 首次编译而卡一下。

- **误区 6：Impeller 只是“比 Skia 更快”**
  - 这说法太粗糙。更准确是：Impeller 通过构建期预编译 shader 和更可预测的管线，减少运行时抖动；但它的支持平台和回退路径是有边界的。

- **误区 7：首帧只看 `build`**
  - 不够。首帧慢要同时看 `buildDuration`、`rasterDuration` 和图片/Shader 工作。

## 面试问法/性能点

### 常见面试问法

- `ImageProvider` 是怎么命中缓存的？
- `ImageCache` 的 key 是什么，为什么不是看对象实例？
- `cacheWidth/cacheHeight` 为什么能降内存？
- `precacheImage` 适合什么场景？
- 为什么某个动画第一次播放会卡，后面正常？
- `firstFrameRasterized` 和 `build` 完成有什么区别？
- Impeller 和 Skia 的关系是什么？它解决的核心问题是什么？

### 性能排查要点

- 首屏大图多时，优先检查 `cacheWidth/cacheHeight` 是否合理
- 列表图频繁闪烁或重复下载时，先看 key 是否稳定、是否有预热
- 首次动画卡顿时，优先看 shader compilation 标记
- 只要是首帧慢，就不要只盯着 Dart 代码，还要看 raster 和 GPU 侧
- 需要提前展示的图片，可以用 `precacheImage` 预热
- 需要看真性能时，用 profile mode，不要拿 debug mode 下的结果下结论

### 一个实用判断

如果问题表现为：

- **首屏白屏久**：先看启动路径、首帧 raster、同步初始化、图片预热
- **图片显示慢**：先看缓存命中、解码尺寸、网络/磁盘读取
- **第一次动画卡**：先看 shader compilation 和 Impeller 支持边界
- **滚动时掉帧**：再看布局、绘制、阴影、透明度、clip、列表构建量

## 参考

- [ImageCache class - Dart API](https://api.flutter.dev/flutter/painting/ImageCache-class.html)
- [ImageProvider class - Dart API](https://api.flutter.dev/flutter/painting/ImageProvider-class.html)
- [obtainKey - Dart API](https://api.flutter.dev/flutter/painting/ImageProvider/obtainKey.html)
- [resolveStreamForKey - Dart API](https://api.flutter.dev/flutter/painting/ImageProvider/resolveStreamForKey.html)
- [Image class - Dart API](https://api.flutter.dev/flutter/widgets/Image-class.html)
- [ResizeImage.resizeIfNeeded - Dart API](https://api.flutter.dev/flutter/painting/ResizeImage/resizeIfNeeded.html)
- [ResizeImage - Dart API](https://api.flutter.dev/flutter/painting/ResizeImage/ResizeImage.html)
- [firstFrameRasterized - Dart API](https://api.flutter.dev/flutter/widgets/WidgetsBinding/firstFrameRasterized.html)
- [Performance metrics - Flutter docs](https://docs.flutter.dev/perf/metrics)
- [Use the Performance view - Flutter docs](https://docs.flutter.dev/tools/devtools/performance)
- [Improving rendering performance - Flutter docs](https://docs.flutter.dev/perf/rendering-performance)
- [Shader compilation jank - Flutter docs](https://docs.flutter.dev/perf/shader)
- [Impeller rendering engine - Flutter docs](https://docs.flutter.dev/perf/impeller)
