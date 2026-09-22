import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, nip44, utils, type EventTemplate } from "nostr-tools";

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock("@/nostr/relays", () => ({ publish: publishMock }));

import { sendDirectMessage } from "@/nostr/messaging/service";
import { db } from "@/db/dexie";

const senderSecret = utils.hexToBytes("1".padStart(64, "0"));
const recipientSecret = utils.hexToBytes("2".padStart(64, "0"));
const senderPubkey = getPublicKey(senderSecret);
const recipientPubkey = getPublicKey(recipientSecret);

const context = {
  senderPubkey,
  nip44Encrypt: async (pubkey: string, plaintext: string) => {
    const key = nip44.v2.utils.getConversationKey(senderSecret, pubkey);
    return nip44.v2.encrypt(plaintext, key);
  },
  signEvent: async (event: EventTemplate) => finalizeEvent(event, senderSecret)
};

describe("NIP-17 message publication", () => {
  beforeEach(async () => {
    publishMock.mockReset();
    await db.outgoingQueue.clear();
  });

  it("requires every encrypted copy to reach at least one relay", async () => {
    publishMock
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: true, ts: 1 }])
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: false, reason: "timeout", ts: 2 }]);

    await expect(sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "hello",
      relays: ["wss://one.test"],
      context
    })).rejects.toThrow("加密副本未被任何 relay 接收");
    expect(publishMock).toHaveBeenCalledTimes(2);
  });

  it("returns success when recipient and sender copies are acknowledged", async () => {
    publishMock.mockResolvedValue([{ relay: "wss://one.test", ok: true, ts: 1 }]);
    const result = await sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "hello",
      relays: ["wss://one.test"],
      context
    });
    expect(result.events).toHaveLength(2);
    expect(new Set(result.events.map(event => event.id)).size).toBe(2);
    expect(result.events.every(event => event.kind === 1059 && event.tags.length === 1)).toBe(true);
    expect(result.events.map(event => event.tags[0]).sort((a, b) => a[1].localeCompare(b[1]))).toEqual(
      [["p", senderPubkey], ["p", recipientPubkey]].sort((a, b) => a[1].localeCompare(b[1]))
    );
    expect(result.relayResults).toHaveLength(2);
    expect(result.relayResults.map(result => result.targetPubkey).sort()).toEqual(
      [senderPubkey, recipientPubkey].sort()
    );
  });
});
