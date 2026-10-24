import { bookmarkRepository } from "@/repositories/bookmarkRepository";
import type { useBookmarksStore } from "@/stores/bookmarks";
import type { useKeyStore } from "@/stores/keys";
import type { useUIStore } from "@/stores/ui";

type Bookmarks = ReturnType<typeof useBookmarksStore>;
type Keys = ReturnType<typeof useKeyStore>;
type UI = ReturnType<typeof useUIStore>;

/** One independent toast per removed bookmark. The removed revision is a CAS token. */
export async function offerBookmarkUndoToast(
  id: string, keys: Keys, bookmarks: Bookmarks, ui: UI,
) {
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  if (!keys.isUnlocked || bookmarks.loadedFor !== account) return;
  const removed = await bookmarkRepository.get(account, id);
  if (!removed?.deleted || !Number.isSafeInteger(removed.updatedAt) ||
      keys.pkHex.toLowerCase() !== account || keys.sessionGeneration !== generation ||
      !keys.isUnlocked || bookmarks.loadedFor !== account) return;
  const stamp = removed.updatedAt!;
  let used = false;
  ui.addToast("已移除收藏 · 可撤销", 5_000, "info", {
    label: "撤销",
    run: () => {
      if (used || !keys.isUnlocked || keys.pkHex.toLowerCase() !== account ||
          keys.sessionGeneration !== generation || bookmarks.loadedFor !== account) return;
      used = true;
      void bookmarks.undoRemoval(account, id, stamp).catch(() => {
        if (keys.isUnlocked && keys.pkHex.toLowerCase() === account &&
            keys.sessionGeneration === generation)
          ui.addToast("撤销收藏失败，请重试", 2_400, "error");
      });
    },
  });
}
