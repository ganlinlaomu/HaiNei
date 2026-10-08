import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, utils, type EventTemplate } from "nostr-tools";
import { HaiNeiDatabase } from "@/db/dexie";
import { nip17Adapter, encryptDirectMessage, decryptDirectMessage } from "@/nostr/messaging/protocol";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { burnControlTags, parseBurnControl, serializeBurnControl } from "@/nostr/messaging/dmBurnControl";
import { disappearingMetadata, isExpiredDisappearing } from "@/nostr/messaging/disappearingMessages";

const a = utils.hexToBytes("1".padStart(64, "0"));
const b = utils.hexToBytes("2".padStart(64, "0"));
const sender = getPublicKey(a);
const receiver = getPublicKey(b);
const context = {
  senderPubkey: sender,
  nip44Encrypt: (peer: string, plaintext: string) => encryptDirectMessage({ senderPrivateKey: a, recipientPubkey: peer, plaintext }),
  signEvent: (event: EventTemplate) => Promise.resolve(finalizeEvent(event, a)),
};
const decrypt = {
  accountPubkey: receiver,
  nip44Decrypt: (peer: string, ciphertext: string) => decryptDirectMessage({ recipientPrivateKey: b, senderPubkey: peer, ciphertext }),
};
let index = 0;
const opened: HaiNeiDatabase[] = [];
function repository() {
  const database = new HaiNeiDatabase(`temporary-dm-test-${index++}`);
  opened.push(database);
  return new SyncedMessageRepository(database);
}
afterEach(async () => {
  vi.useRealTimers();
  for (const database of opened.splice(0)) {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  }
});

describe("opt-in disappearing NIP-17", () => {
  it("does not change normal DMs or their seal tags", async () => {
    const regular = await nip17Adapter.encode!({ recipientPubkeys: [receiver], plaintext: "ordinary", tags: [["t", "hainei-dm"]] }, context);
    expect(regular.events.every(wrap => wrap.tags.every(tag => tag[0] !== "expiration"))).toBe(true);
    const wrap = regular.events.find(event => event.tags[0][1] === receiver)!;
    expect((await nip17Adapter.decode(wrap, decrypt))?.plaintext).toBe("ordinary");
  });

  it("expires receiver and sender gift wraps in 48 hours without changing the seal tags", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T01:00:00.000Z"));
    const encoded = await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "disappearing",
      tags: [["t", "hainei-dm"]], burnAfterSeconds: 10,
    }, context);
    expect(encoded.events).toHaveLength(2);
    const expiration = Math.floor(Date.now() / 1000) + 48 * 3600;
    for (const wrap of encoded.events) {
      expect(wrap.kind).toBe(1059);
      const outerExpiration = Number(wrap.tags.find(tag => tag[0] === "expiration")?.[1]);
      expect(outerExpiration).toBeGreaterThan(expiration - 900);
      expect(outerExpiration).toBeLessThanOrEqual(expiration);
    }
    expect(disappearingMetadata(encoded.message.tags)).toEqual({ expiresAt: expiration, burnAfterSeconds: 10 });
    const receiverWrap = encoded.events.find(event => event.tags[0][1] === receiver)!;
    const seal = JSON.parse(await decryptDirectMessage({
      recipientPrivateKey: b, senderPubkey: receiverWrap.pubkey, ciphertext: receiverWrap.content,
    }));
    expect(seal.tags).toEqual([]);
    expect((await nip17Adapter.decode(receiverWrap, decrypt))?.plaintext).toBe("disappearing");

    vi.setSystemTime(new Date((expiration + 1) * 1000));
    expect(isExpiredDisappearing(encoded.message.tags)).toBe(true);
    await expect(nip17Adapter.decode(receiverWrap, decrypt)).resolves.toBeNull();
  });

  it("rejects malformed or non-DM burn settings", async () => {
    await expect(nip17Adapter.encode!({ recipientPubkeys: [receiver], plaintext: "x", burnAfterSeconds: 10 }, context))
      .rejects.toThrow("disappearing_messages_require_single_direct_recipient");
    expect(disappearingMetadata([["t", "hainei-dm-disappearing"], ["burn-after", "10"]])).toBeNull();
    expect(isExpiredDisappearing([["t", "hainei-dm-disappearing"]])).toBe(true);
    const notice = serializeBurnControl("A".repeat(64));
    expect(parseBurnControl({ plaintext: notice, tags: burnControlTags() })).toBe("a".repeat(64));
    expect(parseBurnControl({ plaintext: notice, tags: [] })).toBeNull();
  });

  it("burn tombstones prevent replay, isolate accounts, and cannot burn normal DMs", async () => {
    const repo = repository();
    const ephemeral = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "sensitive text", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 30,
    }, context)).message;
    expect((await repo.insertMessageIfAbsent(receiver, ephemeral)).inserted).toBe(true);
    expect((await repo.get(receiver, ephemeral.id))?.plaintext).toBe("sensitive text");
    expect(await repo.burnDisappearingMessage(receiver, ephemeral.id, sender)).toBe(true);
    expect(await repo.get(receiver, ephemeral.id)).toBeUndefined();
    expect(await repo.isBurnedMessage(receiver, ephemeral)).toBe(true);
    expect((await repo.insertMessageIfAbsent(receiver, ephemeral)).inserted).toBe(false);
    expect(await repo.get(receiver, ephemeral.id)).toBeUndefined();
    // A burn in B's account must not remove A's encrypted sender copy.
    expect((await repo.insertMessageIfAbsent(sender, ephemeral)).inserted).toBe(true);

    const ordinary = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "keep", tags: [["t", "hainei-dm"]],
    }, context)).message;
    await repo.insertMessageIfAbsent(receiver, ordinary);
    expect(await repo.burnDisappearingMessage(receiver, ordinary.id, sender)).toBe(false);
    expect((await repo.get(receiver, ordinary.id))?.plaintext).toBe("keep");
  });

  it("starts countdown on explicit open, persists deadline and never resets it", async () => {
    const repo = repository();
    const temporary = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "private view", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 10,
    }, context)).message;
    const receivedAt = Date.now();
    await repo.insertMessageIfAbsent(receiver, temporary);
    expect(await repo.listOpenedDisappearing(receiver, sender)).toEqual([]);
    const deadline = await repo.openDisappearingMessage(receiver, temporary.id, sender, receivedAt);
    expect(deadline).toBe(receivedAt + 10_000);
    expect(await repo.openDisappearingMessage(receiver, temporary.id, sender, receivedAt + 5_000)).toBe(deadline);
    expect(await repo.listOpenedDisappearing(receiver, sender)).toContainEqual({
      messageId: temporary.id, peerPubkey: sender, deadlineAt: deadline,
    });
    expect(await repo.listOpenedDisappearing(sender, receiver)).toEqual([]);
    await repo.burnDisappearingMessage(receiver, temporary.id, sender, deadline!);
    expect(await repo.openDisappearingMessage(receiver, temporary.id, sender, deadline!)).toBeNull();
    expect(await repo.listOpenedDisappearing(receiver, sender)).toEqual([]);
    expect((await repo.insertMessageIfAbsent(receiver, temporary)).inserted).toBe(false);
  });

  it("refuses opening normal, sender-owned or expired temporary messages", async () => {
    const repo = repository();
    const ordinary = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "ordinary", tags: [["t", "hainei-dm"]],
    }, context)).message;
    await repo.insertMessageIfAbsent(receiver, ordinary);
    expect(await repo.openDisappearingMessage(receiver, ordinary.id, sender)).toBeNull();
    const disappearing = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "private", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 30,
    }, context)).message;
    await repo.insertMessageIfAbsent(receiver, disappearing);
    expect(await repo.openDisappearingMessage(sender, disappearing.id, receiver)).toBeNull();
    expect(await repo.openDisappearingMessage(receiver, disappearing.id, sender, Date.now() + 49 * 3600 * 1000)).toBeNull();
  });

  it("purges an elapsed read timer on account restore without opening its chat", async () => {
    const repo = repository();
    const ephemeral = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "do not restore", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 10,
    }, context)).message;
    const ordinary = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "keep this", tags: [["t", "hainei-dm"]],
    }, context)).message;
    await repo.insertMessageIfAbsent(receiver, ephemeral);
    await repo.insertMessageIfAbsent(receiver, ordinary);
    const openedAt = Date.now();
    const deadline = await repo.openDisappearingMessage(receiver, ephemeral.id, sender, openedAt);
    expect(await repo.listDueOpenedDisappearing(receiver, openedAt + 9_000)).toEqual([]);
    expect(await repo.listDueOpenedDisappearing(sender, openedAt + 11_000)).toEqual([]);
    expect(await repo.listDueOpenedDisappearing(receiver, openedAt + 11_000))
      .toContainEqual({ messageId: ephemeral.id, peerPubkey: sender, deadlineAt: deadline });

    expect(await repo.purgeExpiredDisappearing(receiver, openedAt + 11_000)).toBe(1);
    expect(await repo.get(receiver, ephemeral.id)).toBeUndefined();
    expect(await repo.get(receiver, ordinary.id)).toEqual(expect.objectContaining({ plaintext: "keep this" }));
    expect(await repo.listDueOpenedDisappearing(receiver, openedAt + 11_000)).toEqual([]);
    expect((await repo.insertMessageIfAbsent(receiver, ephemeral)).inserted).toBe(false);
    expect(await repo.isBurnedMessage(receiver, ephemeral)).toBe(true);
  });

  it("honors an elapsed deadline after a database reopen across login sessions", async () => {
    const repo = repository();
    const ephemeral = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "suspend", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 30,
    }, context)).message;
    await repo.insertMessageIfAbsent(receiver, ephemeral);
    const base = Date.now();
    const deadline = await repo.openDisappearingMessage(receiver, ephemeral.id, sender, base);
    const existing = opened.at(-1)!;
    const name = existing.name;
    existing.close();
    const restored = new HaiNeiDatabase(name);
    opened.push(restored);
    const reopened = new SyncedMessageRepository(restored);
    expect(await reopened.listDueOpenedDisappearing(receiver, base + 31_000))
      .toContainEqual({ messageId: ephemeral.id, peerPubkey: sender, deadlineAt: deadline });
    await reopened.purgeExpiredDisappearing(receiver, base + 31_000);
    expect(await reopened.get(receiver, ephemeral.id)).toBeUndefined();
    expect(await reopened.openDisappearingMessage(receiver, ephemeral.id, sender)).toBeNull();
  });

  it("handles a signed burn control arriving before the original message", async () => {
    const repo = repository();
    const temporary = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "late relay", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 60,
    }, context)).message;
    expect(await repo.burnDisappearingMessage(receiver, temporary.id, sender)).toBe(true);
    expect((await repo.insertMessageIfAbsent(receiver, temporary)).inserted).toBe(false);
    expect(await repo.get(receiver, temporary.id)).toBeUndefined();
  });

  it("does not persist expired temporary messages", async () => {
    const repo = repository();
    const message = (await nip17Adapter.encode!({
      recipientPubkeys: [receiver], plaintext: "expired", tags: [["t", "hainei-dm"]],
      burnAfterSeconds: 10,
    }, context)).message;
    expect((await repo.insertMessageIfAbsent(receiver, message, Date.now() + 49 * 60 * 60 * 1000)).inserted).toBe(false);
    expect(await repo.get(receiver, message.id)).toBeUndefined();
  });
});
