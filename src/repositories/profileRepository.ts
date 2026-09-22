import { db, type AccountProfileRecord, type HaiNeiDatabase, type HaiNeiProfile } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

export class ProfileRepository {
  constructor(private readonly database: HaiNeiDatabase = db) {}

  list(accountPubkey: string) {
    return this.database.accountProfiles.where("accountPubkey").equals(normalizeAccountPubkey(accountPubkey)).toArray();
  }

  get(accountPubkey: string, ownerPubkey: string) {
    return this.database.accountProfiles.get([
      normalizeAccountPubkey(accountPubkey), normalizeAccountPubkey(ownerPubkey)
    ]);
  }

  async putLatest(accountPubkey: string, profile: HaiNeiProfile) {
    const account = normalizeAccountPubkey(accountPubkey);
    const owner = normalizeAccountPubkey(profile.ownerPubkey);
    let stored = false;
    await this.database.transaction("rw", this.database.accountProfiles, async () => {
      const current = await this.database.accountProfiles.get([account, owner]);
      if (current && current.updatedAt >= profile.updatedAt) return;
      const record: AccountProfileRecord = { ...profile, accountPubkey: account, ownerPubkey: owner };
      await this.database.accountProfiles.put(record);
      stored = true;
    });
    return stored;
  }
}

export const profileRepository = new ProfileRepository();
