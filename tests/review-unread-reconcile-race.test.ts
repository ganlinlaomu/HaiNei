// Review finding #2: a full durable unread reconciliation is silently dropped
// when unrelated peer state changes while it awaits IndexedDB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FriendshipRecord, SyncedMessageRecord } from "@/db/dexie";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER_PEER = "c".repeat(64);
const CONVERSATION = `conversation:${PEER}`;
const OTHER_CONVERSATION = `conversation:${OTHER_PEER}`;

const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() },
  unreadGate: null as Promise<void> | null,
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    listPrefix: vi.fn(async () => []),
  },
}));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));
vi.mock("@/repositories/outgoingDmTaskRepository", () => ({
  outgoingDmTaskRepository: { list: vi.fn(async () => []), get: vi.fn(), put: vi.fn(), update: vi.fn() },
}));
vi.mock("@/repositories/syncedMessageRepository", () => ({
  syncedMessageRepository: {
    listDirectConversationHeads: vi.fn(async (): Promise<Partial<SyncedMessageRecord>[]> => [{
      id: "head", senderPubkey: PEER, recipientPubkeys: [ACCOUNT], conversationId: CONVERSATION, createdAt: 10,
    }]),
    // Durable truth: three unread messages from PEER.
    getVisibleUnreadCount: vi.fn(async () => {
      if (mocks.unreadGate) await mocks.unreadGate;
      return 3;
    }),
    getReadState: vi.fn(async () => ({ lastReadCreatedAt: 5, lastReadMessageId: "read" })),
  },
}));

import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";

function accepted(peer: string): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: peer, state: "accepted", acceptedAt: 1, acceptedEventId: `accepted-${peer}`,
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: `accepted-${peer}` }], updatedAt: 1,
  };
}

function setup() {
  const friendships = useFriendshipsStore();
  friendships.loadedFor = ACCOUNT;
  friendships.records = [accepted(PEER), accepted(OTHER_PEER)];
  const direct = useDirectMessagesStore();
  direct.loadedFor = ACCOUNT;
  direct.readStateRestorePhase = "ready";
  direct.preferencesByPeer = { [PEER]: undefined };
  direct.readCursors = { [CONVERSATION]: undefined };
  return direct;
}

beforeEach(() => {
  setActivePinia(createPinia());
  // Exercise the production IndexedDB branch of reconcileDurableUnread.
  vi.stubGlobal("indexedDB", {});
  mocks.unreadGate = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review #2: full unread reconciliation vs. concurrent peer state changes", () => {
  it("baseline: without concurrent changes the durable count is applied", async () => {
    const direct = setup();
    await direct.reconcileDurableUnread();
    expect(direct.unreadByConversation).toEqual({ [CONVERSATION]: 3 });
  });

  it("keeps the durable count when another peer's state loads mid-reconciliation", async () => {
    const direct = setup();
    // refresh() clears the projection right before its full reconciliation.
    direct.unreadByConversation = {};
    let release!: () => void;
    mocks.unreadGate = new Promise<void>(resolve => { release = resolve; });

    const reconciling = direct.reconcileDurableUnread();
    // A first message from another friend arrives meanwhile:
    // applyCanonicalMessage -> ensurePeerState replaces readCursors/preferences.
    await direct.ensurePeerState(ACCOUNT, OTHER_PEER, OTHER_CONVERSATION);
    release();
    await reconciling;

    expect(direct.unreadByConversation[CONVERSATION]).toBe(3);
    expect(direct.unreadCount).toBe(3);
  });

  it("keeps the durable count when the user reads a different chat mid-reconciliation", async () => {
    const direct = setup();
    direct.unreadByConversation = {};
    let release!: () => void;
    mocks.unreadGate = new Promise<void>(resolve => { release = resolve; });

    const reconciling = direct.reconcileDurableUnread();
    // Same assignment pattern markPeerReadInternal uses for its cursor.
    direct.readCursors = { ...direct.readCursors, [OTHER_CONVERSATION]: { lastReadCreatedAt: 9, lastReadMessageId: "x" } };
    release();
    await reconciling;

    expect(direct.unreadByConversation[CONVERSATION]).toBe(3);
  });

  it("still discards the result when the account switches mid-reconciliation", async () => {
    const direct = setup();
    direct.unreadByConversation = {};
    let release!: () => void;
    mocks.unreadGate = new Promise<void>(resolve => { release = resolve; });

    const reconciling = direct.reconcileDurableUnread();
    direct.loadedFor = "d".repeat(64);
    release();
    await reconciling;

    expect(direct.unreadByConversation).toEqual({});
  });
});
