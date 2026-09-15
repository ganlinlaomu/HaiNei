import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  nip44,
  validateEvent,
  type NostrEvent,
  type UnsignedEvent
} from "nostr-tools";
import { deriveConversationId, normalizePubkey, recipientPubkeys, replyReferences, verifySignedEvent } from "./common";
import type { EncodedMessage, MessageProtocolAdapter, OutgoingMessage, EncodeContext } from "./types";

export const GIFT_WRAP_KIND = 1059;
export const SEAL_KIND = 13;
export const RUMOR_KIND = 14;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

type Rumor = UnsignedEvent & { id: string; sig?: never };

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function randomPastTimestamp(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * TWO_DAYS_SECONDS);
}

function encryptWithEphemeralKey(secretKey: Uint8Array, pubkey: string, plaintext: string): string {
  const key = nip44.v2.utils.getConversationKey(secretKey, pubkey);
  return nip44.v2.encrypt(plaintext, key);
}

export const nip17Adapter: MessageProtocolAdapter = {
  name: "nip17",
  canDecode: event => event.kind === GIFT_WRAP_KIND || event.kind === RUMOR_KIND,
  async decode(event, context) {
    try {
      const account = normalizePubkey(context.accountPubkey);
      let rumor: Rumor;
      let transportEvent = event;

      if (event.kind === GIFT_WRAP_KIND) {
        if (!context.nip44Decrypt || !validateEvent(event) || !verifySignedEvent(event)) return null;
        const outerRecipients = recipientPubkeys(event.tags);
        if (outerRecipients.length !== 1 || outerRecipients[0] !== account) return null;

        const sealValue = parseObject(await context.nip44Decrypt(event.pubkey, event.content));
        if (!sealValue || !validateEvent(sealValue) || sealValue.kind !== SEAL_KIND || sealValue.tags.length !== 0) return null;
        const seal = sealValue as unknown as NostrEvent;
        if (!verifySignedEvent(seal)) return null;

        const rumorValue = parseObject(await context.nip44Decrypt(seal.pubkey, seal.content));
        if (!rumorValue || "sig" in rumorValue || !validateEvent(rumorValue)) return null;
        rumor = rumorValue as unknown as Rumor;
        if (rumor.kind !== RUMOR_KIND || rumor.pubkey !== seal.pubkey || rumor.id !== getEventHash(rumor)) return null;
      } else {
        if (!validateEvent(event) || !verifySignedEvent(event)) return null;
        rumor = event as unknown as Rumor;
      }

      const recipients = recipientPubkeys(rumor.tags);
      if (rumor.pubkey !== account && !recipients.includes(account)) return null;
      const participants = [rumor.pubkey, ...recipients];
      return {
        id: rumor.id,
        senderPubkey: rumor.pubkey,
        recipientPubkeys: recipients,
        conversationId: await deriveConversationId(participants),
        plaintext: rumor.content,
        ciphertext: transportEvent.content,
        createdAt: rumor.created_at,
        protocol: "nip17",
        transportKind: transportEvent.kind,
        transportEventId: transportEvent.id,
        rumorId: rumor.id,
        ...replyReferences(rumor.tags),
        tags: rumor.tags,
        rawEvent: transportEvent
      };
    } catch {
      return null;
    }
  },
  encode: buildNip17Message
};

export async function buildNip17Message(message: OutgoingMessage, context: EncodeContext): Promise<EncodedMessage> {
  if (!context.nip44Encrypt) throw new Error("NIP-44 signer support is required for NIP-17");
  const sender = normalizePubkey(context.senderPubkey);
  const requestedRecipients = [...new Set(message.recipientPubkeys.map(normalizePubkey))];
  const otherRecipients = requestedRecipients.filter(pubkey => pubkey !== sender);
  const recipients = otherRecipients.length > 0 ? otherRecipients : [sender];
  if (requestedRecipients.length === 0) throw new Error("at least one recipient is required");
  const tags: string[][] = recipients.map(pubkey => ["p", pubkey]);
  if (message.rootId) tags.push(["e", message.rootId, "", "root"]);
  if (message.replyTo) tags.push(["e", message.replyTo, "", "reply"]);
  for (const tag of message.tags || []) {
    if (!Array.isArray(tag) || tag.length === 0 || tag[0] === "p" || tag[0] === "e") continue;
    tags.push([...tag]);
  }
  const rumorBase: UnsignedEvent = {
    pubkey: sender,
    kind: RUMOR_KIND,
    created_at: message.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: message.plaintext
  };
  const rumor: Rumor = { ...rumorBase, id: getEventHash(rumorBase) };
  const events: NostrEvent[] = [];

  for (const target of [...new Set([...recipients, sender])]) {
    const seal = await context.signEvent({
      kind: SEAL_KIND,
      created_at: randomPastTimestamp(),
      tags: [],
      content: await context.nip44Encrypt(target, JSON.stringify(rumor))
    });
    if (seal.pubkey !== sender || !verifySignedEvent(seal)) throw new Error("signer returned an invalid NIP-17 seal");
    const ephemeralSecret = generateSecretKey();
    const wrap = finalizeEvent({
      kind: GIFT_WRAP_KIND,
      created_at: randomPastTimestamp(),
      tags: [["p", target]],
      content: encryptWithEphemeralKey(ephemeralSecret, target, JSON.stringify(seal))
    }, ephemeralSecret);
    events.push(wrap);
  }

  return {
    message: {
      id: rumor.id,
      senderPubkey: sender,
      recipientPubkeys: recipients,
      conversationId: await deriveConversationId([sender, ...recipients]),
      plaintext: message.plaintext,
      createdAt: rumor.created_at,
      protocol: "nip17",
      transportKind: GIFT_WRAP_KIND,
      rumorId: rumor.id,
      replyTo: message.replyTo,
      rootId: message.rootId,
      tags
    },
    events
  };
}
