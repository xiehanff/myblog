---
title: Flutter 企业开发实践10-iOS推送
date: 2026-05-18
tags: [Flutter, 面试, 架构, iOS推送, APNs, 静默推送, 推送扩展, JPush, 极光]
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

本篇在通用机制之外，穿插某已上线半年的 Flutter 混合开发项目的工程实践：jpush_flutter 插件托管 APNs 注册（宿主 AppDelegate 零手写推送代码）、点击通知冷启动时 launchOptions 的补偿链路、以及一份上线前 entitlements 检查清单。

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

#### 设备 Token 获取：自建插件 vs 插件托管

[iOS] Token 获取的标准链路是：申请权限 → `registerForRemoteNotifications` → APNs 下发 deviceToken → 上报服务端。落到 Flutter 工程上有两条路线：

| 路线 | 做法 | 适用 |
|------|------|------|
| 自建插件 | 自己写 FlutterPlugin：UNUserNotificationCenterDelegate + didRegisterForRemoteNotificationsWithDeviceToken | 深度定制、多服务商 |
| 插件托管（真实项目采用） | 直接用 jpush_flutter 等成熟插件，由插件 hook AppDelegate 完成注册 | 单一服务商、快速上线 |

自建路线的核心代码——也是托管模式在幕后替你做的事，排查"收不到 Token"时要能看懂：

```swift
// iOS 原生端（自建插件核心逻辑）
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

##### 插件托管注册：宿主 AppDelegate 零手写代码

某已上线半年的 Flutter 混合开发项目采用 jpush_flutter 3.3.9（iOS Pods：JPush 5.9.0 + JCore 5.4.0），宿主 AppDelegate.m 中**没有一行手写的推送注册代码**——插件注册时 hook 了 AppDelegate 生命周期，自动完成 APNs 注册与 JPush SDK 初始化，宿主只管 window 与混合栈初始化：

- 权限申请在 Dart 侧一行触发：`jPush.applyPushAuthority(const NotificationSettingsIOS(sound: true, alert: true, badge: true))`
- deviceToken 从回调流拿到：`onReceiveDeviceToken` 里持久化，随后随 registrationId 一起上报服务端
- `jPush.setup(production: true)` 决定 JPush 侧走 APNs 生产通道，必须与打包环境一致

托管模式的收益是原生工程零推送维护成本；代价是注册时机、通知代理优先级这些细节被封装——出问题时先查插件版本与这几个参数，再往系统层查。

#### 上线前检查清单（真实项目踩坑版）

| 检查项 | 要求 | 不满足的后果 |
|--------|------|-------------|
| Entitlements 的 aps-environment | App Store/TestFlight 包必须为 `production` | development 环境注册的 token 在生产通道收不到推送，且**没有任何编译期报错**——某项目上线前自查发现该项遗留 development，惊出一身冷汗 |
| setup 的 production 参数 | Dart 侧 `jPush.setup(production: true)` | 传 false 时调试行为与生产不一致，问题拖到线上才暴露 |
| 推送证书与打包环境 | .p8/.p12、provisioning 与打包方式（Debug/Ad hoc/App Store）匹配 | 推送静默失败：注册成功、发送成功、就是收不到 |
| badge 清零时机 | 初始化时 `setBadge(0)` + 点击通知时 `setBadge(0)` | 角标残留，用户反感 |

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
2. **payload 大小限制**：通过 APNs 发送的常规远程通知 payload 上限为 4KB，超过会被拒绝
3. **授权与投递是两件事**：关闭 alert/sound/badge 授权不等于可靠收到后台通知；后台通知本来就是低优先级且不保证投递，用户强制退出 App 后系统也不会继续唤醒它
4. **低电量模式**：iOS 低电量模式下后台通知可能被延迟或丢弃

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

跨平台推送架构的核心挑战是：**iOS 走 APNs，Android 走厂商通道或聚合通道，两端能力不对等。** 抽象层需要：

1. **统一消息模型**：两端的消息格式差异由抽象层消化
2. **能力降级**：iOS 不支持的功能需要优雅降级
3. **Token 统一管理**：两端 Token 格式和获取时机不同，抽象层统一上报

#### 真实项目的落地形态：一个 Manager 收敛五大职责

某已上线半年的 Flutter 混合开发项目没有先造抽象接口，而是让一个 JPushManager 单例同时服务双端（极光在 iOS 之上封装 APNs），把跨端差异全部消化在内部，业务层完全无感知（完整实现见 09-Android推送篇第 6 节）：

| 职责 | iOS 行为 | Android 行为 | 统一出口 |
|------|---------|-------------|---------|
| 初始化 | setup(production: true)，插件自动注册 APNs | setup 建立极光长连接 | setupJPush() |
| 权限 | applyPushAuthority(alert/sound/badge) | permission_handler 动态申请（13+） | setup 内部按 Platform 分支 |
| 标识上报 | registrationId + deviceToken | registrationId | 持久化 + 登录后补报 |
| 通知点击路由 | userInfo 根节点即业务字段 | extras['cn.jpush.android.EXTRA']（可能是 JSON 字符串） | 统一 PushModel + jumpTo 分发 |
| 冷启动补偿 | 提取远程通知 payload + MethodChannel 拉取 | 原生启动数据拉取 | _getLaunchData()（见下一节） |

```dart
/// 双端共用的推送管理器骨架
class JPushManager {
  static late JPushFlutterInterface jPush;
  static PushModel? pushModel; // 待消费的点击/冷启动数据

  // 职责 1+2：setupJPush 初始化与权限（内部按 Platform 分支）
  // 职责 3：registrationId 持久化 + 登录成功后补报
  // 职责 4：通知点击路由（守卫 → 解析 → popUntil 主页 → type 分发）
  // 职责 5：冷启动补偿（_getLaunchData，见第 6 节）
}
```

这五个职责是推送抽象层的"最小完备集"：少任何一条都会在某个场景掉链子——没有冷启动补偿，点通知冷启动就白点；没有登录补报，服务端永远拿不到最新 registrationId。若未来真的要接多服务商，再在这一层之下按 PushService 接口拆分 iOS/Android 实现，业务层代码不动。

#### 平台差异处理策略

| 能力 | iOS | Android | 抽象层策略 |
|------|-----|---------|-----------|
| 透传消息 | 静默推送（受限） | 厂商 SDK 支持 | 统一为 data 消息，iOS 降级为静默推送 |
| 富媒体通知 | Notification Extension | 自定义布局 | 抽象层标记 isRichMedia，iOS 走 Extension |
| 通知点击跳转 | UNUserNotificationCenter | Intent 路由 | 统一为 URI Scheme 跳转 |
| 后台保活 | 不允许 | 可做 | 不抽象此能力 |
| Token 获取 | 注册后异步回调 | 注册后异步回调 | 统一 onTokenRefresh 回调 |

```dart
/// 工厂方法：真实项目双端共用 JPushManager，暂不需要工厂
/// 多服务商场景下的演进方向
PushService createPushService() {
  if (Platform.isIOS) return IOSPushService();
  if (Platform.isAndroid) return AndroidPushService();
  throw UnsupportedError('Unsupported platform');
}
```

---

### 6. 冷启动推送链路：launchOptions 的补偿方案

#### 问题：点击通知冷启动时，回调还没注册

[iOS] 用户点击通知拉起 App（冷启动）时，通知数据在 `launchOptions[UIApplicationLaunchOptionsRemoteNotificationKey]` 里；但此刻 Flutter Engine 刚启动，`addEventHandler` 还没注册，onOpenNotification 自然收不到——**冷启动点通知"没反应"，是 iOS 推送接入最容易漏掉的场景**（测试时 App 多半在后台，走的是热启动回调，一测就"过"了）。

```
点击通知 → iOS 冷启动拉起 App（launchOptions 携带通知数据）
        → Flutter Engine 启动 → 此刻才注册 addEventHandler（已错过回调）
        → 通知数据静静躺在 launchOptions 里，无人消费
```

#### 真实方案：原生缓存 + MethodChannel 主动拉取

某已上线半年的 Flutter 混合开发项目采用三步方案：**AppDelegate 从 launchOptions 提取远程通知 payload → 自建 MethodChannel 暴露 getLaunchData 并 clear-on-read → Flutter 推送初始化完成后主动拉取，走统一路由分发。**

第 1 步 [iOS]：AppDelegate 只缓存远程通知 payload：

```objective-c
// AppDelegate.h
@interface AppDelegate : FlutterAppDelegate <UIApplicationDelegate>
@property(nonatomic, strong) NSDictionary *pendingRemoteNotification;
@end

// AppDelegate.m 的 didFinishLaunchingWithOptions 中
_pendingRemoteNotification =
    launchOptions[UIApplicationLaunchOptionsRemoteNotificationKey];
// 只缓存远程通知 payload，不把 URL、UIApplication 等其他启动对象送进 Channel
// 其余只做 window / 混合栈初始化：没有任何手写推送代码（注册由插件托管，见第 1 节）
```

第 2 步 [iOS]：在原生桥接类 NativeFlutterBridge 的 MethodChannel（如 `com.example.app.method.channel`）里加一个 case，读取后立即清空缓存：

```objective-c
- (void)handleMethodCall:(FlutterMethodCall *)call result:(FlutterResult)result {
    if ([call.method isEqualToString:@"getLaunchData"]) {
        AppDelegate *app = (AppDelegate *)UIApplication.sharedApplication.delegate;
        NSMutableDictionary *res = [NSMutableDictionary new];
        NSDictionary *payload = app.pendingRemoteNotification;
        app.pendingRemoteNotification = nil; // clear-on-read：原生侧保证只消费一次
        if (payload == nil) {
            res[@"code"] = @1; res[@"msg"] = @"没有推送数据";
        } else {
            res[@"code"] = @0; res[@"msg"] = @"成功";
            res[@"data"] = payload;
        }
        result(res);
    }
}
```

第 3 步 [双端]：Flutter 在推送初始化（setupJPush）末尾主动拉取并解析：

```dart
static void _getLaunchData() async {
  final res = await NativeInteractiveManager.instance()
      .nativeInvokeMethod(type: NativeMethodType.getLaunchData);
  if (!res.isSuccess) return; // 正常启动：没有推送数据

  if (Platform.isAndroid) {
    // Android 冷启动：启动参数里取极光附加字段，再取业务 extras（可能是 JSON 字符串）
    dynamic jMessageExtra = res.data?['JMessageExtra'];
    if (jMessageExtra is String) jMessageExtra = jsonDecode(jMessageExtra);
    pushModel = PushModel.fromJson(jMessageExtra['n_extras']);
  } else {
    // iOS 原生已提取并 clear-on-read，这里只接收 APNs payload
    final payload = res.data;
    if (payload is! Map) return;
    pushModel = PushModel.fromJson(payload);
  }
  // 之后与热启动共用同一套守卫 + jumpTo 分发（见第 5 节职责 4）
}
```

四个关键细节：

1. **拉取时机**放在 setupJPush 末尾——太早（引擎/通道未就绪）调用失败，太晚用户已停留在首页才跳走
2. **解析差异**：iOS 在原生侧只提取 `UIApplicationLaunchOptionsRemoteNotificationKey` 对应 payload；Android 走 `JMessageExtra → n_extras`，且字段可能是 JSON 字符串，要兼容 String/Map 两种类型
3. **统一出口**：冷启动解析出的 PushModel 与热启动（onOpenNotification）共用同一个 jumpTo 分发，冷热行为一致
4. **一次性消费**：原生返回前先 clear pending payload，Dart 跳转完成后再把 pushModel 置空；两层防线避免 setup 重试或页面重建导致重复跳转

#### 整体时序

```
冷启动点击通知
  │
  ▼
AppDelegate.didFinishLaunching ──提取并缓存──▶ remote notification payload
  │
  ▼
Flutter Engine 启动 → 首帧 → 用户隐私同意已确认、渠道配置就绪（见 09 篇第 7 节）
  │
  ▼
JPushManager.setupJPush() ──getLaunchData──▶ MethodChannel ──▶ NativeFlutterBridge
  │                                              │
  ▼◀──────────── payload 返回并在原生清空 ───────┘
解析 PushModel → 守卫 → jumpTo 统一分发
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

### 坑6：aps-environment 遗留 development，生产收不到推送

[iOS] Entitlements 里的 `aps-environment` 决定 App 注册的是开发还是生产 APNs 通道。Xcode 自动签名调试时常把它置为 `development`；打 App Store/TestFlight 包时如果没检查，**不会有任何编译期报错**，但 token 注册到的是开发通道，生产推送永远收不到——注册成功、服务端发送也返回成功，唯独用户手机不响。某上线半年的项目发版前自查时发现该项遗留 development，从此把它列入发版检查清单：

```xml
<!-- 上线前必查：App Store/TestFlight 包必须为 production -->
<dict>
    <key>aps-environment</key>
    <string>production</string>
</dict>
```

### 坑7：推送证书与打包环境不匹配

[iOS] 推送能否送达取决于三方匹配：Entitlements 的 aps-environment、推送凭证、APNs endpoint 与打包方式（Debug/Ad hoc/App Store）。`.p8` 简化了证书生命周期和多 App 密钥管理，但不代表可以忽略 Sandbox/Production：设备 token 与服务端连接环境仍要匹配。排查时分别核对签名后的 entitlement、token 来源、JPush/APNs 环境参数与服务端发送 endpoint（见坑1 与第 1 节检查清单）。

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

###  点击推送冷启动 App 时，Flutter 侧怎么拿到通知数据？

冷启动时通知数据在 iOS 的 launchOptions / Android 的启动 Intent 里，而 Flutter 的推送回调此时还没注册。方案：iOS 原生在 didFinishLaunching 只提取远程通知 payload，自建 MethodChannel 暴露 clear-on-read 的 getLaunchData；Flutter 在推送初始化完成后主动拉取一次，解析成统一消息模型后走与热启动相同的路由分发。这个"冷启动补偿"最容易被漏掉——不做的话，测试时 App 在后台点通知正常，冷启动点通知却没反应。

###  如果让你设计一个跨平台推送架构，如何处理两端能力差异？

核心策略是"抽象共性、降级差异"：1) 统一消息模型，两端的消息格式差异（如极光 Android 的 extras 嵌套 vs iOS 的 userInfo）在平台实现层消化；2) 定义统一的 PushService 接口或单例 Manager，iOS 和 Android 各自实现/内部分支；3) 能力不对等时打能力标记（如 isRichMedia），不支持的平台优雅降级；4) Token 管理统一为回调 + 持久化 + 登录后补报；5) 不抽象两端都不可靠的能力（如后台保活）。真实项目的经验是：单服务商阶段用一个 Manager 收敛"初始化/权限/标识上报/点击路由/冷启动补偿"五大职责就够，等多服务商需求真实出现再拆接口——避免过度设计。

---

## 参考资源

- [Apple Push Notification Service 官方文档](https://developer.apple.com/documentation/usernotifications)
- [Setting Up a Remote Notification Server](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server)
- [Notification Service Extension 指南](https://developer.apple.com/documentation/usernotifications/modifying_content_in_newly_delivered_notifications)
- [APNs API Reference (Provider API)](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/sending-notification-requests-to-apns)
- [极光推送 iOS 集成文档](https://docs.jiguang.cn/jpush/client/iOS/ios_guide_new)
- [flutter_local_notifications 插件](https://pub.dev/packages/flutter_local_notifications)
