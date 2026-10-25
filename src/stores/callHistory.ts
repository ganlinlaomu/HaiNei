import { defineStore } from "pinia";
import Dexie, { liveQuery } from "dexie";
import { db } from "@/db/dexie";
import { metaRepository } from "@/repositories/metaRepository";
import {
  CALL_HISTORY_DELETED_PREFIX, CALL_HISTORY_SYNC_PREFIX, callHistoryItem, deletedCallIds,
  loadDeletedCallIds, uniqueCallHistory, type CallHistoryItem,
} from "@/services/callHistory";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { useKeyStore } from "@/stores/keys";

const SEEN_KEY = "call-history:seen-through";
const DELETED_PREFIX = CALL_HISTORY_DELETED_PREFIX;
const LOCAL_MISSED_PREFIX = "call-history:missed-record:";
/** Carry over recent missed calls on first run, rather than marking all as read at PWA open. */
const FIRST_RUN_HISTORY_SECONDS = 7 * 24 * 60 * 60;
let generation = 0;
let subscription: { unsubscribe(): void } | undefined;
let pendingLoad: { account: string; promise: Promise<void> } | undefined;

/**
 * Account-local call history presentation state, separate from DM read cursors.
 * A tombstone hides every copy of a logical call id even when NIP-17 re-syncs it.
 */
export const useCallHistoryStore = defineStore("callHistory", {
  state: () => ({
    loadedFor: "",
    ready: false,
    seenThrough: 0,
    deletedIds: [] as string[],
    recentMissed: [] as CallHistoryItem[],
    localMissed: [] as CallHistoryItem[],
  }),
  getters: {
    missedUnreadCount: state => uniqueCallHistory([...state.recentMissed, ...state.localMissed]
      .filter(item => item.missed && item.createdAt > state.seenThrough && !state.deletedIds.includes(item.id))).length,
    isDeleted: state => (id: string) => state.deletedIds.includes(id),
  },
  actions: {
    async load(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (this.loadedFor === account && this.ready) return;
      if (pendingLoad?.account === account) return pendingLoad.promise;
      const token = ++generation;
      subscription?.unsubscribe(); subscription = undefined;
      this.loadedFor = account;
      this.ready = false;
      this.seenThrough = 0;
      this.recentMissed = [];
      this.deletedIds = [];
      this.localMissed = [];
      if (!account) return;
      const promise = (async () => {
        const [seen, tombstones, fallbackRecords, syncedPreferences] = await Promise.all([
          metaRepository.get(account, SEEN_KEY),
          metaRepository.listPrefix(account, DELETED_PREFIX),
          metaRepository.listPrefix(account, LOCAL_MISSED_PREFIX),
          metaRepository.get(account, "feed_preferences_v2"),
        ]);
        if (token !== generation || this.loadedFor !== account) return;
        // Do not mark offline/missed calls as read merely because the PWA was reopened.
        const readAt = typeof seen?.value === "number" && Number.isFinite(seen.value)
          ? Math.max(0, Math.floor(seen.value))
          : Math.max(0, Math.floor(Date.now() / 1000) - FIRST_RUN_HISTORY_SECONDS);
        if (!seen) await metaRepository.put(account, SEEN_KEY, readAt);
        if (token !== generation || this.loadedFor !== account) return;
        this.seenThrough = readAt;
        this.deletedIds = [...deletedCallIds(tombstones, syncedPreferences?.value)];
        this.localMissed = fallbackRecords.flatMap(row => {
          const value = row.value as { peer?: unknown; createdAt?: unknown } | null;
          const suffix = row.key.slice(LOCAL_MISSED_PREFIX.length);
          const [peer, id] = suffix.split(":");
          if (!value || !/^[0-9a-f]{64}$/.test(peer || "") || !/^[0-9a-f]{32}$/.test(id || "") ||
            typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return [];
          return [{ id: suffix, peer, createdAt: value.createdAt, text: "未接来电",
            missed: true, direction: "incoming" as const }];
        });
        this.ready = true;
        this.observe(account, token);
      })();
      pendingLoad = { account, promise };
      try { await promise; }
      finally { if (pendingLoad?.promise === promise) pendingLoad = undefined; }
    },
    observe(account: string, token = generation) {
      subscription?.unsubscribe();
      const cutoff = this.seenThrough;
      subscription = liveQuery(async () => {
        const deleted = await loadDeletedCallIds(account);
        const found: CallHistoryItem[] = [];
        await db.syncedMessages.where("[accountPubkey+createdAt+id]")
          .between([account, cutoff + 1, Dexie.minKey],
            [account, Dexie.maxKey, Dexie.maxKey])
          .each(record => {
            const item = callHistoryItem(record, account);
            if (item?.missed && !deleted.has(item.id)) found.push(item);
          });
        return { items: uniqueCallHistory(found), deleted: [...deleted] };
      }).subscribe({
        next: result => {
          if (generation === token && this.loadedFor === account && this.seenThrough === cutoff) {
            // Never temporarily resurrect a locally deleted item while an
            // earlier Dexie liveQuery snapshot is finishing.
            this.deletedIds = [...new Set([...this.deletedIds, ...result.deleted])];
            this.recentMissed = result.items.filter(item => !this.deletedIds.includes(item.id));
          }
        },
        error: () => {
          if (generation === token && this.loadedFor === account) this.recentMissed = [];
        },
      });
    },
    /**
     * A verified, authorized caller's cancel can arrive even when its ordinary
     * missed-call log is delayed or unavailable. Retain an account-scoped local
     * fallback, deduplicated with the later NIP-17 log by peer/callId.
     */
    async recordIncomingMissed(accountPubkey: string, peerPubkey: string, callId: string, createdAt: number) {
      const account = accountPubkey.toLowerCase(), peer = peerPubkey.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(account) || !/^[0-9a-f]{64}$/.test(peer)
        || !/^[0-9a-f]{32}$/.test(callId) || peer === account || !Number.isFinite(createdAt)) return;
      await this.load(account);
      if (this.loadedFor !== account || !this.ready) return;
      const id = `${peer}:${callId}`;
      if (this.localMissed.some(item => item.id === id)) return;
      const item: CallHistoryItem = { id, peer, createdAt, text: "未接来电",
        missed: true, direction: "incoming" };
      await metaRepository.put(account, LOCAL_MISSED_PREFIX + id, { peer, createdAt });
      if (this.loadedFor === account && !this.localMissed.some(row => row.id === id)) {
        this.localMissed = [item, ...this.localMissed];
      }
    },
    async acknowledge(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (this.loadedFor !== account || !this.ready || !account) return;
      const timestamp = Math.max(this.seenThrough, Math.floor(Date.now() / 1000) - 1);
      if (timestamp === this.seenThrough) return;
      this.seenThrough = timestamp;
      this.recentMissed = [];
      this.observe(account);
      await metaRepository.put(account, SEEN_KEY, timestamp);
    },
    async deleteRecord(accountPubkey: string, id: string) {
      const account = accountPubkey.toLowerCase();
      if (!id || !account || this.loadedFor !== account || !this.ready || this.deletedIds.includes(id)) return;
      await metaRepository.put(account, DELETED_PREFIX + id, true);
      if (this.loadedFor === account && !this.deletedIds.includes(id)) this.deletedIds = [...this.deletedIds, id];
      // Use the existing encrypted account preference sync, just as hidden
      // dynamics and friend metadata retain their deletion state.
      const keys = useKeyStore();
      if (keys.pkHex.toLowerCase() === account && this.loadedFor === account) {
        try {
          const preferences = useFeedPreferencesStore();
          await preferences.load(account);
          if (this.loadedFor === account && keys.pkHex.toLowerCase() === account) {
            await preferences.hide(CALL_HISTORY_SYNC_PREFIX + id);
          }
        } catch {
          // Local durable tombstone remains authoritative even when offline.
          // Account state sync can retry independently when connectivity returns.
        }
      }
    },
    reset() {
      ++generation;
      subscription?.unsubscribe(); subscription = undefined;
      pendingLoad = undefined;
      this.loadedFor = "";
      this.ready = false;
      this.seenThrough = 0;
      this.deletedIds = [];
      this.recentMissed = [];
      this.localMissed = [];
    },
  },
});
