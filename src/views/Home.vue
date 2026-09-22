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


    <div ref="feedElement" class="feed">
      <div v-if="displayedMessages.length === 0" class="empty-feed">还没有动态</div>
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
import { formatRelativeTime } from "@/utils/format";
import PostCard from "@/components/PostCard.vue";
import { useRoute } from "vue-router";
import { usePullToRefresh } from "@/components/usePullToRefresh";
import { getLastSeenCreatedAt, setLastSeenCreatedAt, updateLastSeenToNewest } from "@/utils/lastSeen";
import { extractVideoData as extractVideoDataUtil, getVideoUrlRemovalPatterns } from "@/utils/videoUtils";
import { useRealtimeInboxReconcile } from "@/components/useRealtimeInboxReconcile";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { MessageSyncManager } from "@/nostr/messaging/sync";
import { createHomeMessageHandler, incomingFriendRequestNotification } from "@/nostr/messaging/homeDelivery";
import { decodeFriendshipControl } from "@/nostr/messaging/friendshipControl";
import { useNotificationsStore } from "@/stores/notifications";
import { useProfilesStore } from "@/stores/profiles";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { registerOutgoingPushSigner } from "@/nostr/messaging/service";


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
    const interactions = useInteractionsStore();
    const settings = useSettingsStore();
    const notifications = useNotificationsStore();
    const profiles = useProfilesStore();
    const feedPreferences = useFeedPreferencesStore();
    const readyForPending = ref(false);
    const route = useRoute();
    const realtimeSessionSince = ref(0);
    const notificationJumpDone = ref(false);
    const lastSeenCreatedAt = ref(0); // Track the watermark for filtering pending messages
    const inboxSnapshot = computed(() => `${msgs.inbox.length}:${msgs.inbox[0]?.id || ""}`);
    const feedPreferenceSnapshot = computed(() =>
      `${[...feedPreferences.hiddenMessageIds].sort().join(",")}|${[...feedPreferences.mutedPubkeys].sort().join(",")}`
    );
    const visibleInbox = () => msgs.inbox.filter(message => feedPreferences.isVisible(message));

    const status = ref("未连接");
    let homeAccountPk = "";
    let homeSyncGeneration = 0;
    const messageSync = new MessageSyncManager();

    const messagesRef = ref([] as any[]);
    const displayedMessages = ref([] as any[]);
    const feedElement = ref<HTMLElement | null>(null);
    const virtualStart = ref(0);
    const virtualEnd = ref(12);
    const postHeights = new Map<string, number>();
    const ESTIMATED_POST_HEIGHT = 420;
    const OVERSCAN_PX = 900;
    const virtualMessages = computed(() => displayedMessages.value.slice(virtualStart.value, virtualEnd.value));
    const rangeHeight = (start: number, end: number) => displayedMessages.value
      .slice(start, end).reduce((sum, message) => sum + (postHeights.get(message.id) || ESTIMATED_POST_HEIGHT) + 10, 0);
    const topSpacerHeight = computed(() => rangeHeight(0, virtualStart.value));
    const bottomSpacerHeight = computed(() => rangeHeight(virtualEnd.value, displayedMessages.value.length));

    function updateVirtualWindow() {
      const scroller = document.querySelector(SCROLL_CONTAINER_SELECTOR) as HTMLElement | null;
      if (!scroller || !feedElement.value || displayedMessages.value.length === 0) return;
      const localTop = Math.max(0, scroller.scrollTop - feedElement.value.offsetTop);
      const lowerBound = Math.max(0, localTop - OVERSCAN_PX);
      const upperBound = localTop + scroller.clientHeight + OVERSCAN_PX;
      let cursor = 0;
      let start = 0;
      while (start < displayedMessages.value.length) {
        const height = (postHeights.get(displayedMessages.value[start].id) || ESTIMATED_POST_HEIGHT) + 10;
        if (cursor + height >= lowerBound) break;
        cursor += height;
        start += 1;
      }
      let end = start;
      while (end < displayedMessages.value.length && cursor < upperBound) {
        cursor += (postHeights.get(displayedMessages.value[end].id) || ESTIMATED_POST_HEIGHT) + 10;
        end += 1;
      }
      virtualStart.value = start;
      virtualEnd.value = Math.max(start + 1, end);
    }

    function recordPostHeight(id: string, height: number) {
      if (!height || Math.abs((postHeights.get(id) || 0) - height) < 1) return;
      postHeights.set(id, height);
    }

    let scrollContainer: HTMLElement | null = null;
    function attachVirtualScroll() {
      detachVirtualScroll();
      scrollContainer = document.querySelector(SCROLL_CONTAINER_SELECTOR) as HTMLElement | null;
      scrollContainer?.addEventListener("scroll", updateVirtualWindow, { passive: true });
      requestAnimationFrame(updateVirtualWindow);
    }
    function detachVirtualScroll() {
      scrollContainer?.removeEventListener("scroll", updateVirtualWindow);
      scrollContainer = null;
    }
    const pendingMessages = ref([] as any[]); // Messages fetched but not yet displayed
    const isInitialLoad = ref(true); // Track if this is the first load
    const startupSyncing = ref(false);
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
    const acceptedFriends = computed(() => friends.getAcceptedList(friendships.isAccepted));
    const acceptedAuthorsSignature = computed(() => acceptedFriends.value
      .map(friend => friend.pubkey)
      .filter(Boolean)
      .sort()
      .join("|"));

    function closeHomeSubscriptions() {
      homeSyncGeneration++;
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
      startupSyncing.value = false;
      homeAccountPk = "";
    }

    async function initializeHomeRuntime(accountPk: string) {
      await msgs.load(accountPk);
      await feedPreferences.load(accountPk);
      if (!accountPk || keys.pkHex !== accountPk || msgs.loadedFor !== accountPk) {
        logger.warn(`[account] Home initialization discarded account=${accountPk?.slice(0, 8) || "none"}`);
        return false;
      }

      messagesRef.value = visibleInbox().sort(compareHomeMessages);
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
    const expandedPosts = ref<Set<string>>(new Set());
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
        if (compareHomeMessages(array1[i], array2[j]) <= 0) {
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
        const sortedPending = [...pendingMessages.value].sort(compareHomeMessages);
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
  messagesRef.value = visibleInbox().sort(compareHomeMessages);

  if (!readyForPending.value) {
    updateMessageTimeRange();
    return;
  }

  // During startup/history repair, relay events are the device's baseline, not
  // newly-arrived posts. Render the same newest page another device restores
  // from disk instead of hiding the history behind the "new messages" prompt.
  if (startupSyncing.value) {
    reconcileStartupSnapshot(false);
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
    const sortedOwn = ownMessages.sort(compareHomeMessages);

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

    pendingMessages.value = deduped.sort(compareHomeMessages);
  }

  updateMessageTimeRange();
}

function reconcileStartupSnapshot(updateWatermark: boolean) {
  messagesRef.value = visibleInbox().sort(compareHomeMessages);
  const visibleCount = Math.max(PAGE_SIZE, displayedMessages.value.length);
  displayedMessages.value = messagesRef.value.slice(0, visibleCount);
  const visibleIds = new Set(displayedMessages.value.map(message => message.id));
  pendingMessages.value = pendingMessages.value.filter(message => !visibleIds.has(message.id));
  if (updateWatermark && messagesRef.value.length > 0) {
    lastSeenCreatedAt.value = updateLastSeenToNewest(keys.pkHex, messagesRef.value);
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

    function avatarInitial(pubkey: string) {
      const name = displayName(pubkey).trim();
      return (name[0] || "?").toUpperCase();
    }

    function avatarColor(pubkey: string) {
      let hash = 0;
      for (let index = 0; index < pubkey.length; index++) hash = ((hash << 5) - hash + pubkey.charCodeAt(index)) | 0;
      return `hsl(${Math.abs(hash) % 360} 48% 48%)`;
    }

    function isLongPost(message: InboxItem) {
      const text = textWithoutVideos(message.content);
      return Array.from(text).length > 280 || text.split("\n").length > 6;
    }

    function displayedPostText(message: InboxItem) {
      const text = textWithoutVideos(message.content);
      if (!isLongPost(message) || expandedPosts.value.has(message.id)) return text;
      const lines = text.split("\n").slice(0, 6).join("\n");
      const preview = Array.from(lines).slice(0, 280).join("").trimEnd();
      return `${preview}…`;
    }

    function togglePostText(messageId: string) {
      const next = new Set(expandedPosts.value);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      expandedPosts.value = next;
    }

    function visibilityLabel(message: InboxItem) {
      const groups = message._localMeta?.groups || [];
      if (groups.length === 1 && groups[0].name === "全部好友") return "全部好友";
      return `${message._localMeta?.groupCount || groups.length} 个分组`;
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

  const targetIndex = displayedMessages.value.findIndex(message => message.id === mid);
  const jumpScroller = document.querySelector(SCROLL_CONTAINER_SELECTOR) as HTMLElement | null;
  if (targetIndex >= 0 && jumpScroller && feedElement.value) {
    virtualStart.value = Math.max(0, targetIndex - 2);
    virtualEnd.value = Math.min(displayedMessages.value.length, targetIndex + 4);
    jumpScroller.scrollTop = feedElement.value.offsetTop + rangeHeight(0, targetIndex);
    await nextTick();
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

  // CommentSheet owns comment scrolling/highlighting. Keep the feed positioned
  // on the post and avoid scrolling the background container behind the sheet.
  if (iid) {
    notificationJumpDone.value = true;
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
        try {
          await friends.load(accountPk);
          await friendships.load(accountPk);
          await profiles.load(accountPk);
        } catch (error) {
          logger.warn("[message-sync] friend list unavailable; continuing receive sync", {
            account: accountPk.slice(0, 12),
            reason: error instanceof Error ? error.name || "Error" : "unknown_error"
          });
        }
        if (!accountPk || keys.pkHex !== accountPk) {
          logger.warn(`[account] subscription bootstrap discarded account=${accountPk?.slice(0, 8) || "none"}`);
          return;
        }
        const knownAuthors = friends.loadedFor === accountPk && friendships.loadedFor === accountPk
          ? acceptedFriends.value.map(friend => friend.pubkey)
          : [];
        logger.info(`已确认好友加载完成: ${knownAuthors.length} 个好友`);
        const relays = getRelaysFromStorage("read");
        logger.info(`使用中继: ${relays.join(', ')}`);
        await startRealtimeSubscription(knownAuthors, relays);
      } catch (e) {
        logger.error("startSub failed", e);
        status.value = "订阅失败";
      }
    }
    
    // 阶段2：启动实时订阅
    async function startRealtimeSubscription(knownAuthors: string[], relays: string[]) {
      const accountAtStart = keys.pkHex;
      if (!accountAtStart) return;
      registerOutgoingPushSigner(accountAtStart, keys.signEvent.bind(keys));
      const syncGeneration = ++homeSyncGeneration;
      try {
        startupSyncing.value = true;
realtimeSessionSince.value = Math.floor(Date.now() / 1000);
        await messageSync.start({
          accountPubkey: accountAtStart,
          relays,
          authors: [...new Set([...knownAuthors, accountAtStart])],
          decodeContext: {
            accountPubkey: accountAtStart,
            nip44Decrypt: keys.supportsNip44 ? keys.nip44Decrypt.bind(keys) : undefined
          },
          onMessage: createHomeMessageHandler({
            accountPubkey: accountAtStart,
            currentAccount: () => keys.pkHex,
            isAcceptedMessage: message => message.senderPubkey === accountAtStart
              ? message.recipientPubkeys
                  .filter(pubkey => pubkey !== accountAtStart)
                  .every(pubkey => friendships.isAccepted(pubkey))
              : friendships.isAccepted(message.senderPubkey),
            processFriendshipMessage: message => friendships.processFriendshipMessage(message),
            processProfileMessage: message => profiles.processProfileMessage(message, friendships.isAccepted),
            processFeedControlMessage: message => feedPreferences.processTombstone(
              message,
              friendships.isAccepted,
              messageId => msgs.inbox.find(item => item.id === messageId)?.pubkey
            ),
            notifyFriendshipMessage: message => {
              const notification = incomingFriendRequestNotification(message, accountAtStart);
              if (notification) {
                notifications.addNotification(notification);
                return;
              }
              const control = decodeFriendshipControl(message);
              if (control && control.action !== "request") notifications.resolveFriendRequests(message.senderPubkey);
            },
            isInteraction: isInteractionMessage,
            processInteraction: message => interactions.processCanonicalInteraction(message, accountAtStart),
            mirrorMessage: mirrorSyncedMessage
          }),
          onStatus: syncStatus => {
            if (keys.pkHex !== accountAtStart || syncGeneration !== homeSyncGeneration) return;
            if (syncStatus === "live" || syncStatus === "error") {
              reconcileStartupSnapshot(true);
              startupSyncing.value = false;
            }
            status.value = syncStatus === "live" ? "同步完成" :
              syncStatus === "catching-up" ? "获取历史消息中..." :
              syncStatus === "error" ? "同步失败" : "连接中";
          }
        });
        
      } catch (e) {
        logger.error("startRealtimeSubscription failed", e);
      } finally {
        if (keys.pkHex === accountAtStart && syncGeneration === homeSyncGeneration && startupSyncing.value) {
          reconcileStartupSnapshot(true);
          startupSyncing.value = false;
        }
      }
    }
    
   onMounted(async () => {
     attachVirtualScroll();
     if (!keys.pkHex || homeAccountPk === keys.pkHex) return;
     try {
       await initializeHomeRuntime(keys.pkHex);
     } catch (err) {
       logger.error("[account] Home initialization failed", err);
     }
   });

   onBeforeUnmount(() => {
     detachVirtualScroll();
     closeHomeSubscriptions();
     clearHomeRuntimeState();
   });
   onActivated(attachVirtualScroll);
   onDeactivated(detachVirtualScroll);

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
   watch(() => displayedMessages.value.length, () => nextTick(updateVirtualWindow));
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
  [inboxSnapshot, feedPreferenceSnapshot],
  () => {
    if (!readyForPending.value) return;

    // ⭐ 唯一、绝对、最终入口
    safeUpdateLocalRefs();
  },
  { flush: "post" }
);
   
   watch(acceptedAuthorsSignature, (signature, previousSignature) => {
     if (signature === previousSignature || isInitialLoad.value || !keys.isLoggedIn) return;
     logger.info("已确认好友列表变化，重新启动订阅");
     startSub().catch(e => logger.error("Failed to restart subscription after accepted-friends change", e));
   });

   // Settings sync is intentionally non-blocking. A fresh device initially
   // starts on bootstrap relays, then receives the account's relay set. Restart
   // Home whenever that effective read-relay set changes so the synced settings
   // actually affect content retrieval in the same session.
   watch(
     () => settings.activeRelays
       .filter(relay => relay.read && relay.enabled && !relay.deleted)
       .map(relay => relay.url)
       .sort()
       .join("|"),
     (relaySignature, previousSignature) => {
       if (!keys.isLoggedIn || !homeAccountPk || relaySignature === previousSignature) return;
       logger.info("首页 Relay 配置已更新，重新同步内容");
       startSub().catch(error => logger.error("Failed to restart subscription after relay change", error));
     }
   );
   
   
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
      keys,
      displayedMessages,
      pendingMessages,
      messagesRef,
      toLocalTime, 
      shortPub, 
      status, 
      shortRelay, 
      displayName, 
      avatarInitial,
      avatarColor,
      isLongPost,
      displayedPostText,
      togglePostText,
      expandedPosts,
      visibilityLabel,
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
      , virtualMessages, topSpacerHeight, bottomSpacerHeight, feedElement, recordPostHeight, route
      
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
.feed {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 720px;
  margin: 0 auto;
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
