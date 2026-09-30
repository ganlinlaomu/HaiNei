import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/nostr/crypto";
import { decodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { decodeEncryptedVideoRef } from "@/utils/encryptedVideoRef";
import { sanitizeDebugData } from "@/utils/debugSanitizer";

function encoded(prefix: string, value: unknown) {
  return `${prefix}${bytesToBase64(new TextEncoder().encode(JSON.stringify(value)))}`;
}

describe("encrypted media diagnostic redaction", () => {
  it("never writes encrypted image keys or refs to direct console diagnostics", () => {
    const key = "VERY_SECRET_IMAGE_KEY";
    const ref = encoded("blossom+aesgcm:", {
      v: 1,
      url: "https://media.example/private-image",
      mime: "image/jpeg",
      alg: "INVALID",
      iv: "VERY_SECRET_IMAGE_IV",
      key,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decodeEncryptedImageRef(ref)).toBeNull();
    const output = JSON.stringify(error.mock.calls);
    expect(output).not.toContain(key);
    expect(output).not.toContain("VERY_SECRET_IMAGE_IV");
    expect(output).not.toContain(ref);
    expect(output).not.toContain("https://media.example/private-image");
    error.mockRestore();
  });

  it("never writes encrypted video keys or refs to direct console diagnostics", () => {
    const key = "VERY_SECRET_VIDEO_KEY";
    const ref = encoded("blossom+aesgcm+video:", {
      v: 1,
      url: "https://media.example/private-video",
      mime: "video/mp4",
      alg: "INVALID",
      iv: "VERY_SECRET_VIDEO_IV",
      key,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decodeEncryptedVideoRef(ref)).toBeNull();
    const output = JSON.stringify(error.mock.calls);
    expect(output).not.toContain(key);
    expect(output).not.toContain("VERY_SECRET_VIDEO_IV");
    expect(output).not.toContain(ref);
    expect(output).not.toContain("https://media.example/private-video");
    error.mockRestore();
  });

  it("redacts encrypted media references embedded in exported debug strings", () => {
    const secretRef = "blossom+aesgcm+video:U0VDUkVUX0tFWV9NQVRFUklBTA==";
    const sanitized = sanitizeDebugData({ message: `failed to parse ${secretRef}` });
    expect(JSON.stringify(sanitized)).toContain("[redacted-encrypted-media-ref]");
    expect(JSON.stringify(sanitized)).not.toContain(secretRef);
  });
});
