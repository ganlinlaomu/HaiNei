import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, utils, type EventTemplate, type NostrEvent } from "nostr-tools";

const mocks = vi.hoisted(() => ({
  getRelaysFromStorage: vi.fn(),
  subscribe: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/nostr/relays", () => ({
  getRelaysFromStorage: mocks.getRelaysFromStorage,
}));
vi.mock("@/services/nostrClient", () => ({
  nostrClient: {
    subscribe: mocks.subscribe,
    publish: mocks.publish,
  },
}));

import { db } from "@/db/dexie";
import { dmRelayDirectoryRepository } from "@/repositories/dmRelayDirectoryRepository";
import {
  cancelDmRelayDirectoryWork,
  DM_RELAY_LIST_KIND,
  ensureOwnDmRelayList,
  flushOwnDmRelayOutbox,
  parseDmRelayListEvent,
  resolveDmRelays,
  selectOwnDmRelays,
} from "@/services/dmRelayDirectory";

const accountSecret = utils.hexToBytes("1".padStart(64, "0"));
const peerSecret = utils.hexToBytes("2".padStart(64, "0"));
const otherSecret = utils.hexToBytes("3".padStart(64, "0"));
const account = getPublicKey(accountSecret);
const peer = getPublicKey(peerSecret);
const otherAccount = getPublicKey(otherSecret);

function signed(secret: Uint8Array, template: EventTemplate) {
  return finalizeEvent(template, secret);
}

function dmRelayEvent(secret: Uint8Array, relays: string[], createdAt = 100) {
  return signed(secret, {
    kind: DM_RELAY_LIST_KIND,
    created_at: createdAt,
    tags: relays.map(relay => ["relay", relay]),
    content: "",
  });
}

function relayListEvent(secret: Uint8Array, relays: string[], createdAt = 99) {
  return signed(secret, {
    kind: 10002,
    created_at: createdAt,
    tags: relays.map(relay => ["r", relay, "write"]),
    content: "",
  });
}

function subscription(relays: string[], events: NostrEvent[]) {
  return {
    on(name: string, callback: (...args: any[]) => void) {
      if (name === "event") events.forEach(event => callback(event, relays[0]));
      if (name === "eose") relays.forEach(relay => callback(relay));
    },
    unsub: vi.fn(),
  };
}

beforeEach(async () => {
  mocks.getRelaysFromStorage.mockReset().mockImplementation((mode: string) =>
    mode === "read"
      ? ["wss://own-one.test", "wss://own-two.test", "wss://own-three.test"]
      : ["wss://write.test"]
  );
  mocks.subscribe.mockReset().mockImplementation((relays: string[]) => subscription(relays, []));
  mocks.publish.mockReset().mockImplementation(async (_event: NostrEvent, relays: string[]) => [
    { relay: relays[0], ok: true, ts: 1 },
  ]);
  await Promise.all([
    db.dmRelayDirectory.clear(),
    db.replaceableEventOutbox.clear(),
  ]);
});

afterEach(() => {
  cancelDmRelayDirectoryWork(account);
  cancelDmRelayDirectoryWork(otherAccount);
});

describe("kind 10050 parsing and discovery", () => {
  it("accepts only a valid owner's signed event and caps secure relay tags", () => {
    const event = dmRelayEvent(peerSecret, [
      "wss://one.test",
      "wss://two.test/",
      "ws://insecure.test",
      "wss://three.test",
      "wss://four.test",
    ]);

    expect(parseDmRelayListEvent(event, peer)?.relays).toEqual([
      "wss://one.test",
      "wss://two.test",
      "wss://three.test",
    ]);
    expect(parseDmRelayListEvent(event, account)).toBeNull();
    expect(parseDmRelayListEvent({ ...event, content: "tampered" }, peer)).toBeNull();
  });

  it("uses a discovered kind 10050 route and reuses the account-scoped cache", async () => {
    const event = dmRelayEvent(peerSecret, ["wss://peer-dm.test"]);
    mocks.subscribe.mockImplementation((relays: string[]) => subscription(relays, [event]));

    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"])).resolves.toMatchObject({
      relays: ["wss://peer-dm.test"],
      source: "nip17-10050",
      cached: false,
    });
    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"])).resolves.toMatchObject({
      relays: ["wss://peer-dm.test"],
      source: "nip17-10050",
      cached: true,
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe.mock.calls[0][0]).toHaveLength(2);
  });

  it("uses a signed NIP-65 write hint to find kind 10050", async () => {
    const hint = "wss://peer-hint.test";
    const nip65 = relayListEvent(peerSecret, [hint]);
    const dm = dmRelayEvent(peerSecret, ["wss://peer-inbox.test"]);
    mocks.subscribe.mockImplementation((relays: string[]) =>
      subscription(relays, relays.includes(hint) ? [dm] : [nip65])
    );

    const resolved = await resolveDmRelays(account, peer, ["wss://legacy.test"]);
    expect(resolved).toMatchObject({ relays: ["wss://peer-inbox.test"], source: "nip17-10050" });
    expect(mocks.subscribe).toHaveBeenCalledTimes(3);
    expect(mocks.subscribe.mock.calls[2][0]).toEqual([hint]);
  });

  it("falls back to the traditional Relay and negative-caches a complete miss", async () => {
    const fallback = ["wss://legacy.test"];
    await expect(resolveDmRelays(account, peer, fallback)).resolves.toMatchObject({
      relays: fallback,
      source: "legacy-fallback",
      cached: false,
    });
    await expect(resolveDmRelays(account, peer, fallback)).resolves.toMatchObject({
      relays: fallback,
      source: "legacy-fallback",
      cached: true,
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("checks configured relays after a shared-directory miss", async () => {
    const dm = dmRelayEvent(peerSecret, ["wss://peer-inbox.test"]);
    mocks.subscribe.mockImplementation((relays: string[]) =>
      subscription(relays, relays.includes("wss://own-one.test") ? [dm] : [])
    );
    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"])).resolves.toMatchObject({
      relays: ["wss://peer-inbox.test"], source: "nip17-10050",
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe.mock.calls[1][0]).toEqual(["wss://own-one.test", "wss://write.test"]);
  });

  it("does not turn a valid empty DM list into a legacy fallback", async () => {
    const event = dmRelayEvent(peerSecret, []);
    mocks.subscribe.mockImplementation((relays: string[]) => subscription(relays, [event]));
    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"])).resolves.toMatchObject({ relays: [], source: "nip17-10050" });
    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"])).resolves.toMatchObject({ relays: [], source: "nip17-10050", cached: true });
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("preserves a known DM route when refreshed relays return a complete miss", async () => {
    await dmRelayDirectoryRepository.put({
      accountPubkey: account, ownerPubkey: peer, relays: ["wss://known-inbox.test"],
      eventId: "a".repeat(64), eventCreatedAt: 100, fetchedAt: 1, expiresAt: 2, source: "nip17",
    });
    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"], true)).resolves.toMatchObject({
      relays: ["wss://known-inbox.test"], source: "nip17-10050", cached: true,
    });
    expect(await dmRelayDirectoryRepository.get(account, peer)).toMatchObject({ source: "nip17" });
  });

  it("does not downgrade a newer cached signed list to an older discovery result", async () => {
    const latest = dmRelayEvent(peerSecret, ["wss://new-inbox.test"], 200);
    await dmRelayDirectoryRepository.put({
      accountPubkey: account, ownerPubkey: peer, relays: ["wss://new-inbox.test"],
      eventId: latest.id, eventCreatedAt: latest.created_at, fetchedAt: 1, expiresAt: 2, source: "nip17",
    });
    mocks.subscribe.mockImplementation((relays: string[]) => subscription(relays, [dmRelayEvent(peerSecret, ["wss://old-inbox.test"], 100)]));
    await expect(resolveDmRelays(account, peer, ["wss://legacy.test"], true)).resolves.toMatchObject({
      relays: ["wss://new-inbox.test"], source: "nip17-10050",
    });
  });

  it("closes in-flight directory subscriptions and discards results on cancellation", async () => {
    const unsub = vi.fn();
    mocks.subscribe.mockReturnValue({ on: vi.fn(), unsub });
    const resolving = resolveDmRelays(account, peer, ["wss://legacy.test"]);
    const rejection = expect(resolving).rejects.toThrow("dm_relay_directory_cancelled");
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    cancelDmRelayDirectoryWork(account);
    await rejection;
    expect(unsub).toHaveBeenCalledOnce();
    expect(await dmRelayDirectoryRepository.get(account, peer)).toBeUndefined();
  });

  it("bounds subscriptions across simultaneous messages and cancels queued lookups", async () => {
    const unsubs: ReturnType<typeof vi.fn>[] = [];
    mocks.subscribe.mockImplementation(() => {
      const unsub = vi.fn();
      unsubs.push(unsub);
      return { on: vi.fn(), unsub };
    });
    const resolving = Promise.allSettled([peer, otherAccount, "4".repeat(64)].map(owner => resolveDmRelays(account, owner, ["wss://legacy.test"])));
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
    cancelDmRelayDirectoryWork(account);
    expect((await resolving).every(result => result.status === "rejected")).toBe(true);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(unsubs.every(unsub => unsub.mock.calls.length === 1)).toBe(true);
  });
});

describe("own kind 10050 publication", () => {
  it("adopts an already-published matching list on a fresh device", async () => {
    const remote = dmRelayEvent(accountSecret, ["wss://own-one.test", "wss://own-two.test"]);
    mocks.subscribe.mockImplementation((relays: string[]) => subscription(relays, [remote]));
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(true);
    expect(signer).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(await dmRelayDirectoryRepository.get(account, account)).toMatchObject({
      eventId: remote.id,
      relays: ["wss://own-one.test", "wss://own-two.test"],
      source: "own",
    });
  });

  it("publishes a newer replacement when another device advertised different relays", async () => {
    const futureCreatedAt = Math.floor(Date.now() / 1000) + 100;
    const remote = dmRelayEvent(accountSecret, ["wss://old-device.test"], futureCreatedAt);
    mocks.subscribe.mockImplementation((relays: string[]) => subscription(relays, [remote]));
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(true);
    expect(signer.mock.calls[0][0].created_at).toBe(futureCreatedAt + 1);
    expect(await dmRelayDirectoryRepository.get(account, account)).toMatchObject({
      relays: ["wss://own-one.test", "wss://own-two.test"],
      source: "own",
    });
  });

  it("selects two existing read relays and durably publishes only once", async () => {
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));
    expect(selectOwnDmRelays()).toEqual(["wss://own-one.test", "wss://own-two.test"]);

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(true);
    const own = await dmRelayDirectoryRepository.get(account, account);
    expect(own).toMatchObject({
      relays: ["wss://own-one.test", "wss://own-two.test"],
      source: "own",
    });
    expect(own?.publishedAt).toBeTypeOf("number");
    expect(await db.replaceableEventOutbox.get([account, String(DM_RELAY_LIST_KIND)])).toBeUndefined();
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][0]).toMatchObject({
      kind: DM_RELAY_LIST_KIND,
      tags: [["relay", "wss://own-one.test"], ["relay", "wss://own-two.test"]],
    });
    expect(mocks.publish.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "wss://purplepag.es",
      "wss://own-one.test",
      "wss://own-two.test",
    ]));
    expect(mocks.publish.mock.calls[0][1].length).toBeLessThanOrEqual(4);

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(true);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed publication in the durable outbox without resigning it", async () => {
    mocks.publish.mockResolvedValue([{ relay: "wss://own-one.test", ok: false, ts: 1 }]);
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(false);
    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(false);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(await db.replaceableEventOutbox.get([account, String(DM_RELAY_LIST_KIND)])).toMatchObject({
      attempts: 1,
      lastError: "dm_relay_list_discovery_publish_failed",
    });
  });

  it("keeps retrying when only a non-discovery relay accepted kind 10050", async () => {
    mocks.publish.mockResolvedValue([{ relay: "wss://own-one.test", ok: true, ts: 1 }]);
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(false);
    expect(await db.replaceableEventOutbox.get([account, String(DM_RELAY_LIST_KIND)])).toMatchObject({
      attempts: 1,
      lastError: "dm_relay_list_discovery_publish_failed",
    });
    expect((await dmRelayDirectoryRepository.get(account, account))?.publishedAt).toBeUndefined();
  });

  it("treats a discovery relay's duplicate response as durable acceptance", async () => {
    mocks.publish.mockImplementation(async (_event: NostrEvent, relays: string[]) => [
      { relay: relays[0], ok: false, reason: "duplicate: already have this event", ts: 1 },
    ]);
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));

    await expect(ensureOwnDmRelayList(account, signer)).resolves.toBe(true);
    expect(await db.replaceableEventOutbox.get([account, String(DM_RELAY_LIST_KIND)])).toBeUndefined();
    expect((await dmRelayDirectoryRepository.get(account, account))?.publishedAt).toBeTypeOf("number");
  });

  it("deduplicates concurrent automatic signing and publication", async () => {
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));
    await expect(Promise.all([ensureOwnDmRelayList(account, signer), ensureOwnDmRelayList(account, signer)])).resolves.toEqual([true, true]);
    expect(signer).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("replaces stale pending settings before retrying their publication", async () => {
    mocks.publish.mockResolvedValue([{ relay: "wss://own-one.test", ok: false, ts: 1 }]);
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));
    await ensureOwnDmRelayList(account, signer);
    mocks.getRelaysFromStorage.mockReturnValue(["wss://changed.test"]);
    await ensureOwnDmRelayList(account, signer);
    expect(signer).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[1][0].tags).toEqual([["relay", "wss://changed.test"]]);
  });

  it("does not clear or reschedule the durable outbox after account cancellation", async () => {
    const signer = vi.fn(async (template: EventTemplate) => signed(accountSecret, template));
    await ensureOwnDmRelayList(account, signer);
    const event = dmRelayEvent(accountSecret, selectOwnDmRelays());
    await db.replaceableEventOutbox.put({
      accountPubkey: account, key: String(DM_RELAY_LIST_KIND), event,
      relays: ["wss://own-one.test"], attempts: 0, createdAt: 1, updatedAt: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.publish.mockImplementation(async (_event: NostrEvent, relays: string[]) => {
      await gate;
      return [{ relay: relays[0], ok: true, ts: 1 }];
    });
    const publishing = flushOwnDmRelayOutbox(account);
    const rejection = expect(publishing).rejects.toThrow("dm_relay_directory_cancelled");
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2));
    cancelDmRelayDirectoryWork(account);
    release();
    await rejection;
    expect(await db.replaceableEventOutbox.get([account, String(DM_RELAY_LIST_KIND)])).toMatchObject({ attempts: 0 });
  });
});

describe("DM relay directory storage", () => {
  it("isolates accounts and prunes expired or excess peer entries without deleting self", async () => {
    const now = Date.now();
    await Promise.all([
      dmRelayDirectoryRepository.put({ accountPubkey: account, ownerPubkey: account, relays: ["wss://own.test"], fetchedAt: now, expiresAt: Number.MAX_SAFE_INTEGER, source: "own" }),
      dmRelayDirectoryRepository.put({ accountPubkey: account, ownerPubkey: peer, relays: [], fetchedAt: now - 3, expiresAt: now - 1, source: "negative" }),
      dmRelayDirectoryRepository.put({ accountPubkey: account, ownerPubkey: "4".repeat(64), relays: ["wss://old.test"], fetchedAt: now - 2, expiresAt: now + 1_000, source: "nip17" }),
      dmRelayDirectoryRepository.put({ accountPubkey: account, ownerPubkey: "5".repeat(64), relays: ["wss://new.test"], fetchedAt: now - 1, expiresAt: now + 1_000, source: "nip17" }),
      dmRelayDirectoryRepository.put({ accountPubkey: otherAccount, ownerPubkey: peer, relays: ["wss://other.test"], fetchedAt: now, expiresAt: now + 1_000, source: "nip17" }),
    ]);

    expect(await dmRelayDirectoryRepository.prune(account, 1, now)).toBe(2);
    expect(await dmRelayDirectoryRepository.get(account, account)).toBeTruthy();
    expect(await dmRelayDirectoryRepository.get(account, peer)).toBeUndefined();
    expect(await dmRelayDirectoryRepository.get(account, "4".repeat(64))).toBeUndefined();
    expect(await dmRelayDirectoryRepository.get(account, "5".repeat(64))).toBeTruthy();
    expect(await dmRelayDirectoryRepository.get(otherAccount, peer)).toMatchObject({ relays: ["wss://other.test"] });
  });
});
