---
title: Flutter 企业开发实践14-登录与分享
date: 2026-05-18
tags: [Flutter, 面试, 架构, 登录, 分享, Apple Sign In, Token, 微信, 第三方登录]
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

#### 微信登录

```dart
// 微信登录
class WeChatLoginService {
  Future<WeChatLoginResult?> login() async {
    // 1. 检查微信是否安装
    final installed = await fluwx.isWeChatInstalled;
    if (!installed) {
      return null; // 引导用户安装或降级到其他登录方式
    }

    // 2. 发起授权请求
    final result = await fluwx.sendWeChatAuth(
      scope: 'snsapi_userinfo',
      state: _generateState(), // 防 CSRF
    );

    if (!result) return null;

    // 3. 等待授权回调（通过 fluwx 的回调流）
    final auth = await _waitForAuthCallback();
    if (auth == null) return null;

    // 4. 将 code 发送给服务端
    return WeChatLoginResult(code: auth.code, state: auth.state);
  }
}
```

**微信登录的坑**：
- 微信开放平台需要单独注册 App，审核约 1-3 个工作日
- 签名必须与开放平台注册的签名一致，Debug 签名和 Release 签名需分别配置
- [Android] 回调同样依赖 `wxapi/WXEntryActivity`，类名和包名必须严格匹配
- [iOS] Universal Link 配置错误会导致微信授权后无法跳回 App

#### QQ 登录

QQ 登录的流程与微信类似，但有以下差异：

| 维度 | 微信 | QQ |
|------|------|-----|
| SDK | fluwx | tencent_sdk |
| 授权方式 | OpenSDK | QQ 互联 SDK |
| 回调 | WXEntryActivity / Universal Link | onActivityResult / URL Scheme |
| openid 格式 | 28 位字符串 | 纯数字 |
| unionid | 支持（同主体 App 互通） | 不支持（QQ 无 unionid 概念） |

#### 微博登录

微博登录已逐渐边缘化，新项目通常不接。如果必须接入，注意：
- 微博 SDK 年久失修，Flutter 插件质量参差不齐
- 微博对第三方应用的审核较严格
- 微博开放平台 API 文档更新不及时

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
// Apple Sign In
class AppleSignInService {
  Future<AppleSignInResult?> signIn() async {
    if (!await AppleSignIn.isAvailable()) {
      return null; // iOS 13 以下不支持
    }

    final result = await AppleSignIn.performRequests([
      const AppleIdRequest(requestedScopes: [
        Scope.email,
        Scope.fullName,
      ])
    ]);

    switch (result.status) {
      case AuthorizationStatus.authorized:
        return AppleSignInResult(
          authorizationCode: result.credential?.authorizationCode,
          identityToken: result.credential?.identityToken,
          userIdentifier: result.credential?.userIdentifier,
          email: result.credential?.email,
          fullName: result.credential?.fullName,
        );
      case AuthorizationStatus.denied:
        return null;
      case AuthorizationStatus.cancelled:
        return null;
      case AuthorizationStatus.error:
        return null;
    }
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
# Python 示例：验证 Apple identity_token
import jwt

def verify_apple_identity_token(identity_token):
    # 1. 解码 JWT（不验证签名，先获取 header）
    header = jwt.get_unverified_header(identity_token)
    kid = header['kid']

    # 2. 从 Apple 公钥端点获取公钥
    public_key = get_apple_public_key(kid)

    # 3. 验证签名
    payload = jwt.decode(
        identity_token,
        public_key,
        algorithms=['RS256'],
        audience='com.yourapp.bundleid',  # 你的 Bundle ID
        issuer='https://appleid.apple.com',
    )

    # 4. 提取用户标识
    user_identifier = payload['sub']  # 唯一用户标识
    email = payload.get('email')
    email_verified = payload.get('email_verified', False)

    return {
        'user_id': user_identifier,
        'email': email,
        'email_verified': email_verified,
    }
```

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
enum LoginMethod {
  wechat,
  qq,
  apple,
  phone,
  email,
}

/// 登录结果
class AuthResult {
  final bool success;
  final String? accessToken;
  final String? refreshToken;
  final String? error;
  final UserInfo? userInfo;

  AuthResult({
    required this.success,
    this.accessToken,
    this.refreshToken,
    this.error,
    this.userInfo,
  });
}

/// 用户信息（统一模型）
class UserInfo {
  final String userId;
  final String? nickname;
  final String? avatarUrl;
  final String? email;
  final String? phone;

  UserInfo({
    required this.userId,
    this.nickname,
    this.avatarUrl,
    this.email,
    this.phone,
  });
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

#### 不这么做会怎样？

如果不做抽象层，每个页面的登录逻辑直接调用第三方 SDK：
- 新增登录方式时需要改所有页面的登录代码
- 无法统一处理登录异常、Token 存储、事件上报
- 切换登录 SDK（如从微信登录切到手机号登录）时影响面大

---

### 4. 第三方分享 SDK 接入

#### 分享架构

```
┌─────────────────────────────────┐
│        Flutter 业务层             │
│    ShareService (统一接口)        │
├─────────────────────────────────┤
│      share_plugin (Dart 侧)      │
│    MethodChannel 通信            │
├─────────────────────────────────┤
│      share_plugin (原生侧)       │
│  ┌──────┬──────┬──────┐         │
│  │微信  │ QQ  │ 微博 │         │
│  │Share │Share│Share │         │
│  └──────┴──────┴──────┘         │
└─────────────────────────────────┘
```

#### 统一分享接口

```dart
/// 分享内容模型
class ShareContent {
  final String title;
  final String? description;
  final String? imageUrl;
  final String? webUrl;
  final ShareMediaType mediaType;

  ShareContent({
    required this.title,
    this.description,
    this.imageUrl,
    this.webUrl,
    this.mediaType = ShareMediaType.webPage,
  });
}

enum ShareMediaType {
  text,
  image,
  webPage,
  video,
  miniProgram, // 微信小程序
}

/// 分享服务
abstract class ShareService {
  /// 分享到指定平台
  Future<ShareResult> share(SharePlatform platform, ShareContent content);

  /// 检查平台是否可用（如微信是否安装）
  Future<bool> isPlatformAvailable(SharePlatform platform);
}

enum SharePlatform {
  wechatSession,  // 微信好友
  wechatTimeline, // 微信朋友圈
  qq,
  weibo,
}

class ShareResult {
  final bool success;
  final String? error;

  ShareResult({required this.success, this.error});
}
```

#### 分享的坑

**坑1：微信分享缩略图大小限制**

[双端] 微信分享网页类型的缩略图不能超过 32KB。如果你的图片超过 32KB，微信会静默失败——不报错，只是不显示缩略图。需要在分享前压缩：

```dart
Future<Uint8List> compressThumbnail(Uint8List imageBytes) async {
  // 压缩到 32KB 以内
  var quality = 85;
  var compressed = imageBytes;
  while (compressed.lengthInBytes > 32 * 1024 && quality > 10) {
    compressed = await FlutterImageCompress.compressWithList(
      imageBytes,
      minHeight: 150,
      minWidth: 150,
      quality: quality,
    );
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

```dart
/// Token 安全存储
class TokenStorage {
  static const _accessTokenKey = 'access_token';
  static const _refreshTokenKey = 'refresh_token';

  /// 存储 Token
  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    // iOS: Keychain (flutter_secure_storage 默认)
    // Android: EncryptedSharedPreferences
    final storage = FlutterSecureStorage();
    await storage.write(key: _accessTokenKey, value: accessToken);
    await storage.write(key: _refreshTokenKey, value: refreshToken);
  }

  /// 读取 access_token
  Future<String?> getAccessToken() async {
    final storage = FlutterSecureStorage();
    return storage.read(key: _accessTokenKey);
  }
}
```

**绝对不要用 `SharedPreferences` 存储 Token**——Android 上 SharedPreferences 是明文 XML 文件，root 设备可直接读取。

#### Token 刷新的并发竞态问题

这是 Token 管理中最容易被忽略的问题：

**场景**：多个并发请求同时发现 access_token 过期，同时发起 refresh 请求。

```
请求A: access_token 过期 → refresh → 拿到新 token1 → 用 token1 发请求
请求B: access_token 过期 → refresh → 拿到新 token2 → 用 token2 发请求
请求C: access_token 过期 → refresh → 拿到新 token3 → 用 token3 发请求
```

问题：多次 refresh 可能导致第一次 refresh 拿到的 token1 立即被 token2 作废，后续用 token1 的请求全部失败。

**解决方案：加锁 + 请求队列**

```dart
/// Token 刷新管理器（解决并发竞态）
class TokenRefreshManager {
  Completer<String>? _refreshCompleter;

  /// 刷新 Token（并发安全）
  Future<String> refreshToken() async {
    // 如果已经有正在进行的 refresh 请求，等待同一个结果
    if (_refreshCompleter != null && !_refreshCompleter!.isCompleted) {
      return _refreshCompleter!.future;
    }

    // 发起新的 refresh 请求
    _refreshCompleter = Completer<String>();
    try {
      final newToken = await _doRefreshToken();
      _refreshCompleter!.complete(newToken);
      return newToken;
    } catch (e) {
      _refreshCompleter!.completeError(e);
      rethrow;
    } finally {
      _refreshCompleter = null;
    }
  }

  Future<String> _doRefreshToken() async {
    final refreshToken = await TokenStorage().getRefreshToken();
    if (refreshToken == null) {
      throw TokenExpiredException('No refresh token');
    }

    final response = await _apiClient.post('/auth/refresh', body: {
      'refresh_token': refreshToken,
    });

    if (response.success) {
      await TokenStorage().saveTokens(
        accessToken: response.data['access_token'],
        refreshToken: response.data['refresh_token'],
      );
      return response.data['access_token'];
    } else {
      // refresh_token 也过期，需要重新登录
      await _logout();
      throw TokenExpiredException('Refresh token expired');
    }
  }
}
```

#### HTTP 拦截器自动刷新

```dart
/// Dio 拦截器：自动刷新 Token
class AuthInterceptor extends Interceptor {
  final TokenRefreshManager _refreshManager = TokenRefreshManager();

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await TokenStorage().getAccessToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode == 401) {
      // Token 过期，尝试刷新
      try {
        final newToken = await _refreshManager.refreshToken();
        // 用新 Token 重试原请求
        final options = err.requestOptions;
        options.headers['Authorization'] = 'Bearer $newToken';
        final response = await _dio.fetch(options);
        handler.resolve(response);
      } catch (e) {
        // 刷新失败，跳转登录页
        _navigateToLogin();
        handler.reject(err);
      }
    } else {
      handler.next(err);
    }
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

## 常见坑与踩点

### 坑1：微信登录/分享回调 Activity

[Android] 微信的回调必须在 `包名.wxapi.WXEntryActivity`（登录）和 `包名.wxapi.WXPayEntryActivity`（支付）中接收。类名、包名写错一位字符，回调静默丢失，没有任何报错提示。

### 坑2：Apple Sign In 首次授权后的信息丢失

[iOS] Apple Sign In 只在首次授权时返回 email 和 fullName，后续授权只返回 userIdentifier。如果首次授权时没有保存，这些信息永久丢失。必须在首次授权时立即将 email 和 fullName 上报服务端。

### 坑3：Token 刷新竞态

多个并发请求同时发现 Token 过期时，会同时发起 refresh。如果不加锁，多次 refresh 可能导致先拿到的 Token 被后续的 refresh 作废。必须使用 Completer/锁机制保证同一时刻只有一个 refresh 请求。

### 坑4：iOS 强制 Apple Sign In

[iOS] 如果 App 支持微信/QQ 登录但没提供 Apple Sign In，Apple 审核会直接拒绝。解决方案要么加上 Apple Sign In，要么只保留手机号/邮箱登录。不能只提供第三方社交登录。

### 坑5：Universal Link 配置

[iOS] 微信登录和分享在 iOS 上依赖 Universal Link 回调。如果 apple-app-site-association 文件配置有误、域名未验证、或 HTTPS 证书有问题，授权后无法跳回 App。必须用 Apple 的验证工具检查配置。

---

## 面试追问

###  iOS 为什么必须支持 Apple Sign In？

Apple 审核指南 4.8 规定：如果 App 支持任何第三方社交登录服务，就必须同时提供 Sign in with Apple。这是 Apple 保护用户隐私的措施——第三方登录可能追踪用户行为，而 Apple Sign In 提供隐藏邮箱功能，让用户可以选择不暴露真实邮箱。唯一的例外是 App 不使用任何第三方社交登录（只用手机号/邮箱），此时不需要 Apple Sign In。

###  Token 过期怎么处理？

标准做法是双 Token 机制：短期 access_token（2h）+ 长期 refresh_token（30d）。API 请求携带 access_token，401 时自动用 refresh_token 换取新的 access_token 并重试请求。关键要处理并发竞态——多个请求同时发现 Token 过期时，必须加锁保证只发一次 refresh 请求，其他请求等待同一个结果。refresh_token 也过期时，跳转登录页让用户重新登录。

###  第三方登录的账号合并怎么做？

同一用户可能用微信登录和手机号登录，产生两个账号。合并策略：1) 服务端维护 `user_auths` 表，一个用户可以有多个绑定（微信 openid、手机号、Apple userIdentifier）；2) 登录时先查 `user_auths` 表，有匹配则关联已有用户；3) 新用户注册时提供"绑定已有账号"入口；4) 合并时需处理数据冲突（如两个账号都有订单，需迁移到同一账号下）。关键是登录时不直接创建新用户，而是提供"绑定"流程。

###  微信分享和微信登录共用一个 SDK 吗？

是的，微信开放平台的 SDK 同时支持登录、分享、支付，统称微信 OpenSDK。在 Flutter 侧通常通过 fluwx 插件统一管理。但登录和分享的回调机制不同：登录通过 `WXEntryActivity` 的 `onResp` 回调（type = `SEND_AUTH`），分享通过同一个 `WXEntryActivity` 的 `onResp` 回调（type = `SEND_MESSAGE_TO_WX`），需要在回调中区分类型分别处理。

###  设计一个统一登录架构，如何处理多平台差异、Token 管理和账号合并？

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
- [flutter_secure_storage](https://pub.dev/packages/flutter_secure_storage)
- [OAuth 2.0 RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
