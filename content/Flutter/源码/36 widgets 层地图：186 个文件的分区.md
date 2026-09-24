# 36 widgets 层地图：186 个文件的分区

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/widgets`

## 一、问题

`widgets` 是 framework 里最大的一层：**186 个文件、156.3k 行**。它是 `rendering`（48 文件 / 52.0k 行）的三倍。

于是"怎么读"这个问题比其它层更尖锐：**如果只读 20%，该读哪些？**

错误直觉是"`widgets` 这个名字最熟悉，所以从最熟悉的地方开始读"——于是从 `Container` 或 `Text` 入手，一路读到 `basic.dart`（8573 行）和 `editable_text.dart`（6864 行），两周之后既不知道自己读到哪了，也说不清 Element 到底怎么被复用。

正确的直觉相反：**这一层里"机制"和"组件"是两个完全不同的品种**。机制只有 17 个文件（20.7k 行，占 13%），组件有 169 个文件。这篇要做的就是把这两类分开，并给出"只读 20%"的具体名单。

## 二、最小 Demo

一个最小可运行程序，把这一层最核心的四个角色同时摆出来：

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
  void initState() {
    super.initState();
    debugPrint('1. initState，此时 context 可用但依赖未注册');  // 1. 生命周期起点
  }

  @override
  Widget build(BuildContext context) {
    // 2. Element 在 rebuild 时把自身作为 BuildContext 传进来
    return Directionality(
      textDirection: TextDirection.ltr,
      child: GestureDetector(
        onTap: () => setState(() => _n++),   // 3. setState 只标脏，不立即绘制
        child: Text('$_n', textDirection: TextDirection.ltr),
      ),
    );
  }
}
```

把它 `runApp` 起来，在 `build` 里打一行 `context.runtimeType`，会看到输出是 `StatefulElement` 而不是 `BuildContext`——这是这一卷要反复用到的一个事实（第三十七篇展开）。

再看一眼依赖方向，就知道为什么这一层的入口必须从机制文件开始：

```bash
# widgets 依赖几乎所有下层，但没有任何一层依赖它
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src
grep -c "^import 'package:flutter/" widgets/framework.dart   # 2
grep -c "^import '" widgets/framework.dart                   # 11
```

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `widgets.dart:1-188` | 整个层的对外面，188 行、173 个 export（其中 169 个指向 `src/widgets/`） |
| `widgets/framework.dart:312` | `abstract class Widget`，配置协议 |
| `widgets/framework.dart:3557` | `abstract class Element`，身份与生命周期协议 |
| `widgets/framework.dart:2306` | `abstract class BuildContext`，Element 的接口视角 |
| `widgets/framework.dart:2901` | `class BuildOwner`，脏列表与调度 |
| `widgets/framework.dart:2684` | `final class BuildScope`，3.44 新增的脏列表容器 |
| `widgets/binding.dart:455` | `mixin WidgetsBinding`，一帧的编排 |
| `widgets/binding.dart:1536` | `drawFrame`，`buildScope` 在这里被调用 |
| `widgets/basic.dart:1` | 8.5k 行的组件库，属于"上层应用协议"的起点了 |

## 四、调用链：从 186 个文件里挑出 17 个

### 4.1 先看导出面：169 / 186

`widgets.dart` 一共 188 行，173 个 `export`。其中 4 个指向别的包（`package:characters`、`package:vector_math`、`foundation.dart`、`rendering.dart`），**169 个指向 `src/widgets/` 下的文件**。

186 减 169 是 17，正好是这 17 个没有被导出的文件：

```text
_window.dart  _window_io.dart  _window_web.dart  _window_linux.dart
_window_macos.dart  _window_win32.dart  _window_positioner.dart
_web_image_io.dart  _web_image_web.dart  _web_browser_detection_io.dart
_web_browser_detection_web.dart  _html_element_view_io.dart  _html_element_view_web.dart
_platform_selectable_region_context_menu_io.dart
_platform_selectable_region_context_menu_web.dart
_accessibility_evaluations.dart   constants.dart
```

前 16 个可以按两种模式归位：

| 模式 | 文件 | 谁在用 |
|---|---|---|
| 条件导入的实现文件 | `_window*`、`_web_image*`、`_web_browser_detection*`、`_html_element_view*`、`_platform_selectable_region_context_menu*` | 门面文件用 `if (dart.library.js_interop)` 选择 |
| 纯内部实现 | `_accessibility_evaluations.dart` | 无障碍规则评估（`MinimumTapTargetEvaluation` 等），只被 `binding.dart:39` import |

`constants.dart` 是唯一的例外：它只有 19 行，一个常量 `kMinInteractiveDimension`。**它不在 `widgets.dart` 的导出名单里**，只被同目录的 3 个文件直接 import（`autocomplete.dart:17`、`editable_text.dart:36`、`text_selection.dart:21`）。见第六节实验 2。

`src/material/constants.dart` 里有一份**同名同值的副本**（`material/constants.dart:27` 也是 `const double kMinInteractiveDimension = 48.0;`）。两个文件互不相干，各自被本层文件 import——所以`package:flutter/material.dart` 用起来不会冲突。

### 4.2 条件导入：和 foundation 层同一套手法

```dart
// _window.dart:22
import '_window_io.dart' if (dart.library.js_interop) '_window_web.dart' as window_impl;
```

同一模式在本层共 6 处：

| 门面文件 | 实现文件 | 分叉原因 |
|---|---|---|
| `_window.dart:22` | `_window_io` / `_window_web` | 多窗口 API：原生走 C++ 宿主，Web 只有单窗口 |
| `image.dart:22` | `_web_image_io` / `_web_image_web` | Web 的 `ImageElement` 解码路径不同 |
| `editable_text.dart:29` | `_web_browser_detection_io` / `_web_browser_detection_web` | 浏览器族判定（Safari/Firefox 的输入法差异） |
| `platform_view.dart:14` | `_html_element_view_io` / `_html_element_view_web` | Web 的原生元素嵌入 |
| `platform_selectable_region_context_menu.dart:5-6` | `_platform_selectable_region_context_menu_io` / `..._web` | Web 走浏览器原生右键菜单（这处是 `export` + `if`，不是 `import`） |
| `_window_positioner.dart` | 引 `_window.dart` | 本层内部二次分叉 |

**关键认知**：这一层的条件导入比 foundation 层"重"。foundation 分叉的是 `defaultTargetPlatform`、`compute` 这类**一行为主**的开关；widgets 分叉的是一整块**平台专属控件**（多窗口、原生元素嵌入、右键菜单），每个 `_io` 文件背后都是几百行。所以看到 `_window_io.dart` 有 43 行而 `_window_linux.dart` 有 1453 行，不要意外——门面只负责选，重量在三个具体平台实现里。

### 4.3 一帧的编排链：只有 3 跳

`binding.dart` 的名字容易让人以为它很大。它 2155 行，但**真正的编排只有 3 跳**：

```dart
// binding.dart:1536 起（节选）
void drawFrame() {
  ...
  if (rootElement != null) {
    buildOwner!.buildScope(rootElement!);   // 1. 冲刷脏 Element（一次性重建）
  }
  super.drawFrame();                        // 2. layout → compositeBits → paint → semantics
  buildOwner!.finalizeTree();               // 3. 把 _inactiveElements 里的 Element 真正 unmount
}
```

三跳的分工：

| 跳 | 调用 | 谁被驱动 |
|---|---|---|
| 1 | `buildOwner!.buildScope(rootElement!)` | 脏 Element 列表，产出新的 Element 树 |
| 2 | `super.drawFrame()`（`RendererBinding`） | `PipelineOwner` 的 layout / paint 流水线 |
| 3 | `buildOwner!.finalizeTree()` | `_inactiveElements` 里的 Element → `unmount` |

`buildOwner` 的 `onBuildScheduled` 在 `initInstances` 里接上：

```dart
// binding.dart:476-477
_buildOwner = BuildOwner();
buildOwner!.onBuildScheduled = _handleBuildScheduled;
```

`_handleBuildScheduled`（`binding.dart:1430`）做的事就是 `scheduleFrame()`——**这就是"setState 不是立即刷新屏幕"的最短答案**：`setState` 只到 `_handleBuildScheduled`，剩下的事等下一帧 `drawFrame`。完整链路见第四十二篇，帧的来源见第四卷 18 篇。

### 4.4 组件是怎么挂在机制上的

`framework.dart:312` 的 `Widget.createElement()` 是唯一的缝合点：

```dart
// framework.dart:347-349
@protected
@factory
Element createElement();
```

- `StatelessWidget.createElement()` → `StatelessElement(this)`（`:531`）
- `StatefulWidget.createElement()` → `StatefulElement(this)`（`:779`）
- `InheritedWidget.createElement()` → `InheritedElement(this)`（`:1859`）
- `RenderObjectWidget.createElement()` 声明在 `:1899`，由三个子类各自实现：`:1944`（Leaf）/ `:1967`（SingleChild）/ `:2051`（MultiChild）

**关键认知**：`Widget` 是 `@immutable` 的，`Element` 是可变的长生命周期对象。整层的设计都围绕这条分界线：**配置（Widget）随便重建，身份（Element）尽量复用**。169 个组件文件里所有的 `createElement`、`createRenderObject`、`updateRenderObject` 都是在给这条分界线补具体内容。

## 五、核心对象：十三个分区与各自的分量

把 186 个文件按职责分区。下面这张表就是本篇的结论——**加粗的是机制，其余是组件**。

### 总表

| 分区 | 文件数 | 行数 | 其中必读 |
|---|---|---|---|
| **A 框架协议** | 17 | 20 663 | `framework.dart`、`binding.dart`、`view.dart` |
| **B 基础组件** | 28 | 17 356 | `basic.dart` 里的 `MultiChildRenderObjectWidget` 家族 |
| C 滚动与 Sliver | 41 | 33 533 | `scrollable.dart`、`viewport.dart` |
| D 路由与导航 | 12 | 14 723 | `navigator.dart` 的 `_history` 处理 |
| E 浮层 | 8 | 6 571 | `overlay.dart` 的 `OverlayEntry` |
| F 文本编辑 | 16 | 20 470 | `editable_text.dart` 的 `TextInputConnection` 边界 |
| G 焦点 / 动作 / 快捷键 | 7 | 9 498 | `focus_manager.dart` 的 `FocusNode` 树 |
| H 媒体查询与平台窗口 | 19 | 16 129 | `media_query.dart`、`view.dart`、`_window.dart` |
| I 手势桥接 | 7 | 5 974 | `gesture_detector.dart` 的 `RawGestureDetector` |
| J 动画 | 9 | 4 823 | `implicit_animations.dart` 的 `AnimatedWidgetBaseState` |
| K 本地化与主题 | 8 | 1 860 | `localizations.dart` |
| L 表单与开关等 | 8 | 3 973 | `form.dart`、`toggleable.dart` |
| M Web 分叉实现 | 6 | 743 | 只在 Web 编译时生效，可整块跳过 |

### A 区：框架协议（17 文件 / 20 663 行）——本卷全部内容

| 文件 | 行数 | 内容 |
|---|---|---|
| **`framework.dart`** | 7 455 | `Widget`/`Element`/`BuildContext`/`BuildOwner`/`BuildScope`/`State`/`InheritedElement`/`RenderObjectElement` 全在这里 |
| **`binding.dart`** | 2 155 | `WidgetsBinding`，一帧编排、`Views` 管理 |
| `widget_inspector.dart` | 4 618 | DevTools 的 Widget 树检查协议 |
| `widget_state.dart` | 1 152 | `WidgetStateProperty` / `WidgetState`，Material 状态的基类 |
| `restoration.dart` | 1 035 | `RestorationManager`，状态恢复 |
| `restoration_properties.dart` | 688 | `RestorableXxx` 一族 |
| `view.dart` | 919 | `View`、`RawView`、`RenderTreeRootElement` 的宿主 |
| `debug.dart` | 552 | `debugPrintBuildScope`、`debugPrintGlobalKeyedWidgetLifecycle` 等开关 |
| `service_extensions.dart` | 539 | `ext.flutter.*` 名字常量 |
| `async.dart` | 672 | `StreamBuilder` / `FutureBuilder`（其实是组件，但机制性很强） |
| `inherited_model.dart` | 249 | `InheritedModel`，`InheritedWidget` 的 aspect 版 |
| `notification_listener.dart` | 177 | `NotificationListener` 与通知树 |
| `inherited_notifier.dart` | 135 | `InheritedNotifier` |
| `adapter.dart` | 186 | `ViewAdapter`，多视图适配 |
| `disposable_build_context.dart` | 75 | `DisposableBuildContext`，跨帧持有 `BuildContext` |
| `unique_widget.dart` | 37 | `UniqueWidget` |
| `constants.dart` | 19 | **零引用** |

**关键认知**：A 区之外，`framework.dart` 的机制**没有任何一处被复制**。6.5k 行的 `navigator.dart`、6.9k 行的 `editable_text.dart` 全部是"在 `ComponentElement` / `RenderObjectElement` 上做扩展"——它们自己定义 `createElement` 和新的 Element 子类，但**升级/复用判定仍然回到 `Widget.canUpdate`**。这就是为什么只读 A 区就能读懂其余 169 个文件的骨架。

### 只读 20% 的名单

156.3k 行的 20% 是 31k 行。按下面顺序读，约 21k 行，正好落在 20% 以内：

```text
1. framework.dart    7 455 行   本卷 37–44 全部内容
2. binding.dart      2 155 行   drawFrame 三跳，只读 455–1700 行的区间（约 1 250 行）
3. basic.dart        8 573 行   只读前 2 300 行（Widget 家族声明与 createElement 派发）
4. scrollable.dart   2 553 行   卷 10 内容，本卷不读
5. editable_text.dart 6 864 行  卷 10 内容，本卷不读
```

**把 3 压缩到前 2 300 行、2 压缩到 `WidgetsBinding` 段落之后，A 区实测只需读约 11k 行**，比 20% 还少一半。

## 六、源码实验

### 实验 1：确认导出面

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib
grep -c "^export 'src/widgets/" widgets.dart        # 169
find src/widgets -name '*.dart' | wc -l              # 186
```

**预测**：导出数应该等于文件数减去下划线文件数。

**实际**：169 vs 186，差额 17。但下划线文件只有 16 个，第 17 个是 `constants.dart`。

**说明**：这个差额是可以逐项对上的，说明这一层的门面是完整的（没有"写了但忘了导出"的公开 API）。

### 实验 2：三种"被引用"的形态

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib
# 1. 门面导出
grep -c "^export 'src/widgets/" widgets.dart
# 2. 同层兄弟文件是否直接 import 了它
grep -rn "import '\./\?[a-z_]*\.dart'" src/widgets/framework.dart
# 3. 某个文件到底有没有人用（以 constants.dart 为例）
grep -rn "import 'constants.dart'" src/widgets/
```

**预测**：一个文件"有用"应该等价于"有人 import 它"。

**实际**（实测）：三个命令的输出分别是 `169`、第六节 4.3 已列的 6 行、以及 3 行（`autocomplete.dart:17`、`editable_text.dart:36`、`text_selection.dart:21`）。

**说明**：这里推翻了预测里的等价关系。186 个文件里，**127 个被同层兄弟文件直接 import**，**57 个只被 `widgets.dart` export、不被任何兄弟文件 import**，两者相加 184，剩下 2 个（`_platform_selectable_region_context_menu_web.dart`、`_web_browser_detection_web.dart`）只出现在跨行书写的条件导入第二行上，用逐行 grep 扫不到。所以判断一个 widgets 文件是否被用到，要跑两次检查（import 和 export），只看 import 会把 57 个文件误判成死代码。

这个计数也顺手解释了为什么 `constants.dart` 特殊：它**既没被 export，也没被跨目录 import，只有 3 个同目录文件 import 它**。它属于"本层内部工具"，不是公开 API。

### 实验 3：`framework.dart` 到底依赖了本层谁

```bash
cd $(dirname $(dirname $(which flutter)))/packages/flutter/lib/src/widgets
grep -n "^import" framework.dart
```

**预测**：`framework.dart` 是这一层最大的文件，应该 import 很多兄弟文件。

**实际**（实测输出，共 10 行 import）：

```text
13:import 'dart:async';
14:import 'dart:collection';
16:import 'package:flutter/foundation.dart';
17:import 'package:flutter/rendering.dart';
19:import 'binding.dart';
20:import 'debug.dart';
21:import 'focus_manager.dart';
22:import 'inherited_model.dart';
23:import 'notification_listener.dart';
24:import 'widget_inspector.dart';
```

本层只引了 6 个。

**说明**：这是"机制文件不吃组件"的直接证据。`framework.dart` 反过来被 100+ 个文件 import，但自己只向上要 6 个兄弟——其中 `inherited_model.dart` 和 `notification_listener.dart` 是为了给 `InheritedModel` / `NotificationListener` 提供 Element 基类而反向依赖。**读源码时"谁引用我"比"我引用谁"更能定位文件的层级**。

### 实验 4：确认一帧的三跳

读完第四节 4.3 后，用调试开关把这一帧打出来：

```dart
// 在任何 Widget 的 build 之前执行
import 'package:flutter/widgets.dart';

void main() {
  debugPrintBuildScope = true;    // 开关声明在 widgets/debug.dart:88
  runApp(const Counter());
}
```

**预测**：应该每一帧看到一次 `buildScope called with context ...`。

**实际**：只在有脏 Element 的帧才打印（`buildScope` 开头有 `if (callback == null && buildScope._dirtyElements.isEmpty) return;`，`framework.dart:3058`）。静止不动时一帧都不打印。

**说明**：这条早退是整个"按需重建"的入口。它同时解释了为什么 `setState` 之后必须要有一个东西去 `scheduleFrame`——如果没有任何人请求新帧，`drawFrame` 根本不会被调用，脏列表就一直躺着。那个"东西"就是 `BuildOwner.onBuildScheduled`。

## 七、结论

1. `widgets` 层 186 个文件里，**真正的机制是 A 区 17 个文件 / 20.7k 行（13%）**；其余 169 个文件是组件，它们都在重复同一件事：定义 `createElement` / `createRenderObject` / `updateRenderObject`，把配置翻译成 Element 和 RenderObject 的操作。
2. **只读 20% 的具体名单**是：`framework.dart` 全文 + `binding.dart` 的 `WidgetsBinding` 段（约 1 250 行）+ `basic.dart` 前 2 300 行。这三处加起来约 11k 行，比 20% 还少一半。
3. `binding.dart` 虽然 2 155 行，但一帧的编排只有三跳：`buildOwner.buildScope(rootElement)` → `super.drawFrame()` → `buildOwner.finalizeTree()`。**其余 1 900 行是 Views 管理、无障碍、热重载、平台消息转发**，本卷不追。

一句话总结：**widgets 层是"17 个协议文件 + 169 个翻译官"，读完 `framework.dart` 就等于拿到了读其余 169 个文件的字典。**

## 八、边界声明

- 本篇只做分区，不展开机制。`Widget` / `Element` / `BuildContext` 从第三十七篇开始，逐篇展开到第四十四篇。
- C 区（滚动与 Sliver，33.5k 行，本层最大）属于**卷 10 widgets 应用协议**，本卷不追。
- D / E / F 区（导航、浮层、文本编辑）同样属于卷 10，本卷只在需要举例子时引用其中的类名。
- `widget_inspector.dart`（4.6k 行）是独立的一条线（DevTools 协议），本系列不做专题。
- M 区（Web 分叉）只在"这一层也用了条件导入"这个事实层面提及，不展开具体平台实现。
- 本篇关注三棵树在 widgets 层目录结构中的文件位置。
