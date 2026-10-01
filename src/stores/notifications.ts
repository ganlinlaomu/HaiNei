import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import { likeNotificationId, useInteractionsStore, type Comment } from "./interactions";
import { deviceStorage } from "@/services/deviceStorage";
import { metaRepository } from "@/repositories/metaRepository";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

export interface NotificationItem {
  id: string;
  type: "like" | "comment" | "friend_request";
  from: string;
  messageId?: string;
  commentId?: string;
  replyId?: string;
  created_at: number;
  read: boolean;
  postContent?: string;
  commentContent?: string;
}

const FIRST_LOGIN_DAYS = 3;
const DAY_SECONDS = 86400;

function notificationsKeyFor(pk?: string) { if (!pk) return null; return `nostr_notifications_${pk}`; }
function dismissedKeyFor(pk?: string) { if (!pk) return null; return `nostr_notifications_dismissed_${pk}`; }
function metaKeyFor(pk?: string) { if (!pk) return null; return `nostr_notifications_meta_${pk}`; }

interface NotificationMeta {
  lastSeenAt: number;
  seenEventIds: string[];
}

interface NotificationReadCursor {
  lastReadCreatedAt: number;
  lastReadMessageId: string;
}

interface SyncedNotificationState {
  dismissedIds?: string[];
  readIds?: string[];
  readCursor?: Partial<NotificationReadCursor>;
}

const MAX_SYNCED_READ_IDS = 512;

function normalizedReadCursor(value?: Partial<NotificationReadCursor>): NotificationReadCursor | undefined {
  const createdAt = Number(value?.lastReadCreatedAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
  return {
    lastReadCreatedAt: createdAt,
    lastReadMessageId: String(value?.lastReadMessageId || ""),
  };
}

function laterReadCursor(
  left?: Partial<NotificationReadCursor>,
  right?: Partial<NotificationReadCursor>,
): NotificationReadCursor | undefined {
  const a = normalizedReadCursor(left);
  const b = normalizedReadCursor(right);
  if (!a) return b;
  if (!b) return a;
  if (a.lastReadCreatedAt !== b.lastReadCreatedAt) {
    return a.lastReadCreatedAt > b.lastReadCreatedAt ? a : b;
  }
  // Legacy notification cursors used an empty id for mark-all. Treat that as
  // the complete second so an older client cannot move the watermark back.
  if (!a.lastReadMessageId || !b.lastReadMessageId) {
    return { lastReadCreatedAt: a.lastReadCreatedAt, lastReadMessageId: "" };
  }
  return a.lastReadMessageId.localeCompare(b.lastReadMessageId) >= 0 ? a : b;
}

function notificationReadByCursor(item: NotificationItem, cursor?: NotificationReadCursor) {
  if (!cursor) return false;
  if (item.created_at !== cursor.lastReadCreatedAt) return item.created_at < cursor.lastReadCreatedAt;
  return !cursor.lastReadMessageId || item.id.localeCompare(cursor.lastReadMessageId) <= 0;
}

function cursorForNotifications(items: NotificationItem[]) {
  return items.reduce<NotificationReadCursor | undefined>((cursor, item) => laterReadCursor(cursor, {
    lastReadCreatedAt: item.created_at,
    lastReadMessageId: item.id,
  }), undefined);
}

function trimReadIds(values: Iterable<string>) {
  const ids = [...new Set([...values].filter(value => typeof value === "string" && value))];
  return ids.slice(-MAX_SYNCED_READ_IDS);
}

function loadMeta(pk: string): NotificationMeta | null {
  try { const raw = deviceStorage.getItem(metaKeyFor(pk)!); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveMeta(pk: string, meta: NotificationMeta) {
  try { deviceStorage.setItem(metaKeyFor(pk)!, JSON.stringify(meta)); } catch {}
}

export const useNotificationsStore = defineStore("notifications", {
  state: () => ({
    list: [] as NotificationItem[],
    loadedFor: "" as string,
    dismissed: new Set<string>(),
    meta: null as NotificationMeta | null,
    readIds: new Set<string>(),
    readCursor: undefined as NotificationReadCursor | undefined,
  }),

  getters: {
    visibleList: (state) => state.list.filter(n => !state.dismissed.has(n.id)),
    unreadCount(): number { return this.visibleList.filter(n => !n.read).length; },
    // since 仅用于订阅 Relay 时的起始时间，不再用于 addNotification 的硬性拦截
    since(): number { 
      const now = Math.floor(Date.now() / 1000);
      return this.meta?.lastSeenAt || (now - FIRST_LOGIN_DAYS * DAY_SECONDS);
    },
  },

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

      // 1. 加载基本列表
      try {
        const raw = deviceStorage.getItem(notificationsKeyFor(targetPk)!);
        const stored = raw ? JSON.parse(raw) : [];
        // Normal posts belong in Home, not Notifications. Remove legacy
        // message notifications account-by-account as they are loaded.
        const seen = new Set<string>();
        this.list = Array.isArray(stored)
          ? stored.filter((item: NotificationItem & { type?: string }) =>
              item?.type === "like" || item?.type === "comment" || item?.type === "friend_request")
            .map((item: NotificationItem) => item.type === "like" && item.messageId
              ? { ...item, id: likeNotificationId(item.messageId, item.from) }
              : item)
            .filter((item: NotificationItem) => {
              if (seen.has(item.id)) return false;
              seen.add(item.id);
              return true;
            })
          : [];
        if (Array.isArray(stored) && JSON.stringify(this.list) !== JSON.stringify(stored)) {
          deviceStorage.setItem(notificationsKeyFor(targetPk)!, JSON.stringify(this.list));
        }
      } catch { this.list = []; }

      // 2. 加载屏蔽列表
      try {
        const raw = deviceStorage.getItem(dismissedKeyFor(targetPk)!);
        this.dismissed = raw ? new Set(JSON.parse(raw)) : new Set();
      } catch { this.dismissed = new Set(); }

      // 3. 加载元数据
      let meta = loadMeta(targetPk);
      if (!meta) {
        const now = Math.floor(Date.now() / 1000);
        meta = { lastSeenAt: now - FIRST_LOGIN_DAYS * DAY_SECONDS, seenEventIds: [] };
        saveMeta(targetPk, meta);
      }
      this.meta = meta;

      this.readIds = new Set(this.list.filter(item => item.read).map(item => item.id));
      const syncedState = (typeof indexedDB === "undefined" ? undefined : (await metaRepository.get(targetPk, "notification_state"))?.value) as SyncedNotificationState | undefined;
      this.readCursor = syncedState ? undefined : normalizedReadCursor(this.meta ? {
        lastReadCreatedAt: this.meta.lastSeenAt,
        lastReadMessageId: this.meta.seenEventIds.at(-1) || "",
      } : undefined);
      if (syncedState) this.applySyncedState(syncedState, false);

      // 4. 填充缺失内容
      this.refreshContent();
    },

    async refreshSyncedState(pk?: string) {
      const targetPk = pk ?? this.loadedFor;
      if (!targetPk || this.loadedFor !== targetPk || typeof indexedDB === "undefined") return false;
      const syncedState = (await metaRepository.get(targetPk, "notification_state"))?.value as SyncedNotificationState | undefined;
      if (!syncedState || this.loadedFor !== targetPk) return false;
      this.applySyncedState(syncedState, true);
      return true;
    },

    applySyncedState(syncedState: SyncedNotificationState, persist = true) {
      const pk = this.loadedFor;
      if (!pk) return;
      this.dismissed = new Set([...this.dismissed, ...(syncedState.dismissedIds || [])]);
      this.readIds = new Set(trimReadIds([...this.readIds, ...(syncedState.readIds || [])]));
      this.readCursor = laterReadCursor(this.readCursor, syncedState.readCursor);
      let changed = false;
      this.list.forEach(item => {
        if (!item.read && (this.readIds.has(item.id) || notificationReadByCursor(item, this.readCursor))) {
          item.read = true;
          changed = true;
        }
      });
      if (this.meta && this.readCursor) {
        this.meta.lastSeenAt = Math.max(this.meta.lastSeenAt, this.readCursor.lastReadCreatedAt);
        this.meta.seenEventIds = this.readCursor.lastReadMessageId ? [this.readCursor.lastReadMessageId] : [];
      }
      if (!persist) return;
      try {
        deviceStorage.setItem(notificationsKeyFor(pk)!, JSON.stringify(this.list));
        deviceStorage.setItem(dismissedKeyFor(pk)!, JSON.stringify([...this.dismissed]));
        if (this.meta) saveMeta(pk, this.meta);
      } catch {}
      if (changed) this.refreshContent();
    },

    // 提取出的内容刷新逻辑
    refreshContent() {
      const interactions = useInteractionsStore();
      this.list.forEach(n => {
        if (n.messageId && n.commentId && !n.commentContent) {
          const comment = interactions.getComments(n.messageId).find(c => c.id === n.commentId);
          if (comment) {
            n.commentContent = comment.text;
            if (comment.parentCommentId) n.replyId = comment.parentCommentId;
          }
        }
      });
    },

    save() {
      const pk = this.loadedFor || "";
      if (!pk) return;
      try {
        deviceStorage.setItem(notificationsKeyFor(pk)!, JSON.stringify(this.list));
        deviceStorage.setItem(dismissedKeyFor(pk)!, JSON.stringify([...this.dismissed]));
        if (this.meta) saveMeta(pk, this.meta);
        if (typeof indexedDB !== "undefined") {
          const keys = useKeyStore();
          const syncedState: SyncedNotificationState = {
            dismissedIds: [...this.dismissed],
            readIds: trimReadIds([...this.readIds, ...this.list.filter(item => item.read).map(item => item.id)]),
            readCursor: this.readCursor,
          };
          void metaRepository.put(pk, "notification_state", syncedState).then(() => {
            if (this.loadedFor !== pk || keys.pkHex !== pk) return;
            // Notification read state is tiny and must leave the device before
            // iOS suspends a just-backgrounded PWA. Start its debounced upload
            // on the next task instead of waiting the general 500 ms window.
            scheduleAccountStateSync(keys, "notification_state", undefined, { delayMs: 0 });
          }).catch(() => undefined);
        }
      } catch {}
    },

    addNotification(n: NotificationItem) {
      if (n.type !== "like" && n.type !== "comment" && n.type !== "friend_request") return;
      if (n.type === "like" && n.messageId) n.id = likeNotificationId(n.messageId, n.from);
      // 这里的逻辑修复最重要：
      // 1. 检查是否重复
      if (this.list.some(x => x.id === n.id)) return;
      if (this.dismissed.has(n.id)) return;
      
      // 2. 检查是否是太旧的历史记录（超过3天就不收了）
      const threeDaysAgo = Math.floor(Date.now() / 1000) - (FIRST_LOGIN_DAYS * DAY_SECONDS);
      if (n.created_at < threeDaysAgo) return;

      // 3. 填充内容
      if (n.messageId && n.commentId) {
        const interactions = useInteractionsStore();
        const comment = interactions.getComments(n.messageId).find(c => c.id === n.commentId);
        if (comment) {
          n.commentContent = comment.text;
          if (comment.parentCommentId) n.replyId = comment.parentCommentId;
        }
      }

      // 4. 插入列表并排序
      if (this.readIds.has(n.id) || notificationReadByCursor(n, this.readCursor)) n.read = true;
      this.list.unshift(n);
      this.list.sort((a, b) => b.created_at - a.created_at);
      
      // 5. 保持列表不要无限长（比如只留200条）
      if (this.list.length > 200) this.list = this.list.slice(0, 200);

      this.save();
    },

    resolveFriendRequests(from: string) {
      let changed = false;
      this.list.forEach(item => {
        if (item.type === "friend_request" && item.from === from && !item.read) {
          item.read = true;
          this.readIds.add(item.id);
          changed = true;
        }
      });
      if (changed) this.save();
    },

    markAsRead(id: string) { 
      const n = this.list.find(x => x.id === id); 
      if (!n) return;
      n.read = true;
      this.readIds.add(n.id);
      // 只有读取了更新的消息，才更新 lastSeenAt
      if (this.meta) {
        this.meta.lastSeenAt = Math.max(this.meta.lastSeenAt, n.created_at);
      }
      this.save();
    },

    markAllRead() {
      this.list.forEach(n => { n.read = true; });
      this.readCursor = laterReadCursor(this.readCursor, cursorForNotifications(this.list));
      this.readIds = new Set();
      if (this.meta) {
        if (this.readCursor) {
          this.meta.lastSeenAt = Math.max(this.meta.lastSeenAt, this.readCursor.lastReadCreatedAt);
          this.meta.seenEventIds = this.readCursor.lastReadMessageId ? [this.readCursor.lastReadMessageId] : [];
        }
      }
      this.save();
    },

    dismiss(id: string) { 
      this.dismissed.add(id); 
      this.save();
    },

    reset(removeFromStorage = false) {
      const pk = this.loadedFor || "";
      this.list = [];
      this.dismissed = new Set();
      this.meta = null;
      this.readIds = new Set();
      this.readCursor = undefined;
      this.loadedFor = "";
      if (removeFromStorage && pk) {
        try {
          deviceStorage.removeItem(notificationsKeyFor(pk)!);
          deviceStorage.removeItem(dismissedKeyFor(pk)!);
          deviceStorage.removeItem(metaKeyFor(pk)!);
        } catch {}
      }
    },
  },
});
