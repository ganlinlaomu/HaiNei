import type { App } from "vue";
import { debugLog } from "@/utils/debugLog";
import { useDebugLogsStore } from "@/stores/debugLogs";

// A blank-but-alive screen and a hot phone left no trace in the logs. These
// record what the page was doing: script errors, Vue warnings, main-thread
// stalls (a busy loop shows up here) and a periodic "still alive" mark.
const STALL_CHECK_MS = 1_000;
const STALL_REPORT_MS = 2_500;
const ALIVE_EVERY_MS = 15_000;
const MAX_VUE_WARNINGS = 20;

let installed = false;

function brief(value: unknown) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
  return text.slice(0, 200);
}

export function installRuntimeDiagnostics(app: App) {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", event => {
    debugLog("system", "js_error", { message: brief(event.error || event.message), source: String(event.filename || "").split("/").pop(), line: event.lineno }, "error");
  });
  window.addEventListener("unhandledrejection", event => {
    debugLog("system", "unhandled_rejection", { message: brief(event.reason) }, "warn");
  });

  const previousError = app.config.errorHandler;
  app.config.errorHandler = (error, instance, info) => {
    debugLog("ui", "vue_error", { message: brief(error), info: String(info).slice(0, 80), component: instance?.$options?.name || "" }, "error");
    if (previousError) previousError(error, instance, info);
    else console.error(error);
  };
  let vueWarnings = 0;
  const previousWarn = app.config.warnHandler;
  app.config.warnHandler = (message, instance, trace) => {
    // "Maximum recursive updates exceeded" is how a render loop surfaces.
    if (vueWarnings++ < MAX_VUE_WARNINGS) debugLog("ui", "vue_warning", { message: brief(message), trace: String(trace).slice(0, 160) }, "warn");
    if (previousWarn) previousWarn(message, instance, trace);
    else console.warn(message, trace);
  };

  const logs = useDebugLogsStore();
  let lastTick = Date.now();
  let lastAlive = 0;
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (document.visibilityState !== "visible") return;
    // Timers do not run while hidden; only a visible gap is a stall.
    if (gap > STALL_REPORT_MS && document.hasFocus?.() !== false) {
      debugLog("system", "main_thread_stall", { ms: gap }, "warn");
    }
    if (now - lastAlive >= ALIVE_EVERY_MS) {
      lastAlive = now;
      logs.noteAlive();
    }
  }, STALL_CHECK_MS);
  document.addEventListener("visibilitychange", () => { lastTick = Date.now(); });
}
