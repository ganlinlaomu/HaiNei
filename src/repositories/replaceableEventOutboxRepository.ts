import { db, type HaiNeiDatabase, type ReplaceableEventOutboxRecord } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class ReplaceableEventOutboxRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  get(accountPubkey: string, key: string) {
    return this.database.replaceableEventOutbox.get([normalizeAccountPubkey(accountPubkey), key]);
  }

  async putLatest(record: ReplaceableEventOutboxRecord) {
    const normalized = { ...record, accountPubkey: normalizeAccountPubkey(record.accountPubkey) };
    await this.database.replaceableEventOutbox.put(normalized);
    return normalized;
  }

  async update(accountPubkey: string, key: string, patch: Partial<ReplaceableEventOutboxRecord>) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.replaceableEventOutbox.update([account, key], { ...patch, accountPubkey: account, key });
    return this.get(account, key);
  }

  delete(accountPubkey: string, key: string) {
    return this.database.replaceableEventOutbox.delete([normalizeAccountPubkey(accountPubkey), key]);
  }

  list(accountPubkey: string) {
    return this.database.replaceableEventOutbox
      .where("accountPubkey")
      .equals(normalizeAccountPubkey(accountPubkey))
      .toArray();
  }
}

export const replaceableEventOutboxRepository = new ReplaceableEventOutboxRepository();
