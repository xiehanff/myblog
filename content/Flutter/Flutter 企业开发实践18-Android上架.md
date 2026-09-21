---
title: Flutter 企业开发实践18-Android上架
date: 2026-05-18
tags:
  - Flutter
  - Android
  - 上架
  - 签名
  - 多渠道打包
  - 应用市场
---

# Android 上架：签名、打包与多渠道分发

## 概述

Android 上架，不是打个 APK 往市场一扔就完事。企业应用得解决三个核心问题：**签名身份可信**（keystore 管理）、**渠道可追踪**（多渠道打包）、**审核可过**（各市场合规）。这三个漏掉一个，轻的渠道数据归因不准，重的应用上不了架，或者上架了被下架。

这篇我站在架构决策的角度，把每一步的"为什么这么做"、"不这么做会怎样"讲清楚。

---

## 核心内容

### 1. 应用签名与密钥管理

#### 1.1 为什么 Android 必须签名

Android 系统用签名做两件事：**身份验证**和**完整性校验**。安装的时候，系统拿这个 APK 的签名跟已安装版本的签名比一下，对不上就拒绝覆盖安装。所以签名密钥一旦丢了，那个包名的应用你就再也更新不了。

**密钥没管好会出什么事：**
- keystore 丢了 → 发不了版，只能换包名重新上架（等于把用户全丢了）
- 密钥泄露 → 谁都能冒充你发版，往里面塞恶意代码
- 好几个人共用同一个密钥文件 → 查不出是谁签的哪个版本

#### 1.2 签名配置实践 [Android]

Flutter 项目的 Android 签名配置写在 `android/app/build.gradle` 里：

```groovy
android {
    // ...

    signingConfigs {
        release {
            // ❌ 硬编码密钥路径，不要这么做
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

从 2021 年开始，Google Play 强制走 **Play App Signing**：你用上传密钥（upload key）签好名传上去，Google 再用你的签名密钥（app signing key）重新签一遍，然后分发。

架构上要拿主意的地方：
- **upload key** 丢了、想轮换都行，它只在传包的时候用
- **app signing key** 由 Google 托管，导不出来，你根本不用担心丢
- 国内市场没有这套机制，密钥全靠自己管

**密钥管理上的几条经验：**

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

国内 Android 市场太碎：华为、小米、OPPO、vivo、应用宝各干各的。你得知道每个用户是从哪个市场下的，才能：
- 做渠道归因（哪个市场带来多少用户）
- 按渠道统计崩溃率、留存率
- 针对不同市场做差异化配置（比如有的市场不让带某个 SDK）

**不做多渠道打包会怎样：** 所有渠道数据混在一块儿，分不清来源，推广 ROI 也就没法算。

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

**致命问题：** 每个渠道都得重新编译、重新签名，10 个渠道就得构建 10 次。Flutter 项目一次 `flutter build` 大概 3-5 分钟，10 个渠道就是半小时往上。

#### 2.3 美团 Walle 方案（推荐）

Walle（瓦力）的思路是：**APK 本身就是个 ZIP，渠道信息直接写进 ZIP 的 Signing Block，不用重新编译，也不用重新签名。**

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

不想引 Walle 这个依赖，也可以自己搭一套差不多的：

- 在 APK 的 `META-INF/` 目录塞个空文件（比如 `META-INF/channel_xiaomi`），利用 ZIP 这块不影响签名的特性
- 缺点：Google Play 不允许 `META-INF` 里多出文件，有些市场也会把这些文件清掉

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

**架构师得提前规划的东西：**

1. **商店素材**：图标（512x512）、截图（至少 4 张，不同尺寸）、简介、更新说明。这些最好有统一的素材管理流程，别每次手动凑
2. **隐私政策 URL**：所有市场都要，而且写的内容得跟实际采集行为对得上
3. **软著**：应用宝这些市场硬性要求，申请周期大概 30-60 天，得提前排上
4. **SDK 声明**：工信部的要求，所有第三方 SDK 和用途都得列出来
5. **App 备案号**：2024 年 4 月起，国内所有商店上架的必填项，没有备案号连提审入口都进不去。办理周期跟软著差不多（常规 20 个工作日上下），最好跟软著一起启动，两个都前置到项目排期里

#### 3.3 Google Play 上架 [Android]

```bash
# 构建 AAB
flutter build appbundle --release

# 上传到 Google Play Console
# 通过浏览器或 fastlane supply 命令行工具
```

Google Play 特殊要求：
- Google Play 从 2021-08 起，新应用强制用 AAB（老应用更新还是可以提 APK）
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
- 对鸿蒙兼容性有要求，Flutter 应用要声明支不支持鸿蒙
- 后台服务管得严，不能常驻通知栏
- 热更新零容忍，一检测到动态加载代码就直接拒

**小米：**
- 隐私政策审得最严，会逐条拿声明与实际采集比对
- "开屏广告"有时长限制（不能超过 5 秒，而且必须能跳过）
- 应用内自更新（检测更新的弹窗）也有规范

**OPPO：**
- SDK 列表的声明格式有专门要求
- 权限申请时机查得严，不能一启动就把权限全申请了
- 应用内 H5 页面有备案要求

**vivo：**
- 审核的人会真的把应用跑起来测
- 耗电和性能有要求，启动超过 5 秒就可能被拒
- 推送通道有限制，推荐用厂商推送

**应用宝：**
- 软著是硬要求
- QQ/微信登录分享的 SDK 版本有最低要求
- 应用内支付通道卡得严（必须走官方通道）

#### 4.3 Flutter 特有的审核注意事项

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 首次启动白屏 | Flutter Engine 初始化慢 | 加个启动页（splash screen），非关键模块延迟加载 |
| 体积过大 | Flutter Engine 约 5-8MB | 用 App Bundle + 按需加载（deferred components） |
| WebView 白屏 | 审核人员网络问题 | 加超时提示和重试机制 |
| 推送不生效 | 未集成厂商推送通道 | 必须把各厂商推送 SDK 集成上 |

---

### 5. SDK 版本适配与 targetSdkVersion 要求

#### 5.1 为什么 targetSdkVersion 很重要

`targetSdkVersion` 声明的是你的应用适配到哪个 Android 版本。系统看这个值来决定要不要给你上新版的安全限制。

**targetSdkVersion 太低会怎样：**
- Google Play 直接不给上架（这个要求逐年往上调：2025-08-31 起得 target API 35/Android 15，2026-08-31 起得 target API 36/Android 16，以 Play 官方公告为准）
- 国内主流市场也在慢慢跟上
- 用户手机上会弹安全警告

#### 5.2 各市场要求（截至 2026-08）

| 市场 | 最低 targetSdkVersion |
|------|---------------------|
| Google Play | 35（2025-08 起）→ 36（2026-08 起） |
| 华为/小米/OPPO/vivo | 以各商店开发者后台当前公告为准，通常比 Play 晚一到两个版本 |
| 应用宝 | 相对宽松，同样逐年跟进 |

> targetSdk 的门槛是"活"的，每年 Android 新版本一发就可能往上调。脑子里记死的数字肯定过时，上架前按各市场后台的实际要求来。

Flutter 项目配置：

```groovy
android {
    defaultConfig {
        minSdkVersion 24    // Flutter 3.35+ 默认值（3.22~3.34 默认 21）
        targetSdkVersion 36 // 满足 2026 年 Google Play 要求
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

**targetSdkVersion 35（Android 15）关键变更：**
- 强制 edge-to-edge 显示（系统栏不再自动留白，需自行处理安全区 insets）
- 前台服务政策进一步收紧

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

| Flutter 版本 | 默认 minSdkVersion | 说明 |
|-------------|-------------------|------|
| 3.10 ~ 3.21 | 19 | |
| 3.22 ~ 3.34 | 21 | |
| 3.35+ | 24 | 当前默认 |

> minSdk 由你用的 Flutter 版本模板决定（新项目跟着默认走就行）；targetSdk 看当年的应用商店政策来设，这俩是两件独立的事。

---

## 常见坑

### 1. Keystore 丢失

**场景：** 开发者离职没交接 keystore，新版本覆盖安装不上。
**解决：** 只能换包名重新上架，但老用户没法自动更新。这种事预防比补救划算得多。

### 2. 多渠道包签名不一致

**场景：** 用 productFlavors 打包时漏了某个渠道的签名配置，这个渠道的安装包就覆盖安装不上。
**解决：** 统一走 `signingConfigs.release`，CI 流水线加上签名校验，发布前用 `apksigner verify` 过一遍。

### 3. 渠道信息被覆盖

**场景：** 有些市场会把 APK 重新签名或重新打包，Walle 写进去的渠道信息就丢了。
**解决：** 这些市场改用 `productFlavors` 硬编码渠道，或者跟服务端配合，首次启动时由服务端按安装来源分配渠道。

### 4. targetSdkVersion 升级后权限崩了

**场景：** 从 31 升到 34，原来还好好的通知、位置这些功能突然失效。
**解决：** 每次升 targetSdkVersion 之前，逐条对着 Android 版本变更日志过一遍，把所有权限相关功能都回归测一遍。

### 5. 应用宝软著卡住

**场景：** 应用宝审核要软著，但软著申请得 30-60 天。
**解决：** 项目一开始就同步申请软著，别等开发完了才想起来。

---

## 面试追问

### 多渠道打包你是怎么做的？

**要点：** 讲清为什么用 Walle（不用重新编译，出包快），说下原理（渠道信息写在 APK Signing Block 里），再提到渠道信息怎么读、归因统计怎么落地。

### 各个应用市场审核有什么坑？

**要点：** 按市场把差异化审核要求列出来：华为的鸿蒙适配、小米的隐私政策严、应用宝强制要软著、OPPO/vivo 查权限申请时机。强调"不要等到提审才发现缺材料"。

### targetSdkVersion 升级你遇到过什么问题？

**要点：** 拿 33→34 升级举例，讲前台服务类型声明、通知权限运行时申请、分区存储适配这些变更。重点说你回归测试和兼容性验证是怎么做的。

### 密钥管理你们是怎么做的？

**要点：** 从组织层面答：keystore 离线备份、密码和文件分开存、CI/CD 里用加密 secret 注入、留交接文档。如果是 Google Play，还要提到 Play App Signing 的双密钥机制。

### 如果让你设计一套自动化上架流水线，你会怎么设计？

**要点：** 说整条链路：代码提交 → 自动构建 → 自动签名 → Walle 多渠道 → 自动提审（各市场 API / fastlane）→ 审核状态监控 → 上架通知。重点讲各市场 API 能力不一样带来的适配成本，以及审核被拒后怎么自动回退。

---

## 参考资源

- [Android 应用签名官方文档](https://developer.android.com/studio/publish/app-signing)
- [美团 Walle 多渠道打包](https://github.com/Meituan-Dianping/walle)
- [Google Play Console 帮助](https://support.google.com/googleplay/android-developer)
- [Android 14 行为变更](https://developer.android.com/about/versions/14/behavior-changes-14)
- [各应用市场开发者平台汇总](https://dev.umiuni.com/appstores)
