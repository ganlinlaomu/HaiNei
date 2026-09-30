import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { unlockLocalVault, lockLocalVault } from "@/services/localVault";
import { metaRepository } from "@/repositories/metaRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useDirectMessagesStore } from "@/stores/directMessages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const CONVERSATION = "dm-persisted-history";
vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64), supportsNip44: true }) }));
vi.mock("@/services/accountStateSync", () => ({ scheduleAccountStateSync: vi.fn() }));

function item(index: number, sender = PEER): InboxItem {
  return { id: index.toString(16).padStart(64, "0"), pubkey: sender, recipientPubkeys: [ACCOUNT, PEER],
    conversationId: CONVERSATION, created_at: index, content: `message ${index}`,
    protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]] };
}
async function save(message: InboxItem) {
  await syncedMessageRepository.insertMessageIfAbsent(ACCOUNT, {
    id: message.id, senderPubkey: message.pubkey, recipientPubkeys: message.recipientPubkeys!,
    conversationId: CONVERSATION, createdAt: message.created_at, plaintext: message.content,
    protocol: "nip17", transportKind: 1059, transportEventId: `wrap-${message.id}`, tags: message.tags!,
  });
}
async function restore() {
  setActivePinia(createPinia());
  const friendships = useFriendshipsStore();
  friendships.loadedFor = ACCOUNT;
  friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", acceptedAt: 1, updatedAt: 1 }];
  await useMessagesStore().load(ACCOUNT);
  const direct = useDirectMessagesStore();
  vi.spyOn(direct, "scheduleReceipt").mockImplementation(() => {});
  await direct.refresh(ACCOUNT);
  await direct.reconcileDurableUnread();
  return direct;
}
beforeEach(async () => {
  await unlockLocalVault(ACCOUNT, "1".repeat(64));
  await db.open();
  await Promise.all([db.syncedMessages.clear(), db.conversationStates.clear(), db.conversationReadStates.clear(),
    db.accountMeta.clear(), db.outgoingQueue.clear(), db.outgoingDmTasks.clear(), db.messageSyncStates.clear()]);
});
afterEach(() => { lockLocalVault(ACCOUNT); vi.restoreAllMocks(); });

describe("reading paged DM history with an encrypted database", () => {
  it("uses a paged incoming message newer than the cached incoming message", async () => {
    for (let i = 1; i <= 151; i++) await save(item(i));
    const direct = await restore();
    useMessagesStore().inbox = [item(10)];
    await direct.reconcileDurableUnread();
    expect(direct.unreadCount).toBe(151);
    await direct.markPeerRead(PEER, item(151));
    expect((await syncedMessageRepository.getReadState(ACCOUNT, CONVERSATION))?.lastReadCreatedAt).toBe(151);
    await direct.reconcileDurableUnread();
    expect(direct.unreadCount).toBe(0);
    expect(direct.scheduleReceipt).toHaveBeenCalledWith(PEER, "read", { createdAt: 151, messageId: item(151).id });
  });

  it("never replaces the durable unread total with the bounded in-memory subset", async () => {
    for (let i = 1; i <= 151; i++) await save(item(i));
    const direct = await restore();
    expect(direct.unreadCount).toBe(151);

    // Simulate the Home cache containing only one historical message while the
    // durable database still contains all 151 unread messages.
    useMessagesStore().inbox = [item(151)];
    await direct.applyCanonicalMessage(ACCOUNT, item(151));

    expect(direct.unreadCount).toBe(151);
  });

  it("does not persist a sent optimistic task as the conversation read cursor", async () => {
    for (let i = 1; i <= 151; i++) await save(item(i));
    let direct = await restore();
    expect(direct.unreadCount).toBe(151);

    const optimistic: InboxItem = {
      ...item(999, ACCOUNT),
      id: "local:sent-task",
      conversationId: `local:${PEER}`,
      outgoing: { localId: "sent-task", state: "sent", hasImage: false },
    };
    await direct.markPeerRead(PEER, optimistic);
    await direct.reconcileDurableUnread();

    expect((await syncedMessageRepository.getReadState(ACCOUNT, CONVERSATION))?.lastReadCreatedAt).toBe(151);
    expect(await syncedMessageRepository.getReadState(ACCOUNT, `local:${PEER}`)).toBeUndefined();
    expect(direct.unreadCount).toBe(0);

    db.close();
    lockLocalVault(ACCOUNT);
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    await db.open();
    direct = await restore();
    expect(direct.unreadCount).toBe(0);
  });

  it("persists the actual chat read position when incoming messages are absent from the home cache", async () => {
    for (let i = 1; i <= 151; i++) await save(item(i));
    // The last incoming messages are outside the global recent-message window.
    for (let i = 152; i <= 360; i++) await save(item(i, ACCOUNT));
    let direct = await restore();
    expect(useMessagesStore().inbox.some(message => message.pubkey === PEER)).toBe(false);
    expect(direct.unreadCount).toBe(151);
    await direct.markPeerRead(PEER, item(360, ACCOUNT));
    await direct.reconcileDurableUnread();
    expect(direct.unreadCount).toBe(0);
    const advance = vi.spyOn(syncedMessageRepository, "advanceReadState");
    const mirror = vi.spyOn(metaRepository, "put");
    for (let i = 0; i < 20; i++) await direct.markPeerRead(PEER, item(360, ACCOUNT));
    expect(advance).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
    expect((await syncedMessageRepository.getReadState(ACCOUNT, CONVERSATION))?.lastReadCreatedAt).toBe(360);
    db.close();
    lockLocalVault(ACCOUNT);
    await unlockLocalVault(ACCOUNT, "1".repeat(64));
    await db.open();
    direct = await restore();
    expect(direct.unreadCount).toBe(0);
    await save(item(361));
    await direct.reconcileDurableUnread();
    expect(direct.unreadCount).toBe(1);
  });
});
