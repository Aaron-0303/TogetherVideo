# TogetherVideo 2.0

一个只供两个人使用的同步观影网站。

2.0 基于原项目的 **Node.js + Express + Socket.IO + 原生前端** 继续修改，但旧的 OpenList / QuarkTV / 多房间逻辑已经废弃。现在只有一个固定影院，不需要创建房间、加入房间或房间码。

## 核心架构

```text
浏览器 A ───────────────→ 123 云盘 / WebDAV
   │                           ↑
   │ WebSocket                 │ 视频字节
   ↓                           │
TogetherVideo 自建服务器       │
   ↑                           │
   │ WebSocket                 │
   │                           │
浏览器 B ───────────────→ 123 云盘 / WebDAV
```

TogetherVideo 服务器只负责：

- 两个人的在线状态
- 播放 / 暂停 / 拖动 / 倍速同步
- 自动对轴
- “等等我”
- WebDAV 目录列表
- 使用 WebDAV 凭据解析文件请求返回的 302 / 直链

**服务器没有任何视频代理接口，也不会转发 Range 请求或视频数据。**

## 主要功能

- 固定单房间，最多两个人在线
- HTML5 Video 播放器
- WebDAV 地址 / 用户名 / 密码 / 根目录网页配置
- WebDAV 连接测试
- 目录浏览和视频选择
- 当前视频同步
- 播放 / 暂停同步
- 进度跳转同步
- 倍速同步
- 小误差轻微调速追赶
- 大误差自动调整 `currentTime`
- 缓冲期间暂停硬跳校准，避免“越同步越卡”
- 显示对方在线 / 离线 / 缓冲中
- WebSocket 自动重连
- 重连后恢复视频、进度、播放状态和倍速
- “等等我”按钮：点击后双方暂停
- 手机端播放器优先，片库使用侧边抽屉

## WebDAV 播放方式

TogetherVideo 使用 WebDAV 账号在后端执行 `PROPFIND` 来读取目录。

播放视频时，后端只做一次轻量的直链探测：

```text
TogetherVideo → WebDAV（带认证，只探测响应）
                   ↓
              302 Location
                   ↓
TogetherVideo 把直链 URL 告诉浏览器
                   ↓
浏览器 ─────────────────→ 云盘文件
```

如果 WebDAV 本身不需要认证，播放器可以直接使用 WebDAV 文件 URL。

如果 WebDAV 需要 Basic Auth，则它必须在文件 GET/HEAD 时返回可以由浏览器直接访问的 302 / 签名直链。若只返回文件正文而不提供直链，TogetherVideo 会明确报错，而不是退化成服务器代理视频。

这是 2.0 的硬性设计原则。

> 对 123 云盘：使用其 WebDAV 能力即可。本项目不会默认启用 123 云盘收费的音视频分发 / CDN 产品。

## 自动部署

部署平台只需要支持：

- Linux
- Node.js 20+
- 项目目录可持久化（至少 `data/`）

仓库：

```text
https://github.com/Aaron-0303/TogetherVideo.git
```

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

如果平台提供 `PORT`，程序会自动使用该端口。

## 第一次使用

打开网站后使用默认密码：

```text
change-me
```

昵称随便填写，然后进入设置。

### 配置 WebDAV

填写：

```text
WebDAV 地址
用户名
密码
根目录
```

根目录可以是：

```text
/
```

或者：

```text
/影视/电视剧
```

先点击 **测试连接**，成功后点击 **保存 WebDAV**。

密码保存后，设置页不会再次返回密码明文；以后密码输入框留空表示继续使用已经保存的密码。

然后修改网站默认访问密码。

## 两个人怎么使用

两个人打开同一个网站，各自填写昵称和网站访问密码即可。

不需要：

- 创建房间
- 输入房间号
- 复制房间链接
- 加入房间

服务器最多保留两个在线参与者。相同昵称重新连接时，新连接会替换旧连接，避免手机切网或页面刷新后临时占满名额。

## 自动对轴逻辑

后端保存权威播放状态：

```text
当前视频
mediaVersion
playing
position
rate
startedAt
revision
```

播放时后端根据 `startedAt` 动态计算当前理论位置。

客户端周期性比较自己的 `currentTime`：

```text
误差 <= 0.3 秒
    不处理

0.3 ~ 1.5 秒
    临时轻微调整 playbackRate

> 1.5 秒
    网络稳定时直接校正 currentTime
```

为了避免卡顿：

- 正在 `waiting / stalled` 时不做硬跳
- 刚结束缓冲后的几秒内不做硬跳
- 两次自动硬跳之间至少间隔约 5 秒
- 缓冲恢复后先正常播放，再继续对轴
- 用户点击“重新对轴”才会立即强制校正

## 断线恢复

Socket.IO 会自动重连。

重连后：

1. 重新进入唯一影院
2. 获取服务器权威状态
3. 恢复当前视频
4. 获取新的 WebDAV 直链
5. 恢复进度、倍速和播放 / 暂停状态
6. 继续自动对轴

断线期间不会把旧的播放器操作排队到服务器。

## “等等我”

任意一方点击：

```text
等等我
```

后端立即把权威状态改成暂停，并广播给两个人。

适合一方加载较慢、临时离开或网络突然变差时使用。

## 支持的视频格式

浏览器实际能否播放取决于文件的容器、视频编码和音频编码。

推荐：

```text
MP4
H.264 / AVC
AAC
```

MP4 只是容器。如果 MP4 内部是 H.265 / HEVC，部分浏览器仍然可能黑屏或提示无法解码。

TogetherVideo 2.0 不做转码，因为转码会违背“自建服务器只负责对轴”的目标。

## 环境变量

绝大多数配置可以直接在网页完成。

可选环境变量见 `.env.example`：

```env
HOST=0.0.0.0
PORT=3000
COOKIE_SECURE=false
TRUST_PROXY=true
WEBDAV_TIMEOUT_MS=15000
DATA_FILE=./data/state.json
SETTINGS_FILE=./data/settings.json
```

也可以预设：

```env
WEBDAV_URL=
WEBDAV_USERNAME=
WEBDAV_PASSWORD=
WEBDAV_ROOT=/
```

## 持久化

至少持久化：

```text
data/settings.json
data/state.json
```

其中包含 WebDAV 配置、网站密码哈希、Session 密钥和当前同步状态。

## HTTPS

生产环境建议使用 HTTPS，尤其是因为设置页面需要提交 WebDAV 密码。

HTTPS 后可以设置：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

如果部署平台当前仍然只提供 HTTP，则保持：

```env
COOKIE_SECURE=false
```

## 开发检查

```bash
npm install
npm run check
```

`npm run check` 会执行 JavaScript 语法检查，以及固定房间状态 / WebDAV 目录与直链解析的回归测试。
