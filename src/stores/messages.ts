import { defineStore } from "pinia";
import { deviceStorage } from "@/services/deviceStorage";
import { useKeyStore } from "./keys";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { isExpiredDisappearing } from "@/nostr/messaging/disappearingMessages";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { notifyCanonicalMessageAdded } from "@/services/directMessageStateEvents";
import { isConversationMessage } from "@/nostr/messaging/messageRouting";
import {
  isHomeControl,
  syncedMessageRecordToInboxItem,
  type InboxItem,
} from "@/nostr/messaging/messageViewModel";

export { isHomeControl };
export type { InboxItem };

export type InboxMutation = {
  revision: number;
  type: "replace" | "insert" | "update" | "reset";
  itemId?: string;
  evictedId?: string;
  /** The inserted item, even when it fell outside the bounded window. */
  item?: InboxItem;
};

const MAX_INBOX_ITEMS = 1000;

/** Inbox order is newest-first; ties keep the same id order as load(). */
function inboxInsertIndex(inbox: InboxItem[], item: InboxItem) {
  let low = 0;
  let high = inbox.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const current = inbox[middle];
    const before = current.created_at > item.created_at
      || (current.created_at === item.created_at && current.id.localeCompare(item.id) < 0);
    if (before) low = middle + 1;
    else high = middle;
  }
  return low;
}

export type OutboxItem = {
  id: string;
  created_at: number;
  sent_at: number;
  content: string;
  relayResults: Array<{ relay: string; ok: boolean; reason?: any; ts?: number }>;
};

function inboxKeyFor(pk: string | null | undefined) {
  if (!pk) return null;
  return `nostr_inbox_${pk}`;
}
function outboxKeyFor(pk: string | null | undefined) {
  if (!pk) return null;
  return `nostr_outbox_${pk}`;
}

function optimisticOutgoingState(state: "pending" | "sending" | "waiting_network" | "failed" | "sent"):
  NonNullable<InboxItem["outgoing"]>["state"] {
  if (state === "failed") return "send_failed";
  if (state === "sent") return "sent";
  return "sending";
}

function legacyTags(item: InboxItem) {
  try {
    const type = JSON.parse(item.content || "")?.type;
    if (type === "hainei-profile" || type === "hainei-profile-request" || type === "hainei-tombstone") {
      return [["t", type]];
    }
    if (typeof type === "string" && type.startsWith("friend_")) {
      return [["l", "hainei-friendship"], ["t", type.slice(7)]];
    }
  } catch {}
  return [];
}

export const useMessagesStore = defineStore("messages", {
  state: () => ({
    inbox: [] as InboxItem[],
    outbox: [] as OutboxItem[],
    loadedFor: "" as string,
    inboxRevision: 0,
    lastInboxMutation: null as InboxMutation | null
  }),
  actions: {
    recordInboxMutation(type: InboxMutation["type"], itemId?: string, evictedId?: string, item?: InboxItem) {
      this.inboxRevision += 1;
      this.lastInboxMutation = { revision: this.inboxRevision, type, itemId, evictedId, ...(item ? { item } : {}) };
    },

    async load(pk?: string) {
      const ks = useKeyStore();
      const targetPk = pk ?? ks.pkHex;
      if (!targetPk) {
        this.reset(false);
        return;
      }
      if (this.loadedFor && this.loadedFor !== targetPk) {
        this.reset(false);
      }
      if (this.loadedFor === targetPk) return;
      this.loadedFor = targetPk;

      // One-time, account-scoped import of the migrated legacy mirror.
      try {
        const ik = inboxKeyFor(targetPk);
        if (ik) {
          const rawI = deviceStorage.getItem(ik);
          const stored = rawI ? JSON.parse(rawI) : [];
          const compatible = Array.isArray(stored) ? stored
            .filter((item: InboxItem) => item.protocol === "nip17" && item.transportKind === 1059) : [];
          for (const item of compatible) {
            const message: CanonicalMessage = {
              id: item.id,
              senderPubkey: item.pubkey,
              recipientPubkeys: item.recipientPubkeys || [targetPk],
              conversationId: item.conversationId,
              plaintext: item.content,
              createdAt: item.created_at,
              protocol: "nip17",
              transportKind: 1059,
              transportEventId: item.transportEventId || item.id,
              rumorId: item.rumorId,
              replyTo: item.replyTo,
              rootId: item.rootId,
              tags: legacyTags(item)
            };
            await syncedMessageRepository.insertMessageIfAbsent(targetPk, message);
          }
          if (rawI) deviceStorage.removeItem(ik);
        }
      } catch {
        // Leave the legacy key intact so a later load can retry safely.
      }
      // Purge expired temporary plaintext before restoring the in-memory mirror.
      await syncedMessageRepository.purgeExpiredDisappearing(targetPk);
      const records = await syncedMessageRepository.listRecent(targetPk);
      if (this.loadedFor !== targetPk) return;
      const durableInbox: InboxItem[] = records
        .filter(record => !isHomeControl(record.tags, record.plaintext) && !isExpiredDisappearing(record.tags))
        .map(syncedMessageRecordToInboxItem);
      const outgoing = await outgoingQueueRepository.list(targetPk);
      if (this.loadedFor !== targetPk) return;
      const inboxById = new Map(durableInbox.map(item => [item.id, item]));
      const optimisticOutgoing = [
        ...outgoing.filter(item => item.state !== "sent"),
        ...outgoing.filter(item => item.state === "sent")
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 50),
      ];
      for (const item of optimisticOutgoing) {
        const message = item.message as CanonicalMessage;
        const tags = message.tags || [];
        if (message.senderPubkey.toLowerCase() !== targetPk.toLowerCase()) continue;
        if (isHomeControl(tags, message.plaintext) || isConversationMessage(message)) continue;
        const outgoingState: NonNullable<InboxItem["outgoing"]> = {
          localId: item.outgoingId,
          state: optimisticOutgoingState(item.state),
          hasImage: /!\[[^\]]*\]\(/.test(message.plaintext || ""),
          lastError: item.lastError,
        };
        const existing = inboxById.get(item.outgoingId);
        if (existing) {
          inboxById.set(item.outgoingId, { ...existing, outgoing: outgoingState });
          continue;
        }
        inboxById.set(item.outgoingId, {
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
          tags,
          outgoing: outgoingState,
        });
      }
      this.inbox = [...inboxById.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      this.recordInboxMutation("replace");
      this.outbox = outgoing.filter(item => item.state === "sent").map(item => {
        const message = item.message as CanonicalMessage;
        return {
          id: item.outgoingId,
          created_at: message.createdAt,
          sent_at: item.updatedAt,
          content: message.plaintext || "",
          relayResults: (item.relayResults || []) as OutboxItem["relayResults"]
        };
      });
    },

    saveInbox() {},

    saveOutbox() {},

    scheduleInboxSave() {},

    scheduleOutboxSave() {},

    removeInboxMessage(messageId: string) {
      const index = this.inbox.findIndex(item => item.id === messageId);
      if (index < 0) return;
      this.inbox.splice(index, 1);
      this.recordInboxMutation("replace");
    },

    addInbox(item: InboxItem) {
      if (!item || !item.id || isHomeControl(item.tags, item.content)) return;
      
      // Check if message already exists
      const existingIndex = this.inbox.findIndex((m) => m.id === item.id);
      if (existingIndex !== -1) {
        // Message already exists - handle _localMeta intelligently:
        // - If new item has _localMeta but existing doesn't: add it (relay echo arrived first)
        // - If both have _localMeta: keep existing (already correct, locally created version)
        // - If only existing has _localMeta: keep existing (preserve local metadata)
        // - If neither has _localMeta: no update needed
        const existing = this.inbox[existingIndex];
        
        if (item._localMeta && !existing._localMeta) {
          // Only case where we update: new has metadata but existing doesn't
          // Create a new object to ensure Vue reactivity
          this.inbox[existingIndex] = {
            ...existing,
            _localMeta: item._localMeta
          };
          this.recordInboxMutation("update", item.id);
          this.scheduleInboxSave();
        }
        // All other cases: keep existing as-is
        return;
      }
      
      // Insert at its sorted position and evict the OLDEST entry. Relay
      // catch-up delivers history newest-first; prepending it would push the
      // newest messages (conversation heads) out of the bounded window.
      this.inbox.splice(inboxInsertIndex(this.inbox, item), 0, item);
      const evictedId = this.inbox.length > MAX_INBOX_ITEMS ? this.inbox[MAX_INBOX_ITEMS]?.id : undefined;
      if (this.inbox.length > MAX_INBOX_ITEMS) this.inbox.splice(MAX_INBOX_ITEMS);
      this.recordInboxMutation("insert", item.id, evictedId, item);
      this.scheduleInboxSave();
      notifyCanonicalMessageAdded(this.loadedFor, item);
    },

    setPostOutgoingState(
      messageId: string,
      state: NonNullable<InboxItem["outgoing"]>["state"],
      lastError?: string,
    ) {
      const index = this.inbox.findIndex(item => item.id === messageId);
      if (index < 0) return;
      const current = this.inbox[index];
      if (!current.outgoing || isConversationMessage(current)) return;
      this.inbox[index] = {
        ...current,
        outgoing: {
          ...current.outgoing,
          state,
          lastError: state === "sent" ? undefined : lastError,
        },
      };
      this.recordInboxMutation("update", messageId);
      this.scheduleInboxSave();
    },

    addOutbox(item: OutboxItem) {
      if (!item || !item.id) return;
      this.outbox.unshift(item);
      if (this.outbox.length > 500) this.outbox.splice(500);
      this.scheduleOutboxSave();
    },

    // remove in-memory lists for current user, optionally remove persisted storage
    reset(removeFromStorage = false) {
      const pk = this.loadedFor || "";
      const ik = inboxKeyFor(pk);
      const ok = outboxKeyFor(pk);
      this.inbox = [];
      this.outbox = [];
      this.loadedFor = "";
      this.recordInboxMutation("reset");
      if (removeFromStorage) {
        try { if (ik) deviceStorage.removeItem(ik); } catch {}
        try { if (ok) deviceStorage.removeItem(ok); } catch {}
      }
    },

    // debug: list stored pks that have inbox/outbox saved
    storedPks(): string[] {
      try {
        const out: string[] = [];
        for (let i = 0; i < deviceStorage.length; i++) {
          const k = deviceStorage.key(i);
          if (!k) continue;
          if (k.startsWith("nostr_inbox_") || k.startsWith("nostr_outbox_")) {
            const pk = k.split("_").slice(2).join("_");
            if (!out.includes(pk)) out.push(pk);
          }
        }
        return out;
      } catch {
        return [];
      }
    }
  }
});
