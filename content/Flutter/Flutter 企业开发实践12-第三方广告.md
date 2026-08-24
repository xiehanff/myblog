---
title: Flutter 企业开发实践12-第三方广告
date: 2026-08-24
tags:
  - Flutter
  - 广告变现
  - 聚合SDK
  - ToBid
  - Sigmob
  - 激励视频
---

# 广告变现与聚合 SDK——ToBid 从 0 到 1 的接入与排坑

> 广告变现是"对接类"工作里链条最长的一类：它同时碰构建系统（多家 ADN 的 aar 依赖冲突）、双端原生（SDK 的展示控制器、PlatformView 渲染时序）、业务状态机（激励发放与错误处理的二十种组合）和合规（审核形态、隐私权限）。
> 本篇基于某从 0 到 1 开发、并在线上经过多轮迭代修复的真实项目（下文简称"该项目"），以 ToBid（Sigmob/Windmill 系）聚合 SDK 为样本，把整条链路的决策、实现与踩过的坑完整拆开。

**版本说明**：基于 `windmill_ad_plugin 5.5.5`（ToBid Android/iOS SDK 5.5.5），信息截至 2026-08。文中业务代码取自该项目生产代码（标识符已做匿名化处理），插件原生层的通信实现不在本篇展开。

---

## 概述

先给出整篇的结论，再逐层展开：

1. **国内聚合首选自托管可控的国内平台**。该项目选 ToBid（穿山甲/优量汇/百度/快手等 8 家 ADN 的聚合层），决策依据是国内联盟覆盖、Waterfall + Bidding 双模、 Flutter 插件完整。
2. **集成方式比选型更影响后续效率**：以**本地插件目录**形式引入（而非 pub 依赖），换来的是"出问题能自己打补丁"的能力——后文的 iOS Modal 补丁就是靠这个能力救急的。
3. **激励视频是业务复杂度的主体**：一次"看广告发奖励"要过资格校验、冷却、免责弹窗三道关卡，成功/失败回调有 5 种时序组合，错误处理分"用户可见"和"日志上报"两层——这块的状态机设计是面试的真正考点。
4. **信息流广告"单体跑通"和"嵌进列表"是两道坎**：后者要解决滚动中加载的浪费与抖动、列表回收重建打散广告状态、失败位留白三个问题——滚动感知 + 索引缓存 + 失败折叠是成套解法。
5. **构建期与运行期的坑一样多**：AGP 降级、Jetifier、Manifest 合并冲突在编译期；PlatformView 时序、Modal 控制器查找在运行期。都要有排坑记录。

---

## 核心内容

### 1. 聚合广告的决策框架

#### 1.1 为什么需要聚合

单接一家广告联盟（穿山甲或优量汇）的问题：**填充率有天花板**——某家没有库存时请求直接浪费。聚合平台把一次请求同时发给多家联盟（Bidding）或按 eCPM 历史排序依次请求（Waterfall），填充率和综合 eCPM 都显著优于单接。

| 维度 | Waterfall（瀑布流） | Bidding（竞价） |
|------|-------------------|----------------|
| 原理 | 按 eCPM 历史数据排优先级，依次请求 | 所有联盟同时出价，选最高 |
| 实时性 | 依赖历史数据 | 实时反映当前竞价 |
| 缺点 | 排序靠后的联盟可能永远拿不到请求 | 依赖各联盟竞价能力 |

成熟做法是**两者混用**：支持 Bidding 的联盟走竞价，其余进瀑布兜底——这正是聚合平台的核心价值，也是自研聚合不划算的原因。

#### 1.2 选型格局（口径截至 2026-08）

| 方案 | 定位 | 备注 |
|------|------|------|
| ToBid（Sigmob/Windmill） | 国内聚合 | 本篇样本；Flutter 插件完整，8 家主流 ADN |
| 穿山甲 GroMore | 字节聚合 | 国内主流，Flutter 侧多需自接或桥接 |
| TopOn（国内已拆分 Taku） | 第三方聚合 | 2024-03 拆分：中国区业务由新品牌 Taku 承接，出海仍用 TopOn |
| AdMob | Google 聚合 | 大陆设备基本不可达，仅出海 |
| AppLovin MAX / Unity LevelPlay | 海外主流 | 出海场景 |

> 名词澄清：2023 年被 Unity 关停的是**自家的 Unity Mediation**；ironSource 的聚合以 **Unity LevelPlay** 之名继续迭代（2025-09 的 SDK 9.0 已全面迁移 API 命名）。网上把"ironSource 关停"当讣告的说法是错的。

**选型建议**：纯国内产品在 ToBid/GroMore/Taku 里按"插件完整度 + 后台数据 + 服务响应"实测评选择；出海走 MAX/LevelPlay/AdMob；最重要的不是平台名字，而是下文第 2 节的集成方式决策。

### 2. 集成方式：为什么用本地插件而不是 pub 依赖

官方 Flutter 插件（`windmill_ad_plugin`）该项目以**本地目录**形式引入（`plugins/tobid5550/`，目录名带版本号），`pubspec.yaml` 用 path 依赖：

```yaml
windmill_ad_plugin:
  path: plugins/tobid5550
```

插件内容：Dart 层 API（`WindmillAd` / `WindmillSplashAd` / `WindmillRewardAd` / `WindmillNativeAd` 等）+ 双端原生层 + Android 侧 8 家 ADN 的 aar（穿山甲、优量汇、百度、快手、美数、趣盟、AdScope、GroMore）+ OAID SDK。`pub get` 后经 `GeneratedPluginRegistrant` 自动注册，宿主无需改 `MainActivity`。

**为什么要本地化？** 两个生产级理由：

1. **补丁能力**。广告 SDK 的 bug 不会等你——该项目上线后就遇到 iOS Modal 场景激励广告拉不起的问题，根因在插件 OC 代码的一行返回值错误（见第 9 节）。走官方 issue 等排期可能要数周，本地插件一行补丁当天解决。pub 依赖做不到这件事。
2. **构建链路可控**。ADN 的 aar 版本、依赖冲突都锁在自己仓库里，升级节奏自己定（代价是每次升级要人工同步，必须配升级核对清单）。

**代价与纪律**：本地插件 = 永久的 fork 维护成本。每次改动必须留文档记录（改了什么、为什么、升级时怎么核对），否则半年后没人敢动它——该项目的补丁记录文档就是为这个存在的。

### 3. 宿主工程改造：Android 构建期的四个坑

引入聚合插件后，宿主 Android 工程需要四处改造——这些是"集成日"一次性踩完的坑，记录下来下次集成可直查：

**坑 1：AGP 版本降级**。插件 `build.gradle` 的 buildscript classpath 与宿主 AGP 版本链路不匹配，宿主从 AGP 8.11.1 降到 8.4.0 才能构建（Kotlin 2.2.20 不动）：

```kotlin
// android/settings.gradle.kts
id("com.android.application") version "8.4.0" apply false
```

**坑 2：开启 Jetifier**。部分 ADN 的 aar 传递依赖旧版 Android Support 库，与 `android.useAndroidX=true` 冲突：

```properties
# android/gradle.properties
android.useAndroidX=true
android.enableJetifier=true
```

**坑 3：统一 androidx 版本 + 补依赖**。多家 ADN 会传递引入不同版本的 androidx 组件，用 `resolutionStrategy` 强制统一；原生信息流模板渲染依赖 CardView，需显式声明：

```kotlin
// android/app/build.gradle.kts
configurations.all {
    resolutionStrategy {
        eachDependency {
            if (requested.group == "androidx.browser" && requested.name == "browser") {
                useVersion("1.8.0")
            }
            if (requested.group == "androidx.core") {
                useVersion("1.15.0")
            }
        }
    }
}

dependencies {
    implementation("androidx.cardview:cardview:1.0.0")
}
```

**坑 4：Manifest 合并冲突**。广告 SDK 的 manifest 声明的 `allowBackup` 与应用取值不同导致 merger 报错，用 `tools:replace` 以应用为准：

```xml
<application
    android:name="${applicationName}"
    android:allowBackup="false"
    android:label="应用名"
    tools:replace="android:allowBackup,android:label">
```

另有硬性门槛：插件要求宿主 `minSdkVersion >= 24`。iOS 侧对应确认 podspec 与权限声明。这四个坑的共同点：**全部在构建期暴露，报错信息都在 Gradle/Merger 输出里**——集成日预留半天专门处理依赖冲突是合理预期。

### 4. 初始化与合规：审核形态是一等公民

初始化入口收敛在 `AdCommonManager` 单例里，它做了三件事，每件都有讲究：

```dart
class AdCommonManager {
  factory AdCommonManager() => _instance;

  Future<void> initTobidAd() async {
    try {
      // 1. 审核模式下收紧 SDK 的隐私采集能力
      if (AuditState.isEnabled) { // 审核形态开关（示意命名，服务端下发）
        WindmillAd.setCustomDevice(CustomDevice(
          isCanUseAppList: false,
          isCanUseLocation: false,
          isCanUseAndroidId: false,
          isCanUseOaid: false,
          isCanUseIdfa: false,
          isCanUsePhoneState: false,
          isCanUseWifiState: false,
          isCanUseMacAddress: false,
          isCanUseWriteExternal: false,
          isCanUsePermissionRecordAudio: false,
        ));
      }

      // 2. 按平台取 AppId 初始化（AppId 也是集中配置，文中不落真实值）
      final appId = Platform.isAndroid
          ? AdConfig.tobidAndroidAppId
          : AdConfig.tobidIosAppId;
      final res = await WindmillAd.init(appId);

      // 3. 初始化失败不是静默吞掉，而是上报服务端留痕
      if (res is Map && res['success'] != true) {
        await reportTobidInitError(res);
      }
    } catch (e, s) {
      await reportTobidInitError({'error': e.toString()});
    }
  }
}
```

三个设计点：

1. **审核模式收紧隐私权限**：`setCustomDevice` 把应用列表/定位/AndroidId/OAID/IDFA 等采集开关全部关掉。这不是可选项——商店审核期间展示广告 + 过度采集是高频拒审组合；审核通过后恢复全量采集。**"审核形态"必须做成服务端下发的开关**，不能靠发版切换。
2. **初始化失败要上报**：广告 SDK 初始化失败往往静默（App 其他功能正常），没有留痕就永远不知道有一批用户的广告全挂了。该项目把失败结果上报到错误日志接口（`url = TobidInitError`），与后端日志对账。
3. **广告位 ID 集中管理**：所有广告位用 enum 收敛，双平台 ID 成对声明，杜绝散落硬编码（下例 ID 为**示意占位**，真实广告位 ID 属于商业配置，不落在文章里）：

```dart
enum TobidAdsPlacementID {
  splash(android: '9100000000000001', iOS: '9100000000000011'),
  reward1(android: '9100000000000002', iOS: '9100000000000012'),
  // reward2 / reward3 / reward4 ...
  native(android: '9100000000000003', iOS: '9100000000000013'),
  interstitial(android: '9100000000000004', iOS: '9100000000000014'),
  banner(android: '9100000000000005', iOS: '9100000000000015');

  final String android;
  final String iOS;
  String get value => Platform.isIOS ? iOS : android;
}
```

### 5. 开屏广告：一切设计围绕"别把用户卡在启动页"

开屏是时序最敏感的广告形态：它发生在 App 冷启动的关键路径上，任何一步卡住都直接伤害留存。该项目的开屏实现有三条铁律：

```dart
void _dispatchSplashByAuditMode() {
  if (AuditState.isEnabled) { // 审核形态开关（示意命名，服务端下发）
    _safeGoToView();        // 铁律 1：审核模式直接跳过广告
  } else {
    _loadTobidSplashAd();
  }
}

void _loadTobidSplashAd() {
  // 铁律 2：4 秒兜底超时，无论如何强制进首页
  _splashFallbackTimer?.cancel();
  _splashFallbackTimer = Timer(const Duration(seconds: 4), () {
    _safeGoToView();
  });

  _splashAd?.destroy();
  _splashAd = WindmillSplashAd(
    request: AdCommonManager().buildRequest(
      AdCommonManager().splashPlacementId,
    ),
    width: splashWidth,   // 用 platformDispatcher 实测逻辑分辨率
    height: splashHeight,
    listener: _SplashAdListener(
      onLoaded: (ad) async {
        try { await ad.showAd(); } catch (_) { _safeGoToView(); }
      },
      onFailed: (_) => _safeGoToView(),
      onOpened: () => _splashFallbackTimer?.cancel(),  // 展示成功才解除兜底
      onClosed: () => _safeGoToView(),
      onSkipped: () => _safeGoToView(),
      onShowError: (_) => _safeGoToView(),
    ),
  );
  _splashAd?.loadAd();
}
```

1. **审核模式跳过**：与初始化的审核形态联动；
2. **兜底超时先行**：Timer 在加载**之前**启动，`onOpened`（广告真正展示）才解除——加载慢、加载失败、展示失败、用户跳过，全部收敛到 `_safeGoToView()` 这一个出口。开屏代码评审就看一句话：**任何一个回调路径都能在有界时间内到达首页**；
3. **尺寸取实测值**：用 `platformDispatcher.views.first.physicalSize / devicePixelRatio` 计算逻辑分辨率传给 SDK，避免广告尺寸与容器不符导致的展示失败。

### 6. 激励视频：完整业务链路与错误状态机

激励视频（看广告 → 发奖励）是广告变现的主力形态，也是业务复杂度的主体。该项目的链路经过线上多轮迭代，值得完整拆解。

#### 6.1 全链路总览

```text
业务按钮点击
  → onForwardButtonTapped(advCount, advCountdown)
  → 资格校验（服务端）
  → 本地冷却检查
  → 免责弹窗
  → 用户点"浏览视频"
  → showNext(callType)
  → 4 个广告位轮换加载
  → SDK 回调
     → 发奖成功: onAdReward → 上报服务端 → 发放奖励
     → 广告关闭: onAdClosed → 业务方刷新页面
     → 加载/展示失败: 查错误文案 → 失败弹窗 → 上报错误日志
```

注意一个反直觉的设计：**真正触发广告加载的不是业务按钮，而是免责弹窗里的确认按钮**。业务按钮只负责走完前置检查；免责弹窗（告知用户"观看视频可获得奖励"）确认后才 `showNext`。这层弹窗既是合规需要（用户知情），也天然充当了广告加载前的确认门。

#### 6.2 前置三关卡

**关卡 1：资格校验（服务端）**。请求资格校验接口，按返回码分流（错误码语义由业务服务端约定，下表为示意结构）：

| 返回码 | 含义 | 处理 |
|--------|------|------|
| 0 | 允许观看 | 继续，同会话内缓存结果 |
| 业务约定码 A | App 版本过低 | 弹升级提示，终止 |
| 业务约定码 B | 不满足运营条件（如当日次数用尽） | 服务端下发提示文案，终止 |

资格判断放服务端而不是客户端，是因为"今天还能不能看、看了几次"是运营策略，必须可热更；具体的业务前置条件（账号状态、版本门槛等）都在这一层收敛，广告链路本身不感知业务规则。

**关卡 2：本地冷却**。服务端下发 `advCount`（次数上限）与 `advCountdown`（冷却秒数），客户端用本地保存的上次成功时间戳算剩余冷却，未到点弹倒计时提示。冷却基准时间戳在**发奖成功时**写入——以真实发奖为准，不以广告关闭为准。

**关卡 3：免责弹窗**。见上文。

#### 6.3 四广告位轮换

管理器初始化时创建 4 个激励广告实例（reward1~4 四个广告位 ID），展示时按 `hasShow == false` 取第一个：

```dart
Future<void> showNext({required TobidRewardCallType callType}) async {
  showLoading(); // 全局 loading（示意命名）
  // 4 个都展示过 → 全部重置，从第一个重新开始
  if (tobidRewards.every((e) => e.hasShow)) {
    for (var e in tobidRewards) { e.hasShow = false; }
    await tobidRewards.first.ad.loadAdData();
    return;
  }
  final item = tobidRewards.firstWhere((e) => !e.hasShow);
  item.callType = callType;
  await item.ad.loadAdData();
}
```

**为什么 4 个广告位轮换？** 同一个广告位连续展示会被联盟风控判定异常（填充下降甚至封位）；多广告位轮换让每次请求落在"新鲜"的位上，也天然分摊单联盟无库存的风险。`hasShow` 在 `onAdOpened`（真正展示）时置位——加载失败不算消耗。

#### 6.4 成功链路：发奖的时序

```text
onAdReward（SDK 判定完成激励条件）
  → 清空错误态：_errorMessage = null、关闭失败弹窗
  → manager._handleRewardCallBack(ad)
     → 播放成功音效
     → reportReward()：调发奖上报接口（带签名；scene 字段区分触发广告的业务场景，语义由服务端约定）
     → 保存本地成功时间戳（冷却基准）
onAdClosed（广告关闭）
  → _onAdClosed?.call()   // 业务方的页面刷新出口
```

两个关键设计：

1. **发奖上报以 `onAdReward` 为准，不以 `onAdClosed` 为准**。`onAdReward` 是 SDK 判定"用户看完了"的唯一信号；`onAdClosed` 只说明广告关了（可能没看完）。两者间还有一层保险：上报失败时拉服务器时间拼接"手机时间/服务器时间"的提示，在广告关闭时 toast 给用户——**发奖失败要让用户知道，而不是静默吞掉**。
2. **页面刷新是出口不是内置**。`onAdClosed` 回调暴露给业务方挂接（`manager.onAdClosed = () => 刷新方法`），管理器不内置任何页面刷新——通用能力与具体页面解耦。

#### 6.5 失败链路：双层错误处理

这一节和下一节（成功覆盖失败）是整条激励链路里**最有含金量的商业级优化**——大部分团队的第一版实现都是"error 就 toast 一句完了"，而线上事故与用户投诉几乎全部出在这两节覆盖的场景里。

失败分两类：`onAdFailedToLoad`（加载失败）与 `onAdShowError`（展示失败），走同一套处理，但**分两层**：

```text
recordErrorMsg(error)
  → 请求文案配置接口（示意：/api/config/error-copy，按 error.code + 平台）
  → 缓存三份信息：
     _errorMessage      → 给用户看的文案（接口失败时兜底 error.message）
     _latestErrorMessage → 最近一次错误（给外部调用方复用）
     _adDetailMessage    → error.toJson()，给后端日志用
showErrorAlert(code)
  → 仅 _isReward == false 时才弹（成功覆盖失败，见 6.6）
```

**日志上报不在这里发**，而是挂在错误弹窗的 `onDismiss`：用户关掉失败弹窗时，如果 detail 存在才上报错误日志接口（示意：`/api/log/error`，带 `url = RewardAdDetailError` 标记来源场景）。收到 error 但没弹窗（比如被成功覆盖）就不打这条日志——用户可见层和日志层是两条独立链路。

#### 6.6 成功覆盖失败：最容易写错的状态语义

激励广告的回调时序不止"要么成功要么失败"——SDK 可能先给 error、后面又给 reward（重试成功），也可能先 reward 后 error（关闭时异常）。该项目的语义规则：

**一旦 `onAdReward` 到达，按成功收口**：

- 立即清空 `_errorMessage`、关闭已弹出的失败弹窗（按 tag 关闭失败弹窗，弹窗库任选）
- `_isReward = true`——后续 `onAdClosed` 里再判一次，双保险关闭失败弹窗
- 失败弹窗只在 `_isReward == false` 时才允许弹出——"先成功后 error"永远不弹错误

按这个规则可推出完整的行为矩阵（也是该项目错误处理的验收标准）：

| 场景 | 时序 | 错误弹窗 |
|------|------|---------|
| 1 | 无广告，error | 弹 |
| 2 | 广告出现，先 error 后 reward | 先弹，reward 到达时主动关闭 |
| 3 | 广告出现，先 reward 后 error | 不弹 |
| 4 | 广告出现，无 reward 无 error，用户关广告 | 不弹 |
| 5 | 广告出现，无 reward，中途 error，用户关广告 | 弹 |

**一个如实记录的边界**：失败弹窗的日志上报挂在 `onDismiss` 上，如果弹窗已经展示、随后被成功回调关闭，`onDismiss` 仍会触发——即"先 error 后 reward"场景下，`RewardAdDetailError` 日志可能照打（用户侧已按成功收口，日志层多一条失败记录）。这是目标语义（成功完全覆盖失败）与当前实现之间的已知差距，修法是把上报条件改为 `!_isReward`——记录在此，说明**"用户可见层"和"日志层"的清理时机必须分开评审**。

#### 6.7 对外激励 API：Completer 化与超时防挂起

除了内部业务调用，管理器还对外暴露 Future 化的激励接口（`callType: external`），供任意业务模块"看广告拿结果"。这个包装有三个防挂起设计：

```dart
// 示意伪代码：对外激励接口的骨架
Future<YQBaseResModel<bool>> showExternalReward() {
  final completer = Completer<YQBaseResModel<bool>>();
  final requestId = _nextExternalRewardRequestId(); // 自增种子 + 时间戳

  // 1. 超时熔断：15 秒没 onAdOpened 就按失败收口
  _scheduleExternalRewardTimeout(requestId, completer);

  // 2. requestId 防串扰：回调只认"当前请求"的广告实例
  _activeExternalRewardRequestId = requestId;

  // 3. 所有终态（reward/closed/failed/showError/timeout）
  //    统一走 _finishExternalReward，幂等（completer 已完成则跳过）
  ...
  return completer.future;
}
```

1. **超时熔断**：广告 SDK 的回调没有可靠性保证——加载卡死、回调丢失都真实发生过。超时器兜底保证调用方的 Future 一定在有限时间内完成。这个超时该项目的迭代史是 **8 秒 → 15 秒**：线上发现部分低端机冷启动后首次广告加载超过 8 秒，误判为失败——**超时阈值的依据是线上分位数，不是拍脑袋**；
2. **requestId 防串扰**：多个广告位实例共享状态流，用"当前请求 ID + 广告位 ID"双重匹配，避免把上一个请求的回调错配给当前调用方；
3. **Completer 幂等**：所有终态收敛到一个 finish 函数，已完成直接 return——奖励回调与关闭回调几乎同时到达时不会二次 complete 崩溃。

#### 6.8 服务端接口清单

激励链路最少依赖 5 个服务端接口（迁移/重构时的核对清单；路径为示意占位，按自己的服务端约定替换）：

| 接口（示意路径） | 用途 |
|------|------|
| `POST /api/ad/qualify` | 资格校验（错误码分流） |
| `POST /api/ad/reward-callback` | 发奖上报（scene 区分业务场景） |
| `POST /api/system/time` | 上报失败时拼服务器时间提示 |
| `POST /api/config/error-copy` | 按错误码查用户可见文案 |
| `POST /api/log/error` | 错误日志留痕（init 失败/激励失败两用） |

文案走服务端配置是刻意设计：联盟错误码对用户不可读，运营要能随时调整话术，而不是等发版。

### 7. 原生信息流：PlatformView 时序坑（经典）

这是该项目排查时间最长的一个坑，值得完整复盘。

**现象**：测试页点"加载信息流"，状态显示"加载成功，等待渲染"，但广告区域永远空白；Banner 和激励视频都正常，仅原生信息流异常。

**排查链路**：原生信息流是 Dart Widget（`NativeAdWidget`，PlatformView 包装）→ Android 原生 View（`showAd` 渲染）两层。日志显示 `loadAd` 成功、`onAdLoaded` 回调到达，但 `onRenderSuccess` 永远不来。

**根因：PlatformView 的创建时机早于广告加载，且不会自动重试**：

```text
initState
  → NativeAdWidget 挂进 widget 树
  → build 创建 PlatformView
  → 原生构造函数立即调 showAd()
  → 此时还没 loadAd，广告数据为 null → 原生层 NPE 被 PlatformView 框架吞掉
  → 返回空容器
点击"加载信息流"
  → loadAd 成功、数据填充
  → 但 creationParams 没变，PlatformView 不会重建
  → showAd 不会再执行 → 永远不渲染
```

**为什么 Banner 不受影响**：Banner 的 `showAd` 只是放一个空容器视图，不依赖广告数据，SDK 加载完成后自己渲染进去；原生信息流的 `showAd` 必须拿到广告数据才能把数据绑定到视图——**时序不可逆**。

**修复**：只改调用方时序，不动插件——把 `NativeAdWidget` 的挂载推迟到 `onLoaded` 回调之后：

```dart
// ❌ 错误：加载前就挂载
void _prepareNativeAd() {
  final ad = WindmillNativeAd(placementId: ...);
  setState(() {
    _nativeAd = ad;
    _nativeWidget = NativeAdWidget(nativeAd: ad, ...); // 提前挂载 → 永不渲染
  });
}

// ✅ 正确：onLoaded 之后再挂载
void _prepareNativeAd() {
  final ad = WindmillNativeAd(
    placementId: ...,
    onLoaded: () {
      if (!mounted) return;
      setState(() {
        _nativeWidget = NativeAdWidget(nativeAd: ad, ...); // 数据就绪才创建
      });
    },
  );
  ad.loadAd();
}
```

**通用教训**：任何"依赖异步数据"的 PlatformView，都要保证**首次创建时数据已就绪**——PlatformView 的生命周期由 widget 树驱动，`creationParams` 不变就不会重建，你没有第二次机会。这条教训适用于地图、WebView 预注入、原生播放器等一切同构场景。

### 8. 信息流广告进列表：滚动感知加载与状态缓存

单体信息流跑通只是第一步，真正的战场是把它嵌进业务列表（商品流/内容流）——列表有滚动、有回收重建、有快速划过，直接把第 7 节的单体用法塞进 `ListView.builder` 会在体验和数据两头翻车。该项目的列表版组件沉淀了五个优化，每个都对应一类线上问题：

#### 8.1 滚动感知：滚动中不加载、停不稳不加载

`ListView` 把共享的 `ScrollController` 传给每个广告组件，组件监听它做**防抖判定**：

```dart
// 示意伪代码：滚动防抖核心
void _onScroll() {
  if (!isScrolling) setState(() => isScrolling = true); // 滚动中：只显示占位符
  _scrollIdleTimer?.cancel();
  _scrollIdleTimer = Timer(scrollIdleDelay, () {        // 默认 300ms 防抖
    setState(() => isScrolling = false);
    _checkAndLoadAd();                                  // 停稳后才开始加载
  });
}
```

**为什么要卡滚动**：快速滑动时列表项转瞬即逝——此刻发起加载是纯浪费（联盟按请求算填充，加载出来的广告一划而过没人看，还可能白白消耗掉一次曝光机会）；更糟的是列表回收会引发 PlatformView 创建/销毁风暴，滚动中加载直接叠加渲染 jank。300ms 防抖则避免把惯性滚动末端的微动误判为"停稳"。

#### 8.2 按索引的加载状态缓存：回收重建不打散已成功的广告

`ListView.builder` 的 item 随滚动被回收重建，而广告实例和"这个位置已经成功加载过"的事实不应该跟着销毁。用一张静态表按列表索引记录结果：

```dart
// 示意伪代码：索引级加载缓存
class _AdLoadCache {
  static final Map<int, bool> _loaded = {};
  static bool isLoaded(int index) => _loaded[index] ?? false;
  static void mark(int index, bool ok) => _loaded[index] = ok;
}
```

- 加载成功 → 组件重建时查缓存直接跳过重复加载（配合 `ValueKey('ad_$index')` 稳定标识）；
- 加载/展示失败 → 清除标记，下次停稳允许重试；
- 缓存是静态的，跨页面复用同一列表时注意提供 `clearCache()` 出口。

#### 8.3 三态占位与"失败即折叠"

渲染侧的三态设计，目标只有一个——**列表不跳动**：

| 状态 | 渲染 | 高度 |
|------|------|------|
| 滚动中 / 加载中 / 兜底 | shimmer 占位 | 预留 `height`（默认占位高度） |
| 加载成功 | `NativeAdWidget`（真实广告） | `onAdOpened` 后 `getAdSize()` 拿真实尺寸，`AnimatedContainer` 300ms 过渡 |
| 失败 / 被关闭 | `SizedBox.shrink()` | **折叠为 0** |

"失败即折叠"是容易被忽略的细节：加载失败的广告位如果保留占位高度，用户会看到一条永久的空白缝——所以组件不仅折叠自身，`marginTop` 也只在加载成功时才生效。广告的失败率是常态（某联盟无库存很常见），列表的视觉密度不能被它拖垮。

#### 8.4 挂载时序：把第 7 节的教训做成组件默认行为

列表组件里 `shouldMountNativeAd` 只在 `onAdLoaded` 之后置 true、`NativeAdWidget` 才创建——这正是第 7 节 PlatformView 时序结论的组件化落地。该项目的实现注释里还点破了一个衍生坑：**模板广告需要先挂载 `NativeAdWidget` 才会进入原生渲染，不能被 SDK `isReady()` 的即时返回值拦截**——`isReady()` 为 false 不代表这个广告渲染不出来，别用它做挂载门条件。

#### 8.5 曝光上报交给插件的可见性检测

联盟计费依赖**真实曝光**（广告进入视口才算），插件的 `NativeAdWidget` 内部用 `visibility_detector` 做可见性上报（并调整了 `VisibilityDetectorController.updateInterval`），业务侧不需要自己埋曝光。这意味着快速划过的广告不会计费曝光——与 8.1 的"滚动中不加载"在商业逻辑上也是自洽的：不加载就不会有"加载了但没人看"的浪费。

#### 8.6 列表插入策略

测试页的用法是工程上的最小样板：

```dart
ListView.builder(
  controller: _scrollController,      // 共享给广告组件做滚动判定
  itemCount: 10,
  itemBuilder: (context, index) {
    if (index == 2 || index == 6) {   // 固定间隔插入广告位
      return TobidListNativeWidget(
        key: ValueKey('list_native_ad_$index'),  // 稳定 key
        scrollController: _scrollController,
        listIndex: index,             // 对应 8.2 的索引缓存
        height: 420.px,
      );
    }
    return const NormalListItem(index: index);
  },
);
```

三个要点：**固定间隔**（生产环境间隔通常由运营配置下发而非写死）、**稳定 ValueKey**（重建后缓存能对上号）、**共享 scrollController**（多个广告位共用一份滚动监听，不各自 attach）。

### 9. iOS Modal 场景：本地补丁与补丁管理纪律

**现象**：普通页面拉激励广告正常；但页面上已存在一个由 iOS `present` 弹出的 Modal 控制器时，激励广告无法展示。

**根因**（在本地插件的 OC 源码里找到）：插件把"当前展示的 VC"传给 SDK 用于 present 广告，其查找链路 `_findCurrentShowingViewControllerFromVC` 递归算出了正确的 `currentVC`（穿透 Navigation/TabBar/Modal 层级），**但最后一行返回了方法入参 `vc`**——递归白算，SDK 拿到的是错误的展示控制器。

**补丁**：一行改动：

```objc
// plugins/tobid5550/ios/Classes/Core/WindmillUtil.m
-    return vc;
+    return currentVC;
```

**补丁管理的纪律**（本地插件的核心配套，比补丁本身更重要）：

1. **独立文档记录**：改动文件、改动行、验证状态、回退方式（把那行改回去即可，不连带其他）全部落档；
2. **升级核对清单**：SDK 升级时先对比新版该函数实现——上游已修则删补丁，未修且问题仍在则先在独立 demo 复现再与广告商确认，**绝不机械套用**；
3. **回归范围**：补丁后必须覆盖普通页面、Modal、Navigation Push、广告关闭后原页面可操作、连续多次拉起无残留 VC 五个场景——展示控制器的选择影响所有广告形态，不能只验激励。

### 10. 测试基建：广告专用测试页

该项目为广告单独建了测试页（路由 `/test_pages/tobid_ads`，约 700 行）：开屏/激励/信息流/Banner/插屏五种形态各有独立的加载、展示、销毁按钮与状态流水。配套约定：

- 测试入口做成**悬浮按钮，release 构建自动隐藏**（`kReleaseMode` 判断）——既保证测试页永远可用，又不泄漏给线上用户；
- 悬浮按钮只放在特定页面（商城首页）而不是全局 Overlay，避免遮挡所有页面。

这套基建的价值在排坑时兑现：第 7 节的信息流时序问题、第 8 节的列表进阶与第 9 节的 Modal 问题，都是在测试页先稳定复现、再定位到根因的。**接入广告 SDK 的第一件事不是写业务，是把每种形态的测试页跑通**——它是后续所有排坑的前置条件。

---

## 常见坑

### 1. 原生信息流加载成功但不渲染

**场景**：`onLoaded` 回调到达，广告区域空白，反复重建无效。
**根因**：PlatformView 在广告数据就绪前创建，原生 `showAd` 拿到 null 数据 NPE 被吞；`creationParams` 不变导致加载成功后也不会重建。
**解决**：`onLoaded` 之后再挂载 `NativeAdWidget`（见第 7 节）。

### 2. iOS Modal 页面激励广告拉不起

**场景**：普通页面正常，present 弹出的 Modal 内无法展示激励广告。
**根因**：插件查找当前 VC 的函数递归结果没有返回，SDK 收到错误展示控制器。
**解决**：本地插件打一行补丁 `return currentVC`，并按补丁纪律记录与回归（见第 9 节）。

### 3. 对外激励 Future 永远不完成

**场景**：业务方 await 激励广告结果，偶发永久挂起。
**根因**：SDK 回调丢失（加载卡死/回调异常），没有超时兜底。
**解决**：Completer 包装 + 超时熔断 + requestId 防串扰 + finish 幂等（见 6.7 节）；超时阈值用线上分位数定，该项目从 8 秒调到 15 秒。

### 4. 先失败后成功的弹窗残留

**场景**：失败弹窗已弹出，随后激励成功，但用户还是看到了（或日志层多打了）失败记录。
**根因**：错误清理只做了用户可见层；日志上报挂在弹窗 `onDismiss`，被成功关闭时仍触发。
**解决**：`onAdReward` 立即清错误态 + 关弹窗；弹窗只在 `_isReward == false` 时弹；日志上报加同样的条件（见 6.6 节的边界讨论）。

### 5. 构建期依赖冲突连环爆

**场景**：引入聚合插件后 Gradle 构建失败，报 androidx 版本冲突 / Manifest merger 错误 / Support 库冲突。
**解决**：四件套——AGP 版本对齐插件构建链、`enableJetifier`、`resolutionStrategy` 统一 androidx、`tools:replace` 处理 manifest 冲突（见第 3 节，可直接对照排查）。

### 6. 审核期间被拒：广告 + 隐私采集组合拳

**场景**：提审被拒，理由涉及广告展示与个人信息收集。
**解决**：审核形态做成服务端开关——审核模式下跳过开屏等广告展示、`setCustomDevice` 关闭应用列表/定位/IDFA 等采集项（见第 4、5 节）；过审后恢复。

### 7. 开屏把用户卡在启动页

**场景**：广告加载慢或回调异常，用户停在开屏页无法进入。
**解决**：兜底 Timer 先于加载启动，所有回调路径（成功/失败/跳过/展示错误）收敛到同一个"进首页"出口，`onOpened` 才解除兜底（见第 5 节）。

### 8. 广告位 ID 散落硬编码

**场景**：ID 写在各页面里，双平台各一份，换广告位要全局搜索替换。
**解决**：enum 集中管理，双平台 ID 成对声明，`Platform.isIOS` 取值封装成 getter（见第 4 节）。

### 9. 列表滚动中加载信息流广告

**场景**：信息流广告塞进 `ListView` 后，快速滑动时列表卡顿、广告位反复加载又划走、停止后出现空白缝。
**根因**：滚动中发起加载既浪费请求（划过即弃）又叠加 PlatformView 创建/销毁风暴；item 回收重建把已成功的广告状态打散；失败的广告位保留占位高度留下永久空白。
**解决**：滚动感知（300ms 防抖，停稳才加载）+ 索引级加载缓存 + 失败即折叠（见第 8 节，三个优化各对应一类症状）。

---

## 面试追问

### 1. 为什么用聚合 SDK 而不是直接接穿山甲/优量汇？

**要点**：填充率与 eCPM——单联盟无库存时请求浪费，聚合层做 Bidding（实时竞价）+ Waterfall（瀑布兜底）混调；聚合还统一了多联盟的接入/数据/计费口径。能展开：选型时看国内联盟覆盖、Flutter 插件完整度、后台数据能力；再深一层的决策是**集成方式**——本地插件换来补丁能力，代价是 fork 维护成本。

### 2. 激励视频的完整链路怎么设计？

**要点**：前置三关卡（服务端资格校验做错误码分流、本地冷却以发奖成功为基准、免责弹窗做确认门）→ 多广告位轮换（防联盟风控、分摊无库存风险，`onAdOpened` 才算消耗）→ 发奖以 `onAdReward` 为准（`onAdClosed` 可能没看完）→ 上报失败要暴露给用户（拉服务器时间拼提示）→ 页面刷新做成出口暴露给业务方而不是内置。加分项：对外 Future 化 API 的超时熔断 + requestId 防串扰 + 幂等收口。

### 3. 广告的错误处理为什么要分两层？

**要点**：用户可见层（服务端配置文案，运营可热更话术）与日志层（`error.toJson()` 上报后端，排障用）关注点不同、清理时机也不同——"成功覆盖失败"必须两层分别评审，只清用户层会留下日志层的误报（先 error 后 reward 场景）。能背出 5 场景错误弹窗矩阵是硬通货。

### 4. 原生信息流"加载成功但不渲染"怎么排查？

**要点**：先分层（Dart widget / PlatformView / 原生渲染），日志定位到 `onAdLoaded` 到了但 `onRenderSuccess` 不到；根因是 PlatformView 创建时机早于数据就绪，且 `creationParams` 不变不重建、原生 NPE 被框架吞掉。修复是把挂载推迟到 `onLoaded`。通用化：依赖异步数据的 PlatformView 都适用"数据就绪再创建"。

### 5. 广告 SDK 出 bug 怎么办？

**要点**：本地插件化是前提——一行补丁当天解决（iOS Modal VC 查找示例）；配套纪律是独立文档记录改动与回退方式、升级时先对比上游实现（已修删补丁/未修先 demo 复现）、五场景回归。没有本地插件就只能等官方排期。

### 6. 审核与合规在广告侧怎么做？

**要点**：审核形态是服务端开关——审核期跳过开屏等广告、`setCustomDevice` 收紧隐私采集；初始化失败上报留痕；错误文案走服务端配置。再展开：广告类 App 的合规清单（隐私政策披露广告 SDK、个性化推荐关闭开关、未成年人保护）与商店审核的高频拒审点。

### 7. 信息流广告嵌进列表，你会做哪些优化？

**要点**：五个优化各对应一类线上问题——滚动感知加载（300ms 防抖，滚动中不请求：划过即弃是浪费，还叠加 PlatformView 创建销毁风暴）；索引级加载缓存（builder 回收重建不打散已成功广告，配合稳定 ValueKey）；三态占位与失败即折叠（shimmer 占位防列表跳动、`getAdSize()` 真实高度动画过渡、失败折叠为 0 不留空白缝）；挂载时序组件化（`onAdLoaded` 后才挂 `NativeAdWidget`，且不能用 SDK `isReady()` 当挂载门）；曝光上报交给插件的可视性检测（快速划过不计曝光，商业逻辑与"滚动不加载"自洽）。能讲出"每个优化对应什么症状"是加分项。

---

## 参考资源

- [Sigmob / ToBid 开发者平台](https://www.sigmob.cn/)（Windmill SDK 文档，以官网为准）
- [穿山甲（CSJ）开发者平台](https://www.csjplatform.com/)（联盟侧文档）
- [优量汇广告开发者平台](https://adnet.qq.com/)
- [工信部 App 备案与个人信息合规要求](https://www.miit.gov.cn/)
