import "fake-indexeddb/auto";
import { createPinia, setActivePinia } from "pinia";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listDeviceAccounts } from "@/services/accountRegistry";
import { deviceStorage } from "@/services/deviceStorage";
import { useKeyStore } from "@/stores/keys";
import { hasEncryptedKey } from "@/utils/crypto";

const STALE_PUBKEY = "a".repeat(64);
const PRIVATE_KEY = "01".padStart(64, "0");
const PRIVATE_PUBKEY = getPublicKey(hexToBytes(PRIVATE_KEY));
const SESSION_KEYS = [
  "hainei_device_accounts", "skHex", "pkHex", "loginMethod", "loginTimestamp",
  "isEncrypted", "bunkerInput", "bunkerClientSecretKey",
];

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

function createStore() {
  const store = useKeyStore();
  vi.spyOn(store, "loadAccountStores").mockResolvedValue(undefined);
  vi.spyOn(store, "resetAccountStores").mockImplementation(() => undefined);
  return store;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  for (const key of [...SESSION_KEYS, `encrypted_sk_${PRIVATE_PUBKEY}`]) deviceStorage.removeItem(key);
  setActivePinia(createPinia());
});

describe("private-key authentication", () => {
  it("keeps a one-time private-key login in memory without persisting plaintext", async () => {
    const store = createStore();

    await store.loginWithNsec(PRIVATE_KEY);

    expect(store.loginMethod).toBe("private-key");
    expect(store.pkHex).toBe(PRIVATE_PUBKEY);
    expect(store.supportsNip44).toBe(true);
    expect(store.skHex).toBe(PRIVATE_KEY);
    expect(store.isEncrypted).toBe(false);
    expect(deviceStorage.getItem("skHex")).toBeNull();
    expect(deviceStorage.getItem("pkHex")).toBeNull();
    expect(listDeviceAccounts()[0]).toMatchObject({
      pubkey: PRIVATE_PUBKEY,
      authType: "private-key",
      hasEncryptedKey: false,
    });
  });

  it("stores an encrypted private key and unlocks it without nsec re-entry", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");
    expect(hasEncryptedKey(PRIVATE_PUBKEY)).toBe(true);
    expect(deviceStorage.getItem("skHex")).toBeNull();

    await store.clearActiveSession();
    await expect(store.selectRememberedAccount(PRIVATE_PUBKEY)).resolves.toBe("unlock");
    expect(store.skHex).toBe("");
    expect(store.isUnlocked).toBe(false);

    await store.unlockWithPassword("local-password");
    expect(store.skHex).toBe(PRIVATE_KEY);
    expect(store.isUnlocked).toBe(true);
  });

  it("deduplicates the same encrypted account in the device registry", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");
    await store.clearActiveSession();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");

    expect(listDeviceAccounts()).toHaveLength(1);
    expect(listDeviceAccounts()[0]).toMatchObject({
      pubkey: PRIVATE_PUBKEY,
      authType: "private-key",
      hasEncryptedKey: true,
    });
  });

  it("preserves the encrypted key while clearing the active session", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");
    await store.clearActiveSession();

    expect(hasEncryptedKey(PRIVATE_PUBKEY)).toBe(true);
    expect(listDeviceAccounts()[0]).toMatchObject({ pubkey: PRIVATE_PUBKEY, hasEncryptedKey: true });
  });

  it("deletes only the encrypted key and registry entry on explicit removal", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");

    await store.removeAccountFromDevice(PRIVATE_PUBKEY);

    expect(hasEncryptedKey(PRIVATE_PUBKEY)).toBe(false);
    expect(listDeviceAccounts()).toEqual([]);
  });
});

describe("session restoration", () => {
  it.each(["nip07", "nip46"])("clears a stale %s session", async staleMethod => {
    deviceStorage.setItem("pkHex", STALE_PUBKEY);
    deviceStorage.setItem("loginMethod", staleMethod);
    const store = createStore();

    await store.restoreSession();

    expect(store.pkHex).toBe("");
    expect(store.loginMethod).toBe("");
    expect(deviceStorage.getItem("pkHex")).toBeNull();
  });

  it("restores an encrypted account as locked without persisting plaintext", async () => {
    const first = createStore();
    await first.loginWithNsec(PRIVATE_KEY, "local-password");

    setActivePinia(createPinia());
    const restored = createStore();
    await restored.restoreSession();

    expect(restored.loginMethod).toBe("private-key");
    expect(restored.pkHex).toBe(PRIVATE_PUBKEY);
    expect(restored.skHex).toBe("");
    expect(restored.isEncrypted).toBe(true);
    expect(restored.isUnlocked).toBe(false);
    expect(deviceStorage.getItem("skHex")).toBeNull();
  });

  it("uses a legacy plaintext session once and purges it from persistent storage", async () => {
    deviceStorage.setItem("pkHex", PRIVATE_PUBKEY);
    deviceStorage.setItem("loginMethod", "private-key");
    deviceStorage.setItem("loginTimestamp", "1");
    deviceStorage.setItem("isEncrypted", "false");
    deviceStorage.setItem("skHex", PRIVATE_KEY);
    const store = createStore();

    await store.restoreSession();

    expect(store.pkHex).toBe(PRIVATE_PUBKEY);
    expect(store.skHex).toBe(PRIVATE_KEY);
    expect(store.isUnlocked).toBe(true);
    expect(deviceStorage.getItem("skHex")).toBeNull();
    expect(deviceStorage.getItem("pkHex")).toBeNull();
    expect(deviceStorage.getItem("loginMethod")).toBeNull();
  });
});
