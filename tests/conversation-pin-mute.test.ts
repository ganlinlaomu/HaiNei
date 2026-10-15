// Conversation pin / mute. Stored on the per-friend metadata record so it
// syncs across devices (friend_metadata account state): a device-local mute
// would be undone by another device re-uploading the account-wide push policy.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db, type FriendshipRecord } from "@/db/dexie";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);

const mocks = vi.hoisted(() => ({
  scheduleSync: vi.fn(),
  pushPolicy: vi.fn(async () => true),
}));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() }) }));
vi.mock("@/services/accountStateSync", () => ({ scheduleAccountStateSync: mocks.scheduleSync }));
vi.mock("@/services/pushNotifications", () => ({
  pushEnabledForAccount: () => true,
  syncPushAuthorizationPolicy: mocks.pushPolicy,
}));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), listPrefix: vi.fn(async () => []) },
}));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));
vi.mock("@/repositories/outgoingDmTaskRepository", () => ({
  outgoingDmTaskRepository: { list: vi.fn(async () => []), get: vi.fn(), put: vi.fn(), update: vi.fn() },
}));

import { friendRepository } from "@/repositories/friendRepository";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useMessagesStore } from "@/stores/messages";
import { sortConversationRows } from "@/utils/conversationOrder";

function accepted(peer: string): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: peer, state: "accepted", acceptedAt: 1, acceptedEventId: `a-${peer}`,
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: `a-${peer}` }], updatedAt: 1,
  };
}

function dm(peer: string, id: string, createdAt: number): InboxItem {
  return {
    id, pubkey: peer, recipientPubkeys: [ACCOUNT], created_at: createdAt, content: id,
    conversationId: `conversation:${peer}`, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

async function loadStores() {
  const friendships = useFriendshipsStore();
  friendships.loadedFor = ACCOUNT;
  friendships.authorizationReady = true;
  friendships.records = [accepted(PEER), accepted(OTHER)];
  const friends = useFriendsStore();
  await friends.load(ACCOUNT);
  return { friends, friendships };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  mocks.scheduleSync.mockClear();
  mocks.pushPolicy.mockClear();
  await db.open();
  await db.accountFriends.clear();
});

describe("friend metadata storage", () => {
  it("persists pin and mute and lists muted peers", async () => {
    await friendRepository.put(ACCOUNT, { pubkey: PEER, name: "老王", dmPinnedAt: 123, dmMuted: true, updatedAt: 1 });
    await friendRepository.put(ACCOUNT, { pubkey: OTHER, dmMuted: false, updatedAt: 1 });
    expect(await friendRepository.get(ACCOUNT, PEER)).toMatchObject({ name: "老王", dmPinnedAt: 123, dmMuted: true });
    expect(await friendRepository.listMutedPeers(ACCOUNT)).toEqual([PEER]);
  });
});

describe("friends store conversation preferences", () => {
  it("pins a friend without metadata and never persists a placeholder name", async () => {
    const { friends } = await loadStores();
    await friends.setConversationPreference(PEER, { pinned: true });
    const stored = await friendRepository.get(ACCOUNT, PEER);
    expect(stored?.dmPinnedAt).toBeGreaterThan(0);
    expect(stored?.name).toBeUndefined();
    expect(friends.conversationPreference(PEER)).toMatchObject({ pinned: true, muted: false });
    expect(mocks.scheduleSync).toHaveBeenCalledWith(expect.anything(), "friend_metadata");
    expect(mocks.pushPolicy).not.toHaveBeenCalled(); // pin does not affect push
  });

  it("keeps the existing remark and refreshes the push policy without muted friends", async () => {
    const { friends } = await loadStores();
    await friends.upsertMetadata(PEER, { name: "老王" });
    await friends.setConversationPreference(PEER, { muted: true });
    expect(await friendRepository.get(ACCOUNT, PEER)).toMatchObject({ name: "老王", dmMuted: true });
    expect(mocks.pushPolicy).toHaveBeenCalledWith(ACCOUNT, expect.arrayContaining([PEER, OTHER]), expect.any(Function));

    await friends.setConversationPreference(PEER, { pinned: true });
    await friends.setConversationPreference(PEER, { pinned: false, muted: false });
    expect(friends.conversationPreference(PEER)).toEqual({ pinned: false, muted: false, pinnedAt: 0 });
  });
});

describe("conversation order", () => {
  it("puts pinned conversations first (latest pin first), then by latest message", () => {
    const row = (peerPubkey: string, at: number) => ({ peerPubkey, latest: { id: peerPubkey, created_at: at } });
    const rows = [row("old-pinned", 10), row("newest", 50), row("new-pinned", 5), row("middle", 30)];
    const pinnedAt: Record<string, number> = { "old-pinned": 100, "new-pinned": 200 };
    expect(sortConversationRows(rows, peer => pinnedAt[peer] || 0).map(item => item.peerPubkey))
      .toEqual(["new-pinned", "old-pinned", "newest", "middle"]);
  });
});

describe("muted conversations and unread totals", () => {
  it("excludes muted conversations from the badge total but keeps their per-row unread", async () => {
    const { friends } = await loadStores();
    const messages = useMessagesStore();
    messages.loadedFor = ACCOUNT;
    messages.inbox = [dm(PEER, "p1", 10), dm(PEER, "p2", 11), dm(OTHER, "o1", 12)];
    const direct = useDirectMessagesStore();
    vi.stubGlobal("indexedDB", undefined); // in-memory projection path
    try {
      await direct.refresh(ACCOUNT);
      expect(direct.unreadCount).toBe(3);

      await friends.setConversationPreference(PEER, { muted: true });
      expect(direct.unreadCount).toBe(1);
      expect(direct.visibleUnreadByConversation[`conversation:${PEER}`]).toBe(2);
      expect(direct.isConversationMuted(`conversation:${PEER}`)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
