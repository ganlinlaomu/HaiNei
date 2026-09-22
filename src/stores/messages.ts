import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

export type InboxItem = {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  protocol?: "nip17";
  transportKind?: number;
  transportEventId?: string;
  rumorId?: string;
  recipientPubkeys?: string[];
  conversationId?: string;
  replyTo?: string;
  rootId?: string;
  _localMeta?: {
    groupCount: number;
    groups: Array<{ name: string; count: number }>;
  };
};

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

function isHomeControl(tags: string[][] | undefined) {
  const values = new Set((tags || []).map(tag => `${tag[0]}:${tag[1]}`));
  return values.has("l:hainei-friendship")
    || values.has("l:hainei-interaction")
    || values.has("t:hainei-profile")
    || values.has("t:hainei-profile-request")
    || values.has("t:hainei-tombstone");
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
    loadedFor: "" as string
  }),
  actions: {
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

      // One-time, account-scoped import of the old localStorage mirror.
      try {
        const ik = inboxKeyFor(targetPk);
        if (ik) {
          const rawI = localStorage.getItem(ik);
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
          if (rawI) localStorage.removeItem(ik);
        }
      } catch {
        // Leave the legacy key intact so a later load can retry safely.
      }
      const records = await syncedMessageRepository.list(targetPk);
      if (this.loadedFor !== targetPk) return;
      this.inbox = records.filter(record => !isHomeControl(record.tags)).map(record => ({
        id: record.id,
        pubkey: record.senderPubkey,
        created_at: record.createdAt,
        content: record.plaintext || "",
        protocol: "nip17" as const,
        transportKind: record.transportKind,
        transportEventId: record.transportEventIds[0],
        rumorId: record.rumorId,
        recipientPubkeys: record.recipientPubkeys,
        conversationId: record.conversationId,
        replyTo: record.replyTo,
        rootId: record.rootId
      })).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const outgoing = await outgoingQueueRepository.list(targetPk);
      if (this.loadedFor !== targetPk) return;
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

    addInbox(item: InboxItem) {
      if (!item || !item.id) return;
      
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
          this.scheduleInboxSave();
        }
        // All other cases: keep existing as-is
        return;
      }
      
      // Add new message
      this.inbox.unshift(item);
      // keep bounded history
      if (this.inbox.length > 1000) this.inbox.splice(1000);
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
      if (removeFromStorage) {
        try { if (ik) localStorage.removeItem(ik); } catch {}
        try { if (ok) localStorage.removeItem(ok); } catch {}
      }
    },

    // debug: list stored pks that have inbox/outbox saved
    storedPks(): string[] {
      try {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
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
