import { defineStore } from "pinia";
import type { BookmarkRecord } from "@/db/dexie";
import { bookmarkRepository } from "@/repositories/bookmarkRepository";
import { useKeyStore } from "@/stores/keys";
import { ensureBookmarkCloudSyncState, noteBookmarkLocalMutation } from "@/services/bookmarkCloudSync";
import { recoverNip51SnapshotDeletionBatch, schedulePrivateBookmarkMirror } from "@/services/privateBookmarkMirror";

export const useBookmarksStore = defineStore("bookmarks", {
  state: () => ({ records: [] as BookmarkRecord[], loadedFor: "" }),
  getters: {
    isBookmarked: state => (messageId: string) => state.records.some(item => item.messageId === messageId)
  },
  actions: {
    async load(accountPubkey?: string, force = false) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account) return this.reset();
      if (this.loadedFor === account && !force) return;
      this.reset();
      this.loadedFor = account;
      let records = await bookmarkRepository.list(account);
      await ensureBookmarkCloudSyncState(account);
      const recovered = recoverNip51SnapshotDeletionBatch(records);
      if (recovered.length) {
        await Promise.all(recovered.map(record => bookmarkRepository.put(record)));
        records = await bookmarkRepository.list(account);
        const keys = useKeyStore();
        noteBookmarkLocalMutation(keys, account, { delayMs: 0 });
        schedulePrivateBookmarkMirror(keys, 0);
      }
      if (this.loadedFor === account) this.records = records.filter(record => !record.deleted);
    },
    reset() {
      this.records = [];
      this.loadedFor = "";
    },
    async toggle(messageId: string) {
      const account = this.loadedFor;
      if (!account || !messageId) return false;
      const existing = this.records.find(item => item.messageId === messageId);
      if (existing) {
        this.records = this.records.filter(item => item.messageId !== messageId);
        try {
          await bookmarkRepository.put({ ...existing, deleted: true, updatedAt: Date.now() });
          const keys = useKeyStore();
          noteBookmarkLocalMutation(keys, account);
          schedulePrivateBookmarkMirror(keys);
          return false;
        } catch (error) {
          this.records = [existing, ...this.records];
          throw error;
        }
      }
      const now = Date.now();
      const record = { accountPubkey: account, messageId, createdAt: now, updatedAt: now, deleted: false };
      this.records = [record, ...this.records];
      try {
        await bookmarkRepository.put(record);
        const keys = useKeyStore();
        noteBookmarkLocalMutation(keys, account);
        schedulePrivateBookmarkMirror(keys);
        return true;
      } catch (error) {
        this.records = this.records.filter(item => item.messageId !== messageId);
        throw error;
      }
    }
  }
});
