import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { signedWorkerPost } from "@/services/workerAuth";
import { timedJsonFetch } from "@/utils/timedFetch";
import { deviceStorage } from "@/services/deviceStorage";
import { startupMark } from "@/utils/debugLog";

const CONFIG_CACHE_MS = 5 * 60_000;
const EXPIRY_SKEW_SECONDS = 30;
// Sessions last a day and are kept per account (encrypted with its local
// data), so most launches connect without the ~1 s challenge + session
// round trips. Renew in the background once less than this remains.
const RENEW_AHEAD_SECONDS = 2 * 60 * 60;
const storedSessionKey = (pubkey: string) => `nostr_relay_session_${pubkey}`;
const MANAGED_RELAY_STORAGE_KEY = "hainei_managed_relay_url";
const RECEIVED_SINCE_STORAGE_KEY = "hainei_relay_received_since";
const RECEIVED_SINCE_CACHE_MS = 24 * 60 * 60_000;
const RECEIVED_SINCE_RETRY_MS = 10 * 60_000;

export type ManagedRelayConfig = {
  enabled: boolean;
  relayUrl: string;
};

export type ManagedRelaySession = {
  token: string;
  pubkey: string;
  relayUrl: string;
  scope: "relay";
  expiresAt: number;
};

type RelaySigner = (event: EventTemplate) => Promise<VerifiedEvent>;

let configCache: { value: ManagedRelayConfig; loadedAt: number } | null = null;
let configInflight: Promise<ManagedRelayConfig> | null = null;
let identity: { pubkey: string; signEvent: RelaySigner } | null = null;
let sessionCache: ManagedRelaySession | null = null;
let sessionInflight: Promise<ManagedRelaySession> | null = null;
let renewInflight: Promise<unknown> | null = null;
// Tokens read back from storage rather than issued in this app session.
const restoredTokens = new Set<string>();
let receivedSinceProbe: { url: string; supported: boolean; checkedAt: number; ttl: number } | null = null;
let receivedSinceInflight: Promise<boolean> | null = null;

function workerBaseUrl() {
  return haineiWorkerBaseUrl().replace(/\/+$/, "");
}

async function json(response: Response, fallback: string) {
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new Error(body?.error || body?.message || `${fallback} (HTTP ${response.status})`);
  return body;
}

function usable(session: ManagedRelaySession | null, now = Math.floor(Date.now() / 1000)) {
  return !!session && session.scope === "relay" && session.expiresAt > now + EXPIRY_SKEW_SECONDS;
}

function storedSession(pubkey: string): ManagedRelaySession | null {
  try {
    const value = JSON.parse(deviceStorage.getItem(storedSessionKey(pubkey)) || "null");
    const session: ManagedRelaySession = {
      token: String(value?.token || ""),
      pubkey: String(value?.pubkey || ""),
      relayUrl: normalizeRelayUrl(String(value?.relayUrl || "")),
      scope: value?.scope,
      expiresAt: Number(value?.expiresAt),
    };
    return session.token.startsWith("nrs_") && session.pubkey === pubkey && session.relayUrl && usable(session) ? session : null;
  } catch {
    return null;
  }
}

function persistSession(session: ManagedRelaySession) {
  try { deviceStorage.setItem(storedSessionKey(session.pubkey), JSON.stringify(session)); } catch { /* memory copy still works */ }
}

/** Synchronous read for socket factories; null unless a fresh token is cached. */
export function cachedManagedRelaySession(url: string) {
  const normalizedUrl = normalizeRelayUrl(url);
  const session = usable(sessionCache) && sessionCache?.relayUrl === normalizedUrl && sessionCache.pubkey === identity?.pubkey ? sessionCache : null;
  if (session && session.expiresAt - Math.floor(Date.now() / 1000) < RENEW_AHEAD_SECONDS && !renewInflight) {
    // Swap in a fresh session before this one lapses; sockets keep using
    // the current token until then.
    renewInflight = getManagedRelaySessionForUrl(normalizedUrl, true)
      .catch(() => undefined)
      .finally(() => { renewInflight = null; });
  }
  return session;
}

export function registerRelaySessionSigner(pubkey: string, signEvent: RelaySigner) {
  const normalized = String(pubkey || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return false;
  if (identity?.pubkey !== normalized) {
    sessionCache = null;
    sessionInflight = null;
  }
  identity = { pubkey: normalized, signEvent };
  if (!usable(sessionCache)) {
    sessionCache = storedSession(normalized);
    if (sessionCache) restoredTokens.add(sessionCache.token);
  }
  return true;
}

/**
 * The relay refused a session restored from storage (for example after the
 * app was re-created in the relay admin). Forget it so the next connection
 * asks for a new one. Fresh sessions are never dropped here, so a relay
 * that rejects every session cannot cause a token request loop.
 */
export function invalidateRestoredRelaySession(token: string) {
  if (!restoredTokens.delete(token)) return false;
  if (sessionCache?.token === token) {
    try { deviceStorage.removeItem(storedSessionKey(sessionCache.pubkey)); } catch { /* replaced on next issue */ }
    sessionCache = null;
  }
  return true;
}

export function clearRelaySessionSigner(pubkey?: string) {
  if (pubkey && identity?.pubkey !== pubkey.toLowerCase()) return;
  identity = null;
  sessionCache = null;
  sessionInflight = null;
}

export function resetManagedRelaySessionForTests() {
  receivedSinceProbe = null;
  receivedSinceInflight = null;
  configCache = null;
  configInflight = null;
  identity = null;
  sessionCache = null;
  sessionInflight = null;
  renewInflight = null;
}

export function managedRelayUrlFromCache() {
  const cached = configCache?.value.enabled ? normalizeRelayUrl(configCache.value.relayUrl) : "";
  if (cached) return cached;
  try {
    return normalizeRelayUrl(deviceStorage.getItem(MANAGED_RELAY_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

export async function getManagedRelayConfig(force = false): Promise<ManagedRelayConfig> {
  if (!force && configCache && Date.now() - configCache.loadedAt < CONFIG_CACHE_MS) return configCache.value;
  if (!force && configInflight) return configInflight;
  const pending = (async () => {
    const response = await timedJsonFetch(`${workerBaseUrl()}/api/relay/config`, {
      method: "GET",
      headers: { Accept: "application/json" },
    }, 3_000);
    const body = await json(response, "获取托管 Relay 配置失败");
    if (body?.enabled === false) {
      const value = { enabled: false, relayUrl: "" };
      configCache = { value, loadedAt: Date.now() };
      return value;
    }
    const relayUrl = normalizeRelayUrl(String(body?.relayUrl || ""));
    if (body?.enabled !== true || !relayUrl) throw new Error("HaiNei Worker 返回了无效 Relay 配置");
    const value = { enabled: true, relayUrl };
    configCache = { value, loadedAt: Date.now() };
    return value;
  })();
  configInflight = pending;
  try { return await pending; }
  finally { if (configInflight === pending) configInflight = null; }
}

export async function getManagedRelaySessionForUrl(url: string, force = false): Promise<ManagedRelaySession | null> {
  const normalizedUrl = normalizeRelayUrl(url);
  if (!normalizedUrl) return null;
  // A saved session for the relay last configured as managed is enough to
  // connect. Fetching the config first cost a worker round trip on every
  // start, and on a slow network its 3 s timeout kept the relay offline.
  if (
    !force && identity && usable(sessionCache)
    && sessionCache?.pubkey === identity.pubkey && sessionCache.relayUrl === normalizedUrl
    && managedRelayUrlFromCache() === normalizedUrl
  ) {
    void getManagedRelayConfig().catch(() => undefined);
    return sessionCache;
  }
  const config = await getManagedRelayConfig();
  if (!config.enabled || config.relayUrl !== normalizedUrl) return null;
  if (!identity) throw new Error("relay_session_identity_unavailable");

  if (!force && usable(sessionCache) && sessionCache?.pubkey === identity.pubkey && sessionCache.relayUrl === normalizedUrl) {
    return sessionCache;
  }
  if (!force && sessionInflight) return sessionInflight;

  const currentIdentity = identity;
  const tokenStarted = Date.now();
  const pending = (async () => {
    const base = workerBaseUrl();
    const endpoint = `${base}/api/relay/session`;
    const response = await signedWorkerPost(currentIdentity.signEvent, currentIdentity.pubkey, {
      action: "hainei_relay_session",
      url: endpoint,
      payload: {},
      content: "Authorize HaiNei relay session",
      ensureCurrent: () => { if (identity !== currentIdentity) throw new Error("relay_session_account_changed"); },
      challenge: async () => {
        const body = await json(await timedJsonFetch(`${base}/api/auth/challenge`, {
          method: "POST",
          headers: { Accept: "application/json" },
        }), "获取 Relay 身份验证 challenge 失败");
        const challenge = String(body?.challenge || "").trim().toLowerCase();
        const expiresAt = Number(body?.expiresAt);
        if (!/^[0-9a-f]{64}$/.test(challenge) || !Number.isSafeInteger(expiresAt)) throw new Error("HaiNei Worker 返回了无效 challenge");
        return { challenge, expiresAt };
      },
      send: body => timedJsonFetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const body = await json(response, "获取 Relay 会话失败");
    const session: ManagedRelaySession = {
      token: String(body?.token || ""),
      pubkey: String(body?.pubkey || "").trim().toLowerCase(),
      relayUrl: normalizeRelayUrl(String(body?.relayUrl || "")),
      scope: body?.scope,
      expiresAt: Number(body?.expiresAt),
    };
    if (
      body?.bindingVersion !== 1
      || !session.token.startsWith("nrs_")
      || session.pubkey !== currentIdentity.pubkey
      || session.relayUrl !== normalizedUrl
      || session.scope !== "relay"
      || !usable(session)
    ) throw new Error("HaiNei Worker 返回了无效 Relay 会话");
    if (identity !== currentIdentity) throw new Error("relay_session_account_changed");
    sessionCache = session;
    persistSession(session);
    return session;
  })();

  sessionInflight = pending;
  let ok = false;
  try { const session = await pending; ok = true; return session; }
  finally {
    if (sessionInflight === pending) sessionInflight = null;
    startupMark("relay_token", { durationMs: Date.now() - tokenStarted, ok });
  }
}

function relayInfoUrl(url: string) {
  return url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

/**
 * The managed relay URL when it advertises the `received_since` filter
 * extension in NIP-11, else "". Cached for a day (per device) so a cold
 * start does not wait on the info document.
 */
export async function managedReceivedSinceRelay(): Promise<string> {
  const url = managedRelayUrlFromCache();
  if (!url) return "";
  const now = Date.now();
  if (receivedSinceProbe?.url !== url) {
    try {
      const stored = JSON.parse(deviceStorage.getItem(RECEIVED_SINCE_STORAGE_KEY) || "null");
      if (stored?.url === url && typeof stored.supported === "boolean" && Number.isFinite(stored.checkedAt)) {
        receivedSinceProbe = { url, supported: stored.supported, checkedAt: stored.checkedAt, ttl: RECEIVED_SINCE_CACHE_MS };
      }
    } catch { /* unreadable cache: probe again */ }
  }
  if (receivedSinceProbe?.url === url && now - receivedSinceProbe.checkedAt < receivedSinceProbe.ttl) {
    return receivedSinceProbe.supported ? url : "";
  }
  receivedSinceInflight ??= (async () => {
    try {
      const response = await timedJsonFetch(relayInfoUrl(url), { headers: { Accept: "application/nostr+json" } }, 2_500);
      const supported = response.ok && (await response.json())?.received_since === true;
      receivedSinceProbe = { url, supported, checkedAt: Date.now(), ttl: RECEIVED_SINCE_CACHE_MS };
      try { deviceStorage.setItem(RECEIVED_SINCE_STORAGE_KEY, JSON.stringify({ url, supported, checkedAt: receivedSinceProbe.checkedAt })); } catch { /* memory cache still applies */ }
      return supported;
    } catch {
      // Offline or slow: use the regular catch-up and ask again later.
      receivedSinceProbe = { url, supported: false, checkedAt: Date.now(), ttl: RECEIVED_SINCE_RETRY_MS };
      return false;
    } finally {
      receivedSinceInflight = null;
    }
  })();
  return await receivedSinceInflight ? url : "";
}
