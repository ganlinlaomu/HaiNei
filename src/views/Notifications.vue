<template>
  <div class="notifications-page">
    <header class="page-header">
      <h2>通知</h2>
      <button
        v-if="notifications.unreadCount > 0"
        class="mark-read"
        @click="notifications.markAllRead()"
      >
        全部已读
      </button>
    </header>

    <div class="notification-tabs" role="tablist" aria-label="通知分类">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="notification-tab"
        :class="{ active: activeTab === tab.value }"
        role="tab"
        :aria-selected="activeTab === tab.value"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="filteredNotifications.length === 0" class="empty">
      暂无通知
    </div>

    <div class="notification-groups">
      <!-- 今天 -->
      <template v-if="groups.today.length">
        <div class="group-title">今天</div>
        <TransitionGroup name="notify" tag="ul" class="notification-list">
          <li
            v-for="n in groups.today"
            :key="n.id"
            class="swipe-wrapper"
            @touchstart="onTouchStart($event, n.id)"
            @touchmove="onTouchMove($event, n.id)"
            @touchend="onTouchEnd(n.id)"
          >
            <div class="swipe-actions">
              <button class="action read" @click.stop="markRead(n)">已读</button>
              <button class="action delete" @click.stop="dismiss(n)">忽略</button>
            </div>

            <div
              class="notification-item"
              :class="{ unread: !n.read }"
              :style="swipeStyle(n.id)"
              @click="go(n)"
            >
              <div class="notification-identity">
                <ProfileAvatar :pubkey="n.from" :local-name="localName(n.from)" :size="36" />
                <NotificationTypeIcon :kind="notificationIconType(n)" />
              </div>

              <div class="content">
                <div class="text">
                  <span class="from">{{ displayName(n.from) }}</span>
                  {{ notificationAction(n) }}
                </div>

                <!-- 评论/回复或点赞对应帖子内容 -->
                <div class="comment-content">
                  {{ getNotificationContent(n) }}
                </div>

                <div class="time">
                  {{ formatRelativeTime(n.created_at) }}
                </div>
              </div>

              <span v-if="!n.read" class="dot"></span>
            </div>
          </li>
        </TransitionGroup>
      </template>

      <!-- 昨天 -->
      <template v-if="groups.yesterday.length">
        <div class="group-title">昨天</div>
        <TransitionGroup name="notify" tag="ul" class="notification-list">
          <li
            v-for="n in groups.yesterday"
            :key="n.id"
            class="swipe-wrapper"
            @touchstart="onTouchStart($event, n.id)"
            @touchmove="onTouchMove($event, n.id)"
            @touchend="onTouchEnd(n.id)"
          >
            <div class="swipe-actions">
              <button class="action read" @click.stop="markRead(n)">已读</button>
              <button class="action delete" @click.stop="dismiss(n)">忽略</button>
            </div>

            <div
              class="notification-item"
              :class="{ unread: !n.read }"
              :style="swipeStyle(n.id)"
              @click="go(n)"
            >
              <div class="notification-identity">
                <ProfileAvatar :pubkey="n.from" :local-name="localName(n.from)" :size="36" />
                <NotificationTypeIcon :kind="notificationIconType(n)" />
              </div>

              <div class="content">
                <div class="text">
                  <span class="from">{{ displayName(n.from) }}</span>
                  {{ notificationAction(n) }}
                </div>

                <div class="comment-content">
                  {{ getNotificationContent(n) }}
                </div>

                <div class="time">
                  {{ formatRelativeTime(n.created_at) }}
                </div>
              </div>

              <span v-if="!n.read" class="dot"></span>
            </div>
          </li>
        </TransitionGroup>
      </template>

      <!-- 更早 -->
      <template v-if="groups.earlier.length">
        <div class="group-title">更早</div>
        <TransitionGroup name="notify" tag="ul" class="notification-list">
          <li
            v-for="n in groups.earlier"
            :key="n.id"
            class="swipe-wrapper"
            @touchstart="onTouchStart($event, n.id)"
            @touchmove="onTouchMove($event, n.id)"
            @touchend="onTouchEnd(n.id)"
          >
            <div class="swipe-actions">
              <button class="action read" @click.stop="markRead(n)">已读</button>
              <button class="action delete" @click.stop="dismiss(n)">忽略</button>
            </div>

            <div
              class="notification-item"
              :class="{ unread: !n.read }"
              :style="swipeStyle(n.id)"
              @click="go(n)"
            >
              <div class="notification-identity">
                <ProfileAvatar :pubkey="n.from" :local-name="localName(n.from)" :size="36" />
                <NotificationTypeIcon :kind="notificationIconType(n)" />
              </div>

              <div class="content">
                <div class="text">
                  <span class="from">{{ displayName(n.from) }}</span>
                  {{ notificationAction(n) }}
                </div>

                <div class="comment-content">
                  {{ getNotificationContent(n) }}
                </div>

                <div class="time">
                  {{ formatRelativeTime(n.created_at) }}
                </div>
              </div>

              <span v-if="!n.read" class="dot"></span>
            </div>
          </li>
        </TransitionGroup>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useNotificationsStore } from "@/stores/notifications";
import { useFriendsStore } from "@/stores/friends";
import { useRouter } from "vue-router";
import { useInteractionsStore } from "@/stores/interactions";
import { useMessagesStore } from "@/stores/messages";
import NotificationTypeIcon from "@/components/NotificationTypeIcon.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { useKeyStore } from "@/stores/keys";
import { localProfileName, profileDisplayName } from "@/services/profileCache";

const notifications = useNotificationsStore();
const friends = useFriendsStore();
const interactions = useInteractionsStore();
const messagesStore = useMessagesStore();
const router = useRouter();
const keys = useKeyStore();

type NotificationTab = "all" | "comments" | "likes" | "friends";
const activeTab = ref<NotificationTab>("all");
const tabs: Array<{ value: NotificationTab; label: string }> = [
  { value: "all", label: "全部" },
  { value: "comments", label: "回复/评论" },
  { value: "likes", label: "点赞" },
  { value: "friends", label: "好友请求" },
];
const filteredNotifications = computed(() => notifications.visibleList.filter(item => {
  if (activeTab.value === "comments") return item.type === "comment";
  if (activeTab.value === "likes") return item.type === "like";
  if (activeTab.value === "friends") return item.type === "friend_request";
  return true;
}));

const friendsByPubkey = computed(() =>
  new Map(friends.sortedList.map(friend => [friend.pubkey, friend]))
);
const messagesById = computed(() =>
  new Map(messagesStore.inbox.map(message => [message.id, message]))
);

/* ---------- 时间分组 ---------- */
function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const groups = computed(() => {
  const todayStart = startOfDay(Date.now());
  const yesterdayStart = todayStart - 86400000;

  const res = { today: [], yesterday: [], earlier: [] } as any;

  [...filteredNotifications.value]
    .sort((a, b) => b.created_at - a.created_at)
    .forEach(n => {
      const t = n.created_at * 1000;
      if (t >= todayStart) res.today.push(n);
      else if (t >= yesterdayStart) res.yesterday.push(n);
      else res.earlier.push(n);
    });

  return res;
});

/* ---------- 相对时间 ---------- */
function formatRelativeTime(ts: number) {
  const diff = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5);
}

/* ---------- 左滑 ---------- */
const swipe = reactive<Record<string, number>>({});
const startX = reactive<Record<string, number>>({});

function onTouchStart(e: TouchEvent, id: string) {
  startX[id] = e.touches[0].clientX;
}
function onTouchMove(e: TouchEvent, id: string) {
  const dx = e.touches[0].clientX - startX[id];
  swipe[id] = Math.min(0, Math.max(dx, -120));
}
function onTouchEnd(id: string) {
  swipe[id] = swipe[id] < -60 ? -120 : 0;
}
function swipeStyle(id: string) {
  return { transform: `translateX(${swipe[id] || 0}px)` };
}

/* ---------- 操作 ---------- */
function markRead(n: any) {
  notifications.markAsRead(n.id);
  swipe[n.id] = 0;
}
function dismiss(n: any) {
  notifications.dismiss(n.id);
  swipe[n.id] = 0;
}
function displayName(pk: string) {
  return profileDisplayName(keys.pkHex, pk, localName(pk));
}
function localName(pk: string) { return localProfileName(pk, friendsByPubkey.value.get(pk)?.name); }
function notificationIconType(n: any): "like" | "comment" | "reply" | "friend" {
  if (n.type === "like") return "like";
  if (n.type === "friend_request") return "friend";
  return n.replyId ? "reply" : "comment";
}
function notificationAction(n: any) {
  if (n.type === "like") return "点赞了你";
  if (n.type === "friend_request") return "请求添加你为好友";
  return n.replyId ? "回复了你的评论" : "评论了你";
}
function go(n: any) {
  notifications.markAsRead(n.id);
  if (n.type === "friend_request") {
    router.push({ path: "/friends", query: { section: "incoming" } });
    return;
  }
  router.push({ path: "/", query: { mid: n.messageId, iid: n.commentId, rid: n.replyId } });
}

/* ---------- 评论/回复/点赞内容 ---------- */
function getNotificationContent(n: any) {
  if (n.type === "friend_request") return "前往好友页面处理请求";
  const allInteractions = interactions.getComments(n.messageId);
  const rootPost = messagesById.value.get(n.messageId);
  
  const rootSummary = summarizeNotificationText(rootPost?.content || rootPost?.text || "");

  // 处理点赞
  if (n.type === "like") {
    const targetId = n.replyId || n.commentId;
    if (targetId) {
      const target = allInteractions.find(c => c.id === targetId);
      return summarizeNotificationText(target?.text || "已删除消息");
    }
    return rootSummary || "[媒体动态]";
  }

  // 处理评论或回复
  const targetId = n.replyId || n.commentId;
  const actionNode = allInteractions.find(c => c.id === targetId);
  
  if (targetId && actionNode) {
    const actionSummary = summarizeNotificationText(actionNode.text);
    // 这里的格式为: "评论内容 // 原帖: 原帖内容"
    return rootSummary 
      ? `${actionSummary} // 原帖: ${rootSummary}` 
      : actionSummary;
  }

  return rootSummary || "[媒体动态]";
}

function summarizeNotificationText(text: string, maxLength = 40) {
  if (!text) return "[媒体动态]";
  let cleanText = text
    .replace(/!\[.*?\]\(blossom\+aesgcm:[^\s)]+\)/gi, "[加密图片]")
    .replace(/\[video:\{.*?\}\]/gi, "[视频]")
    .replace(/https?:\/\/[^\s]+/gi, "[链接]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleanText.length > maxLength) cleanText = `${cleanText.slice(0, maxLength)}...`;
  return cleanText || "[媒体动态]";
}
</script>

<style scoped>
/* === 保持原排版 === */
.notifications-page {
  padding: 12px;
  padding-bottom: calc(20px + var(--bottom-nav-height) + env(safe-area-inset-bottom));
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.notification-tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  margin: 0 -2px 10px;
  padding: 2px;
  scrollbar-width: none;
}
.notification-tabs::-webkit-scrollbar { display: none; }
.notification-tab {
  min-height: 36px;
  padding: 0 13px;
  flex: 0 0 auto;
  border-radius: 18px;
  color: #64748b;
  background: #f1f5f9;
  font-size: 13px;
}
.notification-tab.active {
  color: #fff;
  background: #2563eb;
}
.mark-read {
  font-size: 12px;
  color: #64748b;
}
.empty {
  text-align: center;
  color: #94a3b8;
  margin-top: 40px;
}
.group-title {
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  margin: 14px 4px 6px;
}
.notification-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.swipe-wrapper {
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid #e5e7eb;
}
.swipe-actions {
  position: absolute;
  right: 0;
  top: 0;
  height: 100%;
  display: flex;
}
.action {
  width: 60px;
  color: #fff;
  font-size: 12px;
  border: none;
}
.action.read {
  background: #3b82f6;
}
.action.delete {
  background: #ef4444;
}
.notification-item {
  display: flex;
  gap: 10px;
  padding: 10px;
  background: #fff;
  position: relative;
  transition: transform 0.2s ease;
}
.notification-item.unread {
  background: #f8fafc;
}
.notification-identity {
  position: relative;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
}
.notification-identity :deep(.notification-type-icon) {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 18px;
  height: 18px;
  border: 2px solid #fff;
}
.notification-identity :deep(.notification-type-icon svg) {
  width: 11px;
  height: 11px;
}
.content {
  flex: 1;
}
.from {
  font-weight: 600;
}
.comment-content {
  font-size: 13px;
  color: #334155;
  margin-top: 2px;
  white-space: pre-line;
  word-break: break-word;
}
.time {
  font-size: 12px;
  color: #64748b;
}
.dot {
  width: 8px;
  height: 8px;
  background: #ef4444;
  border-radius: 50%;
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
}
.notify-enter-active {
  transition: all 0.25s ease;
}
.notify-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
</style>
