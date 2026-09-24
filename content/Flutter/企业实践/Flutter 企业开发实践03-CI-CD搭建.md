---
title: Flutter 企业开发实践03-CI-CD搭建
date: 2026-06-01
tags:
  - Flutter
  - CI/CD
  - GitHub Actions
  - Fastlane
  - 企业级
  - 自动化
---

# CI/CD 搭建

## 概述

没有 CI/CD 的团队，发布流程是这样的：开发手动 `flutter build`，等着编译，手动签名，手动上传，结果发现打包配置写错了，然后重来一遍。发一次版半天就没了，而且每次都可能出错。

CI/CD 核心解决的一件事，就是**把人的操作变成代码**：构建步骤写在 YAML 里，签名证书放在密钥管理里，分发的活交给脚本自动跑。人只管点"发布"按钮，甚至这个按钮也可以省掉。

本文讲四件事：CI 流水线怎么设计，多环境怎么管，签名和证书怎么安全处理，Flutter 专用 CI 方案怎么取舍。

---

## 一、GitHub Actions / GitLab CI 配置

### 1.1 Flutter 项目的 CI 流水线设计

一条完整的 CI 流水线，大概长这样：

```
Push/PR → Lint → Test → Build → Archive → Distribute
```

**GitHub Actions 的例子**：

```yaml
name: Flutter CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.22.0'
          channel: 'stable'
      - run: flutter pub get
      - run: dart analyze --fatal-infos
      - run: dart format --set-exit-if-changed .
      - run: flutter test --coverage
      - uses: codecov/codecov-action@v5
        with:
          files: coverage/lcov.info

  build-android:
    needs: lint-and-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.22.0'
      # 解码签名文件
      - name: Decode keystore
        run: echo "${{ secrets.KEYSTORE_BASE64 }}" | base64 -d > android/app/keystore.jks
      - name: Create key.properties
        run: |
          echo "storePassword=${{ secrets.KEYSTORE_PASSWORD }}" > android/key.properties
          echo "keyPassword=${{ secrets.KEY_PASSWORD }}" >> android/key.properties
          echo "keyAlias=${{ secrets.KEY_ALIAS }}" >> android/key.properties
          echo "storeFile=keystore.jks" >> android/key.properties
      - run: flutter build apk --release
      - uses: actions/upload-artifact@v4
        with:
          name: release-apk
          path: build/app/outputs/flutter-apk/app-release.apk

  build-ios:
    needs: lint-and-test
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.22.0'
      - name: Install Apple certificates
        uses: apple-actions/import-codesign-certs@v2
        with:
          p12-file-base64: ${{ secrets.IOS_CERTIFICATE_BASE64 }}
          p12-password: ${{ secrets.IOS_CERTIFICATE_PASSWORD }}
      - name: Install provisioning profile
        run: |
          mkdir -p ~/Library/MobileDevice/Provisioning\ Profiles
          echo "${{ secrets.PROVISIONING_PROFILE_BASE64 }}" | base64 -d > ~/Library/MobileDevice/Provisioning\ Profiles/profile.mobileprovision
      - run: flutter build ios --release --no-codesign
      - name: Archive & Export
        run: |
          cd ios
          xcodebuild -workspace Runner.xcworkspace -scheme Runner \
            -archivePath build/Runner.xcarchive archive \
            -destination 'generic/platform=iOS'
          xcodebuild -exportArchive \
            -archivePath build/Runner.xcarchive \
            -exportOptionsPlist ExportOptions.plist \
            -exportPath build/ipa
      - uses: actions/upload-artifact@v4
        with:
          name: release-ipa
          path: ios/build/ipa/*.ipa
```

### 1.2 GitLab CI 不一样在哪

GitLab CI 跟它比，主要是这几点：

1. **Runner 自建**：拿台 Mac mini 当 Runner 就行，能避开 macOS 机器的分钟费
2. **环境变量管理**：在 `Settings → CI/CD → Variables` 这里配，支持 Protected（只有保护分支能用）和 Masked（日志里打码）
3. **缓存**：GitLab CI 的缓存机制更适合自建 Runner，缓存目录就在本地

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build

flutter_test:
  stage: test
  tags:
    - mac-mini  # 自建 Runner 的 tag
  script:
    - flutter pub get
    - flutter test
  cache:
    paths:
      - .dart_tool/
      - build/

build_android:
  stage: build
  tags:
    - mac-mini
  script:
    - flutter build apk --release
  artifacts:
    paths:
      - build/app/outputs/flutter-apk/app-release.apk
  only:
    - main
```

### 1.3 CI 里怎么管 Flutter 版本

```yaml
# 方式1：固定版本（推荐生产环境）
- uses: subosito/flutter-action@v2
  with:
    flutter-version: '3.22.0'

# 方式2：从 pubspec.yaml 读版本（版本只维护这一处）
# 注意：flutter-version-file 读的是 pubspec 里的 environment.flutter 字段
# （不是 environment.sdk，那是 Dart SDK 约束如 ^3.4.0，当版本号用会直接失效）
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: pubspec.yaml

# pubspec.yaml 里要这样写：
# environment:
#   sdk: ^3.4.0
#   flutter: 3.22.0   ← flutter-version-file 读的是这一行

# 方式3：用 FVM（Flutter Version Management）
# 注意 GitHub 托管的 runner 没预装 fvm，得先装：
# - run: dart pub global activate fvm && echo $HOME/.pub-cache/bin >> $GITHUB_PATH
- run: fvm flutter build apk --release
```

**我推荐方式 2**：版本只在 `pubspec.yaml` 里写一处，YAML 和 pubspec 就不会对不上。但要记住，读的是 `environment.flutter` 那行。写进 `sdk` 约束里，CI 会不声不响用错版本。

---

## 二、Fastlane 自动化打包

### 2.1 为什么还要上 Fastlane

CI 平台能跑 `flutter build`，但**签名 + 上架**这一步特别烦：
- `[Android]`：生成签名 APK → 上传 Google Play → 填写发版说明
- `[iOS]`：匹配证书 → Archive → 导出 IPA → 上传 App Store Connect → 提交审核

Fastlane 说白了就把这些步骤收成一条命令，而且**跨 CI 平台**：GitHub Actions 和 GitLab CI 用的都是同一套 Fastlane 配置。

### 2.2 Fastlane 配置

```
项目根目录/
├── android/
│   └── fastlane/
│       ├── Appfile        # 包名、JSON 密钥路径
│       └── Fastfile       # 打包逻辑
├── ios/
│   └── fastlane/
│       ├── Appfile        # Bundle ID、Apple ID
│       ├── Fastfile
│       └── Matchfile      # 证书管理配置
└── Gemfile                # Ruby 依赖锁定
```

**Android Fastfile**：

```ruby
default_platform(:android)

platform :android do
  desc "Build and upload to Google Play"
  lane :release do
    sh("flutter build appbundle --release")
    upload_to_play_store(
      track: 'internal',
      aab: '../build/app/outputs/bundle/release/app-release.aab',
      json_key: 'path/to/service-account.json'
    )
  end
end
```

**iOS Fastfile**：

```ruby
default_platform(:ios)

platform :ios do
  desc "Build and upload to App Store Connect"
  lane :release do
    match(type: "appstore", readonly: true)  # 从 Git 仓库拉取证书
    sh("flutter build ios --release --no-codesign")
    build_ios_app(
      workspace: "Runner.xcworkspace",
      scheme: "Runner",
      export_method: "app-store",
      output_directory: "./build"
    )
    upload_to_app_store(
      skip_screenshots: true,
      skip_metadata: true
    )
  end
end
```

### 2.3 match：证书管理

iOS 证书管理是最容易翻车的地方。`match` 把证书和 Provisioning Profile 放进一个**私有 Git 仓库**，团队成员和 CI 都从这儿拉：

```ruby
# Matchfile
git_url("https://github.com/your-org/certificates")
storage_mode("git")
type("appstore")
app_identifier("com.your.app")
username("your@apple-id.com")
```

**关键安全措施**：
1. 证书仓库用 `match_password` 加密
2. CI 里密码走环境变量传，别写进配置文件
3. 证书仓库权限收窄，只有 CI 和指定的几个开发者能读

---

## 三、多环境管理（dev/staging/prod）

### 3.1 为什么一个 App 要分三个环境

| 环境 | 用途 | 后端 | 安装方式 |
|---|---|---|---|
| dev | 开发自测 | 本地/开发服务器 | 直接运行 |
| staging | 测试团队验证 | 预发布服务器 | 内测分发 |
| prod | 线上用户 | 生产服务器 | 应用商店 |

三个环境可能同时装在一台测试机上，所以每个环境都得有**不同的包名/Bundle ID**。

### 3.2 Flutter 多环境配置方案

**方案 1：Flavor（推荐）**

Android 用 `productFlavors`，iOS 用 Xcode Scheme：

```groovy
// android/app/build.gradle
android {
  flavorDimensions = ["environment"]
  productFlavors {
    dev {
      dimension = "environment"
      applicationIdSuffix = ".dev"
      resValue "string", "app_name", "MyApp-Dev"
    }
    staging {
      dimension = "environment"
      applicationIdSuffix = ".staging"
      resValue "string", "app_name", "MyApp-Staging"
    }
    prod {
      dimension = "environment"
      resValue "string", "app_name", "MyApp"
    }
  }
}
```

```bash
# 构建 dev 环境
flutter build apk --flavor dev
flutter build ios --flavor dev
```

iOS 这边得建对应的 Scheme：`Runner-dev`、`Runner-staging`（prod 可以直接用默认 Scheme，也可以建 `Runner-prod`）。

**方案 2：dart-define（轻量级）**

这个不用动原生配置，靠编译时常量切环境：

```bash
flutter build apk \
  --dart-define=ENV=staging \
  --dart-define=API_URL=https://staging.api.com
```

```dart
// 读取配置
class EnvConfig {
  static const env = String.fromEnvironment('ENV', defaultValue: 'dev');
  static const apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://localhost:8080');
}
```

**区别**：Flavor 能改包名，同一台设备上多个环境可以共存，dart-define 做不到。要在同一台设备上装多个环境的 App，只能用 Flavor。

### 3.3 环境配置文件管理

```
lib/
├── config/
│   ├── app_config.dart       # 抽象类
│   ├── dev_config.dart       # dev 实现
│   ├── staging_config.dart   # staging 实现
│   └── prod_config.dart      # prod 实现
```

```dart
abstract class AppConfig {
  String get apiBaseUrl;
  String get appName;
  bool get enableLogging;
  Duration get apiTimeout;
}

class DevConfig implements AppConfig {
  @override
  String get apiBaseUrl => 'http://10.0.2.2:8080'; // Android 模拟器访问宿主机
  @override
  String get appName => 'MyApp-Dev';
  @override
  bool get enableLogging => true;
  @override
  Duration get apiTimeout => const Duration(seconds: 30);
}

class ProdConfig implements AppConfig {
  @override
  String get apiBaseUrl => 'https://api.myapp.com';
  @override
  String get appName => 'MyApp';
  @override
  bool get enableLogging => false;
  @override
  Duration get apiTimeout => const Duration(seconds: 10);
}
```

**在 DI 层注册**：

```dart
void setupDependencies() {
  final config = switch (EnvConfig.env) {
    'prod' => ProdConfig(),
    'staging' => StagingConfig(),
    _ => DevConfig(),
  };
  Get.put<AppConfig>(config);
}
```

---

## 四、自动化测试在 CI 中的集成

### 4.1 测试金字塔

```
        ┌──────────┐
        │  E2E 测试  │  ← 少量，慢，验证核心流程
       ┌┴──────────┴┐
       │  Widget 测试  │  ← 中量，验证 UI 交互
      ┌┴────────────┴┐
      │   单元测试     │  ← 大量，快，验证业务逻辑
     └──────────────┘
```

### 4.2 CI 里跑哪些测试

```yaml
# 单元测试：每次 PR 都跑
- run: flutter test --coverage

# Widget 测试：合并到 main 时跑
- run: flutter test test/widgets/

# 集成测试：发版前跑（要真机）
- run: flutter test integration_test/
  # GitHub Actions 里用 reactivecircus/android-emulator-runner
```

### 4.3 集成测试在 CI 里的麻烦

集成测试得有真机或者模拟器，在 CI 里配起来比较复杂：

**Android 模拟器方案**：

```yaml
- uses: reactivecircus/android-emulator-runner@v2
  with:
    api-level: 33
    script: flutter test integration_test/
```

**iOS 模拟器方案**（macOS Runner）：

```yaml
- name: Run integration tests
  run: |
    xcrun simctl create "iPhone 15" "iPhone 15" iOS17.0
    flutter test integration_test/ -d "iPhone 15"
```

**注意**：集成测试不稳定，模拟器启动慢、UI 渲染时序也说不准，建议这么办：
1. 只给核心的购买、注册流程写集成测试
2. 重试策略设合理点（失败重试 1 次）
3. 不阻塞 PR 合并，只阻塞发版

### 4.4 测试覆盖率门禁

```yaml
- name: Check coverage
  run: |
    flutter test --coverage
    # 移除 generated 文件
    lcov --remove coverage/lcov.info 'lib/**/*.g.dart' 'lib/**/*.freezed.dart' -o coverage/lcov.info
    # 生成报告
    genhtml coverage/lcov.info -o coverage/html
    # 检查阈值（示例：核心模块覆盖率 > 80%）
    COVERAGE=$(lcov --summary coverage/lcov.info 2>&1 | grep lines | awk '{print $2}' | sed 's/%//')
    if (( $(echo "$COVERAGE < 80" | bc -l) )); then
      echo "Coverage $COVERAGE% is below 80%"
      exit 1
    fi
```

---

## 五、Codemagic / Bitrise 等 Flutter 专用 CI 方案

> 历史 note：Visual Studio App Center 已经在 **2025 年 3 月 31 日正式退役**（微软官方公告，账号和 API 都不能用了）。网上还能搜到一堆 App Center 的分发教程，全都过时了，别再选它。

### 5.1 专用 CI vs 通用 CI

| 维度 | GitHub Actions / GitLab CI | Codemagic | Bitrise |
|---|---|---|---|
| 配置自由度 | 极高 | 中 | 中高 |
| macOS 机器 | 按分钟计费（2026-01 起降价：标准 macOS 约 $0.062/min、M1 larger runner 约 $0.102/min；macOS 任务按约 10 倍分钟数消耗配额） | 包含在套餐内 | 包含在套餐内 |
| Flutter 预装 | ❌ 需手动安装 | ✅ 开箱即用 | ✅ 开箱即用 |
| iOS 签名管理 | 需自己处理 | ✅ 自动化签名 | ✅ 自动化签名 |
| 免费额度 | 2000 min/月（Linux 计） | 500 min/月 | 有免费档（以官网为准） |
| 适合场景 | 需要定制流水线 | 快速上手、小团队 | 移动专项、需要托管 Mac 集群 |

### 5.2 Codemagic 配置示例

```yaml
# codemagic.yaml
workflows:
  ios-workflow:
    name: iOS Release
    environment:
      ios_signing:
        distribution_type: app_store
        bundle_identifier: com.your.app
      flutter: stable
    scripts:
      - name: Get Flutter packages
        script: flutter pub get
      - name: Run unit tests
        script: flutter test
      - name: Build IPA
        script: |
          flutter build ipa --release \
            --export-options-plist=/Users/builder/export_options.plist
    artifacts:
      - build/ios/ipa/*.ipa
    publishing:
      app_store_connect:
        apple_id: your@apple-id.com
        password: $APP_STORE_CONNECT_PASSWORD
```

### 5.3 怎么选

- **小团队（<5 人）+ 预算充足**：选 Codemagic，CI 搭建和签名管理这些麻烦事都省了
- **中大型团队**：GitHub Actions / GitLab CI + Fastlane，想怎么定制都行
- **已经有 macOS 机器**：自己搭 GitLab Runner，长期看成本最低

---

## 六、构建产物分发与内测分发

### 6.1 分发渠道

| 平台 | 内测分发 | 生产分发 |
|---|---|---|
| Android | Firebase App Distribution / 蒲公英 | Google Play / 国内各应用市场 |
| iOS | TestFlight | App Store |

### 6.2 Firebase App Distribution 集成

```yaml
# GitHub Actions 中的分发步骤
- name: Distribute to testers
  uses: wzieba/Firebase-Distribution-Github-Action@v1
  with:
    appId: ${{ secrets.FIREBASE_APP_ID }}
    serviceCredentialsFileContent: ${{ secrets.FIREBASE_CREDENTIALS }}
    groups: internal-testers
    file: build/app/outputs/flutter-apk/app-release.apk
```

### 6.3 TestFlight 自动分发

```ruby
# Fastfile 中
lane :beta do
  build_ios_app(...)
  upload_to_testflight(
    # 二选一，两个参数互相矛盾：
    # - skip_waiting: 上传完就返回，但此时构建还没处理完，
    #   不能 distribute_external（会静默失败）
    # - 等待处理完成后再分发到外部测试组
    skip_waiting_for_build_processing: false,
    distribute_external: true,
    groups: ["Internal Testers"]
  )
end
```

### 6.4 完整的发版自动化流程

```
开发者打 tag (v1.2.0)
  → CI 触发构建
    → 运行全量测试
    → 构建 Android AAB + iOS IPA
    → 上传到 Firebase / TestFlight
    → 创建 GitHub Release
    → 通知团队（Slack / 飞书 Webhook）
```

```yaml
# 自动创建 Release
- name: Create GitHub Release
  uses: softprops/action-gh-release@v1
  with:
    tag_name: ${{ github.ref_name }}
    name: Release ${{ github.ref_name }}
    files: |
      build/app/outputs/flutter-apk/app-release.apk
      ios/build/ipa/*.ipa
```

---

## 常见坑

### 1. CI 里 Flutter 版本和本地对不上

本地用 Flutter 3.22 开发，CI 拿 3.19 去构建，编译直接报错。**解法**：在 `pubspec.yaml` 的 `environment.flutter` 字段写明确版本号，CI 用 `flutter-version-file: pubspec.yaml` 来读（注意不是 `environment.sdk`，那是 Dart SDK 约束）。

### 2. iOS 签名在 CI 里反复失败

证书过期、Profile 对不上、Keychain 访问权限，iOS 签名问题占了 CI 调试时间的 50%。**解法**：用 `match` 统一管证书，CI 里用 `match` 的 `readonly` 模式拉取，不在 CI 里创建新证书。

### 3. 构建缓存没用上

每次 CI 都从零跑 `flutter pub get` 再加编译，一耗就是 10 多分钟。**解法**：把 `.dart_tool/` 和 `build/` 目录缓存起来，用上 Flutter 的增量编译。

```yaml
- uses: actions/cache@v3
  with:
    path: |
      ~/.pub-cache
      .dart_tool
    key: ${{ runner.os }}-pub-${{ hashFiles('**/pubspec.lock') }}
```

### 4. 多环境打包容易搞混配置

staging 的包打出去，里头的 API 地址却是 prod 的。**解法**：在 App 启动页明显标出当前环境（比如一个红色角标 "STAGING"），打包脚本里再加一步校验。

### 5. 集成测试的时序问题

`pumpAndSettle()` 在 CI 的慢机器上会超时。**解法**：把 `pumpAndSettle()` 换成 `pump(Duration)`，或者把 `pumpAndSettle` 的超时时间调大。

---

## 面试追问

### CI 流水线中 lint 和 test 哪个先跑？

**lint 先跑**。lint 最快，秒级就能给出反馈，明显的代码问题一眼就看到。test 慢一些，分钟级，排在 lint 后面。这样格式上如果有明显问题，开发者不用等测试跑完才知道。

### Flutter 的 CI 构建时间太长怎么办？

1. **缓存 pub cache 和 build 目录**
2. **拆分 Job 并行**：Android 和 iOS 的构建同时跑
3. **只构建变更的平台**：PR 里只改了 Dart 代码，两端都构建；只改了 Android 原生代码，就只构建 Android
4. **用 self-hosted Runner**（macOS 机器，省掉冷启动）
5. **打开 Flutter 的 `--no-pub` 选项**（如果 pub get 在前面步骤已经跑过）

### iOS 证书管理的最佳实践是什么？

1. **统一管理**：用 `match`，或者手动把证书存进加密的 Git 仓库
2. **CI 只读**：CI 里用 `readonly: true` 模式，不创建也不改证书
3. **定期轮换**：证书过期前 30 天自动告警
4. **环境隔离**：dev/staging/prod 各用各的 Bundle ID 和证书，别互相影响

### 如何实现"一键发版"？

1. 开发者在 GitHub 上打一个 Release Tag
2. CI 监听 Tag 创建事件，触发发版流水线
3. 流水线跑一遍：测试 → 构建 → 签名 → 上传商店 → 通知
4. 关键一点：**所有敏感信息（证书、密钥、密码）都存在 CI 的 Secret 中**，YAML 里只引用变量名

### 多个 Flutter App 共享 CI 配置怎么管理？

1. **CI 配置模板化**：把通用步骤抽成 GitHub Actions 的 Composite Action，或者 GitLab CI 的 include 文件
2. **每个 App 的特殊配置**：用环境变量覆盖
3. **Fastlane 共享**：把通用 lane 抽成 Ruby Gem，各 App 引用
4. **统一版本管理**：Flutter、Ruby、CocoaPods 这些版本，都在团队 Wiki 里统一维护

---

## 参考资源

- [Flutter 官方 - CI/CD 指南](https://docs.flutter.dev/deployment/cd)
- [Fastlane 官方文档](https://docs.fastlane.tools/)
- [Codemagic 官方文档](https://docs.codemagic.io/)
- [GitHub Actions - Flutter 工作流模板](https://github.com/marketplace/actions/flutter-action)
- [match - 证书管理最佳实践](https://docs.fastlane.tools/actions/match/)
