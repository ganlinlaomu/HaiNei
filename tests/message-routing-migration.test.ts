import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { LEGACY_FEED_CUTOFF_SECONDS } from "@/nostr/messaging/messageRouting";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
let database: HaiNeiDatabase | undefined;
let sequence = 0;

afterEach(async () => {
  lockLocalVault(ACCOUNT);
  if (database) {
    await database.delete();
    database = undefined;
  }
});

describe("NIP-17 durable routing migration", () => {
  it("reindexes only the unlocked account, clears stale unread counts and keeps sealed tags", async () => {
    database = new HaiNeiDatabase(`nip17-routing-migration-${++sequence}`);
    const repository = new SyncedMessageRepository(database);
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    const conversationId = "conversation-test";
    const fixtures = [
      { id: "1".repeat(64), createdAt: LEGACY_FEED_CUTOFF_SECONDS - 4, tags: [] as string[][], direct: false },
      { id: "2".repeat(64), createdAt: LEGACY_FEED_CUTOFF_SECONDS + 1, tags: [["p", ACCOUNT]], direct: true },
      { id: "3".repeat(64), createdAt: LEGACY_FEED_CUTOFF_SECONDS + 2, tags: [["t", "hainei-post"]], direct: false },
    ];
    for (const fixture of fixtures) {
      await repository.insertMessageIfAbsent(ACCOUNT, {
        id: fixture.id, senderPubkey: PEER, recipientPubkeys: [ACCOUNT],
        conversationId, plaintext: "sealed private text", createdAt: fixture.createdAt,
        protocol: "nip17", transportKind: 1059, transportEventId: `wrap-${fixture.id}`,
        tags: fixture.tags,
      });
      await database.syncedMessages.update([ACCOUNT, fixture.id], {
        messageClass: fixture.direct ? "other" : "direct",
      });
    }
    await database.conversationStates.update([ACCOUNT, conversationId], {
      unreadCache: { cursor: "old", count: 3, directCount: 3 },
    });

    await repository.migrateMessageRoutingAfterUnlock(ACCOUNT);

    for (const fixture of fixtures) {
      const stored = await database.syncedMessages.get([ACCOUNT, fixture.id]);
      expect(stored?.messageClass).toBe(fixture.direct ? "direct" : "other");
      expect(stored?.tags).toEqual(fixture.tags);
      expect(stored?.plaintext).toBe("sealed private text");
    }
    expect((await database.conversationStates.get([ACCOUNT, conversationId]))?.unreadCache).toBeUndefined();
    expect((await repository.listDirectConversationHeads(ACCOUNT, conversationId)).map(row => row.id)).toEqual(["2".repeat(64)]);
    const marker = await database.accountMeta.get([ACCOUNT, "migration:nip17-message-routing-v1"]);
    expect(marker?.value).toBe(true);
    await repository.migrateMessageRoutingAfterUnlock(ACCOUNT);
    expect((await database.accountMeta.get([ACCOUNT, "migration:nip17-message-routing-v1"]))?.value).toBe(true);

    lockLocalVault(ACCOUNT);
    await expect(database.syncedMessages.get([ACCOUNT, "2".repeat(64)])).rejects.toThrow("local_vault_locked");
  });
});
