import { defineStore } from "pinia";
import type { FriendshipRecord, OutgoingDmTaskRecord } from "@/db/dexie";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DIRECT_MESSAGE_TYPE, canStartDirectMessage, directMessagePeer, isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { publishQueuedOutgoing, registerOutgoingPushSigner, sendDirectMessage, type PublishedMessage } from "@/nostr/messaging/service";
import { isMessageAfter } from "@/nostr/messaging/sync/sorting";
import { metaRepository } from "@/repositories/metaRepository";
import { outgoingDmTaskRepository } from "@/repositories/outgoingDmTaskRepository";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { uploadEncryptedCommentImage } from "@/utils/commentImage";
import { scheduleAccountStateSync } from "@/services/accountStateSync";
import { registerDirectMessageStateOwner } from "@/services/directMessageStateEvents";

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
const activeOutgoingTasks = new Map<string, Promise<void>>();
const taskPreviewUrls = new Map<string, string>();
let resumeListenersInstalled = false;

function taskKey(accountPubkey: string, localId: string) { return `${accountPubkey}:${localId}`; }
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
function taskContent(task: OutgoingDmTaskRecord) {
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
    protocol: "nip17",
    transportKind: 1059,
    tags: [["t", DIRECT_MESSAGE_TYPE]],
    outgoing: {
      localId: task.localId,
      state: task.state,
      imagePreviewUrl: task.state === "sent" ? undefined : taskPreviewUrls.get(taskKey(task.accountPubkey, task.localId)),
      hasImage: !!task.imageName || !!task.imageBytes || !!task.preparedImage || !!task.uploadedRef,
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
    conversationId: result.message.conversationId, tags: result.message.tags,
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
    recomputeUnreadFromMemory(conversationId?: string) {
      const account = this.loadedFor;
      if (!account) return;
      const friendships = useFriendshipsStore();
      const visible = useMessagesStore().inbox.filter(item => {
        if (!isDirectMessageTags(item.tags)) return false;
        const peer = directMessagePeer({ senderPubkey: item.pubkey, recipientPubkeys: item.recipientPubkeys || [] }, account);
        return !!peer && !this.preferencesByPeer[peer]?.hidden
          && afterDeletion(item, this.preferencesByPeer[peer])
          && isAuthorizedDirectMessage(item, account, friendships.getRecord(peer));
      });
      const ids = conversationId
        ? [conversationId]
        : [...new Set(visible.map(item => item.conversationId).filter((value): value is string => !!value))];
      const next = conversationId ? { ...this.unreadByConversation } : {} as Record<string, number>;
      for (const id of ids) {
        const conversation = visible.filter(item => item.conversationId === id);
        const peer = conversation[0] && directMessagePeer({
          senderPubkey: conversation[0].pubkey,
          recipientPubkeys: conversation[0].recipientPubkeys || [],
        }, account);
        if (!conversation.length || !peer) {
          delete next[id];
          continue;
        }
        const read = this.readCursors[id];
        next[id] = friendships.isAccepted(peer)
          ? conversation.filter(item => item.pubkey !== account && isMessageAfter({ id: item.id, createdAt: item.created_at }, read)).length
          : 0;
      }
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
      if (item.conversationId) this.recomputeUnreadFromMemory(item.conversationId);
      await this.relinkOutgoingTask(account, item);
    },
    async reconcileAuthorization(accountPubkey: string) {
      const account = accountPubkey.toLowerCase();
      if (!account || this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      for (const peer of Object.keys(this.preferencesByPeer)) {
        await this.unhideForNewCanonicalMessages(account, peer);
        if (this.loadedFor !== account || useKeyStore().pkHex.toLowerCase() !== account) return;
      }
      this.recomputeUnreadFromMemory();
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
      this.claimDerivedStateOwnership();
      ensureResumeListeners();
      void this.resumePending(false);
    },
    async markPeerRead(peerPubkey: string) {
      const account = useKeyStore().pkHex.toLowerCase();
      if (!account || this.loadedFor !== account) await this.refresh(account);
      const items = this.peerMessages(peerPubkey);
      const latestIncoming = items.filter(item => item.pubkey !== account).at(-1);
      if (!latestIncoming?.conversationId) return;
      const read = { lastReadCreatedAt: latestIncoming.created_at, lastReadMessageId: latestIncoming.id };
      await metaRepository.put(account, readKey(latestIncoming.conversationId), read);
      if (typeof syncedMessageRepository.markRead === "function" && typeof indexedDB !== "undefined") {
        await syncedMessageRepository.markRead(account, latestIncoming.conversationId);
      }
      scheduleAccountStateSync(useKeyStore(), "read_state");
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
      await this.markPeerRead(peer);
    },
    send(peerPubkey: string, content: string, image?: File) {
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
        void this.runTask(task.localId);
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
          } else {
            task = (await this.patchTask(localId, { state: "sending", lastError: undefined })) || task;
          }
          if (useKeyStore().pkHex !== account) throw new Error("账号已切换");
          const keys = useKeyStore();
          registerOutgoingPushSigner(account, keys.signEvent.bind(keys));
          const content = taskContent(task);
          const result = task.outgoingId
            ? await publishQueuedOutgoing(account, task.outgoingId, "message")
            : await sendDirectMessage({
              recipientPubkeys: [task.peerPubkey], content, createdAt: task.createdAt,
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
            : current.imageBytes && !current.uploadedRef && !current.outgoingId ? "upload_failed" : "send_failed", error);
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
          && (!task.imageBytes || !!task.outgoingId || !!task.uploadedRef || task.lastError?.startsWith("persist_failed:"));
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
      this.readCursors = {};
      this.preferencesByPeer = {};
      this.outgoingTasks = [];
    },
  },
});
