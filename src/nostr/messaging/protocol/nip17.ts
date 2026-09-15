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
import type { CanonicalMessage, EncodedMessage, MessageProtocolAdapter, OutgoingMessage, EncodeContext } from "./types";
import { logger } from "@/utils/logger";

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

function eventDiagnostic(event: NostrEvent, account: string, stage: string, reason?: string) {
  return {
    stage,
    eventId: event.id?.slice(0, 12) || "unknown",
    eventKind: event.kind,
    account: account.slice(0, 12) || "unknown",
    ...(reason ? { reason } : {})
  };
}

function decodeFailed(event: NostrEvent, account: string, stage: string, reason: string): null {
  logger.warn("[nip17] decode_failed", eventDiagnostic(event, account, stage, reason));
  return null;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "unknown_error";
}

export const nip17Adapter: MessageProtocolAdapter = {
  name: "nip17",
  canDecode: event => event.kind === GIFT_WRAP_KIND || event.kind === RUMOR_KIND,
  async decode(event, context) {
    const accountInput = typeof context.accountPubkey === "string" ? context.accountPubkey : "";
    logger.debug("[nip17] wrap_received", eventDiagnostic(event, accountInput, "wrap-received"));
    try {
      const account = normalizePubkey(context.accountPubkey);
      let rumor: Rumor;
      const transportEvent = event;

      if (event.kind === GIFT_WRAP_KIND) {
        if (!context.nip44Decrypt) return decodeFailed(event, account, "outer-validation", "nip44_decrypt_unavailable");
        if (!validateEvent(event)) return decodeFailed(event, account, "outer-validation", "invalid_event_shape");
        if (!verifySignedEvent(event)) return decodeFailed(event, account, "outer-validation", "invalid_event_signature");
        const outerRecipients = recipientPubkeys(event.tags);
        if (outerRecipients.length !== 1) return decodeFailed(event, account, "outer-recipient", "expected_exactly_one_recipient");
        if (outerRecipients[0] !== account) return decodeFailed(event, account, "outer-recipient", "recipient_mismatch");
        logger.debug("[nip17] outer_recipient_valid", eventDiagnostic(event, account, "outer-recipient"));

        let sealPlaintext: string;
        try {
          sealPlaintext = await context.nip44Decrypt(event.pubkey, event.content);
        } catch (error) {
          return decodeFailed(event, account, "outer-decrypt", errorKind(error));
        }
        logger.debug("[nip17] outer_decrypt_success", eventDiagnostic(event, account, "outer-decrypt"));
        const sealValue = parseObject(sealPlaintext);
        if (!sealValue) return decodeFailed(event, account, "seal-validation", "invalid_seal_json");
        if (!validateEvent(sealValue)) return decodeFailed(event, account, "seal-validation", "invalid_seal_shape");
        if (sealValue.kind !== SEAL_KIND) return decodeFailed(event, account, "seal-validation", "invalid_seal_kind");
        if (sealValue.tags.length !== 0) return decodeFailed(event, account, "seal-validation", "seal_tags_not_empty");
        const seal = sealValue as unknown as NostrEvent;
        if (!verifySignedEvent(seal)) return decodeFailed(event, account, "seal-validation", "invalid_seal_signature");
        logger.debug("[nip17] seal_valid", eventDiagnostic(event, account, "seal-validation"));

        let rumorPlaintext: string;
        try {
          rumorPlaintext = await context.nip44Decrypt(seal.pubkey, seal.content);
        } catch (error) {
          return decodeFailed(event, account, "rumor-decrypt", errorKind(error));
        }
        logger.debug("[nip17] rumor_decrypt_success", eventDiagnostic(event, account, "rumor-decrypt"));
        const rumorValue = parseObject(rumorPlaintext);
        if (!rumorValue) return decodeFailed(event, account, "rumor-validation", "invalid_rumor_json");
        if ("sig" in rumorValue) return decodeFailed(event, account, "rumor-validation", "rumor_must_be_unsigned");
        if (!validateEvent(rumorValue)) return decodeFailed(event, account, "rumor-validation", "invalid_rumor_shape");
        rumor = rumorValue as unknown as Rumor;
        if (rumor.kind !== RUMOR_KIND) return decodeFailed(event, account, "rumor-validation", "invalid_rumor_kind");
        if (rumor.pubkey !== seal.pubkey) return decodeFailed(event, account, "rumor-validation", "seal_sender_mismatch");
        if (rumor.id !== getEventHash(rumor)) return decodeFailed(event, account, "rumor-validation", "invalid_rumor_id");
      } else {
        if (!validateEvent(event)) return decodeFailed(event, account, "rumor-validation", "invalid_rumor_shape");
        if (!verifySignedEvent(event)) return decodeFailed(event, account, "rumor-validation", "invalid_rumor_signature");
        rumor = event as unknown as Rumor;
      }
      logger.debug("[nip17] rumor_valid", eventDiagnostic(event, account, "rumor-validation"));

      const recipients = recipientPubkeys(rumor.tags);
      if (rumor.pubkey !== account && !recipients.includes(account)) {
        return decodeFailed(event, account, "recipient-validation", "account_not_in_rumor");
      }
      logger.debug("[nip17] recipient_match", eventDiagnostic(event, account, "recipient-validation"));
      const participants = [rumor.pubkey, ...recipients];
      const decoded: CanonicalMessage = {
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
      logger.debug("[nip17] decode_success", {
        ...eventDiagnostic(event, account, "decode-success"),
        logicalMessageId: rumor.id.slice(0, 12),
        sender: rumor.pubkey.slice(0, 12)
      });
      return decoded;
    } catch (error) {
      return decodeFailed(event, accountInput, "unexpected", errorKind(error));
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
