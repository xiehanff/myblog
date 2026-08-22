---
title: Flutter 企业开发实践11-支付对接
date: 2026-05-18
tags: [Flutter, 面试, 架构, 支付, 微信支付, 支付宝, IAP, 幂等性, 对账, fluwx, tobias]
---

# 支付对接

> 支付是 App 最核心的商业化链路，也是最容不得出错的环节——钱的问题没有"小 bug"。本篇从架构师视角拆解微信支付、支付宝、iOS 内购的接入差异，以及支付回调幂等、掉单处理、对账等工程级问题的解决方案。

---

## 概述：支付对接解决什么问题？

支付对接的核心挑战不是"调起支付页面"，而是**保证资金流和信息流的一致性**。用户付了钱但 App 没到账，或者 App 到了账但服务端没记录，都是生产事故。

三个支付渠道的技术差异：

| 维度 | 微信支付 | 支付宝 | iOS 内购 (IAP) |
|------|---------|--------|---------------|
| 支付端 | App → 微信 App → 回调 | App 内 SDK → 回调 | App → App Store → 回调 |
| 回调机制 | 服务端异步通知 + App 端回调 | 服务端异步通知 + App 端回调 | 客户端送验 + Notifications V2 + Server API 对账 |
| 订单归属 | 服务端创建 | 服务端创建 | App Store 创建 |
| 审核约束 | 无 | 无 | 必须走 IAP，不允许第三方支付 |
| 退款 | 服务端处理 | 服务端处理 | Apple 管理，App 无法主动退款 |
| 抽成 | 无 | 无 | 30%（小企业 15%） |

本篇示例大量取自某已上线半年的 Flutter 混合开发项目（iOS 原生宿主 + Flutter module）：微信用 fluwx 5.7.2（本地 fork，仅 Android 启用支付、iOS 编译期裁剪），支付宝用 tobias 5.2.0，IAP 用 in_app_purchase ^3.1.13 + in_app_purchase_storekit ^0.3.8；iOS 线上渠道为支付宝 + IAP + 余额/组合支付（微信因虚拟商品合规下线），三渠道由单例 PaymentManager 统一封装。后文以这套工程为实践基线，并在 IAP 验单、发货与完成交易等资金安全边界上按当前方案修正。

---

## 核心内容

### 1. 微信支付接入流程与坑

#### 选型：用 fluwx，别手写 MethodChannel

微信支付的原生接入包含双端初始化、签名透传、Android 回调 Activity、iOS Universal Link 校验等大量样板代码，手写 MethodChannel 等于全部自己维护，成熟做法是用 [fluwx](https://pub.dev/packages/fluwx) 再封装一层支付管理类。某已上线半年的 Flutter 混合开发项目（下文简称"该项目"）使用 fluwx 5.7.2 的本地 fork（原因见"fork 插件的工程实践"），appId 与 Universal Link 收拢在 pubspec 的 fluwx 配置块：插件自带 ruby 脚本可自动写入原生工程，但该项目的 fork 把 iOS 自动脚本禁用、改为手动配置——自动脚本依赖的 ruby 库版本会迫使团队每个成员升级本地环境，得不偿失（fork 注释里记了这条原因）：

```yaml
dependencies:
  fluwx:
    path: packages/fluwx   # 本地 fork
# app_id 与 ios.universal_link 仍写在 pubspec；本项目禁用了自动脚本，
# iOS Associated Domains、URL Scheme 等配置由宿主工程手动维护
```

流程主线：App 请求服务端创建订单 → 服务端统一下单、加签后返回七个支付参数 → App 用 fluwx 调起微信 → 用户在微信完成支付 → 微信异步通知业务服务端（最终事实）→ 用户跳回 App 后轮询服务端确认再更新 UI。下面按初始化、调起、回调入口三步拆开。

#### 初始化：registerApi + 统一回调分发

fluwx 的回调是订阅式的：`addSubscriber` 注册一个分发函数，支付/登录/分享回调全部从这一个出口出来。初始化放在单例的懒加载里，全 App 只执行一次：

```dart
class PaymentManager {
  static final PaymentManager _instance = PaymentManager._();
  factory PaymentManager() => _instance;
  PaymentManager._(); // 单例：全 App 一份 SDK 状态
  final _wx = Fluwx();
  final _tobias = Tobias();
  final _iap = InAppPurchase.instance;
  bool _wxSdkIsInit = false;
  bool _iapInitialized = false;
  Completer<PayResult>? _wxPayResult;
  Completer<PayResult<AppStorePurchaseDetails>>? _applePayResult;
  StreamSubscription<List<PurchaseDetails>>? _purchaseSubscription;

  Future<void> _initWxSdk() async {
    if (_wxSdkIsInit) return; // 幂等
    await _wx.registerApi(appId: wxAppId, // 形如 wx1234567890abcdef
        universalLink: 'https://www.example.com/ul/'); // [iOS] 必配
    // 一个订阅统一分发支付/登录/分享三类回调，避免多处注册互相覆盖
    _wx.addSubscriber((res) {
      if (res is WeChatPaymentResponse) _handleWxPay(res);
      // WeChatAuthResponse / WeChatShareResponse → 登录/分享，同样在此分发
    });
    // 冷启动补偿：被微信回跳拉起时，回调可能早于订阅注册到达
    await _wx.attemptToResumeMsgFromWx();
    _wxSdkIsInit = true;
  }
}
```

`attemptToResumeMsgFromWx` 最容易漏：用户付完款回跳时 App 若已被系统回收、这次回跳是冷启动，原生层会先于 Dart 拿到回调。fluwx 会暂存这条消息，订阅注册后补投一次——不调的话那次支付的 Future 会永远挂起。

#### 调起支付：Completer 挂起等原生回调

微信支付是"先返回、后回调"的两段式异步：`_wx.pay()` 的返回值只代表"是否成功拉起微信"，真正的结果要等 `WeChatPaymentResponse` 送达。企业级封装的标准做法是 **Completer 挂起**：调用时创建 Completer 并返回其 future，回调到达时 complete，把两个异步阶段粘成一个 `await` 就能拿结果的接口：

```dart
extension WeChatPayExt on PaymentManager {
  /// 七个参数全部由服务端统一下单返回，客户端不参与签名
  Future<PayResult> wechatPay({
    required String appId, required String partnerId,
    required String prepayId, required String packageValue, // "Sign=WXPay"
    required String nonceStr, required int timestamp, required String sign,
  }) async {
    await _initWxSdk();
    _wxPayResult = Completer<PayResult>(); // 1. 挂起一个"等回调"的 Completer
    await _wx.pay(which: Payment(
        appId: appId, partnerId: partnerId, prepayId: prepayId,
        packageValue: packageValue, nonceStr: nonceStr,
        timestamp: timestamp, sign: sign)); // 2. 返回值只代表"拉起成功"
    return _wxPayResult!.future; // 3. 回调到达时才 complete
  }

  void _handleWxPay(WeChatPaymentResponse resp) {
    if (_wxPayResult == null) return; // 非支付触发的回调，忽略
    _wxPayResult!.complete(resp.errCode == 0
        ? PayResult.ok('微信支付成功')
        : resp.errCode == -2
            ? PayResult.fail('微信取消支付')
            : PayResult.fail(resp.errStr ?? '微信支付失败'));
    _wxPayResult = null;
  }
}
```

`errCode` 只需两个显式分支：`0` 成功、`-2` 用户取消，其余一律失败并透出原始 `errStr` 方便排查。**`errCode == 0` 也不能直接发货**——客户端回调只用于更新 UI，发货依据永远是服务端支付通知（见第 4、5 节）。

#### [Android] 回调入口：插件已自动生成 wxapi，别再手写

老教程要求在 `包名.wxapi` 下手写 `WXEntryActivity` / `WXPayEntryActivity`，**用 fluwx 后不需要了**——插件在自己的 AndroidManifest.xml 里用 `activity-alias` 自动生成回调入口（WXEntryActivity 同理）：

```xml
<!-- fluwx 插件自带（宿主无需任何操作） -->
<activity-alias
    android:name="${applicationId}.wxapi.WXPayEntryActivity"
    android:exported="true"
    android:targetActivity="com.jarvan.fluwx.wxapi.FluwxWXEntryActivity" />
```

alias 的 name 用 `${applicationId}` 占位，编译后自动落在宿主包名下，正好满足微信"必须在 包名.wxapi 下"的硬性要求。完整回跳链路：微信 → alias → 插件内部 Activity → 转发给宿主的 Flutter 容器 Activity → MethodChannel → Dart 订阅者。如果按老教程又手写了一份 wxapi，微信会回跳到你写的那份，插件反而收不到回调（详见"常见坑"坑7）。

#### [iOS] 虚拟商品合规：从编译期裁剪微信支付

Apple 审核指南 3.1.1 要求虚拟商品必须走 IAP，iOS 包里带着完整的微信支付 SDK，即使 UI 藏掉入口，二进制里的支付符号仍可能被审核扫出来，属于不可控风险。该项目的做法：**fork fluwx，把 podspec 的子模块强制切到 `no_pay`**，iOS 改依赖微信官方裁剪版 SDK：

```ruby
# fluwx.podspec（本地 fork 的关键改动）
# 官方默认应为 'pay'；此处无条件强制 no_pay，宿主漏配也不带入完整支付 SDK
fluwx_subspec = 'no_pay'

s.subspec 'pay' do |sp|
    sp.dependency 'WechatOpenSDK-XCFramework', '~> 2.0.5'  # 完整 SDK
end

s.subspec 'no_pay' do |sp|
    sp.dependency 'OpenWeChatSDKNoPay', '~> 2.0.5'         # 官方去支付版 SDK
    # NO_PAY=1 让 fluwx 原生代码在预处理阶段剔除支付分支
    pod_target_xcconfig["GCC_PREPROCESSOR_DEFINITIONS"] = "$(inherited) NO_PAY=1"
end
```

切到 no_pay 之后：iOS 包内不存在微信支付符号，**从源头**消除审核风险，比 UI 藏入口可靠得多；微信登录、分享能力保留不受影响。代价是调 `pay()` 会静默失败（见"常见坑"坑6），业务层必须同步裁剪——该项目线上 iOS 只保留 IAP 与余额/组合支付，支付方式枚举（balance / alipay / apple / combined）里的 `wechat` 一项在 iOS 分支整体注释下线，仅 Android 出微信支付入口。

#### fork 插件的工程实践

上文的 no_pay 裁剪引出更通用的问题：**什么时候值得 fork 三方插件？** 两类场景值得：一是合规裁剪，官方插件不提供开关时 fork 改 podspec 是唯一选择；二是定制回跳，fluwx 的 Kotlin 扩展把回跳目标硬编码成宿主某个具体 Activity 的类名，宿主工程结构一变就失效，fork 后改成可配置。

代价必须认清：永久失去随社区升级的能力，插件每次升级都要手工合并魔改点；所有魔改处必须用醒目注释标记，并维护一份 fork 说明文档逐条记录"改了什么、为什么改、基于哪个版本"。该项目就吃过亏：半年后排查一个回跳失效问题，半天后才发现是 fork 里那个硬编码类名在起作用，上游 issue 里根本搜不到。**能提 PR 优先提 PR，fork 是最后手段**——fork 前先评估这个插件要跟社区走多远、锁死旧版本的维护成本能否接受。

#### 常见坑

**坑1：签名参数大小写** [Android]
微信支付的参数命名有严格规范，`partnerId` 不能写成 `partnerid`，`prepayId` 不能写成 `prepayid`，`packageValue` 的值固定是 `Sign=WXPay`（大小写敏感）。这类错误直接导致调起失败，且微信几乎不给有价值的报错信息，只能拿服务端参数逐字段比对。

**坑2：Universal Link 三处一致** [iOS]
从微信跳回 App 依赖 Universal Link，三处必须完全一致：fluwx 配置里的 `universal_link`、entitlements 的 Associated Domains（`applinks:www.example.com`）、以及该域名路径下可公网访问的 `apple-app-site-association` 文件。任何一处对不上，支付完成就回不了 App，回调链路整体断掉（用户只能手动切回来，Completer 挂起直到超时）。

**坑3：未安装微信检测** [双端]
调起前用 `_wx.isWeChatInstalled` 检测。[Android] fluwx 的 manifest 已声明对 `com.tencent.mm` 的 `<queries>`；[iOS] 需要在宿主 Info.plist 的 `LSApplicationQueriesSchemes` 白名单里加 `weixin`、`weixinULAPI`，否则检测恒为 false。

---

### 2. 支付宝支付接入流程与坑

#### 标准流程与关键代码

与微信的"跳 App"模式不同：服务端创建订单、加签后返回 orderString（订单信息+签名的完整串），App 把它原样交给 `tobias.pay()`；SDK 自己处理已装支付宝（跳 App 完成）/未装（SDK 内 H5 收银台）两种情况，支付完成后经 URL Scheme [iOS] / Activity [Android] 回调 App，最终事实同样是支付宝服务端的异步通知。[tobias](https://pub.dev/packages/tobias) 封装了支付宝官方 SDK，一个 `pay(orderInfo)` 吃掉整个流程。该项目（tobias 5.2.0）的真实封装：

```dart
extension AliPayExt on PaymentManager {
  // payOrder：服务端加签后的完整订单串，客户端不做任何加工
  Future<PayResult> aliPay({required String payOrder}) async {
    try {
      if (!await _tobias.isAliPayInstalled) {
        return PayResult.fail('请先安装支付宝');
      }
      final res = await _tobias.pay(payOrder);
      switch (res['resultStatus'] as String?) {
        case '9000': // 支付成功
          return PayResult.ok('成功');
        case '8000': // 正在处理中——既不是成功也不是失败
          return PayResult(code: 8000, msg: '正在处理中');
        case '6001': // 用户中途取消
          return PayResult(code: 6001, msg: '支付宝取消支付');
        case '6002': // 网络异常
          return PayResult(code: 6002, msg: '网络错误');
        case '4000': // 系统异常/参数错误（订单无效、签名错误等）
          return PayResult(code: 4000, msg: '系统异常/参数错误');
        default:
          return PayResult.fail('支付失败');
      }
    } catch (e) {
      // 抛 PlatformException 多半是 orderString 非法，换成业务语义返回
      return PayResult.fail('调起支付宝失败');
    }
  }
}
```

resultStatus 映射表：

| resultStatus | 含义 | 客户端处理 |
|------|------|------|
| 9000 | 支付成功 | 轮询服务端确认后更新 UI |
| 8000 | 正在处理中 | 继续轮询服务端，禁止按成功/失败二选一 |
| 6001 | 用户取消 | 主动关单（orderClose，见第 4 节），避免僵尸订单 |
| 6002 | 网络异常 | 引导重试或查看订单列表 |
| 4000 | 系统异常/参数错误 | 多为 orderString 问题，上报日志排查 |
| 其他 | 未知失败 | 兜底失败，轮询服务端确认真实状态 |

#### 常见坑

**坑1：orderString 签名必须在服务端完成**
客户端签名等于把商户私钥打进安装包，任何拿到安装包的人都能伪造订单。正确分工：服务端创建订单、加签、返回订单串；App 只负责原样透传给 `pay()`。订单金额、商品内容全部由服务端控制，客户端想篡改也没有落点。

**坑2：8000 是最容易漏掉的状态**
把 `8000` 归到 default 当失败处理，会出现"用户实际已扣款但 App 提示失败"；如果失败分支还触发关单，甚至会造成用户已付款、订单被关闭的资损事故。`8000` 的唯一正确处理是继续查服务端。

**坑3：回调 scheme 撞车** [iOS]
支付宝回跳依赖 URL Scheme，需在宿主 Info.plist 注册并与开放平台后台配置一致：

```xml
<key>CFBundleURLTypes</key>
<array><dict><key>CFBundleURLSchemes</key>
    <array><string>alipayExampleApp</string></array>
</dict></array>
```

多个 App 注册相同 scheme 时系统随机分派、回调可能丢，scheme 要全局唯一（建议用 appId 或包名派生）；`LSApplicationQueriesSchemes` 还需包含 `alipay`、`alipays` 用于检测支付宝是否安装。

---

### 3. iOS 内购（IAP）全流程

#### 为什么 iOS 必须走 IAP？

[iOS] Apple 审核指南 3.1.1 明确规定：**虚拟商品和服务必须使用 IAP，不允许使用第三方支付。** 实体商品（如外卖、电商）可以使用第三方支付，但虚拟货币、会员、订阅、数字内容必须走 IAP。

违反此规则的 App 会被拒审。这是架构设计时必须前置考虑的约束。

#### IAP 全流程

```
1. App Store Connect 配置商品（Product ID、价格、类型）
2. App 进入收银台：监听 purchaseStream + 注册 PaymentQueueDelegate
3. queryProductDetails 拉取商品 → 展示价格（必须用 Apple 返回的价格）
4. 用户点击购买 → buyConsumable / buyNonConsumable → App Store 系统面板扣款
5. purchaseStream 收到 purchased → 取得 serverVerificationData（新链路优先签名交易数据，旧客户端可能仍是 receipt）
6. App 把验证数据连同订单号交业务服务端 → 服务端按数据类型验签或走兼容验证
7. 验证通过 → 服务端发货 → App completePurchase 完成交易
```

与微信/支付宝不同，IAP 客户端仍要及时把交易凭证送到业务服务端，但服务端不能只依赖这一次上送。生产系统还应接入 App Store Server Notifications V2，并用 App Store Server API 主动查询交易历史，实现客户端送验、服务端通知、主动对账三条补偿链路。该项目原实现只覆盖客户端送验，下面按完整资金闭环修正（in_app_purchase ^3.1.13 + in_app_purchase_storekit ^0.3.8）：

```dart
extension ApplePayExt on PaymentManager {
  /// App 启动后尽早调用；整个进程只注册一次交易监听
  Future<void> initInAppPurchase() async {
    if (_iapInitialized) return;
    if (!await _iap.isAvailable()) throw StateError('当前账号不允许购买');

    _purchaseSubscription = _iap.purchaseStream.listen(
      _listenToPurchaseUpdated,
      onError: (e, s) => reportError('purchaseStream', e, s),
    );
    final addition = _iap.getPlatformAddition<InAppPurchaseStoreKitPlatformAddition>();
    await addition.setDelegate(_PaymentQueueDelegate());
    _iapInitialized = true;
  }

  /// 发起购买前先持久化业务订单与 Product ID 的映射，供崩溃恢复后送验
  Future<PayResult<AppStorePurchaseDetails>> applePay({
    required String productId, required String orderId,
  }) async {
    await initInAppPurchase();
    if (_applePayResult?.isCompleted == false) {
      throw StateError('已有 IAP 交易等待确认'); // 防止后一次购买覆盖前一次回调
    }
    final response = await _iap.queryProductDetails({productId});
    if (response.error != null || response.productDetails.isEmpty) {
      return PayResult.fail('商品数据获取失败'); // notFoundIDs 会给出线索
    }
    await pendingIapOrderStore.save(productId: productId, orderId: orderId);
    final completer = Completer<PayResult<AppStorePurchaseDetails>>();
    _applePayResult = completer;
    final launched = await _iap.buyConsumable(
      purchaseParam: PurchaseParam(
          productDetails: response.productDetails.first),
    );
    if (!launched) {
      await pendingIapOrderStore.remove(productId);
      _applePayResult = null;
      return PayResult.fail('未能调起 App Store');
    }
    try {
      return await completer.future.timeout(const Duration(minutes: 5));
    } on TimeoutException {
      return PayResult.fail('支付结果确认中，请稍后查询订单');
    } finally {
      // 超时后交易仍由常驻监听和服务端补偿处理，但不能让旧 Completer 污染下一笔购买
      if (identical(_applePayResult, completer)) _applePayResult = null;
    }
  }

  Future<void> _listenToPurchaseUpdated(
      List<PurchaseDetails> purchaseDetailsList) async {
    for (final details in purchaseDetailsList) {
      final purchase = details as AppStorePurchaseDetails;
      switch (purchase.status) {
        case PurchaseStatus.pending:
          continue; // 家长批准、扣款确认中：保留未完成交易
        case PurchaseStatus.canceled:
        case PurchaseStatus.error:
          if (purchase.pendingCompletePurchase) {
            await _iap.completePurchase(purchase);
          }
          await pendingIapOrderStore.remove(purchase.productID);
          _completeApplePay(PayResult.fail('取消/购买失败'));
          continue;
        case PurchaseStatus.purchased:
        case PurchaseStatus.restored:
          final orderId = await pendingIapOrderStore.read(purchase.productID);
          if (orderId == null) {
            reportError('iap_order_missing', purchase.productID, null);
            continue; // 不 finish，保留交易等待人工/下次启动补偿
          }
          // 服务端验签 + 幂等发货必须在 completePurchase 之前成功
          final delivered = await paymentApi.verifyAndDeliver(
            orderId: orderId,
            verificationData: purchase.verificationData.serverVerificationData,
          );
          if (!delivered) {
            _completeApplePay(PayResult.fail('验单未完成，请稍后查询订单'));
            continue; // 不 finish，purchaseStream 下次可重新投递
          }
          if (purchase.pendingCompletePurchase) {
            await _iap.completePurchase(purchase);
          }
          await pendingIapOrderStore.remove(purchase.productID);
          _completeApplePay(PayResult.ok(purchase));
      }
    }
  }

  void _completeApplePay(PayResult<AppStorePurchaseDetails> result) {
    if (_applePayResult?.isCompleted == false) _applePayResult!.complete(result);
    _applePayResult = null;
  }

  Future<void> disposeInAppPurchase() async {
    await _purchaseSubscription?.cancel();
    _purchaseSubscription = null;
    _iapInitialized = false;
  }
}

/// 自定义 SKPaymentQueueDelegateWrapper：
/// shouldContinueTransaction → true；shouldShowPriceConsent → false（此处略）
```

同样是 Completer 挂起模式——微信、支付宝、IAP 三个渠道的异步形状完全不同（订阅推送 / pay 返回 Map / 交易流推送），封装后对业务侧都是 `await manager.xxxPay(...)` 一种体验。区别是 IAP 的交易监听必须随支付管理器常驻，并遍历每一条更新；不能在每次购买前取消再重建，否则可能漏掉上次会话的未完成交易。

**完成交易的硬边界**：`completePurchase` 表示业务已经验证并处理了购买，不是单纯“释放队列”。必须先让服务端验签并幂等发货，成功后再对 `pendingCompletePurchase` 调用完成；验单超时或发货失败时保留未完成交易，让 App 下次启动继续收到。服务端再用 Notifications V2 与主动查询补齐客户端永远没有回来的场景（见第 6 节）。

#### 商品 ID 与包名绑定

IAP 的 Product ID 是 App 级唯一而非全局唯一：两个 App 各自都可以有 `coin_6`。多个 App/多 flavor 共用一套业务服务端时，服务端无法区分同名商品归属。该项目的做法：**发起购买前把业务商品 ID 拼上包名再查询**：

```dart
// 商品 ID 规则：包名.业务商品ID，形如 com.example.app.goods_1001
final appleProductId = '${packageName}.${product.id}';
final res = await PaymentManager().applePay(
    productId: appleProductId, orderId: orderId);
// PaymentManager 已在 completePurchase 前完成服务端验签与幂等发货；
// 这里仅按 res 更新 UI，超时则查询业务订单状态，不能重复发货。
```

拼包名让"业务商品 ↔ IAP 商品"的映射无歧义，服务端从验证结果的 productID 也能反查归属，App Store Connect 后台的商品列表也一眼可读。

#### 商品类型

| 类型 | 说明 | 示例 | finishTransaction |
|------|------|------|-------------------|
| Consumable（消耗型） | 一次性消耗 | 金币、钻石 | 必须调用 |
| Non-Consumable（非消耗型） | 永久拥有 | 去广告、高级功能 | 必须调用 |
| Auto-Renewable Subscription（自动续期订阅） | 定期扣款 | 会员月卡 | 必须调用 |
| Non-Renewing Subscription（非续期订阅） | 固定期限 | 季度会员 | 必须调用 |

#### 恢复购买

[iOS] 非消耗型商品和订阅必须提供"恢复购买"功能。用户换设备或重装 App 后，需要能恢复已购买的内容：

```dart
Future<void> restorePurchases() async {
  await _iap.restorePurchases();
  // purchaseStream 会收到 status = PurchaseStatus.restored 的交易
}
```

**不提供恢复购买会被拒审。**

---

### 4. 支付回调的幂等性与客户端订单状态机

#### 为什么幂等性是支付的生命线？

支付回调会被重复发送——这是所有支付平台的默认行为，不是 bug 而是 feature。原因：

1. 网络超时，支付平台不知道你是否收到回调，于是重试
2. 服务端响应慢，支付平台触发超时重试
3. 分布式系统中消息重复是常态

**如果回调处理不是幂等的，一次支付可能被处理多次——用户付一次钱，到两次账。**

#### 幂等性实现方案

```dart
// 服务端幂等处理伪代码
class PaymentCallbackHandler {
  Future<CallbackResult> handleWeChatCallback(Map<String, dynamic> data) async {
    // 1. 验签（防止伪造回调）
    if (!_verifySign(data)) {
      return CallbackResult.fail('Invalid sign');
    }

    // 2. 幂等检查：用 out_trade_no 作为幂等键
    final orderId = data['out_trade_no'] as String;
    final existingOrder = await _orderRepository.findById(orderId);

    if (existingOrder?.status == OrderStatus.paid) {
      // 已处理过，直接返回成功（让支付平台停止重试）
      return CallbackResult.success('Already processed');
    }

    // 3. 事务内更新状态（防止并发重复处理）
    await _db.transaction(() async {
      // 乐观锁或唯一索引保证并发安全
      final updated = await _orderRepository.tryUpdateStatus(
        orderId: orderId,
        fromStatus: OrderStatus.pending,
        toStatus: OrderStatus.paid,
        transactionId: data['transaction_id'],
      );
      if (updated) {
        await _deliveryService.deliver(orderId); // 发货
      }
    });

    return CallbackResult.success('OK');
  }
}
```

**关键设计决策**：
- 用订单号作为幂等键，而非支付平台的 transaction_id（因为同一订单可能产生多笔交易，如支付失败后重新支付）
- 乐观锁（CAS）或数据库唯一索引保证并发安全
- 即使已处理过也要返回成功，让支付平台停止重试

#### 客户端订单状态机：创建 → 支付 → 轮询 → 取消关单

幂等是服务端的责任，但**防掉单有一半责任在客户端的订单状态机上**。以该项目"余额 + 支付宝组合支付"的真实链路为例：

```
用户点击购买 → PayPasswordDialog 输入支付密码（校验余额部分）
  → orderCreate 创建订单（balancePayAmount + thirdPartyPayAmount 拆分）
  → pay 换取支付凭证（支付宝返回 paymentData 加签订单串）
  → 调起支付宝 SDK，按 resultStatus 分流：
       ├─ 9000 成功 → payStatus 轮询服务端状态
       │               ├─ paid → 成功收尾；paying/pending → 继续轮询/引导去订单列表
       └─ 6001 取消 → orderClose 关单（防僵尸订单）
```

服务端订单状态机是客户端所有 UI 的唯一依据：

| 状态 | 含义 | 客户端动作 |
|------|------|------|
| pending | 待支付 | 可继续支付、可取消 |
| paying | 支付中（已调起三方） | 只能轮询等待，禁止再次调起 |
| paid | 已支付 | 成功页、发货 |
| cancelled | 用户已取消 | 回商品页 |
| closed | 已关闭（超时/系统关单） | 提示重新下单 |

真实流程代码（脱敏后，组合支付场景）：

```dart
Future<void> onTapBuy() async {
  // 1. 余额部分先验支付密码
  final password = await PayPasswordDialog.show();
  if (password == null || password.trim().isEmpty) return;
  payData['payPassword'] = password.trim();

  // 2. 创建订单：金额拆分由服务端复核，客户端只上报选择
  final createRes = await api.orderCreate(data: {
    'productId': product.id, 'paymentMethod': 'combined',
    'balancePayAmount': balance, // 余额抵扣部分
    'thirdPartyPayAmount': price - balance, // 三方支付部分
    'thirdPartyType': 'alipay', // 三方通道
  });
  if (createRes.isFailed) return;
  payData['orderId'] = createRes.data.orderId;

  // 3. 换取支付凭证：服务端返回加签订单串 paymentData
  final payRes = await api.pay(data: payData);
  if (payRes.isFailed) return;

  // 4. 调起三方支付；失败时若为用户主动取消则关单，防僵尸订单
  final res =
      await PaymentManager().aliPay(payOrder: payRes.data.paymentData);
  if (res.isFailed) {
    if (res.code == 6001) orderClose(createRes.data.orderId); // 取消→关单
    return;
  }

  // 5. SDK 说成功 → 仍以服务端订单状态为准
  queryPayStatus(payData);
}

void queryPayStatus(Map<String, dynamic> payData) async {
  final res = await api.payStatus(
      queryParameters: {'orderId': payData['orderId']});
  if (res.isSuccess && res.data?.orderStatus == 'paid') {
    nav.pop(true); // 支付成功
  } else {
    await OrderResultDialog.show(payData: payData); // 非成功态引导查订单列表
    nav.pop(true);
  }
}
```

三个设计要点：**用户取消必须关单**——"同一商品同一用户仅一个待支付订单"的唯一约束（防重复支付）会被僵尸单卡住，关单接口自身也要幂等；**金额拆分由服务端裁决**——客户端上报的 `balancePayAmount` 只是意向，服务端要按自己的余额记录重算，防篡改；**SDK 成功后仍轮询服务端**——支付宝 `8000`、微信回调延迟都会造成"SDK 说成功、服务端还没收到通知"，这正是第 6 节掉单补偿的第一层。

---

### 5. 服务端验证 vs 客户端验证

| 维度 | 服务端验证 | 客户端验证 |
|------|-----------|-----------|
| 安全性 | 高（私钥不暴露） | 低（可被篡改） |
| 可靠性 | 高（回调可重试） | 低（用户可能关闭 App） |
| 速度 | 需网络请求 | 本地即可 |
| 适用场景 | 所有正式环境 | 仅用于 UI 状态预更新 |

**原则：服务端验证是唯一可信来源。客户端验证只用于优化体验，不能作为发货依据。**

#### IAP 服务端验证：优先使用签名交易与 Server API

[iOS] `verifyReceipt` 已废弃，新系统应围绕 Apple 签名交易数据、App Store Server API 与 App Store Server Notifications V2 建立资金闭环：

| 数据来源 | 作用 | 服务端关键校验 |
|---------|------|---------------|
| 客户端送验的签名交易/JWS | 用户支付后的低延迟确认 | 签名链、bundleId、productId、environment、transactionId、appAccountToken |
| Notifications V2 | 续期、退款、撤销等异步状态变化 | 验证 signedPayload，按 notificationUUID/transactionId 幂等 |
| App Store Server API | 主动查询交易历史与订阅状态 | 使用服务端 JWT 鉴权，按 transactionId 对账 |

服务端处理流程（伪代码，具体类型以 Apple 官方 Server Library 为准）：

```python
def verify_and_deliver(signed_transaction, expected_order):
    tx = apple_signed_data_verifier.verify(signed_transaction)
    assert tx.bundle_id == expected_order.bundle_id
    assert tx.product_id == expected_order.product_id
    assert tx.app_account_token == expected_order.user_token

    # transaction_id 建唯一索引；重复送验只返回已有发货结果
    with db.transaction():
        payment = db.get_or_create_by_transaction_id(tx.transaction_id)
        if not payment.delivered:
            deliver_entitlement(expected_order)
            payment.mark_delivered()
    return payment
```

旧版 `in_app_purchase` 的 `serverVerificationData` 可能仍是 Base64 receipt。迁移期可以继续兼容旧客户端，但不要为新系统新增 `verifyReceipt` 调用：服务端先持久化 transactionId，逐步迁到 App Store Server API；客户端升级后优先上传 StoreKit 2 的签名交易数据。Sandbox 与 Production 的交易数据、设备 token 和服务端环境仍要明确区分，不能靠失败后猜环境作为长期设计。

---

### 6. 对账与异常处理

#### 掉单：支付最痛的问题

**掉单**是指用户实际已支付，但服务端未收到回调或未正确处理，导致用户付了钱但没到账。

掉单的常见原因：

| 原因 | 发生场景 | 概率 |
|------|---------|------|
| 回调网络超时 | 服务端响应慢、网络抖动 | 中 |
| App 崩溃 | 支付过程中 App 被 kill | 低 |
| 服务端重启 | 回调到达时服务正在部署 | 低 |
| 数据库死锁 | 高并发时事务冲突 | 低 |

#### 掉单处理方案

**方案1：主动查询（补偿）**

App 端在 SDK 回调返回后轮询服务端订单状态（秒级、10 次左右封顶），拿到 `paid` 才展示成功——第 4 节的 `queryPayStatus` 就是该项目的真实实现：它不信任客户端回调，把"轮询服务端状态机"作为唯一的 UI 依据。

**方案2：服务端定时对账**

```
服务端定时任务 → 查询"支付中"状态超过 N 分钟的订单
→ 主动调用支付平台查询 API → 补偿状态
```

```python
# 服务端对账定时任务
def reconcile_pending_orders():
    # 查找超时未确认的订单
    pending_orders = db.query(
        "SELECT * FROM orders WHERE status = 'pending' AND created_at < NOW() - INTERVAL 5 MINUTE"
    )
    for order in pending_orders:
        # 主动查询微信/支付宝
        result = wechat_client.query_order(order.id)
        if result.trade_state == 'SUCCESS':
            # 补偿发货
            deliver_order(order.id)
        elif result.trade_state in ['CLOSED', 'NOTPAY']:
            # 关闭订单
            close_order(order.id)
```

**方案3：IAP 的 finishTransaction 陷阱**

[iOS] IAP 中如果 App 在 `finishTransaction` 之前崩溃，交易会留在未完成队列。App 重新启动后，`purchaseStream` 会再次收到这些交易。**必须处理这种情况，否则用户无法继续购买**——这也是第 3 节把监听放在支付管理类初始化里、而不是购买动作里的原因：监听常驻，启动时接住上次未完成的交易；服务端用 transactionId 幂等，即使客户端重复送验也只发货一次。

#### 重复支付

重复支付通常发生在以下场景：
1. 用户支付成功但 App 未收到回调，再次点击购买
2. 网络延迟导致用户重复提交

**防范措施**：
- 订单创建时加唯一约束，同一商品同一用户只能有一个"待支付"订单
- App 端支付按钮加防重复点击（debounce）
- 服务端创建订单前检查是否有同商品的待支付订单

---

## 常见坑与踩点

### 坑1：微信支付回调不是实时的

微信支付回调可能有 1-5 秒延迟。App 端收到支付结果回调后，不能直接信任客户端结果，必须以服务端回调为准。客户端回调仅用于更新 UI。

### 坑2：支付宝沙盒环境

支付宝沙盒环境和生产环境的 API 域名不同，SDK 初始化参数也不同。上线前必须确认切换到生产环境，否则生产用户无法支付。

### 坑3：IAP 沙盒测试账号

[iOS] IAP 沙盒测试必须使用 App Store Connect 创建的沙盒测试账号，不能用真实 Apple ID。沙盒账号的支付不会真正扣款，但交易流程与生产环境一致。注意沙盒账号创建后需要等待一段时间才能使用。

### 坑4：IAP 订阅续期验证

[iOS] 自动续期订阅的验证比一次性购买复杂得多。每次续期都会产生新的 transaction，服务端需要通过 Apple Server-to-Server Notification V2 接收续期、取消、退款等事件，不能只依赖客户端验证。

### 坑5：Android 回调 Activity 被回收

[Android] 微信支付跳转到微信 App 后，如果用户在微信中停留时间过长，原 App 进程可能被系统回收，回调链路看似断了。fluwx 对这种情况有两条补偿：一是冷启动回跳时由插件 manifest 里的 `activity-alias` 重新接住回调，二是 Dart 侧订阅注册后调用 `attemptToResumeMsgFromWx()` 补投暂存消息。但补偿不是万能的，最终仍要以服务端订单状态轮询兜底。

### 坑6：iOS 裁剪 no_pay 后调微信支付会静默失败 [iOS]

fork fluwx 切到 `no_pay` 子模块后，`pay()` 不会抛异常、不会回调错误，就是"什么都没发生"——因为原生支付代码在预处理阶段就被 `NO_PAY=1` 剔除了。这正是裁剪的目的（编译期消除能力），但也意味着**业务层必须同步下线微信入口**，否则线上用户点了微信支付按钮会毫无反应，客诉直接打进客服。渠道可用性要做成服务端下发或按平台编译的配置，不要只靠客户端硬编码忘记删。

### 坑7：插件自动生成的 wxapi 与手写 wxapi 冲突 [Android]

fluwx 通过 `activity-alias` 在宿主包名下自动生成了 `wxapi.WXEntryActivity` / `wxapi.WXPayEntryActivity`。如果从手写方案迁移过来、保留了旧的手写 Activity，会出现两个同名入口：编译可能直接报 duplicate class；即使不报，微信回跳到哪一份是不确定的，插件大概率收不到回调。迁移到 fluwx 后应删掉全部手写 wxapi 代码。

### 坑8：支付回调依赖 App 存活，必须靠服务端对账兜底 [双端]

微信 WeChatPaymentResponse、支付宝 resultStatus、IAP purchaseStream 都依赖 App 进程和回跳/监听链路。用户付完款直接杀 App、手机关机或回跳失败时，客户端可能永远收不到结果。所以客户端回调只负责低延迟 UI；资金闭环必须依靠支付平台异步通知、App Store Server Notifications V2 与服务端主动对账（见第 6 节）。客户端轮询只是体验优化，不能作为 correctness 依据。

---

## 面试追问

###  支付掉单怎么处理？

掉单是指用户已支付但服务端未收到回调。处理方案有三层：1) App 端轮询补偿——支付完成后主动查询服务端订单状态；2) 服务端定时对账——定期扫描"支付中"超时的订单，主动调用支付平台查询 API；3) 支付平台回调重试——确保回调接口幂等，重复回调不会重复发货。关键是多层补偿，不依赖单一通道。

###  IAP 审核要注意什么？

[iOS] 核心注意点：1) 虚拟商品必须走 IAP，不能用第三方支付；2) 非消耗型商品和订阅必须提供"恢复购买"功能；3) 价格展示必须与 App Store 一致，不能显示其他支付方式的价格；4) 不能引导用户到网页支付来绕过 IAP；5) IAP 商品价格由 Apple 定价，开发者不能自定义精确价格。

###  微信支付和支付宝支付的技术差异是什么？

微信支付必须跳转到微信 App：[iOS] 依赖 Universal Link 回跳，[Android] 回跳入口必须是 `包名.wxapi.WXPayEntryActivity`——但用 fluwx 这类插件时，这个入口由插件用 `activity-alias` + `${applicationId}` 占位符自动生成，宿主不要手写（会冲突）。支付宝由 SDK 自己处理已装/未装（未装走内置 H5 收银台），回调 [iOS] 依赖 URL Scheme。两者的客户端结果回调都只用于 UI，发货一律以服务端异步通知为准。工程封装上可以把两者统一成 Completer 挂起模式：调起时挂起一个 Future，回调到达时 complete，对业务层暴露一致的 `await` 接口。

###  iOS 上为什么你们的 App 没有微信支付？怎么做到的？

[iOS] Apple 审核指南 3.1.1 要求虚拟商品必须走 IAP，包内携带第三方支付能力本身就是拒审风险，所以我们在 iOS 下线了微信支付。实现上不是"隐藏入口"，而是 fork fluwx 把 podspec 的子模块强制切到 `no_pay`：依赖换成微信官方裁剪版 SDK `OpenWeChatSDKNoPay`，并用 `NO_PAY=1` 预处理宏剔除插件原生支付代码——支付能力在编译期就不存在，比运行时隐藏可靠得多；登录、分享不受影响。配套动作：业务层支付方式枚举下线 wechat 项、iOS 渠道只保留 IAP 与余额/组合支付；同时要意识到 no_pay 后调 `pay()` 是静默失败的，渠道开关必须与服务端配置联动。fork 的代价是失去随社区升级的能力，魔改点要用注释和 fork 说明文档固化，能提 PR 优先提 PR。

###  如何保证支付回调的幂等性？

用订单号作为幂等键，回调处理前先查询订单状态，已支付则直接返回成功。使用数据库事务 + 乐观锁（CAS）或唯一索引保证并发安全。即使订单已处理，也要返回成功响应，让支付平台停止重试。绝对不能在回调中做非幂等操作（如直接增加余额），必须通过状态机流转控制。

###  设计一个支持多支付渠道的支付架构，如何处理掉单、对账、幂等？

1. **统一抽象层**：定义 `PaymentService` 接口，每个渠道一个实现（WeChatPayService、AlipayService、IAPService），统一返回 `PaymentResult`
2. **状态机**：订单状态只允许单向流转 `pending → paying → paid → delivered`，每次状态变更记录事件日志
3. **幂等键**：订单号作为幂等键，数据库唯一索引 + CAS 保证并发安全
4. **掉单补偿**：三层——客户端轮询（秒级）+ 服务端定时对账（分钟级）+ 支付平台回调重试（平台级）
5. **对账系统**：每日 T+1 对账，拉取支付平台结算文件与服务端订单逐笔核对，差异订单标记为异常待人工处理
6. **IAP 特殊处理**：finishTransaction 必须在服务端验证后调用，未 finish 的交易在 App 重启后重新出现，需处理

---

## 参考资源

- [微信支付开发文档](https://pay.weixin.qq.com/wiki/doc/apiv3/wxpay/pages/index.shtml)
- [支付宝开放平台](https://opendocs.alipay.com/open/204)
- [Apple In-App Purchase 官方文档](https://developer.apple.com/documentation/storekit/in-app_purchase)
- [in_app_purchase Flutter 插件](https://pub.dev/packages/in_app_purchase)
- [fluwx —— 微信 SDK Flutter 封装](https://pub.dev/packages/fluwx)
- [tobias —— 支付宝 SDK Flutter 封装](https://pub.dev/packages/tobias)
- [OpenWeChatSDKNoPay 微信官方裁剪版 SDK（CocoaPods）](https://cocoapods.org/pods/OpenWeChatSDKNoPay)
- [Apple Server-to-Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications)
- [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)
- [Apple verifyReceipt 迁移说明](https://developer.apple.com/documentation/appstorereceipts)
