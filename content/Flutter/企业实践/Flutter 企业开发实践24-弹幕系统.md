---
title: Flutter 企业开发实践24-弹幕系统
date: 2026-08-22
tags: [Flutter, 面试, 组件封装, 弹幕, Ticker, 动画, 状态建模, 队列, 性能]
---

# 从 0 封装一套可复用的 Flutter 弹幕组件

弹幕组件要同时管这些事：消息进来、分配轨道、算碰撞间距、逐帧推进、离屏回收，还要能渲染任意 Widget。这些逻辑要是全塞进页面控制器，组件就没法复用，也没法单独测。

这一章我们从零写一个 `EnterpriseDanmu`，示例包名用 `enterprise_danmu`，你可以把它丢进任何 Flutter 工程里验证。

目标就四条：宿主不用自己创建状态控制器；运行时状态放在 Widget 内部；队列和轨道算法能脱离真实帧测试；公开 API 只表达发送和播放命令，别的不管。

文中代码片段省掉了跟结构无关的 import 和样式参数，当伪代码看就行；完整实现参照文末的组件结构，在示例工程里补齐后就能跑。

## 1. 先把“弹幕”拆成三种数据

弹幕系统里的数据分三种，生命周期各不相同：

| 数据 | 生命周期 | 责任 |
| --- | --- | --- |
| `DanmuConfig` | Widget 配置 | 轨道高度、数量、间距、默认速度和队列上限 |
| `DanmuEntry` | 一条消息 | id、Widget、预估宽度、速度、优先级和可选轨道 |
| `ActiveDanmu` | 渲染快照 | 当前轨道和 left 坐标，只读地交给 Widget |

消息对象里不存“是否已经显示”“是否暂停”这一堆布尔值。它在哪个集合里，就说明它处在哪个阶段：待布局、等待队列，还是活跃轨道。

## 2. 先定义宿主 API

```dart
final handle = DanmuHandle();

EnterpriseDanmu(
  handle: handle,
  config: const DanmuConfig(
    laneCount: 4,
    laneHeight: 38,
    laneSpacing: 12,
  ),
);

handle.send(
  DanmuEntry(
    id: 'message-1',
    width: 180,
    child: const Text('新的弹幕'),
  ),
);
```

组件对外只有四个命令：

```dart
handle.send(entry);
handle.play();
handle.pause();
handle.clear();
```

`DanmuHandle` 只是一个可选的命令桥，它自己并不装状态。页面上没有按钮，完全可以不给它；有按钮的时候，也不用去接管 `Ticker`、队列或者轨道列表。

## 3. 先把独立包的结构搭好

```text
your_danmu_package/
├── lib/
│   ├── enterprise_danmu.dart
│   └── src/
│       ├── danmu_engine.dart
│       └── danmu_widget.dart
└── test/
    └── danmu_engine_test.dart
```

入口文件保持稳定：

```dart
library enterprise_danmu;

export 'src/danmu_engine.dart';
export 'src/danmu_widget.dart';
```

引擎只依赖 Flutter 的值对象和通知，`Ticker` 和布局交给 Widget 层。这样一来，没有真机也能验证“消息有没有正确入队”。

## 4. 第一步：用枚举表达运行阶段

```dart
enum DanmuPhase {
  unconfigured,
  ready,
  playing,
  paused,
}

enum DanmuPriority { normal, high }

enum DanmuEnqueueResult {
  accepted,
  queued,
  pendingLayout,
  rejected,
}
```

弹幕引擎里不会同时挂着 `isPlaying`、`isPaused`、`hasLayout`、`isCleared` 这一堆组合状态。阶段是枚举，发送结果也是枚举，调用方照着四种情况处理就行：“已入轨”“已排队”“等待首帧布局”“队列已满”。

配置里的 `autoStart` 是单独一项，不参与运行阶段的组合判断；它只决定首次布局完成后是进 `playing` 还是 `ready`。

## 5. 第二步：定义消息和值对象

```dart
@immutable
class DanmuEntry {
  const DanmuEntry({
    required this.id,
    required this.child,
    required this.width,
    this.speed,
    this.priority = DanmuPriority.normal,
    this.laneHint,
  }) : assert(width > 0 && width != double.infinity);

  final String id;
  final Widget child;
  final double width;
  final double? speed;
  final DanmuPriority priority;
  final int? laneHint;
}
```

宽度让消息创建者给，这样就不用每一帧去量文字。固定卡片的宽度是常量；动态内容在进引擎之前量一次就行。

轨道状态使用内部对象保存：

```dart
class _DanmuItem {
  _DanmuItem({
    required this.entry,
    required this.lane,
    required this.left,
  });

  final DanmuEntry entry;
  final int lane;
  double left;
}
```

渲染层每次拿到的都是新生成的只读 `ActiveDanmu` 快照，碰不到引擎里的可变对象。渲染归渲染，调度归调度，两边是不同的对象。

## 6. 第三步：先写纯调度引擎

引擎的核心接口：

```dart
class DanmuEngine extends ChangeNotifier {
  DanmuEngine(DanmuConfig config) : _config = config;

  DanmuConfig _config;
  DanmuConfig get config => _config;

  void configure(Size size);
  DanmuEnqueueResult enqueue(DanmuEntry entry);
  void play();
  void pause();
  void clear();
  void advance(Duration elapsed);

  void updateConfig(DanmuConfig config);
}
```

时钟由 Widget 提供，引擎只收时间差。它自己不创建 `Ticker`，不调 `setState`，也不关心页面是不是用了 Material。

### 6.1 首次布局前的消息

按钮有可能在首帧布局之前就发消息。这类消息引擎先放进 `_pendingLayout`，等配置好尺寸再转进正式队列：

```dart
if (_size == Size.zero) {
  if (_pendingLayout.length >= config.maxQueueSize) {
    return DanmuEnqueueResult.rejected;
  }
  _pendingLayout.add(entry);
  return DanmuEnqueueResult.pendingLayout;
}
```

这比直接把消息丢掉好用，也比在发送方法里去读一个还没稳定的屏幕尺寸靠谱。

### 6.2 轨道数量由尺寸决定

```dart
final laneExtent = config.laneHeight + config.laneSpacing;
final laneCount = (size.height / laneExtent)
    .floor()
    .clamp(0, config.laneCount)
    .toInt(); // num.clamp 返回 num，赋给 int 必须显式转换
```

配置里的最大轨道数不会突破容器高度。`laneHeight` 管卡片占多高，`laneSpacing` 管相邻轨道之间留多少空，一条轨道的总占用高度是 `laneExtent = laneHeight + laneSpacing`。高度不够一条轨道就返回 0，消息继续留在队列里，免得渲染层越界；等空间恢复再入轨。轨道从 0 开始编号，渲染时用 `lane * laneExtent` 算顶部位置。

## 7. 第四步：轨道分配和碰撞间距

每条轨道至少得看一遍当前活跃项里最靠右的那个尾部，保证新弹幕出生的时候有 `gap`。要是允许每条消息速度不同，还得检查新消息会不会在旧消息离屏前追上它。你想，只看最靠右的一条，就会漏掉“出生不重叠、运行中追尾”这种隐蔽碰撞。

```dart
int? _findAvailableLane(DanmuEntry entry) {
  final entrySpeed = entry.speed ?? config.speed;
  final candidates = <int>[];
  if (entry.laneHint != null &&
      entry.laneHint! >= 0 &&
      entry.laneHint! < _laneCount) {
    candidates.add(entry.laneHint!);
  }
  for (var index = 0; index < _laneCount; index++) {
    if (index != entry.laneHint) candidates.add(index);
  }

  for (final lane in candidates) {
    var nearestTail = double.negativeInfinity;
    var catchesUp = false;
    for (final item in _active) {
      if (item.lane != lane) continue;
      final tail = item.left + item.entry.width;
      nearestTail = max(nearestTail, tail);
      final itemSpeed = item.entry.speed ?? config.speed;
      if (entrySpeed > itemSpeed) {
        final timeToCatch = (_size.width - tail) /
            (entrySpeed - itemSpeed);
        final timeToExit = tail / itemSpeed;
        if (timeToCatch < timeToExit) {
          catchesUp = true;
          break;
        }
      }
    }
    if (!catchesUp &&
        (nearestTail == double.negativeInfinity ||
            nearestTail + config.gap <= _size.width)) {
      return lane;
    }
  }
  return null;
}
```

优先级只管队列顺序，绕不过碰撞规则。高优先级消息插在普通消息前面，但同一优先级照样 FIFO；轨道该守的 `gap` 和速度追尾规则一条不少。`laneHint` 是优先选择，不能因为指定的那条轨道暂时忙，就把别的可用轨道一起堵死。

优先级入队的关键就四个字：**稳定插入**。从队头开始找第一个优先级比新消息低的元素，插到它前面；找不到，也就是全同级或更高，那就追加到队尾。这样同级消息自然保持 FIFO，不用另外排序：

```dart
// 示意伪代码：优先级入队核心，省略判重与容量控制
DanmuEnqueueResult enqueue(DanmuEntry entry) {
  if (entry.priority == DanmuPriority.normal) {
    _queue.add(entry);
    return DanmuEnqueueResult.queued;
  }
  final index = _queue.indexWhere(
      (e) => e.priority.index < entry.priority.index);
  _queue.insert(index == -1 ? _queue.length : index, entry);
  return DanmuEnqueueResult.queued;
}
```

注意枚举 index 的语义：`DanmuPriority` 里 `high` 的 index 必须比 `normal` 大（值越大优先级越高），不然判断方向就反了。配套测试至少要覆盖两条用例：三条同优先级消息的相对顺序，高优先级插队之后普通消息没丢。

当所有轨道暂时不可用时：

```dart
final result = _findAvailableLane(entry) == null
    ? DanmuEnqueueResult.queued
    : DanmuEnqueueResult.accepted;
```

队列到了 `maxQueueSize` 就返回 `rejected`，是提示还是直接丢，交给宿主定。

## 8. 第五步：用时间差推进和回收

```dart
void advance(Duration elapsed) {
  if (_phase != DanmuPhase.playing) return;

  final seconds =
      elapsed.inMicroseconds / Duration.microsecondsPerSecond;

  for (final item in _active) {
    item.left -= (item.entry.speed ?? config.speed) * seconds;
  }

  _active.removeWhere(
    (item) => item.left + item.entry.width <= 0,
  );
  _drainQueue();
  notifyListeners();
}
```

离屏条件是“右边缘小于等于 0”。等于 0 的时候整条已经离开容器了，就该在当前帧回收，别多留一帧。

引擎每推进一次，先回收再试着从队列入轨。新消息就能在同一帧占上刚空出来的轨道，队列不会因为回收时序白等一帧。

## 9. 第六步：Widget 自己拥有 Ticker

```dart
class _EnterpriseDanmuState extends State<EnterpriseDanmu>
    with SingleTickerProviderStateMixin {
  late final DanmuEngine _engine;
  late final Ticker _ticker;
  Duration? _lastTick;

  @override
  void initState() {
    super.initState();
    _engine = DanmuEngine(widget.config);
    _ticker = createTicker(_onTick);
    _attachHandle(widget.handle);
  }

  void _attachHandle(DanmuHandle? handle) {
    handle?.attach(
      send: _send,
      play: _play,
      pause: _pause,
      clear: _engine.clear,
    );
  }

  DanmuEnqueueResult _send(DanmuEntry entry) {
    final result = _engine.enqueue(entry);
    if (_engine.phase == DanmuPhase.playing &&
        (result == DanmuEnqueueResult.accepted ||
            result == DanmuEnqueueResult.queued)) {
      _ensureTicker();
    }
    return result;
  }

  void _ensureTicker() {
    if (!_ticker.isActive) {
      _lastTick = null;
      _ticker.start();
    }
  }

  @override
  void dispose() {
    widget.handle?.detach();
    _ticker.dispose();
    _engine.dispose();
    super.dispose();
  }
}
```

Ticker 回调里只算相邻两帧的时间差：

```dart
void _onTick(Duration elapsed) {
  final previous = _lastTick;
  _lastTick = elapsed;
  if (previous != null) {
    _engine.advance(elapsed - previous);
  }
}
```

暂停就停掉 Ticker，继续播放时重新开始计时。推不推进由引擎按 `DanmuPhase` 判断，哪怕某个调用重复到达，时间也不会被推进两次。

### 9.1 别漏了 App 生命周期：后台回来弹幕"瞬移"的经典 bug

`_onTick` 算时间差有个隐含前提：**相邻两帧之间没有大间隔**。App 退到后台，Ticker 被 mute（不再回调），可时间照样在走；用户切回前台的第一帧，`elapsed - previous` 里装的是整个后台时长，所有活跃弹幕一帧之内被推进几分钟，集体瞬移离屏。这跟“Flutter 动画后台回来直接跳到终点”是同一个原理。

修复办法是让 State 混入 `WidgetsBindingObserver`，后台主动停表，回前台把基准重置：

```dart
class _EnterpriseDanmuState extends State<EnterpriseDanmu>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  // initState: WidgetsBinding.instance.addObserver(this);
  // dispose:   WidgetsBinding.instance.removeObserver(this);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      _ticker.stop();          // 后台停表，时间差不累计
    } else if (state == AppLifecycleState.resumed) {
      _lastTick = null;        // 关键：丢弃后台时长的基准
      if (_engine.phase == DanmuPhase.playing) _ensureTicker();
    }
  }
}
```

重点是 `_lastTick = null`：下次 tick 时 `previous == null` 就不推进，从回前台那一帧重新起算。凡是自己管时间差的组件，自绘动画、游戏循环、倒计时，都绕不过这层处理，弹幕组件想做成通用的，也一样。

## 10. 第七步：渲染任意 Widget

```dart
AnimatedBuilder(
  animation: _engine,
  builder: (context, child) => ClipRect(
    child: Stack(
      clipBehavior: Clip.hardEdge,
      children: [
        ..._engine.activeItems.map(
          (item) => Positioned(
            left: item.left,
            top: item.lane *
                (widget.config.laneHeight + widget.config.laneSpacing),
            width: item.entry.width,
            height: widget.config.laneHeight,
            child: RepaintBoundary(child: item.entry.child),
          ),
        ),
      ],
    ),
  ),
)
```

渲染层只读快照，不碰引擎。每条弹幕都可以是自定义卡片、头像、表情，或者带点击事件的 Widget。

这里用 `Positioned`，没把整个弹幕墙变成一个变换层，子 Widget 的命中区域就保住了。等真需要优化的时候，再根据帧分析决定要不要上复用池或分层绘制。

## 11. 第八步：配置更新与清理

配置是 Widget 的输入，运行时数据归引擎。组件更新时要换配置，每种情况怎么处理得说清楚：

- 只改外观参数：引擎和队列都留着；
- 改轨道高度或数量：重新算布局；
- 容器尺寸变了：重新调 `configure`，不清空没显示的消息；
- Widget 销毁：解绑句柄，停掉并释放 Ticker，释放引擎通知。

`clear()` 只清当前组件里的活跃项、等待队列和布局前队列，宿主自己的消息源它不管。

## 12. 第九步：用无帧测试验证算法

第一条测试，验证碰撞队列：

```dart
test('keeps the first item active and queues a collision', () {
  final engine = DanmuEngine(
    const DanmuConfig(
      laneCount: 1,
      laneHeight: 40,
      laneSpacing: 10,
      gap: 20,
    ),
  );
  engine.configure(const Size(300, 50));

  expect(engine.enqueue(entry('first')), DanmuEnqueueResult.accepted);
  expect(engine.enqueue(entry('second')), DanmuEnqueueResult.queued);
  expect(engine.snapshot.activeCount, 1);
  expect(engine.snapshot.queuedCount, 1);
});
```

第二条测试，验证时间推进和离屏回收：

```dart
engine.play();
engine.advance(const Duration(seconds: 4));

expect(engine.snapshot.activeCount, 1);
expect(engine.snapshot.queuedCount, 0);
expect(engine.activeItems.single.entry.id, 'second');
```

第三条测试，验证首帧布局之前发送：

```dart
expect(
  engine.enqueue(entry('before-layout')),
  DanmuEnqueueResult.pendingLayout,
);

engine.configure(const Size(300, 80));

expect(engine.snapshot.activeCount, 1);
expect(engine.snapshot.queuedCount, 0);
```

验证命令：

```bash
flutter analyze
flutter test
```

静态分析和引擎测试在你自己那份 Flutter 工程里跑。测试不用等真实动画，也不用连消息服务器。

## 13. 手动运行和日志

示例页上有普通消息、高优先级消息、暂停、继续、清空这几个按钮，输出长这样：

```text
[enterprise_danmu] send result=pendingLayout text=来自服务端的弹幕
[enterprise_danmu] send result=accepted text=来自服务端的弹幕
[enterprise_danmu] send result=queued text=高优先级用户弹幕
```

第一条消息可能在首帧布局前返回 `pendingLayout`，布局完成后它会进活跃轨道；连着发的时候看到 `queued`，说明碰撞规则生效了，不代表消息丢了。

手动运行命令：

```bash
flutter devices
flutter run -d <device-id> -v 2>&1 | tee /tmp/enterprise_danmu.log
```

照着这个顺序验：

1. 打开“弹幕系统”页；
2. 多点几次“发送普通”，看多条消息是不是一直保持间距；
3. 点“发送高优先级”，看它是不是插到了队列头；
4. 点“暂停”和“继续”，确认位置停下又能接着走；
5. 点“清空”，确认活跃项和等待项都清干净了；
6. 切到另一个 Tab 再回来，确认 Widget 重新挂载后没有旧回调。

排查的时候，日志先存完整的。队列结果和生命周期日志通常都在异常前面，光看最后一行报错，容易把根因判错。

把弹幕组件挂到独立路由上，然后重复“打开弹幕页面 → 发送消息 → 返回”至少 10 次，盯着日志看：

```text
[enterprise_danmu] disposed label=danmu-page
[lab] DanmuDemoPage dispose
```

组件销毁日志出来之后，就不该再有这个页面的帧推进或队列通知日志了。要是还在一直打，先查三件事：Ticker 停了没、`DanmuEngine` 释放了没、`DanmuHandle` 解绑了没。

## 14. 性能边界

组件先用可读、可测的 `Stack + Positioned` 渲染，扛中等数量的同时活跃弹幕没问题。性能上的策略，按成本从低到高排：

1. 宽度提前给，别每帧去量；
2. 通知只发生在 Ticker 帧推进时；
3. 引擎先查每条轨道最靠右的尾部，保证出生间距；速度可变时再遍历活跃项，把运行中会追尾的轨道排掉；
4. 离屏立即回收；
5. 单条内容套 `RepaintBoundary`；
6. 只有真实帧分析说明确实需要，才上 Widget 复用池或 Canvas 批量绘制。

说白了，别一上来就把所有内容改成 `CustomPainter`。弹幕要点击、要富文本、要复杂卡片，那 Widget 渲染的可维护性通常更值钱；内容固定是文字、同时活跃数量又很大，这才加 Canvas 渲染器，而且复用同一套 `DanmuEngine`。

## 15. 封装到什么程度算完

下面这些条件都满足，弹幕组件才算从“页面动画”变成能复用的组件：

1. 消息数据、调度算法、Widget 渲染三者边界清晰；
2. 阶段和发送结果用枚举表达；
3. 外部句柄只发命令，不持有运行时状态；
4. 首帧布局前发送不会静默丢失；
5. 轨道分配、队列、离屏回收都能脱离设备测试；
6. Ticker、通知、句柄在销毁路径上都清理干净；
7. 示例页能展示入队结果和播放控制；
8. 性能优化有帧分析依据，不靠一个个补丁堆出来。

## 面试追问

### 为什么引擎不直接创建 Ticker？

时钟归 Widget 生命周期管，引擎只处理时间差，这样它在单元测试和其他渲染器里都能复用。

### 为什么要让调用方提供宽度？

轨道碰撞只需要宽度，没必要为每帧的布局测量买单。动态内容在入队前量一次就够。

### 为什么不能只检查轨道最靠右的弹幕？

新弹幕从右侧出生，同轨道里最靠右的那条决定出生点够不够 `gap`；但速度可变的时候，快的新消息可能在旧的离屏前追上它。所以实现还得遍历该轨道的活跃项，拿相对速度和剩余时间算会不会追尾。

### 何时选择 Canvas？

弹幕内容固定、点击需求少、并发量又大的时候，Canvas 能把 Widget 数量压下来。富文本、图片、复杂交互还是留给 Widget 渲染，调度引擎照样复用。

### 为什么高优先级消息也遵守碰撞规则？

优先级只描述排队顺序，不该破坏视觉上的最小间距。不然“高优先级”就成了一条能覆盖已有消息的特殊路径，测试和解释都变麻烦。

## 官方技术文档

- [Ticker API](https://api.flutter.dev/flutter/scheduler/Ticker-class.html)
- [TickerProvider API](https://api.flutter.dev/flutter/scheduler/TickerProvider-class.html)
- [ChangeNotifier API](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html)
- [AnimatedBuilder API](https://api.flutter.dev/flutter/widgets/AnimatedBuilder-class.html)
- [Positioned API](https://api.flutter.dev/flutter/widgets/Positioned-class.html)
- [RepaintBoundary API](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html)
