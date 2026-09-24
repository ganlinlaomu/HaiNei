import { db } from "@/db/dexie";
import { legacyBrowserStorageForMigration } from "@/services/legacyStorageAccess";

const values = new Map<string, string>();
let hydrated = false;

export async function hydrateDeviceStorage() {
  if (hydrated) return;
  const rows = await db.deviceKeyValues.toArray();
  values.clear();
  for (const row of rows) values.set(row.key, row.value);
  hydrated = true;
}

export const deviceStorage = {
  getItem: (key: string) => {
    if (import.meta.env.MODE === "test") return legacyBrowserStorageForMigration()?.getItem(key) ?? values.get(key) ?? null;
    return values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    const serialized = String(value);
    values.set(key, serialized);
    if (import.meta.env.MODE === "test") legacyBrowserStorageForMigration()?.setItem(key, serialized);
    if (typeof indexedDB !== "undefined") void db.deviceKeyValues.put({ key, value: serialized, updatedAt: Date.now() });
  },
  removeItem(key: string) {
    values.delete(key);
    if (import.meta.env.MODE === "test") legacyBrowserStorageForMigration()?.removeItem(key);
    if (typeof indexedDB !== "undefined") void db.deviceKeyValues.delete(key);
  },
  key: (index: number) => import.meta.env.MODE === "test"
    ? legacyBrowserStorageForMigration()?.key(index) ?? null
    : [...values.keys()][index] ?? null,
  get length() { return import.meta.env.MODE === "test" ? legacyBrowserStorageForMigration()?.length || 0 : values.size; },
};

export async function putDeviceValue(key: string, value: string) {
  await db.deviceKeyValues.put({ key, value, updatedAt: Date.now() });
  values.set(key, value);
}

export async function getDeviceValue(key: string) {
  if (!hydrated) await hydrateDeviceStorage();
  return values.get(key) ?? null;
}
