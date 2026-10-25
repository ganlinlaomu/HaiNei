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
  const shown: Array<{ close: ReturnType<typeof vi.fn>; options: any; data: any }> = [];
  const showNotification = vi.fn(async (_title: string, options: any) => {
    const sameTag = shown.findIndex(item => item.options.tag && item.options.tag === options.tag);
    if (sameTag >= 0) shown.splice(sameTag, 1);
    shown.push({ close: vi.fn(), options, data: options.data });
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
        shown.filter(item => !item.close.mock.calls.length && (!filter?.tag || item.options.tag === filter.tag))),
    },
  };
  runInNewContext(readFileSync("public/service-worker.js", "utf8"), { self, caches, URL, Response, console });
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return {
    showNotification, shown, openWindow,
    push: async (notificationId: string, type = "message") => {
      handlers.get("push")!({
        data: { text: () => JSON.stringify({ type, notificationId, accountScope: windows.length >= 0 ? accountScope : "" }) },
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      await settle();
    },
    syncBadge: async (count: number) => {
      handlers.get("message")!({ data: { type: "SYNC_APP_BADGE", count, accountScope }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await settle();
    },
    callMessage: async (type: string, visibilityState: string) => {
      handlers.get("message")!({ data: { type, callId: "c".repeat(32) },
        source: { visibilityState }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await settle();
    },
    click: async (type = "message") => {
      const notification = { close: vi.fn(), data: { type } };
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

  it("keeps an unclaimed call push audible and visible even with a visible window", async () => {
    accountScope = await scope(ACCOUNT);
    const sw = worker([client("visible", { focused: true })]);
    await sw.push("6".repeat(64), "call");
    expect(sw.showNotification).toHaveBeenCalledOnce();
    expect(sw.shown[0].options).toMatchObject({ body: "你有一个语音来电", requireInteraction: true, renotify: true });
    expect(sw.shown[0].options.silent).not.toBe(true);
    expect(sw.shown[0].close).not.toHaveBeenCalled();
    // Repeated provider delivery of the same push cannot create another alert.
    await sw.push("6".repeat(64), "call");
    expect(sw.showNotification).toHaveBeenCalledOnce();
  });

  it("shows a background call and focuses the existing session without navigation", async () => {
    accountScope = await scope(ACCOUNT);
    const background = client("hidden");
    const sw = worker([background]);
    await sw.push("7".repeat(64), "call");
    expect(sw.shown[0].close).not.toHaveBeenCalled();
    await sw.click("call");
    expect(background.focus).toHaveBeenCalledOnce();
    expect(background.navigate).not.toHaveBeenCalled();
    expect(background.postMessage).toHaveBeenCalledWith({ type: "ENCRYPTED_PUSH_HINT_AVAILABLE" });
  });

  it("opens a closed PWA on a call notification click", async () => {
    accountScope = await scope(ACCOUNT);
    const sw = worker([]);
    await sw.push("8".repeat(64), "call");
    expect(sw.shown[0].options.data.type).toBe("call");
    await sw.click("call");
    expect(sw.openWindow).toHaveBeenCalledWith("https://app.test/#/conversations");
  });

  it("does not let a hidden Relay client or autoplay-denied fallback erase or duplicate an OS call alert", async () => {
    accountScope = await scope(ACCOUNT);
    const sw = worker([client("hidden")]);
    await sw.push("9".repeat(64), "call");
    await sw.callMessage("INCOMING_RINGTONE_START", "hidden");
    await sw.callMessage("INCOMING_RINGTONE_PLAYING", "hidden");
    await sw.callMessage("INCOMING_RINGTONE_BLOCKED", "visible");
    expect(sw.showNotification).toHaveBeenCalledOnce();
    expect(sw.shown[0].close).not.toHaveBeenCalled();
    await sw.callMessage("INCOMING_RINGTONE_START", "visible");
    expect(sw.shown[0].close).toHaveBeenCalledOnce();
  });

  it("hands a claimed incoming call back to the system when its page goes into the background", async () => {
    const sw = worker([client("visible")]);
    await sw.callMessage("INCOMING_RINGTONE_START", "visible");
    expect(sw.showNotification).not.toHaveBeenCalled();
    await sw.callMessage("INCOMING_CALL_BACKGROUND", "hidden");
    await sw.callMessage("INCOMING_CALL_BACKGROUND", "hidden");
    expect(sw.showNotification).toHaveBeenCalledOnce();
    expect(sw.shown[0].options.data).toEqual({ type: "call", callId: "c".repeat(32) });
    await sw.callMessage("INCOMING_RINGTONE_START", "visible");
    expect(sw.shown[0].close).toHaveBeenCalledOnce();
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
