import { timedJsonFetch } from "@/utils/timedFetch";
import { signWorkerRequest } from "@/services/workerAuth";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
const SESSION_SCOPE = "upload";
const EXPIRY_SKEW_SECONDS = 5;

export type MediaSession = {
  token: string;
  pubkey: string;
  scope: "upload";
  expiresAt: number;
};

const cache = new Map<string, MediaSession>();
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


export function clearMediaSession(serverUrl: string, pubkey: string) {
  cache.delete(cacheKey(serverUrl, pubkey));
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
): Promise<MediaSession> {
  const pubkey = normalizedPubkey(accountPubkey);
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("当前 Nostr 账号公钥无效");
  const key = `${cacheKey(serverUrl, pubkey)}|${contentHash || ""}`;
  const cached = cache.get(key);
  // Upload capabilities are single-use: never reuse a settled token.
  if (!usable(cached)) cache.delete(key);


  const pending = (async () => {
    const base = workerBaseUrl();
    const challengeResponse = await timedJsonFetch(`${base}/api/auth/challenge`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const challengeBody = await json(challengeResponse, "获取身份验证 challenge 失败");
    const challenge = String(challengeBody?.challenge || "").trim().toLowerCase();
    const challengeExpiresAt = Number(challengeBody?.expiresAt);
    if (!/^[0-9a-f]{64}$/.test(challenge) || !Number.isSafeInteger(challengeExpiresAt)) {
      throw new Error("HaiNei Worker 返回了无效 challenge");
    }

    const url = `${base}/api/media/session`;
    const payload = { ...(fileSize === undefined ? {} : { fileSize }), ...(contentHash === undefined ? {} : { contentHash }) };
    const event = await signWorkerRequest(signEvent, pubkey, {
      action: "hainei_media_session",
      challenge,
      expiresAt: challengeExpiresAt,
      url,
      method: "POST",
      payload,
      content: "Authorize HaiNei media session",
    });
    const sessionResponse = await timedJsonFetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, challenge, event }),
    });
    const body = await json(sessionResponse, "获取媒体上传会话失败");
    const session: MediaSession = {
      token: String(body?.token || ""),
      pubkey: normalizedPubkey(body?.pubkey),
      scope: body?.scope,
      expiresAt: Number(body?.expiresAt),
    };
    if (!session.token || session.pubkey !== pubkey || session.scope !== SESSION_SCOPE || !usable(session)) {
      throw new Error("HaiNei Worker 返回了无效媒体会话");
    }

    return session;
  })();

  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}
