import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);

const mocks = vi.hoisted(() => ({
  key: {
    pkHex: "a".repeat(64),
    isLoggedIn: true,
    supportsNip44: true,
    nip44Encrypt: vi.fn(),
    signEvent: vi.fn()
  },
  send: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
  delete: vi.fn()
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: mocks.send }));
vi.mock("@/repositories/friendshipRepository", () => ({
  friendshipRepository: { list: mocks.list, put: mocks.put, delete: mocks.delete }
}));

import { useFriendshipsStore } from "@/stores/friendships";
import { usePostsStore } from "@/stores/posts";
import { useInteractionsStore } from "@/stores/interactions";
import { useFriendsStore } from "@/stores/friends";
import { friendshipTags } from "@/nostr/messaging/friendshipControl";

function message(action: "request" | "accept" | "reject" | "remove", sender = PEER): CanonicalMessage {
  return {
    id: `${action}-event`,
    senderPubkey: sender,
    recipientPubkeys: [ACCOUNT],
    conversationId: "control",
    plaintext: JSON.stringify({ type: `friend_${action}`, from: sender, timestamp: 100 }),
    createdAt: 100,
    protocol: "nip17",
    transportKind: 1059,
    transportEventId: `${action}-wrap`,
    rumorId: `${action}-event`,
    tags: friendshipTags(action)
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.key.pkHex = ACCOUNT;
  mocks.list.mockResolvedValue([]);
  mocks.put.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async (options: any) => ({
    message: {
      id: `sent-${options.tags?.[1]?.[1] || "normal"}`,
      senderPubkey: ACCOUNT,
      recipientPubkeys: options.recipientPubkeys,
      createdAt: 100,
      protocol: "nip17",
      transportKind: 1059,
      tags: options.tags || []
    },
    events: [],
    relayResults: []
  }));
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
    key: () => null
  });
});

describe("friendship state and message authorization", () => {
  it("processes unknown requests and control messages bypass the normal friend gate", async () => {
    const friendships = useFriendshipsStore();
    await friendships.load(ACCOUNT);
    expect(await friendships.processFriendshipMessage(message("request"))).toBe(true);
    expect(friendships.getState(PEER)).toBe("incoming_pending");

    await friendships.sendRequest(OTHER);
    expect(friendships.getState(OTHER)).toBe("outgoing_pending");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      recipientPubkeys: [OTHER], tags: friendshipTags("request")
    }));
  });

  it.each(["outgoing_pending", "incoming_pending"] as const)("blocks normal messages while %s", async state => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state, updatedAt: 1 }];
    await expect(usePostsStore().sendDirectMessage([PEER], "blocked")).rejects.toThrow("已互相确认");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("allows normal messages and interactions after acceptance", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", updatedAt: 1 }];
    await usePostsStore().sendDirectMessage([PEER], "allowed");
    await useInteractionsStore().sendLike("message-id", PEER);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("shows an optimistic like immediately and does not duplicate it after publish", async () => {
    let finishSend!: (value: any) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { finishSend = resolve; }));
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", updatedAt: 1 }];
    const interactions = useInteractionsStore();
    interactions.loadedFor = ACCOUNT;
    const sending = interactions.sendLike("message-id", PEER);
    expect(interactions.getLikeCount("message-id")).toBe(1);
    expect(interactions.getLikes("message-id")[0].pending).toBe(true);
    finishSend({ message: {}, events: [], relayResults: [] });
    await sending;
    expect(interactions.getLikeCount("message-id")).toBe(1);
    expect(interactions.getLikes("message-id")[0].pending).toBeUndefined();
  });

  it("accepts only a pending outgoing request and remove blocks later messages", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "outgoing_pending", updatedAt: 1 }];
    await friendships.processFriendshipMessage(message("accept"));
    expect(friendships.getState(PEER)).toBe("accepted");
    await friendships.processFriendshipMessage(message("remove"));
    expect(friendships.getState(PEER)).toBeUndefined();
    await expect(usePostsStore().sendDirectMessage([PEER], "blocked again")).rejects.toThrow("已互相确认");
  });

  it("accepts an incoming request and creates minimal contact metadata", async () => {
    const friendships = useFriendshipsStore();
    const friends = useFriendsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "incoming_pending", updatedAt: 1 }];
    friends.loadedFor = ACCOUNT;
    friends.list = [];
    await friendships.acceptRequest(PEER);
    expect(friendships.getState(PEER)).toBe("accepted");
    expect(friends.list).toEqual([expect.objectContaining({ pubkey: PEER, name: `${PEER.slice(0, 8)}…` })]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ tags: friendshipTags("accept") }));
  });

  it("clears pending state on reject", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "outgoing_pending", updatedAt: 1 }];
    await friendships.processFriendshipMessage(message("reject"));
    expect(friendships.getState(PEER)).toBeUndefined();
    expect(mocks.delete).toHaveBeenCalledWith(ACCOUNT, PEER);
  });

  it("does not leak relationship state across accounts", async () => {
    mocks.list.mockImplementation(async (account: string) => account === ACCOUNT
      ? [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", updatedAt: 1 }]
      : []);
    const friendships = useFriendshipsStore();
    await friendships.load(ACCOUNT);
    expect(friendships.isAccepted(PEER)).toBe(true);
    friendships.reset();
    await friendships.load(OTHER);
    expect(friendships.isAccepted(PEER)).toBe(false);
  });
});
