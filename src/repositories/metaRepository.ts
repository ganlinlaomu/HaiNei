import {
  db,
  type AccountMetaRecord,
  type HaiNeiDatabase
} from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class MetaRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  async get(accountPubkey: string, key: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountMeta.get([account, key]);
  }

  async put(accountPubkey: string, key: string, value: unknown) {
    const account = normalizeAccountPubkey(accountPubkey);
    const record: AccountMetaRecord = { accountPubkey: account, key, value };
    await this.database.accountMeta.put(record);
    return record;
  }

  async delete(accountPubkey: string, key: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.accountMeta.delete([account, key]);
  }

  async listPrefix(accountPubkey: string, prefix: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountMeta
      .where("accountPubkey")
      .equals(account)
      .filter(record => record.key.startsWith(prefix))
      .toArray();
  }
}

export const metaRepository = new MetaRepository();
