# TogetherVideo 3.0

只供两个人使用的固定房间同步观影网站。

3.0 继续保持最重要的原则：**TogetherVideo 服务器不代理视频数据**。服务器只负责 WebDAV 元数据、临时播放地址发现和双人同步；真正的视频字节仍由 123 云盘/CDN 直接发送到各自浏览器。

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
