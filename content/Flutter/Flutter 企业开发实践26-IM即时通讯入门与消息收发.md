---
title: Flutter 企业开发实践26-IM即时通讯入门与消息收发
date: 2026-08-23
tags: [Flutter, IM, 即时通讯, 腾讯云 Chat, TUIKit, 架构, 面试]
---

# IM 即时通讯入门与消息收发

> 本篇是 IM 系列的基础篇：把 Tencent Cloud Chat 接进 Flutter 混合工程的完整路径——SDK 初始化、UserSig 登录、状态机、监听器生命周期、会话列表与聊天页、未读数、消息音效。结论一句话：IM 接入的复杂点不在 SDK 调用本身，而在登录状态机、监听器生命周期和未读数这三条生命线，源码里有七处容易写坏它们的坑，本篇逐个给出修正。红包自定义消息在 28 篇，好友体系与群管理在 27 篇。

---

## 一、为什么要用 IM SDK

聊天不是一个"客户端连上服务端"就完事的协议，它是一组叠加的需求：

- 在线消息实时到达，离线消息不丢、可漫游（换设备还能拉到历史）。
- 消息有全局有序性，客户端要能处理乱序与重复。
- 未读数、已读回执、撤回、正在输入等状态同步。
- 群聊的消息扩散、成员管理、禁言与权限。
- 多端同步：同一账号手机、平板、Web 同时在线。

逐项自建的成本可以列一张表：

| 能力 | 自建 socket/轮询 | 商业 IM SDK（Tencent Cloud Chat） |
|---|---|---|
| 长连接 | 自行保活、断线重连、心跳探测 | 内置连接管理与重连 |
| 消息顺序与去重 | 自行设计 seq/ack/重传协议 | 平台保证 |
| 离线消息与历史漫游 | 自建存储与拉取协议 | 内置，默认保存 7 天 |
| 已读回执 | 自建回执通道 | 内置（C2C） |
| 群聊扩散 | 自研广播与成员路由 | 内置 |
| 多端同步 | 自建同步位点 | 内置 |
| 安全 | 自行做鉴权与加密 | UserSig 鉴权 + TLS |
| 团队投入 | 协议栈长期维护 | 接入期投入，升级由 SDK 版本承担 |

轮询方案还有一个隐藏代价：为了"看起来实时"，客户端高频轮询，流量与电量持续消耗；消息间隔越短，轮询越接近长连接，而长连接本身就是最难自建的部分。

结论：社交类核心链路直接选成熟 IM SDK。本系列工程的选择是 Tencent Cloud Chat SDK 8.x + TUIKit 4.x（本地 fork），把协议栈和大部分 UI 复用掉，业务只保留登录、门禁、自定义消息这类自己的边界。对 IM 消息推送的离线到达率问题，见下文第六节与 09/10 推送篇的衔接说明。

## 二、接入前准备

### 2.1 依赖与版本

`pubspec.yaml` 中的依赖：

```yaml
tencent_cloud_chat_sdk: ^8.6.7019+5
tencent_cloud_chat_uikit:
  path: packages/tencent_cloud_chat_uikit-4.0.8
```

SDK 与 TUIKit 分两个包：SDK 提供底层能力（`V2TIMManager` 及各 Manager），TUIKit 提供开箱即用的会话列表、聊天页等组件。TUIKit 走本地 fork（4.0.8），因为红包、摘要等能力需要改组件内部交互，见 28 篇第 3 节。fork 意味着每次升级要做定向回归。

### 2.2 SDKAppID 只放在客户端

SDKAppID 不是密钥，它只标识应用，可以明文放客户端：

```dart
// fake_docs/configs/third_party_config.dart
static const int tencentIMAppId = 1234567890; // FAKE_SDK_APP_ID_FOR_DOCS
```

真正的凭证是 UserSig。UserSig 由服务端用密钥签发，客户端只有签发结果；把密钥放进 App，等于把任意身份的签发权交给攻击者。这是接入 IM 的第一条安全底线。

### 2.3 UserSig 由业务服务端签发

工程里登录所需凭证来自业务接口：

```dart
// fake_docs/network/api_paths.dart
static const fakeDocsRefreshUserSig = "/api/fake/im-user-sig-refresh";
```

响应模型只有两个字段（`fake_docs/pages/chat/models/im_login_info_model.dart`）：

```dart
class ImLoginInfoModel {
  String? info; // userID
  String? sign; // userSig
}
```

关键设计：IM 的 userID 不是平台用户 ID，而是"邀请码"。源码注释写明"聊天的 info 是邀请码"，登录与自定义消息里到处以 `User.inviteCode` 作为 IM 身份。理由：邀请码本身就是用户在平台内公开、唯一、稳定的标识，IM 侧用它与业务侧用它能对齐同一套身份体系。

### 2.4 三层架构

```text
页面与业务层
├── 会话列表页 ChatHomeView（TIMUIKitConversation、未读标题、签到门禁）
├── 聊天页 ChatView（TIMUIKitChat、自定义消息 Builder）
└── 顶层 Tab 栏（未读角标）
            │
IM 适配层（ImManager 单例 + ImState）
├── 初始化、登录状态机、UserSig 生命周期
├── 会话/好友/消息三类监听器
├── 未读数、消息音效
└── 错误码统一 toast
            │
基础设施层
├── Tencent Cloud Chat SDK 8.x（tencent_cloud_chat_sdk）
├── TUIKit 4.0.8 本地 fork（tencent_cloud_chat_uikit）
└── 业务服务端（签发 UserSig、签到门禁等业务接口）
```

页面层不直接持有 SDK 单例，统一通过 `ImManager` 单例（`fake_docs/sdk_manager/im_manager/im_manager.dart`）访问：

```dart
class ImManager {
  bool _isInit = false;
  static final ImManager _instance = ImManager._();
  factory ImManager() => _instance;

  final CoreServicesImpl _coreInstance = TIMUIKitCore.getInstance();
  final V2TIMManager _v2TIMManager = TIMUIKitCore.getSDKInstance();

  final state = ImState(); // 登录状态、未读数等响应式状态
}
```

`ImState`（`fake_docs/sdk_manager/im_manager/im_state.dart`）是 GetX 响应式状态：

```dart
enum ImLoginStatus { normal, onLogin, success, failed }

class ImState {
  final totalUnReadMsg = 0.obs;   // 消息未读数
  final friednAddCount = 0.obs;   // 好友申请未读数（字段名拼写为源码原样）
  final status = ImLoginStatus.normal.obs;
  String userID = "";
  String userSig = "";
  int retryCount = 0;

  void clearData() {
    status.value = ImLoginStatus.normal;
    userID = "";
    userSig = "";
    totalUnReadMsg.value = 0;
    friednAddCount.value = 0;
  }
}
```

适配层单例 + 响应式状态，是页面与 SDK 之间唯一的桥：页面订阅状态，SDK 回调写状态，两端互不直接依赖。

## 三、初始化

### 3.1 初始化代码

`ImManager._initSetupIM()`（`fake_docs/sdk_manager/im_manager/im_manager.dart`）：

```dart
Future _initSetupIM() async {
  try {
    if (_isInit) {
      return;
    }
    final result = await _coreInstance.init(
      sdkAppID: ThirdPartyConfig.tencentIMAppId,
      language: LanguageEnum.zhHans,
      loglevel: kDebugMode
          ? LogLevelEnum.V2TIM_LOG_DEBUG
          : LogLevelEnum.V2TIM_LOG_NONE,
      onTUIKitCallbackListener: _handlerErrorCallbackValue,
      listener: V2TimSDKListener(
        /// 签名过期
        onUserSigExpired: () async {
          final imSignKey = StorageKeys.imSignKey();
          await GetStorage().remove(imSignKey);
          AppLogger.i("IM签名过期，重新请求");
          state.clearData();
          _v2TIMManager.getConversationManager().removeConversationListener();
          _v2TIMManager.getFriendshipManager().removeFriendListener();
          _v2TIMManager.getMessageManager().removeAdvancedMsgListener();
          _onUserSigExpired();
        },
        /// 被踢下线
        onKickedOffline: _onKickedOffline),
    );
    coreInstance.setTheme(
        theme: const TUITheme(
            primaryColor: AppColors.blue1,
            appbarTextColor: AppColors.black1A,
            weakDividerColor: AppColors.whiteF5));
    AppLogger.i("IM初始化：${result}");
  } catch (e, s) {
    AppLogger.e("IM初始化错误:$e", s);
  }

  /// 注册IM内部回调
  TIMUIKitCore.registerExternalFunction(
    permissionFunction: AppPermission.check,
  );
  _isInit = true;
  return _isInit;
}
```

各部分职责：

| 参数/调用 | 说明 |
|---|---|
| `sdkAppID` | 2.2 节的常量，标识应用 |
| `language: LanguageEnum.zhHans` | 文案中文化 |
| `loglevel` | debug 包开 `V2TIM_LOG_DEBUG`，生产包 `V2TIM_LOG_NONE`，避免正式包刷日志 |
| `onTUIKitCallbackListener` | TUIKit 内部错误统一回调，见 3.2 |
| `V2TimSDKListener` | SDK 级事件：UserSig 过期、被踢下线 |
| `setTheme` | 主题色、导航栏文字色、分割线色 |
| `registerExternalFunction` | 把权限请求委托给业务统一的 `AppPermission.check`（录音、相册等） |

`_isInit` 保证初始化只执行一次（幂等）；`onUserSigExpired` 回调里清缓存、清状态、移除监听器后重新走 `_onUserSigExpired` 拉新凭证，这条链路在第四节展开。

### 3.2 错误码统一出口

`onTUIKitCallbackListener` 收到的 `TIMCallback` 交给 `_handlerErrorCallbackValue`：

```dart
void _handlerErrorCallbackValue(TIMCallback callbackValue) {
  final errorCode = callbackValue.errorCode ?? 0;
  if (IMErrorCodeToast.filterCodeList.contains(errorCode)) {
    return;
  } else if ((callbackValue.errorMsg?.startsWith("group_read_sequence") ??
          false) &&
      callbackValue.errorCode == 6017) {
    /// 特殊处理的，解散群组时，会导致群组刷新，然后去获取群成员信息，导致的报错，可以直接过滤掉
    return;
  }
  if (callbackValue.errorCode != 0 && callbackValue.errorCode != 6015) {
    if (callbackValue.infoRecommendText != null &&
        callbackValue.infoRecommendText!.trim().isNotEmpty) {
      IMErrorCodeToast.showToast(callbackValue.errorCode,
          infoRecommendText: callbackValue.infoRecommendText);
      return;
    }
    IMErrorCodeToast.showToast(callbackValue.errorCode);
  }
}
```

三层过滤：`filterCodeList` 里的高频噪声错误码（网络类 95xx、本地 IO 类等）直接丢弃；6017 且错误信息以 `group_read_sequence` 开头的是"解散群组时残留请求"的已知噪声，单独过滤；其余错误优先展示 `infoRecommendText`，否则查 `IMErrorCodeToast` 的 `_errorTips` 映射表（20012/20049 禁言提示等）弹 toast。错误码统一走这一处，页面不用各自处理（禁言、群相关错误码的细分见 27 篇）。

### 3.3 坑：初始化失败也认为已初始化

脱敏示例在 `try-catch` 之后无条件执行 `_isInit = true;`。

风险：fork 的 `TIMUIKitCore.init` 返回 `Future<bool?>`——`true` 成功、`false` 失败（FAKE fork `core_services_implements.dart` 中 init 内部 `initSDK` 后 `result.code == 0 ? true : false`）。初始化失败（如网络问题导致 SDK 资源加载失败）时 `_isInit` 仍被置位，后续 `imLogin` 会跳过初始化直接登录，在未初始化状态下运行，报错定位成本极高。

修正：只在 init 明确成功后置位，setTheme 与 registerExternalFunction 也放进成功分支：

```dart
Future _initSetupIM() async {
  if (_isInit) {
    return;
  }
  final result = await _coreInstance.init(
    sdkAppID: ThirdPartyConfig.tencentIMAppId,
    language: LanguageEnum.zhHans,
    loglevel: kDebugMode
        ? LogLevelEnum.V2TIM_LOG_DEBUG
        : LogLevelEnum.V2TIM_LOG_NONE,
    onTUIKitCallbackListener: _handlerErrorCallbackValue,
    listener: V2TimSDKListener(
      onUserSigExpired: _onUserSigExpired,
      onKickedOffline: _onKickedOffline,
    ),
  );
  if (result != true) {
    AppLogger.e("IM初始化失败");
    return; // _isInit 保持 false，下次调用会重试
  }
  coreInstance.setTheme(
      theme: const TUITheme(
          primaryColor: AppColors.blue1,
          appbarTextColor: AppColors.black1A,
          weakDividerColor: AppColors.whiteF5));
  TIMUIKitCore.registerExternalFunction(
    permissionFunction: AppPermission.check,
  );
  _isInit = true;
}
```

## 四、登录状态机与 UserSig 生命周期

### 4.1 状态机

登录用四个状态而不是一个布尔值：

```dart
enum ImLoginStatus { normal, onLogin, success, failed }
```

`normal`（未登录/已清空）→ `onLogin`（登录中，防并发）→ `success` / `failed`。

### 4.2 imLogin 脱敏示例

`ImManager.imLogin()`（`fake_docs/sdk_manager/im_manager/im_manager.dart`）：

```dart
/// 6206: "UserSig 过期",
/// 70013: '无效的userSig，请重新获取',
/// 70014: 'userSig已过期，请重新登录',
/// 70016: 'userSig与userID不匹配',
/// 70017: 'userSig无效，请重新获取',
List<int> sigExpCodeList = [6206, 70013, 70014, 70016, 70017];

Future imLogin({required String userID, required String userSig}) async {
  await _initSetupIM();
  if (userID.isEmpty || userSig.isEmpty) {
    return;
  }
  if (User.accessToken == null || User.accessToken!.isEmpty) {
    return;
  }

  state.userID = userID;
  state.userSig = userSig;
  if (state.status.value == ImLoginStatus.onLogin) {
    return;
  }

  state.status.value = ImLoginStatus.onLogin;
  V2TimCallback res =
      await _coreInstance.login(userID: userID, userSig: userSig);
  AppLogger.i("IM登录结果:${res.toJson().toString()} 重试次数:${state.retryCount}");
  if (res.code == 0) {
    state.status.value = ImLoginStatus.success;
    _addMsgListen();
  } else if (sigExpCodeList.contains(res.code)) {
    final imSignKey = StorageKeys.imSignKey();
    await GetStorage().remove(imSignKey);
    AppLogger.i("IM签名过期或者错误，重新请求");
    state.clearData();
    _onUserSigExpired();
  } else {
    if (state.retryCount >= 3) {
      state.status.value = ImLoginStatus.failed;
      return;
    }
    await Future.delayed(const Duration(seconds: 5));
    state.retryCount = state.retryCount += 1;
    return imLogin(userID: userID, userSig: userSig);
  }
  return;
}
```

路径拆解：

- 前置校验：userID/userSig 为空直接返回；业务登录态 `accessToken` 为空直接返回——IM 登录跟着业务登录走，业务没登录不碰 IM。
- 并发防护：状态已是 `onLogin` 直接返回，避免重复发起登录。
- 成功：置 `success`，注册三类监听器（第五节）。
- 签名类错误码（6206/70013/70014/70016/70017）：清缓存、`clearData()` 回到 `normal`，走 `_onUserSigExpired` 重拉凭证。
- 其他错误（网络等）：`retryCount >= 3` 置 `failed`，否则等 5 秒后重试。

### 4.3 坑：递归重试被状态机自身拦截

脱敏示例的失败分支是递归调用 `return imLogin(...)`，而 `imLogin` 开头有 `if (state.status.value == ImLoginStatus.onLogin) return;`。状态在进入登录前就置为 `onLogin`，所以递归进来的新一层 `imLogin` 会在第一行直接返回——看似有重试计数，实际一次都不会重试，网络抖动时登录就停在 `onLogin` 上不动了。

风险：重试逻辑形同虚设，失败即卡死；`retryCount` 只在重试成功后（下次调用时被 `_onUserSigExpired` 清零）才有意义，递归路径上它永远不会超过 1。

修正示意（伪代码）：把重试改成有上限的 for 循环，状态只置位一次：

```dart
Future imLogin({required String userID, required String userSig}) async {
  await _initSetupIM();
  if (userID.isEmpty || userSig.isEmpty) return;
  if (User.accessToken == null || User.accessToken!.isEmpty) return;
  if (state.status.value == ImLoginStatus.onLogin) return;

  state.status.value = ImLoginStatus.onLogin;
  const maxRetry = 3;

  for (var retry = 0; retry <= maxRetry; retry++) {
    final res = await _coreInstance.login(userID: userID, userSig: userSig);
    if (res.code == 0) {
      state.status.value = ImLoginStatus.success;
      _addMsgListen();
      return;
    }
    if (sigExpCodeList.contains(res.code)) {
      // 签名类错误不重试，回到 normal，清缓存重拉凭证
      state.clearData();
      await GetStorage().remove(StorageKeys.imSignKey());
      _onUserSigExpired();
      return;
    }
    if (retry < maxRetry) {
      await Future.delayed(const Duration(seconds: 5));
    }
  }
  state.status.value = ImLoginStatus.failed;
}
```

循环重试还有一个好处：每种失败路径的状态迁移都在同一函数内可见，可读性和可测试性都好于递归。

### 4.4 UserSig 过期与重拉

`_onUserSigExpired`（脱敏示例，`fake_docs/sdk_manager/im_manager/im_manager.dart`）：

```dart
/// 通过邀请码，也就是聊天的邀请码获取信息
void _onUserSigExpired() async {
  final inviteCode = User.inviteCode ?? "";
  final resModel = await ApiClientExt.requestAction(
      ApiPaths.fakeDocsRefreshUserSig,
      method: RequestEnum.get,
      needShow: false,
      fromJsonT: (json) => ImLoginInfoModel.fromJson(json));
  final imSignKey = StorageKeys.imSignKey();
  if (resModel.isFailed) {
    AppLogger.i("im信息获取失败:${resModel.toJson().toString()}");
    final uSign = GetStorage().read<String>(imSignKey) ?? "";
    if (inviteCode.isNotEmpty && uSign.isNotEmpty) {
      ImManager().state.retryCount = 0;
      ImManager().imLogin(userID: inviteCode, userSig: uSign);
    }
    return;
  }

  /// 注意下子 聊天的info是邀请码
  final userID = resModel.data?.info ?? "";
  final userSig = resModel.data?.sign ?? "";
  if (userID.isEmpty || userSig.isEmpty) {
    AppLogger.i("关键数据获取失败:userID:$userID\n usrSig:$userSig");
    return;
  }
  if (inviteCode.isNotEmpty) {
    GetStorage().write(imSignKey, userSig);
  }

  ImManager().state.retryCount = 0;
  ImManager().imLogin(userID: userID, userSig: userSig);
}
```

三个触发入口：

```text
SDK 回调 onUserSigExpired / 登录返回签名错误码 / redayLogin（业务触发）
  → _onUserSigExpired()
    → GET /api/fake/im-user-sig-refresh
    → 成功：info → userID（邀请码）、sign → userSig，写入 GetStorage 缓存
    → 失败：读本地缓存兜底，缓存可用则继续登录
  → imLogin(userID, userSig)
```

缓存 key 按邀请码隔离（`storage_keys.dart`）：

```dart
static String imSignKey() {
  return "${StorageKeys.imSign}-${User.inviteCode ?? ""}";
}
```

服务端不可用时用本地缓存兜底重登，这是降级手段，不是长期方案：缓存里的 UserSig 迟早过期，过期后仍然要回到服务端重新签发。

### 4.5 坑：日志输出完整 UserSig

反例：以下示例展示了不应出现的凭证日志：

```dart
AppLogger.i("发起IM登录操作- userID:$userID userSig:$userSig");  // imLogin 内
...
AppLogger.i("uSign:$uSign");                                     // _onUserSigExpired 内
```

风险：UserSig 是账号凭证，具备"登录即代表用户"的能力。日志会进崩溃上报、厂商日志、用户反馈收集渠道，等于把凭证散落到多个不可控位置；一旦日志外泄，任何拿到它的人都能以该用户身份登录 IM。

修正：只记录 userID、错误码、重试次数等非敏感信息，UserSig 最多记录长度：

```dart
AppLogger.i("发起IM登录操作- userID:$userID userSigLength:${userSig.length}");
AppLogger.i("读取缓存 sign 成功，长度:${uSign.length}");
```

### 4.6 被踢下线

`onKickedOffline` 回调（脱敏示例）：

```dart
void _onKickedOffline() async {
  await TipDialog.show(
      title: "警告", content: "您当前账号在其他端登录，如非本人操作，请注意账号密码变更。", sureStr: "我已知晓");
  AppGlobal.logout();
}
```

被踢不只是改一个状态，而是弹窗告知后走全局登出（`AppGlobal.logout()` 会联动业务登录态与本地数据清理）。多端互踢是 IM 的账号安全约定，处理要落到业务登出的完整链路，不能只清 IM 侧。

### 4.7 业务门禁：签到驱动登录

IM 登录不是 App 启动就做，而是"进入聊天 Tab 且通过签到检查"才发生。触发链（`fake_docs/observer/app_life_cycle_observer.dart` + `fake_docs/pages/chat/chat_home_controller.dart`）：

```text
进入聊天 Tab（onPageShow 且当前是 baseTabBar）
  → redyRefreshTabData("聊天")
  → ChatHomeController.refreshData()（EasyThrottle 10 秒节流）
    → 拉取顶部公告 getImTopMessage
    → 查询今日签到 /api/fake/sign-in-today
      → 已签到 → ImManager().redayLogin()
        → 状态为 normal/failed 才继续，success 直接跳过（已登录）
        → _onUserSigExpired() → 拉 UserSig → imLogin
      → 未签到且已登录 → ImManager().imLogout()（强制下线）
```

`redayLogin` 与 `_getSignData` 的脱敏示例：

```dart
/// 准备登录
void redayLogin() async {
  if (state.status.value == ImLoginStatus.normal ||
      state.status.value == ImLoginStatus.failed) {
    _onUserSigExpired();
  }
}
```

```dart
/// 是否签到了（chat_home_controller.dart）
void _getSignData() async {
  final resModel = await ApiClientExt.requestAction<bool>(
    ApiPaths.fakeDocsIsTodaySignedIn,
    needShow: false,
  );
  if (resModel.isFailed) {
    return;
  }
  state.isSign.value = resModel.data ?? false;
  if (state.isSign.value) {
    ImManager().redayLogin();
  } else {
    if (ImManager().state.status.value == ImLoginStatus.success) {
      ImManager().imLogout();
    }
  }
}
```

UI 侧同步收口（`chat_home_view.dart`）：未签到时会话列表上方盖一层 `BackdropFilter` 模糊遮罩，点击弹"请您签到后再使用聊天功能"，列表不可操作；签到状态是 `state.isSign` 的 `Obx` 响应，签到成功后遮罩自动消失。注意这套门禁只认签到状态，不认 IM 登录状态——源码里有一段按 `ImLoginStatus` 显示"IM连接中/未连接"的模糊遮罩实现，已被注释移除，说明登录状态不该暴露成业务遮罩，业务门禁与连接状态各管各的。

## 五、监听器与未读数

### 5.1 三类监听器

登录成功后 `_addMsgListen()` 注册三类监听（`fake_docs/sdk_manager/im_manager/im_manager.dart`）：

```dart
void _addMsgListen() async {
  /// 监听消息未读数
  _v2TIMManager.getConversationManager().addConversationListener(
    listener: V2TimConversationListener(
      onTotalUnreadMessageCountChanged: (int totalUnreadCount) {
        AppLogger.i("未读总数变化为：$totalUnreadCount");
        state.totalUnReadMsg.value = totalUnreadCount;
      },
    ),
  );

  final unReadResult = await _v2TIMManager
      .getConversationManager()
      .getTotalUnreadMessageCount();
  if (unReadResult.code == 0) {
    state.totalUnReadMsg.value = 0;
  }

  /// 监听好友关系变更
  _v2TIMManager.getFriendshipManager().addFriendListener(
          listener: V2TimFriendshipListener(onFriendListAdded: (users) {
        _getFriendApplicationList();
      }, onFriendApplicationListDeleted: (userIDList) {
        _getFriendApplicationList();
      }, onFriendApplicationListAdded: (
        List<V2TimFriendApplication> applicationList,
      ) {
        List<V2TimFriendApplication> incomingRequests =
            applicationList.where((application) {
          FriendApplicationTypeEnum typeEnum =
              FriendApplicationTypeEnum.values[application.type];
          return typeEnum ==
              FriendApplicationTypeEnum.V2TIM_FRIEND_APPLICATION_COME_IN;
        }).toList();
        if (incomingRequests.isNotEmpty) {
          _getFriendApplicationList();
        }
      }));
  _getFriendApplicationList();

  /// 监听消息获取
  _v2TIMManager.getMessageManager().addAdvancedMsgListener(
      listener: V2TimAdvancedMsgListener(
    onRecvNewMessage: (msg) {
      AppLogger.i("收到IM消息:${msg.toLogString()}");
      playReciveMsg(msg);
    },
  ));
}
```

| 监听器 | 职责 |
|---|---|
| `V2TimConversationListener` | 未读总数增量回调 |
| `V2TimFriendshipListener` | 好友申请新增/删除/好友列表变更 → 刷新申请未读数（好友体系详见 27-IM好友体系与群管理篇） |
| `V2TimAdvancedMsgListener` | 收到新消息 → 播放收消息音效（第七节） |

未读数是两条数据源配合：`onTotalUnreadMessageCountChanged` 增量更新（收到事件就写），`getTotalUnreadMessageCount()` 首次查询（冷启动兜底拉历史未读）。

### 5.2 坑：首次查询成功后直接赋值 0

脱敏示例：

```dart
final unReadResult = await _v2TIMManager
    .getConversationManager()
    .getTotalUnreadMessageCount();
if (unReadResult.code == 0) {
  state.totalUnReadMsg.value = 0;
}
```

风险：冷启动后历史未读数被清零，用户看到 0 条未读，只有等下一次未读变化事件才能修正；把"查询成功"当成"未读为 0"，是两个不同的事实。

修正：赋查询返回值：

```dart
final unReadResult = await _v2TIMManager
    .getConversationManager()
    .getTotalUnreadMessageCount();
if (unReadResult.code == 0) {
  state.totalUnReadMsg.value = unReadResult.data ?? 0;
}
```

### 5.3 坑：用外部整数做枚举数组下标

脱敏示例：

```dart
FriendApplicationTypeEnum typeEnum =
    FriendApplicationTypeEnum.values[application.type];
```

`application.type` 是服务端返回的 `int`，客户端无法保证它在枚举长度内。SDK 的 `FriendApplicationTypeEnum` 从 0 开始且首个是 `V2TIM_FRIEND_APPLICATION_NULL` 占位（`dart 不支持枚举初始值`），服务端一旦返回超出枚举范围的类型值，`values[index]` 直接抛 `RangeError`，整个 `onFriendApplicationListAdded` 回调崩溃，进而可能影响登录链路。

风险：一条脏数据打崩回调，且崩溃点远离数据源，排查成本高。

修正：直接比较目标枚举的 `index`，不做数组下标：

```dart
onFriendApplicationListAdded: (List<V2TimFriendApplication> applicationList) {
  final incomingRequests = applicationList.where((application) {
    return application.type ==
        FriendApplicationTypeEnum.V2TIM_FRIEND_APPLICATION_COME_IN.index;
  }).toList();
  if (incomingRequests.isNotEmpty) {
    _getFriendApplicationList();
  }
}
```

`_getFriendApplicationList()` 把服务端返回的申请未读数写入 `state.friednAddCount`，通讯录入口红点据此展示（27 篇展开）。

### 5.4 坑：无参移除监听器且不保存引用

脱敏示例在登出、签名过期两处都调用无参移除：

```dart
// imLogout() 内
_v2TIMManager.getConversationManager().removeConversationListener();
_v2TIMManager.getFriendshipManager().removeFriendListener();
_v2TIMManager.getMessageManager().removeAdvancedMsgListener();
```

SDK 的 `removeXxxListener` 参数可空，且"无参 = 清空该类全部监听器"。以 friend 监听为例，SDK 源码（`tim_friendship_manager.dart`）：

```dart
Future<void> removeFriendListener({V2TimFriendshipListener? listener}) {
  if (listener == null) {
    v2TimFriendshipListenerList.clear();
  } else {
    v2TimFriendshipListenerList.remove(listener);
  }
}
```

风险有两个：

1. 无参移除会清掉该类全部监听器，包括 TUIKit 自己注册的——TUIKit 的会话列表、聊天页功能会静默失效或行为错乱。
2. 登出时清空、重登时又 `add` 一批新监听器，但旧实例若未被真正移除，同一事件会回调多次：收到一条消息播两遍音效、未读数重复累加。

修正：登录时保存自己创建的监听器实例，登出/过期时按实例移除（与 28 篇 2.3 节同一原则，这里给出本工程的自有写法）：

```dart
V2TimConversationListener? _conversationListener;
V2TimFriendshipListener? _friendshipListener;
V2TimAdvancedMsgListener? _msgListener;

void _addMsgListen() {
  _conversationListener = V2TimConversationListener(
    onTotalUnreadMessageCountChanged: (int count) {
      state.totalUnReadMsg.value = count;
    },
  );
  _v2TIMManager.getConversationManager()
      .addConversationListener(listener: _conversationListener);
  // friend、advancedMsg 同理，先 new 实例再 add，并保存到字段
}

Future<void> _removeMsgListen() async {
  if (_conversationListener != null) {
    await _v2TIMManager.getConversationManager()
        .removeConversationListener(listener: _conversationListener);
    _conversationListener = null;
  }
  if (_friendshipListener != null) {
    await _v2TIMManager.getFriendshipManager()
        .removeFriendListener(listener: _friendshipListener);
    _friendshipListener = null;
  }
  if (_msgListener != null) {
    await _v2TIMManager.getMessageManager()
        .removeAdvancedMsgListener(listener: _msgListener);
    _msgListener = null;
  }
}
```

登出、UserSig 过期回调、重登前统一走 `_removeMsgListen()`，替换监听器而不是叠加监听器。

### 5.5 未读数联动：GetX Worker 与角标

未读数消费端有两处：

- 顶层 Tab 栏角标（`base_tab_bar_view.dart`）：`Obx` 直接读全局状态 `ImManager().state.totalUnReadMsg.value`（以及 `friednAddCount`），任一大于 0 就显示红点。
- 聊天页标题（`chat_home_view.dart`）：显示"聊天(N)"，N 来自 `ChatHomeController.unReadMsg`，经 1 秒 debounce：

```dart
/// chat_home_controller.dart
void addMsgListion() {
  final totalUnReadMsg = ImManager().state.totalUnReadMsg;

  /// 保证1秒只刷1次
  _unReadMsgWorker = debounce(
    totalUnReadMsg,
    (value) {
      unReadMsg.value = value;
    },
    time: const Duration(seconds: 1),
  );
}
```

群消息密集到达时，`onTotalUnreadMessageCountChanged` 可能 1 秒内触发多次，debounce 把 UI 刷新合并为 1 秒一次。

### 5.6 坑：Worker 没有在 onClose 中 dispose

脱敏示例：

```dart
@override
void onClose() {
  super.onClose();
}
```

风险：GetX `Worker` 是订阅关系，控制器销毁后订阅仍存活，未读数变化会继续回调已销毁控制器的 `unReadMsg`，产生脏更新和内存泄漏；页面重建时 `addMsgListion` 又会注册一个新 Worker，订阅叠加。

修正：

```dart
@override
void onClose() {
  _unReadMsgWorker?.dispose();
  super.onClose();
}
```

## 六、会话列表与聊天页

### 6.1 会话列表页 TIMUIKitConversation

`chat_home_view.dart` 中的会话列表直接复用 TUIKit 组件：

```dart
TIMUIKitConversation(
  onTapItem: (selectedConv) {
    BoostNavigator.instance.push(
      RouteConfigKey.chat,
      arguments: {'conversation': selectedConv},
    );
  },
  emptyBuilder: () {
    return SizedBox(
      height: 600.px,
      child: EmptyView(marginTop: 140.px, status: EmptyStatus.noChat),
    );
  },
)
```

要点：点击项把整个 `V2TimConversation` 对象作为路由参数传给聊天页——聊天页需要的会话 ID、类型、免打扰状态都从这个对象取，不需要二次查询。

### 6.2 聊天页 TIMUIKitChat

`chat_view.dart` 的 `initState` 从路由参数取会话：

```dart
final arg = BoostNavigator.instance.getTopPageInfo()?.arguments;
V2TimConversation conversation = arg?['conversation'];

controller = Get.put(ChatController(),
    tag: "ChatController${conversation.conversationID}");
controller.conversation = conversation;
```

会话 ID 与类型由会话对象推导（`chat_controller.dart`）：

```dart
String? getConvID() {
  return conversation.type == 1 ? conversation.userID : conversation.groupID;
}

ConvType getConversationType() {
  return conversation.type == 1 ? ConvType.c2c : ConvType.group;
}
```

`V2TimConversation.type == 1` 是 C2C（单聊），否则是群聊——`type == 1` 在整个工程里统一按这个语义用（群聊为 2）。

`build` 里的 `TIMUIKitChat` 配置（脱敏示例精简）：

```dart
TIMUIKitChat(
  lifeCycle: lifeCycle, // ChatLifeCycle(messageDidSend: () => playSendMsg())
  appBarConfig: AppBar(...), // actions 里是右侧更多按钮 → controller.onTapMore
  topFixWidget: controller.conversation.type == 2
      ? Container(... "如涉及金钱交易或转账，请不要轻信" ...)  // 群聊顶部防骗提示
      : null,
  conversationID: controller.getConvID() ?? "",
  conversation: controller.conversation,
  onTapAvatar: controller.onTapAvatar,
  conversationType: controller.getConversationType(),
  config: TIMUIKitChatConfig(
    isAllowSoundMessage: true,
    isAllowEmojiPanel: true,
    isAllowShowMorePanel: true,
    showC2cMessageEditStatus: false,
    isAtWhenReply: false,
    isSupportMarkdownForTextMessage: false,
    isShowReadingStatus: controller.conversation.type == 1 ? true : false,
    isGroupAdminRecallEnabled: true,
  ),
  textFieldHintText: "请输入",
  messageItemBuilder: MessageItemBuilder(
    /// 自定义消息
    customMessageItemBuilder: customMessageItemBuilder,
  ),
  rpClick: controller.onTapSendRedPacket,
)
```

关键配置：

| 配置项 | 值 | 说明 |
|---|---|---|
| `lifeCycle.messageDidSend` | 播放发送音效 | TUIKit 的消息生命周期钩子 |
| `isAllowSoundMessage` | true | 语音消息 |
| `isShowReadingStatus` | 仅 C2C 开启 | 已读回执只对单聊有意义，群聊关闭 |
| `isGroupAdminRecallEnabled` | true | 群管理员可撤回 |
| `isAllowEmojiPanel` / `isAllowShowMorePanel` | true | 表情面板、更多面板 |
| `showC2cMessageEditStatus` / `isAtWhenReply` / `isSupportMarkdownForTextMessage` | false | 工程按需关闭的能力 |
| `messageItemBuilder.customMessageItemBuilder` | 业务接管 | 自定义消息渲染扩展点，红包卡片在此插入（28 篇） |
| `rpClick` | 发红包 | 更多面板"红包"入口回调（28 篇） |

聊天页里还有 `onDealWithGroupApplication`（群申请列表）与 AppBar 更多按钮跳群资料/用户详情，属于好友体系与群管理内容（详见 27-IM好友体系与群管理篇），本篇不展开。

### 6.3 收发消息路径

普通消息（文本、图片、语音、表情）的发送与渲染全部由 TUIKit 内部处理：输入区组装消息、`sendMessage` 发送、`customMessageItemBuilder` 之外的消息类型走 TUIKit 默认气泡。业务层不碰普通消息的协议细节。

自定义消息是唯一需要业务主动调用 SDK 的路径，链路是 `createCustomMessage` + `sendMessage`。以红包领取回执为例（`chat_controller.dart` 精简）：

```dart
final jsonStringData = jsonEncode({
  "businessID": ChatCustomMsgBusinessID.redPacketPick.businessId,
  "text": text,
  "send_uid": model.fromUid,
  "from_uid": ImManager.imLoginInfo.userID
});
V2TimValueCallback<V2TimMsgCreateInfoResult> target =
    await messageManager.createCustomMessage(data: jsonStringData);

final sendRes = await messageManager.sendMessage(
    message: target.data?.messageInfo,
    receiver: conversation.userID ?? "",
    groupID: conversation.groupID ?? "",
    priority: MessagePriorityEnum.V2TIM_PRIORITY_NORMAL);
```

`createCustomMessage` 把 JSON 数据包装成自定义消息体，`sendMessage` 按会话类型填 `receiver`（C2C）或 `groupID`（群）。`createCustomMessage` 可能返回 null，不能直接 `!` 解包（28 篇第 3 节有完整处理）。收发消息的完整语义（定向群消息、撤回、已读）在 28 篇展开。

### 6.4 离线推送衔接

`ImManager` 没有接腾讯 IM 的离线推送：业务推送走极光 JPush，IM 消息的离线触达需要厂商通道 + IM 离线推送配置，这两条链路的取舍与配置分别在 09-Android推送篇与 10-iOS推送篇，本篇不展开。前提是：如果 IM 消息要求"App 被杀也能收到通知"，离线推送必须单独接，接法与业务推送共用厂商通道资源。

## 七、消息音效

### 7.1 收消息音效

`playReciveMsg`（脱敏示例，`fake_docs/sdk_manager/im_manager/im_manager.dart`）：

```dart
void playReciveMsg(V2TimMessage msg) async {
  if (_isPlay) {
    return;
  }
  _lock.synchronized(() async {
    if (_isPlay) {
      return;
    }

    /// 判断消息是否免打扰
    bool isMute = false;
    final c = tuiConversationViewModel.conversationList.firstWhereOrNull((v) {
      final startStr = msg.messageConvType == 1 ? "c2c_" : "group_";
      return v?.conversationID == "$startStr${msg.messageConvID}";
    });
    isMute = c?.recvOpt == 2;
    if (isMute || c == null) {
      AppLogger.i("免打扰开启");
      return;
    }
    _isPlay = true;
    try {
      final isOtherPlay = await _isOtherAudioPlaying();
      if (isOtherPlay) {
        AppLogger.i("有其他音频在播放");
        await Future.delayed(const Duration(seconds: 2));
        _isPlay = false;
        return;
      }
      final player = AudioPlayer();
      await player.play(AssetSource("audio/receive_msg.mp3"));
      await Future.delayed(const Duration(seconds: 2));
      player.stop();
      player.dispose();
    } catch (e, s) {
      AppLogger.e("收到消息，播放报错:$e", s);
    }
    _isPlay = false;
  });
}
```

逻辑拆解：

- **免打扰判断**：从 `TUIConversationViewModel.conversationList` 找对应会话，`recvOpt == 2` 表示该会话开了免打扰，静音；会话不在当前列表也不播。会话 ID 按 `messageConvType == 1` 拼 `c2c_` 前缀、否则拼 `group_`，与 SDK 会话 ID 规则一致。
- **并发防护**：`_isPlay` 布尔 + `Lock`（synchronized 包）双重检查，防止消息密集到达时多个播放任务叠加。
- **不打断其他音频**：`_isOtherAudioPlaying()` 检测系统其他音频——Android 用 `AndroidAudioManager.isMusicActive()`，iOS 用 `AVAudioSession.isOtherAudioPlaying`；检测抛异常时返回 `true`（宁可漏播也不打断）。
- **播放与释放**：`audioplayers` 播放 2 秒后 `stop()` + `dispose()`，避免播放器实例泄漏。

### 7.2 发送音效

`playSendMsg` 与收消息同一套结构，两个差异：不查免打扰（发送方提示音与接收方无关）；音源是 `audio/send_msg.mp3`。由聊天页的 `ChatLifeCycle.messageDidSend` 触发，即 TUIKit 消息发送成功后回调。

## 八、常见错误与修正

| 问题 | 风险 | 修正 |
|---|---|---|
| init 在 try-catch 后无条件 `_isInit = true` | 初始化失败后仍跳过初始化直接登录 | 检查 init 返回值（`Future<bool?>`），成功才置位 |
| 登录重试用递归，被 `onLogin` 状态拦截 | 看似重试实际一次都不重试，失败即卡死 | 有上限的 for 循环重试 |
| 首次未读查询成功后赋值 0 | 冷启动历史未读数丢失，角标错误 | 赋 `result.data ?? 0` |
| 登出/过期用无参 `removeXxxListener()` | 清空 TUIKit 自己的监听器；重登后监听叠加、消息重复回调 | 保存实例，按实例移除 |
| 日志输出完整 UserSig（两处） | 凭证外泄风险 | 只记录 userID、错误码、重试次数 |
| `FriendApplicationTypeEnum.values[type]` | 服务端返回越界类型值时回调崩溃 | 直接比较枚举 `index` |
| GetX Worker 未在 `onClose` dispose | 控制器销毁后仍响应更新，订阅叠加 | `onClose` 中 `_unReadMsgWorker?.dispose()` |

这七处都出在 `im_manager.dart` 与 `chat_home_controller.dart` 两个文件里，是 IM 接入最容易写坏的集中区，也是面试时讲"对 IM 接入的深度"最好的素材。

## 九、单元测试与验收清单

### 9.1 单元测试

登录状态机适合用注入的登录抽象做纯逻辑测试，不需要真实 SDK（28 篇第 8 节有同类做法）。覆盖的状态迁移：

| 用例 | 前置 | 期望 |
|---|---|---|
| 首次登录成功 | status=normal | normal → onLogin → success，注册监听器 |
| 并发登录 | status=onLogin | 再次调用直接返回，只发起一次登录 |
| 签名错误（70014） | 登录返回签名错误码 | 清缓存、回 normal、重拉 UserSig 后重新登录 |
| 网络失败重试 | 连续 3 次失败 | 每次间隔 5 秒，第 4 次置 failed |
| 失败后重登 | status=failed | redayLogin 触发重新拉凭证 |
| 未读数首次查询 | getTotalUnreadMessageCount 返回 5 | `totalUnReadMsg == 5`，不是 0 |
| 未读数增量 | 回调 8 | `totalUnReadMsg == 8` |
| 免打扰静音 | 会话 `recvOpt == 2` | playReciveMsg 不播放 |
| 其他音频播放中 | `_isOtherAudioPlaying` 返回 true | 不播放，2 秒后复位 `_isPlay` |
| 监听器按实例移除 | remove 自己实例后 | 其他实例（TUIKit 的）仍在生效 |

### 9.2 验收清单

| 场景 | 验收标准 |
|---|---|
| 冷启动进聊天 Tab | 签到通过后自动登录，未读数与 Web 端一致 |
| 收发普通消息 | 文本/图片/语音正常，发送与接收音效各播一次 |
| 群免打扰会话来消息 | 无音效 |
| 其他设备登录同一账号 | 弹窗提示，全局登出 |
| UserSig 过期 | 自动重拉凭证重新登录，无崩溃，日志无凭证原文 |
| 断网重连 | 监听器不叠加，消息不重复播音效 |
| 未签到进入聊天 | 列表被模糊遮罩，无法操作，Tab 角标归零 |
| 解散群组 | 无 group_read_sequence 相关报错 toast |

## 十、面试问答

### Q1：UserSig 为什么必须由服务端签发，不能放客户端？

UserSig 是由密钥签名生成的凭证，持有密钥就等于拥有签发任意账号身份的能力。密钥放客户端，攻击者反编译即可伪造任意用户的登录凭证；服务端签发让凭证的生成、时效与吊销都掌握在业务手里。

### Q2：登录重试用递归实现有什么问题？

递归入口处如果状态已置"登录中"，重试调用会在第一行被并发防护拦截，实际一次都不重试；即使能执行，递归深度与退出条件也难以验证。有上限的 for 循环让每次尝试、间隔、失败出口都在一个函数内可见。

### Q3：IM 监听器为什么要保存实例并按实例移除？

SDK 的 `removeXxxListener` 无参会清空该类全部监听器，包括 TUIKit 自己注册的；不保存实例则登出后无法精确移除自己的监听，重登后新旧监听叠加，同一条消息会重复回调（音效重复播放、未读数重复累加）。

### Q4：未读数为什么需要"首次查询 + 增量回调"两条数据源？

增量回调只在登录后的事件流上生效，冷启动时先发生的未读变化不会补发；首次查询 `getTotalUnreadMessageCount()` 拉的是服务端/本地缓存的当前值，两条数据源配合才能保证冷启动和历史状态都不丢。

## 总结

IM 接入的骨架是四件事：服务端签发的 UserSig、一个可测试的登录状态机、按实例管理的监听器、增量与首次结合的正确未读数。本工程用单例适配层把 SDK 挡在页面之外，用签到门禁控制登录时机，用统一错误码出口收敛异常提示。把这七处坑修掉，IM 的基础设施才算是稳的；往上是自定义消息（28 篇）与好友群体系（27 篇）。

## 参考资料

- [Tencent Cloud Chat：登录](https://trtc.io/document/47971)
- [Tencent Cloud Chat：UserSig 鉴权](https://trtc.io/document/34385)
- [Tencent Cloud Chat：Flutter SDK API 概览](https://trtc.io/document/40124?menulabel=core+sdk&platform=flutter&product=chat)
- [pub.dev：tencent_cloud_chat_sdk](https://pub.dev/packages/tencent_cloud_chat_sdk)
- [pub.dev：tencent_cloud_chat_uikit](https://pub.dev/packages/tencent_cloud_chat_uikit)
