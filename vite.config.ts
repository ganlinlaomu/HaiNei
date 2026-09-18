import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

const DEFAULT_PORT = 5173;


const rawAllowed = (process.env.ALLOWED_HOSTS ?? "localhost,127.0.0.1,raspberrypi.dzo-hadar.ts.net").trim();
const ALLOWED_HOSTS = rawAllowed === "" ? [] : rawAllowed.split(",").map(s => s.trim());

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    host: "0.0.0.0",
    port: DEFAULT_PORT,
    cors: true,
    // Vite 支持 allowedHosts: 可以是 string[] 或 'all'
    // 当 ALLOWED_HOSTS 包含 "*" 时，设为 'all'（允许所有 host）
    allowedHosts: ALLOWED_HOSTS.includes("*") ? "all" : ALLOWED_HOSTS,
    // 额外中间件：双重保护（可选），保留以便更灵活的自定义响应
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        try {
          if (ALLOWED_HOSTS.length === 0 || ALLOWED_HOSTS.includes("*")) {
            return next();
          }
          const hostHeader = (req.headers.host || "").toString();
          const hostOnly = hostHeader.split(":")[0];
          if (ALLOWED_HOSTS.includes(hostOnly)) {
            return next();
          }
          res.statusCode = 403;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Host not allowed by dev server configuration.");
        } catch (err) {
          next();
        }
      });
    }
  }
});
