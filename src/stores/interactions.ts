import { defineStore } from "pinia";
import { pool } from "@/nostr/relays";
import { getRelaysFromStorage } from "@/nostr/relays";
import { useKeyStore } from "@/stores/keys";
import { useNotificationsStore } from "@/stores/notifications";
import { logger } from "@/utils/logger";
import { backfillEvents } from "@/utils/backfill";
import { decodeMessageEvent, legacy8965Adapter } from "@/nostr/messaging/protocol";
import { buildInteractionSubscriptions } from "@/nostr/messaging/subscriptions";

/**
 * Interactions store - handles encrypted likes and comments
 * Uses kind 8965 for encrypted interactions (likes/comments)
 */

/**
 * Decode an encrypted interaction event (kind 8965)
 * Standalone helper function to avoid 'this' binding issues
 * 
 * @param evt - The Nostr event to decode
 * @param myPubkey - The public key of the current user
 * @param keyStore - The key store instance for decryption
 * @returns The decoded Interaction object, or null if decoding failed
 */
async function decodeInteractionEvent(
  evt: any,
  myPubkey: string,
  keyStore: ReturnType<typeof useKeyStore>
): Promise<Interaction | null> {
  try {
    logger.info(`[sync] interaction event=${evt.id?.slice(0, 8)} author=${evt.pubkey?.slice(0, 8)} created_at=${evt.created_at}`);
    const decoded = await decodeMessageEvent(evt, {
      accountPubkey: myPubkey,
      nip04Decrypt: keyStore.nip04Decrypt.bind(keyStore),
      nip44Decrypt: keyStore.supportsNip44 ? keyStore.nip44Decrypt.bind(keyStore) : undefined
    });
    if (!decoded || decoded.protocol !== "legacy-8965" || !decoded.plaintext) return null;
    try {
      const interaction: Interaction = JSON.parse(decoded.plaintext);
      
      // Validate interaction structure
      if (!interaction.messageId || !interaction.type) {
        logger.warn(`[sync] interaction fields missing event=${evt.id?.slice(0, 8)}`);
        return null;
      }
      
      logger.info(`[sync] interaction decoded event=${evt.id?.slice(0, 8)} type=${interaction.type} message=${interaction.messageId.slice(0, 8)} author=${interaction.author.slice(0, 8)}`);
      return interaction;
    } catch (e) {
      logger.warn(`[sync] interaction package decrypt failed event=${evt.id?.slice(0, 8)}`, e);
      return null;
    }
  } catch (e) {
    logger.warn(`[sync] interaction decode failed event=${evt.id?.slice(0, 8)}`, e);
    return null;
  }
}

export interface Like {
  id: string;
  messageId: string;
  author: string;
  timestamp: number;
  type: 'like';
}

export interface Comment {
  id: string;
  messageId: string;
  author: string;
  text: string;
  timestamp: number;
  type: 'comment';
  parentCommentId?: string; // Optional: ID of parent comment for replies
}

export type Interaction = Like | Comment;

export const useInteractionsStore = defineStore("interactions", {
  state: () => ({
    // Map of messageId -> array of interactions
    interactions: new Map<string, Interaction[]>(),
    // Map of interaction event id -> interaction (to avoid duplicates)
    processedEvents: new Set<string>(),
    // Latest synced timestamp for incremental backfill
    lastSyncedAt: 0,
    loadedFor: "",
  }),
  
  getters: {
    getLikes: (state) => (messageId: string): Like[] => {
      const items = state.interactions.get(messageId) || [];
      return items.filter(i => i.type === 'like') as Like[];
    },
    
    getComments: (state) => (messageId: string): Comment[] => {
      const items = state.interactions.get(messageId) || [];
      return items.filter(i => i.type === 'comment') as Comment[];
    },
    
    getReplies: (state) => (messageId: string, parentCommentId: string): Comment[] => {
      const items = state.interactions.get(messageId) || [];
      return items.filter(i => 
        i.type === 'comment' && (i as Comment).parentCommentId === parentCommentId
      ) as Comment[];
    },
    
    getLikeCount: (state) => (messageId: string): number => {
      const items = state.interactions.get(messageId) || [];
      return items.filter(i => i.type === 'like').length;
    },
    
    getCommentCount: (state) => (messageId: string): number => {
      const items = state.interactions.get(messageId) || [];
      return items.filter(i => i.type === 'comment').length;
    },
    
    isLikedByUser: (state) => (messageId: string, userPubkey: string): boolean => {
      const items = state.interactions.get(messageId) || [];
      return items.some(i => i.type === 'like' && i.author === userPubkey);
    },
  },
  
  actions: {
    /**
     * Send an encrypted like to the message author
     */
    async sendLike(messageId: string, messageAuthor: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      
      const interaction: Like = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID 
          ? crypto.randomUUID() 
          : Date.now().toString() + '-' + Math.random().toString(36).slice(2, 11),
        messageId,
        author: key.pkHex,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'like'
      };
      
      await this._sendInteraction(interaction, messageAuthor);
      
      // Add to local state immediately for instant feedback
      this._addInteraction(messageId, interaction);
    },
    
    /**
     * Send an encrypted comment to the message author
     */
    async sendComment(messageId: string, messageAuthor: string, text: string, parentCommentId?: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      
      const interaction: Comment = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID 
          ? crypto.randomUUID() 
          : Date.now().toString() + '-' + Math.random().toString(36).slice(2, 11),
        messageId,
        author: key.pkHex,
        text: text.trim(),
        timestamp: Math.floor(Date.now() / 1000),
        type: 'comment',
        parentCommentId // Add parent comment ID if this is a reply
      };
      
      await this._sendInteraction(interaction, messageAuthor);
      
      // Add to local state immediately for instant feedback
      this._addInteraction(messageId, interaction);
    },
    
    /**
     * Remove a like (unlike)
     */
    async removeLike(messageId: string, messageAuthor: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) return;
      
      const items = this.interactions.get(messageId) || [];
      const likeIndex = items.findIndex(i => i.type === 'like' && i.author === key.pkHex);
      
      if (likeIndex !== -1) {
        items.splice(likeIndex, 1);
        this.interactions.set(messageId, items);
        this._saveToStorage();
        
        // Note: In a full implementation, we'd send a "remove like" event
        // For now, we just remove it locally
      }
    },
    
    /**
     * Private: Send encrypted interaction event
     */
    async _sendInteraction(interaction: Interaction, recipientPubkey: string) {
      const key = useKeyStore();
      if (!key.isLoggedIn) throw new Error("未登录");
      
      const plaintext = JSON.stringify(interaction);
      const recipients = [recipientPubkey];
      if (key.pkHex !== recipientPubkey) {
        recipients.push(key.pkHex); // Include self to see own interactions
      }
      
      const encoded = await legacy8965Adapter.encode!({
        recipientPubkeys: recipients,
        plaintext,
        replyTo: interaction.messageId
      }, {
        senderPubkey: key.pkHex,
        nip04Encrypt: key.nip04Encrypt.bind(key),
        signEvent: key.signEvent.bind(key)
      });
      const signed = encoded.events[0];
      
      const relays = getRelaysFromStorage();
      
      try {
        await pool.publish(relays, signed);
        logger.debug("[message-protocol] published legacy interaction", {
          account: key.pkHex.slice(0, 8),
          eventId: signed.id.slice(0, 8),
          interactionType: interaction.type,
          relays: relays.length
        });
      } catch (e) {
        logger.warn("publish interaction failed", e);
        throw e;
      }
    },
    
    /**
     * Process received interaction event
     * Uses standalone decode helper to avoid 'this' binding issues
     */
    async processInteractionEvent(evt: any, myPubkey: string) {
     try {
      const key = useKeyStore();
      if (!myPubkey || key.pkHex !== myPubkey || this.loadedFor !== myPubkey) {
        logger.warn(`[account] interaction event discarded account=${myPubkey?.slice(0, 8) || "none"} event=${evt?.id?.slice(0, 8) || "unknown"}`);
        return false;
      }
     // ⭐⭐⭐【关键】入口第一行做硬去重
      if (this.processedEvents.has(evt.id)) {
        return false;
       }

      const interaction = await decodeInteractionEvent(evt, myPubkey, key);

      if (!interaction) {
        return false;
      }
      if (key.pkHex !== myPubkey || this.loadedFor !== myPubkey) {
        logger.warn(`[account] decrypted interaction discarded account=${myPubkey.slice(0, 8)} event=${evt?.id?.slice(0, 8) || "unknown"}`);
        return false;
      }

      // ⭐ 只有「成功解码 + 即将写入」才标记为 processed
      this.processedEvents.add(evt.id);

      // ⭐⭐⭐ 在这里生成通知
      this._emitNotificationFromInteraction(evt, interaction, myPubkey);

      this._addInteraction(interaction.messageId, interaction);

      logger.info(
        `[互动事件] 已写入store: ${interaction.type} on messageId=${interaction.messageId.slice(0, 8)}... by ${interaction.author.slice(0, 8)}...`
      );

      if (evt.created_at && evt.created_at > this.lastSyncedAt) {
        this.lastSyncedAt = evt.created_at;
       }
      return true;
      } catch (e) {
      logger.warn(`[sync] interaction processing failed event=${evt?.id?.slice(0, 8) || "unknown"}`, e);
      return false;
     }
   },

    _emitNotificationFromInteraction(
  evt: any,
  interaction: Interaction,
  myPubkey: string
) {
  // 不给自己发通知
  if (interaction.author === myPubkey) return;

  const notifications = useNotificationsStore();

  notifications.addNotification({
    id: evt.id,
    type: interaction.type,            // 'like' | 'comment'
    from: interaction.author,           // 谁点的
    messageId: interaction.messageId,   // 哪条消息
    commentId:
      interaction.type === "comment"
        ? interaction.id
        : undefined,
    created_at: interaction.timestamp,
    read: false,
  });
},

    
    /**
     * Private: Add interaction to state
     */
    _addInteraction(messageId: string, interaction: Interaction) {
      const items = this.interactions.get(messageId) || [];
      
      // For likes: prevent duplicate likes from same user on same message
      if (interaction.type === 'like') {
        const existingLike = items.find(i => 
          i.type === 'like' && i.author === interaction.author
        );
        
        if (existingLike) {
          // User has already liked this message, don't add duplicate
          logger.debug(`[互动存储] 跳过重复点赞: messageId=${messageId.slice(0, 8)}... author=${interaction.author.slice(0, 8)}...`);
          return;
        }
      } else if (interaction.type === 'comment') {
        // For comments: check for duplicates (same author, same text, same timestamp within 5 seconds)
        const isDuplicate = items.some(i => 
          i.type === 'comment' &&
          i.author === interaction.author &&
          (i as Comment).text === (interaction as Comment).text &&
          Math.abs(i.timestamp - interaction.timestamp) < 5
        );
        
        if (isDuplicate) {
          logger.debug(`[互动存储] 跳过重复评论: messageId=${messageId.slice(0, 8)}... author=${interaction.author.slice(0, 8)}...`);
          return;
        }
      }
      
      // Add interaction if no duplicates found
      items.push(interaction);
      this.interactions.set(messageId, items);
      this._saveToStorage();
      logger.debug(`[互动存储] 已保存到Map: ${interaction.type} on messageId=${messageId.slice(0, 8)}..., 该消息共有 ${items.length} 个互动`);
    },
    
    /**
     * Load interactions from localStorage
     */
    load(pk?: string) {
      try {
        const key = useKeyStore();
        const targetPk = pk ?? key.pkHex;
        if (!targetPk) {
          this.reset(false);
          return;
        }

        if (this.loadedFor && this.loadedFor !== targetPk) {
          this.reset(false);
        }
        if (this.loadedFor === targetPk) return;
        this.interactions.clear();
        this.processedEvents.clear();
        this.lastSyncedAt = 0;
        this.loadedFor = targetPk;
        
        const storageKey = `interactions_${targetPk}`;
        const stored = localStorage.getItem(storageKey);
        
        if (stored) {
          const data = JSON.parse(stored);
          
          // Backward compatibility: check if data has new structure or old structure
          if (data && typeof data === 'object' && 'interactions' in data) {
            // New structure: { interactions: {...}, lastSyncedAt: number }
            this.interactions = new Map(Object.entries(data.interactions || {}));
            this.lastSyncedAt = data.lastSyncedAt || 0;
          } else {
            // Old structure: direct map of messageId -> interactions
            this.interactions = new Map(Object.entries(data));
            this.lastSyncedAt = 0;
          }
        } else {
          this.interactions.clear();
          this.processedEvents.clear();
          this.lastSyncedAt = 0;
        }
      } catch (e) {
        logger.warn("Failed to load interactions", e);
      }
    },
    
    /**
     * Save interactions to localStorage
     */
    _saveToStorage() {
      try {
        const pk = this.loadedFor;
        if (!pk) return;
        
        const storageKey = `interactions_${pk}`;
        const interactionsObj: Record<string, Interaction[]> = {};
        
        this.interactions.forEach((value, key) => {
          interactionsObj[key] = value;
        });
        
        // Save new structure with lastSyncedAt
        const data = {
          interactions: interactionsObj,
          lastSyncedAt: this.lastSyncedAt
        };
        
        localStorage.setItem(storageKey, JSON.stringify(data));
      } catch (e) {
        logger.warn("Failed to save interactions", e);
      }
    },
    
    /**
     * Reset interactions store - clear in-memory data and optionally remove from storage
     * @param removeFromStorage - If true, remove persisted interactions from localStorage
     */
    reset(removeFromStorage = false) {
      const pk = this.loadedFor;
      this.interactions.clear();
      this.processedEvents.clear();
      this.lastSyncedAt = 0;
      this.loadedFor = "";
      
      if (removeFromStorage && pk) {
        try {
          const storageKey = `interactions_${pk}`;
          localStorage.removeItem(storageKey);
        } catch (e) {
          logger.warn("Failed to remove interactions from storage", e);
        }
      }
    },
    
    /**
     * Backfill interactions from relays for multi-device sync
     * 
     * This method fetches interactions using two filters for comprehensive coverage:
     * 1. Inbox: Interactions targeted at the user (#p tag) - for notifications and comments on user's posts
     * 2. Outbox: Interactions authored by the user - for cross-device sync of own interactions
     * 
     * For comprehensive sync, always fetches the last 3 days of data to ensure no interactions
     * are missed across devices with different online durations.
     * 
     * @returns Object with fetched and processed counts
     */
    async backfillInteractions(options: {
      relays: string[];
      since?: number;
      until?: number;
      maxBatches?: number;
      onEvent?: (event: any) => void;
      onProgress?: (fetched: number, processed: number) => void;
    }): Promise<{ fetched: number; processed: number }> {
      const key = useKeyStore();
      if (!key.pkHex) {
        logger.warn("Cannot backfill interactions: not logged in");
        return { fetched: 0, processed: 0 };
      }
      
      const {
        relays,
        since = 0,
        until = Math.floor(Date.now() / 1000),
        maxBatches = 10,
        onEvent: externalOnEvent,
        onProgress
      } = options;
      const accountPk = key.pkHex;

      if (this.loadedFor !== accountPk) {
        logger.warn(`[account] interaction backfill skipped account=${accountPk.slice(0, 8)} loadedFor=${this.loadedFor.slice(0, 8) || "none"}`);
        return { fetched: 0, processed: 0 };
      }
      
      logger.info(`开始回填互动事件: since=${since ? new Date(since * 1000).toLocaleString() : 'beginning'}, until=${new Date(until * 1000).toLocaleString()}`);
      
      let fetchedCount = 0;
      let processedCount = 0;
      let maxTimestamp = this.lastSyncedAt;
      
      try {
        const processEvent = async (evt: any) => {
          if (key.pkHex !== accountPk || this.loadedFor !== accountPk) {
            logger.warn(`[account] interaction backfill event discarded account=${accountPk.slice(0, 8)} event=${evt?.id?.slice(0, 8) || "unknown"}`);
            return;
          }
          fetchedCount++;
          try {
            const processed = await this.processInteractionEvent(evt, accountPk);
            if (key.pkHex !== accountPk || this.loadedFor !== accountPk) {
              logger.warn(`[account] interaction backfill result discarded account=${accountPk.slice(0, 8)} event=${evt?.id?.slice(0, 8) || "unknown"}`);
              return;
            }
            if (!processed) return;
            processedCount++;
            
            // Track the maximum timestamp we've seen
            if (evt.created_at && evt.created_at > maxTimestamp) {
              maxTimestamp = evt.created_at;
            }
            
            if (onProgress) {
              onProgress(fetchedCount, processedCount);
            }
            externalOnEvent?.(evt);
          } catch (e) {
            logger.warn("处理回填互动事件失败", e);
          }
        };
        
        // Build filters - we fetch interactions in two ways for privacy and comprehensive sync:
        // 1. Inbox: Interactions where user is mentioned (#p tag) - others' interactions sent to us
        // 2. Outbox: Interactions authored by user - our own interactions (for cross-device sync)
        const filters = buildInteractionSubscriptions(accountPk, since, until);
        
        // Log the filters being used for debugging
        logger.info(`互动回填过滤器详情:`);
        logger.info(`  收件箱/发件箱: account=[${accountPk.substring(0, 8)}...], since=${since}, until=${until}`);
        
        // Fetch with each filter in parallel for better performance
        const filterPromises = filters.map((filter, i) => {
          const filterType = "#p" in filter ? "收件箱 (#p)" : "发件箱 (authors)";
          logger.debug(`回填互动过滤器 ${i + 1}/${filters.length}: ${filterType}`);
          
          return backfillEvents({
            relays,
            filters: filter,
            onEvent: processEvent,
            onProgress: (stats) => {
              logger.debug(`回填互动进度 (${filterType}): ${stats.totalEvents} 条事件`);
            },
            onComplete: (stats) => {
              if (key.pkHex !== accountPk || this.loadedFor !== accountPk) return;
              logger.info(`互动过滤器 ${filterType} 完成: ${stats.totalEvents} 条事件`);
            },
            batchSize: 500,
            maxBatches,
            timeoutMs: 10000
          });
        });
        
        // Wait for all filters to complete
        await Promise.all(filterPromises);
        if (key.pkHex !== accountPk || this.loadedFor !== accountPk) {
          logger.warn(`[account] interaction backfill completion discarded account=${accountPk.slice(0, 8)}`);
          return { fetched: fetchedCount, processed: processedCount };
        }
        
        logger.info(`互动事件回填完成: 获取 ${fetchedCount} 条, 处理 ${processedCount} 条`);
        
        // Update lastSyncedAt after successful sync
        // If we found events, use the max timestamp; otherwise use 'until'
        // to mark this time range as successfully synced and avoid re-fetching
        const newSyncedAt = maxTimestamp > this.lastSyncedAt ? maxTimestamp : until;
        if (newSyncedAt > this.lastSyncedAt) {
          this.lastSyncedAt = newSyncedAt;
          this._saveToStorage();
          logger.info(`更新最后同步时间戳: ${new Date(newSyncedAt * 1000).toLocaleString()}`);
        }
        
        return { fetched: fetchedCount, processed: processedCount };
      } catch (e) {
        logger.error("回填互动事件失败", e);
        return { fetched: fetchedCount, processed: processedCount };
      }
    }
  }
});
