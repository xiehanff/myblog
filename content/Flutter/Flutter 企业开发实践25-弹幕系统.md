---
title: Flutter 企业开发实践25-大型弹幕组件封装
date: 2026-08-22
tags: [Flutter, 面试, 组件封装, 弹幕, Ticker, 动画, 状态建模, 队列, 性能]
---

# 从 0 封装一套可复用的 Flutter 弹幕组件

弹幕组件同时处理“消息进入、轨道分配、碰撞间距、帧推进、离屏回收和任意 Widget 渲染”。如果把这些逻辑塞进页面控制器，组件就很难复用，也很难单独测试。

本章从零实现 `EnterpriseDanmu`，示例包名使用 `enterprise_danmu`，读者可以把它放入任意 Flutter 工程中验证。

设计目标是：宿主不需要创建状态控制器；运行时状态由 Widget 内部拥有；队列和轨道算法可以脱离真实帧测试；公开 API 只表达发送和播放命令。

文中的代码片段省略了不影响结构的 import 和样式参数，完整可运行实现以验证工程中的源码为准。

## 1. 先把“弹幕”拆成三种数据

弹幕系统里有三种不同生命周期的数据：

| 数据 | 生命周期 | 责任 |
| --- | --- | --- |
| `DanmuConfig` | Widget 配置 | 轨道高度、数量、间距、默认速度和队列上限 |
| `DanmuEntry` | 一条消息 | id、Widget、预估宽度、速度、优先级和可选轨道 |
| `ActiveDanmu` | 渲染快照 | 当前轨道和 left 坐标，只读地交给 Widget |

消息对象不保存“是否已经显示”“是否暂停”之类的多个布尔值。它进入哪个集合，就代表它处于哪个阶段：待布局、等待队列或活跃轨道。

## 2. 先定义宿主 API

~~~dart
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
~~~

组件提供四个有限命令：

~~~dart
handle.send(entry);
handle.play();
handle.pause();
handle.clear();
~~~

`DanmuHandle` 不是外部状态容器，只是可选命令桥。页面没有按钮时可以完全省略它；有按钮时也不需要接管 `Ticker`、队列或轨道列表。

## 3. 建立独立包结构

~~~text
your_danmu_package/
├── lib/
│   ├── enterprise_danmu.dart
│   └── src/
│       ├── danmu_engine.dart
│       └── danmu_widget.dart
└── test/
    └── danmu_engine_test.dart
~~~

入口文件保持稳定：

~~~dart
library enterprise_danmu;

export 'src/danmu_engine.dart';
export 'src/danmu_widget.dart';
~~~

引擎只依赖 Flutter 的值对象和通知能力，Widget 层才负责 `Ticker` 与布局。这样可以在没有真实设备的情况下验证“消息是否正确入队”。

## 4. 第一步：用枚举表达运行阶段

~~~dart
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
~~~

弹幕引擎不会同时维护 `isPlaying`、`isPaused`、`hasLayout`、`isCleared` 等组合状态。阶段是枚举，发送结果也是枚举，调用方可以明确处理“已入轨”“已排队”“等待首帧布局”和“队列已满”。

配置中的 `autoStart` 是独立配置项，不参与运行阶段的组合判断；它只决定首次布局完成后进入 `playing` 还是 `ready`。

## 5. 第二步：定义消息和值对象

~~~dart
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
~~~

宽度由消息创建者提供，避免在每一帧测量文字。对于固定卡片，宽度是稳定常量；对于动态内容，在进入引擎前完成一次测量即可。

轨道状态使用内部对象保存：

~~~dart
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
~~~

渲染层不直接拿到可变对象，而是每次生成只读 `ActiveDanmu` 快照。渲染和调度由不同的对象负责。

## 6. 第三步：先写纯调度引擎

引擎的核心接口：

~~~dart
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
~~~

Widget 提供时钟，引擎只接收时间差。它不创建 `Ticker`，不调用 `setState`，也不关心页面是否使用 Material。

### 6.1 首次布局前的消息

按钮可能在首帧布局前发送消息。引擎把这类消息放入 `_pendingLayout`，配置尺寸后再转入正式队列：

~~~dart
if (_size == Size.zero) {
  if (_pendingLayout.length >= config.maxQueueSize) {
    return DanmuEnqueueResult.rejected;
  }
  _pendingLayout.add(entry);
  return DanmuEnqueueResult.pendingLayout;
}
~~~

这比直接丢弃消息更容易使用，也比在发送方法里读取一个尚未稳定的屏幕尺寸可靠。

### 6.2 轨道数量由尺寸决定

~~~dart
final laneExtent = config.laneHeight + config.laneSpacing;
final laneCount = (size.height / laneExtent)
    .floor()
    .clamp(0, config.laneCount);
~~~

配置中的最大轨道数不会突破容器高度。`laneHeight` 控制卡片占用高度，`laneSpacing` 控制相邻轨道之间的留白，轨道总占用高度是 `laneExtent = laneHeight + laneSpacing`。高度不足一条轨道时返回 0，消息留在队列中，避免渲染层产生越界；空间恢复后再入轨。所有轨道从 0 开始编号，渲染时用 `lane * laneExtent` 得到顶部位置。

## 7. 第四步：轨道分配和碰撞间距

每条轨道至少要检查当前活跃项中最靠右的尾部，保证新弹幕出生时有 `gap`。如果允许每条消息使用不同速度，还必须检查新消息是否会在旧消息离屏前追上它；只检查最靠右的一条会产生“出生不重叠、运行中追尾”的隐蔽碰撞。

~~~dart
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
~~~

优先级只影响队列顺序，不绕过碰撞规则。高优先级消息插入普通消息之前，但同一优先级仍保持 FIFO；轨道仍然遵守 `gap` 和速度追尾规则。`laneHint` 是优先选择，不应因为指定轨道暂时繁忙而阻塞其他可用轨道。

当所有轨道暂时不可用时：

~~~dart
final result = _findAvailableLane(entry) == null
    ? DanmuEnqueueResult.queued
    : DanmuEnqueueResult.accepted;
~~~

队列达到 `maxQueueSize` 后返回 `rejected`，由宿主决定是否提示或丢弃。

## 8. 第五步：用时间差推进和回收

~~~dart
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
~~~

离屏条件使用“右边缘小于等于 0”。等于 0 时已经完整离开容器，应当在当前帧回收，避免多保留一帧。

引擎每次推进后先回收，再尝试从队列入轨。这样新消息可以在同一帧占用刚释放的轨道，队列不会因为回收时序多等待一帧。

## 9. 第六步：Widget 自己拥有 Ticker

~~~dart
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
~~~

Ticker 回调只计算相邻帧的时间差：

~~~dart
void _onTick(Duration elapsed) {
  final previous = _lastTick;
  _lastTick = elapsed;
  if (previous != null) {
    _engine.advance(elapsed - previous);
  }
}
~~~

暂停时停止 Ticker，继续播放时重新开始计时。引擎用 `DanmuPhase` 判断是否推进，因此即使某个调用重复到达，也不会把时间推进两次。

## 10. 第七步：渲染任意 Widget

~~~dart
AnimatedBuilder(
  animation: _engine,
  builder: (context, child) => ClipRect(
    child: Stack(
      clipBehavior: Clip.hardEdge,
      children: [
        ..._engine.activeItems.map(
          (item) => Positioned(
            left: item.left,
            top: item.lane * widget.config.laneExtent,
            width: item.entry.width,
            height: widget.config.laneHeight,
            child: RepaintBoundary(child: item.entry.child),
          ),
        ),
      ],
    ),
  ),
)
~~~

渲染层只读取快照，不修改引擎。每一条弹幕都可以是自定义卡片、头像、表情或带点击事件的 Widget。

使用 `Positioned` 而不是把整个弹幕墙变成一个变换层，可以保留子 Widget 的命中区域。真正需要优化时再根据帧分析决定是否增加复用池或分层绘制。

## 11. 第八步：配置更新与清理

配置是 Widget 输入，运行时数据由引擎拥有。组件更新时如果需要更换配置，应采用明确策略：

- 只改变外观参数：保留引擎和队列；
- 改变轨道高度或数量：重新计算布局；
- 改变容器尺寸：重新调用 `configure`，不清空未显示消息；
- Widget 销毁：解绑句柄、停止并释放 Ticker、释放引擎通知。

`clear()` 只清空当前组件内的活跃项、等待队列和布局前队列，不影响宿主自己的消息源。

## 12. 第九步：用无帧测试验证算法

第一条测试验证碰撞队列：

~~~dart
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
~~~

第二条测试验证时间推进和离屏回收：

~~~dart
engine.play();
engine.advance(const Duration(seconds: 4));

expect(engine.snapshot.activeCount, 1);
expect(engine.snapshot.queuedCount, 0);
expect(engine.activeItems.single.entry.id, 'second');
~~~

第三条测试验证首帧布局前发送：

~~~dart
expect(
  engine.enqueue(entry('before-layout')),
  DanmuEnqueueResult.pendingLayout,
);

engine.configure(const Size(300, 80));

expect(engine.snapshot.activeCount, 1);
expect(engine.snapshot.queuedCount, 0);
~~~

验证命令：

~~~bash
flutter analyze
flutter test
~~~

静态分析和引擎测试应在读者自己的 Flutter 工程中执行。测试不需要等待真实动画，也不需要连接消息服务器。

## 13. 手动运行和日志

根工程示例页提供普通消息、高优先级消息、暂停、继续和清空按钮，并输出：

~~~text
[enterprise_danmu] send result=pendingLayout text=来自服务端的弹幕
[enterprise_danmu] send result=accepted text=来自服务端的弹幕
[enterprise_danmu] send result=queued text=高优先级用户弹幕
~~~

首条消息可能在首帧布局前返回 `pendingLayout`，布局完成后会进入活跃轨道；连续发送时出现 `queued` 说明碰撞规则正在生效，并不代表消息丢失。

手动运行命令：

~~~bash
flutter devices
flutter run -d <device-id> -v 2>&1 | tee /tmp/enterprise_danmu.log
~~~

请依次验证：

1. 打开“弹幕系统”页；
2. 点击“发送普通”多次，观察多条消息是否保持间距；
3. 点击“发送高优先级”，观察它进入队列头；
4. 点击“暂停”和“继续”，确认位置停止和恢复；
5. 点击“清空”，确认活跃项和等待项都消失；
6. 切换到另一个 Tab 再回来，确认 Widget 重新挂载后没有旧回调。

若出现问题，回传设备型号、屏幕尺寸、操作步骤、完整日志和截图。不要只回传最后一行异常，因为队列结果和生命周期日志通常位于前面。

将弹幕组件放入独立路由后，重复执行“打开弹幕页面 → 发送消息 → 返回”至少 10 次，观察：

~~~text
[enterprise_danmu] disposed label=danmu-page
[lab] DanmuDemoPage dispose
~~~

组件销毁日志出现后，不应再有该页面的帧推进或队列通知日志。若仍在持续输出，优先检查 Ticker 是否停止、`DanmuEngine` 是否释放，以及 `DanmuHandle` 是否解除绑定。

## 14. 性能边界

组件先采用可读、可测试的 `Stack + Positioned` 渲染，适合中等数量的同时活跃弹幕。性能策略按成本从低到高排列：

1. 预先提供宽度，避免每帧测量；
2. 只在 Ticker 帧推进时通知；
3. 引擎先检查每条轨道最靠右的尾部以保证出生间距，并在速度可变时遍历活跃项，排除运行中追尾的轨道；
4. 离屏立即回收；
5. 对单条内容使用 `RepaintBoundary`；
6. 只有在真实帧分析证明需要时，才引入 Widget 复用池或 Canvas 批量绘制。

不要一开始就把所有内容改成 `CustomPainter`。如果弹幕需要点击、富文本和复杂卡片，Widget 渲染的可维护性通常更重要；如果内容固定为文字且同时活跃数量很大，再增加 Canvas 渲染器，并复用同一套 `DanmuEngine`。

## 15. 封装完成标准

弹幕组件达到以下条件，才算从“页面动画”进入可复用组件：

1. 消息数据、调度算法和 Widget 渲染有清晰边界；
2. 阶段和发送结果用枚举表达；
3. 外部句柄只发送命令，不拥有运行时状态；
4. 首帧布局前发送不会静默丢失；
5. 轨道分配、队列和离屏回收可脱离设备测试；
6. Ticker、通知和句柄在销毁路径上完整清理；
7. 示例页能展示入队结果和播放控制；
8. 性能优化有帧分析依据，不靠维护补丁堆叠。

## 面试追问

### 为什么引擎不直接创建 Ticker？

时钟属于 Widget 生命周期，引擎只处理时间差，因此可以在单元测试和其他渲染器中复用。

### 为什么要让调用方提供宽度？

轨道碰撞只需要宽度，不应该为每一帧的布局测量付出代价。动态内容可以在入队前完成一次测量。

### 为什么不能只检查轨道最靠右的弹幕？

新弹幕从右侧出生，同轨道中最靠右的项决定出生点是否满足 `gap`；但当消息速度可变时，较快的新消息可能在旧消息离屏前追上更慢的旧消息。因此实现还要遍历该轨道的活跃项，使用相对速度和剩余时间做追尾判断。

### 何时选择 Canvas？

弹幕内容固定、点击需求少且并发量很大时，Canvas 可以降低 Widget 数量。富文本、图片、复杂交互仍适合保留 Widget 渲染，并继续复用调度引擎。

### 为什么高优先级消息也遵守碰撞规则？

优先级只描述排队顺序，不应破坏视觉上的最小间距。否则“高优先级”会变成覆盖已有消息的特殊路径，难以测试和解释。

## 官方技术文档

- [Ticker API](https://api.flutter.dev/flutter/scheduler/Ticker-class.html)
- [TickerProvider API](https://api.flutter.dev/flutter/scheduler/TickerProvider-class.html)
- [ChangeNotifier API](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html)
- [AnimatedBuilder API](https://api.flutter.dev/flutter/widgets/AnimatedBuilder-class.html)
- [Positioned API](https://api.flutter.dev/flutter/widgets/Positioned-class.html)
- [RepaintBoundary API](https://api.flutter.dev/flutter/widgets/RepaintBoundary-class.html)
