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
      useDebugLogsStore().add({ category, event, level, ...(safeData ? { data: safeData } : {}) });
    }
  } catch {
    // Diagnostics must never affect the application path being observed.
  }
  logger[level](`[${category}] ${event}`, safeData ?? {});
}
