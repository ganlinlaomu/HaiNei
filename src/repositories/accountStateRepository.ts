import { db, type AccountStateMirrorRecord, type AccountStateNamespace } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class AccountStateRepository {
  get(accountPubkey: string, namespace: AccountStateNamespace) {
    return db.accountStateMirrors.get([normalizeAccountPubkey(accountPubkey), namespace]);
  }

  list(accountPubkey: string) {
    return db.accountStateMirrors.where("accountPubkey").equals(normalizeAccountPubkey(accountPubkey)).toArray();
  }

  put(record: AccountStateMirrorRecord) {
    return db.accountStateMirrors.put({ ...record, accountPubkey: normalizeAccountPubkey(record.accountPubkey) });
  }
}

export const accountStateRepository = new AccountStateRepository();
