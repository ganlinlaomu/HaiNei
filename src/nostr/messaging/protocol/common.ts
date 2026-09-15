import { verifyEvent, type NostrEvent } from "nostr-tools";

const HEX_64 = /^[0-9a-f]{64}$/;

export function normalizePubkey(pubkey: string): string {
  const normalized = pubkey?.trim().toLowerCase();
  if (!HEX_64.test(normalized)) throw new Error("invalid nostr pubkey");
  return normalized;
}

export function recipientPubkeys(tags: string[][]): string[] {
  return [...new Set(
    tags
      .filter(tag => tag[0] === "p" && typeof tag[1] === "string")
      .map(tag => tag[1].toLowerCase())
      .filter(pubkey => HEX_64.test(pubkey))
  )];
}

export function replyReferences(tags: string[][]): { replyTo?: string; rootId?: string } {
  const eventTags = tags.filter(tag => tag[0] === "e" && tag[1]);
  const reply = eventTags.find(tag => tag[3] === "reply") ?? eventTags[eventTags.length - 1];
  const root = eventTags.find(tag => tag[3] === "root");
  return { replyTo: reply?.[1], rootId: root?.[1] };
}

export async function deriveConversationId(participants: string[]): Promise<string> {
  const normalized = [...new Set(participants.map(normalizePubkey))].sort().join(":");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Rebuild the signed fields so nostr-tools cannot reuse a stale verifiedSymbol cache. */
export function verifySignedEvent(event: NostrEvent): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig
    });
  } catch {
    return false;
  }
}
