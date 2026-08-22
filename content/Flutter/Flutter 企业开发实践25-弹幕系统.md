---
title: Flutter 企业开发实践25-弹幕系统
date: 2026-08-22
tags: [Flutter, 面试, 架构, 弹幕, MQTT, Ticker, 自研组件, 状态管理, 重构]
---

# 弹幕系统——生产实现剖析与重构方案

> 架构师看一个在线系统，要先分清"骨架"与"结缔组织"。这篇文章剖析的是一个真实生产项目的弹幕系统：它的渲染引擎骨架——Ticker 驱动、轨道分配、碰撞简化、定向刷新——是教科书级的，我会先讲清楚它做对了什么，并逐条列出六条"重构时原样保留"的好设计；但长在这副骨架上的消息分发、状态管理与生命周期是失控的，我会逐条给出病理证据，其中一个还是线上可复现的真 bug。因此本文是严格的三段式：**生产实现剖析 → 病理诊断 → 重构方案**。重构方案的核心三个词：分层、多播、单一真相——重构不是全盘否定，而是让好代码周围不再长坏代码。

## 概述

某已上线半年的 Flutter 混合开发项目（下文简称"该项目"）的首页有一个"心愿单" Tab：一堵会飘的弹幕墙，用户许愿的商品以卡片形式从右向左匀速飘过，观众可以发弹幕（自己的弹幕插队进指定轨道）、点"+1"点赞（点赞接口 + 乐观 UI）。注意它**不是直播间弹幕**——直播间那套是 H5 WebView，这堵墙是纯原生 Flutter 自研组件。

完整链路：MQTT 推送 → 首页控制器分发 → 业务控制器解析 → 自研弹幕渲染包（Ticker + Stack）飘动渲染，依赖 `mqtt_client ^10.5.1`。

这套系统的真实状态可以概括为一句话：**渲染引擎是优秀的，工程外围是失控的**。项目 owner 自己的定性是四句话：代码难以维护、bool 值过多、心智模型重、过于依赖外部控制器。这四句话后面全部能对得上具体代码证据，其中一个还是线上可复现的真 bug。

本文按三段展开：第 1、2 章剖析生产实现（先肯定骨架，六条好设计逐条展开）；第 3 章病理诊断（四个病灶、八个证据）；第 4 章给出完整的重构方案（五层架构、每层核心类给完整实现 + 状态建模三原则 + 生命周期所有权 + 四步迁移策略）。标识符与地址均已匿名化改写，但设计与代码细节忠实于原实现——包括那些"看起来很怪但其实有道理"的设计。

## 核心内容

### 1. 业务形态与数据链路总览

#### 1.1 链路全景与代码规模

先建立全景。数据从 MQTT broker 到屏幕上一条飘动的卡片，要经过六个环节：

```text
                    ┌─────────────────────────────────────────────┐
                    │               MQTT Broker                   │
                    │    topic: wishlist/products/{userId}        │
                    └────────────────────┬────────────────────────┘
                                         │ QoS 1 推送，payload 为 JSON 数组
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  MQTT 服务单例：连接 / 自动重连 / 订阅 / UTF-8 解码 / 单槽回调分发      │
│  （还内置了一个业务补拉 HTTP API —— 第 3 章的病灶之一）                │
└────────────────────┬────────────────────────────────────────────────┘
                     │ _onMessageReceived(topic, payload)  ← 单播单槽
                     ▼
┌──────────────────────────┐   topic.contains('wishlist/products')
│  首页控制器（MQTT 宿主）    │ ──────────────────────────────────┐
└──────────────────────────┘                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  弹幕业务控制器：JSON 解析 → 卡片构造 → 广播流 → 发送/点赞/输入编排     │
└────────────────────┬────────────────────────────────────────────────┘
                     │ broadcast Stream<DanmakuData>
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  自研渲染引擎：轨道分配 → 双 FIFO 队列 → Ticker 每帧推进 → Stack 渲染  │
└─────────────────────────────────────────────────────────────────────┘
```

用户作为观众有两个主动动作，走的却是两条完全不同的路：**发弹幕**是先调 HTTP 接口、成功后本地用"优先级发送"插队入场；**点赞**是先乐观更新本地状态、成功后固化。这两个动作在第 3 章都会成为病理证据。

参与这条链路的代码规模（匿名化后）：

| 模块 | 规模 | 职责 |
| --- | --- | --- |
| MQTT 服务单例 | ~460 行 | 连接、重连、订阅管理、UTF-8 解码、单槽回调分发，外加一个业务补拉 API |
| 前后台生命周期观察者 | ~120 行 | 后台断连；前台重连 + 清屏 + 补拉 |
| 首页控制器 | — | MQTT 统一管理、topic 字符串匹配分发、弹幕控制器宿主、键盘状态 |
| 弹幕业务控制器 | ~300 行 | JSON 解析、发送、点击、节流、两个业务 API、输入框 controller |
| 数据模型 + 解析器 | ~110 行 | 字段模型与 List payload 解析 |
| 弹幕卡片 UI | ~440 行 | 继承引擎组件基类的自定义卡片（头像/正文/+1 胶囊） |
| 自研渲染引擎包 | ~4200 行 | 核心控制器 579 行 + 模型 330 行 + Stream 管道 291 行 + 渲染容器 137 行 + 调试可视化 463 行 |
| 调试页 | — | 与生产控制器约 60% 逻辑重复（初始化配置、MQTT 连接、解析、点击处理各一份） |

#### 1.2 消息从 broker 到入轨：逐环节看代码

**环节一：接收与解码。** mqtt_client 把所有订阅的消息统一吐进 `client.updates` 流，服务单例在这里做 UTF-8 解码，然后调用单槽回调：

```dart
// MQTT 服务单例
void _setupMessageListener() {
  _client!.updates!
      .listen((List<MqttReceivedMessage<MqttMessage>>? messages) {
    if (messages == null || messages.isEmpty) return;
    for (final message in messages) {
      final recMessage = message.payload as MqttPublishMessage;
      final topic = message.topic;
      String payload;
      try {
        payload = utf8.decode(recMessage.payload.message); // 解决中文乱码
      } catch (_) {
        payload = MqttPublishPayload.bytesToStringAsString(
            recMessage.payload.message);
      }
      _onMessageReceived?.call(topic, payload); // 单槽回调：见 3.1 的病灶
    }
  });
}
```

**环节二：分发。** 首页控制器拿到 `(topic, payload)` 后按字符串匹配分发给业务控制器：

```dart
// 首页控制器的 MQTT 扩展
void dispatchMqttMessage(String topic, String payload) {
  if (topic.contains('wishlist/products')) {
    final wishlistController =
        WishlistController.to; // 自愈式访问，见 3.4 的病灶
    wishlistController.handleMqttMessage(topic, payload);
  }
  // else if (topic.contains('……')) { …… }
  // 历史上还有第二个 topic 的分支，现以注释形式存在
}
```

**环节三：解析。** 业务控制器把 payload 解析成模型列表。注意服务端下发的 payload 是 **List**（一次推一屏的若干条），不是单条对象：

```dart
class WishlistDanmakuItem {
  final String id;
  final String avatarUrl;
  final String nickname;
  final String title;
  final int heat;
  final int isClick; // 服务端是 int，UI 层要的是 bool —— 3.2 的证据

  factory WishlistDanmakuItem.fromJson(Map<String, dynamic> json) {
    return WishlistDanmakuItem(
      id: parseString(json['id']) ?? '',
      avatarUrl: json['avatarUrl'] ?? '',
      nickname: parseString(json['nickname']) ?? '',
      title: parseString(json['title']) ?? '',
      heat: parseInt(json['heat']) ?? 0,
      isClick: parseInt(json['isClick']) ?? 0,
    );
  }
}

class WishlistDanmakuParser {
  static List<WishlistDanmakuItem> parseJsonString(String jsonString) {
    final dynamic decoded = jsonDecode(jsonString);
    if (decoded is List) {
      return decoded
          .whereType<Map<String, dynamic>>()
          .map<WishlistDanmakuItem>(WishlistDanmakuItem.fromJson)
          .toList();
    }
    throw FormatException(
        'JSON 数据格式错误：期望 List，实际收到 ${decoded.runtimeType}');
  }
}
```

**环节四：入管道。** 解析出的每条数据被包装成弹幕卡片组件，逐条塞进一个 broadcast StreamController；引擎是这股流的下游消费者。这一段完整链路（含键盘联动的分支）在 2.6 展开。

#### 1.3 补拉链路：两条触发路径

推送通道只覆盖"在线期间"的数据，断连期间、后台期间、冷启动首屏都需要 REST 补拉。生产实现的补拉接口返回"最新一屏"数据，走与 MQTT 推送完全相同的处理链。触发路径有两条：

**路径一：前台恢复。** 生命周期观察者在 App 回前台时执行"重连 → 清屏 → 补拉"（完整代码见 2.7）。

**路径二：build 的 postFrame 回调。** 弹幕容器每次 build 都在帧末尾无条件补拉：

```dart
// 弹幕容器（业务 widget 的 build 里）
Widget build(BuildContext context) {
  final controller = WishlistController.to;
  return Builder(builder: (context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      MqttService.instance().pullLatestForWishlist().then((value) {
        if (value != null) {
          final list =
              value.map(WishlistDanmakuItem.fromJson).toList();
          controller.handleItems(list);
        }
      });
    });
    return LayoutBuilder(builder: (context, constraints) {
      return /* 弹幕墙 */ Container();
    });
  });
}
```

这个"无条件 postFrame 补拉"乍看只是浪费，实则是第 3 章两个病灶的温床：键盘弹起会触发弹幕层高度变化 → 重建 → 再次补拉 → **同一条弹幕被重复喂进引擎**（数据无去重）。第 5 章坑 4 会完整推演这个链条。

顺带看一眼那个长在网络层单例里的业务 API——它是 3.4 节"职责混杂"的直接证据：

```dart
// MQTT 服务（网络层单例）里长出来的业务 HTTP API
Future<List<dynamic>?> pullLatestForWishlist() async {
  try {
    const String path = '/wishlist/latest';
    final res = await ApiClient.instance().post(path); // 硬编码端点，不进 api_paths
    final data = res.data;
    if (data['code'] == 0) return data['data'];
    return null;
  } catch (e, s) {
    logger.e('订阅后调用API失败: $e', s);
    return null;
  }
}
```

### 2. 生产实现剖析：这套引擎做对了什么

诊断之前必须先讲清楚骨架。以下八个小节全部来自真实代码（匿名化改写），最后一节把六条好设计逐条展开——它们是第 4 章重构方案里明令保留的部分。

#### 2.1 驱动：把 Ticker 挂在 GetX 控制器上

核心控制器继承 GetX 控制器并混入 TickerProvider，把 Flutter 的 `Ticker` 挂在了 GetX 生命周期上：

```dart
class DanmakuEngine extends GetxController
    with GetSingleTickerProviderStateMixin {
  late Ticker _ticker;
  late DanmakuConfig _config;
  bool _isInitialized = false;

  // 轨道列表与全量活跃弹幕（渲染用）
  final List<DanmakuTrack> _tracks = [];
  final RxList<DanmakuItem> activeDanmuList = <DanmakuItem>[].obs;

  // 动画状态
  bool _isPlaying = false;
  double _currentTime = 0.0;
  double _pausedTime = 0.0;

  // 更新控制
  double _lastUpdateTime = 0.0;
  static const double _updateInterval = 1.0 / 25.0; // 25FPS，平衡流畅度与性能

  @override
  void onInit() {
    super.onInit();
    _ticker = createTicker(_onTick);
  }

  /// 每帧回调：仿真循环的"心脏"
  void _onTick(Duration elapsed) {
    if (!_isPlaying) return;
    _currentTime = _pausedTime + elapsed.inMicroseconds / 1000000.0;

    bool needsUpdate = false;
    if (_processWaitingQueues()) needsUpdate = true;   // 1. 队列出队
    if (_updateDanmuPositions()) needsUpdate = true;   // 2. 位置推进
    if (_cleanupCompletedDanmu()) needsUpdate = true;  // 3. 回收离屏

    // 4. 自适应降频判断后，定向刷新（见 2.5）
    if (shouldUpdate) {
      _lastUpdateTime = _currentTime;
      update(['danmu_layer']); // 只重建弹幕层，不惊动页面其它部分
    }
  }

  @override
  void onClose() {
    disconnectStream();
    if (_ticker.isActive) _ticker.stop();
    _ticker.dispose(); // GetX 销毁时同步处置 Ticker
    super.onClose();
  }
}
```

每帧四件事：处理等待队列 → 更新位置 → 回收完成弹幕 → 节流后定向刷新。这里有两个值得点名的决策：其一，**动画启动与添加弹幕解耦**——`sendDanmuComponent` 只入轨/入队并刷一次 UI，是否播放由外部 `startAnimation/pauseAnimation` 控制（源码注释原话："动画的启动/暂停应该由外部控制，与添加弹幕解耦"），这让键盘弹起时"暂停播放但仍收数据"成为可能；其二，`update(['danmu_layer'])` 的 id 定向刷新让整墙弹幕的逐帧重绘与页面其余 UI 完全隔离，这是 GetX 下成本最低的"局部 setState"。

当然，把 Ticker 挂在 GetX 控制器上也埋了生命周期隐患（控制器常被 `Get.put` 提到页面外存活），第 5 章坑 1 展开。

#### 2.2 位移与渲染：Positioned 保住点击命中

位移是纯匀速模型，没有插值：

```dart
double calculatePosition(double containerWidth, double currentTime) {
  if (!isActive) return containerWidth;
  final elapsedTime = currentTime - startTime;
  final moveDistance = elapsedTime * speed;
  return containerWidth - moveDistance; // 匀速左移
}
```

位置永远是"出生时间 + 速度"的纯函数，而不是逐帧累加——这保证了任何时刻的位置都可重算（幂等），中途丢帧不会累积误差。离屏判定也建在这个纯函数上：`currentX + logicalWidth < 0` 才算完全离开（**严格离屏**，右缘贴 0 还不算），保证不会出现"弹幕还看得见就消失"的跳变。

渲染树是 `ClipRect > SizedBox > Stack`，每条弹幕一个 `Positioned`：

```dart
GetBuilder<DanmakuEngine>(
  tag: tag,
  id: 'danmu_layer',          // 定向刷新的接收端
  builder: (controller) => RepaintBoundary(        // 整墙一层
    child: Stack(
      clipBehavior: Clip.hardEdge,
      children: controller.activeDanmuList
          .map(_buildDanmuItem)
          .toList(),
    ),
  ),
)

Widget _buildDanmuItem(DanmakuItem danmu) {
  // 源码注释原话："使用 Positioned 而不是 Transform.translate
  // 来避免点击事件问题"
  return Positioned(
    left: danmu.currentX ?? controller.containerWidth,
    top: track.topOffset,     // 轨道顶部对齐，高度等于轨道高
    width: danmu.component.getWidth(),
    height: track.height,
    child: RepaintBoundary(child: danmuWidget),      // 每卡一层
  );
}
```

两层 `RepaintBoundary`（整墙一层、每卡一层）把每帧重绘限制在位置变化的部分：墙外的东西不重绘，卡片的业务内容（图片、文本）在飞行期间不重绘，只有 `Positioned.left` 变化引发的布局更新。这是自研 Stack 弹幕能与 CustomPainter 方案掰手腕的关键（渲染选型的完整对比见第 6 章）。

为什么坚持 `Positioned` 而不是 `Transform.translate`？Transform 是绘制期变换，命中测试要把触点逆变换回子坐标，在"高速移动 + ClipRect 裁剪 + 部分离屏"的组合下容易出现看得见点不着/看不见还能点的边角问题；Positioned 是布局属性，命中区域即视觉区域。对一个**可点击**的弹幕墙（点赞）来说这个选择是对的。第 5 章坑 5 展开。

#### 2.3 轨道与碰撞：同轨同速，只需防"出生重叠"

固定 4 轨（`trackCount: 4`，适合手机屏的卡片尺寸），高度按容器高度动态均分（减去轨距后 `clamp(20, ∞)`），顶部偏移按 `index * (dynamicHeight + spacing)` 计算——容器高度变化时整套轨道布局重算。碰撞检测是这个引擎里最聪明的一笔：

```dart
bool canAddDanmu(
    double containerWidth, double currentTime, double newDanmuWidth) {
  if (activeDanmuList.isEmpty) return true;

  // 只查该轨道最后一条（最右侧）弹幕
  final lastDanmu = activeDanmuList.last;
  final lastDanmuCurrentX =
      lastDanmu.calculatePosition(containerWidth, currentTime);
  final lastDanmuRightEdge = lastDanmuCurrentX + lastDanmu.logicalWidth;

  // 新弹幕从容器右边缘出生，只要和"队尾"保持最小间距即可
  final newDanmuStartX = containerWidth;
  final actualSpacing = newDanmuStartX - lastDanmuRightEdge;
  return actualSpacing >= minSpacing;
}
```

为什么只查一条就够？因为**同轨同速**：一条轨道里所有弹幕速度相同，后出生的永远追不上先出生的，间距在飞行全程保持不变，运行中不可能相撞——唯一需要防的是"出生瞬间"与队尾重叠。O(1) 的碰撞检测不是偷懒，是对不变量的正确利用。（代价是这个不变量绑定了"匀速"假设：一旦引入按文本长度变速的弹幕，此简化即失效，见第 6 章追问。）

分轨按负载评分挑最优：

```dart
double get loadScore {
  // 综合活跃弹幕数量和队列长度，优先队列权重更高
  return activeDanmuList.length * 2.0 +   // 活跃弹幕权重最高
      waitingQueue.length * 1.0 +
      priorityQueue.length * 1.5;         // 优先队列积压说明该轨压力大
}

DanmakuTrack _selectOptimalTrack(DanmakuItem danmu) {
  // 先找"能立即入轨"的轨道，在其中挑负载最低的
  final availableTracks = _tracks
      .where((track) => track.canAddDanmu(
          _containerWidth, _currentTime, danmu.logicalWidth))
      .toList();
  if (availableTracks.isNotEmpty) {
    availableTracks.sort((a, b) => a.loadScore.compareTo(b.loadScore));
    return availableTracks.first;
  }
  // 都不行就全局挑负载最低的，进它的等待队列
  _tracks.sort((a, b) => a.loadScore.compareTo(b.loadScore));
  return _tracks.first;
}
```

#### 2.4 队列：双 FIFO 与"每帧只试队头"

每条轨道两个队列：普通 FIFO + 优先 FIFO。用户自己发的弹幕走 `sendPriorityDanmuComponent`，可以指定 `preferredTrackId` 插进指定轨道的优先队列（生产代码里固定传 3，且源码 FIXME 承认该参数实际不生效——3.6 的证据之一）。每帧每轨只尝试队头一条：

```dart
bool _processWaitingQueues() {
  bool processed = false;
  for (final track in _tracks) {
    // 优先处理优先队列
    if (track.priorityQueue.isNotEmpty) {
      final danmu = track.priorityQueue.first; // 只看队头一条
      if (track.canAddDanmu(
          _containerWidth, _currentTime, danmu.logicalWidth)) {
        track.priorityQueue.removeAt(0);
        _activateDanmu(danmu, track);
        processed = true;
        continue; // 优先队列处理完后继续下一个轨道
      }
    }
    // 普通等待队列
    if (track.waitingQueue.isNotEmpty) {
      final danmu = track.waitingQueue.first;
      if (track.canAddDanmu(
          _containerWidth, _currentTime, danmu.logicalWidth)) {
        track.waitingQueue.removeAt(0);
        _activateDanmu(danmu, track);
        processed = true;
      }
    }
  }
  return processed;
}

void _activateDanmu(DanmakuItem danmu, DanmakuTrack track) {
  danmu.isActive = true;
  danmu.startTime = _currentTime;
  danmu.currentX = _containerWidth;
  danmu.calculateEndTime(_containerWidth); // 预计完全离屏的时刻
  track.activeDanmuList.add(danmu);
  activeDanmuList.add(danmu);              // 双列表同步登记
}
```

"每帧每轨只试队头"是个克制的设计：入队尝试是 O(轨道数) 而不是 O(积压数)，洪峰时不会在队列检查上烧帧。它的反面是队头阻塞（队头进不去，后面全等着）——生产实现里队列无上限，这个反面在 3.5 变成病灶；重构版用"队头超时丢弃"补上（4.5）。

回收与双列表同步：

```dart
bool _cleanupCompletedDanmu() {
  final toRemove = <DanmakuItem>[];
  for (final danmu in activeDanmuList) {
    if (danmu.isCompleted) toRemove.add(danmu); // 先标记后移除，避免遍历中改表
  }
  for (final danmu in toRemove) {
    activeDanmuList.remove(danmu);
    final track = _tracks.firstWhere((t) => t.trackId == danmu.trackId);
    track.activeDanmuList.remove(danmu);        // 轨道列表同步移除
  }
  return toRemove.isNotEmpty;
}
```

#### 2.5 自适应降频与"健康检查"补丁

弹幕墙大部分时间不需要满帧刷新：位置变化肉眼不可见时，刷帧是纯浪费。引擎做了三级降频——位置变化 `< 0.1px` 不更新；连续 10 帧无变化把更新间隔 ×1.5；再叠加一个强制 ×2 周期兜底：

```dart
// 智能更新策略：减少闪烁
if (needsUpdate) {
  _hasVisualChanges = true;
  _consecutiveNoChangeFrames = 0;
} else {
  _consecutiveNoChangeFrames++;
}

final adaptiveInterval = _consecutiveNoChangeFrames > _maxNoChangeFrames
    ? _updateInterval * 1.5 // 无变化时轻微降低频率
    : _updateInterval;

final hasActiveDanmu = activeDanmuList.isNotEmpty;
final hasWaitingDanmu = _tracks.any((track) =>
    track.waitingQueue.isNotEmpty || track.priorityQueue.isNotEmpty);

// 修复智能更新机制：确保有等待弹幕时也会更新（注释原话）
final shouldUpdate = _hasVisualChanges ||
    (hasActiveDanmu &&
        (_currentTime - _lastUpdateTime) >= adaptiveInterval) ||
    (hasWaitingDanmu &&
        (_currentTime - _lastUpdateTime) >= _updateInterval) ||
    (_currentTime - _lastUpdateTime) >=
        _updateInterval * 2.0; // 强制兜底，确保不会完全停止

if (shouldUpdate) {
  _lastUpdateTime = _currentTime;
  _hasVisualChanges = false;
  update(['danmu_layer']);
}
```

此外每 3 秒一次健康检查定时器，"补一记 update"对冲渲染停摆：

```dart
void checkSystemHealth() {
  final now = DateTime.now().millisecondsSinceEpoch / 1000.0;
  final timeSinceLastUpdate = now - _lastUpdateTime;
  final totalWaitingDanmu = _tracks.fold(
      0, (sum, t) => sum + t.waitingQueue.length + t.priorityQueue.length);

  // 症状 1：播放态但 Ticker 没在跑 → 重启动画
  if (_isPlaying && !_ticker.isActive) {
    startAnimation();
  }
  // 症状 2：有等待弹幕但很久没刷新 → 强制补一次刷新
  if (totalWaitingDanmu > 0 && timeSinceLastUpdate > 2.0) {
    _hasVisualChanges = true;
    update(['danmu_layer']); // 定时"补一记 update"
  }
}
```

要公平地评价这段代码：它是典型的**症状治疗**——治的是"没人知道为什么偶尔停摆"，用定时器把症状压住。注释里那句"修复智能更新机制"说明降频逻辑曾经出过"停更"事故，兜底条款是事后打上的补丁。在缺乏诊断手段的生产环境里这是务实的选择；第 4 章的重构会让 ticker 的启停全部由所有权树上的显式调用驱动，这个补丁大概率自然消失（4.7 有完整讨论）。

#### 2.6 Stream 管道与键盘联动

业务控制器与引擎之间隔着一层 broadcast Stream 管道——这是整个链路里设计意识最强的部分：

```dart
class DanmakuData {
  final String id;
  final DanmakuCard component;
  final bool skipAnimationTrigger; // 是否跳过动画触发逻辑
  // ...
}

class DanmakuStreamPipe {
  final _streamController = StreamController<DanmakuData>.broadcast();
  Stream<DanmakuData> get stream => _streamController.stream;

  void addComponent(DanmakuCard component) {
    _add(DanmakuData(id: component.id, component: component));
  }

  /// 专门用于键盘弹起等"暂停播放但仍要收数据"的场景：
  /// 只入队，不触发动画启动
  void addComponentWithoutAnimation(DanmakuCard component) {
    _add(DanmakuData(
      id: component.id,
      component: component,
      skipAnimationTrigger: true,
    ));
  }

  void _add(DanmakuData data) {
    if (!_streamController.isClosed) _streamController.add(data);
  }
}
```

引擎侧的连接逻辑：

```dart
void connectStream(Stream<DanmakuData> stream) {
  disconnectStream(); // 先断开旧连接，防止重复订阅
  _streamSubscription = stream.listen((danmuData) {
    sendDanmuComponent(danmuData.component);
    // 如果不跳过动画触发且当前未播放，则启动动画
    if (!danmuData.skipAnimationTrigger && !_isPlaying) {
      startAnimation();
    }
  });
}
```

业务侧的键盘联动——弹幕墙在键盘弹起时暂停（视觉上静止），但数据照收，只是不触发动画启动：

```dart
void handleItems(List<WishlistDanmakuItem> itemList) {
  for (final item in itemList) {
    final component = item.toComponent(onTap: () => _onItemTapped(item));
    if (HomeController.to.wishlistKeyboardVisible) {
      streamPipe.addComponentWithoutAnimation(component); // 键盘弹起：只入队
    } else {
      streamPipe.addComponent(component);
    }
  }
  update();
}
```

评价：管道隔离本身是对的（业务不直接摸引擎，引擎不理解业务）；`skipAnimationTrigger` 这个 flag 却是"用布尔开关给消息分类"的坏味道——它让一条管道承载两种语义不同的消息，下游靠 flag 分叉。3.2 把它列入 bool 泛滥的证据，4.4 的重构用"页面显式编排 pause/resume"替代这个 flag。

#### 2.7 连接管理与前后台联动

**clientId 的构造**——MQTT 规范建议 clientId ≤ 23 字节，且同一 clientId 重复连接会互相踢下线，所以拼入设备标识并在超长时哈希截断：

```dart
String get _clientId {
  final userId = UserManager.userId ?? 0;
  final deviceId = DeviceIdProvider.deviceId;
  // 用户ID + 设备ID 组合保证唯一，避免多设备互踢
  final fullClientId = 'mqttx_${userId}_$deviceId';
  if (fullClientId.length > 23) {
    final hash = sha256
        .convert(utf8.encode(fullClientId))
        .toString()
        .substring(0, 8);
    return 'mqttx_${userId}_$hash';
  }
  return fullClientId;
}
```

**连接配置**：`autoReconnect = true`、`resubscribeOnAutoReconnect = true`——断线自动重连与重连后自动重订阅都交给库；断连语义只有私有的 `_disconnect()`，对外只暴露终态的 `dispose()`（这一点在 3.4 和第 5 章坑 2 都会回来）。

**前后台联动**由全局生命周期观察者驱动：

```dart
class AppLifecycleObserver with GlobalPageVisibilityObserver {
  @override
  void onBackground(Route route) {
    _disposeMqtt(); // 后台：断连（dispose 会连业务回调一起清空）
  }

  @override
  void onForeground(Route route) {
    final mq = MqttService.instance();
    if (mq.isConnected) return;
    if (Get.isRegistered<HomeController>()) {
      _reconnectAndCatchUp(Get.find<HomeController>());
    }
  }

  void _reconnectAndCatchUp(HomeController homeController) {
    homeController.connectMqtt().then((value) {
      homeController.initializeMqttService(); // 重新注册单槽回调！
      if (!Get.isRegistered<WishlistController>()) return;
      final wishlistController = Get.find<WishlistController>();
      wishlistController.clearAllDanmu();     // 清屏：旧内容已无意义
      MqttService.instance().pullLatestForWishlist().then((value) {
        if (value != null) {
          wishlistController.handleItems(
              value.map(WishlistDanmakuItem.fromJson).toList());
        }
      });
    });
  }

  void _disposeMqtt() {
    MqttService.instance().dispose(); // 连接、回调、订阅列表一起清空
    if (Get.isRegistered<HomeController>()) {
      Get.find<HomeController>().isConnected = false;
    }
  }
}
```

注意"重连 → **重新注册回调** → 清屏 → 补拉"这个顺序——因为 dispose 把回调清了，重连后必须重新注册。这个隐式契约没有编译器也没有测试保障，全靠"每次改这块代码的人恰好知道"。它也是 3.1 劫持 bug 能"自愈"的原因：前后台切换会重新注册生产回调，把调试页的劫持覆盖掉，于是问题变成了"时隐时现"。

#### 2.8 卡片 UI 与交互

卡片固定设计稿尺寸 **490 x 260**（宽为碰撞检测服务），结构是 `InkWell > Container(渐变或用户自定义背景图) > Column[头像+昵称 / 正文 / 分割图片 / +1 胶囊]`。头像三分支：默认卡通图 / 网络图（CachedNetworkImage）/ 本地 asset。两个关键细节：

```dart
class DanmakuCard extends DanmakuComponent {
  // 固定的渐变色，在构造时确定，避免闪烁
  late final LinearGradient _gradient = _pickRandomGradient();

  // 固定尺寸（设计稿单位；宽暴露给外部做碰撞检测）
  static const double designWidth = 490.0;
  static const double _cardHeight = 260.0;

  @override
  double getWidth() => designWidth; // 引擎用它做碰撞检测与布局

  @override
  Widget build(BuildContext context) {
    // 整卡再包一层 GetBuilder：点击 +1 后只刷新这一张卡
    return GetBuilder<WishlistController>(
      builder: (controller) {
        final isClickedByUser = controller.isClickedByLocal(id);
        final finalIsClick = isClickedByUser || isClick; // 三份真相汇合点
        return RepaintBoundary(
          child: InkWell(
            onTap: onCardTap,
            child: Container(
              decoration: BoxDecoration(gradient: _gradient),
              child: Column(children: [
                _buildHeader(),            // 头像 + 昵称
                _buildContent(),           // 商品标题正文
                _buildDivider(),           // 分割图片
                _buildLikeCapsule(finalIsClick), // "+1" 胶囊
              ]),
            ),
          ),
        );
      },
    );
  }
}
```

构造期固化随机渐变色（`late final`，构造时掷一次骰子）：弹幕卡片每次进入 `Stack` 重建都是新 widget，如果渐变色在 build 里现算，每次重建颜色都会跳变——固化在构造期，同一个 item 对象生命周期内颜色稳定。点击与发送统一用 EasyThrottle 节流（点击 1 秒 / 发送 2 秒）：

```dart
void _onItemTapped(WishlistDanmakuItem item) {
  EasyThrottle.throttle('wishlist_click', const Duration(milliseconds: 1000),
      () async {
    if (item.isClick == 1 || isClickedByLocal(item.id)) return; // 已点赞
    final ok = await likeItemRequest(item.id);
    if (ok) {
      _clickedDanmuIds.add(item.id); // 本地乐观 Set
      update();
    }
  });
}
```

#### 2.9 六条值得保留的好设计（逐条展开）

**1. `update(['danmu_layer'])` 定向刷新。** 逐帧动画若用无参 `update()`，每帧全页重建，页面上的输入条、列表、轮播全部陪葬；id 定向刷新把重建范围锁在弹幕层一个 `GetBuilder` 里。它的本质是"**订阅域最小化**"：状态变化只通知真正消费它的 widget。重构版换成 `ChangeNotifier + ListenableBuilder`，语义完全等价（见 4.5）。

**2. 双层 RepaintBoundary（整墙 + 每卡）。** 整墙一层把弹幕层的重绘与页面隔离；每卡一层让卡片飞行期间的 repaint 边界止于 `Positioned` 的布局变化。弹幕是"每帧都在动"的组件，repaint 边界设计错了，性能问题是持续性而不是偶发性的。

**3. 自适应降频（<0.1px 忽略、×1.5 退避、×2 兜底）。** 弹幕墙空闲期（弹幕少、移动慢）肉眼分辨不出降频，却分辨得出发热和耗电。三级降频让帧成本随视觉需求自动回落，"×2 兜底"保证降频逻辑自身出错时系统也不会完全停摆——防御性设计的正确姿势。

**4. 构造期固化随机渐变色。** 这是"**派生值不该在 build 里现算**"的经典案例：随机色是 item 的属性（构造期决定一次），不是视图的属性（每次 build 变一次）。凡是 build 里调 `Random()` 的代码，都在制造闪烁 bug。

**5. 同轨同速只防出生重叠的碰撞简化。** 用"所有弹幕同速"这一个业务约束，把 O(n) 的运行期碰撞检测消成 O(1) 的出生检测。这是**用不变量换复杂度**的典范——前提是约束真的成立，且代码里写清楚为什么（该项目的注释做到了）。

**6. EasyThrottle 统一节流点击与发送。** 点赞、发弹幕都是"用户手速快于接口承载力"的场景，节流键（`wishlist_click` / `wishlist_add`）统一管理、互不干扰。比在每个 onTap 里手写时间戳判断干净得多。

以上六条在 4.9 节会再次出现——重构方案对它们**原样保留**。

### 3. 病理诊断：四个病灶与八个证据

以下是项目 owner 的原话定性：**代码难以维护、bool 值过多、心智模型重、过于依赖外部控制器**。逐条对应展开。诊断对事不对人——这些病灶每一个单看都是"当时最快的选择"，合起来才是灾难。

#### 3.1 病灶一【最危险】：单播单槽回调被抢注

MQTT 服务的消息入口是单播单槽回调：

```dart
class MqttService {
  MqttMessageCallback? _onMessageReceived; // 一个槽位，set 即覆盖
  MqttStatusCallback? _onStatusChanged;

  void setOnMessageReceived(MqttMessageCallback callback) {
    _onMessageReceived = callback; // 后来者整体覆盖先来者
  }

  void setOnStatusChanged(MqttStatusCallback callback) {
    _onStatusChanged = callback;
  }
}
```

生产链路由首页控制器注册：

```dart
// 首页控制器扩展：生产链路的注册
void initializeMqttService() {
  mqttService.setOnStatusChanged((status) {
    isConnected = status == MqttConnectionStatus.connected;
    update();
  });
  mqttService.setOnMessageReceived((topic, payload) {
    dispatchMqttMessage(topic, payload);
  });
}
```

但调试页控制器初始化时也注册同一对回调：

```dart
// 调试页控制器 onInit：另一份注册（劫持发生地）
_mqttService.setOnMessageReceived((topic, payload) {
  _handleDebugMessage(topic, payload); // 生产分发从此静默失效
});
_mqttService.setOnStatusChanged((status) {
  _debugStatus = status;
  update();
});
```

于是：**打开一次调试页，生产弹幕的消息分发就被劫持到调试控制器**，直到下一次前后台切换时生命周期观察者重新注册为止。时序如下：

```text
T0  首页控制器注册回调 ──► 生产链路正常
T1  打开调试页，调试控制器 onInit 注册同名回调 ──► 单槽被覆盖
T2  MQTT 推送到达 ──► 消息进入调试控制器，生产弹幕墙静默断流
T3  用户切后台再回前台 ──► 生命周期观察者重新注册 ──► 意外"恢复"
```

这不是谁的疏忽，是"**单例 + 单播回调 + 多消费者**"的结构性冲突：单例保证了全局只有一个服务，单播回调却假定了全局只有一个消费者。测试页、埋点、客服插件，任何一个新消费者进来都会静默踩掉别人。这是全部病灶里风险最高的一条，因为它不报错、不崩溃，只是"弹幕不来了"——而 T3 的"自愈"让它在测试环境里时隐时现，几乎不可能稳定复现。

#### 3.2 病灶二：bool/int 状态过多与伪装

bool 和 int 状态遍布各层，其中一半是"伪装"——用 int 表达本该是枚举或 bool 的语义：

| 状态 | 位置 | 类型 | 问题 |
| --- | --- | --- | --- |
| `_isInitialized` / `_isPlaying` / `_hasVisualChanges` | 引擎 | bool | 引擎内部私有小状态，尚可接受 |
| `isActive` / `isCompleted` | 弹幕 item | bool | 两个 bool 编码三态（等待/活跃/完成），存在非法组合 |
| `skipAnimationTrigger` | Stream 数据项 | bool | 用 flag 给消息分类，一条管道两种语义（2.6） |
| `hasText` | 业务控制器 | bool | 跨控制器消费，引发 3.4 的真 bug |
| `wishlistKeyboardVisible` | 首页控制器 | bool | 由 View 层反写（3.4） |
| `isConnected` ×2 | 首页控制器 RxBool / MQTT 服务 getter | 同一语义两份 | 靠人肉同步 |
| loading 遮罩状态 | 业务控制器 | RxInt 0/1/2 | **int 伪装枚举**：语义全靠注释 |
| `loadMark` | 业务控制器 | int 0/1 | **int 伪装 bool**："用来标记收到数据" |
| `isClick` | 数据模型 | 服务端 int / UI bool | **单位漂移**：解析边界转一次，之后两套表示并存 |

loading 遮罩是 int 伪装枚举的完整标本，注释与实现都值得一看：

```dart
/// 0 默认显示状态
/// 1 展示状态
/// 2 隐藏状态
final showLoadingStatus = 0.obs;

/// 用来标记收到数据
var loadMark = 0;

void hideLoading() async {
  if (loadMark == 1) return; // int 伪装 bool：保证只执行一次
  loadMark = 1;

  /// 减去边距和 loading 所占宽度再除 2，除以速度换算毫秒：
  /// 让 loading 恰好"送走"第一屏弹幕再淡出
  final ms = (screenWidth - 60 - 200) / 2 / danmuSpeed * 1000;
  await Future.delayed(Duration(milliseconds: ms.toInt()));
  showLoadingStatus.value = 1; // 淡出
  await Future.delayed(const Duration(seconds: 1));
  showLoadingStatus.value = 2; // 隐藏
}
```

0/1/2 的含义只存在于注释里：读代码的人要背一张映射表，写代码的人可能写出 `showLoadingStatus.value = 3`——类型系统毫无意见。`isClick` 则是单位漂移：服务端下发 `int`，`toComponent` 里转成 `bool` 传入卡片（`isClick: isClick == 1`），于是同一个概念在数据模型和 UI 组件里是两种类型，任何一处忘记转换就是静默逻辑错误。

#### 3.3 病灶三：同一语义三份真相

"这条弹幕被我点过赞吗"这一个语义，同时存在三份真相：

1. 本地 `Set<String>`（乐观点击，接口成功后加入，业务控制器持有）；
2. 服务端下发的 `isClick` int（数据模型持有）；
3. 卡片组件里的 `isClick` bool（`toComponent` 转换产物）。

三者交叉决定文案与配色，还有一行拼接逻辑：

```dart
final isClickedByUser = controller.isClickedByLocal(id); // 真相 1
final finalIsClick = isClickedByUser || isClick;         // 真相 2/3 拼接
final targetUser = finalIsClick ? (UserManager.nickName ?? '') : '';
```

第三行还顺带依赖了全局 User 单例——"最后点赞的人是我"要跨三层查全局状态。三份真相意味着任何一个新需求（比如"取消点赞"）都要同时改三处，漏一处就出现"图标亮着但计数没变"式的状态漂移。注释里还留着大段历史 if 分支，说明这里已经改怕了。判断标准很简单：**`finalIsClick` 这种"拼接真相"的存在，就是建模失败的信号**——它从来不该被存储，只该被计算（4.6 的解法）。

#### 3.4 病灶四：过于依赖外部控制器（含一个真 bug）

**真 bug：跨控制器状态写入错位。** 输入条的清除按钮显隐依赖业务控制器的 `hasText`，但输入条外层包的是**首页控制器**的 GetBuilder：

```dart
// 业务控制器内：hasText 的写入方
void _onTextChanged() {
  final has = wishInputController.text.isNotEmpty;
  if (has != hasText) {
    hasText = has;
    update(); // 通知的是业务控制器自己的监听者
  }
}
```

```dart
// 输入条（首页控制器的 GetBuilder 里）：hasText 的消费方
GetBuilder<HomeController>(
  builder: (homeController) => Row(
    children: [
      Expanded(
        child: TextField(controller: wishlistController.wishInputController),
      ),
      // 显隐读的是业务控制器的 hasText，
      // 重建却听的是首页控制器——两个通知域没有交集
      if (wishlistController.hasText)
        IconButton(icon: const Icon(Icons.close), onPressed: onClear),
    ],
  ),
)
```

`hasText` 变化时调用的是业务控制器的 `update()`，首页控制器的 GetBuilder 收不到通知——**清除按钮的显隐要等到下一次任意原因的重建才生效**。用户输入第一个字符后，清除按钮可能延迟数秒才出现。这是一个结构必然的 bug：状态的写入方与消费方住在不同的通知域里，靠"恰好会有别的重建来救场"维持表面正常。

**View 反写 Controller。** 键盘可见性由 View 层写进首页控制器，再被另外三处读取：

```dart
// 弹幕页 View 的 build 里
KeyboardVisibilityBuilder(builder: (context, isKeyboardVisible) {
  controller.wishlistKeyboardVisible = isKeyboardVisible; // View 写 Controller
  if (isKeyboardVisible) {
    wishDanmuController.pauseDanmu();
  } else {
    wishDanmuController.startDanmu();
  }
  WidgetsBinding.instance.addPostFrameCallback((_) {
    controller.update(); // build 里派发动作后再补一次刷新
  });
  // ...
});
```

build 方法里写状态 + 派发动作 + 补刷新，意味着每次重建都执行一遍副作用，副作用又触发重建——这类代码的正确性依赖执行顺序的运气，而且无法单测。

**自愈式访问。** 业务控制器的 getter 是"查不到就重建"：

```dart
class WishlistController extends GetxController {
  static WishlistController get to {
    if (Get.isRegistered<WishlistController>(tag: 'wishlist_danmu')) {
      return Get.find<WishlistController>(tag: 'wishlist_danmu');
    }
    // 查不到就重建（源码还有一行日志："未注册，重新注册"）
    return Get.put(WishlistController(), tag: 'wishlist_danmu');
  }

  DanmakuEngine get danmuController {
    if (Get.isRegistered<DanmakuEngine>(tag: 'wishlist_danmu')) {
      return Get.find<DanmakuEngine>(tag: 'wishlist_danmu');
    }
    return _initializeDanmuController(); // 同样的自愈
  }
}
```

配合 `Get.delete<DanmakuEngine>(tag: ..., force: true)`，谁先死、谁重建、stream 有没有重连，全靠运行时碰运气。生命周期错误被"自愈"掩盖成性能抖动，永远到不了该到的人面前。一条弹幕卡片的渲染还依赖全局 UserManager 单例 + 全局 GetX 注册表，无法离线单测。

**职责混杂放大了依赖。** MQTT 服务一个类同时管连接、重连、topic 枚举、消息解码，还内置**业务 HTTP API 调用**（1.3 节的 `pullLatestForWishlist`，网络层单例里硬编码业务端点，不进统一的 api_paths 定义）；业务控制器同时管引擎装配、JSON 解析、loading 编排、点击节流、两个业务 API、输入框 controller。每个依赖方向都是双向的，心智模型自然重。

#### 3.5 并发症一：队列与消息风暴无治理

等待队列**无上限**：MQTT 洪峰或键盘弹起期间（弹幕暂停但推送不停）会无限积压组件对象；无消息节流/合并；每帧只看队头，队头卡住整队饿死（2.4 的克制设计在这里翻面）；弹幕容器 build 的 postFrame **无条件**补拉，键盘可见性变化触发重建时会重复请求 + 重复喂一屏弹幕——数据无去重，同 id 弹幕再次入场。风暴的完整链条：

```text
MQTT 洪峰（N 条/秒）
   │ 逐条 emit（无合并窗口）
   ▼
broadcast Stream ──► 引擎 send（队列无上限）
   │                     │
   │ 键盘弹起 → pause     ▼
   │              等待队列无限增长（组件对象 + 关联图片缓存）
   ▼                     │
postFrame 重建 ──► 补拉一屏 ──► 同 id 弹幕再次入场（无去重）
```

四个"无"（无上限、无合并、无去重、无队头超时）单独看都能忍，叠加在"保活 Tab + 键盘联动 + QoS 1 至少一次投递"的真实环境里就是内存与体验的双重炸弹。

#### 3.6 并发症二：死代码与魔法数字

逐条列出（均可在源码验证）：

- 配置项 `targetFps` 传了 25，但引擎根本不读它——实际硬编码 `static const _updateInterval = 1.0 / 25.0`。配置项"存在但不生效"比没有更糟：调参的人会以为自己在起作用。
- 注释写"minSpacing 增加到 50px 避免拥挤"，代码是 30px；`targetFps` 注释写"降低到 20FPS"，代码传 25。注释与代码互相打架。
- 负载权重 2.0 / 1.0 / 1.5、卡片 490x260、轨道高 260、轨距 30 全是裸数字，无出处无解释。
- 用户弹幕固定 `preferredTrackId: 3`，代码里 FIXME 承认"目前不生效，是随机在某个轨道"。
- 拼写错误的重订阅静态方法（`redSubscriTopic`）与库内 `resubscribeOnAutoReconnect` 自动重订阅职责重叠。
- broker 地址硬编码在构造函数里（生产值匿名化为 `broker.example.com`），环境切换靠注释掉的三段代码切换。
- `onAutoReconnected` 回调被连续赋值两次（第二次覆盖第一次，纯死代码）。
- 约 150 行注释掉的旧 WebSocket 数据源、注释掉的发布消息方法、注释掉的第二个 topic 分支。
- 自定义连接状态枚举里 `reconnecting` 值**从未被赋值**——状态机里根本没有重连态，UI 永远感知不到"正在重连"，用户看到的是"断开 → 直接连上"的假象。

#### 3.7 并发症三：测试页 60% 逻辑复制

调试页控制器与生产控制器是两份平行实现：初始化配置一份、MQTT 连接一份、JSON 解析一份、点击处理一份，约 60% 逻辑重复。它不是"复用生产链路的只读观察者"，而是"另一个消费者"——于是共享单例回调互相踩踏（3.1），生产改了解析逻辑调试页不改，调试数据与生产数据逐渐分叉。调试设施的正确形态是"只读 tap"，4.8 给出完整方案。

#### 3.8 病灶汇总：症状 → 根因 → 修复方向

| # | 病灶 | 直接症状 | 根因 | 修复方向 |
| --- | --- | --- | --- | --- |
| 1 | 单槽回调被抢注 | 打开调试页生产弹幕断流 | 单例 + 单播 + 多消费者 | broadcast 多播（4.3） |
| 2 | bool/int 泛滥 | 语义靠注释，改一处漏三处 | 缺状态建模纪律 | enum + 单一真相（4.6） |
| 3 | 三份真相 | 点赞态漂移 | 派生值被物化存储 | 只留一个可写源（4.6） |
| 4 | 跨控制器写入错位 | 清除按钮延迟生效（真 bug） | 状态归属错层 | 输入状态收拢（4.6） |
| 5 | 自愈式依赖 + 职责混杂 | 生命周期靠运气 | 无所有权边界 | 分层 + fail-fast（4.1/4.7） |
| 6 | 队列无治理 | 洪峰积压、同 id 重复入场 | 无上限无去重无合并 | LRU + 合并窗口 + 上限（4.4/4.5） |
| 7 | 死代码魔法数字 | 注释与代码打架 | 无配置真源 | 配置显式化（4.2） |
| 8 | 测试页复制 | 调试即劫持 | 无只读调试通道 | tap 流 / mock 工厂（4.8） |

### 4. 重构方案：分层、多播与单一真相

目标一句话：**骨架不动，结缔组织全部重接**。渲染引擎的轨道/碰撞/队列/降频逻辑保留（2.9 六条），围绕它的分发、状态、生命周期推倒重来。本章每层核心类给完整实现。

#### 4.1 目标架构：五层

```text
┌──────────────────────────────────────────────────────────────┐
│  UI 层                                                       │
│  DanmakuView（ListenableBuilder 渲染）/ DanmakuCard /        │
│  DanmakuInputBar（持有 WishlistInputController）             │
│  只依赖 item 数据与回调，不碰任何单例                           │
├──────────────────────────────────────────────────────────────┤
│  DanmakuEngine（渲染引擎，ChangeNotifier）                    │
│  轨道 / 队列（带上限）/ 回收 / Ticker 驱动                     │
│  对外：add / clear / pause / resume / dispose                │
│        + ValueListenable<int> activeCount                    │
├──────────────────────────────────────────────────────────────┤
│  WishlistDanmakuRepo（弹幕仓库）                              │
│  订阅管理 / 补拉 / 去重（LRU seenIds）/ 100ms 合并窗口         │
├──────────────────────────────────────────────────────────────┤
│  MessageHub（消息多播）                                       │
│  broadcast Stream<Message(topic, payload)>，可注册多个消费者   │
├──────────────────────────────────────────────────────────────┤
│  MqttTransport（纯连接层）                                    │
│  connect / disconnect / dispose / subscribe / unsubscribe    │
│  + Stream<ConnState> states；不含任何业务与 HTTP              │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 职责 | 明确不做 |
| --- | --- | --- |
| MqttTransport | 连接、重连、订阅、原始消息吐出 | 不做 JSON 解析、不做 HTTP、不持业务回调 |
| MessageHub | topic → 消息多播分发 | 不解析 payload、不理解业务语义 |
| WishlistDanmakuRepo | 订阅心愿单 topic、补拉、去重、合并、吐出干净 item 流 | 不碰渲染、不碰 UI |
| DanmakuEngine | 轨道、队列、Ticker、回收 | 不依赖 GetX、不理解业务 |
| UI | 卡片、输入条、视图组装 | 不读全局单例、不反写控制器 |

依赖规则只有一条：**只能向下依赖，不能向上、不能跨层**。UI 不 import transport；engine 不知道 repo 存在；repo 不知道 engine 存在——它们在页面层被组装。分层不是文档美观问题：3.4 的每个"职责混杂"证据，都对应一条被违反的依赖规则。

#### 4.2 MqttTransport：纯连接层与真的状态机

把 MQTT 服务里的业务 API、topic 枚举、单槽回调全部剥离，只留连接语义。第一件事：让 `reconnecting` 成为真的状态——枚举里的每个值都必须有赋值它的代码路径，否则删掉：

```dart
enum ConnState { disconnected, connecting, connected, reconnecting }

class MqttConfig {
  final String broker;
  final int port;
  final String clientId;
  final String username;
  final int keepAlive;
  const MqttConfig({
    required this.broker,
    this.port = 1883,
    required this.clientId,
    required this.username,
    this.keepAlive = 60,
  });
}

/// 一条已解码的原始消息：topic + UTF-8 字符串
class MqttMessage {
  final String topic;
  final String payload;
  const MqttMessage(this.topic, this.payload);
}

class MqttTransport {
  /// onMessage 在构造期注入、永不更换——transport 的"单消费者"就是它
  MqttTransport({void Function(String topic, String payload)? onMessage})
      : _onMessage = onMessage;

  final void Function(String topic, String payload)? _onMessage;
  MqttServerClient? _client;
  final Set<String> _subscribedTopics = <String>{};
  final _states = StreamController<ConnState>.broadcast();

  ConnState _state = ConnState.disconnected;
  ConnState get state => _state;
  Stream<ConnState> get states => _states.stream;
  bool get isConnected => _state == ConnState.connected;

  Future<bool> connect(MqttConfig cfg) async {
    if (isConnected) return true;
    _setState(ConnState.connecting);
    try {
      final client =
          MqttServerClient.withPort(cfg.broker, cfg.clientId, cfg.port);
      client.keepAlivePeriod = cfg.keepAlive;
      client.autoReconnect = true;              // 断线自动重连交给库
      client.resubscribeOnAutoReconnect = true; // 重连后自动重订阅
      client.logging(on: false);
      client.connectionMessage = MqttConnectMessage()
          .authenticateAs(cfg.username, cfg.username)
          .startClean()
          .withWillQos(MqttQos.atLeastOnce);
      client.onConnected = () => _setState(ConnState.connected);
      client.onDisconnected = () => _setState(ConnState.disconnected);
      client.onAutoReconnect = () =>
          _setState(ConnState.reconnecting); // 重连态：真实存在、可被订阅
      client.onAutoReconnected = () {
        _setState(ConnState.connected);
        _resubscribeAll(); // 与库内重订阅幂等共存，只做兜底
      };
      client.updates!.listen(_onUpdates);

      await client.connect();
      if (client.connectionStatus?.state !=
          MqttConnectionState.connected) {
        _setState(ConnState.disconnected);
        return false;
      }
      _client = client;
      _setState(ConnState.connected);
      await _resubscribeAll(); // 补齐断线期间记账的订阅
      return true;
    } catch (_) {
      _setState(ConnState.disconnected);
      return false;
    }
  }

  /// 非终态断开：后台切换用，states 流保持打开
  Future<void> disconnect() async {
    _client?.disconnect();
    _client = null;
    _setState(ConnState.disconnected);
  }

  void subscribe(String topic, {MqttQos qos = MqttQos.atLeastOnce}) {
    _subscribedTopics.add(topic); // 断线期间也记账，重连后补齐
    _client?.subscribe(topic, qos);
  }

  void unsubscribe(String topic) {
    _subscribedTopics.remove(topic);
    _client?.unsubscribe(topic);
  }

  void _onUpdates(List<MqttReceivedMessage<MqttMessage>>? messages) {
    if (messages == null) return;
    for (final message in messages) {
      final published = message.payload as MqttPublishMessage;
      String payload;
      try {
        payload = utf8.decode(published.payload.message);
      } catch (_) {
        payload = MqttPublishPayload.bytesToStringAsString(
            published.payload.message);
      }
      _onMessage?.call(message.topic, payload); // 唯一出口
    }
  }

  Future<void> _resubscribeAll() async {
    final client = _client;
    if (client == null) return;
    for (final topic in _subscribedTopics) {
      client.subscribe(topic, MqttQos.atLeastOnce);
    }
  }

  void _setState(ConnState next) {
    if (_state == next) return;
    _state = next;
    _states.add(next); // 状态变化即事件：谁关心谁订阅
  }

  /// 终态销毁：仅应用退出时调用
  Future<void> dispose() async {
    await disconnect();
    _subscribedTopics.clear();
    await _states.close(); // 只清理自己拥有的资源，不碰任何业务
  }
}
```

四个关键决定，每个都对着一个病灶：

1. **`reconnecting` 真的被赋值**（病灶 7）：UI 可以对"正在重连"显示转圈，而不是断开/连上的二值假象。
2. **`disconnect()` 与 `dispose()` 分离**（病灶 4 + 坑 2）：后台切换是可逆的 `disconnect()`，应用退出才是终态 `dispose()`。生产实现只有一个终态 dispose 且顺带清空业务回调，重连后消息静默丢失。
3. **`onMessage` 构造期注入**——这不是 3.1 的单槽回调问题的复发。区别在于：生产实现的 `setOnXxx` 是运行期可变、暴露给所有业务方的公共槽位（多消费者抢一个槽）；这里是构造期固定、组合根注入的一对一出口（transport 的消息永远只交给 hub 一个下游）。**单播本身不是罪，把单播槽位直接暴露给业务层多消费者才是。**
4. **broker 地址从 `MqttConfig` 传入**（病灶 7）：环境切换回归配置系统，不再注释代码；同时删掉 topic 枚举、业务 API（挪回业务侧统一 API 层，端点进 api_paths 常量定义）。

#### 4.3 MessageHub：广播流替代单槽回调

这是**风险收益比最高**的一刀，根治病灶一：

```dart
class MessageHub {
  final _controller = StreamController<MqttMessage>.broadcast();

  /// 多播：任意数量的消费者，互不干扰
  Stream<MqttMessage> get messages =>
      _controller.stream.asBroadcastStream();

  /// 按 topic 模式订阅的便捷方法，返回订阅以便取消
  StreamSubscription<MqttMessage> on(
      Pattern topicPattern, void Function(String payload) handler) {
    return _controller.stream
        .where((m) => topicPattern.allMatches(m.topic).isNotEmpty)
        .listen((m) => handler(m.payload));
  }

  /// 由 Transport 的 onMessage 调用（唯一写入口）
  void emit(String topic, String payload) {
    if (!_controller.isClosed) {
      _controller.add(MqttMessage(topic, payload));
    }
  }

  void dispose() => _controller.close();
}
```

transport 与 hub 的装配发生在**组合根**——应用启动时唯一允许"知道所有层"的地方：

```dart
/// 组合根：应用启动装配一次
class RealtimeGraph {
  RealtimeGraph._();
  static final RealtimeGraph instance = RealtimeGraph._();

  late final MessageHub hub;
  late final MqttTransport transport;

  MqttConfig buildConfig(Env env) {
    final userId = UserManager.userId ?? 0;
    return MqttConfig(
      broker: env.mqttBroker, // 配置系统：broker.example.com 等
      clientId: buildClientId(userId),
      username: userId.toString(),
    );
  }

  void bootstrap(Env env) {
    hub = MessageHub();
    transport = MqttTransport(
      onMessage: (topic, payload) => hub.emit(topic, payload),
    );
    transport.connect(buildConfig(env));
  }

  Future<void> shutdown() async {
    await transport.dispose();
    hub.dispose();
  }
}
```

改造后的消费格局：首页控制器不再注册任何回调（它甚至不需要知道消息的存在）；仓库层用 `hub.on(RegExp(r'wishlist/products/'), ...)` 订阅——字符串匹配顺势显式化为正则模式；调试页只是 `hub.messages.listen(...)` 的一个 tap，开着关着都不影响任何人；未来加埋点、加客服监听都是**新订阅**，不是新劫持。broadcast 流的纪律是**谁 listen 谁 cancel**，消费者在自己的 dispose 里取消订阅（4.7 的时序图给出了全部取消点）。

为什么用 broadcast Stream 而不是 `Map<Pattern, handler>` 注册表？注册表也能多消费者，但注册/注销的时序约定仍靠文档；broadcast 流的订阅句柄（`StreamSubscription`）天然携带生命周期语义，配合 `cancel` 就是完整的解绑协议，而且是 Dart 原生机制，不新增概念。

#### 4.4 WishlistDanmakuRepo：去重、合并与风暴治理

仓库层收编"订阅 + 补拉 + 风暴治理"三件事。先给模型与 API（注意 `isClick` 在解析边界完成 int → bool 的**唯一一次**转换，此后全链路一种类型）：

```dart
class WishlistDanmakuItem {
  final String id;
  final String avatarUrl;
  final String nickname;
  final String title;
  final int heat;
  final bool clickedFromServer;

  const WishlistDanmakuItem({
    required this.id,
    required this.avatarUrl,
    required this.nickname,
    required this.title,
    required this.heat,
    required this.clickedFromServer,
  });

  factory WishlistDanmakuItem.fromJson(Map<String, dynamic> json) {
    return WishlistDanmakuItem(
      id: (json['id'] ?? '').toString(),
      avatarUrl: json['avatarUrl'] ?? '',
      nickname: json['nickname'] ?? '',
      title: json['title'] ?? '',
      heat: (json['heat'] as num?)?.toInt() ?? 0,
      clickedFromServer: (json['isClick'] as num?)?.toInt() == 1,
    );
  }
}

class WishlistApi {
  const WishlistApi();
  // 走统一 API 层，端点定义在 api_paths 常量里
  Future<List<Map<String, dynamic>>> latest() async {/* GET /wishlist/latest */}
  Future<bool> add(String productName) async {/* POST /wishlist/add */}
  Future<bool> like(String id) async {/* POST /wishlist/like */}
}
```

仓库完整实现：

```dart
class WishlistDanmakuRepo {
  WishlistDanmakuRepo(this._hub, this._api) {
    _sub = _hub.on(RegExp(r'wishlist/products/'), _onPush);
  }

  final MessageHub _hub;
  final WishlistApi _api;
  StreamSubscription<MqttMessage>? _sub;

  final _items = StreamController<WishlistDanmakuItem>.broadcast();
  Stream<WishlistDanmakuItem> get items => _items.stream;

  // 1) 去重：LRU seenIds
  final _seenIds = LinkedHashSet<String>();
  static const int _seenCapacity = 500;

  // 2) 合并：100ms 窗口攒批
  Timer? _mergeTimer;
  final List<WishlistDanmakuItem> _buffer = [];

  // 3) 截断：一次 flush 最多放行一屏
  static const int _maxPerFlush = 12;

  // 4) 补拉节流
  DateTime _lastPull = DateTime.fromMillisecondsSinceEpoch(0);
  static const Duration _pullThrottle = Duration(seconds: 3);

  void _onPush(String payload) {
    final batch = _parse(payload);
    _buffer.addAll(batch.where((e) => _remember(e.id))); // 去重
    _mergeTimer ??= Timer(const Duration(milliseconds: 100), _flush);
  }

  List<WishlistDanmakuItem> _parse(String payload) {
    final dynamic decoded = jsonDecode(payload);
    if (decoded is! List) {
      throw FormatException('期望 List，实际 ${decoded.runtimeType}');
    }
    return decoded
        .whereType<Map<String, dynamic>>()
        .map(WishlistDanmakuItem.fromJson)
        .toList();
  }

  void _flush() {
    if (_buffer.length > _maxPerFlush) {
      // 超一屏截断：只保留最新一屏
      _buffer.removeRange(0, _buffer.length - _maxPerFlush);
    }
    _buffer.forEach(_items.add);
    _buffer.clear();
    _mergeTimer = null;
  }

  bool _remember(String id) {
    if (_seenIds.contains(id)) {
      _seenIds.remove(id);
      _seenIds.add(id); // LRU：命中即"最近使用"，移到队尾
      return false;
    }
    _seenIds.add(id);
    if (_seenIds.length > _seenCapacity) {
      _seenIds.remove(_seenIds.first); // 淘汰最旧
    }
    return true;
  }

  /// 补拉最新一屏：前台恢复 / 订阅成功时调用；3 秒节流
  Future<void> pullLatest() async {
    final now = DateTime.now();
    if (now.difference(_lastPull) < _pullThrottle) return;
    _lastPull = now;
    try {
      final batch = await _api.latest();
      _buffer.addAll(batch
          .map(WishlistDanmakuItem.fromJson)
          .where((e) => _remember(e.id))); // 补拉与推送共用去重管道
      _mergeTimer ??= Timer(Duration.zero, _flush); // 立即冲刷
    } catch (_) {
      // 拉取失败不阻塞：推送通道仍然活着
    }
  }

  /// 页面隐藏/切后台：清空未冲刷的缓冲（不取消订阅，回前台继续收）
  void suspend() {
    _mergeTimer?.cancel();
    _mergeTimer = null;
    _buffer.clear();
  }

  Future<void> dispose() async {
    await _sub?.cancel(); // 谁 listen 谁 cancel
    _mergeTimer?.cancel();
    await _items.close();
  }
}
```

四个治理手段各对准一个症状，每个都值得讲清"为什么"：

**LRU 去重**治"同 id 重复入场"。重复来源有三：QoS 1 的 at-least-once 投递语义本身就可能重复、补拉窗口与推送窗口重叠、键盘弹起引发 postFrame 重复补拉。容量取一屏的几十倍（500）覆盖"用户离开半小时回来"的时间尺度；LRU 而非普通 Set，是因为"最近出现过的 id 更可能再出现"（服务端补拉总给最新一屏），命中要刷新它的"新鲜度"。去重放在仓库层而不是引擎层，因为引擎不该理解业务 id，而 UI 层去重已经晚了（同一 id 的两张卡已在飞）。

**100ms 合并窗口**治"逐条喂入"。一屏 payload 是 List，逐条 emit 会造成逐条入队、逐次判断、极端时逐帧插队；攒 100ms 一次冲刷，洪峰时 N 条推送只产生常数次 flush。100ms 的量级依据：低于一帧人眼无法区分，高于 300ms 会感知到"成批出现"，取 100ms 是"既合批又不破坏随机感"的折中。

**超一屏截断**治"积压追不上"。风暴过后队列里可能积压几百条，按正常出队速度要几分钟才能消化，用户体验是"弹幕墙在还债"。截断的哲学是**观众永远看"现在"，不补历史课**——落后的弹幕直接丢弃，只放行最新一屏。

**补拉节流**治"postFrame 重复请求"。`pullLatest` 内部 3 秒节流，键盘弹起引发的重建潮最多触发一次真实请求；配合去重，即使请求穿透也不会重复入场。生产实现的 postFrame 无条件补拉从此变成"订阅成功/前台恢复时调用一次"。

注意 `skipAnimationTrigger`（2.6 的 flag）在这个设计里消失了：暂停与否是**页面编排**的事——页面在键盘弹起时调 `engine.pause()`，数据照常流入队列（队列有上限，不怕积压），不需要给消息本身打标记。

#### 4.5 DanmakuEngine：去 GetX 化与队列治理

引擎保留 2.1–2.5 的全部骨架（轨道、碰撞简化、双 FIFO、自适应降频、严格回收），改四处：基类从 GetxController 换成 ChangeNotifier、队列加上限与队头超时、对外 API 收敛为五个动词、直持 Ticker。先给数据结构：

```dart
enum ItemPhase { queued, flying, done }

/// 渲染项：引擎只认 width/child，不认识任何业务概念
class DanmakuItem {
  DanmakuItem({
    required this.id,
    required this.width,
    required this.child,
    this.speed,
    this.priority = false,
  });

  final String id;
  final double width;    // 供碰撞检测与布局
  final Widget child;    // 页面组装好的卡片
  final double? speed;   // null 用引擎默认速度
  final bool priority;   // 用户自己发的弹幕走优先队列

  ItemPhase phase = ItemPhase.queued;
  DateTime enqueuedAt = DateTime.now();
  int trackId = -1;
  double speedResolved = 0;
  double startTime = 0;
  double? currentX;
}

class DanmakuTrack {
  DanmakuTrack({
    required this.id,
    required this.top,
    required this.height,
    required this.minSpacing,
  });

  final int id;
  final double top;
  final double height;
  final double minSpacing;

  final List<DanmakuItem> flying = [];
  final List<DanmakuItem> normalQueue = [];
  final List<DanmakuItem> priorityQueue = [];

  /// 负载评分：活跃权重最高，优先队列积压次之（沿用生产权重）
  double get loadScore =>
      flying.length * 2.0 +
      normalQueue.length * 1.0 +
      priorityQueue.length * 1.5;

  /// 出生碰撞检测：同轨同速，只需防出生重叠（保留生产简化）
  bool canAccept(double containerWidth, double newItemWidth) {
    if (flying.isEmpty) return true;
    final last = flying.last;
    final lastRight = last.currentX! + last.width;
    return containerWidth - lastRight >= minSpacing;
  }

  void clear() {
    flying.clear();
    normalQueue.clear();
    priorityQueue.clear();
  }
}
```

引擎完整实现：

```dart
class DanmakuEngine extends ChangeNotifier {
  DanmakuEngine({
    this.trackCount = 4,
    this.defaultSpeed = 30.0,
    this.minSpacing = 30.0,
    this.maxQueuePerTrack = 30,
  }) {
    _ticker = Ticker(_onTick); // 直持 Ticker：不依赖任何状态管理框架
  }

  final int trackCount;
  final double defaultSpeed;
  final double minSpacing;
  final int maxQueuePerTrack;
  static const Duration _headTimeout = Duration(seconds: 10);
  static const double _updateInterval = 1.0 / 25.0; // 定向刷新频率
  static const int _maxNoChangeFrames = 10;

  late final Ticker _ticker;
  final List<DanmakuTrack> _tracks = [];
  final List<DanmakuItem> _flying = [];

  double _containerWidth = 0;
  double _containerHeight = 0;
  double _currentTime = 0;
  double _pausedAt = 0;
  double _lastUpdateTime = 0;
  bool _playing = false;
  bool _visualDirty = false;
  int _noChangeFrames = 0;

  final _activeCount = ValueNotifier<int>(0);
  ValueListenable<int> get activeCount => _activeCount;

  List<DanmakuItem> get flyingItems => List.unmodifiable(_flying);
  double get containerWidth => _containerWidth;
  double topOf(int trackId) => _tracks.firstWhere((t) => t.id == trackId).top;

  // ---- 对外 API：五个动词 ----
  void add(DanmakuItem item) {
    if (_containerWidth <= 0) return; // 容器未布局，静默丢弃
    item.speedResolved = item.speed ?? defaultSpeed;
    if (_tracks.isEmpty) _rebuildTracks();
    final track = _selectTrack(item);
    item.trackId = track.id;
    if (track.canAccept(_containerWidth, item.width)) {
      _activate(item, track);
    } else {
      _enqueue(track, item);
    }
    _visualDirty = true;
  }

  void clear() {
    _flying.clear();
    for (final t in _tracks) {
      t.clear();
    }
    _activeCount.value = 0;
    notifyListeners();
  }

  void pause() {
    if (!_playing) return;
    _playing = false;
    _pausedAt = _currentTime;
    _ticker.stop();
  }

  void resume() {
    if (_playing) return;
    _playing = true;
    _ticker.start();
  }

  @override
  void dispose() {
    _ticker.stop();
    _ticker.dispose();
    _activeCount.dispose();
    super.dispose();
  }

  // ---- 布局 ----
  void resize(double width, double height) {
    if (width == _containerWidth && height == _containerHeight) return;
    _containerWidth = width;
    _containerHeight = height;
    _rebuildTracks(); // 高度变化重算轨道；飞行中弹幕保持原轨道
  }

  void _rebuildTracks() {
    if (_containerHeight <= 0) return;
    final trackHeight = _containerHeight / trackCount;
    _tracks.clear();
    for (var i = 0; i < trackCount; i++) {
      _tracks.add(DanmakuTrack(
        id: i,
        top: i * trackHeight,
        height: trackHeight,
        minSpacing: minSpacing,
      ));
    }
  }

  // ---- 仿真循环 ----
  void _onTick(Duration elapsed) {
    if (!_playing) return;
    _currentTime = _pausedAt + elapsed.inMicroseconds / 1e6;

    if (_dequeueHeads()) _visualDirty = true;      // 1. 队头出队
    final moved = _advancePositions();             // 2. 位置推进
    if (_recycleOffscreen()) _visualDirty = true;  // 3. 回收离屏
    _dropStaleHeads();                             // 4. 队头超时防饿死

    _noChangeFrames = moved ? 0 : _noChangeFrames + 1;
    final interval = _noChangeFrames > _maxNoChangeFrames
        ? _updateInterval * 1.5 // 无变化退避（保留）
        : _updateInterval;
    final shouldPaint = _visualDirty ||
        _currentTime - _lastUpdateTime >= interval ||
        _currentTime - _lastUpdateTime >= _updateInterval * 2; // 兜底（保留）
    if (shouldPaint) {
      _lastUpdateTime = _currentTime;
      _visualDirty = false;
      notifyListeners(); // 原 update(['danmu_layer']) 的等价物
    }
    _activeCount.value = _flying.length;
  }

  DanmakuTrack _selectTrack(DanmakuItem item) {
    final available =
        _tracks.where((t) => t.canAccept(_containerWidth, item.width)).toList();
    final pool = available.isNotEmpty ? available : _tracks;
    pool.sort((a, b) => a.loadScore.compareTo(b.loadScore));
    return pool.first;
  }

  void _activate(DanmakuItem item, DanmakuTrack track) {
    item.phase = ItemPhase.flying;
    item.startTime = _currentTime;
    item.currentX = _containerWidth;
    track.flying.add(item);
    _flying.add(item);
  }

  void _enqueue(DanmakuTrack track, DanmakuItem item) {
    item.enqueuedAt = DateTime.now();
    final queue = item.priority ? track.priorityQueue : track.normalQueue;
    queue.add(item);
    if (queue.length > maxQueuePerTrack) {
      queue.removeAt(0); // 溢出策略：丢最旧的（普通丢普通，优先丢优先）
    }
  }

  bool _dequeueHeads() {
    var processed = false;
    for (final track in _tracks) {
      for (final queue in [track.priorityQueue, track.normalQueue]) {
        if (queue.isEmpty) continue;
        final item = queue.first; // 每帧每轨只试队头（保留）
        if (track.canAccept(_containerWidth, item.width)) {
          queue.removeAt(0);
          _activate(item, track);
          processed = true;
          break; // 优先队列出队后直接看下一轨道（保留）
        }
      }
    }
    return processed;
  }

  bool _advancePositions() {
    var changed = false;
    for (final item in _flying) {
      final newX =
          _containerWidth - (_currentTime - item.startTime) * item.speedResolved;
      if ((newX - (item.currentX ?? newX)).abs() > 0.1) { // <0.1px 忽略（保留）
        item.currentX = newX;
        changed = true;
      }
    }
    return changed;
  }

  bool _recycleOffscreen() {
    final done = _flying
        .where((i) => (i.currentX ?? 0) + i.width < 0) // 严格离屏（保留）
        .toList();
    if (done.isEmpty) return false;
    for (final item in done) {
      _flying.remove(item);
      _tracks[item.trackId].flying.remove(item); // 双列表同步（保留）
    }
    return true;
  }

  void _dropStaleHeads() {
    final now = DateTime.now();
    for (final track in _tracks) {
      track.normalQueue.removeWhere(
          (i) => now.difference(i.enqueuedAt) > _headTimeout);
    }
  }
}
```

对照生产版本的四处变化，每处的"为什么"：

1. **ChangeNotifier 替代 GetxController**：引擎是纯渲染组件，不该绑定状态管理框架。GetBuilder 的定向刷新语义由 `ListenableBuilder` 完整继承（订阅域还是只有弹幕层）；`activeCount` 用 `ValueListenable` 单独暴露，调试面板挂载它时连弹幕层都不用重建。
2. **队列上限 + 丢最旧 + 队头超时**：上限 30/轨 封死"洪峰积压组件对象"；队头超时 10 秒封死"队头卡住整队饿死"——队头是特殊位置的弹幕（很宽）挡住时，普通队列里等了 10 秒的直接丢弃。注意超时只作用于普通队列：用户自己的弹幕（优先队列）宁可等也不能丢，这是优先级语义的一部分。
3. **API 收敛为五个动词**：`add/clear/pause/resume/dispose`。生产引擎暴露了 sendDanmuComponent、sendPriorityDanmuComponent、sendBatchDanmuComponent、startAnimation、pauseAnimation、stopAnimation、clearAllDanmu、connectStream……调用方要理解十几个方法的隐含关系（比如 start 与 send 谁触发谁）；五个动词没有隐含关系。
4. **直持 Ticker**：`Ticker(_onTick)` 不再借道 GetSingleTickerProviderStateMixin，启停完全由显式调用控制，dispose 必然释放——坑 1 的 vsync 陷阱在结构上消除。

配套视图（渲染树逐层对应 2.2，六条好设计的 1、2 号在这里落地）：

```dart
class DanmakuView extends StatelessWidget {
  const DanmakuView({super.key, required this.engine});
  final DanmakuEngine engine;

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: LayoutBuilder(builder: (context, constraints) {
        engine.resize(constraints.maxWidth, constraints.maxHeight);
        return ListenableBuilder(
          listenable: engine, // 订阅域 = 弹幕层（原 GetBuilder id 等价物）
          builder: (context, _) => RepaintBoundary(        // 整墙一层
            child: Stack(
              clipBehavior: Clip.hardEdge,
              children: [
                for (final item in engine.flyingItems)
                  Positioned(
                    left: item.currentX ?? constraints.maxWidth,
                    top: engine.topOf(item.trackId),
                    width: item.width,
                    child: RepaintBoundary(child: item.child), // 每卡一层
                  ),
              ],
            ),
          ),
        );
      }),
    );
  }
}
```

#### 4.6 状态建模三原则

**原则一：int 不许伪装。** 一切 0/1/2 魔法数显式建模。改造前后对照：

| 改造前 | 问题 | 改造后 |
| --- | --- | --- |
| `showLoadingStatus = 0/1/2`（RxInt） | int 伪装枚举，语义靠注释 | `enum LoadingPhase { hidden, visible, fading }` |
| `loadMark = 0/1` | int 伪装 bool（"只执行一次"） | LoadingController 的 `_greeted` 私有 bool，或直接用 phase 推导 |
| `isClick` 服务端 int / UI bool 并存 | 单位漂移 | 解析边界转一次 `clickedFromServer`，此后全链路 bool（4.4） |
| `isActive` + `isCompleted` 双 bool | 非法组合空间（既非 active 又非 completed 是什么？） | `enum ItemPhase { queued, flying, done }`（4.5） |
| `skipAnimationTrigger` flag | 用布尔给消息分类 | 删除；暂停是页面编排（`engine.pause()`），不是消息属性 |

loading 的重构版（对照 3.2 的 int 标本）：

```dart
enum LoadingPhase { hidden, visible, fading }

class LoadingController extends ChangeNotifier {
  LoadingPhase _phase = LoadingPhase.hidden;
  LoadingPhase get phase => _phase;
  bool _greeted = false; // 替代 loadMark："已迎接过首屏"的一次性语义

  /// 首屏数据到达后，按第一屏完全飘出的时长让 loading 淡出
  Future<void> onFirstScreenArrived(double containerWidth, double speed) async {
    if (_greeted) return;
    _greeted = true;
    _set(LoadingPhase.visible);
    final flyoutMs = (containerWidth / speed * 1000).round();
    await Future.delayed(Duration(milliseconds: flyoutMs));
    _set(LoadingPhase.fading);
    await Future.delayed(const Duration(seconds: 1));
    _set(LoadingPhase.hidden);
  }

  void _set(LoadingPhase next) {
    if (_phase == next) return;
    _phase = next;
    notifyListeners();
  }
}
```

语义变化全部走枚举迁移，`phase == LoadingPhase.visible` 在类型系统里可检查、可穷举 switch；"只执行一次"由私有 bool 显式命名。

**原则二：单一真相 + 派生计算。** "被我点赞"只保留一个可写源（本地乐观点击 Set），服务端状态是只读事实，UI 显示是两者的**派生值**，禁止第三份存储：

```dart
class ClickState extends ChangeNotifier {
  final Set<String> _localLikes = {}; // 唯一可写源

  void markLiked(String id) {
    if (_localLikes.add(id)) notifyListeners();
  }

  bool isLiked(WishlistDanmakuItem item) =>
      item.clickedFromServer || _localLikes.contains(item.id); // 派生
}
```

```dart
// 卡片里的消费：只读派生值，不再持有第三份 bool
ListenableBuilder(
  listenable: clickState,
  builder: (context, _) {
    final liked = clickState.isLiked(item);
    return LikeCapsule(
      liked: liked,
      count: item.heat + (liked ? 1 : 0), // 计数同样是派生
      onTap: () => onLike(item),
    );
  },
)
```

`finalIsClick` 拼接消失了——它从来不该被存储，只该被计算。点"+1"成功后 `markLiked(id)` 一个动作，所有读 `isLiked` 的卡片自动一致；"取消点赞"这类新需求只改 `ClickState` 一处。判断你是否违反了单一真相的试金石：**如果某个语义的更新需要同步多个字段/对象，说明它有多份真相**。

**原则三：状态跟着所有者走。** 键盘/输入状态全部收进一个与输入条组件同生命周期的 `WishlistInputController`：

```dart
class WishlistInputController extends ChangeNotifier {
  final focusNode = FocusNode();
  final textController = TextEditingController();
  bool hasText = false;
  bool keyboardVisible = false; // 由 focusNode 派生，View 不反写

  WishlistInputController() {
    textController.addListener(_sync);
    focusNode.addListener(_sync);
  }

  void _sync() {
    hasText = textController.text.isNotEmpty;
    keyboardVisible = focusNode.hasFocus;
    notifyListeners(); // 通知的是输入条自己的监听者
  }

  void clear() => textController.clear();

  void dispose() {
    focusNode.dispose();
    textController.dispose();
    super.dispose();
  }
}
```

```dart
class DanmakuInputBar extends StatefulWidget {
  const DanmakuInputBar({super.key, required this.onSubmitted});
  final ValueChanged<String> onSubmitted;

  @override
  State<DanmakuInputBar> createState() => _DanmakuInputBarState();
}

class _DanmakuInputBarState extends State<DanmakuInputBar> {
  late final WishlistInputController input = WishlistInputController();

  @override
  void dispose() {
    input.dispose(); // 与输入条同生共死
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: input, // hasText 与消费者在同一个通知域
      builder: (context, _) => Row(
        children: [
          Expanded(
            child: TextField(
              controller: input.textController,
              focusNode: input.focusNode,
              onSubmitted: widget.onSubmitted,
            ),
          ),
          if (input.hasText) // 3.4 的 bug 在结构上不再可表达
            IconButton(
              icon: const Icon(Icons.close),
              onPressed: input.clear,
            ),
        ],
      ),
    );
  }
}
```

对照 3.4 的真 bug：生产实现里 `hasText` 写在业务控制器、消费在首页控制器的通知域，两个域没有交集，只能靠"别的重建来救场"。重构后**状态和它的所有消费者住在同一个通知域里**——bug 不是被修复，是被结构消灭。业务层需要感知"用户发了弹幕"，通过 `onSubmitted` 回调上抛事件；键盘弹起联动弹幕暂停，由页面层监听 `input.keyboardVisible` 后调 `engine.pause()/resume()`——View 不再反写任何 Controller。

#### 4.7 生命周期所有权：fail-fast 与所有权树

删掉所有"查不到就重建"的自愈式 getter，换成 fail-fast：

```dart
T findOrThrow<T>({String? tag, String hint = ''}) {
  assert(() {
    if (!Get.isRegistered<T>(tag: tag)) {
      throw FlutterError(
          '$T ($tag) 未注册。生命周期错误应在开发期爆炸，$hint');
    }
  }());
  return Get.find<T>(tag: tag);
}
```

debug 断言 + 明确异常：让"谁先死、谁重建"的错误在开发期就爆炸，而不是被自愈掩盖成线上抖动。所有权树——每个对象有且只有一个创建者与释放者：

```text
App / 路由级（组合根）
 └── MqttTransport（应用级单例，跨页面存活）
      └── MessageHub（应用级，随 transport 存活）
           ├── 首页 WishlistDanmakuRepo（页面级，订阅/退订由页面驱动）
           │    └── DanmakuEngine（页面级，页面创建与销毁）
           │         └── DanmakuView / DanmakuCard（widget 树）
           ├── 调试页：只读 tap（messages.listen，dispose 时 cancel）
           └── 未来消费者：埋点 / 客服 / 通知……（互不知晓）
```

页面是页面级对象的唯一所有者，完整装配代码：

```dart
class WishlistTabPage extends StatefulWidget {
  const WishlistTabPage({super.key});

  @override
  State<WishlistTabPage> createState() => _WishlistTabPageState();
}

class _WishlistTabPageState extends State<WishlistTabPage>
    with WidgetsBindingObserver {
  late final DanmakuEngine engine;
  late final WishlistDanmakuRepo repo;
  late final ClickState clicks;
  late final LoadingController loading;
  StreamSubscription<WishlistDanmakuItem>? _feed;
  bool _firstScreenArrived = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);

    final graph = RealtimeGraph.instance; // 组合根持有 transport + hub
    engine = DanmakuEngine();
    repo = WishlistDanmakuRepo(graph.hub, const WishlistApi());
    clicks = ClickState();
    loading = LoadingController();

    _feed = repo.items.listen(_onItem); // 仓库 → 引擎的唯一管道
    graph.transport
        .subscribe('wishlist/products/${UserManager.userId}');
    repo.pullLatest(); // 首屏对齐
    engine.resume();
  }

  void _onItem(WishlistDanmakuItem item) {
    if (!_firstScreenArrived) {
      _firstScreenArrived = true;
      loading.onFirstScreenArrived(engine.containerWidth, engine.defaultSpeed);
    }
    engine.add(DanmakuItem(
      id: item.id,
      width: DanmakuCard.designWidth,
      child: DanmakuCard(item: item, clicks: clicks, onLike: _like),
    ));
  }

  Future<void> _like(WishlistDanmakuItem item) async {
    if (clicks.isLiked(item)) return; // 已点赞（含服务端事实）直接短路
    if (await const WishlistApi().like(item.id)) {
      clicks.markLiked(item.id); // 唯一可写源
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final graph = RealtimeGraph.instance;
    switch (state) {
      case AppLifecycleState.paused:
        engine.pause();
        repo.suspend(); // 清缓冲，订阅保留
        graph.transport.disconnect(); // 可逆断开，states 流保持打开
        break;
      case AppLifecycleState.resumed:
        graph.transport.disconnect(); // 确保旧连接清理（幂等）
        graph.transport.connect(graph.buildConfig(currentEnv)).then((ok) {
          if (!ok) return;
          engine.clear(); // 清屏：旧内容已无意义
          repo.pullLatest(); // 对齐最新一屏
          engine.resume();
        });
        break;
      default:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _feed?.cancel();     // 谁 listen 谁 cancel
    engine.dispose();    // 释放 ticker / activeCount
    repo.dispose();      // 取消订阅、关流
    clicks.dispose();
    loading.dispose();
    RealtimeGraph.instance.transport
        .unsubscribe('wishlist/products/${UserManager.userId}');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      DanmakuView(engine: engine),
      // 输入条、loading 遮罩、点赞胶囊等（略）
    ]);
  }
}
```

四个场景的时序（注意每一步都有明确的执行者）：

```text
进页    initState（页面）
        → 创建 Engine / Repo / ClickState / Loading
        → repo 订阅 wishlist/products/{userId} → repo.pullLatest()
        → engine.resume()

切后台  AppLifecycleState.paused（页面处理）
        → engine.pause() → repo.suspend()（清缓冲）
        → transport.disconnect()（可逆；states 流仍活着）

回前台  AppLifecycleState.resumed（页面处理）
        → transport.connect()
        → states 捕获 reconnecting → connected 事件序列
        → engine.clear() + repo.pullLatest()（清旧屏、对齐新屏）
        → engine.resume()

离页    dispose（页面处理）
        → _feed.cancel() → engine.dispose() → repo.dispose()
        → clicks/loading.dispose() → transport.unsubscribe(topic)
        （transport 与 hub 是应用级，不随页面销毁）
```

对比生产实现的三处改善：其一，"后台断连"从全局观察者里的隐式动作变成页面生命周期回调里的显式编排，且 transport 的 `states` 流本身就是事件源——页面订阅 `reconnecting → connected` 决定清屏与补拉，不靠"重连后记得重新注册回调"的人肉契约（坑 2 根除）。其二，回前台的清屏 + 补拉由页面做，而生产实现里这段逻辑长在全局观察者里、跨三层 `Get.find`（2.7 的 `_reconnectAndCatchUp`）。其三，健康检查补丁（2.5）在这个结构里大概率自然消失——ticker 的启停全部由所有权树上的显式调用驱动，不存在"不知道谁把动画停了"的暗状态；若线上仍需要兜底，保留定时器也不冲突，但它从"唯一的保障"降级为"保险丝"。

#### 4.8 调试页解耦

调试页两个选项，都不注册回调、零逻辑复制：

**选项 A：从广播流 tap（只读观察）。** 调试页是 hub 的一个普通订阅者，与生产链路互不知晓：

```dart
class DebugPanel extends StatefulWidget {
  const DebugPanel({super.key});
  @override
  State<DebugPanel> createState() => _DebugPanelState();
}

class _DebugPanelState extends State<DebugPanel> {
  final _log = <String>[];
  final _counts = <String, int>{};
  StreamSubscription<MqttMessage>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = RealtimeGraph.instance.hub.messages.listen((m) {
      if (!mounted) return;
      setState(() {
        _log.insert(0, '${DateTime.now().toIso8601String()} ${m.topic}');
        _counts[m.topic] = (_counts[m.topic] ?? 0) + 1;
        if (_log.length > 200) _log.removeLast();
      });
    });
  }

  @override
  void dispose() {
    _sub?.cancel(); // 谁 listen 谁 cancel
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {/* 日志列表 + topic 计数面板 */}
}
```

**选项 B：引擎 mock 工厂（完全离线调试）。** 不碰任何真实链路，注入一条周期流就能调渲染：

```dart
class DanmakuEngine {
  // ... 4.5 的实现之外，追加一个调试工厂
  factory DanmakuEngine.debug({required Stream<DanmakuItem> mockStream}) {
    final engine = DanmakuEngine();
    engine.resume();
    mockStream.listen(engine.add); // 订阅句柄由调试页持有并 cancel
    return engine;
  }
}

// 调试页使用：每 2 秒飘一张假卡片，不连 MQTT、不调接口
final engine = DanmakuEngine.debug(
  mockStream: Stream<DanmakuItem>.periodic(
    const Duration(seconds: 2),
    (i) => DanmakuItem(
      id: 'mock_$i',
      width: DanmakuCard.designWidth,
      child: DanmakuCard(item: fakeItem(i), clicks: ClickState()),
    ),
  ),
);
```

对照 3.7：生产实现里调试页是"另一个消费者"（复制 60% 逻辑 + 抢注回调）；重构后它是"观察者"（tap）或"平行宇宙"（mock 工厂）。调试页打开一万次也不会影响生产弹幕，因为它根本没有能影响生产的通道。顺带地，`activeCount` 这个 `ValueListenable` 让调试面板显示"活跃/排队弹幕数"变成零成本挂载——调试能力是设计出来的，不是复制代码复制出来的。

#### 4.9 原样保留的六条好设计

呼应 2.9，逐条说明它们为什么在新架构里依然成立：

1. **定向刷新**：`update(['danmu_layer'])` → `ChangeNotifier + ListenableBuilder`，订阅域等价收缩。保留理由：逐帧动画的重建范围必须与页面其它 UI 隔离，这与用什么状态管理框架无关。
2. **双层 RepaintBoundary**：渲染树结构原样（整墙一层 + 每卡一层）。保留理由：repaint 边界是性能的地基，不是可选项。
3. **自适应降频**：三级策略（<0.1px / ×1.5 / ×2 兜底）原样。保留理由：空闲降频 + 兜底不停摆，是弹幕类组件的通用最优解。
4. **构造期固化随机渐变色**：卡片代码原样（`late final _gradient`）。保留理由：派生值不在 build 里现算，这条原则被原代码正确执行。
5. **出生重叠碰撞简化**：`canAccept` 逐字保留（只是改用已更新的 `currentX` 而非重算）。保留理由：同轨同速的不变量在新引擎里依然成立，O(1) 依然够用。
6. **EasyThrottle 节流**：点击与发送的节流键原样。保留理由：统一节流入口比散落的时间戳判断可维护。

重构的价值不在于重写好代码，而在于让好代码周围不再长坏代码。

#### 4.10 迁移策略：四步走

重构不是一次性的大爆炸重写，四步每步可独立回归、独立上线：

| 步骤 | 动作 | 风险 | 回归验证 |
| --- | --- | --- | --- |
| 1 | MessageHub 替换单槽回调（transport 保持旧壳，内部改 emit） | 低（消费侧逐个迁移） | 打开调试页 + 首页弹幕同时在线，观察互不干扰 |
| 2 | 状态单一真相化（ClickState + LoadingPhase + WishlistInputController） | 低 | 点赞/输入/loading 三条手工用例 + 清除按钮即时显隐 |
| 3 | 队列治理（LRU 去重 + 合并窗口 + 上限 + 补拉节流） | 中（需压测） | 灌 1000 条推送观察内存与流畅度；键盘反复弹起观察无重复入场 |
| 4 | 引擎去 GetX 化（GetxController → ChangeNotifier + 直持 Ticker） | 中 | 弹幕动画全量回归 + 前后台切换 20 次 + 页面进出 20 次 |

**为什么第 1 步先做**：它独立于其余三步、改动集中在传输层一处、直接消除最危险病灶（调试页劫持），且验证手段简单（同开调试页与生产页）。**为什么第 4 步最后做**：它动的骨架最大（引擎基类 + 渲染容器 + 所有调用点），而前三步已经把外围清理干净——hub 就位后引擎的输入是干净的 item 流，状态单一真相后引擎的输出只喂 ListenableBuilder，此时换基类只是机械劳动，不需要同时理解业务。每步一个 PR，出问题可以单独回滚——这才是生产系统重构的节奏。

## 常见坑与踩点

### 坑1：Ticker 挂在 GetX 控制器上的 vsync 陷阱

`GetSingleTickerProviderStateMixin` 假定控制器与某棵 widget 子树同生命周期（vsync 随 TickerProvider 的 muted 机制联动），但 GetX 控制器常被 `Get.put` 提到页面外存活——页面销毁、控制器还在、Ticker 还在跳，白烧电；反过来控制器被 `Get.delete(force: true)` 而 `onClose` 没有完整执行 stop + dispose，Ticker 泄漏并在下一个 tick 抛异常。**解法**：要么 Ticker 生命周期严格绑定拥有它的对象（4.5 的 ChangeNotifier + 显式 dispose），要么明确用 TickerMode/mute 让不可见期静音。判断标准：谁 createTicker，谁保证 dispose。

### 坑2：dispose 顺带清回调，重连后消息静默丢失

生产实现的 `dispose()` 会把业务方注册的消息回调一并置 null，而 mqtt_client 的 autoReconnect 可能在后台被打断、前台重连成功——**没有任何事件提醒业务方重新注册**。连接状态绿着、订阅列表还在（服务端视角你已重订阅），但客户端的消息回调是 null：消息到了、解码了、`_onMessageReceived?.call` 静默吞掉。日志一片干净，症状只有"弹幕不来了"。**解法**：连接层不持业务回调（消息走广播流，4.3）；重连语义通过 `states` 流显式广播（4.2 的 `reconnecting → connected`），消费者对事件自行决定补拉。

### 坑3：保活 Tab 里的弹幕墙在后台仍收推送

首页 Tab 通常放在 IndexedStack 里保活，用户滑去别的 Tab：弹幕墙不可见，但 MQTT 订阅还在、广播流还在进、队列还在积压。叠加"队列无上限"，积压的是组件对象（连带图片缓存）而不只是数据。**解法**：可见性驱动暂停（Tab 切走 `engine.pause()` + `repo.suspend()` 或退订），队列上限兜底（4.5）。IndexedStack 的 offstage 子树不 build 但 Stream 照常送达——这是所有"保活页面 + 长连接"组合的通病。

### 坑4：键盘弹起触发 postFrame 无条件补拉，重复请求 + 重复入场

键盘可见性变化 → 弹幕层高度变化 → 重建 → build 里的 postFrame 回调无条件补拉一屏 → 重复请求；补拉数据与推送窗口重叠、又无去重 → **同一张卡片在墙上飘了两遍**。这个链条的每一环单独看都"没什么问题"，串起来就是线上视觉事故。**解法**：补拉只在显式事件（前台恢复、订阅成功）触发且带节流；postFrame 里的逻辑必须幂等；进引擎前 LRU 去重（4.4）。

### 坑5：Transform.translate 与 Positioned 的命中差异

弹幕高速移动时用 `Transform.translate` 做位移：命中测试要把触点逆变换回子坐标，在频繁变换 + ClipRect 裁剪 + 部分离屏的组合下容易出现"看得见点不着 / 看不见还能点"的边角问题，且每帧变换走合成层。**解法**：布局期定位用 `Positioned`，命中区域即视觉区域。该项目的源码注释明确写了这个取舍——可点击的弹幕墙必须用 Positioned。

### 坑6：QoS 1 + 补拉导致同 id 弹幕重复入场

MQTT QoS 1 是 at-least-once，broker 重发、网络重试都可能造成同一条消息投递两次；补拉窗口与推送窗口重叠时同一条弹幕被喂两次。数据层无去重时 UI 无从分辨（引擎按自增计数器发 id，同一业务 id 的两张卡是两个"不同"的渲染项）。**解法**：进渲染引擎前按业务 id 做 LRU seenIds 去重（容量按一屏的几十倍取），补拉与推送共用同一条去重管道（4.4）。

### 坑7：broadcast 流忘记 cancel 订阅

`StreamController.broadcast` 的监听者不会随页面 dispose 自动解除。调试页 listen 了 hub 忘 cancel：页面销毁后回调仍打在已 disposed 的 State 上，轻则内存泄漏、重则 setState after dispose 抛错；更隐蔽的是"僵尸订阅"继续驱动计数器与日志，干扰排查。**解法**：纪律是"谁 listen 谁 cancel"，订阅句柄存到 State 字段、dispose 里统一 cancel（4.7/4.8 的示例都遵守）。

## 面试追问

###  弹幕渲染选型：CustomPainter、Stack+Positioned、列表复用怎么选？

三者分别对应绘制层、合成层、布局层复用。CustomPainter（如 canvas_danmaku 的做法）性能上限最高——单 Canvas 直绘、无 widget 开销——但文本测量、图片解码、点击命中全要手写，富媒体卡片（头像 + 图 + 多行文本 + 点赞按钮）成本陡增。Stack+Positioned 每条弹幕是真 widget，命中、文本、图片全部免费，配合双层 RepaintBoundary 和定向刷新，几十条同屏弹幕完全可行，适合"卡片即内容"的场景。列表（ListView）复用只适合底部滚动的静态弹幕列表，不适合自由飘动。选型判断标准是**内容复杂度 × 数量级**：百级简单文本选 Painter，十级富卡片选 Stack。该项目的卡片弹幕选 Stack 是正确的。

###  如何做轨道分配与碰撞检测？为什么可以只查每条轨道最后一条弹幕？

轨道分配按负载评分（活跃 ×2.0 + 等待 ×1.0 + 优先 ×1.5）取最低，保证多轨均衡；新弹幕先在"能立即入轨"的轨道里挑最低分，都不行进最低分轨道的等待队列。碰撞检测只查该轨道最后一条弹幕的右缘与新弹幕出生点（容器右缘）的间距——O(1)。这样做的正确性依赖一个不变量：**同轨同速**。同一轨道内所有弹幕速度相同，后出生者与先出生者的间距在飞行全程保持不变，运行期不可能追尾，唯一需要防的是出生瞬间与队尾重叠。一旦引入变速弹幕（按文本长度调速），不变量被打破，必须退回全队列检测或按"到达时间"预估。

###  Ticker 与 AnimationController 的区别？弹幕为什么选 Ticker？

AnimationController 是"一条受控动画"：值域 0→1、支持曲线、正向/反向、状态事件，本质是帮你插值的定时器。Ticker 是更原始的"每帧回调"：只给 elapsed 时间戳，没有值域、没有曲线、没有结束概念。弹幕是**无固定时长的连续仿真**——N 条弹幕各自有出生时间、各自按 `x = W - (now - start) * v` 推进、随时有新弹幕加入旧弹幕离场——没有"一条动画"可建模，只有"一个世界"要推进，所以选 Ticker 直接驱动仿真循环，每帧批量更新所有实体的位置。AnimationController 适合一次性、有起止的过渡（如卡片入场缩放），两者在弹幕系统里常常共存。

###  长连接消息如何支持多消费者分发？

三种模式：单播回调（一个槽位，后注册覆盖先注册——调试页劫持生产链路的根源）；`Map<Pattern, handler>` 注册表（支持多消费者但注册/注销时序仍靠约定）；broadcast Stream（发布方与消费方完全解耦，任意数量消费者，各自 filter 各自 cancel）。推荐 broadcast Stream 做主干：Dart 原生、取消语义清晰、天然支持"调试页只读 tap"。要点有二：消息对象保持"原始但已解码"（topic + UTF-8 字符串），业务解析放在各自消费者里，hub 永远不理解 payload；连接层可以有单播出口（构造期注入、一对一），但绝不能把可变单播槽位暴露给业务层——单播不是罪，"多消费者抢一个可变单播槽"才是。

###  MQTT 的 QoS 等级如何影响弹幕系统？离线消息补拉怎么设计？

QoS 0 至多一次（可能丢）、QoS 1 至少一次（可能重）、QoS 2 恰好一次（四次握手开销大）。弹幕是"看现在"的业务，单条丢失无感，所以推送选 QoS 1 即可——但必须对冲它的重复语义：消费端按业务 id 去重（LRU）。离线补拉的黄金设计是"**MQTT 管增量，REST 管对齐**"：重连/前台恢复时先清屏，再拉一次"最新一屏"接口对齐到当下，之后增量交给推送。绝不能用"加大的 QoS 2 + 持久会话"去模拟补拉——broker 为你积压的离线消息在重连瞬间一次性灌下来，就是一场自己制造的消息风暴。

###  自研动画组件如何在 GetX/Bloc 等状态管理框架下保持解耦？

规则是"引擎不认识框架，框架只当搬运工"。具体做法：引擎用 ChangeNotifier/ValueListenable 这类 Flutter 原生通知原语，不继承任何状态管理库的基类；输入用 `add(item)` 这类朴素方法，输出用 `ValueListenable<int> activeCount`；View 层用 `ListenableBuilder` 消费。这样引擎可以在任何状态管理方案下复用、可以脱离 UI 单测（注入 fake Ticker 或直接调 tick 处理函数）。反例就是该项目的引擎 extends GetxController——复用方被迫连 GetX 一起吃下去，而且 Ticker 的生命周期被绑到 GetX 的注册表上，埋下 vsync 陷阱（坑 1）。

###  遇到消息风暴（洪峰）有哪些治理手段？

分四层：入口限流（订阅端能退订就退订，保活 Tab 不可见时暂停消费）、去重（LRU seenIds，对冲 QoS 1 重复 + 补拉重叠）、合并（100ms 窗口攒批，把 N 次入队合成 1 次 flush）、丢弃策略（队列上限 + 超一屏截断 + 队头超时，核心原则是"观众看现在，不补历史课"；优先级上普通弹幕可丢、用户自己的弹幕不可丢）。最后是渲染端背压与可观测性：每帧每轨只处理队头，队列深度作为可观测指标暴露给调试面板（`activeCount` / 排队数），风暴发生时看得见、事后查得到。

## 参考资源

- Flutter `Ticker` 与 `SchedulerBinding` 文档：https://api.flutter.dev/flutter/scheduler/Ticker-class.html
- mqtt_client（MQTT v3.1.1 客户端，本文生产实现所用）：https://pub.dev/packages/mqtt_client
- Dart 官方 Stream 教程（含 broadcast 流语义）：https://dart.dev/libraries/async/using-streams
- ns_danmaku（B 站风格弹幕组件，可对照轨道实现）：https://pub.dev/packages/ns_danmaku
- canvas_danmaku（CustomPainter 直绘方案，对照渲染选型）：https://pub.dev/packages/canvas_danmaku
- Flutter `ChangeNotifier` 文档：https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html
- Flutter `ValueListenable` 文档：https://api.flutter.dev/flutter/foundation/ValueListenable-class.html
