import { getActivePinia } from "pinia";
import {
  useDebugLogsStore,
  type DebugLogCategory,
  type DebugLogLevel
} from "@/stores/debugLogs";
import { logger } from "@/utils/logger";
import { sanitizeDebugData } from "@/utils/debugSanitizer";
export { sanitizeDebugData } from "@/utils/debugSanitizer";

export function debugLog(
  category: DebugLogCategory,
  event: string,
  data?: Record<string, unknown>,
  level: DebugLogLevel = "debug"
) {
  const safeData = sanitizeDebugData(data);
  try {
    if (getActivePinia()) {
      useDebugLogsStore().addSanitized({ category, event, level, ...(safeData ? { data: safeData } : {}) });
    }
  } catch {
    // Diagnostics must never affect the application path being observed.
  }
  logger[level](`[${category}] ${event}`, safeData ?? {});
}

/**
 * A launch milestone. `ms` counts from the moment the page started loading,
 * so on a cold start it reads directly as "this long after opening HaiNei".
 * Filter the debug log by "startup_" to see the whole timeline.
 */
export function startupMark(event: string, data: Record<string, unknown> = {}) {
  const ms = typeof performance === "undefined" ? undefined : Math.round(performance.now());
  debugLog("system", `startup_${event}`, { ms, ...data }, "info");
}
