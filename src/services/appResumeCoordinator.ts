export type AppResumeReason = "visibilitychange" | "focus" | "pageshow" | "online";
export type AppResumeHandler = (reason: AppResumeReason) => void | Promise<void>;

const handlers = new Set<AppResumeHandler>();
const COALESCE_MS = 1_000;
let installed = false;
let lastDispatchAt = 0;

function canDispatch() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function dispatch(reason: AppResumeReason) {
  if (!canDispatch()) return;
  const now = Date.now();
  if (lastDispatchAt && now - lastDispatchAt < COALESCE_MS) return;
  lastDispatchAt = now;
  for (const handler of [...handlers]) {
    try {
      void Promise.resolve(handler(reason)).catch(error => {
        console.warn("[lifecycle] foreground resume handler failed", error);
      });
    } catch (error) {
      console.warn("[lifecycle] foreground resume handler failed", error);
    }
  }
}

function visibilityHandler() {
  if (document.visibilityState === "visible") dispatch("visibilitychange");
}
function focusHandler() { dispatch("focus"); }
function pageShowHandler() { dispatch("pageshow"); }
function onlineHandler() { dispatch("online"); }

function install() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  lastDispatchAt = 0;
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("focus", focusHandler);
  window.addEventListener("pageshow", pageShowHandler);
  window.addEventListener("online", onlineHandler);
}

function uninstall() {
  if (!installed || typeof window === "undefined" || typeof document === "undefined") {
    installed = false;
    lastDispatchAt = 0;
    return;
  }
  document.removeEventListener("visibilitychange", visibilityHandler);
  window.removeEventListener("focus", focusHandler);
  window.removeEventListener("pageshow", pageShowHandler);
  window.removeEventListener("online", onlineHandler);
  installed = false;
  lastDispatchAt = 0;
}

export function onAppResume(handler: AppResumeHandler) {
  handlers.add(handler);
  install();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) uninstall();
  };
}

export function resetAppResumeCoordinatorForTests() {
  handlers.clear();
  uninstall();
}
