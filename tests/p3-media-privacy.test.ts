import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/nostr/crypto";
import { decodeEncryptedImageRef, encodeEncryptedImageRef } from "@/utils/encryptedImageRef";
import { decodeEncryptedVideoRef, encodeEncryptedVideoRef } from "@/utils/encryptedVideoRef";

const mocks = vi.hoisted(() => ({
  downloadMedia: vi.fn(),
}));

vi.mock("@/utils/mediaSafety", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/mediaSafety")>();
  return { ...actual, downloadMedia: mocks.downloadMedia };
});

import { MAX_AVATAR_LOAD_CONCURRENCY, loadPrivateProfileAvatar } from "@/utils/profileAvatar";
import { clearMemoryImageCache } from "@/utils/imageCache";

const ACCOUNT = "a".repeat(64);
const URL = "https://media.example/avatar.enc";

async function encryptedAvatar(plaintext: string, url = URL) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    encrypted,
    ref: encodeEncryptedImageRef({
      v: 1,
      url,
      mime: "image/jpeg",
      alg: "AES-GCM",
      iv: bytesToBase64(iv),
      key: bytesToBase64(raw),
    }),
  };
}

describe("P3 media privacy hardening", () => {
  beforeEach(() => {
    mocks.downloadMedia.mockReset();
    clearMemoryImageCache();
  });
  it("loads private avatars through the bounded cancellable media downloader", async () => {
    const { encrypted, ref } = await encryptedAvatar("private avatar bytes");
    const controller = new AbortController();
    mocks.downloadMedia.mockReset().mockResolvedValue(encrypted);

    const blob = await loadPrivateProfileAvatar(ACCOUNT, ref, controller.signal);

    expect(mocks.downloadMedia).toHaveBeenCalledWith(URL, 16 * 1024 * 1024, expect.any(AbortSignal));
    expect(await blob.text()).toBe("private avatar bytes");
  });

  it("shares one avatar download/decrypt across concurrent consumers and then hits memory cache", async () => {
    const { encrypted, ref } = await encryptedAvatar("shared avatar bytes");
    let release!: (value: ArrayBuffer) => void;
    mocks.downloadMedia.mockReturnValue(new Promise<ArrayBuffer>(resolve => { release = resolve; }));

    const first = loadPrivateProfileAvatar(ACCOUNT, ref);
    const second = loadPrivateProfileAvatar(ACCOUNT, ref);
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(1));

    release(encrypted);
    const [a, b] = await Promise.all([first, second]);
    expect(await a.text()).toBe("shared avatar bytes");
    expect(await b.text()).toBe("shared avatar bytes");

    await loadPrivateProfileAvatar(ACCOUNT, ref);
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps shared avatar work alive while another consumer still needs it", async () => {
    const { encrypted, ref } = await encryptedAvatar("shared cancellation bytes");
    const firstController = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    let release!: (value: ArrayBuffer) => void;
    mocks.downloadMedia.mockImplementation((_url, _maxBytes, signal) => {
      sharedSignal = signal;
      return new Promise<ArrayBuffer>(resolve => { release = resolve; });
    });

    const first = loadPrivateProfileAvatar(ACCOUNT, ref, firstController.signal);
    const second = loadPrivateProfileAvatar(ACCOUNT, ref);
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(1));

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);

    release(encrypted);
    expect(await (await second).text()).toBe("shared cancellation bytes");
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(1);
  });

  it("bounds different avatar downloads while preserving per-avatar dedupe", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: MAX_AVATAR_LOAD_CONCURRENCY + 1 }, (_, index) =>
        encryptedAvatar(`avatar-${index}`, `https://media.example/avatar-${index}.enc`)
      )
    );
    const byUrl = new Map(fixtures.map((fixture, index) => [
      `https://media.example/avatar-${index}.enc`,
      fixture.encrypted,
    ]));
    const releases = new Map<string, (value: ArrayBuffer) => void>();
    mocks.downloadMedia.mockImplementation((url: string) =>
      new Promise<ArrayBuffer>(resolve => { releases.set(url, resolve); })
    );

    const loads = fixtures.map(fixture => loadPrivateProfileAvatar(ACCOUNT, fixture.ref));
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(MAX_AVATAR_LOAD_CONCURRENCY));
    expect(MAX_AVATAR_LOAD_CONCURRENCY).toBe(4);

    const firstUrl = "https://media.example/avatar-0.enc";
    releases.get(firstUrl)?.(byUrl.get(firstUrl)!);
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(MAX_AVATAR_LOAD_CONCURRENCY + 1));

    for (const [url, release] of releases) release(byUrl.get(url)!);
    const blobs = await Promise.all(loads);
    expect(await Promise.all(blobs.map(blob => blob.text()))).toEqual(
      fixtures.map((_, index) => `avatar-${index}`)
    );
  });

  it("rejects unknown encrypted-media metadata fields before any media load", async () => {
    const rawKey = bytesToBase64(new Uint8Array(32));
    const iv = bytesToBase64(new Uint8Array(12));
    const image = encodeEncryptedImageRef({
      v: 1,
      url: "https://media.example/image.enc",
      mime: "image/jpeg",
      alg: "AES-GCM",
      iv,
      key: rawKey,
      unexpected: "must-not-be-accepted",
    } as any);
    const video = encodeEncryptedVideoRef({
      v: 1,
      url: "https://media.example/video.enc",
      mime: "video/mp4",
      alg: "AES-GCM",
      iv,
      key: rawKey,
      unexpected: "must-not-be-accepted",
    } as any);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(decodeEncryptedImageRef(image)).toBeNull();
      expect(decodeEncryptedVideoRef(video)).toBeNull();
      expect(mocks.downloadMedia).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("aborts avatar and shared image-decrypt work when its UI consumer leaves", () => {
    const avatar = readFileSync("src/components/ProfileAvatar.vue", "utf8");
    const preview = readFileSync("src/components/PostImagePreview.vue", "utf8");

    expect(avatar).toContain('ref="root"');
    expect(avatar).toContain("new IntersectionObserver");
    expect(avatar).toContain('rootMargin: "320px 0px"');
    expect(avatar).toContain("onActivated(() =>");
    expect(avatar).toContain("onDeactivated(() =>");
    expect(avatar).toContain("controller?.abort()");
    expect(avatar).toContain("requestController.signal");
    expect(avatar).toContain("if (active && nearVisible.value) requestVisibleAvatar()");
    expect(avatar).not.toContain("}, { immediate: true });");

    expect(preview).toContain("job.consumers += 1");
    expect(preview).toContain("loadController.abort()");
    expect(preview).toContain("getDecryptedBlob(accountAtStart, item.sourceUrl, priority, loadController.signal)");
    expect(preview).toContain("if (abortIfUnused && job.consumers === 0");
  });
});
