# 33 BoxConstraints 模型与约束向下尺寸向上

> 版本锚点：Flutter 3.44.8 (058e0af2c2) · 源码路径 `packages/flutter/lib/src/rendering/box.dart`（3388 行）、`rendering/object.dart`

## 一、问题

Flutter 布局有一句被引用最多的话：**约束向下、尺寸向上、位置由父决定**。

问题是：这三句话在源码里分别对应什么？以及最关键的——**约束到底是"建议"还是"硬契约"？**

错误直觉有三个，都很常见：

1. **"约束是建议，子可以不听"** —— 源码里 `constrain()` 是 `clampDouble`，是硬性的数值夹取。子可以在 `[min, max]` 内自由选，但**选不出去**。debug 模式下 `debugAssertDoesMeetConstraints` 会检查 `constraints.isSatisfiedBy(size)`。
2. **"给子设置 width 就是给子设尺寸"** —— `SizedBox(width: 100)` 做的是**把约束改成 tight 的 100**，子仍然可以"不接受"这个值吗？不能，因为 tight 约束下 `constrain` 只有一个解。但它确实只是约束，不是直接赋值。
3. **"`hasInfiniteWidth` 表示 maxWidth 是无限的"** —— `const BoxConstraints()` 的 `maxWidth` 是 `double.infinity`，但 `hasInfiniteWidth` 返回 **false**。这个 getter 判断的是 `minWidth >= double.infinity`（`box.dart:410`），是 `BoxConstraints.expand()` 那种"强制无限大"的情形，不是"上界无限"。

`BoxConstraints` 的四个字段是 **两个区间**，不是一个尺寸。`constrain()` 的语义是"把想要的值夹进区间"，`tighten()` 的语义是"把区间收成一个点"，`enforce()` 的语义是"把两个区间求交"。三者的区别是本文最值钱的部分。

## 二、最小 Demo

`BoxConstraints` 是纯值对象，不依赖 `dart:ui` 的渲染能力，可以单独算。下面这段是实际输出：

```dart
import 'package:flutter/rendering.dart';

void main() {
  // 1. 一个区间：宽 100~200，高 0~50
  const BoxConstraints c = BoxConstraints(minWidth: 100, maxWidth: 200, minHeight: 0, maxHeight: 50);

  // 2. constrain = 夹取：不管给多大/多小，结果一定落在区间内
  debugPrint('${c.constrain(const Size(300, 300))}');   // Size(200.0, 50.0)
  debugPrint('${c.constrain(const Size(10, 10))}');     // Size(100.0, 10.0)

  // 3. enforce = 求交：把 c 夹进另一个约束允许的范围
  const BoxConstraints outer = BoxConstraints(minWidth: 10, maxWidth: 80, minHeight: 10, maxHeight: 80);
  debugPrint('${c.enforce(outer)}');   // BoxConstraints(w=80.0, 10.0<=h<=50.0)

  // 4. tighten = 收成一个点（但仍尊重原区间）
  debugPrint('${c.tighten(width: 500)}');   // BoxConstraints(w=200.0, 0.0<=h<=50.0)
  debugPrint('${c.tighten(width: 150)}');   // BoxConstraints(w=150.0, 0.0<=h<=50.0)

  // 5. deflate = 减去边距（给 Padding 用的）
  debugPrint('${c.deflate(const EdgeInsets.symmetric(horizontal: 20, vertical: 10))}');
  // BoxConstraints(60.0<=w<=160.0, 0.0<=h<=30.0)

  // 6. loosen = 把 min 归零，max 不变
  debugPrint('${c.loosen()}');   // BoxConstraints(0.0<=w<=200.0, 0.0<=h<=50.0)
}
```

把第 3、4 步的输出和直觉对一下：`enforce` 之后 `minWidth == maxWidth == 80`（约束被"夹"成了 tight），而 `tighten(width: 500)` 想要 500 却只拿到 200。**两个方法的"让步方向"不同：`enforce` 让步给参数，`tighten` 让步给自身。**

## 三、入口锚点

| 锚点 | 说明 |
|---|---|
| `rendering/object.dart:902` | `abstract class Constraints`，只有 `isTight` / `isNormalized` / `debugAssertIsValid` |
| `rendering/box.dart:100` | `class BoxConstraints extends Constraints` |
| `rendering/box.dart:169-182` | 四个字段：`minWidth` / `maxWidth` / `minHeight` / `maxHeight` |
| `rendering/box.dart:222` | `enforce(BoxConstraints)`，五个派生方法里最常用的一个 |
| `rendering/box.dart:234` | `tighten({width, height})` |
| `rendering/box.dart:263-292` | `constrainWidth` / `constrainHeight` / `constrain`，硬夹取 |
| `rendering/box.dart:370-377` | `hasTightWidth` / `hasTightHeight` / `isTight` |
| `rendering/box.dart:386-414` | `hasBoundedWidth` / `hasInfiniteWidth`（注意语义差异） |

表中只列追这条链的主入口；其余锚点随第四、六节的正文就近给出，不重复列。

## 四、调用链

### 4.1 `Constraints` 基类小到只有三个成员

```dart
// rendering/object.dart:902-911
@immutable
abstract class Constraints {
  const Constraints();
  bool get isTight;
  bool get isNormalized;
}
```

`isTight` 是唯一一个被框架逻辑真正使用的：`RenderObject.layout` 里 `constraints.isTight` 直接参与 `_isRelayoutBoundary` 的判定（`object.dart:2847`）。**约束是不是 tight，决定了这个节点是不是重布局边界**——这是"约束模型"与"脏传播"两件事唯一的直接接口。

`isNormalized` 和 `debugAssertIsValid` 只在断言里用，属于"把错误讲清楚"的范畴。

### 4.2 四个字段与三种「松紧」

`BoxConstraints` 的全部状态就是四个 double：

```dart
// rendering/box.dart:169-182
final double minWidth;    // 可能为 0，可能为 double.infinity
final double maxWidth;    // 可能为 double.infinity
final double minHeight;
final double maxHeight;
```

由此派生出三组正交的属性，**它们经常被混用，但语义完全不同**：

| 属性 | 定义（源码） | 含义 |
|---|---|---|
| `hasTightWidth` | `minWidth >= maxWidth`（`:370`） | 宽度只有一个解 |
| `isTight` | `hasTightWidth && hasTightHeight`（`:377`） | 尺寸只有一个解 |
| `hasBoundedWidth` | `maxWidth < double.infinity`（`:386`） | 宽度**有上界** |
| `hasInfiniteWidth` | `minWidth >= double.infinity`（`:410`） | 宽度被**强制为无限**（`expand` 那种） |

`hasBoundedWidth == false` 和 `hasInfiniteWidth == true` **不是同一件事**。对照下面两组：

```text
BoxConstraints()             minW=0.0   maxW=Infinity  hasBoundedW=false  hasInfiniteW=false
BoxConstraints.expand()      minW=Infinity maxW=Infinity hasBoundedW=false hasInfiniteW=true
```

默认构造的 `BoxConstraints()` 是"**无上界但也不是无限**"（可以理解为"任意有限值"），而 `expand()` 是"**必须是无限大**"。很多"判断约束是否无限"的代码写成了 `!constraints.hasBoundedWidth`，那会把默认的无约束也判成无限，进而误判出"这里会崩"。

另一个反直觉的结果：**`BoxConstraints.expand().isTight` 是 `true`**。因为它四个字段都是 `double.infinity`，满足 `minWidth >= maxWidth`。所以"tight 意味着尺寸是有限确定值"是错的——tight 只意味着**唯一**，唯一的值可以是 infinity。

三种常用构造对照：

| 构造 | min | max | 典型语义 |
|---|---|---|---|
| `BoxConstraints()` | 0 / 0 | ∞ / ∞ | 完全不限制（`unconstrained`） |
| `BoxConstraints.loose(size)`（`:145`） | 0 / 0 | size 的宽高 | "最多这么大" |
| `BoxConstraints.tight(size)`（`:110`） | size 的宽高 | size 的宽高 | "必须这么大" |
| `BoxConstraints.tightFor(width: w)`（`:123`） | w 或 0 | w 或 ∞ | 给了就 tight，没给就不限 |
| `BoxConstraints.tightForFinite(width: w)`（`:136`） | w 或 0 | w 或 ∞ | **w 为 ∞ 时退化为"不限"** |
| `BoxConstraints.expand()`（`:155`） | ∞ / ∞ | ∞ / ∞ | 尽可能大（撑满） |

**注意 `tightFor(width: double.infinity)` 和 `tightForFinite(width: double.infinity)` 的结果完全不同**：前者给 `minWidth = infinity`（`isTight = false` 是因为高度不限），后者输出 `BoxConstraints(unconstrained)`。这个差异在 `box.dart:120-142` 的文档注释里写明了，但很容易看漏。

### 4.3 `constrain`：约束是硬契约

```dart
// rendering/box.dart:263-292（节选）
double constrainWidth([double width = double.infinity]) {
  assert(debugAssertIsValid());
  return clampDouble(width, minWidth, maxWidth);      // 硬夹取，没有例外
}
double constrainHeight([double height = double.infinity]) => ...;   // 同上
Size constrain(Size size) =>
    Size(constrainWidth(size.width), constrainHeight(size.height));
```

三个观察：

1. **默认参数是 `double.infinity`**。所以 `constrainWidth()` 不传参时返回 `maxWidth`——这就是 `biggest`（`:364`）和 `smallest`（`:367`，传 `0.0`）的实现方式。
2. **`clampDouble` 来自 `dart:ui`，不是框架自己写的**。`box.dart` 通过 `import 'package:flutter/foundation.dart'` 拿到它，而 `foundation/binding.dart:35` 那行 `export 'dart:ui' show PlatformDispatcher, SingletonFlutterWindow, clampDouble;` 才是真正的来源。所以这个夹取函数运行在引擎侧。
3. **`constrain` 的宽度和高度是独立的**，不保持宽高比。要保持宽高比得用 `constrainSizeAndAttemptToPreserveAspectRatio`（`:317`），它按"先满足上界、再满足下界"的顺序调整。

验收标准是 `isSatisfiedBy`：

```dart
// rendering/box.dart:428-435
bool isSatisfiedBy(Size size) {
  assert(debugAssertIsValid());
  return (minWidth <= size.width) && (size.width <= maxWidth) &&
      (minHeight <= size.height) && (size.height <= maxHeight);
}
```

这条检查在 debug 模式下由 `RenderBox.debugAssertDoesMeetConstraints`（`box.dart:2561`）自动执行，失败会直接抛 `FlutterError`。所以"约束是硬契约"不是文档承诺，是有断言兜底的。

### 4.4 五个"变换约束"的方法：语义表

这五个方法最容易混，它们都是"在不改变已有含义的前提下派生出新约束"，但**谁让步、谁不变**各不相同：

| 方法 | 位置 | 做什么 | 谁让步 | 典型调用方 |
|---|---|---|---|---|
| `enforce(outer)` | `:222` | 把自身四个字段 clamp 到 `outer` 的区间内 | **自身** | `RenderConstrainedBox`（`proxy_box.dart:296`） |
| `tighten({width, height})` | `:234` | 把指定维度收成 tight，值 clamp 到自身区间 | 参数愿望 | 需要"给定宽但保持自身范围"的场景 |
| `deflate(edges)` | `:200` | 四个字段都减去边距，min 用 `math.max(0, ...)` 兜底 | 自身缩水 | `RenderPadding`（`shifted_box.dart:261`） |
| `loosen()` | `:215` | 只保留 max，min 归零 | 自身放松 | "最多这么大"的场景 |
| `flipped` | `:244` | 宽高字段互换 | 无 | 把水平约束当垂直用（`_AxisSize.applyConstraints`） |

三个例子的输出最能说明问题：

```text
c = BoxConstraints(100<=w<=200, 0<=h<=50)

c.enforce(BoxConstraints(10<=w<=80, 10<=h<=80))
  → BoxConstraints(w=80.0, 10.0<=h<=50.0)      // 100 被夹到 80，0 被夹到 10

c.tighten(width: 500)  → BoxConstraints(w=200.0, 0.0<=h<=50.0)   // 想要 500 只给 200
c.tighten(width: 150)  → BoxConstraints(w=150.0, 0.0<=h<=50.0)   // 150 在区间内，直接给

c.deflate(EdgeInsets.symmetric(horizontal: 20, vertical: 10))
  → BoxConstraints(60.0<=w<=160.0, 0.0<=h<=30.0)   // 减 40/20，min 不低于 0
```

`deflate` 里的两处 `math.max` 是防负数用的：`minWidth - horizontal` 可能变成负数，约束不允许负的 min，所以夹到 0；`maxWidth - horizontal` 也不能小于新的 min（`box.dart:208`）。

### 4.5 `RenderConstrainedBox`：`enforce` 的唯一常规调用点

`SizedBox` 和 `ConstrainedBox` 两个 Widget 最终都产出同一个 RenderObject：

```dart
// rendering/proxy_box.dart:293-301
@override
void performLayout() {
  final BoxConstraints constraints = this.constraints;                 // 1. 父给我的约束
  if (child != null) {
    child!.layout(_additionalConstraints.enforce(constraints), parentUsesSize: true);  // 2. 求交后向下传
    size = child!.size;                                                // 3. 尺寸向上：我的尺寸 = 子的尺寸
  } else {
    size = _additionalConstraints.enforce(constraints).constrain(Size.zero);
  }
}
```

**这三行就是"约束向下、尺寸向上"的完整实现**：

- 第 2 步 `_additionalConstraints.enforce(constraints)`：先按自己的意愿（`additionalConstraints`）构造约束，再用父给的约束把它夹回去。**这一行保证了"子不会违反祖辈的约束"**。
- 第 2 步的 `parentUsesSize: true`：因为第 3 步要读 `child.size`。少写这个参数，debug 模式下 `child.size` 的 getter 会直接抛异常。
- 第 3 步 `size = child!.size`：尺寸向上。

`RenderConstrainedBox` 的 `performLayout` **没有调 `size = constraints.constrain(...)`**，而是直接用子的尺寸。这是合法的，因为子已经在这个约束下算过尺寸了（第 2 步传的就是 `enforce` 后的约束），子的尺寸必然满足父的约束。这一步的"正确性"是链条式传递的。

也正因为第 2 步是 `enforce`，**`SizedBox` 无法突破父给的 tight 约束**。三组对照如下：

```text
父给 tight 300x300，SizedBox(width: 100, height: 100)
  → 传给孩子的约束 = BoxConstraints(w=300.0, h=300.0)     // 100 被夹成 300
父给 tight 300x300，SizedBox(height: 100)
  → 传给孩子的约束 = BoxConstraints(w=300.0, h=300.0)     // 宽本来就来自父，高也被夹
父给 loose 300x300，SizedBox(height: 100)
  → 传给孩子的约束 = BoxConstraints(0.0<=w<=300.0, h=100.0)   // 这次 height 生效了
```

**这就是"SizedBox 有时不生效"的全部原因**：`SizedBox` 并没有被忽略，只是 `enforce` 把它的愿望夹掉了。父的约束是 tight 时，子没有任何自由；父的约束是 loose 时，`SizedBox` 的 tight 意愿才能生效。

对比 `RenderProxyBoxMixin.performLayout`（`proxy_box.dart:116-121`），它连约束都不改：

```dart
// rendering/proxy_box.dart:116-121
void performLayout() {
  size = (child?..layout(constraints, parentUsesSize: true))?.size ??
      computeSizeForNoChild(constraints);
  return;
}
```

`RenderProxyBox` 的 `setupParentData` 则**故意不用 `BoxParentData`**（`proxy_box.dart:68-74`，代码见实验 5）——它和子完全重合、用不上 `offset`，只分配最轻的 `ParentData()`。所以"所有 box 的孩子都有 `BoxParentData`"是错的：只有像 `RenderPadding` / `RenderStack` 这种会挪动子的父才需要它。

### 4.6 归一化：非法的约束是"可以构造出来"的

`BoxConstraints` 允许 `minWidth > maxWidth` 这种非法状态被构造出来（只有 debug 下的 assert 拦）。`normalize()` 是修复方法：

```dart
// rendering/box.dart:627-641（节选）
BoxConstraints normalize() {
  if (isNormalized) {
    return this;
  }
  final double minWidth = this.minWidth >= 0.0 ? this.minWidth : 0.0;   // 负 min 归零
  return BoxConstraints(
    minWidth: minWidth,
    maxWidth: minWidth > maxWidth ? minWidth : maxWidth,     // 用 min 抬高 max
    ...                                                       // 高度同理
  );
}
```

修复策略是"**抬 max 去迁就 min**"，不是"压 min 去迁就 max"。例如：

```text
BoxConstraints(minWidth: 100, maxWidth: 90).normalize()
  → BoxConstraints(w=100.0, 0.0<=h<=Infinity)
```

`isNormalized` 的判断（`:538`）是 `minWidth >= 0 && minWidth <= maxWidth && minHeight >= 0 && minHeight <= maxHeight`——**负的 min 也算不归一化**。

框架里几乎所有 `BoxConstraints` API 都假设输入是归一化的（`box.dart:534-536` 的文档原话："Most of the APIs on BoxConstraints expect the constraints to be normalized and have undefined behavior when they are not"）。所以自定义 `RenderBox` 里如果要构造新约束，用 `enforce` / `tighten` / `deflate` 派生比自己拼四个字段更安全——这三个方法都保证输出归一。

## 五、核心对象：三组对比

| | `Constraints`（基类） | `BoxConstraints` | `SliverConstraints` |
|---|---|---|---|
| 规模 | 3 个成员 | 4 个 double + 20 多个方法 | 十多个字段 |
| `isTight` 的含义 | 抽象 | 宽高都只有一个解 | `SliverConstraints` 里语义不同 |
| 是否有 `constrain` | **没有**（不定义尺寸概念） | 有，尺寸是 `Size` | 无，产出 `SliverGeometry` |
| 谁来 new | — | 几乎所有 box 父节点 | `RenderViewport` |

| | `enforce` | `tighten` |
|---|---|---|
| 参数 | 另一个 `BoxConstraints` | `width` / `height` 可选 |
| 作用 | 用参数的区间夹自身 | 用自身的区间夹参数 |
| 结果是否 tight | 只对"被夹到同一点"的维度变 tight | 指定维度一定变 tight |
| 谁让步 | 自身 | 参数 |
| 典型调用 | `RenderConstrainedBox.performLayout` | 需要"尽可能给指定宽"时 |

| | `deflate` | `loosen` |
|---|---|---|
| 输入 | `EdgeInsetsGeometry` | 无 |
| 对 min 的影响 | 减边距后不小于 0 | 归零 |
| 对 max 的影响 | 减边距后不小于新 min | 不变 |
| 用途 | Padding / Border 的"减去占用" | "子最多和我一样大，但可以更小" |

## 六、源码实验

### 实验 1：`constrain` 的两个方向

```dart
const BoxConstraints c = BoxConstraints(minWidth: 100, maxWidth: 200, minHeight: 0, maxHeight: 50);
debugPrint('${c.constrain(const Size(300, 300))}');   // Size(200.0, 50.0)
debugPrint('${c.constrain(const Size(10, 10))}');     // Size(100.0, 10.0)
```

**预测**：给大了应该被压到 max，给小了应该被抬到 min。

**实际**：第一行两个维度都被压到上界；第二行的宽被抬到 100，高保持 10。

**说明**：第二行是高方向**没被抬**的例子——`minHeight` 是 0，10 本来就在区间内。所以 `constrain` 的结果**不一定等于 `biggest` 也不一定等于 `smallest`**，只是"被夹进区间"。

### 实验 2：`isTight`、`hasBoundedWidth`、`hasInfiniteWidth` 三者的关系

```dart
const BoxConstraints un = BoxConstraints();
const BoxConstraints exp = BoxConstraints.expand();
debugPrint('un:  minW=${un.minWidth} maxW=${un.maxWidth} '
    'hasBoundedW=${un.hasBoundedWidth} hasInfiniteW=${un.hasInfiniteWidth} isTight=${un.isTight}');
debugPrint('exp: minW=${exp.minWidth} maxW=${exp.maxWidth} '
    'hasBoundedW=${exp.hasBoundedWidth} hasInfiniteW=${exp.hasInfiniteWidth} isTight=${exp.isTight}');
debugPrint('${const BoxConstraints(minHeight: double.infinity).biggest}');
```

**预测**：`hasInfiniteWidth` 应该等价于 `!hasBoundedWidth`（"无上界"就是"无限"）。

**实际**：

```text
un:  minW=0.0      maxW=Infinity  hasBoundedW=false  hasInfiniteW=false  isTight=false
exp: minW=Infinity maxW=Infinity  hasBoundedW=false  hasInfiniteW=true   isTight=true
minHeight=infinity 的 biggest = Size(Infinity, Infinity)
```

**说明**：两者独立。`maxWidth = infinity` 时 `hasBoundedWidth` 为 false，但 `hasInfiniteWidth` 也是 false——因为后者判断的是 `minWidth >= double.infinity`，即"**min 已经是无穷大，没得选**"（`box.dart:410`）。默认构造的 `BoxConstraints()` 是"无上界但可以取任意有限值"。

顺带一个反直觉结论：**`BoxConstraints.expand().isTight` 是 `true`**（四个字段都是 infinity，满足 `minWidth >= maxWidth`）。所以 tight 只意味着"唯一"，不意味着"有限"。

### 实验 3：`tightFor` 与 `tightForFinite` 在 `infinity` 上的分歧

```dart
const BoxConstraints a = BoxConstraints.tightFor(width: double.infinity);
const BoxConstraints b = BoxConstraints.tightForFinite(width: double.infinity);
debugPrint('a: minW=${a.minWidth} maxW=${a.maxWidth} hasInfiniteW=${a.hasInfiniteWidth} isTight=${a.isTight}');
debugPrint('b: minW=${b.minWidth} maxW=${b.maxWidth} hasInfiniteW=${b.hasInfiniteWidth}');
```

**预测**：两个构造名字只差一个后缀，传 `infinity` 的行为应该接近。

**实际**：

```text
a (tightFor):       minW=Infinity  maxW=Infinity  hasInfiniteW=true  isTight=false
b (tightForFinite): minW=0.0       maxW=Infinity  hasInfiniteW=false
```

**说明**：`tightForFinite`（`box.dart:136`）的三元判断是 `width != double.infinity ? width : 0.0`，所以传 `infinity` 会**退化成完全无约束**（`toString` 打出来就是 `BoxConstraints(unconstrained)`）。`tightFor(width: infinity)` 则把宽度设成 tight 的 infinity，而 `isTight` 仍为 false——因为高度没设，`hasTightHeight` 为 false。**这是"isTight 要求两个维度都 tight"的实证。**

### 实验 4：`enforce` 与 `tighten` 的让步方向

```dart
const BoxConstraints c = BoxConstraints(minWidth: 100, maxWidth: 200, minHeight: 0, maxHeight: 50);
debugPrint('${c.enforce(const BoxConstraints(minWidth: 10, maxWidth: 80, minHeight: 10, maxHeight: 80))}');
debugPrint('${c.tighten(width: 500)}');
```

**预测**：两者都应该把宽度变成某个确定值，可能相同。

**实际**：

```text
c.enforce(...)         → BoxConstraints(w=80.0, 10.0<=h<=50.0)     // 结果 80 = 对方的 maxWidth
c.tighten(width: 500)  → BoxConstraints(w=200.0, 0.0<=h<=50.0)     // 结果 200 = 自身的 maxWidth
```

**说明**：`enforce` 里 `minWidth` 被夹到 80，`maxWidth` 也被夹到 80，于是宽度变成 tight 的 80——**它的 tight 效果是"被对方的区间夹出来的"**。而 `tighten` 的 tight 效果是"主动收成一个点，但值选自自身的区间"。两者都能产出 tight 约束，方向相反。

### 实验 5：`RenderProxyBox` 不分配 `BoxParentData`

```bash
cd /Users/hax/fvm/default/packages/flutter/lib/src/rendering
sed -n '1572,1578p' box.dart        # RenderBox 基类版本
sed -n '66,74p' proxy_box.dart      # RenderProxyBoxMixin 覆盖版本
```

**预测**：既然 `BoxParentData` 只比 `ParentData` 多一个 `Offset`，"所有 box 父节点都分配 `BoxParentData`"最省事。

**实际**：两个版本共存，选的是不同的类：

```dart
// rendering/box.dart:1573-1578（RenderBox 基类）
void setupParentData(covariant RenderObject child) {
  if (child.parentData is! BoxParentData) {
    child.parentData = BoxParentData();
  }
}
```

```dart
// rendering/proxy_box.dart:68-74（RenderProxyBoxMixin 覆盖）
void setupParentData(RenderObject child) {
  // We don't actually use the offset argument in BoxParentData, so let's
  // avoid allocating it at all.
  if (child.parentData is! ParentData) {
    child.parentData = ParentData();
  }
}
```

**说明**：`parentData` 的类型是**按需要**选择的。`RenderProxyBox` 和子完全重合、用不上 `offset`，所以只分配最轻的 `ParentData`。这对写自定义 `RenderBox` 有直接影响：如果你的父节点会挪动子（写 `offset`），就必须重写 `setupParentData` 分配 `BoxParentData`，否则 `child.parentData as BoxParentData` 会在运行期抛类型错误。

## 七、结论

1. `BoxConstraints` 的状态是**两个区间**（宽一个、高一个），不是尺寸。`constrain` 做硬性 `clampDouble` 夹取；`isSatisfiedBy`（`box.dart:428`）是验收标准，debug 下由 `debugAssertDoesMeetConstraints`（`box.dart:2561`）自动执行——所以"约束是硬契约"有断言兜底，不是文档承诺。
2. 五个派生方法各有让步方向：`enforce` 自身让步给参数（用于 `RenderConstrainedBox`），`tighten` 让参数让步给自身，`deflate` 减边距且 min 不低于 0（用于 `RenderPadding`），`loosen` 只保留上界，`flipped` 交换宽高。选择哪一个取决于"谁的意愿优先"。
3. `hasTightWidth`（`isTight`）、`hasBoundedWidth`、`hasInfiniteWidth` 是三个**互不蕴含**的属性：`BoxConstraints()` 是"无上界但非无限"（`hasBoundedWidth=false` 且 `hasInfiniteWidth=false`），`BoxConstraints.expand()` 是"强制无限且 tight"（两者分别 true / `isTight=true`）。

**约束是父给子的硬性区间，子只能在这个区间里选一个值；`enforce` / `tighten` / `deflate` 的区别就是"谁向谁让步"。**

## 八、边界声明

- 本文只讲 box 协议的约束。`SliverConstraints` 与 `SliverGeometry` 是另一套（尺寸向上传的是 `SliverGeometry` 而非 `Size`），留给第十卷视口篇。
- 约束如何影响 `relayoutBoundary` 的判定只讲了 `constraints.isTight` 这一句，完整判定与脏传播在 32 篇。
- 内在尺寸（`computeMinIntrinsicWidth` 等）与 `computeDryLayout` 的完整体系不在本文展开，只在 `RenderConstrainedBox` 一节提到。
- `RenderPadding` 的完整实现（`shifted_box.dart`）不在本文展开，只借用它的 `deflate` 调用点。
- 本文聚焦约束对象的语义表，不展开具体布局现象。
