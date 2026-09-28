<template>
  <div v-if="update && !dismissed" class="android-update-notification" role="status" aria-live="polite">
    <div class="android-update-content">
      <div class="android-update-icon" aria-hidden="true">↻</div>
      <div class="android-update-text">
        <h3>发现新版本 {{ update.versionName }}</h3>
        <p>{{ statusText || update.notes || "海内已有新的 Android 版本" }}</p>
      </div>
      <div class="android-update-actions">
        <button class="android-update-later" type="button" :disabled="updating" @click="dismissed = true">稍后</button>
        <button class="android-update-button" type="button" :disabled="updating" @click="startUpdate">
          {{ updating ? "下载并更新…" : "立即更新" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  checkAndroidUpdate,
  installAndroidUpdate,
  isNativeAndroidApp,
  onAndroidUpdateAvailable,
  type AndroidUpdateManifest,
} from "@/services/androidUpdater";

const update = ref<AndroidUpdateManifest | null>(null);
const dismissed = ref(false);
const updating = ref(false);
const statusText = ref("");
let initialTimer: number | null = null;
let unsubscribe: (() => void) | null = null;

async function refresh() {
  if (!isNativeAndroidApp()) return;
  try {
    await checkAndroidUpdate(false);
  } catch (error) {
    console.warn("[android-update] check failed", error);
  }
}

async function startUpdate() {
  if (!update.value || updating.value) return;
  updating.value = true;
  statusText.value = "正在下载更新包，完成后会打开 Android 安装界面";
  try {
    await installAndroidUpdate(update.value);
    statusText.value = "下载完成，请在 Android 系统界面确认更新";
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error || "");
    if (code === "INSTALL_PERMISSION_REQUIRED" || message.includes("INSTALL_PERMISSION_REQUIRED")) {
      statusText.value = "请先允许“海内”安装未知来源应用，返回后再次点立即更新";
    } else {
      statusText.value = message || "更新失败，请稍后重试";
    }
    updating.value = false;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") void refresh();
}

onMounted(() => {
  if (!isNativeAndroidApp()) return;
  unsubscribe = onAndroidUpdateAvailable(next => {
    update.value = next;
    dismissed.value = false;
    statusText.value = "";
  });
  initialTimer = window.setTimeout(() => void refresh(), 1_500);
  window.addEventListener("focus", refresh);
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", handleVisibilityChange);
});

onBeforeUnmount(() => {
  if (initialTimer !== null) window.clearTimeout(initialTimer);
  unsubscribe?.();
  window.removeEventListener("focus", refresh);
  window.removeEventListener("online", refresh);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
});
</script>

<style scoped>
.android-update-notification {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 10000;
  background: #111827;
  color: #fff;
  box-shadow: 0 4px 18px rgba(15, 23, 42, .24);
}

.android-update-content {
  width: min(100%, 920px);
  min-height: 72px;
  margin: 0 auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
}

.android-update-icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  border-radius: 50%;
  background: rgba(255,255,255,.12);
  font-size: 22px;
}

.android-update-text {
  min-width: 0;
  flex: 1;
}

.android-update-text h3 {
  margin: 0 0 3px;
  font-size: 14px;
  font-weight: 700;
}

.android-update-text p {
  margin: 0;
  color: #d1d5db;
  font-size: 12px;
  line-height: 1.45;
}

.android-update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.android-update-actions button {
  min-height: 38px;
  padding: 0 13px;
  border-radius: 9px;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.android-update-later {
  border: 1px solid rgba(255,255,255,.26);
  background: transparent;
  color: #e5e7eb;
}

.android-update-button {
  border: 0;
  background: #fff;
  color: #111827;
}

.android-update-actions button:disabled {
  opacity: .6;
}

@media (max-width: 560px) {
  .android-update-content {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .android-update-text {
    flex: 1 1 calc(100% - 50px);
  }

  .android-update-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
