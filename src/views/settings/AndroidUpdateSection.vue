<template>
  <details class="technical-section">
    <summary class="section-heading">
      <div><h3>应用更新 / Update</h3><p>{{ androidUpdateSummary }}</p></div>
    </summary>
    <div class="account-row">
      <span class="small">{{ androidVersionName ? `当前版本：${androidVersionName}` : "Android APK 自动检查更新" }}</span>
      <button class="btn btn-secondary" type="button" :disabled="checkingAndroidUpdate" @click="checkForAndroidAppUpdate">
        {{ checkingAndroidUpdate ? "检查中…" : "检查更新" }}
      </button>
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { checkAndroidUpdate, getCurrentAndroidVersion } from "@/services/androidUpdater";
import { useUIStore } from "@/stores/ui";
import { useDeferredSettingsRefresh } from "./useDeferredSettingsRefresh";

/** Only mounted inside the Android APK. */
const ui = useUIStore();
const checkingAndroidUpdate = ref(false);
const androidVersionName = ref("");
const androidUpdateSummary = ref("自动检查更新");

async function refreshAndroidVersion() {
  try {
    const current = await getCurrentAndroidVersion();
    androidVersionName.value = current?.versionName || "";
  } catch {
    androidVersionName.value = "";
  }
}
useDeferredSettingsRefresh({ refresh: () => void refreshAndroidVersion() });

async function checkForAndroidAppUpdate() {
  if (checkingAndroidUpdate.value) return;
  checkingAndroidUpdate.value = true;
  androidUpdateSummary.value = "正在检查…";
  try {
    const update = await checkAndroidUpdate(true);
    if (update) {
      androidUpdateSummary.value = `发现新版本 ${update.versionName}`;
      ui.addToast(`发现新版本 ${update.versionName}`, 2_500, "success");
    } else {
      androidUpdateSummary.value = "已经是最新版本";
      ui.addToast("当前已经是最新版本", 2_000, "success");
    }
    await refreshAndroidVersion();
  } catch (error) {
    androidUpdateSummary.value = "检查失败";
    ui.addToast(error instanceof Error ? error.message : "检查更新失败", 2_500, "error");
  } finally {
    checkingAndroidUpdate.value = false;
  }
}
</script>

<style scoped src="./systemSettingsSection.css"></style>
