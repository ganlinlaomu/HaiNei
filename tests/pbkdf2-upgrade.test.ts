import "fake-indexeddb/auto";
import { createPinia, setActivePinia } from "pinia";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deviceStorage, putDeviceValue } from "@/services/deviceStorage";
import { removeDevicePrivateKey } from "@/services/devicePrivateKey";
import { useKeyStore } from "@/stores/keys";
import {
  decryptPrivateKey, encryptPrivateKey, needsKdfUpgrade, PBKDF2_ITERATIONS, retrieveEncryptedKey,
  type EncryptedData,
} from "@/utils/crypto";

const PRIVATE_KEY = "01".padStart(64, "0");
const PUBKEY = getPublicKey(hexToBytes(PRIVATE_KEY));
const PASSWORD = "local-password";
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A record as versions before 0.1.225 wrote it: 100,000 rounds, optionally without the field. */
async function legacyRecord(withIterationsField: boolean): Promise<EncryptedData> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    passwordKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(PRIVATE_KEY)));
  const record = { ciphertext: base64(ciphertext), salt: base64(salt), iv: base64(iv) } as EncryptedData;
  if (withIterationsField) record.iterations = 100_000;
  return record;
}

describe("password-protected key derivation", () => {
  it("encrypts new records with 600,000 rounds", async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const record = await encryptPrivateKey(PRIVATE_KEY, PASSWORD);
    expect(record.iterations).toBe(600_000);
    expect(needsKdfUpgrade(record)).toBe(false);
    await expect(decryptPrivateKey(record, PASSWORD)).resolves.toBe(PRIVATE_KEY);
  }, 30_000);

  it("still decrypts older records, also ones that never stored the round count", async () => {
    for (const withField of [true, false]) {
      const record = await legacyRecord(withField);
      expect(needsKdfUpgrade(record)).toBe(true);
      await expect(decryptPrivateKey(record, PASSWORD)).resolves.toBe(PRIVATE_KEY);
    }
  }, 30_000);

  it("rejects a tampered round count instead of running it", async () => {
    const record = await legacyRecord(true);
    for (const iterations of [1, 9_999, 50_000_000, 1.5, Number.NaN]) {
      await expect(decryptPrivateKey({ ...record, iterations }, PASSWORD)).rejects.toThrow("解密失败");
    }
  });
});

describe("upgrade on unlock", () => {
  beforeEach(async () => {
    deviceStorage.removeItem(`encrypted_sk_${PUBKEY}`);
    await removeDevicePrivateKey(PUBKEY);
    setActivePinia(createPinia());
  });

  async function unlockedWithLegacyRecord() {
    const store = useKeyStore();
    vi.spyOn(store, "loadAccountStores").mockResolvedValue(undefined);
    vi.spyOn(store, "resetAccountStores").mockImplementation(() => undefined);
    await store.loginWithNsec(PRIVATE_KEY, PASSWORD);
    const legacy = await legacyRecord(false);
    await putDeviceValue(`encrypted_sk_${PUBKEY}`, JSON.stringify(legacy));
    await store.unlockWithPassword(PASSWORD);
    expect(store.isUnlocked).toBe(true);
    return { store, legacy };
  }

  it("re-encrypts an older record with 600,000 rounds after a successful unlock", async () => {
    await unlockedWithLegacyRecord();
    await vi.waitFor(() => expect(retrieveEncryptedKey(PUBKEY)?.iterations).toBe(600_000), { timeout: 20_000, interval: 50 });
    // The upgraded record opens with the same password.
    await expect(decryptPrivateKey(retrieveEncryptedKey(PUBKEY)!, PASSWORD)).resolves.toBe(PRIVATE_KEY);
  }, 40_000);

  it("never overwrites a record that changed during the upgrade (e.g. a new password)", async () => {
    await unlockedWithLegacyRecord();
    // Written at once, while the upgrade is still deriving its 600,000-round
    // key: stands for a password change that lands first.
    const changed = { ciphertext: "changed", salt: "c2FsdA==", iv: "aXY=", iterations: 600_000 };
    await putDeviceValue(`encrypted_sk_${PUBKEY}`, JSON.stringify(changed));
    const before = Date.now();
    await vi.waitFor(() => expect(Date.now() - before).toBeGreaterThan(5_000), { timeout: 8_000, interval: 250 });
    expect(retrieveEncryptedKey(PUBKEY)?.ciphertext).toBe("changed");
  }, 40_000);
});
