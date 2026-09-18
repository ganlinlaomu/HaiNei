import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import {
  disconnectRelay,
  getRelaysFromStorage,
  onRelayConnectionState,
  publish,
  subscribe
} from "@/nostr/relays";
import { setMediaHealthReporter } from "@/utils/blossom";
import { logger } from "@/utils/logger";
import { closeSubscription } from "@/utils/closeSubscription";
import {
  ACTIVE_RELAY_CONFIGS_KEY,
  DEFAULT_RELAY_URLS,
  MEDIA_SYNC_IDENTIFIER,
  RELAY_SYNC_IDENTIFIER,
  SETTINGS_VERSION,
  createDefaultConnectionSettings,
  dedupeMedia,
  mediaServerId,
  getOrCreateDeviceId,
  mergeMediaServers,
  mergeRelayConfigs,
  migrateConnectionSettings,
  normalizeMediaUrl,
  normalizeRelayUrl,
  rankMediaServers,
  relayConfigsFromNip65,
  selectRelayConfigs,
  type ConnectionSettings,
  type MediaServer,
  type MediaServerType,
  type RelayConfig
} from "@/services/connectionSettings";

export type { MediaServer, MediaServerType, RelayConfig };

type SettingsDomain = "relays" | "media";

type StoredSettingsData = {
  version: number;
  settings: ConnectionSettings;
  lastSyncTimestamp: number;
  lastRelaySyncTimestamp?: number;
  lastMediaSyncTimestamp?: number;
  bootstrapSyncVersion?: number;
};

type SettingsSyncPayload<T> = {
  version: number;
  type: string;
  items: T[];
};

let relayHealthUnsubscribe: (() => void) | null = null;
let cancelSettingsFetch: (() => void) | null = null;

export function storageKeyFor(pkHex?: string | null) {
  if (!pkHex) return null;
  return `nostr_settings_${pkHex.toLowerCase()}`;
}

export function settingsSyncRelays(mode: "read" | "write") {
  // Every installation knows the bootstrap defaults. Always include them for
  // settings transport so a new device can discover user-specific Relay config.
  return [...new Set([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage(mode)])];
}

function readJsonArray(key: string): unknown[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readLegacyRelays(): unknown[] {
  const raw = localStorage.getItem("custom-relays");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // The historic format was newline-delimited.
  }
  return raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function syncStampItem<T extends RelayConfig | MediaServer>(item: T, createdAt: number, eventId: string): T {
  return { ...item, syncCreatedAt: createdAt, syncEventId: eventId };
}

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    settings: createDefaultConnectionSettings() as ConnectionSettings,
    loadedFor: "",
    deviceId: "",
    syncing: false,
    syncError: "",
    lastSyncTimestamp: 0,
    lastRelaySyncTimestamp: 0,
    lastMediaSyncTimestamp: 0,
    bootstrapSyncVersion: 0,
    _isFetching: false,
    _sessionGeneration: 0,
    _publishTimer: null as number | null,
    _pendingDomains: [] as SettingsDomain[]
  }),

  getters: {
    relayList: (state) => state.settings.relays
      .filter(item => !item.deleted)
      .slice()
      .sort((a, b) => {
        const source = { user: 0, nip65: 1, default: 2 };
        return source[a.source] - source[b.source] || a.url.localeCompare(b.url);
      }),
    mediaList: (state) => {
      const visible = dedupeMedia(state.settings.mediaServers).filter(item => !item.deleted);
      const enabled = rankMediaServers(visible);
      return enabled.concat(visible.filter(item => !item.enabled));
    },
    activeRelays: (state) => selectRelayConfigs(state.settings.relays),
    activeMediaServers: (state) => rankMediaServers(state.settings.mediaServers)
  },

  actions: {
    reset() {
      this._sessionGeneration++;
      cancelSettingsFetch?.();
      cancelSettingsFetch = null;
      const activeRuntimeRelays = getRelaysFromStorage();
      if (this._publishTimer !== null) window.clearTimeout(this._publishTimer);
      this._publishTimer = null;
      this._pendingDomains = [];
      relayHealthUnsubscribe?.();
      relayHealthUnsubscribe = null;
      setMediaHealthReporter();
      this.settings = createDefaultConnectionSettings();
      this.loadedFor = "";
      this.deviceId = "";
      this.syncing = false;
      this.syncError = "";
      this.lastSyncTimestamp = 0;
      this.lastRelaySyncTimestamp = 0;
      this.lastMediaSyncTimestamp = 0;
      this.bootstrapSyncVersion = 0;
      this._isFetching = false;
      try {
        for (const url of activeRuntimeRelays) disconnectRelay(url);
        localStorage.removeItem(ACTIVE_RELAY_CONFIGS_KEY);
        localStorage.removeItem("custom-relays");
        localStorage.removeItem("blossom_servers");
        localStorage.removeItem("blossom_upload_url");
        localStorage.removeItem("blossom_token");
        window.dispatchEvent(new CustomEvent("blossom-config-updated", { detail: { servers: [] } }));
      } catch (error) {
        logger.warn("[settings] clear runtime mirrors failed", error);
      }
    },

    async load(pk?: string) {
      const keyStore = useKeyStore();
      const targetPk = (pk ?? keyStore.pkHex).toLowerCase();
      if (!targetPk) {
        this.reset();
        return;
      }
      if (this.loadedFor === targetPk) return;

      const canUseGlobalLegacy = !this.loadedFor
        && localStorage.getItem("pkHex")?.toLowerCase() === targetPk;
      const legacyRelays = canUseGlobalLegacy ? readLegacyRelays() : [];
      const legacyMedia = canUseGlobalLegacy ? readJsonArray("blossom_servers") : [];
      const legacySingleMedia = canUseGlobalLegacy && !legacyMedia.length
        ? [{
            url: localStorage.getItem("blossom_upload_url") || "",
            token: localStorage.getItem("blossom_token") || ""
          }]
        : [];

      if (this.loadedFor !== targetPk) this.reset();
      this.loadedFor = targetPk;
      const generation = this._sessionGeneration;
      this.deviceId = getOrCreateDeviceId();

      const key = storageKeyFor(targetPk);
      let storedValue: unknown;
      try {
        const raw = key ? localStorage.getItem(key) : null;
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
          errorType: error instanceof Error ? error.name : typeof error
        });
      }

      this.settings = migrateConnectionSettings(storedValue, {
        deviceId: this.deviceId,
        legacyRelays,
        legacyMediaServers: legacyMedia.length ? legacyMedia : legacySingleMedia
      });
      this.save();
      this.applySettings();
      this.bindHealthTracking();

      // Remote sync is deliberately non-blocking: local/default settings are ready now.
      const fetchPromise = this.fetchFromRelays();

      // Republish migrated identities through bootstrap Relays as well.
      // After first merging anything already remote, republish only domains that
      // contain an actual legacy user change (not untouched built-in defaults).
      if ((storedValue || legacyMedia.length || legacySingleMedia.length) && this.bootstrapSyncVersion < SETTINGS_VERSION) {
        const migrationDomains: SettingsDomain[] = [];
        if (this.settings.relays.some(item => item.updatedAt > 0 && item.updatedBy !== "builtin")) {
          migrationDomains.push("relays");
        }
        if (this.settings.mediaServers.some(item => item.source === "user" || (item.updatedAt > 0 && item.updatedBy !== "builtin"))) {
          migrationDomains.push("media");
        }
        if (migrationDomains.length) {
          void fetchPromise.finally(() => {
            if (this.loadedFor === targetPk && this._sessionGeneration === generation) this.schedulePublish(migrationDomains);
          });
        }
      }
    },

    bindHealthTracking() {
      const account = this.loadedFor;
      const generation = this._sessionGeneration;
      const isCurrent = () => this.loadedFor === account && this._sessionGeneration === generation;
      relayHealthUnsubscribe?.();
      relayHealthUnsubscribe = onRelayConnectionState(event => {
        if (!this.loadedFor || !isCurrent()) return;
        const relay = this.settings.relays.find(item => item.url === event.url);
        if (!relay || relay.deleted) return;
        if (event.connected) {
          relay.lastConnectedAt = event.at;
          relay.successCount = (relay.successCount || 0) + 1;
          relay.failureCount = 0;
          if (typeof event.latency === "number") relay.latency = event.latency;
        } else if (event.failed) {
          relay.lastFailureAt = event.at;
          relay.failureCount = (relay.failureCount || 0) + 1;
        }
        this.save();
        this.applySettings(false);
      });

      setMediaHealthReporter((serverId, ok, at) => {
        if (!isCurrent()) return;
        const server = this.settings.mediaServers.find(item => item.id === serverId);
        if (!server || server.deleted) return;
        if (ok) {
          server.lastSuccessAt = at;
          server.failureCount = 0;
        } else {
          server.lastFailureAt = at;
          server.failureCount = (server.failureCount || 0) + 1;
        }
        this.save();
        this.applySettings(false);
      });
    },

    applySettings(_connectNewRelays = false) {
      const previousRelays = new Set(getRelaysFromStorage());
      const activeRelays = selectRelayConfigs(this.settings.relays);
      const activeUrls = activeRelays.map(item => item.url);
      const activeSet = new Set(activeUrls);

      try {
        localStorage.setItem(ACTIVE_RELAY_CONFIGS_KEY, JSON.stringify(activeRelays));
        localStorage.setItem("custom-relays", activeUrls.join("\n"));
        for (const url of previousRelays) {
          if (!activeSet.has(url)) disconnectRelay(url);
        }
        // Relay objects are lazy: adding a URL must not open a WebSocket until
        // subscribe, publish, or auth actually needs it.
      } catch (error) {
        logger.warn("[settings] apply relay configuration failed", {
          account: this.loadedFor.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error
        });
      }

      try {
        const activeMedia = rankMediaServers(this.settings.mediaServers);
        localStorage.setItem("blossom_servers", JSON.stringify(activeMedia));
        const first = activeMedia[0];
        if (first) {
          localStorage.setItem("blossom_upload_url", first.url);
          localStorage.setItem("blossom_token", first.token || "");
        } else {
          localStorage.removeItem("blossom_upload_url");
          localStorage.removeItem("blossom_token");
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
      this.settings.mediaServers = dedupeMedia(this.settings.mediaServers);
      const data: StoredSettingsData = {
        version: SETTINGS_VERSION,
        settings: this.settings,
        lastSyncTimestamp: this.lastSyncTimestamp,
        lastRelaySyncTimestamp: this.lastRelaySyncTimestamp,
        lastMediaSyncTimestamp: this.lastMediaSyncTimestamp,
        bootstrapSyncVersion: this.bootstrapSyncVersion
      };
      try {
        localStorage.setItem(key, JSON.stringify(data));
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
      this.schedulePublish(domains);
    },

    addRelay(input: string) {
      const url = normalizeRelayUrl(input);
      if (!url) return false;
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
      this.changed(["relays"]);
      return true;
    },

    updateRelay(url: string, patch: Partial<Pick<RelayConfig, "read" | "write" | "enabled">>) {
      const relay = this.settings.relays.find(item => item.url === url && !item.deleted);
      if (!relay) return;
      Object.assign(relay, patch, {
        updatedAt: Date.now(),
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this.changed(["relays"]);
    },

    deleteRelay(url: string) {
      const relay = this.settings.relays.find(item => item.url === url && !item.deleted);
      if (!relay || relay.source === "default" || (DEFAULT_RELAY_URLS as readonly string[]).includes(relay.url)) return false;
      Object.assign(relay, {
        deleted: true,
        enabled: false,
        updatedAt: Date.now(),
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this.changed(["relays"]);
      return true;
    },

    addMediaServer(type: MediaServerType, input: string, token?: string) {
      const url = normalizeMediaUrl(input);
      if (!url) return false;
      const existing = this.settings.mediaServers.find(item => item.url === url && item.type === type);
      const now = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);
      if (existing) {
        Object.assign(existing, {
          token: token || existing.token,
          ...(token ? { tokenUpdatedAt: now, tokenUpdatedBy: this.deviceId } : {}),
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
          token,
          ...(token !== undefined ? { tokenUpdatedAt: now, tokenUpdatedBy: this.deviceId } : {}),
          enabled: true,
          priority: 0,
          source: "user",
          addedAt: now,
          updatedAt: now,
          updatedBy: this.deviceId
        });
      }
      this.changed(["media"]);
      return true;
    },

    updateMediaServer(id: string, patch: Partial<Pick<MediaServer, "enabled" | "priority" | "token">>) {
      const server = this.settings.mediaServers.find(item => item.id === id && !item.deleted);
      if (!server) return;
      const now = Math.max(Date.now(), server.updatedAt + 1);
      Object.assign(server, patch, {
        ...(patch.token !== undefined ? { tokenUpdatedAt: now, tokenUpdatedBy: this.deviceId } : {}),
        updatedAt: now,
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this.changed(["media"]);
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
      Object.assign(server, {
        deleted: true,
        enabled: false,
        updatedAt: Math.max(Date.now(), server.updatedAt + 1),
        updatedBy: this.deviceId,
        syncCreatedAt: undefined,
        syncEventId: undefined
      });
      this.changed(["media"]);
      return true;
    },

    schedulePublish(domains: SettingsDomain[]) {
      const keyStore = useKeyStore();
      if (!keyStore.supportsNip44 || keyStore.pkHex !== this.loadedFor) return;
      this._pendingDomains = [...new Set([...this._pendingDomains, ...domains])];
      if (this._publishTimer !== null) window.clearTimeout(this._publishTimer);
      this._publishTimer = window.setTimeout(() => {
        const pending = [...this._pendingDomains];
        this._pendingDomains = [];
        this._publishTimer = null;
        void this.publishToRelays(pending);
      }, 1_500);
    },

    async publishToRelays(domains: SettingsDomain[] = ["relays", "media"]): Promise<boolean> {
      const keyStore = useKeyStore();
      if (!keyStore.isLoggedIn || !keyStore.supportsNip44 || keyStore.pkHex !== this.loadedFor) return false;
      const account = keyStore.pkHex;
      const generation = this._sessionGeneration;
      const isCurrent = () => this._sessionGeneration === generation && this.loadedFor === account && keyStore.pkHex === account;
      const snapshot: ConnectionSettings = JSON.parse(JSON.stringify(this.settings));
      const relays = settingsSyncRelays("write");
      this.syncing = true;
      this.syncError = "";
      let allSucceeded = true;

      try {
        for (const domain of [...new Set(domains)]) {
          if (!isCurrent()) return false;
          const items = domain === "relays" ? snapshot.relays : snapshot.mediaServers;
          const identifier = domain === "relays" ? RELAY_SYNC_IDENTIFIER : MEDIA_SYNC_IDENTIFIER;
          const payload: SettingsSyncPayload<RelayConfig | MediaServer> = {
            version: SETTINGS_VERSION,
            type: identifier,
            items
          };
          const encrypted = await keyStore.nip44Encrypt(account, JSON.stringify(payload));
          if (!isCurrent()) return false;
          const event = await keyStore.signEvent({
            kind: 30078,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["d", identifier], ["client", "HaiNei"]],
            content: encrypted
          });
          if (!isCurrent() || event.pubkey !== account) return false;
          const results = await publish(relays, event);
          if (!isCurrent()) return false;
          const anySuccess = results.some(result => result.ok);
          const bootstrapSuccess = results.some(result =>
            result.ok && (DEFAULT_RELAY_URLS as readonly string[]).includes(result.relay)
          );
          if (!anySuccess) {
            allSucceeded = false;
            continue;
          }
          if (domain === "relays") {
            this.settings.relays = this.settings.relays.map(item =>
              snapshot.relays.some(sent => sent.url === item.url && JSON.stringify(sent) === JSON.stringify(item))
                ? syncStampItem(item, event.created_at, event.id) : item);
          } else {
            this.settings.mediaServers = this.settings.mediaServers.map(item =>
              snapshot.mediaServers.some(sent => sent.id === item.id && JSON.stringify(sent) === JSON.stringify(item))
                ? syncStampItem(item, event.created_at, event.id) : item);
          }
          this.lastSyncTimestamp = Math.max(this.lastSyncTimestamp, event.created_at);
          if (bootstrapSuccess && domain === "relays") {
            this.lastRelaySyncTimestamp = Math.max(this.lastRelaySyncTimestamp, event.created_at);
          } else if (bootstrapSuccess) {
            this.lastMediaSyncTimestamp = Math.max(this.lastMediaSyncTimestamp, event.created_at);
          } else {
            allSucceeded = false;
          }
          this.save();
        }
        if (allSucceeded) {
          this.bootstrapSyncVersion = SETTINGS_VERSION;
          this.save();
        } else {
          this.syncError = "部分设置同步失败，本地配置已生效";
        }
        return allSucceeded;
      } catch (error) {
        if (!isCurrent()) return false;
        this.syncError = "设置同步失败，本地配置已生效";
        logger.warn("[settings] encrypted publish failed", {
          account: account.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error
        });
        return false;
      } finally {
        if (isCurrent()) this.syncing = false;
      }
    },

    async fetchFromRelays(): Promise<boolean> {
      const keyStore = useKeyStore();
      if (!keyStore.isLoggedIn || keyStore.pkHex !== this.loadedFor || this._isFetching) return false;
      const account = keyStore.pkHex;
      const generation = this._sessionGeneration;
      const isCurrent = () => this._sessionGeneration === generation && this.loadedFor === account && keyStore.pkHex === account;
      const relays = settingsSyncRelays("read");
      if (!relays.length) return false;

      this._isFetching = true;
      this.syncing = true;
      this.syncError = "";
      try {
        const sub = subscribe(relays, [
          { kinds: [30078], authors: [account], "#d": [RELAY_SYNC_IDENTIFIER, MEDIA_SYNC_IDENTIFIER], limit: 20 },
          { kinds: [10002], authors: [account], limit: 5 }
        ]);

        return await new Promise(resolve => {
          const expectedRelays = new Set(relays);
          const completedRelays = new Set<string>();
          const candidates = new Map<string, any>();
          let finished = false;
          let timer: ReturnType<typeof setTimeout>;
          const cancel = () => {
            finished = true;
            clearTimeout(timer);
            closeSubscription(sub);
            resolve(false);
          };
          cancelSettingsFetch = cancel;

          const finish = async () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            closeSubscription(sub);
            if (!isCurrent()) {
              resolve(false);
              return;
            }

            const ordered = [...candidates.values()].sort((a, b) =>
              (Number(a.created_at) - Number(b.created_at)) || String(a.id).localeCompare(String(b.id))
            );
            let changed = false;
            let newestNip65: any = null;
            for (const event of ordered) {
              if (!isCurrent()) { resolve(false); return; }
              if (event.kind === 10002) {
                newestNip65 = event;
                continue;
              }
              if (event.kind !== 30078 || !keyStore.supportsNip44) continue;
              const identifier = event.tags?.find((tag: unknown) =>
                Array.isArray(tag) && tag[0] === "d"
              )?.[1];
              if (identifier !== RELAY_SYNC_IDENTIFIER && identifier !== MEDIA_SYNC_IDENTIFIER) continue;
              try {
                const decrypted = await keyStore.nip44Decrypt(account, event.content);
                if (!isCurrent()) { resolve(false); return; }
                const payload = JSON.parse(decrypted) as SettingsSyncPayload<unknown>;
                if (!payload || !Array.isArray(payload.items) || payload.type !== identifier) continue;
                const migrated = migrateConnectionSettings(
                  identifier === RELAY_SYNC_IDENTIFIER
                    ? { relays: payload.items }
                    : { mediaServers: payload.items },
                  { deviceId: this.deviceId }
                );
                const metadata = { createdAt: Number(event.created_at) || 0, eventId: String(event.id || "") };
                if (identifier === RELAY_SYNC_IDENTIFIER) {
                  this.settings.relays = mergeRelayConfigs(this.settings.relays, migrated.relays, metadata);
                  this.lastRelaySyncTimestamp = Math.max(this.lastRelaySyncTimestamp, metadata.createdAt);
                } else {
                  this.settings.mediaServers = mergeMediaServers(this.settings.mediaServers, migrated.mediaServers, metadata);
                  this.lastMediaSyncTimestamp = Math.max(this.lastMediaSyncTimestamp, metadata.createdAt);
                }
                this.lastSyncTimestamp = Math.max(this.lastSyncTimestamp, metadata.createdAt);
                changed = true;
              } catch (error) {
                if (!isCurrent()) { resolve(false); return; }
                logger.warn("[settings] ignored invalid encrypted settings event", {
                  event: String(event.id || "").slice(0, 8),
                  errorType: error instanceof Error ? error.name : typeof error
                });
              }
            }

            if (!isCurrent()) { resolve(false); return; }
            if (newestNip65) {
              this.settings.relays = relayConfigsFromNip65(
                newestNip65.tags,
                {
                  createdAt: Number(newestNip65.created_at) || 0,
                  eventId: String(newestNip65.id || "")
                },
                account,
                this.settings.relays
              );
              this.lastRelaySyncTimestamp = Math.max(
                this.lastRelaySyncTimestamp,
                Number(newestNip65.created_at) || 0
              );
              changed = true;
            }

            if (changed) {
              this.save();
              this.applySettings();
            }
            resolve(changed);
          };

          timer = setTimeout(() => void finish(), 5_000);
          sub.on("event", event => {
            if (!finished && isCurrent() && event?.id) candidates.set(event.id, event);
          });
          sub.on("eose", (relayUrl: string) => {
            completedRelays.add(relayUrl);
            if (completedRelays.size >= expectedRelays.size) void finish();
          });
        });
      } catch (error) {
        logger.warn("[settings] remote sync failed; local settings remain active", {
          account: account.slice(0, 8),
          errorType: error instanceof Error ? error.name : typeof error
        });
        return false;
      } finally {
        if (isCurrent()) {
          cancelSettingsFetch = null;
          this.syncing = false;
          this._isFetching = false;
        }
      }
    }
  }
});
