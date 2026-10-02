import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasDevicePrivateKey,
  removeDevicePrivateKey,
  storeDevicePrivateKey,
  unlockDevicePrivateKey,
} from "@/services/devicePrivateKey";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const PRIVATE_A = "01".padStart(64, "0");
const PRIVATE_B = "02".padStart(64, "0");

afterEach(async () => {
  await Promise.all([removeDevicePrivateKey(ACCOUNT_A), removeDevicePrivateKey(ACCOUNT_B)]);
});

describe("device private-key storage", () => {
  it("keeps account credentials isolated and removes only the requested account", async () => {
    await storeDevicePrivateKey(ACCOUNT_A, PRIVATE_A);
    await storeDevicePrivateKey(ACCOUNT_B, PRIVATE_B);

    expect(await unlockDevicePrivateKey(ACCOUNT_A)).toBe(PRIVATE_A);
    expect(await unlockDevicePrivateKey(ACCOUNT_B)).toBe(PRIVATE_B);

    await removeDevicePrivateKey(ACCOUNT_A);
    expect(await hasDevicePrivateKey(ACCOUNT_A)).toBe(false);
    expect(await unlockDevicePrivateKey(ACCOUNT_B)).toBe(PRIVATE_B);
  });

  it("stores an encrypted credential behind a non-exportable wrapping key", async () => {
    await storeDevicePrivateKey(ACCOUNT_A, PRIVATE_A);

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("hainei_device_credentials", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction("privateKeys", "readonly");
      const request = transaction.objectStore("privateKeys").get(ACCOUNT_A);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();

    expect(record).not.toHaveProperty("privateKeyHex");
    expect(record.ciphertext).toBeInstanceOf(ArrayBuffer);
    expect(record.wrappingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", record.wrappingKey)).rejects.toBeDefined();
  });
});
