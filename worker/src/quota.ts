import { HttpError, integerSetting, type Env } from "./types";

export function quotaPolicy(env: Env) {
  return {
    maxFileSize: integerSetting(env.MAX_FILE_SIZE_BYTES, 25 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    dailyUploadCount: integerSetting(env.DAILY_UPLOAD_COUNT, 100, 1, 100000),
    dailyUploadBytes: integerSetting(env.DAILY_UPLOAD_BYTES, 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
  };
}

export async function assertUserAndQuota(env: Env, pubkey: string, requestedBytes?: unknown, now = Math.floor(Date.now() / 1000)) {
  const user = await env.DB.prepare(
    "SELECT revoked_at FROM hainei_users WHERE pubkey = ?"
  ).bind(pubkey).first<{ revoked_at: number | null }>();
  if (user?.revoked_at !== null && user?.revoked_at !== undefined) throw new HttpError(403, "user_revoked");

  await env.DB.prepare(`
    INSERT INTO hainei_users (pubkey, created_at, last_seen_at, revoked_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(pubkey) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).bind(pubkey, now, now).run();

  const policy = quotaPolicy(env);
  const size = requestedBytes === undefined ? 0 : Number(requestedBytes);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "invalid_file_size");
  if (size > policy.maxFileSize) throw new HttpError(413, "file_too_large");

  const usageDate = new Date(now * 1000).toISOString().slice(0, 10);
  const usage = await env.DB.prepare(`
    SELECT upload_count, upload_bytes FROM hainei_media_usage
    WHERE pubkey = ? AND usage_date = ?
  `).bind(pubkey, usageDate).first<{ upload_count: number; upload_bytes: number }>();
  if (Number(usage?.upload_count || 0) >= policy.dailyUploadCount) throw new HttpError(429, "daily_upload_count_exceeded");
  if (Number(usage?.upload_bytes || 0) + size > policy.dailyUploadBytes) throw new HttpError(429, "daily_upload_bytes_exceeded");
  return policy;
}

