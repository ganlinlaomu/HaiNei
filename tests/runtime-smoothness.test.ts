import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMAGE_MEMORY_CACHE_MAX_BYTES,
  clearMemoryImageCache,
  getCacheStats,
  getImageFromCache,
  storeImageInCache,
} from "@/utils/imageCache";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

class SizedBlob extends Blob {
  constructor(private readonly reportedSize: number) {
    super(["x"], { type: "image/jpeg" });
  }
  override get size() {
    return this.reportedSize;
  }
}

describe("v0.1.10 runtime smoothness", () => {
  it("keeps decrypted image cache in account-scoped memory and evicts by LRU size", async () => {
    clearMemoryImageCache();
    await storeImageInCache(ACCOUNT, "one", new SizedBlob(30 * 1024 * 1024), "image/jpeg");
    await storeImageInCache(ACCOUNT, "two", new SizedBlob(30 * 1024 * 1024), "image/jpeg");
    await storeImageInCache(OTHER, "other", new Blob(["other"]), "image/jpeg");

    expect(IMAGE_MEMORY_CACHE_MAX_BYTES).toBe(48 * 1024 * 1024);
    expect(await getImageFromCache(ACCOUNT, "one")).toBeNull();
    expect(await getImageFromCache(ACCOUNT, "two")).not.toBeNull();
    expect((await getCacheStats(ACCOUNT)).size).toBeLessThanOrEqual(IMAGE_MEMORY_CACHE_MAX_BYTES);
    expect((await getCacheStats(OTHER)).count).toBe(1);

    clearMemoryImageCache(ACCOUNT);
    expect((await getCacheStats(ACCOUNT)).count).toBe(0);
    expect((await getCacheStats(OTHER)).count).toBe(1);
    clearMemoryImageCache();
  });

  it("clears memory media on account reset instead of persisting decrypted blobs", () => {
    const keys = readFileSync("src/stores/keys.ts", "utf8");
    const cache = readFileSync("src/utils/imageCache.ts", "utf8");
    expect(keys).toContain("clearMemoryImageCache(currentPk)");
    expect(cache).not.toContain("imageCacheRepository.put(");
    expect(cache).toContain("IMAGE_MEMORY_CACHE_MAX_BYTES");
  });

  it("routes low-priority warmups through the activity-aware scheduler", () => {
    const scheduler = readFileSync("src/services/backgroundWorkScheduler.ts", "utf8");
    const app = readFileSync("src/App.vue", "utf8");
    expect(scheduler).toContain('export type BackgroundPriority = "high" | "normal" | "idle"');
    expect(scheduler).toContain('"pointerdown", "touchstart", "keydown", "wheel", "scroll", "input"');
    expect(scheduler).toContain("now() < busyUntil");
    expect(app).toContain('scheduleBackgroundTask("preload-post-editor"');
    expect(app).toContain('scheduleBackgroundTask("preload-bottom-tabs"');
    expect(app).toContain("installForegroundActivityMonitor()");
  });

  it("preloads common destination chunks on pointer/focus intent", () => {
    const conversations = readFileSync("src/views/Conversations.vue", "utf8");
    const settings = readFileSync("src/views/Settings.vue", "utf8");
    const card = readFileSync("src/components/PostCard.vue", "utf8");
    const routes = readFileSync("src/router/index.ts", "utf8");
    expect(conversations).toContain('@pointerdown="preloadMessagesView"');
    expect(settings).toContain('@pointerdown="loadSavedView"');
    expect(settings).toContain('@pointerdown="loadFriendsView"');
    expect(card).toContain('@pointerdown="preloadProfile"');
    expect(routes).toContain("component: loadMessagesView");
    expect(routes).toContain("component: loadProfileView");
  });

  it("keeps normalized outgoing task list reads write-free", () => {
    const source = readFileSync("src/repositories/outgoingDmTaskRepository.ts", "utf8");
    expect(source).not.toContain("rows.map(row => this.put(row))");
    expect(source).toContain("normalized.filter(item => item.changed)");
    expect(source).toContain("bulkPut(migrated)");
  });
});
