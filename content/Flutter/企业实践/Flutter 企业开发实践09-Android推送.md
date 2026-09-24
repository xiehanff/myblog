---
title: Flutter 企业开发实践09-Android推送
date: 2026-05-18
tags: [Flutter, 面试, 架构, 推送, 厂商通道, 透传消息, 离线推送, JPush, 极光]
---

# Android 推送

> 在国内 Android 生态里，推送不是"加个 SDK 就能用"的事。厂商通道常被当成救命稻草，可它到底是不是必选项？本文分五块讲：推送怎么选型、厂商通道怎么接、消息类型怎么设计、通知点击怎么路由，还有 Flutter 侧怎么封装。同时拿一个上线半年的 Flutter 混合开发项目做例子（下文简称"该项目"）：它 Android 只走极光长连接，一家厂商通道都没接，这个取舍正好可以当"要不要厂商通道"的样本。

---

## 概述：Android 推送解决什么问题？

推送是 App 主动触达用户最重要的通道。可国内 Android 环境特殊：Google Play Services 用不了，FCM（Firebase Cloud Messaging）基本等于摆设，App 进程一旦被系统杀掉，什么自建长连接都活不下来。**推送背后没有厂商通道撑着，离线到达率可能连 30% 都不到。**

问题的链条是这样：

1. 国内 Android 没有 FCM → 指望不上统一推送
2. 国产 ROM 清后台很激进 → 自建长连接说断就断
3. 各厂商自己搞推送通道 → 离线到达率最优解，但接入和维护成本高，得权衡
4. 厂商通道 API 各写各的 → 需要一层聚合统一管理
5. 工信部和应用商店有合规要求 → 推送 SDK 得等用户同意隐私政策之后才能初始化

---

## 核心内容

### 1. 推送架构：厂商通道 vs 第三方聚合

#### 厂商通道到底解决了什么？

[Android] 国产 ROM（华为 EMUI/HarmonyOS、小米 MIUI、OPPO ColorOS、vivo OriginOS、魅族 Flyme）都有自己的系统级推送服务，跑在系统进程里，不看 App 保活的脸色，所以能办到几件事：

- **进程被杀照样能送到**：消息先由系统服务收下，再唤起 App 或者直接把通知亮出来
- **省电省内存**：App 不用自己挂着长连接，长连接交给厂商推送服务统一管
- **但到达率差得很远**：

| 方案 | 在线到达率 | 离线到达率 | 说明 |
|------|-----------|-----------|------|
| 自建长连接（WebSocket/MQTT） | 90%+ | <30% | 进程被杀即失效 |
| 第三方聚合（极光/个推） | 90%+ | 50-70% | 依赖自建通道+厂商通道混合 |
| 厂商通道直连 | 95%+ | 90%+ | 系统级保障 |

**不接厂商通道，代价是什么？** 用户一锁屏，App 进程被系统杀掉，自建长连接跟着断，消息只能靠聚合服务商自己的通道和系统兜底，离线到达率一下就掉下去了。对社交、IM、交易类 App，这可能是致命的；对运营促活类 App，这也许只是能接受的折中。要不要厂商通道，是道成本收益题，不一定非接不可。

#### 真实案例：一个上线半年的项目为什么"敢"不接厂商通道

该项目，Android 端只集成了极光 JPush（jpush_flutter 3.3.9，iOS 侧 Pods 为 JPush 5.9.0 + JCore 5.4.0），**一家厂商通道都没接**，全量消息都走极光自有长连接。这是团队明确算过的取舍，不是偷懒：

| 权衡维度 | 分析 |
|---------|------|
| 集成成本 | 华为、小米、OPPO、vivo 每家都得注册开发者账号、建应用、配签名指纹；OPPO 和 vivo 还要软著审核；聚合 SDK 里得一家家打开开关、一家家回归，第一次接至少花 1-2 周 |
| 维护成本 | 厂商 SDK 版本发得勤，插件要跟着升，后台配置（像华为的 agconnect-services.json）每年还得更新，审核流程也要重走，这些都算长期"税" |
| 到达率收益 | 厂商通道主要提的是**离线到达率**。该项目是内容运营型 App，不是 IM，推送以每天低频促活为主，没有一条"必须秒到"的消息；从在线时长和推送频率看，长连接在线的那段时间已经覆盖了大部分推送窗口 |
| 双端一致性 | iOS 本来就只能走 APNs，压根没有"厂商通道"可接；双端统一用极光，后台一套、报表一份、服务端 API 一套 |

结论：**拿离线到达率的损失，换零厂商维护成本**。这套做法上线跑了半年，一直挺稳；以后推送要是变成 IM、交易这类核心链路，厂商通道还能在聚合 SDK 里一个个打开，这也是当初选聚合层当底座换来的空间。

#### 决策框架：要不要接厂商通道？

把"要不要厂商通道"当成一个能反复用的决策框架，别默认它就是必选：

1. **推送在业务里的分量**：IM、交易、告警类（消息就是业务）→ 必接；运营促活类（晚到用户也没感觉）→ 可以先缓一缓，甚至不接
2. **离线到达率能忍到什么程度**：50-70% 能接受 → 聚合通道就够了；要求 90%+ → 只能上厂商通道
3. **团队人力和工期**：小团队、首版时间又紧 → 先用聚合通道上线，厂商通道留到二期
4. **资质门槛**：软著或企业开发者账号还没有 → OPPO、vivo 直接卡住，只能走聚合通道
5. **以后好不好扩展**：选聚合 SDK（极光、个推）时先确认它支持后面增量打开厂商通道，给自己留条后路

> 反过来也得清醒：厂商通道管的是"进程被杀之后还能送到"，它救不了推送内容烂、频率高。先把推什么、推给谁想清楚，再决定用什么通道。

#### 第三方聚合的价值

极光（JPush）、个推、信鸽这些第三方推送服务，核心价值就是做一层**统一接入层**：

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

**优势**：集成一次，后面自动路由到对应的厂商通道
**代价**：多一层 SDK 依赖，厂商通道版本更新可能慢半拍，而且聚合 SDK 自己也有商业上的考量

#### 选型决策

| 场景 | 推荐方案 | 原因 |
|------|---------|------|
| 社交、IM、交易类，推送是核心功能 | 厂商通道直连（或聚合 + 全量厂商通道） | 到达率和时效性要求高 |
| 运营促活类 App，团队小、工期紧 | 聚合通道先行，不接厂商通道 | 离线到达率的损失可以接受，厂商维护成本为零（真实项目采用） |
| 团队不到 5 人，要快速上线 | 第三方聚合 | 接入成本最低 |
| 大型 App，多条业务线 | 自建聚合服务端 + 厂商通道 | 完全可控，服务端统一路由 |

---

### 2. 华为/小米/OPPO/vivo 厂商通道接入要点

#### 共同流程

每个厂商通道的接入流程都差不多：

1. **注册开发者账号** → 建应用 → 拿到 AppID/AppKey/ClientSecret
2. **集成客户端 SDK** → 拿到 PushToken → 上报服务端
3. **服务端对接推送 API** → 按 Token 或主题推
4. **处理推送回调** → 展示通知 / 点击跳转

#### 各厂商差异对比

| 维度 | 华为 Push | 小米 Push | OPPO Push | vivo Push |
|------|----------|----------|----------|----------|
| 接入门槛 | 得做华为开发者认证 | 个人就能开 | 要软著审核 | 要软著审核 |
| SDK 体积 | ~1.5MB | ~800KB | ~600KB | ~700KB |
| 通知 vs 透传 | 都支持 | 都支持 | 仅通知栏消息 | 都支持 |
| 主题推送 | 支持 | 支持 | 不支持 | 支持 |
| 内测/审核 | 要申请审核 | 不用 | 要申请 | 要申请 |
| HarmonyOS 适配 | HMS Core Push | - | - | - |

#### 关键接入坑

**华为 HMS** [Android]
- 必须用 `agconnect-services.json` 配置文件，位置放错了会编译报错，可报错信息又不说明白
- 华为手机上得装 HMS Core（apk），有些老机型没预装，要引导用户去装
- Debug 签名和 Release 签名对应的是不同的 ClientSecret，切环境时很容易漏
- 华为的审核流程大概 1-3 个工作日

**小米 Push** [Android]
- 支持透传消息，但 MIUI 12+ 对后台启动 Activity 有约束
- 小米的 `regId` 卸载重装之后会变，服务端得跟着更新
- 国际版的小米手机用不了小米推送

**OPPO Push** [Android]
- **不支持透传消息**，只能发通知栏消息，这是最要命的一条限制
- 接入要走 OPPO 开发者平台审核，审核得交软著
- OPPO 的通知渠道必须提前建好，不然低优先级的通知可能根本不显示

**vivo Push** [Android]
- 一样要软著审核
- vivo 的 `regId` 长度不固定，设计数据库字段时别把长度写死
- 类名必须在 vivo 平台注册过，不然点了通知跳不过去

---

### 3. 透传消息 vs 通知栏消息

这是理解推送架构最关键的那个分叉点。

#### 通知栏消息（Notification Message）

```
服务端 → 厂商推送服务 → 系统直接展示通知 → 用户点击 → 唤起 App
```

- **通知由系统直接展示**，App 不用运行
- 消息体固定格式：`title` + `content` + `clickAction`
- **App 进程可能压根没启动**，用户点了才唤起
- 适合的场景：运营推送、公告、活动通知

#### 透传消息（Data Message / Silent Message）

```
服务端 → 厂商推送服务 → App 接收数据 → App 自己决定要不要展示通知
```

- App 得有个活跃进程（或者厂商 SDK 的 Receiver）才收得到
- 消息体自己定，展示逻辑完全由 App 说了算
- 能干的事：前端处理数据、静默同步、自定义通知样式、IM 消息聚合
- **OPPO 不支持透传**，这是做方案时最主要的障碍

#### 架构决策：怎么选？

| 需求 | 选择 | 原因 |
|------|------|------|
| 纯运营推送，到达率优先 | 通知栏消息 | 离线也能送达 |
| IM 消息，需要前端处理后再展示 | 透传消息 | 需要前端聚合、去重、自己画 UI |
| 两者都有 | 混合方案 | 透传优先，离线 fallback 到通知栏 |

**混合方案设计**：

```
App 在线 → 透传消息 → 前端处理 → 自定义通知
App 离线 → 通知栏消息 → 用户点击 → 进入对应页面
```

服务端得知道 App 在不在线：在线就发透传，离线就发通知栏。IM 类 App 基本都这么干。

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

下面是该项目的真实做法（极光 jpush_flutter + flutter_boost 混合栈）。通知里的业务参数由服务端写进 extras，客户端在点击回调里统一解析成 `PushModel`：

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

**第一步：解析 extras（Android 和 iOS 的结构不一样）**

[Android] 极光把通知的附加字段放在 `extras['cn.jpush.android.EXTRA']` 里，而且**可能是 JSON 字符串，不一定是 Map**（看下发方式）；[iOS] 点击回调直接把 userInfo 带上，根节点就是业务字段：

```dart
static void _handlerPushMsg(Map<String, dynamic> message) async {
  // 守卫 1：未登录不跳，避免把用户"闪送"到登录页背后的业务页
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

`jumpTo` 用一个 switch 把所有跳转目标集中管起来，运营那边只要在后台配 type 编号就行：

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

这套分发设计有几个要点：

| 设计点 | 动机 |
|--------|------|
| 用 type 编号，不用 URI Scheme | 运营后台配置简单，客户端一个 switch 就能管住；H5 只收 HTTPS + 域名白名单；消费完置空，防重复触发 |
| 守卫条件（未登录、登录流程里不跳） | 推送可能落在任何栈状态上，不加守卫就会出现"登录页上叠着业务页"这种怪栈 |
| 先 popUntil 回主页再 push | flutter_boost 混合栈下这样返回键语义才对，从目标页返回一定回主页，不会随机落到别的页面 |

#### 关键坑：冷启动 vs 热启动

- **冷启动**（App 没运行）：通知的点击数据在启动参数里（[iOS] launchOptions、[Android] 启动 Intent），这时候 Flutter 的 `addEventHandler` 还没注册，回调根本收不到
- **热启动**（App 在后台）：点击通知走 `onOpenNotification` 回调，正常消费。两条链路都得处理，不然冷启动点通知就是"没反应"。偏偏测试的时候大家往往只测热启动
- 真实项目的做法：推送初始化到最后，主动调一次 `_getLaunchData()`，通过自建的 MethodChannel 从原生那侧拉启动参数（[Android] 解析 `JMessageExtra → n_extras`，[iOS] 解析 `UIApplicationLaunchOptionsRemoteNotificationKey`），解析出来的 PushModel 和热启动走同一个 jumpTo 分发，冷热启动的行为完全一致（双端实现详见 10-iOS推送篇第 6 节）

---

### 5. 推送到达率统计与优化

#### 到达率统计为什么这么难？

推送链路又长、环节又多，哪一层都可能把消息丢了：

```
服务端发送 → 聚合平台 → 厂商推送服务 → 系统通知展示 → 用户看到
     ↓            ↓             ↓              ↓
   超时/限流    路由失败     Token失效/限频   通知折叠/静默
```

每层说的"到达"，定义都不一样：
- **服务端到达率**：聚合平台返回成功 / 厂商 API 返回成功 → 99%+
- **设备到达率**：设备 SDK 收到回调 → 70-90%（看厂商通道）
- **展示到达率**：通知真的挂到通知栏 → 受通知折叠、静默时段影响
- **用户感知到达率**：用户真的看到通知 → 这个没法精确统计

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

1. **Token 管理**：每次启动都刷新 PushToken 并上报，Token 过期是到达率往下掉的头号原因
2. **通知渠道优化** [Android]：建高优先级的通知渠道，免得被系统折叠
3. **厂商通道降级**：厂商通道发失败就 fallback 到自建通道（App 在线时）
4. **推送频率控制**：别把频率顶到厂商的限流线，一限就是批量丢弃
5. **消息合并**：短时间内的多条推送合成一条，免得通知栏被折叠

---

### 6. Flutter 侧插件封装：以 JPushManager 为例

封装图的是**把底层差异挡住**，业务层不用管当前走的哪个通道。不过真实项目里，"抽象"不一定非要先写一套 PushService 接口再写实现。该项目就在极光官方插件 jpush_flutter（3.3.9）上直接封了一个两百多行的 JPushManager 单例，把**初始化、权限、回调流、registrationId 上报、点击路由分发**这五件事收进一个文件：业务层只认识 JPushManager，以后真要换推送服务商，要改的也就在这一处（跨平台抽象接口的完整讨论见 10-iOS推送篇第 5 节）。

#### setup：appKey 由 Dart 传入，原生零配置

jpush_flutter 支持在 Dart 侧 `setup` 时直接把 appKey 传进去，原生工程不用再动 manifest/plist，第三方参数集中放在一个配置类里维护，双端配置就不会各走各的：

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

appKey 有两种配法：**Dart 动态传入**（真实项目用的就是这种，配置集中在 ThirdPartyConfig 一处，多环境、多渠道包切换方便，原生工程里一点推送配置都没有），还有**原生硬编码**（AndroidManifest meta-data / Info.plist，不依赖 Flutter 的初始化时序，但双端两份配置容易走偏）。工程里一定只挑一种，混着用的坑见坑8。

#### 权限申请：iOS applyPushAuthority / Android 13+ 动态权限

[双端] setup 完紧接着就处理通知权限，两端手段不一样：

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

registrationId 是极光的设备标识（服务端按它定向推送）。它拿到手是**异步的，还可能延迟**，上报又依赖**登录态**，这两个条件不同步，时机怎么定就成了核心问题。真实项目的解法是"取到就存，能报就报，登录再补"：

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

三个上报时机，各管一段：

| 时机 | 动作 | 原因 |
|------|------|------|
| setup 完成后 | getRegistrationID → 持久化 + 尝试上报 | registrationId 是异步到的，首次启动还可能是空的，所以必须落盘，不能只搁在内存里 |
| 登录成功回调 | 再上报一次 | 上报接口要登录态；用户可能是"先启动、后登录"，冷启动那一次报不上 |
| 每次冷启动 | 重取 + 再报 | 卸载重装、换设备都会换 id，每次启动刷新一遍比较保险 |

#### 封装的整体结构

业务层只认识 JPushManager，它内部收敛了六大职责：setupJPush（初始化 + 权限）、addEventHandler（回调流）、registrationId（持久化 + 补报）、_handlerPushMsg（守卫与解析）、jumpTo（分发表）、_getLaunchData（冷启动补偿）。再往下就是 jpush_flutter 3.3.9 这层桥接和原生 SDK（[iOS] JPush 5.9.0 + JCore 5.4.0 底层走 APNs；[Android] 极光长连接，没接厂商通道）。

#### 不这么做会怎样？

不做统一封装，让各业务模块直接对接推送 SDK、厂商通道，后果是这样：
- 换推送方案的时候，所有业务代码都得跟着改（真实项目把极光收在一个 JPushManager 里，就是给以后替换留了后门）
- 通知回调格式五花八门（Android 的 extras 还嵌着一层，iOS 直接给 userInfo），业务层满屏 if-else 和平台判断
- registrationId 的上报时机散在各处，服务端永远拿不到全量的设备标识
- 想做统一的点击统计和冷启动补偿也没法做

---

### 7. 隐私合规：推送 SDK 必须延迟初始化

#### 为什么不能在 main() 里初始化推送？

工信部《App 违法违规收集使用个人信息行为认定方法》和各应用商店的审核要求写着同一条：**用户同意隐私政策之后，App 才能初始化会采集设备信息的第三方 SDK**。推送 SDK 初始化的时候会读设备标识、注册长连接，是典型的"采集个人信息"；直接在 `main()` 或 Application.onCreate 里 setup，是上架被拒、被通报的高频原因。

#### 真实项目的延迟初始化链路

该项目先等用户明确同意隐私协议，再取版本配置、初始化推送。关键的门禁就一个：`privacyConsent == true`；首帧渲染完、审核状态、远程开关，这些都不能代替用户同意：

```
main() → runApp() → 首页容器读取本地 privacyConsent
  → 未同意：展示隐私协议 → 用户拒绝：不初始化任何三方 SDK
                         └→ 用户同意：持久化 consent 版本与时间
  → 获取版本/渠道配置（失败不影响 consent 判断）
  → MethodChannel 同步 consent 给原生宿主
  → consent == true → initAllSDK() → JPushManager.setupJPush()
  → 开屏加载 / 进入主流程
```

这么做有三重收益：

1. **合规能举证**：同意记录里有协议版本、时间和渠道，SDK 初始化在代码上也被 consent 状态明确挡住
2. **不拖累首屏**：setup 里有网络注册和权限弹窗，搁在首帧前面会直接拖慢冷启动
3. **双端一致**：Flutter 和原生宿主共用同一份 consent 状态，哪一端都别想抢跑初始化

代价也得心里有数：初始化越晚，registrationId 来得越晚，冷启动点击推送的补偿链路就更得自己做（见第 4 节和 10-iOS推送篇第 6 节）。**合规延迟初始化和冷启动补偿，是一对必须一起设计的孪生问题**。

---

## 常见坑

### 坑1：PushToken 时机问题

PushToken 的获取是异步的，网络一差还会延迟返回。常见的翻车姿势是在 `main()` 里同步取 Token 并上报，正确做法是在回调里处理：

```dart
PushService.instance.init();
PushService.instance.onTokenRefresh((token) {
  // 这里上报，不要在 init() 后同步 getToken
  api.reportPushToken(token);
});
```

### 坑2：华为 HMS Core 未安装

[Android] 一些老款华为手机没预装 HMS Core，调 Push API 会闷声失败。得先检测 HMS Core 能不能用：

```kotlin
if (HuaweiApiAvailability.getInstance().isHuaweiMobileServicesAvailable(context) == ConnectionResult.SUCCESS) {
    // 初始化华为推送
} else {
    // fallback 到其他通道
}
```

### 坑3：OPPO 不支持透传

设计推送方案的时候，OPPO 不支持透传这条必须算进去。IM 类 App 的做法是：OPPO 设备上走通知栏消息 + 离线消息拉取，用户点进来之后 App 再拉一次历史消息补齐。

### 坑4：通知渠道未创建

[Android] Android 8.0+ 得有通知渠道，通知才展示得出来。厂商 SDK 一般会帮你建一个默认渠道，但你要自定义渠道（比如静音渠道、高优先级渠道）的话，必须在推送之前就建好：

```kotlin
val channel = NotificationChannel(
    "high_priority",
    "重要通知",
    NotificationManager.IMPORTANCE_HIGH
)
notificationManager.createNotificationChannel(channel)
```

### 坑5：多进程回调

[Android] 厂商 SDK 的推送回调可能是在独立进程里触发的，可 Flutter Engine 跑在主进程。回调一旦落在非主进程，MethodChannel 通信就会失败。解法是在非主进程里用 `ContentProvider` 或者 `BroadcastReceiver` 把它转发到主进程。

### 坑6：registrationID 获取过早拿到空值

[Android] registrationId 是极光服务端在长连接注册成功之后下发的，**异步，还可能延迟**。setup 完立马去同步取，首次集成或者弱网的时候经常只拿到个空字符串。正确的姿势：

- `getRegistrationID()` 在 setup 完成后异步调，结果**持久化**存起来（比如 GetStorage），别只在内存里用完就算；拿到空值别搞重试风暴，等下次启动自然刷新，登录成功之后再补报一次（真实项目就是"setup 后取一次 + 登录成功补报一次"的双保险）
- 别把 registrationId 当业务唯一标识用，它只服务推送这一件事

### 坑7：多进程 App 的 SDK 重复初始化

[Android] App 配了多进程（`:push`、`:remote` 之类）的话，`Application.onCreate` 在每个进程都会各跑一遍。推送 SDK 在非主进程重复初始化，轻的浪费资源，重的回调错乱、通知点击路由直接失效。所以必须在 Application 里区分进程：

```kotlin
override fun onCreate() {
    super.onCreate()
    // 只有主进程才初始化推送/统计等 SDK
    if (packageName == Application.getProcessName()) initPushSDK()
}
```

用 jpush_flutter + 混合栈的时候尤其要留意：Flutter Engine 只在主进程里，非主进程触发 MethodChannel 必然失败。

### 坑8：appKey 两种配置模式混用

[Android] 极光的 appKey 有两种配法：① Dart 侧 setup 动态传入；② AndroidManifest meta-data 硬编码。两种同时存在时，**动态传入优先**。常见的翻车现场：排查问题时改了 manifest 里的 appKey，结果不生效；或者 Android manifest 和 iOS plist 各配各的，双端漂移。建议全工程只留一种：真实项目选的是 Dart 传入，并集中到 ThirdPartyConfig，原生工程里一点推送配置都没有。

```xml
<!-- 模式②：manifest 硬编码（与 Dart 动态传入二选一，不要并存） -->
<meta-data android:name="JPUSH_APPKEY" android:value="jpushAppKey" />
```

---

## 面试追问

### 为什么国内 Android 推送绕不开"厂商通道"这个话题？

因为国内没有 Google Play Services，FCM 用不了。App 进程被系统杀掉之后，自建长连接断开，离线推送基本就废了。厂商通道跑在系统进程里，不受 App 进程生命周期的影响，离线到达率能从 <30% 提到 90%+。但"绕不开"不等于"必须接"。它是道成本收益题：IM、交易类必接，运营促活类可以权衡（见下一问）。

### 厂商通道是必须接入的吗？什么情况下可以不接？

这是明确算过的取舍，不是必然要接。必接：IM、交易、告警这类"消息就是业务"、要求离线到达率 90%+ 的。可不接、缓接的：低频运营促活推送、团队小工期紧、软著这些厂商审核资质还没齐。该项目 Android 全量走极光自有长连接，一家厂商通道都没接，用离线到达率的损失换零厂商维护成本（四家的后台配置、软著审核、SDK 迭代跟进），上线半年，表现符合预期。关键前提是选聚合 SDK 的时候留一手：以后能增量的把厂商通道打开，让这个决策可以反悔。

### 透传消息和通知栏消息有什么区别？

透传消息是 App 收到自己处理（可以展示通知，也可以静默处理），灵活，但要求 App 得有活跃进程；通知栏消息由系统直接展示，App 不用跑着，代价是展示逻辑没法自定义。OPPO 不支持透传，这是两边最关键的差异。

### 如何设计推送的消息路由？用户点击通知后怎么跳转到对应页面？

拿那个上线半年的项目说：服务端在通知 extras 里下发 type/momentId/jumpUrl 这些业务字段，客户端在点击回调里解析成统一的 PushModel：Android 得从 extras['cn.jpush.android.EXTRA'] 里取，还可能是个 JSON 字符串，iOS 直接读 userInfo。跳之前先过守卫（未登录不跳，登录和引导流程里也不跳），混合栈下先 popUntil 回主页容器，再 push 目标页；最后按 type 查那张集中分发表：切 tab 类只切主页 tab，业务页类 push 对应路由，99 号只允许跳到 HTTPS 域名白名单里的 H5，未知类型和非法 URL 直接拒绝并上报，消费完置空。冷启动回调收不到，还得从原生拉一次启动参数做补偿，和热启动共用同一套分发逻辑。

### 推送到达率怎么统计？各环节的到达率差异是什么？

推送链路每一层都可能丢消息，所以要分阶段上报事件：服务端发送 → 设备收到 → 通知展示 → 用户点击。最难的就在"通知展示"这一环，它没法精确统计（系统不会告诉 App 通知到底展示没展示），一般拿"设备收到"近似。Token 过期、厂商限频、通知折叠，是到达率往下掉的三大原因。

### 推送 SDK 的初始化时机有什么合规要求？怎么落地？

推送 SDK 会采集设备标识，所以必须先给用户看隐私政策、拿到明确同意，再去初始化或者调那些会采集信息的接口；首帧跑完、服务端配置返回、所谓“审核态”，这些都不能替代用户同意。落地的时候把同意的版本和时间持久化，Flutter 和原生共享同一份状态，用户拒绝就让 SDK 一直不初始化；同意了再加载渠道配置、执行 setup。代价是 registrationId 来得更晚，所以冷启动点击补偿和延迟注册的监控得配套做。

### 如果让你从零设计一个推送架构，支持多厂商通道且可扩展，你会怎么设计？

1. **服务端**：统一推送 API 层 → 路由层（按设备 Token 前缀或者厂商标识分发到对应厂商通道）→ 厂商适配器层（每家一个适配器，实现同一套接口）
2. **客户端**：Flutter 侧定义 PushService 抽象接口 → Android 侧按 Build.MANUFACTURER 自动挑 PushDelegate → 每个 PushDelegate 封一个厂商 SDK
3. **消息类型**：统一消息模型，里面带 isNotification 字段，服务端看 App 在不在线决定发透传还是通知栏
4. **可扩展性**：新增厂商只需新增适配器/Delegate，不改路由逻辑和业务代码
5. **可观测性**：每个环节都打点上报，攒出一条端到端的到达率漏斗

---

## 参考资源

- [华为推送服务开发指南](https://developer.huawei.com/consumer/cn/hms/huawei-pushkit/)
- [小米推送服务文档](https://dev.mi.com/console/doc/detail?pId=230)
- [OPPO 推送服务](https://push.oppo.com/)
- [vivo 推送服务](https://dev.vivo.com.cn/documentCenter/doc/366)
- [极光推送 Flutter 插件](https://docs.jiguang.cn/jpush/client/Flutter/Flutter_plugin/)
- Android Notification Channels 官方文档
