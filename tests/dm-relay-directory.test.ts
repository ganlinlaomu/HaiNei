import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, utils, type EventTemplate, type NostrEvent } from "nostr-tools";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/services/nostrClient", () => ({
  nostrClient: {
    subscribe: mocks.subscribe,
    publish: mocks.publish,
  },
}));

import { db } from "@/db/dexie";
import { dmRelayDirectoryRepository } from "@/repositories/dmRelayDirectoryRepository";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import {
  advertisedDmRelays,
  cancelDmRelayDirectoryWork,
  DM_RELAY_LIST_KIND,
  ensureOwnDmRelayList,
  flushOwnDmRelayOutbox,
  getOwnDmRelayStatus,
  parseDmRelayListEvent,
} from "@/services/dmRelayDirectory";

const accountSecret = utils.hexToBytes("1".padStart(64, "0"));
const peerSecret = utils.hexToBytes("2".padStart(64, "0"));
const otherSecret = utils.hexToBytes("3".padStart(64, "0"));
const account = getPublicKey(accountSecret);
const peer = getPublicKey(peerSecret);
const otherAccount = getPublicKey(otherSecret);
const defaults = [...DEFAULT_RELAY_URLS].slice(0, 3);
const outboxKey = [account, String(DM_RELAY_LIST_KIND)] as [string, string];

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

const signer = () => vi.fn(async (template: EventTemplate) => signed(accountSecret, template));

beforeEach(async () => {
  mocks.subscribe.mockReset();
  mocks.publish.mockReset().mockImplementation(async (_event: NostrEvent, relays: string[]) =>
    relays.map(relay => ({ relay, ok: true, ts: 1 })),
  );
  await Promise.all([
    db.dmRelayDirectory.clear(),
    db.replaceableEventOutbox.clear(),
  ]);
});

afterEach(() => {
  cancelDmRelayDirectoryWork(account);
  cancelDmRelayDirectoryWork(otherAccount);
});

describe("kind 10050 parsing", () => {
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
});

describe("own kind 10050 (for older HaiNei versions only)", () => {
  it("publishes the default relays, to the default relays, without any lookup", async () => {
    const sign = signer();
    expect(advertisedDmRelays()).toEqual(defaults);

    await expect(ensureOwnDmRelayList(account, sign)).resolves.toBe(true);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][0]).toMatchObject({
      kind: DM_RELAY_LIST_KIND,
      tags: defaults.map(relay => ["relay", relay]),
    });
    expect(mocks.publish.mock.calls[0][1]).toEqual([...DEFAULT_RELAY_URLS]);
    expect(mocks.publish.mock.calls[0][1]).not.toContain("wss://purplepag.es");
    const own = await dmRelayDirectoryRepository.get(account, account);
    expect(own).toMatchObject({ relays: defaults, source: "own" });
    expect(own?.publishedAt).toBeTypeOf("number");
    expect(await db.replaceableEventOutbox.get(outboxKey)).toBeUndefined();

    // Already published and recent: nothing to do.
    await expect(ensureOwnDmRelayList(account, sign)).resolves.toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("republishes as the defaults when the stored list came from an older version", async () => {
    await dmRelayDirectoryRepository.put({
      accountPubkey: account, ownerPubkey: account,
      relays: ["wss://own-one.test", "wss://retired.workers.dev"],
      eventId: "e".repeat(64), eventCreatedAt: 2_000_000_000,
      fetchedAt: Date.now(), expiresAt: Number.MAX_SAFE_INTEGER, publishedAt: Date.now(), source: "own",
    });
    const sign = signer();

    await expect(ensureOwnDmRelayList(account, sign)).resolves.toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
    const event = mocks.publish.mock.calls[0][0] as NostrEvent;
    expect(event.tags).toEqual(defaults.map(relay => ["relay", relay]));
    // Replaceable event: must be newer than the list it replaces.
    expect(event.created_at).toBeGreaterThan(2_000_000_000);
    expect((await getOwnDmRelayStatus(account)).relays).toEqual(defaults);
  });

  it("refreshes an unchanged list weekly, so a list another device's old version published is replaced", async () => {
    await dmRelayDirectoryRepository.put({
      accountPubkey: account, ownerPubkey: account, relays: defaults,
      eventId: "e".repeat(64), eventCreatedAt: 100,
      fetchedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, publishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, source: "own",
    });
    const sign = signer();
    await expect(ensureOwnDmRelayList(account, sign)).resolves.toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed publication in the durable outbox without resigning it", async () => {
    mocks.publish.mockImplementation(async (_event: NostrEvent, relays: string[]) =>
      relays.map(relay => ({ relay, ok: false, ts: 1 })),
    );
    const sign = signer();

    await expect(ensureOwnDmRelayList(account, sign)).resolves.toBe(false);
    await expect(ensureOwnDmRelayList(account, sign)).resolves.toBe(false);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(await db.replaceableEventOutbox.get(outboxKey)).toMatchObject({
      attempts: 1,
      lastError: "dm_relay_list_publish_failed",
    });
    expect((await dmRelayDirectoryRepository.get(account, account))?.publishedAt).toBeUndefined();
  });

  it("treats a duplicate response as durable acceptance", async () => {
    mocks.publish.mockImplementation(async (_event: NostrEvent, relays: string[]) => [
      { relay: relays[0], ok: false, reason: "duplicate: already have this event", ts: 1 },
    ]);
    await expect(ensureOwnDmRelayList(account, signer())).resolves.toBe(true);
    expect(await db.replaceableEventOutbox.get(outboxKey)).toBeUndefined();
    expect((await dmRelayDirectoryRepository.get(account, account))?.publishedAt).toBeTypeOf("number");
  });

  it("publishes a row an older version queued only to the default relays", async () => {
    const event = dmRelayEvent(accountSecret, ["wss://own-one.test"]);
    await db.replaceableEventOutbox.put({
      accountPubkey: account, key: String(DM_RELAY_LIST_KIND), event,
      relays: ["wss://purplepag.es", "wss://own-one.test"], attempts: 0, createdAt: 1, updatedAt: 1,
    });
    await expect(flushOwnDmRelayOutbox(account)).resolves.toBe(true);
    expect(mocks.publish.mock.calls[0][1]).toEqual([...DEFAULT_RELAY_URLS]);
  });

  it("deduplicates concurrent automatic signing and publication", async () => {
    const sign = signer();
    await expect(Promise.all([ensureOwnDmRelayList(account, sign), ensureOwnDmRelayList(account, sign)])).resolves.toEqual([true, true]);
    expect(sign).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("does not clear or reschedule the durable outbox after account cancellation", async () => {
    const event = dmRelayEvent(accountSecret, defaults);
    await db.replaceableEventOutbox.put({
      accountPubkey: account, key: String(DM_RELAY_LIST_KIND), event,
      relays: [...DEFAULT_RELAY_URLS], attempts: 0, createdAt: 1, updatedAt: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.publish.mockImplementation(async (_event: NostrEvent, relays: string[]) => {
      await gate;
      return [{ relay: relays[0], ok: true, ts: 1 }];
    });
    const publishing = flushOwnDmRelayOutbox(account);
    const rejection = expect(publishing).rejects.toThrow("dm_relay_directory_cancelled");
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
    cancelDmRelayDirectoryWork(account);
    release();
    await rejection;
    expect(await db.replaceableEventOutbox.get(outboxKey)).toMatchObject({ attempts: 0 });
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
