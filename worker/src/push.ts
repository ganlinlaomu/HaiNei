import { verifyEvent } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
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
/**
 * Every app launch re-registers its subscription, so a row untouched this
 * long belongs to a device that got a new endpoint or is gone. Apple keeps
 * delivering to some replaced endpoints, which showed duplicate banners.
 * A device that comes back simply re-registers.
 */
export const PUSH_SUBSCRIPTION_STALE_SECONDS = 30 * 24 * 60 * 60;
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
// Like messages, carries no caller name: the encrypted invite (push hint)
// tells the app who is calling once it opens.
export const CALL_PUSH_PAYLOAD = Object.freeze({
  type: "call" as const,
  title: "HaiNei",
  body: "你有一个语音来电",
  url: "/#/conversations",
});
const MAX_PUSH_HINTS = 8;
const MAX_PUSH_HINT_EVENT_BYTES = 8_000;
export type WorkerEncryptedPushHint = {
  recipient: string;
  eventId: string;
  relays: string[];
  event?: NostrEvent;
};

/** Hints are only routing metadata or signed, encrypted NIP-17 wraps. */
export function sanitizeEncryptedPushHints(value: unknown): WorkerEncryptedPushHint[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PUSH_HINTS).flatMap((item): WorkerEncryptedPushHint[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const recipient = typeof candidate.recipient === "string" ? candidate.recipient.toLowerCase() : "";
    const eventId = typeof candidate.eventId === "string" ? candidate.eventId.toLowerCase() : "";
    if (!PUBKEY.test(recipient) || !EVENT_ID.test(eventId)) return [];
    const relays = [...new Set((Array.isArray(candidate.relays) ? candidate.relays : [])
      .filter((url): url is string => typeof url === "string")
      .filter(url => {
        try { const parsed = new URL(url); return parsed.protocol === "wss:" && !parsed.username && !parsed.password && url.length <= 250; }
        catch { return false; }
      }))].slice(0, 2);
    const hint: WorkerEncryptedPushHint = { recipient, eventId, relays };
    const event = candidate.event as NostrEvent | undefined;
    if (event && JSON.stringify(event).length <= MAX_PUSH_HINT_EVENT_BYTES
      && event.id === eventId && event.kind === 1059
      && Array.isArray(event.tags) && event.tags.some(tag => tag[0] === "p" && tag[1] === recipient)) {
      // Verify a fresh plain event; never trust nostr-tools' symbol-cached
      // verification result on a mutated object passed by a caller.
      const signed = {
        id: event.id, sig: event.sig, pubkey: event.pubkey, created_at: event.created_at,
        kind: event.kind, tags: event.tags, content: event.content,
      };
      try { if (verifyEvent(signed)) hint.event = signed; } catch {}
    }
    return [hint];
  });
}


export function pushPayloadForType(value: unknown) {
  return value === "message" ? MESSAGE_PUSH_PAYLOAD : value === "call" ? CALL_PUSH_PAYLOAD : null;
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
  handled?: number;
};

// Wait before creating a Web Push, not after: WebKit requires every delivered
// push to show a notification. A visible, mounted call UI can claim only its
// own subscription and this exact invite during this bounded handoff window.
export const CALL_PUSH_HANDOFF_MS = 1_500;
const CALL_HANDLED_TTL_SECONDS = 5;

async function callHandledEndpointHash(endpoint: string) {
  return sha256Hex(`call-handled:${endpoint}`);
}

export async function acknowledgeVisibleCall(
  env: Env, recipientPubkey: string, endpointValue: unknown,
  senderValue: unknown, messageValue: unknown,
) {
  const endpoint = validatedPushEndpoint(env, endpointValue);
  const sender = typeof senderValue === "string" ? senderValue.toLowerCase() : "";
  const messageId = typeof messageValue === "string" ? messageValue.toLowerCase() : "";
  if (!PUBKEY.test(sender) || sender === recipientPubkey || !EVENT_ID.test(messageId)) {
    throw new HttpError(400, "invalid_call_acknowledgement");
  }
  // Use a separate hash namespace in the existing idempotency table. This is
  // not a provider delivery receipt; no schema migration or plaintext call
  // secrets are required. INSERT SELECT prevents acknowledging another account's
  // endpoint. Existing scheduled delivery cleanup also removes these rows.
  const result = await env.DB.prepare(`
    INSERT INTO hainei_push_deliveries
      (sender_pubkey, recipient_pubkey, message_id, endpoint_hash, status, updated_at)
    SELECT ?, ?, ?, ?, 'sent', ?
    FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
    ON CONFLICT(sender_pubkey, recipient_pubkey, message_id, endpoint_hash)
    DO UPDATE SET updated_at = excluded.updated_at
  `).bind(sender, recipientPubkey, messageId, await callHandledEndpointHash(endpoint),
    Math.floor(Date.now() / 1000), recipientPubkey, endpoint).run();
  return { acknowledged: Number(result.meta?.changes || 0) > 0 };
}

async function callWasHandled(env: Env, sender: string, messageId: string, row: PushSubscriptionRow) {
  const receipt = await env.DB.prepare(`
    SELECT updated_at FROM hainei_push_deliveries
    WHERE sender_pubkey = ? AND recipient_pubkey = ? AND message_id = ? AND endpoint_hash = ? AND status = 'sent'
  `).bind(sender, row.account_pubkey, messageId, await callHandledEndpointHash(row.endpoint))
    .first<{ updated_at: number }>();
  return !!receipt && receipt.updated_at >= Math.floor(Date.now() / 1000) - CALL_HANDLED_TTL_SECONDS;
}

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

export async function savePushSubscription(env: Env, accountPubkey: string, value: unknown, previousEndpointValue?: unknown) {
  const subscription = parseSubscription(env, value);
  const now = Math.floor(Date.now() / 1000);
  // The browser replaced this device's endpoint: drop the old row so the
  // device is not notified twice (and the old one ignores foreground state).
  if (typeof previousEndpointValue === "string" && previousEndpointValue && previousEndpointValue !== subscription.endpoint) {
    let previous = "";
    try { previous = validatedPushEndpoint(env, previousEndpointValue); } catch { /* ignore a bad hint */ }
    if (previous) {
      await env.DB.prepare(`
        DELETE FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
      `).bind(accountPubkey, previous).run();
    }
  }
  await env.DB.prepare(`
    DELETE FROM hainei_push_subscriptions
    WHERE account_pubkey = ? AND endpoint <> ? AND updated_at < ?
  `).bind(accountPubkey, subscription.endpoint, now - PUSH_SUBSCRIPTION_STALE_SECONDS).run();
  const existing = await env.DB.prepare(`
    SELECT endpoint FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
  `).bind(accountPubkey, subscription.endpoint).first<{ endpoint: string }>();

  if (!existing) {
    // Keep the newest devices and make room for this endpoint. Old PWA
    // subscriptions can survive reinstalls / cleared browser data and would
    // otherwise permanently block a valid current device at the hard limit.
    await env.DB.prepare(`
      DELETE FROM hainei_push_subscriptions
      WHERE account_pubkey = ?
        AND endpoint NOT IN (
          SELECT endpoint
          FROM hainei_push_subscriptions
          WHERE account_pubkey = ?
          ORDER BY updated_at DESC, created_at DESC, endpoint DESC
          LIMIT ?
        )
    `).bind(
      accountPubkey,
      accountPubkey,
      MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT - 1,
    ).run();
  }

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

/** How long a foreground report holds pushes back if the app never says it left. */
export const PUSH_FOREGROUND_TTL_SECONDS = 40;

/**
 * The app reports that this device is on screen (it gets messages and calls
 * over its own relay connection) or has left. Pushes skip the device while
 * foreground; the short TTL bounds a missed "left" report.
 */
export async function setPushForeground(env: Env, accountPubkey: string, endpointValue: unknown, foreground: unknown, now = Math.floor(Date.now() / 1000)) {
  const endpoint = validatedPushEndpoint(env, endpointValue);
  const until = foreground === true ? now + PUSH_FOREGROUND_TTL_SECONDS : 0;
  await env.DB.prepare(`
    UPDATE hainei_push_subscriptions SET foreground_until = ? WHERE account_pubkey = ? AND endpoint = ?
  `).bind(until, accountPubkey, endpoint).run();
  return { foregroundUntil: until };
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
  hintsValue?: unknown,
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
      ${pushPayload.type === "call" ? "" : "AND s.foreground_until <= ?"}
  `).bind(senderPubkey, now, ...recipients, ...(pushPayload.type === "call" ? [] : [now])).all<PushSubscriptionRow>();
  diagnostics.subscriptionsFound = rows.results.length;
  if (!rows.results.length) return diagnostics;

  if (pushPayload.type === "call") {
    diagnostics.handled = 0;
    await new Promise(resolve => setTimeout(resolve, CALL_PUSH_HANDOFF_MS));
    // A generic foreground heartbeat is never sufficient to suppress a call.
    // Missing/late UI acknowledgement always falls back to an actual push.
    const checked = await Promise.all(rows.results.map(async row => ({ row,
      handled: await callWasHandled(env, senderPubkey, messageId, row).catch(() => false),
    })));
    const pending = checked.filter(item => !item.handled).map(item => item.row);
    diagnostics.handled = checked.length - pending.length;
    if (!pending.length) return diagnostics;
    return deliverPushRows(env, senderPubkey, messageId, pending, diagnostics, now, sanitizeEncryptedPushHints(hintsValue), pushPayload);
  }

  return deliverPushRows(env, senderPubkey, messageId, rows.results, diagnostics, now, sanitizeEncryptedPushHints(hintsValue), pushPayload);
}

// The authenticated account can inspect delivery only to its own browser endpoint.
export async function testOwnPush(env: Env, accountPubkey: string, endpointValue: unknown) {
  const endpoint = validatedPushEndpoint(env, endpointValue);
  const now = Math.floor(Date.now() / 1000);
  await consumeRateLimit(env, `push:test:${accountPubkey}`, 5, 60, now);
  const row = await env.DB.prepare(`
    SELECT account_pubkey, endpoint, p256dh, auth FROM hainei_push_subscriptions
    WHERE account_pubkey = ? AND endpoint = ?
  `).bind(accountPubkey, endpoint).first<PushSubscriptionRow>();
  const diagnostics: PushDiagnostics = {
    requested: 1, subscriptionsFound: row ? 1 : 0, sent: 0, failed: 0, expired: 0,
  };
  if (!row) return diagnostics;
  const messageId = await sha256Hex(crypto.randomUUID());
  return deliverPushRows(env, accountPubkey, messageId, [row], diagnostics, now);
}

async function deliverPushRows(
  env: Env,
  senderPubkey: string,
  messageId: string,
  rows: PushSubscriptionRow[],
  diagnostics: PushDiagnostics,
  now: number,
  hints: WorkerEncryptedPushHint[] = [],
  pushPayload: typeof MESSAGE_PUSH_PAYLOAD | typeof CALL_PUSH_PAYLOAD = MESSAGE_PUSH_PAYLOAD,
) {
  const config = pushConfig(env);
  const timeoutMs = integerSetting(env.PUSH_FETCH_TIMEOUT_MS, 8000, 1000, 30000);

  const deadline = Date.now() + 20_000;
  await mapWithConcurrency(rows, 4, async row => {
    if (Date.now() >= deadline) { diagnostics.failed += 1; return; }
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

      const basePayload = {
        ...pushPayload,
        accountScope: await sha256Hex(row.account_pubkey),
        notificationId: await sha256Hex(`${row.auth}:${senderPubkey}:${messageId}`),
      };
      const matching = hints.find(hint => hint.recipient === row.account_pubkey);
      const hint = matching && {
        eventId: matching.eventId,
        relays: matching.relays,
        ...(matching.event ? { event: matching.event } : {}),
      };
      // Account for Web Push framing and UTF-8 content. Always retain the
      // small exact-ID route when the encrypted event exceeds push capacity.
      let packed = { ...basePayload, ...(hint ? { hint } : {}) };
      if (hint?.event && encoder.encode(JSON.stringify(packed)).length > 3_400) {
        packed = { ...basePayload, hint: { eventId: hint.eventId, relays: hint.relays } };
      }
      const [body, vapidHeaders] = await Promise.all([
        encryptPushPayload(JSON.stringify(packed), row.p256dh, row.auth),
        createVapidHeaders(config, row.endpoint),
      ]);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(row.endpoint, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            ...vapidHeaders,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "60",
            // A ringing call is worthless a minute later; ask for prompt delivery.
            ...(pushPayload.type === "call" ? { Urgency: "high" } : {}),
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

  // Old delivery rows are removed by the daily scheduled cleanup.
  return diagnostics;
}
