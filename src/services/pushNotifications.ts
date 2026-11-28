import type { EventTemplate, VerifiedEvent, NostrEvent } from "nostr-tools";
import { deviceStorage } from "@/services/deviceStorage";
import { debugLog, startupMark } from "@/utils/debugLog";
import { sha256Hex, signWorkerRequest, signedWorkerPost } from "@/services/workerAuth";
import { DEFAULT_HAINEI_WORKER_URL, haineiWorkerBaseUrl, resolveHaiNeiWorkerBaseUrl } from "@/services/workerUrl";
import { friendRepository } from "@/repositories/friendRepository";

const PUSH_ACTION = "hainei_push";
const SERVICE_WORKER_TIMEOUT_MS = 10_000;
const PUSH_SUBSCRIBE_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const PUSH_SYNC_COOLDOWN_MS = 10 * 60_000;

type SignEvent = (event: EventTemplate) => Promise<VerifiedEvent>;
export type PushCategory = "message" | "call" | "activity";
export type EncryptedPushHint = { recipient: string; eventId: string; relays: string[]; event?: NostrEvent };

export { DEFAULT_HAINEI_WORKER_URL };

export function resolvePushWorkerBaseUrl(configuredUrl: string | undefined, pageOrigin: string, isProduction: boolean) {
  return resolveHaiNeiWorkerBaseUrl(configuredUrl, pageOrigin, isProduction);
}

function baseUrl() {
  return haineiWorkerBaseUrl();
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
  if (error === "push_queue_unavailable") return "推送延迟队列尚未部署，请更新 HaiNei Worker";
  if (error === "push_subscription_limit") return "推送设备记录已达上限，请重新开启推送";
  if (error === "push_storage_unavailable" || error === "internal_error") {
    return "推送服务数据库尚未准备好，请检查 Worker 部署和 D1 迁移";
  }
  return error || fallback;
}

async function authenticatedPost(path: string, payload: Record<string, unknown>, pubkey: string, signEvent: SignEvent) {
  const url = `${baseUrl()}${path}`;
  const response = await signedWorkerPost(signEvent, pubkey, {
    action: PUSH_ACTION,
    url,
    payload,
    content: "Authorize HaiNei push action",
    challenge: async () => responseJson(await pushFetch(`${baseUrl()}/api/auth/challenge`, { method: "POST" }), "获取推送授权失败"),
    send: body => pushFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
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

export async function enablePushNotifications(pubkey: string, signEvent: SignEvent, authorizedSenderPubkeys: string[] = []) {
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
  await syncRegisteredPush(subscription, pubkey, signEvent, authorizedSenderPubkeys, true);
  debugLog("system", "push_worker_subscribe_ok");
  debugLog("system", "push_policy_sync_ok");
  deviceStorage.setItem(enabledKey, "1");
}

type PolicySync = { running: Promise<boolean>; next?: { senderPubkeys: string[]; signEvent: SignEvent; result: Promise<boolean> } };
const policySyncs = new Map<string, PolicySync>();

/**
 * Startup and friendship changes can request a resync at the same moment.
 * Run one at a time per account; calls made meanwhile share a single
 * follow-up run with the latest sender list.
 */
export function syncPushAuthorizationPolicy(
  pubkey: string,
  senderPubkeys: string[],
  signEvent: SignEvent,
): Promise<boolean> {
  const key = pubkey.toLowerCase();
  const current = policySyncs.get(key);
  if (current) {
    if (current.next) {
      current.next.senderPubkeys = senderPubkeys;
      current.next.signEvent = signEvent;
      return current.next.result;
    }
    const next = { senderPubkeys, signEvent } as NonNullable<PolicySync["next"]>;
    next.result = current.running.catch(() => false).then(() => {
      const entry = { running: runPushAuthorizationPolicySync(pubkey, next.senderPubkeys, next.signEvent) };
      policySyncs.set(key, entry);
      return trackPolicySync(key, entry);
    });
    current.next = next;
    return next.result;
  }
  const entry: PolicySync = { running: runPushAuthorizationPolicySync(pubkey, senderPubkeys, signEvent) };
  policySyncs.set(key, entry);
  return trackPolicySync(key, entry);
}

function trackPolicySync(key: string, entry: PolicySync) {
  return entry.running.finally(() => {
    if (policySyncs.get(key) === entry && !entry.next) policySyncs.delete(key);
  });
}

async function runPushAuthorizationPolicySync(
  pubkey: string,
  senderPubkeys: string[],
  signEvent: SignEvent,
) {
  if (!pushEnabledForAccount(pubkey)) return false;
  if (!supportsPushNotifications() || Notification.permission !== "granted") return false;

  // The local opt-in flag can outlive a Worker/D1 redeploy. Re-register the
  // browser's existing subscription before refreshing the recipient policy so
  // a valid iOS PWA subscription repairs a missing server-side row automatically.
  const enabledKey = `hainei_push_enabled_${pubkey.toLowerCase()}`;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await withTimeout(
      navigator.serviceWorker.ready,
      SERVICE_WORKER_TIMEOUT_MS,
      "service worker 未就绪",
    );
  } catch (error) {
    throw new Error("service worker 未就绪", { cause: error });
  }
  const subscription = await withTimeout(
    registration.pushManager.getSubscription(),
    PUSH_SUBSCRIBE_TIMEOUT_MS,
    "browser push subscription 失败",
  );
  if (!subscription) {
    deviceStorage.removeItem(enabledKey);
    debugLog("system", "push_subscription_missing", {}, "warn");
    return false;
  }

  await syncRegisteredPush(subscription, pubkey, signEvent, senderPubkeys);
  debugLog("system", "push_worker_resubscribe_ok");
  debugLog("system", "push_policy_resync_ok");
  return true;
}

const endpointKey = (pubkey: string) => `hainei_push_endpoint_${pubkey.toLowerCase()}`;
const presenceTokenKey = (pubkey: string) => `hainei_push_presence_token_${pubkey.toLowerCase()}`;
const syncMetadataKey = (pubkey: string) => `hainei_push_sync_${pubkey.toLowerCase()}`;

type PushSyncMetadata = { endpoint: string; policyHash: string; verifiedAt: number };

function subscriptionEndpoint(subscription: PushSubscription) {
  return subscription.endpoint || String(subscription.toJSON().endpoint || "");
}

async function effectiveAuthorizedSenders(pubkey: string, senderPubkeys: string[]) {
  const muted = new Set(await friendRepository.listMutedPeers(pubkey).catch(() => [] as string[]));
  return [...new Set(senderPubkeys.map(value => value.toLowerCase()))]
    .filter(value => !muted.has(value))
    .sort();
}

function readSyncMetadata(pubkey: string): PushSyncMetadata | null {
  try {
    const parsed = JSON.parse(deviceStorage.getItem(syncMetadataKey(pubkey)) || "null") as PushSyncMetadata | null;
    return parsed && typeof parsed.endpoint === "string" && typeof parsed.policyHash === "string"
      && Number.isFinite(parsed.verifiedAt) ? parsed : null;
  } catch { return null; }
}

/**
 * Register the endpoint and replace its sender policy in one signed request.
 * A successful identical sync is reused briefly so opening Settings or
 * duplicate startup hooks never prompt a NIP-46 signer again.
 */
async function syncRegisteredPush(
  subscription: PushSubscription,
  pubkey: string,
  signEvent: SignEvent,
  senderPubkeys: string[],
  force = false,
) {
  const endpoint = subscriptionEndpoint(subscription);
  if (!endpoint) throw new Error("browser push subscription 失败");
  const authorized = await effectiveAuthorizedSenders(pubkey, senderPubkeys);
  const policyHash = await sha256Hex(JSON.stringify(authorized));
  const previous = deviceStorage.getItem(endpointKey(pubkey)) || "";
  const cached = readSyncMetadata(pubkey);
  if (!force && cached?.endpoint === endpoint && cached.policyHash === policyHash
    && Date.now() - cached.verifiedAt < PUSH_SYNC_COOLDOWN_MS
    && !!deviceStorage.getItem(presenceTokenKey(pubkey))) return;
  const result = await authenticatedPost("/api/push/sync", {
    subscription: subscription.toJSON(),
    senderPubkeys: authorized,
    ...(previous && previous !== endpoint ? { previousEndpoint: previous } : {}),
  }, pubkey, signEvent);
  const presenceToken = String(result?.presenceToken || "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(presenceToken)) throw new Error("推送服务未返回设备状态令牌");
  deviceStorage.setItem(endpointKey(pubkey), endpoint);
  deviceStorage.setItem(presenceTokenKey(pubkey), presenceToken);
  deviceStorage.setItem(syncMetadataKey(pubkey), JSON.stringify({ endpoint, policyHash, verifiedAt: Date.now() }));
}

/** Detach this device's endpoint from an outgoing account; keep the browser
 * subscription intact so the incoming account can reuse it after unlocking. */
export async function unsubscribeAccountPushOnExit(pubkey: string, signEvent: SignEvent) {
  if (!supportsPushNotifications()) return false;
  const savedEndpoint = deviceStorage.getItem(endpointKey(pubkey));
  const endpoint = savedEndpoint || (await withTimeout(
    navigator.serviceWorker.ready, SERVICE_WORKER_TIMEOUT_MS, "service worker 未就绪",
  ).then(registration => registration.pushManager.getSubscription()))?.endpoint;
  if (!endpoint) return false;
  await authenticatedPost("/api/push/unsubscribe", { endpoint }, pubkey, signEvent);
  deviceStorage.removeItem(endpointKey(pubkey));
  deviceStorage.removeItem(presenceTokenKey(pubkey));
  deviceStorage.removeItem(syncMetadataKey(pubkey));
  // Preserve the opt-in flag: the next time this account unlocks on this device
  // its browser subscription must be registered again with the worker.
  return true;
}

export async function disablePushNotifications(pubkey: string, signEvent: SignEvent) {
  if (!supportsPushNotifications()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await authenticatedPost("/api/push/unsubscribe", { endpoint: subscription.endpoint }, pubkey, signEvent);
  }
  deviceStorage.removeItem(`hainei_push_enabled_${pubkey.toLowerCase()}`);
  deviceStorage.removeItem(endpointKey(pubkey));
  deviceStorage.removeItem(presenceTokenKey(pubkey));
  deviceStorage.removeItem(syncMetadataKey(pubkey));
}

export async function triggerGenericPush(
  recipientPubkeys: string[],
  pubkey: string,
  signEvent: SignEvent,
  type: PushCategory = "activity",
  messageId?: string,
  hints: EncryptedPushHint[] = [],
  shouldSendCall?: () => boolean,
) {
  if (type !== "message" && type !== "call") return;
  const recipients = [...new Set(recipientPubkeys.map(value => value.toLowerCase()))]
    .filter(value => value !== pubkey.toLowerCase());
  if (!recipients.length) return;
  const payload = {
    recipientPubkeys: recipients,
    type,
    ...(messageId ? { messageId } : {}),
    ...(hints.length ? { hints } : {}),
  };
  // Calls are ephemeral: retry a transient request failure once, using the
  // same canonical ID so the Worker's per-device reservation prevents repeats.
  // Never put call invites in the ordinary 24-hour message retry queue.
  const retryBefore = Date.now() + 5_000;
  for (let attempt = 1; ; attempt++) {
    if (type === "call" && shouldSendCall && !shouldSendCall()) return;
    try {
      await authenticatedPost("/api/push/trigger", payload, pubkey, signEvent);
      if (type === "call") startupMark("call_push_requested", { attempt });
      return;
    } catch (error) {
      if (type !== "call" || attempt >= 2 || Date.now() >= retryBefore) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}


type CallHandledChallenge = { account: string; challenge: string; expiresAt: number };
const CALL_CHALLENGE_EXPIRY_MARGIN_SECONDS = 10;
let readyCallChallenge: CallHandledChallenge | null = null;
let callChallengeFlight: { account: string; promise: Promise<boolean> } | null = null;
let callChallengeEpoch = 0;

function takeCallHandledChallenge(account: string) {
  const ready = readyCallChallenge;
  readyCallChallenge = null; // Worker consumes challenges exactly once.
  return ready?.account === account.toLowerCase()
    && ready.expiresAt > Math.floor(Date.now() / 1000) + CALL_CHALLENGE_EXPIRY_MARGIN_SECONDS
    ? ready : null;
}

/** Drop cached authorization when the account locks or the page hides. */
export function clearCallHandledChallenge() {
  callChallengeEpoch++;
  readyCallChallenge = null;
}

/** Warm one single-use call-handled challenge while the app is unlocked and visible. */
export async function prefetchCallHandledChallenge(pubkey: string) {
  const account = pubkey.toLowerCase();
  if (!account || !supportsPushNotifications() || !pushEnabledForAccount(account)
    || document.visibilityState !== "visible") return false;
  if (readyCallChallenge?.account === account
    && readyCallChallenge.expiresAt > Math.floor(Date.now() / 1000) + CALL_CHALLENGE_EXPIRY_MARGIN_SECONDS) return true;
  readyCallChallenge = null;
  if (callChallengeFlight?.account === account) return callChallengeFlight.promise;
  const epoch = ++callChallengeEpoch;
  const promise = (async () => {
    const result = await responseJson(
      await pushFetch(`${baseUrl()}/api/auth/challenge`, { method: "POST" }),
      "获取来电确认授权失败",
    );
    const challenge = String(result?.challenge || "").toLowerCase();
    const expiresAt = Number(result?.expiresAt);
    if (!/^[0-9a-f]{64}$/.test(challenge) || !Number.isFinite(expiresAt)
      || expiresAt <= Math.floor(Date.now() / 1000) + CALL_CHALLENGE_EXPIRY_MARGIN_SECONDS
      || epoch !== callChallengeEpoch || document.visibilityState !== "visible") return false;
    readyCallChallenge = { account, challenge, expiresAt };
    return true;
  })();
  callChallengeFlight = { account, promise };
  try { return await promise; }
  finally { if (callChallengeFlight?.promise === promise) callChallengeFlight = null; }
}

/** Call only after the incoming UI has mounted, never for mere visibility. */
export async function acknowledgeCallNotification(
  pubkey: string, signEvent: SignEvent, senderPubkey: string, messageId: string,
  isCurrent: () => boolean,
) {
  if (!/^[0-9a-f]{64}$/i.test(messageId) || !supportsPushNotifications()
    || !pushEnabledForAccount(pubkey) || document.visibilityState !== "visible" || !isCurrent()) return;
  const registration = await withTimeout(navigator.serviceWorker.ready, SERVICE_WORKER_TIMEOUT_MS, "service worker 未就绪");
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription || document.visibilityState !== "visible" || !isCurrent()) return;
  const payload = { endpoint: subscription.endpoint, senderPubkey, messageId };
  const cached = takeCallHandledChallenge(pubkey);
  let response;
  if (cached) {
    const url = `${baseUrl()}/api/push/call-handled`;
    const event = await signWorkerRequest(signEvent, pubkey, {
      action: PUSH_ACTION, url, method: "POST", payload,
      content: "Authorize HaiNei push action",
      challenge: cached.challenge, expiresAt: cached.expiresAt,
    });
    // Signing can outlive a fast decline or account switch.
    if (document.visibilityState !== "visible" || !isCurrent()) return;
    response = await responseJson(await pushFetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, challenge: cached.challenge, event }),
    }), "来电确认失败");
  } else {
    // Original single-trip (with challenge fallback) when cache is unavailable or expired.
    response = await authenticatedPost("/api/push/call-handled", payload, pubkey, signEvent);
  }
  startupMark("call_notification_handoff", { acknowledged: response?.acknowledged === true });
}

export async function testPushNotification(pubkey: string, signEvent: SignEvent) {
  if (!supportsPushNotifications() || Notification.permission !== "granted") {
    throw new Error("请先开启本机推送权限");
  }
  const registration = await withTimeout(navigator.serviceWorker.ready, SERVICE_WORKER_TIMEOUT_MS, "service worker 未就绪");
  const subscription = await withTimeout(registration.pushManager.getSubscription(), PUSH_SUBSCRIBE_TIMEOUT_MS, "读取本机推送订阅超时");
  if (!subscription) throw new Error("本机推送订阅已失效，请重新开启推送");
  const result = await authenticatedPost("/api/push/test", { endpoint: subscription.endpoint }, pubkey, signEvent);
  if (!result?.subscriptionsFound) throw new Error("服务器没有本机的推送订阅，请重新开启推送");
  if (result.expired) throw new Error("系统推送订阅已过期，请重新开启推送");
  if (!result.sent) throw new Error("推送服务发送失败，请检查 Worker 日志中的 VAPID 或推送服务响应");
  return "系统推送服务已接受测试通知；请确认本机是否弹出提醒。此结果不代表通知已经显示。";
}

/**
 * A subscription-scoped capability makes the lifecycle request cheap and
 * safe to send with keepalive. The delayed queue is still the correctness
 * fallback when iOS freezes the page before a final hidden report.
 */
export async function reportPushForeground(pubkey: string, foreground: boolean) {
  if (!supportsPushNotifications() || !pushEnabledForAccount(pubkey)) return;
  const endpoint = deviceStorage.getItem(endpointKey(pubkey));
  const presenceToken = deviceStorage.getItem(presenceTokenKey(pubkey));
  if (!endpoint || !presenceToken) return;
  const response = await fetch(`${baseUrl()}/api/push/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, presenceToken, foreground }),
    keepalive: !foreground,
  });
  if (foreground && !response.ok) throw new Error("推送前台状态更新失败");
}
