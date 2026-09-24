# 42 setState 与 BuildOwner：脏列表与 buildScope

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `widgets/framework.dart`、`widgets/binding.dart`

## 一、问题

"`setState` 不会立即刷新屏幕"是 Flutter 最常被提到的一句话。但它的下一句常常是错的：

> 常见回答："`setState` 把 widget 标脏，然后 Flutter 在下一帧统一刷新。"

这句里有三个含糊处：

1. **"标脏"标在哪个对象上？** 是 `State` 吗？不是——`State` 没有脏标记。
2. **"统一刷新"是谁驱动的？** 如果没有任何人请求一帧，脏标记就一直躺着，谁来发起？
3. **"下一帧"的"下一个"是谁保证的？** 如果这一帧正在 layout 中途，新加的脏 Element 会被立刻 build 吗？

还有一个更具体的疑问：`setState` 说"效率考虑，一帧只 build 一次"。既然 `_dirty` 是 `bool`，那**同一个 Element 在帧内被标脏两次会怎样**？如果第二次标脏发生在第一帧 build 之后、"脏列表清理"之前，它会漏掉吗？

本文把 `setState` 到 `build()` 之间的**六个跳**逐跳展开，并给出一个 3.44 才有的结构：**`_dirtyElements` 在 `BuildScope` 上，不在 `BuildOwner` 上。**

## 二、最小 Demo

```dart
import 'package:flutter/widgets.dart';

class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _n = 0;

  @override
  Widget build(BuildContext context) {
    debugPrint('build _n=$_n');
    return GestureDetector(
      onTap: () {
        // 1. setState 只做两件事：执行回调 + 标脏
        setState(() => _n++);
        // 2. 这里 _n 已经变了，但屏幕还没变
        debugPrint('setState 返回后，_n=$_n，但这一帧还没开始');
        // 3. 再标一次：因为 _dirty 已经是 true，这次直接被丢弃（幂等）
        setState(() => _n++);
        debugPrint('第二次 setState 返回后，_n=$_n');
      },
      child: Text('$_n', textDirection: TextDirection.ltr),
    );
  }
}
```

点一下的输出顺序是：

```text
setState 返回后，_n=1，但这一帧还没开始
第二次 setState 返回后，_n=2
build _n=2          ← 只 build 一次，两次 setState 合并成一次
```

**`build` 只打了一行，但 `_n` 是 2。** 这就是"标脏 + 合并"的最小可见形式。加上两个调试开关能看到全貌：

```dart
void main() {
  debugPrintBuildScope = true;      // widgets/debug.dart:88，每次 buildScope 打一行
  debugPrintScheduleBuildForStacks = true;  // 每次 scheduleBuildFor 打栈
  runApp(const Counter());
}
```

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `framework.dart:1160` | `State.setState` |
| `framework.dart:1219` | `_element!.markNeedsBuild();`，setState 的最后一行 |
| `framework.dart:5339` | `Element.markNeedsBuild` |
| `framework.dart:5322` / `5323` | `bool get dirty => _dirty;` / `bool _dirty = true;`（**初值是 true**） |
| `framework.dart:5386-5388` | `if (dirty) { return; }`，幂等的关键一行 |
| `framework.dart:5390` | `owner!.scheduleBuildFor(this);`（`_dirty = true` 在 `:5389`） |
| `framework.dart:2901` | `class BuildOwner` |
| `framework.dart:2918` | `bool _scheduledFlushDirtyElements = false;`（在 `BuildOwner` 上） |
| `framework.dart:2936` | `BuildOwner.scheduleBuildFor` |
| `framework.dart:2982` | `onBuildScheduled!()`，请求一帧的唯一出口 |
| `framework.dart:2684` | `final class BuildScope`（3.44 新增） |
| `framework.dart:2711` | `final List<Element> _dirtyElements = <Element>[];`（在 `BuildScope` 上） |
| `framework.dart:2716` | `BuildScope._scheduleBuildFor`，真正往列表里加 |
| `framework.dart:2710` | `bool? _dirtyElementsNeedsResorting;` |
| `framework.dart:2798` | `BuildScope._flushDirtyElements` |
| `framework.dart:2800` | `_dirtyElements.sort(Element._sort);`（重置在 `:2801`） |
| `framework.dart:3616` | `Element._sort` |
| `framework.dart:3056` | `BuildOwner.buildScope` |
| `framework.dart:5503` | `Element.rebuild` |
| `binding.dart:1430` | `WidgetsBinding._handleBuildScheduled` |
| `binding.dart:1571` | `buildOwner!.buildScope(rootElement!);` |

## 四、调用链

### 4.1 六跳全景

```text
用户：setState(() => _n++)
  │
  ├─ 跳 1  State.setState                     framework.dart:1160
  │         ├─ 三段断言（defunct / constructor / Future）
  │         ├─ fn()                                  ← 改数据
  │         └─ _element!.markNeedsBuild()     :1219
  ├─ 跳 2  Element.markNeedsBuild              :5339
  │         ├─ 不活跃 → return                 :5341
  │         ├─ dirty 已 true → return          :5387   ← 幂等的关键
  │         ├─ _dirty = true                   :5389
  │         └─ owner!.scheduleBuildFor(this)   :5390
  ├─ 跳 3  BuildOwner.scheduleBuildFor         :2936
  │         ├─ 取 element.buildScope           :2963
  │         ├─ if (!_scheduledFlushDirtyElements && onBuildScheduled != null) {
  │         │      _scheduledFlushDirtyElements = true;            :2986
  │         │      onBuildScheduled!();         :2987   ← 请求一帧（全局只一次）
  │         │  }
  │         └─ buildScope._scheduleBuildFor(element)               :2989
  ├─ 跳 4  BuildScope._scheduleBuildFor         :2716
  │         ├─ if (!element._inDirtyList) → add + _inDirtyList = true
  │         ├─ 第一次标脏 → scheduleRebuild?.call()
  │         └─ if (_dirtyElementsNeedsResorting != null) → 置 true   :2726
  ├─ 跳 5  WidgetsBinding._handleBuildScheduled  binding.dart:1430
  │         └─ scheduleFrame()                  ← 交给 SchedulerBinding
  └─ 跳 6  下一帧 WidgetsBinding.drawFrame      binding.dart:1536
            └─ buildOwner!.buildScope(rootElement!)   binding.dart:1571
                 └─ BuildScope._flushDirtyElements    framework.dart:2798
                      ├─ _dirtyElements.sort(Element._sort)   :2800
                      └─ element.rebuild()                     :5503
                           └─ performRebuild()  ← 这里才调 build()
```

`setState` 到 `build()` 之间有 **6 个方法调用、跨 4 个对象**（`State` → `Element` → `BuildOwner` → `BuildScope` → `WidgetsBinding`）。这条链上一半的代码都在做**去重**，"重建"本身只占一小部分：`_dirty` 去掉重复标脏（跳 2）、`_scheduledFlushDirtyElements` 去掉重复请求帧（跳 3）、`_inDirtyList` 去掉重复入队（跳 4）。

### 4.2 跳 3 与跳 4 的分工：为什么要有两层

跳 3 在 `BuildOwner` 上，跳 4 在 `BuildScope` 上。这不是冗余，是 3.44 新增的分层：

```dart
// framework.dart:2936-2990（节选）
void scheduleBuildFor(Element element) {
  assert(element.owner == this);
  assert(element._parentBuildScope != null);
  ...
  final BuildScope buildScope = element.buildScope;   // 2963：找回自己的 scope
  ...
  if (!_scheduledFlushDirtyElements && onBuildScheduled != null) {   // 2985
    _scheduledFlushDirtyElements = true;              // 2986
    onBuildScheduled!();                              // 2987：请求一帧（全局只请求一次）
  }
  buildScope._scheduleBuildFor(element);              // 2989：入自己的脏列表
}
```

| | `BuildOwner` 侧 | `BuildScope` 侧 |
|---|---|---|
| 字段 | `_scheduledFlushDirtyElements`（`:2918`） | `_dirtyElements`（`:2711`）、`_dirtyElementsNeedsResorting`（`:2710`）、`_buildScheduled`（`:2689`）、`_building`（`:2691`） |
| 管什么 | **请求帧**（全局一份） | **脏列表**（每个 scope 一份） |
| 去重字段 | `_scheduledFlushDirtyElements` | `_inDirtyList`（在 Element 上，`framework.dart:5327`） |
| 清空时机 | `buildScope` 的 `finally`（`:3114` 复位 `_scheduledFlushDirtyElements`） | `_flushDirtyElements` 的 `finally`（`:2834-2842`） |

**为什么要分？** 因为 `LayoutBuilder` 这样需要"独立构建区"的组件会覆盖 `Element.buildScope`：

```dart
// layout_builder.dart:118-121
@override
BuildScope get buildScope => _buildScope;

late final BuildScope _buildScope = BuildScope(scheduleRebuild: _scheduleRebuild);
```

它的语义在 `BuildScope` 的类文档里写得很清楚（`framework.dart:2682-2684`）：**"no descendant `Element`s may rebuild prematurely until the incoming constraints are known"**。`RenderObjectElement` 默认共享父级的 scope：

```dart
// framework.dart:3709-3720
/// Always return the same [BuildScope] instance if you override this getter.
...
BuildScope get buildScope => _parentBuildScope!;
```

`_dirtyElements` 从 `BuildOwner` 移到 `BuildScope` 是 3.44 的结构变化。如果你读的老资料说"`BuildOwner._dirtyElements`"，那是旧版本——**3.44.8 里 `BuildOwner` 没有这个字段**，它只有 `_scheduledFlushDirtyElements` 这个"是否已经请求过帧"的布尔量。验证见第六节实验 1。

### 4.3 幂等是怎么实现的

`markNeedsBuild` 里那行 `if (dirty) return;` 只挡住"同一个对象重复标脏"。真正让"两次 `setState` 合并成一次 build"的还有另外两层：

```dart
// framework.dart:5386-5391（节选）
if (dirty) {
  return;                        // 5387：本对象已脏 → 丢弃
}
_dirty = true;                   // 5389
owner!.scheduleBuildFor(this);   // 5390
```

```dart
// framework.dart:2716-2724（节选）
void _scheduleBuildFor(Element element) {
  if (!element._inDirtyList) {        // 已经在脏列表里 → 不重复 add
    _dirtyElements.add(element);
    element._inDirtyList = true;
  }
  ...
}
```

```dart
// framework.dart:2985-2988（节选）
if (!_scheduledFlushDirtyElements && onBuildScheduled != null) {
  _scheduledFlushDirtyElements = true;
  onBuildScheduled!();              // 一帧内只会请求一次
}
```

**三个 `bool` 管三件事**：

| 字段 | 位置 | 挡住什么 |
|---|---|---|
| `_dirty` | `Element:5323`（初值 `true`） | 同一次"标脏请求"重复到达 |
| `_inDirtyList` | `Element:5327` | 同一个 Element 被 `add` 进脏列表两次 |
| `_scheduledFlushDirtyElements` | `BuildOwner:2918` | 同一帧内重复请求新帧 |

Demo 里两次 `setState` 的路径：第一次走完全链（`_dirty` 变 `true`、入队、请求帧）；第二次在跳 2 的 `:5386` 就被挡下，**只执行了 `fn()`（所以 `_n` 确实加了）**。

`_dirty` 的初值是 `true`（`:5323`）。一个新的 Element 刚 `createElement` 出来就天生是脏的，所以 `mount` 之后不需要任何人标脏它就能被 build——这也是"`initState` 里 `setState` 是多余的"的源码依据。

### 4.4 脏列表的排序与 `_dirtyElementsNeedsResorting`

帧到了，`_flushDirtyElements` 开始工作：

```dart
// framework.dart:2798-2843（节选）
void _flushDirtyElements({required Element debugBuildRoot}) {
  assert(_dirtyElementsNeedsResorting == null, '_flushDirtyElements must be non-reentrant');
  _dirtyElements.sort(Element._sort);        // 2800：先排一次
  _dirtyElementsNeedsResorting = false;      // 2801：进入"正在构建"状态
  try {
    for (var index = 0; index < _dirtyElements.length; index = _dirtyElementIndexAfter(index)) {
      final Element element = _dirtyElements[index];
      if (identical(element.buildScope, this)) {    // 不是自己的 dirty，跳过
        assert(_debugAssertElementInScope(element, debugBuildRoot));
        _tryRebuild(element);                       // → element.rebuild()
      }
    }
    ...
  } finally {
    for (final Element element in _dirtyElements) {
      if (identical(element.buildScope, this)) {
        element._inDirtyList = false;               // 清标记
      }
    }
    _dirtyElements.clear();                         // 2840 清列表
    _dirtyElementsNeedsResorting = null;            // 2841 退出"正在构建"状态
    _buildScheduled = false;                        // 2842 允许下一次请求帧
  }
}
```

排序函数：

```dart
// framework.dart:3616-3631
static int _sort(Element a, Element b) {
  final int diff = a.depth - b.depth;
  if (diff != 0) {
    return diff;                          // 1. 先按 depth 升序（父在子之前）
  }
  final bool isBDirty = b.dirty;
  if (a.dirty != isBDirty) {
    return isBDirty ? -1 : 1;             // 2. depth 相同时，不脏的排前面
  }
  return 0;
}
```

**`depth` 的唯一用途就是排序**（第三篇已确认），保证"父先于子"的拓扑序——因为子 Element 可能被父的 build 顺手换掉，先 build 父能省一次无用功。第二条规则（不脏的排前面）是为了让"循环中被取消的脏标记"表现为"这个元素已经不需要 build 了"，把它排到后面可以让 `_dirtyElementIndexAfter` 的下标回退逻辑更简单。

**`_dirtyElementsNeedsResorting` 是"构建期间又变脏"的信号**。它由跳 4 设置：

```dart
// framework.dart:2726-2728（节选）
if (_dirtyElementsNeedsResorting != null) {   // 只有"正在构建"时才非 null
  _dirtyElementsNeedsResorting = true;
}
```

`_flushDirtyElements` 的循环不直接用 `index++`，而是用 `_dirtyElementIndexAfter`：

```dart
// framework.dart:2849-2870（节选）
int _dirtyElementIndexAfter(int index) {
  if (!_dirtyElementsNeedsResorting!) {
    return index + 1;                    // 列表没被改过，正常前进
  }
  index += 1;
  _dirtyElements.sort(Element._sort);    // 重新排序
  _dirtyElementsNeedsResorting = false;
  while (index > 0 && _dirtyElements[index - 1].dirty) {
    // It is possible for previously dirty but inactive widgets to move right in the list.
    // We therefore have to move the index left in the list to account for this.
    ...
  }
  return index;
}
```

`_dirtyElementsNeedsResorting` 用 `bool?` 而不是 `bool` 是有意的——**`null` 表示"不在构建中"**（初值），此时跳 4 里那句判断不成立，所以不会设 `true`。`_flushDirtyElements` 进出时把它设成 `false` / `null`，正好构成一个"构建中"的作用域标记。这就是为什么 `_dirtyElementIndexAfter` 敢直接 `!`：它能被调到就说明正在 `_flushDirtyElements` 里。

**为什么需要重排？** 因为在 build 过程中会有新的 Element 变脏（比如父 build 时给某个子 `setState`）。这些新脏的 depth 可能比当前下标处的元素更浅，必须插到前面。重排之后下标可能要**回退**（注释里解释的原因：本来脏但已不活跃的元素可能被排到右边，导致 `index - 1` 处出现新的待处理元素）。最后那个 `while` 循环就是处理这个回退。

### 4.5 `buildScope` 的入口与"每帧一次"

```dart
// framework.dart:3056-3060
void buildScope(Element context, [VoidCallback? callback]) {
  final BuildScope buildScope = context.buildScope;
  if (callback == null && buildScope._dirtyElements.isEmpty) {
    return;                          // 没活干就直接返回
  }
  ...
}
```

`callback` 只在两个地方非空：`RootWidget.attach`（`binding.dart:2005`）和 `LayoutBuilder`（`layout_builder.dart:270`）。**常规的每帧调用（`binding.dart:1571`）不传 callback**，所以第一行的早退就是"这一帧没有脏 Element 就什么都不做"。

它的 `finally` 负责复位全局状态：

```dart
// framework.dart:3112-3118（节选）
} finally {
  buildScope._building = false;
  _scheduledFlushDirtyElements = false;    // 允许下一帧再次请求
  ...
}
```

`_scheduledFlushDirtyElements` 的复位点在 `buildScope`，而不是 `_flushDirtyElements`。这两处分别在 `BuildOwner` 和 `BuildScope` 上，各自负责自己的标志——**这就是分层的代价：两个 `finally` 都要对**。

### 4.6 与帧的衔接

跳 5 只有一行：

```dart
// binding.dart:1430 起（节选）
void _handleBuildScheduled() {
  // If we're in the process of building dirty elements, then changes
  // should not trigger a new frame.
  assert(() {
    if (debugBuildingDirtyElements) {
      throw FlutterError.fromParts(<DiagnosticsNode>[
        ErrorSummary('Build scheduled during frame.'),
        ...
      ]);
    }
    return true;
  }());
  scheduleFrame();
}
```

那个断言值得单独提：**在 `drawFrame` 期间请求新帧会抛错**。因为 `drawFrame` 已经包住了 build / layout / paint 三阶段，任何在其中的标脏都应该由同一个 `buildScope` 处理完。这也从反面证明了"一帧一次"：**帧内不需要新帧**。

`scheduleFrame()` 之后的事属于 `SchedulerBinding`：`ensureFrameCallbacksRegistered` → `PlatformDispatcher.scheduleFrame()` → 引擎回调 → `handleDrawFrame` → `drawFrame`。这条链的第一跳 `setState` → `scheduleFrame` 已经讲完；帧本身如何产生见**第 4 卷 18 篇**。

## 五、核心对象：`BuildOwner` vs `BuildScope`

| | `BuildOwner` | `BuildScope` |
|---|---|---|
| 声明位置 | `framework.dart:2901` | `framework.dart:2684` |
| 数量 | 每个 `WidgetsBinding` 一个（`binding.dart:476`） | 每个需要独立构建区的 Element 一个，默认从父继承 |
| 脏列表 | **没有** | `final List<Element> _dirtyElements`（`:2711`） |
| 请求帧的去重标志 | `_scheduledFlushDirtyElements`（`:2918`） | `_buildScheduled`（`:2689`） |
| "正在构建"标记 | `_debugBuilding`（仅 debug，`:3005`） | `_building`（`:2691`，release 下也在） |
| 排序重排信号 | 没有 | `_dirtyElementsNeedsResorting`（`:2710`） |
| `GlobalKey` 注册表 | `_globalKeyRegistry`（`:3148`） | 没有 |
| 暂存区 | `_inactiveElements`（`:2916`） | 没有 |
| 谁来清空 | `buildScope` 的 `finally` 复位 `_scheduledFlushDirtyElements` | `_flushDirtyElements` 的 `finally` 清列表 |
| 谁能创建 | 只有 `WidgetsBinding` / `RootWidget.attach` | 任何 Element 都可以覆盖 `buildScope` getter |
| 谁在用 | 全体 | `LayoutBuilder`（`layout_builder.dart:121`）是框架内的例子 |

**一句话区分**：`BuildOwner` 管"全局的一份状态"（注册表、暂存区、是否请求过帧），`BuildScope` 管"这一片区域的脏列表"。

## 六、源码实验

### 实验 1：确认 `_dirtyElements` 不在 `BuildOwner` 上

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
awk '/^class BuildOwner/,/^}/' framework.dart | grep -n "_dirtyElements"
awk '/^final class BuildScope/,/^}/' framework.dart | grep -n "_dirtyElements"
```

**预测**：按老资料的说法，第一个命令应该命中。

**实际**：第一个命令**无输出**；第二个命令命中类内的两处相对行 `:25` 和 `:26`，对应文件里的 `:2710` 和 `:2711`。

**说明**：这是 3.44.8 与常见资料最明显的一处结构差异。**`BuildOwner` 里根本没有 `_dirtyElements`**，只有 `_scheduledFlushDirtyElements`。如果你的调试代码或文章里写 `buildOwner._dirtyElements`，在 3.44 上是找不到的。这也是第三十六篇把 `BuildScope`（`:2684`）单独列进入口锚点的原因——它是这一版新增的机制层。

### 实验 2：观察 `_dirtyElementsNeedsResorting` 被置真的时机

```bash
grep -n "_dirtyElementsNeedsResorting" packages/flutter/lib/src/widgets/framework.dart
```

**实际**（共 8 处）：

```text
2708:  bool? _dirtyElementsNeedsResorting;                             ← 声明
2734:    if (_dirtyElementsNeedsResorting != null) {                   ← 跳 4 里置真
2735:      _dirtyElementsNeedsResorting = true;
2799:    assert(_dirtyElementsNeedsResorting == null, ...);             ← 进入构建时的断言
2801:    _dirtyElementsNeedsResorting = false;                          ← 进入构建
2847:    if (!_dirtyElementsNeedsResorting!) {                          ← 不重排就 index+1
2852:    _dirtyElementsNeedsResorting = false;                          ← 重排后清
2874:    _dirtyElementsNeedsResorting = null;                           ← 退出构建
```

**说明**：8 处里 4 处是状态的读写，2 处是判断。注意 `2734` 的读判断用的是 `!= null`——**这正是 `bool?` 而不是 `bool` 的用途**：`null` 表示"不在构建中，别设"，`false` 表示"在构建中，但还不需要重排"，`true` 表示"需要重排"。三态布尔量。

### 实验 3：确认 `_dirty` 的初值是 `true`

```bash
grep -n "bool _dirty = true;\|bool get dirty" packages/flutter/lib/src/widgets/framework.dart
```

**预测**：既然要"标脏"，初值应该是 `false`。

**实际**：

```text
5322:  bool get dirty => _dirty;
5323:  bool _dirty = true;
```

**说明**：初值是 `true`。这解释了两件事：（1）新 Element 的 `mount` → `_firstBuild` → `rebuild()` 不需要 `force: true` 就能通过 `if (!_dirty && !force) return` 这道关（`:5505`）；（2）`initState` 里调 `setState` 是纯多余，因为 `markNeedsBuild` 会在 `:5386` 直接返回。

### 实验 4：两个调试开关 + 早退条件

```bash
grep -n "debugPrintBuildScope = false\|debugPrintScheduleBuildForStacks = false" \
  packages/flutter/lib/src/widgets/debug.dart
sed -n '3056,3060p' packages/flutter/lib/src/widgets/framework.dart
```

**实际**：开关在 `debug.dart:88`（`debugPrintBuildScope`）和 `debug.dart:101`（`debugPrintScheduleBuildForStacks`）；`buildScope` 的前三行是：

```dart
  void buildScope(Element context, [VoidCallback? callback]) {
    final BuildScope buildScope = context.buildScope;
    if (callback == null && buildScope._dirtyElements.isEmpty) {
      return;
    }
```

**说明**：把两个开关都打开跑第二节的 Demo，会看到：

- 静止时一帧都不打印（`:3058` 的早退要求"没有 callback **且**脏列表为空"两个条件同时成立）；
- 点一次触发两次 `setState`，只看到**一次** `scheduleBuildFor` 相关的输出——第二次在 `:5387` 就被挡下了；
- `buildScope called with context ...` 每次只在真有脏 Element 的帧出现。

另外，`buildScope` 的早退条件解释了它的文档为什么说"To flush the current dirty list without performing any other work, this function can be called with no callback"——**传 null 才是"只冲刷脏列表"的语义**，传 callback 时即使列表为空也要继续，因为 callback 本身可能标脏（`RootWidget.attach`（`binding.dart:2005`）和 `LayoutBuilder`（`layout_builder.dart:270`）就是这么用的）。

## 七、结论

1. `setState` 的全部效果是"执行回调 + `markNeedsBuild`"。`markNeedsBuild` 有三道去重：`Element._dirty`（`:5386`）挡重复标脏、`Element._inDirtyList`（`:5327`）挡重复入队、`BuildOwner._scheduledFlushDirtyElements`（`:2918`）挡重复请求帧。**一帧内多次 `setState` 只产生一次 build，但回调每次都会执行。**
2. **`_dirtyElements` 在 `BuildScope`（`:2711`）上，不在 `BuildOwner` 上**——这是 3.44 的结构。`BuildScope` 还可能被 `LayoutBuilder` 之类的 Element 覆盖（`layout_builder.dart:121`），使一片子树拥有独立的脏列表与独立的 build 时机。`BuildOwner` 只保留"是否已请求过帧"这一个全局标志。
3. `_flushDirtyElements` 先 `sort(Element._sort)`（`:2800`，按 `depth` 保证父先于子），然后边遍历边判断 `_dirtyElementsNeedsResorting`（`:2850`）。这个 `bool?` 是三态的：`null` = 不在构建中、`false` = 构建中且有序、`true` = 构建中且需要重排。**构建期间新变脏的 Element 会被重新插到正确位置，必要时下标回退。**

**`setState` 只是把 Element 塞进它所属 `BuildScope` 的脏列表并请一帧；真正的 rebuild 发生在下一帧 `drawFrame` 里 `buildScope(rootElement)` → `_flushDirtyElements` 那一刻。**

## 八、边界声明

- `SchedulerBinding.scheduleFrame` 到引擎回调的完整链路见**第 4 卷 18 篇（一帧的五个阶段）**，本文只给 `_handleBuildScheduled`（`binding.dart:1430`）这一跳。
- `drawFrame` 的三跳（`buildScope` → `super.drawFrame()` → `finalizeTree`）已在**第三十六篇 4.3** 给过锚点，本文只展开第一跳。
- `LayoutBuilder` 的独立 `BuildScope` 内部机制（`_scheduleRebuild` 与 `markNeedsLayout` 的联动，`layout_builder.dart:119-135`）本文不展开，只当作"为什么 `BuildScope` 必须存在"的例证。
- `Element._sort` 里 `depth` 的"只增不减"语义见**第三篇**；本文不重复。
- `StatefulElement.performRebuild` 里 `_didChangeDependencies` 的延迟兑现见**第四十篇 4.3** 与**第四十一篇 4.3**。
- `InheritedElement.notifyDependent`（`:6373`）触发的 `didChangeDependencies` 也走本文这条链，但注册与通知本身见**第四十三篇**。
- 本文讲的是**脏列表的存放位置、三层去重、排序与重排**，以及 3.44 的 `BuildScope` 分层。
