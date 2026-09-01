# TogetherVideo 4.1

TogetherVideo 是一个固定双人使用的同步观影网站。视频存放在 **123 网盘**，网站通过 **WebDAV** 浏览媒体目录；真正的视频数据由 123 CDN 直接发送到两个人各自的浏览器，Node 服务不转发视频正文。

![TogetherVideo 4.1 界面](docs/images/togethervideo-4.1.png)

## 功能

- 固定双人房间，昵称只允许选择 **小杨 / 旭旭**
- 播放、暂停、拖动、倍速同步
- 两边缓存和网络线路独立，一方缓冲不会卡住另一方
- 右侧 **房间 / 播放列表** 双 Tab
- 123 网盘 WebDAV 媒体库
- ArtPlayer 播放器
- 房间实时聊天
- 明亮 / 黑暗主题
- 设置中心支持 WebDAV、站点密码和聊天记录管理

---

# 部署前需要准备什么

## 1. 一台服务器

准备一台可以长期运行 Node.js 的 Linux 云服务器 / VPS，例如 Ubuntu 22.04 / 24.04。

服务器主要负责：

- 网站页面
- 登录与站点设置
- Socket.IO 双人同步
- WebDAV 目录读取
- 解析 123 临时媒体地址

**视频正文不经过服务器**，因此服务器不需要承担视频转发带宽。

推荐准备：

- Linux 服务器
- 公网 IP
- Node.js 20+
- Git
- Nginx 或 Caddy
- 一个域名
- HTTPS 证书

> 公网正式部署请使用 **HTTPS**。TogetherVideo 的浏览器媒体链路依赖 Service Worker，普通公网 HTTP 页面无法正常使用 Service Worker；`localhost` 是浏览器的特殊例外。

## 2. 一个 123 网盘账号

视频文件需要放在 123 网盘中，并准备可用的 **WebDAV** 访问方式。

你需要能够获得：

```text
WebDAV 地址
WebDAV 用户名
WebDAV 密码 / 应用密码
媒体根目录
```

这些信息之后直接在 TogetherVideo 的 **设置 → WebDAV** 中填写，不需要写进代码。

## 3. 一个域名

推荐把域名解析到服务器，例如：

```text
watch.example.com
        ↓
服务器公网 IP
```

生产环境建议让 Nginx / Caddy 监听 `80 / 443`，TogetherVideo 自己只在服务器内部监听 `3000`。

---

# 一、安装 TogetherVideo

下面以 Ubuntu 为例。

## 1. 安装 Node.js 20+

先确认版本：

```bash
node -v
npm -v
```

Node.js 需要：

```text
>= 20
```

如果服务器还没有 Node.js，可以使用你习惯的 Node.js 安装方式，例如 NodeSource、nvm 或系统软件源。

## 2. 克隆项目

```bash
git clone https://github.com/Aaron-0303/TogetherVideo.git
cd TogetherVideo
```

安装依赖：

```bash
npm install
```

## 3. 第一次启动

建议先在终端测试运行：

```bash
HOST=127.0.0.1 \
PORT=3000 \
SITE_PASSWORD='请改成你自己的初始密码' \
TRUST_PROXY=true \
COOKIE_SECURE=true \
npm start
```

看到类似：

```text
[TogetherVideo 4.1.0] listening on 127.0.0.1:3000
```

说明后端已经启动。

主要环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 服务监听地址；使用反向代理时推荐 `127.0.0.1` |
| `PORT` | `3000` | TogetherVideo 端口 |
| `SITE_PASSWORD` | `change-me` | 第一次登录使用的站点密码 |
| `TRUST_PROXY` | `true` | 反向代理部署保持 `true` |
| `COOKIE_SECURE` | `false` | HTTPS 生产环境建议设为 `true` |
| `DATA_DIR` | `./data` | 设置和房间状态保存目录 |

> 不要在公网部署时继续使用默认密码 `change-me`。

---

# 二、配置 Nginx 和 HTTPS

## 1. Nginx 反向代理

假设域名是：

```text
watch.example.com
```

Nginx 可以配置为：

```nginx
server {
    listen 80;
    server_name watch.example.com;

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

Socket.IO 需要 WebSocket，因此：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

不要删掉。

检查并重载 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 2. 配置 HTTPS

可以使用 Certbot、Caddy 或你现有的证书方案。

使用 Certbot + Nginx 时，常见流程是：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d watch.example.com
```

完成后访问：

```text
https://watch.example.com
```

---

# 三、让 TogetherVideo 后台运行

推荐使用 systemd。

创建：

```bash
sudo nano /etc/systemd/system/togethervideo.service
```

示例：

```ini
[Unit]
Description=TogetherVideo
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/TogetherVideo
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=SITE_PASSWORD=请改成你自己的初始密码
Environment=TRUST_PROXY=true
Environment=COOKIE_SECURE=true
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

其中：

```text
User
WorkingDirectory
SITE_PASSWORD
```

请按你的服务器实际情况修改。

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now togethervideo
```

查看状态：

```bash
sudo systemctl status togethervideo
```

查看日志：

```bash
journalctl -u togethervideo -f
```

---

# 四、第一次使用

## 1. 打开网站

浏览器访问：

```text
https://你的域名
```

登录页选择昵称：

```text
小杨
或
旭旭
```

然后输入站点访问密码进入房间。

## 2. 配置 123 WebDAV

进入右上角：

```text
设置 → WebDAV
```

填写：

```text
WebDAV 地址
用户名
密码 / 应用密码
根目录
```

建议先点击：

```text
测试连接
```

测试成功后再点击：

```text
保存媒体源
```

配置只需要做一次，之后会保存在服务器的 `data` 目录中。

## 3. 选择视频

回到主界面右侧：

```text
播放列表
```

浏览 123 网盘目录并选择视频。

选择后，该视频会成为房间当前视频，两个人都会收到同一个播放状态。

## 4. 两个人进入房间

另一台电脑 / 浏览器访问同一个地址，选择另外一个昵称进入即可。

例如：

```text
浏览器 A：旭旭
浏览器 B：小杨
```

右上角显示：

```text
2 / 2 在线
```

即可一起观看。

---

# 五、怎么使用

主界面右侧有两个区域：

```text
房间 | 播放列表
```

### 房间

可以看到：

- 小杨 / 旭旭在线状态
- 当前播放状态
- 双方缓冲状态
- 等等我
- 重新同步
- 播放速度
- 聊天

### 播放列表

用于浏览 WebDAV 媒体目录并切换视频。

### 等等我

需要临时停一下时点击，房间播放状态会同步暂停。

### 重新同步

如果两边播放位置明显错开，点击一次 **重新同步** 即可重新对齐。

---

# 六、同步机制简述

TogetherVideo 只同步 **视频、播放 / 暂停、进度、倍速和时间线**；两个人的浏览器缓存、Range 请求和 CDN 下载完全独立。

因此正常情况下：

```text
一方网络卡顿 → 只影响自己
另一方网络正常 → 不需要等待对方缓存
```

视频数据路径是：

```text
123 CDN → 浏览器 A
123 CDN → 浏览器 B
```

而不是：

```text
123 CDN → TogetherVideo 服务器 → 两个浏览器
```

所以服务器不承担视频转发流量。

---

# 七、推荐视频格式

浏览器兼容性最稳定的是：

```text
容器：MP4
视频：H.264 / AVC
Profile：Main / High
位深：8-bit
像素格式：yuv420p
音频：AAC-LC
Fast Start：开启
```

HEVC 能否播放取决于浏览器和系统解码能力。

如果某个视频一直无法播放，可以先检查：

```bash
ffprobe -hide_banner "input.mp4"
```

---

# 八、更新项目

进入项目目录：

```bash
cd /home/ubuntu/TogetherVideo
git pull
npm install
sudo systemctl restart togethervideo
```

前端版本更新后，两个浏览器建议执行一次：

```text
Ctrl + Shift + R
```

如果仍然看到旧界面，可在浏览器开发者工具中注销旧的 Service Worker 后重新刷新。

---

# 九、常见问题

## WebDAV 测试失败

优先检查：

```text
WebDAV 地址
用户名
应用密码
根目录
```

确认同一套账号能够正常访问 123 WebDAV。

## 网站能打开，但视频一直加载

优先检查：

1. 网站是否通过 HTTPS 打开
2. 浏览器 Service Worker 是否正常注册
3. 123 WebDAV 是否还能解析媒体地址
4. 视频编码是否被当前浏览器支持

## 两个人能看视频，但同步不正常

检查 Nginx 是否保留 WebSocket 相关配置：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

## 升级以后还是旧界面

执行：

```text
Ctrl + Shift + R
```

仍无效时注销旧 Service Worker 后重新加载页面。

---

# 数据保存位置

默认目录：

```text
./data/
```

主要保存：

```text
settings.json
watch-state.json
```

其中包含站点设置和 WebDAV 配置。部署时建议备份该目录，并限制其他用户读取权限。

---

# 端口

默认 TogetherVideo：

```text
3000
```

推荐生产环境：

```text
公网开放：80 / 443
3000：只监听 127.0.0.1，由 Nginx 反向代理
```

---

# 快速部署检查表

部署前：

- [ ] 一台 Linux 云服务器 / VPS
- [ ] Node.js 20+
- [ ] Git
- [ ] 123 网盘账号
- [ ] 已准备可用的 123 WebDAV
- [ ] 域名已解析到服务器
- [ ] Nginx / Caddy
- [ ] HTTPS 已配置

部署后：

- [ ] `npm install` 完成
- [ ] TogetherVideo 服务正常运行
- [ ] HTTPS 可以访问
- [ ] 小杨 / 旭旭可以登录
- [ ] WebDAV 测试连接成功
- [ ] 播放列表能看到视频
- [ ] 两个浏览器显示 `2 / 2 在线`
- [ ] 播放 / 暂停 / 拖动同步正常

---

**TogetherVideo 4.1：一条时间线，两条独立媒体线路。**
