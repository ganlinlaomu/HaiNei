import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { FRIEND_HISTORY_RESCAN_VERSION, MessageSyncManager } from "@/nostr/messaging/sync/MessageSyncManager";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);
const NOW_MS = 1_900_000_000_000;
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

afterEach(async () => {
  const active = databases.splice(0);
  active.forEach(item => item.close());
  await Promise.all(active.map(item => Dexie.delete(item.name)));
});

function oldPeerMessage(): CanonicalMessage {
  return {
    id: "old-peer-message",
    senderPubkey: PEER,
    recipientPubkeys: [ACCOUNT],
    conversationId: `conversation:${PEER}`,
    plaintext: "以前的消息",
    createdAt: 1_000,
    protocol: "nip17",
    transportKind: 1059,
    transportEventId: "old-wrap",
    tags: [],
  };
}

/** A relay holding one old wrap, answering only full-history queries with it. */
function relayWithOldWrap(fullHistoryQueries: number[]) {
  return (relays: string[], filters: any[]) => {
    const historical = filters.some(filter => filter.until !== undefined);
    const fullHistory = historical && filters.every(filter => filter.since === 0);
    if (fullHistory) fullHistoryQueries.push(filters[0].until);
    return {
      on(name: string, callback: (...args: any[]) => void) {
        if (!historical) return;
        if (name === "event" && fullHistory && filters[0].until >= 1_000) {
          queueMicrotask(() => callback({ id: "old-wrap", kind: 1059, created_at: 1_000 }, relays[0]));
        }
        if (name === "eose") queueMicrotask(() => queueMicrotask(() => callback(relays[0])));
      },
      unsub() {},
    };
  };
}

describe("friend history rescan", () => {
  it("re-reads old history once on a device whose initial sync finished under the old rule", async () => {
    const db = new HaiNeiDatabase(`friend-rescan-${sequence++}`);
    databases.push(db);
    const repo = new SyncedMessageRepository(db);
    await repo.updateSyncState(ACCOUNT, {
      historyBackfillStartedAt: NOW_MS - 10_000_000,
      historyBackfillCompletedAt: NOW_MS - 9_000_000,
      historyBackfillRelaySignature: "wss://a",
      lastCatchupCompletedAt: NOW_MS - 60_000,
      highWatermarkCreatedAt: NOW_MS / 1000 - 60,
    });
    const fullHistoryQueries: number[] = [];
    const build = () => new MessageSyncManager({
      repository: repo,
      subscribe: relayWithOldWrap(fullHistoryQueries),
      observeRelays: () => () => undefined,
      resumeRelays: () => {},
      retryOutgoing: () => {},
      now: () => NOW_MS,
      decode: async event => event.id === "old-wrap" ? oldPeerMessage() : null,
    });
    const options = {
      accountPubkey: ACCOUNT,
      relays: ["wss://a"],
      authors: [PEER, ACCOUNT],
      decodeContext: { accountPubkey: ACCOUNT },
      onMessage: async () => true,
    };

    const first = build();
    try {
      await first.start(options);
      await vi.waitFor(async () => {
        expect((await repo.getSyncState(ACCOUNT)).friendHistoryRescanVersion).toBe(FRIEND_HISTORY_RESCAN_VERSION);
      }, { timeout: 5_000 });
      expect(await repo.get(ACCOUNT, "old-peer-message")).toBeTruthy();
      expect(fullHistoryQueries.length).toBeGreaterThan(0);
    } finally {
      first.stop();
    }

    // Done once: the next launch only runs the normal catch-up.
    fullHistoryQueries.length = 0;
    const second = build();
    try {
      await second.start(options);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(fullHistoryQueries).toEqual([]);
    } finally {
      second.stop();
    }
  });

  it("keeps reading pass after pass until the oldest message, which comes last", async () => {
    const db = new HaiNeiDatabase(`friend-rescan-${sequence++}`);
    databases.push(db);
    const repo = new SyncedMessageRepository(db);
    await repo.updateSyncState(ACCOUNT, {
      historyBackfillStartedAt: NOW_MS - 10_000_000,
      historyBackfillCompletedAt: NOW_MS - 9_000_000,
      historyBackfillRelaySignature: "wss://a",
      lastCatchupCompletedAt: NOW_MS - 60_000,
      highWatermarkCreatedAt: NOW_MS / 1000 - 60,
    });
    // More wraps than one pass (8 pages of 250) reads; the friend's old
    // message is the oldest of them.
    const TOTAL = 2_600;
    const newest = NOW_MS / 1000 - 100;
    const wraps = Array.from({ length: TOTAL }, (_, i) => ({ id: `wrap-${i}`, kind: 1059, created_at: newest - i }));
    const subscribe = (relays: string[], filters: any[]) => {
      const fullHistory = filters.some(filter => filter.until !== undefined) && filters.every(filter => filter.since === 0);
      return {
        on(name: string, callback: (...args: any[]) => void) {
          if (!fullHistory) {
            if (name === "eose" && filters.some(filter => filter.until !== undefined)) queueMicrotask(() => callback(relays[0]));
            return;
          }
          if (name === "event") queueMicrotask(() => wraps
            .filter(wrap => wrap.created_at <= filters[0].until)
            .slice(0, filters[0].limit)
            .forEach(wrap => callback(wrap, relays[0])));
          if (name === "eose") queueMicrotask(() => queueMicrotask(() => callback(relays[0])));
        },
        unsub() {},
      };
    };
    const oldest = wraps[TOTAL - 1];
    const manager = new MessageSyncManager({
      repository: repo,
      subscribe,
      observeRelays: () => () => undefined,
      resumeRelays: () => {},
      retryOutgoing: () => {},
      now: () => NOW_MS,
      decode: async event => event.id === oldest.id
        ? { ...oldPeerMessage(), transportEventId: oldest.id, createdAt: oldest.created_at }
        : null,
    });
    try {
      await manager.start({
        accountPubkey: ACCOUNT,
        relays: ["wss://a"],
        authors: [PEER, ACCOUNT],
        decodeContext: { accountPubkey: ACCOUNT },
        onMessage: async () => true,
      });
      await vi.waitFor(async () => {
        expect((await repo.getSyncState(ACCOUNT)).friendHistoryRescanVersion).toBe(FRIEND_HISTORY_RESCAN_VERSION);
      }, { timeout: 20_000, interval: 100 });
      expect(await repo.get(ACCOUNT, "old-peer-message")).toBeTruthy();
      expect((await repo.getSyncState(ACCOUNT)).friendHistoryRescanUntilByRelay).toBeUndefined();
    } finally {
      manager.stop();
    }
  }, 30_000);
});
