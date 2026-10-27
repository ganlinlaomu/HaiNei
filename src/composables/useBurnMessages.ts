import { computed, ref } from "vue";
import { disappearingMetadata, hasDisappearingMarker, isExpiredDisappearing } from "@/nostr/messaging/disappearingMessages";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import type { useDirectMessagesStore } from "@/stores/directMessages";
import type { InboxItem } from "@/stores/messages";

type DirectMessagesStore = ReturnType<typeof useDirectMessagesStore>;
type Notify = (message: string, durationMs: number, kind: "info" | "error") => void;

/**
 * Burn-after-reading state for one open conversation: which temporary
 * messages were opened and until when, the countdown clock, and burning
 * rows whose deadline or 48h expiry passed. Durable state lives in the
 * repository and the direct-messages store; this is the chat's view of it.
 */
export function useBurnMessages(options: {
  account: () => string;
  peer: () => string;
  accepted: () => boolean;
  messages: () => InboxItem[];
  isOwn: (message: InboxItem) => boolean;
  isDisposed: () => boolean;
  directMessages: DirectMessagesStore;
  notify: Notify;
}) {
  const { directMessages } = options;
  const openedDeadlines = ref<Record<string, number>>({});
  const clockNow = ref(Date.now());
  const openingMessageId = ref("");
  let burnTimer: ReturnType<typeof setInterval> | null = null;
  let burnTimerPeriod = 0;
  const burningMessageIds = new Set<string>();

  function isDisappearing(message: InboxItem) {
    return hasDisappearingMarker(message.tags) || directMessages.burnedById[message.id]?.peerPubkey === options.peer();
  }
  // Re-evaluated when messages or receipts change; the 2-minute grace uses wall time.
  const readReceiptsHiddenReason = computed(() =>
    directMessages.readReceiptsHiddenReason(options.peer(), options.messages(), Math.max(clockNow.value, Date.now())));
  /** Without an open confirmation the sender's copy lives until the 48h expiry. */
  function burnFallbackNotice(message: InboxItem) {
    if (!options.isOwn(message) || isBurned(message) || message.outgoing) return "";
    if (directMessages.outgoingReceiptStatus(options.peer(), message) === "read") return "";
    if (readReceiptsHiddenReason.value === "peer") return "对方关闭了已读回执，消息将在 48 小时后销毁";
    if (readReceiptsHiddenReason.value === "self") return "你关闭了已读回执，看不到对方是否已查看；消息将在 48 小时后销毁";
    return "";
  }
  function burnDuration(message: InboxItem) {
    return disappearingMetadata(message.tags)?.burnAfterSeconds || 10;
  }
  function remainingBurnSeconds(message: InboxItem) {
    const deadline = openedDeadlines.value[message.id] || 0;
    return Math.max(0, Math.ceil((deadline - clockNow.value) / 1000));
  }
  function isBurned(message: InboxItem) {
    return !!directMessages.burnedById[message.id]
      || isExpiredDisappearing(message.tags, Math.floor(clockNow.value / 1000))
      || (openedDeadlines.value[message.id] !== undefined && remainingBurnSeconds(message) === 0);
  }
  function canShowTemporaryText(message: InboxItem) {
    return !options.isOwn(message) && !isBurned(message)
      && openedDeadlines.value[message.id] !== undefined && remainingBurnSeconds(message) > 0;
  }
  async function revealDisappearing(message: InboxItem) {
    if (openingMessageId.value || options.isOwn(message) || isBurned(message) || !options.accepted()
      || !/^[0-9a-f]{64}$/i.test(message.id)) return;
    const account = options.account();
    const peer = options.peer();
    openingMessageId.value = message.id;
    try {
      const deadline = await syncedMessageRepository.openDisappearingMessage(account, message.id, peer);
      if (options.isDisposed() || account !== options.account() || peer !== options.peer()) return;
      clockNow.value = Date.now();
      if (deadline === null) {
        options.notify("临时消息已不可查看", 1800, "info");
        void checkBurnDeadlines();
        return;
      }
      openedDeadlines.value = { ...openedDeadlines.value, [message.id]: deadline };
      // Actual reveal, not opening the chat or advancing a read cursor, is the
      // only event that emits a per-message encrypted read confirmation.
      void directMessages.acknowledgeOpenedDisappearing(peer, message, deadline);
      // Global one-shot timer survives closing or navigating away from this chat.
      directMessages.scheduleOpenedBurn(peer, message.id, deadline);
      if (deadline <= Date.now()) void checkBurnDeadlines();
      else startBurnClock();
    } catch {
      if (!options.isDisposed() && account === options.account()) options.notify("临时消息打开失败，请重试", 2100, "error");
    } finally {
      if (openingMessageId.value === message.id) openingMessageId.value = "";
    }
  }
  function stopBurnClock() {
    if (burnTimer !== null) clearInterval(burnTimer);
    burnTimer = null;
    burnTimerPeriod = 0;
  }
  function startBurnClock() {
    if (typeof document !== "undefined" && document.hidden) return;
    // Unopened DM history requires no high-frequency polling. A live reading
    // countdown needs only second precision; background execution is suspended.
    const active = Object.values(openedDeadlines.value).some(deadline => deadline > Date.now());
    const period = active ? 1000 : 60_000;
    if (burnTimer !== null && burnTimerPeriod === period) return;
    stopBurnClock();
    clockNow.value = Date.now();
    burnTimerPeriod = period;
    burnTimer = setInterval(() => {
      const now = Date.now();
      // The whole chat renders from clockNow. While a countdown runs, the label
      // ticks inside DmBurnCountdown; advance clockNow only when a deadline is
      // crossed, so the expired message hides without re-rendering every second.
      if (period !== 1000 || Object.values(openedDeadlines.value).some(deadline => deadline > clockNow.value && deadline <= now)) {
        clockNow.value = now;
      }
      void checkBurnDeadlines();
    }, period);
  }
  async function checkBurnDeadlines() {
    if (options.isDisposed() || !options.account() || !options.accepted()) return;
    const account = options.account();
    const peer = options.peer();
    const now = Date.now();
    for (const message of options.messages()) {
      if (!isDisappearing(message) || directMessages.burnedById[message.id]
        || !/^[0-9a-f]{64}$/i.test(message.id) || burningMessageIds.has(message.id)) continue;
      const deadline = openedDeadlines.value[message.id];
      if (deadline === undefined && !isExpiredDisappearing(message.tags, Math.floor(now / 1000))) continue;
      if (deadline !== undefined && deadline > now && !isExpiredDisappearing(message.tags, Math.floor(now / 1000))) continue;
      burningMessageIds.add(message.id);
      try {
        if (await directMessages.burnDisappearingMessage(peer, message.id)
          && account === options.account() && peer === options.peer()) {
          const next = { ...openedDeadlines.value };
          delete next[message.id];
          openedDeadlines.value = next;
          startBurnClock();
        }
      } catch {
        // Retry on the next visible tick; never reveal expired plaintext again.
      } finally {
        burningMessageIds.delete(message.id);
      }
    }
  }
  /** Restores this conversation's opened messages after a load, then burns any that are due. */
  function restoreOpenedDeadlines(rows: Array<{ messageId: string; deadlineAt: number }>) {
    openedDeadlines.value = Object.fromEntries(rows.map(row => [row.messageId, row.deadlineAt]));
    for (const row of rows) directMessages.scheduleOpenedBurn(options.peer(), row.messageId, row.deadlineAt);
    startBurnClock();
    clockNow.value = Date.now();
    void checkBurnDeadlines();
  }
  /** Visibility change: pause the clock while hidden, catch up when shown. */
  function syncBurnClockWithVisibility() {
    clockNow.value = Date.now();
    if (typeof document !== "undefined" && document.hidden) {
      stopBurnClock();
      return false;
    }
    startBurnClock();
    void checkBurnDeadlines();
    return true;
  }

  return {
    openedDeadlines,
    clockNow,
    openingMessageId,
    readReceiptsHiddenReason,
    isDisappearing,
    burnFallbackNotice,
    burnDuration,
    remainingBurnSeconds,
    isBurned,
    canShowTemporaryText,
    revealDisappearing,
    startBurnClock,
    stopBurnClock,
    checkBurnDeadlines,
    restoreOpenedDeadlines,
    syncBurnClockWithVisibility,
  };
}
