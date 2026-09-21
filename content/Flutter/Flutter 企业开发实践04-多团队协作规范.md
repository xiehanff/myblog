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

一个人写代码，规范不重要，代码都在脑子里。但 5 个、10 个、20 个人一起改一个 Flutter 仓库，没规范就是灾难：PR 里的代码风格各不一样、合并冲突永远合不完、审查就是走个形式点个"LGTM"、依赖版本满天飞。

规范的作用就一条：**降低协作的沟通成本**。规范定得好，每个人不用问"这里该怎么写"，就能做出一致的选择；定得不好，要么没人遵守，要么照着做反而更慢。

这篇不讲"应该有什么规范"，只讲**每条规范为什么存在、不遵守会出什么问题、在团队里怎么落地**。

---

## 一、代码规范与 lint 配置

### 1.1 为什么非得有 lint

团队没有 lint，审查就变成了"格式警察"：审查者 80% 的时间在指命名不规范、少写 const、行太长，只有 20% 的时间看业务逻辑。**格式问题交给 lint 自动化，人只看真正需要判断的东西**。

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

**企业项目就选 very_good_analysis**。开头肯定被一堆 lint 报错烦得不行，但严格扛上两周，风格自然就统一了，审查里也不用再吵格式。

### 1.4 lint 规则怎么渐进引入

老项目直接上 very_good_analysis，一下会冒出几百个 lint 警告，根本改不完。所以得**渐进式引入**：

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

有些团队会把架构约定写成自定义 lint 规则，靠工具硬推：

- **禁止在 Widget 中直接调用 Dio** → 强制走 Repository
- **禁止 import 另一个 feature 的实现类** → 强制模块解耦
- **Controller 中方法超过 20 行报警** → 强制拆分

怎么实现：用 [custom_lint](https://pub.dev/packages/custom_lint) 框架自己写规则。投入不算小，但对大团队来说，**机器能执行的约束比文档里的约定可靠**。

---

## 二、Git 工作流：Git Flow / Trunk Based

### 2.1 两种工作流对比

| 维度 | Git Flow | Trunk Based |
|---|---|---|
| 核心思想 | 功能分支开发，合并到 develop | 所有人直接提交到 main |
| 分支模型 | main / develop / feature / release / hotfix | main + 短命 feature 分支 |
| 适合团队 | 有明确发版周期的团队 | 持续部署的团队 |
| 合并频率 | 低（feature 完成后合并） | 高（每天至少一次） |
| 冲突风险 | 高（长期分支攒下的差异多） | 低（频繁集成，差异小） |
| 回滚复杂度 | 高（得找到对应的 merge commit） | 低（revert 单个 commit） |

### 2.2 Git Flow 详解

```
main ──────────────────────────────── merge ──── merge ────
  \                                       /          /
   \── develop ────── merge ── merge ────/          /
         \          /         /                     /
          \─ feature/A ─────/   \── release/1.2 ──/
          \─ feature/B ─────────/
```

**什么时候用**：App 有固定的发版节奏（比如每两周一个版本），测试团队需要在稳定分支上验证。

**Flutter 项目里 Git Flow 怎么用**：

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

**什么时候用**：团队能持续部署，功能可以用 Feature Flag 控制开关。

**在 Flutter 项目里跑 Trunk Based，有几件事得配套**：

1. **Feature Flag**：没做完的功能在入口处判一下 Flag，Flag 关着用户就看不到
2. **短命分支**：feature 分支活不过 2 天，超了就拆小
3. **PR 快速审查**：分支活得短，PR 必须当天审完
4. **CI 门禁**：main 分支任何时候都得是可发布的状态

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

### 2.4 Flutter 项目该选哪种

**5 人以下团队**：Trunk Based + Feature Flag。分支管理的负担小，迭代快。

**10 人以上团队**：Git Flow 或 GitHub Flow（main + feature 分支，无 develop）。有个正式的分支模型，团队之间少互相干扰。

**关键原则**：不管用哪种，**main 分支必须随时可发布**。main 发不出去，要么是 CI 门禁卡不住，要么是分支策略本身有问题。

---

## 三、代码审查机制

### 3.1 代码审查不是"找 Bug"

审查第一目的是下面这几件事，找 bug 交给测试和 lint 就行：
1. **知识传播**：一段代码别只有你一个人看得懂
2. **架构一致性**：新代码得跟项目已有的架构约定对齐
3. **隐性导师**：高级工程师借审查把设计思路传下去

### 3.2 审查清单

让审查者"凭感觉"看，不如直接给一份结构化清单：

**架构层面**：
- [ ] 新代码放对层了吗？（UI 逻辑不放在 UseCase，业务逻辑不放在 Controller）
- [ ] 有没有越模块边界？（是不是 import 了别的 feature 的实现类）
- [ ] 新加的依赖真的需要吗？有没有更轻的替代方案？

**代码质量**：
- [ ] 方法超过 20 行了吗？超过了就该拆
- [ ] 有没有硬编码的魔法值？（URL、颜色值、超时时间）
- [ ] 错误处理够不够？空 catch、没处理的 Future

**Flutter 特定**：
- [ ] 这个 Widget 能不能加 `const`？
- [ ] Controller 里的业务逻辑该不该抽到 UseCase？
- [ ] 大列表是不是用了 `ListView.builder` 而不是 `ListView`？

**测试**：
- [ ] 新增或改过的逻辑，有没有对应测试？
- [ ] 错误路径测到了吗？

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

**超时了怎么办**：过了 SLA 没人审的 PR，开发者可以直接在 IM 里 @ 审查者。拖过 2 天，PR 就让 Team Lead 直接审完合掉。

### 3.4 审查里常见的几个反模式

**反模式 1："LGTM" 审查**

只看一眼 diff 摘要就点 Approve。**对策**：定一条规矩，Approve 之前至少写一条具体反馈，哪怕就是"这里命名很清晰"这种夸人的话。

**反模式 2：审查者重写代码**

审查者直接在评论里丢一份完整的重写代码，开发者复制粘贴就完事。**这就是代写**。审查要做的是把问题指出来，方案让开发者自己想。

**反模式 3：审查变成风格争论**

为"这个变量该叫 `isLoading` 还是 `loading`"这种问题吵半天。**对策**：风格问题交给 lint，审查者不提风格意见。lint 没覆盖到，就去补一条规则，而不是在 PR 里争论。

---

## 四、多模块团队分工与接口约定

### 4.1 按业务域分工

```
团队 A：用户域（登录/注册/个人中心）
团队 B：交易域（下单/支付/退款）
团队 C：内容域（商品列表/详情/搜索）
团队 D：基础设施（网络/存储/通用组件）
```

每个团队对自己负责的 package/feature 目录有**写权限**，别的团队只能从公开接口进。

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

**三条原则**：
1. **只导出接口，不导出实现类**：调用方别去依赖实现细节
2. **接口放在 `lib/` 下，实现放在 `lib/src/` 下**：Dart 的 `src/` 目录约定就是不对外暴露
3. **接口变更需要版本号+迁移期**：不能今天改完接口，明天让所有模块跟着改

### 4.3 接口版本管理

接口要改的时候，走**渐进式迁移**：

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

**怎么查**：用 `dependency_validator` 包，或者自定义 lint 规则，把非法 import 揪出来。

---

## 五、冲突治理与依赖版本锁定

### 5.1 Dart/Flutter 的依赖版本问题

```yaml
# pubspec.yaml
dependencies:
  dio: ^5.0.0   # 允许 5.x.x 的任何版本
```

A 今天 `pub get` 拉到 `dio 5.1.0`，B 明天 `pub get` 拉到 `dio 5.2.0`。两个版本的 API 差一点点，代码在 A 的机器上跑得好好的，到 B 的机器上就报错。

### 5.2 pubspec.lock：团队的版本契约

**规则就一条**：`pubspec.lock` 必须提交进 Git 仓库。

```gitignore
# ❌ 不要忽略 pubspec.lock
# pubspec.lock   ← 注释掉或删除这行

# ✅ 只在纯 Dart 包（供他人依赖的库）中忽略 lock
# 对于应用项目，lock 文件必须提交
```

**为什么**：`pubspec.lock` 保证全团队用的依赖版本一模一样。应用项目（不会被别人依赖）里，lock 文件就是团队的共识；库项目（会被别人依赖）里，lock 文件影响不到使用者。

### 5.3 依赖升级策略

| 策略 | 频率 | 执行者 | 风险 |
|---|---|---|---|
| 定期升级 | 每 Sprint 一次 | 指定负责人 | 可控，升级挂了也不耽误开发 |
| 随意升级 | 有人想起就升 | 任何人 | 不可控，可能把别人的活搞坏 |

**推荐定期升**：

```bash
# 升级 minor 版本（5.1→5.2；升 patch 用 --patch）
dart pub upgrade --minor-versions

# 升级主版本（需要手动改 pubspec.yaml 约束）
# 修改约束后
dart pub get
```

**升级完怎么验**：

1. 跑一遍全量测试
2. 启动 App，把核心流程走一遍
3. 看构建产物有没有异常

**升级 PR 单独提**：升级依赖的 PR 别掺功能代码，出问题的时候才能单独回滚。

### 5.4 多模块的依赖版本统一

几个 package 自己的 `pubspec.yaml` 里，可能引用了同一个依赖的不同版本：

```
module_user → dio: ^5.0.0
module_order → dio: ^5.1.0
component_network → dio: ^5.2.0
```

Flutter 解析依赖时会取**兼容范围内最高的那个版本**，但约束不一致，解析就可能直接失败。

**怎么治理**：

1. **统一依赖版本文件**：建一个 `melos.yaml`，或者自己写脚本，把所有 pubspec.yaml 的依赖版本扫一遍，把不一致的报出来
2. **上 Melos**：多 package 管理工具，版本号可以统一管

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

### 5.5 Git 冲突怎么预防、怎么解

**先预防**：

1. **勤合并 develop/main**：每天至少 rebase 一次最新代码
2. **文件所有权**：每个文件都有明确的 Owner，少让几个人同时改同一个文件
3. **PR 开小一点**：一个 PR 变更不超过 300 行，冲突面就小
4. **大文件拆开**：一个 2000 行的 Controller，改哪个功能都会撞冲突，拆成几个小 Controller

**出冲突了再解决**：

1. **让冲突双方一起解**：别人代码的冲突别自己闷头解
2. **解完必须跑测试**：Git 合并只是把文本拼起来，逻辑对不对得靠测试验
3. **记一下冲突模式**：同一对文件反复冲突，说明架构有问题，模块边界该重划了

---

## 常见坑

### 1. lint 规则太严，团队直接抵触

上来就开 100 条规则，写个 5 分钟的功能，得先花 1 小时改 lint 才能提交。**解法**：分批上，一开始只开 error 级别，每周加 5 条 warning 规则，给团队留适应期。

### 2. PR 积压，开发节奏被打断

20 个 PR 排着队等人审，开发者干等 3 天。**解法**：上个"审查值班"制度，每天轮一个人专门审 PR，审别人的 PR 排在自己的开发任务前面。

### 3. pubspec.lock 不一致，"在我机器上能跑"

有人 `pub get` 生出了新的 lock 文件，忘了提交。**解法**：CI 里加一步检查，`pubspec.lock` 跟仓库里的版本对不上，CI 直接报错。

```yaml
- name: Check pubspec.lock
  run: |
    dart pub get
    git diff --exit-code pubspec.lock
```

### 4. 多模块团队间的"接口变更突袭"

团队 A 改了 `UserService` 接口，没跟团队 B 打招呼，团队 B 的功能突然就编不过了。**解法**：接口变更必须走 RFC 流程，在共享文档里写清楚改了什么、影响谁、怎么迁移，至少提前 3 天通知受影响的团队。

### 5. 依赖升级引入 Breaking Change

`dio` 从 5.x 升到 6.x，API 全变了，所有网络请求一起报错。**解法**：升主版本之前，这几步必须走：
1. 把 CHANGELOG 和 Migration Guide 读一遍
2. 拉个独立分支升级，跑全量测试
3. 估一下工作量，超过 1 天就排进 Sprint 计划

---

## 面试追问

### 为什么一直强调 pubspec.lock 要提交？

因为 Flutter 应用的依赖版本在所有环境里都得一致。A 用 `dio 5.1.0`、B 用 `dio 5.2.0`，就算 API 兼容，行为上也会有差别（比如默认超时时间），照样出 bug。`pubspec.lock` 是团队对"我们用哪些版本"的共识，把这个共识锁住，构建才能重复得出来。

### Git Flow 和 Trunk Based 的核心取舍是什么？

**这是在冲突风险和发版控制之间选**。Git Flow 靠长期分支把开发隔开，发版可控，但分支活得越久冲突越大；Trunk Based 靠频繁集成把冲突磨掉，代价是每个 commit 都得能发布（用 Feature Flag 控制）。选哪个看你的发版节奏：有固定发版周期的走 Git Flow，持续部署的走 Trunk Based。

### 代码审查中遇到架构分歧怎么办？

审查者和开发者对架构方案意见不一样。**怎么处理**：
1. 各自在 PR 评论里把理由讲清楚
2. 30 分钟内谈不拢，升级给 Team Lead 仲裁
3. 仲裁决定连同理由记在 PR 里，以后碰到类似的决策能回头看
4. **别在 PR 里反复拉锯**：评论超过 3 轮还没谈拢，就该往上拍板了

### 怎么防止"面条式 import"打破模块边界？

1. **靠工具**：自定义 lint 规则，盯 `import 'package:module_x/src/` 这种引用
2. **靠流程**：CI 里跑 `dependency_validator`，把非法依赖报出来
3. **靠组织**：每个模块有明确的 Owner，改别的模块得 Owner 审
4. **靠图**：用 `dart pub deps --json` 生成依赖图，定期 review 有没有循环依赖

### 大型 Flutter 项目（50+ 人）如何管理代码所有权？

1. **CODEOWNERS 文件**：Git 平台自带，给每个目录指定审查者
2. **分层审批**：通用组件的改动要架构师批，业务模块的改动模块 Owner 批就行
3. **自动查权限**：CI 里检查 PR 的审查者符不符合 CODEOWNERS 的要求
4. **定期轮换**：Owner 每季度换一次，免得知识全攒在一个人手里

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
