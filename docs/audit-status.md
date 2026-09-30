# HaiNei 审查续作交接（2026-09-30）

已核对另一模型的 main 提交 `4616611cab1bead5a352ef2695aa0dec6f92d9f2`，保留其第一批安全改动。本次后续代码按第二、第三、第四批拆为本地独立提交，并另有 Blossom 配套分支。

| 批次 | 本地分支 | 内容／说明 | 验证 |
|---|---|---|---|
| 第一批 | main / 4616611 | 已有推播授权、端点限制、HTTP 绑定、收讯重试和诊断去密钥；续作保留 | 后续完整回归包含相关测试 |
| 第二批 | fix/audit-batch-2 | 启动、容量／TTL、历史与未读、角标、授权替换原子性；audit-batch-2.md | typecheck；65 文件／470 测试通过 |
| 第三批 | fix/audit-batch-3 | vault、草稿、账号数据清除、媒体验证和绑定上传；audit-batch-3.md | typecheck；67 文件／477 测试通过 |
| 第四批 | fix/audit-batch-4 | 后台锁定、通行密钥用词、focus、缩放和 Pages 标头；audit-batch-4.md | typecheck；67 文件／478 测试通过；生产 build 通过 |
| 图床配套 | Blossom-ImgBed: fix/bound-upload-capabilities | 单次能力、真实 bytes 配额、串流上限及旧 D1 migration；AUDIT-UPLOAD.md | 3 项 Node SQLite／串流测试通过 |

各 PR 的目标应依次为 main、fix/audit-batch-2、fix/audit-batch-3；合并前将后续 PR 的 base 更新到 main，并保留依赖顺序。第三批发布先完成 Blossom migration／部署，后 Worker，最后前端。不可把旧 vault-unaware 前端回滚到已经加密／升版的数据库。

## 发布状态

分支尚未推送，草稿 PR 尚未创建，生产环境未部署。自动审批拒绝了 git push：当前对话未明确授权将仓库代码和历史传到外部 GitHub。待用户批准后，仅推送以上四个修正分支并创建草稿 PR；不直接修改 main、不合并、不部署。

## 尚未验证的项目

Chromium 下载失败，因此真实浏览器 smoke 脚本没有执行。iPhone／iPad／Android 真机矩阵、生产实际响应标头、线上并发／跨服务操作以及 1万／5万／10万历史性能 trace 未执行。构建仍有已有的大 chunk 提示。无主旧版隔离明文不能在未知归属下自动删除，详见 vault 迁移说明；本次不把这些项目标成验收通过。
