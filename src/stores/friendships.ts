import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage, queueDirectMessage, publishQueuedOutgoing, onOutgoingQueueState } from "@/nostr/messaging/service";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import type { OutgoingQueueState } from "@/db/dexie";
import { startupMark } from "@/utils/debugLog";
import { decodeFriendshipControl, friendshipTags, type FriendshipAction, type FriendshipControl } from "@/nostr/messaging/friendshipControl";
import { DEFAULT_RELAYS, getRelaysFromStorage } from "@/nostr/relays";
import { friendshipRepository } from "@/repositories/friendshipRepository";
import type { FriendshipAcceptedWindow, FriendshipRecord, FriendshipState } from "@/db/dexie";
import { useKeyStore } from "@/stores/keys";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";
import { scheduleAccountStateSync } from "@/services/accountStateSync";
import { notifyDirectMessageAuthorizationChanged } from "@/services/directMessageStateEvents";
import { notifyMessageAuthorizationChanged } from "@/services/messageAuthorizationEvents";
import { pushEnabledForAccount, syncPushAuthorizationPolicy } from "@/services/pushNotifications";

function normalized(pubkey: string) { return pubkey.trim().toLowerCase(); }

/**
 * Control timestamps come from the sender's clock and an accept must order
 * after its request, so a fast clock on either device moves the window start
 * ahead of the other device's message timestamps. Tolerate bounded skew at the
 * start of a window only; its end (removal) stays strict.
 */
export const FRIENDSHIP_CLOCK_SKEW_SECONDS = 15 * 60;

export function isFriendshipAcceptedAt(friendship: FriendshipRecord | undefined, createdAt: number) {
  if (!friendship) return false;
  const windows = friendship.acceptedWindows || [];
  if (!windows.length) {
    if (!friendship.acceptedAt) return friendship.state === "accepted";
    const endedAt = friendship.state === "accepted" ? undefined : friendship.lastControlAt;
    return createdAt >= friendship.acceptedAt - FRIENDSHIP_CLOCK_SKEW_SECONDS
      && (endedAt === undefined || createdAt <= endedAt);
  }
  return windows.some(window => createdAt >= window.acceptedAt - FRIENDSHIP_CLOCK_SKEW_SECONDS
    && (window.endedAt === undefined || createdAt <= window.endedAt));
}

const activeFriendshipControls = new Map<string, { action: FriendshipAction; promise: Promise<any> }>();

let requestDeliveryObserverInstalled = false;
function ensureRequestDeliveryObserver() {
  if (requestDeliveryObserverInstalled) return;
  requestDeliveryObserverInstalled = true;
  onOutgoingQueueState(event => {
    const store = useFriendshipsStore();
    if (store.loadedFor !== event.accountPubkey || useKeyStore().pkHex !== event.accountPubkey) return;
    if (store.loading || store.records.some(record => record.requestEventId === event.outgoingId)) {
      store.requestDeliveries[event.outgoingId] = event.state;
    }
  });
}

async function readRequestDeliveries(account: string, records: FriendshipRecord[]) {
  const pending = records.filter(record => record.state === "outgoing_pending" && record.requestEventId);
  return Promise.all(pending.map(async record => {
    const queued = await outgoingQueueRepository.get(account, record.requestEventId!);
    return { outgoingId: record.requestEventId!, state: queued?.state ?? ("sent" as OutgoingQueueState) };
  }));
}

function friendshipControlRelays() {
  return [...new Set([...getRelaysFromStorage("write"), ...DEFAULT_RELAYS])];
}

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
  state: () => ({ records: [] as FriendshipRecord[], loadedFor: "", loading: false, authorizationReady: false, requestDeliveries: {} as Record<string, OutgoingQueueState> }),
  getters: {
    getRecord: state => (peerPubkey: string) => state.records.find(item => item.peerPubkey === normalized(peerPubkey)),
    getState(): (peerPubkey: string) => FriendshipState | undefined {
      return peerPubkey => this.getRecord(peerPubkey)?.state;
    },
    isAccepted(): (peerPubkey: string) => boolean {
      return peerPubkey => this.getState(peerPubkey) === "accepted";
    },
    requestDelivery(): (peerPubkey: string) => OutgoingQueueState {
      return peerPubkey => {
        const id = this.getRecord(peerPubkey)?.requestEventId;
        // Legacy requests may predate the durable outgoing queue.
        return id ? this.requestDeliveries[id] || "pending" : "sent";
      };
    },
    getIncomingRequests: state => () => state.records.filter(item => item.state === "incoming_pending"),
    getOutgoingRequests: state => () => state.records.filter(item => item.state === "outgoing_pending"),
  },
  actions: {
    async load(accountPubkey?: string) {
      const account = normalized(accountPubkey || useKeyStore().pkHex);
      if (!account) return this.reset();
      if (this.loadedFor === account && !this.loading && this.authorizationReady) return;
      this.records = [];
      this.requestDeliveries = {};
      this.loadedFor = account;
      ensureRequestDeliveryObserver();
      this.loading = true;
      this.authorizationReady = false;
      try {
        const records = await friendshipRepository.list(account);
        const outgoing = await readRequestDeliveries(account, records);
        if (this.loadedFor === account) {
          this.records = records;
          // Install the observer before reading disk; never overwrite a newer
          // in-flight delivery event with the snapshot that was just loaded.
          for (const item of outgoing) {
            if (!this.requestDeliveries[item.outgoingId]) this.requestDeliveries[item.outgoingId] = item.state;
          }
          this.authorizationReady = true;
          notifyDirectMessageAuthorizationChanged(account);
          notifyMessageAuthorizationChanged(account);
        }
      } finally {
        if (this.loadedFor === account) this.loading = false;
      }
    },
    async reloadFromStorage(accountPubkey?: string) {
      const account = normalized(accountPubkey || useKeyStore().pkHex);
      if (!account || this.loadedFor !== account) return false;
      ensureRequestDeliveryObserver();
      const deliveryBeforeRead = { ...this.requestDeliveries };
      const records = await friendshipRepository.list(account);
      const outgoing = await readRequestDeliveries(account, records);
      if (this.loadedFor !== account) return false;
      this.records = records;
      for (const item of outgoing) {
        if (this.requestDeliveries[item.outgoingId] === deliveryBeforeRead[item.outgoingId]) this.requestDeliveries[item.outgoingId] = item.state;
      }
      this.authorizationReady = true;
      notifyDirectMessageAuthorizationChanged(account);
      notifyMessageAuthorizationChanged(account);
      return true;
    },
    reset() {
      this.records = [];
      this.loadedFor = "";
      this.loading = false;
      this.authorizationReady = false;
      this.requestDeliveries = {};
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
      notifyDirectMessageAuthorizationChanged(accountPubkey);
      notifyMessageAuthorizationChanged(accountPubkey);
      scheduleAccountStateSync(useKeyStore(), "friendships");
      const keys = useKeyStore();
      if (pushEnabledForAccount(accountPubkey) && keys.pkHex === accountPubkey) {
        const acceptedSenders = this.records
          .filter(item => item.state === "accepted")
          .map(item => item.peerPubkey);
        void syncPushAuthorizationPolicy(accountPubkey, acceptedSenders, keys.signEvent.bind(keys))
          .catch(error => console.warn("[push] friendship policy sync failed", error instanceof Error ? error.message : "unknown"));
      }
      return { changed: true, record };
    },
    async sendControl(peerPubkey: string, action: FriendshipAction, requestId?: string) {
      const keys = useKeyStore();
      const account = keys.pkHex;
      const peer = normalized(peerPubkey);
      if (!keys.isLoggedIn || !account) throw new Error("请先登录");
      if (peer === account) throw new Error("不能添加自己为好友");
      if (!keys.supportsNip44) throw new Error("当前登录方式暂不支持加密好友请求");
      if (!peer) throw new Error("无法发送好友关系消息");
      const flightKey = `${account}:${peer}`;
      const existingFlight = activeFriendshipControls.get(flightKey);
      if (existingFlight) {
        if (existingFlight.action === action) return existingFlight.promise;
        throw new Error("好友关系操作处理中");
      }
      const promise = (async () => {
        if (this.loadedFor !== account) await this.load(account);
        if (keys.pkHex !== account || this.loadedFor !== account) throw new Error("账号已切换");
        if (action === "request") {
          const state = this.getState(peer);
          if (state === "accepted") throw new Error("你们已经是好友");
          if (state === "outgoing_pending") throw new Error("好友请求已保存，请在已发送列表查看进度");
          if (state === "incoming_pending") throw new Error("对方正在等待你的确认");
        }
        const previousControlAt = this.getRecord(peer)?.lastControlAt || 0;
        const timestamp = Math.max(Math.floor(Date.now() / 1000), previousControlAt + 1);
        const startedAt = Date.now();
        const send = action === "request" ? queueDirectMessage : sendDirectMessage;
        const result = await send({
          recipientPubkeys: [peer],
          content: JSON.stringify({ type: `friend_${action}`, from: account, timestamp, ...(requestId ? { requestId } : {}) }),
          tags: friendshipTags(action),
          relays: friendshipControlRelays(),
          context: { senderPubkey: account, nip44Encrypt: keys.nip44Encrypt.bind(keys), signEvent: keys.signEvent.bind(keys) },
        });
        if (keys.pkHex !== account || this.loadedFor !== account) throw new Error("账号已切换");
        const applied = await this.applyControl(peer, { action, timestamp, eventId: result.message.id, requestId, selfMessage: true });
        if (keys.pkHex !== account || this.loadedFor !== account) throw new Error("账号已切换");
        if (action === "request") {
          ensureRequestDeliveryObserver();
          this.requestDeliveries[result.message.id] = "pending";
          startupMark("friend_request_queued", { durationMs: Date.now() - startedAt });
          // The signed request is durable and the local relationship is saved.
          // Relay discovery and publication must not hold the editor open.
          void this.publishRequest(account, result.message.id).then(() => {
            startupMark("friend_request_published", { durationMs: Date.now() - startedAt });
          }).catch(error => {
            startupMark("friend_request_publish_failed", {
              durationMs: Date.now() - startedAt,
              reason: error instanceof Error ? error.message : "publish_failed",
            });
          });
        }
        return { result, applied };
      })().finally(() => {
        if (activeFriendshipControls.get(flightKey)?.promise === promise) activeFriendshipControls.delete(flightKey);
      });
      activeFriendshipControls.set(flightKey, { action, promise });
      return promise;
    },
    async sendRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      const state = this.getState(peer);
      if (state === "accepted") throw new Error("你们已经是好友");
      if (state === "outgoing_pending") throw new Error("好友请求已保存，请在已发送列表查看进度");
      if (state === "incoming_pending") throw new Error("对方正在等待你的确认");
      return (await this.sendControl(peer, "request")).result;
    },
    async publishRequest(account: string, outgoingId: string) {
      if (this.loadedFor !== account || useKeyStore().pkHex !== account) throw new Error("账号已切换");
      try {
        await publishQueuedOutgoing(account, outgoingId);
        // An automatic retry may have finished before the local relationship
        // was installed, so its queue event could have preceded our observer.
        if (this.loadedFor === account && useKeyStore().pkHex === account) this.requestDeliveries[outgoingId] = "sent";
      } catch (error) {
        if (this.loadedFor !== account || useKeyStore().pkHex !== account) throw error;
        // Route discovery/storage can fail before the publisher enters its
        // normal retry state. Keep these failures visible and retryable too.
        try {
          const queued = await outgoingQueueRepository.get(account, outgoingId);
          if (queued && (queued.state === "pending" || queued.state === "sending")) {
            await outgoingQueueRepository.update(account, outgoingId, {
              state: "failed", lastError: error instanceof Error ? error.message : "publish_failed", updatedAt: Date.now(),
            });
            if (this.loadedFor === account && useKeyStore().pkHex === account) this.requestDeliveries[outgoingId] = "failed";
          }
        } catch { /* Preserve the original publication error. */ }
        throw error;
      }
    },
    async retryRequest(peerPubkey: string) {
      const account = this.loadedFor;
      const keys = useKeyStore();
      const record = this.getRecord(peerPubkey);
      if (!account || keys.pkHex !== account || !keys.isLoggedIn) throw new Error("请先登录");
      if (record?.state !== "outgoing_pending" || !record.requestEventId) throw new Error("好友请求已失效");
      const queued = await outgoingQueueRepository.get(account, record.requestEventId);
      if (this.loadedFor !== account || keys.pkHex !== account) throw new Error("账号已切换");
      if (!queued) throw new Error("找不到待发送的好友请求");
      if (queued.state === "sent") {
        this.requestDeliveries[record.requestEventId] = "sent";
        return;
      }
      // Reuse the signed event and its queue entry, never generate a new request.
      ensureRequestDeliveryObserver();
      await this.publishRequest(account, record.requestEventId);
    },
    async acceptRequest(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      const current = this.getRecord(peer);
      if (current?.state !== "incoming_pending") throw new Error("好友请求已失效");
      const { result, applied } = await this.sendControl(peer, "accept", current.requestEventId);
      const accepted = applied.record || this.getRecord(peer);
      const echoedOwnAccept = accepted?.state === "accepted" && accepted.acceptedEventId === result.message.id;
      if (!applied.changed && !echoedOwnAccept) throw new Error("好友请求已失效");
      const friends = (await import("@/stores/friends")).useFriendsStore();
      if (friends.loadedFor !== this.loadedFor) {
        if (typeof indexedDB !== "undefined") await friends.load(this.loadedFor);
        else friends.loadedFor = this.loadedFor;
      }
      if (!friends.list.some(item => item.pubkey === peer)) {
        await friends.ensureMetadata({ pubkey: peer, name: `${peer.slice(0, 8)}…` });
      }
      const profiles = useProfilesStore();
      void Promise.allSettled([profiles.sendCurrentProfileTo(peer), profiles.requestCurrentProfile(peer)]);
      return result;
    },
    async rejectRequest(peerPubkey: string) {
      const current = this.getRecord(peerPubkey);
      if (current?.state !== "incoming_pending") throw new Error("好友请求已失效");
      await this.sendControl(peerPubkey, "reject", current.requestEventId);
    },
    async cancelRequest(peerPubkey: string) {
      const current = this.getRecord(peerPubkey);
      if (current?.state !== "outgoing_pending") throw new Error("好友请求已失效");
      const account = this.loadedFor;
      const queued = current.requestEventId ? await outgoingQueueRepository.get(account, current.requestEventId) : undefined;
      if (this.loadedFor !== account || useKeyStore().pkHex !== account) throw new Error("账号已切换");
      if (this.getRecord(peerPubkey)?.requestEventId !== current.requestEventId || this.getState(peerPubkey) !== "outgoing_pending") throw new Error("好友请求已失效");
      if (queued && queued.state !== "sent") throw new Error("请等待好友请求发送成功后再撤回");
      await this.sendControl(peerPubkey, "cancel", current.requestEventId);
    },
    async removeFriend(peerPubkey: string) {
      const peer = normalized(peerPubkey);
      if (this.getState(peer) !== "accepted") throw new Error("好友关系已失效");
      const keys = useKeyStore();
      const account = this.loadedFor;
      let pushRevokedFirst = false;
      if (account && pushEnabledForAccount(account) && keys.pkHex === account) {
        const remaining = this.records
          .filter(item => item.peerPubkey !== peer && item.state === "accepted")
          .map(item => item.peerPubkey);
        await syncPushAuthorizationPolicy(account, remaining, keys.signEvent.bind(keys));
        pushRevokedFirst = true;
      }
      try {
        await this.sendControl(peer, "remove");
      } catch (error) {
        // If the Nostr remove failed after a defensive push revoke, restore the
        // still-valid friendship policy so reliability is not silently degraded.
        if (pushRevokedFirst && account && keys.pkHex === account) {
          const current = this.records.filter(item => item.state === "accepted").map(item => item.peerPubkey);
          void syncPushAuthorizationPolicy(account, current, keys.signEvent.bind(keys)).catch(() => {});
        }
        throw error;
      }
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
