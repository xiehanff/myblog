# 计算机网络｜HTTP 语义、缓存与版本演进

规范核查日期：2026-09-22。正文涉及的规范版本、浏览器支持状态与部署比例都按该日期核查，各段再标出具体来源与统计口径。

同一个头像接口被 App 反复调用，如果每次都把完整响应重新下载一遍，浪费的是流量和用户等待时间；可当用户改完资料刷新页面却仍看到旧内容时，又说明这次“缓存”没有被正确跳过。这两件事看起来相反，其实都是同一套判断没有理清：哪些响应可以存、副本还能不能用、不能用时该验证还是重传。

很多人口中的 HTTP 知识来自口诀：“GET 长度有限、POST 更安全、PUT 没有认证机制、no-cache 就是完全不缓存”。这些说法要么早已过时，要么把实现细节当成了协议规定。RFC 9110 定义的方法属性、RFC 9111 定义的缓存算法，才是浏览器、代理和 CDN 真正依据的规则。

本文路线：先建立“HTTP 是一套语义”的模型（资源、表示、方法与属性），再看状态码和字段如何表达条件请求、内容协商与范围；然后用一套决策算法讲清缓存；最后回到线上承载，说明 HTTP/1.1、HTTP/2、HTTP/3 如何传递同一套语义，以及浏览器为什么还要额外用 CORS 限制读取。

<!-- GFM-TOC -->
* [HTTP 先是一套语义，不等于某种文本格式](#http-先是一套语义不等于某种文本格式)
* [URL、请求目标与消息模型](#url请求目标与消息模型)
* [方法：先看承诺，再看常见用途](#方法先看承诺再看常见用途)
* [状态码是响应语义，不是业务真相](#状态码是响应语义不是业务真相)
* [字段、表示与内容协商](#字段表示与内容协商)
* [条件请求、范围请求与并发更新](#条件请求范围请求与并发更新)
* [HTTP 缓存是一套决策算法](#http-缓存是一套决策算法)
* [连接、代理、网关、隧道与 CDN](#连接代理网关隧道与-cdn)
* [HTTP/1.0 与 HTTP/1.1：从短连接到持久连接](#http10-与-http11从短连接到持久连接)
* [HTTP/2：帧、流、HPACK 与 TCP 队头阻塞](#http2帧流hpack-与-tcp-队头阻塞)
* [HTTP/3：HTTP 语义如何映射到 QUIC](#http3http-语义如何映射到-quic)
* [浏览器边界：同源策略与 CORS](#浏览器边界同源策略与-cors)
* [用 curl 构造可复现的 HTTP 实验](#用-curl-构造可复现的-http-实验)
* [常见误区](#常见误区)
* [参考资料](#参考资料)
* [一句话总结](#一句话总结)
<!-- GFM-TOC -->

## HTTP 先是一套语义，不等于某种文本格式

同一个 `GET` 请求，可能跑在 HTTP/1.1 的文本报文里，也可能跑在 HTTP/2 的二进制帧或 HTTP/3 的 QUIC 流里；服务端和客户端各自升级，谁也不需要改业务代码。这背后是 HTTP 的分层设计：语义与承载分离。

- **语义层**由 RFC 9110 定义：方法、状态码、字段含义、条件请求、内容协商。缓存规则单独放在 RFC 9111。
- **承载层**由 RFC 9112（HTTP/1.1）、RFC 9113（HTTP/2）、RFC 9114（HTTP/3）分别定义：消息如何编码、如何在一段连接上复用、如何进行流控。

只有把这两层分开，才能解释“HTTP/2 更快”到底快在哪：它完全没有改变 `GET /profile` 的含义，只改变了这条消息的编码与传输方式。

接下来要建立的几个概念，后续所有讨论都基于它们：

- **客户端（user agent）**：发起请求的一方，可能是浏览器、移动 App 或命令行工具。
- **源服务器（origin server）**：资源的权威来源，负责生成或存储表示。
- **中间节点（intermediary）**：代理（proxy）、网关（gateway）、隧道（tunnel），都会按字段语义转发、改写或缓存消息。
- **资源（resource）**：可以被标识和操作的目标，例如 `/profile`。
- **表示（representation）**：资源在某一时刻、某一内容协商结果下的具体数据，由媒体类型、字符集、编码等元数据描述。术语从 “entity” 更新为 “representation” 就是 RFC 9110 相对旧规范的变化之一。
- **无状态（stateless）**：协议本身不在两次请求之间保存应用状态；需要“记住用户”时，由 Cookie、令牌等机制把状态带回服务端。

> **关键认知：** HTTP 语义与承载版本解耦：换到 HTTP/2 或 HTTP/3 不需要修改方法、状态码和字段的含义；HTTPS 也不是“另一套 HTTP”，它是 HTTP 消息在 TLS 之上传输。

> **历史机制（已废弃）：** RFC 2616 是 1999 年的统一规范，2014 年被 RFC 7230–7235 取代，2022 年又被 RFC 9110–9114 取代。现在引用“HTTP 规范”应指向 9110 系列。[核查日期：2026-09]

> **面试高频：** HTTP 是无状态的，那登录状态是怎么保持的？
> **答题脉络：** 先说明无状态指协议不保存应用状态 → 服务器通过 Set-Cookie 下发标识、客户端后续请求带 Cookie → 服务端用会话或令牌还原用户身份。
> **追问方向：** Cookie 属性（Secure/HttpOnly/SameSite）、会话与自包含令牌的取舍、撤销与过期（详见[身份认证：Cookie、Session 与 JWT](./09-身份认证：Cookie、Session与JWT.md)）。

## URL、请求目标与消息模型

URL 是 URI 的一种：它同时提供标识和定位信息。本篇只用到其中的 authority（主机与端口）和 path/query 部分；完整的解析规则、编码与 URL 组件如何被浏览器处理，属于[一次网络请求的完整旅程](./06-一次网络请求的完整旅程.md)的主线。

HTTP 请求抽象成四个要素：**方法（method）、请求目标（request target）、字段区（field section）、内容（content）**。响应则是**状态码、字段区、内容**。在 HTTP/1.1 里，请求目标有四种写法（RFC 9112 第 3.2 节）：

- `origin-form`：最常见的 `/path?query`，直接发给源服务器。
- `absolute-form`：`http://host/path`，发给正向代理时使用。
- `authority-form`：`host:port`，用于 `CONNECT` 建立隧道。
- `asterisk-form`：`*`，用于 `OPTIONS *` 这类服务器级查询。

HTTP/1.1 的请求必须带 `Host`：缺少 Host、出现多个 Host 或 Host 值非法，服务器应当回 `400 Bad Request`。这条规则是虚拟主机与共享 CDN 的基础。

HTTP/1.1 的报文可以被人类逐行阅读，这是它最容易被误解的地方，也是最好的教学材料。先看一份等价于抓取过程的请求（为便于阅读只保留三个字段）：

```http
GET / HTTP/1.1
Host: example.com
Accept: text/html
```

对应的响应取自一次真实抓取（curl 8.17.0，2026-09-21 GMT，只保留与本节有关的字段，`Age` 等值会随抓取时刻变化，内容部分已截断）：

```http
HTTP/1.1 200 OK
Date: Mon, 21 Sep 2026 16:58:42 GMT
Content-Type: text/html
Transfer-Encoding: chunked
Age: 11255
last-modified: Tue, 15 Sep 2026 23:41:26 GMT
cf-cache-status: HIT

<!doctype html>...
```

这里已经能看到后续几节要讲的三件事：`Transfer-Encoding: chunked` 是 HTTP/1.1 的消息定界方式；`Age` 说明这份响应在到达客户端之前已经待在缓存里 11255 秒；`cf-cache-status: HIT` 是 CDN 提供的诊断字段（非标准字段，仅用于观察）。

HTTP/2 与 HTTP/3 不再有这些文本行。方法、目标、状态码被放进伪字段：`:method`、`:scheme`、`:path`、`:authority`、`:status`，与普通字段一起被压缩进 HEADERS 帧，内容放进 DATA 帧。抓包工具不解析帧，就只能看到二进制；RFC 9113 还明确规定 `Host` 与 `:authority` 不允许互相矛盾。

> **关键认知：** “请求行长什么样”只是 HTTP/1.1 的编码结果；方法、目标和状态码是语义概念，在 HTTP/2/3 中以伪字段存在，不能按文本逐行去抓。

## 方法：先看承诺，再看常见用途

方法不是动词标签，而是三项可被机器依赖的承诺（RFC 9110 第 9.2 节）：

- **安全（safe）**：语义上是只读的，客户端不请求也不期望服务器状态改变。
- **幂等（idempotent）**：同一个请求执行一次和执行多次，对服务器的预期效果相同。安全方法天然幂等，`PUT`、`DELETE` 也幂等。
- **可缓存（cacheable）**：RFC 9110 为 `GET`、`HEAD`、`POST` 定义了缓存语义，但实际上绝大多数缓存只实现 `GET` 和 `HEAD`。

| 方法 | 安全 | 幂等 | 规范语义 |
|---|---|---|---|
| GET | 是 | 是 | 获取目标资源的当前表示 |
| HEAD | 是 | 是 | 与 GET 相同，但不返回内容 |
| OPTIONS | 是 | 是 | 查询目标资源支持的能力 |
| TRACE | 是 | 是 | 消息回环测试；很多生产环境出于安全考虑会禁用它 |
| QUERY | 是 | 是 | 由 RFC 10008 新增：把查询内容放进请求体，按安全且幂等的方式执行 |
| PUT | 否 | 是 | 用请求内容替换目标资源的当前表示 |
| DELETE | 否 | 是 | 删除目标资源的当前表示 |
| POST | 否 | 否 | 交给目标资源按自身语义处理请求内容 |
| PATCH | 否 | 否 | 由 RFC 5789 单独定义，对资源做部分修改 |
| CONNECT | 否 | 否 | 建立隧道 |

这张表能拆掉一批口诀：

- **“GET 不能带请求体”**：RFC 9110 的准确表述是客户端“不应当”在 GET 中生成内容，除非直接对源服务器且对方事先声明支持。带 body 的 GET 请求会让中间节点难以转发（也是请求走私的常见素材），所以接口设计上应避免，但把它说成协议禁止并不准确。
- **“POST 参数在 body 里所以更安全”**：参数放在 URL 还是 body，只是位置差异。除非走 HTTPS，两者都被明文传输；POST 更容易被日志和错误上报采集，反而更需要小心敏感数据。
- **“PUT 没有认证机制”**：认证由 `Authorization`、`WWW-Authenticate` 等字段和凭据体系决定，与方法无关；`PUT` 的风险来自它是“整体替换”，不是缺少认证。
- **“URL 只支持 ASCII，所以 GET 有长度上限”**：URL 中的非 ASCII 字符需要百分号编码，这一点正确；但长度上限不存在于 HTTP 规范，它取决于浏览器、服务器、代理各自的实现配置。

幂等描述的是**预期效果**，不是响应字节：`DELETE /item/7` 第一次返回 `200`，第二次返回 `404`，仍然是幂等的，因为服务器状态在两次之后相同。这一点直接决定客户端能否在连接中断后自动重试：对非幂等方法重放可能重复下单、重复扣款，只能在服务端用业务幂等键去重的条件下才敢重试。

> **关键认知：** 安全与幂等是向机器发出的承诺，不是文档里的分类：浏览器的预取、代理与客户端的自动重试都默认依赖它，所以用 `GET` 触发写操作不只是风格问题，而是会让编译器与中间节点的默认行为全部失准。

```dart
// 前置条件：Dart 3.x；纯 Dart；无第三方依赖。
//
// RFC 9110 为方法定义了“安全（safe）”与“幂等（idempotent）”两个属性；
// 客户端、代理和缓存据此决定能否自动重放请求。

/// HTTP 方法与规范属性，包含 RFC 10008 新增的 QUERY。
enum HttpMethod {
  get('GET', safe: true, idempotent: true),
  head('HEAD', safe: true, idempotent: true),
  options('OPTIONS', safe: true, idempotent: true),
  trace('TRACE', safe: true, idempotent: true),
  query('QUERY', safe: true, idempotent: true),
  put('PUT', safe: false, idempotent: true),
  delete('DELETE', safe: false, idempotent: true),
  post('POST', safe: false, idempotent: false),
  patch('PATCH', safe: false, idempotent: false),
  connect('CONNECT', safe: false, idempotent: false);

  const HttpMethod(
    this.wireName, {
    required this.safe,
    required this.idempotent,
  });

  /// 出现在请求行中的方法名。
  final String wireName;

  /// 安全方法承诺语义只读，不请求也不期望服务器改变状态。
  final bool safe;

  /// 幂等方法重复执行一次或多次，预期效果相同。
  final bool idempotent;
}

/// 连接在收到响应前中断时，客户端能否自动重发同一请求。
bool canAutoRetry(HttpMethod method, {bool serverDeduplicates = false}) {
  // 1. 幂等方法重复发送的预期效果相同，可以直接重放。
  if (method.idempotent) return true;
  // 2. 非幂等方法只有在服务端能按业务键去重时才允许重放。
  return serverDeduplicates;
}
```

<!-- verify: .work/verify/B13/lib/idempotent_retry.dart -->

运行验证脚本会断言三件事：安全方法集合恰好是 `GET/HEAD/OPTIONS/TRACE/QUERY`；“安全蕴含幂等”对所有方法成立；`POST`、`PATCH` 只有在服务端去重时才允许自动重试。这段逻辑可以直接放进网络层的重试策略里。

> **时效信息（核查日期：2026-09）：** `QUERY` 由 RFC 10008（Standards Track，2026-06）定义，IANA HTTP Method Registry 已登记为 safe 且 idempotent。它的动机是填补 `GET` 与 `POST` 之间的空白：查询参数放进请求体，但语义仍是只读、可重试、可缓存。

> **面试高频：** GET、POST、PUT、PATCH、DELETE 的区别到底是什么？
> **答题脉络：** 先讲安全与幂等三项属性 → 再说缓存与重试的工程后果 → 最后纠正 URL 长度、POST 更安全、PUT 无认证等口诀。
> **追问方向：** 幂等是否要求响应完全相同、POST 在什么条件下可缓存、PATCH 为什么不保证幂等、服务端幂等键如何设计。

## 状态码是响应语义，不是业务真相

状态码分五类：1xx 中间响应、2xx 成功、3xx 重定向、4xx 客户端错误、5xx 服务器错误。它们描述的是**这一次 HTTP 交换**的结果，不是业务结果的全部：很多接口用 `200 OK` 加业务错误码返回“余额不足”，在 HTTP 层这是成功响应，缓存、监控和自动重试都看不出业务失败。

**1xx：中间响应。** `100 Continue` 配合请求中的 `Expect: 100-continue`，让客户端在发送较大的请求体前先获得许可，服务器也可以直接回 `417` 拒绝或干脆不回 `100`（客户端应当有超时后继续发送的兜底）。`101 Switching Protocols` 用于协议升级。`103 Early Hints`（[RFC 8297](https://www.rfc-editor.org/rfc/rfc8297.html)，Experimental）可以让服务器在最终响应之前先发送 `Link` 头，浏览器据此提前预加载资源。

**2xx：成功。** `200 OK` 是通用成功；`201 Created` 表示创建了新资源，通常带 `Location`；`202 Accepted` 表示请求已接受但尚未处理完成（异步任务的典型返回）；`204 No Content` 表示成功且没有内容；`206 Partial Content` 表示返回的是范围请求的一部分。

**3xx：重定向。** 这组状态码的差别集中在“方法要不要保留”上（RFC 9110 第 15.4 节）：

- `301 Moved Permanently`：永久重定向。规范注明“出于历史原因，用户代理可以把后续请求的方法从 POST 改为 GET”；不想要这个行为时应使用 `308`。
- `302 Found`：临时重定向；与 301 一样，规范允许用户代理出于历史原因把 POST 改为 GET，不想要时应使用 `307`。
- `303 See Other`：明确要求用检索请求（GET 或 HEAD）访问 `Location` 指向的资源，常用于“POST 提交后重定向到结果页”。
- `307 Temporary Redirect`：临时重定向，且用户代理**不得**改变请求方法。
- `308 Permanent Redirect`：永久重定向，同样不得改变方法。
- `304 Not Modified`：条件请求命中，服务器告诉客户端“你手上那份仍然有效”，响应不含内容。

重定向的缓存行为容易踩坑：RFC 9110 把 `200`、`203`、`204`、`206`、`300`、`301`、`308`、`404`、`405`、`410`、`414`、`501` 定义为可启发式缓存（heuristically cacheable），`302` 与 `307` 不在其中。也就是说“没写 Cache-Control 的永久重定向”也可能被缓存很久，排查“改了域名仍跳旧地址”时要先看这里。`305` 已废弃，`306` 保留未使用。

状态行的原因短语（reason phrase，如 `OK`）只是建议值，可以被替换甚至省略，不影响协议；HTTP/2 与 HTTP/3 只承载三位数字的状态码（HTTP/2 中由 `:status` 携带），连放原因短语的位置都没有。

**4xx：客户端错误。** 按排错方向记住它们比背列表有效：`400` 报文/语法有问题；`401` 缺少或无效的认证凭据，必须带 `WWW-Authenticate`；`403` 服务器理解了请求但拒绝执行，原因可能是权限策略、资源策略或其他访问限制，并不等于凭据一定有效；`404` 没有当前表示；`405` 方法不被允许，必须带 `Allow`；`406` 无法满足 `Accept` 协商；`408` 请求超时；`409` 与当前资源状态冲突（如并发编辑）；`410` 曾经存在且已永久移除；`412` 前置条件失败；`413` 内容过大；`415` 媒体类型不支持；`416` 范围不合法；`421` 请求被错误地路由（HTTP/2 连接合并场景）；`425` 过早的早期数据（TLS 0-RTT 重放风险）；`428` 要求前置条件；`429` 触发限流，通常带 `Retry-After`；`431` 字段过大；`451` 因法律原因不可用。

**5xx：服务器错误。** `500` 应用内部错误；`501` 方法未实现；`502` 作为网关时上游返回了无效响应；`503` 暂时不可用（通常带 `Retry-After`）；`504` 等待上游超时；`505` 不支持的 HTTP 版本；`511` 需要网络认证。

> **关键认知：** `304` 不是错误、也不含内容；它是缓存验证成功的结果。`401` 明确要求客户端通过 `WWW-Authenticate` 重新提供或更换凭据；`403` 只表示服务器拒绝执行，不承诺换凭据后一定会成功。

> **面试高频：** 301、302、303、307、308 有什么区别？401 和 403 怎么选？
> **答题脉络：** 重定向先分永久/临时，再分方法是否保留（303 强制改 GET，307/308 禁止改） → 401 表示凭据缺失或无效、必须回 `WWW-Authenticate`，403 表示服务器理解请求但拒绝执行，不必然说明凭据有效。
> **追问方向：** 重定向的启发式缓存、304 与 200 在缓存流程中的作用、429 与 `Retry-After`、502 和 504 分别指向哪一层。

## 字段、表示与内容协商

旧教材把字段分成“通用/请求/响应/实体”四类，现行规范不再这样组织。更好的记法是按“这个字段改变谁的决策”分组：

- **目标与主机**：`Host`（HTTP/1.1 必需）、`:authority`（HTTP/2/3 伪字段）。
- **表示元数据**：`Content-Type`、`Content-Length`、`Content-Encoding`、`Content-Language`、`Content-Location`、`Last-Modified`。
- **内容协商**：`Accept`、`Accept-Encoding`、`Accept-Language`、`Vary`。
- **条件与范围**：`ETag`、`If-Match`、`If-None-Match`、`If-Modified-Since`、`If-Unmodified-Since`、`If-Range`、`Range`、`Accept-Ranges`、`Content-Range`。
- **缓存与新鲜度**：`Cache-Control`、`Expires`、`Age`、`Date`。
- **重定向与重试**：`Location`、`Retry-After`。
- **认证**：`Authorization`、`WWW-Authenticate`、`Proxy-Authorization`、`Proxy-Authenticate`。
- **请求上下文与协议控制**：`Referer`、`User-Agent`、`Origin`、`Expect`、`TE`、`Trailer`、`Connection`。

`Content-Encoding` 和 `Transfer-Encoding` 经常被混为一谈，它们解决的是不同问题：前者描述**表示被压缩过**（`gzip`、`br`、`zstd`），接收方要先解码才能得到表示；后者描述**消息如何定界**（HTTP/1.1 的 `chunked`），是逐跳的传输细节。HTTP/3 明确不允许 `Transfer-Encoding` 字段——QUIC 流本身已经提供了定界。

`Cookie` 与 `Set-Cookie` 也是普通字段，但它们承载的是会话凭证，本篇只在缓存边界处点名：完整机制、属性与安全边界见[身份认证：Cookie、Session 与 JWT](./09-身份认证：Cookie、Session与JWT.md)。

**内容协商**决定服务器返回哪一种表示。主动协商由客户端用 `Accept*` 字段声明偏好，服务器挑选并在响应里用 `Vary` 记录“选了哪些维度”。`Vary` 直接参与缓存键计算：`Vary: Accept-Language` 意味着缓存必须按语言分别存储；`Vary: *` 则永远无法匹配，等于禁止复用。最常见的线上事故就是协商了语言或编码却忘了 `Vary`，导致英语用户拿到缓存中的德语页面。协商失败时可以返回 `406`，或者用 `300 Multiple Choices` 让客户端自己挑。

> **关键认知：** `Vary` 是缓存键的一部分：服务器协商了哪些维度，就必须声明哪些维度；漏掉 `Vary` 比不做协商更容易造成事故，因为它会让缓存把一个用户的结果复用到另一个用户身上。

> **时效信息（核查日期：2026-09）：** IANA HTTP Content Coding Registry 除了常见的 `gzip`、`deflate`、`br`、`zstd`，还登记了 RFC 9842（Standards Track，2025-09）定义的字典压缩编码 `dcb`（Dictionary-Compressed Brotli）与 `dcz`（Dictionary-Compressed Zstandard）；`zstd` 的 `window` 大小在 HTTP 场景下由 [RFC 9659](https://www.rfc-editor.org/rfc/rfc9659.html) 收紧为强制要求。

> **历史机制（已废弃）：** `Warning` 字段已被 RFC 9111 废弃（其信息可以从 `Age` 等字段获知），`Pragma` 被标为 deprecated、只在兼容 HTTP/1.0 缓存时才有意义；`Content-MD5` 已被废弃（摘要需求改用 RFC 9530 定义的 `Content-Digest`/`Repr-Digest`）；`Proxy-Connection` 从来不是标准字段。[核查日期：2026-09]

> **面试高频：** 这么多字段要背吗？
> **答题脉络：** 不背列表，按决策分组：它影响缓存、协商、认证、定界还是重试 → 说明 `Vary` 参与缓存键、`Content-Encoding` 与 `Transfer-Encoding` 层次不同。
> **追问方向：** `Content-Length` 与 `chunked` 的取舍、`Vary` 漏发导致的问题、`Accept-Encoding` 与 CDN 压缩策略。

## 条件请求、范围请求与并发更新

条件请求把“要不要传内容”变成一次可判定的比较。客户端带上验证器，服务器比较后决定返回新表示（`200`）还是“没变”（`304`），写请求还可以用前置条件避免覆盖别人的修改（`412`）。RFC 9110 第 13.2.2 节规定了多个前置条件同时出现时的求值顺序：`If-Match` → `If-Unmodified-Since` → `If-None-Match` → `If-Modified-Since` → `If-Range`。

两种验证器的差别值得单独强调：

- **ETag**：服务器为选定的表示生成的不透明标识，客户端只负责原样回传。带 `W/` 前缀的是弱验证器，表示“语义等价但不保证字节相同”。`If-Match`、`If-Range` 使用强比较，`If-None-Match` 使用弱比较。
- **Last-Modified**：基于时间的验证器，天然精度有限；RFC 9110 第 8.8.2.2 节说明它默认是弱验证器，只有在服务器能确认“所覆盖的那一秒内表示没有变化两次”等条件成立时才能当作强验证器使用。

> **关键认知：** ETag 标识的是“某个资源在某个协商维度下的这份表示”，不是资源的全局唯一 ID。它必须和 `Vary` 描述的协商维度配合，否则同一 URL 的不同语言版本可能共用同一个 ETag。

**乐观并发**是写接口的常用模式：先 `GET` 拿到 `ETag`，修改时用 `If-Match` 带上它；如果这段时间里有别人改过，服务器返回 `412 Precondition Failed`，客户端重新读取后再提交。它的时序只有四步：

```text
客户端                              服务器
  │ -- GET /doc --------------------> │
  │ <-- 200 + ETag: "v7" ----------- | 本地保存验证器
  │ -- PUT /doc  If-Match: "v7" ---> | 只有当前版本仍是 v7 才接受
  │ <-- 200 + ETag: "v8" ----------- | 更新成功
  │ -- PUT /doc  If-Match: "v7" ---> | 别人已经写过，当前是 v8
  │ <-- 412 Precondition Failed ---- | 客户端重新读取后再提交
```

下面的实验用公开服务复现了最后一步：

```bash
# 1. 前置条件不匹配时，写请求被拒绝
curl -s -i -H 'If-Match: "wrong-etag"' "https://httpbin.org/etag/abc123" \
  | grep -Ei '^(HTTP/|content-length)'
```

```text
HTTP/1.1 412 PRECONDITION FAILED
Content-Length: 0
```

**范围请求**让客户端只取表示的一部分，用于断点续传与媒体拖动。`Range: bytes=0-9` 请求成功返回 `206 Partial Content`，响应里带 `Content-Range` 说明片段位置与表示的总长度；范围越界返回 `416 Range Not Satisfiable`。两个容易踩的边界：

- 服务器**可以忽略** `Range`，此时返回 `200` 和完整内容。这不是错误，客户端必须处理。
- 续传时若资源已被替换，拼接旧片段会得到损坏文件；`If-Range` 就是为了解决这个问题：验证器不匹配时服务器直接返回完整表示。

## HTTP 缓存是一套决策算法

缓存要解决的不是“永远不请求”，而是三个依次判断的问题：**这份响应能不能存？**、**手上的副本还能不能直接用？**、**不能直接用时是验证还是重新获取？** 这三个问题分别对应 RFC 9111 的存储条件、新鲜度计算与验证流程。之所以值得认真对待，是因为它同时决定三件事：重复传输的带宽成本、用户感知的延迟，以及断网或源站故障时的可用性。

```text
收到请求
   │
   ├─ ① 可存储吗？ 方法/状态码允许、无 no-store、
   │      私有缓存不看 private/Authorization，
   │      共享缓存还要求 private 不在场、请求无 Authorization ──✗──> 直接回源
   │
   ├─ ② 新鲜吗？ freshness_lifetime > current_age
   │      └─ 是 ──> 直接复用（无网络请求）
   │
   └─ ③ 不能直接复用：有验证器吗？
         ├─ 有 ──> 发条件请求，304 就继续用旧副本
         └─ 无 ──> 重新获取完整响应
```

**第一步：可存储性。** 缓存只有在方法被理解、状态码是最终响应、响应不含 `no-store` 等条件下才允许存储；若缓存是共享的（代理、CDN），还要求 `private` 不在场、请求没有 `Authorization`（除非响应带 `public`、`must-revalidate` 或 `s-maxage`），并且响应至少提供了显式新鲜度信息或属于“可启发式缓存”的状态码。这也解释了为什么带认证信息的接口默认不会被 CDN 缓存。

**第二步：新鲜度。** 计算 `freshness_lifetime` 时按顺序取第一个命中的来源：

1. 共享缓存且响应有 `s-maxage`：用它的值；
2. 有 `max-age`：用它的值；
3. 有 `Expires`：用 `Expires - Date`；
4. 都没有：可能适用启发式新鲜度。

当前年龄 `current_age` 由三部分组成：根据 `Date` 推算的 `apparent_age`、`Age` 字段加上请求在途时间得到的 `corrected_age_value`（两者取大者），再加上副本在本地驻留的时间。副本新鲜的条件就是 `freshness_lifetime > current_age`。

**第三步：不能复用时的动作。** 有验证器就发条件请求（`If-None-Match`/`If-Modified-Since`），拿到 `304` 就更新元数据继续用旧内容；没有验证器只能重新获取完整响应。`must-revalidate` 会在过期后禁止使用陈旧副本：缓存若与源站失联，应当返回 `504`，而不是继续用旧数据。

指令可以按“请求侧”和“响应侧”分开理解：

- **请求侧**：`max-age=N`（客户端只要年龄不超过 N 的副本）、`max-stale[=N]`（愿意接受过期副本）、`min-fresh=N`（还要新鲜至少 N 秒）、`no-cache`（不要直接用缓存，强制验证）、`only-if-cached`（只用缓存，不回源）、`no-store`。
- **响应侧**：`no-cache`（可以存储，但复用前必须验证，可带字段名参数）、`no-store`（不得存储）、`private`/`public`（限定私有或共享缓存，可带字段名参数）、`must-revalidate`/`proxy-revalidate`、`s-maxage`、`must-understand`、`immutable`、`stale-while-revalidate`/`stale-if-error`。

> **关键认知：** `no-cache` 与 `no-store` 是两件事：前者允许存储但每次复用前要验证，后者禁止存储；而“命中缓存就不访问网络”只在新鲜期内成立，过期后照样要发验证请求。

几种扩展指令的适用条件不同：`immutable`（RFC 8246）承诺“在新鲜期内表示不会变”，客户端在新鲜期内连用户主动刷新都可以跳过验证；`stale-while-revalidate` 与 `stale-if-error`（RFC 5861，Informational）允许过期后先返回旧内容、后台再验证或在上游出错时兜底，代价是可能返回陈旧数据，适合对可用性比对一致性更敏感的静态内容。它们都不是 RFC 9111 定义的核心指令，采用前要确认 CDN 或反向代理是否支持。

```dart
// 前置条件：Dart 3.x；纯 Dart；无第三方依赖；导入同目录 cache_entry.dart。
import 'cache_entry.dart';

int _atLeastZero(int value) => value < 0 ? 0 : value;

extension CachePolicy on CacheEntry {
  /// RFC 9111 第 4.2.1 节：按 s-maxage、max-age、Expires 取第一个命中的值。
  int freshnessLifetime({required bool shared}) {
    // 1. 只有共享缓存才看 s-maxage，它覆盖 max-age 与 Expires。
    final sharedMaxAgeValue = sharedMaxAge;
    if (shared && sharedMaxAgeValue != null) return sharedMaxAgeValue;
    // 2. max-age 是第二种显式来源。
    final maxAgeValue = maxAge;
    if (maxAgeValue != null) return maxAgeValue;
    // 3. Expires 减 Date 是第三种显式来源。
    final expiresValue = expires;
    if (expiresValue != null) return expiresValue - date;
    // 4. 没有显式过期时间才轮到启发式：这里取“最后修改至今的 10%”。
    final modified = lastModified;
    if (modified == null) return 0;
    return _atLeastZero(date - modified) ~/ 10;
  }

  /// RFC 9111 第 4.2.3 节：current_age = corrected_initial_age + resident_time。
  int currentAge(int now) {
    // 1. apparent_age 与 corrected_age_value 各算一份，取大者更保守。
    final apparentAge = _atLeastZero(responseTime - date);
    final correctedAgeValue = age + _atLeastZero(responseTime - requestTime);
    final correctedInitialAge = apparentAge > correctedAgeValue
        ? apparentAge
        : correctedAgeValue;
    // 2. 再加上副本驻留在本缓存里的时间。
    return correctedInitialAge + _atLeastZero(now - responseTime);
  }

  /// 两阶段决策：先判新鲜度，再决定复用、验证还是重新获取。
  CacheAction decide(int now, {required bool shared}) {
    // 1. no-store 的响应不该被存储；若手上仍有副本，只能重新获取。
    if (noStore) return CacheAction.fetchFull;
    // 2. 新鲜且没有 no-cache 时，才允许完全离线复用。
    final fresh = freshnessLifetime(shared: shared) > currentAge(now);
    if (fresh && !noCache) return CacheAction.reuseStored;
    // 3. 过期或必须验证时：有验证器就验证，否则完整重新获取。
    return hasValidator ? CacheAction.validate : CacheAction.fetchFull;
  }
}
```

<!-- verify: .work/verify/B13/lib/cache_policy.dart（CacheEntry 字段定义见同目录 cache_entry.dart） -->

验证脚本覆盖了几个关键边界：`s-maxage` 只对共享缓存生效并覆盖 `max-age`；`Expires` 要减去 `Date` 而不是减“现在”；`current_age` 取 `apparent_age` 与 `Age + 在途时间` 的较大者再加驻留时间；`no-cache` 在新鲜期内也必须验证；`max-age=0` 配 `Age: 1` 的效果接近 `no-cache`；`no-store` 或没有验证器的过期副本只能重新获取。

落到工程上，常见的配方是：HTML 文档配 `no-cache` + `ETag`（每次验证、未变不重传）；带内容指纹的静态资源配一年 `max-age` 加 `immutable`；含用户数据的接口配 `private, max-age=0, must-revalidate` 或直接 `no-store`。

> **面试高频：** `no-cache` 和 `no-store` 有什么区别？ETag 和 Last-Modified 该怎么选？
> **答题脉络：** 先用可存储性、新鲜度、验证三个阶段定位问题 → 说明 `no-cache` 允许存储但必须验证、`no-store` 禁止存储 → ETag 更精确、Last-Modified 精度低且默认弱验证器。
> **追问方向：** `max-age=0` 与 `no-cache` 的差别、`s-maxage` 与 `Authorization` 对共享缓存的影响、启发式新鲜度的 10% 是建议还是规定、CDN 缓存与浏览器缓存的配置差异。

## 连接、代理、网关、隧道与 CDN

`Connection` 字段不是“管理连接的开关”，它列出的是**只对当前这一跳有意义**的字段名，中间节点在转发前必须移除这些字段（RFC 9110 第 7.6.1 节）。典型逐跳字段包括 `Connection`、`Keep-Alive`、`TE`、`Transfer-Encoding`、`Upgrade` 以及非标准的 `Proxy-Connection`。其余字段是端到端的，代理必须原样传递。

按角色区分中间节点：

- **正向代理**：由客户端或其组织配置，代表客户端出网，可以缓存、审计、做访问控制。
- **反向代理**：位于服务端一侧，代表服务器接收请求，负责负载均衡、TLS 终止、压缩、缓存。
- **网关**：在转发时做协议转换，例如把 HTTP 请求转成后端的 gRPC 或自定义协议。
- **隧道**：用 `CONNECT` 建立一条透明转发通道，HTTPS 代理场景中代理只转发字节、看不到加密内容。

**虚拟主机**依赖两个阶段的信息：HTTP 层靠 `Host`（HTTP/2/3 中由 `:authority` 承担），TLS 层靠客户端发来的 SNI 扩展。二者不一致或缺失都会导致“证书正确但访问到别人的站点”，TLS 部分的细节见 [HTTPS 与 TLS](./08-HTTPS与TLS.md)。

**CDN** 是部署在网络边缘的共享缓存加反向代理：把副本放在离用户近的位置，用 DNS 或任播把用户导向最近的节点。它是否复用某个响应，完全由前面那套缓存算法决定；`Vary`、`Authorization`、`Cache-Control` 都是 CDN 的输入。响应中的 `Age`、`cf-cache-status`、`X-Cache` 等字段用于观察命中情况，其中除 `Age` 外都不是标准字段。

> **关键认知：** 代理不是透明管子。它按字段语义工作：逐跳字段会被移除或改写，`Authorization` 与 `Cookie` 会影响共享缓存能否存储，缓存键由 URL 加 `Vary` 指定的维度组成。

## HTTP/1.0 与 HTTP/1.1：从短连接到持久连接

HTTP 消息必须能确定“内容到哪里结束”。HTTP/1.1 有四种定界方式：状态码本身不含内容（如 `204`、`304`）、`Content-Length` 给出字节数、`chunked` 传输编码给出分块结构、以及关闭连接（HTTP/1.0 的兜底手段，代价是连接无法复用）。

`chunked` 让发送方在不知道总长度时也能流式传输：每个分块先给十六进制长度，长度为 0 的分块表示结束，之后可以带 trailer 字段。它解决的是**逐跳的定界问题**，因此解码后得到的表示与不压缩时完全相同。

两条容易被忽略的规则来自 RFC 9112 第 6 节：`Transfer-Encoding` 存在时会覆盖 `Content-Length`；同时收到两者应视为错误并关闭连接，因为这是请求走私（request smuggling）与响应拆分的经典素材。收到 HTTP/1.0 消息却带 `Transfer-Encoding` 时，也应把定界视为损坏。

持久连接方面，HTTP/1.1 默认复用连接，用 `Connection: close` 主动结束；HTTP/1.0 默认每次请求新连接，历史上靠 `Connection: keep-alive` 协商复用。**管线化（pipelining）**允许客户端不等响应就连续发送多个请求，规范仍允许（服务器必须按请求顺序返回响应），但现代浏览器默认不启用：代理兼容性差，且响应大小、RTT、带宽都会影响收益，正确实现很难（MDN 的说明见参考资料）。连接数同样没有规范规定值——RFC 9112 第 9.4 节明确不再规定上限，只要求客户端保守开连接。

```dart
// 前置条件：Dart 3.x；纯 Dart；无第三方依赖。
//
// HTTP/1.1 用 chunked 传输编码给大小未知的内容定界：每个分块先给出
// 十六进制长度，最后以长度为 0 的分块收尾，之后是可选的 trailer 字段。
// 报文按 Latin-1 读成字符串，一个字符对应一个字节，便于逐字节定位。

/// 解析结果：消息负载与 trailer 字段。
class ChunkedBody {
  ChunkedBody(this.content, this.trailers);

  final String content;
  final Map<String, String> trailers;
}

ChunkedBody decodeChunkedBody(String raw) {
  var index = 0;
  final buffer = StringBuffer();
  final trailers = <String, String>{};

  String readLine() {
    final end = raw.indexOf('\r\n', index);
    if (end < 0) throw const FormatException('缺少 CRLF 行尾');
    final line = raw.substring(index, end);
    index = end + 2;
    return line;
  }

  while (true) {
    // 1. 分块长度以十六进制写在行首，分号之后是可选的分块扩展。
    final size = int.tryParse(readLine().split(';').first, radix: 16);
    if (size == null || size < 0) throw const FormatException('非法的分块长度');

    // 2. 长度为 0 的分块表示内容结束。
    if (size == 0) break;

    // 3. 数据区长度由 chunk-size 决定，不能按“下一行”推断。
    if (index + size + 2 > raw.length) throw const FormatException('分块数据不足');
    buffer.write(raw.substring(index, index + size));
    index += size + 2;
  }

  // 4. 收尾之后是可选的 trailer 字段，以空行结束。
  while (true) {
    final line = readLine();
    if (line.isEmpty) break;
    final separator = line.indexOf(':');
    if (separator <= 0) continue;
    trailers[line.substring(0, separator)] = line
        .substring(separator + 1)
        .trim();
  }
  return ChunkedBody(buffer.toString(), trailers);
}
```

<!-- verify: .work/verify/B13/lib/chunked_framing.dart -->

验证脚本构造了两分块加 trailer 的消息、带分块扩展的消息，以及数据区里包含 `CRLF` 的分块：只有按 `chunk-size` 读取字节、而不是按“下一行”切分，才能正确还原内容；长度行非法时直接抛出 `FormatException`，而不是猜一个长度继续读——这也是解析 HTTP/1.1 报文时安全上的默认姿态。

> **关键认知：** HTTP/1.1 的消息边界来自四种定界方式，而不是“关闭连接”这一种兜底；`chunked` 只解决逐跳的定界问题，不改变表示的字节内容。

> **面试高频：** HTTP/1.1 的队头阻塞是什么？持久连接和管线化解决了吗？
> **答题脉络：** 应用层队头阻塞来自“响应必须按请求顺序返回” → 持久连接减少建连开销但不改顺序 → 管线化允许连续发送但实现与代理兼容性问题大，浏览器默认关闭 → 最终靠多连接和 HTTP/2 多路复用缓解。
> **追问方向：** `chunked` 与 `Content-Length` 的取舍、请求走私的成因、为什么现代客户端还要保持少量并发连接。

## HTTP/2：帧、流、HPACK 与 TCP 队头阻塞

HTTP/2 用二进制分帧把一条连接拆成多个**流（stream）**：每个请求-响应对占用一个流，消息被拆成 HEADERS 帧与 DATA 帧，不同流的帧可以交错发送，接收端按流 ID 重组。这使应用层的“一个请求阻塞后面所有请求”消失，一条 TCP 连接即可并行处理多个资源。

它同时删掉了 HTTP/1.1 里那些与连接绑定的概念：`Connection`、`Keep-Alive`、`Transfer-Encoding`、`Upgrade`、`Proxy-Connection` 等逐跳字段在 HTTP/2 中不允许出现，出现即视为消息格式错误（RFC 9113 第 8.2.2 节）。主机信息改由 `:authority` 伪字段承载，且不允许与 `Host` 冲突。

头部压缩用 **HPACK**（[RFC 7541](https://www.rfc-editor.org/rfc/rfc7541.html)）：静态表加动态表，再叠加 Huffman 编码。动态表让重复字段只需引用索引，但有一个副作用——它依赖双方的隐式状态，因此解压必须按顺序进行。

流控仍然是必须的：HTTP/2 定义了流级与连接级窗口，接收方通过 `WINDOW_UPDATE` 允许发送方继续发送。并发流数量由 `SETTINGS_MAX_CONCURRENT_STREAMS` 等设置协商。

优先级的历史变化值得记住：RFC 7540 的依赖树优先级方案**在 RFC 9113 中被弃用**，因为实现与部署配合度差；替代方案是 RFC 9218 定义的 `Priority` 字段（客户端表达偏好，服务器仍可自行决策）。

> **时效信息（核查日期：2026-09）：** 服务器推送（server push）在 RFC 9113 第 8.4 节中仍被定义，但主流浏览器已不再支持：Chrome 从 106 起默认禁用（Chromium 于 2022-08 发布移除公告），Firefox 从 132 起禁用（Mozilla Bug 1915848）；据 Mozilla 在移除讨论中的测试记录，Safari 当前版本也会拒绝推送流。Chrome 同时明确不支持 HTTP/3 上的 push。替代做法是 `rel=preload` 与 `103 Early Hints`。判断一个“协议特性”能否使用，必须把“规范是否定义”和“客户端是否实现”分开看。

> **关键认知：** HTTP/2 消灭的是应用层队头阻塞，不是传输层队头阻塞：所有流共享同一条 TCP 连接，一旦发生丢包，TCP 的重传会让所有流一起等待。

## HTTP/3：HTTP 语义如何映射到 QUIC

HTTP/3（RFC 9114）把承载换成 QUIC。QUIC 在 UDP 之上重新实现了可靠传输、每流流控、连接迁移与加密，并把 TLS 1.3 握手合并进连接建立（传输机制与握手细节见[传输层：UDP、TCP 与 QUIC](./04-传输层：UDP、TCP与QUIC.md)）。因此 HTTP/3 的映射非常直接：

- 一个请求-响应对占用一条 QUIC 双向流，消息由 HEADERS 帧与 DATA 帧组成；
- 字段压缩换成 **QPACK**（RFC 9204）。HPACK 依赖有序传输，而 QUIC 的流可以乱序到达，QPACK 因此把动态表的更新放在独立的单向流上，让编码方在“压缩率”与“队头阻塞”之间自行权衡；
- `Transfer-Encoding` 不允许出现，定界由 QUIC 流提供；`TE` 若出现也只能表示 `trailers`，不能用来请求 `chunked`；
- 控制流承载连接级设置与取消信息。

把三代版本放在同一维度对比，差别集中在“怎么运”：

| 对比点 | HTTP/1.1（RFC 9112） | HTTP/2（RFC 9113） | HTTP/3（RFC 9114） |
|---|---|---|---|
| 承载 | TCP | TCP | QUIC（基于 UDP） |
| 消息形式 | 文本起始行 + 字段区 | 二进制帧 | 二进制帧 |
| 并行方式 | 按序应答，靠多条连接 | 单连接多路复用 | 单连接多路复用 |
| 队头阻塞 | 应用层 + TCP 层 | 仅 TCP 层 | 各流独立，基本消除 |
| 加密握手 | 独立 TLS 握手 | 独立 TLS 握手 | 与 QUIC 握手合并 |

（TLS 1.3 与 0-RTT 早期数据的重放风险见 [HTTPS 与 TLS](./08-HTTPS与TLS.md)。）

版本发现与协商也变了：服务器可以通过 `Alt-Svc` 响应头（RFC 7838）或 DNS 的 HTTPS/SVCB 记录（RFC 9460）宣告 HTTP/3 端点，客户端先访问该端点、失败再回退 TCP。UDP 被运营商或防火墙阻断时，回退是正常路径而不是错误。

```text
客户端                    服务器
  │ --- QUIC 握手（含 TLS 1.3）--> │  一个往返即可发送请求
  │ --- HEADERS (流 0) ----------> │  :method :path :authority + 字段
  │ --- DATA (流 0) -------------> │  请求内容（如有）
  │ <-- HEADERS + DATA (流 0) ---- │  响应
```

> **时效信息（核查日期：2026-09）：** 两个独立来源的 2025 年度统计都表明三代 HTTP 长期并存——Cloudflare Radar 的年终统计（2025-12-15 发布）显示全球发往 Cloudflare 的请求中约 50% 走 HTTP/2、29% 走 HTTP/1.x、21% 走 HTTP/3；HTTP Archive 的 Web Almanac 2025 CDN 章节（2026-01-15）在其抽样中看到 CDN 服务的移动端 HTML 请求有 29% 使用 HTTP/3，而源站不足 7%。两组数字的采样口径不同，不能直接相加或互相换算。

> **关键认知：** HTTP/3 只替换承载：方法、状态码、字段和缓存规则完全不变；它也不能消除同一条流内部的排队，只能让丢包不再阻塞其它流。

> **面试高频：** HTTP/1.1、HTTP/2、HTTP/3 的区别怎么答？
> **答题脉络：** 共性先行（同一套语义，只换编码与传输） → HTTP/1.1 文本、按序应答、靠多连接 → HTTP/2 二进制分帧、单连接多路复用、HPACK，但受 TCP 丢包影响 → HTTP/3 基于 QUIC、QPACK、握手与连接建立合并。
> **追问方向：** server push 为什么被判死刑、HPACK 动态表为什么不能直接搬到 QUIC 上、QUIC 为什么基于 UDP 以及 0-RTT 的重放风险（`425`）、UDP 被封锁时的回退与部署比例口径。

## 浏览器边界：同源策略与 CORS

同源策略限制的是**文档脚本能读取哪些响应**：源由协议、主机、端口三元组决定。跨源请求可以被浏览器发出，但脚本默认拿不到响应内容——除非服务器通过 CORS 明确授权读取。

CORS 的判定分两类（WHATWG Fetch Standard 的术语是“简单方法”“CORS 安全列表请求头”，MDN 的教学说明更直观）：

- **不需要预检**：方法是 `GET`、`HEAD`、`POST`，且请求头都在安全列表内（`Accept`、`Accept-Language`、`Content-Language`、`Content-Type` 等），`Content-Type` 还限于 `application/x-www-form-urlencoded`、`multipart/form-data`、`text/plain` 三种。
- **需要预检**：方法或请求头超出上述范围（例如 `PUT`、带 `Authorization`、`Content-Type: application/json`）。浏览器先发 `OPTIONS`，用 `Access-Control-Request-Method`、`Access-Control-Request-Headers` 询问，服务器用 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods`、`Access-Control-Allow-Headers` 回答，通过的预检结果会被缓存一段时间（`Access-Control-Max-Age`，MDN 记录默认 5 秒，且各浏览器有自己的上限）。

携带凭据时有一条硬规则：`Access-Control-Allow-Origin: *` 不能与凭据同时使用，服务器必须回显具体源并配合 `Access-Control-Allow-Credentials: true`。确需让脚本读取额外的响应头时，用 `Access-Control-Expose-Headers` 声明——默认只有少数几个“安全列表”响应头可读。

下面用 curl 模拟一次预检（curl 自己不受 CORS 限制，所以它能直接看到服务器的回答，过长字段值在展示时用 `...` 截断）：

```bash
# 1. 模拟浏览器预检：声明来源、方法与请求头
curl -s -i -X OPTIONS \
  -H "Origin: https://example.org" \
  -H "Access-Control-Request-Method: DELETE" \
  -H "Access-Control-Request-Headers: authorization" \
  "https://api.github.com/zen" | grep -Ei '^(HTTP/|access-control|vary)'
```

```text
HTTP/1.1 204 No Content
access-control-max-age: 86400
access-control-allow-headers: Authorization, Content-Type, If-Match, ...
access-control-allow-methods: GET, POST, PATCH, PUT, DELETE
Access-Control-Allow-Origin: *
Vary: Accept-Encoding, Accept, X-Requested-With
```

服务器用 `204` 配合 `Access-Control-Allow-*` 声明“这个来源可以用这些方法和请求头访问”；`access-control-max-age: 86400` 告诉浏览器预检结果可以缓存一天，`Vary` 则提醒中间缓存不能把这份响应与其它请求混用。如果响应按请求来源动态回显 `Access-Control-Allow-Origin`，共享缓存还必须带 `Vary: Origin`，否则一个来源的授权结果会被错误地复用给另一个来源。

> **关键认知：** CORS 是浏览器执行的读取授权检查，不是服务端认证或授权机制：curl、移动 App 和服务器之间的调用不受它约束，接口自身的鉴权与越权防护仍然必须做。

> **面试高频：** 为什么 curl 请求成功，浏览器却报 CORS 错误？
> **答题脉络：** 先区分“请求是否发出”和“脚本能否读取” → 跨源响应缺少 `Access-Control-Allow-Origin` 时浏览器丢弃响应 → 复杂请求还会先被预检拦截。
> **追问方向：** 预检为什么不能只用 `*` 配凭据、`Vary: Origin` 的必要性、CORS 与 CSRF 的差别（攻击与防护见[常见应用攻击与防护](../06-安全基础/01-常见应用攻击与防护.md)）。

## 用 curl 构造可复现的 HTTP 实验

以下命令在 curl 8.17.0（Windows，2025-11-05 发布）上于 2026-09-21 GMT 执行。为了让输出只包含教学点，每个命令都用 `grep` 过滤字段名；命令中的 URL 一律加引号，避免 shell 对 `?`、`&` 的解析。

**实验一：看一次交换，并识别共享缓存的痕迹。**

```bash
# 1. -i 显示响应头；Age 与 cf-cache-status 是判断缓存命中的入口
curl -s -i "https://example.com/" \
  | grep -Ei '^(HTTP/|content-type|transfer-encoding|age|cf-cache-status)'
```

```text
HTTP/1.1 200 OK
Content-Type: text/html
Transfer-Encoding: chunked
Age: 3
cf-cache-status: HIT
```

`chunked` 说明响应没有预先给出总长度；`Age` 是这份副本已经历的秒数（会随抓取时刻变化，本文首次抓取时是 `11255`）；`cf-cache-status: HIT` 是 CDN 的诊断字段，说明它来自共享缓存。

**实验二：`-I` 发的是 HEAD，不是“GET 再丢掉内容”。**

```bash
# 2. -w 打印实际使用的方法，可以验证 -I 等价于 -X HEAD
curl -s -o /dev/null -w '%{method}\n' -I "https://example.com/"
```

```text
HEAD
```

用同样的思路观察字段：

```bash
# 3. HEAD 的响应头与 GET 基本一致，但没有内容
curl -s -I "https://example.com/" | grep -Ei '^(HTTP/|content-type|connection)'
```

```text
HTTP/1.1 200 OK
Content-Type: text/html
Connection: keep-alive
```

`HEAD` 适合检查资源是否存在、验证器是否变化；但服务器可以省略那些“只有在生成内容时才能确定”的字段，所以不能用 `HEAD` 的结果当作 GET 的严格等价物。

**实验三：条件请求与 `304`。**

```bash
# 4. 用响应中的 Last-Modified 验证本地副本是否仍然有效
curl -s -i -H 'If-Modified-Since: Tue, 15 Sep 2026 23:41:26 GMT' \
  "https://example.com/" \
  | grep -Ei '^(HTTP/|date|age|etag|last-modified)'
```

```text
HTTP/1.1 304 Not Modified
Date: Mon, 21 Sep 2026 17:03:15 GMT
Age: 11527
last-modified: Tue, 15 Sep 2026 23:41:26 GMT
etag: "6aa9d7a6-22f"
```

`304` 没有响应体，只刷新验证器与新鲜度信息：本例中它甚至带回了先前 `200` 响应里没出现的 `etag`。把条件换成 `If-None-Match: "6aa9d7a6-22f"` 会得到同样的结果，这也是缓存实现需要容忍“验证器不一定每次齐全”的原因。

**实验四：范围请求成功时的形状。**

```bash
# 5. 只要前 10 个字节，成功时返回 206 与 Content-Range
curl -s -i -H "Range: bytes=0-9" \
  "https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js" \
  | grep -Ei '^(HTTP/|content-type|content-length|accept-ranges|content-range)'
```

```text
HTTP/1.1 206 Partial Content
Content-Length: 10
Content-Type: application/javascript; charset=utf-8
Accept-Ranges: bytes
Content-Range: bytes 0-9/87533
```

**实验五：同一个 `Range` 也可能被忽略。**

```bash
# 6. 换成 CDN 上的文档：Range 被忽略，返回 200 加完整内容
curl -s -i -H "Range: bytes=0-9" \
  "https://www.rfc-editor.org/rfc/rfc9110.txt" \
  | grep -Ei '^(HTTP/|transfer-encoding|cache-control)'
```

```text
HTTP/1.1 200 OK
Transfer-Encoding: chunked
Cache-Control: public, max-age=86400
```

两个实验对照起来看才是完整的机制：服务器（或中间缓存）有权忽略 `Range`。客户端必须把“忽略”当作正常分支，用完整响应重新开始，而不是报错或拼接旧片段。

**实验六：重定向与它的可缓存性。** 并发更新与 `412` 的实验见上一节，这里换一个日常更常见的返回码：

```bash
# 7. 不带 Cache-Control 的永久重定向：它属于可启发式缓存的状态码
curl -s -i "http://www.rfc-editor.org/rfc/rfc9110.txt" \
  | grep -Ei '^(HTTP/|location|cache-control)'
```

```text
HTTP/1.1 301 Moved Permanently
Location: https://www.rfc-editor.org/rfc/rfc9110.txt
```

这个响应里没有任何缓存字段，但 `301` 是 RFC 9110 定义为可启发式缓存的状态码，所以它很可能被浏览器或中间缓存长期使用。把 HTTP 改到 HTTPS 时，如果客户端仍能命中旧的 `301`，就需要清缓存或改用一个不同的入口域名，而不是反复检查源站配置。

**关于公开演示服务。** `httpbin.org` 等公开服务可能限流或返回 `502`；涉及写方法和前置条件的实验失败时应重试，或在本地起一个可控的服务验证。

**观察版本与 HTTP/3 广告。** `curl -w '%{http_version}\n'` 打印本次使用的 HTTP 版本（本次环境中输出 `1.1`），响应里的 `alt-svc: h3=":443"; ma=86400` 是服务器宣告“同一个主机在 443 端口也提供 HTTP/3”的方式，可以用 `grep -i '^alt-svc'` 单独观察。但 `--http2`、`--http3` 需要 curl 构建时包含对应库：本次验证所用的 curl 8.17.0 未编译 HTTP/2/HTTP/3 支持，执行 `--http2` 会直接报 “the installed libcurl version does not support this”，因此本文不给这两个开关的示例输出。需要时的顺序是：先 `curl --version` 看特性列表，再决定是否使用。

> **关键认知：** 命令行工具能观察字段与状态码，但它不做内容协商之外的浏览器行为：不执行 JavaScript、不受同源策略约束、也不会实现 HTTP 缓存。用 curl 的结果推断浏览器行为，是排错时最常见的误判来源。

## 常见误区

- **“GET 有 URL 长度上限。”** 规范没有定义上限，长度限制来自浏览器、服务器与中间节点的实现配置；排查时应看具体组件的日志与配置，而不是引协议。
- **“POST 参数在请求体里，所以更安全。”** 位置不提供任何保护，只有 HTTPS 才保护传输过程；POST 反而更容易进入日志与错误上报，敏感数据要额外约束。
- **“`no-cache` 表示完全不缓存。”** 它允许存储，只是复用前必须先向源站验证；完全禁止存储的是 `no-store`。
- **“`304` 是错误或失败。”** 它是条件请求命中、可以继续使用本地副本的结果，不含响应体，但会带回新的验证器与新鲜度信息。
- **“幂等就是每次响应完全一样。”** 幂等描述对服务器的预期效果；`DELETE` 第二次返回 `404` 仍幂等，只是“这次没有可删的对象”。
- **“HTTP/2 已经取代 HTTP/1.1，HTTP/3 也会取代前两代。”** 三代版本长期并存、按连接协商，淘汰旧版本的动因通常来自安全与实现成本，而不是语义冲突。
- **“协议里定义的特性，客户端一定支持。”** server push 就是反例：RFC 9113/9114 仍定义它，主流浏览器已经禁用或移除。
- **“CORS 是服务端安全机制。”** 它是浏览器执行的读取限制，不保护 curl 和原生客户端，因此服务端鉴权与越权校验不能省。

## 参考资料

- [R1] [RFC] [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) — IETF，STD 97，[核查日期：2026-09]。
- [R2] [RFC] [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html) — IETF，STD 98，[核查日期：2026-09]。
- [R3] [RFC] [RFC 9112: HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112.html) — IETF，STD 99，[核查日期：2026-09]。
- [R4] [RFC] [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html) — IETF，[核查日期：2026-09]。
- [R5] [RFC] [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114.html) — IETF，[核查日期：2026-09]。
- [R6] [RFC] [RFC 9204: QPACK: Field Compression for HTTP/3](https://www.rfc-editor.org/rfc/rfc9204.html) — IETF，[核查日期：2026-09]。
- [R7] [RFC] [RFC 5789: PATCH Method for HTTP](https://www.rfc-editor.org/rfc/rfc5789.html) — IETF，[核查日期：2026-09]。
- [R8] [RFC] [RFC 10008: The QUERY Method](https://www.rfc-editor.org/rfc/rfc10008.html) — IETF，Standards Track，2026-06，[核查日期：2026-09]。
- [R9] [RFC] [RFC 5861: HTTP Cache-Control Extensions for Stale Content](https://www.rfc-editor.org/rfc/rfc5861.html) — IETF，Informational，[核查日期：2026-09]。
- [R10] [RFC] [RFC 8246: HTTP Immutable Responses](https://www.rfc-editor.org/rfc/rfc8246.html) — IETF，Standards Track，[核查日期：2026-09]。
- [R11] [RFC] [RFC 9218: Extensible Prioritization Scheme for HTTP](https://www.rfc-editor.org/rfc/rfc9218.html) — IETF，Standards Track，[核查日期：2026-09]。
- [R12] [RFC] [RFC 7838: HTTP Alternative Services](https://www.rfc-editor.org/rfc/rfc7838.html) — IETF，[核查日期：2026-09]。
- [R13] [RFC] [RFC 9460: Service Binding and Parameter Specification via the DNS](https://www.rfc-editor.org/rfc/rfc9460.html) — IETF，[核查日期：2026-09]。
- [R14] [RFC] [RFC 9842: Compression Dictionary Transport](https://www.rfc-editor.org/rfc/rfc9842.html) — IETF，Standards Track，2025-09，[核查日期：2026-09]。
- [R15] [标准] [IANA HTTP Method Registry](https://www.iana.org/assignments/http-methods/http-methods.xhtml) — IANA，方法的安全与幂等属性以该表为准，[核查日期：2026-09]。
- [R16] [标准] [IANA HTTP Field Name Registry](https://www.iana.org/assignments/http-fields/http-fields.xhtml) — IANA，字段状态（permanent/deprecated/obsoleted）以该表为准，[核查日期：2026-09]。
- [R17] [标准] [WHATWG Fetch Living Standard](https://fetch.spec.whatwg.org/) — WHATWG，CORS 与预检算法的现行定义，[核查日期：2026-09]。
- [R18] [官方文档] [MDN: Cross-Origin Resource Sharing (CORS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) — MDN，[核查日期：2026-09]。
- [R19] [官方文档] [MDN: Connection management in HTTP/1.x](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x) — MDN，管线化默认行为的说明，[核查日期：2026-09]。
- [R20] [官方文档] [Chrome for Developers: Remove HTTP/2 Server Push from Chrome](https://developer.chrome.com/blog/removing-push) — Chromium，2022-08-18，[核查日期：2026-09]。
- [R21] [官方文档] [Mozilla Bug 1915848: Pref off HTTP/2 push](https://bugzilla.mozilla.org/show_bug.cgi?id=1915848) — Mozilla，Firefox 132 起禁用推送，[核查日期：2026-09]。
- [R22] [官方文档] [Cloudflare Radar 2025 Year in Review](https://blog.cloudflare.com/radar-2025-year-in-review/) — Cloudflare，2025-12-15，HTTP 版本请求占比，[核查日期：2026-09]。
- [R23] [官方文档] [Web Almanac 2025: CDN](https://almanac.httparchive.org/en/2025/cdn) — HTTP Archive，2026-01-15，按 CDN/源站划分的 HTTP/3 采用率，[核查日期：2026-09]。
- [R24] [RFC] [RFC 7541: HPACK: Header Compression for HTTP/2](https://www.rfc-editor.org/rfc/rfc7541.html) — IETF，[核查日期：2026-09]。
- [R25] [官方文档] [Mozilla: Intent to unship HTTP/2 Push](https://groups.google.com/a/mozilla.org/g/dev-platform/c/vU9hJg343U8) — Mozilla dev-platform 邮件列表，Firefox 禁用推送的动机与其它浏览器状态，[核查日期：2026-09]。

## 一句话总结

> HTTP 用统一的资源和表示语义描述“要做什么”，用状态码、字段与缓存算法决定“这次能不能复用或重传”，而 HTTP/1.1、HTTP/2、HTTP/3 只是承载同一套语义的三种不同运输方式。
