<template>
  <div 
    class="home-container" ref="container"
  >
    <div
      class="pull-indicator"
      :style="{ height: pullDistance + 'px' }"
    >
      <span v-if="!refreshing">↓ 下拉刷新</span>
      <span v-else>⟳ 刷新中...</span>
    </div>
    
    <!-- New messages notification - only show on PC/desktop (non-touch devices) -->
    <div 
      v-if="pendingMessages.length > 0" 
      class="new-messages-notification" 
      role="button"
      tabindex="0"
      :aria-label="`有 ${pendingMessages.length} 条新消息，点击查看`"
      @click="showPendingMessages"
      @keyup.enter="showPendingMessages"
      @keyup.space.prevent="showPendingMessages"
    >
      <span class="notification-icon">↓</span>
      <span class="notification-text">{{ pendingMessages.length }} 条新消息</span>
    </div>


    <div class="card">
      <h4 style="margin: 0 0 12px 0;">好友动态</h4>
      <div v-if="displayedMessages.length === 0" class="small">还没有消息</div>
      <div class="list">
        <div v-for="m in displayedMessages" :key="m.id" :id="`msg-${m.id}`" class="card">
          <div class="small">
            {{ displayName(m.pubkey) }}
            <span class="muted"> · {{ toLocalTime(m.created_at) }}</span>
          </div>
          <!-- 如果仍需显示文本（去除了图片 URL/Markdown），使用 textWithoutVideos -->
          <div v-if="textWithoutVideos(m.content)" class="message-text message-text-top">{{ textWithoutVideos(m.content) }}</div>
          <!-- 图片预览（9宫格展示多图） -->
          <PostImagePreview v-if="m.content" :content="m.content" :showAll="true" :max="9" class="post-images" />

          <!-- 视频预览 -->
          <VideoPlayer v-if="extractVideoData(m.content)" :videoData="extractVideoData(m.content)" style="margin-top:8px;" />
          
          <!-- 操作按钮：点赞和评论 -->
          <div class="message-actions">
            <button class="action-btn" @click="toggleLike(m)" :class="{ 'liked': isLiked(m.id) }">
              <span class="action-icon">{{ isLiked(m.id) ? '❤️' : '🤍' }}</span>
              <span class="action-text">{{ getLikeCount(m.id) }}</span>
            </button>
            <button class="action-btn" @click="toggleComments(m.id)">
              <span class="action-icon">💬</span>
              <span class="action-text">{{ getCommentCount(m.id) }}</span>
            </button>
            <!-- SEND META (only author) -->
            <div v-if="m._localMeta?.groupCount" class="send-meta">
             <button
               class="action-btn send-btn"
               @click="toggleSendMeta(m.id)"
             >
               <span class="action-icon">👀</span>
               <span class="action-text">{{ m._localMeta.groupCount }}</span>
            </button>
          </div>

          </div>
<div class="message-expanded">

           <!-- SEND META EXPANDED (like comments) -->
<div
  v-if="showingSendMeta.has(m.id)"
  class="send-meta-panel"
>
  <div class="send-meta-title">对谁可见:</div>

  <div class="send-meta-groups">
    <div
      v-for="g in m._localMeta.groups"
      :key="g.name"
      class="send-meta-row"
    >
      <span class="group-name">{{ g.name }}</span>
      <span class="group-count">{{ g.count }} 人</span>
    </div>
  </div>
</div>

          <!-- 评论区域 -->
          <div v-if="showingComments.has(m.id)" class="comments-section">
            <div class="comments-list">
              <div v-for="comment in getComments(m.id)" :key="comment.id"  class="comment-thread">
                <!-- 主评论 -->
                <div class="comment-item" :id="`comment-${comment.id}`">
                  <div class="comment-header small">
                    <strong>{{ displayName(comment.author) }}</strong>
                    <span class="muted"> · {{ toLocalTime(comment.timestamp) }}</span>
                  </div>
                  <div class="comment-text">{{ comment.text }}</div>
                  <button class="reply-btn small" @click="startReply(m.id, comment.id, displayName(comment.author))">
                    回复
                  </button>
                </div>
                
                <!-- 回复列表 -->
                <div v-if="getReplies(m.id, comment.id).length > 0" class="replies-list">
                  <div v-for="reply in getReplies(m.id, comment.id)" :key="reply.id" class="comment-item reply-item">
                    <div class="comment-header small">
                      <strong>{{ displayName(reply.author) }}</strong>
                      <span class="muted"> · {{ toLocalTime(reply.timestamp) }}</span>
                    </div>
                    <div class="comment-text">{{ reply.text }}</div>
                    <!-- 不显示回复按钮，因为只支持两层评论 -->
                  </div>
                </div>
              </div>
              <div v-if="getComments(m.id).length === 0" class="small muted">暂无评论</div>
            </div>
            
            <!-- 评论输入框 -->
            <div class="comment-input-container">
              <div v-if="replyingTo[m.id]" class="replying-indicator small">
                <span>正在回复...</span>
                <button class="cancel-reply-btn" @click="cancelReply(m.id)">✕</button>
              </div>
              <div class="comment-input-wrapper">
                <input 
                  v-model="commentInputs[m.id]" 
                  class="comment-input" 
                  placeholder="写下你的评论..."
                  :data-message-id="m.id"
                  @keyup.enter="addComment(m.id)"
                />
                <button class="comment-submit" @click="addComment(m.id)" :disabled="!commentInputs[m.id]?.trim()">
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
      
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
import { defineComponent, ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from "vue";
import { useFriendsStore } from "@/stores/friends";
import { useKeyStore } from "@/stores/keys";
import { getRelaysFromStorage } from "@/nostr/relays";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { isInteractionMessage, useInteractionsStore } from "@/stores/interactions";
import { useNotificationsStore } from "@/stores/notifications";
import { logger } from "@/utils/logger";
import { formatRelativeTime } from "@/utils/format";
import PostImagePreview from "@/components/PostImagePreview.vue";
import VideoPlayer from "@/components/VideoPlayer.vue";
import { useRoute } from "vue-router";
import { usePullToRefresh } from "@/components/usePullToRefresh";
import { getLastSeenCreatedAt, setLastSeenCreatedAt, updateLastSeenToNewest } from "@/utils/lastSeen";
import { extractVideoData as extractVideoDataUtil, getVideoUrlRemovalPatterns } from "@/utils/videoUtils";
import { useRealtimeInboxReconcile } from "@/components/useRealtimeInboxReconcile";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { MessageSyncManager } from "@/nostr/messaging/sync";


// reuse the regex logic from extractImageUrls to strip out image markdown and plain image URLs
const mdImageRE = /!\[[^\]]*?\]\(\s*(https?:\/\/[^\s)]+)\s*\)/gi;
const plainImgUrlRE = /(https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)]*)?)/gi;
// Match encrypted image references in markdown: ![](blossom+aesgcm:...)
// This is needed to prevent raw encrypted markdown from appearing in the message text area
// while PostImagePreview handles the actual decryption and rendering
const mdEncryptedImageRE = /!\[[^\]]*?\]\(\s*(blossom\+aesgcm:[^\s)]+)\s*\)/gi;

// Video pattern: [video:{json}] - constant for video metadata format
const VIDEO_METADATA_PREFIX = '[video:';
const VIDEO_METADATA_SUFFIX = ']';
const videoDataRE = /\[video:(\{[^\]]+\})\]/g;

// Get video URL removal patterns for text cleanup
const videoUrlPatterns = getVideoUrlRemovalPatterns();

// Constants for scroll and layout calculations
const BOTTOM_NAV_HEIGHT = 80; // Must match --bottom-nav-height in styles.css
const SCROLL_SAFE_OFFSET = 20; // Extra padding to ensure elements are fully visible
const SCROLL_CONTAINER_SELECTOR = 'body > #app'; // Main scrollable container

export default defineComponent({
  name: "Home",
  components: { PostImagePreview, VideoPlayer },
  setup() {
    const friends = useFriendsStore();
    const keys = useKeyStore();
    const msgs = useMessagesStore();
    const interactions = useInteractionsStore();
    const notifications = useNotificationsStore();
    const readyForPending = ref(false);
    const route = useRoute();
    const realtimeSessionSince = ref(0);
    const notificationJumpDone = ref(false);
    const lastSeenCreatedAt = ref(0); // Track the watermark for filtering pending messages
    const inboxSnapshot = computed(() => `${msgs.inbox.length}:${msgs.inbox[0]?.id || ""}`);

    const status = ref("未连接");
    let homeAccountPk = "";
    const messageSync = new MessageSyncManager();

    const messagesRef = ref([] as any[]);
    const displayedMessages = ref([] as any[]);
    const pendingMessages = ref([] as any[]); // Messages fetched but not yet displayed
    const isInitialLoad = ref(true); // Track if this is the first load
    const showingSendMeta = ref<Set<string>>(new Set());
    
    // 分页相关状态
    const PAGE_SIZE = 20; // 每页显示 20 条
    const currentPage = ref(1); // 当前页码
    const hasMore = computed(() => {
      return messagesRef.value.length > displayedMessages.value.length;
    });
    const isLoadingMore = ref(false);
    const remainingMessagesCount = computed(() => {
      return messagesRef.value.length - displayedMessages.value.length;
    });

    function closeHomeSubscriptions() {
      messageSync.stop();
    }

    function clearHomeRuntimeState() {
      messagesRef.value = [];
      displayedMessages.value = [];
      pendingMessages.value = [];
      readyForPending.value = false;
      lastSeenCreatedAt.value = 0;
      realtimeSessionSince.value = 0;
      notificationJumpDone.value = false;
      homeAccountPk = "";
    }

    async function initializeHomeRuntime(accountPk: string) {
      await msgs.load(accountPk);
      if (!accountPk || keys.pkHex !== accountPk || msgs.loadedFor !== accountPk) {
        logger.warn(`[account] Home initialization discarded account=${accountPk?.slice(0, 8) || "none"}`);
        return false;
      }

      messagesRef.value = [...msgs.inbox].sort(
        (a, b) => (b.created_at || 0) - (a.created_at || 0)
      );
      displayedMessages.value = messagesRef.value.slice(0, PAGE_SIZE);
      currentPage.value = 1;
      isInitialLoad.value = false;

      const storedLastSeen = getLastSeenCreatedAt(accountPk) || 0;
      const newestInUI = displayedMessages.value[0]?.created_at || 0;
      lastSeenCreatedAt.value = Math.max(storedLastSeen, newestInUI);
      readyForPending.value = true;
      homeAccountPk = accountPk;
      updateLocalRefs();
      void handleNotificationJump().catch((e) => logger.warn("notification jump failed", e));
      return true;
    }

    
    
    // State for comments UI
    const showingComments = ref<Set<string>>(new Set());
    const commentInputs = ref<Record<string, string>>({});
    const replyingTo = ref<Record<string, string>>({}); // messageId -> commentId being replied to
    const replyingToAuthor = ref<Record<string, string>>({}); // messageId -> author pubkey of comment being replied to
    
    // State for message time range display
    const messageTimeRange = ref<string>("");
    
    /**
     * Merge two sorted arrays of messages with de-duplication by message ID
     * @param array1 First sorted array (descending by created_at)
     * @param array2 Second sorted array (descending by created_at)
     * @returns Merged and de-duplicated array, sorted by created_at (descending)
     */
    function mergeSortedMessagesWithDedup<T extends { id: string; created_at?: number }>(
      array1: T[],
      array2: T[]
    ): T[] {
      const merged: T[] = [];
      const seenIds = new Set<string>();
      let i = 0, j = 0;
      
      while (i < array1.length || j < array2.length) {
        if (i >= array1.length) {
          // Add remaining items from array2 (de-duplicating)
          for (let k = j; k < array2.length; k++) {
            if (!seenIds.has(array2[k].id)) {
              merged.push(array2[k]);
              seenIds.add(array2[k].id);
            }
          }
          break;
        }
        if (j >= array2.length) {
          // Add remaining items from array1 (de-duplicating)
          for (let k = i; k < array1.length; k++) {
            if (!seenIds.has(array1[k].id)) {
              merged.push(array1[k]);
              seenIds.add(array1[k].id);
            }
          }
          break;
        }
        // Merge based on timestamp, but de-duplicate by id
        if ((array1[i].created_at || 0) >= (array2[j].created_at || 0)) {
          if (!seenIds.has(array1[i].id)) {
            merged.push(array1[i]);
            seenIds.add(array1[i].id);
          }
          i++;
        } else {
          if (!seenIds.has(array2[j].id)) {
            merged.push(array2[j]);
            seenIds.add(array2[j].id);
          }
          j++;
        }
      }
      
      return merged;
    }
    
    
    function showPendingMessages() {
      if (pendingMessages.value.length > 0) {
        logger.info(`手动显示 ${pendingMessages.value.length} 条待显示消息`);
        // Sort pending messages first
        const sortedPending = [...pendingMessages.value].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        // Use efficient merge with de-duplication
        const merged = mergeSortedMessagesWithDedup(sortedPending, displayedMessages.value);
        displayedMessages.value = merged;
        
        // Update lastSeen watermark to the newest message timestamp across all displayed messages
        lastSeenCreatedAt.value = updateLastSeenToNewest(keys.pkHex, merged);
        logger.info(`更新 lastSeenCreatedAt: ${new Date(lastSeenCreatedAt.value * 1000).toLocaleString()}`);
        const visibleConversations = new Set(
          pendingMessages.value.map(message => message.conversationId).filter(Boolean)
        );
        for (const conversationId of visibleConversations) {
          void messageSync.markConversationRead(String(conversationId));
        }
        
        pendingMessages.value = [];
        updateMessageTimeRange();
      }
    }
    
    function updateLocalRefs() {
  // ① 按时间排序 inbox
  messagesRef.value = [...msgs.inbox].sort(
    (a, b) => (b.created_at || 0) - (a.created_at || 0)
  );

  if (!readyForPending.value) {
    updateMessageTimeRange();
    return;
  }

  const lastSeen = lastSeenCreatedAt.value;

  // ⭐ ② 真正的“新消息”定义：只看时间
  const newMessages = messagesRef.value.filter(m => {
  const ts = m.created_at || 0;

  // ⭐ 唯一标准：是否晚于 lastSeen
  return ts > lastSeen;
});

  if (newMessages.length === 0) {
    updateMessageTimeRange();
    return;
  }

  // ③ 区分自己 / 他人
  const ownMessages = newMessages.filter(m => m.pubkey === keys.pkHex);
  const othersMessages = newMessages.filter(m => m.pubkey !== keys.pkHex);

  // ④ 自己的消息：直接显示（不走 pending）
  if (ownMessages.length > 0) {
    const sortedOwn = ownMessages.sort(
      (a, b) => (b.created_at || 0) - (a.created_at || 0)
    );

    displayedMessages.value = mergeSortedMessagesWithDedup(
      sortedOwn,
      displayedMessages.value
    );
  }

  // ⑤ 别人的消息：全部进 pending（只要晚于 lastSeen）
  if (othersMessages.length > 0) {
    const combined = [...othersMessages, ...pendingMessages.value];
    const deduped = Array.from(
      new Map(combined.map(m => [m.id, m])).values()
    );

    pendingMessages.value = deduped.sort(
      (a, b) => (b.created_at || 0) - (a.created_at || 0)
    );
  }

  updateMessageTimeRange();
}
  // --------------------
// ⭐ 防重复触发包装（加在这里）
// --------------------
let reconcileScheduled = false;
let reconcilePending = false;

async function safeUpdateLocalRefs() {
  if (route.path !== "/") {
    reconcilePending = true;
    return;
  }
  if (reconcileScheduled) {
    reconcilePending = true;
    return;
  }
  reconcileScheduled = true;
  await new Promise<void>(resolve => {
    const run = () => {
      reconcileScheduled = false;
      updateLocalRefs();
      const shouldRunAgain = reconcilePending;
      reconcilePending = false;
      resolve();
      if (shouldRunAgain) void safeUpdateLocalRefs();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  });
}
    // 加载更多消息
    function loadMoreMessages() {
      if (isLoadingMore.value || !hasMore.value) return;
      
      isLoadingMore.value = true;
      logger.info(`加载更多消息，当前页: ${currentPage.value}`);
      
      // 使用 setTimeout 模拟异步加载，避免阻塞主线程
      setTimeout(() => {
        const startIndex = displayedMessages.value.length;
        const endIndex = Math.min(startIndex + PAGE_SIZE, messagesRef.value.length);
        const newMessages = messagesRef.value.slice(startIndex, endIndex);
        
        displayedMessages.value = [...displayedMessages.value, ...newMessages];
        currentPage.value++;
        isLoadingMore.value = false;
        updateMessageTimeRange();
        
        logger.info(`加载了 ${newMessages.length} 条消息，总共显示 ${displayedMessages.value.length} 条`);
      }, 100);
    }
    const {
       container,
       pullDistance,
       refreshing
    } = usePullToRefresh({
      onRefresh: async () => {
        await messageSync.resume("manual");
        safeUpdateLocalRefs();     // UI 刷新
      }
    });

    function updateMessageTimeRange() {
      if (displayedMessages.value.length === 0) {
        messageTimeRange.value = "";
        return;
      }
      
      // Calculate oldest and newest in displayed messages
      const { oldest, newest } = displayedMessages.value.reduce((acc, msg) => {
        const ts = msg?.created_at || 0;
        if (ts > 0) {
          if (acc.oldest === 0 || ts < acc.oldest) {
            acc.oldest = ts;
          }
          if (ts > acc.newest) {
            acc.newest = ts;
          }
        }
        return acc;
      }, { oldest: 0, newest: 0 });
      
      if (oldest > 0 && newest > 0) {
        const oldestDate = new Date(oldest * 1000);
        const newestDate = new Date(newest * 1000);
        messageTimeRange.value = `${oldestDate.toLocaleDateString('zh-CN')} - ${newestDate.toLocaleDateString('zh-CN')}`;
      }
    }

    const toLocalTime = (ts: number) => formatRelativeTime(ts);
    const shortPub = (s: string) => (s ? s.slice(0, 8) + "..." : "");
    const shortRelay = (r: string) => (r ? r.replace(/^wss?:\/\//, "").replace(/\/$/, "").slice(0, 22) : "");

    function displayName(pubkey: string) {
      if (!pubkey) return "未知用户";
      if (keys.pkHex && pubkey === keys.pkHex) return "自己";
      const f = (friends.list || []).find((x: any) => x.pubkey === pubkey);
      if (f && f.name && String(f.name).trim().length > 0) return f.name;
      // Return shortened public key as fallback
      return pubkey.slice(0, 8) + "...";
    }

    function mirrorSyncedMessage(message: CanonicalMessage) {
  msgs.addInbox({
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
    rootId: message.rootId
  });
}

    function textWithoutImages(content: string): string {
      if (!content) return "";
      // remove markdown image ![alt](url)
      let s = content.replace(mdImageRE, "");
      // remove encrypted image markdown ![](blossom+aesgcm:...)
      s = s.replace(mdEncryptedImageRE, "");
      // remove plain image urls
      s = s.replace(plainImgUrlRE, "");
      // remove video data
      s = s.replace(videoDataRE, "");
      // remove plain video URLs using patterns from utility
      s = s.replace(videoUrlPatterns.youtubePattern, "");
      s = s.replace(videoUrlPatterns.vimeoPattern, "");
      s = s.replace(videoUrlPatterns.directVideoPattern, "");
      // collapse multiple blank lines and trim
      s = s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      return s;
    }

    // Alias for backward compatibility - removes both images and videos
    function textWithoutVideos(content: string): string {
      return textWithoutImages(content);
    }

    function extractVideoData(content: string): any {
      // Use the shared utility function
      return extractVideoDataUtil(content);
    }

    // Like functionality
    async function toggleLike(message: any) {
      if (!keys.pkHex) return;
      
      const messageId = message.id;
      const isCurrentlyLiked = interactions.isLikedByUser(messageId, keys.pkHex);
      
      try {
        if (isCurrentlyLiked) {
          await interactions.removeLike(messageId, message.pubkey);
        } else {
          await interactions.sendLike(messageId, message.pubkey);
        }
      } catch (e: any) {
        logger.error("Toggle like failed", e);
      }
    }

    function isLiked(messageId: string): boolean {
      if (!keys.pkHex) return false;
      return interactions.isLikedByUser(messageId, keys.pkHex);
    }

    function getLikeCount(messageId: string): number {
      return interactions.getLikeCount(messageId);
    }

    function toggleSendMeta(messageId: string) {
  // ⭐ 关闭评论
  showingComments.value.delete(messageId);

  if (showingSendMeta.value.has(messageId)) {
    showingSendMeta.value.delete(messageId);
  } else {
    showingSendMeta.value.clear();
    showingSendMeta.value.add(messageId);
  }

  showingSendMeta.value = new Set(showingSendMeta.value);
  showingComments.value = new Set(showingComments.value);
}



    // Comment functionality
    function toggleComments(messageId: string) {
     // ⭐ 关闭 send-meta
     showingSendMeta.value.delete(messageId);

     if (showingComments.value.has(messageId)) {
        showingComments.value.delete(messageId);
     } else {
       showingComments.value.clear();
       showingComments.value.add(messageId);
     }

     showingComments.value = new Set(showingComments.value);
     showingSendMeta.value = new Set(showingSendMeta.value);
    }

    async function addComment(messageId: string) {
      if (!keys.pkHex) return;
      const text = commentInputs.value[messageId]?.trim();
      if (!text) return;

      // Find the message to get the author
      const message = msgs.inbox.find((m) => m.id === messageId);
      if (!message) return;

      try {
        const parentCommentId = replyingTo.value[messageId];
        // Determine recipient: if replying to a comment, send to comment author; otherwise send to post author
        const recipient = replyingToAuthor.value[messageId] || message.pubkey;
        await interactions.sendComment(messageId, recipient, text, parentCommentId);
        // Clear input and reply state
        commentInputs.value[messageId] = "";
        replyingTo.value[messageId] = "";
        replyingToAuthor.value[messageId] = "";
      } catch (e: any) {
        logger.error("Add comment failed", e);
      }
    }

    // Helper to check if query has notification params
    function hasNotificationParams(query: any): boolean {
      return !!(query.mid || query.iid);
    }


  async function handleNotificationJump() {
  const mid = route.query.mid as string | undefined;
  const iid = route.query.iid as string | undefined;
 


  if (!mid) return;

  // ① 等消息本身存在（点赞能跳就是靠这个）
  const waitForMessage = async () => {
    for (let i = 0; i < 20; i++) {
      if (displayedMessages.value.some(m => m.id === mid)) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  };

  const msgReady = await waitForMessage();
  if (!msgReady) {
    console.warn("通知跳转失败：消息未出现", mid);
    return;
  }

  // ② 如果是评论，强制展开评论区
  if (iid) {
    showingComments.value.add(mid);
    showingComments.value = new Set(showingComments.value);
  }

  // ③ 等评论 DOM 真正渲染出来（核心）
  const targetId = iid ? `comment-${iid}` : `msg-${mid}`;

  const waitForElement = async () => {
    for (let i = 0; i < 40; i++) {
      const el = document.getElementById(targetId);
      if (el) return el;
      await new Promise(r => setTimeout(r, 50));
    }
    return null;
  };

  const el = await waitForElement();

  if (!el) {
    console.warn("通知跳转失败：DOM 未找到", targetId);
    return;
  }

  // ④ 滚动 + 高亮
  // Use custom scroll calculation to prevent bottom bar from disappearing
  // when scrolling to elements near the bottom
  await nextTick();
  
  // Get the scrollable container
  const scrollContainer = document.querySelector(SCROLL_CONTAINER_SELECTOR) as HTMLElement | null;
  if (scrollContainer) {
    const rect = el.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    
    // Calculate where the element currently is in the viewport
    const elementTop = rect.top - containerRect.top;
    const elementBottom = rect.bottom - containerRect.top;
    
    // Calculate safe viewing area (viewport minus bottom bar)
    const viewportHeight = containerRect.height;
    const safeViewportBottom = viewportHeight - BOTTOM_NAV_HEIGHT - SCROLL_SAFE_OFFSET;
    
    // Determine if element needs scrolling
    if (elementTop < SCROLL_SAFE_OFFSET) {
      // Element is above viewport, scroll to bring it to top with safe offset
      const targetTop = scrollContainer.scrollTop + elementTop - SCROLL_SAFE_OFFSET;
      scrollContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else if (elementBottom > safeViewportBottom) {
      // Element extends into bottom bar area
      // Try to scroll to show it at the top of safe area
      const desiredScrollDelta = elementTop - SCROLL_SAFE_OFFSET;
      const targetTop = scrollContainer.scrollTop + desiredScrollDelta;
      scrollContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
    }
    // If element is already fully visible in safe area, no scroll needed
  } else {
    // Fallback to scrollIntoView if container not found
    // Use instant behavior to match custom scroll implementation
    el.scrollIntoView({
      behavior: "auto",
      block: "start"
    });
  }

  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), 1500);
  notificationJumpDone.value = true;
    
}




    function startReply(messageId: string, commentId: string, authorName: string) {
      replyingTo.value[messageId] = commentId;
      commentInputs.value[messageId] = `@${authorName} `;
      
      // Find the comment to get its author pubkey
      // Note: interactions.getComments() returns ALL comments (including nested replies)
      const allComments = interactions.getComments(messageId);
      const comment = allComments.find((c: any) => c.id === commentId);
      if (comment) {
        replyingToAuthor.value[messageId] = comment.author;
      } else {
        logger.warn("Could not find comment to reply to", { messageId, commentId });
      }
      
      // Focus input after state update
      setTimeout(() => {
        const input = document.querySelector(`input[data-message-id="${messageId}"]`) as HTMLInputElement;
        if (input) input.focus();
      }, 100);
    }

    function cancelReply(messageId: string) {
      replyingTo.value[messageId] = "";
      replyingToAuthor.value[messageId] = "";
      commentInputs.value[messageId] = "";
    }

    function getComments(messageId: string) {
      // Get only top-level comments (no parent)
      return interactions.getComments(messageId).filter((c: any) => !c.parentCommentId);
    }

    function getReplies(messageId: string, commentId: string) {
      return interactions.getReplies(messageId, commentId);
    }

    function getCommentCount(messageId: string): number {
      return interactions.getCommentCount(messageId);
    }
    
    async function startSub() {
      try {
        logger.info("开始订阅流程");
        if (!keys.isLoggedIn) {
          messageSync.stop();
          status.value = "未登录";
          logger.warn("[startSub] skip: not logged in");
          return;
        }
        const accountPk = keys.pkHex;
        if (homeAccountPk !== accountPk) {
          const initialized = await initializeHomeRuntime(accountPk);
          if (!initialized) return;
        }
        await friends.load(accountPk);
        if (!accountPk || keys.pkHex !== accountPk || friends.loadedFor !== accountPk) {
          logger.warn(`[account] subscription bootstrap discarded account=${accountPk?.slice(0, 8) || "none"}`);
          return;
        }
        logger.info(`好友列表加载完成: ${friends.list.length} 个好友`);
        const friendSet = new Set<string>((friends.list || []).map((f: any) => f.pubkey));
        friendSet.add(accountPk);
        logger.info(`准备订阅 ${friendSet.size} 个作者（包括自己）`);
        const relays = getRelaysFromStorage();
        logger.info(`使用中继: ${relays.join(', ')}`);
        await startRealtimeSubscription(friendSet, relays);
      } catch (e) {
        logger.error("startSub failed", e);
        status.value = "订阅失败";
      }
    }
    
    // 阶段2：启动实时订阅
    async function startRealtimeSubscription(friendSet: Set<string>, relays: string[]) {
      const accountPk = keys.pkHex;
      if (!accountPk) return;
      try {
        const accountAtStart = keys.pkHex;
        if (!accountAtStart) return;
realtimeSessionSince.value = Math.floor(Date.now() / 1000);
        await messageSync.start({
          accountPubkey: accountAtStart,
          relays,
          authors: Array.from(friendSet),
          decodeContext: {
            accountPubkey: accountAtStart,
            nip44Decrypt: keys.supportsNip44 ? keys.nip44Decrypt.bind(keys) : undefined
          },
          onMessage: async (message, metadata) => {
            if (keys.pkHex !== accountAtStart) return;
            if (!friendSet.has(message.senderPubkey)) return;
            if (isInteractionMessage(message)) {
              await interactions.processCanonicalInteraction(message, accountAtStart);
              return;
            }
            mirrorSyncedMessage(message);
            if (message.senderPubkey !== accountAtStart && metadata.source !== "local-migration") {
              notifications.addNotification({
                id: `message:${message.id}`,
                type: "message",
                from: message.senderPubkey,
                messageId: message.id,
                created_at: message.createdAt,
                read: false,
                postContent: message.plaintext || ""
              });
            }
          },
          onStatus: syncStatus => {
            if (keys.pkHex !== accountAtStart) return;
            status.value = syncStatus === "live" ? "同步完成" :
              syncStatus === "catching-up" ? "获取历史消息中..." :
              syncStatus === "error" ? "同步失败" : "连接中";
          }
        });
        
      } catch (e) {
        logger.error("startRealtimeSubscription failed", e);
      }
    }
    
   onMounted(async () => {
     if (!keys.pkHex || homeAccountPk === keys.pkHex) return;
     try {
       await initializeHomeRuntime(keys.pkHex);
     } catch (err) {
       logger.error("[account] Home initialization failed", err);
     }
   });

   onBeforeUnmount(() => {
     closeHomeSubscriptions();
     clearHomeRuntimeState();
   });

  // 启动 Realtime Reconcile
    useRealtimeInboxReconcile({
      reconcile: safeUpdateLocalRefs,
      isReady: () => readyForPending.value,
      debug: true,
    });

   watch(
  () => keys.isLoggedIn,
  (loggedIn) => {
    if (!loggedIn) {
      closeHomeSubscriptions();
      clearHomeRuntimeState();
      return;
    }

    logger.info("[Home] keys ready → startSub()");
    startSub().catch((e) => {
      logger.error("startSub failed", e);
    });
  },
  { immediate: true }
);
   watch(
     () => keys.pkHex,
     (accountPk, previousPk) => {
       if (!accountPk || !previousPk || accountPk === previousPk) return;
       closeHomeSubscriptions();
       clearHomeRuntimeState();
       logger.info(`[account] Home account switch ${previousPk.slice(0, 8)} -> ${accountPk.slice(0, 8)}`);
       startSub().catch((e) => logger.error("[account] switched account start failed", e));
     }
   );
   watch(
     () => interactions.lastSyncedAt,
     () => {
       if (route.path !== "/" || notificationJumpDone.value) return;
       handleNotificationJump();
     }
   );

   

   watch(
  inboxSnapshot,
  () => {
    if (!readyForPending.value) return;

    // ⭐ 唯一、绝对、最终入口
    safeUpdateLocalRefs();
  },
  { flush: "post" }
);
   
   // Watch for changes to friend list (add/remove) and restart subscriptions
   // This ensures that when friends are added or removed, the subscription
   // automatically updates to include/exclude them
   watch(() => friends.version, (newVersion, oldVersion) => {
     // Only restart if this is not the initial load
     if (oldVersion !== undefined && !isInitialLoad.value) {
       logger.info(`好友列表版本变化 (${oldVersion} -> ${newVersion})，重新启动订阅`);
       startSub().catch(e => logger.error('Failed to restart subscription after friends change', e));
     }
   });
   
   
    // Watch for route query changes to handle notification jump state
    watch(() => route.path, path => {
      if (path === "/" && reconcilePending) void safeUpdateLocalRefs();
    });

    watch(() => route.query, newQuery => {
  if (!hasNotificationParams(newQuery)) {
    notificationJumpDone.value = false;
  } else {
    handleNotificationJump().catch(console.error);
  }
});

    

    return { 
      displayedMessages,
      pendingMessages,
      messagesRef,
      toLocalTime, 
      shortPub, 
      status, 
      shortRelay, 
      displayName, 
      textWithoutImages,
      textWithoutVideos,
      extractVideoData,
      // Like and comment functions
      toggleLike,
      isLiked,
      getLikeCount,
      toggleComments,
      toggleSendMeta,
      addComment,
      getComments,
      getCommentCount,
      showingComments,
      showingSendMeta,
      commentInputs,
      // Reply functions
      startReply,
      cancelReply,
      getReplies,
      replyingTo,
      replyingToAuthor,
      messageTimeRange,
      showPendingMessages,
      container,
      pullDistance,
      refreshing,
      // Pagination
      hasMore,
      isLoadingMore,
      loadMoreMessages,
      remainingMessagesCount
      
    };
  }
});
</script>

<style scoped>
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
.card { background: #fff; padding:12px; border-radius:10px; margin-bottom:12px; box-shadow: 0 4px 10px rgba(0,0,0,0.04); }
.list { display:flex; flex-direction:column; gap:8px; }
.muted { color: #94a3b8; font-size: 12px; margin-left:6px; }
.message-text {
  margin-top: 8px;
  white-space: pre-wrap;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
  max-width: 100%;
}

.message-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid #f1f5f9;
}

.message-expanded {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
}


.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 6px 12px;
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

.action-icon {
  font-size: 16px;
}

.action-text {
  font-size: 13px;
}

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
  margin-left: auto;   /* ⭐ 推到最右 */
  position: relative;
}
.send-btn {
  padding: 6px 12px;   /* 和 action-btn 保持一致 */
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
</style>
