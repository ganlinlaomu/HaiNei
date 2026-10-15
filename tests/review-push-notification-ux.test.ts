// Review finding #11: push notification behavior in the service worker.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(64);

async function scope(account: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

type FakeClient = {
  visibilityState: "visible" | "hidden";
  focused?: boolean;
  navigate: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};

function client(visibilityState: "visible" | "hidden", options: { focused?: boolean; navigateFails?: boolean } = {}): FakeClient {
  const self: FakeClient = {
    visibilityState,
    focused: options.focused ?? false,
    navigate: vi.fn(async () => {
      if (options.navigateFails) throw new TypeError("navigate on uncontrolled client");
      return self;
    }),
    focus: vi.fn(async () => self),
    postMessage: vi.fn(),
  };
  return self;
}

function worker(windows: FakeClient[] = []) {
  const handlers = new Map<string, (event: any) => void>();
  const rows = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const shown: Array<{ close: ReturnType<typeof vi.fn>; options: any }> = [];
  const showNotification = vi.fn(async (_title: string, options: any) => {
    const sameTag = shown.findIndex(item => item.options.tag && item.options.tag === options.tag);
    if (sameTag >= 0) shown.splice(sameTag, 1);
    shown.push({ close: vi.fn(), options });
  });
  const caches = { open: async () => ({
    match: async (url: string) => rows.get(url)?.clone(),
    put: async (url: string, response: Response) => { rows.set(url, response.clone()); },
  }) };
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    navigator: { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) },
    clients: { matchAll: async () => windows, openWindow },
    registration: {
      showNotification,
      getNotifications: vi.fn(async (filter?: { tag?: string }) =>
        shown.filter(item => !filter?.tag || item.options.tag === filter.tag)),
    },
  };
  runInNewContext(readFileSync("public/service-worker.js", "utf8"), { self, caches, URL, Response, console });
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return {
    showNotification, shown, openWindow,
    push: async (notificationId: string) => {
      handlers.get("push")!({
        data: { text: () => JSON.stringify({ notificationId, accountScope: windows.length >= 0 ? accountScope : "" }) },
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      await settle();
    },
    syncBadge: async (count: number) => {
      handlers.get("message")!({ data: { type: "SYNC_APP_BADGE", count, accountScope }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await settle();
    },
    click: async () => {
      const notification = { close: vi.fn(), data: { type: "message" } };
      handlers.get("notificationclick")!({ notification, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await settle();
    },
  };
}

let accountScope = "";

describe("review #11: push notification behavior", () => {
  it("collapses repeated DM pushes into one notification instead of piling them up", async () => {
    accountScope = await scope(ACCOUNT);
    const sw = worker([]);
    await sw.push("1".repeat(64));
    await sw.push("2".repeat(64));
    await sw.push("3".repeat(64));
    expect(sw.showNotification).toHaveBeenCalledTimes(3);
    const tags = new Set(sw.showNotification.mock.calls.map(([, options]) => options.tag));
    expect(tags.size).toBe(1);
    expect(sw.shown).toHaveLength(1);
    // A replacement while the app is in the background must still alert.
    expect(sw.showNotification.mock.calls.at(-1)![1]).toMatchObject({ renotify: true });
  });

  it("still displays (iOS requires it) but stays silent while an app window is visible", async () => {
    accountScope = await scope(ACCOUNT);
    const sw = worker([client("visible", { focused: true })]);
    await sw.push("4".repeat(64));
    expect(sw.showNotification).toHaveBeenCalledOnce();
    expect(sw.showNotification.mock.calls[0][1]).toMatchObject({ silent: true });
    expect(sw.showNotification.mock.calls[0][1].renotify).not.toBe(true);
  });

  it("closes the stale DM notification once the app reports zero unread", async () => {
    accountScope = await scope(ACCOUNT);
    const sw = worker([]);
    await sw.push("5".repeat(64));
    const [notification] = sw.shown;
    await sw.syncBadge(3);
    expect(notification.close).not.toHaveBeenCalled();
    await sw.syncBadge(0);
    expect(notification.close).toHaveBeenCalledOnce();
  });

  it("opens the conversation list in the visible window, not an arbitrary first client", async () => {
    accountScope = await scope(ACCOUNT);
    const background = client("hidden");
    const foreground = client("visible");
    const sw = worker([background, foreground]);
    await sw.click();
    expect(foreground.navigate).toHaveBeenCalledWith("https://app.test/#/conversations");
    expect(foreground.focus).toHaveBeenCalled();
    expect(background.navigate).not.toHaveBeenCalled();
  });

  it("falls back to a new window when the existing client cannot be navigated", async () => {
    accountScope = await scope(ACCOUNT);
    const uncontrolled = client("hidden", { navigateFails: true });
    const sw = worker([uncontrolled]);
    await sw.click();
    expect(sw.openWindow).toHaveBeenCalledWith("https://app.test/#/conversations");
  });
});
