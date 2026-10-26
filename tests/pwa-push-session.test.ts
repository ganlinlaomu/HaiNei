import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { reactive, watch as vueWatch, nextTick } from "vue";
import { accountBadgeCount, syncAppBadge, syncAppBadgeScope } from "@/utils/appBadge";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
async function scope(account: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function harness() {
  const handlers = new Map<string, (event: any) => void>();
  const cacheRows = new Map<string, Map<string, Response>>();
  const pending: Promise<unknown>[] = [];
  const notifications: Array<{ tag?: string; close: ReturnType<typeof vi.fn> }> = [];
  const showNotification = vi.fn(async (_title: string, options: { tag?: string }) => {
    notifications.push({ tag: options.tag, close: vi.fn() });
  });
  const caches = { open: async (name: string) => {
    let rows = cacheRows.get(name);
    if (!rows) cacheRows.set(name, rows = new Map());
    return {
      match: async (url: string) => rows!.get(url)?.clone(),
      put: async (url: string, response: Response) => { rows!.set(url, response.clone()); },
    };
  } };
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    navigator: { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) },
    clients: { matchAll: async () => [] },
    registration: { showNotification, getNotifications: vi.fn(async ({ tag }: { tag?: string } = {}) =>
      notifications.filter(n => (!tag || n.tag === tag) && n.close.mock.calls.length === 0)) },
  };
  runInNewContext(readFileSync("public/service-worker.js", "utf8"), { self, caches, URL, URLSearchParams, Response, console });
  const postMessage = (data: unknown) => handlers.get("message")!({ data, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
  const target = { clearAppBadge: vi.fn(async () => {}), setAppBadge: vi.fn(async () => {}),
    serviceWorker: { controller: { postMessage }, ready: Promise.resolve({ active: { postMessage } }) } } as any;
  return { target, pending, cacheRows, showNotification, notifications, backgroundSetAppBadge: self.navigator.setAppBadge,
    inbox: async (type: string, accountScope: string, ids: string[] = []) => {
      let value: any = null;
      handlers.get("message")!({
        data: { type, accountScope, ids },
        ports: [{ postMessage: (result: unknown) => { value = result; } }],
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      await nextTick();
      while (pending.length) await Promise.all(pending.splice(0));
      return value;
    },
    push: (payload: unknown) => {
    handlers.get("push")!({ data: { text: () => JSON.stringify(payload) }, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
  }, settle: async () => {
    await nextTick();
    while (pending.length) await Promise.all(pending.splice(0));
  } };
}
function watchApp(keys: { pkHex: string; isUnlocked: boolean; isRestored: boolean }, worker: ReturnType<typeof harness>, unread = 0) {
  const app = readFileSync("src/App.vue", "utf8");
  const start = app.indexOf("    watch(\n      () => [");
  const end = app.indexOf("\n    watch(", start + 1);
  let stop = () => {};
  runInNewContext(app.slice(start, end).replace("] as const", "]"), {
    keys,
    notifications: { loadedFor: ACCOUNT, unreadCount: unread },
    directMessages: { loadedFor: ACCOUNT, unreadCount: 0 },
    accountBadgeCount,
    syncAppBadge: (count: number, _target: unknown, account: string) => {
      const result = syncAppBadge(count, worker.target, account);
      worker.pending.push(result);
      return result;
    },
    syncAppBadgeScope: (account: string) => {
      const result = syncAppBadgeScope(account, worker.target);
      worker.pending.push(result);
      return result;
    },
    watch: (...args: Parameters<typeof vueWatch>) => { stop = (vueWatch as any)(...args); },
  });
  return () => stop();
}

describe("PWA push across account lock and restore", () => {
  it("routes push to the selected account even when the badge API rejects", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, OTHER);
    await worker.settle();
    worker.target.clearAppBadge.mockRejectedValue(new Error("badge denied"));
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    worker.push({ accountScope: await scope(ACCOUNT), notificationId: "badge-failure" });
    await worker.settle();
    expect(worker.showNotification).toHaveBeenCalledOnce();
  });

  it("allows redelivery after showNotification rejects and deduplicates only successful displays", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    const payload = { accountScope: await scope(ACCOUNT), notificationId: "retry-display" };
    worker.showNotification.mockRejectedValueOnce(new Error("display failed"));
    worker.push(payload);
    await expect(worker.settle()).rejects.toThrow("display failed");
    worker.push(payload);
    await worker.settle();
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    worker.push(payload);
    await worker.settle();
    expect(worker.showNotification).toHaveBeenCalledTimes(3);
    expect(worker.showNotification.mock.calls.at(-1)![1]).toMatchObject({ silent: true, tag: "hainei-rejected-push" });
    expect(worker.notifications.at(-1)!.close).toHaveBeenCalledOnce();
  });

  it("still shows the generic push while the remembered account is locked", async () => {
    const worker = harness();
    const keys = reactive({ pkHex: ACCOUNT, isUnlocked: true, isRestored: true });
    const stop = watchApp(keys, worker, 5);
    try {
      await worker.settle();
      expect(worker.target.setAppBadge).toHaveBeenLastCalledWith(5);
      keys.isUnlocked = false;
      await worker.settle();
      expect(worker.target.clearAppBadge).not.toHaveBeenCalled();
      worker.push({ type: "message", accountScope: await scope(ACCOUNT), notificationId: "locked-message" });
      await worker.settle();
      expect(worker.showNotification).toHaveBeenCalledWith("HaiNei", expect.objectContaining({ body: "你有新的私信消息" }));
      expect(worker.backgroundSetAppBadge).toHaveBeenLastCalledWith(6);
    } finally { stop(); }
  });

  it("preserves the existing scope while a cold startup is still restoring its account", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    const keys = reactive({ pkHex: "", isUnlocked: false, isRestored: false });
    const stop = watchApp(keys, worker);
    try {
      await worker.settle();
      worker.push({ type: "message", accountScope: await scope(ACCOUNT), notificationId: "restore-message" });
      await worker.settle();
      expect(worker.showNotification).toHaveBeenCalledOnce();
    } finally { stop(); }
  });

  it("suppresses a logged-out account and accepts only the newly selected locked account", async () => {
    const worker = harness();
    const keys = reactive({ pkHex: ACCOUNT, isUnlocked: true, isRestored: true });
    const stop = watchApp(keys, worker);
    try {
      await worker.settle();
      keys.pkHex = "";
      keys.isUnlocked = false;
      await worker.settle();
      worker.push({ type: "message", accountScope: await scope(ACCOUNT), notificationId: "logged-out" });
      await worker.settle();
      expect(worker.showNotification).toHaveBeenCalledOnce();
      expect(worker.showNotification.mock.calls[0][1]).toMatchObject({ silent: true, tag: "hainei-rejected-push" });
      expect(worker.notifications[0].close).toHaveBeenCalledOnce();
      keys.pkHex = OTHER;
      await worker.settle();
      worker.push({ type: "message", accountScope: await scope(ACCOUNT), notificationId: "old-account" });
      worker.push({ type: "message", accountScope: await scope(OTHER), notificationId: "new-account" });
      await worker.settle();
      expect(worker.showNotification).toHaveBeenCalledTimes(3);
      expect(worker.notifications[1].close).toHaveBeenCalledOnce();
      expect(worker.showNotification.mock.calls[1][1]).toMatchObject({ silent: true, tag: "hainei-rejected-push" });
      expect(worker.notifications[2].close).not.toHaveBeenCalled();
    } finally { stop(); }
  });
  it("caches opaque encrypted gift wraps and consumes them independently of notification taps", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    const accountScope = await scope(ACCOUNT);
    const eventId = "c".repeat(64);
    const notificationId = "d".repeat(64);
    const event = { id: eventId, kind: 1059, content: "opaque-encrypted-wrap", tags: [["p", ACCOUNT]] };
    worker.push({ type: "message", accountScope, notificationId,
      hint: { eventId, relays: ["wss://dm.test"], event } });
    await worker.settle();

    const result = await worker.inbox("GET_ENCRYPTED_PUSH_HINTS", accountScope);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].hint.event).toEqual(event);
    expect(result.entries[0].hint.event).not.toHaveProperty("plaintext");

    await worker.inbox("ACK_ENCRYPTED_PUSH_HINTS", accountScope, [notificationId]);
    expect((await worker.inbox("GET_ENCRYPTED_PUSH_HINTS", accountScope)).entries).toEqual([]);
  });

  it("purges encrypted cache on account switch, while preserving push notifications", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    const firstScope = await scope(ACCOUNT);
    const secondScope = await scope(OTHER);
    worker.push({ type: "message", accountScope: firstScope, notificationId: "e".repeat(64),
      hint: { eventId: "f".repeat(64), relays: ["wss://dm.test"] } });
    await worker.settle();
    expect((await worker.inbox("GET_ENCRYPTED_PUSH_HINTS", firstScope)).entries).toHaveLength(1);

    await syncAppBadge(0, worker.target, OTHER);
    await worker.settle();
    expect((await worker.inbox("GET_ENCRYPTED_PUSH_HINTS", firstScope)).entries).toEqual([]);
    expect((await worker.inbox("GET_ENCRYPTED_PUSH_HINTS", secondScope)).entries).toEqual([]);

    worker.push({ type: "message", accountScope: firstScope, notificationId: "1".repeat(64) });
    await worker.settle();
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.notifications[1].close).toHaveBeenCalledOnce();
    expect(worker.showNotification.mock.calls[1][1]).toMatchObject({ silent: true, tag: "hainei-rejected-push" });
  });


  it("displays and closes malformed pushes without recording seen IDs or incrementing badge", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    const validScope = await scope(ACCOUNT);
    worker.push({ type: "message", notificationId: "has-no-scope" });
    worker.push({ type: "message", accountScope: validScope });
    await worker.settle();
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.notifications.every(n => n.close.mock.calls.length === 1)).toBe(true);
    expect(worker.backgroundSetAppBadge).not.toHaveBeenCalled();
    worker.push({ type: "message", notificationId: "has-no-scope", accountScope: validScope });
    await worker.settle();
    expect(worker.notifications.at(-1)!.close).not.toHaveBeenCalled();
    expect(worker.showNotification.mock.calls.at(-1)![1]).not.toHaveProperty("silent", true);
  });
  it("prunes expired ciphertext hints before delivering to the app", async () => {
    const worker = harness();
    await syncAppBadge(0, worker.target, ACCOUNT);
    await worker.settle();
    const accountScope = await scope(ACCOUNT);
    worker.push({ type: "message", accountScope, notificationId: "9".repeat(64),
      hint: { eventId: "8".repeat(64), relays: ["wss://dm.test"] } });
    await worker.settle();
    const cache = worker.cacheRows.get("closed-community-pwa-runtime-state")!;
    const cacheUrl = "https://app.test/__hainei_push_inbox__";
    const entry = await cache.get(cacheUrl)!.json();
    entry.entries[0].at = Date.now() - 25 * 60 * 60 * 1000;
    cache.set(cacheUrl, new Response(JSON.stringify(entry)));
    expect((await worker.inbox("GET_ENCRYPTED_PUSH_HINTS", accountScope)).entries).toEqual([]);
  });

});
