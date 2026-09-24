# Dart / Flutter 中 Stream 与 StreamController 详细解析：底层原理、实战使用与工程最佳实践

> 适用对象：已经熟悉 Dart / Flutter 基础语法，希望深入理解异步数据流、事件驱动、响应式编程、页面状态通知、网络进度、WebSocket、表单输入、BLoC / RxDart 等场景的开发者。

---

## 目录

- [一、Stream 要解决什么问题](#一stream-要解决什么问题)
- [二、Future 与 Stream 的核心区别](#二future-与-stream-的核心区别)
- [三、Stream 的基本概念](#三stream-的基本概念)
- [四、Stream 的生命周期](#四stream-的生命周期)
- [五、Stream 底层原理：事件源、订阅者与调度](#五stream-底层原理事件源订阅者与调度)
- [六、StreamController 是什么](#六streamcontroller-是什么)
- [七、StreamController 的核心 API](#七streamcontroller-的核心-api)
- [八、单订阅 Stream 与广播 Stream](#八单订阅-stream-与广播-stream)
- [九、同步 StreamController 与异步 StreamController](#九同步-streamcontroller-与异步-streamcontroller)
- [十、StreamSubscription：暂停、恢复、取消](#十streamsubscription暂停恢复取消)
- [十一、Stream 的常用操作符](#十一stream-的常用操作符)
- [十二、错误处理机制](#十二错误处理机制)
- [十三、Flutter 中的 StreamBuilder](#十三flutter-中的-streambuilder)
- [十四、实战一：用 StreamController 实现计数器](#十四实战一用-streamcontroller-实现计数器)
- [十五、实战二：搜索输入防抖 debounce](#十五实战二搜索输入防抖-debounce)
- [十六、实战三：WebSocket 消息流封装](#十六实战三websocket-消息流封装)
- [十七、实战四：下载进度流](#十七实战四下载进度流)
- [十八、实战五：BLoC 风格状态管理](#十八实战五bloc-风格状态管理)
- [十九、常见问题与坑](#十九常见问题与坑)
- [二十、源码理解路径](#二十源码理解路径)
- [二十一、GitHub 上相关开源项目](#二十一github-上相关开源项目)
- [二十二、相关概念扩展](#二十二相关概念扩展)
- [二十三、总结](#二十三总结)

---

# 一、Stream 要解决什么问题

在 Dart / Flutter 中，`Stream` 用来表达：

> 一段时间内，可能连续产生多个异步事件的数据源。

它适合处理“不是一次性返回，而是持续产生”的数据。

典型场景包括：

1. 用户输入框内容持续变化；
2. WebSocket 持续接收消息；
3. 文件下载进度持续变化；
4. 定时器周期性触发；
5. 蓝牙、定位、传感器数据持续上报；
6. Firebase / 数据库监听实时变化；
7. Flutter 页面状态随事件驱动更新；
8. BLoC 架构中的事件流与状态流。

如果说 `Future` 描述的是：

```dart
未来某一刻给我一个结果。
```

那么 `Stream` 描述的是：

```dart
未来一段时间内，不断给我多个结果。
```

---

# 二、Future 与 Stream 的核心区别

## 2.1 Future：一次性异步结果

```dart
Future<String> fetchUserName() async {
  await Future.delayed(const Duration(seconds: 1));
  return 'han';
}
```

`Future` 只能完成一次：

- 成功一次；
- 或失败一次；
- 完成之后不能再次产生数据。

## 2.2 Stream：多次异步事件

```dart
Stream<int> countStream() async* {
  for (var i = 0; i < 3; i++) {
    await Future.delayed(const Duration(seconds: 1));
    yield i;
  }
}
```

这个 `Stream` 会依次产生：

```text
0
1
2
完成
```

## 2.3 对比表

| 维度 | Future | Stream |
|---|---|---|
| 数据次数 | 只能一次 | 可以多次 |
| 表达含义 | 一个异步结果 | 一组异步事件序列 |
| 常见场景 | HTTP 请求、文件读取、初始化 | WebSocket、输入监听、下载进度、状态流 |
| 是否可以取消 | 通常不易取消 | 可以通过 StreamSubscription 取消 |
| 是否可以暂停 | 不支持 | 支持 pause / resume |
| Flutter 对应 Widget | FutureBuilder | StreamBuilder |

---

# 三、Stream 的基本概念

一个完整的 Stream 模型里通常有 4 个角色。

## 3.1 事件源：Event Source

事件源负责产生数据，例如：

- 定时器；
- Socket；
- 文件读取器；
- 用户输入；
- 手动调用 `controller.add()`；
- `async*` 函数中的 `yield`。

## 3.2 Stream：事件管道

`Stream<T>` 本身不是数据，而是“数据流的抽象”。

它像一根管道：

```text
事件源 ---> Stream ---> listener
```

Stream 的泛型 `T` 表示每个事件的数据类型。

例如：

```dart
Stream<int>
Stream<String>
Stream<User>
Stream<AppState>
```

## 3.3 Listener：监听者

监听者通过 `listen()` 订阅 Stream。

```dart
final subscription = stream.listen((event) {
  print('收到事件: $event');
});
```

## 3.4 StreamSubscription：订阅关系

`listen()` 返回的是 `StreamSubscription<T>`。

它代表：

> 某个监听者和某条 Stream 之间的订阅关系。

可以用它来：

```dart
subscription.pause();
subscription.resume();
await subscription.cancel();
```

这点非常重要。

`Stream` 是数据源抽象，`StreamSubscription` 才是真正控制监听生命周期的对象。

---

# 四、Stream 的生命周期

一个 Stream 的典型生命周期如下：

```text
创建 Stream
   ↓
等待监听 listen
   ↓
建立 StreamSubscription
   ↓
事件源开始产生数据
   ↓
发送 data / error / done
   ↓
监听者处理事件
   ↓
取消订阅或 Stream 完成
   ↓
释放资源
```

示例：

```dart
void main() {
  final stream = Stream<int>.periodic(
    const Duration(seconds: 1),
    (count) => count,
  ).take(3);

  final subscription = stream.listen(
    (event) {
      print('data: $event');
    },
    onError: (error, stackTrace) {
      print('error: $error');
    },
    onDone: () {
      print('done');
    },
    cancelOnError: false,
  );
}
```

输出：

```text
data: 0
data: 1
data: 2
done
```

---

# 五、Stream 底层原理：事件源、订阅者与调度

## 5.1 Stream 不是“集合”，而是“异步事件序列”

很多人初学时会把 Stream 理解成 List：

```dart
Stream<int> ≈ List<int>
```

这是不准确的。

更准确的理解是：

```dart
Stream<int> ≈ Future<int> + Future<int> + Future<int> + ... + done
```

也可以理解为：

```text
时间轴上的多个事件
```

例如：

```text
0s      1s      2s      3s
|-------|-------|-------|
        A       B       C
```

Stream 关心的不只是“有哪些值”，还关心：

1. 什么时候产生；
2. 以什么顺序产生；
3. 是否出错；
4. 是否结束；
5. 订阅者是否还存在；
6. 订阅者是否暂停；
7. 是否允许多个订阅者。

## 5.2 Stream 的三类事件

Stream 只能发送三类事件：

```text
Data Event
Error Event
Done Event
```

对应到 API：

```dart
controller.add(data);
controller.addError(error, stackTrace);
controller.close();
```

其中：

- `add`：发送普通数据；
- `addError`：发送错误事件；
- `close`：发送完成事件；
- `done` 之后不能再发送任何事件。

## 5.3 监听者的处理函数

```dart
stream.listen(
  (data) {},
  onError: (error, stackTrace) {},
  onDone: () {},
);
```

三类事件分别对应：

| Stream 事件 | listen 回调 |
|---|---|
| data | onData |
| error | onError |
| done | onDone |

## 5.4 底层分发模型

抽象地看，Stream 内部类似下面这种结构：

```dart
class ConceptualStream<T> {
  final List<ConceptualSubscription<T>> _subscriptions = [];

  void listen(void Function(T data) onData) {
    _subscriptions.add(ConceptualSubscription(onData));
  }

  void emit(T data) {
    for (final sub in _subscriptions) {
      sub.onData(data);
    }
  }
}
```

真实的 Dart Stream 实现比这个复杂得多，因为它还需要处理：

1. 单订阅限制；
2. 广播订阅；
3. pause / resume；
4. cancel；
5. Zone；
6. error stackTrace；
7. sync / async 调度；
8. backpressure 弱支持；
9. 事件缓冲；
10. 关闭状态。

但从工程理解角度，可以先记住一句话：

> Stream 的核心，是把事件源产生的 data / error / done 按规则分发给订阅者。

## 5.5 async* 与 yield 的底层语义

```dart
Stream<int> createStream() async* {
  yield 1;
  yield 2;
  yield 3;
}
```

`async*` 本质上是 Dart 提供的语法糖。它帮助你创建一个 Stream，并在函数内部用 `yield` 发送数据。官方对 Stream 用法的系统介绍见 [dart.dev：Using streams](https://dart.dev/libraries/async/using-streams)。

可以粗略理解为：

```dart
Stream<int> createStream() {
  final controller = StreamController<int>();

  Future(() async {
    controller.add(1);
    controller.add(2);
    controller.add(3);
    await controller.close();
  });

  return controller.stream;
}
```

当然，真实实现会比这个模拟严格得多，有四个关键差异必须记住：

1. **惰性启动**：调用 `async*` 函数本身不会执行函数体，只是返回一个 Stream；直到有人 `listen`，函数体才开始执行。上面的模拟代码用了 `Future(...)`，即使没人监听也会执行，这是它失真的地方；
2. **单订阅**：`async*` 返回的 Stream 只能被 listen 一次，第二次 listen 抛 `Bad state: Stream has already been listened to.`；
3. **暂停即挂起**：消费者暂停订阅时，生成器会停在 `yield` 处不再往下执行，`resume` 后才继续——这是 `async*` 天然支持背压的原因；
4. **取消即停止**：订阅被 cancel 后，生成器函数体会在下一个挂起点终止，不再产出事件。

其中第 2 点常被拿来和 `Stream.fromIterable` 对比：`fromIterable` 创建的流**可以**被多次 listen，每次 listen 都会从头迭代一遍源集合。所以"单订阅"描述的是"同一时刻只允许一个订阅者"，而 `async*` 更进一步——它连"先取消再重新 listen"都不支持，事件序列本身是一次性的。

## 5.6 await for 的底层语义

```dart
await for (final event in stream) {
  print(event);
}
```

它可以理解为：

```dart
final subscription = stream.listen((event) {
  print(event);
});

await subscription.asFuture<void>();
```

更准确地说，`await for` 会按顺序等待 Stream 的事件，一直到 Stream 关闭。如果循环中 `break`，会取消订阅。

顺带提醒：`asFuture` 会**覆盖**订阅上已有的 `onError` / `onDone` 回调，把错误转成 Future 的异常抛出。它是"等流结束"的接口，不是 `await for` 的等价替代，混用容易出现"明明写了 onError 却没生效"的疑惑。

示例：

```dart
Future<void> main() async {
  final stream = Stream<int>.periodic(
    const Duration(milliseconds: 300),
    (i) => i,
  );

  await for (final value in stream) {
    print(value);

    if (value >= 2) {
      break;
    }
  }

  print('loop finished');
}
```

输出：

```text
0
1
2
loop finished
```

`break` 之后，该订阅会被取消。

`await for` 和 `listen` 还有一个容易被忽略的调度差异，它直接决定了两者对背压的支持程度：

- **`await for`**：循环体执行期间，底层订阅处于暂停状态。要等本次循环体跑完、进入下一轮等待时，订阅才恢复接收。所以消费者处理慢，生产者（比如 `async*` 生成器）就会跟着慢——事件不会在中间堆积；
- **`listen`**：`onData` 回调一返回，订阅立刻可以接收下一个事件。即使 `onData` 里写了 `await`（把回调写成异步函数），也只代表回调函数自身还没跑完，事件仍会继续分发进来——`listen` + 异步回调没有背压能力，处理慢时事件会在订阅内部排队。

`await for` 是"处理完一个再要下一个"，`listen` 是"来一个处理一个、处理不过来就排队"。

---

# 六、StreamController 是什么

`StreamController<T>` 是 Dart 提供的手动控制 Stream 的工具。

> 官方 API 文档：[api.dart.dev/dart-async/StreamController-class.html](https://api.dart.dev/dart-async/StreamController-class.html)

它负责：

1. 创建一条 Stream；
2. 往 Stream 中添加数据；
3. 往 Stream 中添加错误；
4. 关闭 Stream；
5. 监听订阅、暂停、恢复、取消等生命周期钩子。

简单理解：

```text
StreamController = Stream 的生产端控制器
Stream = 暴露给外部的消费端管道
```

典型写法：

```dart
final controller = StreamController<int>();

controller.stream.listen((value) {
  print('收到: $value');
});

controller.add(1);
controller.add(2);
controller.add(3);

await controller.close();
```

输出：

```text
收到: 1
收到: 2
收到: 3
```

## 6.1 为什么不直接暴露 StreamController？

在工程中，不推荐把 `StreamController` 直接暴露给外部。

错误写法：

```dart
class CounterBloc {
  final counterController = StreamController<int>();
}
```

这样外部可以随意调用：

```dart
bloc.counterController.add(999);
bloc.counterController.close();
```

这会破坏封装。

推荐写法：

```dart
class CounterBloc {
  final StreamController<int> _counterController = StreamController<int>();

  Stream<int> get counterStream => _counterController.stream;

  void increment(int value) {
    _counterController.add(value);
  }

  Future<void> dispose() async {
    await _counterController.close();
  }
}
```

对外只暴露 `Stream<int>`，不暴露 `StreamController<int>`。

这符合“读写分离”：

```text
外部只能 listen
内部才能 add / close
```

---

# 七、StreamController 的核心 API

## 7.1 创建

```dart
final controller = StreamController<int>();
```

默认创建的是：

```text
单订阅、异步分发 StreamController
```

## 7.2 获取 Stream

```dart
Stream<int> stream = controller.stream;
```

## 7.3 添加数据

```dart
controller.add(100);
```

## 7.4 添加错误

```dart
controller.addError(
  Exception('network error'),
  StackTrace.current,
);
```

## 7.5 关闭

```dart
await controller.close();
```

关闭后不能再 add。

错误示例：

```dart
await controller.close();
controller.add(1); // Bad state: Cannot add event after closing
```

## 7.6 判断是否关闭

```dart
if (!controller.isClosed) {
  controller.add(1);
}
```

## 7.7 done

```dart
await controller.done;
```

`done` 是一个 `Future`，当 controller 完全关闭后完成。

## 7.8 生命周期回调

```dart
final controller = StreamController<int>(
  onListen: () {
    print('有人开始监听');
  },
  onPause: () {
    print('订阅被暂停');
  },
  onResume: () {
    print('订阅恢复');
  },
  onCancel: () {
    print('订阅取消');
  },
);
```

这些钩子非常适合做资源管理。

例如：

- 有人监听时才开启 Socket；
- 暂停时暂停读取；
- 取消时关闭连接；
- 没有订阅者时释放资源。

两个必须知道的细节：

1. `onPause` / `onResume` 只在**单订阅** controller 上存在。`StreamController.broadcast()` 的构造函数只接受 `onListen` / `onCancel` / `sync` 三个参数，广播订阅的暂停不会通知到 controller（暂停的订阅各自缓冲事件）；
2. 广播 controller 的 `onListen` 在**第一个**监听者订阅时调用，`onCancel` 在**最后一个**监听者取消时调用；之后如果又有新的监听者订阅，`onListen` 会再次触发。所以"连接→复用→断开"的资源管理可以完全建立在这对钩子上。

## 7.9 addStream：批量注入另一个流的事件

```dart
await controller.addStream(otherStream);
```

`addStream` 会把 `otherStream` 的所有事件转发进当前 controller，直到它结束。返回的 Future 完成后，才能继续手动 `add`。

约束：**`addStream` 进行期间不能再调用 `add` / `addError` / `close`**，否则抛出：

```text
Bad state: Cannot add event while adding a stream
```

这个约束在"复用 controller 转发多个来源"时很容易踩到——如果两个地方同时 `addStream` 到同一个 controller，第二个会直接抛错。

---

# 八、单订阅 Stream 与广播 Stream

这是 Stream 中最容易踩坑的地方。

Dart Stream 分为两类：

```text
Single-subscription Stream
Broadcast Stream
```

## 8.1 单订阅 Stream

默认 `StreamController()` 创建的是单订阅 Stream。

```dart
final controller = StreamController<int>();

final stream = controller.stream;

stream.listen((value) {
  print('listener 1: $value');
});

stream.listen((value) {
  print('listener 2: $value');
});
```

这段代码会报错：

```text
Bad state: Stream has already been listened to.
```

原因：默认 Stream 只允许被监听一次。

## 8.2 为什么默认是单订阅？

因为很多异步资源天然只能被消费一次。

例如：

1. 文件读取流；
2. HTTP response body；
3. Socket 输入流；
4. async* 生成的数据序列；
5. 某些有状态的异步任务。

这些数据流如果被多个监听者同时消费，容易出现资源争夺和语义混乱。

## 8.3 广播 Stream

如果你需要多个监听者，应该使用：

```dart
final controller = StreamController<int>.broadcast();
```

示例：

```dart
final controller = StreamController<int>.broadcast();

controller.stream.listen((value) {
  print('listener 1: $value');
});

controller.stream.listen((value) {
  print('listener 2: $value');
});

controller.add(100);
await controller.close();
```

输出：

```text
listener 1: 100
listener 2: 100
```

## 8.4 广播 Stream 的重要特点

广播 Stream 更像事件总线。

特点：

1. 允许多个 listener；
2. 新 listener 收不到过去已经发出的事件；
3. 没有监听者时，`add` / `addError` 的事件会被直接丢弃（SDK 文档明确：广播 controller 没有内部事件队列，add 时刻没有订阅者就丢弃）；
4. 更适合 UI 事件、全局通知、状态广播；
5. 不适合必须可靠消费的任务队列。

示例：

```dart
final controller = StreamController<int>.broadcast();

controller.add(1);

controller.stream.listen((value) {
  print('listener: $value');
});

controller.add(2);
await controller.close();
```

只会输出：

```text
listener: 2
```

`1` 在监听者出现之前发出，已经被丢弃了。

这与单订阅 controller 形成关键对比：**单订阅 controller 在 `listen` 之前 `add` 的事件不会丢弃，而是全部缓冲（包括 close 产生的 done 事件），等第一个监听者到来后依次补发**。所以单订阅流"先 add 后 listen"不丢数据，广播流"先 add 后 listen"丢数据。

## 8.5 asBroadcastStream

你也可以把一个单订阅 Stream 转成广播 Stream：

```dart
final source = Stream<int>.periodic(
  const Duration(seconds: 1),
  (i) => i,
).take(3);

final broadcast = source.asBroadcastStream();
```

注意：

```dart
asBroadcastStream()
```

不是简单复制数据源，而是在内部管理对原始 Stream 的订阅。它适合多个 UI 层 listener 共享同一个源。

它的工作方式：

1. 第一个监听者出现时，才去订阅原始单订阅 Stream（`onListen` 回调触发）；
2. 之后每个 listener 拿到的是独立的广播订阅；
3. 所有 listener 都取消后，`onCancel` 触发。注意此时源订阅**默认不会被自动取消**，只是没有接收者了、事件被丢弃；如果你希望"没人听就暂停或取消源"，需要用 `onListen` / `onCancel` 回调参数里传入的 subscription 主动调用 `pause` / `cancel`（官方文档给的正是这种用法）；
4. 源自然结束（或被主动取消）后再 listen，只会立即收到一个 done 事件。

另一个要点：广播出去的订阅者即使**全部**暂停，也不会暂停底层源——源照常产出事件，暂停的订阅各自在内部缓冲，恢复后补发。所以不要指望 `asBroadcastStream` 帮你做背压。

---

# 九、同步 StreamController 与异步 StreamController

`StreamController` 默认是异步分发。

```dart
final controller = StreamController<int>();
```

等价于：

```dart
final controller = StreamController<int>(sync: false);
```

也可以创建同步分发：

```dart
final controller = StreamController<int>(sync: true);
```

## 9.1 默认异步分发

示例：

```dart
import 'dart:async';

void main() {
  final controller = StreamController<int>();

  controller.stream.listen((value) {
    print('listen: $value');
  });

  print('before add');
  controller.add(1);
  print('after add');

  controller.close();
}
```

常见输出：

```text
before add
after add
listen: 1
```

因为事件不是在 `add` 的调用栈中立即同步分发，而是被放入订阅的待处理队列，再通过 `scheduleMicrotask` 调度到事件循环的微任务阶段执行（SDK 源码中 `_AsyncStreamControllerDispatch._sendData` 的实现就是 `_addPending(_DelayedData(...))`）。所以 `add` 之后的所有同步代码都会先执行完。

## 9.2 同步分发

```dart
import 'dart:async';

void main() {
  final controller = StreamController<int>(sync: true);

  controller.stream.listen((value) {
    print('listen: $value');
  });

  print('before add');
  controller.add(1);
  print('after add');

  controller.close();
}
```

输出：

```text
before add
listen: 1
after add
```

## 9.3 什么时候使用 sync: true？

大多数业务代码不要使用 `sync: true`。

同步分发会带来：

1. 调用栈更深；
2. 重入问题；
3. 状态还没更新完，监听者已经被触发；
4. Flutter build 期间触发状态更新的风险更高；
5. 更难调试。

除非你明确需要低延迟同步事件，并且完全理解重入影响，否则保持默认即可。

## 9.4 重入问题示例

```dart
final controller = StreamController<int>(sync: true);

controller.stream.listen((value) {
  print('listener: $value');

  if (value < 3) {
    controller.add(value + 1);
  }
});

controller.add(1);
await Future<void>.delayed(Duration.zero);
await controller.close();
```

输出：

```text
listener: 1
listener: 2
listener: 3
```

一个容易忽略的细节：即使是 `sync: true` 的 controller，在监听回调执行期间再次 `add` 的事件也不会立即重入分发，而是先进入订阅的待处理队列，等当前回调返回后再继续分发（这是 SDK 内部用"回调执行中"状态位实现的保护，防止无限递归）。

因此上面必须先 `await Future<void>.delayed(Duration.zero)` 让排队事件全部分发完，再 `close`。如果直接紧跟 `controller.close()`，处理 `2` 时回调里的 `add(3)` 就会撞上已关闭的 controller，抛出 `Bad state: Cannot add event after closing`。

这种递归式事件触发可能让状态机变得复杂。默认异步分发可以降低这类风险。

还要注意：`sync: true` 的**广播** controller 比单订阅的更严格。在它的监听回调里直接 `add`，不会像单订阅那样排队等待，而是直接抛出：

```text
Bad state: Cannot fire new event. Controller is already firing an event
```

因为广播 controller 在同步分发时必须保证一个事件完整地发给所有监听者，不允许中途插入新事件。

---

# 十、StreamSubscription：暂停、恢复、取消

`listen()` 的返回值非常重要。

> 官方 API 文档：[api.dart.dev/dart-async/StreamSubscription-class.html](https://api.dart.dev/dart-async/StreamSubscription-class.html)

```dart
final subscription = stream.listen((event) {
  print(event);
});
```

## 10.1 pause

```dart
subscription.pause();
```

暂停之后，事件不会继续交给当前 listener 处理。

pause 是有计数的：连续调用多次 `pause()`，就需要等次数的 `resume()` 才能真正恢复。`pause` 还可以接受一个 `resumeSignal` 参数（一个 Future），该 Future 完成时自动解除这一次暂停：

```dart
subscription.pause(someFuture); // someFuture 完成后自动恢复
```

可以用 `isPaused` 查询当前是否处于暂停状态（pause 次数多于 resume 次数时为 `true`；订阅完成或取消后恒为 `false`）。

暂停期间的语义因流类型而异：

1. **单订阅 Stream**：订阅暂停会触发 controller 的 `onPause`（首次从非暂停变暂停时调用一次），此后 `add` 的事件在订阅内部缓冲，`resume` 后依次补发。这也是一种对源的"背压"信号——例如 `async*` 生成器在消费者暂停时会挂起在 `yield` 处，停止继续生产；
2. **广播 Stream**：某个订阅者暂停只影响它自己，暂停的订阅会在内部缓冲事件（不会丢弃），源和其他订阅者照常运行，controller 层面完全感知不到这次暂停。

## 10.2 resume

```dart
subscription.resume();
```

恢复监听。

## 10.3 cancel

```dart
await subscription.cancel();
```

取消订阅。

在 Flutter 的 `State.dispose()` 里，手动监听 Stream 时必须 cancel。

```dart
class _MyPageState extends State<MyPage> {
  StreamSubscription<int>? _subscription;

  @override
  void initState() {
    super.initState();

    _subscription = Stream.periodic(
      const Duration(seconds: 1),
      (i) => i,
    ).listen((value) {
      print(value);
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const SizedBox();
  }
}
```

## 10.4 cancelOnError

```dart
stream.listen(
  (event) {
    print(event);
  },
  onError: (error) {
    print(error);
  },
  cancelOnError: true,
);
```

当出现 error 事件时自动取消订阅。

---

# 十一、Stream 的常用操作符

Stream 提供了很多类似集合的操作符，但它们处理的是异步事件序列。

> 完整操作符列表见官方 API 文档：[api.dart.dev/dart-async/Stream-class.html](https://api.dart.dev/dart-async/Stream-class.html)。这些操作符都是"惰性"的——调用 `map` / `where` 只是记录转换规则并返回新 Stream，不会开始消费上游，直到最终被 `listen` 或 `await for`。

## 11.1 map

```dart
final stream = Stream.fromIterable([1, 2, 3]);

final mapped = stream.map((value) => value * 10);

await for (final value in mapped) {
  print(value);
}
```

输出：

```text
10
20
30
```

## 11.2 where

```dart
final stream = Stream.fromIterable([1, 2, 3, 4]);

final evenStream = stream.where((value) => value.isEven);

await for (final value in evenStream) {
  print(value);
}
```

输出：

```text
2
4
```

## 11.3 take

```dart
final stream = Stream.periodic(
  const Duration(milliseconds: 300),
  (i) => i,
).take(3);

await for (final value in stream) {
  print(value);
}
```

输出：

```text
0
1
2
```

## 11.4 skip

```dart
final stream = Stream.fromIterable([1, 2, 3, 4]).skip(2);

await for (final value in stream) {
  print(value);
}
```

输出：

```text
3
4
```

## 11.5 distinct

```dart
final stream = Stream.fromIterable([1, 1, 2, 2, 3, 3]).distinct();

await for (final value in stream) {
  print(value);
}
```

输出：

```text
1
2
3
```

## 11.6 asyncMap

适合每个事件都要执行一个异步任务。

```dart
Future<String> fetchName(int id) async {
  await Future.delayed(const Duration(milliseconds: 300));
  return 'user_$id';
}

Future<void> main() async {
  final stream = Stream.fromIterable([1, 2, 3]);

  final result = stream.asyncMap(fetchName);

  await for (final name in result) {
    print(name);
  }
}
```

输出：

```text
user_1
user_2
user_3
```

## 11.7 transform

`transform` 是更底层的流转换能力。

```dart
final transformer = StreamTransformer<int, String>.fromHandlers(
  handleData: (value, sink) {
    sink.add('value = $value');
  },
  handleError: (error, stackTrace, sink) {
    sink.add('error = $error');
  },
  handleDone: (sink) {
    sink.close();
  },
);

final stream = Stream.fromIterable([1, 2, 3]).transform(transformer);

await for (final value in stream) {
  print(value);
}
```

输出：

```text
value = 1
value = 2
value = 3
```

---

# 十二、错误处理机制

## 12.1 通过 listen 的 onError 处理

```dart
final controller = StreamController<int>();

controller.stream.listen(
  (value) {
    print('data: $value');
  },
  onError: (error, stackTrace) {
    print('error: $error');
  },
  onDone: () {
    print('done');
  },
);

controller.add(1);
controller.addError(Exception('something wrong'), StackTrace.current);
controller.add(2);
await controller.close();
```

输出：

```text
data: 1
error: Exception: something wrong
data: 2
done
```

注意：error 事件不一定会终止 Stream。

是否终止取决于：

1. Stream 源的实现；
2. 是否 close；
3. listen 时是否 `cancelOnError: true`。

## 12.2 handleError

```dart
final stream = Stream<int>.error(Exception('fail'));

final safeStream = stream.handleError((error) {
  print('handled: $error');
});

await for (final value in safeStream) {
  print(value);
}
```

## 12.3 在 async* 中抛错

```dart
Stream<int> createStream() async* {
  yield 1;
  throw Exception('boom');
}

Future<void> main() async {
  createStream().listen(
    print,
    onError: (error) {
      print('error: $error');
    },
    onDone: () {
      print('done');
    },
  );
}
```

输出：

```text
1
error: Exception: boom
done
```

`async*` 函数体里抛出的异常会作为 error 事件发给订阅者，随后流关闭、触发 `onDone`——错误不会跳过 done 事件。

## 12.4 忘记写 onError 会怎样

如果 `listen` 时不提供 `onError`，error 事件不会被"静默忽略"，而是被当作**未处理异常**交给当前 Zone 的 `handleUncaughtError` 处理：

- 默认 Zone 下表现为打印堆栈并终止程序（命令行）或被框架捕获上报；
- 可以用 `runZonedGuarded` 统一兜底。

```dart
runZonedGuarded(() {
  final controller = StreamController<int>();
  controller.stream.listen((value) => print('data: $value')); // 没传 onError
  controller.add(1);
  controller.addError(Exception('no handler'));
  controller.add(2);
  controller.close();
}, (error, stackTrace) {
  print('zone caught: $error');
});
```

这段代码会依次打印 `data: 1`、`zone caught: Exception: no handler`、`data: 2`——错误被 zone 兜住后，流本身还在继续。如果去掉 `runZonedGuarded`，error 事件就会成为未处理异常，程序在分发该错误时直接终止，`data: 2` 永远打印不出来。

生产代码里，凡是可能出错的流，`onError` 不是可选项。

---

# 十三、Flutter 中的 StreamBuilder

`StreamBuilder<T>` 是 Flutter 中消费 Stream 的常用 Widget。

它会监听 Stream，并根据 `AsyncSnapshot<T>` 构建 UI。

基本结构：

```dart
StreamBuilder<int>(
  stream: counterStream,
  initialData: 0,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return Text('error: ${snapshot.error}');
    }

    final value = snapshot.data ?? 0;

    return Text('value: $value');
  },
)
```

## 13.1 AsyncSnapshot 的状态

常见状态：

| 状态 | 含义 |
|---|---|
| ConnectionState.none | 没有 Stream |
| ConnectionState.waiting | 已连接，但还没收到数据 |
| ConnectionState.active | 正在接收数据 |
| ConnectionState.done | Stream 已完成 |

## 13.2 不要在 build 中创建 StreamController

错误写法：

```dart
@override
Widget build(BuildContext context) {
  final controller = StreamController<int>();

  return StreamBuilder<int>(
    stream: controller.stream,
    builder: (context, snapshot) {
      return Text('${snapshot.data}');
    },
  );
}
```

原因：

`build` 可能频繁执行，每次都会创建新的 controller，导致：

1. 旧 controller 没有关闭；
2. StreamBuilder 反复换源；
3. 数据丢失；
4. 内存泄漏；
5. UI 状态不稳定。

正确做法是在 `State` 中持有 controller。

```dart
class CounterPage extends StatefulWidget {
  const CounterPage({super.key});

  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  late final StreamController<int> _controller;
  int _count = 0;

  @override
  void initState() {
    super.initState();
    _controller = StreamController<int>();
    _controller.add(_count);
  }

  @override
  void dispose() {
    _controller.close();
    super.dispose();
  }

  void _increment() {
    _count++;
    if (!_controller.isClosed) {
      _controller.add(_count);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Counter Stream')),
      body: Center(
        child: StreamBuilder<int>(
          stream: _controller.stream,
          initialData: _count,
          builder: (context, snapshot) {
            return Text(
              '${snapshot.data}',
              style: Theme.of(context).textTheme.displayMedium,
            );
          },
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _increment,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

---

# 十四、实战一：用 StreamController 实现计数器

下面给一个可以直接运行的 Flutter 示例。

## 14.1 完整代码

```dart
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true),
      home: const CounterPage(),
    );
  }
}

class CounterPage extends StatefulWidget {
  const CounterPage({super.key});

  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  late final StreamController<int> _counterController;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _counterController = StreamController<int>();
    _counterController.add(_counter);
  }

  @override
  void dispose() {
    _counterController.close();
    super.dispose();
  }

  void _increment() {
    _counter++;

    if (!_counterController.isClosed) {
      _counterController.add(_counter);
    }
  }

  void _decrement() {
    _counter--;

    if (!_counterController.isClosed) {
      _counterController.add(_counter);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('StreamController Counter')),
      body: Center(
        child: StreamBuilder<int>(
          stream: _counterController.stream,
          initialData: _counter,
          builder: (context, snapshot) {
            if (snapshot.hasError) {
              return Text('Error: ${snapshot.error}');
            }

            final value = snapshot.data ?? 0;

            return Text(
              '$value',
              style: Theme.of(context).textTheme.displayLarge,
            );
          },
        ),
      ),
      floatingActionButton: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FloatingActionButton(
            heroTag: 'decrement',
            onPressed: _decrement,
            child: const Icon(Icons.remove),
          ),
          const SizedBox(width: 16),
          FloatingActionButton(
            heroTag: 'increment',
            onPressed: _increment,
            child: const Icon(Icons.add),
          ),
        ],
      ),
    );
  }
}
```

## 14.2 代码说明

这个例子中：

```dart
_counterController.add(_counter);
```

负责把最新计数值推送到 Stream。

```dart
StreamBuilder<int>
```

负责监听 Stream，并在收到新值时重新构建 UI。

这本质上就是一个最小的响应式状态管理模型：

```text
事件发生
  ↓
状态变化
  ↓
add 新状态
  ↓
StreamBuilder 收到状态
  ↓
UI 更新
```

---

# 十五、实战二：搜索输入防抖 debounce

Dart 原生 Stream 没有内置 `debounceTime`，但可以用 `Timer` + `StreamController` 自己实现一个。

场景：用户在搜索框快速输入时，不希望每输入一个字符就请求接口，而是等待用户停止输入一段时间后再搜索。

## 15.1 自定义 debounce transformer

```dart
import 'dart:async';

StreamTransformer<T, T> debounce<T>(Duration duration) {
  Timer? timer;
  StreamController<T>? controller;

  void onData(T data) {
    timer?.cancel();
    timer = Timer(duration, () {
      controller?.add(data);
    });
  }

  void onDone() {
    timer?.cancel();
    controller?.close();
  }

  return StreamTransformer<T, T>.fromBind((stream) {
    controller = StreamController<T>(
      onListen: () {
        stream.listen(
          onData,
          onError: controller?.addError,
          onDone: onDone,
        );
      },
      onCancel: () {
        timer?.cancel();
      },
    );

    return controller!.stream;
  });
}
```

上面这个版本演示了原理，但在严谨工程中，推荐把内部订阅也保存并取消。

## 15.2 更严谨的 debounce transformer

```dart
import 'dart:async';

StreamTransformer<T, T> debounce<T>(Duration duration) {
  return StreamTransformer<T, T>.fromBind((source) {
    late final StreamController<T> controller;
    StreamSubscription<T>? subscription;
    Timer? timer;
    var isSourceDone = false;

    void emit(T data) {
      if (!controller.isClosed) {
        controller.add(data);
      }
    }

    controller = StreamController<T>(
      onListen: () {
        subscription = source.listen(
          (data) {
            timer?.cancel();
            timer = Timer(duration, () {
              emit(data);

              if (isSourceDone && !controller.isClosed) {
                controller.close();
              }
            });
          },
          onError: (Object error, StackTrace stackTrace) {
            if (!controller.isClosed) {
              controller.addError(error, stackTrace);
            }
          },
          onDone: () {
            isSourceDone = true;

            if (timer == null || !timer!.isActive) {
              controller.close();
            }
          },
        );
      },
      onPause: () {
        subscription?.pause();
      },
      onResume: () {
        subscription?.resume();
      },
      onCancel: () async {
        timer?.cancel();
        await subscription?.cancel();
      },
    );

    return controller.stream;
  });
}
```

## 15.3 Flutter 搜索页面示例

```dart
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true),
      home: const SearchPage(),
    );
  }
}

class SearchPage extends StatefulWidget {
  const SearchPage({super.key});

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  late final StreamController<String> _keywordController;
  late final StreamSubscription<String> _searchSubscription;

  String _result = '请输入关键字';

  @override
  void initState() {
    super.initState();

    _keywordController = StreamController<String>();

    _searchSubscription = _keywordController.stream
        .map((text) => text.trim())
        .where((text) => text.isNotEmpty)
        .distinct()
        .transform(debounce(const Duration(milliseconds: 500)))
        .listen(_search);
  }

  @override
  void dispose() {
    _searchSubscription.cancel();
    _keywordController.close();
    super.dispose();
  }

  Future<void> _search(String keyword) async {
    setState(() {
      _result = '搜索中：$keyword';
    });

    await Future.delayed(const Duration(milliseconds: 300));

    if (!mounted) {
      return;
    }

    setState(() {
      _result = '搜索结果：$keyword';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Search Debounce')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                labelText: '搜索',
              ),
              onChanged: _keywordController.add,
            ),
            const SizedBox(height: 24),
            Text(_result),
          ],
        ),
      ),
    );
  }
}

StreamTransformer<T, T> debounce<T>(Duration duration) {
  return StreamTransformer<T, T>.fromBind((source) {
    late final StreamController<T> controller;
    StreamSubscription<T>? subscription;
    Timer? timer;
    var isSourceDone = false;

    controller = StreamController<T>(
      onListen: () {
        subscription = source.listen(
          (data) {
            timer?.cancel();
            timer = Timer(duration, () {
              if (!controller.isClosed) {
                controller.add(data);
              }

              if (isSourceDone && !controller.isClosed) {
                controller.close();
              }
            });
          },
          onError: (Object error, StackTrace stackTrace) {
            if (!controller.isClosed) {
              controller.addError(error, stackTrace);
            }
          },
          onDone: () {
            isSourceDone = true;

            if (timer == null || !timer!.isActive) {
              controller.close();
            }
          },
        );
      },
      onPause: () => subscription?.pause(),
      onResume: () => subscription?.resume(),
      onCancel: () async {
        timer?.cancel();
        await subscription?.cancel();
      },
    );

    return controller.stream;
  });
}
```

## 15.4 实战说明

这个例子中的数据流是：

```text
TextField.onChanged
  ↓
_keywordController.add
  ↓
stream.map trim
  ↓
where 非空过滤
  ↓
distinct 去重
  ↓
debounce 防抖
  ↓
listen 执行搜索
```

这就是 Stream 在实际业务中非常典型的用法：

> 把一连串用户事件转成可组合、可过滤、可变换的异步数据流。

---

# 十六、实战三：WebSocket 消息流封装

WebSocket 是 Stream 非常典型的使用场景。

## 16.1 设计目标

我们希望封装一个类：

1. 对外暴露消息 Stream；
2. 内部管理连接；
3. 支持发送消息；
4. 支持关闭连接；
5. 不直接暴露内部 controller。

## 16.2 示例代码

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';

class SocketMessage {
  const SocketMessage({
    required this.type,
    required this.payload,
  });

  final String type;
  final Map<String, dynamic> payload;

  factory SocketMessage.fromJson(Map<String, dynamic> json) {
    return SocketMessage(
      type: json['type'] as String? ?? 'unknown',
      payload: json['payload'] as Map<String, dynamic>? ?? const {},
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'payload': payload,
    };
  }
}

class WebSocketClient {
  WebSocketClient(this.url);

  final String url;

  final StreamController<SocketMessage> _messageController =
      StreamController<SocketMessage>.broadcast();

  WebSocket? _socket;
  StreamSubscription<dynamic>? _socketSubscription;

  Stream<SocketMessage> get messages => _messageController.stream;

  Future<void> connect() async {
    if (_socket != null) {
      return;
    }

    try {
      _socket = await WebSocket.connect(url);

      _socketSubscription = _socket!.listen(
        (dynamic data) {
          try {
            final decoded = jsonDecode(data as String) as Map<String, dynamic>;
            final message = SocketMessage.fromJson(decoded);

            if (!_messageController.isClosed) {
              _messageController.add(message);
            }
          } catch (error, stackTrace) {
            if (!_messageController.isClosed) {
              _messageController.addError(error, stackTrace);
            }
          }
        },
        onError: (Object error, StackTrace stackTrace) {
          if (!_messageController.isClosed) {
            _messageController.addError(error, stackTrace);
          }
        },
        onDone: () {
          _socket = null;
        },
        cancelOnError: false,
      );
    } catch (error, stackTrace) {
      if (!_messageController.isClosed) {
        _messageController.addError(error, stackTrace);
      }
      rethrow;
    }
  }

  void send(SocketMessage message) {
    final socket = _socket;

    if (socket == null) {
      throw StateError('WebSocket is not connected.');
    }

    socket.add(jsonEncode(message.toJson()));
  }

  Future<void> close() async {
    await _socketSubscription?.cancel();
    _socketSubscription = null;

    await _socket?.close();
    _socket = null;

    await _messageController.close();
  }
}
```

## 16.3 使用示例

```dart
Future<void> main() async {
  final client = WebSocketClient('wss://example.com/socket');

  final subscription = client.messages.listen(
    (message) {
      print('message: ${message.type}, ${message.payload}');
    },
    onError: (error) {
      print('socket error: $error');
    },
  );

  await client.connect();

  client.send(
    const SocketMessage(
      type: 'ping',
      payload: {'time': 123},
    ),
  );

  await Future.delayed(const Duration(seconds: 3));

  await subscription.cancel();
  await client.close();
}
```

## 16.4 为什么 messages 用 broadcast？

因为 WebSocket 消息可能被多个模块关心：

1. UI 页面；
2. 日志模块；
3. 业务状态模块；
4. 心跳模块；
5. 调试面板。

这类消息流更接近“事件广播”，所以适合 broadcast。

---

# 十七、实战四：下载进度流

下载进度也是 Stream 的经典场景。

## 17.1 进度模型

```dart
class DownloadProgress {
  const DownloadProgress({
    required this.received,
    required this.total,
  });

  final int received;
  final int total;

  double get percent {
    if (total <= 0) {
      return 0;
    }

    return received / total;
  }

  @override
  String toString() {
    return 'DownloadProgress(received: $received, total: $total, percent: $percent)';
  }
}
```

## 17.2 模拟下载器

```dart
import 'dart:async';

class FakeDownloader {
  Stream<DownloadProgress> download({
    required int total,
    required int chunkSize,
    Duration interval = const Duration(milliseconds: 300),
  }) async* {
    var received = 0;

    while (received < total) {
      await Future.delayed(interval);

      received += chunkSize;

      if (received > total) {
        received = total;
      }

      yield DownloadProgress(
        received: received,
        total: total,
      );
    }
  }
}
```

## 17.3 Flutter UI 示例

```dart
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true),
      home: const DownloadPage(),
    );
  }
}

class DownloadPage extends StatefulWidget {
  const DownloadPage({super.key});

  @override
  State<DownloadPage> createState() => _DownloadPageState();
}

class _DownloadPageState extends State<DownloadPage> {
  Stream<DownloadProgress>? _progressStream;

  void _startDownload() {
    setState(() {
      _progressStream = FakeDownloader().download(
        total: 1000,
        chunkSize: 100,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final progressStream = _progressStream;

    return Scaffold(
      appBar: AppBar(title: const Text('Download Progress')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (progressStream == null)
              const Text('点击按钮开始下载')
            else
              StreamBuilder<DownloadProgress>(
                stream: progressStream,
                builder: (context, snapshot) {
                  final progress = snapshot.data;
                  final percent = progress?.percent ?? 0;

                  return Column(
                    children: [
                      LinearProgressIndicator(value: percent),
                      const SizedBox(height: 16),
                      Text('${(percent * 100).toStringAsFixed(0)}%'),
                      if (snapshot.connectionState == ConnectionState.done)
                        const Text('下载完成'),
                    ],
                  );
                },
              ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _startDownload,
              child: const Text('开始下载'),
            ),
          ],
        ),
      ),
    );
  }
}

class DownloadProgress {
  const DownloadProgress({
    required this.received,
    required this.total,
  });

  final int received;
  final int total;

  double get percent {
    if (total <= 0) {
      return 0;
    }

    return received / total;
  }
}

class FakeDownloader {
  Stream<DownloadProgress> download({
    required int total,
    required int chunkSize,
    Duration interval = const Duration(milliseconds: 300),
  }) async* {
    var received = 0;

    while (received < total) {
      await Future.delayed(interval);

      received += chunkSize;

      if (received > total) {
        received = total;
      }

      yield DownloadProgress(
        received: received,
        total: total,
      );
    }
  }
}
```

---

# 十八、实战五：BLoC 风格状态管理

StreamController 是早期 BLoC 模式的重要基础。

BLoC 的核心思想：

```text
事件输入 Stream
    ↓
业务逻辑处理
    ↓
状态输出 Stream
    ↓
UI 根据状态重建
```

## 18.1 定义事件

```dart
sealed class CounterEvent {
  const CounterEvent();
}

class IncrementPressed extends CounterEvent {
  const IncrementPressed();
}

class DecrementPressed extends CounterEvent {
  const DecrementPressed();
}

class ResetPressed extends CounterEvent {
  const ResetPressed();
}
```

## 18.2 定义状态

```dart
class CounterState {
  const CounterState({required this.value});

  final int value;

  CounterState copyWith({int? value}) {
    return CounterState(
      value: value ?? this.value,
    );
  }
}
```

## 18.3 Bloc 实现

```dart
import 'dart:async';

class CounterBloc {
  CounterBloc() {
    _eventSubscription = _eventController.stream.listen(_handleEvent);
    _stateController.add(_state);
  }

  final StreamController<CounterEvent> _eventController =
      StreamController<CounterEvent>();

  final StreamController<CounterState> _stateController =
      StreamController<CounterState>.broadcast();

  late final StreamSubscription<CounterEvent> _eventSubscription;

  CounterState _state = const CounterState(value: 0);

  Stream<CounterState> get stream => _stateController.stream;

  CounterState get state => _state;

  void add(CounterEvent event) {
    if (!_eventController.isClosed) {
      _eventController.add(event);
    }
  }

  void _handleEvent(CounterEvent event) {
    final current = _state;

    final nextState = switch (event) {
      IncrementPressed() => current.copyWith(value: current.value + 1),
      DecrementPressed() => current.copyWith(value: current.value - 1),
      ResetPressed() => current.copyWith(value: 0),
    };

    _emit(nextState);
  }

  void _emit(CounterState state) {
    _state = state;

    if (!_stateController.isClosed) {
      _stateController.add(state);
    }
  }

  Future<void> close() async {
    await _eventSubscription.cancel();
    await _eventController.close();
    await _stateController.close();
  }
}
```

## 18.4 Flutter 页面使用

```dart
import 'package:flutter/material.dart';

class CounterBlocPage extends StatefulWidget {
  const CounterBlocPage({super.key});

  @override
  State<CounterBlocPage> createState() => _CounterBlocPageState();
}

class _CounterBlocPageState extends State<CounterBlocPage> {
  late final CounterBloc _bloc;

  @override
  void initState() {
    super.initState();
    _bloc = CounterBloc();
  }

  @override
  void dispose() {
    _bloc.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Counter BLoC')),
      body: Center(
        child: StreamBuilder<CounterState>(
          stream: _bloc.stream,
          initialData: _bloc.state,
          builder: (context, snapshot) {
            final state = snapshot.data ?? _bloc.state;

            return Text(
              '${state.value}',
              style: Theme.of(context).textTheme.displayLarge,
            );
          },
        ),
      ),
      floatingActionButton: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FloatingActionButton(
            heroTag: 'minus',
            onPressed: () => _bloc.add(const DecrementPressed()),
            child: const Icon(Icons.remove),
          ),
          const SizedBox(width: 16),
          FloatingActionButton(
            heroTag: 'reset',
            onPressed: () => _bloc.add(const ResetPressed()),
            child: const Icon(Icons.refresh),
          ),
          const SizedBox(width: 16),
          FloatingActionButton(
            heroTag: 'plus',
            onPressed: () => _bloc.add(const IncrementPressed()),
            child: const Icon(Icons.add),
          ),
        ],
      ),
    );
  }
}
```

## 18.5 为什么状态流用 broadcast？

因为状态可能被多个位置监听：

1. 页面主体；
2. AppBar；
3. 调试面板；
4. 日志模块；
5. 其他业务模块。

但事件输入流一般不需要广播，因为事件应该由 Bloc 单独消费。

---

# 十九、常见问题与坑

## 19.1 Bad state: Stream has already been listened to

原因：单订阅 Stream 被 listen 了多次。

错误示例：

```dart
final controller = StreamController<int>();
final stream = controller.stream;

stream.listen(print);
stream.listen(print); // 报错
```

解决方案：

1. 确认是否真的需要多个监听者；
2. 如果需要，使用 `StreamController.broadcast()`；
3. 或者使用 `asBroadcastStream()`；
4. Flutter 中避免多个 StreamBuilder 监听同一个单订阅 Stream。

## 19.2 Bad state: Cannot add event after closing

原因：controller 已经 close，仍然调用 add。

解决：

```dart
if (!controller.isClosed) {
  controller.add(value);
}
```

但更根本的做法是理清生命周期，不要让异步回调在对象销毁后继续写入。

## 19.3 StreamController 忘记 close

错误：

```dart
class MyState extends State<MyPage> {
  final controller = StreamController<int>();

  @override
  Widget build(BuildContext context) {
    return Container();
  }
}
```

正确：

```dart
@override
void dispose() {
  controller.close();
  super.dispose();
}
```

## 19.4 手动 listen 忘记 cancel

错误：

```dart
stream.listen((event) {
  setState(() {});
});
```

如果页面销毁后 Stream 还在发事件，就可能导致：

```text
setState() called after dispose()
```

正确：

```dart
late final StreamSubscription<int> _subscription;

@override
void initState() {
  super.initState();
  _subscription = stream.listen((event) {
    if (!mounted) {
      return;
    }

    setState(() {});
  });
}

@override
void dispose() {
  _subscription.cancel();
  super.dispose();
}
```

## 19.5 StreamBuilder 中 stream 对象频繁变化

错误：

```dart
StreamBuilder<int>(
  stream: createStream(),
  builder: ...,
)
```

如果 `createStream()` 每次 build 都返回新 Stream，可能导致不断重新订阅。

正确：

```dart
late final Stream<int> _stream;

@override
void initState() {
  super.initState();
  _stream = createStream();
}
```

## 19.6 broadcast 不等于缓存最近值

很多人误以为广播流类似 Rx 的 BehaviorSubject，会自动保存最近的值。

实际上：

```dart
StreamController.broadcast()
```

不会为新订阅者补发历史数据。

如果你需要“新订阅者立刻获得最近状态”，你应该：

1. 自己保存 state；
2. 给 StreamBuilder 传 `initialData`；
3. 使用 RxDart 的 `BehaviorSubject`；
4. 使用 ValueNotifier、ChangeNotifier、Riverpod、Bloc 等状态工具。

## 19.7 addError 后 Stream 不一定结束

```dart
controller.addError(Exception('fail'));
controller.add(1);
```

这是允许的。

如果你希望出错后结束，需要显式：

```dart
controller.addError(error, stackTrace);
await controller.close();
```

或者 listen 时使用：

```dart
cancelOnError: true
```

## 19.8 不要滥用 StreamController

不是所有状态都需要 StreamController。

如果只是一个页面内部简单状态：

```dart
setState
```

可能更简单。

如果是一个可监听的单值状态：

```dart
ValueNotifier<T>
```

可能更轻量。

如果是复杂业务状态机：

```dart
Bloc / Cubit / Riverpod / GetX
```

可能更规范。

StreamController 更适合：

1. 事件序列；
2. 异步持续数据；
3. 多阶段任务；
4. 状态流架构；
5. 对 pause / resume / cancel 有要求的场景。

---

# 二十、源码理解路径

如果你想读 Dart SDK 源码，可以从以下概念切入：

## 20.1 核心类

常见源码类包括：

```dart
Stream<T>
StreamController<T>
StreamSubscription<T>
StreamTransformer<S, T>
StreamSink<T>
EventSink<T>
```

## 20.2 重点理解的问题

读源码时，不建议一开始逐行看实现。更好的方式是带着问题看。

### 问题一：listen 后发生了什么？

关注：

```dart
stream.listen(...)
```

它如何创建 subscription？

### 问题二：add 后事件如何到达 listener？

关注：

```dart
controller.add(data)
```

它如何进入 pending event 队列？

### 问题三：sync: true 和 sync: false 差异在哪里？

关注事件是立即发送，还是放入异步调度。

### 问题四：pause 后事件怎么处理？

关注 subscription 的状态位与事件缓存。

### 问题五：broadcast 为什么允许多个 listener？

关注广播控制器如何维护多个订阅者。

### 问题六：cancel 后如何释放资源？

关注 onCancel 何时触发，以及 Future 如何完成。

## 20.3 推荐源码阅读顺序

建议顺序：

```text
Stream 抽象接口
  ↓
StreamSubscription 抽象接口
  ↓
StreamController 构造与 add / close
  ↓
单订阅 controller 实现
  ↓
broadcast controller 实现
  ↓
StreamTransformer
  ↓
async* / await for 行为
```

---

# 二十一、GitHub 上相关开源项目

下面列举一些和 Stream / StreamController 关系密切的开源项目或代码方向。具体版本和实现会不断变化，阅读时建议以项目当前 main 分支和官方文档为准。

## 21.1 dart-lang/sdk

Dart 语言与核心库源码，仓库地址：[github.com/dart-lang/sdk](https://github.com/dart-lang/sdk)。`Stream` / `StreamController` 的实现主要在 `sdk/lib/async/` 目录下的 `stream.dart`、`stream_controller.dart`、`stream_impl.dart`、`broadcast_stream_controller.dart`。

重点关注：

```text
dart:async
Stream
StreamController
StreamSubscription
StreamTransformer
```

适合用来理解 Stream 的真正底层实现。

## 21.2 ReactiveX/rxdart

RxDart 是 Dart 生态中非常重要的响应式扩展库，仓库地址：[github.com/ReactiveX/rxdart](https://github.com/ReactiveX/rxdart)，包主页：[pub.dev/packages/rxdart](https://pub.dev/packages/rxdart)。

它在 Dart Stream 之上提供了更多操作符和 Subject 类型，例如：

```dart
PublishSubject
BehaviorSubject
ReplaySubject
debounceTime
switchMap
combineLatest
```

如果你觉得原生 Stream 操作符不够用，RxDart 是非常值得学习的库。

## 21.3 felangel/bloc

Flutter BLoC 生态的核心库之一，仓库地址：[github.com/felangel/bloc](https://github.com/felangel/bloc)。

它不是简单暴露 StreamController 给业务层，而是提供了更规范的事件到状态转换模型。

你可以重点看：

1. Event 如何进入 Bloc；
2. State 如何被 emit；
3. BlocBuilder 如何订阅状态变化；
4. Stream 在架构层如何被封装。

## 21.4 firebase/flutterfire

FlutterFire 中大量 API 都与 Stream 有关，仓库地址：[github.com/firebase/flutterfire](https://github.com/firebase/flutterfire)。

例如 Firestore 实时监听：

```dart
FirebaseFirestore.instance
    .collection('users')
    .snapshots();
```

返回的就是 Stream。

这种场景非常典型：远程数据变化不断推送到本地 UI。

## 21.5 dart-lang/web_socket_channel

`web_socket_channel` 封装了 WebSocket 通信，内部也大量使用 Stream / Sink 模型，仓库地址：[github.com/dart-lang/web_socket_channel](https://github.com/dart-lang/web_socket_channel)。

它的 API 非常能体现 Dart 异步设计的典型风格：

```dart
channel.stream.listen(...)
channel.sink.add(...)
```

也就是：

```text
Stream 负责读
Sink 负责写
```

## 21.6 flutter/flutter

Flutter 框架源码中也有大量 Stream 的使用场景，仓库地址：[github.com/flutter/flutter](https://github.com/flutter/flutter)，例如：

1. `StreamBuilder`；
2. 平台事件通道；
3. 图片加载事件；
4. 手势、调度、服务扩展相关机制中的异步事件处理。

其中最适合业务开发者阅读的是：

```dart
StreamBuilder
AsyncSnapshot
```

---

# 二十二、相关概念扩展

## 22.1 StreamSink

`StreamSink<T>` 是数据写入端抽象。

常见 API：

```dart
sink.add(data);
sink.addError(error);
sink.close();
```

它和 Stream 的关系类似：

```text
StreamSink: 写入端
Stream: 读取端
```

## 22.2 EventSink

`EventSink<T>` 常用于 `StreamTransformer` 内部。

它也提供：

```dart
add
addError
close
```

## 22.3 Sink

`Sink<T>` 是更泛化的写入抽象。

```dart
abstract interface class Sink<T> {
  void add(T data);
  void close();
}
```

## 22.4 StreamTransformer

用于把一个 Stream 转成另一个 Stream。

例如：

```text
Stream<int> ---> Stream<String>
```

典型操作包括：

1. map；
2. filter；
3. debounce；
4. throttle；
5. json decode；
6. model parse；
7. error mapping。

另外，官方维护的 [`package:async`](https://pub.dev/packages/async) 在核心库之外补了几个常用的流工具：

- `StreamGroup`：把多条流合并成一条广播流，新事件来自任何一条成员流都会转发（`add` / `close` 动态管理成员）；
- `StreamZip`：把多条流按"各自第 N 个事件"对齐成记录流，任何一条结束就结束。

它们是对 `merge` / `zip` 这类 RxDart 风格操作符的轻量官方替代。

## 22.5 RxDart Subject

Subject 是同时具备 Stream 和 Sink 能力的对象。

常见类型：

| 类型 | 特点 |
|---|---|
| PublishSubject | 只发送订阅后的新事件 |
| BehaviorSubject | 保存最近一个值，新订阅者立即收到最近值 |
| ReplaySubject | 缓存多个历史值，新订阅者可收到历史事件 |

这三个概念对理解 StreamController 很有帮助。

可以粗略理解为：

```text
Subject ≈ StreamController + 更丰富的响应式语义
```

## 22.6 ValueNotifier

`ValueNotifier<T>` 适合单值状态。

```dart
final notifier = ValueNotifier<int>(0);

notifier.value++;
```

与 StreamController 对比：

| 维度 | ValueNotifier | StreamController |
|---|---|---|
| 数据模型 | 当前值 | 事件序列 |
| 是否保存最新值 | 是 | 默认否 |
| 错误事件 | 不支持 | 支持 |
| 完成事件 | 不支持 | 支持 |
| pause / resume | 不支持 | 支持 |
| 适合场景 | 简单 UI 状态 | 异步事件流 |

## 22.7 ChangeNotifier

`ChangeNotifier` 更适合对象状态管理，例如：

```dart
class UserModel extends ChangeNotifier {
  String name = '';

  void updateName(String value) {
    name = value;
    notifyListeners();
  }
}
```

它不关心事件数据本身，只通知“我变了”。

而 Stream 更强调：

```text
我产生了一个具体事件。
```

## 22.8 FutureOr

`FutureOr<T>` 表示：

```dart
T 或 Future<T>
```

在 `asyncMap`、异步转换、统一同步/异步回调时经常会遇到。

## 22.9 Isolate 消息流

Dart Isolate 通信中常见：

```dart
ReceivePort
SendPort
```

`ReceivePort` 本身实现了 Stream，可以被 listen。

```dart
final receivePort = ReceivePort();
receivePort.listen((message) {
  print(message);
});
```

这说明 Stream 是 Dart 异步事件系统中的基础抽象。

---

# 二十三、总结

## 23.1 一句话理解 Stream

```text
Stream 是 Dart 中表示异步事件序列的核心抽象。
```

它不是集合，也不是普通回调，而是一条有生命周期、有错误、有完成、有订阅关系的事件管道。

## 23.2 一句话理解 StreamController

```text
StreamController 是 Stream 的生产端控制器，用来手动 add / addError / close。
```

它适合把外部事件、业务状态、异步任务进度等封装成 Stream。

## 23.3 工程最佳实践

建议遵守以下规则：

1. 对外暴露 `Stream<T>`，不要暴露 `StreamController<T>`；
2. 在 `dispose` 中关闭 controller；
3. 手动 `listen` 时保存并取消 `StreamSubscription`；
4. 默认使用单订阅 Stream，确实需要多个监听者时再用 broadcast；
5. 不要误以为 broadcast 会缓存历史值；
6. 不要在 `build` 中创建 StreamController；
7. 默认不要使用 `sync: true`；
8. 复杂流操作可以考虑 RxDart；
9. 简单 UI 状态优先考虑 `setState` 或 `ValueNotifier`；
10. 长生命周期业务状态可以考虑 Bloc / Riverpod / GetX 等架构方案。

## 23.4 最终心智模型

可以把 Stream 系统理解成：

```text
事件源
  ↓
StreamController.add / addError / close
  ↓
Stream 管道
  ↓
StreamSubscription
  ↓
onData / onError / onDone
  ↓
业务逻辑或 UI 更新
```

在 Flutter 中，这套机制经常表现为：

```text
用户操作 / 网络消息 / 定时器 / 下载进度
  ↓
StreamController
  ↓
StreamBuilder / BlocBuilder / 手动 listen
  ↓
Widget 重建或业务状态更新
```

真正掌握 Stream，不只是会写 `listen()`，而是要理解：

1. 谁生产事件；
2. 谁消费事件；
3. 谁拥有生命周期；
4. 何时取消；
5. 是否允许多个监听者；
6. 事件是否需要缓存；
7. 错误是否应该终止流；
8. 该用 Stream，还是该用更简单的状态工具。

当你能回答这些问题时，Stream / StreamController 就不再只是 Dart 语法，而会成为你构建异步架构、状态流、事件驱动系统的重要基础。
