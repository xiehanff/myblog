# StatefulWidget 的生命周期详解

[toc]

StatefulWidget 是 Flutter 中具有可变状态的组件，其生命周期比 StatelessWidget 更复杂。下面详细解释 StatefulWidget 及其对应 State 对象的完整生命周期。

## StatefulWidget 的生命周期阶段

StatefulWidget 的生命周期主要由其关联的 State 对象管理，完整的生命周期包括以下阶段：

### 1. 创建阶段

- **createState()**: 当 StatefulWidget 被插入到组件树中时，框架会调用该方法创建一个与之关联的 State 对象。更准确地说，它是在对应的 StatefulElement 构造时被调用的，因此同一个 Element 生命周期内只会执行一次。
  ```dart
  @override
  State<MyWidget> createState() => _MyWidgetState();
  ```

### 2. 初始化阶段

- **initState()**: State 对象被创建后的第一个生命周期方法，只调用一次。在这里可以进行一些初始化工作，如订阅流、初始化变量等。
  ```dart
  @override
  void initState() {
    super.initState(); // 必须先调用父类方法
    // 初始化代码
  }
  ```

- **didChangeDependencies()**: 在 initState() 之后立即调用，以及当 State 对象的依赖关系发生变化时调用。例如，当使用 InheritedWidget 时，如果 InheritedWidget 发生变化，此方法会被调用。State 从树中移除后又重新插入（如 GlobalKey 移动子树）且之前注册过依赖时，也会再次触发。
  ```dart
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 处理依赖变化
  }
  ```

为什么依赖初始化要放在 `didChangeDependencies` 而不是 `initState`？因为 `initState` 执行期间 State 还处于 created 阶段，此时调用 `Theme.of(context)`、`MediaQuery.of(context)` 这类会建立 InheritedWidget 依赖的方法，会直接抛出 FlutterError（源码断言报错：`dependOnInheritedWidgetOfExactType<...>() was called before initState() completed`）。`didChangeDependencies` 是框架保证 initState 已完成、可以安全建立依赖的第一个时机。

### 3. 构建阶段

- **build()**: 构建组件的 UI 结构。当 State 对象初始化后，或调用 setState() 方法后，框架会调用此方法重新构建 UI。
  ```dart
  @override
  Widget build(BuildContext context) {
    return Container(/* ... */);
  }
  ```

### 4. 更新阶段

- **didUpdateWidget(oldWidget)**: 当父组件重新构建导致当前 StatefulWidget 更新时调用。框架会提供旧的 widget 实例，允许我们对比新旧 widget 的变化。
  ```dart
  @override
  void didUpdateWidget(MyWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.someProperty != oldWidget.someProperty) {
      // 处理属性变化
    }
  }
  ```

- **setState()**: 不是生命周期方法，而是手动触发 State 对象重新构建的方法。调用此方法后，框架会标记当前 State 为"dirty"，并在下一帧重新调用 build() 方法。
  ```dart
  void _handleTap() {
    setState(() {
      _counter++;
    });
  }
  ```

### 5. 销毁阶段

- **deactivate()**: 当 State 对象从组件树中移除时调用。这通常是临时性的，因为 State 对象可能会被重新插入到另一处。
  ```dart
  @override
  void deactivate() {
    // 处理暂时移除的逻辑
    super.deactivate();
  }
  ```

- **dispose()**: 当 State 对象永久从组件树中移除时调用。在这里应该释放所有资源，如取消订阅、关闭流、释放动画控制器等。
  ```dart
  @override
  void dispose() {
    _controller.dispose(); // 释放资源
    super.dispose(); // 必须在最后调用父类方法
  }
  ```

## 生命周期流程图

初始创建过程：
```
createState() → initState() → didChangeDependencies() → build()
```

更新过程：
```
setState() → build()
```
或
```
父组件重建 → didUpdateWidget() → build()
```

销毁过程：
```
deactivate() → [可能重新插入：activate() → didChangeDependencies()（若有依赖）→ build()] 或 → dispose()
```

## 补充回调

- **reassemble()**：热重载时触发，用于重置临时状态或调试数据
- **activate()**：State 暂时移出树（deactivate）后又被重新插回时触发，典型场景是 GlobalKey 移动子树；首次插入不会调用（走 initState）。这个回调自框架早期（2016 年）就已存在，并非新 API
- **didChangeDependencies()**：依赖项变化时触发，不等同于父组件重建

## 使用建议补充

1. **initState** 中可以直接初始化状态，通常不需要 `setState`
2. **didUpdateWidget** 中要比较 `oldWidget` 与 `widget`，避免无意义更新
3. **异步回调前检查 mounted**，避免 `setState` after dispose（触发时抛出 `setState() called after dispose(): ...`；dispose 是终态，State 无法重新挂载）

```text
Flutter Framework 创建 StatefulWidget
↓
调用 createState() 创建 State
↓
State 与 Widget / Element 建立关联
↓
initState()
↓
didChangeDependencies()
↓
build(context)
↓
父 Widget 配置变化时：didUpdateWidget(oldWidget) → build(context)
↓
状态变化时：setState() → markNeedsBuild() → 下一帧 build(context)
↓
临时移出树时：deactivate()
↓
同一帧内重新插回：activate() → didChangeDependencies()（若有依赖）→ build(context)
↓
永久移除时：dispose()
```

## 使用建议

1. **在 initState() 中**：初始化状态变量、创建控制器、订阅流等

2. **在 didChangeDependencies() 中**：处理依赖项变化，如获取 InheritedWidget 数据

3. **在 build() 中**：构建 UI，不应包含复杂计算或网络请求

4. **在 didUpdateWidget() 中**：响应 widget 配置变化

5. **在 dispose() 中**：释放所有资源，防止内存泄漏

---

# didUpdateWidget 和 didChangeDependencies 的区别

`didUpdateWidget` 和 `didChangeDependencies` 是 StatefulWidget 生命周期中两个重要的回调方法，它们用于不同的场景并有明显的区别。以下是它们的详细对比：

## 调用时机的区别

### didUpdateWidget

- **触发条件**：当父组件重新构建，导致当前 StatefulWidget 更新（配置或属性发生变化）时调用。
- **时机**：发生在 widget 配置更新后，但在 build 方法调用前。
- **特点**：接收一个参数 `oldWidget`，允许你比较新旧 widget 的属性变化。

### didChangeDependencies

- **触发条件**：
  1. 在 `initState()` 之后立即调用一次
  2. 当 widget 依赖的 InheritedWidget 发生变化时调用
- **时机**：在依赖项变化后，build 方法调用前
- **特点**：不接收任何参数

## 依赖关系的区别

### didUpdateWidget

- 关注的是当前 widget 本身的配置变化
- 处理的是父组件传递给当前组件的参数变化
- 与组件树的层级关系直接相关

### didChangeDependencies

- 关注的是当前 widget 所依赖的 InheritedWidget 数据变化
- 通常是通过 `context.dependOnInheritedWidgetOfExactType<T>()` 或 `Provider.of<T>(context)` 等方法建立的依赖关系
- 与数据传递机制相关，而非直接的组件层级关系

## 使用场景举例

### didUpdateWidget 的典型使用场景

```dart
class CounterDisplay extends StatefulWidget {
  final int count;
  
  const CounterDisplay({Key? key, required this.count}) : super(key: key);
  
  @override
  State<CounterDisplay> createState() => _CounterDisplayState();
}

// AnimationController 的 vsync 参数需要 TickerProvider，
// 所以这里必须混入 TickerProviderStateMixin
class _CounterDisplayState extends State<CounterDisplay>
    with TickerProviderStateMixin {
  late AnimationController _controller;
  
  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: Duration(milliseconds: 500));
  }
  
  @override
  void didUpdateWidget(CounterDisplay oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 当计数值变化时，开始动画
    if (widget.count != oldWidget.count) {
      _controller.forward(from: 0.0);
    }
  }
  
  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Text('Count: ${widget.count}', 
          style: TextStyle(fontSize: 20 + 5 * _controller.value),
        );
      },
    );
  }
  
  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}
```

### didChangeDependencies 的典型使用场景

```dart
class ThemeAwareWidget extends StatefulWidget {
  @override
  State<ThemeAwareWidget> createState() => _ThemeAwareWidgetState();
}

class _ThemeAwareWidgetState extends State<ThemeAwareWidget> {
  Color? _themeColor;
  
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 获取当前主题颜色
    final theme = Theme.of(context);
    _themeColor = theme.primaryColor;
    
    // 如果使用Provider
    // final dataModel = Provider.of<DataModel>(context);
    // 进行需要的操作...
  }
  
  @override
  Widget build(BuildContext context) {
    return Container(
      color: _themeColor,
      child: Text('Theme aware content'),
    );
  }
}
```

## 主要区别总结

1. **触发源不同**：
   - `didUpdateWidget`：当 widget 的配置（从父组件传入的属性）发生变化时触发
   - `didChangeDependencies`：当 widget 依赖的 InheritedWidget 数据变化时触发

2. **用途不同**：
   - `didUpdateWidget`：用于响应属性变化，比较新旧 widget 的差异，并进行相应的处理
   - `didChangeDependencies`：用于响应上下文依赖的变化，如主题、语言、或通过 Provider 提供的数据

3. **参数不同**：
   - `didUpdateWidget`：接收旧 widget 作为参数，可以比较变化
   - `didChangeDependencies`：不接收任何参数

4. **初始调用**：
   - `didUpdateWidget`：只有当 widget 更新时才会调用，初始构建时不会调用
   - `didChangeDependencies`：在初始 `initState()` 之后会立即调用一次，然后在依赖变化时再次调用

了解这两个方法的区别，可以帮助开发者在适当的时机处理状态更新，提高 Flutter 应用的性能和响应能力。

> 完整的生命周期语义以官方文档为准：[StatefulWidget](https://api.flutter.dev/flutter/widgets/StatefulWidget-class.html)、[State](https://api.flutter.dev/flutter/widgets/State-class.html)、[StatefulElement](https://api.flutter.dev/flutter/widgets/StatefulElement-class.html)。
