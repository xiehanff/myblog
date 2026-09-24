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

> 热更新是 Flutter 工程化里被问得最多、也最容易答错的题目。
> 这篇回答三个问题：Flutter 为什么做不了 RN 那种热更新？2026 年真实的方案格局长什么样？如果要自托管，从打补丁到服务端灰度再到崩溃回滚，整套体系怎么落地？
> 自托管这块，拿开源库 flutter_patcher（0.1.4，MIT 协议）当样本做源码级剖析。它每一层的设计（加载注入、原子安装、签名校验、熔断回滚）都是"企业级热更新"的通用考题。

**版本说明**：flutter_patcher 部分基于 0.1.4 源码（2026-08，GitHub `xuelinger2333/flutter_patcher`）；Shorebird 现状截至 2026-08，商业条款以官网为准。文里的代码都照着真实 API 写，没在真机跑通的流程会明确标出来。

---

## 概述

先把结论摆出来，后面再一层层展开：

1. **iOS 上不存在合规的热更新**。App Store 审核条款 2.5.2 禁止下载并执行可动态改变行为的代码，这条路在政策层面就堵死了。
2. **Android 上技术可行，而且只有一条主路径**：Release 模式下 Dart 代码 AOT 编译成 `libapp.so`，热更新就等于"下次冷启动时让引擎加载一份新的 `libapp.so`"。Shorebird（云端托管，引擎级差量）和 flutter_patcher（自托管，整包替换）是同一条路径的两种工程化走法。
3. **热更新只是应急手段，替不了一套发版策略**。灰度发布控制影响范围、功能开关远程止血、强制更新兜底、加急审核救火，这套"发版组合拳"比热更新本身更常被面试问到。

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

**核心原因**：Flutter 的 Release 模式走 AOT（Ahead-of-Time）编译，Dart 代码连同它依赖的 Dart 运行时快照一起编进了 `libapp.so`。这东西不是能动态解释执行的中间代码，想改它只有两条路：要么把整个产物重新编一遍，要么在引擎加载它之前把文件换掉。

#### 1.2 理论上的绕过方案与缺陷

| 方案 | 原理 | 致命缺陷 |
|------|------|---------|
| JIT 模式 | Release 也用 JIT 执行 | iOS 系统层面禁止自修改可执行内存；Android 上失去 AOT 的启动与峰值性能优势 |
| 下发 Dart Kernel | 编译为 Kernel Snapshot 动态加载 | iOS 违反 2.5.2；Android 上引擎不支持运行时切换入口 |
| WebView 壳 | 业务逻辑放 H5 | 不是 Flutter，体验退化 |
| 动态布局引擎 | JSON/DSL 驱动 UI | 只能改外观不能改逻辑，双端一致性维护成本高 |
| **替换 libapp.so** | 冷启动前换掉 AOT 产物 | **Android 上可行，这就是下文全部内容的起点** |

#### 1.3 Flutter 官方的立场

Flutter 团队明确表过态，AOT 热更新官方不支持，理由有三条：

1. **安全模型**：动态加载代码绕过了操作系统的代码签名体系；
2. **测试成本**：线上版本本来就碎，"哪个基线 + 哪个补丁"的组合数会随发布次数一路涨，质量保障难度是指数级上升的；
3. **责任边界**：官方真提供了这个能力，就得给所有渠道的合规后果背书。

所以现实中的选择就是：**iOS 认了发版节奏，Android 在合规允许的渠道里用第三方方案**。

---

### 2. 2026 年的方案格局

#### 2.1 Shorebird：云端托管的代码推送

Shorebird 是目前最成熟的 Flutter 代码推送商业方案，**Android、iOS、Mac、Windows、Linux 五端的 Dart 代码补丁都支持**（`shorebird release ios` / `shorebird patch ios`，注意 iOS 补丁只支持真机、不支持模拟器）。它的做法是在自己的构建工具链里改造 Dart 编译器，把基线版本的元数据记下来，代码改完之后能产出引擎级差量补丁，客户端下次重启时生效。

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

几个关键事实（免得面试翻车）：

- **补丁在下次冷启动生效**，不是当前进程里热替换；
- 免费档限制的是**每月补丁安装量**，不是"补丁条数"（具体额度以官网定价页为准）；
- iOS 合规性还有解释空间：Shorebird 官方说自己的补丁机制符合 App Store 条款，但要不要用，得各团队自己去做合规评估，部分国内渠道是明确禁止的；
- Native 代码改不了，`pubspec.yaml` 里的依赖也改不了。

#### 2.2 自托管：flutter_patcher

如果代码不能交给第三方云（企业内网分发、私有渠道、数据合规要求），那就得自托管。开源库 [flutter_patcher](https://pub.dev/packages/flutter_patcher)（MIT）把"替换 libapp.so"这条路完整工程化了一遍：

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

**选型建议**：要 iOS，或者不想自建基础设施，选 Shorebird；Android 私有渠道、要求代码不出自己服务器的，选自托管；上架 Google Play 的应用，**别用任何运行时下发可执行代码的方案**（见 2.4）。

#### 2.4 合规边界

- **Google Play**：政策禁止应用在运行时下载可执行代码。自托管热更新只适用于自控分发渠道：企业内部分发、官网直发、国内不设这条限制的应用商店（以各渠道当前政策为准）。
- **国内渠道**：华为等部分市场对热更新有明确限制，接入前一个渠道一个渠道确认。
- **iOS**：2.5.2 条款，不要碰。

---

### 3. 自托管原理：冷启动替换 libapp.so（源码剖析）

这节拿 flutter_patcher 0.1.4 的源码当样本，把整条链路拆开看。这节看明白了，"自研热更新方案设计"这类面试题就能答完整。

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

替换 `libapp.so` 的前提是**抢在 Flutter 引擎初始化之前**把两件事做完：校验磁盘上的补丁，把加载路径"掉包"。Android 的进程启动顺序是固定的：

```text
Application.attachBaseContext()
  ↓
installContentProviders()   ← flutter_patcher 的 AutoInitProvider 在这里执行
  ↓
Application.onCreate()
  ↓
Activity 创建 → 首次初始化 FlutterEngine → FlutterInjector 开始被使用
```

插件挂了一个不暴露任何数据的 `ContentProvider`（`FlutterPatcherAutoInitProvider`），借 `installContentProviders()` 这个时机做补丁加载：它比 `Application.onCreate` 早，又必然早于 Activity。Firebase、WorkManager 的自动初始化用的是同一个套路。宿主**不用改自己的 Application 类**。

唯一的例外，是宿主在 `attachBaseContext` 里**预热 FlutterEngine** 的大厂混合工程：引擎创建早于 provider，注入赶不上。这类项目得在 Manifest 里把自动初始化摘掉，改成手动调用：

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

这一步是整个方案里最核心、也最"黑"的。Flutter 的 Android embedding 有个单例 `FlutterInjector`，里面持着一个 `FlutterLoader`，引擎初始化时靠它定位 AOT 产物。flutter_patcher 是这么干的（`LoaderHook.kt`）：

1. 反射拿到 `FlutterInjector` 实例上的 `flutterLoader` 字段；
2. 拿自定义的 `PatchedFlutterLoader` 把它换掉，子类只重写一个关键方法：

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

引擎参数 `--aot-shared-library-name` 从 Flutter 1.x 起就稳定存在，接受任意文件路径。**这就是"替换 libapp.so"的全部秘密：引擎本来就支持从指定路径加载 AOT 产物，只是默认没人告诉它**。

反射是依赖 Flutter 内部字段名的，所以插件做了三层防御：

| 层级 | 策略 | 风险 |
|------|------|------|
| 1 | 候选字段名精确匹配（默认 `flutterLoader`，可通过 `init(loaderFieldCandidates: [...])` 下发新名字） | 无 |
| 2 | 按字段类型匹配（`FlutterLoader` 或其子类） | 无 |
| 3 | 启发式（首个非 static 非 ExecutorService 字段） | 可能命错字段，**默认关闭** |

第 3 层默认关掉，这个取舍值得说一句：**宁可退回内置 so，也别注到错误字段上搞出没法预测的崩溃**，fail-safe 优先于成功率，热更新方案都该是这个默认姿态。

#### 3.4 资产热更新：AssetManifest 合并与私有资产包

替换 `libapp.so` 只管 Dart 代码，图片、JSON 这类资产走的是另一条链路（0.1.3+ 支持）。装补丁的时候，它在本地合成一份完整的资产包：

1. 把基线 APK 里 `assets/flutter_assets/*` 全量拷到 staging 目录；
2. 用补丁带的新资产把对应路径覆盖掉；
3. **合并资产索引**：`AssetManifest.bin` 是 Flutter 用 `StandardMessageCodec` 编出来的"资产键 → 变体列表"表，插件先解码，对每个被打补丁的资产 `upsert`（替换或插入变体列表），再重新编码写回；
4. 逐个校验每个资产文件的 MD5；
5. 最后把整棵树重新打成一个私有的 `flutter_assets.apk`。

冷启动加载的时候，`LoaderHook` 除了换 loader，还会反射把 `FlutterInjector.flutterJniFactory` 换掉，让自定义的 `FlutterJNI` 在执行 `runBundleAndSnapshotFromLibrary` 之前调 `AssetManager.addAssetPath`，把这份私有资产包挂进系统的 AssetManager。**`Image.asset()`、`rootBundle.load()` 一行业务代码都不用改，就能读到新资产**，没被打补丁的路径还是回落到 APK 内置资产。

"能补资产"比"能补代码"麻烦的地方就在这：代码只有一个 `libapp.so`，资产要处理索引表合并和双来源回落。

#### 3.5 安装事务：原子提交与断电恢复

补丁安装（`applyPatch`）最怕装到一半断电或者被杀，下次启动加载了半个补丁。flutter_patcher 用"staging → pending → current"三级目录加安装标记，把这事做成了事务：

```text
staging/   ← 下载校验后在这里解包 so、合成资产包（随便中断，无害）
   ↓ 逐个 rename
pending/   ← finalizePatch 内部的短暂中间态；先写 install marker
   ↓ rename（真正的事务提交点）
current/   ← 下次冷启动实际加载的内容；旧版本挪到 previous/ 后删除
```

所有写文件都带 `fd.sync()` 落盘。冷启动时要是发现 `installing` 标记还在（上次没提交完），`recoverInterruptedInstall` 就按"有 previous 回滚到 previous、没有就丢掉半成品"的规则收拾现场。

**注意**：这个磁盘事务只保证"装好或者没装"，保证不了"装好的补丁能启动"，后者是崩溃保护的事，两套机制互相独立。

#### 3.6 校验链：四道关卡

安装和冷启动两个阶段都要校验，顺序是固定的：

```text
payload MD5（外层 zip 或裸 so）
  → Ed25519 签名（对 md5 hex 字符串签名）
  → versionCode 匹配（补丁绑定宿主 APK 的 versionCode）
  → patch.zip 内部逐文件 MD5（libapp.so + 每个资产）
```

两个容易漏掉的安全语义（面试加分点）：

1. **`md5` 缺省 = 签名同时失效**。签名的消息体就是 md5 hex 字符串，没 md5 就没有可签名的东西，只靠 HTTPS 保传输完整性的时候，两种校验会一起跳过。原生侧下载完还是会算一遍实际 md5 写进元数据，留给启动期校验和黑名单用。
2. **strictSignature 防降级攻击**。Android 13（API 33）以下没有 JDK 原生 Ed25519。默认策略（`strictSignature: true`）是：低版本设备收到**带签名的补丁直接拒载**，不是"跳过验签放行"，不然攻击者专门拿低版本设备就能绕过签名校验。想关掉，得显式接受降级。

另外 ZIP 里的路径都会过一遍 `isSafeZipPath`（拒绝绝对路径、`\` 开头、`..` 穿越与空字节），防经典的 Zip Slip 攻击。

#### 3.7 崩溃保护：熔断、黑名单、观察窗口

补丁把启动搞崩，是热更新里最怕的事故形态：崩溃 → 下次启动又加载同一个坏补丁 → 无限循环。flutter_patcher 的防线有四层：

**第一层：精准判定"上次是不是崩了"。** Android 11+ 用 `ActivityManager.getHistoricalProcessExitReasons`（按上次记录的 pid 查）拿到上一次进程退出的官方原因，只有 `CRASH / CRASH_NATIVE / ANR / INITIALIZATION_FAILURE` 四类计进熔断计数；用户划掉、系统 OOM、强停都不算。Android 10 及以下退化成 `patch_loading` 标志位兜底：首帧前死了算崩溃，首帧后不算。

**第二层：首帧即清零。** Dart 侧 `init()` 之后，首个渲染帧回调会触发 `reportBootSuccess`，把熔断计数立即清掉，正常启动的用户不会一直带着"启动中"状态。

**第三层：verifyAfter 观察窗口。** 首帧之后默认再盯 5 秒（只算前台时间）。窗口里 `init()` 装的 `PlatformDispatcher.onError` / `FlutterError.onError` 钩子抓到的未处理异常，会上报原生侧**算作一次真崩溃**计数，这就把"进程没死但首屏白屏/不可用"的坏补丁形态也盖住了。窗口一关，钩子就透明转发给原来的处理器，业务异常不再影响熔断。

**第四层：黑名单。** 熔断一触发，坏补丁就以 `(version, md5)` 复合键进本地黑名单：服务端再下发同一个坏补丁，**下载前直接拒掉**；开发者拿同一个 version 修复后重发（md5 变了）可以重试；黑名单跨 APK 升级一直留着（防服务端忘了下架），FIFO 上限 50 条。手动 `rollback()` 不进黑名单。

默认 `maxCrashCount = 1`：fail-fast，失败一次就熔断。生产环境不建议调高，确认有问题的补丁，重试只是放大事故。

---

### 4. 客户端接入实战

下面的代码都用 flutter_patcher 0.1.4 的公开 API（`lib/flutter_patcher.dart`）。

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

`init()` 干三件事：把配置持久化到原生侧（给下次冷启动的自动加载流程读）、装 Dart 错误钩子、注册首帧成功回调。这方法幂等，重复调也没问题。

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

产物是 `dist/patch.zip` + `dist/manifest.json`（含 md5/abi/targetVersionCode）。**没有差量**：每个补丁都是完整的 `libapp.so`（通常几 MB），这是自托管方案相对 Shorebird 的主要代价；对内部分发场景通常能接受。

#### 4.4 检查、下载、应用与进度

```dart
class PatchUpdateController extends ChangeNotifier {
  String _log = '';
  String get log => _log;

  Future<void> checkAndApply() async {
    // checkUpdate 是可选的便捷方法：请求内置的最小 JSON 协议
    // 服务端协议不一样的话，自己解析响应后直接构造 PatchInfo 就行
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

`applyPatch` 返回成功只说明**已经落盘**，补丁要等下次冷启动才加载。引导用户重启的常见做法：弹个提示条 + "立即重启"按钮（内部用 `exit` 还是引导用户划掉，看产品策略）。

#### 4.5 启动诊断上报（监控闭环的关键）

`applyPatch` 报的是安装期结果；**上次冷启动到底有没有加载补丁**，得看诊断：

```dart
final diag = await FlutterPatcher.lastBootDiagnostic;
if (diag != null && !diag.isHealthy) {
  // 上报到 APM。重点盯这几个状态：
  // droppedCircuitBreaker  熔断触发，强告警，服务端立即停发
  // droppedMd5Mismatch / droppedSignatureInvalid  完整性失败，排查分发链路
  // droppedVersionCodeMismatch  多为正常 APK 升级，统计一下就行
  // hookInstallFailed      注入失败，检查 Flutter 版本兼容
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

手动回滚不进黑名单，它代表的是"运营决策"，不是"补丁有问题"。

---

### 5. 服务端如何配合

自托管的核心工作其实都在服务端。下面这套参考设计可以直接落地。

#### 5.1 检查更新协议

客户端轮询（建议启动时来一次，之后每隔几小时一次）：

```http
GET /api/patch/check?app_version_code=47&abi=arm64-v8a&current_patch=2.5.4-h1
```

无更新时：

```json
{ "has_update": false }
```

有更新时（字段名不管是 snake_case 还是 camelCase，客户端都认）：

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

`libapp.so` 按 ABI 不通用（每个 patch.zip 里只含一个 ABI 的产物，多 ABI 得分头打包分发）。客户端可以查当前 ABI 拿去路由：

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

全链路走 HTTPS；`patch_url` 也能是 `file://`（本地测试、内置预置补丁的场景），校验逻辑完全一样。

#### 5.3 发布流水线中的签名

签名是在"发布补丁"这一步做的，不是每次请求现签：对 `dist/patch.zip` 的 md5 签一次，结果连同元数据一起入库。**私钥只放在发布流水线的密钥管理系统里**（CI 的 secret store / KMS），Web 服务和客户端永远只接触公钥和签名结果。

#### 5.4 灰度放量：按设备分桶

补丁比发版更需要灰度，它绕过了渠道审核，出了问题没有外部闸门拦着。建议按稳定设备 ID 哈希分桶，保证同一台设备每次命中的结果都一样：

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

放量节奏：**1% → 5% → 20% → 50% → 100%**，每档至少观察一个完整的日活周期，指标异常就置 `paused`。

#### 5.5 紧急止血

发现坏补丁之后的动作顺序：

1. 检查接口先停止返回这个补丁（`status` 置 `rolled_back`），新用户不再下载；
2. 已经装了的用户分两类：**触发过熔断的已经本地回滚、也进了黑名单**，不会再加载；**还没触发熔断的**（还没重启，或者问题还没暴露），推下一个修复补丁（新 version + 新 md5）去覆盖；
3. 复盘完把事故补丁的 `(version, md5)` 记进发布台账。

注意第 2 类的处理：服务端没有"远程删除"这种通道，**覆盖式发新补丁**是唯一的远程修复手段，这就要求补丁发布流水线一直得是能用的。

#### 5.6 本地联调

仓库自带一个最小的 mock 服务，用来验证完整的 HTTP 流程（别用在生产）：

```bash
dart run flutter_patcher:mock_server --dist dist --port 8080
# 模拟器配合：adb reverse tcp:8080 tcp:8080，客户端请求 http://127.0.0.1:8080/check
```

---

### 6. 版本与补丁管理

#### 6.1 versionCode 绑定：补丁的"兼容域"

每个补丁都得声明它适配哪个基线 APK 的 `versionCode`。有两个地方是强制校验：

- 安装时：服务端下发的 `targetVersionCode` 跟本机对不上 → `invalidArgs` 拒装；
- 每次冷启动：本机 versionCode 变了（用户升了 APK）→ 补丁被静默丢掉，回到内置版本。

"用户升级 APK 之后旧补丁怎么办"，这个设计给的就是答案：自动失效，不用写清理逻辑。代价是：**灰度发版期间多个 versionCode 并存，每个基线都得出一个自己的补丁**（`--target-version-code` 各不一样），发布系统得按基线维度管补丁矩阵。

#### 6.2 什么会作废一个补丁

| 变更 | 补丁是否作废 | 说明 |
|------|-------------|------|
| 基线 APK 升级（versionCode 变化） | ✅ 端侧自动丢弃 | 按 `targetVersionCode` 分发新补丁 |
| Flutter SDK / 引擎升级 | ✅ 必须重新产出 | `libapp.so` 与引擎 ABI 级耦合，旧补丁不可复用 |
| 构建配置变化（混淆规则、flavor、签名） | ✅ 建议重新产出 | 产物有差异，可能出现行为不一致 |
| 只改 Dart 代码 / 资产内容 | ❌ 正常出补丁 | 热更新的目标场景 |
| 改 Native 代码 / AndroidManifest / 依赖插件 | ❌ 无法热更 | 只能发版 |

#### 6.3 什么能补、什么不能补

| 能热更 | 不能热更 |
|-------|---------|
| `lib/` 下的一切：Widget、逻辑、路由、常量 | Native 代码（Kotlin/Java/C++） |
| 纯 Dart 包的升级（不牵动原生侧） | `AndroidManifest.xml`、APK `res/` |
| 已注册资产的内容替换（`Image.asset` / `rootBundle.load` 自动读到新字节） | 新增/删除原生插件、字体注册变更 |

#### 6.4 补丁版本号与发布台账

- 补丁版本建议用 `基线版本-h序号`（如 `2.5.4-h1`、`2.5.4-h2`），跟基线 APK 版本的对应关系一眼就能看出来；
- **修复重发必须换 md5**（内容必然变化），同 version 不同 md5 不会被黑名单误拦；
- 每个补丁的发布记录（version / target_vc / abi / md5 / 签名 / 放量比例 / 状态 / 时间）都落库，第 5.4 节的 `patch_release` 表就是台账本体，事故复盘全靠它；
- 监控大盘上盯这几个核心指标：**补丁生效率**（`patched` 占比）、**熔断率**（`droppedCircuitBreaker`）、**安装失败分布**（按 error 分类）、**各基线的补丁覆盖进度**。

---

### 7. 发版策略：灰度与回滚

热更新解决的是"快"，发版策略解决的是"稳"，两者的监控和止血思路是一脉相承的。

#### 7.1 为什么灰度

全量发布的问题在于：新版本一旦有严重 Bug，100% 的用户同时中招。灰度发布（Staged Rollout）把影响范围变成一个可控的递增序列，在问题扩散之前发现并止损。经验节奏是 `1% → 5% → 20% → 50% → 100%`，每档盯 24-48 小时。

#### 7.2 各端灰度能力（注意语义差异）

**Google Play [Android]**：Console 里有内置的分阶段发布，随时能**暂停**（halt rollout）。要点：**Play 没有真正的"回滚"**，`versionCode` 只能单调递增，已经更新的用户没法降级；止血手段就是暂停放量，再拿更高的 `versionCode` 重发修复版。

**App Store [iOS]**：Phased Release 只对**自动更新**到新版本的用户生效（7 天线性放量），随时能暂停；手动更新过的用户不受它控制。同样没有回滚。

**国内渠道 [Android]**：部分支持（比如华为的分阶段发布），多数不支持。通用替代做法：服务端 Feature Flag 控制新功能可见性，再加服务端强制更新接口控制版本分布（见第 8 节）。

#### 7.3 灰度期间盯什么

| 指标 | 参考阈值（经验值，按业务基线调整） | 数据源 |
|------|------|--------|
| 崩溃率 | 显著高于基线即暂停 | Bugly / Crashlytics / 自建 |
| ANR 率 | 显著高于基线即暂停 | 各厂商后台 / Play Console |
| 启动时间 | 劣化超过基线 20% 就查 | 自定义埋点 |
| 核心转化率 | 下降超 5% 则调查 | 业务埋点 |
| 评价/反馈 | 差评率飙升即暂停 | 各渠道评论 |

---

### 8. 升级提醒与强制更新

#### 8.1 何时强制

强制更新是"用户不更新就没法用"的核武器，适用面很窄：

- 严重安全漏洞修复
- 服务端 API 彻底不兼容旧版
- 本地数据库结构变更，旧版无法工作
- 强制合规要求（如隐私政策重大变更）

一般的 Bug 修复、UI 优化、新功能，都别强制（用户可能正在弱网环境里）。

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
    barrierDismissible: false, // 点遮罩不可关，PopScope 只挡返回键，挡不住遮罩点击
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

两个工程细节：**强制弹窗得在前台的时候展示**（部分国产 ROM 会把后台弹窗当广告拦掉）；弹窗入口挂在首页 `onResume` 这类时机，别一启动就弹。

#### 8.3 可选更新的频率控制

可选弹窗每次启动都弹，用户要骂人。经典三板斧：跳过本版本不再提醒、最多提醒 3 次、间隔至少 3 天（用 `SharedPreferences` 记录，实现很直观，这里不展开）。

---

### 9. 紧急回滚

#### 9.1 先纠正一个常见误区

"Google Play 支持回滚到任意历史版本"这种说法是错的（不少文章以讹传讹）。事实是：

- Google Play **不支持版本回滚**；能做的是**暂停分阶段发布**，阻止继续扩散；
- 已更新到坏版本的用户，唯一恢复路径是**以更高的 `versionCode` 发布修复版**；
- iOS 一个道理，而且更严：App Store 不允许降级，修复版还得过审。

所以"回滚"在移动端真正的语义是三层组合：**停扩散（暂停灰度/停发补丁）→ 远程止血（功能开关/服务端兼容）→ 覆盖修复（新版本/新补丁）**。

#### 9.2 iOS 加急审核

App Store 有加急审核通道（Expedited Review），申请入口在开发者网站的 Contact 页，一般针对严重 Bug 或时效性事件。苹果没公开说过配额，滥用会导致后续申请被拒。把它当稀缺资源管。

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

**场景**：团队升级完 Flutter，还用着升级前打的补丁，部分设备加载补丁后行为异常。
**根因**：`libapp.so` 与 Flutter 引擎的快照格式耦合得很深，跨引擎版本的产物没有兼容性保证。
**解决**：SDK/引擎一变，所有在放量的补丁全部重新产出，并以新 md5 发布。

### 2. 混合栈预热引擎导致补丁失效

**场景**：宿主 App 在 `Application.attachBaseContext` 里预热 FlutterEngine 做首屏加速，补丁就是永远不生效。
**根因**：自动初始化的 ContentProvider 比引擎创建晚，反射注入赶不上。
**解决**：把 Manifest 里的自动初始化 provider 移除，在 `attachBaseContext` 里手动调 `FlutterPatcherApplication.attachPatcher(base)`（见 3.2 节）。

### 3. 服务端忘下架坏补丁

**场景**：熔断回滚后，用户反复下载同一个坏补丁，浪费流量，体验也差。
**根因**：只靠端侧回滚，服务端没联动。
**解决**：端侧黑名单保证"不再加载"，服务端还得配合停发；监控里把 `droppedCircuitBreaker` 设成强告警，直接连发布系统。

### 4. `md5` 缺省以为还有签名保护

**场景**：服务端协议没下发 md5，团队以为 Ed25519 签名还在兜底。
**根因**：签名消息体就是 md5 hex，没 md5 的时候**两种校验一起跳过**。
**解决**：要么补齐 md5 + 签名，要么明确接受"仅 HTTPS"的安全模型并写进评审记录。

### 5. 灰度期间版本碎片化

**场景**：灰度期 1.x 与 2.x 并存，再加补丁矩阵，服务端要兼容的组合就炸了。
**解决**：API 向下兼容三原则（新字段 optional、旧字段不删、忽略未知字段）；大版本切换设置 `minSupportedVersion` 收敛存量；补丁严格按 `(versionCode, abi)` 分域管理。

### 6. 强制更新弹窗被绕过

**场景**：弹窗加了 `PopScope(canPop: false)`，用户点一下弹窗外面的遮罩就关掉了。
**根因**：`showDialog` 默认 `barrierDismissible: true`，`PopScope` 只拦截系统返回。
**解决**：`barrierDismissible: false` 与 `PopScope` 要同时设置（见 8.2 节）。

### 7. 版本号字符串比较

**场景**：`'2.10.0'.compareTo('2.9.0')` 返回负数，误判 2.10 低于 2.9。
**解决**：一律分段按数值比较（见 8.2 节 `_compareVersions`）。

### 8. 构建号不统一导致发布混乱

**场景**：iOS 和 Android 各维护各的 buildNumber，补丁的 `targetVersionCode` 就对不上。
**解决**：CI 单一数据源注入（Git tag / 自增序列），`flutter build --build-number=$CI_BUILD_NUMBER`；补丁发布脚本从同一个来源读基线 versionCode。

---

## 面试追问

### 1. Flutter 为什么做不了 RN 式热更新？

**要点**：Release 下 Dart AOT 编成机器码进 `libapp.so`，没有能解释执行的中间产物；iOS 卡在 2.5.2 条款上，政策面直接封死；Flutter 官方考虑到安全模型与版本碎片化的成本，明确不做。能往下展开的方向：AOT 产物跟引擎的耦合关系、`--aot-shared-library-name` 这个引擎级"后门"。

### 2. Android 上热更新的可行路径是什么？

**要点**：冷启动之前替换 `libapp.so`。关键三步：时机（抢在引擎初始化之前，ContentProvider 是标准载体）、注入（反射替换 `FlutterInjector.flutterLoader`，用引擎参数指向补丁路径）、兜底（校验链 + 原子安装 + 熔断回滚）。Shorebird 与自托管在这三步上的差别：云端还是自建、差量还是整包。

### 3. 自托管热更新怎么防止"补丁把 App 砖了"？

**要点**：分四层。启动失败判定（API 30+ 用 ApplicationExitInfo 把崩溃和用户主动退出精确区分开）、首帧清零、verifyAfter 窗口里的 Dart 异常算作崩溃（覆盖白屏型故障）、黑名单 `(version, md5)` 防反复下发。再往上一层，是服务端灰度和停发联动。能讲清楚"fail-fast（maxCrashCount=1）优于重试"这个取舍，是加分项。

### 4. 补丁和 APK 版本怎么关联？

**要点**：补丁绑基线 `versionCode`，安装和冷启动要双重校验；APK 升级后旧补丁自动失效；灰度发版期多基线并存，就按 `(versionCode, abi)` 出补丁矩阵；SDK 升级必须重出全部补丁。

### 5. 灰度发布你怎么做？

**要点**：渠道灰度（Play 分阶段 / iOS Phased Release）加自有渠道按设备哈希分桶；每档盯崩溃率、ANR、核心转化；一异常就暂停。要强调"暂停 ≠ 回滚"：移动端没有真正的版本回滚，止血靠停扩散 + 功能开关 + 覆盖修复。

### 6. 设计一套完整的发版与应急体系？

**要点**：四层：L1 预防（灰度 + 功能开关 + 自动化测试）、L2 监控（崩溃/ANR/业务指标告警，热更新场景再加上补丁生效率与熔断率）、L3 止血（暂停放量、停发补丁、远程关功能）、L4 修复（覆盖发版、iOS 加急）。落到时效上：L3 分钟级，L4 小时到天级。

---

## 参考资源

- [flutter_patcher（GitHub 源码）](https://github.com/xuelinger2333/flutter_patcher)：文里的源码剖析基于 0.1.4
- [flutter_patcher（pub.dev）](https://pub.dev/packages/flutter_patcher)
- [Shorebird 官方文档](https://docs.shorebird.dev/)
- [Google Play 分阶段发布说明](https://support.google.com/googleplay/android-developer/answer/6346149)
- [App Store 加急审核入口](https://developer.apple.com/contact/app-store/?topic=expedite)
- [Flutter Android 发版指南](https://docs.flutter.dev/deployment/android)
- [语义化版本规范](https://semver.org/)
