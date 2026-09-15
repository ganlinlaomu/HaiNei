import type { NostrEvent } from "nostr-tools";
import { subscribe, onRelayConnectionState, type RelayConnectionEvent } from "@/nostr/relays";
import { buildMessageSubscriptions } from "@/nostr/messaging/subscriptions";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { closeSubscription } from "@/utils/subscriptions";
import { logger } from "@/utils/logger";
import { runPagedCatchup, type SubscribeForCatchup } from "./catchup";
import { MessageIngestionPipeline, type DecodeMessage } from "./ingestion";
import { calculateCatchupSince } from "./sorting";
import type { MessageSource, MessageSyncOptions, SubscriptionLike, SyncStatus } from "./types";

type ManagerDependencies = {
  repository?: SyncedMessageRepository;
  subscribe?: SubscribeForCatchup;
  observeRelays?: (listener: (event: RelayConnectionEvent) => void) => () => void;
  decode?: DecodeMessage;
  now?: () => number;
};

function legacyToCanonical(item: Record<string, any>, accountPubkey: string): CanonicalMessage | null {
  if (!item?.id || !item?.pubkey || typeof item.created_at !== "number") return null;
  return {
    id: item.rumorId || item.id,
    senderPubkey: String(item.pubkey).toLowerCase(),
    recipientPubkeys: Array.isArray(item.recipientPubkeys) ? item.recipientPubkeys : [accountPubkey],
    conversationId: item.conversationId || [accountPubkey, String(item.pubkey).toLowerCase()].sort().join(":"),
    plaintext: typeof item.content === "string" ? item.content : undefined,
    createdAt: item.created_at,
    protocol: item.protocol || "legacy-8964",
    transportKind: item.transportKind || 8964,
    transportEventId: item.transportEventId || item.id,
    rumorId: item.rumorId,
    replyTo: item.replyTo,
    rootId: item.rootId,
    tags: []
  };
}

export class MessageSyncManager {
  private readonly repository: SyncedMessageRepository;
  private readonly subscribeFn: SubscribeForCatchup;
  private readonly observeRelays: (listener: (event: RelayConnectionEvent) => void) => () => void;
  private readonly decode?: DecodeMessage;
  private readonly now: () => number;
  private options: MessageSyncOptions | null = null;
  private realtimeSubscription: SubscriptionLike | null = null;
  private removeRelayObserver: (() => void) | null = null;
  private pipeline: MessageIngestionPipeline | null = null;
  private sessionId = "";
  private catchupRunning = false;
  private catchupSessionId = "";
  private catchupPending: MessageSource | null = null;
  private foregroundHandler: (() => void) | null = null;
  private connectedRelays = new Set<string>();
  private activeCatchupSubscriptions = new Set<SubscriptionLike>();
  private abortController: AbortController | null = null;

  constructor(dependencies: ManagerDependencies = {}) {
    this.repository = dependencies.repository || syncedMessageRepository;
    this.subscribeFn = dependencies.subscribe || subscribe;
    this.observeRelays = dependencies.observeRelays || onRelayConnectionState;
    this.decode = dependencies.decode;
    this.now = dependencies.now || Date.now;
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
      this.decode
    );

    await this.setStatus("connecting", sessionId);
    for (const item of options.legacyMessages || []) {
      if (!isCurrent()) return;
      const message = legacyToCanonical(item, accountPubkey);
      if (message) await this.pipeline.ingestCanonicalMessage(message, { source: "local-migration" });
    }
    const localMessages = await this.repository.list(accountPubkey);
    for (const record of localMessages) {
      if (!isCurrent()) return;
      if (options.legacyReadThrough) {
        await this.repository.seedReadState(accountPubkey, record.conversationId, options.legacyReadThrough);
      }
      await options.onMessage?.({
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
      }, { source: "local-migration" });
    }
    if (!isCurrent()) return;

    const state = await this.repository.getSyncState(accountPubkey);
    const nowSeconds = Math.floor(this.now() / 1000);
    const since = calculateCatchupSince(state.highWatermarkCreatedAt, nowSeconds);
    const filters = buildMessageSubscriptions(accountPubkey, options.authors, since);

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
      if (event.connected && event.reconnected) {
        void this.repository.updateSyncState(accountPubkey, { lastRealtimeConnectedAt: event.at });
        void this.resume("reconnect", event.url);
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
        const since = calculateCatchupSince(state.highWatermarkCreatedAt, nowSeconds);
        const relays = relayUrl ? [relayUrl] : options.relays;
        const filters = buildMessageSubscriptions(options.accountPubkey, options.authors, since, nowSeconds)
          .map(filter => ({ ...filter, limit: 500 }));
        logger.debug(`[message-sync] account=${options.accountPubkey.slice(0, 8)} session=${sessionId} phase=${activeSource} since=${since} until=${nowSeconds}`);
        const result = await runPagedCatchup({
          relays,
          filters,
          subscribeFn: this.subscribeFn,
          trackSubscription: subscription => {
            this.activeCatchupSubscriptions.add(subscription);
            return () => this.activeCatchupSubscriptions.delete(subscription);
          },
          signal: this.abortController?.signal,
          isCurrent: () => this.isCurrent(sessionId, options.accountPubkey),
          onEvent: async (event, eventRelay) => {
            await this.pipeline?.ingestNostrEvent(event, { source: activeSource!, relayUrl: eventRelay });
          }
        });
        if (!this.isCurrent(sessionId, options.accountPubkey)) return;
        const completedAt = this.now();
        await this.repository.updateSyncState(options.accountPubkey, {
          lastSuccessfulSyncAt: completedAt,
          lastCatchupCompletedAt: completedAt
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
    if (typeof window === "undefined" || typeof document === "undefined") return;
    this.foregroundHandler = () => {
      if (document.visibilityState === "hidden") return;
      void this.resume("resume");
    };
    document.addEventListener("visibilitychange", this.foregroundHandler);
    window.addEventListener("focus", this.foregroundHandler);
    window.addEventListener("pageshow", this.foregroundHandler);
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
    if (this.foregroundHandler && typeof window !== "undefined" && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.foregroundHandler);
      window.removeEventListener("focus", this.foregroundHandler);
      window.removeEventListener("pageshow", this.foregroundHandler);
    }
    this.foregroundHandler = null;
    this.connectedRelays.clear();
    this.catchupRunning = false;
    this.catchupSessionId = "";
    this.catchupPending = null;
    this.options = null;
    this.pipeline = null;
  }
}
