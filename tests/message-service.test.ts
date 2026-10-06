import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, nip44, utils, type EventTemplate } from "nostr-tools";

const { publishMock, resolveDmRelaysMock, cancelDmRelayDirectoryWorkMock } = vi.hoisted(() => ({
  publishMock: vi.fn(),
  resolveDmRelaysMock: vi.fn(),
  cancelDmRelayDirectoryWorkMock: vi.fn(),
}));
vi.mock("@/nostr/relays", () => ({ publish: publishMock }));
vi.mock("@/services/dmRelayDirectory", () => ({
  resolveDmRelays: resolveDmRelaysMock,
  cancelDmRelayDirectoryWork: cancelDmRelayDirectoryWorkMock,
}));

import {
  buildMessageEvents,
  cancelOutgoingWorkForAccount,
  publishQueuedOutgoing,
  queueDirectMessage,
  resolveMessageEventRoutes,
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
    resolveDmRelaysMock.mockReset().mockImplementation(async (
      accountPubkey: string,
      ownerPubkey: string,
      fallbackRelays: string[],
    ) => ({
      relays: fallbackRelays,
      source: ownerPubkey === accountPubkey ? "own-10050" : "legacy-fallback",
      cached: true,
    }));
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
      relays: ["wss://one.test"],
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
      relays: ["wss://one.test"],
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
      relays: ["wss://one.test"],
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

  it("publishes each gift-wrap copy only to that target's resolved DM relays", async () => {
    resolveDmRelaysMock.mockImplementation(async (
      accountPubkey: string,
      ownerPubkey: string,
      fallbackRelays: string[],
    ) => ownerPubkey === accountPubkey
      ? { relays: ["wss://self-dm.test"], source: "own-10050", cached: true }
      : ownerPubkey === recipientPubkey
        ? { relays: ["wss://peer-dm.test"], source: "nip17-10050", cached: false }
        : { relays: fallbackRelays, source: "legacy-fallback", cached: false }
    );
    publishMock.mockImplementation(async (relays: string[]) =>
      relays.map(relay => ({ relay, ok: true, ts: 1 }))
    );

    await sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "routed",
      relays: ["wss://legacy.test"],
      context,
    });

    const relayByTarget = new Map(publishMock.mock.calls.map(([relays, event]) => [
      event.tags[0][1],
      relays,
    ]));
    expect(relayByTarget.get(recipientPubkey)).toEqual(["wss://peer-dm.test"]);
    expect(relayByTarget.get(senderPubkey)).toEqual(["wss://self-dm.test"]);
    expect(publishMock.mock.calls.every(call => !call[0].includes("wss://purplepag.es"))).toBe(true);
    const [queued] = await db.outgoingQueue.toArray();
    expect(queued.eventRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetPubkey: recipientPubkey, relays: ["wss://peer-dm.test"], source: "nip17-10050" }),
      expect.objectContaining({ targetPubkey: senderPubkey, relays: ["wss://self-dm.test"], source: "own-10050" }),
    ]));
  });

  it("does not publish a recipient with an explicit empty DM route to legacy relays", async () => {
    resolveDmRelaysMock.mockImplementation(async (_account: string, owner: string) => ({
      relays: owner === senderPubkey ? ["wss://self-dm.test"] : [],
      source: owner === senderPubkey ? "own-10050" : "nip17-10050",
      cached: true,
    }));
    publishMock.mockResolvedValue([{ relay: "wss://self-dm.test", ok: true, ts: 1 }]);
    await expect(sendDirectMessage({ recipientPubkeys: [recipientPubkey], content: "no public fallback", relays: ["wss://legacy.test"], context })).rejects.toThrow();
    expect(publishMock.mock.calls.map(call => call[1].tags[0][1])).toEqual([senderPubkey]);
    expect((await db.outgoingQueue.toArray())[0].eventRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetPubkey: recipientPubkey, relays: [], source: "nip17-10050" }),
    ]));
  });

  it("returns after durable queueing without waiting for DM relay discovery or Relay ACK", async () => {
    let resolveStarted = false;
    resolveDmRelaysMock.mockImplementation(async () => {
      resolveStarted = true;
      return { relays: ["wss://dm.test"], source: "nip17-10050", cached: false };
    });
    publishMock.mockResolvedValue([{ relay: "wss://dm.test", ok: true, ts: 1 }]);

    const queued = await queueDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "optimistic",
      relays: ["wss://legacy.test"],
      context,
    });

    expect(queued.message.plaintext).toBe("optimistic");
    expect(resolveStarted).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
    const [durable] = await db.outgoingQueue.toArray();
    expect(durable).toMatchObject({
      outgoingId: queued.message.id,
      state: "pending",
      dmRelayRoutesPending: true,
    });
  });

  it("persists signed fallback copies before waiting for DM relay discovery", async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    resolveDmRelaysMock.mockImplementation(async (
      accountPubkey: string,
      ownerPubkey: string,
      fallbackRelays: string[],
    ) => {
      await discoveryGate;
      return {
        relays: fallbackRelays,
        source: ownerPubkey === accountPubkey ? "own-10050" : "legacy-fallback",
        cached: false,
      };
    });
    publishMock.mockResolvedValue([{ relay: "wss://legacy.test", ok: true, ts: 1 }]);
    const onQueued = vi.fn();

    const sending = sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "durable first",
      relays: ["wss://legacy.test"],
      context,
      onQueued,
    });
    await vi.waitFor(() => expect(onQueued).toHaveBeenCalledOnce());
    const [durable] = await db.outgoingQueue.toArray();
    expect(durable).toMatchObject({ state: "pending", relays: ["wss://legacy.test"], dmRelayRoutesPending: true });
    expect(durable.events).toHaveLength(2);
    expect(durable.eventRoutes).toHaveLength(2);

    releaseDiscovery();
    await expect(sending).resolves.toBeTruthy();
  });

  it("refreshes a failed kind 10050 route for the durable retry", async () => {
    resolveDmRelaysMock.mockImplementation(async (
      accountPubkey: string,
      ownerPubkey: string,
      fallbackRelays: string[],
      force = false,
    ) => ownerPubkey === accountPubkey
      ? { relays: ["wss://self-dm.test"], source: "own-10050", cached: true }
      : force
        ? { relays: ["wss://peer-new.test"], source: "nip17-10050", cached: false }
        : { relays: ["wss://peer-old.test"], source: "nip17-10050", cached: false }
    );
    publishMock.mockImplementation(async (relays: string[]) => relays.map(relay => ({
      relay,
      ok: relay !== "wss://peer-old.test",
      ts: 1,
    })));

    await expect(sendDirectMessage({
      recipientPubkeys: [recipientPubkey],
      content: "refresh route",
      relays: ["wss://legacy.test"],
      context,
    })).rejects.toThrow("收件人副本未被任何 relay 接收");

    expect(resolveDmRelaysMock).toHaveBeenCalledWith(
      senderPubkey,
      recipientPubkey,
      ["wss://legacy.test"],
      true,
    );
    const [queued] = await db.outgoingQueue.toArray();
    expect(queued.eventRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetPubkey: recipientPubkey, relays: ["wss://peer-new.test"] }),
    ]));
  });

  it("resolves every target with at most two concurrent directory lookups", async () => {
    const peers = ["3", "4", "5", "6"].map(value => value.repeat(64));
    const events = [...peers, senderPubkey].map((targetPubkey, index) => ({
      id: String(index + 1).repeat(64),
      kind: 1059,
      pubkey: senderPubkey,
      created_at: 1,
      content: "cipher",
      sig: "0".repeat(128),
      tags: [["p", targetPubkey]],
    }));

    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    resolveDmRelaysMock.mockImplementation(async (_account: string, owner: string) => {
      active++;
      maxActive = Math.max(active, maxActive);
      await new Promise<void>(resolve => gates.push(resolve));
      active--;
      return { relays: [`wss://dm-${owner.slice(0, 1)}.test`], source: "nip17-10050", cached: false };
    });
    const resolving = resolveMessageEventRoutes(senderPubkey, events, ["wss://legacy.test"]);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    for (let released = 0; released < events.length;) {
      const next = gates.splice(0);
      released += next.length;
      next.forEach(release => release());
      if (released < events.length) await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    }
    const routes = await resolving;
    const networkPeers = resolveDmRelaysMock.mock.calls
      .map(call => call[1])
      .filter(target => target !== senderPubkey);
    expect(networkPeers).toEqual(peers);
    expect(maxActive).toBe(2);
    expect(routes).toHaveLength(events.length);
  });

  it("retries suspended discovery before publishing provisional legacy routes", async () => {
    const encoded = await buildMessageEvents({ recipientPubkeys: [recipientPubkey], content: "resume discovery", context });
    await db.outgoingQueue.put({
      accountPubkey: senderPubkey, outgoingId: encoded.message.id, state: "pending",
      message: encoded.message, events: encoded.events, relays: ["wss://legacy.test"],
      dmRelayRoutesPending: true, attempts: 0, createdAt: 1, updatedAt: 1,
    });
    resolveDmRelaysMock.mockResolvedValue({ relays: ["wss://dm.test"], source: "nip17-10050", cached: false });
    publishMock.mockResolvedValue([{ relay: "wss://dm.test", ok: true, ts: 1 }]);

    await publishQueuedOutgoing(senderPubkey, encoded.message.id);
    expect(publishMock.mock.calls.every(call => JSON.stringify(call[0]) === JSON.stringify(["wss://dm.test"]))).toBe(true);
    expect(await db.outgoingQueue.get([senderPubkey, encoded.message.id])).toMatchObject({ dmRelayRoutesPending: false });
  });

  it("stops directory workers and does not publish after account cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    resolveDmRelaysMock.mockImplementation(async () => {
      await gate;
      return { relays: ["wss://dm.test"], source: "nip17-10050", cached: false };
    });
    const sending = sendDirectMessage({ recipientPubkeys: [recipientPubkey], content: "cancel", relays: ["wss://legacy.test"], context });
    const rejection = expect(sending).rejects.toThrow("账号已切换");
    await vi.waitFor(() => expect(resolveDmRelaysMock).toHaveBeenCalledTimes(2));
    cancelOutgoingWorkForAccount(senderPubkey);
    release();
    await rejection;
    expect(publishMock).not.toHaveBeenCalled();
    expect((await db.outgoingQueue.toArray())[0]).toMatchObject({ state: "pending", dmRelayRoutesPending: true });
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
