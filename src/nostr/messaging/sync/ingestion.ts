import type { NostrEvent } from "nostr-tools";
import { decodeMessageEvent, type CanonicalMessage, type DecodeContext } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { debugLog } from "@/utils/debugLog";
import type { MessageIngestionMetadata } from "./types";
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

export class MessageIngestionPipeline {
  private readonly deliveredLogicalIds = new Set<string>();

  constructor(
    private readonly accountPubkey: string,
    private readonly decodeContext: DecodeContext,
    private readonly isSessionCurrent: () => boolean,
    private readonly onInserted?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => boolean | void | Promise<boolean | void>,
    private readonly repository: SyncedMessageRepository = syncedMessageRepository,
    private readonly decode: DecodeMessage = decodeMessageEvent
  ) {}

  async ingestNostrEvent(event: NostrEvent, metadata: MessageIngestionMetadata) {
    const diagnostic = eventContext(event, metadata);
    debugLog("sync", "ingestion_received", diagnostic);
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: false, discarded: true };
    }
    const eventId = event?.id || (event as NostrEvent & { canonical?: CanonicalMessage }).canonical?.transportEventId;
    if (!eventId) return { inserted: false, discarded: false };
    rememberSeenOn(eventId, metadata.relayUrl);
    const cacheKey = scopedKey(this.accountPubkey, eventId);
    if (this.deliveredLogicalIds.has(`transport:${eventId}`)) {
      performanceCounters.duplicateEventsDropped++;
      return { inserted: false, discarded: false };
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
          return { inserted: false, discarded: true };
        }
        decryptedEventCache.set(cacheKey, message);
        if (message) void this.repository.putDecryptedEvent(this.accountPubkey, eventId, message).catch(() => {});
      }
    } catch (e) {
      debugLog("sync", "decode_null", {
        ...diagnostic,
        reason: e instanceof Error ? e.name || "Error" : "unknown_error"
      }, "warn");
      return { inserted: false, discarded: false };
    }
    if (!message) {
      debugLog("sync", "decode_null", diagnostic);
      return { inserted: false, discarded: false };
    }
    this.deliveredLogicalIds.add(`transport:${eventId}`);
    debugLog("sync", "decode_success", {
      ...diagnostic,
      logicalMessageId: message.id.slice(0, 12),
      sender: message.senderPubkey.slice(0, 12)
    });
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: false, discarded: true };
    }
    return this.ingestCanonicalMessage(message, metadata);
  }

  async ingestCanonicalMessage(message: CanonicalMessage, metadata: MessageIngestionMetadata) {
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
      return { inserted: false, discarded: true };
    }
    const logicalKey = message.rumorId || message.id;
    if (this.deliveredLogicalIds.has(`logical:${logicalKey}`)) {
      performanceCounters.duplicateEventsDropped++;
      const result = await this.repository.enqueueMessage(this.accountPubkey, message);
      return { inserted: result.inserted, discarded: false };
    }
    this.deliveredLogicalIds.add(`logical:${logicalKey}`);

    // Update the reactive store before touching IndexedDB. Store-level idempotence
    // handles a message that was already restored from local history.
    const uiUpdate = this.onInserted ? (async () => {
      try {
        const delivered = await this.onInserted!(message, metadata);
        debugLog("sync", "on_message_invoked", diagnostic);
        return delivered;
      } catch (error) {
        debugLog("sync", "on_message_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "unknown_error"
        }, "warn");
        return false;
      }
    })() : Promise.resolve(undefined);
    const delivered = await uiUpdate;
    if (delivered === false) {
      try {
        await this.repository.advanceHighWatermark(this.accountPubkey, message.createdAt);
      } catch (error) {
        debugLog("storage", "storage_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "watermark_error"
        }, "warn");
      }
      return { inserted: false, discarded: true };
    }
    const persistence = this.repository.enqueueMessage(this.accountPubkey, message);
    let result: Awaited<ReturnType<SyncedMessageRepository["insertMessageIfAbsent"]>>;
    try {
      result = await persistence;
    } catch (error) {
      debugLog("storage", "storage_failed", {
        ...diagnostic,
        reason: error instanceof Error ? error.name || "Error" : "storage_error"
      }, "error");
      throw error;
    }
    debugLog("storage", result.inserted ? "storage_inserted" : "storage_duplicate", {
      ...diagnostic,
      inserted: result.inserted
    }, result.inserted ? "info" : "debug");
    // A stale operation may safely finish writing to A's account namespace, but
    // it must never update B's in-memory state or produce arrival side effects.
    if (!this.isSessionCurrent()) {
      debugLog("sync", "stale_session_discarded", diagnostic, "warn");
      return { inserted: result.inserted, discarded: true };
    }
    return { inserted: result.inserted, discarded: false };
  }
}
