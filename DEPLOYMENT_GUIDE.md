# 快速部署指南 - PWA 更新功能

## 🚀 一键部署

```bash
# 1. 更新版本号（如果需要）
# 编辑 package.json 中的 version 字段
vim package.json

# 2. 构建应用
npm run build

# 3. 部署 dist/ 目录到服务器
# 方式 A: 直接复制
cp -r dist/* /var/www/html/

# 方式 B: 使用 rsync
rsync -avz dist/ user@server:/var/www/html/

# 方式 C: 使用 scp
scp -r dist/* user@server:/var/www/html/
```

## ☁️ 部署到 Cloudflare

### 方式 A: Cloudflare Pages

```bash
# 首次需要先登录
npm exec wrangler login

# 首次创建 Pages 项目
npm exec wrangler pages project create hainei

# 构建并部署
npm run deploy:cf:pages
```

如需部署到其他 Pages 项目，请先设置环境变量：

```bash
export CF_PAGES_PROJECT_NAME=your-project-name
```

或在 Cloudflare Pages 控制台配置：
- Framework preset: `None`
- Build command: `npm run build`
- Build output directory: `dist`

## ✅ 部署后验证

1. 访问应用 URL
2. 打开开发者工具 > Console
3. 查看日志确认版本:
   ```
   [SW] Installing version: X.X.X YYYY-MM-DD
   ```

## 🔄 更新现有部署

当你需要发布新版本:

```bash
# 1. 更新 package.json 版本号
{
  "version": "0.2.0",  // 从 0.1.0 更新
  ...
}

# 2. 构建新版本
npm run build

# 3. 部署到服务器（替换旧文件）
rsync -avz --delete dist/ user@server:/var/www/html/

# 4. 验证
# 用户在 60 秒内会看到更新通知
# 或者刷新页面自动更新
```

## 📝 版本更新自动化

构建时会自动运行:
- ✅ `update-app-version.js` - 同步 APP_VERSION
- ✅ `update-sw-version.js` - 更新 Service Worker 版本

你只需:
1. 更新 `package.json` 中的 version
2. 运行 `npm run build`
3. 部署

## ⚠️ 重要提示

### 版本号格式
支持标准语义化版本:
- ✅ `0.1.0`
- ✅ `1.2.3`
- ✅ `2.0.0-beta.1`
- ✅ `1.0.0-rc.2`

### 缓存策略
- **HTML**: Network-First（始终获取最新）
- **JS/CSS/图片**: Cache-First（提高性能）

### 用户体验
- 首次访问: 安装 Service Worker，缓存资源
- 版本更新: 显示通知，用户点击更新
- 自动检测: 每 60 秒检查一次更新

## 🐛 故障排除

### 问题: 用户仍然看到旧版本

**原因**: 浏览器可能缓存了旧的 service-worker.js 文件

**解决**:
1. 确保服务器不缓存 service-worker.js:
   ```nginx
   # nginx 配置
   location /service-worker.js {
     add_header Cache-Control "no-cache, no-store, must-revalidate";
     add_header Pragma "no-cache";
     add_header Expires "0";
   }
   ```

2. 或在 HTML 中添加:
   ```html
   <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
   ```

### 问题: 构建失败

**检查**:
1. Node.js 版本 >= 16
2. 所有依赖已安装: `npm install`
3. scripts/ 目录存在且脚本有执行权限

### 问题: 更新通知不显示

**检查**:
1. Service Worker 是否注册成功
2. 浏览器控制台是否有错误
3. 是否在 HTTPS 环境（localhost 除外）

## 📊 监控建议

部署后监控:
1. **版本分布**: 用户使用的版本分布
2. **更新成功率**: 更新完成的比例
3. **错误率**: JavaScript 错误数量
4. **加载性能**: 页面加载时间

可以使用:
- Google Analytics
- Sentry
- LogRocket
- 自定义分析

## 🔒 安全检查

- ✅ 已通过 CodeQL 安全扫描
- ✅ 无已知安全漏洞
- ✅ Service Worker 范围限制在根目录
- ✅ 不缓存敏感数据

## 📚 更多文档

- [完整解决方案文档](./PWA_UPDATE_SOLUTION.md)
- [详细测试指南](./PWA_UPDATE_TESTING_GUIDE.md)

## 💡 提示

### 开发环境
```bash
# 开发时不会触发版本更新（使用相同版本）
npm run dev
```

### 生产构建
```bash
# 每次构建都会更新时间戳，创建新的缓存版本
npm run build
```

### 测试更新流程
```bash
# 1. 构建版本 0.1.0
npm run build
# 部署

# 2. 修改版本为 0.1.1
# 编辑 package.json

# 3. 重新构建
npm run build
# 部署

# 4. 访问应用，应该看到更新通知
```

---

**需要帮助?** 查看完整文档或提交 Issue。
