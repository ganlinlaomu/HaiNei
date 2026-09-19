import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHaiNeiAccessTokenCacheForTests, uploadImageToBlossom } from "@/utils/blossom";

type XhrResponse = {
  status: number;
  body?: string;
  responseHeaders?: string;
};

class MockXMLHttpRequest {
  static responses: XhrResponse[] = [];
  static sentHeaders: Array<Record<string, string>> = [];

  readyState = 0;
  status = 0;
  responseText = "";
  upload = {};
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};
  private responseHeaders = "";

  open() {}

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  getAllResponseHeaders() {
    return this.responseHeaders;
  }

  abort() {}

  send() {
    MockXMLHttpRequest.sentHeaders.push({ ...this.headers });
    const next = MockXMLHttpRequest.responses.shift();
    if (!next) throw new Error("missing mock xhr response");
    this.status = next.status;
    this.responseText = next.body || "";
    this.responseHeaders = next.responseHeaders || "";
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

describe("HaiNei Access upload authorization", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const signEvent = vi.fn(async (evt: any) => ({
    ...evt,
    id: "signed-event-id",
    pubkey: "a".repeat(64),
    sig: "b".repeat(128)
  }));

  beforeEach(() => {
    resetHaiNeiAccessTokenCacheForTests();
    MockXMLHttpRequest.responses = [];
    MockXMLHttpRequest.sentHeaders = [];
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: () => null
    });
    fetchMock.mockReset();
    signEvent.mockClear();
  });

  afterEach(() => {
    resetHaiNeiAccessTokenCacheForTests();
    vi.unstubAllGlobals();
  });

  it("exchanges the current Nostr identity for a short-lived bearer token", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "c".repeat(64),
        expiresAt: 2_000_000_000,
        ttlSeconds: 300
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "hainei-token-1",
        scope: "blossom:upload",
        pubkey: "a".repeat(64),
        issuedAt: 1_900_000_000,
        expiresAt: 1_900_003_600
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "X-Reason": "ok" } }));
    MockXMLHttpRequest.responses.push({
      status: 200,
      body: JSON.stringify({ url: "https://media.example/file.png" })
    });

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const uploaded = await uploadImageToBlossom(file, {
      uploadUrl: "https://media.example/upload",
      serverBaseUrl: "https://media.example",
      accountPubkey: "a".repeat(64),
      signEvent
    });

    expect(uploaded.url).toBe("https://media.example/file.png");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://media.example/api/hainei/challenge");
    expect(fetchMock.mock.calls[1][0]).toBe("https://media.example/api/hainei/token");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "HEAD",
      headers: expect.objectContaining({
        Authorization: ["Bearer", "hainei-token-1"].join(" ")
      })
    });
    expect(MockXMLHttpRequest.sentHeaders[0].Authorization).toBe(["Bearer", "hainei-token-1"].join(" "));
    expect(signEvent).toHaveBeenCalledTimes(1);
    expect(signEvent.mock.calls[0][0]).toMatchObject({
      kind: 24242,
      tags: expect.arrayContaining([
        ["t", "hainei_access"],
        ["challenge", "c".repeat(64)],
        ["server", "media.example"]
      ])
    });
  });

  it("reuses a cached HaiNei token until it expires", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "d".repeat(64),
        expiresAt: 2_000_000_000,
        ttlSeconds: 300
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "hainei-token-cache",
        scope: "blossom:upload",
        pubkey: "a".repeat(64),
        issuedAt: 1_900_000_000,
        expiresAt: 4_102_444_800
      }), { status: 201 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push(
      { status: 200, body: JSON.stringify({ url: "https://media.example/1.png" }) },
      { status: 200, body: JSON.stringify({ url: "https://media.example/2.png" }) }
    );

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    await uploadImageToBlossom(file, {
      uploadUrl: "https://media.example/upload",
      serverBaseUrl: "https://media.example",
      accountPubkey: "a".repeat(64),
      signEvent
    });
    await uploadImageToBlossom(file, {
      uploadUrl: "https://media.example/upload",
      serverBaseUrl: "https://media.example",
      accountPubkey: "a".repeat(64),
      signEvent
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("/api/hainei/")).length).toBe(2);
    expect(MockXMLHttpRequest.sentHeaders).toHaveLength(2);
    expect(MockXMLHttpRequest.sentHeaders.every(headers => headers.Authorization === ["Bearer", "hainei-token-cache"].join(" "))).toBe(true);
    expect(signEvent).toHaveBeenCalledTimes(1);
  });

  it("refreshes the HaiNei token after a 401 upload response", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "e".repeat(64),
        expiresAt: 2_000_000_000,
        ttlSeconds: 300
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "expired-token",
        scope: "blossom:upload",
        pubkey: "a".repeat(64),
        issuedAt: 1_900_000_000,
        expiresAt: 4_102_444_800
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "f".repeat(64),
        expiresAt: 2_000_000_300,
        ttlSeconds: 300
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "fresh-token",
        scope: "blossom:upload",
        pubkey: "a".repeat(64),
        issuedAt: 1_900_000_100,
        expiresAt: 4_102_444_900
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push(
      { status: 401, body: JSON.stringify({ error: "expired_hainei_token" }) },
      { status: 200, body: JSON.stringify({ url: "https://media.example/retried.png" }) }
    );

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const uploaded = await uploadImageToBlossom(file, {
      uploadUrl: "https://media.example/upload",
      serverBaseUrl: "https://media.example",
      accountPubkey: "a".repeat(64),
      signEvent
    });

    expect(uploaded.url).toBe("https://media.example/retried.png");
    expect(MockXMLHttpRequest.sentHeaders).toHaveLength(2);
    expect(MockXMLHttpRequest.sentHeaders[0].Authorization).toBe(["Bearer", "expired-token"].join(" "));
    expect(MockXMLHttpRequest.sentHeaders[1].Authorization).toBe(["Bearer", "fresh-token"].join(" "));
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("/api/hainei/challenge"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("/api/hainei/token"))).toHaveLength(2);
    expect(signEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects a token response bound to a different pubkey", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challenge: "1".repeat(64),
        expiresAt: 2_000_000_000,
        ttlSeconds: 300
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "wrong-pubkey-token",
        scope: "blossom:upload",
        pubkey: "b".repeat(64),
        issuedAt: 1_900_000_000,
        expiresAt: 4_102_444_800
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    await expect(uploadImageToBlossom(file, {
      uploadUrl: "https://media.example/upload",
      serverBaseUrl: "https://media.example",
      accountPubkey: "a".repeat(64),
      signEvent
    })).rejects.toThrow(/HTTP 401/);
    expect(MockXMLHttpRequest.sentHeaders).toHaveLength(0);
    expect(signEvent).toHaveBeenCalledTimes(2);
  });
});
