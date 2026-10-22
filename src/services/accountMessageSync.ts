import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { getActivePinia } from "pinia";
import { getRelaysFromStorage, inspectRelays, onRelayConnectionState, releaseUnusedRelayConnections } from "@/nostr/relays";
import { managedReceivedSinceRelay, managedRelayUrlFromCache } from "@/services/relaySession";
import { negentropyCapableRelays } from "@/services/relayCapabilities";
import { decodeFriendshipControl } from "@/nostr/messaging/friendshipControl";
import { createHomeMessageHandler, incomingFriendRequestNotification } from "@/nostr/messaging/homeDelivery";
import { MessageSyncManager } from "@/nostr/messaging/sync";
import type { SyncStatus } from "@/nostr/messaging/sync/types";
import { registerOutgoingPushSigner } from "@/nostr/messaging/service";
import { isConversationMessage } from "@/nostr/messaging/messageRouting";
import { isDmReceiptMessage } from "@/nostr/messaging/dmReceipts";
import { isAuthorizedCanonicalDirectMessage, useDirectMessagesStore } from "@/stores/directMessages";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { isFriendshipAcceptedAt, useFriendshipsStore } from "@/stores/friendships";
import { isInteractionMessage, useInteractionsStore } from "@/stores/interactions";
import { useMessagesStore } from "@/stores/messages";
import { useSettingsStore } from "@/stores/settings";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { onMessageAuthorizationChanged } from "@/services/messageAuthorizationEvents";
import { pushEnabledForAccount, syncPushAuthorizationPolicy } from "@/services/pushNotifications";
import { mentionedPubkeysFromTags } from "@/utils/mentions";
import { debugLog, startupMark } from "@/utils/debugLog";
import { deliveryStatsLogData, recordPersistedDelivery, resetDeliveryStats } from "@/services/dmDeliveryStats";
import {
  cancelDmRelayDirectoryWork,
  ensureOwnDmRelayList,
  getOwnDmRelayStatus,
  logDmRelayDirectoryFailure,
  selectOwnDmRelays,
} from "@/services/dmRelayDirectory";

export type AccountSyncKeys = {
  pkHex: string;
  isLoggedIn: boolean;
  supportsNip44: boolean;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};

export type AccountMessageSyncSnapshot = {
  accountPubkey: string;
  status: SyncStatus;
  relay: "idle" | "connecting" | "connected" | "offline";
  live: "idle" | "subscribing" | "active";
  catchup: "idle" | "running" | "pending" | "settled" | "error";
  /**
   * The managed relay finished this pass's catch-up; slower relays may still
   * be paging in the background. Reset when a new pass starts.
   */
  preferredCaughtUp?: boolean;
};

/** What the conversation list title shows: 连接中… / 同步中… / nothing. */
export type MessageSyncPhase = "connecting" | "syncing" | "idle";

export function messageSyncPhase(snapshot: AccountMessageSyncSnapshot, startupHydrating: boolean): MessageSyncPhase {
  if (snapshot.status === "connecting") return "connecting";
  if (snapshot.status === "offline" && snapshot.relay !== "connected") return "connecting";
  // Once the managed relay is caught up the list is current; a slow secondary
  // relay finishing in the background used to keep "同步中…" up for seconds.
  if (snapshot.status === "catching-up" || snapshot.catchup === "running") return snapshot.preferredCaughtUp ? "idle" : "syncing";
  // Startup history that is still paging in keeps the unread count provisional.
  if (snapshot.catchup === "pending" && startupHydrating) return "syncing";
  return "idle";
}

/**
 * Upper bound for holding the startup unread barrier while catch-up stays
 * pending (e.g. one Relay keeps failing). Fresh realtime messages still
 * surface during the wait; after it the durable projection is shown.
 */
export const STARTUP_UNREAD_PENDING_GRACE_MS = 60_000;

// The account service is the sole owner of the MessageSyncManager lifecycle.
// UI layers may request resume/read operations through the functions below,
// but they never receive the manager instance or start/stop subscriptions.
const accountMessageSyncManager = new MessageSyncManager();
let activeKeys: AccountSyncKeys | null = null;
let accountSyncGeneration = 0;
let accountSyncSnapshot: AccountMessageSyncSnapshot = { accountPubkey: "", status: "idle", relay: "idle", live: "idle", catchup: "idle" };
let removeAccountRelayObserver: (() => void) | null = null;
const accountSyncStatusListeners = new Set<(snapshot: AccountMessageSyncSnapshot) => void>();
let startupUnreadGraceTimer: ReturnType<typeof setTimeout> | null = null;

function clearStartupUnreadGraceTimer() {
  if (startupUnreadGraceTimer) clearTimeout(startupUnreadGraceTimer);
  startupUnreadGraceTimer = null;
}
let dmRelayHealthUnsubscribe: (() => void) | null = null;
const DM_RELAY_FAILURE_THRESHOLD = 3;
const DM_RELAY_FAILURE_GRACE_MS = 5 * 60_000;
const DM_RELAY_RECHECK_MS = 5 * 60_000;
type DmRelayFailureState = {
  failures: number;
  firstFailedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};
const dmRelayHealthFailures = new Map<string, DmRelayFailureState>();

function clearDmRelayFailure(relayUrl: string) {
  const state = dmRelayHealthFailures.get(relayUrl);
  if (state?.timer) clearTimeout(state.timer);
  dmRelayHealthFailures.delete(relayUrl);
}

function stopDmRelayHealthWatch() {
  for (const relayUrl of [...dmRelayHealthFailures.keys()]) clearDmRelayFailure(relayUrl);
  dmRelayHealthUnsubscribe?.();
  dmRelayHealthUnsubscribe = null;
}

function bindDmRelayHealthWatch(
  account: string,
  isCurrent: () => boolean,
  signer: (event: EventTemplate) => Promise<VerifiedEvent>,
) {
  stopDmRelayHealthWatch();

  const scheduleReconcile = (relayUrl: string, delay: number) => {
    const state = dmRelayHealthFailures.get(relayUrl);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const latest = dmRelayHealthFailures.get(relayUrl);
      if (!latest || !isCurrent()) return;
      latest.timer = null;

      const runtime = inspectRelays()[relayUrl];
      if (runtime?.state === "connected" || runtime?.ready === true) {
        clearDmRelayFailure(relayUrl);
        return;
      }

      const failureAge = Date.now() - latest.firstFailedAt;
      if (latest.failures < DM_RELAY_FAILURE_THRESHOLD || failureAge < DM_RELAY_FAILURE_GRACE_MS) {
        scheduleReconcile(relayUrl, Math.max(1_000, DM_RELAY_FAILURE_GRACE_MS - failureAge));
        return;
      }

      void ensureOwnDmRelayList(account, signer, { replaceUnhealthyRelays: [relayUrl], refreshRemote: false })
        .then(async () => {
          if (!isCurrent()) return;
          const own = await getOwnDmRelayStatus(account);
          if (!own.relays.includes(relayUrl)) {
            clearDmRelayFailure(relayUrl);
            return;
          }
          // No healthy replacement was available. Keep the sticky route and
          // retry conservatively instead of shrinking/churning the inbox list.
          scheduleReconcile(relayUrl, DM_RELAY_RECHECK_MS);
        })
        .catch(logDmRelayDirectoryFailure);
    }, Math.max(0, delay));
    (state.timer as any).unref?.();
  };

  const scheduleAnyOverdueFailures = () => {
    const now = Date.now();
    for (const [relayUrl, state] of dmRelayHealthFailures) {
      if (state.failures < DM_RELAY_FAILURE_THRESHOLD) continue;
      const remaining = DM_RELAY_FAILURE_GRACE_MS - (now - state.firstFailedAt);
      scheduleReconcile(relayUrl, Math.max(0, remaining));
    }
  };

  dmRelayHealthUnsubscribe = onRelayConnectionState(event => {
    if (!isCurrent()) {
      stopDmRelayHealthWatch();
      return;
    }
    const readRelays = new Set(getRelaysFromStorage("read"));
    if (!readRelays.has(event.url)) return;

    if (event.connected) {
      clearDmRelayFailure(event.url);
      // A newly healthy alternative may now be able to replace another Relay
      // that has already crossed the sustained-failure threshold.
      scheduleAnyOverdueFailures();
      return;
    }
    if (!event.failed) return;

    const previous = dmRelayHealthFailures.get(event.url);
    const next: DmRelayFailureState = previous || {
      failures: 0,
      firstFailedAt: event.at || Date.now(),
      timer: null,
    };
    next.failures += 1;
    dmRelayHealthFailures.set(event.url, next);
    if (next.failures < DM_RELAY_FAILURE_THRESHOLD) return;

    const elapsed = Math.max(0, (event.at || Date.now()) - next.firstFailedAt);
    scheduleReconcile(event.url, Math.max(0, DM_RELAY_FAILURE_GRACE_MS - elapsed));
  });
}

onMessageAuthorizationChanged(accountPubkey => {
  if (activeKeys?.pkHex.toLowerCase() !== accountPubkey) return;
  void accountMessageSyncManager.retryDeferredAuthorization().catch(error => {
    console.warn("[message-sync] deferred authorization retry failed", error);
  });
});

function setAccountMessageSyncStatus(accountPubkey: string, status: SyncStatus, patch: Partial<Omit<AccountMessageSyncSnapshot, "accountPubkey" | "status">> = {}) {
  const sameAccount = accountSyncSnapshot.accountPubkey === accountPubkey.toLowerCase();
  accountSyncSnapshot = {
    ...(sameAccount ? accountSyncSnapshot : { relay: "idle" as const, live: "idle" as const, catchup: "idle" as const }),
    ...patch,
    accountPubkey: accountPubkey.toLowerCase(), status,
  };
  for (const listener of accountSyncStatusListeners) {
    try {
      listener({ ...accountSyncSnapshot });
    } catch {
      // A UI status observer must never interfere with sync ownership.
    }
  }
}

export function getAccountMessageSyncStatus(): AccountMessageSyncSnapshot {
  return { ...accountSyncSnapshot };
}

export function onAccountMessageSyncStatus(listener: (snapshot: AccountMessageSyncSnapshot) => void) {
  accountSyncStatusListeners.add(listener);
  listener(getAccountMessageSyncStatus());
  return () => accountSyncStatusListeners.delete(listener);
}

export async function startAccountMessageSync(keys: AccountSyncKeys, startup: { historyGate?: Promise<unknown> } = {}) {
  const account = keys.pkHex.toLowerCase();
  if (!account || !keys.isLoggedIn || !keys.supportsNip44) return false;

  const generation = ++accountSyncGeneration;
  clearStartupUnreadGraceTimer();
  stopDmRelayHealthWatch();
  removeAccountRelayObserver?.();
  removeAccountRelayObserver = null;
  activeKeys = keys;
  const isCurrent = () =>
    generation === accountSyncGeneration
    && activeKeys === keys
    && keys.isLoggedIn
    && keys.pkHex.toLowerCase() === account;
  // A managed-relay refresh must not block NIP-17 subscriptions. If it changes
  // the read-relay set, reconcile once the current startup has settled.
  let subscribedReadRelaySignature: string | null = null;
  let startupSettled = false;
  const readRelaySignature = (relays: string[]) => [...new Set(relays)].sort().join("|");
  const reconcileManagedRelay = () => {
    if (!isCurrent() || !startupSettled || subscribedReadRelaySignature === null) return;
    if (readRelaySignature(getRelaysFromStorage("read")) === subscribedReadRelaySignature) return;
    void restartAccountMessageSync().catch(error => {
      console.warn("[message-sync] managed relay refresh restart failed", error instanceof Error ? error.message : "unknown");
    });
  };
  const assertCurrentSigner = async (event: EventTemplate) => {
    if (!isCurrent()) throw new Error("account_sync_cancelled");
    const signed = await keys.signEvent(event);
    if (!isCurrent() || signed.pubkey.toLowerCase() !== account) throw new Error("account_sync_cancelled");
    return signed;
  };
  const decryptForCurrentSession = async (peer: string, ciphertext: string) => {
    if (!isCurrent()) throw new Error("account_sync_cancelled");
    const plaintext = await keys.nip44Decrypt(peer, ciphertext);
    if (!isCurrent()) throw new Error("account_sync_cancelled");
    return plaintext;
  };

  const friendships = useFriendshipsStore();
  if (friendships.loadedFor !== account || !friendships.authorizationReady) {
    try {
      await friendships.load(account);
    } catch (error) {
      console.warn("[message-sync] friendship authorization remains unresolved", error);
    }
  }
  if (!isCurrent()) return false;
  const profiles = useProfilesStore();
  if (getActivePinia()) {
    void useSettingsStore().refreshManagedRelay()
      .then(reconcileManagedRelay)
      .catch(error => {
        console.warn("[message-sync] managed relay refresh unavailable", error instanceof Error ? error.message : "unknown");
      });
  }
  const initialSyncState = await syncedMessageRepository.getSyncState(account);
  if (!isCurrent()) return false;
  let friendshipHistoryComplete = !!initialSyncState.historyBackfillCompletedAt;

  const authorizePeerAt = (peerPubkey: string, createdAt: number) => {
    const authorized = isFriendshipAcceptedAt(friendships.getRecord(peerPubkey), createdAt);
    if (authorized) return "accepted" as const;
    return friendshipHistoryComplete ? "rejected" as const : "unresolved" as const;
  };

  const feedPreferences = useFeedPreferencesStore();
  const interactions = useInteractionsStore();
  const notifications = useNotificationsStore();
  const messages = useMessagesStore();
  const directMessages = useDirectMessagesStore();
  resetDeliveryStats();
  directMessages.beginHistoryHydration(account);
  const settleStartupUnread = (outcome: "live" | "error") => {
    void directMessages.finishHistoryHydration(account, outcome).then(() => {
      // Last startup gate: only show unread after both the cloud cursor
      // and the first durable history/authorization reconciliation.
      // Old manager callbacks must not unmask a newer account session.
      if (isCurrent() && directMessages.historyHydrationPhase === outcome) {
        directMessages.finishReadStateRestore(account);
        // Until here the unread badge and fresh unread were held back.
        startupMark("unread_revealed", { outcome });
      }
    }).catch(error => {
      // Do not expose the provisional hundreds-of-unread projection on
      // an incomplete reconciliation; retry on the next status transition.
      console.warn("[dm] startup unread reconciliation failed", error instanceof Error ? error.message : "unknown");
    });
  };
  // Latest bounded catch-up outcome. "live" only means the realtime
  // subscription is up; history may still be paging in ("pending").
  let latestCatchup: "unknown" | "pending" | "settled" = "unknown";
  const settleStartupUnreadWhenHistoryComplete = () => {
    if (latestCatchup !== "pending") {
      clearStartupUnreadGraceTimer();
      settleStartupUnread("live");
      return;
    }
    if (startupUnreadGraceTimer || directMessages.historyHydrationPhase !== "hydrating") return;
    startupUnreadGraceTimer = setTimeout(() => {
      startupUnreadGraceTimer = null;
      if (!isCurrent() || directMessages.historyHydrationPhase !== "hydrating") return;
      debugLog("sync", "startup_unread_pending_grace_elapsed", { pubkeyPrefix: account }, "warn");
      settleStartupUnread("live");
    }, STARTUP_UNREAD_PENDING_GRACE_MS);
    (startupUnreadGraceTimer as any).unref?.();
  };
  const accepted = friendships.records
    .filter(record => record.state === "accepted")
    .map(record => record.peerPubkey);

  if (!isCurrent()) return false;
  registerOutgoingPushSigner(account, assertCurrentSigner);
  if (pushEnabledForAccount(account)) {
    void syncPushAuthorizationPolicy(account, accepted, assertCurrentSigner).catch(error => {
      console.warn("[push] authorization policy refresh failed", error instanceof Error ? error.message : "unknown");
    });
  }

  try {
    let homeHandler: ReturnType<typeof createHomeMessageHandler>;
    const storedOwnDm = await getOwnDmRelayStatus(account);
    if (!isCurrent()) return false;
    const legacyReadRelays = getRelaysFromStorage("read");
    const dmRelays = storedOwnDm.relays.length ? storedOwnDm.relays : selectOwnDmRelays(legacyReadRelays);
    subscribedReadRelaySignature = readRelaySignature(legacyReadRelays);
    const messageRelays = [...new Set([...dmRelays, ...legacyReadRelays])];
    // Connectivity is independent of historical repair. Observe first, then
    // inspect the current pool so already-open sockets are not reported offline.
    const publishRelaySnapshot = () => {
      if (!isCurrent()) return;
      const runtime = inspectRelays();
      const connected = messageRelays.some(url => runtime[url]?.ready || runtime[url]?.state === "connected");
      const connecting = messageRelays.some(url => runtime[url]?.state === "connecting" || runtime[url]?.state === "waiting-retry");
      const relay = connected ? "connected" : connecting ? "connecting" : "offline";
      if (accountSyncSnapshot.accountPubkey === account && accountSyncSnapshot.relay === relay) return;
      setAccountMessageSyncStatus(account, accountSyncSnapshot.accountPubkey === account ? accountSyncSnapshot.status : "connecting", { relay });
    };
    removeAccountRelayObserver = onRelayConnectionState(event => {
      if (messageRelays.includes(event.url)) publishRelaySnapshot();
    });
    publishRelaySnapshot();
    // All configured read relays remain part of the normal message subscription.
    // The kind 10050 advertisement itself is refreshed only after runtime
    // connectivity is known, so failed read relays are never selected merely
    // because they appear early in configuration order.
    await accountMessageSyncManager.start({
      accountPubkey: account,
      historyGate: startup.historyGate,
      relays: messageRelays,
      authors: [...new Set([...accepted, account])],
      decodeContext: {
        accountPubkey: account,
        nip44Decrypt: keys.supportsNip44 ? decryptForCurrentSession : undefined,
      },
      onMessage: homeHandler = createHomeMessageHandler({
        deferUntilDurable: true,
        accountPubkey: account,
        currentAccount: () => activeKeys?.pkHex || "",
        isAuthorizationReady: () => friendships.loadedFor === account && friendships.authorizationReady && !friendships.loading,
        isAcceptedMessage: message => {
          if (friendships.loadedFor !== account || friendships.loading || !friendships.authorizationReady) return "unresolved";
          if (isConversationMessage(message)) {
            const peer = message.senderPubkey === account
              ? message.recipientPubkeys.find(pubkey => pubkey !== account) || ""
              : message.senderPubkey;
            if (!peer) return friendshipHistoryComplete ? "rejected" : "unresolved";
            if (isAuthorizedCanonicalDirectMessage(message, account, friendships.getRecord(peer))) {
              return "accepted";
            }
            return friendshipHistoryComplete ? "rejected" : "unresolved";
          }
          if (message.senderPubkey === account) {
            const recipients = message.recipientPubkeys.filter(pubkey => pubkey !== account);
            const decisions = recipients.map(pubkey => authorizePeerAt(pubkey, message.createdAt));
            if (decisions.every(decision => decision === "accepted")) return "accepted";
            return decisions.some(decision => decision === "unresolved") ? "unresolved" : "rejected";
          }
          return authorizePeerAt(message.senderPubkey, message.createdAt);
        },
        processFriendshipMessage: message => friendships.processFriendshipMessage(message),
        processProfileMessage: message => profiles.processProfileMessage(message, friendships.isAccepted),
        processFeedControlMessage: message => feedPreferences.processTombstone(
          message,
          friendships.isAccepted,
          messageId => messages.inbox.find(item => item.id === messageId)?.pubkey,
        ),
        notifyFriendshipMessage: message => {
          const notification = incomingFriendRequestNotification(message, account);
          if (notification) notifications.addNotification(notification);
          else if (decodeFriendshipControl(message)) notifications.resolveFriendRequests(message.senderPubkey);
        },
        isReceipt: isDmReceiptMessage,
        processReceipt: message => directMessages.processReceipt(message),
        processBurnControl: message => directMessages.processBurnControl(message),
        isInteraction: isInteractionMessage,
        processInteraction: async message => {
          await interactions.processCanonicalInteraction(message, account);
        },
        mirrorMessage: message => {
          if (
            message.senderPubkey.toLowerCase() !== account
            && !isConversationMessage(message)
            && mentionedPubkeysFromTags(message.tags).includes(account)
          ) {
            notifications.addNotification({
              id: `mention-post:${message.id}`,
              type: "mention_post",
              from: message.senderPubkey,
              messageId: message.id,
              created_at: message.createdAt,
              read: false,
              postContent: message.plaintext || "",
            });
          }
          messages.addInbox({
          id: message.id,
          pubkey: message.senderPubkey,
          created_at: message.createdAt,
          content: message.plaintext || "",
          protocol: message.protocol,
          transportKind: message.transportKind,
          transportEventId: message.transportEventId,
          rumorId: message.rumorId,
          recipientPubkeys: message.recipientPubkeys,
          conversationId: message.conversationId,
          replyTo: message.replyTo,
          rootId: message.rootId,
          tags: message.tags,
          });
        },
      }),
      onPersistedMessage: async (message, metadata, inserted) => {
        // Diagnostics for duplicate re-delivery cost (review item #8).
        const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const inboxRevision = messages.inboxRevision;
        try {
          await homeHandler(message, {...metadata,durable:true});
          // A Push-cached or live NIP-17 wrap can be durable before initial
          // history EOSE. Show ONLY this new incoming unread, not the provisional
          // historical total. The canonical cursor and friend policy still apply.
          if (isCurrent() && metadata.source === "realtime") {
            directMessages.noteFreshPersistedIncoming(account, message, inserted);
          }
          // Restoring cached messages is not a new delivery. Their persisted
          // receipt state already survives the session; avoid per-message work.
          if (metadata.source !== "local-migration") {
            await directMessages.acknowledgePersistedIncoming(account, message);
          }
        } finally {
          if (isCurrent()) {
            const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
            recordPersistedDelivery(metadata.source, inserted, elapsed, messages.inboxRevision !== inboxRevision);
          }
        }
      },
      // The managed relay pages hundreds of wraps in well under a second while
      // a self-hosted one can take many seconds. Catch up from it first and
      // reveal unread once it is done; slower relays keep paging behind it.
      preferredCatchupRelay: managedRelayUrlFromCache,
      receivedSinceRelay: managedReceivedSinceRelay,
      negentropyRelays: negentropyCapableRelays,
      onPreferredRelayCaughtUp: () => {
        if (isCurrent()) setAccountMessageSyncStatus(account, accountSyncSnapshot.status, { preferredCaughtUp: true });
        if (!isCurrent() || directMessages.historyHydrationPhase !== "hydrating") return;
        clearStartupUnreadGraceTimer();
        settleStartupUnread("live");
      },
      onCatchupStatus: catchup => {
        if (!isCurrent()) return;
        latestCatchup = catchup;
        setAccountMessageSyncStatus(account, accountSyncSnapshot.status, { catchup });
      },
      onStatus: status => {
        if (!isCurrent()) return;
        setAccountMessageSyncStatus(account, status, {
          ...(status === "catching-up" ? { preferredCaughtUp: false } : {}),
          live: status === "connecting" ? "subscribing" : status === "live" || status === "catching-up" ? "active" : "idle",
          catchup: status === "catching-up" ? "running" : status === "error" ? "error" : accountSyncSnapshot.catchup,
        });
        if (status === "live") {
          // Finalize the startup unread count only once history has settled;
          // an idle continuation reports live again after the next page.
          settleStartupUnreadWhenHistoryComplete();
          debugLog("sync", "dm_delivery_stats", deliveryStatsLogData(), "info");
        }
        // Terminal startup outcomes that never become live: a failed catch-up,
        // or no message Relay at all. A transient all-Relays-disconnected
        // "offline" normally still reaches live after catch-up, so keep the
        // barrier for it. Read cursors were restored before sync started, so
        // the durable local projection is safe to show.
        else if (status === "error" || (status === "offline" && messageRelays.length === 0)) {
          clearStartupUnreadGraceTimer();
          settleStartupUnread("error");
        }
        if (status !== "live" || friendshipHistoryComplete) return;
        void syncedMessageRepository.getSyncState(account).then(state => {
          if (activeKeys?.pkHex.toLowerCase() !== account || !state.historyBackfillCompletedAt) return;
          friendshipHistoryComplete = true;
          return accountMessageSyncManager.retryDeferredAuthorization();
        }).catch(error => {
          console.warn("[message-sync] friendship history readiness check failed", error);
        });
      },
    });
    if (!isCurrent()) return false;
    startupSettled = true;
    reconcileManagedRelay();
    if (!isCurrent()) return false;
    if (keys.supportsNip44) {
      bindDmRelayHealthWatch(account, isCurrent, assertCurrentSigner);
      void ensureOwnDmRelayList(account, assertCurrentSigner).catch(logDmRelayDirectoryFailure);
    }
    return true;
  } catch (error) {
    if (isCurrent()) {
      const value = error instanceof Error ? error : new Error(String(error));
      startupMark("message_sync_failed", { name: value.name || "Error", message: String(value.message || "").slice(0, 160) });
      setAccountMessageSyncStatus(account, "error");
      settleStartupUnread("error");
    }
    throw error;
  }
}

export async function restartAccountMessageSync() {
  if (!activeKeys?.isLoggedIn) return false;
  return startAccountMessageSync(activeKeys);
}

export async function resumeAccountMessageSync(source: "reconnect" | "resume" | "manual" = "manual") {
  if (!activeKeys?.isLoggedIn) return false;
  await accountMessageSyncManager.resume(source);
  return true;
}

export async function markAccountConversationRead(conversationId: string) {
  if (!activeKeys?.isLoggedIn || !conversationId) return false;
  await accountMessageSyncManager.markConversationRead(conversationId);
  return true;
}

export function stopAccountMessageSync() {
  const account = activeKeys?.pkHex.toLowerCase() || accountSyncSnapshot.accountPubkey;
  accountSyncGeneration++;
  clearStartupUnreadGraceTimer();
  stopDmRelayHealthWatch();
  removeAccountRelayObserver?.();
  removeAccountRelayObserver = null;
  activeKeys = null;
  if (account) cancelDmRelayDirectoryWork(account);
  accountMessageSyncManager.stop();
  // Reclaim only unowned warm/discovery sockets on account switch or lock.
  // Active publish confirmation leases remain protected until settled.
  releaseUnusedRelayConnections();
  setAccountMessageSyncStatus(account, "idle", { relay: "idle", live: "idle", catchup: "idle" });
}
