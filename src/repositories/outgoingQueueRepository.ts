import { db, type HaiNeiDatabase, type OutgoingQueueRecord, type OutgoingQueueState } from "@/db/dexie";

const UNSENT_STATES: OutgoingQueueState[] = ["pending", "sending", "waiting_network", "failed"];
/** A sent row can still owe a Push request for this long (see service.ts). */
export const SENT_PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Sent rows older than this are deleted; the message itself is in syncedMessages. */
export const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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

  /** Unsent rows, via the state index: no sent row is read or decrypted. */
  listUnsent(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.outgoingQueue.where("[accountPubkey+state]")
      .anyOf(UNSENT_STATES.map(state => [account, state])).toArray();
  }

  /** Sent rows updated at or after `since`, newest first. */
  listSentSince(accountPubkey: string, since: number, limit = 50) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.outgoingQueue.where("[accountPubkey+state+updatedAt]")
      .between([account, "sent", since], [account, "sent", Number.MAX_SAFE_INTEGER], true, true)
      .reverse().limit(limit).toArray();
  }

  /**
   * Delete sent rows last updated before `before`, except `keep` (ids still
   * referenced by an unfinished DM task). Only primary keys are read, so no
   * sealed payload is decrypted.
   */
  async pruneSent(accountPubkey: string, before: number, keep: ReadonlySet<string> = new Set()) {
    const account = normalizeAccountPubkey(accountPubkey);
    const keys = await this.database.outgoingQueue.where("[accountPubkey+state+updatedAt]")
      .between([account, "sent", 0], [account, "sent", before], true, false)
      .primaryKeys() as Array<[string, string]>;
    const doomed = keys.filter(([, outgoingId]) => !keep.has(outgoingId));
    if (doomed.length) await this.database.outgoingQueue.bulkDelete(doomed);
    return doomed.length;
  }

  async listRetryable(accountPubkey: string, includeFailed = false, now = Date.now()) {
    // A sent row is retryable only for its pending Push, which expires within
    // SENT_PUSH_WINDOW_MS of sending; older sent rows are not read at all.
    const [unsent, recentSent] = await Promise.all([
      this.listUnsent(accountPubkey),
      this.listSentSince(accountPubkey, now - SENT_PUSH_WINDOW_MS - 60_000, Number.MAX_SAFE_INTEGER),
    ]);
    const records = [...unsent, ...recentSent];
    return records.filter(record => {
      if (record.state === "sent") {
        return record.pushState === "pending" && (record.pushExpiresAt || 0) > now;
      }
      return (
        record.state === "pending" || record.state === "sending" || record.state === "waiting_network" ||
        (includeFailed && record.state === "failed")
      ) && (includeFailed || !record.nextAttemptAt || record.nextAttemptAt <= now);
    });
  }
}

export const outgoingQueueRepository = new OutgoingQueueRepository();
