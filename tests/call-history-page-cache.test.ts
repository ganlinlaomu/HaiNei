import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cachedCallHistoryPage, clearCallHistoryPageCache, rememberCallHistoryPage, storedCallHistoryPage, type CallHistoryItem,
} from "@/services/callHistory";
import { prepareAccountLock } from "@/services/accountLifecycle";
import { metaRepository } from "@/repositories/metaRepository";

const account = "1".repeat(64);
const item = (n: number, missed = false): CallHistoryItem => ({
  id: `call-${n}`, peer: "2".repeat(64), createdAt: 1_000 - n, text: "语音通话", missed, direction: "incoming",
});

describe("call history page cache", () => {
  afterEach(async () => {
    clearCallHistoryPageCache();
    await metaRepository.delete(account, "call-history:page:all");
    await metaRepository.delete(account, "call-history:page:missed");
    await metaRepository.delete(account, "call-history:deleted:call-1");
  });

  it("returns the last page for the same session, account and filter", async () => {
    await rememberCallHistoryPage("1", account, false, { items: [item(1), item(2)], hasMore: false });
    expect(cachedCallHistoryPage("1", account, 50, false)?.items.map(i => i.id)).toEqual(["call-1", "call-2"]);
    expect(cachedCallHistoryPage("1", account, 50, true)).toBeNull();
    expect(cachedCallHistoryPage("1", "3".repeat(64), 50, false)).toBeNull();
  });

  it("trims a larger cached page to the requested size and keeps load-more", async () => {
    await rememberCallHistoryPage("1", account, false, { items: [item(1), item(2), item(3)], hasMore: false });
    const page = cachedCallHistoryPage("1", account, 2, false);
    expect(page?.items).toHaveLength(2);
    expect(page?.hasMore).toBe(true);
  });

  it("drops cached pages when the key session changes or the account locks", async () => {
    await rememberCallHistoryPage("1", account, false, { items: [item(1)], hasMore: false });
    expect(cachedCallHistoryPage("2", account, 50, false)).toBeNull();
    expect(cachedCallHistoryPage("1", account, 50, false)).toBeNull();
    await rememberCallHistoryPage("2", account, false, { items: [item(1)], hasMore: false });
    await prepareAccountLock(account);
    expect(cachedCallHistoryPage("2", account, 50, false)).toBeNull();
  });

  it("restores the last page from IndexedDB after the in-memory session is gone", async () => {
    await rememberCallHistoryPage("1", account, false, { items: [item(1), item(2)], hasMore: true });
    clearCallHistoryPageCache();
    const restored = await storedCallHistoryPage("2", account, 50, false);
    expect(restored?.items.map(entry => entry.id)).toEqual(["call-1", "call-2"]);
    expect(restored?.hasMore).toBe(true);
  });

  it("does not resurrect a locally deleted call from the cold-start snapshot", async () => {
    await rememberCallHistoryPage("1", account, false, { items: [item(1), item(2)], hasMore: false });
    await metaRepository.put(account, "call-history:deleted:call-1", true);
    clearCallHistoryPageCache();
    const restored = await storedCallHistoryPage("2", account, 50, false);
    expect(restored?.items.map(entry => entry.id)).toEqual(["call-2"]);
  });

  it("paints cached calls before liveQuery and clears them while locked", () => {
    const view = readFileSync(join(process.cwd(), "src/views/Calls.vue"), "utf8");
    expect(view).toContain("const cached = cachedCallHistoryPage(session, account, count, missed);");
    expect(view).toContain("loading.value = !cached;");
    expect(view).toContain("await storedCallHistoryPage(session, account, count, missed)");
    expect(view).toContain("void rememberCallHistoryPage(session, account, missed, page);");
    expect(view).toContain("if (!account || !keys.isUnlocked) { clearCallHistoryPageCache();");
  });
});
