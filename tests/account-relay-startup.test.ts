import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("account relay startup ordering", () => {
  it("loads the selected account settings before warming read relays", () => {
    const source = readFileSync(join(process.cwd(), "src/stores/keys.ts"), "utf8");
    const settingsLoad = source.indexOf("await useSettingsStore().load(pk)");
    const warmup = source.indexOf("warmReadRelaysForSession(this)");
    expect(settingsLoad).toBeGreaterThan(-1);
    expect(warmup).toBeGreaterThan(settingsLoad);
  });

  it("actively restores selected relays and repairs catch-up on first connection", () => {
    const source = readFileSync(join(process.cwd(), "src/nostr/messaging/sync/MessageSyncManager.ts"), "utf8");
    expect(source).toContain("this.resumeRelays(options.relays)");
    expect(source).toContain("if (event.connected)");
    expect(source).toContain('event.reconnected ? "reconnect" : "resume"');
  });
});
