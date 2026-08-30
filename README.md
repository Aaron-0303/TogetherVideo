# TogetherVideo 2.0

只供两个人使用的同步观影网站。

2.0 在原项目的 **Node.js + Express + Socket.IO + 原生前端** 基础上继续修改，但旧版的 OpenList / QuarkTV / 多房间逻辑已经废弃。网站现在永久只有一个固定影院，不需要创建房间、加入房间、复制房间链接或输入房间码。

## 核心架构

```text
浏览器 A ─────────────────────→ 123 云盘 / WebDAV
   │                                 ↑
   │ WebSocket                       │ 视频数据
   ↓                                 │
TogetherVideo 自建服务器             │
   ↑                                 │
   │ WebSocket                       │
   │                                 │
浏览器 B ─────────────────────→ 123 云盘 / WebDAV
```

TogetherVideo 服务器只负责：

- 两个人的在线和缓冲状态
- 播放 / 暂停 / 拖动 / 倍速同步
- 自动对轴
- “等等我”
- WebDAV 连接测试与目录列表
- 使用 WebDAV 凭据探测文件请求返回的 302 / 签名直链

**服务器没有视频代理接口，不会 pipe 视频，不会转发 Range 视频数据，也不会转码。**

## 功能

- 一个固定房间，最多两个人在线
- HTML5 Video 原生播放器：播放、暂停、拖动、音量、全屏
- 0.5×、0.75×、1×、1.25×、1.5×、2× 倍速并同步
- WebDAV 地址、用户名、密码、根目录网页配置
- WebDAV 连接测试、目录浏览、视频选择
- 当前视频同步
- 播放 / 暂停同步
- 进度跳转同步
- 倍速同步
- 小误差轻微调速追赶
- 大误差调整 `currentTime`
- 缓冲时停止硬跳校准，降低“越同步越卡”的概率
- 显示自己和对方在线状态
- 显示对方是否正在缓冲
- Socket.IO 自动重连
- 断线期间的旧操作不会排队到重连后补发
- 重连后恢复当前视频、进度、播放状态和倍速
- “等等我”一键暂停双方
- 手机端播放器优先，片库为侧滑面板

## WebDAV 与视频直连

目录浏览使用标准 WebDAV `PROPFIND`。这些请求只包含目录元数据，不包含视频内容。

播放需要认证的 WebDAV 文件时，流程是：

```text
TogetherVideo
    │  带 WebDAV Basic Auth，只探测 HEAD / 1-byte Range
    ▼
WebDAV
    │
    └── 302 / 307 Location ──→ 临时下载地址
                                 │
                                 ▼
                        返回给 HTML5 Video
                                 │
                                 ▼
                           浏览器直接播放
```

TogetherVideo 不把 WebDAV 用户名和密码放进播放器 URL。现代浏览器通常会阻止带 `user:password@host` 的媒体子资源，因此 2.0 要求需要认证的 WebDAV 在文件请求时能够返回浏览器可访问的 302 / 307 / 签名直链。

如果某个 WebDAV 只能在认证后直接返回文件正文、却不提供浏览器可用的重定向地址，网站会明确报错，而**不会为了能播而退化成服务器视频代理**。

123 云盘官网目前明确提供 WebDAV 协议挂载和第三方应用直连能力。本项目只使用 WebDAV / 普通下载链路，不默认启用其收费的直链 CDN 或音视频分发服务。

## 推荐视频格式

浏览器兼容性最稳妥的是：

```text
MP4 + H.264 / AVC + AAC
```

`.mp4` 只是封装格式。如果内部视频编码是 H.265 / HEVC，或音频使用 DTS 等编码，不同浏览器仍可能黑屏或无声。2.0 不做服务器转码。

## 自动对轴

服务端保存唯一权威时间线：

```text
media
mediaVersion
playing
position
rate
anchorAt
revision
```

播放状态为 `playing=true` 时，后端使用 `anchorAt` 动态计算当前理论进度。

客户端大约每 4 秒与服务器校时，并测量一次 WebSocket 往返时间用于修正目标时间。

基本策略：

```text
误差 <= 0.25 秒
    不处理

约 0.35 ~ 1.8 秒
    临时轻微修改 playbackRate 追赶

> 1.8 秒
    非缓冲状态下调整 currentTime
```

为了减少卡顿：

- `waiting / stalled` 时不硬跳进度
- 缓冲时恢复正常倍速，不继续加速追赶
- 自动硬校准之间至少间隔约 6 秒
- 换视频后使用 `mediaVersion` 丢弃上一视频迟到的旧事件
- 程序触发的 play / pause / seek / ratechange 不会反向当作用户操作广播
- 用户点击“立即对轴”时才主动强制跟随服务器最新位置

## “等等我”

任意一方点击：

```text
等等我
```

服务器立即把唯一权威时间线改为暂停，然后同时广播给两个人。

适合一方加载较慢、临时离开或网络突然变差时使用。

## 在线和缓冲状态

顶部显示：

```text
1 / 2 在线
2 / 2 在线
```

播放器下方分别显示自己和对方状态。浏览器发生持续 `waiting / stalled` 时会向服务器上报缓冲状态，对方可以直接看到“正在缓冲”。

## 断线恢复

Socket.IO 自动重连。断线期间的播放控制不会排队。

重新连接后客户端会：

1. 获取当前唯一房间状态
2. 恢复当前视频
3. 重新取得 WebDAV 直链
4. 恢复进度和倍速
5. 恢复播放 / 暂停状态
6. 继续自动对轴

## WebDAV 设置

首次进入网站后打开 **设置**，填写：

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

根目录例如：

```text
/
```

或：

```text
/影视/电视剧
```

先点击 **测试连接**，成功后点击 **保存并使用**。

WebDAV 密码保存在服务器的 `data/settings.json`，文件以私有权限创建。设置 API 不会把密码明文返回网页；之后密码输入框留空表示继续使用已保存密码。

## 部署

仓库：

```text
https://github.com/Aaron-0303/TogetherVideo.git
```

要求：

- Linux 或其他可运行 Node.js 的环境
- Node.js 20+
- `data/` 目录可持久化

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

自动部署平台如果提供 `PORT`，程序会自动使用该端口。

首次访问默认站点密码：

```text
change-me
```

登录后请在“设置”里立即修改。

## 可选环境变量

WebDAV 不需要环境变量，直接在网页里配置即可。

`.env.example` 中只有部署层参数：

```env
HOST=0.0.0.0
PORT=3000
SITE_PASSWORD=change-me
COOKIE_SECURE=false
TRUST_PROXY=true
DATA_DIR=./data
```

网站固定两个人，不提供可修改的房间数或人数参数。

## 持久化

部署平台必须持久化：

```text
data/
```

主要保存：

```text
data/settings.json
  WebDAV 配置
  站点密码哈希
  Session 密钥

data/watch-state.json
  当前视频
  播放状态
  进度
  倍速
```

## HTTPS

生产环境建议使用 HTTPS，尤其因为设置页面需要提交 WebDAV 密码。

如果 HTTPS 由部署平台 / 反向代理终止：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

如果当前仍是普通 HTTP：

```env
COOKIE_SECURE=false
```

## 开发检查

```bash
npm install
npm run check
```

检查包含 JavaScript 语法以及单房间状态、旧媒体事件隔离、WebDAV PROPFIND 解析和“认证 WebDAV 必须提供浏览器直链”的回归测试。
