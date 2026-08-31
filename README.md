# TogetherVideo 3.0.1

只供两个人使用的固定房间同步观影网站。

3.0.x 继续保持最重要的原则：**TogetherVideo 服务器不代理视频数据**。服务器只负责 WebDAV 元数据、临时播放地址发现和双人同步；真正的视频字节仍由 123 云盘/CDN 直接发送到各自浏览器。

## 3.0：稳定播放优先

3.0 不再把“加载、缓冲、恢复、同步”混成一个状态，而是明确拆分：

```text
准备媒体
  ↓
首帧就绪
  ↓
稳定播放
  ↓
检测到卡顿
  ↓
共享缓冲保护
  ↓
重新可播放
  ↓
连续稳定播放 3 秒
  ↓
恢复自动对轴
```

媒体恢复期间，客户端只保持服务端权威的播放/暂停意图，不进行周期性硬 seek，也不通过临时倍速追赶。只有真实播放连续稳定后，才重新加入自动对轴。

持续卡顿超过约 12 秒会进入有限自动重载，退避间隔为：

```text
0.5s → 1.5s → 3.5s → 7s → 12s
```

最多 5 次，之后明确停止，避免无限重载和反复跳动。

## Safari / iPad / iPhone

3.0 对 Apple 移动端采取 **Safari 系统原生媒体管线优先**。

2.1 的 libmedia HEVC fallback 在实际 iPad Safari 测试中出现黑屏和无声，因此 3.0 已明确禁用 Safari 上的这条 fallback。Safari 原生播放失败时会直接给出媒体诊断，不再进入一个看似“兼容播放”但实际上没有画面/声音的状态。

非 Apple 浏览器仍保留 `@libmedia/avplayer` 作为原生播放失败后的可选兼容核心。

跨浏览器最稳妥的片源仍然是：

```text
MP4 + H.264 / AVC + AAC-LC
```

HEVC 是否可以原生播放取决于设备、浏览器、MP4 封装与具体 codec 标记。

## 视频需要什么格式才能播放

TogetherVideo 不会在服务器上实时转码，因此 **视频最终能不能播放，取决于浏览器本身是否支持该文件的容器、视频编码、音频编码和封装方式**。

如果片源来源复杂、以后可能出现 H.264、HEVC、AV1、VP9、MKV 等各种格式，建议统一按下面的规则处理。

### 推荐的通用兼容格式

为了尽量同时兼容 iPad / iPhone Safari、Android Chrome、Windows Chrome 等设备，推荐把需要转换的片源统一做成：

```text
容器：MP4
视频：H.264 / AVC
Profile：Main 或 High
位深：8-bit
像素格式：yuv420p
音频：AAC-LC
声道：Stereo / 2.0 优先
Fast Start：开启
```

也就是：

```text
MP4 + H.264 8-bit yuv420p + AAC-LC + faststart
```

这是 TogetherVideo 的 **最稳妥兼容目标格式**。

### HEVC / H.265 的特殊情况

HEVC 并不是一定不能播放。Apple 设备可以原生播放很多 HEVC 文件，但 MP4 内部的 HEVC sample entry 很重要。

先检查：

```powershell
ffprobe -v error -select_streams v:0 `
  -show_entries stream=codec_name,codec_tag_string,profile,pix_fmt,width,height `
  -of default=noprint_wrappers=1 `
  "input.mp4"
```

如果看到：

```text
codec_name=hevc
codec_tag_string=hvc1
```

可以先直接尝试播放，通常不需要重新编码。

如果看到：

```text
codec_name=hevc
codec_tag_string=hev1
```

在 Apple Safari 上建议先无损重封装成 `hvc1`：

```powershell
ffmpeg -i "input.mp4" `
  -map 0:v:0 -map "0:a?" `
  -c copy `
  -tag:v:0 hvc1 `
  -movflags +faststart `
  "output.hvc1.mp4"
```

这个操作：

```text
不会重新编码视频
不会重新编码音频
不会降低画质
不会改变 4K 分辨率
主要只是重新写 MP4 并将 HEVC 标记改为 hvc1
```

如果输入文件带有 MJPEG 封面图等额外 video stream，不要使用 `-map 0 -tag:v hvc1`，否则 FFmpeg 可能会尝试把封面图也标记成 `hvc1`。上面的 `-map 0:v:0 -map "0:a?" -tag:v:0 hvc1` 会只保留主视频和音频，更适合网页播放。

### 其他编码格式怎么办

建议按下面的逻辑处理：

| 输入格式 | 建议 |
| --- | --- |
| MP4 + H.264 + AAC | 直接播放，通常无需处理 |
| MP4 + HEVC/H.265 + `hvc1` | Apple 设备可先直接尝试 |
| MP4 + HEVC/H.265 + `hev1` | 优先无损重封装为 `hvc1` |
| HEVC 重封装后仍无法播放 | 转成 H.264 + AAC |
| AV1 | 为最大兼容性建议转 H.264 |
| VP9 / WebM | 为 Apple / 多设备统一兼容建议转 H.264 MP4 |
| MKV | 浏览器兼容性不统一；建议转/封装为 MP4 |
| MPEG-4 Part 2 / Xvid / DivX | 建议转 H.264 |
| H.264 10-bit / yuv422p / yuv444p | 建议转成 H.264 8-bit yuv420p |
| DTS / TrueHD 等音频 | 建议转 AAC-LC |

注意：**改文件后缀不等于转码。** 例如把 `.mkv` 改成 `.mp4` 并不会让浏览器自动支持里面的视频编码。

### 检查一个视频到底是什么格式

可以直接使用：

```powershell
ffprobe -hide_banner "input.mp4"
```

重点关注：

```text
Video: h264 / hevc / av1 / vp9 ...
codec_tag_string=hvc1 / hev1 ...
pix_fmt=yuv420p / yuv420p10le ...
Audio: aac / ac3 / dts / truehd ...
```

### 任意片源转换为通用兼容版

如果不想研究原始编码，最省事的做法就是统一生成 H.264 网页兼容版。

CPU 转码：

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

NVIDIA GPU 转码：

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

上面的命令 **没有缩放参数**，因此原视频如果是 3840×2160，输出仍然可以保持 3840×2160。HEVC / AV1 → H.264 属于真正的重新编码，不可能做到数学意义上的无损，但 `CRF 18` / `CQ 18` 通常已经是很高的观感质量。

如果输入音频已经确认是普通 AAC-LC，也可以把：

```text
-c:a aac -b:a 192k -ac 2
```

替换成：

```text
-c:a copy
```

避免重复压缩音频。

### 推荐处理流程

```text
拿到一个新视频
      ↓
ffprobe 检查编码
      ↓
MP4 + H.264 + AAC？ ── 是 → 直接使用
      │
      否
      ↓
HEVC + hev1？ ─────── 是 → 先无损改成 hvc1
      │                         ↓
      │                    实机测试 Safari
      │                         ↓
      │                       能播 → 使用
      ↓
其他格式 / 仍然不能播放
      ↓
转成 MP4 + H.264 + AAC-LC + yuv420p
      ↓
上传到 123
      ↓
TogetherVideo 播放
```

## 视频数据链路

```text
浏览器 A ───────────────→ 123 WebDAV / CDN
   │                           ↑
   │ WebSocket                 │ 视频 Range 数据
   ↓                           │
TogetherVideo 服务器           │
   ↑                           │
   │ WebSocket                 │
   │                           │
浏览器 B ───────────────→ 123 WebDAV / CDN
```

TogetherVideo 服务器只负责：

- 两个人的在线与真实缓冲状态
- 播放 / 暂停 / 拖动 / 倍速同步
- 自动对轴
- “等等我”
- WebDAV 连接测试与目录列表
- 使用 WebDAV 凭据探测并解析临时下载地址

**服务器不会 pipe 视频、不会转发视频 Range、不会缓存或转码视频。**

## 123 WebDAV 与浏览器兼容层

目录浏览使用 WebDAV `PROPFIND`。

对需要认证的 123 WebDAV 文件，服务端只使用 HEAD 或极小的 Range 请求发现浏览器可以访问的临时 CDN 地址，然后返回 307；视频正文不进入 TogetherVideo 服务器。

123 普通下载节点可能返回：

```text
Content-Type: application/octet-stream
Content-Disposition: attachment
X-Content-Type-Options: nosniff
```

浏览器 Service Worker 会在本地透传 Range，把交给原生 `<video>` 的响应修正为正确的视频 MIME 和 `inline`，同时保留 206 / Content-Range。视频字节仍然是 123 CDN → 浏览器。

## 同步功能

- 永久只有一个房间，最多两个人在线
- 当前视频同步
- 播放 / 暂停同步
- 拖动进度同步
- 0.5× / 0.75× / 1× / 1.25× / 1.5× / 2× 倍速同步
- 小偏差通过轻微临时倍速平滑追赶
- 大偏差才硬 seek
- 恢复期间冻结 seek / 倍速追赶
- 一方持续真实缓冲时双方暂时暂停
- 媒体重新可播放后先恢复房间播放，再连续验证本地播放稳定性
- “等等我”一键暂停双方
- Socket.IO 自动重连
- 重连后恢复媒体、进度、播放状态和倍速
- 手机端播放器优先布局

服务端保存唯一权威时间线，包括 `media`、`mediaVersion`、`playing`、`position`、`rate`、`anchorAt` 和 `revision`。客户端定期测量 RTT 并与服务端时间线校准。

## WebDAV 设置

首次进入网站后打开 **设置**，填写：

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

123 云盘示例：

```text
https://webdav.123pan.cn/webdav
```

根目录通常可以使用 `/`。先点击 **测试连接**，成功后点击 **保存并使用**。

WebDAV 密码保存在服务器 `data/settings.json` 中，设置 API 不会把密码明文返回前端。

## 部署

要求：

- Node.js 20+
- `data/` 可持久化
- 生产环境使用 HTTPS

```bash
npm install
npm start
```

默认端口为 `3000`。自动部署平台提供 `PORT` 时会自动使用该端口。

首次默认站点密码：

```text
change-me
```

登录后请在设置中修改。

## HTTPS

3.0 生产环境应通过 HTTPS 访问，因为 Service Worker 和现代浏览器媒体能力依赖安全上下文。

```text
浏览器
  │ HTTPS
  ▼
Nginx / Caddy / 部署平台反代
  │ HTTP
  ▼
TogetherVideo :3000
```

反向代理终止 HTTPS 时建议：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

## 持久化

持续保存：

```text
data/
```

主要包含：

```text
data/settings.json
data/watch-state.json
```

升级到 3.0 不需要清空数据目录。

## 开发检查

```bash
npm install
npm run check
```

CI 会检查：

- 服务端和浏览器脚本语法
- 运行时依赖是否完整
- 3.0 媒体恢复状态机
- Safari 不进入 libmedia fallback
- 恢复期间冻结自动对轴
- 自动重载次数上限
- WebDAV 解析与认证重定向安全规则
- 单房间和同步状态回归测试

## 第三方组件

非 Apple 浏览器的可选兼容核心使用 `@libmedia/avplayer`。许可和归属信息见 `THIRD_PARTY_NOTICES.md`。
