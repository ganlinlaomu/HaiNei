import { HttpError, type Env } from "./types";
import { consumeRateLimit } from "./requestGuards";

// Short-lived Cloudflare TURN credentials for WebRTC (file transfer, calls).
// ICE still prefers a direct path; TURN only relays when peers cannot reach
// each other. Media stays DTLS-SRTP/SCTP-encrypted end to end through it.
const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TURN_TTL_SECONDS = 12 * 60 * 60;
const TURN_REQUESTS_PER_HOUR_PER_PUBKEY = 30;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

/** Browsers refuse or stall on port 53 (Cloudflare's docs advise dropping it). */
function withoutPort53(server: IceServer): IceServer | null {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => typeof url === "string" && !/:53(?:\?|$)/.test(url));
  return urls.length ? { ...server, urls } : null;
}

export function normalizeIceServers(body: any): IceServer[] {
  const raw = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers ? [body.iceServers] : [];
  return raw
    .filter((server: any) => server && (typeof server.urls === "string" || Array.isArray(server.urls)))
    .map((server: any) => withoutPort53({
      urls: server.urls,
      ...(typeof server.username === "string" ? { username: server.username } : {}),
      ...(typeof server.credential === "string" ? { credential: server.credential } : {}),
    }))
    .filter((server: IceServer | null): server is IceServer => !!server);
}

export async function createTurnCredentials(env: Env, pubkey: string, now = Math.floor(Date.now() / 1000)) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) throw new HttpError(503, "turn_not_configured");
  await consumeRateLimit(env, `turn:${pubkey}`, TURN_REQUESTS_PER_HOUR_PER_PUBKEY, 3600, now);
  const response = await fetch(`${TURN_API}/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
  });
  if (!response.ok) throw new HttpError(502, "turn_issuer_failed");
  const iceServers = normalizeIceServers(await response.json().catch(() => null));
  if (!iceServers.some(server => server.username && server.credential)) throw new HttpError(502, "turn_issuer_failed");
  return { iceServers, expiresAt: now + TURN_TTL_SECONDS };
}
