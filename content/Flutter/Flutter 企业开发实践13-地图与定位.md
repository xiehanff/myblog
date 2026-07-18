---
title: Flutter 企业开发实践13-地图与定位
date: 2026-05-18
tags: [Flutter, 面试, 架构, 地图, 定位, 高德, 百度, 后台定位, 权限]
---

# 地图与定位

> 地图和定位是 O2O、出行、物流、社交类 App 的基础能力。但"接入地图 SDK"远不止调起定位——双端权限差异、后台定位保活、坐标系转换、隐私合规，每一环都是面试追问的切入点。本篇从架构师视角拆解地图定位的工程全链路。

---

## 概述：地图与定位解决什么问题？

地图定位解决的核心问题是：**让 App 知道用户在哪里，以及在地图上呈现与位置相关的信息。** 看似简单，但工程落地时面临以下挑战：

1. **双端权限体系完全不同**：Android 前台/后台定位权限分离，iOS Always/WhenInUse 语义差异大
2. **坐标系不统一**：WGS84（GPS 原始）、GCJ02（国测局/高德/腾讯）、BD09（百度）三种坐标系并存
3. **后台定位受严格限制**：Android 后台定位需 Foreground Service，iOS Always 需额外审核
4. **定位精度与耗电极限**：高精度定位（GPS）耗电是网络定位的 5-10 倍
5. **隐私合规**：定位是敏感权限，过度使用会被审核拒绝

---

## 核心内容

### 1. 高德/百度地图 SDK 接入

#### 为什么选高德或百度？

国内地图 SDK 只有三个选择：高德、百度、腾讯。其中腾讯地图在 2022 年已停止对个人开发者的部分服务支持，实际选择主要在高德和百度之间。

| 维度 | 高德 | 百度 |
|------|------|------|
| 坐标系 | GCJ02 | BD09（百度偏移） |
| 定位精度 | 高 | 高 |
| SDK 体积 | ~2MB（定位）+ ~5MB（地图） | ~3MB（定位）+ ~8MB（地图） |
| Flutter 插件 | amap_flutter_map / amap_flutter_location | flutter_bmflocation / flutter_bmfmap |
| 官方维护 | 较活跃 | 一般 |
| 免费配额 | 日均 30 万次 | 日均 30 万次 |
| 路径规划 | 支持 | 支持 |
| 海外支持 | 弱 | 弱 |

#### 关键选型因素：坐标系

**高德用 GCJ02，百度用 BD09。** 这不是简单的偏移量差异，而是两个完全不同的坐标系体系。一旦选了百度，所有坐标数据都存储 BD09，与其他系统（如服务端、第三方数据）对接时需要频繁转换。

**架构决策**：如果项目需要与服务端/第三方系统交换坐标数据，优先选高德（GCJ02 是国内事实标准），减少坐标转换。如果项目高度依赖百度的 POI 数据或路网数据，则选百度。

#### Flutter 侧接入

```dart
// 高德地图初始化
class AMapService {
  static Future<void> init({required String androidKey, required String iosKey}) async {
    await AMapFlutterMap.init(
      androidKey: androidKey,
      iosKey: iosKey,
    );
  }
}

// 高德定位初始化
class AMapLocationService {
  static Future<void> init({required String androidKey, required String iosKey}) async {
    await AMapFlutterLocation.init(
      androidKey: androidKey,
      iosKey: iosKey,
    );
    await AMapFlutterLocation.updatePrivacyShow(true, true);
    await AMapFlutterLocation.updatePrivacyAgree(true);
  }

  /// 获取当前位置
  static Future<AMapLocation?> getCurrentLocation() async {
    final result = await AMapFlutterLocation.getLocation(true);
    if (result != null && result.code == '0') {
      return AMapLocation(
        latitude: result.latLng?.latitude ?? 0,
        longitude: result.latLng?.longitude ?? 0,
        accuracy: result.accuracy ?? 0,
      );
    }
    return null;
  }
}
```

#### 隐私合规初始化

[双端] 高德 SDK 3.x 之后强制要求先设置隐私合规才能初始化：

```dart
// 必须在 SDK 初始化之前调用
await AMapFlutterLocation.updatePrivacyShow(true, true); // 展示隐私弹窗
await AMapFlutterLocation.updatePrivacyAgree(true);     // 用户同意
```

不设置这两个参数，SDK 初始化会静默失败，定位不返回数据但不报错——这是最常见的接入坑。

---

### 2. 定位权限适配

这是地图定位中最复杂的工程问题，因为 Android 和 iOS 的权限体系差异巨大。

#### Android 定位权限 [Android]

Android 10+ 将定位权限拆分为前台和后台：

| 权限 | 说明 | 申请方式 |
|------|------|---------|
| `ACCESS_FINE_LOCATION` | 精确定位（GPS） | 运行时权限 |
| `ACCESS_COARSE_LOCATION` | 粗略定位（网络/WiFi） | 运行时权限 |
| `ACCESS_BACKGROUND_LOCATION` | 后台定位 | 需先获得前台权限再单独申请 |

关键变化：
- **Android 10**：引入后台定位权限，必须单独申请
- **Android 11**：后台定位只能引导用户去系统设置中手动开启
- **Android 12**：前台定位增加"精确/大致"选项
- **Android 13**：新增 `POST_NOTIFICATIONS` 权限，Foreground Service 通知需额外授权

```dart
// Android 定位权限申请流程
class AndroidLocationPermission {
  Future<LocationPermissionResult> requestPermission() async {
    // 1. 申请前台定位权限
    var status = await Permission.location.request();
    if (status.isDenied) return LocationPermissionResult.denied;
    if (status.isPermanentlyDenied) {
      // 用户选择"不再询问"，引导去设置
      await openAppSettings();
      return LocationPermissionResult.permanentlyDenied;
    }

    // 2. 如果需要后台定位，单独申请
    if (_needBackgroundLocation) {
      var bgStatus = await Permission.locationAlways.request();
      if (bgStatus.isDenied) return LocationPermissionResult.backgroundDenied;
    }

    return LocationPermissionResult.granted;
  }
}
```

#### iOS 定位权限 [iOS]

iOS 的定位权限有两个级别：

| 权限 | 说明 | 适用场景 |
|------|------|---------|
| `whenInUse` | 使用期间 | 导航、打车 |
| `always` | 始终 | 轨迹记录、围栏通知 |

关键差异：
- **`always` 权限需要 Apple 审核理由**：必须在 `Info.plist` 中提供 `NSLocationAlwaysUsageDescription`，且 App 功能确实需要后台定位
- **iOS 13+ `always` 权限变更**：用户只能选"使用期间"或"允许一次"，"始终"选项被隐藏，需要引导用户去设置手动修改
- **`always` 实际是 `whenInUse` + 后台启动权限**：即使获得 `always` 权限，后台定位也会显示蓝条提示

```dart
// iOS 定位权限申请
class IOSLocationPermission {
  Future<LocationPermissionResult> requestPermission({bool always = false}) async {
    if (always) {
      // 先申请 whenInUse，再申请 always
      var whenInUse = await Permission.locationWhenInUse.request();
      if (whenInUse.isDenied) return LocationPermissionResult.denied;

      var alwaysStatus = await Permission.locationAlways.request();
      if (alwaysStatus.isDenied) return LocationPermissionResult.backgroundDenied;
      return LocationPermissionResult.granted;
    } else {
      var status = await Permission.locationWhenInUse.request();
      if (status.isGranted) return LocationPermissionResult.granted;
      if (status.isPermanentlyDenied) return LocationPermissionResult.permanentlyDenied;
      return LocationPermissionResult.denied;
    }
  }
}
```

#### 双端权限差异总结

| 维度 | Android | iOS |
|------|---------|-----|
| 前台定位 | 运行时申请 | 运行时申请 |
| 后台定位 | 单独权限，需引导去设置 | `always` 权限，需审核理由 |
| 权限拒收后 | 可引导去设置 | 可引导去设置 |
| 后台定位提示 | Foreground Service 通知 | 蓝条提示 |
| 精度选项 | 精确/大致（Android 12+） | 无，系统自动选择 |
| 审核风险 | 低 | 高（`always` 权限需要充分理由） |

---

### 3. 地图标注与覆盖物

#### 标注（Marker）

```dart
// 添加标注
final markers = <Marker>{
  Marker(
    position: LatLng(39.9092, 116.3974),
    infoWindow: InfoWindow(title: '天安门', snippet: '北京市东城区'),
    icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
  ),
};

AMapFlutterMap(
  markers: markers,
  onMapCreated: (controller) {
    _mapController = controller;
  },
)
```

#### 覆盖物（Overlay）

覆盖物用于在地图上绘制线、面、圆：

| 类型 | 用途 | 示例 |
|------|------|------|
| Polyline | 路线、轨迹 | 配送路线、运动轨迹 |
| Polygon | 区域 | 配送范围、电子围栏 |
| Circle | 半径范围 | 附近 X 公里 |

```dart
// 画配送范围
final polygons = <Polygon>{
  Polygon(
    points: deliveryAreaPoints,
    fillColor: Colors.blue.withOpacity(0.2),
    strokeColor: Colors.blue,
    strokeWidth: 2,
  ),
};
```

#### 性能考量

当地图上需要渲染大量标注（如周边 1000+ 个 POI）时：

1. **聚合（Clustering）**：将相近的标注合并为一个聚合点，缩放时展开
2. **视口裁剪**：只渲染当前视口范围内的标注
3. **图片缓存**：自定义 Marker 图标预渲染为 Bitmap，避免每次 `build()` 重新创建

```dart
/// 标注聚合管理器
class MarkerClusterManager {
  final List<POI> _allPois;
  final double _clusterRadius; // 聚合半径（像素）

  List<ClusterItem> cluster(CameraPosition camera) {
    // 1. 视口裁剪：只保留可见范围内的 POI
    final visiblePois = _filterByViewport(_allPois, camera);

    // 2. 按屏幕像素距离聚合
    final clusters = <ClusterItem>[];
    for (final poi in visiblePois) {
      final screenPos = _latLngToScreen(poi.latLng, camera);
      final existing = clusters.where((c) =>
        (_latLngToScreen(c.center, camera) - screenPos).distance < _clusterRadius
      );
      if (existing.isEmpty) {
        clusters.add(ClusterItem(center: poi.latLng, pois: [poi]));
      } else {
        existing.first.pois.add(poi);
      }
    }
    return clusters;
  }
}
```

---

### 4. 路径规划与导航

#### 路径规划 vs 导航

- **路径规划**：起终点 → 多条路线 → 距离/时间/费用。纯数据服务，不需要地图渲染
- **导航**：路径规划 + 实时引导（语音播报、转向提示、偏航重算）。需要完整导航 SDK

大多数 App 只需要路径规划，不需要完整导航。

#### 路径规划接入

```dart
class RouteService {
  final AMapSearch _search = AMapSearch();

  /// 驾车路径规划
  Future<List<RouteResult>> planDriveRoute({
    required LatLng origin,
    required LatLng destination,
  }) async {
    final result = await _search.driveRouteSearch(
      origin: PoiItem(latLonPoint: LatLonPoint(origin.latitude, origin.longitude)),
      destination: PoiItem(latLonPoint: LatLonPoint(destination.latitude, destination.longitude)),
    );
    return result.routes.map((r) => RouteResult(
      distance: r.distance,
      duration: r.duration,
      polyline: _decodePolyline(r.polyline),
    )).toList();
  }
}
```

#### 坐标系转换

这是路径规划中最容易出错的环节。不同数据源的坐标系可能不同：

```dart
/// 坐标系转换工具
class CoordinateConverter {
  /// WGS84 → GCJ02（GPS 原始坐标 → 高德坐标）
  static LatLng wgs84ToGcj02(LatLng wgs84) {
    return _transform(wgs84);
  }

  /// GCJ02 → BD09（高德坐标 → 百度坐标）
  static LatLng gcj02ToBd09(LatLng gcj02) {
    final x = gcj02.longitude;
    final y = gcj02.latitude;
    final z = sqrt(x * x + y * y) + 0.00002 * sin(y * pi * 3000.0 / 180.0);
    final theta = atan2(y, x) + 0.000003 * cos(x * pi * 3000.0 / 180.0);
    return LatLng(
      z * sin(theta) + 0.006,
      z * cos(theta) + 0.0065,
    );
  }

  /// BD09 → GCJ02（百度坐标 → 高德坐标）
  static LatLng bd09ToGcj02(LatLng bd09) {
    final x = bd09.longitude - 0.0065;
    final y = bd09.latitude - 0.006;
    final z = sqrt(x * x + y * y) - 0.00002 * sin(y * pi * 3000.0 / 180.0);
    final theta = atan2(y, x) - 0.000003 * cos(x * pi * 3000.0 / 180.0);
    return LatLng(
      z * sin(theta),
      z * cos(theta),
    );
  }
}
```

**架构决策**：服务端统一存储 GCJ02 坐标，客户端根据所用地图 SDK 在入口处做转换。不要在数据库中混存多种坐标系——查询时无法确定转换方向。

---

### 5. 后台持续定位与保活

#### 为什么后台定位这么难？

后台定位是所有地图定位需求中最复杂的工程问题，因为两个平台都在限制后台定位：

- [Android] 后台定位消耗电量，Google/国产 ROM 激进限制后台 Service
- [iOS] 后台定位需要 `always` 权限，且会显示蓝条提示用户

#### Android 后台定位 [Android]

**方案：Foreground Service + 通知**

```kotlin
// Android 后台定位必须使用 Foreground Service
class LocationService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 1. 创建通知渠道
        createNotificationChannel()

        // 2. 启动前台服务（必须展示通知）
        val notification = buildNotification("正在定位中...")
        startForeground(LOCATION_NOTIFICATION_ID, notification)

        // 3. 开始持续定位
        startLocationUpdates()

        return START_STICKY
    }

    private fun startLocationUpdates() {
        val locationRequest = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            5000L // 5秒更新一次
        ).build()

        val fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        fusedLocationClient.requestLocationUpdates(
            locationRequest,
            locationCallback,
            Looper.getMainLooper()
        )
    }
}
```

**关键限制**：
- 必须展示通知，用户可以随时关闭
- Android 12+ 前台服务类型需声明 `location`
- Android 14+ 前台服务类型需与权限匹配
- 部分国产 ROM（小米/OPPO）会杀 Foreground Service，需要厂商白名单

#### iOS 后台定位 [iOS]

**方案：`always` 权限 + `allowsBackgroundLocationUpdates`**

```swift
// iOS 后台定位配置
class LocationManager: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()

    func startBackgroundLocation() {
        // 1. 请求 always 权限
        manager.requestAlwaysAuthorization()

        // 2. 配置后台定位
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true // 蓝条提示

        // 3. 配置定位参数
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = 10.0 // 10米更新一次

        // 4. 开启定位
        manager.startUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        // 上报位置
        reportLocation(location)
    }
}
```

**关键限制**：
- 必须在 `Info.plist` 中添加 `UIBackgroundModes` → `location`
- 后台定位时状态栏显示蓝条，用户可以点击关闭
- `always` 权限审核时需提供充分理由
- iOS 会在状态栏提示"App 正在使用您的位置"，用户感知强

#### 降低定位频率的省电策略

```dart
/// 智能定位策略
class SmartLocationStrategy {
  LatLng? _lastLocation;
  DateTime? _lastUpdateTime;
  double _speed = 0; // m/s

  /// 计算下次定位间隔
  Duration getNextInterval() {
    if (_speed < 1) {
      // 静止：30 秒一次
      return const Duration(seconds: 30);
    } else if (_speed < 10) {
      // 步行：10 秒一次
      return const Duration(seconds: 10);
    } else if (_speed < 30) {
      // 骑行：5 秒一次
      return const Duration(seconds: 5);
    } else {
      // 驾车：2 秒一次
      return const Duration(seconds: 2);
    }
  }
}
```

---

## 常见坑与踩点

### 坑1：坐标系混用导致偏移

最经典的坑：用高德地图展示百度坐标的 POI，或者反过来。偏移通常 100-600 米，在地图上看起来点位在马路对面甚至隔了几个街区。**服务端必须统一存储一种坐标系**（推荐 GCJ02），客户端展示时按 SDK 需要转换。

### 坑2：Android 11 后台定位

[Android] Android 11 中 `ACCESS_BACKGROUND_LOCATION` 不能通过系统弹窗授予，必须引导用户去系统设置中手动开启。直接调用 `request()` 只会返回 `permanentlyDenied`。正确的做法是检测到 `permanentlyDenied` 后弹出自定义引导弹窗，用户点击后跳转系统设置。

### 坑3：iOS 模拟器定位

[iOS] iOS 模拟器默认定位在 Apple 总部（Cupertino）。调试定位功能时必须通过 Debug → Location 手动设置模拟位置或导入 GPX 文件，否则所有定位测试都在美国。

### 坑4：高德 SDK Key 配置

[双端] 高德 SDK 的 Android Key 和 iOS Key 是独立的，且 Android Key 需要绑定 SHA1 签名和包名。Debug 和 Release 签名不同，需要配置两个 Key。如果忘记配置 Release Key，打包后的 App 定位会静默失败。

### 坑5：权限申请顺序

[Android] 必须先获得前台定位权限，才能申请后台定位权限。如果先申请后台权限，系统会直接拒绝。iOS 同理，必须先申请 `whenInUse`，再申请 `always`。

---

## 面试追问

###  双端定位权限有什么差异？

Android 前台/后台定位权限是分离的——前台定位通过运行时权限申请，后台定位（Android 10+）需要单独的 `ACCESS_BACKGROUND_LOCATION` 权限，且 Android 11+ 只能引导用户去系统设置手动开启。iOS 分 `whenInUse` 和 `always` 两个级别，`always` 需要在 Info.plist 中提供使用说明且通过 Apple 审核。Android 后台定位需要 Foreground Service 并展示通知，iOS 后台定位会显示蓝条提示。

###  后台持续定位怎么做？

Android：通过 Foreground Service 实现后台定位，必须展示通知告知用户。Service 设置为 START_STICKY 保证被杀后重启。需要注意 Android 12+ 需声明前台服务类型为 `location`，Android 14+ 前台服务类型需与权限匹配。iOS：获取 `always` 权限后设置 `allowsBackgroundLocationUpdates = true`，在 Info.plist 中添加 `UIBackgroundModes` → `location`。后台定位时系统会显示蓝条提示。两个平台都需要注意省电——根据移动速度动态调整定位频率。

###  三种坐标系（WGS84/GCJ02/BD09）的区别和转换？

WGS84 是 GPS 原始坐标系，国际标准；GCJ02 是国测局加密坐标（俗称火星坐标），高德和腾讯使用；BD09 是百度在 GCJ02 基础上二次加密的坐标系。由于国家安全要求，国内地图必须使用 GCJ02 或 BD09，不能直接使用 WGS84（会偏移 100-600 米）。架构上建议服务端统一存储 GCJ02（国内事实标准），客户端根据所用地图 SDK 在入口处转换。不要混存多种坐标系。

###  地图上大量标注（1000+）怎么优化？

三层优化：1) 视口裁剪——只渲染当前可见范围内的标注，减少渲染数量；2) 标注聚合——将相近的标注合并为聚合点，缩放时展开，避免密集区域标注重叠；3) 图标缓存——自定义 Marker 图标预渲染为 BitmapDescriptor 并缓存，避免每次 build 重新创建。如果使用高德，可以用其内置的 ClusterOverlay；百度也有 ClusterManager。自己实现的话，核心算法是按屏幕像素距离做网格聚类。

###  设计一个跨平台的定位服务架构，如何处理双端权限差异和后台定位？

1. **抽象层**：Flutter 侧定义 `LocationService` 接口，统一返回 `Location` 数据模型，平台差异由实现层消化
2. **权限管理**：定义 `LocationPermissionManager`，封装双端权限申请流程——Android 区分前台/后台，iOS 区分 whenInUse/always，业务层不感知差异
3. **后台定位**：Android 用 Foreground Service + 通知，iOS 用 always 权限 + Background Mode。两端都通过 MethodChannel 上报位置，Flutter 侧通过 Stream 统一分发
4. **省电策略**：定义 `SmartLocationStrategy`，根据速度和场景动态调整定位频率（静止 30s/步行 10s/驾车 2s）
5. **坐标系统一**：服务端存储 GCJ02，客户端入口处按 SDK 类型自动转换
6. **降级方案**：GPS 不可用时降级为网络定位，定位完全不可用时使用缓存的上次位置

---

## 参考资源

- [高德地图 Flutter 插件](https://pub.dev/packages/amap_flutter_map)
- [高德定位 Flutter 插件](https://pub.dev/packages/amap_flutter_location)
- [百度地图 Flutter 插件](https://pub.dev/packages/flutter_bmfmap)
- [Android Location 官方文档](https://developer.android.com/training/location)
- [Core Location 官方文档](https://developer.apple.com/documentation/corelocation)
- [坐标转换算法详解](https://lbs.amap.com/faq/system/coordconvert)
