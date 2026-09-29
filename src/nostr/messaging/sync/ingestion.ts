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

export class MessageIngestionPipeline {
  private readonly deliveredLogicalIds = new Set<string>();
  private readonly discardedLogicalIds = new Set<string>();
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
    if (this.deliveredLogicalIds.has(`transport:${eventId}`)) {
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
    this.deliveredLogicalIds.add(`transport:${eventId}`);
    debugLog("sync", "decode_success", {
      ...diagnostic,
      logicalMessageId: message.id.slice(0, 12),
      sender: message.senderPubkey.slice(0, 12)
    });
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: false, discarded: true, deferred: false };
    }
    return this.ingestCanonicalMessage(message, metadata);
  }

  async ingestCanonicalMessage(message: CanonicalMessage, metadata: MessageIngestionMetadata) {
    const logicalKey = message.rumorId || message.id;
    const logicalToken = `logical:${logicalKey}`;

    if (this.discardedLogicalIds.has(logicalToken)) {
      await this.repository.clearDeferredAuthorizationMessage(this.accountPubkey, message.id).catch(() => {});
      performanceCounters.duplicateEventsDropped++;
      return { inserted: false, discarded: true, deferred: false };
    }

    if (this.deliveredLogicalIds.has(logicalToken)) {
      performanceCounters.duplicateEventsDropped++;
      const result = await this.repository.enqueueMessage(this.accountPubkey, message);
      await this.repository.clearDeferredAuthorizationMessage(this.accountPubkey, message.id).catch(() => {});
      return { inserted: result.inserted, discarded: false, deferred: false };
    }

    return this.processCanonicalMessage(message, metadata, logicalToken);
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
      debugLog("sync", "authorization_deferred", diagnostic, "info");
      return { inserted: false, discarded: false, deferred: true };
    }

    if (delivery === "discard") {
      this.discardedLogicalIds.add(logicalToken);
      await this.repository.clearDeferredAuthorizationMessage(this.accountPubkey, message.id);
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

    let result: Awaited<ReturnType<SyncedMessageRepository["insertMessageIfAbsent"]>>;
    try {
      result = await this.repository.enqueueMessage(this.accountPubkey, message);
    } catch (error) {
      debugLog("storage", "storage_failed", {
        ...diagnostic,
        reason: error instanceof Error ? error.name || "Error" : "storage_error"
      }, "error");
      throw error;
    }

    this.deliveredLogicalIds.add(logicalToken);
    await this.repository.clearDeferredAuthorizationMessage(this.accountPubkey, message.id);
    debugLog("storage", result.inserted ? "storage_inserted" : "storage_duplicate", {
      ...diagnostic,
      inserted: result.inserted
    }, result.inserted ? "info" : "debug");

    // A stale operation may safely finish writing to A's account namespace, but
    // it must never update B's in-memory state or produce arrival side effects.
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
          reason: error instanceof Error ? error.name || "Error" : "unknown_error"
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
