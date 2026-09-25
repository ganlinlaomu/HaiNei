import { db, type FriendshipRecord, type HaiNeiDatabase } from "@/db/dexie";
import { normalizeAccountPubkey } from "@/repositories/accountScope";

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string") throw new TypeError(`invalid ${field}`);
  return value;
}

function requiredNumber(value: unknown, field: string) {
  if (typeof value !== "number") throw new TypeError(`invalid ${field}`);
  return value;
}

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
    const plainRecord: FriendshipRecord = {
      accountPubkey: normalizeAccountPubkey(record.accountPubkey),
      peerPubkey: normalizeAccountPubkey(record.peerPubkey),
      state: requiredString(record.state, "friendship state") as FriendshipRecord["state"],
      ...(typeof record.requestEventId === "string" ? { requestEventId: record.requestEventId } : {}),
      ...(typeof record.acceptedEventId === "string" ? { acceptedEventId: record.acceptedEventId } : {}),
      ...(typeof record.requestedAt === "number" ? { requestedAt: record.requestedAt } : {}),
      ...(typeof record.acceptedAt === "number" ? { acceptedAt: record.acceptedAt } : {}),
      ...(Array.isArray(record.acceptedWindows) ? {
        acceptedWindows: Array.from(record.acceptedWindows, window => ({
          acceptedAt: requiredNumber(window.acceptedAt, "acceptedAt"),
          acceptedEventId: requiredString(window.acceptedEventId, "acceptedEventId"),
          ...(typeof window.endedAt === "number" ? { endedAt: window.endedAt } : {}),
          ...(typeof window.endedEventId === "string" ? { endedEventId: window.endedEventId } : {})
        }))
      } : {}),
      ...(typeof record.lastAction === "string" ? { lastAction: record.lastAction } : {}),
      ...(typeof record.lastControlAt === "number" ? { lastControlAt: record.lastControlAt } : {}),
      ...(typeof record.lastControlEventId === "string" ? { lastControlEventId: record.lastControlEventId } : {}),
      updatedAt: requiredNumber(record.updatedAt, "updatedAt")
    };
    return this.database.accountFriendships.put(plainRecord);
  }

  delete(accountPubkey: string, peerPubkey: string) {
    return this.database.accountFriendships.delete([
      normalizeAccountPubkey(accountPubkey), normalizeAccountPubkey(peerPubkey)
    ]);
  }
}

export const friendshipRepository = new FriendshipRepository();
