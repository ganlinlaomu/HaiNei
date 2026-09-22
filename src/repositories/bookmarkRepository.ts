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

  delete(accountPubkey: string, messageId: string) {
    return this.database.accountBookmarks.delete([normalizeAccountPubkey(accountPubkey), messageId]);
  }
}

export const bookmarkRepository = new BookmarkRepository();
