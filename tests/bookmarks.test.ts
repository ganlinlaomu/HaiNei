import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HaiNeiDatabase } from "@/db/dexie";
import { BookmarkRepository } from "@/repositories/bookmarkRepository";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function repository() {
  const database = new HaiNeiDatabase(`bookmarks-${sequence++}`);
  databases.push(database);
  return new BookmarkRepository(database);
}

afterEach(async () => {
  const active = databases.splice(0);
  const names = active.map(database => database.name);
  active.forEach(database => database.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("private local bookmarks", () => {
  it("persists only the message reference", async () => {
    const bookmarks = repository();
    await bookmarks.put({ accountPubkey: ACCOUNT_A, messageId: "message-1", createdAt: 10 });
    expect(await bookmarks.list(ACCOUNT_A)).toEqual([{
      accountPubkey: ACCOUNT_A, messageId: "message-1", createdAt: 10
    }]);
  });

  it("isolates bookmarks by account", async () => {
    const bookmarks = repository();
    await bookmarks.put({ accountPubkey: ACCOUNT_A, messageId: "message-a", createdAt: 10 });
    await bookmarks.put({ accountPubkey: ACCOUNT_B, messageId: "message-b", createdAt: 20 });
    expect((await bookmarks.list(ACCOUNT_A)).map(item => item.messageId)).toEqual(["message-a"]);
    expect((await bookmarks.list(ACCOUNT_B)).map(item => item.messageId)).toEqual(["message-b"]);
  });

  it("undoes multiple removals independently, retaining bookmark identity for NIP-51", async () => {
    const bookmarks = repository();
    const now = Date.now();
    for (const [id, n] of [["a".repeat(64), 1], ["b".repeat(64), 2]] as const) {
      await bookmarks.put({ accountPubkey: ACCOUNT_A, messageId: id, createdAt: now - 10_000 + n, updatedAt: now - 10_000 + n, deleted: false });
    }
    const [one, two] = await bookmarks.list(ACCOUNT_A);
    await bookmarks.put({ ...one, deleted: true, updatedAt: now });
    await bookmarks.put({ ...two, deleted: true, updatedAt: now + 1 });
    const restored2 = await bookmarks.restoreRemoval(ACCOUNT_A, two.messageId, now + 1);
    const restored1 = await bookmarks.restoreRemoval(ACCOUNT_A, one.messageId, now);
    expect(restored1).toMatchObject({ createdAt: one.createdAt, deleted: false, messageId: one.messageId });
    expect(restored2).toMatchObject({ createdAt: two.createdAt, deleted: false, messageId: two.messageId });
    expect(restored1!.updatedAt).toBeGreaterThan(now);
    expect(restored2!.updatedAt).toBeGreaterThan(now + 1);
    expect(await bookmarks.restoreRemoval(ACCOUNT_A, one.messageId, now)).toBeNull();
    expect((await bookmarks.list(ACCOUNT_A)).filter(item => !item.deleted)).toHaveLength(2);
    expect(await bookmarks.list(ACCOUNT_B)).toHaveLength(0);
  });

  it("does not resurrect an item removed again after an earlier undo token", async () => {
    const bookmarks = repository();
    const id = "e".repeat(64);
    await bookmarks.put({ accountPubkey: ACCOUNT_A, messageId: id, createdAt: 100, updatedAt: 100, deleted: true });
    await bookmarks.put({ accountPubkey: ACCOUNT_A, messageId: id, createdAt: 100, updatedAt: 101, deleted: true });
    expect(await bookmarks.restoreRemoval(ACCOUNT_A, id, 100)).toBeNull();
    expect((await bookmarks.get(ACCOUNT_A, id))?.deleted).toBe(true);
  });

  it("does not depend on Nostr delivery or notifications", () => {
    const source = readFileSync(join(process.cwd(), "src/stores/bookmarks.ts"), "utf8");
    expect(source).not.toContain("sendDirectMessage");
    expect(source).not.toContain("notifications");
    expect(source).not.toContain("nostr");
  });
});
