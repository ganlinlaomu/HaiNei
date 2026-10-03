import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { signWorkerRequest } from "@/services/workerAuth";
import { timedJsonFetch } from "@/utils/timedFetch";

const CONFIG_CACHE_MS = 5 * 60_000;
const EXPIRY_SKEW_SECONDS = 30;

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

export function registerRelaySessionSigner(pubkey: string, signEvent: RelaySigner) {
  const normalized = String(pubkey || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return false;
  if (identity?.pubkey !== normalized) {
    sessionCache = null;
    sessionInflight = null;
  }
  identity = { pubkey: normalized, signEvent };
  return true;
}

export function clearRelaySessionSigner(pubkey?: string) {
  if (pubkey && identity?.pubkey !== pubkey.toLowerCase()) return;
  identity = null;
  sessionCache = null;
  sessionInflight = null;
}

export function resetManagedRelaySessionForTests() {
  configCache = null;
  configInflight = null;
  identity = null;
  sessionCache = null;
  sessionInflight = null;
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
  const config = await getManagedRelayConfig();
  if (!config.enabled || config.relayUrl !== normalizedUrl) return null;
  if (!identity) throw new Error("relay_session_identity_unavailable");

  if (!force && usable(sessionCache) && sessionCache?.pubkey === identity.pubkey && sessionCache.relayUrl === normalizedUrl) {
    return sessionCache;
  }
  if (!force && sessionInflight) return sessionInflight;

  const currentIdentity = identity;
  const pending = (async () => {
    const base = workerBaseUrl();
    const challengeResponse = await timedJsonFetch(`${base}/api/auth/challenge`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const challengeBody = await json(challengeResponse, "获取 Relay 身份验证 challenge 失败");
    const challenge = String(challengeBody?.challenge || "").trim().toLowerCase();
    const challengeExpiresAt = Number(challengeBody?.expiresAt);
    if (!/^[0-9a-f]{64}$/.test(challenge) || !Number.isSafeInteger(challengeExpiresAt)) {
      throw new Error("HaiNei Worker 返回了无效 challenge");
    }

    const endpoint = `${base}/api/relay/session`;
    const payload = {};
    const event = await signWorkerRequest(currentIdentity.signEvent, currentIdentity.pubkey, {
      action: "hainei_relay_session",
      challenge,
      expiresAt: challengeExpiresAt,
      url: endpoint,
      method: "POST",
      payload,
      content: "Authorize HaiNei relay session",
    });
    if (identity !== currentIdentity) throw new Error("relay_session_account_changed");

    const response = await timedJsonFetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, event }),
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
    return session;
  })();

  sessionInflight = pending;
  try { return await pending; }
  finally { if (sessionInflight === pending) sessionInflight = null; }
}
