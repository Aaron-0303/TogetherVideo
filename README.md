# TogetherVideo 3.2.5

只供两个人使用的固定房间同步观影网站。

TogetherVideo 的核心原则是：**同步播放控制，但不把两个浏览器的媒体下载和缓存绑在一起。**

服务器不会代理、缓存或转码视频正文。服务端只负责 WebDAV 元数据、123 临时播放地址发现、房间状态以及播放 / 暂停 / 跳转等控制同步；真正的视频数据始终由 123 云盘 / CDN 直接发送到每一个浏览器。

## 3.2.5：控制同步，媒体线路独立

3.2.5 使用 **ArtPlayer 5.4.0** 作为播放器 UI，底层仍由浏览器原生 `HTMLVideoElement` 解码。Service Worker 负责 123 临时直链、Range 和 MIME 兼容处理。

两个人共享的是：

```text
当前视频
播放 / 暂停
跳转目标
正式倍速
房间权威时间线
```

两个人不共享的是：

```text
浏览器缓存
Range 请求
CDN 连接
临时签名 URL
下载速度
网络状态
解码状态
```

整体结构：

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

**A 缓冲不会让 B 暂停，B 缓冲也不会阻塞 A。**

这和单人播放器的行为一致：每个浏览器自己加载自己的数据，只在需要同步控制时交换时间点。

## 播放 / 暂停

播放和暂停是房间级同步操作。

例如 A 点击暂停：

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

播放时服务器会给两个浏览器一个很短的共同 `startAt`，默认只预留约 500 ms 的控制传播时间：

```text
A 点击播放
    ↓
服务器确定目标位置
    ↓
startAt = 当前服务器时间 + 短暂 runway
    ↓
A 在 startAt play()
B 在 startAt play()
```

这里的 `startAt` 是为了尽量让两边同时开始，不是为了等待双方缓存。

如果某一端网络慢，它可以在自己的播放器里短暂转圈，但不会把另一端一起锁住。

## 拖动进度条

3.2.5 不再使用“双方缓存完成后才能继续”的 Barrier。

拖动现在更接近于 **两个用户同时手动把进度条拖到同一个位置**：

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

不会再执行：

```text
等待 A ready
等待 B ready
比较双方 buffer
一方没缓存好就阻塞另一方
```

如果拖动前房间处于暂停状态，则两边只同步到目标位置并保持暂停。

## 缓冲

缓冲是 **每个浏览器自己的状态**。

例如：

```text
A 网络正常                B 网络较慢
A 正常播放                B waiting / stalled
     │                         │
     │                         └─ UI 显示“对方正在缓冲”
     │
     └─ 不暂停、不 seek、不等待 B
```

`presence:buffering` 只用于状态展示，不会触发房间暂停、重新定位或缓存 Barrier。

因此两个人一起看时，不再要求两边缓存量完全一致。

## 后进入房间的人

第二个人进入一个已经在播放的房间时，不会再把先进入的人暂停。

```text
A 正在播放
    ↓
B 上线
    ↓
A 继续播放
B 读取当前房间时间线
    ↓
B 自己加载 / 自己追到当前播放位置
```

加入房间只是 presence 事件，不会创建同步屏障。

## 漂移检测与“重新同步”

客户端仍会低频测量房间时间线，用于显示两边是否存在明显差值。

正常播放期间：

```text
不使用 0.97x / 1.02x / 1.03x 等临时倍速追赶
不因为轻微偏差频繁 seek
不因为检测到漂移自动暂停双方
```

即使检测到明显偏差，也只做提示。

只有用户主动点击 **重新同步** 时，才执行一次轻量对齐：

```text
点击“重新同步”
      ↓
服务器取得当前权威时间点
      ↓
A currentTime = target
B currentTime = target
      ↓
约 750 ms 后共同 startAt
      ↓
两边各自播放
```

它本质上仍然是“一次同步拖动”，不会等待两端缓存一致。

对于固定两人的看片场景，目标是 **观感上的同步**，而不是强制两个浏览器的网络、缓存和播放器状态每一刻完全一致。

## ArtPlayer 与媒体读取链路

3.2.5 使用：

```text
ArtPlayer 5.4.0
    ↓
原生 HTMLVideoElement
    ↓
/api/media?path=...
    ↓
Service Worker
    ↓
123 临时 CDN URL
```

ArtPlayer 负责：

- 播放器 UI
- 进度条
- 音量
- 全屏 / 网页全屏
- 画中画
- 快捷键
- 移动端播放界面

原生 `<video>` 负责浏览器解码。

TogetherVideo 自己的房间倍速选择器负责同步倍速，因此 ArtPlayer 的本地独立倍速菜单被关闭，避免一个人只修改自己的播放速度。

## Service Worker / 123 Range

播放器始终使用站内逻辑地址：

```text
/api/media?path=xxx.mp4
```

服务端通过 WebDAV 找到浏览器可直接访问的 123 临时 CDN 地址，并返回重定向；视频正文不经过 Node 服务。

Service Worker 在浏览器本地完成媒体兼容处理：

```text
/video Range 请求
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
交给原生 <video>
```

如果临时 CDN 地址过期或 Range 响应异常，会重新解析临时地址后重试，而不是让 Node 服务器接管视频正文。

## 当前后端结构

```text
server.js
  ├─ 启动 / Session / 静态资源 / 生命周期
  ├─ http-routes.js       HTTP API / 媒体地址解析
  ├─ socket-gateway.js    Socket.IO 事件入口
  ├─ room-coordinator.js  双人控制同步 / 短 startAt
  ├─ watch-room.js        唯一权威播放时间线
  ├─ media-service.js     片库、直链解析与媒体探测
  ├─ webdav.js            WebDAV 协议与认证重定向
  └─ settings.js          设置与持久化
```

`WatchRoom` 保存当前媒体、位置、播放状态、正式倍速和权威时间线。

`RoomCoordinator` 负责把播放、暂停、拖动和手动重新同步转换成房间控制事件。它不会把一端的 buffering 变成另一端的暂停事件。

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

服务端只负责：

- 唯一房间和最多两个人在线
- 当前视频和房间权威时间线
- 播放 / 暂停 / 跳转 / 正式倍速同步
- WebDAV 目录浏览
- 使用 WebDAV 凭据发现临时 CDN 地址
- “等等我”
- 手动重新同步

**服务器不会 pipe 视频、不会代理视频 Range、不会缓存视频、不会实时转码。**

每个浏览器拥有自己的媒体线路和临时 CDN 连接。

## Safari / iPad / iPhone

ArtPlayer 在 Apple 设备上仍然建立浏览器原生 `HTMLVideoElement`，最终能否播放由 Safari 的系统媒体解码能力决定。

移动浏览器还可能限制“没有用户手势的带声音自动播放”。遇到这种情况，TogetherVideo 会尝试以浏览器允许的方式继续播放，并显示：

```text
点击开启声音并加入同步播放
```

点击一次即可解除静音。

---

# 视频需要什么格式才能播放

TogetherVideo 不会在服务器上实时转码，所以最终能否播放取决于 **容器 + 视频编码 + 视频位深/像素格式 + 音频编码 + 浏览器/设备**。

以后片源可能来自各种地方，建议统一按照下面的规则处理。

## 最稳妥的通用格式

为了尽量同时兼容 iPad / iPhone Safari、Android Chrome、Windows Chrome：

```text
容器：MP4
视频：H.264 / AVC
Profile：Main 或 High
位深：8-bit
像素格式：yuv420p
音频：AAC-LC
Fast Start：开启
```

也就是：

```text
MP4 + H.264 8-bit yuv420p + AAC-LC + faststart
```

如果不想研究一个新视频到底是什么奇怪编码，转换到这个目标格式最省事。

## 先用 ffprobe 检查

```powershell
ffprobe -v error -select_streams v:0 `
  -show_entries stream=codec_name,codec_tag_string,profile,pix_fmt,width,height `
  -of default=noprint_wrappers=1 `
  "input.mp4"
```

也可以直接：

```powershell
ffprobe -hide_banner "input.mp4"
```

重点看：

```text
Video: h264 / hevc / av1 / vp9 ...
codec_tag_string=hvc1 / hev1 ...
pix_fmt=yuv420p / yuv420p10le / yuv422p ...
Audio: aac / ac3 / eac3 / dts / truehd ...
```

## HEVC / H.265

HEVC 并不是一定不能播放。Apple 设备可以原生播放很多 HEVC，但 MP4 中的 sample entry 很重要。

如果是：

```text
codec_name=hevc
codec_tag_string=hvc1
```

可以先直接实机测试。

如果是：

```text
codec_name=hevc
codec_tag_string=hev1
```

优先尝试无损重封装成 `hvc1`：

```powershell
ffmpeg -i "input.mp4" `
  -map 0:v:0 -map "0:a?" `
  -c copy `
  -tag:v:0 hvc1 `
  -movflags +faststart `
  "output.hvc1.mp4"
```

这个过程通常不会重新编码视频和音频，因此不会因为转码降低画质，也不会改变 4K 分辨率。

如果输入文件带 MJPEG 封面等额外 video stream，不建议：

```text
-map 0 -tag:v hvc1
```

否则 FFmpeg 可能把封面流也尝试标记成 `hvc1`。网页播放更推荐：

```text
-map 0:v:0 -map "0:a?" -tag:v:0 hvc1
```

只保留主视频和音频。

## 各种输入格式怎么处理

| 输入 | 建议 |
| --- | --- |
| MP4 + H.264 + AAC | 直接播放 |
| MP4 + HEVC + `hvc1` | Apple 设备先直接测试 |
| MP4 + HEVC + `hev1` | 优先无损重封装为 `hvc1` |
| HEVC 改成 `hvc1` 后仍不能播 | 转 H.264 + AAC |
| AV1 | 为最大兼容性建议转 H.264 |
| VP9 / WebM | 多设备统一观看建议转 H.264 MP4 |
| MKV | 浏览器兼容性不统一，建议封装/转为 MP4 |
| Xvid / DivX / MPEG-4 Part 2 | 建议转 H.264 |
| H.264 10-bit | 建议转 H.264 8-bit |
| yuv422p / yuv444p | 建议转 yuv420p |
| DTS / TrueHD 等音轨 | 建议转 AAC-LC |

**只修改文件后缀没有用。** `.mkv` 改名成 `.mp4` 不会改变内部编码。

## 任意片源转成网页兼容版

### CPU / libx264

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

### NVIDIA NVENC

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

上面的命令没有缩放参数，所以原视频是 `3840×2160` 时仍可以保持 `3840×2160`。

如果已经确认原始音频就是普通 AAC-LC，可以把：

```text
-c:a aac -b:a 192k -ac 2
```

改成：

```text
-c:a copy
```

避免重复压缩音频。

## 推荐的视频处理流程

```text
拿到新视频
    ↓
ffprobe 检查
    ↓
MP4 + H.264 + AAC？ ── 是 → 直接使用
    │
    否
    ↓
HEVC + hvc1？ ──────── 是 → 实机测试
    │
HEVC + hev1？ ──────── 是 → 无损重封装 hvc1 → 实机测试
    │
    ↓
仍然不能播放 / 其他复杂格式
    ↓
MP4 + H.264 8-bit yuv420p + AAC-LC + faststart
```

---

## WebDAV 设置

首次进入网站后打开 **设置**，填写：

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

浏览器不会把 WebDAV 用户名和密码塞进 `<video src>`。服务端使用认证信息进行 `PROPFIND` 和极小的 HEAD / Range 探测，找到最终浏览器可访问的临时 CDN 地址；视频正文仍然由浏览器直接获取。

如果 WebDAV 只能返回“必须携带 Basic Auth 才能下载正文”的地址，而没有匿名 / 签名临时 URL，TogetherVideo 会拒绝把视频正文变成服务端代理流。

## 部署

需要 Node.js 20+：

```bash
git pull
npm install
npm start
```

3.2.5 使用 `artplayer@5.4.0`，升级版本后需要重新执行一次 `npm install`。

生产环境建议使用 HTTPS，并由 Nginx / Caddy / 宝塔反向代理到 Node 服务。Service Worker 在公网移动端需要安全上下文，因此生产环境不要直接使用普通 HTTP 域名。

升级 Service Worker 或前端版本后，如果浏览器仍然加载旧逻辑，可以先强制刷新；必要时在浏览器开发者工具中注销旧 Service Worker 后重新打开页面。

## 3.2.5 同步原则

```text
播放：同步控制 + 短 startAt
暂停：双方同步暂停
拖动：双方跳到同一目标，各自独立加载
缓冲：谁卡谁自己缓冲，不暂停另一方
后加入：不打断正在播放的人
小偏差：不处理
明显偏差：只提示，不自动 seek
重新同步：手动执行一次“共同目标 + 短 startAt”
临时倍速追赶：不使用
```

对这个固定两人的看片场景，**观感优先于数学意义上每一秒都完全重合；控制需要同步，媒体线路必须独立。**
