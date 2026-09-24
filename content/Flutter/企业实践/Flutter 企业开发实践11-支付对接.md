---
title: Flutter 企业开发实践11-支付对接
date: 2026-05-18
tags: [Flutter, 面试, 架构, 支付, 微信支付, 支付宝, IAP, 幂等性, 对账, fluwx, tobias]
---

# 支付对接

> 支付是 App 最核心的商业化链路，也是最容不得出错的环节，钱的问题没有"小 bug"。本文讲这么几件事：微信支付、支付宝、iOS 内购接进来有什么不一样，支付回调的幂等、掉单处理、对账这些工程问题该怎么解。

---

## 概述：支付对接解决什么问题？

支付对接最麻烦的地方，就是钱和信息得对得上。调起支付页面只是第一步。用户那边钱付了，我们这边没到账；或者我们记了账，服务端没记上。这都算事故。

三个支付渠道的技术差异：

| 维度 | 微信支付 | 支付宝 | iOS 内购 (IAP) |
|------|---------|--------|---------------|
| 支付端 | App → 微信 App → 回调 | App 内 SDK → 回调 | App → App Store → 回调 |
| 回调机制 | 服务端异步通知 + App 端回调 | 服务端异步通知 + App 端回调 | 客户端送验 + Notifications V2 + Server API 对账 |
| 订单归属 | 服务端创建 | 服务端创建 | App Store 创建 |
| 审核约束 | 无 | 无 | 必须走 IAP，不允许第三方支付 |
| 退款 | 服务端处理 | 服务端处理 | Apple 管理，App 不能主动退款 |
| 抽成 | 无 | 无 | 30%（小企业 15%） |

下面的示例大多取自一个已经上线半年的 Flutter 混合开发项目（下文简称"该项目"），它是 iOS 原生宿主 + Flutter module 的结构：微信用 fluwx 5.7.2（本地 fork，仅 Android 启用支付、iOS 编译期裁剪），支付宝用 tobias 5.2.0，IAP 用 in_app_purchase ^3.1.13 + in_app_purchase_storekit ^0.3.8；iOS 线上渠道是支付宝 + IAP + 余额/组合支付（微信因虚拟商品合规下线），三个渠道都由单例 PaymentManager 统一封装。后面就以这套工程作为实践基线，涉及 IAP 验单、发货、完成交易这些资金安全边界的地方，按当前方案做了修正。

---

## 核心内容

### 1. 微信支付接入流程与坑

#### 选型：用 fluwx，别手写 MethodChannel

微信支付原生接进来要写一堆样板代码：双端初始化、签名透传、Android 回调 Activity、iOS Universal Link 校验。手写 MethodChannel 就等于这些全得自己维护，成熟点的做法是用 [fluwx](https://pub.dev/packages/fluwx) 再封一层支付管理类。该项目用的是 fluwx 5.7.2 的本地 fork（原因见"fork 插件的工程实践"），appId 和 Universal Link 都收在 pubspec 的 fluwx 配置块里。插件自带的 ruby 脚本本来能自动写进原生工程，但该项目的 fork 把 iOS 自动脚本禁了、改成手动配置，因为自动脚本依赖的 ruby 库版本会逼着团队每个人升级本地环境，不划算（fork 注释里记了这条原因）：

```yaml
dependencies:
  fluwx:
    path: packages/fluwx   # 本地 fork
# app_id 与 ios.universal_link 仍写在 pubspec；本项目禁用了自动脚本，
# iOS Associated Domains、URL Scheme 等配置由宿主工程手动维护
```

整条流程是这么走的：App 请求服务端创建订单 → 服务端统一下单、加签后返回七个支付参数 → App 用 fluwx 调起微信 → 用户在微信完成支付 → 微信异步通知业务服务端（最终事实）→ 用户跳回 App，App 再轮询服务端确认、然后更新 UI。下面按初始化、调起、回调入口三步拆开说。

#### 初始化：registerApi + 统一回调分发

fluwx 的回调是订阅式的：`addSubscriber` 注册一个分发函数，支付、登录、分享的回调都从这一个出口出来。初始化放在单例的懒加载里，全 App 只跑一次：

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

`attemptToResumeMsgFromWx` 这个地方最容易漏。用户付完款回跳的时候，如果 App 已经被系统回收、这次回跳属于冷启动，原生层会比 Dart 先拿到回调。fluwx 会把这条消息暂存下来，等订阅注册完再补投一次。不调的话，那笔支付的 Future 会一直挂着。

#### 调起支付：Completer 挂起等原生回调

微信支付是"先返回、后回调"的两段式异步：`_wx.pay()` 的返回值只说明"有没有成功拉起微信"，真正的结果得等 `WeChatPaymentResponse` 送过来。企业封装的常规做法是 **Completer 挂起**：调用的时候创建一个 Completer 并把它的 future 返回出去，回调到了再 complete，这样两个异步阶段就被粘成一个接口，业务侧一个 `await` 就能拿到结果：

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

`errCode` 只需要显式分两个分支：`0` 成功、`-2` 用户取消，剩下的统一按失败处理，同时把原始 `errStr` 透出来方便排查。**`errCode == 0` 也不能直接发货**，客户端回调只管更新 UI，发货依据永远是服务端支付通知（见第 4、5 节）。

#### [Android] 回调入口：插件已自动生成 wxapi，别再手写

老教程都让你在 `包名.wxapi` 下手写 `WXEntryActivity` / `WXPayEntryActivity`，**用了 fluwx 就不用写**：插件在自己 AndroidManifest.xml 里用 `activity-alias` 把回调入口自动生成了（WXEntryActivity 同理）：

```xml
<!-- fluwx 插件自带（宿主不用做任何事） -->
<activity-alias
    android:name="${applicationId}.wxapi.WXPayEntryActivity"
    android:exported="true"
    android:targetActivity="com.jarvan.fluwx.wxapi.FluwxWXEntryActivity" />
```

alias 的 name 用 `${applicationId}` 占位，编译完自动落在宿主包名下，正好满足微信"必须在 包名.wxapi 下"这个硬性要求。完整的回跳链路是这样：微信 → alias → 插件内部 Activity → 转发给宿主的 Flutter 容器 Activity → MethodChannel → Dart 订阅者。要是按老教程又手写了一份 wxapi，微信会回跳到你写的那份，插件反倒收不到回调（详见"常见坑"坑7）。

#### [iOS] 虚拟商品合规：从编译期裁剪微信支付

Apple 审核指南 3.1.1 要求虚拟商品必须走 IAP。iOS 包里带着完整的微信支付 SDK，就算把 UI 入口藏了，二进制里的支付符号还是可能被审核扫出来，这个风险控制不住。该项目的做法是 **fork fluwx，把 podspec 的子模块强制切到 `no_pay`**，iOS 换成依赖微信官方裁剪版 SDK：

```ruby
# fluwx.podspec（本地 fork 的关键改动）
# 官方默认应该是 'pay'；这里无条件强制 no_pay，宿主漏配也不会带入完整支付 SDK
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

切到 no_pay 之后，iOS 包内不存在微信支付符号，审核风险**从源头**就没了，比藏 UI 入口可靠得多；微信登录、分享不受影响。代价是调 `pay()` 会静默失败（见"常见坑"坑6），业务层得跟着一起裁剪。该项目线上 iOS 只留 IAP 和余额/组合支付，支付方式枚举（balance / alipay / apple / combined）里的 `wechat` 一项在 iOS 分支整体注释下线，只有 Android 出微信支付入口。

#### fork 插件的工程实践

no_pay 这个裁剪引出一个更通用的问题：**什么时候值得 fork 三方插件？** 有两类场景值得：一是合规裁剪，官方插件不给开关的时候，fork 改 podspec 是唯一的路；二是定制回跳，fluwx 的 Kotlin 扩展把回跳目标硬编码成宿主某个具体 Activity 的类名，宿主工程结构一变就失效，fork 之后才能改成可配置。

代价也得心里有数：从此失去随社区升级的能力，插件每次升级都要手工合并魔改点；所有魔改的地方都要用醒目注释标出来，再维护一份 fork 说明文档，逐条记清楚"改了什么、为什么改、基于哪个版本"。该项目就吃过亏：半年后排查一个回跳失效问题，半天才发现是 fork 里那个硬编码类名在起作用，去上游 issue 里根本搜不到。**能提 PR 就优先提 PR，fork 是最后手段**。fork 之前先评估一下：这个插件要跟社区走多远，锁死旧版本的维护成本能不能接受。

#### 常见坑

**坑1：签名参数大小写** [Android]
微信支付对参数命名卡得很严，`partnerId` 不能写成 `partnerid`，`prepayId` 不能写成 `prepayid`，`packageValue` 的值固定是 `Sign=WXPay`（大小写敏感）。这类错误直接导致调起失败，而微信几乎不给什么有用的报错，只能拿服务端参数一个字段一个字段对。

**坑2：Universal Link 三处一致** [iOS]
从微信跳回 App 靠的是 Universal Link，这三处必须完全一致：fluwx 配置里的 `universal_link`、entitlements 的 Associated Domains（`applinks:www.example.com`）、以及该域名路径下可公网访问的 `apple-app-site-association` 文件。任何一处对不上，支付完成就回不了 App，整条回调链路直接断掉（用户只能手动切回来，Completer 一直挂到超时）。

**坑3：未安装微信检测** [双端]
调起之前先用 `_wx.isWeChatInstalled` 检测一下。[Android] fluwx 的 manifest 已经声明了对 `com.tencent.mm` 的 `<queries>`；[iOS] 要在宿主 Info.plist 的 `LSApplicationQueriesSchemes` 白名单里加上 `weixin`、`weixinULAPI`，不然检测结果恒为 false。

---

### 2. 支付宝支付接入流程与坑

#### 标准流程与关键代码

和微信的"跳 App"模式不一样：服务端创建订单、加签，然后把 orderString（订单信息+签名的完整串）返回给 App，App 原样交给 `tobias.pay()`。SDK 自己会分两种情况：装了支付宝就跳 App 完成，没装就走 SDK 内 H5 收银台。支付完成后经 URL Scheme [iOS] / Activity [Android] 回调 App，最终事实同样是支付宝服务端的异步通知。[tobias](https://pub.dev/packages/tobias) 封装了支付宝官方 SDK，一个 `pay(orderInfo)` 就能吃掉整个流程。该项目（tobias 5.2.0）里的真实封装：

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
        case '8000': // 正在处理中，既不是成功也不是失败
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
| 6001 | 用户取消 | 主动关单（orderClose，见第 4 节），免得留下僵尸订单 |
| 6002 | 网络异常 | 引导重试或查看订单列表 |
| 4000 | 系统异常/参数错误 | 多为 orderString 问题，上报日志排查 |
| 其他 | 未知失败 | 兜底失败，轮询服务端确认真实状态 |

#### 常见坑

**坑1：orderString 签名必须在服务端完成**
客户端签名等于把商户私钥打进安装包，谁拿到安装包谁就能伪造订单。正确的分工是：服务端创建订单、加签、返回订单串；App 只管原样透传给 `pay()`。订单金额、商品内容全由服务端控制，客户端想改也没地方下手。

**坑2：8000 是最容易漏掉的状态**
把 `8000` 扔进 default 当失败处理，就会出现"用户其实已经扣款、App 却提示失败"；要是失败分支还触发关单，更糟，用户付了钱订单却被关掉，这就是资损事故。`8000` 只有一种处理是对的：继续查服务端。

**坑3：回调 scheme 撞车** [iOS]
支付宝回跳靠 URL Scheme，得在宿主 Info.plist 里注册，并且跟开放平台后台的配置一致：

```xml
<key>CFBundleURLTypes</key>
<array><dict><key>CFBundleURLSchemes</key>
    <array><string>alipayExampleApp</string></array>
</dict></array>
```

多个 App 注册了同一个 scheme，系统会随机分派，回调就可能丢，所以 scheme 要全局唯一（建议用 appId 或包名派生）；`LSApplicationQueriesSchemes` 里还要加上 `alipay`、`alipays`，用来检测用户装没装支付宝。

---

### 3. iOS 内购（IAP）全流程

#### 为什么 iOS 必须走 IAP？

[iOS] Apple 审核指南 3.1.1 写得很清楚：**虚拟商品和服务必须使用 IAP，不允许使用第三方支付。** 实体商品（如外卖、电商）可以使用第三方支付，但虚拟货币、会员、订阅、数字内容必须走 IAP。

违反这条的 App 直接拒审。这个约束在架构设计阶段就得先想清楚。

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

和微信、支付宝不一样的地方在于：IAP 客户端也要及时把交易凭证送到业务服务端，但服务端不能只靠这一次上送。线上系统还得接 App Store Server Notifications V2，再用 App Store Server API 主动查交易历史，这样才有客户端送验、服务端通知、主动对账三条补偿链路。该项目原来的实现只覆盖了客户端送验，下面按完整的资金闭环做了修正（in_app_purchase ^3.1.13 + in_app_purchase_storekit ^0.3.8）：

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

这里同样是 Completer 挂起模式：微信、支付宝、IAP 三个渠道的异步形状完全不同（订阅推送 / pay 返回 Map / 交易流推送），封一层之后业务侧看到的都是 `await manager.xxxPay(...)`。区别在 IAP 的交易监听得跟着支付管理器常驻，而且要把每一条更新都遍历到；不能每次购买前取消再重建，不然可能漏掉上个会话没完成的交易。

**完成交易的硬边界**：`completePurchase` 的意思是业务已经验证并处理了这次购买，不是单纯“释放队列”。必须先让服务端验签、幂等发货，成功了再对 `pendingCompletePurchase` 调用完成；验单超时或者发货失败就保留这笔未完成交易，让 App 下次启动时继续收到。客户端永远没回来的场景，服务端再用 Notifications V2 和主动查询补上（见第 6 节）。

#### 商品 ID 与包名绑定

IAP 的 Product ID 是 App 级唯一，不是全局唯一：两个 App 都可以有 `coin_6`。多个 App、多 flavor 共用一套业务服务端的时候，服务端分不清同名商品到底归谁。该项目的做法是 **发起购买前先把业务商品 ID 拼上包名再查询**：

```dart
// 商品 ID 规则：包名.业务商品ID，形如 com.example.app.goods_1001
final appleProductId = '${packageName}.${product.id}';
final res = await PaymentManager().applePay(
    productId: appleProductId, orderId: orderId);
// PaymentManager 已在 completePurchase 前完成服务端验签与幂等发货；
// 这里只按 res 更新 UI，超时则查询业务订单状态，不能重复发货。
```

拼上包名以后，"业务商品 ↔ IAP 商品"的映射就没有歧义了，服务端从验证结果的 productID 也能反查归属，App Store Connect 后台的商品列表也一眼能看懂。

#### 商品类型

| 类型 | 说明 | 示例 | finishTransaction |
|------|------|------|-------------------|
| Consumable（消耗型） | 一次性消耗 | 金币、钻石 | 必须调用 |
| Non-Consumable（非消耗型） | 永久拥有 | 去广告、高级功能 | 必须调用 |
| Auto-Renewable Subscription（自动续期订阅） | 定期扣款 | 会员月卡 | 必须调用 |
| Non-Renewing Subscription（非续期订阅） | 固定期限 | 季度会员 | 必须调用 |

#### 恢复购买

[iOS] 非消耗型商品和订阅必须提供"恢复购买"。用户换设备或者重装了 App，得能把已买的内容恢复回来：

```dart
Future<void> restorePurchases() async {
  await _iap.restorePurchases();
  // purchaseStream 会收到 status = PurchaseStatus.restored 的交易
}
```

**不提供恢复购买会被拒审。**

#### 出海 Android：Google Play Billing（与 IAP 成对的存在）

[iOS] 走 IAP，出海 Android 对应的就是 Google Play Billing，模型是同一套"平台抽成 + 服务端验证 + 幂等发货"。Flutter 侧的好消息是**同一个包**：`in_app_purchase` 把双端抽象掉了，Play Billing 只是它在 Android 上的后台实现，客户端代码基本能复用，差异全在服务端：

| 维度 | App Store（IAP） | Google Play Billing |
|------|-----------------|---------------------|
| 验证凭据 | 签名交易（JWS）/ Server API | `purchaseToken` + Google Play Developer API |
| 异步通知 | App Store Server Notifications V2 | Real-Time Developer Notifications（RTDN，Pub/Sub） |
| 服务端官方库 | App Store Server Library | Google Play Developer API 客户端 |

跟 IAP 同源的三条铁律在这里一样成立：`purchaseToken` 建唯一索引做幂等、RTDN 和主动查询互相补偿、客户端确认（`completePurchase`）得在服务端发货成功之后。另外注意 Play Billing 的 SKU/订阅配置是在 Play Console 侧管理的，测试要走 License Tester 账号，沙盒和生产的行为差异是出海项目的经典坑。国内分发渠道（没有 Google 服务）就回到前面三节的微信/支付宝通道，两套并存的时候用 flavor 隔离。

---

### 4. 支付回调的幂等性与客户端订单状态机

#### 为什么幂等性是支付的生命线？

支付回调会被重复发送，所有支付平台都这样，这是 feature 不是 bug。原因有三个：

1. 网络超时，支付平台不知道你收没收到回调，就重试
2. 服务端响应慢，支付平台超时重试
3. 分布式系统里消息重复本来就是常态

**回调处理要是没做幂等，一次支付可能被处理多次，用户付一次钱，到两次账。**

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

**几个关键的设计取舍**：
- 幂等键用订单号，不用支付平台的 transaction_id（同一订单可能产生多笔交易，比如支付失败后重新支付）
- 并发安全靠乐观锁（CAS）或者数据库唯一索引
- 已经处理过的也照样返回成功，让支付平台别再重试

#### 客户端订单状态机：创建 → 支付 → 轮询 → 取消关单

幂等是服务端的责任，但**防掉单有一半责任在客户端的订单状态机上**。拿该项目"余额 + 支付宝组合支付"这条真实链路举例：

```
用户点击购买 → PayPasswordDialog 输入支付密码（校验余额部分）
  → orderCreate 创建订单（balancePayAmount + thirdPartyPayAmount 拆分）
  → pay 换取支付凭证（支付宝返回 paymentData 加签订单串）
  → 调起支付宝 SDK，按 resultStatus 分流：
       ├─ 9000 成功 → payStatus 轮询服务端状态
       │               ├─ paid → 成功收尾；paying/pending → 继续轮询/引导去订单列表
       └─ 6001 取消 → orderClose 关单（防僵尸订单）
```

客户端所有 UI 都只看服务端订单状态机：

| 状态 | 含义 | 客户端动作 |
|------|------|------|
| pending | 待支付 | 可继续支付、可取消 |
| paying | 支付中（已调起三方） | 只能轮询等待，禁止再次调起 |
| paid | 已支付 | 成功页、发货 |
| cancelled | 用户已取消 | 回商品页 |
| closed | 已关闭（超时/系统关单） | 提示重新下单 |

下面这段是真实流程代码（已脱敏，组合支付场景）：

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

  // 4. 调起三方支付；失败时如果是用户主动取消就关单，防僵尸订单
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
  // 真正的轮询：秒级间隔、10 次封顶。SDK 回调延迟（微信 1-5s）、
  // 支付宝 8000 处理中，都要靠多轮查询等到 paid；一次网络抖动
  // 就把用户踢去"非成功"弹窗是掉单补偿第一层的常见实现 bug
  for (var attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) {
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    final res = await api.payStatus(
        queryParameters: {'orderId': payData['orderId']});
    if (res.isSuccess && res.data?.orderStatus == 'paid') {
      nav.pop(true); // 支付成功
      return;
    }
    // paying / pending 都继续等；明确失败态（closed）提前退出
    if (res.isSuccess && res.data?.orderStatus == 'closed') break;
  }
  await OrderResultDialog.show(payData: payData); // 超时仍未成功：引导查订单列表
  nav.pop(true);
}
```

这里有三个设计要点：**用户取消必须关单**，"同一商品同一用户仅一个待支付订单"这个唯一约束（防重复支付）会被僵尸单卡住，而且关单接口本身也得幂等；**金额拆分由服务端说了算**，客户端上报的 `balancePayAmount` 只是个意向，服务端要按自己的余额记录重算，防止被篡改；**SDK 说成功之后仍然要轮询服务端**，支付宝 `8000`、微信回调延迟都会造成"SDK 说成功、服务端还没收到通知"，这也是第 6 节掉单补偿的第一层。

---

### 5. 服务端验证 vs 客户端验证

| 维度 | 服务端验证 | 客户端验证 |
|------|-----------|-----------|
| 安全性 | 高（私钥不暴露） | 低（可被篡改） |
| 可靠性 | 高（回调可重试） | 低（用户可能关闭 App） |
| 速度 | 要走网络请求 | 本地就能判断 |
| 适用场景 | 所有正式环境 | 只用来提前更新 UI 状态 |

**原则就一条：服务端验证才是唯一可信来源。客户端验证只用来优化体验，不能拿来当发货依据。**

#### IAP 服务端验证：优先使用签名交易与 Server API

[iOS] `verifyReceipt` 已经废弃了，新系统应该围绕 Apple 签名交易数据、App Store Server API 和 App Store Server Notifications V2 把资金闭环建起来：

| 数据来源 | 作用 | 服务端关键校验 |
|---------|------|---------------|
| 客户端送验的签名交易/JWS | 用户支付后的低延迟确认 | 签名链、bundleId、productId、environment、transactionId、appAccountToken |
| Notifications V2 | 续期、退款、撤销等异步状态变化 | 验证 signedPayload，按 notificationUUID/transactionId 幂等 |
| App Store Server API | 主动查询交易历史与订阅状态 | 使用服务端 JWT 鉴权，按 transactionId 对账 |

服务端的处理流程就是下面这样（伪代码，具体类型以 Apple 官方 Server Library 为准）：

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

旧版 `in_app_purchase` 的 `serverVerificationData` 可能还是 Base64 receipt。迁移期兼容旧客户端没问题，但别再给新系统加 `verifyReceipt` 调用了：服务端先把 transactionId 持久化下来，慢慢迁到 App Store Server API；客户端升级之后优先上传 StoreKit 2 的签名交易数据。Sandbox 和 Production 的交易数据、设备 token、服务端环境还是要明确区分开，靠失败之后猜环境不是长期办法。

---

### 6. 对账与异常处理

#### 掉单：支付最痛的问题

**掉单**指的是用户钱已经付了，但服务端没收到回调或者没处理对，结果用户付了钱东西没到账。

掉单的常见原因：

| 原因 | 发生场景 | 概率 |
|------|---------|------|
| 回调网络超时 | 服务端响应慢、网络抖动 | 中 |
| App 崩溃 | 支付过程中 App 被 kill | 低 |
| 服务端重启 | 回调到达时服务正在部署 | 低 |
| 数据库死锁 | 高并发时事务冲突 | 低 |

#### 掉单处理方案

**方案1：主动查询（补偿）**

App 端在 SDK 回调返回之后轮询服务端订单状态（秒级间隔、10 次左右封顶），拿到 `paid` 才展示成功。第 4 节的 `queryPayStatus` 就是该项目真实的实现：它不信客户端回调，把"轮询服务端状态机"当成唯一的 UI 依据。

**方案2：服务端定时对账**

```
服务端定时任务 → 查询"支付中"状态超过 N 分钟的订单
→ 主动调用支付平台查询 API → 补偿状态
```

```python
# 服务端对账定时任务
def reconcile_unconfirmed_orders():
    # 掉单发生在"已调起三方"之后，按第 4 节状态机就是 paying 态：
    # 用户付了钱、三方已成功，但回调没到，订单卡在 paying。
    # 只扫 pending 会漏掉绝大多数掉单（pending 是还没调起，本就不会付钱）。
    # pending 顺带扫是为了关掉超时未付的僵尸单。
    orders = db.query(
        "SELECT * FROM orders "
        "WHERE status IN ('pending', 'paying') "
        "AND updated_at < NOW() - INTERVAL 5 MINUTE"
    )
    for order in orders:
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

[iOS] IAP 里如果 App 在 `finishTransaction` 之前崩了，这笔交易会留在未完成队列里。App 重新启动之后，`purchaseStream` 会再收到这些交易。**这种情况必须处理，不然用户没法继续购买**。这也是第 3 节把监听放在支付管理类初始化里、而不是放在购买动作里的原因：监听常驻，启动时把上次没完成的交易接住；服务端用 transactionId 做幂等，客户端重复送验也只发一次货。

#### 重复支付

重复支付一般出现在这几种情况：
1. 用户支付成功了但 App 没收到回调，又点了一次购买
2. 网络延迟导致用户重复提交

**防范措施**：
- 创建订单时加唯一约束，同一商品同一用户只能有一个"待支付"订单
- App 端的支付按钮加防重复点击（debounce）
- 服务端创建订单之前先查一下有没有同商品的待支付订单

---

## 常见坑

### 坑1：微信支付回调不是实时的

微信支付回调可能延迟 1-5 秒。App 端收到支付结果回调之后，不能直接信客户端的结果，得服务端回调说了算。客户端回调只用来更新 UI。

### 坑2：支付宝沙盒环境

支付宝沙盒环境和生产环境的 API 域名不一样，SDK 初始化参数也不一样。上线前一定要确认切到了生产环境，不然生产用户付不了款。

### 坑3：IAP 沙盒测试账号

[iOS] IAP 沙盒测试必须用 App Store Connect 里创建的沙盒测试账号，不能拿真实 Apple ID 测。沙盒账号支付不会真扣款，但交易流程跟生产环境是一样的。注意沙盒账号创建完得等一段时间才能用。

### 坑4：IAP 订阅续期验证

[iOS] 自动续期订阅的验证比一次性购买复杂得多。每次续期都会产生一个新的 transaction，服务端得通过 Apple Server-to-Server Notification V2 接收续期、取消、退款这些事件，不能只靠客户端验证。

### 坑5：Android 回调 Activity 被回收

[Android] 微信支付跳到微信 App 之后，用户在微信里待得太久，原 App 的进程可能被系统回收，回调链路看着就断了。fluwx 对这种情况有两条补偿：一是冷启动回跳时由插件 manifest 里的 `activity-alias` 重新接住回调，二是 Dart 侧订阅注册之后调用 `attemptToResumeMsgFromWx()` 把暂存的消息补投一次。不过补偿不是万能的，最后还是得靠轮询服务端订单状态兜底。

### 坑6：iOS 裁剪 no_pay 后调微信支付会静默失败 [iOS]

fork fluwx 切到 `no_pay` 子模块之后，`pay()` 不抛异常也不回调错误，就是"什么都没发生"，因为原生支付代码在预处理阶段就已经被 `NO_PAY=1` 剔掉了。裁剪要的就是这个效果（编译期消除能力），但也意味着**业务层必须同步把微信入口下线**，不然线上用户点了微信支付按钮一点反应都没有，客诉直接进客服。渠道可用性最好做成服务端下发或者按平台编译的配置，别只靠客户端硬编码，忘了删就出事。

### 坑7：插件自动生成的 wxapi 与手写 wxapi 冲突 [Android]

fluwx 通过 `activity-alias` 在宿主包名下自动生成了 `wxapi.WXEntryActivity` / `wxapi.WXPayEntryActivity`。要是从手写方案迁过来、旧的手写 Activity 还留着，就会出现两个同名入口：编译可能直接报 duplicate class；就算不报，微信回跳到哪一份也是不确定的，插件大概率收不到回调。迁到 fluwx 之后，手写的 wxapi 代码全部删掉。

### 坑8：支付回调依赖 App 存活，必须靠服务端对账兜底 [双端]

微信 WeChatPaymentResponse、支付宝 resultStatus、IAP purchaseStream 都依赖 App 进程和回跳/监听链路。用户付完款直接把 App 杀了、手机关机、或者回跳失败，客户端可能永远收不到结果。所以客户端回调只负责低延迟地更新 UI；资金闭环得靠支付平台异步通知、App Store Server Notifications V2 和服务端主动对账（见第 6 节）。客户端轮询只是体验优化，不能当成 correctness 的依据。

---

## 面试追问

### 支付掉单怎么处理？

掉单就是用户已经付了钱、服务端没收到回调。有三种一层一层叠上的处理：1) App 端轮询补偿：支付完成后主动查服务端订单状态；2) 服务端定时对账：定期扫"支付中"超时的订单，主动调支付平台查询 API；3) 支付平台回调重试：回调接口得幂等，重复回调不会重复发货。关键是多层补偿，别只靠一条通道。

### IAP 审核要注意什么？

[iOS] 核心要注意这几点：1) 虚拟商品必须走 IAP，不能用第三方支付；2) 非消耗型商品和订阅必须提供"恢复购买"功能；3) 价格展示必须与 App Store 一致，不能显示其他支付方式的价格；4) 不能引导用户到网页支付来绕过 IAP；5) IAP 商品价格由 Apple 定价，开发者不能自定义精确价格。

### 微信支付和支付宝支付的技术差异是什么？

微信支付必须跳转到微信 App：[iOS] 依赖 Universal Link 回跳，[Android] 回跳入口必须是 `包名.wxapi.WXPayEntryActivity`，不过用 fluwx 这类插件的时候，这个入口由插件用 `activity-alias` + `${applicationId}` 占位符自动生成，宿主别手写（会冲突）。支付宝是 SDK 自己处理装没装（没装就走内置 H5 收银台），回调 [iOS] 依赖 URL Scheme。两者的客户端结果回调都只用于 UI，发货一律以服务端异步通知为准。工程封装上可以把两者统一成 Completer 挂起模式：调起时挂起一个 Future，回调到了再 complete，对业务层暴露一样的 `await` 接口。

### iOS 上为什么你们的 App 没有微信支付？怎么做到的？

[iOS] Apple 审核指南 3.1.1 要求虚拟商品必须走 IAP，包里带着第三方支付能力本身就是拒审风险，所以我们在 iOS 下线了微信支付。光把入口藏起来不够，还得 fork fluwx 把 podspec 的子模块强制切到 `no_pay`：依赖换成微信官方裁剪版 SDK `OpenWeChatSDKNoPay`，再用 `NO_PAY=1` 预处理宏把插件原生支付代码剔掉，支付能力在编译期就不存在了，比运行时隐藏可靠得多；登录、分享不受影响。配套还得做几件事：业务层支付方式枚举下线 wechat 项、iOS 渠道只留 IAP 和余额/组合支付；同时得意识到 no_pay 之后调 `pay()` 是静默失败的，渠道开关必须跟服务端配置联动。fork 的代价是失去随社区升级的能力，魔改点要用注释和 fork 说明文档固化下来，能提 PR 就优先提 PR。

### 如何保证支付回调的幂等性？

幂等键用订单号，回调处理前先查订单状态，已经支付就直接返回成功。并发安全靠数据库事务 + 乐观锁（CAS）或者唯一索引。订单处理过了也照样返回成功，让支付平台别再重试。回调里绝对不做非幂等操作（比如直接加余额），要靠状态机流转来控制。

### 设计一个支持多支付渠道的支付架构，如何处理掉单、对账、幂等？

1. **统一抽象层**：定一个 `PaymentService` 接口，每个渠道一个实现（WeChatPayService、AlipayService、IAPService），统一返回 `PaymentResult`
2. **状态机**：订单状态只能单向流转 `pending → paying → paid → delivered`，每次变更都记事件日志
3. **幂等键**：订单号作为幂等键，数据库唯一索引 + CAS 保证并发安全
4. **掉单补偿**：三层，客户端轮询（秒级）+ 服务端定时对账（分钟级）+ 支付平台回调重试（平台级）
5. **对账系统**：每天 T+1 对账，拉支付平台的结算文件跟服务端订单逐笔核，差异订单标记成异常等人工处理
6. **IAP 特殊处理**：finishTransaction 必须在服务端验证之后才调，没 finish 的交易在 App 重启后会再出现，得处理

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
