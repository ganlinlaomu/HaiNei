import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);
const POST = "post-id";
const NOW = Math.floor(Date.now() / 1000);

const mocks = vi.hoisted(() => ({
  key: {
    pkHex: "a".repeat(64),
    isLoggedIn: true,
    supportsNip44: true,
    nip44Encrypt: vi.fn(),
    signEvent: vi.fn()
  },
  friendships: {
    loadedFor: "a".repeat(64),
    load: vi.fn(),
    isAccepted: vi.fn(() => true)
  },
  send: vi.fn()
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => mocks.friendships }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: mocks.send }));

import { INTERACTION_LABEL, likeNotificationId, useInteractionsStore, type Like } from "@/stores/interactions";
import { useNotificationsStore } from "@/stores/notifications";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, String(value)); }
  };
}

function likeMessage(eventId: string, author: string, liked: boolean | undefined, timestamp: number): CanonicalMessage {
  const like: Like = { id: `logical-${author}`, messageId: POST, author, timestamp, type: "like" };
  if (liked !== undefined) like.liked = liked;
  return {
    id: eventId,
    senderPubkey: author,
    recipientPubkeys: [ACCOUNT],
    conversationId: POST,
    plaintext: JSON.stringify(like),
    createdAt: timestamp,
    protocol: "nip17",
    transportKind: 1059,
    transportEventId: `${eventId}-wrap`,
    rumorId: eventId,
    tags: [["l", INTERACTION_LABEL], ["t", "like"]]
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true });
  mocks.friendships.loadedFor = ACCOUNT;
  mocks.friendships.isAccepted.mockReturnValue(true);
  mocks.send.mockResolvedValue({ message: {}, events: [], relayResults: [] });
  await useNotificationsStore().load(ACCOUNT);
  useInteractionsStore().loadedFor = ACCOUNT;
});

describe("stateful likes", () => {
  it("treats a legacy like without liked as active", async () => {
    const interactions = useInteractionsStore();
    await interactions.processCanonicalInteraction(likeMessage("legacy", PEER, undefined, NOW), ACCOUNT);
    expect(interactions.getLikeCount(POST)).toBe(1);
    expect(interactions.isLikedByUser(POST, PEER)).toBe(true);
  });

  it("collapses true -> false -> true to one active state and one notification", async () => {
    const interactions = useInteractionsStore();
    await interactions.processCanonicalInteraction(likeMessage("like-1", PEER, true, NOW), ACCOUNT);
    await interactions.processCanonicalInteraction(likeMessage("unlike", PEER, false, NOW + 1), ACCOUNT);
    await interactions.processCanonicalInteraction(likeMessage("like-2", PEER, true, NOW + 2), ACCOUNT);
    expect(interactions.getLikeCount(POST)).toBe(1);
    expect(interactions.getLikes(POST)).toHaveLength(1);
    expect(interactions.isLikedByUser(POST, PEER)).toBe(true);
    expect(useNotificationsStore().list).toEqual([
      expect.objectContaining({ id: likeNotificationId(POST, PEER), type: "like" })
    ]);
  });

  it("counts unique active authors and ignores an unlike for notifications", async () => {
    const interactions = useInteractionsStore();
    await interactions.processCanonicalInteraction(likeMessage("peer-like", PEER, true, NOW), ACCOUNT);
    await interactions.processCanonicalInteraction(likeMessage("peer-unlike", PEER, false, NOW + 1), ACCOUNT);
    await interactions.processCanonicalInteraction(likeMessage("other-like", OTHER, true, NOW + 2), ACCOUNT);
    expect(interactions.getLikeCount(POST)).toBe(1);
    expect(interactions.isLikedByUser(POST, PEER)).toBe(false);
    expect(interactions.isLikedByUser(POST, OTHER)).toBe(true);
    expect(useNotificationsStore().list.map(item => item.id)).toEqual([likeNotificationId(POST, OTHER), likeNotificationId(POST, PEER)]);
  });

  it("sends unlike through the existing interaction path", async () => {
    const interactions = useInteractionsStore();
    interactions._addInteraction({
      id: likeNotificationId(POST, ACCOUNT), messageId: POST, author: ACCOUNT,
      timestamp: NOW, type: "like", liked: true
    });
    await interactions.removeLike(POST, PEER);
    const payload = JSON.parse(mocks.send.mock.calls[0][0].content);
    expect(payload).toMatchObject({ type: "like", messageId: POST, author: ACCOUNT, liked: false });
    expect(mocks.send.mock.calls[0][0].tags).toContainEqual(["liked", "false"]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(interactions.isLikedByUser(POST, ACCOUNT)).toBe(false);
    expect(interactions.getLikeCount(POST)).toBe(0);
  });
});
