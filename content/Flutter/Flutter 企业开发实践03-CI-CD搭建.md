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

没有 CI/CD 的团队，发布流程是这样的：开发手动 `flutter build` → 等编译 → 手动签名 → 手动上传 → 发现打包配置错了 → 重来。一次发版半天，而且每次都可能出错。

CI/CD 解决的核心问题是**把人的操作变成代码**：构建步骤写在 YAML 里，签名证书存在密钥管理中，分发逻辑自动化执行。人只负责点"发布"按钮——甚至这个按钮也可以省掉。

本文从架构师视角讲清楚：CI 流水线怎么设计、多环境怎么管理、签名和证书怎么安全处理、以及 Flutter 专用 CI 方案的取舍。

---

## 一、GitHub Actions / GitLab CI 配置

### 1.1 Flutter 项目的 CI 流水线设计

一条完整的 CI 流水线应该包含：

```
Push/PR → Lint → Test → Build → Archive → Distribute
```

**GitHub Actions 示例**：

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
      - uses: codecov/codecov-action@v3
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

### 1.2 GitLab CI 的差异点

GitLab CI 的核心区别：

1. **Runner 自建**：可以用 Mac mini 做 Runner，避免 macOS 机器的分钟费
2. **环境变量管理**：`Settings → CI/CD → Variables`，支持 Protected（仅保护分支可用）和 Masked（日志中隐藏）
3. **缓存**：GitLab CI 的缓存机制更适合自建 Runner（本地缓存目录）

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

### 1.3 CI 中的 Flutter 版本管理

```yaml
# 方式1：固定版本（推荐生产环境）
- uses: subosito/flutter-action@v2
  with:
    flutter-version: '3.22.0'

# 方式2：从 pubspec.yaml 读取版本（单一事实来源）
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: pubspec.yaml  # 读取 environment.sdk

# 方式3：使用 FVM（Flutter Version Management）
- run: fvm flutter build apk --release
```

**推荐方式 2**：版本信息只维护在 `pubspec.yaml` 一处，避免 YAML 和 pubspec 版本不一致。

---

## 二、Fastlane 自动化打包

### 2.1 为什么需要 Fastlane

CI 平台能执行 `flutter build`，但**签名 + 上架**这一步极其繁琐：
- `[Android]`：生成签名 APK → 上传 Google Play → 填写发版说明
- `[iOS]`：匹配证书 → Archive → 导出 IPA → 上传 App Store Connect → 提交审核

Fastlane 把这些步骤封装成一条命令，并且**跨 CI 平台**：GitHub Actions 和 GitLab CI 都能用同一套 Fastlane 配置。

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

iOS 证书管理是最容易翻车的环节。`match` 把证书和 Provisioning Profile 存在一个**私有 Git 仓库**中，团队成员和 CI 都从这里拉取：

```ruby
# Matchfile
git_url("https://github.com/your-org/certificates")
storage_mode("git")
type("appstore")
app_identifier("com.your.app")
username("your@apple-id.com")
```

**关键安全措施**：
1. 证书仓库设置 `match_password` 加密
2. CI 中通过环境变量传入密码，不写在配置文件里
3. 证书仓库的访问权限严格限制，只有 CI 和指定开发者可读

---

## 三、多环境管理（dev/staging/prod）

### 3.1 为什么需要多环境

| 环境 | 用途 | 后端 | 安装方式 |
|---|---|---|---|
| dev | 开发自测 | 本地/开发服务器 | 直接运行 |
| staging | 测试团队验证 | 预发布服务器 | 内测分发 |
| prod | 线上用户 | 生产服务器 | 应用商店 |

三个环境可能同时存在于一台测试手机上，所以每个环境需要**不同的包名/Bundle ID**。

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

iOS 侧需要创建对应的 Scheme：`Runner-dev`、`Runner-staging`、`Runner-runner`。

**方案 2：dart-define（轻量级）**

不需要改原生配置，通过编译时常量切换环境：

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

**区别**：Flavor 可以改变包名（同设备多环境共存），dart-define 不能。需要同设备安装多环境 App 的场景必须用 Flavor。

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

### 4.2 CI 中的测试策略

```yaml
# 单元测试：每次 PR 都跑
- run: flutter test --coverage

# Widget 测试：合并到 main 时跑
- run: flutter test test/widgets/

# 集成测试：发版前跑（需要设备）
- run: flutter test integration_test/
  # GitHub Actions 中使用 reactivecircus/android-emulator-runner
```

### 4.3 集成测试在 CI 中的挑战

集成测试需要真实设备/模拟器，CI 中的配置较复杂：

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

**注意**：集成测试不稳定（模拟器启动慢、UI 渲染时序不确定），建议：
1. 只对核心购买/注册流程写集成测试
2. 设置合理的重试策略（失败重试 1 次）
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

## 五、Codemagic / AppCenter 等 Flutter 专用 CI 方案

### 5.1 专用 CI vs 通用 CI

| 维度 | GitHub Actions / GitLab CI | Codemagic | AppCenter |
|---|---|---|---|
| 配置自由度 | 极高 | 中 | 低 |
| macOS 机器成本 | 贵（$0.08/min） | 包含在套餐内 | 包含在套餐内 |
| Flutter 预装 | ❌ 需手动安装 | ✅ 开箱即用 | ✅ 开箱即用 |
| iOS 签名管理 | 需自己处理 | ✅ 自动化签名 | ✅ 自动化签名 |
| 免费额度 | 2000 min/月 | 500 min/月 | 2400 min/月 |
| 适合场景 | 需要定制流水线 | 快速上手、小团队 | 微软生态团队 |

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

### 5.3 选型建议

- **小团队（<5 人）+ 预算充足**：Codemagic，省去 CI 搭建和签名管理的麻烦
- **中大型团队**：GitHub Actions / GitLab CI + Fastlane，自定义能力强
- **已有 macOS 机器**：自建 GitLab Runner，长期成本最低

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
    skip_waiting_for_build_processing: true,
    distribute_external: true,
    groups: ["Internal Testers"]
  )
end
```

### 6.4 发版自动化完整流程

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

## 常见坑与踩点

### 1. CI 中 Flutter 版本与本地不一致

本地用 Flutter 3.22 开发，CI 用 3.19 构建，产生编译错误。**解法**：在 `pubspec.yaml` 中锁定 SDK 版本约束，CI 配置从 pubspec 读取版本。

### 2. iOS 签名在 CI 中反复失败

证书过期、Profile 不匹配、Keychain 访问权限——iOS 签名问题占 CI 调试时间的 50%。**解法**：用 `match` 统一管理证书，CI 中用 `match` 的 `readonly` 模式拉取，不在 CI 中创建新证书。

### 3. 构建缓存未利用

每次 CI 都从零 `flutter pub get` + 编译，耗时 10+ 分钟。**解法**：缓存 `.dart_tool/` 和 `build/` 目录，利用 Flutter 的增量编译。

```yaml
- uses: actions/cache@v3
  with:
    path: |
      ~/.pub-cache
      .dart_tool
    key: ${{ runner.os }}-pub-${{ hashFiles('**/pubspec.lock') }}
```

### 4. 多环境打包时混淆配置

staging 包打成了 prod 的 API 地址。**解法**：在 App 启动页显著显示当前环境标识（如红色角标 "STAGING"），打包脚本增加校验步骤。

### 5. 集成测试的时序问题

`pumpAndSettle()` 在 CI 的慢机器上超时。**解法**：用 `pump(Duration)` 替代 `pumpAndSettle()`，或增加 `pumpAndSettle` 的超时时间。

---

## 面试追问

### 🌱 CI 流水线中 lint 和 test 哪个先跑？

**lint 先跑**，因为 lint 最快（秒级），能最快反馈明显的代码问题。test 较慢（分钟级），放在 lint 之后。这样如果有明显的格式问题，开发者不用等测试跑完才看到失败。

### 🌱 Flutter 的 CI 构建时间太长怎么办？

1. **缓存 pub cache 和 build 目录**
2. **拆分 Job 并行**：Android 和 iOS 构建并行跑
3. **只构建变更平台**：PR 中只改了 Dart 代码时两端都构建；只改了 Android 原生代码时只构建 Android
4. **使用 self-hosted Runner**（macOS 机器，避免冷启动）
5. **开启 Flutter 的 `--no-pub` 选项**（如果 pub get 已在前面步骤完成）

### 🌿 iOS 证书管理的最佳实践是什么？

1. **统一管理**：用 `match` 或手动将证书存入加密 Git 仓库
2. **CI 只读**：CI 中用 `readonly: true` 模式，不创建/修改证书
3. **定期轮换**：证书过期前 30 天自动告警
4. **环境隔离**：dev/staging/prod 用不同的 Bundle ID 和证书，避免互相影响

### 🌿 如何实现"一键发版"？

1. 开发者在 GitHub 上创建 Release Tag
2. CI 监听 Tag 创建事件，触发发版流水线
3. 流水线：测试 → 构建 → 签名 → 上传商店 → 通知
4. 关键：**所有敏感信息（证书、密钥、密码）都存在 CI 的 Secret 中**，YAML 里只引用变量名

### 🌳 多个 Flutter App 共享 CI 配置怎么管理？

1. **CI 配置模板化**：把通用步骤抽成 GitHub Actions 的 Composite Action 或 GitLab CI 的 include 文件
2. **每个 App 的特殊配置**：通过环境变量覆盖
3. **Fastlane 共享**：把通用 lane 抽成 Ruby Gem，各 App 引用
4. **统一版本管理**：Flutter、Ruby、CocoaPods 等版本在团队 Wiki 中统一维护

---

## 参考资源

- [Flutter 官方 - CI/CD 指南](https://docs.flutter.dev/deployment/cd)
- [Fastlane 官方文档](https://docs.fastlane.tools/)
- [Codemagic 官方文档](https://docs.codemagic.io/)
- [GitHub Actions - Flutter 工作流模板](https://github.com/marketplace/actions/flutter-action)
- [match - 证书管理最佳实践](https://docs.fastlane.tools/actions/match/)
