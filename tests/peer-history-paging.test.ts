import "fake-indexeddb/auto";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/dexie";
import { deriveConversationId } from "@/nostr/messaging/protocol/common";
import { friendshipRepository } from "@/repositories/friendshipRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { conversationPageSize, MAX_CONVERSATION_PAGE_SIZE } from "@/repositories/conversationPage";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useKeyStore } from "@/stores/keys";

const ME = "a".repeat(64);
const PEER = "c".repeat(64);
const TOTAL = 350;

describe("reading a long chat's history page by page (real IndexedDB)", () => {
  beforeEach(async () => {
    await Promise.all([db.syncedMessages.clear(), db.accountFriendships.clear()]);
    setActivePinia(createPinia());
    useKeyStore().pkHex = ME;
    useDirectMessagesStore().loadedFor = ME;
    await friendshipRepository.put({ accountPubkey: ME, peerPubkey: PEER, state: "accepted", acceptedAt: 1, updatedAt: 1 });
    const conversationId = await deriveConversationId([ME, PEER]);
    for (let i = 0; i < TOTAL; i++) {
      const fromPeer = i % 3 !== 0;
      const id = i.toString(16).padStart(64, "0");
      await syncedMessageRepository.insertMessageIfAbsent(ME, {
        id, senderPubkey: fromPeer ? PEER : ME, recipientPubkeys: [fromPeer ? ME : PEER], conversationId,
        plaintext: `m${i}`, createdAt: 1_000 + i, protocol: "nip17", transportKind: 1059,
        transportEventId: `wrap-${id}`, tags: [["t", "hainei-dm"]],
      });
    }
  });

  it("keeps reading older pages until the very first message", async () => {
    const direct = useDirectMessagesStore();
    let page = await direct.prefetchPeerHistory(PEER);
    const seen = [...page.items];
    for (let guard = 0; !page.exhausted && guard < 20; guard++) {
      page = await direct.loadPeerHistoryPage(PEER, page.cursor);
      seen.push(...page.items);
    }
    // 0.1.228 asked the repository for 150 rows, got its cap of 100, read
    // that as "no older rows" and stopped after one older page.
    expect(page.exhausted).toBe(true);
    expect(seen).toHaveLength(TOTAL);
    expect(seen.filter(item => item.pubkey === PEER)).toHaveLength(TOTAL - Math.ceil(TOTAL / 3));
  });

  it("clamps page sizes the same way the repository does", () => {
    expect(conversationPageSize(150)).toBe(MAX_CONVERSATION_PAGE_SIZE);
    expect(conversationPageSize(50)).toBe(50);
    expect(conversationPageSize(0)).toBe(1);
  });
});
