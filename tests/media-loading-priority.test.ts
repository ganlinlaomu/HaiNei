import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPrioritizedTaskQueue } from "@/utils/prioritizedTaskQueue";

describe("prioritized media loading", () => {
  it("promotes a queued task when it becomes the current image", async () => {
    const queue = createPrioritizedTaskQueue(1);
    const order: string[] = [];
    let release!: () => void;

    const blocker = queue.schedule(async () => {
      order.push("blocker");
      await new Promise<void>(resolve => { release = resolve; });
      return "blocker";
    }, 0);
    const adjacent = queue.schedule(async () => { order.push("adjacent"); return "adjacent"; }, 1);
    const becomesCurrent = queue.schedule(async () => { order.push("current"); return "current"; }, 2);

    await vi.waitFor(() => expect(order).toEqual(["blocker"]));
    becomesCurrent.promote(0);
    release();
    await Promise.all([blocker.promise, adjacent.promise, becomesCurrent.promise]);

    expect(order).toEqual(["blocker", "current", "adjacent"]);
  });

  it("cancels an unused queued task without consuming a concurrency slot", async () => {
    const queue = createPrioritizedTaskQueue(1);
    let release!: () => void;
    const ran = vi.fn();

    const blocker = queue.schedule(async () => {
      await new Promise<void>(resolve => { release = resolve; });
    }, 0);
    const pending = queue.schedule(async () => { ran(); }, 1);
    pending.cancel();

    await expect(pending.promise).rejects.toMatchObject({ name: "AbortError" });
    release();
    await blocker.promise;
    expect(ran).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(queue.snapshot()).toEqual({ active: 0, queued: 0 }));
  });

  it("opens the viewer from preview immediately, upgrades only current/adjacent originals, and keeps retry/cancellation hooks", () => {
    const preview = readFileSync("src/components/PostImagePreview.vue", "utf8");
    const viewer = readFileSync("src/components/ImageViewer.vue", "utf8");

    const openViewer = preview.slice(preview.indexOf("function openViewer"), preview.indexOf("function handleViewerIndexChange"));
    expect(openViewer).toContain("viewerImageUrls.value = buildViewerUrls()");
    expect(openViewer).toContain("viewerVisible.value = true");
    expect(openViewer).not.toContain("await");
    expect(preview).toContain("const wanted = new Set(adjacentSlideIndexes(index, images.value.length))");
    expect(preview).not.toContain("images.value.forEach((_, itemIndex)");
    expect(preview).toContain("scheduled.promote(priority)");
    expect(preview).toContain("cancelViewerOriginalLoads(wanted)");
    expect(preview).toContain("void loadImage(index, 0).then(refreshViewerUrls)");
    expect(preview).toContain("void loadImage(adjacent, 1).then(refreshViewerUrls)");
    expect(preview).toContain("request.controller.abort()");
    expect(preview).toContain("job.consumers === 0");
    expect(preview).toContain("inFlightDecrypts.delete(taskKey)");
    expect(preview).toContain("retryViewerOriginal");
    expect(viewer).toContain('emit("indexChange", currentIndex.value)');
    expect(viewer).toContain('emit("retryOriginal")');
    expect(viewer).toContain("原图加载失败 · 重试");
  });
});
