import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMedia } from "@/utils/mediaSafety";

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

describe("media download budget", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("applies the 20 second budget while waiting for response headers", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    })));
    const pending = downloadMedia("https://media.example/video.enc", 1024);
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError", message: "media_download_timeout" });

    await vi.advanceTimersByTimeAsync(20_000);

    await rejected;
  });

  it("keeps the same budget active while streaming the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          init?.signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
        }
      });
      return new Response(stream, { status: 200 });
    }));
    const pending = downloadMedia("https://media.example/video.enc", 1024);
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(20_000);

    await rejected;
  });

  it("preserves caller cancellation as AbortError instead of TimeoutError", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    })));
    const controller = new AbortController();
    const pending = downloadMedia("https://media.example/video.enc", 1024, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "media_download_aborted" });

    controller.abort();

    await rejected;
  });

  it("retains the streamed download size limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })));
    await expect(downloadMedia("https://media.example/video.enc", 3)).rejects.toThrow("media_too_large");
  });
});
