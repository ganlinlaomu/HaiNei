import { defineStore } from "pinia";
import Dexie, { liveQuery } from "dexie";
import { db } from "@/db/dexie";
import { metaRepository } from "@/repositories/metaRepository";
import { callHistoryItem, uniqueCallHistory, type CallHistoryItem } from "@/services/callHistory";

const SEEN_KEY = "call-history:seen-through";
const DELETED_PREFIX = "call-history:deleted:";
let generation = 0;
let subscription: { unsubscribe(): void } | undefined;

/**
 * Account-local call history presentation state, separate from DM read cursors.
 * A tombstone hides every copy of a logical call id even when NIP-17 re-syncs it.
 */
export const useCallHistoryStore = defineStore("callHistory", {
  state: () => ({
    loadedFor: "",
    seenThrough: 0,
    deletedIds: [] as string[],
    recentMissed: [] as CallHistoryItem[],
  }),
  getters: {
    missedUnreadCount: state => uniqueCallHistory(state.recentMissed
      .filter(item => item.missed && item.createdAt > state.seenThrough && !state.deletedIds.includes(item.id))).length,
    isDeleted: state => (id: string) => state.deletedIds.includes(id),
  },
  actions: {
    async load(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (this.loadedFor === account) return;
      const token = ++generation;
      subscription?.unsubscribe(); subscription = undefined;
      this.loadedFor = account;
      this.seenThrough = 0;
      this.recentMissed = [];
      this.deletedIds = [];
      if (!account) return;
      const [seen, tombstones] = await Promise.all([
        metaRepository.get(account, SEEN_KEY),
        metaRepository.listPrefix(account, DELETED_PREFIX),
      ]);
      if (token !== generation || this.loadedFor !== account) return;
      // On upgrading from mixed DM/call logs, old historical misses aren't new alerts.
      const readAt = typeof seen?.value === "number" && Number.isFinite(seen.value)
        ? Math.max(0, Math.floor(seen.value)) : Math.floor(Date.now() / 1000);
      if (!seen) await metaRepository.put(account, SEEN_KEY, readAt);
      if (token !== generation || this.loadedFor !== account) return;
      this.seenThrough = readAt;
      this.deletedIds = tombstones.filter(row => row.value === true)
        .map(row => row.key.slice(DELETED_PREFIX.length));
      this.observe(account, token);
    },
    observe(account: string, token = generation) {
      subscription?.unsubscribe();
      const cutoff = this.seenThrough;
      subscription = liveQuery(async () => {
        const found: CallHistoryItem[] = [];
        await db.syncedMessages.where("[accountPubkey+createdAt+id]")
          .between([account, cutoff + 1, Dexie.minKey],
            [account, Dexie.maxKey, Dexie.maxKey])
          .each(record => {
            const item = callHistoryItem(record, account);
            if (item?.missed) found.push(item);
          });
        return uniqueCallHistory(found);
      }).subscribe({
        next: items => {
          if (generation === token && this.loadedFor === account && this.seenThrough === cutoff) {
            this.recentMissed = items;
          }
        },
        error: () => {
          if (generation === token && this.loadedFor === account) this.recentMissed = [];
        },
      });
    },
    async acknowledge(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (this.loadedFor !== account || !account) return;
      const timestamp = Math.max(this.seenThrough, Math.floor(Date.now() / 1000));
      if (timestamp === this.seenThrough) return;
      this.seenThrough = timestamp;
      this.recentMissed = [];
      this.observe(account);
      await metaRepository.put(account, SEEN_KEY, timestamp);
    },
    async deleteRecord(accountPubkey: string, id: string) {
      const account = accountPubkey.toLowerCase();
      if (!id || !account || this.loadedFor !== account || this.deletedIds.includes(id)) return;
      await metaRepository.put(account, DELETED_PREFIX + id, true);
      if (this.loadedFor === account && !this.deletedIds.includes(id)) this.deletedIds = [...this.deletedIds, id];
    },
    reset() {
      ++generation;
      subscription?.unsubscribe(); subscription = undefined;
      this.loadedFor = "";
      this.seenThrough = 0;
      this.deletedIds = [];
      this.recentMissed = [];
    },
  },
});
