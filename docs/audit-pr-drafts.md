# 待发布草稿 PR

## HaiNei：第二批

Head: fix/audit-batch-2；Base: main

Title: fix: local-first restore, bounded quarantine and indexed history

登录被慢 snapshot 阻塞、未决队列和会话去重增长、全历史读取与重复推播让手机体验不可靠。本 PR 在保留第一批安全修正的基础上，先恢复本机资料，后台恢复受 deadline 和 session generation 保护；限制暂存数量、大小和原始 TTL，分页处理全部发送者；稳定游标读取历史，并维护包含授权／删除偏好的未读缓存。推播仅作为当前账号的去重提示，前台从本机未读校准。

补充 D1 batch 的原子授权替换与推播 fanout 工作预算，防止并发刷新交错和长时间启动新请求。65 个测试文件／470 项通过，前端和 Worker typecheck 通过。大规模与真机性能尚未测量。发布／回滚参见 docs/audit-batch-2.md；回滚必须保留 version 14 schema。

## HaiNei：第三批

Head: fix/audit-batch-3；Base: fix/audit-batch-2

Title: security: seal local data and bind managed upload capabilities

私信、媒体引用及草稿以前会以明文留在设备，受管上传能力也未约束本次实际内容。本 PR 使用账号独立的 HKDF/AES-GCM vault，在解锁后按批迁移并验证旧副本；加密所有已盘点的敏感入口，拒绝锁定写入，移除持久解密图片缓存，并提供只清除选定账号的本机资料操作。

媒体引用和下载增加 schema／实际字节上限。受管 token 绑定 hash/maxBytes，必须得到图床单次能力的版本声明，每次上传重新领取。67 文件／477 项测试及 typecheck 通过，包括中断迁移、原始 IDB、锁定写入、草稿、账号删除和 chunked 下载。先部署 Blossom 配套与 migration，再 Worker，最后前端；不能回滚到不理解 vault 的前端。详见 docs/audit-batch-3.md。

## HaiNei：第四批

Head: fix/audit-batch-4；Base: fix/audit-batch-3

Title: ux: optional background lock and accessible dialogs

加密账号增加默认关闭的五分钟后台锁定；先保存加密草稿，随后停止工作并清除账号缓存页面。短暂切换不会要求再次解锁，A 的超时不会作用于 B。通行密钥用词避免把所有设备认证都称为 Face ID；Relay 接受与真实送达／已读保持不同语意。

新私信／发帖对话框支持 Tab、Escape 和焦点归还，视口恢复缩放；Pages 增加相容自定义 HTTPS/WSS 的 CSP 与隐私标头。完整 67 文件／478 测试、typecheck、生产 build 通过。真实浏览器脚本因 Chromium 下载失败未执行，真机矩阵和生产标头仍待验收，不将源码断言或 CI 等同真实 UI 验证。详见 docs/audit-batch-4.md。

## Blossom-ImgBed 配套

Head: fix/bound-upload-capabilities；Base: main

Title: security: content-bound single-use upload capabilities

签发受管能力时可绑定 hash/maxBytes，PUT 按实际 bytes 和 hash 校验、原子消费一次能力，阻止并发重用；现有原子配额改为按原 UTC 日期释放，串流超限即取消。保留旧调用兼容及其实际字节配额。

3 项真实 SQLite／串流测试通过。全量 Mocha／生产部署测试未执行。已有 D1 必须先执行 v2.14.0_bound_upload_tokens.sql；需要 Node 22.6+ 执行测试。普通 Blossom 上传现在同样遵守配置的单文件上限，既有大文件部署需核对配置。详见 AUDIT-UPLOAD.md。此 PR 必须在 HaiNei 第三批发布之前部署。
