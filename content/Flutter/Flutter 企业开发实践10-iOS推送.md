---
title: Flutter 企业开发实践10-iOS推送
date: 2026-05-18
tags: [Flutter, 面试, 架构, iOS推送, APNs, 静默推送, 推送扩展]
---

# iOS 推送

> iOS 推送与 Android 推送的底层机制完全不同——iOS 只有 APNs 一条通道，没有厂商通道碎片化的问题，但有自己独特的约束：证书体系复杂、推送扩展能力受限、用户拒收后无解。本篇从架构师视角拆解 iOS 推送全链路。

---

## 概述：iOS 推送解决什么问题？

iOS 推送的核心约束是：**Apple 不允许 App 在后台保持长连接。** 所有推送必须通过 APNs（Apple Push Notification service）中转。这看似是限制，实际上是 Apple 对推送生态的统一治理——一个通道、一套规则、一个证书体系。

与 Android 的核心差异：

| 维度 | iOS | Android (国内) |
|------|-----|---------------|
| 推送通道 | APNs 统一 | 厂商通道碎片化 |
| 后台保活 | 不允许 | 可做但不可靠 |
| 证书管理 | 复杂（p12/p8/pem） | 无证书概念 |
| 离线推送 | APNs 系统级保障 | 依赖厂商通道 |
| 透传/静默 | 有限制（payload 大小、频率） | 相对自由 |
| 富媒体 | 需 Notification Extension | 相对自由 |

---

## 核心内容

### 1. APNs 接入全流程：证书配置、设备 Token 获取

#### 证书体系：最让人头疼的入门门槛

[iOS] APNs 证书有三种格式，每种对应不同的接入方式：

| 类型 | 格式 | 有效期 | 适用场景 |
|------|------|--------|---------|
| 开发证书 (.p12) | PKCS12 | 1 年 | 开发调试 |
| 生产证书 (.p12) | PKCS12 | 1 年 | App Store 发布 |
| Token (.p8) | PKCS8 (API Key) | 永不过期 | 推荐，服务端免管理证书 |

**为什么推荐 .p8 Token？**

- .p12 证书每年过期，需要重新生成并更新服务端配置——如果忘记更新，所有推送瞬间全部失败
- .p8 Token 永不过期，基于 JWT 认证，服务端只需维护一个 Key ID + Team ID + Key 文件
- 缺点：.p8 Token 每小时需要重新生成 JWT Token，但服务端自动处理即可

#### 证书配置步骤

1. **Apple Developer Console** → Keys → 创建 APNs Key (.p8)
2. 记录 Key ID、Team ID
3. 下载 .p8 文件（**只能下载一次**，丢失需重新生成）
4. 服务端使用 .p8 文件生成 JWT：

```python
# Python 示例：生成 APNs JWT Token
import jwt, time

def generate_apns_token(key_path, key_id, team_id):
    with open(key_path, 'r') as f:
        key = f.read()
    token = jwt.encode(
        {'iss': team_id, 'iat': int(time.time())},
        key,
        algorithm='ES256',
        headers={'alg': 'ES256', 'kid': key_id}
    )
    return token
```

#### 设备 Token 获取

[iOS] 设备 Token 的获取必须在用户授权推送权限之后：

```dart
// Flutter 侧通过插件获取
class IOSPushService implements PushService {
  @override
  Future<String?> getToken() async {
    // 1. 先请求权限
    final granted = await _requestPermission();
    if (!granted) return null;

    // 2. 获取 Token
    final token = await _methodChannel.invokeMethod<String>('getAPNsToken');
    return token;
  }

  Future<bool> _requestPermission() async {
    final result = await _methodChannel.invokeMethod<bool>('requestNotificationPermission');
    return result ?? false;
  }
}
```

```swift
// iOS 原生端
class PushPlugin: NSObject, FlutterPlugin, UNUserNotificationCenterDelegate {
    func register(with registrar: FlutterPluginRegistrar) {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    // Token 回调
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        channel?.invokeMethod("onTokenReceived", arguments: token)
    }

    // 获取 Token 失败
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        channel?.invokeMethod("onTokenError", arguments: error.localizedDescription)
    }
}
```

#### Token 变化场景

[iOS] 以下场景会导致 Token 变化，必须重新上报：
- 用户卸载重装 App
- 用户恢复设备
- 用户升级 iOS
- **每次启动都应重新获取并上报**，这是最佳实践

---

### 2. 静默推送（Silent Push）与应用场景

#### 什么是静默推送？

[iOS] 静默推送是 APNs 的一种消息类型，不展示通知，只唤醒 App 在后台执行代码（最长 30 秒）。

```json
// 静默推送 payload
{
  "aps": {
    "content-available": 1
  },
  "data": {
    "action": "sync_messages",
    "conversationId": "abc123"
  }
}
```

关键点：
- `content-available: 1` 是静默推送的标识
- **不展示通知栏**，用户无感知
- App 在后台被唤醒，执行 `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`
- 系统保证唤醒但**不保证时机**（可能延迟几分钟到几小时）
- 后台执行时间上限 **30 秒**

#### 应用场景

| 场景 | 说明 |
|------|------|
| IM 消息同步 | 收到静默推送后拉取最新消息，等用户打开 App 时数据已就绪 |
| 内容预加载 | 新闻类 App 收到静默推送后预下载文章内容 |
| 数据同步 | 配置变更、账户状态变更通知 |
| Badge 更新 | 服务端通知 App 更新角标数字 |

#### 静默推送的限制

1. **不保证即时送达**：iOS 根据电量、网络、使用频率决定何时唤醒 App。频繁发静默推送可能被系统限流
2. **payload 大小限制**：静默推送 payload 无硬性大小限制，但建议 <4KB
3. **用户关闭推送后静默推送也不生效**：这是最常见的误解——用户关闭通知后，静默推送同样无法送达
4. **低电量模式**：iOS 低电量模式下静默推送会被延迟或丢弃

**不这么做会怎样？** 如果用静默推送做即时通讯的核心消息通道，用户会频繁遇到消息延迟，体验远不如直接用通知栏消息。静默推送应该作为**优化手段**而非**核心通道**。

---

### 3. 推送扩展：Notification Service Extension（富媒体推送）

#### 为什么需要推送扩展？

[iOS] 标准 APNs 通知只能显示文本，无法显示图片、视频、音频。如果要在通知中展示富媒体内容，必须通过 Notification Service Extension 处理：

```
APNs 推送到达 → 系统启动 NotificationServiceExtension
             → Extension 下载富媒体资源
             → 修改通知内容，附加附件
             → 系统展示带图片/视频的通知
```

#### Extension 接入

1. 在 Xcode 中添加 Notification Service Extension Target
2. 实现 `UNNotificationServiceExtension`：

```swift
class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let content = bestAttemptContent,
              let imageUrlString = content.userInfo["image_url"] as? String,
              let imageUrl = URL(string: imageUrlString) else {
            // 没有富媒体，直接展示
            contentHandler(request.content)
            return
        }

        // 下载图片
        let task = URLSession.shared.downloadTask(with: imageUrl) { [weak self] url, _, error in
            guard let self, let url, let content = self.bestAttemptContent else { return }
            // 将下载的文件移动到临时目录
            let tempDir = NSTemporaryDirectory()
            let tempPath = tempDir + "push_image.jpg"
            try? FileManager.default.moveItem(atPath: url.path, toPath: tempPath)
            // 创建附件
            if let attachment = try? UNNotificationAttachment(identifier: "image",
                                                               url: URL(fileURLWithPath: tempPath)) {
                content.attachments = [attachment]
            }
            contentHandler(content)
        }
        task.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        // 30 秒内未完成，系统调用此方法，必须尽快返回
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
```

#### 推送 Payload 格式

```json
{
  "aps": {
    "alert": {
      "title": "新消息",
      "body": "你收到了一条图片消息"
    },
    "mutable-content": 1,
    "category": "MESSAGE_CATEGORY"
  },
  "image_url": "https://example.com/image.jpg"
}
```

关键点：`mutable-content: 1` 告诉系统触发 Notification Service Extension。

#### Extension 的坑

1. **独立 Target**：Extension 是独立的可执行文件，有独立的 Bundle ID、独立的 Entitlements，不会继承主 App 的权限
2. **30 秒超时**：如果下载资源超时，必须返回未修改的通知内容
3. **内存限制**：Extension 内存约 24-30MB，下载大图片可能导致 OOM
4. **不支持自定义 UI**：Notification Service Extension 只能修改通知内容，自定义 UI 需要额外的 Notification Content Extension
5. **Flutter 插件冲突**：Extension Target 中不能引入 Flutter 框架，纯原生实现

---

### 4. 推送权限申请与用户拒收后的处理

#### 权限申请时机

[iOS] 推送权限申请的最佳实践是**不要在 App 启动时立即弹窗**，而是：

1. **场景触发**：用户进入聊天页、下单完成等场景时才请求权限，此时用户有明确预期
2. **预授权弹窗**：先展示自定义弹窗解释"为什么要推送"，用户同意后再调系统弹窗

```dart
// Flutter 侧预授权流程
class PushPermissionManager {
  /// 检查当前权限状态
  Future<PushPermissionStatus> checkStatus() async {
    final status = await _channel.invokeMethod<int>('checkPermissionStatus');
    return PushPermissionStatus.fromValue(status);
  }

  /// 请求推送权限（带预授权）
  Future<bool> requestWithPrePermission() async {
    // 1. 先检查是否已授权
    final status = await checkStatus();
    if (status == PushPermissionStatus.authorized) return true;
    if (status == PushPermissionStatus.denied) return false; // 已拒收，无法再弹

    // 2. 展示预授权弹窗
    final preGranted = await _showPrePermissionDialog();
    if (!preGranted) return false;

    // 3. 调用系统权限弹窗
    return await _requestSystemPermission();
  }
}
```

#### 用户拒收后的处理

[iOS] 一旦用户拒收推送权限，**无法再次弹出系统权限弹窗**。只能引导用户去系统设置中手动开启：

```dart
// 引导用户去设置
Future<void> openAppSettings() async {
  // iOS: 打开 App 设置页
  await _channel.invokeMethod('openNotificationSettings');
}
```

```swift
// iOS 原生
if let url = URL(string: UIApplication.openSettingsURLString) {
    UIApplication.shared.open(url)
}
```

#### 替代方案

用户拒收推送后，可以采用以下替代方案维持触达能力：

| 方案 | 说明 | 限制 |
|------|------|------|
| App 内消息中心 | 在 App 内展示未读消息 | 用户不打开 App 就看不到 |
| 短信验证码/通知 | 服务端通过短信通知 | 成本高，骚扰感强 |
| 邮件通知 | 低优先级场景 | 打开率极低 |
| 静默推送 | 期望在后台同步数据 | **用户关推送后同样不生效** |

**不这么做会怎样？** 不做预授权直接弹系统权限窗口，授权率可能低至 20-30%。做预授权可以将授权率提升到 50-60%。

---

### 5. Flutter 侧的统一推送抽象层设计

#### 设计目标

跨平台推送架构的核心挑战是：**iOS 走 APNs，Android 走厂商通道，两端能力不对等。** 抽象层需要：

1. **统一消息模型**：两端的消息格式差异由抽象层消化
2. **能力降级**：iOS 不支持的功能（如自定义通知样式）需要优雅降级
3. **Token 统一管理**：两端 Token 格式和获取时机不同，抽象层统一上报

```dart
/// 跨平台推送抽象层
abstract class PushService {
  /// 初始化推送
  Future<PushInitResult> init();

  /// 获取推送 Token
  Future<String?> getToken();

  /// Token 刷新回调
  void onTokenRefresh(void Function(String token) callback);

  /// 前台消息回调（App 在前台时收到推送）
  void onForegroundMessage(void Function(PushMessage message) callback);

  /// 后台消息回调（App 在后台时收到推送，点击通知唤起）
  void onBackgroundMessage(void Function(PushMessage message) callback);

  /// 请求推送权限
  Future<bool> requestPermission();

  /// 检查权限状态
  Future<PushPermissionStatus> checkPermission();
}

/// 统一消息模型
class PushMessage {
  final String messageId;
  final String? title;
  final String? body;
  final Map<String, dynamic> data;
  final PushMessageSource source;

  PushMessage({
    required this.messageId,
    this.title,
    this.body,
    required this.data,
    required this.source,
  });
}

/// 消息来源（用于统计）
enum PushMessageSource {
  apns,          // iOS APNs
  huawei,        // 华为推送
  xiaomi,        // 小米推送
  oppo,          // OPPO 推送
  vivo,          // vivo 推送
  customChannel, // 自建通道
}

/// 初始化结果
class PushInitResult {
  final bool success;
  final String? token;
  final String? error;
  final PushMessageSource source;

  PushInitResult({
    required this.success,
    this.token,
    this.error,
    required this.source,
  });
}
```

#### 平台差异处理策略

| 能力 | iOS | Android | 抽象层策略 |
|------|-----|---------|-----------|
| 透传消息 | 静默推送（受限） | 厂商 SDK 支持 | 统一为 data 消息，iOS 降级为静默推送 |
| 富媒体通知 | Notification Extension | 自定义布局 | 抽象层标记 isRichMedia，iOS 走 Extension |
| 通知点击跳转 | UNUserNotificationCenter | Intent 路由 | 统一为 URI Scheme 跳转 |
| 后台保活 | 不允许 | 可做 | 不抽象此能力 |
| Token 获取 | 注册后异步回调 | 注册后异步回调 | 统一 onTokenRefresh 回调 |

```dart
/// iOS 实现
class IOSPushService implements PushService {
  @override
  Future<PushInitResult> init() async {
    // 1. 请求权限
    final granted = await requestPermission();
    if (!granted) {
      return PushInitResult(success: false, error: 'Permission denied', source: PushMessageSource.apns);
    }
    // 2. 注册 APNs
    await _channel.invokeMethod('registerAPNs');
    return PushInitResult(success: true, source: PushMessageSource.apns);
  }
}

/// Android 实现（见 09-Android推送.md）
class AndroidPushService implements PushService {
  // ...
}

/// 工厂方法
PushService createPushService() {
  if (Platform.isIOS) return IOSPushService();
  if (Platform.isAndroid) return AndroidPushService();
  throw UnsupportedError('Unsupported platform');
}
```

---

## 常见坑与踩点

### 坑1：开发环境 vs 生产环境证书

[iOS] 开发证书和生产证书是分开的，Token 绑定环境。用开发证书的 Token 往生产 APNs 发推送会失败，反之亦然。调试时最常见的错误就是证书与环境不匹配。

### 坑2：模拟器不支持推送

[iOS] iOS 模拟器不支持接收 APNs 推送，所有推送测试必须用真机。开发阶段可以用 `xcrun simctl push` 模拟推送（仅限模拟器），但与真实 APNs 行为有差异。

### 坑3：Notification Extension 未签名

[iOS] Extension 是独立 Target，需要独立的 Provisioning Profile。如果 Extension 的签名配置有误，富媒体推送会静默降级为普通推送——不会有任何报错，只是图片不显示。

### 坑4：静默推送频率限制

[iOS] Apple 对静默推送有频率限制。如果短时间内发送过多静默推送，系统会逐步增加延迟，最终可能完全丢弃。Apple 文档未公开具体阈值，经验值是每小时不超过 2-3 条/设备。

### 坑5：iOS 15+ 通知摘要

[iOS] iOS 15 引入通知摘要功能，用户可以选择将通知"稍后显示"。这意味着即使推送成功送达，用户也可能在数小时后才看到。这属于平台行为，开发者无法控制，但需要理解——**推送到达 ≠ 用户感知**。

---

## 面试追问

###  iOS 推送和 Android 推送的核心差异是什么？

iOS 只有 APNs 一个通道，由系统级保障离线推送，不需要 App 自建长连接；Android（国内）需要接入多家厂商通道，碎片化严重。iOS 有证书体系，证书过期推送就会全部失败；Android 没有证书概念。iOS 不允许后台保活，Android 可以做但不可靠。iOS 有静默推送和 Notification Extension 等系统级扩展能力。

###  为什么推荐用 .p8 Token 而不是 .p12 证书？

.p12 证书每年过期，需要手动更新服务端配置，一旦遗忘就会导致全量推送失败；.p8 Token 永不过期，服务端用 JWT 认证，免去了证书管理的运维风险。唯一的代价是每小时需重新生成 JWT，但这是服务端自动处理的。

###  静默推送有什么限制？能用来做 IM 消息推送吗？

静默推送不展示通知、不保证即时送达、后台执行时间仅 30 秒、低电量模式下会被延迟或丢弃、用户关闭通知权限后同样失效。不适合做 IM 的核心消息通道，更适合作为优化手段——预先同步数据，让用户打开 App 时内容已就绪。IM 应该用通知栏消息保证可见性。

###  用户拒收推送权限后怎么办？

一旦拒收，系统权限弹窗无法再次弹出。只能通过 App 内引导（跳转系统设置页）让用户手动开启。最佳实践是在请求权限前先展示预授权弹窗解释推送用途，用户同意后再调系统弹窗，可以显著提升授权率。拒收后可降级为 App 内消息中心、短信等替代触达方式。

###  如果让你设计一个跨平台推送架构，如何处理两端能力差异？

核心策略是"抽象共性、降级差异"：1) 统一消息模型，两端的消息格式差异在平台实现层消化；2) 定义统一的 PushService 接口，iOS 和 Android 各自实现；3) 能力不对等时抽象层标记能力标记（如 isRichMedia），不支持的平台优雅降级；4) Token 管理统一为 onTokenRefresh 回调，两端各自的获取时机差异封装在实现层；5) 不抽象两端都不可靠的能力（如后台保活）。关键是让业务层写一套代码，不需要关心平台差异。

---

## 参考资源

- [Apple Push Notification Service 官方文档](https://developer.apple.com/documentation/usernotifications)
- [Setting Up a Remote Notification Server](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server)
- [Notification Service Extension 指南](https://developer.apple.com/documentation/usernotifications/modifying_content_in_newly_delivered_notifications)
- [APNs API Reference (Provider API)](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/sending-notification-requests-to-apns)
- [flutter_local_notifications 插件](https://pub.dev/packages/flutter_local_notifications)
