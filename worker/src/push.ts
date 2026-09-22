import webpush from "web-push";
import { HttpError, type Env } from "./types";

const PUBKEY = /^[0-9a-f]{64}$/;
export const GENERIC_PUSH_PAYLOAD = Object.freeze({
  title: "HaiNei",
  body: "有新的活动",
  url: "/#/notifications",
});

type PushSubscriptionRow = {
  account_pubkey: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

function pushConfig(env: Env) {
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

export async function triggerGenericPush(env: Env, senderPubkey: string, recipientValue: unknown) {
  const recipients = sanitizePushRecipients(recipientValue, senderPubkey);
  if (!recipients.length) return { queued: 0 };
  const config = pushConfig(env);
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const placeholders = recipients.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT account_pubkey, endpoint, p256dh, auth
    FROM hainei_push_subscriptions WHERE account_pubkey IN (${placeholders})
  `).bind(...recipients).all<PushSubscriptionRow>();
  const payload = JSON.stringify(GENERIC_PUSH_PAYLOAD);
  await Promise.allSettled(rows.results.map(async row => {
    try {
      await webpush.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }, payload, { TTL: 60 });
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await env.DB.prepare(`
          DELETE FROM hainei_push_subscriptions WHERE account_pubkey = ? AND endpoint = ?
        `).bind(row.account_pubkey, row.endpoint).run();
      }
    }
  }));
  return { queued: rows.results.length };
}
