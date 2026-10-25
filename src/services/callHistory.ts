import type { SyncedMessageRecord } from "@/db/dexie";
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
