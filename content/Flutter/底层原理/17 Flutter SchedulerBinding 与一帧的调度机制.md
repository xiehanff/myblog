# Flutter SchedulerBinding 与一帧的调度机制

## 概念总览

`SchedulerBinding` 是 Flutter 框架里负责 **帧调度、回调编排、任务优先级控制** 的核心入口，并不只是一个定时器。它把引擎侧的 `VSync` 信号、框架侧的 build/layout/paint 流程，以及动画、后帧回调、空闲任务串成了一条完整链路。

可以把它理解成三件事：

1. **接收帧信号**：引擎在合适的时机触发一帧，框架进入 `handleBeginFrame` 和 `handleDrawFrame`
2. **分发不同阶段的回调**：`transient callbacks`、`persistent callbacks`、`post-frame callbacks`
3. **安排非渲染任务**：通过 `scheduleTask` 在帧与帧之间按优先级运行短任务

这也解释了几个常见现象：

- `setState` 不会立刻改变屏幕像素，它只是标记需要重建，真正的更新发生在后续帧里
- 动画必须依赖 `VSync`，因为动画要按显示刷新节奏去取样，避免乱跳、撕裂和无意义的空转
- `addPostFrameCallback` 适合做“这一帧渲染完成之后”的事，而不是拿来做循环动画或频繁刷新

状态变化只是“申请一帧”，`SchedulerBinding` 负责把申请变成真正的 `build → layout → paint`，而这一切都以 VSync 为节拍。下文先看一帧的完整流程，再逐个拆解每类回调的语义与边界。

## 核心流程

Flutter 的一帧通常可以理解为下面这条链：

```text
setState / 动画 tick / 其他事件
    ↓
scheduleFrame / ensureVisualUpdate
    ↓
引擎在 VSync 到来时触发 onBeginFrame
    ↓
SchedulerBinding.handleBeginFrame()
    ↓
执行 transient callbacks
    ↓
处理 transient callbacks 产生的 microtasks（midFrameMicrotasks 阶段）
    ↓
引擎触发 onDrawFrame
    ↓
SchedulerBinding.handleDrawFrame()
    ↓
执行 persistent callbacks
    ↓
WidgetsBinding.drawFrame()
    ↓
build → layout → paint → compositing
    ↓
执行 post-frame callbacks
    ↓
当前帧结束
```

### 1. 触发下一帧

当状态变化、动画启动或渲染对象需要刷新时，框架会尝试调用 `scheduleFrame()` 或 `ensureVisualUpdate()` 请求下一帧。

常见触发来源包括：

- `State.setState()` 导致 `markNeedsBuild`
- `RenderObject.markNeedsLayout()` / `markNeedsPaint()`
- `Ticker` / `AnimationController` 开始运行
- `scheduleFrameCallback()` 注册了新的 transient callback

要点是：**调用这些 API 并不会立刻重绘，只是让框架在下一帧处理更新**。  
所以 `setState` 的效果不会在当前函数栈里立刻体现在屏幕上。

另一个关键点是**请求会被去重，一帧只向引擎申请一次**。`scheduleFrame()` 内部靠 `_hasScheduledFrame` 标志挡住重复请求：

```dart
// flutter/packages/flutter/lib/src/scheduler/binding.dart（节选）
void scheduleFrame() {
  if (_hasScheduledFrame || !framesEnabled) {
    return; // 已经申请过，或当前不允许出帧（比如应用退到了后台）
  }
  ensureFrameCallbacksRegistered();
  platformDispatcher.scheduleFrame(); // 向引擎请求下一次 VSync
  _hasScheduledFrame = true;
}
```

`_hasScheduledFrame` 会在下一帧的 `handleBeginFrame()` 开头被重置为 false，之后才能再次申请。`framesEnabled` 由应用生命周期控制：`paused / hidden / detached` 时为 false，退到后台就不会继续空转刷帧；回到前台时会自动再 `scheduleFrame()` 补一帧。

`ensureVisualUpdate()` 在这之上还多一层保护：它先看 `schedulerPhase`，只有处于 `idle` 或 `postFrameCallbacks` 阶段才真正调 `scheduleFrame()`，一帧正在处理中时它是空操作。这就是“同一帧里调用一百次 `setState`，也只会产出一帧”的底层保证。

### 2. `handleBeginFrame`

`handleBeginFrame` 是引擎在一帧开始时调用框架的入口。它主要负责：

- 计算当前帧时间戳
- 执行所有 `transient callbacks`
- 让 transient callbacks 里触发的 microtask 先跑完
- 再进入 `handleDrawFrame`

`transient callbacks` 是“这一帧的临时回调”，典型来源是：

- `SchedulerBinding.scheduleFrameCallback`
- `Ticker` 的 tick
- `AnimationController` 的帧驱动

这也是动画同步的关键点：**多个动画在同一个帧时间戳下执行，所以它们天然是对齐的**。  
官方动画文档里也明确说明了，`SchedulerBinding` 会把 begin frame 事件分发给注册的回调，而 `Ticker` 正是挂在这一机制上的。

`SchedulerBinding` 把“当前走到一帧的哪一步”暴露为 `SchedulerPhase` 枚举，取值顺序与实际发生顺序一致：

1. `idle`：帧与帧之间，事件、Timer、低优先级任务都可以跑
2. `transientCallbacks`：正在执行 transient callbacks（`handleBeginFrame` 内）
3. `midFrameMicrotasks`：transient callbacks 期间产生的 microtask 正在执行
4. `persistentCallbacks`：正在执行 persistent callbacks（build / layout / paint）
5. `postFrameCallbacks`：正在执行 post-frame callbacks（`handleDrawFrame` 末尾）

**容易忽略的是 `midFrameMicrotasks` 这一档**：microtask 不是“随便找个空隙”执行的，它们被明确安排在 transient callbacks 结束之后、引擎回调 `onDrawFrame`（也就是 persistent callbacks 开始）之前。`handleBeginFrame` 在 `finally` 里把阶段切到 `midFrameMicrotasks`，方法返回后引擎先排空 microtask 队列，再调用 `onDrawFrame`。所以在 transient callback 里 `await` 之后的续体，会在这一帧的 build/layout 之前执行完。

### 3. `handleDrawFrame`

`handleDrawFrame` 在 `handleBeginFrame` 之后执行。它做两件大事：

1. 执行 `persistent callbacks`
2. 执行 `post-frame callbacks`

在 Flutter Widgets 体系里，最重要的 persistent callback 就是 `WidgetsBinding.drawFrame()`。它负责把 build、layout、paint、合成这一整套渲染管线跑完。

可以把这一段理解成：

```text
persistent callbacks
    ↓
WidgetsBinding.drawFrame()
    ↓
重建需要刷新的 Widget
    ↓
更新 Element
    ↓
推动 RenderObject 完成布局和绘制
```

### 4. `post-frame callbacks`

当主渲染管线跑完后，框架再执行 `addPostFrameCallback` 注册的回调。

这个阶段适合做：

- 读取布局结果，比如 `context.size`
- 首帧渲染后再执行跳转、弹窗、滚动定位
- 等待 UI 已经出现在屏幕上后再做一次性收尾逻辑

不适合做：

- 需要持续执行的动画
- 依赖取消机制的长任务
- 频繁触发的状态同步

原因很简单：`addPostFrameCallback` **只执行一次，且不能取消**。  
它的语义是“当前帧结束后补一刀”，不是“每帧都帮我跑”。

### 5. 帧之间的任务调度

`SchedulerBinding.scheduleTask` 处理的是 **非渲染任务**，它会在帧与帧之间按 `Priority` 和当前 `schedulingStrategy` 决定是否执行。

这部分很重要，因为它说明 `SchedulerBinding` 处理的不只是“帧回调”，还包括：

- `touch`
- `animation`
- `idle`

也就是说，框架会尽量先让影响交互和动画的工作跑完，再考虑低优先级任务。  
所以它是一个“帧调度 + 任务优先级”的系统，而不是一个简单的定时器壳子。

## 关键对象 / 接口

### `SchedulerBinding`

`SchedulerBinding` 是调度核心，常见能力包括：

- `scheduleFrame()`：请求下一帧
- `scheduleTask()`：提交带优先级的任务
- `scheduleFrameCallback()`：注册 transient callback
- `addPersistentFrameCallback()`：注册持续回调
- `addPostFrameCallback()`：注册帧尾回调
- `handleBeginFrame()` / `handleDrawFrame()`：一帧的两个关键入口
- `endOfFrame`：等待当前帧结束

它的职责是把不同阶段的工作按正确顺序放进帧里，并不直接画 UI。

### `handleBeginFrame` / `handleDrawFrame`

- `handleBeginFrame`：开始一帧，先跑 transient callbacks
- `handleDrawFrame`：继续一帧，跑 persistent callbacks 和 post-frame callbacks

这两个方法的组合，构成了 Flutter 每一帧的主骨架。

### `transient callbacks`

特点：

- 由 `scheduleFrameCallback()` 注册
- 主要用于动画和一次性帧任务
- 每帧开始时执行
- 如果在当前帧动画阶段又注册，通常会顺延到下一帧

适合的场景：

- `Ticker`
- `AnimationController`
- 需要精确对齐帧时间戳的工作

### `persistent callbacks`

特点：

- 由 `addPersistentFrameCallback()` 注册
- 每一帧都会执行
- 不能注销
- 典型用途是驱动渲染管线

在 Widgets 体系里，这类回调最终会把 `build → layout → paint` 推起来。

### `post-frame callbacks`

特点：

- 由 `addPostFrameCallback()` 注册
- 在当前帧主流程完成后执行
- 只执行一次
- 不能取消

最典型用途是“依赖布局结果的后置逻辑”。

### `Ticker`

`Ticker` 的官方定义就是：**在启用时，每个动画帧调用一次回调**。  
它通过 `scheduleFrameCallback()` 参与帧驱动，所以动画天然和 VSync 对齐。

这也是 `AnimationController` 的底层工作方式：  
`AnimationController` 借助 `Ticker` 跟着帧走，并没有另找一个计时器打点。

### `Priority`

`Priority` 用来描述 `scheduleTask()` 的任务优先级。三个内置档位从低到高：

- `Priority.idle`（0）
- `Priority.animation`（100000）
- `Priority.touch`（200000）

默认的调度策略 `defaultSchedulingStrategy` 是：只要还有 transient callback 注册着（说明动画在跑），优先级低于 `animation` 的任务就不会执行。它表达的是：**不同任务在帧间隙里该不该先跑、先跑谁**。

### `scheduleFrame()`

`scheduleFrame()` 会向引擎请求一帧。真正的帧仍然要等下一次 VSync 或引擎可用时机到来。  
它不是“立刻执行 build”，只是告诉引擎：**请尽快安排下一帧**。

## 常见误区

### 1. `SchedulerBinding` 只是定时器

不是。

定时器是按时间间隔触发，`SchedulerBinding` 是按 **帧** 和 **优先级** 调度。  
前者关注“多久触发一次”，后者关注“这一帧里先做什么、后做什么、哪些工作等空闲再做”。

### 2. `setState` 会立刻刷新屏幕

不会。

`setState` 的实际行为是：

1. 同步执行你传入的回调
2. 调用 `Element.markNeedsBuild`
3. 把这个 Element 标记为 dirty
4. 等下一帧统一重建

所以它改变的是“状态”和“重建请求”，不是“当前像素”。

### 3. 动画自己用 `Timer.periodic` 就够了

不够稳。

`Timer` 不知道当前显示器刷新节奏，也不和帧时间戳对齐。  
动画要的是“跟屏幕同步”，而不是“隔固定毫秒跑一次”。  
所以 `Ticker` 才是动画的正确底层接口。

### 4. `addPostFrameCallback` 可以拿来做循环刷新

不建议。

它是一次性的，且不能取消。  
如果你需要持续响应帧，应该用 `Ticker`、`AnimationController`、`scheduleFrameCallback` 或状态驱动的正常渲染流程。

### 5. 在 `build()` 里直接做依赖布局结果的逻辑

通常不对。

`build()` 阶段还没完成布局和绘制，很多尺寸信息还不稳定。  
如果你要读取尺寸、滚动到某个位置、或弹首帧提示，应该放到 `addPostFrameCallback`。

### 6. `scheduleTask` 可以替代 UI 更新

不可以。

`scheduleTask` 面向的是帧间隙里的后台型小任务，不是替代 `setState`、`markNeedsBuild` 或渲染管线的接口。

## 面试问法 / 性能点

### 面试常问 1：`setState` 为什么不会立刻生效？

核心答案：

- `setState` 只会调用 `Element.markNeedsBuild`
- `markNeedsBuild` 只是把 Element 加到待重建队列
- 真正的 rebuild 发生在下一帧的 `buildScope`
- 最终要等 `handleBeginFrame` / `handleDrawFrame` 驱动完整帧流程

### 面试常问 2：为什么动画要依赖 VSync？

核心答案：

- VSync 代表显示刷新节奏
- 动画如果跟帧对齐，时间戳统一，多个动画更容易同步
- 这样能减少无意义的中间帧和撕裂感
- `Ticker` 就是挂在帧机制上的动画驱动器

### 面试常问 3：`transient`、`persistent`、`post-frame` 的区别？

可以直接这样回答：

- `transient`：每帧开始时执行，适合动画和一次性帧任务
- `persistent`：每帧都执行，适合驱动渲染管线
- `post-frame`：渲染完成后执行，适合依赖布局结果的收尾逻辑

### 面试常问 4：`addPostFrameCallback` 的正确使用场景是什么？

常见正确场景：

- 首帧后弹窗
- 首帧后滚动定位
- 首帧后读取 `context.size`
- 依赖 build/layout 完成后做一次性逻辑

不正确场景：

- 循环动画
- 轮询刷新
- 替代业务状态流转

### 性能点 1：减少同一帧内重复 `setState`

`setState` 本身开销不大，但它会推动后续 rebuild / layout / paint。  
如果短时间内重复调用，最终浪费的是整条渲染链路的成本。

### 性能点 2：把非 UI 任务放到低优先级调度

`scheduleTask` 的意义在于：  
不要让图片处理、埋点整理、缓存清理这类工作抢占动画和交互的帧预算。

### 性能点 3：关注帧时间，而不是只看 build

一帧慢，不一定只是 build 慢，也可能是：

- build 过重
- layout 层级复杂
- paint/raster 过慢
- 帧间任务抢占 CPU

所以排查性能问题时，要结合 `FrameTiming`、`addTimingsCallback` 和 DevTools 的帧时间线一起看。

## 参考

### 官方文档

- [SchedulerBinding mixin](https://api.flutter.dev/flutter/scheduler/SchedulerBinding-mixin.html)
- [SchedulerPhase enum](https://api.flutter.dev/flutter/scheduler/SchedulerPhase.html)
- [handleBeginFrame](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/handleBeginFrame.html)
- [handleDrawFrame](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/handleDrawFrame.html)
- [ensureVisualUpdate](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/ensureVisualUpdate.html)
- [scheduleFrameCallback](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/scheduleFrameCallback.html)
- [addPersistentFrameCallback](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPersistentFrameCallback.html)
- [addPostFrameCallback](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html)
- [scheduleFrame](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/scheduleFrame.html)
- [scheduleTask](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/scheduleTask.html)
- [Priority class](https://api.flutter.dev/flutter/scheduler/Priority-class.html)
- [Ticker](https://api.flutter.dev/flutter/scheduler/Ticker-class.html)
- [Flutter 动画架构概览](https://docs.flutter.dev/ui/animations/overview)

