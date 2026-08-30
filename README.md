# TogetherVideo

TogetherVideo 是一个给两个人使用的私人“一起看”网站。它把 **夸克网盘 + OpenList + 双人同步播放器**整合到一个 Node.js 项目里。

当前版本专门面向 **“部署平台只允许提供 GitHub 仓库链接”** 的场景：

- 不使用 Docker
- 不要求 SSH 登录服务器
- 不要求手动安装 OpenList
- 不要求手动修改 `.env`
- 不要求进入 OpenList 管理后台
- 不要求手动配置 systemd / Nginx

部署平台只要能够运行 Node.js 20+，执行 `npm install` 和 `npm start`，TogetherVideo 就会自动准备 OpenList。夸克授权、片库目录和网站密码都可以在 TogetherVideo 网页里完成。

> **低带宽设计：** TogetherVideo 不代理视频字节。播放接口只解析 OpenList / QuarkTV 地址并返回 HTTP 302，视频应由浏览器直接从夸克/CDN获取。对于 4 Mbps 一类的小带宽服务器，这是必须保持的工作方式。

---

## 1. 已实现功能

- 站点密码 + 昵称登录
- 首次启动网页配置向导
- 自动下载并启动 OpenList
- 网页直接生成 QuarkTV 登录二维码
- 使用夸克 App 扫码授权
- 网页设置媒体根目录
- OpenList 目录浏览
- 中文 / 数字自然排序
- 默认最多 2 人的同步房间
- 切换剧集同步
- 播放 / 暂停同步
- 拖动进度同步
- 倍速同步
- 每 5 秒播放进度校准
- 小幅漂移使用短暂倍速修正
- 大幅漂移直接校准
- 后加入房间时恢复当前剧集和进度
- 在线成员显示
- 房间聊天
- Emoji 表情反应
- MP4 / WebM 原生播放
- m3u8 使用本地 hls.js
- PC / 手机响应式页面
- 房间状态、聊天记录和站点配置持久化
- `/healthz` 健康检查

---

## 2. 架构

```text
                         ┌──────────────────┐
                         │     夸克网盘     │
                         │     QuarkTV      │
                         └────────┬─────────┘
                                  │
                            视频/CDN直链
                                  │
                                  ▼
                           用户浏览器播放
                                  ▲
                                  │
                     视频字节不经过服务器
                                  │
用户浏览器 ── HTTP/WebSocket ──> TogetherVideo
                                  │
                             本机 API 请求
                                  │
                                  ▼
                           OpenList 子进程
                         127.0.0.1:5244
```

TogetherVideo 的 `/api/play` 流程是：

```text
浏览器
  ↓
TogetherVideo /api/play
  ↓
OpenList /api/fs/get
  ↓
取得 QuarkTV raw_url
  ↓
HTTP 302
  ↓
浏览器直接连接夸克/CDN
```

代码中没有视频 `pipe()`、Range 中转或服务器转码逻辑。

---

# 3. 自动化部署要求

部署平台需要满足：

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Linux |
| CPU | x86_64 / amd64 或 arm64 |
| Node.js | 20 或更高 |
| 安装命令 | `npm install` |
| 启动命令 | `npm start` |
| 对外端口 | 使用平台提供的 `PORT`，未提供时默认 `3000` |
| 文件写入 | 项目目录必须可写 |
| 子进程 | 必须允许 Node.js 启动 OpenList 子进程 |
| 外网访问 | 服务器需要能访问 GitHub Releases 和夸克服务 |

通常只需要向自动部署平台提供：

```text
https://github.com/Aaron-0303/TogetherVideo.git
```

如果平台要求填写构建 / 启动命令：

```text
Build / Install: npm install
Start:           npm start
```

TogetherVideo 默认监听：

```text
0.0.0.0:$PORT
```

因此部署平台只需要暴露 TogetherVideo 自己的端口。**OpenList 的 5244 不需要暴露公网。**

---

# 4. 第一次启动会发生什么

第一次执行：

```bash
npm start
```

`launcher.js` 会自动完成：

1. 判断服务器 CPU 架构；
2. 从 OpenList 官方 GitHub Release 下载对应 Linux 二进制；
3. 解压到：

```text
.runtime/openlist/
```

4. 在本机启动 OpenList：

```text
127.0.0.1:5244
```

5. 自动生成一个随机的 OpenList 内部管理员密码；
6. 该密码只保存在服务器本地，不显示给普通用户；
7. 启动 TogetherVideo；
8. TogetherVideo 通过本机 OpenList 管理 API 完成后续 QuarkTV 配置。

所以你不需要自己安装或登录 OpenList。

---

# 5. 第一次打开网站

第一次打开部署好的 TogetherVideo 网站时：

```text
昵称：随便填写
访问密码：change-me
```

这是仅用于首次进入的默认密码。

登录后网站会自动打开 **“媒体与站点设置”**。

建议第一次配置完成后立即在设置页修改访问密码。

> 因为首次密码是公开默认值，部署完成后应尽快打开网站完成初始化，不要长期保持 `change-me`。

---

# 6. 网页配置夸克

不需要进入 OpenList 后台。

在 TogetherVideo：

```text
设置
  ↓
媒体与站点设置
  ↓
夸克网盘（QuarkTV）
```

点击：

```text
生成登录二维码
```

TogetherVideo 会通过 OpenList 管理 API 自动创建：

```text
挂载路径：/QuarkTV
驱动：QuarkTV
视频链接方式：download
Web Proxy：关闭
Proxy Range：关闭
```

页面随后显示二维码。

使用手机上的 **夸克 App** 扫码并确认授权，然后点击：

```text
我已扫码，完成授权
```

TogetherVideo 会自动重新初始化 QuarkTV 挂载并检查授权状态。

成功后页面显示：

```text
QuarkTV 已连接
```

如果二维码过期，可以点击：

```text
重新生成二维码
```

---

# 7. 设置片库目录

QuarkTV 授权完成以后，默认片库根目录为：

```text
/QuarkTV
```

即显示整个夸克网盘。

如果你的电视剧在：

```text
夸克网盘/
└── 电视剧/
    ├── 想见你/
    ├── 庆余年/
    └── ...
```

可以在网页设置中填写：

```text
/QuarkTV/电视剧
```

点击：

```text
保存片库目录
```

无需重启应用。

TogetherVideo 会限制片库浏览范围在该目录及其子目录内。

---

# 8. 修改访问密码

在：

```text
设置 → 修改网站访问密码
```

输入至少 6 个字符的新密码即可。

密码不会明文写入 `settings.json`，TogetherVideo 保存的是密码哈希。

---

# 9. 持久化非常重要

自动化部署平台必须保留以下数据：

```text
.runtime/openlist/
data/
```

其中：

```text
.runtime/openlist/
├── openlist                 OpenList 程序
├── data/                    OpenList 数据库、QuarkTV token 等
├── .admin-secret            内部随机管理员密码
└── .admin-ready             初始化标记

data/
├── settings.json            TogetherVideo 配置
└── state.json               房间状态、聊天等
```

如果部署平台每次重新部署都会删除整个工作目录，应给以下目录配置持久化磁盘 / Volume：

```text
.runtime/openlist
/data
```

实际挂载路径应以部署平台的项目工作目录为准。

如果这些目录被删除：

- QuarkTV 需要重新扫码；
- 网站密码会恢复；
- 房间历史会丢失。

普通服务器上直接 `git pull` 更新不会删除这些目录，因为它们已经加入 `.gitignore`。

---

# 10. 服务器带宽为什么够用

TogetherVideo 本身只承担：

```text
HTML / CSS / JS
OpenList API 查询
Socket.IO 同步
聊天
少量状态数据
```

视频应当：

```text
浏览器 ─────────────────→ 夸克/CDN
```

而不是：

```text
夸克 → 服务器 → 浏览器
```

因此即使服务器只有：

```text
4 Mbps
300 GB / 月
```

只要 QuarkTV 直链工作正常，服务器带宽通常不是主要瓶颈。

---

# 11. 如何确认没有中转视频

部署完成以后推荐做一次验证。

浏览器打开开发者工具：

```text
F12 → Network / 网络
```

播放一集视频。

应看到类似：

```text
/api/play
    ↓ 302
夸克 / CDN 域名
```

最终的大量视频数据请求应该来自夸克/CDN，而不是 TogetherVideo 服务器。

如果媒体数据持续来自 TogetherVideo 的服务器域名，并产生高带宽流量，应停止使用并检查 QuarkTV 链接方式。

---

# 12. 视频格式兼容性

网页浏览器最稳定的是：

```text
MP4
H.264
AAC
```

可能存在兼容问题：

```text
MKV
H.265 / HEVC
DTS
ASS 内封字幕
```

OpenList 能获得文件并不代表浏览器一定能够解码。

TogetherVideo 故意不做服务器转码，因为转码会明显增加服务器 CPU 和带宽压力。

---

# 13. 可选环境变量

**正常自动部署不需要创建 `.env`。**

如果部署平台需要特殊设置，可以参考 `.env.example`。

常用可选变量：

```env
PORT=3000
HOST=0.0.0.0
OPENLIST_MANAGED=true
DEFAULT_ROOM=ours
MAX_ROOM_USERS=2
```

## 使用已有 OpenList

高级场景下，也可以关闭自动 OpenList：

```env
OPENLIST_MANAGED=false
OPENLIST_BASE_URL=http://127.0.0.1:5244
OPENLIST_ADMIN_PASSWORD=已有OpenList管理员密码
```

普通用户不需要这样做。

---

# 14. 健康检查

部署平台可以把健康检查配置为：

```text
/healthz
```

正常返回：

```json
{
  "ok": true
}
```

如果 OpenList 自动下载 / 启动失败，健康检查仍会保留 TogetherVideo 进程，并在响应或网页设置页显示 bootstrap 错误，方便定位自动部署环境限制。

---

# 15. 更新

更新 TogetherVideo 只需要让部署平台重新拉取 GitHub 主分支并执行：

```text
npm install
npm start
```

只要 `.runtime/openlist/` 和 `data/` 被保留，夸克授权和站点配置无需重做。

---

# 16. 开发检查

```bash
npm run check
```

用于检查 Node.js / 浏览器脚本语法。

---

# 17. 自动部署检查表

部署人员只需要确认：

- [ ] 仓库使用 `main`
- [ ] Node.js >= 20
- [ ] 安装命令为 `npm install`
- [ ] 启动命令为 `npm start`
- [ ] 对外暴露 `$PORT`
- [ ] 允许应用写项目目录
- [ ] 允许 Node.js 创建子进程
- [ ] 能访问 GitHub Releases
- [ ] `.runtime/openlist/` 有持久化
- [ ] `data/` 有持久化
- [ ] 打开网页，使用 `change-me` 首次登录
- [ ] 网页中完成 QuarkTV 扫码
- [ ] 修改网站访问密码
- [ ] 选择片库目录
- [ ] 播放视频后确认 `/api/play` 跳转到夸克/CDN

做到这些即可，不需要登录服务器操作。
