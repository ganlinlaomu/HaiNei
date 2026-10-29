import { timedJsonFetch } from "@/utils/timedFetch";
import { signedWorkerPost } from "@/services/workerAuth";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
const SESSION_SCOPE = "upload";
const EXPIRY_SKEW_SECONDS = 5;

export type MediaSession = {
  token: string;
  pubkey: string;
  scope: "upload";
  expiresAt: number;
};

const cache = new Map<string, MediaSession & { size?: number }>();
const inflight = new Map<string, Promise<MediaSession>>();

function normalizedPubkey(value: string | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizedUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function cacheKey(serverUrl: string, pubkey: string) {
  return `${normalizedUrl(serverUrl)}|${normalizedPubkey(pubkey)}`;
}

function workerBaseUrl() {
  return normalizedUrl(haineiWorkerBaseUrl());
}

function abortError() {
  const error = new Error("media_session_aborted");
  error.name = "AbortError";
  return error;
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function usable(session: MediaSession | undefined, now = Math.floor(Date.now() / 1000)) {
  return !!session && session.scope === SESSION_SCOPE && session.expiresAt > now + EXPIRY_SKEW_SECONDS;
}

async function json(response: Response, fallback: string) {
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error: any = new Error(body?.error || body?.message || `${fallback} (HTTP ${response.status})`);
    error.details = { status: response.status, body };
    throw error;
  }
  return body;
}


function postSessionRequest(
  pubkey: string,
  payload: Record<string, unknown>,
  signEvent: (event: any) => Promise<any> | any,
  signal?: AbortSignal,
) {
  const base = workerBaseUrl();
  const url = `${base}/api/media/session`;
  return signedWorkerPost(template => withAbort(signEvent(template), signal), pubkey, {
    action: "hainei_media_session",
    url,
    payload,
    content: "Authorize HaiNei media session",
    challenge: async () => {
      const body = await json(await timedJsonFetch(`${base}/api/auth/challenge`, {
        method: "POST",
        headers: { Accept: "application/json" },
        signal,
      }), "获取身份验证 challenge 失败");
      const challenge = String(body?.challenge || "").trim().toLowerCase();
      const expiresAt = Number(body?.expiresAt);
      if (!/^[0-9a-f]{64}$/.test(challenge) || !Number.isSafeInteger(expiresAt)) throw new Error("HaiNei Worker 返回了无效 challenge");
      return { challenge, expiresAt };
    },
    send: body => timedJsonFetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  });
}

function parseSession(raw: any, pubkey: string): MediaSession {
  const session: MediaSession = {
    token: String(raw?.token || ""),
    pubkey: normalizedPubkey(raw?.pubkey),
    scope: raw?.scope,
    expiresAt: Number(raw?.expiresAt),
  };
  if (!session.token || session.pubkey !== pubkey || session.scope !== SESSION_SCOPE || !usable(session)) {
    throw new Error("HaiNei Worker 返回了无效媒体会话");
  }
  return session;
}

export const MAX_PRIMED_MEDIA_SESSIONS = 4;

/**
 * Fetch upload tokens for several files with one signature and one request,
 * so the uploads that follow skip their own session round trip. Best effort:
 * on any failure each upload simply requests its own session.
 */
export async function primeMediaSessions(
  serverUrl: string,
  accountPubkey: string,
  signEvent: (event: any) => Promise<any> | any,
  items: Array<{ fileSize: number; contentHash: string }>,
  signal?: AbortSignal,
): Promise<number> {
  const pubkey = normalizedPubkey(accountPubkey);
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return 0;
  const wanted = items
    .filter(item => /^[0-9a-f]{64}$/.test(item.contentHash) && Number.isSafeInteger(item.fileSize) && item.fileSize > 0)
    .filter(item => !usable(cache.get(`${cacheKey(serverUrl, pubkey)}|${item.contentHash}`)))
    .slice(0, MAX_PRIMED_MEDIA_SESSIONS);
  if (!wanted.length) return 0;
  try {
    const response = await postSessionRequest(pubkey, { items: wanted }, signEvent, signal);
    const body = await json(response, "获取媒体上传会话失败");
    // An older Worker ignores `items`; it cannot answer with a batch.
    if (!Array.isArray(body?.sessions) || body.sessions.length !== wanted.length) return 0;
    const sessions = body.sessions.map((raw: any) => parseSession(raw, pubkey));
    sessions.forEach((session: MediaSession, index: number) => {
      cache.set(`${cacheKey(serverUrl, pubkey)}|${wanted[index].contentHash}`, { ...session, size: wanted[index].fileSize });
    });
    return sessions.length;
  } catch (error) {
    if (signal?.aborted) throw error;
    return 0;
  }
}

export function clearMediaSession(serverUrl: string, pubkey: string) {
  const prefix = cacheKey(serverUrl, pubkey);
  for (const key of [...cache.keys()]) if (key === prefix || key.startsWith(`${prefix}|`)) cache.delete(key);
}

export function resetMediaSessionCacheForTests() {
  cache.clear();
  inflight.clear();
}

export async function getMediaSession(
  serverUrl: string,
  accountPubkey: string,
  signEvent: (event: any) => Promise<any> | any,
  forceRefresh = false,
  fileSize?: number,
  contentHash?: string,
  signal?: AbortSignal,
): Promise<MediaSession> {
  const pubkey = normalizedPubkey(accountPubkey);
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("当前 Nostr 账号公钥无效");
  const key = `${cacheKey(serverUrl, pubkey)}|${contentHash || ""}`;
  const cached = cache.get(key);
  // Upload capabilities are single-use: a primed token is handed out once.
  cache.delete(key);
  if (!forceRefresh && contentHash && cached && usable(cached) && cached.size === fileSize) return cached;

  const pending = (async () => {
    const payload = { ...(fileSize === undefined ? {} : { fileSize }), ...(contentHash === undefined ? {} : { contentHash }) };
    const sessionResponse = await postSessionRequest(pubkey, payload, signEvent, signal);
    const body = await json(sessionResponse, "获取媒体上传会话失败");
    return parseSession(body, pubkey);
  })();

  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}
