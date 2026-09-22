import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../worker/src/index";
import { GENERIC_PUSH_PAYLOAD, sanitizePushRecipients } from "../worker/src/push";
import { pushEnabledForAccount } from "@/services/pushNotifications";
import { accountBadgeCount, syncAppBadge } from "@/utils/appBadge";
import { shouldTriggerGenericPush } from "@/nostr/messaging/service";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));

describe("privacy-preserving push and badge", () => {
  it("requires signed challenge authentication for subscriptions", async () => {
    const env = {
      DB: { prepare: () => ({ bind() { return this; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) },
      BLOSSOM: { fetch: vi.fn() }, BLOSSOM_SERVICE_TOKEN: "secret",
      VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private"
    } as any;
    const response = await handleRequest(new Request("https://worker.test/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint: "https://push.test", keys: { p256dh: "x", auth: "y" } } })
    }), env);
    expect(response.status).toBe(400);
  });

  it("uses a fixed generic payload that cannot contain caller private content", () => {
    expect(GENERIC_PUSH_PAYLOAD).toEqual({ title: "HaiNei", body: "有新的活动", url: "/#/notifications" });
    expect(JSON.stringify(GENERIC_PUSH_PAYLOAD)).not.toContain("private post text");
    expect(sanitizePushRecipients([OTHER, "private post text", ACCOUNT], ACCOUNT)).toEqual([OTHER]);
    expect(shouldTriggerGenericPush([["t", "hainei-profile-request"]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "hainei-tombstone"]])).toBe(false);
  });

  it("sets and clears the app badge from unread count", async () => {
    const target = { setAppBadge: vi.fn(), clearAppBadge: vi.fn() } as any;
    await syncAppBadge(3, target);
    await syncAppBadge(0, target);
    expect(target.setAppBadge).toHaveBeenCalledWith(3);
    expect(target.clearAppBadge).toHaveBeenCalledOnce();
    expect(accountBadgeCount(OTHER, ACCOUNT, 3)).toBe(0);
    expect(accountBadgeCount(ACCOUNT, ACCOUNT, 3)).toBe(3);
  });

  it("keeps push opt-in state isolated across account switches", () => {
    localStorage.setItem(`hainei_push_enabled_${ACCOUNT}`, "1");
    expect(pushEnabledForAccount(ACCOUNT)).toBe(true);
    expect(pushEnabledForAccount(OTHER)).toBe(false);
  });
});
