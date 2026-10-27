<template>
  <details class="technical-section" open>
    <summary class="section-heading">
      <div class="section-heading-main">
        <span class="section-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>
        </span>
        <div>
          <h3>连接</h3>
          <p>{{ relayList.filter(relay => relay.enabled).length }} 个服务器已启用</p>
        </div>
      </div>
    </summary>
    <p class="section-detail">海内自带的服务器始终开启，保证你和好友之间至少有一条共同的通道；也可以添加自己的服务器作为备用。</p>

    <article class="item-card dm-relay-card">
      <div class="item-header">
        <div class="item-main">
          <div class="item-url">收信地址</div>
          <div class="meta-row">
            <span class="pill" :class="dmRelayStatusTone">{{ dmRelayStatusLabel }}</span>
          </div>
        </div>
      </div>
      <p class="dm-relay-copy">好友会把私信送到这里，系统自动选择，一般不需要修改。</p>
      <button class="text-button" type="button" @click="router.push('/debug')">查看技术详情</button>
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
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { reconnectRelay } from "@/nostr/relays";
import { DEFAULT_RELAY_URLS, type RelayConfig, type RelaySource } from "@/services/connectionSettings";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { formatTimestamp } from "./settingsFormat";
import type { RelayRuntime } from "./useRelayRuntimeStatus";

const props = defineProps<{ runtime: RelayRuntime }>();
const { statuses, dmRelayStatusLabel, dmRelayStatusTone, refreshStatuses, forgetRelay } = props.runtime;
const router = useRouter();
const settings = useSettingsStore();
const ui = useUIStore();
const relayList = computed(() => settings.relayList);
const newRelay = ref("");

function relaySourceLabel(source: RelaySource) {
  return source === "user" ? "自己添加" : source === "nip65" ? "公开列表" : "默认";
}
function isBuiltinRelay(relay: RelayConfig) {
  return relay.source === "default" || (DEFAULT_RELAY_URLS as readonly string[]).includes(relay.url);
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
  forgetRelay(relay.url);
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
</script>

<style scoped src="./systemSettingsSection.css"></style>
<style scoped>
.dm-relay-card { margin-bottom: 14px; }
.dm-relay-copy { margin: 10px 0 8px; color: var(--fg-64748b); font-size: .75rem; line-height: 1.5; }
.dm-relay-list { display: grid; gap: 4px; color: var(--fg-475569); font: .7rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.relay-last-seen{margin-top:8px;color:var(--fg-64748b);font-size:.7rem}
.system-relay-lock{color:var(--fg-64748b);font-size:.76rem;font-weight:600}
</style>
