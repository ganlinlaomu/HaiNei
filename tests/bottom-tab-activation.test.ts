import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isAccountResourceStale, loadAccountStoresOnce } from "@/utils/bottomTabActivation";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function accountStore() {
  const store = {
    loadedFor: "",
    load: vi.fn(async (account: string) => {
      store.loadedFor = account;
      await Promise.resolve();
    }),
  };
  return store;
}

describe("bottom-tab activation loading", () => {
  it("does not call account store loads again on repeated activation", async () => {
    const stores = [accountStore(), accountStore(), accountStore(), accountStore()];
    await Promise.all([
      loadAccountStoresOnce(ACCOUNT, stores),
      loadAccountStoresOnce(ACCOUNT, stores),
    ]);
    await loadAccountStoresOnce(ACCOUNT, stores);
    expect(stores.map(store => store.load.mock.calls)).toEqual(stores.map(() => [[ACCOUNT]]));
  });

  it("loads all account stores again after an account switch", async () => {
    const stores = [accountStore(), accountStore()];
    await loadAccountStoresOnce(ACCOUNT, stores);
    await loadAccountStoresOnce(OTHER, stores);
    expect(stores.map(store => store.load.mock.calls)).toEqual(stores.map(() => [[ACCOUNT], [OTHER]]));
  });

  it("reuses fresh cache stats but refreshes stale or account-mismatched stats", () => {
    const now = 1_000_000;
    const maxAge = 300_000;
    expect(isAccountResourceStale(ACCOUNT, ACCOUNT, now - 1_000, maxAge, now)).toBe(false);
    expect(isAccountResourceStale(ACCOUNT, ACCOUNT, now - maxAge, maxAge, now)).toBe(true);
    expect(isAccountResourceStale(OTHER, ACCOUNT, now - 1_000, maxAge, now)).toBe(true);
  });

  it("wires activations to deduped loads, stale cache checks, and idle chunk preload", () => {
    const conversations = readFileSync(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    const settings = readFileSync(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    const routes = readFileSync(join(process.cwd(), "src/router/index.ts"), "utf8");

    expect(conversations).toContain("loadAccountStoresOnce(account, [messages, friendships, friends, profiles])");
    expect(settings).toContain("isAccountResourceStale(");
    expect(settings).toContain("scheduleCacheStatsRefresh();");
    expect(settings).toContain('@click="refreshCacheStats(true)"');
    expect(app).toContain("void preloadBottomTabViews()");
    expect(routes).toContain("component: loadConversationsView");
    expect(routes).toContain("component: loadNotificationsView");
    expect(routes).toContain("component: loadSettingsView");
  });
});
