# `WidgetsBinding` 使用场景

`WidgetsBinding` 是 Flutter 启动后最先就位的"总管家"单例（`WidgetsBinding.instance`），它本身是一个 mixin，组合了 `ServicesBinding`、`SchedulerBinding`、`GestureBinding`、`RendererBinding`、`SemanticsBinding` 的能力。这意味着：帧调度、生命周期、手势竞技场、渲染树等入口都能从 `WidgetsBinding.instance` 一路访问到，但每个 API 真正的"归属类"不同——下面每节都会标注，便于查阅官方文档。

### 1. 帧相关（多数定义在 SchedulerBinding）
```dart
// 下一帧渲染完成后执行一次（只触发这一次，没有对应的移除 API）
WidgetsBinding.instance.addPostFrameCallback((_) {
  // 适合拿布局尺寸、滚动到目标位置等
});

// 每一帧都执行（谨慎使用）
WidgetsBinding.instance.addPersistentFrameCallback((_) {
  // 注册后无法移除！框架内部的 build/layout/paint 流程
  // 本身就注册在这里，业务代码几乎不需要自己注册
});

// 请求引擎调度新帧
WidgetsBinding.instance.scheduleFrame();

// 等待当前帧完成（本质是注册一个 post-frame 回调并等待）
await WidgetsBinding.instance.endOfFrame;
```

三类帧回调的区别值得记牢：

| 类型 | 注册 API | 移除方式 | 典型用途 |
| --- | --- | --- | --- |
| transient | `scheduleFrameCallback`（SchedulerBinding） | `cancelFrameCallbackWithId(id)` | 动画 tick（Ticker 内部使用） |
| persistent | `addPersistentFrameCallback` | **不可移除** | 框架 build/layout/paint 流程（`WidgetsBinding.drawFrame` 就注册在此） |
| post-frame | `addPostFrameCallback` | 无法移除，但只执行一次 | 首帧测量、滚动定位 |

### 2. 生命周期相关（WidgetsBindingObserver）
```dart
class AppLifecycleObserver with WidgetsBindingObserver {
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // resumed / inactive / hidden / paused / detached
  }
}

// 注册/移除观察者（必须成对出现，注意保存同一个实例）
final observer = AppLifecycleObserver();
WidgetsBinding.instance.addObserver(observer);
WidgetsBinding.instance.removeObserver(observer);
```

`AppLifecycleState` 在 3.13 后新增了 `hidden`（介于 inactive 和 paused 之间，表示所有视图均不可见但仍在运行）。

如果只想监听个别状态，3.13+ 提供了回调式的 [AppLifecycleListener](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html)，无需自己管理 observer 注册：

```dart
final listener = AppLifecycleListener(
  onResume: () { /* 回到前台 */ },
  onHide: () { /* 进入 hidden */ },
  onExitRequested: () async => AppExitResponse.exit,
);
// 不再需要时：listener.dispose();
```

`WidgetsBindingObserver` 还能覆写 `didHaveMemoryPressure`（内存警告）、`didChangeMetrics`（尺寸变化）、`didChangePlatformBrightness`（深浅色切换）、`didChangeLocales`（语言区域变化）等方法，通知来源都是 `WidgetsBinding.instance.addObserver` 注册的这批观察者。

### 3. 平台/窗口相关
```dart
// 推荐使用 View / MediaQuery 获取窗口信息
final view = View.of(context);
final size = view.physicalSize;
final dpr = view.devicePixelRatio;

final padding = MediaQuery.of(context).padding;

// 需要全局访问时可用 platformDispatcher（定义在 BindingBase 上）
final dispatcher = WidgetsBinding.instance.platformDispatcher;
```

### 4. 初始化相关
```dart
// 确保 Flutter 初始化完成
WidgetsFlutterBinding.ensureInitialized();

// 首帧控制（用于启动页或预加载，定义在 RendererBinding 上）
WidgetsBinding.instance.deferFirstFrame();
WidgetsBinding.instance.allowFirstFrame();
```

**关键认知**：`deferFirstFrame` 内部是计数器，可以嵌套多次调用，只有等 `allowFirstFrame` 把计数减到零才会真正放行首帧；且它只对**首帧**有效——首帧已经发送后再调用没有任何效果。

### 5. 渲染树相关（定义在 RendererBinding 上）
```dart
// 获取所有渲染树根节点（多窗口场景下可能不止一个）
final renderViews = WidgetsBinding.instance.renderViews;

// PipelineOwner 树的根节点，刷新/布局/绘制的调度入口
final rootPipelineOwner = WidgetsBinding.instance.rootPipelineOwner;
```

注意：旧代码里的 `renderView`（单数）、`pipelineOwner`、`renderViewElement` 从 3.10 起已陆续标记废弃，分别改用 `renderViews`、`rootPipelineOwner`、`rootElement`。

### 6. 手势相关（定义在 GestureBinding 上）
```dart
// GestureBinding 提供手势竞技场等能力
final gestureArena = WidgetsBinding.instance.gestureArena;
// 全局指针路由（监听所有指针事件时使用）
final pointerRouter = WidgetsBinding.instance.pointerRouter;
```

### 7. 调度相关（SchedulerBinding）
```dart
// 将任务安排到空闲时段（返回 Future，任务完成后完成）
SchedulerBinding.instance.scheduleTask(
  () {
    // 任务内容
  },
  Priority.animation,
);

// 监听每帧耗时
SchedulerBinding.instance.addTimingsCallback((timings) {
  // timings 是 List<FrameTiming>，可统计 FPS / 帧耗时
});
```

### 实际应用示例：
```dart
class MyWidget extends StatefulWidget {
  @override
  State<MyWidget> createState() => _MyWidgetState();
}

class _MyWidgetState extends State<MyWidget> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    
    // 注册观察者
    WidgetsBinding.instance.addObserver(this);
    
    // 添加帧回调
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 初始化完成后的操作
      print('Widget 渲染完成');
    });
  }
  
  @override
  void dispose() {
    // 移除观察者
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
  
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 监听应用生命周期变化
    switch (state) {
      case AppLifecycleState.resumed:
        print('应用进入前台');
        break;
      case AppLifecycleState.inactive:
        print('应用失去焦点但可见');
        break;
      case AppLifecycleState.hidden:
        print('应用所有视图不可见但仍在运行');
        break;
      case AppLifecycleState.paused:
        print('应用进入后台');
        break;
      case AppLifecycleState.detached:
        print('应用视图被销毁/引擎仍在运行');
        break;
    }
  }
  
  @override
  Widget build(BuildContext context) {
    return Container();
  }
}
```

这些方法在不同场景下都很有用：
1. 性能优化
2. 生命周期管理
3. 布局控制
4. 动画同步
5. 系统交互
6. 初始化控制

选择合适的方法取决于你的具体需求。

## 参考

- [WidgetsBinding 官方 API 文档](https://api.flutter.dev/flutter/widgets/WidgetsBinding-class.html)
- [WidgetsBindingObserver 官方 API 文档](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html)
- [AppLifecycleListener 官方 API 文档](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html)
- [SchedulerBinding 官方 API 文档](https://api.flutter.dev/flutter/scheduler/SchedulerBinding-class.html)
- [RendererBinding 官方 API 文档](https://api.flutter.dev/flutter/rendering/RendererBinding-class.html)

一句话总结：`WidgetsBinding.instance` 是所有 Binding 能力的统一入口，但记住每个 API 的真实归属类，才能在查阅文档和排障时找对地方。
