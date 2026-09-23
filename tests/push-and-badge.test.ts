import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { handleRequest } from "../worker/src/index";
import { GENERIC_PUSH_PAYLOAD, sanitizePushRecipients } from "../worker/src/push";
import {
  enablePushNotifications,
  pushEnabledForAccount,
  pushServiceErrorMessage,
} from "@/services/pushNotifications";
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

class PushD1 {
  challenges = new Map<string, { expires_at: number; used_at: number | null; pubkey: string | null }>();
  subscriptions = new Map<string, { account_pubkey: string; endpoint: string; p256dh: string; auth: string }>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return this.bound(normalized, []);
  }

  private bound(sql: string, values: unknown[]): any {
    return {
      bind: (...next: unknown[]) => this.bound(sql, next),
      first: async () => {
        if (sql.includes("FROM hainei_auth_challenges")) return this.challenges.get(String(values[0])) || null;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => {
        if (sql.startsWith("INSERT INTO hainei_auth_challenges")) {
          this.challenges.set(String(values[0]), { expires_at: Number(values[2]), used_at: null, pubkey: null });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE hainei_auth_challenges")) {
          const row = this.challenges.get(String(values[2]));
          if (!row || row.used_at !== null || row.expires_at <= Number(values[3])) return { meta: { changes: 0 } };
          row.used_at = Number(values[0]);
          row.pubkey = String(values[1]);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO hainei_push_subscriptions")) {
          const account = String(values[0]);
          const endpoint = String(values[1]);
          this.subscriptions.set(`${account}|${endpoint}`, {
            account_pubkey: account,
            endpoint,
            p256dh: String(values[2]),
            auth: String(values[3]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM hainei_push_subscriptions")) {
          const removed = this.subscriptions.delete(`${values[0]}|${values[1]}`);
          return { meta: { changes: removed ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

function pushEnv(db = new PushD1(), configured = true) {
  return {
    DB: db,
    BLOSSOM: { fetch: vi.fn() },
    BLOSSOM_SERVICE_TOKEN: "secret",
    ...(configured ? { VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private" } : {}),
  } as any;
}

async function authenticatedBody(env: any, secret: Uint8Array, extra: Record<string, unknown>) {
  const challengeResponse = await handleRequest(new Request("https://worker.test/api/auth/challenge", { method: "POST" }), env);
  const { challenge, expiresAt } = await challengeResponse.json() as { challenge: string; expiresAt: number };
  const now = Math.floor(Date.now() / 1000);
  return {
    ...extra,
    challenge,
    event: finalizeEvent({
      kind: 27235,
      created_at: now,
      content: "Authorize HaiNei push action",
      tags: [["t", "hainei_push"], ["challenge", challenge], ["expiration", String(Math.min(expiresAt, now + 300))]],
    }, secret),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("privacy-preserving push and badge", () => {
  it("serves the POST public-key route and reports missing VAPID config explicitly", async () => {
    const configured = await handleRequest(new Request("https://worker.test/api/push/public-key", { method: "POST" }), pushEnv());
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ publicKey: "public" });

    const missing = await handleRequest(new Request("https://worker.test/api/push/public-key", { method: "POST" }), pushEnv(new PushD1(), false));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "push_not_configured" });
  });

  it("requires signed challenge authentication for subscriptions", async () => {
    const env = pushEnv();
    const response = await handleRequest(new Request("https://worker.test/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint: "https://push.test", keys: { p256dh: "x", auth: "y" } } })
    }), env);
    expect(response.status).toBe(400);
  });

  it("persists and removes a subscription through authenticated routes", async () => {
    const db = new PushD1();
    const env = pushEnv(db);
    const secret = generateSecretKey();
    const account = getPublicKey(secret);
    const subscription = { endpoint: "https://push.test/subscription", keys: { p256dh: "p256dh", auth: "auth" } };
    const subscribeBody = await authenticatedBody(env, secret, { subscription });
    const subscribed = await handleRequest(new Request("https://worker.test/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscribeBody),
    }), env);
    expect(subscribed.status).toBe(201);
    expect(db.subscriptions.get(`${account}|${subscription.endpoint}`)).toMatchObject({ account_pubkey: account });

    const unsubscribeBody = await authenticatedBody(env, secret, { endpoint: subscription.endpoint });
    const unsubscribed = await handleRequest(new Request("https://worker.test/api/push/unsubscribe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(unsubscribeBody),
    }), env);
    expect(unsubscribed.status).toBe(200);
    expect(db.subscriptions.size).toBe(0);
  });

  it("uses a fixed generic payload that cannot contain caller private content", () => {
    expect(GENERIC_PUSH_PAYLOAD).toEqual({ title: "HaiNei", body: "有新的活动", url: "/#/notifications" });
    expect(JSON.stringify(GENERIC_PUSH_PAYLOAD)).not.toContain("private post text");
    expect(sanitizePushRecipients([OTHER, "private post text", ACCOUNT], ACCOUNT)).toEqual([OTHER]);
    expect(shouldTriggerGenericPush([["t", "hainei-profile-request"]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "hainei-tombstone"]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "like"], ["liked", "false"]])).toBe(false);
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

  it("maps deployment and VAPID failures to safe actionable messages", () => {
    expect(pushServiceErrorMessage(404, "not_found", "fallback")).toBe("推送服务尚未部署，请更新 HaiNei Worker");
    expect(pushServiceErrorMessage(503, "push_not_configured", "fallback")).toBe("推送服务尚未配置 VAPID");
    expect(pushServiceErrorMessage(500, "push_storage_unavailable", "fallback"))
      .toBe("推送服务数据库尚未准备好，请检查 Worker 部署和 D1 迁移");
  });

  it("sets the local enabled flag only after subscribe succeeds", async () => {
    const subscription = { endpoint: "https://push.test/subscription", toJSON: () => ({ endpoint: "https://push.test/subscription", keys: { p256dh: "x", auth: "y" } }) };
    const subscribe = vi.fn(async () => subscription);
    const notification = { permission: "granted", requestPermission: vi.fn() };
    vi.stubGlobal("window", { location: { origin: "https://app.test" }, PushManager: function PushManager() {}, Notification: notification });
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) } });
    vi.stubGlobal("Notification", notification);

    let finishSubscribe!: (response: Response) => void;
    const subscribeResponse = new Promise<Response>(resolve => { finishSubscribe = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: "AQ" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ challenge: "challenge", expiresAt: Math.floor(Date.now() / 1000) + 300 }), { status: 201 }))
      .mockImplementationOnce(() => subscribeResponse);
    vi.stubGlobal("fetch", fetchMock);

    const enabling = enablePushNotifications(ACCOUNT, async event => ({ ...event, pubkey: ACCOUNT, id: "id", sig: "sig" }) as any);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(pushEnabledForAccount(ACCOUNT)).toBe(false);
    finishSubscribe(new Response(JSON.stringify({ subscribed: true }), { status: 201 }));
    await enabling;
    expect(pushEnabledForAccount(ACCOUNT)).toBe(true);
  });

  it("does not leave push enabled when authenticated subscribe fails", async () => {
    const notification = { permission: "granted", requestPermission: vi.fn() };
    vi.stubGlobal("window", { location: { origin: "https://app.test" }, PushManager: function PushManager() {}, Notification: notification });
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe: vi.fn(async () => ({ toJSON: () => ({ endpoint: "https://push.test", keys: { p256dh: "x", auth: "y" } }) })) } }) } });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: "AQ" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ challenge: "challenge", expiresAt: Math.floor(Date.now() / 1000) + 300 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "push_storage_unavailable" }), { status: 500 })));
    localStorage.setItem(`hainei_push_enabled_${ACCOUNT}`, "1");

    await expect(enablePushNotifications(ACCOUNT, async event => ({ ...event, pubkey: ACCOUNT, id: "id", sig: "sig" }) as any))
      .rejects.toThrow("推送服务数据库尚未准备好");
    expect(pushEnabledForAccount(ACCOUNT)).toBe(false);
  });
});
