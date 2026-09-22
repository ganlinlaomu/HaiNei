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

  it("does not depend on Nostr delivery or notifications", () => {
    const source = readFileSync(join(process.cwd(), "src/stores/bookmarks.ts"), "utf8");
    expect(source).not.toContain("sendDirectMessage");
    expect(source).not.toContain("notifications");
    expect(source).not.toContain("nostr");
  });
});
