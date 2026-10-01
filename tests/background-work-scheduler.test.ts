import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MutableDocument = EventTarget & { visibilityState: "visible" | "hidden" };

describe("background work scheduler", () => {
  let fakeDocument: MutableDocument;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: fakeDocument,
    });
    Object.defineProperty(globalThis, "requestIdleCallback", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, "cancelIdleCallback", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "requestIdleCallback");
    Reflect.deleteProperty(globalThis, "cancelIdleCallback");
  });

  it("sleeps while hidden and wakes from visibilitychange without polling", async () => {
    const { scheduleBackgroundTask } = await import("@/services/backgroundWorkScheduler");
    const run = vi.fn();
    fakeDocument.visibilityState = "hidden";

    scheduleBackgroundTask("hidden", run, { priority: "idle", timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();

    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("defers idle work during foreground activity and supports cancellation", async () => {
    const { cancelBackgroundTask, noteForegroundActivity, scheduleBackgroundTask } =
      await import("@/services/backgroundWorkScheduler");
    const run = vi.fn();

    noteForegroundActivity(500);
    scheduleBackgroundTask("busy", run, { priority: "idle" });
    await vi.advanceTimersByTimeAsync(499);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    scheduleBackgroundTask("cancelled", cancelled, { priority: "idle" });
    cancelBackgroundTask("cancelled");
    await vi.advanceTimersByTimeAsync(500);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("stages resumed idle tasks instead of starting them in one burst", async () => {
    const { scheduleBackgroundTask } = await import("@/services/backgroundWorkScheduler");
    const order: string[] = [];

    scheduleBackgroundTask("one", () => order.push("one"), { priority: "idle" });
    scheduleBackgroundTask("two", () => order.push("two"), { priority: "idle" });

    await vi.advanceTimersByTimeAsync(45);
    expect(order).toEqual(["one"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["one", "two"]);
  });
});
