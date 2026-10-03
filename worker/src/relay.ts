import { HttpError, type Env } from "./types";

const PUBKEY = /^[0-9a-f]{64}$/;

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function normalizeManagedRelayUrl(value: string | undefined) {
  const input = String(value || "").trim();
  if (!input) return "";
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `wss://${input}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return "";
    if (url.protocol === "ws:" && !isLoopback(url.hostname)) return "";
    if (url.username || url.password) return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function relayPublicConfig(env: Env) {
  const relayUrl = normalizeManagedRelayUrl(env.RELAY_APP_URL);
  if (!env.RELAY_APP_URL) return { enabled: false, relayUrl: "" };
  if (!relayUrl) throw new HttpError(503, "relay_url_invalid");
  return { enabled: true, relayUrl };
}

function relaySessionEndpoint(relayUrl: string) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/app/session";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function createRelaySession(env: Env, pubkey: string) {
  const normalizedPubkey = String(pubkey || "").trim().toLowerCase();
  if (!PUBKEY.test(normalizedPubkey)) throw new HttpError(400, "invalid_pubkey");
  const config = relayPublicConfig(env);
  if (!config.enabled) throw new HttpError(503, "relay_not_configured");
  if (!env.RELAY_APP_TOKEN) throw new HttpError(503, "relay_app_token_not_configured");

  const response = await fetch(relaySessionEndpoint(config.relayUrl), {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${env.RELAY_APP_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ subject: normalizedPubkey, ttl: 600 }),
  });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new HttpError(status, body?.error || "relay_session_issuer_failed");
  }

  const expiresAt = Number(body?.expiresAt);
  if (
    body?.bindingVersion !== 1
    || body?.scope !== "relay"
    || body?.subject !== normalizedPubkey
    || typeof body?.token !== "string"
    || !body.token.startsWith("nrs_")
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Math.floor(Date.now() / 1000) + 30
  ) {
    throw new HttpError(502, "invalid_relay_session_response");
  }

  return {
    bindingVersion: 1,
    relayUrl: config.relayUrl,
    token: body.token,
    pubkey: normalizedPubkey,
    scope: "relay" as const,
    expiresAt,
  };
}
