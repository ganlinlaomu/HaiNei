import { messageOrderAt } from "@/nostr/messaging/sync/sorting";

type OrderableRow = { peerPubkey: string; latest: { id: string; created_at: number; tags?: string[][] } };

/** Pinned conversations first (most recently pinned on top), then newest message first. */
export function sortConversationRows<T extends OrderableRow>(rows: T[], pinnedAt: (peerPubkey: string) => number) {
  return [...rows].sort((a, b) => {
    const pinA = pinnedAt(a.peerPubkey);
    const pinB = pinnedAt(b.peerPubkey);
    if (pinA || pinB) {
      if (!pinA) return 1;
      if (!pinB) return -1;
      if (pinA !== pinB) return pinB - pinA;
    }
    return messageOrderAt(b.latest.created_at, b.latest.tags) - messageOrderAt(a.latest.created_at, a.latest.tags)
      || a.latest.id.localeCompare(b.latest.id);
  });
}
