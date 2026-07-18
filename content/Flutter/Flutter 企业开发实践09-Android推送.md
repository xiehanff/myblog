---
title: Flutter 企业开发实践09-Android推送
date: 2026-05-18
tags: [Flutter, 面试, 架构, 推送, 厂商通道, 透传消息, 离线推送]
---

# Android 推送

> 在国内 Android 生态里，推送不是"加个 SDK 就能用"的事，而是"不接厂商通道就等于没有推送"的生存问题。本篇从架构师视角拆解推送方案选型、厂商通道接入、消息类型设计和 Flutter 侧的封装策略。

---

## 概述：Android 推送解决什么问题？

推送是 App 与用户之间最重要的主动触达通道。但在国内 Android 环境下，由于 Google Play Services 不可用，FCM（Firebase Cloud Messaging）形同虚设，App 进程一旦被系统杀死，任何自建长连接都无法存活——**这意味着没有厂商通道支持的推送，离线到达率可能低于 30%。**

核心问题链：

1. 国内 Android 没有 FCM → 无法依赖统一推送
2. 国产 ROM 激进的后台清理策略 → 自建长连接随时断
3. 各厂商自建推送通道 → 必须逐一接入
4. 厂商通道 API 碎片化 → 需要聚合层统一管理

---

## 核心内容

### 1. 推送架构：厂商通道 vs 第三方聚合

#### 为什么必须接厂商通道？

[Android] 国产 ROM（华为 EMUI/HarmonyOS、小米 MIUI、OPPO ColorOS、vivo OriginOS、魅族 Flyme）都有自己的系统级推送服务。这些服务运行在系统进程中，不受应用保活影响，因此能做到：

- **进程被杀后仍可送达**：推送由系统服务接收，再唤起 App 或直接展示通知
- **省电省内存**：不需要 App 自行长连接，厂商推送服务统一管理长连接
- **到达率差异巨大**：

| 方案 | 在线到达率 | 离线到达率 | 说明 |
|------|-----------|-----------|------|
| 自建长连接（WebSocket/MQTT） | 90%+ | <30% | 进程被杀即失效 |
| 第三方聚合（极光/个推） | 90%+ | 50-70% | 依赖自建通道+厂商通道混合 |
| 厂商通道直连 | 95%+ | 90%+ | 系统级保障 |

**不接厂商通道会怎样？** 用户锁屏后 App 进程被杀，所有推送静默丢失，用户感知就是"这个 App 不给我推消息"。对社交/IM/交易类 App，这是致命的。

#### 第三方聚合的价值

极光（JPush）、个推、信鸽等第三方推送服务提供的核心价值是**统一接入层**：

```
┌──────────┐
│  你的服务端  │
└─────┬─────┘
      │ 统一 API
┌─────▼─────┐
│  聚合 SDK  │  ← 极光/个推
├─────┬─────┤
│ 华为 │ 小米 │ OPPO │ vivo │ 自建通道 │
└─────┴─────┘
```

**优势**：一次集成，自动路由到对应厂商通道
**代价**：多一层 SDK 依赖，厂商通道版本更新可能滞后，且聚合 SDK 自身有商业利益考量

#### 选型决策

| 场景 | 推荐方案 | 原因 |
|------|---------|------|
| 团队 <5 人，快速上线 | 第三方聚合 | 接入成本最低 |
| 社交/IM 类，推送是核心功能 | 厂商通道直连 + 自建长连接 | 到达率和时效性要求高 |
| 大型 App，多业务线 | 自建聚合服务端 + 厂商通道 | 完全可控，服务端统一路由 |

---

### 2. 华为/小米/OPPO/vivo 厂商通道接入要点

#### 共同流程

每个厂商通道接入都遵循以下步骤：

1. **注册开发者账号** → 创建应用 → 获取 AppID/AppKey/ClientSecret
2. **集成客户端 SDK** → 获取 PushToken → 上报服务端
3. **服务端对接推送 API** → 按 Token 或主题推送
4. **处理推送回调** → 通知展示 / 点击跳转

#### 各厂商差异对比

| 维度 | 华为 Push | 小米 Push | OPPO Push | vivo Push |
|------|----------|----------|----------|----------|
| 接入门槛 | 需华为开发者认证 | 个人即可 | 需软著审核 | 需软著审核 |
| SDK 体积 | ~1.5MB | ~800KB | ~600KB | ~700KB |
| 通知 vs 透传 | 都支持 | 都支持 | 仅通知栏消息 | 都支持 |
| 主题推送 | 支持 | 支持 | 不支持 | 支持 |
| 内测/审核 | 需申请审核 | 无需 | 需申请 | 需申请 |
| HarmonyOS 适配 | HMS Core Push | - | - | - |

#### 关键接入坑

**华为 HMS** [Android]
- 必须用 `agconnect-services.json` 配置文件，放错位置编译报错但报错信息不明确
- 华为手机需要安装 HMS Core（apk），部分老机型未预装，需引导安装
- Debug 签名和 Release 签名对应不同的 ClientSecret，切换环境容易遗漏
- 华为审核流程约 1-3 个工作日

**小米 Push** [Android]
- 支持透传消息，但 MIUI 12+ 对后台启动 Activity 有限制
- 小米的 `regId` 在卸载重装后会变化，服务端需更新
- 国际版小米手机不支持小米推送

**OPPO Push** [Android]
- **不支持透传消息**，只能发通知栏消息——这是最大的限制
- 接入需要 OPPO 开发者平台审核，审核需提供软著
- OPPO 的通知渠道必须提前创建，否则低优先级通知可能不显示

**vivo Push** [Android]
- 同样需要软著审核
- vivo 的 `regId` 长度不固定，数据库字段设计时注意不要写死长度
- 类名必须在 vivo 平台注册，否则点击通知无法跳转

---

### 3. 透传消息 vs 通知栏消息

这是理解推送架构的关键分叉点。

#### 通知栏消息（Notification Message）

```
服务端 → 厂商推送服务 → 系统直接展示通知 → 用户点击 → 唤起 App
```

- **系统直接展示通知**，App 不需要运行
- 消息体固定格式：`title` + `content` + `clickAction`
- **App 进程可能未启动**，点击后才唤起
- 适合：运营推送、公告、活动通知

#### 透传消息（Data Message / Silent Message）

```
服务端 → 厂商推送服务 → App 接收数据 → App 自行决定是否展示通知
```

- App 必须有活跃进程（或厂商 SDK 的 Receiver）才能接收
- 消息体自定义，App 完全控制展示逻辑
- 可以做：前端数据处理、静默同步、自定义通知样式、IM 消息聚合
- **OPPO 不支持透传**，是方案设计的主要障碍

#### 架构决策：如何选？

| 需求 | 选择 | 原因 |
|------|------|------|
| 纯运营推送，到达率优先 | 通知栏消息 | 离线也能送达 |
| IM 消息，需要前端处理后再展示 | 透传消息 | 需要前端聚合、去重、自定义 UI |
| 两者都有 | 混合方案 | 透传优先，离线 fallback 到通知栏 |

**混合方案设计**：

```
App 在线 → 透传消息 → 前端处理 → 自定义通知
App 离线 → 通知栏消息 → 用户点击 → 进入对应页面
```

服务端需要感知 App 在线状态：在线时发透传，离线时发通知栏。这是 IM 类 App 的标准做法。

---

### 4. 离线推送与点击跳转

#### 离线推送的流程

[Android] 离线推送的完整链路：

```
1. App 运行时获取 PushToken，上报服务端
2. App 进程被杀
3. 服务端检测到 App 离线（WebSocket 断开 / 心跳超时）
4. 服务端改走厂商通道发送通知栏消息
5. 厂商系统服务接收消息，展示通知
6. 用户点击通知 → 系统拉起 App（通过 Intent）
7. App 在启动路径中解析 Intent，跳转到目标页面
```

#### 点击跳转的实现

点击通知唤起 App 时，需要在入口处统一解析路由参数：

```dart
// Android 端 MainActivity.kt 处理 Intent
override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val uri = intent.data?.toString()
    if (uri != null) {
        // 通过 MethodChannel 传递给 Flutter
        pushChannel.invokeMethod("onNotificationClick", uri)
    }
}
```

```dart
// Flutter 侧路由分发
class PushRouter {
  static final _pendingRoutes = <String>[];

  /// 初始化时注册 MethodChannel 回调
  static void init() {
    const channel = MethodChannel('push_router');
    channel.setMethodCallHandler((call) async {
      if (call.method == 'onNotificationClick') {
        _navigateTo(call.arguments as String);
      }
    });
  }

  /// 处理路由跳转
  static void _navigateTo(String uri) {
    // 解析 URI，跳转到对应页面
    // 例如: myapp://order/detail?id=123
    final parsed = Uri.parse(uri);
    switch (parsed.host) {
      case 'order':
        Get.toNamed('/order/detail', parameters: {'id': parsed.queryParameters['id']!});
      case 'chat':
        Get.toNamed('/chat', parameters: {'conversationId': parsed.queryParameters['cid']!});
      default:
        Get.toNamed('/home');
    }
  }
}
```

#### 关键坑：冷启动 vs 热启动

- **冷启动**（App 未运行）：通知点击 Intent 在 `MainActivity.onCreate` 中获取
- **热启动**（App 在后台）：通知点击 Intent 在 `MainActivity.onNewIntent` 中获取
- 必须两处都处理，否则热启动时点击通知无反应
- Flutter 侧可能在 `initState` 之前就收到路由参数，需要缓存待消费的路由

---

### 5. 推送到达率统计与优化

#### 为什么到达率统计这么难？

推送链路长、环节多，每一层都可能丢消息：

```
服务端发送 → 聚合平台 → 厂商推送服务 → 系统通知展示 → 用户看到
     ↓            ↓             ↓              ↓
   超时/限流    路由失败     Token失效/限频   通知折叠/静默
```

每一层的"到达"定义不同：
- **服务端到达率**：聚合平台返回成功 / 厂商 API 返回成功 → 99%+
- **设备到达率**：设备 SDK 收到回调 → 70-90%（取决于厂商通道）
- **展示到达率**：通知实际展示在通知栏 → 受通知折叠、静默时段影响
- **用户感知到达率**：用户实际看到通知 → 无法精确统计

#### 统计方案设计

```dart
/// 推送事件上报模型
class PushEvent {
  final String messageId;
  final PushEventStage stage;
  final DateTime timestamp;
  final String? channel; // huawei, xiaomi, oppo, vivo, custom
  final String? error;

  PushEvent({
    required this.messageId,
    required this.stage,
    required this.timestamp,
    this.channel,
    this.error,
  });
}

/// 事件阶段
enum PushEventStage {
  serverSent,      // 服务端已发送
  deviceReceived,  // 设备收到
  notificationShown, // 通知已展示
  userClicked,     // 用户点击
}
```

**关键指标**：

| 指标 | 计算方式 | 目标值 |
|------|---------|--------|
| 到达率 | deviceReceived / serverSent | >85% |
| 展示率 | notificationShown / deviceReceived | >90% |
| 点击率 | userClicked / notificationShown | 业务相关 |
| 端到端到达率 | notificationShown / serverSent | >75% |

#### 优化手段

1. **Token 管理**：每次启动刷新 PushToken 并上报，Token 过期是到达率下降的首要原因
2. **通知渠道优化** [Android]：创建高优先级通知渠道，避免被系统折叠
3. **厂商通道降级**：厂商通道失败时 fallback 到自建通道（在线场景）
4. **推送频率控制**：避免厂商限频导致批量丢弃
5. **消息合并**：短时间内多条推送合并为一条，避免通知栏被折叠

---

### 6. Flutter 侧插件封装设计

#### 设计原则

Flutter 侧推送封装的核心目标是**屏蔽底层差异**，让业务层不关心当前走的是哪个厂商通道：

```dart
/// 推送抽象层
abstract class PushService {
  /// 初始化（内部自动识别厂商并初始化对应通道）
  Future<void> init();

  /// 获取当前 PushToken
  Future<String?> getToken();

  /// 注册消息回调
  void onMessageReceived(PushMessageCallback callback);

  /// 注册通知点击回调
  void onNotificationClick(NotificationClickCallback callback);

  /// 设置别名/标签（用于定向推送）
  Future<void> setAlias(String alias);
  Future<void> setTags(List<String> tags);
}

typedef PushMessageCallback = void Function(PushMessage message);
typedef NotificationClickCallback = void Function(String uri);

class PushMessage {
  final String messageId;
  final String title;
  final String body;
  final Map<String, String> data;
  final bool isNotification; // true=通知栏消息, false=透传消息

  PushMessage({
    required this.messageId,
    required this.title,
    required this.body,
    required this.data,
    required this.isNotification,
  });
}
```

#### 插件架构

```
┌─────────────────────────────────┐
│        Flutter 业务层            │
│    PushService (抽象接口)         │
├─────────────────────────────────┤
│      push_plugin (Dart 侧)       │
│    MethodChannel 通信            │
├─────────────────────────────────┤
│      push_plugin (Android 侧)    │
│  ┌──────┬──────┬──────┬──────┐  │
│  │华为  │ 小米 │ OPPO │ vivo │  │
│  │Push  │Push  │Push  │Push  │  │
│  └──────┴──────┴──────┴──────┘  │
│     统一回调 → MethodChannel     │
└─────────────────────────────────┘
```

#### Android 侧实现要点

```kotlin
// push_plugin Android 端核心逻辑
class PushPlugin : FlutterPlugin, MethodCallHandler {
    private var pushDelegate: PushDelegate? = null

    override fun onAttachedToEngine(binding: FlutterPluginBinding) {
        // 1. 检测厂商
        val manufacturer = Build.MANUFACTURER.lowercase()
        pushDelegate = when {
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> HuaweiPushDelegate()
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") -> XiaomiPushDelegate()
            manufacturer.contains("oppo") -> OppoPushDelegate()
            manufacturer.contains("vivo") -> VivoPushDelegate()
            else -> DefaultPushDelegate() // fallback
        }

        // 2. 初始化对应 SDK
        pushDelegate?.init(binding.applicationContext)
    }

    override fun onMethodCall(call: MethodCall, result: Result) {
        when (call.method) {
            "init" -> pushDelegate?.init(/* ... */)
            "getToken" -> pushDelegate?.getToken { result.success(it) }
            "setAlias" -> pushDelegate?.setAlias(call.arguments as String) { result.success(null) }
            else -> result.notImplemented()
        }
    }
}
```

#### 不这么做会怎样？

如果不封装抽象层，每个业务模块直接调用厂商 SDK，后果是：
- 切换推送方案时需要改所有业务代码
- 不同厂商的消息回调格式不统一，业务层满屏 if-else
- 无法做统一的到达率统计和事件上报

---

## 常见坑与踩点

### 坑1：PushToken 时机问题

PushToken 的获取是异步的，且可能因为网络原因延迟返回。常见错误是在 `main()` 中同步获取 Token 并上报——必须在回调中处理：

```dart
PushService.instance.init();
PushService.instance.onTokenRefresh((token) {
  // 这里上报，不要在 init() 后同步 getToken
  api.reportPushToken(token);
});
```

### 坑2：华为 HMS Core 未安装

[Android] 部分老款华为手机未预装 HMS Core，调用 Push API 会静默失败。必须检测 HMS Core 可用性：

```kotlin
if (HuaweiApiAvailability.getInstance().isHuaweiMobileServicesAvailable(context) == ConnectionResult.SUCCESS) {
    // 初始化华为推送
} else {
    // fallback 到其他通道
}
```

### 坑3：OPPO 不支持透传

设计推送方案时必须把 OPPO 不支持透传纳入考量。IM 类 App 的做法：OPPO 设备上走通知栏消息 + 离线消息拉取（用户点击后 App 拉取历史消息补齐）。

### 坑4：通知渠道未创建

[Android] Android 8.0+ 必须创建通知渠道才能展示通知。厂商 SDK 通常会自动创建默认渠道，但如果你要自定义渠道（如静音渠道、高优先级渠道），必须在推送之前创建：

```kotlin
val channel = NotificationChannel(
    "high_priority",
    "重要通知",
    NotificationManager.IMPORTANCE_HIGH
)
notificationManager.createNotificationChannel(channel)
```

### 坑5：多进程回调

[Android] 厂商 SDK 的推送回调可能在独立进程中触发，而 Flutter Engine 运行在主进程。如果回调在非主进程触发，MethodChannel 通信会失败。解决方案是在非主进程中通过 `ContentProvider` 或 `BroadcastReceiver` 转发到主进程。

---

## 面试追问

###  为什么国内 Android 必须接厂商通道？

因为国内没有 Google Play Services，FCM 不可用。App 进程被系统杀死后，自建长连接断开，无法接收推送。厂商通道运行在系统进程中，不受 App 进程生命周期影响，离线到达率从 <30% 提升到 90%+。

###  透传消息和通知栏消息有什么区别？

透传消息由 App 接收并自行处理（可展示通知、可静默处理），灵活但要求 App 有活跃进程；通知栏消息由系统直接展示通知，App 不需要运行，但无法自定义展示逻辑。OPPO 不支持透传是关键差异。

###  如何设计推送的消息路由？用户点击通知后怎么跳转到对应页面？

定义统一 URI Scheme（如 `myapp://order/detail?id=123`），在通知的 clickAction 中携带该 URI。Android 端在 `onNewIntent` 和 `onCreate` 中解析 Intent，通过 MethodChannel 传给 Flutter 侧，Flutter 侧统一路由分发。需要处理冷启动和热启动两种场景，且 Flutter 侧可能还未初始化完成，需要缓存待消费的路由。

###  推送到达率怎么统计？各环节的到达率差异是什么？

推送链路每层都可能丢消息，需要分阶段上报事件：服务端发送 → 设备收到 → 通知展示 → 用户点击。关键难点是"通知展示"这一环无法精确统计（系统不会通知 App 通知是否展示），通常用"设备收到"近似。Token 过期、厂商限频、通知折叠是到达率下降的三大原因。

###  如果让你从零设计一个推送架构，支持多厂商通道且可扩展，你会怎么设计？

1. **服务端**：统一推送 API 层 → 路由层（根据设备 Token 前缀或厂商标识分发到对应厂商通道）→ 厂商适配器层（每个厂商一个适配器实现统一接口）
2. **客户端**：Flutter 侧定义 PushService 抽象接口 → Android 侧根据 Build.MANUFACTURER 自动选择 PushDelegate → 每个 PushDelegate 封装一个厂商 SDK
3. **消息类型**：统一消息模型，包含 isNotification 字段，服务端根据 App 在线状态决定发透传还是通知栏
4. **可扩展性**：新增厂商只需新增适配器/Delegate，不改路由逻辑和业务代码
5. **可观测性**：每个环节打点上报，构建端到端到达率漏斗

---

## 参考资源

- [华为推送服务开发指南](https://developer.huawei.com/consumer/cn/hms/huawei-pushkit/)
- [小米推送服务文档](https://dev.mi.com/console/doc/detail?pId=230)
- [OPPO 推送服务](https://push.oppo.com/)
- [vivo 推送服务](https://dev.vivo.com.cn/documentCenter/doc/366)
- [极光推送 Flutter 插件](https://docs.jiguang.cn/jpush/client/Flutter/Flutter_plugin/)
- Android Notification Channels 官方文档
