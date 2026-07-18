---
title: Flutter 企业开发实践19-Android上架
date: 2026-05-18
tags:
  - Flutter
  - Android
  - 上架
  - 签名
  - 多渠道打包
  - 应用市场
---

# Android 上架——签名、打包与多渠道分发

## 概述

Android 上架不是"打一个 APK 往市场一扔"那么简单。企业级应用需要解决三个核心问题：**签名身份可信**（keystore 管理）、**渠道可追踪**（多渠道打包）、**审核可过**（各市场合规）。忽略任何一个，轻则数据归因失败，重则应用无法上架或被下架。

本文站在架构决策视角，讲清楚每一步"为什么这么做"以及"不这么做会怎样"。

---

## 核心内容

### 1. 应用签名与密钥管理

#### 1.1 为什么 Android 必须签名

Android 系统用签名做两件事：**身份验证**和**完整性校验**。安装时系统比对该 APK 的签名与已安装版本的签名是否一致——不一致就拒绝覆盖安装。这意味着签名密钥一旦丢失，你就永远无法更新那个包名的应用。

**不管理好密钥的后果：**
- 丢失 keystore → 无法发版，只能换包名重新上架（等于丢掉所有用户）
- 密钥泄露 → 任何人都能冒充你发版，植入恶意代码
- 多人共用同一密钥文件 → 无法追溯谁签了哪个版本

#### 1.2 签名配置实践 [Android]

Flutter 项目的 Android 签名配置在 `android/app/build.gradle` 中：

```groovy
android {
    // ...

    signingConfigs {
        release {
            // ❌ 硬编码密钥路径——不要这么做
            // storeFile file("my-release-key.jks")

            // ✅ 从环境变量或 local.properties 读取
            def keystoreProperties = new Properties()
            def keystorePropertiesFile = rootProject.file('keystore.properties')
            if (keystorePropertiesFile.exists()) {
                keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
            }

            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

`keystore.properties`（**绝不能提交到 Git**）：

```properties
storeFile=/path/to/release-key.jks
storePassword=your_store_password
keyAlias=your_key_alias
keyPassword=your_key_password
```

`.gitignore` 中必须添加：

```
keystore.properties
*.jks
*.keystore
```

#### 1.3 Google Play App Signing（2026年现状）

自 2021 年起，Google Play 强制使用 **Play App Signing**：你上传密钥（upload key）签名后上传，Google 用你的签名密钥（app signing key）重新签名后分发。

架构决策要点：
- **upload key** 可以丢失或轮换——只是上传时用的
- **app signing key** 由 Google 托管，无法导出——永远不用担心丢失
- 国内市场没有类似机制，密钥全靠自己管理

**密钥管理最佳实践：**

| 措施 | 说明 |
|------|------|
| 离线存储 keystore | U 盘/保险柜，至少两份异地备份 |
| 密码与文件分离 | keystore 文件和密码不要存在同一地方 |
| 交接文档 | 记录密钥用途、创建时间、负责人 |
| CI/CD 环境变量 | 密码以加密 secret 形式注入，不落盘 |

#### 1.4 Flutter 构建签名命令

```bash
# 构建 APK（使用 build.gradle 中的签名配置）
flutter build apk --release

# 构建 App Bundle（Google Play 推荐）
flutter build appbundle --release

# 带 Dart 混淆构建
flutter build apk --release --obfuscate --split-debug-info=/<project-name>/symbols
```

---

### 2. 多渠道打包方案

#### 2.1 为什么需要多渠道

国内 Android 市场碎片化严重——华为、小米、OPPO、vivo、应用宝各自为政。你需要知道每个用户从哪个市场下载的，才能：
- 做渠道归因（哪个市场带来了多少用户）
- 按渠道统计崩溃率、留存率
- 针对不同市场做差异化配置（如某些市场不能包含某 SDK）

**不多渠道打包的后果：** 所有渠道数据混在一起，无法区分来源，市场推广 ROI 无法计算。

#### 2.2 传统方案：Android Manifest placeholder

```groovy
android {
    productFlavors {
        huawei { manifestPlaceholders = [CHANNEL_VALUE: "huawei"] }
        xiaomi { manifestPlaceholders = [CHANNEL_VALUE: "xiaomi"] }
        oppo { manifestPlaceholders = [CHANNEL_VALUE: "oppo"] }
        vivo { manifestPlaceholders = [CHANNEL_VALUE: "vivo"] }
        tencent { manifestPlaceholders = [CHANNEL_VALUE: "tencent"] }
    }
}
```

`AndroidManifest.xml`：

```xml
<meta-data
    android:name="CHANNEL"
    android:value="${CHANNEL_VALUE}" />
```

**致命缺陷：** 每个渠道都要重新编译、重新签名——10 个渠道就要构建 10 次。Flutter 项目一次 `flutter build` 约 3-5 分钟，10 个渠道就是半小时以上。

#### 2.3 美团 Walle 方案（推荐）

Walle（瓦力）的核心思路：**APK 本质是 ZIP，在 ZIP 的 Signing Block 中写入渠道信息，不需要重新编译和签名。**

```
+----------------+
|   APK 内容     |  ← 不动
+----------------+
| Signing Block  |  ← 在这里写入渠道 ID
+----------------+
| Central Dir    |  ← 不动
+----------------+
| End of Central |  ← 不动
+----------------+
```

集成步骤：

1. 项目级 `build.gradle`：

```groovy
buildscript {
    dependencies {
        classpath 'com.meituan.android.walle:plugin:1.1.7'
    }
}
```

2. App 级 `build.gradle`：

```groovy
apply plugin: 'walle'

walle {
    // 指定渠道配置文件
    channelFile = file("${project.rootDir}/channel.txt")
    // 自定义 APK 输出路径
    apkOutputDirectory = file("${project.buildDir}/outputs/channels")
    apkFileNameFormat = '${appName}-${packageName}-${channel}-${versionName}-${versionCode}-${buildTime}.apk'
}
```

3. `channel.txt`（每行一个渠道）：

```
huawei
xiaomi
oppo
vivo
tencent
qihoo
baidu
```

4. 读取渠道信息（Dart 侧）：

```dart
import 'package:walle/walle.dart';

// 通过 MethodChannel 调用原生获取
class ChannelUtil {
  static Future<String> getChannel() async {
    // Android 原生侧通过 WalleChannel.getChannel(context) 获取
    const channel = MethodChannel('app_channel');
    return await channel.invokeMethod('getChannel') ?? 'unknown';
  }
}
```

5. 打包命令：

```bash
# 先构建一个基线 APK
flutter build apk --release

# 用 Walle 生成多渠道包
./gradlew assembleReleaseChannels
```

**性能对比：**

| 方案 | 10 个渠道耗时 | 原理 |
|------|-------------|------|
| productFlavors | 30-50 分钟 | 每个渠道重新编译 |
| Walle | 10-30 秒 | 只写入渠道信息 |

#### 2.4 自建方案思路

如果不想引入 Walle 依赖，可以自建类似方案：

- 在 APK 的 `META-INF/` 目录写入空文件（如 `META-INF/channel_xiaomi`），利用 ZIP 不影响签名的特性
- 缺点：Google Play 不允许 `META-INF` 中有额外文件，且部分市场会清理这些文件

---

### 3. 主流应用市场上架

#### 3.1 国内六大市场对比 [Android]

| 市场 | 开发者注册 | 审核周期 | 首次审核 | 特殊要求 |
|------|-----------|---------|---------|---------|
| 华为应用市场 | 企业认证 1-3 天 | 1-3 天 | 3-5 天 | 鸿蒙适配说明（2026年建议提供） |
| 小米应用商店 | 企业认证 1 天 | 1-2 天 | 2-3 天 | 隐私政策审核严格 |
| OPPO 软件商店 | 企业认证 1-2 天 | 1-2 天 | 3-5 天 | SDK 列表声明 |
| vivo 应用商店 | 企业认证 1-2 天 | 1-3 天 | 3-5 天 | 实名认证+人脸 |
| 腾讯应用宝 | 企业认证 1-3 天 | 1-3 天 | 3-7 天 | 软著必须提供 |
| 360 手机助手 | 企业认证 1-2 天 | 1-3 天 | 2-5 天 | 安全检测报告 |

#### 3.2 上架通用流程

```
企业资质认证 → 创建应用 → 上传 APK/AAB → 填写商店信息 → 提交审核 → 审核通过 → 上架
```

**架构师需要提前规划的：**

1. **商店素材**：图标（512x512）、截图（至少 4 张，不同尺寸）、简介、更新说明——这些应该有统一的素材管理流程，不要每次手动准备
2. **隐私政策 URL**：所有市场都要求，且内容必须与实际采集行为一致
3. **软著**：应用宝等市场强制要求，申请周期约 30-60 天，需要提前规划
4. **SDK 声明**：工信部 2023 年起要求，必须列出所有第三方 SDK 及其用途

#### 3.3 Google Play 上架 [Android]

```bash
# 构建 AAB
flutter build appbundle --release

# 上传到 Google Play Console
# 通过浏览器或 fastlane supply 命令行工具
```

Google Play 特殊要求：
- 必须 AAB 格式（2026年强制）
- targetSdkVersion 最低要求（见下节）
- 数据安全声明（Data safety section）
- 内容分级问卷

---

### 4. 各市场审核要点与差异

#### 4.1 通用审核红线

所有市场都会拒绝的应用：
- 没有隐私政策或隐私政策不完整
- 超范围采集个人信息
- 强制索权（不给权限不让用）
- 包含其他市场的下载链接
- 存在 WebView 劫持或诱导下载

#### 4.2 各市场差异化审核

**华为：**
- 对鸿蒙兼容性有要求，Flutter 应用需声明是否支持鸿蒙
- 对后台服务限制严格，不能常驻通知栏
- 对热更新零容忍——检测到动态加载代码直接拒

**小米：**
- 隐私政策审核最严，会逐条比对声明与实际采集
- 对"开屏广告"有时长限制（不能超过 5 秒且必须可跳过）
- 对自更新（应用内检测更新弹窗）有规范

**OPPO：**
- SDK 列表声明格式有特定要求
- 对应用权限申请时机审查严格——不能启动就申请所有权限
- 对应用内 H5 页面有备案要求

**vivo：**
- 审核人员会实际运行测试
- 对耗电和性能有要求，启动超过 5 秒可能被拒
- 对推送通道有限制，推荐使用厂商推送

**应用宝：**
- 强制要求软著
- 对 QQ/微信登录分享的 SDK 版本有最低要求
- 对应用内支付通道有严格限制（必须走官方通道）

#### 4.3 Flutter 特有的审核注意事项

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 首次启动白屏 | Flutter Engine 初始化慢 | 添加启动页（splash screen），延迟加载非关键模块 |
| 体积过大 | Flutter Engine 约 5-8MB | 使用 App Bundle + 按需加载（deferred components） |
| WebView 白屏 | 审核人员网络问题 | 增加超时提示和重试机制 |
| 推送不生效 | 未集成厂商推送通道 | 必须集成各厂商推送 SDK |

---

### 5. SDK 版本适配与 targetSdkVersion 要求

#### 5.1 为什么 targetSdkVersion 很重要

`targetSdkVersion` 声明了你的应用适配的 Android 版本。系统会根据这个值决定是否启用新版安全限制。

**低 targetSdkVersion 的后果：**
- Google Play 拒绝上架（2026年要求 targetSdkVersion ≥ 34，即 Android 14）
- 国内主流市场逐步跟进要求
- 用户看到安全警告弹窗

#### 5.2 各市场要求（2026年）

| 市场 | 最低 targetSdkVersion |
|------|---------------------|
| Google Play | 34 (Android 14) |
| 华为 | 33+ |
| 小米 | 33+ |
| OPPO | 33+ |
| vivo | 33+ |
| 应用宝 | 31+ |

Flutter 项目配置：

```groovy
android {
    defaultConfig {
        minSdkVersion 23    // Flutter 3.x 最低支持
        targetSdkVersion 34 // 满足所有市场要求
    }
}
```

#### 5.3 版本适配关键变更

**targetSdkVersion 33（Android 13）关键变更：**
- 通知权限 `POST_NOTIFICATIONS` 必须运行时申请
- 新增 `NEARBY_WIFI_DEVICES` 权限替代部分 `ACCESS_FINE_LOCATION`
- 剪贴板读取有 toast 提示

**targetSdkVersion 34（Android 14）关键变更：**
- 前台服务类型必须声明
- 隐式 Intent 和 Pending Intent 需要指定包名
- `Photo` 和 `Video` 部分权限替代 `READ_MEDIA_*`

```dart
// Flutter 侧权限适配示例
// 使用 permission_handler 包
Future<void> requestNotificationPermission() async {
  if (Platform.isAndroid) {
    final androidInfo = await DeviceInfoPlugin().androidInfo;
    if (androidInfo.version.sdkInt >= 33) {
      // Android 13+ 必须请求通知权限
      final status = await Permission.notification.request();
      if (!status.isGranted) {
        // 权限被拒绝，降级处理
        log('通知权限被拒绝，部分功能受限');
      }
    }
  }
}
```

#### 5.4 Flutter 版本与 SDK 版本对应关系

| Flutter 版本 | 默认 minSdkVersion | 推荐 targetSdkVersion |
|-------------|-------------------|---------------------|
| 3.10 | 19 | 33 |
| 3.16 | 21 | 34 |
| 3.22+ | 23 | 34 |

---

## 常见坑与踩点

### 1. Keystore 丢失

**场景：** 开发者离职未交接 keystore，新版本无法覆盖安装。
**解决：** 只能换包名重新上架，但老用户无法自动更新。预防远大于补救。

### 2. 多渠道包签名不一致

**场景：** 用 productFlavors 打包时，某个渠道的签名配置遗漏，导致该渠道安装包无法覆盖安装。
**解决：** 统一使用 `signingConfigs.release`，CI 流水线做签名校验——发布前用 `apksigner verify` 检查。

### 3. 渠道信息被覆盖

**场景：** 某些市场会对 APK 重新签名或重新打包，导致 Walle 写入的渠道信息丢失。
**解决：** 对这些市场使用 `productFlavors` 方式硬编码渠道，或与服务端配合——首次启动时由服务端根据安装来源分配渠道。

### 4. targetSdkVersion 升级后权限崩了

**场景：** 从 31 升到 34，之前正常工作的通知、位置等功能突然失效。
**解决：** 每次升级 targetSdkVersion 前，逐条对照 Android 版本变更日志，回归测试所有权限相关功能。

### 5. 应用宝软著卡住

**场景：** 应用宝审核需要软著，但软著申请要 30-60 天。
**解决：** 项目启动时同步申请软著，不要等开发完了才想起来。

---

## 面试追问

###  多渠道打包你是怎么做的？

**要点：** 说明使用 Walle 的原因（不重新编译，快速生成），简述原理（在 APK Signing Block 写入渠道信息），提到渠道信息的读取方式和归因统计的落地。

###  各个应用市场审核有什么坑？

**要点：** 按市场列举差异化审核要求——华为的鸿蒙适配、小米的隐私政策严格、应用宝的软著强制要求、OPPO/vivo 的权限申请时机审查。强调"不要等到提审才发现缺材料"。

###  targetSdkVersion 升级你遇到过什么问题？

**要点：** 以 33→34 升级为例，讲述前台服务类型声明、通知权限运行时申请、分区存储适配等变更。重点讲你如何做回归测试和兼容性验证。

###  密钥管理你们是怎么做的？

**要点：** 从组织层面回答——keystore 离线备份、密码与文件分离、CI/CD 中以加密 secret 注入、交接文档。如果是 Google Play 还要提到 Play App Signing 的双密钥机制。

###  如果让你设计一套自动化上架流水线，你会怎么设计？

**要点：** 从代码提交 → 自动构建 → 自动签名 → Walle 多渠道 → 自动提审（各市场 API / fastlane）→ 审核状态监控 → 上架通知。重点讲各市场 API 能力差异导致的适配成本，以及审核被拒后的自动回退机制。

---

## 参考资源

- [Android 应用签名官方文档](https://developer.android.com/studio/publish/app-signing)
- [美团 Walle 多渠道打包](https://github.com/Meituan-Dianping/walle)
- [Google Play Console 帮助](https://support.google.com/googleplay/android-developer)
- [Android 14 行为变更](https://developer.android.com/about/versions/14/behavior-changes-14)
- [各应用市场开发者平台汇总](https://dev.umiuni.com/appstores)
