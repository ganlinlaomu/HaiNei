import { BoundedSet } from "@/utils/boundedSet";
import { defineStore } from "pinia";
import { deviceStorage, putDeviceValue } from "@/services/deviceStorage";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { getRelaysFromStorage } from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { useNotificationsStore } from "@/stores/notifications";
import { logger } from "@/utils/logger";
import { useFriendshipsStore } from "@/stores/friendships";
import { isEncryptedImageRef } from "@/utils/encryptedImageRef";
import { cancelBackgroundTask, scheduleBackgroundTask } from "@/services/backgroundWorkScheduler";
import { onBeforeAccountLock } from "@/services/accountLifecycle";

export const INTERACTION_LABEL = "hainei-interaction";

export interface Like {
  id: string;
  messageId: string;
  author: string;
  timestamp: number;
  type: "like";
  liked?: boolean;
  pending?: boolean;
  failed?: boolean;
}

export interface Comment {
  id: string;
  messageId: string;
  author: string;
  text: string;
  timestamp: number;
  type: "comment";
  parentCommentId?: string;
  media?: CommentMedia[];
  pending?: boolean;
  failed?: boolean;
}

export interface CommentMedia {
  type: "image";
  ref: string;
  width?: number;
  height?: number;
}

export type Interaction = Like | Comment;

export const INTERACTION_SAVE_DEBOUNCE_MS = 400;
export const INTERACTION_SAVE_MAX_WAIT_MS = 2_500;
const INTERACTION_SAVE_IDLE_TIMEOUT_MS = 1_000;

type InteractionSaveState = {
  dirtyRevision: number;
  enqueuedRevision: number;
  persistedRevision: number;
  quietTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  writeChain: Promise<void>;
};

const saveStates = new Map<string, InteractionSaveState>();
const pendingLikeTransitions = new Set<string>();

function interactionSaveTaskKey(account: string) {
  return `persist-interactions:${account}`;
}

function interactionSaveState(account: string) {
  let state = saveStates.get(account);
  if (!state) {
    state = {
      dirtyRevision: 0,
      enqueuedRevision: 0,
      persistedRevision: 0,
      quietTimer: null,
      deadlineTimer: null,
      writeChain: Promise.resolve(),
    };
    saveStates.set(account, state);
  }
  return state;
}

function cancelInteractionSaveSchedule(account: string, state = interactionSaveState(account)) {
  if (state.quietTimer) {
    clearTimeout(state.quietTimer);
    state.quietTimer = null;
  }
  if (state.deadlineTimer) {
    clearTimeout(state.deadlineTimer);
    state.deadlineTimer = null;
  }
  cancelBackgroundTask(interactionSaveTaskKey(account));
}

export function likeNotificationId(messageId: string, authorPubkey: string) {
  return `like:${messageId}:${authorPubkey.toLowerCase()}`;
}

export function isActiveLike(like: Like) {
  return like.liked !== false;
}

function latestLikeStates(items: Interaction[]) {
  const latest = new Map<string, Like>();
  items.forEach(item => {
    if (item.type !== "like") return;
    const author = item.author.toLowerCase();
    const existing = latest.get(author);
    if (!existing || item.timestamp >= existing.timestamp) latest.set(author, item);
  });
  return [...latest.values()];
}

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
    if (interaction.type === "comment") {
      if (typeof interaction.text !== "string") return null;
      if (interaction.media !== undefined) {
        if (!Array.isArray(interaction.media) || interaction.media.length > 1) return null;
        const media = interaction.media[0];
        if (media && (media.type !== "image" || !isEncryptedImageRef(media.ref))) return null;
      }
      if (!interaction.text.trim() && !interaction.media?.length) return null;
    }
    return interaction;
  } catch {
    return null;
  }
}

export const useInteractionsStore = defineStore("interactions", {
  state: () => ({
    interactions: new Map<string, Interaction[]>(),
    processedEvents: new BoundedSet<string>(),
    lastSyncedAt: 0,
    loadedFor: ""
  }),

  getters: {
    getLikes: state => (messageId: string) =>
      latestLikeStates(state.interactions.get(messageId) || []).filter(isActiveLike),
    getComments: state => (messageId: string) =>
      (state.interactions.get(messageId) || []).filter(item => item.type === "comment") as Comment[],
    getReplies: state => (messageId: string, parentCommentId: string) =>
      (state.interactions.get(messageId) || []).filter(item =>
        item.type === "comment" && item.parentCommentId === parentCommentId
      ) as Comment[],
    getLikeCount: state => (messageId: string) =>
      latestLikeStates(state.interactions.get(messageId) || []).filter(isActiveLike).length,
    getCommentCount: state => (messageId: string) =>
      (state.interactions.get(messageId) || []).reduce((count, item) => count + Number(item.type === "comment"), 0),
    isLikedByUser: state => (messageId: string, userPubkey: string) =>
      latestLikeStates(state.interactions.get(messageId) || [])
        .some(item => item.author.toLowerCase() === userPubkey.toLowerCase() && isActiveLike(item))
  },

  actions: {
    async sendLike(messageId: string, messageAuthor: string) {
      if (this.isLikedByUser(messageId, useKeyStore().pkHex)) return;
      await this._sendLikeState(messageId, messageAuthor, true);
    },

    async sendComment(
      messageId: string,
      messageAuthor: string,
      text: string,
      parentCommentId?: string,
      media?: CommentMedia[]
    ) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const normalizedMedia = media?.slice(0, 1).filter(item => item.type === "image" && isEncryptedImageRef(item.ref));
      if (!text.trim() && !normalizedMedia?.length) throw new Error("评论不能为空");
      const interaction: Comment = {
        id: newInteractionId(), messageId, author: key.pkHex, text: text.trim(),
        timestamp: Math.floor(Date.now() / 1000), type: "comment", parentCommentId,
        ...(normalizedMedia?.length ? { media: normalizedMedia } : {})
      };
      this._addInteraction({ ...interaction, pending: true });
      try {
        await this._sendInteraction(interaction, messageAuthor);
        this._replaceInteraction(interaction);
      } catch (error) {
        this._removeInteraction(interaction.messageId, interaction.id);
        throw error;
      }
    },

    async removeLike(messageId: string, messageAuthor: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) return;
      if (!this.isLikedByUser(messageId, key.pkHex)) return;
      await this._sendLikeState(messageId, messageAuthor, false);
    },

    async _sendLikeState(messageId: string, messageAuthor: string, liked: boolean) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const transitionKey = `${key.pkHex.toLowerCase()}:${messageId}`;
      if (pendingLikeTransitions.has(transitionKey)) return;
      pendingLikeTransitions.add(transitionKey);
      const previous = latestLikeStates(this.interactions.get(messageId) || [])
        .find(item => item.author.toLowerCase() === key.pkHex.toLowerCase());
      const interaction: Like = {
        id: likeNotificationId(messageId, key.pkHex),
        messageId,
        author: key.pkHex,
        liked,
        timestamp: Math.max(Math.floor(Date.now() / 1000), (previous?.timestamp || 0) + 1),
        type: "like"
      };
      this._addInteraction({ ...interaction, pending: true });
      try {
        await this._sendInteraction(interaction, messageAuthor);
        this._addInteraction(interaction);
      } catch (error) {
        this._addInteraction({ ...interaction, pending: false, failed: true });
        throw error;
      } finally {
        pendingLikeTransitions.delete(transitionKey);
      }
    },

    async _sendInteraction(interaction: Interaction, recipientPubkey: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      const friendships = useFriendshipsStore();
      if (friendships.loadedFor !== key.pkHex) await friendships.load(key.pkHex);
      if (recipientPubkey.toLowerCase() !== key.pkHex.toLowerCase() && !friendships.isAccepted(recipientPubkey)) {
        throw new Error("只能与已互相确认的好友互动");
      }
      await sendDirectMessage({
        recipientPubkeys: [recipientPubkey],
        content: JSON.stringify(interaction),
        replyTo: interaction.messageId,
        tags: [
          ["l", INTERACTION_LABEL],
          ["t", interaction.type],
          ...(interaction.type === "like" ? [["liked", String(isActiveLike(interaction))]] : [])
        ],
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
      const currentLike = interaction.type === "like"
        ? latestLikeStates(this.interactions.get(interaction.messageId) || [])
          .find(item => item.author.toLowerCase() === interaction.author.toLowerCase())
        : undefined;
      const staleLike = !!currentLike && interaction.type === "like" && interaction.timestamp < currentLike.timestamp;
      if (!staleLike && interaction.author !== myPubkey && (interaction.type !== "like" || isActiveLike(interaction))) {
        useNotificationsStore().addNotification({
          id: interaction.type === "like"
            ? likeNotificationId(interaction.messageId, interaction.author)
            : `interaction:${message.id}`,
          type: interaction.type,
          from: interaction.author,
          messageId: interaction.messageId,
          commentId: interaction.type === "comment" ? interaction.id : undefined,
          replyId: interaction.type === "comment" ? interaction.parentCommentId : undefined,
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
      if (interaction.type === "like") {
        const author = interaction.author.toLowerCase();
        const existing = latestLikeStates(items).find(item => item.author.toLowerCase() === author);
        if (existing) {
          if (interaction.timestamp < existing.timestamp) return;
          const next = items.filter(item => item.type !== "like" || item.author.toLowerCase() !== author);
          this.interactions.set(interaction.messageId, [...next, interaction]);
          this._scheduleSave();
          return;
        }
      }
      if (items.some(item => item.id === interaction.id)) {
        this._replaceInteraction(interaction);
        return;
      }
      this.interactions.set(interaction.messageId, [...items, interaction]);
      this._scheduleSave();
    },

    _replaceInteraction(interaction: Interaction) {
      const items = this.interactions.get(interaction.messageId) || [];
      const index = items.findIndex(item => item.id === interaction.id);
      if (index < 0) return;
      const next = [...items];
      next[index] = interaction;
      this.interactions.set(interaction.messageId, next);
      this._scheduleSave();
    },

    _removeInteraction(messageId: string, interactionId: string) {
      const items = this.interactions.get(messageId) || [];
      const next = items.filter(item => item.id !== interactionId);
      if (next.length === items.length) return;
      this.interactions.set(messageId, next);
      this._scheduleSave();
    },

    load(pk?: string) {
      const targetPk = pk ?? useKeyStore().pkHex;
      if (!targetPk) return this.reset(false);
      if (this.loadedFor === targetPk) return;
      if (this.loadedFor) void this._flushToStorage(this.loadedFor);
      this.interactions.clear();
      this.processedEvents.clear();
      this.lastSyncedAt = 0;
      this.loadedFor = targetPk;
      try {
        const raw = deviceStorage.getItem(`interactions_${targetPk}`);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data?.protocol !== "nip17") {
          deviceStorage.removeItem(`interactions_${targetPk}`);
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
      const account = this.loadedFor.toLowerCase();
      if (!account) return;
      const state = interactionSaveState(account);
      state.dirtyRevision += 1;
      this._armSave(account);
    },

    _armSave(account: string) {
      const normalized = account.toLowerCase();
      if (!normalized || this.loadedFor.toLowerCase() !== normalized) return;
      const state = interactionSaveState(normalized);
      if (state.dirtyRevision <= state.persistedRevision) return;

      if (state.quietTimer) clearTimeout(state.quietTimer);
      cancelBackgroundTask(interactionSaveTaskKey(normalized));
      state.quietTimer = setTimeout(() => {
        state.quietTimer = null;
        if (this.loadedFor.toLowerCase() !== normalized || state.dirtyRevision <= state.persistedRevision) return;
        scheduleBackgroundTask(
          interactionSaveTaskKey(normalized),
          () => this._flushToStorage(normalized),
          { priority: "idle", timeoutMs: INTERACTION_SAVE_IDLE_TIMEOUT_MS },
        );
      }, INTERACTION_SAVE_DEBOUNCE_MS);

      if (!state.deadlineTimer) {
        state.deadlineTimer = setTimeout(() => {
          state.deadlineTimer = null;
          cancelBackgroundTask(interactionSaveTaskKey(normalized));
          void this._flushToStorage(normalized);
        }, INTERACTION_SAVE_MAX_WAIT_MS);
      }
    },

    _flushToStorage(
      accountOverride?: string,
      options: { throwOnError?: boolean } = {},
    ): Promise<void> {
      const account = (accountOverride || this.loadedFor).toLowerCase();
      if (!account) return Promise.resolve();

      const state = interactionSaveState(account);
      cancelInteractionSaveSchedule(account, state);
      let waitFor = state.writeChain;

      if (this.loadedFor.toLowerCase() === account && state.dirtyRevision > state.enqueuedRevision) {
        const revision = state.dirtyRevision;
        let payload: string;
        try {
          payload = JSON.stringify({
            protocol: "nip17",
            interactions: Object.fromEntries(this.interactions),
            lastSyncedAt: this.lastSyncedAt,
          });
        } catch (error) {
          logger.warn("Failed to serialize interactions", error);
          this._armSave(account);
          return options.throwOnError ? Promise.reject(error) : Promise.resolve();
        }

        state.enqueuedRevision = revision;
        const write = state.writeChain
          .catch(() => undefined)
          .then(() => putDeviceValue(`interactions_${account}`, payload));

        state.writeChain = write.then(
          () => {
            state.persistedRevision = Math.max(state.persistedRevision, revision);
          },
          error => {
            if (state.enqueuedRevision === revision) {
              state.enqueuedRevision = state.persistedRevision;
            }
            throw error;
          },
        );
        waitFor = state.writeChain;
      }

      return waitFor.catch(error => {
        logger.warn("Failed to save interactions", error);
        if (this.loadedFor.toLowerCase() === account && state.dirtyRevision > state.persistedRevision) {
          this._armSave(account);
        }
        if (options.throwOnError) throw error;
      });
    },

    reset(removeFromStorage = false) {
      const pk = this.loadedFor.toLowerCase();
      if (!removeFromStorage && pk) void this._flushToStorage(pk);
      else if (pk) cancelInteractionSaveSchedule(pk);
      this.interactions.clear();
      this.processedEvents.clear();
      this.lastSyncedAt = 0;
      this.loadedFor = "";
      if (removeFromStorage && pk) deviceStorage.removeItem(`interactions_${pk}`);
    }
  }
});


const stopInteractionLockFlush = onBeforeAccountLock(async account => {
  const interactions = useInteractionsStore();
  if (interactions.loadedFor.toLowerCase() !== account.toLowerCase()) return;
  await interactions._flushToStorage(account, { throwOnError: true });
});

if (import.meta.hot) import.meta.hot.dispose(stopInteractionLockFlush);
