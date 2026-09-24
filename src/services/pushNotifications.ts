import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { deviceStorage } from "@/services/deviceStorage";
import { debugLog } from "@/utils/debugLog";

const PUSH_ACTION = "hainei_push";
const SERVICE_WORKER_TIMEOUT_MS = 10_000;
const PUSH_SUBSCRIBE_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;

type SignEvent = (event: EventTemplate) => Promise<VerifiedEvent>;
export type PushCategory = "message" | "activity";

function baseUrl() {
  return String(import.meta.env.VITE_HAINEI_WORKER_URL || window.location.origin).trim().replace(/\/+$/, "");
}

async function responseJson(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(pushServiceErrorMessage(response.status, body?.error, fallback));
  return body;
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      error => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function pushFetch(input: RequestInfo | URL, init: RequestInit, timeoutMessage = "推送服务请求超时") {
  const controller = new AbortController();
  return new Promise<Response>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, FETCH_TIMEOUT_MS);
    fetch(input, { ...init, signal: controller.signal }).then(
      response => {
        globalThis.clearTimeout(timer);
        resolve(response);
      },
      error => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  const challengeResponse = await pushFetch(`${baseUrl()}/api/auth/challenge`, { method: "POST" });
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
  const response = await pushFetch(`${baseUrl()}${path}`, {
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

function sameApplicationServerKey(subscription: PushSubscription, expected: Uint8Array) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}

function reusableSubscription(subscription: PushSubscription, expected: Uint8Array) {
  const json = subscription.toJSON();
  return sameApplicationServerKey(subscription, expected)
    && typeof json.endpoint === "string"
    && json.endpoint.length > 0
    && typeof json.keys?.p256dh === "string"
    && json.keys.p256dh.length > 0
    && typeof json.keys?.auth === "string"
    && json.keys.auth.length > 0;
}

export function supportsPushNotifications() {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export function pushEnabledForAccount(pubkey: string) {
  return !!pubkey && deviceStorage.getItem(`hainei_push_enabled_${pubkey.toLowerCase()}`) === "1";
}

export async function enablePushNotifications(pubkey: string, signEvent: SignEvent) {
  const enabledKey = `hainei_push_enabled_${pubkey.toLowerCase()}`;
  deviceStorage.removeItem(enabledKey);
  if (!supportsPushNotifications()) throw new Error("当前浏览器不支持推送通知");
  if (Notification.permission === "denied") throw new Error("推送权限已被浏览器拒绝，请在系统设置中恢复");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("未授予推送权限");
  debugLog("system", "push_permission_ok");
  const publicKeyResponse = await pushFetch(`${baseUrl()}/api/push/public-key`, { method: "POST" }, "获取推送公钥超时");
  const publicKeyBody = await responseJson(publicKeyResponse, "获取推送公钥失败");
  const publicKey = String(publicKeyBody?.publicKey || "").trim();
  if (!publicKey) throw new Error("推送服务尚未配置 VAPID");
  debugLog("system", "push_public_key_ok");
  debugLog("system", "push_sw_ready_start");
  let registration: ServiceWorkerRegistration;
  try {
    registration = await withTimeout(navigator.serviceWorker.ready, SERVICE_WORKER_TIMEOUT_MS, "service worker 未就绪");
  } catch (error) {
    throw new Error("service worker 未就绪", { cause: error });
  }
  debugLog("system", "push_sw_ready_ok");
  debugLog("system", "push_subscribe_start");
  const serverKey = applicationServerKey(publicKey);
  let subscription: PushSubscription;
  try {
    const existing = await withTimeout(
      registration.pushManager.getSubscription(),
      PUSH_SUBSCRIBE_TIMEOUT_MS,
      "browser push subscription 失败",
    );
    if (existing && reusableSubscription(existing, serverKey)) {
      subscription = existing;
    } else {
      if (existing) {
        await withTimeout(existing.unsubscribe(), PUSH_SUBSCRIBE_TIMEOUT_MS, "browser push subscription 失败");
      }
      subscription = await withTimeout(registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      }), PUSH_SUBSCRIBE_TIMEOUT_MS, "push subscription 创建超时");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "push subscription 创建超时") throw error;
    throw new Error("browser push subscription 失败", { cause: error });
  }
  debugLog("system", "push_subscribe_ok");
  debugLog("system", "push_auth_start");
  await authenticatedPost("/api/push/subscribe", { subscription: subscription.toJSON() }, pubkey, signEvent);
  debugLog("system", "push_worker_subscribe_ok");
  deviceStorage.setItem(enabledKey, "1");
}

export async function disablePushNotifications(pubkey: string, signEvent: SignEvent) {
  if (!supportsPushNotifications()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await authenticatedPost("/api/push/unsubscribe", { endpoint: subscription.endpoint }, pubkey, signEvent);
  }
  deviceStorage.removeItem(`hainei_push_enabled_${pubkey.toLowerCase()}`);
}

export async function triggerGenericPush(
  recipientPubkeys: string[],
  pubkey: string,
  signEvent: SignEvent,
  type: PushCategory = "activity",
) {
  if (type !== "message") return;
  const recipients = [...new Set(recipientPubkeys.map(value => value.toLowerCase()))]
    .filter(value => value !== pubkey.toLowerCase());
  if (!recipients.length) return;
  await authenticatedPost("/api/push/trigger", { recipientPubkeys: recipients, type }, pubkey, signEvent);
}
