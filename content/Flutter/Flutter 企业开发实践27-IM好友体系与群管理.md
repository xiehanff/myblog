---
title: Flutter 企业开发实践27-IM好友体系与群管理
date: 2026-08-23
tags: [Flutter, IM, 即时通讯, TUIKit, 群聊, 通讯录, 好友, GetX, 架构, 面试]
---

# IM 好友体系与群管理

> 26 篇解决了"IM 怎么接入、消息怎么收发"，28 篇要解决"红包这种带资金状态的自定义消息怎么做"。本篇是夹在两者之间的中间篇：好友体系与群管理。接入、登录、收发消息是这两块业务的土壤，不再重复；本篇回答的问题是——复杂度的来源不是"消息能不能发出去"，而是"谁能做这件事"和"状态怎么保持一致"。好友申请要同步未读数，群成员要分页拉取，群主、管理员、普通成员的权限边界要跟 UI 入口一一对应，禁言状态要同时反映在输入区、错误码和群管理设置里。权限与状态同步，就是好友与群管理全部复杂度的来源。

---

## 一、功能全景与页面路径

先给一张页面路径图，后续所有章节都挂在它上面。图中的实线是用户可走的入口，虚线是返回路径：

```text
会话列表（ChatHomeView）
  ├── 顶部搜索框 ──────→ TIMUIKitSearch（会话/联系人/群组/群成员/历史消息）
  ├── 通讯录 ──────────→ TIMUIKitContact（ContactBookView）
  │                      ├── 新的朋友 ──→ TIMUIKitNewContact（处理好友申请）
  │                      ├── 我的群聊 ──→ TIMUIKitGroup（我加入的群）
  │                      ├── 黑名单 ────→ TIMUIKitBlackList
  │                      └── 好友列表项 ─→ 用户详情页（自研 ChatUserDetailsView）
  └── 右上角"更多" ────→ ChatTopRightDialog（SmartDialog 弹窗）
       ├── 发起会话 ────→ 选好友页（convType=single）→ 单聊页
       ├── 扫一扫 ──────→ 权限检查 → 扫码 → 邀请码查用户 / groupqr 加群
       ├── 创建群聊 ────→ 选好友 → 群设置 → createGroup → 群聊页
       ├── 添加好友 ────→ TIMUIKitAddFriend
       └── 添加群聊 ────→ TIMUIKitAddGroup（贴群 ID / 群二维码）

群聊页（ChatView，TIMUIKitChat）
  ├── 右上角更多 ──────→ 群资料页（TIMUIKitGroupProfile + 自研入口）
  ├── 群头像点击 ──────→ 群成员资料（groupPush=true）
  └── 入群申请横幅 ────→ TIMUIKitGroupApplicationList（进群申请列表）

群资料页
  ├── TUIKit 自带：群管理（设置管理员/全员禁言/成员禁言）、主动加群方式、邀请加群方式、
  │                消息免打扰、置顶、群公告、群昵称、清空/退出/解散/转让
  ├── 自研叠加：群二维码、举报（type=1）、群成员列表、删除群成员
  └── 成员头像 ───────→ 用户详情页（groupPush=true）

用户详情页（自研 TIMUIKitProfile 包装）
  ├── 备注名 / 消息免打扰 / 置顶 / 黑名单（TUIKit 能力）
  ├── 举报（type=0）/ 发送消息 / 清空聊天记录 / 删除好友（自研）
  └── 发送消息 → 清理栈 → pushReplacement 聊天页
```

这张图有三个值得注意的分层：**通讯录与好友申请直接复用 TUIKit 组件**（TIMUIKitContact、TIMUIKitAddFriend、TIMUIKitNewFriend、TIMUIKitBlackList），**群资料和聊天页是 TUIKit 组件 + 自研入口的混合体**，**用户详情页是 TUIKit Profile 的能力槽 + 自研业务按钮**。三种形态的选择标准在第三节展开。

## 二、业务门禁与入口：签到、实名、权限的 gate 设计

聊天首页的入口不是"想点就能点"。`chat_home_controller.dart` 把门禁抽象成了两个检查，串在入口函数前面：

```dart
// chat_home_controller.dart
void onTapContact() async {
  final check = await _checkSign();
  if (check == false) return;
  BoostNavigator.instance.push(RouteConfigKey.contactBook);
}

Future<bool> _checkSign() async {
  if (state.isSign.value == false) {
    final tipCheck = await ActionDialog.show(
        title: "温馨提醒",
        content: "尊敬的用户，请您签到后再使用聊天功能，给您带来的不便，敬请谅解！",
        cancelStr: "确认",
        sureStr: "我要签到");
    if (tipCheck == null || tipCheck == false) return false;
    BaseTabBarController.to?.changeTabIndex(2);
    return false;
  }
  return true;
}
```

第一个 gate 是**签到**。通讯录、搜索框、更多图标全部先过 `_checkSign()`：未签到弹窗提示，点"我要签到"直接切到 Tab 2（签到页）。这个 gate 不是摆设——`_getSignData()` 里把签到状态和 IM 登录状态绑在了一起：

```dart
// chat_home_controller.dart
state.isSign.value = resModel.data ?? false;
if (state.isSign.value) {
  ImManager().redayLogin();
} else {
  if (ImManager().state.status.value == ImLoginStatus.success) {
    ImManager().imLogout();
  }
}
```

未签到直接登出 IM。这是一个业务强制"签到才可用 IM"的手段：登出后所有会话、未读数同步停止刷新，比在 UI 层拦截更彻底——就算绕过 UI 直接调聊天页，数据层也是断的。代价是每次签到后要重新走登录链路，这依赖 26 篇建立的登录状态机。

第二个 gate 是**实名**，比签到更细。看 `onTapMore` 的顺序，这是全篇第一个"权限分级"的实例：

```dart
// chat_home_controller.dart
final itemStr = await ChatTopRightDialog.show();
if (itemStr == null || itemStr.isEmpty) return;
final check = await _checkSign();
if (check == false) return;

if (itemStr == "发起会话") {
  BoostNavigator.instance.push(RouteConfigKey.createGroup, arguments: {
    "convType": GroupTypeForUIKit.single,
  });
  return; // 发起会话不需要实名，直接放行
}

if (state.isRealName.value == false) {
  showToast("请先进行实名");
  BoostNavigator.instance.push(RouteConfigKey.mineRealName);
  return;
}

switch (itemStr) {
  case "扫一扫":   _scanAction(); break;
  case "创建群聊": ... break;
  case "添加好友": ... break;
  case "添加群聊": ... break;
}
```

- **发起会话**放行：只是跟已有好友聊天，不产生新的关系。
- **扫一扫 / 创建群聊 / 添加好友 / 添加群聊**要实名：扫一扫可能把陌生人变成关系链，创建群聊会建立一个新的社交实体，这两类都涉及"建立新关系"，所以卡实名。

实名的判定来自接口 `isRealName` 的 `verify == 1`（`_getRealNameData`，结果存在 `state.isRealName`），未实名时先 toast"请先进行实名"再跳实名认证页。注意 toast 和跳转的顺序：先给反馈再跳页，避免用户不知道发生了什么。

`_scanAction` 里还有第三层 gate——**设备权限**：

```dart
// chat_home_controller.dart
void _scanAction() async {
  final check = await AppPermission.check(type: Permission.camera);
  if (check == false) return;
  final check1 = await AppPermission.check(type: Permission.photos);
  if (check1 == false) return;
  String? codeUrl = await BoostNavigator.instance.push(RouteConfigKey.qrScan);
  ...
}
```

扫码需要相机 + 相册两个权限（相册是为了从图库选二维码）。这三个 gate 的层次是：**签到（业务活跃度）→ 实名（建立关系的资格）→ 设备权限（硬件能力）**，每一层都只拦截自己负责的事，互不越界。如果全部写在一个函数里，后面加"会员等级门禁"时就要重写入口；分开写，新增 gate 只是再加一行检查。

扫码结果的处理是协议分发的典型写法（`_scanAction` 后半段）：

```dart
if (codeUrl.startsWith("http")) {
  final inviteCode = codeUrl.parerUrlByKey(); // 提取 ?info=xxx
  final resModel = await ApiClientExt.requestAction(
    ApiPaths.fakeDocsGetUserByInviteCode, ...);
  if (resModel.data?.uid == User.userId) {
    showToast("不可以添加本人~");
    return;
  }
  BoostNavigator.instance.push(RouteConfigKey.chatUserDetails,
      arguments: {"userID": inviteCode});
} else if (codeUrl.startsWith("groupqr")) {
  final list = codeUrl.split(";");
  if (list.length < 3) {
    showToast("请扫描正确的群二维码");
    return;
  }
  final groupID = list[1];
  BoostNavigator.instance.push(RouteConfigKey.addGroup,
      arguments: {"groupID": groupID});
} else {
  showToast("请扫描正确的邀请码");
}
```

三种内容三种去向：http 邀请码 → 查用户 → 用户详情；`groupqr;FAKE_GROUP_ID;FAKE_OWNER_ID` 群二维码 → 直接进添加群聊页（带 groupID 参数）；其他 → 提示。`split(";")` 后先校验长度再取 `list[1]`，这就是群二维码的协议格式——生成端在 `fake_docs/group_qr_code_controller.dart`：

```dart
// fake_docs/group_qr_code_controller.dart
inviteUrl = "groupqr;FAKE_GROUP_ID;FAKE_OWNER_ID";
```

扫描端与生成端对齐同一份格式约定。写协议的时候要注意：一旦二维码流出到朋友圈、截图里，格式就不能再变，所以版本兼容要么靠格式演进（比如加版本段），要么靠"不可变"。

## 三、好友体系：TUIKit 组件与自研入口的共存

好友体系是 TUIKit 覆盖度最高的部分，四个页面几乎零业务代码：

| 页面 | 组件 | 项目代码量 | 业务接线 |
|---|---|---|---|
| 通讯录 | `TIMUIKitContact` | 只配 topList 和 onTapItem | topList 三项 + 好友项跳用户详情 |
| 添加好友 | `TIMUIKitAddFriend` | 只配 onTapAlreadyFriendsItem | 已是好友 → pushReplacement 用户详情 |
| 新的朋友 | `TIMUIKitNewContact` | 只配 emptyBuilder | 空态换自研组件 |
| 黑名单 | `TIMUIKitBlackList` | 只配 onTapItem | 点击进用户详情 |

这是"自带业务逻辑的组件"（组件即页面）和自研入口共存的第一个策略：**直接嵌入 + 路由接线**。`contact_book_view.dart` 的写法：

```dart
// contact_book_view.dart
body: TIMUIKitContact(
  onTapItem: (item) {
    BoostNavigator.instance.push(RouteConfigKey.chatUserDetails,
        arguments: {'userID': item.userID});
  },
  topList: [
    TopListItem(name: "新的朋友", id: "newContact",
        icon: Stack(... 未读数红点 ...),
        onTap: () => _onTapTopListItemTap("newContact")),
    TopListItem(name: "我的群聊", id: "groupList", ...),
    TopListItem(name: "黑名单", id: "blackList", ...),
  ],
  topListItemBuilder: topListBuilder,
)
```

TUIKit 的 `TIMUIKitContact` 自带好友列表的数据加载、字母索引、搜索和空态。项目要接三件事：好友点击后的路由（`onTapItem`）、通讯录顶部的三个自定义入口（`topList` + `topListItemBuilder`）、好友申请未读数红点。其中红点是 `Obx` 包着状态驱动的：

```dart
final count = ImManager().state.friednAddCount.value;
if (count == 0) return const SizedBox.shrink();
return Container(... 红点样式 ...);
```

`friednAddCount` 由 `im_manager.dart` 的适配层维护，数据源是 SDK 的 `getFriendApplicationList()` 返回的 `unreadCount`，并通过好友监听器实时刷新（监听器的注册与生命周期管理属于 26 篇的适配层范畴，本篇只说业务使用）：

```dart
// im_manager.dart（精简）
void _getFriendApplicationList() async {
  final friendAddResult = await _v2TIMManager.getFriendshipManager()
      .getFriendApplicationList();
  if (friendAddResult.code == 0) {
    state.friednAddCount.value = friendAddResult.data?.unreadCount ?? 0;
  }
}

_v2TIMManager.getFriendshipManager().addFriendListener(listener:
    V2TimFriendshipListener(
  onFriendListAdded: (users) { _getFriendApplicationList(); },
  onFriendApplicationListDeleted: (userIDList) { _getFriendApplicationList(); },
  onFriendApplicationListAdded: (applicationList) {
    // 只统计"收到"的申请（V2TIM_FRIEND_APPLICATION_COME_IN），
    // 自己发出的申请不计数
    ...
    _getFriendApplicationList();
  },
));
```

把未读数收敛到适配层的 `state` 里，页面只管 `Obx` 消费——这就是 26 篇讲的"监听器生命周期归适配层"在好友场景的延续。未读数清零的时机由 TUIKit 的 NewFriend 页处理申请时自然完成（SDK 的 unreadCount 会更新），业务层不需要手动管理。

### 用户详情页：TUIKit 能力槽 + 自研业务按钮

用户详情页是"混合形态"的代表。`chat_im_user_details_view.dart` 用 `TIMUIKitProfile` 作为容器，通过 `profileWidgetsOrder` 指定区块顺序，再逐个用 `profileWidgetBuilder` 覆盖：

```dart
// chat_im_user_details_view.dart
TIMUIKitProfile(
  userID: c.userID,
  profileWidgetsOrder: const [
    ProfileWidgetEnum.userInfoCard,      // 自研：头像/昵称/ID/签名
    ProfileWidgetEnum.remarkBar,         // TUIKit：备注名
    ProfileWidgetEnum.messageMute,       // TUIKit：消息免打扰
    ProfileWidgetEnum.pinConversationBar,// TUIKit：置顶聊天
    ProfileWidgetEnum.addToBlockListBar, // TUIKit：加入黑名单
    ProfileWidgetEnum.customBuilderOne,  // 自研：举报
    ProfileWidgetEnum.customBuilderTwo,  // 自研：发送消息
    ProfileWidgetEnum.addAndDeleteArea,  // 自研：添加/删除好友、清空记录
  ],
  profileWidgetBuilder: ProfileWidgetBuilder(
    userInfoCard: userInfoWidget, ...),
)
```

TUIKit 的 Profile 页本身就是"可组装区块"的设计：备注、免打扰、置顶、黑名单这些通用能力直接用枚举挂上，业务的举报、发送消息用 `customBuilderOne/Two` 插槽塞进去。自研区块里藏着几个细节：

**举报区分对象。** 用户详情页的举报 `type=0`、accid 是 userID；群资料页的举报 `type=1`、accid 是 groupID（`group_profile_controller.dart`）。同一个举报后端接口，用 type 区分举报对象，进入不同的审核流程。自己不能举报自己——`customBuilderOne` 里 `friendInfo.userID == User.inviteCode` 时直接返回 `SizedBox.shrink()`。

**发送消息前清理导航栈。** 这是 `chat_im_user_details_controller.dart` 里最值得抄的一段：

```dart
// chat_im_user_details_controller.dart
void onTapSendMsg(...) async {
  List<String> noRemList = [
    "/",
    RouteConfigKey.baseTabBar,
    RouteConfigKey.chatUserDetails
  ];
  final containers = BoostNavigator.instance.appState?.containers ?? [];
  for (final v in containers) {
    for (final m in v.pages) {
      if (noRemList.contains(m.name) == false) {
        BoostNavigator.instance.remove(m.pageInfo.uniqueId);
      }
    }
  }
  // showName 回退链
  String showName = conversation.showName ?? "";
  if (showName.isEmpty) showName = friendInfo.friendRemark ?? "";
  if (showName.isEmpty) showName = friendInfo.userProfile?.nickName ?? "";
  if (showName.isEmpty) showName = "聊天";
  conversation.showName = showName;
  BoostNavigator.instance.pushReplacement(RouteConfigKey.chat,
      arguments: {"conversation": conversation});
}
```

用户可能从"通讯录 → 用户详情 → 发送消息"，也可能从"扫一扫 → 查用户 → 用户详情 → 发送消息"，还可能从"群成员列表 → 用户详情 → 发送消息"。如果不清理栈，聊天页返回时会一层层退回到用户详情、扫码结果页、通讯录——路径不可控。这里的做法是：**只保留 Tab 容器、会话列表和当前详情页，其余全部 remove，然后 pushReplacement 聊天页**，这样从聊天页返回永远落在会话列表。Boost 的容器模型（`appState.containers` 里每项含 `pages`）让"按页面名批量移除"成为可能。不这样做会怎样：在混合栈里，一次扫码发消息后用户会被困在一条不可控的返回链里，连续按返回键能退到十几层之前的页面。

showName 的回退链（conversation.showName → friendRemark → nickName → "聊天"）保证会话标题有值：TUIKit 的会话对象可能没有 showName，直接渲染会出空标题，最后兜底的"聊天"是硬编码防线。

**清空聊天记录要确认 + 处理失败。** `onTapClearMsg` 先用 `TipDialog` 确认，再调 `clearC2CHistoryMessage(userID: userID)`，失败时 toast 返回的 `desc`。删除好友同样要二次确认（"删除好友后，将清空聊天记录，是否确认?"）。这类"不可逆操作"全部过确认弹窗，是关系链操作的安全基线。

**群内好友有特殊限制。** 用户详情页底部按钮区（`addAndDeleteAreaWidget`）里，`friendType == 0`（非好友）时显示"添加好友"，但如果 `groupPush == true`（从群成员列表进来），点击会提示"群组内添加好友暂未开放!"。为什么：群成员之间是"弱关系"（可能只是同群），直接放行加好友会把骚扰路径打开——有人专门加群收集成员再批量加好友。产品上先关掉这个入口，比后期做频控简单。

## 四、群聊：从创建到进入

创建群聊是两个页面的接力：选好友页（`create_group_view.dart`）→ 群设置页（`create_group_setup_view.dart`）。"发起会话"也复用选好友页，只是 `convType=single` 时行为变成单选好友、直接建 C2C 会话（`_createSingleConversation`：`conversationID = "c2c_$userID"`，查会话失败就用 `V2TimConversation` 手动构造兜底）。

### 4.1 设置页的三个设计决定

`create_group_setup_controller.dart` 的 `onReady` 和 `onTapSure` 集中了三个关键决定：

```dart
// create_group_setup_controller.dart
@override
void onReady() {
  ...
  groupName.value = arg?["groupName"] as String? ?? "群聊";
  groupId.value = StringExt.generateRandomString(length: 12).toUpperCase();
  friends.addAll(arg?['data'] as List<V2TimFriendInfo>? ?? []);
}

void onTapGroupType() async {
  showToast("群类型无法修改");
}
```

**第一个决定：groupID 客户端生成，随机 12 位大写。** 腾讯云允许创建群时指定群 ID（不传则由服务端生成 `@TGS#_` 前缀的系统 ID）。这里用 `generateRandomString(length: 12).toUpperCase()` 生成可读性好的群 ID。群 ID 有格式约束（错误码 8501：长度上限 48 字节、只能数字和字母），12 位大写字母和数字既满足格式又便于传播——群 ID 会被展示在群资料页（"ID:xxx"）、写进二维码。不自己生成会怎样：系统 ID 形如 `@TGS#_xxx`，展示和传播体验都很差。

**第二个决定：群类型创建时锁定。** 点击群类型直接 toast"群类型无法修改"。群类型（Public/Work/Meeting/Community）决定了一整套能力差异（加群方式、禁言能力、解散条件），创建后不允许变更，避免在运营中偷偷改变群性质。

**第三个决定：成员角色映射。** 代码里有两套角色类型并存：

```dart
// create_group_setup_controller.dart
const groupType = GroupType.Public; // 项目只开放 Public 公开群
final groupMember = friends.map((e) {
  final role = e.userProfile!.role!;                 // int 常量（200/300/400）
  GroupMemberRoleTypeEnum roleEnum = GroupMemberRoleTypeEnum
      .V2TIM_GROUP_MEMBER_UNDEFINED;
  switch (role) {
    case GroupMemberRoleType.V2TIM_GROUP_MEMBER_ROLE_ADMIN:
      roleEnum = GroupMemberRoleTypeEnum.V2TIM_GROUP_MEMBER_ROLE_ADMIN;
      break;
    case GroupMemberRoleType.V2TIM_GROUP_MEMBER_ROLE_MEMBER:
      roleEnum = GroupMemberRoleTypeEnum.V2TIM_GROUP_MEMBER_ROLE_MEMBER;
      break;
    case GroupMemberRoleType.V2TIM_GROUP_MEMBER_ROLE_OWNER:
      roleEnum = GroupMemberRoleTypeEnum.V2TIM_GROUP_MEMBER_ROLE_OWNER;
      break;
    default:
      roleEnum = GroupMemberRoleTypeEnum.V2TIM_GROUP_MEMBER_UNDEFINED;
  }
  return V2TimGroupMember(role: roleEnum, userID: e.userID);
}).toList();
```

`GroupMemberRoleType` 是 int 常量（MEMBER=200、ADMIN=300、OWNER=400），`GroupMemberRoleTypeEnum` 是 Dart 枚举，`V2TimGroupMember` 的 role 字段要枚举类型。创建群时把被邀请成员的角色映射进 memberList，是为了**保留管理员的初始身份**：如果被邀请的好友在别的群是管理员，这里显式映射 ADMIN，让他在新群里也以管理员身份入群。不映射会怎样：`V2TimGroupMember` 直接传 int 编译不过，或者漏掉某个分支被 `!` 强解包炸掉——注意这里 `e.userProfile!.role!` 是双重强解包，资料拉取失败或 role 为空时会直接崩溃，稳健写法是判空后按普通成员处理。角色映射里最危险的其实是误用：`role` 来自好友资料，它的语义是"该用户在其所在群的角色"，不是"新群里的角色"。对创建群这个场景，显式映射恰好就是"我指定你以什么身份入群"，语义是对的。

### 4.2 创建成功后的四步动作

```dart
// create_group_setup_controller.dart
final res = await ...createGroup(
    groupID: groupId.value.isNotEmpty ? groupId.value : null,
    groupType: groupType,
    groupName: ...,
    faceUrl: ...,
    memberList: groupMember);
if (res.code == 0) {
  final groupID = res.data;
  final conversationID = "group_$groupID";
  final convRes = await ...getConversation(conversationID: conversationID);
  if (convRes.code == 0) {
    await _sendMessageToNewlyCreatedGroup(groupType, groupID!);
    final conversation = convRes.data ?? V2TimConversation(
        conversationID: conversationID, type: 2, showName: groupName.value,
        groupType: groupType, groupID: groupID);
    conversation.showName ??= groupName.value;
    if (uniqueId != null) {
      BoostNavigator.instance.remove(uniqueId); // 移除选好友页
    }
    ImManager().tempApproveOpt(groupID, groupType);
    BoostNavigator.instance.pushReplacement(RouteConfigKey.chat,
        arguments: {"conversation": conversation});
  }
}
```

1. **createGroup 成功后 getConversation**。刚建的群未必立刻有会话对象，所以先查一次；查不到就用 `V2TimConversation` 手动构造（conversationID、type=2、showName、groupType、groupID）兜底——保证立刻能进聊天页，不依赖 SDK 的会话同步时序。
2. **发一条"创建群组"系统消息**（下面展开）。
3. **remove(uniqueId) 移除选好友页**，再 pushReplacement 聊天页——和用户详情页"清理栈"是同一个思路：进群后的返回路径必须干净。
4. **tempApproveOpt 设置邀请进群方式**：

```dart
// im_manager.dart
/// 修改邀请进群的方式
void tempApproveOpt(String groupID, String groupType) async {
  V2TimGroupInfo v2timGroupInfo =
      V2TimGroupInfo(groupID: groupID, groupType: groupType);
  v2timGroupInfo.approveOpt = 1; // 对应 V2TIM_GROUP_ADD_AUTH：管理员审批
  final response = await _groupServices.setGroupInfo(info: v2timGroupInfo);
}
```

新群默认"邀请进群"是管理员审批——防止群刚建好就被邀请者随意拉人，把审核权握在群主手里。群资料页的"邀请加群方式"（`groupApproveModeBarWidget`）后续可以改回自动审批/禁止邀请，这条路径在第六节权限部分再说。

### 4.3 group_create：系统操作消息，不是聊天消息

```dart
// create_group_setup_controller.dart
_sendMessageToNewlyCreatedGroup(String groupType, String groupID) async {
  final loginUserInfo = ImManager.coreInstance.loginUserInfo;
  V2TimMsgCreateInfoResult? res =
      await ImManager.messageService.createCustomMessage(data: json.encode({
    "businessID": "group_create",
    "version": 4,
    "opUser": loginUserInfo?.nickName ?? loginUserInfo!.userID,
    "content": "创建群组",
    "cmd": 0
  }));
  if (res != null) {
    await ImManager.messageService.sendMessage(
        id: res.id!, groupID: groupID, receiver: '');
  }
}
```

创建成功后立刻向新群发一条 `businessID=group_create` 的自定义消息，聊天页的 `customMessageItemBuilder` 把它渲染成**居中提示**而不是气泡：

```dart
// chat_view.dart
case ChatCustomMsgBusinessID.createGroup:
  return Row(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      FittedBox(child: Text("`${customMsgModel.opUser ?? ""}` ", ...)),
      Text("创建群组", style: ...),
    ],
  );
```

这一条消息有两个作用：群里所有人（包括后加入的）在消息流里都能看到"谁创建了这个群"的轨迹；`opUser` 取自 `loginUserInfo.nickName ?? userID`，昵称为空时退化显示 userID，保证有值可渲染。

这里要分清"系统操作消息"和红包那种自定义消息的区别：**`group_create` 是客户端发起、纯展示、无状态的自定义消息**，没有业务实体，不需要服务端参与，渲染成居中文案即可；**红包（详见 28-IM即时通讯与红包自定义消息篇）是带资金状态的自定义消息**，卡片背后有服务端实体、领取状态、幂等与对账。同样是自定义消息，一个是"操作通告"，一个是"业务载体"。决定一条自定义消息落在哪一边，看它有没有"状态需要多端一致"：没有，就按 group_create 这种最简模式做；有，就得按红包那套协议设计走。

### 4.4 进群的其他路径

创建群只是入口之一，入群还有三条路，全部由 TUIKit 组件承接：

| 路径 | 组件 | 项目接线 |
|---|---|---|
| 贴群 ID / 扫群二维码 | `TIMUIKitAddGroup`（add_group_view） | 扫码场景带 `{"groupID": gid}` 参数进入，直接预填 |
| 处理入群申请 | `TIMUIKitGroupApplicationList`（group_application_list） | 聊天页 `onDealWithGroupApplication` 回调携带 groupID 进入 |
| 查看我加入的群 | `TIMUIKitGroup`（group_list_view） | `groupCollector` 过滤 `im_discuss_` 前缀的讨论组 |

`group_list_view.dart` 里 `groupCollector: (groupInfo) => !groupID.contains("im_discuss_")` 是 TUIKit 的"收集器"用法：`TIMUIKitGroup` 默认展示我加入的全部群组，讨论组（`im_discuss_` 前缀）不满足产品的"群"定义，用收集器过滤掉。点击群项时先 `getConversation(conversationID: "group_$groupID")` 再进聊天页，`conversation.showName ??= groupInfo.groupName` 兜底标题——和创建群的兜底逻辑同构。

入群申请的入口在聊天页：`onDealWithGroupApplication: (groupID) => push(groupApplicationList, arguments: {"groupID": groupID})`。这个回调是 TUIKit 聊天页在"有入群申请"时挂出的横幅按钮，业务只需要把它接到申请列表页。申请的处理（同意/拒绝）完全由 `TIMUIKitGroupApplicationList` 内置逻辑完成。

## 五、群成员管理

群成员列表是项目自研投入最大的页面（`member_list_controller.dart` + `member_list_view.dart`），因为它有三个 TUIKit 没有的诉求：**群主/管理员置顶分组、拼音索引、服务端搜索**。

### 5.1 三批拉取 + 游标分页

`member_list_controller.dart` 把成员分成三批拉：

```dart
// member_list_controller.dart
Future<List<V2TimGroupMemberFullInfo>> loadGroupMgrMemberList({int count = 100}) async {
  final ownRes = await groupManager.getGroupMemberList(
      groupID: groupID,
      filter: GroupMemberFilterTypeEnum.V2TIM_GROUP_MEMBER_FILTER_OWNER,
      count: 100, nextSeq: "0");
  final mgrRes = await groupManager.getGroupMemberList(
      groupID: groupID,
      filter: GroupMemberFilterTypeEnum.V2TIM_GROUP_MEMBER_FILTER_ADMIN,
      count: 100, nextSeq: "0");
  // 群主 + 管理员 合并进 mgrList
  ...
}

Future<String?> loadGroupMemberListV3({int count = 100}) async {
  _nextSeq = "0";
  final merList = await loadGroupMgrMemberList();
  final res = await groupManager.getGroupMemberList(
      groupID: groupID,
      filter: GroupMemberFilterTypeEnum.V2TIM_GROUP_MEMBER_FILTER_COMMON,
      nextSeq: _nextSeq);
  if (res.code == 0) {
    merList.addAll(res.data?.memberInfoList ?? []);
    _nextSeq = res.data?.nextSeq ?? "0";
  }
  dataList = merList;
  azShowList.value = _handleShowList(dataList);
  return res.data?.nextSeq;
}

Future<String?> loadGroupMemberListV3Next({int count = 100}) async {
  final res = await groupManager.getGroupMemberList(
      groupID: groupID,
      filter: GroupMemberFilterTypeEnum.V2TIM_GROUP_MEMBER_FILTER_COMMON,
      count: count, nextSeq: _nextSeq);
  ...
  return res.data?.nextSeq;
}
```

为什么拆三批而不是一次 `FILTER_COMMON` 拉全量：

- **群主/管理员数量少且固定**（管理员上限 10），一次 100 条足够，不需要分页。
- **普通成员可能上千**（Public 群上限 2000），必须游标分页，`nextSeq` 由服务端返回、客户端原样回传。
- 三批合并后才能给"群主/管理员置顶"提供数据基础——如果只拉 COMMON，置顶组就永远是空的。

分页的结束条件是一个容易写错的地方，放到第八节"常见错误"里专门讲。

### 5.2 排序：@ 组置顶、拼音索引、# 组垫底

`_handleShowList` 是成员列表的排序核心，它给每个成员打一个"索引标签"：

```dart
// member_list_controller.dart
for (var i = 0; i < allList.length; i++) {
  final item = allList[i];
  final showName = _getShowName(item); // friendRemark → nameCard → nickName → userID
  if (item.role == GroupMemberRoleType.V2TIM_GROUP_MEMBER_ROLE_OWNER ||
      item.role == GroupMemberRoleType.V2TIM_GROUP_MEMBER_ROLE_ADMIN) {
    showList.add(SuspensionBeanImpl(memberInfo: item, tagIndex: "@", originalIndex: i));
  } else {
    String pinyin = PinyinHelper.getPinyinE(showName); // lpinyin 转拼音
    String tag = pinyin.substring(0, 1).toUpperCase();
    if (RegExp("[A-Z]").hasMatch(tag)) {
      showList.add(SuspensionBeanImpl(memberInfo: item, tagIndex: tag, originalIndex: i));
    } else {
      showList.add(SuspensionBeanImpl(memberInfo: item, tagIndex: "#", originalIndex: i));
    }
  }
}
```

排序规则分三级，`sort` 比较器里写得很直白：

1. `@`（群主、管理员）排最前；
2. `#`（非字母开头，如中文名、数字、emoji）排最后；
3. 字母组按拼音首字母排序，`@` 内部和 `#` 内部按 `originalIndex` 保持原始顺序。

`originalIndex` 是刻意加的字段：同一标签内部不重新排序，避免"每次进页面成员顺序都在跳"。中文名的拼音用 `lpinyin` 的 `PinyinHelper.getPinyinE` 转换后取首字母——不转拼音直接按中文排序的话，索引条会显示一串中文，无法建立"字母索引"心智。UI 层把 `@` 标签显示成"群主、管理员"（`susItemBuilder`），成员行内用彩色角标标出群主（橙色）和管理员（蓝色）。

### 5.3 服务端搜索：防抖 + 多字段

搜索没有走本地过滤，而是调 SDK 的 `searchGroupMembers`（服务端搜索）：

```dart
// member_list_controller.dart
_searchWorker = debounce(searchKey, (value) { searchAction(); },
    time: const Duration(seconds: 1));

void searchAction() async {
  final text = searchKey.value.trim();
  if (text.isEmpty) return;
  V2TimGroupMemberSearchParam param = V2TimGroupMemberSearchParam(
      groupIDList: [groupID],
      isSearchMemberNameCard: true,
      isSearchMemberRemark: true,
      isSearchMemberNickName: true,
      isSearchMemberUserID: true,
      keywordList: [text]);
  final res = await ImManager.groupManager.searchGroupMembers(param: param);
  final data = res.data?.groupMemberSearchResultItems?[groupID];
  ...
  searchDataList.value = newList;
}
```

两个设计点：**1 秒 debounce**（GetX 的 `debounce` worker）防止每敲一个字符就发一次请求；**四字段全开**（群昵称 nameCard/备注 remark/昵称 nickName/userID），保证任何记忆碎片都能搜到人。搜索结果是按 groupID 分组的 `groupMemberSearchResultItems[groupID]`，因为 searchGroupMembers 支持跨群搜索，这里只取当前群的。成员点击统一进用户详情页，带 `groupPush: true` 标记（第五节说的"群内添加好友未开放"就靠这个标记）。

### 5.4 删除成员：只能删普通成员，最多 20 个

删除成员页（`member_delete_controller.dart`）是成员列表的"受限子集"：

```dart
// member_delete_controller.dart
// 只拉普通成员——群主/管理员在数据源层面就被排除
final res = await groupManager.getGroupMemberList(
    groupID: groupID,
    filter: GroupMemberFilterTypeEnum.V2TIM_GROUP_MEMBER_FILTER_COMMON,
    nextSeq: _nextSeq);

// 搜索时也过滤只保留普通成员
newList = newList
    .where((v) => v.role == GroupMemberRoleType.V2TIM_GROUP_MEMBER_ROLE_MEMBER)
    .toList();

void onTapPickItem(V2TimGroupMemberFullInfo model) {
  ...
  if (pickList.length >= 20) {
    AppLogger.i("单次删除不超过20个");
    return;
  }
  pickList.add(model);
}

void onTapSubmitAction() async {
  ...
  final rmIds = pickList.map((v) => v.userID).toList();
  final res = await ImManager.groupManager
      .kickGroupMember(groupID: groupID, memberList: rmIds);
  if (res.code != 0) { showToast("删除群成员失败"); return; }
  showToast("删除群成员成功");
  BoostNavigator.instance.pop(true); // 带结果返回
}
```

这里有两层"误删保护"，值得在面试里讲清楚：

- **数据源层**：列表接口直接 `FILTER_COMMON`，群主和管理员根本不会出现在可选列表里——不是"禁止勾选"，而是"不存在"。管理员不能删管理员、不能删群主，这是 SDK 权限模型的要求（群主/管理员只能踢普通成员）。
- **交互层**：搜索结果的过滤再补一道 `role == MEMBER`，防止搜索接口返回了非普通成员。
- **批量上限 20**：勾选超过 20 人直接 return，单次踢人请求控制在服务端接受范围内。

踢人成功后 `pop(true)` 带结果返回，群资料页的 `onTapMemberDel` 拿到 `true` 后刷新成员数据：

```dart
// group_profile_controller.dart
final res = await BoostNavigator.instance
    .push(RouteConfigKey.groupMemberDel, arguments: {"groupID": groupID});
if (res != null && res == true) {
  gModel.loadGroupMemberListV3();
  await Future.delayed(const Duration(milliseconds: 300));
  gModel.loadGroupInfo(groupID); // 成员数、群资料一起刷
}
```

成员列表和群信息都刷，因为踢人后成员数和群资料页头部的成员缩略图都会变。这里 `Future.delayed(300ms)` 是给 TUIKit 内部状态更新的喘息时间——一个粗糙但实用的时序补偿。

## 六、群主与禁言：权限矩阵与 TUIKit 群管理

### 6.1 权限矩阵

把项目里所有入口摊开，对照 SDK/TUIKit 的权限模型，得到这张矩阵（面试常考）：

| 操作 | 群主 | 管理员 | 普通成员 | 实现来源 |
|---|---|---|---|---|
| 创建群 | ✅（需实名） | ✅（需实名） | ✅（需实名） | 项目入口 |
| 解散群 | ✅ | ❌ | ❌ | TUIKit 按钮区按 owner 显隐（SDK 约定） |
| 转让群主 | ✅（Public 群） | ❌ | ❌ | TUIKit 按钮区提供（SDK 约定） |
| 设置/取消管理员 | ✅（上限 10） | ❌ | ❌ | TUIKit 群管理页（SDK 约定） |
| 删除群成员（踢人） | ✅ 仅普通成员 | ✅ 仅普通成员 | ❌ | 项目自研入口，数据源层过滤 |
| 设置/解除成员禁言 | ✅ 仅普通成员 | ✅ 仅普通成员 | ❌ | TUIKit 群管理页（SDK 约定） |
| 全员禁言 | ✅ | ✅ | ❌ | TUIKit 群管理页开关（SDK 约定） |
| 修改群资料（群名/头像/公告） | ✅ | ✅ | ❌ | TUIKit 权限 + 项目 detailCard 双重显隐 |
| 撤回消息 | ✅ 可撤他人 | ✅ 可撤他人（`isGroupAdminRecallEnabled`） | 仅自己 | 项目 TIMUIKitChatConfig |
| 退出群 | ✅（先转让或解散） | ✅ | ✅ | TUIKit；SDK 错误码 20052 群主不能退出 |
| 主动加群方式/邀请加群方式 | ✅ | ✅ | ❌ | TUIKit groupJoiningModeBar/groupApproveModeBar |
| 我的群昵称 | ✅ 自己 | ✅ 自己 | ✅ 自己 | TUIKit nameCardBar |

三个要点：

1. **客户端显隐不是权限本身，SDK 才是真边界**。UI 上"群主才看得到解散按钮"只是体验层；真正拦人（比如普通成员直接调 `dismissGroup`）的是 IM 服务端，失败会回错误码（10007 群组权限被拒绝、20041 无权限操作）。所以权限矩阵的每一行都要回答两件事：入口在哪（客户端）、拦不拦得住（服务端）。
2. **项目隐藏与暴露**。TUIKit 的群资料页自带完整的群管理能力（群管理入口、管理员设置、禁言、退出/解散/转让）。项目叠加了三个自研入口：群二维码、举报（type=1）、成员列表与删除成员。同时项目**隐藏**了两个 TUIKit 默认能力：成员列表项上的"设为管理员/禁言/踢出该群聊"更多操作（`member_list_controller.dart` 里 `moreAction` 整段注释）、群资料页的"查找聊天内容"（`searchMessage` 注释）。隐藏的理由是收敛入口：群管理统一走群资料页，避免同一操作在两个页面重复出现导致权限判断不一致。转让群主没有自研入口，走 TUIKit 按钮区提供的能力（Public 群群主可见"转让群主"），只通过权限模型呈现，不在项目里重复实现。
3. **"我是群主"的判定方式**。群资料页按钮区用 `groupInfo.owner == User.inviteCode` 判断（owner 的 userID 与本地用户邀请码比较），成员列表用 `groupInfo?.role == OWNER` 判断——两种判断分别适用于"对比他人"和"判断自己"，混用会出错：role 是"我在群里的角色"，owner 字段是群主的 ID。

### 6.2 TUIKit 群管理：全员禁言与成员禁言

群资料页的"群管理"入口指向 TUIKit 的 `tim_uikit_group_manage.dart`（`GroupProfileGroupManagePage`），项目没有重写，只透传：

```dart
// group_profile_view.dart
groupManage: groupManageWidget, // 自研 UI 行，onTap 回调 toDefaultGroupManagementPage
```

TUIKit 群管理页覆盖三块：

1. **设置管理员**（`GroupProfileSetManagerPage`）：群主页签展示群主，管理员页签展示管理员（上限 10，"管理员 (n/10)"），可添加/取消管理员。添加时只允许选普通成员，取消管理员用 `setMemberToNormal`。
2. **全员禁言**：一个 `CupertinoSwitch`，绑 `isAllMuted`，改动调 `model.setMuteAll(value)`。文案"全员禁言开启后，只允许群主和管理员发言。"——这是产品语义，实现上就是群内所有非管理员成员的发言被服务端拦截。
3. **成员禁言**："添加需要禁言的群成员"进入 `GroupProfileAddAdmin`（waitMute 模式），列表只显示**普通成员且未在禁言中**的成员（`!isMute && isMember`），选中后逐个调 `muteGroupMember(userID, true, serverTime)`。已禁言成员在列表里展示，滑动可"删除"（解除禁言）。

禁言的实现细节值得记一笔：`muteGroupMember` 传的 `serverTime` 是**禁言到期时间戳（秒）**，来自 `getServerTime()`——客户端本地时间不可信，会被用户改时间绕过禁言，所以到期判断用服务端时间。解除禁言传 `false` 和同样的 `serverTime`。TUIKit 里对"是否在禁言中"的判断：`(element?.muteUntil ?? 0) > serverTime`。

另外注意 `isAllowMuteMember = groupType != Work`：工作群不支持成员禁言（SDK 对 Work 群的约束），UI 直接不渲染禁言入口——这印证了第六节开头那句"群类型锁定不可改"的意义：类型定了，能力边界就定了。

### 6.3 禁言的输入区提示与错误码联动

禁言不是只在设置页存在，它要在**被禁言的人这边**有感知。输入区的提示来自 TUIKit 的 `tim_uikit_text_field.dart`：

```dart
// tim_uikit_text_field.dart（TUIKit 内部，精简）
String? getForbiddenText() {
  if (!(model.isGroupExist)) return "群组不存在";
  else if (model.isNotAMember) return "您不是群成员";
  else if (muteStatus == MuteStatus.all) return "全员禁言中";
  else if (muteStatus == MuteStatus.me) return "您被禁言";
  return null;
}
```

`muteStatus` 的判定逻辑：群主/管理员永远不算被禁言（`willNotBeenMuted` 直接短路）；普通成员看 `groupInfo.isAllMuted`（全员禁言）或自己的 `muteUntil`（成员禁言）。输入区显示"全员禁言中/您被禁言"时，输入框被替换成提示条，根本没法打字。

如果禁言状态和本地数据有时差（比如刚被禁言、群资料还没同步），发送会直接失败，错误码由 `im_error_code_toast.dart` 翻译成用户话术：

| 错误码 | 文案 | 场景 |
|---|---|---|
| 20012 / 20049 | 您已被禁言 | 成员禁言后尝试发消息 |
| 20050 | 群已被禁言 | 全员禁言后尝试发消息 |
| 10017 | 群组禁言 | 群级禁言（服务端侧） |
| 20041 | 无权限操作 | 普通成员调用管理接口 |
| 20052 | 群主不能退出群 | 群主点退出（SDK 拦截） |
| 20007 | 被拉黑，无法发送消息 | 黑名单关系下的发送 |

三层防护层层递进：**输入区提示（预防）→ 发送失败错误码（兜底）→ 群管理设置（治理）**。前端只做前两层，第三层是管理员的权限。消息免打扰（`recvOpt==2`）与音效联动在 26 篇讲音效时已经覆盖，群资料页的"消息免打扰"开关（`muteGroupMessageBarWidget`）和用户详情页的对应开关都是 TUIKit 能力，本篇不重复展开。

## 七、搜索与消息管理

搜索是 IM 主题里的"统一入口"问题。会话列表顶部的搜索框和通讯录里的搜索框都指向 `search_im_view.dart`：

```dart
// search_im_view.dart
TIMUIKitSearch(
  onBack: () { BoostNavigator.instance.pop(); },
  onTapConversation: (conversation, msg) {
    BoostNavigator.instance.pushReplacement(RouteConfigKey.chat,
        arguments: {'conversation': conversation});
  },
  onEnterSearchInConversation: (conversation, initKeyword) {
    BoostNavigator.instance.pushReplacement(RouteConfigKey.chat,
        arguments: {'conversation': conversation});
  },
)
```

`TIMUIKitSearch` 把五类搜索（会话、联系人、群组、群成员、历史消息）全部包在组件内部，底层是 SDK 的搜索接口 + 适配层兜底，业务只负责两个回调：搜索命中会话后进聊天页。搜索命中后 `pushReplacement` 而不是 push——从搜索结果进聊天页，返回应该回到搜索前的页面，而不是搜索页。这个"替换而非压栈"的细节和用户详情页发送消息、创建群成功后进聊天页是同一个返回路径原则。

群资料页的"查找聊天内容"（群内历史消息搜索）入口在项目里被注释掉了（`group_profile_view.dart` 的 `searchMessage` 区块），与成员列表的 `moreAction` 一样属于"隐藏的 TUIKit 能力"——统一由顶部搜索承担，避免搜索能力碎片化。

消息管理（免打扰、置顶、清空记录、删除会话）在用户详情页/群资料页都有对应区块，全部由 TUIKit 提供，项目只做了 UI 包装。唯一业务自研的清空逻辑是 `clearC2CHistoryMessage`（单聊），群内清空走 TUIKit 的 `clearHistory`。

## 八、常见错误与修正

把项目里踩过的坑和容易踩的坑归纳成一张表（以源码现状为准，标注修正方向）：

| 问题 | 现象 | 原因 | 修正 |
|---|---|---|---|
| 导航栈不清理 | 从扫一扫→用户详情→聊天页后，返回键一层层退回扫码页 | push 聊天页保留了中间页 | 发送消息/创建群成功前 remove 非白名单页，pushReplacement 进聊天页 |
| 分页游标误判结束 | 大群滚动加载停不下来或反复请求 | 腾讯云约定 `nextSeq` 返回**空字符串**表示没有更多，实现用初值 `"0"` 比较 | 以 `nextSeq == ""` 作为结束条件；代码中 `_hasMore = newSeq != null && newSeq != "0"` 是保守写法，需与服务端实际返回对齐 |
| 角色类型两套并存 | `V2TimGroupMember` 传错类型编译失败，或 `role!` 强解包崩溃 | `GroupMemberRoleType` 是 int 常量、`GroupMemberRoleTypeEnum` 是枚举，createGroup 需要枚举 | 显式 switch 映射；`userProfile!.role!` 加判空，空值按普通成员处理 |
| 群主/管理员被误删 | 管理员出现在删除列表里 | 删除页拉了全量成员 | 删除页数据源直接 `FILTER_COMMON`，搜索再补 `role == MEMBER` 过滤，双保险 |
| "我是群主"判断混用 | 转让/解散入口显隐异常 | `groupInfo.owner == User.inviteCode`（对比）与 `groupInfo.role == OWNER`（自判）语义不同 | 判定自己用 role，判定他人用 owner 字段 |
| 枚举 values[index] 越界 | 好友申请监听偶发崩溃 | `FriendApplicationTypeEnum.values[application.type]` 对未知类型越界 | 处理见 26 篇已述的枚举安全取值方案，本篇不再展开 |
| 扫码协议不校验 | 群二维码解析崩溃或误入错误页面 | `split(";")` 后直接取下标 | 先校验 `list.length < 3` 再取 `list[1]`；非 http/groupqr 前缀一律"请扫描正确的邀请码" |
| 创建群后无会话可进 | 进聊天页黑屏或空标题 | SDK 会话同步有延迟 | getConversation 失败用 `V2TimConversation` 手动构造兜底，showName 用群名填充 |
| 空昵称成员索引错乱 | 成员列表出现空索引标签 | 中文/emoji/空名取拼音首字母失败 | `_getShowName` 四级回退链保证有值；非字母打 `#` 组 |
| 踢人后资料不刷新 | 成员数还是旧值 | 只刷了列表没刷群信息 | `pop(true)` 回传结果，群资料页成功后 `loadGroupMemberListV3 + loadGroupInfo` 双刷新 |

这些坑的共同根源是一个原则：**IM 的本地状态是"可能过期"的**。会话可能还没同步、角色可能刚变、禁言可能刚设置——所有依赖本地状态的判断都要有兜底（手动构造会话、错误码翻译、成功后强制刷新），所有服务端才是真值的判断（权限、角色、游标结束）都要向服务端对齐。

## 九、验收清单与测试

| 场景 | 验证点 | 预期结果 |
|---|---|---|
| 创建群成功路径 | 选 2 个好友 → 设置页 → 创建 | 群会话立即打开；群内出现居中"xxx 创建群组"提示；返回落在会话列表；群资料"邀请加群方式"为管理员审批 |
| 群类型锁定 | 设置页点群类型 | toast"群类型无法修改"，页面不跳转 |
| 群主操作边界 | 群主打开群资料页 | 可见：群管理、删除群成员、转让群主（Public）、解散群组；成员列表"群主/管理员"置顶于 @ 组 |
| 管理员操作边界 | 管理员打开群资料页 | 可见：群管理、删除群成员；不可见：转让群主、解散群组；删除成员页列表只含普通成员 |
| 普通成员操作边界 | 普通成员打开群资料页 | 不可见：群管理入口、删除成员入口；按钮区只有清空消息/退出群组 |
| 全员禁言 | 群管理开全员禁言 → 普通成员发消息 | 输入区变"全员禁言中"；强行发送失败提示"群已被禁言"（20050）；群主/管理员仍可发言 |
| 成员禁言 | 禁言某普通成员 → 该成员发消息 | 输入区变"您被禁言"；到期（服务端时间）后自动恢复可发言 |
| 删除成员 | 勾选 3 人踢出 | 成功 toast；群资料成员数与成员列表同步刷新；被踢成员收"您已被移出群聊"（20048） |
| 批量上限 | 勾选第 21 人 | 无反应（单次不超过 20），已勾选保持 |
| 好友申请流 | A 搜索加 B → B 处理 | A 通讯录出现 B；B 通讯录"新的朋友"红点出现与消除跟随 unreadCount |
| 实名/签到门禁 | 未签到点通讯录；未实名点创建群聊 | 弹签到弹窗可跳 Tab2；toast"请先进行实名"并跳实名页 |
| 扫码分发 | 扫 http 邀请码 / groupqr 群码 / 乱码 | 分别进用户详情 / 添加群聊（带 groupID）/ 提示"请扫描正确的邀请码" |
| 成员搜索 | 输入昵称/备注/ID 片段 | 1 秒防抖后出结果；清空输入恢复索引列表 |
| 大群分页 | 滚到底部 | 触发加载下一页；到末尾后不再请求 |

单元测试层面，成员排序（@ 置顶、# 垫底、字母序）和 `_getShowName` 回退链是纯函数，可以直接抽出来测；`_checkSign`、实名 gate、栈清理属于 Boost/GetX 集成逻辑，用集成测试覆盖"发送消息后返回路径"一条用例即可。适配层的 `friednAddCount` 更新可以在注入 Fake FriendshipManager 后断言。

## 十、面试问答

### Q1：TIMUIKitContact、TIMUIKitAddFriend 这类"自带业务逻辑"的组件，和自研页面如何共存？

按"复用边界"分三种形态：纯复用（通讯录、加好友、新朋友、黑名单直接嵌入组件，只接路由和空态）、混合（群资料页、聊天页用 TUIKit 组件 + 自研区块/回调，如 customBuilder、onDealWithGroupApplication）、自研（用户详情页的业务按钮、成员列表的三批拉取与排序）。选择标准是：TUIKit 覆盖且不需要差异化 → 纯复用；需要业务入口或业务按钮 → 混合；TUIKit 没有的能力 → 自研。自研不是"造轮子"，是把组件给不了的业务语义（举报、删除成员、群二维码）补上。

### Q2：成员列表为什么要拆群主/管理员/普通成员三批拉取，再游标分页？

因为两类数据形态不同：群主与管理员数量少（管理员上限 10）、必须展示在置顶的 @ 组，一次拉 100 条即可且不参与分页；普通成员最多 2000 人，必须用服务端游标分页。三批合并后，"@ 组置顶"才有一份完整的角色数据可用。如果只调一次 `FILTER_COMMON` 拉全量，置顶组会缺失，分页也会让"@ 组"和普通成员交错，排序没法做。

### Q3：群主/管理员/普通成员的权限，靠客户端隐藏按钮够吗？

不够。客户端显隐只是体验层，真正的权限边界是 IM 服务端：普通成员即使绕开 UI 直接调 `dismissGroup`、`kickGroupMember`，服务端也会回 10007/20041 之类的错误码。所以客户端的按钮显隐只负责"别让用户点到做不了的事"，服务端负责"拦得住"。这也是为什么删除成员页要在数据源层过滤普通成员——双保险，而不是只靠 UI 禁止勾选。

### Q4：创建群成功后为什么要发一条 group_create 自定义消息？它和红包自定义消息有什么区别？

作用有两个：新群消息流里有"谁创建了群"的可见轨迹（对后加入的成员尤其重要）；它验证了创建成功后整条消息通道可用。它是"系统操作消息"模式：客户端发起、纯展示、无状态、渲染成居中提示。红包（详见 28-IM即时通讯与红包自定义消息篇）是另一种模式：带资金状态、服务端是唯一真值、需要幂等与对账。判断一条自定义消息用哪种模式，看它有没有"需要多端一致的状态"。

### Q5：被禁言的用户会看到什么？禁言状态从哪来？

三层联动：输入区提示（TUIKit 根据 `isAllMuted` 和 `muteUntil` 把输入框换成"全员禁言中/您被禁言"）、发送失败错误码（20012/20049/20050/10017 由 im_error_code_toast 翻译）、群管理设置（群主/管理员在 TUIKit 群管理页设置与解除）。到期时间用服务端时间（`getServerTime`）而非本地时间，防止改系统时间绕过禁言；群主/管理员在判定中直接短路，永远不显示禁言提示。

## 总结

好友体系是"复用成熟组件"的范本：TUIKit 覆盖度高的页面几乎零代码，业务只接路由、空态和未读数；真正的自研投入在 TUIKit 给不了的地方——用户详情页的业务按钮、成员列表的拉取与排序、权限门禁。

群管理把两个问题暴露得最清楚：

1. **权限问题**：谁能在 UI 上看到什么、SDK 服务端实际放行什么，是两层边界。客户端负责显隐与入口收敛，服务端负责真正拦截；删除成员的双重过滤、群类型的创建时锁定，都是"把权限钉死在数据源层"的做法。
2. **状态同步问题**：成员列表的分页游标、创建群后的会话兜底、踢人后的双刷新、禁言的输入区与错误码联动——本地 IM 状态随时可能过期，每一次读本地状态都要想"过期了怎么办"。

如果只带走一条经验：**凡是"多端一致"的状态（角色、禁言、成员关系），本地都只是缓存，UI 可以按缓存渲染，判断必须向服务端对齐；凡是"仅展示"的语义（群创建提示），才适合用自定义消息这种最轻的模型。**

## 参考资料

- [Tencent Cloud Chat：Flutter SDK API 概览](https://trtc.io/document/40124?menulabel=core+sdk&platform=flutter&product=chat)
- [Tencent Cloud Chat：登录](https://trtc.io/document/47971)
- [tencent_cloud_chat_uikit（pub.dev）](https://pub.dev/packages/tencent_cloud_chat_uikit)
- [Tencent Cloud Chat：错误码文档](https://cloud.tencent.com/document/product/269/1671)（`fake_docs/widgets/im_error_code_toast.dart` 的文案来源）
