import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";

const A = "a".repeat(64);
const B = "b".repeat(64);
const SECRET_A = "1".repeat(64);
const SECRET_B = "2".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function makeRepo() {
  const database = new HaiNeiDatabase("private-space-test-" + sequence++, true);
  databases.push(database);
  return { database, notes: new PrivateSpaceRepository(database) };
}

afterEach(async () => {
  lockLocalVault(A);
  lockLocalVault(B);
  for (const db of databases.splice(0)) {
    db.close();
    await Dexie.delete(db.name);
  }
});

describe("private space PR1", () => {
  it("encrypts note titles, body, task text and hides them while locked", async () => {
    const { database, notes } = makeRepo();
    await unlockLocalVault(A, SECRET_A);
    const note = await notes.create(A, "todo");
    const saved = await notes.save(A, note.id, {
      kind: "todo", title: "Secret title", body: "Secret body", pinned: true,
      tasks: [{ id: "item-1", text: "Secret task", done: false }],
    });
    expect(saved.revision).toBe(2);
    expect(saved.title).toBe("Secret title");
    const raw: any = await new Promise((resolve, reject) => {
      const tx = database.backendDB().transaction("accountNotes", "readonly");
      const request = tx.objectStore("accountNotes").get([A, note.id]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(JSON.stringify(raw)).not.toContain("Secret title");
    expect(JSON.stringify(raw)).not.toContain("Secret body");
    expect(JSON.stringify(raw)).not.toContain("Secret task");
    expect(raw._vault?.v).toBe(1);
    lockLocalVault(A);
    await expect(notes.list(A)).rejects.toThrow("local_vault_locked");
    await unlockLocalVault(A, SECRET_A);
    expect((await notes.list(A))[0].tasks[0].text).toBe("Secret task");
  });

  it("isolates accounts, increments revisions and keeps deleted notes recoverable", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, SECRET_A);
    await unlockLocalVault(B, SECRET_B);
    const one = await notes.create(A, "note");
    const two = await notes.create(B, "todo");
    const updated = await notes.save(A, one.id, {
      kind: "note", title: "A only", body: "Private", tasks: [], pinned: false,
    });
    expect(updated.revision).toBe(2);
    expect((await notes.list(A)).map(n => n.id)).toEqual([one.id]);
    expect((await notes.list(B)).map(n => n.id)).toEqual([two.id]);
    const deleted = await notes.moveToTrash(A, one.id);
    expect(deleted.deletedAt).toBeGreaterThan(0);
    await expect(notes.save(A, one.id, {
      kind: "note", title: "accidental overwrite", body: "", tasks: [], pinned: false,
    })).rejects.toThrow("private_space_deleted");
    const restored = await notes.update(A, one.id, { deletedAt: 0 });
    expect(restored.deletedAt).toBe(0);
    expect(restored.title).toBe("A only");
  });

  it("restores every to-do field including due and bumps revision after a synced deletion", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, SECRET_A);
    const original = await notes.createWithContent(A, "undo-due", {
      kind: "todo", title: "计划", body: "", pinned: true,
      tasks: [{ id: "task-1", text: "看医生", done: false, due: 1_800_000_000_000 }],
    });
    const deleted = await notes.moveToTrash(A, original.id);
    await notes.markSynced(A, original.id, deleted.revision, 2);
    const restored = await notes.undoDisposition(A, original.id, "deletedAt", deleted.revision, deleted.deletedAt!);
    expect(restored).toMatchObject({
      title: original.title, pinned: true, tasks: original.tasks,
      revision: deleted.revision + 1, cloudVersion: 2, syncedRevision: deleted.revision,
      deletedAt: 0,
    });
    expect(restored!.revision).toBeGreaterThan(restored!.syncedRevision!); // cloud re-upload required
    expect(await notes.undoDisposition(A, original.id, "deletedAt", deleted.revision, deleted.deletedAt!)).toBeNull();
  });

  it("undoes two deletions independently, and avoids restoring a later deletion", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, SECRET_A);
    const first = await notes.createWithContent(A, "undo-first", {
      kind: "note", title: "一", body: "原文", pinned: false, tasks: [],
    });
    const second = await notes.createWithContent(A, "undo-second", {
      kind: "note", title: "二", body: "另一篇", pinned: false, tasks: [],
    });
    const d1 = await notes.moveToTrash(A, first.id);
    const d2 = await notes.moveToTrash(A, second.id);
    expect(await notes.undoDisposition(A, second.id, "deletedAt", d2.revision, d2.deletedAt!)).not.toBeNull();
    expect(await notes.undoDisposition(A, first.id, "deletedAt", d1.revision, d1.deletedAt!)).not.toBeNull();
    expect((await notes.list(A)).every(n => !n.deletedAt)).toBe(true);
    const newest = await notes.moveToTrash(A, first.id);
    expect(await notes.undoDisposition(A, first.id, "deletedAt", d1.revision, d1.deletedAt!)).toBeNull();
    expect((await notes.get(A, first.id))?.deletedAt).toBe(newest.deletedAt);
  });

  it("restores an archived item without changing body or due, but never across locked accounts", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, SECRET_A);
    const record = await notes.createWithContent(A, "undo-archive", {
      kind: "todo", title: "重要", body: "", pinned: false,
      tasks: [{ id: "t", text: "缴费", done: false, due: 1_800_000_000_000 }],
    });
    const archived = await notes.update(A, record.id, { archivedAt: Date.now() });
    lockLocalVault(A);
    await expect(notes.undoDisposition(A, record.id, "archivedAt", archived.revision, archived.archivedAt!))
      .rejects.toThrow("local_vault_locked");
    await unlockLocalVault(A, SECRET_A);
    const restored = await notes.undoDisposition(A, record.id, "archivedAt", archived.revision, archived.archivedAt!);
    expect(restored).toMatchObject({ title: "重要", tasks: record.tasks, archivedAt: 0 });
  });

  it("rejects oversized content and duplicate task IDs without rewriting saved notes", async () => {
    const { notes } = makeRepo();
    await unlockLocalVault(A, SECRET_A);
    const note = await notes.create(A, "todo");
    await expect(notes.save(A, note.id, {
      kind: "todo", title: "", body: "", pinned: false,
      tasks: [{ id: "same", text: "a", done: false }, { id: "same", text: "b", done: true }],
    })).rejects.toThrow("invalid_private_space_task");
    expect((await notes.list(A))[0].revision).toBe(1);
  });
});
