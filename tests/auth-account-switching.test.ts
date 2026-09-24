import "fake-indexeddb/auto";
import { createPinia, setActivePinia } from "pinia";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectWithPomegranate = vi.hoisted(() => vi.fn());

vi.mock("@/services/pomegranateAuth", async importOriginal => {
  const actual = await importOriginal<typeof import("@/services/pomegranateAuth")>();
  return { ...actual, connectWithPomegranate };
});

import { listDeviceAccounts } from "@/services/accountRegistry";
import { deviceStorage } from "@/services/deviceStorage";
import { useKeyStore } from "@/stores/keys";
import { hasEncryptedKey } from "@/utils/crypto";

const GOOGLE_PUBKEY = "a".repeat(64);
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

function signer(pubkey = GOOGLE_PUBKEY) {
  return {
    getPublicKey: vi.fn(async () => pubkey),
    signEvent: vi.fn(async event => ({ ...event, pubkey, id: "b".repeat(64), sig: "c".repeat(128) })),
    nip44: {
      encrypt: vi.fn(async (_peer: string, plaintext: string) => `encrypted:${plaintext}`),
      decrypt: vi.fn(async (_peer: string, ciphertext: string) => ciphertext.replace("encrypted:", "")),
    },
    disconnect: vi.fn(),
  };
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
  connectWithPomegranate.mockReset();
});

describe("Google and private-key authentication", () => {
  it("logs in with a fully capable Google signer and adapts signing and NIP-44", async () => {
    const store = createStore();
    const googleSigner = signer();

    await store.loginWithGoogleSigner(GOOGLE_PUBKEY, googleSigner);

    expect(store.loginMethod).toBe("google");
    expect(store.pkHex).toBe(GOOGLE_PUBKEY);
    await store.signEvent({ kind: 1, created_at: 1, content: "hello", tags: [] });
    await expect(store.nip44Encrypt("d".repeat(64), "hello")).resolves.toBe("encrypted:hello");
    await expect(store.nip44Decrypt("d".repeat(64), "encrypted:hello")).resolves.toBe("hello");
    expect(googleSigner.signEvent).toHaveBeenCalledOnce();
  });

  it("rejects Google login when NIP-44 is unavailable", async () => {
    const store = createStore();
    const incompleteSigner = {
      getPublicKey: vi.fn(async () => GOOGLE_PUBKEY),
      signEvent: vi.fn(),
    };

    await expect(store.loginWithGoogleSigner(GOOGLE_PUBKEY, incompleteSigner)).rejects.toThrow("NIP-44");
    expect(store.pkHex).toBe("");
  });

  it("switches to an encrypted private-key account and unlocks without nsec re-entry", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");
    store.clearActiveSession();

    await expect(store.selectRememberedAccount(PRIVATE_PUBKEY)).resolves.toBe("unlock");
    expect(store.skHex).toBe("");
    expect(store.isUnlocked).toBe(false);
    await store.unlockWithPassword("local-password");
    expect(store.skHex).toBe(PRIVATE_KEY);
    expect(store.isUnlocked).toBe(true);
  });

  it("keeps Google and private-key accounts together in the device registry", async () => {
    const store = createStore();
    await store.loginWithGoogleSigner(GOOGLE_PUBKEY, signer());
    await store.loginWithNsec(PRIVATE_KEY, "local-password");

    expect(listDeviceAccounts().map(account => account.authType).sort()).toEqual(["google", "private-key"]);
  });

  it("deduplicates the same pubkey instead of creating another local account", async () => {
    const store = createStore();
    await store.loginWithGoogleSigner(GOOGLE_PUBKEY, signer());
    await store.loginWithGoogleSigner(GOOGLE_PUBKEY, signer());

    expect(listDeviceAccounts()).toHaveLength(1);
    expect(listDeviceAccounts()[0].pubkey).toBe(GOOGLE_PUBKEY);
  });

  it("preserves the encrypted key while switching away", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");
    store.clearActiveSession();

    expect(hasEncryptedKey(PRIVATE_PUBKEY)).toBe(true);
    expect(listDeviceAccounts()[0]).toMatchObject({ pubkey: PRIVATE_PUBKEY, hasEncryptedKey: true });
  });

  it("deletes only the local encrypted key and registry entry on explicit removal", async () => {
    const store = createStore();
    await store.loginWithNsec(PRIVATE_KEY, "local-password");

    store.removeAccountFromDevice(PRIVATE_PUBKEY);

    expect(hasEncryptedKey(PRIVATE_PUBKEY)).toBe(false);
    expect(listDeviceAccounts()).toEqual([]);
  });
});

describe("session restoration", () => {
  it.each(["nip07", "nip46"])("clears a stale %s session", async staleMethod => {
    deviceStorage.setItem("pkHex", GOOGLE_PUBKEY);
    deviceStorage.setItem("loginMethod", staleMethod);
    const store = createStore();

    await store.restoreSession();

    expect(store.pkHex).toBe("");
    expect(store.loginMethod).toBe("");
    expect(deviceStorage.getItem("pkHex")).toBeNull();
  });

  it("runs concurrent restore calls only once", async () => {
    deviceStorage.setItem("pkHex", GOOGLE_PUBKEY);
    deviceStorage.setItem("loginMethod", "google");
    deviceStorage.setItem("loginTimestamp", "1");
    deviceStorage.setItem("isEncrypted", "false");
    const googleSigner = signer();
    let release!: (value: { pubkey: string; signer: ReturnType<typeof signer> }) => void;
    connectWithPomegranate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const store = createStore();

    const first = store.restoreSession();
    const second = store.restoreSession();
    expect(connectWithPomegranate).toHaveBeenCalledTimes(1);
    release({ pubkey: GOOGLE_PUBKEY, signer: googleSigner });
    await Promise.all([first, second]);

    expect(connectWithPomegranate).toHaveBeenCalledTimes(1);
    expect(store.loginMethod).toBe("google");
  });
});
