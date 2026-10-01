export type BackgroundPriority = "normal" | "low";

type ScheduleOptions = {
  priority?: BackgroundPriority;
  delayMs?: number;
  timeoutMs?: number;
};

const USER_ACTIVITY_GRACE_MS = 500;
let activityListenersInstalled = false;
let lastUserActivityAt = 0;

function noteUserActivity() {
  lastUserActivityAt = Date.now();
}

function installActivityListeners() {
  if (activityListenersInstalled || typeof window === "undefined" || typeof document === "undefined") return;
  activityListenersInstalled = true;
  const passive = { passive: true } as AddEventListenerOptions;
  window.addEventListener("pointerdown", noteUserActivity, passive);
  window.addEventListener("touchmove", noteUserActivity, passive);
  window.addEventListener("scroll", noteUserActivity, passive);
  window.addEventListener("keydown", noteUserActivity);
  document.addEventListener("input", noteUserActivity, true);
}

function runIdle(task: () => void, timeoutMs: number) {
  const requestIdle = (globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  const cancelIdle = (globalThis as typeof globalThis & {
    cancelIdleCallback?: (handle: number) => void;
  }).cancelIdleCallback;

  if (typeof requestIdle === "function") {
    const handle = requestIdle(task, { timeout: timeoutMs });
    return () => cancelIdle?.(handle);
  }
  const handle = setTimeout(task, Math.min(120, timeoutMs));
  return () => clearTimeout(handle);
}

export function scheduleBackgroundWork(task: () => void, options: ScheduleOptions = {}) {
  installActivityListeners();
  const priority = options.priority || "low";
  const delayMs = Math.max(0, options.delayMs || 0);
  const timeoutMs = Math.max(100, options.timeoutMs || 1_500);
  let cancelled = false;
  let cancelPending: (() => void) | null = null;

  const run = () => {
    if (cancelled) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      const handle = setTimeout(run, 250);
      cancelPending = () => clearTimeout(handle);
      return;
    }
    if (priority === "low") {
      const quietFor = Date.now() - lastUserActivityAt;
      if (quietFor < USER_ACTIVITY_GRACE_MS) {
        const handle = setTimeout(run, USER_ACTIVITY_GRACE_MS - quietFor);
        cancelPending = () => clearTimeout(handle);
        return;
      }
      cancelPending = runIdle(() => {
        cancelPending = null;
        if (!cancelled) task();
      }, timeoutMs);
      return;
    }
    task();
  };

  const handle = setTimeout(run, delayMs);
  cancelPending = () => clearTimeout(handle);

  return () => {
    cancelled = true;
    cancelPending?.();
    cancelPending = null;
  };
}
