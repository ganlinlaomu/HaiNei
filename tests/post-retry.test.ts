import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  key: {
    pkHex: "a".repeat(64),
    isLoggedIn: true,
    supportsNip44: true,
    nip44Encrypt: vi.fn(),
    signEvent: vi.fn(),
  },
  friendships: {
    loadedFor: "a".repeat(64),
    load: vi.fn(),
    isAccepted: vi.fn(() => true),
  },
  messages: {
    loadedFor: "a".repeat(64),
    load: vi.fn(),
    addOutbox: vi.fn(),
  },
  send: vi.fn(),
  publishQueued: vi.fn(),
  queueUpdate: vi.fn(),
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => mocks.friendships }));
vi.mock("@/stores/messages", () => ({ useMessagesStore: () => mocks.messages }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({
  sendDirectMessage: mocks.send,
  publishQueuedOutgoing: mocks.publishQueued,
}));
vi.mock("@/repositories/outgoingQueueRepository", () => ({
  outgoingQueueRepository: { update: mocks.queueUpdate },
}));

import { usePostsStore } from "@/stores/posts";

function published(id = "post-1") {
  return {
    message: {
      id,
      senderPubkey: ACCOUNT,
      recipientPubkeys: [PEER],
      plaintext: "hello",
      createdAt: 100,
      protocol: "nip17" as const,
      transportKind: 1059,
    },
    events: [],
    relayResults: [{ relay: "wss://relay.test", ok: true, ts: 1, eventId: "wrap-1" }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.key.pkHex = ACCOUNT;
  mocks.key.isLoggedIn = true;
  mocks.friendships.loadedFor = ACCOUNT;
  mocks.friendships.isAccepted.mockReturnValue(true);
  mocks.messages.loadedFor = ACCOUNT;
  mocks.friendships.load.mockResolvedValue(undefined);
  mocks.messages.load.mockResolvedValue(undefined);
  mocks.messages.addOutbox.mockResolvedValue(undefined);
  mocks.queueUpdate.mockResolvedValue(undefined);
});

describe("post publish retry identity", () => {
  it("freezes a queued post after a visible publish failure and exposes the same outgoing id", async () => {
    mocks.send.mockImplementationOnce(async (options: any) => {
      await options.onQueued("post-1");
      throw new Error("消息发布失败：1/1 个收件人副本未被任何 relay 接收");
    });

    let failure: any;
    try {
      await usePostsStore().sendDirectMessage([PEER], "hello");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure.outgoingId).toBe("post-1");
    expect(mocks.queueUpdate).toHaveBeenCalledWith(
      ACCOUNT,
      "post-1",
      expect.objectContaining({ state: "failed", nextAttemptAt: undefined })
    );
  });

  it("retries the exact queued post instead of creating a new message id", async () => {
    mocks.publishQueued.mockResolvedValueOnce(published("post-1"));

    const result = await usePostsStore().retryDirectMessage("post-1");

    expect(mocks.publishQueued).toHaveBeenCalledWith(ACCOUNT, "post-1");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.message.id).toBe("post-1");
    expect(mocks.messages.addOutbox).toHaveBeenCalledWith(expect.objectContaining({ id: "post-1" }));
  });

  it("freezes a failed explicit retry again so no background retry remains", async () => {
    mocks.publishQueued.mockRejectedValueOnce(new Error("relay failed"));

    await expect(usePostsStore().retryDirectMessage("post-1")).rejects.toMatchObject({ outgoingId: "post-1" });
    expect(mocks.queueUpdate).toHaveBeenCalledWith(
      ACCOUNT,
      "post-1",
      expect.objectContaining({ state: "failed", nextAttemptAt: undefined })
    );
  });
});
