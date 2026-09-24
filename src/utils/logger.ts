import { deviceStorage } from "@/services/deviceStorage";

export function isDebugEnabled(): boolean {
  try {
    return deviceStorage.getItem("nostr_debug") === "1";
  } catch {
    return false;
  }
}

export const logger = {
  debug: (...args: any[]) => {
    if (isDebugEnabled()) {
      // keep debug messages quiet unless explicitly enabled
      console.debug("[debug]", ...args);
    }
  },
  info: (...args: any[]) => {
    console.info("[info]", ...args);
  },
  warn: (...args: any[]) => {
    // Always show warnings - they indicate potential issues
    console.warn("[warn]", ...args);
  },
  error: (...args: any[]) => {
    console.error("[error]", ...args);
  }
};
