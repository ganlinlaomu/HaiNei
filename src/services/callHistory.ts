import { db, type SyncedMessageRecord } from "@/db/dexie";
import { metaRepository } from "@/repositories/metaRepository";
import { CALL_LOG_TYPE, CALL_MISSED_TYPE } from "@/nostr/messaging/callControl";
import { directMessagePeer } from "@/nostr/messaging/directMessages";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { CALL_LOG_CLASS_MIGRATION_KEY } from "@/repositories/syncedMessageRepository";

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
  local: ReadonlyArray<{ key: string; value?: unknown }>,
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
/**
 * Stored records that may be call logs, created after `since`. Uses the
 * "call" class index once this account's reclassification has finished;
 * until then every DM row is scanned. Callers still validate each record.
 */
export async function callLogCandidates(account: string, since = 0) {
  const indexed = (await db.accountMeta.get([account, CALL_LOG_CLASS_MIGRATION_KEY]))?.value === true;
  // IndexedDB does not permit +/-Infinity as compound-key members.
  return indexed
    ? db.syncedMessages.where("[accountPubkey+messageClass+createdAt+id]")
      .between([account, "call", since, ""], [account, "call", Number.MAX_SAFE_INTEGER, "\uffff"])
    : db.syncedMessages.where("[accountPubkey+createdAt+id]")
      .between([account, since, ""], [account, Number.MAX_SAFE_INTEGER, "\uffff"]);
}

export async function readVisibleCallHistoryPage(account: string, requested: number, missedOnly: boolean) {
  const count = Math.max(1, Math.floor(requested));
  const deleted = await loadDeletedCallIds(account);
  const seen = new Set<string>(), items: CallHistoryItem[] = [];
  await (await callLogCandidates(account))
    .reverse().until(() => items.length > count).each(record => {
      const item = callHistoryItem(record, account);
      if (!item || (missedOnly && !item.missed) || deleted.has(item.id) || seen.has(item.id)) return;
      seen.add(item.id);
      items.push(item);
    });
  return { items: items.slice(0, count), hasMore: items.length > count };
}

// The page scan above walks every DM record, so reopening Calls (not kept
// alive) used to flash "正在读取通话记录…". Keep the last visible page per
// session in memory and paint it first; liveQuery then replaces it.
type CachedCallPage = { items: CallHistoryItem[]; hasMore: boolean };
const pageCache = new Map<string, CachedCallPage>();
let pageCacheSession = "";
const pageKey = (account: string, missedOnly: boolean) => `${account}:${missedOnly ? "missed" : "all"}`;
function usePageCacheSession(session: string) {
  if (session !== pageCacheSession) { pageCache.clear(); pageCacheSession = session; }
}
export function cachedCallHistoryPage(session: string, account: string, requested: number, missedOnly: boolean): CachedCallPage | null {
  usePageCacheSession(session);
  const cached = pageCache.get(pageKey(account, missedOnly));
  if (!cached) return null;
  const count = Math.max(1, Math.floor(requested));
  return { items: cached.items.slice(0, count), hasMore: cached.hasMore || cached.items.length > count };
}
export function rememberCallHistoryPage(session: string, account: string, missedOnly: boolean, page: CachedCallPage) {
  usePageCacheSession(session);
  pageCache.set(pageKey(account, missedOnly), { items: page.items, hasMore: page.hasMore });
}
export function clearCallHistoryPageCache() { pageCache.clear(); pageCacheSession = ""; }
const stopPageCacheLockClear = onBeforeAccountLock(() => { clearCallHistoryPageCache(); });
if (import.meta.hot) import.meta.hot.dispose(stopPageCacheLockClear);
