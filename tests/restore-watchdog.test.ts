// An iOS IndexedDB error left session restore pending forever; the router
// waited on it and the whole UI froze until the PWA was swiped away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isStorageFailure, reloadOnceForRecovery, restoreWithWatchdog, RESTORE_WATCHDOG_MS } from "@/utils/restoreWatchdog";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

let visibility = "visible";
const visibilityListeners: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  visibilityListeners.length = 0;
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("document", {
    get visibilityState() { return visibility; },
    addEventListener: (_type: string, listener: () => void) => { visibilityListeners.push(listener); },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session restore watchdog", () => {
  it("reloads once when restore never settles", async () => {
    const reload = vi.fn();
    void restoreWithWatchdog(() => new Promise<void>(() => undefined), reload);
    await vi.advanceTimersByTimeAsync(RESTORE_WATCHDOG_MS + 1_000);
    expect(reload).toHaveBeenCalledOnce();

    // A second hang right after the reload must not start a reload loop.
    const again = vi.fn();
    void restoreWithWatchdog(() => new Promise<void>(() => undefined), again);
    await vi.advanceTimersByTimeAsync(RESTORE_WATCHDOG_MS + 1_000);
    expect(again).not.toHaveBeenCalled();
  });

  it("reloads on an IndexedDB failure but not on other errors or success", async () => {
    const reload = vi.fn();
    const idbError = Object.assign(new Error("Cannot inject key into script value"), { name: "UnknownError" });
    await expect(restoreWithWatchdog(() => Promise.reject(idbError), reload)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledOnce();

    vi.stubGlobal("sessionStorage", new MemoryStorage());
    const other = vi.fn();
    await expect(restoreWithWatchdog(() => Promise.reject(new TypeError("bad credential")), other)).rejects.toThrow();
    await restoreWithWatchdog(async () => undefined, other);
    await vi.advanceTimersByTimeAsync(RESTORE_WATCHDOG_MS * 2);
    expect(other).not.toHaveBeenCalled();
    expect(isStorageFailure(Object.assign(new Error("x"), { name: "DatabaseClosedError" }))).toBe(true);
  });

  it("does not judge a restore while the app is in the background", async () => {
    const reload = vi.fn();
    let finish!: () => void;
    visibility = "hidden";
    const pending = restoreWithWatchdog(() => new Promise<void>(resolve => { finish = resolve; }), reload);
    await vi.advanceTimersByTimeAsync(RESTORE_WATCHDOG_MS * 3);
    expect(reload).not.toHaveBeenCalled();
    // Back in the foreground, restore completes normally: no reload.
    visibility = "visible";
    visibilityListeners.forEach(listener => listener());
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(RESTORE_WATCHDOG_MS * 2);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOnceForRecovery("manual", reload)).toBe(true);
  });
});
