import { db, type HaiNeiDatabase, type OutgoingDmTaskRecord } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class OutgoingDmTaskRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  get(accountPubkey: string, localId: string) {
    return this.database.outgoingDmTasks.get([normalizeAccountPubkey(accountPubkey), localId]);
  }

  async put(record: OutgoingDmTaskRecord) {
    const normalized = { ...record, accountPubkey: normalizeAccountPubkey(record.accountPubkey) };
    await this.database.outgoingDmTasks.put(normalized);
    return normalized;
  }

  async update(accountPubkey: string, localId: string, patch: Partial<OutgoingDmTaskRecord>) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.outgoingDmTasks.update([account, localId], { ...patch, accountPubkey: account, localId });
    return this.get(account, localId);
  }

  list(accountPubkey: string) {
    return this.database.outgoingDmTasks.where("accountPubkey").equals(normalizeAccountPubkey(accountPubkey)).toArray();
  }
}

export const outgoingDmTaskRepository = new OutgoingDmTaskRepository();
