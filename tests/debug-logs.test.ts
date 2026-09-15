import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebugLogsStore } from "@/stores/debugLogs";
import { debugLog, sanitizeDebugData } from "@/utils/debugLog";
import { logger } from "@/utils/logger";

describe("local debug logs", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps only the newest 1000 in-memory entries", () => {
    const store = useDebugLogsStore();
    for (let index = 0; index < 1005; index += 1) {
      store.add({ category: "system", event: `event-${index}`, level: "debug", ts: index });
    }
    expect(store.entries).toHaveLength(1000);
    expect(store.entries[0].event).toBe("event-5");
    store.clear();
    expect(store.entries).toEqual([]);
  });

  it("redacts secrets and truncates identifiers before storage and console", () => {
    debugLog("nip17", "decode_failed", {
      eventId: "e".repeat(64),
      accountPrefix: "a".repeat(64),
      privateKey: "not-a-recognized-label",
      skHex: "secret-sk",
      password: "secret-password",
      blossomToken: "secret-token",
      ciphertext: "secret-ciphertext",
      content: "secret-content"
    }, "debug");
    const entry = useDebugLogsStore().entries[0];
    expect(entry.data).toMatchObject({
      eventId: "e".repeat(12),
      accountPrefix: "a".repeat(12),
      privateKey: "[redacted]",
      skHex: "[redacted]",
      password: "[redacted]",
      blossomToken: "[redacted]",
      ciphertext: "[redacted]",
      content: "[redacted]"
    });
    expect(JSON.stringify(entry)).not.toContain("secret-");
    expect(logger.debug).toHaveBeenCalledWith("[nip17] decode_failed", entry.data);
  });

  it("sanitizes nested copy metadata and errors", () => {
    expect(sanitizeDebugData({
      copies: [{ target: "b".repeat(64), eventId: "c".repeat(64), conversationKey: "hidden" }],
      failure: new Error("message may contain a secret")
    })).toEqual({
      copies: [{ target: "b".repeat(12), eventId: "c".repeat(12), conversationKey: "[redacted]" }],
      failure: { name: "Error" }
    });
  });
});
