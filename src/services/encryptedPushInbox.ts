import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { accountScopeForBadge } from "@/utils/appBadge";

export type EncryptedPushInboxEntry = {
  id: string;
  at: number;
  hint: { eventId: string; relays: string[]; event?: NostrEvent };
};

const HEX64 = /^[0-9a-f]{64}$/i;
const PUSH_HINT_WAIT_MS = 1_500;

export function isVerifiedPushGiftWrap(event: NostrEvent, account: string, eventId: string) {
  return !!event && HEX64.test(eventId) && event.id === eventId
    && event.kind === 1059 && Array.isArray(event.tags)
    && event.tags.some(tag => tag[0] === "p" && tag[1] === account)
    && verifyEvent(event);
}

export function safePushRelays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((url): url is string => {
    if (typeof url !== "string" || url.length > 250) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "wss:" && !parsed.username && !parsed.password;
    } catch { return false; }
  }))].slice(0, 2);
}

async function requestPushInbox(account: string, type: string, ids: string[] = []) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller || typeof MessageChannel === "undefined") return null;
  const accountScope = await accountScopeForBadge(account);
  if (!HEX64.test(accountScope)) return null;
  const channel = new MessageChannel();
  return new Promise<{ entries?: unknown; ok?: boolean } | null>(resolve => {
    let settled = false;
    const done = (result: { entries?: unknown; ok?: boolean } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(result);
    };
    const timer = setTimeout(() => done(null), PUSH_HINT_WAIT_MS);
    channel.port1.onmessage = event => done(event.data && typeof event.data === "object" ? event.data : null);
    try {
      navigator.serviceWorker.controller?.postMessage({ type, accountScope, ids }, [channel.port2]);
    } catch {
      done(null);
    }
  });
}

/** The service worker stores only already-encrypted NIP-17 Gift Wraps. */
export async function readEncryptedPushInbox(account: string): Promise<EncryptedPushInboxEntry[]> {
  const response = await requestPushInbox(account, "GET_ENCRYPTED_PUSH_HINTS");
  if (!Array.isArray(response?.entries)) return [];
  const now = Date.now();
  return response.entries.filter((entry): entry is EncryptedPushInboxEntry => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as EncryptedPushInboxEntry;
    return HEX64.test(item.id || "") && HEX64.test(item.hint?.eventId || "")
      && Number.isFinite(item.at) && now >= item.at - 60_000 && now - item.at < 24 * 60 * 60_000;
  }).slice(-32);
}

export async function acknowledgeEncryptedPushInbox(account: string, ids: string[]) {
  if (!ids.length) return;
  await requestPushInbox(account, "ACK_ENCRYPTED_PUSH_HINTS", ids.slice(0, 32));
}
