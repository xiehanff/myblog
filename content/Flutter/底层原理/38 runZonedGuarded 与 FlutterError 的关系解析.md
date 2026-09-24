# Flutter 错误处理最佳实践：FlutterError 与 PlatformDispatcher

基于官方文档（Handling errors in Flutter），当前推荐的全局错误处理入口是：

- `FlutterError.onError`：处理 **Flutter 框架内** 的同步错误（build/layout/paint）。
- `PlatformDispatcher.instance.onError`：处理 **未被 Flutter 捕获** 的错误——即主 isolate 中调用栈上没有 Flutter 回调的错误（异步回调、插件等）。

官方文档没有再推荐把 `runZonedGuarded` 作为主入口。它仍然是 Dart 的通用 Zone 机制，但在 Flutter 场景下应当 **优先使用上面两个官方入口**。

参考：<https://docs.flutter.dev/testing/errors>

---

## 1. 原生机制拆解（官方推荐链路）

### 1.1 FlutterError.onError
- 捕获 Flutter 框架回调中抛出的错误
- 覆盖范围：build/layout/paint，以及框架同步回调
- 官方建议在自定义处理时保留 `FlutterError.presentError`，便于控制台仍可输出信息

**内部链路**（源码：`packages/flutter/lib/src/foundation/assertions.dart`）：框架通过 `FlutterError.reportError(details)` 把错误路由到 `FlutterError.onError`；`onError` 的默认值就是 `presentError`，而 `presentError` 的默认值是 `dumpErrorToConsole`（用 `debugPrint` 输出到控制台，首次错误输出完整信息，之后只输出摘要 `Another exception was thrown: ...`）。在 IDE 中运行时，inspector 会覆盖 `presentError`，把错误同步到 IDE 控制台。

`FlutterError` 本身是"报告 Flutter 特有的断言失败和契约违反"的错误类型（官方 API 文档定位），`onError` 收到的是 `FlutterErrorDetails`（对错误的包装，含 `exception`、`stack`、`library`、`context` 等），而不是原始异常对象。

API 文档：<https://api.flutter.dev/flutter/foundation/FlutterError/onError.html>

### 1.2 PlatformDispatcher.instance.onError
- 捕获 **Flutter 没有回调栈的错误**（异步回调、插件）
- 回调签名是 `bool Function(Object error, StackTrace stack)`：返回 `true` 表示"已处理"；返回 `false` 则走平台默认的兜底行为（打印到 stderr）
- 只作用于**主 isolate（root isolate）**：子 isolate 的未捕获错误**不会**触发它，必须在子 isolate 上监听并手动转发回主 isolate
- 官方明确建议使用它作为“非 Flutter 错误”的统一入口

API 文档：<https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html>

### 1.3 ErrorWidget.builder
- build 阶段错误时，用自定义 UI 替代崩溃控件
- 官方示例中通过 `MaterialApp.builder` 注入
- 默认行为：debug 模式下显示红色错误信息，release 模式下只显示灰色背景
- 执行顺序上，build 出错时框架**先**调用 `FlutterError.onError` 上报，**再**调用 `ErrorWidget.builder` 生成替代 UI（两者通常收到同一个 `FlutterErrorDetails`）

API 文档：<https://api.flutter.dev/flutter/widgets/ErrorWidget/builder.html>

---

## 2. runZonedGuarded 的现状定位

`runZonedGuarded` 仍然是 Dart 的 Zone 工具，但在 Flutter app 的全局错误处理上 **不再是官方推荐路径**，原因：

- Flutter 已提供更明确、可维护的入口（`FlutterError.onError` + `PlatformDispatcher.onError`）。
- Zone 只能捕获 **Zone 内的 Future/微任务错误**，容易造成覆盖误判。
- 主 isolate 中不在 Flutter 回调栈上的错误由 `PlatformDispatcher.onError` 兜底；原生层（Kotlin/Swift/Objective-C）的崩溃则不经过 Dart，需要原生 SDK 或原生 handler 处理。

结论：**优先使用官方入口，runZonedGuarded 只在有明确 Zone 需求时作为补充。**

---

## 3. 官方最佳实践示例（推荐写法）

```dart
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details);
    _reportError(details.exception, details.stack ?? StackTrace.current);
  };

  PlatformDispatcher.instance.onError = (error, stack) {
    _reportError(error, stack);
    return true;
  };

  runApp(const MyApp());
}

void _reportError(Object error, StackTrace stack) {
  if (kDebugMode) {
    debugPrint('Error: $error');
    debugPrint('$stack');
  } else {
    // TODO: 上报错误到你的平台
  }
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      builder: (context, widget) {
        ErrorWidget.builder = (details) {
          return const Scaffold(
            body: Center(child: Text('发生错误')),
          );
        };
        return widget ?? const SizedBox.shrink();
      },
      home: const Scaffold(
        body: Center(child: Text('Home')),
      ),
    );
  }
}
```

---

## 4. 典型错误分类与入口对应

- **Flutter 框架错误**：`FlutterError.onError`
- **异步回调/插件错误（Dart 侧、主 isolate）**：`PlatformDispatcher.instance.onError`
- **build 阶段异常 UI**：`ErrorWidget.builder`

---

## 5. 迁移建议（从 runZonedGuarded 到官方推荐）

1. 删除全局 `runZonedGuarded` 包裹
2. 在 `main()` 中设置 `FlutterError.onError`
3. 设置 `PlatformDispatcher.instance.onError`
4. 如需自定义 UI，添加 `ErrorWidget.builder`
5. 仅在确实需要 Zone 上下文时，再保留 `runZonedGuarded` 作为补充

---

## 6. 注意事项

- `FlutterError.onError` 只覆盖框架同步回调
- `PlatformDispatcher.onError` 才是官方推荐的“非 Flutter 错误”入口，且只作用于主 isolate
- Isolate 内错误需要额外处理（`Isolate.current.addErrorListener`，错误以 `[error.toString(), 堆栈字符串]` 的二元 List 送达）

---

## 7. Zone 的依赖注入能力与仍具价值的场景

### 7.1 runZonedGuarded 的完整参数

`runZonedGuarded` 是 Dart Zone 机制的核心入口，签名如下（Dart SDK `lib/async/zone_api.dart`）：

```dart
R? runZonedGuarded<R>(
  R body(),
  void onError(Object error, StackTrace stack), {
  Map<Object?, Object?>? zoneValues,
  ZoneSpecification? zoneSpecification,
})
```

三个可选参数各有用途：

| 参数 | 作用 |
|------|------|
| `zoneValues` | Zone 级别的键值对数据，用于**依赖注入** |
| `zoneSpecification` | Zone 行为定制，可以拦截回调、定时器、print 等 |
| `onError`（位置参数） | Zone 内未捕获错误的回调 |

> 注意：`onError` 会收到 **两类错误**——`body()` 中同步抛出的错误，以及 Zone 内注册的异步回调（Future/微任务/Timer）中未捕获的错误。SDK 源码里前者是直接 try/catch 转发给 `onError`，后者是通过覆盖新 Zone 的 `handleUncaughtError` 实现。这也是 `runZonedGuarded` 与 `runZoned` 的核心区别：`runZoned` 不做这层捕获，body 的同步错误会正常向外抛。
>
> 因为 body 同步抛错时函数只能返回 `null`，所以返回类型是 `R?` 而不是 `R`。

官方背景资料（Zones 文章）：<https://dart.dev/articles/libraries/zones>

### 7.2 ZoneValues 依赖注入

`zoneValues` 允许你在 Zone 中存入键值对，子 Zone 和异步回调中可以通过 `Zone.current[key]` 获取，天然实现了**依赖注入容器**。

```dart
import 'dart:async';

// 定义依赖的 key（推荐用 private Symbol 避免冲突）
final _apiKey = Object();

void main() {
  runZonedGuarded(
    () async {
      // 在任意深度获取注入的服务
      final apiClient = Zone.current[_apiKey] as ApiClient;
      final logger = Zone.current[#logger] as Logger;

      await apiClient.fetchData();
      logger.info('数据加载完成');

      // 异步回调中同样可以获取
      Future.delayed(Duration(seconds: 1), () {
        final client = Zone.current[_apiKey] as ApiClient;
        client.refresh();
      });
    },
    (error, stack) {
      print('Zone 捕获错误: $error');
    },
    zoneValues: {
      _apiKey: ApiClient(baseUrl: 'https://api.example.com'),
      #logger: Logger(level: LogLevel.info),
    },
  );
}

class ApiClient {
  final String baseUrl;
  ApiClient({required this.baseUrl});

  Future<void> fetchData() async {
    print('请求 $baseUrl/data');
  }

  void refresh() {
    print('刷新数据');
  }
}

class Logger {
  final LogLevel level;
  Logger({required this.level});

  void info(String message) {
    print('[INFO] $message');
  }
}

enum LogLevel { debug, info, warn, error }
```

这套机制的行为有几个特点：

- `Zone.current[key]` 返回的是当前 Zone 及其父 Zone 链中找到的第一个值
- 子 Zone 可以**覆盖**父 Zone 的值（就近原则）
- 在 `async` 回调、`Future.then`、`Timer` 中都能正确获取到所在 Zone 的值

### 7.3 zoneSpecification 的自定义能力

`zoneSpecification` 可以拦截 Zone 内的几乎所有行为：

```dart
import 'dart:async';

void main() {
  final stopwatch = Stopwatch();

  runZoned(
    () {
      // 普通回调 —— 会被 registerCallback 拦截
      scheduleMicrotask(() {
        print('微任务执行完毕');
      });

      // print 输出 —— 会被拦截
      print('这是一条 print');

      // 定时器 —— 会被 createTimer 拦截
      Timer(Duration(seconds: 1), () {
        print('1 秒定时器触发');
      });
    },
    zoneValues: {_stopwatchKey: stopwatch},
    zoneSpecification: ZoneSpecification(
      // 拦截所有回调注册
      // 注意：registerCallback 的类型是泛型函数，必须显式写 <R>，否则无法通过类型推断
      registerCallback: <R>(self, parent, zone, callback) {
        print('[Zone] 注册回调');
        stopwatch.start();
        return parent.registerCallback(zone, () {
          final result = callback();
          stopwatch.stop();
          print('[Zone] 回调耗时: ${stopwatch.elapsedMilliseconds}ms');
          stopwatch.reset();
          return result;
        });
      },

      // 拦截一元回调（同样需要显式 <R, T>）
      registerUnaryCallback: <R, T>(self, parent, zone, callback) {
        print('[Zone] 注册一元回调');
        return parent.registerUnaryCallback(zone, callback);
      },

      // 拦截二元回调（同样需要显式 <R, T1, T2>）
      registerBinaryCallback: <R, T1, T2>(self, parent, zone, callback) {
        print('[Zone] 注册二元回调');
        return parent.registerBinaryCallback(zone, callback);
      },

      // 拦截微任务调度
      scheduleMicrotask: (self, parent, zone, callback) {
        print('[Zone] 调度微任务');
        return parent.scheduleMicrotask(zone, callback);
      },

      // 拦截一次性定时器
      createTimer: (self, parent, zone, duration, callback) {
        print('[Zone] 创建定时器: ${duration.inSeconds}s');
        return parent.createTimer(zone, duration, callback);
      },

      // 拦截周期性定时器
      createPeriodicTimer: (self, parent, zone, duration, callback) {
        print('[Zone] 创建周期定时器');
        return parent.createPeriodicTimer(zone, duration, callback);
      },

      // 拦截 print 输出
      print: (self, parent, zone, line) {
        parent.print(zone, '[拦截] $line');
      },

      // 拦截 fork 行为
      fork: (self, parent, zone, specification, zoneValues) {
        print('[Zone] fork 子 Zone');
        return parent.fork(zone, specification, zoneValues);
      },
    ),
  );
}

final _stopwatchKey = Object();
```

**运行输出**（Dart 3.11）：

```
[拦截] [Zone] 注册回调
[拦截] [Zone] 调度微任务
[拦截] [Zone] 注册回调
[拦截] 这是一条 print
[拦截] [Zone] 注册回调
[拦截] [Zone] 创建定时器: 1s
[拦截] [Zone] 注册回调
[拦截] 微任务执行完毕
[拦截] [Zone] 回调耗时: 1ms
[拦截] [Zone] 回调耗时: 0ms
[拦截] 1 秒定时器触发
[拦截] [Zone] 回调耗时: 0ms
[拦截] [Zone] 回调耗时: 0ms
```

这份输出里有三个细节：

- **所有输出都带 `[拦截]` 前缀**：ZoneSpecification 的处理函数本身也在该 Zone 的动态作用域内执行，其中的 `print` 同样会走 `print` 拦截器。
- **"注册回调"先于"调度微任务"/"创建定时器"出现**：`scheduleMicrotask` 和 `Timer` 的底层实现会先通过 `bindCallbackGuarded` 把回调绑定到当前 Zone（这一步触发 `registerCallback`），然后才走到我们自定义的 `scheduleMicrotask`/`createTimer` 拦截器。
- **每个回调触发了两次"注册回调"、两次"回调耗时"**：一次来自 `bindCallback` 的绑定层，一次来自根 Zone 调度层的再次注册，所以微任务和定时器各被包了两层。

### 7.4 runZonedGuarded 仍有价值的场景

即使官方推荐 `PlatformDispatcher.onError`，以下场景中 `runZonedGuarded` 仍然不可替代：

#### 场景一：需要依赖注入（zoneValues）

```dart
// 通过 Zone 实现无 Context 的服务获取
final _serviceKey = #serviceContainer;

T getService<T>() => Zone.current[_serviceKey] as T;

void main() {
  runZonedGuarded(
    () {
      // 关键：ensureInitialized 必须在 runZonedGuarded 内部调用。
      // Binding 初始化时会注册一系列平台回调（帧回调、平台消息等），
      // 这些回调注册在哪个 Zone，之后就在哪个 Zone 中执行。
      // 如果放在 runZonedGuarded 外面，framework 回调都挂在 root zone 上，
      // Zone 内异步回调的未捕获错误就不会进入下面这个 onError。
      WidgetsFlutterBinding.ensureInitialized();
      runApp(const MyApp());
    },
    (error, stack) => reportError(error, stack),
    zoneValues: {
      _serviceKey: ServiceContainer(
        apiClient: ApiClient(),
        authService: AuthService(),
      ),
    },
  );
}

// 在任意位置直接调用
class SomeWidget extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final api = getService<ServiceContainer>().apiClient;
    // ...
  }
}
```

#### 场景二：需要自定义 Zone 行为（zoneSpecification）

例如在测试环境中拦截所有 `print` 输出、在生产环境中给所有定时器加监控：

```dart
ZoneSpecification createProductionSpec() {
  return ZoneSpecification(
    print: (self, parent, zone, line) {
      // 生产环境 print 重定向到日志系统
      Logger.instance.log(line);
    },
    createTimer: (self, parent, zone, duration, callback) {
      // 监控定时器泄漏
      final timer = parent.createTimer(zone, duration, callback);
      TimerMonitor.instance.track(timer, duration);
      return timer;
    },
  );
}
```

#### 场景三：隔离错误处理区域（多层 Zone 嵌套）

```dart
void main() {
  runZonedGuarded(
    () {
      // 外层 Zone：全局错误处理
      runZonedGuarded(
        () {
          // 内层 Zone：特定模块的错误处理
          throw Exception('内层错误');
        },
        (error, stack) {
          print('内层 onError 捕获: $error'); // ① 先捕获
        },
      );
    },
    (error, stack) {
      print('外层 onError 捕获: $error'); // ② 不会被触发
    },
  );
}
// 输出：内层 onError 捕获: Exception: 内层错误
```

**嵌套规则**：内层 Zone 的 `onError` 优先捕获错误，外层 Zone 的 `onError` 不会收到该错误。只有当内层**不是错误 Zone**（比如用的是 `runZoned` 而非 `runZonedGuarded`，没有覆盖 `handleUncaughtError`），或内层 `onError` 自身**又抛出了新错误**时，错误才会传播到外层。

#### 场景四：在特定 Zone 中执行代码

```dart
late Zone workerZone;

void main() {
  workerZone = Zone.current.fork(
    zoneValues: {'tenantId': 'tenant-001'},
    specification: ZoneSpecification(
      registerCallback: <R>(self, parent, zone, callback) {
        return parent.registerCallback(zone, () {
          // 在执行前注入租户上下文
          final tenantId = Zone.current['tenantId'];
          print('[Tenant: $tenantId] 执行回调');
          return callback();
        });
      },
    ),
  );

  // 在特定 Zone 中执行代码
  workerZone.run(() {
    print('租户 ID: ${Zone.current['tenantId']}');
  });
}
```

---

## 8. 与 Sentry / Firebase Crashlytics 集成的完整代码示例

### 8.1 Sentry 集成

```dart
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  await SentryFlutter.init(
    (options) {
      options.dsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';
      options.tracesSampleRate = 1.0;
      options.profilesSampleRate = 1.0;

      // 配置环境信息
      options.environment = kReleaseMode ? 'production' : 'development';
      options.release = 'my-app@1.0.0';

      // 配置面包屑自动采集
      options.beforeSendBreadcrumb = (breadcrumb) {
        // 过滤敏感信息
        if (breadcrumb.category == 'http' &&
            breadcrumb.data?['url']?.toString().contains('/api/token') == true) {
          return null; // 不上报
        }
        return breadcrumb;
      };
    },
    appRunner: () => runApp(const MyApp()),
  );

  // === 全局错误处理 ===

  // 1. Flutter 框架错误 → Sentry
  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details);
    Sentry.captureException(
      details.exception,
      stackTrace: details.stack,
    );
  };

  // 2. 非 Flutter 错误（异步、插件、平台层） → Sentry
  PlatformDispatcher.instance.onError = (error, stack) {
    Sentry.captureException(error, stackTrace: stack);
    return true;
  };
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sentry Demo')),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              ElevatedButton(
                onPressed: () {
                  // 这个错误会被 FlutterError.onError 捕获
                  throw Exception('Flutter 框架错误');
                },
                child: const Text('触发 Flutter 错误'),
              ),
              ElevatedButton(
                onPressed: () async {
                  // 这个错误会被 PlatformDispatcher.onError 捕获
                  Future.delayed(Duration.zero, () {
                    throw Exception('异步错误');
                  });
                },
                child: const Text('触发异步错误'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

#### Sentry 上下文配置

在用户登录或关键操作时，设置用户信息和上下文：

```dart
class SentryHelper {
  /// 设置用户信息
  static void setUser({required String id, String? email, String? username}) {
    Sentry.configureScope((scope) {
      scope.user = SentryUser(
        id: id,
        email: email,
        username: username,
      );
    });
  }

  /// 清除用户信息（登出时调用）
  static void clearUser() {
    Sentry.configureScope((scope) {
      scope.user = null;
    });
  }

  /// 添加自定义 Tag
  static void setTag(String key, String value) {
    Sentry.configureScope((scope) {
      scope.setTag(key, value);
    });
  }

  /// 添加面包屑（记录用户操作路径）
  static void addBreadcrumb({
    required String message,
    required String category,
    Map<String, dynamic>? data,
  }) {
    Sentry.addBreadcrumb(
      Breadcrumb(
        message: message,
        category: category,
        data: data,
        type: 'default',
      ),
    );
  }

  /// 添加额外上下文（如设备信息、业务数据）
  static void setContext(String key, Map<String, dynamic> data) {
    Sentry.configureScope((scope) {
      scope.setContexts(key, data);
    });
  }
}

// 使用示例
void onUserLogin(User user) {
  SentryHelper.setUser(
    id: user.id,
    email: user.email,
    username: user.name,
  );
  SentryHelper.setTag('membership', user.membershipLevel);
  SentryHelper.addBreadcrumb(
    message: '用户登录',
    category: 'auth',
    data: {'method': 'password'},
  );
}
```

### 8.2 Firebase Crashlytics 集成

```dart
import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();

  // 始终启用 Crashlytics（包括 Debug 模式，便于测试）
  await FirebaseCrashlytics.instance.setCrashlyticsCollectionEnabled(true);

  // === 全局错误处理 ===

  // 1. Flutter 框架错误 → Crashlytics
  FlutterError.onError = (FlutterErrorDetails details) {
    FirebaseCrashlytics.instance.recordFlutterError(details);
  };

  // 2. 非 Flutter 错误 → Crashlytics
  PlatformDispatcher.instance.onError = (error, stack) {
    FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
    return true;
  };

  // 3. 在 Debug 模式下同时输出到控制台
  if (kDebugMode) {
    // Debug 模式下重写 onError：先在控制台输出完整错误，再上报 Crashlytics
    FlutterError.onError = (details) {
      FlutterError.dumpErrorToConsole(details);
      FirebaseCrashlytics.instance.recordFlutterError(details);
    };
  }

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Crashlytics Demo')),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              ElevatedButton(
                onPressed: () {
                  // Flutter 框架错误 → FlutterError.onError → Crashlytics
                  throw Exception('Flutter 框架错误');
                },
                child: const Text('触发 Flutter 错误'),
              ),
              ElevatedButton(
                onPressed: () {
                  // 非框架错误 → PlatformDispatcher.onError → Crashlytics
                  FirebaseCrashlytics.instance.log('用户点击了异步错误按钮');
                  Future.delayed(Duration.zero, () {
                    throw Exception('异步错误');
                  });
                },
                child: const Text('触发异步错误'),
              ),
              ElevatedButton(
                onPressed: () {
                  // 手动记录非致命错误（不会导致闪退）
                  FirebaseCrashlytics.instance.recordError(
                    Exception('手动记录的错误'),
                    StackTrace.current,
                    fatal: false,
                  );
                },
                child: const Text('记录非致命错误'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

#### Crashlytics 自定义键值对和日志

```dart
class CrashlyticsHelper {
  /// 设置自定义键值对（附加到错误报告）
  static Future<void> setCustomKey(String key, Object value) async {
    await FirebaseCrashlytics.instance.setCustomKey(key, value);
  }

  /// 记录日志（附加到下一次错误报告）
  static Future<void> log(String message) async {
    await FirebaseCrashlytics.instance.log(message);
  }

  /// 设置用户 ID
  static Future<void> setUserId(String id) async {
    await FirebaseCrashlytics.instance.setUserIdentifier(id);
  }

  /// 清除用户 ID（登出时调用）
  static Future<void> clearUserId() async {
    await FirebaseCrashlytics.instance.setUserIdentifier('');
  }

  /// 发送未处理的异常（手动触发，慎用）
  static Future<void> crash() async {
    await FirebaseCrashlytics.instance.crash();
  }
}

// 使用示例
void onUserLogin(User user) {
  CrashlyticsHelper.setUserId(user.id);
  CrashlyticsHelper.setCustomKey('membership', user.membershipLevel);
  CrashlyticsHelper.setCustomKey('login_method', 'password');
  CrashlyticsHelper.log('用户登录成功: ${user.email}');
}
```

### 8.3 同时使用 Sentry + Crashlytics

某些场景下需要同时接入两个平台（例如 Sentry 用于实时告警、Crashlytics 用于 Firebase 生态集成）：

```dart
// 错误分发器：同时上报到两个平台
class ErrorReporter {
  static Future<void> reportFlutterError(FlutterErrorDetails details) async {
    // Sentry
    Sentry.captureException(
      details.exception,
      stackTrace: details.stack,
    );
    // Crashlytics
    await FirebaseCrashlytics.instance.recordFlutterError(details);
  }

  static Future<bool> reportPlatformError(Object error, StackTrace stack) async {
    // Sentry
    Sentry.captureException(error, stackTrace: stack);
    // Crashlytics
    await FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
    return true;
  }
}

void setupErrorHandling() {
  FlutterError.onError = ErrorReporter.reportFlutterError;
  PlatformDispatcher.instance.onError = ErrorReporter.reportPlatformError;
}
```

### 8.4 平台特定错误

#### Android：Uncaught Exception

```dart
// 注意：PlatformDispatcher.onError 只覆盖主 isolate 中 Dart 侧的未处理错误。
// Android 原生层（Java/Kotlin）的 uncaught exception 不会传给 PlatformDispatcher.onError，
// 而是直接终止进程；Sentry/Crashlytics 的原生 SDK 会在这类崩溃发生时自行捕获上报。

// 如果需要在 Android 原生层做额外处理，
// 可以在 MainActivity.kt 中自定义：
// class MainActivity : FlutterActivity() {
//     override fun onCreate(savedInstanceState: Bundle?) {
//         val handler = Thread.UncaughtExceptionHandler { thread, throwable ->
//             // 自定义处理
//             defaultHandler.uncaughtException(thread, throwable)
//         }
//         Thread.setDefaultUncaughtExceptionHandler(handler)
//         super.onCreate(savedInstanceState)
//     }
// }
```

#### iOS：Signal Handler

```dart
// iOS 的 signal（如 SIGSEGV、SIGABRT）由 Crashlytics SDK 的原生层自动捕获
// Sentry 也通过原生 SDK 处理 signal
// Dart 层无需额外处理

// 如果需要在 Dart 层感知信号崩溃后的恢复，可以监听 App 生命周期：
class _MyAppState extends State<MyApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // App 从后台恢复，可能是因为崩溃后重启
      // 可以检查是否是崩溃恢复
      _checkIfCrashRecovery();
    }
  }

  Future<void> _checkIfCrashRecovery() async {
    final didCrash = await FirebaseCrashlytics.instance.didCrashOnPreviousExecution();
    if (didCrash) {
      print('上次运行因崩溃退出');
    }
  }
}
```

### 8.5 错误上报最佳实践

| 实践 | 说明 |
|------|------|
| **面包屑（Breadcrumbs）** | 记录用户操作路径，帮助复现问题 |
| **用户信息** | 设置 userId、email，方便定位问题用户 |
| **自定义 Tag** | 标记业务维度（版本、环境、功能模块） |
| **自定义上下文** | 附加业务数据（订单 ID、页面名称） |
| **日志（Log）** | 在关键节点记录日志，附加到下一次崩溃报告 |
| **非致命错误** | 用 `fatal: false` / `recordError` 区分致命和非致命 |
| **Source Map** | 上传 obfuscated 的 source map，还原混淆后的堆栈 |

---

## 9. compute() / Isolate.spawn 的跨 Isolate 错误处理

### 9.1 Isolate.spawn 的错误处理

`Isolate.spawn` 创建新的 Isolate，新 Isolate 有**独立的 Zone 和错误处理**，不会继承主 Isolate 的错误处理器。

```dart
import 'dart:async';
import 'dart:isolate';

void main() {
  print('[主 Isolate] 启动');

  // 创建 ReceivePort 接收子 Isolate 的消息
  final mainReceivePort = ReceivePort();
  mainReceivePort.listen((message) {
    if (message == 'done') {
      print('[主 Isolate] 子 Isolate 正常完成');
    }
  }, onError: (error) {
    print('[主 Isolate] ReceivePort 收到错误: $error');
  });

  // 创建错误接收端口
  final errorPort = ReceivePort();
  errorPort.listen((error) {
    print('[主 Isolate] 子 Isolate 错误: $error');
  });

  // 创建退出接收端口
  final exitPort = ReceivePort();
  exitPort.listen((exitMessage) {
    print('[主 Isolate] 子 Isolate 退出，退出码: $exitMessage');
    mainReceivePort.close();
    errorPort.close();
    exitPort.close();
  });

  Isolate.spawn(
    _workerEntryPoint,
    mainReceivePort.sendPort,
    onError: errorPort.sendPort,       // 错误发送端口
    onExit: exitPort.sendPort,         // 退出通知端口
    errorsAreFatal: false,             // 错误不致命，不会终止子 Isolate
  );
}

/// 子 Isolate 的入口函数
void _workerEntryPoint(SendPort mainSendPort) {
  print('[子 Isolate] 启动');

  // 模拟正常工作
  mainSendPort.send('done');

  // 模拟已捕获的错误 —— 已捕获的错误不会走 onError 端口，
  // 想告诉主 Isolate 只能自己手动 send（SendPort 只有 send() 一个发送方法）
  try {
    throw Exception('子 Isolate 中的错误');
  } catch (e, stack) {
    // 同一个 isolate group 内可以直接发送对象（发送时会被拷贝）
    mainSendPort.send([e, stack]);
  }

  print('[子 Isolate] 继续执行（因为 errorsAreFatal: false）');
}
```

**`Isolate.spawn` 关键参数说明**：

| 参数 | 说明 |
|------|------|
| `onError` | 子 Isolate 中**未捕获**错误的发送目标 `SendPort`，收到的是 `[error.toString(), 堆栈字符串或 null]` 的二元 List（两个元素都是 String） |
| `onExit` | 子 Isolate 退出时发送消息的 `SendPort`（默认消息为 null） |
| `errorsAreFatal` | `true`（默认）：错误导致子 Isolate 终止；`false`：错误通过 `onError` 发送，子 Isolate 继续 |

### 9.2 compute() 的错误处理

`compute()` 是 Flutter 对 Isolate 的简化封装，自动处理 Isolate 的创建和通信。如果计算函数抛出异常，异常会被传递到调用方。

```dart
import 'dart:isolate';
import 'package:flutter/foundation.dart';

void main() {
  testComputeSuccess();
  testComputeFailure();
}

/// compute() 正常执行
Future<void> testComputeSuccess() async {
  try {
    final result = await compute<int, int>(_heavyComputation, 100);
    print('计算结果: $result'); // 输出：计算结果: 5050
  } catch (e, stack) {
    print('不会走到这里');
  }
}

/// compute() 异常处理
Future<void> testComputeFailure() async {
  try {
    // compute<Q, R>：Q 是参数类型，R 是返回类型
    final result = await compute<int, int>(_riskyComputation, -1);
    print('不会走到这里: $result');
  } catch (e, stack) {
    print('捕获到 compute 异常: $e');
    print('堆栈:\n$stack');
  }
}

/// 普通计算函数
int _heavyComputation(int n) {
  return List.generate(n, (i) => i + 1).fold(0, (a, b) => a + b);
}

/// 可能抛出异常的计算函数
int _riskyComputation(int value) {
  if (value < 0) {
    throw ArgumentError('输入值不能为负数: $value');
  }
  return value * 2;
}
```

**`compute()` 的局限性**：

| 局限 | 说明 |
|------|------|
| 单参数 | 只能传入一个参数，多参数需用 Record 或自定义类 |
| 单次返回 | 只能返回一个结果，无法持续通信 |
| 无双向通信 | 主 Isolate 无法在计算过程中发送消息给子 Isolate |
| Isolate 复用 | 每次调用创建新 Isolate，频繁调用有开销 |

多参数的 workaround：

```dart
// 方法一：用 Record（Dart 3.0+）
final result = await compute(_process, (userId: '123', page: 1));

int _process(({String userId, int page}) params) {
  // ...
  return 0;
}

// 方法二：用自定义类
final result = await compute(_process, TaskParams(userId: '123', page: 1));

class TaskParams {
  final String userId;
  final int page;
  const TaskParams({required this.userId, required this.page});
}

int _process(TaskParams params) {
  // ...
  return 0;
}
```

### 9.3 Isolate 间的错误传递机制

#### 手动发送错误（SendPort.send）

```dart
import 'dart:async';
import 'dart:isolate';

void main() async {
  final mainReceivePort = ReceivePort();
  final errorPort = ReceivePort();

  // 监听错误端口
  errorPort.listen(
    (errorPair) {
      // 本例中 errorPair 来自 _isolateEntryPoint 的手动 send，是 [error, stackTrace] 对象列表；
      // 注意区分：如果是 Isolate.spawn(onError:) 自动转发的未捕获错误，
      // 收到的则是 [error.toString(), 堆栈字符串或 null]，两个元素都是 String
      final error = (errorPair as List).first;
      final stack = (errorPair as List).last;
      print('[主 Isolate] 收到错误: $error');
      print('[主 Isolate] 堆栈: $stack');
    },
  );

  final exitPort = ReceivePort();
  exitPort.listen((_) {
    mainReceivePort.close();
    errorPort.close();
    exitPort.close();
    print('[主 Isolate] 清理完成');
  });

  Isolate.spawn(
    _isolateEntryPoint,
    _IsolateMessage(sendPort: mainReceivePort.sendPort, errorPort: errorPort.sendPort),
    onError: errorPort.sendPort,
    onExit: exitPort.sendPort,
    errorsAreFatal: false,
  );
}

void _isolateEntryPoint(_IsolateMessage message) {
  try {
    // 模拟业务逻辑
    throw StateError('业务校验失败：用户数据不完整');
  } catch (e, stack) {
    // 手动通过错误端口发送
    message.errorPort.send([e, stack]);
  }
}

class _IsolateMessage {
  final SendPort sendPort;
  final SendPort errorPort;
  const _IsolateMessage({required this.sendPort, required this.errorPort});
}
```

#### ReceivePort.onError

```dart
void main() {
  final receivePort = ReceivePort();

  // onError 接收子 Isolate 通过 onError 端口发送的错误
  receivePort.listen(
    (message) => print('收到消息: $message'),
    onError: (error) => print('端口错误: $error'),
    onDone: () => print('端口关闭'),
  );

  // 注意：receivePort.listen 的 onError 和 Isolate.spawn 的 onError 是不同的
  // receivePort.listen 的 onError 捕获的是端口自身的错误
  // Isolate.spawn 的 onError 捕获的是子 Isolate 中未捕获的异常
}
```

#### 可序列化的错误对象

Isolate 间能传什么对象，取决于两个 Isolate 是否共享同一份代码（同一 isolate group）：

- **`Isolate.spawn`（同组，也是 `compute` 的方式）**：几乎任何对象都能发送（`Exception`、`StackTrace`、自定义异常、闭包都可以），发送时会被**拷贝**。真正不能发的是携带原生资源的对象：`Socket`、`ReceivePort`、`DynamicLibrary`、`Finalizer` 等。
- **`Isolate.spawnUri`（不同组）**：只能发基本类型及其容器——`null`、`bool`、`int`、`double`、`String`、由它们组成的 List/Map/Set、`SendPort`、`TransferableTypedData` 等。自定义异常对象发不过去，需要先 `toString()` 转成字符串。

```dart
// ✅ 同组（Isolate.spawn/compute）—— 对象直接发送（拷贝）
throw Exception('简单错误');
throw StateError('状态错误');

class BusinessException implements Exception {
  final String code;
  final String message;
  BusinessException({required this.code, required this.message});

  @override
  String toString() => 'BusinessException($code): $message';
}

// ❌ 任何场景都不可发送 —— 携带原生资源的字段
class BadException implements Exception {
  final Socket socket; // Socket 内部持有原生资源，不可跨 Isolate
  BadException(this.socket);
}
```

### 9.4 多 Isolate 错误汇总上报

在实际项目中可能有多个 Isolate 同时工作，需要一个统一的错误收集机制：

```dart
import 'dart:async';
import 'dart:isolate';

/// 多 Isolate 错误汇总管理器
class IsolateErrorManager {
  final List<_IsolateErrorRecord> _errors = [];
  final Map<int, SendPort> _activeIsolates = {};
  int _isolateCounter = 0;

  /// 创建并启动一个受管理的 Isolate
  Future<int> spawnIsolate(
    void Function(SendPort) entryPoint, {
    String? name,
  }) async {
    final id = _isolateCounter++;
    final mainPort = ReceivePort();
    final errorPort = ReceivePort();
    final exitPort = ReceivePort();

    // 收集子 Isolate 的 SendPort（用于双向通信）
    final completer = Completer<SendPort>();
    mainPort.listen((message) {
      if (message is SendPort && !completer.isCompleted) {
        completer.complete(message);
      }
    });

    // 监听错误（spawn 的 onError 自动转发，errorPair 是 [error字符串, 堆栈字符串]）
    errorPort.listen((errorPair) {
      final error = (errorPair as List).first;
      final stack = (errorPair as List).last;
      _errors.add(_IsolateErrorRecord(
        isolateId: id,
        isolateName: name ?? 'Isolate-$id',
        error: error,
        stackTrace: stack,
        timestamp: DateTime.now(),
      ));
      _onError?.call(_errors.last);
    });

    // 监听退出
    exitPort.listen((_) {
      _activeIsolates.remove(id);
      print('[Manager] Isolate-$id 已退出');
      if (_activeIsolates.isEmpty) {
        mainPort.close();
        errorPort.close();
        exitPort.close();
        _onAllExited?.call();
      }
    });

    final isolate = await Isolate.spawn(
      entryPoint,
      mainPort.sendPort,
      onError: errorPort.sendPort,
      onExit: exitPort.sendPort,
      errorsAreFatal: false,
    );

    final childSendPort = await completer.future;
    _activeIsolates[id] = childSendPort;
    print('[Manager] Isolate-$id ($name) 已启动');
    return id;
  }

  /// 错误回调
  void Function(_IsolateErrorRecord record)? _onError;
  void onError(void Function(_IsolateErrorRecord record) callback) {
    _onError = callback;
  }

  /// 所有 Isolate 退出回调
  void Function()? _onAllExited;
  void onAllExited(void Function() callback) {
    _onAllExited = callback;
  }

  /// 获取所有错误记录
  List<_IsolateErrorRecord> get errors => List.unmodifiable(_errors);

  /// 上报所有错误
  void reportAll() {
    for (final record in _errors) {
      print('[上报] ${record.isolateName}: ${record.error}');
      // 上报到 Sentry / Crashlytics
      // Sentry.captureException(record.error, stackTrace: record.stackTrace);
    }
  }
}

class _IsolateErrorRecord {
  final int isolateId;
  final String isolateName;
  final Object error;
  final Object stackTrace;
  final DateTime timestamp;

  _IsolateErrorRecord({
    required this.isolateId,
    required this.isolateName,
    required this.error,
    required this.stackTrace,
    required this.timestamp,
  });
}
```

使用示例：

```dart
void main() async {
  final manager = IsolateErrorManager();

  manager.onError((record) {
    print('[实时] ${record.isolateName} 发生错误: ${record.error}');
  });

  // 启动多个 Isolate
  await manager.spawnIsolate(
    _worker1,
    name: '数据加载',
  );
  await manager.spawnIsolate(
    _worker2,
    name: '图片处理',
  );

  // 所有 Isolate 退出后汇总上报
  manager.onAllExited(() {
    print('所有 Isolate 完成，共 ${manager.errors.length} 个错误');
    manager.reportAll();
  });
}

void _worker1(SendPort mainSendPort) {
  // 发送自己的 SendPort 给主 Isolate
  final receivePort = ReceivePort();
  mainSendPort.send(receivePort.sendPort);

  // 模拟工作
  throw Exception('数据加载超时');
}

void _worker2(SendPort mainSendPort) {
  final receivePort = ReceivePort();
  mainSendPort.send(receivePort.sendPort);

  // 模拟正常工作，不抛出错误
  print('图片处理完成');
}
```

### 9.5 Isolate 死亡的处理

#### Isolate.addOnExitListener()

`addOnExitListener` 是 **Isolate 实例方法**（没有对应的静态方法），最直接的方式还是在 `Isolate.spawn` 时传 `onExit` 参数：

```dart
void main() {
  final exitPort = ReceivePort();

  Isolate.spawn(
    _worker,
    null,
    onExit: exitPort.sendPort,
    errorsAreFatal: true,
  );

  exitPort.listen((message) {
    // message 是 onExit 通知附带的响应值（默认为 null）
    print('子 Isolate 已退出');
    exitPort.close();
  });
}

void _worker(_) {
  print('工作完成');
}
```

也可以在拿到 Isolate 实例后再补挂监听（`addOnExitListener` 的可选参数 `response` 会作为退出消息发出）：

```dart
void mainAlt() async {
  final exitPort = ReceivePort();

  final isolate = await Isolate.spawn(_worker, null, errorsAreFatal: true);
  isolate.addOnExitListener(exitPort.sendPort, response: 'worker-exited');

  exitPort.listen((message) {
    print('子 Isolate 已退出: $message'); // 输出：worker-exited
    exitPort.close();
  });
}
```

> 注意：Isolate 是并发运行的，事后补挂监听有可能赶不上——子 Isolate 可能在监听建立前就退出了。要可靠监听，用 spawn 的 `onExit` 参数，或者下面 `setErrorsFatal` 示例中"先 paused 再恢复"的方式。

#### Isolate.setErrorsFatal()

控制错误是否致命，最可靠的方式是 spawn 的 `errorsAreFatal` 参数。运行期动态修改要用实例方法 `isolate.setErrorsFatal()`，但它要求持有该 Isolate 的 `terminateCapability`。`Isolate.spawn` 返回的实例**无论是否传 `paused: true`，都带有 `pauseCapability` 和 `terminateCapability`**；`paused: true` 的真正作用是让子 Isolate 在你完成 `setErrorsFatal`、`addErrorListener` 这类控制调用之前不开始运行——官方文档提醒：不以 paused 状态启动时，子 Isolate 可能在这些方法生效前就已经退出：

```dart
void main() async {
  final errorPort = ReceivePort();
  final exitPort = ReceivePort();

  // 1. 先以 paused 状态启动：确保控制调用（setErrorsFatal 等）生效前子 Isolate 不会运行或退出
  final isolate = await Isolate.spawn(
    _worker,
    null,
    paused: true,
    errorsAreFatal: true,
  );

  // 2. 挂好错误与退出监听（实例方法），再切换错误为非致命
  errorPort.listen((errorPair) {
    // 未捕获错误以 [error.toString(), 堆栈字符串或 null] 送达
    print('未捕获错误: ${(errorPair as List)[0]}');
    errorPort.close();
  });
  exitPort.listen((_) {
    print('子 Isolate 已退出');
    exitPort.close();
  });
  isolate.addErrorListener(errorPort.sendPort);
  isolate.setErrorsFatal(false);

  // 3. 恢复执行
  isolate.resume(isolate.pauseCapability!);
}

void _worker(_) {
  // 现在抛出错误只会发到 errorPort，不会终止子 Isolate
  throw Exception('非致命错误');
}
```

### 9.6 错误处理架构总结

```
┌─────────────────────────────────────────────────┐
│                  主 Isolate                       │
│                                                   │
│  ┌─────────────────────────────────────────┐     │
│  │ PlatformDispatcher.instance.onError     │     │
│  │   ← 捕获非 Flutter 错误                  │     │
│  └──────────────┬──────────────────────────┘     │
│                 │                                  │
│  ┌──────────────▼──────────────────────────┐     │
│  │ FlutterError.onError                     │     │
│  │   ← 捕获 Flutter 框架错误                │     │
│  └──────────────┬──────────────────────────┘     │
│                 │                                  │
│  ┌──────────────▼──────────────────────────┐     │
│  │ runZonedGuarded (onError)                │     │
│  │   ← Zone 内异步错误（补充）               │     │
│  │   ← 依赖注入、自定义 Zone 行为            │     │
│  └─────────────────────────────────────────┘     │
│                                                   │
│  ┌─────────────────────────────────────────┐     │
│  │ Isolate.spawn (onError: SendPort)        │     │
│  │   ← 子 Isolate 的未捕获错误              │     │
│  │ Isolate.spawn (onExit: SendPort)         │     │
│  │   ← 子 Isolate 退出通知                  │     │
│  └─────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘

┌──────────────────┐   ┌──────────────────┐
│   子 Isolate A   │   │   子 Isolate B   │
│                  │   │                  │
│  独立的 Zone     │   │  独立的 Zone     │
│  独立的错误处理  │   │  独立的错误处理  │
│                  │   │                  │
│  错误通过        │   │  错误通过        │
│  SendPort 传递   │   │  SendPort 传递   │
│  到主 Isolate    │   │  到主 Isolate    │
└──────────────────┘   └──────────────────┘
```

**核心原则**：

- 每个 Isolate 有独立的 Zone，错误处理互不干扰
- 子 Isolate 的错误**不会自动传播**到主 Isolate，必须通过 `SendPort` 手动传递
- `compute()` 封装了这一机制，异常会自动传递到调用方的 `Future`
- 全局错误上报（Sentry / Crashlytics）需要在主 Isolate 中设置，子 Isolate 的错误需要先传回主 Isolate 再上报

---

这版内容与官方文档保持一致：**以 FlutterError + PlatformDispatcher 为主，runZonedGuarded 仅作为补充，不再作为推荐主入口**。
