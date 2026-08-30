# TogetherVideo

TogetherVideo 是一个给两个人使用的私人“一起看”网站。

- **OpenList**：连接夸克网盘、列出电视剧目录、提供播放地址。
- **TogetherVideo**：登录、片库浏览、双人房间、播放同步、聊天和表情互动。
- **Nginx**：对外提供 HTTP / HTTPS，并代理 WebSocket。
- **systemd**：后台运行 TogetherVideo 和 OpenList，开机自动启动。

本项目现在采用 **Ubuntu 裸机部署**，**不使用 Docker / Docker Compose**。

> 对低带宽服务器，最重要的不是网页能否打开，而是视频必须通过 OpenList **302 跳转到夸克/CDN**。TogetherVideo 本身不会代理视频字节。

---

## 1. 已实现功能

- 站点密码 + 昵称登录
- OpenList 目录浏览
- 中文 / 数字自然排序
- 默认最多 2 人的同步房间
- 切换剧集同步
- 播放 / 暂停同步
- 拖动进度同步
- 倍速同步
- 每 5 秒进行播放进度校准
- 小幅时间漂移使用短暂倍速修正
- 大幅时间漂移直接校准
- 后加入房间时恢复当前剧集和进度
- 浏览器阻止自动播放时提供继续同步提示
- 在线成员显示
- 房间聊天
- Emoji 表情反应
- 房间状态和聊天记录持久化
- MP4 / WebM 原生播放
- m3u8 使用本地安装的 hls.js
- PC / 手机响应式页面
- systemd 服务文件
- Nginx 示例配置
- `/healthz` 健康检查

---

## 2. 架构

```text
                        ┌─────────────────────┐
                        │      夸克网盘       │
                        │      QuarkTV        │
                        └──────────┬──────────┘
                                   │
                              302 / CDN直链
                                   │
                                   ▼
                          用户浏览器直接播放
                                   ▲
                                   │
                    视频字节不经过 TogetherVideo
                                   │
公网 ── 80/443 ──> Nginx ──> 127.0.0.1:3000
                              TogetherVideo
                                   │
                         API / 文件信息请求
                                   │
                                   ▼
                           127.0.0.1:5244
                               OpenList
```

TogetherVideo 的 `/api/play` 只完成：

1. 调用 OpenList 获取文件信息；
2. 解析 `raw_url`；
3. 返回 HTTP 302；
4. 浏览器随后直接连接夸克/CDN。

代码中没有视频 `pipe()`、Range 中转或服务器转码逻辑。

---

## 3. 端口

推荐公网安全组只开放：

| 端口 | 用途 | 公网开放 |
| --- | --- | --- |
| 22/tcp | SSH | 是，最好限制来源 IP |
| 80/tcp | HTTP / HTTPS 证书签发 | 是 |
| 443/tcp | HTTPS / WebSocket | 是 |
| 3000/tcp | TogetherVideo | **否** |
| 5244/tcp | OpenList | **否** |

TogetherVideo 默认绑定：

```text
127.0.0.1:3000
```

OpenList 只需要被本机 TogetherVideo 访问。不要在腾讯云安全组中开放 3000 和 5244。

如果需要进入 OpenList 管理后台，推荐使用 SSH 隧道，而不是把 5244 暴露公网：

```bash
ssh -L 5244:127.0.0.1:5244 ubuntu@服务器IP
```

然后本机浏览器访问：

```text
http://127.0.0.1:5244
```

---

# 4. Ubuntu 裸机部署

推荐 Ubuntu 22.04 / 24.04。

以下示例假设：

```text
运行用户：ubuntu
项目目录：/opt/TogetherVideo
TogetherVideo：127.0.0.1:3000
OpenList：127.0.0.1:5244
```

如果服务器用户名或安装目录不同，需要同步修改 `deploy/togethervideo.service`。

## 4.1 安装基础软件

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx
```

## 4.2 安装 Node.js

项目要求 Node.js 20+。

例如安装 Node.js 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

检查：

```bash
node -v
npm -v
```

`node -v` 必须至少为 `v20`。

---

# 5. 安装 OpenList

Ubuntu / Debian 推荐使用 OpenList 官方 APT 包。该安装方式会自动创建 `openlist` 用户和 systemd 服务。

```bash
curl -fsSL https://github.com/OpenListTeam/OpenList-APT/releases/latest/download/install-apt.sh | sudo bash
sudo apt install -y openlist
```

启用并启动：

```bash
sudo systemctl enable --now openlist
sudo systemctl status openlist --no-pager
```

检查版本：

```bash
openlist version
```

APT 安装的主要位置：

```text
程序：/var/lib/openlist/openlist
数据：/var/lib/openlist/
命令：/usr/bin/openlist
服务：openlist.service
```

查看日志：

```bash
sudo journalctl -u openlist -n 100 --no-pager
```

如果需要重新设置管理员密码：

```bash
sudo -u openlist openlist admin set '你的新密码'
```

官方安装文档：

https://doc.oplist.org/guide/installation/manual

---

# 6. 配置 QuarkTV

对于低带宽服务器，**优先使用 `QuarkTV`，不要使用普通 `Quark` 驱动。**

OpenList 官方说明中：

- 普通 Quark 当前因限速问题只能通过 Local Proxy 传输；
- QuarkTV 支持 302；
- QuarkTV 主要支持访问和下载，正好满足 TogetherVideo 的看片需求。

官方文档：

https://doc.oplist.org/guide/drivers/quark

通过 SSH 隧道打开 OpenList 后台：

```text
http://127.0.0.1:5244
```

然后：

1. 登录 OpenList 管理后台；
2. 添加存储；
3. 驱动选择 `QuarkTV`；
4. 设置挂载路径，例如 `/QuarkTV`；
5. 保存；
6. 回到存储列表，使用夸克 App 扫描二维码；
7. 扫码确认后，禁用再启用该驱动；
8. 确认能够浏览电视剧文件。

### 低带宽配置要求

不要开启会把视频变成本机中转的配置：

```text
Web Proxy / Web 代理
Native Proxy / 本机代理
```

如果启用了 Web Proxy，OpenList 可能成为视频中转节点，从而吃满服务器 4 Mbps 带宽。

---

# 7. 安装 TogetherVideo

创建项目目录并克隆：

```bash
sudo mkdir -p /opt/TogetherVideo
sudo chown ubuntu:ubuntu /opt/TogetherVideo

git clone https://github.com/Aaron-0303/TogetherVideo.git /opt/TogetherVideo
cd /opt/TogetherVideo
```

安装生产依赖：

```bash
npm install --omit=dev
```

创建状态目录：

```bash
mkdir -p data
```

创建配置：

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

---

# 8. TogetherVideo 配置

推荐配置：

```env
HOST=127.0.0.1
PORT=3000

SITE_PASSWORD=请修改成情侣网站访问密码
SESSION_SECRET=请修改成一段足够长的随机字符串

COOKIE_SECURE=false
TRUST_PROXY=false

DEFAULT_ROOM=ours
MAX_ROOM_USERS=2

OPENLIST_BASE_URL=http://127.0.0.1:5244
OPENLIST_PUBLIC_URL=
OPENLIST_TOKEN=
OPENLIST_ROOT=/QuarkTV/电视剧
OPENLIST_PATH_PASSWORD=
OPENLIST_TIMEOUT_MS=15000

DATA_FILE=./data/state.json
```

生成随机 `SESSION_SECRET`：

```bash
openssl rand -hex 32
```

## OPENLIST_ROOT

假设 OpenList 中：

```text
/QuarkTV/电视剧/
├── 想见你/
├── 庆余年/
└── ...
```

则填写：

```env
OPENLIST_ROOT=/QuarkTV/电视剧
```

TogetherVideo 只允许访问该根目录及其子目录。

## OPENLIST_TOKEN

如果媒体路径允许匿名读取，可以先留空。

如果需要 Token，可在 OpenList 管理页面的 **设置 → 其他** 中获取长期 Token，然后写入：

```env
OPENLIST_TOKEN=你的Token
```

Token 只存在服务器 `.env`，不会发给浏览器。

不要把真实 `.env` 提交到 GitHub。

---

# 9. 本机测试

先手动启动一次：

```bash
cd /opt/TogetherVideo
set -a
source .env
set +a
npm start
```

另开一个 SSH 终端测试：

```bash
curl http://127.0.0.1:3000/healthz
```

正常返回：

```json
{"ok":true}
```

停止前台测试后，再配置 systemd。

---

# 10. systemd 后台运行

仓库已经提供：

```text
deploy/togethervideo.service
```

默认对应：

```text
User=ubuntu
WorkingDirectory=/opt/TogetherVideo
EnvironmentFile=/opt/TogetherVideo/.env
```

安装：

```bash
sudo cp /opt/TogetherVideo/deploy/togethervideo.service /etc/systemd/system/togethervideo.service
sudo systemctl daemon-reload
sudo systemctl enable --now togethervideo
```

检查：

```bash
sudo systemctl status togethervideo --no-pager
```

日志：

```bash
sudo journalctl -u togethervideo -f
```

重启：

```bash
sudo systemctl restart togethervideo
```

此 service 带有基础 systemd 沙箱限制，并且只允许应用写入 `/opt/TogetherVideo/data`。

---

# 11. Nginx

仓库提供：

```text
nginx.example.conf
```

复制：

```bash
sudo cp /opt/TogetherVideo/nginx.example.conf /etc/nginx/sites-available/togethervideo
sudo nano /etc/nginx/sites-available/togethervideo
```

把：

```nginx
server_name movie.example.com;
```

修改成真实域名。

启用站点：

```bash
sudo ln -sf /etc/nginx/sites-available/togethervideo /etc/nginx/sites-enabled/togethervideo
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 已经包含 Socket.IO 所需要的 WebSocket Upgrade 请求头。

如果暂时没有域名，可以把 `server_name` 改成 `_`，然后通过服务器 IP 的 80 端口测试。

---

# 12. HTTPS

有域名后推荐使用 HTTPS。

安装 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
```

签发：

```bash
sudo certbot --nginx -d movie.example.com
```

HTTPS 正常以后，把 `/opt/TogetherVideo/.env` 修改为：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

然后：

```bash
sudo systemctl restart togethervideo
```

如果仍然使用纯 HTTP，则保持：

```env
TRUST_PROXY=false
COOKIE_SECURE=false
```

---

# 13. 必须验证：视频是否真正走 302

**低带宽服务器必须做这一步。**

TogetherVideo 网页能打开并不代表带宽方案正确。

## 浏览器验证

1. 打开 TogetherVideo；
2. 登录；
3. 打开浏览器开发者工具；
4. 进入 `Network / 网络`；
5. 播放一集视频；
6. 找到视频媒体请求；
7. 查看最终请求域名。

正确状态应该类似：

```text
TogetherVideo /api/play
        ↓ 302
夸克 / CDN 域名
        ↓
浏览器直接接收视频
```

如果大部分视频数据持续来自：

```text
你的服务器IP
```

或者：

```text
OpenList服务器:5244
```

并且服务器出口带宽接近视频码率，说明发生了本地代理中转。

对于 4 Mbps 服务器，这种状态不适合正式使用。

可以同时在服务器观察带宽：

```bash
sudo apt install -y nload
nload
```

两个人播放视频时，如果服务器流量仍然很小，说明 302 直链方案工作正常。

---

# 14. 视频格式兼容性

网页播放器最稳的格式：

```text
MP4 + H.264 + AAC
```

可能存在浏览器兼容问题的格式：

```text
MKV
H.265 / HEVC
DTS
ASS 内封字幕
```

OpenList 能下载某个文件，不代表 Chrome / Edge / Safari 一定能够解码。

TogetherVideo **不在服务器转码**，因为转码和媒体代理都不符合低带宽服务器的设计目标。

---

# 15. 更新项目

```bash
cd /opt/TogetherVideo
git pull
npm install --omit=dev
npm run check
sudo systemctl restart togethervideo
```

检查：

```bash
curl http://127.0.0.1:3000/healthz
sudo systemctl status togethervideo --no-pager
```

---

# 16. 备份

TogetherVideo 自身最重要的数据：

```text
/opt/TogetherVideo/.env
/opt/TogetherVideo/data/state.json
```

OpenList 数据默认位于：

```text
/var/lib/openlist/
```

升级或迁移服务器前建议备份这些目录。

---

# 17. 常用命令

## TogetherVideo

```bash
sudo systemctl status togethervideo
sudo systemctl restart togethervideo
sudo systemctl stop togethervideo
sudo journalctl -u togethervideo -f
```

## OpenList

```bash
sudo systemctl status openlist
sudo systemctl restart openlist
sudo journalctl -u openlist -f
```

## Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status nginx
```

---

# 18. 常见问题

## 网页出现 502

先检查：

```bash
sudo systemctl status togethervideo --no-pager
curl http://127.0.0.1:3000/healthz
sudo journalctl -u togethervideo -n 100 --no-pager
```

## TogetherVideo 显示无法连接 OpenList

检查：

```bash
sudo systemctl status openlist --no-pager
curl -I http://127.0.0.1:5244
```

并确认 `.env`：

```env
OPENLIST_BASE_URL=http://127.0.0.1:5244
```

## 看不到电视剧

检查：

```env
OPENLIST_ROOT=/QuarkTV/电视剧
```

路径必须和 OpenList 中的实际挂载路径完全一致。

## 视频一直缓冲

依次排查：

1. 是否使用 `QuarkTV`；
2. 是否错误开启 Web Proxy / Native Proxy；
3. 浏览器 Network 中视频最终请求是不是夸克/CDN；
4. 视频编码是否为浏览器支持格式；
5. 夸克账号本身的下载速度是否正常。

## 两个人不同步

检查浏览器是否成功建立 Socket.IO WebSocket，并检查：

```bash
sudo journalctl -u togethervideo -f
```

Nginx 配置不能删除：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

---

# 19. 开发检查

```bash
npm install
npm run check
```

---

# 20. 交付部署检查表

部署人员上线前请逐项确认：

- [ ] Node.js >= 20
- [ ] OpenList 正常运行
- [ ] 使用 QuarkTV 挂载夸克
- [ ] `OPENLIST_ROOT` 指向正确电视剧目录
- [ ] TogetherVideo `127.0.0.1:3000` 健康检查正常
- [ ] `togethervideo.service` 已设置开机启动
- [ ] `openlist.service` 已设置开机启动
- [ ] Nginx WebSocket 代理正常
- [ ] 公网没有开放 3000
- [ ] 公网没有开放 5244
- [ ] HTTPS 已启用（正式使用推荐）
- [ ] HTTPS 后 `TRUST_PROXY=true`
- [ ] HTTPS 后 `COOKIE_SECURE=true`
- [ ] 浏览器确认视频最终走夸克/CDN 302
- [ ] 播放时服务器 4 Mbps 带宽没有被视频流量吃满
- [ ] 两台设备实际测试播放 / 暂停 / 拖动 / 换集同步

满足以上条件后即可正式使用。
