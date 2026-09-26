<template>
  <main class="settings-container app-page">
    <section v-if="!hasAccount" class="card">
      <h2>我的</h2>
      <p class="small">当前未登录。</p>
      <button class="btn btn-primary" type="button" @click="router.push('/login')">前往登录</button>
    </section>
    <section v-else class="card settings-card">
      <header class="my-profile-summary">
        <ProfileAvatar :pubkey="keyStore.pkHex" :local-name="nickname" :size="56" />
        <span><strong>{{ nickname }}</strong><small>{{ shortPk }}</small></span>
      </header>
      <button class="top-level-row" type="button" @click="router.push('/settings/profile')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><strong>我的资料</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/settings/saved')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg></span><strong>已收藏</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/friends')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 15.5a5 5 0 0 1 7 4.5"/></svg></span><strong>好友 / 好友分组</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/settings/system')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg></span><strong>设置</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
    </section>
  </main>
</template>
<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import {
  inspectRelays,
  onRelayConnectionState,
  reconnectRelay,
  type RelayRuntimeStatus
} from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { clearAllCache, getCacheStats } from "@/utils/imageCache";
import { registerOutgoingPushSigner, retryFailedOutgoing } from "@/nostr/messaging/service";
import {
  disablePushNotifications,
  enablePushNotifications,
  pushEnabledForAccount,
  supportsPushNotifications
} from "@/services/pushNotifications";
import {
  DEFAULT_RELAY_URLS,
  type MediaServer,
  type MediaServerType,
  type RelayConfig,
  type RelaySource
} from "@/services/connectionSettings";
import { isAccountResourceStale, runAfterFirstPaint } from "@/utils/bottomTabActivation";

const keyStore = useKeyStore();
const profiles = useProfilesStore();
const settings = useSettingsStore();
const ui = useUIStore();
const router = useRouter();

const hasAccount = computed(() => !!keyStore.pkHex);
const nickname = computed(() => profiles.getProfile(keyStore.pkHex)?.nickname?.trim() || "未设置昵称");
const shortPk = computed(() => keyStore.pkHex ? `${keyStore.pkHex.slice(0, 8)}...${keyStore.pkHex.slice(-6)}` : "");
const relayList = computed(() => settings.relayList);
const mediaList = computed(() => settings.mediaList);
const primaryMediaId = computed(() =>
  settings.activeMediaServers.find(server => server.source === "user")?.id || ""
);

const newRelay = ref("");
const newMediaType = ref<MediaServerType>("blossom");
const newMediaUrl = ref("");
const newMediaToken = ref("");
const statuses = reactive<Record<string, RelayRuntimeStatus | undefined>>({});
const cacheStats = reactive({ count: 0, size: 0, oldestTimestamp: 0 });
const loadingCache = ref(false);
const clearingCache = ref(false);
const pushBusy = ref(false);
const retryingQueue = ref(false);
const pushEnabled = ref(false);
const pushSupported = supportsPushNotifications();
const pushStatusText = computed(() => !pushSupported
  ? "不支持"
  : pushEnabled.value ? "已开启 · 通用隐私通知" : "未开启");
let statusInterval: ReturnType<typeof setInterval> | null = null;
let statusUnsubscribe: (() => void) | null = null;
let cacheRequestId = 0;
let cacheStatsAccount = "";
let cacheStatsUpdatedAt = 0;
let cacheRefresh: { account: string; promise: Promise<void> } | null = null;
let cancelScheduledCacheRefresh: (() => void) | null = null;
const CACHE_STATS_MAX_AGE_MS = 5 * 60_000;

function relaySourceLabel(source: RelaySource) {
  return source === "user" ? "用户" : source === "nip65" ? "NIP-65" : "默认";
}

function mediaTypeLabel(type: MediaServerType) {
  return type === "blossom" ? "Blossom" : type === "imgbed" ? "ImgBed" : "Custom";
}

function isBuiltinRelay(relay: RelayConfig) {
  return relay.source === "default" || (DEFAULT_RELAY_URLS as readonly string[]).includes(relay.url);
}

function isBuiltinMedia(server: MediaServer) {
  return server.source === "default";
}

function relayStatusLabel(relay: RelayConfig) {
  if (!relay.enabled) return "已停用";
  const runtime = statuses[relay.url];
  if (!runtime) return "未连接";
  if (runtime.state === "connected") return "已连接";
  if (runtime.state === "connecting") return "连接中…";
  if (runtime.state === "waiting-retry") return "重试中";
  return relay.lastFailureAt ? "连接失败" : "未连接";
}

function relayStatusTone(relay: RelayConfig) {
  const state = statuses[relay.url]?.state;
  return {
    healthy: state === "connected",
    pending: state === "connecting" || state === "waiting-retry",
    failed: state === "disconnected" && !!relay.lastFailureAt
  };
}

function formatTimestamp(timestamp?: number) {
  return timestamp ? new Date(timestamp).toLocaleString() : "—";
}

function formatSyncTimestamp(timestamp?: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "—";
}

function showValidationError(fallback: string) {
  ui.addToast(settings.validationError || fallback, 2_500, "error");
}

function addRelay() {
  if (!settings.addRelay(newRelay.value)) {
    showValidationError("请输入有效的 Relay 地址");
    return;
  }
  newRelay.value = "";
  refreshStatuses();
}

function removeRelay(relay: RelayConfig) {
  if (!confirm(`确定要删除 ${relay.url} 吗？`)) return;
  if (!settings.deleteRelay(relay.url)) {
    showValidationError("删除 Relay 失败");
    return;
  }
  delete statuses[relay.url];
}

function toggleRelay(relay: RelayConfig, field: "enabled" | "read" | "write", event: Event) {
  if (!settings.updateRelay(relay.url, { [field]: (event.target as HTMLInputElement).checked })) {
    showValidationError("更新 Relay 失败");
  }
}

function reconnect(url: string) {
  reconnectRelay(url);
  refreshStatuses();
}

function addMediaServer() {
  if (!settings.addMediaServer(newMediaType.value, newMediaUrl.value, newMediaToken.value.trim())) {
    showValidationError("请输入有效的媒体服务器地址");
    return;
  }
  newMediaUrl.value = "";
  newMediaToken.value = "";
}

function removeMediaServer(server: MediaServer) {
  if (!confirm(`确定要删除 ${server.url} 吗？`)) return;
  if (!settings.deleteMediaServer(server.id)) {
    showValidationError("删除媒体服务器失败");
  }
}

function toggleMediaServer(server: MediaServer, event: Event) {
  if (!settings.updateMediaServer(server.id, { enabled: (event.target as HTMLInputElement).checked })) {
    showValidationError("更新媒体服务器失败");
  }
}

function refreshStatuses() {
  const current = inspectRelays();
  const activeUrls = new Set(relayList.value.map(relay => relay.url));
  for (const url of Object.keys(statuses)) {
    if (!activeUrls.has(url)) delete statuses[url];
  }
  for (const relay of relayList.value) statuses[relay.url] = current[relay.url];
}

function startStatusPolling() {
  refreshStatuses();
  if (!statusInterval) statusInterval = setInterval(refreshStatuses, 5_000);
  if (!statusUnsubscribe) {
    statusUnsubscribe = onRelayConnectionState(() => {
      // onClose schedules retry immediately after emitting; next task observes
      // the final connecting/backoff state rather than a transient disconnect.
      window.setTimeout(refreshStatuses, 0);
    });
  }
}

function stopStatusPolling() {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = null;
  statusUnsubscribe?.();
  statusUnsubscribe = null;
}

async function refreshCacheStats(force = false) {
  const account = keyStore.pkHex;
  if (!account) {
    Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0 });
    return;
  }
  if (!force && !isAccountResourceStale(
    account,
    cacheStatsAccount,
    cacheStatsUpdatedAt,
    CACHE_STATS_MAX_AGE_MS
  )) return;
  if (!force && cacheRefresh?.account === account) return cacheRefresh.promise;
  const requestId = ++cacheRequestId;
  loadingCache.value = true;
  const promise = (async () => {
    try {
      const stats = await getCacheStats(account);
      if (requestId !== cacheRequestId || keyStore.pkHex !== account) return;
      Object.assign(cacheStats, stats);
      cacheStatsAccount = account;
      cacheStatsUpdatedAt = Date.now();
    } catch {
      if (requestId === cacheRequestId && keyStore.pkHex === account) {
        ui.addToast("获取缓存统计失败", 2_000, "error");
      }
    } finally {
      if (requestId === cacheRequestId) loadingCache.value = false;
      if (cacheRefresh?.promise === promise) cacheRefresh = null;
    }
  })();
  cacheRefresh = { account, promise };
  return promise;
}

function scheduleCacheStatsRefresh(force = false) {
  if (cancelScheduledCacheRefresh && !force) return;
  cancelScheduledCacheRefresh?.();
  cancelScheduledCacheRefresh = runAfterFirstPaint(() => {
    cancelScheduledCacheRefresh = null;
    void refreshCacheStats(force);
  });
}

async function clearCache() {
  const account = keyStore.pkHex;
  if (!account || !confirm("确定要清空所有图片缓存吗？")) return;
  clearingCache.value = true;
  try {
    await clearAllCache(account);
    if (keyStore.pkHex !== account) return;
    await refreshCacheStats(true);
    if (keyStore.pkHex === account) ui.addToast("缓存已清空", 2_000, "success");
  } catch {
    if (keyStore.pkHex === account) ui.addToast("清空缓存失败", 2_000, "error");
  } finally {
    clearingCache.value = false;
  }
}

function formatSize(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function doLogout() {
  keyStore.logout();
  location.href = "/#/login";
}

async function togglePush() {
  const account = keyStore.pkHex;
  if (!account || pushBusy.value) return;
  pushBusy.value = true;
  try {
    if (pushEnabled.value) await disablePushNotifications(account, event => keyStore.signEvent(event));
    else await enablePushNotifications(account, event => keyStore.signEvent(event));
    if (keyStore.pkHex !== account) return;
    pushEnabled.value = pushEnabledForAccount(account);
    ui.addToast(pushEnabled.value ? "后台推送已开启" : "后台推送已关闭", 2_000, "success");
  } catch (error) {
    if (keyStore.pkHex === account) ui.addToast(error instanceof Error ? error.message : "推送设置失败", 2_500, "error");
  } finally {
    pushBusy.value = false;
  }
}

async function retryFailedQueue() {
  const account = keyStore.pkHex;
  if (!account || retryingQueue.value) return;
  retryingQueue.value = true;
  try {
    registerOutgoingPushSigner(account, keyStore.signEvent.bind(keyStore));
    const results = await retryFailedOutgoing(account);
    const failures = results.filter(result => result.status === "rejected").length;
    ui.addToast(failures ? `仍有 ${failures} 项发送失败` : "待发送内容已重试", 2_000, failures ? "error" : "success");
  } finally {
    retryingQueue.value = false;
  }
}

watch(() => keyStore.pkHex, async pk => {
  cacheRequestId += 1;
  cacheRefresh = null;
  cancelScheduledCacheRefresh?.();
  cancelScheduledCacheRefresh = null;
  loadingCache.value = false;
  if (!pk) {
    settings.reset();
    Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0 });
    cacheStatsAccount = "";
    cacheStatsUpdatedAt = 0;
    for (const url of Object.keys(statuses)) delete statuses[url];
    pushEnabled.value = false;
    return;
  }
  if (cacheStatsAccount !== pk) Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0 });
  pushEnabled.value = pushEnabledForAccount(pk);
  if (settings.loadedFor !== pk) await settings.load(pk);
  if (keyStore.pkHex !== pk || settings.loadedFor !== pk) return;
  scheduleCacheStatsRefresh();
}, { immediate: true });

onMounted(startStatusPolling);
onActivated(() => {
  startStatusPolling();
  scheduleCacheStatsRefresh();
});
onDeactivated(() => {
  stopStatusPolling();
  cancelScheduledCacheRefresh?.();
  cancelScheduledCacheRefresh = null;
});
onBeforeUnmount(() => {
  stopStatusPolling();
  cancelScheduledCacheRefresh?.();
});
</script>

<style scoped>
.settings-container {
  width: 100%;
  margin: 0 auto;
  padding: 0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px);
  box-sizing: border-box;
}

.card {
  padding: 16px;
  border: 1px solid #e8edf3;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.035);
}

.settings-card {
  padding: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  overflow: hidden;
}

.my-profile-summary {
  display: flex;
  min-height: 88px;
  align-items: center;
  gap: 13px;
  padding: 15px 16px;
}
.my-profile-summary > span {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.my-profile-summary strong {
  overflow: hidden;
  color: #172033;
  font-size: 1.05rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.my-profile-summary small {
  color: #64748b;
  font-size: .78rem;
}

h2,
h3,
p {
  margin-top: 0;
}

h2 {
  margin-bottom: 4px;
}

h3 {
  margin-bottom: 6px;
  font-size: 1rem;
}

.top-level-row {
  display: flex;
  width: 100%;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 16px;
  border: 0;
  border-top: 1px solid #e2e8f0;
  background: transparent;
  color: #1e293b;
  text-align: left;
  cursor: pointer;
  list-style: none;
}
.top-level-row::-webkit-details-marker { display: none; }
.row-main { display: flex; min-width: 0; align-items: center; gap: 12px; }
.row-main strong { font-size: .94rem; font-weight: 600; }
.row-icon { display: grid; width: 24px; height: 24px; flex: 0 0 24px; place-items: center; color: #475569; }
.row-icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.row-chevron { flex: 0 0 auto; color: #94a3b8; font-size: 22px; transition: transform 160ms ease; }
.top-level-group[open] > .top-level-row .row-chevron { transform: rotate(90deg); }
.top-level-content { padding: 4px 16px 16px; border-top: 1px solid #eef2f6; }
.top-level-content.account-row { min-height: 64px; }
.technical-settings { padding-top: 0; }

.technical-section {
  padding: 0;
  border-top: 1px solid #e2e8f0;
}

.technical-section:first-child {
  border-top: 0;
}

.section-heading {
  min-height: 68px;
  padding: 13px 28px 13px 0;
  position: relative;
  display: flex;
  align-items: center;
  cursor: pointer;
  list-style: none;
}
.section-heading::-webkit-details-marker { display: none; }
.section-heading::after {
  content: "›";
  position: absolute;
  right: 4px;
  color: #94a3b8;
  font-size: 22px;
  transform: rotate(90deg);
  transition: transform 160ms ease;
}
.technical-section[open] > .section-heading::after { transform: rotate(-90deg); }

.section-heading p {
  margin: 2px 0 0;
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.5;
}
.data-mode {
  display: flex;
  gap: 8px;
  padding: 2px 0 10px;
}
.data-mode label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 42px;
  padding: 0 14px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  color: #334155;
  cursor: pointer;
}
.section-detail {
  margin: 0 0 14px;
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.55;
}

.sync-status {
  margin: 10px 12px;
  padding: 9px 12px;
  border-radius: 9px;
  background: #e0f2fe;
  color: #075985;
  font-size: 0.8rem;
}

.sync-warning {
  background: #fff7ed;
  color: #9a3412;
}

.sync-ok {
  background: #ecfdf5;
  color: #047857;
}

.add-form,
.media-add-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  margin-bottom: 14px;
}

.media-add-form {
  grid-template-columns: 120px minmax(0, 1fr) minmax(120px, 0.7fr) auto;
}

.input {
  min-height: 44px;
  margin: 0;
}

.item-list {
  display: grid;
  gap: 10px;
}

.item-card {
  padding: 13px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fafc;
}

.item-header,
.control-row,
.button-row,
.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.item-main {
  min-width: 0;
}

.item-url {
  color: #1e293b;
  font-size: 0.84rem;
  overflow-wrap: anywhere;
}

.meta-row {
  margin-top: 7px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.pill {
  padding: 3px 7px;
  border-radius: 999px;
  background: #e2e8f0;
  color: #475569;
  font-size: 0.68rem;
}

.pill.healthy,
.pill.primary {
  background: #d1fae5;
  color: #047857;
}

.pill.failed {
  background: #fee2e2;
  color: #b91c1c;
}

.pill.pending {
  background: #fef3c7;
  color: #92400e;
}

.control-row {
  margin-top: 12px;
  justify-content: flex-start;
  flex-wrap: wrap;
}

.control-row label {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #475569;
  font-size: 0.78rem;
}

.control-row input {
  width: 17px;
  height: 17px;
}

.text-button {
  min-height: 36px;
  padding: 5px 8px;
  border: 0;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
}

.text-button.danger {
  color: #b91c1c;
}

.health-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  color: #64748b;
  font-size: 0.7rem;
}

.cache-info {
  display: grid;
  gap: 12px;
  padding-bottom: 16px;
}

.technical-section > .add-form,
.technical-section > .media-add-form,
.technical-section > .item-list,
.technical-section > .account-row { margin-bottom: 16px; }

.small {
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.6;
}

.btn {
  min-height: 42px;
}

.btn-secondary {
  background: #475569;
}

.btn-warning {
  background: #d97706;
}

.btn-danger {
  background: #dc2626;
}

@media (max-width: 640px) {
  .settings-container {
    padding-right: 0;
    padding-left: 0;
  }

  .card {
    padding: 14px;
  }

  .settings-card {
    padding: 0;
  }

  .media-add-form {
    grid-template-columns: 110px minmax(0, 1fr);
  }

  .media-add-form .btn,
  .media-add-form input[type="password"] {
    grid-column: 1 / -1;
  }

  .health-grid {
    grid-template-columns: 1fr;
  }

  .account-row {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .section-heading::after,
  .row-chevron { transition: none; }
}
</style>
