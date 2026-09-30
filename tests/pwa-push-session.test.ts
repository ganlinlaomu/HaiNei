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
  const showNotification = vi.fn(async () => {});
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
    registration: { showNotification },
  };
  runInNewContext(readFileSync("public/service-worker.js", "utf8"), { self, caches, URL, Response, console });
  const postMessage = (data: unknown) => handlers.get("message")!({ data, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
  const target = { clearAppBadge: vi.fn(async () => {}), setAppBadge: vi.fn(async () => {}),
    serviceWorker: { controller: { postMessage }, ready: Promise.resolve({ active: { postMessage } }) } } as any;
  return { target, pending, showNotification, backgroundSetAppBadge: self.navigator.setAppBadge, push: (payload: unknown) => {
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
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
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
      expect(worker.showNotification).not.toHaveBeenCalled();
      keys.pkHex = OTHER;
      await worker.settle();
      worker.push({ type: "message", accountScope: await scope(ACCOUNT), notificationId: "old-account" });
      worker.push({ type: "message", accountScope: await scope(OTHER), notificationId: "new-account" });
      await worker.settle();
      expect(worker.showNotification).toHaveBeenCalledOnce();
    } finally { stop(); }
  });
});
