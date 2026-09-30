# HaiNei 后台推送部署

后台推送复用现有 `hainei-media` Worker 和 `blossom-imgbed-db` D1。不要创建第二个 Worker 或数据库。

## 1. 配置现有 VAPID 密钥

保持现有 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` 和 `VAPID_SUBJECT` 不变。公钥可以提交；不要提交、打印或记录私钥。如需重新录入现有私钥，使用交互式命令：

```bash
npm exec wrangler -- secret put VAPID_PRIVATE_KEY --config worker/wrangler.toml
```

## 2. 应用生产 D1 迁移并部署现有 Worker

`0002_push_subscriptions.sql` 创建订阅表；`0004_security_controls.sql` 新增原子限流、收件人授权和推送去重表。**必须先完成 D1 迁移，再部署 Worker 和前端**。以下命令明确作用于 `worker/wrangler.toml` 中绑定的现有生产数据库：

```bash
npm exec wrangler -- d1 migrations apply DB --remote --config worker/wrangler.toml
npm exec wrangler -- deploy --config worker/wrangler.toml
```

部署前确认 `VAPID_PUBLIC_KEY` 不为空；`VAPID_PRIVATE_KEY` 只应存在于 Cloudflare Worker secret。

## 3. 让 Pages 前端请求该 Worker

`not_found` 通常表示 Pages 构建没有设置 Worker 地址，请把下面地址替换为实际的 `hainei-media` Worker URL 后重新构建 Pages：

```bash
VITE_HAINEI_WORKER_URL="https://hainei-media.<workers-subdomain>.workers.dev" \
CF_PAGES_PROJECT_NAME="hainei" \
npm run deploy:cf:pages
```

若使用 Git 集成自动构建，请在 Cloudflare Pages 的生产环境变量中设置同名 `VITE_HAINEI_WORKER_URL`，然后触发一次新的生产部署。

## 4. 生产冒烟检查

先验证公开路由存在且返回非空公钥：

```bash
export HAINEI_WORKER_URL="https://hainei-media.<workers-subdomain>.workers.dev"
curl -fsS -X POST "$HAINEI_WORKER_URL/api/push/public-key"
```

预期为 `{ "publicKey": "..." }`，而不是 `not_found` 或 `push_not_configured`。

然后在 HaiNei 设置中点击“开启推送”。该操作会先获取 challenge，用当前 Nostr 账号对**完整 URL、POST 方法和业务 payload 哈希**签名，调用 `/api/push/subscribe`，再把当前 accepted 好友列表同步到 `/api/push/policy`。用只返回计数的查询确认订阅和授权已写入：

```bash
npm exec wrangler -- d1 execute DB --remote --config worker/wrangler.toml \
  --command "SELECT COUNT(*) AS subscription_count FROM hainei_push_subscriptions; SELECT COUNT(*) AS authorization_count FROM hainei_push_authorizations"
```

从另一已接受好友账号发送一条私信，确认 `/api/push/trigger` 只返回通用 `202 { "accepted": true }`，不会暴露收件人是否有订阅；后台实际投递必须要求该 sender 仍在收件人的授权表中，并按 canonical message id 去重。系统通知严格只有：

```text
HaiNei
你有新的私信消息
```

点赞、评论和好友活动不得触发推送；私信推送载荷不得包含发送者、pubkey、消息、动态、评论、资料或任何解密内容。最后关闭推送，再次查询计数，确认对应订阅已删除。


## 5. 安全回滚注意

本批次是“数据库迁移先行”的兼容升级。若 Worker 部署后需要回滚前端，可保留 `0004` 新表；旧前端不会读取这些表。不要在回滚时删除 `hainei_push_authorizations` / `hainei_push_deliveries` / `hainei_rate_limits`，以免正在运行的新 Worker 实例出现表缺失。

若只回滚 Worker，则应同时暂停新前端部署，因为新前端的请求签名包含 `u` / `method` / `payload` 绑定标签，并会调用 `/api/push/policy`。
