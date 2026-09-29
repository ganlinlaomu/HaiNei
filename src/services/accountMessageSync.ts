import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { getRelaysFromStorage } from "@/nostr/relays";
import { decodeFriendshipControl } from "@/nostr/messaging/friendshipControl";
import { createHomeMessageHandler, incomingFriendRequestNotification } from "@/nostr/messaging/homeDelivery";
import { MessageSyncManager } from "@/nostr/messaging/sync";
import type { SyncStatus } from "@/nostr/messaging/sync/types";
import { registerOutgoingPushSigner } from "@/nostr/messaging/service";
import { isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { isDmReceiptMessage } from "@/nostr/messaging/dmReceipts";
import { isAuthorizedCanonicalDirectMessage, useDirectMessagesStore } from "@/stores/directMessages";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { isFriendshipAcceptedAt, useFriendshipsStore } from "@/stores/friendships";
import { isInteractionMessage, useInteractionsStore } from "@/stores/interactions";
import { useMessagesStore } from "@/stores/messages";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";
import { onMessageAuthorizationChanged } from "@/services/messageAuthorizationEvents";

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
};

// The account service is the sole owner of the MessageSyncManager lifecycle.
// UI layers may request resume/read operations through the functions below,
// but they never receive the manager instance or start/stop subscriptions.
const accountMessageSyncManager = new MessageSyncManager();
let activeKeys: AccountSyncKeys | null = null;
let accountSyncSnapshot: AccountMessageSyncSnapshot = { accountPubkey: "", status: "idle" };
const accountSyncStatusListeners = new Set<(snapshot: AccountMessageSyncSnapshot) => void>();

onMessageAuthorizationChanged(accountPubkey => {
  if (activeKeys?.pkHex.toLowerCase() !== accountPubkey) return;
  void accountMessageSyncManager.retryDeferredAuthorization().catch(error => {
    console.warn("[message-sync] deferred authorization retry failed", error);
  });
});

function setAccountMessageSyncStatus(accountPubkey: string, status: SyncStatus) {
  accountSyncSnapshot = { accountPubkey: accountPubkey.toLowerCase(), status };
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

export async function startAccountMessageSync(keys: AccountSyncKeys) {
  const account = keys.pkHex.toLowerCase();
  if (!account || !keys.isLoggedIn) return false;

  activeKeys = keys;
  const friendships = useFriendshipsStore();
  const profiles = useProfilesStore();
  const feedPreferences = useFeedPreferencesStore();
  const interactions = useInteractionsStore();
  const notifications = useNotificationsStore();
  const messages = useMessagesStore();
  const directMessages = useDirectMessagesStore();
  const accepted = friendships.records
    .filter(record => record.state === "accepted")
    .map(record => record.peerPubkey);

  registerOutgoingPushSigner(account, keys.signEvent.bind(keys));

  try {
    await accountMessageSyncManager.start({
      accountPubkey: account,
      relays: getRelaysFromStorage("read"),
      authors: [...new Set([...accepted, account])],
      decodeContext: {
        accountPubkey: account,
        nip44Decrypt: keys.supportsNip44 ? keys.nip44Decrypt.bind(keys) : undefined,
      },
      onMessage: createHomeMessageHandler({
        accountPubkey: account,
        currentAccount: () => activeKeys?.pkHex || "",
        isAuthorizationReady: () => friendships.loadedFor === account && !friendships.loading,
        isAcceptedMessage: message => {
          if (friendships.loadedFor !== account || friendships.loading) return "unresolved";
          if (isDirectMessageTags(message.tags)) {
            const peer = message.senderPubkey === account
              ? message.recipientPubkeys.find(pubkey => pubkey !== account) || ""
              : message.senderPubkey;
            if (!peer) return "rejected";
            return isAuthorizedCanonicalDirectMessage(
              message,
              account,
              friendships.getRecord(peer),
            ) ? "accepted" : "rejected";
          }
          if (message.senderPubkey === account) {
            const recipients = message.recipientPubkeys.filter(pubkey => pubkey !== account);
            return recipients.every(pubkey => isFriendshipAcceptedAt(
              friendships.getRecord(pubkey),
              message.createdAt,
            )) ? "accepted" : "rejected";
          }
          return isFriendshipAcceptedAt(
            friendships.getRecord(message.senderPubkey),
            message.createdAt,
          ) ? "accepted" : "rejected";
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
        isInteraction: isInteractionMessage,
        processInteraction: async message => {
          await interactions.processCanonicalInteraction(message, account);
        },
        mirrorMessage: message => messages.addInbox({
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
        }),
      }),
      onPersistedMessage: message => directMessages.acknowledgePersistedIncoming(account, message),
      onStatus: status => setAccountMessageSyncStatus(account, status),
    });
    return true;
  } catch (error) {
    if (activeKeys?.pkHex.toLowerCase() === account) setAccountMessageSyncStatus(account, "error");
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
  activeKeys = null;
  accountMessageSyncManager.stop();
  setAccountMessageSyncStatus(account, "idle");
}
