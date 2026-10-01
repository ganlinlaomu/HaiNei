import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  lockLocalVault,
  openLocalVaultBytes,
  sealLocalVaultBytes,
  unlockLocalVault,
} from "@/services/localVault";

const ACCOUNT = "a".repeat(64);
const PRIVATE_KEY = "1".repeat(64);

afterEach(() => {
  lockLocalVault(ACCOUNT);
});

describe("encrypted media cache vault", () => {
  it("seals cached media bytes and requires the unlocked account key to reopen them", async () => {
    await unlockLocalVault(ACCOUNT, PRIVATE_KEY);
    const plain = new TextEncoder().encode("private cached image bytes");
    const input = plain.slice().buffer;

    const sealed = await sealLocalVaultBytes(
      ACCOUNT,
      "media-cache",
      "cache-id",
      "image/jpeg",
      input,
    );

    expect(sealed.bytes.byteLength).toBeGreaterThan(input.byteLength);
    expect(Array.from(new Uint8Array(sealed.bytes))).not.toEqual(Array.from(new Uint8Array(input)));

    const opened = await openLocalVaultBytes(
      ACCOUNT,
      "media-cache",
      "cache-id",
      "image/jpeg",
      input.byteLength,
      sealed.iv,
      sealed.bytes,
    );
    expect(new TextDecoder().decode(opened)).toBe("private cached image bytes");

    lockLocalVault(ACCOUNT);
    await expect(openLocalVaultBytes(
      ACCOUNT,
      "media-cache",
      "cache-id",
      "image/jpeg",
      input.byteLength,
      sealed.iv,
      sealed.bytes,
    )).rejects.toThrow("local_vault_locked");
  });

  it("uses a hashed persistent key, 48 MB L1, and 256 MB encrypted L2", () => {
    const cache = readFileSync("src/utils/imageCache.ts", "utf8");
    const schema = readFileSync("src/db/dexie.ts", "utf8");
    const repository = readFileSync("src/repositories/imageCacheRepository.ts", "utf8");

    expect(cache).toContain("IMAGE_MEMORY_CACHE_MAX_BYTES = 48 * 1024 * 1024");
    expect(cache).toContain("IMAGE_PERSISTENT_CACHE_MAX_BYTES = 256 * 1024 * 1024");
    expect(cache).toContain('"SHA-256"');
    expect(cache).toContain('"media-cache"');
    expect(schema).toContain("[accountPubkey+cacheId]");
    expect(schema).toContain("[accountPubkey+lastAccess]");
    expect(repository).toContain("trimToBytes");
    expect(repository).not.toContain("blob:");
  });
});
