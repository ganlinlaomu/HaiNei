import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/dexie";
import { migrateLegacyLocalStorage } from "@/services/legacyLocalStorageMigration";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

const ACCOUNT = "a".repeat(64);

beforeEach(async () => {
  await db.open();
  await db.deviceKeyValues.clear();
  await db.accountFriends.clear();
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("one-time legacy browser storage migration", () => {
  it("verifies IndexedDB persistence before removing encrypted keys and account data", async () => {
    localStorage.setItem("pkHex", ACCOUNT);
    localStorage.setItem(`encrypted_sk_${ACCOUNT}`, JSON.stringify({ ciphertext: "opaque", iv: "iv", salt: "salt" }));
    localStorage.setItem(`nostr_friends_${ACCOUNT}`, JSON.stringify([{ pubkey: "b".repeat(64), name: "友" }]));
    localStorage.setItem("unrelated-host-key", "keep");

    await migrateLegacyLocalStorage();
    expect((await db.deviceKeyValues.get(`encrypted_sk_${ACCOUNT}`))?.value).toContain('"ciphertext":"opaque"');
    expect(await db.deviceKeyValues.get(`nostr_friends_${ACCOUNT}`)).toBeTruthy();
    expect((await db.accountFriends.where("accountPubkey").equals(ACCOUNT).first())?.name).toBe("友");
    expect(localStorage.getItem(`encrypted_sk_${ACCOUNT}`)).toBeNull();
    expect(localStorage.getItem(`nostr_friends_${ACCOUNT}`)).toBeNull();
    expect(localStorage.getItem("unrelated-host-key")).toBe("keep");
  });

  it("is idempotent and never exposes private-key plaintext", async () => {
    const encrypted = JSON.stringify({ ciphertext: "cipher-only", iv: "iv", salt: "salt" });
    localStorage.setItem(`encrypted_sk_${ACCOUNT}`, encrypted);
    await migrateLegacyLocalStorage();
    await migrateLegacyLocalStorage();
    expect((await db.deviceKeyValues.get(`encrypted_sk_${ACCOUNT}`))?.value).toBe(encrypted);
    expect(JSON.stringify(await db.deviceKeyValues.toArray())).not.toContain("private-key-plaintext");
  });
});
