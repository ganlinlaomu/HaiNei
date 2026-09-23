import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";

const PUSH_ACTION = "hainei_push";

type SignEvent = (event: EventTemplate) => Promise<VerifiedEvent>;

function baseUrl() {
  return String(import.meta.env.VITE_HAINEI_WORKER_URL || window.location.origin).trim().replace(/\/+$/, "");
}

async function responseJson(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(pushServiceErrorMessage(response.status, body?.error, fallback));
  return body;
}

export function pushServiceErrorMessage(status: number, code: unknown, fallback: string) {
  const error = typeof code === "string" ? code : "";
  if (status === 404 || error === "not_found") return "推送服务尚未部署，请更新 HaiNei Worker";
  if (error === "push_not_configured") return "推送服务尚未配置 VAPID";
  if (error === "push_storage_unavailable" || error === "internal_error") {
    return "推送服务数据库尚未准备好，请检查 Worker 部署和 D1 迁移";
  }
  return error || fallback;
}

async function authenticatedPost(path: string, payload: Record<string, unknown>, pubkey: string, signEvent: SignEvent) {
  const challengeResponse = await fetch(`${baseUrl()}/api/auth/challenge`, { method: "POST" });
  const challengeBody = await responseJson(challengeResponse, "获取推送授权失败");
  const challenge = String(challengeBody?.challenge || "");
  const expiresAt = Number(challengeBody?.expiresAt || 0);
  const now = Math.floor(Date.now() / 1000);
  const event = await signEvent({
    kind: 27235,
    created_at: now,
    content: "Authorize HaiNei push action",
    tags: [
      ["t", PUSH_ACTION],
      ["challenge", challenge],
      ["expiration", String(Math.min(expiresAt, now + 300))],
    ],
  });
  if (event.pubkey.toLowerCase() !== pubkey.toLowerCase()) throw new Error("推送授权账号不匹配");
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, challenge, event }),
  });
  return responseJson(response, "推送服务请求失败");
}

function applicationServerKey(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

export function supportsPushNotifications() {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export function pushEnabledForAccount(pubkey: string) {
  return !!pubkey && localStorage.getItem(`hainei_push_enabled_${pubkey.toLowerCase()}`) === "1";
}

export async function enablePushNotifications(pubkey: string, signEvent: SignEvent) {
  const enabledKey = `hainei_push_enabled_${pubkey.toLowerCase()}`;
  localStorage.removeItem(enabledKey);
  if (!supportsPushNotifications()) throw new Error("当前浏览器不支持推送通知");
  if (Notification.permission === "denied") throw new Error("推送权限已被浏览器拒绝，请在系统设置中恢复");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("未授予推送权限");
  const publicKeyResponse = await fetch(`${baseUrl()}/api/push/public-key`, { method: "POST" });
  const publicKeyBody = await responseJson(publicKeyResponse, "获取推送公钥失败");
  const publicKey = String(publicKeyBody?.publicKey || "").trim();
  if (!publicKey) throw new Error("推送服务尚未配置 VAPID");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  await authenticatedPost("/api/push/subscribe", { subscription: subscription.toJSON() }, pubkey, signEvent);
  localStorage.setItem(enabledKey, "1");
}

export async function disablePushNotifications(pubkey: string, signEvent: SignEvent) {
  if (!supportsPushNotifications()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await authenticatedPost("/api/push/unsubscribe", { endpoint: subscription.endpoint }, pubkey, signEvent);
  }
  localStorage.removeItem(`hainei_push_enabled_${pubkey.toLowerCase()}`);
}

export async function triggerGenericPush(
  recipientPubkeys: string[],
  pubkey: string,
  signEvent: SignEvent,
) {
  const recipients = [...new Set(recipientPubkeys.map(value => value.toLowerCase()))]
    .filter(value => value !== pubkey.toLowerCase());
  if (!recipients.length) return;
  await authenticatedPost("/api/push/trigger", { recipientPubkeys: recipients }, pubkey, signEvent);
}
