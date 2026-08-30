# TogetherVideo

一个给两个人使用的私人“一起看”网站：OpenList 负责网盘目录与播放地址，TogetherVideo 负责登录、片库、房间、播放同步、聊天与表情反应。

## 设计目标

**低服务器带宽优先。** TogetherVideo 不提供视频代理接口，也不会把视频字节从你的 Node.js 服务转发出去。播放器只请求 `/api/play` 获取一次 HTTP 302，随后浏览器直接连接 OpenList 返回的网盘/CDN 地址。

推荐使用 OpenList 的 **QuarkTV** 驱动并保持 302 下载方式。普通 Quark 驱动目前可能强制本地代理，会消耗 OpenList 所在服务器的大量上下行带宽，不适合小带宽服务器。

```text
浏览器 ──页面/WebSocket──> TogetherVideo
   │
   └── 视频数据 ─────────> 夸克 CDN
                ▲
TogetherVideo ──┘ 仅解析 OpenList 播放地址并返回 302
```

## 已实现

- 访问密码 + 昵称登录
- OpenList 目录浏览与自然排序
- 两人房间，默认最多 2 人
- 选择剧集自动同步
- 播放 / 暂停 / 拖动 / 倍速同步
- 每 5 秒对时，轻微漂移使用短暂速率修正，明显漂移直接校准
- 加入正在播放的房间时恢复当前进度
- 浏览器阻止自动播放时显示“点击继续同步播放”
- 在线成员、聊天、表情飘屏
- 房间和聊天状态持久化到 JSON（两人场景足够轻量）
- MP4/WebM 原生播放，m3u8 使用本地安装的 hls.js
- 手机响应式页面
- Docker / Docker Compose / Nginx 示例
- `/healthz` 健康检查

## 1. OpenList 设置

推荐先在 OpenList 中添加 `QuarkTV`，完成扫码登录，然后只挂载你真正需要的电视剧目录。

为了避免服务器成为视频中转节点：

1. 优先使用 QuarkTV，而不是普通 Quark。
2. 不要为该存储开启会强制本地中转的 Web Proxy / Native Proxy。
3. 在 OpenList 中直接点击一个视频，确认最终请求会 302 到网盘/CDN，而不是持续从你的服务器下载。
4. 最好创建一个只读 OpenList 用户或限制到电视剧目录，不要把管理员凭据暴露给 TogetherVideo 前端。

TogetherVideo 的 `OPENLIST_TOKEN` 只存在服务端，浏览器永远拿不到它。

## 2. 配置

```bash
cp .env.example .env
```

至少修改：

```env
SITE_PASSWORD=你的站点密码
SESSION_SECRET=一段足够长的随机字符串
OPENLIST_BASE_URL=http://openlist:5244
OPENLIST_TOKEN=你的OpenList访问Token
OPENLIST_ROOT=/QuarkTV/电视剧
```

如果 TogetherVideo 和 OpenList 不在同一个 Docker 网络，`OPENLIST_BASE_URL` 改成 TogetherVideo 后端能够访问的地址。

`OPENLIST_PUBLIC_URL` 通常可以留空。只有 `/api/fs/get` 没有返回 `raw_url` 时才需要设置为浏览器可访问的 OpenList 地址。

## 3. Docker Compose 启动

仓库自带 OpenList 服务，适合从零部署：

```bash
docker compose up -d --build
```

访问：

```text
TogetherVideo: http://服务器IP:3000
OpenList:      http://服务器IP:5244
```

如果你已经有 OpenList，可以删除 `docker-compose.yml` 里的 `openlist` service 和 `depends_on`，然后把 `OPENLIST_BASE_URL` 指向现有服务。

## 4. 直接使用 Node.js

需要 Node.js 20+：

```bash
npm install
cp .env.example .env
npm start
```

> Node.js 本身不会自动读取 `.env`。裸机运行时请使用 systemd / Docker 注入环境变量，或先在 shell 中导出 `.env`。Docker Compose 会自动读取 `env_file`。

## 5. Nginx

参考 `nginx.example.conf`。Socket.IO 需要保留 Upgrade/Connection 请求头。

如果 HTTPS 由 Nginx/Cloudflare 终止，建议：

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

## 6. 视频兼容性

网页播放器最稳的格式是：

```text
MP4 + H.264 + AAC
```

MKV、DTS、部分 H.265/HEVC 文件即使 OpenList 能下载，也不代表 Chrome/Firefox 能直接解码。TogetherVideo 不做服务器转码，因为这会增加 CPU 和带宽压力。

## 7. 为什么服务器带宽很小也能用

TogetherVideo 的 `/api/play` 实现只有：

1. 后端调用 OpenList `/api/fs/get`。
2. 获得 `raw_url`。
3. 给浏览器返回 HTTP 302。
4. 浏览器之后直接访问网盘/CDN。

代码中没有 `pipe()`、Range 转发或媒体反代逻辑，所以 TogetherVideo 容器不会承担整段视频流量。

需要注意：**如果 OpenList 自己把 Quark 存储配置成本地代理，OpenList 服务器仍会吃视频流量。** 因此低带宽部署的关键是 QuarkTV + 302。

## 8. 开发检查

```bash
npm run check
```

## 后续部署

等服务器信息确定后，再补：域名、HTTPS、反代、OpenList 实际挂载目录、Token、Docker 网络和防火墙规则即可，应用代码不需要为了服务器地址再次重写。
