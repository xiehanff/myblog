---
title: Flutter 企业开发实践10-iOS推送
date: 2026-05-18
tags: [Flutter, 面试, 架构, iOS推送, APNs, 静默推送, 推送扩展, JPush, 极光]
---

# iOS 推送

> iOS 推送和 Android 推送底层完全是两套机制：iOS 就 APNs 一条通道，没有厂商通道碎片化那堆事，但自己的约束也不少：证书体系复杂、推送扩展能力受限、用户一旦拒收就没辙。这篇把 iOS 推送的整条链路拆开讲。

---

## 概述：iOS 推送解决什么问题？

iOS 推送最核心的约束就一条：**Apple 不让 App 在后台挂长连接。** 推送只能走 APNs（Apple Push Notification service）中转。这看着像限制，其实是 Apple 把整个推送生态统一管起来了：一个通道、一套规则、一个证书体系。

和 Android 的核心差异：

| 维度 | iOS | Android (国内) |
|------|-----|---------------|
| 推送通道 | APNs 统一 | 厂商通道碎片化 |
| 后台保活 | 不允许 | 可做但不可靠 |
| 证书管理 | 复杂（p12/p8/pem） | 无证书概念 |
| 离线推送 | APNs 系统级保障 | 依赖厂商通道 |
| 透传/静默 | 有限制（payload 大小、频率） | 相对自由 |
| 富媒体 | 要 Notification Extension | 相对自由 |

通用机制之外，这篇还会带上某个已上线半年的 Flutter 混合开发项目（下文简称"该项目"）的工程实践：jpush_flutter 插件托管 APNs 注册（宿主 AppDelegate 零手写推送代码）、点击通知冷启动时 launchOptions 的补偿链路，还有一份上线前 entitlements 检查清单。

---

## 核心内容

### 1. APNs 接入全流程：证书配置、设备 Token 获取

#### 证书体系：最让人头疼的入门门槛

[iOS] APNs 证书有三种格式，各自对应一种接入方式：

| 类型 | 格式 | 有效期 | 适用场景 |
|------|------|--------|---------|
| 开发证书 (.p12) | PKCS12 | 1 年 | 开发调试 |
| 生产证书 (.p12) | PKCS12 | 1 年 | App Store 发布 |
| Token (.p8) | PKCS8 (API Key) | 永不过期 | 推荐，服务端不用管证书 |

**为什么推荐 .p8 Token？**

- .p12 证书每年过期，到期得重新生成、更新服务端配置，忘了更新，所有推送当场全挂
- .p8 Token 永不过期，走 JWT 认证，服务端只要维护一个 Key ID + Team ID + Key 文件
- 缺点：.p8 Token 每小时要重新生成一次 JWT Token，这事服务端自动做掉就行

#### 证书配置步骤

1. **Apple Developer Console** → Keys → 创建 APNs Key (.p8)
2. 记录 Key ID、Team ID
3. 下载 .p8 文件（**只能下载一次**，丢了只能重新生成）
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

[iOS] 拿 Token 的标准链路是：申请权限 → `registerForRemoteNotifications` → APNs 下发 deviceToken → 上报服务端。落到 Flutter 工程上就两条路线：

| 路线 | 做法 | 适用 |
|------|------|------|
| 自建插件 | 自己写 FlutterPlugin：UNUserNotificationCenterDelegate + didRegisterForRemoteNotificationsWithDeviceToken | 深度定制、多服务商 |
| 插件托管（真实项目采用） | 直接用 jpush_flutter 等成熟插件，由插件 hook AppDelegate 完成注册 | 单一服务商、快速上线 |

自建路线的核心代码（托管模式在幕后替你干的也是这些事），排查"收不到 Token"的时候得能看懂：

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

该项目用的是 jpush_flutter 3.3.9（iOS Pods：JPush 5.9.0 + JCore 5.4.0），宿主 AppDelegate.m 里**没有一行手写的推送注册代码**：插件注册的时候 hook 了 AppDelegate 生命周期，APNs 注册和 JPush SDK 初始化它自己就做完了，宿主只管 window 和混合栈初始化：

- 权限申请在 Dart 侧一行就能触发：`jPush.applyPushAuthority(const NotificationSettingsIOS(sound: true, alert: true, badge: true))`
- deviceToken 从回调流里拿：`onReceiveDeviceToken` 里持久化，然后跟 registrationId 一起上报服务端
- `jPush.setup(production: true)` 决定 JPush 侧走 APNs 生产通道，这个值必须和打包环境一致

托管模式的好处是原生工程在推送这块零维护成本；代价是注册时机、通知代理优先级这些细节全被包起来了，出问题时先查插件版本和这几个参数，再往系统层查。

#### 上线前检查清单（真实项目踩坑版）

| 检查项 | 要求 | 不满足的后果 |
|--------|------|-------------|
| Entitlements 的 aps-environment | App Store/TestFlight 包必须为 `production` | development 环境注册的 token 在生产通道收不到推送，而且**没有任何编译期报错**，某个项目上线前自查发现这项还留着 development，惊出一身冷汗 |
| setup 的 production 参数 | Dart 侧 `jPush.setup(production: true)` | 传 false 调试行为和线上不一致，问题会拖到线上才暴露 |
| 推送证书与打包环境 | .p8/.p12、provisioning 与打包方式（Debug/Ad hoc/App Store）匹配 | 推送会悄悄失败：注册成功、发送成功，就是收不到 |
| badge 清零时机 | 初始化时 `setBadge(0)` + 点击通知时 `setBadge(0)` | 角标残留，用户反感 |

#### Token 变化场景

[iOS] 下面这些场景会让 Token 发生变化，必须重新上报：
- 用户卸载重装 App
- 用户恢复设备
- 用户升级 iOS
- **每次启动都该重新获取并上报**，这是最佳实践

---

### 2. 静默推送（Silent Push）与应用场景

#### 什么是静默推送？

[iOS] 静默推送是 APNs 里的一种消息类型，不弹通知，只把 App 唤醒到后台跑一段代码（最长 30 秒）。

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
- `content-available: 1` 是静默推送的标志
- **不弹通知栏**，用户没感觉
- App 在后台被唤醒，去跑 `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`
- 系统会唤醒它，但**不保证什么时候**（可能延迟几分钟到几小时）
- 后台能跑的时间上限 **30 秒**

#### 哪些场景会用它

| 场景 | 说明 |
|------|------|
| IM 消息同步 | 收到静默推送就去拉最新消息，等用户打开 App，数据已经准备好了 |
| 内容预加载 | 新闻类 App 收到静默推送，提前把文章内容下下来 |
| 数据同步 | 配置变了、账户状态变了，通知一下 |
| Badge 更新 | 服务端让 App 把角标数字更新一下 |

#### 静默推送的限制

1. **不保证即时送达**：什么时候唤醒 App 由 iOS 自己看着办，它看电量、看网络、看使用频率。静默推送发得太勤，还可能被系统限流
2. **payload 大小限制**：走 APNs 发的常规远程通知 payload 上限 4KB，超了直接拒
3. **授权和投递是两码事**：把 alert/sound/badge 授权关掉，不代表后台通知就能稳稳收到；后台通知本来就是低优先级、不保证投递，用户把 App 强制退出之后，系统也不会再去唤醒它
4. **低电量模式**：iOS 开低电量模式后，后台通知可能被延迟，也可能直接丢

**不这么做会怎样？** 拿静默推送当即时通讯的核心消息通道，用户会三天两头碰上消息延迟，体验还不如直接用通知栏消息。静默推送应该当**优化手段**来用，别把它当**核心通道**。

---

### 3. 推送扩展：Notification Service Extension（富媒体推送）

#### 为什么需要推送扩展？

[iOS] 标准 APNs 通知只能显示文字，图片、视频、音频都显示不了。想在通知里展示富媒体内容，就得靠 Notification Service Extension 来处理：

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
            // 把下载的文件挪到临时目录
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
        // 30 秒内没弄完，系统会调这个方法，得赶紧返回
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

关键点：`mutable-content: 1` 会让系统触发 Notification Service Extension。

#### Extension 的坑

1. **独立 Target**：Extension 是单独的可执行文件，Bundle ID、Entitlements 都是自己的，拿不到主 App 的权限
2. **30 秒超时**：资源下载超时了，就得把没改过的通知内容原样返回
3. **内存限制**：Extension 内存大概 24-30MB，下载大图有可能 OOM
4. **不支持自定义 UI**：Notification Service Extension 只能改通知内容，要自定义 UI 还得再来一个 Notification Content Extension
5. **Flutter 插件冲突**：Extension Target 里不能引 Flutter 框架，只能纯原生实现

---

### 4. 推送权限申请与用户拒收后的处理

#### 什么时候弹权限弹窗

[iOS] 推送权限申请，最佳实践是**别在 App 启动的时候就弹窗**，合适的时机是这两种：

1. **场景触发**：等用户进了聊天页、或者下完单再来要权限，这时候他心里有底
2. **预授权弹窗**：先拿自己的弹窗把"为什么要推送"解释清楚，用户点头了再调系统弹窗

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
    // 1. 先看有没有授权
    final status = await checkStatus();
    if (status == PushPermissionStatus.authorized) return true;
    if (status == PushPermissionStatus.denied) return false; // 已经拒收过了，弹不出来

    // 2. 弹预授权弹窗
    final preGranted = await _showPrePermissionDialog();
    if (!preGranted) return false;

    // 3. 调系统权限弹窗
    return await _requestSystemPermission();
  }
}
```

#### 用户拒收之后怎么办

[iOS] 用户一旦拒收推送权限，**系统权限弹窗就再也弹不出来了**，只能引导他去系统设置里手动开：

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

用户拒收推送之后，还有这些替代方案能保住触达能力：

| 方案 | 说明 | 限制 |
|------|------|------|
| App 内消息中心 | 在 App 里展示未读消息 | 用户不打开 App 就看不到 |
| 短信验证码/通知 | 服务端通过短信通知 | 成本高，骚扰感强 |
| 邮件通知 | 低优先级场景 | 打开率极低 |
| 静默推送 | 想借它在后台同步数据 | **用户关推送后同样不生效** |

**不这么做会怎样？** 不做预授权、上来就弹系统权限窗口，授权率可能只有 20-30%。做了预授权，能提到 50-60%。

---

### 5. Flutter 侧的统一推送抽象层设计

#### 设计目标

跨平台推送架构最麻烦的地方是：**iOS 走 APNs，Android 走厂商通道或者聚合通道，两端能力不对等。** 抽象层得管三件事：

1. **统一消息模型**：两端的消息格式差异，抽象层吃掉
2. **能力降级**：iOS 不支持的功能，得有个优雅的降级方案
3. **Token 统一管理**：两端 Token 格式和拿到的时机都不一样，交给抽象层统一上报

#### 真实项目的落地形态：一个 Manager 收敛五大职责

该项目没先去造抽象接口，直接让一个 JPushManager 单例同时服务双端（极光在 iOS 之上又封装了一层 APNs），跨端差异全在它内部消化掉，业务层完全不用管（完整实现见 09-Android推送篇第 6 节）：

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

这五个职责是推送抽象层的"最小完备集"，少哪一条都会在某个场景掉链子：没有冷启动补偿，点通知冷启动就等于白点；没有登录补报，服务端永远拿不到最新的 registrationId。以后真要接多服务商，再在这一层下面按 PushService 接口拆出 iOS/Android 两套实现，业务层代码一行不用动。

#### 平台差异处理策略

| 能力 | iOS | Android | 抽象层策略 |
|------|-----|---------|-----------|
| 透传消息 | 静默推送（受限） | 厂商 SDK 支持 | 统一为 data 消息，iOS 降级为静默推送 |
| 富媒体通知 | Notification Extension | 自定义布局 | 抽象层标记 isRichMedia，iOS 走 Extension |
| 通知点击跳转 | UNUserNotificationCenter | Intent 路由 | 统一为 URI Scheme 跳转 |
| 后台保活 | 不允许 | 可做 | 这块能力不抽象 |
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

[iOS] 用户点通知把 App 拉起来（冷启动）的时候，通知数据在 `launchOptions[UIApplicationLaunchOptionsRemoteNotificationKey]` 里；可这会儿 Flutter Engine 才刚启动，`addEventHandler` 还没注册上，onOpenNotification 当然收不到。**冷启动点通知"没反应"，是 iOS 推送接入最容易漏掉的一个场景**（测试的时候 App 多半在后台，走的是热启动回调，一测就"过"了）。

```
点击通知 → iOS 冷启动拉起 App（launchOptions 携带通知数据）
        → Flutter Engine 启动 → 此刻才注册 addEventHandler（已错过回调）
        → 通知数据静静躺在 launchOptions 里，无人消费
```

#### 真实方案：原生缓存 + MethodChannel 主动拉取

该项目用三步搞定：**AppDelegate 从 launchOptions 提取远程通知 payload → 自建 MethodChannel 暴露 getLaunchData 并 clear-on-read → Flutter 推送初始化完成后主动拉一次，走统一路由分发。**

第 1 步 [iOS]：AppDelegate 只负责缓存远程通知 payload：

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

第 2 步 [iOS]：在原生桥接类 NativeFlutterBridge 的 MethodChannel（如 `com.example.app.method.channel`）里加一个 case，读完马上把缓存清掉：

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

第 3 步 [双端]：Flutter 在推送初始化（setupJPush）末尾主动拉一次、解析出来：

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

1. **拉取时机**：放到 setupJPush 末尾。太早，引擎或者通道还没就绪，调用直接失败；太晚，用户已经在首页待着了才跳走
2. **解析差异**：iOS 在原生侧只提取 `UIApplicationLaunchOptionsRemoteNotificationKey` 对应的 payload；Android 走 `JMessageExtra → n_extras`，而且字段可能是 JSON 字符串，String/Map 两种类型都得兼容
3. **统一出口**：冷启动解析出来的 PushModel，跟热启动（onOpenNotification）用的是同一个 jumpTo 分发，冷热行为一致
4. **一次性消费**：原生返回前先 clear 掉 pending payload，Dart 跳转完成后再把 pushModel 置空；两层防线，免得 setup 重试或者页面重建导致重复跳转

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

## 常见坑

### 坑1：开发环境 vs 生产环境证书

[iOS] 开发证书和生产证书是两套，Token 绑环境。拿开发证书的 Token 往生产 APNs 发推送，发不出去，反过来也一样。调试时最常见的错误就是证书和环境对不上。

### 坑2：以为模拟器完全不能测推送

[iOS] "模拟器不支持 APNs、必须真机"这个老结论已经过时了：Xcode 11.4+ 就能用 `xcrun simctl push <device> <bundle-id> <payload.apns>` 直接给模拟器注入一条推送（payload 本地构造，不走真实 APNs 链路）；Xcode 14 / iOS 16+ 的模拟器登录 Apple ID 之后，还能注册并接收**真实 APNs 远程推送**。日常开发拿模拟器覆盖基础推送调试就够了，但静默推送、Notification Extension、生产环境验证还是得上真机，这三类行为在模拟器上并不完全等价。

### 坑3：Notification Extension 未签名

[iOS] Extension 是独立 Target，要单独配一份 Provisioning Profile。Extension 的签名配置要是错了，富媒体推送会悄悄降级成普通推送：一点报错都没有，就是图片不显示。

### 坑4：静默推送频率限制

[iOS] Apple 对静默推送有频率限制。短时间内发太多，系统会一点点加大延迟，最后干脆丢掉。具体阈值 Apple 文档里没公开，经验值是每小时不超过 2-3 条/设备。

### 坑5：iOS 15+ 通知摘要

[iOS] iOS 15 加了通知摘要，用户可以让通知"稍后显示"。推送就算成功送到了，用户也可能几个小时后才看到。这是平台行为，开发者管不了，但心里得有数：**推送到达 ≠ 用户感知**。

### 坑6：aps-environment 遗留 development，生产收不到推送

[iOS] Entitlements 里的 `aps-environment` 决定 App 注册到开发通道还是生产 APNs 通道。Xcode 自动签名调试的时候经常把它设成 `development`；打 App Store/TestFlight 包时没去检查的话，**编译期一点报错都没有**，可 token 注册到的是开发通道，生产推送永远收不到：注册成功、服务端发送也返回成功，就用户手机不响。某个上线半年的项目发版前自查，发现这项还留着 development，从此把它写进了发版检查清单：

```xml
<!-- 上线前必查：App Store/TestFlight 包必须为 production -->
<dict>
    <key>aps-environment</key>
    <string>production</string>
</dict>
```

### 坑7：推送证书与打包环境不匹配

[iOS] 推送能不能送到，看三方对不对得上：Entitlements 的 aps-environment、推送凭证、APNs endpoint 和打包方式（Debug/Ad hoc/App Store）。`.p8` 把证书生命周期和多 App 密钥管理简化了，但不代表 Sandbox/Production 能忽略：设备 token 和服务端连的环境还是得对上。排查的时候，签名后的 entitlement、token 来源、JPush/APNs 环境参数、服务端发送 endpoint，一项一项对（见坑1 和第 1 节检查清单）。

---

## 面试追问

### iOS 推送和 Android 推送的核心差异是什么？

iOS 就 APNs 一个通道，离线推送由系统兜着，App 不用自己建长连接；Android（国内）得接好几家厂商通道，碎片化很严重。iOS 有证书体系，证书一过期推送全挂；Android 没有证书这个概念。iOS 不让后台保活，Android 能做但不可靠。iOS 这边还有静默推送、Notification Extension 这些系统级扩展能力。

### 为什么推荐用 .p8 Token 而不是 .p12 证书？

.p12 证书每年过期，得手动更新服务端配置，一忘就是一整批推送全失败；.p8 Token 永不过期，服务端走 JWT 认证，证书管理这块的运维风险就没了。代价只有一个：每小时得重新生成 JWT，不过这个服务端自动做。

### 静默推送有什么限制？能用来做 IM 消息推送吗？

静默推送不弹通知、不保证即时送达、后台只能跑 30 秒、低电量模式下会被延迟或者丢掉、用户关掉通知权限它同样失效。所以它不适合当 IM 的核心消息通道，更适合当优化手段：提前把数据同步好，用户打开 App 内容就已经在那儿了。IM 还是得用通知栏消息来保证可见性。

### 用户拒收推送权限后怎么办？

一旦拒收，系统权限弹窗就再也弹不出来了，只能在 App 里引导用户（跳系统设置页）自己手动开。最佳实践是请求权限之前先弹个预授权弹窗，把推送用途讲清楚，用户同意了再调系统弹窗，授权率能明显提上去。拒收之后，还能降级成 App 内消息中心、短信这些方式继续触达。

### 点击推送冷启动 App 时，Flutter 侧怎么拿到通知数据？

冷启动的时候，通知数据在 iOS 的 launchOptions / Android 的启动 Intent 里，可 Flutter 的推送回调这会儿还没注册上。方案是：iOS 原生在 didFinishLaunching 里只提取远程通知 payload，自建 MethodChannel 暴露一个 clear-on-read 的 getLaunchData；Flutter 在推送初始化完成后主动拉一次，解析成统一消息模型，走跟热启动一样的路由分发。这个"冷启动补偿"最容易被漏掉，不做的话，测试时 App 在后台点通知正常，冷启动点通知就没反应。

### 如果让你设计一个跨平台推送架构，如何处理两端能力差异？

核心策略就八个字："抽象共性、降级差异"。1) 统一消息模型，两端的格式差异（比如极光 Android 的 extras 嵌套 vs iOS 的 userInfo）在平台实现层消化掉；2) 定义统一的 PushService 接口或者单例 Manager，iOS 和 Android 各写各的实现/内部分支；3) 能力不对等的地方打标记（比如 isRichMedia），不支持的平台优雅降级；4) Token 管理统一成回调 + 持久化 + 登录后补报；5) 两端都不可靠的能力别抽象（比如后台保活）。真实项目的经验是：单服务商阶段，一个 Manager 收敛"初始化/权限/标识上报/点击路由/冷启动补偿"这五大职责就够了，等多服务商的需求真出现了再去拆接口，别过度设计。

---

## 参考资源

- [Apple Push Notification Service 官方文档](https://developer.apple.com/documentation/usernotifications)
- [Setting Up a Remote Notification Server](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server)
- [Notification Service Extension 指南](https://developer.apple.com/documentation/usernotifications/modifying_content_in_newly_delivered_notifications)
- [APNs API Reference (Provider API)](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/sending-notification-requests-to-apns)
- [极光推送 iOS 集成文档](https://docs.jiguang.cn/jpush/client/iOS/ios_guide_new)
- [flutter_local_notifications 插件](https://pub.dev/packages/flutter_local_notifications)
