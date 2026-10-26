import type { NostrEvent } from "nostr-tools";
import type { IncrementalCatchupCheckpoint, MessageSyncStateRecord, RelaySyncStateRecord } from "@/db/dexie";
import { getRelaysFromStorage, inspectRelays, onRelayConnectionState, restoreRelayConnections, type RelayConnectionEvent } from "@/nostr/relays";
import { nostrClient } from "@/services/nostrClient";
import { buildMessageSubscriptions } from "@/nostr/messaging/subscriptions";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { closeSubscription } from "@/utils/subscriptions";
import { logger } from "@/utils/logger";
import { debugLog, startupMark } from "@/utils/debugLog";
import { fetchCatchupPage, runPagedCatchup, type SubscribeForCatchup } from "./catchup";
import { negentropyMissingIds } from "./negentropy";
import { MessageIngestionPipeline, type DecodeMessage } from "./ingestion";
import { calculateCatchupSince } from "./sorting";
import { retryOutgoingQueue } from "@/nostr/messaging/service";
import { onAppResume } from "@/services/appResumeCoordinator";
import { scheduleBackgroundTask } from "@/services/backgroundWorkScheduler";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import { acknowledgeEncryptedPushInbox, isVerifiedPushGiftWrap, readEncryptedPushInbox, safePushRelays, type EncryptedPushInboxEntry } from "@/services/encryptedPushInbox";
import {
  CATCHUP_PAGE_LIMIT,
  INITIAL_HISTORY_MAX_BATCHES,
  RECEIVED_CURSOR_MARGIN_SECONDS,
  RESUME_MAX_BATCHES,
  type MessageSource,
  type MessageSyncOptions,
  type SubscriptionLike,
  type SyncStatus
} from "./types";

type ManagerDependencies = {
  repository?: SyncedMessageRepository;
  subscribe?: SubscribeForCatchup;
  observeRelays?: (listener: (event: RelayConnectionEvent) => void) => () => void;
  decode?: DecodeMessage;
  now?: () => number;
  resumeRelays?: (relays: string[]) => void;
  activeReadRelays?: () => string[];
  retryOutgoing?: (accountPubkey: string) => Promise<unknown> | void;
  catchupTimeoutMs?: number;
  reconcile?: typeof negentropyMissingIds;
};

function validatedCheckpoint(
  saved: IncrementalCatchupCheckpoint | undefined,
  signature: string,
  configured: string[]
): IncrementalCatchupCheckpoint | null {
  if (!saved || saved.relaySignature !== signature
    || !Number.isSafeInteger(saved.since) || saved.since < 0
    || !Number.isSafeInteger(saved.until) || saved.until < saved.since
    || !Array.isArray(saved.requiredRelays) || !saved.requiredRelays.length
    || !Array.isArray(saved.completedRelays)
    || !saved.pendingUntilByRelay || typeof saved.pendingUntilByRelay !== "object") return null;
  const required = new Set(saved.requiredRelays);
  if (required.size !== saved.requiredRelays.length
    || [...required].some(url => !configured.includes(url))
    || saved.completedRelays.some(url => !required.has(url))
    || Object.entries(saved.pendingUntilByRelay).some(([url, until]) =>
      !required.has(url) || !Number.isSafeInteger(until) || until < 0 || until > saved.until
    )
  ) return null;
  return saved;
}

// Seen wraps older than this are never inside a NIP-77 catch-up window.
const SEEN_WRAP_WINDOW_SECONDS = 10 * 24 * 60 * 60;
const RELAY_EVENT_FLUSH_MS = 5_000;

export const RELAY_CATCHUP_RETRY_BASE_MS = 1_000;
export const RELAY_CATCHUP_RETRY_MAX_MS = 60_000;

/** 1s, 2s, 4s, … capped at 60s for the n-th consecutive failure of one Relay. */
export function relayCatchupRetryDelayMs(attempt: number) {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  return Math.min(RELAY_CATCHUP_RETRY_MAX_MS, RELAY_CATCHUP_RETRY_BASE_MS * 2 ** exponent);
}

/** Error kind, message and the first stack frames, without message content. */
function describeError(error: unknown) {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name || "Error",
    message: String(value.message || "").slice(0, 160),
    stack: String(value.stack || "").split("\n").slice(1, 4).map(line => line.trim().slice(0, 120)).join(" | "),
  };
}

export class MessageSyncManager {
  private readonly repository: SyncedMessageRepository;
  private readonly subscribeFn: SubscribeForCatchup;
  private readonly observeRelays: (listener: (event: RelayConnectionEvent) => void) => () => void;
  private readonly decode?: DecodeMessage;
  private readonly now: () => number;
  private readonly resumeRelays: (relays: string[]) => void;
  private readonly activeReadRelays: () => string[];
  private readonly retryOutgoing: (accountPubkey: string) => Promise<unknown> | void;
  private readonly catchupTimeoutMs?: number;
  private readonly reconcile: typeof negentropyMissingIds;
  private options: MessageSyncOptions | null = null;
  private realtimeSubscription: SubscriptionLike | null = null;
  private removeRelayObserver: (() => void) | null = null;
  private pipeline: MessageIngestionPipeline | null = null;
  private sessionId = "";
  private catchupRunning = false;
  private catchupSessionId = "";
  private catchupPending: MessageSource | null = null;
  private removeForegroundResume: (() => void) | null = null;
  private connectedRelays = new Set<string>();
  private activeCatchupSubscriptions = new Set<SubscriptionLike>();
  // Processed gift wraps, written in batches for NIP-77 reconciliation.
  private seenWraps: Array<{ account: string; id: string; createdAt: number }> = [];
  private seenWrapsTimer: ReturnType<typeof setTimeout> | null = null;
  private seenWrapsPrunedFor = "";
  private pushInboxFlight: Promise<void> | null = null;
  private removePushInboxListener: (() => void) | null = null;
  private abortController: AbortController | null = null;
  private catchupAbortController: AbortController | null = null;
  private removeBackgroundListener: (() => void) | null = null;
   private idleContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelIdleContinuation: (() => void) | null = null;
  private relayRetryAttempts = new Map<string, number>();
  private relayRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Realtime relay diagnostics are batched: a (re)subscription replays the
  // 48h NIP-17 window, and one write transaction per event contends with the
  // message inserts that share the messageSyncStates store.
  private relayEventHighs = new Map<string, number>();
  private pendingRelayEventWrites = new Map<string, { account: string; createdAt: number }>();
  private relayEventFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private noteRealtimeEvent(account: string, relayUrl: string, createdAt: number) {
    const key = `${account}\n${relayUrl}`;
    if (!Number.isFinite(createdAt) || createdAt <= (this.relayEventHighs.get(key) ?? -Infinity)) return;
    this.relayEventHighs.set(key, createdAt);
    this.pendingRelayEventWrites.set(key, { account, createdAt });
    if (this.relayEventFlushTimer === null) {
      this.relayEventFlushTimer = setTimeout(() => this.flushRealtimeEventWrites(), RELAY_EVENT_FLUSH_MS);
      (this.relayEventFlushTimer as any).unref?.();
    }
  }

  private flushRealtimeEventWrites() {
    if (this.relayEventFlushTimer !== null) clearTimeout(this.relayEventFlushTimer);
    this.relayEventFlushTimer = null;
    const pending = [...this.pendingRelayEventWrites.entries()];
    this.pendingRelayEventWrites.clear();
    for (const [key, { account, createdAt }] of pending) {
      const relayUrl = key.slice(account.length + 1);
      void this.repository.updateRelayState(account, relayUrl, { lastEventCreatedAt: createdAt })
        .catch(() => undefined);
    }
  }

  private clearIdleContinuation() {
    if (this.idleContinuationTimer !== null) clearTimeout(this.idleContinuationTimer);
    this.idleContinuationTimer = null;
    this.cancelIdleContinuation?.();
    this.cancelIdleContinuation = null;
  }

  private scheduleIdleContinuation(sessionId: string, accountPubkey: string) {
    this.clearIdleContinuation();
    if (!this.isCurrent(sessionId, accountPubkey) || !this.isForeground()) return;
    // Never chain pages immediately on wake. Only one small follow-up pass
    // runs after a cooldown and the shared scheduler sees foreground idle time.
    this.idleContinuationTimer = setTimeout(() => {
      this.idleContinuationTimer = null;
      if (!this.isCurrent(sessionId, accountPubkey) || !this.isForeground()) return;
      this.cancelIdleContinuation = scheduleBackgroundTask(`dm-history:${sessionId}`, () => {
        this.cancelIdleContinuation = null;
        if (this.isCurrent(sessionId, accountPubkey) && this.isForeground()) {
          void this.resume("resume");
        }
      }, { priority: "idle", timeoutMs: 60_000 });
    }, 30_000);
    (this.idleContinuationTimer as any).unref?.();
  }

  private clearRelayRetries() {
    for (const timer of this.relayRetryTimers.values()) clearTimeout(timer);
    this.relayRetryTimers.clear();
    this.relayRetryAttempts.clear();
  }

  /**
   * A failed Relay page used to wait for the next app resume or reconnect.
   * Retry just that Relay with exponential backoff; success resets it.
   */
  private scheduleRelayRetries(
    sessionId: string,
    accountPubkey: string,
    result: { failedRelays: Map<string, unknown>; relayProgress: Record<string, { incomplete: boolean; paginationStalled?: boolean }> },
  ) {
    for (const [url, progress] of Object.entries(result.relayProgress)) {
      if (progress.incomplete || result.failedRelays.has(url)) continue;
      this.relayRetryAttempts.delete(url);
      const timer = this.relayRetryTimers.get(url);
      if (timer) clearTimeout(timer);
      this.relayRetryTimers.delete(url);
    }
    for (const url of result.failedRelays.keys()) {
      // A bucket larger than the page cap will not succeed by retrying.
      if (result.relayProgress[url]?.paginationStalled || this.relayRetryTimers.has(url)) continue;
      const attempt = (this.relayRetryAttempts.get(url) || 0) + 1;
      this.relayRetryAttempts.set(url, attempt);
      const delay = relayCatchupRetryDelayMs(attempt);
      debugLog("sync", "relay_catchup_retry_scheduled", { relay: url, attempt, delayMs: delay }, "info");
      const timer = setTimeout(() => {
        this.relayRetryTimers.delete(url);
        if (!this.isCurrent(sessionId, accountPubkey) || !this.isForeground()) return;
        void this.resume("reconnect", url);
      }, delay);
      (timer as any).unref?.();
      this.relayRetryTimers.set(url, timer);
    }
  }

  private isForeground() {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  constructor(dependencies: ManagerDependencies = {}) {
    this.repository = dependencies.repository || syncedMessageRepository;
    this.subscribeFn = dependencies.subscribe || ((relays, filters) => nostrClient.subscribe(relays, filters));
    this.observeRelays = dependencies.observeRelays || onRelayConnectionState;
    this.decode = dependencies.decode;
    this.now = dependencies.now || Date.now;
    this.resumeRelays = dependencies.resumeRelays || restoreRelayConnections;
    this.activeReadRelays = dependencies.activeReadRelays || (() => getRelaysFromStorage("read"));
    this.retryOutgoing = dependencies.retryOutgoing || retryOutgoingQueue;
    this.catchupTimeoutMs = dependencies.catchupTimeoutMs;
    this.reconcile = dependencies.reconcile ?? negentropyMissingIds;
  }

  private isCurrent(sessionId: string, accountPubkey: string) {
    return !!sessionId && this.sessionId === sessionId && this.options?.accountPubkey === accountPubkey;
  }

  private async setStatus(status: SyncStatus, sessionId = this.sessionId) {
    const options = this.options;
    if (!options || !this.isCurrent(sessionId, options.accountPubkey)) return;
    await this.repository.setStatus(options.accountPubkey, status);
    if (this.isCurrent(sessionId, options.accountPubkey)) options.onStatus?.(status);
  }

  private async fetchPushedEvent(
    hint: EncryptedPushInboxEntry["hint"],
    account: string,
    sessionId: string,
  ): Promise<NostrEvent | null> {
    const relays = safePushRelays(hint.relays);
    if (!relays.length || !this.isCurrent(sessionId, account)) return null;
    return new Promise(resolve => {
      let complete = false;
      let subscription: SubscriptionLike | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (event: NostrEvent | null) => {
        if (complete) return;
        complete = true;
        if (timer) clearTimeout(timer);
        closeSubscription(subscription);
        resolve(event);
      };
      try {
        subscription = this.subscribeFn(relays, [{
          kinds: [1059], ids: [hint.eventId], "#p": [account],
        }]);
        subscription.on("event", (event: NostrEvent) => {
          if (this.isCurrent(sessionId, account) && isVerifiedPushGiftWrap(event, account, hint.eventId)) done(event);
        });
        subscription.on("failure", () => undefined);
        // A relay's EOSE does not mean another relay has responded.
        timer = setTimeout(() => done(null), 2_500);
      } catch {
        done(null);
      }
    });
  }

  recoverNotificationInbox() {
    if (this.options && this.sessionId) this.drainEncryptedPushInbox(this.sessionId, this.options.accountPubkey);
    return this.resume("manual");
  }

  private drainEncryptedPushInbox(sessionId: string, account: string) {
    if (this.pushInboxFlight || !this.isCurrent(sessionId, account) || !this.pipeline) return;
    const flight = (async () => {
      const entries = await readEncryptedPushInbox(account);
      if (!this.isCurrent(sessionId, account)) return;
      startupMark("push_inbox_read", { entries: entries.length });
      const acknowledged: string[] = [];
      let next = 0;
      // Bound expensive decryption and relay lookups without blocking normal REQ.
      await Promise.all(Array.from({ length: Math.min(2, entries.length) }, async () => {
        while (next < entries.length && this.isCurrent(sessionId, account)) {
          const entry = entries[next++];
          const hint = entry.hint;
          let event: NostrEvent | null = null;
          try {
            const fetchStarted = Date.now();
            const embedded = !!hint.event && isVerifiedPushGiftWrap(hint.event, account, hint.eventId);
            if (embedded) {
              event = hint.event!;
            } else {
              event = await this.fetchPushedEvent(hint, account, sessionId);
            }
            startupMark("push_hint_event", { from: embedded ? "push" : event ? "relay" : "missing", fetchMs: embedded ? 0 : Date.now() - fetchStarted });
            if (!event || !this.isCurrent(sessionId, account)) continue;
            // Reuse the same NIP-17 authorization, durable storage and dedupe
            // pipeline as realtime Relay delivery. Never mirror raw push data.
            const result = await this.pipeline?.ingestNostrEvent(event, { source: "realtime" });
            // Already-stored messages count too: unacknowledged hints were kept
            // forever and re-processed on every launch.
            if (result && (result.inserted || result.deferred || result.discarded || ("known" in result && result.known))) acknowledged.push(entry.id);
          } catch (error) {
            logger.warn("[message-sync] encrypted push hint deferred", error instanceof Error ? error.name : "unknown");
          }
        }
      }));
      if (acknowledged.length && this.isCurrent(sessionId, account)) {
        await acknowledgeEncryptedPushInbox(account, acknowledged);
      }
    })().catch(error => {
      logger.warn("[message-sync] encrypted push inbox unavailable", error instanceof Error ? error.name : "unknown");
    }).finally(() => {
      if (this.pushInboxFlight === flight) this.pushInboxFlight = null;
    });
    this.pushInboxFlight = flight;
  }

  async start(options: MessageSyncOptions) {
    this.stop();
    const accountPubkey = options.accountPubkey.toLowerCase();
    const relays = [...new Set(options.relays.map(normalizeRelayUrl).filter(Boolean))];
    options = { ...options, accountPubkey, relays };
    this.options = options;
    const sessionId = `${accountPubkey.slice(0, 8)}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = sessionId;
    this.abortController = new AbortController();
    const isCurrent = () => this.isCurrent(sessionId, accountPubkey);
    this.pipeline = new MessageIngestionPipeline(
      accountPubkey,
      { ...options.decodeContext, accountPubkey },
      isCurrent,
      options.onMessage,
      this.repository,
      this.decode,
      options.onPersistedMessage
    );

    // Open pooled inbox sockets before awaiting IndexedDB status writes.
    // The subscription itself still waits for authorized account restoration.
    this.resumeRelays(options.relays);
    await this.setStatus("connecting", sessionId);
    if (!isCurrent()) return;
    const cleanup = await this.repository.runUnsupportedMessageCleanupMigration(accountPubkey);
    if (cleanup.ran) {
      logger.info(`[message-sync] message cleanup migration v${cleanup.version} completed purged=${cleanup.purged}`);
    }
    // Consume cached encrypted Push events without waiting for legacy history.
    if (isCurrent()) this.drainEncryptedPushInbox(sessionId, accountPubkey);
    const localMessages = (await this.repository.listRecent(accountPubkey))
      .filter(record => record.protocol === "nip17" && record.transportKind === 1059);
    for (const record of localMessages) {
      if (!isCurrent()) return;
      const restoredMessage: CanonicalMessage = {
        id: record.id,
        senderPubkey: record.senderPubkey,
        recipientPubkeys: record.recipientPubkeys,
        conversationId: record.conversationId,
        plaintext: record.plaintext,
        ciphertext: record.ciphertext,
        createdAt: record.createdAt,
        protocol: record.protocol as CanonicalMessage["protocol"],
        transportKind: record.transportKind,
        transportEventId: record.transportEventIds[0],
        rumorId: record.rumorId,
        replyTo: record.replyTo,
        rootId: record.rootId,
        tags: record.tags || []
      };
      try {
        await options.onMessage?.(restoredMessage, { source: "local-migration" });
        await options.onPersistedMessage?.(restoredMessage, { source: "local-migration" }, false);
        debugLog("storage", "dexie_message_restored", {
          logicalMessageId: record.id.slice(0, 12),
          transportEventId: record.transportEventIds[0]?.slice(0, 12) || "unknown",
          sender: record.senderPubkey.slice(0, 12),
          account: accountPubkey.slice(0, 12)
        });
      } catch (error) {
        debugLog("ui", "ui_restore_failed", {
          logicalMessageId: record.id.slice(0, 12),
          account: accountPubkey.slice(0, 12),
          reason: error instanceof Error ? error.name || "Error" : "unknown_error"
        }, "warn");
      }
    }
    if (!isCurrent()) return;

    // Re-evaluate messages that were durably quarantined by an earlier session.
    // This happens after account stores have had a chance to restore friendship
    // state, but before a new catch-up advances the session further.
    await this.pipeline.retryDeferredAuthorization();
    if (!isCurrent()) return;

    if (options.historyGate) {
      // Cloud read state / friendships are still being restored. Push hints
      // above are already shown; Relay streams must not race that restore.
      this.listenForPushHints(sessionId, accountPubkey);
      startupMark("history_gate_waiting");
      await options.historyGate;
      if (!isCurrent()) return;
      startupMark("history_gate_released");
      this.drainEncryptedPushInbox(sessionId, accountPubkey);
      await this.pipeline.retryDeferredAuthorization();
      if (!isCurrent()) return;
    }

    let state = await this.repository.getSyncState(accountPubkey);
    // Existing local messages do not prove that older Relay history was ever
    // repaired. Upgraded devices without explicit completion state must enter
    // the same bounded repair flow as a fresh installation.
    if (!state.historyBackfillCompletedAt && !state.historyBackfillStartedAt) {
      state = await this.repository.updateSyncState(accountPubkey, { historyBackfillStartedAt: this.now() });
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    // Realtime only needs to bridge the startup race. The separate bounded,
    // checkpointed catch-up below owns every gap since the last session; an
    // old watermark here would reopen an unbounded backlog stream (and replay
    // it on every reconnect). buildMessageSubscriptions still applies the
    // NIP-17 48h wrapper skew, which new wraps need to match live.
    // limit: 0 skips the stored part of that 48h window. The relay replays
    // this REQ on every reconnect, and without it each resume re-downloaded
    // every wrap of the last two days, all already known.
    const filters = buildMessageSubscriptions(accountPubkey, options.authors, nowSeconds)
      .map(filter => ({ ...filter, limit: 0 }));

    // Subscribe before catch-up so an event arriving during the historical query
    // is already covered. Both streams converge in the same idempotent pipeline.
    this.realtimeSubscription = this.subscribeFn(options.relays, filters);
    this.realtimeSubscription.on("event", (event: NostrEvent, relayUrl?: string) => {
      if (!isCurrent()) return;
      this.noteRealtimeEvent(accountPubkey, relayUrl || "unknown", event.created_at);
      void this.pipeline?.ingestNostrEvent(event, { source: "realtime", relayUrl })
        .then(() => this.noteSeenWrap(accountPubkey, event, true), () => undefined);
    });
    this.realtimeSubscription.on("eose", (relayUrl: string) => {
      if (!isCurrent()) return;
      void this.repository.updateRelayState(accountPubkey, relayUrl, { lastEOSEAt: this.now() });
    });

    // A listener alone misses sockets that opened before this manager started.
    // Subscribe first, then snapshot to close the observe/snapshot race.
    this.removeRelayObserver = this.observeRelays(event => {
      if (!isCurrent() || !options.relays.includes(event.url)) return;
      void this.repository.updateRelayState(accountPubkey, event.url, event.connected
        ? { connected: true, lastConnectedAt: event.at }
        : { connected: false, lastDisconnectedAt: event.at });
      if (event.connected) this.connectedRelays.add(event.url);
      else this.connectedRelays.delete(event.url);
      if (!event.connected && this.connectedRelays.size === 0) void this.setStatus("offline", sessionId);
      if (event.connected) {
        void this.repository.updateSyncState(accountPubkey, { lastRealtimeConnectedAt: event.at });
        void retryOutgoingQueue(accountPubkey);
        // A first connection can arrive after the startup catch-up timeout
        // (catch-up: 8s, connection-open timeout: 10s). Always queue a bounded
        // repair on successful connection; runCatchup coalesces it if startup
        // history repair is still running.
        void this.resume(event.reconnected ? "reconnect" : "resume", event.url);
      }
    });
    if (!isCurrent()) return;
    const relaySnapshot = inspectRelays();
    this.connectedRelays = new Set(options.relays.filter(url => relaySnapshot[url]?.ready));
    this.installForegroundHandlers();
    await this.runCatchup("history", undefined, sessionId);
  }

  async resume(source: "reconnect" | "resume" | "manual" = "resume", relayUrl?: string) {
    if (!this.options || !this.sessionId) return;
    await this.runCatchup(source, relayUrl, this.sessionId);
  }

  private async runCatchup(source: MessageSource, relayUrl: string | undefined, sessionId: string) {
    const options = this.options;
    if (!options || !this.isCurrent(sessionId, options.accountPubkey) || !this.isForeground()) return;
    // No configured receiver is not a successful zero-Relay reconciliation.
    if (!options.relays.length) {
      await this.setStatus("offline", sessionId);
      return;
    }
    if (this.catchupRunning && this.catchupSessionId === sessionId) {
      // A foreground wake during a normally running catch-up needs no extra
      // pass. If background suspension aborted the old pass, queue one resume.
      if (source === "resume" && !this.catchupAbortController?.signal.aborted) return;
      this.catchupPending = source;
      return;
    }
    this.catchupRunning = true;
    this.catchupSessionId = sessionId;
    try {
      let nextSource: MessageSource | null = source;
      do {
        const activeSource = nextSource;
        nextSource = null;
        this.catchupPending = null;
        if (!this.isCurrent(sessionId, options.accountPubkey) || !this.isForeground()) return;
        const catchupAbortController = new AbortController();
        this.catchupAbortController = catchupAbortController;
        await this.setStatus("catching-up", sessionId);
        if (catchupAbortController.signal.aborted || !this.isForeground()) return;
        const state = await this.repository.getSyncState(options.accountPubkey);
        if (catchupAbortController.signal.aborted || !this.isForeground()) return;
        const nowSeconds = Math.floor(this.now() / 1000);
        const currentRelaySignature = [...new Set(options.relays)].sort().join("|");
        const previousRelaySet = new Set(
          (state.historyBackfillRelaySignature || "").split("|").filter(Boolean)
        );
        const newlyAddedRelays = options.relays.filter(url => !previousRelaySet.has(url));
        const localHighWatermark = state.highWatermarkCreatedAt
          || await this.repository.latestMessageCreatedAt(options.accountPubkey)
          || undefined;
        if (catchupAbortController.signal.aborted || !this.isForeground()) return;
        const freshHistoryRepair = !state.historyBackfillCompletedAt
          && !!state.historyBackfillStartedAt;
        // A gift-wrap carries a randomized outer timestamp. The completed
        // *scan time*, not the newest decrypted rumor's createdAt, anchors
        // future REQs. buildMessageSubscriptions applies the NIP-17 48h skew.
        const highWatermarkSince = localHighWatermark
          ? calculateCatchupSince(localHighWatermark, nowSeconds)
          : nowSeconds;
        const lastCompleteSince = state.lastCatchupCompletedAt
          ? calculateCatchupSince(Math.floor(state.lastCatchupCompletedAt / 1000), nowSeconds)
          : highWatermarkSince;
        const durable = !freshHistoryRepair
          ? validatedCheckpoint(state.incrementalCatchup, currentRelaySignature, options.relays)
          : null;
        const baseRelays = state.historyBackfillCompletedAt && newlyAddedRelays.length
          ? newlyAddedRelays
          : options.relays;
        const freshSince = Math.min(highWatermarkSince, lastCompleteSince);
        const checkpoint: IncrementalCatchupCheckpoint | null = freshHistoryRepair ? null : durable || {
          relaySignature: currentRelaySignature,
          requiredRelays: [...baseRelays],
          completedRelays: [],
          since: freshSince,
          until: nowSeconds,
          pendingUntilByRelay: Object.fromEntries(baseRelays.map(url => [url, nowSeconds])),
        };
        const relays = freshHistoryRepair
          ? relayUrl ? [relayUrl] : options.relays
          : checkpoint
            ? (relayUrl && relayUrl in checkpoint.pendingUntilByRelay
              ? [relayUrl]
              : Object.keys(checkpoint.pendingUntilByRelay))
            : [];
        const since = freshHistoryRepair ? 0 : checkpoint!.since;
        const until = freshHistoryRepair
          ? Math.min(state.historyBackfillUntil ?? nowSeconds, nowSeconds)
          : checkpoint!.until;
        const filters = buildMessageSubscriptions(options.accountPubkey, options.authors, since, until)
          .map(filter => ({ ...filter, limit: CATCHUP_PAGE_LIMIT }));
        logger.debug(`[message-sync] account=${options.accountPubkey.slice(0, 8)} session=${sessionId} phase=${activeSource} since=${since} until=${until}`);
        const preferredUrl = normalizeRelayUrl(options.preferredCatchupRelay?.() || "");
        const preferredRelay = (preferredUrl && relays.find(url => normalizeRelayUrl(url) === preferredUrl)) || "";
        const orderedRelays = preferredRelay
          ? [preferredRelay, ...relays.filter(url => url !== preferredRelay)]
          : relays;
        const trackSubscription = (subscription: SubscriptionLike) => {
          this.activeCatchupSubscriptions.add(subscription);
          return () => this.activeCatchupSubscriptions.delete(subscription);
        };
        const notifyPreferredCaughtUp = () => {
          if (!this.isCurrent(sessionId, options.accountPubkey)) return;
          startupMark("preferred_relay_caught_up", { source: activeSource });
          options.onPreferredRelayCaughtUp?.();
        };

        // Arrival-time catch-up: one page of what the relay stored since the
        // cursor replaces re-reading the whole NIP-59 backdating window there.
        // A full or failed page falls back to the normal window for that relay.
        const receiptUrl = normalizeRelayUrl(await options.receivedSinceRelay?.().catch(() => "") || "");
        if (catchupAbortController.signal.aborted || !this.isCurrent(sessionId, options.accountPubkey)) return;
        const receiptCandidate = (receiptUrl && relays.find(url => normalizeRelayUrl(url) === receiptUrl)) || "";
        const receivedCursor = receiptCandidate ? state.relayStates[receiptCandidate]?.receivedCursor : undefined;
        const receiptStartedAt = this.now();
        let receiptRelay = "";
        let receiptEvents = 0;
        if (!freshHistoryRepair && receiptCandidate && typeof receivedCursor === "number") {
          const receiptFilters = filters.map(({ since: _since, until: _until, ...filter }) => ({ ...filter, received_since: receivedCursor }));
          const page = await fetchCatchupPage([receiptCandidate], receiptFilters, this.catchupTimeoutMs, this.subscribeFn, trackSubscription, catchupAbortController.signal);
          let processed = true;
          for (const { event, relayUrl: eventRelay } of page.events) {
            if (catchupAbortController.signal.aborted || !this.isCurrent(sessionId, options.accountPubkey)) { processed = false; break; }
            await this.pipeline?.ingestNostrEvent(event, { source: activeSource!, relayUrl: eventRelay || receiptCandidate });
            this.noteSeenWrap(options.accountPubkey, event);
          }
          receiptEvents = page.events.length;
          const pageComplete = processed && !page.aborted && !page.timedOut && !page.failedRelays.size && page.allRelaysCompleted;
          if (pageComplete && page.events.length < CATCHUP_PAGE_LIMIT) receiptRelay = receiptCandidate;
          startupMark("received_since_page", { events: receiptEvents, used: !!receiptRelay });
          if (receiptRelay && receiptRelay === preferredRelay) notifyPreferredCaughtUp();
        }

        // NIP-77: for relays that support it, compare the processed wraps in
        // this window with the relay's set and fetch only the missing ones,
        // instead of downloading the whole backdating window again.
        const negentropyDone = new Set<string>();
        let negentropyEvents = 0;
        const negentropyRelays = !freshHistoryRepair && options.negentropyRelays
          ? await options.negentropyRelays(relays.filter(url => url !== receiptRelay)).catch(() => [])
          : [];
        if (negentropyRelays.length && !catchupAbortController.signal.aborted && this.isCurrent(sessionId, options.accountPubkey)) {
          await this.flushSeenWraps();
          if (this.seenWrapsPrunedFor !== options.accountPubkey) {
            // Far older than any catch-up window; once per session.
            this.seenWrapsPrunedFor = options.accountPubkey;
            await this.repository.pruneSeenGiftWraps(options.accountPubkey, nowSeconds - 30 * 24 * 60 * 60).catch(() => 0);
          }
          const { limit: _limit, ...windowFilter } = filters[0];
          const local = await this.repository.listSeenGiftWraps(options.accountPubkey, windowFilter.since ?? 0, windowFilter.until ?? nowSeconds);
          for (const relay of negentropyRelays) {
            if (catchupAbortController.signal.aborted || !this.isCurrent(sessionId, options.accountPubkey)) break;
            const started = this.now();
            const missing = await this.reconcile(relay, windowFilter, local, { timeoutMs: this.catchupTimeoutMs, signal: catchupAbortController.signal });
            let complete = missing !== null;
            for (let index = 0; complete && index < missing!.length; index += CATCHUP_PAGE_LIMIT) {
              const ids = missing!.slice(index, index + CATCHUP_PAGE_LIMIT);
              const page = await fetchCatchupPage([relay], [{ ids, limit: ids.length }], this.catchupTimeoutMs, this.subscribeFn, trackSubscription, catchupAbortController.signal);
              for (const { event } of page.events) {
                if (catchupAbortController.signal.aborted || !this.isCurrent(sessionId, options.accountPubkey)) { complete = false; break; }
                await this.pipeline?.ingestNostrEvent(event, { source: activeSource!, relayUrl: relay });
                this.noteSeenWrap(options.accountPubkey, event);
              }
              negentropyEvents += page.events.length;
              complete = complete && !page.aborted && !page.timedOut && !page.failedRelays.size && page.allRelaysCompleted;
            }
            startupMark("negentropy_sync", { missing: missing?.length ?? null, used: complete, durationMs: this.now() - started });
            if (complete) negentropyDone.add(relay);
          }
        }
        const reconciled = new Set([...negentropyDone, ...(receiptRelay ? [receiptRelay] : [])]);
        const result = await runPagedCatchup({
          relays: orderedRelays.filter(url => !reconciled.has(url)),
          filters,
          initialUntilByRelay: freshHistoryRepair
            ? Object.fromEntries(relays.map(url => [url, state.relayStates[url]?.historyBackfillUntil ?? until]))
            : checkpoint?.pendingUntilByRelay,
          subscribeFn: this.subscribeFn,
          trackSubscription,
          signal: catchupAbortController.signal,
          timeoutMs: this.catchupTimeoutMs,
          // Initial onboarding can resume a bounded history page sequence.
          // Normal resume/reconnect runs a bounded page count per relay per wake.
          maxBatches: freshHistoryRepair && activeSource === "history" ? INITIAL_HISTORY_MAX_BATCHES : RESUME_MAX_BATCHES,
          // On resume, a dead relay must not serially delay a healthy inbox.
          // Keep initial history repair conservative; bound resume to two.
          relayConcurrency: activeSource === "history" ? 1 : 2,
          onRelayDone: (doneRelay, progress) => {
            if (!preferredRelay || normalizeRelayUrl(doneRelay) !== preferredUrl || !progress.naturalEnd || progress.incomplete) return;
            notifyPreferredCaughtUp();
          },
          isCurrent: () => this.isCurrent(sessionId, options.accountPubkey),
          onEvent: async (event, eventRelay) => {
            await this.pipeline?.ingestNostrEvent(event, { source: activeSource!, relayUrl: eventRelay });
            // Initial history import can be thousands of wraps; the first
            // reconciliation afterwards fetches the recent window once instead.
            if (!freshHistoryRepair) this.noteSeenWrap(options.accountPubkey, event);
          }
        });
        await this.flushSeenWraps();
        if (!this.isCurrent(sessionId, options.accountPubkey)) return;
        if (receiptRelay) {
          // The arrival page covered this relay; record it like a natural end.
          result.completedRelays.add(receiptRelay);
          result.relayProgress[receiptRelay] = { naturalEnd: true, hitMaxBatches: false, incomplete: false };
          result.received += receiptEvents;
        }
        for (const relay of negentropyDone) {
          // Reconciled against the relay's full window: a natural end too.
          result.completedRelays.add(relay);
          result.relayProgress[relay] = { naturalEnd: true, hitMaxBatches: false, incomplete: false };
        }
        result.received += negentropyEvents;
        if (catchupAbortController.signal.aborted || !this.isForeground()) {
          // Incomplete pages are deliberately not committed as checkpoints.
          // Realtime remains subscribed and foreground resume will retry.
          if (this.isForeground()) {
            nextSource = this.catchupPending || "resume";
            this.catchupPending = null;
            continue;
          }
          return;
        }
        const completedAt = this.now();
        const completedFreshHistory = freshHistoryRepair
          && !relayUrl // One Relay's EOSE cannot finalize initial history for every Relay.
          && result.allRelaysCompleted
          && result.exhaustedHistory
          && !result.hitMaxBatches
          && !result.incomplete;

        // A checkpoint describes a fixed, bounded reconciliation window.
        // Every configured Relay has its own pending inclusive timestamp.
        // A failed/stalled page stays pending; only a fully processed page may
        // advance its cursor, and only natural end establishes coverage.
        const pending = { ...(checkpoint?.pendingUntilByRelay || {}) };
        const completed = new Set(checkpoint?.completedRelays || []);
        if (!freshHistoryRepair) {
          for (const [url, progress] of Object.entries(result.relayProgress)) {
            if (progress.naturalEnd && !progress.incomplete) {
              delete pending[url];
              completed.add(url);
            } else if (!progress.incomplete && typeof progress.nextUntil === "number") {
              pending[url] = progress.nextUntil;
            }
          }
        }
        const completedIncremental = !freshHistoryRepair && !!checkpoint
          && !result.incomplete
          && Object.keys(pending).length === 0
          && checkpoint.requiredRelays.every(url => completed.has(url));
        const fullAccountCoverage = completedIncremental && !!checkpoint
          && checkpoint.requiredRelays.length === options.relays.length
          && options.relays.every(url => completed.has(url));
        const completedRelaySignature = [...new Set([...previousRelaySet, ...completed])]
          .filter(url => options.relays.includes(url)).sort().join("|");

        const resumableHistoryCursor = freshHistoryRepair
          && !result.incomplete
          && result.hitMaxBatches
          && typeof result.nextUntil === "number"
          && result.nextUntil <= until
            ? result.nextUntil
            : undefined;

        const syncStatePatch: Partial<MessageSyncStateRecord> = {};
        if (completedFreshHistory || fullAccountCoverage) {
          // A continuation may finish much later than the initial query.
          // The completed frontier is the ORIGINAL query's upper bound, not
          // today's clock: the interval since then still needs checking.
          const coveredAt = completedFreshHistory ? until * 1000 : checkpoint!.until * 1000;
          syncStatePatch.lastSuccessfulSyncAt = Math.max(state.lastSuccessfulSyncAt || 0, coveredAt);
          syncStatePatch.lastCatchupCompletedAt = Math.max(state.lastCatchupCompletedAt || 0, coveredAt);
        }
        if (completedFreshHistory) {
          syncStatePatch.historyBackfillCompletedAt = completedAt;
          syncStatePatch.historyBackfillUntil = undefined;
          syncStatePatch.historyBackfillRelaySignature = currentRelaySignature;
        } else if (resumableHistoryCursor !== undefined) {
          syncStatePatch.historyBackfillUntil = resumableHistoryCursor;
        }
        if (!freshHistoryRepair && checkpoint) {
          // Undefined clears stale checkpoint data in the same atomic commit
          // that records the newly confirmed completion frontier.
          syncStatePatch.incrementalCatchup = completedIncremental ? undefined : {
            ...checkpoint,
            pendingUntilByRelay: pending,
            completedRelays: [...completed].sort(),
          };
          if (completedIncremental && state.historyBackfillCompletedAt) {
            syncStatePatch.historyBackfillRelaySignature = completedRelaySignature;
          }
        }

        const relayPatches: Record<string, Partial<RelaySyncStateRecord>> = {};
        for (const completedRelay of result.completedRelays) {
          const progress = result.relayProgress[completedRelay];
          // Every event this relay received before coveredUntil is processed.
          const coveredUntil = completedRelay === receiptRelay
            ? Math.floor(receiptStartedAt / 1000)
            : progress?.naturalEnd && !progress.incomplete
              ? freshHistoryRepair ? until : checkpoint!.until
              : undefined;
          relayPatches[completedRelay] = {
            lastEOSEAt: completedAt,
            ...(completedRelay === receiptCandidate && coveredUntil !== undefined
              ? { receivedCursor: Math.max(
                  state.relayStates[completedRelay]?.receivedCursor || 0,
                  coveredUntil - RECEIVED_CURSOR_MARGIN_SECONDS,
                ) }
              : {}),
            ...(freshHistoryRepair && progress?.naturalEnd && !progress.incomplete
              ? { historyBackfillCompletedAt: completedAt, historyBackfillUntil: undefined }
              : freshHistoryRepair && typeof progress?.nextUntil === "number" && !progress.incomplete
                ? { historyBackfillUntil: progress.nextUntil }
                : {}),
            ...(!freshHistoryRepair && progress?.naturalEnd && !progress.incomplete
              ? { lastSuccessfulCatchupAt: Math.max(
                  state.relayStates[completedRelay]?.lastSuccessfulCatchupAt || 0,
                  checkpoint!.until * 1000,
                ) }
              : completedFreshHistory
                ? { lastSuccessfulCatchupAt: until * 1000 }
                : {}),
          };
        }
        if (catchupAbortController.signal.aborted || !this.isForeground()) return;
        // Persist both checkpoint and relay EOSE markers atomically, scoped to
        // the active account. Reprocessing after a crash is harmless.
        if (Object.keys(syncStatePatch).length || Object.keys(relayPatches).length) {
          await this.repository.commitCatchupProgress(options.accountPubkey, syncStatePatch, relayPatches);
        }
        options.onCatchupStatus?.(completedFreshHistory || fullAccountCoverage ? "settled" : "pending");
        startupMark("catchup_page", {
          source: activeSource, received: result.received, unique: result.unique,
          settled: completedFreshHistory || fullAccountCoverage, incomplete: !!result.incomplete,
          failedRelays: result.failedRelays.size, timedOut: !!result.timedOut,
        });
        this.scheduleRelayRetries(sessionId, options.accountPubkey, result);
        if (result.incomplete) {
          logger.warn(`[message-sync] catch-up incomplete account=${options.accountPubkey.slice(0, 8)} phase=${activeSource} failed=${[...result.failedRelays.entries()].map(([url, reason]) => `${url}:${reason}`).join(",") || (result.paginationStalled ? "timestamp-pagination-stalled" : result.timedOut ? "timeout" : result.aborted ? "aborted" : "partial")}`);
        }
        logger.debug(`[message-sync] account=${options.accountPubkey.slice(0, 8)} phase=${activeSource} received=${result.received} unique=${result.unique}`);
        // Continue only safe completed pages in the PR3 idle scheduler.
        // Failed/stalled pages need a later recovery/manual attempt.
        if (!result.incomplete && (freshHistoryRepair && result.hitMaxBatches || !freshHistoryRepair && Object.keys(pending).length > 0)) {
          this.scheduleIdleContinuation(sessionId, options.accountPubkey);
        } else if (completedIncremental || completedFreshHistory) {
          this.clearIdleContinuation();
        }
        nextSource = this.catchupPending;
      } while (nextSource && this.isCurrent(sessionId, options.accountPubkey) && this.isForeground());
      if (!this.catchupAbortController?.signal.aborted && this.isForeground()) {
        await this.setStatus("live", sessionId);
        startupMark("relay_catchup_live");
      }
    } catch (e) {
      logger.warn(`[message-sync] catch-up failed account=${options.accountPubkey.slice(0, 8)}`, e);
      // A failing catch-up never records completion, so the next launch
      // repeats the full history page; keep the cause in the exported log.
      const failure = describeError(e);
      debugLog("sync", "catchup_failed", failure, "warn");
      startupMark("catchup_failed", failure);
      await this.setStatus("error", sessionId);
    } finally {
      if (this.catchupSessionId === sessionId) {
        // A quick background -> foreground transition can happen while an
        // aborted page is still completing an in-flight durable write.
        // Preserve the queued wake across that final await.
        const pendingResume = this.catchupPending;
        const interrupted = this.catchupAbortController?.signal.aborted;
        this.catchupRunning = false;
        this.catchupSessionId = "";
        this.catchupAbortController = null;
        this.catchupPending = null;
        if (this.isForeground() && this.isCurrent(sessionId, options.accountPubkey) && (pendingResume || interrupted)) {
          queueMicrotask(() => {
            if (this.isCurrent(sessionId, options.accountPubkey) && this.isForeground()) {
              void this.resume(pendingResume === "reconnect" || pendingResume === "manual" ? pendingResume : "resume");
            }
          });
        }
      }
    }
  }

  async retryDeferredAuthorization() {
    if (!this.options || !this.pipeline) return 0;
    return this.pipeline.retryDeferredAuthorization();
  }

  async markConversationRead(conversationId: string) {
    if (!this.options) return;
    await this.repository.markRead(this.options.accountPubkey, conversationId);
  }

  async getUnreadCount(conversationId: string) {
    if (!this.options) return 0;
    return this.repository.getUnreadCount(this.options.accountPubkey, conversationId);
  }

  async getTotalUnread() {
    if (!this.options) return 0;
    return this.repository.getTotalUnread(this.options.accountPubkey);
  }

  /** The service worker can receive a Push while this tab is already visible. */
  private listenForPushHints(sessionId: string, accountPubkey: string) {
    this.removePushInboxListener?.();
    this.removePushInboxListener = null;
    if (typeof navigator === "undefined" || !navigator.serviceWorker
      || typeof navigator.serviceWorker.addEventListener !== "function"
      || typeof navigator.serviceWorker.removeEventListener !== "function") return;
    const onPushHint = (event: MessageEvent) => {
      if (event.data?.type === "ENCRYPTED_PUSH_HINT_AVAILABLE" && this.isCurrent(sessionId, accountPubkey)) {
        this.drainEncryptedPushInbox(sessionId, accountPubkey);
      }
    };
    navigator.serviceWorker.addEventListener("message", onPushHint);
    this.removePushInboxListener = () => navigator.serviceWorker.removeEventListener("message", onPushHint);
  }

  private installForegroundHandlers() {
    this.removeForegroundResume?.();
    this.removeBackgroundListener?.();
    // Abort only optional history/catch-up work on backgrounding; do not abort
    // the account's realtime subscription or any message persistence flight.
    if (typeof document !== "undefined") {
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          this.catchupAbortController?.abort();
          this.clearIdleContinuation();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      this.removeBackgroundListener = () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (this.options && this.sessionId) this.listenForPushHints(this.sessionId, this.options.accountPubkey);
    this.removeForegroundResume = onAppResume(() => {
      const options = this.options;
      if (!options || !this.sessionId) return;
      // DM inbox relays may not be part of the ordinary read-relay settings.
      // Recover exactly the active account's subscriptions alongside read relays.
      // restoreRelayConnections skips healthy/in-flight sockets itself.
      this.resumeRelays([...new Set([...options.relays, ...this.activeReadRelays()])]);
      this.drainEncryptedPushInbox(this.sessionId, options.accountPubkey);
      void this.retryOutgoing(options.accountPubkey);
      void this.resume("resume");
    });
  }

  /** Catch-up passes flush once at their end; realtime arrivals on a timer. */
  private noteSeenWrap(account: string, event: NostrEvent, flushLater = false) {
    if (event?.kind !== 1059 || typeof event.id !== "string" || !Number.isInteger(event.created_at)) return;
    // Only fully handled wraps: one parked for a later retry must be refetched.
    if (!this.pipeline?.isTransportFinalized(event.id)) return;
    // Only the recent window is ever reconciled; skip deep history imports.
    if (event.created_at < Math.floor(this.now() / 1000) - SEEN_WRAP_WINDOW_SECONDS) return;
    this.seenWraps.push({ account, id: event.id, createdAt: event.created_at });
    if (!flushLater || this.seenWrapsTimer) return;
    this.seenWrapsTimer = setTimeout(() => { this.seenWrapsTimer = null; void this.flushSeenWraps(); }, 1_000);
    (this.seenWrapsTimer as any).unref?.();
  }

  private async flushSeenWraps() {
    if (this.seenWrapsTimer) clearTimeout(this.seenWrapsTimer);
    this.seenWrapsTimer = null;
    const batch = this.seenWraps.splice(0);
    const byAccount = new Map<string, Array<{ id: string; createdAt: number }>>();
    for (const wrap of batch) {
      const list = byAccount.get(wrap.account) || [];
      list.push({ id: wrap.id, createdAt: wrap.createdAt });
      byAccount.set(wrap.account, list);
    }
    for (const [account, wraps] of byAccount) {
      await this.repository.markGiftWrapsSeen(account, wraps).catch(() => undefined);
    }
  }

  stop() {
    void this.flushSeenWraps();
    this.flushRealtimeEventWrites();
    this.relayEventHighs.clear();
    this.sessionId = "";
    this.abortController?.abort();
    this.abortController = null;
    this.catchupAbortController?.abort();
    this.catchupAbortController = null;
    this.clearIdleContinuation();
    this.clearRelayRetries();
     this.removeBackgroundListener?.();
    this.removeBackgroundListener = null;
    closeSubscription(this.realtimeSubscription);
    this.realtimeSubscription = null;
    for (const subscription of this.activeCatchupSubscriptions) closeSubscription(subscription);
    this.activeCatchupSubscriptions.clear();
    this.removeRelayObserver?.();
    this.removeRelayObserver = null;
    this.removeForegroundResume?.();
    this.removeForegroundResume = null;
    this.removePushInboxListener?.();
    this.removePushInboxListener = null;
    this.pushInboxFlight = null;
    this.connectedRelays.clear();
    this.catchupRunning = false;
    this.catchupSessionId = "";
    this.catchupPending = null;
    this.options = null;
    this.pipeline = null;
  }
}
