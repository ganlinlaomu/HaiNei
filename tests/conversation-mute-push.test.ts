// A muted conversation must not wake the account: the Worker push policy
// (account-wide, uploaded by every device) excludes muted friends.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/dexie";
import { friendRepository } from "@/repositories/friendRepository";
import { syncPushAuthorizationPolicy } from "@/services/pushNotifications";

const ACCOUNT = "a".repeat(64);
const MUTED = "b".repeat(64);
const NORMAL = "c".repeat(64);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  await db.open();
  await db.accountFriends.clear();
  const notification = { permission: "granted", requestPermission: vi.fn() };
  const subscription = { endpoint: "https://push.test/x", toJSON: () => ({ endpoint: "https://push.test/x", keys: { p256dh: "x", auth: "y" } }) };
  vi.stubGlobal("window", { location: { origin: "https://app.test" }, PushManager: function PushManager() {}, Notification: notification });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => subscription) } }) } });
  vi.stubGlobal("Notification", notification);
  localStorage.setItem(`hainei_push_enabled_${ACCOUNT}`, "1");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("push policy and muted conversations", () => {
  it("does not authorize muted friends to wake this account", async () => {
    await friendRepository.put(ACCOUNT, { pubkey: MUTED, dmMuted: true, updatedAt: 1 });
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/challenge")) {
        return new Response(JSON.stringify({ challenge: "c".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 300 }), { status: 201 });
      }
      bodies.push({ url, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(JSON.stringify({ accepted: true, subscribed: true }), { status: 200 });
    }));

    await expect(syncPushAuthorizationPolicy(ACCOUNT, [MUTED, NORMAL],
      async event => ({ ...event, pubkey: ACCOUNT, id: "id", sig: "sig" }) as any)).resolves.toBe(true);

    const policy = bodies.find(item => item.url.endsWith("/api/push/policy"));
    expect(policy.body.senderPubkeys).toEqual([NORMAL]);
  });
});
