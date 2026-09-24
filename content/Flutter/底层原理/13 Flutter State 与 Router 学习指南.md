# Flutter 学习顺序：Riverpod 3.0 + go_router

这份文档只关注 Flutter 侧的常用内容，目标是先把最常用的状态管理和路由能力学会，再考虑更进阶的特性。

## 先学 Riverpod，再学 go_router

建议顺序是：先学 Riverpod 的状态与依赖注入，再学 go_router 的页面跳转与参数传递。这样更容易把"状态变化"和"页面跳转"分开理解。

## Riverpod 3.0 学习顺序

1. `Getting started`
   - 先搞清楚 `ProviderScope`、`ConsumerWidget`、`WidgetRef` 是什么。
   - 目标是能让 Flutter App 读取 provider。
   - 官方链接：
   - [Getting started](https://riverpod.dev/docs/introduction/getting_started)

2. `Providers`
   - 先认识 `Provider`、`NotifierProvider`、`AsyncNotifierProvider`、`Provider.family`。
   - 重点理解：什么是状态，什么是派生值，什么是依赖注入。
   - 官方链接：
   - [Providers](https://riverpod.dev/docs/concepts2/providers)

3. `Refs`
   - 重点学 `ref.watch`、`ref.read`、`ref.listen`。
   - 记住一个简单规则：
   - 展示用 `watch`
   - 动作用 `read`
   - 副作用用 `listen`
   - 官方链接：
   - [Refs](https://riverpod.dev/docs/concepts2/refs)

4. `select`
   - 只在你想减少局部重建时学它。
   - 适合只关心某个字段、某个布尔值、某个派生结果的场景。
   - 官方链接：
   - [How to reduce provider/widget rebuilds](https://riverpod.dev/docs/how_to/select)

5. `Scopes`
   - 只看 Flutter 里最常见的用法：`ProviderScope`、override、测试隔离。
   - 先不用深挖很复杂的作用域技巧。
   - 官方链接：
   - [Scopes](https://riverpod.dev/docs/concepts/scopes)

6. `What's new in Riverpod 3.0` 和 `Migration`
   - 只看和 Flutter 开发最相关的变化：
   - `Ref.mounted`
   - 自动重试
   - 生命周期变化
   - `ProviderScope` / `ProviderContainer` 的行为变化
   - 官方链接：
   - [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
   - [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration)

### Riverpod 暂时可以先跳过的内容

- 代码生成的所有细节
- `offline persistence`
- `mutations`
- 很深的 `ProviderContainer` 手动管理
- 复杂的生命周期定制

## go_router 学习顺序

1. 先看整体介绍
   - 先理解 go_router 是“基于 URL 的声明式路由”。
   - 重点不是所有 API，而是它怎么把页面、URL、深链和跳转统一起来。
   - go_router 由 Flutter 团队维护（pub.dev 上的发布者是 flutter.dev），底层基于 Navigator 2.0 的 Router API，是 Flutter 官方文档推荐的声明式路由方案；目前处于功能完备（feature-complete）阶段，官方重心是修 bug 和保持稳定。
   - 官方链接：
   - [go_router package](https://pub.dev/packages/go_router)
   - [go_router API docs](https://pub.dev/documentation/go_router/latest/)
   - [Navigation and routing](https://docs.flutter.dev/ui/navigation)

2. `Configuration`
   - 先学 `GoRouter`、`GoRoute`、路由表怎么写。
   - 目标是能定义首页、详情页、登录页这种基础路由。
   - 官方链接：
   - [GoRouter class](https://pub.dev/documentation/go_router/latest/go_router/GoRouter-class.html)
   - [GoRoute class](https://pub.dev/documentation/go_router/latest/go_router/GoRoute-class.html)

3. `Navigation`
   - 先学 `context.go`、`context.push`、`context.pop`。
   - 只需要先掌握“替换当前页”和“压栈进入新页”的区别。
   - 官方链接：
   - [go_router API docs](https://pub.dev/documentation/go_router/latest/)

4. `Path parameters` 和 `Query parameters`
   - 先学最常见的两种参数：
   - 路径参数：`/product/:id`
   - 查询参数：`/search?keyword=phone&page=1`
   - 官方链接：
   - [go_router package](https://pub.dev/packages/go_router)

5. `Redirection`
   - 先学登录守卫和简单跳转，不要一开始就碰复杂权限系统。
   - 官方链接：
   - [GoRouter class](https://pub.dev/documentation/go_router/latest/go_router/GoRouter-class.html)

6. `Named routes`
   - 先学能不能用名字跳转即可。
   - 如果你项目里 URL 直接写得清楚，名字路由不是第一优先级。
   - 官方链接：
   - [go_router API docs](https://pub.dev/documentation/go_router/latest/)

### go_router 暂时可以先跳过的内容

- `ShellRoute`
- 多 Navigator 嵌套
- `Transition animations`
- `Web` 专项细节
- `Deep linking` 的高级场景
- `State restoration`
- `Type-safe routes` / 代码生成
- 复杂的 `Error handling`

## 建议的实战练习顺序

1. 用 Riverpod 做一个计数器页面，练 `NotifierProvider`。
2. 用 Riverpod 做一个异步用户资料页，练 `AsyncNotifierProvider`。
3. 用 Riverpod 做一个按 id 读取详情的页面，练 `Provider.family`。
4. 用 go_router 做首页、详情页、登录页跳转。
5. 把登录守卫接到 `redirect`。
6. 最后再用 `select` 优化局部刷新。

## 最后建议

如果你只想先会用，不想一开始就学太多，先把下面 5 个关键词学透就够了：

- `ProviderScope`
- `ConsumerWidget`
- `ref.watch`
- `ref.read`
- `GoRouter`

## 附录：Riverpod 官方 first app 教程中文整理

这个附录基于官方英文原版教程 [Your first Riverpod app](https://riverpod.dev/docs/tutorials/first_app)。教程的核心不是“做一个笑话生成器”本身，而是通过一个最小可运行示例，把 Riverpod 的完整使用链路走一遍。

### 1. 教程目标

先记住这 4 个重点：

- 学会把 Riverpod 安装进 Flutter 项目
- 学会写第一个 provider 去请求网络数据
- 学会用 `Consumer` 把 provider 的值显示到 UI
- 学会处理 `AsyncValue` 的加载态和错误态

### 2. 先搭一个静态 UI

教程一开始并不急着接网络，而是先写一个静态页面。

这样做的原因很直接：

- 先把页面结构定下来
- 后面只需要把静态文本替换成动态数据
- 更容易看出 Riverpod 介入后到底改了什么

### 3. 把 Riverpod 接入项目

教程里需要做两件事：

- 添加 `flutter_riverpod`
- 在 `main` 外层包一层 `ProviderScope`

`ProviderScope` 是 Riverpod 正常工作的入口，没有它，provider 无法被正确管理。

### 4. 先定义数据模型

教程使用一个随机笑话 API，返回的数据大致包含：

- `type`
- `setup`
- `punchline`
- `id`

然后定义一个 `Joke` 模型，并通过 `fromJson` 把 JSON 转成对象。

这一步的意义是把“网络返回值”转换成“业务对象”，后面的 UI 和 provider 都围绕这个对象来写。

### 5. 写一个真正请求网络的方法

模型准备好以后，再写 `fetchRandomJoke()` 这种函数去请求接口。

教程这里故意不手动 `try/catch`，因为它想把错误交给 Riverpod 来处理。

这对应一个很重要的思路：

- 网络请求本身负责抛出错误
- Riverpod 负责把错误包装成可观察状态
- UI 负责展示 loading / error / data

### 6. 用 `FutureProvider` 缓存请求结果

因为 `fetchRandomJoke()` 返回的是 `Future<Joke>`，所以教程使用 `FutureProvider<Joke>`。

这样写有两个关键效果：

- provider 会缓存结果
- 多处读取时不会重复发请求

这一点很适合“页面展示远程数据”的场景。

### 7. 用 `Consumer` 让 UI 读取 provider

当 provider 准备好以后，就要把 UI 包进 `Consumer`。

`Consumer` 的作用是：

- 读取 provider
- 当 provider 变化时自动重建局部 UI

它的思路和 `StreamBuilder` 有点像，但它是 Riverpod 体系里的标准入口。

### 8. 用 `ref.watch` 读取数据

在 `Consumer` 的 `builder` 里，教程调用：

```dart
final randomJoke = ref.watch(randomJokeProvider);
```

这里拿到的不是 `Joke`，而是 `AsyncValue<Joke>`。

这点要特别记住：

- `watch` 是“订阅变化”
- `FutureProvider` 返回的是异步状态封装
- 真正的数据、加载态、错误态都包含在 `AsyncValue` 里

### 9. 用 `AsyncValue` 处理三种状态

教程推荐用 `switch` 或模式匹配来处理：

- 有数据时显示笑话
- 出错时显示错误文本
- 没完成时显示加载指示器

可以把它理解成三态分支：

- `data`
- `error`
- `loading`

这一步是 Riverpod 最实用的地方之一，因为你不需要自己再维护 `isLoading = true/false` 这种手动标志位。

### 10. 用 `ref.invalidate` 重新请求

教程里的按钮“Get another joke”不是手动改状态，而是直接：

```dart
ref.invalidate(randomJokeProvider);
```

这会让 provider 重新执行，从而发起新的请求。

这比手写一套刷新状态更干净，也更符合 Riverpod 的设计。

### 11. 理解 `isRefreshing`

教程最后补了一个很实用的细节：再次刷新时，旧数据不会立刻消失。

这时可以用 `randomJoke.isRefreshing` 判断当前是不是“正在刷新但仍有旧值”。

常见用途是：

- 保留旧内容
- 同时在顶部显示一个 `LinearProgressIndicator`

这能让刷新体验更平滑，不会出现页面闪烁。

### 12. 这个教程真正教会你的事

看完这个 first app 教程，应该能形成下面这条最小闭环：

1. 用 `ProviderScope` 启动 Riverpod
2. 用 `FutureProvider` 提供异步数据
3. 用 `Consumer` + `ref.watch` 读取状态
4. 用 `AsyncValue` 分别处理 loading / error / data
5. 用 `ref.invalidate` 触发重新请求

这条链路几乎就是 Riverpod 最常见的入门模板。

### 13. 和本地学习文档的关系

如果把这篇官方教程放回到你这份学习顺序里，它最适合用来补这几个概念：

- `ProviderScope`
- `FutureProvider`
- `Consumer`
- `ref.watch`
- `AsyncValue`
- `ref.invalidate`

它们正好是后面学习更复杂状态管理和路由联动的基础。

### 14. 官方原文链接

- [Your first Riverpod app](https://riverpod.dev/docs/tutorials/first_app)
- [Providers](https://riverpod.dev/docs/concepts2/providers)
- [Refs](https://riverpod.dev/docs/concepts2/refs)
- [AsyncValue](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/AsyncValue-class.html)

## 附录 2：Riverpod 官方概念页中文整理

这一部分基于官方英文原版概念页里最适合入门的三块：`Providers`、`Consumers`、`Refs`。它们和上面的 first app 教程是配套的，教程负责带你跑通流程，概念页负责解释“为什么这样写”。

### 1. Providers 是什么

官方对 provider 的定位很清楚：它是 Riverpod 应用的核心，用来封装一段状态，并允许别处监听这段状态。

你可以把 provider 理解成“带缓存的函数”或“更可组合的状态入口”。

它带来的几个直接好处是：

- 可以在多个地方复用同一份状态
- 可以把多个状态自然组合起来
- 可以缓存昂贵计算，减少重复执行
- 更容易测试和覆盖依赖

这也是 Riverpod 可以替代一部分单例、服务定位器、依赖注入和 `InheritedWidget` 使用场景的原因。

### 2. 常见 provider 类型

官方概念页把 provider 按用途分得很清楚。Riverpod 3.0 的主流变体是下面 6 种：

- `Provider`：返回任意对象，适合服务类和派生计算
- `FutureProvider`：适合异步请求结果
- `StreamProvider`：适合流式数据
- `NotifierProvider`：可变状态的标准写法，适合大多数本地状态
- `AsyncNotifierProvider`：可变的异步状态，可以看作 `FutureProvider` 的"可写"版本
- `StreamNotifierProvider`：可变的流式状态

要注意一个版本差异：`StateProvider`、`StateNotifierProvider`、`ChangeNotifierProvider` 在 3.0 里被官方标记为 legacy，移到了单独的导入（`import 'package:flutter_riverpod/legacy.dart';`），新代码推荐用 `Notifier` 系列替代，只有接手旧项目时才需要认识它们。

如果你刚开始学，优先顺序通常是：

1. `Provider`
2. `FutureProvider`
3. `NotifierProvider`
4. `AsyncNotifierProvider`

### 3. `Provider.family` 和 `autoDispose`

官方把 `family` 和 `autoDispose` 放在 provider 的修饰符里。

- `family` 用来让 provider 接收外部参数
- `autoDispose` 用来在无人监听时自动销毁 provider

这两个特性经常组合使用，例如：

```dart
final userProvider = FutureProvider.autoDispose.family<User, int>(
  (ref, userId) async {
    return fetchUser(userId);
  },
);
```

如果你要按 `id`、`keyword`、`page` 这类参数读数据，`family` 会非常常用。

### 4. Consumers 是什么

官方把 `Consumer` 看成连接 Widget 树和 Provider 树的桥梁。

它的作用很直接：

- 给 Widget 提供 `ref`
- 让 Widget 能读取 provider
- 让 Widget 能在 provider 变化时自动重建

常见的三种消费者组件是：

- `Consumer`
- `ConsumerWidget`
- `ConsumerStatefulWidget`

入门阶段最推荐的默认选择是：

- 页面大多用 `ConsumerWidget`
- 需要本地生命周期或控制器时，用 `ConsumerStatefulWidget`

如果你只是想在现有 `StatelessWidget` 里局部接入 Riverpod，`Consumer` 也很合适。

### 5. 为什么不直接用 `StatelessWidget + context.watch`

官方给出的核心原因是：Riverpod 很重视自动释放和生命周期可靠性。

只依赖 `BuildContext` 的做法会让自动销毁在一些边界情况下不够稳定，可能导致：

- 资源无法及时释放
- 旧 provider 继续在后台工作
- 网络请求、定时器之类的逻辑无法正确停止

所以 Riverpod 宁愿多引入一个 `Consumer` 体系，也不把便利性放在可靠性前面。

### 6. Refs 是什么

`Ref` 是你和 provider 交互的主要入口。

可以把它理解成“面向 provider 的上下文对象”，它类似 Flutter 的 `BuildContext`，但服务对象是 provider。

通过 `ref` 你可以做这些事：

- 读取或观察 provider
- 重置 provider
- 监听 provider 生命周期
- 触发副作用

### 7. `watch`、`listen`、`read` 的分工

这三个 API 是最值得先记牢的。

- `ref.watch`：声明式监听，最常用，UI 读取状态优先用它
- `ref.listen`：手动监听，适合副作用
- `ref.read`：只读取一次，适合按钮点击和一次性动作

简单规则仍然是：

- 展示用 `watch`
- 副作用用 `listen`
- 动作用 `read`

但官方特别提醒过一点：不要为了“优化”而用 `read` 去替代 `watch`，否则 UI 很容易和状态不同步。真要减少重建，优先考虑 `select`。

### 8. `select` 的位置

`select` 的作用是只监听状态里你真正关心的那一小部分。

例如你只想看一个布尔值，就不要整份状态都重建。

```dart
final isEven = ref.watch(
  counterProvider.select((count) => count.isEven),
);
```

它适合：

- 布尔判断
- 单个字段
- 派生结果

### 9. 生命周期监听

官方还强调了 `ref.onDispose`、`ref.onCancel` 这类生命周期钩子。

它们很像 Widget 里的 `initState` / `dispose`，但作用范围在 provider 上。

常见用途是：

- 取消定时器
- 清理监听
- 停止不再需要的后台工作

这也是 Riverpod 自动释放特性的重要组成部分。

### 10. `invalidate` 和 `refresh`

官方把 `ref.invalidate` 解释为“重置 provider 状态”。

如果你需要重置后立刻读新值，可以继续 `ref.read`，或者直接用 `ref.refresh` 一步完成。

这和 first app 里的“再来一个笑话”按钮是同一类用法。

### 11. 这一组概念怎么串起来

可以把 Riverpod 的核心链路理解成：

1. 用 provider 定义状态和依赖
2. 用 consumer 把 provider 接到 UI
3. 用 ref.watch 订阅状态
4. 用 ref.listen 处理副作用
5. 用 ref.read 处理一次性动作
6. 用 family / autoDispose / select 处理更细的场景

### 12. 和这份学习文档的对应关系

如果你要按本地文档继续学，下面这些关键词是最该优先串起来的：

- `ProviderScope`
- `Provider`
- `FutureProvider`
- `ConsumerWidget`
- `ref.watch`
- `ref.listen`
- `ref.read`
- `select`
- `family`
- `autoDispose`

### 13. 官方原文链接

- [Providers](https://riverpod.dev/docs/concepts2/providers)
- [Consumers](https://riverpod.dev/docs/concepts2/consumers)
- [Refs](https://riverpod.dev/docs/concepts2/refs)
