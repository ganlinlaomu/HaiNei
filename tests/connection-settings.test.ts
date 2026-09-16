import { describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  mergeMediaServers,
  mergeRelayConfigs,
  migrateConnectionSettings,
  rankMediaServers,
  rankRelayConfigs,
  relayConfigsFromNip65,
  runMediaFailover,
  ACTIVE_RELAY_CONFIGS_KEY,
  DEFAULT_MEDIA_SERVERS,
  DEFAULT_RELAY_URLS,
  type MediaServer,
  type RelayConfig
} from "@/services/connectionSettings";
import { settingsSyncRelays, storageKeyFor, useSettingsStore } from "@/stores/settings";

const NOW = 1_700_000_000_000;

function relay(url: string, source: RelayConfig["source"], patch: Partial<RelayConfig> = {}): RelayConfig {
  return {
    url,
    read: true,
    write: true,
    enabled: true,
    source,
    addedAt: NOW,
    updatedAt: NOW,
    updatedBy: "device-a",
    ...patch
  };
}

function media(id: string, source: MediaServer["source"], patch: Partial<MediaServer> = {}): MediaServer {
  return {
    id,
    type: "blossom",
    url: `https://${id}.example`,
    enabled: true,
    priority: 0,
    source,
    addedAt: NOW,
    updatedAt: NOW,
    updatedBy: "device-a",
    ...patch
  };
}

describe("Relay configuration", () => {
  it("uses the current built-in Relay and media fallbacks", () => {
    expect(DEFAULT_RELAY_URLS).toEqual([
      "wss://relay.damus.io",
      "wss://relay.floonet.dev"
    ]);
    expect(DEFAULT_MEDIA_SERVERS).toEqual([
      expect.objectContaining({ url: "https://blossom-imgbed.noster.workers.dev" })
    ]);
  });

  it("retires old built-in services without deleting matching user entries", () => {
    const migrated = migrateConnectionSettings({
      relays: [
        relay("wss://relay.0xchat.com", "default", { updatedBy: "builtin" }),
        relay("wss://relay.0xchat.com", "user")
      ],
      mediaServers: [
        media("default:blossom.lostr.space", "default", { url: "https://blossom.lostr.space" })
      ]
    }, { deviceId: "device-a", now: NOW });
    expect(migrated.relays.some(item => item.url === "wss://relay.0xchat.com" && item.source === "default")).toBe(false);
    expect(migrated.relays.some(item => item.url === "wss://relay.0xchat.com" && item.source === "user")).toBe(true);
    expect(migrated.relays.some(item => item.url === "wss://relay.floonet.dev" && item.source === "default")).toBe(true);
    expect(migrated.mediaServers.some(item => item.url === "https://blossom.lostr.space")).toBe(false);
    expect(migrated.mediaServers.some(item => item.url === "https://blossom-imgbed.noster.workers.dev")).toBe(true);
  });

  it("always ranks user Relay above NIP-65 and defaults", () => {
    const ranked = rankRelayConfigs([
      relay("wss://default.example", "default", { latency: 1 }),
      relay("wss://nip65.example", "nip65", { latency: 1 }),
      relay("wss://user.example", "user", { failureCount: 20, lastFailureAt: NOW })
    ], NOW);
    expect(ranked.map(item => item.source)).toEqual(["user", "nip65", "default"]);
  });

  it("imports NIP-65 access markers without overriding an existing user Relay", () => {
    const current = [relay("wss://user.example", "user")];
    const merged = relayConfigsFromNip65(
      [["r", "wss://nip65.example", "read"], ["r", "wss://user.example", "write"]],
      { createdAt: 100, eventId: "event-b" },
      "a".repeat(64),
      current
    );
    expect(rankRelayConfigs(merged).map(item => item.source)).toEqual(["user", "nip65"]);
    expect(merged.find(item => item.url === "wss://user.example")?.write).toBe(true);
  });

  it("retains failed Relay configuration and only lowers health rank within its source", () => {
    const failed = relay("wss://failed.example", "user", { failureCount: 4, lastFailureAt: NOW });
    const healthy = relay("wss://healthy.example", "user", { successCount: 2, lastConnectedAt: NOW - 100 });
    const ranked = rankRelayConfigs([failed, healthy], NOW);
    expect(ranked.map(item => item.url)).toEqual([healthy.url, failed.url]);
    expect(ranked).toContainEqual(failed);
  });

  it("does not select disabled Relay", () => {
    expect(rankRelayConfigs([
      relay("wss://disabled.example", "user", { enabled: false }),
      relay("wss://enabled.example", "default")
    ]).map(item => item.url)).toEqual(["wss://enabled.example"]);
  });

  it("migrates legacy string arrays as enabled user Relay items", () => {
    const migrated = migrateConnectionSettings(
      { relays: ["wss://legacy-one.example", "wss://legacy-two.example"] },
      { deviceId: "device-a", now: NOW }
    );
    const legacy = migrated.relays.filter(item => item.url.includes("legacy-"));
    expect(legacy).toHaveLength(2);
    expect(legacy.every(item => item.source === "user" && item.enabled)).toBe(true);
  });

  it("preserves a locally disabled built-in Relay during migration and merge", () => {
    const migrated = migrateConnectionSettings({
      relays: [relay("wss://relay.damus.io", "default", { enabled: false, updatedAt: 50 })]
    }, { deviceId: "device-a", now: NOW });
    const remoteBuiltin = relay("wss://relay.damus.io", "default", { enabled: true, updatedAt: 0 });
    const merged = mergeRelayConfigs(migrated.relays, [remoteBuiltin]);
    expect(merged.find(item => item.url === "wss://relay.damus.io")?.enabled).toBe(false);
  });
});

describe("Media configuration", () => {
  it("migrates legacy Blossom arrays into user media servers", () => {
    const migrated = migrateConnectionSettings({
      blossomServers: [{ url: "https://legacy-media.example", token: "token" }]
    }, { deviceId: "device-a", now: NOW });
    const legacy = migrated.mediaServers.find(item => item.url === "https://legacy-media.example");
    expect(legacy).toMatchObject({ source: "user", enabled: true, token: "token", type: "blossom" });
  });

  it("falls back after a Primary upload failure", async () => {
    const primary = media("primary", "user", { priority: 0 });
    const secondary = media("secondary", "user", { priority: 1 });
    const attempts: string[] = [];
    const reports: Array<[string, boolean]> = [];
    const result = await runMediaFailover(
      [secondary, primary],
      async server => {
        attempts.push(server.id);
        if (server.id === "primary") throw new Error("offline");
        return "uploaded";
      },
      (server, ok) => reports.push([server.id, ok])
    );
    expect(attempts).toEqual(["primary", "secondary"]);
    expect(result.server.id).toBe("secondary");
    expect(reports).toEqual([["primary", false], ["secondary", true]]);
  });

  it("ranks every user media server above default fallback", () => {
    expect(rankMediaServers([
      media("default", "default", { priority: 0 }),
      media("user", "user", { priority: 99 })
    ]).map(item => item.id)).toEqual(["user", "default"]);
  });

  it("temporarily lowers a failed server within the user tier", () => {
    expect(rankMediaServers([
      media("failed-primary", "user", { priority: 0, failureCount: 1, lastFailureAt: NOW }),
      media("healthy-secondary", "user", { priority: 1 })
    ], NOW).map(item => item.id)).toEqual(["healthy-secondary", "failed-primary"]);
  });

  it("never attempts a disabled media server", async () => {
    const attempt = vi.fn(async () => "ok");
    await runMediaFailover([
      media("disabled", "user", { enabled: false }),
      media("fallback", "default")
    ], attempt);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0][0].id).toBe("fallback");
  });
});

describe("per-item settings sync", () => {
  it("always includes bootstrap defaults alongside website-specific Relay settings", () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: key => values.get(key) ?? null,
      key: index => [...values.keys()][index] ?? null,
      removeItem: key => values.delete(key),
      setItem: (key, value) => values.set(key, String(value))
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    storage.setItem(ACTIVE_RELAY_CONFIGS_KEY, JSON.stringify([
      relay("wss://website-only.example", "user")
    ]));
    expect(settingsSyncRelays("read")).toEqual(expect.arrayContaining([
      ...DEFAULT_RELAY_URLS,
      "wss://website-only.example"
    ]));
  });

  it("lets a newer remote item replace local", () => {
    const local = relay("wss://same.example", "user", { updatedAt: 10, enabled: true });
    const remote = relay("wss://same.example", "user", { updatedAt: 20, enabled: false });
    expect(mergeRelayConfigs([local], [remote])[0].enabled).toBe(false);
  });

  it("keeps a newer local item", () => {
    const local = media("same", "user", { updatedAt: 20, enabled: false });
    const remote = media("same", "user", { updatedAt: 10, enabled: true });
    expect(mergeMediaServers([local], [remote])[0].enabled).toBe(false);
  });

  it("merges concurrent changes to different items", () => {
    const local = relay("wss://local.example", "user", { updatedAt: 20 });
    const remote = relay("wss://remote.example", "user", { updatedAt: 20 });
    expect(mergeRelayConfigs([local], [remote]).map(item => item.url).sort()).toEqual([
      "wss://local.example",
      "wss://remote.example"
    ]);
  });

  it("propagates a newer deletion tombstone", () => {
    const local = media("same", "user", { updatedAt: 10, deleted: false });
    const remote = media("same", "user", { updatedAt: 20, deleted: true });
    expect(mergeMediaServers([local], [remote])[0].deleted).toBe(true);
  });

  it("uses event time and id as a deterministic equal-time tie break", () => {
    const local = relay("wss://same.example", "user", {
      updatedAt: 20,
      enabled: true,
      syncCreatedAt: 100,
      syncEventId: "a"
    });
    const remote = relay("wss://same.example", "user", { updatedAt: 20, enabled: false });
    expect(mergeRelayConfigs([local], [remote], { createdAt: 100, eventId: "b" })[0].enabled).toBe(false);
  });

  it("uses separate account-scoped storage keys", () => {
    const accountA = "a".repeat(64);
    const accountB = "b".repeat(64);
    const storage = new Map<string, string>();
    storage.set(storageKeyFor(accountA)!, JSON.stringify({ relays: ["wss://a.example"] }));
    storage.set(storageKeyFor(accountB)!, JSON.stringify({ relays: ["wss://b.example"] }));
    expect(storageKeyFor(accountA)).not.toBe(storageKeyFor(accountB));
    expect(storage.get(storageKeyFor(accountB)!)).not.toContain("wss://a.example");
  });

  it("does not expose account A settings after loading account B", async () => {
    class MemoryStorage implements Storage {
      private values = new Map<string, string>();
      get length() { return this.values.size; }
      clear() { this.values.clear(); }
      getItem(key: string) { return this.values.get(key) ?? null; }
      key(index: number) { return [...this.values.keys()][index] ?? null; }
      removeItem(key: string) { this.values.delete(key); }
      setItem(key: string, value: string) { this.values.set(key, String(value)); }
    }
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { clearTimeout, setTimeout, dispatchEvent: vi.fn() }
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: class {
        addEventListener() {}
        close() {}
      }
    });
    setActivePinia(createPinia());
    const accountA = "a".repeat(64);
    const accountB = "b".repeat(64);
    storage.setItem(storageKeyFor(accountA)!, JSON.stringify({
      settings: { relays: ["wss://only-a.example"], blossomServers: [] }
    }));
    storage.setItem(storageKeyFor(accountB)!, JSON.stringify({
      settings: { relays: ["wss://only-b.example"], blossomServers: [] }
    }));

    const store = useSettingsStore();
    await store.load(accountA);
    expect(store.relayList.some(item => item.url === "wss://only-a.example")).toBe(true);
    await store.load(accountB);
    expect(store.relayList.some(item => item.url === "wss://only-a.example")).toBe(false);
    expect(store.relayList.some(item => item.url === "wss://only-b.example")).toBe(true);
  });
});
