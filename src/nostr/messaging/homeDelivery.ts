import type { CanonicalMessage } from "./protocol";
import type { MessageIngestionMetadata } from "./sync/types";
import { debugLog } from "@/utils/debugLog";
import { decodeFriendshipControl, isFriendshipControlMessage } from "@/nostr/messaging/friendshipControl";
import { isHaiNeiProfileMessage } from "@/nostr/messaging/privateProfile";
import type { NotificationItem } from "@/stores/notifications";

export function incomingFriendRequestNotification(message: CanonicalMessage, accountPubkey: string): NotificationItem | null {
  const control = decodeFriendshipControl(message);
  if (control?.action !== "request" || message.senderPubkey === accountPubkey) return null;
  return {
    id: `friend-request:${message.id}`,
    type: "friend_request",
    from: message.senderPubkey,
    messageId: message.id,
    created_at: control.timestamp,
    read: false,
  };
}

export type HomeMessageDelivery = {
  accountPubkey: string;
  currentAccount: () => string;
  isAcceptedMessage?: (message: CanonicalMessage) => boolean;
  processFriendshipMessage?: (message: CanonicalMessage) => boolean | Promise<boolean>;
  notifyFriendshipMessage?: (message: CanonicalMessage) => void;
  processProfileMessage?: (message: CanonicalMessage) => boolean | Promise<boolean>;
  isInteraction: (message: CanonicalMessage) => boolean;
  processInteraction: (message: CanonicalMessage) => void | Promise<void>;
  mirrorMessage: (message: CanonicalMessage) => void;
};

/**
 * Bridges durable sync into the Home UI after friendship authorization.
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
      return false;
    }
    if (isFriendshipControlMessage(message)) {
      await delivery.processFriendshipMessage?.(message);
      delivery.notifyFriendshipMessage?.(message);
      debugLog("ui", "ui_friendship_control_routed", diagnostic, "info");
      return false;
    }
    if (isHaiNeiProfileMessage(message)) {
      await delivery.processProfileMessage?.(message);
      debugLog("ui", "ui_private_profile_routed", diagnostic, "info");
      return false;
    }
    if (delivery.isAcceptedMessage && !delivery.isAcceptedMessage(message)) {
      debugLog("ui", "ui_non_friend_discarded", diagnostic, "info");
      return false;
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
      return true;
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
    return true;
  };
}
