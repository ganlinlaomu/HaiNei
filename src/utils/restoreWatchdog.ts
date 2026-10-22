import { debugLog } from "@/utils/debugLog";

// iOS WebKit occasionally throws inside an IndexedDB event handler ("UnknownError:
// Cannot inject key into script value"); the awaiting Dexie request then never
// settles. Session restore hung forever, the router (which waits for it) froze
// and the menu stopped responding until the PWA was swiped away. A reload is
// exactly what fixed it, so do that once, automatically.
export const RESTORE_WATCHDOG_MS = 10_000;
const RELOAD_GUARD_KEY = "hainei-restore-reload-at";
const RELOAD_GUARD_MS = 2 * 60_000;
// Lets the launch log (marks + this error) reach IndexedDB before reloading.
const RELOAD_DELAY_MS = 600;
const STORAGE_ERROR = /^(UnknownError|AbortError|InvalidStateError|DatabaseClosedError|OpenFailedError|DataError|TransactionInactiveError)$/;

export function isStorageFailure(error: unknown) {
  return error instanceof Error && (STORAGE_ERROR.test(error.name) || /IDB|IndexedDB|Cannot inject key/i.test(error.message));
}

/** Reload at most once per guard window, so a persistent failure cannot loop. */
export function reloadOnceForRecovery(reason: string, reload: () => void = () => window.location.reload()) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    if (Date.now() - last < RELOAD_GUARD_MS) {
      debugLog("account", "recovery_reload_skipped", { reason }, "error");
      return false;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Without session storage there is no loop guard; do not risk a loop.
    return false;
  }
  debugLog("account", "recovery_reload", { reason }, "error");
  setTimeout(reload, RELOAD_DELAY_MS);
  return true;
}

/**
 * Run session restore with a watchdog. A restore that rejects with a storage
 * error, or has not settled after RESTORE_WATCHDOG_MS of visible time, reloads
 * the page once.
 */
export async function restoreWithWatchdog(restore: () => Promise<void>, reload?: () => void) {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    timer = null;
    if (settled) return;
    // Timers stall in the background; judge only while the app is visible.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      document.addEventListener("visibilitychange", () => { if (!settled) timer = setTimeout(check, RESTORE_WATCHDOG_MS); }, { once: true });
      return;
    }
    debugLog("account", "session_restore_stuck", { ms: RESTORE_WATCHDOG_MS }, "error");
    reloadOnceForRecovery("session_restore_stuck", reload);
  };
  timer = setTimeout(check, RESTORE_WATCHDOG_MS);
  try {
    await restore();
  } catch (error) {
    debugLog("account", "session_restore_error", { name: error instanceof Error ? error.name : "unknown", message: String(error instanceof Error ? error.message : error).slice(0, 160) }, "error");
    if (isStorageFailure(error)) reloadOnceForRecovery("session_restore_storage_error", reload);
    throw error;
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}
