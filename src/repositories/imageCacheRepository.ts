import Dexie from "dexie";
import {
  db,
  type AccountImageCacheRecord,
  type HaiNeiDatabase
} from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

const totalBytesKey = (account: string) => `media_cache_bytes_${account}`;

export type ImageCacheStats = {
  count: number;
  size: number;
  oldestTimestamp: number;
};

export class ImageCacheRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  private async readTotalBytes(account: string) {
    const value = (await this.database.deviceKeyValues.get(totalBytesKey(account)))?.value;
    const total = Number(value);
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  private async writeTotalBytes(account: string, total: number) {
    await this.database.deviceKeyValues.put({
      key: totalBytesKey(account),
      value: String(Math.max(0, Math.floor(total))),
      updatedAt: Date.now(),
    });
  }

  async get(accountPubkey: string, cacheId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountImageCache.get([account, cacheId]);
  }

  async put(
    accountPubkey: string,
    entry: Omit<AccountImageCacheRecord, "accountPubkey">,
  ) {
    const account = normalizeAccountPubkey(accountPubkey);
    const record: AccountImageCacheRecord = { ...entry, accountPubkey: account };
    return this.database.transaction(
      "rw",
      this.database.accountImageCache,
      this.database.deviceKeyValues,
      async () => {
        const previous = await this.database.accountImageCache.get([account, entry.cacheId]);
        const total = await this.readTotalBytes(account);
        await this.database.accountImageCache.put(record);
        await this.writeTotalBytes(
          account,
          total - (previous?.size || 0) + record.size,
        );
        return record;
      },
    );
  }

  async touch(accountPubkey: string, cacheId: string, lastAccess = Date.now()) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.accountImageCache.update([account, cacheId], { lastAccess });
  }

  async delete(accountPubkey: string, cacheId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.transaction(
      "rw",
      this.database.accountImageCache,
      this.database.deviceKeyValues,
      async () => {
        const previous = await this.database.accountImageCache.get([account, cacheId]);
        if (!previous) return false;
        const total = await this.readTotalBytes(account);
        await this.database.accountImageCache.delete([account, cacheId]);
        await this.writeTotalBytes(account, total - previous.size);
        return true;
      },
    );
  }

  async clear(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.transaction(
      "rw",
      this.database.accountImageCache,
      this.database.deviceKeyValues,
      async () => {
        const deleted = await this.database.accountImageCache
          .where("accountPubkey")
          .equals(account)
          .delete();
        await this.writeTotalBytes(account, 0);
        return deleted;
      },
    );
  }

  async trimToBytes(accountPubkey: string, maxBytes: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    let total = await this.readTotalBytes(account);
    let evicted = 0;

    while (total > maxBytes) {
      const removed = await this.database.transaction(
        "rw",
        this.database.accountImageCache,
        this.database.deviceKeyValues,
        async () => {
          const oldest = await this.database.accountImageCache
            .where("[accountPubkey+lastAccess]")
            .between([account, Dexie.minKey], [account, Dexie.maxKey])
            .first();
          if (!oldest) {
            await this.writeTotalBytes(account, 0);
            return 0;
          }
          const currentTotal = await this.readTotalBytes(account);
          await this.database.accountImageCache.delete([account, oldest.cacheId]);
          const nextTotal = Math.max(0, currentTotal - oldest.size);
          await this.writeTotalBytes(account, nextTotal);
          return oldest.size;
        },
      );
      if (!removed) break;
      total = Math.max(0, total - removed);
      evicted += 1;
    }

    return evicted;
  }

  async getStats(accountPubkey: string): Promise<ImageCacheStats> {
    const account = normalizeAccountPubkey(accountPubkey);
    const [count, size, oldest] = await Promise.all([
      this.database.accountImageCache.where("accountPubkey").equals(account).count(),
      this.readTotalBytes(account),
      this.database.accountImageCache
        .where("[accountPubkey+lastAccess]")
        .between([account, Dexie.minKey], [account, Dexie.maxKey])
        .first(),
    ]);
    return {
      count,
      size,
      oldestTimestamp: oldest?.timestamp || 0,
    };
  }

  async list(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountImageCache.where("accountPubkey").equals(account).toArray();
  }
}

export const imageCacheRepository = new ImageCacheRepository();
