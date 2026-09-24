# 25 GestureArena 与 TapGestureRecognizer：从原始事件到 onTap

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `gestures/arena.dart`（304 行）、`gestures/recognizer.dart`（844 行）、`gestures/tap.dart`（816 行）、`gestures/pointer_router.dart`（144 行）

## 一、问题

同一个位置上的 `GestureDetector` 可能同时挂着 `onTap`、`onDoubleTap`、`onLongPress`、`onVerticalDragStart`、`onScaleStart`。一串原始的 down / move / up 怎么决定算哪一种？

错误直觉是"看谁先响应"或者"看 widget 层级谁更深"。两种都不对：`GestureArenaManager` 的注释直接写出了真正的规则（`arena.dart:110`）：

> The first member to accept or the last member to not reject wins.

翻译过来是：**第一个声明"我要赢"的人赢；如果没人主动要，那么最后一个没退出的赢。**

这个规则要处理的不只是"谁赢"，还有三件更细的事：多个识别器都想赢怎么办、赢家还没确定时就收到了 up 怎么办、某些识别器需要"拖延判决"（比如双击要等一段时间看有没有第二下）怎么办。`_GestureArena` 的四个字段就是为这三件事准备的。

## 二、最小 Demo

`GestureArenaManager` 是纯逻辑，可以完全脱离 Widget 直接驱动。下面这个 Demo 五行代码就是它的最小用法：

```dart
import 'package:flutter/gestures.dart';

class NamedMember extends GestureArenaMember {
  NamedMember(this.name);
  final String name;
  @override
  void acceptGesture(int pointer) => debugPrint('$name 赢下 pointer $pointer');
  @override
  void rejectGesture(int pointer) => debugPrint('$name 输掉 pointer $pointer');
}

void main() {
  final GestureArenaManager arena = GestureArenaManager();
  // 1. 两个候选者报名，拿到各自的"投票权"句柄
  arena.add(1, NamedMember('tap'));
  final GestureArenaEntry handheld = arena.add(1, NamedMember('longPress'));
  // 2. 关场：之后不再接受新成员
  arena.close(1);
  // 3. 一个成员主动认输，剩一个
  handheld.resolve(GestureDisposition.rejected);
  // 4. 剩下的那个要等一个微任务才会收到 accept
  debugPrint('同步阶段结束');
}
```

输出：

```text
同步阶段结束
longPress 输掉 pointer 1
tap 赢下 pointer 1
```

注意"同步阶段结束"出现在所有回调之前——**最后剩下的那个成员不是立刻获胜的**，这一点是 `close` 路径上最容易读漏的细节（见 4.3）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `gestures/arena.dart:15` | `enum GestureDisposition { accepted, rejected }`，竞技场里只有两种投票 |
| `gestures/arena.dart:31` | `abstract class GestureArenaMember`：`acceptGesture` / `rejectGesture` |
| `gestures/arena.dart:43` | `class GestureArenaEntry`：`resolve(disposition)` 的入口 |
| `gestures/arena.dart:59` | `class _GestureArena`：`members` / `isOpen` / `isHeld` / `hasPendingSweep` / `eagerWinner` |
| `gestures/arena.dart:71` | `_GestureArena.add`：`assert(isOpen)`，关场后不能再加 |
| `gestures/arena.dart:117` | `class GestureArenaManager` |
| `gestures/arena.dart:121` | `add(pointer, member)` → `GestureArenaEntry` |
| `gestures/arena.dart:134` | `close(pointer)`：`isOpen = false` 后立刻 `_tryToResolveArena` |
| `gestures/arena.dart:157` | `sweep(pointer)`：强判胜负，第一个成员赢 |
| `gestures/arena.dart:193` | `hold(pointer)`：延迟 sweep |
| `gestures/arena.dart:211` | `release(pointer)`：解除 hold，若有 pending sweep 则立即执行 |
| `gestures/arena.dart:226` | `_resolve`：真正的投票处理，区分 opened / closed |
| `gestures/arena.dart:251` | `_tryToResolveArena`：只剩 0 / 1 / 有 eagerWinner 三种分支 |
| `gestures/arena.dart:265` | `_resolveByDefault`：`scheduleMicrotask` 的落点 |
| `gestures/arena.dart:278` | `_resolveInFavorOf`：赢家 accept、其余全部 reject |
| `gestures/pointer_router.dart:18` | `_routeMap`：按 pointer 分组的路由表 |
| `gestures/pointer_router.dart:28` | `addRoute(pointer, route, [transform])` |
| `gestures/pointer_router.dart:124` | `route(event)`：先按 pointer 派发，再派发全局路由 |
| `gestures/recognizer.dart:243` | `GestureRecognizer.addPointer`：先 `isPointerAllowed` 再 `addAllowedPointer` |
| `gestures/recognizer.dart:500` | `_addPointerToArena`：有 team 就进 team，否则直接进 arena |
| `gestures/recognizer.dart:519` | `startTrackingPointer`：**同时**登记路由和竞技场 |
| `gestures/recognizer.dart:534` | `stopTrackingPointer`：只删路由，不退出竞技场 |
| `gestures/recognizer.dart:447` | `OneSequenceGestureRecognizer.resolve`：把票投给所有 entry 后清空 |
| `gestures/recognizer.dart:684` | `PrimaryPointerGestureRecognizer.addAllowedPointer`：primary pointer + deadline 计时器 |
| `gestures/recognizer.dart:704` | `handleEvent`：slop 超限 → reject；否则交给 `handlePrimaryPointer` |
| `gestures/tap.dart:202` | `abstract class BaseTapGestureRecognizer` |
| `gestures/tap.dart:276` | `addAllowedPointer`：记住 `_down`（注释说明为什么必须在这里赋值） |
| `gestures/tap.dart:311` | `handlePrimaryPointer`：up / cancel / buttons 变化 / move 分派 |
| `gestures/tap.dart:348` | `acceptGesture`：`_checkDown()` + `_wonArenaForPrimaryPointer` + `_checkUp()` |
| `gestures/tap.dart:370` / `378` / `396` | `_checkDown` 的幂等闸门 / `_checkUp` 的双条件 / `_reset` 清三个位 |
| `gestures/team.dart:139` | `class GestureArenaTeam`，把多个识别器当一个参赛者 |

## 四、调用链

### 4.1 报名：一次 `addPointer` 同时做两件事

`GestureDetector` 的 `_handlePointerDown` 对每个识别器调一次 `addPointer`：

```dart
// recognizer.dart:243-250
void addPointer(PointerDownEvent event) {
  _pointerToKind[event.pointer] = event.kind;
  if (isPointerAllowed(event)) {
    addAllowedPointer(event);
  } else {
    handleNonAllowedPointer(event);
  }
}
```

`OneSequenceGestureRecognizer.addAllowedPointer` 只有一行（`recognizer.dart:402-404`）：`startTrackingPointer(event.pointer, event.transform)`。而 `startTrackingPointer` 是关键的一步——**它同时登记了"我要收事件"和"我要参赛"**：

```dart
// recognizer.dart:519-526
void startTrackingPointer(int pointer, [Matrix4? transform]) {
  GestureBinding.instance.pointerRouter.addRoute(pointer, handleEvent, transform);  // 1. 路由
  _trackedPointers.add(pointer);
  _entries[pointer] = _addPointerToArena(pointer);                                  // 2. 竞技场
}
```

```dart
// recognizer.dart:500-502
GestureArenaEntry _addPointerToArena(int pointer) {
  return _team?.add(pointer, this) ?? GestureBinding.instance.gestureArena.add(pointer, this);
}
```

`startTrackingPointer` 有两个副作用，而且它们**不等价**。`stopTrackingPointer`（`recognizer.dart:534`）只做一半——删路由，**不退出竞技场**。这就是为什么"手指滑出 widget 后识别器仍然可能赢下这场竞技场"：它不再收事件了，但它的票还在。

### 4.2 四张状态位

```dart
// arena.dart:59-69
class _GestureArena {
  final List<GestureArenaMember> members = <GestureArenaMember>[];
  bool isOpen = true;          // 还接受新成员
  bool isHeld = false;         // 有人要求延迟 sweep
  bool hasPendingSweep = false; // sweep 来过但被 isHeld 挡住了
  GestureArenaMember? eagerWinner;  // 关场前就声明 accepted 的人
```

这四个字段的组合，覆盖了竞技场全部可能的中间状态：

| 字段 | 何时被置位 | 何时被清 | 作用 |
|---|---|---|---|
| `isOpen` | 默认 true | `close`（`arena.dart:139`） | 关场前不算胜负，只记 `eagerWinner` |
| `eagerWinner` | 开放期内有人 `accepted`（`arena.dart:236`） | 竞技场被移除 | 让"抢先认领"的人最终胜出 |
| `isHeld` | `hold`（`arena.dart:198`） | `release`（`arena.dart:216`） | 阻止 `sweep` 立即判决 |
| `hasPendingSweep` | held 状态下收到 `sweep`（`arena.dart:164`） | 随竞技场移除 | 记住"欠一次 sweep"，release 时补上 |

`_GestureArena.toString`（`arena.dart:77-103`）把这些位都打了出来，所以调试日志里能直接看到 `[open]` / `[held]` / `[hasPendingSweep]` 三种后缀。

### 4.3 关场：三条分支，其中一条是微任务

`close` 在 PointerDown 分发的最后被调用（第 24 篇 4.4）：

```dart
// arena.dart:134-142
void close(int pointer) {
  final _GestureArena? state = _arenas[pointer];
  if (state == null) {
    return; // This arena either never existed or has been resolved.
  }
  state.isOpen = false;
  _tryToResolveArena(pointer, state);
}
```

```dart
// arena.dart:251-263
void _tryToResolveArena(int pointer, _GestureArena state) {
  assert(!state.isOpen);
  if (state.members.length == 1) {
    scheduleMicrotask(() => _resolveByDefault(pointer, state));   // ← 不是同步的
  } else if (state.members.isEmpty) {
    _arenas.remove(pointer);
  } else if (state.eagerWinner != null) {
    _resolveInFavorOf(pointer, state, state.eagerWinner!);
  }
}
```

三种情况的语义差别很大：

| 关场时的状态 | 结果 | 时机 |
|---|---|---|
| 只剩 1 个成员 | `_resolveByDefault` → 该成员 `acceptGesture` | **微任务** |
| 0 个成员 | 竞技场直接删除，没有任何回调 | 同步 |
| ≥2 个成员且有 `eagerWinner` | `_resolveInFavorOf(eagerWinner)` | 同步 |
| ≥2 个成员且无 `eagerWinner` | 什么都不做，等后续 `reject` 或 `sweep` | — |

只有 1 个识别器时，"默认获胜"走的是 `scheduleMicrotask`，不是同步调用。第 6 节的实验 1 会给出这个差别的证据：`close` 返回后日志仍是空的，让出一个微任务后才出现 `accept`。这个设计让"单一识别器"和"多识别器"在对调用方可见的时序上一致——都是异步出结果。

### 4.4 投票：开着和关了的处理完全不同

```dart
// arena.dart:226-249（节选）
void _resolve(int pointer, GestureArenaMember member, GestureDisposition disposition) {
  final _GestureArena? state = _arenas[pointer];
  if (state == null) {
    return; // This arena has already resolved.
  }
  switch (disposition) {
    case GestureDisposition.accepted:
      if (state.isOpen) {
        state.eagerWinner ??= member;     // 只记录，不立即判
      } else {
        _resolveInFavorOf(pointer, state, member);   // 立刻判
      }
    case GestureDisposition.rejected:
      state.members.remove(member);
      member.rejectGesture(pointer);
      if (!state.isOpen) {
        _tryToResolveArena(pointer, state);
      }
  }
}
```

同样是 `accepted`，在开放期和关场后行为不同：
- **开放期内** `accepted` 只是"预约"（`eagerWinner ??= member`，注意是 `??=`，**先到先得，后来者不会覆盖**）；
- **关场后** `accepted` 立即定胜负，其余成员全部 `rejectGesture`。

而 `rejected` 每次都会同步通知本人，并在关场后重试 `_tryToResolveArena`（因为成员数可能掉到 1 或 0）。

### 4.5 sweep 与 hold：为什么 `onTap` 会晚 300ms

`GestureBinding.handleEvent` 在 `PointerUpEvent` 上调用 `sweep`（第 24 篇 4.4）：

```dart
// arena.dart:157-179（节选）
void sweep(int pointer) {
  final _GestureArena? state = _arenas[pointer];
  if (state == null) {
    return;
  }
  assert(!state.isOpen);
  if (state.isHeld) {
    state.hasPendingSweep = true;    // 记一笔欠账就返回
    return;
  }
  _arenas.remove(pointer);
  if (state.members.isNotEmpty) {
    state.members.first.acceptGesture(pointer);     // 第一个成员赢
    for (var i = 1; i < state.members.length; i++) {
      state.members[i].rejectGesture(pointer);      // 其余全输
    }
  }
}
```

```dart
// arena.dart:211-221
void release(int pointer) {
  final _GestureArena? state = _arenas[pointer];
  if (state == null) {
    return;
  }
  state.isHeld = false;
  if (state.hasPendingSweep) {
    sweep(pointer);      // 补上那次被挡掉的 sweep
  }
}
```

这就是"`onTap` 和 `onDoubleTap` 一起挂时会延迟"的全部机制。`DoubleTapGestureRecognizer` 在收到 down 后会 `hold` 竞技场，等 `kDoubleTapTimeout`（300ms）确认没有第二下再 `reject` 自己；`reject` 让成员数掉到 1，`_tryToResolveArena` 安排微任务让 `TapGestureRecognizer` 获胜——**在此之前 `onTap` 不会触发**。第 6 节实验 4 有完整日志。

### 4.6 路由：为什么删除立即可见、添加要等下一次

`PointerRouter.route` 遍历的是路由表的**副本**，但每次调用前用**原件**检查 `containsKey`（`pointer_router.dart:124-143`）。这个组合产生两条不对称的规则（文档写在 `:26-27` 和 `:42-43`）：

| 操作 | 在 `route` 执行期间发生 | 生效时机 |
|---|---|---|
| `removeRoute` | 原表被改，`containsKey` 变 false | **立即**（本次不再调用） |
| `addRoute` | 副本已生成，新路由不在里面 | **下一次事件** |

路由分两张表（`:18` 按 pointer 分组的 `_routeMap`、`:19` 的 `_globalRoutes`），派发顺序是**先专有、后全局**。所以 `startTrackingPointer` 里新加的路由要等下一个事件才生效——**"按下后立刻能收到自己注册的 down"靠的是 `startTrackingPointer` 在 down 分发期间就被调用，而不是靠路由立即生效**。

### 4.7 `TapGestureRecognizer` 的输出：两边都要满足才回调

`BaseTapGestureRecognizer` 维护两个位：`_sentTapDown`（`tap.dart:214`）和 `_wonArenaForPrimaryPointer`（`tap.dart:215`）。两个回调各自要求其中一位：

```dart
// tap.dart:370-385
void _checkDown() {
  if (_sentTapDown) {
    return;                       // 幂等闸门：down 只发一次
  }
  handleTapDown(down: _down!);
  _sentTapDown = true;
}

void _checkUp() {
  if (!_wonArenaForPrimaryPointer || _up == null) {
    return;                       // 必须"赢过"且"收到 up"两条都满足
  }
  assert(_up!.pointer == _down!.pointer);
  handleTapUp(down: _down!, up: _up!);
  _reset();
}
```

而 `_checkDown` 有两个触发点：

```dart
// tap.dart:342-345
@override
void didExceedDeadline() {
  _checkDown();      // ① 计时器到期（kPressTimeout）
}

// tap.dart:347-355
@override
void acceptGesture(int pointer) {
  super.acceptGesture(pointer);
  if (pointer == primaryPointer) {
    _checkDown();                          // ② 赢下竞技场
    _wonArenaForPrimaryPointer = true;
    _checkUp();                            // 已经收到过 up 就立刻补发
  }
}
```

`_checkDown` 是**幂等的**，谁先到、另一个就变成空操作。所以 `onTapDown` 的触发条件既可能是"按下后过了 `kPressTimeout`"，也可能是"赢下竞技场"，两者谁先发生就是谁——这就是"`onTapDown` 有时比 `onTapUp` 早很多、有时紧挨着"的原因。这一点在 `addAllowedPointer` 的注释里也有暗示（`tap.dart:286-289`）：`_down` 必须在那个方法里就赋好，**因为 `acceptGesture` 可能先于 `handlePrimaryPointer` 被调用**。

而 `_reset()`（`tap.dart:396-401`）会把三个位一起清掉（`_sentTapDown` / `_wonArenaForPrimaryPointer` / `_up`，以及 `_down`），所以每个 `TapGestureRecognizer` 实例在一次完整手势结束后必然回到"未发过 down、未赢过"的初始状态。

## 五、核心对象：两组对比

**第一组：成员与句柄。**

| | `GestureArenaMember` | `GestureArenaEntry` |
|---|---|---|
| 声明位置 | `arena.dart:31` | `arena.dart:43` |
| 形态 | 抽象类，被识别器继承 | 不可变句柄（三个 final 字段） |
| 方法 | `acceptGesture` / `rejectGesture`（**被别人调用**） | `resolve(disposition)`（**自己主动投票**） |
| 数量关系 | 一个识别器 | 一个识别器在一个 pointer 上一次参赛对应一个 |
| 持有者 | 识别器自身 | 识别器的 `_entries[pointer]` |

`OneSequenceGestureRecognizer` 里 `_entries` 是 `Map<int, GestureArenaEntry>`（`recognizer.dart:397`），`resolve(disposition)` 会**遍历所有 entry 投票然后清空**（`recognizer.dart:447-455`）。这就是"一个识别器同时跟踪多个指针"时的语义：对每个 pointer 的竞技场各投一票。

**第二组：两种"赢"。**

| | `sweep` 产生的赢家 | `_resolve` / `_tryToResolveArena` 产生的赢家 |
|---|---|---|
| 触发者 | `GestureBinding.handleEvent` 在 up 时（`binding.dart:532`） | 识别器自己 `resolve(accepted)`，或成员数掉到 1 |
| 选择规则 | **列表第一个**成员（`arena.dart:170-173`） | 主动 accept 的那个 / 唯一剩下的那个 |
| 被打断 | 可被 `hold` 挡下（转为 `hasPendingSweep`） | 不受 `hold` 影响 |
| 语义 | "没人主动要，那就给最早报名的" | "这个识别器自己认领了" |

`sweep` 的"第一个成员赢"值得单独记一句：它**不看能力、不看位置**，只看谁先 `add`。而 `add` 的顺序由 `RawGestureDetectorState._recognizers` 这个 `Map` 的插入顺序决定——但**这个顺序与你在 `GestureDetector(onTap: ..., onLongPress: ...)` 里写参数的顺序无关**（命名参数没有顺序语义），它由框架源码写死：`GestureDetector.build` 按固定顺序构造 gestures map（`widgets/gesture_detector.dart:1065` 起：Tap → DoubleTap → LongPress → VerticalDrag → HorizontalDrag → Pan → Scale → ForcePress），`_syncAll`（`:1535`）按同一顺序填进 `_recognizers`，`_handlePointerDown`（`:1557`）再按 Map 的迭代顺序逐个 `addPointer`，于是 `gestureArena.add` 的先后、也就是 `members.first` 是谁，在你写 widget 时就已经定死了。实验 5 的日志（Tap → LongPress → VerticalDrag → Scale）就是这个固定顺序的直接体现。**"多个手势都不主动认领时，第一个 `add` 的赢——对 `GestureDetector` 来说恒为 Tap"** —— 这是本层最反直觉的一条规则。

## 六、源码实验

### 实验 1：竞技场的五种结局

**改什么**：直接驱动 `GestureArenaManager`，分别构造"单成员关场"、"关场后 sweep"、"hold 后 sweep 再 release"、"开放期内 accept"、"关场后 reject"五种场景。

**预测**：`close`/`sweep` 应该是同步把所有回调发完。

**实际输出**：

```text
A close 同步后: []
A 一个微任务后: [a.accept]
B close 后: b1=[] b2=[]
B sweep 后: b1=[b1.accept] b2=[b2.reject]
C sweep 后（held）: c1=[] c2=[]
C release 后: c1=[c1.accept] c2=[c2.reject]
D eager accept 后: d3=[]
D close 后: d1=[d1.reject] d2=[d2.reject] d3=[d3.accept]
E reject 后（同步）: e1=[]
E reject 后（微任务）: e1=[e1.accept] e2=[e2.reject]
```

**说明**：五组结果逐一对应源码：
- A：`_tryToResolveArena` 走 `scheduleMicrotask`（`arena.dart:255`），所以 `close` 同步返回时日志为空；
- B：`close` 有两个成员且无 `eagerWinner` → 什么都不做；`sweep` 让 `members.first` 赢；
- C：`hold` 之后的 `sweep` 只置 `hasPendingSweep`（`arena.dart:163-167`），`release` 才补做；
- D：开放期内 `accepted` 只记 `eagerWinner`（`arena.dart:235-236`），`close` 时才 `_resolveInFavorOf`；
- E：关场后 `rejected` 让成员数掉到 1，`_tryToResolveArena` 同样走微任务。

`grep -n "scheduleMicrotask" gestures/arena.dart` 只有一处命中（`arena.dart:255`）。这说明"只剩一个成员就默认获胜"在 3.44.8 是**微任务**；老版本里这段逻辑的位置和实现方式不同，所以"单识别器时 `onTap` 是同步还是异步"这个问题的答案会随版本变化。判断这类问题不要凭记忆，直接 grep 落点。

### 实验 2：真实 tap 的竞技场日志

**改什么**：把 `debugPrintGestureArenaDiagnostics`（`gestures/debug.dart:35`）置为 true，跑一次只有 `onTap` 的 `GestureDetector`。

**预测**：应该只有"开竞技场 / 加成员 / 关竞技场"。

**实际输出**：

```text
Gesture arena 2 ❙ ★ Opening new gesture arena.
Gesture arena 2 ❙ Adding: TapGestureRecognizer#27ac7(debugOwner: GestureDetector, state: ready, button: 1)
Gesture arena 2 ❙ Closing with 1 member.
Gesture arena 2 ❙ Default winner: TapGestureRecognizer#27ac7(debugOwner: GestureDetector, state: possible, button: 1)
```

**说明**：只有 1 个成员时，日志里出现的是 **`Default winner`** 而不是 `Winner`——这两个词来自不同的方法（`_resolveByDefault` `arena.dart:274` 与 `sweep` `arena.dart:172`）。**看到 `Default winner` 就知道走的是微任务那条路径。**

### 实验 3：`hold` 是谁发的

**改什么**：给同一个 `GestureDetector` 同时挂 `onTap` 和 `onDoubleTap`，再跑一次。

**实际输出**：

```text
Gesture arena 1 ❙ ★ Opening new gesture arena.
Gesture arena 1 ❙ Adding: TapGestureRecognizer#5814d(...)
Gesture arena 1 ❙ Adding: DoubleTapGestureRecognizer#33204(...)
Gesture arena 1 ❙ Closing with 2 members.
Gesture arena 1 ❙ Holding with 2 members.
Gesture arena 1 ❙ Delaying sweep with 2 members.
```

**说明**：`Holding` 与 `Delaying sweep` 两行是 `DoubleTapGestureRecognizer` 造成的。日志本身就把"谁 hold 了竞技场"暴露出来——**这是排查"点击延迟"最快的办法**，不用读任何识别器代码。

### 实验 4：`onTap` 被延迟了多久

**改什么**：在实验 3 的界面上 tap 一次，只 `pump()` 一帧打印回调，再 `pump(400ms)` 打印一次。

**预测**：`onTap` 应该在 up 的同一帧就触发。

**实际输出**：

```text
TAPS after 1 frame: []
Gesture arena 1 ❙ Rejecting: DoubleTapGestureRecognizer#33204(...)
Gesture arena 1 ❙ Releasing with 1 member.
Gesture arena 1 ❙ Sweeping with 1 member.
Gesture arena 1 ❙ Winner: TapGestureRecognizer#5814d(...)
TAPS after 400ms: [onTap @1420070400300]
```

**说明**：up 之后一帧 `onTap` 还没触发（数组为空）；等到双击超时，`DoubleTapGestureRecognizer` 主动 `Rejecting`，成员数掉到 1，`Releasing` 补做被挡下的 sweep，`TapGestureRecognizer` 才拿到 `Winner`，`onTap` 才执行。

**注意日志里的关键字**：`Sweeping` 这一行是在 `Releasing` 之后出现的，说明它是 `release` 里补做的那次，而不是 up 时那次 sweep（`arena.dart:218-220`）。这一段是"`hold`/`release`/`hasPendingSweep` 三态"最完整的现场。

### 实验 5：成员数由 widget 组合决定

**改什么**：同一个 `GestureDetector` 上挂 `onTap` + `onLongPress` + `onVerticalDragStart` + `onScaleStart`。

**实际输出**：

```text
Gesture arena 3 ❙ Adding: TapGestureRecognizer#d787c(...)
Gesture arena 3 ❙ Adding: LongPressGestureRecognizer#bd968(...)
Gesture arena 3 ❙ Adding: VerticalDragGestureRecognizer#c06ce(...)
Gesture arena 3 ❙ Adding: ScaleGestureRecognizer#54f51(...)
Gesture arena 3 ❙ Closing with 4 members.
--- up ---
Gesture arena 3 ❙ Rejecting: LongPressGestureRecognizer#bd968(...)
Gesture arena 3 ❙ Rejecting: VerticalDragGestureRecognizer#c06ce(...)
Gesture arena 3 ❙ Rejecting: ScaleGestureRecognizer#54f51(...)
Gesture arena 3 ❙ Sweeping with 1 member.
Gesture arena 3 ❙ Winner: TapGestureRecognizer#d787c(...)
```

**说明**：一次短按里，三个"需要更多证据"的识别器都主动退场，`TapGestureRecognizer` 成为唯一剩下的，最后被 `sweep` 确认获胜。**加 member 的是 down，减 member 的是各个识别器的逻辑，最终判决在 up**——这三段的划分很清晰。

## 七、结论

1. 竞技场的规则只有一句：**第一个 accept 的赢，否则最后一个没 reject 的赢**（`arena.dart:110`）。`_GestureArena` 的四个字段 `isOpen` / `isHeld` / `hasPendingSweep` / `eagerWinner` 全部服务于这句话在时间轴上的各种错位情况。
2. `startTrackingPointer` 同时做"登记路由"和"加入竞技场"两件事，而 `stopTrackingPointer` 只撤销前者。**"滑出范围仍可能赢"是这两件事不对称的直接后果。**
3. `hold` / `release` / `sweep` 的三态（`arena.dart:157-221`）是"点击延迟"的机制来源：`hold` 后的 `sweep` 只记一个 `hasPendingSweep` 就返回，必须等 `release` 才补做。`onTap` + `onDoubleTap` 同挂时 `onTap` 晚约 300ms，走的就是这条路径。

**竞技场不判断"哪个手势更合理"，它只数票——谁先 accept 谁赢，没人 accept 就留给最后一个不肯退出的。**

## 八、边界声明

- 本文只展开 `TapGestureRecognizer`。`LongPressGestureRecognizer`、`DoubleTapGestureRecognizer`、`*DragGestureRecognizer`、`ScaleGestureRecognizer` 的内部判定（时间阈值、slop 拆解、速度估计）不在这个系列展开；它们的共同骨架就是 `PrimaryPointerGestureRecognizer`（`recognizer.dart:594`），在本文 4.5 / 4.7 里已给出。
- `GestureArenaTeam`（`team.dart:139`）与 `DefaultTeam` / `captain` 的细节不展开，它在本层只有 `_addPointerToArena`（`recognizer.dart:500`）一个入口。
- `PrimaryPointerGestureRecognizer` 的 `deadline`（`kPressTimeout`）与 slop 的具体数值来自 `gestures/constants.dart`，属于可调参数，不展开。
- 本文聚焦 `hold` / `release` / `sweep` 三态、`_tryToResolveArena` 的分支，以及可复现的诊断日志。
