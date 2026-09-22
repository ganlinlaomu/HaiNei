import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles.css";
import router from "./router";

import { useKeyStore } from "@/stores/keys";
import { clearExpiredCache } from "@/utils/imageCache";
import { initVersionTracking, handleVersionUpdate } from "@/utils/versionManager";

// 🔍 Check for version changes BEFORE mounting the app
const versionChanged = initVersionTracking();

if (versionChanged) {
  // Version changed - handle update and reload
  console.log("[main] Version changed detected, handling update...");
  
  handleVersionUpdate().then(() => {
    console.log("[main] Update complete, reloading...");
    window.location.reload();
  }).catch((e) => {
    console.error("[main] Failed to handle version update", e);
    // Force reload anyway - better to try than to leave broken state
    alert("检测到应用更新，正在刷新页面...");
    window.location.reload();
  });
  
  // Don't continue with app initialization
  // The page will reload after cleanup
} else {
  // Normal app initialization
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(router);

  // 🚀 优先渲染：先 mount，再恢复会话（避免首屏白屏）
  app.mount("#app");

  // 异步恢复登录态，不阻塞首屏渲染
  (async () => {
    const keys = useKeyStore();
    try {
      await keys.restoreSession();
    } catch (e) {
      console.error("[main] restoreSession failed", e);
    }
    
    // Clear expired image cache in background
    try {
      if (keys.pkHex) await clearExpiredCache(keys.pkHex);
    } catch (e) {
      console.warn("[main] clearExpiredCache failed", e);
    }
  })();

  // register service worker for production
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/service-worker.js", { updateViaCache: "none" })
        .then(() => {
          console.log("[main] Service Worker registered successfully");
        })
        .catch((err) => {
          console.warn("Service Worker 注册失败", err);
        });
    });
  }
}
