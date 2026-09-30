# 第四批：手机体验及回归

后台锁定默认关闭，可在加密账号的设置页启用。离开前景不足五分钟不锁；超过五分钟后，后台计时器或回前景检查会先保存加密草稿，再停止同步与发件工作、清空私钥和 vault key、销毁账号的缓存页面及 Blob URL，并要求密码／通行密钥解锁。A 的计时不能锁 B。草稿保存失败时保持解锁并记录不含内容的错误。

“Relay 已接受”只表示 relay 的发布确认；“已送达”和“已读”仍取决于相应的加密回执。登录区区分“忘记此账号”（保留历史）和“删除本机资料”（清除该账号本机数据）；删除不影响其他账号或远端内容。

新私信和发帖对话框加入 Tab 循环、Escape 与关闭后的焦点归还；移动设备打开时不主动弹键盘。视口允许用户缩放。Cloudflare Pages 的 `_headers` 包含 CSP、no-referrer、nosniff、HSTS 和禁止嵌入；自定义媒体与 relay 保留 HTTPS/WSS 连接，内嵌视频保留 HTTPS。部署后需核对实际响应；这些配置不是已验证的线上标头。

## 可执行验证

- `npm run typecheck && npm test && npm run build`
- 浏览器烟雾回归：安装 Playwright 和 Chromium，先运行 `npm run dev`，另一个终端执行 `node tests/browser/audit-smoke.mjs`。脚本检查真实对话框的焦点循环、Escape、焦点归还、390×844 登录布局与运行时错误。fixture 仅供开发服务器使用，不会进入 Vite 生产入口。
- 本次环境没有 Chromium；安装下载失败，因此没有把脚本列为已通过的测试。

## 尚需真机验收

| 环境 | 必测流程 | 本次状态 |
|---|---|---|
| 新、旧款 iPhone Safari／PWA | 键盘开合、旋转、图片及语音、密码／PRF enrollment、通行密钥取消与降级 | 未执行 |
| iPhone／iPad PWA | 后台 30 秒／5 分钟、锁屏、切 A→B、重复推播、通知跳转及找不到内容 | 未执行 |
| Android APK | 相同账号切换、后台锁定、通知与本机升级流程 | 未执行 |
| 各端弱网／离线 | 已有历史登录、snapshot 黑洞、持久化故障、保留未送草稿及重试同 logical ID | 自动回归覆盖部分逻辑；真机未执行 |
| 各端版本升级 | 不丢草稿、Service Worker 更新、vault migration、CSP 下自定义 relay／图床 | 未执行 |
| 1万／5万／10万历史、字体放大与 reduced-motion | 真实 IndexedDB 查询、输入与滑动 trace、读屏器和手势 | 未执行；不宣称 p95 或 50ms 目标已达成 |

## 回滚

第四批 UI 和标头可独立回滚，保留第三批 vault reader、账号数据加密和第二批数据库索引。关闭后台锁定即可恢复手动退出习惯。不要用旧前端覆盖已加密的数据库；详见第三批说明。
