import { db } from "@/db/dexie";
import { legacyBrowserStorageForMigration } from "@/services/legacyStorageAccess";

const values = new Map<string, string>();
let hydrated = false;
const pendingWrites = new Set<Promise<void>>();
function trackWrite(write: Promise<void>) {
 pendingWrites.add(write);
 void write.catch(() => console.warn("[storage] device value write failed")).finally(() => pendingWrites.delete(write));
}
export async function flushDeviceWrites() { await Promise.all([...pendingWrites]); }

const privateDeviceKey = /^(?:nostr_(?:inbox|outbox|post_draft|settings|connection_health|notifications(?:_dismissed|_meta)?)|interactions)_([0-9a-f]{64})$/i;
function privateAccount(key: string) { return key.match(privateDeviceKey)?.[1]?.toLowerCase(); }
export function clearPrivateDeviceValues(account: string) {
 for(const key of values.keys()) if(privateAccount(key)===account)values.delete(key);
}
export async function hydratePrivateDeviceValues(account: string) {
 // Upgrade old device rows one at a time, deleting only after encrypted commit.
 const legacy = await db.deviceKeyValues.toArray();
 for(const row of legacy) if(privateAccount(row.key)===account) {
  await db.accountMeta.put({accountPubkey:account,key:`private-device:${row.key}`,value:row.value});
  await db.deviceKeyValues.delete(row.key);
 }
 const rows=await db.accountMeta.where("accountPubkey").equals(account).filter(row=>row.key.startsWith("private-device:")).toArray();
 for(const row of rows)values.set(row.key.slice("private-device:".length),String(row.value));
}


export async function hydrateDeviceStorage() {
  if (hydrated) return;
  const rows = await db.deviceKeyValues.toArray();
  values.clear();
  for (const row of rows) if (!privateAccount(row.key)) values.set(row.key, row.value);
  hydrated = true;
}

export const deviceStorage = {
  getItem: (key: string) => {
    if (import.meta.env.MODE === "test") return legacyBrowserStorageForMigration()?.getItem(key) ?? values.get(key) ?? null;
    return values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    trackWrite(putDeviceValue(key, String(value)));
  },
  removeItem(key: string) {
    trackWrite(removeDeviceValue(key));
  },
  key: (index: number) => import.meta.env.MODE === "test"
    ? legacyBrowserStorageForMigration()?.key(index) ?? null
    : [...values.keys()][index] ?? null,
  get length() { return import.meta.env.MODE === "test" ? legacyBrowserStorageForMigration()?.length || 0 : values.size; },
};

export async function putDeviceValue(key: string, value: string) {
  const serialized = String(value);
  values.set(key, serialized);
  if (import.meta.env.MODE === "test") legacyBrowserStorageForMigration()?.setItem(key, serialized);
  if (typeof indexedDB !== "undefined") {
    const account=privateAccount(key);
    if(account) await db.accountMeta.put({accountPubkey:account,key:`private-device:${key}`,value:serialized});
    else await db.deviceKeyValues.put({ key, value: serialized, updatedAt: Date.now() });
  }
}

export async function removeDeviceValue(key: string) {
  values.delete(key);
  if (import.meta.env.MODE === "test") legacyBrowserStorageForMigration()?.removeItem(key);
  if (typeof indexedDB !== "undefined") {
    const account=privateAccount(key);
    if(account)await db.accountMeta.delete([account,`private-device:${key}`]);
    await db.deviceKeyValues.delete(key);
  }
}

export async function getDeviceValue(key: string) {
  if (!hydrated) await hydrateDeviceStorage();
  return values.get(key) ?? null;
}
