import type { PrivateSpaceRecord } from "@/db/dexie";
import type { InboxItem } from "@/nostr/messaging/messageViewModel";
import { privateSpaceDisplay } from "@/services/privateSpaceContent";

/** Feed ids of private cards; never collide with Nostr event ids (hex). */
export const PRIVATE_FEED_PREFIX = "private:";

/**
 * Notes and unfinished to-dos as items of the owner's own feed. A to-do list
 * is one card however many tasks it has, and leaves the feed once all are done.
 */
export function privateFeedItems(records: PrivateSpaceRecord[], ownerPubkey: string): InboxItem[] {
  return records
    .filter(record => !record.deletedAt && !record.archivedAt)
    .filter(record => record.kind === "todo"
      ? record.tasks.some(task => task.text.trim() && !task.done)
      : !!(record.title.trim() || privateSpaceDisplay(record).text.trim() || record.attachments?.length))
    .map(record => ({
      id: `${PRIVATE_FEED_PREFIX}${record.id}`,
      pubkey: ownerPubkey,
      created_at: Math.floor(record.createdAt / 1000),
      content: "",
      tags: [],
      privateNote: record,
    }));
}
