# Flutter Binding API 速查

下面把 **Flutter 中与图片/缓存/性能/生命周期相关的 Binding 类** 以及 **常用方法** 整理成速查表。  
示例可直接粘进项目使用，注意部分 API 仅适合调试或特定场景。

---

### 📌 1. PaintingBinding（图片 & GPU）
| 方法                                                         | 作用                                    | 示例                            |
| ------------------------------------------------------------ | --------------------------------------- | ------------------------------- |
| `PaintingBinding.instance.imageCache`                        | 全局 **内存 LRU 图片缓存**              | 查看/调整容量、手动驱逐         |
| `PaintingBinding.instance.imageCache.evict(key)`             | 把指定 key 的图片从 **内存** 移除       | `await provider.obtainKey(...)` |
| `PaintingBinding.instance.imageCache.clear()`                | 清空整个 ImageCache（不含正在使用的图） | 临时救急                        |
| `PaintingBinding.instance.imageCache.clearLiveImages()`      | 立即释放所有 **正在显示** 的 `ui.Image` | 内存警告时调用                  |
| `PaintingBinding.instance.imageCache.maximumSize = 100`      | 调整 **最多缓存多少张**                 | 默认 1000                       |
| `PaintingBinding.instance.imageCache.maximumSizeBytes = 50 << 20` | 调整 **最多缓存多少字节**               | 默认 100 MB                     |
| `PaintingBinding.instance.imageCache.statusForKey(key)`      | Debug：查看某张图在不在缓存             | 打印调试信息                    |

> 图片缓存 key 通常来自 `ImageProvider.obtainKey`。  
> 建议搭配 `cacheWidth/cacheHeight` 或 `ResizeImage` 控制解码尺寸，减少内存峰值。  
> **注意**：`imageCache` 只在 PaintingBinding 上（`WidgetsBinding` 并未混入它），也可以用 `painting.dart` 暴露的顶层 `imageCache` getter 访问。

---

### 📌 2. ServicesBinding & 系统回调（内存警告监听走 WidgetsBinding）
| 方法 / 用法                                                 | 作用               | 示例                           |
| ----------------------------------------------------------- | ------------------ | ------------------------------ |
| `WidgetsBinding.instance.addObserver` / `removeObserver`（参数是 `WidgetsBindingObserver`） | 监听 **内存警告、生命周期、深浅色、locale** 等 | 覆写 `didHaveMemoryPressure()` 后执行 `clearLiveImages()` |
| `ServicesBinding.instance.defaultBinaryMessenger`           | 默认平台通道收发器 | 发送自定义平台消息（极少用到） |
| `SystemChannels.lifecycle`                                  | 生命周期平台通道   | 仅底层使用                     |

> 内存警告的链路：引擎经 `SystemChannels.system` 发来 `memoryPressure` 消息 → `ServicesBinding.handleSystemMessage` → `WidgetsBinding.handleMemoryPressure` → 逐个通知观察者的 `didHaveMemoryPressure()`。

---

### 📌 3. WidgetsBinding（生命周期 & 帧回调）
| 方法                                                       | 作用                  | 示例                                 |
| ---------------------------------------------------------- | --------------------- | ------------------------------------ |
| `WidgetsBinding.instance.addPostFrameCallback((_) => ...)` | 在布局完成后执行一次  | 计算 item 偏移                       |
| `WidgetsBinding.instance.endOfFrame`                       | 等待当前帧结束        | 依赖布局结果                         |
| `View.of(context).physicalSize`                            | 获取 **物理像素尺寸** | 与 `devicePixelRatio` 一起算逻辑高度 |
| `View.of(context).devicePixelRatio`                        | 获取 **像素比**       | 用于 `memCacheWidth` 计算            |

> 帧回调与调度方法（`addPersistentFrameCallback`、`scheduleFrame` 等）实际定义在 `SchedulerBinding` 上，`WidgetsBinding` 混入了它，因此都能通过 `WidgetsBinding.instance` 访问。

---

### 📌 4. SchedulerBinding（帧回调 & 性能调度）
| 方法                                           | 作用             | 示例        |
| ---------------------------------------------- | ---------------- | ----------- |
| `SchedulerBinding.instance.addTimingsCallback` | 监听每帧耗时     | 做 FPS 监控 |
| `SchedulerBinding.instance.scheduleTask`       | 把任务放到空闲帧 | 避免卡顿    |

---

### 📌 5. GestureBinding（手势）
| 方法                                                   | 作用         | 示例     |
| ------------------------------------------------------ | ------------ | -------- |
| `GestureBinding.instance.pointerRouter.addGlobalRoute` | 全局手势拦截 | 极少用到 |

---

### 📌 6. RendererBinding（渲染树）
| 方法                                              | 作用                     | 示例                               |
| ------------------------------------------------- | ------------------------ | ---------------------------------- |
| `RendererBinding.instance.renderViews`            | 所有渲染树根 RenderObject | 调试渲染树（旧单数 `renderView` 已废弃） |
| `RendererBinding.instance.rootPipelineOwner`      | PipelineOwner 树的根     | 极少直接调（旧 `pipelineOwner` 已废弃） |
| `RendererBinding.instance.deferFirstFrame` / `allowFirstFrame` | 推迟/放行首帧 | 启动页预加载 |

---

### 📌 7. SemanticsBinding（可访问性）
| 方法                                      | 作用          | 示例                  |
| ----------------------------------------- | ------------- | --------------------- |
| `SemanticsBinding.instance`               | 可访问性绑定  | 仅需要时访问          |
| `PlatformDispatcher.instance.accessibilityFeatures` | 辅助功能状态 | 大字号/反色等适配 |

---

### 📌 8. 快捷记忆口诀
> **"想看图 → Painting，想算尺寸 → View，想等布局 → addPostFrameCallback，内存炸了 → clearLiveImages。"**

---

### 📌 9. 完整示例：内存警告一键清缓存

```dart
import 'package:flutter/services.dart';

class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didHaveMemoryPressure() {
    // 系统内存警告时自动清图（消息经 WidgetsBinding 分发到这里）
    PaintingBinding.instance.imageCache.clearLiveImages();
    PaintingBinding.instance.imageCache.clear();
  }

  @override
  Widget build(BuildContext context) => const MaterialApp(home: GalleryPage());
}
```

### 📌 10. 监控内存信息的常用插件

| 插件                                                  | 作用                                              | 引入方式                      |
| ----------------------------------------------------- | ------------------------------------------------- | ----------------------------- |
| [`memory_info`](https://pub.dev/packages/memory_info) | **一行代码**拿 **总内存 / 可用内存 / 低内存状态** | `flutter pub add memory_info` |

```dart
import 'package:memory_info/memory_info.dart';

final mem = await MemoryInfoPlugin().getMemoryInfo();
print('总内存: ${mem.totalMem}');
print('可用内存: ${mem.availMem}');
print('低内存: ${mem.lowMemory}');
```

---

### 📌 11. 参考

- [ImageCache 官方 API 文档](https://api.flutter.dev/flutter/painting/ImageCache-class.html)
- [PaintingBinding 官方 API 文档](https://api.flutter.dev/flutter/painting/PaintingBinding-class.html)
- [WidgetsBindingObserver.didHaveMemoryPressure](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver/didHaveMemoryPressure.html)
- [WidgetsBinding 官方 API 文档](https://api.flutter.dev/flutter/widgets/WidgetsBinding-class.html)

---

