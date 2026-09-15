import type { CanonicalMessage } from "./protocol";
import type { MessageIngestionMetadata } from "./sync/types";
import { logger } from "@/utils/logger";

export type HomeMessageDelivery = {
  accountPubkey: string;
  currentAccount: () => string;
  isInteraction: (message: CanonicalMessage) => boolean;
  processInteraction: (message: CanonicalMessage) => void | Promise<void>;
  mirrorMessage: (message: CanonicalMessage) => void;
  notifyMessage: (message: CanonicalMessage) => void;
};

/**
 * Bridges durable sync into the Home UI. Decryption and recipient validation
 * are the authorization boundary; friend-list membership is intentionally not
 * an input to this delivery path.
 */
export function createHomeMessageHandler(delivery: HomeMessageDelivery) {
  return async (message: CanonicalMessage, metadata: MessageIngestionMetadata) => {
    const diagnostic = {
      logicalMessageId: message.id.slice(0, 12),
      sender: message.senderPubkey.slice(0, 12),
      account: delivery.accountPubkey.slice(0, 12),
      source: metadata.source
    };
    if (delivery.currentAccount() !== delivery.accountPubkey) {
      logger.debug("[message-sync] ui_discarded_stale_account", diagnostic);
      return;
    }
    if (delivery.isInteraction(message)) {
      await delivery.processInteraction(message);
      logger.debug("[message-sync] interaction_routed", diagnostic);
      return;
    }
    delivery.mirrorMessage(message);
    logger.debug("[message-sync] ui_mirrored", diagnostic);
    if (message.senderPubkey !== delivery.accountPubkey && metadata.source !== "local-migration") {
      delivery.notifyMessage(message);
      logger.debug("[message-sync] notification_created", diagnostic);
    }
  };
}
