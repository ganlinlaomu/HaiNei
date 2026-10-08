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
import { debugLog } from "@/utils/debugLog";
import { DISAPPEARING_DM_TYPE, DISAPPEARING_DM_TTL_SECONDS, BURN_DURATIONS, disappearingMetadata, expirationFromTags, hasDisappearingMarker, isExpiredDisappearing } from "../disappearingMessages";

export const GIFT_WRAP_KIND = 1059;
export const SEAL_KIND = 13;
export const RUMOR_KIND = 14;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
// Separate outer expiry for each recipient to reduce deterministic cross-wrap linkage.
const WRAP_EXPIRATION_JITTER_SECONDS = 15 * 60;

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
    accountPrefix: account.slice(0, 12) || "unknown",
    ...(reason ? { reason } : {})
  };
}

function decodeFailed(event: NostrEvent, account: string, stage: string, reason: string): null {
  debugLog("nip17", "decode_failed", eventDiagnostic(event, account, stage, reason), "warn");
  return null;
}

function decryptErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "nip44_decrypt_failed";
  const message = error.message.toLowerCase();
  if (error.name === "RangeError" || message.includes("payload") || message.includes("length")) {
    return "nip44_invalid_payload";
  }
  if (message.includes("version")) return "nip44_invalid_version";
  return "nip44_decrypt_failed";
}

function unexpectedErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  if (error.name === "SyntaxError") return "syntax_error";
  if (error.name === "TypeError") return "type_error";
  if (error.name === "RangeError") return "range_error";
  return "unexpected_error";
}

export const nip17Adapter: MessageProtocolAdapter = {
  name: "nip17",
  canDecode: event => event.kind === GIFT_WRAP_KIND || event.kind === RUMOR_KIND,
  async decode(event, context) {
    const accountInput = typeof context.accountPubkey === "string" ? context.accountPubkey : "";
    debugLog("nip17", "wrap_received", eventDiagnostic(event, accountInput, "wrap-received"));
    try {
      const account = normalizePubkey(context.accountPubkey);
      let rumor: Rumor;
      const transportEvent = event;

      if (event.kind === GIFT_WRAP_KIND) {
        if (!context.nip44Decrypt) return decodeFailed(event, account, "outer-validation", "nip44_decrypt_unavailable");
        if (!validateEvent(event)) return decodeFailed(event, account, "outer-validation", "invalid_event_shape");
        if (!verifySignedEvent(event)) return decodeFailed(event, account, "outer-validation", "invalid_event_signature");
        const outerExpiry = expirationFromTags(event.tags);
        if (event.tags.some(tag => tag[0] === "expiration") && (outerExpiry === null || outerExpiry <= Math.floor(Date.now() / 1000))) {
          return decodeFailed(event, account, "outer-validation", "expired_or_invalid_outer_expiration");
        }
        const outerRecipients = recipientPubkeys(event.tags);
        if (outerRecipients.length !== 1) return decodeFailed(event, account, "outer-recipient", "expected_exactly_one_recipient");
        if (outerRecipients[0] !== account) return decodeFailed(event, account, "outer-recipient", "recipient_mismatch");
        debugLog("nip17", "outer_recipient_valid", eventDiagnostic(event, account, "outer-recipient"));

        let sealPlaintext: string;
        try {
          sealPlaintext = await context.nip44Decrypt(event.pubkey, event.content);
        } catch (error) {
          return decodeFailed(event, account, "outer-decrypt", decryptErrorKind(error));
        }
        debugLog("nip17", "outer_decrypt_success", eventDiagnostic(event, account, "outer-decrypt"));
        const sealValue = parseObject(sealPlaintext);
        if (!sealValue) return decodeFailed(event, account, "seal-validation", "invalid_seal_json");
        if (!validateEvent(sealValue)) return decodeFailed(event, account, "seal-validation", "invalid_seal_shape");
        if (sealValue.kind !== SEAL_KIND) return decodeFailed(event, account, "seal-validation", "invalid_seal_kind");
        if (sealValue.tags.length !== 0) return decodeFailed(event, account, "seal-validation", "seal_tags_not_empty");
        const seal = sealValue as unknown as NostrEvent;
        if (!verifySignedEvent(seal)) return decodeFailed(event, account, "seal-validation", "invalid_seal_signature");
        debugLog("nip17", "seal_valid", eventDiagnostic(event, account, "seal-validation"));

        let rumorPlaintext: string;
        try {
          rumorPlaintext = await context.nip44Decrypt(seal.pubkey, seal.content);
        } catch (error) {
          return decodeFailed(event, account, "rumor-decrypt", decryptErrorKind(error));
        }
        debugLog("nip17", "rumor_decrypt_success", eventDiagnostic(event, account, "rumor-decrypt"));
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
      debugLog("nip17", "rumor_valid", eventDiagnostic(event, account, "rumor-validation"));

      if (isExpiredDisappearing(rumor.tags)) return decodeFailed(event, account, "rumor-validation", "expired_or_invalid_disappearing_message");
      if (hasDisappearingMarker(rumor.tags)) {
        const temporary = disappearingMetadata(rumor.tags);
        const outerExpiration = expirationFromTags(event.tags);
        if (!temporary || event.kind !== GIFT_WRAP_KIND || outerExpiration === null
          || outerExpiration > temporary.expiresAt
          || outerExpiration < temporary.expiresAt - WRAP_EXPIRATION_JITTER_SECONDS) {
          return decodeFailed(event, account, "rumor-validation", "disappearing_expiration_mismatch");
        }
      }
      const recipients = recipientPubkeys(rumor.tags);
      if (rumor.pubkey !== account && !recipients.includes(account)) {
        return decodeFailed(event, account, "recipient-validation", "account_not_in_rumor");
      }
      debugLog("nip17", "recipient_match", eventDiagnostic(event, account, "recipient-validation"));
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
      debugLog("nip17", "decode_success", {
        ...eventDiagnostic(event, account, "decode-success"),
        logicalMessageId: rumor.id.slice(0, 12),
        sender: rumor.pubkey.slice(0, 12)
      });
      return decoded;
    } catch (error) {
      return decodeFailed(event, accountInput, "unexpected", unexpectedErrorKind(error));
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
    // Temporary metadata is generated, never accepted as raw caller-supplied tags.
    if (tag[0] === "expiration" || tag[0] === "burn-after" || (tag[0] === "t" && tag[1] === DISAPPEARING_DM_TYPE)) continue;
    tags.push([...tag]);
  }
  let expiresAt: number | undefined;
  if (message.burnAfterSeconds !== undefined) {
    if (!BURN_DURATIONS.includes(message.burnAfterSeconds)) throw new Error("unsupported_burn_duration");
    if (recipients.length !== 1 || recipients[0] === sender || !tags.some(tag => tag[0] === "t" && tag[1] === "hainei-dm")) {
      throw new Error("disappearing_messages_require_single_direct_recipient");
    }
    expiresAt = Math.floor(Date.now() / 1000) + DISAPPEARING_DM_TTL_SECONDS;
    tags.push(["t", DISAPPEARING_DM_TYPE], ["burn-after", String(message.burnAfterSeconds)], ["expiration", String(expiresAt)]);
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
    const wrapExpiresAt = expiresAt === undefined ? undefined
      : expiresAt - Math.floor(Math.random() * WRAP_EXPIRATION_JITTER_SECONDS);
    const wrap = finalizeEvent({
      kind: GIFT_WRAP_KIND,
      created_at: randomPastTimestamp(),
      tags: [["p", target], ...(wrapExpiresAt === undefined ? [] : [["expiration", String(wrapExpiresAt)]])],
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
