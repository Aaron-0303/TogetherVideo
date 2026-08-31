# TogetherVideo 2.1

只供两个人使用的固定房间同步观影网站。

2.1 继续保持最重要的原则：**TogetherVideo 服务器不代理视频数据**。服务器只负责 WebDAV 元数据、临时播放地址发现和双人同步；真正的视频字节仍由 123 云盘/CDN 直接发送到各自浏览器。

## 2.1 新增：双播放器核心

2.1 不再把所有视频兼容性都押在原生 `<video>` 上：

```text
选择视频
   │
   ▼
原生 HTML5 Video
   │
   ├─ 能播放 ───────────────→ 继续使用原生播放器
   │
   └─ 解码 / 媒体源失败
          │
          ▼
   libmedia AVPlayer
          │
          ├─ MP4 自行解封装
          ├─ WebCodecs / MSE / 硬件解码优先
          └─ WASM 软件解码兜底
```

HEVC 兼容核心使用 `@libmedia/avplayer`。原生播放器失败时自动切换，不需要手动选择播放器。两套播放器共用同一个同步接口，所以播放、暂停、拖动、倍速、自动对轴和“等等我”仍使用原来的服务端权威时间线。

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

- 两个人的在线与缓冲状态
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

2.1 保留浏览器 Service Worker 本地兼容层。它可以在浏览器本地透传 Range，并把交给原生 `<video>` 的响应修正为正确的视频 MIME 和 `inline`，同时保留 206 / Content-Range。

如果原生播放器仍然因为 HEVC、封装或浏览器媒体管线失败，2.1 会自动切换到 libmedia AVPlayer。AVPlayer 直接通过 Fetch/Range 读取 123 地址并自行解封装，不依赖 123 的视频 MIME。

## HEVC / H.265

2.1 的目标是让 HEVC 文件不必为了网页播放而预先全部转成 H.264。

兼容播放器优先尝试浏览器硬件能力：

- MediaSource / MSE
- WebCodecs
- 硬件解码

如果硬件路径不可用，libmedia 可以加载对应 WASM 解码器作为兜底。实际 4K HEVC 软件解码仍受设备 CPU、内存、温度和浏览器限制，因此不能保证所有老旧手机都能流畅软解 4K。

跨所有浏览器最稳妥的格式仍然是：

```text
MP4 + H.264 / AVC + AAC-LC
```

但 2.1 会主动尝试兼容 HEVC，而不是一遇到 HEVC 就要求用户转码。

## 同步功能

- 永久只有一个房间，最多两个人在线
- 当前视频同步
- 播放 / 暂停同步
- 拖动进度同步
- 0.5× / 0.75× / 1× / 1.25× / 1.5× / 2× 倍速同步
- 小偏差通过轻微临时倍速平滑追赶
- 大偏差才硬 seek
- 缓冲保护：一方持续缓冲时双方暂时暂停
- “等等我”一键暂停双方
- Socket.IO 自动重连
- 重连后恢复媒体、进度、播放状态和倍速
- 手机端播放器优先布局

服务端保存唯一权威时间线，包括 `media`、`mediaVersion`、`playing`、`position`、`rate`、`anchorAt` 和 `revision`。客户端定期测量 RTT 并与服务端时间线校准；底层播放器换成 HEVC 兼容核心时，同步协议不会改变。

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

根目录通常可以使用：

```text
/
```

先点击 **测试连接**，成功后点击 **保存并使用**。

WebDAV 密码保存在服务器 `data/settings.json` 中，设置 API 不会把密码明文返回前端。

## 部署

要求：

- Node.js 20+
- `data/` 可持久化
- 生产环境使用 HTTPS

安装：

```bash
npm install
```

启动：

```bash
npm start
```

默认端口：

```text
3000
```

自动部署平台提供 `PORT` 时会自动使用该端口。

首次默认站点密码：

```text
change-me
```

登录后请在设置中修改。

## HTTPS

2.1 强烈要求生产环境通过 HTTPS 访问，因为 Service Worker 和部分现代浏览器媒体能力依赖安全上下文。

推荐：

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

TogetherVideo 自身仍可以监听本机 HTTP 端口。

## 持久化

部署平台需要持久化：

```text
data/
```

其中主要包含：

```text
data/settings.json
data/watch-state.json
```

升级 2.0 → 2.1 不需要清空数据目录。

## 开发检查

```bash
npm install
npm run check
```

CI 会检查：

- 服务端和浏览器脚本语法
- 运行时依赖是否完整
- libmedia AVPlayer ESM 主文件和动态 chunk 是否实际安装
- AVPlayer 发布文件是否包含浏览器无法直接解析的裸 `@libmedia/*` import
- WebDAV 解析与认证重定向安全规则
- 单房间和同步状态回归测试

## 第三方组件

2.1 使用 `@libmedia/avplayer` 作为原生播放失败时的浏览器兼容核心。其许可和归属信息见 `THIRD_PARTY_NOTICES.md`。
