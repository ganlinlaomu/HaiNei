import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import { encodeTombstone, HAI_NEI_TOMBSTONE_TAGS } from "@/nostr/messaging/feedControl";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

const ACCOUNT = "a".repeat(64);
const FRIEND = "b".repeat(64);
const OTHER = "c".repeat(64);
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  key: {
    pkHex: "a".repeat(64), supportsNip44: true,
    nip44Encrypt: vi.fn(), signEvent: vi.fn()
  }
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: mocks.send }));

import { useFeedPreferencesStore } from "@/stores/feedPreferences";

function tombstone(sender = FRIEND): CanonicalMessage {
  return {
    id: "tombstone", senderPubkey: sender, recipientPubkeys: [ACCOUNT],
    plaintext: encodeTombstone("post-1"), createdAt: 1,
    protocol: "nip17", transportKind: 1059, tags: HAI_NEI_TOMBSTONE_TAGS
  };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  mocks.send.mockReset().mockResolvedValue({ message: { id: "control" }, events: [], relayResults: [] });
  await db.accountMeta.clear();
});

describe("feed controls", () => {
  it("increments a local revision for every loaded or changed feed preference", async () => {
    const store = useFeedPreferencesStore();
    const initialRevision = store.revision;
    await store.load(ACCOUNT);
    expect(store.revision).toBeGreaterThan(initialRevision);
    const loadedRevision = store.revision;
    await store.hide("post-r");
    expect(store.revision).toBeGreaterThan(loadedRevision);
    const hiddenRevision = store.revision;
    await store.mute(FRIEND);
    expect(store.revision).toBeGreaterThan(hiddenRevision);
    const mutedRevision = store.revision;
    await store.unmute(FRIEND);
    expect(store.revision).toBeGreaterThan(mutedRevision);
  });

  it("hides an own post before sending its private tombstone", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    await store.tombstoneOwn({ id: "post-1", pubkey: ACCOUNT, recipientPubkeys: [FRIEND] });
    expect(store.isHidden("post-1")).toBe(true);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ tags: HAI_NEI_TOMBSTONE_TAGS }));
  });

  it("accepts an author's tombstone, hides the post, and creates no Home item or notification", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    const mirror = vi.fn();
    const notify = vi.fn();
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT, currentAccount: () => ACCOUNT,
      processFeedControlMessage: message => store.processTombstone(message, pk => pk === FRIEND, () => FRIEND),
      notifyFriendshipMessage: notify, isInteraction: () => false,
      processInteraction: () => {}, mirrorMessage: mirror
    });
    expect(await handler(tombstone(), { source: "realtime" })).toBe(false);
    expect(store.isHidden("post-1")).toBe(true);
    expect(mirror).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps hidden posts and mutes local and account scoped", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    await store.hide("post-a");
    await store.mute(FRIEND);
    expect(store.isVisible({ id: "post-a", pubkey: OTHER })).toBe(false);
    expect(store.isVisible({ id: "post-b", pubkey: FRIEND })).toBe(false);
    store.reset();
    await store.load(OTHER);
    expect(store.isHidden("post-a")).toBe(false);
    expect(store.isMuted(FRIEND)).toBe(false);
    store.reset();
    await store.load(ACCOUNT);
    expect(store.isHidden("post-a")).toBe(true);
    expect(store.isMuted(FRIEND)).toBe(true);
  });
});
