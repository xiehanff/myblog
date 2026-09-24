# Flutter Engine / Shell / Embedder：从 Dart VM 到屏幕像素

[toc]

## 概念总览

Flutter 的一条完整链路，可以粗略理解为：

`Dart 代码 -> Flutter Framework -> Engine（内部由 Shell 装配）-> Embedder -> 操作系统 -> GPU -> 屏幕像素`

更具体一点：

- **Framework** 负责声明 UI、管理状态、布局与事件分发
- **Engine** 负责提供 Dart 运行时、文本与图形能力、帧调度和与平台侧的低层交互
- **Shell** 是 Engine 内部的装配与调度层，负责把 runtime、线程、`PlatformView`、`Rasterizer`、`TaskRunners` 这些部件接起来
- **Embedder** 是平台宿主侧的接入层，负责把 Flutter 接进 Android / iOS / 桌面 / embedded OS

这里最容易混淆的点有两个：

1. **Shell 不是宿主 app 的“壳”**。它是 Engine 内部概念，不是 `Activity`、`UIViewController` 这一类平台容器。
2. **Embedder 不是 Flutter Framework**。它属于平台原生侧，负责窗口、Surface、输入、生命周期和事件循环的接入。

从职责边界看，可以记成一句话：

- **Framework 说“画什么”**
- **Engine 说“怎么跑、怎么渲染”**
- **Embedder 说“怎么接操作系统”**

## 核心流程

下面按“从启动到出像素”的顺序看：

### 1. 平台宿主拉起进程

Android、iOS、Windows、macOS、Linux 先启动自己的进程模型和主线程。
宿主侧会创建窗口、Surface 或等价的渲染目标，并准备好事件循环。

在 add-to-app 场景里，宿主通常就是现有应用的一部分；Flutter 只是在其中渲染一块视图。官方的 add-to-app 文档明确说明了这一点：Flutter 可以作为模块嵌入现有应用，而不必接管整个应用。

### 2. Embedder 初始化 Engine

Embedder 启动 Flutter Engine，并把平台能力接给引擎：

- 提供渲染 Surface / Texture
- 提供输入事件入口
- 提供生命周期变化
- 提供平台消息与平台通道的承接
- 提供事件循环和线程模型的接入点

这一步之后，Flutter 才真正拥有“向屏幕写像素”的通道。

### 3. Dart VM 执行 Framework 代码

Flutter 的业务和框架代码运行在 Dart 运行时里。
在调试模式下，Dart 代码常见于 JIT 形态，热重载正是依赖 JIT 的能力；在 profile / release 中通常是 AOT 产物。但无论哪种形态，都是由 Engine 托管 Dart runtime 并执行 Flutter Framework。官方架构文档把这一点概括为：engine 把 Skia 和 Dart 这两个核心组件托管在 shell 里。

可以把关系理解成：

- **Dart VM / runtime**：执行 Dart 代码的运行时
- **Flutter Framework**：用 Dart 写的 UI、状态、布局、手势、语义逻辑
- **Engine**：托管 runtime，并把 Dart 世界和图形世界接起来

### 4. Framework 生成下一帧

当状态变化、输入到达或系统请求重绘时，Framework 会在下一帧里重新执行必要的构建流程。

典型路径是：

1. `setState()` 或其他状态变化触发重建
2. Widget 重新 `build()`
3. Element 维持树结构和复用
4. RenderObject 完成 layout / paint
5. 生成可交给引擎的 scene / layer tree

这套流程正是三棵树的分工：Widget 提供新配置，Element 决定哪里复用、哪里更新，RenderObject 落实布局和绘制，最终生成交给引擎的场景描述。

### 5. Engine 把场景交给 Raster 线程

Framework 只负责描述“场景是什么”，真正的像素化发生在 Raster 侧。

引擎把 layer tree / scene 交给 Raster 线程后，由图形后端完成栅格化：

- **Skia**：Flutter 的传统图形后端，通用 2D 图形库
- **Impeller**：Flutter 自研的新一代图形后端，在构建期预编译着色器，从设计上消除运行时 shader 编译卡顿

这两个都不是业务层概念，它们的角色是“把引擎给出的绘制指令变成 GPU 能提交的像素工作”。

版本现状（以 2026 年 stable 3.41 为准）：iOS 上 Impeller 是唯一支持的渲染后端，无法切回 Skia；Android 上 Impeller 自 3.27 起默认启用，API 29+ 走 Vulkan，更低版本或无 Vulkan 的设备自动回退到 Impeller 的 OpenGL ES 后端（而不是 Skia）。桌面端（macOS / Windows / Linux）当前默认仍是 Skia，Impeller 计划自 3.47 起在桌面默认启用；Web 端渲染仍基于 Skia（CanvasKit / Skwasm）。另外，即使渲染走 Impeller，引擎仍复用 Skia 的文本排版与图片编解码子组件。详见官方 [Impeller 文档](https://docs.flutter.dev/perf/impeller)。

### 6. GPU 提交并呈现到屏幕

Raster 线程完成绘制后，图像会进入 GPU 提交流程，最终由平台合成并显示到屏幕。
这一段通常是“看起来最短，实际链路最长”的地方，因为它涉及渲染后端、Surface、交换缓冲、合成和系统展示。

### 7. 输入与平台消息回流

用户触摸、按键、生命周期变化、插件回调、平台消息都会从 Embedder 回到 Flutter。

其中：

- 输入事件先由宿主接收，再进入 Flutter 的事件分发与命中测试
- 平台通道把 Dart 与原生能力连接起来
- 生命周期和窗口变化会影响后续帧调度

这条回流的终点依然是"状态变化驱动下一帧"：手势竞技的胜出者触发业务回调，回调修改状态，下一帧重建，如此循环。

## 关键对象/接口

| 名称 | 所在层 | 作用 |
|---|---|---|
| `Dart VM` / runtime | Engine 内部 | 执行 Dart 代码，托管 isolate 和运行时能力 |
| `Flutter Framework` | Dart | Widget、Element、RenderObject、Scheduler、Gesture、Semantics |
| `Flutter Engine` | C++ | 帧调度、文本、图形、I/O、Dart runtime、与平台的低层连接 |
| `Shell` | Engine 内部 | 把 runtime、`PlatformView`、`Rasterizer`、线程和任务调度装配起来 |
| `Embedder` | 平台侧原生代码 | 对接窗口、Surface、输入、生命周期、平台事件循环 |
| `PlatformDispatcher` | Dart / `dart:ui` | 接收平台调度、窗口与输入相关回调 |
| `Scene` / `LayerTree` | Framework -> Engine | Framework 输出给引擎的可渲染场景描述 |
| `MethodChannel` / `EventChannel` / `BasicMessageChannel` | Framework <-> 平台 | 跨 Dart 与原生代码的消息传递 |

表格里 Shell 组装的 `PlatformView` 是 Engine 内部的 C++ 接口（`shell::PlatformView`），负责把渲染 Surface、输入事件、生命周期消息等平台能力抽象给引擎核心，和 Dart 侧“嵌入原生视图”的 `PlatformView`（`AndroidView` / `UiKitView` 那一套）是两回事，不要混淆。

### 1. Dart VM 和 Engine

很多人会把 Dart VM 和 Engine 当成两个平级系统，这不准确。

更稳妥的理解是：

- **Dart VM / runtime 是 Engine 的一部分能力**
- **Framework 运行在 Dart runtime 之上**
- **Engine 决定什么时候跑帧、什么时候渲染、怎么把 Dart 输出变成像素**

也就是说，Dart VM 是 Engine 托管的执行环境，并不单独“外置”。

### 2. UI 线程

经典概念里，UI 线程负责执行 Dart 代码，也就是：

- 运行 Flutter Framework
- 执行 `build()`
- 执行 layout / paint，生成 LayerTree
- 处理动画、状态更新和大部分 UI 逻辑

官方性能文档强调：**所有 Dart 代码都在 UI 线程上运行**，所以任何同步重活都会直接影响 UI 流畅度。

版本背景：从 Flutter 3.29 开始，iOS 和 Android 上 UI 线程与 Platform 线程已默认合并——独立的 UI 线程被移除，Dart 代码直接运行在宿主平台主线程上；macOS / Windows（3.35）和 Linux（3.39）随后跟进。因此在当前 stable 版本里，“UI 线程”就是平台主线程，但理解职责时仍可以按“UI 侧逻辑”和“宿主平台逻辑”来分开看。官方说明见 [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)。

### 3. Raster 线程

Raster 线程负责：

- 接收 layer tree / scene
- 调用 Skia 或 Impeller 做栅格化
- 生成 GPU 可提交的数据
- 把最终帧送去显示

如果 UI graph 没红，但 GPU graph 红了，通常说明问题不在 Dart 构建，而在渲染后端、层级复杂度、图片开销、shader、裁剪、离屏缓冲等地方。

### 4. Platform 线程

Platform 线程是宿主平台的主线程，负责：

- 原生生命周期回调
- 插件代码
- 窗口和视图管理
- 平台消息和系统事件

在旧资料里，它经常和 UI 线程分开写；自 Flutter 3.29（iOS / Android）、3.35（macOS / Windows）、3.39（Linux）起，两条线程已默认合并为同一条宿主主线程，“同一个主线程上的不同职责面”从比喻变成了事实。

线程数量上可以记两点：每个引擎实例拥有一组自己的 task runner（platform / ui / raster / io），线程本身由 Embedder 创建并提供给引擎；add-to-app 场景下的多个引擎实例共享同一条平台线程（通过 `FlutterEngineGroup` 创建时还能共享 UI 线程与 isolate group）。

### 5. IO 线程

IO 线程负责把耗时 I/O 从 UI 和 Raster 线程上移走，避免阻塞主渲染链路。

通常可以把它理解成 Engine 的后台辅助线程，常见工作包括：

- 图片等资源的读取与解码
- 纹理上传前的准备工作
- 其他引擎侧的阻塞性 I/O

这条线程服务的是引擎自身的资源管线；Dart 应用代码里的文件 / 网络 I/O 由 Dart VM 自己的机制处理，并不跑在这条线程上。

### 6. Platform Channel

Platform Channel 不是“直接调用原生方法”。

它本质上是：

- 先序列化 Dart 数据
- 再通过 Engine / Embedder 传到平台侧
- 再由原生代码反序列化并处理
- 最后把结果回传给 Dart

所以它更像跨进程消息协议的思路，只不过发生在 Flutter 框架和宿主原生代码之间。

## 常见误区

### 1. “Flutter 就是 Skia”

不对。Skia / Impeller 是图形后端，不是 Flutter 整体。
Flutter 还有 Framework、Engine、Embedder、Dart runtime、平台通道等一整套链路。

### 2. “Dart 代码直接控制 GPU 画像素”

不对。Dart 代码先影响状态和树结构，再由 Framework 产出场景描述，最后才到 Engine 的 Raster 侧。

### 3. “Engine 和 Embedder 是一层”

不对。Engine 是可移植运行时与渲染核心，Embedder 是平台宿主接入层。
前者更像 Flutter 本体，后者更像把 Flutter 接进 OS 的胶水。

### 4. “Shell 就是宿主壳工程”

不对。这里的 Shell 是 Engine 内部概念，不是应用工程名，也不是 UI 里的壳组件。

### 5. “Platform Channel 可以直接同步当函数调用用”

不对。它是消息通信机制，存在序列化、线程边界和异步成本。
把它当同步函数用，通常会在性能和可维护性上出问题。

### 6. “UI 线程、Platform 线程永远分开”

不对。当前 stable 上，iOS / Android（3.29 起）、macOS / Windows（3.35 起）、Linux（3.39 起）的 UI 线程与 Platform 线程已默认合并为同一条主线程，Dart 代码运行在平台主线程上；但 Raster 与 IO 仍是独立线程。
如果写文章或面试回答，最好同时说明“经典职责划分”与“当前实现现状”。

## 面试问法/性能点

### 常见面试问法

1. 从用户点击图标到首帧显示，Flutter 内部经历了哪些层？
2. Engine、Shell、Embedder 各自做什么？
3. Dart VM 和 Flutter Framework 的关系是什么？
4. UI 线程和 Raster 线程分别负责什么？
5. 为什么 Platform Channel 不能当作普通函数调用？
6. Skia 和 Impeller 在 Flutter 里扮演什么角色？
7. 当前 Flutter 平台实现的线程合并，对理解线程模型有什么影响？

### 性能点

- **UI 卡顿**：通常是 Dart 侧同步工作太重，`build()`、layout、状态更新或主线程阻塞过多
- **Raster 卡顿**：通常是场景太复杂、图片太大、shader 太重、裁剪和离屏绘制太多
- **平台卡顿**：通常是宿主主线程被插件、生命周期或原生同步逻辑阻塞
- **I/O 压力**：大图解码、文件读取、网络准备若放错线程，会拖慢整条链路

实际排查时，可以结合 Flutter 的性能叠层、DevTools 和帧耗时数据看：

- UI graph 红，优先查 Dart / Framework
- GPU graph 红，优先查 Raster / 图形管线
- 平台交互慢，优先查宿主线程和通道调用

### 面试回答模板

如果被要求一句话说清楚，可以这么答：

> Flutter 由 Framework、Engine 和 Embedder 三层组成。Framework 在 Dart 里描述 UI 和状态，Engine 托管 Dart runtime 并把场景交给 Raster 线程渲染，Embedder 则把 Flutter 接入 OS 的窗口、输入和生命周期，最终由 Skia 或 Impeller 把场景变成屏幕像素。

## 参考

官方资料优先看这些：

- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
- [Flutter performance profiling](https://docs.flutter.dev/perf/ui-performance)
- [Platform-specific code / platform channels](https://docs.flutter.dev/platform-integration/platform-channels)
- [Add Flutter to an existing app](https://docs.flutter.dev/add-to-app)
- [Embedded support for Flutter](https://docs.flutter.dev/embedded)
- [The Engine architecture](https://github.com/flutter/flutter/blob/main/docs/about/The-Engine-architecture.md)
- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller)
- [Merged threads on macOS and Windows](https://docs.flutter.dev/release/breaking-changes/macos-windows-merged-threads)
- [Merged threads on Linux](https://docs.flutter.dev/release/breaking-changes/linux-merged-threads)
