import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const source = (path: string) => readFileSync(path, "utf8");
describe("missed calls survive PWA cold start and slow relay logs", () => {
  it("retains recent offline missed calls on first initialization", () => {
    const store = source("src/stores/callHistory.ts");
    expect(store).toContain("FIRST_RUN_HISTORY_SECONDS");
    expect(store).not.toContain(': Math.floor(Date.now() / 1000);');
    expect(store).toContain("metaRepository.listPrefix(account, LOCAL_MISSED_PREFIX)");
  });
  it("persists authorized caller cancellation independently from relay outcome logs", () => {
    const sync = source("src/services/accountMessageSync.ts");
    expect(sync).toContain('sender !== account && signal.action === "cancel"');
    expect(sync).toContain("recordIncomingMissed(account, sender, signal.callId");
    expect(sync).toContain("recordIncomingMissed(account, sender, id");
    const calls = source("src/views/Calls.vue");
    expect(calls).toContain("...callHistory.localMissed");
    expect(calls).not.toContain("watch(() => callHistory.missedUnreadCount, count =>");
  });
});
