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
}

export const metaRepository = new MetaRepository();
