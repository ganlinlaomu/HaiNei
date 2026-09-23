import { defineStore } from "pinia";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DIRECT_MESSAGE_TYPE, canStartDirectMessage, directMessagePeer, isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { isMessageAfter } from "@/nostr/messaging/sync/sorting";
import { metaRepository } from "@/repositories/metaRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";

type DirectReadCursor = { lastReadCreatedAt: number; lastReadMessageId: string };

function readKey(conversationId: string) {
  return `dm-read:${conversationId}`;
}

export function directMessagesForPeer(items: InboxItem[], accountPubkey: string, peerPubkey: string) {
  const peer = peerPubkey.toLowerCase();
  return items.filter(item => isDirectMessageTags(item.tags)
    && directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, accountPubkey) === peer)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

export function buildDirectConversationSummaries(
  items: InboxItem[],
  accountPubkey: string,
  unreadByConversation: Record<string, number>,
) {
  const latestByPeer = new Map<string, InboxItem>();
  for (const item of items) {
    if (!isDirectMessageTags(item.tags)) continue;
    const peer = directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, accountPubkey);
    if (!peer) continue;
    const current = latestByPeer.get(peer);
    if (!current || item.created_at > current.created_at
      || (item.created_at === current.created_at && item.id.localeCompare(current.id) > 0)) {
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
    readCursors: {} as Record<string, DirectReadCursor | undefined>,
  }),
  getters: {
    unreadCount: state => Object.values(state.unreadByConversation).reduce((sum, value) => sum + value, 0),
  },
  actions: {
    async refresh(accountPubkey?: string) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account) return this.reset();
      const messages = useMessagesStore();
      if (messages.loadedFor !== account) await messages.load(account);
      if (useKeyStore().pkHex !== account) return;
      const direct = messages.inbox.filter(item => isDirectMessageTags(item.tags));
      const conversationIds = [...new Set(direct.map(item => item.conversationId).filter((value): value is string => !!value))];
      const cursors = await Promise.all(conversationIds.map(async conversationId => {
        const record = await metaRepository.get(account, readKey(conversationId));
        return [conversationId, record?.value as DirectReadCursor | undefined] as const;
      }));
      if (useKeyStore().pkHex !== account) return;
      this.loadedFor = account;
      this.readCursors = Object.fromEntries(cursors);
      this.unreadByConversation = Object.fromEntries(conversationIds.map(conversationId => {
        const cursor = this.readCursors[conversationId];
        const count = direct.filter(item => item.conversationId === conversationId
          && item.pubkey !== account
          && isMessageAfter({ id: item.id, createdAt: item.created_at }, cursor)).length;
        return [conversationId, count];
      }));
    },

    async markPeerRead(peerPubkey: string) {
      const account = useKeyStore().pkHex.toLowerCase();
      if (!account || this.loadedFor !== account) await this.refresh(account);
      const items = directMessagesForPeer(useMessagesStore().inbox, account, peerPubkey);
      const latestIncoming = items.filter(item => item.pubkey !== account).at(-1);
      if (!latestIncoming?.conversationId) return;
      const cursor = { lastReadCreatedAt: latestIncoming.created_at, lastReadMessageId: latestIncoming.id };
      await metaRepository.put(account, readKey(latestIncoming.conversationId), cursor);
      if (useKeyStore().pkHex !== account) return;
      this.readCursors = { ...this.readCursors, [latestIncoming.conversationId]: cursor };
      this.unreadByConversation = { ...this.unreadByConversation, [latestIncoming.conversationId]: 0 };
    },

    async send(peerPubkey: string, content: string) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      const peer = peerPubkey.trim().toLowerCase();
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      if (!canStartDirectMessage(account, peer, friendships.isAccepted)) {
        throw new Error(peer === account ? "无法向自己发送私信" : "只能向已接受的好友发送私信");
      }
      if (!content.trim()) throw new Error("消息不能为空");
      const result = await sendDirectMessage({
        recipientPubkeys: [peer],
        content: content.trim(),
        tags: [["t", DIRECT_MESSAGE_TYPE]],
        relays: getRelaysFromStorage("write"),
        context: {
          senderPubkey: account,
          nip44Encrypt: keys.supportsNip44 ? keys.nip44Encrypt.bind(keys) : undefined,
          signEvent: keys.signEvent.bind(keys),
        },
      });
      if (keys.pkHex !== account || !friendships.isAccepted(peer)) throw new Error("好友关系已变更");
      await syncedMessageRepository.insertMessageIfAbsent(account, result.message);
      const messages = useMessagesStore();
      messages.addInbox({
        id: result.message.id,
        pubkey: result.message.senderPubkey,
        created_at: result.message.createdAt,
        content: result.message.plaintext || "",
        protocol: "nip17",
        transportKind: result.message.transportKind,
        rumorId: result.message.rumorId,
        recipientPubkeys: result.message.recipientPubkeys,
        conversationId: result.message.conversationId,
        tags: result.message.tags,
      });
      await this.refresh(account);
      return result;
    },

    reset() {
      this.loadedFor = "";
      this.unreadByConversation = {};
      this.readCursors = {};
    },
  },
});
