---
title: Flutter 企业开发实践02-技术选型决策
date: 2026-05-18
tags:
  - Flutter
  - 技术选型
  - 状态管理
  - 企业级
  - 架构决策
---

# 技术选型决策

## 概述

技术选型不是"哪个库 Star 多就用哪个"，而是一个**约束条件下的最优化问题**：团队规模、项目周期、人员流动、已有技术债，都是约束。选错状态的代价不只是"换个库"，而是**改一遍所有页面的状态管理代码**——这足以让一个迭代延期一个月。

本文提供决策矩阵而非排名，因为"最好"取决于上下文。同时给出选型方法论，让你面对新选项时能自己评估。

---

## 一、状态管理选型

### 1.1 四大方案对比矩阵

| 维度 | GetX | Bloc | Riverpod | Provider |
|---|---|---|---|---|
| **学习成本** | 极低（5 分钟上手） | 中（需理解 Stream/Cubit） | 中高（编译时安全带来复杂度） | 低（入门级方案） |
| **样板代码量** | 最少 | 较多（Event/State/Bloc 三件套） | 中（注解+代码生成） | 少 |
| **可测试性** | 中（依赖 Get.find） | 好（纯 Stream，易 mock） | 好（Provider 覆盖机制） | 好 |
| **编译时安全** | ❌ 运行时才报错 | ✅ Event/State 类型安全 | ✅ 编译时检查最强 | ❌ 运行时 |
| **生态完整度** | 极高（路由/依赖注入/国际化） | 高（Bloc 库全家桶） | 中（核心库 + 插件） | 低（只管状态） |
| **适合团队** | 小团队/快速迭代 | 中大团队/金融类严谨场景 | 中大团队/追求类型安全 | 新手学习/极简项目 |
| **主要风险** | 全家桶耦合、隐式依赖 | 样板代码多影响效率 | 语法糖多、新人上手慢 | 功能弱、大型项目力不从心 |

### 1.2 选型决策树

```
团队 < 5 人 且 追求速度？
  ├─ 是 → GetX（但隔离业务层，保留未来迁移可能）
  └─ 否 → 需要强类型保障？
       ├─ 是 → Riverpod（编译时安全）
       └─ 否 → 团队熟悉 Stream？
            ├─ 是 → Bloc（Stream 生态天然契合）
            └─ 否 → GetX（门槛最低）
```

### 1.3 各方案的核心代码模式

**GetX**——Controller + 响应式变量：

```dart
class UserController extends GetxController {
  final user = Rxn<User>();
  final isLoading = false.obs;

  Future<void> loadUser() async {
    isLoading.value = true;
    user.value = await _repo.getUser();
    isLoading.value = false;
  }
}

// UI 侧
Obx(() => Text(controller.user.value?.name ?? ''))
```

**Bloc**——Event 驱动状态机：

```dart
sealed class UserEvent {}
class LoadUser extends UserEvent {}

sealed class UserState {}
class UserInitial extends UserState {}
class UserLoading extends UserState {}
class UserLoaded extends UserState {
  final User user;
  UserLoaded(this.user);
}

class UserBloc extends Bloc<UserEvent, UserState> {
  UserBloc(this._repo) : super(UserInitial()) {
    on<LoadUser>((event, emit) async {
      emit(UserLoading());
      final user = await _repo.getUser();
      emit(UserLoaded(user));
    });
  }
}
```

**Riverpod**——声明式 Provider：

```dart
@riverpod
Future<User> user(Ref ref) async {
  final repo = ref.watch(userRepositoryProvider);
  return repo.getUser();
}

// UI 侧
class UserPage extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(userProvider);
    return userAsync.when(
      data: (user) => Text(user.name),
      loading: () => CircularProgressIndicator(),
      error: (e, _) => Text('Error: $e'),
    );
  }
}
```

### 1.4 不选某个方案的真实理由

- **不选 Provider**：功能太弱，没有依赖自动销毁、没有代码生成、没有编译时安全。适合 5 页面 Demo，不适合企业级。
- **不选 Bloc 的场景**：你的团队一半人不懂 Stream，强行上 Bloc 会产出"假 Bloc"——在 Bloc 里写命令式代码，Event/State 只是个空壳。
- **不选 GetX 的场景**：你需要在编译时捕获所有状态管理 bug，而不是等到线上用户触发 crash 才发现 `Get.find<XxxController>()` 找不到实例。

### 1.5 迁移成本评估

| 从 → 到 | 代码改动量 | 风险 |
|---|---|---|
| Provider → Riverpod | 中（API 相似） | 低 |
| GetX → Bloc | 大（全部重写 Controller → Bloc） | 高 |
| Bloc → Riverpod | 中（概念可映射） | 中 |
| 任意 → GetX | 小（GetX 吞一切） | 低（但全家桶锁定） |

**降低迁移成本的唯一方法**：不管用哪个状态管理库，**业务逻辑都不写在 Controller/Bloc/Provider 里**，而是写在 UseCase 中。这样迁移只是换表现层的壳，业务层代码不动。

---

## 二、网络库选型

### 2.1 Dio vs http

| 维度 | Dio | http (package:http) |
|---|---|---|
| 拦截器 | ✅ 内置，支持请求/响应/错误拦截 | ❌ 无，需自己封装 |
| 超时控制 | ✅ 细粒度（连接/接收/发送） | ✅ 全局超时 |
| 请求取消 | ✅ CancelToken | ✅ AbortController（新版） |
| 文件上传/下载 | ✅ 流式+进度回调 | ⚠️ 需自行封装 |
| 代理/证书 | ✅ 支持自定义 HttpClient | ✅ 但 API 更底层 |
| 体积 | 较大 | 极轻量 |
| 维护方 | 中文社区活跃 | Dart 官方团队 |

### 2.2 企业级项目为什么选 Dio

核心原因不是"Dio 功能多"，而是**拦截器**。企业级网络层必须统一处理：

```dart
class AuthInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = TokenManager.instance.accessToken;
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    if (err.response?.statusCode == 401) {
      // Token 过期 → 刷新 → 重试
      _refreshAndRetry(err, handler);
    } else {
      handler.next(err);
    }
  }
}
```

一个拦截器解决鉴权，一个解决日志，一个解决错误映射。如果用 `http`，这些逻辑全部要手动注入到每个请求——不是不能做，是**维护成本和遗漏风险太高**。

### 2.3 拦截器链设计

```
Request → [日志] → [鉴权] → [加密] → [超时] → Network → Response
Response ← [日志] ← [错误映射] ← [解密] ← ← ← ← ← ← ← Network
```

**注意顺序**：日志拦截器放最外层（第一个进入、最后一个出来），这样才能记录完整的请求和响应。鉴权拦截器放在日志之后，这样日志中能看到鉴权前的原始请求。

### 2.4 错误处理的分层

```dart
// 数据层：将 DioException 转为领域异常
try {
  final response = await dio.get('/user/profile');
  return UserDto.fromJson(response.data);
} on DioException catch (e) {
  throw _mapDioException(e); // 转为 NetworkException / AuthException / ...
}

// 业务层：只处理领域异常
try {
  final user = await userRepo.getUser();
  return user;
} on AuthException {
  // Token 无效，触发登出
} on NetworkException {
  // 网络异常，返回缓存
}

// 表现层：只处理展示逻辑
onError: (error) => showErrorSnackBar(error.message)
```

**不要在 UI 层判断 `DioException.type`**——这意味着表现层知道了数据层的实现细节。

---

## 三、路由选型

### 3.1 三大方案对比

| 维度 | GoRouter | auto_route | GetX Router |
|---|---|---|---|
| 声明式路由 | ✅ 路径字符串 | ✅ 代码生成 | ✅ 路径字符串 |
| 深度链接 | ✅ 原生支持 | ✅ 原生支持 | ⚠️ 需额外配置 |
| 嵌套导航 | ✅ ShellRoute | ✅ NestedRouter | ⚠️ 有限支持 |
| 导航守卫 | ✅ Redirect | ✅ Guards | ✅ Middleware |
| 代码生成 | ❌ 手写路由表 | ✅ 自动生成 | ❌ 手写 |
| Web 支持 | ✅ 官方推荐 | ✅ 支持 | ❌ 不推荐 |
| 维护方 | Flutter 官方 | 社区（infiniteflow） | GetX 社区 |

### 3.2 决策建议

- **纯移动端 + 已用 GetX 全家桶**：用 GetX Router，不要为了"更正规"引入 GoRouter 增加学习成本
- **需要 Web 支持 + 深度链接**：GoRouter，Flutter 官方维护，API 稳定
- **50+ 路由的大型项目**：auto_route，代码生成避免手写路由表的遗漏

### 3.3 GoRouter 的导航守卫实践

```dart
GoRouter(
  redirect: (context, state) {
    final isLoggedIn = AuthService.instance.isLoggedIn;
    final isLoginRoute = state.matchedLocation == '/login';

    if (!isLoggedIn && !isLoginRoute) return '/login';
    if (isLoggedIn && isLoginRoute) return '/home';
    return null; // 不重定向
  },
  routes: [
    GoRoute(path: '/login', builder: (_, __) => LoginPage()),
    GoRoute(path: '/home', builder: (_, __) => HomePage()),
  ],
);
```

**坑**：GoRouter 的 `redirect` 在每次路由变化时都会执行。如果有耗时检查（如异步 Token 验证），要用 `refreshListenable` 配合状态变化触发重定向，不要在 redirect 里做异步操作。

---

## 四、本地存储选型

### 4.1 四大方案对比

| 维度 | SharedPreferences | Hive | Isar | Drift |
|---|---|---|---|---|
| 数据模型 | Key-Value | Key-Value + TypeAdapter | 对象数据库 | 关系型（SQLite） |
| 性能 | 中 | 快 | 极快 | 中 |
| 查询能力 | ❌ 只能按 key 取 | ⚠️ 有限过滤 | ✅ 索引查询 | ✅ 完整 SQL |
| 加密 | ❌ | ✅ AES-256 | ✅ 内置 | ⚠️ 需 SQLCipher |
| 关系支持 | ❌ | ❌ | ⚠️ Link 对象 | ✅ 外键/JOIN |
| 原生依赖 | ✅ 平台原生 | ✅ 纯 Dart | ⚠️ Rust FFI `[双端]` | ✅ SQLite 内置 |
| 适合场景 | 简单配置 | 中等复杂缓存 | 大量结构化数据 | 关系型业务数据 |

### 4.2 选型决策

```
只需要存 Token/主题等简单配置？ → SharedPreferences
需要存复杂对象但量不大（<1000 条）？ → Hive
需要高性能查询大量数据？ → Isar
数据之间有复杂关系？ → Drift
```

### 4.3 存储层的抽象

不管用哪个存储库，都要通过 Repository 接口隔离：

```dart
abstract class TokenStorage {
  Future<String?> getAccessToken();
  Future<void> saveAccessToken(String token);
  Future<void> clear();
}

// SharedPreferences 实现
class SharedPreferencesTokenStorage implements TokenStorage {
  static const _key = 'access_token';
  final SharedPreferences prefs;

  @override
  Future<String?> getAccessToken() async => prefs.getString(_key);
  @override
  Future<void> saveAccessToken(String token) async =>
      prefs.setString(_key, token);
  @override
  Future<void> clear() async => prefs.remove(_key);
}

// Hive 实现（可以随时切换）
class HiveTokenStorage implements TokenStorage {
  static const _boxName = 'auth';
  static const _key = 'access_token';

  @override
  Future<String?> getAccessToken() async {
    final box = await Hive.openBox(_boxName);
    return box.get(_key);
  }
  // ...
}
```

**为什么不能直接在代码里写 `prefs.getString('token')`**：换存储库时要全局搜索替换，而且 key 是魔法字符串，拼写错误只有运行时才会暴露。接口 + 常量类可以编译时检查。

---

## 五、选型方法论

### 5.1 评估框架：5 维度打分法

对每个候选方案，按以下维度打 1-5 分，加权求和：

| 维度 | 权重 | 评估标准 |
|---|---|---|
| **团队契合度** | 30% | 团队已有经验、学习曲线陡峭程度 |
| **生态成熟度** | 20% | Star 数、Issue 响应速度、Breaking Change 频率 |
| **可维护性** | 20% | 样板代码量、重构友好度、类型安全 |
| **性能** | 15% | 包体积、运行时开销、编译时间 |
| **可迁移性** | 15% | 替换成本、是否锁定生态 |

**团队契合度权重最高**——技术再好，团队不会用就是负债。一个团队能熟练驾驭的 GetX，远比大家勉强使用的 Riverpod 更有生产力。

### 5.2 避免"选型陷阱"

**陷阱 1：追逐最新**

Riverpod 2.0 刚出就立刻迁移，结果 API 不稳定，三个月后又改。**新库至少等 6 个月、确认 minor 版本 API 稳定后再上生产**。

**陷阱 2：Demo 驱动选型**

看了个 TodoMVC Demo 觉得"好简单"，上了生产发现：全局状态管理、错误恢复、代码拆分——Demo 里全没有。**选型前必须用真实场景的复杂度验证**。

**陷阱 3：全家桶锁定**

GetX 提供路由 + 状态管理 + 依赖注入 + 国际化，一旦用了就很难换掉其中一个。**每个关注点独立选型**，即使最终选的都是 GetX 的子模块，也要确保每个子模块可以独立替换。

### 5.3 渐进式迁移策略

1. **新页面用新方案**：不碰老代码，新需求用新选型的库实现
2. **适配器层过渡**：如果新旧方案需要通信，通过适配器桥接
3. **按模块替换**：一个 feature 一个 feature 地迁移，不要全量替换
4. **保留回滚窗口**：每个迁移阶段独立提交，出问题可以回滚到上一阶段

### 5.4 技术雷达：持续评估

每季度做一次技术雷达 review：

| 状态 | 含义 | 行动 |
|---|---|---|
| Adopt | 推荐在项目中使用 | 新项目默认选型 |
| Trial | 值得尝试，需验证 | 在非核心模块试水 |
| Assess | 有潜力但不确定 | 持续关注，PoC 验证 |
| Hold | 不推荐使用 | 新项目不用，老项目计划迁移 |

---

## 常见坑与踩点

### 1. 状态管理混用

项目里同时用 Provider + GetX + Bloc，三种状态管理共存。新人不知道该用哪个，同一个页面出现两种状态管理方式。**规定：一个项目只用一种状态管理方案**，迁移期可以共存，但必须在迁移完成后移除旧方案。

### 2. Dio 实例未单例化

每个 DataSource 都 `new Dio()` 创建新实例，导致拦截器、BaseOptions 不统一。**Dio 必须全局单例**，通过 DI 注入。

### 3. 路由硬编码字符串

`context.push('/order/detail')` 写在 10 个地方，改路径时漏改。**路由常量化**：

```dart
class AppRoutes {
  static const orderDetail = '/order/detail';
  static const userProfile = '/user/profile';
}
```

### 4. 本地存储存敏感数据明文

`prefs.setString('password', password)`——SharedPreferences 在 Android 上是 XML 明文存储，root 设备可直接读取。**敏感数据必须加密存储**（Hive 加密箱 / Isar 加密 / flutter_secure_storage）。

### 5. 选型讨论变成宗教战争

技术选型是工程决策，不是信仰。如果团队在两个方案间反复争论，用**限时 PoC** 决胜负：各花 2 天用两种方案实现同一个复杂页面，对比代码量和可维护性，用数据说话。

---

## 面试追问

### 🌱 为什么不推荐 Provider 做企业级状态管理？

Provider 本身没问题，但它只是"依赖注入 + 监听"的薄封装。企业级项目需要：响应式变量、自动销毁、导航集成、代码生成支持——这些 Provider 都没有。用 Provider 就像用锤子拧螺丝，能拧但效率低。

### 🌱 GetX 全家桶的风险具体在哪？

1. **隐式依赖**：`Get.find<XController>()` 在编译时无法验证，只有运行时才知道有没有注册
2. **全局状态污染**：`Get.put()` 注册的实例是全局的，测试时需要手动清理
3. **锁定效应**：路由、状态管理、DI 都用 GetX，想换一个就必须全换

### 🌿 Dio 的拦截器中发起网络请求会导致死循环吗？

会。如果鉴权拦截器里的 Token 刷新逻辑也经过同一个 Dio 实例，就会再次触发拦截器，形成无限递归。**解法**：Token 刷新请求用独立的 Dio 实例（不带鉴权拦截器），或者用 `handler.resolve()` 直接注入刷新后的 Token。

### 🌿 如何在 Riverpod 和 Bloc 之间做选择？

核心区别是**状态变更模型**：Bloc 用 Event 驱动（命令式），Riverpod 用声明式依赖图。如果你的业务逻辑是"用户做了 X → 系统做 Y"的事件流，Bloc 更自然；如果是"这些数据组合起来决定 UI"，Riverpod 更简洁。两者都能做对方的事，选团队思维模式更匹配的。

### 🌳 如何评估一个 Flutter 库是否值得长期依赖？

5 个信号：
1. **维护活跃度**：最近 6 个月有 commit，Issue 平均响应 < 7 天
2. **Breaking Change 频率**：major 版本之间间隔 > 6 个月
3. **测试覆盖率**：核心逻辑有单测，不只是 Demo
4. **社区采纳度**：pub.dev 平台分数 > 120，GitHub Star > 1000
5. **迁移路径**：作者是否提供迁移指南，API 是否有废弃过渡期

如果 3 个以上信号不满足，考虑自己封装或寻找替代方案。

---

## 参考资源

- [Flutter 官方 - 状态管理选型指南](https://docs.flutter.dev/data-and-backend/state-mgmt/options)
- [Dio 官方文档](https://pub.dev/packages/dio)
- [GoRouter 官方文档](https://pub.dev/packages/go_router)
- [Very Good Ventures - 技术选型方法论](https://verygood.ventures/blog)
- [Reso Coder - Flutter 状态管理对比](https://resocoder.com/)
