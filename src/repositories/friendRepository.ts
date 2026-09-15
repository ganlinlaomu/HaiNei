import {
  db,
  type AccountFriendRecord,
  type DBFriend,
  type HaiNeiDatabase
} from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class FriendRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  async list(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountFriends.where("accountPubkey").equals(account).toArray();
  }

  async get(accountPubkey: string, friendPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const friend = normalizeAccountPubkey(friendPubkey);
    return this.database.accountFriends.get([account, friend]);
  }

  async put(accountPubkey: string, friend: DBFriend) {
    const account = normalizeAccountPubkey(accountPubkey);
    const record: AccountFriendRecord = {
      ...friend,
      pubkey: normalizeAccountPubkey(friend.pubkey),
      accountPubkey: account
    };
    await this.database.accountFriends.put(record);
    return record;
  }
}

export const friendRepository = new FriendRepository();
