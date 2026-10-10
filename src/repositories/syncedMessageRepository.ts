import { directMessagePeer, isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { isConversationMessage } from "@/nostr/messaging/messageRouting";
import { disappearingMetadata, hasDisappearingMarker, isExpiredDisappearing } from "@/nostr/messaging/disappearingMessages";
import Dexie from "dexie";
import {
  db,
  type ConversationReadStateRecord,
  type ConversationStateRecord,
  type HaiNeiDatabase,
  type MessageSyncStateRecord,
  type RelaySyncStateRecord,
  type SyncedMessageRecord
} from "@/db/dexie";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { normalizeAccountPubkey } from "@/repositories/accountScope";
import { isMessageAfter } from "@/nostr/messaging/sync/sorting";
import { MAX_FUTURE_SKEW_SECONDS, type SyncStatus } from "@/nostr/messaging/sync/types";
import { performanceCounters } from "@/services/nostrCache";

export type InsertMessageResult = { inserted: boolean; record: SyncedMessageRecord };
export type AdvanceReadStateResult = { advanced: boolean; state: ConversationReadStateRecord };

const burnKey = (messageId: string) => `dm-burn:${messageId.toLowerCase()}`;
const openedKey = (messageId: string) => `dm-open:${messageId.toLowerCase()}`;
export type OpenedDmState = { messageId: string; peerPubkey: string; deadlineAt: number };

export const LEGACY_DM_READ_STATE_MIGRATION_VERSION = 1;
export const LEGACY_DM_READ_PREFIX = "dm-read:";
export const legacyDmReadStateMigrationMetaKey = (
  version = LEGACY_DM_READ_STATE_MIGRATION_VERSION,
) => `migration:legacy-dm-read-state-v${version}`;

export const UNSUPPORTED_MESSAGE_CLEANUP_VERSION = 1;
export const unsupportedMessageCleanupMetaKey = (version = UNSUPPORTED_MESSAGE_CLEANUP_VERSION) =>
  `message-maintenance:unsupported-nip17-v${version}`;

export type MessageCleanupMigrationResult = {
  ran: boolean;
  purged: number;
  version: number;
};


function toRecord(accountPubkey: string, message: CanonicalMessage, nowMs: number): SyncedMessageRecord {
  return {
    accountPubkey,
    id: message.id,
    senderPubkey: message.senderPubkey.toLowerCase(),
    recipientPubkeys: message.recipientPubkeys.map(value => value.toLowerCase()),
    conversationId: message.conversationId || message.id,
    messageClass: isConversationMessage(message) ? "direct" : "other",
    plaintext: message.plaintext,
    ciphertext: message.ciphertext,
    createdAt: message.createdAt,
    protocol: message.protocol,
    transportKind: message.transportKind,
    transportEventIds: message.transportEventId ? [message.transportEventId] : [],
    rumorId: message.rumorId,
    replyTo: message.replyTo,
    rootId: message.rootId,
    tags: message.tags,
    firstSeenAt: nowMs,
    lastSeenAt: nowMs
  };
}

export class SyncedMessageRepository {
  private visiblePolicies = new Map<string, { policy: string; test: (message: SyncedMessageRecord) => boolean }>();
  private pending = new Map<string, {
    account: string;
    message: CanonicalMessage;
    nowMs: number;
    resolve: (result: InsertMessageResult) => void;
    reject: (error: unknown) => void;
  }[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushScheduled = false;
  private cleanupMigrations = new Map<string, Promise<MessageCleanupMigrationResult>>();

  constructor(private readonly database: HaiNeiDatabase = db) {}

  /** Queue message persistence so the realtime UI path never waits before rendering. */
  enqueueMessage(accountPubkey: string, message: CanonicalMessage, nowMs = Date.now()): Promise<InsertMessageResult> {
    const account = normalizeAccountPubkey(accountPubkey);
    const key = `${account}:${message.id}`;
    return new Promise((resolve, reject) => {
      const waiting = this.pending.get(key) || [];
      waiting.push({ account, message, nowMs, resolve, reject });
      this.pending.set(key, waiting);
      performanceCounters.indexedDbQueueSize = this.pending.size;
      if (this.pending.size >= 50) void this.flushWriteQueue();
      else if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => void this.flushWriteQueue());
      }
    });
  }

  async flushWriteQueue() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushScheduled = false;
    if (!this.pending.size) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    performanceCounters.indexedDbQueueSize = 0;
    const completed: Array<{ waiter: (typeof batch)[number][1][number]; result: InsertMessageResult }> = [];
    try {
      // Dexie nests these operations into one physical transaction while retaining
      // the existing atomic insert/update semantics.
      await this.database.transaction(
        "rw",
        this.database.syncedMessages,
        this.database.conversationStates,
        this.database.conversationReadStates,
        this.database.messageSyncStates,
        this.database.accountMeta,
        async () => {
          for (const [, waiters] of batch) {
            let result: InsertMessageResult | undefined;
            for (const waiter of waiters) {
              result = await this.insertMessageIfAbsent(waiter.account, waiter.message, waiter.nowMs);
              completed.push({ waiter, result });
            }
          }
        }
      );
      for (const { waiter, result } of completed) waiter.resolve(result);
    } catch (error) {
      for (const [, waiters] of batch) for (const waiter of waiters) waiter.reject(error);
    }
  }

  async insertMessageIfAbsent(accountPubkey: string, message: CanonicalMessage, nowMs = Date.now()): Promise<InsertMessageResult> {
    const account = normalizeAccountPubkey(accountPubkey);
    const incoming = toRecord(account, message, nowMs);
    return this.database.transaction(
      "rw",
      this.database.syncedMessages,
      this.database.conversationStates,
        this.database.conversationReadStates,
      this.database.messageSyncStates,
      this.database.accountMeta,
      async () => {
        const key: [string, string] = [account, message.id];
        if (isExpiredDisappearing(message.tags, Math.floor(nowMs / 1000))) {
          return { inserted: false, record: incoming };
        }
        const tombstone = await this.database.accountMeta.get([account, burnKey(message.id)]);
        const peer = directMessagePeer(message, account);
        if (hasDisappearingMarker(message.tags) && isDirectMessageTags(message.tags)
          && (tombstone?.value as { peerPubkey?: string } | undefined)?.peerPubkey === peer) {
          return { inserted: false, record: incoming };
        }
        const existing = await this.database.syncedMessages.get(key);
        if (existing) {
          const transportEventIds = [...new Set([...existing.transportEventIds, ...incoming.transportEventIds])];
          await this.database.syncedMessages.update(key, { transportEventIds, lastSeenAt: nowMs });
          return { inserted: false, record: { ...existing, transportEventIds, lastSeenAt: nowMs } };
        }

        await this.database.syncedMessages.add(incoming);
        const conversationKey: [string, string] = [account, incoming.conversationId];
        const current = await this.database.conversationStates.get(conversationKey);
        const read = await this.getReadState(account,incoming.conversationId);
        const cursorKey = JSON.stringify([read?.lastReadCreatedAt || 0,read?.lastReadMessageId || ""]);
        const unread = incoming.senderPubkey !== account && isMessageAfter({id:incoming.id,createdAt:incoming.createdAt},read);
        const previousCache = current?.unreadCache?.cursor === cursorKey ? current.unreadCache : !current ? {cursor:cursorKey,count:0,directCount:0} : undefined;
        const visiblePolicy = this.visiblePolicies.get(JSON.stringify(conversationKey));
        const visibleUnreadCache = current?.visibleUnreadCache && visiblePolicy?.policy === current.visibleUnreadCache.policy
          ? { policy: visiblePolicy.policy, count: current.visibleUnreadCache.count + Number(incoming.senderPubkey !== account && isConversationMessage(incoming) && visiblePolicy.test(incoming)) }
          : undefined;
        const unreadCache = previousCache ? {...previousCache,count:previousCache.count + Number(unread),directCount:previousCache.directCount + Number(unread && isConversationMessage(incoming))} : undefined;
        if (!current || incoming.createdAt > current.lastMessageAt ||
          (incoming.createdAt === current.lastMessageAt && incoming.id.localeCompare(current.lastMessageId) > 0)) {
          await this.database.conversationStates.put({
            accountPubkey: account,
            conversationId: incoming.conversationId,
            unreadCache,
            visibleUnreadCache,
            lastMessageId: incoming.id,
            lastMessageAt: incoming.createdAt,
            lastMessageSenderPubkey: incoming.senderPubkey,
            updatedAt: nowMs
          });
        } else {
          await this.database.conversationStates.update(conversationKey,{unreadCache, visibleUnreadCache});
        }

        const nowSeconds = Math.floor(nowMs / 1000);
        if (incoming.createdAt <= nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
          const sync = await this.getSyncState(account);
          if (!sync.highWatermarkCreatedAt || incoming.createdAt > sync.highWatermarkCreatedAt) {
            await this.database.messageSyncStates.put({ ...sync, highWatermarkCreatedAt: incoming.createdAt });
          }
        }
        return { inserted: true, record: incoming };
      }
    );
  }

  /** Persistent, account-scoped tombstones prevent old relay wraps from resurrecting a burned message. */
  async isBurnedMessage(accountPubkey: string, message: CanonicalMessage) {
    if (!hasDisappearingMarker(message.tags) || !isDirectMessageTags(message.tags)) return false;
    const account = normalizeAccountPubkey(accountPubkey);
    const marker = await this.database.accountMeta.get([account, burnKey(message.id)]);
    return (marker?.value as { peerPubkey?: string } | undefined)?.peerPubkey === directMessagePeer(message, account);
  }

  /** Persist the absolute deadline *before* returning plaintext to the viewer.
   * Concurrent devices cannot reset a deadline on the same account database. */
  async openDisappearingMessage(accountPubkey: string, messageId: string, peerPubkey: string, nowMs = Date.now()) {
    const account = normalizeAccountPubkey(accountPubkey);
    const peer = peerPubkey.toLowerCase();
    return this.database.transaction("rw", [this.database.syncedMessages, this.database.accountMeta], async () => {
      const target = await this.database.syncedMessages.get([account, messageId]);
      if (!target || !isDirectMessageTags(target.tags) || target.senderPubkey.toLowerCase() === account
        || directMessagePeer(target, account) !== peer) return null;
      const metadata = disappearingMetadata(target.tags);
      if (!metadata || metadata.expiresAt * 1000 <= nowMs) return null;
      if (await this.database.accountMeta.get([account, burnKey(messageId)])) return null;
      const existing = (await this.database.accountMeta.get([account, openedKey(messageId)]))?.value as OpenedDmState | undefined;
      if (existing) return existing.peerPubkey === peer ? existing.deadlineAt : null;
      const deadlineAt = Math.min(metadata.expiresAt * 1000, nowMs + metadata.burnAfterSeconds * 1000);
      await this.database.accountMeta.put({
        accountPubkey: account, key: openedKey(messageId),
        value: { messageId, peerPubkey: peer, deadlineAt } satisfies OpenedDmState,
      });
      return deadlineAt;
    });
  }

  /** An authenticated exact-read receipt can establish the sender's own
   * absolute burn deadline. Keep it durable across PWA suspension/relogin so
   * the sender does not depend solely on a later remote burn notification. */
  async recordSenderBurnDeadline(accountPubkey: string, messageId: string, peerPubkey: string, deadlineAt: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    const id = messageId.toLowerCase();
    const peer = peerPubkey.toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(peer)
      || peer === account || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) return null;
    return this.database.transaction("rw", [this.database.syncedMessages, this.database.accountMeta], async () => {
      const target = await this.database.syncedMessages.get([account, id]);
      if (!target || target.senderPubkey.toLowerCase() !== account
        || !isDirectMessageTags(target.tags) || directMessagePeer(target, account) !== peer) return null;
      const metadata = disappearingMetadata(target.tags);
      if (!metadata || deadlineAt > metadata.expiresAt * 1000) return null;
      if (await this.database.accountMeta.get([account, burnKey(id)])) return null;
      const key = openedKey(id);
      const existing = (await this.database.accountMeta.get([account, key]))?.value as OpenedDmState | undefined;
      if (existing) {
        if (existing.peerPubkey !== peer || !Number.isFinite(existing.deadlineAt)) return null;
        // Never extend or reset a previously confirmed deletion deadline.
        return existing.deadlineAt;
      }
      await this.database.accountMeta.put({
        accountPubkey: account, key,
        value: { messageId: id, peerPubkey: peer, deadlineAt } satisfies OpenedDmState,
      });
      return deadlineAt;
    });
  }

  async listOpenedDisappearing(accountPubkey: string, peerPubkey: string): Promise<OpenedDmState[]> {
    const account = normalizeAccountPubkey(accountPubkey);
    const peer = peerPubkey.toLowerCase();
    const rows = await this.database.accountMeta.where("accountPubkey").equals(account)
      .filter(record => record.key.startsWith("dm-open:")).toArray();
    return rows.map(record => record.value as OpenedDmState)
      .filter(record => record && record.peerPubkey === peer
        && /^[0-9a-f]{64}$/i.test(record.messageId) && Number.isFinite(record.deadlineAt));
  }

  async burnDisappearingMessage(accountPubkey: string, messageId: string, peerPubkey: string, nowMs = Date.now()) {
    const account = normalizeAccountPubkey(accountPubkey);
    const peer = peerPubkey.toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(messageId) || !/^[0-9a-f]{64}$/i.test(peer) || peer === account) return false;
    const id = messageId.toLowerCase();
    let accepted = false;
    await this.database.transaction("rw", [
      this.database.syncedMessages, this.database.accountMeta, this.database.decryptedEvents,
      this.database.deferredAuthorizationMessages, this.database.outgoingQueue,
      this.database.outgoingDmTasks, this.database.conversationStates,
    ], async () => {
        const target = await this.database.syncedMessages.get([account, id]);
        if (target && (!isDirectMessageTags(target.tags) || !hasDisappearingMarker(target.tags)
          || directMessagePeer(target, account) !== peer)) return;
        const marker = await this.database.accountMeta.get([account, burnKey(id)]);
        if (marker && (marker.value as { peerPubkey?: string })?.peerPubkey !== peer) return;
        await this.database.accountMeta.put({ accountPubkey: account, key: burnKey(id), value: { peerPubkey: peer, burnedAt: nowMs, ...(target ? { createdAt: target.createdAt, senderPubkey: target.senderPubkey, conversationId: target.conversationId } : {}) } });
        accepted = true;
        await this.database.accountMeta.delete([account, openedKey(id)]);
        // The optimistic-send task can contain plaintext even after the synced row is removed.
        const tasks = await this.database.outgoingDmTasks.where("accountPubkey").equals(account)
          .filter(task => task.canonicalMessageId === id || task.outgoingId === id).primaryKeys();
        if (tasks.length) await this.database.outgoingDmTasks.bulkDelete(tasks);
        if (!target) return; // burn event may arrive before the original wrap
        await this.database.syncedMessages.delete([account, id]);
        await this.database.deferredAuthorizationMessages.delete([account, id]);
        for (const transportId of target.transportEventIds || []) {
          await this.database.decryptedEvents.delete([account, transportId]);
        }
        await this.database.outgoingQueue.delete([account, id]);
        const stateKey: [string, string] = [account, target.conversationId];
        const current = await this.database.conversationStates.get(stateKey);
        if (current?.lastMessageId === id) {
          const latest = await this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt+id]")
            .between([account, target.conversationId, 0, ""], [account, target.conversationId, Number.MAX_SAFE_INTEGER, "\\uffff"])
            .reverse().first();
          if (latest) await this.database.conversationStates.put({ ...current, lastMessageId: latest.id,
            lastMessageAt: latest.createdAt, lastMessageSenderPubkey: latest.senderPubkey,
            unreadCache: undefined, visibleUnreadCache: undefined, updatedAt: nowMs });
          else await this.database.conversationStates.delete(stateKey);
        } else if (current) {
          await this.database.conversationStates.update(stateKey, { unreadCache: undefined, visibleUnreadCache: undefined });
        }
      });
    return accepted;
  }

  /** Due read deadlines are durable even when the chat view is unmounted.
   * Return only minimal identifiers; never materialize plaintext for scheduling. */
  async listDueOpenedDisappearing(accountPubkey: string, nowMs = Date.now()): Promise<OpenedDmState[]> {
    const account = normalizeAccountPubkey(accountPubkey);
    const records = await this.database.accountMeta.where("accountPubkey").equals(account)
      .filter(record => record.key.startsWith("dm-open:")).toArray();
    return records
      .map(record => record.value as OpenedDmState | undefined)
      .filter((record): record is OpenedDmState => !!record
        && /^[0-9a-f]{64}$/i.test(record.messageId)
        && /^[0-9a-f]{64}$/i.test(record.peerPubkey)
        && Number.isFinite(record.deadlineAt)
        && record.deadlineAt <= nowMs);
  }

  /** Never defer secure local deletion to the next time that particular chat
   * is opened. All expired/watched plaintext is purged on account restoration. */
  async purgeExpiredDisappearing(accountPubkey: string, nowMs = Date.now()) {
    const account = normalizeAccountPubkey(accountPubkey);
    const [expired, openedDue] = await Promise.all([
      this.database.syncedMessages.where("accountPubkey").equals(account)
        .filter(record => isExpiredDisappearing(record.tags, Math.floor(nowMs / 1000))).toArray(),
      this.listDueOpenedDisappearing(account, nowMs),
    ]);
    const toBurn = new Map<string, string>();
    for (const record of expired) {
      const peer = directMessagePeer(record, account);
      if (peer) toBurn.set(record.id, peer);
    }
    for (const record of openedDue) {
      const existing = toBurn.get(record.messageId);
      if (!existing) toBurn.set(record.messageId, record.peerPubkey);
    }
    let cleaned = 0;
    for (const [id, peer] of toBurn) {
      if (await this.burnDisappearingMessage(account, id, peer, nowMs)) cleaned++;
    }
    return cleaned;
  }

  async get(accountPubkey: string, messageId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.syncedMessages.get([account, messageId]);
  }

  async getDecryptedEvent(accountPubkey: string, eventId: string): Promise<CanonicalMessage | null> {
    const account = normalizeAccountPubkey(accountPubkey);
    const record = await this.database.decryptedEvents.get([account, eventId]);
    return (record?.message as CanonicalMessage | undefined) || null;
  }

  async putDecryptedEvent(accountPubkey: string, eventId: string, message: CanonicalMessage) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.decryptedEvents.put({ accountPubkey: account, eventId, message, decryptedAt: Date.now() });
  }

  async deleteDecryptedEvent(accountPubkey: string, eventId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.decryptedEvents.delete([account, eventId]);
  }

  async deferAuthorizationMessage(
    accountPubkey: string,
    message: CanonicalMessage,
    metadata: { source: string; relayUrl?: string },
    nowMs = Date.now(),
  ) {
    const account = normalizeAccountPubkey(accountPubkey);
    if (new TextEncoder().encode(JSON.stringify(message)).length > 65536) throw new Error("deferred_message_too_large");
    await this.database.transaction("rw", this.database.deferredAuthorizationMessages, async () => {
      const table = this.database.deferredAuthorizationMessages;
      await table.where("[accountPubkey+deferredAt]").between([account,0],[account,nowMs-7*86400000],true,true).delete();
      const existing = await table.get([account,message.id]);
      if (!existing) {
        const records = await table.where("accountPubkey").equals(account).limit(501).toArray();
        if (records.length >= 500 || records.filter(r => (r.message as CanonicalMessage).senderPubkey === message.senderPubkey).length >= 25) throw new Error("deferred_queue_full");
      }
      await table.put({
      accountPubkey: account,
      id: message.id,
      createdAt: message.createdAt,
      message,
      metadata: {
        source: metadata.source,
        ...(metadata.relayUrl ? { relayUrl: metadata.relayUrl } : {}),
      },
      deferredAt: existing?.deferredAt ?? nowMs,
    });
    });
  }

  async listDeferredAuthorizationMessages(accountPubkey: string, afterId?: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.deferredAuthorizationMessages
      .where("[accountPubkey+id]")
      .between([account, afterId || ""], [account, "\uffff"], !afterId, true)
      .limit(50)
      .toArray();
  }

  async clearDeferredAuthorizationMessage(accountPubkey: string, messageId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    await this.database.deferredAuthorizationMessages.delete([account, messageId]);
  }

  async list(accountPubkey: string, limit?: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    const query = this.database.syncedMessages
      .where("[accountPubkey+createdAt]")
      .between([account, Dexie.minKey], [account, Dexie.maxKey]);
    return (limit === undefined ? query : query.limit(limit)).toArray();
  }

  async listHistoryPage(accountPubkey: string, before?: {createdAt:number;id:string}) {
    const account=normalizeAccountPubkey(accountPubkey);
    return this.database.syncedMessages.where("[accountPubkey+createdAt+id]")
      .between([account,0,""],[account,before?.createdAt ?? Number.MAX_SAFE_INTEGER,before?.id ?? "\uffff"],true,!before)
      .reverse().limit(100).toArray();
  }
  async listBySender(accountPubkey: string, senderPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const sender = senderPubkey.toLowerCase();
    return this.database.syncedMessages
      .where("[accountPubkey+senderPubkey]")
      .equals([account, sender])
      .toArray();
  }
  // Vault-backed tag fields cannot be decrypted in a Dexie versionchange
  // transaction. Reindex after this account's key has been unlocked instead.
  async migrateMessageRoutingAfterUnlock(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const key = "migration:nip17-message-routing-v1";
    if ((await this.database.accountMeta.get([account, key]))?.value === true) return;
    await this.database.transaction(
      "rw", this.database.syncedMessages, this.database.conversationStates, this.database.accountMeta,
      async () => {
        if ((await this.database.accountMeta.get([account, key]))?.value === true) return;
        await this.database.syncedMessages.where("accountPubkey").equals(account).modify(record => {
          record.messageClass = isConversationMessage(record) ? "direct" : "other";
        });
        await this.database.conversationStates.where("accountPubkey").equals(account).modify(record => {
          delete record.unreadCache;
          delete record.visibleUnreadCache;
        });
        await this.database.accountMeta.put({
          accountPubkey: account, key, value: true,
        });
      },
    );
  }

  async listDirectConversationHeads(accountPubkey: string, conversationId?: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const conversationIds = conversationId
      ? [conversationId]
      : (await this.database.conversationStates.where("accountPubkey").equals(account).toArray())
          .map(summary => summary.conversationId);
    const latestDirect = await Promise.all(conversationIds.map(id => this.database.syncedMessages
      .where("[accountPubkey+conversationId+messageClass+createdAt+id]")
      .between([account, id, "direct", 0, ""], [account, id, "direct", Number.MAX_SAFE_INTEGER, "\uffff"])
      .reverse().first()));
    return latestDirect.filter((message): message is SyncedMessageRecord => !!message);
  }

  async listRecent(accountPubkey: string, limit = 200) {
    const account = normalizeAccountPubkey(accountPubkey);
    const recent = await this.database.syncedMessages.where("[accountPubkey+createdAt]")
      .between([account,Dexie.minKey],[account,Dexie.maxKey]).reverse().limit(limit).toArray();
    const summaries = await this.database.conversationStates.where("accountPubkey").equals(account).toArray();
    const latest = await this.database.syncedMessages.bulkGet(summaries.map(s=>[account,s.lastMessageId]));
    const latestDirect = await this.listDirectConversationHeads(account);
    return [...new Map([...recent,...latest.filter((m):m is SyncedMessageRecord=>!!m), ...latestDirect].map(m=>[m.id,m])).values()];
  }

  async purgeUnsupportedMessages(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const keys = await this.database.syncedMessages
      .where("accountPubkey")
      .equals(account)
      .filter(record => record.protocol !== "nip17" || record.transportKind !== 1059)
      .primaryKeys();
    if (keys.length === 0) return 0;
    await this.database.syncedMessages.bulkDelete(keys);
    await this.rebuildConversationState(account);
    return keys.length;
  }

  async runUnsupportedMessageCleanupMigration(
    accountPubkey: string,
    version = UNSUPPORTED_MESSAGE_CLEANUP_VERSION,
    nowMs = Date.now(),
  ): Promise<MessageCleanupMigrationResult> {
    const account = normalizeAccountPubkey(accountPubkey);
    const migrationId = `${account}:${version}`;
    const active = this.cleanupMigrations.get(migrationId);
    if (active) return active;

    const run = (async () => {
      const key = unsupportedMessageCleanupMetaKey(version);
      const completed = await this.database.accountMeta.get([account, key]);
      if (completed) return { ran: false, purged: 0, version };

      // Deliberately write the marker only after cleanup succeeds. If the app is
      // terminated during migration, the next launch retries instead of treating
      // a partial cleanup as complete.
      const purged = await this.purgeUnsupportedMessages(account);
      await this.database.accountMeta.put({
        accountPubkey: account,
        key,
        value: { version, completedAt: nowMs, purged },
      });
      return { ran: true, purged, version };
    })();

    this.cleanupMigrations.set(migrationId, run);
    try {
      return await run;
    } finally {
      if (this.cleanupMigrations.get(migrationId) === run) this.cleanupMigrations.delete(migrationId);
    }
  }

  async listConversationPage(accountPubkey: string, conversationId: string, before?: {createdAt:number;id:string}, limit = 50) {
    const account = normalizeAccountPubkey(accountPubkey);
    return (await this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt+id]")
      .between([account,conversationId,0,""],
        [account,conversationId,before?.createdAt ?? Number.MAX_SAFE_INTEGER,before?.id ?? "\uffff"],true,!before)
      .reverse().limit(Math.max(1,Math.min(limit,100))).toArray()).reverse();
  }
  async listConversation(accountPubkey: string, conversationId: string) {
    // Compatibility for explicit full-history operations (search/rebuild).
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt]")
      .between([account,conversationId,Dexie.minKey],[account,conversationId,Dexie.maxKey]).toArray();
  }

  async listConversationAround(accountPubkey: string, conversationId: string, messageId: string, radius = 20) {
    const account = normalizeAccountPubkey(accountPubkey);
    const target = await this.database.syncedMessages.get([account, messageId]);
    if (!target || target.conversationId !== conversationId) return [] as SyncedMessageRecord[];
    const index = this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt]");
    const [before, sameTimestamp, sameTimestampAfter, after] = await Promise.all([
      index
        .between([account, conversationId, Dexie.minKey], [account, conversationId, target.createdAt], true, false)
        .reverse()
        .limit(radius)
        .toArray(),
      this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt+id]")
        .between([account, conversationId, target.createdAt, ""], [account, conversationId, target.createdAt, target.id], true, true)
        .reverse().limit(radius + 1).toArray(),
      this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt+id]")
        .between([account, conversationId, target.createdAt, target.id], [account, conversationId, target.createdAt, "\uffff"], false, true)
        .limit(radius).toArray(),
      index
        .between([account, conversationId, target.createdAt], [account, conversationId, Dexie.maxKey], false, true)
        .limit(radius)
        .toArray(),
    ]);
    const byId = new Map([...before, ...sameTimestamp, ...sameTimestampAfter, ...after].map(record => [record.id, record]));
    const ordered = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const targetIndex = ordered.findIndex(record => record.id === messageId);
    if (targetIndex < 0) return [] as SyncedMessageRecord[];
    return ordered.slice(Math.max(0, targetIndex - radius), targetIndex + radius + 1);
  }

  async getSyncState(accountPubkey: string): Promise<MessageSyncStateRecord> {
    const account = normalizeAccountPubkey(accountPubkey);
    return (await this.database.messageSyncStates.get(account)) || {
      accountPubkey: account,
      status: "idle",
      relayStates: {}
    };
  }

  async updateSyncState(accountPubkey: string, patch: Partial<MessageSyncStateRecord>) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.transaction("rw", this.database.messageSyncStates, async () => {
      const current = await this.getSyncState(account);
      const next: MessageSyncStateRecord = { ...current, ...patch, accountPubkey: account };
      await this.database.messageSyncStates.put(next);
      return next;
    });
  }

  /** Commit the global completion marker and all per-relay progress in one
   * IndexedDB transaction. A crash cannot make an incomplete Relay look done. */
  async commitCatchupProgress(
    accountPubkey: string,
    patch: Partial<MessageSyncStateRecord>,
    relayPatches: Record<string, Partial<RelaySyncStateRecord>>
  ) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.transaction("rw", this.database.messageSyncStates, async () => {
      const current = await this.getSyncState(account);
      const relayStates = { ...current.relayStates };
      for (const [url, relayPatch] of Object.entries(relayPatches)) {
        relayStates[url] = { ...(relayStates[url] || { url, connected: false }), ...relayPatch, url };
      }
      const next: MessageSyncStateRecord = { ...current, ...patch, accountPubkey: account, relayStates };
      await this.database.messageSyncStates.put(next);
      return next;
    });
  }

  async advanceHighWatermark(accountPubkey: string, createdAt: number, nowMs = Date.now()) {
    const nowSeconds = Math.floor(nowMs / 1000);
    if (createdAt > nowSeconds + MAX_FUTURE_SKEW_SECONDS) return;
    const current = await this.getSyncState(accountPubkey);
    if (!current.highWatermarkCreatedAt || createdAt > current.highWatermarkCreatedAt) {
      await this.updateSyncState(accountPubkey, { highWatermarkCreatedAt: createdAt });
    }
  }

  async updateRelayState(accountPubkey: string, relayUrl: string, patch: Partial<RelaySyncStateRecord>) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.transaction("rw", this.database.messageSyncStates, async () => {
      const current = await this.getSyncState(account);
      const relay = current.relayStates[relayUrl] || { url: relayUrl, connected: false };
      const next = {
        ...current,
        relayStates: { ...current.relayStates, [relayUrl]: { ...relay, ...patch, url: relayUrl } }
      };
      await this.database.messageSyncStates.put(next);
      return next;
    });
  }

  async setStatus(accountPubkey: string, status: SyncStatus) {
    return this.updateSyncState(accountPubkey, { status });
  }

  async getReadState(accountPubkey: string, conversationId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.conversationReadStates.get([account, conversationId]);
  }

  async migrateLegacyDmReadState(
    accountPubkey: string,
    version = LEGACY_DM_READ_STATE_MIGRATION_VERSION,
    nowMs = Date.now(),
  ) {
    const account = normalizeAccountPubkey(accountPubkey);
    const markerKey = legacyDmReadStateMigrationMetaKey(version);
    const completed = await this.database.accountMeta.get([account, markerKey]);
    if (completed) return { ran: false, migrated: 0, removed: 0, version };

    return this.database.transaction(
      "rw",
      this.database.accountMeta,
      this.database.conversationReadStates,
      async () => {
        const marker = await this.database.accountMeta.get([account, markerKey]);
        if (marker) return { ran: false, migrated: 0, removed: 0, version };

        const legacy = await this.database.accountMeta
          .where("accountPubkey")
          .equals(account)
          .filter(record => record.key.startsWith(LEGACY_DM_READ_PREFIX))
          .toArray();

        let migrated = 0;
        for (const record of legacy) {
          const conversationId = record.key.slice(LEGACY_DM_READ_PREFIX.length);
          if (!conversationId) continue;
          const value = record.value as {
            lastReadCreatedAt?: unknown;
            lastReadMessageId?: unknown;
          } | undefined;
          const lastReadCreatedAt = Number(value?.lastReadCreatedAt || 0);
          const lastReadMessageId = typeof value?.lastReadMessageId === "string"
            ? value.lastReadMessageId
            : "";
          if (!Number.isFinite(lastReadCreatedAt) || lastReadCreatedAt <= 0) continue;

          const current = await this.database.conversationReadStates.get([account, conversationId]);
          if (!current || isMessageAfter(
            { id: lastReadMessageId, createdAt: lastReadCreatedAt },
            current,
          )) {
            await this.database.conversationReadStates.put({
              accountPubkey: account,
              conversationId,
              lastReadCreatedAt,
              lastReadMessageId,
              updatedAt: nowMs,
            });
            migrated += 1;
          }
        }

        if (legacy.length) {
          await this.database.accountMeta.bulkDelete(
            legacy.map(record => [account, record.key] as [string, string]),
          );
        }
        await this.database.accountMeta.put({
          accountPubkey: account,
          key: markerKey,
          value: { version, completedAt: nowMs, migrated, removed: legacy.length },
        });
        return { ran: true, migrated, removed: legacy.length, version };
      },
    );
  }

  async advanceReadStateResult(
    accountPubkey: string,
    conversationId: string,
    cursor: { lastReadCreatedAt: number; lastReadMessageId: string },
  ): Promise<AdvanceReadStateResult> {
    const account = normalizeAccountPubkey(accountPubkey);
    // The repository arbitrates monotonic cursor ownership and returns the
    // durable winner so UI state can recover from concurrent remote restores.
    return this.database.transaction("rw", this.database.conversationReadStates, async () => {
      const current = await this.database.conversationReadStates.get([account, conversationId]);
      if (current && !isMessageAfter(
        { id: cursor.lastReadMessageId, createdAt: cursor.lastReadCreatedAt },
        current,
      )) {
        return { advanced: false, state: current };
      }
      const state: ConversationReadStateRecord = {
        accountPubkey: account,
        conversationId,
        lastReadMessageId: cursor.lastReadMessageId,
        lastReadCreatedAt: cursor.lastReadCreatedAt,
        updatedAt: Date.now(),
      };
      await this.database.conversationReadStates.put(state);
      return { advanced: true, state };
    });
  }

  async advanceReadState(
    accountPubkey: string,
    conversationId: string,
    cursor: { lastReadCreatedAt: number; lastReadMessageId: string },
  ) {
    return (await this.advanceReadStateResult(accountPubkey, conversationId, cursor)).advanced;
  }

  async markRead(accountPubkey: string, conversationId: string, message?: SyncedMessageRecord) {
    const account = normalizeAccountPubkey(accountPubkey);
    const messages = message ? [message] : await this.database.syncedMessages
      .where("[accountPubkey+conversationId+createdAt+id]")
      .between([account, conversationId, 0, ""], [account, conversationId, Number.MAX_SAFE_INTEGER, "\uffff"])
      .reverse().filter(item => item.senderPubkey !== account).limit(1).toArray();
    const latestIncoming = messages
      .filter(item => item.senderPubkey !== account)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .at(-1);
    if (!latestIncoming) return false;
    return this.advanceReadState(account, conversationId, {
      lastReadCreatedAt: latestIncoming.createdAt,
      lastReadMessageId: latestIncoming.id,
    });
  }

  async seedReadState(accountPubkey: string, conversationId: string, createdAt: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    const current = await this.getReadState(account, conversationId);
    if (current || !createdAt) return;
    const seed: ConversationReadStateRecord = { accountPubkey: account, conversationId, lastReadCreatedAt: createdAt, updatedAt: Date.now() };
    await this.database.conversationReadStates.put(seed);
  }

  async getUnreadCount(accountPubkey: string, conversationId: string, directOnly = false) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.transaction("rw",this.database.syncedMessages,this.database.conversationStates,this.database.conversationReadStates,async()=>{
      const cursor = await this.getReadState(account,conversationId);
      const key:[string,string]=[account,conversationId];
      const summary=await this.database.conversationStates.get(key);
      const cursorKey=JSON.stringify([cursor?.lastReadCreatedAt || 0,cursor?.lastReadMessageId || ""]);
      if(summary?.unreadCache?.cursor === cursorKey) return directOnly ? summary.unreadCache.directCount : summary.unreadCache.count;
      let count=0,directCount=0;
      await this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt+id]")
        .between([account,conversationId,cursor?.lastReadCreatedAt || 0,cursor?.lastReadMessageId || ""],
          [account,conversationId,Number.MAX_SAFE_INTEGER,"\uffff"],false,true)
        .each(message=>{
          if(message.senderPubkey !== account && isMessageAfter({id:message.id,createdAt:message.createdAt},cursor)) {
            count++;if(isConversationMessage(message))directCount++;
          }
        });
      if(summary) await this.database.conversationStates.update(key,{unreadCache:{cursor:cursorKey,count,directCount}});
      return directOnly ? directCount : count;
    });
  }

  async getVisibleUnreadCount(accountPubkey: string, conversationId: string, policy: string,
    cursor: { lastReadCreatedAt?: number; lastReadMessageId?: string } | undefined,
    visible: (message: SyncedMessageRecord) => boolean) {
    const account = normalizeAccountPubkey(accountPubkey);
    const token = JSON.stringify([account, conversationId]);
    this.visiblePolicies.delete(token);
    this.visiblePolicies.set(token, { policy, test: message => isMessageAfter({ id: message.id, createdAt: message.createdAt }, cursor) && visible(message) });
    if (this.visiblePolicies.size > 512) this.visiblePolicies.delete(this.visiblePolicies.keys().next().value!);
    return this.database.transaction("rw", this.database.syncedMessages, this.database.conversationStates, async () => {
      const key: [string, string] = [account, conversationId];
      const summary = await this.database.conversationStates.get(key);
      if (summary?.visibleUnreadCache?.policy === policy) return summary.visibleUnreadCache.count;
      let count = 0;
      await this.database.syncedMessages.where("[accountPubkey+conversationId+createdAt+id]")
        .between([account, conversationId, cursor?.lastReadCreatedAt || 0, cursor?.lastReadMessageId || ""],
          [account, conversationId, Number.MAX_SAFE_INTEGER, "\uffff"], false, true)
        .each(message => { if (message.senderPubkey !== account && isConversationMessage(message) && visible(message)) count++; });
      if (summary) await this.database.conversationStates.update(key, { visibleUnreadCache: { policy, count } });
      return count;
    });
  }

  async getTotalUnread(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const conversations = await this.database.conversationStates.where("accountPubkey").equals(account).toArray();
    const counts = await Promise.all(conversations.map(item => this.getUnreadCount(account, item.conversationId)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  async rebuildConversationState(accountPubkey: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const messages = await this.list(account);
    const latest = new Map<string, SyncedMessageRecord>();
    for (const message of messages) {
      const current = latest.get(message.conversationId);
      if (!current || message.createdAt > current.createdAt ||
        (message.createdAt === current.createdAt && message.id.localeCompare(current.id) > 0)) {
        latest.set(message.conversationId, message);
      }
    }
    await this.database.transaction("rw", this.database.conversationStates, async () => {
      await this.database.conversationStates.where("accountPubkey").equals(account).delete();
      const now = Date.now();
      const records: ConversationStateRecord[] = [...latest.values()].map(message => ({
        accountPubkey: account,
        conversationId: message.conversationId,
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
        lastMessageSenderPubkey: message.senderPubkey,
        updatedAt: now
      }));
      if (records.length) await this.database.conversationStates.bulkPut(records);
    });
  }
}

export const syncedMessageRepository = new SyncedMessageRepository();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const flushPendingMessages = () => { void syncedMessageRepository.flushWriteQueue(); };
  window.addEventListener("pagehide", flushPendingMessages);
  window.addEventListener("beforeunload", flushPendingMessages);
}
