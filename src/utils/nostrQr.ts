import { nip19 } from "nostr-tools";
import { keyToHex } from "@/utils/format";

export function pubkeyToNpub(pubkey: string): string {
  const hex = keyToHex(pubkey);
  if (!hex) throw new Error("invalid_pubkey");
  return nip19.npubEncode(hex);
}

export function buildNostrProfileQrValue(pubkey: string): string {
  return `nostr:${pubkeyToNpub(pubkey)}`;
}

export function parseNostrProfileQrValue(value: string): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  const payload = trimmed.replace(/^nostr:/i, "").trim();
  if (!payload || /^nsec1/i.test(payload)) return null;

  return keyToHex(payload);
}

export function shortNpub(pubkey: string, head = 12, tail = 8): string {
  try {
    const npub = pubkeyToNpub(pubkey);
    return `${npub.slice(0, head)}…${npub.slice(-tail)}`;
  } catch {
    return "";
  }
}
