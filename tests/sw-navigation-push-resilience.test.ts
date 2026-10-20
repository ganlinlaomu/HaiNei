import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

async function scope(account: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Node builds Responses with type "default"; a browser same-origin fetch is "basic". */
function sameOrigin(body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

function worker(options: { fetch?: (request: any) => Promise<Response>; cacheFails?: boolean } = {}) {
  const handlers = new Map<string, (event: any) => void>();
  const rows = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const showNotification = vi.fn(async () => {});
  const keyOf = (request: any) => typeof request === "string" ? request : request.url;
  const cache = {
    match: async (request: any) => rows.get(keyOf(request))?.clone(),
    put: async (request: any, response: Response) => { rows.set(keyOf(request), response.clone()); },
    addAll: async () => {},
  };
  const caches = {
    open: async () => {
      if (options.cacheFails) throw new DOMException("quota", "QuotaExceededError");
      return cache;
    },
    match: async (request: any) => rows.get(keyOf(request))?.clone(),
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    navigator: { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) },
    clients: { matchAll: async () => [] },
    registration: { showNotification },
  };
  runInNewContext(readFileSync("public/service-worker.js", "utf8"), {
    self, caches, URL, Response, console, setTimeout, clearTimeout,
    fetch: options.fetch ?? (async () => new Response("network")),
  });
  return {
    rows, showNotification,
    navigate(url = "https://app.test/") {
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: { url, mode: "navigate", method: "GET" },
        respondWith: (value: Promise<Response>) => { response = value; },
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      return response!;
    },
    push(payload: unknown) {
      handlers.get("push")!({ data: { text: () => JSON.stringify(payload) }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    },
    settle: async () => { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}

afterEach(() => vi.useRealTimers());

describe("service worker navigation", () => {
  it("opens the cached shell at once on a stalled network, then refreshes the cache", async () => {
    let release!: (response: Response) => void;
    const sw = worker({ fetch: () => new Promise(resolve => { release = resolve; }) });
    sw.rows.set("https://app.test/", new Response("cached shell"));

    // No timer has to elapse: the cached page answers immediately.
    expect(await (await sw.navigate()).text()).toBe("cached shell");

    release(sameOrigin("fresh shell"));
    await sw.settle();
    expect(await sw.rows.get("https://app.test/")!.clone().text()).toBe("fresh shell");
  });

  it("never replaces the cached shell with an error page", async () => {
    const sw = worker({ fetch: async () => sameOrigin("server error", 500) });
    sw.rows.set("https://app.test/", new Response("cached shell"));
    expect(await (await sw.navigate()).text()).toBe("cached shell");
    await sw.settle();
    expect(await sw.rows.get("https://app.test/")!.clone().text()).toBe("cached shell");
  });

  it("uses the network page when nothing is cached yet", async () => {
    const sw = worker({ fetch: async () => sameOrigin("network page") });
    expect(await (await sw.navigate()).text()).toBe("network page");
    await sw.settle();
    expect(await sw.rows.get("https://app.test/")!.clone().text()).toBe("network page");
  });

  it("keeps waiting for the network when nothing is cached", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const sw = worker({ fetch: () => new Promise(resolve => { release = resolve; }) });
    const response = sw.navigate();
    await vi.advanceTimersByTimeAsync(5000);
    release(new Response("slow network page"));
    expect(await (await response).text()).toBe("slow network page");
  });

  it("opens the cached shell offline", async () => {
    const sw = worker({ fetch: async () => { throw new TypeError("offline"); } });
    sw.rows.set("https://app.test/", new Response("cached shell"));
    expect(await (await sw.navigate()).text()).toBe("cached shell");
  });

  it("still loads the page when CacheStorage is unavailable", async () => {
    const sw = worker({ fetch: async () => sameOrigin("network page"), cacheFails: true });
    expect(await (await sw.navigate()).text()).toBe("network page");
  });

  it("only caches successful same-origin pages", () => {
    const source = readFileSync("public/service-worker.js", "utf8");
    expect(source).toContain("if (response.ok && response.type === 'basic')");
    expect(source).toContain("event.waitUntil(network.then(() => storeCopy, () => {}));");
  });
});

describe("service worker push resilience", () => {
  it("still shows the notification when push state cannot be read", async () => {
    const sw = worker({ cacheFails: true });
    sw.push({ type: "message", accountScope: await scope("a".repeat(64)), notificationId: "1".repeat(64) });
    await sw.settle().catch(() => undefined);
    expect(sw.showNotification).toHaveBeenCalledWith("HaiNei", expect.objectContaining({ body: "你有新的私信消息" }));
  });
});
