<template>
  <details class="technical-section">
    <summary class="section-heading">
      <div class="section-heading-main">
        <span class="section-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>
        </span>
        <div>
          <h3>后台推送 / {{ isNativeApp ? "Android Push" : "Web Push" }}</h3>
          <p>{{ pushStatusText }}</p>
        </div>
      </div>
    </summary>
    <p class="section-detail">推送用于消息与来电提醒，显示“你有新的私信消息”或“你有一个语音来电”，不会包含好友名称、消息内容或图片信息。</p>
    <div class="account-row">
      <span class="small">{{ pushHelpText }}</span>
      <button v-if="!isNativeApp" class="btn btn-secondary" type="button" :disabled="pushBusy || !pushSupported" @click="togglePush">
        {{ pushBusy ? "处理中…" : pushEnabled ? "关闭推送" : "开启推送" }}
      </button>
      <span v-else class="pill pending">原生 Push 待启用</span>
      <button v-if="!isNativeApp && pushEnabled" class="btn btn-secondary" type="button" :disabled="pushBusy" @click="testCurrentPush">测试本机推送</button>
    </div>
    <p v-if="pushTestResult" class="section-detail" role="status">{{ pushTestResult }}</p>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  disablePushNotifications,
  enablePushNotifications,
  pushEnabledForAccount,
  supportsPushNotifications,
  testPushNotification
} from "@/services/pushNotifications";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";

const props = defineProps<{ isNativeApp: boolean }>();
const keyStore = useKeyStore();
const friendships = useFriendshipsStore();
const ui = useUIStore();
const pushBusy = ref(false);
const pushTestResult = ref("");
const pushEnabled = ref(false);
const pushSupported = !props.isNativeApp && supportsPushNotifications();
const pushStatusText = computed(() => props.isNativeApp
  ? "原生通知将在下一阶段启用"
  : !pushSupported
    ? "不支持"
    : pushEnabled.value ? "已开启 · 通用隐私通知" : "未开启");
const pushHelpText = computed(() => props.isNativeApp
  ? "Android APK 已禁用 PWA Service Worker；后续将接入原生 Push 与 Badge。"
  : pushSupported ? "需要你主动授权浏览器通知权限" : "当前浏览器不支持 Web Push");

watch(() => keyStore.pkHex, pk => {
  pushEnabled.value = pk ? pushEnabledForAccount(pk) : false;
}, { immediate: true });

async function testCurrentPush() {
  const account = keyStore.pkHex;
  if (!account || pushBusy.value) return;
  pushBusy.value = true;
  pushTestResult.value = "正在检查本机订阅并发送测试通知…";
  try {
    const result = await testPushNotification(account, event => keyStore.signEvent(event));
    if (keyStore.pkHex === account) pushTestResult.value = result;
  } catch (error) {
    if (keyStore.pkHex === account) pushTestResult.value = error instanceof Error ? error.message : "测试推送失败";
  } finally {
    pushBusy.value = false;
  }
}

async function togglePush() {
  const account = keyStore.pkHex;
  if (!account || pushBusy.value) return;
  pushBusy.value = true;
  try {
    if (pushEnabled.value) await disablePushNotifications(account, event => keyStore.signEvent(event));
    else {
      if (friendships.loadedFor !== account || !friendships.authorizationReady) await friendships.load(account);
      const acceptedSenders = friendships.records
        .filter(record => record.state === "accepted")
        .map(record => record.peerPubkey);
      await enablePushNotifications(account, event => keyStore.signEvent(event), acceptedSenders);
    }
    if (keyStore.pkHex !== account) return;
    pushEnabled.value = pushEnabledForAccount(account);
    ui.addToast(pushEnabled.value ? "后台推送已开启" : "后台推送已关闭", 2_000, "success");
  } catch (error) {
    if (keyStore.pkHex === account) ui.addToast(error instanceof Error ? error.message : "推送设置失败", 2_500, "error");
  } finally {
    pushBusy.value = false;
  }
}
</script>

<style scoped src="./systemSettingsSection.css"></style>
