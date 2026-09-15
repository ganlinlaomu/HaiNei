import type { NostrEvent } from "nostr-tools";
import { deriveConversationId, normalizePubkey, recipientPubkeys, replyReferences, verifySignedEvent } from "./common";
import type { MessageProtocolAdapter } from "./types";

export const NIP04_KIND = 4;

export const nip04Adapter: MessageProtocolAdapter = {
  name: "nip04",
  canDecode: event => event.kind === NIP04_KIND,
  async decode(event: NostrEvent, context) {
    try {
      const account = normalizePubkey(context.accountPubkey);
      if (!context.nip04Decrypt || !verifySignedEvent(event)) return null;
      const recipients = recipientPubkeys(event.tags);
      if (event.pubkey !== account && !recipients.includes(account)) return null;
      const plaintext = await context.nip04Decrypt(event.pubkey, event.content);
      return {
        id: event.id,
        senderPubkey: event.pubkey,
        recipientPubkeys: recipients,
        conversationId: await deriveConversationId([event.pubkey, ...recipients]),
        plaintext,
        ciphertext: event.content,
        createdAt: event.created_at,
        protocol: "nip04",
        transportKind: event.kind,
        transportEventId: event.id,
        ...replyReferences(event.tags),
        tags: event.tags,
        rawEvent: event
      };
    } catch {
      return null;
    }
  }
};
