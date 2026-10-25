import { describe, expect, it } from "vitest";
import { callHistoryItem, uniqueCallHistory, CALL_RECORD_TAG } from "@/services/callHistory";
import type { SyncedMessageRecord } from "@/db/dexie";
const me = "a".repeat(64), peer = "b".repeat(64);
const record = (overrides: Partial<SyncedMessageRecord> = {}) => ({ accountPubkey: me, id: "id", senderPubkey: me, recipientPubkeys: [peer], createdAt: 100, plaintext: "📞 语音通话 · 3秒", tags: [["t", "hainei-call-log"]], ...overrides } as SyncedMessageRecord);
describe("call history", () => {
  it("keeps legacy self notes without inventing a call direction", () => {
    expect(callHistoryItem(record(), me)).toMatchObject({ peer, direction: "unknown", missed: false });
  });
  it("preserves incoming direction of self-authored completed calls", () => {
    expect(callHistoryItem(record({ tags: [["t", "hainei-call-log"], [CALL_RECORD_TAG, "c".repeat(32), "incoming", "hangup", "3"]] }), me)?.direction).toBe("incoming");
  });
  it("treats the caller's missed record as incoming only on the recipient", () => {
    const tags = [["t", "hainei-call-log"], ["t", "hainei-call-missed"], [CALL_RECORD_TAG, "c".repeat(32), "outgoing", "no_answer", "0"]];
    expect(callHistoryItem(record({ tags }), me)).toMatchObject({ direction: "outgoing", missed: false });
    expect(callHistoryItem(record({ accountPubkey: peer, tags }), peer)).toMatchObject({ direction: "incoming", missed: true });
  });
  it("does not expose records from a different account or unrelated recipients", () => {
    expect(callHistoryItem(record(), peer)).toBeNull();
    expect(callHistoryItem(record({ senderPubkey: peer, recipientPubkeys: ["d".repeat(64)] }), me)).toBeNull();
  });
  it("ignores ordinary messages, call signals and self peers", () => {
    expect(callHistoryItem(record({ tags: [["t", "hainei-call"]] }), me)).toBeNull();
    expect(callHistoryItem(record({ recipientPubkeys: [me] }), me)).toBeNull();
  });
  it("deduplicates structured call ids but retains distinct legacy records", () => {
    const tags = [["t", "hainei-call-log"], [CALL_RECORD_TAG, "c".repeat(32), "outgoing"]];
    const first = callHistoryItem(record({ tags }), me)!;
    const second = callHistoryItem(record({ id: "different-message", tags }), me)!;
    expect(uniqueCallHistory([first, second])).toEqual([first]);
    expect(uniqueCallHistory([callHistoryItem(record(), me)!, callHistoryItem(record({ id: "another" }), me)!])).toHaveLength(2);
  });
  it("does not trust malformed structured metadata", () => {
    expect(callHistoryItem(record({ tags: [["t", "hainei-call-log"], [CALL_RECORD_TAG, "bad", "incoming"]] }), me)).toMatchObject({ id: "id", direction: "unknown" });
  });
});
