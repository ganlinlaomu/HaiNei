import { assertUserAndQuota } from "./quota";
import { HttpError, integerSetting, type Env } from "./types";

export async function createMediaSession(env: Env, pubkey: string, requestedBytes?: unknown) {
  await assertUserAndQuota(env, pubkey, requestedBytes);
  if (!env.BLOSSOM_SERVICE_TOKEN) throw new HttpError(503, "service_token_not_configured");
  if (!env.BLOSSOM || typeof env.BLOSSOM.fetch !== "function") throw new HttpError(503, "blossom_service_not_configured");

  const ttl = integerSetting(env.UPLOAD_TOKEN_TTL_SECONDS, 3600, 60, 86400);
  const request = new Request("https://blossom.internal/api/service/upload-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BLOSSOM_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ subject: pubkey, ttl }),
  });
  const response = await env.BLOSSOM.fetch(request);
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, body?.error || "blossom_token_issuer_failed");
  if (!body?.token || body.subject !== pubkey || body.scope !== "upload" || !Number.isSafeInteger(body.expiresAt)) {
    throw new HttpError(502, "invalid_blossom_token_response");
  }
  return { token: body.token, pubkey, scope: "upload", expiresAt: body.expiresAt };
}

