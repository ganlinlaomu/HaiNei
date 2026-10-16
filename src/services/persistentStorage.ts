import { debugLog } from "@/utils/debugLog";

export type PersistentStorageState = "persisted" | "best-effort" | "unsupported";

// Keys, messages and the private space live in IndexedDB. Without a
// persistence grant the browser may evict them under storage pressure, which
// signs the user out of an account that may exist only on this device.
let request: Promise<PersistentStorageState> | null = null;

function storageManager() {
  return typeof navigator !== "undefined" ? navigator.storage : undefined;
}

/** Ask once per session, after login, so the (Firefox) prompt has context. */
export function requestPersistentStorage(): Promise<PersistentStorageState> {
  if (request) return request;
  const storage = storageManager();
  if (!storage?.persist) return Promise.resolve("unsupported");
  request = (async () => {
    try {
      if (await storage.persisted?.()) return "persisted";
      const granted = await storage.persist();
      debugLog("storage", "persistent_storage_requested", { granted }, granted ? "info" : "warn");
      return granted ? "persisted" : "best-effort";
    } catch (error) {
      debugLog("storage", "persistent_storage_failed", { reason: error instanceof Error ? error.name : "unknown" }, "warn");
      request = null;
      return "best-effort";
    }
  })();
  return request;
}

export async function persistentStorageState(): Promise<PersistentStorageState> {
  const storage = storageManager();
  if (!storage?.persisted) return "unsupported";
  try {
    return (await storage.persisted()) ? "persisted" : "best-effort";
  } catch {
    return "best-effort";
  }
}

export function resetPersistentStorageRequestForTests() {
  request = null;
}
