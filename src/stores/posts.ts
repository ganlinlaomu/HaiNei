import { defineStore } from "pinia";
import { getRelaysFromStorage } from "@/nostr/relays";
import { publishQueuedOutgoing, sendDirectMessage, type PublishedMessage } from "@/nostr/messaging/service";
import { useKeyStore } from "@/stores/keys";
import { logger } from "@/utils/logger";
import { useMessagesStore } from "@/stores/messages";
import { useFriendshipsStore } from "@/stores/friendships";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";

type PostPublishError = Error & { outgoingId?: string };

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
    async sendDirectMessage(recipients: string[], plaintext: string, replyTo?: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const accountAtStart = key.pkHex;
      const requestedRecipients = [...new Set(recipients.filter(Boolean))];
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
        } catch (freezeError) {
          logger.warn("[post] failed to freeze retry", freezeError);
        }
        throw withOutgoingId(error, outgoingId);
      }
    },
  }
});
