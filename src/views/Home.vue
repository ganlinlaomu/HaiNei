<template>
  <div 
    class="home-container app-page" ref="container"
  >
    <div
      class="pull-indicator"
      :style="{ height: pullDistance + 'px' }"
    >
      <span v-if="!refreshing">↓ 下拉刷新</span>
      <span v-else>⟳ 刷新中...</span>
    </div>
    
    <!-- New messages notification -->
    <div 
      v-if="pendingMessages.length > 0" 
      class="new-messages-notification" 
      role="button"
      tabindex="0"
      :aria-label="`有 ${pendingMessages.length} 条新动态，点击查看`"
      @click="showPendingMessages"
      @keyup.enter="showPendingMessages"
      @keyup.space.prevent="showPendingMessages"
    >
      <span class="notification-icon">↓</span>
      <span class="notification-text">{{ pendingMessages.length }} 条新动态</span>
    </div>


    <div ref="feedElement" class="feed">
      <div v-if="displayedMessages.length === 0" class="empty-feed">
        <strong>这里还没有动态</strong>
        <span>添加好友后，他们的动态会显示在这里。</span>
        <button type="button" @click="router.push('/friends')">添加好友</button>
      </div>
      <div v-if="topSpacerHeight" class="virtual-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true"></div>
      <PostCard
        v-for="m in virtualMessages"
        :key="m.id"
        :message="m"
        :open-comment-id="route.query.mid === m.id ? String(route.query.iid || '') : undefined"
        @height="recordPostHeight"
      />
      <div v-if="bottomSpacerHeight" class="virtual-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true"></div>
      
      <!-- 加载更多按钮 -->
      <div v-if="hasMore" class="load-more-container">
        <button 
          class="load-more-btn" 
          @click="loadMoreMessages" 
          :disabled="isLoadingMore"
        >
          <span v-if="!isLoadingMore">加载更多 (还有 {{ remainingMessagesCount }} 条)</span>
          <span v-else>加载中...</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, computed, watch, nextTick } from "vue";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { getRelaysFromStorage } from "@/nostr/relays";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { isInteractionMessage, useInteractionsStore } from "@/stores/interactions";
import { useSettingsStore } from "@/stores/settings";
import { logger } from "@/utils/logger";
import PostCard from "@/components/PostCard.vue";
import { useRoute, useRouter } from "vue-router";
import { usePullToRefresh } from "@/components/usePullToRefresh";
import { getLastSeenCreatedAt, updateLastSeenToNewest } from "@/utils/lastSeen";
import { useRealtimeInboxReconcile } from "@/components/useRealtimeInboxReconcile";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { accountMessageSyncManager } from "@/services/accountMessageSync";
import { createHomeMessageHandler, incomingFriendRequestNotification } from "@/nostr/messaging/homeDelivery";
import { decodeFriendshipControl } from "@/nostr/messaging/friendshipControl";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { registerOutgoingPushSigner } from "@/nostr/messaging/service";
import { isDirectMessageTags } from "@/nostr/messaging/directMessages";
import { isDmReceiptMessage, isDmReceiptPayload } from "@/nostr/messaging/dmReceipts";
import { isAuthorizedCanonicalDirectMessage, useDirectMessagesStore } from "@/stores/directMessages";
import { buildHeightPrefix, resolveVirtualRange, updateHeightPrefix } from "@/utils/virtualFeed";
import { loadHomeScroll, saveHomeScroll } from "@/utils/homeScroll";


// Constants for scroll and layout calculations
const SCROLL_SAFE_OFFSET = 20; // Extra padding to ensure elements are fully visible
const AUTO_LOAD_MORE_THRESHOLD = 420;
const SCROLL_CONTAINER_SELECTOR = 'body > #app'; // Main scrollable container

function bottomNavigationHeight() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--bottom-nav-height");
  return Number.parseFloat(value) || 0;
}

function compareHomeMessages(a: { id: string; created_at?: number }, b: { id: string; created_at?: number }) {
  return (b.created_at || 0) - (a.created_at || 0) || String(a.id).localeCompare(String(b.id));
}

export default defineComponent({
  name: "Home",
  components: { PostCard },
  setup() {
    const friends = useFriendsStore();
    const friendships = useFriendshipsStore();
    const keys = useKeyStore();
    const msgs = useMessagesStore();
    const directMessages = useDirectMessagesStore();
    const interactions = useInteractionsStore();
    const settings = useSettingsStore();
    const notifications = useNotificationsStore();
    const profiles = useProfilesStore();
    const feedPreferences = useFeedPreferencesStore();
    const readyForPending = ref(false);
    const route = useRoute();
    const router = useRouter();
    const realtimeSessionSince = ref(0);
    const notificationJumpDone = ref(false);
    const lastSeenCreatedAt = ref(0); // Track the watermark for filtering pending messages
    const inboxRevision = computed(() => msgs.inboxRevision);
    const feedPreferenceRevision = computed(() => feedPreferences.revision);
    const isHomeRenderable = (message: InboxItem) => !isDirectMessageTags(message.tags)
      && !isDmReceiptMessage({ tags: message.tags })
      && !isDmReceiptPayload(message.content);
    const visibleInbox = () => msgs.inbox.filter(message => isHomeRenderable(message) && feedPreferences.isVisible(message));

    const status = ref("未连接");
    let homeAccountPk = "";
    let homeSyncGeneration = 0;
    const messageSync = accountMessageSyncManager;

    const messagesRef = ref([] as InboxItem[]);
    const displayedMessages = ref([] as InboxItem[]);
    let visibleInboxMessageRevision = -1;
    let visibleInboxPreferenceRevision = -1;

    function insertSortedHomeMessage(current: InboxItem[], item: InboxItem) {
      let low = 0;
      let high = current.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (compareHomeMessages(item, current[mid]) < 0) high = mid;
        else low = mid + 1;
      }
      return [...current.slice(0, low), item, ...current.slice(low)];
    }

    function rebuildVisibleInbox() {
      messagesRef.value = visibleInbox().sort(compareHomeMessages);
    }

    function refreshVisibleInbox(force = false): {
      changed: boolean;
      mode: "none" | "incremental" | "rebuild";
      inserted?: InboxItem;
    } {
      const messageRevision = msgs.inboxRevision;
      const preferenceRevision = feedPreferences.revision;
      if (!force
        && messageRevision === visibleInboxMessageRevision
        && preferenceRevision === visibleInboxPreferenceRevision) {
        return {
      keys,
      displayedMessages,
      pendingMessages,
      status,
      showPendingMessages,
      container,
      pullDistance,
      refreshing,
      hasMore,
      isLoadingMore,
      loadMoreMessages,
      remainingMessagesCount,
      virtualMessages,
      topSpacerHeight,
      bottomSpacerHeight,
      feedElement,
      recordPostHeight,
      route,
      router
    };
  }
});
</script>

<style scoped>
.empty-feed{display:flex;min-height:42vh;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:24px;color:#64748b;text-align:center}.empty-feed strong{color:#0f1419;font-size:19px}.empty-feed span{font-size:14px}.empty-feed button{min-height:40px;margin-top:8px;padding:0 18px;border:0;border-radius:999px;background:#0f1419;color:#fff;font-size:14px;font-weight:650}

.home-container {
  position: relative;
  min-height: 100vh;
  overscroll-behavior: contain;
  padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
}


.refresh-icon {
  font-size: 24px;
  margin-bottom: 8px;
  transition: transform 0.3s ease;
}

.refresh-icon.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
:deep(.post-card.home-new-highlight){animation:home-new-post-highlight 1.25s ease}
@keyframes home-new-post-highlight{0%,35%{box-shadow:0 0 0 3px rgba(37,99,235,.18)}100%{box-shadow:0 2px 8px rgba(15,23,42,.035)}}

.refresh-text {
  font-size: 14px;
  color: #64748b;
  font-weight: 500;
}

.new-messages-notification {
  position: sticky;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 10px 20px;
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  z-index: 999;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 12px;
  animation: slideDown 0.3s ease;
  transition: all 0.2s;
  width: fit-content;
  max-width: calc(100% - 24px);
}

@media (max-width: 767px) {
  .new-messages-notification {
    position: fixed;
    top: calc(env(safe-area-inset-top) + 12px);
    left: 50%;
    margin: 0;
    z-index: 1200;
  }
}

.new-messages-notification:hover {
  transform: translateX(-50%) scale(1.02);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
}

.new-messages-notification:active {
  transform: translateX(-50%) scale(0.98);
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

.notification-icon {
  font-size: 16px;
  animation: bounce 1s ease infinite;
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

.notification-text {
  font-size: 14px;
}

.small { font-size:12px; color:#64748b; }
.feed {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 8px 20px;
}
.post-card {
  background: #fff;
  padding: 14px;
  border: 1px solid #e8edf3;
  border-radius: 14px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.035);
}
.empty-feed {
  padding: 56px 20px;
  text-align: center;
  color: #94a3b8;
}
.post-author {
  display: flex;
  align-items: center;
  gap: 10px;
}
.author-avatar {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.author-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.author-copy strong { color: #172033; font-size: 14px; }
.author-copy time { color: #94a3b8; font-size: 12px; }
.muted { color: #94a3b8; font-size: 12px; margin-left:6px; }
.message-text {
  margin-top: 10px;
  color: #202938;
  font-size: 15px;
  line-height: 1.62;
  white-space: pre-wrap;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
  max-width: 100%;
}
.expand-text {
  display: block;
  min-height: 34px;
  padding: 4px 0 0;
  border: 0;
  background: transparent;
  color: #2563eb;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.post-video { margin-top: 10px; }

.message-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  margin-top: 12px;
  padding-top: 9px;
  border-top: 1px solid #f1f5f9;
}

.message-expanded {
  margin-top: 0;
}


.action-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  cursor: pointer;
  min-height: 38px;
  padding: 6px 11px;
  border-radius: 8px;
  transition: all 0.2s;
  font-size: 14px;
  color: #64748b;
}

.action-btn:hover {
  background: #f8fafc;
}

.action-btn.liked {
  color: #ef4444;
}

.action-count { color: #94a3b8; font-size: 12px; }
.visibility-btn { color: #475569; }

.comments-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
}

.comments-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
  max-height: 300px;
  overflow-y: auto;
}

.comment-item {
  background: #f8fafc;
  padding: 8px;
  border-radius: 6px;
}

.comment-header {
  margin-bottom: 4px;
}

.comment-text {
  font-size: 13px;
  color: #1e293b;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.comment-input {
  flex: 1;
  min-width: 0; /* Allow flex item to shrink below its content size */
  padding: 8px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  /* Prevent iOS zoom on focus */
  font-size: 16px;
  box-sizing: border-box;
  max-width: 100%;
  width: 100%;
  /* Better mobile input handling */
  -webkit-appearance: none;
  touch-action: manipulation;
}

.comment-input:focus {
  outline: none;
  border-color: #1976d2;
}

.comment-submit {
  background: #1976d2;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  flex-shrink: 0; /* Prevent button from shrinking */
  white-space: nowrap; /* Prevent text wrapping */
}

.comment-submit:hover:not(:disabled) {
  background: #1565c0;
}

.comment-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.reply-btn {
  background: transparent;
  border: none;
  color: #64748b;
  cursor: pointer;
  padding: 4px 0;
  margin-top: 4px;
  font-size: 12px;
  transition: color 0.2s;
}

.reply-btn:hover {
  color: #1976d2;
}

.comment-thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.replies-list {
  margin-left: 24px;
  padding-left: 12px;
  border-left: 2px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reply-item {
  background: #ffffff;
  border: 1px solid #e2e8f0;
}

.replying-indicator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: #eff6ff;
  border-radius: 6px;
  margin-bottom: 4px;
  color: #1976d2;
}

.cancel-reply-btn {
  background: transparent;
  border: none;
  color: #64748b;
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
  transition: color 0.2s;
}

.cancel-reply-btn:hover {
  color: #dc2626;
}

.comment-input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comment-input-wrapper {
  display: flex;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.send-meta {
  margin-left: auto;
  position: relative;
}


.send-meta-panel {
  margin-top: 8px;
  padding: 10px 12px;
  background: #f8fafc;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
}

.send-meta-title {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 6px;
}

.send-meta-groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.send-meta-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.group-name {
  color: #0f172a;
}

.group-count {
  color: #64748b;
}
.highlight {
  animation: flash 1.5s ease;
}

@keyframes flash {
  0%   { background: rgba(59,130,246,0.15); }
  100% { background: transparent; }
}

.pull-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #666;
  transition: height 0.2s ease;
  overflow: hidden;
  position: sticky;
  top: 0;
  z-index: 10;
}

.load-more-container {
  display: flex;
  justify-content: center;
  padding: var(--load-more-padding) 12px;
}

.load-more-btn {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 20px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  transition: all 0.2s;
}

.load-more-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
}

.load-more-btn:active:not(:disabled) {
  transform: translateY(0);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.message-text-top {
  margin-bottom: 8px;
}
.post-images {
  margin-top: 0;
}

@media (min-width: 640px) {
  .feed { padding-right: 0; padding-left: 0; }
  .post-card { padding: 16px; }
}

@media (prefers-reduced-motion: reduce) {
  .new-messages-notification,
  .notification-icon,
  .highlight { animation: none; }
}
</style>
