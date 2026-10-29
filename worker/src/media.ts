import { assertUserAndQuota } from "./quota";
import { HttpError, integerSetting, type Env } from "./types";

export const MAX_MEDIA_SESSION_BATCH = 4;

export async function createMediaSession(env: Env, pubkey: string, requestedBytes?: unknown, contentHash?: unknown) {
  await assertUserAndQuota(env, pubkey, requestedBytes);
  if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) throw new HttpError(400,"invalid_content_hash");
  return issueUploadToken(env, pubkey, requestedBytes, contentHash);
}

/** One signed request for several uploads, e.g. a post's original and preview. */
export async function createMediaSessions(env: Env, pubkey: string, items: unknown) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MEDIA_SESSION_BATCH) {
    throw new HttpError(400, "invalid_media_session_items");
  }
  const parsed = items.map(item => {
    const fileSize = Number(item?.fileSize);
    const contentHash = item?.contentHash;
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new HttpError(400, "invalid_file_size");
    if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) throw new HttpError(400, "invalid_content_hash");
    return { fileSize, contentHash };
  });
  await assertUserAndQuota(env, pubkey, Math.max(...parsed.map(item => item.fileSize)), undefined, {
    count: parsed.length,
    totalBytes: parsed.reduce((sum, item) => sum + item.fileSize, 0),
  });
  const sessions = await Promise.all(parsed.map(item => issueUploadToken(env, pubkey, item.fileSize, item.contentHash)));
  return { sessions };
}

async function issueUploadToken(env: Env, pubkey: string, requestedBytes: unknown, contentHash: string) {
  if (!env.BLOSSOM_SERVICE_TOKEN) throw new HttpError(503, "service_token_not_configured");
  if (!env.BLOSSOM || typeof env.BLOSSOM.fetch !== "function") throw new HttpError(503, "blossom_service_not_configured");

  const ttl = integerSetting(env.UPLOAD_TOKEN_TTL_SECONDS, 3600, 60, 86400);
  const request = new Request("https://blossom.internal/api/service/upload-token", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${env.BLOSSOM_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ subject: pubkey, ttl, contentHash, maxBytes: requestedBytes }),
  });
  const response = await env.BLOSSOM.fetch(request);
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, body?.error || "blossom_token_issuer_failed");
  if (body?.bindingVersion !== 1 || body?.singleUse !== true || body?.contentHash !== contentHash || body?.maxBytes !== requestedBytes) throw new HttpError(502,"blossom_binding_upgrade_required");
  if (!body?.token || body.subject !== pubkey || body.scope !== "upload" || !Number.isSafeInteger(body.expiresAt)) {
    throw new HttpError(502, "invalid_blossom_token_response");
  }
  return { token: body.token, pubkey, scope: "upload", expiresAt: body.expiresAt };
}

