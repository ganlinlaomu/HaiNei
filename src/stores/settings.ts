import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import {
  disconnectRelay,
  getRelaysFromStorage,
  onRelayConnectionState
} from "@/nostr/relays";
import { setMediaHealthReporter } from "@/utils/blossom";
import { logger } from "@/utils/logger";
import { deviceStorage } from "@/services/deviceStorage";
import { scheduleAccountStateSync, syncAccountStateNamespace } from "@/services/accountStateSync";
import { getManagedRelayConfig } from "@/services/relaySession";
import {
  ACTIVE_RELAY_CONFIGS_KEY,
  DEFAULT_RELAY_URLS,
  SETTINGS_VERSION,
  createDefaultConnectionSettings,
  dedupeMedia,
  effectiveMediaServers,
  hasUsableMediaConfiguration,
  hasUsableRelayConfiguration,
  mediaServerId,
  getOrCreateDeviceId,
  mergeMediaServers,
  mergeRelayConfigs,
  migrateConnectionSettings,
  normalizeMediaUrl,
  normalizeRelayUrl,
  rankMediaServers,
  selectRelayConfigs,
  stripConnectionHealth,
  type ConnectionSettings,
  type MediaServer,
  type MediaServerHealth,
  type MediaServerType,
  type RelayConfig,
  type RelayHealth
} from "@/services/connectionSettings";
import {
  extractLegacyConnectionHealth,
  loadLocalConnectionHealth,
  mediaServersWithHealth,
  relayConfigsWithHealth,
  saveLocalConnectionHealth,
} from "@/services/localConnectionHealth";

export type { MediaServer, MediaServerType, RelayConfig };

type SettingsDomain = "relays" | "media" | "privacy";

type StoredSettingsData = {
  version: number;
  settings: ConnectionSettings;
  lastSyncTimestamp: number;
  lastRelaySyncTimestamp?: number;
  lastMediaSyncTimestamp?: number;
  bootstrapSyncVersion?: number;
};

let relayHealthUnsubscribe: (() => void) | null = null;
const MANAGED_RELAY_STORAGE_KEY = "hainei_managed_relay_url";

function selectRuntimeRelayConfigs(items: RelayConfig[]) {
  const required = items.filter(item =>
    item.enabled && !item.deleted && item.source === "default"
    && ((DEFAULT_RELAY_URLS as readonly string[]).includes(item.url) || item.updatedBy === "managed-worker")
  );
  const ranked = selectRelayConfigs(items, 5);
  const requiredUrls = new Set(required.map(item => item.url));
  const others = ranked.filter(item => !requiredUrls.has(item.url));
  return [...others.slice(0, Math.max(0, 5 - required.length)), ...required].slice(0, 5);
}

export function storageKeyFor(pkHex?: string | null) {
  const normalized = typeof pkHex === "string" ? pkHex.trim().toLowerCase() : "";
  if (!normalized) return null;
  return `nostr_settings_${normalized}`;
}

export function dataSaverKeyFor(pkHex?: string | null) {
  const normalized = typeof pkHex === "string" ? pkHex.trim().toLowerCase() : "";
  return normalized ? `nostr_data_saver_${normalized}` : null;
}

export function settingsSyncRelays(mode: "read" | "write") {
  // Every installation knows the bootstrap defaults. Always include them for
  // settings transport so a new device can discover user-specific Relay config.
  return [...new Set([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage(mode)])];
}

function readJsonArray(key: string): unknown[] {
  try {
    const parsed = JSON.parse(deviceStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readLegacyRelays(): unknown[] {
  const raw = deviceStorage.getItem("custom-relays");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // The historic format was newline-delimited.
  }
  return raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    settings: createDefaultConnectionSettings() as ConnectionSettings,
    relayHealth: {} as Record<string, RelayHealth>,
    mediaHealth: {} as Record<string, MediaServerHealth>,
    loadedFor: "",
    deviceId: "",
    syncing: false,
    syncStatusText: "",
    syncError: "",
    validationError: "",
    lastSyncTimestamp: 0,
    lastRelaySyncTimestamp: 0,
    lastMediaSyncTimestamp: 0,
    bootstrapSyncVersion: 0,
    dataSaver: false,
    _isFetching: false,
    _syncJobs: 0,
    _sessionGeneration: 0,
    _publishTimer: null as number | null,
    _pendingDomains: [] as SettingsDomain[]
  }),

  getters: {
    relayList: (state) => relayConfigsWithHealth(state.settings.relays, state.relayHealth)
      .filter(item => !item.deleted)
      .slice()
      .sort((a, b) => {
        const source = { user: 0, nip65: 1, default: 2 };
        return source[a.source] - source[b.source] || a.url.localeCompare(b.url);
      }),
    mediaList: (state) => {
      const visible = dedupeMedia(
        mediaServersWithHealth(state.settings.mediaServers, state.mediaHealth)
      ).filter(item => !item.deleted);
      const enabled = rankMediaServers(visible);
      return enabled.concat(visible.filter(item => !item.enabled));
    },
    activeRelays: (state) => selectRuntimeRelayConfigs(
      relayConfigsWithHealth(state.settings.relays, state.relayHealth)
    ),
    activeMediaServers: (state) => effectiveMediaServers(
      mediaServersWithHealth(state.settings.mediaServers, state.mediaHealth)
    )
  },

  actions: {
    setDataSaver(enabled: boolean) {
      this.dataSaver = enabled;
      const key = dataSaverKeyFor(this.loadedFor);
      if (!key) return;
      try { deviceStorage.setItem(key, enabled ? "1" : "0"); } catch {}
    },

    setReadReceipts(enabled: boolean) {
      if (!this.loadedFor) return;
      const current = this.settings.privacy;
      this.settings.privacy = {
        readReceipts: enabled,
        updatedAt: Math.max(Date.now(), (current?.updatedAt || 0) + 1),
        updatedBy: this.deviceId || "device"
      };
      this.changed(["privacy"]);
    },

    _clearValidationError() {
    this.validationError = "";
    },

    _setValidationError(message: string) {
    this.validationError = message;
    },

    _beginSync(message: string) {
    this._syncJobs += 1;
    this.syncing = true;
    this.syncStatusText = message;
    },

    _endSync() {
    this._syncJobs = Math.max(0, this._syncJobs - 1);
    this.syncing = this._syncJobs > 0;
    if (!this.syncing) this.syncStatusText = "";
    },

    reset() {
    this._sessionGeneration++;
    const activeRuntimeRelays = getRelaysFromStorage();
      if (this._publishTimer !== null) window.clearTimeout(this._publishTimer!);
      this._publishTimer = null;
      this._pendingDomains = [];
      relayHealthUnsubscribe?.();
      relayHealthUnsubscribe = null;
      setMediaHealthReporter();
      this.settings = createDefaultConnectionSettings();
      this.relayHealth = {};
      this.mediaHealth = {};
      this.loadedFor = "";
      this.deviceId = "";
      this.syncing = false;
      this.syncStatusText = "";
      this.syncError = "";
      this.validationError = "";
      this.lastSyncTimestamp = 0;
      this.lastRelaySyncTimestamp = 0;
      this.lastMediaSyncTimestamp = 0;
      this.bootstrapSyncVersion = 0;
      this.dataSaver = false;
      this._isFetching = false;
      this._syncJobs = 0;
      try {
        for (const url of activeRuntimeRelays) disconnectRelay(url);
        deviceStorage.removeItem(ACTIVE_RELAY_CONFIGS_KEY);
        deviceStorage.removeItem("custom-relays");
        deviceStorage.removeItem("blossom_servers");
        deviceStorage.removeItem("blossom_upload_url");
        deviceStorage.removeItem("blossom_token");
        window.dispatchEvent(new CustomEvent("blossom-config-updated", { detail: { servers: [] } }));
      } catch (error) {
        logger.warn("[settings] clear runtime mirrors failed", error);
      }
    },

    async load(pk?: string, force = false) {
      const keyStore = useKeyStore();
      const targetPk = typeof (pk ?? keyStore.pkHex) === "string"
        ? String(pk ?? keyStore.pkHex).trim().toLowerCase()
        : "";
      if (!targetPk) {
        this.reset();
        return;
      }
      if (this.loadedFor === targetPk && !force) return;

      const canUseGlobalLegacy = !this.loadedFor
        && (deviceStorage.getItem("pkHex") || "").trim().toLowerCase() === targetPk;
      const legacyRelays = canUseGlobalLegacy ? readLegacyRelays() : [];
      const legacyMedia = canUseGlobalLegacy ? readJsonArray("blossom_servers") : [];
      const legacySingleMedia = canUseGlobalLegacy && !legacyMedia.length
        ? [{ url: deviceStorage.getItem("blossom_upload_url") || "" }]
        : [];

      if (this.loadedFor !== targetPk) this.reset();
      this.loadedFor = targetPk;
      try {
        this.dataSaver = deviceStorage.getItem(dataSaverKeyFor(targetPk)!) === "1";
      } catch { this.dataSaver = false; }
      const generation = this._sessionGeneration;
      this.deviceId = getOrCreateDeviceId();

      const key = storageKeyFor(targetPk);
      let storedValue: unknown;
      try {
        const raw = key ? deviceStorage.getItem(key) : null;
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<StoredSettingsData>;
          storedValue = parsed.settings;
          this.lastSyncTimestamp = Number(parsed.lastSyncTimestamp) || 0;
          this.lastRelaySyncTimestamp = Number(parsed.lastRelaySyncTimestamp) || 0;
          this.lastMediaSyncTimestamp = Number(parsed.lastMediaSyncTimestamp) || 0;
          this.bootstrapSyncVersion = Number(parsed.bootstrapSyncVersion) || 0;
        }
      } catch (error) {
        logger.warn("[settings] local settings were invalid; defaults restored", {
          account: targetPk.slice(0, 8),
          errorType: error instanceof Error ? (error as Error).name : typeof error
        });
      }

      const legacyHealth = extractLegacyConnectionHealth(storedValue);
      const localHealth = loadLocalConnectionHealth(targetPk);
      this.relayHealth = { ...legacyHealth.relays, ...(localHealth?.relays || {}) };
      this.mediaHealth = { ...legacyHealth.mediaServers, ...(localHealth?.mediaServers || {}) };

      this.settings = migrateConnectionSettings(storedValue, {
        deviceId: this.deviceId,
        legacyRelays,
        legacyMediaServers: legacyMedia.length ? legacyMedia : legacySingleMedia
      });
      this.settings.mediaServers = this.settings.mediaServers.map(server => {
        const sanitized = { ...server };
        delete sanitized.token;
        delete sanitized.tokenUpdatedAt;
        delete sanitized.tokenUpdatedBy;
        return sanitized;
      });
      this.persistConnectionHealth();
      this._clearValidationError();
      this.save();
      this.applySettings();
      this.bindHealthTracking();
      void this.refreshManagedRelay();

      // Account settings are restored and synchronized through the encrypted
      // account-state namespace. Relay settings events are legacy import only.
    },

    async refreshManagedRelay() {
      const account = this.loadedFor;
      const generation = this._sessionGeneration;
      if (!account) return "";
      try {
        const config = await getManagedRelayConfig();
        if (this.loadedFor !== account || this._sessionGeneration !== generation) return "";
        const previous = normalizeRelayUrl(deviceStorage.getItem(MANAGED_RELAY_STORAGE_KEY) || "");
        const next = config.enabled ? normalizeRelayUrl(config.relayUrl) : "";
        let changed = false;

        if (previous && previous !== next && !(DEFAULT_RELAY_URLS as readonly string[]).includes(previous)) {
          const before = this.settings.relays.length;
          this.settings.relays = this.settings.relays.filter(item =>
            !(item.url === previous && item.source === "default" && item.updatedBy === "managed-worker")
          );
          changed ||= this.settings.relays.length !== before;
        }

        if (next) {
          const existing = this.settings.relays.find(item => item.url === next);
          if (existing) {
            const shouldChange = !existing.enabled || existing.deleted || !existing.read || !existing.write
              || existing.source !== "default" || existing.updatedBy !== "managed-worker";
            if (shouldChange) {
              Object.assign(existing, {
                enabled: true,
                deleted: false,
                read: true,
                write: true,
                source: "default",
                updatedBy: "managed-worker",
              });
              changed = true;
            }
          } else {
            this.settings.relays.push({
              url: next,
              read: true,
              write: true,
              enabled: true,
              deleted: false,
              source: "default",
              addedAt: 0,
              updatedAt: 0,
              updatedBy: "managed-worker",
            });
            changed = true;
          }
          deviceStorage.setItem(MANAGED_RELAY_STORAGE_KEY, next);
        } else if (previous) {
          deviceStorage.removeItem(MANAGED_RELAY_STORAGE_KEY);
        }

        if (changed) {
          this.save();
          this.applySettings();
        }
        return next;
      } catch (error) {
        logger.warn("[settings] managed relay configuration unavailable", {
          account: account.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return "";
      }
    },

    persistConnectionHealth() {
      const account = this.loadedFor;
      if (!account) return;
      const configuredRelayUrls = new Set(this.settings.relays.filter(item => !item.deleted).map(item => item.url));
      const configuredMediaIds = new Set(this.settings.mediaServers.filter(item => !item.deleted).map(item => item.id));
      const relays = Object.fromEntries(
        Object.entries(this.relayHealth).filter(([url]) => configuredRelayUrls.has(url))
      );
      const mediaServers = Object.fromEntries(
        Object.entries(this.mediaHealth).filter(([id]) => configuredMediaIds.has(id))
      );
      this.relayHealth = relays;
      this.mediaHealth = mediaServers;
      try {
        saveLocalConnectionHealth(account, { version: 1, relays, mediaServers });
      } catch (error) {
        logger.warn("[settings] local connection health save failed", {
          account: account.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    },

    bindHealthTracking() {
      const account = this.loadedFor;
      const generation = this._sessionGeneration;
      const isCurrent = () => this.loadedFor === account && this._sessionGeneration === generation;
      relayHealthUnsubscribe?.();
      relayHealthUnsubscribe = onRelayConnectionState(event => {
        if (!this.loadedFor || !isCurrent()) return;
        const url = normalizeRelayUrl(event.url);
        const relay = this.settings.relays.find(item => item.url === url);
        if (!relay || relay.deleted || (!event.connected && !event.failed)) return;

        const current = this.relayHealth[url] || {};
        const next: RelayHealth = { ...current };
        if (event.connected) {
          next.lastConnectedAt = event.at;
          next.successCount = (current.successCount || 0) + 1;
          next.failureCount = 0;
          if (typeof event.latency === "number") next.latency = event.latency;
        } else {
          next.lastFailureAt = event.at;
          next.failureCount = (current.failureCount || 0) + 1;
        }
        this.relayHealth = { ...this.relayHealth, [url]: next };
        this.persistConnectionHealth();
        this.applySettings(false);
      });

      setMediaHealthReporter((serverId, ok, at) => {
        if (!isCurrent()) return;
        const server = this.settings.mediaServers.find(item => item.id === serverId);
        if (!server || server.deleted) return;

        const current = this.mediaHealth[serverId] || {};
        const next: MediaServerHealth = { ...current };
        if (ok) {
          next.lastSuccessAt = at;
          next.failureCount = 0;
        } else {
          next.lastFailureAt = at;
          next.failureCount = (current.failureCount || 0) + 1;
        }
        this.mediaHealth = { ...this.mediaHealth, [serverId]: next };
        this.persistConnectionHealth();
        this.applySettings(false);
      });
    },

    applySettings(_connectNewRelays = false) {
      const previousRelays = new Set(getRelaysFromStorage());
      const activeRelays = selectRuntimeRelayConfigs(
        relayConfigsWithHealth(this.settings.relays, this.relayHealth)
      );
      const activeUrls = activeRelays.map(item => item.url);
      const activeSet = new Set(activeUrls);

      try {
        deviceStorage.setItem(ACTIVE_RELAY_CONFIGS_KEY, JSON.stringify(activeRelays));
        deviceStorage.setItem("custom-relays", activeUrls.join("\n"));
        for (const url of previousRelays) {
          if (!activeSet.has(url)) disconnectRelay(url);
        }
        // Relay objects are lazy: adding a URL must not open a WebSocket until
        // subscribe, publish, or auth actually needs it.
      } catch (error) {
        logger.warn("[settings] apply relay configuration failed", {
          account: this.loadedFor.slice(0, 8),
          errorType: error instanceof Error ? (error as Error).name : typeof error
        });
      }

      try {
        const activeMedia = effectiveMediaServers(
          mediaServersWithHealth(this.settings.mediaServers, this.mediaHealth)
        ).map(server => {
          const sanitized = { ...server };
          delete sanitized.token;
          delete sanitized.tokenUpdatedAt;
          delete sanitized.tokenUpdatedBy;
          return sanitized;
        });
        deviceStorage.setItem("blossom_servers", JSON.stringify(activeMedia));
        deviceStorage.removeItem("blossom_token");
        const first = activeMedia[0];
        if (first) {
          deviceStorage.setItem("blossom_upload_url", first.url);
        } else {
          deviceStorage.removeItem("blossom_upload_url");
        }
        window.dispatchEvent(new CustomEvent("blossom-config-updated", { detail: { servers: activeMedia } }));
      } catch (error) {
        logger.warn("[settings] apply media configuration failed", {
          account: this.loadedFor.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error
        });
      }
    },

    save() {
      const key = storageKeyFor(this.loadedFor);
      if (!key) return;
      const mediaServers = dedupeMedia(this.settings.mediaServers).map(server => {
        const sanitized = { ...server };
        delete sanitized.token;
        delete sanitized.tokenUpdatedAt;
        delete sanitized.tokenUpdatedBy;
        return sanitized;
      });
      this.settings = stripConnectionHealth({ ...this.settings, mediaServers });
      const data: StoredSettingsData = {
        version: SETTINGS_VERSION,
        settings: this.settings,
        lastSyncTimestamp: this.lastSyncTimestamp,
        lastRelaySyncTimestamp: this.lastRelaySyncTimestamp,
        lastMediaSyncTimestamp: this.lastMediaSyncTimestamp,
        bootstrapSyncVersion: this.bootstrapSyncVersion
      };
      try {
        deviceStorage.setItem(key, JSON.stringify(data));
        scheduleAccountStateSync(useKeyStore(), "settings", this.deviceId);
      } catch (error) {
        logger.warn("[settings] local save failed", {
          account: this.loadedFor.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error
        });
      }
    },

    changed(domains: SettingsDomain[]) {
      this.save();
      this.applySettings();
      if (domains.includes("relays")) {
        void import("@/services/accountMessageSync").then(({ restartAccountMessageSync }) => restartAccountMessageSync());
      }
      this.schedulePublish(domains);
    },

    addRelay(input: string) {
      const url = normalizeRelayUrl(input);
      if (!url) {
        this._setValidationError("请输入有效的 Relay 地址（仅支持 ws:// 或 wss://）。");
        return false;
      }
      const now = Date.now();
      const existing = this.settings.relays.find(item => item.url === url);
      if (existing) {
        Object.assign(existing, {
          read: true,
          write: true,
          enabled: true,
          source: existing.source === "default" ? "default" : "user",
          deleted: false,
          updatedAt: now,
          updatedBy: this.deviceId,
          syncCreatedAt: undefined,
          syncEventId: undefined
        } satisfies Partial<RelayConfig>);
      } else {
        this.settings.relays.push({
          url,
          read: true,
          write: true,
          enabled: true,
          source: "user",
          addedAt: now,
          updatedAt: now,
          updatedBy: this.deviceId
        });
      }
      this._clearValidationError();
      this.changed(["relays"]);
      return true;
    },

    updateRelay(url: string, patch: Partial<Pick<RelayConfig, "read" | "write" | "enabled">>) {
      const relay = this.settings.relays.find(item => item.url === url && !item.deleted);
      if (!relay) return false;
      if (relay.source === "default" || (DEFAULT_RELAY_URLS as readonly string[]).includes(relay.url)) {
        this._setValidationError("系统 Relay 固定保持启用并允许读取/写入。");
        return false;
      }
      const next = this.settings.relays.map(item =>
        item.url === url && !item.deleted ? { ...item, ...patch } : item
      );
      if (!hasUsableRelayConfiguration(next)) {
        this._setValidationError("请至少保留一个启用的读取 Relay 和一个启用的写入 Relay。");
        return false;
      }
      Object.assign(relay, patch, {
        updatedAt: Date.now(),
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this._clearValidationError();
      this.changed(["relays"]);
      return true;
    },

    deleteRelay(url: string) {
      const relay = this.settings.relays.find(item => item.url === url && !item.deleted);
      if (!relay || relay.source === "default" || (DEFAULT_RELAY_URLS as readonly string[]).includes(relay.url)) return false;
      const next = this.settings.relays.map(item =>
        item.url === url && !item.deleted ? { ...item, deleted: true, enabled: false } : item
      );
      if (!hasUsableRelayConfiguration(next)) {
        this._setValidationError("无法删除最后一个可用 Relay，请先启用其他读取和写入 Relay。");
        return false;
      }
      Object.assign(relay, {
        deleted: true,
        enabled: false,
        updatedAt: Date.now(),
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this._clearValidationError();
      this.changed(["relays"]);
      return true;
    },

    addMediaServer(type: MediaServerType, input: string) {
      const url = normalizeMediaUrl(input);
      if (!url) {
        this._setValidationError("请输入有效的媒体服务器地址（仅支持 HTTPS，localhost 可使用 HTTP）。");
        return false;
      }
      const existing = this.settings.mediaServers.find(item => item.url === url && item.type === type);
      const now = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);
      if (existing) {
        Object.assign(existing, {
          enabled: true,
          source: "user",
          deleted: false,
          updatedAt: now,
          updatedBy: this.deviceId,
          syncCreatedAt: undefined,
          syncEventId: undefined
        } satisfies Partial<MediaServer>);
      } else {
        this.settings.mediaServers.push({
          id: mediaServerId(type, url),
          type,
          url,
          enabled: true,
          priority: 0,
          source: "user",
          addedAt: now,
          updatedAt: now,
          updatedBy: this.deviceId
        });
      }
      this._clearValidationError();
      this.changed(["media"]);
      return true;
    },

    updateMediaServer(id: string, patch: Partial<Pick<MediaServer, "enabled" | "priority">>) {
      const server = this.settings.mediaServers.find(item => item.id === id && !item.deleted);
      if (!server) return false;
      const next = this.settings.mediaServers.map(item =>
        item.id === id && !item.deleted ? { ...item, ...patch } : item
      );
      if (!hasUsableMediaConfiguration(next)) {
        this._setValidationError("请至少保留一个启用的媒体服务器。");
        return false;
      }
      const now = Math.max(Date.now(), server.updatedAt + 1);
      Object.assign(server, patch, {
        updatedAt: now,
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this._clearValidationError();
      this.changed(["media"]);
      return true;
    },

    setPrimaryMediaServer(id: string) {
      const now = Math.max(Date.now(), ...this.settings.mediaServers.map(server => server.updatedAt + 1));
      let changed = false;
      for (const server of this.settings.mediaServers) {
        if (server.deleted || server.source !== "user") continue;
        const priority = server.id === id ? 0 : Math.max(1, server.priority);
        if (priority === server.priority) continue;
        Object.assign(server, {
          priority,
          updatedAt: now,
          updatedBy: this.deviceId,
          syncCreatedAt: undefined,
          syncEventId: undefined
        });
        changed = true;
      }
      if (changed) this.changed(["media"]);
    },

    deleteMediaServer(id: string) {
      const server = this.settings.mediaServers.find(item => item.id === id && !item.deleted);
      if (!server || server.source === "default") return false;
      const next = this.settings.mediaServers.map(item =>
        item.id === id && !item.deleted ? { ...item, deleted: true, enabled: false } : item
      );
      if (!hasUsableMediaConfiguration(next)) {
        this._setValidationError("无法删除最后一个可用媒体服务器，请先启用或添加其他服务器。");
        return false;
      }
      Object.assign(server, {
        deleted: true,
        enabled: false,
        updatedAt: Math.max(Date.now(), server.updatedAt + 1),
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this._clearValidationError();
      this.changed(["media"]);
      return true;
    },

    schedulePublish(domains: SettingsDomain[]) {
      const keyStore = useKeyStore();
      if (!keyStore.supportsNip44 || keyStore.pkHex !== this.loadedFor) return;
      void domains;
      scheduleAccountStateSync(keyStore, "settings", this.deviceId);
    },

    async publishToRelays(domains: SettingsDomain[] = ["relays", "media"]): Promise<boolean> {
      const keyStore = useKeyStore();
      if (!keyStore.isLoggedIn || !keyStore.supportsNip44 || keyStore.pkHex !== this.loadedFor) return false;
      void domains;
      return syncAccountStateNamespace(keyStore, "settings", this.deviceId);
    },

    async fetchFromRelays(): Promise<boolean> {
      // Settings snapshots moved to the authenticated encrypted account-state
      // endpoint. Keep this no-op only for callers from older UI code.
      return false;
    }
  }
});
