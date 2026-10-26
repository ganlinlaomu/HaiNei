import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(64);

/**
 * Execute the real Vue action functions with injected UI/repository fakes.
 * Unlike text matching, this exercises the confirmation, deletion and undo
 * callbacks without mounting the entire account/relay application.
 */
function harness(undoResult: unknown = null) {
  const view = readFileSync("src/views/PrivateSpace.vue", "utf8");
  const begin = view.indexOf("/** Each toast captures its own item/revision");
  const end = view.indexOf("watch([query, filter], closeAllNoteSwipes)", begin);
  if (begin < 0 || end < 0) throw new Error("private-space actions unavailable");
  const js = ts.transpileModule(view.slice(begin, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const original = {
    id: "note1", accountPubkey: ACCOUNT, kind: "note", title: "Reminder",
    body: "Coffee", tasks: [], deletedAt: 0, archivedAt: 0, revision: 1,
  };
  const deleted = { ...original, deletedAt: 12345, revision: 2 };
  const repo = {
    get: vi.fn(async () => original),
    moveToTrash: vi.fn(async () => deleted),
    undoDisposition: vi.fn(async () => undoResult),
  };
  const ui = { addToast: vi.fn() };
  const window = { confirm: vi.fn(() => { throw new Error("unexpected confirm dialog"); }) };
  const keys = { pkHex: ACCOUNT, isUnlocked: true, sessionGeneration: 7 };
  const updated = vi.fn();
  const mutation = vi.fn();
  const closeSwipe = vi.fn();
  const refs = {
    backupBusy: { value: false }, loading: { value: false },
    editorTransitionBusy: { value: false }, rowActionBusyId: { value: "" },
    error: { value: "old error" },
  };
  const context = {
    ...refs, window, keys, ui, privateSpaceRepository: repo,
    canSwipeNote: () => true, closeSwipe, updateInList: updated,
    notePrivateSpaceMutation: mutation,
    sessionSnapshot: () => ({ account: ACCOUNT, isCurrent: () => true }),
    handleError: vi.fn(),
  };
  const actions = runInNewContext(js + "\n({ deleteFromSwipe, offerDispositionUndo })", context) as {
    deleteFromSwipe: (note: typeof original) => Promise<void>;
    offerDispositionUndo: (note: typeof deleted, field: "deletedAt" | "archivedAt") => void;
  };
  return { actions, original, deleted, repo, ui, window, keys, updated, mutation, closeSwipe, refs };
}

describe("private-space swipe deletion and undo", () => {
  it("moves a swiped note to trash without a confirm dialog and offers Undo", async () => {
    const h = harness();
    await h.actions.deleteFromSwipe(h.original);
    expect(h.window.confirm).not.toHaveBeenCalled();
    expect(h.repo.get).toHaveBeenCalledWith(ACCOUNT, h.original.id);
    expect(h.repo.moveToTrash).toHaveBeenCalledWith(ACCOUNT, h.original.id);
    expect(h.updated).toHaveBeenCalledWith(h.deleted);
    expect(h.closeSwipe).toHaveBeenCalledWith(h.original.id);
    expect(h.mutation).toHaveBeenCalledOnce();
    expect(h.ui.addToast).toHaveBeenCalledWith("已删除 · 可撤销", 5_000, "info", expect.objectContaining({ label: "撤销", run: expect.any(Function) }));
    expect(h.refs.rowActionBusyId.value).toBe("");
  });

  it("reports a revision conflict instead of silently claiming Undo succeeded", async () => {
    const h = harness(null);
    h.actions.offerDispositionUndo(h.deleted, "deletedAt");
    const callback = h.ui.addToast.mock.calls[0][3].run;
    callback();
    await vi.waitFor(() => expect(h.ui.addToast).toHaveBeenCalledTimes(2));
    expect(h.repo.undoDisposition).toHaveBeenCalledWith(ACCOUNT, h.deleted.id, "deletedAt", 2, 12345, 0);
    expect(h.ui.addToast).toHaveBeenLastCalledWith("这一项已被修改，未撤销", 2_600, "info");
    expect(h.updated).not.toHaveBeenCalled();
    expect(h.mutation).not.toHaveBeenCalled();
  });
});
