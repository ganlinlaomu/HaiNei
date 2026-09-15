import type { NostrEvent } from "nostr-tools";
import { genSymHex, symDecryptPackage, symEncryptPackage } from "@/nostr/crypto";
import { deriveConversationId, normalizePubkey, replyReferences, verifySignedEvent } from "./common";
import type {
  CanonicalMessage,
  DecodeContext,
  EncodedMessage,
  EncodeContext,
  MessageProtocol,
  MessageProtocolAdapter,
  OutgoingMessage
} from "./types";

export const LEGACY_MESSAGE_KIND = 8964;
export const LEGACY_INTERACTION_KIND = 8965;

type LegacyPayload = {
  version?: string;
  keys: Array<{ to: string; enc: string }>;
  pkg: { iv: string; ct: string };
};

async function decodeLegacy(
  event: NostrEvent,
  context: DecodeContext,
  protocol: "legacy-8964" | "legacy-8965"
): Promise<CanonicalMessage | null> {
  try {
    const account = normalizePubkey(context.accountPubkey);
    if (!context.nip04Decrypt || typeof event.content !== "string" || !verifySignedEvent(event)) return null;
    const payload = JSON.parse(event.content) as LegacyPayload;
    if (!Array.isArray(payload?.keys) || !payload?.pkg || typeof payload.pkg.iv !== "string" || typeof payload.pkg.ct !== "string") {
      return null;
    }
    const deliveryRecipients = [...new Set(payload.keys.map(key => key?.to?.toLowerCase()).filter(Boolean))] as string[];
    const recipients = deliveryRecipients.filter(pubkey => pubkey !== event.pubkey.toLowerCase());
    const ownKey = payload.keys.find(key => key?.to?.toLowerCase() === account);
    if (!ownKey || typeof ownKey.enc !== "string") return null;

    let symmetricKey: string;
    try {
      symmetricKey = await context.nip04Decrypt(event.pubkey, ownKey.enc);
    } catch {
      if (!/^[0-9a-f]{64}$/i.test(ownKey.enc)) return null;
      symmetricKey = ownKey.enc;
    }
    const plaintext = await symDecryptPackage(symmetricKey, payload.pkg);
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const references = replyReferences(tags);
    return {
      id: event.id,
      senderPubkey: event.pubkey.toLowerCase(),
      recipientPubkeys: recipients,
      conversationId: await deriveConversationId([event.pubkey, ...recipients]),
      plaintext,
      ciphertext: event.content,
      createdAt: event.created_at,
      protocol,
      transportKind: event.kind,
      transportEventId: event.id,
      ...references,
      tags,
      rawEvent: event
    };
  } catch {
    return null;
  }
}

async function encodeLegacy(
  message: OutgoingMessage,
  context: EncodeContext,
  kind: number,
  protocol: "legacy-8964" | "legacy-8965"
): Promise<EncodedMessage> {
  if (!context.nip04Encrypt) throw new Error("NIP-04 is required for legacy message fallback");
  const sender = normalizePubkey(context.senderPubkey);
  const recipients = [...new Set(message.recipientPubkeys.map(normalizePubkey))];
  const deliveryRecipients = [...new Set([...recipients, sender])];
  const symmetricKey = genSymHex();
  const pkg = await symEncryptPackage(symmetricKey, message.plaintext);
  const keys = await Promise.all(deliveryRecipients.map(async to => ({
    to,
    enc: await context.nip04Encrypt!(to, symmetricKey)
  })));
  const tags: string[][] = [];
  if (message.rootId) tags.push(["e", message.rootId, "", "root"]);
  if (message.replyTo) tags.push(["e", message.replyTo, "", "reply"]);
  if (kind === LEGACY_INTERACTION_KIND) {
    for (const recipient of recipients.filter(pubkey => pubkey !== sender)) tags.push(["p", recipient]);
  }
  const content = JSON.stringify({
    version: kind === LEGACY_MESSAGE_KIND ? "nip-44-per-message-v1" : "nip-44-interaction-v1",
    keys,
    pkg
  });
  const signed = await context.signEvent({
    kind,
    created_at: message.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content
  });
  return {
    message: {
      id: signed.id,
      senderPubkey: sender,
      recipientPubkeys: recipients,
      conversationId: await deriveConversationId([sender, ...recipients]),
      plaintext: message.plaintext,
      ciphertext: content,
      createdAt: signed.created_at,
      protocol,
      transportKind: kind,
      transportEventId: signed.id,
      replyTo: message.replyTo,
      rootId: message.rootId,
      tags,
      rawEvent: signed
    },
    events: [signed]
  };
}

function adapter(kind: number, name: "legacy-8964" | "legacy-8965"): MessageProtocolAdapter {
  return {
    name,
    canDecode: event => event.kind === kind,
    decode: (event, context) => decodeLegacy(event, context, name),
    encode: (message, context) => encodeLegacy(message, context, kind, name)
  };
}

export const legacy8964Adapter = adapter(LEGACY_MESSAGE_KIND, "legacy-8964");
export const legacy8965Adapter = adapter(LEGACY_INTERACTION_KIND, "legacy-8965");

export function inferLegacyProtocol(kind: number | undefined): MessageProtocol | undefined {
  if (kind === LEGACY_MESSAGE_KIND) return "legacy-8964";
  if (kind === LEGACY_INTERACTION_KIND) return "legacy-8965";
  return undefined;
}
