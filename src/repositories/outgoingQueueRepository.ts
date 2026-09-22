import { db, type HaiNeiDatabase, type OutgoingQueueRecord } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class OutgoingQueueRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  get(accountPubkey: string, outgoingId: string) {
    return this.database.outgoingQueue.get([normalizeAccountPubkey(accountPubkey), outgoingId]);
  }

  async putIfAbsent(record: OutgoingQueueRecord) {
    const account = normalizeAccountPubkey(record.accountPubkey);
    const existing = await this.database.outgoingQueue.get([account, record.outgoingId]);
    if (existing) return existing;
    const normalized = { ...record, accountPubkey: account };
    await this.database.outgoingQueue.add(normalized);
    return normalized;
  }

  async update(accountPubkey: string, outgoingId: string, patch: Partial<OutgoingQueueRecord>) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.outgoingQueue.update([account, outgoingId], { ...patch, accountPubkey: account, outgoingId });
    return this.get(account, outgoingId);
  }

  list(accountPubkey: string) {
    return this.database.outgoingQueue.where("accountPubkey").equals(normalizeAccountPubkey(accountPubkey)).toArray();
  }

  async listRetryable(accountPubkey: string, includeFailed = false, now = Date.now()) {
    const records = await this.list(accountPubkey);
    return records.filter(record =>
      record.state === "pending" || record.state === "sending" || record.state === "waiting_network" ||
      (includeFailed && record.state === "failed")
    ).filter(record => includeFailed || !record.nextAttemptAt || record.nextAttemptAt <= now);
  }
}

export const outgoingQueueRepository = new OutgoingQueueRepository();
