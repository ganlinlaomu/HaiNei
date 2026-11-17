import { onAppResume } from "@/services/appResumeCoordinator";
import { debugLog, startupMark } from "@/utils/debugLog";
import { reloadOnceForRecovery } from "@/utils/restoreWatchdog";

/**
 * iOS can bring a long-suspended PWA back with its content area unpainted:
 * the bottom bar (an old snapshot) shows, the content stays blank, and the
 * page may not even be told it is visible again. Seen 2026-11-16 after 33
 * minutes in the background: socket errors were logged, but no resume event
 * and no visible heartbeat for 10 s, until the user swiped the app away.
 */
export const REPAINT_AFTER_HIDDEN_MS = 60_000;
export const RELOAD_AFTER_HIDDEN_MS = 30 * 60_000;
/** A touch on a page that has believed itself hidden this long is a stuck page. */
export const STUCK_HIDDEN_MS = 3_000;
const THAW_CHECK_MS = 2_000;
const THAW_GAP_MS = 30_000;

export type ResumeAction = "none" | "repaint" | "reload";

export function decideResumeAction(hiddenMs: number, busy: boolean): ResumeAction {
  if (hiddenMs >= RELOAD_AFTER_HIDDEN_MS && !busy) return "reload";
  if (hiddenMs >= REPAINT_AFTER_HIDDEN_MS) return "repaint";
  return "none";
}

/** Make WebKit repaint the content without changing what is shown. */
export function forceRepaint(root: HTMLElement | null = document.getElementById("app")) {
  if (!root) return Promise.resolve(-1);
  const started = performance.now();
  // Scroll, not transform: #app is the scroll container of the fixed bottom
  // bar, and a transform there would make that bar jump for a frame.
  const top = root.scrollTop;
  root.scrollTop = top + 1;
  root.scrollTop = top;
  return new Promise<number>(resolve => {
    let done = false;
    const finish = (ms: number) => {
      if (done) return;
      done = true;
      resolve(ms);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => finish(Math.round(performance.now() - started))));
    // A page that is not painting never runs rAF; report that instead of waiting.
    setTimeout(() => finish(-1), 1_000);
  });
}

let installed = false;

export function installResumeRecovery(options: {
  /** True while a reload would lose something (a call, an open post editor). */
  isBusy: () => boolean;
  reload?: (reason: string) => boolean;
  now?: () => number;
}) {
  if (installed || typeof document === "undefined") return () => undefined;
  installed = true;
  const now = options.now || Date.now;
  const reload = options.reload || reloadOnceForRecovery;
  let hiddenAt = document.visibilityState === "hidden" ? now() : 0;

  const onVisibility = () => {
    if (document.visibilityState === "hidden") hiddenAt = now();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const stopResume = onAppResume(reason => {
    if (!hiddenAt) return;
    const hiddenMs = now() - hiddenAt;
    hiddenAt = 0;
    const busy = options.isBusy();
    const action = decideResumeAction(hiddenMs, busy);
    startupMark("resume_check", { reason, hiddenMs, busy, action });
    if (action === "reload") {
      reload("long_background");
    } else if (action === "repaint") {
      void forceRepaint().then(rafMs => startupMark("resume_repainted", { hiddenMs, rafMs }));
    }
  });

  // The stuck case: WebKit shows the page but still reports it hidden. A
  // genuinely backgrounded page cannot be touched, so a touch proves it.
  const onTouch = () => {
    if (document.visibilityState !== "hidden" || !hiddenAt || now() - hiddenAt < STUCK_HIDDEN_MS) return;
    debugLog("system", "touch_while_hidden", { hiddenMs: now() - hiddenAt }, "error");
    if (!options.isBusy()) reload("touch_while_hidden");
  };
  document.addEventListener("touchstart", onTouch, { capture: true, passive: true });
  document.addEventListener("pointerdown", onTouch, { capture: true, passive: true });

  // Record every thaw from a long freeze, whatever visibility claims, so the
  // next blank resume shows what state the page was in.
  let lastTick = now();
  const timer = setInterval(() => {
    const tick = now();
    const gap = tick - lastTick;
    lastTick = tick;
    if (gap < THAW_GAP_MS) return;
    startupMark("thawed", {
      frozenMs: gap,
      visibility: document.visibilityState,
      focused: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    });
  }, THAW_CHECK_MS);

  return () => {
    installed = false;
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("touchstart", onTouch, { capture: true });
    document.removeEventListener("pointerdown", onTouch, { capture: true });
    clearInterval(timer);
    stopResume();
  };
}
