import { db, type DmRelayDirectoryRecord, type HaiNeiDatabase } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class DmRelayDirectoryRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  get(accountPubkey: string, ownerPubkey: string) {
    return this.database.dmRelayDirectory.get([
      normalizeAccountPubkey(accountPubkey),
      normalizeAccountPubkey(ownerPubkey),
    ]);
  }

  async put(record: DmRelayDirectoryRecord) {
    const normalized = {
      ...record,
      accountPubkey: normalizeAccountPubkey(record.accountPubkey),
      ownerPubkey: normalizeAccountPubkey(record.ownerPubkey),
    };
    await this.database.dmRelayDirectory.put(normalized);
    return normalized;
  }

  list(accountPubkey: string) {
    return this.database.dmRelayDirectory
      .where("accountPubkey")
      .equals(normalizeAccountPubkey(accountPubkey))
      .toArray();
  }

  delete(accountPubkey: string, ownerPubkey: string) {
    return this.database.dmRelayDirectory.delete([
      normalizeAccountPubkey(accountPubkey),
      normalizeAccountPubkey(ownerPubkey),
    ]);
  }

  async prune(accountPubkey: string, maxPeerRecords = 500, now = Date.now()) {
    const account = normalizeAccountPubkey(accountPubkey);
    const rows = await this.list(account);
    const expiredNegative = rows.filter(record =>
      record.ownerPubkey !== account
      && record.source === "negative"
      && record.expiresAt <= now
    );
    const expiredKeys = new Set(expiredNegative.map(record => record.ownerPubkey));
    const retainedPeers = rows
      .filter(record => record.ownerPubkey !== account && !expiredKeys.has(record.ownerPubkey))
      .sort((left, right) => right.fetchedAt - left.fetchedAt);
    const overflow = retainedPeers.slice(Math.max(0, maxPeerRecords));
    const ownerPubkeys = [...new Set([
      ...expiredNegative.map(record => record.ownerPubkey),
      ...overflow.map(record => record.ownerPubkey),
    ])];
    if (ownerPubkeys.length) {
      await this.database.dmRelayDirectory.bulkDelete(
        ownerPubkeys.map(ownerPubkey => [account, ownerPubkey] as [string, string]),
      );
    }
    return ownerPubkeys.length;
  }
}

export const dmRelayDirectoryRepository = new DmRelayDirectoryRepository();
