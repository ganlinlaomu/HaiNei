// Review finding #3: addInbox prepends regardless of created_at and evicts the
// tail, so historical catch-up pushes the newest messages out of memory.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64) }) }));
vi.mock("@/services/directMessageStateEvents", () => ({ notifyCanonicalMessageAdded: vi.fn() }));

import { useMessagesStore } from "@/stores/messages";
import { notifyCanonicalMessageAdded } from "@/services/directMessageStateEvents";

function dm(index: number): InboxItem {
  return {
    id: index.toString(16).padStart(64, "0"), pubkey: PEER, recipientPubkeys: [ACCOUNT],
    created_at: 1_000_000 + index, content: `m${index}`, conversationId: `conversation:${PEER}`,
    protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

function loaded(items: InboxItem[]) {
  const store = useMessagesStore();
  store.loadedFor = ACCOUNT;
  store.inbox = [...items].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(notifyCanonicalMessageAdded).mockClear();
});

describe("review #3: bounded in-memory inbox order", () => {
  it("keeps the inbox sorted newest-first when an older message arrives", () => {
    const store = loaded([dm(10), dm(20), dm(30)]);
    store.addInbox(dm(15));
    expect(store.inbox.map(item => item.content)).toEqual(["m30", "m20", "m15", "m10"]);
  });

  it("never evicts the newest messages while historical catch-up fills the window", () => {
    // New device: empty memory, Relay catch-up pages deliver newest-first.
    const store = loaded([]);
    for (let i = 1050; i >= 1; i--) store.addInbox(dm(i));

    expect(store.inbox.length).toBe(1000);
    const ids = new Set(store.inbox.map(item => item.content));
    expect(ids.has("m1050")).toBe(true);
    expect(ids.has("m51")).toBe(true);
    expect(ids.has("m50")).toBe(false);
    expect(store.inbox[0].content).toBe("m1050");
  });

  it("still notifies the DM store and reports the evicted id for a message outside the window", () => {
    const store = loaded(Array.from({ length: 1000 }, (_, i) => dm(1001 + i)));
    const old = dm(1);
    store.addInbox(old);
    expect(notifyCanonicalMessageAdded).toHaveBeenCalledWith(ACCOUNT, old);
    expect(store.lastInboxMutation).toMatchObject({ type: "insert", itemId: old.id, evictedId: old.id });
    expect(store.lastInboxMutation?.item).toEqual(old);
  });
});
