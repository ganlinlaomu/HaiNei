// Messages.vue's in-chat search and burn-after-reading logic moved into
// composables; these pin their behavior independent of the view.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { DISAPPEARING_DM_TYPE } from "@/nostr/messaging/disappearingMessages";

const repo = vi.hoisted(() => ({ openDisappearingMessage: vi.fn() }));
vi.mock("@/repositories/syncedMessageRepository", () => ({ syncedMessageRepository: repo }));

import { useDmSearch } from "@/composables/useDmSearch";
import { useBurnMessages } from "@/composables/useBurnMessages";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const result = (id: string, createdAt: number) => ({ id, createdAt, preview: id }) as any;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("useDmSearch", () => {
  it("debounces, merges streamed batches newest first, then settles on the final list", async () => {
    const search = vi.fn(async (_peer: string, _query: string, { onBatch }: any) => {
      onBatch([result("old", 1)], { complete: false });
      onBatch([result("new", 5), result("old", 1)], { complete: false });
      return [result("new", 5), result("old", 1), result("oldest", 0)];
    });
    const s = useDmSearch({ account: () => ACCOUNT, peer: () => PEER, search });
    s.searchQuery.value = " 咖啡 ";
    s.scheduleSearch();
    expect(s.searching.value).toBe(true);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180);
    expect(search).toHaveBeenCalledWith(PEER, "咖啡", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(s.searchResults.value.map(r => r.id)).toEqual(["new", "old", "oldest"]);
    expect(s.searching.value).toBe(false);
    expect(s.searchComplete.value).toBe(true);
    expect(s.searchStatusText.value).toBe("3 条 · 已完成");
  });

  it("discards results from a superseded query or another peer, and aborts the old request", async () => {
    const peer = ref(PEER);
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const search = vi.fn((_p: string, query: string, { signal }: any) => {
      signals.push(signal);
      return new Promise<any[]>(resolve => { release = () => resolve([result(query, 1)]); });
    });
    const s = useDmSearch({ account: () => ACCOUNT, peer: () => peer.value, search });
    s.searchQuery.value = "first";
    s.scheduleSearch();
    await vi.advanceTimersByTimeAsync(180);
    s.searchQuery.value = "second";
    s.scheduleSearch();
    expect(signals[0].aborted).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.searchResults.value).toEqual([]);

    await vi.advanceTimersByTimeAsync(180);
    peer.value = "c".repeat(64);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.searchResults.value).toEqual([]);
  });

  it("pages rendering, drops hidden results and resets on close", async () => {
    const many = Array.from({ length: 130 }, (_, i) => result(`m${i}`, 1000 - i));
    const s = useDmSearch({ account: () => ACCOUNT, peer: () => PEER, search: async () => many });
    s.searchOpen.value = true;
    s.searchQuery.value = "x";
    s.scheduleSearch();
    await vi.advanceTimersByTimeAsync(180);
    expect(s.visibleSearchResults.value).toHaveLength(60);
    expect(s.hiddenSearchResultCount.value).toBe(70);
    s.showMoreSearchResults();
    expect(s.visibleSearchResults.value).toHaveLength(120);
    s.dropSearchResults(r => r.id === "m0");
    expect(s.searchResults.value.some(r => r.id === "m0")).toBe(false);
    s.resetSearch();
    expect([s.searchOpen.value, s.searchQuery.value, s.searchResults.value.length]).toEqual([false, "", 0]);
  });
});

describe("useBurnMessages", () => {
  const burnTags = (expiresAt: number) => [["t", DISAPPEARING_DM_TYPE], ["burn-after", "10"], ["expiration", String(expiresAt)]];
  const id = (n: number) => String(n).repeat(64).slice(0, 64);

  function setup(messages: any[]) {
    const directMessages = {
      burnedById: {} as Record<string, { peerPubkey: string }>,
      readReceiptsHiddenReason: vi.fn(() => null),
      outgoingReceiptStatus: vi.fn(() => "sent"),
      acknowledgeOpenedDisappearing: vi.fn(async () => {}),
      scheduleOpenedBurn: vi.fn(),
      burnDisappearingMessage: vi.fn(async (_peer: string, messageId: string) => {
        directMessages.burnedById[messageId] = { peerPubkey: PEER };
        return true;
      }),
    };
    const notify = vi.fn();
    const burn = useBurnMessages({
      account: () => ACCOUNT, peer: () => PEER, accepted: () => true,
      messages: () => messages, isOwn: m => m.pubkey === ACCOUNT, isDisposed: () => false,
      directMessages: directMessages as any, notify,
    });
    return { burn, directMessages, notify };
  }

  it("reveals a received temporary message, counts down, then burns it at the deadline", async () => {
    const now = Date.now();
    const message = { id: id(1), pubkey: PEER, tags: burnTags(Math.floor(now / 1000) + 48 * 3600) };
    const { burn, directMessages } = setup([message]);
    repo.openDisappearingMessage.mockResolvedValue(now + 10_000);

    expect(burn.canShowTemporaryText(message as any)).toBe(false);
    await burn.revealDisappearing(message as any);
    expect(directMessages.acknowledgeOpenedDisappearing).toHaveBeenCalledWith(PEER, message, now + 10_000);
    expect(directMessages.scheduleOpenedBurn).toHaveBeenCalledWith(PEER, message.id, now + 10_000);
    expect(burn.canShowTemporaryText(message as any)).toBe(true);
    expect(burn.burnDuration(message as any)).toBe(10);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(directMessages.burnDisappearingMessage).toHaveBeenCalledWith(PEER, message.id);
    expect(burn.isBurned(message as any)).toBe(true);
    expect(burn.openedDeadlines.value[message.id]).toBeUndefined();
    burn.stopBurnClock();
  });

  it("never reveals our own message and reports a message that can no longer be opened", async () => {
    const now = Date.now();
    const own = { id: id(2), pubkey: ACCOUNT, tags: burnTags(Math.floor(now / 1000) + 3600) };
    const received = { id: id(3), pubkey: PEER, tags: burnTags(Math.floor(now / 1000) + 3600) };
    const { burn, notify } = setup([own, received]);
    await burn.revealDisappearing(own as any);
    expect(repo.openDisappearingMessage).not.toHaveBeenCalled();
    repo.openDisappearingMessage.mockResolvedValue(null);
    await burn.revealDisappearing(received as any);
    expect(notify).toHaveBeenCalledWith("临时消息已不可查看", 1800, "info");
    expect(burn.openingMessageId.value).toBe("");
  });

  it("restores opened deadlines after a load and burns the ones already due", async () => {
    const now = Date.now();
    const due = { id: id(4), pubkey: PEER, tags: burnTags(Math.floor(now / 1000) + 3600) };
    const later = { id: id(5), pubkey: PEER, tags: burnTags(Math.floor(now / 1000) + 3600) };
    const { burn, directMessages } = setup([due, later]);
    burn.restoreOpenedDeadlines([{ messageId: due.id, deadlineAt: now - 1 }, { messageId: later.id, deadlineAt: now + 60_000 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(directMessages.burnDisappearingMessage).toHaveBeenCalledTimes(1);
    expect(directMessages.burnDisappearingMessage).toHaveBeenCalledWith(PEER, due.id);
    expect(burn.canShowTemporaryText(later as any)).toBe(true);
    burn.stopBurnClock();
  });
});
