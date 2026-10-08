import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../worker/src/index";
import { authorizeMetricsRequest, getRuntimeMetrics } from "../worker/src/adminMetrics";
import type { Env } from "../worker/src/types";

const TOKEN = "6df899b894d24a8fa5d0f27bb4b219c7a9c349b83c5174d6bb179049f701851f";
const URL = "https://worker.test/api/admin/metrics";

function fixture() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first() {
          calls.push({ sql, args });
          if (sql.includes("hainei_account_snapshots")) return {
            accounts_with_snapshots: 43, synced_accounts_24h: 7, synced_accounts_7d: 21,
          };
          if (sql.includes("hainei_push_subscriptions")) return {
            registered_endpoints: 18, accounts_with_push: 12,
          };
          if (sql.includes("hainei_push_deliveries")) return {
            recorded_copies_7d: 60, accepted_by_push_provider_7d: 52,
          };
          throw new Error("unexpected query");
        },
        async all() {
          calls.push({ sql, args });
          if (!sql.includes("hainei_account_snapshots")) throw new Error("unexpected query");
          return { results: [{ day: "2026-10-07", accounts: 5 }, { day: "2026-10-08", accounts: 7 }] };
        },
      };
    },
  };
  return {
    calls,
    env: { DB: db as unknown as Env["DB"], METRICS_READ_TOKEN: TOKEN } as Env,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("private aggregate runtime metrics", () => {
  it("rejects missing, invalid and unconfigured administrator authorization before touching D1", async () => {
    const { calls, env } = fixture();
    for (const authorization of [undefined, "Bearer wrong", "Bearer " + "x".repeat(64)]) {
      const response = await handleRequest(
        new Request(URL, { headers: authorization ? { Authorization: authorization } : {} }),
        env,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    const response = await handleRequest(new Request(URL, { headers: { Authorization: "Bearer " + TOKEN } }), {
      ...env, METRICS_READ_TOKEN: "",
    });
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("does not allow CORS or mutation methods for the admin route", async () => {
    const { env } = fixture();
    const preflight = await handleRequest(new Request(URL, { method: "OPTIONS" }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const post = await handleRequest(new Request(URL, { method: "POST", headers: { Authorization: "Bearer " + TOKEN } }), env);
    expect(post.status).toBe(405);
  });

  it("returns only aggregates with precise metric definitions and UTC trend", async () => {
    const { calls, env } = fixture();
    await expect(authorizeMetricsRequest(
      new Request(URL, { headers: { Authorization: "Bearer " + TOKEN } }), env,
    )).resolves.toBeUndefined();

    const response = await handleRequest(new Request(URL, { headers: { Authorization: "Bearer " + TOKEN } }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const result = await response.json();
    expect(result.metrics).toEqual({
      accountsWithEncryptedSnapshots: 43,
      accountsWithRecentSnapshotChanges24h: 7,
      accountsWithRecentSnapshotChanges7d: 21,
      pushSubscribedAccounts: 12,
      pushRegisteredEndpoints: 18,
      pushCopiesRecorded7d: 60,
      pushCopiesAcceptedByProvider7d: 52,
    });
    expect(result.syncedAccountsByDay).toHaveLength(7);
    expect(result.syncedAccountsByDay.at(-1)).toEqual({ date: "2026-10-08", accounts: 7 });
    expect(result.syncedAccountsByDay.at(-2)).toEqual({ date: "2026-10-07", accounts: 5 });
    expect(result.unavailable.dailyActiveUsers).toMatch(/Not measurable/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("account_pubkey");
    expect(calls).toHaveLength(4);
    expect(calls.every(call => /^SELECT\s/i.test(call.sql))).toBe(true);
  });

  it("exposes no actual counts when the store has no rows", async () => {
    const { env } = fixture();
    const empty = {
      ...env,
      DB: {
        prepare: (_sql: string) => ({
          bind() { return this; },
          async first() { return null; },
          async all() { return { results: [] }; },
        }),
      } as unknown as Env["DB"],
    };
    const result = await getRuntimeMetrics(empty, Date.UTC(2026, 9, 8));
    expect(Object.values(result.metrics).every(value => value === 0)).toBe(true);
    expect(result.syncedAccountsByDay.every(row => row.accounts === 0)).toBe(true);
  });
});
