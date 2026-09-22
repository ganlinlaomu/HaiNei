import { defineStore } from "pinia";
import type { BookmarkRecord } from "@/db/dexie";
import { bookmarkRepository } from "@/repositories/bookmarkRepository";
import { useKeyStore } from "@/stores/keys";

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
      if (this.loadedFor === account) this.records = records;
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
        await bookmarkRepository.delete(account, messageId);
        return false;
      }
      const record = { accountPubkey: account, messageId, createdAt: Date.now() };
      this.records = [record, ...this.records];
      await bookmarkRepository.put(record);
      return true;
    }
  }
});
