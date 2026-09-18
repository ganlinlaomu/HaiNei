import { db, type FriendshipRecord, type HaiNeiDatabase } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class FriendshipRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  list(accountPubkey: string) {
    return this.database.accountFriendships.where("accountPubkey").equals(normalizeAccountPubkey(accountPubkey)).toArray();
  }

  get(accountPubkey: string, peerPubkey: string) {
    return this.database.accountFriendships.get([
      normalizeAccountPubkey(accountPubkey), normalizeAccountPubkey(peerPubkey)
    ]);
  }

  put(record: FriendshipRecord) {
    return this.database.accountFriendships.put({
      ...record,
      accountPubkey: normalizeAccountPubkey(record.accountPubkey),
      peerPubkey: normalizeAccountPubkey(record.peerPubkey)
    });
  }

  delete(accountPubkey: string, peerPubkey: string) {
    return this.database.accountFriendships.delete([
      normalizeAccountPubkey(accountPubkey), normalizeAccountPubkey(peerPubkey)
    ]);
  }
}

export const friendshipRepository = new FriendshipRepository();
