import { defineStore } from "pinia";
import type { FriendshipRecord } from "@/db/dexie";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DIRECT_MESSAGE_TYPE, canStartDirectMessage, directMessagePeer, isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { isMessageAfter } from "@/nostr/messaging/sync/sorting";
import { metaRepository } from "@/repositories/metaRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";

type MessageCursor = { lastReadCreatedAt: number; lastReadMessageId: string };
export type ConversationPreference = {
  hidden: boolean;
  hiddenMode?: "hidden" | "deleted";
  hiddenThroughCreatedAt?: number;
  hiddenThroughMessageId?: string;
  deletedThroughCreatedAt?: number;
  deletedThroughMessageId?: string;
};

function readKey(conversationId: string) { return `dm-read:${conversationId}`; }
function preferenceKey(peerPubkey: string) { return `dm-conversation:${peerPubkey}`; }
function cursor(createdAt?: number, messageId?: string) {
  return createdAt === undefined ? undefined : { lastReadCreatedAt: createdAt, lastReadMessageId: messageId || "" };
}
function afterCursor(item: InboxItem, createdAt?: number, messageId?: string) {
  return isMessageAfter({ id: item.id, createdAt: item.created_at }, cursor(createdAt, messageId));
}

export function isAuthorizedDirectMessage(item: InboxItem, accountPubkey: string, friendship?: FriendshipRecord) {
  if (item.pubkey === accountPubkey) return true;
  const windows = friendship?.acceptedWindows || [];
  if (!windows.length) return friendship?.state === "accepted";
  return windows.some(window => item.created_at >= window.acceptedAt
    && (window.endedAt === undefined || item.created_at <= window.endedAt));
}

function afterDeletion(item: InboxItem, preference?: ConversationPreference) {
  return afterCursor(item, preference?.deletedThroughCreatedAt, preference?.deletedThroughMessageId);
}

export function directMessagesForPeer(
  items: InboxItem[],
  accountPubkey: string,
  peerPubkey: string,
  options: { friendship?: FriendshipRecord; preference?: ConversationPreference; enforceAuthorization?: boolean } = {},
) {
  const peer = peerPubkey.toLowerCase();
  return items.filter(item => isDirectMessageTags(item.tags)
    && directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, accountPubkey) === peer
    && (!options.enforceAuthorization || isAuthorizedDirectMessage(item, accountPubkey, options.friendship))
    && afterDeletion(item, options.preference))
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

export function buildDirectConversationSummaries(
  items: InboxItem[],
  accountPubkey: string,
  unreadByConversation: Record<string, number>,
  options: { friendshipRecords?: FriendshipRecord[]; preferencesByPeer?: Record<string, ConversationPreference | undefined> } = {},
) {
  const latestByPeer = new Map<string, InboxItem>();
  for (const item of items) {
    if (!isDirectMessageTags(item.tags)) continue;
    const peer = directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, accountPubkey);
    if (!peer || options.preferencesByPeer?.[peer]?.hidden) continue;
    const friendship = options.friendshipRecords?.find(record => record.peerPubkey === peer);
    if (options.friendshipRecords && !isAuthorizedDirectMessage(item, accountPubkey, friendship)) continue;
    if (!afterDeletion(item, options.preferencesByPeer?.[peer])) continue;
    const current = latestByPeer.get(peer);
    if (!current || item.created_at > current.created_at || (item.created_at === current.created_at && item.id.localeCompare(current.id) > 0)) {
      latestByPeer.set(peer, item);
    }
  }
  return [...latestByPeer.entries()].map(([peerPubkey, latest]) => ({
    peerPubkey,
    conversationId: latest.conversationId || latest.id,
    latest,
    unread: unreadByConversation[latest.conversationId || latest.id] || 0,
  })).sort((a, b) => b.latest.created_at - a.latest.created_at || a.latest.id.localeCompare(b.latest.id));
}

export const useDirectMessagesStore = defineStore("directMessages", {
  state: () => ({
    loadedFor: "",
    unreadByConversation: {} as Record<string, number>,
    readCursors: {} as Record<string, MessageCursor | undefined>,
    preferencesByPeer: {} as Record<string, ConversationPreference | undefined>,
  }),
  getters: {
    unreadCount: state => Object.values(state.unreadByConversation).reduce((sum, value) => sum + value, 0),
  },
  actions: {
    peerMessages(peerPubkey: string) {
      const account = this.loadedFor;
      const friendships = useFriendshipsStore();
      return directMessagesForPeer(useMessagesStore().inbox, account, peerPubkey, {
        friendship: friendships.getRecord(peerPubkey),
        preference: this.preferencesByPeer[peerPubkey.toLowerCase()],
        enforceAuthorization: true,
      });
    },
    async refresh(accountPubkey?: string) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account) return this.reset();
      const messages = useMessagesStore();
      const friendships = useFriendshipsStore();
      await Promise.all([
        messages.loadedFor === account ? Promise.resolve() : messages.load(account),
        friendships.loadedFor === account && !friendships.loading ? Promise.resolve() : friendships.load(account),
      ]);
      if (useKeyStore().pkHex !== account) return;
      const direct = messages.inbox.filter(item => isDirectMessageTags(item.tags));
      const peers = [...new Set(direct.map(item => directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account)).filter(Boolean))] as string[];
      const preferenceEntries = await Promise.all(peers.map(async peer => {
        const record = await metaRepository.get(account, preferenceKey(peer));
        return [peer, record?.value as ConversationPreference | undefined] as const;
      }));
      const preferences = Object.fromEntries(preferenceEntries) as Record<string, ConversationPreference | undefined>;
      for (const peer of peers) {
        const preference = preferences[peer];
        if (!preference?.hidden) continue;
        const friendship = friendships.getRecord(peer);
        const authorized = directMessagesForPeer(direct, account, peer, { friendship, preference, enforceAuthorization: true });
        const newer = authorized.some(item => afterCursor(item, preference.hiddenThroughCreatedAt, preference.hiddenThroughMessageId)
          && (preference.hiddenMode === "deleted" || item.pubkey !== account));
        if (newer) {
          preferences[peer] = { ...preference, hidden: false };
          await metaRepository.put(account, preferenceKey(peer), preferences[peer]);
        }
      }
      const visible = direct.filter(item => {
        const peer = directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account);
        return !!peer && !preferences[peer]?.hidden
          && afterDeletion(item, preferences[peer])
          && isAuthorizedDirectMessage(item, account, friendships.getRecord(peer));
      });
      const conversationIds = [...new Set(visible.map(item => item.conversationId).filter((value): value is string => !!value))];
      const cursors = await Promise.all(conversationIds.map(async conversationId => {
        const record = await metaRepository.get(account, readKey(conversationId));
        return [conversationId, record?.value as MessageCursor | undefined] as const;
      }));
      if (useKeyStore().pkHex !== account) return;
      this.loadedFor = account;
      this.preferencesByPeer = preferences;
      this.readCursors = Object.fromEntries(cursors);
      this.unreadByConversation = Object.fromEntries(conversationIds.map(conversationId => {
        const read = this.readCursors[conversationId];
        const conversation = visible.filter(item => item.conversationId === conversationId);
        const peer = conversation[0] && directMessagePeer({
          senderPubkey: conversation[0].pubkey,
          recipientPubkeys: conversation[0].recipientPubkeys || [],
        }, account);
        const count = peer && friendships.isAccepted(peer)
          ? conversation.filter(item => item.pubkey !== account && isMessageAfter({ id: item.id, createdAt: item.created_at }, read)).length
          : 0;
        return [conversationId, count];
      }));
    },
    async markPeerRead(peerPubkey: string) {
      const account = useKeyStore().pkHex.toLowerCase();
      if (!account || this.loadedFor !== account) await this.refresh(account);
      const items = this.peerMessages(peerPubkey);
      const latestIncoming = items.filter(item => item.pubkey !== account).at(-1);
      if (!latestIncoming?.conversationId) return;
      const read = { lastReadCreatedAt: latestIncoming.created_at, lastReadMessageId: latestIncoming.id };
      await metaRepository.put(account, readKey(latestIncoming.conversationId), read);
      if (useKeyStore().pkHex !== account) return;
      this.readCursors = { ...this.readCursors, [latestIncoming.conversationId]: read };
      this.unreadByConversation = { ...this.unreadByConversation, [latestIncoming.conversationId]: 0 };
    },
    async hideConversation(peerPubkey: string) {
      const peer = peerPubkey.toLowerCase();
      const items = this.peerMessages(peer);
      const latest = items.at(-1);
      const preference: ConversationPreference = {
        ...this.preferencesByPeer[peer],
        hidden: true,
        hiddenMode: "hidden",
        hiddenThroughCreatedAt: latest?.created_at,
        hiddenThroughMessageId: latest?.id,
      };
      await metaRepository.put(this.loadedFor, preferenceKey(peer), preference);
      this.preferencesByPeer = { ...this.preferencesByPeer, [peer]: preference };
      for (const item of items) if (item.conversationId) this.unreadByConversation[item.conversationId] = 0;
      await this.markPeerRead(peer);
    },
    async deleteConversation(peerPubkey: string) {
      const peer = peerPubkey.toLowerCase();
      const items = this.peerMessages(peer);
      const latest = items.at(-1);
      const existing = this.preferencesByPeer[peer];
      const preference: ConversationPreference = {
        ...existing,
        hidden: true,
        hiddenMode: "deleted",
        hiddenThroughCreatedAt: latest?.created_at ?? existing?.hiddenThroughCreatedAt,
        hiddenThroughMessageId: latest?.id ?? existing?.hiddenThroughMessageId,
        deletedThroughCreatedAt: latest?.created_at ?? existing?.deletedThroughCreatedAt,
        deletedThroughMessageId: latest?.id ?? existing?.deletedThroughMessageId,
      };
      await metaRepository.put(this.loadedFor, preferenceKey(peer), preference);
      this.preferencesByPeer = { ...this.preferencesByPeer, [peer]: preference };
      for (const item of items) if (item.conversationId) this.unreadByConversation[item.conversationId] = 0;
      await this.markPeerRead(peer);
    },
    async send(peerPubkey: string, content: string) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      const peer = peerPubkey.trim().toLowerCase();
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      if (!canStartDirectMessage(account, peer, friendships.isAccepted)) throw new Error(peer === account ? "无法向自己发送私信" : "只能向已接受的好友发送私信");
      if (!content.trim()) throw new Error("消息不能为空");
      const result = await sendDirectMessage({
        recipientPubkeys: [peer], content: content.trim(), tags: [["t", DIRECT_MESSAGE_TYPE]], relays: getRelaysFromStorage("write"),
        pushCategory: "message",
        context: { senderPubkey: account, nip44Encrypt: keys.supportsNip44 ? keys.nip44Encrypt.bind(keys) : undefined, signEvent: keys.signEvent.bind(keys) },
      });
      if (keys.pkHex !== account || !friendships.isAccepted(peer)) throw new Error("好友关系已变更");
      await syncedMessageRepository.insertMessageIfAbsent(account, result.message);
      useMessagesStore().addInbox({
        id: result.message.id, pubkey: result.message.senderPubkey, created_at: result.message.createdAt,
        content: result.message.plaintext || "", protocol: "nip17", transportKind: result.message.transportKind,
        rumorId: result.message.rumorId, recipientPubkeys: result.message.recipientPubkeys,
        conversationId: result.message.conversationId, tags: result.message.tags,
      });
      await this.refresh(account);
      return result;
    },
    reset() {
      this.loadedFor = "";
      this.unreadByConversation = {};
      this.readCursors = {};
      this.preferencesByPeer = {};
    },
  },
});
