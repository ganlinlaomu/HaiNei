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

function toRecord(accountPubkey: string, message: CanonicalMessage, nowMs: number): SyncedMessageRecord {
  return {
    accountPubkey,
    id: message.id,
    senderPubkey: message.senderPubkey.toLowerCase(),
    recipientPubkeys: message.recipientPubkeys.map(value => value.toLowerCase()),
    conversationId: message.conversationId || message.id,
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
  private pending = new Map<string, {
    account: string;
    message: CanonicalMessage;
    nowMs: number;
    resolve: (result: InsertMessageResult) => void;
    reject: (error: unknown) => void;
  }[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushScheduled = false;

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
        this.database.messageSyncStates,
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
      this.database.messageSyncStates,
      async () => {
        const key: [string, string] = [account, message.id];
        const existing = await this.database.syncedMessages.get(key);
        if (existing) {
          const transportEventIds = [...new Set([...existing.transportEventIds, ...incoming.transportEventIds])];
          await this.database.syncedMessages.update(key, { transportEventIds, lastSeenAt: nowMs });
          return { inserted: false, record: { ...existing, transportEventIds, lastSeenAt: nowMs } };
        }

        await this.database.syncedMessages.add(incoming);
        const conversationKey: [string, string] = [account, incoming.conversationId];
        const current = await this.database.conversationStates.get(conversationKey);
        if (!current || incoming.createdAt > current.lastMessageAt ||
          (incoming.createdAt === current.lastMessageAt && incoming.id.localeCompare(current.lastMessageId) > 0)) {
          await this.database.conversationStates.put({
            accountPubkey: account,
            conversationId: incoming.conversationId,
            lastMessageId: incoming.id,
            lastMessageAt: incoming.createdAt,
            lastMessageSenderPubkey: incoming.senderPubkey,
            updatedAt: nowMs
          });
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

  async list(accountPubkey: string, limit?: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    const query = this.database.syncedMessages
      .where("[accountPubkey+createdAt]")
      .between([account, Dexie.minKey], [account, Dexie.maxKey]);
    return (limit === undefined ? query : query.limit(limit)).toArray();
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

  async listConversation(accountPubkey: string, conversationId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    return this.database.syncedMessages
      .where("[accountPubkey+conversationId+createdAt]")
      .between([account, conversationId, Dexie.minKey], [account, conversationId, Dexie.maxKey])
      .toArray();
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

  async markRead(accountPubkey: string, conversationId: string, message?: SyncedMessageRecord) {
    const account = normalizeAccountPubkey(accountPubkey);
    const messages = message ? [message] : await this.listConversation(account, conversationId);
    const latestIncoming = messages
      .filter(item => item.senderPubkey !== account)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .at(-1);
    if (!latestIncoming) return;
    const current = await this.getReadState(account, conversationId);
    if (!isMessageAfter({ id: latestIncoming.id, createdAt: latestIncoming.createdAt }, current)) return;
    await this.database.conversationReadStates.put({
      accountPubkey: account,
      conversationId,
      lastReadMessageId: latestIncoming.id,
      lastReadCreatedAt: latestIncoming.createdAt,
      updatedAt: Date.now()
    });
  }

  async seedReadState(accountPubkey: string, conversationId: string, createdAt: number) {
    const account = normalizeAccountPubkey(accountPubkey);
    const current = await this.getReadState(account, conversationId);
    if (current || !createdAt) return;
    const seed: ConversationReadStateRecord = { accountPubkey: account, conversationId, lastReadCreatedAt: createdAt, updatedAt: Date.now() };
    await this.database.conversationReadStates.put(seed);
  }

  async getUnreadCount(accountPubkey: string, conversationId: string) {
    const account = normalizeAccountPubkey(accountPubkey);
    const [messages, cursor] = await Promise.all([
      this.listConversation(account, conversationId),
      this.getReadState(account, conversationId)
    ]);
    return messages.filter(message => message.senderPubkey !== account && isMessageAfter({ id: message.id, createdAt: message.createdAt }, cursor)).length;
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
