import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { decodeFeedPin, encodeFeedPin, HAI_NEI_FEED_PIN_TAGS } from "@/nostr/messaging/feedControl";
import { classifyPrivateMessage } from "@/nostr/messaging/messageRouting";
import { createHomeMessageHandler } from "@/nostr/messaging/homeDelivery";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

const ACCOUNT = "a".repeat(64);
const FRIEND = "b".repeat(64);
const STRANGER = "c".repeat(64);
const POST = "d".repeat(64);
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  key: { pkHex: "a".repeat(64), supportsNip44: true, nip44Encrypt: vi.fn(), signEvent: vi.fn() },
}));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: mocks.send }));

import { useFeedPreferencesStore } from "@/stores/feedPreferences";

function pinMessage(sender: string, messageId: string | null, pinnedAt: number): CanonicalMessage {
  return {
    id: `pin-${pinnedAt}`, senderPubkey: sender, recipientPubkeys: [ACCOUNT],
    plaintext: encodeFeedPin({ messageId, pinnedAt }), createdAt: 1,
    protocol: "nip17", transportKind: 1059, tags: HAI_NEI_FEED_PIN_TAGS,
  };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  mocks.send.mockReset().mockResolvedValue({ message: { id: "control" }, events: [], relayResults: [] });
  await db.accountMeta.clear();
});

describe("feed pins", () => {
  it("is a control message, never a feed post", () => {
    const message = pinMessage(FRIEND, POST, 10);
    expect(classifyPrivateMessage({ ...message, content: message.plaintext })).toBe("control");
    expect(decodeFeedPin(message)).toEqual({ messageId: POST, pinnedAt: 10 });
    expect(decodeFeedPin({ ...message, plaintext: encodeFeedPin({ messageId: "not-an-id", pinnedAt: 1 }) })).toBeNull();
  });

  it("keeps only the newest pin per accepted author and persists it", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    const accepted = (pubkey: string) => pubkey === FRIEND;
    expect(await store.processFeedControl(pinMessage(FRIEND, POST, 20), accepted, () => undefined)).toBe(true);
    expect(await store.processFeedControl(pinMessage(FRIEND, null, 10), accepted, () => undefined)).toBe(false);
    expect(await store.processFeedControl(pinMessage(STRANGER, POST, 30), accepted, () => undefined)).toBe(false);
    expect(store.pinnedPostOf(FRIEND)).toBe(POST);
    expect(store.pinnedPostOf(STRANGER)).toBeNull();
    await store.processFeedControl(pinMessage(FRIEND, null, 40), accepted, () => undefined);
    expect(store.pinnedPostOf(FRIEND)).toBeNull();

    setActivePinia(createPinia());
    const reloaded = useFeedPreferencesStore();
    await reloaded.load(ACCOUNT);
    expect(reloaded.pinsByAuthor[FRIEND]).toEqual({ messageId: null, pinnedAt: 40 });
  });

  it("pins an own post locally first, then tells every friend and the account itself", async () => {
    const store = useFeedPreferencesStore();
    await store.load(ACCOUNT);
    await store.pinOwn({ id: POST, pubkey: ACCOUNT }, [FRIEND]);
    expect(store.pinnedPostOf(ACCOUNT)).toBe(POST);
    const call = mocks.send.mock.calls[0][0];
    expect(call.recipientPubkeys.sort()).toEqual([ACCOUNT, FRIEND].sort());
    expect(call.tags).toEqual(HAI_NEI_FEED_PIN_TAGS);
    await expect(store.pinOwn({ id: POST, pubkey: FRIEND }, [FRIEND])).rejects.toThrow();
  });

  it("routes pins to the feed control handler", async () => {
    const processFeedControlMessage = vi.fn().mockResolvedValue(true);
    const mirror = vi.fn();
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT, currentAccount: () => ACCOUNT,
      processFeedControlMessage, isInteraction: () => false,
      processInteraction: () => {}, mirrorMessage: mirror,
    });
    expect(await handler(pinMessage(FRIEND, POST, 5), { source: "realtime" })).toBe(false);
    expect(mirror).not.toHaveBeenCalled();
    expect(processFeedControlMessage).toHaveBeenCalledTimes(1);
  });
});
