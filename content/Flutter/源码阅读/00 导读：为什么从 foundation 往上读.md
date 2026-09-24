# 00 导读：为什么从 foundation 往上读

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · Dart 3.12.2 · 源码路径 `packages/flutter/lib/src`

## 一、问题

大部分人第一次读 Flutter 源码，都从 `Container` 或 `setState` 开始。

然后卡住。不是因为 `Container` 难，而是因为：读 `Container` 会立刻撞上 `Padding`、`ColoredBox`、`ConstrainedBox`，读 `setState` 会立刻撞上 `Element`、`BuildOwner`、`SchedulerBinding`。**你还没有坐标系，就先撞进了最上面的那几百个文件里。**

这篇要回答的是：为什么这个系列的阅读方向是**从下往上**，以及这套路线具体怎么走。

## 二、为什么要反过来读

Flutter framework 是一个**分层**系统。这个分层不是文档里随便画给人看的——把 `packages/flutter/lib/src` 下 681 个文件的 import 全部扫一遍，会得到一张基本单向的依赖图；不过它也不是编译期强制的约束，仓库里没有阻止下层 import 上层的分析器规则，靠的是各层库文档声明的约定与评审维护。

真实的层间依赖是：

```text
foundation
    ↓  42 文件，11.4k 行
physics ── painting ── scheduler ── animation ── gestures ── services ── semantics
    ↓  并列的第一层
rendering
    ↓  48 文件，52.0k 行
widgets
    ↓  186 文件，156.3k 行
material / cupertino
       250 文件，259.1k 行
```

这个结构决定了阅读顺序的性价比：

| 读法 | 一次投入 | 收益面 |
|---|---|---|
| 从上往下（Container → 底层） | 每碰到一个新概念就要回头补 | 收益只覆盖你碰到的那个组件 |
| 从下往上（foundation → widgets） | 每层的契约读过一次就够了 | 上层代码里出现的下层类型你都已经认识 |

举个具体的例子。`widgets/framework.dart` 里 `InheritedElement` 有这么一行：

```dart
// widgets/framework.dart:6263
_inheritedElements = incomingWidgets.put(widget.runtimeType, this);
```

如果你没读过 `foundation/persistent_hash_map.dart`，这一行会显得莫名其妙——为什么用一个不可变 Map？为什么要"每个 Element 存一份"？

读过之后你会知道：`PersistentHashMap.put` 返回的是**新版本**，且新旧版本共享绝大部分结构，所以"每个节点持有一份完整快照"这个看起来昂贵的操作实际上是便宜的。上层这行代码的设计动机，在下层已经解释完了。

**关键认知**：从下往上读，不是"更正经"，而是**先把上层会反复用到的词汇表建好**。上层代码之所以难读，多数时候不是你不够聪明，而是你在同一段代码里同时要学三个新概念。

## 三、分层地图怎么来的

README 里那张表不是照抄文档，是把所有 import 分类统计出来的。方法很简单，你自己也能重跑：

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src
for d in */; do
  n=$(find "$d" -name '*.dart' | wc -l)
  l=$(find "$d" -name '*.dart' -exec cat {} + | wc -l)
  printf "%-14s files=%-4s lines=%s\n" "${d%/}" "$n" "$l"
done
```

依赖关系用一段脚本把 import 语句归一化成层名再统计即可。得到的结论有几处和直觉不同，值得先知道：

1. **`foundation` 几乎没有依赖。** 42 个文件里只有 5 个 import `dart:ui`，只有 1 个跨出 `foundation` 目录（还是 web 专用实现）。它是名副其实的最底层。
2. **`scheduler`、`painting`、`gestures`、`services`、`semantics`、`animation` 是并列的。** 它们之间没有互相引用（`painting` 依赖 `services` 和 `gestures`，但都是单向的；`services`、`gestures` 都不回头依赖 `painting`），所以第一层内部其实是一张 DAG。全图唯一一个技术性的环来自 `animation/curves.dart:11`——它为了 dartdoc 链接 `import 'package:flutter/cupertino.dart'`，代码里零使用，cupertino 又经 widgets 依赖回 animation。卷次顺序仍按依赖强度排，不按字母排。
3. **`widgets` 依赖 9 个层。** 这是它 156k 行的代价，也是为什么它必须放在最后一卷读。
4. **`material` / `cupertino` 占了全部代码量的 55%，但不进入主干。** 它们是"组件用法的集合"，不是新的机制，本系列只在收尾卷抽样下潜一次。

## 四、这套路线怎么走

每篇固定八节，可以按需要选读模式：

**顺读**（第一次读某一层）：从第一节顺序读到第八节。第三节的锚点表先用 grep 打开文件，第四节的调用链对照源码走一遍。

**查读**（写业务时撞到某个机制）：直接进第五节看对象职责对比，或进第七节看结论。第八节会告诉你这件事的完整机制在哪一篇。

**动手验证**：先看该篇的第四节调用链，再围绕关键节点写 Demo、打断点验证。

每一篇的第三节都长这样：

| 锚点 | 说明 |
|---|---|
| `foundation/change_notifier.dart:413` | `notifyListeners`，通知的唯一出口 |
| `foundation/change_notifier.dart:339` | `removeListener`，通知期间的移除走置空占位 |
| `foundation/change_notifier.dart:457` | 递归通知结束后才真正压缩列表 |

**行号一定会漂移，类名和调用关系不会。** 所以每篇的结论都写成"谁在什么条件下调用谁"，而不是"第 413 行做了什么"。升级 SDK 后按 README 里的 grep 命令复核即可。

## 五、核心对象：本系列会反复出现的那几个

读之前先认识一遍主干角色，后面每一篇都在给它们补细节。

| 对象 | 所在层 | 一句话职责 |
|---|---|---|
| `Element` | widgets | 树上的常驻节点，身份和生命周期的持有者 |
| `Widget` | widgets | 不可变的配置描述，每次 build 都可能换新 |
| `RenderObject` | rendering | 负责 layout / paint / hitTest 的实际对象 |
| `BuildOwner` | widgets | 收集脏 Element，并在一个 buildScope 里统一重建 |
| `PipelineOwner` | rendering | 收集脏 RenderObject，驱动 layout / paint / semantics |
| `BindingBase` 及其 mixin | foundation → widgets | 把 dart:ui 的一次性回调接线到框架的各层 |

第五卷之前的每一步，实际上都是在给这张表里的角色补前置知识。

## 六、源码实验：先证明你在读的确实是这份源码

在你的 SDK 根目录执行下面三条，把输出记下来，后面每一篇核对锚点时都用得上：

```bash
# 1. 确认版本
flutter --version

# 2. 确认 foundation 确实是最底层：42 个文件里只有 5 个碰 dart:ui
grep -rl "import 'dart:ui'" packages/flutter/lib/src/foundation | wc -l

# 3. 确认某个锚点存在（第三篇会用到）
grep -n "class AbstractNode" packages/flutter/lib/src/foundation/node.dart
```

第 3 条会顺手暴露本系列的第一个"版本事实"：`AbstractNode` 在 3.44.8 里已经被标记 `@Deprecated`，而且框架内部**一次都没有再引用它**。第三篇会完整讲清楚这套树骨架协议后来去了哪。

## 七、结论

1. Flutter framework 当前的分层可以通过 import 关系观察，但不是编译期强制的依赖约束；它依赖各层约定与评审维护。
2. 从下往上读的收益是**词汇表复用**：上层代码里反复出现的下层类型，在进入上层之前就已经认识。
3. 每篇的锚点行号会随版本漂移，但"谁调用谁、在什么条件下"是稳定的，这才是要记住的东西。

一句话总结：**不要从最热闹的那一层开始读，从没有任何依赖的那一层开始读。**

## 八、边界声明

- 本系列不深入 Engine（C++）、Impeller、Dart VM / GC / JIT。那是另一条路线，只在收尾卷给地图。
- 本系列不写单元测试。结论依据是 SDK 源码本身，文中的 Demo 用于对照调用栈。
- 不追求"一次读完整层"。每篇只追一条链，第八节明确写出今天不追什么。
