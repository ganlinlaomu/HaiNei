import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  DEFAULT_MEDIA_SERVERS, DEFAULT_RELAY_URLS, MEDIA_SYNC_IDENTIFIER,
  dedupeMedia, mediaServerId, mergeMediaServers, migrateConnectionSettings,
  rankMediaServers, runMediaFailover, type MediaServer
} from "@/services/connectionSettings";

const mocks = vi.hoisted(() => ({
  key: {
    pkHex: "a".repeat(64), isLoggedIn: true, supportsNip44: true,
    nip44Decrypt: vi.fn(), nip44Encrypt: vi.fn(), signEvent: vi.fn()
  },
  publish: vi.fn(), subscribe: vi.fn(), healthReporter: undefined as undefined | ((id: string, ok: boolean, at: number) => void)
}));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/nostr/relays", () => ({
  DEFAULT_RELAYS: ["wss://relay.damus.io", "wss://relay.floonet.dev"],
  disconnectRelay: vi.fn(), reconnectRelay: vi.fn(),
  getRelaysFromStorage: () => [], onRelayConnectionState: () => vi.fn(),
  publish: mocks.publish, subscribe: mocks.subscribe
}));
vi.mock("@/utils/blossom", () => ({
  setMediaHealthReporter: (reporter?: typeof mocks.healthReporter) => { mocks.healthReporter = reporter; }
}));
import { storageKeyFor, useSettingsStore } from "@/stores/settings";

const A = "a".repeat(64), B = "b".repeat(64);
const URL = "https://media.example/upload";
function media(id: string, updatedAt: number, patch: Partial<MediaServer> = {}): MediaServer {
  return { id, url: URL, type: "blossom", source: "user", enabled: true,
    priority: 0, addedAt: 1, updatedAt, updatedBy: "device-a", ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function activate(account: string) {
  const store = useSettingsStore();
  store.reset();
  mocks.key.pkHex = account;
  store.loadedFor = account;
  store.deviceId = `device-${account[0]}`;
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout, dispatchEvent: vi.fn() });
  setActivePinia(createPinia());
  mocks.key.pkHex = A;
  mocks.key.supportsNip44 = true;
  mocks.key.nip44Encrypt.mockResolvedValue("encrypted");
  mocks.key.signEvent.mockImplementation(async template => ({ ...template, pubkey: mocks.key.pkHex, id: "signed" }));
  mocks.publish.mockResolvedValue([{ relay: DEFAULT_RELAY_URLS[0], ok: true }]);
});
afterEach(() => {
  useSettingsStore().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("media identity migration", () => {
  it("collapses three legacy IDs and preserves the newest user configuration", () => {
    const records = [
      media("default:x", 0, { source: "default" }),
      media("old-desktop-uuid", 10, { token: "saved-token" }),
      media("old-phone-uuid", 20, { url: `${URL}/`, enabled: false, priority: 3 })
    ];
    const migrated = migrateConnectionSettings({ mediaServers: records }, { deviceId: "migration" });
    const entries = migrated.mediaServers.filter(item => item.url === URL);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: mediaServerId("blossom", URL), source: "user", enabled: false, priority: 3, token: "saved-token" });
    expect(dedupeMedia([...records].reverse())).toEqual(dedupeMedia(records));
    expect(migrateConnectionSettings(migrated, { deviceId: "second-run" })).toEqual(migrated);
  });

  it("converges after independent device additions and repeated round trips", () => {
    const desktop = activate(A);
    desktop.addMediaServer("blossom", URL, "saved-token");
    const left = JSON.parse(JSON.stringify(desktop.settings.mediaServers));
    const phone = activate(A);
    phone.addMediaServer("blossom", `${URL}/`, "saved-token");
    let a = left, b = JSON.parse(JSON.stringify(phone.settings.mediaServers));
    for (let round = 0; round < 3; round++) {
      a = mergeMediaServers(a, b);
      b = mergeMediaServers(b, a);
      a = migrateConnectionSettings({ mediaServers: a }, { deviceId: "desktop" }).mediaServers;
      b = migrateConnectionSettings({ mediaServers: b }, { deviceId: "phone" }).mediaServers;
    }
    expect(a).toEqual(b);
    expect(a.filter((item: MediaServer) => item.url === URL)).toHaveLength(1);
    phone.settings.mediaServers = a;
    phone.save();
    expect(phone.mediaList.filter(item => item.url === URL)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(storageKeyFor(A)!)!).settings.mediaServers.filter((item: MediaServer) => item.url === URL)).toHaveLength(1);
  });

  it("keeps deletion across old UUIDs, repeated sync, and default injection", () => {
    const url = DEFAULT_MEDIA_SERVERS[0].url;
    const deleted = media("new-id", 30, { url, deleted: true, enabled: false });
    const old = media("old-id", 10, { url });
    let current = [deleted];
    for (let i = 0; i < 3; i++) {
      current = mergeMediaServers(current, [old], { createdAt: 9999 + i, eventId: `old-republish-${i}` });
      current = migrateConnectionSettings({ mediaServers: current }, { deviceId: "phone" }).mediaServers;
      expect(current.filter(item => item.url === url)).toHaveLength(1);
      expect(rankMediaServers(current).some(item => item.url === url)).toBe(false);
    }
  });

  it("does not merge different protocols, paths, or query parameters", () => {
    expect(dedupeMedia([
      media("a", 1), media("b", 1, { type: "imgbed" }),
      media("c", 1, { url: "https://media.example/other" }),
      media("d", 1, { url: `${URL}?bucket=a` }),
      media("e", 1, { url: `${URL}?bucket=b` })
    ])).toHaveLength(5);
  });

  it("preserves missing legacy credentials but honors an explicit newer clear", () => {
    const saved = media("saved", 10, { token: "saved-token" });
    expect(mergeMediaServers([saved], [media("missing", 20)])[0].token).toBe("saved-token");
    expect(mergeMediaServers([saved], [media("cleared", 20, { token: "" })])[0].token).toBe("");
  });

  it("converges on credentials regardless of incremental merge order", () => {
    const old = media("old", 10, { token: "old-token" });
    const tokenChange = media("credential-change", 20, { token: "new-token" });
    const configChange = media("config-change", 30, { enabled: false });
    const a = mergeMediaServers(mergeMediaServers([old], [configChange]), [tokenChange]);
    const b = mergeMediaServers(mergeMediaServers([old], [tokenChange]), [configChange]);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ enabled: false, token: "new-token", tokenUpdatedAt: 20 });
  });

  it("allows a default endpoint to become one user override with Primary and deletion", () => {
    vi.setSystemTime(100);
    const store = activate(A);
    const url = DEFAULT_MEDIA_SERVERS[0].url;
    store.addMediaServer("blossom", url, "saved-token");
    store.addMediaServer("blossom", `${url}/`);
    const id = mediaServerId("blossom", url);
    store.setPrimaryMediaServer(id);
    expect(store.mediaList.filter(item => item.url === url)).toEqual([
      expect.objectContaining({ id, source: "user", priority: 0, token: "saved-token" })
    ]);
    expect(store.deleteMediaServer(id)).toBe(false);
    expect(store.validationError).toContain("最后一个可用媒体服务器");
    expect(store.mediaList.some(item => item.url === url)).toBe(true);
  });

  it("tries a duplicate endpoint only once before falling back", async () => {
    const attempted: string[] = [];
    await runMediaFailover([
      media("a", 1), media("b", 2), media("c", 3),
      media("fallback", 0, { url: "https://fallback.example", source: "default" })
    ], async item => {
      attempted.push(item.url);
      if (item.url === URL) throw new Error("offline");
      return "ok";
    });
    expect(attempted).toEqual([URL, "https://fallback.example"]);
  });

  it("keeps rapid edits and deletion newer than the prior local revision", () => {
    const store = activate(A);
    store.addMediaServer("blossom", URL);
    const id = mediaServerId("blossom", URL);
    store.updateMediaServer(id, { token: "changed" });
    const old = JSON.parse(JSON.stringify(store.settings.mediaServers));
    store.deleteMediaServer(id);
    store.settings.mediaServers = mergeMediaServers(store.settings.mediaServers, old);
    expect(store.mediaList.some(item => item.url === URL)).toBe(false);
  });
});

describe("settings session isolation", () => {
  it("handles an empty account load by resetting instead of calling toLowerCase on null", async () => {
    const store = activate(A);
    await expect(store.load("")).resolves.toBeUndefined();
    expect(store.loadedFor).toBe("");
    mocks.key.pkHex = "";
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.loadedFor).toBe("");
  });

  it("retires Relay-based settings snapshots", async () => {
    const store = activate(A);
    await expect(store.fetchFromRelays()).resolves.toBe(false);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("ignores an old account's delayed upload health result", () => {
    const store = activate(A);
    store.bindHealthTracking();
    const oldReporter = mocks.healthReporter!;
    activate(B);
    store.settings.mediaServers = [media(mediaServerId("blossom", URL), 10)];
    store.bindHealthTracking();
    oldReporter(mediaServerId("blossom", URL), false, Date.now());
    expect(store.settings.mediaServers[0].failureCount).toBeUndefined();
  });

  it("prevents disabling the last readable or writable relay", () => {
    const store = activate(A);
    const url = DEFAULT_RELAY_URLS[0];
    expect(store.updateRelay(url, { read: false })).toBe(false);
    expect(store.validationError).toContain("读取 Relay");
    expect(store.updateRelay(url, { write: false })).toBe(false);
    expect(store.validationError).toContain("写入 Relay");
  });

  it("prevents disabling the last enabled media server", () => {
    const store = activate(A);
    const id = store.mediaList[0].id;
    expect(store.updateMediaServer(id, { enabled: false })).toBe(false);
    expect(store.validationError).toContain("至少保留一个启用的媒体服务器");
  });
});
