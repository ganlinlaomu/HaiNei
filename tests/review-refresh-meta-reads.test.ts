// Review finding #10 (store half): refresh() issued three metaRepository.get
// calls per peer (preference, receipt, sent receipt) instead of prefix reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { FriendshipRecord } from "@/db/dexie";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEERS = ["b", "c", "d", "e", "f"].map(char => char.repeat(64));

const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() },
  meta: new Map<string, unknown>(),
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: {
    get: vi.fn(async (account: string, key: string) => {
      const value = mocks.meta.get(`${account}:${key}`);
      return value === undefined ? undefined : { accountPubkey: account, key, value };
    }),
    put: vi.fn(async (account: string, key: string, value: unknown) => {
      mocks.meta.set(`${account}:${key}`, value);
    }),
    delete: vi.fn(async () => undefined),
    listPrefix: vi.fn(async (account: string, prefix: string) => [...mocks.meta.entries()]
      .filter(([key]) => key.startsWith(`${account}:${prefix}`))
      .map(([key, value]) => ({ accountPubkey: account, key: key.slice(account.length + 1), value }))),
  },
}));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => [] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: vi.fn() }));
vi.mock("@/repositories/outgoingDmTaskRepository", () => ({
  outgoingDmTaskRepository: { list: vi.fn(async () => []), get: vi.fn(), put: vi.fn(), update: vi.fn() },
}));

import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useMessagesStore } from "@/stores/messages";
import { metaRepository } from "@/repositories/metaRepository";

function accepted(peer: string): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: peer, state: "accepted", acceptedAt: 1, acceptedEventId: `a-${peer}`,
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: `a-${peer}` }], updatedAt: 1,
  };
}

function dm(peer: string, index: number): InboxItem {
  return {
    id: `${peer.slice(0, 8)}${index}`.padEnd(64, "0"), pubkey: peer, recipientPubkeys: [ACCOUNT],
    created_at: 100 + index, content: "hi", conversationId: `conversation:${peer}`,
    protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.meta.clear();
  vi.mocked(metaRepository.get).mockClear();
});

describe("review #10: refresh reads per-peer metadata by prefix", () => {
  it("does not issue per-peer point reads and still restores every peer's state", async () => {
    const [hiddenPeer, receiptPeer] = PEERS;
    mocks.meta.set(`${ACCOUNT}:dm-conversation:${hiddenPeer}`, { hidden: true, hiddenMode: "hidden", hiddenThroughCreatedAt: 999, hiddenThroughMessageId: "z" });
    mocks.meta.set(`${ACCOUNT}:dm-receipt:${receiptPeer}`, { read: { createdAt: 101, messageId: "r" } });
    mocks.meta.set(`${ACCOUNT}:dm-receipt-sent:${receiptPeer}`, { delivered: { createdAt: 102, messageId: "s" } });

    const messages = useMessagesStore();
    messages.loadedFor = ACCOUNT;
    messages.inbox = PEERS.map((peer, index) => dm(peer, index));
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = PEERS.map(accepted);

    const direct = useDirectMessagesStore();
    await direct.refresh(ACCOUNT);

    const keys = vi.mocked(metaRepository.get).mock.calls.map(([, key]) => key);
    expect(keys.filter(key => /^dm-(conversation|receipt|receipt-sent):/.test(key))).toEqual([]);

    expect(direct.preferencesByPeer[hiddenPeer]?.hidden).toBe(true);
    expect(direct.receiptStateByPeer[receiptPeer]?.read).toEqual({ createdAt: 101, messageId: "r" });
    expect(direct.sentReceiptStateByPeer[receiptPeer]?.delivered).toEqual({ createdAt: 102, messageId: "s" });
    // Peers without stored state still count as "loaded" for ensurePeerState.
    for (const peer of PEERS) expect(Object.prototype.hasOwnProperty.call(direct.preferencesByPeer, peer)).toBe(true);
  });
});
