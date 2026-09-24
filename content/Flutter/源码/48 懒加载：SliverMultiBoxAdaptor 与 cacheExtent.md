# 48 懒加载：SliverMultiBoxAdaptor 与 cacheExtent

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/sliver_multi_box_adaptor.dart`（807 行）、`rendering/sliver_list.dart`（341 行）、`widgets/sliver.dart`（2699 行）、`widgets/scroll_delegate.dart`（809 行）、`widgets/automatic_keep_alive.dart`

## 一、问题

`ListView.builder` 的"懒加载"通常被描述成两件事：**延迟创建**（用到才建）和**滚出即销毁**（看不见就回收）。

第一句只对了一半。真正发生的是：**只创建落在 cache extent 内的 child，落在区间外的立刻被移出 child 列表**。这不是"延迟"，是"按区间裁剪"——创建与否由一个**数值区间**决定，跟"是否可见"无关。

第二句错得更明显。真实行为分两支，取决于 child 自己的 `keepAlive` 标志：

```dart
// sliver_multi_box_adaptor.dart:373-387
void _destroyOrCacheChild(RenderBox child) {
  final childParentData = child.parentData! as SliverMultiBoxAdaptorParentData;
  if (childParentData.keepAlive) {
    assert(!childParentData._keptAlive);
    remove(child);
    _keepAliveBucket[childParentData.index!] = child;   // 进桶，不销毁
    child.parentData = childParentData;
    super.adoptChild(child);
    childParentData._keptAlive = true;
  } else {
    assert(child.parent == this);
    _childManager.removeChild(child);                   // 真正移除
    assert(child.parent == null);
  }
}
```

**关键认知**：这个方法的私有名字比公开文档更诚实——它叫 `_destroyOr**Cache**Child`，不是 `_destroyChild`。滚动只是"把 child 从渲染列表里挪走"，进桶还是销毁由 `keepAlive` 决定。**所以"滚出去会不会丢状态"的答案不是"会"，而是"看你的 child 有没有申请 keepAlive"**。

## 二、最小 Demo

### 2.1 数一数到底建了几个

```dart
import 'package:flutter/material.dart';

class BuildCounter extends StatefulWidget {
  const BuildCounter({super.key});

  @override
  State<BuildCounter> createState() => _BuildCounterState();
}

class _BuildCounterState extends State<BuildCounter> {
  int built = 0;
  double cache = 250;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Text('builder 调用次数 = $built, cacheExtent = $cache'),
        // 1. 三档 cacheExtent 切换，观察 built 的变化
        SegmentedButton<double>(
          segments: const <ButtonSegment<double>>[
            ButtonSegment<double>(value: 0, label: Text('0')),
            ButtonSegment<double>(value: 250, label: Text('250(默认)')),
            ButtonSegment<double>(value: 1000, label: Text('1000')),
          ],
          selected: <double>{cache},
          onSelectionChanged: (Set<double> v) => setState(() => cache = v.first),
        ),
        Expanded(
          child: ListView.builder(
            // 2. 3.44 起的写法：一个 ScrollCacheExtent 取代旧的 cacheExtent + cacheExtentStyle
            scrollCacheExtent: ScrollCacheExtent.pixels(cache),
            itemExtent: 100,
            itemCount: 1000,
            itemBuilder: (BuildContext context, int index) {
              built += 1;      // 3. 只统计累计调用次数：含复用 index 的重建，不含 keepAlive 桶里复活的 child（见下）
              return SizedBox(height: 100, child: Text('$index'));
            },
          ),
        ),
      ],
    );
  }
}
```

在 600 高的视口里点三档，会看到 `built` 从 6 → 9 → 16（第六节有实测输出）。**"建几个"这件事完全是算术：`(视口长度 + cacheExtent) / itemExtent` 向上取整。** 但要记住这个计数器统计的是 **builder 回调累计被调的次数**，不等于"当前存活的 child 数"——本实验没滚动、区间只单调扩大，每次新增调用恰好都对应一个新建的 child，数字才刚好相等；一旦滚动往返，同一个 index 的重建也会再调 builder（`createChild` 对已存在的 index 同样先 `_build` 再 `updateChild`，`widgets/sliver.dart:1072`），而 keepAlive 桶里复活的孩子又不调 builder（`_createOrObtainChild` 桶命中分支不走 `childManager`，`sliver_multi_box_adaptor.dart:359`）。想观测真实存活数，用第六节实验 2（遍历渲染 child）或实验 3（统计 init/dispose）的办法。

### 2.2 申请 keepAlive，让滚出去的状态活下来

```dart
/// Widget 本体——State 的泛型参数必须和它配对
class KeepAliveItem extends StatefulWidget {
  const KeepAliveItem({super.key});

  @override
  State<KeepAliveItem> createState() => _KeepAliveItemState();
}

/// mixin 的泛型要显式写成 AutomaticKeepAliveClientMixin<KeepAliveItem>，
/// 与 State<KeepAliveItem> 的类型参数一致
class _KeepAliveItemState extends State<KeepAliveItem>
    with AutomaticKeepAliveClientMixin<KeepAliveItem> {
  bool _keep = true;

  @override
  void dispose() {
    debugPrint('被销毁了');    // keepAlive 生效期间这一行不会打印
    super.dispose();
  }

  @override
  bool get wantKeepAlive => _keep;   // 1. 声明"别回收我"

  void _toggle() {
    setState(() => _keep = !_keep);
    updateKeepAlive();               // 2. wantKeepAlive 的值变了，必须手动通知（释放路径见 4.5）
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);            // 3. AutomaticKeepAliveClientMixin 要求先调 super.build
    return GestureDetector(
      onTap: _toggle,
      child: Text(_keep ? '滚出去也保留状态（点击放弃）' : '已放弃 keepAlive（点击恢复）'),
    );
  }
}
```

第 3 步的 `super.build(context)` 是 `AutomaticKeepAliveClientMixin` 的硬要求——它在那里根据 `wantKeepAlive` 决定要不要发 `KeepAliveNotification`。漏了这一行，`wantKeepAlive` 完全不起作用，而且是**静默失效**。第 2 步的 `updateKeepAlive()` 则是 `wantKeepAlive` **会变化**时的必需品：mixin 的 `initState` 只在挂载时读一次初值，`build` 里的检查（`wantKeepAlive && _keepAliveHandle == null`，`automatic_keep_alive.dart:476-478`）也只会补"从无到有"的注册、**不会做释放**，所以 true → false 的退订只能靠 State 自己喊一声（源码注释原话："Call [updateKeepAlive] whenever this getter's value changes"）。

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets/sliver.dart:56` | `abstract class SliverMultiBoxAdaptorWidget`，多 box 子节点的 sliver widget 基类 |
| `widgets/sliver.dart:167` | `class SliverList extends SliverMultiBoxAdaptorWidget` |
| `widgets/sliver.dart:923` | `SliverMultiBoxAdaptorElement implements RenderSliverBoxChildManager` |
| `widgets/sliver.dart:959` | `final SplayTreeMap<int, Element?> _childElements`，**child 的真实仓库** |
| `widgets/sliver.dart:1059` | `void createChild(int index, {required RenderBox? after})` |
| `widgets/sliver.dart:1105` | `void removeChild(RenderBox child)` |
| `widgets/sliver.dart:1172` | `int get childCount` |
| `widgets/sliver.dart:963` | `void performRebuild()`，delegate 变更时的整体重建 |
| `widgets/scroll_delegate.dart:135` | `abstract class SliverChildDelegate` |
| `widgets/scroll_delegate.dart:153` | `Widget? build(BuildContext context, int index);`，**delegate 唯一必须实现的** |
| `widgets/scroll_delegate.dart:352` | `class SliverChildBuilderDelegate extends SliverChildDelegate` |
| `widgets/scroll_delegate.dart:546` | `SliverChildBuilderDelegate.build`，三层包装就在这里 |
| `widgets/scroll_delegate.dart:633` | `class SliverChildListDelegate`，一次性传入全部 children 的版本 |
| `rendering/sliver_multi_box_adaptor.dart:25` | `abstract class RenderSliverBoxChildManager`，渲染层向 element 层要 child 的接口 |
| `rendering/sliver_multi_box_adaptor.dart:201` | `abstract class RenderSliverMultiBoxAdaptor` |
| `rendering/sliver_multi_box_adaptor.dart:233` | `final Map<int, RenderBox> _keepAliveBucket` |
| `rendering/sliver_multi_box_adaptor.dart:356` | `void _createOrObtainChild(int index, {required RenderBox? after})` |
| `rendering/sliver_multi_box_adaptor.dart:373` | `void _destroyOrCacheChild(RenderBox child)` |
| `rendering/sliver_multi_box_adaptor.dart:452` | `bool addInitialChild({int index = 0, double layoutOffset = 0.0})` |
| `rendering/sliver_multi_box_adaptor.dart:586` | `void collectGarbage(int leadingGarbage, int trailingGarbage)` |
| `rendering/sliver_list.dart:40` | `class RenderSliverList extends RenderSliverMultiBoxAdaptor` |
| `rendering/sliver_list.dart:46` | `RenderSliverList.performLayout`，懒加载的主循环 |
| `widgets/automatic_keep_alive.dart:71` | `class AutomaticKeepAlive extends StatefulWidget` |
| `widgets/automatic_keep_alive.dart:446` | `AutomaticKeepAliveClientMixin.updateKeepAlive` |
| `widgets/sliver.dart:1577` | `class KeepAlive extends ParentDataWidget<KeepAliveParentDataMixin>` |

## 四、调用链

### 4.1 widget 侧：一个 child 被包了四层

`SliverChildBuilderDelegate.build` 是"用户 builder"和"真正挂进树的 widget"之间唯一的加工点：

```dart
// scroll_delegate.dart:546-574（节选）
Widget? build(BuildContext context, int index) {
  if (index < 0 || (childCount != null && index >= childCount!)) {
    return null;                       // 越界直接返回 null，这是"列表结束"的信号
  }
  Widget? child = builder(context, index);
  if (child == null) { return null; }
  final Key? key = child.key != null ? _SaltedValueKey(child.key!) : null;
  if (addRepaintBoundaries) {
    child = RepaintBoundary(child: child);      // 1. 每个 item 独立图层
  }
  if (addAutomaticKeepAlives) {
    child = AutomaticKeepAlive(child: _SelectionKeepAlive(child: child));  // 2. keepAlive
  }
  return KeyedSubtree(key: key, child: child);  // 3. 最外层是 KeyedSubtree
}
```

四个细节都值得记：

1. **`return null` 有两个来源**：索引越界，或用户 `builder` 自己返回 null。两者都被当作"没有下一个 child"（`RenderSliverList.performLayout` 用它判断 `reachedEnd`）。
2. **`_SaltedValueKey` 会给用户 key 加盐**（`:553`）。原因是同一个 key 可能同时出现在多个 `SliverList` 里，加盐避免跨 sliver 的 key 冲突。
3. **`_SelectionKeepAlive`（`:799`）是 3.44 里比 `AutomaticKeepAlive` 更内层的一层**，负责选中态（文本选择）跨滚动保留。老资料里只有 `AutomaticKeepAlive` 一层，这是本地源码与常见描述不一致的一处。
4. **三层包都是可关的**：`addAutomaticKeepAlives` / `addRepaintBoundaries` / `addSemanticIndexes` 的默认值都是 true（`:368-370`）。关掉 `addRepaintBoundaries` 能省一层 RenderObject，代价是滚动时整屏重绘。

**关键认知**：`addAutomaticKeepAlives: false` 会让 `KeepAliveItem` 那种写法**完全失效**，而不是"稍微差一点"。因为 keepAlive 的整个通路（`KeepAliveNotification` → `AutomaticKeepAlive._addClient` → `KeepAlive` parentData → `SliverMultiBoxAdaptorParentData.keepAlive`）是从这一层包上去的。

### 4.2 element 侧：`SliverMultiBoxAdaptorElement` 是 child 的仓库

渲染对象不直接创建 widget，它通过 `childManager`（就是 element）要：

```dart
// rendering/sliver_multi_box_adaptor.dart:25-40（节选）
abstract class RenderSliverBoxChildManager {
  void createChild(int index, {required RenderBox? after});
  void removeChild(RenderBox child);
  int get childCount;                       // 已知总数；未知时为 0 或估计值
  double estimateMaxScrollOffset(...);      // 不知道总长时给个估计
  void didAdoptChild(RenderBox child);
  void setDidUnderflow(bool value);
}
```

element 这一侧的存储很简单：

```dart
// widgets/sliver.dart:959
final SplayTreeMap<int, Element?> _childElements = SplayTreeMap<int, Element?>();
```

用 `SplayTreeMap` 而不是 `Map` 是因为要**按 index 顺序遍历**（`performRebuild` 里 `newChildren` 也是 `SplayTreeMap`）。创建和移除都必须包在 `buildScope` 里：

```dart
// widgets/sliver.dart:1059-1080（节选）
void createChild(int index, {required RenderBox? after}) {
  assert(_currentlyUpdatingChildIndex == null);
  owner!.buildScope(this, () {                 // 1. 必须开一个新的 buildScope
    final insertFirst = after == null;
    _currentBeforeChild = insertFirst ? null
        : (_childElements[index - 1]!.renderObject as RenderBox?);
    _currentlyUpdatingChildIndex = index;
    newChild = updateChild(_childElements[index], _build(index, adaptorWidget), index);
    ...
  });
}
```

这里有两个约束：

- **`buildScope` 不能省**。`createChild` 是在 layout 期间被调用的，而 layout 期间不允许随意 build。`buildScope` 是"我现在要在布局中插入一次构建"的正式声明（第 50 篇会展开 `BuildOwner.buildScope` 与 `debugBuildingDirtyElements`）。
- **`_currentlyUpdatingChildIndex` 是给断言用的**。`_debugAssertChildListLocked` 之类的检查靠它发现"在一次 create 的过程中又发生了 create"。

`removeChild` 是它的镜像，同样要 `buildScope`：

```dart
// widgets/sliver.dart:1105-1122（节选）
void removeChild(RenderBox child) {
  final int index = renderObject.indexOf(child);
  owner!.buildScope(this, () {
    _currentlyUpdatingChildIndex = index;
    final Element? result = updateChild(_childElements[index], null, index);
    assert(result == null);              // 传 null widget → 一定卸载
    _childElements.remove(index);
  });
}
```

**关键认知**：`updateChild(existing, null, slot)` 是"卸载"的标准写法——不是 `unmount`，而是走 element 的正常更新流程（可能先 `deactivate` 再等本帧结束才 `unmount`）。所以"滚动时被回收的 child 的 `dispose` 时机"是**本帧末尾**，不是立即。

### 4.3 渲染侧：主循环只看一个区间

`RenderSliverList.performLayout` 是懒加载的核心，长度 290 行，但骨架只有四条：

```dart
// sliver_list.dart:46-56（节选）
void performLayout() {
  final SliverConstraints constraints = this.constraints;
  childManager.didStartLayout();
  childManager.setDidUnderflow(false);

  // 1. 要建的目标区间 = 缓存区起点 .. 缓存区起点 + 缓存区长度
  final double scrollOffset = constraints.scrollOffset + constraints.cacheOrigin;
  final double remainingExtent = constraints.remainingCacheExtent;
  final double targetEndScrollOffset = scrollOffset + remainingExtent;
  final BoxConstraints childConstraints = constraints.asBoxConstraints();
```

注意它用的是 `remainingCacheExtent` 而**不是** `remainingPaintExtent`。这就是"建 9 个而不是 6 个"的原因——builder 的调用范围由缓存区决定。

接下来三个循环，各自解决一件事：

```dart
// sliver_list.dart:271-300（节选）
// sliver_list.dart:272-294（节选）
// 2. 找第一个"结束位置在 scrollOffset 之后"的 child，之前的都算前部垃圾
while (endScrollOffset < scrollOffset) {
  leadingGarbage += 1;
  if (!advance()) { ... collectGarbage(leadingGarbage - 1, 0); ... }
}
// 3. 一直往后建，直到跨过 targetEndScrollOffset
while (endScrollOffset < targetEndScrollOffset) {
  if (!advance()) { reachedEnd = true; break; }
}
// 4. 剩下的都算尾部垃圾
if (child != null) {
  child = childAfter(child!);
  while (child != null) { trailingGarbage += 1; child = childAfter(child!); }
}
```

`advance()` 是内嵌函数（`sliver_list.dart:223`），它在 `child == null` 或索引不连续时调 `insertAndLayoutChild`（`sliver_multi_box_adaptor.dart:509`），否则对已有 child 调 `layout`。**"创建新 child"和"重新布局已有 child"在同一个函数里，靠 `indexOf(child) != index` 区分**。

最后上报 geometry：

```dart
// sliver_list.dart:326-335
geometry = SliverGeometry(
  scrollExtent: estimatedMaxScrollOffset,
  paintExtent: paintExtent,
  cacheExtent: cacheExtent,
  maxPaintExtent: estimatedMaxScrollOffset,
  hasVisualOverflow: endScrollOffset > targetEndScrollOffsetForPaint || constraints.scrollOffset > 0.0,
);
```

`paintExtent` 与 `cacheExtent` 分别由 `calculatePaintOffset` / `calculateCacheOffset`（`rendering/sliver.dart:1573` / `:1597`）从"已建出的区间"换算——**已经把可见区和缓存区区分开了**，viewport 拿到的两个数字不一样。

### 4.4 `_createOrObtainChild`：先查桶，再建新

```dart
// sliver_multi_box_adaptor.dart:356-371
void _createOrObtainChild(int index, {required RenderBox? after}) {
  invokeLayoutCallback<SliverConstraints>((SliverConstraints constraints) {
    if (_keepAliveBucket.containsKey(index)) {
      final RenderBox child = _keepAliveBucket.remove(index)!;   // 1. 桶里有，复活
      final childParentData = child.parentData! as SliverMultiBoxAdaptorParentData;
      dropChild(child);
      child.parentData = childParentData;
      insert(child, after: after);              // 2. 插回渲染列表
      childParentData._keptAlive = false;
    } else {
      _childManager.createChild(index, after: after);             // 3. 桶里没有，新建
    }
  });
}
```

这一共 14 行，就是"keepAlive 复活"与"真正新建"的分叉点。注意它必须包在 `invokeLayoutCallback` 里——因为 `insert` / `dropChild` 会改渲染树，而这个方法是在布局过程中被调用的，框架用 `invokeLayoutCallback` 做"这是合法的布局期树改动"的登记。

**别把 `_keepAliveBucket` 和"列表回收"混为一谈**：桶里的 child **仍然是这个 RenderObject 的孩子**（看 `_destroyOrCacheChild` 里 `super.adoptChild(child)`），只是不在顺序列表里。所以 `visitChildren` 看不到它（源码注释明说 "Do not visit children in [_keepAliveBucket]"），但 `attach` / `detach` / `redepthChild` 都会带上它（`:392-408`）。

### 4.5 `collectGarbage`：两种垃圾，两件事

```dart
// sliver_multi_box_adaptor.dart:586-620（节选）
// sliver_multi_box_adaptor.dart:587-612（节选）
void collectGarbage(int leadingGarbage, int trailingGarbage) {
  invokeLayoutCallback<SliverConstraints>((SliverConstraints constraints) {
    while (leadingGarbage > 0) {
      _destroyOrCacheChild(firstChild!);      // 1. 头部垃圾
      leadingGarbage -= 1;
    }
    while (trailingGarbage > 0) {
      _destroyOrCacheChild(lastChild!);       // 2. 尾部垃圾
      trailingGarbage -= 1;
    }
    // 3. 桶里"已经不再申请 keepAlive"的也清掉
    _keepAliveBucket.values.where((RenderBox child) =>
        !(child.parentData! as SliverMultiBoxAdaptorParentData).keepAlive)
      .toList().forEach(_childManager.removeChild);
  });
}
```

第 3 步是桶的清理规则，也是 keepAlive 的**释放路径**：`wantKeepAlive` 变 false → `AutomaticKeepAliveClientMixin.updateKeepAlive` 释放 `KeepAliveHandle` → `AutomaticKeepAlive` 把 `KeepAlive` 的 parentData 改成 false → `SliverMultiBoxAdaptorParentData.keepAlive` 变 false → 下一次 `collectGarbage` 时从桶里移除。**"取消 keepAlive"不是立即销毁，而是"下一次布局时才销毁"。**

### 4.6 不知道总长怎么办：`estimateMaxScrollOffset`

`SliverList` 不知道第 3000 个 item 有多高。它的处理方式写在一个静态方法里：

```dart
// widgets/sliver.dart:1124-1139（节选）
static double _extrapolateMaxScrollOffset(
  int firstIndex, int lastIndex, double leadingScrollOffset,
  double trailingScrollOffset, int childCount,
) {
  if (lastIndex == childCount - 1) {
    return trailingScrollOffset;                       // 已到末尾，不用估
  }
  final int reifiedCount = lastIndex - firstIndex + 1;  // 已建出的个数
  final double averageExtent = (trailingScrollOffset - leadingScrollOffset) / reifiedCount;
  final int remainingCount = childCount - lastIndex - 1;
  return trailingScrollOffset + averageExtent * remainingCount;   // 均值外推
}
```

**关键认知**：这就是"`ListView.builder` 的滚动条长度会跳"的根因——总长是用**已建出的几个 item 的平均高度**外推的，每建一个新 item，估计值就变一次。所以源码注释里反复强调 "Providing a non-null itemCount improves the ability to estimate the maximum scroll extent"，而 `itemExtent` 更是直接把 `RenderSliverFixedExtentList` 换成 O(1) 公式。

## 五、核心对象

### 5.1 三个 extent 在懒加载里的分工

| | 决定什么 | 源码依据 |
|---|---|---|
| `constraints.remainingPaintExtent` | 最终 `paintExtent`（画多少） | `sliver_list.dart:322-335` |
| `constraints.remainingCacheExtent` + `cacheOrigin` | **建几个 child**（`targetEndScrollOffset`） | `sliver_list.dart:51-55` |
| `geometry.cacheExtent` | 报给下一个 sliver 的 `remainingCacheExtent` | `sliver_list.dart:320`、`viewport.dart:872` |

### 5.2 回收 vs keepAlive

| | 普通 child | 申请了 keepAlive 的 child |
|---|---|---|
| 移出区间时 | `_childManager.removeChild` → element 卸载 | `remove(child)` + 进 `_keepAliveBucket` |
| 还是这个 RenderObject 的孩子吗 | 否 | **是**（`super.adoptChild(child)`） |
| `visitChildren` 能看到吗 | 不适用 | **看不到** |
| `attach` / `detach` / `redepthChild` 会带上吗 | — | 会 |
| State 会被 dispose 吗 | 会（本帧末） | **不会** |
| 何时真正销毁 | 移出后本帧末 | `keepAlive` 变 false 后的下一次 `collectGarbage` |
| 复活路径 | 重新 `createChild` | `_createOrObtainChild` 从桶里取出（`sliver_multi_box_adaptor.dart:359`） |

### 5.3 `SliverList` vs `SliverList.builder` vs `SliverChildListDelegate`

| | `SliverList(delegate:)` | `SliverList.builder(itemBuilder:)` | `SliverList.list(children:)` |
|---|---|---|---|
| delegate | 任意 `SliverChildDelegate` | `SliverChildBuilderDelegate` | `SliverChildListDelegate` |
| `childCount` | 由 delegate 决定 | `itemCount`（可为 null = 无限） | `children.length` |
| 总长估计 | 由 delegate 的 `estimateMaxScrollOffset` 决定 | 均值外推 | 精确（列表已知） |
| 是否真懒 | 是 | 是 | `build` 只是从列表里取，但**列表本身已全部创建** |
| 何时用 | 自定义 delegate | 大量/无限 item | 少量固定 item |

`SliverChildListDelegate` 的文档说得很直接："In general building all the widgets in advance is not efficient."（`scroll_delegate.dart:589-593`）

## 六、源码实验

### 实验 1：cacheExtent 直接决定 builder 被调用几次

视口 600、`itemExtent: 100`、`itemCount: 1000`，切换 `scrollCacheExtent`：

```text
LAB13 cache=0    built=6
LAB13 cache=250  built=9
LAB13 cache=1000 built=16
```

**预测**：`cacheExtent` 会影响旁边的 item，但没想到是精确的算术关系。

**实际**：完全等于 `(视口长度 + cacheExtent) / itemExtent` 向上取整——`600/100 = 6`、`850/100 = 8.5 → 9`、`1600/100 = 16`。

**说明**：这组数字是"懒加载是一个数值区间裁剪"最直接的证据。第二档（默认 250）落在 8.5，所以是 9 个——**多出来的那半个 item 就是"缓存区"的作用**。另外注意口径：`built` 计数在这里能当"存活数"读，前提是**从头到尾没滚动**、区间只扩不缩——新增的每次 builder 调用都恰好对应一个新 child。一般情形下它是累计调用数：child 被回收后重建会再 +1（`createChild` 对已存在的 index 也会先 `_build`），keepAlive 桶里复活的不 +1，所以不能直接当存活数。观测存活数的正确姿势是实验 2 的遍历渲染 child（`firstChild` / `childAfter`）或实验 3 的 `init 数 − dispose 数`。

`cache=250` 时为什么是 850 而不是 1100（600 + 250 + 250）？因为 `cacheOrigin` 在列表顶部被压成 0（第 45 篇实验 4、第 47 篇第五节都验证过）。**只有向后（未滚过的方向）的缓存区在顶部生效。**

### 实验 2：滚起来之后建的区间

`cacheExtent = 0`，先布局再 `jumpTo(2000)`：

```text
LAB13b viewport(0.0): indices 20..25 count=6
```

**说明**：偏移量 2000、itemExtent 100，所以第一个可见 item 是 20；`2000/100 = 20`，视口高 600 → 20..25 共 6 个。**滚过的 item 全部被回收，新建的只有区间内的 6 个**——`_destroyOrCacheChild` 与 `_createOrObtainChild` 在这一步各跑了一遍。

### 实验 3：keepAlive 让一个 item 跨越 50 屏活下来

让 index 0 的 item `wantKeepAlive => true`，其余不申请：

```text
LAB14 t0                  init=9  dispose=0  item0.present=1
LAB14 after jump 5000     item0.present=1      dispose=8
LAB14 back to 0           init=29 dispose=20   item0.present=1
```

**预测**：跳到 5000 之后，index 0 应该被销毁（`dispose` 应该 +9）。

**实际**：`dispose` 只有 **8**——9 个 child 里有 8 个被销毁，**index 0 活着**，而且 `item0.present=1`（`skipOffstage: false` 时才找得到，因为它已在 `_keepAliveBucket` 里、不在渲染子列表中）。

**说明**：三个数字把 5.2 节的表逐个坐实了。回到 0 之后 `init=29`——多出来的 init 都是滚动过程中新建的；而 `item0` 从头到尾只 init 过一次。

**代价与收益**：代价是桶里的 child 仍然占内存、仍然会被 `attach`/`detach`/`redepthChild` 遍历、`keepAlive` 期间它的 `layout` 不会再跑（`RenderSliverMultiBoxAdaptor` 不 layout 桶里的孩子），所以你要为"复活"付出一次重新布局。收益是 State、ScrollController、动画进度、文本选择全都保留。

### 实验 4：确认包装层的顺序

把一个 `ListView.builder` 的 element 树从 `SliverList` 往下打印：

```text
0:SliverList | 1:KeyedSubtree | 2:AutomaticKeepAlive | 3:KeepAlive |
4:NotificationListener<KeepAliveNotification> | 5:_SelectionKeepAlive | 6:IndexedSemantics | ...
```

**说明**：与 4.1 节的源码完全对上，但**顺序是反的**（源码里 `RepaintBoundary` 先包、`KeyedSubtree` 最后包，所以树里 `KeyedSubtree` 最外层）。另外这一行确认了 3.44 里存在 `_SelectionKeepAlive`（`scroll_delegate.dart:799`）——它是 `AutomaticKeepAlive` 的孩子，也就是说**一个 item 上实际有两层 keepAlive 相关的 widget**。老资料里只有 `AutomaticKeepAlive` 和 `KeepAlive` 两层，这是版本差异。

## 七、结论

1. 懒加载不是"延迟创建 + 销毁"，而是**按数值区间裁剪**：`targetEndScrollOffset = constraints.scrollOffset + constraints.cacheOrigin + constraints.remainingCacheExtent`（`sliver_list.dart:51-55`）以内的 child 存在，以外的移出。区间由 `cacheExtent` 决定，与"是否可见"无关——实测 600 高的视口 + 默认 cacheExtent 会建出 9 个 item。
2. 移出区间的 child 分两支：`keepAlive == false` 走 `_childManager.removeChild`（element 卸载，State 在本帧末 dispose）；`keepAlive == true` 进 `_keepAliveBucket`，**仍然是同一个 RenderObject 的孩子**，只是不被 `visitChildren` 遍历、不参与 layout，下次滚回来时被 `_createOrObtainChild` 直接取出复活（`sliver_multi_box_adaptor.dart:359`）。
3. 不知道总长时，滚动总长由"已建出的 item 的平均高度"外推（`widgets/sliver.dart:1123-1139`）。`itemExtent` 或 `SliverFixedExtentList` 能把这个估计变成精确公式，这也是 `ListView` 上 `itemExtent` 对滚动性能有实测收益的原因之一。

一句话总结：**懒加载的判据是一个用 cacheExtent 算出来的偏移量区间，不是可见性；回收也不等于销毁，`keepAlive` 决定 child 进哪个桶。**

## 八、边界声明

- 本篇只讲"谁在什么时候建/拆/留 child"。**`SliverConstraints` / `SliverGeometry` 的完整字段语义、viewport 怎么把累积量传下去，是第 47 篇。**
- `cacheExtent` 的 API 换代（`cacheExtent` + `cacheExtentStyle` → `scrollCacheExtent: ScrollCacheExtent`）在第 47 篇给过锚点，本篇只用新写法。
- `RenderSliverGrid` / `RenderSliverFixedExtentList` 的布局算法不展开；它们复用的是本节的 `_createOrObtainChild` / `_destroyOrCacheChild` / `collectGarbage` 三件套。注意 `ListView` 传了 `itemExtent` 时用的是 `SliverFixedExtentList` → `RenderSliverFixedExtentBoxAdaptor`，**它并不继承 `RenderSliverList`**（实测 `whereType<RenderSliverList>()` 命中 0 个），这是很多资料会写错的地方。
- `KeepAliveNotification` / `KeepAliveHandle` / `AutomaticKeepAliveClientMixin` 的完整状态机（尤其是 `_addClient` 里那段"不能在布局期 setState"的长注释，`automatic_keep_alive.dart:200-262`）不展开。
- 本篇不展开列表虚拟化的业务侧选型（何时关闭 `addRepaintBoundaries`、`itemExtent` 的取值、`prototypeItem` 的用处）。
- `ListView.builder` 的 widget 组合（`BoxScrollView` → `SliverPadding` → `SliverList`）属于 widget 组合层，按类名读即可。
