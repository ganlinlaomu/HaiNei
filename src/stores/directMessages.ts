import { defineStore } from "pinia";
import type { FriendshipRecord, OutgoingDmTaskRecord } from "@/db/dexie";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DIRECT_MESSAGE_TYPE, canStartDirectMessage, directMessagePeer, directMessagePreview, isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { deriveConversationId } from "@/nostr/messaging/protocol/common";
import {
  cursorAfter as receiptCursorAfter,
  cursorCovers,
  decodeDmReceipt,
  dmReceiptTags,
  serializeDmReceipt,
  type DmReceiptCursor,
  type DmReceiptStatus,
} from "@/nostr/messaging/dmReceipts";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { publishQueuedOutgoing, registerOutgoingPushSigner, sendDirectMessage, type PublishedMessage } from "@/nostr/messaging/service";
import { isMessageAfter } from "@/nostr/messaging/sync/sorting";
import { metaRepository } from "@/repositories/metaRepository";
import { outgoingDmTaskRepository } from "@/repositories/outgoingDmTaskRepository";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { isFriendshipAcceptedAt, useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { useSettingsStore } from "@/stores/settings";
import { deviceStorage } from "@/services/deviceStorage";
import { uploadEncryptedCommentImage } from "@/utils/commentImage";
import { prepareEncryptedDmAudio, uploadPreparedEncryptedDmAudio } from "@/utils/encryptedDmAudio";
import { serializePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { scheduleAccountStateSync } from "@/services/accountStateSync";
import { useNotificationsStore } from "@/stores/notifications";
import { accountBadgeCount, syncAppBadge } from "@/utils/appBadge";
import { registerDirectMessageStateOwner } from "@/services/directMessageStateEvents";

type MessageCursor = { lastReadCreatedAt: number; lastReadMessageId: string };
export type PeerReceiptState = {
  delivered?: DmReceiptCursor;
  read?: DmReceiptCursor;
};
export type DmDraft = {
  text: string;
  replyTo?: string;
  updatedAt: number;
};
export type DmSearchResult = {
  id: string;
  createdAt: number;
  senderPubkey: string;
  preview: string;
};
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
function receiptStateKey(peerPubkey: string) { return `dm-receipt:${peerPubkey}`; }
function sentReceiptStateKey(peerPubkey: string) { return `dm-receipt-sent:${peerPubkey}`; }
function draftKey(peerPubkey: string) { return `dm-draft:${peerPubkey.toLowerCase()}`; }
const DRAFT_PREFIX = "dm-draft:";
const activeOutgoingTasks = new Map<string, Promise<void>>();
const taskPreviewUrls = new Map<string, string>();
const pendingReceiptCursors = new Map<string, DmReceiptCursor>();
const receiptTimers = new Map<string, ReturnType<typeof setTimeout>>();
let resumeListenersInstalled = false;

function taskKey(accountPubkey: string, localId: string) { return `${accountPubkey}:${localId}`; }
function receiptQueueKey(accountPubkey: string, peerPubkey: string, status: DmReceiptStatus) {
  return `${accountPubkey}:${peerPubkey}:${status}`;
}
function clearReceiptTimers() {
  for (const timer of receiptTimers.values()) clearTimeout(timer);
  receiptTimers.clear();
  pendingReceiptCursors.clear();
}
function mergeReceiptCursor(current: DmReceiptCursor | undefined, next: DmReceiptCursor) {
  return receiptCursorAfter(next, current) ? next : current;
}
function readReceiptsEnabledForAccount(accountPubkey: string) {
  const account = accountPubkey.toLowerCase();
  const settings = useSettingsStore();
  if (settings.loadedFor === account) return settings.settings.privacy.readReceipts;
  try {
    const raw = deviceStorage.getItem(`nostr_settings_${account}`);
    if (!raw) return true;
    return JSON.parse(raw)?.settings?.privacy?.readReceipts !== false;
  } catch {
    return true;
  }
}
export function receiptStatusForMessage(
  message: Pick<InboxItem, "id" | "created_at">,
  state?: PeerReceiptState,
): "sent" | "delivered" | "read" {
  if (cursorCovers(state?.read, message)) return "read";
  if (cursorCovers(state?.delivered, message)) return "delivered";
  return "sent";
}
function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase();
}
function recordInboxItem(record: Awaited<ReturnType<typeof syncedMessageRepository.listConversation>>[number]): InboxItem {
  return {
    id: record.id,
    pubkey: record.senderPubkey,
    recipientPubkeys: record.recipientPubkeys,
    created_at: record.createdAt,
    content: record.plaintext || "",
    conversationId: record.conversationId,
    replyTo: record.replyTo,
    rootId: record.rootId,
    protocol: "nip17",
    transportKind: record.transportKind,
    rumorId: record.rumorId,
    tags: record.tags || [],
  };
}
function persistenceError(error: unknown) {
  const wrapped = new Error(error instanceof Error ? error.message : "indexeddb write failed") as Error & { phase: string };
  wrapped.phase = "persist_failed";
  return wrapped;
}
function mergeTaskVersions(left: OutgoingDmTaskRecord, right: OutgoingDmTaskRecord) {
  if (left.state === "sent" && right.state !== "sent") return left;
  if (right.state === "sent" && left.state !== "sent") return right;
  return right.updatedAt > left.updatedAt ? right : left;
}
function normalizeTaskForQueue(task: OutgoingDmTaskRecord, queueState?: "pending" | "sending" | "waiting_network" | "failed" | "sent") {
  if (task.state === "sent" || queueState === "sent") return { ...task, state: "sent" as const, lastError: undefined };
  if (queueState === "failed") return { ...task, state: "send_failed" as const };
  if (queueState === "pending" || queueState === "sending" || queueState === "waiting_network") {
    return { ...task, state: "sending" as const, lastError: undefined };
  }
  if ((task.uploadedRef || task.outgoingId) && task.state === "upload_failed") {
    return { ...task, state: "send_failed" as const };
  }
  return task;
}
function createLocalId() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}
export function taskContent(task: OutgoingDmTaskRecord) {
  if (task.mediaType === "audio" && task.uploadedRef) {
    return serializePrivateAudioMessage({
      encryptedRef: task.uploadedRef,
      mime: task.audioMime || "",
      duration: task.audioDuration || 0,
      size: task.audioSize || 0,
    });
  }
  return `${task.text}${task.text && task.uploadedRef ? "\n" : ""}${task.uploadedRef ? `![](${task.uploadedRef})` : ""}`;
}
function taskInboxItem(task: OutgoingDmTaskRecord): InboxItem {
  return {
    id: `local:${task.localId}`,
    pubkey: task.accountPubkey,
    recipientPubkeys: [task.peerPubkey],
    created_at: task.createdAt,
    content: taskContent(task),
    conversationId: `local:${task.peerPubkey}`,
    replyTo: task.replyTo,
    protocol: "nip17",
    transportKind: 1059,
    tags: [["t", DIRECT_MESSAGE_TYPE]],
    outgoing: {
      localId: task.localId,
      state: task.state,
      imagePreviewUrl: task.state === "sent" ? undefined : taskPreviewUrls.get(taskKey(task.accountPubkey, task.localId)),
      audioPreviewUrl: task.mediaType === "audio" && task.state !== "sent" ? taskPreviewUrls.get(taskKey(task.accountPubkey, task.localId)) : undefined,
      audioMime: task.audioMime,
      audioDuration: task.audioDuration,
      audioSize: task.audioSize,
      hasImage: task.mediaType !== "audio" && (!!task.imageName || !!task.imageBytes || !!task.preparedImage || !!task.uploadedRef),
      hasAudio: task.mediaType === "audio",
      lastError: task.lastError,
    },
  };
}
export function matchOutgoingTasksToCanonical(
  canonical: InboxItem[],
  tasks: OutgoingDmTaskRecord[],
  accountPubkey: string,
) {
  const taskByMessageId = new Map<string, OutgoingDmTaskRecord>();
  const matchedLocalIds = new Set<string>();
  const canonicalIds = new Set(canonical.map(item => item.id));

  for (const task of tasks) {
    const exactId = task.canonicalMessageId || task.outgoingId;
    if (!exactId || !canonicalIds.has(exactId)) continue;
    matchedLocalIds.add(task.localId);
    if (!taskByMessageId.has(exactId)) taskByMessageId.set(exactId, task);
  }

  const unmatchedTasks = tasks
    .filter(task => !matchedLocalIds.has(task.localId))
    .sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
  for (const message of canonical) {
    if (message.pubkey !== accountPubkey || !isDirectMessageTags(message.tags) || taskByMessageId.has(message.id)) continue;
    const peer = directMessagePeer({ senderPubkey: message.pubkey, recipientPubkeys: message.recipientPubkeys || [] }, accountPubkey);
    const matchIndex = unmatchedTasks.findIndex(task => task.peerPubkey === peer
      && task.createdAt === message.created_at
      && task.replyTo === message.replyTo
      && taskContent(task) === message.content);
    if (matchIndex < 0) continue;
    const [task] = unmatchedTasks.splice(matchIndex, 1);
    matchedLocalIds.add(task.localId);
    taskByMessageId.set(message.id, task);
  }
  return { taskByMessageId, matchedLocalIds };
}
function canonicalInboxItem(result: PublishedMessage): InboxItem {
  return {
    id: result.message.id, pubkey: result.message.senderPubkey, created_at: result.message.createdAt,
    content: result.message.plaintext || "", protocol: "nip17", transportKind: result.message.transportKind,
    rumorId: result.message.rumorId, recipientPubkeys: result.message.recipientPubkeys,
    conversationId: result.message.conversationId, replyTo: result.message.replyTo,
    rootId: result.message.rootId, tags: result.message.tags,
  };
}
function ensureResumeListeners() {
  if (resumeListenersInstalled || typeof window === "undefined" || typeof document === "undefined") return;
  const resume = () => {
    if (document.visibilityState === "hidden") return;
    void useDirectMessagesStore().resumePending(true);
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", resume);
  resumeListenersInstalled = true;
}
function cursor(createdAt?: number, messageId?: string) {
  return createdAt === undefined ? undefined : { lastReadCreatedAt: createdAt, lastReadMessageId: messageId || "" };
}
function afterCursor(item: InboxItem, createdAt?: number, messageId?: string) {
  return isMessageAfter({ id: item.id, createdAt: item.created_at }, cursor(createdAt, messageId));
}

export function isAuthorizedDirectMessage(
  item: Pick<InboxItem, "pubkey" | "created_at">,
  accountPubkey: string,
  friendship?: FriendshipRecord,
) {
  if (item.pubkey === accountPubkey) return true;
  return isFriendshipAcceptedAt(friendship, item.created_at);
}

export function isAuthorizedCanonicalDirectMessage(
  message: { senderPubkey: string; createdAt: number },
  accountPubkey: string,
  friendship?: FriendshipRecord,
) {
  return isAuthorizedDirectMessage(
    { pubkey: message.senderPubkey, created_at: message.createdAt },
    accountPubkey,
    friendship,
  );
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
  const friendshipByPeer = options.friendshipRecords
    ? new Map(options.friendshipRecords.map(record => [record.peerPubkey.toLowerCase(), record]))
    : undefined;
  for (const item of items) {
    if (!isDirectMessageTags(item.tags)) continue;
    const peer = directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, accountPubkey);
    if (!peer || options.preferencesByPeer?.[peer]?.hidden) continue;
    const friendship = friendshipByPeer?.get(peer);
    if (friendshipByPeer && friendship?.state !== "accepted") continue;
    if (friendshipByPeer && !isAuthorizedDirectMessage(item, accountPubkey, friendship)) continue;
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
    unreadHydratingFor: "",
    readCursors: {} as Record<string, MessageCursor | undefined>,
    persistedReadCursors: {} as Record<string, MessageCursor | undefined>,
    preferencesByPeer: {} as Record<string, ConversationPreference | undefined>,
    receiptStateByPeer: {} as Record<string, PeerReceiptState | undefined>,
    sentReceiptStateByPeer: {} as Record<string, PeerReceiptState | undefined>,
    draftsByPeer: {} as Record<string, DmDraft | undefined>,
    outgoingTasks: [] as OutgoingDmTaskRecord[],
  }),
  getters: {
    unreadCount: state => Object.values(state.unreadByConversation).reduce((sum, value) => sum + value, 0),
  },
  actions: {
    peerMessages(peerPubkey: string) {
      const account = this.loadedFor;
      const friendships = useFriendshipsStore();
      const canonical = directMessagesForPeer(useMessagesStore().inbox, account, peerPubkey, {
        friendship: friendships.getRecord(peerPubkey),
        preference: this.preferencesByPeer[peerPubkey.toLowerCase()],
        enforceAuthorization: true,
      });
      const matches = matchOutgoingTasksToCanonical(canonical, this.outgoingTasks, account);
      const outgoing = this.outgoingTasks
        .filter(task => task.peerPubkey === peerPubkey.toLowerCase() && !matches.matchedLocalIds.has(task.localId))
        .map(taskInboxItem);
      return [...canonical.map(item => {
        const task = matches.taskByMessageId.get(item.id);
        return task ? { ...item, outgoing: taskInboxItem(task).outgoing } : item;
      }), ...outgoing].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    },
    conversationItems() {
      const canonical = useMessagesStore().inbox;
      const matches = matchOutgoingTasksToCanonical(canonical, this.outgoingTasks, this.loadedFor);
      return [...canonical, ...this.outgoingTasks
        .filter(task => !matches.matchedLocalIds.has(task.localId))
        .map(taskInboxItem)];
    },
    async loadDraft(peerPubkey: string, accountPubkey?: string) {
      const account = (accountPubkey || this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !peer) return undefined;
      const stored = (await metaRepository.get(account, draftKey(peer)).catch(() => undefined))?.value as DmDraft | undefined;
      if ((this.loadedFor || useKeyStore().pkHex.toLowerCase()) === account) {
        this.draftsByPeer = { ...this.draftsByPeer, [peer]: stored };
      }
      return stored;
    },
    async saveDraft(peerPubkey: string, value: Pick<DmDraft, "text" | "replyTo">, accountPubkey?: string) {
      const account = (accountPubkey || this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !peer) return;
      const text = value.text || "";
      const replyTo = value.replyTo && /^[0-9a-f]{64}$/i.test(value.replyTo) ? value.replyTo : undefined;
      if (!text && !replyTo) return this.clearDraft(peer, account);
      const draft: DmDraft = { text, ...(replyTo ? { replyTo } : {}), updatedAt: Date.now() };
      await metaRepository.put(account, draftKey(peer), draft);
      if ((this.loadedFor || useKeyStore().pkHex.toLowerCase()) === account) {
        this.draftsByPeer = { ...this.draftsByPeer, [peer]: draft };
      }
      return draft;
    },
    async clearDraft(peerPubkey: string, accountPubkey?: string) {
      const account = (accountPubkey || this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !peer) return;
      await metaRepository.delete(account, draftKey(peer));
      if ((this.loadedFor || useKeyStore().pkHex.toLowerCase()) === account) {
        const next = { ...this.draftsByPeer };
        delete next[peer];
        this.draftsByPeer = next;
      }
    },
    async clearDraftThrough(peerPubkey: string, updatedAt: number, accountPubkey?: string) {
      const account = (accountPubkey || this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !peer) return;
      const current = (await metaRepository.get(account, draftKey(peer)).catch(() => undefined))?.value as DmDraft | undefined;
      if (!current || current.updatedAt > updatedAt) return;
      await this.clearDraft(peer, account);
    },
    async searchPeerMessages(peerPubkey: string, query: string): Promise<DmSearchResult[]> {
      const account = (this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      const needle = normalizeSearchText(query.trim());
      if (!account || !peer || !needle) return [];
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      const conversationId = await deriveConversationId([account, peer]);
      const records = await syncedMessageRepository.listConversation(account, conversationId);
      const preference = this.preferencesByPeer[peer];
      const byId = new Map<string, InboxItem>();
      for (const item of records.map(recordInboxItem)) byId.set(item.id, item);
      for (const item of this.peerMessages(peer)) byId.set(item.id, item);
      return [...byId.values()]
        .filter(item => isDirectMessageTags(item.tags)
          && directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account) === peer
          && isAuthorizedDirectMessage(item, account, friendships.getRecord(peer))
          && afterDeletion(item, preference))
        .map(item => ({ item, preview: directMessagePreview(item.content) }))
        .filter(({ preview }) => !!preview && !["[图片]", "[语音]"].includes(preview) && normalizeSearchText(preview).includes(needle))
        .map(({ item, preview }) => ({ id: item.id, createdAt: item.created_at, senderPubkey: item.pubkey, preview }))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    },
    async loadPeerHistoryPage(peerPubkey: string, before?: {createdAt:number;id:string}) {
      const account = this.loadedFor || useKeyStore().pkHex;
      const peer = peerPubkey.toLowerCase();
      const conversation = await deriveConversationId([account,peer]);
      const records = await syncedMessageRepository.listConversationPage(account,conversation,before,50);
      if (useKeyStore().pkHex !== account) return {items:[] as InboxItem[],cursor:before,exhausted:true};
      const friendships = useFriendshipsStore();
      const items = records.map(recordInboxItem).filter(item => isDirectMessageTags(item.tags)
        && isAuthorizedDirectMessage(item,account,friendships.getRecord(peer))
        && afterDeletion(item,this.preferencesByPeer[peer]));
      const last=records[0];
      return {items,cursor:last ? {createdAt:last.createdAt,id:last.id} : before,exhausted:records.length<50};
    },
    async loadPeerMessageContext(peerPubkey: string, messageId: string, radius = 20) {
      const account = (this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !peer || !messageId) return [] as InboxItem[];
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      const conversationId = await deriveConversationId([account, peer]);
      const records = await syncedMessageRepository.listConversationAround(account, conversationId, messageId, radius);
      return records
        .map(recordInboxItem)
        .filter(item => isDirectMessageTags(item.tags)
          && directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account) === peer
          && isAuthorizedDirectMessage(item, account, friendships.getRecord(peer))
          && afterDeletion(item, this.preferencesByPeer[peer]))
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    },
    outgoingReceiptStatus(peerPubkey: string, message: Pick<InboxItem, "id" | "created_at" | "pubkey">) {
      const account = this.loadedFor || useKeyStore().pkHex.toLowerCase();
      if (!account || message.pubkey !== account) return null;
      const state = this.receiptStateByPeer[peerPubkey.toLowerCase()];
      if (!readReceiptsEnabledForAccount(account)) {
        return receiptStatusForMessage(message, state ? { ...state, read: undefined } : state);
      }
      return receiptStatusForMessage(message, state);
    },
    async persistReceiptState(peerPubkey: string, state: PeerReceiptState, sent = false) {
      const account = this.loadedFor || useKeyStore().pkHex.toLowerCase();
      if (!account || useKeyStore().pkHex.toLowerCase() !== account) return;
      await metaRepository.put(account, sent ? sentReceiptStateKey(peerPubkey) : receiptStateKey(peerPubkey), state);
    },
    async processReceipt(message: CanonicalMessage) {
      const account = (this.loadedFor || useKeyStore().pkHex).toLowerCase();
      if (!account || message.senderPubkey.toLowerCase() === account) return false;
      const receipt = decodeDmReceipt(message);
      if (!receipt) return false;
      const peer = message.senderPubkey.toLowerCase();
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      if (!friendships.isAccepted(peer) || useKeyStore().pkHex.toLowerCase() !== account) return false;
      if (receipt.status === "read" && !readReceiptsEnabledForAccount(account)) return false;

      let current = this.receiptStateByPeer[peer];
      if (!current) {
        current = (await metaRepository.get(account, receiptStateKey(peer)).catch(() => undefined))?.value as PeerReceiptState | undefined;
      }
      current = current || {};
      const next: PeerReceiptState = { ...current };
      let changed = false;
      if (receipt.status === "delivered" && receiptCursorAfter(receipt.upTo, current.delivered)) {
        next.delivered = receipt.upTo;
        changed = true;
      }
      if (receipt.status === "read" && receiptCursorAfter(receipt.upTo, current.read)) {
        next.read = receipt.upTo;
        next.delivered = mergeReceiptCursor(current.delivered, receipt.upTo);
        changed = true;
      }
      if (!changed) return false;
      this.receiptStateByPeer = { ...this.receiptStateByPeer, [peer]: next };
      await this.persistReceiptState(peer, next);
      return true;
    },
    scheduleReceipt(peerPubkey: string, status: DmReceiptStatus, upTo: DmReceiptCursor) {
      const account = (this.loadedFor || useKeyStore().pkHex).toLowerCase();
      const peer = peerPubkey.toLowerCase();
      if (!account || !peer || peer === account || !/^[0-9a-f]{64}$/i.test(upTo.messageId)) return;
      if (status === "read" && !readReceiptsEnabledForAccount(account)) return;
      const sent = this.sentReceiptStateByPeer[peer]?.[status];
      if (!receiptCursorAfter(upTo, sent)) return;
      const key = receiptQueueKey(account, peer, status);
      const pending = pendingReceiptCursors.get(key);
      if (!pending || receiptCursorAfter(upTo, pending)) pendingReceiptCursors.set(key, upTo);
      if (receiptTimers.has(key)) return;
      const timer = setTimeout(() => {
        receiptTimers.delete(key);
        void this.flushReceipt(account, peer, status, key);
      }, 500);
      receiptTimers.set(key, timer);
    },
    async flushReceipt(accountPubkey: string, peerPubkey: string, status: DmReceiptStatus, queueKey?: string) {
      const account = accountPubkey.toLowerCase();
      const peer = peerPubkey.toLowerCase();
      const key = queueKey || receiptQueueKey(account, peer, status);
      const upTo = pendingReceiptCursors.get(key);
      pendingReceiptCursors.delete(key);
      if (!upTo || !account || useKeyStore().pkHex.toLowerCase() !== account || this.loadedFor !== account) return;
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      if (!friendships.isAccepted(peer)) return;
      if (status === "read" && !readReceiptsEnabledForAccount(account)) return;
      const keys = useKeyStore();
      if (!keys.supportsNip44) return;

      const sent = this.sentReceiptStateByPeer[peer]?.[status];
      if (!receiptCursorAfter(upTo, sent)) return;
      try {
        await sendDirectMessage({
          recipientPubkeys: [peer],
          content: serializeDmReceipt(status, upTo),
          tags: dmReceiptTags(status),
          relays: getRelaysFromStorage("write"),
          context: {
            senderPubkey: account,
            nip44Encrypt: keys.nip44Encrypt.bind(keys),
            signEvent: keys.signEvent.bind(keys),
          },
        });
        if (useKeyStore().pkHex.toLowerCase() !== account || this.loadedFor !== account) return;
        const current = this.sentReceiptStateByPeer[peer] || {};
        const next: PeerReceiptState = { ...current, [status]: mergeReceiptCursor(current[status], upTo) };
        if (status === "read") next.delivered = mergeReceiptCursor(current.delivered, upTo);
        this.sentReceiptStateByPeer = { ...this.sentReceiptStateByPeer, [peer]: next };
        await this.persistReceiptState(peer, next, true);
      } catch (error) {
        console.warn("[dm] receipt send failed", error instanceof Error ? error.message : "unknown error");
      }
    },
    async acknowledgePersistedIncoming(accountPubkey: string, message: CanonicalMessage) {
      const account = accountPubkey.toLowerCase();
      if (!account || useKeyStore().pkHex.toLowerCase() !== account || message.senderPubkey.toLowerCase() === account) return;
      if (!isDirectMessageTags(message.tags) || !/^[0-9a-f]{64}$/i.test(message.id)) return;
      const peer = message.senderPubkey.toLowerCase();
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== account) await friendships.load(account);
      if (!friendships.isAccepted(peer)) return;
      if (this.loadedFor !== account) await this.refresh(account);
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      this.scheduleReceipt(peer, "delivered", { createdAt: message.createdAt, messageId: message.id });
    },
    async reconcileDurableUnread(conversationId?: string) {
      const account = this.loadedFor;
      if (!account) return;
      const messages = useMessagesStore();
      const friendships = useFriendshipsStore();
      const cursors = this.readCursors;
      const preferences = this.preferencesByPeer;
      const records = friendships.records;
      // listRecent() always materializes the latest direct message for every
      // durable conversation, so these IDs cover the complete DM set even when
      // the normal recent-message window is bounded.
      const durableConversationIds = [...new Set(messages.inbox
        .filter(item => isDirectMessageTags(item.tags))
        .map(item => item.conversationId)
        .filter((value): value is string => !!value))];
      const ids = conversationId ? [conversationId] : durableConversationIds;
      const counts = await Promise.all(ids.map(async id => {
        const item = messages.inbox.find(message => message.conversationId === id && isDirectMessageTags(message.tags));
        const peer = item && directMessagePeer({
          senderPubkey: item.pubkey,
          recipientPubkeys: item.recipientPubkeys || [],
        }, account);
        if (!peer || !friendships.isAccepted(peer) || preferences[peer]?.hidden) return [id, 0] as const;
        const friendship = friendships.getRecord(peer);
        const preference = preferences[peer];
        const read = cursors[id];
        const policy = JSON.stringify([friendship, preference, read]);
        const count = await syncedMessageRepository.getVisibleUnreadCount(account, id, policy, read, message => {
          const candidate = recordInboxItem(message);
          return afterDeletion(candidate, preference)
            && isAuthorizedDirectMessage(candidate, account, friendship);
        });
        return [id, count] as const;
      }));
      if (this.loadedFor !== account || this.readCursors !== cursors || this.preferencesByPeer !== preferences
        || friendships.records !== records) return;
      // There is exactly one source of truth for unread: durable, de-duplicated
      // messages after the persisted read cursor. Never merge a provisional
      // in-memory count into a full reconciliation.
      const next = conversationId ? { ...this.unreadByConversation } : {} as Record<string, number>;
      for (const [id, count] of counts) next[id] = count;
      this.unreadByConversation = next;
    },
    async ensurePeerState(account: string, peer: string, conversationId?: string) {
      const needsPreference = !Object.prototype.hasOwnProperty.call(this.preferencesByPeer, peer);
      const needsCursor = !!conversationId && !Object.prototype.hasOwnProperty.call(this.readCursors, conversationId);
      if (!needsPreference && !needsCursor) return;
      const [preferenceRecord, cursorValues] = await Promise.all([
        needsPreference ? metaRepository.get(account, preferenceKey(peer)).catch(() => undefined) : Promise.resolve(undefined),
        needsCursor && conversationId ? Promise.all([
          metaRepository.get(account, readKey(conversationId)).catch(() => undefined),
          typeof syncedMessageRepository.getReadState === "function" && typeof indexedDB !== "undefined"
            ? syncedMessageRepository.getReadState(account, conversationId).catch(() => undefined)
            : Promise.resolve(undefined),
        ]) : Promise.resolve(undefined),
      ]);
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      if (needsPreference) {
        this.preferencesByPeer = { ...this.preferencesByPeer, [peer]: preferenceRecord?.value as ConversationPreference | undefined };
      }
      if (needsCursor && conversationId && cursorValues) {
        const [localRecord, synced] = cursorValues;
        const local = localRecord?.value as MessageCursor | undefined;
        const remote = synced?.lastReadCreatedAt === undefined ? undefined : {
          lastReadCreatedAt: synced.lastReadCreatedAt,
          lastReadMessageId: synced.lastReadMessageId || "",
        };
        const read = !local || (remote && isMessageAfter({ id: remote.lastReadMessageId, createdAt: remote.lastReadCreatedAt }, local)) ? remote : local;
        this.readCursors = { ...this.readCursors, [conversationId]: read };
      }
    },
    async unhideForNewCanonicalMessages(account: string, peer: string) {
      const preference = this.preferencesByPeer[peer];
      if (!preference?.hidden) return;
      const authorized = directMessagesForPeer(useMessagesStore().inbox, account, peer, {
        friendship: useFriendshipsStore().getRecord(peer),
        preference,
        enforceAuthorization: true,
      });
      const newer = authorized.some(item => afterCursor(item, preference.hiddenThroughCreatedAt, preference.hiddenThroughMessageId)
        && (preference.hiddenMode === "deleted" || item.pubkey !== account));
      if (!newer) return;
      const visiblePreference = { ...preference, hidden: false };
      this.preferencesByPeer = { ...this.preferencesByPeer, [peer]: visiblePreference };
      try {
        await metaRepository.put(account, preferenceKey(peer), visiblePreference);
      } catch (error) {
        console.warn("[dm] conversation visibility persistence failed", error instanceof Error ? error.message : "unknown error");
      }
    },
    async relinkOutgoingTask(account: string, item: InboxItem) {
      const task = matchOutgoingTasksToCanonical([item], this.outgoingTasks, account).taskByMessageId.get(item.id);
      if (!task || (task.outgoingId === item.id && task.canonicalMessageId === item.id)) return;
      const updatedAt = Date.now();
      const index = this.outgoingTasks.findIndex(current => current.accountPubkey === account && current.localId === task.localId);
      if (index >= 0) {
        this.outgoingTasks.splice(index, 1, { ...this.outgoingTasks[index], outgoingId: item.id, canonicalMessageId: item.id, updatedAt });
      }
      try {
        await outgoingDmTaskRepository.update(account, task.localId, {
          outgoingId: item.id,
          canonicalMessageId: item.id,
          updatedAt,
        });
      } catch (error) {
        console.warn("[dm] outgoing task relink persistence failed", error instanceof Error ? error.message : "unknown error");
      }
    },
    async applyCanonicalMessage(accountPubkey: string, item: InboxItem) {
      const account = accountPubkey.toLowerCase();
      if (!account || this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account || !isDirectMessageTags(item.tags)) return;
      const peer = directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account);
      if (!peer) return;
      await this.ensurePeerState(account, peer, item.conversationId);
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      await this.unhideForNewCanonicalMessages(account, peer);
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      // During initial Relay history hydration, keep the login badge frozen.
      // The final count is reconciled once from durable history against the
      // restored read cursor when startup catch-up reaches live state.
      if (item.conversationId && this.unreadHydratingFor !== account) {
        await this.reconcileDurableUnread(item.conversationId);
      }
      await this.relinkOutgoingTask(account, item);
    },
    async reconcileAuthorization(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (!account || this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      for (const peer of Object.keys(this.preferencesByPeer)) {
        await this.unhideForNewCanonicalMessages(account, peer);
        if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      }
      await this.reconcileDurableUnread();
    },
    beginUnreadHydration(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (!account || this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      this.unreadHydratingFor = account;
    },
    async finishUnreadHydration(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (!account || this.unreadHydratingFor !== account) return;
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) {
        this.unreadHydratingFor = "";
        return;
      }
      await this.reconcileDurableUnread();
      if (this.loadedFor === account && useKeyStore().pkHex.toLowerCase() === account) {
        this.unreadHydratingFor = "";
      }
    },
    claimDerivedStateOwnership() {
      registerDirectMessageStateOwner({
        canonicalMessageAdded: (account, item) => {
          void this.applyCanonicalMessage(account, item).catch(error => console.warn("[dm] incremental message update failed", error));
        },
        authorizationChanged: account => {
          void this.reconcileAuthorization(account).catch(error => console.warn("[dm] authorization update failed", error));
        },
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
      let outgoingTasks = await outgoingDmTaskRepository.list(account);
      if (useKeyStore().pkHex !== account) return;
      const outgoingMatches = matchOutgoingTasksToCanonical(messages.inbox, outgoingTasks, account);
      for (const [messageId, task] of outgoingMatches.taskByMessageId) {
        if (task.outgoingId === messageId && task.canonicalMessageId === messageId) continue;
        task.outgoingId = messageId;
        task.canonicalMessageId = messageId;
        await outgoingDmTaskRepository.update(account, task.localId, {
          outgoingId: messageId,
          canonicalMessageId: messageId,
          updatedAt: Date.now(),
        });
      }
      outgoingTasks = await Promise.all(outgoingTasks.map(async task => {
        const queued = task.outgoingId ? await outgoingQueueRepository.get(account, task.outgoingId) : undefined;
        const normalized = normalizeTaskForQueue(task, queued?.state);
        if (normalized.state !== task.state || normalized.lastError !== task.lastError) {
          const updatedAt = Date.now();
          await outgoingDmTaskRepository.update(account, task.localId, {
            state: normalized.state,
            lastError: normalized.lastError,
            updatedAt,
          });
          return { ...normalized, updatedAt };
        }
        return normalized;
      }));
      if (useKeyStore().pkHex !== account) return;
      const mergedById = new Map(outgoingTasks.map(task => [task.localId, task]));
      for (const current of this.outgoingTasks.filter(task => task.accountPubkey === account)) {
        const loaded = mergedById.get(current.localId);
        mergedById.set(current.localId, loaded ? mergeTaskVersions(loaded, current) : current);
      }
      outgoingTasks = [...mergedById.values()];
      this.outgoingTasks = outgoingTasks.sort((a, b) => a.createdAt - b.createdAt || a.localId.localeCompare(b.localId));
      for (const task of outgoingTasks) {
        const key = taskKey(account, task.localId);
        const previewBytes = task.preparedImage?.previewBytes || task.imageBytes;
        if (previewBytes && !taskPreviewUrls.has(key) && typeof URL?.createObjectURL === "function") {
          taskPreviewUrls.set(key, URL.createObjectURL(new Blob([previewBytes], { type: task.imageType || task.preparedImage?.mime || "image/jpeg" })));
        }
      }
      const direct = messages.inbox.filter(item => isDirectMessageTags(item.tags));
      const peers = [...new Set([
        ...direct.map(item => directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account)).filter(Boolean),
        ...outgoingTasks.map(task => task.peerPubkey),
      ])] as string[];
      const draftRecords = await metaRepository.listPrefix(account, DRAFT_PREFIX);
      const drafts = Object.fromEntries(draftRecords.flatMap(record => {
        const peer = record.key.slice(DRAFT_PREFIX.length).toLowerCase();
        const value = record.value as DmDraft | undefined;
        return peer && value && (value.text || value.replyTo) ? [[peer, value] as const] : [];
      }));
      const draftPeers = Object.keys(drafts);
      for (const peer of draftPeers) if (!peers.includes(peer)) peers.push(peer);

      const [preferenceEntries, receiptEntries, sentReceiptEntries] = await Promise.all([
        Promise.all(peers.map(async peer => {
          const record = await metaRepository.get(account, preferenceKey(peer));
          return [peer, record?.value as ConversationPreference | undefined] as const;
        })),
        Promise.all(peers.map(async peer => {
          const record = await metaRepository.get(account, receiptStateKey(peer));
          return [peer, record?.value as PeerReceiptState | undefined] as const;
        })),
        Promise.all(peers.map(async peer => {
          const record = await metaRepository.get(account, sentReceiptStateKey(peer));
          return [peer, record?.value as PeerReceiptState | undefined] as const;
        })),
      ]);
      const preferences = Object.fromEntries(preferenceEntries) as Record<string, ConversationPreference | undefined>;
      const receiptStates = Object.fromEntries(receiptEntries) as Record<string, PeerReceiptState | undefined>;
      const sentReceiptStates = Object.fromEntries(sentReceiptEntries) as Record<string, PeerReceiptState | undefined>;
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
        const [record, synced] = await Promise.all([
          metaRepository.get(account, readKey(conversationId)),
          typeof syncedMessageRepository.getReadState === "function" && typeof indexedDB !== "undefined"
            ? syncedMessageRepository.getReadState(account, conversationId)
            : Promise.resolve(undefined),
        ]);
        const local = record?.value as MessageCursor | undefined;
        const remote = synced?.lastReadCreatedAt === undefined ? undefined : {
          lastReadCreatedAt: synced.lastReadCreatedAt,
          lastReadMessageId: synced.lastReadMessageId || "",
        };
        return [conversationId, !local || (remote && isMessageAfter({ id: remote.lastReadMessageId, createdAt: remote.lastReadCreatedAt }, local)) ? remote : local] as const;
      }));
      if (useKeyStore().pkHex !== account) return;
      this.preferencesByPeer = preferences;
      this.receiptStateByPeer = receiptStates;
      this.sentReceiptStateByPeer = sentReceiptStates;
      this.draftsByPeer = drafts;
      // A foreground read may complete while this refresh awaits storage or
      // account restoration. Merge at commit time so its newer cursor survives.
      const restoredCursors = Object.fromEntries(cursors);
      if (this.loadedFor === account) {
        for (const [id, current] of Object.entries(this.readCursors)) {
          if (current && isMessageAfter({ id: current.lastReadMessageId, createdAt: current.lastReadCreatedAt }, restoredCursors[id])) {
            restoredCursors[id] = current;
          }
        }
      }
      this.loadedFor = account;
      this.readCursors = restoredCursors;
      // Do not publish a provisional count derived from the bounded memory
      // window. Login/refresh waits for the durable unread result so the UI
      // cannot bounce between two different algorithms.
      this.unreadByConversation = {};
      await this.reconcileDurableUnread();
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      this.claimDerivedStateOwnership();
      ensureResumeListeners();
      void this.resumePending(false);
    },
    async markPeerRead(peerPubkey: string, readThrough?: InboxItem) {
      return this.markPeerReadInternal(peerPubkey, true, readThrough);
    },
    async markPeerReadInternal(peerPubkey: string, emitReceipt: boolean, readThrough?: InboxItem) {
      const account = useKeyStore().pkHex.toLowerCase();
      if (!account) return;
      if (this.loadedFor !== account) await this.refresh(account);
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      const peer = peerPubkey.toLowerCase();
      const items = this.peerMessages(peer);
      // The chat has its own paged history, independent of the bounded home
      // cache. Persist only a canonical position actually stored for this
      // conversation. A "sent" optimistic task still uses local:* ids until the
      // Relay echo is matched, so it must never become a durable read cursor.
      const readable = (item: InboxItem) => (!item.outgoing || item.outgoing.state === "sent")
        && !item.id.startsWith("local:")
        && !item.conversationId?.startsWith("local:");
      const requestedReadThrough = readThrough
        ? directMessagesForPeer([readThrough], account, peer, {
          friendship: useFriendshipsStore().getRecord(peer),
          preference: this.preferencesByPeer[peer],
          enforceAuthorization: true,
        }).filter(readable).at(-1)
        : undefined;
      // If the UI tail is an optimistic sent task, fall back to the newest
      // canonical message instead of returning without persisting the real read
      // position. This is what makes the cursor survive lock/login cycles.
      const latest = requestedReadThrough || items.filter(readable).at(-1);
      if (!latest?.conversationId) return;
      const conversationId = latest.conversationId;
      const previous = this.readCursors[conversationId];
      const candidate = { lastReadCreatedAt: latest.created_at, lastReadMessageId: latest.id };
      const advanced = isMessageAfter({ id: candidate.lastReadMessageId, createdAt: candidate.lastReadCreatedAt }, previous);

      // A new device can restore a read cursor that is newer than the subset of
      // Relay history currently available locally. Never rewind that cursor to
      // the newest message merely present on this device, otherwise later
      // backfill is incorrectly counted as unread again.
      const read = advanced || !previous ? candidate : previous;
      const persisted = this.persistedReadCursors[conversationId];
      // Scroll events at the bottom can fire repeatedly. Once both writes have
      // succeeded, the same position needs no more writes or account sync.
      if (persisted && !isMessageAfter({ id: read.lastReadMessageId, createdAt: read.lastReadCreatedAt }, persisted)
        && !this.unreadByConversation[conversationId]) return;

      // Foreground read state owns the icon badge. Update memory immediately so
      // a previously delivered Push badge cannot linger while IndexedDB/D1 work
      // is still pending.
      this.readCursors = { ...this.readCursors, [conversationId]: read };
      this.unreadByConversation = { ...this.unreadByConversation, [conversationId]: 0 };
      if (typeof navigator !== "undefined") {
        const notifications = useNotificationsStore();
        void syncAppBadge(accountBadgeCount(
          account,
          notifications.loadedFor,
          notifications.unreadCount,
          this.loadedFor,
          this.unreadCount,
        ), undefined, account).catch(() => undefined);
      }

      // Persist even when the in-memory cursor did not advance. This self-heals
      // a device whose first persistence attempt failed after memory was already
      // updated, and keeps the durable cursor monotonic.
      let durableReady = typeof indexedDB === "undefined";
      if (typeof indexedDB !== "undefined") {
        try {
          await syncedMessageRepository.advanceReadState(account, conversationId, read);
          durableReady = true;
        } catch (error) {
          console.warn("[dm] durable read-state persistence failed", error instanceof Error ? error.message : "unknown error");
        }
      }
      let mirrorReady = false;
      try {
        await metaRepository.put(account, readKey(conversationId), read);
        mirrorReady = true;
      } catch (error) {
        console.warn("[dm] read-state mirror persistence failed", error instanceof Error ? error.message : "unknown error");
      }
      if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      if (durableReady && mirrorReady) {
        const saved = this.persistedReadCursors[conversationId];
        if (!saved || isMessageAfter({ id: read.lastReadMessageId, createdAt: read.lastReadCreatedAt }, saved)) {
          this.persistedReadCursors = { ...this.persistedReadCursors, [conversationId]: read };
        }
      }
      if (durableReady) scheduleAccountStateSync(useKeyStore(), "read_state");

      // Receipts acknowledge only peer messages, even if the local read position
      // advanced through our own later message.
      const latestIncoming = [...items, ...(readThrough ? [readThrough] : [])]
        .filter(item => item.pubkey !== account && readable(item)
          && item.conversationId === conversationId
          && !isMessageAfter({ id: item.id, createdAt: item.created_at }, candidate))
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).at(-1);
      if (emitReceipt && latestIncoming && /^[0-9a-f]{64}$/i.test(latestIncoming.id)
        && isMessageAfter({ id: latestIncoming.id, createdAt: latestIncoming.created_at }, previous)) {
        this.scheduleReceipt(peer, "read", {
          createdAt: latestIncoming.created_at,
          messageId: latestIncoming.id,
        });
      }
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
      await this.markPeerReadInternal(peer, false);
    },
    async deleteConversation(peerPubkey: string) {
      const peer = peerPubkey.toLowerCase();
      const items = this.peerMessages(peer);
      const latest = items.at(-1);
      const existing = this.preferencesByPeer[peer];
      const cutoffMessageId = latest?.outgoing ? "\uffff" : latest?.id;
      const preference: ConversationPreference = {
        ...existing,
        hidden: true,
        hiddenMode: "deleted",
        hiddenThroughCreatedAt: latest?.created_at ?? existing?.hiddenThroughCreatedAt,
        hiddenThroughMessageId: cutoffMessageId ?? existing?.hiddenThroughMessageId,
        deletedThroughCreatedAt: latest?.created_at ?? existing?.deletedThroughCreatedAt,
        deletedThroughMessageId: cutoffMessageId ?? existing?.deletedThroughMessageId,
      };
      await metaRepository.put(this.loadedFor, preferenceKey(peer), preference);
      this.preferencesByPeer = { ...this.preferencesByPeer, [peer]: preference };
      for (const item of items) if (item.conversationId) this.unreadByConversation[item.conversationId] = 0;
      await this.markPeerReadInternal(peer, false);
    },
    send(peerPubkey: string, content: string, image?: File, replyTo?: string) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      const peer = peerPubkey.trim().toLowerCase();
      const friendships = useFriendshipsStore();
      if (!canStartDirectMessage(account, peer, friendships.isAccepted)) throw new Error(peer === account ? "无法向自己发送私信" : "只能向已接受的好友发送私信");
      const text = content.trim();
      if (!text && !image) throw new Error("消息不能为空");
      const now = Date.now();
      const task: OutgoingDmTaskRecord = {
        accountPubkey: account,
        localId: createLocalId(),
        peerPubkey: peer,
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(image ? { imageName: image.name, imageType: image.type } : {}),
        state: image ? "uploading" : "sending",
        createdAt: Math.floor(now / 1000),
        updatedAt: now,
      };
      if (image && typeof URL?.createObjectURL === "function") {
        taskPreviewUrls.set(taskKey(account, task.localId), URL.createObjectURL(image));
      }
      this.outgoingTasks = [...this.outgoingTasks, task];
      void (async () => {
        let durableTask = task;
        if (image) {
          try {
            const imageBytes = await image.arrayBuffer();
            durableTask = { ...task, imageBytes, updatedAt: Date.now() };
            const index = this.outgoingTasks.findIndex(item => item.localId === task.localId && item.accountPubkey === account);
            if (index >= 0) this.outgoingTasks.splice(index, 1, durableTask);
          } catch (error) {
            await this.failTask(task.localId, "upload_failed", error);
            return;
          }
        }
        try {
          await outgoingDmTaskRepository.put(durableTask);
        } catch (error) {
          const index = this.outgoingTasks.findIndex(item => item.localId === task.localId && item.accountPubkey === account);
          if (index >= 0) {
            this.outgoingTasks.splice(index, 1, {
              ...this.outgoingTasks[index],
              state: "send_failed",
              lastError: `persist_failed: ${error instanceof Error ? error.message : "indexeddb write failed"}`,
              updatedAt: Date.now(),
            });
          }
          return;
        }
        void this.clearDraftThrough(peer, now, account)
          .catch(error => console.warn("[dm] draft cleanup failed", error instanceof Error ? error.message : "unknown error"));
        void this.runTask(task.localId);
      })();
      return task.localId;
    },
    sendAudio(peerPubkey: string, recording: { blob: Blob; mime: string; duration: number; size: number }, replyTo?: string) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      const peer = peerPubkey.trim().toLowerCase();
      const friendships = useFriendshipsStore();
      if (!canStartDirectMessage(account, peer, friendships.isAccepted)) throw new Error(peer === account ? "无法向自己发送私信" : "只能向已接受的好友发送私信");
      if (!recording.blob.size || !recording.mime.startsWith("audio/") || recording.duration <= 0 || recording.duration > 300) {
        throw new Error("语音消息无效");
      }
      const now = Date.now();
      const task: OutgoingDmTaskRecord = {
        accountPubkey: account,
        localId: createLocalId(),
        peerPubkey: peer,
        text: "",
        ...(replyTo ? { replyTo } : {}),
        mediaType: "audio",
        audioMime: recording.mime,
        audioDuration: recording.duration,
        audioSize: recording.blob.size,
        state: "uploading",
        createdAt: Math.floor(now / 1000),
        updatedAt: now,
      };
      if (typeof URL?.createObjectURL === "function") {
        taskPreviewUrls.set(taskKey(account, task.localId), URL.createObjectURL(recording.blob));
      }
      this.outgoingTasks = [...this.outgoingTasks, task];
      void (async () => {
        try {
          await outgoingDmTaskRepository.put(task);
          void this.clearDraftThrough(peer, now, account)
            .catch(error => console.warn("[dm] draft cleanup failed", error instanceof Error ? error.message : "unknown error"));
          const preparedAudio = await prepareEncryptedDmAudio(recording.blob, recording.duration);
          const updated = { ...task, preparedAudio, updatedAt: Date.now() };
          await outgoingDmTaskRepository.put(updated);
          if (useKeyStore().pkHex !== account || this.loadedFor !== account) return;
          const index = this.outgoingTasks.findIndex(item => item.accountPubkey === account && item.localId === task.localId);
          if (index >= 0) this.outgoingTasks.splice(index, 1, updated);
          void this.runTask(task.localId);
        } catch (error) {
          if (useKeyStore().pkHex === account && this.loadedFor === account) await this.failTask(task.localId, "upload_failed", error);
          else await outgoingDmTaskRepository.update(account, task.localId, {
            state: "upload_failed",
            lastError: `prepare_failed: ${error instanceof Error ? error.message : "录音加密失败"}`,
            updatedAt: Date.now(),
          });
        }
      })();
      return task.localId;
    },
    async patchTask(localId: string, patch: Partial<OutgoingDmTaskRecord>) {
      const account = this.loadedFor || useKeyStore().pkHex.toLowerCase();
      const index = this.outgoingTasks.findIndex(task => task.accountPubkey === account && task.localId === localId);
      if (index < 0) return;
      const current = this.outgoingTasks[index];
      const combined = { ...current, ...patch };
      const protectedPatch = { ...patch };
      if (current.state === "sent") {
        protectedPatch.state = "sent";
        protectedPatch.lastError = undefined;
      } else if (protectedPatch.state === "upload_failed" && (combined.uploadedRef || combined.outgoingId)) {
        protectedPatch.state = "send_failed";
      }
      const updated = { ...current, ...protectedPatch, updatedAt: Date.now() };
      this.outgoingTasks.splice(index, 1, updated);
      try {
        await outgoingDmTaskRepository.update(account, localId, { ...protectedPatch, updatedAt: updated.updatedAt });
      } catch (error) {
        throw persistenceError(error);
      }
      return updated;
    },
    async failTask(localId: string, state: "upload_failed" | "send_failed", error: unknown) {
      const account = this.loadedFor || useKeyStore().pkHex.toLowerCase();
      const task = this.outgoingTasks.find(item => item.accountPubkey === account && item.localId === localId);
      const finalState = state === "upload_failed" && (task?.uploadedRef || task?.outgoingId) ? "send_failed" : state;
      const phase = typeof error === "object" && error && "phase" in error && typeof error.phase === "string"
        ? error.phase
        : finalState === "send_failed" ? "relay_failed" : "prepare_failed";
      try {
        await this.patchTask(localId, {
          state: finalState,
          lastError: `${phase}: ${error instanceof Error ? error.message : finalState}`,
        });
      } catch (persistenceFailure) {
        console.warn("[dm] local task failure-state persistence failed", persistenceFailure instanceof Error ? persistenceFailure.message : "unknown error");
      }
    },
    async finishTask(task: OutgoingDmTaskRecord, result: PublishedMessage) {
      try {
        await this.patchTask(task.localId, {
          state: "sent",
          outgoingId: result.message.id,
          canonicalMessageId: result.message.id,
          imageBytes: undefined,
          imageName: undefined,
          imageType: undefined,
          preparedImage: undefined,
          preparedAudio: undefined,
          lastError: undefined,
        });
      } catch (error) {
        console.warn("[dm] local sent-state persistence failed", error instanceof Error ? error.message : "unknown error");
      }
      try {
        await syncedMessageRepository.insertMessageIfAbsent(task.accountPubkey, result.message);
      } catch (error) {
        console.warn("[dm] local synced-message persistence failed", error instanceof Error ? error.message : "unknown error");
      }
      if (useKeyStore().pkHex === task.accountPubkey) {
        try {
          useMessagesStore().addInbox(canonicalInboxItem(result));
        } catch (error) {
          console.warn("[dm] local inbox update failed", error instanceof Error ? error.message : "unknown error");
        }
      }
      const previewKey = taskKey(task.accountPubkey, task.localId);
      const previewUrl = taskPreviewUrls.get(previewKey);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      taskPreviewUrls.delete(previewKey);
    },
    async runTask(localId: string) {
      const account = this.loadedFor || useKeyStore().pkHex.toLowerCase();
      const key = taskKey(account, localId);
      const running = activeOutgoingTasks.get(key);
      if (running) return running;
      const work = (async () => {
        let task = this.outgoingTasks.find(item => item.accountPubkey === account && item.localId === localId)
          || await outgoingDmTaskRepository.get(account, localId);
        if (!task || task.state === "sent" || useKeyStore().pkHex !== account) return;
        if (task.imageName && !task.imageBytes && !task.preparedImage && !task.uploadedRef && !task.outgoingId) return;
        if (task.mediaType === "audio" && !task.preparedAudio && !task.uploadedRef && !task.outgoingId) return;
        const friendships = useFriendshipsStore();
        if (friendships.loadedFor !== account) await friendships.load(account);
        if (!friendships.isAccepted(task.peerPubkey)) {
          await this.failTask(localId, "send_failed", new Error("好友关系已变更"));
          return;
        }
        try {
          let persisted: OutgoingDmTaskRecord | undefined;
          try {
            persisted = await outgoingDmTaskRepository.get(account, localId);
            if (!persisted) await outgoingDmTaskRepository.put(task);
          } catch (error) {
            throw persistenceError(error);
          }
          if (task.imageBytes && !task.uploadedRef) {
            task = (await this.patchTask(localId, { state: "uploading", lastError: undefined })) || task;
            const imageBytes = task.imageBytes;
            if (!imageBytes) throw new Error("待上传图片不存在");
            const image = new File([imageBytes], task.imageName || "image.jpg", { type: task.imageType || "image/jpeg" });
            const media = await uploadEncryptedCommentImage(image, {
              accountPubkey: account,
              signEvent: useKeyStore().signEvent.bind(useKeyStore()),
              prepared: task.preparedImage,
              onPrepared: async preparedImage => {
                task = (await this.patchTask(localId, { preparedImage })) || task;
              },
            });
            task = (await this.patchTask(localId, { uploadedRef: media.ref, state: "sending", lastError: undefined })) || task;
          } else if (task.mediaType === "audio" && task.preparedAudio && !task.uploadedRef) {
            task = (await this.patchTask(localId, { state: "uploading", lastError: undefined })) || task;
            const preparedAudio = task.preparedAudio;
            if (!preparedAudio) throw new Error("待上传语音不存在");
            const media = await uploadPreparedEncryptedDmAudio(preparedAudio, {
              accountPubkey: account,
              signEvent: useKeyStore().signEvent.bind(useKeyStore()),
            });
            task = (await this.patchTask(localId, {
              uploadedRef: media.encryptedRef,
              audioMime: media.mime,
              audioDuration: media.duration,
              audioSize: media.size,
              state: "sending",
              lastError: undefined,
            })) || task;
          } else {
            task = (await this.patchTask(localId, { state: "sending", lastError: undefined })) || task;
          }
          if (useKeyStore().pkHex !== account) throw new Error("账号已切换");
          if (!friendships.isAccepted(task.peerPubkey)) throw new Error("好友关系已变更");
          const keys = useKeyStore();
          registerOutgoingPushSigner(account, keys.signEvent.bind(keys));
          const content = taskContent(task);
          const result = task.outgoingId
            ? await publishQueuedOutgoing(account, task.outgoingId, "message")
            : await sendDirectMessage({
              recipientPubkeys: [task.peerPubkey], content, createdAt: task.createdAt,
              replyTo: task.replyTo,
              tags: [["t", DIRECT_MESSAGE_TYPE]], relays: getRelaysFromStorage("write"), pushCategory: "message",
              context: { senderPubkey: account, nip44Encrypt: keys.supportsNip44 ? keys.nip44Encrypt.bind(keys) : undefined, signEvent: keys.signEvent.bind(keys) },
              onQueued: async outgoingId => { await this.patchTask(localId, { outgoingId }); },
            });
          await this.finishTask(task, result);
        } catch (error) {
          const current = this.outgoingTasks.find(item => item.accountPubkey === account && item.localId === localId) || task;
          const phase = typeof error === "object" && error && "phase" in error ? String(error.phase) : "";
          await this.failTask(localId, phase === "persist_failed"
            ? "send_failed"
            : (current.imageBytes || current.preparedAudio) && !current.uploadedRef && !current.outgoingId ? "upload_failed" : "send_failed", error);
        }
      })().finally(() => activeOutgoingTasks.delete(key));
      activeOutgoingTasks.set(key, work);
      return work;
    },
    async retry(localId: string) {
      return this.runTask(localId);
    },
    async resumePending(includeFailed = false) {
      const account = useKeyStore().pkHex.toLowerCase();
      if (!account || this.loadedFor !== account) return;
      const tasks = [...this.outgoingTasks];
      for (const task of tasks) {
        if (task.outgoingId) {
          const queued = await outgoingQueueRepository.get(account, task.outgoingId);
          if (queued?.state === "sent") {
            await this.finishTask(task, {
              message: queued.message as PublishedMessage["message"],
              events: queued.events as PublishedMessage["events"],
              relayResults: (queued.relayResults || []) as PublishedMessage["relayResults"],
            });
            continue;
          }
          const normalized = normalizeTaskForQueue(task, queued?.state);
          if (normalized.state !== task.state || normalized.lastError !== task.lastError) {
            await this.patchTask(task.localId, { state: normalized.state, lastError: normalized.lastError });
            task.state = normalized.state;
            task.lastError = normalized.lastError;
          }
        }
        const resumableFailure = task.state === "send_failed"
          && ((!task.imageBytes && !task.preparedAudio) || !!task.outgoingId || !!task.uploadedRef || task.lastError?.startsWith("persist_failed:"));
        if (["uploading", "sending"].includes(task.state) || (includeFailed && resumableFailure)) {
          void this.runTask(task.localId);
        }
      }
    },
    reset() {
      for (const task of this.outgoingTasks) {
        const key = taskKey(task.accountPubkey, task.localId);
        const url = taskPreviewUrls.get(key);
        if (url) URL.revokeObjectURL(url);
        taskPreviewUrls.delete(key);
      }
      this.loadedFor = "";
      this.unreadByConversation = {};
      this.unreadHydratingFor = "";
      this.readCursors = {};
      this.persistedReadCursors = {};
      this.preferencesByPeer = {};
      this.receiptStateByPeer = {};
      this.sentReceiptStateByPeer = {};
      this.draftsByPeer = {};
      clearReceiptTimers();
      this.outgoingTasks = [];
    },
  },
});
