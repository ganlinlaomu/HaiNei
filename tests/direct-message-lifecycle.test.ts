import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FriendshipRecord } from "@/db/dexie";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const CONVERSATION = `conversation:${PEER}`;

const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true, signEvent: vi.fn(), nip44Encrypt: vi.fn() },
  meta: new Map<string, unknown>(),
  put: vi.fn(),
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/repositories/metaRepository", () => ({
  metaRepository: {
    get: vi.fn(async (account: string, key: string) => {
      const value = mocks.meta.get(`${account}:${key}`);
      return value === undefined ? undefined : { accountPubkey: account, key, value };
    }),
    put: mocks.put,
    delete: vi.fn(async (account: string, key: string) => {
      mocks.meta.delete(`${account}:${key}`);
    }),
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

import {
  buildDirectConversationSummaries,
  isAuthorizedCanonicalDirectMessage,
  isAuthorizedDirectMessage,
  useDirectMessagesStore
} from "@/stores/directMessages";
import { useFriendshipsStore } from "@/stores/friendships";
import { useMessagesStore } from "@/stores/messages";
import { metaRepository } from "@/repositories/metaRepository";
import { notifyDirectMessageAuthorizationChanged } from "@/services/directMessageStateEvents";

function dm(id: string, created_at: number): InboxItem {
  return {
    id, pubkey: PEER, recipientPubkeys: [ACCOUNT], created_at, content: id,
    conversationId: CONVERSATION, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

function relationship(state: FriendshipRecord["state"], endedAt?: number): FriendshipRecord {
  return {
    accountPubkey: ACCOUNT, peerPubkey: PEER, state, acceptedAt: 1, acceptedEventId: "accepted",
    acceptedWindows: [{ acceptedAt: 1, acceptedEventId: "accepted", ...(endedAt === undefined ? {} : { endedAt, endedEventId: "ended" }) }],
    updatedAt: 1,
  };
}

function seed(messages: InboxItem[], friendship: FriendshipRecord) {
  const messageStore = useMessagesStore();
  messageStore.loadedFor = ACCOUNT;
  messageStore.inbox = messages;
  const friendships = useFriendshipsStore();
  friendships.loadedFor = ACCOUNT;
  friendships.records = [friendship];
  return { messageStore, friendships, direct: useDirectMessagesStore() };
}

function summaries() {
  const messages = useMessagesStore();
  const friendships = useFriendshipsStore();
  const direct = useDirectMessagesStore();
  return buildDirectConversationSummaries(messages.inbox, ACCOUNT, direct.unreadByConversation, {
    friendshipRecords: friendships.records,
    preferencesByPeer: direct.preferencesByPeer,
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.meta.clear();
  mocks.put.mockReset().mockImplementation(async (account: string, key: string, value: unknown) => {
    mocks.meta.set(`${account}:${key}`, value);
    return { accountPubkey: account, key, value };
  });
});

describe("direct-message authorization and conversation lifecycle", () => {
  it("keeps full refresh ownership out of HeaderBar and KeepAlive page watchers", () => {
    for (const file of ["src/components/HeaderBar.vue", "src/views/Conversations.vue", "src/views/Messages.vue"]) {
      expect(readFileSync(join(process.cwd(), file), "utf8")).not.toContain("directMessages.refresh(");
    }
    const keys = readFileSync(join(process.cwd(), "src/stores/keys.ts"), "utf8");
    const direct = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(keys).toContain("const directMessages = useDirectMessagesStore()");
    expect(keys).toContain("await directMessages.refresh(pk)");
    expect(direct).not.toContain("dm-read:");
    expect(direct).not.toContain("read-state mirror persistence failed");
  });

  it("keeps text/reply drafts isolated by account and peer and protects newer drafts", async () => {
    const direct = useDirectMessagesStore();
    direct.loadedFor = ACCOUNT;
    const otherPeer = "c".repeat(64);
    const otherAccount = "d".repeat(64);

    const first = await direct.saveDraft(PEER, { text: "下午三点", replyTo: "1".repeat(64) }, ACCOUNT);
    await direct.saveDraft(otherPeer, { text: "另一个好友" }, ACCOUNT);
    await direct.saveDraft(PEER, { text: "另一个账号" }, otherAccount);

    expect(direct.draftsByPeer[PEER]).toMatchObject({ text: "下午三点", replyTo: "1".repeat(64) });
    expect(direct.draftsByPeer[otherPeer]?.text).toBe("另一个好友");
    expect(mocks.meta.get(`${otherAccount}:dm-draft:${PEER}`)).toMatchObject({ text: "另一个账号" });

    await direct.clearDraftThrough(PEER, (first?.updatedAt || 0) - 1, ACCOUNT);
    expect(direct.draftsByPeer[PEER]?.text).toBe("下午三点");

    await direct.clearDraftThrough(PEER, (first?.updatedAt || 0) + 1, ACCOUNT);
    expect(direct.draftsByPeer[PEER]).toBeUndefined();
    expect(mocks.meta.has(`${ACCOUNT}:dm-draft:${PEER}`)).toBe(false);
  });

  it("increments unread and unhides from a canonical inbox update without a full refresh", async () => {
    const context = seed([dm("first", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    await context.direct.hideConversation(PEER);
    const refresh = vi.spyOn(context.direct, "refresh");
    const reconcile = vi.spyOn(context.direct, "reconcileDurableUnread").mockImplementation(async conversationId => {
      if (conversationId === CONVERSATION) context.direct.unreadByConversation = { [CONVERSATION]: 1 };
    });

    context.messageStore.addInbox(dm("new", 6));

    await vi.waitFor(() => expect(summaries().map(item => item.latest.id)).toEqual(["new"]));
    expect(context.direct.unreadCount).toBe(1);
    expect(reconcile).toHaveBeenCalledWith(CONVERSATION);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("hides provisional cross-device unread until authoritative account state is restored", async () => {
    const context = seed([dm("first", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    context.direct.unreadByConversation = { [CONVERSATION]: 151 };

    context.direct.beginReadStateRestore(ACCOUNT);
    expect(context.direct.readStateRestorePhase).toBe("restoring");
    expect(context.direct.unreadCount).toBe(0);
    expect(context.direct.visibleUnreadByConversation).toEqual({});

    context.direct.finishReadStateRestore(ACCOUNT);
    expect(context.direct.readStateRestorePhase).toBe("ready");
    expect(context.direct.unreadCount).toBe(151);
    expect(context.direct.visibleUnreadByConversation).toEqual({ [CONVERSATION]: 151 });
  });

  it("keeps unread stable while startup Relay history is hydrating", async () => {
    const context = seed([dm("first", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    expect(context.direct.unreadCount).toBe(1);

    context.direct.beginHistoryHydration(ACCOUNT);
    context.messageStore.addInbox(dm("history", 6));
    await Promise.resolve();
    await Promise.resolve();

    expect(context.direct.unreadCount).toBe(1);
    const reconcile = vi.spyOn(context.direct, "reconcileDurableUnread").mockResolvedValue(undefined);
    reconcile.mockClear();
    await context.direct.finishHistoryHydration(ACCOUNT);
    expect(reconcile).toHaveBeenCalled();
    expect(context.direct.historyHydrationPhase).toBe("live");
  });

  it("keeps a foreground read made while background refresh is still loading peer state", async () => {
    const context = seed([dm("latest", 20)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    const get = vi.mocked(metaRepository.get);
    const original = get.getMockImplementation()!;
    let release!: () => void;
    let captured!: () => void;
    const capturedRead = new Promise<void>(resolve => { captured = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    get.mockImplementation(async (account, key) => {
      const record = await original(account, key);
      if (key === `dm-conversation:${PEER}`) {
        captured();
        await gate;
      }
      return record;
    });
    try {
      const refresh = context.direct.refresh(ACCOUNT);
      await capturedRead;
      await context.direct.markPeerRead(PEER);
      release();
      await refresh;
      expect(context.direct.unreadCount).toBe(0);
      expect(context.direct.readCursors[CONVERSATION]?.lastReadMessageId).toBe("latest");
    } finally {
      release();
      get.mockImplementation(original);
    }
  });

  it("never rewinds a restored read cursor when a new device has only older local history", async () => {
    const context = seed([dm("local-10", 10)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);

    const restored = { lastReadCreatedAt: 20, lastReadMessageId: "remote-20" };
    context.direct.readCursors = { [CONVERSATION]: restored };
    context.direct.unreadByConversation = { [CONVERSATION]: 151 };

    await context.direct.markPeerRead(PEER);

    expect(context.direct.readCursors[CONVERSATION]).toEqual(restored);
    expect(context.direct.unreadCount).toBe(0);
    expect(mocks.meta.has(`${ACCOUNT}:dm-read:${CONVERSATION}`)).toBe(false);

    // Historical backfill that is still before the restored cursor must stay read.
    context.messageStore.addInbox(dm("backfill-15", 15));
    await vi.waitFor(() => expect(context.direct.unreadCount).toBe(0));
    expect(context.direct.readCursors[CONVERSATION]).toEqual(restored);
  });

  it("recomputes authorization-derived unread in memory when friendship state changes", async () => {
    const context = seed([dm("historical", 5), dm("blocked", 20)], relationship("removed", 10));
    await context.direct.refresh(ACCOUNT);
    expect(context.direct.unreadCount).toBe(0);
    const refresh = vi.spyOn(context.direct, "refresh");
    const reconcile = vi.spyOn(context.direct, "reconcileDurableUnread").mockImplementation(async () => {
      context.direct.unreadByConversation = { [CONVERSATION]: 2 };
    });

    context.friendships.records = [relationship("accepted")];
    notifyDirectMessageAuthorizationChanged(ACCOUNT);

    await vi.waitFor(() => expect(context.direct.unreadCount).toBe(2));
    expect(reconcile).toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("preserves historical DMs inside ended acceptance windows while blocking later messages", () => {
    const removed = relationship("removed", 10);
    expect(isAuthorizedDirectMessage(dm("historical", 5), ACCOUNT, removed)).toBe(true);
    expect(isAuthorizedDirectMessage(dm("after-remove", 20), ACCOUNT, removed)).toBe(false);
    expect(isAuthorizedCanonicalDirectMessage(
      { senderPubkey: PEER, createdAt: 5 },
      ACCOUNT,
      removed,
    )).toBe(true);
    expect(isAuthorizedCanonicalDirectMessage(
      { senderPubkey: PEER, createdAt: 20 },
      ACCOUNT,
      removed,
    )).toBe(false);
  });

  it("uses acceptedAt/lastControlAt as a safe legacy authorization window when acceptedWindows is absent", () => {
    const legacyRemoved: FriendshipRecord = {
      accountPubkey: ACCOUNT,
      peerPubkey: PEER,
      state: "removed",
      acceptedAt: 3,
      acceptedEventId: "accepted-old",
      lastControlAt: 10,
      lastControlEventId: "removed-old",
      lastAction: "remove",
      updatedAt: 10,
    };
    expect(isAuthorizedDirectMessage(dm("before-accept", 2), ACCOUNT, legacyRemoved)).toBe(false);
    expect(isAuthorizedDirectMessage(dm("during", 5), ACCOUNT, legacyRemoved)).toBe(true);
    expect(isAuthorizedDirectMessage(dm("after", 11), ACCOUNT, legacyRemoved)).toBe(false);
  });

  it("shows only current friends in the conversation list while retaining removed-friend history", async () => {
    let context = seed([dm("accepted-message", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    expect(summaries()).toHaveLength(1);
    expect(context.direct.unreadCount).toBe(1);

    setActivePinia(createPinia());
    context = seed([dm("historical", 5), dm("unauthorized", 20)], relationship("removed", 10));
    await context.direct.refresh(ACCOUNT);
    expect(summaries()).toHaveLength(0);
    expect(context.direct.peerMessages(PEER).map(item => item.id)).toEqual(["historical"]);
    expect(context.direct.unreadCount).toBe(0);
  });

  it("hides a conversation, clears unread, and only an accepted new DM unhides it", async () => {
    const context = seed([dm("first", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    await context.direct.hideConversation(PEER);
    expect(summaries()).toHaveLength(0);
    expect(context.direct.unreadCount).toBe(0);

    context.messageStore.inbox.push(dm("new", 6));
    await context.direct.refresh(ACCOUNT);
    expect(summaries().map(item => item.latest.id)).toEqual(["new"]);
    expect(context.direct.unreadCount).toBe(1);

    await context.direct.hideConversation(PEER);
    context.friendships.records = [relationship("removed", 6)];
    context.messageStore.inbox.push(dm("not-accepted", 7));
    await context.direct.refresh(ACCOUNT);
    expect(summaries()).toHaveLength(0);
    expect(context.direct.unreadCount).toBe(0);
  });

  it("persists deletion cutoff across restart and restores only a new post-cutoff valid DM", async () => {
    let context = seed([dm("old", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    await context.direct.deleteConversation(PEER);
    expect(context.direct.unreadCount).toBe(0);
    expect(summaries()).toHaveLength(0);

    setActivePinia(createPinia());
    context = seed([dm("old", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    expect(summaries()).toHaveLength(0);
    expect(context.direct.unreadCount).toBe(0);

    context.messageStore.addInbox(dm("new", 8));
    await vi.waitFor(() => expect(summaries().map(item => item.latest.id)).toEqual(["new"]));
    expect(summaries().map(item => item.latest.id)).toEqual(["new"]);
    expect(context.direct.peerMessages(PEER).map(item => item.id)).toEqual(["new"]);
    expect(context.direct.unreadCount).toBe(1);
  });

  it("does not restore deleted history when a friend is removed and accepted again", async () => {
    let context = seed([dm("old", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    await context.direct.deleteConversation(PEER);
    context.friendships.records = [relationship("accepted")];
    await context.direct.refresh(ACCOUNT);
    expect(context.direct.peerMessages(PEER)).toHaveLength(0);
    expect(summaries()).toHaveLength(0);
  });

  it("ignores incremental source events for a different account", async () => {
    const context = seed([dm("current", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    const originalUnread = context.direct.unreadCount;
    context.messageStore.loadedFor = "c".repeat(64);

    context.messageStore.addInbox(dm("other-account", 30));
    await Promise.resolve();

    expect(context.direct.loadedFor).toBe(ACCOUNT);
    expect(context.direct.unreadCount).toBe(originalUnread);
  });
});
