---
title: Flutter 企业开发实践01-项目架构设计
date: 2026-05-04
tags:
  - Flutter
  - 架构设计
  - Clean Architecture
  - 企业级
  - 模块化
---

# 项目架构设计

## 概述

Flutter 项目一开始都是一个人写 Demo。等到多人协作、多模块、要长期迭代的时候，最先爆出来的问题就是**代码腐化**：业务逻辑散在 Widget 里，数据源换个实现要改几十个文件，模块之间直接 import，动一处牵一片。

架构设计要解决的核心问题，就是**控制变更的传播半径**：一个需求变了，尽量只改最少的地方。要做到这点，分层得隔离开，模块得解耦，数据源得抽出来，还得有一套团队真能照着执行的目录约定。

这篇我按这几件事讲：每层为什么要存在，不这么分会出什么事，落地的时候怎么走才少踩坑。

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
| 数据层 | 实现接口，对接 API/DB/缓存 | → 业务层（实现它的接口） | `RepositoryImpl`、`RemoteDataSource`、`LocalDataSource` |

**关键原则就一条：依赖方向只能从外向内**。业务层是整个架构里最稳的内核，不依赖任何框架类，所以哪天你想把 GetX 换成 Bloc，业务层一行都不用改。

### 1.2 不分层会怎样

最常见的"伪分层"长这样：Controller 里直接调 Dio。

```dart
// 示意伪代码：省略 orders 状态字段与 import
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
1. 换网络库（Dio → http），所有 Controller 都得改
2. 单元测试 mock 不了数据层，只能跑集成测试
3. 业务规则（比如"订单超 30 分钟自动取消"）散在各个 Controller 里，复用不了

**正确做法**是这样：Controller 调 UseCase，UseCase 调 Repository 接口，RepositoryImpl 再去调 Dio：

```dart
// 示意伪代码：省略 orders 状态字段与 import
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

### 1.3 到底要不要四层或五层

有些团队会在业务层和数据层中间再加一层 **Domain Service**，专门放跨 UseCase 的编排逻辑。要不要拆，看这几点：

- **3 人以下**：三层就够了，UseCase 已经装得下业务逻辑
- **10 人以上**：跨 UseCase 的编排逻辑（比如"下单 → 扣库存 → 发通知"这种事务协调）放 Domain Service，免得 UseCase 之间互相调来调去，最后调成一张网

别为了"更正规"去加层。每加一层就是一套接口加实现要维护，层多了新人反而不知道从哪看起。

---

## 二、模块化与组件化策略

### 2.1 模块化的动机

单体应用所有代码都堆在一个 `lib/` 下，业务一涨就会出这些事：

- **编译慢**：改个图标颜色，整个工程重编一遍
- **冲突多**：几个人改同一个文件，Git 冲突不断
- **职责模糊**：购物车代码里引用了用户模块的私有类

模块化就是按业务域把代码拆成一个个独立 package，每个 package 有自己的 `pubspec.yaml`，能单独编译、单独测试。

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

**粒度原则**：模块切的是**业务域**的边界，不是技术层的边界。`module_order` 里自带 UI、Controller、Repository，但它不会去 import `module_user` 的实现类。

### 2.3 模块间依赖规则

```
module_order ──→ component_ui        ✅ 依赖基础组件
module_order ──→ component_network   ✅ 依赖基础设施
module_order ──→ module_user         ❌ 不允许直接依赖另一个业务模块
```

业务模块之间不许直接 import。要通信就用下一节讲的那几个机制来解耦。

### 2.4 Flutter Package vs Plugin

| 类型 | 适用场景 | 特点 |
|---|---|---|
| Dart Package | 纯 Dart/Flutter UI 逻辑 | 无平台通道，编译快 |
| Plugin Package | 要调原生能力 | 含平台通道 `[Android]`/`[iOS]`，编译慢 |

业务模块一律用 Dart Package。只有要碰原生交互（推送、支付 SDK）才用 Plugin，而且得单独封成一个 package，别让原生代码渗进业务模块。

---

## 三、模块间通信：EventBus vs Router vs 依赖注入

这三种机制解决的是不同粒度的通信问题：

### 3.1 EventBus：事件广播

**适用场景**：一对多、松耦合的"发生了某件事"通知。比如"用户登出了，所有模块把缓存清一下"。

```dart
// 示意伪代码：EventBus.instance 为示意 API（常用事件库无此单例，按实际所用包的 API 调整）
// 定义事件
class UserLogoutEvent {}

// 发送
EventBus.instance.fire(UserLogoutEvent());

// 订阅
EventBus.instance.on<UserLogoutEvent>().listen((_) {
  cartController.clearCart();
});
```

**不适用**：要拿返回值的调用（比如"查用户积分"）。EventBus 发出去就不管了，同步拿不到结果。

**坑**：EventBus 的订阅忘了取消就是内存泄漏。一定要在 Controller 的 `onClose()` 里取消掉。

### 3.2 Router：页面跳转即通信

**适用场景**：模块 A 要打开模块 B 的页面，顺便传参数、收结果。

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

**优势**：模块 A 压根不知道模块 B 存在，只认一个路由 path。这是模块之间解耦最干净的一种。

### 3.3 依赖注入：接口调用

**适用场景**：模块 A 要调模块 B 的业务方法，还得拿返回值。

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

**禁止**：直接 import 另一个业务模块的类。架构腐化就是从这一步开始的。

---

## 四、Repository 模式隔离数据源

### 4.1 Repository 解决什么问题

没有 Repository 的时候，Controller 就直接调 Dio：

```dart
// ❌ 数据源耦合
final res = await dio.get('/user/profile');
user.value = User.fromJson(res.data);
```

问题：
1. 从远程切到本地缓存，所有调用点都得改
2. 几个 Controller 拿同一份数据，缓存逻辑写了好几遍
3. 离线模式没法优雅降级

### 4.2 Repository 的职责边界

Repository 说白了就是**业务层和数据层之间的那份契约**：

- **对上**：往外给的是领域对象（`User`、`Order`），不把 DTO 或者 Dio Response 漏出去
- **对下**：把 Remote/Local DataSource 编排起来，管缓存策略和降级逻辑
- **不做**：不持有 UI 状态，也不管页面跳转

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

RemoteDataSource 返回 DTO（Data Transfer Object），LocalDataSource 负责存和读 DTO。DTO 转 Entity 这一步在 Repository 里做，上层永远只碰 Entity。

**为什么不干脆在 DataSource 层就转成 Entity**：因为 DataSource 可能被好几个 Repository 复用，而每个 Repository 对同一个 DTO 的转换逻辑可能不一样。放在 Repository 里转，更灵活。

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
| 迁移到模块化 | 每个 feature 自然升级为 package | 要重构的地方很多 |

**企业级项目一律用 Feature-First**。Layer-First 代码少的时候看着挺整齐，但页面到 50+ 以后，你改一个登录流程要在 5 个目录之间来回跳，效率很低。

### 5.3 core/ 的膨胀治理

`core/` 是最容易变成垃圾桶的地方，得靠规则管住：

1. **有 2 个以上 feature 在用的东西才放 core**，只有一个 feature 用就留在 feature 里
2. core 下每个子目录必须是**独立的一件事**：network、storage、theme，别建 `common/` 或者 `misc/` 这种筐
3. 定期 review：core 里的类如果只剩一个 feature 在用，就挪回那个 feature

---

## 六、Clean Architecture 在 Flutter 中的实践

### 6.1 Clean Architecture 的核心思想

Uncle Bob 的 Clean Architecture 里有一条**依赖规则**：源码依赖只能从外圈指向内圈。内圈是业务规则，外圈是框架和工具。

落到 Flutter 上就是这样：

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

如果 CRUD 逻辑简单到就一行 `repo.getXxx()`，那直接在 Controller 里调 Repository 接口就行。UseCase 的价值是封装**复杂业务规则**，不是给每个方法套个壳。

**过度设计 2：Entity 和 DTO 完全不同**

有些项目把 Entity 和 DTO 的字段搞成完全不一样，逼着每处都转换。可很多场景下 Entity 就是 DTO 加几个计算属性而已。分得太狠，只是给自己加维护成本。

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

Clean Architecture 的试金石就一句：**业务层能不能脱离 Flutter 框架，自己单独跑测试**。

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

如果 `Order` 类里 import 了 `flutter/material.dart`，那分层就已经被打破了：Entity 不该知道 Flutter 的存在。

---

## 常见坑

### 1. Controller 变成"上帝类"

一个 `HomeController` 扛着 20 个变量、10 个方法，首页所有功能都它一个干。**解法**：按功能把 Controller 拆开，一个页面可以有多个 `GetBuilder`，各自绑各自的 Controller。

### 2. Repository 变成简单的 API 代理

Repository 里就一行 `return await remote.getXxx()`，没缓存、没降级、也不编排数据。这种 Repository 还不如让 Controller 直接调 DataSource。**Repository 得有个存在的理由**：要么有缓存策略，要么有降级逻辑，要么有数据转换。

### 3. 忽略循环依赖

模块 A import 模块 B，模块 B 又 import 模块 A。这种直接循环，Dart 编译器会报错；更隐蔽的是 A 的 interface 依赖 B 的 interface，B 的实现又依赖 A 的实现。**定期用 `dart pub deps` 查一下依赖图**。

### 4. 过早模块化

3 个人的团队一上来就拆 10 个 package，每改个需求都要跨 package 改接口，进度反而更慢。**先用 Feature-First 的目录结构把代码组织好，等团队扩了、或者编译速度真成了瓶颈，再拆 package**。

### 5. 业务层偷偷依赖框架

```dart
// ❌ Entity 里用了 Flutter 的 Color
class Product {
  final Color brandColor;  // 依赖了 dart:ui
}
```

业务层该用纯 Dart 类型（比如用 `int` 表示颜色值），到表现层再转成 `Color`。

---

## 面试追问

### 为什么分层后代码量反而变多了，值得吗？

代码量变多就是分层的代价，换回来的是**变更隔离**和**可测试性**。不分层的时候，改一个 API 字段你得把整个项目搜一遍；分层以后，只要改 DTO 和对应的 fromDto 方法。面试的时候要把这句话说出来：分层的价值是**改的时候少改**，代码量多少是次要的。

### GetX 的 Controller 属于哪一层？

Controller 属于**表现层**。它持有视图状态、响应 UI 事件、调 UseCase/Repository。业务逻辑一旦写进 Controller，它就退化成"胖 Controller"，分层也就名存实亡了。怎么判断？看 Controller 里有没有 `if (条件) 做业务决策` 这种逻辑。有，就抽到 UseCase 里去。

### 如果项目已经是一坨"面条代码"，怎么渐进式重构？

1. **先补测试**：给核心业务流程写集成测试，保证重构完功能还是好的
2. **从数据层开始**：把散落各处的 Dio 调用收拢到 Repository，先不动调用方
3. **再抽业务层**：从 Controller 里把业务规则认出来，提到 UseCase
4. **最后拆模块**：Feature-First 的目录到位了，再按需拆 package

别想着一次性重构完，"绞杀者模式"一点点替换才稳。

### Repository 的缓存策略怎么设计？

常见的就三种：
- **Cache-First**：先读缓存，缓存没有再去请求网络。配置类数据适合这种。
- **Network-First**：先请求网络，失败了再读缓存。实时性要求高的数据适合这种。
- **Stale-While-Revalidate**：先把缓存返回去，同时发网络请求更新缓存。列表页做体验优化适合这种。

选哪种看业务场景，跟技术偏好没关系。策略在 Repository 里用参数控制，别每种策略建一个 Repository。

### 多个 Flutter 应用共享业务模块，怎么设计 package 结构？

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

关键是 **domain 包必须是纯 Dart，不带 Flutter 依赖**，这样任何 Dart 项目（包括后端）都能复用。UI 层按 App 拆，因为不同 App 的界面通常不一样。

---

## 参考资源

- [Clean Architecture - Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [Reso Coder - Flutter Clean Architecture](https://resocoder.com/flutter-clean-architecture-tdd/)
- [Very Good Ventures - Flutter 项目结构](https://verygood.ventures/blog/very-good-flutter-project-structure)
- [Flutter 官方 - 大型应用架构指南](https://docs.flutter.dev/app-architecture)
