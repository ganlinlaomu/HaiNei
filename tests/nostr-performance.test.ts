import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { MessageIngestionPipeline } from "@/nostr/messaging/sync/ingestion";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import {
  LruCache,
  clearAccountScopedCaches,
  conversationCache,
  dedupeRequest,
  decryptedEventCache,
  scopedKey,
  seenOnCache
} from "@/services/nostrCache";
import { normalizeRelayUrl } from "@/services/connectionSettings";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

afterEach(async () => {
  clearAccountScopedCaches();
  seenOnCache.clear();
  const active = databases.splice(0);
  const names = active.map(item => item.name);
  active.forEach(item => item.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("bounded Nostr hot-path caches", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1).set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("shares one in-flight request", async () => {
    let calls = 0;
    const work = () => dedupeRequest("profile:test", async () => {
      calls++;
      await Promise.resolve();
      return 42;
    });
    expect(await Promise.all([work(), work(), work()])).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it("clears only private caches for the selected account", () => {
    decryptedEventCache.set(scopedKey(ACCOUNT_A, "event"), {} as CanonicalMessage);
    decryptedEventCache.set(scopedKey(ACCOUNT_B, "event"), {} as CanonicalMessage);
    conversationCache.set(scopedKey(ACCOUNT_A, "conversation"), []);
    clearAccountScopedCaches(ACCOUNT_A);
    expect(decryptedEventCache.has(scopedKey(ACCOUNT_A, "event"))).toBe(false);
    expect(conversationCache.has(scopedKey(ACCOUNT_A, "conversation"))).toBe(false);
    expect(decryptedEventCache.has(scopedKey(ACCOUNT_B, "event"))).toBe(true);
  });

  it("normalizes equivalent relay URLs", () => {
    expect(normalizeRelayUrl("WSS://Relay.Example.com/")).toBe("wss://relay.example.com");
    expect(normalizeRelayUrl("relay.example.com")).toBe("wss://relay.example.com");
  });
});

describe("NIP-17 ingest hot path", () => {
  it("dedupes before decode, updates UI once, writes once, and records every relay", async () => {
    const database = new HaiNeiDatabase(`nostr-performance-${sequence++}`);
    databases.push(database);
    const repository = new SyncedMessageRepository(database);
    let decodes = 0;
    let visible = 0;
    const message: CanonicalMessage = {
      id: "rumor",
      rumorId: "rumor",
      senderPubkey: "c".repeat(64),
      recipientPubkeys: [ACCOUNT_A],
      conversationId: "conversation",
      plaintext: "hello",
      createdAt: 10,
      protocol: "nip17",
      transportKind: 1059,
      transportEventId: "wrap",
      tags: []
    };
    const pipeline = new MessageIngestionPipeline(
      ACCOUNT_A,
      { accountPubkey: ACCOUNT_A },
      () => true,
      () => { visible++; },
      repository,
      async () => { decodes++; await Promise.resolve(); return message; }
    );
    const event = { id: "wrap", kind: 1059, created_at: 10 } as any;
    await Promise.all([
      pipeline.ingestNostrEvent(event, { source: "realtime", relayUrl: "wss://one.test" }),
      pipeline.ingestNostrEvent(event, { source: "realtime", relayUrl: "wss://two.test" }),
      pipeline.ingestNostrEvent(event, { source: "realtime", relayUrl: "wss://three.test" })
    ]);
    expect(decodes).toBe(1);
    expect(visible).toBe(1);
    expect(await repository.list(ACCOUNT_A)).toHaveLength(1);
    expect([...seenOnCache.get("wrap")!].sort()).toEqual([
      "wss://one.test", "wss://three.test", "wss://two.test"
    ]);
  });
});
