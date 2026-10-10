import { defineStore } from "pinia";
import { getRelaysFromStorage } from "@/nostr/relays";
import {
  onOutgoingQueueState,
  publishQueuedOutgoing,
  queueDirectMessage as queueMessage,
  sendDirectMessage,
  type PublishedMessage,
} from "@/nostr/messaging/service";
import { useKeyStore } from "@/stores/keys";
import { logger } from "@/utils/logger";
import { isExcludedPostRecipient } from "@/utils/friendAudience";
import { HAINEI_BOT_PUBKEY } from "@/utils/haineiBot";
import { mentionedPubkeysFromTags } from "@/utils/mentions";
import { useMessagesStore } from "@/stores/messages";
import { useFriendshipsStore } from "@/stores/friendships";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";

type PostPublishError = Error & { outgoingId?: string };

// Enforce the feed audience policy at the NIP-17 queue boundary as well as
// in the editor. This does not affect directMessages.ts or Bot private chats.
function permittedPostRecipients(
  recipients: string[], accountPubkey: string, plaintext: string, tags?: string[][]
): string[] {
  // The mention tag and visible @Bot token must agree before the Bot can
  // receive a complete encrypted post. A plain audience selection is not consent.
  const explicitBotMention = mentionedPubkeysFromTags(tags).includes(HAINEI_BOT_PUBKEY)
    && /(^|[^\\p{L}\\p{N}_])@Hainei Bot(?![\\p{L}\\p{N}_])/u.test(plaintext);
  return [...new Set(recipients
    .map(pubkey => String(pubkey || "").trim().toLowerCase())
    .filter(pubkey => pubkey
      && (pubkey === accountPubkey || !isExcludedPostRecipient(pubkey) || explicitBotMention)))];
}

let postDeliveryObserverInstalled = false;

function ensurePostDeliveryObserver() {
  if (postDeliveryObserverInstalled) return;
  postDeliveryObserverInstalled = true;
  onOutgoingQueueState(event => {
    const msgs = useMessagesStore();
    if (msgs.loadedFor.toLowerCase() !== event.accountPubkey.toLowerCase()) return;
    const state = event.state === "sent"
      ? "sent"
      : event.state === "failed"
        ? "send_failed"
        : "sending";
    msgs.setPostOutgoingState(event.outgoingId, state, event.lastError);
  });
}

function withOutgoingId(error: unknown, outgoingId: string): PostPublishError {
  const wrapped = new Error(error instanceof Error ? error.message : "发送失败") as PostPublishError;
  wrapped.outgoingId = outgoingId;
  return wrapped;
}

async function freezeFailedPost(accountPubkey: string, outgoingId: string, error: unknown) {
  await outgoingQueueRepository.update(accountPubkey, outgoingId, {
    state: "failed",
    nextAttemptAt: undefined,
    lastError: error instanceof Error ? error.message : "publish_failed",
    updatedAt: Date.now()
  });
}

async function savePublishedOutbox(accountAtStart: string, result: PublishedMessage) {
  const out = {
    id: result.message.id,
    created_at: result.message.createdAt,
    sent_at: Date.now(),
    content: result.message.plaintext || "",
    relayResults: result.relayResults
  };
  try {
    const msgs = useMessagesStore();
    if (msgs.loadedFor !== accountAtStart) await msgs.load(accountAtStart);
    if (useKeyStore().pkHex === accountAtStart) await msgs.addOutbox(out);
  } catch (e) {
    logger.warn("[message-protocol] saving outbox failed", e);
  }
}

export const usePostsStore = defineStore("posts", {
  state: () => ({}),
  actions: {
    startPostDeliveryTracking() {
      ensurePostDeliveryObserver();
    },

    async queuePost(recipients: string[], plaintext: string, replyTo?: string, tags?: string[][]) {
      ensurePostDeliveryObserver();
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const accountAtStart = key.pkHex;
      const requestedRecipients = permittedPostRecipients(recipients, accountAtStart, plaintext, tags);
      if (requestedRecipients.length === 0) throw new Error("recipients 不能为空");
      const otherRecipients = requestedRecipients.filter(pubkey => pubkey !== accountAtStart);
      const recipientPubkeys = otherRecipients.length > 0 ? otherRecipients : [accountAtStart];
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== accountAtStart) await friendships.load(accountAtStart);
      const unauthorized = otherRecipients.find(pubkey => !friendships.isAccepted(pubkey));
      if (unauthorized) throw new Error("只能向已互相确认的好友发送消息");

      const queued = await queueMessage({
        recipientPubkeys,
        content: plaintext,
        replyTo,
        tags,
        relays: getRelaysFromStorage(),
        context: {
          senderPubkey: accountAtStart,
          nip44Encrypt: key.supportsNip44 ? key.nip44Encrypt.bind(key) : undefined,
          signEvent: key.signEvent.bind(key)
        },
      });
      if (key.pkHex !== accountAtStart) throw new Error("账号已切换，消息结果已丢弃");
      return queued;
    },

    startQueuedPostDelivery(outgoingId: string) {
      ensurePostDeliveryObserver();
      const key = useKeyStore();
      if (!key.isLoggedIn || !outgoingId) return;
      const accountAtStart = key.pkHex;
      void publishQueuedOutgoing(accountAtStart, outgoingId).then(async result => {
        if (useKeyStore().pkHex === accountAtStart) await savePublishedOutbox(accountAtStart, result);
      }).catch(error => {
        logger.warn("[post] background delivery pending", {
          outgoingId: outgoingId.slice(0, 12),
          reason: error instanceof Error ? error.message : "publish_failed",
        });
      });
    },

    async sendDirectMessage(recipients: string[], plaintext: string, replyTo?: string, tags?: string[][]) {
      ensurePostDeliveryObserver();
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const accountAtStart = key.pkHex;
      // Explicit direct messages remain available for the Bot and every accepted friend.
      const requestedRecipients = [...new Set(recipients.map(pubkey => String(pubkey || "").trim().toLowerCase()).filter(Boolean))];
      if (requestedRecipients.length === 0) throw new Error("recipients 不能为空");
      const otherRecipients = requestedRecipients.filter(pubkey => pubkey !== accountAtStart);
      const recipientPubkeys = otherRecipients.length > 0 ? otherRecipients : [accountAtStart];
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== accountAtStart) await friendships.load(accountAtStart);
      const unauthorized = otherRecipients.find(pubkey => !friendships.isAccepted(pubkey));
      if (unauthorized) throw new Error("只能向已互相确认的好友发送消息");

      let outgoingId = "";
      let result: PublishedMessage;
      try {
        result = await sendDirectMessage({
          recipientPubkeys,
          content: plaintext,
          replyTo,
          tags,
          relays: getRelaysFromStorage(),
          context: {
            senderPubkey: accountAtStart,
            nip44Encrypt: key.supportsNip44 ? key.nip44Encrypt.bind(key) : undefined,
            signEvent: key.signEvent.bind(key)
          },
          onQueued: id => { outgoingId = id; }
        });
      } catch (error) {
        if (outgoingId) {
          try {
            // A post editor that reports failure must not leave a hidden automatic
            // retry behind. The UI can explicitly retry this exact queued event.
            await freezeFailedPost(accountAtStart, outgoingId, error);
          } catch (freezeError) {
            logger.warn("[post] failed to freeze queued retry", freezeError);
          }
          throw withOutgoingId(error, outgoingId);
        }
        throw error;
      }
      if (key.pkHex !== accountAtStart) throw new Error("账号已切换，消息结果已丢弃");

      await savePublishedOutbox(accountAtStart, result);

      logger.debug("[message-protocol] published", {
        protocol: result.message.protocol,
        messageId: result.message.id.slice(0, 8),
        eventCount: result.events.length
      });
      return result;
    },

    async retryDirectMessage(outgoingId: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const accountAtStart = key.pkHex;
      try {
        const result = await publishQueuedOutgoing(accountAtStart, outgoingId);
        if (key.pkHex !== accountAtStart) throw new Error("账号已切换，消息结果已丢弃");
        await savePublishedOutbox(accountAtStart, result);
        return result;
      } catch (error) {
        try {
          await freezeFailedPost(accountAtStart, outgoingId, error);
          useMessagesStore().setPostOutgoingState(outgoingId, "send_failed", error instanceof Error ? error.message : "publish_failed");
        } catch (freezeError) {
          logger.warn("[post] failed to freeze retry", freezeError);
        }
        throw withOutgoingId(error, outgoingId);
      }
    },
  }
});
