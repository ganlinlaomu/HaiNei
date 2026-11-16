import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const mocks = vi.hoisted(() => ({ feed: vi.fn(), full: vi.fn(), outgoing: vi.fn(), purge: vi.fn() }));
vi.mock("@/repositories/syncedMessageRepository", () => ({
  syncedMessageRepository: {
    listRecentFeed: mocks.feed, listRecent: mocks.full,
    insertMessageIfAbsent: vi.fn(), purgeExpiredDisappearing: mocks.purge,
  },
}));
vi.mock("@/repositories/outgoingQueueRepository", () => ({ outgoingQueueRepository: { list: mocks.outgoing } }));

import { useMessagesStore } from "@/stores/messages";

const record = (id: string, createdAt: number, tags: string[][] = [["t", "hainei-post"]]) => ({
  accountPubkey: ACCOUNT, id, senderPubkey: OTHER, recipientPubkeys: [ACCOUNT], conversationId: id,
  plaintext: id, createdAt, protocol: "nip17", transportKind: 1059, transportEventIds: [`wrap-${id}`],
  firstSeenAt: 1, lastSeenAt: 1, tags,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0, clear() {} });
  mocks.feed.mockReset().mockResolvedValue([record("post-new", 30)]);
  mocks.full.mockReset().mockResolvedValue([record("post-new", 30), record("post-old", 10), record("dm-head", 20, [["t", "hainei-dm"]])]);
  mocks.outgoing.mockReset().mockResolvedValue([]);
  mocks.purge.mockReset().mockResolvedValue(0);
});

describe("cold-start inbox first page", () => {
  it("returns after the newest Feed records, then fills the full window in the background", async () => {
    const messages = useMessagesStore();
    await messages.load(ACCOUNT);
    expect(mocks.feed).toHaveBeenCalledWith(ACCOUNT, 60);
    expect(mocks.full).not.toHaveBeenCalled();
    expect(messages.inboxPartial).toBe(true);
    expect(messages.inbox.map(item => item.id)).toEqual(["post-new"]);
    // Nothing that decrypts the whole history runs before Home's first page.
    expect(mocks.purge).not.toHaveBeenCalled();

    await messages.whenInboxComplete(ACCOUNT);
    expect(messages.inboxPartial).toBe(false);
    expect(messages.inbox.map(item => item.id)).toEqual(["post-new", "dm-head", "post-old"]);
  });

  it("keeps messages that arrived while only the first page was loaded", async () => {
    const messages = useMessagesStore();
    await messages.load(ACCOUNT);
    messages.addInbox({ id: "live", pubkey: OTHER, created_at: 40, content: "live", tags: [["t", "hainei-post"]] });
    await messages.whenInboxComplete(ACCOUNT);
    expect(messages.inbox.map(item => item.id)).toEqual(["live", "post-new", "dm-head", "post-old"]);
  });

  it("reads the full window itself if the background read failed", async () => {
    mocks.full.mockRejectedValueOnce(new Error("busy"));
    const messages = useMessagesStore();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await messages.load(ACCOUNT);
    await messages.whenInboxComplete(ACCOUNT);
    expect(mocks.full).toHaveBeenCalledTimes(2);
    expect(messages.inboxPartial).toBe(false);
  });

  it("the conversation list waits for the full window; Home only fills a short first page", () => {
    expect(readFileSync("src/stores/directMessages.ts", "utf8")).toContain("messages.whenInboxComplete(account)");
    const home = readFileSync("src/views/Home.vue", "utf8");
    expect(home).toContain("watch(() => msgs.inboxPartial");
    expect(home).toContain("if (displayedMessages.value.length >= PAGE_SIZE) return;");
  });
});
