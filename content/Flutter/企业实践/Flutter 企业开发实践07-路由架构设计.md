---
title: Flutter 企业开发实践07-路由架构设计
date: 2026-05-18
tags:
  - Flutter
  - 路由
  - GoRouter
  - 深链接
  - 路由守卫
  - 面试
---

# 路由架构设计

## 概述

路由要解决的核心问题就一个：**页面怎么跳、怎么返回、状态怎么恢复**。

页面少的应用，`Navigator.push` / `Navigator.pop` 就够了。但页面一过 20 个，再加上深链接、登录拦截、嵌套导航（底部 Tab + 子页面栈）这些需求，命令式路由就顶不住了。Flutter 路由 2.0（Navigator 2.0）和 GoRouter 就是冲着这些工程问题来的。

把它当成"怎么 push 页面"，那就想窄了。它是个工程决策：**路由架构怎么设计才可维护、可扩展、可测试**。

## 核心内容

### 1. 命令式路由 vs 声明式路由

#### 命令式路由（Navigator 1.0）

```dart
// 命令式：告诉框架"做什么"
Navigator.push(
  context,
  MaterialPageRoute(builder: (_) => const DetailPage(id: '123')),
);

Navigator.pop(context);
```

**特点**：
- 开发者直接操作路由栈（push/pop/replace）
- 路由状态隐式保存在 Navigator 内部
- 简单直观，小型项目够用

**问题**：
- 路由状态和 UI 状态是分开的，很难同步
- 不支持深链接：URL 变了没法重建路由栈
- 无法全局拦截路由（鉴权、日志）
- 嵌套导航管起来很乱

#### 声明式路由（Navigator 2.0 / GoRouter）

```dart
// 声明式：告诉框架"要什么状态"
final router = GoRouter(
  routes: [
    GoRoute(path: '/', builder: (_, __) => const HomePage()),
    GoRoute(path: '/detail/:id', builder: (_, state) => DetailPage(id: state.pathParameters['id']!)),
  ],
);
```

**特点**：
- 路由配置就是数据（声明式），框架照着配置解析、渲染
- 路由状态和 UI 状态是一套，URL 就是状态
- 天然支持深链接：URL 变化 = 路由状态变化
- 全局拦截器（redirect）也是天然支持

**Flutter 路由 2.0 解决了什么问题？**

核心就一句话：**路由状态从命令式的隐式栈，变成了声明式的数据**。好处有这么几条：

1. **深链接支持**：URL 直接映射到路由状态，不用手动重建栈
2. **状态恢复**：应用被系统杀掉后，照着 URL 就能把路由状态恢复回来
3. **路由可预测**：给定 URL 就能确定是哪个页面，测试和调试都方便
4. **全局拦截**：鉴权、日志、A/B 测试都在路由解析阶段统一做

### 2. GoRouter 深度实践

GoRouter 是 Flutter 官方推荐的路由方案，走的就是声明式这套。

#### 基础配置

```dart
final router = GoRouter(
  navigatorKey: rootNavigatorKey,
  initialLocation: '/',
  routes: [
    GoRoute(
      path: '/',
      name: 'home',
      builder: (context, state) => const HomePage(),
    ),
    GoRoute(
      path: '/user/:id',
      name: 'user',
      builder: (context, state) {
        final id = state.pathParameters['id']!;
        return UserProfilePage(userId: id);
      },
    ),
    GoRoute(
      path: '/settings',
      name: 'settings',
      builder: (context, state) => const SettingsPage(),
    ),
  ],
  errorBuilder: (context, state) => NotFoundPage(error: state.error),
);

// MaterialApp 中使用
MaterialApp.router(routerConfig: router);
```

**为什么不用 `onGenerateRoute`？** `onGenerateRoute` 是命令式和声明式的混合体，写起来像声明式，行为还是命令式那套，深链接支持差，嵌套路由也管得乱。GoRouter 是纯声明式，API 清楚得多。

#### 嵌套路由

嵌套路由要解决的问题很明确：**底部导航栏 + 每个 Tab 各自独立一个子栈**。

```dart
final router = GoRouter(
  initialLocation: '/home',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) {
        return ScaffoldWithNavBar(navigationShell: navigationShell);
      },
      branches: [
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/home',
              builder: (context, state) => const HomePage(),
              routes: [
                GoRoute(
                  path: 'detail/:id',
                  builder: (context, state) => HomeDetailPage(
                    id: state.pathParameters['id']!,
                  ),
                ),
              ],
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/discover',
              builder: (context, state) => const DiscoverPage(),
              routes: [
                GoRoute(
                  path: 'category/:name',
                  builder: (context, state) => CategoryPage(
                    name: state.pathParameters['name']!,
                  ),
                ),
              ],
            ),
          ],
        ),
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/profile',
              builder: (context, state) => const ProfilePage(),
            ),
          ],
        ),
      ],
    ),
  ],
);
```

```dart
// 底部导航栏容器
class ScaffoldWithNavBar extends StatelessWidget {
  final StatefulNavigationShell navigationShell;

  const ScaffoldWithNavBar({super.key, required this.navigationShell});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: navigationShell.currentIndex,
        onTap: (index) => navigationShell.goBranch(index, initialLocation: index == navigationShell.currentIndex),
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.home), label: '首页'),
          BottomNavigationBarItem(icon: Icon(Icons.explore), label: '发现'),
          BottomNavigationBarItem(icon: Icon(Icons.person), label: '我的'),
        ],
      ),
    );
  }
}
```

**为什么不用 BottomNavigationBar + IndexedStack 手写？** 手写的话，每个 Tab 维护不了自己的子路由栈。切 Tab 子页面状态就丢，深链接也没法直接定位到某个 Tab 的子页面。`StatefulShellRoute` 保证每个 Branch 都有自己的 Navigator 栈。

#### 重定向（Redirect）

重定向是 GoRouter 最强的特性之一，鉴权拦截主要靠它：

```dart
final router = GoRouter(
  redirect: (context, state) {
    final isLoggedIn = AuthService.instance.isLoggedIn;
    final isLoginRoute = state.matchedLocation == '/login';

    // 未登录且不在登录页 → 重定向到登录页
    if (!isLoggedIn && !isLoginRoute) return '/login';

    // 已登录且在登录页 → 重定向到首页
    if (isLoggedIn && isLoginRoute) return '/home';

    // 不需要重定向
    return null;
  },
  routes: [
    GoRoute(path: '/login', builder: (_, __) => const LoginPage()),
    GoRoute(path: '/home', builder: (_, __) => const HomePage()),
    GoRoute(path: '/profile', builder: (_, __) => const ProfilePage()),
  ],
);
```

**为什么鉴权不用 `Navigator.push`？** 命令式鉴权是在每次 `push` 之前检查，写得到处都是，漏一处就出事。声明式重定向是集中式的，所有路由跳转都要过 redirect 函数，想漏都难。

#### ShellRoute

ShellRoute 用来让多个子路由共用同一个 UI 壳（侧边栏、顶部导航栏这类）：

```dart
// 注意：壳本身是 ShellRoute，不是 GoRoute；builder 是三参数（多一个 child）
// 子路由是 ShellRoute 的 routes，路径写全路径（ShellRoute 自身没有 path）
ShellRoute(
  builder: (context, state, child) => AdminShell(child: child),
  routes: [
    GoRoute(
      path: '/admin/dashboard',
      builder: (context, state) => const DashboardPage(),
    ),
    GoRoute(
      path: '/admin/users',
      builder: (context, state) => const UsersPage(),
    ),
    GoRoute(
      path: '/admin/settings',
      builder: (context, state) => const AdminSettingsPage(),
    ),
  ],
)
```

三个子页面之间 `AdminShell` 保持不变（不重建），换的只是 shell 里那部分子页面。

**ShellRoute vs StatefulShellRoute**：
- `ShellRoute`：共享 UI 壳，子路由共用一个 Navigator
- `StatefulShellRoute`：每个 Branch 一个独立 Navigator，底部 Tab 场景用它

### 3. 深链接（Deep Link）与 App Link / Universal Link

#### 深链接是什么？

用户点一个 URL，直接打开 App 里对应的页面，不走浏览器。

```
https://app.example.com/user/123
       ↓ 点击
   App 打开 → UserProfilePage(id: '123')
```

#### Android App Links [Android]

```xml
<!-- AndroidManifest.xml -->
<activity android:name=".MainActivity">
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data
      android:scheme="https"
      android:host="app.example.com"
      android:pathPrefix="/user" />
  </intent-filter>
</activity>
```

`android:autoVerify="true"` 让 Android 6.0+ 自动验证域名归属，用户不用再选浏览器还是 App。

验证文件放在 `https://app.example.com/.well-known/assetlinks.json`。

#### iOS Universal Links [iOS]

```xml
<!-- Info.plist -->
<key>com.apple.developer.associated-domains</key>
<array>
  <string>applinks:app.example.com</string>
</array>
```

验证文件放在 `https://app.example.com/.well-known/apple-app-site-association`。

#### Flutter 端处理深链接

```dart
// GoRouter 自动处理深链接
// URL: https://app.example.com/user/123
// 自动匹配 GoRoute(path: '/user/:id')

// 但需要确保 App Links / Universal Links 正确传递到 Flutter
// Android: 在 MainActivity 中处理 intent
// iOS: 在 AppDelegate 中处理 userActivity

// Android 端 [Android]
class MainActivity : FlutterActivity() {
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // Flutter 3.0+ 自动处理，不用手动转发
    // 旧版本需要手动调用 FlutterDeepLinking
  }
}
```

#### 自定义 Scheme 深链接

```
myapp://user/123
```

不推荐。自定义 Scheme 在 iOS 上已经被限制（LSApplicationQueriesSchemes），安全性也差，说白了任何 App 都能注册同一个 Scheme。优先用 App Links / Universal Links。

#### 深链接测试

```bash
# Android 测试 [Android]
adb shell am start -a android.intent.action.VIEW \
  -d "https://app.example.com/user/123"

# iOS 测试 [iOS]
xcrun simctl openurl booted "https://app.example.com/user/123"
```

### 4. 路由守卫与鉴权

#### 全局守卫（GoRouter redirect）

redirect 的用法上面已经写过。它是最省事的全局守卫。

#### 细粒度路由守卫

有些路由要特定权限（VIP、管理员），光靠全局那套登录/未登录的判断不够：

```dart
// 路由元数据：go_router 17.5.0 起提供的 metadata 参数（Map<String, dynamic>?），
// 写在 GoRoute 上、可直接从 GoRouterState.metadata 读到（含父路由继承合并）。
// 注意版本：17.5.0 之前 go_router 没有任何路由元数据能力——
// 网上老文章里的 meta: {...} 写法在旧版本上并不存在，照抄无法编译
final router = GoRouter(
  redirect: (context, state) {
    // 全局鉴权
    final isLoggedIn = AuthService.instance.isLoggedIn;
    final metadata = state.metadata; // 也可 state.topRoute?.metadata

    if (metadata?['requiresAuth'] == true && !isLoggedIn) {
      return '/login?from=${state.matchedLocation}';
    }

    // 角色鉴权
    final userRoles = AuthService.instance.currentRoles;
    final requiredRoles =
        (metadata?['requiredRoles'] as Set<String>?) ?? const <String>{};
    if (requiredRoles.isNotEmpty && !requiredRoles.any(userRoles.contains)) {
      return '/forbidden';
    }

    return null;
  },
  routes: [
    GoRoute(
      path: '/admin',
      metadata: const {
        'requiresAuth': true,
        'requiredRoles': {'admin'},
      },
      builder: (_, __) => const AdminPage(),
    ),
    GoRoute(
      path: '/vip',
      metadata: const {
        'requiresAuth': true,
        'requiredRoles': {'vip', 'admin'},
      },
      builder: (_, __) => const VipPage(),
    ),
  ],
);
```

**工程上有两点要注意：**

1. `metadata` 是弱类型的 `Map`，key 拼错了只会在运行时静默失效，什么都不报。项目稍大一点，建议把 key 和取值封装成类型安全的辅助函数（比如 `RouteMeta.of(state)?.requiresAuth`），或者直接上官方的 `go_router_builder`，编译期就能查出类型问题。
2. 版本上得注意：`metadata` 是 go_router **17.5.0 新增**的能力（不是由 `meta` 更名而来），旧版本上只能用自定义路由封装或 `redirect` 内的路径白名单实现同等效果；升级时以所用版本的 API 文档为准。

**为什么不在每个页面自己查？** 鉴权逻辑散在每个页面的 `initState`、`build` 里，容易漏，而且拦不住页面渲染（页面都 build 完了才发现没权限，体验很差）。集中式守卫在路由解析阶段就拦下来了，页面根本不会构建。

### 5. 路由和状态管理怎么分工

#### 路由参数 vs 状态管理

```dart
// 方式一：路由参数传递数据（适合少量必要数据）
GoRoute(
  path: '/detail/:id',
  builder: (context, state) => DetailPage(id: state.pathParameters['id']!),
)

// 方式二：状态管理共享数据（适合数据量大或跨页面状态）
class DetailController extends GetxController {
  final String id;
  DetailController({required this.id});

  late final detail = Rxn<Detail>();

  @override
  void onInit() {
    super.onInit();
    loadDetail();
  }

  Future<void> loadDetail() async {
    detail.value = await repository.fetchDetail(id);
  }
}
```

**选型原则**：

| 数据特征 | 传递方式 |
|----------|----------|
| 页面必要标识（ID、类型） | 路由参数（pathParameters / queryParameters） |
| 数据量大、只用于展示 | 状态管理（GetX / Provider），路由只传 ID |
| 跨页面共享状态 | 状态管理 |
| 深链接需要的数据 | 路由参数（深链接只有 URL，没有状态管理） |

**结论**：路由参数能序列化进 URL，状态管理里的数据不能。深链接进来的时候，URL 是唯一的信息来源，也就是说，重建页面需要的所有标识信息都得塞进路由参数。

#### URL 即状态

声明式路由的核心理念就一句：**URL 把当前的路由状态说全了**。

```dart
// URL: /home/discover/category/tech
// 完全等价于：
// - 底部 Tab 在"发现"
// - 发现页下打开了"tech"分类页
// 这个 URL 可以被保存、分享、恢复
```

这意味着：
- 分享链接 = 分享页面状态
- 浏览器前进/后退 = 路由栈前进/后退
- 应用被杀死后恢复 = 从保存的 URL 重建

**不这么做会怎样？** 命令式路由里，路由状态就活在内存那个栈里，序列化不成 URL。应用被杀就恢复不了，用户分享出去的链接，打开也不是他看到的那个页面。

## 常见坑

### 1. GoRouter 的 context 依赖

`GoRouter.of(context)` 要拿到对的 context。在 `MaterialApp.router` 外面用会直接报错。

**解法**：用全局 `router` 实例直接调 `router.go()` / `router.push()`，别走 context。

### 2. 嵌套路由中的 Navigator 冲突

嵌套路由下有好几个 Navigator，`context.go()` 有可能匹配到错的那个。

**解法**：`context.go()` 只在最近的那个 Navigator 里找，要跳到根 Navigator，就用 `rootNavigatorKey.currentContext`。

### 3. 深链接在浏览器中不工作

Flutter Web 的深链接默认走 hash 模式（`/#/user/123`），不是 path 模式（`/user/123`）。

**解法**：配上 `usePathUrlStrategy()` 用 path 模式，但服务端得配 fallback 到 `index.html`。

### 4. 路由参数类型安全

GoRouter 的 `pathParameters` 返回的是 `String?`，解析和校验都得自己来。

**解法**：把路由跳转封装起来，做成类型安全的：

```dart
class AppRoutes {
  static GoRoute detailRoute = GoRoute(
    path: '/detail/:id',
    builder: (context, state) {
      final id = int.parse(state.pathParameters['id']!);
      return DetailPage(id: id);
    },
  );

  // 类型安全的跳转方法
  static void goToDetail(int id) {
    router.go('/detail/$id');
  }
}
```

### 5. 页面切换动画

GoRouter 默认用平台风格的转场动画。要自己定制，就用 `pageBuilder` 换掉 `builder`：

```dart
GoRoute(
  path: '/detail/:id',
  pageBuilder: (context, state) {
    return CustomTransitionPage(
      key: state.pageKey,
      child: DetailPage(id: state.pathParameters['id']!),
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        return FadeTransition(opacity: animation, child: child);
      },
    );
  },
),
```

## 面试追问

### Flutter 路由 2.0 解决了什么问题？

核心就一句：路由从命令式（操作栈）变成声明式（配置数据）。它解决了四个问题：1）深链接支持（URL 直接映射到路由状态）；2）路由状态恢复（应用被杀后可从 URL 重建）；3）全局拦截（集中式鉴权/重定向）；4）嵌套路由（多 Navigator 场景的栈管理）。代价是 API 复杂了，学习曲线更陡。

### 深链接怎么做的？

三个层面：1）操作系统层面：Android App Links / iOS Universal Links，通过域名验证文件让系统知道 URL 归哪个 App；2）Flutter 层面：GoRouter 根据 URL 匹配路由配置，自动导航到对应页面；3）参数传递：URL 中的路径参数和查询参数传给页面。关键点：深链接要求路由参数能序列化进 URL，页面需要的所有标识信息都得能从 URL 推出来。

### GoRouter 的 StatefulShellRoute 解决了什么问题？

解决的是底部导航栏场景下，每个 Tab 都得有自己独立子路由栈这件事。如果用 `IndexedStack` + 普通 `Navigator`，切 Tab 子页面状态就丢了，深链接也没法直接跳到某个 Tab 的子页面。`StatefulShellRoute` 给每个 Branch 建一个独立 Navigator，切 Tab 时各 Branch 的子栈状态都留着，深链接也能精确匹配到对应 Branch。

### 路由守卫和页面内鉴权有什么区别？

路由守卫在路由解析阶段就拦住了，页面根本不会构建，用户体验好（不会闪一下未授权内容），逻辑也集中，不会漏。页面内鉴权是在页面 `initState` 或 `build` 里查，页面都渲染出来了才发现没权限，体验差，逻辑还散得到处都是。企业应用做鉴权必须用路由守卫，页面内鉴权只能兜底。

### 如何设计一个支持 A/B 测试的路由架构？

核心思路：路由配置是数据，数据就能动态化。1）路由配置别再编译时写死，改成运行时动态下发（远程配置服务）；2）在路由守卫里按 A/B 实验分组决定重定向目标（比如 `/home` → `/home_v2`）；3）用 GoRouter 的 `refreshListenable`，实验分组一变就刷新路由；4）URL 保持不变（`/home`），实际渲染哪个页面由实验分组决定，这样深链接不受影响。这里有个硬约束：A/B 两版页面的路由参数签名必须一致，不然深链接会断。

## 参考资源

- [GoRouter 官方文档](https://pub.dev/packages/go_router)
- [Flutter 官方：Navigation and Routing](https://docs.flutter.dev/ui/navigation)
- [Deep Linking 官方指南](https://docs.flutter.dev/ui/navigation/deep-linking)
- [Android App Links 文档](https://developer.android.com/training/app-links)
- [iOS Universal Links 文档](https://developer.apple.com/ios/universal-links/)
