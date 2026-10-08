import "fake-indexeddb/auto";
import Dexie from "dexie";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";
import { hasPrivateSpaceDraftContent, makeUnsavedPrivateSpaceDraft } from "@/services/privateSpaceDraft";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const dbs: HaiNeiDatabase[] = [];
let serial = 0;
function setup() {
  const database = new HaiNeiDatabase("private-space-draft-fixture-" + serial++, true);
  dbs.push(database);
  return { database, repo: new PrivateSpaceRepository(database) };
}
afterEach(async () => {
  lockLocalVault(ACCOUNT);
  lockLocalVault(OTHER);
  for (const database of dbs.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

describe("Private Space PR-FIX-A: no accidental empty records", () => {
  it("creates an in-memory draft without opening the database or scheduling cloud writes", async () => {
    const { repo } = setup();
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    const first = makeUnsavedPrivateSpaceDraft(ACCOUNT, "note");
    const second = makeUnsavedPrivateSpaceDraft(ACCOUNT, "todo");
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ title: "", body: "", tasks: [], revision: 1 });
    expect(second.kind).toBe("todo");
    expect(hasPrivateSpaceDraftContent(first)).toBe(false);
    expect(hasPrivateSpaceDraftContent(second)).toBe(false);
    expect(await repo.list(ACCOUNT)).toEqual([]);
  });

  it("does not materialize whitespace, pin-only or blank task rows", async () => {
    const { repo } = setup();
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    const draft = makeUnsavedPrivateSpaceDraft(ACCOUNT, "todo");
    expect(hasPrivateSpaceDraftContent({ title: " \n  ", body: "  ", tasks: [{ id: "x", text: " ", done: true }] })).toBe(false);
    await expect(repo.createWithContent(ACCOUNT, draft.id, {
      kind: "todo", title: " \t ", body: "", pinned: true, tasks: [],
    })).rejects.toThrow("private_space_empty_draft");
    expect(await repo.list(ACCOUNT)).toEqual([]);
  });

  it("atomically saves a title-only note once, encrypted, and preserves normal auto-save", async () => {
    const { database, repo } = setup();
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    const draft = makeUnsavedPrivateSpaceDraft(ACCOUNT, "note");
    const record = await repo.createWithContent(ACCOUNT, draft.id, {
      kind: "note", title: "Important", body: "", tasks: [], pinned: false,
    });
    expect(record.revision).toBe(1);
    expect(record.id).toBe(draft.id);
    expect(await repo.list(ACCOUNT)).toHaveLength(1);
    const raw: any = await new Promise((resolve, reject) => {
      const tx = database.backendDB().transaction("accountNotes", "readonly");
      const request = tx.objectStore("accountNotes").get([ACCOUNT, record.id]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(JSON.stringify(raw)).not.toContain("Important");
    expect(raw._vault?.v).toBe(1);
    const updated = await repo.save(ACCOUNT, draft.id, {
      kind: "note", title: "Important", body: "Added text", tasks: [], pinned: false,
    });
    expect(updated.revision).toBe(2);
    expect(await repo.list(ACCOUNT)).toHaveLength(1);
    // A second insert must never replace a previously saved record.
    await expect(repo.createWithContent(ACCOUNT, draft.id, {
      kind: "note", title: "Overwrite", body: "", tasks: [], pinned: false,
    })).rejects.toThrow();
    expect((await repo.get(ACCOUNT, draft.id))?.body).toBe("Added text");
  });

  it("materializes a new todo with task text and isolates every account", async () => {
    const { repo } = setup();
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    await unlockLocalVault(OTHER, "2".repeat(64));
    const draft = makeUnsavedPrivateSpaceDraft(ACCOUNT, "todo");
    const tasks = [{ id: "task1", text: "Buy coffee", done: false }];
    expect(hasPrivateSpaceDraftContent({ title: "", body: "", tasks })).toBe(true);
    const record = await repo.createWithContent(ACCOUNT, draft.id, {
      kind: "todo", title: "", body: "", tasks, pinned: false,
    });
    expect(record.tasks).toEqual(tasks);
    expect(await repo.list(OTHER)).toEqual([]);
    await expect(repo.createWithContent(OTHER, "z".repeat(65), {
      kind: "todo", title: "Other", body: "", tasks: [], pinned: false,
    })).rejects.toThrow("invalid_private_space_id");
  });

  it("wires quick-add, cancel, blur, background, route-leave and account-lock to the same flush", () => {
    const view = readFileSync(join(process.cwd(), "src/views/PrivateSpace.vue"), "utf8");
    expect(view).toContain("makeUnsavedPrivateSpaceDraft(account, kind)");
    expect(view).toContain("createWithContent(account, id, draft)");
    expect(view).toContain("if (isUnsavedDraft.value && !hasPrivateSpaceDraftContent(draft))");
    expect(view).toContain("if (backupBusy.value || editorTransitionBusy.value || editor.value");
    expect(view).toContain('aria-label="新的待办事项" @input="pendingTaskInput" @blur="addTask"');
    expect(view).toContain("if (commitPendingTaskInput()) queueSave()");
    expect(view).toContain('onBeforeRouteLeave(async () => {');
    expect(view).toContain('onBeforeAccountLock(async account => {');
    expect(view).toContain('document.visibilityState === "hidden"');
    expect(view).not.toContain("const created = await privateSpaceRepository.create(account, kind)");
    expect(view).not.toContain("updateInList(created);");
  });
});
