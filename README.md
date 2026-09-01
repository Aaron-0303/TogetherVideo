# TogetherVideo 4.0

只供两个人使用的固定房间同步观影网站。

TogetherVideo 的核心原则是：**同步控制，不同步媒体线路。** 两个人共享当前视频、播放 / 暂停、跳转目标、正式倍速和房间权威时间线；浏览器缓存、Range 请求、CDN 连接、临时签名 URL、网络速度和解码状态则完全独立。

服务器不会代理、缓存或转码视频正文。服务端只负责 WebDAV 元数据、123 临时播放地址发现、房间状态和同步控制；真正的视频数据始终由 123 云盘 / CDN 直接发送到每一个浏览器。

## 4.0：全新前端

4.0 对前端界面进行了完整重设计，但不改变已经稳定的媒体和同步架构。

主要变化：

- 全新的统一视觉设计，不再使用旧版顶部栏、卡片、状态 pill 混搭布局
- 支持 **明亮 / 黑暗** 两套完整主题
- 主题选择保存在浏览器本地；没有手动选择时跟随系统主题
- 桌面端采用统一侧栏 + 播放器工作区
- 移动端片库变成抽屉式侧栏
- 播放器成为页面唯一视觉中心
- “自己 / 对方”整合为同一个观看状态区域，明确表达“控制同步、媒体独立”
- WebDAV 与站点密码设置重新设计为统一设置面板
- ArtPlayer 继续作为播放器 UI

主题切换只影响界面，不会重建播放器、重新获取视频地址或改变房间同步状态。

## 播放器与媒体结构

4.0 使用 **ArtPlayer 5.4.0** 作为播放器 UI，底层仍由浏览器原生 `HTMLVideoElement` 解码。Service Worker 负责 123 临时直链、Range 和 MIME 兼容处理。

```text
                    TogetherVideo Server
                           │
                    Socket.IO 控制同步
                           │
              ┌────────────┴────────────┐
              │                         │
          Browser A                 Browser B
              │                         │
          ArtPlayer                 ArtPlayer
              │                         │
      HTMLVideoElement          HTMLVideoElement
              │                         │
       Service Worker            Service Worker
              │                         │
         Range A                    Range B
              │                         │
          123 CDN A                 123 CDN B
```

两个人共享：

```text
当前视频
播放 / 暂停
跳转目标
正式倍速
房间权威时间线
```

两个人不共享：

```text
浏览器缓存
Range 请求
CDN 连接
临时签名 URL
下载速度
网络状态
解码状态
```

因此 **A 缓冲不会让 B 暂停，B 缓冲也不会阻塞 A。**

## 同步原则

### 播放 / 暂停

播放和暂停是房间级同步操作。

```text
A 点击暂停
    ↓
player:pause
    ↓
TogetherVideo Server
    ↓
room:state
   ↙     ↘
A pause  B pause
```

播放时服务器会给两个浏览器一个很短的共同 `startAt`，默认只预留约 500 ms 的控制传播时间。这个时间用于尽量让两边同时开始，而不是等待缓存。

如果某一端网络慢，它只会在自己的播放器里短暂缓冲，不会把另一端一起锁住。

### 拖动进度条

拖动相当于 **两个用户同时把各自的进度条拖到同一个位置**：

```text
A 拖到 30:00
      ↓
服务器广播目标 30:00
      ↓
┌─────────────────┬─────────────────┐
│ Browser A       │ Browser B       │
│ currentTime=30m │ currentTime=30m │
│ 自己请求 Range   │ 自己请求 Range   │
│ 自己加载         │ 自己加载         │
└─────────────────┴─────────────────┘
      ↓
短暂共同 startAt
      ↓
各自继续播放
```

不会等待双方 `ready`，也不会比较两边 buffer 大小。

如果拖动前房间处于暂停状态，则两边只同步到目标位置并保持暂停。

### 缓冲

缓冲是每个浏览器自己的状态。

```text
A 网络正常                B 网络较慢
A 正常播放                B waiting / stalled
     │                         │
     │                         └─ UI 显示“对方正在缓冲”
     │
     └─ 不暂停、不 seek、不等待 B
```

`presence:buffering` 只用于状态展示，不会触发房间暂停或重新定位。

### 后进入房间

第二个人进入已经播放中的房间时，不会暂停第一个人：

```text
A 正在播放
    ↓
B 上线
    ↓
A 继续播放
B 读取当前权威时间线
    ↓
B 自己加载并进入当前播放位置
```

### 漂移与重新同步

客户端会低频测量房间时间线，用于显示明显差值，但：

```text
不使用临时倍速追赶
不因为轻微偏差频繁 seek
不因为漂移自动暂停双方
```

只有用户主动点击 **重新同步** 时，才执行一次轻量对齐：

```text
重新同步
   ↓
服务器确定当前权威时间点
   ↓
A / B currentTime = target
   ↓
短暂 startAt
   ↓
两边各自播放
```

目标是观感同步，而不是强制两个浏览器的网络和缓存每一刻都完全一致。

## Service Worker / 123 Range

播放器始终使用站内逻辑地址：

```text
/api/media?path=xxx.mp4
```

服务端通过 WebDAV 找到浏览器可以直接访问的 123 临时 CDN 地址并返回重定向，视频正文不经过 Node 服务。

Service Worker 在浏览器本地完成媒体兼容处理：

```text
播放器 Range 请求
      ↓
限制为有界 Range（最大约 16 MiB）
      ↓
不转发旧 If-Range
      ↓
123 CDN
      ↓
必须得到 206 Partial Content + Content-Range
      ↓
必要时修正：
application/octet-stream → video/mp4
attachment → inline
      ↓
原生 HTMLVideoElement
```

如果临时 CDN 地址失效或 Range 响应异常，会重新解析地址后重试，而不是让服务器代理视频正文。

## 当前代码结构

```text
server.js
  ├─ 启动 / Session / 静态资源 / 生命周期
  ├─ src/http-routes.js       HTTP API / 媒体地址解析
  ├─ src/socket-gateway.js    Socket.IO 事件入口
  ├─ src/room-coordinator.js  双人控制同步 / 短 startAt
  ├─ src/watch-room.js        唯一权威播放时间线
  ├─ src/media-service.js     片库、直链解析与媒体探测
  ├─ src/webdav.js            WebDAV 协议与认证重定向
  ├─ public/index.html        4.0 页面结构
  ├─ public/styles.css        4.0 明亮 / 黑暗设计系统
  ├─ public/ui-shell.js       主题与界面壳层交互
  ├─ public/artplayer-media.js ArtPlayer 与原生 video 适配
  ├─ public/media-transport.js Service Worker 启动时序
  └─ public/sw.js             浏览器本地媒体桥
```

`WatchRoom` 保存当前媒体、位置、播放状态、正式倍速和权威时间线。

`RoomCoordinator` 只负责控制同步，不会把一端的 buffering 变成另一端的暂停事件。

## 视频数据链路

```text
Browser A ─────────────────────────────→ 123 CDN
    │                                      ↑
    │ Socket.IO 控制                        │ Range A
    ↓                                      │
TogetherVideo Server                       │
    ↑                                      │
    │ Socket.IO 控制                        │
    │                                      │
Browser B ─────────────────────────────→ 123 CDN
                                           ↑
                                         Range B
```

服务器不会：

- pipe 视频正文
- 代理视频 Range
- 缓存视频数据
- 实时转码

每个浏览器拥有自己的媒体线路和临时 CDN 连接。

## WebDAV 设置

首次进入网站后打开 **设置**，填写：

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

浏览器不会把 WebDAV 用户名和密码直接放进 `<video src>`。服务端使用认证信息进行目录读取和小型探测，并找到最终浏览器可访问的临时 CDN 地址。

如果 WebDAV 只能返回“必须携带 Basic Auth 才能下载正文”的地址，而没有匿名 / 签名临时 URL，TogetherVideo 会拒绝把视频正文变成服务端代理流。

## 视频兼容建议

TogetherVideo 不做服务器实时转码，因此最终播放兼容性取决于容器、视频编码、像素格式、音频编码和浏览器设备。

最稳妥的通用格式：

```text
容器：MP4
视频：H.264 / AVC
Profile：Main 或 High
位深：8-bit
像素格式：yuv420p
音频：AAC-LC
Fast Start：开启
```

即：

```text
MP4 + H.264 8-bit yuv420p + AAC-LC + faststart
```

### 检查媒体

```powershell
ffprobe -hide_banner "input.mp4"
```

重点查看：

```text
Video: h264 / hevc / av1 / vp9 ...
codec_tag_string=hvc1 / hev1 ...
pix_fmt=yuv420p / yuv420p10le / yuv422p ...
Audio: aac / ac3 / eac3 / dts / truehd ...
```

### HEVC / H.265

Apple 设备可以原生播放很多 HEVC。MP4 中推荐 `hvc1`。

如果是 `hev1`，可以先尝试无损重封装：

```powershell
ffmpeg -i "input.mp4" `
  -map 0:v:0 -map "0:a?" `
  -c copy `
  -tag:v:0 hvc1 `
  -movflags +faststart `
  "output.hvc1.mp4"
```

如果仍不能播放，再转成 H.264 + AAC。

### 通用 H.264 转换

CPU：

```powershell
ffmpeg -i "input.mkv" `
  -map 0:v:0 -map "0:a:0?" `
  -c:v libx264 `
  -preset medium `
  -crf 18 `
  -profile:v high `
  -pix_fmt yuv420p `
  -c:a aac `
  -b:a 192k `
  -ac 2 `
  -movflags +faststart `
  "output.web.mp4"
```

NVIDIA NVENC：

```powershell
ffmpeg -i "input.mkv" `
  -map 0:v:0 -map "0:a:0?" `
  -c:v h264_nvenc `
  -preset p5 `
  -tune hq `
  -rc vbr `
  -cq 18 `
  -b:v 0 `
  -profile:v high `
  -pix_fmt yuv420p `
  -c:a aac `
  -b:a 192k `
  -ac 2 `
  -movflags +faststart `
  "output.web.mp4"
```

只修改文件后缀没有用，容器和编码必须真的兼容浏览器。

## 部署

需要 Node.js 20+：

```bash
git pull
npm install
npm start
```

4.0 继续使用 `artplayer@5.4.0`。生产环境建议使用 HTTPS，并由 Nginx / Caddy / 宝塔反向代理到 Node 服务。Service Worker 在公网环境需要安全上下文，因此不要直接使用普通 HTTP 域名。

升级 4.0 后建议两个浏览器至少强制刷新一次。如果浏览器仍然运行旧媒体脚本，可以在开发者工具中注销旧 Service Worker 后重新打开页面。

## 4.0 总结

```text
UI：全新设计系统 + 明亮 / 黑暗主题
播放器：ArtPlayer 5.4.0
播放：同步控制 + 短 startAt
暂停：双方同步暂停
拖动：双方到同一目标，各自独立加载
缓冲：谁卡谁自己缓冲
后加入：不打断正在播放的人
漂移：只提示，不自动 seek
重新同步：手动轻量对齐
视频正文：123 CDN → Browser
服务器代理视频：禁止
```

**控制需要同步，媒体线路必须独立；观感优先于数学意义上的绝对重合。**
