import { HttpError, integerSetting, type Env } from "./types";
import { consumeRateLimit } from "./requestGuards";

const encoder = new TextEncoder();
const WEB_PUSH_INFO = encoder.encode("WebPush: info\0");
const CONTENT_ENCODING_INFO = encoder.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = encoder.encode("Content-Encoding: nonce\0");
const RECORD_SIZE = 4096;
const MAX_PAYLOAD_SIZE = 3993;

const PUBKEY = /^[0-9a-f]{64}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;
const MAX_PUSH_ENDPOINT_LENGTH = 2048;
const MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT = 8;
const MAX_PUSH_AUTHORIZED_SENDERS = 200;
const DEFAULT_PUSH_PROVIDER_ORIGINS = [
  "https://web.push.apple.com",
  "https://fcm.googleapis.com",
  "https://updates.push.services.mozilla.com",
];
export const MESSAGE_PUSH_PAYLOAD = Object.freeze({
  type: "message" as const,
  title: "HaiNei",
  body: "你有新的私信消息",
  url: "/#/conversations",
});
export const GENERIC_PUSH_PAYLOAD = MESSAGE_PUSH_PAYLOAD;

export function pushPayloadForType(value: unknown) {
  return value === "message" ? MESSAGE_PUSH_PAYLOAD : null;
}

type PushSubscriptionRow = {
  account_pubkey: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushDiagnostics = {
  requested: number;
  subscriptionsFound: number;
  sent: number;
  failed: number;
  expired: number;
};

type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

function concatBytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function arrayBuffer(value: Uint8Array) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url value");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(base64);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function base64UrlEncode(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", arrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: arrayBuffer(salt),
    info: arrayBuffer(info),
  }, key, length * 8);
  return new Uint8Array(bits);
}

export async function encryptPushPayload(payload: string, p256dh: string, auth: string) {
  const userPublicKeyBytes = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);
  const plaintext = encoder.encode(payload);
  if (userPublicKeyBytes.length !== 65 || userPublicKeyBytes[0] !== 4) throw new Error("invalid subscription public key");
  if (authSecret.length !== 16) throw new Error("invalid subscription auth secret");
  if (plaintext.length > MAX_PAYLOAD_SIZE) throw new Error("push payload too large");

  const userPublicKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(userPublicKeyBytes),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const applicationKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const applicationPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", applicationKeyPair.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: userPublicKey },
    applicationKeyPair.privateKey,
    256,
  ));
  const keyInfo = concatBytes(WEB_PUSH_INFO, userPublicKeyBytes, applicationPublicKey);
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(inputKeyMaterial, salt, CONTENT_ENCODING_INFO, 16);
  const nonce = await hkdf(inputKeyMaterial, salt, NONCE_INFO, 12);
  const aesKey = await crypto.subtle.importKey("raw", arrayBuffer(contentEncryptionKey), "AES-GCM", false, ["encrypt"]);
  const record = concatBytes(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce) },
    aesKey,
    arrayBuffer(record),
  ));

  const header = new Uint8Array(21 + applicationPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = applicationPublicKey.length;
  header.set(applicationPublicKey, 21);
  return concatBytes(header, ciphertext);
}

export async function createVapidHeaders(config: VapidConfig, endpoint: string, now = Math.floor(Date.now() / 1000)) {
  const publicKeyBytes = base64UrlDecode(config.publicKey);
  const privateKeyBytes = base64UrlDecode(config.privateKey);
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) throw new Error("invalid VAPID public key");
  if (privateKeyBytes.length !== 32) throw new Error("invalid VAPID private key");

  const audience = new URL(endpoint).origin;
  const encodedHeader = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: config.subject,
  })));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(publicKeyBytes.slice(1, 33)),
      y: base64UrlEncode(publicKeyBytes.slice(33, 65)),
      d: base64UrlEncode(privateKeyBytes),
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    arrayBuffer(encoder.encode(unsignedToken)),
  ));
  const token = `${unsignedToken}.${base64UrlEncode(signature)}`;
  return {
    Authorization: `vapid t=${token}, k=${config.publicKey}`,
    "Crypto-Key": `p256ecdsa=${config.publicKey}`,
  };
}

function endpointHost(endpoint: string) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid-endpoint";
  }
}

function safePushErrorMessage(error: unknown, secrets: string[]) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted endpoint]");
}

function allowedPushOrigins(env: Env) {
  const configured = String(env.PUSH_ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const origins = configured.length ? configured : DEFAULT_PUSH_PROVIDER_ORIGINS;
  return new Set(origins.map(value => {
    try { return new URL(value).origin; } catch { return ""; }
  }).filter(Boolean));
}

function isIpLiteral(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (normalized.includes(":")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized);
}

function validatedPushEndpoint(env: Env, value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > MAX_PUSH_ENDPOINT_LENGTH) throw new HttpError(400, "invalid_push_subscription");
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "invalid_push_subscription"); }
  if (
    url.protocol !== "https:"
    || !!url.username
    || !!url.password
    || !!url.port
    || !url.hostname
    || isIpLiteral(url.hostname)
    || !allowedPushOrigins(env).has(url.origin)
  ) {
    throw new HttpError(400, "unsupported_push_endpoint");
  }
  return url.toString();
}

function pushConfig(env: Env): VapidConfig {
  const publicKey = String(env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || "").trim();
  const subject = String(env.VAPID_SUBJECT || "mailto:admin@hainei.app").trim();
  if (!publicKey || !privateKey) throw new HttpError(503, "push_not_configured");
  return { publicKey, privateKey, subject };
}

function parseSubscription(env: Env, value: unknown) {
  const item = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = validatedPushEndpoint(env, item?.endpoint);
  const p256dh = typeof item?.keys?.p256dh === "string" ? item.keys.p256dh.trim() : "";
  const auth = typeof item?.keys?.auth === "string" ? item.keys.auth.trim() : "";
  try {
    const publicKey = base64UrlDecode(p256dh);
    const authSecret = base64UrlDecode(auth);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || authSecret.length !== 16) {
      throw new Error("invalid key size");
    }
  } catch {
    throw new HttpError(400, "invalid_push_subscription");
  }
  return { endpoint, p256dh, auth };
}

export function getPushPublicKey(env: Env) {
  return { publicKey: pushConfig(env).publicKey };
}

export async function savePushSubscription(env: Env, accountPubkey: string, value: unknown) {
  const subscription = parseSubscription(env, value);
  const existing = await env.DB.prepare(`
    SELECT endpoint FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
  `).bind(accountPubkey, subscription.endpoint).first<{ endpoint: string }>();
  if (!existing) {
    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM hainei_push_subscriptions WHERE account_pubkey = ?
    `).bind(accountPubkey).first<{ count: number }>();
    if (Number(count?.count || 0) >= MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT) {
      throw new HttpError(429, "push_subscription_limit");
    }
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO hainei_push_subscriptions
      (account_pubkey, endpoint, p256dh, auth, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_pubkey, endpoint) DO UPDATE SET
      p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
  `).bind(accountPubkey, subscription.endpoint, subscription.p256dh, subscription.auth, now, now).run();
  return { subscribed: true };
}

export async function removePushSubscription(env: Env, accountPubkey: string, endpointValue: unknown) {
  const endpoint = validatedPushEndpoint(env, endpointValue);
  await env.DB.prepare(`
    DELETE FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
  `).bind(accountPubkey, endpoint).run();
  return { subscribed: false };
}

export function sanitizePushAuthorizedSenders(value: unknown, recipientPubkey: string) {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_push_authorization");
  const senders = [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim().toLowerCase())
    .filter(item => PUBKEY.test(item) && item !== recipientPubkey))];
  if (senders.length > MAX_PUSH_AUTHORIZED_SENDERS) throw new HttpError(400, "too_many_push_authorizations");
  return senders;
}

export async function replacePushAuthorizationPolicy(
  env: Env,
  recipientPubkey: string,
  senderValues: unknown,
  now = Math.floor(Date.now() / 1000),
) {
  const senders = sanitizePushAuthorizedSenders(senderValues, recipientPubkey);
  const ttl = integerSetting(env.PUSH_AUTHORIZATION_TTL_SECONDS, 30 * 24 * 60 * 60, 3600, 90 * 24 * 60 * 60);
  const expiresAt = now + ttl;

  // D1 executes the replacement as one transaction; concurrent refreshes
  // cannot interleave a removed sender back into another request's policy.
  const statements = [env.DB.prepare("DELETE FROM hainei_push_authorizations WHERE recipient_pubkey = ?")
    .bind(recipientPubkey)];
  for (const senderPubkey of senders) {
    statements.push(env.DB.prepare(`
      INSERT INTO hainei_push_authorizations
        (recipient_pubkey, sender_pubkey, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(recipient_pubkey, sender_pubkey) DO UPDATE SET
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).bind(recipientPubkey, senderPubkey, expiresAt, now));
  }
  await env.DB.batch(statements);
  return { accepted: true, expiresAt };
}

export function sanitizePushRecipients(value: unknown, senderPubkey: string) {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_recipients");
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim().toLowerCase())
    .filter(item => PUBKEY.test(item) && item !== senderPubkey))].slice(0, 100);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function reservePushDelivery(
  env: Env,
  senderPubkey: string,
  recipientPubkey: string,
  messageId: string,
  endpoint: string,
  now: number,
) {
  const endpointHash = await sha256Hex(endpoint);
  const staleBefore = now - 120;
  const result = await env.DB.prepare(`
    INSERT INTO hainei_push_deliveries
      (sender_pubkey, recipient_pubkey, message_id, endpoint_hash, status, updated_at)
    VALUES (?, ?, ?, ?, 'sending', ?)
    ON CONFLICT(sender_pubkey, recipient_pubkey, message_id, endpoint_hash)
    DO UPDATE SET status = 'sending', updated_at = excluded.updated_at
    WHERE hainei_push_deliveries.status != 'sent'
      AND hainei_push_deliveries.updated_at <= ?
  `).bind(senderPubkey, recipientPubkey, messageId, endpointHash, now, staleBefore).run();
  return { reserved: Number(result.meta?.changes || 0) === 1, endpointHash };
}

async function completePushDelivery(
  env: Env,
  senderPubkey: string,
  recipientPubkey: string,
  messageId: string,
  endpointHash: string,
  sent: boolean,
  now: number,
) {
  if (sent) {
    await env.DB.prepare(`
      UPDATE hainei_push_deliveries
      SET status = 'sent', updated_at = ?
      WHERE sender_pubkey = ? AND recipient_pubkey = ? AND message_id = ? AND endpoint_hash = ?
    `).bind(now, senderPubkey, recipientPubkey, messageId, endpointHash).run();
  } else {
    await env.DB.prepare(`
      DELETE FROM hainei_push_deliveries
      WHERE sender_pubkey = ? AND recipient_pubkey = ? AND message_id = ? AND endpoint_hash = ? AND status = 'sending'
    `).bind(senderPubkey, recipientPubkey, messageId, endpointHash).run();
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  }));
}

export async function triggerGenericPush(
  env: Env,
  senderPubkey: string,
  recipientValue: unknown,
  typeValue?: unknown,
  messageIdValue?: unknown,
) {
  const recipients = sanitizePushRecipients(recipientValue, senderPubkey);
  const diagnostics: PushDiagnostics = {
    requested: recipients.length,
    subscriptionsFound: 0,
    sent: 0,
    failed: 0,
    expired: 0,
  };
  const pushPayload = pushPayloadForType(typeValue);
  if (!pushPayload || !recipients.length) return diagnostics;

  const messageId = typeof messageIdValue === "string" ? messageIdValue.trim().toLowerCase() : "";
  if (!EVENT_ID.test(messageId)) throw new HttpError(400, "invalid_push_message_id");

  const senderLimit = integerSetting(env.PUSH_TRIGGER_PER_MINUTE_PER_SENDER, 60, 5, 600);
  const globalLimit = integerSetting(env.PUSH_TRIGGER_PER_MINUTE_GLOBAL, 1000, 50, 10000);
  const now = Math.floor(Date.now() / 1000);
  await consumeRateLimit(env, `push:sender:${senderPubkey}`, senderLimit, 60, now);
  await consumeRateLimit(env, "push:global", globalLimit, 60, now);

  const placeholders = recipients.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT s.account_pubkey, s.endpoint, s.p256dh, s.auth
    FROM hainei_push_subscriptions AS s
    INNER JOIN hainei_push_authorizations AS a
      ON a.recipient_pubkey = s.account_pubkey
      AND a.sender_pubkey = ?
      AND a.expires_at > ?
    WHERE s.account_pubkey IN (${placeholders})
  `).bind(senderPubkey, now, ...recipients).all<PushSubscriptionRow>();
  diagnostics.subscriptionsFound = rows.results.length;
  if (!rows.results.length) return diagnostics;

  const config = pushConfig(env);
  const timeoutMs = integerSetting(env.PUSH_FETCH_TIMEOUT_MS, 8000, 1000, 30000);

  const deadline = Date.now() + 20_000;
  await mapWithConcurrency(rows.results, 4, async row => {
    if (Date.now() >= deadline) return;
    const host = endpointHost(row.endpoint);
    let reservation: { reserved: boolean; endpointHash: string } | undefined;
    try {
      // Re-validate persisted data in case an older deployment stored unsafe rows.
      validatedPushEndpoint(env, row.endpoint);
      const recipientLimit = integerSetting(env.PUSH_TRIGGER_PER_MINUTE_PER_RECIPIENT, 30, 5, 600);
      const deviceLimit = integerSetting(env.PUSH_TRIGGER_PER_MINUTE_PER_DEVICE, 30, 5, 600);
      const endpointFingerprint = (await sha256Hex(row.endpoint)).slice(0, 24);
      await consumeRateLimit(env, `push:recipient:${row.account_pubkey}`, recipientLimit, 60, now);
      await consumeRateLimit(env, `push:device:${endpointFingerprint}`, deviceLimit, 60, now);
      reservation = await reservePushDelivery(env, senderPubkey, row.account_pubkey, messageId, row.endpoint, now);
      if (!reservation.reserved) return;

      const [body, vapidHeaders] = await Promise.all([
        encryptPushPayload(JSON.stringify({ ...pushPayload, accountScope: await sha256Hex(row.account_pubkey), notificationId: await sha256Hex(`${row.auth}:${senderPubkey}:${messageId}`) }), row.p256dh, row.auth),
        createVapidHeaders(config, row.endpoint),
      ]);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(row.endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            ...vapidHeaders,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "60",
          },
          body: arrayBuffer(body),
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        await completePushDelivery(env, senderPubkey, row.account_pubkey, messageId, reservation.endpointHash, true, now);
        diagnostics.sent += 1;
        console.info({ endpointHost: host, status: response.status, message: "push sent" });
        return;
      }

      await completePushDelivery(env, senderPubkey, row.account_pubkey, messageId, reservation.endpointHash, false, now);
      if (response.status === 404 || response.status === 410) {
        await env.DB.prepare(`
          DELETE FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
        `).bind(row.account_pubkey, row.endpoint).run();
        diagnostics.expired += 1;
      } else {
        diagnostics.failed += 1;
      }
      console.error({
        endpointHost: host,
        status: response.status,
        message: "push request failed",
      });
    } catch (error: unknown) {
      if (reservation?.reserved) {
        await completePushDelivery(env, senderPubkey, row.account_pubkey, messageId, reservation.endpointHash, false, now).catch(() => {});
      }
      diagnostics.failed += 1;
      console.error({
        endpointHost: host,
        message: safePushErrorMessage(error, [row.endpoint, row.p256dh, row.auth, config.privateKey]),
      });
    }
  });

  if ((now & 63) === 0) {
    void env.DB.prepare("DELETE FROM hainei_push_deliveries WHERE updated_at <= ?")
      .bind(now - 7 * 24 * 60 * 60).run().catch(() => {});
  }
  return diagnostics;
}
