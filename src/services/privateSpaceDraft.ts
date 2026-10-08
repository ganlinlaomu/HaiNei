import type { PrivateSpaceDraft } from "@/repositories/privateSpaceRepository";
import type { PrivateSpaceRecord } from "@/db/dexie";

/** UI-only draft. Calling this function must never write IndexedDB or schedule cloud sync. */
export function makeUnsavedPrivateSpaceDraft(
  account: string, kind: "note" | "todo",
  id = crypto.randomUUID(), now = Date.now(),
): PrivateSpaceRecord {
  return {
    accountPubkey: account, id, kind, title: "", body: "",
    tasks: [], pinned: false, createdAt: now, updatedAt: now, revision: 1,
  };
}

/** Whitespace, an empty task row, or pinning an otherwise blank draft is not user content. */
export function hasPrivateSpaceDraftContent(
  draft: Pick<PrivateSpaceDraft, "title" | "body" | "tasks">,
): boolean {
  return !!draft.title.trim() || !!draft.body.trim() ||
    draft.tasks.some(task => !!task.text.trim());
}
