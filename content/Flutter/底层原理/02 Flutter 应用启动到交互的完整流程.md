# Flutter 开发者的系统层查漏补缺

> 面向有经验 Flutter 开发者的系统层查漏补缺版本。每行一个要点，简洁但尽量覆盖关键细节。

## 0. 概览（一句话链路）
- 用户点击图标
- 系统拉起进程与窗口
- 引擎初始化并创建 Dart VM
- 运行 main 并 runApp
- 三棵树构建
- 首帧完成并显示
- 事件输入与手势分发
- 状态更新驱动 UI

## 1. 进程与窗口（平台侧）
- Android 由 ActivityManager 启动进程
- iOS 由 SpringBoard 启动进程
- 创建主线程并初始化消息循环
- 创建窗口与 Surface/UIView
- 初始化资源路径与沙盒目录
- 准备 GPU/渲染上下文
- 建立输入通道（触控/键盘/鼠标）
- 构建平台侧生命周期回调
- 读取应用配置（manifest/Info.plist）
- 初始化线程池与 I/O 调度
- 预加载动态库（libflutter.so 等）
- 创建 FlutterEngine 宿主对象
- 建立 PlatformView 容器
- 注册平台插件入口
- 进入 Flutter 引擎初始化流程

## 2. FlutterEngine 创建
- 初始化 Shell（Engine/Platform/Raster/UI 线程）
- 绑定平台 TaskRunner 与消息循环
- 配置 GPU 驱动能力与后端
- 初始化渲染后端（Impeller/Skia）与字体引擎
- 创建 Dart VM 实例（可能复用）
- 建立资源加载器（AssetManager）
- 设置 Dart Entrypoint（main）
- 设置 snapshot（AOT/JIT）
- 绑定 Platform Channel 管道
- 初始化语义树系统
- 初始化纹理注册表
- 初始化绘制管线状态
- 设置帧调度与 VSync
- 绑定系统时钟与时间源
- 进入引擎 Ready 状态

## 3. Dart VM 与 Isolate
- 创建主 Isolate（UI isolate）
- 加载 kernel 或 AOT snapshot
- 构建 Dart 堆与 GC
- 绑定 Dart 消息循环
- 初始化 core libraries
- 解析入口函数 main
- 执行运行时初始化回调
- 创建微任务队列
- 建立 Zone 默认链
- 初始化服务协议（debug/profile）
- 建立 VM Service 通道
- 注册 Dart:ui 绑定
- 连接 engine 与 Dart runtime
- 初始化事件通道（Pointer/Event）
- 等待框架 ensureInitialized 接管
- 准备框架层启动

注意：SchedulerBinding 等 bindings 是 Dart 框架层对象，在 `WidgetsFlutterBinding.ensureInitialized()`（即 `runApp` 阶段）才创建，并不属于引擎初始化阶段；引擎侧只负责把 `onBeginFrame`/`onDrawFrame` 等回调入口注册给 Dart 的 PlatformDispatcher。

关于 FlutterEngine 的创建时机，Android 与 iOS 略有差异（官方 [add-to-app 性能文档](https://docs.flutter.dev/add-to-app/performance)）：Android 上首次构造 `FlutterEngine` 就会加载 libflutter.so 并启动 Dart VM，随后调用 `executeDartEntrypoint` 才创建 root isolate 并执行 main；iOS 上 Dart VM 在首次 `runWithEntrypoint:` 运行入口时启动。新建的 FlutterEngine 不会自动执行任何 Dart 代码，在注册 RenderSurface（如 FlutterView）之前也不会显示任何 UI。

## 4. main() 与 runApp()
- main 被调用
- 执行 WidgetsFlutterBinding.ensureInitialized
- 初始化 bindings（Gesture/Services/Painting/Semantics/Scheduler/Rendering/Widgets）
- 构建初始 BuildOwner 与 PipelineOwner
- 注册平台消息处理器
- 初始化错误处理
- 调用 runApp
- runApp 内部再次 ensureInitialized（幂等）
- 根 Widget 被 wrapWithDefaultView 包进 View
- scheduleAttachRootWidget 经 Timer.run 异步挂载
- attachRootWidget 创建 RootElement 并同步完成首帧 build
- View 挂载时创建/复用 RenderView
- scheduleWarmUpFrame 立即调度首帧管线

注意：RenderView、PipelineOwner、BuildOwner 都在 binding 初始化与根 Widget 挂载阶段就绪，而不是在 attachRootWidget 之后才创建。另外在较新版本的框架（本机 3.41.9）中，`runApp` 通过 `scheduleAttachRootWidget`（内部 `Timer.run`）异步挂载根 Widget，而不是同步调用 `attachRootWidget`；根 Element 对应的类是 `RootElement`（挂载 `RootWidget`），老的 `RenderObjectToWidgetAdapter`/`renderViewElement` 路径已不再是 runApp 的主链路。可参考 [runApp 文档](https://api.flutter.dev/flutter/widgets/runApp.html)。

## 5. 三棵树构建
- Widget 是不可变配置
- Element 是 Widget 的运行时实例（连接另两棵树的桥梁）
- RenderObject 负责布局与绘制
- runApp 触发 root element 创建
- createElement 生成 Element 节点
- mount 绑定父子关系
- RenderObjectWidget 创建 RenderObject
- RenderObject attach 到 render tree
- Element 树维护生命周期状态
- RenderObject 树持有布局与绘制逻辑
- Element updateChild 负责复用判断
- Widget.canUpdate 决定复用
- key 影响 Element 的匹配策略
- GlobalKey 允许跨位置复用
- 结构稳定依赖 Element 树

## 6. 首帧调度
- runApp 末尾调用 scheduleWarmUpFrame
- 首帧是 warm-up 帧：不等 VSync
- 引擎直接回调 beginFrame/drawFrame
- beginFrame 执行动画回调（时间戳可能为空）
- drawFrame 进入 persistentCallbacks 阶段
- WidgetsBinding.drawFrame 先执行 buildScope
- 重建 dirty Element 完成构建
- flushLayout 完成布局
- flushCompositingBits 更新合成位
- flushPaint 生成 Layer tree
- renderView.compositeFrame 合成 Scene 上送引擎
- Raster 线程光栅化
- 交换 buffer 显示首帧
- 触发 postFrame 回调
- 标记首帧完成（firstFrameSent）
- 后续帧改由 VSync 驱动

这里的关键认知是：**首帧不经过 scheduleFrame/VSync 请求，而是由 scheduleWarmUpFrame 直接驱动**。引擎从应用启动到发出第一个 VSync 信号之间可能有几毫秒空闲，框架趁机把昂贵的 build/layout/paint 先做掉；warm-up 帧本身可能不会真正上屏（引擎没有请求它，可能没有有效的渲染上下文），等引擎请求的 VSync 帧到来时只需少量增量工作即可出画面。warm-up 帧期间还会 lockEvents 锁住输入事件分发，直到该帧结束，因此首帧完成前触摸事件不会插入。

在 3.41 中，`SchedulerBinding.scheduleWarmUpFrame` 委托给引擎的 `PlatformDispatcher.instance.scheduleWarmUpFrame`：beginFrame 回调执行 `handleBeginFrame(null)`，drawFrame 回调执行 `handleDrawFrame()` 后 `resetEpoch()` 重置时间纪元（避免 implicit 动画因时间戳跳变而跳帧），若此前已有正常帧排队还会补一个 `scheduleFrame()`。drawFrame 期间允许 build：`WidgetsBinding.drawFrame` 在 `super.drawFrame()`（layout/paint/composite）之前先对 rootElement 执行 `buildScope`。详见 [SchedulerBinding.scheduleWarmUpFrame 文档](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/scheduleWarmUpFrame.html) 与本机 SDK `packages/flutter/lib/src/scheduler/binding.dart`、`packages/flutter/lib/src/widgets/binding.dart`。

## 7. Build 阶段要点
- build 只生成 Widget 配置
- build 不直接绘制
- build 可以多次调用
- Element 复用减少重建成本
- setState 标记 dirty
- markNeedsBuild 合并多次请求
- buildScope 对 dirty list 排序
- 只 rebuild 脏 Element
- build 依赖 context 的 Inherited
- didChangeDependencies 可被触发
- build 应避免副作用
- build 应避免 I/O 和异步
- build 内避免 setState
- build 只做纯 UI 组装
- build 期间创建对象应谨慎

## 8. Layout 阶段要点
- RenderObject 接收约束
- 约束自上向下传递
- 尺寸自下向上传递
- performLayout 是核心入口
- RenderBox 常用布局协议
- Flex/Stack 等特殊布局逻辑
- ParentData 用于父子协作
- Layout 可触发 relayout
- 布局变化可能标记 repaint
- Layout 可能触发 intrinsic 计算
- 过度使用 intrinsic 影响性能
- RenderObject 持有 size/offset
- 布局完成后进入 paint
- 需要 layout 的节点被标记 dirty
- layout 只做尺寸与位置

## 9. Paint 阶段要点
- paint 生成绘制指令
- Recording 到 Layer
- 使用 Canvas 进行绘制
- RepaintBoundary 隔离重绘
- RenderObject.paint 是入口
- paint 可被局部重绘
- 透明度与变换进入 Layer
- PictureLayer 保存绘制指令
- ClipLayer 处理裁剪
- TransformLayer 处理变换
- OpacityLayer 处理透明
- CompositedTransformLayer 用于跟随
- paint 不做布局
- paint 可跳过未变化节点
- paint 阶段尽量少分配

## 10. Compositing 与 Raster
- Layer 树组合为 Scene
- Scene 发送到 Raster 线程
- Raster 线程使用 Impeller/Skia
- GPU 执行光栅化
- 生成最终帧 buffer
- 通过 Surface 显示
- 可能使用 GPU/CPU 合成
- 受限于 GPU 驱动
- shader 编译可能卡顿
- 使用 shader warmup 缓解
- 大图会触发纹理解码
- cacheWidth/height 控制解码尺寸
- 纹理上传在 GPU 线程
- 首帧常受资源加载影响
- Raster 慢则掉帧

## 11. 线程模型
- UI 线程执行 Dart/Build
- Raster 线程执行绘制
- Platform 线程处理系统事件
- IO 线程处理资源与解码
- TaskRunner 管理任务队列
- 线程间消息通过 PostTask
- UI 线程阻塞会卡 UI
- Raster 阻塞导致掉帧
- IO 阻塞会拖慢图片解码
- 平台线程阻塞影响输入响应
- 线程优先级由系统控制
- 线程调度受系统压力影响
- 多线程间需减少同步等待
- Text/layout 主要在 UI 线程
- 图片解码常在 IO 线程

## 12. Input 到 Handlers
- 平台层接收触摸
- 转换为 PointerEvent
- 进入 GestureBinding
- 执行命中测试
- 生成 HitTestResult
- 事件自下而上分发
- Listener 直接接收 PointerEvent
- GestureRecognizer 进入竞技场
- 识别 tap/drag/scale
- 手势胜出触发回调
- 回调执行用户逻辑
- 可能触发 setState
- setState 进入下一帧
- 事件也可被 Absorb/Ignore
- semantics 参与可访问交互

## 13. GestureArena 细节
- 每个指针事件都可创建 arena
- 多个 recognizer 竞争
- accept 或 reject 决策
- arena 在 pointer up 前或 up 时裁决（sweep）
- DoubleTap 与 Tap 有优先规则
- Drag 与 Scroll 的冲突
- 触控与鼠标可并存
- RawGestureDetector 可定制规则
- GestureDetector 是封装
- 事件耗尽后释放资源
- 复杂手势需自定义 recognizer
- 识别器可通过 resolve 提前结束
- arena 提升手势解析一致性
- 影响用户交互延迟
- 调试可用 debugPrintGestureArenaDiagnostics

## 14. Platform Channel
- MethodChannel 用于方法调用
- EventChannel 用于事件流
- BasicMessageChannel 用于基础消息
- PlatformMessage 通过 binary messenger
- 编解码使用 StandardMessageCodec
- 平台侧有 MethodCallHandler
- Dart 与平台线程间异步
- 调用涉及序列化成本
- 大消息需优化格式
- 多次调用需考虑并发
- isolate 需单独 messenger
- plugin 注册发生在引擎启动
- 生命周期事件也走通道
- 错误通过 PlatformException 传回
- 通道阻塞会影响 UI

## 15. 插件注册与初始化
- Android 在 FlutterActivity 中注册
- iOS 在 AppDelegate 中注册
- 插件向 engine 注册通道
- 插件可创建 PlatformView
- 插件可监听生命周期
- 插件可注册 texture
- 插件可能依赖后台服务
- 初始化过重会拖慢首帧
- 可延迟初始化非关键插件
- 插件使用 PlatformDispatcher
- 插件可影响权限流程
- 插件可以有后台线程
- 插件需处理热重载
- 插件异常需降级
- 注册顺序影响某些行为

## 16. 资源加载与 Asset
- AssetBundle 读取资源
- 默认使用 rootBundle
- Asset 由 Flutter 工具打包
- 资源读取是异步
- 读取发生在 IO 线程
- 图片解码后缓存
- fonts 在引擎中注册
- 字体 fallback 依赖平台
- 资源过大影响首帧
- 预加载可减少卡顿
- AssetManifest.json 记录资源
- 变体资源通过分辨率匹配
- ImageCache 控制缓存大小
- LRU 驱逐策略
- 大图需压缩或裁剪

## 17. 字体与文本渲染
- Text 使用 ParagraphBuilder
- 字体度量影响布局
- 文字方向由 Localizations 决定
- 文本缩放因子影响字体大小
- 字体加载可能延迟首帧
- fallback 字体用于缺字
- RichText 生成 RenderParagraph
- text shaping 在引擎层完成
- 字体缓存减少重复布局
- 超长文本影响 layout
- Emoji 使用彩色字体
- 高级排版依赖 HarfBuzz
- 文本绘制在 paint 阶段
- 选择/光标通过 RenderEditable
- 软键盘交互走平台通道

## 18. 图片解码与渲染
- ImageProvider 提供 key
- 图片缓存基于 key
- 解码通常在 IO 线程
- 解码后上传纹理
- resize 解码减少内存
- FadeInImage 可能触发重绘
- ImageStream 管理帧
- GIF 使用多帧解码
- 过多大图易 OOM
- Cache width/height 推荐
- ImageCache 可手动驱逐
- 清理 live images 应谨慎
- skia image 影响 GPU
- 大图会触发 gc 压力
- 使用 precacheImage 预加载

## 19. 生命周期与可见性
- AppLifecycleState 有 5 种
- resumed 进入前台
- inactive 失去焦点
- paused 进入后台
- hidden 已不可见（所有视图均不显示）
- detached 进程即将结束
- WidgetsBindingObserver 监听
- 生命周期变化可能触发 rebuild
- paused 时应停止动画
- resumed 时恢复订阅
- 生命周期变化也影响插件
- iOS background 有额外限制
- Android onStop 时可能释放
- 热启动与冷启动不同
- 前后台切换影响资源
- App 可被系统杀死

## 20. 首帧性能要点
- 首帧由 runApp 驱动
- 首帧耗时来自 build/layout/paint
- IO 资源加载也影响首帧
- shader 编译是常见原因
- 使用 shader warmup
- 减少同步 I/O
- 延迟非必要插件
- 预加载首屏资源
- 避免首屏复杂布局
- 减少首屏图片解码
- 使用 const 减少 rebuild
- 监控 frame timings
- 使用 DevTools 追踪帧
- 路由首屏应轻量
- 过多动画会拖慢首帧

## 21. App 启动阶段分类
- 冷启动：系统新建进程，从头开始
- 暖启动：进程仍在，但 Activity 需重建
- 热启动：进程与 Activity 都在内存，直接切前台
- 冷启动耗时最大
- Warm start 仍需重建 UI
- Hot restart 接近重新构建
- 启动优化目标首帧
- 可记录 TTF（Time To First Frame）
- 可记录 TTID（Time To Interact）
- 平台有冷启动统计
- Flutter 可自定义追踪
- 首帧之后仍可能卡顿
- 启动期间应避免大同步任务
- 首屏数据可占位
- 延迟渲染可用 deferFirstFrame

前三行的划分依据 [Android 官方启动时间文档](https://developer.android.com/topic/performance/vitals/launch-time)：cold start 是系统创建新进程；warm start 是进程还在（或有保存的状态）但 Activity 必须重建并带到前台；hot start 开销最小，进程与 Activity 都驻留内存，只需切到前台。Android 侧的标准指标是 TTID（time to initial display，首帧可见）与 TTFD（time to fully drawn，调用 `reportFullyDrawn()` 报告），可与上面自定义的 TTF/TTID 埋点对照。注意 Flutter 语境下的 Hot Restart（重启 isolate）与平台的 hot start 是两回事。

## 22. deferFirstFrame/allowFirstFrame
- 用于延迟首帧显示
- 适合启动时加载资源
- 过度使用影响体验
- 必须成对调用
- 适合 splash 控制
- 只延迟上屏而非构建
- 期间仍可进行异步加载
- 结束后 allowFirstFrame 再排一个 warm-up 帧
- 延迟过久用户感知差
- 可配合原生启动页
- 适合复杂启动流程
- 需避免阻塞 UI 线程
- 适合首屏关键资源
- 用于首屏授权流程
- 注意与导航时序

"只延迟上屏而非构建"值得展开：`RendererBinding.deferFirstFrame` 只是把一个计数器 +1，框架仍会完整执行 build/layout/paint，只是 `drawFrame` 里跳过 `compositeFrame()`，帧不发给引擎、不上屏（源码注释："The framework will still do all the work to produce frames, but those frames are never sent to the engine"）。因此它适合"构建可以照常进行、但等关键资源就绪后再显示"的场景；`allowFirstFrame` 将计数器归零时会补一个 `scheduleWarmUpFrame()` 立即出帧。首帧一旦已发送给引擎，再调用 deferFirstFrame 就无效了。

## 23. 路由与导航栈
- runApp 创建 MaterialApp
- Navigator 管理路由栈
- 初始 route 决定首屏
- push 创建新 route
- pop 移除 route
- route 切换触发 build
- Hero 动画依赖 Overlay
- Navigator 依赖 GlobalKey
- 路由切换可能触发 layout
- 页面状态通过 State 保存
- 路由可懒加载
- 复杂路由要注意状态保留
- 路由动画影响首帧
- 系统 back 走平台回调
- Router 2.0 使用 declarative

## 24. 状态管理与更新
- setState 适合局部状态
- Provider 依赖 InheritedWidget
- Bloc 使用 Stream 驱动
- Riverpod 拆分依赖
- 状态变化触发 rebuild
- 粒度越小越高效
- 大范围 rebuild 导致掉帧
- 使用 Selector/Consumer 优化
- ValueListenableBuilder 轻量
- AnimatedBuilder 避免 setState
- ChangeNotifier 需 notifyListeners
- Provider 依赖变化触发 didChangeDependencies
- 状态变更应在 UI 线程
- 状态持久化需异步
- 避免在 build 里触发副作用

## 25. InheritedWidget 机制
- dependOn 记录依赖
- updateShouldNotify 决定通知
- 依赖变化触发 didChangeDependencies
- 依赖更新触发 markNeedsBuild
- 依赖适合共享小范围状态
- 依赖链过深需优化
- 依赖更新过频会重建
- InheritedModel 可分区更新
- Theme/MediaQuery 都是继承机制
- 依赖读取需在 build 中
- 依赖读取影响 rebuild 范围
- 依赖更新是同步通知
- 依赖更新会影响 subtree
- 依赖与 Provider 类似
- 依赖不要滥用

## 26. 事件驱动 UI 更新链
- 用户点击触发 gesture 回调
- 回调修改 state
- setState 标记 dirty
- Scheduler 进入下一帧
- build 生成新 Widget
- updateChild 判断复用
- RenderObject 更新属性
- layout/paint 标记 dirty
- 生成新帧
- Raster 输出新画面
- 用户看到变化
- 同一帧多次 setState 合并
- 避免 setState 过频
- 延迟更新可用 throttle
- 复杂交互建议动画控制器

## 27. 可访问性与语义树
- Semantics 生成语义节点
- 语义树与 RenderObject 树并行
- 平台读屏依赖语义
- 语义更新会影响性能
- 可以 excludeSemantics
- 合并语义避免噪音
- 语义与可点击区域关联
- 语义变更需同步更新
- 大量语义节点可能卡顿
- 语义树更新在 build 后
- 可访问性需要正确 label
- 增加 hint 提升可用性
- 语义点击回调走框架
- 语义用于测试定位
- 语义在 release 也启用

## 28. 帧调度与优先级
- SchedulerBinding 负责帧调度
- transient callbacks 用于动画
- persistent callbacks 用于渲染管线
- post-frame callbacks 用于布局后逻辑
- scheduleTask 可指定优先级
- 低优先级 scheduleTask 趁空闲执行
- frame budget 16ms/8ms
- 超时会掉帧
- 过多 post-frame 会堆积
- 动画控制器与帧同步
- scheduleFrame 保证下一帧
- platform frame 和 engine frame 对齐
- VSync 由系统提供
- VSync 不稳定会导致卡顿
- 监控 FrameTiming 诊断

## 29. FlutterError 与错误链
- FlutterError.onError 捕获框架错误
- runZonedGuarded 捕获异步错误
- PlatformDispatcher.onError 捕获平台层错误
- 生产环境应统一上报
- debug 下可 dumpErrorToConsole
- 错误链应保留 StackTrace
- isolate 错误需额外监听
- error handler 不应阻塞
- 错误处理不要再 throw
- error handler 应降级
- error handler 应收集设备信息
- error handler 应附带版本
- 错误处理需要采样
- 上报失败需兜底
- 错误分类有助排查

## 30. 平台视图（PlatformView）
- Android 使用 Hybrid Composition/Texture
- iOS 使用 UiKitView
- 平台视图嵌入影响性能
- 需要额外合成开销
- 触摸事件需桥接
- 平台视图层级可能限制
- PlatformView 会破坏某些动画
- 叠加顺序不易控制
- 使用场景需谨慎
- 大量 PlatformView 会卡顿
- 透明度与遮罩限制
- 平台视图渲染在平台线程
- 可能导致帧率下降
- 必要时做降级
- 注意生命周期同步

## 31. 纹理与视频
- TextureRegistry 由引擎维护
- 纹理更新通过标记帧
- 视频解码在原生侧
- Flutter 仅显示纹理
- 纹理更新频率影响帧
- 多纹理会增加 GPU 压力
- 纹理尺寸过大会卡顿
- 纹理销毁需释放资源
- 纹理更新需同步帧
- 使用 TextureLayer 渲染
- 纹理与 Transform 组合
- 纹理支持裁剪与透明
- Texture 影响 hitTest
- 视频播放需处理后台
- 视频插件与引擎通信

## 32. 滚动与合成
- Scrollable 使用 Viewport
- Sliver 进行懒加载
- 滚动驱动位置变化
- 滚动可触发重绘
- RepaintBoundary 优化滚动
- 过度重绘影响滑动
- 滚动缓存通过 cacheExtent
- 滚动事件影响 gesture arena
- NestedScroll 处理冲突
- Overscroll 使用 ScrollPhysics
- 滚动动画由 AnimationController
- 滚动位置通过 ScrollController
- KeepAlive 保留子项状态
- ReorderableList 使用 key
- 列表性能依赖 itemBuilder

## 33. 布局与重建性能
- 复杂布局会增加 layout 时间
- 多层嵌套影响测量
- 使用 const 减少 rebuild
- 使用 SizedBox/Spacer 简化
- 尽量避免 LayoutBuilder 滥用
- 避免 IntrinsicHeight/Width
- 关注 RenderObject 重建成本
- 使用 RepaintBoundary 减少重绘
- 关注过多 Opacity/Clip
- ClipPath 代价高
- Transform 影响合成层
- 使用 CacheExtent 优化列表
- 分离静态与动态组件
- 大图解码影响 UI
- 减少 build 中创建对象

## 34. 依赖与模块初始化
- 初始化顺序影响依赖关系
- 使用 lazy init 减少首帧
- 把网络请求延后
- 把 analytics 延后
- 把 crash SDK 延后
- 保证必要配置优先
- 使用 FutureBuilder 慎重
- 缓存配置可以同步读取
- 依赖注入可提前构建
- 使用同步 I/O 会卡主线程
- initState 中的耗时需分拆
- isolate 可做重活
- isolate 与 UI 线程通信需 port
- isolate 适合 CPU 密集任务
- isolate 创建有开销

## 35. Shader 与 SkSL
- shader 编译可能导致首帧卡顿
- 使用 shader warmup
- sksl 记录并预热
- 预热需在 profile 收集
- 预热文件随应用发布
- 预热可减少 jank
- 仍需注意 GPU 差异
- shader 缓存依赖驱动
- 复杂动画更易触发编译
- 使用 Impeller 可消除运行时 shader 编译
- Impeller 在构建期预编译着色器
- SkSL 预热只对 Skia 后端有意义
- Impeller 仍需测试
- shader 预热不等于零卡
- 复杂渐变也会触发
- 监控 ShaderCompilation events
- GPU 线程压力可见

自 Flutter 3.27 起 Impeller 已是 iOS 与 Android API 29+ 的默认渲染后端（iOS 上唯一支持、无法切回 Skia），着色器全部在引擎构建期预编译，运行时不再即时编译，因此 SkSL 收集与预热这一套只在使用 Skia 后端时才有意义。见 [Impeller 官方文档](https://docs.flutter.dev/perf/impeller)。

## 36. Debug/Profile/Release 差异
- Debug 使用 JIT
- Release 使用 AOT
- Debug 有 asserts
- Debug 有额外诊断开销
- Profile 介于两者之间
- JIT 支持 Hot Reload
- AOT 启动更快
- Release 帧率更高
- Debug 帧率不可靠
- Profile 用于性能分析
- Release 不启用 VM service
- Release 需要符号化
- Release 日志需谨慎
- Debug 中布局更严格
- 不同模式渲染时序略有差异

## 37. 热重载与热重启
- Hot Reload 保留 state
- 通过 reassemble 通知
- 仅替换类定义
- 不能改变静态初始化
- 不能修改 main
- Hot Restart 重建 isolate
- 状态全部清空
- 仍复用 engine
- 调试时注意状态不一致
- 大修改用 Restart
- 插件原生改动需重启
- 资源变更需重启
- 热重载不等于刷新页面
- reassemble 适合重置缓存
- reassemble 后也会补一个 warm-up 帧
- 热重载不影响 native

## 38. App 内存管理
- Dart GC 管理堆
- 大量对象会触发 GC
- 频繁分配影响性能
- ImageCache 持有图像
- 清理 cache 可能闪烁
- 使用 weak references 不常见
- isolate 与 UI 线程独立堆
- native 内存不受 Dart GC 管控
- GPU 纹理占用巨大
- 释放 texture 需要主动
- ListView item 缓存影响内存
- KeepAlive 过多会占用内存
- 使用 DevTools 查看内存
- 防止内存泄露
- dispose 必须释放资源

## 39. GC 与帧稳定性
- GC 可能引发 jank
- 频繁创建临时对象会触发 GC
- 减少 build 中分配
- 复用对象降低压力
- 大列表滚动易触发 GC
- 图片解码会增加内存峰值
- GC 的 stop-the-world 影响帧
- 使用 const 减少 new
- 适当缓存计算结果
- isolate 可分担压力
- 过大对象应避免
- 监控 GC 事件
- Profile 模式可观察
- Debug 模式 GC 行为不同
- 流式处理减少峰值

## 40. UI 线程工作负载
- UI 线程负责 build/layout/paint
- UI 线程也处理 input dispatch
- UI 线程也执行 Dart 逻辑
- 阻塞 UI 线程会卡顿
- 同步 I/O 是常见问题
- JSON 大解析应放 isolate
- 大计算应放后台
- 动画帧应保持轻量
- 使用 compute 进行后台
- 使用 SchedulerBinding.scheduleTask
- 避免在 build 中做网络请求
- initState 里避免长逻辑
- postFrame 回调避免重任务
- 关注 frame budget
- 使用 Timeline 追踪任务

## 41. Raster 线程负载
- Raster 线程处理绘制
- Shader 编译影响 raster
- 大量 Layer 增加负担
- 过多 Opacity/Clip 会影响
- 复杂 path 影响 raster
- blur/阴影开销大
- 图片缩放耗时
- 过大纹理影响 GPU
- 同时动画过多会卡
- 透明度叠加耗 GPU
- Skia backend 决定性能
- 使用 Impeller 可能更稳定
- 监控 raster time
- raster 超 16ms 掉帧
- 合成层数过多会卡

## 42. 合成层与 Layer 数量
- RepaintBoundary 会创建 layer
- Opacity/Transform 可能创建 layer
- Clip 可能创建 layer
- 过多 layer 增加合成成本
- 仅必要时创建 layer
- Flutter Inspector 可查看 layer
- 使用 RepaintBoundary 分隔热点
- Large repaint area 影响帧
- 过度拆分也不好
- 复杂层级影响 GPU
- 使用 DebugLayerTree 诊断
- 避免无意义 opacity
- 合成层影响内存
- 变换层也有开销
- layer tree 与 render tree 不同

## 43. FrameTiming 与性能指标
- FrameTiming 包含 build/layout/paint/raster
- addTimingsCallback 获取每帧
- 性能指标可上报
- Flutter DevTools 可分析
- 使用 PerformanceOverlay
- UI 和 raster 需同时关注
- 只看 FPS 不够
- build time 过长需优化布局
- raster time 过长需优化绘制
- 总 frame time > budget 会卡
- Profile 模式更准确
- Debug 不能作为依据
- 使用 timeline trace
- 监控 Jank 次数
- 监控 frame pacing

## 44. 帧率与刷新率
- 60Hz 每帧 16.67ms
- 90Hz 每帧 11.11ms
- 120Hz 每帧 8.33ms
- 高刷新更难保持
- 过度动画会掉帧
- 动画要避免大量重建
- 低端机更容易掉帧
- 使用 RepaintBoundary 优化
- 使用 const Widget
- 动画控制器节制
- 动画 curve 不影响时序
- 物理模拟可能耗时
- 使用 TickerProvider
- 关闭不可见动画
- 合理设置 FPS 目标

## 45. 系统 API 与场景触发
- addPostFrameCallback 用于获取布局
- endOfFrame 用于等待渲染完成
- scheduleFrame 用于强制下一帧
- addTimingsCallback 用于性能监控
- platformDispatcher.onError 捕获平台错误
- WidgetsBindingObserver 监听生命周期
- SystemChannels.lifecycle 监听状态
- SystemChrome.setPreferredOrientations 经 metrics 变化间接触发重建
- MediaQuery 变化触发布局更新
- AccessibilityFeatures 变化触发重建
- Window metrics 改变触发重建
- Locale 变化触发 Localizations 更新
- Brightness 变化触发主题更新
- 文本缩放因子变化触发重建
- PointerDeviceKind 变化影响输入

## 46. 首屏路由与加载策略
- 最轻首屏是纯 UI
- 数据可用 skeleton
- 首屏请求可并行
- 使用 FutureBuilder 时注意 build
- 使用 StreamBuilder 可能频繁重建
- 使用 StatefulWidget 管理状态
- 先展示缓存数据
- 后台刷新再更新
- 避免首屏阻塞
- 图片延迟加载
- 长列表延迟构建
- 复杂组件延迟插入
- preload 需要控制并发
- 首屏动画简化
- 关注 TTI 指标

## 47. 事件与状态一致性
- 事件回调应检查 mounted
- 异步回调可能过期
- setState after dispose 会报错
- 使用 if (!mounted) return
- 避免在 build 中触发 side effect
- 在 initState 启动异步需谨慎
- 使用 cancelable operation
- 监听流需在 dispose 取消
- 计时器在 dispose 取消
- 手势回调不要重入
- 长任务需防抖
- 响应过快可能重复触发
- 使用 debouncer 管控
- 事件与 UI 更新应一致
- 处理异常避免崩溃

## 48. isolate 与并行计算
- isolate 是独立线程与堆
- UI isolate 与后台 isolate 隔离
- 通过 SendPort 传递消息
- 数据需可序列化
- 大对象传递有成本
- 适合 CPU 密集任务
- 不适合频繁小任务
- compute 是简化封装
- isolate 启动有开销
- isolate 崩溃需处理
- isolate 无法访问 UI
- isolate 无法直接使用插件
- 使用 BackgroundIsolateBinaryMessenger
- 控制 isolate 生命周期
- isolate 可用于预解析

## 49. 调试与诊断工具
- Flutter DevTools
- Timeline view
- Performance view
- Memory view
- CPU profiler
- Widget inspector
- Render tree inspection
- Repaint rainbow
- Slow animations
- Debug paint
- Debug profile paint
- showPerformanceOverlay
- traceStartup via --trace-startup
- VM Service（Observatory 已被其取代）
- 输出日志与 TAG
- 自定义 timeline events

## 50. 资源与包体
- Flutter build 打包 assets
- assets 列表在 pubspec
- font 注册在 pubspec
- 冗余资源增加包体
- asset 大小影响安装
- 使用压缩图片
- 避免无用字体
- 使用字体子集化
- 资源变体减少浪费
- 使用 webp/avif 视平台
- 资源加载会占 I/O
- 清理未使用资源
- 资源路径错误会导致黑屏
- 资源缺失会抛异常
- 使用 flutter_gen 管理

## 51. 引擎与框架边界
- 引擎处理渲染/输入/文本
- 框架处理 Widget/Element/State
- Dart:ui 是桥接层
- 框架调用引擎 API
- PlatformDispatcher 连接平台
- FlutterView 提供每个窗口的绘制表面
- Scheduler 连接 VSync
- SceneBuilder 构建 Scene
- PictureRecorder 生成绘制指令
- Engine 不理解 Widget
- Framework 不处理 GPU 细节
- 插件跨越两侧
- 线程边界需注意
- 框架升级可能影响行为
- 引擎版本影响渲染特性

## 52. 渲染与布局问题排查
- Overflow 由 layout 规则引起
- 约束不满足会报错
- 使用 Flexible/Expanded 解决
- 使用 LayoutBuilder 调试
- 使用 debugPaintSizeEnabled
- 使用 Inspector 查看约束
- RenderObject 报错需看 parentData
- Flex overflow 需看 mainAxisSize
- Stack 可能无限尺寸
- 使用 SizedBox 限制
- 使用 Align 限制
- 使用 Intrinsic 时性能下降
- 使用 ConstrainedBox 控制
- 关注多次 layout
- layout 循环会触发异常

## 53. 交互延迟与响应
- 触摸事件进入 UI 线程
- UI 线程忙会导致延迟
- 大 build 会延迟响应
- 大布局会延迟响应
- 复杂绘制会延迟响应
- 插件通道阻塞会延迟
- 使用 isolate 处理重任务
- 使用 scheduleTask 延后任务
- 事件回调要轻量
- 动画开始需及时
- 帧丢失会感觉卡顿
- 关注 input latency
- 使用 flutter_driver 测试响应
- 触摸 hitTest 过复杂也慢
- 避免层级过深

## 54. 动画系统要点
- AnimationController 驱动帧
- TickerProvider 提供 vsync
- 每帧调用 listener
- AnimatedBuilder 避免 setState
- Implicit animations 重建 widget
- 手动动画更灵活
- 多动画要管理生命周期
- 重复动画应暂停不可见
- offstage 可停动画
- AnimationStatus 监听结束
- Curve 影响动画速度曲线
- 使用 Tween 简化插值
- 大量动画会占用 UI 线程
- 与 scroll 结合需注意
- 复杂动画影响 raster

## 55. 列表虚拟化与回收
- ListView.builder 按需构建
- SliverList 支持懒加载
- itemExtent 提升性能
- keepAlive 保留状态
- AutomaticKeepAliveClientMixin
- 过多 keepAlive 占内存
- ReorderableList 依赖 key
- ScrollController 监听滚动
- ScrollNotification 触发 rebuild
- 过度监听影响性能
- 使用 const 子项减少 rebuild
- 使用 RepaintBoundary 分隔
- 复杂 item 需拆分
- 预估高度可优化 layout
- 复杂列表需分段加载

## 56. 触摸与鼠标差异
- PointerDeviceKind 区分输入
- 鼠标支持 hover
- 触摸有多指输入
- 右键需要 GestureDetector
- ScrollWheel 走 pointer signal
- 触摸与鼠标手势冲突
- HitTestBehavior 影响穿透
- Listener 更底层
- GestureDetector 更高级
- RawGestureDetector 适合复杂
- Focus 处理键盘输入
- FocusNode 管理焦点
- 键盘事件走 HardwareKeyboard（RawKeyboard 已废弃）
- 桌面平台有窗口变化
- 多窗口影响视图

## 57. 多窗口与 view
- Flutter 支持多 FlutterView
- 每个 view 有独立 metrics
- View.of(context) 获取当前 view
- Window 已逐步废弃
- 多窗口需考虑资源
- 多 view 共享 engine
- 事件与 view 关联
- 语义树也按 view 分离
- 多窗口适合桌面平台
- view 变化触发 rebuild
- 视图切换需保存状态
- 插件可能不支持多 view
- view 可能影响导航
- view 应正确识别 size
- 多 view 带来复杂性

## 58. 颜色与主题变更
- Theme 是 InheritedWidget
- 修改 Theme 触发依赖更新
- ThemeData 影响文本样式
- 颜色变更可能触发 repaint
- 深色模式切换会 rebuild
- 使用 Theme.of(context)
- 使用 ColorScheme 提升一致性
- 过度主题切换会卡顿
- 主题切换可动画
- themeAnimation 在 MaterialApp
- platformBrightness 变化触发
- MediaQuery 平台亮度影响
- 主题变化也影响 IconTheme
- 主题变化影响 TextTheme
- 主题变化影响默认组件

## 59. 国际化与本地化
- Localizations 是 InheritedWidget
- Locale 变化触发 rebuild
- 文本方向由 locale 决定
- 日期格式依赖 locale
- 字符串资源加载异步
- 文字宽度影响布局
- 语言长度变化需容忍
- RTL 需要适配
- 使用 TextDirection
- 使用 MaterialApp.localizationsDelegates
- 使用 supportedLocales
- localeResolutionCallback
- 本地化资源要缓存
- 本地化切换影响字体
- 注意 Emoji 与特殊字符

## 60. 网络与首屏数据
- 网络请求不应阻塞首帧
- 首屏先渲染占位
- 请求完成后更新
- 使用缓存快速显示
- 请求失败需降级
- 过多请求影响启动
- 合并请求减少开销
- 使用 HTTP keep-alive
- 解析 JSON 可放 isolate
- 避免在 build 中请求
- 使用 FutureBuilder 慎重
- 使用 repository 管理
- 使用 retry/backoff
- 网络慢时避免重复请求
- 使用 timeout 控制

## 61. Storage 与配置读取
- SharedPreferences 异步
- 初始化时避免阻塞
- 本地数据库需延迟
- 大量同步读写影响启动
- 读取配置可缓存
- 使用 mmap 需要慎重
- 大文件读取影响 IO
- 读取错误需降级
- 迁移任务需异步
- 版本升级可能触发迁移
- 本地存储影响内存
- 读写频繁需批量
- 事务操作减少碎片
- 使用 secure storage 会慢
- 加密操作需谨慎

## 62. 启动页与 Splash
- 原生启动页最先显示
- Flutter 首帧后覆盖
- 启动页应轻量
- 延迟首帧不等于加载
- 使用 flutter_native_splash
- 手动移除启动页
- 启动页与首屏风格一致
- 启动页过长影响体验
- 首帧慢会出现空白
- 使用 Warmup 减少白屏
- 首屏可显示 placeholder
- 首帧后再加载重组件
- 使用 Skeleton 提升体验
- 避免在启动页做逻辑
- 启动页不应请求网络

## 63. 渲染与可视化层
- RenderObject 负责绘制
- Layer tree 负责合成
- Scene 发送到 GPU
- Impeller/Skia 将绘制指令光栅化
- GPU 处理复杂路径
- 纹理与图层叠加
- 透明度会触发 layer
- Transform 会触发 layer
- 复杂裁剪影响 GPU
- 滤镜 blur 代价高
- Path 裁剪性能差
- 使用 ClipRect 优于 ClipPath
- 频繁 shader 触发 jank
- 合成层太多会卡
- 关注 DevTools layer tree

## 64. 可交互状态（TTI）
- 首帧显示不等于可交互
- TTI 指输入到响应
- 事件处理需 UI 线程空闲
- 异步任务阻塞影响 TTI
- 首帧后仍可能做初始化
- 将非关键任务延迟
- 使用 scheduleTask 优先级
- 使用 postFrame 处理小任务
- TTI 过慢用户感知差
- 监控首帧到可交互时间
- 自定义埋点记录 TTI
- 对比冷启动/热启动
- 记录不同设备差异
- 评估插件影响
- 使用 traceEvents 诊断

## 65. 帧合并与脏标记
- setState 仅标记 dirty
- dirty 元素在下一帧重建
- 同一帧多次 setState 合并
- markNeedsBuild 在 Element 层
- markNeedsLayout 在 RenderObject
- markNeedsPaint 在 RenderObject
- build 与 layout 可被跳过
- 重建不会直接创建 RenderObject
- updateRenderObject 仅更新属性
- 只有 dirty 才参与 pipeline
- 父节点变更可能影响子树
- Key 改变会触发重建
- GlobalKey 可触发 element 移动
- Element 生命周期管理状态
- reassemble 会重建子树

## 66. RenderObject 更新机制
- RenderObjectWidget.updateRenderObject
- 只更新属性不重建
- 属性变化标记 layout/paint
- ParentDataWidget 更新 parentData
- ParentData 更新触发布局
- ProxyWidget 不创建 renderObject
- RenderObjectElement 管理 attach/detach
- RenderObjectElement.updateChild
- RenderObjectElement.insertRenderObjectChild
- RenderObjectElement.removeRenderObjectChild
- RenderObject 生命周期较长
- RenderObject 复用提升性能
- 错误 parentData 会报错
- RenderObject 可在 debug 模式检查
- 渲染错误可定位到 RenderObject
- RenderObject 可用于自定义渲染

## 67. 自定义渲染管线点
- 自定义 RenderBox 需实现 layout/paint
- 自定义 hitTest 影响事件
- 自定义 dryLayout 提升性能
- 自定义 semantics 提升可访问性
- paint 使用 Canvas
- 需处理 constraints
- 需管理 child 布局
- 需管理 parentData
- 需正确 markNeedsLayout
- 需正确 markNeedsPaint
- 需处理 intrinsic size
- 需处理 overflow
- 需处理 alignment
- 需处理 clip
- 需处理 debug paint

## 68. SceneBuilder 与 Layer
- SceneBuilder 收集 layer
- layer append 到 scene
- pushTransform/pushClipRect
- pushOpacity/pushShaderMask
- addPicture 添加绘制指令
- addTexture 用于 platform texture
- pop 结束 layer
- Layer 提升合成效率
- Layer 过多会卡顿
- Layer 影响内存
- Layer 适合隔离 repaint
- Scene 构建在 UI 线程
- Raster 读取 scene
- Scene 不等于 widget
- Scene 与 view 关联

## 69. Time 与 frame pacing
- VSync 驱动帧节奏
- beginFrame 收到时间戳
- Scheduler 使用 timeStamp
- Animations 依赖 timeStamp
- frame jitter 会影响动画
- 设备繁忙会丢帧
- CPU governor 影响帧
- Thermal throttling 影响性能
- 帧间隔不稳定会抖动
- 使用 FrameTiming 观察
- 使用 tracing 观察 jank
- 使用 Impeller 可改善 pacing
- 合成队列过深会延迟
- 优化 build 与 raster 同等重要
- 帧延迟影响响应

## 70. 指标与埋点
- 记录 TTF
- 记录 TTI
- 记录首帧耗时
- 记录首屏渲染耗时
- 记录网络首响应
- 记录 crash 与异常
- 记录内存峰值
- 记录 GPU/CPU 使用
- 记录 frame drop
- 记录页面加载时间
- 记录 route 切换时间
- 记录图片解码耗时
- 记录 shader 编译次数
- 记录插件初始化耗时
- 记录冷启动/热启动
- 使用 Timeline.startSync

## 71. 常见卡顿原因
- 大量同步 I/O
- 大量 JSON 解析
- 复杂布局
- 过多 rebuild
- 图片解码过大
- shader 编译
- 过多 layer
- 过多透明度与 blur
- 列表 item 太复杂
- 频繁 setState
- 不可见动画未停止
- 平台通道阻塞
- 插件初始化过重
- 大量 GC
- 线程竞争

## 72. 优化策略速记
- 分离首屏与非首屏
- 延迟非关键初始化
- 预加载资源
- 缓存网络数据
- 使用 const
- 减少 build 内分配
- 采用细粒度状态
- 使用 RepaintBoundary
- 避免 Intrinsic
- 控制图片尺寸
- 预热 shader
- 使用 profile 诊断
- 监控 frame times
- 使用 isolate 处理重任务
- 避免大平台视图

## 73. 与系统交互细节
- 系统旋转触发 metrics 变化
- 键盘弹出影响 viewInsets
- 安全区变化影响 padding
- 深色模式触发 brightness
- 语言变更触发 locale
- 多窗口变化触发 metrics
- 截图/录屏可能影响性能
- 低电量可能降低刷新率
- 后台权限影响插件
- 系统内存压力回调
- didHaveMemoryPressure 触发
- 可清理 ImageCache
- 低内存需降级资源
- 通知/推送可拉起 app
- 冷启动带入 intent

## 74. 框架与引擎版本差异
- 引擎更新可能改变渲染路径
- 新版可能引入 Impeller
- 新版可能优化 text layout
- 新版可能修改 thread model
- 框架更新可能调整 bindings
- 版本差异可能影响性能
- 插件兼容性随版本变化
- API 弃用需注意
- dart 版本影响性能
- 关注 release notes
- 新版可能改变 default behaviors
- 版本升级需要回归测试
- 新版可能优化启动时间
- 新版可能影响 shader
- 版本差异需记录

## 75. 进入交互后的循环
- 输入事件不断进入
- 状态不断更新
- 渲染管线持续运行
- 帧率取决于负载
- UI 与 IO 交替工作
- 事件触发 rebuild
- 交互驱动动画
- 资源加载可能继续
- 运行时可动态调整
- 后台任务可能执行
- 内存回收持续发生
- 设备条件改变会影响
- 生命周期变化会中断
- 应用可能被系统回收
- 进程可被杀死

## 76. 启动路径（Android 细节）
- Activity 创建
- attachBaseContext
- onCreate
- onCreate 中创建（或取缓存）FlutterEngine
- 首个引擎会加载 libflutter.so 并启动 Dart VM
- configureFlutterEngine 注册插件
- onStart/onResume
- FlutterView attach
- 渲染 surface 创建
- executeDartEntrypoint 执行 main
- VSync 绑定
- 输入通道建立
- PluginRegistry 初始化
- 生命周期回调绑定
- 首帧渲染
- onPostResume
- 用户交互开始
- 返回键处理
- onPause/onStop 触发

可对照官方 [Add a Flutter screen to an Android app](https://docs.flutter.dev/add-to-app/android/add-flutter-screen)：每个 FlutterActivity 默认创建自己的 FlutterEngine，有不可忽略的预热成本；可提前在 Application 中创建并缓存引擎（FlutterEngineCache/FlutterEngineGroup）来缩短可见延迟。插件的自动注册发生在 onCreate 阶段的 configureFlutterEngine 中，早于 onStart 里 Dart 入口的执行。

## 77. 启动路径（iOS 细节）
- UIApplicationMain
- AppDelegate didFinishLaunching
- FlutterEngine 创建
- FlutterViewController 初始化
- 创建 FlutterView
- 添加到窗口
- viewDidLoad
- viewWillAppear
- viewDidAppear
- 输入通道建立
- Plugin 注册
- VSync 绑定
- 首帧渲染
- 进入前台交互
- applicationDidEnterBackground
- applicationWillTerminate

## 78. 文本输入与键盘
- TextField 绑定 TextInput
- 平台弹出键盘
- TextInputChannel 通信
- 更新编辑状态
- 光标位置同步
- 选择菜单通过平台
- 输入法联想通过平台
- 软键盘影响 viewInsets
- MediaQuery 更新布局
- 键盘弹出触发 rebuild
- 输入法切换触发重建
- 硬件键盘走 HardwareKeyboard（RawKeyboard 已废弃）
- FocusNode 控制焦点
- FocusScope 管理焦点
- 输入系统与语义协作

## 79. 渲染异常与崩溃
- assert 只在 debug
- RenderFlex overflow 会报错
- parentData 不匹配会抛异常
- hitTest 断言可能失败
- build 中抛异常导致红屏
- paint 中异常会影响渲染
- platform channel 异常需捕获
- 错误可能导致白屏
- 记录错误堆栈
- 线上需上报 crash
- 监控发生率
- 出现异常需降级
- 自定义 error widget
- 使用 FlutterError.onError
- 使用 ErrorWidget.builder

## 80. 细节补充清单
- const 构造可避免 rebuild
- Key 不滥用
- GlobalKey 有成本
- Use const for static icons
- List item 应稳定 key
- build 中避免 new controller
- controller 应在 initState
- dispose 必须释放
- AnimationController 需 dispose
- StreamSubscription 需 cancel
- Timer 需 cancel
- FocusNode 需 dispose
- TextEditingController 需 dispose
- ScrollController 需 dispose
- 资源释放避免泄露
- 使用 mounted 检查

## 81. 1000 行要求说明
- 本文以短句覆盖大量细节
- 每行一个要点
- 避免长段落
- 适合快速检索
- 面向系统底层查漏补缺
- 强调启动到交互全链路
- 保留框架与引擎边界
- 包含性能与优化要点
- 包含常见坑与排查方向
- 包含平台差异与版本差异
- 可按需裁剪或重组
- 可作为团队内部手册
- 可映射到具体问题排查
- 可结合 DevTools 进一步验证
- 可作为面试复习清单
