# TogetherVideo 4.1

TogetherVideo 是一个固定双人使用的同步观影网站。

核心原则只有两条：

1. **同步播放控制和时间线**：播放、暂停、拖动、倍速、重新同步由房间统一协调。
2. **媒体线路完全独立**：两个人各自在浏览器中向 123 云盘 / CDN 请求视频数据，一方缓冲不会阻塞另一方。

Node 服务只负责登录、WebDAV 目录、临时媒体地址解析、Socket.IO 房间状态和聊天，**不会代理、缓存或转码视频正文**。

---

## 1. 4.1 界面

桌面端采用“一起看”式布局：

```text
┌──────────────────────── 顶部导航 ────────────────────────┐
│ TogetherVideo 4.1 │ 固定双人房间 │ 在线 │ 主题 │ 设置     │
├────────────────────────────────────────┬─────────────────┤
│ 当前视频标题                           │ 房间 | 播放列表 │
├────────────────────────────────────────┤─────────────────┤
│                                        │ 房间            │
│                                        │ - 双方状态      │
│                                        │ - 同步状态      │
│              ArtPlayer                 │ - 等等我        │
│                                        │ - 重新同步      │
│                                        │ - 播放速度      │
│                                        │ - 实时聊天      │
│                                        │                 │
│                                        │ 播放列表        │
│                                        │ - WebDAV 目录   │
│                                        │ - 视频文件      │
└────────────────────────────────────────┴─────────────────┘
```

主观影区域直接占满浏览器剩余视口：

```text
100vw × (100vh - 顶栏高度)
```

播放器占左侧主要空间，右侧固定为 **房间 / 播放列表** 两个 Tab。视频使用 `object-fit: contain` 保持原始比例，必要的黑边只出现在播放器内部，不会在页面外围留下大块空白。

支持 **明亮 / 黑暗** 两套主题，主题偏好保存在浏览器本地。

登录页昵称不再自由输入，只允许选择：

```text
小杨
旭旭
```

---

## 2. 房间与播放列表

### 房间

“房间”Tab 显示：

- 你 / TA 的在线状态
- 当前同步状态
- 双方缓冲状态
- `等等我`
- `重新同步`
- 播放速度
- 实时聊天

### 播放列表

“播放列表”Tab 直接展示 WebDAV 媒体库：

- 文件夹浏览
- 面包屑路径
- 视频文件
- 文件大小 / 类型
- 当前播放视频高亮
- 手动刷新

选择视频后，会把该视频设为房间当前媒体，两个人加载同一个逻辑媒体路径，但各自独立请求实际视频数据。

---

## 3. 同步机制

### 播放 / 暂停

播放和暂停属于房间级控制。

```text
A 点击暂停
    ↓
TogetherVideo Server
    ↓
room:state
   ↙     ↘
A pause  B pause
```

播放时服务器会提供一个很短的共同 `startAt`，让两个浏览器尽量同时开始。

这个 `startAt` 只用于时间对齐，**不会等待双方缓存一致**。

### 拖动进度

拖动等价于两个人同时把播放器拖到同一位置：

```text
A 拖到 30:00
      ↓
服务器广播 target = 30:00
      ↓
A currentTime = 30:00
B currentTime = 30:00
      ↓
A 独立请求 Range
B 独立请求 Range
      ↓
短 startAt 后继续播放
```

不会再执行“双方都缓存完成才能播放”的 Barrier。

### 缓冲

缓冲只作为状态显示：

```text
A 缓冲 → A 自己等待
B 正常 → B 继续播放
```

不会因为一方 `waiting / stalled` 自动暂停另一方。

### 后加入

第二个人进入正在播放的房间时，不会暂停已经在看的用户。后加入者读取当前房间时间线，然后自行加载到对应位置。

### 重新同步

正常播放时不会因为轻微漂移不断 seek 或调临时倍速。

只有主动点击 **重新同步** 时，才进行一次轻量对齐：

```text
共同 target
   ↓
A / B seek 到 target
   ↓
短 startAt
   ↓
继续播放
```

---

## 4. 聊天

聊天复用现有 Socket.IO 房间连接。

特性：

- 双方实时收发
- 单条最多 300 个字符
- 服务器内存最多保留最近 80 条
- 后加入者可以看到当前内存中的最近聊天记录
- 不写数据库
- 服务器重启后自动清空

需要手动删除时：

```text
设置
  ↓
聊天记录
  ↓
清空聊天记录
```

清空后：

- 服务器内存聊天历史立即删除
- 两边当前页面同步清空
- 后加入者也不会再看到旧记录

---

## 5. 媒体链路

4.1 使用 **ArtPlayer 5.4.0** 作为播放器 UI，真正解码仍由浏览器原生 `HTMLVideoElement` 完成。

```text
                    TogetherVideo Server
                           │
                   Socket.IO 控制
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

两个人共享的是：

```text
当前视频
播放 / 暂停
目标进度
正式倍速
房间时间线
聊天消息
```

两个人不共享的是：

```text
浏览器缓存
Range 请求
CDN 连接
临时签名 URL
网络速度
解码状态
```

---

## 6. Service Worker 与 Range

播放器始终使用站内逻辑地址：

```text
/api/media?path=xxx.mp4
```

Node 通过 WebDAV 找到可供浏览器访问的临时 CDN 地址，然后返回重定向；视频正文不进入 Node。

浏览器 Service Worker 负责：

```text
播放器请求
   ↓
限制 Range 大小（最大约 16 MiB）
   ↓
不转发旧 If-Range
   ↓
123 CDN
   ↓
要求真实 206 + Content-Range
   ↓
必要时修正 MIME / Content-Disposition
   ↓
HTMLVideoElement
```

如果临时地址失效或 Range 响应异常，会重新解析一次临时 URL 后重试。

---

## 7. 设置

右上角“设置”目前包含三部分：

### WebDAV 媒体源

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

服务端只使用这些信息读取目录、解析临时下载地址以及执行少量媒体探测。

### 站点访问密码

用于修改进入 TogetherVideo 的访问密码。

### 聊天记录

提供 **清空聊天记录** 操作。

---

## 8. 推荐视频格式

兼容性最稳定的组合：

```text
容器：MP4
视频：H.264 / AVC
Profile：Main / High
位深：8-bit
像素格式：yuv420p
音频：AAC-LC
Fast Start：开启
```

检查视频：

```powershell
ffprobe -hide_banner "input.mp4"
```

HEVC 建议优先使用 `hvc1`。如果是 `hev1`，可以尝试无损重封装：

```powershell
ffmpeg -i "input.mp4" `
  -map 0:v:0 -map "0:a?" `
  -c copy `
  -tag:v:0 hvc1 `
  -movflags +faststart `
  "output.hvc1.mp4"
```

---

## 9. 部署

需要 Node.js 20+：

```bash
git pull
npm install
npm start
```

生产环境建议使用 HTTPS，因为 Service Worker 在公网环境需要安全上下文。

升级前端后建议两个浏览器各执行一次：

```text
Ctrl + Shift + R
```

如果仍然命中旧 Service Worker，可在浏览器开发者工具中注销旧 Worker 后重新打开页面。

---

## 10. 代码结构

```text
server.js
├─ src/http-routes.js        HTTP API / 媒体地址解析
├─ src/socket-gateway.js     房间控制 / 聊天 / 聊天清空
├─ src/room-coordinator.js   双人同步协调
├─ src/watch-room.js         权威播放时间线
├─ src/media-service.js      片库 / 临时直链 / 媒体探测
├─ src/webdav.js             WebDAV 协议
├─ public/index.html         4.1 主界面
├─ public/styles.css         基础布局与主题
├─ public/sidebar-readable.css 右侧可读字号覆盖
├─ public/room-panel.js      房间 / 播放列表 / 聊天
├─ public/app-3.1.js         播放同步客户端
├─ public/artplayer-media.js ArtPlayer 与原生 video 适配
├─ public/media-transport.js Service Worker 注册
└─ public/sw.js              浏览器本地媒体桥
```

---

## 4.1 当前状态

```text
UI：全屏左播放器 + 右侧 房间/播放列表
主题：明亮 / 黑暗
身份：小杨 / 旭旭固定选择
播放器：ArtPlayer 5.4.0
聊天：实时聊天 + 设置中清空历史
播放 / 暂停：双方同步
拖动：共同 target，各自独立加载
缓冲：互不阻塞
后加入：不打断已有播放
重新同步：手动轻量对齐
视频正文：123 CDN → Browser
Node 视频代理：不使用
```

**一条时间线，各自一条媒体线路。**
