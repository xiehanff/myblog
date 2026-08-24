---
title: Flutter 企业开发实践14-单元测试
date: 2026-05-18
tags:
  - Flutter
  - 单元测试
  - 测试金字塔
  - mockito
  - BDD
  - 企业级
---

# 单元测试

## 概述

单元测试不是"写完代码补一下"的装饰品，而是架构师用来**保护重构安全**和**降低回归成本**的工程工具。一个没有测试覆盖的项目，每次发版都是在赌——赌没有意外破坏已有功能。从 ROI 视角看：单元测试的投入在首次编写时是负的，但在第 3 次回归验证后开始产生正收益，且随项目寿命增长收益加速放大。

核心问题：**哪些代码必须测？哪些不值得测？** 答案决定了一个团队的测试效率和工程成熟度。

## 测试金字塔

### 为什么是金字塔而不是倒三角？

```
        /  E2E  \          ← 少量，慢，贵
       / Widget  \         ← 适量，中速，中成本
      /   Unit    \        ← 大量，快，便宜
     /_____________\
```

- **单元测试（70%）**：纯逻辑验证，无 UI 依赖，毫秒级执行
- **Widget 测试（20%）**：验证组件渲染与交互，秒级执行
- **集成测试（10%）**：端到端用户流程，分钟级执行

**不这么做会怎样？** 倒三角（大量 E2E + 少量单元测试）的典型后果：
- CI 跑一次要 40 分钟以上，开发者不愿等，测试形同虚设
- 一个底层模型改动导致 20 个 E2E 用例挂掉，排查成本极高
- 测试的定位精度差——失败了只知道"某个流程坏了"，不知道"哪里坏了"

### 金字塔比例的调优

实际项目中比例会浮动，但核心原则不变：**越底层的测试越要多写**。以下是常见调整：

| 项目特征 | 调整方向 |
|---------|---------|
| 纯 UI 展示类 App | Widget 测试占比提升至 30% |
| 业务逻辑复杂的金融 App | 单元测试占比提升至 80% |
| 快速迭代的 MVP 阶段 | 单元测试保底 50%，其余可后补 |

## Flutter 单元测试框架：test 包

### 基本结构

`test` 包是 Dart 官方测试框架，Flutter 单元测试基于它运行。

```dart
// counter.dart
class Counter {
  int _value = 0;

  int get value => _value;

  void increment() => _value++;

  void decrement() => _value--;
}
```

```dart
// counter_test.dart
import 'package:test/test.dart';
import 'counter.dart';

void main() {
  late Counter counter;

  setUp(() {
    counter = Counter();
  });

  test('初始值应为 0', () {
    expect(counter.value, equals(0));
  });

  test('increment 后值应加 1', () {
    counter.increment();
    expect(counter.value, equals(1));
  });

  test('decrement 后值应减 1', () {
    counter.decrement();
    expect(counter.value, equals(-1));
  });
}
```

### 分组与标签

```dart
group('Counter', () {
  late Counter counter;

  setUp(() {
    counter = Counter();
  });

  test('初始值', () {
    expect(counter.value, 0);
  });

  group('increment', () {
    test('从 0 增加', () {
      counter.increment();
      expect(counter.value, 1);
    });

    test('连续增加', () {
      counter.increment();
      counter.increment();
      expect(counter.value, 2);
    });
  });
});
```

### 哪些代码必须测？

**必须测的（高 ROI）**：
- 状态管理逻辑（Controller / Bloc / Riverpod Notifier）
- 数据转换与校验（Model 的 fromJson / toJson / validate）
- 业务规则（价格计算、权限判断、流程状态机）
- Repository 层（Mock 数据源，验证调用链路）

**不必测的（低 ROI）**：
- 纯 UI 渲染（交给 Widget 测试）
- 框架提供的 API（`setState` 会触发 rebuild 不需要测）
- 简单的数据类（只有 getter/setter 的 POJO）
- 第三方库的内部逻辑

## Widget 测试

### 本质：对 Widget 树的断言

Widget 测试不是"截图比对"，而是对 Widget 树的**结构断言**——验证某个 Widget 存在、具有特定属性、对交互做出正确响应。

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'counter_page.dart';

void main() {
  testWidgets('点击按钮后计数器增加', (WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: CounterPage()));

    // 验证初始状态
    expect(find.text('0'), findsOneWidget);
    expect(find.text('1'), findsNothing);

    // 模拟点击
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump(); // 触发帧重建

    // 验证更新后的状态
    expect(find.text('1'), findsOneWidget);
  });
}
```

### Finder 策略选择

| Finder | 适用场景 | 优先级 |
|--------|---------|--------|
| `find.text('...')` | 验证文本内容 | 高——用户视角 |
| `find.byKey(const Key('xxx'))` | 精确定位组件 | 中——需加 key |
| `find.byType(XXX)` | 验证组件类型存在 | 低——过于宽泛 |
| `find.byWidgetPredicate(...)` | 复杂条件匹配 | 最后手段 |

**架构决策**：对需要测试的 Widget 统一使用 `Key` 标识，而非依赖文本（文本会随国际化变化）。

```dart
// 生产代码
ElevatedButton(
  key: const Key('login_button'),
  onPressed: _onLogin,
  child: Text(AppLocalizations.of(context)!.login),
)

// 测试代码
await tester.tap(find.byKey(const Key('login_button')));
```

### pump vs pumpAndSettle

- `pump()`：推进一帧，适用于同步动画或立即响应
- `pumpAndSettle()`：推进所有帧直到动画结束，适用于有动画的场景
- `pump(Duration)`：推进指定时间，适用于定时器或延时操作

```dart
// 有动画的场景
await tester.tap(find.byKey(const Key('expand_button')));
await tester.pumpAndSettle(); // 等待展开动画完成
expect(find.byType(DetailPanel), findsOneWidget);

// 有定时器的场景
await tester.pump(const Duration(seconds: 3)); // 快进 3 秒
expect(find.text('已超时'), findsOneWidget);
```

## Mock 策略

### 为什么需要 Mock？

单元测试的核心约束：**一个测试只验证一个单元的行为**。如果被测对象依赖真实的网络请求、数据库或文件系统，测试就变成了集成测试——变慢、不稳定、不可重复。

### mockito vs mocktail

| 维度 | mockito | mocktail |
|------|---------|----------|
| 代码生成 | 需要 `build_runner` | 不需要 |
| API 风格 | `when(mock.method()).thenAnswer(...)` | 同左 |
| 泛型支持 | 需要指定 `@GenerateNiceMocks` | 原生支持 |
| 维护状态 | 官方维护 | 社区维护，API 更简洁 |
| 推荐度 | 大型项目、已有基建 | 新项目、快速启动 |

**架构建议**：新项目选 mocktail（零代码生成，编译快）；已有 mockito 基建的项目不必迁移。

### mocktail 使用示例

```dart
// 定义抽象接口（依赖倒置）
abstract class AuthRepository {
  Future<User> login(String email, String password);
  Future<void> logout();
}

// Mock 类
class MockAuthRepository extends Mock implements AuthRepository {}

// 测试
void main() {
  late AuthController controller;
  late MockAuthRepository mockRepo;

  setUp(() {
    mockRepo = MockAuthRepository();
    controller = AuthController(repository: mockRepo);
  });

  test('登录成功时更新用户状态', () async {
    // Arrange
    const user = User(id: '1', name: 'Test');
    when(() => mockRepo.login('test@example.com', '123456'))
        .thenAnswer((_) async => user);

    // Act
    await controller.login('test@example.com', '123456');

    // Assert
    expect(controller.state.user, user);
    verify(() => mockRepo.login('test@example.com', '123456')).called(1);
  });

  test('登录失败时抛出异常', () async {
    when(() => mockRepo.login(any(), any()))
        .thenThrow(AuthException('Invalid credentials'));

    expect(
      () => controller.login('wrong@email.com', 'wrong'),
      throwsA(isA<AuthException>()),
    );
  });
}
```

### Mock 的边界：不要 Mock 你不拥有的类型

```dart
// ❌ 错误：Mock 了第三方库的类型
class MockDio extends Mock implements Dio {}

// ✅ 正确：封装后 Mock 自己的接口
abstract class HttpClient {
  Future<Response> get(String path, {Map<String, String>? headers});
}

class MockHttpClient extends Mock implements HttpClient {}
```

**原因**：第三方库的内部实现可能随版本变化，Mock 它等于你对它的内部做了假设——这个假设随时可能失效。封装一层自己的接口，Mock 这层接口。

### 状态管理层的测试：bloc_test 与 Riverpod overrides

状态层是"必须测"清单的常客，但很多团队最后只测了 Repository——因为不知道状态管理框架怎么 Mock。两种主流框架都有官方配套写法：

**Bloc：`bloc_test` 包**，专为首测状态机设计——给定初始状态与事件序列，断言最终状态流：

```dart
// 基于 bloc_test ^9.x / bloc ^8.x
void main() {
  blocTest<LoginBloc, LoginState>(
    '正确凭据登录 → 状态经 loading 到 success',
    build: () {
      final repo = MockAuthRepository();
      when(() => repo.login('user', 'pass'))
          .thenAnswer((_) async => const User(id: '1'));
      return LoginBloc(repo);
    },
    act: (bloc) => bloc.add(const LoginSubmitted('user', 'pass')),
    expect: () => [
      LoginState(status: LoginStatus.loading),
      LoginState(status: LoginStatus.success, user: const User(id: '1')),
    ],
  );
}
```

**Riverpod：`ProviderScope(overrides: [...])`**——不 Mock Provider 本身，而是用测试实现覆盖依赖：

```dart
// 基于 flutter_riverpod / riverpod 3.x
testWidgets('未登录时展示登录按钮', (tester) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        // 真实 authRepositoryProvider 被测试实现覆盖
        authRepositoryProvider.overrideWithValue(FakeAuthRepo(loggedIn: false)),
      ],
      child: const MaterialApp(home: HomePage()),
    ),
  );
  expect(find.byKey(const Key('login_button')), findsOneWidget);
});
```

**共同原则**：断言的是**状态/输出**，不是实现细节——测试 `state.status == success`，而不是"内部调了两次 repository"。后者会把重构变成改测试。

## BDD 测试

### 为什么考虑 BDD？

传统单元测试以"技术实现"为中心命名，如 `test('login with valid credentials updates state')`。BDD 以"业务行为"为中心：`test('用户使用正确凭据登录后应看到首页')`。

BDD 的价值不在于换了个写法，而在于**让非技术角色（PM、QA）能参与测试用例的评审**。

### bdd_framework 使用

```dart
import 'package:bdd_framework/bdd_framework.dart';

void main() {
  final feature = Feature('用户登录');

  feature.scenario('使用正确凭据登录')
    ..given('用户在登录页面')
    ..when('输入正确的邮箱和密码并点击登录')
    ..then('应跳转到首页')
    ..run((context) async {
      // 实际测试逻辑
      final controller = AuthController(repository: mockRepo);
      when(() => mockRepo.login(any(), any()))
          .thenAnswer((_) async => testUser);

      await controller.login('test@example.com', '123456');

      expect(controller.state.isAuthenticated, isTrue);
    });
}
```

**架构决策**：BDD 适合核心业务流程（登录、支付、订单流转），不适合基础设施层（工具类、数据转换）。过度使用 BDD 会导致测试代码比生产代码还难维护。

## 测试覆盖率与持续集成

### 覆盖率目标

| 层级 | 目标覆盖率 | 理由 |
|------|-----------|------|
| Model / Entity | ≥ 90% | 数据转换错误直接影响业务正确性 |
| Controller / Bloc | ≥ 80% | 业务逻辑核心，回归风险最高 |
| Repository | ≥ 70% | 主要验证调用链路和错误处理 |
| UI Widget | ≥ 50% | 关键交互路径覆盖即可 |
| 整体 | ≥ 70% | 业界可接受的最低线 |

**关键认知**：100% 覆盖率不等于 100% 正确性。覆盖率只告诉你"这行代码被执行过"，不告诉你"是否验证了所有边界条件"。

### 生成覆盖率报告

```bash
# 运行测试并生成覆盖率
flutter test --coverage

# 使用 lcov 格式化（需安装 lcov）
# [Linux/macOS]
genhtml coverage/lcov.info -o coverage/html
open coverage/html/index.html

# [Windows] 使用 coverage 包
dart pub global activate coverage
dart pub global run coverage:format_coverage \
  --lcov --in=coverage --out=coverage/lcov.info \
  --report-on=lib
```

### CI 集成

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.x'
      - run: flutter pub get
      - run: flutter test --coverage
      - name: Check coverage threshold
        run: |
          # flutter test --coverage 已直接产出 lcov 格式的 coverage/lcov.info，
          # 从中汇总行覆盖率：LH = 命中行数，LF = 可执行总行数
          PERCENT=$(awk -F: '
            /^LF:/ { lf += $2 }
            /^LH:/ { lh += $2 }
            END { if (lf == 0) print 0; else printf "%.1f", 100 * lh / lf }
          ' coverage/lcov.info)
          echo "line coverage = ${PERCENT}%"
          # 低于 70% 直接让 CI 失败——没有判断的"覆盖率检查"永远通过，等于没有
          awk -v p="$PERCENT" 'BEGIN { if (p < 70) { print "coverage 0.7 required, got " p; exit 1 } }'
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage/lcov.info
```

**架构建议**：CI 中设置覆盖率门槛（如低于 70% 则失败），但不要设得太高——过高的门槛会逼迫开发者写无意义的测试来凑数。

## 常见坑

### 1. 测试中的异步泄漏

```dart
// ❌ 忘记 await，测试提前结束
test('异步操作', () {
  controller.fetchData(); // 没有 await
  expect(controller.state.data, isNotNull); // 断言在数据到达前执行
});

// ✅ 正确写法
test('异步操作', () async {
  await controller.fetchData();
  expect(controller.state.data, isNotNull);
});
```

### 2. Widget 测试中的 pump 不足

```dart
// ❌ 动画未完成就断言
await tester.tap(find.byKey(const Key('button')));
// 缺少 pump，Widget 树还没更新
expect(find.text('成功'), findsOneWidget); // 失败

// ✅ 确保帧被处理
await tester.tap(find.byKey(const Key('button')));
await tester.pumpAndSettle();
expect(find.text('成功'), findsOneWidget);
```

### 3. Mock 的过度使用

如果测试中 80% 的代码在设置 Mock 而非验证行为，说明**被测单元的依赖太多，应该先重构而非继续写测试**。这是测试给你的信号，别忽略它。

### 4. 测试之间共享状态

```dart
// ❌ 使用全局变量在测试间共享状态
User currentUser = User();

test('test A', () {
  currentUser = User(name: 'A');
});

test('test B', () {
  // B 可能受 A 的影响，执行顺序不同结果不同
  expect(currentUser.name, ???);
});

// ✅ 每个测试在 setUp 中重置状态
setUp(() {
  currentUser = User();
});
```

### 5. 测试代码不做代码评审

测试代码和生产代码同等重要。混乱的测试代码比没有测试更危险——它会给你虚假的安全感。测试代码也应该遵循命名规范、避免重复、保持可读性。

## 面试追问

**你的测试覆盖率是多少？你怎么决定哪些代码需要测？**

覆盖率数字本身不重要，重要的是选择策略。回答要点：Model 和 Controller 层覆盖率 >80%，UI 层覆盖关键路径即可。覆盖率是安全网，不是目标。

**Mock 和 Stub 有什么区别？你什么场景用哪个？**

Mock 验证行为（"这个方法被调用了吗？调了几次？"），Stub 返回预设数据（"调用这个方法返回这个值"）。验证交互用 Mock，只提供数据用 Stub。mocktail 中 `when(...).thenAnswer()` 是 Stub，`verify(...)` 是 Mock。

**你的 CI 中测试跑多久？怎么优化？**

回答要点：分层执行——单元测试 <2 分钟，Widget 测试 <5 分钟，集成测试 <15 分钟。优化手段：并行执行、增量测试（只跑受影响模块的测试）、Shard 分片。

**你遇到过测试代码维护成本过高的问题吗？怎么解决的？**

这是高级问题，考察工程判断力。回答方向：当测试代码的维护成本超过它防止 bug 的价值时，说明测试结构有问题。典型解法——减少对实现细节的耦合（测行为不测实现）、用 Builder 模式简化测试数据构造、抽取共享的 test helper。

**你怎么测试有副作用的外部依赖（网络、数据库、文件系统）？**

回答要点：通过接口隔离（依赖倒置），Mock 接口而非实现。对于必须验证真实行为的场景（如数据库 migration），用集成测试 + 测试专用环境（内存数据库 / 临时目录），而非在单元测试中连真实服务。

## 参考资源

- [Flutter 官方测试文档](https://docs.flutter.dev/testing)
- [mocktail 包](https://pub.dev/packages/mocktail)
- [mockito 包](https://pub.dev/packages/mockito)
- [Effective Dart: Testing](https://docs.flutter.dev/testing/overview)
- Martin Fowler - TestPyramid: https://martinfowler.com/bliki/TestPyramid.html
- Google Testing Blog: https://testing.googleblog.com/
