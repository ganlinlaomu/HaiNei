<template>
  <section class="technical-section">
    <label class="background-lock-row">
      <span class="section-heading-main">
        <span class="section-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        </span>
        <span>
          <strong class="background-lock-title">后台锁定</strong>
          <span class="background-lock-summary">进入后台 5 分钟后锁定</span>
        </span>
      </span>
      <input type="checkbox" :checked="backgroundLock" @change="toggleBackgroundLock" />
    </label>
    <p class="section-detail background-lock-detail">短暂切换应用不会锁定。再次打开时使用本地密码或通行密钥解锁。</p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { autoLockKey } from "@/services/autoLock";
import { deviceStorage } from "@/services/deviceStorage";
import { useKeyStore } from "@/stores/keys";

const keyStore = useKeyStore();
const backgroundLock = ref(deviceStorage.getItem(autoLockKey(keyStore.pkHex)) === "1");
watch(() => keyStore.pkHex, pk => {
  if (pk) backgroundLock.value = deviceStorage.getItem(autoLockKey(pk)) === "1";
});
function toggleBackgroundLock(event: Event) {
 backgroundLock.value=(event.target as HTMLInputElement).checked;
 deviceStorage.setItem(autoLockKey(keyStore.pkHex),backgroundLock.value ? "1" : "0");
}
</script>

<style scoped src="./systemSettingsSection.css"></style>
<style scoped>
/* Same height and layout as a section heading, with the switch instead of a chevron. */
.background-lock-row{display:flex;min-height:68px;align-items:center;justify-content:space-between;gap:10px;padding:13px 4px 13px 0;cursor:pointer}
.background-lock-title{display:block;font-size:1rem}
.background-lock-summary{display:block;margin-top:6px;color:var(--fg-64748b);font-size:0.78rem;line-height:1.5}
.background-lock-row input{width:20px;height:20px;flex:0 0 20px}
/* Aligned with the title text, past the 24px icon and 12px gap. */
.background-lock-detail{padding-left:36px}
</style>
