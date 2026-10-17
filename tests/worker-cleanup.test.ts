import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredRecords } from "../worker/src/cleanup";
import worker, { handleScheduled } from "../worker/src/index";
import { consumeRateLimit } from "../worker/src/requestGuards";
import { createChallenge } from "../worker/src/auth";

type Call = { sql: string; binds: unknown[] };

class CleanupD1 {
  calls: Call[] = [];
  constructor(private readonly changes: Record<string, number | Error> = {}) {}
  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...binds: unknown[]) => ({
        run: async () => {
          this.calls.push({ sql: normalized, binds });
          const table = /^DELETE FROM (\w+)/.exec(normalized)?.[1] || "";
          const outcome = this.changes[table];
          if (outcome instanceof Error) throw outcome;
          return { meta: { changes: normalized.startsWith("DELETE") ? outcome ?? 0 : 1 } };
        },
      }),
    };
  }
}

afterEach(() => vi.restoreAllMocks());

describe("Worker scheduled cleanup", () => {
  it("deletes expired rows from every short-lived table and reports the counts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const db = new CleanupD1({
      hainei_auth_challenges: 12,
      hainei_rate_limits: 340,
      hainei_device_pairs: 2,
      hainei_push_deliveries: 7,
    });
    const now = 1_900_000_000;
    const report = await cleanupExpiredRecords({ DB: db } as any, now);

    expect(report).toEqual({ ranAt: now, challenges: 12, rateLimits: 340, devicePairs: 2, pushDeliveries: 7, failed: [] });
    expect(db.calls).toEqual([
      { sql: "DELETE FROM hainei_auth_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)", binds: [now, now - 3600] },
      { sql: "DELETE FROM hainei_rate_limits WHERE expires_at <= ?", binds: [now] },
      { sql: "DELETE FROM hainei_device_pairs WHERE expires_at < ?", binds: [now - 300] },
      { sql: "DELETE FROM hainei_push_deliveries WHERE updated_at <= ?", binds: [now - 7 * 24 * 3600] },
    ]);
    expect(console.log).toHaveBeenCalledWith("HaiNei cleanup", JSON.stringify(report));
  });

  it("keeps cleaning the other tables when one step fails, then reports failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new CleanupD1({ hainei_rate_limits: new Error("no such table"), hainei_auth_challenges: 3 });
    await expect(cleanupExpiredRecords({ DB: db } as any, 1_900_000_000)).rejects.toThrow("cleanup_failed:rateLimits");
    expect(db.calls).toHaveLength(4);
  });

  it("runs from the cron trigger inside waitUntil so the runtime keeps it alive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const db = new CleanupD1();
    const waitUntil = vi.fn();
    handleScheduled({ scheduledTime: 1_900_000_000_000, cron: "17 3 * * *" }, { DB: db } as any, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(db.calls[0].binds[0]).toBe(1_900_000_000);
    expect(worker.scheduled).toBe(handleScheduled);

    const config = readFileSync("worker/wrangler.toml", "utf8");
    expect(config).toMatch(/\[triggers\]\s*\ncrons = \["17 3 \* \* \*"\]/);
  });

  it("no longer fires unawaited deletes from request handlers", async () => {
    const db = new CleanupD1();
    await consumeRateLimit({ DB: db } as any, "test:source", 10, 60, 1_800_000_000 - (1_800_000_000 % 32));
    await createChallenge({ DB: db } as any, 1_800_000_000);
    expect(db.calls.some(call => call.sql.startsWith("DELETE"))).toBe(false);
    for (const file of ["auth.ts", "requestGuards.ts", "devicePair.ts", "push.ts"]) {
      expect(readFileSync(`worker/src/${file}`, "utf8"), file).not.toMatch(/void env\.DB\.prepare\("?`?\s*DELETE/);
    }
  });
});
