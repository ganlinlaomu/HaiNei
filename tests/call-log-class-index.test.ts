import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { db, HaiNeiDatabase, type SyncedMessageRecord } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { messageClassOf } from "@/nostr/messaging/messageRouting";
import { CALL_LOG_CLASS_MIGRATION_KEY, SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { readVisibleCallHistoryPage } from "@/services/callHistory";

const account = "1".repeat(64);
const peer = "2".repeat(64);
const callTags = (n: number) => [["t", "hainei-dm"], ["t", "hainei-call-log"], ["hainei-call-record", n.toString(16).padStart(32, "0"), "outgoing", "hangup", "5"]];
const record = (n: number, call: boolean, messageClass: SyncedMessageRecord["messageClass"] = call ? "other" : "direct"): SyncedMessageRecord => ({
  accountPubkey: account, id: `msg-${String(n).padStart(5, "0")}`, senderPubkey: account, recipientPubkeys: [peer],
  conversationId: peer, messageClass, plaintext: call ? "📞 语音通话 · 5秒" : "你好", createdAt: 1_800_000_000 + n,
  protocol: "nip17", transportKind: 1059, transportEventIds: [],
  tags: call ? callTags(n) : [["t", "hainei-dm"]], firstSeenAt: 0, lastSeenAt: 0,
});
const migrated = async () => (await db.accountMeta.get([account, CALL_LOG_CLASS_MIGRATION_KEY]))?.value === true;

afterEach(async () => {
  await db.syncedMessages.where("accountPubkey").equals(account).delete();
  await db.accountMeta.where("accountPubkey").equals(account).delete();
});

describe("call log class index", () => {
  it("classifies call logs apart from chat rows and other control records", () => {
    expect(messageClassOf({ tags: callTags(1), createdAt: 1_800_000_000 })).toBe("call");
    expect(messageClassOf({ tags: [["t", "hainei-dm"]], createdAt: 1_800_000_000 })).toBe("direct");
    expect(messageClassOf({ tags: [["t", "hainei-post"]], createdAt: 1_800_000_000 })).toBe("other");
  });

  it("reclassifies stored call logs in batches, then reads them by index", async () => {
    // 60 chat rows with a call every 5th spans several 7-row batches.
    await db.syncedMessages.bulkPut(Array.from({ length: 60 }, (_, n) => record(n, n % 5 === 0)));
    const before = await readVisibleCallHistoryPage(account, 50, false);
    expect(before.items).toHaveLength(12);

    await new SyncedMessageRepository(db).migrateCallLogClassAfterUnlock(account, () => true, 7);
    expect(await migrated()).toBe(true);
    expect(await db.syncedMessages.where("[accountPubkey+messageClass+createdAt+id]")
      .between([account, "call", 0, ""], [account, "call", Number.MAX_SAFE_INTEGER, "￿"]).count()).toBe(12);
    expect((await db.syncedMessages.get([account, "msg-00001"]))?.messageClass).toBe("direct");

    const after = await readVisibleCallHistoryPage(account, 50, false);
    expect(after).toEqual(before);
    // Proves the indexed path is used: an unclassified call log is no longer scanned.
    await db.syncedMessages.update([account, "msg-00055"], { messageClass: "other" });
    expect((await readVisibleCallHistoryPage(account, 50, false)).items).toHaveLength(11);
  });

  it("does not mark the migration done when the session changes mid-way", async () => {
    await db.syncedMessages.bulkPut(Array.from({ length: 20 }, (_, n) => record(n, n === 19)));
    let checks = 0;
    await new SyncedMessageRepository(db).migrateCallLogClassAfterUnlock(account, () => ++checks < 2, 7);
    expect(await migrated()).toBe(false);
    // Still found through the full-scan fallback.
    expect((await readVisibleCallHistoryPage(account, 50, false)).items).toHaveLength(1);
  });

  it("writes new call logs with the call class", async () => {
    const repository = new SyncedMessageRepository(db);
    await repository.insertMessageIfAbsent(account, {
      id: "new-call", senderPubkey: account, recipientPubkeys: [peer], conversationId: peer,
      plaintext: "📞 语音通话 · 5秒", createdAt: 1_800_000_500, protocol: "nip17", transportKind: 1059,
      transportEventId: "wrap-new-call", tags: callTags(7),
    });
    expect((await db.syncedMessages.get([account, "new-call"]))?.messageClass).toBe("call");
  });

  it("reclassifies through the unlocked vault without unsealing stored tags", async () => {
    const database = new HaiNeiDatabase("call-log-class-vault");
    try {
      await unlockLocalVault(account, "3".repeat(64));
      const repository = new SyncedMessageRepository(database);
      await repository.insertMessageIfAbsent(account, {
        id: "sealed-call", senderPubkey: account, recipientPubkeys: [peer], conversationId: peer,
        plaintext: "📞 语音通话 · 5秒", createdAt: 1_800_000_600, protocol: "nip17", transportKind: 1059,
        transportEventId: "wrap-sealed-call", tags: callTags(9),
      });
      await database.syncedMessages.update([account, "sealed-call"], { messageClass: "other" });
      await repository.migrateCallLogClassAfterUnlock(account);
      const stored = await database.syncedMessages.get([account, "sealed-call"]);
      expect(stored?.messageClass).toBe("call");
      expect(stored?.tags).toEqual(callTags(9));
      lockLocalVault(account);
      await expect(database.syncedMessages.get([account, "sealed-call"])).rejects.toThrow("local_vault_locked");
    } finally {
      lockLocalVault(account);
      await database.delete();
    }
  });
});
