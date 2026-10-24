import { db, type BookmarkRecord, type HaiNeiDatabase } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class BookmarkRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  list(accountPubkey: string) {
    return this.database.accountBookmarks
      .where("accountPubkey")
      .equals(normalizeAccountPubkey(accountPubkey))
      .reverse()
      .sortBy("createdAt");
  }

  put(record: BookmarkRecord) {
    return this.database.accountBookmarks.put({
      ...record,
      accountPubkey: normalizeAccountPubkey(record.accountPubkey)
    });
  }

  get(accountPubkey: string, messageId: string) {
    return this.database.accountBookmarks.get([normalizeAccountPubkey(accountPubkey), messageId]);
  }

  /** CAS undo: never resurrect a bookmark removed again or changed elsewhere. */
  async restoreRemoval(accountPubkey: string, messageId: string, expectedUpdatedAt: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    let restored: BookmarkRecord | null = null;
    await this.database.transaction("rw", this.database.accountBookmarks, async () => {
      const current = await this.database.accountBookmarks.get([account, messageId]);
      if (!current?.deleted || current.updatedAt !== expectedUpdatedAt) return;
      restored = {
        ...current, deleted: false,
        updatedAt: Math.max(Date.now(), expectedUpdatedAt + 1),
      };
      await this.database.accountBookmarks.put(restored);
    });
    return restored;
  }

  delete(accountPubkey: string, messageId: string) {
    return this.database.accountBookmarks.delete([normalizeAccountPubkey(accountPubkey), messageId]);
  }
}

export const bookmarkRepository = new BookmarkRepository();
