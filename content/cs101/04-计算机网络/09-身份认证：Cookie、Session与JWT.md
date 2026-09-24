# 计算机网络｜09-身份认证：Cookie、Session 与 JWT

登录过一次之后，刷新页面、新开标签页、第二天再打开，应用依然认得你。可是 HTTP 本身并不会“记住”上一个请求，每一次需要识别用户的请求，都必须重新给出一份能说明身份的材料。

最直接的做法是每次都携带用户名和密码：这样密码会在链路上反复出现，服务端每次都要做一次昂贵的口令校验，一旦泄漏就是账号级损失。于是人们把长期凭证换成了“登录态”，但由此冒出一连串容易混淆的说法：Cookie 是认证机制吗？Session 一定要放在内存里吗？JWT 是不是加密的？“无状态”到底省掉了什么？

本文先分清认证、授权与会话三件事，再解释 HTTP 的无状态是如何被“凭证携带”补上的；接着对比两种状态归属——服务端保存状态的会话与自包含的令牌——最后落到校验顺序、撤销、刷新与存储边界。

<!-- GFM-TOC -->
* [认证、授权与会话不是一回事](#认证授权与会话不是一回事)
    * [凭证与会话凭证](#凭证与会话凭证)
* [HTTP 无状态，为什么登录状态能延续](#http-无状态为什么登录状态能延续)
    * [凭证放在哪里](#凭证放在哪里)
* [Cookie：浏览器替服务端携带的键值对](#cookie浏览器替服务端携带的键值对)
    * [一次写入与一次回传](#一次写入与一次回传)
    * [决定行为的属性](#决定行为的属性)
    * [SameSite 与名称前缀](#samesite-与名称前缀)
    * [大小与数量限制](#大小与数量限制)
* [Session：把状态留在服务端](#session把状态留在服务端)
    * [一次登录的完整时序](#一次登录的完整时序)
    * [最小实现：随机 ID 与会话表](#最小实现随机-id-与会话表)
    * [轮换、超时与共享存储](#轮换超时与共享存储)
* [Bearer Token：凭证移到 Authorization 头](#bearer-token凭证移到-authorization-头)
* [JWT：一个被签名的 JSON 载荷](#jwt一个被签名的-json-载荷)
    * [三段结构与签名输入](#三段结构与签名输入)
    * [用 Dart 拼出一个 JWT](#用-dart-拼出一个-jwt)
* [校验一个 JWT：先验签，再验声明](#校验一个-jwt先验签再验声明)
    * [最小校验实现](#最小校验实现)
    * [失败场景比成功场景更值得观察](#失败场景比成功场景更值得观察)
* [无状态令牌的代价：撤销与续期](#无状态令牌的代价撤销与续期)
    * [两种状态归属怎么选](#两种状态归属怎么选)
* [access token 与 refresh token](#access-token-与-refresh-token)
* [会话被偷走的几条路](#会话被偷走的几条路)
    * [XSS：脚本能拿到什么](#xss脚本能拿到什么)
    * [CSRF：Cookie 为什么会被自动利用](#csrfcookie-为什么会被自动利用)
    * [重放与发送者约束](#重放与发送者约束)
* [OAuth 2.0、OIDC 与 JWT 的边界](#oauth-20oidc-与-jwt-的边界)
* [常见误区](#常见误区)
    * [把 Cookie 当成认证机制](#把-cookie-当成认证机制)
    * [认为 JWT 是加密的](#认为-jwt-是加密的)
    * [认为 Session 必须放在内存里](#认为-session-必须放在内存里)
    * [认为无状态就不需要存储](#认为无状态就不需要存储)
    * [认为客户端删掉令牌就等于注销](#认为客户端删掉令牌就等于注销)
    * [用 Base64URL 换取安全感](#用-base64url-换取安全感)
    * [把令牌的有效期当作唯一防线](#把令牌的有效期当作唯一防线)
* [参考资料](#参考资料)
* [一句话总结](#一句话总结)
<!-- GFM-TOC -->

## 认证、授权与会话不是一回事

认证（Authentication）回答“你是谁”，授权（Authorization）回答“你能做什么”，会话（Session）回答“这次登录结论如何延续”。日常把它们笼统说成“登录状态”，但三者的失败后果并不相同：

- 认证不通过：无法确认身份，对应 401 一类响应；
- 授权或访问策略不允许：服务器理解请求但拒绝执行，对应 403 一类响应；它不必然证明凭据已经被验证为有效；
- 会话失效：之前形成的身份判断不再有效，需要重新认证。

> **关键认知：** 在经典登录流程里，口令认证通常发生在建立会话时，但每个请求仍要验证会话凭证，必要时还会触发重新认证或二次验证；授权判断更要跟着每个请求重新做。“登录过”不等于“现在有权限”。

### 凭证与会话凭证

凭证（credential）是证明身份的材料，例如密码、一次性验证码或私钥签名，它通常长期有效，泄漏后果严重。会话凭证（session credential）是登录成功后发给客户端的引用，例如 Session ID 或令牌（token），它应当可过期、可撤销、可轮换。把长期凭证换成短期引用，是后面所有机制共同的设计动机。

> **面试高频：** 认证和授权有什么区别？
> **答题脉络：** 谁在回答“你是谁” → 谁在回答“你能做什么” → 401 与 403 分别说明什么 → 会话只是延续认证结论的载体。
> **追问方向：** 权限被回收后仍在有效期内的会话、OAuth 的委托授权、基于角色或属性的授权模型。

## HTTP 无状态，为什么登录状态能延续

HTTP 的无状态性说的是协议语义：每个请求要自带足够信息，服务器不必依赖上一个请求留下的上下文才能解释它。这个选择让服务器更容易处理海量、独立的请求，代价是协议层不带“你是谁”的结论。

因此“保持登录”并不是 HTTP 记住了你，而是每次请求都重新提供一份可验证的凭证。有的方案把这种携带交给浏览器自动完成，有的要求调用方显式附加。

> **关键认知：** HTTP 无状态指的是协议语义不要求服务端记住请求之间的关联；它既不禁止服务端保存数据，也不禁止客户端在请求里补上身份信息。

### 凭证放在哪里

| 携带位置 | 由谁附加 | 是否随同站请求自动发送 | 主要风险 |
| --- | --- | --- | --- |
| `Cookie` 请求头 | 浏览器 | 在匹配域、路径、Secure、SameSite 等条件满足时自动发送 | 跨站场景可能触发 CSRF；同域脚本与不可信子域可能读到 |
| `Authorization` 请求头 | 调用方 | 否 | 脚本可读时，一次 XSS 就能取走令牌 |
| 请求体字段 | 调用方 | 否 | 容易被日志与错误上报记录 |
| URL 查询参数 | 调用方 | 否 | 进入浏览器历史、`Referer` 与代理日志 |

URL 里带令牌并非不被允许——Bearer 令牌规范确实定义了这种方式，但同时明确不推荐，因为它会泄漏到不该留下痕迹的地方（[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) 第 2.3 节）。

> **关键认知：** 凭证放在哪里决定了它的攻击面：自动携带带来 CSRF 风险，脚本可读带来 XSS 风险，进入 URL 带来日志与历史泄漏风险；这三类风险不能用同一种手段消除。

## Cookie：浏览器替服务端携带的键值对

Cookie 是浏览器中的一小段键值数据，服务器用响应头写入，浏览器在后续请求里自动回传。RFC 6265 的定义就是“在基本无状态的协议上维持状态”的手段（[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265) 摘要）。它是 HTTP 字段体系的一员，字段的通用语义与缓存交互见 [HTTP 语义、缓存与版本演进](./07-HTTP语义、缓存与版本演进.md)。

### 一次写入与一次回传

```http
HTTP/1.1 200 OK
Set-Cookie: sid=8f3c5a1e9b; Path=/; HttpOnly; Secure; SameSite=Lax

GET /orders HTTP/1.1
Host: api.example.com
Cookie: sid=8f3c5a1e9b
```

写入发生在响应里，回传发生在请求里；中间没有任何“认证”语义。服务端完全可以把 `sid` 解释成 Session ID，也可以解释成主题偏好。

### 决定行为的属性

| 属性 | 决定什么 | 边界 |
| --- | --- | --- |
| `Expires` / `Max-Age` | 持久 Cookie 或会话期 Cookie | 同时出现时 `Max-Age` 优先 |
| `Domain` / `Path` | 回传范围 | 不写 `Domain` 时只发给当前主机（host-only）；写了 `Domain` 时该域与其子域都会回传 |
| `Secure` | 只经安全连接发送 | 限制的是发送通道，不是内容保密 |
| `HttpOnly` | 不通过非 HTTP API（如 `document.cookie`）暴露 | 不能被脚本读取，但请求仍会被浏览器自动发出 |
| `SameSite` | 跨站请求是否携带 | `None` 需要同时设置 `Secure` |

`Secure` 常被误解为“加密 Cookie 内容”，它只声明“只有安全连接才发送这份 Cookie”（[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265) 第 4.1.2.5 节、草案第 5.6.5 节）；这条通道由 TLS 提供，握手与证书校验的过程见 [HTTPS 与 TLS](./08-HTTPS与TLS.md)。`HttpOnly` 也不是访问控制：脚本读不到 `document.cookie` 里的值，但如果页面已经被注入脚本，脚本仍可以让浏览器替你发请求。

### SameSite 与名称前缀

`SameSite` 有三种取值：`Strict` 在顶级导航由外部站点触发时不携带；`Lax` 允许顶级导航且使用安全方法（通常指 `GET`）时携带；`None` 不做限制，但只有同时具备 `Secure` 才会被写入（草案第 5.7 节第 19 步）。没有显式声明 `SameSite` 的 Cookie 会被用户代理当作 `Default` 处理，而检索算法的判定条件是“`same-site-flag` 为 `Lax` 或 `Default`”，也就是默认按 `Lax` 对待（草案第 5.6.7 节与第 5.8.3 节）。

Cookie 名称前缀把“设置时的约束”写进了名字，服务端因此可以确信属性确实生效：

- `__Secure-`：必须带 `Secure`；
- `__Host-`：必须带 `Secure`、必须设置 `Path=/`、不能带 `Domain`，因此锁定在单一主机上（草案第 4.1.3.1 与 4.1.3.2 节）。

值得注意的是，`Lax` 只是“默认值更安全的兜底”，不是完整的 CSRF 防御：草案明确指出它对依赖不安全方法的攻击提供了合理防护，但并不构成对整个 CSRF 类别的稳健防御（草案第 5.6.7.1 节）。

### 大小与数量限制

[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265) 第 6.1 节要求通用用户代理至少支持每条 4096 字节、每个域 50 条、总计 3000 条；草案进一步要求名称与值合计超过 4096 octets 时直接拒收该 Cookie，并把数量限制交给用户代理自行裁剪（草案第 5.7 节第 4 步、第 6.1 节）。

> **关键认知：** Cookie 是一种体积受限、会被用户随时清除的共享通道，服务端不能把它的存在当作可依赖的状态存储；用户代理可以随时淘汰任意 Cookie，服务端必须能优雅降级。

> **时效信息（核查日期：2026-09）：** `SameSite` 与名称前缀目前只定义在 `draft-ietf-httpbis-rfc6265bis-22`（2025-12-01）中。该草案已提交 IESG，但截至核查日期仍是 Active Internet-Draft，尚未发布为 RFC，因此属性语义以草案为准、由浏览器裁决。第三方 Cookie 的分区存储属性 `Partitioned` 不在 RFC 6265 与该草案里，属浏览器厂商推动的独立机制（[Privacy Sandbox: Third-party cookies](https://privacysandbox.google.com/cookies)）。

> **面试高频：** Cookie 的 `Secure`、`HttpOnly`、`SameSite` 各自防什么？
> **答题脉络：** `Secure` 限制发送通道 → `HttpOnly` 限制读取接口、不限制发送 → `SameSite` 限制跨站发送 → 三者都不替代 CSRF 令牌与输出编码。
> **追问方向：** `__Host-` 前缀的约束、`Lax` 与 `Strict` 的体验差异、默认 `Lax` 后还需要不需要 CSRF 令牌。

## Session：把状态留在服务端

既然 Cookie 只是通道，那么真正决定“是否登录”的状态可以放在服务端：客户端只保存一个随机标识，服务端用标识查表得到用户与权限。

### 一次登录的完整时序

<figure class="diagram-scroll"><img src="./09-身份认证：Cookie、Session与JWT.assets/session-login-lifecycle.svg" alt="客户端登录、携带 Session ID 访问并注销的请求时序"></figure>

第 4 步是服务端会话的关键能力：权限一旦撤销，删掉记录即可，不需要等任何客户端配合。

### 最小实现：随机 ID 与会话表

会话 ID 必须不可预测，否则攻击者可以靠猜或遍历拿到别人的会话。下面用 `Random.secure()` 生成 32 字节随机值，再 Base64URL 编码成 ID；会话表把 ID 映射到用户，权限信息留在服务端。代码块是 `SessionStore` 类的完整定义（同文件末尾还有一个演示用的 `main()`，未收录）：

```dart
// 前置条件：Dart 3.12.2；纯 Dart（dart:convert、dart:math），无第三方依赖。
// 运行：dart run lib/session_store.dart
//
// 最小服务端会话存储：只把不可猜测的随机 ID 交给客户端，状态留在服务端。
import 'dart:convert';
import 'dart:math';

class SessionStore {
  // 进程内存储；多实例部署时替换为 Redis、数据库等共享存储。
  final Map<String, String> _userBySessionId = <String, String>{};
  final Random _random = Random.secure();

  /// 创建会话并返回 Session ID。
  ///
  /// 用密码学安全随机数生成 32 字节（256 位）熵，Base64URL 后是 43 个字符；
  /// OWASP 对 Session ID 的下限要求是 64 位熵。
  String create(String user) {
    final bytes = List<int>.generate(32, (_) => _random.nextInt(256));
    final id = base64UrlEncode(bytes).replaceAll('=', '');
    _userBySessionId[id] = user;
    return id;
  }

  String? userOf(String id) => _userBySessionId[id];

  /// 权限级别变化后轮换 Session ID，旧 ID 立即作废。
  ///
  /// 这是防会话固定的关键一步：登录成功后换发新 ID，
  /// 攻击者事先塞给受害者的旧 ID 不会自动升级成已认证会话。
  String rotate(String oldId) {
    final user = _userBySessionId.remove(oldId);
    if (user == null) {
      throw StateError('无法轮换不存在的会话');
    }
    return create(user);
  }

  void destroy(String id) {
    _userBySessionId.remove(id);
  }
}
```

<!-- verify: .work/verify/B15/lib/session_store.dart -->

同一文件的 `main()` 依次演示创建、轮换、注销，输出如下：

```text
login -> sid=fj_eFl2TCq_Pj_2eW7IIEpkO4u_s3uSSxtLZKPVOBcg, user=alice
rotate -> new sid=ECeUrypfN5yLgYq7YJm5QJ8AK1sH3-fFgVdJzrGyLEE
old sid 仍然可用？false
new sid 仍然可用？true
logout -> user=null
```

OWASP 建议 Session ID 至少具备 64 位熵，并在任何权限级别变化后重新生成（[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)）。随机长度要匹配编码：同样 64 位熵，十六进制需要 16 个字符，Base64URL 只需要约 11 个字符，因此“ID 看起来够长”并不能推断熵足够。

### 轮换、超时与共享存储

把上面的存储接到一个最小 HTTP 服务上（`lib/session_server.dart`，同样用 `HttpServer` 实现），就能观察轮换前后的差别：登录拿到一个 `sid`，改密码后服务端换发新 ID，旧 ID 立刻变成无效。

```text
> curl -s -D - -o /dev/null -c b15_jar.txt -d "user=alice" http://127.0.0.1:18080/login | grep -iE "^(HTTP|set-cookie)"
HTTP/1.1 200 OK
set-cookie: sid=tHYMNJ5e-aS5-7nBfdYzBCLq_w-hUMP8jx9GBpVVIIo; HttpOnly; Path=/; SameSite=Lax
> curl -s -b b15_jar.txt http://127.0.0.1:18080/me
hello, alice
> cp b15_jar.txt old_jar.txt && curl -s -D - -o /dev/null -b b15_jar.txt -c b15_jar.txt -X POST http://127.0.0.1:18080/change-password | grep -iE "^(HTTP|set-cookie)"
HTTP/1.1 200 OK
set-cookie: sid=h_d2ES0ahcLaV7T6H5_FY15x70wK_xp_aFXtJHM6q8w; HttpOnly; Path=/; SameSite=Lax
> curl -s -o /dev/null -w "%{http_code}\n" -b old_jar.txt http://127.0.0.1:18080/me
401
> curl -s -b b15_jar.txt http://127.0.0.1:18080/me
hello, alice
> curl -s -b b15_jar.txt http://127.0.0.1:18080/logout
logged out
> curl -s -o /dev/null -w "%{http_code}\n" -b b15_jar.txt http://127.0.0.1:18080/me
401
```

<!-- verify: .work/verify/B15/lib/session_server.dart -->

上面命令里的 `old_jar.txt` 保存了轮换前的 Cookie，因此最后两层验证能同时看到“旧 ID 已失效”与“新 ID 仍有效”。完整命令与输出的保存位置及哈希记录见 `.work/verify/verification-report.md` 的 B15 小节。

“会话固定”（session fixation）是这条时序里最容易被忽略的陷阱：攻击者先把自己的 Session ID 塞给受害者，受害者用它登录，服务端若不换发新 ID，攻击者手里的旧 ID 就自动获得了已认证身份。RFC 6265 对这一攻击给出了明确提醒，并指出服务端应避免这种漏洞（[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265) 第 8.4 节）。

存储位置决定扩展方式：进程内内存最简单，但多实例部署时不同实例互不可见，只能靠粘性会话或共享存储（例如 Redis）；无论放在哪里，会话的权威性都来自服务端的记录，而不是客户端持有的字符串。

超时至少要区分两种：空闲超时（idle timeout）限制长期不活动的会话，绝对超时（absolute timeout）限制会话总寿命，两者都不能只靠客户端定时器实现。OWASP 给出的参考区间是：高价值应用的空闲超时 2–5 分钟、低风险应用 15–30 分钟，绝对超时常按业务使用时长设定（[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)）。

> **关键认知：** Session 的“状态在服务端”意味着客户端只持有一个随机标识；这让即时失效成为可能，代价是每次请求都要多一次状态查询，并且这份状态必须能被所有实例访问到。

> **面试高频：** Cookie 和 Session 是什么关系，各自的边界在哪？
> **答题脉络：** Cookie 是浏览器自动携带的键值对 → Session 是服务端的状态记录 → Cookie 常被选作 Session ID 的运输工具，但也可以换成 URL 重写或自定义头 → 两者结合方式不同，失效与扩展策略也不同。
> **追问方向：** Session ID 存哪里、怎么防会话固定、粘性会话与共享存储的取舍、多端登录如何共享会话。

## Bearer Token：凭证移到 Authorization 头

令牌（token）是服务端签发的凭证字符串，客户端把它放进 `Authorization` 请求头，而不是依赖浏览器自动携带：

```http
GET /orders HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token"
```

`Bearer` 的语义是“持有者即可使用”：令牌不要求提供者证明自己与令牌的绑定关系，因此任何拿到它的人都能用它访问资源（[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) 第 1 节）。同一份规范给出的首要要求就是保护令牌不被泄漏，并强制在传输中使用 TLS（第 5.3 节）。

与 Cookie 相比，`Authorization` 头不会被浏览器自动附加，因此跨站伪造请求拿不到这份凭证；但这也意味着令牌必须由客户端脚本显式读取和附加，一旦页面存在 XSS，令牌就可能被直接取走。

> **关键认知：** `Bearer` 令牌不在协议层区分持有者，所以它的安全性几乎全部来自“不被泄漏”和“传输受保护”；把令牌放进 URL、日志或可被脚本读取的存储里，等于把这个前提拆掉。

## JWT：一个被签名的 JSON 载荷

JSON Web Token（JWT，JSON 网络令牌）是一种令牌的**表示格式**，不是认证协议，也不等于 OAuth。它解决的问题是：如何让接收方在不查询发放方数据库的前提下，判断一段结构化数据是否由持钥方签发、是否被改动。

### 三段结构与签名输入

一个 JWT 是两段 Base64URL 文本加一段签名，用 `.` 连接：

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbSIsInN1YiI6ImFsaWNlIiwiaWF0IjoxNzg4MjY0MDAwLCJleHAiOjE3ODgyNjQ2MDB9.Vu9iKolqor2HUaygJqz68b_XgfOPEnDclAN_QMcM7SI

头部    eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
载荷    eyJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbSIsInN1YiI6ImFsaWNlIiwiaWF0IjoxNzg4MjY0MDAwLCJleHAiOjE3ODgyNjQ2MDB9
签名    Vu9iKolqor2HUaygJqz68b_XgfOPEnDclAN_QMcM7SI
```

上面这个令牌由本文后面展示的 `signHs256` 生成，头部解码后是 `{"alg":"HS256","typ":"JWT"}`，载荷解码后是 `{"iss":"https://auth.example.com","aud":"https://api.example.com","sub":"alice","iat":1788264000,"exp":1788264600}`。

- 头部（JOSE Header）至少包含 `alg`（签名算法），常带 `typ` 与 `kid`（密钥编号）；
- 载荷（JWT Claims Set）是一组声明，注册声明的含义由 JWT 规范的 4.1 节定义：`iss` 签发者、`sub` 主体、`aud` 受众、`exp` 到期时间、`nbf` 生效时间、`iat` 签发时间、`jti` 唯一编号；
- 签名（Signature）对 `ASCII(BASE64URL(头部) || '.' || BASE64URL(载荷))` 这段字节计算（[RFC 7515](https://www.rfc-editor.org/rfc/rfc7515) 第 3.1 节）。这里的 Base64URL 是 Base64 的 URL 安全变体，并且省略了末尾的 `=` 填充；字符表与填充规则见 [Base64 编码](../01-数据表示/03-Base64编码.md#url-safe-base64)。

签名算法分两类：`HS256` 这类消息认证码（MAC，Message Authentication Code）用同一个密钥签名与验证，因此验证方也能签发；`RS256`、`ES256` 这类非对称签名用私钥签、公钥验，更适合“一个签发者、多个验证者”的拓扑。RFC 9068 建议 JWT 访问令牌使用非对称算法，便于资源服务器获取验证材料（[RFC 9068](https://www.rfc-editor.org/rfc/rfc9068) 第 2.1 节）。

“JWT 是签名的”这个默认印象也需要限定：JWT 可以由 JSON Web Signature（JWS，JSON 网络签名）承载，也可以由 JSON Web Encryption（JWE）承载，还可以是既不签名也不加密的“未签名 JWT”。日常见到的三段式 JWT 几乎都是 JWS，见到的 `alg: none` 则是必须拒绝的遗留形态——RFC 9068 直接规定 JWT 访问令牌不得使用 `none`（第 2.1 节）。

> **关键认知：** 三段式 JWT 的头部与载荷只是 Base64URL 编码，任何人都能解码阅读；签名保护的是完整性与来源，不是机密性。

> **时效信息（核查日期：2026-09）：** OAuth 2.0 不要求访问令牌必须是 JWT（[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) 未规定格式）；`typ` 为 `at+jwt`、声明 `iss`/`exp`/`aud`/`sub`/`client_id`/`iat`/`jti` 全部必需的 JWT 访问令牌，是 RFC 9068（2021-10）定义的 profile，不是 JWT 的通用要求。

### 用 Dart 拼出一个 JWT

下面这段代码只做两件事：把 JSON 编码成不带填充的 Base64URL，再把它解码回来。第三段签名由算法生成，这里先不涉及。

```dart
// 前置条件：Dart 3.x；纯 Dart（dart:convert）。
//
// 演示 JWS 使用的 Base64URL（RFC 4648 §5）：URL 安全字符表，且去掉 '=' 填充。
import 'dart:convert';

void main() {
  final header = jsonEncode({'alg': 'HS256', 'typ': 'JWT'});
  final payload = jsonEncode({'sub': 'alice', 'exp': 1790000000});

  // 1. 头和载荷分别编码成不带 '=' 填充的 Base64URL 文本。
  final encodedHeader = _base64UrlNoPad(header);
  final encodedPayload = _base64UrlNoPad(payload);

  // 2. 两段用 '.' 连接，就是 JWT 的前两段（第三段签名由算法生成）。
  print('$encodedHeader.$encodedPayload');

  // 3. 任何人都能解码查看内容：Base64URL 是编码，不是加密，也不提供签名。
  print(utf8.decode(_decodeSegment(encodedHeader)));
  print(utf8.decode(_decodeSegment(encodedPayload)));
}

String _base64UrlNoPad(String text) =>
    base64UrlEncode(utf8.encode(text)).replaceAll('=', '');

List<int> _decodeSegment(String segment) {
  final padding = (4 - segment.length % 4) % 4;
  return base64Url.decode(segment.padRight(segment.length + padding, '='));
}
```

<!-- verify: .work/verify/B15/lib/base64url_demo.dart -->

运行输出直接印证了“编码不等于加密”：两段文本都是可读 JSON。

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSIsImV4cCI6MTc5MDAwMDAwMH0
{"alg":"HS256","typ":"JWT"}
{"sub":"alice","exp":1790000000}
```

把签名补上并不复杂：对 `头部.载荷` 计算 HMAC-SHA256，再对结果做同样的 Base64URL 编码。注意签名只覆盖头部与载荷的编码形式，因此任何字段改动都会让签名失配。下面的代码块抽取 `signHs256` 与它依赖的 `_segment`（`JwtException` 与 import 见 companion file）：

```dart
String _segment(Object? value) =>
    base64UrlEncode(utf8.encode(jsonEncode(value))).replaceAll('=', '');

/// 生成带 HS256 签名的 JWT。
///
/// 签名只保护完整性与来源，不隐藏头部和载荷；载荷中不要放敏感信息。
String signHs256({
  required Map<String, Object?> header,
  required Map<String, Object?> payload,
  required String secret,
}) {
  final signingInput = '${_segment(header)}.${_segment(payload)}';
  final mac = Hmac(
    sha256,
    utf8.encode(secret),
  ).convert(utf8.encode(signingInput));
  return '$signingInput.${base64UrlEncode(mac.bytes).replaceAll('=', '')}';
}
```

<!-- verify: .work/verify/B15/lib/jwt_hs256.dart -->

`Hmac` 与 `sha256` 来自 `package:crypto`，因为 Dart 标准库不提供哈希与消息认证码实现；本文只保留这一处第三方依赖，生产环境应直接使用维护良好的 JOSE 库，而不是自己拼装签名流程。

> **面试高频：** JWT 是不是加密的？它的优缺点怎么答？
> **答题脉络：** 三段式 JWT 默认是 JWS（签名）→ 载荷可读，不能放秘密 → 优点是无状态校验、跨服务传递声明、结构自描述 → 代价是体积更大、签发后难以撤销、密钥与声明校验一旦出错影响面很大。
> **追问方向：** JWE 与 JWS 的差别、`HS256` 与 `RS256` 的选型、把 JWT 放进 Cookie 与放进 `Authorization` 头的差别。

## 校验一个 JWT：先验签，再验声明

JWT 的“自包含”意味着接收方必须自己完成所有判定。顺序不能颠倒，也不能省略：

1. 结构检查：必须是三段紧凑序列化，签名段不能为空；
2. 算法检查：`alg` 必须在调用方声明的白名单内，拒绝 `none`，拒绝算法与密钥类型混淆；
3. 签名验证：用密钥重算签名并做常量时间比较；
4. 声明验证：`exp`、`nbf`（允许少量时钟偏差）、`iss`、`aud`，必要时再检查 `typ` 与 `jti`；
5. 通过之后才使用载荷。

第 1、2 步为什么不能省：把 `alg` 改成 `none` 曾经能让部分库跳过验签；把 `RS256` 改成 `HS256` 则可能让库用 RSA 公钥当作 HMAC 密钥去验证（[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725) 第 2.1 节）。对应的规则是：库必须允许调用方指定支持的算法集合，并且每个密钥只能用于一种算法（第 3.1 节）。

第 4 步为什么不能只验 `exp`：`iss` 决定“谁签的”，`aud` 决定“给谁用的”。同一个签发者可能同时为多个受众签发令牌，如果接收方不校验 `aud`，一个为 A 服务签发的令牌就能在 B 服务上使用（第 3.9 节）。`exp` 与 `nbf` 的判定允许少量时钟偏差，规范建议通常不超过几分钟（[RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) 第 4.1.4、4.1.5 节）。

### 最小校验实现

```dart
  // 1. 紧凑序列化必须是三段，且签名段不能为空（拒绝未签名的 alg=none）。
  final parts = token.split('.');
  if (parts.length != 3 || parts.any((part) => part.isEmpty)) {
    throw JwtException('不是三段紧凑序列化，或签名段为空');
  }

  // 2. 先看算法头：只接受白名单内的算法，避免算法混淆与 none 绕过。
  final header =
      jsonDecode(utf8.decode(_decodeSegment(parts[0]))) as Map<String, Object?>;
  if (header['alg'] != 'HS256') {
    throw JwtException('算法不在白名单内：alg=${header['alg']}');
  }

  // 3. 用同一密钥重算签名，并做常量时间比较。
  final expectedMac = Hmac(
    sha256,
    utf8.encode(secret),
  ).convert(utf8.encode('${parts[0]}.${parts[1]}'));
  if (!_constantTimeEquals(expectedMac.bytes, _decodeSegment(parts[2]))) {
    throw JwtException('签名不匹配');
  }

  // 4. 校验时间与身份声明；未知声明忽略，不做信任推断。
  final claims =
      jsonDecode(utf8.decode(_decodeSegment(parts[1]))) as Map<String, Object?>;
  final exp = (claims['exp'] as num?)?.toInt();
  if (exp == null) throw JwtException('缺少 exp');
  if (!now.isBefore(_fromSeconds(exp).add(leeway))) {
    throw JwtException('已过期');
  }
  final nbf = (claims['nbf'] as num?)?.toInt();
  if (nbf != null && now.isBefore(_fromSeconds(nbf).subtract(leeway))) {
    throw JwtException('尚未生效');
  }
  if (claims['iss'] != expectedIssuer) throw JwtException('iss 不匹配');
  final aud = claims['aud'];
  final audiences = aud is String
      ? <Object?>[aud]
      : (aud is List ? aud : const <Object?>[]);
  if (!audiences.contains(expectedAudience)) throw JwtException('aud 不匹配');
  return claims;
```

<!-- verify: .work/verify/B15/lib/jwt_hs256.dart -->

上面是 `verifyHs256` 的函数体：它的参数列表（`token`、`secret`、`expectedIssuer`、`expectedAudience`、`now`、`leeway`）与它调用的三个辅助函数 `_decodeSegment`、`_constantTimeEquals`、`_fromSeconds` 见 companion file。两处细节值得单独记住：比较签名时用累加异或做常量时间比较，避免按字节短路返回；`aud` 既可能是字符串也可能是数组，规范两种都允许（[RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) 第 4.1.3 节）。

头部里的 `kid`、`jku`、`x5u` 同样是不可信输入：`kid` 若直接拼进数据库或目录查询会造成注入，`jku`/`x5u` 若被无条件跟随会造成服务端请求伪造，应把取值限制在允许列表内（[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725) 第 3.10 节）。

### 失败场景比成功场景更值得观察

```text
token = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbSIsInN1YiI6ImFsaWNlIiwiaWF0IjoxNzg4MjY0MDAwLCJleHAiOjE3ODgyNjQ2MDB9.Vu9iKolqor2HUaygJqz68b_XgfOPEnDclAN_QMcM7SI
sub = alice
tampered -> JwtException: 签名不匹配
alg=none -> JwtException: 算法不在白名单内：alg=none
放大到 10 分钟偏差时 sub = alice
expired -> JwtException: 已过期
```

<!-- verify: .work/verify/B15/lib/jwt_hs256.dart -->

输出里除正常路径那行以外，四条信息分别对应不同的判定：把载荷换成别的用户但沿用旧签名，会在第 3 步失败；把 `alg` 改成 `none`，会在第 2 步失败而不进入验签；“放大时钟偏差”这一行说明 `leeway` 是一个真实的取舍参数，放宽它会同时放宽攻击窗口；最后一行说明签名正确也不能绕过 `exp`。

> **关键认知：** 签名通过只证明“这段载荷由持钥方签发且未被改动”，不证明“这段载荷现在仍然有效”；到期、撤销与权限变化属于另外两层判断，必须由服务端补上。

> **面试高频：** 为什么必须校验 `iss`、`aud`、`exp`、`nbf`？
> **答题脉络：** 签名只覆盖完整性与来源 → `iss` 确认签发者、`aud` 确认受众，防跨服务混用令牌 → `exp`/`nbf` 限定时间窗口，需容忍少量时钟偏差 → 省略任一项都会把“能用”当成“该用”。
> **追问方向：** 多受众令牌、时钟偏差取值、`typ` 与 `kid` 的作用、JWT 与不透明令牌的校验差别。

## 无状态令牌的代价：撤销与续期

JWT 最常被宣传的优点是不需要服务端存储：资源服务器拿到令牌，验签加声明校验即可放行。可是只要业务出现“立即踢下线”“改密码后旧令牌作废”这类需求，这个优点就会遇到硬边界。

令牌本身没有任何可被服务端修改的部分，因此“撤销”只能通过外部状态实现：

- 短有效期 + 刷新令牌轮换：把“立即失效”换成“最多几分钟内失效”；
- `jti` 与用户级令牌版本号：把令牌编号或版本记在 Redis 一类的共享存储里，校验时比对，代价是每次请求多一次查询；
- 黑名单：只针对需要立即拦截的少数令牌，需要控制列表规模与过期清理。

无论选哪种，服务端都重新引入了状态：这正是“无状态”的代价——它把成本从“查询会话”转移到了“管理过期、轮换与密钥”。

> **关键认知：** JWT 的无状态性来自“状态被搬进了令牌”；服务端不查表就能验签，代价是签发后无法直接删除，只能等它过期，或用额外的状态来否证它。

> **面试高频：** 服务端怎么吊销 JWT？
> **答题脉络：** 令牌在客户端且不可修改 → 自然过期最短可达时间由 `exp` 决定 → 需要即时失效就必须引入服务端状态（黑名单、版本号、`jti` 记录）→ 说明这部分状态会让“无状态”打折，最后给出按业务选折中的方法。
> **追问方向：** 黑名单的存储与过期清理、用户级版本号与全端登出、短 TTL 带来的刷新压力。

### 两种状态归属怎么选

把前面几节收成一张对照表。它们不是互斥的技术，而是同一件事的两种归位方式：用户状态放在服务端，还是放进客户端持有的凭证。

| 维度 | 服务端会话 + Session ID | 自包含令牌（如 JWT） |
| --- | --- | --- |
| 状态位置 | 服务端记录，客户端只持随机 ID | 声明随令牌一起下发，服务端不存 |
| 每次校验的成本 | 一次存储查询（会话存在共享存储时是网络往返） | 一次签名运算，不需要查询 |
| 失效与撤销 | 删记录即生效 | 只能等 `exp` 到期，或用额外状态否证 |
| 体积与带宽 | ID 通常是几十字节 | 携带声明，体积随声明增长，且随每次请求发送 |
| 跨服务扩展 | 需要所有实例访问同一份会话存储 | 验证方只需拿到公钥与校验规则 |
| 新增依赖 | 会话存储的可用性与容量 | 密钥分发与轮换、时钟同步、声明校验实现 |

选择时先问三个问题：这个凭证需要多快失效？验证方有几个、是否与签发方同一套代码？令牌里是否真的需要携带声明？答案越偏向“立即失效”“验证方很少”“不需要携带声明”，服务端会话越简单；越偏向“跨服务验证”“短有效期”“一次性使用”，自包含令牌越合适。

> **关键认知：** 服务端会话与自包含令牌的区别不在“安全程度”，而在状态归位方式：前者把撤销权留给服务端，后者把验证成本留给令牌本身。

## access token 与 refresh token

实践中很少只发一种令牌：访问令牌（access token）有效期短、随每个请求发送、直接对应资源权限；刷新令牌（refresh token）有效期长、只用于向授权服务器换取新的访问令牌，因此它暴露的机会更少、价值更高。

这种分工把“频繁使用”与“长期有效”拆开，代价是引入刷新流程与新的攻击面。RFC 9700 的要求是：公共客户端的刷新令牌必须要么受发送者约束，要么使用刷新令牌轮换（[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) 第 2.2.2 节）。轮换的要点是每次刷新都换发新的刷新令牌并让旧的失效，一旦发现旧令牌被再次使用，就说明它已经泄漏，应作废整条令牌链。

存储位置同样要按威胁模型选：浏览器 `localStorage` 里的令牌可被任何同源脚本读取；`HttpOnly` Cookie 免于脚本读取，但会被自动携带，必须同时处理 CSRF；移动端应使用系统提供的密钥存储。三种选择都不是“更安全”，而是在 XSS、CSRF 与设备本地提取之间做取舍。

> **关键认知：** 刷新令牌等价于一份长期登录权，它的存储位置与轮换策略比访问令牌的短有效期更决定整体安全性；只把访问令牌做短，却把刷新令牌长期放在可被脚本读取的地方，等于把风险推后而没消除。

> **时效信息（核查日期：2026-09）：** RFC 9700（BCP 240，2025-01）是 OAuth 2.0 的安全最佳实践，其中对刷新令牌轮换、发送者约束和受众限制提出了要求；OAuth 2.1 仍处于草案阶段（`draft-ietf-oauth-v2-1-15`，2026-03-02），用于合并 OAuth 2.0 及其安全实践，尚不能当作已发布标准引用。

> **面试高频：** 为什么要区分访问令牌与刷新令牌，刷新令牌放在哪里？
> **答题脉络：** 使用频率与有效期不能同时最优 → 短访问令牌限制泄漏窗口，长刷新令牌换取新令牌 → 刷新令牌要轮换、要可检测重放 → 存储位置按 XSS/CSRF/本地提取三类威胁取舍。
> **追问方向：** 刷新令牌重用检测、静默续期的实现、多端登录与全端登出的会话管理。

## 会话被偷走的几条路

会话机制本身不产生漏洞，泄漏渠道才是关键。三条最常见：

### XSS：脚本能拿到什么

注入的脚本与页面同源，因此“读得到的凭证”和“发得出的请求”要分开看：`HttpOnly` Cookie 读不到值，但脚本仍然可以代替用户发请求；放在 `localStorage` 或 JS 变量里的令牌则直接被读走。也就是说，`HttpOnly` 能把“永久窃取令牌”降级为“用受害者的会话做操作”，不能消除 XSS 的危害。攻击的成立条件、上下文编码与分层防护属于安全板块的范围，本文只讨论它与会话凭证的关系。

### CSRF：Cookie 为什么会被自动利用

浏览器只看目标站点决定是否携带 Cookie，不看请求由哪个页面发起。于是第三方页面只要构造一个指向目标站点的请求，用户的 Cookie 就会被自动附加。服务端的防护要点是“让第三方无法构造出有效请求”：校验 `SameSite`、要求 CSRF 令牌、校验 `Origin`/`Referer` 等。把凭证从 Cookie 换成显式附加的 `Authorization` 头，能从机制上移除这种自动携带，但前提是脚本没有被注入。

### 重放与发送者约束

`Bearer` 令牌不区分持有者，因此一旦被复制（XSS、日志、恶意的调试代理），攻击者可以在别处直接复用。要减少重放影响，可以让令牌与某个密钥绑定，例如 DPoP 让客户端用私钥对请求签名（[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)），或使用双向 TLS 把令牌绑定到证书。这类发送者约束（sender-constrained）机制也正是 RFC 9700 对高价值令牌的推荐方向（第 2.2.1 节）。

> **面试高频：** `HttpOnly` 能防 CSRF 吗？XSS 与 CSRF 对会话的影响有什么不同？
> **答题脉络：** `HttpOnly` 只限制脚本读取 → CSRF 利用的是浏览器自动携带，与脚本读取无关 → XSS 拿到的是“在页面内执行的能力”，可以绕过 `HttpOnly` 的边界做操作 → 所以两种攻击需要各自的防护，不能互相替代。
> **追问方向：** `SameSite` 与 CSRF 令牌如何配合、XSS 场景下会话轮换的价值、令牌绑定到设备或密钥。

## OAuth 2.0、OIDC 与 JWT 的边界

这三者经常被混着说，但层级不同：

- OAuth 2.0 是**授权委托**框架，解决“让第三方在有限范围内代表用户访问资源”，访问令牌的格式不在其规范里；
- OpenID Connect（OIDC）建立在 OAuth 2.0 之上，增加**认证**能力，结果是 ID Token——一个 JWT，用来向客户端说明“用户是谁”（[OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)）；
- JWT 只是一种令牌表示格式，可以用在 OIDC 的 ID Token 上，也可以用于自研的登录态。

由此得到两条实践结论：OAuth 2.0 本身不等于登录方案；ID Token 与访问令牌不能互相替代——前者面向客户端，后者面向资源服务器，受众不同，混用会让 `aud` 校验失去意义。RFC 8725 专门提醒不同用途的 JWT 必须使用互斥的校验规则（第 3.12 节）。

> **历史机制（不推荐）：** 隐式授权（`response_type=token`）曾用于纯前端应用，它把访问令牌直接放在重定向 URL 里返回。RFC 9700 明确指出这类流程易受令牌泄漏与重放影响，客户端应当改用授权码流程（第 2.1.2 节）。

## 常见误区

### 把 Cookie 当成认证机制

Cookie 只是浏览器自动携带的键值对。真正决定“是否登录”的是服务端对内容的解释——同一个 Cookie 可以是 Session ID，也可以只是主题偏好。

### 认为 JWT 是加密的

三段式 JWT 默认只签名不加密，载荷随时可以解码。载荷里放密码、身份证号或内部标识，等价于把它们写在请求头里。

### 认为 Session 必须放在内存里

内存实现最简单，但多实例部署时无法共享。会话可以放在 Redis、数据库等共享存储中，只要所有实例都能访问同一份权威记录即可。

### 认为无状态就不需要存储

无状态指的是验证令牌时不必查询发放方的会话表。一旦需要即时撤销、统计登录设备或做全端登出，就必须引入额外状态；区别只是这份状态存放的位置与查询频率。

### 认为客户端删掉令牌就等于注销

删除 Cookie 或清空 `localStorage` 只影响当前客户端。服务端记录仍然有效，令牌在到期前仍可能被使用；真正的注销需要服务端动作配合，且对 JWT 要额外处理。

### 用 Base64URL 换取安全感

Base64URL 只是让字节能安全地放进 URL 与 JSON 文本的编码，它不需要密钥，任何人都能还原。需要保密就用加密，需要证明未被改动就用消息认证码或签名。

### 把令牌的有效期当作唯一防线

有效期决定泄漏后的时间窗口，不决定攻击能否发生。受众限制、发送者约束、轮换与检测同样影响最终影响面。

## 参考资料

- [R1] [RFC] [RFC 6265: HTTP State Management Mechanism](https://www.rfc-editor.org/rfc/rfc6265) — IETF，2011-04 发布，第 6.1 节数量与大小限制、第 8.2 节环境权限、第 8.4 节 Session ID 与会话固定、第 8.5 节隔离限制，[核查日期：2026-09]。
- [R2] [草案] [draft-ietf-httpbis-rfc6265bis-22: Cookies: HTTP State Management Mechanism](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/) — IETF，2025-12-01 发布，第 4.1.3 节名称前缀、第 5.6.7 节 `SameSite`、第 5.7 节存储模型与 4096 octets 上限、第 6.1 节限制；截至核查日期仍为 Active Internet-Draft，[核查日期：2026-09]。
- [R3] [RFC] [RFC 7515: JSON Web Signature (JWS)](https://www.rfc-editor.org/rfc/rfc7515) — IETF，2015-05 发布，第 3.1 节签名输入构造，[核查日期：2026-09]。
- [R4] [RFC] [RFC 7519: JSON Web Token (JWT)](https://www.rfc-editor.org/rfc/rfc7519) — IETF，2015-05 发布，第 3.1 节示例、第 4.1 节注册声明、第 7.2 节校验步骤，[核查日期：2026-09]。
- [R5] [RFC] [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725) — IETF，2020-02 发布，第 2.1 节算法攻击、第 3.1 节算法校验、第 3.9 节受众校验、第 3.10 节不可信头部、第 3.12 节互斥校验规则，[核查日期：2026-09]。
- [R6] [RFC] [RFC 6750: The OAuth 2.0 Authorization Framework: Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750) — IETF，2012-10 发布，第 2.1 节请求头形式、第 2.3 节 URI 查询参数、第 5.3 节必须使用 TLS，[核查日期：2026-09]。
- [R7] [RFC] [RFC 9068: JSON Web Token (JWT) Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068) — IETF，2021-10 发布，第 2.1 节头部要求与 `at+jwt`、第 2.2 节必需声明、第 4 节校验步骤，[核查日期：2026-09]。
- [R8] [RFC] [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700) — IETF，BCP 240，2025-01 发布，第 2.1.2 节隐式授权、第 2.2.1 节发送者约束、第 2.2.2 节刷新令牌、第 2.3 节受众限制，[核查日期：2026-09]。
- [R9] [草案] [draft-ietf-oauth-v2-1-15: The OAuth 2.1 Authorization Framework](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) — IETF，2026-03-02 发布；截至核查日期仍是 Active Internet-Draft，[核查日期：2026-09]。
- [R10] [官方文档] [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) — OWASP，Session ID 熵与长度、权限变化后轮换、空闲超时与绝对超时建议，[核查日期：2026-09]。
- [R11] [官方文档] [MDN: Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) — Mozilla，属性与名称前缀说明、`document.cookie` 与 `HttpOnly` 的关系，[核查日期：2026-09]。
- [R12] [官方文档] [MDN: Using HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies) — Mozilla，三大用途、客户端存储 API 的替代建议，[核查日期：2026-09]。
- [R13] [标准] [OpenID Connect Core 1.0 incorporating errata set 2](https://openid.net/specs/openid-connect-core-1_0.html) — OpenID Foundation，ID Token 的声明与校验，[核查日期：2026-09]。
- [R14] [RFC] [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://www.rfc-editor.org/rfc/rfc9449) — IETF，2023-09 发布，令牌发送者约束与重放检测，[核查日期：2026-09]。
- [R15] [RFC] [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749) — IETF，2012-10 发布，第 1.4 节访问令牌定义，[核查日期：2026-09]。
- [R16] [官方文档] [Privacy Sandbox: Third-party cookies](https://privacysandbox.google.com/cookies) — Google，第三方 Cookie 与 `Partitioned`（CHIPS）等浏览器侧机制的当前状态，[核查日期：2026-09]。

## 一句话总结

> 认证只负责确认身份，真正让请求“保持登录”的是每次重新携带的会话凭证：把状态放在服务端换来可撤销，把状态签进令牌换来免查询，而两者的安全性都取决于校验顺序、有效期、轮换与存储位置。
