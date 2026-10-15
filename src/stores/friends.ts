import { defineStore } from "pinia";
import { friendRepository } from "@/repositories/friendRepository";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { scheduleAccountStateSync } from "@/services/accountStateSync";
import { pushEnabledForAccount, syncPushAuthorizationPolicy } from "@/services/pushNotifications";
import type { DBFriend } from "@/db/dexie";

export type Friend = {
  id?: string;
  pubkey: string;
  name: string;
  groups?: string[];
  group?: string;
  note?: string;
  dmPinnedAt?: number;
  dmMuted?: boolean;
  updatedAt?: number;
};

export type ConversationPreferenceState = { pinned: boolean; muted: boolean; pinnedAt: number };

function placeholderName(pubkey: string) {
  return `${pubkey.slice(0, 8)}…`;
}

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
    /** Pin / mute of the 1:1 conversation with this friend. */
    conversationPreference: state => (pubkey: string): ConversationPreferenceState => {
      const friend = state.list.find(item => item.pubkey === pubkey.toLowerCase());
      const pinnedAt = Number(friend?.dmPinnedAt || 0);
      return { pinned: pinnedAt > 0, muted: friend?.dmMuted === true, pinnedAt };
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
    async reloadFromStorage(accountPubkey?: string) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account || this.loadedFor !== account) return false;
      const records = await friendRepository.list(account);
      if (this.loadedFor !== account) return false;
      this.list = records
        .filter(record => !record.deleted)
        .map(record => normalized({ ...record, name: record.name || `${record.pubkey.slice(0, 8)}…` }));
      this.version++;
      return true;
    },
    reset(_removeFromStorage = false) {
      this.list = [];
      this.loadedFor = "";
      this.syncing = false;
      this.lastSyncTimestamp = 0;
      this.syncError = "";
      this.version++;
    },
    async persist(records: DBFriend[]) {
      const account = this.loadedFor;
      if (!account) return;
      const keys = useKeyStore();
      if (typeof indexedDB !== "undefined") {
        await Promise.all(records.map(friend => friendRepository.put(account, friend)));
      }
      if (this.loadedFor !== account || keys.pkHex.toLowerCase() !== account) return;
      scheduleAccountStateSync(keys, "friend_metadata");
    },
    save() {
      return this.persist(this.list);
    },
    async ensureMetadata(friend: Friend) {
      const peer = friend.pubkey.toLowerCase();
      if (!peer || !friend.name?.trim()) return false;
      if (this.list.some(item => item.pubkey === peer)) return true;
      const next = normalized({ ...friend, pubkey: peer, updatedAt: Date.now() });
      this.list.push(next);
      this.version++;
      await this.persist([next as DBFriend]);
      return true;
    },
    async upsertMetadata(pubkey: string, patch: Partial<Friend>) {
      const peer = pubkey.toLowerCase();
      const name = patch.name?.trim();
      if (!peer || !name) return false;
      const existing = this.list.find(item => item.pubkey === peer);
      if (existing) {
        Object.assign(existing, patch, { name, updatedAt: Date.now() });
        this.version++;
        await this.persist([existing as DBFriend]);
        return true;
      }
      const next = normalized({
        pubkey: peer,
        name,
        groups: patch.groups,
        group: patch.group,
        note: patch.note,
        updatedAt: Date.now()
      });
      this.list.push(next);
      this.version++;
      await this.persist([next as DBFriend]);
      return true;
    },
    add(friend: Friend) {
      if (!friend.pubkey || !friend.name?.trim() || this.list.some(item => item.pubkey === friend.pubkey.toLowerCase())) return false;
      this.list.push(normalized({ ...friend, updatedAt: Date.now() }));
      this.version++;
      void this.save();
      return true;
    },
    async remove(pubkey: string) {
      const peer = pubkey.toLowerCase();
      const existing = this.list.find(friend => friend.pubkey === peer);
      if (!existing) return false;
      const tombstone = { ...existing, pubkey: peer, deleted: true, updatedAt: Date.now() };
      await this.persist([tombstone]);
      if (this.loadedFor && this.list.some(friend => friend.pubkey === peer)) {
        this.list = this.list.filter(friend => friend.pubkey !== peer);
        this.version++;
      }
      return true;
    },
    update(pubkey: string, patch: Partial<Friend>) {
      const friend = this.list.find(item => item.pubkey === pubkey.toLowerCase());
      if (!friend || (patch.name !== undefined && !patch.name.trim())) return false;
      Object.assign(friend, patch, { updatedAt: Date.now() });
      this.version++;
      void this.save();
      return true;
    },
    async setConversationPreference(pubkey: string, patch: { pinned?: boolean; muted?: boolean }) {
      const account = this.loadedFor;
      const peer = pubkey.toLowerCase();
      if (!account || !peer) return false;
      let friend = this.list.find(item => item.pubkey === peer);
      if (!friend) {
        friend = normalized({ pubkey: peer, name: placeholderName(peer) });
        this.list.push(friend);
      }
      const wasMuted = friend.dmMuted === true;
      if (patch.pinned !== undefined) friend.dmPinnedAt = patch.pinned ? Date.now() : 0;
      if (patch.muted !== undefined) friend.dmMuted = patch.muted;
      friend.updatedAt = Date.now();
      this.version++;
      // Never sync a generated placeholder as if it were the user's remark.
      const record: DBFriend = { ...friend, name: friend.name === placeholderName(peer) ? undefined : friend.name };
      await this.persist([record]);
      const keys = useKeyStore();
      if (patch.muted !== undefined && patch.muted !== wasMuted && this.loadedFor === account
        && keys.pkHex.toLowerCase() === account && pushEnabledForAccount(account)) {
        // The Worker policy is account-wide; muted friends are filtered out in
        // syncPushAuthorizationPolicy on every device from the synced records.
        const accepted = useFriendshipsStore().records.filter(item => item.state === "accepted").map(item => item.peerPubkey);
        void syncPushAuthorizationPolicy(account, accepted, keys.signEvent.bind(keys))
          .catch(error => console.warn("[push] mute policy sync failed", error instanceof Error ? error.message : "unknown"));
      }
      return true;
    },
    async publishToRelays() { return false; },
    async fetchFromRelays() { return false; },
  },
});
