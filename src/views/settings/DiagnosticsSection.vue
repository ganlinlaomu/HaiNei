<template>
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
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { registerOutgoingPushSigner, retryFailedOutgoing } from "@/nostr/messaging/service";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import type { RelayRuntime } from "./useRelayRuntimeStatus";

const props = defineProps<{ runtime: RelayRuntime }>();
const {
  diagnostics, diagnosticsSummary, connectedRelayCount, enabledRelayCount, syncStatusLabel, lastCatchupLabel,
} = props.runtime;
const router = useRouter();
const keyStore = useKeyStore();
const ui = useUIStore();
const retryingQueue = ref(false);

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
</script>

<style scoped src="./systemSettingsSection.css"></style>
<style scoped>
.diagnostics-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 14px}
.diagnostics-grid>span{display:grid;gap:3px;padding:10px;border:1px solid var(--bd-e2e8f0);border-radius:10px;background:var(--bg-f8fafc)}
.diagnostics-grid strong{color:var(--fg-1e293b);font-size:.82rem}
.diagnostics-grid small{color:var(--fg-64748b);font-size:.68rem}
@media (max-width: 640px) {
  .diagnostics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
