// Opening a notification on a cold start: the service worker already stored
// the encrypted message, so it must appear before the Worker account-state
// restore finishes. Relay streams still wait for that restore (historyGate).
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(64);
const PEER = "c".repeat(64);
const WRAP_ID = "e".repeat(64);

const pushInbox = vi.hoisted(() => ({ entries: [] as any[], acknowledged: [] as string[] }));
vi.mock("@/services/encryptedPushInbox", () => ({
  readEncryptedPushInbox: vi.fn(async () => pushInbox.entries),
  acknowledgeEncryptedPushInbox: vi.fn(async (_account: string, ids: string[]) => { pushInbox.acknowledged.push(...ids); }),
  isVerifiedPushGiftWrap: () => true,
  safePushRelays: (relays: unknown) => (Array.isArray(relays) ? relays : []),
}));

import { HaiNeiDatabase } from "@/db/dexie";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { MessageSyncManager } from "@/nostr/messaging/sync/MessageSyncManager";

const databases: HaiNeiDatabase[] = [];
afterEach(async () => {
  pushInbox.entries = [];
  pushInbox.acknowledged = [];
  const active = databases.splice(0);
  active.forEach(item => item.close());
  await Promise.all(active.map(item => Dexie.delete(item.name)));
});

const flush = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

describe("push inbox on cold start", () => {
  it("shows pushed messages before the account-state restore releases Relay work", async () => {
    const db = new HaiNeiDatabase(`push-before-state-${Date.now()}`);
    databases.push(db);
    pushInbox.entries = [{
      id: "notification-1",
      at: Date.now(),
      hint: { eventId: WRAP_ID, relays: [], event: { id: WRAP_ID, kind: 1059, pubkey: "f".repeat(64), created_at: 1, tags: [["p", ACCOUNT]], content: "x", sig: "0".repeat(128) } },
    }];
    const subscriptions: string[] = [];
    const delivered: string[] = [];
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });

    const manager = new MessageSyncManager({
      repository: new SyncedMessageRepository(db),
      observeRelays: () => () => undefined,
      resumeRelays: () => undefined,
      retryOutgoing: () => undefined,
      decode: async event => ({
        id: "1".repeat(64), senderPubkey: PEER, recipientPubkeys: [ACCOUNT], conversationId: "conversation",
        plaintext: "你好", createdAt: 1_900_000_000, protocol: "nip17", transportKind: 1059,
        transportEventId: event.id, tags: [["t", "hainei-dm"]],
      }),
      subscribe: (_relays, filters) => {
        subscriptions.push(filters.some(filter => filter.until !== undefined) ? "history" : "realtime");
        return { on() {}, unsub() {} };
      },
    });

    const started = manager.start({
      accountPubkey: ACCOUNT,
      relays: ["wss://relay.test"],
      authors: [PEER, ACCOUNT],
      decodeContext: { accountPubkey: ACCOUNT },
      historyGate,
      onMessage: async message => { delivered.push(message.plaintext || ""); return "accepted" as any; },
    });
    await flush();

    // Pushed message is persisted and acknowledged while Relay work waits.
    expect(delivered).toContain("你好");
    expect(pushInbox.acknowledged).toEqual(["notification-1"]);
    expect(subscriptions).toEqual([]);

    releaseHistory();
    await flush();
    expect(subscriptions[0]).toBe("realtime");
    manager.stop();
    await started.catch(() => undefined);
  });

  it("acknowledges a pushed message that was already stored, without decrypting it again", async () => {
    const db = new HaiNeiDatabase(`push-known-${Date.now()}`);
    databases.push(db);
    const repository = new SyncedMessageRepository(db);
    await repository.insertMessageIfAbsent(ACCOUNT, {
      id: "1".repeat(64), senderPubkey: PEER, recipientPubkeys: [ACCOUNT], conversationId: "conversation",
      plaintext: "旧消息", createdAt: 1_900_000_000, protocol: "nip17", transportKind: 1059,
      transportEventId: WRAP_ID, tags: [["t", "hainei-dm"]],
    } as any);
    pushInbox.entries = [{
      id: "notification-old",
      at: Date.now(),
      hint: { eventId: WRAP_ID, relays: [], event: { id: WRAP_ID, kind: 1059, pubkey: "f".repeat(64), created_at: 1, tags: [["p", ACCOUNT]], content: "x", sig: "0".repeat(128) } },
    }];
    const decode = vi.fn(async () => null);
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
    const manager = new MessageSyncManager({
      repository,
      observeRelays: () => () => undefined,
      resumeRelays: () => undefined,
      retryOutgoing: () => undefined,
      decode,
      subscribe: () => ({ on() {}, unsub() {} }),
    });
    const started = manager.start({
      accountPubkey: ACCOUNT,
      relays: ["wss://relay.test"],
      authors: [PEER, ACCOUNT],
      decodeContext: { accountPubkey: ACCOUNT },
      historyGate,
      onMessage: async () => "accepted" as any,
    });
    await flush();
    // Kept hints used to be re-processed on every launch.
    expect(pushInbox.acknowledged).toEqual(["notification-old"]);
    expect(decode).not.toHaveBeenCalled();
    manager.stop();
    releaseHistory();
    await started.catch(() => undefined);
  });

  it("starts sync right after the local phase and releases Relay history after the critical restore", () => {
    const keys = readFileSync("src/stores/keys.ts", "utf8");
    const local = keys.indexOf("const messageSyncStart = startAccountMessageSync(this, { historyGate });");
    const restore = keys.indexOf("await this.restoreCriticalAccountState(pk, criticalStateRestore, isCurrent);");
    const release = keys.indexOf("releaseHistory();", restore);
    expect(local).toBeGreaterThan(-1);
    expect(local).toBeLessThan(restore);
    expect(release).toBeGreaterThan(restore);
    // Released in finally so a failed restore never strands Relay sync.
    expect(keys.slice(restore, release)).toContain("} finally {");
  });
});
