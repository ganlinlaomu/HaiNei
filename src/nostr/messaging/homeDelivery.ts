import type { CanonicalMessage } from "./protocol";
import type { MessageAuthorizationDecision, MessageIngestionMetadata } from "./sync/types";
import { debugLog } from "@/utils/debugLog";
import { decodeFriendshipControl, isFriendshipControlMessage } from "@/nostr/messaging/friendshipControl";
import { isHaiNeiProfileMessage, isHaiNeiProfileRequest } from "@/nostr/messaging/privateProfile";
import type { NotificationItem } from "@/stores/notifications";
import { isTombstoneMessage } from "@/nostr/messaging/feedControl";

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
  isAuthorizationReady?: () => boolean;
  isAcceptedMessage?: (message: CanonicalMessage) => MessageAuthorizationDecision | boolean;
  processFriendshipMessage?: (message: CanonicalMessage) => boolean | Promise<boolean>;
  notifyFriendshipMessage?: (message: CanonicalMessage) => void;
  processProfileMessage?: (message: CanonicalMessage) => boolean | Promise<boolean>;
  processFeedControlMessage?: (message: CanonicalMessage) => boolean | Promise<boolean>;
  isReceipt?: (message: CanonicalMessage) => boolean;
  processReceipt?: (message: CanonicalMessage) => boolean | void | Promise<boolean | void>;
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
      debugLog("ui", "ui_stale_account_deferred", diagnostic, "warn");
      return "defer" as const;
    }
    if (isFriendshipControlMessage(message)) {
      const changed = await delivery.processFriendshipMessage?.(message);
      if (changed) delivery.notifyFriendshipMessage?.(message);
      debugLog("ui", "ui_friendship_control_routed", diagnostic, "info");
      return false;
    }

    // Friendship controls are allowed to bootstrap authorization. Every other
    // private payload must wait until this account's friendship snapshot is
    // actually loaded; an empty/not-yet-loaded store is not a rejection.
    if (delivery.isAuthorizationReady && !delivery.isAuthorizationReady()) {
      debugLog("ui", "ui_authorization_unresolved", diagnostic, "info");
      return "defer" as const;
    }

    const authorization = delivery.isAcceptedMessage?.(message);
    if (authorization === "unresolved") {
      debugLog("ui", "ui_authorization_unresolved", diagnostic, "info");
      return "defer" as const;
    }
    if (authorization === "rejected" || authorization === false) {
      debugLog("ui", "ui_non_friend_discarded", diagnostic, "info");
      return false;
    }
    if (isHaiNeiProfileMessage(message)) {
      if (!(metadata.source === "local-migration" && isHaiNeiProfileRequest(message))) {
        await delivery.processProfileMessage?.(message);
      }
      debugLog("ui", "ui_private_profile_routed", diagnostic, "info");
      return false;
    }
    if (isTombstoneMessage(message)) {
      await delivery.processFeedControlMessage?.(message);
      debugLog("ui", "ui_feed_control_routed", diagnostic, "info");
      return false;
    }
    if (delivery.isReceipt?.(message)) {
      await delivery.processReceipt?.(message);
      debugLog("ui", "ui_dm_receipt_routed", diagnostic, "info");
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
