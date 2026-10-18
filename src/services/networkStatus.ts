import { readonly, ref } from "vue";

/**
 * Browser connectivity as reported by the OS. A dead WebSocket can take many
 * seconds to time out, so the UI reacts to these events immediately.
 */
const online = ref(typeof navigator === "undefined" || navigator.onLine !== false);
let installed = false;

function install() {
  if (installed || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  installed = true;
  window.addEventListener("online", () => { online.value = true; });
  window.addEventListener("offline", () => { online.value = false; });
}

install();

export const networkOnline = readonly(online);

export function isNetworkOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Errors that only mean "try again once connectivity is back". */
export function isOfflineSendError(error: unknown) {
  if (isNetworkOffline()) return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return /网络不可用|offline|Failed to fetch|NetworkError|network error/i.test(message);
}
