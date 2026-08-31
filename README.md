# TogetherVideo 3.1

只供两个人使用的固定房间同步观影网站。

最重要的原则没有改变：**TogetherVideo 服务器不代理、缓存或转码视频正文。** 服务端只负责 WebDAV 元数据、临时播放地址发现和双人同步；真正的视频 Range 数据仍然由 123 云盘/CDN 直接发送到每一个浏览器。

## 3.1：同步屏障，而不是不停追着对轴

3.1 重写了播放同步核心。之前 3.0.x 会在播放过程中根据偏差进行临时倍速修正和硬 seek，这在浏览器、Safari、远程 4K Range 视频上容易产生“一个人在加速”“一直跳转”“后加入黑屏”等连锁问题。

3.1 不再把两个正在播放的浏览器不停拉回同一时间点，而是采用更简单的 **Barrier / 同步屏障** 模型：

```text
正常播放
   │
   ├─ 拖动进度
   ├─ 第二个人加入正在播放的房间
   ├─ 持续缓冲
   └─ 连续多次检测到严重不同步
           ↓
        暂停双方
           ↓
       统一目标位置
           ↓
   A 跳转并缓存   B 跳转并缓存
       ↓ ready       ↓ ready
           \         /
            双方 ready
                ↓
       server startAt + 约 900ms
                ↓
          两边同时 play()
                ↓
             正常播放
```

### 拖动进度条

任何一端拖动完成后，不再让另一端一边播放一边追赶：

```text
A 拖到 30:00
    ↓
A 立即暂停
    ↓
服务器把房间暂停在 30:00
    ↓
A / B 都跳到 30:00
    ↓
双方都确认目标位置已有可播放数据
    ↓
服务器预约一个未来 startAt
    ↓
双方同时继续播放
```

浏览器的 `seeked` 本身不等于“已经可以顺畅播放”。3.1 的 ready 判断还会检查目标位置和本地可播放数据，优先要求至少约 1 秒的后续缓存或 `HAVE_FUTURE_DATA`。为了避免少数浏览器在暂停状态下永远不给出更高 readyState，等待较长时间后允许在已有当前帧数据时继续。

### 后进入房间的人

如果 A 已经播放了一段时间，B 后进入：

```text
B 上线
  ↓
服务器记录当前权威位置
  ↓
暂停 A
  ↓
A 与 B 都准备这个位置
  ↓
双方 ready
  ↓
一起重新开始
```

因此 3.1 宁可让先进入的人暂停几秒等待对方，也不允许后进入的人在后台连续 seek、倍速追赶或一直黑屏。

### 正常播放期间

正常播放期间 **不再进行临时倍速校准**。

```text
0.97x / 1.02x / 1.03x 之类的内部追赶速度：已删除
```

客户端约每 5 秒只做一次低频检查，不主动改变 `playbackRate`，也不会因为几百毫秒的小偏差 seek。如果连续多次检测到约 2.5 秒以上的严重偏差，才重新进入一次同步屏障：暂停 → 双方准备 → 同时开始。

这意味着正常情况下两个播放器始终按照用户选择的真实倍速运行，例如 `1.0x` 就一直是 `1.0x`。

### 缓冲

两个人都在线并正常播放时，如果一端持续缓冲，服务器不会让另一端一直向前跑，也不会让卡顿端靠加速追回：

```text
持续缓冲
  ↓
进入 barrier
  ↓
双方暂停
  ↓
重新准备同一位置
  ↓
双方 ready 后同时继续
```

## 当前后端结构

```text
server.js
  ├─ 启动 / Session / 静态资源 / 生命周期
  ├─ http-routes.js       HTTP API
  ├─ socket-gateway.js    Socket.IO 事件入口
  ├─ room-coordinator.js  双人 barrier / ready / 定时启动
  ├─ watch-room.js        唯一权威播放时间线
  ├─ media-service.js     片库、直链解析与媒体探测
  ├─ webdav.js            WebDAV 协议与认证重定向
  └─ settings.js          设置与持久化
```

`WatchRoom` 只保存权威媒体、位置、倍速和时间线；`RoomCoordinator` 负责两个人是否 ready 以及何时一起开始；媒体/WebDAV 逻辑不参与同步状态机。

## 视频数据链路

```text
浏览器 A ───────────────→ 123 WebDAV / CDN
   │                           ↑
   │ Socket.IO                 │ 视频 Range 数据
   ↓                           │
TogetherVideo 服务器           │
   ↑                           │
   │ Socket.IO                 │
   │                           │
浏览器 B ───────────────→ 123 WebDAV / CDN
```

服务端只负责：

- 唯一房间和最多两个人在线
- 当前视频、暂停位置、正式倍速
- barrier / ready / 同步开始时间
- WebDAV 目录浏览
- 使用 WebDAV 凭据发现浏览器可直接访问的临时 CDN 地址
- “等等我”和手动重新同步

**服务器不会 pipe 视频、不会转发视频 Range、不会缓存视频、不会实时转码。**

每个浏览器建立媒体连接时都会独立解析自己的临时播放地址，避免两个设备强制共享同一条临时签名 URL。

## Safari / iPad / iPhone

Apple 移动端始终优先使用 Safari 系统原生媒体管线。之前尝试过的 libmedia Safari fallback 在实际设备上出现过黑屏/无声，因此 Apple 移动端不会进入该 fallback。

后加入用户还可能遇到浏览器的自动播放限制：浏览器允许页面加载视频，却拒绝“没有用户手势的带声音自动播放”。遇到这种情况，TogetherVideo 会优先让视频静音启动，保持解码与 Range 下载正常，然后显示：

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

如果 WebDAV 只能返回“必须携带 Basic Auth 才能下载正文”的地址，而没有匿名/签名临时 URL，TogetherVideo 会拒绝把视频正文变成服务端代理流。

## 部署

需要 Node.js 20+：

```bash
git pull
npm install
npm start
```

生产环境建议使用 HTTPS，并由 Nginx / Caddy / 宝塔反向代理到 Node 服务。Service Worker 在公网移动端需要安全上下文，因此生产环境不要直接使用普通 HTTP 域名。

## 3.1 同步原则

```text
小偏差：不管
正常播放：不改临时倍速
拖动：暂停双方 → 双方缓存 → 同时播放
后加入：暂停双方 → 双方缓存 → 同时播放
持续卡顿：暂停双方 → 双方缓存 → 同时播放
严重持续不同步：重新进入一次 barrier
```

对这个固定两人的看片场景，**观感优先于数学意义上每一秒都完全重合**。
