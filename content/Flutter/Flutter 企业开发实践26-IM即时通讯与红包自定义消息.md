---
title: Flutter 企业开发实践26-IM即时通讯与红包自定义消息
date: 2026-08-22
tags: [Flutter, IM, 即时通讯, 自定义消息, 红包, 腾讯云 Chat, GetX, 分布式一致性, 架构, 面试]
---

# IM 即时通讯与红包自定义消息

> 普通聊天解决的是消息传递，红包解决的却是一个带资金状态的分布式交易。两者可以共用 IM 通道，但不能共用一套真值模型。本篇基于某 Flutter 混合项目的实现，拆解常规 IM、自定义消息以及发红包、领红包的完整链路。

---

## 一、先定义边界：IM 是通道，不是账本

这套实现的技术栈是 Flutter + GetX + Tencent Cloud Chat SDK 8.x，并基于本地化的 TUIKit 4.x 扩展交互。架构上分成三层：

```text
页面与业务层
├── 会话列表、聊天页、通讯录、群管理
└── 红包创建、开红包、领取详情
            │
IM 适配层
├── SDK 初始化、登录状态机、监听器生命周期
├── 普通消息与自定义消息的编解码
└── 未读数、好友申请、消息音效
            │
基础设施层
├── Tencent Cloud Chat：消息投递、离线、会话同步
└── 业务服务端：金额、库存、领取资格、资金流水
```

最重要的约束是：

- IM 消息只负责把“有一个红包”和“某人已领取”传递给会话成员。
- 红包是否存在、剩余份数、谁可以领、实际入账金额，一律以服务端为准。
- 客户端修改自定义消息，只是为了就地刷新 UI，不等于修改了账本。

如果把自定义消息当成红包的唯一数据源，用户可修改本地数据、重放请求或在多端制造冲突，最终会直接演变成资金安全问题。

## 二、IM 初始化与登录状态机

### 2.1 UserSig 必须由服务端签发

客户端只保存 `SDKAppID`，登录所需的 `UserSig` 由业务服务端生成。生成 UserSig 需要密钥，把密钥放进 App 等价于把任意身份的签发权交给攻击者。

登录链路是：

```text
用户通过业务资格校验
  → App 向业务服务端请求 UserSig
  → 初始化 IM SDK
  → login(userID, userSig)
  → 注册会话、好友、消息监听器
  → 拉取首次未读数和好友申请数
```

项目会在服务端短暂不可用时读取本地缓存的 UserSig，但它只是降级手段，不能替代过期检查。日志也不应输出完整 UserSig。

### 2.2 状态机比一个 `isLogin` 更可靠

实现中把登录拆成四个状态：

```dart
enum ImLoginStatus {
  normal,
  loggingIn,
  success,
  failed,
}
```

状态机要处理的不只是登录成功：

- 重复调用登录时，阻止并发请求。
- 同一用户已登录时，直接复用会话。
- 网络错误采用有上限的循环重试，而不是无限递归。
- UserSig 过期时清理缓存，重新向服务端申请。
- 被踢下线时结束业务会话，不应仅修改一个布尔值。

一个可测试的登录主干如下：

```dart
Future<void> login(String userId, String userSig) async {
  if (_state == ImLoginStatus.loggingIn) return;
  if (_state == ImLoginStatus.success && _userId == userId) return;
  if (!await _initializeSdk()) {
    _state = ImLoginStatus.failed;
    return;
  }

  _state = ImLoginStatus.loggingIn;
  const maxAttempts = 4;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    final result = await _core.login(userID: userId, userSig: userSig);
    if (result.code == 0) {
      _state = ImLoginStatus.success;
      await _replaceListeners();
      return;
    }
    if (_isUserSigError(result.code)) {
      _state = ImLoginStatus.normal;
      await _refreshUserSig();
      return;
    }
    if (attempt < maxAttempts - 1) {
      await Future<void>.delayed(const Duration(seconds: 5));
    }
  }

  _state = ImLoginStatus.failed;
}
```

这里有一个很容易忽略的错误：如果先把状态设为 `loggingIn`，失败后递归调用 `login()`，新一层会因“正在登录”直接返回。看似有重试计数，实际一次都没重试。有上限的 `for` 循环更清楚。

### 2.3 监听器必须按实例移除

IM SDK 和 TUIKit 都可能注册监听器。如果登录一次就新建一批监听器，但登出时既不保存引用又调用无参移除，会出现两类问题：

1. 重连后同一条消息回调多次，提示音重复播放。
2. 无参移除可能误伤 TUIKit 自己的监听器。

正确做法是保存应用自己创建的监听器，登录成功时先替换，登出和签名过期时按实例移除：

```dart
V2TimConversationListener? _conversationListener;
V2TimFriendshipListener? _friendshipListener;
V2TimAdvancedMsgListener? _messageListener;

Future<void> removeOwnListeners() async {
  if (_conversationListener case final listener?) {
    await conversationManager.removeConversationListener(listener: listener);
    _conversationListener = null;
  }
  if (_friendshipListener case final listener?) {
    await friendshipManager.removeFriendListener(listener: listener);
    _friendshipListener = null;
  }
  if (_messageListener case final listener?) {
    await messageManager.removeAdvancedMsgListener(listener: listener);
    _messageListener = null;
  }
}
```

## 三、常规 IM 功能如何落地

### 3.1 会话列表与未读数

会话列表由 TUIKit 提供基础视图，业务层负责页面入口、路由和权限门禁。首次进入时主动调用 `getTotalUnreadMessageCount()`，后续由 `onTotalUnreadMessageCountChanged` 增量更新。

不能在首次查询成功后直接写 `0`：那会让用户冷启动后看不到历史未读数，只有等下一次未读变化事件才能修正。

```dart
final result = await conversationManager.getTotalUnreadMessageCount();
if (result.code == 0) {
  totalUnread.value = result.data ?? 0;
}
```

页面通过 GetX `Worker` 对未读数做短时间 debounce，避免群消息密集到达时频繁刷新顶层 Tab。页面销毁时必须 `dispose()` Worker，否则控制器已退出仍然会响应更新。

### 3.2 单聊、群聊与常规消息

聊天页使用统一的 `TIMUIKitChat`，再根据会话类型传入用户 ID 或群 ID。开启的能力包括：

- 文本、图片、语音、表情、附件面板。
- C2C 已读状态。
- 群管理员撤回。
- 输入区焦点、消息长按和头像点击回调。
- 按会话免打扰状态决定是否播放收消息音效。

业务层不需要重写文本、图片等基础消息的渲染，只在 `customMessageItemBuilder` 处接管业务自定义消息。这种“通用 UI 复用 + 业务插槽”的成本远低于自建整套聊天页。

### 3.3 通讯录与好友体系

通讯录包含好友列表、新的好友申请、我加入的群组和黑名单。应用额外监听好友申请的新增和删除，将“收到的申请”未读数映射到通讯录入口。

解析 SDK 枚举时不应直接用外部整数作为 `values[index]`，因为越界值会让整个回调抛异常。对当前场景，直接比较需要的枚举 `index` 更稳妥。

### 3.4 群组与搜索

群组链路覆盖创建群、群成员、群资料、入群申请、群二维码和邀请策略。创建成功后会发送一条 `group_create` 自定义系统消息，聊天页把它渲染为居中提示，而不是普通气泡。

搜索则分为好友、群组、群成员和本地历史消息。这些能力应由 IM 适配层统一暴露，避免页面直接依赖 SDK 单例，否则后续升级 SDK 会扩大改动面。

## 四、自定义消息协议

### 4.1 一个可演进的消息信封

自定义消息是 JSON 字符串，顶层字段用 `businessID` 识别类型，`version` 承担协议演进。红包卡片可以是：

```json
{
  "businessID": "red_packet",
  "version": 1,
  "rp_id": 1024,
  "from_uid": "sender-id",
  "nickname": "发送者昵称",
  "avatar": "https://example.com/avatar.png",
  "remark": "恭喜发财",
  "rp_status": 0,
  "red_packet_picked": "user-a,user-b"
}
```

领取回执则是另一种消息：

```json
{
  "businessID": "red_packet_picked",
  "version": 1,
  "send_uid": "packet-sender-id",
  "from_uid": "receiver-id",
  "text": "某用户领取了你的红包"
}
```

建议把所有自定义消息都收敛到一个带版本的信封：

```dart
sealed class ChatEvent {
  const ChatEvent();
}

final class RedPacketCreated extends ChatEvent {
  const RedPacketCreated({required this.packetId});
  final int packetId;
}

final class RedPacketClaimed extends ChatEvent {
  const RedPacketClaimed({required this.packetId, required this.receiverId});
  final int packetId;
  final String receiverId;
}
```

解析器返回具体业务类型，Widget 不再到处判断字符串。对未知 `businessID`、旧版本和非法 JSON 统一降级成“不支持的消息”，不让单条脏数据影响整个消息列表。

### 4.2 本地 TUIKit 扩展点

红包不只需要自定义卡片，还需要发送入口和特殊操作规则。项目在本地 TUIKit fork 中做了三个有边界的扩展：

1. 在更多面板增加“红包”按钮，通过 `rpClick` 回调把操作交回业务层。
2. 会话列表对 `red_packet` 和 `red_packet_picked` 生成可读的最后一条摘要。
3. 多选和长按菜单禁止转发红包，避免“转发一条过期业务指令”。

这些改造保留了 TUIKit 对普通消息的处理，业务代码只接管红包。但本地 fork 也会带来升级成本，应记录每个改动点，并在 SDK 升级时做定向回归。

`sendCustomMessage()` 还要处理“创建消息失败返回 null”，不能直接使用 `!`：

```dart
final created = await messageService.createCustomMessage(data: data);
if (created == null || created.messageInfo == null) {
  return null;
}
return send(created.messageInfo!);
```

## 五、发红包：先创建业务实体，再发通知

### 5.1 金额与业务规则

发红包页面先拉取服务端配置，而不是把限额写死在 App 中。配置通常包括：

- 红包功能开关。
- C2C 或群聊的红包类型、份数范围。
- 单笔固定上限。
- 基于用户余额的百分比上限。
- 支付密码、红包封面、问候语等业务约束。

最终可发金额取固定限额与余额百分比限额的较小值。金额计算使用 `Decimal`，避免 `double` 的二进制精度问题。客户端校验只是为了即时反馈，服务端必须重复执行全部校验。

### 5.2 发送时序

```text
1. 读取红包配置与用户余额
2. 校验金额、份数、会话类型
3. 让用户输入支付密码
4. 调用业务服务端 createRedPacket
5. 服务端完成扣减或冻结，返回 packetId
6. 把 packetId 编码为 red_packet 自定义消息
7. 发送到 C2C 或群会话
```

这个顺序不能反过来。如果先发 IM 卡片再创建红包，会话中可能出现一条永远无法领取的“幽灵红包”。

但先创建服务端红包也不是完全一致：如果第 5 步成功、第 7 步失败，资金已扣减，会话里却没有卡片。这个缺口不能只靠客户端 `try-catch` 解决，需要服务端提供至少一种补偿能力：

- 带幂等键的重发，同一 packetId 可补发 IM 通知。
- 创建后短时间内可撤销未领取红包。
- 服务端 Outbox 记录待投递事件，由可重试任务发送 IM。

## 六、领红包：服务端原子领取，IM 最终同步

### 6.1 打开红包的完整链路

```text
点击红包卡片
  → 根据本地状态快速判断已领完/已过期/已领取
  → 调用 checkAvailable 向服务端确认
  → C2C 场景阻止发送者领自己的红包
  → 展示开红包动画
  → 调用 open(packetId)
  → 服务端原子校验并入账
  → 修改原红包卡片的本地展示状态
  → 发送 red_packet_picked 领取回执
  → 进入服务端红包详情页
```

`checkAvailable` 用于提前反馈，`open` 才是真正的原子命令。两个用户可以同时通过检查，所以服务端在 `open` 中仍然必须使用数据库条件更新、事务或分布式锁保证份数不会超发。

### 6.2 “已领取用户”不能做子串匹配

原始消息把已领取用户 ID 保存为逗号分隔的字符串。如果用 `picked.contains(userId)` 判断，`12` 会误命中 `312`。最小修正是先解析为精确 ID 集合：

```dart
Set<String> get pickedUserIds => (redPacketPicked ?? '')
    .split(',')
    .map((id) => id.trim())
    .where((id) => id.isNotEmpty)
    .toSet();

bool hasPicked(String userId) =>
    userId.isNotEmpty && pickedUserIds.contains(userId);

void markPicked(String userId) {
  if (userId.isEmpty) return;
  final ids = pickedUserIds..add(userId);
  redPacketPicked = ids.join(',');
}
```

这只是对现有协议的兼容修正。从长期看，领取列表不适合无限写回一条自定义消息，原因有三个：

- 群红包人数增长时，消息体会持续膨胀。
- 自定义消息中的业务字段可由客户端构造，不具备账本级可信性。
- 多人并发修改同一条消息，会产生最后写入覆盖问题。

更好的方案是卡片只保留 packetId 和粗粒度状态，详情始终从服务端查询。如果需要高频、细粒度地同步 UI，再评估消息扩展或独立业务事件，而不是不断重写原始 JSON。

### 6.3 群定向回执和 C2C 回执必须分流

领取回执的目标通常是红包发送者，而不是所有群成员。群聊可以先创建普通自定义消息，再转成定向群消息；C2C 则应直接把自定义消息发给对方。

```dart
var receipt = await messageManager.createCustomMessage(data: payload);
var message = receipt.data?.messageInfo;
if (message == null) return;

if (conversation.isGroup) {
  final targeted = await messageManager.createTargetedGroupMessage(
    message: message,
    receiverList: [packetSenderId],
  );
  message = targeted.data?.messageInfo;
  if (message == null) return;
}

await messageManager.sendMessage(
  message: message,
  receiver: conversation.peerUserId ?? '',
  groupID: conversation.groupId ?? '',
);
```

不能在 C2C 中调用 `createTargetedGroupMessage`：它的语义就是定向群消息，并且受群类型、SDK 版本和套餐能力约束。

### 6.4 IM 同步失败不能掩盖领取成功

当服务端 `open` 已返回成功，资金事实已经建立。后续的 `modifyMessage` 或领取回执发送失败时，客户端应记录可观测日志并继续进入领取详情，而不是对用户显示“领取失败”。

这体现了两种不同的成功级别：

| 操作 | 性质 | 失败后的处理 |
|---|---|---|
| 服务端 `open` | 资金主交易 | 不能假定成功，按错误码展示 |
| 修改本地红包卡片 | UI 同步 | 记录错误，详情页从服务端修正 |
| 发送领取回执 | 通知同步 | 可重试或最终一致，不回滚资金事实 |
| 跳转详情页 | 用户反馈 | 应继续，展示服务端最终状态 |

## 七、红包状态的一致性模型

对一条红包消息，客户端同时看到三份状态：

```text
IM 卡片快照：让消息列表立即可渲染
        ↓ 可能过期
服务端快速校验：打开弹窗前判断可用性
        ↓ 仍可能并发变化
服务端原子命令：建立最终领取事实
```

优先级是：服务端原子命令 > 服务端查询 > IM 卡片快照。

因此，消息列表可以依赖快照追求流畅，但用户点击、展示详情或涉及资金时必须回到服务端。

## 八、对原实现的代码评审

### 8.1 值得保留的设计

- 基础消息复用 TUIKit，自定义消息通过 Widget Builder 插入，业务侵入面可控。
- UserSig 由服务端签发，客户端不包含 IM 密钥。
- 红包金额、份数、领取和详情由业务服务端管理，IM 只做投递。
- 红包禁止转发，定向回执避免群聊刷屏。
- 先做可用性检查，再由 `open` 确立最终事实，交互与安全边界清楚。
- 会话免打扰与消息音效联动，不会为静音会话播放提示音。

### 8.2 本轮直接修正的问题

| 问题 | 风险 | 修正 |
|---|---|---|
| SDK 初始化返回失败仍设 `_isInit = true` | 后续登录在未初始化状态运行 | 只在 init 明确成功后注册能力并标记成功 |
| 登录重试用递归，却被 `loggingIn` 拦截 | 网络抖动时实际不重试 | 改为有上限的循环重试 |
| 首次未读查询成功后写死为 0 | 冷启动未读徽标错误 | 使用 SDK 返回的实际未读数 |
| 不保存监听器引用 | 重复回调或误移除 TUIKit 监听器 | 按实例替换和移除 |
| 日志输出完整 UserSig | 凭证泄漏 | 只记录 userID、错误码和重试次数 |
| GetX Worker 没有销毁 | 退出页面后仍然响应更新 | 在 `onClose` 中 dispose |
| 已领取 ID 使用子串匹配 | 用户 ID 误判 | 解析为 Set 后精确匹配，防止重复写入 |
| 模型序列化遗漏 `send_uid` | 回执再序列化时丢失收件人 | 补齐反序列化对称性 |
| C2C 也创建定向群消息 | 接口语义错误，回执发送失败 | 群聊使用定向消息，C2C 直接发送 |
| 自定义消息创建结果强制解包 | 创建失败时崩溃 | 显式处理 null 并返回可恢复失败 |

这些改动不需要改后端协议，也不改变已有消息格式，因此适合直接落地。

### 8.3 深化优化的目标架构

上述低风险问题可以在 Flutter 项目内直接修正。剩余问题不是无法解决，而是修复边界横跨 App、业务服务端和 IM 服务端。只改客户端会产生新的一致性缺口。

本节的 Dart、SQL 与时序片段是用于约定职责和接口的架构伪代码，实施时需根据服务端语言、数据库和 IM Server API 转换。

目标架构将“资金事实”和“聊天投影”分成两条链路：

```text
Flutter App
├── RedPacketRepository ─────────────────┐
│     ├── create(commandId)                  │
│     ├── claim(commandId)                   │ HTTPS
│     └── getSnapshot(packetId)              │
└── ChatGateway                                  │
      ├── 接收版本化业务事件                │
      └── 把事件投影为聊天卡片              │
                                                ↓
业务服务端
├── RedPacket Service：金额、份数、领取事务
├── Ledger Service：冻结、入账、退回
├── Outbox Worker：可重试地投递 IM 事件
└── Reconciliation Job：对账与异常补偿
                                                ↓
IM 服务
├── red_packet.created
├── red_packet.claimed
├── red_packet.status_changed
└── 普通文本、图片、语音消息
```

职责划分如下：

| 组件 | 保存的真值 | 不应承担的职责 |
|---|---|---|
| 业务服务端 | 红包状态、金额、领取记录、账务 | 不依赖客户端回传的卡片状态 |
| Outbox | 待投递业务事件及重试状态 | 不修改红包资金事实 |
| IM | 业务事件的投递结果 | 不判断红包是否还能领 |
| Flutter App | UI 快照与用户交互状态 | 不决定最终入账结果 |

### 8.4 自定义消息升级为版本化事件

现有 `businessID + 平铺字段` 能满足少量消息类型，但不能回答“这条事件是否处理过”、“属于哪个会话”和“对应业务实体的第几个版本”。新协议使用统一信封：

```json
{
  "schema": "chat.business_event",
  "version": 2,
  "eventId": "01J6X4Y8J5Y2R8J7A4Q7M7P9F2",
  "type": "red_packet.created",
  "occurredAt": "2026-08-22T10:00:00Z",
  "conversation": {
    "type": "group",
    "id": "group-1001"
  },
  "actor": {
    "id": "user-1001",
    "displayName": "发送者",
    "avatarUrl": "https://example.com/avatar.png"
  },
  "aggregate": {
    "type": "red_packet",
    "id": "packet-1001",
    "revision": 1
  },
  "payload": {
    "remark": "恭喜发财",
    "cover": "default",
    "packetType": "random"
  },
  "businessID": "red_packet",
  "rp_id": "packet-1001"
}
```

信封中的关键字段有明确语义：

- `eventId`：全局唯一，用于客户端去重、投递重试和全链路排查。
- `type`：使用过去式事件名，如 `red_packet.created`、`red_packet.claimed`。
- `aggregate.id`：业务实体 ID，此处是 packetId。
- `aggregate.revision`：红包状态版本，客户端只接受更新的版本。
- `payload`：只包含渲染所需的快照，不放入支付密码、精确账务等敏感信息。
- 顶层 `businessID` 和 `rp_id`：迁移期的旧客户端兼容字段，完成升级后删除。

客户端解析器先判断 `schema + version`，不识别新协议时再降级到旧 `businessID` 模型：

```dart
ChatEvent decodeChatEvent(Map<String, Object?> json) {
  if (json['schema'] == 'chat.business_event') {
    return switch (json['version']) {
      2 => ChatEventV2.fromJson(json).toDomain(),
      _ => UnsupportedChatEvent(rawType: json['type'] as String?),
    };
  }

  // 兼容存量消息，统一转换为领域事件。
  return LegacyChatEvent.fromJson(json).toDomain();
}
```

迁移不能一次切换，应分为四个阶段：

1. App 先上线双协议解析器，仍只接收 V1 消息。
2. 服务端发送 V2 信封，同时保留顶层 V1 必要字段，新旧 App 都能渲染同一条消息。
3. 根据版本活跃率和解析失败指标确认旧客户端已低于业务阈值。
4. 新版本停止写入兼容字段，但保留 V1 解析能力，确保历史消息可读。

### 8.5 Outbox 解决“红包成功但 IM 没发出”

现有流程是 App 先调用创建红包 API，再由 App 发送 IM 消息。App 在两步之间被杀进程、断网或 SDK 失败时，会留下“已冻结资金但无法访问”的红包。

解决方案是 Transactional Outbox：创建红包和写入待投递事件必须位于同一数据库事务。

```sql
CREATE TABLE red_packet (
  id              VARCHAR(64) PRIMARY KEY,
  sender_id       VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(128) NOT NULL,
  status          VARCHAR(32) NOT NULL,
  total_amount    DECIMAL(18, 2) NOT NULL,
  claimed_amount  DECIMAL(18, 2) NOT NULL DEFAULT 0,
  total_count     INT NOT NULL,
  claimed_count   INT NOT NULL DEFAULT 0,
  revision        BIGINT NOT NULL DEFAULT 1,
  expires_at      TIMESTAMP NOT NULL
);

CREATE TABLE outbox_event (
  event_id        VARCHAR(64) PRIMARY KEY,
  aggregate_id    VARCHAR(64) NOT NULL,
  event_type      VARCHAR(64) NOT NULL,
  payload         JSON NOT NULL,
  status          VARCHAR(16) NOT NULL,
  retry_count     INT NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL,
  delivered_at    TIMESTAMP NULL
);
```

创建事务只做本地数据库写入，不在事务内调用外部 IM 接口：

```text
BEGIN
  检查幂等键
  校验发送人、限额、份数和余额
  冻结资金
  INSERT red_packet(status = PENDING_DISPATCH)
  INSERT outbox_event(type = red_packet.created, status = PENDING)
COMMIT
```

Outbox Worker 通过 `FOR UPDATE SKIP LOCKED` 或等价队列锁抢占任务：

```text
PENDING
  → 调用 IM 服务端 API
  → 成功：事件设为 DELIVERED，红包设为 ACTIVE
  → 可重试失败：指数退避，retry_count + 1
  → 超过最大次数：设为 DEAD，进入补偿队列
```

红包在 `PENDING_DISPATCH` 状态只冻结资金，不允许领取。IM 卡片极短时间内先到达而状态尚未切换时，`checkAvailable` 返回 `PREPARING`，App 显示“红包准备中”并短轮询。

Worker 可能在“IM 已成功、本地未标记成功”时崩溃，重启后将重发同一 `eventId`。跨系统的严格 exactly-once 很难保证，因此接收端用 `eventId` 去重，将投递语义收敛为“至少一次投递 + 幂等消费”。

死信补偿策略是：

- 红包仍为 `PENDING_DISPATCH` 且没有领取记录：取消红包并解冻全部金额。
- IM 已有投递证据，但回写状态失败：修正为 `ACTIVE`，不退款。
- 无法自动判断：进入人工对账队列，不允许客户端自动决定资金结果。

### 8.6 幂等与并发领取方案

网络超时不代表服务端执行失败。用户重复点击、Dio 重试、App 重启恢复都可能重发创建或领取请求。两个写接口都必须接受客户端生成的幂等键：

```http
POST /api/red-packets
Idempotency-Key: 01J6X5CREATE9K1

POST /api/red-packets/{packetId}/claims
Idempotency-Key: 01J6X5CLAIM8T2
```

服务端保存 `user_id + operation + idempotency_key` 与首次响应。同键同参数的重复请求直接返回首次结果；同键不同参数返回 `409 IDEMPOTENCY_CONFLICT`，避免一个键被用于两笔不同交易。

领取表至少需要两个唯一约束：

```sql
CREATE TABLE red_packet_claim (
  id               VARCHAR(64) PRIMARY KEY,
  packet_id        VARCHAR(64) NOT NULL,
  receiver_id      VARCHAR(64) NOT NULL,
  amount           DECIMAL(18, 2) NOT NULL,
  idempotency_key  VARCHAR(64) NOT NULL,
  claim_event_id   VARCHAR(64) NOT NULL,
  created_at       TIMESTAMP NOT NULL,
  UNIQUE (packet_id, receiver_id),
  UNIQUE (receiver_id, idempotency_key)
);
```

`open` 在一个数据库事务内完成：

```text
1. 查询幂等记录，有结果则直接返回
2. 锁定红包记录，检查 ACTIVE、未过期、份数大于 0
3. 在事务内计算本次金额
4. INSERT red_packet_claim，由唯一约束阻止同一人重复领取
5. 增加 claimed_count/claimed_amount/revision
6. 最后一份被领取时把状态改为 EXHAUSTED
7. 写入账务流水与 red_packet.claimed Outbox 事件
8. COMMIT 后返回领取结果
```

可以用行锁，也可以用带版本号的条件更新；不论选哪种，唯一约束都是最后一道保护，不能只依赖 Redis 分布式锁。

### 8.7 用快照和事件替代 `red_packet_picked`

新协议不再把所有领取人 ID 写回原始红包消息。列表页只维护粗粒度投影：

```dart
class RedPacketProjection {
  const RedPacketProjection({
    required this.packetId,
    required this.status,
    required this.claimedCount,
    required this.totalCount,
    required this.revision,
    required this.claimedByMe,
  });

  final String packetId;
  final RedPacketStatus status;
  final int claimedCount;
  final int totalCount;
  final int revision;
  final bool claimedByMe;
}
```

状态有明确迁移：

```text
PENDING_DISPATCH ──投递成功──→ ACTIVE
       │                         ├──最后一份领取──→ EXHAUSTED
       └──投递死信────→ CANCELLED
                                 ├──到期───────→ EXPIRED
                                 └──未领且主动撤销→ CANCELLED
```

客户端处理 `red_packet.claimed` 时，只在事件 `revision` 大于当前投影时更新计数和状态。当 `receiverId` 是当前用户时，设置 `claimedByMe = true`。用户进入详情、重连或发现 revision 跳号时，调用快照接口纠正本地投影：

```http
GET /api/red-packets/{packetId}/snapshot

200 OK
{
  "packetId": "packet-1001",
  "status": "ACTIVE",
  "claimedCount": 8,
  "totalCount": 20,
  "revision": 9,
  "claimedByMe": true
}
```

如果需要让原消息卡片在多端更快显示“已领完”，可评估 Tencent Cloud Chat 的消息扩展能力，只写入 `status`、`claimedCount`、`revision` 等有上限的粗粒度字段。扩展值仍然是 UI 快照，不存储领取人全量列表，也不参与资金校验。上线前要根据实际 SDK 版本、套餐和消息类型验证支持范围。

### 8.8 把 SDK 从页面控制器中隔离

页面控制器直接调用 `createCustomMessage`、`createTargetedGroupMessage`、`modifyMessage` 和 `sendMessage`，会同时承担 UI 状态、业务流程和 SDK 细节。SDK 升级或编写测试时，改动会直接波及页面。

将边界收敛成两个接口：

```dart
abstract interface class ChatGateway {
  Stream<ChatEvent> get events;

  Future<SendResult> sendBusinessEvent({
    required ConversationRef conversation,
    required ChatEvent event,
    Set<String> visibleTo = const {},
  });
}

abstract interface class RedPacketRepository {
  Future<RedPacketCreateResult> create(RedPacketCreateCommand command);

  Future<RedPacketClaimResult> claim({
    required String packetId,
    required String idempotencyKey,
  });

  Future<RedPacketProjection> getSnapshot(String packetId);
}
```

SDK Adapter 内部处理 C2C 与群定向消息差异，Repository 处理 HTTP 错误码和幂等响应。用例层只组织业务：

```dart
final class ClaimRedPacketUseCase {
  ClaimRedPacketUseCase(this._repository);

  final RedPacketRepository _repository;

  Future<ClaimUiResult> call(String packetId) async {
    final commandId = newSortableId();
    final result = await _repository.claim(
      packetId: packetId,
      idempotencyKey: commandId,
    );

    // 资金事实由服务端结果决定，IM 回执不影响返回值。
    return switch (result) {
      ClaimSucceeded(:final snapshot) => ClaimUiResult.success(snapshot),
      AlreadyClaimed(:final snapshot) => ClaimUiResult.detail(snapshot),
      PacketUnavailable(:final reason) => ClaimUiResult.unavailable(reason),
    };
  }
}
```

这样可以用 Fake Repository 和 Fake ChatGateway 测试超时、重试、重复回执与事件乱序，不需要在单元测试中真正登录 IM。

### 8.9 失败补偿与对账

资金系统不能只靠在线请求的成功日志判断正确性。服务端定时对比四类数据：

```text
红包主表冻结/领取金额
          ↕
红包领取明细合计
          ↕
账务流水的冻结、入账、退回记录
          ↕
Outbox 投递与死信状态
```

对账规则至少包括：

- `claimed_amount` 等于领取明细金额总和。
- 发送者冻结金额等于已领金额 + 待领金额 + 已退金额。
- `EXHAUSTED` 的 `claimed_count` 等于 `total_count`。
- `EXPIRED/CANCELLED` 红包的未领部分已生成退回流水。
- `ACTIVE` 红包必须有 `red_packet.created` 成功投递记录。
- `DELIVERED` Outbox 事件保存 IM messageId，方便故障排查。

对账任务发现差异时先冻结异常实体的后续操作，再执行可重复的补偿命令。补偿命令同样要有幂等键，防止定时任务重启时重复退款。

### 8.10 可观测性与交付标准

`commandId`、`eventId`、`packetId`、`IM messageId` 应贯穿客户端日志、HTTP 请求、数据库记录和 IM 投递日志。不记录支付密码、UserSig、完整身份信息和不必要的金额明细。

上线指标可以设计为：

| 指标 | 用途 |
|---|---|
| `red_packet_create_total` | 创建量与业务基线 |
| `red_packet_claim_conflict_total` | 最后一份竞争和重复领取情况 |
| `outbox_delivery_latency` | 从创建成功到 IM 卡片可见的延迟 |
| `outbox_retry_total` | IM 依赖的短期稳定性 |
| `outbox_dead_total` | 需要补偿或人工介入的事件数 |
| `chat_event_decode_failure_total` | 协议兼容和脏数据问题 |
| `projection_revision_gap_total` | 事件丢失、乱序或重连后的快照修正次数 |

方案的交付标准不是“新接口可以调通”，而是：

1. 创建 API 超时后用同一幂等键重试，只产生一个红包和一笔冻结流水。
2. 两人并发抢最后一份，只一人成功，主表、明细和账务金额完全一致。
3. IM 连续不可用期间 Outbox 可重试；恢复后卡片最终可见，客户端不重复渲染同一 `eventId`。
4. 达到死信阈值的未投递红包被取消并解冻，不留下不可访问的活跃资金。
5. App 新旧版本在协议迁移期都可显示红包，历史 V1 消息仍可读。
6. 任意异常交易都能通过 packetId 追溯到 commandId、eventId、账务流水和 IM messageId。

## 九、如何测试这套链路

### 9.1 单元测试

自定义消息模型是最适合先补的纯逻辑测试：

```dart
test('user id must be matched exactly', () {
  final model = ChatMessage(redPacketPicked: '312,45');

  expect(model.hasPicked('12'), isFalse);
  expect(model.hasPicked('312'), isTrue);
});

test('serialization keeps both sender fields', () {
  final source = ChatMessage(
    sendUid: 'packet-sender',
    fromUid: 'packet-receiver',
  );

  final restored = ChatMessage.fromJson(source.toJson());
  expect(restored.sendUid, 'packet-sender');
  expect(restored.fromUid, 'packet-receiver');
});
```

登录状态机应通过注入的 IM Gateway 测试：初始化失败、首次成功、三次失败后成功、UserSig 过期刷新、最终失败，以及并发登录只发起一次请求。

### 9.2 集成测试矩阵

| 场景 | 需要验证的结果 |
|---|---|
| C2C 普通消息 | 发送、接收、已读、未读数一致 |
| 群聊普通消息 | 多成员接收、撤回、免打扰 |
| C2C 红包 | 发送者不可自领，领取回执直接发给对方 |
| 群红包 | 发送者可自领，回执只对指定成员可见 |
| 最后一份并发领取 | 只有一个服务端请求成功，详情统一 |
| 断网后重连 | 监听器不重复，未读数不归零 |
| UserSig 过期 | 刷新凭证后只登录一次，日志无凭证原文 |
| 服务端领取成功、IM 回执失败 | 仍进入成功详情，重新查询可恢复状态 |

## 十、面试问答

### Q1：为什么红包不能只用 IM 自定义消息实现？

因为 IM 解决的是消息投递，不是资金事务。客户端数据不可信，并发领取需要原子性，金额和份数必须由服务端统一维护。

### Q2：为什么要先查 `checkAvailable`，又调用 `open`？

`checkAvailable` 用于提前告知用户已领完或已过期，优化交互；`open` 必须重新校验并原子执行，因为检查到执行之间状态可能已被其他用户改变。

### Q3：修改 IM 中的红包卡片后，能否认为领取成功？

不能。卡片是缓存视图，领取成功的唯一依据是服务端 `open` 返回的交易结果。

### Q4：为什么群领取回执要做定向消息？

红包发送者需要得知领取人，但每次领取都广播给整个群会产生大量噪声。定向群消息可以将回执限制给发送者。

### Q5：登录重试用递归有什么风险？

除了调用栈和可读性问题，更容易出现状态机自我拦截：外层标记“登录中”后，内层重试直接返回。有界循环配合明确的退出条件更容易验证。

### Q6：本地 TUIKit fork 和业务层扩展如何选择？

优先使用官方 Builder、Callback 和配置项。只有当更多面板、长按菜单等内部交互没有对外扩展点时才维护 fork，并把补丁控制在少数可追踪文件中。

## 总结

一套可上线的 Flutter IM 不只是把聊天 UI 跑起来。它需要稳定的登录状态机、可回收的监听器、正确的未读数和清晰的 SDK 适配边界。当红包这类资金业务进入聊天系统后，还要把“消息通知”和“交易事实”彻底分开。

最稳妥的原则可以浓缩成三句话：

1. UserSig 与资金规则属于服务端边界。
2. IM 消息是可能过期的快照，不是账本。
3. 主交易成功后，后续 IM 同步应走最终一致，不能伪造主交易失败。

## 参考资料

- [Tencent Cloud Chat：Flutter SDK API 概览](https://trtc.io/document/40124?menulabel=core+sdk&platform=flutter&product=chat)
- [Tencent Cloud Chat：登录](https://trtc.io/document/47971)
- [Tencent Cloud Chat：UserSig 鉴权](https://trtc.io/document/34385)
- [Tencent Cloud Chat：修改消息](https://trtc.io/document/48004)
- [Tencent Cloud Chat：定向群消息](https://trtc.io/document/48028?product=chat)
- [Tencent Cloud Chat：消息扩展](https://trtc.io/document/52489?menulabel=core+sdk&platform=flutter&product=chat)
