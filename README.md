# TogetherVideo 4.1

只供两个人使用的固定房间同步观影网站。

TogetherVideo 的核心原则是：**同步控制，不同步媒体线路。** 两个人共享当前视频、播放 / 暂停、跳转目标、正式倍速和房间权威时间线；浏览器缓存、Range 请求、CDN 连接、临时签名 URL、网络速度和解码状态完全独立。

服务器不会代理、缓存或转码视频正文。真正的视频数据始终由 123 云盘 / CDN 直接发送到每一个浏览器。

## 4.1 界面

4.1 的桌面端按“一起看”房间布局重新组织：**左侧播放器 + 右侧双 Tab 侧栏**。页面会直接占满浏览器剩余视口，不再通过固定 `max-width` 或整页 16:9 比例留下大块空白。

```text
┌──────────────────────── 顶部导航 ────────────────────────┐
│ TogetherVideo 4.1 │ 固定双人房间 │ 在线状态 │ 主题 │ 设置 │
├────────────────────────────────────────┬─────────────────┤
│ 当前视频标题                           │ 房间 | 播放列表 │
├────────────────────────────────────────┤─────────────────┤
│                                        │ 房间 Tab        │
│                                        │ - 双方成员      │
│                                        │ - 同步状态      │
│              ArtPlayer                 │ - 播放状态      │
│                                        │ - 等等我        │
│                                        │ - 重新同步      │
│                                        │ - 倍速          │
│                                        │ - 实时聊天      │
│                                        │                 │
│                                        │ 播放列表 Tab    │
│                                        │ - WebDAV 路径   │
│                                        │ - 文件夹/视频   │
│                                        │ - 当前视频高亮  │
├────────────────────────────────────────┴─────────────────┤
│ 左右两列从顶部到底部占满可用区域                         │
└──────────────────────────────────────────────────────────┘
```

界面约束：

- 播放器永远是左侧主内容
- 右侧只有两个一级入口：**房间** 和 **播放列表**
- WebDAV 媒体库直接放在“播放列表”Tab，不再使用左侧抽屉
- “房间”Tab 同时承载成员、同步、播放状态、房间控制和聊天
- 主观影区使用 `100vw × (100vh - 顶栏)`，不再受 1760px 最大宽度限制
- 播放器画布填满左侧剩余高度，视频内容由浏览器 `contain` 保持比例
- 不在主界面显示 `ArtPlayer`、`独立媒体线路` 等实现层标签
- 支持明亮 / 黑暗主题
- 窄屏设备自动变成播放器在上、侧栏在下

## 房间聊天

4.1 增加了轻量实时聊天：

- 复用现有 Socket.IO 连接
- 双方实时收到消息
- 新加入者可以看到本次服务运行期间最近 80 条消息
- 单条消息最长 300 个字符
- 聊天只保存在服务器内存中，不写数据库
- 服务器重启后聊天记录清空

这部分和播放器数据链路完全独立，不会影响视频 Range、缓存或同步。

## 播放器与媒体结构

4.1 使用 **ArtPlayer 5.4.0** 作为播放器界面，底层仍由浏览器原生 `HTMLVideoElement` 解码。

```text
                    TogetherVideo Server
                           │
                 Socket.IO 控制 / 聊天
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
聊天消息
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

因此：

```text
A 缓冲 → A 自己等待
B 正常 → B 继续播放
```

## 同步原则

播放和暂停属于房间级控制。播放时服务器会给一个很短的共同 `startAt`，让两个浏览器尽量同时开始，但不会等待双方缓存一致。

拖动进度时：

```text
A 拖到 30:00
      ↓
服务器广播目标 30:00
      ↓
A currentTime = 30:00
B currentTime = 30:00
      ↓
A 自己请求 Range
B 自己请求 Range
      ↓
短 startAt 后各自播放
```

缓冲只作为 presence 状态显示，不会触发暂停另一方、等待另一方 ready 或缓存 Barrier。

第二个人加入正在播放的房间时，第一个人不会被暂停。后加入者读取当前权威时间线并自己加载到当前位置。

正常播放期间不会因为小漂移自动频繁 seek。只有用户主动点击 **重新同步** 时，才做一次轻量共同跳转。

## Service Worker / 123 Range

播放器使用站内逻辑地址：

```text
/api/media?path=xxx.mp4
```

服务端通过 WebDAV 解析临时 CDN 地址；视频正文不经过 Node 服务。

浏览器本地 Service Worker 会：

```text
播放器 Range 请求
      ↓
有界 Range（最大约 16 MiB）
      ↓
不转发旧 If-Range
      ↓
123 CDN
      ↓
必须得到 206 + Content-Range
      ↓
修正 MIME / Content-Disposition
      ↓
HTMLVideoElement
```

临时 CDN 地址失效或返回异常 Range 时，Service Worker 会重新解析一次地址再重试。

## 当前代码结构

```text
server.js
  ├─ src/http-routes.js        HTTP API / 媒体地址解析
  ├─ src/socket-gateway.js     播放控制 + 房间聊天 Socket 事件
  ├─ src/room-coordinator.js   双人控制同步 / 短 startAt
  ├─ src/watch-room.js         权威播放时间线
  ├─ src/media-service.js      片库、直链解析与媒体探测
  ├─ src/webdav.js             WebDAV 协议与认证重定向
  ├─ public/index.html         4.1 全屏左右布局
  ├─ public/styles.css         4.1 明亮 / 黑暗主题与响应式布局
  ├─ public/room-panel.js      房间 / 播放列表 Tab 与实时聊天
  ├─ public/app-3.1.js         播放房间客户端逻辑
  ├─ public/artplayer-media.js ArtPlayer / native video 适配
  ├─ public/media-transport.js Service Worker 启动时序
  └─ public/sw.js              浏览器本地媒体桥
```

## WebDAV 设置

设置面板需要：

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

服务端只使用认证信息读取目录、解析临时下载地址和执行小型探测。

## 视频兼容建议

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

检查媒体：

```powershell
ffprobe -hide_banner "input.mp4"
```

HEVC 建议优先使用 `hvc1`。如果文件为 `hev1`，可尝试无损重封装：

```powershell
ffmpeg -i "input.mp4" `
  -map 0:v:0 -map "0:a?" `
  -c copy `
  -tag:v:0 hvc1 `
  -movflags +faststart `
  "output.hvc1.mp4"
```

## 部署

需要 Node.js 20+：

```bash
git pull
npm install
npm start
```

生产环境建议使用 HTTPS。升级后建议两个浏览器执行一次：

```text
Ctrl + Shift + R
```

## 4.1 总结

```text
UI：全屏左播放器 + 右侧 房间/播放列表 双 Tab
媒体库：右侧播放列表 Tab
聊天：Socket.IO 实时聊天，内存保留最近 80 条
主题：明亮 / 黑暗
播放器：ArtPlayer 5.4.0
播放/暂停：双方同步
拖动：共同 target，各自独立加载
缓冲：谁卡谁自己缓冲
后加入：不打断正在播放的人
重新同步：手动轻量对齐
视频正文：123 CDN → Browser
Node 视频代理：禁止
```

**一条时间线，各自一条媒体线路。**
