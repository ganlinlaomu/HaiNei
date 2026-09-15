import type { NostrEvent } from "nostr-tools";
import { decodeMessageEvent, type CanonicalMessage, type DecodeContext } from "@/nostr/messaging/protocol";
import { syncedMessageRepository, type SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { logger } from "@/utils/logger";
import type { MessageIngestionMetadata } from "./types";

export type DecodeMessage = (event: NostrEvent, context: DecodeContext) => Promise<CanonicalMessage | null>;

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
    if (!this.isSessionCurrent()) return { inserted: false, discarded: true };
    let message: CanonicalMessage | null = null;
    try {
      message = await this.decode(event, this.decodeContext);
    } catch (e) {
      logger.warn(`[message-sync] decode failed event=${event.id?.slice(0, 8) || "unknown"}`, e);
      return { inserted: false, discarded: false };
    }
    if (!message || !this.isSessionCurrent()) return { inserted: false, discarded: true };
    return this.ingestCanonicalMessage(message, metadata);
  }

  async ingestCanonicalMessage(message: CanonicalMessage, metadata: MessageIngestionMetadata) {
    if (!this.isSessionCurrent()) return { inserted: false, discarded: true };
    const result = await this.repository.insertMessageIfAbsent(this.accountPubkey, message);
    // A stale operation may safely finish writing to A's account namespace, but
    // it must never update B's in-memory state or produce arrival side effects.
    if (!this.isSessionCurrent()) {
      logger.debug(`[message-sync] stale callback discarded account=${this.accountPubkey.slice(0, 8)} event=${message.id.slice(0, 8)}`);
      return { inserted: result.inserted, discarded: true };
    }
    if (result.inserted) await this.onInserted?.(message, metadata);
    logger.debug(
      `[message-sync] account=${this.accountPubkey.slice(0, 8)} source=${metadata.source}` +
      ` relay=${metadata.relayUrl || "local"} event=${message.id.slice(0, 8)} inserted=${result.inserted}`
    );
    return { inserted: result.inserted, discarded: false };
  }
}
