# 03 树骨架协议：AbstractNode 废弃后 depth 与 owner 去了哪

> 版本锚点：Flutter 3.44.8 (058e0af2c2)
> 源码路径 `foundation/node.dart`（160 行）、`widgets/framework.dart`、`rendering/object.dart`

## 一、问题

Flutter 有三棵树：Widget 树、Element 树、RenderObject 树。后两棵都是真正的对象树，都需要同一套骨架能力：

- 知道自己挂在哪（`parent`）
- 知道整棵树的归属（`owner`）
- 能按"父先于子"的顺序被遍历（`depth`）
- 能整体挂上和脱开（`attach` / `detach`）

按面向对象直觉，这些应该在同一个基类里，然后 `Element` 和 `RenderObject` 都继承它。

**在 3.44.8 里，这个基类确实存在，名字叫 `AbstractNode`——但整个 SDK 只有它自己的文件提到它。**

老资料里写的"Element 和 RenderObject 都继承 AbstractNode"，现在是一条错误信息。这一篇要说清：这套协议是怎么被"内联"进两棵树各自的实现里的，以及为什么内联比共用基类更合理。

## 二、最小 Demo

用 `GlobalKey` 把同一个 Element 在树里挪动位置，观察它的 `depth`：

```dart
import 'package:flutter/widgets.dart';

class LeafBox extends StatefulWidget {
  const LeafBox({super.key});

  @override
  State<LeafBox> createState() => _LeafBoxState();
}

class _LeafBoxState extends State<LeafBox> {
  @override
  Widget build(BuildContext context) => const SizedBox(width: 10, height: 10);
}

/// [wrapped] 为 true 时给叶子套一层 Padding，把它压到更深的位置。
/// GlobalKey 让 Element 在换父节点时被复用（而不是重建），
/// 于是可以观察到 depth 的真实变化。
class DepthShiftLab extends StatelessWidget {
  const DepthShiftLab({super.key, required this.wrapped, required this.leafKey});

  final bool wrapped;
  final GlobalKey leafKey;

  @override
  Widget build(BuildContext context) {
    final Widget leaf = LeafBox(key: leafKey);
    return ColoredBox(
      color: const Color(0xFF00FF00),
      child: wrapped
          ? Padding(padding: const EdgeInsets.all(4), child: leaf)
          : leaf,
    );
  }
}
```

遍历父链打印 depth 的小工具（`_parent` 是私有的，用 `visitAncestorElements` 走上去）：

```dart
String depthChain(Element element) {
  final List<String> parts = <String>['${element.widget.runtimeType}@${element.depth}'];
  element.visitAncestorElements((Element ancestor) {
    parts.add('${ancestor.widget.runtimeType}@${ancestor.depth}');
    return true;
  });
  return parts.join(' < ');
}
```

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `foundation/node.dart:48-51` | `@Deprecated` 标记，一句话说明废弃原因 |
| `foundation/node.dart:52` | `class AbstractNode`，被内联的协议原件 |
| `foundation/node.dart:38-47` | 关于 `depth` 不变式的完整说明（本篇最重要的一段文档） |
| `widgets/framework.dart:3557` | `abstract class Element extends DiagnosticableTree implements BuildContext` |
| `widgets/framework.dart:4345` | `_depth = 1 + (_parent?.depth ?? 0);`，Element 的 depth 初值 |
| `widgets/framework.dart:4427` | `Element._updateDepth`，只增不减的核心 |
| `widgets/framework.dart:3616` | `Element._sort`，depth 的真实用途 |
| `rendering/object.dart:2003` | `abstract class RenderObject with DiagnosticableTreeMixin implements HitTestTarget` |
| `rendering/object.dart:2137` / `2164` / `2192` | `redepthChild` / `adoptChild` / `dropChild` |

两处类声明都值得看一眼：`Element` 的父类是 `DiagnosticableTree`，`RenderObject` 混入 `DiagnosticableTreeMixin`——**没有一个是 `AbstractNode`**。

## 四、调用链

### 4.1 先确认废弃：整个 SDK 只有 1 个文件提到它

```bash
cd $(dirname $(dirname $(which flutter)))
grep -rl "AbstractNode" . --include="*.dart"
```

结果是 1 个文件：`packages/flutter/lib/src/foundation/node.dart` 自己。

而它对外的 `@Deprecated` 消息写得很直接：

```dart
// node.dart:48-51
@Deprecated(
  'If needed, inline any required functionality of AbstractNode in your class directly. '
  'This feature was deprecated after v3.12.0-4.0.pre.',
)
class AbstractNode {
```

注意 "inline ... directly" 这个措辞：废弃方案不是"换一个新基类"，而是**让每个子类自己写一遍**。

**关键认知**：`node.dart` 现在的作用不是"被继承的基类"，而是一份**协议说明书**。它的字段、方法名、注释把"一棵树需要什么"讲得很清楚，`Element` 和 `RenderObject` 各自按这份说明写了一份实现。所以这个文件仍然值得读，但别指望在别处找到它的引用。

### 4.2 协议去哪了：三份实现的逐行对比

**`depth` 的初始化**

`Element` 在 `mount` 里直接算出来：

```dart
// widgets/framework.dart:4328 起
void mount(Element? parent, Object? newSlot) {
  assert(_lifecycleState == _ElementLifecycle.initial, ...);
  assert(_parent == null, ...);
  assert(parent == null || parent._lifecycleState == _ElementLifecycle.active, ...);
  assert(slot == null, ...);
  _parent = parent;                                   // 4342
  _slot = newSlot;
  _lifecycleState = _ElementLifecycle.active;
  _depth = 1 + (_parent?.depth ?? 0);                 // 4345
  if (parent != null) {
    _owner = parent.owner;                            // 4349，owner 从父亲继承
    _parentBuildScope = parent.buildScope;
  }
  assert(owner != null);
  final Key? key = widget.key;
  if (key is GlobalKey) {
    owner!._registerGlobalKey(key, this);             // GlobalKey 在这里登记
  }
  _updateInheritance();
  attachNotificationTree();
}
```

`RenderObject` 的 `_depth` 则是字段默认值 `0` + `adoptChild` 时重算：

```dart
// rendering/object.dart:2129-2130
int get depth => _depth;
int _depth = 0;
```

**`redepthChild`：几乎逐字相同**

这一对最能说明"内联"的含义——`RenderObject` 的版本和废弃基类的版本逻辑完全一样：

```dart
// foundation/node.dart:65-71（已废弃的基类）
void redepthChild(AbstractNode child) {
  assert(child.owner == owner);
  if (child._depth <= _depth) {
    child._depth = _depth + 1;
    child.redepthChildren();
  }
}
```

```dart
// rendering/object.dart:2137-2143（现役实现）
void redepthChild(RenderObject child) {
  assert(child.owner == owner);
  if (child._depth <= _depth) {
    child._depth = _depth + 1;
    child.redepthChildren();
  }
}
```

**`Element` 走的是另一条路。** 它没有 `redepthChild`，只有一个 `_updateDepth`：

```dart
// widgets/framework.dart:4427-4434
void _updateDepth(int parentDepth) {
  final int expectedDepth = parentDepth + 1;
  if (_depth < expectedDepth) {
    _depth = expectedDepth;
    visitChildren((Element child) {
      child._updateDepth(expectedDepth);
    });
  }
}
```

两处差异值得注意：

| | `RenderObject.redepthChild` | `Element._updateDepth` |
|---|---|---|
| 判断条件 | `child._depth <= _depth` | `_depth < expectedDepth` |
| 递归对象 | 只在需要时 `redepthChildren()` | 变化时无条件 `visitChildren` |
| 语义 | "我不够深就抬一级，再看看孩子" | "我不够深就设为父+1，孩子全按我重算" |

**调用时机也不同**：`RenderObject` 是在 `adoptChild`（建立父子关系）时通过 `redepthChild` 传播；`Element` 是在 `mount` 时直接算，另外在 `_activateWithParent`（GlobalKey 搬运）时调一次：

```dart
// widgets/framework.dart:4717-4731
void _activateWithParent(Element parent, Object? newSlot) {
  assert(_lifecycleState == _ElementLifecycle.inactive);
  _parent = parent;
  _owner = parent.owner;
  ...
  _updateDepth(_parent!.depth);      // 4727
  _updateBuildScopeRecursively();
  _activateRecursively(this);
  attachRenderObject(newSlot);
  assert(_lifecycleState == _ElementLifecycle.active);
}
```

**`adoptChild`：这才是必须内联的理由**

如果只是 `depth`，共用基类本来是可以的。真正让共用变得不划算的是 `adoptChild` / `dropChild` 的**副作用**：

```dart
// foundation/node.dart:130-145（废弃基类的版本：只有三件事）
void adoptChild(covariant AbstractNode child) {
  assert(child._parent == null);
  ... // 环检测
  child._parent = this;
  if (attached) {
    child.attach(_owner!);
  }
  redepthChild(child);
}
```

```dart
// rendering/object.dart:2164-2190（现役版本：五件事）
void adoptChild(RenderObject child) {
  assert(child._parent == null);
  ... // 环检测
  setupParentData(child);              // 1. 分配 parentData
  markNeedsLayout();                   // 2. 自己要重新布局
  markNeedsCompositingBitsUpdate();    // 3. 合成位要重算
  markNeedsSemanticsUpdate();          // 4. 语义要重建
  child._parent = this;
  if (attached) {
    child.attach(_owner!);
  }
  redepthChild(child);
}
```

`dropChild` 里还有更具体的树语义：

```dart
// rendering/object.dart:2192-2211（节选）
void dropChild(RenderObject child) {
  assert(child._parent == this);
  if (!(child._isRelayoutBoundary ?? true)) {
    child._isRelayoutBoundary = null;   // 清掉缓存的重布局边界判定
  }
  child.parentData!.detach();           // parentData 也要脱钩
  child.parentData = null;
  ...
}
```

**关键认知**：`RenderObject` 的"成为某个节点的孩子"要额外触发 **layout / 合成 / 语义** 三条脏传播；`Element` 的"成为孩子"要额外处理 **GlobalKey 登记、buildScope、inherited 依赖**；而 `AbstractNode` 定义的 `adoptChild` 只做 `parent` + `attach` + `redepth`。这三套语义差异太大，共用基类只能靠"子类重写并调用 super"来补——而一旦每个子类都要重写，基类就只剩噪音了。这就是废弃理由里 "inline ... directly" 的含义。

再看 `Element`：它**连 `adoptChild` / `dropChild` 这对方法都没有**。它是多孩子容器，孩子关系的建立分散在 `updateChild`、`inflateWidget`、`deactivateChild` 里，`_parent` 的赋值出现在 `mount`（4342）和 `_activateWithParent`（4719）等处。`Element` 的树操作本来就是按"更新流程"组织的，硬套一个通用的 `adoptChild` 反而要额外翻译一层。

### 4.3 `depth` 到底用来干什么

答案在 `Element` 里的排序函数：

```dart
// widgets/framework.dart:3616 起
static int _sort(Element a, Element b) {
  final int diff = a.depth - b.depth;
  // If depths are not equal, return the difference.
  if (diff != 0) {
    return diff;
  }
  // 深度相同的情况下再按 dirty 状态排
  ...
}
```

**`depth` 的唯一用途是排序**——把脏 Element 排成"父在子之前"的顺序，保证一次遍历就能按拓扑序处理。

这解释了为什么 `depth` 只需要"大于父节点"而不需要"正好等于父节点 +1"。废弃基类的文档把这件事写得非常清楚（`node.dart:38-47`），值得整段读：

> Nodes always have a depth greater than their ancestors'. There's no guarantee regarding depth between siblings. ... The depth of a child can be more than one greater than the depth of the parent, because the depth values are never decreased: all that matters is that it's greater than the parent. Consider a tree with a root node A, a child B, and a grandchild C. Initially, A will have depth 0, B depth 1, and C depth 2. If C is moved to be a child of A, sibling of B, then the numbers won't change. C's depth will still be 2.

**关键认知**：`depth` 不是"层数"，是**单调递增的排序令牌**。它只增不减，所以拿它当"第几层"来推理一定会得出错误结论（第六节的实测会给出一个子节点比父节点大 2 的实际例子）。

## 五、核心对象：三份树协议对比

| | `AbstractNode`（废弃） | `RenderObject` | `Element` |
|---|---|---|---|
| 声明位置 | `node.dart:52` | `object.dart:2003` | `framework.dart:3557` |
| 父类 | 无 | 混入 `DiagnosticableTreeMixin` | `extends DiagnosticableTree` |
| `owner` 类型 | `Object?` | `PipelineOwner?` | `BuildOwner?` |
| `owner` 来源 | `attach(owner)` 传入 | `attach(owner)` 传入 | `mount` 时 `_owner = parent.owner` |
| depth 初始化 | `_depth = 0` | `_depth = 0` | `mount` 里 `1 + parent.depth` |
| depth 更新 | `redepthChild` | `redepthChild` | `_updateDepth` |
| `adoptChild` | 只做 parent/attach/redepth | 额外 setupParentData + 三个 markNeeds* | 没有这个方法 |
| `parent` 可见性 | 公开 getter | 公开 getter | **私有** `_parent`，外部只能 `visitAncestorElements` |
| 是否有环检测 | 有 | 有 | 无（由更新流程保证） |

最后一行是个实用细节：**Element 的父节点对外不可见**。想在业务代码里向上找祖先，必须用 `visitAncestorElements` 或 `context.findAncestorWidgetOfExactType` 这类受控 API。这是刻意的——Element 的父子关系会被更新流程频繁改写，直接暴露会诱发不安全的持有。

## 六、源码实验

### 实验 1：证实 AbstractNode 已无人使用

```bash
cd $(dirname $(dirname $(which flutter)))
grep -rn "AbstractNode" packages/ --include="*.dart"
```

**预测**：如果这个基类还在承担骨架职责，`Element` 和 `RenderObject` 的文件里至少各有一处引用。

**实际**：8 条命中全部在 `node.dart` 自己文件内部（文档注释 1 条、废弃注解 1 条、类声明 1 条、方法签名与字段 5 条）。

**说明**：这直接推翻了"Element 继承 AbstractNode"这类流传很广的描述。凡是介绍三棵树的资料，都要先确认它写的是哪个版本。

### 实验 2：观察 depth 在 GlobalKey 搬运时的变化

用第二节的 `DepthShiftLab`，按下面顺序 pump 并打印 `depthChain(leafElement)`：

1. `wrapped: false`
2. `wrapped: true`
3. `wrapped: false`

**预测**：套上一层 `Padding` 之后，叶子的父节点变深了，所以叶子自己的 depth 应该 +1；再拆掉 `Padding` 后，depth 应该回到原值。

**实际**（实测输出）：

```text
第 1 次：_LeafBox@17 < ColoredBox@16 < _Lab@15 < Directionality@14 < ...
第 2 次：_LeafBox@18 < Padding@17 < ColoredBox@16 < _Lab@15 < Directionality@14 < ...
第 3 次：_LeafBox@18 < ColoredBox@16 < _Lab@15 < Directionality@14 < ...
```

**说明**：预测的前半对了（17 → 18），后半错了（没有回到 17）。

第 3 次的状态是关键证据：叶子的 depth 是 **18**，而它的父节点 `ColoredBox` 只有 **16**——子节点比父节点大 2。这不是 bug，正是 `node.dart:38-47` 文档描述的行为：`_updateDepth` 发现 `expectedDepth (17) < _depth (18)`，于是什么都不做。

**代价与收益**：代价是 depth 会偏大（排序令牌与真实层级脱钩）；收益是**移动节点时不需要更新整棵子树**——只有变深才需要向下传播，变浅什么都不用做。

### 实验 3：确认 depth 只用于排序

```bash
grep -rn "\.depth" packages/flutter/lib/src/widgets/framework.dart | grep -v "^.*///"
```

**预测**：如果 depth 有"层级"含义，应该能看到拿它做算术的地方（比如 `== parent.depth + 1`）。

**实际**：命中集中在 `mount` 计算初值、`_updateDepth` 做比较、`_sort` 做排序三处，没有任何一处把它当层级使用。

### 实验 4：一个容易踩的坑（测量方式本身）

第一次做实验 2 时，我把两次读到的 `Element` 对象存下来做比较，结果两次 `depth` 都是 18：

```dart
final Element before = tester.element(find.byKey(leafKey));  // 存的是对象引用
await tester.pumpWidget(...wrapped: true...);
final Element after = tester.element(find.byKey(leafKey));
print('${before.depth} ${after.depth}');                     // 18 18
```

**原因**：GlobalKey 复用的正是**同一个 Element 实例**，`before` 和 `after` 是同一个可变对象，读 `before.depth` 读到的是它被更新后的新值。

**说明**：观察可变对象的"变化前后"，一定要在变更**之前**把值取出来存成不可变快照（`final int beforeDepth = element.depth;`）。这个坑在跟 Element / RenderObject 状态时几乎必然遇到。

## 七、结论

1. `AbstractNode` 在 3.44.8 已废弃，且整个 SDK 只有它自己的文件提到它。树骨架协议被**内联**进了 `Element` 和 `RenderObject` 各自的实现——不是因为协议不同，而是因为 `adoptChild` / `dropChild` 要触发的副作用（layout / 合成 / 语义 / GlobalKey / buildScope）差异太大，共用基类只剩噪音。
2. `depth` 是**单调递增的排序令牌**，不是层数。它只增不减，只用于 `_sort` 保证"父先于子"的遍历顺序；子节点比父节点大 2 甚至更多都是正常状态。
3. `Element` 的 `owner` 来自父节点继承（`mount` 里 `_owner = parent.owner`），而 `RenderObject` 的 `owner` 来自 `attach(PipelineOwner)` 传入。理解"谁触发 attach"就理解了三条树的挂载时机。

一句话总结：**树骨架没有基类了，`node.dart` 从"被继承的代码"变成了"描述不变式的说明书"。**

## 八、边界声明

- 本篇只讲树骨架（parent / owner / depth / attach）。`markNeedsLayout`、`markNeedsPaint` 的脏传播逻辑留到第八卷篇 32。
- `GlobalKey` 的注册表、`_retakeInactiveElement` 的完整搬运流程留到第九卷篇 39。
- `parentData` 是什么、`setupParentData` 为什么要单独一步，留到第八卷篇 31。
- `Element` 的完整生命周期（`mount` → `activate` → `deactivate` → `unmount`）留到第九卷篇 41。
