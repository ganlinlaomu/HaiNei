import { defineStore } from "pinia";
import { useKeyStore } from "./keys";
import { useInteractionsStore, type Comment } from "./interactions";

export interface NotificationItem {
  id: string;
  type: "like" | "comment";
  from: string;
  messageId: string;
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

function loadMeta(pk: string): NotificationMeta | null {
  try { const raw = localStorage.getItem(metaKeyFor(pk)!); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveMeta(pk: string, meta: NotificationMeta) {
  try { localStorage.setItem(metaKeyFor(pk)!, JSON.stringify(meta)); } catch {}
}

export const useNotificationsStore = defineStore("notifications", {
  state: () => ({
    list: [] as NotificationItem[],
    loadedFor: "" as string,
    dismissed: new Set<string>(),
    meta: null as NotificationMeta | null,
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
        const raw = localStorage.getItem(notificationsKeyFor(targetPk)!);
        const stored = raw ? JSON.parse(raw) : [];
        // Normal posts belong in Home, not Notifications. Remove legacy
        // message notifications account-by-account as they are loaded.
        this.list = Array.isArray(stored)
          ? stored.filter((item: NotificationItem & { type?: string }) => item?.type === "like" || item?.type === "comment")
          : [];
        if (Array.isArray(stored) && this.list.length !== stored.length) {
          localStorage.setItem(notificationsKeyFor(targetPk)!, JSON.stringify(this.list));
        }
      } catch { this.list = []; }

      // 2. 加载屏蔽列表
      try {
        const raw = localStorage.getItem(dismissedKeyFor(targetPk)!);
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

      // 4. 填充缺失内容
      this.refreshContent();
    },

    // 提取出的内容刷新逻辑
    refreshContent() {
      const interactions = useInteractionsStore();
      this.list.forEach(n => {
        if (n.commentId && !n.commentContent) {
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
        localStorage.setItem(notificationsKeyFor(pk)!, JSON.stringify(this.list));
        localStorage.setItem(dismissedKeyFor(pk)!, JSON.stringify([...this.dismissed]));
        if (this.meta) saveMeta(pk, this.meta);
      } catch {}
    },

    addNotification(n: NotificationItem) {
      if (n.type !== "like" && n.type !== "comment") return;
      // 这里的逻辑修复最重要：
      // 1. 检查是否重复
      if (this.list.some(x => x.id === n.id)) return;
      if (this.dismissed.has(n.id)) return;
      
      // 2. 检查是否是太旧的历史记录（超过3天就不收了）
      const threeDaysAgo = Math.floor(Date.now() / 1000) - (FIRST_LOGIN_DAYS * DAY_SECONDS);
      if (n.created_at < threeDaysAgo) return;

      // 3. 填充内容
      if (n.commentId) {
        const interactions = useInteractionsStore();
        const comment = interactions.getComments(n.messageId).find(c => c.id === n.commentId);
        if (comment) {
          n.commentContent = comment.text;
          if (comment.parentCommentId) n.replyId = comment.parentCommentId;
        }
      }

      // 4. 插入列表并排序
      this.list.unshift(n);
      this.list.sort((a, b) => b.created_at - a.created_at);
      
      // 5. 保持列表不要无限长（比如只留200条）
      if (this.list.length > 200) this.list = this.list.slice(0, 200);

      this.save();
    },

    markAsRead(id: string) { 
      const n = this.list.find(x => x.id === id); 
      if (!n) return;
      n.read = true;
      // 只有读取了更新的消息，才更新 lastSeenAt
      if (this.meta) {
        this.meta.lastSeenAt = Math.max(this.meta.lastSeenAt, n.created_at);
      }
      this.save();
    },

    markAllRead() {
      const now = Math.floor(Date.now() / 1000);
      this.list.forEach(n => { n.read = true; });
      if (this.meta) {
        this.meta.lastSeenAt = now;
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
      this.loadedFor = "";
      if (removeFromStorage && pk) {
        try {
          localStorage.removeItem(notificationsKeyFor(pk)!);
          localStorage.removeItem(dismissedKeyFor(pk)!);
          localStorage.removeItem(metaKeyFor(pk)!);
        } catch {}
      }
    },
  },
});
