// A pushed system banner stayed on top of the open app (closing it right
// away did not remove the iOS banner). The app now reports foreground and
// the worker skips that device's pushes while it is on screen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUSH_FOREGROUND_TTL_SECONDS, setPushForeground } from "../worker/src/push";

function db() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    calls,
    prepare(sql: string) {
      return { bind: (...binds: unknown[]) => ({ run: async () => { calls.push({ sql: sql.replace(/\s+/g, " ").trim(), binds }); return { meta: { changes: 1 } }; } }) };
    },
  };
}
const env = (database: any) => ({ DB: database, PUSH_ALLOWED_ORIGINS: "https://web.push.apple.com" }) as any;
const ACCOUNT = "a".repeat(64);
const ENDPOINT = "https://web.push.apple.com/device";

describe("push foreground presence", () => {
  it("marks a device foreground for a short time and clears it on leave", async () => {
    const database = db();
    expect(await setPushForeground(env(database), ACCOUNT, ENDPOINT, true, 1_000)).toEqual({ foregroundUntil: 1_000 + PUSH_FOREGROUND_TTL_SECONDS });
    expect(await setPushForeground(env(database), ACCOUNT, ENDPOINT, false, 1_000)).toEqual({ foregroundUntil: 0 });
    expect(database.calls.map(call => call.binds)).toEqual([[1_040, ACCOUNT, ENDPOINT], [0, ACCOUNT, ENDPOINT]]);
    expect(PUSH_FOREGROUND_TTL_SECONDS).toBeLessThanOrEqual(60);
  });

  it("skips foreground devices when delivering, via a migration-added column", () => {
    expect(readFileSync("worker/src/push.ts", "utf8")).toContain("AND s.foreground_until <= ?");
    expect(readFileSync("worker/migrations/0007_push_foreground.sql", "utf8")).toContain("ADD COLUMN foreground_until INTEGER NOT NULL DEFAULT 0");
    expect(readFileSync("worker/src/index.ts", "utf8")).toContain('if (path === "/api/push/presence") {');
  });

  it("reports foreground while visible (heartbeat) and leaving on hide", () => {
    const presence = readFileSync("src/services/pushPresence.ts", "utf8");
    expect(presence).toContain("const HEARTBEAT_MS = 25_000;");
    expect(presence).toContain("report(false);");
    expect(readFileSync("src/App.vue", "utf8")).toContain("pushPresence = installPushPresence(keys);");
  });
});
