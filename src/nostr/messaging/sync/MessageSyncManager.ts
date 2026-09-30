import type { NostrEvent } from "nostr-tools";
import { getRelaysFromStorage, onRelayConnectionState, restoreRelayConnections, type RelayConnectionEvent } from "@/nostr/relays";
import { nostrClient } from "@/services/nostrClient";
import { buildMessageSubscriptions } from "@/nostr/messaging/subscriptions";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { closeSubscription } from "@/utils/subscriptions";
import { logger } from "@/utils/logger";
import { debugLog } from "@/utils/debugLog";
import { runPagedCatchup, type SubscribeForCatchup } from "./catchup";
import { MessageIngestionPipeline, type DecodeMessage } from "./ingestion";
import { calculateCatchupSince } from "./sorting";
import { retryOutgoingQueue } from "@/nostr/messaging/service";
import { onAppResume } from "@/services/appResumeCoordinator";
import {
  INITIAL_HISTORY_MAX_BATCHES,
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
};

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
  private abortController: AbortController | null = null;

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

  async start(options: MessageSyncOptions) {
    this.stop();
    const accountPubkey = options.accountPubkey.toLowerCase();
    this.options = { ...options, accountPubkey };
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

    await this.setStatus("connecting", sessionId);
    // Reset exhausted retry state and start connecting the exact Relay set selected
    // for this account before subscriptions/catch-up are created.
    this.resumeRelays(options.relays);
    const purged = await this.repository.purgeUnsupportedMessages(accountPubkey);
    if (purged > 0) logger.info(`[message-sync] removed ${purged} unsupported cached messages`);
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

    let state = await this.repository.getSyncState(accountPubkey);
    // Existing local messages do not prove that older Relay history was ever
    // repaired. Upgraded devices without explicit completion state must enter
    // the same bounded repair flow as a fresh installation.
    if (!state.historyBackfillCompletedAt && !state.historyBackfillStartedAt) {
      state = await this.repository.updateSyncState(accountPubkey, { historyBackfillStartedAt: this.now() });
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    // Realtime only needs to bridge the startup race. The separate bounded
    // catch-up below owns full history repair; keeping that work out of the
    // long-lived subscription prevents a new device from opening an unbounded
    // stream from timestamp zero.
    const realtimeSince = state.highWatermarkCreatedAt
      ? calculateCatchupSince(state.highWatermarkCreatedAt, nowSeconds)
      : nowSeconds;
    const filters = buildMessageSubscriptions(accountPubkey, options.authors, realtimeSince);

    // Subscribe before catch-up so an event arriving during the historical query
    // is already covered. Both streams converge in the same idempotent pipeline.
    this.realtimeSubscription = this.subscribeFn(options.relays, filters);
    this.realtimeSubscription.on("event", (event: NostrEvent, relayUrl?: string) => {
      if (!isCurrent()) return;
      void this.repository.updateRelayState(accountPubkey, relayUrl || "unknown", {
        lastEventCreatedAt: event.created_at
      });
      void this.pipeline?.ingestNostrEvent(event, { source: "realtime", relayUrl });
    });
    this.realtimeSubscription.on("eose", (relayUrl: string) => {
      if (!isCurrent()) return;
      void this.repository.updateRelayState(accountPubkey, relayUrl, { lastEOSEAt: this.now() });
    });

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
    this.installForegroundHandlers();
    await this.runCatchup("history", undefined, sessionId);
  }

  async resume(source: "reconnect" | "resume" | "manual" = "resume", relayUrl?: string) {
    if (!this.options || !this.sessionId) return;
    await this.runCatchup(source, relayUrl, this.sessionId);
  }

  private async runCatchup(source: MessageSource, relayUrl: string | undefined, sessionId: string) {
    const options = this.options;
    if (!options || !this.isCurrent(sessionId, options.accountPubkey)) return;
    if (this.catchupRunning && this.catchupSessionId === sessionId) {
      // iOS/PWA wake-up commonly emits visibilitychange + pageshow + focus in
      // one burst. A foreground "resume" arriving while catch-up is already
      // running adds no coverage (the realtime subscription already bridges the
      // race) and previously forced an immediate second historical pass.
      if (source === "resume") return;
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
        if (!this.isCurrent(sessionId, options.accountPubkey)) return;
        await this.setStatus("catching-up", sessionId);
        const state = await this.repository.getSyncState(options.accountPubkey);
        const nowSeconds = Math.floor(this.now() / 1000);
        const currentRelaySignature = [...new Set(options.relays)].sort().join("|");
        const previousRelaySet = new Set(
          (state.historyBackfillRelaySignature || "").split("|").filter(Boolean)
        );
        const newlyAddedRelays = options.relays.filter(url => !previousRelaySet.has(url));
        const localHighWatermark = state.highWatermarkCreatedAt
          || (await this.repository.list(options.accountPubkey))
            .reduce((max, message) => Math.max(max, message.createdAt || 0), 0)
          || undefined;
        const freshHistoryRepair = !relayUrl
          && !state.historyBackfillCompletedAt
          && !!state.historyBackfillStartedAt;
        const relays = relayUrl
          ? [relayUrl]
          : state.historyBackfillCompletedAt && newlyAddedRelays.length
            ? newlyAddedRelays
            : options.relays;
        const since = freshHistoryRepair
          ? 0
          : localHighWatermark
            ? calculateCatchupSince(localHighWatermark, nowSeconds)
            : nowSeconds;
        const until = freshHistoryRepair
          ? Math.min(state.historyBackfillUntil ?? nowSeconds, nowSeconds)
          : nowSeconds;
        const filters = buildMessageSubscriptions(options.accountPubkey, options.authors, since, until)
          .map(filter => ({ ...filter, limit: 500 }));
        logger.debug(`[message-sync] account=${options.accountPubkey.slice(0, 8)} session=${sessionId} phase=${activeSource} since=${since} until=${until}`);
        const result = await runPagedCatchup({
          relays,
          filters,
          subscribeFn: this.subscribeFn,
          trackSubscription: subscription => {
            this.activeCatchupSubscriptions.add(subscription);
            return () => this.activeCatchupSubscriptions.delete(subscription);
          },
          signal: this.abortController?.signal,
          timeoutMs: this.catchupTimeoutMs,
          maxBatches: freshHistoryRepair ? INITIAL_HISTORY_MAX_BATCHES : undefined,
          isCurrent: () => this.isCurrent(sessionId, options.accountPubkey),
          onEvent: async (event, eventRelay) => {
            await this.pipeline?.ingestNostrEvent(event, { source: activeSource!, relayUrl: eventRelay });
          }
        });
        if (!this.isCurrent(sessionId, options.accountPubkey)) return;
        const completedAt = this.now();
        const completedFreshHistory = freshHistoryRepair
          && result.allRelaysCompleted
          && result.exhaustedHistory
          && !result.hitMaxBatches
          && !result.incomplete;
        const completedRelaySetUpdate = !freshHistoryRepair
          && result.allRelaysCompleted
          && !result.incomplete;
        const completedRelaySignature = relayUrl
          ? [...new Set([...previousRelaySet, relayUrl])]
              .filter(url => options.relays.includes(url))
              .sort()
              .join("|")
          : currentRelaySignature;
        const resumableHistoryCursor = freshHistoryRepair
          && !result.incomplete
          && result.hitMaxBatches
          && typeof result.nextUntil === "number"
          && result.nextUntil <= until
            ? result.nextUntil
            : undefined;
        await this.repository.updateSyncState(options.accountPubkey, {
          lastSuccessfulSyncAt: completedAt,
          lastCatchupCompletedAt: completedAt,
          ...(completedFreshHistory
            ? {
                historyBackfillCompletedAt: completedAt,
                historyBackfillUntil: undefined,
                historyBackfillRelaySignature: currentRelaySignature
              }
            : resumableHistoryCursor !== undefined
              ? { historyBackfillUntil: resumableHistoryCursor }
              : completedRelaySetUpdate
                ? { historyBackfillRelaySignature: completedRelaySignature }
                : {})
        });
        for (const completedRelay of result.completedRelays) {
          await this.repository.updateRelayState(options.accountPubkey, completedRelay, {
            lastEOSEAt: completedAt,
            lastSuccessfulCatchupAt: completedAt
          });
        }
        logger.debug(`[message-sync] account=${options.accountPubkey.slice(0, 8)} phase=${activeSource} received=${result.received} unique=${result.unique}`);
        nextSource = this.catchupPending;
      } while (nextSource && this.isCurrent(sessionId, options.accountPubkey));
      await this.setStatus("live", sessionId);
    } catch (e) {
      logger.warn(`[message-sync] catch-up failed account=${options.accountPubkey.slice(0, 8)}`, e);
      await this.setStatus("error", sessionId);
    } finally {
      if (this.catchupSessionId === sessionId) {
        this.catchupRunning = false;
        this.catchupSessionId = "";
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

  private installForegroundHandlers() {
    this.removeForegroundResume?.();
    this.removeForegroundResume = onAppResume(() => {
      this.resumeRelays(this.activeReadRelays());
      if (this.options) void this.retryOutgoing(this.options.accountPubkey);
      void this.resume("resume");
    });
  }

  stop() {
    this.sessionId = "";
    this.abortController?.abort();
    this.abortController = null;
    closeSubscription(this.realtimeSubscription);
    this.realtimeSubscription = null;
    for (const subscription of this.activeCatchupSubscriptions) closeSubscription(subscription);
    this.activeCatchupSubscriptions.clear();
    this.removeRelayObserver?.();
    this.removeRelayObserver = null;
    this.removeForegroundResume?.();
    this.removeForegroundResume = null;
    this.connectedRelays.clear();
    this.catchupRunning = false;
    this.catchupSessionId = "";
    this.catchupPending = null;
    this.options = null;
    this.pipeline = null;
  }
}
