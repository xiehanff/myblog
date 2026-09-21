---
title: Flutter 企业开发实践29-双Token无感刷新
date: 2026-08-24
tags:
  - Flutter
  - Dio
  - 双Token
  - 无感刷新
  - 并发竞态
  - 单元测试
---

# 双 Token 无感刷新——并发竞态、重放与防递归

> "登录态过期"是所有 App 最日常也最容易写错的基础设施：用户用着用着突然被踢回登录页，十有八九是 token 刷新写坏了。
> 这篇拆的是某线上项目（下面简称"该项目"）网络层的双 Token 无感刷新：双 Dio 隔离、并发锁 + 二次校验、401/402 状态机、请求重放和防死循环。**文中核心逻辑全部跑过单元测试**（6 个场景一次跑绿），测试代码也一并贴出来，你可以直接搬进自己的工程。

**版本说明**：基于 Dio 5.x + synchronized 3.x；接口路径都是示意占位。这套实现是从生产代码提炼出来的可测试版本，跟生产版的差异在文末如实标注。

---

## 概述

先给结论：

1. **双 Token（短期 access + 长期 refresh）要解决的就是"安全跟体验打架"**：access 短命，泄露了损失也小；refresh 长命，用户不用天天登录；过期的时候拿 refresh 换新 access，全程用户无感。
2. **真正难的是并发**：token 过期那一瞬间，往往有好几个请求正在飞，写得朴素一点，每个 401 都会去刷一次。轻的浪费请求，重的直接把 refresh token 刷失效，服务端要是单次有效语义，这一下就够把用户踢下线。
3. **国内后端有个特色坑：过期信号藏在业务码里，不在 HTTP 状态码里**。服务端给你 HTTP 200 + `code: 401`，所以拦截器得拦 `onResponse`，拦 `onError` 没用。
4. **这套逻辑对不对，只能靠测试兜底**：并发击穿、重放 token、402 登出、防死循环……每种场景背后都是一类真实的线上事故，光靠肉眼 review 拦不住，这篇用 6 个单元测试把它们一条条锁死。

---

## 核心内容

### 1. 为什么非得双 Token

单 token 就一个两难：有效期长，泄露以后攻击窗口大；有效期短，用户老得重新登录。双 Token 干的事就是把这俩拆开：

| Token | 寿命典型值 | 用途 | 存储 |
|-------|-----------|------|------|
| access_token | 2 小时 | 每个 API 请求的 `Authorization` 头 | 内存（泄露损失可控） |
| refresh_token | 30 天 | 仅用于换新 access | 安全存储 |

走一遍流程：access 过期，服务端返回过期信号，客户端拿 refresh 换新的 access，再把**原请求重放一遍**，调用方照常拿到数据。整个过程业务代码无感，用户也无感，这就是"无感刷新"。

### 2. 核心机制：四个环环相扣的设计

该项目的实现就是一个 Dio 网络客户端 + 拦截器，里面四个设计环环相扣，少一个都会在特定场景翻车：

#### 2.1 业务码过期：拦 onResponse，别拦 onError

国内服务端一般把"token 过期"塞进 HTTP 200 的响应体业务码里（该项目约定 `code: 401` = access 过期、`code: 402` = refresh 也失效），所以过期处理得挂在 `onResponse`：

```dart
onResponse: (response, handler) async {
  if (isTokenExpiredBody(response.data)) {  // code == 401
    // 刷新 + 重放
  }
  handler.next(response);
}
```

你要是把拦截写在 `onError` 里等 HTTP 401，在这类后端上**永远不触发**。接国内后端，第一版栽在这儿的特别多。

#### 2.2 独立刷新 Dio：无递归的根源

刷新请求本身**绝对不能**再走业务拦截器链。不然刷新请求自己拿到过期响应，又去触发刷新，就无限递归了。解法是物理隔离，两个 Dio 实例：业务 Dio 挂 Token 头拦截器 + 刷新拦截器，刷新 Dio 什么都不挂：

```dart
final businessDio = Dio(); // 挂 TokenHeaderInterceptor + TokenRefreshInterceptor
final refreshDio = Dio();  // 裸实例：不带旧 token，也不会触发刷新
```

顺带还保证了**刷新请求不带旧 access_token**（它在 `queryParameters` 里带 refresh_token），第六个测试专门验的就是这一点。

#### 2.3 并发锁 + 锁内二次校验：N 个 401 只刷一次

token 过期那一瞬间的真实场景是这样的：页面同时发出 5 个请求，都带着旧 token，也都收到了 401。要是每个 401 都发起刷新：

- 5 次重复请求纯浪费；
- 更危险的是 refresh_token 如果是"单次有效"（服务端轮换），第 2 次刷新用的已经是失效的旧 refresh → 402 → 用户被误踢下线。

解法是两层防线：

```dart
final refreshed = await _refreshLock.synchronized(() async {
  // 第二层：排队这段时间里，可能已经被前面那个请求刷过了
  final current = store.accessToken;
  if (oldToken != null && current != null && current.isNotEmpty
      && oldToken != current) {
    return true;   // 别人已经刷好了，直接去重放
  }
  // 第一层防线（Lock）：同一时刻只有一个请求能走到这儿
  final res = await refreshDio.post(refreshPath, ...);
  // ... 保存新 token
});
```

- **锁外记下 `oldToken`**（触发 401 时的旧值）；
- **锁内比对当前值**：拿到锁的时候，`accessToken` 已经不是 `oldToken` 了，说明排队期间前面的请求刷过了，那就跳过刷新，直接去重放。

#### 2.4 重放与防死循环

刷新成功后用 `businessDio.fetch(requestOptions)` 重放原请求：走的是**业务 Dio**（重新过一遍 Token 头拦截器，自动带上刚换的新 token），不是拿旧 response 自己拼。重放结果用 `handler.resolve()` 直接回给原调用方，业务层完全无感。

不过重放会带来一个新风险：服务端对新 token 还是返回 401（服务端异常、多端互踢竞态），那就重放 → 又 401 → 又刷新 → 死循环。加固办法是在 `requestOptions.extra` 上打一个一次性标记：

```dart
if (options.extra['auth_retried'] == true) {
  return handler.next(response); // 已重放过一次：透传，不再刷新
}
// ... 刷新成功后
options.extra['auth_retried'] = true;
final retryResponse = await businessDio.fetch<dynamic>(options);
```

**每个请求最多重放一次**，这是生产代码里没有、被测试逼着补上的加固点（差异见第 5 节）。

### 3. 完整实现（测试跑过的版本）

```dart
import 'package:dio/dio.dart';
import 'package:synchronized/synchronized.dart';

/// Token 存取与副作用出口（存储和登出交给宿主实现，核心逻辑只依赖这个抽象）
abstract class TokenStore {
  String? get accessToken;
  String? get refreshToken;
  Future<void> save({
    required String accessToken,
    required String refreshToken,
  });
  void onSessionExpired(); // refresh 也失效（402）时的全局登出钩子
}

class TokenRefreshInterceptor extends Interceptor {
  TokenRefreshInterceptor({
    required this.businessDio,
    required this.refreshDio,
    required this.store,
    required this.refreshPath,
    required this.isTokenExpiredBody,
    this.successCode = 0,
    this.sessionExpiredCode = 402,
  });

  final Dio businessDio;
  final Dio refreshDio;      // 独立实例：不挂任何业务拦截器（防递归的根源）
  final TokenStore store;
  final String refreshPath;  // 示意：/api/auth/refresh-token
  final bool Function(Object? body) isTokenExpiredBody;
  final int successCode;
  final int sessionExpiredCode;

  final Lock _refreshLock = Lock();

  @override
  void onResponse(Response response, ResponseInterceptorHandler handler) async {
    final options = response.requestOptions;
    // 防死循环：这个请求已经重放过一次，不管结果如何都透传
    if (options.extra['auth_retried'] == true) {
      return handler.next(response);
    }
    if (!isTokenExpiredBody(response.data)) {
      return handler.next(response);
    }

    final oldToken = store.accessToken;
    final refreshed = await _refreshLock.synchronized(() async {
      // 锁内二次校验：排队期间可能已经被别的请求刷过了
      final current = store.accessToken;
      if (oldToken != null && current != null && current.isNotEmpty
          && oldToken != current) {
        return true;
      }
      try {
        final res = await refreshDio.post(
          refreshPath,
          queryParameters: {'refreshToken': store.refreshToken},
        );
        final body = res.data;
        if (body is! Map) return false;
        final code = body['code'];
        if (code == successCode && body['data'] is Map) {
          final data = Map<String, dynamic>.from(body['data'] as Map);
          await store.save(
            accessToken: data['accessToken'] as String,
            refreshToken: data['refreshToken'] as String,
          );
          return true;
        }
        if (code == sessionExpiredCode) {
          store.onSessionExpired(); // 402：refresh 也失效 → 全局登出
        }
        return false;
      } catch (_) {
        return false; // 刷新接口网络异常：吞掉，透传原响应
      }
    });

    if (!refreshed) {
      return handler.next(response);
    }

    try {
      options.extra['auth_retried'] = true;
      final retryResponse = await businessDio.fetch<dynamic>(options);
      return handler.resolve(retryResponse);
    } catch (_) {
      return handler.next(response);
    }
  }
}

/// 业务 Dio 的 Token 头拦截器（刷新 Dio 不挂它）
class TokenHeaderInterceptor extends Interceptor {
  TokenHeaderInterceptor(this.store);
  final TokenStore store;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = store.accessToken;
    if (token != null && token.isNotEmpty) {
      options.headers['Authorization'] = token;
    }
    handler.next(options);
  }
}
```

组装方式：

```dart
final store = MyTokenStore();          // 宿主实现：安全存储 + 登出导航
final businessDio = Dio();
final refreshDio = Dio();              // 裸实例，什么都不挂
businessDio.interceptors.add(TokenHeaderInterceptor(store));
businessDio.interceptors.add(TokenRefreshInterceptor(
  businessDio: businessDio,
  refreshDio: refreshDio,
  store: store,
  refreshPath: '/api/auth/refresh-token',
  isTokenExpiredBody: (body) => body is Map && body['code'] == 401,
));
```

### 4. 六个单元测试：每个场景对应一类线上事故

"正确"这件事得能执行着证明。测试的关键是**不碰真网络**：用 Dio 的自定义 `HttpClientAdapter` 搭一个假服务端，把每次请求的路径和 `Authorization` 头记下来，这样"谁在什么时候带了什么 token"就成了一条条可以断言的事实：

```dart
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this._handler);
  final Future<Response<String>> Function(RequestOptions) _handler;
  final requests = <RecordedRequest>[];  // 记录 path + Authorization

  @override
  Future<ResponseBody> fetch(options, requestStream, cancelFuture) async {
    requests.add(RecordedRequest(options.uri.path,
        options.headers['Authorization'] as String?));
    final response = await _handler(options);
    return ResponseBody.fromBytes(
      response.data?.codeUnits ?? const <int>[],
      response.statusCode ?? 200,
    );
  }

  @override
  void close({bool force = false}) {}
}
```

假服务端的默认剧本是：**带旧 token 返回 `code:401`（HTTP 200），带新 token 返回成功**，把"业务码过期"的后端形态精确复刻了一遍。

#### 测试 1：并发 5 个 401，只刷一次（最重要）

```dart
final futures = [for (var i = 0; i < 5; i++) dio.get('/api/business/list')];
final responses = await Future.wait(futures);

expect(biz.countOf('/api/business/list'), 10);  // 5 原始 + 5 重放
expect(refresh.countOf(refreshPath), 1);        // 只发 1 次刷新
// 5 个调用方全部拿到成功响应；重放请求全部带新 token
```

这一条把"锁 + 二次校验"的并发正确性钉死了：没有锁，就会有 5 次刷新；锁少了二次校验，排队的后 4 个请求会拿着旧 refresh_token 再刷 4 次，单次有效语义下就是误登出。断言里同时验证**重放带的是新 token**（新旧 token 各出现 5 次）。重放忘了换头是第二常见的 bug。

#### 测试 2：刷新后新请求直接成功

刷新成功之后再发一个新请求：业务端只出现 1 次请求，刷新次数不增。验的是"token 换了新就不会再多刷"这条自然路径。

#### 测试 3：402 → 登出回调 + 原 401 透传

让刷新接口返回 `code:402`：断言 `store.sessionExpiredCount == 1`（全局登出钩子恰好触发一次），调用方拿到的是**原始 401 响应**（不吞掉、不伪装成功），token 没被改动。402 场景常见的 bug 就是"既登出了，又把 401 当成功继续往下走业务"。透传这个语义，就靠这条测试守住。

#### 测试 4：刷新接口网络异常 → 不崩溃、不误登出

刷新请求直接抛异常（弱网下很常见）：断言原 401 响应透传、`sessionExpiredCount == 0`，**网络抖动不等于会话失效**。把弱网当成登出，是最伤用户的一种误判。

#### 测试 5：重放仍 401 → 不死循环

让服务端对任何 token 都返回 401（模拟服务端异常、多端互踢竞态）：断言刷新恰好 1 次、业务请求恰好 2 次（原始 + 重放各一次），最终透传 401。要是没有 `auth_retried` 标记，这个场景就会一直循环下去。

#### 测试 6：刷新请求自身不带 Authorization

断言刷新请求的 `Authorization` 头是 `null`，独立 Dio 的隔离效果能直接观测到。这条看着显然，但它守的是"无递归"的根源：只要有人图省事把业务拦截器也挂到刷新 Dio 上，测试立刻红。

### 5. 与生产实现的差异（如实记录）

这篇给出的实现是该项目的提炼版，有一处**测试驱动的加固**，还有一处简化：

1. **加固：`auth_retried` 一次性标记**。生产代码的重放没打这个标记，服务端对新 token 仍返回 401 的时候就会形成刷新循环（测试 5 的场景）。这事在生产里概率极低（得服务端配合出错），但真发生就是一场请求风暴。测试写出来之后，加固就成了必然的选择。
2. **简化：并发请求的"排队等待"语义**。生产实现里，锁内二次校验让并发 401 各自快速通过（刷新的那个去刷，后来的直接复用），行为跟这篇一样；但更精细的方案（把并发请求挂进真正的等待队列，刷新完成后统一唤醒重放，不用每个请求各自持锁去等）在极端并发下吞吐更好。`synchronized` 的写法好在简单可靠，两种方案大家按团队口味选。
3. 生产代码还有**刷新失败冷却期**（失败后 5 秒内不再尝试刷新，防止请求风暴打爆刷新接口）和 **401 风暴下的全量登出**兜底，算运维层加固，思路跟第 6 节常见坑 3 呼应，实现从略。

### 6. 工程化细节清单

真要上线，核心之外还有一串细节得过：

1. **`CancelToken` 与重放**：原请求被取消后不要重放（`cancelFuture` 已触发时 `fetch` 会抛 `DioException.cancel`，catch 分支里透传就行，但更主动的做法是重放前先检查 `cancelToken.isCancelled`）；
2. **上传/流式请求的重放**：`data` 是 `Stream` 的请求体，重放的时候可能已经被消费掉了。上传类接口我的建议是改用可重复的 `FormData`（dio 内部对文件路径会重新开流），要么就对这类路径豁免重放；
3. **多 isolate / 多引擎**：Lock 只在单 isolate 内有效，混合栈里原生侧和 Flutter 侧各持一份 token 时，以服务端返回的最新 token 为准（保存前比对时间戳或版本号），别让旧值把新值盖了；
4. **时钟偏移**：别在客户端预判 token 过期时间主动去刷（用户改一下系统时间就全废了），以服务端的 401 信号为准，被动刷新比主动预判可靠；
5. **重放与幂等**：重放的不论读请求还是写请求，都是"收到 401 的那个请求"，写请求天生得幂等（这是服务端契约，刷新层解决不了，但你必须知道）；
6. **登出竞态**：402 触发全局登出的时候，可能还有请求在重放的路上。登出一清 token，重放请求就变成无 token 身份发出去，又吃一个 401，被 `auth_retried` 标记拦下透传，不会循环；但要确保登出导航只触发一次（用 `sessionExpiredCount` 同款守卫）。

---

## 常见坑

### 1. 并发刷新击穿

**场景**：token 过期那一瞬间 5 个请求正在飞，触发 5 次刷新，用户莫名其妙就被踢下线。
**根因**：refresh_token 单次有效（服务端轮换），说白了第二次刷新用的已经是失效的值。
**解决**：Lock 串行 + 锁内 oldToken 二次校验（见 2.3，测试 1 锁死该行为）。

### 2. 重放请求还带着旧 token

**场景**：刷新明明成功了，重放的请求还是 401。
**根因**：重放时手动从原 `requestOptions.headers` 复制了旧 Authorization。
**解决**：重放走业务 Dio 全链路，让 Token 头拦截器重新取最新值（测试 1 的双 token 计数断言专防这个）。

### 3. 刷新失败风暴

**场景**：弱网下刷新连续失败，每个新 401 都再试一次刷新，请求风暴打爆刷新接口。
**解决**：失败冷却期（如 5 秒内不再发起刷新，期间的 401 直接透传）。

### 4. 拦错回调：onError vs onResponse

**场景**：按教科书写 `onError` 去拦 HTTP 401，在国内后端上永远不触发。
**根因**：服务端返回 HTTP 200 + 业务码 401。
**解决**：过期判定挂在 `onResponse`，判据用 `response.data` 的业务码（见 2.1）。

### 5. 刷新接口自身触发刷新

**场景**：刷新接口的响应也走了业务拦截器，形成递归。
**解决**：独立的刷新 Dio，不挂 Token 头与刷新拦截器（测试 6 从请求头上直接验证隔离）。

### 6. 402 与网络异常混为一谈

**场景**：弱网刷新失败被当成"会话失效"，用户被误登出。
**解决**：402（明确的业务语义）才登出；网络异常透传原响应、不登出（测试 3/4 分别锁死两种语义）。

---

## 面试追问

### 1. 双 Token 的机制与必要性？

**要点**：短 access 把泄露损失控制住，长 refresh 把登录频率降下来；过期了就用 refresh 换 access，再把原请求重放一遍，用户无感。能展开的地方：存储位置差异（内存 vs 安全存储）、refresh 单次有效（轮换）语义及其对客户端并发设计的影响。

### 2. token 过期瞬间多个并发请求怎么处理？

**要点**：分三层。独立锁保证只有一个刷新在飞；锁外记录 oldToken、锁内比对当前 token，已被刷新的直接复用；其余请求刷新完成后统一以新 token 重放。强调 refresh 单次有效时"多刷即误登出"的事故模型，以及"重放必须重新走 Token 头拦截器拿最新值"。

### 3. 为什么你的刷新逻辑要拦 onResponse？

**要点**：国内后端把过期放在 HTTP 200 的业务码里，用 onError 拦 HTTP 401 在这类后端上永远不触发，判据得看 `response.data` 的业务码。这也是"先看后端契约再写拦截器"的例子。

### 4. 刷新链路怎么防死循环？

**要点**：两个来源。刷新请求自身触发刷新（用独立 Dio 隔离根治）、重放后仍 401（`requestOptions.extra` 打一次性标记，每请求至多重放一次）。能说出"这两个场景分别怎么用测试锁死"是加分项。

### 5. 怎么保证这套并发逻辑是对的？

**要点**：单元测试 + 假服务端，自定义 `HttpClientAdapter` 记录每次请求的 Authorization，让"并发 N 个 401 只刷一次、重放全带新 token、402 恰好登出一次"从推理变成断言。记住一点：并发正确性靠 review 不可靠，测试才是唯一能执行起来的证明。

---

## 参考资源

- [Dio（pub.dev）](https://pub.dev/packages/dio)：拦截器与自定义 HttpClientAdapter 文档
- [synchronized（pub.dev）](https://pub.dev/packages/synchronized)：Lock 串行化
- [RFC 6749: OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)：refresh_token 语义（第 6 节）
