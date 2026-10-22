import { isStorageFailure } from "@/utils/restoreWatchdog";
import { debugLog } from "@/utils/debugLog";

/**
 * Retry a read that failed with a transient IndexedDB error. On iOS, WebKit
 * sometimes cannot restore a stored CryptoKey on the first read after the PWA
 * starts; reopening the database and reading again usually succeeds.
 */
export async function retryStorageRead<T>(label: string, read: () => Promise<T>, attempts = 3, delayMs = 150): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await read();
      if (attempt > 1) debugLog("storage", "storage_read_recovered", { label, attempt }, "warn");
      return value;
    } catch (error) {
      if (attempt >= attempts || !isStorageFailure(error)) throw error;
      debugLog("storage", "storage_read_retry", {
        label, attempt, name: error instanceof Error ? error.name : "unknown",
        message: String(error instanceof Error ? error.message : error).slice(0, 120),
      }, "warn");
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}
