# 海内是什么

海内，是只给家人朋友的地方。

你看到的，只是你选择的人。
你说的话，也只会被他们听见。



# 基于nostr协议的封闭式朋友圈
- 文字加密
- 图片加密
- 只对已添加的朋友可见
- 只展示来自已添加的朋友的信息
- 点对点评论


## 媒体上传架构

HaiNei Pages/PWA 只包含前端代码。受管默认媒体服务使用独立的 HaiNei Cloudflare Worker：

```text
设备 → HaiNei Worker（验证当前 Nostr 身份、用户状态、撤销状态、配额）
     → Blossom service binding（service API token + issue_upload_token）
     → 返回绑定当前 pubkey 的短期 upload token
设备 → Blossom /upload → 存储后端
```

图片和视频二进制不会经过 HaiNei Worker。Worker 的 `BLOSSOM_SERVICE_TOKEN` 仅存在于 Cloudflare Worker secret 中，不得放入 Vite 环境、Pages、localStorage、IndexedDB 或应用包。

前端只缓存短期用户 token，缓存键包含媒体服务器和当前 pubkey。过期或收到 `401` 后会清除并刷新，上传最多重试一次。用户添加的自定义 Blossom 服务不经过 HaiNei Worker，继续使用用户配置的 API token 或标准 Nostr BUD-11 授权与现有 failover/priority。

### Worker API

- `POST /api/auth/challenge` → `201 { challenge, expiresAt }`
- `POST /api/media/session`，JSON 为 `{ challenge, event, fileSize? }` → `201 { token, pubkey, scope: "upload", expiresAt }`

身份事件必须是有效 Nostr 签名，包含唯一 challenge、`t=hainei_media_session` 和未过期的 expiration。challenge 一次性消费。任何客户端标识、版本、请求头、Origin、Referer 或 User-Agent 都不授予权限。

### Cloudflare 配置

`worker/wrangler.toml` 定义：

- D1 binding `DB`：必须填写 Blossom 已有 `blossom-imgbed-db` 的同一个 `database_id`，禁止创建第二个数据库；
- Service Binding `BLOSSOM`：service 为 `blossom-imgbed`；
- secret `BLOSSOM_SERVICE_TOKEN`：对应 Blossom 中 `type=service` 且权限仅为 `issue_upload_token` 的 API Token；
- 配额变量：`MAX_FILE_SIZE_BYTES`、`DAILY_UPLOAD_COUNT`、`DAILY_UPLOAD_BYTES`；默认分别为 25 MiB、100 次/日、1 GiB/日。

Blossom 端对应变量为 `HAINEI_MAX_FILE_SIZE_BYTES`、`HAINEI_DAILY_UPLOAD_COUNT`、`HAINEI_DAILY_UPLOAD_BYTES`，部署时应保持相同值；Blossom 会基于实际上传字节进行最终的原子配额预留。

Pages 构建可设置 `VITE_HAINEI_WORKER_URL` 指向已部署 Worker；它只是公开 API 地址，不是凭据。

后台推送的生产迁移、VAPID 配置、Worker/Pages 部署与冒烟检查见 [`worker/PUSH_DEPLOYMENT.md`](worker/PUSH_DEPLOYMENT.md)。

## 环境要求
- Node.js 20–22
- npm 或 yarn

## 安装与运行
1. 克隆 / 拷贝项目代码到本地
2. 安装依赖：
   ```bash
   npm install
   ```
   或
   ```bash
   yarn install
   ```

3. 运行开发服务器：
   ```bash
   npm run dev
   ```
   或
   ```bash
   yarn dev
   ```

4. 打开浏览器访问开发 URL（通常 http://localhost:5173）

## 构建
```bash
npm run typecheck
npm test
npm run build
npm run preview
```

## Cloudflare 部署

部署顺序：先对 Blossom 的现有 D1 执行新迁移并部署兼容的 Blossom；再创建 service API token、配置 Worker secret/D1/Service Binding、部署 HaiNei Worker；最后设置 Pages 的 Worker URL 并部署前端。完成后验证真实上传，并确认未列入白名单的外部 Nostr 客户端仍返回 `403`。

```bash
# 首次需要先登录并创建 Pages 项目
npm exec wrangler login

# macOS / Linux
export CF_PAGES_PROJECT_NAME=hainei

# Windows PowerShell
$env:CF_PAGES_PROJECT_NAME="hainei"

# Windows CMD
set CF_PAGES_PROJECT_NAME=hainei

# 创建 Pages 项目
npm exec wrangler pages project create "$CF_PAGES_PROJECT_NAME"     # macOS / Linux
npm exec wrangler pages project create $env:CF_PAGES_PROJECT_NAME   # Windows PowerShell
npm exec wrangler pages project create %CF_PAGES_PROJECT_NAME%      # Windows CMD

# Cloudflare Pages
npm run deploy:cf:pages
```
