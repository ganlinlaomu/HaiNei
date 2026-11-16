import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";

it("listRecentFeed reads only the newest Feed-class rows, newest first", async () => {
  const db = new HaiNeiDatabase("inbox-first-page");
  const repo = new SyncedMessageRepository(db);
  const account = "19".repeat(32);
  const other = "1a".repeat(32);
  const message = (id: string, createdAt: number, tags: string[][]) => ({
    id, createdAt, senderPubkey: other, recipientPubkeys: [account], conversationId: id,
    protocol: "nip17", transportKind: 1059, plaintext: id, tags,
  }) as any;
  try {
    for (let i = 0; i < 5; i++) await repo.insertMessageIfAbsent(account, message(`post-${i}`, 100 + i, [["t", "hainei-post"]]));
    await repo.insertMessageIfAbsent(account, message("dm-newest", 200, [["t", "hainei-dm"]]));
    await repo.insertMessageIfAbsent("1b".repeat(32), message("foreign", 300, [["t", "hainei-post"]]));
    const rows = await repo.listRecentFeed(account, 3);
    expect(rows.map(row => row.id)).toEqual(["post-4", "post-3", "post-2"]);
  } finally {
    db.close();
    await db.delete();
  }
});
