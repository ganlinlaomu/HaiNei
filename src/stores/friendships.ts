import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import {
  decodeFriendshipControl,
  friendshipTags,
  type FriendshipAction
} from "@/nostr/messaging/friendshipControl";
import { getRelaysFromStorage } from "@/nostr/relays";
import { friendshipRepository } from "@/repositories/friendshipRepository";
import type { FriendshipRecord, FriendshipState } from "@/db/dexie";
import { useKeyStore } from "@/stores/keys";
import { useFriendsStore } from "@/stores/friends";
import { useNotificationsStore } from "@/stores/notifications";

function normalized(pubkey: string) { return pubkey.trim().toLowerCase(); }

export const useFriendshipsStore = defineStore("friendships", {
  state: () => ({
    records: [] as FriendshipRecord[],
    loadedFor: "",
    loading: false
  }),

  getters: {
    getState: state => (peerPubkey: string): FriendshipState | undefined =>
      state.records.find(item => item.peerPubkey === normalized(peerPubkey))?.state,
    isAccepted(): (peerPubkey: string) => boolean {
      return peerPubkey => this.getState(peerPubkey) === "accepted";
    },
    getIncomingRequests: state => () => state.records.filter(item => item.state === "incoming_pending"),
    getOutgoingRequests: state => () => state.records.filter(item => item.state === "outgoing_pending")
  },

  actions: {
    async load(accountPubkey?: string) {
      const account = normalized(accountPubkey || useKeyStore().pkHex);
      if (!account) return this.reset();
      if (this.loadedFor === account) return;
      this.records = [];
      this.loadedFor = account;
      this.loading = true;
      try {
        const records = await friendshipRepository.list(account);
        if (this.loadedFor === account) this.records = records;
      } finally {
        if (this.loadedFor === account) this.loading = false;
      }
    },

    reset() {
      this.records = [];
      this.loadedFor = "";
      this.loading = false;
    },

    async setRecord(peerPubkey: string, state: FriendshipState, patch: Partial<FriendshipRecord> = {}) {
      const accountPubkey = this.loadedFor;
      const peer = normalized(peerPubkey);
      if (!accountPubkey || !peer || peer === accountPubkey) return null;
      const current = this.records.find(item => item.peerPubkey === peer);
      const record: FriendshipRecord = {
        ...current,
        ...patch,
        accountPubkey,
        peerPubkey: peer,
        state,
        updatedAt: Date.now()
      };
      await friendshipRepository.put(record);
      if (this.loadedFor !== accountPubkey) return null;
      const index = this.records.findIndex(item => item.peerPubkey === peer);
      if (index >= 0) this.records[index] = record;
      else this.records.push(record);
      return record;
    },

    async deleteRecord(peerPubkey: string) {
      const account = this.loadedFor;
      const peer = normalized(peerPubkey);
      if (!account || !peer) return;
      await friendshipRepository.delete(account, peer);
      if (this.loadedFor === account) this.records = this.records.filter(item => item.peerPubkey !== peer);
    },

    async sendControl(peerPubkey: string, action: FriendshipAction) {
      const keys = useKeyStore();
      const account = keys.pkHex;
      const peer = normalized(peerPubkey);
      if (!keys.isLoggedIn || !keys.supportsNip44 || !account || !peer || peer === account) {
        throw new Error("无法发送好友关系消息");
      }
      if (this.loadedFor !== account) await this.load(account);
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await sendDirectMessage({
        recipientPubkeys: [peer],
        content: JSON.stringify({ type: `friend_${action}`, from: account, timestamp }),
        tags: friendshipTags(action),
        relays: getRelaysFromStorage("write"),
        context: {
          senderPubkey: account,
          nip44Encrypt: keys.nip44Encrypt.bind(keys),
          signEvent: keys.signEvent.bind(keys)
        }
      });
      if (keys.pkHex !== account || this.loadedFor !== account) throw new Error("账号已切换");
      return { result, timestamp };
    },

    async sendRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      const { result, timestamp } = await this.sendControl(peer, "request");
      await this.setRecord(peer, "outgoing_pending", {
        requestEventId: result.message.id,
        requestedAt: timestamp
      });
      return result;
    },

    async acceptRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      if (this.getState(peer) !== "incoming_pending") throw new Error("好友请求已失效");
      const { result, timestamp } = await this.sendControl(peer, "accept");
      await this.setRecord(peer, "accepted", { acceptedEventId: result.message.id, acceptedAt: timestamp });
      const friends = useFriendsStore();
      if (friends.loadedFor !== this.loadedFor) await friends.load(this.loadedFor);
      if (!friends.list.some(item => item.pubkey === peer)) {
        friends.add({ pubkey: peer, name: `${peer.slice(0, 8)}…` });
      }
      return result;
    },

    async rejectRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      if (this.getState(peer) !== "incoming_pending") return;
      await this.sendControl(peer, "reject");
      await this.deleteRecord(peer);
    },

    async cancelRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      if (this.getState(peer) !== "outgoing_pending") return;
      await this.sendControl(peer, "cancel");
      // An accept may win the race while the cancel is publishing. Never
      // remove a relationship that has already reached accepted.
      if (this.getState(peer) === "outgoing_pending") await this.deleteRecord(peer);
    },

    async removeFriend(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      if (this.getState(peer) !== "accepted") return;
      await this.sendControl(peer, "remove");
      await this.deleteRecord(peer);
    },

    async processFriendshipMessage(message: CanonicalMessage) {
      const control = decodeFriendshipControl(message);
      const account = this.loadedFor;
      if (!control || !account) return false;
      const selfMessage = message.senderPubkey === account;
      const peer = selfMessage
        ? message.recipientPubkeys.find(pubkey => pubkey !== account)
        : message.senderPubkey;
      if (!peer || peer === account) return false;

      if (control.action === "request") {
        if (selfMessage) {
          if (this.getState(peer) !== "accepted") await this.setRecord(peer, "outgoing_pending", {
            requestEventId: message.id, requestedAt: control.timestamp
          });
        } else if (this.getState(peer) !== "accepted") {
          await this.setRecord(peer, "incoming_pending", {
            requestEventId: message.id, requestedAt: control.timestamp
          });
        }
      } else if (control.action === "accept") {
        if (selfMessage || this.getState(peer) === "outgoing_pending") {
          await this.setRecord(peer, "accepted", { acceptedEventId: message.id, acceptedAt: control.timestamp });
        }
      } else if (control.action === "cancel") {
        const cancellableState = selfMessage ? "outgoing_pending" : "incoming_pending";
        if (this.getState(peer) === cancellableState) {
          await this.deleteRecord(peer);
          if (!selfMessage) useNotificationsStore().resolveFriendRequests(peer);
        }
      } else {
        await this.deleteRecord(peer);
      }
      return true;
    }
  }
});
