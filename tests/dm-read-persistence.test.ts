import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { unlockLocalVault, lockLocalVault } from "@/services/localVault";
import { metaRepository } from "@/repositories/metaRepository";
import {
  syncedMessageRepository,
  legacyDmReadStateMigrationMetaKey,
} from "@/repositories/syncedMessageRepository";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

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

describe("legacy DM read-state migration", () => {
  it("moves the newer legacy dm-read cursor into conversationReadStates and deletes the mirror", async () => {
    await metaRepository.put(ACCOUNT, `dm-read:${CONVERSATION}`, {
      lastReadCreatedAt: 120,
      lastReadMessageId: item(120).id,
    });
    await syncedMessageRepository.advanceReadState(ACCOUNT, CONVERSATION, {
      lastReadCreatedAt: 100,
      lastReadMessageId: item(100).id,
    });

    const result = await syncedMessageRepository.migrateLegacyDmReadState(ACCOUNT, 1, 1_234);

    expect(result).toEqual({ ran: true, migrated: 1, removed: 1, version: 1 });
    expect(await syncedMessageRepository.getReadState(ACCOUNT, CONVERSATION)).toMatchObject({
      lastReadCreatedAt: 120,
      lastReadMessageId: item(120).id,
    });
    expect(await metaRepository.get(ACCOUNT, `dm-read:${CONVERSATION}`)).toBeUndefined();
    expect(await metaRepository.get(ACCOUNT, legacyDmReadStateMigrationMetaKey())).toMatchObject({
      value: { version: 1, completedAt: 1_234, migrated: 1, removed: 1 },
    });
  });

  it("never rewinds a newer durable cursor while removing the legacy mirror", async () => {
    await syncedMessageRepository.advanceReadState(ACCOUNT, CONVERSATION, {
      lastReadCreatedAt: 150,
      lastReadMessageId: item(150).id,
    });
    await metaRepository.put(ACCOUNT, `dm-read:${CONVERSATION}`, {
      lastReadCreatedAt: 120,
      lastReadMessageId: item(120).id,
    });

    const result = await syncedMessageRepository.migrateLegacyDmReadState(ACCOUNT, 1, 2_345);

    expect(result).toEqual({ ran: true, migrated: 0, removed: 1, version: 1 });
    expect(await syncedMessageRepository.getReadState(ACCOUNT, CONVERSATION)).toMatchObject({
      lastReadCreatedAt: 150,
      lastReadMessageId: item(150).id,
    });
    expect(await metaRepository.get(ACCOUNT, `dm-read:${CONVERSATION}`)).toBeUndefined();
  });

  it("uses the migration marker to avoid rescanning legacy dm-read rows", async () => {
    await metaRepository.put(ACCOUNT, `dm-read:${CONVERSATION}`, {
      lastReadCreatedAt: 90,
      lastReadMessageId: item(90).id,
    });
    const first = await syncedMessageRepository.migrateLegacyDmReadState(ACCOUNT);
    expect(first.ran).toBe(true);

    await metaRepository.put(ACCOUNT, `dm-read:${CONVERSATION}`, {
      lastReadCreatedAt: 200,
      lastReadMessageId: item(200).id,
    });
    const second = await syncedMessageRepository.migrateLegacyDmReadState(ACCOUNT);

    expect(second).toEqual({ ran: false, migrated: 0, removed: 0, version: 1 });
    expect((await syncedMessageRepository.getReadState(ACCOUNT, CONVERSATION))?.lastReadCreatedAt).toBe(90);
  });
});

describe("reading paged DM history with an encrypted database", () => {
  it("does not maintain a second persisted read-cursor authority in Pinia", async () => {
    const direct = await restore();
    expect(Object.prototype.hasOwnProperty.call(direct.$state, "persistedReadCursors")).toBe(false);
  });

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

  it("never replaces the durable unread total with the bounded memory subset", async () => {
    for (let i = 1; i <= 151; i++) await save(item(i));
    const direct = await restore();
    expect(direct.unreadCount).toBe(151);

    // Home happens to hold only one historical message. The badge must still
    // reflect all 151 durable unread messages after the same canonical event is
    // applied to the UI.
    useMessagesStore().inbox = [item(151)];
    await direct.applyCanonicalMessage(ACCOUNT, item(151));

    expect(direct.unreadCount).toBe(151);
  });

  it("enumerates durable unread conversations even when Home memory is empty", async () => {
    for (let i = 1; i <= 151; i++) await save(item(i));
    const direct = await restore();
    expect(direct.unreadCount).toBe(151);

    useMessagesStore().inbox = [];
    direct.unreadByConversation = {};
    await direct.reconcileDurableUnread();

    expect(direct.unreadCount).toBe(151);
    expect(direct.unreadByConversation[CONVERSATION]).toBe(151);
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

  it("adopts a newer durable cursor when the UI projection is stale", async () => {
    for (let i = 1; i <= 360; i++) await save(item(i));
    const direct = await restore();
    direct.readCursors = {
      [CONVERSATION]: { lastReadCreatedAt: 300, lastReadMessageId: item(300).id },
    };
    await syncedMessageRepository.advanceReadState(ACCOUNT, CONVERSATION, {
      lastReadCreatedAt: 350,
      lastReadMessageId: item(350).id,
    });
    vi.mocked(scheduleAccountStateSync).mockClear();

    await direct.markPeerRead(PEER, item(320));

    expect(direct.readCursors[CONVERSATION]).toEqual({
      lastReadCreatedAt: 350,
      lastReadMessageId: item(350).id,
    });
    expect(vi.mocked(scheduleAccountStateSync)).not.toHaveBeenCalled();
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
    const advance = vi.spyOn(syncedMessageRepository, "advanceReadStateResult");
    const mirror = vi.spyOn(metaRepository, "put");
    const syncReadState = vi.mocked(scheduleAccountStateSync);
    syncReadState.mockClear();
    for (let i = 0; i < 20; i++) await direct.markPeerRead(PEER, item(360, ACCOUNT));
    // Repeated bottom-of-chat reads may ask the repository to persist again,
    // but its monotonic compare/write returns false and suppresses remote sync.
    expect(advance).toHaveBeenCalledTimes(20);
    expect(syncReadState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalledWith(
      ACCOUNT,
      expect.stringMatching(/^dm-read:/),
      expect.anything(),
    );
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
