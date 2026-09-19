import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import { getRelaysFromStorage, subscribe, publish } from "@/nostr/relays";
import { logger } from "@/utils/logger";
import { closeSubscription } from "@/utils/closeSubscription";

/* =========================
 * Types（原样保留）
 * ========================= */

export type Friend = {
  id?: string;
  pubkey: string;
  name: string;
  groups?: string[];
  group?: string;
  note?: string;
};

type StoredFriendData = {
  list: Friend[];
  lastSyncTimestamp: number;
};

function storageKeyFor(pkHex: string | null | undefined) {
  if (!pkHex) return null;
  return `nostr_friends_${pkHex}`;
}

/* =========================
 * 工具函数（新增，但不破坏原结构）
 * ========================= */

function normalizeFriend(f: Friend): Friend {
  return {
    ...f,
    groups: f.groups ?? (f.group ? [f.group] : [])
  };
}

function mergeFriend(oldF: Friend, newF: Friend): Friend {
  return {
    ...oldF,
    ...newF,
    groups: Array.from(
      new Set([...(oldF.groups ?? []), ...(newF.groups ?? [])])
    )
  };
}

function mergeList(local: Friend[], incoming: Friend[]): Friend[] {
  const map = new Map<string, Friend>();

  for (const f of local) {
    map.set(f.pubkey, normalizeFriend(f));
  }

  for (const f of incoming) {
    const nf = normalizeFriend(f);
    const existing = map.get(nf.pubkey);
    map.set(nf.pubkey, existing ? mergeFriend(existing, nf) : nf);
  }

  return Array.from(map.values());
}

/* =========================
 * Store
 * ========================= */

export const useFriendsStore = defineStore("friends", {
  state: () => ({
    list: [] as Friend[],
    loadedFor: "",
    syncing: false,
    lastSyncTimestamp: 0,
    syncError: "",
    version: 0
  }),

  getters: {
    sortedList(): Friend[] {
      return [...this.list].sort((a, b) =>
        (a.name || "").localeCompare(b.name || "", "zh-CN")
      );
    },
    getAcceptedList(): (isAccepted: (peerPubkey: string) => boolean) => Friend[] {
      return isAccepted => {
        if (typeof isAccepted !== "function") return [];
        return this.sortedList.filter(friend => !!friend.pubkey && isAccepted(friend.pubkey));
      };
    }
  },

  actions: {
    /* =========================
     * Load（严格 timestamp 决策）
     * ========================= */

    async load(pk?: string) {
      const ks = useKeyStore();
      const targetPk = pk ?? ks.pkHex;
      if (!targetPk) {
        this.reset(false);
        return;
      }

      if (this.loadedFor && this.loadedFor !== targetPk) {
        this.reset(false);
      }
      if (this.loadedFor === targetPk) return;
      // A missing local/relay record must resolve to an explicitly empty account.
      this.list = [];
      this.lastSyncTimestamp = 0;
      this.syncError = "";
      this.loadedFor = targetPk;

      const key = storageKeyFor(targetPk);
      if (!key) return;

      let localData: StoredFriendData | null = null;

      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            localData = { list: parsed, lastSyncTimestamp: 0 };
          } else if (parsed?.list) {
            localData = parsed;
          }
        }
      } catch (e) {
        logger.warn("Failed to parse local friend data", e);
      }

      if (!ks.isLoggedIn || !ks.supportsNip04) {
        if (localData) {
          this.list = localData.list;
          this.lastSyncTimestamp = localData.lastSyncTimestamp;
        }
        return;
      }

      const relayFetched = await this.fetchFromRelays();
      const relayTs = this.lastSyncTimestamp;
      const localTs = localData?.lastSyncTimestamp ?? 0;

      // ===== 决策表 =====
      if (relayFetched) {
        if (!localData || localTs === 0) {
          return; // relay 已写入
        }

        if (relayTs > localTs) {
          return; // relay 更新
        }

        if (relayTs < localTs) {
          this.list = localData.list;
          this.lastSyncTimestamp = localTs;
          this.publishToRelays().catch(e => logger.warn("[friends] relay publish failed", e));
          return;
        }

        // 相等 → merge
        this.list = mergeList(this.list, localData.list);
        this.save();
        return;
      }

      // relay 无数据
      if (localData) {
        this.list = localData.list;
        this.lastSyncTimestamp = localTs;
        this.publishToRelays().catch(e => logger.warn("[friends] relay publish failed", e));
      } else {
        this.list = [];
        this.lastSyncTimestamp = 0;
      }
    },

    reset(removeFromStorage = false) {
      const previousPk = this.loadedFor;
      this.list = [];
      this.loadedFor = "";
      this.syncing = false;
      this.lastSyncTimestamp = 0;
      this.syncError = "";
      this.version++;

      if (removeFromStorage && previousPk) {
        try {
          localStorage.removeItem(`nostr_friends_${previousPk}`);
        } catch (e) {
          logger.warn(`[friends] remove storage failed account=${previousPk.slice(0, 8)}`, e);
        }
      }
    },

    save() {
      const key = storageKeyFor(this.loadedFor);
      if (!key) return;

      const data: StoredFriendData = {
        list: this.list,
        lastSyncTimestamp: this.lastSyncTimestamp
      };

      localStorage.setItem(key, JSON.stringify(data));
    },

    /* =========================
     * 本地修改（永远 bump timestamp）
     * ========================= */

    add(friend: Friend) {
      if (!friend.pubkey || !friend.name?.trim()) return false;
      if (this.list.some(f => f.pubkey === friend.pubkey)) return false;

      this.list.push(normalizeFriend(friend));
      this.lastSyncTimestamp = Math.floor(Date.now() / 1000);
      this.version++;
      this.save();

      const ks = useKeyStore();
      if (ks.supportsNip04) {
        this.publishToRelays().catch(e => logger.warn("[friends] relay publish failed", e));
      }
      return true;
    },

    remove(pubkey: string) {
      const before = this.list.length;
      this.list = this.list.filter(f => f.pubkey !== pubkey);
      if (this.list.length === before) return false;

      this.lastSyncTimestamp = Math.floor(Date.now() / 1000);
      this.version++;
      this.save();

      const ks = useKeyStore();
      if (ks.supportsNip04) {
        this.publishToRelays().catch(e => logger.warn("[friends] relay publish failed", e));
      }
      return true;
    },

    update(pubkey: string, patch: Partial<Friend>) {
      const f = this.list.find(x => x.pubkey === pubkey);
      if (!f) return false;
      if (patch.name !== undefined && !patch.name.trim()) return false;

      Object.assign(f, patch);
      this.lastSyncTimestamp = Math.floor(Date.now() / 1000);
      this.version++;
      this.save();

      const ks = useKeyStore();
      if (ks.supportsNip04) {
        this.publishToRelays().catch(e => logger.warn("[friends] relay publish failed", e));
      }
      return true;
    },

    /* =========================
     * Relay：只做 IO，不做决策
     * ========================= */

    async publishToRelays(): Promise<boolean> {
      const ks = useKeyStore();
      if (!ks.isLoggedIn || !ks.supportsNip04) return false;

      this.syncing = true;
      try {
        const encrypted = await ks.nip04Encrypt(
          ks.pkHex,
          JSON.stringify(this.list)
        );

        const event = await ks.signEvent({
          kind: 30000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "close-friends"]],
          content: encrypted
        });

        const relays = getRelaysFromStorage();
        const results = await publish(relays, event);

        if (results.some(r => r.ok)) {
          this.lastSyncTimestamp = event.created_at;
          this.save();
          return true;
        }
        return false;
      } finally {
        this.syncing = false;
      }
    },

    async fetchFromRelays(): Promise<boolean> {
      const ks = useKeyStore();
      if (!ks.isLoggedIn || !ks.supportsNip04) return false;
      const accountPk = ks.pkHex;

      this.syncing = true;

      try {
        const relays = getRelaysFromStorage();
        const filters = {
          kinds: [30000],
          authors: [ks.pkHex],
          "#d": ["close-friends"],
          limit: 1
        };

        return new Promise(resolve => {
          const expectedRelays = new Set(relays);
          const completedRelays = new Set<string>();
          const candidates = new Map<string, any>();
          let finished = false;
          const sub = subscribe(relays, [filters]);
          let timer = 0;

          const finish = async (reason: "eose" | "timeout" | "no-relays") => {
            if (finished) return;
            finished = true;
            window.clearTimeout(timer);
            closeSubscription(sub);
            logger.info(`[friends] fetch complete account=${accountPk.slice(0, 8)} reason=${reason} eose=${completedRelays.size}/${expectedRelays.size} candidates=${candidates.size}`);

            if (ks.pkHex !== accountPk || this.loadedFor !== accountPk) {
              logger.warn(`[account] friends fetch discarded account=${accountPk.slice(0, 8)}`);
              resolve(false);
              return;
            }

            const ordered = [...candidates.values()].sort((a, b) =>
              (b.created_at - a.created_at) || String(a.id).localeCompare(String(b.id))
            );
            for (const candidate of ordered) {
              try {
                const decrypted = await ks.nip04Decrypt(accountPk, candidate.content);
                if (ks.pkHex !== accountPk || this.loadedFor !== accountPk) {
                  logger.warn(`[account] friends decrypt discarded account=${accountPk.slice(0, 8)} event=${candidate.id?.slice(0, 8)}`);
                  resolve(false);
                  return;
                }
                const incoming = JSON.parse(decrypted);
                if (!Array.isArray(incoming)) continue;
                this.list = mergeList(this.list, incoming);
                this.lastSyncTimestamp = candidate.created_at;
                this.save();
                resolve(true);
                return;
              } catch (e) {
                logger.warn(`[friends] candidate invalid event=${candidate.id?.slice(0, 8)}`, e);
              }
            }
            resolve(false);
          };
          timer = window.setTimeout(() => void finish("timeout"), 5000);

          sub.on("event", evt => {
            if (ks.pkHex !== accountPk || this.loadedFor !== accountPk) return;
            if (evt?.id) candidates.set(evt.id, evt);
          });

          sub.on("eose", (relayUrl: string) => {
            completedRelays.add(relayUrl);
            logger.debug(`[friends] EOSE relay=${relayUrl} count=${completedRelays.size}/${expectedRelays.size}`);
            if (completedRelays.size >= expectedRelays.size) void finish("eose");
          });

          if (expectedRelays.size === 0) void finish("no-relays");
        });
      } catch (e) {
        logger.error(`[friends] relay fetch failed account=${accountPk.slice(0, 8)}`, e);
        this.syncing = false;
        return false;
      } finally {
        if (this.loadedFor === accountPk) this.syncing = false;
      }
    }
  }
});
