---
title: Flutter 企业开发实践18-崩溃与日志
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

## 概述

崩溃和日志是线上可观测性的两条腿。崩溃监控告诉你"什么时候挂了"，日志体系告诉你"挂之前发生了什么"。没有崩溃监控，你只能等用户投诉；没有日志体系，你面对崩溃日志时两眼一抹黑。

架构师的核心问题：**怎么捕获所有异常？怎么区分 Dart 异常和原生崩溃？怎么设计一个不会影响主线程性能的日志体系？**

## Flutter 异常捕获

### Flutter 异常的三层结构

```
┌──────────────────────────────────────────┐
│  Framework 异常（布局溢出、类型错误等）     │  ← FlutterError.onError
├──────────────────────────────────────────┤
│  Dart 异步异常（Future 抛出但未 await）    │  ← runZonedGuarded
├──────────────────────────────────────────┤
│  Platform 异常（原生层崩溃）               │  ← Crashlytics / Sentry Native
└──────────────────────────────────────────┘
```

**关键认知**：这三层异常的捕获机制完全不同，缺任何一层都会有"幽灵崩溃"——用户遇到了但你没捕获到。

### FlutterError.onError：捕获 Framework 异常

Flutter Framework 内部的错误（布局溢出、Widget 树异常等）会通过 `FlutterError.onError` 回调报告。

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

**典型场景**：RenderBox 溢出、类型转换错误、Widget 树中的空指针。这些在 Debug 模式下会显示红屏，但在 Release 模式下会被静默吞掉——如果不主动捕获，线上完全不可见。

### PlatformDispatcher：捕获未处理的 UI 异常

`PlatformDispatcher.instance.onError` 是 Flutter 3.x 推荐的全局错误处理器，替代了旧版的 `onError` 属性。

```dart
void main() {
  // 捕获 Platform 级别的未处理异常
  PlatformDispatcher.instance.onError = (error, stack) {
    CrashReportService.report(
      type: 'platform_error',
      message: error.toString(),
      stackTrace: stack.toString(),
    );
    return true; // true = 已处理，不再传播
  };

  runApp(const MyApp());
}
```

### runZonedGuarded：捕获异步错误

`FlutterError.onError` 和 `PlatformDispatcher.onError` 都无法捕获 `Future` 中未 await 的异常。这是 Dart 的设计：异步错误在独立的 Zone 中传播。

```dart
void main() {
  FlutterError.onError = (details) {
    // Framework 异常
  };

  PlatformDispatcher.instance.onError = (error, stack) {
    // Platform 异常
    return true;
  };

  // 用 runZonedGuarded 包裹 runApp，捕获所有异步异常
  runZonedGuarded(() {
    runApp(const MyApp());
  }, (error, stack) {
    // 异步未捕获异常
    CrashReportService.report(
      type: 'async_error',
      message: error.toString(),
      stackTrace: stack.toString(),
    );
  });
}
```

### 完整的异常捕获方案

```dart
void main() {
  // 1. 确保 WidgetsBinding 初始化
  WidgetsFlutterBinding.ensureInitialized();

  // 2. 捕获 Framework 异常
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

  // 3. 捕获 Platform 级未处理异常
  PlatformDispatcher.instance.onError = (error, stack) {
    CrashReportService.report(
      type: 'platform',
      message: error.toString(),
      stackTrace: stack.toString(),
    );
    return true;
  };

  // 4. 捕获异步未处理异常
  runZonedGuarded(() {
    runApp(const MyApp());
  }, (error, stack) {
    CrashReportService.report(
      type: 'async',
      message: error.toString(),
      stackTrace: stack.toString(),
    );
  });
}
```

**不这么做会怎样？** 缺少 `runZonedGuarded` → 异步错误静默丢失；缺少 `FlutterError.onError` → 布局异常在 Release 模式下不可见；缺少 `PlatformDispatcher.onError` → 部分 Platform 异常无法捕获。三层缺一不可。

## 原生崩溃捕获

### Dart 异常 vs 原生崩溃

| 维度 | Dart 异常 | 原生崩溃 |
|------|----------|---------|
| 发生层 | Dart VM | Android (ART) / iOS (Mach) |
| 捕获方式 | try-catch / Zone | 信号处理器 / 异常处理器 |
| 堆栈语言 | Dart | C++ / Java / Objective-C / Swift |
| 典型原因 | 空指针、类型错误、未处理的 Future | 内存越界、空引用、Native 插件 bug |
| App 是否退出 | 通常不退出 | 通常立即退出 |

**关键区别**：Dart 异常可以被捕获并恢复（App 继续运行），原生崩溃通常导致进程终止——你能做的只是记录崩溃现场。

### Firebase Crashlytics

```yaml
# pubspec.yaml
dependencies:
  firebase_crashlytics: ^3.5.0
```

```dart
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();

  // Crashlytics 初始化
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;

  PlatformDispatcher.instance.onError = (error, stack) {
    FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
    return true;
  };

  runZonedGuarded(() {
    runApp(const MyApp());
  }, (error, stack) {
    FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
  });

  // 开发阶段关闭自动上报
  await FirebaseCrashlytics.instance.setCrashlyticsCollectionEnabled(
    !kDebugMode,
  );
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

### Sentry

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

### Crashlytics vs Sentry

| 维度 | Crashlytics | Sentry |
|------|-------------|--------|
| 部署 | Firebase 生态，Google 托管 | 自建或云托管 |
| 合规 | 数据在 Google 服务器 | 可选自建，合规灵活 |
| 性能监控 | 无（需搭配 Firebase Performance） | 内置 APM |
| 崩溃分组 | 自动 | 自动 + 可自定义 |
| 原生崩溃 | 支持 | 支持 |
| 价格 | 免费额度大 | 免费额度有限 |
| 推荐场景 | 已用 Firebase 的项目 | 需要自建或 APM 一体化的项目 |

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

- 网络请求有开销，频繁上报耗电耗流量
- 大量小请求对服务端造成压力
- 弱网环境下可能上报失败导致日志丢失
- 用户隐私：不应在用户无感知时频繁发送网络请求

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
│  ├─ PlatformDispatcher      → Platform 异常           │
│  └─ runZonedGuarded         → 异步异常                │
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

## 常见坑与踩点

### 1. Zone 嵌套导致的异常丢失

```dart
// ❌ 在 runZonedGuarded 内又创建了新 Zone，异常在新 Zone 中传播
runZonedGuarded(() {
  runZoned(() {
    throw Exception('lost'); // 这个异常不会被外层 runZonedGuarded 捕获
  });
}, (error, stack) {
  // 捕获不到
});

// ✅ 避免嵌套 Zone，或确保所有 Zone 都设置了错误处理
```

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

持久化日志如果不加清理策略，长期运行后可能占满用户磁盘。

**解法**：
- 限制日志文件数量（如最多 10 个文件）
- 限制单文件大小（如 1MB）
- 限制保留天数（如 7 天）
- App 启动时清理过期日志

### 4. 上报网络请求本身导致的崩溃

如果上报逻辑中抛出异常，可能触发无限循环：异常 → 上报 → 上报失败 → 抛异常 → 上报...

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

### 5. Release 模式下的堆栈混淆

Flutter Release 模式使用 AOT 编译，Dart 堆栈中的符号可能被混淆。Crashlytics 和 Sentry 都提供了符号化（symbolication）工具，需要在 CI 中上传符号文件。

```bash
# Crashlytics: 自动上传（Flutter 3.x 集成后）
flutter build apk --split-debug-info=/<project-name>/symbols

# Sentry: 手动上传
sentry-cli upload-dif -o org -p project ./build/symbols
```

## 面试追问

 **Dart 异常和原生崩溃的区别？**

Dart 异常发生在 Dart VM 层，可以被 try-catch 或 Zone 捕获，App 通常不会退出。原生崩溃发生在 Android ART / iOS Mach 层，由信号处理器捕获，App 通常立即退出。Flutter 中需要同时设置两层捕获：Dart 层用 FlutterError.onError + runZonedGuarded，原生层用 Crashlytics NDK / Sentry Native。

 **你的线上崩溃率是多少？怎么定义的？**

业界标准：崩溃率 = 崩溃用户数 / 活跃用户数。目标：< 0.1%（千分之一）。头部 App 标准：< 0.01%。注意区分"崩溃率"和"ANR 率"——ANR [Android] 不算崩溃但影响体验。回答时要说清楚你的统计口径（按用户还是按会话）。

 **日志上报怎么保证不丢？**

三层保障：(1) 批量+压缩上报，减少网络失败概率；(2) 上报失败回写到本地持久化，下次启动时重试；(3) fatal 级别日志立即上报不走批量。同时注意上报逻辑的异常不能触发新的上报（防止无限循环），上报逻辑的异常必须静默处理。

 **怎么设计一个合规的日志体系？**

合规要求（GDPR / 个保法）：(1) 敏感信息脱敏——银行卡号、手机号、邮箱、Token 必须在存储和上报前替换为占位符；(2) 用户可查询和删除自己的日志数据；(3) 日志保留期限有上限（如 7 天本地、90 天服务端）；(4) 明确告知用户数据收集范围。技术上通过 PrivacyLogFilter 在写入前统一脱敏。

 **runZonedGuarded 的原理是什么？为什么它能捕获异步异常？**

Zone 是 Dart 的执行上下文隔离机制，类似于线程局部存储的概念。每个 Zone 可以有自己的错误处理函数。`runZonedGuarded` 创建一个新 Zone 并注册错误处理函数。当 Future 中抛出未捕获的异常时，Dart VM 会沿 Zone 链向上传播，直到找到注册了错误处理函数的 Zone。这就是为什么 `runZonedGuarded` 能捕获异步异常——它不是"全局 try-catch"，而是在 Zone 层面建立了错误传播的终点。

## 参考资源

- [Flutter 官方错误处理文档](https://docs.flutter.dev/testing/errors)
- [Firebase Crashlytics](https://firebase.google.com/docs/crashlytics)
- [Sentry Flutter SDK](https://pub.dev/packages/sentry_flutter)
- [Dart Zones 深度解析](https://dart.dev/articles/archive/zones)
- [Flutter 异常处理最佳实践](https://docs.flutter.dev/testing/errors)
