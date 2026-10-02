import { describe, expect, it } from "vitest";
import {
  decryptRecoveryPrivateKey,
  deriveRecoveryKey,
  encryptRecoveryPrivateKey,
  isValidRecoveryPin,
  recoveryCryptoParameters,
} from "@/services/recovery/backupCrypto";

const PRIVATE_KEY = "01".padStart(64, "0");

describe("recovery backup crypto", () => {
  it("accepts only 6-8 digit recovery PINs", () => {
    expect(isValidRecoveryPin("123456")).toBe(true);
    expect(isValidRecoveryPin("12345678")).toBe(true);
    expect(isValidRecoveryPin("12345")).toBe(false);
    expect(isValidRecoveryPin("123456789")).toBe(false);
    expect(isValidRecoveryPin("12a456")).toBe(false);
  });

  it("round-trips a Google private-key backup without exposing the private key", async () => {
    const key = await deriveRecoveryKey("google", "google-sub-123", "123456");
    const payload = encryptRecoveryPrivateKey(PRIVATE_KEY, key, "google");

    expect(payload).not.toContain(PRIVATE_KEY);
    expect(payload).not.toContain("google-sub-123");
    expect(decryptRecoveryPrivateKey(payload, key, "google")).toBe(PRIVATE_KEY);
    key.fill(0);
  }, 20_000);

  it("isolates provider key derivation and rejects cross-provider decrypt", async () => {
    const googleKey = await deriveRecoveryKey("google", "same-subject", "654321");
    const appleKey = await deriveRecoveryKey("apple", "same-subject", "654321");

    expect(Array.from(googleKey)).not.toEqual(Array.from(appleKey));
    const payload = encryptRecoveryPrivateKey(PRIVATE_KEY, googleKey, "google");
    expect(() => decryptRecoveryPrivateKey(payload, appleKey, "apple")).toThrow();

    googleKey.fill(0);
    appleKey.fill(0);
  }, 20_000);

  it("pins the long-lived backup parameters", () => {
    expect(recoveryCryptoParameters).toEqual({
      version: 1,
      iterations: 600_000,
      pinDigits: "6-8",
    });
  });
});
