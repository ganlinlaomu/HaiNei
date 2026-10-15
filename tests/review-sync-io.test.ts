// Review findings #5, #6, #7, #9, #10 (storage half): avoidable IndexedDB and
// Relay work on the NIP-17 sync and unread paths.
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { MetaRepository } from "@/repositories/metaRepository";
import { MessageSyncManager } from "@/nostr/messaging/sync/MessageSyncManager";
import { GIFT_WRAP_TIMESTAMP_SKEW_SECONDS } from "@/nostr/messaging/subscriptions";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);
const NOW_MS = 1_900_000_000_000;
const NOW = NOW_MS / 1000;
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function database() {
  const db = new HaiNeiDatabase(`review-sync-io-${sequence++}`);
  databases.push(db);
  return db;
}

function message(id: string, createdAt: number): CanonicalMessage {
  return {
    id, senderPubkey: PEER, recipientPubkeys: [ACCOUNT], conversationId: `conversation:${PEER}`,
    plaintext: id, createdAt, protocol: "nip17", transportKind: 1059, transportEventId: `wrap-${id}`,
    tags: [["t", "hainei-dm"]],
  };
}

type FakeSubscription = { filters: any[]; handlers: Record<string, Array<(...args: any[]) => void>> };

function startManager(repo: SyncedMessageRepository) {
  const subscriptions: FakeSubscription[] = [];
  const subscribe = (relays: string[], filters: any[]) => {
    const subscription: FakeSubscription = { filters, handlers: {} };
    subscriptions.push(subscription);
    const historical = filters.some(filter => filter.until !== undefined);
    return {
      on(name: string, callback: (...args: any[]) => void) {
        (subscription.handlers[name] ||= []).push(callback);
        if (name === "eose" && historical) queueMicrotask(() => callback(relays[0]));
      },
      unsub() {},
    };
  };
  const manager = new MessageSyncManager({
    repository: repo,
    subscribe,
    observeRelays: () => () => undefined,
    resumeRelays: () => {},
    retryOutgoing: () => {},
    decode: async () => null,
    now: () => NOW_MS,
  });
  return { manager, subscriptions };
}

afterEach(async () => {
  vi.useRealTimers();
  const active = databases.splice(0);
  active.forEach(item => item.close());
  await Promise.all(active.map(item => Dexie.delete(item.name)));
});

describe("review #5: newest local message lookup", () => {
  it("does not load the whole message table to find the newest timestamp", async () => {
    const repo = new SyncedMessageRepository(database());
    await repo.insertMessageIfAbsent(ACCOUNT, message("1".repeat(64), NOW - 100), NOW_MS);
    // Simulate an upgraded install that has messages but no stored watermark.
    await repo.updateSyncState(ACCOUNT, { highWatermarkCreatedAt: undefined, historyBackfillCompletedAt: NOW_MS - 1 });
    const list = vi.spyOn(repo, "list");
    const { manager } = startManager(repo);
    try {
      await manager.start({ accountPubkey: ACCOUNT, relays: ["wss://relay.test"], authors: [PEER, ACCOUNT], decodeContext: { accountPubkey: ACCOUNT } });
      expect(list).not.toHaveBeenCalled();
    } finally {
      manager.stop();
    }
  });

  it("returns the newest createdAt for the account only", async () => {
    const repo = new SyncedMessageRepository(database());
    await repo.insertMessageIfAbsent(ACCOUNT, message("1".repeat(64), 100), NOW_MS);
    await repo.insertMessageIfAbsent(ACCOUNT, message("2".repeat(64), 300), NOW_MS);
    await repo.insertMessageIfAbsent("d".repeat(64), { ...message("3".repeat(64), 900), recipientPubkeys: ["d".repeat(64)] }, NOW_MS);
    expect(await repo.latestMessageCreatedAt(ACCOUNT)).toBe(300);
    expect(await repo.latestMessageCreatedAt("e".repeat(64))).toBeUndefined();
  });
});

describe("review #6: realtime relay diagnostics writes", () => {
  it("does not open one IndexedDB write per realtime event", async () => {
    const repo = new SyncedMessageRepository(database());
    const { manager, subscriptions } = startManager(repo);
    try {
      await manager.start({ accountPubkey: ACCOUNT, relays: ["wss://relay.test"], authors: [PEER, ACCOUNT], decodeContext: { accountPubkey: ACCOUNT } });
      const realtime = subscriptions.find(item => item.filters.every(filter => filter.until === undefined))!;
      const updates = vi.spyOn(repo, "updateRelayState");
      for (let i = 0; i < 200; i++) {
        realtime.handlers.event?.forEach(callback => callback({ id: i.toString(16).padStart(64, "0"), kind: 1059, created_at: NOW - i }, "wss://relay.test"));
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      const eventWrites = updates.mock.calls.filter(([, , patch]) => "lastEventCreatedAt" in patch);
      expect(eventWrites.length).toBeLessThanOrEqual(1);
    } finally {
      manager.stop();
    }
  });

  it("still persists the newest realtime event timestamp", async () => {
    const repo = new SyncedMessageRepository(database());
    const { manager, subscriptions } = startManager(repo);
    try {
      await manager.start({ accountPubkey: ACCOUNT, relays: ["wss://relay.test"], authors: [PEER, ACCOUNT], decodeContext: { accountPubkey: ACCOUNT } });
      const realtime = subscriptions.find(item => item.filters.every(filter => filter.until === undefined))!;
      for (const createdAt of [NOW - 50, NOW - 10, NOW - 90]) {
        realtime.handlers.event?.forEach(callback => callback({ id: String(createdAt).padStart(64, "0"), kind: 1059, created_at: createdAt }, "wss://relay.test"));
      }
    } finally {
      manager.stop();
    }
    await vi.waitFor(async () => {
      expect((await repo.getSyncState(ACCOUNT)).relayStates["wss://relay.test"]?.lastEventCreatedAt).toBe(NOW - 10);
    });
  });
});

describe("review #7: realtime subscription window", () => {
  it("does not reopen an unbounded realtime stream from an old watermark", async () => {
    const repo = new SyncedMessageRepository(database());
    await repo.updateSyncState(ACCOUNT, {
      highWatermarkCreatedAt: NOW - 30 * 86_400,
      historyBackfillCompletedAt: NOW_MS - 1,
      lastCatchupCompletedAt: (NOW - 30 * 86_400) * 1000,
    });
    const { manager, subscriptions } = startManager(repo);
    try {
      await manager.start({ accountPubkey: ACCOUNT, relays: ["wss://relay.test"], authors: [PEER, ACCOUNT], decodeContext: { accountPubkey: ACCOUNT } });
      const realtime = subscriptions[0];
      expect(realtime.filters.every(filter => filter.until === undefined)).toBe(true);
      // NIP-17 still needs the 48h wrapper skew, but not 30 days of backlog:
      // the bounded, checkpointed catch-up owns that gap.
      expect(realtime.filters[0].since).toBeGreaterThanOrEqual(NOW - GIFT_WRAP_TIMESTAMP_SKEW_SECONDS - 60);
      const catchup = subscriptions.find(item => item.filters.some(filter => filter.until !== undefined))!;
      expect(catchup.filters[0].since).toBeLessThanOrEqual(NOW - 30 * 86_400);
    } finally {
      manager.stop();
    }
  });
});

describe("review #9: cached visible unread count", () => {
  it("serves a cache hit without a read-write transaction", async () => {
    const db = database();
    const repo = new SyncedMessageRepository(db);
    const conversation = `conversation:${PEER}`;
    await repo.insertMessageIfAbsent(ACCOUNT, message("1".repeat(64), 100), NOW_MS);
    await repo.insertMessageIfAbsent(ACCOUNT, message("2".repeat(64), 200), NOW_MS);
    const visible = () => true;
    expect(await repo.getVisibleUnreadCount(ACCOUNT, conversation, "policy-1", undefined, visible)).toBe(2);

    const transaction = vi.spyOn(db, "transaction");
    expect(await repo.getVisibleUnreadCount(ACCOUNT, conversation, "policy-1", undefined, visible)).toBe(2);
    expect(transaction.mock.calls.filter(([mode]) => mode === "rw")).toHaveLength(0);

    // A different policy still recomputes and refreshes the cache.
    expect(await repo.getVisibleUnreadCount(ACCOUNT, conversation, "policy-2", { lastReadCreatedAt: 100, lastReadMessageId: "1".repeat(64) }, visible)).toBe(1);
  });
});

describe("review #10: account meta prefix listing", () => {
  it("uses the primary-key range instead of scanning every account row", async () => {
    const db = database();
    const meta = new MetaRepository(db);
    const other = "d".repeat(64);
    await meta.put(ACCOUNT, `dm-receipt:${PEER}`, { a: 1 });
    await meta.put(ACCOUNT, `dm-receipt-sent:${PEER}`, { b: 1 });
    await meta.put(ACCOUNT, "dm-receipt;", { c: 1 });
    await meta.put(ACCOUNT, "dm-receipt", { d: 1 });
    await meta.put(other, `dm-receipt:${PEER}`, { e: 1 });

    const where = vi.spyOn(db.accountMeta, "where");
    const rows = await meta.listPrefix(ACCOUNT, "dm-receipt:");
    expect(rows.map(row => row.key)).toEqual([`dm-receipt:${PEER}`]);
    // The secondary accountPubkey index means "read every row, then filter".
    expect(where).not.toHaveBeenCalledWith("accountPubkey");
  });
});
