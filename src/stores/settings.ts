import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import {
  getRelaysFromStorage,
  subscribe,
  publish,
  reconnectRelay,
  disconnectRelay
} from "@/nostr/relays";
import { logger } from "@/utils/logger";
import { closeSubscription } from "@/utils/closeSubscription";

/* ------------------------------------------------------------------ */
/* types */
/* ------------------------------------------------------------------ */

export type BlossomServer = {
  url: string;
  token: string;
};

export type AppSettings = {
  relays: string[];
  blossomServers: BlossomServer[];
};

type StoredSettingsData = {
  settings: AppSettings;
  lastSyncTimestamp: number;
};

function storageKeyFor(pkHex?: string | null) {
  if (!pkHex) return null;
  return `nostr_settings_${pkHex}`;
}

/* ------------------------------------------------------------------ */
/* store */
/* ------------------------------------------------------------------ */

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    settings: {
      relays: [],
      blossomServers: []
    } as AppSettings,

    loadedFor: "" as string,

    syncing: false,
    syncError: "",
    lastSyncTimestamp: 0,

    _isFetching: false
  }),

  getters: {
    relayList: (s) => s.settings.relays,
    blossomList: (s) => s.settings.blossomServers
  },

  actions: {
    /* ================================================================
     * reset — 切账号 / 登出必用
     * ================================================================ */
    reset() {
      this.settings = { relays: [], blossomServers: [] };
      this.loadedFor = "";
      this.syncing = false;
      this.syncError = "";
      this.lastSyncTimestamp = 0;
      this._isFetching = false;
      try {
        localStorage.removeItem("custom-relays");
        localStorage.removeItem("blossom_servers");
        localStorage.removeItem("blossom_upload_url");
        localStorage.removeItem("blossom_token");
        window.dispatchEvent(new CustomEvent("blossom-config-updated", {
          detail: { servers: [] }
        }));
      } catch (e) {
        logger.warn("[settings] clear global mirrors failed", e);
      }
    },

    /* ================================================================
     * load — 按 pk 隔离
     * ================================================================ */
    async load(pk?: string) {
      const ks = useKeyStore();
      const targetPk = pk ?? ks.pkHex;

      if (!targetPk) {
        this.reset();
        return;
      }

      // 🔥 切账号
      if (this.loadedFor !== targetPk) {
        this.reset();
      }

      if (this.loadedFor === targetPk) return;
      this.loadedFor = targetPk;

      const key = storageKeyFor(targetPk);
      let hasLocal = false;

      /* ---------- local ---------- */
      try {
        const raw = key ? localStorage.getItem(key) : null;
        if (raw) {
          const parsed = JSON.parse(raw) as StoredSettingsData;
          if (parsed?.settings) {
            this.settings = parsed.settings;
            this.lastSyncTimestamp = parsed.lastSyncTimestamp || 0;
            this.applySettings();
            hasLocal = true;
          }
        }
      } catch (e) {
        logger.error("settings local load failed", e);
      }

      /* ---------- relay bootstrap ---------- */
      if (!hasLocal) {
        await this.bootstrapFetch();
      }
    },

    /* ================================================================
     * bootstrapFetch
     * ================================================================ */
    async bootstrapFetch() {
      const ks = useKeyStore();
      if (!ks.isLoggedIn || ks.pkHex !== this.loadedFor) return;

      const prev = this.syncing;
      this.syncing = false;
      try {
        await this.fetchFromRelays();
      } finally {
        this.syncing = prev;
      }
    },

    /* ================================================================
     * apply
     * ================================================================ */
    applySettings() {
      try {
        localStorage.setItem("custom-relays", this.settings.relays.join("\n"));
        for (const r of this.settings.relays) {
          try { reconnectRelay(r); } catch (e) { logger.warn(`[settings] relay reconnect failed relay=${r}`, e); }
        }
      } catch (e) {
        logger.error("apply relay failed", e);
      }

      try {
        localStorage.setItem(
          "blossom_servers",
          JSON.stringify(this.settings.blossomServers)
        );

        const first = this.settings.blossomServers[0];
        if (first) {
          localStorage.setItem("blossom_upload_url", first.url);
          localStorage.setItem("blossom_token", first.token || "");
        }

        window.dispatchEvent(
          new CustomEvent("blossom-config-updated", {
            detail: { servers: this.settings.blossomServers }
          })
        );
      } catch (e) {
        logger.error("apply blossom failed", e);
      }
    },

    /* ================================================================
     * save
     * ================================================================ */
    save() {
      const key = storageKeyFor(this.loadedFor);
      if (!key) return;

      const data: StoredSettingsData = {
        settings: this.settings,
        lastSyncTimestamp: this.lastSyncTimestamp
      };

      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch {}
    },

    /* ================================================================
     * update
     * ================================================================ */
    updateRelays(relays: string[]) {
      const next = [...new Set(relays.map(value => value.trim()).filter(Boolean))];
      const previous = this.settings.relays;
      for (const relay of previous) {
        if (!next.includes(relay)) disconnectRelay(relay);
      }
      this.settings.relays = next;
      localStorage.setItem("custom-relays", next.join("\n"));
      for (const relay of next) {
        if (!previous.includes(relay)) reconnectRelay(relay);
      }
      this.save();
      if (useKeyStore().supportsNip04) {
        this.publishToRelays().catch(() => {});
      }
    },

    updateBlossomServers(servers: BlossomServer[]) {
      this.settings.blossomServers = [...servers];
      this.save();
      if (useKeyStore().supportsNip04) {
        this.publishToRelays().catch(() => {});
      }
    },

    /* ================================================================
     * publish
     * ================================================================ */
    async publishToRelays(): Promise<boolean> {
      const ks = useKeyStore();
      if (!ks.isLoggedIn || ks.pkHex !== this.loadedFor) return false;

      this.syncing = true;
      this.syncError = "";

      try {
        const encrypted = await ks.nip04Encrypt(
          ks.pkHex,
          JSON.stringify(this.settings)
        );

        const event = await ks.signEvent({
          kind: 30000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "close-settings"]],
          content: encrypted
        });

        const result = await publish(getRelaysFromStorage(), event);
        if (!result.some(r => r.ok)) {
          this.syncError = "所有 relay 发布失败";
          return false;
        }

        this.lastSyncTimestamp = event.created_at;
        this.save();
        return true;
      } catch (e: any) {
        this.syncError = e.message || "发布失败";
        return false;
      } finally {
        this.syncing = false;
      }
    },

    /* ================================================================
     * fetch
     * ================================================================ */
    async fetchFromRelays(): Promise<boolean> {
      const ks = useKeyStore();
      if (!ks.isLoggedIn || ks.pkHex !== this.loadedFor) return false;
      if (this._isFetching) return false;
      const accountPk = ks.pkHex;

      this._isFetching = true;
      this.syncing = true;
      this.syncError = "";

      try {
        const relays = getRelaysFromStorage();
        const sub = subscribe(relays, [{
          kinds: [30000],
          authors: [ks.pkHex],
          "#d": ["close-settings"],
          limit: 1
        }]);

        return await new Promise(resolve => {
          const expectedRelays = new Set(relays);
          const completedRelays = new Set<string>();
          const candidates = new Map<string, any>();
          let finished = false;
          let timer: ReturnType<typeof setTimeout>;

          const finish = async (reason: "eose" | "timeout" | "no-relays") => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            closeSubscription(sub);
            logger.info(`[settings] fetch complete account=${accountPk.slice(0, 8)} reason=${reason} eose=${completedRelays.size}/${expectedRelays.size} candidates=${candidates.size}`);

            if (ks.pkHex !== accountPk || this.loadedFor !== accountPk) {
              logger.warn(`[account] settings fetch discarded account=${accountPk.slice(0, 8)}`);
              resolve(false);
              return;
            }

            const ordered = [...candidates.values()].sort((a, b) =>
              (b.created_at - a.created_at) || String(a.id).localeCompare(String(b.id))
            );
            for (const candidate of ordered) {
              try {
                const dec = await ks.nip04Decrypt(accountPk, candidate.content);
                if (ks.pkHex !== accountPk || this.loadedFor !== accountPk) {
                  logger.warn(`[account] settings decrypt discarded account=${accountPk.slice(0, 8)} event=${candidate.id?.slice(0, 8)}`);
                  resolve(false);
                  return;
                }
                const parsed = JSON.parse(dec);
                if (!parsed || !Array.isArray(parsed.relays) || !Array.isArray(parsed.blossomServers)) continue;
                this.settings = parsed;
                this.lastSyncTimestamp = candidate.created_at;
                this.save();
                this.applySettings();
                resolve(true);
                return;
              } catch (e) {
                logger.warn(`[settings] candidate invalid event=${candidate.id?.slice(0, 8)}`, e);
              }
            }
            this.syncError = candidates.size ? "解密失败" : "";
            resolve(false);
          };
          timer = setTimeout(() => void finish("timeout"), 5000);

          sub.on("event", e => {
            if (ks.pkHex !== accountPk || this.loadedFor !== accountPk) return;
            if (e?.id) candidates.set(e.id, e);
          });

          sub.on("eose", (relayUrl: string) => {
            completedRelays.add(relayUrl);
            logger.debug(`[settings] EOSE relay=${relayUrl} count=${completedRelays.size}/${expectedRelays.size}`);
            if (completedRelays.size >= expectedRelays.size) void finish("eose");
          });

          if (expectedRelays.size === 0) void finish("no-relays");
        });
      } finally {
        this.syncing = false;
        this._isFetching = false;
      }
    }
  }
});
