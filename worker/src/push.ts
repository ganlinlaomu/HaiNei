import { HttpError, type Env } from "./types";

const encoder = new TextEncoder();
const WEB_PUSH_INFO = encoder.encode("WebPush: info\0");
const CONTENT_ENCODING_INFO = encoder.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = encoder.encode("Content-Encoding: nonce\0");
const RECORD_SIZE = 4096;
const MAX_PAYLOAD_SIZE = 3993;

const PUBKEY = /^[0-9a-f]{64}$/;
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

function pushConfig(env: Env): VapidConfig {
  const publicKey = String(env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || "").trim();
  const subject = String(env.VAPID_SUBJECT || "mailto:admin@hainei.app").trim();
  if (!publicKey || !privateKey) throw new HttpError(503, "push_not_configured");
  return { publicKey, privateKey, subject };
}

function parseSubscription(value: unknown) {
  const item = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof item?.endpoint === "string" ? item.endpoint.trim() : "";
  const p256dh = typeof item?.keys?.p256dh === "string" ? item.keys.p256dh.trim() : "";
  const auth = typeof item?.keys?.auth === "string" ? item.keys.auth.trim() : "";
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw new HttpError(400, "invalid_push_subscription");
  return { endpoint, p256dh, auth };
}

export function getPushPublicKey(env: Env) {
  return { publicKey: pushConfig(env).publicKey };
}

export async function savePushSubscription(env: Env, accountPubkey: string, value: unknown) {
  const subscription = parseSubscription(value);
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
  const endpoint = typeof endpointValue === "string" ? endpointValue.trim() : "";
  if (!endpoint.startsWith("https://")) throw new HttpError(400, "invalid_push_subscription");
  await env.DB.prepare(`
    DELETE FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
  `).bind(accountPubkey, endpoint).run();
  return { subscribed: false };
}

export function sanitizePushRecipients(value: unknown, senderPubkey: string) {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_recipients");
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim().toLowerCase())
    .filter(item => PUBKEY.test(item) && item !== senderPubkey))].slice(0, 100);
}

export async function triggerGenericPush(env: Env, senderPubkey: string, recipientValue: unknown, typeValue?: unknown) {
  const recipients = sanitizePushRecipients(recipientValue, senderPubkey);
  const diagnostics: PushDiagnostics = {
    requested: recipients.length,
    subscriptionsFound: 0,
    sent: 0,
    failed: 0,
    expired: 0,
  };
  const pushPayload = pushPayloadForType(typeValue);
  if (!pushPayload) return diagnostics;
  if (!recipients.length) return diagnostics;
  const placeholders = recipients.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT account_pubkey, endpoint, p256dh, auth
    FROM hainei_push_subscriptions WHERE account_pubkey IN (${placeholders})
  `).bind(...recipients).all<PushSubscriptionRow>();
  diagnostics.subscriptionsFound = rows.results.length;
  if (!rows.results.length) return diagnostics;

  const config = pushConfig(env);
  const payload = JSON.stringify(pushPayload);
  await Promise.all(rows.results.map(async row => {
    const host = endpointHost(row.endpoint);
    try {
      const [body, vapidHeaders] = await Promise.all([
        encryptPushPayload(payload, row.p256dh, row.auth),
        createVapidHeaders(config, row.endpoint),
      ]);
      const response = await fetch(row.endpoint, {
        method: "POST",
        headers: {
          ...vapidHeaders,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "60",
        },
        body: arrayBuffer(body),
      });
      if (response.ok) {
        diagnostics.sent += 1;
        console.info({ recipientPubkey: row.account_pubkey, endpointHost: host, status: response.status, message: "push sent" });
        return;
      }
      if (response.status === 404 || response.status === 410) {
        await env.DB.prepare(`
          DELETE FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
        `).bind(row.account_pubkey, row.endpoint).run();
        diagnostics.expired += 1;
      } else {
        diagnostics.failed += 1;
      }
      console.error({
        recipientPubkey: row.account_pubkey,
        endpointHost: host,
        status: response.status,
        message: "push request failed",
      });
    } catch (error: unknown) {
      diagnostics.failed += 1;
      console.error({
        recipientPubkey: row.account_pubkey,
        endpointHost: host,
        message: safePushErrorMessage(error, [row.endpoint, row.p256dh, row.auth, config.privateKey]),
      });
    }
  }));
  return diagnostics;
}
