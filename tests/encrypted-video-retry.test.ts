import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptVideoBytes,
  decryptVideoToBlob,
  encryptVideoBytes,
  exportKeyToBase64,
  generateVideoEncryptionKey,
  importKeyFromBase64,
} from "@/utils/videoCrypto";

describe("encrypted video retry and crypto", () => {
  it("round-trips real AES-GCM video bytes with an exported/imported key", async () => {
    const original = new TextEncoder().encode("fake-video-container-bytes");
    const key = await generateVideoEncryptionKey();
    const encrypted = await encryptVideoBytes(key, original);
    const imported = await importKeyFromBase64(await exportKeyToBase64(key));
    const decrypted = await decryptVideoBytes(imported, encrypted);
    expect([...decrypted]).toEqual([...original]);
  });

  it("creates a typed video Blob URL and allows it to be released", async () => {
    const original = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const key = await generateVideoEncryptionKey();
    const encrypted = await encryptVideoBytes(key, original);
    const encryptedBytes = Uint8Array.from(atob(encrypted.ct), value => value.charCodeAt(0));
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn((blob: Blob) => {
      expect(blob.type).toBe("video/mp4");
      return "blob:video-test";
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    try {
      const url = await decryptVideoToBlob(encryptedBytes, key, encrypted.iv, "video/mp4");
      expect(url).toBe("blob:video-test");
      URL.revokeObjectURL(url);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:video-test");
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
    }
  });

  it("exposes a timeout-specific reload action and generation cleanup in the player", () => {
    const source = readFileSync(join(process.cwd(), "src/components/EncryptedVideoPlayer.vue"), "utf8");
    expect(source).toContain('e?.name === "TimeoutError"');
    expect(source).toContain("视频加载超时，请重新加载");
    expect(source).toContain('@click="retryLoad">重新加载</button>');
    expect(source).toContain("generation += 1;");
    expect(source).toContain("controller?.abort();");
    expect(source).toContain("URL.revokeObjectURL(decryptedUrl.value)");
    expect(source).toContain('@loadedmetadata="onVideoLoaded"');
  });
});
