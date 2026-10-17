import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { MessageSyncManager, relayCatchupRetryDelayMs } from "@/nostr/messaging/sync/MessageSyncManager";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);
const FLAKY = "wss://flaky.test";
const STEADY = "wss://steady.test";
const databases: HaiNeiDatabase[] = [];
let sequence = 0;

afterEach(async () => {
  const active = databases.splice(0);
  active.forEach(item => item.close());
  await Promise.all(active.map(item => Dexie.delete(item.name)));
});

describe("per-Relay catch-up retry", () => {
  it("backs off 1s, 2s, 4s … and caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(relayCatchupRetryDelayMs))
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it("retries only the failed Relay until it completes, without waiting for a resume", async () => {
    const db = new HaiNeiDatabase(`relay-catchup-retry-${sequence++}`);
    databases.push(db);
    const repository = new SyncedMessageRepository(db);
    const historyRequests: Array<{ relay: string; at: number }> = [];
    let flakyFailuresLeft = 2;
    const startedAt = Date.now();

    const manager = new MessageSyncManager({
      repository,
      observeRelays: () => () => undefined,
      resumeRelays: () => undefined,
      retryOutgoing: () => undefined,
      subscribe: (relays, filters) => {
        const isHistory = filters.some(filter => filter.until !== undefined);
        const relay = relays[0];
        if (isHistory) historyRequests.push({ relay, at: Date.now() - startedAt });
        return {
          on(name: string, callback: (...args: any[]) => void) {
            if (!isHistory) return;
            if (relay === FLAKY && flakyFailuresLeft > 0) {
              if (name === "failure") queueMicrotask(() => { flakyFailuresLeft--; callback(relay, "connection-failed"); });
              return;
            }
            if (name === "eose") queueMicrotask(() => callback(relay));
          },
          unsub() {},
        };
      },
    });

    try {
      await manager.start({
        accountPubkey: ACCOUNT,
        relays: [FLAKY, STEADY],
        authors: [PEER, ACCOUNT],
        decodeContext: { accountPubkey: ACCOUNT },
      });
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && historyRequests.filter(item => item.relay === FLAKY).length < 3) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const flaky = historyRequests.filter(item => item.relay === FLAKY);
      const steady = historyRequests.filter(item => item.relay === STEADY);
      expect(flaky).toHaveLength(3);
      // Only the failing Relay is retried; the healthy one completed once.
      expect(steady).toHaveLength(1);
      expect(flaky[1].at - flaky[0].at).toBeGreaterThanOrEqual(900);
      expect(flaky[2].at - flaky[1].at).toBeGreaterThanOrEqual(1_900);

      // After success the backoff resets and no further retry is scheduled.
      await new Promise(resolve => setTimeout(resolve, 1_300));
      expect(historyRequests.filter(item => item.relay === FLAKY)).toHaveLength(3);
    } finally {
      manager.stop();
    }
  }, 20_000);

  it("cancels pending retries when sync stops", async () => {
    const db = new HaiNeiDatabase(`relay-catchup-retry-${sequence++}`);
    databases.push(db);
    let historyRequests = 0;
    const manager = new MessageSyncManager({
      repository: new SyncedMessageRepository(db),
      observeRelays: () => () => undefined,
      resumeRelays: () => undefined,
      retryOutgoing: () => undefined,
      subscribe: (relays, filters) => {
        const isHistory = filters.some(filter => filter.until !== undefined);
        if (isHistory) historyRequests++;
        return {
          on(name: string, callback: (...args: any[]) => void) {
            if (isHistory && name === "failure") queueMicrotask(() => callback(relays[0], "connection-failed"));
          },
          unsub() {},
        };
      },
    });
    await manager.start({
      accountPubkey: ACCOUNT, relays: [FLAKY], authors: [PEER, ACCOUNT], decodeContext: { accountPubkey: ACCOUNT },
    });
    expect(historyRequests).toBe(1);
    manager.stop();
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(historyRequests).toBe(1);
  });
});
