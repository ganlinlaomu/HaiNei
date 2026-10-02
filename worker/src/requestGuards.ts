import { HttpError, integerSetting, type Env } from "./types";

const DEFAULT_BODY_LIMIT = 512 * 1024;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function requestSourceFingerprint(request: Request) {
  const source = (
    request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0]
    || "unknown"
  ).trim();
  return (await sha256(source)).slice(0, 24);
}

export async function consumeRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000),
) {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const normalizedWindow = Math.max(1, Math.floor(windowSeconds));
  const window = Math.floor(now / normalizedWindow);
  const bucket = `${key}:${window}`;
  const expiresAt = (window + 1) * normalizedWindow + normalizedWindow;
  const result = await env.DB.prepare(`
    INSERT INTO hainei_rate_limits (bucket, count, expires_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      count = hainei_rate_limits.count + 1,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE hainei_rate_limits.count < ?
  `).bind(bucket, expiresAt, now, normalizedLimit).run();
  if (Number(result.meta?.changes || 0) !== 1) throw new HttpError(429, "rate_limited");

  // Opportunistic cleanup is bounded by the indexed expires_at predicate.
  if ((now & 31) === 0) {
    void env.DB.prepare("DELETE FROM hainei_rate_limits WHERE expires_at <= ?").bind(now).run().catch(() => {});
  }
}

export async function enforceChallengeRateLimit(env: Env, request: Request, now = Math.floor(Date.now() / 1000)) {
  const source = await requestSourceFingerprint(request);
  const perSource = integerSetting(env.AUTH_CHALLENGE_PER_MINUTE_PER_SOURCE, 120, 5, 600);
  const global = integerSetting(env.AUTH_CHALLENGE_PER_MINUTE_GLOBAL, 2400, 30, 10000);
  await consumeRateLimit(env, `challenge:source:${source}`, perSource, 60, now);
  await consumeRateLimit(env, "challenge:global", global, 60, now);
}

export async function readJsonBody(
  request: Request,
  maxBytes = DEFAULT_BODY_LIMIT,
): Promise<Record<string, unknown>> {
  const limit = Math.max(1024, Math.floor(maxBytes));
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "request_too_large");

  if (!request.body) throw new HttpError(400, "invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("request_too_large").catch(() => {});
        throw new HttpError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
