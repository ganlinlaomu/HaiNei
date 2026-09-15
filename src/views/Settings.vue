<template>
  <main class="settings-container">
    <div v-if="settings.syncing" class="sync-status">正在同步加密设置…</div>
    <div v-else-if="settings.syncError" class="sync-status sync-warning">{{ settings.syncError }}</div>
    <div v-else-if="settings.lastSyncTimestamp" class="sync-status sync-ok">设置已通过 Nostr 加密同步</div>

    <section class="card">
      <h2>设置</h2>

      <div class="section">
        <div class="section-heading">
          <div>
            <h3>Relay</h3>
            <p>用户 Relay 优先，NIP-65 次之，默认 Relay 仅用于 fallback。</p>
          </div>
        </div>

        <form class="add-form" @submit.prevent="addRelay">
          <input
            v-model="newRelay"
            class="input"
            inputmode="url"
            autocapitalize="none"
            autocomplete="off"
            placeholder="wss://relay.example.com"
          />
          <button class="btn btn-primary" type="submit">添加</button>
        </form>

        <div class="item-list">
          <article v-for="relay in relayList" :key="relay.url" class="item-card">
            <div class="item-header">
              <div class="item-main">
                <div class="item-url">{{ relay.url }}</div>
                <div class="meta-row">
                  <span class="pill">{{ relaySourceLabel(relay.source) }}</span>
                  <span class="pill" :class="{ healthy: statuses[relay.url]?.ready, failed: relay.lastFailureAt && !statuses[relay.url]?.ready }">
                    {{ relayStatusLabel(relay) }}
                  </span>
                  <span v-if="relay.latency" class="pill">{{ relay.latency }}ms</span>
                </div>
              </div>
              <button
                v-if="!isBuiltinRelay(relay)"
                class="text-button danger"
                type="button"
                @click="removeRelay(relay)"
              >
                删除
              </button>
            </div>

            <div class="control-row">
              <label><input type="checkbox" :checked="relay.enabled" @change="toggleRelay(relay, 'enabled', $event)" />启用</label>
              <label><input type="checkbox" :checked="relay.read" @change="toggleRelay(relay, 'read', $event)" />读取</label>
              <label><input type="checkbox" :checked="relay.write" @change="toggleRelay(relay, 'write', $event)" />写入</label>
              <button class="text-button" type="button" @click="reconnect(relay.url)">重连</button>
            </div>
          </article>
        </div>
      </div>

      <div class="section">
        <div class="section-heading">
          <div>
            <h3>Media / 图片服务器</h3>
            <p>按 Primary、其他用户服务器、默认 fallback 的顺序上传。</p>
          </div>
        </div>

        <form class="media-add-form" @submit.prevent="addMediaServer">
          <select v-model="newMediaType" class="input compact-input">
            <option value="blossom">Blossom</option>
            <option value="imgbed">ImgBed</option>
            <option value="custom">Custom</option>
          </select>
          <input
            v-model="newMediaUrl"
            class="input"
            inputmode="url"
            autocapitalize="none"
            autocomplete="off"
            placeholder="https://media.example.com"
          />
          <input
            v-model="newMediaToken"
            class="input"
            type="password"
            autocomplete="off"
            placeholder="Token（可选）"
          />
          <button class="btn btn-primary" type="submit">添加</button>
        </form>

        <div class="item-list">
          <article v-for="server in mediaList" :key="server.id" class="item-card">
            <div class="item-header">
              <div class="item-main">
                <div class="item-url">{{ server.url }}</div>
                <div class="meta-row">
                  <span class="pill">{{ mediaTypeLabel(server.type) }}</span>
                  <span class="pill">{{ server.source === "user" ? "用户" : "默认" }}</span>
                  <span v-if="primaryMediaId === server.id" class="pill primary">Primary</span>
                  <span v-else-if="server.source === 'default'" class="pill">Fallback</span>
                </div>
              </div>
              <button
                v-if="!isBuiltinMedia(server)"
                class="text-button danger"
                type="button"
                @click="removeMediaServer(server)"
              >
                删除
              </button>
            </div>

            <div class="health-grid">
              <span>最近成功：{{ formatTimestamp(server.lastSuccessAt) }}</span>
              <span>最近失败：{{ formatTimestamp(server.lastFailureAt) }}</span>
            </div>

            <div class="control-row">
              <label><input type="checkbox" :checked="server.enabled" @change="toggleMediaServer(server, $event)" />启用</label>
              <button
                v-if="server.source === 'user' && primaryMediaId !== server.id"
                class="text-button"
                type="button"
                @click="settings.setPrimaryMediaServer(server.id)"
              >
                设为 Primary
              </button>
            </div>
          </article>
        </div>
      </div>

      <div class="section">
        <h3>缓存管理</h3>
        <div class="cache-info">
          <div class="small">
            <div>图片缓存：{{ cacheStats.count }} 个文件</div>
            <div>缓存大小：{{ formatSize(cacheStats.size) }}</div>
            <div v-if="cacheStats.oldestTimestamp">最早缓存：{{ new Date(cacheStats.oldestTimestamp).toLocaleDateString() }}</div>
          </div>
          <div class="button-row">
            <button class="btn btn-secondary" type="button" :disabled="loadingCache" @click="refreshCacheStats">
              {{ loadingCache ? "加载中…" : "刷新统计" }}
            </button>
            <button class="btn btn-warning" type="button" :disabled="clearingCache" @click="clearCache">
              {{ clearingCache ? "清理中…" : "清空缓存" }}
            </button>
          </div>
        </div>
      </div>

      <div class="section">
        <h3>账户</h3>
        <div class="account-row">
          <span class="small">已登录：{{ shortPk }}</span>
          <button class="btn btn-danger" type="button" @click="doLogout">退出登录</button>
        </div>
      </div>

      <div class="section">
        <h3>开发 / 诊断</h3>
        <div class="account-row">
          <span class="small">查看 Relay、NIP-17 与消息同步的本地实时日志</span>
          <button class="btn btn-secondary" type="button" @click="router.push('/debug')">系统诊断</button>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { inspectRelays, reconnectRelay } from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { clearAllCache, getCacheStats } from "@/utils/imageCache";
import {
  DEFAULT_MEDIA_SERVERS,
  DEFAULT_RELAY_URLS,
  type MediaServer,
  type MediaServerType,
  type RelayConfig,
  type RelaySource
} from "@/services/connectionSettings";

const keyStore = useKeyStore();
const settings = useSettingsStore();
const ui = useUIStore();
const router = useRouter();

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
const statuses = reactive<Record<string, { ready?: boolean }>>({});
const cacheStats = reactive({ count: 0, size: 0, oldestTimestamp: 0 });
const loadingCache = ref(false);
const clearingCache = ref(false);
let statusInterval: ReturnType<typeof setInterval> | null = null;

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
  return server.source === "default"
    || DEFAULT_MEDIA_SERVERS.some(item => item.id === server.id || item.url === server.url);
}

function relayStatusLabel(relay: RelayConfig) {
  if (!relay.enabled) return "已停用";
  if (statuses[relay.url]?.ready) return "已连接";
  if (relay.lastFailureAt) return "连接失败";
  return "未连接";
}

function formatTimestamp(timestamp?: number) {
  return timestamp ? new Date(timestamp).toLocaleString() : "—";
}

function addRelay() {
  if (!settings.addRelay(newRelay.value)) {
    ui.addToast("请输入有效的 Relay 地址", 2200, "error");
    return;
  }
  newRelay.value = "";
  refreshStatuses();
}

function removeRelay(relay: RelayConfig) {
  if (!confirm(`确定要删除 ${relay.url} 吗？`)) return;
  settings.deleteRelay(relay.url);
  delete statuses[relay.url];
}

function toggleRelay(relay: RelayConfig, field: "enabled" | "read" | "write", event: Event) {
  settings.updateRelay(relay.url, { [field]: (event.target as HTMLInputElement).checked });
}

function reconnect(url: string) {
  reconnectRelay(url);
  window.setTimeout(refreshStatuses, 800);
}

function addMediaServer() {
  if (!settings.addMediaServer(newMediaType.value, newMediaUrl.value, newMediaToken.value.trim())) {
    ui.addToast("请输入有效的媒体服务器地址", 2200, "error");
    return;
  }
  newMediaUrl.value = "";
  newMediaToken.value = "";
}

function removeMediaServer(server: MediaServer) {
  if (!confirm(`确定要删除 ${server.url} 吗？`)) return;
  settings.deleteMediaServer(server.id);
}

function toggleMediaServer(server: MediaServer, event: Event) {
  settings.updateMediaServer(server.id, { enabled: (event.target as HTMLInputElement).checked });
}

function refreshStatuses() {
  const current = inspectRelays();
  const activeUrls = new Set(relayList.value.map(relay => relay.url));
  for (const url of Object.keys(statuses)) {
    if (!activeUrls.has(url)) delete statuses[url];
  }
  for (const relay of relayList.value) statuses[relay.url] = current[relay.url] || { ready: false };
}

function startStatusPolling() {
  if (statusInterval) return;
  refreshStatuses();
  statusInterval = setInterval(refreshStatuses, 5_000);
}

function stopStatusPolling() {
  if (!statusInterval) return;
  clearInterval(statusInterval);
  statusInterval = null;
}

async function refreshCacheStats() {
  if (!keyStore.pkHex) return;
  loadingCache.value = true;
  try {
    Object.assign(cacheStats, await getCacheStats(keyStore.pkHex));
  } catch {
    ui.addToast("获取缓存统计失败", 2_000, "error");
  } finally {
    loadingCache.value = false;
  }
}

async function clearCache() {
  if (!keyStore.pkHex || !confirm("确定要清空所有图片缓存吗？")) return;
  clearingCache.value = true;
  try {
    await clearAllCache(keyStore.pkHex);
    await refreshCacheStats();
    ui.addToast("缓存已清空", 2_000, "success");
  } catch {
    ui.addToast("清空缓存失败", 2_000, "error");
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

onMounted(async () => {
  if (keyStore.pkHex && settings.loadedFor !== keyStore.pkHex) await settings.load(keyStore.pkHex);
  await refreshCacheStats();
  startStatusPolling();
});
onActivated(startStatusPolling);
onDeactivated(stopStatusPolling);
onBeforeUnmount(stopStatusPolling);
</script>

<style scoped>
.settings-container {
  max-width: 760px;
  margin: 0 auto;
  padding: 12px 12px calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px);
}

.card {
  padding: 18px;
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

.section {
  padding: 20px 0;
  border-top: 1px solid #e2e8f0;
}

.section:first-of-type {
  margin-top: 12px;
}

.section-heading p {
  margin-bottom: 14px;
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.5;
}

.sync-status {
  margin-bottom: 10px;
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
}

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
    padding-right: 8px;
    padding-left: 8px;
  }

  .card {
    padding: 14px;
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
</style>
