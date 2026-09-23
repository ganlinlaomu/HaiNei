import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HaiNeiDatabase,
  resolveUnambiguousLegacyAccount
} from "@/db/dexie";
import { MessageRepository } from "@/repositories/messageRepository";
import { MetaRepository } from "@/repositories/metaRepository";
import { ImageCacheRepository } from "@/repositories/imageCacheRepository";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const PEER_C = "c".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
}

function createDatabase() {
  const database = new HaiNeiDatabase(`hainei-test-${sequence++}`);
  databases.push(database);
  return database;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage()
  });
});

afterEach(async () => {
  const active = databases.splice(0);
  const names = [...new Set(active.map(database => database.name))];
  active.forEach(database => database.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("account-scoped repositories", () => {
  it("isolates messages and same-peer conversations across accounts and reloads", async () => {
    const database = createDatabase();
    const messages = new MessageRepository(database);

    await messages.put(ACCOUNT_A, { id: "same-id", pubkey: PEER_C, content: "A private", created_at: 10 });
    await messages.put(ACCOUNT_B, { id: "same-id", pubkey: PEER_C, content: "B private", created_at: 20 });

    expect((await messages.listByPeer(ACCOUNT_A, PEER_C)).map(item => item.content)).toEqual(["A private"]);
    expect((await messages.listByPeer(ACCOUNT_B, PEER_C)).map(item => item.content)).toEqual(["B private"]);

    database.close();
    const reopened = new HaiNeiDatabase(database.name);
    databases.push(reopened);
    const reloadedMessages = new MessageRepository(reopened);
    expect((await reloadedMessages.listLatest(ACCOUNT_A))[0].content).toBe("A private");
    expect((await reloadedMessages.listLatest(ACCOUNT_B))[0].content).toBe("B private");
  });

  it("isolates unread metadata and decrypted image blobs", async () => {
    const database = createDatabase();
    const meta = new MetaRepository(database);
    const images = new ImageCacheRepository(database);

    await meta.put(ACCOUNT_A, `unread:${PEER_C}`, 5);
    await meta.put(ACCOUNT_B, `unread:${PEER_C}`, 2);
    await images.put(ACCOUNT_A, { url: "encrypted://same", blob: new Blob(["A"]), mime: "text/plain", timestamp: 1 });
    await images.put(ACCOUNT_B, { url: "encrypted://same", blob: new Blob(["BB"]), mime: "text/plain", timestamp: 2 });

    expect((await meta.get(ACCOUNT_A, `unread:${PEER_C}`))?.value).toBe(5);
    expect((await meta.get(ACCOUNT_B, `unread:${PEER_C}`))?.value).toBe(2);
    expect((await images.get(ACCOUNT_A, "encrypted://same"))?.blob.size).toBe(1);
    expect((await images.get(ACCOUNT_B, "encrypted://same"))?.blob.size).toBe(2);
  });

});

describe("v2 to v3 migration", () => {
  it("migrates legacy rows only when exactly one owner is known", async () => {
    localStorage.setItem("pkHex", ACCOUNT_A);
    expect(resolveUnambiguousLegacyAccount()).toBe(ACCOUNT_A);
    const name = `hainei-migration-${sequence++}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp"
    });
    await legacy.table("messages").put({ id: "legacy", pubkey: PEER_C, content: "private", created_at: 1 });
    await legacy.close();

    const upgraded = new HaiNeiDatabase(name);
    databases.push(upgraded);
    await upgraded.open();
    expect((await new MessageRepository(upgraded).get(ACCOUNT_A, "legacy"))?.content).toBe("private");
  });

  it("quarantines ambiguous legacy rows without crashing or assigning ownership", async () => {
    localStorage.setItem("nostr_registered_accounts", JSON.stringify([ACCOUNT_A, ACCOUNT_B]));
    expect(resolveUnambiguousLegacyAccount()).toBeNull();
    const name = `hainei-ambiguous-${sequence++}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({
      messages: "id, created_at, pubkey",
      friends: "pubkey, name, group",
      meta: "key",
      imageCache: "url, timestamp"
    });
    await legacy.table("messages").put({ id: "legacy", pubkey: PEER_C, content: "unknown", created_at: 1 });
    await legacy.close();

    const upgraded = new HaiNeiDatabase(name);
    databases.push(upgraded);
    await expect(upgraded.open()).resolves.toBe(upgraded);
    expect(await upgraded.accountMessages.count()).toBe(0);
    expect(await upgraded.messages.count()).toBe(1);
  });
});

describe("v9 to v10 friendship migration", () => {
  it("preserves accepted data and adds monotonic control metadata", async () => {
    const name = `hainei-friendship-migration-${sequence++}`;
    const legacy = new Dexie(name);
    legacy.version(9).stores({
      accountFriendships: "[accountPubkey+peerPubkey], accountPubkey, [accountPubkey+state], [accountPubkey+updatedAt]",
    });
    await legacy.table("accountFriendships").put({
      accountPubkey: ACCOUNT_A, peerPubkey: PEER_C, state: "accepted",
      requestEventId: "request", acceptedEventId: "accept", requestedAt: 10, acceptedAt: 20, updatedAt: 30,
    });
    legacy.close();

    const upgraded = new HaiNeiDatabase(name);
    databases.push(upgraded);
    await upgraded.open();
    expect(await upgraded.accountFriendships.get([ACCOUNT_A, PEER_C])).toMatchObject({
      state: "accepted", lastAction: "accept", lastControlAt: 20, lastControlEventId: "accept",
      acceptedWindows: [{ acceptedAt: 20, acceptedEventId: "accept" }],
    });
  });
});
