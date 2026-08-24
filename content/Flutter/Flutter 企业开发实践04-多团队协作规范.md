---
title: Flutter 企业开发实践04-多团队协作规范
date: 2026-05-18
tags:
  - Flutter
  - 协作规范
  - Git 工作流
  - 代码审查
  - 企业级
  - 多团队
---

# 多团队协作规范

## 概述

一个人写代码，规范不重要——代码都在脑子里。但当 5 个、10 个、20 个人同时改一个 Flutter 仓库时，没有规范就是灾难：代码风格各异的 PR、永远合不完的合并冲突、审查流于形式的"LGTM"、依赖版本满天飞。

规范的本质是**降低协作的沟通成本**。好的规范让每个人不需要问"这里该怎么写"就能做出一致的选择；坏的规范要么没人遵守，要么遵守了反而更慢。

本文不讲"应该有什么规范"，而是讲**每个规范为什么存在、不遵守会出什么问题、以及如何在团队中落地执行**。

---

## 一、代码规范与 lint 配置

### 1.1 为什么需要 lint

没有 lint 的团队，代码审查变成"格式警察"：审查者花 80% 的时间指出命名不规范、缺少 const、行太长，只有 20% 的时间看业务逻辑。**lint 把格式问题自动化，让人专注于真正需要人判断的事**。

### 1.2 Flutter 项目的 lint 配置

```yaml
# analysis_options.yaml
include: package:very_good_analysis/analysis_options.yaml

analyzer:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "lib/l10n/**"
  errors:
    invalid_annotation_target: ignore
  language:
    strict-casts: true
    strict-inference: true
    strict-raw-types: true

linter:
  rules:
    # 在 very_good_analysis 基础上调整
    public_member_api_docs: false  # 企业项目不强求文档注释
    prefer_single_quotes: true
    always_declare_return_types: true
    avoid_print: true
    avoid_unnecessary_containers: true
    sized_box_for_whitespace: true
    use_key_in_widget_constructors: true
```

### 1.3 very_good_analysis vs flutter_lints

| 维度 | very_good_analysis | flutter_lints |
|---|---|---|
| 规则数 | 100+ | ~30 |
| 严格程度 | 高（很多强制规则） | 低（推荐为主） |
| 适合项目 | 企业级、多人协作 | 个人项目、快速原型 |
| 维护方 | Very Good Ventures | Flutter 官方 |

**企业级项目用 very_good_analysis**。虽然初期会被 lint 报错困扰，但严格执行两周后，代码风格自然统一，审查中不再有格式争论。

### 1.4 lint 规则的渐进式引入

已有项目直接上 very_good_analysis 会产生几百个 lint 警告，改起来不现实。**渐进式引入**：

```yaml
# 第一步：只开启 error 级别的规则
analyzer:
  errors:
    # 把部分 warning 降级为 info，不阻塞 CI
    avoid_print: info
    prefer_single_quotes: info
```

```bash
# CI 静态分析（按档位渐进收紧，见注释）
dart analyze --fatal-infos  # 严格档：info 也算 fatal。渐进引入时应先用
# dart analyze --no-fatal-warnings 只挡 error，稳定后再收紧
```

逐步收紧：每周开启 5-10 条规则，在 Sprint 回顾中评估执行情况。

### 1.5 自定义 lint 规则

某些团队约定用自定义 lint 规则强制架构约束：

- **禁止在 Widget 中直接调用 Dio** → 强制走 Repository
- **禁止 import 另一个 feature 的实现类** → 强制模块解耦
- **Controller 中方法超过 20 行报警** → 强制拆分

实现方式：使用 [custom_lint](https://pub.dev/packages/custom_lint) 框架编写自定义规则。虽然投入较大，但对大型团队来说，**机器可执行的约束比文档约定可靠**。

---

## 二、Git 工作流：Git Flow / Trunk Based

### 2.1 两种工作流对比

| 维度 | Git Flow | Trunk Based |
|---|---|---|
| 核心思想 | 功能分支开发，合并到 develop | 所有人直接提交到 main |
| 分支模型 | main / develop / feature / release / hotfix | main + 短命 feature 分支 |
| 适合团队 | 有明确发版周期的团队 | 持续部署的团队 |
| 合并频率 | 低（feature 完成后合并） | 高（每天至少一次） |
| 冲突风险 | 高（长期分支累积大量差异） | 低（频繁集成，差异小） |
| 回滚复杂度 | 高（需要找到对应的 merge commit） | 低（revert 单个 commit） |

### 2.2 Git Flow 详解

```
main ──────────────────────────────── merge ──── merge ────
  \                                       /          /
   \── develop ────── merge ── merge ────/          /
         \          /         /                     /
          \─ feature/A ─────/   \── release/1.2 ──/
          \─ feature/B ─────────/
```

**适用场景**：App 有固定发版节奏（如每两周一个版本），测试团队需要在稳定分支上验证。

**Flutter 项目的 Git Flow 实践**：

- `feature/xxx`：功能开发分支
- `release/x.y.z`：发版准备分支，只修 bug 不加功能
- `hotfix/x.y.z`：线上紧急修复，从 main 拉出，合并回 main 和 develop
- `develop`：开发集成分支，CI 跑 lint + 单元测试
- `main`：对应线上版本，CI 跑全量测试 + 构建发版

### 2.3 Trunk Based 详解

```
main ── commit ── commit ── commit ── commit ── commit ──
         \          /           \         /
          commit─commit          commit─commit
          (feature A, <2天)     (feature B, <1天)
```

**适用场景**：团队能持续部署，功能可以用 Feature Flag 控制开关。

**Flutter 项目中 Trunk Based 的关键配套**：

1. **Feature Flag**：未完成的功能在入口处判断 Flag，Flag 关闭时用户看不到
2. **短命分支**：feature 分支存活不超过 2 天，超过则拆小
3. **PR 快速审查**：分支存活短，PR 必须当天审查完
4. **CI 门禁**：main 分支始终保持可发布状态

```dart
// Feature Flag 示例
class FeatureFlags {
  static const enableNewCart = bool.fromEnvironment('ENABLE_NEW_CART', defaultValue: false);
}

// UI 中
if (FeatureFlags.enableNewCart) {
  Navigator.pushNamed(context, AppRoutes.newCart);
} else {
  Navigator.pushNamed(context, AppRoutes.legacyCart);
}
```

### 2.4 Flutter 项目推荐工作流

**5 人以下团队**：Trunk Based + Feature Flag。减少分支管理负担，快速迭代。

**10 人以上团队**：Git Flow 或 GitHub Flow（main + feature 分支，无 develop）。正式的分支模型减少互相干扰。

**关键原则**：不管用哪种，**main 分支必须随时可发布**。如果 main 不能发布，说明 CI 门禁不够或者分支策略有问题。

---

## 三、代码审查机制

### 3.1 代码审查不是"找 Bug"

审查的首要目的不是找 bug（测试和 lint 做这件事），而是：
1. **知识传播**：让不止一个人了解每段代码
2. **架构一致性**：确保新代码符合项目架构约定
3. **隐性导师**：高级工程师通过审查传递设计思维

### 3.2 审查清单

与其让审查者"凭感觉"审查，不如提供结构化清单：

**架构层面**：
- [ ] 新代码是否在正确的层？（UI 逻辑不在 UseCase 中，业务逻辑不在 Controller 中）
- [ ] 是否违反了模块边界？（是否 import 了其他 feature 的实现类）
- [ ] 新增的依赖是否必要？是否有更轻量的替代方案？

**代码质量**：
- [ ] 方法是否超过 20 行？如果超过，是否应拆分
- [ ] 是否有硬编码的魔法值？（URL、颜色值、超时时间）
- [ ] 错误处理是否充分？空 catch、未处理的 Future

**Flutter 特定**：
- [ ] Widget 是否能加 `const`？
- [ ] Controller 中的业务逻辑是否应抽到 UseCase？
- [ ] 是否使用了 `ListView.builder` 而非 `ListView`（大列表场景）？

**测试**：
- [ ] 新增/修改的逻辑是否有对应测试？
- [ ] 测试是否覆盖了错误路径？

### 3.3 审查流程与 SLA

```
开发者提交 PR → CI 自动检查 (lint/test) → 人工审查 → 合并
```

**SLA（Service Level Agreement）**：

| PR 类型 | 审查时限 | 审查人数 |
|---|---|---|
| 功能开发 | 24 小时内 | 1 人（必须） |
| 架构变更 | 48 小时内 | 2 人（含架构师） |
| 紧急修复 | 4 小时内 | 1 人（可事后补审） |

**审查超时的处理**：超过 SLA 未审查的 PR，开发者有权在 IM 中 @ 审查者。超过 2 天未审查，PR 可由 Team Lead 直接审查合并。

### 3.4 审查中的常见反模式

**反模式 1："LGTM" 审查**

只看 diff 摘要就点 Approve。**对策**：要求审查者在 Approve 前至少写出一条具体反馈——哪怕是"这里命名很清晰"这种正面反馈。

**反模式 2：审查者重写代码**

审查者直接在评论中给出完整的重写代码，开发者直接复制粘贴。**这不是审查，是代写**。审查应该指出问题，让开发者自己思考解决方案。

**反模式 3：审查变成风格争论**

"这个变量应该叫 `isLoading` 还是 `loading`"。**对策**：风格问题交给 lint，审查者不提风格意见。如果 lint 没覆盖，加 lint 规则，而不是在 PR 里争论。

---

## 四、多模块团队分工与接口约定

### 4.1 按业务域分工

```
团队 A：用户域（登录/注册/个人中心）
团队 B：交易域（下单/支付/退款）
团队 C：内容域（商品列表/详情/搜索）
团队 D：基础设施（网络/存储/通用组件）
```

每个团队拥有自己负责的 package/feature 目录的**写权限**，其他团队只能通过公开接口访问。

### 4.2 接口约定：模块间的契约

```dart
// packages/module_user/lib/src/user_service.dart
abstract class UserService {
  Future<User> getCurrentUser();
  Future<int> getUserPoints();
  Stream<User> get onUserChanged;
}

// packages/module_user/lib/module_user.dart
export 'src/user_service.dart';  // 只导出接口，不导出实现
```

**原则**：
1. **只导出接口，不导出实现类**——消费者不应该依赖实现细节
2. **接口放在 `lib/` 下，实现放在 `lib/src/` 下**——Dart 的 `src/` 目录约定不对外暴露
3. **接口变更需要版本号+迁移期**——不能今天改接口明天让所有模块跟着改

### 4.3 接口版本管理

当接口需要变更时，采用**渐进式迁移**：

```dart
// 版本 1：旧接口
abstract class UserService {
  Future<User> getUser();
}

// 版本 2：新增接口，旧接口标记废弃
abstract class UserService {
  @Deprecated('Use getCurrentUser instead')
  Future<User> getUser();
  Future<User> getCurrentUser();
}

// 版本 3：移除旧接口（至少等一个 Sprint）
abstract class UserService {
  Future<User> getCurrentUser();
}
```

### 4.4 跨团队依赖的审批流程

```
团队 A 想在 module_order 中使用 module_user 的接口
  → PR 中 import module_user 的公开 API
  → CI 检查是否 import 了 src/ 下的类
  → 如果违反，CI 报错，PR 无法合并
```

**技术手段**：用 `dependency_validator` 包或自定义 lint 规则检查非法 import。

---

## 五、冲突治理与依赖版本锁定

### 5.1 Dart/Flutter 的依赖版本问题

```yaml
# pubspec.yaml
dependencies:
  dio: ^5.0.0   # 允许 5.x.x 的任何版本
```

开发者 A 今天 `pub get` 拿到 `dio 5.1.0`，开发者 B 明天 `pub get` 拿到 `dio 5.2.0`。两个版本的 API 略有不同，代码在 A 的机器上能跑，在 B 的机器上报错。

### 5.2 pubspec.lock：团队的版本契约

**规则**：`pubspec.lock` 必须提交到 Git 仓库。

```gitignore
# ❌ 不要忽略 pubspec.lock
# pubspec.lock   ← 注释掉或删除这行

# ✅ 只在纯 Dart 包（供他人依赖的库）中忽略 lock
# 对于应用项目，lock 文件必须提交
```

**为什么**：`pubspec.lock` 保证团队所有人用的依赖版本完全一致。对于应用项目（不会被人依赖），lock 文件是团队共识；对于库项目（被人依赖），lock 文件不影响消费者。

### 5.3 依赖升级策略

| 策略 | 频率 | 执行者 | 风险 |
|---|---|---|---|
| 定期升级 | 每 Sprint 一次 | 指定负责人 | 可控，升级失败不影响开发 |
| 随意升级 | 有人想起就升 | 任何人 | 不可控，可能破坏其他人的工作 |

**推荐定期升级**：

```bash
# 升级 minor 版本（5.1→5.2；升 patch 用 --patch）
dart pub upgrade --minor-versions

# 升级主版本（需要手动改 pubspec.yaml 约束）
# 修改约束后
dart pub get
```

**升级后的验证**：

1. 运行全量测试
2. 启动 App 走一遍核心流程
3. 确认构建产物无异常

**单独提交升级 PR**：升级依赖的 PR 不要混入功能代码，这样出问题时可以独立回滚。

### 5.4 多模块的依赖版本统一

多个 package 各自的 `pubspec.yaml` 中可能引用了不同版本的同一依赖：

```
module_user → dio: ^5.0.0
module_order → dio: ^5.1.0
component_network → dio: ^5.2.0
```

Flutter 的依赖解析会取**兼容范围内的最高版本**，但约束不一致可能导致解析失败。

**治理方案**：

1. **统一依赖版本文件**：创建 `melos.yaml` 或自定义脚本，扫描所有 pubspec.yaml 的依赖版本，报告不一致
2. **使用 Melos**：多 package 管理工具，支持统一版本号

```yaml
# melos.yaml
name: my_project
packages:
  - packages/**
command:
  version:
    # 统一管理依赖版本
```

```bash
# 检查所有 package 的依赖是否一致
melos exec -- "dart pub deps"
```

### 5.5 Git 冲突的预防与解决

**预防**：

1. **频繁合并 develop/main**：每天至少 rebase 一次最新代码
2. **文件所有权**：每个文件有明确的 Owner，减少多人同时改同一文件
3. **小 PR**：每个 PR 不超过 300 行变更，减少冲突面积
4. **拆分大文件**：一个 2000 行的 Controller 改任何功能都会产生冲突，拆成多个小 Controller

**解决**：

1. **让产生冲突的双方一起解决**：不要自己解决别人代码的冲突
2. **冲突解决后必须运行测试**：Git 合并只是文本拼接，逻辑正确性需要测试验证
3. **记录冲突模式**：如果同一对文件反复冲突，说明架构有问题，需要重新划分模块边界

---

## 常见坑

### 1. lint 规则太严导致团队抵触

上来就开 100 条规则，开发者花 1 小时改 lint 才能提交一个 5 分钟的功能。**解法**：分批引入，初期只开 error 级别，每周增加 5 条 warning 规则，给团队适应期。

### 2. PR 积压导致开发节奏被打断

20 个 PR 等待审查，开发者闲等 3 天。**解法**：设立"审查值班"制度，每天有一人专职审查 PR（轮换），审查优先于自己的开发任务。

### 3. pubspec.lock 不一致导致"在我机器上能跑"

某位开发者 `pub get` 生成了新的 lock 文件但没有提交。**解法**：CI 中增加检查步骤——如果 `pubspec.lock` 与仓库版本不一致，CI 报错。

```yaml
- name: Check pubspec.lock
  run: |
    dart pub get
    git diff --exit-code pubspec.lock
```

### 4. 多模块团队间的"接口变更突袭"

团队 A 修改了 `UserService` 接口，没有通知团队 B，导致团队 B 的功能突然编译不过。**解法**：接口变更必须走 RFC 流程——在团队共享文档中描述变更内容、影响范围、迁移方案，至少提前 3 天通知受影响团队。

### 5. 依赖升级引入 Breaking Change

升级 `dio` 从 5.x 到 6.x，API 全变了，所有网络请求报错。**解法**：升级主版本前必须：
1. 阅读 CHANGELOG 和 Migration Guide
2. 在独立分支上升级并跑全量测试
3. 评估工作量，如果超过 1 天，排入 Sprint 计划

---

## 面试追问

### 为什么非常强调 pubspec.lock 要提交？

因为 Flutter 应用的依赖版本必须在所有环境中一致。如果 A 用 `dio 5.1.0`、B 用 `dio 5.2.0`，即使 API 兼容，行为差异（如默认超时时间）也可能导致 bug。`pubspec.lock` 是团队对"我们用哪些版本"的共识，锁定了这个共识，才能保证构建的可重复性。

### Git Flow 和 Trunk Based 的核心取舍是什么？

**冲突风险 vs 发版控制**。Git Flow 用长期分支隔离开发，发版可控但分支越久冲突越大；Trunk Based 频繁集成消除冲突，但要求每个 commit 都能发布（通过 Feature Flag 控制）。选择取决于你的发布节奏：有固定发版周期的选 Git Flow，持续部署的选 Trunk Based。

### 代码审查中遇到架构分歧怎么办？

审查者和开发者对架构方案有不同意见。**处理流程**：
1. 在 PR 评论中各自陈述理由
2. 如果 30 分钟内无法达成一致，升级到 Team Lead 仲裁
3. 仲裁决定在 PR 中记录理由，作为未来类似决策的参考
4. **不要在 PR 中反复拉锯**——超过 3 轮未达成一致的评论说明需要更高层决策

### 如何防止"面条式 import"导致模块边界被打破？

1. **技术手段**：自定义 lint 规则检查 `import 'package:module_x/src/` 的引用
2. **流程手段**：CI 中运行 `dependency_validator`，报告非法依赖
3. **组织手段**：每个模块有明确的 Owner，跨模块修改需要 Owner 审查
4. **可视化**：用 `dart pub deps --json` 生成依赖图，定期 review 是否有循环依赖

### 大型 Flutter 项目（50+ 人）如何管理代码所有权？

1. **CODEOWNERS 文件**：Git 平台原生支持，指定每个目录的审查者
2. **分层审批**：通用组件的变更需要架构师审批，业务模块的变更只需模块 Owner 审批
3. **自动化权限检查**：CI 中检查 PR 的审查者是否符合 CODEOWNERS 要求
4. **定期轮换**：Owner 每季度轮换一次，避免知识孤岛

```
# CODEOWNERS 示例
/packages/module_user/    @team-user
/packages/module_order/   @team-order
/packages/core/           @architects
/lib/app/routes/          @architects
```

---

## 参考资源

- [Very Good Analysis](https://pub.dev/packages/very_good_analysis)
- [Melos - 多包管理工具](https://pub.dev/packages/melos)
- [Trunk Based Development](https://trunkbaseddevelopment.com/)
- [Google Engineering Practices - Code Review](https://google.github.io/eng-practices/review/)
- [Dart 依赖管理最佳实践](https://dart.dev/tools/pub/dependencies)
