# 29 Semantics 树：配置如何从 RenderObject 生成

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `semantics/semantics.dart`（7188 行）、`semantics/binding.dart`（263 行）、`rendering/object.dart`（`RenderObject` 的语义部分）

## 一、问题

无障碍树（也叫语义树）是从哪来的？

错误直觉是"`Semantics` widget 就是 `SemanticsNode`"，于是会推出两个错误结论：
1. 没写 `Semantics` 就没有语义节点；
2. 写了 `Semantics` 就一定会多出一个节点。

两个都不对。真实关系是：**`SemanticsNode` 由 `RenderObject` 产出，widget 本身并不产出节点**；`Semantics` widget 只是"往某个 RenderObject 上挂一段 `SemanticsConfiguration`"的手段，这段配置**可能**让它形成一个独立节点，也**可能**只是给父节点补了几个属性。

这一篇只讲清三件事：`RenderObject` 怎么产出 `SemanticsConfiguration`（`describeSemanticsConfiguration`）、配置怎么变成 `SemanticsNode`（`isSemanticBoundary` 分支）、以及更新是怎么被调度起来的（`markNeedsSemanticsUpdate` → `flushSemantics`）。无障碍 API 的完整覆盖不在本文范围。

## 二、最小 Demo

同一段内容，"形成独立节点"和"合并进父节点"两种写法，产出的树结构完全不同：

```dart
import 'package:flutter/widgets.dart';

/// 写法 A：container: true → 自己开一个语义节点
Widget boundary() => Center(
  child: Semantics(
    label: 'outer',
    container: true,                        // 1. 关键：声明自己是语义边界
    child: const SizedBox(width: 10, height: 10),
  ),
);

/// 写法 B：MergeSemantics → 开一个节点并把后代的配置吸进来
Widget merge() => Center(
  child: MergeSemantics(                    // 2. 内部把 isMergingSemanticsOfDescendants 置 true
    child: Semantics(
      label: 'outer',                       // 3. 不再需要 container: true
      child: const SizedBox(width: 10, height: 10),
    ),
  ),
);
```

遍历语义树把它们打出来：

```dart
void dump(SemanticsNode node, String indent) {
  debugPrint('$indent#${node.id} merges=${node.mergeAllDescendantsIntoThisNode} '
      'label="${node.getSemanticsData().label}"');
  node.visitChildren((SemanticsNode child) {
    dump(child, '$indent  ');
    return true;
  });
}

// 调用前必须先申请一个句柄，否则框架根本不收集语义信息
final SemanticsHandle handle = SemanticsBinding.instance.ensureSemantics();
dump(SemanticsOwner...rootSemanticsNode, '');
handle.dispose();       // 4. 不 dispose 会一直收集
```

在测试里可以拿到根节点：`tester.binding.pipelineOwner.semanticsOwner?.rootSemanticsNode`。第 6 节实验 1 给出的输出就是这两种写法的树形对比。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `semantics/binding.dart:21` | `mixin SemanticsBinding on BindingBase`：语义层与引擎之间的粘合层 |
| `semantics/binding.dart:29-38` | `initInstances`：挂 `onSemanticsEnabledChanged` / `onSemanticsActionEvent` / `onAccessibilityFeaturesChanged` |
| `semantics/binding.dart:64` | `semanticsEnabled`：由 `_semanticsEnabled`（`ValueNotifier<bool>`）驱动 |
| `semantics/binding.dart:128` | `ensureSemantics()`：句柄计数 +1，**计数 > 0 才收集语义** |
| `semantics/binding.dart:146` | `_handleSemanticsEnabledChanged`：平台说"要语义"时自动 `ensureSemantics()` |
| `semantics/binding.dart:155` | `_handleSemanticsActionEvent`：无障碍操作入向 |
| `semantics/binding.dart:189` | `performSemanticsAction`：由渲染层实现 |
| `semantics/binding.dart:247` | `class SemanticsHandle`：只有 `dispose()` |
| `rendering/object.dart:3835` | `RenderObject.describeSemanticsConfiguration(SemanticsConfiguration config)`：**唯一的配置生产点** |
| `rendering/object.dart:3861` | `Rect get semanticBounds`：抽象方法，每个 RenderObject 子类必须实现 |
| `rendering/object.dart:3788` | `scheduleInitialSemantics()`：把自己排进待更新集合 |
| `rendering/object.dart:3909` | `markNeedsSemanticsUpdate()`：脏传播的公开入口 |
| `rendering/object.dart:3918` | `late final _RenderObjectSemantics _semantics = _RenderObjectSemantics(this);` |
| `rendering/object.dart:3946` | `assembleSemanticsNode(node, config, children)`：语义边界处组装节点 |
| `rendering/object.dart:1427` | `_nodesNeedingSemanticsUpdate`：只放"语义边界祖先" |
| `rendering/object.dart:1436` | `_nodesNeedingSemanticsGeometryUpdate`：只放"几何脏了的节点" |
| `rendering/object.dart:1451` | `PipelineOwner.flushSemantics()`：按 depth 排序后逐节点重建 |
| `rendering/object.dart:3953` | 默认 `assembleSemanticsNode` 的实现就是调用 `node.updateWith(...)` |
| `rendering/object.dart:5523` | `class _RenderObjectSemantics extends _SemanticsFragment`：`_semantics` 的真实类型 |
| `rendering/object.dart:6423` | `_RenderObjectSemantics.markNeedsUpdate()`：往上找到语义边界为止 |
| `rendering/object.dart:6255` | `configProvider.effective.isSemanticBoundary` 的分支 |
| `rendering/object.dart:6278` | `_createSemanticsNode()`：根节点用 `SemanticsNode.root`，其余用 `SemanticsNode()` |
| `rendering/binding.dart:650` | `rootPipelineOwner.flushSemantics(); // this sends the semantics to the OS.` |
| `semantics/semantics.dart:1630` | `class SemanticsProperties extends DiagnosticableTree`：widget 侧的属性集合（不直接进树） |
| `widgets/basic.dart:7945` | `class Semantics extends _SemanticsBase`：`Semantics` widget 的真实位置 |
| `widgets/basic.dart:8124` | `class MergeSemantics extends SingleChildRenderObjectWidget` |
| `rendering/proxy_box.dart:4309` | `class RenderSemanticsAnnotations extends RenderProxyBox with SemanticsAnnotationsMixin` |
| `rendering/object.dart:4927` | `SemanticsAnnotationsMixin.describeSemanticsConfiguration`：`SemanticsProperties` 真正被写进配置的地方 |
| `rendering/custom_paint.dart:904` | 覆写 `assembleSemanticsNode` 自己 new `SemanticsNode` 的真实例子 |
| `semantics/semantics.dart:2769` | `class SemanticsNode with DiagnosticableTreeMixin` |
| `semantics/semantics.dart:2781` | `SemanticsNode.root`：id 固定为 0 |
| `semantics/semantics.dart:3100` | `visitChildren(SemanticsNodeVisitor visitor)` |
| `semantics/semantics.dart:3689` | `updateWith({config, childrenInInversePaintOrder})`：把配置写进节点 |
| `semantics/semantics.dart:3771` | `getSemanticsData()`：把节点还原成一个合并后的值对象 |
| `semantics/semantics.dart:4817` | `class SemanticsOwner extends ChangeNotifier` |
| `semantics/semantics.dart:4840` | `rootSemanticsNode => _nodes[0]` |
| `semantics/semantics.dart:5152` | `class SemanticsConfiguration` |
| `semantics/semantics.dart:5168` | `isSemanticBoundary`：**本文的核心开关** |
| `semantics/semantics.dart:5222` | `explicitChildNodes`：子节点是否必须各自成节点 |
| `semantics/semantics.dart:5239` | `isBlockingSemanticsOfPreviouslyPaintedNodes`：遮挡之前绘制的兄弟 |
| `semantics/semantics.dart:5249` | `hasBeenAnnotated`：这段配置是否"有内容" |
| `semantics/semantics.dart:5858` | `isMergingSemanticsOfDescendants`：`MergeSemantics` 用的开关 |
| `semantics/semantics.dart:6746` | `SemanticsConfiguration.absorb(child)`：把子配置吸收进自己 |

## 四、调用链

### 4.1 三个类，一次单向转换

`semantics` 层的三个核心类构成一次单向转换，而且方向是固定的：

```text
SemanticsProperties（widget 侧，不可变）
        ↓  由 Semantics widget（widgets/basic.dart:7945）经
          RenderSemanticsAnnotations 写入
RenderObject.describeSemanticsConfiguration(config)      rendering/object.dart:3835
        ↓  填出一个可变的 SemanticsConfiguration       semantics/semantics.dart:5152
SemanticsConfiguration（可变的"待办清单"）
        ↓  由 _RenderObjectSemantics 在 flushSemantics 期间消费
SemanticsNode（树节点，持有最终数据）                      semantics/semantics.dart:2769
```

`SemanticsConfiguration` 是**一次性的中间产物**。它的文档明确说了"不要持有这个对象的引用"（`rendering/object.dart:3805-3810`）：配置对象在每次语义更新时由 `_SemanticsConfigurationProvider` 重新生产，外部保留引用只会在下次更新时读到陈旧或崩溃的数据。这也是"三个类不能混用"的原因。

**顺带一个路径上的坑**：`Semantics` widget **不在** `widgets/semantics.dart` 里（这个文件不存在），而是在 `widgets/basic.dart:7945`；它对应的 RenderObject 是 `RenderSemanticsAnnotations`（`rendering/proxy_box.dart:4309`），真正把 `SemanticsProperties` 写进配置的方法是 `SemanticsAnnotationsMixin.describeSemanticsConfiguration`（`rendering/object.dart:4927`）。`MergeSemantics` 同样在 `widgets/basic.dart:8124`。按 `widgets/semantics.dart` 找代码会一无所获。

而 `SemanticsProperties` 又是另一回事：它是 `Semantics` widget 的构造参数集合，是一个 `@immutable` 的值对象（`semantics.dart:1630`）。它**不参与树**，只是"我想要的属性"的声明。

### 4.2 唯一的配置生产点

`RenderObject` 上产出配置的方法只有一个，默认实现是空的：

```dart
// rendering/object.dart:3835-3837
@protected
void describeSemanticsConfiguration(SemanticsConfiguration config) {
  // Nothing to do by default.
}
```

它的官方示例（`rendering/object.dart:3813-3826`）就是最直接的用法：

```dart
@override
void describeSemanticsConfiguration(SemanticsConfiguration config) {
  super.describeSemanticsConfiguration(config);
  config
    ..onTap = _handleTap
    ..label = 'I am a button'
    ..isButton = true;
}
```

`config` 是**参数**，不是返回值，也不是字段。RenderObject **不持有**自己的配置——配置每次都是现场填一份新的。所以"修改语义"这件事只能通过 `markNeedsSemanticsUpdate()` 触发一次重填，不能直接改配置对象。

`RenderObject` 里唯一和语义相关的持久状态是这个字段：

```dart
// rendering/object.dart:3918
late final _RenderObjectSemantics _semantics = _RenderObjectSemantics(this);
```

`_RenderObjectSemantics`（`rendering/object.dart:5523`）才是真正的"状态持有者"：它缓存 `cachedSemanticsNode`、记录 `parentData`、持有 `configProvider`。

### 4.3 脏传播：只到语义边界为止

```dart
// rendering/object.dart:3909-3916
void markNeedsSemanticsUpdate() {
  assert(!_debugDisposed);
  assert(!attached || !owner!._debugDoingSemantics);
  if (!attached || owner!._semanticsOwner == null) {
    return;                       // 没挂上树、或语义没开 → 什么都不做
  }
  _semantics.markNeedsUpdate();
}
```

真正的脏传播在 `_RenderObjectSemantics.markNeedsUpdate`（`rendering/object.dart:6423` 起）：

```dart
// rendering/object.dart:6426-6460（节选）
void markNeedsUpdate() {
  renderObject.owner!._nodesNeedingSemanticsGeometryUpdate.add(renderObject);
  final SemanticsNode? producedSemanticsNode = cachedSemanticsNode;
  // Dirty the semantics tree starting at `this` until we have reached a
  // RenderObject that is a semantics boundary. All semantics past this
  // RenderObject are still up-to date. ...
  final bool wasSemanticsBoundary =
      producedSemanticsNode != null && configProvider.wasSemanticsBoundary;

  configProvider.clear();
  _containsIncompleteFragment = false;
  ...
  bool isEffectiveSemanticsBoundary =
      configProvider.effective.isSemanticBoundary && wasSemanticsBoundary;
  RenderObject node = renderObject;
  while (node.parent != null && (mayProduceSiblingNodes || !isEffectiveSemanticsBoundary)) {
    ...
    node._semantics.parentData = null;
    node = node.parent!;
  }
}
```

这段代码里有三个设计要点：

1. **必须在已 attach 且 `semanticsOwner != null` 时才做**（`rendering/object.dart:3912-3914`）。`_semantics.markNeedsUpdate` 里还有一句更硬的断言：`assert(!attached || !owner!._debugDoingSemantics)`，防止在语义构建过程中再次标脏。
2. **脏传播往上走到"有效的语义边界"就停**。因为边界之上的节点的语义仍然是最新的，不需要重建。
3. **`isEffectiveSemanticsBoundary` 要求"配置声明是边界"且"上次真的是边界"**（`wasSemanticsBoundary`）。这意味着一个 RenderObject 从"边界"变成"非边界"时，脏会继续往上传播——否则它的配置会以错误的位置合并进树。

### 4.4 重建：`flushSemantics` 与两个集合

```dart
// rendering/object.dart:1451-1478（节选）
void flushSemantics() {
  if (_semanticsOwner == null) {
    return;
  }
  ...
  // This has to be a top-down order to be more performant. Otherwise, a parent
  // change can invalidate the whole subtree.
  final List<RenderObject> nodesToProcess =
      _nodesNeedingSemanticsUpdate
          .where((RenderObject object) => !object._needsLayout && object.owner == this)
          .toList()
        ..sort((RenderObject a, RenderObject b) => a.depth - b.depth);
  _nodesNeedingSemanticsUpdate.clear();
  ...
  for (final node in nodesToProcess) {
    if (node._semantics.parentDataDirty) {
      ...
```

两个集合的分工是这一节的关键：

| 集合 | 声明位置 | 内容 | 用途 |
|---|---|---|---|
| `_nodesNeedingSemanticsUpdate` | `rendering/object.dart:1427` | **脏节点的最近语义边界祖先**（文档明确说"集合里全是语义边界"） | 决定从哪些节点开始重建子树 |
| `_nodesNeedingSemanticsGeometryUpdate` | `rendering/object.dart:1434` | 直接变脏的那些节点本身 | 重建几何（rect / transform / clip） |

`nodesToProcess` 按 **`depth` 升序**排序（`rendering/object.dart:1467`），也就是"父先于子"。源码的注释解释了原因：如果先处理子节点，父节点后续的变化会让整棵子树作废，白做一遍。这个排序用的 `depth` 就是第三篇里那个"单调递增的排序令牌"——**它在这里又一次只被用于排序**。

`flushSemantics` 在渲染管线里的位置也很明确：

```dart
// rendering/binding.dart:645-652（节选）
rootPipelineOwner.flushPaint();
if (sendFramesToEngine) {
  for (final RenderView renderView in renderViews) {
    renderView.compositeFrame(); // this sends the bits to the GPU
  }
  rootPipelineOwner.flushSemantics(); // this sends the semantics to the OS.
  _firstFrameSent = true;
}
```

**语义在 paint 和 composite 之后**——因为语义节点的 rect / clip 需要 `paintBounds` / `semanticBounds` 已经确定。

### 4.5 配置 → 节点：一个 if 决定树的形状

`_RenderObjectSemantics` 在组装阶段做判断：

```dart
// rendering/object.dart:6255-6259
if (configProvider.effective.isSemanticBoundary) {
  renderObject.assembleSemanticsNode(node, configProvider.effective, children);
} else {
  node.updateWith(config: configProvider.effective, childrenInInversePaintOrder: children);
}
```

```dart
// rendering/object.dart:3946-3955
void assembleSemanticsNode(
  SemanticsNode node,
  SemanticsConfiguration config,
  Iterable<SemanticsNode> children,
) {
  assert(node == _semantics.cachedSemanticsNode);
  node.updateWith(config: config, childrenInInversePaintOrder: children as List<SemanticsNode>);
}
```

两个分支的结果不同：

| | `isSemanticBoundary == true` | `isSemanticBoundary == false` |
|---|---|---|
| 谁被调用 | `RenderObject.assembleSemanticsNode`（可被覆写） | 直接 `node.updateWith` |
| 节点归属 | 这个 RenderObject 有**自己的** `SemanticsNode` | 配置**合并进最近的祖先节点** |
| 子节点 | 作为独立子节点挂上去 | 继续往上冒泡 |
| 子类能做什么 | 可以自己 new 额外的 `SemanticsNode`（比如滚动列表的行为） | 什么都做不了 |

这正是 `assembleSemanticsNode` 的文档（`rendering/object.dart:3931-3944`）说明的：**只有语义边界会被调用**，覆写它就必须同时在 `clearSemantics` 里释放自己 new 出来的节点。

`isSemanticBoundary` 本身的定义并不特殊：

```dart
// semantics/semantics.dart:5168-5173
bool get isSemanticBoundary => _isSemanticBoundary;
bool _isSemanticBoundary = false;
set isSemanticBoundary(bool value) {
  assert(!isMergingSemanticsOfDescendants || value);   // ← 注意这条断言
  _isSemanticBoundary = value;
}
```

`isSemanticBoundary` 的 setter 有一条断言——**只要 `isMergingSemanticsOfDescendants` 为 true，就强制 `isSemanticBoundary` 也必须为 true**。这就是 `MergeSemantics` 能把后代配置吸进自己节点的原因：它先把自己变成边界，再用 `absorb` 把子配置收上来。第 6 节实验 1 的输出里，`MergeSemantics` 那条支路多出来的节点 `merges=true` 就是这条断言的产物。

### 4.6 语义的"开关"：为什么默认什么都不收集

语义树的构建成本不低（每帧要遍历、要算几何），所以框架**默认不建**。开关是句柄计数：

```dart
// semantics/binding.dart:128-134
SemanticsHandle ensureSemantics() {
  assert(_outstandingHandles >= 0);
  _outstandingHandles++;
  assert(_outstandingHandles > 0);
  _semanticsEnabled.value = true;
  return SemanticsHandle._(_didDisposeSemanticsHandle);
}
```

`semanticsEnabled`（`semantics/binding.dart:64-67`）的值就是"句柄数 > 0"。而 `SemanticsBinding.initInstances` 会监听平台的请求：

```dart
// semantics/binding.dart:146-152
void _handleSemanticsEnabledChanged() {
  if (platformDispatcher.semanticsEnabled) {
    _semanticsHandle ??= ensureSemantics();
  } else {
    _semanticsHandle?.dispose();
  }
}
```

`_semanticsHandle` 是 `??=`，**整个框架只保留一个"平台需要的"句柄**。业务代码自己的 `ensureSemantics()` 和它是并列的计数。这解释了 `SemanticsHandle` 为什么必须 `dispose()`（`semantics/binding.dart:256-262`）：只要有一个句柄没释放，整棵语义树就会一直被重建。

## 五、核心对象：三组对比

**第一组：三个语义类。**

| | `SemanticsProperties` | `SemanticsConfiguration` | `SemanticsNode` |
|---|---|---|---|
| 声明位置 | `semantics.dart:1630` | `semantics.dart:5152` | `semantics.dart:2769` |
| 可变性 | `@immutable` | 可变（每次更新重建） | 可变（跨帧复用） |
| 谁创建 | 开发者（`Semantics(...)` 的参数） | 框架（`_SemanticsConfigurationProvider`） | 框架（`_createSemanticsNode`） |
| 生命周期 | 跟随 widget | 一次更新 | 跨多次更新（有 id） |
| 进树吗 | 不进 | 不进 | **进** |
| 能否被外部持有 | 可以 | **不可以**（文档明确禁止） | 可以（调试用 `debugSemantics`） |

**第二组：三个"边界相关"开关。**

| | `isSemanticBoundary` | `isMergingSemanticsOfDescendants` | `explicitChildNodes` |
|---|---|---|---|
| 声明位置 | `semantics.dart:5168` | `semantics.dart:5858` | `semantics.dart:5222` |
| 回答的问题 | "我要不要有自己的节点？" | "我要不要把后代的配置吸到自己身上？" | "我的子节点能不能直接往我这里写属性？" |
| 隐含关系 | 它是基础开关 | true 时**强制**前者也为 true（setter 断言） | 常与前者配合使用 |
| 对应 widget | `Semantics(container: true)` | `MergeSemantics` | `Semantics(explicitChildNodes: true)` |
| 对子树的影响 | 子树不再向上泄漏 | 后代的属性合并成一个节点 | 后代必须各自成节点才能贡献语义 |

第三个开关容易和第二个混。区分方式：`isMergingSemanticsOfDescendants` 是"**我吸收别人**"，`explicitChildNodes` 是"**别人必须自己开节点**"——前者把树压扁，后者把树撑开。

**第三组：`SemanticsNode` 上的两个方法。**

| | `updateWith` | `assembleSemanticsNode` |
|---|---|---|
| 声明位置 | `semantics/semantics.dart:3689`（节点侧） | `rendering/object.dart:3946`（RenderObject 侧） |
| 谁调用 | 渲染层（`_RenderObjectSemantics`） | 渲染层的边界分支 |
| 参数 | `config` + `childrenInInversePaintOrder` | `node` + `config` + `children` |
| 子类是否可覆写 | 不能（`SemanticsNode` 不是给子类覆写的） | **能**（这是 RenderObject 的扩展点） |
| 默认行为 | 写配置 + 挂子节点 | 直接调 `updateWith` |

`SemanticsNode.updateWith` 收到的子节点顺序是**反绘制序**（`childrenInInversePaintOrder`），而 `visitChildren` 遍历出来的是**正绘制序**。节点的 `_childrenIdInTraversalOrder` / 命中测试顺序（`semantics.dart:4016`、`:4063-4071`）都在这个转换上做文章——文档在 `updateWith` 的参数说明里写得很清楚，需要时按参数名读。

## 六、源码实验

### 实验 1：`container: true` 与 `MergeSemantics` 的树形差别

**改什么**：分别用两种写法渲染同一个 `Semantics(label: 'outer')`，申请 `SemanticsHandle` 后遍历打印每个节点的 `id` / `mergeAllDescendantsIntoThisNode` / `isPartOfNodeMerging` / `label`。

**预测**：两种写法应该产出同样的树，因为属性完全一样。

**实际输出**：

```text
boundary #0 merges=false isPartOfNodeMerging=false label=""
boundary   #1 merges=false isPartOfNodeMerging=false label=""
boundary     #2 merges=false isPartOfNodeMerging=false label=""
boundary       #3 merges=false isPartOfNodeMerging=false label=""
boundary         #4 merges=false isPartOfNodeMerging=false label="outer"

merge    #0 merges=false isPartOfNodeMerging=false label=""
merge      #1 merges=false isPartOfNodeMerging=false label=""
merge        #2 merges=false isPartOfNodeMerging=false label=""
merge          #3 merges=false isPartOfNodeMerging=false label=""
merge            #5 merges=true isPartOfNodeMerging=true label="outer"
```

**说明**：树的**层数相同**（都是 4 层 + 根），但两个关键位不同：
- `container: true` 产出的 `#4` 是普通节点：`merges=false`；
- `MergeSemantics` 产出的 `#5` 是合并节点：`merges=true` 且 `isPartOfNodeMerging=true`。

注意节点 id 从 `#4` 跳到了 `#5`——**节点的 id 是单调分配的**（`SemanticsNode._generateNewId`），它不随树结构变化而回收。所以在实际项目里看到 id 不连续是正常的，不能用 id 推断位置。

`isPartOfNodeMerging`（`semantics.dart:2950`）的定义是 `mergeAllDescendantsIntoThisNode || isMergedIntoParent`，它回答的是"这个节点是否参与了合并"——`merges=true` 的那个节点既是合并点、又是被合并者。

### 实验 2：非边界时配置合并进祖先节点

**改什么**：`GestureDetector(onTap: ...)` 包一个 `Text('tap me')`，然后用 `RenderObject.debugSemantics` 和叶节点数据观察。

**预测**：`GestureDetector` 应该产生自己的语义节点，因为它的 `RenderSemanticsGestureHandler` 看起来"很特别"。

**实际输出**：

```text
GestureDetector RO: RenderSemanticsGestureHandler
  child: RenderPointerListener debugSemantics=null
LEAF #4 label="tap me" actions=1 merges=false
```

**说明**：`GestureDetector` 的 `RenderSemanticsGestureHandler` **不是**语义边界（`debugSemantics` 为 null 说明它没有自己的 `SemanticsNode`），它贡献的 `onTap` 被**合并进了 `Text` 的那个叶节点**——所以 `LEAF #4` 同时带着 `label="tap me"`（来自 `Text`）和 `actions=1`（来自 `GestureDetector` 的 tap）。

这就是"无障碍检查里一个文本节点既是文本又是按钮"的原因。`debugSemantics`（`rendering/object.dart:3881-3888`）只在 debug/profile 模式有效，且只有当 `_semantics.built` 为 true 时才返回节点——**返回 null 只说明"这个 RenderObject 没有自己的节点"，不代表"它没有语义"**。

### 实验 3：`MergeSemantics` 会把后代的数据和动作一起吸上来

**改什么**：`MergeSemantics(child: GestureDetector(onTap: ..., child: Semantics(label: 'probe-label', button: true, container: true, child: ...)))`，然后 dump 整棵树。

**实际输出**（节选）：

```text
#4 rect=40.0 merges=true  label="probe-label" actions=1 isButton=true
  #5 rect=40.0 merges=false label="probe-label" actions=0 isButton=true
```

**说明**：`#4` 是 `MergeSemantics` 产生的合并节点，它同时拿到了：
- `label="probe-label"`（从 `#5` 吸上来的）
- `actions=1`（tap，从 `GestureDetector` 吸上来的）
- `isButton=true`（从 `#5` 吸上来的）

而 `#5`（`container: true` 产生的显式节点）依然存在，只是 `actions=0`。

**重要区别**：`mergeAllDescendantsIntoThisNode` **不等于"把子节点删掉"**。它的语义是"从父节点出发就能读到后代的数据"（`semantics.dart:2914` 附近的文档），子节点仍然在树里。要在无障碍工具里看到"一个可点击的按钮"，靠的正是合并点上的这份数据。

### 实验 4：不申请 `SemanticsHandle` 时什么都没有

**改什么**：把实验 1 的 `SemanticsBinding.instance.ensureSemantics()` 去掉，再取 `rootSemanticsNode`。

**预测**：树结构应该照旧，只是不往引擎发送。

**源码依据**：`SemanticsBinding.semanticsEnabled`（`semantics/binding.dart:64-67`）为 false 时，`PipelineOwner._updateSemanticsOwner`（`rendering/object.dart:1396-1409`）不会创建 `SemanticsOwner`，`semanticsOwner` 保持为 null，因此拿不到 `rootSemanticsNode`。（这一条是本文唯一没有运行验证的实验，结论来自源码。）

**说明**：这与 `RenderObject.markNeedsSemanticsUpdate` 的第一个 `return` 条件呼应（`rendering/object.dart:3912-3914`：`owner!._semanticsOwner == null` 就直接返回）。**语义是"按需收集"的：默认全部工作量为零。** 所以性能剖析时如果要评估语义开销，必须先 `ensureSemantics`，否则测不到任何东西。

这条也和"无障碍测试要在 `testWidgets` 里显式 `tester.ensureSemantics()`"的实践对得上：生产环境同样使用这个开关，测试环境并不特殊。

### 实验 5：确认 `SemanticsNode` 的产出者是 RenderObject，不是 widget

**改什么**：分别 grep "`SemanticsNode(` 的构造点"和"`describeSemanticsConfiguration` 的覆写点"。

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src
grep -rn "SemanticsNode(" rendering/*.dart | head -6
grep -rn "describeSemanticsConfiguration" widgets/basic.dart rendering/proxy_box.dart | head
grep -rn "^class Semantics extends" widgets/*.dart
ls widgets/semantics.dart
```

**实际输出**（节选）：

```text
rendering/custom_paint.dart:904:  final SemanticsNode newChild = oldChild ?? SemanticsNode(key: newSemantics.key);
rendering/object.dart:3946:  void assembleSemanticsNode(
rendering/object.dart:6167:  void ensureSemanticsNode() {
widgets/basic.dart:7945:class Semantics extends _SemanticsBase {
rendering/proxy_box.dart:4360:  void describeSemanticsConfiguration(SemanticsConfiguration config) {
ls: widgets/semantics.dart: No such file or directory
```

**说明**：三点被证实：
1. `SemanticsNode` 的构造只在渲染层发生，而且 `rendering/custom_paint.dart:904` 正是"某个 `assembleSemanticsNode` 覆写自己 new 节点"的真实例子（`CustomPaint` 的语义子节点）；
2. `Semantics` widget 在 `widgets/basic.dart`，不在 `widgets/semantics.dart`（**后者不存在**）；
3. `widgets/` 目录下没有任何 `describeSemanticsConfiguration` 的覆写——**配置的生产全部发生在渲染层**。

这就是本文一开始那个错误直觉的反证：**语义树是渲染树的投影，跟 widget 树并没有直接对应**。同一个 `Semantics` widget 是否产生节点，取决于它落在哪个 RenderObject 上、以及那段配置的 `isSemanticBoundary`。

## 七、结论

1. 语义的产出路径是单向的：**`SemanticsProperties`（widget 侧声明）→ `SemanticsConfiguration`（一次性的可变待办清单）→ `SemanticsNode`（树节点）**。`RenderObject.describeSemanticsConfiguration`（`rendering/object.dart:3835`）是唯一的生产点，且配置是**参数**，RenderObject 不持有它。
2. **`isSemanticBoundary` 决定树的形状**（`rendering/object.dart:6255-6259`）：为 true 时走 `assembleSemanticsNode`，这个 RenderObject 拥有自己的节点；为 false 时直接 `updateWith`，配置合并进最近的祖先节点。`isMergingSemanticsOfDescendants` 为 true 会**强制** `isSemanticBoundary` 也为 true（setter 断言），这是 `MergeSemantics` 的实现基础。
3. `markNeedsSemanticsUpdate` 的脏传播**只往上传到最近的有效语义边界**（`rendering/object.dart:6423` 起），重建在 `PipelineOwner.flushSemantics`（`:1451`）里按 `depth` 升序进行，且发生在 paint / composite **之后**（`rendering/binding.dart:650`）。语义默认不收集，靠 `SemanticsBinding.ensureSemantics()` 的句柄计数打开。

**语义树是渲染树的投影——RenderObject 现场填一份配置，配置里的 `isSemanticBoundary` 决定它变成自己的节点还是并进父节点。**

## 八、边界声明

- 本文只覆盖"配置如何从 `RenderObject` 产出并组成节点树"。无障碍的完整 API（`SemanticsAction` 全表、`SemanticsFlag`/`SemanticsFlags`、`SemanticsEvent`、`SemanticsService`、焦点与遍历顺序、`SemanticsTag`、`childConfigurationsDelegate`）不在这个系列展开。
- `SemanticsConfiguration.absorb`（`semantics.dart:6746`）与 `childConfigurationsDelegate`（`:5730`）这两条"高级合并"路径只标出位置，不展开——它们服务于 `Sliver`/`ListView` 这类"把子项合并成一个节点"的场景，实现集中在 `_RenderObjectSemantics._collectChildMergeUpAndSiblingGroup`（`rendering/object.dart:5952`）。
- `SemanticsData` 的位域打包、`_childrenIdInTraversalOrder`（`semantics.dart:4016`）与引擎通信的 `SemanticsUpdateBuilder` 序列化不展开。
- `SemanticsBinding.performSemanticsAction`（`semantics/binding.dart:189`）到 `RendererBinding` 的实现、以及平台侧的无障碍服务（TalkBack / VoiceOver）不在这个系列范围内。
- `RenderObject` 的 `adoptChild` / `dropChild` 会调用 `markNeedsSemanticsUpdate`（`rendering/object.dart:2178`、`2207`），这属于树骨架的脏传播，已在第三篇 4.2 给出，本文只使用这个结论。
