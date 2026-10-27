import { computed, reactive } from "vue";
import { inspectRelays, onRelayConnectionState, type RelayRuntimeStatus } from "@/nostr/relays";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { getOwnDmRelayStatus } from "@/services/dmRelayDirectory";
import { useKeyStore } from "@/stores/keys";
import { useSettingsStore } from "@/stores/settings";
import { formatRelativeTimestamp } from "./settingsFormat";

function syncStatusText(status: string) {
  if (status === "idle") return "Idle";
  if (status === "connecting") return "连接中";
  if (status === "catching-up") return "补拉中";
  if (status === "live") return "Live";
  if (status === "offline") return "离线";
  if (status === "error") return "错误";
  return status;
}

/**
 * Live relay connection states and message-sync diagnostics, polled every
 * 5s while the settings page is visible. The Connection and Diagnostics
 * sections both read it, so the page owns one instance and passes it down.
 */
export function useRelayRuntimeStatus() {
  const keyStore = useKeyStore();
  const settings = useSettingsStore();
  const relayList = computed(() => settings.relayList);
  const statuses = reactive<Record<string, RelayRuntimeStatus | undefined>>({});
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
  const enabledRelayCount = computed(() => relayList.value.filter(relay => relay.enabled).length);
  const connectedRelayCount = computed(() => relayList.value.filter(relay => relay.enabled && statuses[relay.url]?.state === "connected").length);
  const dmRelayStatusLabel = computed(() =>
    dmRelayStatus.pending
      ? "稍后自动重试"
      : dmRelayStatus.publishedAt
        ? "已就绪"
        : "正在设置"
  );
  const dmRelayStatusTone = computed(() => ({
    healthy: !!dmRelayStatus.publishedAt && !dmRelayStatus.pending,
    pending: dmRelayStatus.pending || !dmRelayStatus.publishedAt,
    failed: !!dmRelayStatus.lastError && dmRelayStatus.pending,
  }));
  const syncStatusLabel = computed(() => syncStatusText(diagnostics.syncStatus));
  const lastCatchupLabel = computed(() => diagnostics.lastCatchupCompletedAt
    ? formatRelativeTimestamp(diagnostics.lastCatchupCompletedAt)
    : "—");
  const diagnosticsSummary = computed(() =>
    `Relay ${connectedRelayCount.value}/${enabledRelayCount.value} · ${syncStatusLabel.value} · 待发送 ${diagnostics.pendingOutgoing}`
  );
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let statusUnsubscribe: (() => void) | null = null;

  function resetDmRelayStatus() {
    Object.assign(dmRelayStatus, { relays: [], eventId: undefined, publishedAt: undefined, pending: false, attempts: 0, lastError: undefined });
  }
  /** Forget the previous account's runtime state (signed out: everything). */
  function resetRuntimeStatus(signedOut: boolean) {
    resetDmRelayStatus();
    if (!signedOut) return;
    for (const url of Object.keys(statuses)) delete statuses[url];
    Object.assign(diagnostics, { syncStatus: "idle", lastCatchupCompletedAt: 0, pendingOutgoing: 0 });
  }

  async function refreshDiagnostics() {
    const account = keyStore.pkHex;
    if (!account) {
      Object.assign(diagnostics, { syncStatus: "idle", lastCatchupCompletedAt: 0, pendingOutgoing: 0 });
      resetDmRelayStatus();
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

  function refreshStatuses() {
    const current = inspectRelays();
    const activeUrls = new Set(relayList.value.map(relay => relay.url));
    for (const url of Object.keys(statuses)) {
      if (!activeUrls.has(url)) delete statuses[url];
    }
    for (const relay of relayList.value) statuses[relay.url] = current[relay.url];
  }
  function forgetRelay(url: string) {
    delete statuses[url];
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

  return {
    statuses,
    diagnostics,
    enabledRelayCount,
    connectedRelayCount,
    dmRelayStatusLabel,
    dmRelayStatusTone,
    syncStatusLabel,
    lastCatchupLabel,
    diagnosticsSummary,
    refreshStatuses,
    forgetRelay,
    startStatusPolling,
    stopStatusPolling,
    resetRuntimeStatus,
  };
}

export type RelayRuntime = ReturnType<typeof useRelayRuntimeStatus>;
