import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

describe("PWA Service Worker third-party fetch handling", () => {
  function handler() {
    const handlers = new Map<string, (event: unknown) => void>();
    const origin = "https://pwa.lostr.space";
    const worker = {
      location: { origin },
      addEventListener: (type: string, callback: (event: unknown) => void) => { handlers.set(type, callback); },
    };
    const fetchStub = vi.fn();
    const source = readFileSync("public/service-worker.js", "utf8");
    runInNewContext(source, { self: worker, URL, Request, Response, Promise, console, fetch: fetchStub });
    return { handleFetch: handlers.get("fetch")!, fetchStub };
  }

  it("does not call respondWith for Gutenberg catalog when offline", () => {
    const { handleFetch, fetchStub } = handler();
    const respondWith = vi.fn();
    handleFetch({ request: new Request("https://gutendex.com/books/?search=Austen"), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("does not intercept Gutenberg cover-image requests", () => {
    const { handleFetch, fetchStub } = handler();
    const respondWith = vi.fn();
    handleFetch({ request: new Request("https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg"), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("continues to leave same-origin download API uncached", () => {
    const { handleFetch, fetchStub } = handler();
    const respondWith = vi.fn();
    handleFetch({ request: new Request("https://pwa.lostr.space/api/books/epub?url=foo"), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
