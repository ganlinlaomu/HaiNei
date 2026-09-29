<template>
  <div 
    class="home-container app-page" ref="container"
  >
    <div
      class="pull-indicator"
      :style="{ height: pullDistance + 'px' }"
    >
      <span v-if="!refreshing">↓ 下拉刷新</span>
      <span v-else>正在更新…</span>
    </div>
    
    <div v-if="connectionNotice" class="home-connection-notice" role="status">
      {{ connectionNotice }}
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
      <span class="notification-icon">↑</span>
      <span class="notification-text">{{ pendingMessages.length }} 条新动态</span>
    </div>


    <div ref="feedElement" class="feed">
      <div v-if="!isInitialLoad && displayedMessages.length === 0" class="empty-feed">
        <template v-if="acceptedFriends.length === 0">
          <strong>还没有好友</strong>
          <span>添加一个朋友后，这里会出现你们共享的动态。</span>
          <button type="button" @click="router.push('/friends')">添加好友</button>
        </template>
        <template v-else>
          <strong>暂时没有新动态</strong>
          <span>可以先分享一点近况。</span>
          <button type="button" @click="ui.openPostEditor()">发布动态</button>
        </template>
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
      
      <div v-if="hasMore" ref="loadMoreSentinel" class="load-more-sentinel" aria-live="polite">
        <span v-if="isLoadingMore">正在加载…</span>
        <button v-else-if="!autoLoadSupported" class="load-more-btn" type="button" @click="loadMoreMessages">
          加载更多
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
import { useUIStore } from "@/stores/ui";
import type { SyncStatus } from "@/nostr/messaging/sync/types";
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
    const ui = useUIStore();
    const profiles = useProfilesStore();
    const feedPreferences = useFeedPreferencesStore();
    const readyForPending = ref(false);
    const route = useRoute();
    const router = useRouter();
    const notificationJumpDone = ref(false);
    const lastSeenCreatedAt = ref(0); // Track the watermark for filtering pending messages
    const inboxRevision = computed(() => msgs.inboxRevision);
    const feedPreferenceRevision = computed(() => feedPreferences.revision);
    const isHomeRenderable = (message: InboxItem) => !isDirectMessageTags(message.tags)
      && !isDmReceiptMessage({ tags: message.tags })
      && !isDmReceiptPayload(message.content);
    const visibleInbox = () => msgs.inbox.filter(message => isHomeRenderable(message) && feedPreferences.isVisible(message));

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
        return { changed: false, mode: "none" };
      }

      const mutation = msgs.lastInboxMutation;
      const canApplySingleInsert = !force
        && preferenceRevision === visibleInboxPreferenceRevision
        && messageRevision === visibleInboxMessageRevision + 1
        && mutation?.revision === messageRevision
        && mutation.type === "insert"
        && !!mutation.itemId;

      let insertedVisible: InboxItem | undefined;
      if (canApplySingleInsert) {
        let next = messagesRef.value;
        if (mutation.evictedId) next = next.filter(message => message.id !== mutation.evictedId);
        const inserted = msgs.inbox[0]?.id === mutation.itemId
          ? msgs.inbox[0]
          : msgs.inbox.find(message => message.id === mutation.itemId);
        if (inserted
          && isHomeRenderable(inserted)
          && feedPreferences.isVisible(inserted)
          && !next.some(message => message.id === inserted.id)) {
          next = insertSortedHomeMessage(next, inserted);
          insertedVisible = inserted;
        }
        messagesRef.value = next;
      } else {
        // Multiple arrivals, reloads, metadata replacements and preference
        // changes intentionally fall back to the proven full rebuild path.
        rebuildVisibleInbox();
      }

      visibleInboxMessageRevision = messageRevision;
      visibleInboxPreferenceRevision = preferenceRevision;
      return {
        changed: true,
        mode: canApplySingleInsert ? "incremental" : "rebuild",
        inserted: insertedVisible,
      };
    }
    const feedElement = ref<HTMLElement | null>(null);
    const virtualStart = ref(0);
    const virtualEnd = ref(12);
    const postHeights = new Map<string, number>();
    const postIndexes = new Map<string, number>();
    const heightPrefix = ref<number[]>([0]);
    const ESTIMATED_POST_HEIGHT = 420;
    const POST_GAP = 10;
    const OVERSCAN_PX = 900;
    const virtualMessages = computed(() => displayedMessages.value.slice(virtualStart.value, virtualEnd.value));
    const rangeHeight = (start: number, end: number) =>
      (heightPrefix.value[end] || 0) - (heightPrefix.value[start] || 0);
    const topSpacerHeight = computed(() => rangeHeight(0, virtualStart.value));
    const bottomSpacerHeight = computed(() => rangeHeight(virtualEnd.value, displayedMessages.value.length));

    function rebuildHeightIndex() {
      postIndexes.clear();
      const heights = displayedMessages.value.map((message, index) => {
        postIndexes.set(message.id, index);
        return (postHeights.get(message.id) || ESTIMATED_POST_HEIGHT) + POST_GAP;
      });
      heightPrefix.value = buildHeightPrefix(heights);
      virtualStart.value = Math.min(virtualStart.value, Math.max(0, heights.length - 1));
      virtualEnd.value = Math.min(heights.length, Math.max(virtualStart.value + 1, virtualEnd.value));
    }

    function updateVirtualWindow() {
      if (!scrollContainer || !feedElement.value || displayedMessages.value.length === 0) return;
      const localTop = Math.max(0, scrollContainer.scrollTop - feedElement.value.offsetTop);
      const range = resolveVirtualRange(heightPrefix.value, localTop, scrollContainer.clientHeight, OVERSCAN_PX);
      virtualStart.value = range.start;
      virtualEnd.value = range.end;
    }

    function recordPostHeight(id: string, height: number) {
      const index = postIndexes.get(id);
      if (!height || index === undefined) return;
      const previousHeight = postHeights.get(id) || ESTIMATED_POST_HEIGHT;
      const delta = height - previousHeight;
      if (Math.abs(delta) < 1) return;

      const localTop = scrollContainer && feedElement.value
        ? Math.max(0, scrollContainer.scrollTop - feedElement.value.offsetTop)
        : 0;
      const measuredPostWasAboveViewport = (heightPrefix.value[index + 1] || 0) <= localTop;
      postHeights.set(id, height);
      heightPrefix.value = updateHeightPrefix(heightPrefix.value, index, delta);

      if (measuredPostWasAboveViewport) queueScrollAnchorAdjustment(delta);
      scheduleVirtualWindowUpdate();
    }

    let scrollContainer: HTMLElement | null = null;
    let virtualFrame: number | null = null;
    let virtualScrollActive = false;
    let pendingAnchorAdjustment = 0;
    let anchorAdjustmentQueued = false;

    function scheduleVirtualWindowUpdate() {
      if (!virtualScrollActive || virtualFrame !== null) return;
      virtualFrame = requestAnimationFrame(() => {
        virtualFrame = null;
        updateVirtualWindow();
      });
    }

    function queueScrollAnchorAdjustment(delta: number) {
      pendingAnchorAdjustment += delta;
      if (anchorAdjustmentQueued) return;
      anchorAdjustmentQueued = true;
      void nextTick(() => {
        anchorAdjustmentQueued = false;
        const adjustment = pendingAnchorAdjustment;
        pendingAnchorAdjustment = 0;
        if (!virtualScrollActive || !scrollContainer || !adjustment) return;
        scrollContainer.scrollTop += adjustment;
        scheduleVirtualWindowUpdate();
      });
    }

    function handleHomeScroll() {
      scheduleVirtualWindowUpdate();
      if (!scrollContainer || isLoadingMore.value || !hasMore.value) return;
      const distanceToBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      if (distanceToBottom <= AUTO_LOAD_MORE_THRESHOLD) loadMoreMessages();
    }

    function attachVirtualScroll() {
      detachVirtualScroll();
      scrollContainer = document.querySelector(SCROLL_CONTAINER_SELECTOR) as HTMLElement | null;
      virtualScrollActive = !!scrollContainer;
      scrollContainer?.addEventListener("scroll", handleHomeScroll, { passive: true });
      scheduleVirtualWindowUpdate();
    }
    function detachVirtualScroll() {
      virtualScrollActive = false;
      scrollContainer?.removeEventListener("scroll", handleHomeScroll);
      scrollContainer = null;
      if (virtualFrame !== null) cancelAnimationFrame(virtualFrame);
      virtualFrame = null;
      pendingAnchorAdjustment = 0;
    }

    function saveCurrentHomeScroll() {
      if (!keys.pkHex || !scrollContainer) return;
      saveHomeScroll(keys.pkHex, scrollContainer.scrollTop);
    }

    async function restoreCurrentHomeScroll() {
      if (!keys.pkHex || route.path !== "/" || hasNotificationParams(route.query)) return;
      const saved = loadHomeScroll(keys.pkHex);
      if (saved <= 0) return;
      await nextTick();
      if (!scrollContainer || route.path !== "/") return;
      scrollContainer.scrollTop = saved;
      scheduleVirtualWindowUpdate();
    }
    const pendingMessages = ref([] as any[]); // Messages fetched but not yet displayed
    const isInitialLoad = ref(true); // Track if this is the first load
    const startupSyncing = ref(false);
    const homeSyncStatus = ref<SyncStatus>("idle");
    const connectionNotice = computed(() => {
      if (homeSyncStatus.value === "offline") return "暂时离线，正在显示已缓存内容";
      if (homeSyncStatus.value === "error") return "正在重新连接…";
      return "";
    });

    // 分页相关状态
    const PAGE_SIZE = 20; // 每页显示 20 条
    const hasMore = computed(() => {
      return messagesRef.value.length > displayedMessages.value.length;
    });
    const isLoadingMore = ref(false);
    const loadMoreSentinel = ref<HTMLElement | null>(null);
    const autoLoadSupported = ref(typeof IntersectionObserver !== "undefined");
    let loadMoreObserver: IntersectionObserver | null = null;
    const acceptedFriends = computed(() => friends.getAcceptedList(friendships.isAccepted));
    const acceptedAuthorsSignature = computed(() => acceptedFriends.value
      .map(friend => friend.pubkey)
      .filter(Boolean)
      .sort()
      .join("|"));

    function closeHomeSubscriptions(stopSession = true) {
      homeSyncGeneration++;
      if (stopSession) messageSync.stop();
    }

    function clearHomeRuntimeState() {
      messagesRef.value = [];
      displayedMessages.value = [];
      pendingMessages.value = [];
      readyForPending.value = false;
      lastSeenCreatedAt.value = 0;
      notificationJumpDone.value = false;
      startupSyncing.value = false;
      homeSyncStatus.value = "idle";
      homeAccountPk = "";
      visibleInboxMessageRevision = -1;
      visibleInboxPreferenceRevision = -1;
    }

    async function initializeHomeRuntime(accountPk: string) {
      await msgs.load(accountPk);
      await feedPreferences.load(accountPk);
      if (!accountPk || keys.pkHex !== accountPk || msgs.loadedFor !== accountPk) {
        logger.warn(`[account] Home initialization discarded account=${accountPk?.slice(0, 8) || "none"}`);
        return false;
      }

      refreshVisibleInbox(true);
      displayedMessages.value = messagesRef.value.slice(0, PAGE_SIZE);
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
    
    
    async function showPendingMessages() {
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
        
        const newestPendingId = sortedPending[0]?.id || "";
        pendingMessages.value = [];

        virtualStart.value = 0;
        virtualEnd.value = Math.min(displayedMessages.value.length, Math.max(12, virtualEnd.value));
        await nextTick();
        if (scrollContainer && feedElement.value) {
          scrollContainer.scrollTo({ top: feedElement.value.offsetTop, behavior: "smooth" });
          saveHomeScroll(keys.pkHex, feedElement.value.offsetTop);
        }
        if (newestPendingId) {
          const target = document.getElementById(`msg-${newestPendingId}`);
          target?.classList.add("home-new-highlight");
          window.setTimeout(() => target?.classList.remove("home-new-highlight"), 1_250);
        }
      }
    }
    
    function updateLocalRefs() {
  // Keep Home's derived list current without re-filtering/re-sorting the
  // entire bounded inbox for the common single-message realtime path.
  const refreshResult = refreshVisibleInbox();

  if (!readyForPending.value) {
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

  // ⭐ ② 真正的“新消息”定义：只看时间。常见的单条实时新增
  // 直接判断这一条；只有 rebuild 才扫描当前 Home 列表。
  const newMessages = refreshResult.mode === "incremental"
    ? (refreshResult.inserted && (refreshResult.inserted.created_at || 0) > lastSeen
      ? [refreshResult.inserted]
      : [])
    : refreshResult.mode === "none"
      ? []
      : messagesRef.value.filter(m => (m.created_at || 0) > lastSeen);

  if (newMessages.length === 0) {
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
}

function reconcileStartupSnapshot(updateWatermark: boolean) {
  refreshVisibleInbox();
  const visibleCount = Math.max(PAGE_SIZE, displayedMessages.value.length);
  displayedMessages.value = messagesRef.value.slice(0, visibleCount);
  const visibleIds = new Set(displayedMessages.value.map(message => message.id));
  pendingMessages.value = pendingMessages.value.filter(message => !visibleIds.has(message.id));
  if (updateWatermark && messagesRef.value.length > 0) {
    lastSeenCreatedAt.value = updateLastSeenToNewest(keys.pkHex, messagesRef.value);
  }
}
  // --------------------
// ⭐ 防重复触发包装（加在这里）
// --------------------
let reconcileScheduled = false;
let reconcilePending = false;
let lastReconciledSnapshot = "";

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
      const snapshot = `${inboxRevision.value}|${feedPreferenceRevision.value}`;
      if (snapshot !== lastReconciledSnapshot || reconcilePending) {
        lastReconciledSnapshot = snapshot;
        updateLocalRefs();
      }
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
      
      const appendPage = () => {
        const startIndex = displayedMessages.value.length;
        const endIndex = Math.min(startIndex + PAGE_SIZE, messagesRef.value.length);
        const newMessages = messagesRef.value.slice(startIndex, endIndex);

        displayedMessages.value = [...displayedMessages.value, ...newMessages];
        isLoadingMore.value = false;

        logger.info(`加载了 ${newMessages.length} 条消息，总共显示 ${displayedMessages.value.length} 条`);
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(appendPage);
      else appendPage();
    }

    function attachLoadMoreObserver() {
      loadMoreObserver?.disconnect();
      loadMoreObserver = null;
      if (typeof IntersectionObserver === "undefined") {
        autoLoadSupported.value = false;
        return;
      }
      autoLoadSupported.value = true;
      loadMoreObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) loadMoreMessages();
      }, { root: scrollContainer, rootMargin: "420px 0px" });
      if (loadMoreSentinel.value) loadMoreObserver.observe(loadMoreSentinel.value);
    }

    function detachLoadMoreObserver() {
      loadMoreObserver?.disconnect();
      loadMoreObserver = null;
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
    rootId: message.rootId,
    tags: message.tags
  });
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
  const jumpScroller = scrollContainer;
  if (targetIndex >= 0 && jumpScroller && feedElement.value) {
    virtualStart.value = Math.max(0, targetIndex - 2);
    virtualEnd.value = Math.min(displayedMessages.value.length, targetIndex + 4);
    jumpScroller.scrollTop = feedElement.value.offsetTop + rangeHeight(0, targetIndex);
    await nextTick();
  }

  // PostCard/CommentSheet owns opening and focusing the requested comment via
  // openCommentId. Home only positions the containing post.
  // ② 等目标 DOM 真正渲染出来
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
  if (jumpScroller) {
    const rect = el.getBoundingClientRect();
    const containerRect = jumpScroller.getBoundingClientRect();
    
    // Calculate where the element currently is in the viewport
    const elementTop = rect.top - containerRect.top;
    const elementBottom = rect.bottom - containerRect.top;
    
    // Calculate safe viewing area (viewport minus bottom bar)
    const viewportHeight = containerRect.height;
    const safeViewportBottom = viewportHeight - bottomNavigationHeight() - SCROLL_SAFE_OFFSET;
    
    // Determine if element needs scrolling
    if (elementTop < SCROLL_SAFE_OFFSET) {
      // Element is above viewport, scroll to bring it to top with safe offset
      const targetTop = jumpScroller.scrollTop + elementTop - SCROLL_SAFE_OFFSET;
      jumpScroller.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else if (elementBottom > safeViewportBottom) {
      // Element extends into bottom bar area
      // Try to scroll to show it at the top of safe area
      const desiredScrollDelta = elementTop - SCROLL_SAFE_OFFSET;
      const targetTop = jumpScroller.scrollTop + desiredScrollDelta;
      jumpScroller.scrollTo({ top: targetTop, behavior: 'smooth' });
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




  async function startSub() {
      try {
        logger.info("开始订阅流程");
        if (!keys.isLoggedIn) {
          messageSync.stop();
          logger.warn("[startSub] skip: not logged in");
          return;
        }
        const accountPk = keys.pkHex;
        if (homeAccountPk !== accountPk) {
          const initialized = await initializeHomeRuntime(accountPk);
          if (!initialized) return;
        }
        try {
          await Promise.all([
            friends.load(accountPk),
            friendships.load(accountPk),
            profiles.load(accountPk)
          ]);
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
            isAcceptedMessage: message => {
              if (isDirectMessageTags(message.tags)) {
                const peer = message.senderPubkey === accountAtStart
                  ? message.recipientPubkeys.find(pubkey => pubkey !== accountAtStart) || ""
                  : message.senderPubkey;
                return !!peer && isAuthorizedCanonicalDirectMessage(
                  message,
                  accountAtStart,
                  friendships.getRecord(peer),
                );
              }
              return message.senderPubkey === accountAtStart
                ? message.recipientPubkeys
                    .filter(pubkey => pubkey !== accountAtStart)
                    .every(pubkey => friendships.isAccepted(pubkey))
                : friendships.isAccepted(message.senderPubkey);
            },
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
            isReceipt: isDmReceiptMessage,
            processReceipt: message => directMessages.processReceipt(message),
            isInteraction: isInteractionMessage,
            processInteraction: message => interactions.processCanonicalInteraction(message, accountAtStart),
            mirrorMessage: mirrorSyncedMessage
          }),
          onPersistedMessage: message => directMessages.acknowledgePersistedIncoming(accountAtStart, message),
          onStatus: syncStatus => {
            if (keys.pkHex !== accountAtStart || syncGeneration !== homeSyncGeneration) return;
            homeSyncStatus.value = syncStatus;
            if (syncStatus === "live" || syncStatus === "error") {
              reconcileStartupSnapshot(true);
              startupSyncing.value = false;
            }
            if (syncStatus === "offline") logger.info("[Home] sync offline");
            if (syncStatus === "error") logger.warn("[Home] sync retrying");
          }
        });
        
      } catch (e) {
        if (keys.pkHex === accountAtStart && syncGeneration === homeSyncGeneration) homeSyncStatus.value = "error";
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
     await nextTick();
     attachLoadMoreObserver();
     if (!keys.pkHex || homeAccountPk === keys.pkHex) return;
     try {
       await initializeHomeRuntime(keys.pkHex);
       await restoreCurrentHomeScroll();
     } catch (err) {
       logger.error("[account] Home initialization failed", err);
     }
   });

   onBeforeUnmount(() => {
     saveCurrentHomeScroll();
     detachLoadMoreObserver();
     detachVirtualScroll();
     closeHomeSubscriptions(false);
     clearHomeRuntimeState();
   });
   onActivated(() => {
     attachVirtualScroll();
     void nextTick(attachLoadMoreObserver);
     void restoreCurrentHomeScroll();
   });
   onDeactivated(() => {
     saveCurrentHomeScroll();
     detachLoadMoreObserver();
     detachVirtualScroll();
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
   watch(displayedMessages, () => {
     rebuildHeightIndex();
     void nextTick(() => {
       scheduleVirtualWindowUpdate();
       attachLoadMoreObserver();
     });
   }, { flush: "sync" });
   watch(
     () => keys.pkHex,
     async (accountPk, previousPk) => {
       if (!accountPk || !previousPk || accountPk === previousPk) return;
       if (scrollContainer) saveHomeScroll(previousPk, scrollContainer.scrollTop);
       closeHomeSubscriptions();
       clearHomeRuntimeState();
       logger.info(`[account] Home account switch ${previousPk.slice(0, 8)} -> ${accountPk.slice(0, 8)}`);
       try {
         await startSub();
         await restoreCurrentHomeScroll();
       } catch (e) {
         logger.error("[account] switched account start failed", e);
       }
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
  [inboxRevision, feedPreferenceRevision],
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
      displayedMessages,
      pendingMessages,
      showPendingMessages,
      container,
      pullDistance,
      refreshing,
      isInitialLoad,
      acceptedFriends,
      ui,
      connectionNotice,
      hasMore,
      isLoadingMore,
      loadMoreMessages,
      loadMoreSentinel,
      autoLoadSupported,
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
.home-connection-notice{position:sticky;top:0;z-index:11;width:100%;box-sizing:border-box;padding:6px 12px;border-bottom:1px solid #e7ebef;background:rgba(255,255,255,.96);color:#657786;font-size:12px;line-height:1.35;text-align:center;backdrop-filter:blur(10px)}

.home-container {
  position: relative;
  min-height: 100vh;
  overscroll-behavior: contain;
  padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
}


.new-messages-notification {
  position: sticky;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  width: fit-content;
  max-width: calc(100% - 24px);
  min-height: 34px;
  align-items: center;
  gap: 5px;
  margin-bottom: 8px;
  padding: 6px 11px;
  border: 1px solid #dbe3ea;
  border-radius: 999px;
  background: rgba(255,255,255,.96);
  color: #334155;
  box-shadow: 0 4px 14px rgba(15,23,42,.09);
  backdrop-filter: blur(10px);
  cursor: pointer;
  z-index: 999;
  font-size: 13px;
  font-weight: 600;
  animation: slideDown .22s ease;
  transition: transform .15s ease, box-shadow .15s ease;
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
  transform: translateX(-50%);
  box-shadow: 0 5px 16px rgba(15,23,42,.11);
}

.new-messages-notification:active {
  transform: translateX(-50%) scale(.98);
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

.notification-icon { font-size:14px; line-height:1; color:#2563eb }
.notification-text { font-size:13px }

.feed {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0 0 20px;
}
.highlight {
  animation: flash 1.5s ease;
}
:deep(.post-card.home-new-highlight) {
  animation: home-new-post-highlight 1.25s ease;
}
@keyframes home-new-post-highlight {
  0%, 35% { box-shadow: 0 0 0 3px rgba(37,99,235,.18); }
  100% { box-shadow: 0 2px 8px rgba(15,23,42,.035); }
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

.load-more-sentinel{display:flex;min-height:34px;align-items:center;justify-content:center;padding:6px 12px;color:#8b98a5;font-size:12px}

.load-more-btn {
  min-height: 36px;
  padding: 7px 14px;
  border: 1px solid #dbe3ea;
  border-radius: 999px;
  background: #fff;
  color: #536471;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  box-shadow: none;
  transition: background .15s ease, border-color .15s ease;
}

.load-more-btn:hover:not(:disabled) { background:#f7f9f9;border-color:#cbd5e1 }
.load-more-btn:active:not(:disabled) { background:#eef2f6 }

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
  .feed { gap:10px;padding-right:0;padding-left:0; }
}

@media (prefers-reduced-motion: reduce) {
  .new-messages-notification,
  .highlight,
  :deep(.post-card.home-new-highlight) { animation: none; }
}
</style>
