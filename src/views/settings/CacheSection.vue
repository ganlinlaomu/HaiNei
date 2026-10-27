<template>
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
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { isAccountResourceStale, runAfterFirstPaint } from "@/utils/bottomTabActivation";
import {
  clearAllCache,
  getCacheStats,
  IMAGE_MEMORY_CACHE_MAX_BYTES,
  IMAGE_PERSISTENT_CACHE_MAX_BYTES,
} from "@/utils/imageCache";
import { useDeferredSettingsRefresh } from "./useDeferredSettingsRefresh";

const keyStore = useKeyStore();
const ui = useUIStore();
const cacheStats = reactive({ count: 0, size: 0, oldestTimestamp: 0, persistentCount: 0, persistentSize: 0, persistentOldestTimestamp: 0 });
const loadingCache = ref(false);
const clearingCache = ref(false);
let cacheRequestId = 0;
let cacheStatsAccount = "";
let cacheStatsUpdatedAt = 0;
let cacheRefresh: { account: string; promise: Promise<void> } | null = null;
let cancelScheduledCacheRefresh: (() => void) | null = null;
const CACHE_STATS_MAX_AGE_MS = 5 * 60_000;

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
function cancelScheduledRefresh() {
  cancelScheduledCacheRefresh?.();
  cancelScheduledCacheRefresh = null;
}

useDeferredSettingsRefresh({
  refresh: () => scheduleCacheStatsRefresh(),
  reset: account => {
    cacheRequestId += 1;
    cacheRefresh = null;
    cancelScheduledRefresh();
    loadingCache.value = false;
    if (!account) {
      Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0 });
      cacheStatsAccount = "";
      cacheStatsUpdatedAt = 0;
    } else if (cacheStatsAccount !== account) Object.assign(cacheStats, { count: 0, size: 0, oldestTimestamp: 0 });
  },
  onHide: cancelScheduledRefresh,
});

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
</script>

<style scoped src="./systemSettingsSection.css"></style>
<style scoped>
.cache-info {
  display: grid;
  gap: 12px;
  padding-bottom: 16px;
}
</style>
