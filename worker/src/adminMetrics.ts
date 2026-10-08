import { HttpError, type Env } from "./types";

// Only pre-existing, aggregate Worker records are read here. No ciphertext,
// user identifiers, device identifiers, endpoints, or message IDs leave D1.
const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;
const encoder = new TextEncoder();

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function authorizeMetricsRequest(request: Request, env: Env) {
  const expected = String(env.METRICS_READ_TOKEN || "").trim();
  // Fail closed unless an independently configured high-entropy secret exists.
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(expected)) {
    throw new HttpError(503, "metrics_not_configured");
  }
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header);
  const presented = match?.[1] || "";
  const [left, right] = await Promise.all([digest(expected), digest(presented)]);
  let mismatch = presented.length === expected.length ? 0 : 1;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  if (mismatch !== 0) throw new HttpError(401, "unauthorized");
}

type NumericRow = Record<string, number | string | null>;
function count(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export async function getRuntimeMetrics(env: Env, now = Date.now()) {
  const today = new Date(now);
  const startUtcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const firstDay = startUtcToday - 6 * DAY_MS;
  const start24h = now - DAY_MS;
  const start7d = now - 7 * DAY_MS;

  // Account snapshot writes indicate sync activity, NOT application DAU.
  // This table has milliseconds; push tables have epoch seconds.
  const [snapshots, subscriptions, pushCopies, daily] = await Promise.all([
    env.DB.prepare([
      "SELECT COUNT(DISTINCT account_pubkey) AS accounts_with_snapshots,",
      "COUNT(DISTINCT CASE WHEN updated_at >= ? THEN account_pubkey END) AS synced_accounts_24h,",
      "COUNT(DISTINCT CASE WHEN updated_at >= ? THEN account_pubkey END) AS synced_accounts_7d",
      "FROM hainei_account_snapshots",
    ].join(" ")).bind(start24h, start7d).first<NumericRow>(),
    env.DB.prepare([
      "SELECT COUNT(*) AS registered_endpoints,",
      "COUNT(DISTINCT account_pubkey) AS accounts_with_push",
      "FROM hainei_push_subscriptions",
    ].join(" ")).first<NumericRow>(),
    env.DB.prepare([
      "SELECT COUNT(*) AS recorded_copies_7d,",
      "COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS accepted_by_push_provider_7d",
      "FROM hainei_push_deliveries WHERE updated_at >= ?",
    ].join(" ")).bind(Math.floor(now / 1000) - 7 * DAY_SECONDS).first<NumericRow>(),
    env.DB.prepare([
      "SELECT strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch') AS day,",
      "COUNT(DISTINCT account_pubkey) AS accounts",
      "FROM hainei_account_snapshots WHERE updated_at >= ?",
      "GROUP BY day ORDER BY day",
    ].join(" ")).bind(firstDay).all<{ day: string; accounts: number }>(),
  ]);
  const byDay = new Map(daily.results.map(row => [row.day, count(row.accounts)]));
  const syncedAccountsByDay = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10);
    return { date, accounts: byDay.get(date) ?? 0 };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    source: "hainei-media Cloudflare D1",
    timezone: "UTC",
    metrics: {
      accountsWithEncryptedSnapshots: count(snapshots?.accounts_with_snapshots),
      accountsWithRecentSnapshotChanges24h: count(snapshots?.synced_accounts_24h),
      accountsWithRecentSnapshotChanges7d: count(snapshots?.synced_accounts_7d),
      pushSubscribedAccounts: count(subscriptions?.accounts_with_push),
      pushRegisteredEndpoints: count(subscriptions?.registered_endpoints),
      pushCopiesRecorded7d: count(pushCopies?.recorded_copies_7d),
      pushCopiesAcceptedByProvider7d: count(pushCopies?.accepted_by_push_provider_7d),
    },
    syncedAccountsByDay,
    unavailable: {
      dailyActiveUsers: "Not measurable from snapshot writes.",
      relayConnectionSuccessRate: "Client-local diagnostics are not uploaded.",
      dmDeliverySuccessRate: "Encrypted DM delivery receipts are not aggregated server-side.",
      pageLoadLatency: "Client performance telemetry is not collected.",
    },
  };
}
