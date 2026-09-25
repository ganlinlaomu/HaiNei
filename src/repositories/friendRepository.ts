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
      accountPubkey: account,
      pubkey: normalizeAccountPubkey(friend.pubkey),
      ...(typeof friend.name === "string" ? { name: friend.name } : {}),
      ...(typeof friend.group === "string" ? { group: friend.group } : {}),
      ...(Array.isArray(friend.groups)
        ? { groups: Array.from(friend.groups).filter((group): group is string => typeof group === "string") }
        : {}),
      ...(typeof friend.note === "string" ? { note: friend.note } : {}),
      ...(typeof friend.updatedAt === "number" ? { updatedAt: friend.updatedAt } : {}),
      ...(typeof friend.deleted === "boolean" ? { deleted: friend.deleted } : {})
    };
    await this.database.accountFriends.put(record);
    return record;
  }
}

export const friendRepository = new FriendRepository();
