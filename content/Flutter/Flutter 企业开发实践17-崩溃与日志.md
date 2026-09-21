---
title: Flutter 企业开发实践17-崩溃与日志
date: 2026-05-18
tags:
  - Flutter
  - 崩溃监控
  - 日志体系
  - Crashlytics
  - Sentry
  - runZonedGuarded
  - 企业级
---

# 崩溃与日志

## 先说清楚要解决什么

崩溃和日志是线上可观测性的两条腿。崩溃监控告诉你"什么时候挂了"，日志体系告诉你"挂之前发生了什么"。没有崩溃监控，你只能等用户来投诉；没有日志体系，崩溃日志摆在你面前，你也不知道出事前发生了什么。

做架构的时候绕不过这几个问题：**怎么把所有异常都捕获到？怎么分清 Dart 异常和原生崩溃？怎么设计一套日志体系，还不拖慢主线程？**

## Flutter 异常捕获

### Flutter 异常的三层结构

```
┌──────────────────────────────────────────┐
│  Framework 异常（布局溢出、类型错误等）     │  ← FlutterError.onError
├──────────────────────────────────────────┤
│  未处理 Dart 异常（含未 await 的 Future、  │  ← PlatformDispatcher.onError
│  平台回调里抛出的异常）                    │     （Flutter 3.3+）
├──────────────────────────────────────────┤
│  Platform 崩溃（原生层崩溃）               │  ← Crashlytics / Sentry Native
└──────────────────────────────────────────┘
```

**说白了**，这三层的捕获机制完全不同，缺任何一层就会冒出"幽灵崩溃"：用户明明遇到了，你这边什么都没有。中间那层还有个变化：**从 Flutter 3.3 起，根 Zone 里没处理的异步错误（包括没 await 的 Future 异常）会自动路由到 `PlatformDispatcher.instance.onError`**，`runZonedGuarded` 不再是必选项（那是 3.3 之前的老写法）。

### FlutterError.onError：接住 Framework 异常

Flutter Framework 内部的错误，像布局溢出、Widget 树异常这些，都会走 `FlutterError.onError` 回调报出来。

```dart
void main() {
  // 捕获 Framework 异常
  FlutterError.onError = (FlutterErrorDetails details) {
    // 开发阶段：继续打印到控制台
    FlutterError.presentError(details);

    // 生产环境：上报到崩溃监控
    CrashReportService.report(
      type: 'framework_error',
      message: details.exceptionAsString(),
      stackTrace: details.stack?.toString(),
      context: details.context?.toString(),
    );
  };

  runApp(const MyApp());
}
```

**常见的就这几类**：RenderBox 溢出、类型转换错误、Widget 树里的空指针。它们在 Debug 模式下会给你红屏，到了 Release 模式却被静默吞掉。你不主动接住，线上就完全看不到。

### PlatformDispatcher：接住没处理的 Dart 异常（含异步错误）

从 Flutter 3.3 起，`PlatformDispatcher.instance.onError` 就是官方推荐的全局错误处理入口，**它替代的是"用 `runZonedGuarded` 包住 runApp"那套老写法**。它接两类错误：平台回调里抛出来的异常（触摸、定时器、微任务这些），还有根 Zone 里没处理的异步错误（没 await 的 Future 异常）。

```dart
void main() {
  // 捕获所有未被 try-catch 处理的 Dart 异常（含异步）
  PlatformDispatcher.instance.onError = (error, stack) {
    CrashReportService.report(
      type: 'unhandled_dart_error',
      message: error.toString(),
      stackTrace: stack.toString(),
    );
    return true; // true = 已处理，不再传播
  };

  runApp(const MyApp());
}
```

### runZonedGuarded：现在还有什么场景用得着

Flutter 3.3 之前，没 await 的 Future 异常只有 `runZonedGuarded` 接得住，所以老代码全是"包住 runApp"的写法。**从 3.3 起，这类根 Zone 的错误统一路由到 `PlatformDispatcher.onError`，新项目不用再包 runApp 了**。现在还需要 `runZonedGuarded` 的场景就一个：你在自建的 Zone 里跑代码，想给这个 Zone 单独要一个错误处理边界，而不是全局的。自建 Zone 默认继承父 Zone 的错误处理器，你得显式包一层，它才能有自己的处理逻辑。

### 完整的异常捕获方案

```dart
void main() {
  // 1. 确保 WidgetsBinding 初始化
  WidgetsFlutterBinding.ensureInitialized();

  // 2. 捕获 Framework 异常（布局溢出、Widget 树错误等）
  FlutterError.onError = (details) {
    if (kReleaseMode) {
      CrashReportService.report(
        type: 'framework',
        message: details.exceptionAsString(),
        stackTrace: details.stack?.toString() ?? '',
      );
    } else {
      FlutterError.presentError(details);
    }
  };

  // 3. 接住剩下所有没处理的 Dart 异常，含没 await 的 Future 异常
  //    （Flutter 3.3+ 会路由到这里，不用再包 runZonedGuarded）
  PlatformDispatcher.instance.onError = (error, stack) {
    CrashReportService.report(
      type: 'unhandled',
      message: error.toString(),
      stackTrace: stack.toString(),
    );
    return true;
  };

  runApp(const MyApp());
}
```

**少一个会怎样？** 缺 `FlutterError.onError`，布局异常在 Release 模式下就不见了；缺 `PlatformDispatcher.onError`，没处理的同步/异步 Dart 错误就静默丢了。**这两个入口就是全部**。第三个"幽灵盲区"不在 Zone 里，在 Isolate：`Isolate.spawn` / `compute` 里抛的异常哪个入口都不进，得用 `Isolate.current.addErrorListener`，或者在子 Isolate 里单独包一层处理（见常见坑 1）。

## 原生崩溃捕获

### Dart 异常 vs 原生崩溃

| 维度 | Dart 异常 | 原生崩溃 |
|------|----------|---------|
| 发生层 | Dart VM | Android (ART) / iOS (Mach) |
| 捕获方式 | try-catch / Zone | 信号处理器 / 异常处理器 |
| 堆栈语言 | Dart | C++ / Java / Objective-C / Swift |
| 典型原因 | 空指针、类型错误、未处理的 Future | 内存越界、空引用、Native 插件 bug |
| App 会不会退出 | 一般不会退 | 一般马上退 |

**最大的区别在这**：Dart 异常能捕获、能恢复，App 接着跑；原生崩溃一般直接把进程干掉，你能做的只有把崩溃现场记下来。

### 崩溃监控选型：先想清楚用户在哪

选型先问一句（口径截至 2026-08）：**大陆设备访问 Firebase 的上报域名不稳定，所以 Crashlytics 只适合出海产品**。国内就两个落点：自建 Sentry（崩溃 + APM 一体，数据不出内网，企业首选），或者腾讯 Bugly（轻量、国内节点、免费）。下面先讲出海方向的 Crashlytics 怎么接，再讲国内首选的 Sentry。

#### 出海项目：Firebase Crashlytics

```yaml
# pubspec.yaml
dependencies:
  firebase_crashlytics: ^3.5.0
```

```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform, // flutterfire configure 生成
  );

  // 两大入口。注意别再用 runZonedGuarded 包 runApp，那会和
  // PlatformDispatcher.onError 重复上报同一条异常
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;

  PlatformDispatcher.instance.onError = (error, stack) {
    FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
    return true;
  };

  // 开关要在 runApp 之前设置，否则初始化期的崩溃不受控
  await FirebaseCrashlytics.instance.setCrashlyticsCollectionEnabled(
    !kDebugMode,
  );

  runApp(const MyApp());
}
```

#### 自定义键值对和用户信息

```dart
// 设置用户标识（崩溃报告中关联用户）
await FirebaseCrashlytics.instance.setUserIdentifier('user_12345');

// 自定义键值对（崩溃时的上下文信息）
await FirebaseCrashlytics.instance.setCustomKey('plan', 'premium');
await FirebaseCrashlytics.instance.setCustomKey('login_count', 42);

// 记录非致命异常
try {
  riskyOperation();
} catch (e, stack) {
  FirebaseCrashlytics.instance.recordError(e, stack, fatal: false);
}

// 记录面包屑（breadcrumbs）
FirebaseCrashlytics.instance.log('User opened product page: P-10086');
FirebaseCrashlytics.instance.log('Added to cart');
```

### 国内首选：Sentry（自建）

```yaml
# pubspec.yaml
dependencies:
  sentry_flutter: ^8.0.0
```

```dart
void main() async {
  await SentryFlutter.init(
    (options) {
      options.dsn = 'https://xxx@sentry.io/xxx';
      options.tracesSampleRate = 1.0; // 性能追踪采样率
      options.attachStacktrace = true;
      options.environment = kReleaseMode ? 'production' : 'development';
    },
    appRunner: () => runApp(const MyApp()),
  );
}

// 手动上报
try {
  await performPayment();
} catch (e, stack) {
  await Sentry.captureException(e, stackTrace: stack);
}

// 添加面包屑
Sentry.addBreadcrumb(Breadcrumb(
  message: 'User tapped checkout',
  category: 'ui',
  level: SentryLevel.info,
));

// 设置用户上下文
Sentry.configureScope((scope) {
  scope.setUser(User(id: '12345', email: 'user@example.com'));
  scope.setTag('subscription', 'premium');
});
```

### Crashlytics vs Sentry vs Bugly

| 维度 | Crashlytics | Sentry（自建） | Bugly |
|------|-------------|--------|------|
| 大陆可用性 | ❌ 上报域名不可达 | ✅ 自托管 | ✅ 国内节点 |
| 部署 | Firebase 生态，Google 托管 | 自建或云托管 | 腾讯云托管 |
| 合规 | 数据在 Google 服务器 | 可选自建，合规灵活 | 国内节点 |
| 性能监控 | 需搭配 Firebase Performance | 内置 APM | 卡顿/ANR 为主，能力有限 |
| 崩溃分组 | 自动 | 自动 + 可自定义 | 自动 |
| 原生崩溃 | 支持 | 支持 | 支持 |
| 价格 | 免费额度大 | 自建机器成本 / 云版额度有限 | 免费 |
| 推荐场景 | 出海且已用 Firebase | 企业首选、有合规要求 | 国内轻量快速接入 |

## 日志体系设计

### 为什么不用 `print()`？

- `print()` 在 Release 模式下可能被优化掉
- 无法分级（无法区分 debug/info/warning/error）
- 无法持久化（App 重启后日志丢失）
- 无法上报（线上问题无法回溯）
- 无法结构化查询

### 分级设计

```dart
enum LogLevel {
  debug,   // 开发调试信息，Release 模式不输出
  info,    // 关键业务节点（用户登录、页面切换）
  warning, // 可恢复的异常（网络超时重试）
  error,   // 不可恢复的异常（支付失败、数据损坏）
  fatal;   // 导致功能完全不可用的严重错误

  bool get shouldPersist => index >= LogLevel.info.index;
  bool get shouldReport => index >= LogLevel.warning.index;
}
```

**分级原则**：
- `debug`：只给开发者看，Release 模式不输出、不持久化、不上报
- `info`：关键业务节点，持久化到本地，不上报
- `warning`：可恢复异常，持久化 + 批量上报
- `error`/`fatal`：不可恢复异常，持久化 + 立即上报

### 格式化

```dart
class LogEntry {
  final LogLevel level;
  final String message;
  final String? tag;
  final String? stackTrace;
  final Map<String, dynamic>? context;
  final DateTime timestamp;
  final String sessionId;
  final String userId;
  final String appVersion;

  LogEntry({
    required this.level,
    required this.message,
    this.tag,
    this.stackTrace,
    this.context,
    DateTime? timestamp,
    required this.sessionId,
    required this.userId,
    required this.appVersion,
  }) : timestamp = timestamp ?? DateTime.now();

  // 结构化输出
  Map<String, dynamic> toJson() => {
        'level': level.name,
        'message': message,
        'tag': tag,
        'stack_trace': stackTrace,
        'context': context,
        'timestamp': timestamp.toIso8601String(),
        'session_id': sessionId,
        'user_id': userId,
        'app_version': appVersion,
      };

  // 控制台可读格式
  @override
  String toString() =>
      '[${timestamp.toIso8601String()}] [${level.name.toUpperCase()}] '
      '${tag != null ? '[$tag] ' : ''}$message'
      '${stackTrace != null ? '\n$stackTrace' : ''}';
}
```

### 持久化

```dart
class LogPersistence {
  final String _logDir;
  final int _maxLogFiles;
  final int _maxFileSizeBytes;

  LogPersistence({
    required String logDir,
    int maxLogFiles = 10,
    int maxFileSizeBytes = 1024 * 1024, // 1MB per file
  })  : _logDir = logDir,
        _maxLogFiles = maxLogFiles,
        _maxFileSizeBytes = maxFileSizeBytes;

  Future<void> write(LogEntry entry) async {
    final file = await _currentLogFile;
    final json = jsonEncode(entry.toJson());

    // 检查文件大小，超限则滚动
    if (await file.length() > _maxFileSizeBytes) {
      await _rotateLogFiles();
    }

    await file.writeAsString('$json\n', mode: FileMode.append);
  }

  Future<File> get _currentLogFile async {
    final dir = Directory(_logDir);
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    return File('$_logDir/app_log_${_dateKey()}.jsonl');
  }

  String _dateKey() {
    final now = DateTime.now();
    return '${now.year}${now.month.toString().padLeft(2, '0')}${now.day.toString().padLeft(2, '0')}';
  }

  Future<void> _rotateLogFiles() async {
    final dir = Directory(_logDir);
    final files = await dir.list()
        .where((f) => f.path.endsWith('.jsonl'))
        .toList();

    if (files.length >= _maxLogFiles) {
      // 删除最旧的文件
      files.sort((a, b) => a.path.compareTo(b.path));
      await files.first.delete();
    }
  }

  // 读取指定日期范围的日志
  Future<List<LogEntry>> readLogs({
    DateTime? since,
    LogLevel? minLevel,
  }) async {
    final dir = Directory(_logDir);
    final entries = <LogEntry>[];

    await for (final file in dir.list()) {
      if (!file.path.endsWith('.jsonl')) continue;
      final lines = await File(file.path).readAsLines();
      for (final line in lines) {
        if (line.isEmpty) continue;
        try {
          final entry = LogEntry.fromJson(jsonDecode(line));
          if (since != null && entry.timestamp.isBefore(since)) continue;
          if (minLevel != null && entry.level.index < minLevel.index) continue;
          entries.add(entry);
        } catch (_) {
          // 跳过格式错误的行
        }
      }
    }

    return entries..sort((a, b) => a.timestamp.compareTo(b.timestamp));
  }
}
```

## 日志上报策略

### 为什么不能每条日志都立即上报？

- 网络请求有开销，上报太勤就是耗电耗流量
- 小请求一多，服务端压力也上来了
- 弱网下上报可能失败，日志就这么丢了
- 用户隐私：不能趁用户没察觉，频繁发网络请求

### 批量上报

```dart
class LogReporter {
  final LogPersistence _persistence;
  final HttpClient _httpClient;
  final _buffer = <LogEntry>[];
  Timer? _flushTimer;

  static const _batchSize = 50;
  static const _flushInterval = Duration(seconds: 30);

  void start() {
    _flushTimer = Timer.periodic(_flushInterval, (_) => flush());
  }

  void add(LogEntry entry) {
    _buffer.add(entry);

    // fatal 级别立即上报
    if (entry.level == LogLevel.fatal) {
      flush();
      return;
    }

    // 达到批量大小也触发上报
    if (_buffer.length >= _batchSize) {
      flush();
    }
  }

  Future<void> flush() async {
    if (_buffer.isEmpty) return;

    final batch = List<LogEntry>.from(_buffer);
    _buffer.clear();

    try {
      // 压缩后上报
      final json = jsonEncode(batch.map((e) => e.toJson()).toList());
      final compressed = gzip.encode(utf8.encode(json));

      await _httpClient.post(
        '/logs/batch',
        body: compressed,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
      );
    } catch (e) {
      // 上报失败，回写到 buffer + 持久化
      _buffer.addAll(batch);
      await _persistToOfflineCache(batch);
    }
  }

  Future<void> _persistToOfflineCache(List<LogEntry> entries) async {
    for (final entry in entries) {
      await _persistence.write(entry);
    }
  }

  // App 启动时重试离线缓存
  Future<void> retryOfflineLogs() async {
    final offlineLogs = await _persistence.readLogs(
      since: DateTime.now().subtract(const Duration(days: 7)),
      minLevel: LogLevel.warning,
    );
    if (offlineLogs.isNotEmpty) {
      _buffer.addAll(offlineLogs);
      await flush();
    }
  }

  void stop() {
    _flushTimer?.cancel();
    flush();
  }
}
```

### 压缩策略

| 策略 | 压缩率 | CPU 开销 | 适用场景 |
|------|--------|---------|---------|
| gzip | ~80% | 中 | 通用方案 |
| 不压缩 | 0% | 无 | 日志量极小 |
| 采样 | ~90%+ | 无 | 高频日志（如性能指标） |

### 离线缓存

```dart
class OfflineLogCache {
  final LogPersistence _persistence;
  static const _maxCacheDays = 7;

  // 上报成功后清理已上报的日志
  Future<void> cleanReportedLogs(DateTime before) async {
    final dir = Directory(_persistence.logDir);
    await for (final file in dir.list()) {
      if (!file.path.endsWith('.jsonl')) continue;
      // 只保留最近 7 天的日志
      final stat = await file.stat();
      if (stat.modified.isBefore(
        DateTime.now().subtract(Duration(days: _maxCacheDays)),
      )) {
        await file.delete();
      }
    }
  }
}
```

### 隐私合规

```dart
class PrivacyLogFilter {
  static final _sensitivePatterns = [
    RegExp(r'\b\d{16,19}\b'),           // 银行卡号
    RegExp(r'\b1[3-9]\d{9}\b'),         // 手机号
    RegExp(r'\b[\w.]+@[\w.]+\.\w+\b'),  // 邮箱
    RegExp(r'token["\s:=]+[\w\-\.]+'),   // Token
  ];

  static String sanitize(String message) {
    var result = message;
    for (final pattern in _sensitivePatterns) {
      result = result.replaceAll(pattern, '***REDACTED***');
    }
    return result;
  }
}

// 在 LogReporter 中集成
void add(LogEntry entry) {
  final sanitized = LogEntry(
    level: entry.level,
    message: PrivacyLogFilter.sanitize(entry.message),
    tag: entry.tag,
    stackTrace: entry.stackTrace,
    context: entry.context?.map(
      (k, v) => MapEntry(k, v is String ? PrivacyLogFilter.sanitize(v) : v),
    ),
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    userId: entry.userId,
    appVersion: entry.appVersion,
  );
  _buffer.add(sanitized);
}
```

## 完整架构总览

```
App 内部
┌──────────────────────────────────────────────────────┐
│  异常捕获层                                           │
│  ├─ FlutterError.onError    → Framework 异常          │
│  ├─ PlatformDispatcher.onError → 其余未处理 Dart 异常 │
│  └─ Isolate addErrorListener → 子 Isolate 异常        │
├──────────────────────────────────────────────────────┤
│  日志记录层                                           │
│  ├─ Logger.log()           → 业务日志                 │
│  ├─ Logger.error()         → 错误日志                 │
│  └─ Breadcrumb.add()       → 面包屑                   │
├──────────────────────────────────────────────────────┤
│  存储与上报层                                         │
│  ├─ LogPersistence         → 本地 JSONL 文件          │
│  ├─ LogReporter            → 批量压缩上报              │
│  └─ CrashReportService     → Crashlytics / Sentry     │
├──────────────────────────────────────────────────────┤
│  原生崩溃捕获                                         │
│  ├─ [Android] Crashlytics NDK / Sentry Native         │
│  └─ [iOS] KSCrash / PLCrashReporter                  │
└──────────────────────────────────────────────────────┘
```

## 常见坑

### 1. 子 Isolate 的异常两个全局入口都收不到

```dart
// ❌ 以为全局钩子能兜住一切，可 Isolate.spawn 里的异常
//    不经过 FlutterError.onError，也不经过 PlatformDispatcher.onError
Isolate.spawn((_) {
  throw Exception('lost'); // 静默丢失，App 不崩、上报里也没有
}, null);

// ✅ 给子 Isolate 挂错误监听，转投到统一上报
final exit = ReceivePort();
final error = ReceivePort();
error.listen((msg) {
  CrashReportService.report(type: 'isolate', message: msg.toString());
});
await Isolate.spawn(entryPoint, null,
    onError: error.sendPort, onExit: exit.sendPort);
// compute() 同理：包一层 try-catch 把异常带回主 Isolate 再上报
```

`runZonedGuarded` 解决不了这个问题：它只管 Zone，不管 Isolate。

### 2. Crashlytics 初始化前崩溃无法捕获

```dart
// ❌ 初始化顺序错误
void main() {
  // 如果这里崩溃，Crashlytics 还没初始化，无法捕获
  someRiskyOperation();

  WidgetsFlutterBinding.ensureInitialized();
  Firebase.initializeApp();
  FirebaseCrashlytics.instance...;
}

// ✅ 最小化 main 中的代码，先初始化再做事
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  // 设置异常处理器
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
  // 然后才启动 App
  runApp(const MyApp());
}
```

### 3. 日志文件占满磁盘

持久化日志要是不加清理策略，跑久了可能把用户的磁盘占满。

**解法**：
- 限制日志文件数量（如最多 10 个文件）
- 限制单文件大小（如 1MB）
- 限制保留天数（如 7 天）
- App 启动时清理过期日志

### 4. 上报网络请求本身导致的崩溃

上报逻辑里要是抛了异常，结果就是死循环：异常 → 上报 → 上报失败 → 抛异常 → 上报...

```dart
// ✅ 上报逻辑用 try-catch 包裹，静默失败
Future<void> flush() async {
  try {
    await _httpClient.post('/logs/batch', body: compressed);
  } catch (e) {
    // 静默处理，不再上报这个上报失败
    _buffer.addAll(batch);
  }
}
```

### 5. Release 产物的符号化：split-debug-info ≠ 混淆

先把两个构建参数分清，它们对堆栈的影响不一样：

- `--split-debug-info=<dir>`：**剥离调试符号**（不混淆）。默认的 Release 构建本来就不混淆，可一旦剥离符号，线上堆栈里的 Dart 符号就变成 dwarf 偏移，得拿构建时留下的符号目录才能还原；
- `--obfuscate`：真正的**混淆**（必须和 `--split-debug-info` 一起用），堆栈里的标识符全变成 `aBc123` 这类短名。

```bash
# 构建（保留符号到本地目录，这个目录要归档！）
flutter build apk --release --split-debug-info=build/symbols --obfuscate

# 本地还原一条线上堆栈：flutter symbolize 是官方解码工具
flutter symbolize -d build/symbols/app.android-arm64.symbols -i stack.txt

# Sentry：上传调试信息文件
sentry-cli upload-dif -o org -p project ./build/symbols
```

**用 Crashlytics 还有一点要注意**：它不会"自动上传"你的 Dart 符号目录。`flutter build` 的时候留下了符号，不代表 Firebase 那边就有符号。CI 里得按 Firebase Flutter 官方文档的 flutterfire 上传命令把产物传上去（具体命令以官方文档为准），漏传的后果就是后台堆栈只剩地址和短名，定位不到代码行。

## 面试追问

 **Dart 异常和原生崩溃的区别？**

Dart 异常在 Dart VM 这一层，try-catch 或者全局错误处理入口都能接住，App 一般不会退。原生崩溃在 Android ART / iOS Mach 这层，靠信号处理器接，App 一般马上就退。Flutter 里这两层得同时设：Dart 层用 `FlutterError.onError`（Framework 异常）+ `PlatformDispatcher.onError`（其余没处理的异常，Flutter 3.3+ 含异步错误），原生层用 Crashlytics NDK / Sentry Native。再补一刀：子 Isolate 的异常两个入口都收不到，得单独挂 `addErrorListener`。

 **你的线上崩溃率是多少？怎么定义的？**

业界算法是：崩溃率 = 崩溃用户数 / 活跃用户数，目标 < 0.1%（千分之一），头部 App 的标准是 < 0.01%。还要分清"崩溃率"和"ANR 率"：ANR [Android] 不算崩溃，但影响体验。答的时候得把自己的统计口径说清楚，是按用户算还是按会话算。

 **日志上报怎么保证不丢？**

三层保障：(1) 批量 + 压缩上报，把网络失败的概率压下去；(2) 上报失败就回写到本地持久化，下次启动再重试；(3) fatal 级别日志立即上报，不走批量。还有一点，上报逻辑自己抛的异常不能再触发新的上报，否则就是无限循环，所以上报里的异常必须静默处理。

 **怎么设计一个合规的日志体系？**

合规上（GDPR / 个保法）要满足四条：(1) 敏感信息脱敏，银行卡号、手机号、邮箱、Token 在存储和上报之前都得换成占位符；(2) 用户能查询和删除自己的日志数据；(3) 日志保留期限要有上限（比如本地 7 天、服务端 90 天）；(4) 数据收集范围要明确告知用户。技术上就是在写入前统一过一遍 PrivacyLogFilter。

 **runZonedGuarded 的原理是什么？为什么它能捕获异步异常？**

Zone 是 Dart 的执行上下文隔离机制，概念上有点像线程局部存储。每个 Zone 可以有自己的一套错误处理函数。`runZonedGuarded` 做的就是创建一个新 Zone，再把错误处理函数注册进去。Future 里抛出没捕获的异常时，Dart VM 会顺着 Zone 链往上找，一直到找到一个注册了错误处理函数的 Zone。这就是 `runZonedGuarded` 能接住异步异常的原因：它在 Zone 这一层给错误传播设了个终点，跟"全局 try-catch"完全是两码事。

## 参考资源

- [Flutter 官方错误处理文档](https://docs.flutter.dev/testing/errors)
- [Firebase Crashlytics](https://firebase.google.com/docs/crashlytics)
- [Sentry Flutter SDK](https://pub.dev/packages/sentry_flutter)
- [Dart Zones 深度解析](https://dart.dev/articles/archive/zones)
- [Flutter 异常处理最佳实践](https://docs.flutter.dev/testing/errors)
