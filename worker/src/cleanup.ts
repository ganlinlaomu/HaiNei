import type { Env } from "./types";

export type CleanupReport = {
  ranAt: number;
  challenges: number;
  rateLimits: number;
  devicePairs: number;
  pushDeliveries: number;
  failed: string[];
};

/** Used challenges stay one hour so replay attempts still read "already used". */
const USED_CHALLENGE_RETENTION_SECONDS = 60 * 60;
/** Expired pairing sessions linger briefly so a late poll reads "expired". */
const DEVICE_PAIR_GRACE_SECONDS = 5 * 60;
const PUSH_DELIVERY_RETENTION_SECONDS = 7 * 24 * 60 * 60;

type CleanupTask = { key: Exclude<keyof CleanupReport, "ranAt" | "failed">; sql: string; binds: unknown[] };

/**
 * Daily housekeeping for short-lived Worker rows. Request handlers used to
 * fire these deletes without waitUntil, so the runtime could drop them once
 * the response was sent. The scheduled handler awaits each one instead.
 */
export async function cleanupExpiredRecords(env: Env, now = Math.floor(Date.now() / 1000)): Promise<CleanupReport> {
  const tasks: CleanupTask[] = [
    {
      key: "challenges",
      sql: "DELETE FROM hainei_auth_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
      binds: [now, now - USED_CHALLENGE_RETENTION_SECONDS],
    },
    { key: "rateLimits", sql: "DELETE FROM hainei_rate_limits WHERE expires_at <= ?", binds: [now] },
    { key: "devicePairs", sql: "DELETE FROM hainei_device_pairs WHERE expires_at < ?", binds: [now - DEVICE_PAIR_GRACE_SECONDS] },
    { key: "pushDeliveries", sql: "DELETE FROM hainei_push_deliveries WHERE updated_at <= ?", binds: [now - PUSH_DELIVERY_RETENTION_SECONDS] },
  ];
  const report: CleanupReport = { ranAt: now, challenges: 0, rateLimits: 0, devicePairs: 0, pushDeliveries: 0, failed: [] };
  for (const task of tasks) {
    try {
      const result = await env.DB.prepare(task.sql).bind(...task.binds).run();
      report[task.key] = Number(result.meta?.changes || 0);
    } catch (error) {
      // One missing table must not stop the remaining cleanup.
      report.failed.push(task.key);
      console.error("HaiNei cleanup step failed", { step: task.key, error: error instanceof Error ? error.message : "unknown" });
    }
  }
  console.log("HaiNei cleanup", JSON.stringify(report));
  if (report.failed.length) throw new Error(`cleanup_failed:${report.failed.join(",")}`);
  return report;
}
