import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db, type SyncedMessageRecord } from "@/db/dexie";
import { metaRepository } from "@/repositories/metaRepository";
import {
  CALL_HISTORY_DELETED_PREFIX, CALL_HISTORY_SYNC_PREFIX,
  readVisibleCallHistoryPage,
} from "@/services/callHistory";
import { useCallHistoryStore } from "@/stores/callHistory";

const account = "1".repeat(64);
const peer = "2".repeat(64);
const otherAccount = "3".repeat(64);
const callId = (n: number) => n.toString(16).padStart(32, "0");
const logicalId = (n: number) => `${peer}:${callId(n)}`;
const makeRecord = (n: number, options: { id?: string; account?: string } = {}): SyncedMessageRecord => ({
  accountPubkey: options.account || account,
  id: options.id || `msg-${n}`,
  senderPubkey: options.account || account,
  recipientPubkeys: [peer],
  conversationId: peer,
  plaintext: "📞 语音通话 · 5秒",
  createdAt: 20000 + n,
  protocol: "nip17",
  transportKind: 1059,
  transportEventIds: [],
  tags: [["t", "hainei-call-log"], ["hainei-call-record", callId(n), "outgoing", "hangup", "5"]],
  firstSeenAt: Date.now(),
  lastSeenAt: Date.now(),
});
const inserted = new Set<string>();
afterEach(async () => {
  useCallHistoryStore().reset();
  for (const scope of [account, otherAccount]) {
    await db.syncedMessages.where("accountPubkey").equals(scope).delete();
    await db.accountMeta.where("accountPubkey").equals(scope).delete();
  }
});

describe("durable call tombstones in paged history", () => {
  it("fills subsequent pages with visible calls without resurrecting deleted entries", async () => {
    setActivePinia(createPinia());
    await db.syncedMessages.bulkPut(Array.from({ length: 65 }, (_, i) => makeRecord(i)));
    const first = await readVisibleCallHistoryPage(account, 50, false);
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);

    await metaRepository.put(account, CALL_HISTORY_DELETED_PREFIX + logicalId(64), true);
    await metaRepository.put(account, CALL_HISTORY_DELETED_PREFIX + logicalId(43), true);
    const more = await readVisibleCallHistoryPage(account, 55, false);
    expect(more.items).toHaveLength(55);
    expect(more.hasMore).toBe(true);
    expect(more.items.some(item => item.id === logicalId(64) || item.id === logicalId(43))).toBe(false);
    expect(more.items.at(-1)?.id).toBe(logicalId(8));

    // Replayed Relay copies with new outer ids still have the same logical ID.
    await db.syncedMessages.put(makeRecord(64, { id: "new-wrap-same-call" }));
    const refreshed = await readVisibleCallHistoryPage(account, 65, false);
    expect(refreshed.items).toHaveLength(63);
    expect(refreshed.hasMore).toBe(false);
  });

  it("respects encrypted cross-device tombstones and isolates accounts", async () => {
    setActivePinia(createPinia());
    await db.syncedMessages.bulkPut([makeRecord(1), makeRecord(2), makeRecord(1, { account: otherAccount })]);
    await metaRepository.put(account, "feed_preferences_v2", {
      hidden: [{ id: CALL_HISTORY_SYNC_PREFIX + logicalId(1), updatedAt: Date.now(), deleted: false }],
      muted: [],
    });
    const page = await readVisibleCallHistoryPage(account, 20, false);
    expect(page.items.map(item => item.id)).toEqual([logicalId(2)]);
    const other = await readVisibleCallHistoryPage(otherAccount, 20, false);
    expect(other.items).toHaveLength(1);
  });

  it("keeps tombstones when the call-history Pinia store is recreated", async () => {
    setActivePinia(createPinia());
    await db.syncedMessages.bulkPut([makeRecord(1), makeRecord(2)]);
    const first = useCallHistoryStore();
    await first.load(account);
    await first.deleteRecord(account, logicalId(1));
    expect(first.isDeleted(logicalId(1))).toBe(true);
    first.reset();
    setActivePinia(createPinia());
    const reopened = useCallHistoryStore();
    await reopened.load(account);
    expect(reopened.isDeleted(logicalId(1))).toBe(true);
    expect((await readVisibleCallHistoryPage(account, 20, false)).items.map(x => x.id)).toEqual([logicalId(2)]);
  });
});
