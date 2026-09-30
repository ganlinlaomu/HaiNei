# 第三批：本机隐私与媒体（A05、A07、A12）

## 本机 vault

每账号 HKDF-SHA256 从已解锁 Nostr 私钥派生独立 AES-256-GCM key；该私钥已有的密码／WebAuthn PRF 包装继续承担解锁。派生 key 只驻留内存，锁定后覆盖并释放，重输同一私钥仍能恢复历史。AAD 绑定版本、表、账号和主键，内容不能被交换到其他记录。索引、消息时间、参与者、状态与数量仍为明文元数据；不是匿名或防 XSS 的方案。

加密 syncedMessages 正文／tags、decryptedEvents、未决授权内容、旧 accountMessages 正文、accountMeta（含私信草稿）、outgoingQueue 及媒体待发任务、accountStateMirrors 和私有 profile 内容。deviceStorage 的 inbox/outbox/notifications/interactions、贴文草稿和设置（可能含图床 token）转入加密 accountMeta。解密媒体不再写入持久图片缓存。拒绝消息不再预先写 durable 解密快取。

首次解锁逐表每批 100 条迁移，同主键替换提交后才删除可核对的旧明文重复记录；中断可重跑，完成标记最后写入。无法确定归属、也没有可验证账号副本的旧 messages/meta 隔离行不自动分配或删除，需人工恢复／检查。旧图片缓存为可再取的派生资料，迁移时清空。迁移期间首次登录可能比平常慢；大量媒体的同步 GCM／序列化需要真机 trace，不宣称 50ms 目标已达成。

生产库拒绝未解锁的敏感写入，重新启动不会降级为明文。 schema 升级中的旧记录只允许在 versionchange 阶段按原格式搬移，随后账号解锁才能完成 vault migration。锁定前保存草稿并等待 deviceStorage 写入；失败时不抛弃草稿。删除本机资料按账号索引执行，不要求读取解密内容，并保留其他账号与远端数据。

## 媒体

受管上传现在要求正整数 fileSize 和 SHA-256，签名覆盖二者。图床 token 必须明确声明 bindingVersion=1、singleUse、相同 hash/maxBytes；不支持的旧 issuer 返回 `blossom_binding_upgrade_required`。每次上传重新领取，不能复用 settled token。

Blossom 配套修改使用实际接收 bytes 做原子配额占用，在持久化失败时按原 UTC 日期释放；能力 token 的原子使用标记防并发重用，并强制 hash/大小匹配。用量限制以图床的 `HAINEI_*` 配置为最终准则，Worker 的读取仅预检。崩溃可能留下保守的当天已占用配额，不能声称有完整跨服务分布式事务或自动预留回收。旧非绑定调用保留兼容，但仍受实际字节配额约束。

加密引用限制长度、HTTPS URL、无用户名／密码／fragment、32-byte key／12-byte IV、MIME 白名单及尺寸／时长。下载按串流计数，图片／语音最多 16MiB、视频最多 32MiB，二十秒 deadline，omit credentials、no-referrer、禁止重定向，退出时取消并释放 Blob。自定义 HTTPS 图床仍可使用。

## 发布顺序与回滚

1. 先合并并部署 Blossom 配套 PR。旧 D1 执行 `database/migrations/v2.14.0_bound_upload_tokens.sql`；新库使用更新的 init.sql。迁移含三条 ALTER，已成功的语句不要重复执行；部分失败先检查列再仅补缺失部分。
2. 验证 issuer attestation、并发单次消费及实际字节配额后，再部署 HaiNei Worker；两边限额配置一致。
3. 最后发布支持新签名／上传与 vault 的前端，旧客户端需刷新。验证 Pages 的实际安全标头、Service Worker 更新和密码／PRF 解锁。
4. 回滚 UI 或上传功能时保留 vault reader 与 version 14 schema。禁止旧前端覆盖已加密数据库；错误密钥／损坏密文应失败，不以空白正文覆盖原密文。图床已签发能力最多存活 TTL；暂停 issuer 可阻止新能力，既有 token 的撤销由其记录控制。

自动测试覆盖 vault 原始 IDB 不含正文、锁定后拒绝读取和新写入、二进制恢复、迁移故障后恢复、草稿加密、单账号删除和超限 chunked 下载。Blossom 配套测试使用 Node 的 SQLite 执行真实 SQL 验证能力和配额；不是线上负载测试。
