---
title: Flutter 企业开发实践01-项目架构设计
date: 2026-05-18
tags:
  - Flutter
  - 架构设计
  - Clean Architecture
  - 企业级
  - 模块化
---

# 项目架构设计

## 概述

当 Flutter 项目从"一个人写 Demo"进化到"多人协作、多模块、长期迭代"的企业级应用时，最先暴露的问题从来不是"哪个 Widget 好用"，而是**代码腐化**：业务逻辑散落在 Widget 里、数据源切换要改几十个文件、模块之间直接 import 导致牵一发动全身。

架构设计的核心目标是**控制变更的传播半径**——某个需求变了，只需要改最少的地方。这需要分层的隔离、模块的解耦、数据源的抽象，以及一套团队可执行的目录约定。

本文从架构师视角回答：每一层为什么存在、不这么分会怎样、以及落地时怎么踩坑最少。

---

## 一、分层架构：表现层 / 业务层 / 数据层

### 1.1 三层职责划分

```
┌─────────────────────────────┐
│  Presentation Layer (UI)     │  Widget / Controller / State
├─────────────────────────────┤
│  Domain Layer (Business)     │  UseCase / Entity / Repository Interface
├─────────────────────────────┤
│  Data Layer (Infrastructure) │  Repository Impl / DataSource / API / DB
└─────────────────────────────┘
```

| 层 | 职责 | 依赖方向 | 典型类 |
|---|---|---|---|
| 表现层 | 渲染 UI、响应交互、持有视图状态 | → 业务层 | `GetX Controller`、`Widget`、`State` |
| 业务层 | 封装业务规则，定义领域模型和接口 | 无外部依赖（纯 Dart） | `UseCase`、`Entity`、`Repository`（接口） |
| 数据层 | 实现接口，对接 API/DB/缓存 | → 业务层（实现其接口） | `RepositoryImpl`、`RemoteDataSource`、`LocalDataSource` |

**关键原则：依赖方向只能从外向内**。业务层是整个架构最稳定的内核，不依赖任何框架类——这意味着你可以换掉 GetX 换成 Bloc，业务层一行不改。

### 1.2 不分层会怎样

最常见的"伪分层"是把 Controller 直接调用 Dio：

```dart
// ❌ Controller 直接依赖网络库
class OrderController extends GetxController {
  final dio = Dio();
  Future<void> loadOrders() async {
    final res = await dio.get('/orders');
    orders.value = res.data;
  }
}
```

**后果**：
1. 换网络库（Dio → http）要改所有 Controller
2. 单元测试无法 mock 数据层，只能集成测试
3. 业务规则（如"订单超 30 分钟自动取消"）散落在各 Controller，无法复用

**正确做法**：Controller 调 UseCase，UseCase 调 Repository 接口，RepositoryImpl 调 Dio：

```dart
// ✅ 分层调用
class OrderController extends GetxController {
  final GetOrdersUseCase getOrders;
  OrderController(this.getOrders);

  Future<void> loadOrders() async {
    final result = await getOrders();
    orders.value = result;
  }
}

// 业务层——纯 Dart，可独立测试
class GetOrdersUseCase {
  final OrderRepository repo;
  GetOrdersUseCase(this.repo);

  Future<List<Order>> call() async {
    final orders = await repo.getOrders();
    return orders.where((o) => !o.isExpired).toList(); // 业务规则在这里
  }
}

// 数据层——实现接口
class OrderRepositoryImpl implements OrderRepository {
  final OrderRemoteDataSource remote;
  final OrderLocalDataSource local;

  @override
  Future<List<Order>> getOrders() async {
    try {
      final dtos = await remote.fetchOrders();
      await local.cacheOrders(dtos);
      return dtos.map(Order.fromDto).toList();
    } on DioException {
      // 降级到缓存
      final cached = await local.getCachedOrders();
      return cached.map(Order.fromDto).toList();
    }
  }
}
```

### 1.3 是否需要四层或五层

有些团队在业务层和数据层之间加 **Domain Service** 层处理跨 UseCase 的编排逻辑。是否拆分取决于：

- **3 人以下团队**：三层足够，UseCase 已经能承载业务逻辑
- **10 人以上团队**：跨 UseCase 的编排逻辑（如"下单 → 扣库存 → 发通知"的事务协调）放到 Domain Service，避免 UseCase 之间互相调用形成网状依赖

不要为了"更正规"而加层。每一层都意味着接口+实现的维护成本，层多了反而让新人无从下手。

---

## 二、模块化与组件化策略

### 2.1 模块化的动机

单体应用的所有代码在一个 `lib/` 下，随着业务增长会出现：

- **编译慢**：改一个图标颜色，整个工程重新编译
- **冲突多**：多人改同一个文件产生 Git 冲突
- **职责模糊**：购物车代码引用了用户模块的私有类

模块化把代码按业务域拆成独立 package，每个 package 有自己的 `pubspec.yaml`，独立编译、独立测试。

### 2.2 模块划分粒度

```
app/
├── packages/
│   ├── module_user/        # 用户域：登录、注册、个人信息
│   ├── module_order/       # 订单域：下单、支付、退款
│   ├── module_product/     # 商品域：列表、详情、搜索
│   ├── component_ui/       # UI 组件库：按钮、卡片、主题
│   ├── component_network/  # 网络基础设施
│   └── component_storage/  # 存储基础设施
├── lib/
│   └── main.dart           # 壳工程：组装模块、配置路由
```

**粒度原则**：模块是**业务域**的边界，不是技术层的边界。`module_order` 包含自己的 UI、Controller、Repository，但不直接 import `module_user` 的实现类。

### 2.3 模块间依赖规则

```
module_order ──→ component_ui        ✅ 依赖基础组件
module_order ──→ component_network   ✅ 依赖基础设施
module_order ──→ module_user         ❌ 不允许直接依赖另一个业务模块
```

业务模块之间禁止直接 import。需要通信时，通过下一节介绍的通信机制解耦。

### 2.4 Flutter Package vs Plugin

| 类型 | 适用场景 | 特点 |
|---|---|---|
| Dart Package | 纯 Dart/Flutter UI 逻辑 | 无平台通道，编译快 |
| Plugin Package | 需要调用原生能力 | 含平台通道 `[Android]`/`[iOS]`，编译慢 |

业务模块一律用 Dart Package。只有涉及原生交互（推送、支付 SDK）时才用 Plugin，并封装在独立 package 中，避免原生代码污染业务模块。

---

## 三、模块间通信：EventBus vs Router vs 依赖注入

三种机制解决不同粒度的通信问题：

### 3.1 EventBus——事件广播

**适用场景**：一对多、松耦合的"发生了某件事"通知。如"用户已登出，所有模块清理缓存"。

```dart
// 定义事件
class UserLogoutEvent {}

// 发送
EventBus.instance.fire(UserLogoutEvent());

// 订阅
EventBus.instance.on<UserLogoutEvent>().listen((_) {
  cartController.clearCart();
});
```

**不适用**：需要返回值的调用（如"查询用户积分"）。EventBus 是 fire-and-forget，无法同步拿到结果。

**坑**：EventBus 的订阅忘记取消会导致内存泄漏。必须在 Controller 的 `onClose()` 中取消订阅。

### 3.2 Router——页面跳转即通信

**适用场景**：模块 A 需要打开模块 B 的页面，并传递参数/接收结果。

```dart
// 注册路由（壳工程负责）
GoRouter(routes: [
  GoRoute(path: '/order/detail', builder: (_, state) {
    final orderId = state.extra as String;
    return OrderDetailPage(orderId: orderId);
  }),
]);

// 调用方——无需 import OrderDetailPage
final result = await context.push('/order/detail', extra: 'order_123');
```

**优势**：模块 A 完全不知道模块 B 的存在，只知道一个路由 path。这是最干净的模块间解耦方式。

### 3.3 依赖注入——接口调用

**适用场景**：模块 A 需要调用模块 B 的业务方法，且需要返回值。

```dart
// 模块 B 定义接口（放在 shared 包中）
abstract class UserService {
  Future<User> getCurrentUser();
  Future<int> getUserPoints();
}

// 模块 B 实现接口
class UserServiceImpl implements UserService { ... }

// 壳工程注册
Get.lazyPut<UserService>(() => UserServiceImpl());

// 模块 A 通过接口调用——不知道实现类是谁
final points = await Get.find<UserService>().getUserPoints();
```

### 3.4 选型决策

| 通信需求 | 推荐方式 | 原因 |
|---|---|---|
| 广播通知（登出、全局刷新） | EventBus | 一对多，松耦合 |
| 打开另一个模块的页面 | Router | 解耦最彻底 |
| 调用另一个模块的业务方法 | DI + 接口 | 类型安全，可测试 |
| 共享数据（如当前用户） | DI + 单例 | 全局唯一，状态一致 |

**禁止**：直接 import 另一个业务模块的类。这是架构腐化的第一步。

---

## 四、Repository 模式隔离数据源

### 4.1 Repository 解决什么问题

没有 Repository 时，Controller 直接调 Dio：

```dart
// ❌ 数据源耦合
final res = await dio.get('/user/profile');
user.value = User.fromJson(res.data);
```

问题：
1. 从远程切换到本地缓存，要改所有调用点
2. 多个 Controller 获取同一数据，缓存逻辑重复
3. 离线模式无法优雅降级

### 4.2 Repository 的职责边界

Repository 是**业务层和数据层之间的契约**：

- **对上**：提供领域对象（`User`、`Order`），不暴露 DTO 或 Dio Response
- **对下**：编排 Remote/Local DataSource，处理缓存策略、降级逻辑
- **不做**：不持有 UI 状态，不做页面跳转

```dart
abstract class UserRepository {
  Future<User> getUser(String id);
  Future<void> saveUser(User user);
}

class UserRepositoryImpl implements UserRepository {
  final UserRemoteDataSource remote;
  final UserLocalDataSource local;
  final NetworkInfo networkInfo;

  @override
  Future<User> getUser(String id) async {
    if (await networkInfo.isConnected) {
      final dto = await remote.fetchUser(id);
      await local.saveUserDto(dto);
      return User.fromDto(dto);
    }
    // 离线降级
    final cached = await local.getUserDto(id);
    if (cached != null) return User.fromDto(cached);
    throw OfflineException();
  }
}
```

### 4.3 DataSource 的拆分

```
UserRepository
  ├── UserRemoteDataSource   → Dio / GraphQL
  └── UserLocalDataSource    → Hive / Drift / SharedPreferences
```

RemoteDataSource 返回 DTO（Data Transfer Object），LocalDataSource 存储和读取 DTO。DTO 到 Entity 的转换在 Repository 中完成，上层永远只接触 Entity。

**为什么不在 DataSource 层就转 Entity**：DataSource 可能被多个 Repository 复用，每个 Repository 对同一个 DTO 可能有不同的转换逻辑。转换放在 Repository 中更灵活。

---

## 五、大型项目的目录结构设计

### 5.1 推荐目录结构（Feature-First）

```
lib/
├── app/                          # 应用壳
│   ├── app.dart                  # MaterialApp 配置
│   ├── routes.dart               # 路由注册
│   └── di/                       # 依赖注入注册
│       └── injection.dart
├── features/                     # 按业务域组织
│   ├── auth/
│   │   ├── presentation/         # UI + Controller
│   │   │   ├── pages/
│   │   │   ├── controllers/
│   │   │   └── widgets/
│   │   ├── domain/               # 业务核心（纯 Dart）
│   │   │   ├── entities/
│   │   │   ├── repositories/     # 接口
│   │   │   └── usecases/
│   │   └── data/                 # 实现
│   │       ├── repositories/     # 实现
│   │       ├── datasources/
│   │       └── models/           # DTO
│   ├── order/
│   └── product/
├── core/                         # 跨 feature 的基础设施
│   ├── network/
│   ├── storage/
│   ├── theme/
│   └── utils/
└── main.dart
```

### 5.2 Feature-First vs Layer-First

| 维度 | Feature-First | Layer-First |
|---|---|---|
| 目录组织 | 按业务域 `features/auth/` | 按技术层 `presentation/` |
| 改一个功能 | 只动一个 feature 目录 | 要跨多个层目录 |
| 适合团队 | 多团队各负责一个 feature | 小团队、功能少 |
| 迁移到模块化 | 每个 feature 自然升级为 package | 需要大量重构 |

**企业级项目一律用 Feature-First**。Layer-First 在代码量小时看起来整洁，但到 50+ 页面后，改一个登录流程要在 5 个目录之间跳转，效率极低。

### 5.3 core/ 的膨胀治理

`core/` 是最容易变成垃圾桶的地方。治理规则：

1. **只在 2 个以上 feature 使用的东西才放 core**，否则留在 feature 内
2. core 下的每个子目录必须是**独立的 concern**：network、storage、theme，不建 `common/` 或 `misc/`
3. 定期 review：core 下的类如果只有一个 feature 在用，移回 feature

---

## 六、Clean Architecture 在 Flutter 中的实践

### 6.1 Clean Architecture 的核心思想

Uncle Bob 的 Clean Architecture 提出**依赖规则**：源码依赖只能从外圈指向内圈。内圈是业务规则，外圈是框架和工具。

映射到 Flutter：

```
Entities (内圈) → Use Cases → Interface Adapters (Controller/Repository) → Frameworks & Drivers (外圈)
```

### 6.2 落地时最常见的过度设计

**过度设计 1：每个 CRUD 操作都建 4 个文件**

```
CreateOrderUseCase.dart
ReadOrderUseCase.dart
UpdateOrderUseCase.dart
DeleteOrderUseCase.dart
```

如果 CRUD 逻辑简单到只有一行 `repo.getXxx()`，直接在 Controller 调 Repository 接口即可。UseCase 的价值在于封装**复杂业务规则**，不是给每个方法包一层。

**过度设计 2：Entity 和 DTO 完全不同**

有些项目让 Entity 和 DTO 字段完全不同，强制所有转换。实际上很多场景下 Entity 就是 DTO 加几个计算属性。过度分离只会增加维护成本。

**务实的做法**：

```dart
// 简单场景：Entity 和 DTO 共用
class User {
  final String id;
  final String name;
  const User({required this.id, required this.name});
}

// 复杂场景：Entity 包含业务逻辑，DTO 只做序列化
class Order {
  final String id;
  final DateTime createdAt;
  final List<OrderItem> items;

  // Entity 特有：业务规则
  bool get isExpired => DateTime.now().difference(createdAt).inMinutes > 30;
  double get totalPrice => items.fold(0, (sum, item) => sum + item.price);
}

class OrderDto {
  final String id;
  final String createdAt;  // JSON 里是字符串
  final List<Map<String, dynamic>> items;
}
```

### 6.3 可测试性验证

Clean Architecture 的试金石：**业务层能否脱离 Flutter 框架独立测试**。

```dart
// ✅ 不 import 任何 Flutter 包，纯 Dart 单元测试
void main() {
  test('过期订单应被过滤', () async {
    final repo = MockOrderRepository();
    when(() => repo.getOrders()).thenAnswer((_) async => [
      Order(id: '1', createdAt: DateTime.now().subtract(Duration(minutes: 31))),
      Order(id: '2', createdAt: DateTime.now()),
    ]);

    final useCase = GetValidOrdersUseCase(repo);
    final result = await useCase();

    expect(result.length, 1);
    expect(result.first.id, '2');
  });
}
```

如果 `Order` 类 import 了 `flutter/material.dart`，那就说明分层被打破了——Entity 不应该知道 Flutter 的存在。

---

## 常见坑与踩点

### 1. Controller 变成"上帝类"

一个 `HomeController` 持有 20 个变量、10 个方法，承担了首页所有功能。**解法**：按功能拆分 Controller，一个页面可以有多个 `GetBuilder` 绑定不同 Controller。

### 2. Repository 变成简单的 API 代理

Repository 只有一行 `return await remote.getXxx()`，没有缓存、没有降级、没有业务编排。这种 Repository 不如直接让 Controller 调 DataSource。**Repository 必须有存在的理由**：要么有缓存策略，要么有降级逻辑，要么有数据转换。

### 3. 忽略循环依赖

模块 A import 模块 B，模块 B 又 import 模块 A。Dart 编译器会报错，但更隐蔽的是：A 的 interface 依赖 B 的 interface，B 的实现依赖 A 的实现。**用 `dart pub deps` 定期检查依赖图**。

### 4. 过早模块化

3 个人的团队上来就拆 10 个 package，每次改需求要跨 package 改接口，反而拖慢进度。**先用 Feature-First 目录结构组织代码，等团队扩张或编译速度成瓶颈时再拆 package**。

### 5. 业务层偷偷依赖框架

```dart
// ❌ Entity 里用了 Flutter 的 Color
class Product {
  final Color brandColor;  // 依赖了 dart:ui
}
```

业务层应该用纯 Dart 类型（如 `int` 表示颜色值），在表现层再转成 `Color`。

---

## 面试追问

### 🌱 为什么分层后代码量反而变多了，值得吗？

代码量增加是分层的代价，但换来的是**变更隔离**和**可测试性**。不分层时，改一个 API 字段可能要搜遍整个项目；分层后，只需要改 DTO 和对应的 fromDto 方法。面试时要强调：分层的价值不在于代码少，而在于**改的时候少改**。

### 🌱 GetX 的 Controller 属于哪一层？

Controller 属于**表现层**。它持有视图状态、响应 UI 事件、调用 UseCase/Repository。如果把业务逻辑写在 Controller 里，Controller 就退化成"胖 Controller"，分层名存实亡。判断标准：Controller 里是否包含 `if (条件) 做业务决策` 的逻辑——如果有，抽到 UseCase。

### 🌿 如果项目已经是一坨"面条代码"，怎么渐进式重构？

1. **先补测试**：对核心业务流程写集成测试，确保重构不破坏功能
2. **从数据层开始**：把散落在各处的 Dio 调用收拢到 Repository，不改调用方
3. **再抽业务层**：从 Controller 中识别业务规则，提取到 UseCase
4. **最后拆模块**：Feature-First 目录到位后，按需拆 package

不要试图一次性重构——"绞杀者模式"逐步替换更安全。

### 🌿 Repository 的缓存策略怎么设计？

常见策略：
- **Cache-First**：先读缓存，缓存不存在再请求网络。适合配置类数据。
- **Network-First**：先请求网络，失败读缓存。适合实时性要求高的数据。
- **Stale-While-Revalidate**：先返回缓存，同时发网络请求更新缓存。适合列表页体验优化。

策略选择取决于业务场景，不是技术偏好。在 Repository 中通过参数控制策略，而不是为每种策略建一个 Repository。

### 🌳 多个 Flutter 应用共享业务模块，怎么设计 package 结构？

```
packages/
├── core/                    # 最底层：工具类、基础类型
├── domain_user/             # 用户领域：Entity + Repository 接口 + UseCase
├── domain_order/            # 订单领域
├── infra_network/           # 基础设施实现
├── infra_storage/
├── feature_user_ui/         # UI 层（可能不同 App 的 UI 不同）
└── feature_order_ui/
```

关键：**domain 包是纯 Dart，不含 Flutter 依赖**，可以被任何 Dart 项目（包括后端）复用。UI 层按 App 拆分，因为不同 App 的用户界面通常不同。

---

## 参考资源

- [Clean Architecture - Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [Reso Coder - Flutter Clean Architecture](https://resocoder.com/flutter-clean-architecture-tdd/)
- [Very Good Ventures - Flutter 项目结构](https://verygood.ventures/blog/very-good-flutter-project-structure)
- [Flutter 官方 - 大型应用架构指南](https://docs.flutter.dev/app-architecture)
