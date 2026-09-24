# 计算机网络

从手机发出一个 `GET /v1/articles` 到拿到响应，中间可能经过 Wi-Fi 上的帧、交换机的转发、DNS 解析、路由器逐跳转发、TCP 建连、TLS 握手和 HTTP 语义处理；失败时客户端往往只抛出同一个 `SocketException`，原因却可能停在任意一层。把网络学成一串协议名词，遇到真实问题时就没有抓手。

本板块先给一张分层地图，再自下而上逐层解释每层替上层承担了什么、边界在哪里，然后用一次完整请求的旅程把十篇文章串起来。主线按客户端视角组织，适用于移动端、命令行和通用网络程序；协议版本演进、安全与编程接口各自独立成篇，具体机制只在其唯一主文中展开。

<!-- GFM-TOC -->
* [这一板块解决什么问题](#这一板块解决什么问题)
* [学习路线：分层顺序](#学习路线分层顺序)
* [场景路线：按问题进入](#场景路线按问题进入)
* [内容索引](#内容索引)
* [完成标准](#完成标准)
* [面试高频入口](#面试高频入口)
* [参考资料](#参考资料)
<!-- GFM-TOC -->

## 这一板块解决什么问题

网络协议是一组针对“不可靠介质、异构网络和多方中间节点”的工程取舍，不是需要逐字背下来的文档。本板块回答四类问题：

1. 一次通信会经过哪些设备与网络，为什么采用分组交换和分层。
2. 每一层提供什么服务、不提供什么服务，字段与状态为何这样设计。
3. 一次 HTTPS 请求实际按什么顺序发生，缓存、连接复用与协议版本会让哪些步骤消失。
4. 出错时如何按层收集证据，而不是笼统重试。

## 学习路线：分层顺序

推荐按 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 推进，依赖关系如下：

1. [01-网络全景与分层](./01-网络全景与分层.md) 是地图：先建立设备、时延与封装的概念，后续每篇都挂在这张坐标系上。
2. [02-物理层与数据链路层](./02-物理层与数据链路层.md)、[03-网络层：IP、路由与地址解析](./03-网络层：IP、路由与地址解析.md)、[04-传输层：UDP、TCP与QUIC](./04-传输层：UDP、TCP与QUIC.md)、[05-应用层：DNS与基础协议](./05-应用层：DNS与基础协议.md) 自下而上补全协议栈，每篇只依赖前一篇的模型。
3. [06-一次网络请求的完整旅程](./06-一次网络请求的完整旅程.md) 是唯一的端到端叙事：读 01 后先浏览一遍建立坐标，读完协议后再回读；它不重复其他篇的机制细节。
4. [07-HTTP语义、缓存与版本演进](./07-HTTP语义、缓存与版本演进.md) 依赖 04：缓存与连接复用要落到传输层，HTTP/3 映射到 QUIC。
5. [08-HTTPS与TLS](./08-HTTPS与TLS.md) 依赖 04 与 07：TLS 跑在传输层字节流上，保护的是 HTTP 语义。
6. [09-身份认证：Cookie、Session与JWT](./09-身份认证：Cookie、Session与JWT.md) 依赖 07 与 08：认证状态复用 HTTP 字段，其安全性依赖传输保护。
7. [10-Socket与I-O模型](./10-Socket与I-O模型.md) 依赖 04：Socket 把 TCP 字节流暴露给应用；内核 I/O 路径见[操作系统板块的 I/O、存储与文件系统](../03-操作系统与程序运行/05-I-O、存储与文件系统.md)。

## 场景路线：按问题进入

- 请求很慢，想先知道慢在哪一段？入口：[把“慢”拆成可观测的时间段](./06-一次网络请求的完整旅程.md#把慢拆成可观测的时间段)。
- 首次请求慢、第二次明显变快？入口：[冷路径、暖路径与 HTTP/3](./06-一次网络请求的完整旅程.md#冷路径暖路径与-http3)。
- 改了 DNS 记录却不生效？入口：[记录、别名、TTL 与缓存](./05-应用层：DNS与基础协议.md#记录别名ttl-与缓存)。
- 抓包看到重传、TIME_WAIT 或反复握手？入口：[可靠传输：序号、累计确认、超时与选择确认](./04-传输层：UDP、TCP与QUIC.md#可靠传输序号累计确认超时与选择确认)、[终止连接、半关闭与 TIME_WAIT](./04-传输层：UDP、TCP与QUIC.md#终止连接半关闭与-time_wait)、[用抓包验证而不是背图](./04-传输层：UDP、TCP与QUIC.md#用抓包验证而不是背图)。
- 证书校验失败或版本不匹配？入口：[按错误信息定位 TLS 问题](./08-HTTPS与TLS.md#按错误信息定位-tls-问题)。
- 接口偶发半包、`EAGAIN` 或卡在等待？入口：[字节流没有消息边界](./10-Socket与I-O模型.md#字节流没有消息边界)、[部分读写、EAGAIN、超时与背压](./10-Socket与I-O模型.md#部分读写eagain超时与背压)。
- 登录态方案在 Cookie、Session 与 JWT 之间摇摆？入口：[Session：把状态留在服务端](./09-身份认证：Cookie、Session与JWT.md#session把状态留在服务端)、[无状态令牌的代价：撤销与续期](./09-身份认证：Cookie、Session与JWT.md#无状态令牌的代价撤销与续期)。

## 内容索引

| 文章 | 学完能回答什么 | 先修 |
|---|---|---|
| [01-网络全景与分层](./01-网络全景与分层.md) | 一次通信经过哪些设备与网络、为什么采用分组交换；带宽、吞吐量、时延与抖动如何区分；分层与封装各自解决什么，故障如何按层定位。 | 无 |
| [02-物理层与数据链路层](./02-物理层与数据链路层.md) | 信号如何变成比特、比特如何组成帧；以太网与 MAC 地址、交换机为何能即插即用；VLAN 与 MTU 在跨网交付中起什么作用。 | 01 |
| [03-网络层：IP、路由与地址解析](./03-网络层：IP、路由与地址解析.md) | IP 提供和不提供什么；子网前缀与路由表如何决定逐跳转发；ARP 与 NDP 解析谁的地址；NAT 与 VPN 改变了哪些语义。 | 02 |
| [04-传输层：UDP、TCP与QUIC](./04-传输层：UDP、TCP与QUIC.md) | 端口与四元组如何分用；三次握手与四次挥手各自确认什么；可靠传输、流量控制与拥塞控制的边界在哪；QUIC 在 UDP 之上重建了什么。 | 03 |
| [05-应用层：DNS与基础协议](./05-应用层：DNS与基础协议.md) | DNS 为什么必须分布式分层，递归与迭代如何分工；记录类型、TTL 与缓存如何协同；DHCP、邮件与 FTP/SSH 各解决什么问题；如何用 dig 观察而不是猜。 | 04 |
| [06-一次网络请求的完整旅程](./06-一次网络请求的完整旅程.md) | 从 URL 到响应各阶段发生什么、哪些阶段会被缓存或连接复用跳过；一次慢请求如何拆成可观测的时间段；不同错误信息分别停在哪一步。 | 01 |
| [07-HTTP语义、缓存与版本演进](./07-HTTP语义、缓存与版本演进.md) | 方法、状态码与字段的语义边界；缓存如何判断新鲜与验证；HTTP/1.1、HTTP/2、HTTP/3 各解决什么问题、代价是什么；同源策略与 CORS 的浏览器边界。 | 04 |
| [08-HTTPS与TLS](./08-HTTPS与TLS.md) | TLS 组合了哪些密码学工具；证书链与信任从哪里开始、客户端验证哪些条件；TLS 1.3 与会话恢复、0-RTT 的收益和风险；出现报错如何定位。 | 04、07 |
| [09-身份认证：Cookie、Session与JWT](./09-身份认证：Cookie、Session与JWT.md) | 认证、授权与会话的区别；Cookie 与 Session 如何分工；JWT 的签名、校验与撤销边界；access token 与 refresh token 如何配合。 | 07、08 |
| [10-Socket与I-O模型](./10-Socket与I-O模型.md) | Socket 抽象与连接的完整生命周期；字节流为什么没有消息边界、半包如何处理；阻塞、非阻塞、多路复用与异步如何选择；LT 与 ET 及平台替代方案。 | 04 |

## 完成标准

- 能画出一次 HTTPS 请求的冷路径与暖路径，并说明每一步可能被缓存或连接复用跳过。
- 能区分时延、带宽、吞吐量与抖动，并解释一次“慢请求”可能停在哪一层。
- 能对 TCP 与 UDP 与 QUIC、HTTP/1.1 与 HTTP/2 与 HTTP/3、Cookie 与 Session 与 JWT 三组选择给出带代价的说明。
- 能用 `dig`、`curl` 或抓包工具复现正文中的关键现象，而不是只背结论。

## 面试高频入口

**端到端与分层**

- 从输入 URL 到拿到响应发生了什么，哪些步骤可能被跳过？入口：[先给这次旅程划一条可复现的主线](./06-一次网络请求的完整旅程.md#先给这次旅程划一条可复现的主线)、[冷路径、暖路径与 HTTP/3](./06-一次网络请求的完整旅程.md#冷路径暖路径与-http3)。
- 带宽、吞吐量、时延和抖动怎么区分？入口：[先建立四个性能概念](./01-网络全景与分层.md#先建立四个性能概念)。
- 排障时如何按层定位？入口：[按层定位一次故障](./01-网络全景与分层.md#按层定位一次故障)。

**传输层**

- TCP 为什么需要三次握手？入口：[建立连接：三次握手确认了什么](./04-传输层：UDP、TCP与QUIC.md#建立连接三次握手确认了什么)。
- TIME_WAIT 和四次挥手解决什么问题？入口：[终止连接、半关闭与 TIME_WAIT](./04-传输层：UDP、TCP与QUIC.md#终止连接半关闭与-time_wait)。
- TCP 如何做到可靠传输？入口：[可靠传输：序号、累计确认、超时与选择确认](./04-传输层：UDP、TCP与QUIC.md#可靠传输序号累计确认超时与选择确认)。
- 流量控制与拥塞控制有什么区别？入口：[滑动窗口与流量控制](./04-传输层：UDP、TCP与QUIC.md#滑动窗口与流量控制)、[拥塞控制：不要把接收方慢与网络堵混为一谈](./04-传输层：UDP、TCP与QUIC.md#拥塞控制不要把接收方慢与网络堵混为一谈)。
- TCP、UDP 与 QUIC 怎么选，QUIC 解决了什么？入口：[TCP、UDP、QUIC 如何选择](./04-传输层：UDP、TCP与QUIC.md#tcpudpquic-如何选择)、[QUIC：在 UDP 之上重建现代传输](./04-传输层：UDP、TCP与QUIC.md#quic在-udp-之上重建现代传输)。

**网络层与链路层**

- IP 地址、子网前缀与路由表如何决定下一跳？入口：[从路由表到逐跳转发](./03-网络层：IP、路由与地址解析.md#从路由表到逐跳转发)。
- ARP 解析的是谁的 MAC 地址，IPv6 用什么替代？入口：[IPv4 ARP 与 IPv6 NDP](./03-网络层：IP、路由与地址解析.md#ipv4-arp-与-ipv6-ndp)。
- 交换机和路由器的分工是什么？入口：[交换机如何转发一帧](./02-物理层与数据链路层.md#交换机如何转发一帧)。

**应用层与安全**

- DNS 的递归查询与迭代查询如何分工？入口：[一次解析：存根、递归解析器与迭代](./05-应用层：DNS与基础协议.md#一次解析存根递归解析器与迭代)。
- DNS 为什么主要使用 UDP，什么时候切换到 TCP？入口：[DNS 的传输选择：UDP、TCP 与 EDNS](./05-应用层：DNS与基础协议.md#dns-的传输选择udptcp-与-edns)。
- HTTP 缓存如何判断新鲜与验证？入口：[HTTP 缓存是一套决策算法](./07-HTTP语义、缓存与版本演进.md#http-缓存是一套决策算法)。
- HTTP/2 与 HTTP/3 各解决了什么问题？入口：[HTTP/2：帧、流、HPACK 与 TCP 队头阻塞](./07-HTTP语义、缓存与版本演进.md#http2帧流hpack-与-tcp-队头阻塞)、[HTTP/3：HTTP 语义如何映射到 QUIC](./07-HTTP语义、缓存与版本演进.md#http3http-语义如何映射到-quic)。
- HTTPS 如何验证服务器身份，TLS 1.3 快在哪里？入口：[PKI 与证书链：信任从哪里开始](./08-HTTPS与TLS.md#pki-与证书链信任从哪里开始)、[TLS 1.3：更少往返、更少遗留算法](./08-HTTPS与TLS.md#tls-13更少往返更少遗留算法)。
- Cookie、Session 与 JWT 的边界是什么，JWT 能撤销吗？入口：[Cookie：浏览器替服务端携带的键值对](./09-身份认证：Cookie、Session与JWT.md#cookie浏览器替服务端携带的键值对)、[Session：把状态留在服务端](./09-身份认证：Cookie、Session与JWT.md#session把状态留在服务端)、[JWT：一个被签名的 JSON 载荷](./09-身份认证：Cookie、Session与JWT.md#jwt一个被签名的-json-载荷)、[无状态令牌的代价：撤销与续期](./09-身份认证：Cookie、Session与JWT.md#无状态令牌的代价撤销与续期)。

**编程接口**

- select、poll、epoll 与 I/O 多路复用在解决什么？入口：[I/O 多路复用：把等待集中到一个调用](./10-Socket与I-O模型.md#io-多路复用把等待集中到一个调用)。
- 阻塞与非阻塞、同步与异步怎么区分？入口：[同步、异步、就绪与完成：先把词用对](./10-Socket与I-O模型.md#同步异步就绪与完成先把词用对)。
- LT 与 ET 的区别是什么？入口：[LT 与 ET：通知策略，不是性能口号](./10-Socket与I-O模型.md#lt-与-et通知策略不是性能口号)。

## 参考资料

- Kurose J F, Ross K W. 计算机网络：自顶向下方法[M]. 机械工业出版社.
- 谢希仁. 计算机网络[M]. 电子工业出版社.
- Stevens W R. TCP/IP 详解 卷 1：协议[M]. 机械工业出版社.
- Stevens W R. UNIX 网络编程 卷 1：套接字联网 API[M]. 人民邮电出版社.
- [RFC] [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)、[RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)、[RFC 9112: HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112)、[RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)、[RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114) — IETF，[核查日期：2026-09]。
- [RFC] [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)、[RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000)、[RFC 9002: QUIC Loss Detection and Congestion Control](https://www.rfc-editor.org/rfc/rfc9002) — IETF，[核查日期：2026-09]。
- [RFC] [RFC 1034](https://www.rfc-editor.org/rfc/rfc1034)、[RFC 1035](https://www.rfc-editor.org/rfc/rfc1035)（DNS）、[RFC 2131](https://www.rfc-editor.org/rfc/rfc2131)（DHCP）、[RFC 8200](https://www.rfc-editor.org/rfc/rfc8200)（IPv6） — IETF，[核查日期：2026-09]。
- [RFC] [RFC 6265: HTTP State Management Mechanism](https://www.rfc-editor.org/rfc/rfc6265)、[RFC 7519: JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519)、[RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749) — IETF，[核查日期：2026-09]。
- [man-pages] [socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html)、[tcp(7)](https://man7.org/linux/man-pages/man7/tcp.7.html)、[ip(7)](https://man7.org/linux/man-pages/man7/ip.7.html) — Linux man-pages，[核查日期：2026-09]。
- [Wireshark User's Guide](https://www.wireshark.org/docs/) 与 [IANA Service Name and Transport Protocol Port Number Registry](https://www.iana.org/assignments/service-names-port-numbers/) — 观察工具与端口注册体系，[核查日期：2026-09]。
