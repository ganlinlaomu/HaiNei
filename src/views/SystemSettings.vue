<template>
  <main class="settings-container system-settings-page app-page">
    <SecondaryPageHeader title="设置" back-label="返回我的" />
    <div v-if="settings.syncing" class="sync-status">{{ settings.syncStatusText || "正在同步加密设置…" }}</div>
    <div v-else-if="settings.syncError" class="sync-status sync-warning">{{ settings.syncError }}</div>
    <div v-else-if="settings.lastRelaySyncTimestamp || settings.lastMediaSyncTimestamp" class="sync-status sync-ok">
      已同步设置：<span v-if="settings.lastRelaySyncTimestamp">Relay {{ formatSyncTimestamp(settings.lastRelaySyncTimestamp) }}</span><span v-if="settings.lastRelaySyncTimestamp && settings.lastMediaSyncTimestamp"> · </span><span v-if="settings.lastMediaSyncTimestamp">Media {{ formatSyncTimestamp(settings.lastMediaSyncTimestamp) }}</span>
    </div>
    <section class="system-content">
      <details class="technical-section" open>
        <summary class="section-heading">
          <div>
            <h3>连接 / Relay</h3>
            <p>{{ relayList.filter(relay => relay.enabled).length }} 个已启用 · 用户、NIP-65 与 fallback</p>
          </div>
        </summary>
        <p class="section-detail">HaiNei System Relay 固定保持读取/写入，确保用户之间至少有共同投递点；自定义 Relay 作为额外冗余。</p>

        <article class="item-card dm-relay-card">
          <div class="item-header">
            <div class="item-main">
              <div class="item-url">私信 Relay / kind 10050</div>
              <div class="meta-row">
                <span class="pill">NIP-17</span>
                <span class="pill" :class="dmRelayStatusTone">{{ dmRelayStatusLabel }}</span>
                <span class="pill">最多 2 个接收点</span>
              </div>
            </div>
          </div>
          <p class="dm-relay-copy">自动从现有读取 Relay 中选择接收点，并将 kind 10050 发布到公共目录。发信时优先使用对方列表；未找到时兼容传统 Relay。公共目录仅用于列表发现，不传送私信；不会为每位联系人保持额外长连接。</p>
          <div class="dm-relay-list">
            <span v-for="relay in dmRelayStatus.relays" :key="relay">{{ relay }}</span>
            <span v-if="!dmRelayStatus.relays.length">等待可用的安全 Relay</span>
          </div>
        </article>

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
                  <span class="pill">{{ isBuiltinRelay(relay) ? "System" : relaySourceLabel(relay.source) }}</span>
                  <span class="pill" :class="relayStatusTone(relay)">
                    {{ relayStatusLabel(relay) }}
                  </span>
                  <span v-if="relay.read" class="pill">Read</span>
                  <span v-if="relay.write" class="pill">Write</span>
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

            <div v-if="relay.lastConnectedAt" class="relay-last-seen">最近连接：{{ formatTimestamp(relay.lastConnectedAt) }}</div>

            <div class="control-row">
              <template v-if="!isBuiltinRelay(relay)">
                <label><input type="checkbox" :checked="relay.enabled" @change="toggleRelay(relay, 'enabled', $event)" />启用</label>
                <label><input type="checkbox" :checked="relay.read" @change="toggleRelay(relay, 'read', $event)" />读取</label>
                <label><input type="checkbox" :checked="relay.write" @change="toggleRelay(relay, 'write', $event)" />写入</label>
              </template>
              <span v-else class="system-relay-lock">系统固定 · Read / Write</span>
              <button class="text-button" type="button" @click="reconnect(relay.url)">重连</button>
            </div>
          </article>
        </div>
      </details>

      <details class="technical-section">
        <summary class="section-heading">
          <div>
            <h3>图片与视频 / Media</h3>
            <p>{{ mediaList.filter(server => server.enabled).length }} 个已启用 · Primary 与 fallback</p>
          </div>
        </summary>
        <p class="section-detail">按 Primary、其他用户服务器、默认 fallback 的顺序上传。媒体服务器仅支持 HTTPS；localhost 可用于本地调试。</p>

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
                v-if="server.source === 'user' && server.enabled && primaryMediaId !== server.id"
                class="text-button"
                type="button"
                @click="settings.setPrimaryMediaServer(server.id)"
              >
                设为 Primary
              </button>
            </div>
          </article>
        </div>
      </details>

      <details class="technical-section" open>
        <summary class="section-heading">
          <div><h3>隐私 / Privacy</h3><p>{{ settings.settings.privacy.readReceipts ? "已读回执已开启" : "已读回执已关闭" }}</p></div>
        </summary>
        <div class="account-row">
          <div class="privacy-copy">
            <strong>已读回执</strong>
            <span class="small">关闭后，你不会向好友发送“已读”，同时也不会看到对方的“已读”状态；“已送达”仍会正常显示。</span>
          </div>
          <label class="privacy-toggle">
            <input
              type="checkbox"
              :checked="settings.settings.privacy.readReceipts"
              aria-label="已读回执"
              @change="toggleReadReceipts"
            />
            <span aria-hidden="true"></span>
          </label>
        </div>
      </details>

      <section v-if="keyStore.credentialMode === 'password' || keyStore.credentialMode === 'passkey'" class="technical-section">
        <label class="account-row">
          <span>进入后台 5 分钟后锁定</span>
          <input type="checkbox" :checked="backgroundLock" @change="toggleBackgroundLock" />
        </label>
        <p class="section-detail">短暂切换应用不会锁定。再次打开时使用本地密码或通行密钥解锁。</p>
      </section>

      <details class="technical-section">
        <summary class="section-heading">
          <div><h3>数据使用 / Data Saver</h3><p>{{ settings.dataSaver ? "节省流量" : "标准" }}</p></div>
        </summary>
        <div class="data-mode" role="radiogroup" aria-label="数据使用模式">
          <label><input type="radio" :checked="!settings.dataSaver" @change="settings.setDataSaver(false)" /> 标准</label>
          <label><input type="radio" :checked="settings.dataSaver" @change="settings.setDataSaver(true)" /> 节省流量</label>
        </div>
        <p class="section-detail">节省流量模式会缩短图片预加载距离，并避免不必要的视频预加载。</p>
      </details>

      <details v-if="isNativeAndroid" class="technical-section">
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

      <details class="technical-section">
        <summary class="section-heading">
          <div><h3>后台推送 / {{ isNativeApp ? "Android Push" : "Web Push" }}</h3><p>{{ pushStatusText }}</p></div>
        </summary>
        <p class="section-detail">推送仅用于私信，固定显示“你有新的私信消息”，不会包含好友名称、消息内容或图片信息。</p>
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

      <details class="technical-section">
        <summary class="section-heading">
          <div><h3>存储 / Cache</h3><p>内存 {{ formatSize(cacheStats.size) }} / {{ formatSize(IMAGE_MEMORY_CACHE_MAX_BYTES) }} · 本地 {{ formatSize(cacheStats.persistentSize) }} / {{ formatSize(IMAGE_PERSISTENT_CACHE_MAX_BYTES) }}</p></div>
        </summary>
        <div class="cache-info">
          <div class="small">
            <div>内存缓存：{{ cacheStats.count }} 个文件 · {{ formatSize(cacheStats.size) }} / {{ formatSize(IMAGE_MEMORY_CACHE_MAX_BYTES) }}</div>
            <div>加密本地缓存：{{ cacheStats.persistentCount }} 个文件 · {{ formatSize(cacheStats.persistentSize) }} / {{ formatSize(IMAGE_PERSISTENT_CACHE_MAX_BYTES) }}</div>
            <div>内存缓存会在锁定、切换账号或退出后清除；加密本地缓存保留，解锁后按需解密。</div>
            <div v-if="cacheStats.persistentOldestTimestamp">最早本地缓存：{{ new Date(cacheStats.persistentOldestTimestamp).toLocaleDateString() }}</div>
          </div>
          <div class="button-row">
            <button class="btn btn-secondary" type="button" :disabled="loadingCache" @click="refreshCacheStats(true)">
              {{ loadingCache ? "加载中…" : "刷新统计" }}
            </button>
            <button class="btn btn-warning" type="button" :disabled="clearingCache" @click="clearCache">
              {{ clearingCache ? "清理中…" : "清空缓存" }}
            </button>
          </div>
        </div>
      </details>

      <details class="technical-section diagnostics-section">
        <summary class="section-heading"><div><h3>高级设置 / Diagnostics</h3><p>{{ diagnosticsSummary }}</p></div></summary>
        <div class="diagnostics-grid">
          <span><strong>{{ connectedRelayCount }}/{{ enabledRelayCount }}</strong><small>Relay 已连接</small></span>
          <span><strong>{{ syncStatusLabel }}</strong><small>消息同步</small></span>
          <span><strong>{{ lastCatchupLabel }}</strong><small>最近补拉</small></span>
          <span><strong>{{ diagnostics.pendingOutgoing }}</strong><small>待发送</small></span>
        </div>
        <div class="account-row">
          <span class="small">查看 Relay、NIP-17 与消息同步的本地实时日志</span>
          <div class="button-row">
            <button class="btn btn-secondary" type="button" :disabled="retryingQueue" @click="retryFailedQueue">
              {{ retryingQueue ? "重试中…" : "重试发送" }}
            </button>
            <button class="btn btn-secondary" type="button" @click="router.push('/debug')">系统诊断</button>
          </div>
        </div>
      </details>

      <details class="technical-section account-section identity-section">
        <summary class="section-heading account-heading">
          <div class="account-heading-main">
            <span class="account-heading-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>
            </span>
            <div>
              <h3>账户</h3>
              <p>{{ nickname }} · {{ shortPk }} · {{ accountProtectionText }}</p>
            </div>
          </div>
        </summary>
        <div class="account-panel">
          <div class="account-control-card">
            <div v-if="keyStore.loginMethod === 'nip46'" class="account-setting-row biometric-row">
              <div class="privacy-copy">
                <strong>远程签名器（Beta）</strong>
                <span class="small">{{ keyStore.remoteSignerConnected ? "已连接 · 发帖、评论、私信与加密操作由远程签名器授权" : "当前离线 · 可浏览本机缓存，签名与加密操作暂停" }}</span>
              </div>
              <button
                class="account-inline-action"
                type="button"
                :disabled="remoteSignerBusy || keyStore.remoteSignerConnected"
                @click="reconnectRemoteSigner"
              >
                {{ remoteSignerBusy ? "连接中…" : keyStore.remoteSignerConnected ? "已连接" : "重新连接" }}
              </button>
            </div>
            <div v-if="keyStore.loginMethod === 'private-key' && keyStore.isEncrypted" class="account-setting-row biometric-row">
              <div class="privacy-copy">
                <strong>{{ biometricLabel }} 登录保护</strong>
                <span class="small">{{ biometricEnabled ? "已开启，重新打开时需验证后进入海内" : biometricSupported ? "开启后用 Face ID、指纹或设备锁保护登录" : "当前环境未通过预检，仍可尝试启用" }}</span>
              </div>
              <button
                class="account-inline-action"
                type="button"
                :disabled="biometricBusy"
                @click="toggleBiometricUnlock"
              >
                {{ biometricBusy ? "处理中…" : biometricEnabled ? "关闭" : "启用" }}
              </button>
            </div>

            <div class="account-actions-row">
              <button class="account-action-button account-action-secondary" type="button" @click="switchAccount">
                切换账号
              </button>
              <button class="account-action-button account-action-primary" type="button" @click="addAccount">
                添加账号
              </button>
            </div>

            <div class="account-danger-row">
              <button class="account-danger-button" type="button" @click="doLogout">
                退出登录
              </button>
            </div>
          </div>
        </div>
      </details>

    </section>

    <footer class="version-footer" aria-label="当前应用版本">
      HaiNei v{{ APP_VERSION }} · {{ APP_UPDATE_SUMMARY }}
    </footer>
  </main>
</template>
<script setup lang="ts">
import { deviceStorage } from "@/services/deviceStorage";
import { APP_VERSION } from "@/db/dexie";
import { APP_UPDATE_SUMMARY } from "@/appRelease";
import { autoLockKey } from "@/services/autoLock";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  inspectRelays,
  onRelayConnectionState,
  reconnectRelay,
  type RelayRuntimeStatus
} from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { useProfilesStore } from "@/stores/profiles";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import {
  clearAllCache,
  getCacheStats,
  IMAGE_MEMORY_CACHE_MAX_BYTES,
  IMAGE_PERSISTENT_CACHE_MAX_BYTES,
} from "@/utils/imageCache";
import { registerOutgoingPushSigner, retryFailedOutgoing } from "@/nostr/messaging/service";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import {
  disablePushNotifications,
  enablePushNotifications,
  pushEnabledForAccount,
  supportsPushNotifications,
  testPushNotification
} from "@/services/pushNotifications";
import {
  DEFAULT_RELAY_URLS,
  type MediaServer,
  type MediaServerType,
  type RelayConfig,
  type RelaySource
} from "@/services/connectionSettings";
import { isAccountResourceStale, runAfterFirstPaint, runWhenIdle } from "@/utils/bottomTabActivation";
import {
  checkAndroidUpdate,
  getCurrentAndroidVersion,
  isNativeAndroidApp,
} from "@/services/androidUpdater";
import { getOwnDmRelayStatus } from "@/services/dmRelayDirectory";

const keyStore = useKeyStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();
const settings = useSettingsStore();
const ui = useUIStore();
const router = useRouter();

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
const cacheStats = reactive({ count: 0, size: 0, oldestTimestamp: 0, persistentCount: 0, persistentSize: 0, persistentOldestTimestamp: 0 });
const loadingCache = ref(false);
const clearingCache = ref(false);
const pushBusy = ref(false);
const pushTestResult = ref("");
const retryingQueue = ref(false);
const pushEnabled = ref(false);
const biometricSupported = ref(false);
const biometricBusy = ref(false);
const remoteSignerBusy = ref(false);
const biometricRevision = ref(0);
const isNativeApp = (() => {
  const capacitor = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
})();
const isNativeAndroid = isNativeAndroidApp();
const checkingAndroidUpdate = ref(false);
const androidVersionName = ref("");
const androidUpdateSummary = ref("自动检查更新");
const pushSupported = !isNativeApp && supportsPushNotifications();
const pushStatusText = computed(() => isNativeApp
  ? "原生通知将在下一阶段启用"
  : !pushSupported
    ? "不支持"
    : pushEnabled.value ? "已开启 · 通用隐私通知" : "未开启");
const pushHelpText = computed(() => isNativeApp
  ? "Android APK 已禁用 PWA Service Worker；后续将接入原生 Push 与 Badge。"
  : pushSupported ? "需要你主动授权浏览器通知权限" : "当前浏览器不支持 Web Push");
const backgroundLock = ref(deviceStorage.getItem(autoLockKey(keyStore.pkHex)) === "1");
function toggleBackgroundLock(event: Event) {
 backgroundLock.value=(event.target as HTMLInputElement).checked;
 deviceStorage.setItem(autoLockKey(keyStore.pkHex),backgroundLock.value ? "1" : "0");
}
const biometricEnabled = computed(() => {
  void biometricRevision.value;
  return keyStore.hasBiometricUnlock();
});
const biometricLabel = computed(() => "通行密钥");
const accountProtectionText = computed(() => {
  if (keyStore.loginMethod === "nip46") {
    return keyStore.remoteSignerConnected ? "远程签名器 · 已连接" : "远程签名器 · 离线";
  }
  return biometricEnabled.value
    ? `${biometricLabel.value}保护`
    : keyStore.credentialMode === "device"
      ? "本机保持登录"
      : keyStore.credentialMode === "password" ? "本地密码保护" : "仅当前会话";
});
const enabledRelayCount = computed(() => relayList.value.filter(relay => relay.enabled).length);
const connectedRelayCount = computed(() => relayList.value.filter(relay => relay.enabled && statuses[relay.url]?.state === "connected").length);
const diagnostics = reactive({
  syncStatus: "idle",
  lastCatchupCompletedAt: 0,
  pendingOutgoing: 0,
});
const dmRelayStatus = reactive<{
  relays: string[];
  eventId?: string;
  publishedAt?: number;
  pending: boolean;
  attempts: number;
  lastError?: string;
}>({ relays: [], pending: false, attempts: 0 });
const dmRelayStatusLabel = computed(() =>
  dmRelayStatus.pending
    ? "等待发布重试"
    : dmRelayStatus.publishedAt
      ? "已发布"
      : "自动配置中"
);
const dmRelayStatusTone = computed(() => ({
  healthy: !!dmRelayStatus.publishedAt && !dmRelayStatus.pending,
  pending: dmRelayStatus.pending || !dmRelayStatus.publishedAt,
  failed: !!dmRelayStatus.lastError && dmRelayStatus.pending,
}));
function syncStatusText(status: string) {
  if (status === "idle") return "Idle";
  if (status === "connecting") return "连接中";
  if (status === "catching-up") return "补拉中";
  if (status === "live") return "Live";
  if (status === "offline") return "离线";
  if (status === "error") return "错误";
  return status;
}
const syncStatusLabel = computed(() => syncStatusText(diagnostics.syncStatus));
const lastCatchupLabel = computed(() => diagnostics.lastCatchupCompletedAt
  ? formatRelativeTimestamp(diagnostics.lastCatchupCompletedAt)
  : "—");
const diagnosticsSummary = computed(() =>
  `Relay ${connectedRelayCount.value}/${enabledRelayCount.value} · ${syncStatusLabel.value} · 待发送 ${diagnostics.pendingOutgoing}`
);
let statusInterval: ReturnType<typeof setInterval> | null = null;
let statusUnsubscribe: (() => void) | null = null;
let cacheRequestId = 0;
let cacheStatsAccount = "";
let cacheStatsUpdatedAt = 0;
let cacheRefresh: { account: string; promise: Promise<void> } | null = null;
let cancelScheduledCacheRefresh: (() => void) | null = null;
let cancelDeferredRuntimeRefresh: (() => void) | null = null;
let viewActive = false;
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

function formatRelativeTimestamp(timestamp?: number) {
  if (!timestamp) return "—";
  const ms = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return new Date(ms).toLocaleDateString();
}

async function refreshDiagnostics() {
  const account = keyStore.pkHex;
  if (!account) {
    Object.assign(diagnostics, { syncStatus: "idle", lastCatchupCompletedAt: 0, pendingOutgoing: 0 });
    Object.assign(dmRelayStatus, { relays: [], eventId: undefined, publishedAt: undefined, pending: false, attempts: 0, lastError: undefined });
    return;
  }
  try {
    const [syncState, pending, ownDmRelays] = await Promise.all([
      syncedMessageRepository.getSyncState(account),
      outgoingQueueRepository.listRetryable(account, true),
      getOwnDmRelayStatus(account).catch(() => null),
    ]);
    if (keyStore.pkHex !== account) return;
    diagnostics.syncStatus = syncState.status || "idle";
    diagnostics.lastCatchupCompletedAt = syncState.lastCatchupCompletedAt || 0;
    diagnostics.pendingOutgoing = pending.length;
    if (ownDmRelays) Object.assign(dmRelayStatus, ownDmRelays);
  } catch {
    if (keyStore.pkHex === account) diagnostics.syncStatus = "error";
  }
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

function toggleReadReceipts(event: Event) {
  settings.setReadReceipts((event.target as HTMLInputElement).checked);
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
  void refreshDiagnostics();
  if (!statusInterval) statusInterval = setInterval(() => {
    refreshStatuses();
    void refreshDiagnostics();
  }, 5_000);
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

function scheduleDeferredRuntimeRefresh() {
  if (!viewActive || cancelDeferredRuntimeRefresh) return;
  cancelDeferredRuntimeRefresh = runWhenIdle(() => {
    cancelDeferredRuntimeRefresh = null;
    if (!viewActive || !keyStore.pkHex) return;
    startStatusPolling();
    scheduleCacheStatsRefresh();
    void refreshBiometricSupport();
    if (isNativeAndroid) void refreshAndroidVersion();
  }, 1_000);
}

async function refreshCacheStats(force = false) {
  const account = keyStore.pkHex;
  if (!account) {
    Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0, persistentCount: 0, persistentSize: 0, persistentOldestTimestamp: 0 });
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

async function refreshBiometricSupport() {
  biometricSupported.value = await keyStore.supportsBiometricUnlock();
}

async function reconnectRemoteSigner() {
  if (remoteSignerBusy.value || keyStore.loginMethod !== "nip46") return;
  remoteSignerBusy.value = true;
  try {
    await keyStore.reconnectRemoteSigner();
    ui.addToast("远程签名器已重新连接", 2_000, "success");
  } catch {
    ui.addToast("远程签名器连接失败，请稍后重试", 2_500, "error");
  } finally {
    remoteSignerBusy.value = false;
  }
}

async function toggleBiometricUnlock() {
  if (biometricBusy.value) return;
  biometricBusy.value = true;
  try {
    if (biometricEnabled.value) {
      await keyStore.disableBiometricUnlock();
      biometricRevision.value += 1;
      ui.addToast(`${biometricLabel.value}登录保护已关闭`, 2_000, "success");
    } else {
      await keyStore.enableBiometricUnlock();
      biometricRevision.value += 1;
      ui.addToast(`${biometricLabel.value}登录保护已开启`, 2_000, "success");
    }
  } catch (error) {
    const cancelled = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
    if (!cancelled) ui.addToast(error instanceof Error ? error.message : `${biometricLabel.value} 设置失败`, 2_500, "error");
  } finally {
    biometricBusy.value = false;
  }
}

async function goToAccountLogin(mode: "switch" | "add") {
  await keyStore.clearActiveSession();
  keyStore.refreshAccounts();
  await router.push({ path: "/login", query: { mode, redirect: "/settings/system" } });
}

function switchAccount() {
  void goToAccountLogin("switch");
}

function addAccount() {
  void goToAccountLogin("add");
}

async function doLogout() {
  await keyStore.logout();
  location.href = "/#/login";
}

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

async function refreshAndroidVersion() {
  if (!isNativeAndroid) return;
  try {
    const current = await getCurrentAndroidVersion();
    androidVersionName.value = current?.versionName || "";
  } catch {
    androidVersionName.value = "";
  }
}

async function checkForAndroidAppUpdate() {
  if (!isNativeAndroid || checkingAndroidUpdate.value) return;
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
  Object.assign(dmRelayStatus, { relays: [], eventId: undefined, publishedAt: undefined, pending: false, attempts: 0, lastError: undefined });
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
    Object.assign(diagnostics, { syncStatus: "idle", lastCatchupCompletedAt: 0, pendingOutgoing: 0 });
    return;
  }
  if (cacheStatsAccount !== pk) Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0 });
  backgroundLock.value = deviceStorage.getItem(autoLockKey(pk)) === "1";
  pushEnabled.value = pushEnabledForAccount(pk);
  if (settings.loadedFor !== pk) await settings.load(pk);
  if (keyStore.pkHex !== pk || settings.loadedFor !== pk) return;

  // Relay state is already in memory, so this is safe for first paint.
  refreshStatuses();
  scheduleDeferredRuntimeRefresh();
}, { immediate: true });

onMounted(() => {
  viewActive = true;
  scheduleDeferredRuntimeRefresh();
});
onActivated(() => {
  viewActive = true;
  scheduleDeferredRuntimeRefresh();
});
onDeactivated(() => {
  viewActive = false;
  stopStatusPolling();
  cancelDeferredRuntimeRefresh?.();
  cancelDeferredRuntimeRefresh = null;
  cancelScheduledCacheRefresh?.();
  cancelScheduledCacheRefresh = null;
});
onBeforeUnmount(() => {
  viewActive = false;
  stopStatusPolling();
  cancelDeferredRuntimeRefresh?.();
  cancelDeferredRuntimeRefresh = null;
  cancelScheduledCacheRefresh?.();
});
</script>

<style scoped>
.system-content{padding:0 16px}.account-section{margin-top:8px}
.privacy-copy{display:grid;min-width:0;flex:1;gap:4px}.privacy-copy strong{font-size:.9rem}.privacy-copy .small{line-height:1.45}
.privacy-toggle{position:relative;width:46px;height:28px;flex:0 0 46px;cursor:pointer}.privacy-toggle input{position:absolute;opacity:0;pointer-events:none}.privacy-toggle span{display:block;width:46px;height:28px;border-radius:999px;background:#cbd5e1;transition:background 150ms ease}.privacy-toggle span::after{content:"";display:block;width:22px;height:22px;margin:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.28);transition:transform 150ms ease}.privacy-toggle input:checked+span{background:#1687e8}.privacy-toggle input:checked+span::after{transform:translateX(18px)}.privacy-toggle input:focus-visible+span{outline:2px solid #2563eb;outline-offset:2px}

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
.account-heading-main{display:flex;min-width:0;align-items:center;gap:12px}
.identity-section{margin-top:18px;border-top:2px solid #e2e8f0}
.account-heading-icon{display:grid;width:24px;height:24px;flex:0 0 24px;place-items:center;color:#475569}
.account-heading-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.account-heading-main>div{min-width:0}
.account-heading-main p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.account-panel{padding:2px 0 18px 36px}
.account-control-card{overflow:hidden;border:1px solid #e5eaf0;border-radius:16px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.025)}
.account-setting-row{display:flex;min-height:72px;align-items:center;gap:14px;padding:14px 15px}
.account-inline-action{flex:0 0 auto;min-width:64px;height:36px;padding:0 13px;border:1px solid #d8e0e8;border-radius:10px;background:#f8fafc;color:#334155;font-size:.86rem;font-weight:600;cursor:pointer}
.account-inline-action:disabled{opacity:.55;cursor:default}
.account-actions-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 15px;border-top:1px solid #eef2f6}
.account-action-button{min-height:48px;border-radius:13px;font-size:.94rem;font-weight:600;cursor:pointer;transition:transform 120ms ease,background 120ms ease,border-color 120ms ease}
.account-action-button:active,.account-inline-action:active,.account-danger-button:active{transform:scale(.985)}
.account-action-secondary{border:1px solid #d7dee7;background:#f8fafc;color:#334155}
.account-action-primary{border:1px solid #475569;background:#475569;color:#fff}
.account-danger-row{padding:0 15px 14px}
.account-danger-button{width:100%;min-height:46px;border:1px solid #fecaca;border-radius:13px;background:#fff7f7;color:#dc2626;font-size:.93rem;font-weight:600;cursor:pointer}
@media(max-width:520px){.account-panel{padding-left:0}.account-actions-row{gap:8px}.account-action-button{min-height:46px}}
.diagnostics-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 14px}
.diagnostics-grid>span{display:grid;gap:3px;padding:10px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc}
.diagnostics-grid strong{color:#1e293b;font-size:.82rem}
.diagnostics-grid small{color:#64748b;font-size:.68rem}
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

.dm-relay-card { margin-bottom: 14px; }
.dm-relay-copy { margin: 10px 0 8px; color: #64748b; font-size: .75rem; line-height: 1.5; }
.dm-relay-list { display: grid; gap: 4px; color: #475569; font: .7rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }

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

.relay-last-seen{margin-top:8px;color:#64748b;font-size:.7rem}
.system-relay-lock{color:#64748b;font-size:.76rem;font-weight:600}
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

.version-footer {
  padding: 22px 16px 4px;
  color: #94a3b8;
  font-size: 0.68rem;
  line-height: 1.5;
  text-align: center;
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

  .diagnostics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .account-panel {
    padding-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .section-heading::after,
  .row-chevron { transition: none; }
}
</style>
