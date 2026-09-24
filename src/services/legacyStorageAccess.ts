/** The sole production access point for one-time legacy localStorage migration. */
export function legacyBrowserStorageForMigration(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
