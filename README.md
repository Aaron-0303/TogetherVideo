# TogetherVideo

TogetherVideo 是一个面向两个人使用的私人“一起看”网站。

OpenList 负责连接夸克网盘并提供目录和播放地址；TogetherVideo 负责登录、片库浏览、房间、播放同步、聊天和表情互动。

本项目的核心目标是：**尽量不让低带宽服务器承担视频流量。**

> 当前版本已经可以交付部署。真实环境上线前最重要的一步不是“能打开网页”，而是确认视频请求确实通过 **302 跳转到夸克/CDN**，而不是由服务器中转。

---

## 目录

- [功能](#功能)
- [架构](#架构)
- [低带宽服务器说明](#低带宽服务器说明)
- [目录结构](#目录结构)
- [部署前准备](#部署前准备)
- [推荐部署：Docker Compose](#推荐部署docker-compose)
- [OpenList 初始化](#openlist-初始化)
- [挂载 QuarkTV](#挂载-quarktv)
- [TogetherVideo 配置](#togethervideo-配置)
- [启动服务](#启动服务)
- [首次验证](#首次验证)
- [必须验证：视频是否真正走 302](#必须验证视频是否真正走-302)
- [Nginx 与域名](#nginx-与域名)
- [HTTPS](#https)
- [服务器安全建议](#服务器安全建议)
- [视频兼容性](#视频兼容性)
- [更新](#更新)
- [备份](#备份)
- [常见问题](#常见问题)
- [裸机 Nodejs 运行](#裸机-nodejs-运行)
- [开发检查](#开发检查)
- [交付部署检查表](#交付部署检查表)

---

## 功能

当前版本已实现：

- 站点密码 + 昵称登录
- OpenList 目录浏览
- 中文/数字自然排序
- 两人房间，默认最多 2 人
- 切换剧集同步
- 播放 / 暂停同步
- 拖动进度同步
- 倍速同步
- 每 5 秒进行一次播放进度校准
- 小幅时间漂移使用短暂倍速修正
- 大幅时间漂移直接校准
- 后加入房间时自动恢复当前剧集和进度
- 浏览器阻止自动播放时显示继续同步提示
- 在线成员显示
- 房间聊天
- Emoji 表情反应
- 房间状态和聊天记录持久化
- MP4 / WebM 原生播放
- m3u8 使用本地安装的 hls.js
- PC / 手机响应式页面
- Docker / Docker Compose
- Nginx 示例配置
- `/healthz` 健康检查

---

## 架构

```text
                         ┌─────────────────────┐
                         │      夸克网盘       │
                         │    Quark / QuarkTV  │
                         └──────────┬──────────┘
                                    │
                              网盘/CDN直链
                                    │
                                    ▼
┌─────────────────┐       ┌─────────────────┐
│   浏览器 A      │       │   浏览器 B      │
│                 │       │                 │
│ HTML5 Player    │       │ HTML5 Player    │
└───────┬─────────┘       └───────┬─────────┘
        │                           │
        │ 页面/API/Socket.IO       │ 页面/API/Socket.IO
        └────────────┬──────────────┘
                     │
                     ▼
             ┌───────────────┐
             │ TogetherVideo │
             │ Node.js       │
             │ Socket.IO     │
             └───────┬───────┘
                     │ OpenList API
                     ▼
             ┌───────────────┐
             │   OpenList    │
             └───────────────┘
```

播放一个视频时：

```text
1. 浏览器请求 TogetherVideo /api/play
2. TogetherVideo 调用 OpenList /api/fs/get
3. OpenList 返回 raw_url / 可访问播放地址
4. TogetherVideo 返回 HTTP 302
5. 浏览器直接访问夸克/CDN
```

TogetherVideo **不会主动代理视频字节**。

---

## 低带宽服务器说明

如果服务器只有例如：

```text
4 Mbps
300 GB / 月
```

仍然可以运行 TogetherVideo，前提是视频真正走网盘/CDN 直链。

推荐的数据路径：

```text
浏览器 ──网页/API/WebSocket──> TogetherVideo

浏览器 ──────视频数据────────> 夸克/CDN
```

错误的数据路径：

```text
夸克 ──视频──> OpenList/服务器 ──视频──> 浏览器
```

如果视频经过服务器中转，4 Mbps 很容易成为瓶颈，两个人同时看 1080P 基本不可接受。

因此本项目部署时必须优先使用 OpenList 的 **QuarkTV + 302** 方案。

普通 Quark 驱动在某些情况下会启用 Local Proxy，本地代理意味着视频流量经过 OpenList 服务器，不适合小带宽机器。

---

## 目录结构

```text
TogetherVideo/
├── server.js
├── package.json
├── Dockerfile
├── docker-compose.yml
├── nginx.example.conf
├── .env.example
│
├── src/
│   ├── config.js
│   ├── openlist.js
│   ├── rooms.js
│   └── store.js
│
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── manifest.webmanifest
│
├── data/                  # 运行后生成，TogetherVideo 状态
└── openlist-data/         # 运行后生成，OpenList 配置
```

---

# 部署

## 部署前准备

推荐环境：

```text
Ubuntu 22.04 / 24.04
Docker Engine
Docker Compose v2
Git
Nginx（如果需要域名/HTTPS）
```

检查：

```bash
docker --version
docker compose version
git --version
```

如果还没有 Docker，请优先按照 Docker 官方文档安装。

也可以使用官方安装脚本：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

重新登录 SSH 后检查：

```bash
docker ps
```

---

## 推荐部署：Docker Compose

建议放在 `/opt`：

```bash
cd /opt
sudo git clone https://github.com/Aaron-0303/TogetherVideo.git
sudo chown -R $USER:$USER /opt/TogetherVideo
cd /opt/TogetherVideo
```

创建配置：

```bash
cp .env.example .env
```

先生成一个 Session Secret：

```bash
openssl rand -hex 32
```

然后编辑：

```bash
nano .env
```

---

## OpenList 初始化

仓库中的 `docker-compose.yml` 已包含 OpenList：

```yaml
openlist:
  image: openlistteam/openlist:latest
```

首次启动 OpenList：

```bash
docker compose up -d openlist
```

查看状态：

```bash
docker ps
```

查看 OpenList 首次生成的管理员密码：

```bash
docker logs openlist
```

日志中会看到类似：

```text
Successfully created the admin user and the initial password is: xxxxxxxxx
```

如果忘记管理员密码，可以重新设置：

```bash
docker exec -it openlist ./openlist admin set NEW_PASSWORD
```

或者生成随机密码：

```bash
docker exec -it openlist ./openlist admin random
```

OpenList 默认端口：

```text
5244
```

临时访问：

```text
http://服务器IP:5244
```

> OpenList 管理后台配置完成后，不建议长期把 5244 对整个公网开放。详见后面的安全建议。

OpenList 官方 Docker 文档：

```text
https://doc.oplist.org/guide/installation/docker
```

---

## 挂载 QuarkTV

登录 OpenList 管理后台后：

```text
管理 → 存储 → 添加
```

优先选择：

```text
QuarkTV
```

而不是普通：

```text
Quark
```

按照 OpenList 页面要求完成夸克账号登录/扫码授权。

建议只挂载真正需要的电视剧目录，例如最终在 OpenList 中形成：

```text
/QuarkTV/电视剧
├── 庆余年
│   ├── 01.mp4
│   ├── 02.mp4
│   └── ...
├── 想见你
└── ...
```

部署人员需要记录最终媒体根目录，例如：

```text
/QuarkTV/电视剧
```

这个值之后填写到：

```env
OPENLIST_ROOT=/QuarkTV/电视剧
```

### OpenList 配置原则

为了减少服务器带宽：

1. 优先 QuarkTV。
2. 使用 302/直链播放。
3. 不要主动开启 Web Proxy / Native Proxy 等本地中转模式。
4. 不要让 TogetherVideo 通过服务器下载完整视频后再转发。
5. 正式使用前必须实际检查浏览器 Network 请求。

---

## TogetherVideo 配置

`.env.example` 当前包含：

```env
PORT=3000
SITE_PASSWORD=replace-with-a-strong-password
SESSION_SECRET=replace-with-a-long-random-string
COOKIE_SECURE=false
TRUST_PROXY=false
DEFAULT_ROOM=ours
MAX_ROOM_USERS=2

OPENLIST_BASE_URL=http://openlist:5244
OPENLIST_PUBLIC_URL=
OPENLIST_TOKEN=
OPENLIST_ROOT=/
OPENLIST_PATH_PASSWORD=
OPENLIST_TIMEOUT_MS=15000

DATA_FILE=/app/data/state.json
```

### 必填配置

至少需要修改：

```env
SITE_PASSWORD=网站进入密码
SESSION_SECRET=随机生成的长字符串
OPENLIST_ROOT=/QuarkTV/电视剧
```

默认 Docker Compose 中，TogetherVideo 与 OpenList 在同一个 Docker 网络，因此：

```env
OPENLIST_BASE_URL=http://openlist:5244
```

通常不需要改。

### OPENLIST_TOKEN

如果 OpenList 的媒体路径允许匿名读取：

```env
OPENLIST_TOKEN=
```

可以保持为空。

如果目录需要登录，则需要配置 OpenList API Token：

```env
OPENLIST_TOKEN=xxxxxxxx
```

Token 只会存在 TogetherVideo 后端环境中，**不会发送给浏览器**。

推荐给 TogetherVideo 使用受限/只读权限，而不是暴露 OpenList 管理员凭据。

### OPENLIST_PUBLIC_URL

通常：

```env
OPENLIST_PUBLIC_URL=
```

可以留空。

如果 OpenList `/api/fs/get` 返回相对播放路径，而不是完整 `raw_url`，才需要设置浏览器能够访问的 OpenList 公网地址，例如：

```env
OPENLIST_PUBLIC_URL=https://disk.example.com
```

### HTTPS 之后

如果外部由 Nginx / Cloudflare 提供 HTTPS：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

HTTP 临时测试阶段：

```env
TRUST_PROXY=false
COOKIE_SECURE=false
```

---

## 启动服务

配置完成后：

```bash
cd /opt/TogetherVideo
docker compose pull
docker compose up -d --build
```

查看容器：

```bash
docker compose ps
```

正常应看到：

```text
openlist          running
together-video    running
```

查看 TogetherVideo 日志：

```bash
docker logs -f together-video
```

查看 OpenList 日志：

```bash
docker logs -f openlist
```

---

## 首次验证

### 1. 健康检查

服务器本机：

```bash
curl http://127.0.0.1:3000/healthz
```

正常返回：

```json
{"ok":true}
```

### 2. 打开 TogetherVideo

临时：

```text
http://服务器IP:3000
```

输入 `.env` 中配置的：

```text
SITE_PASSWORD
```

以及昵称。

### 3. 检查片库

登录后应该能看到 `OPENLIST_ROOT` 下的目录和视频。

如果看不到：

```bash
docker logs together-video --tail 100
```

重点检查：

```text
OPENLIST_BASE_URL
OPENLIST_ROOT
OPENLIST_TOKEN
OpenList 存储是否正常
```

---

# 必须验证：视频是否真正走 302

对于低带宽服务器，这是整个部署中最重要的一步。

## 方法一：浏览器检查

Chrome / Edge：

```text
F12
→ Network
→ 播放视频
→ 找到 Media / 视频请求
```

正确情况：

```text
TogetherVideo /api/play
        ↓ 302
quark / qdrive / CDN 域名
```

视频主体的数据请求目标应该是夸克/CDN，而不是服务器 IP。

### 正确

```text
Request URL: https://...夸克或CDN...
```

### 错误

如果大部分视频数据持续从下面地址传输：

```text
http(s)://你的服务器IP:3000/...
http(s)://你的服务器IP:5244/...
```

或者 OpenList 服务器的网络出口持续跑满，则很可能发生了本地代理。

此时不要直接上线使用。

先检查：

```text
OpenList 存储是不是 QuarkTV
是否启用了本地代理
是否打开 Web Proxy / Native Proxy
OpenList 返回的 raw_url 是什么
```

## 方法二：观察服务器带宽

播放视频前后执行：

```bash
sudo apt install -y iftop
sudo iftop
```

或者：

```bash
sudo apt install -y nload
nload
```

如果一个 1080P 视频播放时服务器持续产生数 Mbps 出站流量，说明视频很可能经过了服务器。

正常 302 方案下，服务器主要只有页面、API、Socket.IO 等少量流量。

---

## Nginx 与域名

仓库内提供：

```text
nginx.example.conf
```

一个典型 TogetherVideo 反向代理：

```nginx
server {
    listen 80;
    server_name movie.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Socket.IO 依赖 WebSocket，因此：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

不要删。

检查 Nginx：

```bash
sudo nginx -t
```

重载：

```bash
sudo systemctl reload nginx
```

---

## HTTPS

推荐正式使用 HTTPS。

例如 Nginx + Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d movie.example.com
```

证书成功后修改 `.env`：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

重启：

```bash
docker compose up -d
```

---

## 服务器安全建议

### 公网只开放必要端口

正式使用建议只开放：

```text
22/tcp   SSH
80/tcp   HTTP
443/tcp  HTTPS
```

如果已经通过 Nginx 使用域名，TogetherVideo 的：

```text
3000
```

不需要长期向公网开放。

OpenList 的：

```text
5244
```

配置完成后也不建议长期暴露给所有公网地址。

### 腾讯云安全组

正式部署后建议：

```text
22    仅可信 IP 或必要来源
80    0.0.0.0/0
443   0.0.0.0/0
3000  不开放公网
5244  不开放公网，除非确有需要
```

### 不要提交 `.env`

`.env` 已被 `.gitignore` 忽略。

不要把下面内容提交到 GitHub：

```text
SITE_PASSWORD
SESSION_SECRET
OPENLIST_TOKEN
OpenList 管理员密码
夸克 Cookie / Token
```

---

## 视频兼容性

浏览器播放最稳妥的格式：

```text
MP4
H.264 / AVC
AAC
```

通常兼容：

```text
.mp4
.webm
.m3u8
```

可能有问题：

```text
MKV
DTS
ASS 内封字幕
部分 HEVC / H.265
```

注意：

> OpenList 能下载一个文件，不代表浏览器一定能解码这个文件。

TogetherVideo 当前**不做服务器转码**，因为转码会明显增加 CPU/GPU 占用，也可能让服务器成为媒体中转节点。

如果某个视频在 PotPlayer / VLC 能播放但网页不能播放，优先检查编码和封装格式，而不是同步代码。

---

## 更新

进入项目：

```bash
cd /opt/TogetherVideo
```

拉取最新代码：

```bash
git pull origin main
```

更新并重新构建：

```bash
docker compose pull
docker compose up -d --build
```

查看：

```bash
docker compose ps
```

---

## 备份

需要长期保存的主要有两个目录：

```text
./data
./openlist-data
```

其中：

```text
data/
```

保存 TogetherVideo 的房间/聊天/播放状态。

```text
openlist-data/
```

保存 OpenList 配置、用户和存储挂载信息。

简单备份：

```bash
cd /opt/TogetherVideo
sudo tar -czf together-video-backup-$(date +%F).tar.gz data openlist-data .env
```

该备份包含敏感信息，请妥善保存，不要上传到公开仓库。

---

# 常见问题

## 1. 网页打不开

检查：

```bash
docker compose ps
curl http://127.0.0.1:3000/healthz
docker logs together-video --tail 100
```

如果本机可以访问但公网不行，检查：

```text
云服务器安全组
UFW
Nginx
域名解析
```

---

## 2. 登录后没有电视剧

检查 `.env`：

```env
OPENLIST_ROOT=/QuarkTV/电视剧
```

然后进入 OpenList 确认这个目录实际存在。

再检查：

```bash
docker logs together-video --tail 100
```

---

## 3. OpenList 连接失败

Docker Compose 默认：

```env
OPENLIST_BASE_URL=http://openlist:5244
```

不要在 TogetherVideo 容器内写：

```env
OPENLIST_BASE_URL=http://127.0.0.1:5244
```

因为容器中的 `127.0.0.1` 指的是 TogetherVideo 容器自己。

如果 OpenList 是另一个独立服务，则填写后端真正可访问的地址。

---

## 4. 视频点开后一直转圈

先检查浏览器：

```text
F12 → Console
F12 → Network
```

常见原因：

- 夸克播放链接失效
- OpenList 登录状态失效
- QuarkTV 授权过期
- 浏览器不支持该视频编码
- raw_url 需要特殊 Header
- 发生跨域/播放策略问题

TogetherVideo 日志：

```bash
docker logs together-video --tail 200
```

如果出现 provider headers 警告，需要检查该网盘播放地址是否允许浏览器直接访问。

---

## 5. 视频能播，但是非常卡

首先确认是不是服务器在中转。

```bash
nload
```

如果播放时服务器出口接近：

```text
4 Mbps
```

并长期跑满，则大概率没有实现真正的 CDN 直连。

重新检查 QuarkTV 和 OpenList 302 设置。

---

## 6. 两个人画面不同步

先确认：

```text
双方都进入同一个房间
双方网络正常
WebSocket 连接没有被 Nginx 阻断
```

Nginx 必须保留：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

系统会每约 5 秒进行一次状态校准。

---

## 7. 手机浏览器不自动播放

这是移动浏览器的自动播放策略，不一定是网站故障。

TogetherVideo 会显示：

```text
点击继续同步播放
```

用户点击一次后即可继续。

---

## 8. OpenList 管理密码忘了

```bash
docker exec -it openlist ./openlist admin set NEW_PASSWORD
```

或：

```bash
docker exec -it openlist ./openlist admin random
```

---

## 9. 如何确认 TogetherVideo 本身没有代理视频

当前播放接口逻辑：

```text
/api/play
  ↓
OpenList /api/fs/get
  ↓
取得 raw_url
  ↓
res.redirect(302, raw_url)
```

代码中没有媒体 `pipe()`，也没有 Range 视频转发实现。

因此如果服务器仍然产生大量视频流量，应优先检查 OpenList 存储配置，而不是 TogetherVideo Node.js 服务。

---

## 裸机 Nodejs 运行

不推荐生产环境裸机运行，但支持。

要求：

```text
Node.js >= 20
```

安装：

```bash
npm install
```

配置环境变量后启动：

```bash
npm start
```

注意：Node.js 当前不会自动读取 `.env`。

裸机运行需要通过：

```text
systemd
shell export
其他进程管理器
```

注入环境变量。

Docker Compose 已通过：

```yaml
env_file: .env
```

自动处理。

---

## 开发检查

Node.js 20+：

```bash
npm install
npm run check
```

当前 `check` 会检查：

```text
server.js
src/config.js
src/openlist.js
src/store.js
src/rooms.js
public/app.js
```

---

# 交付部署检查表

部署人员完成后，请逐项确认：

```text
[ ] Docker 正常
[ ] OpenList 容器正常
[ ] TogetherVideo 容器正常
[ ] /healthz 返回 {"ok":true}

[ ] OpenList 已添加 QuarkTV
[ ] QuarkTV 登录有效
[ ] OPENLIST_ROOT 指向正确电视剧目录
[ ] TogetherVideo 可以列出电视剧

[ ] 两个浏览器都能登录
[ ] 两个浏览器可以进入同一房间
[ ] 换集可以同步
[ ] 播放/暂停可以同步
[ ] 拖动进度可以同步

[ ] 视频可以正常播放
[ ] 浏览器 Network 确认视频最终请求指向夸克/CDN
[ ] 服务器播放期间没有持续跑满 4 Mbps 出口

[ ] Nginx WebSocket 正常
[ ] 域名正常
[ ] HTTPS 正常
[ ] COOKIE_SECURE=true（HTTPS 后）
[ ] TRUST_PROXY=true（反代后）

[ ] 3000 不直接暴露公网（正式环境）
[ ] 5244 不直接暴露公网（无必要时）
[ ] .env 未提交 GitHub
[ ] OpenList/夸克凭据未提交 GitHub
```

只要“视频最终请求指向夸克/CDN”这一项通过，低带宽服务器才算真正达到本项目预期的部署方式。

---

## 项目状态

当前版本已经完成第一版核心功能，可以进入真实服务器 + OpenList + QuarkTV 联调阶段。

真实环境部署最需要验证的两件事：

1. OpenList QuarkTV 是否稳定返回浏览器可直接访问的播放地址。
2. 视频主体流量是否绕过 TogetherVideo/OpenList 服务器。

项目仓库：

```text
https://github.com/Aaron-0303/TogetherVideo
```
