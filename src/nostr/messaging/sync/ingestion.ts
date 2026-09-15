import type { NostrEvent } from "nostr-tools";
import { decodeMessageEvent, type CanonicalMessage, type DecodeContext } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { debugLog } from "@/utils/debugLog";
import type { MessageIngestionMetadata } from "./types";

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
  constructor(
    private readonly accountPubkey: string,
    private readonly decodeContext: DecodeContext,
    private readonly isSessionCurrent: () => boolean,
    private readonly onInserted?: (message: CanonicalMessage, metadata: MessageIngestionMetadata) => void | Promise<void>,
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
    let message: CanonicalMessage | null = null;
    try {
      message = await this.decode(event, this.decodeContext);
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
    let result: Awaited<ReturnType<SyncedMessageRepository["insertMessageIfAbsent"]>>;
    try {
      result = await this.repository.insertMessageIfAbsent(this.accountPubkey, message);
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
    if (result.inserted && this.onInserted) {
      try {
        await this.onInserted(message, metadata);
        debugLog("sync", "on_message_invoked", diagnostic);
      } catch (error) {
        debugLog("sync", "on_message_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "unknown_error"
        }, "warn");
      }
    }
    return { inserted: result.inserted, discarded: false };
  }
}
