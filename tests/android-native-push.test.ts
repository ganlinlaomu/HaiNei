import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  nativeTokenHash,
  sendNativePush,
  saveNativePushToken,
  removeNativePushToken,
  findNativePushToken,
} from "../worker/src/nativePush";
import type { Env } from "../worker/src/types";

type NativeRow = { token_hash: string; account_pubkey: string; token: string; created_at: number; updated_at: number };
const TEST_TOKEN = "fcm:android-token_12345678901234567890";
const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function mockEnv() {
  const rows = new Map<string, NativeRow>();
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.includes("INSERT INTO hainei_native_push_tokens")) {
                  const hash = String(values[0]);
                  const current = rows.get(hash);
                  rows.set(hash, {
                    token_hash: hash, account_pubkey: String(values[1]), token: String(values[2]),
                    created_at: current?.created_at || Number(values[3]), updated_at: Number(values[4]),
                  });
                }
                if (sql.startsWith("DELETE FROM hainei_native_push_tokens WHERE account_pubkey = ? AND token_hash = ?")) {
                  if (rows.get(String(values[1]))?.account_pubkey === values[0]) rows.delete(String(values[1]));
                }
                return { meta: { changes: 1 } };
              },
              async first() {
                if (sql.startsWith("SELECT account_pubkey, token_hash, token")) {
                  const row = rows.get(String(values[1]));
                  return row?.account_pubkey === values[0] ? row : null;
                }
                return null;
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, rows };
}

describe("native Android FCM integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("binds one installation to only its current authorized account", async () => {
    const { env, rows } = mockEnv();
    await saveNativePushToken(env, ACCOUNT, TEST_TOKEN);
    expect((await findNativePushToken(env, ACCOUNT, TEST_TOKEN))?.account_pubkey).toBe(ACCOUNT);
    await saveNativePushToken(env, OTHER, TEST_TOKEN);
    expect(await findNativePushToken(env, ACCOUNT, TEST_TOKEN)).toBeNull();
    expect((await findNativePushToken(env, OTHER, TEST_TOKEN))?.account_pubkey).toBe(OTHER);
    await removeNativePushToken(env, ACCOUNT, TEST_TOKEN);
    expect(rows.size).toBe(1);
    await removeNativePushToken(env, OTHER, TEST_TOKEN);
    expect(rows.size).toBe(0);
  });

  it("rejects malformed tokens before accessing D1 and never treats them as a Web Push endpoint", async () => {
    const { env } = mockEnv();
    await expect(saveNativePushToken(env, ACCOUNT, "http://bad.example")).rejects.toThrow("invalid_native_push_token");
    expect(await nativeTokenHash(TEST_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps native FCM and existing PWA service worker transport separate", () => {
    const main = readFileSync("src/main.ts", "utf8");
    const native = readFileSync("src/services/nativePushNotifications.ts", "utf8");
    const worker = readFileSync("worker/src/push.ts", "utf8");
    expect(main).toContain("if (isNativeContainer()) return;");
    expect(native).toContain("/api/push/native/subscribe");
    expect(native).toContain("/api/push/native/unsubscribe");
    expect(worker).toContain("authorizedNativePushRows");
    expect(worker).toContain("deliverNativePushRows");
  });
});

describe("FCM HTTP v1 delivery", () => {
  let privatePem = "";
  beforeAll(async () => {
    const key = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
    privatePem = "-----BEGIN PRIVATE KEY-----\n" + Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n") + "\n-----END PRIVATE KEY-----";
  });

  function fcmEnv() {
    return { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "hainei-test", client_email: "sender@hainei-test.iam.gserviceaccount.com", private_key: privatePem,
    }) } as unknown as Env;
  }

  it("sends only a fixed generic notification and uses service-account OAuth, not VAPID", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "oauth-test", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "projects/hainei-test/messages/1" }), { status: 200 });
    }));
    const result = await sendNativePush(fcmEnv(), TEST_TOKEN);
    expect(result.sent).toBe(true);
    expect(requests[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(requests[1].url).toBe("https://fcm.googleapis.com/v1/projects/hainei-test/messages:send");
    const payload = JSON.parse(String(requests[1].init.body));
    expect(payload.message.token).toBe(TEST_TOKEN);
    expect(payload.message.notification).toEqual({ title: "HaiNei", body: "你有新的私信消息" });
    expect(payload.message.data).toEqual({ type: "message" });
    expect(payload.message.android.notification.channel_id).toBe("hainei_messages");
    expect(JSON.stringify(payload)).not.toContain(ACCOUNT);
    expect(JSON.stringify(payload)).not.toContain("senderPubkey");
  });

  it("rejects sending without a server-only service account", async () => {
    await expect(sendNativePush({} as Env, TEST_TOKEN)).rejects.toThrow("native_push_not_configured");
  });
});
