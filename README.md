# TogetherVideo 2.0

只供两个人使用的固定同步观影网站。2.0 与旧版实现无兼容关系：没有房间码、没有 OpenList、没有 QuarkTV、没有视频代理。

## 核心架构

```text
浏览器 A ── WebSocket ──┐
                       │
                 TogetherVideo
                 只维护播放状态
                       │
浏览器 B ── WebSocket ──┘

浏览器 A ── 302 ──> 123 云盘 / WebDAV ──> 视频字节
浏览器 B ── 302 ──> 123 云盘 / WebDAV ──> 视频字节
```

`/api/media` 只返回一个 `302 Location`，不会读取、转发或缓存视频内容。即使浏览器发送 Range 请求，自建服务器也只返回重定向，真正的视频请求由浏览器直接发往 WebDAV。

后端访问 WebDAV 仅用于 `PROPFIND`：测试连接、列目录和获取文件信息。这些请求体很小，不包含视频数据。

## 功能

- 永久只有一个房间，最多两个在线参与者
- WebDAV 地址 / 用户名 / 密码 / 根目录均可在网页设置
- WebDAV 连接测试和目录浏览
- HTML5 Video：播放、暂停、拖动、音量、全屏
- 自定义 0.5× ~ 2× 倍速，并同步给另一端
- 同步当前视频、播放、暂停、进度、倍速
- 每 4 秒自动对轴：小误差忽略，中等误差轻微调速，大误差才跳 `currentTime`
- 缓冲期间不强制跳进度，避免“缓冲 → seek → 再缓冲”循环
- 显示双方在线状态和对方缓冲状态
- Socket.IO 自动重连；断线期间的本地操作不会排队，重连以后只服从服务器最新状态
- “等等我”一键让双方暂停
- 手机端播放器优先，片库使用侧滑面板

## 123 云盘 WebDAV

在 123 云盘中创建“第三方挂载 / WebDAV”应用，使用应用提供的 WebDAV 地址、登录账号和应用密码。请优先使用 123 云盘当前界面实际显示的地址；常见形式包括：

```text
https://webdav.123pan.cn/webdav
```

或账号对应的专用 WebDAV 域名。

本项目不会默认启用 123 云盘收费的音视频分发/CDN，也不会申请转码。浏览器直接读取 WebDAV 文件。

> 浏览器最终必须能够直接访问该 WebDAV 文件。项目通过带 Basic Auth 凭据的 WebDAV URL 做 302。如果某个 WebDAV 服务或浏览器明确禁止这种直连认证，那么在“不允许服务器代理视频”的前提下，无法通过服务器中转来绕过；应改用允许浏览器直接读取的 WebDAV 端点或供应商直接下载地址。

## 推荐视频格式

最稳妥：

```text
MP4 + H.264/AVC + AAC
```

`.mp4` 只是容器。若内部是 HEVC/H.265、DTS 等编码，不同浏览器仍可能出现黑屏或无声。网站会在 HTML5 Video 报错时给出明确提示。

## 自动部署

要求：Linux + Node.js 20+（推荐 Node.js 22）。

```bash
npm install
npm start
```

默认端口：

```text
3000
```

如果平台提供 `PORT`，会自动使用平台端口。

首次访问默认站点密码：

```text
change-me
```

登录后请在“设置”中立即修改。

## 环境变量

通常自动部署不需要任何环境变量。可选：

```env
HOST=0.0.0.0
PORT=3000
SITE_PASSWORD=change-me
COOKIE_SECURE=false
TRUST_PROXY=true
MAX_PARTICIPANTS=2
DATA_DIR=./data
```

如果使用 HTTPS 并由反向代理终止 TLS，可设置：

```env
COOKIE_SECURE=true
TRUST_PROXY=true
```

## 持久化

部署平台应持久化：

```text
data/
```

其中保存：

- WebDAV 设置
- 站点密码哈希
- Session 密钥
- 当前播放状态

WebDAV 密码不会返回到设置 API；网页只会显示“已保存”。播放时 `/api/media` 动态生成 302 目标。

## 同步策略

服务端是唯一权威时间线。状态包含：

```text
media
mediaVersion
playing
position
rate
anchorAt
revision
```

客户端所有播放事件都携带 `mediaPath + mediaVersion`。换视频后，旧视频迟到的 play/pause/seek/rate 事件会被服务端直接丢弃。

自动对轴规则：

- <= 0.25 秒：视为已同步
- 约 0.35 ~ 1.8 秒：临时 ±2% ~ 6% 调速追赶
- > 1.8 秒：在非缓冲状态下允许硬校准 `currentTime`
- 两次自动硬校准至少间隔 6 秒
- “立即对轴”允许用户主动立即校准

## 安全与带宽

WebDAV 密码保存在服务器 `data/settings.json`，文件权限以私有方式创建，设置 API 不会把密码回传到前端。

视频流量路径不经过 TogetherVideo。服务器带宽主要是：

- HTML/CSS/JS
- WebSocket 小消息
- WebDAV PROPFIND 目录请求
- `/api/media` 的 302 响应头

因此自建服务器不需要承担视频带宽。
