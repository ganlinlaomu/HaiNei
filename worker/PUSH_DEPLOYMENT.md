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

从另一已接受好友账号发送一条私信，确认 `/api/push/trigger` 正常时返回通用 `202 { "accepted": true }`，发送失败时返回 `503 { "error": "push_delivery_failed" }` 供发送端重试，不返回收件人订阅数或设备信息；后台实际投递必须要求该 sender 仍在收件人的授权表中，并按 canonical message id 去重。系统通知严格只有：

```text
HaiNei
你有新的私信消息
```

点赞、评论和好友活动不得触发推送；私信推送载荷不得包含发送者、pubkey、消息、动态、评论、资料或任何解密内容。最后关闭推送，再次查询计数，确认对应订阅已删除。


## 5. 安全回滚注意

本批次是“数据库迁移先行”的兼容升级。若 Worker 部署后需要回滚前端，可保留 `0004` 新表；旧前端不会读取这些表。不要在回滚时删除 `hainei_push_authorizations` / `hainei_push_deliveries` / `hainei_rate_limits`，以免正在运行的新 Worker 实例出现表缺失。

若只回滚 Worker，则应同时暂停新前端部署，因为新前端的请求签名包含 `u` / `method` / `payload` 绑定标签，并会调用 `/api/push/policy`。

## 6. 本机推送测试与故障恢复

Pages 自动发布不会部署 `worker/`。本次修复增加 `/api/push/test`，必须另外运行第 2 节的 Worker 部署命令；已有迁移无需新增表，保持现有 VAPID 密钥不变。

在已安装的 PWA 中打开“系统设置 → 后台推送 → 测试本机推送”。测试请求使用当前账号签名，只能向该账号已登记的本机 endpoint 发送，不需要自己成为自己的好友。结果区分订阅不存在、订阅已过期、发送失败和系统推送服务已接受。最后一种结果仍需以本机实际显示通知为准。

- 若显示 Worker 尚未部署：部署最新 Worker，不能只更新 Pages。
- 若订阅不存在或过期：关闭再开启推送，重新登记本机订阅。
- 若发送失败：使用 `npm exec wrangler -- tail --config worker/wrangler.toml` 查看推送供应商状态码；日志不会包含完整 endpoint、订阅密钥或 VAPID 私钥。
- 若测试可显示而好友私信没有提醒：让发送端也更新前端，然后检查接收账号 `/api/push/policy` 是否已同步该 accepted 好友。

发送端现在将推送请求单独持久化。请求失败、网络断开或 PWA 被挂起后，在解锁恢复或联网时重试，退避最长 15 分钟、有效期 24 小时；不会重新发布已经发送的私信，也不会补发修复前历史消息的提醒。Worker 已接受的请求不再重试；供应商接受也不等同于设备已显示通知。

## 7. 语音来电的页面／系统通知交接

本次修复必须同时发布 Worker 和 Pages，先部署 Worker。没有新增 D1 迁移，保留现有 VAPID 密钥：

```bash
npm exec wrangler -- deploy --config worker/wrangler.toml
```

普通消息继续使用 `foreground_until`；语音邀请绕过该过滤，避免 PWA 刚退出、离开状态上报被挂起时，在 40 秒内漏掉来电。Worker 在创建来电 Web Push **之前**等待 1.5 秒。页面只有在来电组件已挂载且仍可见、账号和通话仍匹配时，才能签名调用 `/api/push/call-handled`，提交 canonical invite message ID、sender pubkey 和本机 subscription endpoint。确认只抑制该设备的同一邀请，不影响同账号其他设备。

确认记录复用现有 `hainei_push_deliveries`，以 `SHA-256("call-handled:" + endpoint)` 隔离于供应商投递记录；仅接受最近 5 秒的记录，由既有定时清理删除。接口认证绑定 URL、方法和 payload，且只允许确认本账号已经登记的 endpoint。不保存明文通话 room、secret 或来电者姓名。发送端仍只收到通用 accepted 响应；设备计数和 `handled` 仅记录在 Worker 日志，不能向发送者泄露收件人的设备信息。

未及时确认时优先保证提醒：照常创建系统通知，不因窗口可见而静音／关闭来电通知。已收到的 Web Push 仍展示可见通知，不能通过 Service Worker 静默吞掉推送来避免双横幅。页面铃声自动播放失败只保留页面接听／铃声重试按钮，不再另建系统通知。已接管的来电仍在响铃时若页面切到后台，页面同步发消息给 Service Worker，尽力交还系统提醒；回到前台再撤下，接听／取消优先于异步通知创建，重复后台事件不再创建第二条。点击来电通知优先 focus 已有窗口并读取加密邀请缓存，不 navigate／重载当前通话。

来电请求快速失败时最多重试一次，使用同一 canonical ID，且只在最初 5 秒内、呼叫仍在进行时启动重试。普通消息原有持久化重试不变；来电不会进入 24 小时补发队列。`call_push_requested` 表示服务器接受请求，不代表手机已显示。页面确认结果见 `call_notification_handoff`，失败见 `call_notification_handoff_failed`。

发布后用两台真实设备验证：前台来电只显示页面提醒；关闭 PWA 后立即拨打以及等一分钟后拨打均有系统通知；铃声 autoplay 被拒绝不再额外弹系统横幅；同账号另一台后台设备仍收到通知；点通知唤回当前页面；快速接听／拒绝与 Relay 乱序回执不产生幽灵来电。网络严重延迟、系统通知权限／专注模式和 iOS 后台调度仍可能影响送达，不能以单元测试代替 iPhone 实测，也不能宣称具备 CallKit 系统电话能力。
