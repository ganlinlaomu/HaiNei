import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionHealthKeyFor,
  extractLegacyConnectionHealth,
  loadLocalConnectionHealth,
  mediaServersWithHealth,
  relayConfigsWithHealth,
  saveLocalConnectionHealth,
} from "@/services/localConnectionHealth";
import {
  mediaServerId,
  type MediaServer,
  type RelayConfig,
} from "@/services/connectionSettings";

const ACCOUNT = "a".repeat(64);

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  });
});

describe("local connection health", () => {
  it("extracts legacy health without carrying configuration fields", () => {
    const mediaId = mediaServerId("blossom", "https://media.example");
    const health = extractLegacyConnectionHealth({
      relays: [{
        url: "wss://relay.example",
        read: true,
        write: true,
        latency: 55,
        successCount: 2,
        lastConnectedAt: 100,
      }],
      mediaServers: [{
        id: mediaId,
        type: "blossom",
        url: "https://media.example",
        priority: 0,
        lastFailureAt: 200,
        failureCount: 3,
      }],
    });

    expect(health.relays["wss://relay.example"]).toEqual({
      lastConnectedAt: 100,
      lastFailureAt: undefined,
      successCount: 2,
      failureCount: undefined,
      latency: 55,
    });
    expect(health.mediaServers[mediaId]).toEqual({
      lastSuccessAt: undefined,
      lastFailureAt: 200,
      failureCount: 3,
    });
  });

  it("persists health under an account-scoped local-only key", () => {
    const mediaId = mediaServerId("blossom", "https://media.example");
    saveLocalConnectionHealth(ACCOUNT, {
      version: 1,
      relays: { "wss://relay.example": { failureCount: 2, lastFailureAt: 10 } },
      mediaServers: { [mediaId]: { lastSuccessAt: 20, failureCount: 0 } },
    });

    expect(connectionHealthKeyFor(ACCOUNT)).toBe(`hainei_connection_health_${ACCOUNT}`);
    expect(loadLocalConnectionHealth(ACCOUNT)).toEqual({
      version: 1,
      relays: { "wss://relay.example": {
        lastConnectedAt: undefined,
        lastFailureAt: 10,
        successCount: undefined,
        failureCount: 2,
        latency: undefined,
      } },
      mediaServers: { [mediaId]: {
        lastSuccessAt: 20,
        lastFailureAt: undefined,
        failureCount: 0,
      } },
    });
  });

  it("combines local health at runtime without mutating synchronized config", () => {
    const relay: RelayConfig = {
      url: "wss://relay.example",
      read: true,
      write: true,
      enabled: true,
      source: "user",
      addedAt: 1,
      updatedAt: 1,
    };
    const media: MediaServer = {
      id: mediaServerId("blossom", "https://media.example"),
      type: "blossom",
      url: "https://media.example",
      enabled: true,
      priority: 0,
      source: "user",
      addedAt: 1,
      updatedAt: 1,
    };

    const relayRuntime = relayConfigsWithHealth([relay], {
      [relay.url]: { latency: 33, failureCount: 0 },
    });
    const mediaRuntime = mediaServersWithHealth([media], {
      [media.id]: { lastFailureAt: 50, failureCount: 1 },
    });

    expect(relay).not.toHaveProperty("latency");
    expect(media).not.toHaveProperty("lastFailureAt");
    expect(relayRuntime[0]).toMatchObject({ latency: 33, failureCount: 0 });
    expect(mediaRuntime[0]).toMatchObject({ lastFailureAt: 50, failureCount: 1 });
  });
});
