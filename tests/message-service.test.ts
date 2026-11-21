import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, nip44, utils, type EventTemplate } from "nostr-tools";

const { publishMock, sendRelaysMock, cancelDmRelayDirectoryWorkMock, subscribeMock } = vi.hoisted(() => ({
  publishMock: vi.fn(),
  sendRelaysMock: vi.fn(() => ["wss://one.test"]),
  cancelDmRelayDirectoryWorkMock: vi.fn(),
  subscribeMock: vi.fn(),
}));
vi.mock("@/nostr/relays", () => ({ publish: publishMock, subscribe: subscribeMock }));
vi.mock("@/services/dmRelays", () => ({ dmSendRelays: sendRelaysMock }));
vi.mock("@/services/dmRelayDirectory", () => ({
  cancelDmRelayDirectoryWork: cancelDmRelayDirectoryWorkMock,
}));

import {
  buildMessageEvents,
  cancelOutgoingWorkForAccount,
  publishQueuedOutgoing,
  queueDirectMessage,
  retryOutgoingQueue,
  sendDirectMessage,
} from "@/nostr/messaging/service";
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
    sendRelaysMock.mockReset().mockReturnValue(["wss://one.test"]);
    subscribeMock.mockReset();
    cancelDmRelayDirectoryWorkMock.mockReset();
    await db.outgoingQueue.clear();
  });

  afterEach(() => cancelOutgoingWorkForAccount(senderPubkey));

  it("treats recipient delivery as sent even when the sender self-copy misses", async () => {
    publishMock
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: true, ts: 1 }])
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: false, reason: "timeout", ts: 2 }]);

    await expect(sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "hello",
      context
    })).resolves.toMatchObject({ message: { plaintext: "hello" } });
    expect(publishMock).toHaveBeenCalledTimes(2);
  });

  it("still fails when the recipient copy is not accepted by a relay", async () => {
    publishMock
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: false, reason: "timeout", ts: 1 }])
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: true, ts: 2 }]);

    await expect(sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "hello",
      context
    })).rejects.toThrow("收件人副本未被任何 relay 接收");
  });

  it("retries only the gift-wrap copies that have never been acknowledged", async () => {
    publishMock
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: false, reason: "timeout", ts: 1 }])
      .mockResolvedValueOnce([{ relay: "wss://one.test", ok: true, ts: 2 }]);

    await expect(sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "retry one copy",
      context
    })).rejects.toThrow();
    const [queued] = await db.outgoingQueue.toArray();

    publishMock.mockReset().mockResolvedValue([{ relay: "wss://one.test", ok: true, ts: 3 }]);
    await expect(publishQueuedOutgoing(senderPubkey, queued.outgoingId)).resolves.toBeTruthy();
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0][1].tags[0][1]).toBe(recipientPubkey);
  });

  it("returns success when recipient and sender copies are acknowledged", async () => {
    publishMock.mockResolvedValue([{ relay: "wss://one.test", ok: true, ts: 1 }]);
    const result = await sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "hello",
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

  it("publishes every copy, recipient's and our own, to the default plus write relays, without a 10050 lookup", async () => {
    sendRelaysMock.mockReturnValue(["wss://default.test", "wss://write.test"]);
    publishMock.mockImplementation(async (relays: string[]) => relays.map(relay => ({ relay, ok: true, ts: 1 })));

    await sendDirectMessage({ recipientPubkeys: [recipientPubkey], content: "fixed", context });

    const relayByTarget = new Map(publishMock.mock.calls.map(([relays, event]) => [event.tags[0][1], relays]));
    expect(relayByTarget.get(recipientPubkey)).toEqual(["wss://default.test", "wss://write.test"]);
    expect(relayByTarget.get(senderPubkey)).toEqual(["wss://default.test", "wss://write.test"]);
    // No directory query of any kind (kind 10050, purplepag.es).
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(publishMock.mock.calls.every(call => !call[0].includes("wss://purplepag.es"))).toBe(true);
    const [queued] = await db.outgoingQueue.toArray();
    expect(queued.eventRoutes).toBeUndefined();
    expect(queued.relays).toEqual(["wss://default.test", "wss://write.test"]);
  });

  it("returns after durable queueing without waiting for any Relay ACK", async () => {
    const queued = await queueDirectMessage({ recipientPubkeys: [recipientPubkey], content: "optimistic", context });
    expect(queued.message.plaintext).toBe("optimistic");
    expect(publishMock).not.toHaveBeenCalled();
    const [durable] = await db.outgoingQueue.toArray();
    expect(durable).toMatchObject({ outgoingId: queued.message.id, state: "pending" });
    expect(durable.events).toHaveLength(2);
  });

  it("uses a relay the user added after queueing when the message is retried", async () => {
    publishMock.mockImplementation(async (relays: string[]) => relays.map(relay => ({ relay, ok: false, reason: "timeout", ts: 1 })));
    await expect(sendDirectMessage({ recipientPubkeys: [recipientPubkey], content: "new relay", context })).rejects.toThrow();
    const [queued] = await db.outgoingQueue.toArray();

    sendRelaysMock.mockReturnValue(["wss://one.test", "wss://added.test"]);
    publishMock.mockReset().mockImplementation(async (relays: string[]) => relays.map(relay => ({ relay, ok: relay === "wss://added.test", ts: 2 })));
    await expect(publishQueuedOutgoing(senderPubkey, queued.outgoingId)).resolves.toBeTruthy();
    expect(publishMock.mock.calls.every(call => call[0].includes("wss://added.test"))).toBe(true);
    expect((await db.outgoingQueue.get([senderPubkey, queued.outgoingId]))?.state).toBe("sent");
  });

  it("retries a row queued with per-recipient 10050 routes by the new rule", async () => {
    const encoded = await buildMessageEvents({ recipientPubkeys: [recipientPubkey], content: "legacy row", context });
    await db.outgoingQueue.put({
      accountPubkey: senderPubkey, outgoingId: encoded.message.id, state: "waiting_network",
      message: encoded.message, events: encoded.events, relays: ["wss://legacy.test"],
      eventRoutes: (encoded.events as any[]).map(event => ({
        eventId: event.id, targetPubkey: event.tags[0][1], relays: ["wss://blocked-inbox.test"], source: "nip17-10050", resolvedAt: 1,
      })),
      dmRelayRoutesPending: true, attempts: 1, createdAt: 1, updatedAt: 1, nextAttemptAt: 0,
    } as any);
    publishMock.mockImplementation(async (relays: string[]) => relays.map(relay => ({ relay, ok: true, ts: 1 })));

    await retryOutgoingQueue(senderPubkey);
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock.mock.calls.every(call => JSON.stringify(call[0]) === JSON.stringify(["wss://one.test"]))).toBe(true);
    expect((await db.outgoingQueue.get([senderPubkey, encoded.message.id]))?.state).toBe("sent");
  });

  it("does not record a send after account cancellation mid-publish", async () => {
    const releases: Array<(value: unknown) => void> = [];
    publishMock.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const sending = sendDirectMessage({ recipientPubkeys: [recipientPubkey], content: "cancel", context });
    const rejection = expect(sending).rejects.toThrow("账号已切换");
    await vi.waitFor(() => expect(publishMock).toHaveBeenCalledTimes(2));
    cancelOutgoingWorkForAccount(senderPubkey);
    releases.forEach(release => release([{ relay: "wss://one.test", ok: true, ts: 1 }]));
    await rejection;
    expect((await db.outgoingQueue.toArray())[0].state).not.toBe("sent");
  });

  it("keeps a stable logical message id when an optimistic task is encoded again", async () => {
    const options = {
      recipientPubkeys: [recipientPubkey],
      content: "same logical task",
      createdAt: 12345,
      context,
    };
    const first = await buildMessageEvents(options);
    const retry = await buildMessageEvents(options);
    expect(retry.message.id).toBe(first.message.id);
  });
});
