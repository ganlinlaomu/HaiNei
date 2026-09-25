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
    expect(readFileSync(join(process.cwd(), "src/stores/keys.ts"), "utf8")).toContain("useDirectMessagesStore().refresh(pk)");
  });

  it("increments unread and unhides from a canonical inbox update without a full refresh", async () => {
    const context = seed([dm("first", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    await context.direct.hideConversation(PEER);
    const refresh = vi.spyOn(context.direct, "refresh");

    context.messageStore.addInbox(dm("new", 6));

    await vi.waitFor(() => expect(summaries().map(item => item.latest.id)).toEqual(["new"]));
    expect(context.direct.unreadCount).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("recomputes authorization-derived unread in memory when friendship state changes", async () => {
    const context = seed([dm("historical", 5), dm("blocked", 20)], relationship("removed", 10));
    await context.direct.refresh(ACCOUNT);
    expect(context.direct.unreadCount).toBe(0);
    const refresh = vi.spyOn(context.direct, "refresh");

    context.friendships.records = [relationship("accepted")];
    notifyDirectMessageAuthorizationChanged(ACCOUNT);

    await vi.waitFor(() => expect(context.direct.unreadCount).toBe(2));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows and counts accepted incoming DMs but excludes nonaccepted new DMs", async () => {
    let context = seed([dm("accepted-message", 5)], relationship("accepted"));
    await context.direct.refresh(ACCOUNT);
    expect(summaries()).toHaveLength(1);
    expect(context.direct.unreadCount).toBe(1);

    setActivePinia(createPinia());
    context = seed([dm("historical", 5), dm("unauthorized", 20)], relationship("removed", 10));
    await context.direct.refresh(ACCOUNT);
    expect(summaries().map(item => item.latest.id)).toEqual(["historical"]);
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
