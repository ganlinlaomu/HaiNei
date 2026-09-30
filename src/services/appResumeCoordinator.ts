export type AppResumeReason = "visibilitychange" | "focus" | "pageshow" | "online";
export type AppResumeHandler = (reason: AppResumeReason) => void | Promise<void>;

const handlers = new Set<AppResumeHandler>();
const COALESCE_MS = 1_000;
let installed = false;
let lastDispatchAt = 0;

function canDispatch(reason: AppResumeReason) {
  if (typeof document === "undefined") return true;
  if (reason === "online") return document.visibilityState !== "hidden";
  return document.visibilityState !== "hidden";
}

function dispatch(reason: AppResumeReason) {
  if (!canDispatch(reason)) return;
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

function install() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("focus", () => dispatch("focus"));
  window.addEventListener("pageshow", () => dispatch("pageshow"));
  window.addEventListener("online", () => dispatch("online"));
}

export function onAppResume(handler: AppResumeHandler) {
  handlers.add(handler);
  install();
  return () => handlers.delete(handler);
}

export function resetAppResumeCoordinatorForTests() {
  handlers.clear();
  lastDispatchAt = 0;
}
