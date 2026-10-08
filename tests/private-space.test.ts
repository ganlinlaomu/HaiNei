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
