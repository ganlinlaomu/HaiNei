import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  getPublicKey,
  nip17,
  nip44,
  nip59,
  utils,
  type EventTemplate
} from "nostr-tools";
import {
  decodeMessageEvent,
  decryptDirectMessage,
  encryptDirectMessage,
  nip17Adapter
} from "@/nostr/messaging/protocol";
import { MessageDeduplicator } from "@/nostr/messaging/deduplication";
import { buildMessageSubscriptions } from "@/nostr/messaging/subscriptions";

const senderSecret = utils.hexToBytes("1".padStart(64, "0"));
const recipientSecret = utils.hexToBytes("2".padStart(64, "0"));
const wrongSecret = utils.hexToBytes("3".padStart(64, "0"));
const senderPubkey = getPublicKey(senderSecret);
const recipientPubkey = getPublicKey(recipientSecret);
const wrongPubkey = getPublicKey(wrongSecret);

const senderContext = {
  senderPubkey,
  nip44Encrypt: (pubkey: string, plaintext: string) => encryptDirectMessage({ senderPrivateKey: senderSecret, recipientPubkey: pubkey, plaintext }),
  signEvent: (event: EventTemplate) => Promise.resolve(finalizeEvent(event, senderSecret))
};

function recipientDecodeContext(secret = recipientSecret, account = recipientPubkey) {
  return {
    accountPubkey: account,
    nip44Decrypt: (pubkey: string, ciphertext: string) => decryptDirectMessage({ recipientPrivateKey: secret, senderPubkey: pubkey, ciphertext })
  };
}

describe("NIP-44 v2 primitive", () => {
  it("matches the official NIP-44 vector and round trips", async () => {
    const conversationKey = nip44.v2.utils.getConversationKey(senderSecret, recipientPubkey);
    expect(utils.bytesToHex(conversationKey)).toBe("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    const nonce = utils.hexToBytes("1".padStart(64, "0"));
    expect(nip44.v2.encrypt("a", conversationKey, nonce)).toBe("AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb");
    const encrypted = await encryptDirectMessage({ senderPrivateKey: senderSecret, recipientPubkey, plaintext: "hello" });
    await expect(decryptDirectMessage({ recipientPrivateKey: recipientSecret, senderPubkey, ciphertext: encrypted })).resolves.toBe("hello");
    await expect(decryptDirectMessage({ recipientPrivateKey: wrongSecret, senderPubkey, ciphertext: encrypted })).rejects.toThrow();
    await expect(decryptDirectMessage({ recipientPrivateKey: recipientSecret, senderPubkey, ciphertext: "broken" })).rejects.toThrow();
  });
});

describe("NIP-17 gift wrap", () => {
  it("builds, unwraps, validates and deduplicates a standard message", async () => {
    const encoded = await nip17Adapter.encode!({
      recipientPubkeys: [recipientPubkey],
      plaintext: "private hello",
      replyTo: "a".repeat(64),
      tags: [["l", "hainei-interaction"], ["p", wrongPubkey]]
    }, senderContext);
    const recipientWrap = encoded.events.find(event => event.tags[0]?.[1] === recipientPubkey)!;
    const decoded = await decodeMessageEvent(recipientWrap, recipientDecodeContext());
    const standardClientRumor = nip17.unwrapEvent(recipientWrap, recipientSecret);
    expect(recipientWrap.kind).toBe(1059);
    expect(standardClientRumor).toMatchObject({ kind: 14, id: encoded.message.id, content: "private hello" });
    expect(decoded).toMatchObject({ id: encoded.message.id, rumorId: encoded.message.id, plaintext: "private hello", senderPubkey, protocol: "nip17" });
    expect(decoded?.tags).toContainEqual(["l", "hainei-interaction"]);
    expect(decoded?.tags).not.toContainEqual(["p", wrongPubkey]);
    expect(decoded?.transportEventId).toBe(recipientWrap.id);
    const dedupe = new MessageDeduplicator();
    expect(dedupe.accept(decoded!)).toBe(true);
    expect(dedupe.accept({ ...decoded!, transportEventId: "f".repeat(64) })).toBe(false);
  });

  it("decodes an event produced by the official nostr-tools NIP-17 implementation", async () => {
    const external = nip17.wrapEvent(senderSecret, { publicKey: recipientPubkey }, "sdk fixture");
    const decoded = await decodeMessageEvent(external, recipientDecodeContext());
    expect(decoded?.plaintext).toBe("sdk fixture");
    expect(decoded?.senderPubkey).toBe(senderPubkey);
  });

  it("rejects wrong recipients, malformed seals and malformed rumors", async () => {
    const valid = await nip17Adapter.encode!({ recipientPubkeys: [recipientPubkey], plaintext: "private" }, senderContext);
    const wrap = valid.events.find(event => event.tags[0]?.[1] === recipientPubkey)!;
    await expect(decodeMessageEvent(wrap, recipientDecodeContext(wrongSecret, wrongPubkey))).resolves.toBeNull();
    await expect(decodeMessageEvent({ ...wrap, sig: "0".repeat(128) }, recipientDecodeContext())).resolves.toBeNull();

    const malformedSeal = nip59.createWrap({ broken: true } as any, recipientPubkey);
    await expect(decodeMessageEvent(malformedSeal, recipientDecodeContext())).resolves.toBeNull();

    const badRumorCiphertext = await encryptDirectMessage({ senderPrivateKey: senderSecret, recipientPubkey, plaintext: JSON.stringify({ kind: 14, broken: true }) });
    const seal = finalizeEvent({ kind: 13, created_at: 1, tags: [], content: badRumorCiphertext }, senderSecret);
    const malformedRumor = nip59.createWrap(seal, recipientPubkey);
    await expect(decodeMessageEvent(malformedRumor, recipientDecodeContext())).resolves.toBeNull();
    const unknown = finalizeEvent({ kind: 9999, created_at: 1, tags: [], content: "unknown" }, senderSecret);
    await expect(decodeMessageEvent(unknown, recipientDecodeContext())).resolves.toBeNull();
  });

  it("subscribes only to private NIP-17 gift wraps", () => {
    const filters = buildMessageSubscriptions(recipientPubkey, [senderPubkey], 10);
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({ kinds: [1059], "#p": [recipientPubkey] });
    expect(filters.find(filter => filter.kinds.includes(1059))?.since).toBe(0);
  });

  it("does not decode removed custom message or interaction kinds", async () => {
    for (const kind of [8964, 8965]) {
      const event = finalizeEvent({ kind, created_at: 1, tags: [["p", recipientPubkey]], content: "removed" }, senderSecret);
      await expect(decodeMessageEvent(event, recipientDecodeContext())).resolves.toBeNull();
    }
  });
});
