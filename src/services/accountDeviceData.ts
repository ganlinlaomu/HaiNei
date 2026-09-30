import { db, type HaiNeiDatabase } from "@/db/dexie";
import { clearPrivateDeviceValues, removeDeviceValue } from "./deviceStorage";

export async function clearAccountDeviceData(
  account: string,
  database: HaiNeiDatabase = db,
) {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("invalid_account");
  const tables = database.tables.filter(
    (table) =>
      table.schema.primKey.keyPath === "accountPubkey" ||
      table.schema.indexes.some((index) => index.name === "accountPubkey"),
  );
  const deviceRows = await database.deviceKeyValues.toArray();
  // Only keys explicitly scoped to this account are eligible for deletion.
  const keys = deviceRows
    .filter((row) => row.key.endsWith(`_${account}`))
    .map((row) => row.key);
  // Key-only native deletion also works while locked; Dexie's delete hooks
  // fetch row values and would otherwise require decrypting the deleted rows.
  await new Promise<void>((resolve, reject) => {
    const transaction = database
      .backendDB()
      .transaction(
        [...tables.map((table) => table.name), "deviceKeyValues"],
        "readwrite",
      );
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error || new Error("account_deletion_aborted"));
    for (const table of tables) {
      const store = transaction.objectStore(table.name);
      const source =
        table.schema.primKey.keyPath === "accountPubkey"
          ? store
          : store.index("accountPubkey");
      const request = source.openKeyCursor(IDBKeyRange.only(account));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    const devices = transaction.objectStore("deviceKeyValues");
    for (const key of keys) devices.delete(key);
  });
  for (const key of keys) await removeDeviceValue(key);
  clearPrivateDeviceValues(account);
}
