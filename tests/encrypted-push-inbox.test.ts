import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { sanitizeEncryptedPushHints } from "../worker/src/push";
import { isVerifiedPushGiftWrap, safePushRelays } from "@/services/encryptedPushInbox";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function giftWrap(recipient = ACCOUNT) {
  return finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipient]],
    content: "encrypted-nip44-gift-wrap",
  }, generateSecretKey());
}

describe("NIP-17 Push hints", () => {
  it("accepts only signed recipient-bound gift wraps", () => {
    const event = giftWrap();
    const hints = sanitizeEncryptedPushHints([
      { recipient: ACCOUNT, eventId: event.id, relays: ["wss://relay.test"], event },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.event).toEqual(event);
    expect(isVerifiedPushGiftWrap(event, ACCOUNT, event.id)).toBe(true);
    expect(isVerifiedPushGiftWrap(event, OTHER, event.id)).toBe(false);
    expect(isVerifiedPushGiftWrap({ ...event, content: "tampered" }, ACCOUNT, event.id)).toBe(false);
  });

  it("retains only an exact-ID route for an invalid signature or unrelated recipient", () => {
    const event = giftWrap();
    const hints = sanitizeEncryptedPushHints([
      { recipient: ACCOUNT, eventId: event.id, relays: ["wss://relay.test"], event: { ...event, content: "forged" } },
      { recipient: OTHER, eventId: event.id, relays: ["wss://relay.test"], event },
    ]);
    expect(hints).toHaveLength(2);
    expect(hints[0]?.event).toBeUndefined();
    expect(hints[1]?.event).toBeUndefined();
    expect(hints[0]?.eventId).toBe(event.id);
  });

  it("rejects invalid routing hints and caps the relay fanout", () => {
    const event = giftWrap();
    expect(sanitizeEncryptedPushHints([{ recipient: "wrong", eventId: event.id, relays: [] }])).toEqual([]);
    expect(safePushRelays(["http://bad.test", "ws://insecure.test", "wss://one.test", "wss://one.test", "wss://two.test", "wss://third.test"])).toEqual(["wss://one.test", "wss://two.test"]);
    expect(sanitizeEncryptedPushHints([
      { recipient: ACCOUNT, eventId: event.id, relays: ["wss://good.test", "https://bad.test"] },
    ])[0]?.relays).toEqual(["wss://good.test"]);
  });

  it("never includes plaintext in the worker hint contract", () => {
    const event = giftWrap();
    const hint = sanitizeEncryptedPushHints([
      { recipient: ACCOUNT, eventId: event.id, relays: ["wss://relay.test"], event, plaintext: "do not forward" },
    ])[0];
    expect(hint).not.toHaveProperty("plaintext");
    expect(JSON.stringify(hint)).not.toContain("do not forward");
  });
});
