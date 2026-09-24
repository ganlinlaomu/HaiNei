import { defineStore } from "pinia";
import { friendRepository } from "@/repositories/friendRepository";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

export type Friend = {
  id?: string;
  pubkey: string;
  name: string;
  groups?: string[];
  group?: string;
  note?: string;
  updatedAt?: number;
};

function normalized(friend: Friend): Friend {
  return { ...friend, pubkey: friend.pubkey.toLowerCase(), groups: friend.groups ?? (friend.group ? [friend.group] : []) };
}

export const useFriendsStore = defineStore("friends", {
  state: () => ({ list: [] as Friend[], loadedFor: "", syncing: false, lastSyncTimestamp: 0, syncError: "", version: 0 }),
  getters: {
    sortedList(): Friend[] {
      const friendships = useFriendshipsStore();
      const metadata = new Map(this.list.map(friend => [friend.pubkey, friend]));
      return friendships.records
        .filter(record => record.state === "accepted")
        .map(record => metadata.get(record.peerPubkey) || { pubkey: record.peerPubkey, name: `${record.peerPubkey.slice(0, 8)}…` })
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-CN"));
    },
    getAcceptedList(): (isAccepted: (peerPubkey: string) => boolean) => Friend[] {
      return isAccepted => this.sortedList.filter(friend => isAccepted(friend.pubkey));
    },
  },
  actions: {
    async load(accountPubkey?: string) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account) return this.reset(false);
      if (this.loadedFor === account) return;
      this.reset(false);
      this.loadedFor = account;
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      const records = await friendRepository.list(account);
      if (this.loadedFor === account) this.list = records.filter(record => !record.deleted).map(record => normalized({ ...record, name: record.name || `${record.pubkey.slice(0, 8)}…` }));
    },
    reset(_removeFromStorage = false) {
      this.list = [];
      this.loadedFor = "";
      this.syncing = false;
      this.lastSyncTimestamp = 0;
      this.syncError = "";
      this.version++;
    },
    save() {
      const account = this.loadedFor;
      if (!account) return;
      if (typeof indexedDB !== "undefined") for (const friend of this.list) void friendRepository.put(account, friend);
      scheduleAccountStateSync(useKeyStore(), "friend_metadata");
    },
    add(friend: Friend) {
      if (!friend.pubkey || !friend.name?.trim() || this.list.some(item => item.pubkey === friend.pubkey.toLowerCase())) return false;
      this.list.push(normalized({ ...friend, updatedAt: Date.now() }));
      this.version++;
      this.save();
      return true;
    },
    remove(pubkey: string) {
      const peer = pubkey.toLowerCase();
      const existing = this.list.find(friend => friend.pubkey === peer);
      if (!existing) return false;
      this.list = this.list.filter(friend => friend.pubkey !== peer);
      this.version++;
      if (typeof indexedDB !== "undefined") void friendRepository.put(this.loadedFor, { ...existing, pubkey: peer, deleted: true, updatedAt: Date.now() });
      scheduleAccountStateSync(useKeyStore(), "friend_metadata");
      return true;
    },
    update(pubkey: string, patch: Partial<Friend>) {
      const friend = this.list.find(item => item.pubkey === pubkey.toLowerCase());
      if (!friend || (patch.name !== undefined && !patch.name.trim())) return false;
      Object.assign(friend, patch, { updatedAt: Date.now() });
      this.version++;
      this.save();
      return true;
    },
    async publishToRelays() { return false; },
    async fetchFromRelays() { return false; },
  },
});
