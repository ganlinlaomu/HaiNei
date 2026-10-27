<template>
  <section class="technical-section">
    <label class="account-row">
      <span>进入后台 5 分钟后锁定</span>
      <input type="checkbox" :checked="backgroundLock" @change="toggleBackgroundLock" />
    </label>
    <p class="section-detail">短暂切换应用不会锁定。再次打开时使用本地密码或通行密钥解锁。</p>
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
