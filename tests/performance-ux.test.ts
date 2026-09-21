import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { friendshipTags } from "@/nostr/messaging/friendshipControl";
import { createHomeMessageHandler, incomingFriendRequestNotification } from "@/nostr/messaging/homeDelivery";
import { useNotificationsStore } from "@/stores/notifications";
import { decodeEncryptedImageRef, encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { clearPostDraft, loadPostDraft, savePostDraft } from "@/utils/postDraft";
import { loadHomeScroll, saveHomeScroll } from "@/utils/homeScroll";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); }, setItem: (key, value) => values.set(key, String(value)),
  };
}

function requestMessage(sender = PEER, id = "request-event"): CanonicalMessage {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    id, senderPubkey: sender, recipientPubkeys: [ACCOUNT], conversationId: "control",
    plaintext: JSON.stringify({ type: "friend_request", from: sender, timestamp }), createdAt: timestamp,
    protocol: "nip17", transportKind: 1059, transportEventId: `${id}-wrap`, rumorId: id,
    tags: friendshipTags("request"),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: storage(), configurable: true });
});

describe("friend request notifications", () => {
  it("creates one incoming notification, deduplicates replay, and ignores outgoing requests", async () => {
    const notifications = useNotificationsStore();
    await notifications.load(ACCOUNT);
    const incoming = incomingFriendRequestNotification(requestMessage(), ACCOUNT);
    expect(incoming).not.toBeNull();
    notifications.addNotification(incoming!);
    notifications.addNotification(incoming!);
    expect(notifications.list).toHaveLength(1);
    expect(notifications.unreadCount).toBe(1);
    expect(incomingFriendRequestNotification(requestMessage(ACCOUNT, "outgoing"), ACCOUNT)).toBeNull();
  });

  it("does not create a notification for an accepted friend's normal post", async () => {
    const notify = vi.fn();
    const mirror = vi.fn();
    const handler = createHomeMessageHandler({
      accountPubkey: ACCOUNT, currentAccount: () => ACCOUNT, isAcceptedMessage: () => true,
      processFriendshipMessage: () => false, notifyFriendshipMessage: notify,
      isInteraction: () => false, processInteraction: () => undefined, mirrorMessage: mirror,
    });
    const post: CanonicalMessage = {
      ...requestMessage(), id: "post", plaintext: "普通动态", tags: [], conversationId: "feed",
    };
    await handler(post, { source: "relay", relay: "wss://relay.test" });
    expect(mirror).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("encrypted image metadata", () => {
  const variant = { url: "https://media.test/image.enc", mime: "image/jpeg", alg: "AES-GCM", iv: "aXY=", key: "a2V5" };
  it("keeps old single-reference posts compatible", () => {
    expect(decodeEncryptedImageRef(encodeEncryptedImageRef({ v: 1, ...variant })))
      .toMatchObject({ v: 1, url: variant.url });
  });
  it("parses preview/original metadata and dimensions", () => {
    const decoded = decodeEncryptedImageRef(encodeEncryptedImageRef({
      v: 2, ...variant, width: 2400, height: 1600,
      preview: { ...variant, url: "https://media.test/preview.enc", width: 960, height: 640 },
    }));
    expect(decoded?.preview).toMatchObject({ url: "https://media.test/preview.enc", width: 960, height: 640 });
  });
});

describe("account-scoped local UX state", () => {
  it("isolates composer drafts and clears only the selected account", () => {
    savePostDraft(ACCOUNT, { content: "account a", allFriends: false, selectedGroups: ["家人"] });
    savePostDraft(PEER, { content: "account b", allFriends: true, selectedGroups: [] });
    expect(loadPostDraft(ACCOUNT)?.content).toBe("account a");
    expect(loadPostDraft(PEER)?.content).toBe("account b");
    clearPostDraft(ACCOUNT);
    expect(loadPostDraft(ACCOUNT)).toBeNull();
    expect(loadPostDraft(PEER)?.content).toBe("account b");
  });
  it("restores the custom Home container offset per account", () => {
    saveHomeScroll(ACCOUNT, 1234.4);
    saveHomeScroll(PEER, 88);
    expect(loadHomeScroll(ACCOUNT)).toBe(1234);
    expect(loadHomeScroll(PEER)).toBe(88);
  });
});
