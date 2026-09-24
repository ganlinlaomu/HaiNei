import { defineStore } from "pinia";
import type { BookmarkRecord } from "@/db/dexie";
import { bookmarkRepository } from "@/repositories/bookmarkRepository";
import { useKeyStore } from "@/stores/keys";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

export const useBookmarksStore = defineStore("bookmarks", {
  state: () => ({ records: [] as BookmarkRecord[], loadedFor: "" }),
  getters: {
    isBookmarked: state => (messageId: string) => state.records.some(item => item.messageId === messageId)
  },
  actions: {
    async load(accountPubkey?: string) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account) return this.reset();
      if (this.loadedFor === account) return;
      this.reset();
      this.loadedFor = account;
      const records = await bookmarkRepository.list(account);
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
          scheduleAccountStateSync(useKeyStore(), "bookmarks");
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
        scheduleAccountStateSync(useKeyStore(), "bookmarks");
        return true;
      } catch (error) {
        this.records = this.records.filter(item => item.messageId !== messageId);
        throw error;
      }
    }
  }
});
