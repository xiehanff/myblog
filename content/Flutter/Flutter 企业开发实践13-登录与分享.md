---
title: Flutter 企业开发实践13-登录与分享
date: 2026-05-18
tags: [Flutter, 面试, 架构, 登录, 分享, Apple Sign In, Token, 微信, 第三方登录, fluwx, ShareSDK]
---

# 登录与分享

> 登录是用户身份的入口，分享是用户增长的引擎。但第三方登录远不是"调个 SDK 拿个 token"——iOS 强制 Apple Sign In、Token 刷新的并发竞态、分享回调的可靠性，每一环都有架构考量。本篇从架构师视角拆解登录分享的工程决策。

---

## 概述：登录与分享解决什么问题？

登录解决的核心问题是**身份识别**——让服务端知道"你是谁"。分享解决的核心问题是**裂变传播**——让用户帮你拉新。两者的工程挑战：

1. **第三方登录碎片化**：微信/QQ/微博/Apple 各有 SDK，OAuth 流程各有差异
2. **iOS 强制要求**：用了第三方登录就必须支持 Apple Sign In，否则拒审
3. **Token 生命周期管理**：access_token 过期刷新时的并发竞态问题
4. **分享回调可靠性**：微信分享回调依赖特定 Activity/URL Scheme，配置错误则收不到结果
5. **账号合并**：同一用户用微信登录和手机号登录，如何识别为同一人

本篇除通用方案讲解外，登录与分享的落地代码均取自**某已上线半年的 Flutter 混合开发项目（下文简称"该项目"）**（技术栈：GetX + Dio + fluwx + Mob ShareSDK），是经过生产环境验证的实现，可直接参考落地。

---

## 核心内容

### 1. 微信/QQ/微博登录接入

#### OAuth 2.0 标准流程

第三方登录本质上都是 OAuth 2.0 授权码流程：

```
1. App 调起第三方 App（微信/QQ/微博）
2. 用户在第三方 App 中授权
3. 第三方 App 回调你的 App，携带 authorization code
4. App 将 code 发送给你的服务端
5. 服务端用 code 换取 access_token
6. 服务端用 access_token 获取用户信息（openid、昵称、头像）
7. 服务端查找/创建本地用户，返回 JWT
```

**关键安全点**：step 4-6 必须在服务端完成，不能在客户端。因为换取 token 需要 client_secret，这个值不能暴露在 App 中。

#### 微信登录：fluwx 授权 + 服务端换 token

fluwx 5.x 的授权入口是 `authBy(NormalAuth(...))`，`snsapi_userinfo` scope 才能拿到昵称头像。客户端只负责拿 code，换 token 一律在服务端完成：

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:math';

/// 微信授权：一次请求对应一个不可预测的 state 和一个 Completer
class WeChatAuthManager {
  WeChatAuthManager(this._wx) {
    // 登录/分享/支付共用响应流，在各自 Manager 内按类型分发
    _wx.addSubscriber(_handleResponse);
  }

  final Fluwx _wx;
  final Random _secureRandom = Random.secure();
  Completer<String?>? _pendingAuth;
  String? _pendingState;

  Future<String?> auth() async {
    if (!await _wx.isWeChatInstalled) return null;
    if (_pendingAuth?.isCompleted == false) {
      throw StateError('微信授权正在进行中'); // 不允许后一次请求覆盖前一次回调
    }

    _pendingState = base64UrlEncode(
      List<int>.generate(32, (_) => _secureRandom.nextInt(256)),
    );
    final completer = Completer<String?>();
    _pendingAuth = completer;

    final launched = await _wx.authBy(
      which: NormalAuth(
        scope: 'snsapi_userinfo',
        state: _pendingState!,
      ),
    );
    if (!launched) completer.complete(null);

    try {
      return await completer.future.timeout(const Duration(minutes: 2));
    } on TimeoutException {
      return null;
    } finally {
      _pendingAuth = null;
      _pendingState = null;
    }
  }

  void _handleResponse(WeChatResponse resp) {
    if (resp is! WeChatAuthResponse || _pendingAuth == null) return;
    // state 必须与本次请求绑定；不匹配的回调直接拒绝并记录安全日志
    if (resp.state != _pendingState) return;
    _pendingAuth!.complete(
      resp.errCode == 0 && (resp.code?.isNotEmpty ?? false) ? resp.code : null,
    );
  }
}
```

**真实项目的登录不是"成功/失败"二元结果，而是一个由服务端返回码驱动的状态机**（该项目实践）：

```dart
/// 登录控制器：微信登录的真实分支处理
Future<void> onTapWechatLogin() async {
  // 1. fluwx 拿微信 code
  final wxCode = await weChatAuthManager.auth();
  if (wxCode == null) return showToast('授权失败');

  // 2. code + 设备指纹交给服务端换取业务 token
  final resModel = await apiClient.request('/auth/wx-login', data: {
    'code': wxCode,
    'mac': deviceId,        // 设备指纹：服务端用于"一号多机"风控
    'iEmulator': isEmulator, // 模拟器标识，风控拦截用
    'loginType': 1,
  });

  // 3. 登录接口的返回不止成功/失败，还有业务分支
  if (resModel.code == ApiCode.wxNeedBindPhone) {
    // 微信首次登录需绑定手机：携带 wxAuthCode 进注册页（见下文两步流程）
    push(RegistrationPage(wxAuthCode: wxCode, isRegistration: 3));
  } else if (resModel.code == ApiCode.bindOtherDevice) {
    // 一号多机被风控拦截：弹窗引导用户联系微信客服人工解绑
    final contactService = await showActionDialog(
        content: '该手机号已绑定其他设备', sureStr: '联系客服');
    if (contactService) weChatAuthManager.openCustomerService();
  } else if (resModel.isFailed) {
    showToast(resModel.msg ?? '微信登录失败');
  } else {
    loginSuccess(resModel.data); // 拿到 UserTokenModel，进主页
  }
}
```

#### 微信首次登录的两步流程：wxAuthCode 绑定手机

微信授权 code 是一次性的，绑定流程不能在第一步就把它消费掉。真实项目的做法是**让 wxAuthCode 贯穿两个页面**：

```
1. `/auth/wx-login` 返回"微信需绑手机"(wxNeedBindPhone)
   → 携带 wxAuthCode 进入注册页（isRegistration = 3 绑定手机模式）
2. 用户输入手机号 → sendSmsCode(scene = bindWechat) → 进验证码页
3. 验证码页提交：mobile + code + weChatCode(=wxAuthCode)
   → 服务端校验短信、用 wxAuthCode 换 openid、建立绑定关系、下发业务 token
```

关键点：

- **wxAuthCode 通过路由参数一路传递**，最终在绑定请求里作为 `weChatCode` 字段上送，服务端此时才消费它
- 注册页/验证码页用 `isRegistration` 一个参数区分四种模式（0 登录 / 1 注册 / 2 忘记密码 / 3 微信绑定手机），复用同一套 UI 与验证码逻辑
- 绑定接口的返回码同样要处理 `bindOtherDevice`——手机号已在其他设备登录时，绑定也会被风控拦截

**微信登录的坑**：
- 微信开放平台需要单独注册 App，审核约 1-3 个工作日
- 签名必须与开放平台注册的签名一致，Debug 签名和 Release 签名需分别配置
- [Android] 回调同样依赖 `wxapi/WXEntryActivity`，类名和包名必须严格匹配
- [iOS] Universal Link 配置错误会导致微信授权后无法跳回 App
- 客户端必须为每次授权生成不可预测的 state，并在回调时与本次请求逐值校验；code 有效期短，绑定流程跨多个页面时要准备超时重授权

#### 审核模式大开关：服务端下发的"过审形态"

生产级 App 提审 iOS 时，往往需要临时收敛登录方式与部分功能入口。真实项目用**服务端下发的审核状态开关**统一控制：

```dart
/// 审核模式开关（真实项目实现精简版）
Future<void> fetchAuditMode() async {
  try {
    // 冷启动请求：渠道 + 版本号，服务端据此判断当前是否处于审核期
    final res = await apiClient.get('/config/audit-status',
        queryParameters: {'channelId': channelId, 'version': appVersion},
        options: Options(receiveTimeout: const Duration(milliseconds: 3000)));
    if (res.isSuccess) {
      // 拿不到状态默认按审核期处理（fail-safe：宁可多隐藏，不可漏隐藏）
      auditMode = res.data ?? true;
      GetStorage().write('app.auditMode', auditMode);
    }
  } finally {
    // 无论成败都要把状态同步给原生容器，保证双端行为一致
    nativeChannel.invokeMethod(
        'syncAuditStatus', jsonEncode({'auditStatus': auditMode}));
  }
}

// 登录页消费开关：审核期 iOS 只留手机号 + 游客登录，隐藏微信规避 4.8 约束
if (auditMode && Platform.isIOS) {
  canGuestLogin.value = true;
  canWechatLogin.value = false;
}
```

这套开关的四个工程细节：

1. **fail-safe 默认值**：开关请求失败时默认按审核模式处理，避免审核员恰好赶上接口异常而看到不该看的入口
2. **持久化 + 网络恢复重试**：结果写入本地存储，下次冷启动离线也能拿到上次状态；首次请求失败则监听网络恢复事件补偿请求
3. **双端同步**：混合开发中，原生容器（tabbar、原生页面、广告 SDK）也依赖审核状态，Flutter 拿到状态后必须通过 MethodChannel 同步给原生，否则出现"Flutter 侧隐藏了、原生侧还展示"的行为不一致
4. **游客登录 = 审核专用登录方式**：服务端维护一个游客账号池接口，客户端随机取一组账号密码走普通密码登录，同时本地打上 `isGuestLogin` 标记，业务层据此隐藏充值、发帖等入口；过审后开关一关，游客入口自然消失

#### QQ 登录

QQ 登录的流程与微信类似，但有以下差异：

| 维度 | 微信 | QQ |
|------|------|-----|
| SDK | fluwx | tencent_kit（QQ 互联 Flutter 插件） |
| 授权方式 | OpenSDK | QQ 互联 SDK |
| 回调 | WXEntryActivity / Universal Link | onActivityResult / URL Scheme |
| openid 格式 | 28 位字符串 | 32 位字符串（不是纯数字） |
| unionid | 支持（同一开放平台账号下的 App 互通） | 支持（QQ 互联提供 unionid，同一开发者主体下经 `/oauth2.0/me?unionid=1` 获取） |

> 账号打通的选型提示：微信与 QQ 都以"同一开发者主体/开放平台账号"为 unionid 互通的前提——接入前先确认各平台的主体归属一致，否则多 App 之间拿到的 unionid 不同，账号体系对不上。

#### 微博登录

微博登录已逐渐边缘化，新项目通常不接。如果必须接入，注意：
- 微博 SDK 年久失修，Flutter 插件质量参差不齐
- 微博对第三方应用的审核较严格
- 微博开放平台 API 文档更新不及时

#### 运营商三网一键登录（国内产品选型必须知道）

与短信验证码并列的国内标配：本质是**运营商网关取号**——SIM 卡在网状态下，SDK 向运营商（移动/联通/电信，经闪验/极光等聚合方）换取本机号码的授权 token，用户点一次"本机号码一键登录"即完成，全程无输入、无短信。产品价值就一条：**登录转化率显著高于短信码**（少一步等待与输入，转化差距是运营最敏感的数字）。

工程上的关键认知：

1. **前置条件苛刻**：需 cellular 网络在网（双卡取当前数据卡）、运营商 SDK 预取号有超时；Wi-Fi-only 设备、取号失败都要求**优雅回落到短信码**——一键登录是"快路径"，短信是"兜底路径"，两者必须共存；
2. **隐私合规同级别严**：取号即收集手机号，隐私政策、SDK 列表声明、首次弹窗授权一个不能少，且预取号的时机必须在用户同意隐私政策之后；
3. **iOS 同样受 4.8 约束**：一键登录页若提供运营商之外的登录方式，记得同步检查 Apple Sign In 的要求（见下节）。

本项目未接入（目标用户以微信登录为主），但选型评审时它与短信码的转化率对比、回落链路设计是必答题。

---

### 2. Apple Sign In（iOS 必须）

#### 为什么 iOS 必须支持 Apple Sign In？

[iOS] Apple 审核指南 4.8 明确规定：**如果你的 App 支持任何第三方社交登录（微信、QQ、微博等），就必须同时提供 Apple Sign In。** 不提供会被拒审。

这个规定的核心逻辑是：Apple 认为第三方登录服务可能追踪用户，而 Sign in with Apple 提供了隐私保护（隐藏邮箱），是用户权利的保障。

**例外**：
- 纯手机号/邮箱登录（不接第三方登录），不需要 Apple Sign In
- 企业内部 App 不上 App Store，不受此约束
- 教育类 App 如果只用学校 SSO 登录，也不需要

#### Apple Sign In 流程

```
1. App 调起 Apple Sign In 授权弹窗
2. 用户选择"使用 Apple 登录"（可选择隐藏邮箱）
3. Apple 返回 authorization code + identity token + user info
4. App 将 authorization code + identity token 发送给服务端
5. 服务端验证 identity token（JWT 签名验证）
6. 解析 token 获取用户标识（sub 字段）
7. 查找/创建本地用户，返回业务 JWT
```

```dart
// Apple Sign In：使用维护活跃的 sign_in_with_apple 社区插件
// 注意：早期的 apple_sign_in 插件（AppleSignIn.performRequests 那套 API）已废弃，
// 新项目优先使用 sign_in_with_apple，并在升级时核对 Apple 原生 API 变化
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

class AppleSignInService {
  Future<AppleSignInResult?> signIn() async {
    // iOS 13+ 才支持；Android/Web 端需要自己的后端做中继
    if (!await SignInWithApple.isAvailable()) {
      return null;
    }

    final credential = await SignInWithApple.getAppleIDCredential(
      scopes: [
        AppleIDAuthorizationScopes.email,
        AppleIDAuthorizationScopes.fullName,
      ],
      // 仅 Android/Web 端需要；iOS 原生流程可省略
      webAuthenticationOptions: WebAuthenticationOptions(
        clientId: 'com.example.app.service', // Services ID
        redirectUri: Uri.parse('https://www.example.com/auth/callback'),
      ),
    );

    // 首次授权才有 email / familyName / givenName，之后只返回 userIdentifier
    return AppleSignInResult(
      authorizationCode: credential.authorizationCode,
      identityToken: credential.identityToken,
      userIdentifier: credential.userIdentifier,
      email: credential.email, // 后续授权为 null，首次必须上报服务端保存
      fullName: '${credential.familyName ?? ''}${credential.givenName ?? ''}',
    );
  }
}
```

#### 隐藏邮箱的处理

Apple Sign In 允许用户选择"隐藏我的电子邮件"，此时 Apple 会生成一个中转邮箱（`xxxxx@privaterelay.appleid.com`），邮件转发到用户真实邮箱。

**架构影响**：
- 你拿到的 email 可能是中转邮箱，不是真实邮箱
- 首次授权后 Apple 不再返回 email 和 fullName——后续授权只返回 userIdentifier
- **必须在首次授权时保存 email 和 fullName**，否则永久丢失
- 如果业务需要真实邮箱（如营销邮件），不能依赖 Apple Sign In 的邮箱

#### 服务端验证 identity_token

```python
# Python 示例：验证 Apple identity_token（服务端）
import jwt

def verify_apple_identity_token(identity_token):
    # 1. 解码 JWT header 拿 kid，从 Apple 公钥端点取公钥
    kid = jwt.get_unverified_header(identity_token)['kid']
    public_key = get_apple_public_key(kid)

    # 2. 验签 + 校验 aud（你的 Bundle ID）/ iss
    payload = jwt.decode(
        identity_token, public_key, algorithms=['RS256'],
        audience='com.example.app', issuer='https://appleid.apple.com')

    # 3. sub 是唯一用户标识；email 可能是中转邮箱
    return {
        'user_id': payload['sub'],
        'email': payload.get('email'),
        'email_verified': payload.get('email_verified', False),
    }
```

#### 不接 Apple Sign In 的替代过审路线（真实项目方案）

接入 Apple Sign In 并不是唯一路线。该项目的选择是：**不接 Apple Sign In，而是用上文"审核模式大开关"在审核期隐藏微信登录入口，只保留手机号验证码登录 + 游客登录**——审核期内 App 不提供任何第三方社交登录，自然不触发 4.8 条款；过审后开关一切，微信登录恢复展示。

两种路线的取舍：

| 维度 | 接入 Apple Sign In | 审核模式隐藏第三方登录 |
|------|------|------|
| 开发成本 | 插件接入 + Capability 配置 + 服务端验签 | 一个服务端开关 + 登录入口显隐逻辑 |
| 合规风险 | 低，官方推荐路径 | 属于"灰色"操作，存在被审核团队识破后按 2.3.1（隐藏功能）拒审的风险 |
| 用户体验 | 正式用户多一种登录方式 | 审核期与过审后登录方式不一致，且 Apple 账号体系用户无对应登录手段 |
| 维护成本 | 一次接入长期稳定 | 每次提审/过审需人工切换服务端状态，且要保证双端同步 |

工程判断：

- **正规首选仍是接入 sign_in_with_apple**，成本一次性的，且不担合规风险
- 审核模式开关更适合作为**兜底手段**——真实项目里它同时控制着登录方式、运营位、分享入口等一批功能的显隐，Apple Sign In 只是它顺带规避的问题之一
- 如果选择审核模式路线，必须保证开关 fail-safe（默认审核态）与双端同步，否则一次疏漏就是拒审一周起步

---

### 3. Flutter 侧统一登录抽象

#### 设计目标

统一登录抽象层的核心目标是：**业务层只关心"登录成功拿到 JWT"，不关心底层走的是微信/QQ/Apple。**

```dart
/// 登录服务抽象
abstract class AuthService {
  /// 获取支持的登录方式
  List<LoginMethod> get supportedMethods;

  /// 执行登录
  Future<AuthResult> login(LoginMethod method);

  /// 退出登录
  Future<void> logout();
}

/// 登录方式
enum LoginMethod { wechat, qq, apple, phone, email }

/// 登录结果
class AuthResult {
  final bool success;
  final String? accessToken;
  final String? refreshToken;
  final String? error;
  final UserInfo? userInfo;
  AuthResult(
      {required this.success, this.accessToken, this.refreshToken, this.error, this.userInfo});
}

/// 用户信息（统一模型，昵称/头像/邮箱/手机号等字段按业务增减，此处略）
class UserInfo {
  final String userId;
  final String? nickname;
  UserInfo({required this.userId, this.nickname});
}
```

#### 工厂 + 策略模式

```dart
/// 登录策略工厂
class LoginStrategyFactory {
  static final _strategies = <LoginMethod, LoginStrategy>{
    LoginMethod.wechat: WeChatLoginStrategy(),
    LoginMethod.qq: QQLoginStrategy(),
    LoginMethod.apple: AppleLoginStrategy(),
    LoginMethod.phone: PhoneLoginStrategy(),
  };

  static LoginStrategy? getStrategy(LoginMethod method) {
    return _strategies[method];
  }
}

/// 登录策略接口
abstract class LoginStrategy {
  Future<AuthResult> login();
}

/// 微信登录策略
class WeChatLoginStrategy implements LoginStrategy {
  @override
  Future<AuthResult> login() async {
    final wechatResult = await WeChatLoginService().login();
    if (wechatResult == null) {
      return AuthResult(success: false, error: 'WeChat login failed');
    }
    // 将微信 code 发送给服务端，换取业务 JWT
    return _serverAuth(wechatResult.code, LoginMethod.wechat);
  }
}

/// Apple 登录策略
class AppleLoginStrategy implements LoginStrategy {
  @override
  Future<AuthResult> login() async {
    final appleResult = await AppleSignInService().signIn();
    if (appleResult == null) {
      return AuthResult(success: false, error: 'Apple Sign In failed');
    }
    // 将 authorizationCode 发送给服务端验证
    return _serverAuth(appleResult.authorizationCode!, LoginMethod.apple);
  }
}
```

#### 真实项目的中间形态：返回码驱动的登录状态机

上面是教科书式的 Strategy 抽象。该项目实际采用的是更"薄"的中间形态：**一个 LoginController 按钮直连各登录方法 + 服务端返回码分支 + 统一的 `_getUserInfo` 收口**，其中游客登录和微信绑定手机是两个最有代表性的策略实现：

```dart
/// 游客登录（真实项目实现精简版）：账号池 + 本地标记
Future<void> onTapGuestLogin() async {
  // 1. 服务端提供一批游客账号（仅审核模式返回）
  final pool = await apiClient.requestList('/guest/accounts');
  if (pool.isEmpty) return showToast('游客登录不可用');

  // 2. 随机取一组账号密码，复用普通密码登录通道
  final account = pool[Random().nextInt(pool.length)];
  final resModel = await apiClient.request('/auth/password-login', data: {
    'mobile': account.mobile,
    'password': account.password,
    ...deviceMap, // 设备指纹
  });
  if (resModel.isFailed) return showToast(resModel.msg ?? '游客登录失败');

  // 3. 打上游客标记并持久化，业务层据此隐藏充值/发帖等入口
  User.instance().isGuestLogin = true;
  GetStorage().write('app.isGuest', true);
  _getUserInfo(resModel.data);
}
```

这套"薄抽象"的取舍值得注意：

- **登录结果对象化要趁早**：游客登录能塞进密码登录通道，靠的是登录结果里保留了**业务返回码**（`wxNeedBindPhone`/`bindOtherDevice`），而不是简单 bool——登录天然是状态机，不是二元函数
- **收口统一**：无论密码/验证码/微信/游客，最后都走同一个 `_getUserInfo(tokenModel)`：保存 token → 拉用户信息 → 全局 `loginSuccess()`，Token 管理逻辑（见第 5 节）只写一遍
- **抽象时机**：登录方式少于等于四种、且都共用服务端返回码协议时，"控制器 + 返回码分支"比 Strategy 模式更直观；等登录方式继续膨胀、或出现多套异构协议时，再升级为 Strategy 也不迟——避免过度设计

#### 不这么做会怎样？

如果不做抽象层，每个页面的登录逻辑直接调用第三方 SDK：
- 新增登录方式时需要改所有页面的登录代码
- 无法统一处理登录异常、Token 存储、事件上报
- 切换登录 SDK（如从微信登录切到手机号登录）时影响面大

---

### 4. 第三方分享 SDK 接入

#### 分享架构：双 SDK 方案（真实项目选型）

该项目的分享架构是"**微信直连 fluwx + QQ/微博走 Mob ShareSDK**"的混合方案：

```
┌────────────────────────────────────────────────┐
│                 Flutter 业务层                   │
│        ShareManager（统一入口，三方法）            │
│   shareByImage / shareByWebpage / shareText     │
├──────────────────────────┬─────────────────────┤
│    微信：fluwx 直连        │  QQ/微博：Mob ShareSDK │
│  WeChatShare*Model       │  SSDKMap 构参          │
│  addSubscriber 回调分发    │  SSDKResponseState    │
├──────────────────────────┴─────────────────────┤
│        微信 OpenSDK / QQ 互联 SDK / 微博 SDK       │
└────────────────────────────────────────────────┘
```

**为什么不全用 ShareSDK？** 真实项目的注释原话是"ShareSDK 集成微信不友好，得自己单独集成微信"：

- 微信是分享量最大的平台，fluwx 对微信登录/分享/支付/客服的回调链路、Universal Link 适配、参数模型都维护得更及时，**微信必须直连**
- QQ/微博分享频次低，为它们单独维护原生插件性价比太低，ShareSDK 一把接入最省成本
- 双 SDK 的代价是 ShareManager 里要维护一个分支：微信类型走 fluwx，其余走 ShareSDK——分支收敛在 manager 内部，业务层无感知

#### ShareType 枚举与统一入口

```dart
/// 分享平台枚举（真实项目实现精简版）
enum ShareType {
  wechat,         // 微信好友
  wechatTimeline, // 朋友圈
  qq,
  qqZone,
  sina;           // 微博

  /// 映射到 ShareSDK 平台常量
  ShareSDKPlatform toPlatform() => switch (this) {
        ShareType.wechat => ShareSDKPlatforms.wechatSession,
        ShareType.wechatTimeline => ShareSDKPlatforms.wechatTimeline,
        ShareType.qq => ShareSDKPlatforms.qq,
        ShareType.qqZone => ShareSDKPlatforms.qZone,
        ShareType.sina => ShareSDKPlatforms.sina,
      };

  /// 安装检测用主平台：朋友圈复用微信、QQ空间复用QQ
  ShareSDKPlatform get checkInstallPlatform => switch (this) {
        ShareType.wechatTimeline => ShareSDKPlatforms.wechatSession,
        ShareType.qqZone => ShareSDKPlatforms.qq,
        _ => toPlatform(),
      };

  String get platformName => const {
        ShareType.wechat: '微信',
        ShareType.wechatTimeline: '朋友圈',
        ShareType.qq: 'QQ',
        ShareType.qqZone: 'QQ空间',
        ShareType.sina: '微博',
      }[this]!;
}

/// 统一入口：三个方法按内容类型划分，只负责构参；
/// 初始化/安装检测/回调转 Future 收敛在 _shareBySdk 一处
class ShareManager {
  static final ShareManager _instance = ShareManager._();
  factory ShareManager() => _instance;
  ShareManager._();

  bool _shareSdkIsInit = false; // ShareSDK 惰性初始化标记

  /// 图片分享（海报、截图）
  Future<ShareResult> shareByImage(
      {required ShareType type, required Uint8List imageData}) async {
    if (type == ShareType.wechat || type == ShareType.wechatTimeline) {
      return WeChatShareManager().shareImage(type, imageData);
    }
    // QQ 只认本地文件路径：先落盘再分享
    final imagePath = await saveImageToLocal(imageData);
    final sdkMap = SSDKMap();
    if (type == ShareType.sina && Platform.isAndroid) {
      // [Android] 微博必须用 setSina，参数顺序与 setGeneral 完全不同
      sdkMap.setSina(
          '', '', [imagePath], '', '', 0, 0, '', true, '', '', SSDKContentTypes.image);
    } else {
      // QQ 与 [iOS] 微博一致，走 setGeneral
      sdkMap.setGeneral('', '', [imagePath], '', imagePath, '', '', '', '', '',
          SSDKContentTypes.image);
    }
    return _shareBySdk(type, sdkMap);
  }

  /// 网页分享
  Future<ShareResult> shareByWebpage(
      {required ShareType type, required WebpageShareModel model}) async {
    if (type == ShareType.wechat || type == ShareType.wechatTimeline) {
      return WeChatShareManager().shareWebpage(type, model);
    }
    final sdkMap = SSDKMap();
    switch (type) {
      case ShareType.qq:
      case ShareType.qqZone:
        // QQ 网页分享：标题 + 副标题 + 图URL + 网页URL（[iOS] 微博构参相同）
        sdkMap.setGeneral(model.title ?? '', model.subTitle ?? '',
            [model.imageUrl ?? ''], '', '', model.webUrl ?? '', '', '', '', '',
            SSDKContentTypes.webpage);
      case ShareType.sina:
        if (Platform.isIOS) {
          sdkMap.setGeneral(model.title ?? '', model.subTitle ?? '',
              [model.imageUrl ?? ''], '', '', model.webUrl ?? '', '', '', '', '',
              SSDKContentTypes.webpage);
        } else {
          // [Android] setSina 的文本字段在第一位，imageUrl 在倒数第三个
          sdkMap.setSina(model.subTitle ?? '', model.title ?? '', null, '',
              model.webUrl ?? '', 0, 0, '', true, model.imageUrl ?? '', '',
              SSDKContentTypes.webpage);
        }
      default:
        break;
    }
    return _shareBySdk(type, sdkMap);
  }

  /// 文本分享（构参同 shareByImage，contentType 换成 text）
  Future<ShareResult> shareText(
      {required ShareType type, required String content}) async {
    if (type == ShareType.wechat || type == ShareType.wechatTimeline) {
      return WeChatShareManager().shareText(type, content);
    }
    // [Android] QQ 纯文本分享经常调不起/无回调：直接降级为复制内容+提示
    if (type == ShareType.qq && Platform.isAndroid) {
      await Clipboard.setData(ClipboardData(text: content));
      showToast('已复制，可打开QQ粘贴分享');
      return ShareResult(success: true);
    }
    // 构参同 shareByImage：sina 走 setSina(content, ...)、其余 setGeneral('', content, ...)，
    // contentType 换成 SSDKContentTypes.text
    final sdkMap = SSDKMap();
    if (type == ShareType.sina) {
      sdkMap.setSina(
          content, '', null, '', '', 0, 0, '', true, '', '', SSDKContentTypes.text);
    } else {
      sdkMap.setGeneral(
          '', content, null, '', '', '', '', '', '', '', SSDKContentTypes.text);
    }
    return _shareBySdk(type, sdkMap);
  }

  /// ShareSDK 侧公共链路：惰性初始化 → 安装检测 → 分享 → 回调转 Future
  Future<ShareResult> _shareBySdk(ShareType type, SSDKMap sdkMap) async {
    if (!_shareSdkIsInit) {
      // 顺序不能反：先提交 Mob 隐私合规，再注册 QQ/微博平台
      await SharesdkPlugin.uploadPrivacyPermissionStatus(1, (_) {});
      final register = ShareSDKRegister()
        ..setupQQ('qqAppId', 'qqAppSecret')
        ..setupSinaWeibo('sinaAppId', 'sinaAppSecret', '', 'sinaRedirectUri');
      SharesdkPlugin.regist(register);
      _shareSdkIsInit = true;
    }
    // isClientInstalled 返回值双端类型不一致，必须双兼容：
    // [Android] 返回 Map（values 含 "installed"），[iOS] 返回 bool
    final res =
        await SharesdkPlugin.isClientInstalled(type.checkInstallPlatform);
    final installed = (res is Map && res.values.contains('installed')) ||
        (res is bool && res);
    if (!installed) {
      return ShareResult(success: false, error: '请先安装${type.platformName}');
    }
    final completer = Completer<ShareResult>();
    SharesdkPlugin.share(type.toPlatform(), sdkMap,
        (state, userData, shareEntity, error) {
      // SSDKResponseState 回调 → Completer → 统一 ShareResult
      completer.complete(switch (state) {
        SSDKResponseState.Success => ShareResult(success: true, error: '分享成功'),
        SSDKResponseState.Cancel => ShareResult(success: false, error: '取消分享'),
        _ => ShareResult(success: false, error: '分享失败'),
      });
    });
    return completer.future;
  }
}
```

#### 微信直连 fluwx：缩略图必须先下载塞 thumbData

微信的分享回调是全局流（`addSubscriber`），登录/分享/支付按响应类型分发。网页分享最关键的细节是**缩略图必须先下载成二进制塞进 `thumbData`**——只传图片 URL 微信会静默失败：

```dart
class WeChatShareManager {
  final _wx = Fluwx();
  Completer<ShareResult>? _shareResult;

  Future<void> init() async {
    await _wx.registerApi(
        appId: 'wxAppId', universalLink: 'https://www.example.com/ul/');
    _wx.addSubscriber((resp) {
      // 登录/分享/支付按响应类型分发，此处只处理分享
      if (resp is WeChatShareResponse) {
        final msg = switch (resp.errCode) {
          0 => '微信分享成功',
          -2 => '取消分享',
          _ => resp.errStr ?? '分享失败',
        };
        _shareResult
            ?.complete(ShareResult(success: resp.errCode == 0, error: msg));
      }
    });
  }

  /// 网页分享：缩略图先经缓存管理器下载，读 bytes 塞 thumbData（<=32KB）
  Future<ShareResult> shareWebpage(
      ShareType type, WebpageShareModel model) async {
    if (!await _wx.isWeChatInstalled) {
      return ShareResult(success: false, error: '请先安装微信');
    }
    final file = await cacheManager.cacheImage(model.imageUrl);
    if (file == null) {
      return ShareResult(success: false, error: '缩略图下载失败');
    }
    _shareResult = Completer<ShareResult>();
    final shareModel = WeChatShareWebPageModel(
      model.webUrl ?? '',
      title: model.title,
      description: model.subTitle,
      thumbData: file.readAsBytesSync(), // 不塞 thumbData 微信会静默失败
      scene: _scene(type),
    );
    return _dispatch(shareModel);
  }

  /// 图片分享：海报/截图 bytes 直接进 WeChatImageToShare（无缩略图问题）
  Future<ShareResult> shareImage(ShareType type, Uint8List imageData) async {
    if (!await _wx.isWeChatInstalled) {
      return ShareResult(success: false, error: '请先安装微信');
    }
    _shareResult = Completer<ShareResult>();
    return _dispatch(WeChatShareImageModel(
        WeChatImageToShare(uint8List: imageData),
        scene: _scene(type)));
  }

  /// 文本分享：WeChatShareTextModel(content, scene: _scene(type))，结构同上

  WeChatScene _scene(ShareType type) =>
      type == ShareType.wechat ? WeChatScene.session : WeChatScene.timeline;

  Future<ShareResult> _dispatch(dynamic shareModel) async {
    if (await _wx.share(shareModel) == false) {
      return ShareResult(success: false, error: '调起微信失败');
    }
    return _shareResult!.future; // 等待 addSubscriber 回调 resolve
  }
}
```

#### 海报分享模式：截图长图 + 二维码

邀请分享、成就分享这类强运营场景，直接分享网页卡片转化有限。真实项目的海报分享模式：**用 RepaintBoundary 离屏渲染一张超屏长图（含二维码），生成 bytes 后复用统一的 `shareByImage` 链路**：

```dart
/// 海报分享（真实项目实现精简版）
Future<void> sharePoster(BuildContext context) async {
  // captureFromLongWidget：离屏渲染一张超屏长图（背景图 + 内容卡片 +
  // 用户信息 + PrettyQrCode 二维码），无需真实挂载到页面
  final bytes = await ScreenshotController().captureFromLongWidget(
    Material(color: Colors.transparent, child: posterWidget(context)),
    context: context,
    pixelRatio: 3, // 保证长图清晰度
  );
  // 长图复用图片分享链路：微信/朋友圈/QQ/保存相册全部统一
  await ShareManager().shareByImage(type: ShareType.wechat, imageData: bytes);
}
```

要点：长图在页面不可见区域用 `captureFromLongWidget` 离屏渲染；二维码内容是 H5 落地页 + 邀请码参数，扫码路径与分享卡片路径归一到同一套归因；截图失败时要给出降级（如改为分享网页卡片）。

#### 分享的坑

**坑1：微信分享缩略图大小限制**

[双端] 微信分享网页类型的缩略图不能超过 32KB。如果你的图片超过 32KB，微信会静默失败——不报错，只是不显示缩略图。需要在分享前压缩：

```dart
Future<Uint8List> compressThumbnail(Uint8List bytes) async {
  // 循环降质直到 <32KB：微信超限会静默失败（不报错，只是不显示缩略图）
  var quality = 85;
  var compressed = bytes;
  while (compressed.lengthInBytes > 32 * 1024 && quality > 10) {
    compressed = await FlutterImageCompress.compressWithList(bytes,
        minHeight: 150, minWidth: 150, quality: quality);
    quality -= 10;
  }
  return compressed;
}
```

**坑2：微信小程序分享**

[双端] 微信小程序分享需要额外参数（`userName`、`path`、`hdImageData`），且必须与微信开放平台关联小程序。未关联的 App 无法分享小程序卡片。

**坑3：QQ 分享回调**

[Android] QQ 分享回调依赖 `QQShareCallbackActivity`，且必须在 `AndroidManifest.xml` 中正确配置 scheme 和 host。配置错误时分享成功但收不到回调，用户看不到分享结果反馈。

**坑4：iOS Universal Link**

[iOS] 微信/QQ 分享的回调在 iOS 上依赖 Universal Link。如果 Universal Link 配置有误，分享完成后无法跳回 App，用户会认为 App 卡死了。必须测试所有分享场景的回调链路。

---

### 5. Token 管理与刷新策略

#### Token 生命周期

```
登录成功 → 获得 access_token (短期, 通常 2h) + refresh_token (长期, 通常 30d)
     ↓
请求 API → 携带 access_token
     ↓
access_token 过期 → 用 refresh_token 换取新的 access_token
     ↓
refresh_token 过期 → 用户需要重新登录
```

#### Token 存储安全

企业级标准做法是 flutter_secure_storage（[iOS] 落 Keychain，[Android] 落 EncryptedSharedPreferences）：

```dart
/// Token 安全存储
class TokenStorage {
  static const _accessTokenKey = 'access_token';
  static const _refreshTokenKey = 'refresh_token';

  final storage = const FlutterSecureStorage();

  Future<void> saveTokens(
      {required String accessToken, required String refreshToken}) async {
    await storage.write(key: _accessTokenKey, value: accessToken);
    await storage.write(key: _refreshTokenKey, value: refreshToken);
  }

  Future<String?> getAccessToken() => storage.read(key: _accessTokenKey);
}
```

**绝对不要用 `SharedPreferences` 存储 Token**——Android 上 SharedPreferences 是明文 XML 文件，root 设备可直接读取。

**真实教训**：该项目出于迭代速度，token 用 get_storage 以 JSON 明文存储（`UserTokenModel` 整体序列化后写入 `app.token_info`）。这在当时是一笔"安全欠账"：get_storage 本质同样是明文文件，收益只是比裸 SharedPreferences 多了结构化序列化。业务上靠"access_token 短期有效 + 服务端可吊销"兜底，但企业级新项目应直接上 flutter_secure_storage（[iOS] 落 Keychain、[Android] 落 EncryptedSharedPreferences）——存储明文 token 的迁移成本会随挂靠字段（IM token、openid 等）越滚越大。

#### Token 刷新的并发竞态问题

这是 Token 管理中最容易被忽略的问题：

**场景**：多个并发请求同时发现 access_token 过期，同时发起 refresh 请求。

```
请求A: access_token 过期 → refresh → 拿到新 token1 → 用 token1 发请求
请求B: access_token 过期 → refresh → 拿到新 token2 → 用 token2 发请求
请求C: access_token 过期 → refresh → 拿到新 token3 → 用 token3 发请求
```

问题：多次 refresh 可能导致第一次 refresh 拿到的 token1 立即被 token2 作废，后续用 token1 的请求全部失败。

**解决方案：独立 Dio 刷新 + Lock 防并发 + 请求队列挂起重放 + 失败冷却**。以下是该项目的生产实现（完整精简版），四个设计点先划出来：

1. **401 是业务码不是 HTTP 状态码**：国内服务端常把"token 过期"放在 HTTP 200 的响应体 `code` 里返回（本项目约定 401 = access_token 过期需刷新，402 = refreshToken 失效），所以要拦 `onResponse` 而不是 `onError`
2. **独立 `_tokenDio` 刷新**：刷新请求不走业务 dio，天然绕开 Token 拦截器，避免"刷新请求自己 401 又触发刷新"的递归
3. **`Lock`（synchronized 包）+ `_isRefreshing` 标记 + `Queue<Completer>`**：同一时刻只有一个刷新在飞；后续撞上 401 的请求挂进队列，刷新完成后统一唤醒重放
4. **失败冷却 + 402 强制登出**：刷新失败后 5 秒内不再尝试（防止 N 个请求连环打爆刷新接口造成雪崩）；refreshToken 也失效（402）时全局 logout 清态回登录页

```dart
/// Token 自动刷新（真实项目实现精简版，核心约 100 行）
class ApiClient {
  static final ApiClient _instance = ApiClient._internal();
  factory ApiClient.instance() => _instance;

  final _dio = Dio(BaseOptions(connectTimeout: Duration(seconds: 8)));
  // 刷新专用 dio：不带 Token 拦截器，避免递归触发刷新
  final _tokenDio = Dio(BaseOptions(connectTimeout: Duration(seconds: 8)));

  final _lock = Lock(reentrant: false);        // synchronized 包
  bool _isRefreshing = false;                  // 是否正在刷新
  bool _isRefreshFailed = false;               // 刷新失败标记
  int? _refreshFailedTime;                     // 失败时间戳：5 秒冷却防雪崩
  final Queue<Completer> _requestQueue = Queue(); // 挂起等待刷新的并发请求

  ApiClient._internal() {
    _dio.interceptors.add(TokenHeaderInterceptor());
    _dio.interceptors.add(InterceptorsWrapper(onResponse: _onResponse));
  }

  /// 拦"业务码 401"：HTTP 200 但 code == 401 表示 token 过期
  Future<void> _onResponse(
      Response response, ResponseInterceptorHandler handler) async {
    if (HttpDefine.isTokenNeedsRefresh(response.data) == false) {
      handler.next(response);
      return;
    }
    // 已有刷新在飞：当前请求挂进队列等结果
    if (_isRefreshing) {
      final completer = Completer();
      _requestQueue.add(completer);
      final ok = await completer.future;
      if (ok) {
        handler.resolve(await _retryRequest(response.requestOptions));
      } else {
        handler.next(response); // 刷新失败：原样放行，由上层统一提示
      }
      return;
    }
    await _lock.synchronized(() async {
      // 冷却期内直接放行，避免请求风暴反复打刷新接口
      if (_isRefreshFailed && _isInCoolDown()) {
        handler.next(response);
        return;
      }
      _isRefreshing = true;
      try {
        final (ok, code) = await _requestToken();
        if (ok) {
          _isRefreshFailed = false;
          _refreshFailedTime = null;
          _processQueue(true); // 唤醒所有等待请求重放
          handler.resolve(await _retryRequest(response.requestOptions));
        } else {
          _isRefreshFailed = true;
          _refreshFailedTime = DateTime.now().millisecondsSinceEpoch;
          _processQueue(false);
          if (code == 402) {
            // refreshToken 也失效：强制登出，清态回登录页
            AppGlobal.logout();
          }
          handler.next(response);
        }
      } catch (e) {
        _isRefreshFailed = true;
        _refreshFailedTime = DateTime.now().millisecondsSinceEpoch;
        _processQueue(false);
        handler.next(response);
      } finally {
        _isRefreshing = false;
      }
    });
  }

  /// 用独立 dio 请求刷新接口
  Future<(bool, int)> _requestToken() async {
    final refreshToken = User.refreshToken ?? '';
    if (refreshToken.isEmpty) return (false, 402); // 未登录态直接判失效
    try {
      final res = await _tokenDio.post('/auth/refresh-token',
          queryParameters: {'refreshToken': refreshToken});
      final model = BaseResModel.fromJson(res.data,
          fromJsonT: (json) => UserTokenModel.fromJson(json));
      if (model.isSuccess && model.data != null) {
        // 内存与持久化同步更新（见下方 User 单例）
        User.instance().saveTokenInfo(model.data!);
        return (true, 0);
      }
      return (false, res.data['code'] == 402 ? 402 : -1);
    } catch (_) {
      return (false, -1); // 网络异常等：进入冷却
    }
  }

  /// 重放：必须用最新 token 重塞 header，不能复用旧 RequestOptions 里的值
  Future<Response> _retryRequest(RequestOptions requestOptions) async {
    final options = Options(
        method: requestOptions.method, headers: requestOptions.headers);
    options.headers?['Authorization'] = User.accessToken ?? '';
    return _dio.request(requestOptions.path,
        data: requestOptions.data,
        queryParameters: requestOptions.queryParameters,
        options: options);
  }

  void _processQueue(bool success) {
    while (_requestQueue.isNotEmpty) {
      _requestQueue.removeFirst().complete(success);
    }
  }

  bool _isInCoolDown() =>
      _refreshFailedTime != null &&
      DateTime.now().millisecondsSinceEpoch - _refreshFailedTime! < 5000;
}
```

配套的请求头拦截器除 token 外还要注入**设备头**——服务端的"一号多机"风控（登录时的 `bindOtherDevice` 分支）依赖同一套指纹：

```dart
/// 除 token 外还注入设备头：服务端"一号多机"风控（登录时的
/// bindOtherDevice 分支）依赖同一套指纹
class TokenHeaderInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = User.accessToken ?? '';
    if (token.isNotEmpty) options.headers['Authorization'] = token;
    options.headers['platform'] = Platform.isAndroid ? 'Android' : 'iOS';
    options.headers.addAll(
        {'appVersion': appVersion, 'platformVersion': osVersion, 'channel': channelId});
    handler.next(options);
  }
}
```

#### 用户态单例：内存与存储同步

刷新与登录写入的是同一个 `User` 单例，冷启动时从存储恢复，避免"刷新成功但重放仍带旧 token"的低级错误：

```dart
class User {
  static final User _instance = User._internal();
  factory User.instance() => _instance;
  User._internal() { _loadFromStorage(); } // 冷启动恢复登录态

  UserTokenModel? _tokenInfo;

  static String? get accessToken => instance()._tokenInfo?.accessToken;
  static String? get refreshToken => instance()._tokenInfo?.refreshToken;
  // isLogin 必须双 token 同时有效，半态视为未登录
  static bool get isLogin =>
      (accessToken ?? '').isNotEmpty && (refreshToken ?? '').isNotEmpty;

  void saveTokenInfo(UserTokenModel model) {
    _tokenInfo = model; // 内存 + get_storage 同步更新
    GetStorage().write('app.token_info', jsonEncode(model));
  }

  void _loadFromStorage() {
    final json = GetStorage().read<String>('app.token_info');
    if (json != null) _tokenInfo = UserTokenModel.fromJson(jsonDecode(json));
  }

  void clearData() {
    _tokenInfo = null;
    GetStorage().remove('app.token_info');
  }
}

/// token 模型：除双 token 外还挂 imToken（IM SDK 连接凭证，与业务 token
/// 生命周期解耦，刷新时服务端一并下发）、openid（微信绑定关系判定用）
class UserTokenModel {
  int? userId;
  String? accessToken;
  String? refreshToken;
  String? imToken;
  String? openid;
  DateTime? expiresTime;
}
```

登录成功与强制登出的全局收口（402 分支最终调用的就是它）：

```dart
class AppGlobal {
  /// 登录成功：上报设备信息与推送 ID 后清栈进主页
  static void loginSuccess() {
    reportDeviceInfo();     // 设备指纹：机型/系统/渠道/是否模拟器
    reportPushRegisterId(); // 推送 registrationId 与账号绑定
    navigator.offAll(MainPage());
  }

  /// 全局登出：IM 退出 → 清用户态 → 清路由栈回登录页
  static void logout() {
    imManager.logout();
    User.instance().clearData();
    navigator.offAll(LoginPage());
  }
}
```

#### refresh_token 轮换策略

| 策略 | 说明 | 安全性 |
|------|------|--------|
| 不轮换 | refresh_token 永不过期 | 低（泄露后永久有效） |
| 单次轮换 | 每次 refresh 后返回新的 refresh_token，旧的作废 | 中高（泄露后最多用一次） |
| 滑动过期 | 每次使用 refresh_token 后延长过期时间 | 中 |

**推荐：单次轮换**。每次 refresh 返回新的 refresh_token，旧的一次性作废。如果检测到已作废的 refresh_token 被使用，说明可能泄露，应撤销该用户所有 Token。

---

## 常见坑

### 坑1：微信登录/分享回调 Activity

[Android] 微信的回调必须在 `包名.wxapi.WXEntryActivity`（登录）和 `包名.wxapi.WXPayEntryActivity`（支付）中接收。类名、包名写错一位字符，回调静默丢失，没有任何报错提示。

### 坑2：Apple Sign In 首次授权后的信息丢失

[iOS] Apple Sign In 只在首次授权时返回 email 和 fullName，后续授权只返回 userIdentifier。如果首次授权时没有保存，这些信息永久丢失。必须在首次授权时立即将 email 和 fullName 上报服务端。

### 坑3：Token 刷新并发重入

多个并发请求同时发现 Token 过期时，会同时发起 refresh。如果不加锁，多次 refresh 可能导致先拿到的 Token 被后续的 refresh 作废。真实项目的完整防线有三层：`Lock` 保证同一时刻只有一个刷新在飞；后续 401 的请求挂进 `Queue<Completer>` 等待唤醒后重放，且重放时必须用最新 token 重塞 header（不能复用旧 RequestOptions 里的值）；刷新失败后设 5 秒冷却，防止一个瞬时故障引发所有请求连环重试打爆刷新接口。另一个易漏点：如果服务端把 401 放在业务码里（HTTP 200），拦截逻辑要写在 `onResponse` 而不是 `onError`。

### 坑4：iOS 强制 Apple Sign In

[iOS] 如果 App 支持微信/QQ 登录但没提供 Apple Sign In，Apple 审核会直接拒绝。解决方案要么加上 Apple Sign In，要么只保留手机号/邮箱登录。不能只提供第三方社交登录。

### 坑5：Universal Link 配置

[iOS] 微信登录和分享在 iOS 上依赖 Universal Link 回调。如果 apple-app-site-association 文件配置有误、域名未验证、或 HTTPS 证书有问题，授权后无法跳回 App。特别注意：**微信登录回调对 UL 的依赖最致命**——分享收不到回调只是没提示，登录收不到 code 则整个流程直接卡死。fluwx 初始化时记得调 `attemptToResumeMsgFromWx()`，处理"微信回调到达时 App 是冷启动"的场景。必须用 Apple 的验证工具检查配置。

### 坑6：审核模式开关双端不同步

[双端] 混合开发中，Flutter 与原生容器各自消费审核状态。如果只在 Flutter 侧拉取开关、不通过 MethodChannel 同步给原生，会出现"Flutter 页面隐藏了登录入口、原生 tabbar 还展示运营位"的不一致，审核员看到任何一个漏网入口都会拒审。正确做法是开关只拉取一次、集中存储，拿到结果后无论成败都通知原生，且默认值按审核态 fail-safe。

### 坑7：Mob 隐私合规提交时机

[双端] Mob ShareSDK 初始化前必须先提交隐私合规授权（`uploadPrivacyPermissionStatus(1)`），再执行 `ShareSDKRegister` 注册平台。顺序反了在部分机型上会静默初始化失败；而且这个提交必须在用户同意 App 隐私协议之后执行，否则工信部合规检测会判定"未经同意收集信息"。真实项目把 ShareSDK 做成惰性初始化：首次分享时才 init，天然保证在隐私弹窗之后。

### 坑8：isClientInstalled 返回值双端类型不一致

[双端] `SharesdkPlugin.isClientInstalled` 在 Android 上返回 `Map`（values 里包含 `"installed"` 字符串），在 iOS 上返回 `bool`。只按一种类型解析，另一端必然误判"未安装"，分享入口直接被拦掉。必须做双类型兼容，并对"未安装"给用户明确提示而不是静默失败。

---

## 面试追问

### iOS 为什么必须支持 Apple Sign In？

Apple 审核指南 4.8 规定：如果 App 支持任何第三方社交登录服务，就必须同时提供 Sign in with Apple。这是 Apple 保护用户隐私的措施——第三方登录可能追踪用户行为，而 Apple Sign In 提供隐藏邮箱功能，让用户可以选择不暴露真实邮箱。唯一的例外是 App 不使用任何第三方社交登录（只用手机号/邮箱），此时不需要 Apple Sign In。

### Token 过期怎么处理？

标准做法是双 Token 机制：短期 access_token（2h）+ 长期 refresh_token（30d）。API 请求携带 access_token，过期后自动用 refresh_token 换新的并重试请求。生产实现有四个关键点：1) 若服务端把"token 过期"放在 HTTP 200 的业务码里返回，要拦 `onResponse` 而非 `onError`；2) 刷新用独立 Dio 实例，避免刷新请求自身触发刷新递归；3) 并发竞态用"锁 + 请求队列"解决——多个请求同时撞上过期时，只放一个刷新在飞，其余挂进 `Queue<Completer>`，刷新完成后统一唤醒并重放（重放必须重塞最新 token）；4) 刷新失败要设冷却期（如 5 秒）防止请求风暴打爆刷新接口；refreshToken 也失效时全局登出、清用户态、回登录页。

### 第三方登录的账号合并怎么做？

同一用户可能用微信登录和手机号登录，产生两个账号。合并策略：1) 服务端维护 `user_auths` 表，一个用户可以有多个绑定（微信 openid、手机号、Apple userIdentifier）；2) 登录时先查 `user_auths` 表，有匹配则关联已有用户；3) 新用户注册时提供"绑定已有账号"入口；4) 合并时需处理数据冲突（如两个账号都有订单，需迁移到同一账号下）。关键是登录时不直接创建新用户，而是提供"绑定"流程。

### 微信分享和微信登录共用一个 SDK 吗？

是的，微信开放平台的 SDK 同时支持登录、分享、支付，统称微信 OpenSDK。在 Flutter 侧通常通过 fluwx 插件统一管理。但登录和分享的回调机制不同：登录通过 `WXEntryActivity` 的 `onResp` 回调（type = `SEND_AUTH`），分享通过同一个 `WXEntryActivity` 的 `onResp` 回调（type = `SEND_MESSAGE_TO_WX`），需要在回调中区分类型分别处理。fluwx 侧的对应做法是 `addSubscriber` 订阅全局响应流，按 `WeChatAuthResponse`/`WeChatShareResponse`/`WeChatPaymentResponse` 类型分发到各自的 Completer。

### 第三方分享为什么用"双 SDK"而不是 ShareSDK 一把梭？

微信直连 fluwx、QQ/微博走 Mob ShareSDK 是经过生产验证的折中：微信是分享量最大的平台，fluwx 对回调链路、Universal Link、参数模型的维护远比 ShareSDK 及时，微信必须直连；QQ/微博使用频次低，单独维护原生插件性价比不高，ShareSDK 一把接入最省成本。代价是 ShareManager 内部要维护一个"微信类型走 fluwx 分支"的分发，以及两套回调转 Future 的适配（fluwx 用响应流分发、ShareSDK 用 SSDKResponseState 回调），但这些差异全部收敛在 manager 内部，业务层无感知。

### 审核模式开关怎么设计？要注意什么？

审核模式是服务端下发的"过审形态"总开关：客户端冷启动带渠道号+版本号请求审核状态接口，据此控制登录方式、运营位等入口的显隐。设计要点：1) fail-safe——接口失败时默认按审核期处理，宁可多隐藏不可漏隐藏；2) 持久化 + 网络恢复重试，保证离线冷启动也能拿到上次状态；3) 双端同步——混合开发中 Flutter 拿到状态后必须通过 MethodChannel 同步给原生容器，否则双端行为不一致；4) 开关粒度要克制，只控制显隐，不要用它下发业务逻辑。

### 设计一个统一登录架构，如何处理多平台差异、Token 管理和账号合并？

1. **统一抽象层**：`AuthService` 接口 + `LoginStrategy` 策略模式，每个登录方式一个策略实现，业务层只调 `AuthService.login(method)`
2. **Token 管理**：安全存储（Keychain/EncryptedSharedPreferences）+ 双 Token 机制 + 并发安全的刷新管理器（Completer 加锁）+ HTTP 拦截器自动 401 重试
3. **账号合并**：服务端 `user_auths` 表关联多绑定，登录时先查已有绑定，未匹配时走注册+绑定流程，提供"绑定已有账号"入口
4. **平台差异**：iOS 自动展示 Apple Sign In 选项（Android 不展示），微信/QQ 登录前检测是否安装，未安装时隐藏对应选项
5. **降级方案**：第三方登录失败时降级到手机号登录，确保用户始终能登录
6. **安全**：refresh_token 单次轮换，检测泄露时撤销所有 Token；所有第三方登录的 code/token 交换在服务端完成

---

## 参考资源

- [微信开放平台](https://open.weixin.qq.com/)
- [QQ 互联](https://connect.qq.com/)
- [Sign in with Apple 官方文档](https://developer.apple.com/documentation/sign_in_with_apple)
- [fluwx Flutter 插件](https://pub.dev/packages/fluwx)
- [sign_in_with_apple Flutter 插件](https://pub.dev/packages/sign_in_with_apple)
- [Mob ShareSDK（sharesdk_plugin）](https://pub.dev/packages/sharesdk_plugin)
- [flutter_secure_storage](https://pub.dev/packages/flutter_secure_storage)
- [synchronized（Dio 刷新防并发锁）](https://pub.dev/packages/synchronized)
- [screenshot（长图/海报截图）](https://pub.dev/packages/screenshot)
- [OAuth 2.0 RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
