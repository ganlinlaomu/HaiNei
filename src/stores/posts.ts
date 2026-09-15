import { defineStore } from "pinia";
import { getRelaysFromStorage } from "@/nostr/relays";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { useKeyStore } from "@/stores/keys";
import { logger } from "@/utils/logger";
import { useMessagesStore } from "@/stores/messages";

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

      const result = await sendDirectMessage({
        recipientPubkeys,
        content: plaintext,
        replyTo,
        relays: getRelaysFromStorage(),
        context: {
          senderPubkey: accountAtStart,
          nip04Encrypt: key.nip04Encrypt.bind(key),
          nip44Encrypt: key.supportsNip44 ? key.nip44Encrypt.bind(key) : undefined,
          signEvent: key.signEvent.bind(key)
        }
      });
      if (key.pkHex !== accountAtStart) throw new Error("账号已切换，消息结果已丢弃");

      const out = {
        id: result.message.id,
        created_at: result.message.createdAt,
        sent_at: Date.now(),
        content: plaintext,
        relayResults: result.relayResults
      };
      try {
        const msgs = useMessagesStore();
        if (msgs.loadedFor !== accountAtStart) await msgs.load(accountAtStart);
        if (key.pkHex === accountAtStart) await msgs.addOutbox(out);
      } catch (e) {
        logger.warn("[message-protocol] saving outbox failed", e);
        try {
          const fallbackKey = `nostr_outbox_${accountAtStart}`;
          const existing = JSON.parse(localStorage.getItem(fallbackKey) || "[]");
          localStorage.setItem(fallbackKey, JSON.stringify([out, ...(Array.isArray(existing) ? existing : [])].slice(0, 500)));
        } catch {}
      }

      logger.debug("[message-protocol] published", {
        protocol: result.message.protocol,
        messageId: result.message.id.slice(0, 8),
        eventCount: result.events.length
      });
      return result;
    },

    // Compatibility API. It now prefers NIP-17 and only falls back when NIP-44 is unavailable.
    async publishNip44PerMessage(recipients: string[], plaintext: string) {
      const result = await this.sendDirectMessage(recipients, plaintext);
      return {
        ...result,
        signed: {
          id: result.message.id,
          pubkey: result.message.senderPubkey,
          created_at: result.message.createdAt,
          kind: result.message.transportKind,
          tags: result.message.tags,
          content: plaintext,
          sig: ""
        }
      };
    }
  }
});
