import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/dexie";
import { offerBookmarkUndoToast } from "@/services/bookmarkUndoToast";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function createContext() {
  const keys = { pkHex: ACCOUNT, sessionGeneration: 1, isUnlocked: true };
  const bookmarks = { loadedFor: ACCOUNT, undoRemoval: vi.fn(async () => true) };
  const actions: Array<{ label: string; run: () => void }> = [];
  const ui = {
    addToast: vi.fn((_message: string, _timeout: number, _type: string, action: { label: string; run: () => void }) => {
      actions.push(action);
      return actions.length;
    }),
  };
  return { keys, bookmarks, actions, ui };
}

beforeEach(async () => {
  await db.open();
  await db.accountBookmarks.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("bookmark undo toast actions", () => {
  it("keeps two independent undo closures for two removed bookmarks", async () => {
    const ctx = createContext();
    const ids = ["1".repeat(64), "2".repeat(64)];
    for (const [index, id] of ids.entries()) {
      await db.accountBookmarks.put({
        accountPubkey: ACCOUNT, messageId: id, createdAt: 10 + index,
        updatedAt: 100 + index, deleted: true,
      });
      await offerBookmarkUndoToast(id, ctx.keys as any, ctx.bookmarks as any, ctx.ui as any);
    }
    expect(ctx.actions).toHaveLength(2);
    expect(ctx.ui.addToast).toHaveBeenCalledTimes(2);
    expect(ctx.ui.addToast.mock.calls[0][1]).toBe(5_000);
    expect(ctx.actions.map(action => action.label)).toEqual(["撤销", "撤销"]);
    ctx.actions[1].run();
    ctx.actions[0].run();
    await Promise.resolve();
    expect(ctx.bookmarks.undoRemoval.mock.calls).toEqual([
      [ACCOUNT, ids[1], 101],
      [ACCOUNT, ids[0], 100],
    ]);
    ctx.actions[0].run(); // Single-use even if clicked twice.
    expect(ctx.bookmarks.undoRemoval).toHaveBeenCalledTimes(2);
  });

  it("cannot use a stale toast after switching accounts or locking", async () => {
    const ctx = createContext();
    const id = "3".repeat(64);
    await db.accountBookmarks.put({ accountPubkey: ACCOUNT, messageId: id, createdAt: 1, updatedAt: 9, deleted: true });
    await offerBookmarkUndoToast(id, ctx.keys as any, ctx.bookmarks as any, ctx.ui as any);
    ctx.keys.pkHex = OTHER;
    ctx.actions[0].run();
    expect(ctx.bookmarks.undoRemoval).not.toHaveBeenCalled();
    ctx.keys.pkHex = ACCOUNT;
    ctx.keys.isUnlocked = false;
    ctx.actions[0].run();
    expect(ctx.bookmarks.undoRemoval).not.toHaveBeenCalled();
    ctx.keys.isUnlocked = true;
    ctx.keys.sessionGeneration = 2;
    ctx.actions[0].run();
    expect(ctx.bookmarks.undoRemoval).not.toHaveBeenCalled();
  });

  it("never advertises undo for a bookmark that is already restored", async () => {
    const ctx = createContext();
    const id = "4".repeat(64);
    await db.accountBookmarks.put({ accountPubkey: ACCOUNT, messageId: id, createdAt: 1, updatedAt: 11, deleted: false });
    await offerBookmarkUndoToast(id, ctx.keys as any, ctx.bookmarks as any, ctx.ui as any);
    expect(ctx.actions).toHaveLength(0);
  });
});
