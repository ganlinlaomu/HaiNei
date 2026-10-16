import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { computed, isReactive } from "vue";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: "a".repeat(64) }) }));
vi.mock("@/services/directMessageStateEvents", () => ({ notifyCanonicalMessageAdded: vi.fn() }));

import { useMessagesStore } from "@/stores/messages";
import { useDebugLogsStore } from "@/stores/debugLogs";
import { notifyCanonicalMessageAdded } from "@/services/directMessageStateEvents";

function dm(index: number): InboxItem {
  return {
    id: index.toString(16).padStart(64, "0"), pubkey: PEER, recipientPubkeys: [ACCOUNT],
    created_at: 1_000_000 + index, content: `m${index}`, conversationId: `conversation:${PEER}`,
    protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]],
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(notifyCanonicalMessageAdded).mockClear();
});

describe("inbox mutation log", () => {
  it("replays every insert that landed between two watcher runs", () => {
    const store = useMessagesStore();
    store.loadedFor = ACCOUNT;
    const seen = store.inboxRevision;
    store.addInbox(dm(1));
    store.addInbox(dm(2));
    store.addInbox(dm(3));
    const mutations = store.inboxMutationsSince(seen);
    expect(mutations?.map(mutation => [mutation.type, mutation.itemId])).toEqual([
      ["insert", dm(1).id], ["insert", dm(2).id], ["insert", dm(3).id],
    ]);
    expect(store.inboxMutationsSince(store.inboxRevision)).toEqual([]);
  });

  it("reports a gap instead of a partial list once old mutations were dropped", () => {
    const store = useMessagesStore();
    store.loadedFor = ACCOUNT;
    const seen = store.inboxRevision;
    for (let index = 0; index < 80; index++) store.addInbox(dm(index));
    expect(store.inboxMutationsSince(seen)).toBeNull();
    expect(store.inboxMutationsSince(store.inboxRevision - 5)).toHaveLength(5);
  });

  it("still deduplicates after the inbox array is replaced from outside", () => {
    const store = useMessagesStore();
    store.loadedFor = ACCOUNT;
    store.addInbox(dm(1));
    store.inbox = [dm(2), dm(1)].sort((a, b) => b.created_at - a.created_at);
    store.addInbox(dm(2));
    store.addInbox(dm(1));
    store.addInbox(dm(3));
    expect(store.inbox.map(item => item.content)).toEqual(["m3", "m2", "m1"]);
    expect(notifyCanonicalMessageAdded).toHaveBeenCalledTimes(2);
  });

  it("can re-add a message after it was removed", () => {
    const store = useMessagesStore();
    store.loadedFor = ACCOUNT;
    store.addInbox(dm(1));
    store.removeInboxMessage(dm(1).id);
    store.addInbox(dm(1));
    expect(store.inbox.map(item => item.content)).toEqual(["m1"]);
  });

  it("forgets evicted ids so an evicted message can be inserted again", () => {
    const store = useMessagesStore();
    store.loadedFor = ACCOUNT;
    store.inbox = Array.from({ length: 1000 }, (_, index) => dm(1001 - index));
    store.addInbox(dm(1));
    expect(store.inbox).toHaveLength(1000);
    expect(store.inbox.some(item => item.id === dm(1).id)).toBe(false);
    store.inbox = store.inbox.slice(0, 999);
    store.addInbox(dm(1));
    expect(store.inbox.at(-1)?.id).toBe(dm(1).id);
  });

  it("Home and the open chat consume the log instead of only the last mutation", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(home).toContain("msgs.inboxMutationsSince(visibleInboxMessageRevision)");
    expect(chat).toContain("messageStore.inboxMutationsSince(since)");
    expect(chat).toContain("for (const mutation of mutations) applyInboxMutation(mutation);");
  });
});

describe("debug log buffer", () => {
  it("keeps entries out of deep reactivity but still notifies readers", () => {
    const logs = useDebugLogsStore();
    const count = computed(() => logs.entries.length);
    expect(count.value).toBe(0);
    logs.add({ category: "relay", event: "frame", level: "debug", data: { relay: "wss://x" } });
    expect(count.value).toBe(1);
    expect(isReactive(logs.entries[0])).toBe(false);
  });

  it("trims in chunks while always exposing at most 1000 entries", () => {
    const logs = useDebugLogsStore();
    for (let index = 0; index < 1450; index++) logs.add({ category: "relay", event: `e${index}`, level: "debug" });
    expect(logs.entries).toHaveLength(1000);
    expect(logs.entries[0].event).toBe("e450");
    expect(logs.entries.at(-1)?.event).toBe("e1449");
  });
});

describe("chat scroll handling", () => {
  it("coalesces scroll events per frame and skips repeated reads of the same message", () => {
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain("messageScrollFrame = requestAnimationFrame(");
    expect(chat).toContain("if (key === markedReadKey) return Promise.resolve();");
    expect(chat).toContain("if (messageScrollFrame !== null) cancelAnimationFrame(messageScrollFrame);");
  });
});
