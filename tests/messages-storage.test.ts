import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const mocks = vi.hoisted(() => ({ list: vi.fn(), insert: vi.fn(), outgoing: vi.fn() }));
vi.mock("@/repositories/syncedMessageRepository", () => ({
  syncedMessageRepository: { list: mocks.list, insertMessageIfAbsent: mocks.insert }
}));
vi.mock("@/repositories/outgoingQueueRepository", () => ({
  outgoingQueueRepository: { list: mocks.outgoing }
}));

import { useMessagesStore } from "@/stores/messages";

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

let storage: MemoryStorage;
beforeEach(() => {
  setActivePinia(createPinia());
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.insert.mockReset().mockResolvedValue({ inserted: true });
  mocks.outgoing.mockReset().mockResolvedValue([]);
});

describe("Home Dexie restoration", () => {
  it("restores Home messages from the synced repository without writing an inbox array", async () => {
    mocks.list.mockResolvedValue([{
      accountPubkey: ACCOUNT, id: "home-1", senderPubkey: OTHER, recipientPubkeys: [ACCOUNT],
      conversationId: "home-1", plaintext: "hello", createdAt: 12, protocol: "nip17",
      transportKind: 1059, transportEventIds: ["wrap"], firstSeenAt: 1, lastSeenAt: 1
    }]);
    const setItem = vi.spyOn(storage, "setItem");
    const messages = useMessagesStore();
    await messages.load(ACCOUNT);
    expect(messages.inbox).toEqual([expect.objectContaining({ id: "home-1", content: "hello" })]);
    expect(messages.lastInboxMutation).toMatchObject({ type: "replace", revision: messages.inboxRevision });
    const loadedRevision = messages.inboxRevision;
    messages.addInbox({ id: "memory", pubkey: OTHER, created_at: 13, content: "ui only" });
    expect(messages.inboxRevision).toBe(loadedRevision + 1);
    expect(messages.lastInboxMutation).toMatchObject({ type: "insert", itemId: "memory", revision: messages.inboxRevision });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("marks metadata replacement separately so Home falls back to a full rebuild", async () => {
    const messages = useMessagesStore();
    await messages.load(ACCOUNT);
    messages.addInbox({ id: "own", pubkey: ACCOUNT, created_at: 20, content: "hello" });
    const insertedRevision = messages.inboxRevision;
    messages.addInbox({
      id: "own", pubkey: ACCOUNT, created_at: 20, content: "hello",
      _localMeta: { groupCount: 1, groups: [{ name: "好友", count: 1 }] }
    });
    expect(messages.inboxRevision).toBe(insertedRevision + 1);
    expect(messages.lastInboxMutation).toMatchObject({ type: "update", itemId: "own" });
    expect(messages.inbox[0]._localMeta?.groupCount).toBe(1);
  });

  it("does not restore private controls as Home items", async () => {
    mocks.list.mockResolvedValue([{
      accountPubkey: ACCOUNT, id: "request", senderPubkey: OTHER, recipientPubkeys: [ACCOUNT],
      conversationId: "request", plaintext: "{}", createdAt: 12, protocol: "nip17",
      transportKind: 1059, transportEventIds: ["wrap"], tags: [["t", "hainei-profile-request"]],
      firstSeenAt: 1, lastSeenAt: 1
    }]);
    const messages = useMessagesStore();
    await messages.load(ACCOUNT);
    expect(messages.inbox).toEqual([]);
  });

  it("imports only the selected account's compatible legacy inbox and leaves other accounts untouched", async () => {
    storage.setItem(`nostr_inbox_${ACCOUNT}`, JSON.stringify([{
      id: "legacy", pubkey: OTHER, created_at: 4, content: "old", protocol: "nip17", transportKind: 1059
    }]));
    storage.setItem(`nostr_inbox_${OTHER}`, JSON.stringify([{ id: "private-other" }]));
    const messages = useMessagesStore();
    await messages.load(ACCOUNT);
    expect(mocks.insert).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ id: "legacy" }));
    expect(storage.getItem(`nostr_inbox_${ACCOUNT}`)).toBeNull();
    expect(storage.getItem(`nostr_inbox_${OTHER}`)).not.toBeNull();
  });
});
