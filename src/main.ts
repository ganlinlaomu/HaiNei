import { createApp } from "vue";
import { startupMark } from "@/utils/debugLog";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles.css";
import "./theme-tokens.css";
import router from "./router";

import { useKeyStore } from "@/stores/keys";
import { clearExpiredCache } from "@/utils/imageCache";
import { initVersionTracking, handleVersionUpdate } from "@/utils/versionManager";
import { migrateLegacyLocalStorage } from "@/services/legacyLocalStorageMigration";
import { initTheme } from "@/services/theme";
import { installChunkLoadRecovery } from "@/utils/chunkLoadRecovery";
import { installRuntimeDiagnostics } from "@/services/runtimeDiagnostics";
import { restoreWithWatchdog } from "@/utils/restoreWatchdog";

let serviceWorkerRegistration: Promise<ServiceWorkerRegistration> | null = null;
let serviceWorkerLoadListenerAttached = false;

function isNativeContainer() {
  const capacitor = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

function registerServiceWorkerNow() {
  if (serviceWorkerRegistration) return serviceWorkerRegistration;

  console.log("[main] sw_register_start");
  serviceWorkerRegistration = navigator.serviceWorker
    .register("/service-worker.js", { updateViaCache: "none" })
    .then(registration => {
      console.log("[main] sw_register_ok", {
        active: registration.active?.state ?? null,
        waiting: registration.waiting?.state ?? null,
        installing: registration.installing?.state ?? null,
      });
      return registration;
    })
    .catch(error => {
      serviceWorkerRegistration = null;
      console.warn("[main] sw_register_failed", error);
      throw error;
    });

  return serviceWorkerRegistration;
}

export function registerServiceWorker() {
  // Capacitor packages the app assets with the APK; running the PWA service
  // worker there can create a second cache/update lifecycle and stale bundles.
  if (isNativeContainer()) return;
  if (!("serviceWorker" in navigator)) return;

  if (document.readyState === "complete") {
    void registerServiceWorkerNow().catch(() => {});
    return;
  }

  if (serviceWorkerLoadListenerAttached) return;
  serviceWorkerLoadListenerAttached = true;
  window.addEventListener("load", () => {
    serviceWorkerLoadListenerAttached = false;
    void registerServiceWorkerNow().catch(() => {});
  }, { once: true });
}

async function bootstrap() {
  // Pinia is not active yet; report this with the "mounted" mark.
  const bootMs = Math.round(performance.now());
  // Device/session storage must be hydrated before version checks and before
  // Vue Router runs its auth guard. Otherwise restoreSession() sees an empty
  // in-memory deviceStorage map and permanently marks the session as restored.
  await migrateLegacyLocalStorage();
  // Device storage is hydrated now; apply an explicit light/dark choice before mount.
  initTheme();

  const versionChanged = initVersionTracking();
  if (versionChanged) {
    // The running bundle is already the new version and no data is cleared, so
    // only the marker needs updating. Reloading here used to race the async
    // IndexedDB write: an aborted write left the old marker and caused another
    // reload on the next start.
    console.log("[main] Version changed detected, updating marker...");
    try {
      await handleVersionUpdate();
    } catch (e) {
      console.error("[main] Failed to handle version update", e);
    }
  }
  // Normal app initialization
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(router);
  installChunkLoadRecovery(router);
  installRuntimeDiagnostics(app);

  // 🚀 优先渲染：先 mount，再恢复会话（避免首屏白屏）
  app.mount("#app");
  startupMark("mounted", { bootMs });

  // 异步恢复登录态，不阻塞首屏渲染
  (async () => {
    const keys = useKeyStore();
    try {
      await restoreWithWatchdog(() => keys.restoreSession());
      startupMark("session_restored", { loggedIn: keys.isLoggedIn, unlocked: keys.isUnlocked });
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
}

registerServiceWorker();

void bootstrap().catch(error => {
  console.error("[main] bootstrap failed", error);
  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  app.mount("#app");
});
