import "fake-indexeddb/auto";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@/stores/messages";
import { forgetChatHistory, joinChatHistory, recallChatHistory, rememberChatHistory, useDirectMessagesStore } from "@/stores/directMessages";
import { useKeyStore } from "@/stores/keys";

const ME = "a".repeat(64);
const peer = (n: number) => String(n).repeat(64).slice(0, 64);
const item = (n: number) => ({ id: n.toString(16).padStart(64, "0"), pubkey: ME, created_at: 1_000 + n, content: `m${n}`, tags: [] }) as unknown as InboxItem;
const items = (count: number) => Array.from({ length: count }, (_, i) => item(i));

describe("remembered chat history", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useDirectMessagesStore().reset();
  });

  it("returns what a chat had read, for that account and peer only", () => {
    rememberChatHistory(ME, peer(1), { items: items(3), cursor: { createdAt: 1_000, id: item(0).id }, exhausted: false });
    expect(recallChatHistory(ME, peer(1))?.items).toHaveLength(3);
    expect(recallChatHistory("b".repeat(64), peer(1))).toBeUndefined();
    expect(recallChatHistory(ME, peer(2))).toBeUndefined();
  });

  it("keeps only the three most recent chats", () => {
    for (const n of [1, 2, 3, 4]) rememberChatHistory(ME, peer(n), { items: items(1), exhausted: true });
    expect(recallChatHistory(ME, peer(1))).toBeUndefined();
    expect([2, 3, 4].every(n => recallChatHistory(ME, peer(n)))).toBe(true);
  });

  it("caps a long chat at its newest 2000 rows and resumes reading before them", () => {
    rememberChatHistory(ME, peer(1), { items: items(2_500), exhausted: true });
    const memory = recallChatHistory(ME, peer(1))!;
    expect(memory.items).toHaveLength(2_000);
    expect(memory.items[0].id).toBe(item(500).id);
    expect(memory.cursor).toEqual({ createdAt: item(500).created_at, id: item(500).id });
    expect(memory.exhausted).toBe(false);
  });

  it("is cleared by a store reset (account switch, lock)", () => {
    rememberChatHistory(ME, peer(1), { items: items(2), exhausted: true });
    useDirectMessagesStore().reset();
    expect(recallChatHistory(ME, peer(1))).toBeUndefined();
  });

  it("is dropped when the conversation is deleted or hidden", async () => {
    const direct = useDirectMessagesStore();
    useKeyStore().pkHex = ME;
    direct.loadedFor = ME;
    vi.spyOn(direct, "markPeerReadInternal" as never).mockResolvedValue(undefined as never);
    rememberChatHistory(ME, peer(1), { items: items(2), exhausted: true });
    rememberChatHistory(ME, peer(2), { items: items(2), exhausted: true });
    await direct.hideConversation(peer(1)).catch(() => undefined);
    await direct.deleteConversation(peer(2)).catch(() => undefined);
    expect(recallChatHistory(ME, peer(1))).toBeUndefined();
    expect(recallChatHistory(ME, peer(2))).toBeUndefined();
    forgetChatHistory(ME, peer(3));
  });
});

describe("joining remembered history to a fresh first page", () => {
  const cursorOf = (n: number) => ({ createdAt: item(n).created_at, id: item(n).id });
  // Remembered: rows 100..399, could read further back from row 100.
  const remembered = { items: Array.from({ length: 300 }, (_, i) => item(100 + i)), cursor: cursorOf(100), exhausted: false };

  it("joins when the fresh page reaches back into the remembered rows", () => {
    // Fresh page: rows 350..409 (some new rows arrived meanwhile).
    const fresh = { items: Array.from({ length: 60 }, (_, i) => item(350 + i)), cursor: cursorOf(350), exhausted: false };
    const joined = joinChatHistory(remembered, fresh)!;
    expect(joined.items.map(row => row.created_at)).toEqual(Array.from({ length: 310 }, (_, i) => 1_100 + i));
    expect(joined.cursor).toEqual(cursorOf(100));
    expect(joined.exhausted).toBe(false);
  });

  it("does not join across a gap (more arrived than one page holds)", () => {
    // Fresh page starts at row 450; rows 400..449 were never read.
    const fresh = { items: Array.from({ length: 50 }, (_, i) => item(450 + i)), cursor: cursorOf(450), exhausted: false };
    expect(joinChatHistory(remembered, fresh)).toBeNull();
  });

  it("does nothing when the fresh page already holds the whole chat, or nothing was remembered", () => {
    const whole = { items: [item(1)], cursor: cursorOf(1), exhausted: true };
    expect(joinChatHistory(remembered, whole)).toBeNull();
    expect(joinChatHistory(undefined, { items: [item(1)], exhausted: false })).toBeNull();
  });

  it("prefers the fresh copy of a row seen in both", () => {
    const edited = { ...item(380), content: "updated" } as InboxItem;
    const fresh = { items: [edited, item(399)], cursor: cursorOf(380), exhausted: false };
    expect(joinChatHistory(remembered, fresh)!.items.find(row => row.id === edited.id)?.content).toBe("updated");
  });
});
