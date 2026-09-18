import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { getRelaysFromStorage } from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { useNotificationsStore } from "@/stores/notifications";
import { logger } from "@/utils/logger";
import { useFriendshipsStore } from "@/stores/friendships";

export const INTERACTION_LABEL = "hainei-interaction";

export interface Like {
  id: string;
  messageId: string;
  author: string;
  timestamp: number;
  type: "like";
}

export interface Comment {
  id: string;
  messageId: string;
  author: string;
  text: string;
  timestamp: number;
  type: "comment";
  parentCommentId?: string;
}

export type Interaction = Like | Comment;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function newInteractionId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function isInteractionMessage(message: CanonicalMessage): boolean {
  return message.protocol === "nip17" &&
    message.tags.some(tag => tag[0] === "l" && tag[1] === INTERACTION_LABEL);
}

function decodeInteractionMessage(message: CanonicalMessage): Interaction | null {
  try {
    if (!isInteractionMessage(message) || !message.plaintext) return null;
    const interaction = JSON.parse(message.plaintext) as Interaction;
    if (!interaction?.id || !interaction.messageId || !["like", "comment"].includes(interaction.type)) return null;
    if (interaction.author?.toLowerCase() !== message.senderPubkey.toLowerCase()) return null;
    if (typeof interaction.timestamp !== "number") return null;
    if (interaction.type === "comment" && typeof interaction.text !== "string") return null;
    return interaction;
  } catch {
    return null;
  }
}

export const useInteractionsStore = defineStore("interactions", {
  state: () => ({
    interactions: new Map<string, Interaction[]>(),
    processedEvents: new Set<string>(),
    lastSyncedAt: 0,
    loadedFor: ""
  }),

  getters: {
    getLikes: state => (messageId: string) =>
      (state.interactions.get(messageId) || []).filter(item => item.type === "like") as Like[],
    getComments: state => (messageId: string) =>
      (state.interactions.get(messageId) || []).filter(item => item.type === "comment") as Comment[],
    getReplies: state => (messageId: string, parentCommentId: string) =>
      (state.interactions.get(messageId) || []).filter(item =>
        item.type === "comment" && item.parentCommentId === parentCommentId
      ) as Comment[],
    getLikeCount: state => (messageId: string) =>
      (state.interactions.get(messageId) || []).reduce((count, item) => count + Number(item.type === "like"), 0),
    getCommentCount: state => (messageId: string) =>
      (state.interactions.get(messageId) || []).reduce((count, item) => count + Number(item.type === "comment"), 0),
    isLikedByUser: state => (messageId: string, userPubkey: string) =>
      (state.interactions.get(messageId) || []).some(item => item.type === "like" && item.author === userPubkey)
  },

  actions: {
    async sendLike(messageId: string, messageAuthor: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const interaction: Like = {
        id: newInteractionId(), messageId, author: key.pkHex,
        timestamp: Math.floor(Date.now() / 1000), type: "like"
      };
      await this._sendInteraction(interaction, messageAuthor);
      this._addInteraction(interaction);
    },

    async sendComment(messageId: string, messageAuthor: string, text: string, parentCommentId?: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const interaction: Comment = {
        id: newInteractionId(), messageId, author: key.pkHex, text: text.trim(),
        timestamp: Math.floor(Date.now() / 1000), type: "comment", parentCommentId
      };
      await this._sendInteraction(interaction, messageAuthor);
      this._addInteraction(interaction);
    },

    async removeLike(messageId: string, _messageAuthor: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) return;
      const items = this.interactions.get(messageId) || [];
      const next = items.filter(item => !(item.type === "like" && item.author === key.pkHex));
      if (next.length === items.length) return;
      this.interactions.set(messageId, next);
      this._scheduleSave();
    },

    async _sendInteraction(interaction: Interaction, recipientPubkey: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== key.pkHex) await friendships.load(key.pkHex);
      if (!friendships.isAccepted(recipientPubkey)) throw new Error("只能与已互相确认的好友互动");
      await sendDirectMessage({
        recipientPubkeys: [recipientPubkey],
        content: JSON.stringify(interaction),
        replyTo: interaction.messageId,
        tags: [["l", INTERACTION_LABEL], ["t", interaction.type]],
        relays: getRelaysFromStorage(),
        context: {
          senderPubkey: key.pkHex,
          nip44Encrypt: key.supportsNip44 ? key.nip44Encrypt.bind(key) : undefined,
          signEvent: key.signEvent.bind(key)
        }
      });
    },

    async processCanonicalInteraction(message: CanonicalMessage, myPubkey: string) {
      const key = useKeyStore();
      if (!myPubkey || key.pkHex !== myPubkey || this.loadedFor !== myPubkey) return false;
      if (this.processedEvents.has(message.id)) return false;
      const interaction = decodeInteractionMessage(message);
      if (!interaction) return false;
      this.processedEvents.add(message.id);
      if (interaction.author !== myPubkey) {
        useNotificationsStore().addNotification({
          id: `interaction:${message.id}`,
          type: interaction.type,
          from: interaction.author,
          messageId: interaction.messageId,
          commentId: interaction.type === "comment" ? interaction.id : undefined,
          created_at: interaction.timestamp,
          read: false
        });
      }
      this._addInteraction(interaction);
      this.lastSyncedAt = Math.max(this.lastSyncedAt, message.createdAt);
      return true;
    },

    _addInteraction(interaction: Interaction) {
      const items = this.interactions.get(interaction.messageId) || [];
      if (items.some(item => item.id === interaction.id)) return;
      if (interaction.type === "like" && items.some(item => item.type === "like" && item.author === interaction.author)) return;
      this.interactions.set(interaction.messageId, [...items, interaction]);
      this._scheduleSave();
    },

    load(pk?: string) {
      const targetPk = pk ?? useKeyStore().pkHex;
      if (!targetPk) return this.reset(false);
      if (this.loadedFor === targetPk) return;
      if (this.loadedFor) this._flushToStorage();
      this.interactions.clear();
      this.processedEvents.clear();
      this.lastSyncedAt = 0;
      this.loadedFor = targetPk;
      try {
        const raw = localStorage.getItem(`interactions_${targetPk}`);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data?.protocol !== "nip17") {
          localStorage.removeItem(`interactions_${targetPk}`);
          return;
        }
        const stored = data?.interactions && typeof data.interactions === "object" ? data.interactions : {};
        this.interactions = new Map(
          Object.entries(stored) as Array<[string, Interaction[]]>
        );
        this.lastSyncedAt = Number(data?.lastSyncedAt || 0);
      } catch (error) {
        logger.warn("Failed to load interactions", error);
      }
    },

    _scheduleSave() {
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        this._flushToStorage();
      }, 150);
    },

    _flushToStorage() {
      if (!this.loadedFor) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        localStorage.setItem(`interactions_${this.loadedFor}`, JSON.stringify({
          protocol: "nip17",
          interactions: Object.fromEntries(this.interactions),
          lastSyncedAt: this.lastSyncedAt
        }));
      } catch (error) {
        logger.warn("Failed to save interactions", error);
      }
    },

    reset(removeFromStorage = false) {
      const pk = this.loadedFor;
      if (!removeFromStorage) this._flushToStorage();
      this.interactions.clear();
      this.processedEvents.clear();
      this.lastSyncedAt = 0;
      this.loadedFor = "";
      if (removeFromStorage && pk) localStorage.removeItem(`interactions_${pk}`);
    }
  }
});
