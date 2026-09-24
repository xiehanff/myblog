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

别把单元测试当成"写完代码补一下"的装饰品。它是架构师手里用来**保护重构安全**、**降低回归成本**的工程工具。一个项目没有测试覆盖，每次发版都在赌：赌自己没有意外破坏已有功能。

从 ROI 上算，单元测试刚写的时候是纯亏的，扛过第 3 次回归验证才开始产生正收益；项目活得越久，收益放大得越快。

核心问题就一个：**哪些代码必须测？哪些不值得测？** 这个答案决定了一个团队的测试效率和工程成熟度。

## 测试金字塔

### 为什么是金字塔而不是倒三角？

```
        /  E2E  \          ← 少量，慢，贵
       / Widget  \         ← 适量，中速，中成本
      /   Unit    \        ← 大量，快，便宜
     /_____________\
```

- **单元测试（70%）**：只验证纯逻辑，不依赖 UI，毫秒级跑完
- **Widget 测试（20%）**：验证组件渲染和交互，秒级跑完
- **集成测试（10%）**：走完整个用户流程，分钟级跑完

**不这么做会怎样？** 倒三角，也就是大量 E2E 加少量单元测试，后果基本是这几样：
- CI 跑一次要 40 分钟以上，开发者不愿意等，测试就形同虚设
- 底层模型改一下，20 个 E2E 用例跟着挂，排查成本很高
- 定位精度还差：失败了只知道"某个流程坏了"，不知道"哪里坏了"

### 金字塔比例的调优

实际项目里比例会浮动，但核心原则不变：**越底层的测试越要多写**。常见的调整有这么几种：

| 项目特征 | 调整方向 |
|---------|---------|
| 纯 UI 展示类 App | Widget 测试占比提到 30% |
| 业务逻辑复杂的金融 App | 单元测试占比提到 80% |
| 快速迭代的 MVP 阶段 | 单元测试保底 50%，剩下的可以后补 |

## Flutter 单元测试框架：test 包

### 基本结构

`test` 包是 Dart 官方的测试框架，Flutter 单元测试就跑在它上面。

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

**必须测的，都是高 ROI**：
- 状态管理逻辑（Controller / Bloc / Riverpod Notifier）
- 数据转换与校验（Model 的 fromJson / toJson / validate）
- 业务规则（价格计算、权限判断、流程状态机）
- Repository 层（Mock 数据源，验证调用链路）

**不必测的，ROI 太低**：
- 纯 UI 渲染（这块交给 Widget 测试）
- 框架自己提供的 API（`setState` 会触发 rebuild，不用测）
- 简单的数据类（只有 getter/setter 的 POJO）
- 第三方库的内部逻辑

## Widget 测试

### 本质：对 Widget 树的断言

Widget 测试做的就是给 Widget 树做**结构断言**：某个 Widget 在不在、属性对不对、点了以后响应对不对。它跟"截图比对"完全是两回事。

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
| `find.text('...')` | 验证文本内容 | 高（用户视角） |
| `find.byKey(const Key('xxx'))` | 精确定位组件 | 中（需加 key） |
| `find.byType(XXX)` | 验证组件类型存在 | 低（过于宽泛） |
| `find.byWidgetPredicate(...)` | 复杂条件匹配 | 最后手段 |

**架构决策**：需要测试的 Widget 统一用 `Key` 来定位，别依赖文本，文本会随国际化变。

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

- `pump()`：推进一帧，同步动画或立即响应就用它
- `pumpAndSettle()`：一直推进到动画结束，有动画的场景用它
- `pump(Duration)`：推进指定的时间，定时器或延时操作用它

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

单元测试有个硬约束：**一个测试只验证一个单元的行为**。被测对象要是依赖真实的网络请求、真实的数据库、真实的文件系统，那这个测试就变成集成测试了：变慢、不稳定、也没法重复跑。

### mockito vs mocktail

| 维度 | mockito | mocktail |
|------|---------|----------|
| 代码生成 | 需要 `build_runner` | 不需要 |
| API 风格 | `when(mock.method()).thenAnswer(...)` | 同左 |
| 泛型支持 | 需要指定 `@GenerateNiceMocks` | 原生支持 |
| 维护状态 | 官方维护 | 社区维护，API 更简洁 |
| 推荐度 | 大型项目、已有基建 | 新项目、快速启动 |

**架构建议**：新项目直接选 mocktail，零代码生成、编译快；已经有 mockito 基建的项目不用折腾迁移。

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

**原因**：第三方库内部怎么实现，随时可能随版本变。Mock 它，等于你把它的内部当成了稳定的东西，这个假设随时可能失效。自己封一层接口出来，Mock 自己这层。

### 状态管理层的测试：bloc_test 与 Riverpod overrides

状态层是"必须测"清单里的常客，但很多团队最后只测了 Repository，因为不知道状态管理框架该怎么 Mock。两种主流框架都有官方配套的写法：

**Bloc：`bloc_test` 包**，专门用来测状态机：给定初始状态和事件序列，断言最后的状态流：

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

**Riverpod：`ProviderScope(overrides: [...])`**，不去 Mock Provider 本身，改用测试实现把依赖覆盖掉：

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

**共同原则**：断言就断言**状态/输出**，别去管实现细节。测 `state.status == success`，别测"内部调了两次 repository"。写成后者，重构一次你就得改一次测试。

## BDD 测试

### 为什么考虑 BDD？

传统单元测试是按"技术实现"命名的，比如 `test('login with valid credentials updates state')`。BDD 反过来，按"业务行为"命名：`test('用户使用正确凭据登录后应看到首页')`。

BDD 的价值在于**让 PM、QA 这些非技术角色也能参与测试用例评审**。

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

**架构决策**：BDD 适合核心业务流程，登录、支付、订单流转这些；基础设施层就别用了，工具类、数据转换都不适合。BDD 用过头，测试代码会变得比生产代码还难维护。

## 测试覆盖率与持续集成

### 覆盖率目标

| 层级 | 目标覆盖率 | 理由 |
|------|-----------|------|
| Model / Entity | ≥ 90% | 数据转换错了，业务就错了 |
| Controller / Bloc | ≥ 80% | 业务逻辑的核心，回归风险最高 |
| Repository | ≥ 70% | 主要验证调用链路和错误处理 |
| UI Widget | ≥ 50% | 关键交互路径覆盖到就行 |
| 整体 | ≥ 70% | 业界普遍接受的最低线 |

100% 覆盖率不等于 100% 正确。覆盖率只告诉你"这行代码被执行过"，不告诉你"边界条件是不是都验证了"。

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

**架构建议**：CI 里设个覆盖率门槛，比如低于 70% 就失败；但门槛别设太高，太高的门槛只会逼着开发者写一堆没意义的测试来凑数。

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

如果一个测试里 80% 的代码都在搭 Mock，没几行在验证行为，那麻烦的地方就来了：**被测单元的依赖太多，得先重构，别急着继续写测试**。这是测试给你的信号，别忽略它。

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

测试代码跟生产代码同等重要。乱成一团的测试代码比没有测试更危险，它会给你虚假的安全感。测试代码同样要讲命名规范、避免重复、保持可读。

## 面试追问

**你的测试覆盖率是多少？你怎么决定哪些代码需要测？**

覆盖率数字本身不重要，重要的是你怎么选。回答要点：Model 和 Controller 层覆盖率 >80%，UI 层把关键路径覆盖上就行。覆盖率是安全网，不是拿来冲的指标。

**Mock 和 Stub 有什么区别？你什么场景用哪个？**

Mock 管验证行为："这个方法被调用了吗？调了几次？"；Stub 返回预设数据："调用这个方法返回这个值"。要验证交互就用 Mock，只提供数据就用 Stub。mocktail 里 `when(...).thenAnswer()` 是 Stub，`verify(...)` 是 Mock。

**你的 CI 中测试跑多久？怎么优化？**

回答要点：分层跑，单元测试 <2 分钟，Widget 测试 <5 分钟，集成测试 <15 分钟。优化手段就那几招：并行执行、增量测试，只跑受影响模块的测试、Shard 分片。

**你遇到过测试代码维护成本过高的问题吗？怎么解决的？**

这题偏高级，考的是工程判断力。回答方向：测试代码的维护成本一旦超过它防住 bug 的价值，就说明测试结构出问题了。典型解法：少耦合实现细节（测行为，不测实现）、用 Builder 模式简化测试数据构造、把共享的 test helper 抽出来。

**你怎么测试有副作用的外部依赖（网络、数据库、文件系统）？**

回答要点：靠接口隔离，也就是依赖倒置，Mock 接口，别 Mock 实现。必须验证真实行为的场景，比如数据库 migration，就用集成测试加测试专用环境（内存数据库 / 临时目录），别在单元测试里去连真实服务。

## 参考资源

- [Flutter 官方测试文档](https://docs.flutter.dev/testing)
- [mocktail 包](https://pub.dev/packages/mocktail)
- [mockito 包](https://pub.dev/packages/mockito)
- [Effective Dart: Testing](https://docs.flutter.dev/testing/overview)
- Martin Fowler - TestPyramid: https://martinfowler.com/bliki/TestPyramid.html
- Google Testing Blog: https://testing.googleblog.com/
