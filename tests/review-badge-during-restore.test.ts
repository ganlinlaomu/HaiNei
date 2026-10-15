// Review finding #1 (badge half): while the DM unread barrier is restoring,
// App.vue synced the masked 0 to the OS badge and erased the Push-set count.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { nextTick, reactive, watch as vueWatch } from "vue";
import { accountBadgeCount } from "@/utils/appBadge";

const ACCOUNT = "a".repeat(64);

function watchApp(state: {
  keys: { pkHex: string; isUnlocked: boolean; isRestored: boolean };
  notifications: { loadedFor: string; unreadCount: number };
  directMessages: { loadedFor: string; unreadCount: number; readStateRestorePhase: "ready" | "restoring" };
}) {
  const app = readFileSync("src/App.vue", "utf8");
  const start = app.indexOf("    watch(\n      () => [");
  const end = app.indexOf("\n    watch(", start + 1);
  const syncAppBadge = vi.fn(async () => {});
  const syncAppBadgeScope = vi.fn(async () => {});
  let stop = () => {};
  runInNewContext(app.slice(start, end).replace("] as const", "]"), {
    ...state,
    accountBadgeCount,
    syncAppBadge,
    syncAppBadgeScope,
    watch: (...args: Parameters<typeof vueWatch>) => { stop = (vueWatch as any)(...args); },
  });
  return { syncAppBadge, syncAppBadgeScope, stop: () => stop() };
}

describe("review #1: OS badge while DM unread is still restoring", () => {
  it("does not overwrite the Push-provided badge with the masked zero", async () => {
    const state = reactive({
      keys: { pkHex: ACCOUNT, isUnlocked: true, isRestored: true },
      notifications: { loadedFor: ACCOUNT, unreadCount: 0 },
      directMessages: { loadedFor: ACCOUNT, unreadCount: 0, readStateRestorePhase: "restoring" as "ready" | "restoring" },
    });
    const app = watchApp(state);
    try {
      await nextTick();
      expect(app.syncAppBadge).not.toHaveBeenCalledWith(0, undefined, ACCOUNT);
      // Routing for Push must still be bound to this account.
      expect(app.syncAppBadgeScope).toHaveBeenCalledWith(ACCOUNT);

      // Once the durable projection is ready, it owns the badge again.
      state.directMessages.unreadCount = 2;
      state.directMessages.readStateRestorePhase = "ready";
      await nextTick();
      expect(app.syncAppBadge).toHaveBeenLastCalledWith(2, undefined, ACCOUNT);
    } finally {
      app.stop();
    }
  });

  it("control: a ready store still syncs zero to clear the badge", async () => {
    const state = reactive({
      keys: { pkHex: ACCOUNT, isUnlocked: true, isRestored: true },
      notifications: { loadedFor: ACCOUNT, unreadCount: 0 },
      directMessages: { loadedFor: ACCOUNT, unreadCount: 0, readStateRestorePhase: "ready" as "ready" | "restoring" },
    });
    const app = watchApp(state);
    try {
      await nextTick();
      expect(app.syncAppBadge).toHaveBeenLastCalledWith(0, undefined, ACCOUNT);
    } finally {
      app.stop();
    }
  });
});
