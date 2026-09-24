import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { getRelaysFromStorage } from "@/nostr/relays";
import { decodeFriendshipControl } from "@/nostr/messaging/friendshipControl";
import { createHomeMessageHandler, incomingFriendRequestNotification } from "@/nostr/messaging/homeDelivery";
import { MessageSyncManager } from "@/nostr/messaging/sync";
import { registerOutgoingPushSigner } from "@/nostr/messaging/service";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { useFriendshipsStore } from "@/stores/friendships";
import { isInteractionMessage, useInteractionsStore } from "@/stores/interactions";
import { useMessagesStore } from "@/stores/messages";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";

export type AccountSyncKeys = {
  pkHex: string;
  isLoggedIn: boolean;
  supportsNip44: boolean;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
};

export const accountMessageSyncManager = new MessageSyncManager();
let activeKeys: AccountSyncKeys | null = null;

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
  const accepted = friendships.records.filter(record => record.state === "accepted").map(record => record.peerPubkey);
  registerOutgoingPushSigner(account, keys.signEvent.bind(keys));
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
      isAcceptedMessage: message => message.senderPubkey === account
        ? message.recipientPubkeys.filter(pubkey => pubkey !== account).every(pubkey => friendships.isAccepted(pubkey))
        : friendships.isAccepted(message.senderPubkey),
      processFriendshipMessage: message => friendships.processFriendshipMessage(message),
      processProfileMessage: message => profiles.processProfileMessage(message, friendships.isAccepted),
      processFeedControlMessage: message => feedPreferences.processTombstone(
        message, friendships.isAccepted, messageId => messages.inbox.find(item => item.id === messageId)?.pubkey,
      ),
      notifyFriendshipMessage: message => {
        const notification = incomingFriendRequestNotification(message, account);
        if (notification) notifications.addNotification(notification);
        else if (decodeFriendshipControl(message)) notifications.resolveFriendRequests(message.senderPubkey);
      },
      isInteraction: isInteractionMessage,
      processInteraction: async message => { await interactions.processCanonicalInteraction(message, account); },
      mirrorMessage: message => messages.addInbox({
        id: message.id, pubkey: message.senderPubkey, created_at: message.createdAt,
        content: message.plaintext || "", protocol: message.protocol, transportKind: message.transportKind,
        transportEventId: message.transportEventId, rumorId: message.rumorId,
        recipientPubkeys: message.recipientPubkeys, conversationId: message.conversationId,
        replyTo: message.replyTo, rootId: message.rootId, tags: message.tags,
      }),
    }),
  });
  return true;
}

export async function restartAccountMessageSync() {
  if (!activeKeys?.isLoggedIn) return false;
  return startAccountMessageSync(activeKeys);
}

export function stopAccountMessageSync() {
  activeKeys = null;
  accountMessageSyncManager.stop();
}
