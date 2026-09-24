# 32 脏传播：markNeedsLayout 与 relayoutBoundary

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/object.dart`（6773 行）、`rendering/box.dart`（3388 行）

## 一、问题

改一个 `Text` 的字号，框架会重算多少东西？改一个 `Padding` 的 padding 呢？

错误直觉是两种极端：一种认为"`setState` = 整棵树 rebuild + 整棵树 relayout"；另一种相反，认为"只改我这一块，其他地方不动"。

真实答案是**两者都不对**：脏标记会向上传播，但传播会在遇到 **relayoutBoundary** 时停下。所以真正重算的范围是"从脏节点往上到最近的边界"这片子树。

问题因此变成：**边界是怎么定的？**

错误直觉在这里具体表现为"边界 = `RepaintBoundary`"。**relayoutBoundary 和 repaintBoundary 是两套完全独立的判定**：前者由 `layout` 的 `parentUsesSize` / `sizedByParent` / 约束是否 tight 决定，后者由 `isRepaintBoundary` 这个类级别 getter 决定。同一个节点完全可能只是其中之一，或者两者都是。

`_isRelayoutBoundary` 是**三态** `bool?`（`object.dart:2567`）——`null` 表示"还没 layoyut 过，不知道"，`true` / `false` 表示已判定。这个三态的原因是"判断边界需要知道父怎么调用我"，这件事只有 `layout` 发生时才可知，与省内存无关。

## 二、最小 Demo

两个 RenderBox：父**不读**孩子的尺寸——四个判定条件里第一个（`!parentUsesSize`）直接成立，孩子必是 relayout boundary；父**读**孩子的尺寸——这只是排除掉第一个条件，孩子是否成为边界还要看 `sizedByParent` 与约束是否 tight（见 4.2 的完整四条件），Demo 里给孩子的是未收紧的约束、孩子也非 `sizedByParent`，所以孩子不是边界。

```dart
import 'package:flutter/widgets.dart';

/// 父不读子尺寸：子自己决定多大，父只是把它放在左上角。
/// 子因此成为 relayoutBoundary —— 子变尺寸不会传播到父。
class RenderFixedSlot extends RenderProxyBox {
  @override
  void performLayout() {
    // 1. 关键：没传 parentUsesSize（默认 false）→ 子成为 relayout boundary
    child?.layout(constraints);
    // 2. 父尺寸只由约束决定，不含子的尺寸 → 子变尺寸父也无需重算
    size = constraints.biggest;
  }
}

/// 父读子尺寸：父的尺寸等于子的尺寸，所以子变父也必须变。
class RenderShrinkWrap extends RenderProxyBox {
  @override
  void performLayout() {
    // 3. 传了 parentUsesSize: true 只排除判定四条件里的第一个（!parentUsesSize）；
    //    在约束不 tight、子也非 sizedByParent 时，子才不是 relayout boundary
    child?.layout(constraints, parentUsesSize: true);
    // 4. 父尺寸直接取子的尺寸 → 父的 layout 依赖子
    size = child?.size ?? Size.zero;
  }
}
```

把这两个 RenderBox 各配一个 `SingleChildRenderObjectWidget`（`createRenderObject` 返回对应实例），就能挂进 Widget 树。然后在同一个会 `setState` 改自己尺寸的叶子上分别套这两层父节点：

把 `<Squarish />` 塞进 `FixedSlot` 时，孩子是 relayout boundary，`Squarish` 变尺寸**不会**把 `FixedSlot` 标脏；塞进 `ShrinkWrap` 时，`parentUsesSize: true` 只是排除了四条件里的第一个（`!parentUsesSize`），在约束不 tight 且子非 `sizedByParent` 的常见前提下，孩子不是边界，脏标记会一路向上传到 `ShrinkWrap` 的父。两个 `layout` 调用的差别只有一个具名参数，但它决定了**这棵子树重布局的上界**——反过来，即使父传了 `parentUsesSize: true`，只要给的是 tight 约束（或子本身 `sizedByParent`），孩子依然是边界。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering/object.dart:2660` | `markNeedsLayout()`，脏标记的唯一入口 |
| `rendering/object.dart:2667` | `if (owner case ... when (_isRelayoutBoundary ?? false))` 边界判定分叉点 |
| `rendering/object.dart:2691` | `markParentNeedsLayout()`，非边界转交父 |
| `rendering/object.dart:2847` | `_isRelayoutBoundary = !parentUsesSize \|\| sizedByParent \|\| constraints.isTight \|\| parent == null;` |
| `rendering/object.dart:2737` | `_layoutWithoutResize()`，flush 时实际执行的方法 |
| `rendering/object.dart:1137` | `PipelineOwner.flushLayout()` |
| `rendering/object.dart:1163` | `dirtyNodes.sort((a, b) => a.depth - b.depth)`，**必须按 depth 升序** |
| `rendering/object.dart:1319` | `dirtyNodes..sort((a, b) => b.depth - a.depth)`，**paint 反向** |

表中只列追这条链的主入口；其余锚点随第四、六节的正文就近给出，不重复列。

## 四、调用链

### 4.1 `markNeedsLayout` 只有三条分支

```dart
// rendering/object.dart:2660-2679
void markNeedsLayout() {
  assert(_debugCanPerformMutations);
  if (_needsLayout) {
    assert(_debugRelayoutBoundaryAlreadyMarkedNeedsLayout());
    return;                                                    // 分支 0：已经脏了，直接返回
  }
  _needsLayout = true;
  if (owner case final PipelineOwner owner? when (_isRelayoutBoundary ?? false)) {
    owner._nodesNeedingLayout.add(this);                       // 分支 1：我是边界 → 自己进脏表
    owner.requestVisualUpdate();
  } else if (parent != null) {
    markParentNeedsLayout();                                   // 分支 2：不是边界 → 让父也脏
  }
}
```

分支 0 的短路靠 `_needsLayout` 布尔位，所以**同一个节点反复标脏是 O(1)**。分支 2 会把 `_needsLayout = true`（在 `markParentNeedsLayout` 里）后再调 `parent.markNeedsLayout()`，于是标记一路向上爬，直到碰到某个 `_isRelayoutBoundary == true` 的祖先。**没有一个节点会进两次脏表**，因为爬升过程遇到第一个已脏的节点就会命中分支 0。

`markParentNeedsLayout` 的实现很短但有一处坑：

```dart
// rendering/object.dart:2691-2702
void markParentNeedsLayout() {
  assert(_debugCanPerformMutations);
  _needsLayout = true;
  assert(this.parent != null);
  final RenderObject parent = this.parent!;
  if (!_doingThisLayoutWithCallback) {
    parent.markNeedsLayout();
  } else {
    assert(parent._debugDoingThisLayout);
  }
  assert(parent == this.parent);
}
```

`_doingThisLayoutWithCallback` 为 true 时**不向上传播**。这是 `LayoutBuilder` 的专用路径：`invokeLayoutCallback`（`object.dart:3019`）允许在 layout 期间改孩子，此时父正在 `performLayout` 中，再标父脏会造成本帧内不可收敛。

### 4.2 `_isRelayoutBoundary` 的判定只有一行

判定写在 `layout` 开头，紧跟着约束有效性检查：

```dart
// rendering/object.dart:2847
_isRelayoutBoundary = !parentUsesSize || sizedByParent || constraints.isTight || parent == null;
```

四个条件是**或**关系，命中任意一个即为边界：

| 条件 | 含义 | 为什么是边界 |
|---|---|---|
| `!parentUsesSize` | 父没有声明"我读你的尺寸" | 子变尺寸对父的布局无影响 |
| `sizedByParent` | 子尺寸只由约束决定 | 约束不变则尺寸必不变 |
| `constraints.isTight` | 约束只剩一个合法尺寸 | 唯一解，无变化空间 |
| `parent == null` | 自己是树根 | 没有父可以传播 |

这行赋值的**位置**很关键——它在 `if (!_needsLayout && constraints == _constraints) return;`（`:2848`）**之前**。这意味着即使这次 `layout` 因为"不脏且约束没变"而提前返回，`_isRelayoutBoundary` 也已经被更新了。这是刻意的：`parentUsesSize` 可能在上一次调用中变了，边界判定必须跟着变，否则脏传播会走错路。

四个条件里，**日常代码里影响最大的是 `constraints.isTight`**。一个 `SizedBox(width: 100, height: 100)` 给孩子的约束是 tight 的，所以**孩子的任何后代变尺寸都不会传播到 `SizedBox` 上面**。这是"给固定尺寸的容器是天然后布局边界"这句话的源码依据。

另一个高频场景：`RenderView` 给孩子的约束来自 `ViewConfiguration`，在正常手机上宽度是 tight 的（等于屏幕宽），高度可能是 loose 的（因为要考虑键盘弹出）。

### 4.3 `flushLayout`：为什么必须按 depth 升序

`_nodesNeedingLayout` 里存的全是 relayout boundary。`flushLayout` 处理它们时有一个硬性前置动作：

```dart
// rendering/object.dart:1159-1180（节选）
while (_nodesNeedingLayout.isNotEmpty) {
  assert(!_shouldMergeDirtyNodes);
  final List<RenderObject> dirtyNodes = _nodesNeedingLayout;
  _nodesNeedingLayout = <RenderObject>[];                       // 1. 先摘走整张表
  dirtyNodes.sort((RenderObject a, RenderObject b) => a.depth - b.depth);   // 2. 按 depth 升序
  for (var i = 0; i < dirtyNodes.length; i++) {
    if (_shouldMergeDirtyNodes) {
      _shouldMergeDirtyNodes = false;
      if (_nodesNeedingLayout.isNotEmpty) {
        _nodesNeedingLayout.addAll(dirtyNodes.getRange(i, dirtyNodes.length));  // 3. 未处理的塞回新表
        break;
      }
    }
    final RenderObject node = dirtyNodes[i];
    if (node._needsLayout && node.owner == this) {
      node._layoutWithoutResize();                               // 4. 真正布局
    }
  }
  _shouldMergeDirtyNodes = false;
}
```

四个细节都值得记住：

1. **先摘表再遍历**。因为第 4 步的 `performLayout` 可能标新的脏节点，它们必须进"新表"而不是"正在遍历的表"。
2. **按 depth 升序**（`object.dart:1163`）。如果父和子同时是边界（父是 `RenderView`，子是 `SizedBox`），必须先布局父。父布局时会调子的 `layout`，子的 `_needsLayout` 被清掉，于是第 4 步里 `if (node._needsLayout)` 判断为 false，**子被自动跳过**——这就是"一趟处理完"的原理：depth 排序保证父先于子，父做完子就不需要单独做了。
3. **第 4 步有 `node.owner == this` 二次检查**（`object.dart:1173`）。因为脏节点可能在遍历过程中被搬到了别的 `PipelineOwner`（嵌套 `View` 场景）。
4. **`_shouldMergeDirtyNodes` 是给 `LayoutBuilder` 打补丁的**（`object.dart:1102` 的注释直说了 "See layout_builder_mutations_test.dart for an example"）。`invokeLayoutCallback` 返回时把它设为 true（`object.dart:1225`），下次循环就会把还没处理的脏节点和新增的脏节点合到一张表里重新排序。

`flushLayout` 在最后对所有子 `PipelineOwner` 递归（`object.dart:1186-1188`），并在 debug 下 assert 子 owner 不能往父的脏表里塞节点。

### 4.4 `markNeedsPaint`：传播到最近的 repaint boundary

paint 的传播规则和 layout 平行但**判据不同**：

```dart
// rendering/object.dart:3326-3367（节选）
void markNeedsPaint() {
  if (_needsPaint) {
    return;                                        // 已经脏了
  }
  _needsPaint = true;
  if (isRepaintBoundary && _wasRepaintBoundary) {
    assert(_layerHandle.layer is OffsetLayer);
    if (owner != null) {
      owner!._nodesNeedingPaint.add(this);         // 我是边界 → 自己进 paint 脏表
      owner!.requestVisualUpdate();
    }
  } else if (parent != null) {
    parent!.markNeedsPaint();                      // 不是边界 → 让父也脏
  } else {
    owner?.requestVisualUpdate();                  // 无父且非边界：只能指望根整体重画
  }
}
```

和 `markNeedsLayout` 的结构几乎一样，只有两处差异：

- 判据是 `isRepaintBoundary`（类级别 getter）而不是 `_isRelayoutBoundary`（layout 时算出来的），**并且还要 `_wasRepaintBoundary` 也为真**。为什么？因为 `isRepaintBoundary` 是可以变的（子类某天返回 false），而 `_wasRepaintBoundary` 记录的是"上次绘制时的边界身份"，也就是"它是否已经有自己的 layer"（赋值点在 `_paintWithContext` 里、调 `paint` 之前，`object.dart:3566`）。如果这一帧刚变成边界、还没有自己的 layer，就走不了"自己重画"这条路，得让父带着画。
- `else` 分支（无父且非边界）**不把自己加进脏表**。注释解释了原因：树根必然会被要求重画，所以不需要登记。而实际上 `RenderView` 的 `isRepaintBoundary` 返回 true（`view.dart:315`），这条分支在实际框架里走不到。

### 4.5 `flushPaint`：唯一的逆序排序

`flushPaint` 是全框架**唯一一处按 depth 降序**处理脏节点的地方：

```dart
// rendering/object.dart:1315-1333（节选）
final List<RenderObject> dirtyNodes = _nodesNeedingPaint;
_nodesNeedingPaint = <RenderObject>[];
// Sort the dirty nodes in reverse order (deepest first).
for (final node in dirtyNodes..sort((RenderObject a, RenderObject b) => b.depth - a.depth)) {
  assert(node._layerHandle.layer != null);
  if ((node._needsPaint || node._needsCompositedLayerUpdate) && node.owner == this) {
    if (node._layerHandle.layer!.attached) {
      if (node._needsPaint) {
        PaintingContext.repaintCompositedChild(node);
      } else {
        PaintingContext.updateLayerProperties(node);
      }
    } else {
      node._skippedPaintingOnLayer();
    }
  }
}
```

为什么这里要反过来？因为 paint 脏表里存的都是**叶子方向的 repaint boundary**。最深的边界先重画，它把自己的 layer 内容刷新完，然后它的父边界再重画时可以直接复用子层（`_compositeChild` 里 `!child._wasRepaintBoundary` 为 false 就不重画子，`object.dart:275`）。**如果顺序反了，子边界的重画会作废父边界刚做完的工作，同一片区域画两遍。**

另一个必须知道的细节：`flushPaint` 里**没有 `while` 循环**（对比 `flushLayout` 的 `while`）。因为 `paint` 阶段不允许标新的 paint 脏（`markNeedsPaint` 开头有 `assert(owner == null || !owner!.debugDoingPaint)`，`object.dart:3328`）。

### 4.6 `markNeedsCompositingBitsUpdate`：一条会"半途停"的向上传播

这是三个传播里规则最绕的一个，因为它有**两个中止条件**：

```dart
// rendering/object.dart:3194-3213
void markNeedsCompositingBitsUpdate() {
  if (_needsCompositingBitsUpdate) {
    return;                                                    // 条件 1：我已经脏了 → 停
  }
  _needsCompositingBitsUpdate = true;
  final RenderObject? parent = this.parent;
  if (parent != null) {
    if (parent._needsCompositingBitsUpdate) {
      return;                                                    // 条件 2：父已经脏了 → 停
    }
    if ((!_wasRepaintBoundary || !isRepaintBoundary) && !parent.isRepaintBoundary) {
      parent.markNeedsCompositingBitsUpdate();                   // 继续往上爬
      return;
    }
  }
  owner?._nodesNeedingCompositingBitsUpdate.add(this);           // 否则自己进脏表
}
```

三个出口的含义：

| 出口 | 条件 | 结果 |
|---|---|---|
| 早退 | 自己已脏 | 什么都不做（父的脏表里已经有自己） |
| 早退 | 父已脏 | 什么都不做（父会负责这棵子树的 `_updateCompositingBits`） |
| 进脏表 | 父是 repaint boundary，或自己是"从边界变成非边界" | 脏表里的节点就是"需要向下递归重算的起点" |
| 继续爬 | 自己是普通节点且父也普通 | 继续向上 |

第三个判据 `(!_wasRepaintBoundary || !isRepaintBoundary) && !parent.isRepaintBoundary` 读起来别扭，翻译一下：**"如果自己刚丢了边界身份，或者父是边界，就别往上爬了"**。理由在 `_updateCompositingBits`（`object.dart:3248-3253`）里有对应处理——刚丢了边界的节点需要重新找一个可绘制的父，它必须自己进脏表被处理。

对应的消费侧：

```dart
// rendering/object.dart:1243-1249（节选）
_nodesNeedingCompositingBitsUpdate.sort((RenderObject a, RenderObject b) => a.depth - b.depth);
for (final RenderObject node in _nodesNeedingCompositingBitsUpdate) {
  if (node._needsCompositingBitsUpdate && node.owner == this) {
    node._updateCompositingBits();       // 递归向下重算 _needsCompositing
  }
}
_nodesNeedingCompositingBitsUpdate.clear();
```

注意方向反了：**脏标记向上传播、清脏向下递归**。`_updateCompositingBits` 会 `visitChildren` 并汇总 `child.needsCompositing`，最后 `if (isRepaintBoundary || alwaysNeedsCompositing) _needsCompositing = true;`（`object.dart:3240-3242`）——所以"边界及其所有祖先 `needsCompositing` 必为 true"是结构保证。

### 4.7 `RenderBox` 多出来的一条：intrinsics 与 baseline 依赖

`RenderBox` 重写了 `markNeedsLayout`，多出一条判断：

```dart
// rendering/box.dart:2856-2860
if (_layoutCacheStorage.clear() && parent != null) {
  markParentNeedsLayout();      // 清缓存成功 = 父用过我的 intrinsics/baseline → 强制父也脏
  return;
}
super.markNeedsLayout();
```

`_layoutCacheStorage`（`box.dart:1134`）每次 `layout` 开始时清空，里面记着**这次 layout 中被谁问过 intrinsics / dry layout / baseline**。`clear()` 返回 true 表示"上次有人问过"，那么即使自己是 relayout boundary，也要强制把父标脏。

这解释了 `object.dart:2548-2553` 那段文档说的"relayout boundary 不覆盖 baseline 依赖"——`intrinsicWidth` / `getDistanceToBaseline` 这类查询**不经过 `layout` 调用**，所以不体现在 `parentUsesSize` 上。`RenderBox` 用这个缓存把这类隐式依赖补回来。写自定义 `RenderBox` 时如果父会读你的 intrinsics，脏传播会比"只看 relayoutBoundary"推得的范围更大，这是正常的。

## 五、核心对象：邻接的两组边界与两张脏表

| | relayoutBoundary | repaintBoundary |
|---|---|---|
| 判据 | `_isRelayoutBoundary`（三态 `bool?`） | `isRepaintBoundary` + `_wasRepaintBoundary` |
| 何时决定 | `layout` 里（`object.dart:2847`） | 类级别，构造时与 `paint` 结束时 |
| 由什么决定 | `parentUsesSize` / `sizedByParent` / 约束是否 tight / 是否树根 | 子类重写的 getter |
| 脏表 | `_nodesNeedingLayout` | `_nodesNeedingPaint` |
| 消费方式 | `_layoutWithoutResize`，**depth 升序** | `repaintCompositedChild`，**depth 降序** |
| 典型触发 | `SizedBox`、`RenderView`、`parentUsesSize: false` | `RenderView`、`RenderViewport`、`RepaintBoundary` |

| | `_nodesNeedingLayout` | `_nodesNeedingPaint` |
|---|---|---|
| 谁进表 | relayout boundary | repaint boundary |
| flush 循环结构 | `while`（布局中可以标新脏） | 单次 `for`（paint 中禁止标脏） |
| 排序 | `a.depth - b.depth` | `b.depth - a.depth` |
| 重复进表 | 不会（`_needsLayout` 短路 + depth 序跳过） | 不会（`_needsPaint` 短路） |
| 调试开关 | `debugPrintMarkNeedsLayoutStacks` | `debugPrintMarkNeedsPaintStacks` |

三者的传播方向与清脏方向不同：layout 与 paint 都是**向上传播、由边界直接消费**；compositing bits 是**向上传播、向下清脏**（`_updateCompositingBits` 递归孩子汇总 `needsCompositing`）。

## 六、源码实验

### 实验 1：`_isRelayoutBoundary` 的全部读写点

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -rn "_isRelayoutBoundary" *.dart
```

**预测**：如果这个字段是"由父决定"的，写入点应该出现在父的 `performLayout` 里。

**实际**：13 条命中全在 `object.dart`，写入点只有 3 处：

```text
object.dart:2847   _isRelayoutBoundary = !parentUsesSize || sizedByParent || ...（唯一的常规写入）
object.dart:2728   _isRelayoutBoundary = true;   （scheduleInitialLayout，树根）
object.dart:2197   child._isRelayoutBoundary = null;（dropChild，条件清除）
```

**说明**：判定完全由 `layout` 自己完成——**父只是通过 `parentUsesSize` 和约束"间接表达"意图，并不直接写子的字段**。另外注意 `dropChild` 的极性：

```dart
// rendering/object.dart:2196-2198
if (!(child._isRelayoutBoundary ?? true)) {
  child._isRelayoutBoundary = null;
}
```

只在孩子**明确是 `false`**（即已确认不是边界）时才清回 `null`。孩子是 `true` 或 `null` 时都保持原样。所以"孩子离开父之后边界判定会被重置"这个说法只对了一半——只有"非边界"的判定会被重置。

### 实验 2：验证 layout 脏表按 depth 升序、paint 脏表按 depth 降序

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -n "dirtyNodes.sort\|dirtyNodes..sort" object.dart
```

**预测**：两张表总得有个确定顺序，最自然的实现是都用同一个方向。

**实际**：

```text
object.dart:1163   dirtyNodes.sort((RenderObject a, RenderObject b) => a.depth - b.depth);   // layout
object.dart:1319   for (final node in dirtyNodes..sort((RenderObject a, RenderObject b) => b.depth - a.depth)) {  // paint
```

**说明**：`flushLayout` 用升序（父先布局），`flushPaint` 用降序（最深的重绘边界先重画）。`flushCompositingBits` 用的是升序（`object.dart:1243`），与 layout 一致。**三处排序方向不是随意的，它编码了"谁依赖谁"**——layout 与 compositing bits 都是父依赖子，paint 是子先于父（因为父的 `_compositeChild` 要复用子的已完成 layer）。

### 实验 3：确认 `flushPaint` 没有 while 循环

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -n "while (_nodesNeedingLayout.isNotEmpty)\|void flushPaint()" object.dart
grep -n "debugDoingPaint" object.dart | head -4
```

**预测**：如果 paint 阶段也能标新脏，`flushPaint` 应该和 `flushLayout` 一样有 `while`。

**实际**：`while (_nodesNeedingLayout.isNotEmpty)` 只在 `object.dart:1159` 出现（layout）；`flushPaint`（`object.dart:1293`）用的是单个 `for`。而 `object.dart:3328` 有 `assert(owner == null || !owner!.debugDoingPaint);`。

**说明**：这条组合证明"paint 阶段不允许标新脏"是**用 debug assert 保证的不变式**，不是调度巧合。如果自定义 RenderObject 在 `paint` 里调 `markNeedsPaint`，debug 模式会直接在 assert 上崩。

### 实验 4：`markNeedsCompositingBitsUpdate` 的中止条件

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
grep -rn "_nodesNeedingCompositingBitsUpdate" object.dart
```

**预测**：既然叫"markNeeds...Update"，应该和 `markNeedsLayout` 一样一路传到树根。

**实际**：只有 4 处引用——声明 `:1233`、`markNeedsCompositingBitsUpdate` 里加表 `:3212`、`flushCompositingBits` 里读 `:1244` 与清 `:1249`。传播会**在遇到第一个已经脏的节点或 repaint boundary 父节点时停下**（`object.dart:3202-3209`）。

**说明**：这就是 35 篇会用到的结论——**repaint boundary 同时是 compositing bits 的传播屏障**。原因是边界自己一定有 layer（`_updateCompositingBits` 里 `isRepaintBoundary || alwaysNeedsCompositing` 强制为 true），所以它上面的节点不需要知道它下面具体怎么合成。

## 七、结论

1. `markNeedsLayout` 有三条分支（已脏返回 / 自己是边界进 `_nodesNeedingLayout` / 否则转交父）。脏标记一路向上爬，遇到第一个 relayout boundary 就停。`_isRelayoutBoundary` 的三态判定写在 `layout` 里的一行（`object.dart:2847`）：`!parentUsesSize || sizedByParent || constraints.isTight || parent == null`。
2. `flushLayout` **必须按 depth 升序**（`object.dart:1163`），因为这保证父先布局——父布局时会调子的 `layout` 并把子的 `_needsLayout` 清掉，于是子被 `if (node._needsLayout)` 自动跳过。`flushPaint` 恰好相反，按 depth 降序（`object.dart:1319`），让最深的 repaint boundary 先重画，父再复用它。`flushLayout` 用 `while`，`flushPaint` 用单次 `for`——因为 paint 阶段用 `debugDoingPaint` assert 禁止标新脏。
3. `markNeedsCompositingBitsUpdate` 的传播规则与前两者不同：脏标记向上传播时会**在 repaint boundary 父节点或已脏节点处停下**（`object.dart:3202-3209`），但清脏是**向下递归**的（`_updateCompositingBits` 遍历孩子汇总 `needsCompositing`）。方向相反是设计的一部分。

**三张脏表、三个边界判据，layout 与 compositing bits 自上而下处理、paint 自下而上处理，这就是 `PipelineOwner` 一帧里做的事。**

## 八、边界声明

- 本文只讲脏标记的产生与消费，不讲 `PipelineOwner` 与平台的接线（`requestVisualUpdate` 如何变成一次 `scheduleFrame`），那属于 scheduler 卷。
- `markNeedsSemanticsUpdate` 的传播规则不在本文展开，语义树整体留到第七卷。
- `RepaintBoundary` 是否值得加、`markNeedsPaint` 形成 layer 之后的成本，交给 35 篇。
- `BoxConstraints` 的 `tight` / `isTight` 只按字面使用，完整语义表在 33 篇。
- `RenderObjectWithLayoutCallbackMixin` 与 `LayoutBuilder` 的完整交互（为什么需要在 layout 中改树）只讲到 `_shouldMergeDirtyNodes` 这一层，不展开 `widgets/layout_builder.dart`。
- 本文聚焦三张脏表的具体判据、排序方向与 `_isRelayoutBoundary` 的完整读写点。
