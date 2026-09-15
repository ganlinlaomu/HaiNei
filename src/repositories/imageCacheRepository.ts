import Dexie from "dexie";
import {
  db,
  type AccountImageCacheRecord,
  type DBImageCache,
  type HaiNeiDatabase
} from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class ImageCacheRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  async get(accountPubkey: string, url: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountImageCache.get([account, url]);
  }

  async put(accountPubkey: string, entry: DBImageCache) {
    const account = normalizeAccountPubkey(accountPubkey);
    const record: AccountImageCacheRecord = { ...entry, accountPubkey: account };
    await this.database.accountImageCache.put(record);
    return record;
  }

  async delete(accountPubkey: string, url: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.accountImageCache.delete([account, url]);
  }

  async deleteExpired(accountPubkey: string, cutoffTimestamp: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountImageCache
      .where("[accountPubkey+timestamp]")
      .between([account, Dexie.minKey], [account, cutoffTimestamp])
      .delete();
  }

  async clear(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountImageCache.where("accountPubkey").equals(account).delete();
  }

  async list(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountImageCache.where("accountPubkey").equals(account).toArray();
  }
}

export const imageCacheRepository = new ImageCacheRepository();
