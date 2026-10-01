export type BackgroundPriority = "high" | "normal" | "idle";

type ScheduledTask = {
  key: string;
  run: () => void | Promise<void>;
  priority: BackgroundPriority;
  timeoutMs: number;
};

const scheduled = new Map<string, () => void>();
let busyUntil = 0;
let monitorCleanup: (() => void) | null = null;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function noteForegroundActivity(durationMs = 450) {
  busyUntil = Math.max(busyUntil, now() + durationMs);
}

function scheduleIdle(task: ScheduledTask) {
  let cancelled = false;
  let idleHandle: number | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const execute = () => {
    if (cancelled) return;
    if ((typeof document !== "undefined" && document.visibilityState === "hidden") || now() < busyUntil) {
      timeoutHandle = setTimeout(execute, 120);
      return;
    }
    scheduled.delete(task.key);
    void Promise.resolve(task.run()).catch(error => {
      console.warn("[background] task failed", task.key, error);
    });
  };

  const requestIdle = (globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  if (typeof requestIdle === "function") {
    idleHandle = requestIdle(execute, { timeout: task.timeoutMs });
  } else {
    timeoutHandle = setTimeout(execute, Math.min(220, task.timeoutMs));
  }

  return () => {
    cancelled = true;
    if (idleHandle !== null) (globalThis as any).cancelIdleCallback?.(idleHandle);
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  };
}

export function scheduleBackgroundTask(
  key: string,
  run: () => void | Promise<void>,
  options: { priority?: BackgroundPriority; timeoutMs?: number } = {},
) {
  cancelBackgroundTask(key);
  const task: ScheduledTask = {
    key,
    run,
    priority: options.priority || "idle",
    timeoutMs: options.timeoutMs || 2_000,
  };
  let cancel: () => void;
  if (task.priority === "high") {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      scheduled.delete(key);
      void Promise.resolve(run()).catch(error => console.warn("[background] task failed", key, error));
    });
    cancel = () => { cancelled = true; };
  } else if (task.priority === "normal") {
    const handle = setTimeout(() => {
      scheduled.delete(key);
      void Promise.resolve(run()).catch(error => console.warn("[background] task failed", key, error));
    }, 0);
    cancel = () => clearTimeout(handle);
  } else {
    cancel = scheduleIdle(task);
  }
  scheduled.set(key, cancel);
  return cancel;
}

export function cancelBackgroundTask(key: string) {
  scheduled.get(key)?.();
  scheduled.delete(key);
}

export function installForegroundActivityMonitor() {
  if (monitorCleanup || typeof window === "undefined") return monitorCleanup || (() => undefined);
  const mark = () => noteForegroundActivity();
  const events: Array<keyof WindowEventMap> = ["pointerdown", "touchstart", "keydown", "wheel", "scroll", "input"];
  for (const event of events) window.addEventListener(event, mark, { passive: true, capture: true });
  window.visualViewport?.addEventListener("resize", mark, { passive: true });
  monitorCleanup = () => {
    for (const event of events) window.removeEventListener(event, mark, true);
    window.visualViewport?.removeEventListener("resize", mark);
    monitorCleanup = null;
  };
  return monitorCleanup;
}
