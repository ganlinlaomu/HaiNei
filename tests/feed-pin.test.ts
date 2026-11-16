import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { HAI_NEI_FEED_PIN_TYPE } from "@/nostr/messaging/feedControl";
import { classifyPrivateMessage } from "@/nostr/messaging/messageRouting";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

const ACCOUNT = "a".repeat(64);
const FRIEND = "b".repeat(64);
const POSTS = ["1", "2", "3", "4", "5", "6"].map(digit => digit.repeat(64));
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  sync: vi.fn(),
  key: { pkHex: "a".repeat(64), supportsNip44: true, nip44Encrypt: vi.fn(), signEvent: vi.fn() },
}));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: mocks.send }));
vi.mock("@/services/accountStateSync", () => ({ scheduleAccountStateSync: mocks.sync }));

import { MAX_HOME_PINS, useFeedPreferencesStore } from "@/stores/feedPreferences";

beforeEach(async () => {
  setActivePinia(createPinia());
  mocks.send.mockReset();
  mocks.sync.mockReset();
  await db.accountMeta.clear();
});

describe("Home pins", () => {
  it("pins any post personally, newest pin first, and never messages friends", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    await store.pin(POSTS[0]);
    await store.pin(POSTS[1]);
    expect(store.pinnedIds).toEqual([POSTS[1], POSTS[0]]);
    expect(store.isPinned(POSTS[0])).toBe(true);
    await store.unpin(POSTS[1]);
    expect(store.pinnedIds).toEqual([POSTS[0]]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledWith(mocks.key, "feed_preferences");
  });

  it(`allows at most ${MAX_HOME_PINS} pins`, async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    for (const id of POSTS.slice(0, MAX_HOME_PINS)) await store.pin(id);
    await expect(store.pin(POSTS[MAX_HOME_PINS])).rejects.toThrow(`最多置顶 ${MAX_HOME_PINS} 条动态`);
  });

  it("persists pins with the synced feed preferences, unpins as tombstones", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    await store.pin(POSTS[0]);
    await store.pin(POSTS[1]);
    await store.unpin(POSTS[0]);
    const stored = (await db.accountMeta.get([ACCOUNT, "feed_preferences_v2"]))?.value as any;
    expect(stored.pinned.map((item: any) => [item.id, item.deleted])).toEqual(expect.arrayContaining([[POSTS[0], true], [POSTS[1], false]]));

    setActivePinia(createPinia());
    const reloaded = useFeedPreferencesStore();
    await reloaded.load(ACCOUNT);
    expect(reloaded.pinnedIds).toEqual([POSTS[1]]);
  });

  it("still consumes retired 0.1.204 profile-pin controls without showing them", async () => {
    const message: CanonicalMessage = {
      id: "legacy-pin", senderPubkey: FRIEND, recipientPubkeys: [ACCOUNT],
      plaintext: JSON.stringify({ type: HAI_NEI_FEED_PIN_TYPE, version: 1, messageId: POSTS[0], pinnedAt: 1 }),
      createdAt: 1, protocol: "nip17", transportKind: 1059, tags: [["t", HAI_NEI_FEED_PIN_TYPE]],
    };
    expect(classifyPrivateMessage({ ...message, content: message.plaintext })).toBe("control");
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    expect(await store.processFeedControl(message, () => true, () => FRIEND)).toBe(false);
    expect(store.pinnedIds).toEqual([]);
  });

  it("shows pinned posts in their own Home section, excluded from the feed list", () => {
    const home = readFileSync("src/views/Home.vue", "utf8");
    expect(home).toContain('class="pinned-feed"');
    expect(home).toContain("!feedPreferences.isPinned(message.id)");
    const card = readFileSync("src/components/PostCard.vue", "utf8");
    expect(card).toContain('{{ pinnedOnHome ? "取消置顶" : "置顶" }}');
    expect(card).not.toContain("置顶到个人主页");
  });
});
