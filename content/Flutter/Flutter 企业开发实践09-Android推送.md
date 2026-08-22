---
title: Flutter 企业开发实践09-Android推送
date: 2026-05-18
tags: [Flutter, 面试, 架构, 推送, 厂商通道, 透传消息, 离线推送, JPush, 极光]
---

# Android 推送

> 在国内 Android 生态里，推送从来不是"加个 SDK 就能用"的事。厂商通道常被当作救命稻草，但它到底是不是必选项？本篇从架构师视角拆解推送选型决策、厂商通道接入、消息类型设计、通知点击路由和 Flutter 侧封装策略，并结合某已上线半年的 Flutter 混合开发项目的真实取舍——Android 只走极光长连接、不接任何厂商通道——给出"要不要厂商通道"的决策框架。

---

## 概述：Android 推送解决什么问题？

推送是 App 与用户之间最重要的主动触达通道。但在国内 Android 环境下，由于 Google Play Services 不可用，FCM（Firebase Cloud Messaging）形同虚设，App 进程一旦被系统杀死，任何自建长连接都无法存活——**这意味着没有厂商通道支持的推送，离线到达率可能低于 30%。**

核心问题链：

1. 国内 Android 没有 FCM → 无法依赖统一推送
2. 国产 ROM 激进的后台清理策略 → 自建长连接随时断
3. 各厂商自建推送通道 → 离线到达率最优解，但接入/维护成本高，需要权衡
4. 厂商通道 API 碎片化 → 需要聚合层统一管理
5. 工信部与应用商店合规要求 → 推送 SDK 必须在用户同意隐私政策后才能初始化

---

## 核心内容

### 1. 推送架构：厂商通道 vs 第三方聚合

#### 厂商通道解决什么问题？

[Android] 国产 ROM（华为 EMUI/HarmonyOS、小米 MIUI、OPPO ColorOS、vivo OriginOS、魅族 Flyme）都有自己的系统级推送服务。这些服务运行在系统进程中，不受应用保活影响，因此能做到：

- **进程被杀后仍可送达**：推送由系统服务接收，再唤起 App 或直接展示通知
- **省电省内存**：不需要 App 自行长连接，厂商推送服务统一管理长连接
- **到达率差异巨大**：

| 方案 | 在线到达率 | 离线到达率 | 说明 |
|------|-----------|-----------|------|
| 自建长连接（WebSocket/MQTT） | 90%+ | <30% | 进程被杀即失效 |
| 第三方聚合（极光/个推） | 90%+ | 50-70% | 依赖自建通道+厂商通道混合 |
| 厂商通道直连 | 95%+ | 90%+ | 系统级保障 |

**不接厂商通道的代价是什么？** 用户锁屏后 App 进程被杀，自建长连接断开，消息只能依赖聚合服务商的自有通道与系统兜底手段，离线到达率显著下降。对社交/IM/交易类 App，这可能是致命的；但对运营促活类 App，它可能只是一个可接受的折中——"要不要厂商通道"本质上是一道成本/收益题，而不是必选题。

#### 真实案例：一个上线半年的项目为什么"敢"不接厂商通道

某已上线半年的 Flutter 混合开发项目，Android 端只集成了极光 JPush（jpush_flutter 3.3.9，iOS 侧 Pods 为 JPush 5.9.0 + JCore 5.4.0），**没有接入任何厂商通道**，全量消息走极光自有长连接。这不是偷懒，而是一次显式的技术取舍：

| 权衡维度 | 分析 |
|---------|------|
| 集成成本 | 华为/小米/OPPO/vivo 各需注册开发者账号、创建应用、配置签名指纹；OPPO/vivo 还要软著审核；聚合 SDK 里逐家打开开关并逐一回归，首次接入至少 1-2 周 |
| 维护成本 | 厂商 SDK 迭代频繁，插件升级、后台配置（如华为 agconnect-services.json）年度更新、审核流程重走，都是长期"税" |
| 到达率收益 | 厂商通道主要提升**离线到达率**。该项目是内容运营型 App 而非 IM，推送以每日低频促活为主，没有"秒级必达"的消息；在线时长与推送频率决定了长连接在线时段已覆盖大部分推送窗口 |
| 双端一致性 | iOS 本就只能走 APNs，没有任何"厂商通道"可接；统一用极光意味着一套后台、一份报表、一套服务端 API |

结论：**用离线到达率的损失，换取零厂商维护成本**。该方案上线半年运行稳定；若后续推送演进为 IM/交易类核心链路，厂商通道可以在聚合 SDK 内增量打开——这正是选择聚合层作为底座的演进红利。

#### 决策框架：要不要接厂商通道？

把"要不要厂商通道"做成一个可复用的决策框架，而不是默认必选：

1. **推送的业务权重**：IM/交易/告警类（消息即业务）→ 必接；运营促活类（晚到无感知）→ 可缓接甚至不接
2. **离线到达率容忍度**：能接受 50-70% 的离线到达率 → 聚合通道即可；要求 90%+ → 必须厂商通道
3. **团队人力与工期**：小团队、首版工期紧 → 先聚合通道上线，厂商通道作为二期
4. **资质门槛**：没有软著/企业开发者账号 → OPPO/vivo 直接被卡，只能走聚合通道
5. **可演进性**：选聚合 SDK（极光/个推）时确认其支持后续增量打开厂商通道，保留演进空间

> 反过来也要清醒：厂商通道解决的是"进程被杀后的送达"，它救不了糟糕的推送内容与过高的推送频率。先想清楚推什么、推给谁，再决定用什么通道。

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
| 社交/IM/交易类，推送是核心功能 | 厂商通道直连（或聚合+全量厂商通道） | 到达率和时效性要求高 |
| 运营促活类 App，团队小、工期紧 | 聚合通道先行，不接厂商通道 | 离线到达率损失可接受，零厂商维护成本（真实项目采用） |
| 团队 <5 人，快速上线 | 第三方聚合 | 接入成本最低 |
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

#### 点击跳转的实现：extras 协议解析 + type 分发 + 混合栈范式

以下是某已上线半年的 Flutter 混合开发项目的真实方案（极光 jpush_flutter + flutter_boost 混合栈）。通知的业务参数由服务端写入 extras，客户端点击回调后统一解析为 `PushModel`：

```dart
/// 通知 extras 中的业务协议模型（服务端与客户端共同维护的跳转协议）
class PushModel {
  String? type;      // 跳转类型编号：1/3/8 切 tab、2 直播 H5、4~14 各业务页、99 任意 H5
  String? momentId;  // type=11 时：内容详情 id
  String? orderType; // type=12 时：订单频道
  String? jumpUrl;   // type=99 时：任意 H5 落地页地址

  factory PushModel.fromJson(Map<dynamic, dynamic> json) => PushModel(
      type: json["type"], jumpUrl: json["jumpUrl"],
      momentId: json['momentId'], orderType: json['orderType']);
  PushModel({this.type, this.momentId, this.orderType, this.jumpUrl});
}
```

**第一步：解析 extras（Android 与 iOS 数据结构不同）**

[Android] 极光把通知附加字段放在 `extras['cn.jpush.android.EXTRA']`，且**可能是 JSON 字符串而不是 Map**（取决于下发方式）；[iOS] 点击回调直接携带 userInfo，根节点就是业务字段：

```dart
static void _handlerPushMsg(Map<String, dynamic> message) async {
  // 守卫 1：未登录不跳——避免把用户"闪送"到登录页背后的业务页
  if (User.isLogin == false) return;

  // 守卫 2：登录/引导流程中不跳（登录页/验证码/注册/忘记密码/引导容器）
  final topName = BoostNavigator.instance.getTopPageInfo()?.pageName ?? '';
  const loginFlow = [RouteConfigKey.baseMain, RouteConfigKey.loginPage,
    RouteConfigKey.loginCode, RouteConfigKey.forterPassword, RouteConfigKey.registration];
  if (loginFlow.contains(topName)) return;

  // extras 解析：双端结构差异在这里消化
  try {
    dynamic extra;
    if (Platform.isAndroid) {
      final extras = message['extras'];
      if (extras is! Map) return;
      extra = extras['cn.jpush.android.EXTRA'];
      if (extra is String) extra = jsonDecode(extra);
    } else {
      extra = message; // iOS：根节点即业务字段
    }
    if (extra is! Map) return;
    pushModel = PushModel.fromJson(extra);
  } on FormatException {
    PushMonitor.reportInvalidPayload(message); // 非法 JSON 拒绝执行并上报
    return;
  }

  // 混合栈跳转范式：先回到主页容器，再 push 目标页
  if (topName != RouteConfigKey.baseTabBar) {
    BoostNavigator.instance.popUntil(route: RouteConfigKey.baseTabBar);
    await Future.delayed(const Duration(milliseconds: 200)); // 等 pop 动画收尾
  }
  jumpTo();
}
```

**第二步：type → 页面分发表**

`jumpTo` 用一个 switch 集中管理所有跳转目标，运营侧只需在后台配 type 编号：

```dart
static void jumpTo() async {
  if (pushModel == null) return;
  if (User.isLogin == false) return;

  final pushType = pushModel?.type ?? '';
  switch (pushType) {
    case "1":
    case "3":
    case "8":
      // 运营位类：只切 tab，不新开页面
      BaseTabBarController.to?.goToByTitle("探索");
      break;
    case "2":
      // 直播开播提醒：跳 H5 直播页
      BoostNavigator.instance.push(RouteConfigKey.uniWebView, arguments: {"url": "${HttpDefine.h5BaseUrl}/open-live"});
      break;
    case "4":
    case "5":
    case "6":
    case "7":
    case "9":
    case "10":
    case "14":
      // 各类业务详情页（粉丝中心/收益明细/提现明细/会员中心/消息中心/虚拟物品记录…）
      BoostNavigator.instance.push(_routeForType(pushType));
      break;
    case "11":
      // 内容被评论：先按 momentId 拉详情（目标可能已删除），成功后再跳
      final res = await ApiClientExt.requestAction(/* getMomentDetail */);
      if (res.isFailed || res.data == null) { pushModel = null; return; }
      BoostNavigator.instance.push(RouteConfigKey.momentsDetail, arguments: {"data": res.data});
      break;
    case "12":
      // 订单同步：按 orderType 跳对应频道的订单页
      if (pushModel?.orderType == "1") {
        BoostNavigator.instance.push(RouteConfigKey.orderPageA);
      } else if (pushModel?.orderType == "2") {
        BoostNavigator.instance.push(RouteConfigKey.orderPageB);
      }
      break;
    case "99":
      // H5 落地页也是外部输入：仅允许 HTTPS + 可信域名
      final uri = _trustedCampaignUri(pushModel?.jumpUrl);
      if (uri == null) {
        PushMonitor.reportRejectedUrl(pushModel?.jumpUrl);
        pushModel = null;
        return;
      }
      BoostNavigator.instance.push(
          RouteConfigKey.uniWebView, arguments: {"url": uri.toString()});
      break;
  }
  pushModel = null; // 一次性消费，防止重复触发
}

Uri? _trustedCampaignUri(String? raw) {
  final uri = Uri.tryParse(raw ?? '');
  const allowedHosts = {'www.example.com', 'campaign.example.com'};
  if (uri == null || uri.scheme != 'https' || !allowedHosts.contains(uri.host)) {
    return null;
  }
  return uri;
}
```

这套分发设计的要点：

| 设计点 | 动机 |
|--------|------|
| type 编号而非 URI Scheme | 运营后台配置简单，客户端 switch 集中可控；H5 只接收 HTTPS + 域名白名单；消费后置空防重复触发 |
| 守卫条件（未登录/登录流程不跳） | 推送可能落在任何栈状态上，不守卫就会出现"登录页上叠业务页"的怪异栈 |
| popUntil 主页再 push | flutter_boost 混合栈下保证返回键语义正确，从目标页返回一定回到主页而不是随机页面 |

#### 关键坑：冷启动 vs 热启动

- **冷启动**（App 未运行）：通知点击数据在启动参数里（[iOS] launchOptions、[Android] 启动 Intent），此时 Flutter 的 `addEventHandler` 还没注册，回调收不到
- **热启动**（App 在后台）：通知点击走 `onOpenNotification` 回调，正常消费；必须两条链路都处理，否则冷启动点通知"没反应"，而测试时往往只测热启动
- 真实项目的做法：在推送初始化末尾主动调用 `_getLaunchData()`，通过自建 MethodChannel 从原生拉取启动参数（[Android] 解析 `JMessageExtra → n_extras`，[iOS] 解析 `UIApplicationLaunchOptionsRemoteNotificationKey`），解析出的 PushModel 与热启动共用同一个 jumpTo 分发——冷热启动行为完全一致（双端实现详见 10-iOS推送篇第 6 节）

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

### 6. Flutter 侧插件封装：以 JPushManager 为例

封装的核心目标是**屏蔽底层差异**，让业务层不关心当前走的是哪个通道。但真实项目里，"抽象"未必意味着先写一套 PushService 接口再写实现——某已上线半年的 Flutter 混合开发项目以极光官方插件 jpush_flutter（3.3.9）为基础，直接封装了一个两百多行的 JPushManager 单例，把**初始化、权限、回调流、registrationId 上报、点击路由分发**五件事收敛到一个文件：业务层只认识 JPushManager，未来若更换推送服务商，改造面也收敛在这一处（跨平台抽象接口的完整讨论见 10-iOS推送篇第 5 节）。

#### setup：appKey 由 Dart 传入，原生零配置

jpush_flutter 支持在 Dart 侧 `setup` 时直接传 appKey，原生工程不需要再改 manifest/plist——第三方参数集中在一个配置类里维护，避免双端配置漂移：

```dart
/// 第三方参数集中配置（真实值在工程中维护，此处为占位）
class ThirdPartyConfig {
  static const jPushAppKey = "jpushAppKey";
}

class JPushManager {
  static late JPushFlutterInterface jPush;

  static Future<bool> setupJPush() async {
    try {
      jPush = JPush.newJPush();
      jPush.setup(
        appKey: ThirdPartyConfig.jPushAppKey,
        channel: "developer-default",
        production: true, // iOS：走生产环境，必须与打包环境一致
        debug: false,
      );
      // 权限申请、回调注册、registrationId 获取见下文
      return true;
    } catch (e) {
      return false; // 初始化失败吞异常打日志，不能带崩主流程
    }
  }
}
```

appKey 有两种配置模式：**Dart 动态传入**（真实项目采用，配置集中在 ThirdPartyConfig 一处，便于多环境/多渠道包切换，原生工程零推送配置）与**原生硬编码**（AndroidManifest meta-data / Info.plist，不依赖 Flutter 初始化时序，但双端两份配置易漂移）。工程里务必只选一种，混用的坑见坑8。

#### 权限申请：iOS applyPushAuthority / Android 13+ 动态权限

[双端] setup 之后紧接着处理通知权限，双端手段不同：

```dart
if (Platform.isIOS) {
  // iOS：由插件代理申请通知权限（alert/sound/badge）
  jPush.applyPushAuthority(
      const NotificationSettingsIOS(sound: true, alert: true, badge: true));
} else {
  // Android 13+：POST_NOTIFICATIONS 变为运行时权限，用 permission_handler 申请
  final status = await Permission.notification.status; // 先查再弹
  Permission.notification.request().then((s) {/* 记录状态，用于引导与归因 */});
}
```

#### addEventHandler：一条回调流覆盖五类事件

```dart
jPush.addEventHandler(
  // 前台收到通知：一般只做日志/统计，前台展示策略可在此扩展
  onReceiveNotification: (message) async {},
  // 用户点击通知：前台/后台/热启动都走这里（冷启动除外，见第 4 节）
  onOpenNotification: (Map<String, dynamic> message) async {
    jPush.setBadge(0);          // 点击即清角标
    _handlerPushMsg(message);   // 进入统一路由分发
  },
  // 收到自定义透传消息
  onReceiveMessage: (message) async {},
  // 应用内消息（运营 in-app 弹窗）点击
  onInAppMessageClick: (message) async {},
  // iOS deviceToken 回调：持久化，随 registrationId 一起上报服务端
  onReceiveDeviceToken: (Map<dynamic, dynamic> tokenData) async {
    GetStorage().write('deviceToken', tokenData['deviceToken']);
  },
);
jPush.setBadge(0); // 每次初始化兜底清一次角标
```

#### registrationId：获取 → 持久化 → 两次上报的时机设计

registrationId 是极光的设备标识（服务端按它定向推送）。它的获取**异步且可能延迟**，上报又依赖**登录态**——两个不同步的条件构成时机设计的核心矛盾。真实项目的解法是"取到就存，能报就报，登录再补"：

```dart
jPush.getRegistrationID().then((value) async {
  // 1. 先持久化：与登录态解耦，任何时候拿到都先落盘
  await GetStorage().write('registrationId', value);
  // 2. 尝试上报：已登录才报，未登录静默跳过
  AppGlobal.upRegisterId();
});
```

```dart
extension AppGlobalTool on AppGlobal {
  /// 上报 registrationId（未登录/未拿到都不报）
  static void upRegisterId() async {
    if (User.isLogin == false) return;
    final registerId = GetStorage().read<String?>('registrationId');
    if (registerId == null) return;
    final dataMap = {"registerId": registerId};
    final deviceToken = GetStorage().read<String?>('deviceToken');
    if (deviceToken?.isNotEmpty == true) dataMap[Platform.isIOS ? 'iosToken' : 'androidToken'] = deviceToken;
    await ApiClientExt.requestAction(ApiPaths.registerIdSave, data: dataMap);
  }
}

class AppGlobal {
  /// 登录成功回调：登录态就绪，补报一次
  static void loginSuccess() async {
    AppGlobalTool.upDeviceInfo();
    AppGlobalTool.upRegisterId(); // 关键：登录后再报一次
  }
}
```

三个上报时机各司其职：

| 时机 | 动作 | 原因 |
|------|------|------|
| setup 完成后 | getRegistrationID → 持久化 + 尝试上报 | registrationId 异步到达且首启可能为空，必须落盘而不是只放内存 |
| 登录成功回调 | 再上报一次 | 上报接口需要登录态；用户可能"先启动后登录"，冷启动那次报不上 |
| 每次冷启动 | 重取 + 再报 | 卸载重装/换设备会换 id，每次启动刷新是通用最佳实践 |

#### 封装的整体结构

业务层只认识 JPushManager；它内部收敛六大职责：setupJPush（初始化+权限）、addEventHandler（回调流）、registrationId（持久化+补报）、_handlerPushMsg（守卫与解析）、jumpTo（分发表）、_getLaunchData（冷启动补偿）；再往下是 jpush_flutter 3.3.9 桥接层与原生 SDK（[iOS] JPush 5.9.0 + JCore 5.4.0 底层走 APNs；[Android] 极光长连接，未接厂商通道）。

#### 不这么做会怎样？

如果不做统一封装，让各业务模块直接对接推送 SDK / 厂商通道，后果是：
- 切换推送方案时需要改所有业务代码（真实项目把极光收敛在一个 JPushManager 里，就是给未来的替换留后门）
- 通知回调格式不统一（Android 的 extras 嵌套 vs iOS 的 userInfo），业务层满屏 if-else 和平台判断
- registrationId 的上报时机散落在各处，服务端永远拿不到全量设备标识
- 无法做统一的点击统计与冷启动补偿

---

### 7. 隐私合规：推送 SDK 必须延迟初始化

#### 为什么不能在 main() 里初始化推送？

工信部《App 违法违规收集使用个人信息行为认定方法》与各大应用商店审核要求：**App 必须在用户同意隐私政策后，才能初始化会采集设备信息的第三方 SDK**。推送 SDK 初始化时会读取设备标识并注册长连接，属于典型的"采集个人信息"行为；在 `main()` 或 Application.onCreate 里直接 setup，是上架被拒/被通报的高频原因。

#### 真实项目的延迟初始化链路

某已上线半年的 Flutter 混合开发项目先等待用户明确同意隐私协议，再获取版本配置并初始化推送。关键门禁是 `privacyConsent == true`；首帧、审核状态或远程开关都不能代替用户同意：

```
main() → runApp() → 首页容器读取本地 privacyConsent
  → 未同意：展示隐私协议 → 用户拒绝：不初始化任何三方 SDK
                         └→ 用户同意：持久化 consent 版本与时间
  → 获取版本/渠道配置（失败不影响 consent 判断）
  → MethodChannel 同步 consent 给原生宿主
  → consent == true → initAllSDK() → JPushManager.setupJPush()
  → 开屏加载 / 进入主流程
```

这样做的三重收益：

1. **合规可举证**：同意记录包含协议版本、时间和渠道，且 SDK 初始化在代码上受 consent 状态显式守卫
2. **首屏不被拖累**：setup 含网络注册与权限弹窗，放在首帧前会直接拖慢冷启动
3. **双端一致**：Flutter 与原生宿主共享同一份 consent 状态，任一端都不能抢跑初始化

代价也必须心里有数：初始化越晚，registrationId 到得越晚，冷启动点击推送的补偿链路就越要自己做（见第 4 节与 10-iOS推送篇第 6 节）——**合规延迟初始化与冷启动补偿是一对必须一起设计的孪生问题**。

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

### 坑6：registrationID 获取过早拿到空值

[Android] registrationId 是极光服务端在长连接注册成功后下发的，**异步且可能延迟**。setup 后立即同步取，首次集成或弱网时经常拿到空字符串。正确姿势：

- `getRegistrationID()` 在 setup 完成后异步调用，结果**持久化**（如 GetStorage）而不是只在内存里用；拿到空值不重试风暴，等下次启动自然刷新，登录成功后再补报（真实项目"setup 后取一次 + 登录成功补报一次"的双保险）
- 不要拿 registrationId 当业务唯一标识用，它只服务于推送

### 坑7：多进程 App 的 SDK 重复初始化

[Android] 如果 App 配置了多进程（`:push`、`:remote` 等），`Application.onCreate` 会在每个进程各执行一次。推送 SDK 在非主进程重复初始化，轻则浪费资源，重则回调错乱、通知点击路由失效。必须在 Application 中区分进程：

```kotlin
override fun onCreate() {
    super.onCreate()
    // 只有主进程才初始化推送/统计等 SDK
    if (packageName == Application.getProcessName()) initPushSDK()
}
```

使用 jpush_flutter + 混合栈时尤其注意：Flutter Engine 只存在于主进程，非主进程里触发 MethodChannel 必然失败。

### 坑8：appKey 两种配置模式混用

[Android] 极光支持两种 appKey 配置：① Dart 侧 setup 动态传入；② AndroidManifest meta-data 硬编码。两者同时存在时**动态传入优先**。常见翻车现场：排查问题时改了 manifest 里的 appKey 却不生效；或 Android manifest 与 iOS plist 各配各的，双端漂移。建议全工程只保留一种——真实项目选择 Dart 传入并集中到 ThirdPartyConfig，原生工程零推送配置。

```xml
<!-- 模式②：manifest 硬编码（与 Dart 动态传入二选一，不要并存） -->
<meta-data android:name="JPUSH_APPKEY" android:value="jpushAppKey" />
```

---

## 面试追问

###  为什么国内 Android 推送绕不开"厂商通道"这个话题？

因为国内没有 Google Play Services，FCM 不可用。App 进程被系统杀死后，自建长连接断开，离线推送基本失效。厂商通道运行在系统进程中，不受 App 进程生命周期影响，离线到达率能从 <30% 提升到 90%+。但"绕不开这个话题"不等于"必须接入"——它是一道成本/收益题：IM/交易类必接，运营促活类可以权衡（见下一问）。

###  厂商通道是必须接入的吗？什么情况下可以不接？

不是必然选择，而是显式权衡。必接：IM/交易/告警等"消息即业务"、要求离线到达率 90%+。可不接/缓接：低频运营促活推送、团队小工期紧、缺软著等厂商审核资质。某已上线半年的 Flutter 混合开发项目 Android 全量走极光自有长连接、未接任何厂商通道，用离线到达率的损失换零厂商维护成本（四家后台配置、软著审核、SDK 迭代跟进），上线半年表现符合预期——关键前提是选聚合 SDK 时保留增量打开厂商通道的演进空间，让决策可逆。

###  透传消息和通知栏消息有什么区别？

透传消息由 App 接收并自行处理（可展示通知、可静默处理），灵活但要求 App 有活跃进程；通知栏消息由系统直接展示通知，App 不需要运行，但无法自定义展示逻辑。OPPO 不支持透传是关键差异。

###  如何设计推送的消息路由？用户点击通知后怎么跳转到对应页面？

以某上线半年的项目为例：服务端在通知 extras 里下发 type/momentId/jumpUrl 等业务字段，客户端在点击回调里解析成统一的 PushModel——Android 要从 extras['cn.jpush.android.EXTRA'] 取且可能是 JSON 字符串，iOS 直接读 userInfo。跳转前做守卫（未登录、登录/引导流程中不跳），混合栈下先 popUntil 回主页容器再 push 目标页；最后按 type 查集中分发表：切 tab 类只切换主页 tab、业务页类 push 对应路由、99 号只允许跳转到 HTTPS 域名白名单内的 H5，未知类型和非法 URL 拒绝并上报，消费后置空。冷启动回调收不到，还要从原生拉取启动参数做补偿，与热启动共用同一分发逻辑。

###  推送到达率怎么统计？各环节的到达率差异是什么？

推送链路每层都可能丢消息，需要分阶段上报事件：服务端发送 → 设备收到 → 通知展示 → 用户点击。关键难点是"通知展示"这一环无法精确统计（系统不会通知 App 通知是否展示），通常用"设备收到"近似。Token 过期、厂商限频、通知折叠是到达率下降的三大原因。

###  推送 SDK 的初始化时机有什么合规要求？怎么落地？

推送 SDK 可能采集设备标识，必须先向用户展示隐私政策并取得明确同意，再初始化或调用会采集信息的接口；首帧完成、服务端配置返回或所谓“审核态”都不能替代用户同意。落地时持久化同意版本与时间，Flutter 和原生共享同一状态，拒绝时保持 SDK 未初始化；同意后再加载渠道配置并执行 setup。代价是 registrationId 到得更晚，因此冷启动点击补偿和延迟注册监控要配套做。

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
