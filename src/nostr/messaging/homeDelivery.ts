import type { CanonicalMessage } from "./protocol";
import type { MessageIngestionMetadata } from "./sync/types";
import { debugLog } from "@/utils/debugLog";

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
      debugLog("ui", "ui_stale_account_discarded", diagnostic, "warn");
      return;
    }
    if (delivery.isInteraction(message)) {
      try {
        await delivery.processInteraction(message);
        debugLog("ui", "ui_interaction_routed", diagnostic);
      } catch (error) {
        debugLog("ui", "ui_interaction_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name : "interaction_error"
        }, "error");
        throw error;
      }
      return;
    }
    try {
      delivery.mirrorMessage(message);
      debugLog("ui", "ui_message_mirrored", diagnostic, "info");
    } catch (error) {
      debugLog("ui", "ui_mirror_failed", {
        ...diagnostic,
        reason: error instanceof Error ? error.name : "ui_mirror_error"
      }, "error");
      throw error;
    }
    if (message.senderPubkey !== delivery.accountPubkey && metadata.source !== "local-migration") {
      try {
        delivery.notifyMessage(message);
        debugLog("ui", "ui_notification_created", diagnostic, "info");
      } catch (error) {
        debugLog("ui", "ui_notification_failed", {
          ...diagnostic,
          reason: error instanceof Error ? error.name : "notification_error"
        }, "error");
        throw error;
      }
    }
  };
}
