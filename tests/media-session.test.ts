import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMediaSession, resetMediaSessionCacheForTests } from "@/services/mediaSession";
import { uploadImageToBlossom, uploadImageToBlossomWithFallback } from "@/utils/blossom";

class MockXMLHttpRequest {
  static responses: Array<{ status?: number; body?: string; pending?: boolean }> = [];
  static headers: Array<Record<string, string>> = [];
  static instances: MockXMLHttpRequest[] = [];
  static aborts = 0;
  readyState = 0;
  status = 0;
  responseText = "";
  upload = {};
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private requestHeaders: Record<string, string> = {};
  constructor() { MockXMLHttpRequest.instances.push(this); }
  open() {}
  abort() {
    MockXMLHttpRequest.aborts += 1;
    this.onabort?.();
  }
  getAllResponseHeaders() { return ""; }
  setRequestHeader(name: string, value: string) { this.requestHeaders[name] = value; }
  send() {
    MockXMLHttpRequest.headers.push({ ...this.requestHeaders });
    const response = MockXMLHttpRequest.responses.shift();
    if (!response) throw new Error("missing XHR response");
    if (response.pending) return;
    this.status = response.status || 0;
    this.responseText = response.body || "";
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

describe("HaiNei Worker media sessions", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const fetchMock = vi.fn<typeof fetch>();
  const signer = (pubkey: string) => vi.fn(async (event: any) => ({ ...event, pubkey, id: "id", sig: "f".repeat(128) }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    resetMediaSessionCacheForTests();
    fetchMock.mockReset();
    MockXMLHttpRequest.responses = [];
    MockXMLHttpRequest.headers = [];
    MockXMLHttpRequest.instances = [];
    MockXMLHttpRequest.aborts = 0;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    vi.stubGlobal("localStorage", { getItem: () => null });
  });

  afterEach(() => {
    resetMediaSessionCacheForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function queueSession(pubkey: string, token: string, expiresAt = 1_893_459_600) {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ challenge: "c".repeat(64), expiresAt: 1_893_456_300 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token, pubkey, scope: "upload", expiresAt }), { status: 201 }));
  }

  it("creates a signed Worker session and reuses its account-scoped cache", async () => {
    queueSession(A, "imgbed_upload_one");
    const sign = signer(A);
    const first = await getMediaSession("https://media.example", A, sign);
    const second = await getMediaSession("https://media.example", A, sign);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://app.example/api/auth/challenge");
    expect(fetchMock.mock.calls[1][0]).toBe("https://app.example/api/media/session");
    expect(sign.mock.calls[0][0]).toMatchObject({
      kind: 27235,
      tags: expect.arrayContaining([["t", "hainei_media_session"], ["challenge", "c".repeat(64)]]),
    });
  });

  it("never reuses Account A's token for Account B and refreshes expired sessions", async () => {
    queueSession(A, "imgbed_upload_a", 1_893_456_010);
    await getMediaSession("https://media.example", A, signer(A));
    queueSession(B, "imgbed_upload_b");
    expect((await getMediaSession("https://media.example", B, signer(B))).token).toBe("imgbed_upload_b");
    queueSession(A, "imgbed_upload_a2");
    vi.setSystemTime(new Date("2030-01-01T00:00:06Z"));
    expect((await getMediaSession("https://media.example", A, signer(A))).token).toBe("imgbed_upload_a2");
  });

  it("clears a rejected token and retries an upload only once", async () => {
    queueSession(A, "imgbed_upload_old");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    queueSession(A, "imgbed_upload_new");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push(
      { status: 401, body: JSON.stringify({ error: "expired_upload_token" }) },
      { status: 200, body: JSON.stringify({ url: "https://media.example/file" }) },
    );
    const result = await uploadImageToBlossom(new File(["data"], "file.txt", { type: "text/plain" }), {
      uploadUrl: "https://media.example/upload", serverBaseUrl: "https://media.example",
      accountPubkey: A, signEvent: signer(A), managedHaiNeiServer: true,
    });
    expect(result.url).toBe("https://media.example/file");
    expect(MockXMLHttpRequest.headers.map(headers => headers.Authorization)).toEqual([
      "Bearer imgbed_upload_old", "Bearer imgbed_upload_new",
    ]);
  });

  it("keeps custom servers on BUD-11 and never calls the Worker session routes", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push({ status: 200, body: JSON.stringify({ url: "https://custom.example/file" }) });
    await uploadImageToBlossom(new File(["data"], "file.txt", { type: "text/plain" }), {
      uploadUrl: "https://custom.example/upload", serverBaseUrl: "https://custom.example",
      accountPubkey: A, signEvent: signer(A), managedHaiNeiServer: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(call => String(call[0]).endsWith("/upload"))).toBe(true);
    expect(MockXMLHttpRequest.headers[0].Authorization).toMatch(/^Nostr /);
  });

  it("automatically uses the Worker-issued token for the managed default server", async () => {
    queueSession(A, "imgbed_upload_default");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push({ status: 200, body: JSON.stringify({ url: "https://default.example/file" }) });
    await uploadImageToBlossomWithFallback(new File(["data"], "file.txt", { type: "text/plain" }), {
      accountPubkey: A,
      signEvent: signer(A),
      servers: [{
        id: "default:blossom-imgbed.noster.workers.dev",
        type: "blossom",
        url: "https://blossom-imgbed.noster.workers.dev",
        source: "default",
      }],
    });
    expect(MockXMLHttpRequest.headers[0].Authorization).toBe("Bearer imgbed_upload_default");
  });

  it("settles a valid HTTP 2xx descriptor once without aborting", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push({ status: 200, body: JSON.stringify({ url: "https://media.example/file" }) });

    const result = await uploadImageToBlossom(new File(["data"], "file.txt", { type: "text/plain" }), {
      uploadUrl: "https://media.example/upload",
      uploadToken: "test-token",
    });

    expect(result.url).toBe("https://media.example/file");
    expect(MockXMLHttpRequest.aborts).toBe(0);
    MockXMLHttpRequest.instances[0].onabort?.();
    expect(MockXMLHttpRequest.aborts).toBe(0);
  });

  it("aborts only on timeout and reports the timeout phase once", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    MockXMLHttpRequest.responses.push({ pending: true });
    const upload = uploadImageToBlossom(new File(["data"], "file.txt", { type: "text/plain" }), {
      uploadUrl: "https://media.example/upload",
      uploadToken: "test-token",
      timeoutMs: 1000,
    });
    const rejected = expect(upload).rejects.toMatchObject({ phase: "put_timeout" });

    await vi.waitFor(() => expect(MockXMLHttpRequest.instances).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1000);

    await rejected;
    expect(MockXMLHttpRequest.aborts).toBe(1);
  });
});
