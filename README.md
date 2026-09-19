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


## 环境要求
- Node.js 16+（建议 18+）
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
npm run build
npm run preview
```

## Cloudflare 部署

```bash
# 首次需要先登录并创建 Pages 项目
npm exec wrangler login
export CF_PAGES_PROJECT_NAME=hainei
npm exec wrangler pages project create "$CF_PAGES_PROJECT_NAME"

# Cloudflare Pages
npm run deploy:cf:pages
```
