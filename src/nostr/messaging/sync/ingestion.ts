import type { NostrEvent } from "nostr-tools";
import { decodeMessageEvent, type CanonicalMessage, type DecodeContext } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { debugLog } from "@/utils/debugLog";
import type { MessageDeliveryResult, MessageIngestionMetadata } from "./types";
import {
  decryptedEventCache,
  dedupeRequest,
  eventCache,
  performanceCounters,
  rememberSeenOn,
  scopedKey
} from "@/services/nostrCache";

export type DecodeMessage = (event: NostrEvent, context: DecodeContext) => Promise<CanonicalMessage | null>;

function eventContext(event: NostrEvent, metadata: MessageIngestionMetadata) {
  return {
    eventId: event.id?.slice(0, 12) || "unknown",
    kind: event.kind,
    source: metadata.source,
    relayUrl: metadata.relayUrl || "local"
  };
}

function normalizeDeliveryResult(result: MessageDeliveryResult): "persist" | "discard" | "defer" {
  if (result === "defer") return "defer";
  if (result === false) return "discard";
  return "persist";
}

const MAX_PENDING_PERSISTENCE_RETRIES = 64;
const MAX_PERSISTENCE_RETRY_ATTEMPTS = 3;
const PERSISTENCE_RETRY_DELAY_MS = 500;

export class MessageIngestionPipeline {
  private readonly deliveredLogicalIds = new Set<string>();
  private readonly discardedLogicalIds = new Set<string>();
  private readonly finalizedTransportIds = new Set<string>();
  private readonly logicalFlights = new Map<string, Promise<{ inserted: boolean; discarded: boolean; deferred: boolean }>>();
  private readonly pendingPersistenceRetries = new Map<string, {
    message: CanonicalMessage;
    metadata: MessageIngestionMetadata;
    attempts: number;
  }>();
  private persistenceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDeferredFlight: Promise<number> | null = null;

  constructor(
    private readonly accountPubkey: string,
    private readonly decodeContext: DecodeContext,
    private readonly isSessionCurrent: () => boolean,
    private readonly onInserted?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => MessageDeliveryResult | Promise<MessageDeliveryResult>,
    private readonly repository: SyncedMessageRepository = syncedMessageRepository,
    private readonly decode: DecodeMessage = decodeMessageEvent,
    private readonly onPersisted?: (message: CanonicalMessage, metadata: MessageIngestionMetadata, inserted: boolean) => void | Promise<void>
  ) {}

  private async clearDeferredBestEffort(messageId: string, diagnostic?: Record<string, unknown>) {
    try {
      await this.repository.clearDeferredAuthorizationMessage(this.accountPubkey, messageId);
    } catch (error) {
      debugLog("storage", "deferred_cleanup_failed", {
        account: this.accountPubkey.slice(0, 12),
        logicalMessageId: messageId.slice(0, 12),
        ...(diagnostic || {}),
        reason: error instanceof Error ? error.name || "Error" : "storage_error",
      }, "warn");
    }
  }

  private finalizeTransport(message: CanonicalMessage, transportEventId?: string) {
    const id = transportEventId || message.transportEventId;
    if (id) this.finalizedTransportIds.add(id);
  }

  private queuePersistenceRetry(logicalToken: string, message: CanonicalMessage, metadata: MessageIngestionMetadata) {
    if (!this.isSessionCurrent() || this.pendingPersistenceRetries.has(logicalToken)) return;
    if (this.pendingPersistenceRetries.size >= MAX_PENDING_PERSISTENCE_RETRIES) {
      debugLog("storage", "persistence_retry_queue_full", {
        account: this.accountPubkey.slice(0, 12),
        logicalMessageId: message.id.slice(0, 12),
        queued: this.pendingPersistenceRetries.size,
      }, "warn");
      return;
    }
    this.pendingPersistenceRetries.set(logicalToken, { message, metadata, attempts: 0 });
    this.schedulePersistenceRetry();
  }

  private schedulePersistenceRetry() {
    if (this.persistenceRetryTimer || !this.pendingPersistenceRetries.size || !this.isSessionCurrent()) return;
    this.persistenceRetryTimer = setTimeout(() => {
      this.persistenceRetryTimer = null;
      void this.flushPersistenceRetries();
    }, PERSISTENCE_RETRY_DELAY_MS);
    (this.persistenceRetryTimer as any).unref?.();
  }

  private async flushPersistenceRetries() {
    if (!this.isSessionCurrent()) {
      this.pendingPersistenceRetries.clear();
      return;
    }
    for (const [logicalToken, pending] of [...this.pendingPersistenceRetries.entries()].slice(0, 8)) {
      if (!this.isSessionCurrent()) break;
      if (this.logicalFlights.has(logicalToken)) continue;
      pending.attempts += 1;
      const flight = this.persistAuthorizedMessage(pending.message, pending.metadata, logicalToken, false)
        .finally(() => {
          if (this.logicalFlights.get(logicalToken) === flight) this.logicalFlights.delete(logicalToken);
        });
      this.logicalFlights.set(logicalToken, flight);
      try {
        await flight;
        this.pendingPersistenceRetries.delete(logicalToken);
      } catch (error) {
        if (pending.attempts >= MAX_PERSISTENCE_RETRY_ATTEMPTS) {
          this.pendingPersistenceRetries.delete(logicalToken);
          debugLog("storage", "persistence_retry_exhausted", {
            account: this.accountPubkey.slice(0, 12),
            logicalMessageId: pending.message.id.slice(0, 12),
            attempts: pending.attempts,
            reason: error instanceof Error ? error.name || "Error" : "storage_error",
          }, "error");
        }
      }
    }
    if (this.pendingPersistenceRetries.size) this.schedulePersistenceRetry();
  }

  async ingestNostrEvent(event: NostrEvent, metadata: MessageIngestionMetadata) {
    const diagnostic = eventContext(event, metadata);
    debugLog("sync", "ingestion_received", diagnostic);
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: false, discarded: true, deferred: false };
    }
    const eventId = event?.id || (event as NostrEvent & { canonical?: CanonicalMessage }).canonical?.transportEventId;
    if (!eventId) return { inserted: false, discarded: false, deferred: false };
    rememberSeenOn(eventId, metadata.relayUrl);
    const cacheKey = scopedKey(this.accountPubkey, eventId);
    if (this.finalizedTransportIds.has(eventId)) {
      performanceCounters.duplicateEventsDropped++;
      return { inserted: false, discarded: false, deferred: false };
    }

    let message: CanonicalMessage | null | undefined = decryptedEventCache.get(cacheKey);
    if (message !== undefined) performanceCounters.decryptCacheHit++;
    try {
      if (message === undefined) {
        performanceCounters.decryptCacheMiss++;
        message = await dedupeRequest(`decrypt:${cacheKey}`, async () => {
          const persisted = await this.repository.getDecryptedEvent(this.accountPubkey, eventId);
          if (persisted) return persisted;
          eventCache.set(eventId, event);
          return this.decode(event, this.decodeContext);
        });
        if (!this.isSessionCurrent()) {
          debugLog("sync", "stale_session_discarded", diagnostic, "warn");
          return { inserted: false, discarded: true, deferred: false };
        }
        decryptedEventCache.set(cacheKey, message);
        if (message) void this.repository.putDecryptedEvent(this.accountPubkey, eventId, message).catch(() => {});
      }
    } catch (e) {
      debugLog("sync", "decode_null", {
        ...diagnostic,
        reason: e instanceof Error ? e.name || "Error" : "unknown_error"
      }, "warn");
      return { inserted: false, discarded: false, deferred: false };
    }
    if (!message) {
      debugLog("sync", "decode_null", diagnostic);
      return { inserted: false, discarded: false, deferred: false };
    }
    debugLog("sync", "decode_success", {
      ...diagnostic,
      logicalMessageId: message.id.slice(0, 12),
      sender: message.senderPubkey.slice(0, 12)
    });
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: false, discarded: true, deferred: false };
    }
    const result = await this.ingestCanonicalMessage(message, metadata);
    if (this.isSessionCurrent()) this.finalizeTransport(message, eventId);
    return result;
  }

  async ingestCanonicalMessage(message: CanonicalMessage, metadata: MessageIngestionMetadata) {
    const logicalKey = message.rumorId || message.id;
    const logicalToken = `logical:${logicalKey}`;

    const pendingPersistence = this.pendingPersistenceRetries.get(logicalToken);
    if (pendingPersistence) {
      const existingFlight = this.logicalFlights.get(logicalToken);
      if (existingFlight) return existingFlight;
      const retryFlight = this.persistAuthorizedMessage(message, metadata, logicalToken, true)
        .finally(() => {
          if (this.logicalFlights.get(logicalToken) === retryFlight) this.logicalFlights.delete(logicalToken);
        });
      this.logicalFlights.set(logicalToken, retryFlight);
      return retryFlight;
    }

    if (this.discardedLogicalIds.has(logicalToken)) {
      await this.clearDeferredBestEffort(message.id);
      performanceCounters.duplicateEventsDropped++;
      return { inserted: false, discarded: true, deferred: false };
    }

    if (this.deliveredLogicalIds.has(logicalToken)) {
      performanceCounters.duplicateEventsDropped++;
      const result = await this.repository.enqueueMessage(this.accountPubkey, message);
      await this.clearDeferredBestEffort(message.id);
      return { inserted: result.inserted, discarded: false, deferred: false };
    }

    const existingFlight = this.logicalFlights.get(logicalToken);
    if (existingFlight) {
      performanceCounters.duplicateEventsDropped++;
      const settled = await existingFlight;
      if (settled.deferred || settled.discarded) return settled;
      const merged = await this.repository.enqueueMessage(this.accountPubkey, message);
      return { inserted: merged.inserted, discarded: false, deferred: false };
    }

    const flight = this.processCanonicalMessage(message, metadata, logicalToken)
      .finally(() => {
        if (this.logicalFlights.get(logicalToken) === flight) this.logicalFlights.delete(logicalToken);
      });
    this.logicalFlights.set(logicalToken, flight);
    return flight;
  }

  private async processCanonicalMessage(
    message: CanonicalMessage,
    metadata: MessageIngestionMetadata,
    logicalToken: string,
  ) {
    const diagnostic = {
      logicalMessageId: message.id.slice(0, 12),
      transportEventId: message.transportEventId?.slice(0, 12) || "unknown",
      sender: message.senderPubkey.slice(0, 12),
      account: this.accountPubkey.slice(0, 12),
      source: metadata.source,
      relayUrl: metadata.relayUrl || "local"
    };
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: false, discarded: true, deferred: false };
    }

    const uiUpdate = this.onInserted ? (async () => {
      try {
        const delivered = await this.onInserted!(message, metadata);
        debugLog("sync", "on_message_invoked", diagnostic);
        return delivered;
      } catch (error) {
        // A handler failure is not proof that the message is unauthorized.
        // Keep it in the durable deferred queue so a later state repair can retry.
        debugLog("sync", "on_message_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "unknown_error"
        }, "warn");
        return "defer" as const;
      }
    })() : Promise.resolve(undefined);

    const delivery = normalizeDeliveryResult(await uiUpdate);

    if (delivery === "defer") {
      await this.repository.deferAuthorizationMessage(this.accountPubkey, message, metadata);
      this.finalizeTransport(message);
      debugLog("sync", "authorization_deferred", diagnostic, "info");
      return { inserted: false, discarded: false, deferred: true };
    }

    if (delivery === "discard") {
      this.discardedLogicalIds.add(logicalToken);
      this.pendingPersistenceRetries.delete(logicalToken);
      this.finalizeTransport(message);
      await this.clearDeferredBestEffort(message.id, diagnostic);
      try {
        await this.repository.advanceHighWatermark(this.accountPubkey, message.createdAt);
      } catch (error) {
        debugLog("storage", "storage_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "watermark_error"
        }, "warn");
      }
      return { inserted: false, discarded: true, deferred: false };
    }

    return this.persistAuthorizedMessage(message, metadata, logicalToken, true, diagnostic);
  }

  private async persistAuthorizedMessage(
    message: CanonicalMessage,
    metadata: MessageIngestionMetadata,
    logicalToken: string,
    queueOnFailure: boolean,
    diagnosticOverride?: Record<string, unknown>,
  ) {
    const diagnostic = diagnosticOverride || {
      logicalMessageId: message.id.slice(0, 12),
      transportEventId: message.transportEventId?.slice(0, 12) || "unknown",
      sender: message.senderPubkey.slice(0, 12),
      account: this.accountPubkey.slice(0, 12),
      source: metadata.source,
      relayUrl: metadata.relayUrl || "local",
    };
    let result: Awaited<ReturnType<SyncedMessageRepository["insertMessageIfAbsent"]>>;
    try {
      result = await this.repository.enqueueMessage(this.accountPubkey, message);
    } catch (error) {
      if (queueOnFailure) this.queuePersistenceRetry(logicalToken, message, metadata);
      debugLog("storage", "storage_failed", {
        ...diagnostic,
        retryQueued: queueOnFailure && this.pendingPersistenceRetries.has(logicalToken),
        reason: error instanceof Error ? error.name || "Error" : "storage_error",
      }, "error");
      throw error;
    }

    this.pendingPersistenceRetries.delete(logicalToken);
    this.deliveredLogicalIds.add(logicalToken);
    this.finalizeTransport(message);
    await this.clearDeferredBestEffort(message.id, diagnostic);
    debugLog("storage", result.inserted ? "storage_inserted" : "storage_duplicate", {
      ...diagnostic,
      inserted: result.inserted,
    }, result.inserted ? "info" : "debug");

    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: result.inserted, discarded: true, deferred: false };
    }
    if (this.onPersisted) {
      try {
        await this.onPersisted(message, metadata, result.inserted);
      } catch (error) {
        debugLog("sync", "post_persist_side_effect_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "unknown_error",
        }, "warn");
      }
    }
    return { inserted: result.inserted, discarded: false, deferred: false };
  }

  retryDeferredAuthorization() {
    if (this.retryDeferredFlight) return this.retryDeferredFlight;
    const run = (async () => {
      const records = await this.repository.listDeferredAuthorizationMessages(this.accountPubkey);
      let finalized = 0;
      for (const record of records) {
        if (!this.isSessionCurrent()) break;
        const message = record.message as CanonicalMessage;
        if (!message?.id || message.id !== record.id) {
          await this.repository.clearDeferredAuthorizationMessage(this.accountPubkey, record.id);
          continue;
        }
        const metadata = {
          source: record.metadata.source as MessageIngestionMetadata["source"],
          ...(record.metadata.relayUrl ? { relayUrl: record.metadata.relayUrl } : {}),
        } satisfies MessageIngestionMetadata;
        const result = await this.ingestCanonicalMessage(message, metadata);
        if (!result.deferred) finalized++;
      }
      return finalized;
    })().finally(() => {
      if (this.retryDeferredFlight === run) this.retryDeferredFlight = null;
    });
    this.retryDeferredFlight = run;
    return run;
  }
}
