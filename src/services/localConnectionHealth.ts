import { deviceStorage } from "@/services/deviceStorage";
import {
  mediaServerId,
  normalizeMediaUrl,
  normalizeRelayUrl,
  type MediaServer,
  type MediaServerHealth,
  type MediaServerType,
  type RelayConfig,
  type RelayHealth,
} from "@/services/connectionSettings";

const CONNECTION_HEALTH_VERSION = 1;

export type LocalConnectionHealth = {
  version: number;
  relays: Record<string, RelayHealth>;
  mediaServers: Record<string, MediaServerHealth>;
};

export function connectionHealthKeyFor(pkHex?: string | null) {
  const account = typeof pkHex === "string" ? pkHex.trim().toLowerCase() : "";
  return account ? `nostr_connection_health_${account}` : null;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function relayHealthFromUnknown(value: unknown): RelayHealth {
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  return {
    lastConnectedAt: finiteNumber(item.lastConnectedAt),
    lastFailureAt: finiteNumber(item.lastFailureAt),
    successCount: finiteNumber(item.successCount),
    failureCount: finiteNumber(item.failureCount),
    latency: finiteNumber(item.latency),
  };
}

function mediaHealthFromUnknown(value: unknown): MediaServerHealth {
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  return {
    lastSuccessAt: finiteNumber(item.lastSuccessAt),
    lastFailureAt: finiteNumber(item.lastFailureAt),
    failureCount: finiteNumber(item.failureCount),
  };
}

function hasRelayHealth(value: RelayHealth) {
  return value.lastConnectedAt !== undefined
    || value.lastFailureAt !== undefined
    || value.successCount !== undefined
    || value.failureCount !== undefined
    || value.latency !== undefined;
}

function hasMediaHealth(value: MediaServerHealth) {
  return value.lastSuccessAt !== undefined
    || value.lastFailureAt !== undefined
    || value.failureCount !== undefined;
}

export function emptyLocalConnectionHealth(): LocalConnectionHealth {
  return { version: CONNECTION_HEALTH_VERSION, relays: {}, mediaServers: {} };
}

export function extractLegacyConnectionHealth(value: unknown): LocalConnectionHealth {
  const health = emptyLocalConnectionHealth();
  if (!value || typeof value !== "object") return health;
  const root = value as Record<string, unknown>;

  if (Array.isArray(root.relays)) {
    for (const raw of root.relays) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const url = normalizeRelayUrl(String(item.url || ""));
      if (!url) continue;
      const relayHealth = relayHealthFromUnknown(item);
      if (hasRelayHealth(relayHealth)) health.relays[url] = relayHealth;
    }
  }

  const mediaInput = Array.isArray(root.mediaServers)
    ? root.mediaServers
    : Array.isArray(root.blossomServers) ? root.blossomServers : [];
  for (const raw of mediaInput) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const url = normalizeMediaUrl(String(item.url || ""));
    if (!url) continue;
    const type: MediaServerType = item.type === "imgbed" || item.type === "custom" ? item.type : "blossom";
    const mediaHealth = mediaHealthFromUnknown(item);
    if (hasMediaHealth(mediaHealth)) health.mediaServers[mediaServerId(type, url)] = mediaHealth;
  }

  return health;
}

export function loadLocalConnectionHealth(account: string): LocalConnectionHealth | null {
  const key = connectionHealthKeyFor(account);
  if (!key) return null;
  try {
    const raw = deviceStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const health = emptyLocalConnectionHealth();

    const relays = parsed.relays && typeof parsed.relays === "object"
      ? parsed.relays as Record<string, unknown>
      : {};
    for (const [rawUrl, value] of Object.entries(relays)) {
      const url = normalizeRelayUrl(rawUrl);
      if (!url) continue;
      const relayHealth = relayHealthFromUnknown(value);
      if (hasRelayHealth(relayHealth)) health.relays[url] = relayHealth;
    }

    const media = parsed.mediaServers && typeof parsed.mediaServers === "object"
      ? parsed.mediaServers as Record<string, unknown>
      : {};
    for (const [id, value] of Object.entries(media)) {
      const mediaHealth = mediaHealthFromUnknown(value);
      if (hasMediaHealth(mediaHealth)) health.mediaServers[id] = mediaHealth;
    }

    return health;
  } catch {
    return null;
  }
}

export function saveLocalConnectionHealth(account: string, health: LocalConnectionHealth) {
  const key = connectionHealthKeyFor(account);
  if (!key) return;
  deviceStorage.setItem(key, JSON.stringify({
    version: CONNECTION_HEALTH_VERSION,
    relays: health.relays,
    mediaServers: health.mediaServers,
  }));
}

export function relayConfigsWithHealth(
  configs: RelayConfig[],
  health: Record<string, RelayHealth>,
): RelayConfig[] {
  return configs.map(config => ({ ...config, ...(health[config.url] || {}) }));
}

export function mediaServersWithHealth(
  servers: MediaServer[],
  health: Record<string, MediaServerHealth>,
): MediaServer[] {
  return servers.map(server => ({ ...server, ...(health[server.id] || {}) }));
}
