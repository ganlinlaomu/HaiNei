import Dexie from "dexie";
import {
  db,
  type AccountMessageRecord,
  type DBMessage,
  type HaiNeiDatabase
} from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class MessageRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  async get(accountPubkey: string, id: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountMessages.get([account, id]);
  }

  async listLatest(accountPubkey: string, limit = 1000) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.accountMessages
      .where("[accountPubkey+created_at]")
      .between([account, Dexie.minKey], [account, Dexie.maxKey])
      .reverse()
      .limit(limit)
      .toArray();
  }

  async listByPeer(accountPubkey: string, peerPubkey: string, limit = 1000) {
    const account = normalizeAccountPubkey(accountPubkey);
    const peer = normalizeAccountPubkey(peerPubkey);
    return this.database.accountMessages
      .where("[accountPubkey+pubkey+created_at]")
      .between(
        [account, peer, Dexie.minKey],
        [account, peer, Dexie.maxKey]
      )
      .reverse()
      .limit(limit)
      .toArray();
  }

  async put(accountPubkey: string, message: DBMessage) {
    const account = normalizeAccountPubkey(accountPubkey);
    const record: AccountMessageRecord = {
      ...message,
      pubkey: normalizeAccountPubkey(message.pubkey),
      accountPubkey: account
    };
    await this.database.accountMessages.put(record);
    return record;
  }

  async delete(accountPubkey: string, id: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.accountMessages.delete([account, id]);
  }
}

export const messageRepository = new MessageRepository();
