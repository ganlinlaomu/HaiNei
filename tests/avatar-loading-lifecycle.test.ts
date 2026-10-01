import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/nostr/crypto";
import { encodeEncryptedImageRef } from "@/utils/encryptedImageRef";

const mocks = vi.hoisted(() => ({
  downloadMedia: vi.fn(),
}));

vi.mock("@/utils/mediaSafety", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/mediaSafety")>();
  return { ...actual, downloadMedia: mocks.downloadMedia };
});

import { clearMemoryImageCache } from "@/utils/imageCache";
import { loadPrivateProfileAvatar, MAX_AVATAR_LOAD_CONCURRENCY } from "@/utils/profileAvatar";

const ACCOUNT = "a".repeat(64);

async function avatarFixture(url: string) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode("avatar"),
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

describe("avatar viewport loading", () => {
  beforeEach(() => {
    clearMemoryImageCache();
    mocks.downloadMedia.mockReset();
  });

  it("caps different avatar downloads while retaining per-reference sharing", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: MAX_AVATAR_LOAD_CONCURRENCY + 1 }, (_, index) =>
        avatarFixture(`https://media.example/avatar-${index}.enc`)
      )
    );
    const pending = new Map<string, (bytes: ArrayBuffer) => void>();
    let active = 0;
    let maxActive = 0;

    mocks.downloadMedia.mockImplementation((url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<ArrayBuffer>(resolve => {
        pending.set(url, bytes => {
          active -= 1;
          resolve(bytes);
        });
      });
    });

    const loads = fixtures.map(item => loadPrivateProfileAvatar(ACCOUNT, item.ref));
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(MAX_AVATAR_LOAD_CONCURRENCY));
    expect(maxActive).toBe(MAX_AVATAR_LOAD_CONCURRENCY);

    const firstUrl = `https://media.example/avatar-0.enc`;
    pending.get(firstUrl)?.(fixtures[0].encrypted);
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(fixtures.length));
    expect(maxActive).toBe(MAX_AVATAR_LOAD_CONCURRENCY);

    for (let index = 1; index < fixtures.length; index++) {
      pending.get(`https://media.example/avatar-${index}.enc`)?.(fixtures[index].encrypted);
    }
    await Promise.all(loads);
  });

  it("allows an immediate retry after the last consumer aborts a shared avatar job", async () => {
    const fixture = await avatarFixture("https://media.example/avatar-retry.enc");
    let call = 0;
    mocks.downloadMedia.mockImplementation((_url: string, _maxBytes: number, signal: AbortSignal) => {
      call += 1;
      if (call === 1) {
        return new Promise<ArrayBuffer>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(fixture.encrypted);
    });

    const controller = new AbortController();
    const first = loadPrivateProfileAvatar(ACCOUNT, fixture.ref, controller.signal);
    await vi.waitFor(() => expect(mocks.downloadMedia).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const second = await loadPrivateProfileAvatar(ACCOUNT, fixture.ref);
    expect(await second.text()).toBe("avatar");
    expect(mocks.downloadMedia).toHaveBeenCalledTimes(2);
  });

  it("does not request avatar bytes until the component is near the viewport and cancels on lifecycle changes", () => {
    const source = readFileSync("src/components/ProfileAvatar.vue", "utf8");
    expect(source).toContain('ref="root"');
    expect(source).toContain("observeNearViewport");
    expect(source).toContain("if (!componentActive || !nearViewport.value) return");
    expect(source).toContain("onActivated(() =>");
    expect(source).toContain("onDeactivated(() =>");
    expect(source).toContain("abortPending()");
    expect(source).toContain("privateProfile.value?.avatar !== avatar");
    expect(source).not.toContain("}, { immediate: true });");
  });

  it("uses one shared observer instead of one IntersectionObserver per avatar instance", () => {
    const source = readFileSync("src/utils/nearViewportObserver.ts", "utf8");
    expect(source).toContain("let observer: IntersectionObserver | null = null");
    expect(source).toContain('rootMargin: "240px 0px"');
    expect(source).toContain("callbacks.delete(element)");
    expect(source).toContain("activeObserver.unobserve(element)");
  });
});
