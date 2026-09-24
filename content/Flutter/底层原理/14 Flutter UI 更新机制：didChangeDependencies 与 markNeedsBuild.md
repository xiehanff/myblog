# Flutter UI 更新机制

[toc]

`didChangeDependencies`、`markNeedsBuild`、`canUpdate` 和 `setState` 共同决定了 Flutter 如何在状态变化或依赖变化时更新 UI。理解它们的职责、调用顺序和触发场景，有助于判断更新范围并避免无效重建。

## 核心职责

### didChangeDependencies

**所属**：`State`
**作用**：当依赖的 `InheritedWidget` 变化时触发（例如 `Theme`、`MediaQuery`）
**触发时机**：
- `initState` 之后、首次 `build` 之前，一定会调用一次
- 依赖的 `InheritedWidget` 的 `updateShouldNotify` 返回 `true`
- Element 被重新激活时（例如通过 `GlobalKey` 把子树移到树的另一个位置，且该 Element 之前建立过依赖）
**典型场景**：
- 主题切换：`Theme.of(context)` 依赖变化后更新颜色/字体
- 屏幕尺寸变化：旋转/分屏导致 `MediaQuery` 更新
- 本地化变更：`Localizations` 切换语言、文本方向
- Provider / InheritedModel 更新：依赖的 model 变更触发刷新

### markNeedsBuild

**所属**：`Element`
**作用**：将当前 Element 标记为 dirty，加入待重建队列，并请求调度新帧
**语义细节**（源码位于 `packages/flutter/lib/src/widgets/framework.dart`）：
- 去重：如果 Element 已经是 dirty 状态，直接返回，不会重复入队
- Element 不处于 active 生命周期状态时是 no-op（静默忽略）
- 置脏后调用 `BuildOwner.scheduleBuildFor`，Element 实际进入 `BuildScope` 持有的 `_dirtyElements` 队列
**常见入口**：
- `State.setState`（内部就是调用 `_element!.markNeedsBuild()`）
- 依赖变更后自动触发（`InheritedElement.notifyDependent` → `Element.didChangeDependencies` → `markNeedsBuild`）
**典型场景**：
- 点击按钮更新计数器
- 下拉刷新后更新列表数据
- 动画驱动的状态变更（如手动控制帧时）

### canUpdate

**所属**：`Widget`（静态方法）
**作用**：判断新旧 Widget 是否可复用 Element
**规则**：`runtimeType` 相同且 `key` 相同 → 复用
**典型场景**：
- 列表项重排序时使用 `ValueKey(id)` 保持状态
- 使用 `UniqueKey()` 强制重建某个子树
- `GlobalKey` 允许跨位置复用 Element

### setState

**所属**：`State`
**作用**：同步修改状态，并触发 `markNeedsBuild`
**注意**：
- 只能在 `StatefulWidget` 的 `State` 中使用
- 不要在 `build` 中调用，避免无限循环
**典型场景**：
- 用户交互改变本地状态（开关、计数、Tab 切换）
- 异步请求完成后刷新 UI（注意 `mounted` 检查）

## 串联逻辑（简化）

```text
状态变化 / 依赖变化
    ↓
setState（主动）或 InheritedElement.notifyDependent（依赖变化）
    ↓
markNeedsBuild
    ↓
BuildOwner.scheduleBuildFor → 请求调度新帧（ensureVisualUpdate）
    ↓
新帧中 BuildOwner.buildScope / BuildScope._flushDirtyElements
    ↓
element.rebuild / build()
    ↓
updateChild
    ↓
Widget.canUpdate 判断复用
```

## 详细流程

1. **触发入口**：
   - 依赖变化：`InheritedWidget.updateShouldNotify == true`
   - 主动更新：`setState`

2. **标记 dirty**：
   - `markNeedsBuild` 置 `_dirty = true` 后调用 `BuildOwner.scheduleBuildFor`
   - Element 进入的是 `BuildScope._dirtyElements`（Flutter 3.41 中 dirty 队列由 `BuildScope` 持有，早期版本才挂在 `BuildOwner` 上）
   - 队列首次有元素时，会经 `onBuildScheduled` → `WidgetsBinding._handleBuildScheduled` → `SchedulerBinding.ensureVisualUpdate` 请求调度新帧；若当前已在帧的回调阶段内，则不会重复排帧

3. **下一帧处理**：
   - `WidgetsBinding.drawFrame` 调用 `buildOwner.buildScope`，实际排序与重建由 `BuildScope._flushDirtyElements` 执行
   - dirty elements 按深度排序（父先子后），逐个执行 `element.rebuild`

4. **对比与复用**：
   - `updateChild` 使用 `Widget.canUpdate` 判断复用 Element
   - 能复用则更新 Widget 配置；否则销毁旧 Element 并新建

5. **渲染管线**：
   - build 结束后，标记需要 layout/paint 的 RenderObject
   - 在同一帧完成 Layout/Paint/Compositing/Raster

## 细节补充：为什么有时没更新

1. **依赖未建立**：没有通过 `context.dependOnInheritedWidgetOfExactType` 或 `Theme.of` 取值
2. **复用导致未重建**：`canUpdate` 返回 true，Element 被复用，需确认 `build` 是否真正依赖变化
3. **状态未变**：`setState` 内未改动任何状态，导致 UI 无差异
4. **异步回调晚于 dispose**：未检查 `mounted`，更新被忽略或抛异常

## 进阶细节：markNeedsBuild 的边界与 didChangeDependencies 的调用时机

### markNeedsBuild 什么时候会被拒绝

`markNeedsBuild` 内部有多层保护，它们对应两类常见报错：

- **build 期间只能标记"子孙"**：debug 模式下，如果框架正在 build，而被标记的 Element 不是当前正在构建的 Element 的后代，会抛出 `setState() or markNeedsBuild() called during build.`。框架允许标记子孙这个例外，是因为 build 顺序父先子后，脏掉的子孙一定会被本轮 build 覆盖到。
- **树锁定时禁止标脏**：widget 树处于锁定阶段（例如 `buildScope` 回调执行期间）调用会抛出 "widget tree was locked" 相关错误。
- **非 active 状态是 no-op**：Element 处于 inactive（已 deactivate、尚未 dispose）时直接返回，不报错也不生效。

### ensureVisualUpdate：谁来决定"下一帧"

`markNeedsBuild` 本身不排帧，真正请求新帧的是 `SchedulerBinding.ensureVisualUpdate`：

- 当前处于 `idle` 或 `postFrameCallbacks` 阶段 → 调用 `scheduleFrame` 向引擎请求新帧
- 已处于帧的其他阶段（动画回调、微任务、持久回调）→ 直接返回，不重复排帧

这解释了为什么 `setState` 的效果总是"最迟下一帧"生效，也解释了为什么在布局/绘制回调里 `setState` 会触发断言——那正处于帧内，框架不希望重建被推迟造成界面滞后一帧。

### 3.41 中 State.didChangeDependencies 的调用时机

依赖变化时，framework 先走 Element 层的 `didChangeDependencies`（内部调用 `markNeedsBuild`），而 `State.didChangeDependencies` 并不会立即执行：`StatefulElement` 会先记录一个 `_didChangeDependencies` 标志，等本帧 `performRebuild` 开头再调用它，然后才执行 `build`。这样设计是为了避免"widget 已被移出树、但它依赖的 `InheritedWidget` 还在更新"时的无效回调。首帧则是另一条路径：`StatefulElement._firstBuild` 里依次执行 `initState` → `didChangeDependencies` → `build`。

## 代码示例

```dart
import 'package:flutter/material.dart';

class MyStatefulWidget extends StatefulWidget {
  @override
  _MyStatefulWidgetState createState() => _MyStatefulWidgetState();
}

class _MyStatefulWidgetState extends State<MyStatefulWidget> {
  int counter = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    print('didChangeDependencies called');
  }

  void _incrementCounter() {
    setState(() {
      counter++;
      print('setState called');
    });
  }

  @override
  Widget build(BuildContext context) {
    print('build called');
    return Scaffold(
      appBar: AppBar(title: Text('Lifecycle Example')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Counter: $counter'),
            ElevatedButton(
              onPressed: _incrementCounter,
              child: Text('Increment'),
            ),
          ],
        ),
      ),
    );
  }
}

void main() {
  runApp(
    MaterialApp(
      home: MyStatefulWidget(),
    ),
  );
}
```

**运行日志**

首次渲染：

```bash
didChangeDependencies called
build called
```

点击按钮触发 setState：

```bash
setState called
build called
```

## 关键点总结

1. `didChangeDependencies` 在首帧（`initState` 之后）和 Element 重新激活时必调一次，其余情况只在依赖变更时触发，不会因 `setState` 自动调用
2. `markNeedsBuild` 仅标记 dirty，真正 build 在下一帧
3. `canUpdate` 决定 Element 复用策略，影响性能与状态复用
4. `setState` 是最常见入口，但不是唯一入口
