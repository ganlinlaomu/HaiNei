// Review finding #12: a conversation row looked up unread by the latest
// item's conversationId, which is "local:<peer>" for an unmatched outgoing task.
// Review finding #13: refresh() compared pkHex to the lowercased account
// without normalizing it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FriendshipRecord } from "@/db/dexie";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const CONVERSATION = `conversation:${PEER}`;

const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() },
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

import { buildDirectConversationSummaries, useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useMessagesStore } from "@/stores/messages";

function accepted(): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", acceptedAt: 1, acceptedEventId: "a",
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: "a" }], updatedAt: 1,
  };
}

function incoming(id: string, createdAt: number): InboxItem {
  return {
    id, pubkey: PEER, recipientPubkeys: [ACCOUNT], created_at: createdAt, content: id,
    conversationId: CONVERSATION, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

function pendingOutgoing(createdAt: number): InboxItem {
  // Shape produced by taskInboxItem() for a task not yet matched to its echo.
  return {
    id: "local:task-1", pubkey: ACCOUNT, recipientPubkeys: [PEER], created_at: createdAt, content: "offline reply",
    conversationId: `local:${PEER}`, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
    outgoing: { localId: "task-1", state: "send_failed" },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.key.pkHex = ACCOUNT;
});

describe("review #12: conversation row unread with a pending outgoing tail", () => {
  it("keeps showing the peer's unread when my unsent reply is the newest item", () => {
    // Peer messages delivered late (after reconnect) but timestamped before my
    // failed offline reply: the row's latest item is my local task.
    const items = [incoming("1".repeat(64), 100), incoming("2".repeat(64), 110), pendingOutgoing(120)];
    const [row] = buildDirectConversationSummaries(items, ACCOUNT, { [CONVERSATION]: 2 }, {
      friendshipRecords: [accepted()],
    });
    expect(row.latest.id).toBe("local:task-1");
    expect(row.unread).toBe(2);
  });

  it("control: unread lookup is unchanged when the latest item is canonical", () => {
    const [row] = buildDirectConversationSummaries([incoming("1".repeat(64), 100)], ACCOUNT, { [CONVERSATION]: 1 }, {
      friendshipRecords: [accepted()],
    });
    expect(row.unread).toBe(1);
  });
});

describe("review #13: refresh tolerates a non-normalized pkHex", () => {
  it("loads the account even if the key store holds an uppercase pubkey", async () => {
    mocks.key.pkHex = ACCOUNT.toUpperCase();
    const messages = useMessagesStore();
    messages.loadedFor = ACCOUNT;
    messages.inbox = [incoming("1".repeat(64), 100)];
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [accepted()];
    const direct = useDirectMessagesStore();
    await direct.refresh(ACCOUNT.toUpperCase());
    expect(direct.loadedFor).toBe(ACCOUNT);
  });
});
