export type BackgroundPriority = "high" | "normal" | "idle";

type ScheduledTask = {
  key: string;
  run: () => void | Promise<void>;
  priority: BackgroundPriority;
  timeoutMs: number;
  deadlineAt: number;
};

type ScheduledRecord = {
  priority: BackgroundPriority;
  cancel: () => void;
};

type IdleTask = ScheduledTask & {
  cancelled: boolean;
};

const scheduled = new Map<string, ScheduledRecord>();
const idleTasks = new Map<string, IdleTask>();
const FALLBACK_IDLE_DELAY_MS = 40;
const RESUME_STAGGER_MS = 32;

let busyUntil = 0;
let monitorCleanup: (() => void) | null = null;
let idleHandle: number | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityCleanup: (() => void) | null = null;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isPageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function cancelDrainHandles() {
  if (idleHandle !== null) {
    (globalThis as typeof globalThis & { cancelIdleCallback?: (handle: number) => void })
      .cancelIdleCallback?.(idleHandle);
    idleHandle = null;
  }
  if (wakeTimer !== null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

function removeVisibilityWakeIfUnused() {
  if (idleTasks.size || !visibilityCleanup) return;
  visibilityCleanup();
  visibilityCleanup = null;
}

function ensureVisibilityWake() {
  if (visibilityCleanup || typeof document === "undefined") return;
  const handleVisibilityChange = () => {
    cancelDrainHandles();
    if (document.visibilityState === "hidden") return;
    requestIdleDrain(RESUME_STAGGER_MS);
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  visibilityCleanup = () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function nextIdleTimeout() {
  const timestamp = now();
  let remaining = Number.POSITIVE_INFINITY;
  for (const task of idleTasks.values()) {
    remaining = Math.min(remaining, task.deadlineAt - timestamp);
  }
  return Number.isFinite(remaining) ? Math.max(1, Math.ceil(remaining)) : 1_000;
}

function runIdleTask() {
  idleHandle = null;
  wakeTimer = null;

  if (!idleTasks.size) {
    removeVisibilityWakeIfUnused();
    return;
  }
  if (isPageHidden()) {
    ensureVisibilityWake();
    return;
  }
  if (now() < busyUntil) {
    requestIdleDrain();
    return;
  }

  const task = idleTasks.values().next().value as IdleTask | undefined;
  if (!task) {
    removeVisibilityWakeIfUnused();
    return;
  }

  idleTasks.delete(task.key);
  scheduled.delete(task.key);
  if (!task.cancelled) {
    void Promise.resolve(task.run()).catch(error => {
      console.warn("[background] task failed", task.key, error);
    });
  }

  if (idleTasks.size) requestIdleDrain(RESUME_STAGGER_MS);
  else removeVisibilityWakeIfUnused();
}

function requestIdleDrain(delayMs = 0) {
  if (!idleTasks.size) {
    cancelDrainHandles();
    removeVisibilityWakeIfUnused();
    return;
  }

  ensureVisibilityWake();
  if (isPageHidden()) {
    cancelDrainHandles();
    return;
  }

  cancelDrainHandles();

  const timestamp = now();
  if (timestamp < busyUntil) {
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null;
        requestIdleDrain();
      },
      Math.max(1, Math.ceil(busyUntil - timestamp)),
    );
    return;
  }

  if (delayMs > 0) {
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      requestIdleDrain();
    }, delayMs);
    return;
  }

  const requestIdle = (globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;

  if (typeof requestIdle === "function") {
    idleHandle = requestIdle(runIdleTask, { timeout: nextIdleTimeout() });
  } else {
    wakeTimer = setTimeout(runIdleTask, Math.min(FALLBACK_IDLE_DELAY_MS, nextIdleTimeout()));
  }
}

export function noteForegroundActivity(durationMs = 450) {
  busyUntil = Math.max(busyUntil, now() + durationMs);
  if (idleTasks.size) requestIdleDrain();
}

export function yieldToMainThread() {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
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
    deadlineAt: now() + (options.timeoutMs || 2_000),
  };

  if (task.priority === "high") {
    let cancelled = false;
    scheduled.set(key, {
      priority: task.priority,
      cancel: () => { cancelled = true; },
    });
    queueMicrotask(() => {
      if (cancelled) return;
      scheduled.delete(key);
      void Promise.resolve(run()).catch(error => console.warn("[background] task failed", key, error));
    });
  } else if (task.priority === "normal") {
    const handle = setTimeout(() => {
      scheduled.delete(key);
      void Promise.resolve(run()).catch(error => console.warn("[background] task failed", key, error));
    }, 0);
    scheduled.set(key, {
      priority: task.priority,
      cancel: () => clearTimeout(handle),
    });
  } else {
    const idleTask: IdleTask = { ...task, cancelled: false };
    idleTasks.set(key, idleTask);
    scheduled.set(key, {
      priority: task.priority,
      cancel: () => {
        idleTask.cancelled = true;
        idleTasks.delete(key);
      },
    });
    requestIdleDrain();
  }

  return () => cancelBackgroundTask(key);
}

export function cancelBackgroundTask(key: string) {
  const record = scheduled.get(key);
  record?.cancel();
  scheduled.delete(key);
  if (record?.priority === "idle") {
    idleTasks.delete(key);
    if (idleTasks.size) requestIdleDrain();
    else {
      cancelDrainHandles();
      removeVisibilityWakeIfUnused();
    }
  }
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
    busyUntil = 0;
    if (idleTasks.size) requestIdleDrain();
  };
  return monitorCleanup;
}
