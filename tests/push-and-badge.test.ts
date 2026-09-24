import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { handleRequest } from "../worker/src/index";
import {
  createVapidHeaders,
  encryptPushPayload,
  GENERIC_PUSH_PAYLOAD,
  MESSAGE_PUSH_PAYLOAD,
  pushPayloadForType,
  sanitizePushRecipients,
  triggerGenericPush,
} from "../worker/src/push";
import {
  enablePushNotifications,
  pushEnabledForAccount,
  pushServiceErrorMessage,
  triggerGenericPush as triggerFrontendPush,
} from "@/services/pushNotifications";
import { accountBadgeCount, syncAppBadge } from "@/utils/appBadge";
import { pushCategoryForMessage, shouldTriggerGenericPush } from "@/nostr/messaging/service";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let vapidPublicKey = "";
let vapidPrivateKey = "";
let subscriptionPublicKey = "";
let subscriptionPrivateKey: CryptoKey;
let subscriptionAuth = "";

function toArrayBuffer(value: Uint8Array) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function base64UrlEncode(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

async function testHkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: toArrayBuffer(salt),
    info: toArrayBuffer(info),
  }, key, length * 8));
}

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
      all: async () => ({
        results: sql.includes("FROM hainei_push_subscriptions")
          ? [...this.subscriptions.values()].filter(row => values.includes(row.account_pubkey))
          : [],
      }),
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
    ...(configured ? {
      VAPID_PUBLIC_KEY: vapidPublicKey,
      VAPID_PRIVATE_KEY: vapidPrivateKey,
      VAPID_SUBJECT: "mailto:admin@hainei.app",
    } : {}),
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

beforeAll(async () => {
  const vapidKeys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
  vapidPublicKey = base64UrlEncode(vapidPublic);
  vapidPrivateKey = vapidPrivate.d!;

  const subscriptionKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  subscriptionPrivateKey = subscriptionKeys.privateKey;
  subscriptionPublicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", subscriptionKeys.publicKey)));
  subscriptionAuth = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
});

beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("privacy-preserving push and badge", () => {
  function addSubscription(db: PushD1, endpoint = "https://web.push.apple.com/QWxhZGRpbjpvcGVuIHNlc2FtZQ") {
    const row = { account_pubkey: OTHER, endpoint, p256dh: subscriptionPublicKey, auth: subscriptionAuth };
    db.subscriptions.set(`${OTHER}|${endpoint}`, row);
    return row;
  }

  it("serves the POST public-key route and reports missing VAPID config explicitly", async () => {
    const configured = await handleRequest(new Request("https://worker.test/api/push/public-key", { method: "POST" }), pushEnv());
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ publicKey: vapidPublicKey });

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

  it("uses only the fixed privacy-safe private-message payload", () => {
    expect(MESSAGE_PUSH_PAYLOAD).toEqual({ type: "message", title: "HaiNei", body: "你有新的私信消息", url: "/#/conversations" });
    expect(GENERIC_PUSH_PAYLOAD).toBe(MESSAGE_PUSH_PAYLOAD);
    expect(pushPayloadForType("unknown")).toBeNull();
    expect(pushPayloadForType(undefined)).toBeNull();
    expect(JSON.stringify(MESSAGE_PUSH_PAYLOAD)).not.toContain("private post text");
    expect(sanitizePushRecipients([OTHER, "private post text", ACCOUNT], ACCOUNT)).toEqual([OTHER]);
    expect(pushCategoryForMessage([["t", "hainei-dm"]])).toBe("message");
    expect(pushCategoryForMessage([["l", "hainei-interaction"], ["t", "like"]])).toBeNull();
    expect(pushCategoryForMessage([["l", "hainei-interaction"], ["t", "comment"]])).toBeNull();
    expect(pushCategoryForMessage([["l", "hainei-friendship"], ["t", "request"]])).toBeNull();
    expect(shouldTriggerGenericPush([["l", "hainei-interaction"], ["t", "like"]])).toBe(false);
    expect(shouldTriggerGenericPush([["l", "hainei-interaction"], ["t", "comment"]])).toBe(false);
    expect(shouldTriggerGenericPush([["l", "hainei-friendship"], ["t", "request"]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "hainei-profile-request"]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "hainei-tombstone"]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "like"], ["liked", "false"]])).toBe(false);
  });

  it("encrypts a valid non-empty RFC 8291 aes128gcm payload", async () => {
    const payload = JSON.stringify(GENERIC_PUSH_PAYLOAD);
    const body = await encryptPushPayload(payload, subscriptionPublicKey, subscriptionAuth);
    expect(body.byteLength).toBeGreaterThan(86 + 16);
    expect(new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);

    const salt = body.slice(0, 16);
    const applicationPublicKeyBytes = body.slice(21, 86);
    const applicationPublicKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(applicationPublicKeyBytes),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "ECDH", public: applicationPublicKey },
      subscriptionPrivateKey,
      256,
    ));
    const keyInfo = new Uint8Array([
      ...encoder.encode("WebPush: info\0"),
      ...base64UrlDecode(subscriptionPublicKey),
      ...applicationPublicKeyBytes,
    ]);
    const inputKeyMaterial = await testHkdf(sharedSecret, base64UrlDecode(subscriptionAuth), keyInfo, 32);
    const contentEncryptionKey = await testHkdf(
      inputKeyMaterial,
      salt,
      encoder.encode("Content-Encoding: aes128gcm\0"),
      16,
    );
    const nonce = await testHkdf(inputKeyMaterial, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
    const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(contentEncryptionKey), "AES-GCM", false, ["decrypt"]);
    const record = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      aesKey,
      toArrayBuffer(body.slice(86)),
    ));
    expect(record.at(-1)).toBe(2);
    expect(decoder.decode(record.slice(0, -1))).toBe(payload);
  });

  it("creates a verifiable VAPID JWT and headers for the endpoint origin", async () => {
    const now = 1_800_000_000;
    const headers = await createVapidHeaders({
      publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey,
      subject: "mailto:admin@hainei.app",
    }, "https://web.push.apple.com/path/token", now);
    const token = headers.Authorization.match(/^vapid t=([^,]+), k=/)?.[1];
    expect(token).toBeTruthy();
    expect(headers["Crypto-Key"]).toBe(`p256ecdsa=${vapidPublicKey}`);

    const [encodedHeader, encodedPayload, encodedSignature] = token!.split(".");
    expect(JSON.parse(decoder.decode(base64UrlDecode(encodedHeader)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(decoder.decode(base64UrlDecode(encodedPayload)))).toEqual({
      aud: "https://web.push.apple.com",
      exp: now + 12 * 60 * 60,
      sub: "mailto:admin@hainei.app",
    });
    const verificationKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(base64UrlDecode(vapidPublicKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    await expect(crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verificationKey,
      toArrayBuffer(base64UrlDecode(encodedSignature)),
      toArrayBuffer(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
    )).resolves.toBe(true);
  });

  it("reports a successful push as sent", async () => {
    const db = new PushD1();
    addSubscription(db);
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", send);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER], "message")).resolves.toEqual({
      requested: 1, subscriptionsFound: 1, sent: 1, failed: 0, expired: 0,
    });
    expect(log).toHaveBeenCalledWith({
      recipientPubkey: OTHER,
      endpointHost: "web.push.apple.com",
      status: 201,
      message: "push sent",
    });
    const [, request] = send.mock.calls[0] as [string, RequestInit];
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "60",
    });
    expect((request.headers as Record<string, string>).Authorization).toMatch(/^vapid t=.+, k=/);
    expect((request.body as ArrayBuffer).byteLength).toBeGreaterThan(0);
  });

  it("does not deliver activity or unknown push categories", async () => {
    const db = new PushD1();
    addSubscription(db);
    const send = vi.fn();
    vi.stubGlobal("fetch", send);

    await expect(triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER], "activity")).resolves.toEqual({
      requested: 1, subscriptionsFound: 0, sent: 0, failed: 0, expired: 0,
    });
    await expect(triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER], "unknown")).resolves.toEqual({
      requested: 1, subscriptionsFound: 0, sent: 0, failed: 0, expired: 0,
    });
    await expect(triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER])).resolves.toEqual({
      requested: 1, subscriptionsFound: 0, sent: 0, failed: 0, expired: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not call the Worker trigger route for frontend activity pushes", async () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    await triggerFrontendPush([OTHER], ACCOUNT, vi.fn(), "activity");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([404, 410])("removes and reports an expired subscription for status %i", async statusCode => {
    const db = new PushD1();
    const row = addSubscription(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: statusCode })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER], "message")).resolves.toEqual({
      requested: 1, subscriptionsFound: 1, sent: 0, failed: 0, expired: 1,
    });
    expect(db.subscriptions.has(`${OTHER}|${row.endpoint}`)).toBe(false);
  });

  it("reports other delivery failures and retains the subscription", async () => {
    const db = new PushD1();
    const row = addSubscription(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER], "message")).resolves.toEqual({
      requested: 1, subscriptionsFound: 1, sent: 0, failed: 1, expired: 0,
    });
    expect(db.subscriptions.has(`${OTHER}|${row.endpoint}`)).toBe(true);
  });

  it("reports no subscription without attempting delivery", async () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);

    await expect(triggerGenericPush(pushEnv(), ACCOUNT, [OTHER], "message")).resolves.toEqual({
      requested: 1, subscriptionsFound: 0, sent: 0, failed: 0, expired: 0,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not expose push secrets or full endpoint URLs in diagnostics", async () => {
    const db = new PushD1();
    const row = addSubscription(db);
    const privateKey = vapidPrivateKey;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new Error(`failed ${row.endpoint} ${row.p256dh} ${row.auth} ${privateKey}`),
    ));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await triggerGenericPush(pushEnv(db), ACCOUNT, [OTHER], "message");

    const diagnostics = JSON.stringify(log.mock.calls);
    expect(diagnostics).toContain(OTHER);
    expect(diagnostics).toContain("web.push.apple.com");
    expect(diagnostics).not.toContain(row.endpoint);
    expect(diagnostics).not.toContain(row.p256dh);
    expect(diagnostics).not.toContain(row.auth);
    expect(diagnostics).not.toContain(privateKey);
  });

  it("keeps Node createECDH and web-push out of the Worker push path", () => {
    const source = readFileSync(new URL("../worker/src/push.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createECDH/);
    expect(source).not.toMatch(/(?:from|require\s*\()\s*["'](?:node:)?web-push["']/);
  });

  it("keeps service-worker notification wording and click target private-message only", () => {
    const source = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
    expect(source).toContain("body: '你有新的私信消息'");
    expect(source).toContain("JSON.parse(event.data?.text() || '{}')");
    expect(source).toContain("const path = '/#/conversations'");
    expect(source).not.toMatch(/sender|pubkey|private-message content|post content/);
  });

  it("sets and clears the app badge from unread count", async () => {
    const target = { setAppBadge: vi.fn(), clearAppBadge: vi.fn() } as any;
    await syncAppBadge(3, target);
    await syncAppBadge(0, target);
    expect(target.setAppBadge).toHaveBeenCalledWith(3);
    expect(target.clearAppBadge).toHaveBeenCalledOnce();
    expect(accountBadgeCount(OTHER, ACCOUNT, 3)).toBe(0);
    expect(accountBadgeCount(ACCOUNT, ACCOUNT, 3)).toBe(3);
    expect(accountBadgeCount(ACCOUNT, ACCOUNT, 3, ACCOUNT, 2)).toBe(5);
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
