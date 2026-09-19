export type RelaySource = "user" | "nip65" | "default";
export type MediaServerType = "blossom" | "imgbed" | "custom";
export type MediaServerSource = "user" | "default";

export interface SyncMetadata {
  updatedAt: number;
  updatedBy?: string;
  deleted?: boolean;
  syncCreatedAt?: number;
  syncEventId?: string;
}

export interface RelayConfig extends SyncMetadata {
  url: string;
  read: boolean;
  write: boolean;
  enabled: boolean;
  source: RelaySource;
  addedAt: number;
  lastConnectedAt?: number;
  lastFailureAt?: number;
  successCount?: number;
  failureCount?: number;
  latency?: number;
}

export interface MediaServer extends SyncMetadata {
  id: string;
  type: MediaServerType;
  url: string;
  token?: string;
  tokenUpdatedAt?: number;
  tokenUpdatedBy?: string;
  enabled: boolean;
  priority: number;
  source: MediaServerSource;
  addedAt: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureCount?: number;
}

export interface ConnectionSettings {
  relays: RelayConfig[];
  mediaServers: MediaServer[];
}

export interface SyncEventMetadata {
  createdAt: number;
  eventId: string;
}

export const SETTINGS_VERSION = 3;
export const RELAY_SYNC_IDENTIFIER = "hainei-relays";
export const MEDIA_SYNC_IDENTIFIER = "hainei-media";
export const DEVICE_ID_STORAGE_KEY = "hainei_device_id";
export const ACTIVE_RELAY_CONFIGS_KEY = "hainei_active_relay_configs";

export const DEFAULT_RELAY_URLS = [
  "wss://nostr.dzo-hadar.ts.net"
] as const;

export const DEFAULT_MEDIA_SERVERS: ReadonlyArray<Pick<MediaServer, "id" | "type" | "url">> = [
  {
    id: "default:blossom-imgbed.noster.workers.dev",
    type: "blossom",
    url: "https://blossom-imgbed.noster.workers.dev"
  }
];

const RETIRED_DEFAULT_RELAY_URLS = new Set([""]);
const RETIRED_DEFAULT_MEDIA = new Set([
  "",
  ""
]);

const RELAY_SOURCE_ORDER: Record<RelaySource, number> = {
  user: 0,
  nip65: 1,
  default: 2
};

const MEDIA_SOURCE_ORDER: Record<MediaServerSource, number> = {
  user: 0,
  default: 1
};

const BACKOFF_DELAYS = [30_000, 60_000, 300_000, 900_000, 1_800_000];

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

export function getOrCreateDeviceId(storage: Storage = localStorage): string {
  const existing = storage.getItem(DEVICE_ID_STORAGE_KEY)?.trim();
  if (existing) return existing;
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  storage.setItem(DEVICE_ID_STORAGE_KEY, id);
  return id;
}

export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^wss?:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return "";
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function normalizeMediaUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const secureHttp = parsed.protocol === "https:";
    const insecureLoopback = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
    if (!secureHttp && !insecureLoopback) return "";
    if (parsed.username || parsed.password) return "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function ensureDefaultRelayCandidates(items: RelayConfig[]): RelayConfig[] {
  const next = dedupeRelays(items);
  for (const fallback of defaultRelayConfigs()) {
    if (!next.some(item => item.url === fallback.url)) next.push(fallback);
  }
  return next;
}

function ensureRelayModes(items: RelayConfig[]): RelayConfig[] {
  const next = ensureDefaultRelayCandidates(items).map(item => ({ ...item }));
  const hasRead = next.some(item => item.enabled && !item.deleted && item.read);
  const hasWrite = next.some(item => item.enabled && !item.deleted && item.write);
  if (hasRead && hasWrite) return next;
  const fallbackUrl = DEFAULT_RELAY_URLS[0];
  const fallbackIndex = next.findIndex(item => item.url === fallbackUrl);
  if (fallbackIndex >= 0) {
    next[fallbackIndex] = {
      ...next[fallbackIndex],
      enabled: true,
      deleted: false,
      read: hasRead ? next[fallbackIndex].read : true,
      write: hasWrite ? next[fallbackIndex].write : true,
      source: "default"
    };
  } else if (fallbackUrl) {
    next.push({
      ...defaultRelayConfigs()[0],
      url: fallbackUrl,
      enabled: true,
      deleted: false,
      read: true,
      write: true,
      source: "default"
    });
  }
  return next;
}

export function hasUsableRelayConfiguration(items: RelayConfig[]): boolean {
  const active = items.filter(item => item.enabled && !item.deleted);
  return active.some(item => item.read) && active.some(item => item.write);
}

export function hasUsableMediaConfiguration(items: MediaServer[]): boolean {
  return items.some(item => item.enabled && !item.deleted);
}

export function effectiveMediaServers(items: MediaServer[], now = Date.now()): MediaServer[] {
  const ranked = rankMediaServers(items, now);
  return ranked.length ? ranked : rankMediaServers(defaultMediaServers(), now);
}

export function defaultRelayConfigs(): RelayConfig[] {
  return DEFAULT_RELAY_URLS.map(url => ({
    url,
    read: true,
    write: true,
    enabled: true,
    deleted: false,
    source: "default",
    addedAt: 0,
    updatedAt: 0,
    updatedBy: "builtin"
  }));
}

export function defaultMediaServers(): MediaServer[] {
  return DEFAULT_MEDIA_SERVERS.map((server, index) => ({
    ...server,
    id: mediaServerId(server.type, server.url),
    enabled: true,
    deleted: false,
    priority: 1_000 + index,
    source: "default",
    addedAt: 0,
    updatedAt: 0,
    updatedBy: "builtin"
  }));
}

export function createDefaultConnectionSettings(): ConnectionSettings {
  return { relays: defaultRelayConfigs(), mediaServers: defaultMediaServers() };
}

function relayFromUnknown(value: unknown, now: number, deviceId: string): RelayConfig | null {
  if (typeof value === "string") {
    const url = normalizeRelayUrl(value);
    return url ? {
      url, read: true, write: true, enabled: true, source: "user",
      addedAt: now, updatedAt: now, updatedBy: deviceId
    } : null;
  }
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<RelayConfig>;
  const url = normalizeRelayUrl(String(item.url || ""));
  if (!url) return null;
  const source: RelaySource = item.source === "nip65" || item.source === "default" ? item.source : "user";
  return {
    ...item,
    url,
    read: item.read !== false,
    write: item.write !== false,
    enabled: item.enabled !== false,
    source,
    addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : now,
    updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : now,
    updatedBy: item.updatedBy || deviceId,
    deleted: item.deleted === true
  };
}

function mediaFromUnknown(value: unknown, index: number, now: number, deviceId: string): MediaServer | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<MediaServer> & { token?: string };
  const url = normalizeMediaUrl(String(item.url || ""));
  if (!url) return null;
  const type: MediaServerType = item.type === "imgbed" || item.type === "custom" ? item.type : "blossom";
  const source: MediaServerSource = item.source === "default" ? "default" : "user";
  return {
    ...item,
    id: mediaServerId(type, url),
    type,
    url,
    token: typeof item.token === "string" ? item.token : undefined,
    enabled: item.enabled !== false,
    priority: Number.isFinite(item.priority) ? Number(item.priority) : index,
    source,
    addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : now,
    updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : 0,
    updatedBy: item.updatedBy || deviceId,
    deleted: item.deleted === true
  };
}

function dedupeRelays(items: RelayConfig[]): RelayConfig[] {
  const byUrl = new Map<string, RelayConfig>();
  for (const item of items) {
    const current = byUrl.get(item.url);
    if (!current || compareSyncMetadata(item, current) >= 0) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

export function mediaServerId(type: MediaServerType, url: string): string {
  return `media:${type}:${normalizeMediaUrl(url)}`;
}

// Identity is independent of installation, legacy UUID, and default/user source.
// Keep tombstones through every merge, including merges from older clients.
export function dedupeMedia(items: MediaServer[]): MediaServer[] {
  const byId = new Map<string, MediaServer>();
  const credentials = new Map<string, MediaServer>();
  const ordered = items.map(item => ({
    ...item, url: normalizeMediaUrl(item.url), id: mediaServerId(item.type, item.url)
  })).filter(item => item.url).sort((a, b) =>
    (a.updatedAt - b.updatedAt)
    || (Number(a.source === "user") - Number(b.source === "user"))
    || (Number(!!a.deleted) - Number(!!b.deleted))
    || compareSyncMetadata(a, b)
    || String(a.updatedBy || "").localeCompare(String(b.updatedBy || ""))
    || JSON.stringify([a.enabled, a.priority, a.token]).localeCompare(JSON.stringify([b.enabled, b.priority, b.token]))
  );
  for (const item of ordered) {
    byId.set(item.id, item);
    if (item.token === undefined) continue;
    const candidate = {
      ...item,
      tokenUpdatedAt: item.tokenUpdatedAt ?? item.updatedAt,
      tokenUpdatedBy: item.tokenUpdatedBy ?? item.updatedBy ?? ""
    };
    const current = credentials.get(item.id);
    const comparison = !current ? 1 :
      (candidate.tokenUpdatedAt - (current.tokenUpdatedAt ?? current.updatedAt))
      || candidate.tokenUpdatedBy.localeCompare(current.tokenUpdatedBy || "")
      || candidate.token!.localeCompare(current.token || "");
    if (comparison > 0) credentials.set(item.id, candidate);
  }
  return [...byId.values()].map(item => {
    const credential = credentials.get(item.id);
    // Keep the credential's own revision when filling a missing legacy token;
    // otherwise an older token could acquire a newer configuration timestamp.
    return credential ? { ...item, token: credential.token,
      tokenUpdatedAt: credential.tokenUpdatedAt, tokenUpdatedBy: credential.tokenUpdatedBy } : item;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function migrateConnectionSettings(
  value: unknown,
  options: {
    now?: number;
    deviceId: string;
    legacyRelays?: unknown;
    legacyMediaServers?: unknown;
  }
): ConnectionSettings {
  const now = options.now ?? Date.now();
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const relayInput = Array.isArray(root.relays)
    ? root.relays
    : Array.isArray(options.legacyRelays) ? options.legacyRelays : [];
  const mediaInput = Array.isArray(root.mediaServers)
    ? root.mediaServers
    : Array.isArray(root.blossomServers)
      ? root.blossomServers
      : Array.isArray(options.legacyMediaServers) ? options.legacyMediaServers : [];

  const migratedRelays = relayInput
    .map(item => relayFromUnknown(item, now, options.deviceId))
    .filter((item): item is RelayConfig => !!item)
    .filter(item => item.source !== "default" || !RETIRED_DEFAULT_RELAY_URLS.has(item.url));
  const migratedMedia = mediaInput
    .map((item, index) => mediaFromUnknown(item, index, now, options.deviceId))
    .filter((item): item is MediaServer => !!item)
    .filter(item => item.source !== "default"
      || (!RETIRED_DEFAULT_MEDIA.has(item.id) && !RETIRED_DEFAULT_MEDIA.has(item.url)));

  for (const fallback of defaultRelayConfigs()) {
    if (!migratedRelays.some(item => item.url === fallback.url)) migratedRelays.push(fallback);
  }
  for (const fallback of defaultMediaServers()) {
    if (!migratedMedia.some(item => item.id === fallback.id)) migratedMedia.push(fallback);
  }

  return {
    relays: dedupeRelays(migratedRelays),
    mediaServers: dedupeMedia(migratedMedia)
  };
}

export function relayBackoffMs(failureCount = 0): number {
  if (failureCount <= 0) return 0;
  return BACKOFF_DELAYS[Math.min(failureCount - 1, BACKOFF_DELAYS.length - 1)];
}

function relayHealthScore(item: RelayConfig, now: number): number {
  const inBackoff = item.lastFailureAt
    ? now - item.lastFailureAt < relayBackoffMs(item.failureCount || 0)
    : false;
  const failurePenalty = Math.min(item.failureCount || 0, 20) * 1_000;
  const latencyPenalty = Math.min(item.latency || 0, 10_000);
  const successBonus = item.lastConnectedAt ? Math.max(0, 10_000 - Math.floor((now - item.lastConnectedAt) / 60_000)) : 0;
  return (inBackoff ? 1_000_000 : 0) + failurePenalty + latencyPenalty - successBonus;
}

export function rankRelayConfigs(items: RelayConfig[], now = Date.now()): RelayConfig[] {
  return items
    .filter(item => item.enabled && !item.deleted && (item.read || item.write))
    .slice()
    .sort((a, b) =>
      (RELAY_SOURCE_ORDER[a.source] - RELAY_SOURCE_ORDER[b.source])
      || (relayHealthScore(a, now) - relayHealthScore(b, now))
      || a.url.localeCompare(b.url)
    );
}

export function selectRelayConfigs(items: RelayConfig[], max = 5, now = Date.now()): RelayConfig[] {
  const ranked = rankRelayConfigs(ensureRelayModes(items), now);
  if (ranked.length <= max) return ranked;
  const selected = ranked.slice(0, max);
  const fallback = ranked.find(item => item.source === "default");
  if (fallback && !selected.some(item => item.url === fallback.url)) selected[max - 1] = fallback;
  return selected;
}

export function rankMediaServers(items: MediaServer[], now = Date.now()): MediaServer[] {
  return dedupeMedia(items)
    .filter(item => item.enabled && !item.deleted)
    .slice()
    .sort((a, b) =>
      (MEDIA_SOURCE_ORDER[a.source] - MEDIA_SOURCE_ORDER[b.source])
      || (Number(!!a.lastFailureAt && now - a.lastFailureAt < relayBackoffMs(a.failureCount || 0))
        - Number(!!b.lastFailureAt && now - b.lastFailureAt < relayBackoffMs(b.failureCount || 0)))
      || (a.priority - b.priority)
      || ((a.failureCount || 0) - (b.failureCount || 0))
      || a.url.localeCompare(b.url)
    );
}

export function compareSyncMetadata(a: SyncMetadata, b: SyncMetadata): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  const eventTime = (a.syncCreatedAt || 0) - (b.syncCreatedAt || 0);
  if (eventTime !== 0) return eventTime;
  return String(a.syncEventId || "").localeCompare(String(b.syncEventId || ""));
}

function withEventMetadata<T extends SyncMetadata>(item: T, metadata?: SyncEventMetadata): T {
  return metadata ? {
    ...item,
    syncCreatedAt: metadata.createdAt,
    syncEventId: metadata.eventId
  } : item;
}

function mergeItems<T extends SyncMetadata>(
  local: T[],
  remote: T[],
  keyFor: (item: T) => string,
  metadata?: SyncEventMetadata
): T[] {
  const merged = new Map(local.map(item => [keyFor(item), item]));
  for (const raw of remote) {
    const item = withEventMetadata(raw, metadata);
    const key = keyFor(item);
    const current = merged.get(key);
    if (!current || compareSyncMetadata(item, current) > 0) merged.set(key, item);
  }
  return [...merged.values()];
}

export function mergeRelayConfigs(local: RelayConfig[], remote: RelayConfig[], metadata?: SyncEventMetadata): RelayConfig[] {
  return mergeItems(local, remote, item => item.url, metadata)
    .filter(item => item.source !== "default" || !RETIRED_DEFAULT_RELAY_URLS.has(item.url));
}

export function mergeMediaServers(local: MediaServer[], remote: MediaServer[], metadata?: SyncEventMetadata): MediaServer[] {
  return dedupeMedia([...local, ...remote.map(item => withEventMetadata(item, metadata))])
    .filter(item => item.source !== "default"
      || (!RETIRED_DEFAULT_MEDIA.has(item.id) && !RETIRED_DEFAULT_MEDIA.has(item.url)));
}

export function relayConfigsFromNip65(
  tags: unknown,
  metadata: SyncEventMetadata,
  accountPubkey: string,
  current: RelayConfig[]
): RelayConfig[] {
  if (!Array.isArray(tags)) return current;
  const updatedAt = metadata.createdAt * 1_000;
  const parsed = new Map<string, { read: boolean; write: boolean }>();
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "r" || typeof tag[1] !== "string") continue;
    const url = normalizeRelayUrl(tag[1]);
    if (!url) continue;
    const marker = tag[2];
    const access = parsed.get(url) || { read: false, write: false };
    if (marker === "read") access.read = true;
    else if (marker === "write") access.write = true;
    else { access.read = true; access.write = true; }
    parsed.set(url, access);
  }

  const next = [...current];
  for (const [url, access] of parsed) {
    const existing = next.find(item => item.url === url);
    if (existing?.source === "user") continue;
    const incoming: RelayConfig = {
      ...(existing || {} as RelayConfig),
      url,
      read: access.read,
      write: access.write,
      enabled: existing?.enabled !== false,
      source: "nip65",
      addedAt: existing?.addedAt || updatedAt,
      updatedAt,
      updatedBy: `nip65:${accountPubkey}`,
      deleted: false
    };
    const index = next.findIndex(item => item.url === url);
    if (index >= 0) next[index] = withEventMetadata(incoming, metadata);
    else next.push(withEventMetadata(incoming, metadata));
  }

  return next.map(item => {
    if (item.source !== "nip65" || parsed.has(item.url)) return item;
    if (item.updatedAt > updatedAt) return item;
    return withEventMetadata({
      ...item,
      deleted: true,
      updatedAt,
      updatedBy: `nip65:${accountPubkey}`
    }, metadata);
  });
}

export async function runMediaFailover<T>(
  servers: MediaServer[],
  attempt: (server: MediaServer) => Promise<T>,
  report?: (server: MediaServer, ok: boolean) => void
): Promise<{ result: T; server: MediaServer }> {
  const ranked = rankMediaServers(servers);
  let lastError: unknown;
  for (const server of ranked) {
    try {
      const result = await attempt(server);
      report?.(server, true);
      return { result, server };
    } catch (error) {
      lastError = error;
      report?.(server, false);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("所有媒体服务器均上传失败");
}
