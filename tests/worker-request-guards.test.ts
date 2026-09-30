import { describe, expect, it } from "vitest";
import { consumeRateLimit, readJsonBody } from "../worker/src/requestGuards";

class RateD1 {
  counts = new Map<string, number>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (normalized.startsWith("INSERT INTO hainei_rate_limits")) {
            const bucket = String(values[0]);
            const limit = Number(values[3]);
            const current = this.counts.get(bucket) || 0;
            if (current >= limit) return { meta: { changes: 0 } };
            this.counts.set(bucket, current + 1);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

describe("Worker request guards", () => {
  it("rejects the actual streamed request body when it exceeds the route byte limit", async () => {
    const body = JSON.stringify({ value: "x".repeat(4096) });
    const request = new Request("https://worker.test/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await expect(readJsonBody(request, 1024)).rejects.toMatchObject({
      status: 413,
      message: "request_too_large",
    });
  });

  it("rejects an oversized declared content length before reading the body", async () => {
    const request = new Request("https://worker.test/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body: "{}",
    });
    await expect(readJsonBody(request, 4096)).rejects.toMatchObject({
      status: 413,
      message: "request_too_large",
    });
  });

  it("enforces a shared atomic D1 bucket at the configured limit", async () => {
    const env = { DB: new RateD1() } as any;
    await consumeRateLimit(env, "test:source", 2, 60, 1_800_000_000);
    await consumeRateLimit(env, "test:source", 2, 60, 1_800_000_001);
    await expect(consumeRateLimit(env, "test:source", 2, 60, 1_800_000_002))
      .rejects.toMatchObject({ status: 429, message: "rate_limited" });
  });
});
