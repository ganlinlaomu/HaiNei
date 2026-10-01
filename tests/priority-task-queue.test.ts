import { describe, expect, it } from "vitest";
import { PriorityTaskQueue } from "@/utils/priorityTaskQueue";

describe("PriorityTaskQueue", () => {
  it("promotes queued work before lower-priority neighbors", async () => {
    const queue = new PriorityTaskQueue(1);
    const started: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.enqueue(async () => {
      started.push("first");
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      return "first";
    }, 0);
    const low = queue.enqueue(async () => {
      started.push("low");
      return "low";
    }, 2);
    const normal = queue.enqueue(async () => {
      started.push("normal");
      return "normal";
    }, 1);

    await Promise.resolve();
    expect(started).toEqual(["first"]);
    low.promote(0);
    releaseFirst();

    await Promise.all([first.promise, low.promise, normal.promise]);
    expect(started).toEqual(["first", "low", "normal"]);
  });

  it("cancels queued work without starting it", async () => {
    const queue = new PriorityTaskQueue(1);
    let releaseBlocker!: () => void;
    let cancelledStarted = false;

    const blocker = queue.enqueue(async () => {
      await new Promise<void>(resolve => { releaseBlocker = resolve; });
    }, 0);
    const cancelled = queue.enqueue(async () => {
      cancelledStarted = true;
    }, 1);

    await Promise.resolve();
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledStarted).toBe(false);

    releaseBlocker();
    await blocker.promise;
  });
});
