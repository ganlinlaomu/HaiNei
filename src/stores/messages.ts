import { defineStore } from "pinia";
import { useKeyStore } from "./keys";

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

let inboxSaveTimer: ReturnType<typeof setTimeout> | null = null;
let outboxSaveTimer: ReturnType<typeof setTimeout> | null = null;

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

      // load inbox
      try {
        const ik = inboxKeyFor(targetPk);
        if (ik) {
          const rawI = localStorage.getItem(ik);
          const stored = rawI ? JSON.parse(rawI) : [];
          const compatible = Array.isArray(stored) ? stored
            .filter((item: InboxItem) => item.protocol === "nip17" && item.transportKind === 1059) : [];
          this.inbox = compatible
            .map((item: InboxItem) => ({
              ...item,
              transportEventId: item.transportEventId ?? item.id
            }));
          if (Array.isArray(stored) && compatible.length !== stored.length) this.saveInbox();
        } else {
          this.inbox = [];
        }
      } catch {
        this.inbox = [];
      }

      // load outbox
      try {
        const ok = outboxKeyFor(targetPk);
        if (ok) {
          const rawO = localStorage.getItem(ok);
          this.outbox = rawO ? JSON.parse(rawO) : [];
        } else {
          this.outbox = [];
        }
      } catch {
        this.outbox = [];
      }
    },

    saveInbox() {
      if (inboxSaveTimer) {
        clearTimeout(inboxSaveTimer);
        inboxSaveTimer = null;
      }
      const key = inboxKeyFor(this.loadedFor || "");
      if (!key) return;
      try { localStorage.setItem(key, JSON.stringify(this.inbox)); } catch {}
    },

    saveOutbox() {
      if (outboxSaveTimer) {
        clearTimeout(outboxSaveTimer);
        outboxSaveTimer = null;
      }
      const key = outboxKeyFor(this.loadedFor || "");
      if (!key) return;
      try { localStorage.setItem(key, JSON.stringify(this.outbox)); } catch {}
    },

    scheduleInboxSave() {
      if (inboxSaveTimer) return;
      inboxSaveTimer = setTimeout(() => this.saveInbox(), 150);
    },

    scheduleOutboxSave() {
      if (outboxSaveTimer) return;
      outboxSaveTimer = setTimeout(() => this.saveOutbox(), 150);
    },

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
      if (removeFromStorage) {
        if (inboxSaveTimer) clearTimeout(inboxSaveTimer);
        if (outboxSaveTimer) clearTimeout(outboxSaveTimer);
        inboxSaveTimer = null;
        outboxSaveTimer = null;
      } else {
        this.saveInbox();
        this.saveOutbox();
      }
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
