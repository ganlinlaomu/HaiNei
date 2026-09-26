import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);
const BOOTSTRAP_RELAYS = ["wss://bootstrap.test", "wss://shared.test"];

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
  delete: vi.fn(),
  sendCurrentProfileTo: vi.fn(),
  requestCurrentProfile: vi.fn(),
  getRelaysFromStorage: vi.fn()
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({
  DEFAULT_RELAYS: ["wss://bootstrap.test", "wss://shared.test"],
  getRelaysFromStorage: mocks.getRelaysFromStorage
}));
vi.mock("@/nostr/messaging/service", () => ({
  sendDirectMessage: mocks.send,
  publishQueuedOutgoing: vi.fn()
}));
vi.mock("@/repositories/friendshipRepository", () => ({
  friendshipRepository: { list: mocks.list, put: mocks.put, delete: mocks.delete }
}));
vi.mock("@/stores/profiles", () => ({
  useProfilesStore: () => ({
    sendCurrentProfileTo: mocks.sendCurrentProfileTo,
    requestCurrentProfile: mocks.requestCurrentProfile
  })
}));

import { reduceFriendshipControl, useFriendshipsStore, type FriendshipControlEvent } from "@/stores/friendships";
import { usePostsStore } from "@/stores/posts";
import { useInteractionsStore } from "@/stores/interactions";
import { useFriendsStore } from "@/stores/friends";
import { friendshipTags } from "@/nostr/messaging/friendshipControl";
import { useNotificationsStore } from "@/stores/notifications";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";

function message(action: "request" | "accept" | "reject" | "remove" | "cancel", sender = PEER): CanonicalMessage {
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
  mocks.key.isLoggedIn = true;
  mocks.key.supportsNip44 = true;
  mocks.getRelaysFromStorage.mockReturnValue(["wss://relay.test"]);
  mocks.list.mockResolvedValue([]);
  mocks.put.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue(undefined);
  mocks.sendCurrentProfileTo.mockResolvedValue(undefined);
  mocks.requestCurrentProfile.mockResolvedValue(undefined);
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
  it("uses configured write relays plus deduped bootstrap relays for friendship requests", async () => {
    mocks.getRelaysFromStorage.mockReturnValue(["wss://configured.test", "wss://shared.test"]);
    await useFriendshipsStore().sendRequest(PEER);
    expect(mocks.getRelaysFromStorage).toHaveBeenCalledWith("write");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      relays: ["wss://configured.test", "wss://shared.test", "wss://bootstrap.test"]
    }));
  });

  it("falls back to bootstrap relays when configured write relays are empty", async () => {
    mocks.getRelaysFromStorage.mockReturnValue([]);
    await useFriendshipsStore().sendRequest(PEER);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ relays: BOOTSTRAP_RELAYS }));
  });

  it("rejects unsupported NIP-44 before sending a friendship request", async () => {
    mocks.key.supportsNip44 = false;
    await expect(useFriendshipsStore().sendRequest(PEER))
      .rejects.toThrow("当前登录方式暂不支持加密好友请求");
    expect(mocks.send).not.toHaveBeenCalled();
  });

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

  it("allows a self-recipient comment without friendship and sends only an encrypted image ref", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [];
    const ref = encodeEncryptedImageRef({
      v: 1,
      url: "https://media.example/encrypted",
      mime: "image/jpeg",
      alg: "AES-GCM",
      iv: "aXY=",
      key: "a2V5"
    });
    await useInteractionsStore().sendComment("message-id", ACCOUNT, "", undefined, [
      { type: "image", ref, width: 320, height: 240 },
      { type: "image", ref, width: 640, height: 480 }
    ]);
    const payload = JSON.parse(mocks.send.mock.calls[0][0].content);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ recipientPubkeys: [ACCOUNT] }));
    expect(payload.text).toBe("");
    expect(payload.media).toEqual([{ type: "image", ref, width: 320, height: 240 }]);
    expect(mocks.send.mock.calls[0][0].content).not.toContain("data:image");
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
    expect(friendships.getState(PEER)).toBe("removed");
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
    expect(mocks.sendCurrentProfileTo).toHaveBeenCalledWith(PEER);
    expect(mocks.requestCurrentProfile).toHaveBeenCalledWith(PEER);
  });

  it("binds new accept controls to the pending request id", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{
      accountPubkey: ACCOUNT, peerPubkey: PEER, state: "incoming_pending",
      requestEventId: "bound-request", requestedAt: 90, updatedAt: 1,
    }];
    await friendships.acceptRequest(PEER);
    expect(JSON.parse(mocks.send.mock.calls[0][0].content)).toMatchObject({
      type: "friend_accept", requestId: "bound-request",
    });
  });

  it("sends the current profile when an outgoing request becomes accepted", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "outgoing_pending", updatedAt: 1 }];
    await friendships.processFriendshipMessage(message("accept"));
    expect(friendships.getState(PEER)).toBe("accepted");
    expect(mocks.sendCurrentProfileTo).toHaveBeenCalledWith(PEER);
    expect(mocks.requestCurrentProfile).toHaveBeenCalledWith(PEER);
  });

  it("clears pending state on reject", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "outgoing_pending", updatedAt: 1 }];
    await friendships.processFriendshipMessage(message("reject"));
    expect(friendships.getState(PEER)).toBe("rejected");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("withdraws a local outgoing request with a distinct cancel control", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "outgoing_pending", updatedAt: 1 }];
    await friendships.cancelRequest(PEER);
    expect(friendships.getState(PEER)).toBe("cancelled");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ tags: friendshipTags("cancel") }));
  });

  it("removes a remote incoming request on cancel and resolves its notification", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "incoming_pending", updatedAt: 1 }];
    const notifications = useNotificationsStore();
    notifications.loadedFor = ACCOUNT;
    notifications.list = [{
      id: "friend-request:request-event", type: "friend_request", from: PEER,
      messageId: "request-event", created_at: Math.floor(Date.now() / 1000), read: false
    }];
    await friendships.processFriendshipMessage(message("cancel"));
    expect(friendships.getState(PEER)).toBe("cancelled");
    expect(notifications.unreadCount).toBe(0);
    expect(notifications.list[0].read).toBe(true);
  });

  it("does not remove an accepted friendship when a stale cancel arrives", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "accepted", updatedAt: 1 }];
    await friendships.processFriendshipMessage(message("cancel"));
    expect(friendships.getState(PEER)).toBe("accepted");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("handles duplicate cancel events idempotently", async () => {
    const friendships = useFriendshipsStore();
    friendships.loadedFor = ACCOUNT;
    friendships.records = [{ accountPubkey: ACCOUNT, peerPubkey: PEER, state: "incoming_pending", updatedAt: 1 }];
    await friendships.processFriendshipMessage(message("cancel"));
    await friendships.processFriendshipMessage(message("cancel"));
    expect(friendships.getState(PEER)).toBe("cancelled");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("edits outgoing-request metadata without resending the request", () => {
    const friends = useFriendsStore();
    friends.loadedFor = ACCOUNT;
    friends.list = [{ pubkey: PEER, name: "旧备注", groups: ["旧分组"] }];
    expect(friends.update(PEER, { name: "新备注", groups: ["家人"], group: "家人" })).toBe(true);
    expect(friends.list[0]).toMatchObject({ name: "新备注", groups: ["家人"], group: "家人" });
    expect(mocks.send).not.toHaveBeenCalled();
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

describe("monotonic friendship control reducer", () => {
  const base = { accountPubkey: ACCOUNT, peerPubkey: PEER };
  const event = (action: FriendshipControlEvent["action"], timestamp: number, eventId: string, selfMessage = false, requestId?: string): FriendshipControlEvent =>
    ({ action, timestamp, eventId, selfMessage, requestId });

  it("keeps removed after replaying an old request or accept", () => {
    const requested = reduceFriendshipControl(undefined, base, event("request", 10, "request"))!;
    const accepted = reduceFriendshipControl(requested, base, event("accept", 20, "accept", true, "request"))!;
    const removed = reduceFriendshipControl(accepted, base, event("remove", 30, "remove"))!;
    expect(reduceFriendshipControl(removed, base, event("request", 10, "request"))?.state).toBe("removed");
    expect(reduceFriendshipControl(removed, base, event("accept", 20, "accept", true, "request"))?.state).toBe("removed");
  });

  it("does not let a stale cancel overwrite accepted state", () => {
    const requested = reduceFriendshipControl(undefined, base, event("request", 10, "request"))!;
    const accepted = reduceFriendshipControl(requested, base, event("accept", 20, "accept", true))!;
    expect(reduceFriendshipControl(accepted, base, event("cancel", 15, "cancel"))).toBe(accepted);
  });

  it("is idempotent and uses event id as the same-timestamp tie-break", () => {
    const first = reduceFriendshipControl(undefined, base, event("request", 10, "b"))!;
    expect(reduceFriendshipControl(first, base, event("request", 10, "b"))).toBe(first);
    expect(reduceFriendshipControl(first, base, event("request", 10, "a"))).toBe(first);
    expect(reduceFriendshipControl(first, base, event("request", 10, "c"))?.lastControlEventId).toBe("c");
  });

  it("allows a genuinely newer request after a tombstone", () => {
    const requested = reduceFriendshipControl(undefined, base, event("request", 10, "request"))!;
    const accepted = reduceFriendshipControl(requested, base, event("accept", 20, "accept", true))!;
    const removed = reduceFriendshipControl(accepted, base, event("remove", 30, "remove"))!;
    expect(reduceFriendshipControl(removed, base, event("request", 40, "new-request"))?.state).toBe("incoming_pending");
  });

  it("ignores a mismatched requestId and accepts legacy controls without one", () => {
    const requested = reduceFriendshipControl(undefined, base, event("request", 10, "request"))!;
    expect(reduceFriendshipControl(requested, base, event("accept", 20, "bad-accept", true, "other"))).toBe(requested);
    expect(reduceFriendshipControl(requested, base, event("accept", 20, "legacy-accept", true))?.state).toBe("accepted");
  });
});
