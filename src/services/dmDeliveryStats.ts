import type { MessageSource } from "@/nostr/messaging/sync/types";

/**
 * Diagnostics for review item #8: how often an already-stored NIP-17 message
 * is delivered again and re-runs the post-persist side effects (Home mirror,
 * interactions, receipts), and what that costs. Counts and timings only.
 */
export type DeliverySourceStats = {
  /** First durable insert of this logical message. */
  inserted: number;
  /** Already stored; side effects ran again. */
  duplicate: number;
  /** Wall time spent in the duplicate side-effect path (ms). */
  duplicateMs: number;
  /** Duplicates whose side effects mutated the in-memory inbox. */
  duplicateChangedInbox: number;
};

export type DeliveryStatsSnapshot = {
  sessionStartedAt: number;
  bySource: Partial<Record<MessageSource, DeliverySourceStats>>;
  /** Totals excluding local-migration (startup replay of local rows). */
  relay: DeliverySourceStats;
};

const empty = (): DeliverySourceStats => ({ inserted: 0, duplicate: 0, duplicateMs: 0, duplicateChangedInbox: 0 });

let sessionStartedAt = 0;
let bySource: Partial<Record<MessageSource, DeliverySourceStats>> = {};

export function resetDeliveryStats(nowMs = Date.now()) {
  sessionStartedAt = nowMs;
  bySource = {};
}

export function recordPersistedDelivery(source: MessageSource, inserted: boolean, elapsedMs: number, changedInbox: boolean) {
  const stats = bySource[source] ||= empty();
  if (inserted) {
    stats.inserted++;
    return;
  }
  stats.duplicate++;
  stats.duplicateMs += Math.max(0, elapsedMs);
  if (changedInbox) stats.duplicateChangedInbox++;
}

export function getDeliveryStats(): DeliveryStatsSnapshot {
  const relay = empty();
  const copy: DeliveryStatsSnapshot["bySource"] = {};
  for (const [source, stats] of Object.entries(bySource) as Array<[MessageSource, DeliverySourceStats]>) {
    copy[source] = { ...stats, duplicateMs: Math.round(stats.duplicateMs) };
    if (source === "local-migration") continue;
    relay.inserted += stats.inserted;
    relay.duplicate += stats.duplicate;
    relay.duplicateMs += stats.duplicateMs;
    relay.duplicateChangedInbox += stats.duplicateChangedInbox;
  }
  relay.duplicateMs = Math.round(relay.duplicateMs);
  return { sessionStartedAt, bySource: copy, relay };
}

/** Flat record for debugLog (sanitizer-friendly scalars only). */
export function deliveryStatsLogData() {
  const snapshot = getDeliveryStats();
  const data: Record<string, number> = {
    sessionSeconds: sessionStartedAt ? Math.round((Date.now() - sessionStartedAt) / 1000) : 0,
    relayInserted: snapshot.relay.inserted,
    relayDuplicate: snapshot.relay.duplicate,
    relayDuplicateMs: snapshot.relay.duplicateMs,
    relayDuplicateChangedInbox: snapshot.relay.duplicateChangedInbox,
  };
  for (const [source, stats] of Object.entries(snapshot.bySource)) {
    data[`${source}Inserted`] = stats!.inserted;
    data[`${source}Duplicate`] = stats!.duplicate;
  }
  return data;
}
