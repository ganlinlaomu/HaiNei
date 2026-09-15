<template>
  <main class="debug-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">开发 / 诊断</p>
        <h2>系统诊断 / Debug Console</h2>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" @click="refreshRelayStatus">刷新状态</button>
        <button class="btn btn-secondary" @click="exportLogs">导出日志</button>
        <button class="btn btn-danger" @click="logs.clear()">清空日志</button>
      </div>
    </header>

    <section class="meta-grid card-panel">
      <div><span>当前账号</span><strong>{{ accountPrefix || "未登录" }}</strong></div>
      <div><span>登录方式</span><strong>{{ keys.loginMethod || "—" }}</strong></div>
      <div><span>当前时间</span><strong>{{ currentTime }}</strong></div>
      <div><span>App / DB</span><strong>{{ APP_VERSION }} / v{{ DB_VERSION }}</strong></div>
    </section>

    <section class="summary-grid">
      <article class="summary-card"><span>Relay Connected</span><strong>{{ summary.connected }}/{{ summary.relays }}</strong></article>
      <article class="summary-card"><span>Publish</span><small>success {{ summary.publishOk }} · failed {{ summary.publishFailed }} · timeout {{ summary.publishTimeout }}</small></article>
      <article class="summary-card"><span>NIP-17</span><small>received {{ summary.nipReceived }} · decoded {{ summary.nipDecoded }} · failed {{ summary.nipFailed }}</small></article>
      <article class="summary-card"><span>Storage</span><small>inserted {{ summary.inserted }} · duplicates {{ summary.duplicates }}</small></article>
    </section>

    <section class="card-panel">
      <div class="section-title"><h3>Relay 状态</h3><span>{{ Object.keys(relayStatus).length }} 个连接</span></div>
      <div v-if="Object.keys(relayStatus).length" class="relay-list">
        <div v-for="(status, relay) in relayStatus" :key="relay" class="relay-row">
          <div class="relay-name"><i :class="status.ready ? 'ready' : 'offline'"></i>{{ relay }}</div>
          <div class="relay-metrics">
            <span>ready {{ status.ready }}</span><span>queue {{ status.queueLength }}</span><span>subs {{ status.subs }}</span>
            <span>OK {{ status.okHandlers }}</span><span>retry {{ status.reconnectAttempts }}</span>
          </div>
          <button class="compact-button" @click="reconnect(String(relay))">重新连接</button>
        </div>
      </div>
      <p v-else class="empty">尚未建立 relay 连接。</p>
    </section>

    <section v-if="lastSend" class="card-panel">
      <div class="section-title"><h3>最近一次发送</h3><span>{{ formatTime(lastSend.ts) }}</span></div>
      <div class="send-meta">
        <span>Logical message ID <code>{{ lastSend.logicalMessageId }}</code></span>
        <span>Recipients {{ lastSend.recipients }}</span>
        <span>Gift wraps {{ lastSend.giftWraps }}</span>
      </div>
      <div v-for="copy in lastSend.copies" :key="copy.eventId" class="copy-block">
        <strong>{{ copy.role === "sender" ? "Sender copy" : copy.target }}</strong>
        <code>{{ copy.eventId }}</code>
        <div v-if="copy.relays.length" class="copy-results">
          <span v-for="result in copy.relays" :key="`${copy.eventId}-${result.relay}`">
            {{ result.relay }} {{ result.status === "ok" ? "✅" : "❌" }}<em v-if="result.reason"> {{ result.reason }}</em>
          </span>
        </div>
        <span v-else class="empty">尚无 relay 结果</span>
      </div>
    </section>

    <section class="card-panel logs-panel">
      <div class="section-title"><h3>实时日志</h3><span>{{ filteredLogs.length }} / {{ logs.entries.length }}</span></div>
      <div class="filters">
        <select v-model="categoryFilter" aria-label="日志分类">
          <option value="all">All</option><option value="relay">Relay</option><option value="publish">Publish</option>
          <option value="subscription">Subscription</option><option value="nip17">NIP17</option><option value="sync">Sync</option>
          <option value="storage">Storage</option><option value="ui">UI</option><option value="account">Account</option>
        </select>
        <select v-model="levelFilter" aria-label="日志级别">
          <option value="all">All levels</option><option value="debug">Debug</option><option value="info">Info</option>
          <option value="warn">Warn</option><option value="error">Error</option>
        </select>
        <input v-model.trim="search" type="search" placeholder="搜索 relay、event id、公钥或事件名" aria-label="搜索日志" />
      </div>
      <div class="log-list">
        <article v-for="entry in filteredLogs" :key="entry.id" class="log-row" :class="`level-${entry.level}`">
          <time>{{ formatTime(entry.ts) }}</time><span class="category">[{{ entry.category }}]</span><strong>{{ entry.event }}</strong>
          <pre v-if="entry.data">{{ formatData(entry.data) }}</pre>
        </article>
        <p v-if="!filteredLogs.length" class="empty">没有符合当前过滤条件的日志。</p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { APP_VERSION, DB_VERSION } from "@/db/dexie";
import { inspectRelays, reconnectRelay } from "@/nostr/relays";
import { useDebugLogsStore, type DebugLogCategory, type DebugLogEntry, type DebugLogLevel } from "@/stores/debugLogs";
import { useKeyStore } from "@/stores/keys";

type RelayStatus = { ready: boolean; queueLength: number; subs: number; okHandlers: number; reconnectAttempts: number };
type LastSend = { ts: number; logicalMessageId: string; recipients: number; giftWraps: number; copies: Array<{ eventId: string; target: string; role: string; relays: Array<{ relay: string; status: string; reason?: string }> }> };

const logs = useDebugLogsStore();
const keys = useKeyStore();
const relayStatus = ref<Record<string, RelayStatus>>({});
const now = ref(Date.now());
const categoryFilter = ref<DebugLogCategory | "all">("all");
const levelFilter = ref<DebugLogLevel | "all">("all");
const search = ref("");
let timer: ReturnType<typeof setInterval> | undefined;

const accountPrefix = computed(() => keys.pkHex.slice(0, 12));
const currentTime = computed(() => new Date(now.value).toLocaleString());

function refreshRelayStatus() { relayStatus.value = inspectRelays(); }
function reconnect(relay: string) { reconnectRelay(relay); window.setTimeout(refreshRelayStatus, 500); }
function formatTime(ts: number) { return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }); }
function formatData(data: Record<string, unknown>) { return Object.entries(data).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("  "); }

const filteredLogs = computed(() => {
  const query = search.value.toLowerCase();
  return logs.entries.slice().reverse().filter((entry) => {
    if (categoryFilter.value !== "all" && entry.category !== categoryFilter.value) return false;
    if (levelFilter.value !== "all" && entry.level !== levelFilter.value) return false;
    return !query || `${entry.event} ${entry.category} ${JSON.stringify(entry.data || {})}`.toLowerCase().includes(query);
  });
});

function count(event: string, category?: DebugLogCategory) {
  return logs.entries.filter((entry) => entry.event === event && (!category || entry.category === category)).length;
}
const summary = computed(() => ({
  connected: Object.values(relayStatus.value).filter((status) => status.ready).length,
  relays: Object.keys(relayStatus.value).length,
  publishOk: count("publish_ok", "publish"), publishFailed: count("publish_rejected", "publish"), publishTimeout: count("publish_timeout", "publish"),
  nipReceived: count("wrap_received", "nip17"), nipDecoded: count("decode_success", "nip17"), nipFailed: count("decode_failed", "nip17"),
  inserted: count("storage_inserted", "storage"), duplicates: count("storage_duplicate", "storage")
}));

const lastSend = computed<LastSend | null>(() => {
  const startIndex = logs.entries.findLastIndex((entry) => entry.event === "message_publish_start");
  if (startIndex < 0) return null;
  const start = logs.entries[startIndex];
  const data = start.data || {};
  const rawCopies = Array.isArray(data.copies) ? data.copies : [];
  return {
    ts: start.ts,
    logicalMessageId: String(data.logicalMessageId || "unknown"),
    recipients: Number(data.recipients || 0),
    giftWraps: Number(data.giftWraps || rawCopies.length),
    copies: rawCopies.map((raw) => {
      const copy = raw as Record<string, unknown>;
      const eventId = String(copy.eventId || "unknown");
      const results = logs.entries.slice(startIndex + 1).filter((entry) =>
        ["publish_ok", "publish_rejected", "publish_timeout"].includes(entry.event) && entry.data?.eventId === eventId
      );
      return {
        eventId, target: String(copy.target || "unknown"), role: String(copy.role || "recipient"),
        relays: results.map((entry: DebugLogEntry) => ({
          relay: String(entry.data?.relay || "unknown"), status: entry.event === "publish_ok" ? "ok" : "failed",
          ...(entry.data?.reason ? { reason: String(entry.data.reason) } : {})
        }))
      };
    })
  };
});

function exportLogs() {
  refreshRelayStatus();
  const payload = { appVersion: APP_VERSION, dbVersion: DB_VERSION, account: accountPrefix.value, relayStatus: relayStatus.value, logs: logs.entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `hainei-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; anchor.click();
  URL.revokeObjectURL(url);
}

onMounted(() => { refreshRelayStatus(); timer = window.setInterval(() => { now.value = Date.now(); refreshRelayStatus(); }, 2000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.debug-page{display:grid;gap:16px;padding:16px 16px calc(var(--bottom-nav-height) + 24px);max-width:1180px;margin:auto;color:#172033}.page-header,.section-title,.header-actions,.filters,.relay-row,.relay-metrics,.send-meta{display:flex;align-items:center}.page-header,.section-title{justify-content:space-between;gap:12px}.page-header h2,.section-title h3{margin:0}.eyebrow{margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.header-actions,.filters,.relay-metrics,.send-meta{gap:8px;flex-wrap:wrap}.card-panel,.summary-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px}.meta-grid,.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.meta-grid div,.summary-card{display:flex;flex-direction:column;gap:5px}.meta-grid span,.summary-card span,.section-title span,.empty{font-size:12px;color:#64748b}.summary-card strong{font-size:24px}.summary-card small{line-height:1.5}.relay-list{display:grid;margin-top:12px}.relay-row{display:grid;grid-template-columns:minmax(240px,1fr) 1fr auto;gap:12px;padding:12px 0;border-top:1px solid #eef2f7}.relay-name{overflow-wrap:anywhere}.relay-name i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px}.ready{background:#22c55e}.offline{background:#ef4444}.relay-metrics span,.send-meta span{font-size:12px;color:#475569;background:#f8fafc;padding:4px 7px;border-radius:6px}.compact-button{border:1px solid #cbd5e1;border-radius:7px;background:#fff;padding:6px 10px;cursor:pointer}.copy-block{display:grid;grid-template-columns:120px 110px 1fr;gap:10px;padding:11px 0;border-top:1px solid #eef2f7}.copy-results{display:flex;flex-direction:column;font-size:12px}.copy-results em{color:#64748b}.filters{margin:12px 0}.filters select,.filters input{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;background:#fff}.filters input{flex:1;min-width:220px}.log-list{max-height:620px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;background:#0f172a}.log-row{display:grid;grid-template-columns:105px 110px minmax(180px,auto) 1fr;gap:8px;padding:8px 10px;border-bottom:1px solid #25324a;color:#e2e8f0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.log-row time{color:#94a3b8}.log-row .category{color:#60a5fa}.log-row pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#cbd5e1}.level-warn{border-left:3px solid #f59e0b}.level-error{border-left:3px solid #ef4444}.log-list .empty{padding:20px}.btn{cursor:pointer}@media(max-width:760px){.page-header{align-items:flex-start;flex-direction:column}.meta-grid,.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.relay-row{grid-template-columns:1fr}.copy-block,.log-row{grid-template-columns:1fr}.log-row{gap:2px}.log-row pre{margin-top:4px}}
</style>
