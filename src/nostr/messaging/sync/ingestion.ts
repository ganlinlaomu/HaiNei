import type { NostrEvent } from "nostr-tools";
import { decodeMessageEvent, type CanonicalMessage, type DecodeContext } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { logger } from "@/utils/logger";
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
    logger.debug("[message-sync] relay_event_received", diagnostic);
    if (!this.isSessionCurrent()) {
      logger.debug("[message-sync] discarded_stale_session", diagnostic);
      return { inserted: false, discarded: true };
    }
    let message: CanonicalMessage | null = null;
    try {
      message = await this.decode(event, this.decodeContext);
    } catch (e) {
      logger.warn("[message-sync] decode_failed", {
        ...diagnostic,
        reason: e instanceof Error ? e.name || "Error" : "unknown_error"
      });
      return { inserted: false, discarded: false };
    }
    if (!message) {
      logger.debug("[message-sync] decode_null", diagnostic);
      return { inserted: false, discarded: false };
    }
    logger.debug("[message-sync] decode_succeeded", {
      ...diagnostic,
      logicalMessageId: message.id.slice(0, 12),
      sender: message.senderPubkey.slice(0, 12)
    });
    if (!this.isSessionCurrent()) {
      logger.debug("[message-sync] discarded_stale_session", diagnostic);
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
      logger.debug("[message-sync] discarded_stale_session", diagnostic);
      return { inserted: false, discarded: true };
    }
    const result = await this.repository.insertMessageIfAbsent(this.accountPubkey, message);
    logger.debug("[message-sync] persisted", { ...diagnostic, inserted: result.inserted });
    if (!result.inserted) logger.debug("[message-sync] duplicate", diagnostic);
    // A stale operation may safely finish writing to A's account namespace, but
    // it must never update B's in-memory state or produce arrival side effects.
    if (!this.isSessionCurrent()) {
      logger.debug("[message-sync] discarded_stale_session", diagnostic);
      return { inserted: result.inserted, discarded: true };
    }
    if (result.inserted && this.onInserted) {
      try {
        await this.onInserted(message, metadata);
        logger.debug("[message-sync] on_message_invoked", diagnostic);
      } catch (error) {
        logger.warn("[message-sync] on_message_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name || "Error" : "unknown_error"
        });
      }
    }
    return { inserted: result.inserted, discarded: false };
  }
}
