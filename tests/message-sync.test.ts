import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { MessageIngestionPipeline } from "@/nostr/messaging/sync/ingestion";
import { calculateCatchupSince, compareMessages } from "@/nostr/messaging/sync/sorting";
import { fetchCatchupPage, runPagedCatchup } from "@/nostr/messaging/sync/catchup";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { MessageSyncManager } from "@/nostr/messaging/sync/MessageSyncManager";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const PEER = "c".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function database() {
  const value = new HaiNeiDatabase(`message-sync-${sequence++}`);
  databases.push(value);
  return value;
}

function message(id: string, createdAt: number, overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    id,
    senderPubkey: PEER,
    recipientPubkeys: [ACCOUNT_A],
    conversationId: `conversation:${PEER}`,
    plaintext: id,
    createdAt,
    protocol: "nip17",
    transportKind: 1059,
    transportEventId: `wrap-${id}`,
    tags: [],
    ...overrides
  };
}

afterEach(async () => {
  const active = databases.splice(0);
  const names = [...new Set(active.map(item => item.name))];
  active.forEach(item => item.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("reliable message persistence", () => {
  it("purges cached records from removed message protocols", async () => {
    const db = database();
    const repo = new SyncedMessageRepository(db);
    await db.syncedMessages.add({
      accountPubkey: ACCOUNT_A,
      id: "removed",
      senderPubkey: PEER,
      recipientPubkeys: [ACCOUNT_A],
      conversationId: "removed-conversation",
      plaintext: "old",
      createdAt: 1,
      protocol: "removed-custom",
      transportKind: 8964,
      transportEventIds: ["removed"],
      firstSeenAt: 1,
      lastSeenAt: 1
    });
    expect(await repo.purgeUnsupportedMessages(ACCOUNT_A)).toBe(1);
    expect(await repo.list(ACCOUNT_A)).toEqual([]);
  });

  it("deduplicates concurrent multi-relay and duplicate realtime delivery atomically", async () => {
    const repo = new SyncedMessageRepository(database());
    const canonical = message("logical-rumor", 1000);
    const results = await Promise.all([
      repo.insertMessageIfAbsent(ACCOUNT_A, canonical),
      repo.insertMessageIfAbsent(ACCOUNT_A, { ...canonical, transportEventId: "relay-b-wrap" }),
      repo.insertMessageIfAbsent(ACCOUNT_A, { ...canonical, transportEventId: "relay-c-wrap" })
    ]);
    expect(results.filter(result => result.inserted)).toHaveLength(1);
    expect(await repo.list(ACCOUNT_A)).toHaveLength(1);
    expect((await repo.get(ACCOUNT_A, canonical.id))?.transportEventIds.sort()).toEqual(
      ["relay-b-wrap", "relay-c-wrap", "wrap-logical-rumor"].sort()
    );
  });

  it("keeps same-second and late messages and sorts them deterministically", async () => {
    const repo = new SyncedMessageRepository(database());
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("a", 1000));
    expect(calculateCatchupSince(undefined, 2000)).toBe(0);
    expect(calculateCatchupSince((await repo.getSyncState(ACCOUNT_A)).highWatermarkCreatedAt, 2000)).toBe(970);
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("c", 1000));
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("later", 1005));
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("middle", 1003));
    expect((await repo.list(ACCOUNT_A)).sort(compareMessages).map(item => item.id)).toEqual(["a", "c", "middle", "later"]);
  });

  it("derives unread from read cursors and never counts self messages", async () => {
    const repo = new SyncedMessageRepository(database());
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("a", 1));
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("b", 2));
    await repo.markRead(ACCOUNT_A, `conversation:${PEER}`);
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("c", 3));
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("d", 4));
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("self", 5, { senderPubkey: ACCOUNT_A }));
    expect(await repo.getUnreadCount(ACCOUNT_A, `conversation:${PEER}`)).toBe(2);
    expect(await repo.getTotalUnread(ACCOUNT_A)).toBe(2);
  });

  it("persists account-scoped read state across restart and rebuilds derived conversations", async () => {
    const db = database();
    const repo = new SyncedMessageRepository(db);
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("a", 1));
    await repo.insertMessageIfAbsent(ACCOUNT_B, message("b-private", 2, { recipientPubkeys: [ACCOUNT_B] }));
    await repo.markRead(ACCOUNT_A, `conversation:${PEER}`);
    db.close();
    const reopened = new HaiNeiDatabase(db.name);
    databases.push(reopened);
    const restored = new SyncedMessageRepository(reopened);
    await restored.rebuildConversationState(ACCOUNT_A);
    expect(await restored.getUnreadCount(ACCOUNT_A, `conversation:${PEER}`)).toBe(0);
    expect((await restored.list(ACCOUNT_A)).map(item => item.id)).toEqual(["a"]);
    expect((await restored.list(ACCOUNT_B)).map(item => item.id)).toEqual(["b-private"]);
  });

  it("stores future-skewed events without poisoning the high watermark", async () => {
    const repo = new SyncedMessageRepository(database());
    const now = 1_700_000_000_000;
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("normal", 1_700_000_000), now);
    await repo.insertMessageIfAbsent(ACCOUNT_A, message("future", 4_070_908_800), now);
    expect(await repo.get(ACCOUNT_A, "future")).toBeTruthy();
    expect((await repo.getSyncState(ACCOUNT_A)).highWatermarkCreatedAt).toBe(1_700_000_000);
  });

  it("discards stale account callbacks after await without contaminating the new session", async () => {
    const repo = new SyncedMessageRepository(database());
    let current = true;
    let release!: (value: CanonicalMessage) => void;
    const delayed = new Promise<CanonicalMessage>(resolve => { release = resolve; });
    const visible: string[] = [];
    const pipeline = new MessageIngestionPipeline(
      ACCOUNT_A,
      { accountPubkey: ACCOUNT_A },
      () => current,
      value => { visible.push(value.id); },
      repo,
      async () => delayed
    );
    const pending = pipeline.ingestNostrEvent({ id: "transport" } as any, { source: "realtime" });
    current = false;
    release(message("late-a", 10));
    await pending;
    expect(visible).toEqual([]);
    expect(await repo.list(ACCOUNT_B)).toEqual([]);
  });
});

describe("relay catch-up", () => {
  it("waits for every relay EOSE and retains the slower relay event", async () => {
    const subscribeFake = () => {
      const handlers: Record<string, Array<(...args: any[]) => void>> = {};
      return {
        on(name: string, callback: (...args: any[]) => void) {
          (handlers[name] ||= []).push(callback);
          if (name === "eose") queueMicrotask(() => {
            handlers.event?.forEach(handler => handler({ id: "slow", created_at: 10 }, "wss://b"));
            callback("wss://a");
            callback("wss://b");
          });
        },
        unsub() {}
      };
    };
    const page = await fetchCatchupPage(["wss://a", "wss://b"], [{}], 100, subscribeFake);
    expect(page.completedRelays.size).toBe(2);
    expect(page.events.map(item => item.event.id)).toEqual(["slow"]);
  });

  it("keeps a shared timestamp boundary, deduplicates IDs, and terminates", async () => {
    let calls = 0;
    const pages = [
      [{ id: "a", created_at: 100 }, { id: "b", created_at: 100 }],
      [{ id: "a", created_at: 100 }, { id: "c", created_at: 100 }],
      [{ id: "a", created_at: 100 }, { id: "c", created_at: 100 }]
    ];
    const subscribeFake = () => {
      const handlers: Record<string, Array<(...args: any[]) => void>> = {};
      const page = pages[Math.min(calls++, pages.length - 1)];
      return {
        on(name: string, callback: (...args: any[]) => void) {
          (handlers[name] ||= []).push(callback);
          if (name === "eose") queueMicrotask(() => {
            page.forEach(event => handlers.event?.forEach(handler => handler(event, "wss://a")));
            callback("wss://a");
          });
        },
        unsub() {}
      };
    };
    const ingested: string[] = [];
    await runPagedCatchup({
      relays: ["wss://a"],
      filters: [{ until: 200, limit: 2 }],
      subscribeFn: subscribeFake,
      isCurrent: () => true,
      onEvent: async event => { ingested.push(event.id); }
    });
    expect(ingested).toEqual(["a", "b", "c"]);
    expect(calls).toBe(3);
  });
});

describe("message sync session", () => {
  it("reconnects active read relays before foreground catch-up without duplicating realtime", async () => {
    const repo = new SyncedMessageRepository(database());
    const subscriptions: Array<{ relays: string[]; filters: any[]; handlers: Record<string, Array<(...args: any[]) => void>> }> = [];
    const subscribeFake = (relays: string[], filters: any[]) => {
      const handlers: Record<string, Array<(...args: any[]) => void>> = {};
      const entry = { relays, filters, handlers };
      subscriptions.push(entry);
      return {
        on(name: string, callback: (...args: any[]) => void) {
          (handlers[name] ||= []).push(callback);
          if (name === "eose" && filters.some(filter => filter.until !== undefined)) {
            queueMicrotask(() => callback(relays[0]));
          }
        },
        unsub() {},
      };
    };
    const documentHandlers = new Map<string, () => void>();
    const windowHandlers = new Map<string, () => void>();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        visibilityState: "visible",
        addEventListener: (name: string, handler: () => void) => documentHandlers.set(name, handler),
        removeEventListener: (name: string) => documentHandlers.delete(name),
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: (name: string, handler: () => void) => windowHandlers.set(name, handler),
        removeEventListener: (name: string) => windowHandlers.delete(name),
      },
    });
    const resumeRelays = vi.fn();
    const retryOutgoing = vi.fn();
    const manager = new MessageSyncManager({
      repository: repo,
      subscribe: subscribeFake,
      observeRelays: () => () => undefined,
      resumeRelays,
      activeReadRelays: () => ["wss://active-read.test"],
      retryOutgoing,
      now: () => 2_000_000,
    });
    await manager.start({
      accountPubkey: ACCOUNT_A,
      relays: ["wss://active-read.test"],
      authors: [PEER, ACCOUNT_A],
      decodeContext: { accountPubkey: ACCOUNT_A },
    });
    expect(subscriptions.filter(item => item.filters.every(filter => filter.until === undefined))).toHaveLength(1);

    windowHandlers.get("focus")?.();
    expect(resumeRelays).toHaveBeenCalledWith(["wss://active-read.test"]);
    expect(retryOutgoing).toHaveBeenCalledWith(ACCOUNT_A);
    for (let attempt = 0; attempt < 20 && subscriptions.length < 3; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(subscriptions).toHaveLength(3);
    expect(subscriptions.filter(item => item.filters.every(filter => filter.until === undefined))).toHaveLength(1);
    manager.stop();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "window");
  });

  it("subscribes before history, merges the race, and catch-ups again after reconnect", async () => {
    const repo = new SyncedMessageRepository(database());
    const subscriptions: Array<Record<string, Array<(...args: any[]) => void>>> = [];
    let relayObserver: ((event: any) => void) | undefined;
    const canonical = message("during-history", 1000);
    const subscribeFake = () => {
      const handlers: Record<string, Array<(...args: any[]) => void>> = {};
      const index = subscriptions.push(handlers) - 1;
      return {
        on(name: string, callback: (...args: any[]) => void) {
          (handlers[name] ||= []).push(callback);
          if (index > 0 && name === "eose") queueMicrotask(() => {
            // The same logical message arrives live while historical replay is active.
            if (index === 1) subscriptions[0].event?.forEach(handler => handler({ canonical }, "wss://a"));
            handlers.event?.forEach(handler => handler({ canonical }, "wss://a"));
            callback("wss://a");
          });
        },
        unsub() {}
      };
    };
    const visible: string[] = [];
    const manager = new MessageSyncManager({
      repository: repo,
      subscribe: subscribeFake,
      observeRelays: listener => { relayObserver = listener; return () => { relayObserver = undefined; }; },
      decode: async (event: any) => event.canonical,
      now: () => 2_000_000
    });
    await manager.start({
      accountPubkey: ACCOUNT_A,
      relays: ["wss://a"],
      authors: [PEER, ACCOUNT_A],
      decodeContext: { accountPubkey: ACCOUNT_A },
      onMessage: value => { visible.push(value.id); }
    });
    expect(subscriptions).toHaveLength(2);
    expect(await repo.list(ACCOUNT_A)).toHaveLength(1);
    expect(visible).toEqual(["during-history"]);
    expect((await repo.getSyncState(ACCOUNT_A)).historyBackfillCompletedAt).toBe(2_000_000);
    expect((await repo.getSyncState(ACCOUNT_A)).historyBackfillRelaySignature).toBe("wss://a");

    relayObserver?.({ url: "wss://a", connected: true, reconnected: true, at: 2_000_100 });
    for (let attempt = 0; attempt < 20 && subscriptions.length < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    manager.stop();
    expect(subscriptions.length).toBeGreaterThanOrEqual(3);
    expect(await repo.list(ACCOUNT_A)).toHaveLength(1);

    await manager.start({
      accountPubkey: ACCOUNT_A,
      relays: ["wss://b"],
      authors: [PEER, ACCOUNT_A],
      decodeContext: { accountPubkey: ACCOUNT_A },
      onMessage: value => { visible.push(value.id); }
    });
    expect((await repo.getSyncState(ACCOUNT_A)).historyBackfillRelaySignature).toBe("wss://b");
    manager.stop();
  });
});
