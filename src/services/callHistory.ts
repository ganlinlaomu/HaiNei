import Dexie from "dexie";
import { db, type SyncedMessageRecord } from "@/db/dexie";
import { metaRepository } from "@/repositories/metaRepository";
import { CALL_LOG_TYPE, CALL_MISSED_TYPE } from "@/nostr/messaging/callControl";
import { directMessagePeer } from "@/nostr/messaging/directMessages";

export const CALL_RECORD_TAG = "hainei-call-record";
export type CallHistoryItem = { id: string; peer: string; createdAt: number; text: string; missed: boolean; direction: "incoming" | "outgoing" | "unknown" };
/** Old self-authored notes do not preserve direction. Never guess it from sender alone. */
export function callHistoryItem(record: SyncedMessageRecord, account: string): CallHistoryItem | null {
  if (record.accountPubkey !== account || !record.tags?.some(t => t[0] === "t" && t[1] === CALL_LOG_TYPE)) return null;
  const peer = directMessagePeer(record, account);
  if (!/^[0-9a-f]{64}$/.test(peer) || peer === account) return null;
  const remote = record.senderPubkey !== account;
  if (remote && !record.recipientPubkeys.includes(account)) return null;
  const tag = record.tags.find(t => t[0] === CALL_RECORD_TAG);
  const valid = tag && /^[0-9a-f]{32}$/.test(tag[1]) && ["incoming", "outgoing"].includes(tag[2]);
  const direction = remote ? "incoming" : valid ? tag[2] as "incoming" | "outgoing" : "unknown";
  return { id: valid ? `${peer}:${tag[1]}` : record.id, peer, createdAt: record.createdAt,
    text: record.plaintext || "语音通话", direction,
    missed: remote && record.tags.some(t => t[0] === "t" && t[1] === CALL_MISSED_TYPE) };
}
export function uniqueCallHistory(items: CallHistoryItem[]) {
  const seen = new Set<string>();
  return items.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
}

// The local tombstone is authoritative on this device. The namespaced entry
// in encrypted feed_preferences additionally propagates deletions to other
// devices without deleting Relay messages or unrelated post preferences.
export const CALL_HISTORY_DELETED_PREFIX = "call-history:deleted:";
export const CALL_HISTORY_SYNC_PREFIX = "call-history:";
const FEED_PREFERENCES_SYNC_KEY = "feed_preferences_v2";

export function deletedCallIds(
  local: ReadonlyArray<{ key: string; value: unknown }>,
  preferenceValue: unknown,
): Set<string> {
  const result = new Set<string>();
  for (const entry of local) {
    if (entry.value === true && entry.key.startsWith(CALL_HISTORY_DELETED_PREFIX)) {
      result.add(entry.key.slice(CALL_HISTORY_DELETED_PREFIX.length));
    }
  }
  const hidden = preferenceValue && typeof preferenceValue === "object" && "hidden" in preferenceValue
    ? (preferenceValue as { hidden?: unknown }).hidden : undefined;
  if (Array.isArray(hidden)) {
    for (const item of hidden) {
      if (!item || typeof item.id !== "string" || item.deleted === true
        || !item.id.startsWith(CALL_HISTORY_SYNC_PREFIX)) continue;
      result.add(item.id.slice(CALL_HISTORY_SYNC_PREFIX.length));
    }
  }
  return result;
}

/** Read both durable local markers and restored encrypted cross-device markers. */
export async function loadDeletedCallIds(account: string) {
  const [local, shared] = await Promise.all([
    metaRepository.listPrefix(account, CALL_HISTORY_DELETED_PREFIX),
    metaRepository.get(account, FEED_PREFERENCES_SYNC_KEY),
  ]);
  return deletedCallIds(local, shared?.value);
}

/**
 * Page by VISIBLE logical calls, not raw encrypted records. Doing this inside
 * Dexie's liveQuery makes a tombstone refresh the page and keeps old Relay
 * copies hidden even when more history is loaded.
 */
export async function readVisibleCallHistoryPage(account: string, requested: number, missedOnly: boolean) {
  const count = Math.max(1, Math.floor(requested));
  const deleted = await loadDeletedCallIds(account);
  const seen = new Set<string>(), items: CallHistoryItem[] = [];
  await db.syncedMessages.where("[accountPubkey+createdAt+id]")
    .between([account, Dexie.minKey, Dexie.minKey], [account, Dexie.maxKey, Dexie.maxKey])
    .reverse().until(() => items.length > count).each(record => {
      const item = callHistoryItem(record, account);
      if (!item || (missedOnly && !item.missed) || deleted.has(item.id) || seen.has(item.id)) return;
      seen.add(item.id);
      items.push(item);
    });
  return { items: items.slice(0, count), hasMore: items.length > count };
}
