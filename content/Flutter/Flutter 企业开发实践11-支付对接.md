---
title: Flutter 企业开发实践11-支付对接
date: 2026-05-18
tags: [Flutter, 面试, 架构, 支付, 微信支付, 支付宝, IAP, 幂等性, 对账]
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
| 回调机制 | 服务端异步通知 + App 端回调 | 服务端异步通知 + App 端回调 | App 端交易凭证 → 服务端验证 |
| 订单归属 | 服务端创建 | 服务端创建 | App Store 创建 |
| 审核约束 | 无 | 无 | 必须走 IAP，不允许第三方支付 |
| 退款 | 服务端处理 | 服务端处理 | Apple 管理，App 无法主动退款 |
| 抽成 | 无 | 无 | 30%（小企业 15%） |

---

## 核心内容

### 1. 微信支付接入流程与坑

#### 标准流程

```
1. 用户点击购买 → App 请求服务端创建订单
2. 服务端调用微信统一下单 API → 获取 prepay_id
3. 服务端返回签名参数给 App
4. App 调起微信 SDK → 用户在微信中完成支付
5. 微信服务端异步通知业务服务端（支付结果通知）
6. 用户跳回 App → App 查询服务端获取最终支付结果
```

#### 关键参数签名

```dart
// Flutter 侧调起微信支付
Future<void> payWithWeChat({
  required String appId,
  required String partnerId,
  required String prepayId,
  required String nonceStr,
  required String timeStamp,
  required String sign,
}) async {
  await _channel.invokeMethod('payWithWeChat', {
    'appId': appId,
    'partnerId': partnerId,
    'prepayId': prepayId,
    'nonceStr': nonceStr,
    'timeStamp': timeStamp,
    'sign': sign,
  });
}
```

#### 常见坑

**坑1：签名参数大小写** [Android]
微信支付的签名参数有严格的 key 命名规范，`partnerId` 不能写成 `partnerid`，`prepayId` 不能写成 `prepayid`。大小写错误直接导致调起失败，且报错信息不明确。

**坑2：回调 Activity 配置** [Android]
微信支付回调必须在包名下的 `wxapi` 目录中创建 `WXPayEntryActivity`，路径和类名写错则收不到回调：

```kotlin
// 必须在 包名.wxapi 包下
package com.yourapp.wxapi

class WXPayEntryActivity : Activity(), IWXAPIEventHandler {
    override fun onResp(baseResp: BaseResp) {
        if (baseResp.type == ConstantsAPI.COMMAND_PAY_BY_WX) {
            val resp = baseResp as PayResp
            // 通过 EventChannel 或 BroadcastReceiver 通知 Flutter
        }
    }
}
```

**坑3：Universal Link** [iOS]
iOS 9+ 必须配置 Universal Link 才能从微信跳回 App。如果 Universal Link 配置有误（域名未验证、apple-app-site-association 文件路径错误），支付完成后无法跳回。

**坑4：未安装微信**
调起微信支付前必须检测微信是否安装，未安装时需要引导用户或提供 H5 支付降级方案。

---

### 2. 支付宝支付接入流程与坑

#### 标准流程

与微信类似，但支付宝支持 App 内 SDK 直接支付，不需要跳转到支付宝 App：

```
1. 服务端创建订单 → 签名 → 返回 orderString
2. App 调起支付宝 SDK → SDK 内部判断：
   a. 已安装支付宝 App → 跳转支付宝 App
   b. 未安装 → SDK 内 H5 支付
3. 支付完成 → 回调 App
4. 支付宝服务端异步通知业务服务端
```

#### 关键代码

```dart
Future<AlipayResult> payWithAlipay(String orderString) async {
  final result = await _channel.invokeMethod<Map>('payWithAlipay', {
    'orderString': orderString,
  });
  return AlipayResult(
    resultStatus: result?['resultStatus'] as String? ?? '',
    result: result?['result'] as String? ?? '',
    memo: result?['memo'] as String? ?? '',
  );
}
```

#### 常见坑

**坑1：orderString 签名必须在服务端完成**
客户端签名是严重的安全隐患——私钥暴露在 App 中等于把支付权限交给了黑客。签名必须在服务端完成，App 只负责传递 orderString。

**坑2：resultStatus 状态码**
- `9000`：支付成功
- `8000`：支付结果待确认（需要轮询服务端）
- `6001`：用户取消
- `6002`：网络异常

`8000` 是最容易遗漏的状态——它既不是成功也不是失败，必须轮询服务端查询最终结果。

**坑3：回调 scheme** [iOS]
支付宝回调依赖 URL Scheme，需在 `Info.plist` 中配置 `CFBundleURLTypes`。如果 scheme 被其他 App 占用，回调会丢失。

---

### 3. iOS 内购（IAP）全流程

#### 为什么 iOS 必须走 IAP？

[iOS] Apple 审核指南 3.1.1 明确规定：**虚拟商品和服务必须使用 IAP，不允许使用第三方支付。** 实体商品（如外卖、电商）可以使用第三方支付，但虚拟货币、会员、订阅、数字内容必须走 IAP。

违反此规则的 App 会被拒审。这是架构设计时必须前置考虑的约束。

#### IAP 全流程

```
1. App Store Connect 配置商品（Product ID、价格、类型）
2. App 获取商品信息 → 展示价格
3. 用户点击购买 → App 发起 SKPayment
4. App Store 处理支付 → 扣款
5. App 收到交易回调 → 获取 transactionReceipt
6. App 将 receipt 发送给业务服务端
7. 服务端向 Apple 验证 receipt（生产/沙盒环境）
8. 验证通过 → 服务端发货 → 标记交易完成
9. App 调用 finishTransaction 完成交易
```

```dart
// Flutter 侧 IAP 流程（使用 in_app_purchase 插件）
class IAPManager {
  final InAppPurchase _iap = InAppPurchase.instance;

  /// 购买商品
  Future<void> purchase(String productId) async {
    final productDetails = await _getProductDetails(productId);
    if (productDetails == null) return;

    final purchaseParam = PurchaseParam(productDetails: productDetails);
    final success = await _iap.buyNonConsumable(purchaseParam: purchaseParam);
    if (!success) {
      // 购买发起失败
      _handlePurchaseError();
    }
  }

  /// 监听购买结果
  void listenPurchaseUpdates() {
    _iap.purchaseStream.listen((purchases) {
      for (final purchase in purchases) {
        switch (purchase.status) {
          case PurchaseStatus.purchased:
            // 发送 receipt 到服务端验证
            _verifyAndDeliver(purchase);
            break;
          case PurchaseStatus.error:
            _handlePurchaseError();
            break;
          case PurchaseStatus.restored:
            _handleRestore(purchase);
            break;
          case PurchaseStatus.canceled:
            break;
          case PurchaseStatus.pending:
            // 家长控制等场景
            break;
        }
      }
    });
  }

  /// 服务端验证
  Future<void> _verifyAndDeliver(PurchaseDetails purchase) async {
    final verified = await _serverVerifyReceipt(purchase.verificationData.serverVerificationData);
    if (verified) {
      _iap.completePurchase(purchase); // 必须调用，否则交易会一直挂起
    }
  }
}
```

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

### 4. 支付回调的幂等性保证

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

---

### 5. 服务端验证 vs 客户端验证

| 维度 | 服务端验证 | 客户端验证 |
|------|-----------|-----------|
| 安全性 | 高（私钥不暴露） | 低（可被篡改） |
| 可靠性 | 高（回调可重试） | 低（用户可能关闭 App） |
| 速度 | 需网络请求 | 本地即可 |
| 适用场景 | 所有正式环境 | 仅用于 UI 状态预更新 |

**原则：服务端验证是唯一可信来源。客户端验证只用于优化体验，不能作为发货依据。**

#### IAP 验证的特殊性

[iOS] IAP 的 receipt 必须在服务端向 Apple 验证：

```
App → receipt → 你的服务端 → Apple 验证服务器 → 验证结果
```

Apple 提供两个验证端点：
- 沙盒：`https://sandbox.itunes.apple.com/verifyReceipt`
- 生产：`https://buy.itunes.apple.com/verifyReceipt`

**坑**：审核期间 App 走沙盒环境，但 Apple 审核用的是生产环境。最佳实践是**先请求生产端点，如果返回沙盒错误码（21007），再请求沙盒端点**：

```python
def verify_receipt(receipt_data):
    # 先尝试生产环境
    result = requests.post('https://buy.itunes.apple.com/verifyReceipt',
                          json={'receipt-data': receipt_data})
    if result.json().get('status') == 21007:
        # 沙盒 receipt 发到了生产端点，转去沙盒验证
        result = requests.post('https://sandbox.itunes.apple.com/verifyReceipt',
                              json={'receipt-data': receipt_data})
    return result.json()
```

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

```dart
// App 端补偿查询
class PaymentCompensator {
  Timer? _pollTimer;

  /// 支付完成后启动轮询
  void startPolling(String orderId) {
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (timer) async {
      final order = await _api.getOrderStatus(orderId);
      if (order.status == OrderStatus.paid || timer.tick >= 10) {
        timer.cancel();
        _updateUI(order);
      }
    });
  }
}
```

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

[iOS] IAP 中如果 App 在 `finishTransaction` 之前崩溃，交易会一直挂在 Apple 服务器上。App 重新启动后，`purchaseStream` 会再次收到这些未完成的交易。**必须处理这种情况，否则用户无法继续购买。**

```dart
// 启动时检查未完成交易
void checkPendingTransactions() {
  _iap.purchaseStream.listen((purchases) {
    for (final purchase in purchases) {
      // 未 finish 的交易会在这里重新出现
      _verifyAndDeliver(purchase);
    }
  });
}
```

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

[Android] 微信支付跳转到微信 App 后，如果用户在微信中停留时间过长，原 App 进程可能被系统回收，导致回调 Activity 无法正常接收结果。需要在 `onCreate` 中恢复状态，或通过服务端主动查询兜底。

---

## 面试追问

###  支付掉单怎么处理？

掉单是指用户已支付但服务端未收到回调。处理方案有三层：1) App 端轮询补偿——支付完成后主动查询服务端订单状态；2) 服务端定时对账——定期扫描"支付中"超时的订单，主动调用支付平台查询 API；3) 支付平台回调重试——确保回调接口幂等，重复回调不会重复发货。关键是多层补偿，不依赖单一通道。

###  IAP 审核要注意什么？

[iOS] 核心注意点：1) 虚拟商品必须走 IAP，不能用第三方支付；2) 非消耗型商品和订阅必须提供"恢复购买"功能；3) 价格展示必须与 App Store 一致，不能显示其他支付方式的价格；4) 不能引导用户到网页支付来绕过 IAP；5) IAP 商品价格由 Apple 定价，开发者不能自定义精确价格。

###  微信支付和支付宝支付的技术差异是什么？

微信支付必须跳转到微信 App，需要配置 Universal Link（iOS）/ 回调 Activity（Android）处理返回；支付宝支持 App 内 SDK 直接支付，不依赖是否安装支付宝 App。微信支付的回调依赖 `wxapi/WXPayEntryActivity`，类名和包名必须严格匹配；支付宝回调依赖 URL Scheme。两者都需要服务端异步通知作为最终确认，客户端回调只用于 UI 更新。

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
- [Apple Server-to-Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications)
