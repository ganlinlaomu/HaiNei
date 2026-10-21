import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { cspMetaPlugin } from "./build-plugins/cspMeta";
import { swPrecachePlugin } from "./build-plugins/swPrecache";

const DEFAULT_PORT = 5173;

// Third-party code loaded at startup changes far less often than app code.
// Keeping it in its own chunk lets the service worker reuse it across app
// releases, so an update only downloads HaiNei's own code. Only modules the
// entry reaches through static imports belong there: anything reached only
// through a lazy import (Trystero, zxing, settings-only helpers) must stay
// in its lazy chunk or it would start loading at launch.
type ModuleInfo = { isEntry: boolean; importers: readonly string[] } | null;
function startupVendor(id: string, getModuleInfo: (id: string) => ModuleInfo, seen = new Map<string, boolean>()): boolean {
  if (seen.has(id)) return seen.get(id)!;
  seen.set(id, false);
  const info = getModuleInfo(id);
  const reachable = !!info && (info.isEntry || info.importers.some(importer => startupVendor(importer, getModuleInfo, seen)));
  seen.set(id, reachable);
  return reachable;
}


const rawAllowed = (process.env.ALLOWED_HOSTS ?? "localhost,127.0.0.1,raspberrypi.dzo-hadar.ts.net").trim();
const ALLOWED_HOSTS = rawAllowed === "" ? [] : rawAllowed.split(",").map(s => s.trim());

export default defineConfig({
  // Dev server keeps no CSP so Vite HMR (ws://) keeps working.
  plugins: [vue(), cspMetaPlugin(path.resolve(__dirname, "public/_headers")), swPrecachePlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id, { getModuleInfo }) {
          if (id.includes("/node_modules/") && startupVendor(id, getModuleInfo)) return "vendor";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // NIP-77 negentropy is only reachable through nostr-tools' root bundle,
      // which would pull in every NIP; alias its standalone module instead.
      "nostr-tools-nip77": path.resolve(__dirname, "node_modules/nostr-tools/lib/esm/nip77.js")
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
