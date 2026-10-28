import { describe, it, expect, afterEach, vi } from "vitest";
import { onRequestGet } from "../functions/api/books/epub";

afterEach(() => vi.unstubAllGlobals());

function request(url: string) {
  return { request: new Request("https://pwa.lostr.space/api/books/epub?url=" + encodeURIComponent(url)) };
}
describe("Gutenberg EPUB same-origin gateway", () => {
  it("rejects arbitrary external hosts without contacting them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await onRequestGet(request("https://attacker.example/book.epub"));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects redirects outside the Gutenberg allowlist", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "https://attacker.example/book.epub" },
    }));
    vi.stubGlobal("fetch",fetchMock);
    const response = await onRequestGet(request("https://www.gutenberg.org/ebooks/1342.epub3.images"));
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("passes through a small valid ZIP payload with no caching", async () => {
    const payload = new Uint8Array(128);
    payload[0] = 0x50; payload[1] = 0x4b;
    vi.stubGlobal("fetch",vi.fn(async () => new Response(payload,{status:200})));
    const response = await onRequestGet(request("https://www.gutenberg.org/ebooks/1342.epub3.images"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/epub+zip");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect((await response.arrayBuffer()).byteLength).toBe(128);
  });
});