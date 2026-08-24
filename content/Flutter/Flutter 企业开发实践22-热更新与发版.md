---
title: Flutter 企业开发实践22-热更新与发版
date: 2026-08-24
tags:
  - Flutter
  - 热更新
  - Shorebird
  - flutter_patcher
  - 自托管
  - 发版策略
  - 灰度发布
---

# 热更新与发版——从"能不能"到"自托管怎么落地"

> 热更新是 Flutter 工程化里被问得最多、也最容易答错的主题。
> 本篇回答三个问题：Flutter 为什么做不了 RN 式热更新？2026 年真实的方案格局是什么？如果要自托管，从打补丁到服务端灰度再到崩溃回滚，整套体系怎么落地？
> 自托管部分以开源库 flutter_patcher（0.1.4，MIT 协议）为样本做源码级剖析——它的每一层设计（加载注入、原子安装、签名校验、熔断回滚）都是"企业级热更新"的通用考题。

**版本说明**：flutter_patcher 部分基于 0.1.4 源码（2026-08，GitHub `xuelinger2333/flutter_patcher`）；Shorebird 现状截至 2026-08，商业条款以官网为准。本文代码均基于真实 API 编写，未在真机跑通的流程会明确标注。

---

## 概述

先给出结论，再逐层展开：

1. **iOS 上不存在合规的热更新**。App Store 审核条款 2.5.2 禁止下载并执行可动态改变行为的代码，这条路在政策层面就封死了。
2. **Android 上技术可行，且只有一条主路径**：Release 模式下 Dart 代码 AOT 编译为 `libapp.so`，热更新等价于"下次冷启动时让引擎加载一份新的 `libapp.so`"。Shorebird（云端托管，引擎级差量）和 flutter_patcher（自托管，整包替换）走的是同一条路径的两种工程化。
3. **热更新只是应急手段，不是发版策略的替代品**。灰度发布控制影响范围、功能开关远程止血、强制更新兜底、加急审核救火——这套"发版组合拳"比热更新本身更常被面试考察。

---

## 核心内容

### 1. Flutter 为什么做不了 RN 式热更新

#### 1.1 编译模式对比

| 维度 | React Native | Flutter（Release） |
|------|-------------|---------|
| 运行方式 | JavaScript 引擎执行 JS Bundle（0.76+ 默认新架构，JSI 直连） | Dart AOT 编译为原生机器码 |
| 更新单元 | 替换 JS Bundle 文件 | 替换整个 AOT 产物（`libapp.so`） |
| 典型补丁体积 | Bundle 差量（业务复杂度决定） | Shorebird 差量通常 KB 级；自托管为整包替换，MB 级 |
| 安全性 | Bundle 可被反编译阅读 | AOT 机器码难以逆向 |

**核心原因**：Flutter Release 模式使用 AOT（Ahead-of-Time）编译，Dart 代码与它依赖的 Dart 运行时快照一起被编译进 `libapp.so`。它不是可以动态解释执行的中间代码——要改动它，要么重新编译整个产物，要么在引擎加载它之前把文件换掉。

#### 1.2 理论上的绕过方案与缺陷

| 方案 | 原理 | 致命缺陷 |
|------|------|---------|
| JIT 模式 | Release 也用 JIT 执行 | iOS 系统层面禁止自修改可执行内存；Android 上失去 AOT 的启动与峰值性能优势 |
| 下发 Dart Kernel | 编译为 Kernel Snapshot 动态加载 | iOS 违反 2.5.2；Android 上引擎不支持运行时切换入口 |
| WebView 壳 | 业务逻辑放 H5 | 不是 Flutter，体验退化 |
| 动态布局引擎 | JSON/DSL 驱动 UI | 只能改外观不能改逻辑，双端一致性维护成本高 |
| **替换 libapp.so** | 冷启动前换掉 AOT 产物 | **Android 上可行——这就是下文全部内容的起点** |

#### 1.3 Flutter 官方的立场

Flutter 团队多次明确表示不官方支持 AOT 热更新，理由有三：

1. **安全模型**：动态加载代码绕过了操作系统的代码签名体系；
2. **测试成本**：线上版本碎片化，"哪个基线 + 哪个补丁"的组合数随发布次数增长，质量保障难度指数上升；
3. **责任边界**：官方如果提供该能力，就要为所有渠道的合规后果背书。

所以现实里的选择是：**iOS 接受发版节奏，Android 在合规允许的渠道里用第三方方案**。

---

### 2. 2026 年的方案格局

#### 2.1 Shorebird：云端托管的代码推送

Shorebird 是目前最成熟的 Flutter 代码推送商业方案，**支持 Android、iOS、Mac、Windows、 Linux 五端的 Dart 代码补丁**（`shorebird release ios` / `shorebird patch ios`，注意 iOS 补丁只支持真机、不支持模拟器）。它在自己的构建工具链里改造 Dart 编译器，记录基线版本的元数据，代码修改后可以产出引擎级差量补丁，客户端下次重启时生效。

基本工作流：

```bash
dart pub global activate shorebird_cli
shorebird login
shorebird init          # 在项目里生成 shorebird.yaml

shorebird release android --artifact apk   # 发布基线版本
# ……修 bug 后……
shorebird patch android                    # 产出差量补丁
shorebird patches list --release-version 1.0.0+1   # 查看某基线下的补丁
```

关键事实（避免面试翻车）：

- **补丁在下次冷启动生效**，不是当前进程内热替换；
- 免费档限制的是**每月补丁安装量**，不是"补丁条数"（具体额度以官网定价页为准）；
- iOS 合规性存在解释空间：Shorebird 官方立场是其补丁机制符合 App Store 条款，但是否采用需要各团队自行做合规评估，部分国内渠道明确禁止；
- 不能改 Native 代码、不能改 `pubspec.yaml` 依赖。

#### 2.2 自托管：flutter_patcher

当你不能把代码交给第三方云（企业内网分发、私有渠道、数据合规要求），就需要自托管方案。开源库 [flutter_patcher](https://pub.dev/packages/flutter_patcher)（MIT）把"替换 libapp.so"这条路完整工程化了：

| 能力 | 说明 |
|------|------|
| 更新范围 | Dart 代码 + 在 `pubspec.yaml` 注册的 Flutter 资产 |
| 生效时机 | 下次冷启动 |
| 完整性 | MD5 + 可选 Ed25519 签名（Android 13+ 原生验签） |
| 崩溃保护 | 启动失败自动回滚 + 坏补丁黑名单 |
| 托管 | 任意 HTTP 服务：自己的 CDN / 对象存储 / nginx 静态目录 |
| 平台 | 仅 Android；iOS/macOS/桌面/Web 上所有 API 为安全空操作 |
| 版本约束 | Flutter ≥3.3（loader 注入在 3.19~3.44 验证过）、minSdk 24、AGP 8.11+、Kotlin 2.2.20+、JDK 17 |

#### 2.3 对比与选型

|                | Shorebird                | flutter_patcher（自托管）     | 纯发版            |
|----------------|--------------------------|------------------------------|-------------------|
| 平台           | Android/iOS/Mac/Win/Linux | 仅 Android                   | 双端              |
| 补丁形态       | 引擎级差量（KB 级）      | 整包 libapp.so（MB 级）+ 资产 | —                 |
| 依赖的云       | Shorebird 云（必须）      | 自己的服务器（必须自建）      | 无                |
| 回滚/熔断      | 云端控制                 | 端侧自动 + 服务端停发         | 渠道灰度          |
| 适用           | 快速迭代产品、双端诉求    | 企业内部分发、私有渠道、强合规 | 渠道政策严格的产品 |

**选型建议**：需要 iOS 或不想自建基础设施 → Shorebird；Android 私有渠道且要求代码不出自己的服务器 → 自托管；上架 Google Play 的应用**不要用任何运行时下发可执行代码的方案**（见 2.4）。

#### 2.4 合规边界

- **Google Play**：政策禁止应用在运行时下载可执行代码。自托管热更新只适用于自控分发渠道：企业内部分发、官网直发、国内不设此限制的应用商店（以各渠道当前政策为准）。
- **国内渠道**：华为等部分市场对热更新有明确限制，接入前逐渠道确认。
- **iOS**：2.5.2 条款，不要碰。

---

### 3. 自托管原理：冷启动替换 libapp.so（源码剖析）

这一节以 flutter_patcher 0.1.4 的源码为样本，把整条链路拆开。理解了这节，"自研热更新方案设计"这类面试题就有了完整答案。

#### 3.1 三种角色

```text
开发机                     服务端                      用户设备
────────                 ──────────                 ──────────
改 Dart 代码               存储与分发                  检查更新
  │                          │                          │
flutter build apk          上传 patch.zip              applyPatch() 下载+校验+落盘
  │                          │                          │
pack CLI 抽取产物   ───→   CDN / 对象存储   ─────────→  下次冷启动加载
                                                        │
                                                 启动成功 → 继续用
                                                 启动失败 → 自动回滚
```

#### 3.2 注入时机：为什么是 ContentProvider

替换 `libapp.so` 的前提是**抢在 Flutter 引擎初始化之前**完成两件事：校验磁盘上的补丁、把加载路径"掉包"。Android 的进程启动顺序是固定的：

```text
Application.attachBaseContext()
  ↓
installContentProviders()   ← flutter_patcher 的 AutoInitProvider 在这里执行
  ↓
Application.onCreate()
  ↓
Activity 创建 → 首次初始化 FlutterEngine → FlutterInjector 开始被使用
```

插件用了一个不暴露任何数据的 `ContentProvider`（`FlutterPatcherAutoInitProvider`），借 `installContentProviders()` 这个比 `Application.onCreate` 更早、又必然早于 Activity 的时机执行补丁加载——这与 Firebase、WorkManager 的自动初始化是同一个模式。宿主**不需要改自己的 Application 类**。

唯一的例外：宿主在 `attachBaseContext` 里**预热 FlutterEngine** 的大厂混合工程，引擎创建早于 provider，注入来不及。这类项目要在 Manifest 里移除自动初始化，改为手动调用：

```xml
<provider
    android:name="com.flutter_patcher.flutter_patcher.FlutterPatcherAutoInitProvider"
    android:authorities="${applicationId}.flutter_patcher.autoinit"
    tools:node="remove" />
```

```kotlin
class MyApp : FlutterApplication() {
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        FlutterPatcherApplication.attachPatcher(base) // 手动挂载
    }
}
```

#### 3.3 LoaderHook：反射替换 FlutterLoader

这是整个方案最核心也最"黑"的一步。Flutter 的 Android embedding 通过单例 `FlutterInjector` 持有一个 `FlutterLoader`，引擎初始化时用它定位 AOT 产物。flutter_patcher 的做法（`LoaderHook.kt`）：

1. 反射拿到 `FlutterInjector` 实例的 `flutterLoader` 字段；
2. 用自定义的 `PatchedFlutterLoader` 替换它——子类只重写一个关键方法：

```kotlin
// PatchedFlutterLoader（节选，源码 android/.../LoaderHook.kt）
override fun ensureInitializationComplete(context: Context, args: Array<String>?) {
    val patched = (args ?: emptyArray()).toMutableList()
    patched.add("--aot-shared-library-name=$patchSoPath")   // 指向补丁 so 的绝对路径
    if (!patchAssetsPath.isNullOrEmpty()) {
        patched.add("--flutter-assets-dir=$patchAssetsPath")
    }
    super.ensureInitializationComplete(context, patched.toTypedArray())
}
```

引擎参数 `--aot-shared-library-name` 从 Flutter 1.x 起就稳定存在，接受任意文件路径——**这就是"替换 libapp.so"的全部秘密：引擎本来就支持从指定路径加载 AOT 产物，只是默认没人告诉它**。

因为反射依赖 Flutter 内部字段名，插件做了三层防御：

| 层级 | 策略 | 风险 |
|------|------|------|
| 1 | 候选字段名精确匹配（默认 `flutterLoader`，可通过 `init(loaderFieldCandidates: [...])` 下发新名字） | 无 |
| 2 | 按字段类型匹配（`FlutterLoader` 或其子类） | 无 |
| 3 | 启发式（首个非 static 非 ExecutorService 字段） | 可能命错字段，**默认关闭** |

第 3 层默认关闭的设计值得注意：**宁可退回内置 so，也不要注入到错误字段上导致不可预测的崩溃**——fail-safe 优先于成功率，这是所有热更新方案应有的默认姿态。

#### 3.4 资产热更新：AssetManifest 合并与私有资产包

替换 `libapp.so` 只解决 Dart 代码，图片、JSON 等资产走的是另一条链路（0.1.3+ 支持）。安装补丁时在本地合成一份完整的资产包：

1. 把基线 APK 里的 `assets/flutter_assets/*` 全量拷到 staging 目录；
2. 用补丁里携带的新资产覆盖对应路径；
3. **合并资产索引**：`AssetManifest.bin` 是 Flutter 用 `StandardMessageCodec` 编码的"资产键 → 变体列表"表，插件解码后对每个被补丁的资产执行 `upsert`（替换或插入变体列表），再重新编码写回；
4. 校验每个资产文件的 MD5；
5. 把整棵树重新打包成一个私有的 `flutter_assets.apk`。

冷启动加载时，`LoaderHook` 除了替换 loader，还会反射替换 `FlutterInjector.flutterJniFactory`，让自定义 `FlutterJNI` 在执行 `runBundleAndSnapshotFromLibrary` 前调用 `AssetManager.addAssetPath` 把这份私有资产包挂进系统的 AssetManager——**`Image.asset()`、`rootBundle.load()` 无需任何业务代码改动就能读到新资产**，未被打补丁的路径仍回落到 APK 内置资产。

这就是为什么"能补资产"比"能补代码"更麻烦：代码只有一个 `libapp.so`，资产要处理索引表合并与双来源回落。

#### 3.5 安装事务：原子提交与断电恢复

补丁安装（`applyPatch`）最怕装一半断电/被杀，下次启动加载半个补丁。flutter_patcher 用"staging → pending → current"三级目录加安装标记实现事务：

```text
staging/   ← 下载校验后在这里解包 so、合成资产包（随便中断，无害）
   ↓ 逐个 rename
pending/   ← finalizePatch 内部的短暂中间态；先写 install marker
   ↓ rename（真正的事务提交点）
current/   ← 下次冷启动实际加载的内容；旧版本挪到 previous/ 后删除
```

所有写文件都带 `fd.sync()` 落盘。如果冷启动时发现 `installing` 标记还在（上次没提交完），`recoverInterruptedInstall` 会按"有 previous 就回滚到 previous、没有就丢弃半成品"的规则收拾现场。

**注意**：这个磁盘事务只保证"装好或没装"，不保证"装好的补丁能启动"——后者是崩溃保护的职责，两者是独立机制。

#### 3.6 校验链：四道关卡

安装与冷启动两个阶段都执行校验，顺序固定：

```text
payload MD5（外层 zip 或裸 so）
  → Ed25519 签名（对 md5 hex 字符串签名）
  → versionCode 匹配（补丁绑定宿主 APK 的 versionCode）
  → patch.zip 内部逐文件 MD5（libapp.so + 每个资产）
```

两个容易忽略的安全语义（面试加分点）：

1. **`md5` 缺省 = 签名同时失效**。签名的消息体就是 md5 hex 字符串，没有 md5 就没有可签名的对象——依赖 HTTPS 传输完整性时两种校验一起跳过。原生侧下载后仍会计算实际 md5 写入元数据，供启动期校验和黑名单使用。
2. **strictSignature 防降级攻击**。Android 13（API 33）以下没有 JDK 原生 Ed25519。默认策略（`strictSignature: true`）是：低版本设备收到**带签名的补丁直接拒绝加载**，而不是"跳过验签放行"——否则攻击者可以专门用低版本设备绕过签名校验。显式接受降级才允许关掉。

另外所有 ZIP 内路径都过一遍 `isSafeZipPath`（拒绝绝对路径、`\` 开头、`..` 穿越与空字节），防经典的 Zip Slip 攻击。

#### 3.7 崩溃保护：熔断、黑名单、观察窗口

补丁导致启动崩溃是热更新最怕的事故形态：崩溃 → 下次启动又加载同一个坏补丁 → 无限循环。flutter_patcher 的防线分四层：

**第一层：精确判定"上次是不是崩了"。** Android 11+ 用 `ActivityManager.getHistoricalProcessExitReasons`（按上次记录的 pid 查询）拿到上一次进程退出的官方原因，只有 `CRASH / CRASH_NATIVE / ANR / INITIALIZATION_FAILURE` 四类计入熔断计数；用户划掉、系统 OOM、强停都不算。Android 10 及以下退化为 `patch_loading` 标志位兜底：首帧前死亡算崩溃，首帧后不算。

**第二层：首帧即清零。** Dart 侧 `init()` 后首个渲染帧回调触发 `reportBootSuccess`，立即清掉熔断计数——正常启动的用户不会带着"启动中"状态到处跑。

**第三层：verifyAfter 观察窗口。** 首帧之后默认再观察 5 秒（仅前台计时）。窗口内 `init()` 安装的 `PlatformDispatcher.onError` / `FlutterError.onError` 钩子捕获到的未处理异常，会被上报原生侧**视同一次真崩溃**计数——这覆盖了"进程没死但首屏白屏/不可用"的坏补丁形态。窗口关闭后钩子透明转发给原有处理器，业务异常不再影响熔断。

**第四层：黑名单。** 熔断触发时，坏补丁以 `(version, md5)` 复合键进本地黑名单：服务端再下发同一个坏补丁时**下载前直接拒绝**；开发者用同 version 修复后重发（md5 变了）允许重试；黑名单跨 APK 升级持久保留（防服务端忘下架），FIFO 上限 50 条。手动 `rollback()` 不进黑名单。

默认 `maxCrashCount = 1`：fail-fast，失败一次就熔断。生产环境不建议调高——确认有问题的补丁，重试只是放大事故。

---

### 4. 客户端接入实战

以下代码基于 flutter_patcher 0.1.4 的公开 API（`lib/flutter_patcher.dart`）。

#### 4.1 依赖与初始化

```yaml
# pubspec.yaml
dependencies:
  flutter_patcher: ^0.1.4
```

```dart
import 'package:flutter/material.dart';
import 'package:flutter_patcher/flutter_patcher.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await FlutterPatcher.init(
    // Ed25519 公钥（X.509 SubjectPublicKeyInfo 的 Base64），空串关闭签名校验
    publicKeyBase64: const String.fromEnvironment('PATCH_PUBLIC_KEY'),
    maxCrashCount: 1,                        // fail-fast
    verifyAfter: const Duration(seconds: 5), // 首帧后的观察窗口
  );
  runApp(const MyApp());
}
```

`init()` 做三件事：把配置持久化到原生侧（供下次冷启动的自动加载流程读取）、安装 Dart 错误钩子、注册首帧成功回调。方法幂等，可安全重复调用。

#### 4.2 生成签名密钥（服务端保管私钥）

```bash
# 私钥：只放服务端/构建机
openssl genpkey -algorithm ed25519 -out patch_sk.pem

# 公钥：Base64 后嵌入客户端（建议经 --dart-define 注入而非硬编码）
openssl pkey -in patch_sk.pem -pubout -outform DER | base64 -w0

# 对补丁 md5 签名（发布流水线里执行）
printf "%s" "<补丁md5小写hex>" | openssl pkeyutl -sign -inkey patch_sk.pem -rawin | base64 -w0
```

#### 4.3 生产一个补丁

```bash
# 1. 修复 bug 后重新构建 release
flutter build apk --release

# 2. 从新 APK 抽取产物，打包为 patch.zip
#    --target-version-code 是"用户设备上已安装基线 APK"的 versionCode
dart run flutter_patcher:pack \
  --apk build/app/outputs/flutter-apk/app-release.apk \
  --version 2.5.4-h1 \
  --target-version-code 47

# 3. 需要同时热更资产时（资产必须在 pubspec.yaml 里注册过）
dart run flutter_patcher:pack \
  --apk build/app/outputs/flutter-apk/app-release.apk \
  --version 2.5.4-h2 \
  --target-version-code 47 \
  --assets assets/hero.png,assets/strings/zh.json
```

产物：`dist/patch.zip` + `dist/manifest.json`（含 md5/abi/targetVersionCode）。**没有差量**——每个补丁都是完整的 `libapp.so`（通常几 MB），这是自托管方案相对 Shorebird 的主要代价；对内部分发场景通常可接受。

#### 4.4 检查、下载、应用与进度

```dart
class PatchUpdateController extends ChangeNotifier {
  String _log = '';
  String get log => _log;

  Future<void> checkAndApply() async {
    // checkUpdate 是可选的便捷方法：请求内置的最小 JSON 协议
    // 服务端协议不同的话，自己解析响应后直接构造 PatchInfo 即可
    final check = await FlutterPatcher.checkUpdate(
      'https://cdn.example.com/api/patch/check',
    );
    if (!check.hasUpdate || check.patch == null) {
      _log = '已是最新';
      notifyListeners();
      return;
    }

    final result = await FlutterPatcher.applyPatch(
      check.patch!,
      onProgress: (p) {
        // p.phase: downloading / verifying / finalizing
        // p.fraction: 下载进度 0.0~1.0（无 Content-Length 时为 null）
        _log = '${p.phase.name}  ${p.fraction != null
            ? '${(p.fraction! * 100).toStringAsFixed(0)}%'
            : ''}';
        notifyListeners();
      },
    );

    if (result.ok) {
      _log = '补丁已安装，下次冷启动生效';
    } else {
      // error 分类：invalidArgs / blacklisted / network / md5Mismatch /
      //            signatureInvalid / unsupportedAbi / assetPackageInvalid /
      //            ioError / unknown
      _log = '失败：${result.error?.name} ${result.message ?? ''}';
    }
    notifyListeners();
  }

  /// 已经自己下载好补丁字节时的入口（内置预置补丁、自定义下载器）
  Future<void> applyBytes(Uint8List bytes) async {
    final result = await FlutterPatcher.applyPatchBytes(
      bytes,
      version: '2.5.4-h1',
      targetVersionCode: 47,
    );
    _log = result.ok ? '已安装' : '失败：${result.error?.name}';
    notifyListeners();
  }
}
```

`applyPatch` 返回成功只代表**已落盘**，补丁在下次冷启动才加载。引导用户重启的常见做法：提示条 + "立即重启"按钮（内部用 `exit` 或引导划掉，由产品策略决定）。

#### 4.5 启动诊断上报（监控闭环的关键）

`applyPatch` 报告的是安装期结果；**上次冷启动到底有没有加载补丁**要看诊断：

```dart
final diag = await FlutterPatcher.lastBootDiagnostic;
if (diag != null && !diag.isHealthy) {
  // 上报到 APM。重点盯这些状态：
  // droppedCircuitBreaker  熔断触发——强告警，服务端立即停发
  // droppedMd5Mismatch / droppedSignatureInvalid  完整性失败——排查分发链路
  // droppedVersionCodeMismatch  多为正常 APK 升级，统计即可
  // hookInstallFailed      注入失败——检查 Flutter 版本兼容
  await myApm.report('patch_boot', {
    'status': diag.status.name,
    'patchVersion': diag.patchVersion,
    'appVersionCode': diag.appVersionCode,
    'crashCount': diag.crashCount,
    'message': diag.message,
  });
}
```

#### 4.6 回滚

```dart
await FlutterPatcher.rollback(); // 删除补丁，下次冷启动回到 APK 内置版本
```

手动回滚不进黑名单——它语义是"运营决策"，不是"补丁有问题"。

---

### 5. 服务端如何配合

自托管的核心工作都在服务端。以下是一套可直接落地的参考设计。

#### 5.1 检查更新协议

客户端轮询（建议启动时 + 每隔数小时一次）：

```http
GET /api/patch/check?app_version_code=47&abi=arm64-v8a&current_patch=2.5.4-h1
```

无更新时：

```json
{ "has_update": false }
```

有更新时（字段名 snake_case / camelCase 两种风格客户端都接受）：

```json
{
  "has_update": true,
  "version": "2.5.4-h2",
  "patch_url": "https://cdn.example.com/patches/v47/arm64-v8a/2.5.4-h2.zip",
  "md5": "0123456789abcdef0123456789abcdef",
  "target_version_code": 47,
  "signature": "BASE64_ED25519_SIGNATURE"
}
```

#### 5.2 ABI 路由与补丁托管

`libapp.so` 按 ABI 不通用（每个 patch.zip 内含一个 ABI 的产物，多 ABI 需分别打包分发）。客户端可查询当前 ABI 供路由：

```dart
final abi = await FlutterPatcher.deviceAbi; // 如 arm64-v8a
final vc = await FlutterPatcher.appVersionCode;
```

服务端目录组织（对象存储/CDN/nginx 均可）：

```text
patches/
└── v47/                          # 基线 APK versionCode
    ├── arm64-v8a/
    │   └── 2.5.4-h2.zip
    ├── armeabi-v7a/
    │   └── 2.5.4-h2.zip
    └── x86_64/
        └── 2.5.4-h2.zip
```

全链路 HTTPS；`patch_url` 也可以是 `file://`（本地测试、内置预置补丁场景），校验逻辑完全一致。

#### 5.3 发布流水线中的签名

签名发生在"发布补丁"这一步，而不是响应请求时——对 `dist/patch.zip` 的 md5 签一次，结果连同元数据入库。**私钥只存在于发布流水线的密钥管理系统**（CI 的 secret store / KMS），Web 服务与客户端永远只接触公钥和签名结果。

#### 5.4 灰度放量：按设备分桶

补丁比发版更需要灰度——它绕过了渠道审核，出问题没有外部闸门。推荐按稳定设备 ID 哈希分桶，保证同一设备每次命中的结果一致：

```sql
-- 发布记录表（参考实现）
CREATE TABLE patch_release (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  version       VARCHAR(64)  NOT NULL,          -- 2.5.4-h2
  target_vc     INT          NOT NULL,          -- 基线 versionCode，如 47
  abi           VARCHAR(16)  NOT NULL,          -- arm64-v8a / ...
  md5           CHAR(32)     NOT NULL,
  signature     TEXT         NOT NULL,
  patch_url     VARCHAR(512) NOT NULL,
  rollout_permille INT       NOT NULL DEFAULT 0, -- 0~1000 千分比
  status        VARCHAR(16)  NOT NULL,          -- ramping/full/paused/rolled_back
  released_at   DATETIME     NOT NULL,
  notes         VARCHAR(512)                    -- 变更说明/回滚原因
);
```

```python
# 检查接口核心逻辑（参考实现，Python/任意后端同理）
def check_patch(app_version_code, abi, current_patch, device_id):
    rel = query_latest_patch(
        target_vc=app_version_code, abi=abi, status__in=("ramping", "full"))
    if rel is None:
        return {"has_update": False}

    bucket = int(hashlib.md5(f"{device_id}:{rel.id}".encode()).hexdigest(), 16) % 1000
    if bucket >= rel.rollout_permille:        # 未命中灰度
        return {"has_update": False}
    if current_patch == rel.version:           # 已安装
        return {"has_update": False}
    return {
        "has_update": True,
        "version": rel.version,
        "patch_url": rel.patch_url,
        "md5": rel.md5,
        "target_version_code": rel.target_vc,
        "signature": rel.signature,
    }
```

放量节奏：**1% → 5% → 20% → 50% → 100%**，每档观察至少一个完整的日活周期，指标异常即 `paused`。

#### 5.5 紧急止血

发现坏补丁后的动作顺序：

1. 检查接口停止返回该补丁（`status` 置 `rolled_back`）——新用户不再下载；
2. 已装用户分两类：**触发过熔断的已经本地回滚且进了黑名单**，不会再次加载；**还没触发熔断的**（还没重启或还没暴露问题），推送下一个修复补丁（新 version + 新 md5）覆盖；
3. 复盘后把事故补丁的 `(version, md5)` 记入发布台账。

注意第 2 类的处理：服务端没有"远程删除"通道，**覆盖式发新补丁**是唯一的远程修复手段——这要求补丁发布流水线始终保持可用。

#### 5.6 本地联调

仓库自带最小 mock 服务，验证完整 HTTP 流程（勿用于生产）：

```bash
dart run flutter_patcher:mock_server --dist dist --port 8080
# 模拟器配合：adb reverse tcp:8080 tcp:8080，客户端请求 http://127.0.0.1:8080/check
```

---

### 6. 版本与补丁管理

#### 6.1 versionCode 绑定：补丁的"兼容域"

每个补丁必须声明它适配的基线 APK `versionCode`。两处强制校验：

- 安装时：服务端下发的 `targetVersionCode` 与本机不符 → `invalidArgs` 拒装；
- 每次冷启动：本机 versionCode 变了（用户升了 APK）→ 补丁被静默丢弃，回到内置版本。

这个设计回答了"用户升级 APK 后旧补丁怎么办"——自动失效，不需要清理逻辑。代价是：**灰度发版期间多个 versionCode 并存时，每个基线都要出各自的补丁**（`--target-version-code` 各不同），发布系统要按基线维度管理补丁矩阵。

#### 6.2 什么会作废一个补丁

| 变更 | 补丁是否作废 | 说明 |
|------|-------------|------|
| 基线 APK 升级（versionCode 变化） | ✅ 端侧自动丢弃 | 按 `targetVersionCode` 分发新补丁 |
| Flutter SDK / 引擎升级 | ✅ 必须重新产出 | `libapp.so` 与引擎 ABI 级耦合，旧补丁不可复用 |
| 构建配置变化（混淆规则、flavor、签名） | ✅ 建议重新产出 | 产物差异可能导致行为不一致 |
| 只改 Dart 代码 / 资产内容 | ❌ 正常出补丁 | 热更新的目标场景 |
| 改 Native 代码 / AndroidManifest / 依赖插件 | ❌ 无法热更 | 只能发版 |

#### 6.3 什么能补、什么不能补

| 能热更 | 不能热更 |
|-------|---------|
| `lib/` 下的一切：Widget、逻辑、路由、常量 | Native 代码（Kotlin/Java/C++） |
| 纯 Dart 包的升级（不牵动原生侧） | `AndroidManifest.xml`、APK `res/` |
| 已注册资产的内容替换（`Image.asset` / `rootBundle.load` 自动读到新字节） | 新增/删除原生插件、字体注册变更 |

#### 6.4 补丁版本号与发布台账

- 补丁版本建议 `基线版本-h序号`（如 `2.5.4-h1`、`2.5.4-h2`），与基线 APK 版本的对应关系一眼可读；
- **修复重发必须换 md5**（内容必然变化），同 version 不同 md5 不会被黑名单误拦；
- 每个补丁的发布记录（version / target_vc / abi / md5 / 签名 / 放量比例 / 状态 / 时间）落库——第 5.4 节的 `patch_release` 表就是台账本体，事故复盘全靠它；
- 监控大盘核心指标：**补丁生效率**（`patched` 占比）、**熔断率**（`droppedCircuitBreaker`）、**安装失败分布**（按 error 分类）、**各基线的补丁覆盖进度**。

---

### 7. 发版策略：灰度与回滚

热更新解决"快"，发版策略解决"稳"。两者的监控与止血思路一脉相承。

#### 7.1 为什么灰度

全量发布的问题：新版本有严重 Bug 时 100% 用户同时受影响。灰度发布（Staged Rollout）把影响范围变成可控的递增序列，在问题扩散前发现并止损。经验节奏：`1% → 5% → 20% → 50% → 100%`，每档观察 24-48 小时。

#### 7.2 各端灰度能力（注意语义差异）

**Google Play [Android]**：Console 内置分阶段发布，可以随时**暂停**（halt rollout）。要点：**Play 没有真正的"回滚"**——`versionCode` 必须单调递增，已更新用户无法降级；止血手段是暂停放量 + 以更高 `versionCode` 重新发布修复版。

**App Store [iOS]**：Phased Release 仅对新版本**自动更新**的用户生效（7 天线性放量），可随时暂停；已手动更新的用户不受控制。同样没有回滚。

**国内渠道 [Android]**：部分支持（如华为分阶段发布），多数不支持。通用替代：服务端 Feature Flag 控制新功能可见性 + 服务端强制更新接口控制版本分布（见第 8 节）。

#### 7.3 灰度期间盯什么

| 指标 | 参考阈值（经验值，按业务基线调整） | 数据源 |
|------|------|--------|
| 崩溃率 | 显著高于基线即暂停 | Bugly / Crashlytics / 自建 |
| ANR 率 | 显著高于基线即暂停 | 各厂商后台 / Play Console |
| 启动时间 | 劣化超基线 20% 则调查 | 自定义埋点 |
| 核心转化率 | 下降超 5% 则调查 | 业务埋点 |
| 评价/反馈 | 差评率飙升即暂停 | 各渠道评论 |

---

### 8. 升级提醒与强制更新

#### 8.1 何时强制

强制更新是"用户不更新就无法使用"的核武器，适用面很窄：

- 严重安全漏洞修复
- 服务端 API 彻底不兼容旧版
- 本地数据库结构变更，旧版无法工作
- 强制合规要求（如隐私政策重大变更）

一般 Bug 修复、UI 优化、新功能——都不要强制（用户可能在弱网环境）。

#### 8.2 实现

```dart
import 'dart:io';

import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:flutter/material.dart';

Future<void> maybeShowForceUpdate(
  BuildContext context, {
  required String minSupportedVersion,
}) async {
  final info = await PackageInfo.fromPlatform();
  if (_compareVersions(info.version, minSupportedVersion) >= 0) return;

  await showDialog<void>(
    context: context,
    barrierDismissible: false, // 点遮罩不可关——PopScope 只挡返回键，挡不住遮罩点击
    builder: (context) => PopScope(
      canPop: false,           // 挡系统返回键
      child: AlertDialog(
        title: const Text('需要更新'),
        content: const Text('当前版本过旧，请更新后继续使用。'),
        actions: [
          FilledButton(
            onPressed: () => _openStore(),
            child: const Text('立即更新'),
          ),
        ],
      ),
    ),
  );
}

Future<void> _openStore() async {
  if (Platform.isAndroid) {
    await launchUrl(Uri.parse('market://details?id=com.example.app'));
  } else {
    await launchUrl(Uri.parse('https://apps.apple.com/app/idXXXXXXXXX'));
  }
}

int _compareVersions(String a, String b) {
  final ap = a.split('.').map(int.parse).toList();
  final bp = b.split('.').map(int.parse).toList();
  for (var i = 0; i < 3; i++) {
    if (ap[i] != bp[i]) return ap[i].compareTo(bp[i]);
  }
  return 0;
}
```

两个工程细节：**强制弹窗必须在前台时展示**（部分国产 ROM 会把后台弹窗当广告拦截）；弹窗入口放在首页 `onResume` 等值时机而不是启动即弹。

#### 8.3 可选更新的频率控制

可选弹窗每次启动都弹会被用户骂。经典三板斧：跳过本版本不再提醒、最多提醒 3 次、间隔至少 3 天（`SharedPreferences` 记录，实现直观，此处不展开）。

---

### 9. 紧急回滚

#### 9.1 先纠正一个常见误区

"Google Play 支持回滚到任意历史版本"是错误说法（不少文章以讹传讹）。事实：

- Google Play **不支持版本回滚**；能做的是**暂停分阶段发布**阻止继续扩散；
- 已更新到坏版本的用户，唯一恢复路径是**以更高的 `versionCode` 发布修复版**；
- iOS 同理且更严格：App Store 不允许降级，修复版还要过审。

所以"回滚"在移动端的真实语义是三层组合：**停扩散（暂停灰度/停发补丁）→ 远程止血（功能开关/服务端兼容）→ 覆盖修复（新版本/新补丁）**。

#### 9.2 iOS 加急审核

App Store 提供加急审核通道（Expedited Review），申请入口在开发者网站的 Contact 页，通常针对严重 Bug 或时效性事件。苹果没有公开配额承诺，滥用会导致后续申请被拒——把它当稀缺资源管理。

#### 9.3 回滚决策流程

```text
发现严重问题
  ↓
评估影响（崩溃率 / 资损 / 舆情）
  ↓
├─ 影响可控 → 功能开关关闭问题功能 → 常规节奏修复
├─ 影响较大 → 暂停灰度/停发补丁 + 功能开关 + 修复版提审
└─ 影响严重（资损级）→ 全渠道暂停 + 全平台加急 + 必要时服务端降级旧接口
```

---

## 常见坑

### 1. Flutter SDK 升级后复用旧补丁

**场景**：团队升级 Flutter 后，沿用升级前打的补丁，部分设备加载补丁后行为异常。
**根因**：`libapp.so` 与 Flutter 引擎的快照格式深度耦合，跨引擎版本的产物没有兼容性保证。
**解决**：SDK/引擎一变，所有在放量的补丁全部重新产出，并以新 md5 发布。

### 2. 混合栈预热引擎导致补丁失效

**场景**：宿主 App 在 `Application.attachBaseContext` 里预热 FlutterEngine 做首屏加速，补丁永远不生效。
**根因**：自动初始化的 ContentProvider 时机晚于引擎创建，反射注入来不及。
**解决**：Manifest 移除自动初始化 provider，在 `attachBaseContext` 里手动调 `FlutterPatcherApplication.attachPatcher(base)`（见 3.2 节）。

### 3. 服务端忘下架坏补丁

**场景**：熔断回滚后，用户反复下载同一个坏补丁，浪费流量且体验差。
**根因**：只依赖端侧回滚，没有服务端联动。
**解决**：端侧黑名单保证"不再加载"，但服务端必须配合停发；监控里把 `droppedCircuitBreaker` 设为强告警直连发布系统。

### 4. `md5` 缺省以为还有签名保护

**场景**：服务端协议没下发 md5，团队以为 Ed25519 签名仍在兜底。
**根因**：签名消息体就是 md5 hex，无 md5 时**两种校验同时跳过**。
**解决**：要么补齐 md5 + 签名，要么明确接受"仅 HTTPS"的安全模型并写入评审记录。

### 5. 灰度期间版本碎片化

**场景**：灰度期 1.x 与 2.x 并存，加上补丁矩阵，服务端要兼容的组合爆炸。
**解决**：API 向下兼容三原则（新字段 optional、旧字段不删、忽略未知字段）；大版本切换设置 `minSupportedVersion` 收敛存量；补丁严格按 `(versionCode, abi)` 分域管理。

### 6. 强制更新弹窗被绕过

**场景**：弹窗加了 `PopScope(canPop: false)`，用户点一下弹窗外面的遮罩就关掉了。
**根因**：`showDialog` 默认 `barrierDismissible: true`，`PopScope` 只拦截系统返回。
**解决**：`barrierDismissible: false` 与 `PopScope` 要同时设置（见 8.2 节）。

### 7. 版本号字符串比较

**场景**：`'2.10.0'.compareTo('2.9.0')` 返回负数，误判 2.10 低于 2.9。
**解决**：永远分段数值比较（见 8.2 节 `_compareVersions`）。

### 8. 构建号不统一导致发布混乱

**场景**：iOS/Android 各自维护 buildNumber，补丁的 `targetVersionCode` 对不上。
**解决**：CI 单一数据源注入（Git tag / 自增序列），`flutter build --build-number=$CI_BUILD_NUMBER`；补丁发布脚本从同一来源读基线 versionCode。

---

## 面试追问

### 1. Flutter 为什么做不了 RN 式热更新？

**要点**：Release 下 Dart AOT 编译为机器码进 `libapp.so`，没有可解释执行的中间产物；iOS 受 2.5.2 条款限制，政策面直接封死；Flutter 官方基于安全模型与版本碎片化成本明确不做。能展开的方向：AOT 产物与引擎的耦合关系、`--aot-shared-library-name` 这个引擎级"后门"。

### 2. Android 上热更新的可行路径是什么？

**要点**：冷启动前替换 `libapp.so`。关键三步——时机（抢在引擎初始化前，ContentProvider 是标准载体）、注入（反射替换 `FlutterInjector.flutterLoader`，靠引擎参数指向补丁路径）、兜底（校验链 + 原子安装 + 熔断回滚）。Shorebird 与自托管方案在这三步上的差异：云端 vs 自建、差量 vs 整包。

### 3. 自托管热更新怎么防止"补丁把 App 砖了"？

**要点**：四层——启动失败判定（API 30+ 用 ApplicationExitInfo 精确区分崩溃与用户主动退出）、首帧清零、verifyAfter 窗口内 Dart 异常视同崩溃（覆盖白屏型故障）、黑名单 `(version, md5)` 防反复下发。再往上一层是服务端灰度与停发联动。能说出"fail-fast（maxCrashCount=1）优于重试"的取舍逻辑是加分项。

### 4. 补丁和 APK 版本怎么关联？

**要点**：补丁绑定基线 `versionCode`，安装与冷启动双重校验；APK 升级后旧补丁自动失效；灰度发版期多基线并存时按 `(versionCode, abi)` 出补丁矩阵；SDK 升级必须重出全部补丁。

### 5. 灰度发布你怎么做？

**要点**：渠道灰度（Play 分阶段 / iOS Phased Release）+ 自有渠道按设备哈希分桶；每档观察崩溃率、ANR、核心转化；异常即暂停。强调"暂停 ≠ 回滚"：移动端没有真正的版本回滚，止血靠停扩散 + 功能开关 + 覆盖修复。

### 6. 设计一套完整的发版与应急体系？

**要点**：四层——L1 预防（灰度 + 功能开关 + 自动化测试）、L2 监控（崩溃/ANR/业务指标告警，热更新场景再加补丁生效率与熔断率）、L3 止血（暂停放量、停发补丁、远程关功能）、L4 修复（覆盖发版、iOS 加急）。落到时效：L3 分钟级、L4 小时到天级。

---

## 参考资源

- [flutter_patcher（GitHub 源码）](https://github.com/xuelinger2333/flutter_patcher) —— 本文源码剖析基于 0.1.4
- [flutter_patcher（pub.dev）](https://pub.dev/packages/flutter_patcher)
- [Shorebird 官方文档](https://docs.shorebird.dev/)
- [Google Play 分阶段发布说明](https://support.google.com/googleplay/android-developer/answer/6346149)
- [App Store 加急审核入口](https://developer.apple.com/contact/app-store/?topic=expedite)
- [Flutter Android 发版指南](https://docs.flutter.dev/deployment/android)
- [语义化版本规范](https://semver.org/)
