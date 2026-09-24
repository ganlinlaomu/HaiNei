import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { decodeFriendshipControl, friendshipTags, type FriendshipAction, type FriendshipControl } from "@/nostr/messaging/friendshipControl";
import { getRelaysFromStorage } from "@/nostr/relays";
import { friendshipRepository } from "@/repositories/friendshipRepository";
import type { FriendshipAcceptedWindow, FriendshipRecord, FriendshipState } from "@/db/dexie";
import { useKeyStore } from "@/stores/keys";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

function normalized(pubkey: string) { return pubkey.trim().toLowerCase(); }

export type FriendshipControlEvent = FriendshipControl & { eventId: string; selfMessage: boolean };

function controlIsNewer(current: FriendshipRecord | undefined, event: FriendshipControlEvent) {
  if (current?.lastControlAt === undefined) return true;
  if (event.timestamp !== current.lastControlAt) return event.timestamp > current.lastControlAt;
  return event.eventId.localeCompare(current.lastControlEventId || "") > 0;
}

function matchingRequest(current: FriendshipRecord | undefined, event: FriendshipControlEvent) {
  return !event.requestId || (!!current?.requestEventId && event.requestId === current.requestEventId);
}

function closeOpenWindow(windows: FriendshipAcceptedWindow[], event: FriendshipControlEvent) {
  return windows.map((window, index) => index === windows.length - 1 && window.endedAt === undefined
    ? { ...window, endedAt: event.timestamp, endedEventId: event.eventId }
    : window);
}

/** The only state transition for both locally sent and replayed friendship controls. */
export function reduceFriendshipControl(
  current: FriendshipRecord | undefined,
  base: Pick<FriendshipRecord, "accountPubkey" | "peerPubkey">,
  event: FriendshipControlEvent,
): FriendshipRecord | undefined {
  if (current?.state === "blocked" || !controlIsNewer(current, event)) return current;
  let state: FriendshipState | undefined;

  if (event.action === "request") {
    if (current?.state === "accepted") return current;
    state = event.selfMessage ? "outgoing_pending" : "incoming_pending";
  } else if (event.action === "accept") {
    const expected = event.selfMessage ? "incoming_pending" : "outgoing_pending";
    if (current?.state !== expected || !matchingRequest(current, event)) return current;
    state = "accepted";
  } else if (event.action === "reject") {
    const expected = event.selfMessage ? "incoming_pending" : "outgoing_pending";
    if (current?.state !== expected || !matchingRequest(current, event)) return current;
    state = "rejected";
  } else if (event.action === "cancel") {
    const expected = event.selfMessage ? "outgoing_pending" : "incoming_pending";
    if (current?.state !== expected || !matchingRequest(current, event)) return current;
    state = "cancelled";
  } else if (event.action === "remove") {
    if (current?.state !== "accepted") return current;
    state = "removed";
  }
  if (!state) return current;

  let acceptedWindows = [...(current?.acceptedWindows || [])];
  if (!acceptedWindows.length && current?.state === "accepted" && current.acceptedAt && current.acceptedEventId) {
    acceptedWindows = [{ acceptedAt: current.acceptedAt, acceptedEventId: current.acceptedEventId }];
  }
  if (event.action === "accept" && !acceptedWindows.some(window => window.endedAt === undefined)) {
    acceptedWindows.push({ acceptedAt: event.timestamp, acceptedEventId: event.eventId });
  } else if (event.action === "remove") {
    acceptedWindows = closeOpenWindow(acceptedWindows, event);
  }
  return {
    ...current,
    ...base,
    state,
    ...(event.action === "request" ? { requestEventId: event.eventId, requestedAt: event.timestamp } : {}),
    ...(event.action === "accept" ? { acceptedEventId: event.eventId, acceptedAt: event.timestamp } : {}),
    acceptedWindows,
    lastAction: event.action,
    lastControlAt: event.timestamp,
    lastControlEventId: event.eventId,
    updatedAt: Date.now(),
  };
}

export const useFriendshipsStore = defineStore("friendships", {
  state: () => ({ records: [] as FriendshipRecord[], loadedFor: "", loading: false }),
  getters: {
    getRecord: state => (peerPubkey: string) => state.records.find(item => item.peerPubkey === normalized(peerPubkey)),
    getState(): (peerPubkey: string) => FriendshipState | undefined {
      return peerPubkey => this.getRecord(peerPubkey)?.state;
    },
    isAccepted(): (peerPubkey: string) => boolean {
      return peerPubkey => this.getState(peerPubkey) === "accepted";
    },
    getIncomingRequests: state => () => state.records.filter(item => item.state === "incoming_pending"),
    getOutgoingRequests: state => () => state.records.filter(item => item.state === "outgoing_pending"),
  },
  actions: {
    async load(accountPubkey?: string) {
      const account = normalized(accountPubkey || useKeyStore().pkHex);
      if (!account) return this.reset();
      if (this.loadedFor === account && !this.loading) return;
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
    async applyControl(peerPubkey: string, event: FriendshipControlEvent) {
      const accountPubkey = this.loadedFor;
      const peer = normalized(peerPubkey);
      if (!accountPubkey || !peer || peer === accountPubkey) return { changed: false, record: undefined };
      const current = this.getRecord(peer);
      const record = reduceFriendshipControl(current, { accountPubkey, peerPubkey: peer }, event);
      if (!record || record === current) return { changed: false, record: current };
      await friendshipRepository.put(record);
      if (this.loadedFor !== accountPubkey) return { changed: false, record: undefined };
      const index = this.records.findIndex(item => item.peerPubkey === peer);
      if (index >= 0) this.records[index] = record;
      else this.records.push(record);
      scheduleAccountStateSync(useKeyStore(), "friendships");
      return { changed: true, record };
    },
    async sendControl(peerPubkey: string, action: FriendshipAction, requestId?: string) {
      const keys = useKeyStore();
      const account = keys.pkHex;
      const peer = normalized(peerPubkey);
      if (!keys.isLoggedIn || !keys.supportsNip44 || !account || !peer || peer === account) throw new Error("无法发送好友关系消息");
      if (this.loadedFor !== account) await this.load(account);
      const previousControlAt = this.getRecord(peer)?.lastControlAt || 0;
      const timestamp = Math.max(Math.floor(Date.now() / 1000), previousControlAt + 1);
      const result = await sendDirectMessage({
        recipientPubkeys: [peer],
        content: JSON.stringify({ type: `friend_${action}`, from: account, timestamp, ...(requestId ? { requestId } : {}) }),
        tags: friendshipTags(action),
        relays: getRelaysFromStorage("write"),
        context: { senderPubkey: account, nip44Encrypt: keys.nip44Encrypt.bind(keys), signEvent: keys.signEvent.bind(keys) },
      });
      if (keys.pkHex !== account || this.loadedFor !== account) throw new Error("账号已切换");
      const applied = await this.applyControl(peer, { action, timestamp, eventId: result.message.id, requestId, selfMessage: true });
      return { result, applied };
    },
    async sendRequest(peerPubkey: string) {
      return (await this.sendControl(peerPubkey, "request")).result;
    },
    async acceptRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      const current = this.getRecord(peer);
      if (current?.state !== "incoming_pending") throw new Error("好友请求已失效");
      const { result, applied } = await this.sendControl(peer, "accept", current.requestEventId);
      if (!applied.changed) throw new Error("好友请求已失效");
      const friends = (await import("@/stores/friends")).useFriendsStore();
      if (friends.loadedFor !== this.loadedFor) {
        if (typeof indexedDB !== "undefined") await friends.load(this.loadedFor);
        else friends.loadedFor = this.loadedFor;
      }
      if (!friends.list.some(item => item.pubkey === peer)) {
        friends.list.push({ pubkey: peer, name: `${peer.slice(0, 8)}…` });
      }
      const profiles = useProfilesStore();
      void Promise.allSettled([profiles.sendCurrentProfileTo(peer), profiles.requestCurrentProfile(peer)]);
      return result;
    },
    async rejectRequest(peerPubkey: string) {
      const current = this.getRecord(peerPubkey);
      if (current?.state !== "incoming_pending") return;
      await this.sendControl(peerPubkey, "reject", current.requestEventId);
    },
    async cancelRequest(peerPubkey: string) {
      const current = this.getRecord(peerPubkey);
      if (current?.state !== "outgoing_pending") return;
      await this.sendControl(peerPubkey, "cancel", current.requestEventId);
    },
    async removeFriend(peerPubkey: string) {
      if (this.getState(peerPubkey) !== "accepted") return;
      await this.sendControl(peerPubkey, "remove");
    },
    async processFriendshipMessage(message: CanonicalMessage) {
      const control = decodeFriendshipControl(message);
      const account = this.loadedFor;
      if (!control || !account) return false;
      const selfMessage = message.senderPubkey === account;
      const peer = normalized(selfMessage ? message.recipientPubkeys.find(pubkey => pubkey !== account) || "" : message.senderPubkey);
      if (!peer || peer === account) return false;
      const wasAccepted = this.isAccepted(peer);
      const applied = await this.applyControl(peer, { ...control, eventId: message.id, selfMessage });
      if (applied.changed && control.action === "accept" && !wasAccepted) {
        const profiles = useProfilesStore();
        void Promise.allSettled([profiles.sendCurrentProfileTo(peer), profiles.requestCurrentProfile(peer)]);
      }
      if (applied.changed && control.action === "cancel" && !selfMessage) useNotificationsStore().resolveFriendRequests(peer);
      return applied.changed;
    },
  },
});
