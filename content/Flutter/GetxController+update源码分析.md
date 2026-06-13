# 关于疑惑

> 这篇记录基于当前仓库里 `get 4.7.2` 对应的源码。  
> 把自己刷源码时的几个点记下来。

我第一次碰 GetX 的 update 机制时，脑子里冒出来的第一个问题其实很简单：页面明明只是改了一个字段，为什么有时候只动一小块，有时候又像整页都跟着翻了一遍。

那时候我以为这里面会有点“自动识别变化”的味道，后来顺了源码，发现它其实没那么玄。它更像一条很直的通知链，controller 负责发信号，GetBuilder 负责接住信号，最后还是回到 Flutter 的 setState。

```dart
abstract class GetxController extends DisposableInterface
    with ListenableMixin, ListNotifierMixin
```

这一段已经把底子说得差不多了。GetxController 自己就带着监听能力，不是单纯装状态的盒子。它能登记谁在听，也能主动通知谁该动一动。

而 GetBuilder 那边也没有故弄玄虚，它还是个普通的 StatefulWidget。

```dart
void getUpdate() {
  if (mounted) setState(() {});
}
```

我后来对它的理解，基本就停在这里了。GetX 没有绕开 Flutter 的重建机制，它只是把“什么时候 setState”这件事收得更细一点。

## 我真正想弄清的，是订阅关系

源码里最让我停住的地方，是 GetBuilder 初始化时那段注册逻辑。它不是等 controller 自己来找它，而是先把自己的回调塞进去。

```dart
_remove = (widget.id == null)
    ? controller?.addListener(
        _filter != null ? _filterUpdate : getUpdate,
      )
    : controller?.addListenerId(
        widget.id,
        _filter != null ? _filterUpdate : getUpdate,
      );
```

这个地方看久了，我才慢慢反应过来：所谓“局部刷新”，本质上不是一套自动推断系统，而是一个很朴素的订阅系统。没有 id 的时候，就进默认列表；有 id 的时候，就进对应分组。

所以我后来再看 update，就不会把它想成“刷新页面”，而是“把通知发出去”。这两个动作其实差很多。前者像系统帮你做了判断，后者只是你自己决定通知谁。

```dart
void update([List<Object>? ids, bool condition = true]) {
  if (!condition) {
    return;
  }
  if (ids == null) {
    refresh();
  } else {
    for (final id in ids) {
      refreshGroup(id);
    }
  }
}
```

这里的语气很直接，甚至有点朴素得过头。没有 ids，就全走默认监听；有 ids，就只找那几组。它不帮你猜，它只是照着你给的名单发消息。

## 为什么会觉得它像“细粒度刷新”

我一开始总觉得“细粒度”这个词有点大，后来发现它在这里其实很具体。默认监听是一份列表，分组监听是另一份按 id 分开的表。update 只是把通知送去不同地方。

```dart
void refresh() {
  _notifyUpdate();
}

void refreshGroup(Object id) {
  _notifyIdUpdate(id);
}
```

顺着这条线往下看，`update(['count'])` 这种写法就很容易懂了。它不是去页面树里找“那个叫 count 的区域”，而是只去通知注册在 count 这个 id 上的人。哪块会重建，完全取决于谁订阅了这次消息。

我挺喜欢这件事的。它没有把状态变化包装得太聪明，反而显得清楚。页面大一点的时候，这种清楚比“自动帮你处理”更有用。标题、列表、统计区都可以挂在同一个 controller 上，但它们不必一起抖一下。

## filter 像是在门口多看了一眼

如果 GetBuilder 带了 filter，订阅进去的就不是普通回调，而是先过一层判断。

```dart
void _filterUpdate() {
  var newFilter = widget.filter!(controller!);
  if (newFilter != _filter) {
    _filter = newFilter;
    getUpdate();
  }
}
```

这个设计我看着一直有种很轻的感觉。controller 还是照常发通知，但 widget 不一定马上重建，它会先看看 filter 结果有没有真的变化。变了，再 setState；没变，就算了。

我把它理解成“门口多看了一眼”。它不是主角，也不是另一套机制，只是把一些没必要的重建拦掉一点。

## 我现在怎么理解这套东西

我现在再看 GetxController 和 update，脑子里不会先冒出“源码分析”四个字，而是一个很简单的图景。

controller 发消息，GetBuilder 收消息，最后落到 setState。id 负责把消息分组，filter 负责把消息再筛一遍。

```dart
@override
Widget build(BuildContext context) {
  return widget.builder(controller!);
}
```

build 本身还是老样子，没什么花活。真正变的是前面的通知过程。GetX 只是把这条过程拆得更细，所以你在页面里能更明确地控制哪一块该动、哪一块不用动。

