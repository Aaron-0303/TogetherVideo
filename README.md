# TogetherVideo 4.1

只供两个人使用的固定房间同步观影网站。

TogetherVideo 的核心原则仍然是：**同步控制，不同步媒体线路。** 两个人共享当前视频、播放 / 暂停、跳转目标、正式倍速和房间权威时间线；浏览器缓存、Range 请求、CDN 连接、临时签名 URL、网络速度和解码状态完全独立。

服务器不会代理、缓存或转码视频正文。真正的视频数据始终由 123 云盘 / CDN 直接发送到每一个浏览器。

## 4.1：沉浸式观影界面

4.1 再次重构了前端布局。重点不是增加更多卡片，而是把页面重新组织成真正的“观影房间”。

桌面端结构：

```text
┌──────────────────── 顶部细导航 ────────────────────┐
│ TogetherVideo 4.1 / 房间 / 连接 / 在线 / 主题 / 设置 │
├──────────────────────────────────────┬─────────────┤
│                                      │ 房间成员     │
│                                      │             │
│             大播放器                 │ 同步状态     │
│                                      │             │
│                                      │ 缓冲状态     │
│                                      │             │
│                                      │ 等等我       │
│                                      │ 重新同步     │
│                                      │             │
│                                      │ 播放速度     │
│                                      │ 房间动态     │
├──────────────────────────────────────┴─────────────┤
│ 媒体库默认隐藏，需要时从左侧抽屉展开                  │
└────────────────────────────────────────────────────┘
```

4.1 的主要变化：

- 播放器成为页面绝对视觉中心，不再被片库和多张状态卡分割
- 右侧改成统一的 **房间侧栏**，集中显示成员、同步、缓冲和房间操作
- 媒体库改成 **抽屉式 WebDAV Library**，平时不占用播放器宽度
- 顶部导航压缩为一条细栏，只保留房间与连接相关信息
- “等等我”“重新同步”和倍速统一放入右侧房间栏
- 继续支持 **明亮 / 黑暗** 两套主题，布局完全一致
- 桌面端优先沉浸观看；窄屏和手机端自动将右侧栏移动到播放器下方
- 保留 ArtPlayer 5.4.0 和原有媒体链路，不为了换 UI 重写已经稳定的后端

主题选择存储在浏览器本地；用户没有手动选择时跟随系统主题。

## 播放器与媒体结构

4.1 使用 **ArtPlayer 5.4.0** 作为播放器界面，底层由浏览器原生 `HTMLVideoElement` 解码。

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

因此：

```text
A 缓冲 → A 自己等待
B 正常 → B 继续播放
```

不会再因为一方缓存不足把另一方锁住。

## 同步原则

### 播放 / 暂停

播放和暂停是房间级同步控制。

```text
A 点击暂停
    ↓
TogetherVideo Server
    ↓
room:state
   ↙     ↘
A pause  B pause
```

播放时服务器会提供一个很短的共同 `startAt`，用于让两个浏览器尽量同时开始；它不是缓存屏障。

### 拖动进度条

拖动相当于两个用户同时把自己的播放器拖到同一时间点：

```text
A 拖到 30:00
      ↓
服务器广播 30:00
      ↓
Browser A currentTime = 30:00
Browser B currentTime = 30:00
      ↓
A 自己请求 Range
B 自己请求 Range
      ↓
短 startAt 后各自播放
```

不会等待双方 buffer 一致。

### 缓冲

缓冲只是一条 presence 状态：

```text
presence:buffering
```

它可以显示在右侧“缓冲状态”中，但不会触发：

```text
暂停另一方
等待另一方 ready
创建缓存 Barrier
强制重复 seek
```

### 后加入房间

第二个人进入正在播放的房间时，第一个人不会被暂停。后加入者读取当前权威时间线并自己加载到当前播放位置。

### 漂移与重新同步

正常播放期间：

```text
不使用临时倍速追赶
不因为小偏差频繁 seek
不因为漂移自动暂停双方
```

只有用户主动点击 **重新同步** 时，才执行一次轻量对齐：

```text
确定共同 target
      ↓
A / B currentTime = target
      ↓
短 startAt
      ↓
继续播放
```

## Service Worker / 123 Range

播放器使用站内逻辑地址：

```text
/api/media?path=xxx.mp4
```

服务端通过 WebDAV 找到浏览器可直接访问的 123 临时 CDN 地址。视频正文不经过 Node 服务。

浏览器本地 Service Worker 完成：

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
必要时修正 MIME / Content-Disposition
      ↓
HTMLVideoElement
```

临时 CDN 地址失效或返回异常 Range 时，Service Worker 会重新解析一次临时地址再重试。

## 当前代码结构

```text
server.js
  ├─ 启动 / Session / 静态资源 / 生命周期
  ├─ src/http-routes.js        HTTP API / 媒体地址解析
  ├─ src/socket-gateway.js     Socket.IO 事件入口
  ├─ src/room-coordinator.js   双人控制同步 / 短 startAt
  ├─ src/watch-room.js         唯一权威播放时间线
  ├─ src/media-service.js      片库、直链解析与媒体探测
  ├─ src/webdav.js             WebDAV 协议与认证重定向
  ├─ public/index.html         4.1 沉浸式页面结构
  ├─ public/styles.css         4.1 明亮 / 黑暗设计系统
  ├─ public/ui-shell.js        主题切换
  ├─ public/app-3.1.js         房间客户端逻辑
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

服务端仅使用认证信息读取目录、解析临时下载地址和执行小型探测。

如果 WebDAV 只能返回必须携带 Basic Auth 才能下载正文的地址，而没有匿名 / 签名临时 URL，TogetherVideo 不会把服务器变成视频代理。

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

即：

```text
MP4 + H.264 8-bit yuv420p + AAC-LC + faststart
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

4.1 继续使用：

```text
artplayer@5.4.0
```

生产环境建议使用 HTTPS。Service Worker 在公网环境需要安全上下文。

从旧版本升级到 4.1 后，建议两个浏览器都执行一次强制刷新：

```text
Ctrl + Shift + R
```

如果浏览器仍然运行旧媒体桥，可以在开发者工具中注销旧 Service Worker 后重新打开页面。

## 4.1 总结

```text
UI：顶部细导航 + 大播放器 + 右侧房间栏 + 抽屉片库
主题：明亮 / 黑暗
播放器：ArtPlayer 5.4.0
播放：同步控制 + 短 startAt
暂停：双方同步暂停
拖动：共同 target，各自独立加载
缓冲：谁卡谁自己缓冲
后加入：不打断正在播放的人
漂移：只提示
重新同步：手动轻量对齐
视频正文：123 CDN → Browser
Node 视频代理：禁止
```

**一条时间线，各自一条媒体线路。**
