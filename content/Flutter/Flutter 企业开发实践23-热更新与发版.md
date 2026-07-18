---
title: Flutter 企业开发实践23-热更新与发版
date: 2026-05-18
tags:
  - Flutter
  - 热更新
  - Shorebird
  - 发版策略
  - 灰度发布
  - 回滚
---

# 热更新与发版——Flutter 为什么不能热更新及替代方案

## 概述

"Flutter 能不能热更新"是被问到最多的问题之一。答案很明确：**Flutter AOT 编译模式下无法像 React Native 那样下发 JavaScript Bundle 实现热更新**。但"不能热更新"不等于"没有快速修复的能力"——Shorebird 提供了代码推送方案，灰度发布可以控制问题的影响范围，强制更新可以兜底。本文从架构决策角度，讲清楚 Flutter 热更新的技术瓶颈、可行替代方案，以及完整的发版策略设计。

---

## 核心内容

### 1. Flutter 为什么不能像 React Native 那样热更新

#### 1.1 编译模式对比

| 维度 | React Native | Flutter |
|------|-------------|---------|
| 运行方式 | JavaScript Bundle 解释执行 | AOT 编译为机器码 |
| 更新方式 | 替换 JS Bundle 文件 | 需要重新编译整个应用 |
| 动态性 | 高（JS 天然支持 eval） | 低（机器码无法动态替换） |
| 性能 | 受 JS Bridge 瓶颈限制 | 原生性能 |
| 安全性 | JS Bundle 可被反编译阅读 | AOT 机器码难以逆向 |

**核心原因：** Flutter Release 模式使用 AOT（Ahead-of-Time）编译，Dart 代码被编译为原生机器码（`libapp.so`），不是可以动态解释执行的中间代码。要修改机器码，只能重新编译。

#### 1.2 技术上是否可能

理论上，有几种绕过方案，但都有致命缺陷：

| 方案 | 原理 | 致命缺陷 |
|------|------|---------|
| JIT 模式 | Release 模式也用 JIT 解释执行 | 性能严重下降（2-5x），且 iOS 禁止 JIT |
| 下发 Dart Kernel | 编译为 Kernel Snapshot 动态加载 | iOS 不允许动态加载可执行代码（2.5.2 条款） |
| WebView 壳 | 业务逻辑放在 WebView 中 | 不是真正的 Flutter，性能和体验退化为 H5 |
| 动态布局引擎 | 通过 JSON/DSL 驱动 UI 渲染 | 只能改 UI，无法改逻辑，开发成本高 |

**结论：在 iOS 平台上，任何形式的动态代码下发都违反 App Store 审核条款 2.5.2，技术上可行也不合规。Android 理论上可以做，但 Flutter 官方不支持。**

#### 1.3 Flutter 团队的官方立场

Flutter 团队多次明确表态：**不会支持 AOT 模式的热更新**。原因：
1. 安全性：动态加载代码打破了操作系统的代码签名安全模型
2. 性能：AOT 编译的性能优势来自编译期优化，动态加载无法实现
3. 可维护性：动态更新会导致版本碎片化，测试和调试成本指数增长

---

### 2. 代码推送的可行方案：Shorebird

#### 2.1 Shorebird 是什么

Shorebird 是目前唯一成熟的 Flutter 代码推送方案。它的核心思路是：**不替换整个机器码，而是生成补丁（patch），在应用启动时将补丁应用到已有的 AOT 代码上。**

```
正常构建：
Dart 源码 → AOT 编译 → libapp.so

Shorebird 构建：
Dart 源码 → Shorebird 编译器 → libapp.so + 基线版本信息
                                    ↓
修改代码后 → Shorebird 生成 patch → 补丁文件（差量）
                                    ↓
客户端启动 → Shorebird 引擎检查更新 → 下载并应用 patch
```

#### 2.2 Shorebird 的工作原理

Shorebird 修改了 Dart 编译器，在编译时生成额外的元数据，使得修改代码后可以计算出增量补丁：

1. **首次构建**：生成 `libapp.so` + 元数据（基线快照）
2. **代码修改后**：对比新旧元数据，生成差量补丁
3. **客户端启动时**：Shorebird 引擎检查是否有新补丁 → 下载 → 应用到内存中的代码

**技术限制：**
- 补丁大小通常在 KB 级别（因为是差量）
- 不能修改 Native 层代码（Java/Kotlin/Swift/ObjC）
- 不能修改 `pubspec.yaml`（不能新增依赖）
- 补丁数量有限制（Shorebird 免费版限制补丁数量）

#### 2.3 Shorebird 集成实践

```bash
# 1. 安装 Shorebird CLI
dart pub global activate shorebird_cli

# 2. 登录
shorebird login

# 3. 初始化项目
shorebird init

# 4. 首次发布
shorebird release android

# 5. 修复 Bug 后发布补丁
shorebird patch android
```

**Flutter 侧无需修改任何代码**——Shorebird 在编译期注入，对业务代码透明。

```bash
# 查看补丁状态
shorebird patch list

# 查看某个发布的状态
shorebird release list
```

#### 2.4 Shorebird 的合规性

**Android：** ✅ 合规。Shorebird 不下载可执行代码，而是下载差量补丁并应用到已签名代码上。技术上不等同于"动态加载代码"。

**iOS：** ❌ 不支持。苹果审核条款 2.5.2 禁止任何形式的代码推送。Shorebird 官方也明确不支持 iOS。

**国内市场：**  有风险。华为等部分市场明确禁止热更新，检测到可能下架。使用 Shorebird 前需要评估目标市场的政策。

#### 2.5 Shorebird 的适用场景

| 场景 | 适合 | 不适合 |
|------|------|--------|
| 紧急 Bug 修复 | ✅ 快速推送补丁 | |
| UI 文案修改 | ✅ 小改动 | |
| 新增功能 | | ❌ 改动太大，走正式发版 |
| 修改 Native 代码 | | ❌ Shorebird 只能改 Dart 层 |
| 新增依赖 | | ❌ 不能改 pubspec.yaml |
| iOS 修复 | | ❌ iOS 不支持 |

---

### 3. 发版策略：全量 vs 灰度

#### 3.1 为什么需要灰度

全量发布的问题：一旦新版本有严重 Bug，100% 的用户都会受影响。灰度发布（Staged Rollout）允许你逐步扩大新版本的覆盖范围，在问题影响大量用户之前发现并止损。

**不发版策略的后果：** 某次更新引入了一个崩溃 Bug，影响 20% 用户。如果你有 100 万用户，就是 20 万人崩溃——灾难性的用户流失。

#### 3.2 灰度发布方案

**Google Play 灰度发布 [Android]：**

Google Play Console 内置灰度发布功能：

```
创建发布 → 选择灰度比例（1% → 5% → 10% → 25% → 50% → 100%）
         → 每个阶段观察 24-48 小时
         → 崩溃率正常 → 提升比例
         → 崩溃率异常 → 暂停发布
```

**国内市场灰度发布 [Android]：**

部分国内市场支持灰度（如华为的"分阶段发布"），但大多数不支持。替代方案：

```dart
/// 客户端灰度控制——通过服务端配置决定是否展示新功能
class FeatureFlagService {
  static Future<bool> isEnabled(String featureKey) async {
    final response = await http.get(
      Uri.parse('$baseUrl/feature-flags/$featureKey'),
      headers: await _getAuthHeaders(),
    );
    final data = jsonDecode(response.body);
    return data['enabled'] as bool;
  }
}

/// 版本灰度——服务端根据用户 ID 决定是否推送新版本
class VersionService {
  /// 检查是否需要更新
  static Future<UpdateInfo?> checkUpdate() async {
    final response = await http.get(
      Uri.parse('$baseUrl/app/update-check'),
      headers: {
        'X-App-Version': await _getCurrentVersion(),
        'X-User-ID': await _getUserId(),
        'X-Device-ID': await _getDeviceId(),
      },
    );

    if (response.statusCode == 204) return null; // 无需更新

    final data = jsonDecode(response.body);
    return UpdateInfo(
      version: data['version'] as String,
      downloadUrl: data['downloadUrl'] as String,
      isForceUpdate: data['forceUpdate'] as bool,
      description: data['description'] as String,
    );
  }
}
```

#### 3.3 灰度发布的监控指标

灰度期间必须监控的指标：

| 指标 | 阈值 | 数据源 |
|------|------|--------|
| 崩溃率 | > 基线 0.5% 则暂停 | Bugly / Firebase Crashlytics |
| ANR 率 | > 基线 0.3% 则暂停 | Bugly / Google Play Console |
| 启动时间 | > 基线 20% 则暂停 | 自定义埋点 |
| 核心功能转化率 | 下降 > 5% 则调查 | 自定义埋点 |
| 用户反馈 | 差评率飙升则暂停 | 各市场评价 |

---

### 4. 版本号管理与升级提醒

#### 4.1 语义化版本号

Flutter 项目的版本号在 `pubspec.yaml` 中定义：

```yaml
# 格式：major.minor.patch+buildNumber
version: 2.5.3+47
#          ↑       ↑
#     语义版本   构建号（每次发版递增）
```

**版本号策略：**

| 变更类型 | 版本号变化 | 示例 |
|---------|-----------|------|
| Bug 修复 | patch +1 | 2.5.3 → 2.5.4 |
| 新功能（向下兼容） | minor +1 | 2.5.3 → 2.6.0 |
| 破坏性变更 | major +1 | 2.5.3 → 3.0.0 |

**构建号（buildNumber）：**
- 每次上传到应用市场必须递增
- Google Play 和 App Store 用构建号区分同版本号的不同构建
- 建议用 CI 自动递增（如 Git commit count）

```bash
# CI 中自动设置构建号
flutter build apk --build-number=$CI_BUILD_NUMBER
flutter build ipa --build-number=$CI_BUILD_NUMBER
```

#### 4.2 升级提醒实现 [双端]

```dart
class UpdateChecker {
  /// 检查更新
  static Future<UpdateInfo?> check() async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/app/version'),
      headers: {'X-Platform': Platform.isIOS ? 'ios' : 'android'},
    );

    final data = jsonDecode(response.body);
    final latestVersion = data['version'] as String;
    final currentVersion = await _getCurrentVersion();

    if (!_shouldUpdate(currentVersion, latestVersion)) return null;

    return UpdateInfo(
      version: latestVersion,
      downloadUrl: data['downloadUrl'] as String?,
      isForceUpdate: data['forceUpdate'] as bool,
      minSupportedVersion: data['minSupportedVersion'] as String?,
      description: data['description'] as String,
    );
  }

  /// 版本比较
  static bool _shouldUpdate(String current, String latest) {
    final currentParts = current.split('.').map(int.parse).toList();
    final latestParts = latest.split('.').map(int.parse).toList();

    for (var i = 0; i < 3; i++) {
      if (latestParts[i] > currentParts[i]) return true;
      if (latestParts[i] < currentParts[i]) return false;
    }
    return false;
  }
}
```

---

### 5. 强制更新与可选更新策略

#### 5.1 什么时候用强制更新

强制更新意味着用户不更新就无法使用应用——这是一个"核武器"，必须谨慎使用。

**适合强制更新的场景：**
- 严重安全漏洞修复
- 服务端 API 不再兼容旧版本
- 数据库结构变更，旧版本无法正常工作
- 合规要求（如隐私政策重大变更）

**不适合强制更新的场景：**
- 一般性 Bug 修复（用户可能在弱网环境）
- UI 优化
- 新功能上线

#### 5.2 强制更新策略实现

```dart
class UpdateStrategy {
  /// 决定更新策略
  static UpdateType determineType(UpdateInfo info) {
    final currentVersion = PackageInfo.fromPlatform();
    // 简化逻辑：实际需要异步处理
    final current = '2.5.0'; // 示例
    final minSupported = info.minSupportedVersion ?? '0.0.0';

    // 当前版本低于最低支持版本 → 强制更新
    if (_compareVersions(current, minSupported) < 0) {
      return UpdateType.force;
    }

    // 有新版本但不低于最低支持版本 → 可选更新
    return UpdateType.optional;
  }

  static int _compareVersions(String a, String b) {
    final aParts = a.split('.').map(int.parse).toList();
    final bParts = b.split('.').map(int.parse).toList();
    for (var i = 0; i < 3; i++) {
      if (aParts[i] != bParts[i]) return aParts[i].compareTo(bParts[i]);
    }
    return 0;
  }
}

enum UpdateType { force, optional }
```

**强制更新的 UI 实现：**

```dart
class ForceUpdateDialog extends StatelessWidget {
  final UpdateInfo updateInfo;

  const ForceUpdateDialog({required this.updateInfo});

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false, // 禁止返回键关闭
      child: AlertDialog(
        title: const Text('需要更新'),
        content: Text(updateInfo.description),
        actions: [
          ElevatedButton(
            onPressed: () => _openStore(context),
            child: const Text('立即更新'),
          ),
        ],
      ),
    );
  }

  void _openStore(BuildContext context) {
    if (Platform.isAndroid) {
      // 跳转应用市场
      launchUrl(Uri.parse('market://details?id=com.example.app'));
    } else {
      // 跳转 App Store
      launchUrl(Uri.parse('https://apps.apple.com/app/idXXXXXXXXX'));
    }
  }
}
```

#### 5.3 可选更新的频率控制

可选更新弹窗不能每次启动都弹——用户会烦。

```dart
class UpdateReminder {
  static const _keyLastRemind = 'update_remind_last';
  static const _keyRemindCount = 'update_remind_count';
  static const _keySkippedVersion = 'update_skipped_version';

  /// 是否应该展示更新提醒
  static Future<bool> shouldShowReminder(UpdateInfo info) async {
    final prefs = await SharedPreferences.getInstance();

    // 用户已跳过此版本 → 不再提醒
    final skippedVersion = prefs.getString(_keySkippedVersion);
    if (skippedVersion == info.version) return false;

    // 提醒次数控制：最多 3 次
    final remindCount = prefs.getInt(_keyRemindCount) ?? 0;
    if (remindCount >= 3) return false;

    // 间隔控制：至少间隔 3 天
    final lastRemind = prefs.getString(_keyLastRemind);
    if (lastRemind != null) {
      final lastDate = DateTime.parse(lastRemind);
      final daysSince = DateTime.now().difference(lastDate).inDays;
      if (daysSince < 3) return false;
    }

    return true;
  }

  /// 记录提醒
  static Future<void> recordReminder(String version) async {
    final prefs = await SharedPreferences.getInstance();
    final count = prefs.getInt(_keyRemindCount) ?? 0;
    await prefs.setInt(_keyRemindCount, count + 1);
    await prefs.setString(_keyLastRemind, DateTime.now().toIso8601String());
  }

  /// 用户跳过
  static Future<void> skipVersion(String version) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keySkippedVersion, version);
  }
}
```

---

### 6. 紧急回滚方案

#### 6.1 为什么需要回滚

灰度发布能降低风险，但不能消除风险。某些 Bug 只在特定设备/网络条件下出现，灰度期间可能没暴露。发布后大面积爆发时，回滚是最快的止血手段。

**没有回滚方案的后果：** 发现严重 Bug 后只能紧急修复 → 提审 → 等待审核 → 上架，最快 1-2 天（Android）或 1-7 天（iOS）。期间所有用户持续受影响。

#### 6.2 Android 回滚方案 [Android]

**Google Play：** 支持"回滚"到之前任意版本——在 Google Play Console 中选择"管理生产版本" → "回滚"。

**国内市场：** 大多数不支持回滚到旧版本。替代方案：

1. **服务端降级**：关键功能的服务端 API 保持向下兼容，客户端检测到新版异常时自动回退到旧版 API 逻辑
2. **功能开关**：新功能通过 Feature Flag 控制，出问题时服务端关闭开关即可

```dart
class FeatureFlagService {
  static final _cache = <String, bool>{};

  /// 获取功能开关状态
  static Future<bool> isEnabled(String featureKey) async {
    if (_cache.containsKey(featureKey)) return _cache[featureKey]!;

    try {
      final response = await http.get(
        Uri.parse('$baseUrl/feature-flags/$featureKey'),
      ).timeout(const Duration(seconds: 3));
      final enabled = jsonDecode(response.body)['enabled'] as bool;
      _cache[featureKey] = enabled;
      return enabled;
    } catch (_) {
      // 网络异常时默认关闭新功能
      return false;
    }
  }
}
```

3. **紧急发布修复版**：修复 Bug 后以最高优先级提审，走各市场的加急审核通道

#### 6.3 iOS 回滚方案 [iOS]

iOS 没有"回滚"概念——App Store 不允许降级。但有以下替代方案：

1. ** Expedited Review**：申请加急审核（每年约 2 次额度），通常 24 小时内通过
2. **功能开关**：新功能通过远程配置开关控制，出问题时服务端关闭
3. **服务端兼容**：旧版客户端必须能正常工作——API 永远向下兼容

**架构原则：iOS 上不存在真正的回滚，所以每一个发版决策都必须更谨慎。**

#### 6.4 回滚决策流程

```
发现严重 Bug
  ↓
评估影响范围（崩溃率/用户反馈/业务损失）
  ↓
┌─ 影响可控 → 功能开关关闭问题功能 → 修复 → 常规发版
│
├─ 影响较大 → Android 回滚 + 功能开关 + 紧急修复版
│
└─ 影响严重 → Android 回滚 + iOS 加急审核 + 全平台功能开关 + 紧急修复版
```

---

## 常见坑与踩点

### 1. Shorebird 补丁导致崩溃

**场景：** 发布 Shorebird 补丁后，部分低版本 Android 设备崩溃。
**根因：** 补丁是基于特定基线版本生成的，如果客户端基线版本与补丁不匹配，会崩溃。
**解决：** 确保所有用户都已更新到补丁对应的基线版本后再发补丁。Shorebird 会自动处理版本匹配，但如果绕过 Shorebird 直接修改 APK 会导致不匹配。

### 2. 灰度期间版本碎片化

**场景：** 灰度发布时，1.x 和 2.x 版本同时在线，服务端 API 需要兼容两个大版本。
**解决：** API 设计必须向下兼容——新字段 optional、旧字段不删除、客户端忽略未知字段。大版本升级时设置 `minSupportedVersion`，强制低版本用户升级。

### 3. 强制更新弹窗被系统杀死

**场景：** Android 后台弹出强制更新弹窗，在某些国产 ROM 上被系统当做"弹窗广告"杀掉。
**解决：** 强制更新弹窗必须在应用前台时展示，不要从后台弹出。检测到需要强制更新时，在首页（MainActivity）的 `onResume` 中展示。

### 4. 版本号比较逻辑错误

**场景：** 字符串比较 `2.10.0` < `2.9.0`（因为 `"10" < "9"` 字典序比较）。
**解决：** 永远用数值比较，不要用字符串比较：

```dart
// ❌ 错误
'2.10.0'.compareTo('2.9.0') // 返回 -1（错误地认为 2.10 < 2.9）

// ✅ 正确
_compareVersions('2.10.0', '2.9.0') // 返回 1（正确）
```

### 5. 构建号不一致导致上架失败

**场景：** iOS 和 Android 使用不同构建号，导致版本管理混乱。
**解决：** 统一由 CI 注入构建号，从单一数据源生成（如 Git tag 或 CI 自增序列）。

---

## 面试追问

###  Flutter 热更新为什么难？

**要点：** AOT 编译为机器码 → 无法像 JS 那样替换 Bundle；iOS 平台禁止动态加载代码 → App Store 条款 2.5.2；Flutter 官方明确不支持 → 架构决策层面就不应该依赖热更新。

###  你用什么替代热更新的方案？

**要点：** Shorebird（Android 代码推送）、灰度发布（控制影响范围）、功能开关（远程关闭问题功能）、服务端兼容（旧版客户端可持续工作）。强调"替代方案"不是单一方案，而是组合拳。

###  灰度发布你怎么做的？

**要点：** Google Play 内置灰度 → 国内市场通过服务端 Feature Flag 实现 → 每个灰度阶段监控崩溃率、ANR 率、核心转化率 → 异常则暂停/回滚，正常则推进。重点讲监控指标和决策标准。

###  强制更新你怎么控制的？

**要点：** 服务端下发 `minSupportedVersion` → 客户端比较当前版本 → 低于最低版本则弹出不可关闭的更新弹窗。强调强制更新的适用场景（安全漏洞、API 不兼容）和不适用场景（一般 Bug），以及频率控制策略。

###  设计一套完整的发版与应急体系，你会怎么做？

**要点：** 四层体系——L1 预防（灰度发布 + 功能开关 + 自动化测试）→ L2 监控（崩溃率/ANR 率/核心指标告警）→ L3 止血（Android 回滚 + 功能开关远程关闭 + Shorebird 紧急补丁）→ L4 修复（紧急发版 + iOS 加急审核）。重点讲各层的触发条件和执行时效。

---

## 参考资源

- [Shorebird 官方文档](https://docs.shorebird.dev/)
- [Flutter 发布流程](https://docs.flutter.dev/deployment/android)
- [Google Play 灰度发布](https://support.google.com/googleplay/android-developer/answer/6346149)
- [App Store 加急审核](https://developer.apple.com/contact/app-store/?topic=expedite)
- [语义化版本规范](https://semver.org/)
