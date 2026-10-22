import type { PrivateSpaceRecord } from "@/db/dexie";
import type { InboxItem } from "@/nostr/messaging/messageViewModel";
import { privateSpaceDisplay } from "@/services/privateSpaceContent";

/** Feed ids of private cards; never collide with Nostr event ids (hex). */
export const PRIVATE_FEED_PREFIX = "private:";

/**
 * Notes as items of the owner's own feed. To-dos are not feed cards: open
 * tasks are listed in the to-do bar at the top of Home (see openTodoTasks).
 */
export function privateFeedItems(records: PrivateSpaceRecord[], ownerPubkey: string): InboxItem[] {
  return records
    .filter(record => !record.deletedAt && !record.archivedAt && record.kind === "note")
    .filter(record => !!(record.title.trim() || privateSpaceDisplay(record).text.trim() || record.attachments?.length))
    .map(record => ({
      id: `${PRIVATE_FEED_PREFIX}${record.id}`,
      pubkey: ownerPubkey,
      created_at: Math.floor(record.createdAt / 1000),
      content: "",
      tags: [],
      privateNote: record,
    }));
}

export type OpenTodoTask = {
  recordId: string;
  taskId: string;
  text: string;
  /** The to-do list's title, if any. */
  listTitle: string;
  pinned: boolean;
};

/**
 * Every unfinished task across to-do lists, for the Home to-do bar: pinned
 * lists first, then the most recently edited, tasks in their list order.
 */
export function openTodoTasks(records: PrivateSpaceRecord[]): OpenTodoTask[] {
  return records
    .filter(record => record.kind === "todo" && !record.deletedAt && !record.archivedAt)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .flatMap(record => record.tasks
      .filter(task => !task.done && task.text.trim())
      .map(task => ({ recordId: record.id, taskId: task.id, text: task.text.trim(), listTitle: record.title.trim(), pinned: record.pinned })));
}
