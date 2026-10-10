import { HttpError, integerSetting, type Env } from "./types";
import { consumeRateLimit } from "./requestGuards";

const encoder = new TextEncoder();
const MAX_TOKENS_PER_ACCOUNT = 8;
const TOKEN_PATTERN = /^[A-Za-z0-9:_-]{20,4096}$/;
const ACCOUNT_PATTERN = /^[0-9a-f]{64}$/;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FCM_CHANNEL = "hainei_messages";

export type NativePushRow = { account_pubkey: string; token_hash: string; token: string };
export type NativePushStats = { subscriptionsFound: number; sent: number; failed: number; expired: number };
type ServiceAccount = { project_id: string; client_email: string; private_key: string };
let oauthCache: { key: string; accessToken: string; validUntil: number } | null = null;

function validToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!TOKEN_PATTERN.test(token)) throw new HttpError(400, "invalid_native_push_token");
  return token;
}

export async function nativeTokenHash(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, "0")).join("");
}

export async function saveNativePushToken(env: Env, account: string, rawToken: unknown) {
  if (!ACCOUNT_PATTERN.test(account)) throw new HttpError(400, "invalid_account");
  const token = validToken(rawToken);
  const hash = await nativeTokenHash(token);
  const now = Math.floor(Date.now() / 1000);
  // Remove stale devices first. This cannot delete any other account's devices.
  await env.DB.prepare(`
    DELETE FROM hainei_native_push_tokens WHERE account_pubkey = ?
    AND token_hash NOT IN (
      SELECT token_hash FROM hainei_native_push_tokens WHERE account_pubkey = ?
      ORDER BY updated_at DESC, created_at DESC LIMIT ?
    )
  `).bind(account, account, MAX_TOKENS_PER_ACCOUNT - 1).run();
  await env.DB.prepare(`
    INSERT INTO hainei_native_push_tokens (token_hash, account_pubkey, token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      account_pubkey = excluded.account_pubkey,
      token = excluded.token,
      updated_at = excluded.updated_at
  `).bind(hash, account, token, now, now).run();
  return { subscribed: true };
}

export async function removeNativePushToken(env: Env, account: string, rawToken: unknown) {
  const hash = await nativeTokenHash(validToken(rawToken));
  await env.DB.prepare("DELETE FROM hainei_native_push_tokens WHERE account_pubkey = ? AND token_hash = ?")
    .bind(account, hash).run();
  return { subscribed: false };
}

export async function findNativePushToken(env: Env, account: string, rawToken: unknown) {
  const hash = await nativeTokenHash(validToken(rawToken));
  return env.DB.prepare("SELECT account_pubkey, token_hash, token FROM hainei_native_push_tokens WHERE account_pubkey = ? AND token_hash = ?")
    .bind(account, hash).first<NativePushRow>();
}

export async function authorizedNativePushRows(env: Env, sender: string, recipients: string[], now: number) {
  if (!recipients.length) return [] as NativePushRow[];
  const placeholders = recipients.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT t.account_pubkey, t.token_hash, t.token
    FROM hainei_native_push_tokens AS t
    INNER JOIN hainei_push_authorizations AS a
      ON a.recipient_pubkey = t.account_pubkey
      AND a.sender_pubkey = ?
      AND a.expires_at > ?
    WHERE t.account_pubkey IN (${placeholders})
  `).bind(sender, now, ...recipients).all<NativePushRow>();
  return rows.results;
}

function accountCredentials(env: Env): ServiceAccount {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) throw new HttpError(503, "native_push_not_configured");
  let value: unknown;
  try { value = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON); } catch {
    throw new HttpError(503, "native_push_not_configured");
  }
  const data = value as Partial<ServiceAccount>;
  if (!data || typeof data.project_id !== "string" || !/^[\w-]{1,100}$/.test(data.project_id)
    || typeof data.client_email !== "string" || !data.client_email.endsWith(".gserviceaccount.com")
    || typeof data.private_key !== "string" || !data.private_key.includes("BEGIN PRIVATE KEY")) {
    throw new HttpError(503, "native_push_not_configured");
  }
  return data as ServiceAccount;
}

function encodeBase64Url(input: Uint8Array) {
  let str = "";
  for (const value of input) str += String.fromCharCode(value);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function pemBytes(privateKey: string): ArrayBuffer {
  const raw = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, "");
  const bytes = Uint8Array.from(atob(raw), char => char.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
async function signedAssertion(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const part = (data: unknown) => encodeBase64Url(encoder.encode(JSON.stringify(data)));
  const jwt = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: account.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_ENDPOINT, iat: now, exp: now + 3600,
  })}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(jwt)));
  return `${jwt}.${encodeBase64Url(signature)}`;
}

async function accessToken(env: Env, account: ServiceAccount, forceRefresh = false) {
  const cacheKey = `${account.project_id}:${account.client_email}`;
  if (!forceRefresh && oauthCache?.key === cacheKey && oauthCache.validUntil > Date.now() + 60_000)
    return oauthCache.accessToken;
  const assertion = await signedAssertion(account);
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(integerSetting(env.PUSH_FETCH_TIMEOUT_MS, 8000, 1000, 30000)),
  });
  if (!res.ok) throw new Error(`FCM OAuth HTTP ${res.status}`);
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("FCM OAuth token missing");
  oauthCache = {
    key: cacheKey, accessToken: data.access_token,
    validUntil: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  return data.access_token;
}

export async function sendNativePush(env: Env, token: string) {
  const account = accountCredentials(env);
  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const body = {
    message: {
      token,
      notification: { title: "HaiNei", body: "你有新的私信消息" },
      android: { priority: "HIGH", ttl: "60s", notification: { channel_id: FCM_CHANNEL } },
      data: { type: "message" },
    },
  };
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const authorization = await accessToken(env, account, attempt === 1);
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(integerSetting(env.PUSH_FETCH_TIMEOUT_MS, 8000, 1000, 30000)),
    });
    if (response.status !== 401) break;
  }
  if (!response) throw new Error("FCM response missing");
  if (response.ok) return { sent: true, expired: false, status: response.status };
  const error = await response.json().catch(() => null) as {
    error?: { status?: string; details?: Array<{ errorCode?: string }> };
  } | null;
  const expired = error?.error?.details?.some(item => item.errorCode === "UNREGISTERED") === true;
  return { sent: false, expired, status: response.status };
}

export async function deliverNativePushRows(
  env: Env,
  sender: string,
  messageId: string,
  rows: NativePushRow[],
  now: number,
  reserve: (sender: string, recipient: string, messageId: string, token: string, now: number) => Promise<{ reserved: boolean; endpointHash: string }>,
  complete: (sender: string, recipient: string, messageId: string, hash: string, sent: boolean, now: number) => Promise<void>,
): Promise<NativePushStats> {
  const stats: NativePushStats = { subscriptionsFound: rows.length, sent: 0, failed: 0, expired: 0 };
  const limit = integerSetting(env.PUSH_TRIGGER_PER_MINUTE_PER_RECIPIENT, 30, 5, 600);
  // Avoid unbounded concurrent FCM calls for wide audiences.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      let delivery: { reserved: boolean; endpointHash: string } | null = null;
      try {
        await consumeRateLimit(env, `push:recipient:${row.account_pubkey}`, limit, 60, now);
        await consumeRateLimit(env, `push:device:${row.token_hash.slice(0, 24)}`,
          integerSetting(env.PUSH_TRIGGER_PER_MINUTE_PER_DEVICE, 30, 5, 600), 60, now);
        delivery = await reserve(sender, row.account_pubkey, messageId, row.token, now);
        if (!delivery.reserved) continue;
        const result = await sendNativePush(env, row.token);
        await complete(sender, row.account_pubkey, messageId, delivery.endpointHash, result.sent, now);
        if (result.sent) stats.sent++;
        else if (result.expired) {
          stats.expired++;
          await env.DB.prepare("DELETE FROM hainei_native_push_tokens WHERE account_pubkey = ? AND token_hash = ?")
            .bind(row.account_pubkey, row.token_hash).run();
        } else stats.failed++;
        console.info({ provider: "fcm", status: result.status, message: result.sent ? "native push sent" : "native push rejected" });
      } catch {
        if (delivery?.reserved) {
          await complete(sender, row.account_pubkey, messageId, delivery.endpointHash, false, now).catch(() => {});
        }
        stats.failed++;
        // Never print device tokens, service-account keys or FCM responses.
        console.error({ provider: "fcm", message: "native push delivery failed" });
      }
    }
  }));
  return stats;
}
