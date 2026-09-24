---
title: Flutter 企业开发实践08-环境与构建管理
date: 2026-05-18
tags:
  - Flutter
  - Flavor
  - FVM
  - dart-define
  - 包体积优化
  - 多渠道打包
  - 面试
---

# 环境与构建管理

## 概述

环境与构建管理要解决的，就是**同一份代码怎么在不同环境（开发/测试/预发/生产）下产出不同的构建产物，而且整个过程能追溯、能复现**。

说白了，把它当成"怎么改 API 地址"就想歪了。这是工程基础设施的活：多环境隔离、SDK 版本对齐、构建产物优化、多渠道分发。这里面哪个环节出问题都不算小事，往轻了说，测试环境的脏数据能把生产污染了；往重了说，线上包体积超标，直接被应用商店拒审。

## 核心内容

### 1. Flutter Flavor 多环境方案

#### 为什么需要多环境？

| 环境 | 用途 | API 地址 | 数据 | 日志级别 |
|------|------|----------|------|----------|
| dev | 开发调试 | `api-dev.example.com` | Mock/测试数据 | verbose |
| staging | 测试验证 | `api-staging.example.com` | 测试数据 | debug |
| production | 线上 | `api.example.com` | 真实数据 | error only |

**不隔离会怎样？**
- 开发环境的脏数据把生产库污染了
- 测试接口一改，线上直接崩
- 日志泄露到生产环境（安全风险）
- 开发跟测试没法并行

#### Flutter 端 Flavor 配置

Flutter 3.0+ 推荐直接用 `--flavor` 参数：

```dart
// lib/main_dev.dart
void main() => runApp(const App(environment: Environment.dev));

// lib/main_staging.dart
void main() => runApp(const App(environment: Environment.staging));

// lib/main_production.dart
void main() => runApp(const App(environment: Environment.production));
```

```dart
// lib/config/environment.dart
enum Environment { dev, staging, production }

class EnvironmentConfig {
  final String apiBaseUrl;
  final String appName;
  final LogLevel logLevel;
  final bool enableCrashlytics;

  const EnvironmentConfig({
    required this.apiBaseUrl,
    required this.appName,
    required this.logLevel,
    required this.enableCrashlytics,
  });

  static const configs = {
    Environment.dev: EnvironmentConfig(
      apiBaseUrl: 'https://api-dev.example.com',
      appName: 'MyApp-Dev',
      logLevel: LogLevel.verbose,
      enableCrashlytics: false,
    ),
    Environment.staging: EnvironmentConfig(
      apiBaseUrl: 'https://api-staging.example.com',
      appName: 'MyApp-Staging',
      logLevel: LogLevel.debug,
      enableCrashlytics: true,
    ),
    Environment.production: EnvironmentConfig(
      apiBaseUrl: 'https://api.example.com',
      appName: 'MyApp',
      logLevel: LogLevel.error,
      enableCrashlytics: true,
    ),
  };
}
```

```dart
// lib/app.dart
class App extends StatelessWidget {
  final Environment environment;

  const App({super.key, required this.environment});

  @override
  Widget build(BuildContext context) {
    final config = EnvironmentConfig.configs[environment]!;

    return GetMaterialApp(
      title: config.appName,
      initialBinding: AppBinding(config),
      home: const HomePage(),
    );
  }
}
```

#### Android 端 Flavor [Android]

```groovy
// android/app/build.gradle
android {
  // ...

  flavorDimensions += "environment"

  productFlavors {
    dev {
      dimension = "environment"
      applicationIdSuffix = ".dev"
      versionNameSuffix = "-dev"
      resValue "string", "app_name", "MyApp-Dev"
    }
    staging {
      dimension = "environment"
      applicationIdSuffix = ".staging"
      versionNameSuffix = "-staging"
      resValue "string", "app_name", "MyApp-Staging"
    }
    production {
      dimension = "environment"
      resValue "string", "app_name", "MyApp"
    }
  }
}
```

`applicationIdSuffix` 一加，不同环境就能装在同一台设备上，因为包名不一样。

构建命令：

```bash
flutter build apk --flavor dev
flutter build apk --flavor staging
flutter build apk --flavor production
```

#### iOS 端 Flavor [iOS]

iOS 这边走的是 Xcode Scheme + Configuration：

1. 在 Xcode 中创建三个 Configuration：`Debug-Dev`、`Debug-Staging`、`Release-Production`
2. 创建对应的 Scheme：`dev`、`staging`、`production`
3. 在 `Info.plist` 中使用 `$(APP_NAME)` 等变量

```bash
# 构建
flutter build ios --flavor production
```

iOS 多环境最容易踩的地方是，`applicationId`（Bundle Identifier）得在 Xcode Configuration 里设，不像 Android 那样有 `applicationIdSuffix` 这种语法糖。每个 Configuration 都得手动设一遍不同的 Bundle Identifier。

### 2. FVM 管理 SDK 版本

#### 为什么需要 FVM？

团队里每个人的 Flutter SDK 版本不一样，会带出一串问题：
- `pubspec.lock` 动不动就变
- 有些 API 低版本里没有，高版本又废弃了
- CI/CD 构建出来的结果复现不了

FVM（Flutter Version Management）就是用来对齐 SDK 版本的。

#### 安装与配置

```bash
# 安装 FVM
dart pub global activate fvm

# 安装指定版本
fvm install 3.22.0

# 项目中使用指定版本
fvm use 3.22.0

# 全局默认版本
fvm global 3.22.0
```

跑完 `fvm use`，项目根目录会生成 `.fvmrc`（版本记录）和 `.fvm/` 目录（指向本机 SDK 的 symlink 等）：

```json
// .fvmrc（FVM 3.x 的版本事实来源；旧版 FVM 的 .fvm/fvm_config.json 已废弃）
{
  "flutter": "3.22.0"
}
```

#### 团队里怎么用

```bash
# 克隆项目后，先安装对应 SDK 版本
fvm install
fvm flutter pub get

# 所有 Flutter 命令通过 fvm 执行
fvm flutter run
fvm flutter build apk
fvm flutter test
```

在 CI/CD 中：

```yaml
# GitHub Actions 示例
- name: Install FVM
  run: dart pub global activate fvm

- name: Install Flutter SDK
  run: fvm install

- name: Build
  run: fvm flutter build apk --flavor production
```

**`.fvmrc` 要提交，`.fvm/` 要忽略**，这是 FVM 官方的版本控制建议（FVM 3.x 会自动往 `.gitignore` 追加）。`.fvm/` 里放的是指向本机 SDK 绝对路径的 symlink，一旦提交，别人（尤其 Windows）拉下来肯定是坏的。所以就这么配：

```gitignore
# .gitignore
.fvm/
```

克隆项目后跑一下 `fvm install`（它读的就是已提交的 `.fvmrc`），SDK 版本就跟团队一致了。

### 3. dart-define 与环境变量注入

#### dart-define 是干嘛的

`--dart-define` 是在构建时注入常量值，不用改代码就能改变构建行为：

```bash
flutter build apk \
  --dart-define=API_BASE_URL=https://api.example.com \
  --dart-define=ENABLE_LOGGING=false \
  --dart-define=APP_ENV=production
```

Dart 端靠 `String.fromEnvironment` 读：

```dart
class BuildConfig {
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://api-dev.example.com',
  );

  static const bool enableLogging = bool.fromEnvironment(
    'ENABLE_LOGGING',
    defaultValue: true,
  );

  static const String appEnv = String.fromEnvironment(
    'APP_ENV',
    defaultValue: 'dev',
  );

  static bool get isProduction => appEnv == 'production';
}
```

#### dart-define-file：批量注入

变量一多，就换成文件批量注入：

```bash
flutter build apk --dart-define-file=env/production.env
```

```properties
# env/production.env
API_BASE_URL=https://api.example.com
ENABLE_LOGGING=false
APP_ENV=production
SENTRY_DSN=https://xxx@sentry.io/123
```

**注意**：`.env` 文件别提交到 Git（里面有敏感信息），要加进 `.gitignore`。团队之间共享模板文件就行（如 `env/production.env.example`）。

#### dart-define vs Flavor 怎么选？

| 维度 | Flavor | dart-define |
|------|--------|-------------|
| 原生端配置 | 支持（Android productFlavors / iOS Scheme） | 不支持（原生端读不到） |
| Dart 端配置 | 靠入口文件区分 | 靠编译时常量 |
| 构建变体 | 每个 Flavor 单独构建 | 同一份构建 + 换个参数 |
| 适用场景 | 环境差异大（API、包名、图标都不同） | 环境差异小（只有几个变量不同） |
| 复杂度 | 高（两端原生都得配） | 低（一个参数搞定） |

实际项目里建议搭着用：Flavor 管大的环境分类（dev/staging/production），dart-define 管同一环境内的微调（如 A/B 实验开关、动态 DSN）。

### 4. 构建产物分析与包体积优化

#### 分析工具

```bash
# 生成包体积分析报告（终端输出树状明细）
fvm flutter build apk --analyze-size
fvm flutter build ios --analyze-size

# 更细致的分析：Android Studio 的 APK Analyzer，或 DevTools 的 App Size Tool
```

Flutter DevTools 里的 App Size Tool 能可视化看：

```bash
fvm flutter pub global activate devtools
fvm flutter pub global run devtools
```

#### 包体积优化策略

**1. 代码分割：Deferred Import**

```dart
// 懒加载非首屏必需的模块
import 'package:my_app/feature/payment.dart' deferred as payment;

class OrderPage extends StatelessWidget {
  Future<void> _openPayment() async {
    await payment.loadLibrary(); // 按需加载
    Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => payment.PaymentPage()),
    );
  }
}
```

**效果**：首屏不用加载支付模块的代码，初始包体积能少 5-15%（看模块大小）。

**代价**：第一次加载会有延迟（约 50-200ms），得加个 loading 指示器。

**2. 资源优化**

```yaml
# pubspec.yaml - 精确指定资源，不用整个目录
flutter:
  assets:
    - assets/images/home/     # 只包含首页必需图片
    # - assets/images/        # 不要整目录引入
```

- 图片走 WebP 格式（比 PNG 小 25-35%）
- 矢量图标用 `IconData`，别拿图片顶
- 大图用 `cached_network_image` 从服务端拉，不打进 APK

**3. Tree Shaking**

Flutter 默认开着 Tree Shaking，但这几种情况会让它失效：

- `dynamic` 类型调用 → 编译器定不了调用目标，只能把所有可能的方法都留着
- 反射（`dart:mirrors`）→ Flutter 直接禁用了，不用担心
- 全局变量引用 → 就算没用到也会保留

想让 Tree Shaking 真生效：别用 `dynamic`，用强类型；把没用的 `import` 删掉。

**4. 去掉用不上的平台支持**

```bash
# 只构建目标平台
flutter build apk --target-platform android-arm64
# 不加此参数默认构建 armeabi-v7a + arm64-v8a + x86_64
```

**5. 字体子集化**

```yaml
# pubspec.yaml
flutter:
  fonts:
    - family: MyCustomFont
      fonts:
        - asset: fonts/MyCustomFont-Regular.ttf
          weight: 400
```

只保留应用里真正用到的字符，工具用 [pyftsubset（fonttools）](https://fonttools.readthedocs.io/en/latest/subset/index.html)。

#### 这些手段各能省多少

| 优化手段 | 预期减少 |
|----------|----------|
| Deferred Import | 5-15% |
| WebP 替代 PNG | 25-35%（图片部分） |
| 去除 x86_64 | 10-15% |
| 字体子集化 | 视使用字符数 |
| Tree Shaking | 默认已开启 |
| --split-debug-info | 20-30%（分离符号表） |

```bash
# 分离调试符号（生产包必须做）
flutter build apk --split-debug-info=debug-info --obfuscate=true
```

### 5. Android 多渠道打包 [Android]

国内的 Android 市场，每个应用商店都得打不同的包（渠道号不一样，用来做统计）。

#### 方案一：Android Product Flavor

```groovy
// android/app/build.gradle
android {
  flavorDimensions += "channel"

  productFlavors {
    huawei { dimension = "channel"; resValue "string", "channel", "huawei" }
    xiaomi { dimension = "channel"; resValue "string", "channel", "xiaomi" }
    oppo { dimension = "channel"; resValue "string", "channel", "oppo" }
    vivo { dimension = "channel"; resValue "string", "channel", "vivo" }
    wandoujia { dimension = "channel"; resValue "string", "channel", "wandoujia" }
  }
}
```

**问题**：每个渠道都得编译一次，10 个渠道就是 10 次编译，太慢了。

#### 方案二：APK Meta-data 注入（推荐）

只编译一次，用脚本改 APK 的 meta-data，把渠道号写进去：

```bash
# 使用 walle 多渠道打包工具
java -jar walle-cli-all.jar put -c huawei app-release.apk app-huawei.apk
java -jar walle-cli-all.jar put -c xiaomi app-release.apk app-xiaomi.apk
```

Dart 端读取渠道号：

```dart
// 通过 MethodChannel 读取 [Android]
class ChannelService {
  static const _channel = MethodChannel('com.example/channel');

  Future<String> getChannel() async {
    if (!Platform.isAndroid) return 'default';
    return await _channel.invokeMethod<String>('getChannel') ?? 'unknown';
  }
}
```

```kotlin
// Android 端读取 [Android]
override fun onMethodCall(call: MethodCall, result: Result) {
  when (call.method) {
    "getChannel" -> {
      val channel = WalleChannelReader.getChannel(context) ?: "unknown"
      result.success(channel)
    }
  }
}
```

**优势**：只编一次，几百个渠道包几秒钟就出来了。

#### 方案三：AGP 8.0+ Variant API

```groovy
// android/app/build.gradle (AGP 8.0+)
androidComponents {
  onVariants(selector().all()) { variant ->
    variant.outputs.forEach { output ->
      // 通过 Variant API 在构建时注入渠道信息
    }
  }
}
```

### 6. iOS 多 Target 配置 [iOS]

iOS 没有 Android Product Flavor 那套东西，只能靠多 Target 来做：

#### 创建多 Target

1. 在 Xcode 中复制 Runner Target → 命名为 `Runner-Dev`、`Runner-Staging`
2. 每个 Target 有独立的：
   - Bundle Identifier（`com.example.app.dev`）
   - Display Name（`MyApp-Dev`）
   - Info.plist
   - Assets（不同图标/启动图）
   - 预处理宏（`DEV=1`、`STAGING=1`）

```swift
// 通过预处理宏区分环境
#if DEV
let apiBaseUrl = "https://api-dev.example.com"
#elseif STAGING
let apiBaseUrl = "https://api-staging.example.com"
#else
let apiBaseUrl = "https://api.example.com"
#endif
```

#### 构建命令

```bash
# 构建 dev Target
flutter build ios --flavor dev -t lib/main_dev.dart

# 构建 production Target
flutter build ios --flavor production -t lib/main_production.dart
```

#### iOS 多 Target 的坑

- **Podfile 配置**：每个 Target 都得在 Podfile 里单独配一份
- **证书与描述文件**：每个 Target 的 Bundle ID 都要有独立的签名配置
- **CI/CD 复杂度**：每个 Target 都要单独构建和上传

### 7. 构建流程规范化

#### CI/CD 流水线

```
代码提交 → Lint/Analyze → 单元测试 → 构建 → 包体积检查 → 签名 → 分发
```

```yaml
# GitHub Actions 完整示例
name: Build & Deploy

on:
  push:
    branches: [main, develop]

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install FVM
        run: dart pub global activate fvm

      - name: Install Flutter SDK
        run: fvm install

      - name: Install dependencies
        run: fvm flutter pub get

      - name: Analyze
        run: fvm flutter analyze

      - name: Test
        run: fvm flutter test --coverage

      - name: Build Android [Android]
        run: |
          fvm flutter build apk \
            --flavor production \
            --dart-define-file=env/production.env \
            --split-debug-info=debug-info \
            --obfuscate=true

      - name: Size Check
        run: |
          SIZE=$(stat -f%z build/app/outputs/flutter-apk/app-production-release.apk)
          if [ $SIZE -gt 52428800 ]; then
            echo "APK size exceeds 50MB!"
            exit 1
          fi
```

#### 版本号管理

```bash
# pubspec.yaml 中的版本号
# version: 1.2.3+45
# 1.2.3 = 版本号 (semver)
# 45 = 构建号 (build number, 必须单调递增)

# CI 中自动递增构建号
flutter build apk --build-number=$GITHUB_RUN_NUMBER
```

## 常见坑

### 1. Flavor 与 dart-define 混用导致配置不一致

Flutter 端能用 `String.fromEnvironment` 读到 dart-define，但原生端读不到这些值。要是原生端也需要环境配置（比如推送 SDK 的 AppKey），就得在原生端单独配一份（通过 Flavor 或 buildConfigField）。

### 2. iOS Archive 失败

`flutter build ios` 能过，但 Xcode Archive 失败，一般是这几个原因：
- Signing 配置不正确（Team / Provisioning Profile）
- 多 Target 的 Podfile 配置遗漏
- Bitcode 设置不一致

**解法**：先在 Xcode 里手动 Archive 一次，确认配置没问题，再挪到 CI。

### 3. 热重载不生效

用 `--dart-define` 构建之后，改 `String.fromEnvironment` 的值热重载是不生效的，因为它们是编译时常量。

**解法**：只能整个重启（Hot Restart 也不行，得 stop + run）。

### 4. FVM 缓存污染

FVM 换过版本之后，旧的 `pubspec.lock` 可能引着新版本不兼容的依赖。

**解法**：切完 FVM 版本就把 `pubspec.lock` 和 `.dart_tool/` 删掉，重新 `pub get`。

### 5. 包体积分析误判

`flutter build apk --analyze-size` 报出来的体积把所有 ABI 都算进去了，但每个 ABI 其实是独立的 .so 文件。按 ABI 拆开看，真实体积要小不少。

**解法**：用 `--target-platform android-arm64` 只编单 ABI，再来分析。

## 面试追问

### 多环境方案怎么选？

就看环境差异有多大。差异大（API、包名、图标、推送 Key 全都不一样）用 Flavor + 多入口文件，它能同时把 Dart 端和原生端配好；差异小（就几个 API 地址不同）用 dart-define，简单快。实际项目里我建议一起用：Flavor 定大类（dev/staging/production），dart-define 做同环境内的微调。

### 包体积优化做了哪些？

分三类答：1）编译优化：`--split-debug-info` 分离符号表、`--obfuscate` 代码混淆、`--target-platform` 指定 ABI、Tree Shaking 默认开着；2）资源优化：WebP 替 PNG、字体子集化、大图走网络加载不打进包；3）代码分割：Deferred Import 懒加载非首屏模块。关键是要有度量：每次发版前跑一遍包体积检查，超了阈值自动报错。

### FVM 解决了什么问题？不用 FVM 会怎样？

FVM 就是拿来把团队的 SDK 版本对齐的。不用 FVM 会出这些事：不同开发者 `flutter pub get` 出来的结果不一样（`pubspec.lock` 频繁变更）、有些 API 低版本用不了直接编译失败、CI 构建复现不了（每次拿最新 SDK 构建可能引入 Breaking Change）。FVM 靠 `.fvmrc` 锁住项目的 SDK 版本，保证所有人用的是同一个版本。

### Android 多渠道打包怎么做的？为什么不每个渠道编译一次？

用 walle 这类 APK 二进制修改工具，只编一次，靠改 APK 的 meta-data 把渠道号写进去，几百个渠道包几秒钟就生成完了。每个渠道编一次的问题就是耗时长：10 个渠道要编 10 次，一次 5-10 分钟，加起来快一个小时。walle 这套只编一次，后面就是复制 + 改 meta-data，毫秒级的事。

### 如何设计一套完整的构建管理体系？

分四个层面：1）**环境管理**：Flavor 定环境大类 + dart-define 注入细粒度变量 + .env 文件管敏感配置；2）**版本管理**：FVM 锁 SDK 版本 + pubspec.lock 锁依赖版本 + CI 自动递增 build number；3）**构建优化**：包体积分析 + 阈值检查 + Deferred Import + 资源压缩 + 单 ABI 构建；4）**分发管理**：Android walle 多渠道 + iOS 多 Target + CI/CD 自动构建上传。核心就三条：**构建结果可复现**（相同代码+相同环境=相同产物）、**构建过程可追溯**（每次构建都有日志和产物归档）、**构建质量可度量**（包体积、启动耗时、崩溃率都有基线）。

## 参考资源

- [Flutter 官方：Flavors](https://docs.flutter.dev/deployment/flavors)
- [FVM 官方文档](https://fvm.app/)
- [Flutter 官方：包体积优化](https://docs.flutter.dev/perf/app-size)
- [Walle 多渠道打包](https://github.com/Meituan-Dianping/Walle)
- [dart-define 官方说明](https://docs.flutter.dev/testing/build-modes#declare-compilation-variables)
