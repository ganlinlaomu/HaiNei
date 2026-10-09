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
        :open-comment-id="route.query.mid === m.id ? String(route.query.rid || route.query.iid || '') : undefined"
        @height="recordPostHeight"
      />
      <div v-if="bottomSpacerHeight" class="virtual-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true"></div>
      
      <div v-if="hasMore" ref="loadMoreSentinel" class="load-more-sentinel" aria-live="polite">
        <span v-if="isLoadingMore">正在加载…</span>
        <button v-else-if="!autoLoadSupported" class="load-more-btn" type="button" @click="loadMoreMessages({ notifyOnError: true })">
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
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { usePostsStore } from "@/stores/posts";
import { isInteractionMessage, useInteractionsStore } from "@/stores/interactions";
import { logger } from "@/utils/logger";
import PostCard from "@/components/PostCard.vue";
import { useRoute, useRouter } from "vue-router";
import { usePullToRefresh } from "@/components/usePullToRefresh";
import { getLastSeenCreatedAt, updateLastSeenToNewest } from "@/utils/lastSeen";
import { useRealtimeInboxReconcile } from "@/components/useRealtimeInboxReconcile";
import { getAccountMessageSyncStatus, markAccountConversationRead, onAccountMessageSyncStatus, resumeAccountMessageSync } from "@/services/accountMessageSync";
import { useUIStore } from "@/stores/ui";
import type { SyncStatus } from "@/nostr/messaging/sync/types";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import {
  isFeedRenderableMessage,
  syncedMessageRecordToInboxItem,
} from "@/nostr/messaging/messageViewModel";
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
    const posts = usePostsStore();
    posts.startPostDeliveryTracking();
    const interactions = useInteractionsStore();
    const ui = useUIStore();
    const feedPreferences = useFeedPreferencesStore();
    const readyForPending = ref(false);
    const route = useRoute();
    const router = useRouter();
    const notificationJumpDone = ref(false);
    const lastSeenCreatedAt = ref(0); // Track the watermark for filtering pending messages
    const inboxRevision = computed(() => msgs.inboxRevision);
    const feedPreferenceRevision = computed(() => feedPreferences.revision);
    const isHomeRenderable = isFeedRenderableMessage;
    const storedHistory = ref<InboxItem[]>([]);
    let historyCursor: {createdAt:number;id:string} | undefined;
    const historyExhausted = ref(false);
    const visibleInbox = () => [...new Map([...storedHistory.value,...msgs.inbox].map(m=>[m.id,m])).values()].filter(message => isHomeRenderable(message) && feedPreferences.isVisible(message));

    let homeAccountPk = "";
    let stopSyncStatusListener: (() => void) | null = null;

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
    const homeRelayState = ref<"idle" | "connecting" | "connected" | "offline">("idle");
    const showRelayDisconnect = ref(false);
    let relayDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    function clearRelayDisconnectTimer() {
      if (relayDisconnectTimer !== null) clearTimeout(relayDisconnectTimer);
      relayDisconnectTimer = null;
    }
    function updateRelayNotice(relay: typeof homeRelayState.value) {
      homeRelayState.value = relay;
      clearRelayDisconnectTimer();
      if (relay !== "offline") {
        showRelayDisconnect.value = false;
      } else if (!showRelayDisconnect.value) {
        relayDisconnectTimer = setTimeout(() => {
          relayDisconnectTimer = null;
          if (homeRelayState.value === "offline") showRelayDisconnect.value = true;
        }, 2000);
      }
    }
    const connectionNotice = computed(() =>
      showRelayDisconnect.value && homeRelayState.value === "offline"
        ? "正在重新连接…已缓存内容仍可查看"
        : ""
    );

    function applyAccountSyncStatus(snapshot = getAccountMessageSyncStatus()) {
      if (!keys.pkHex || snapshot.accountPubkey !== keys.pkHex.toLowerCase()) return;
      const wasStartupSyncing = startupSyncing.value;
      homeSyncStatus.value = snapshot.status;
      updateRelayNotice(snapshot.relay);
      if (snapshot.status === "connecting" || snapshot.status === "catching-up") {
        startupSyncing.value = true;
        return;
      }
      if (snapshot.status === "live" || snapshot.status === "error") {
        if (wasStartupSyncing && readyForPending.value) reconcileStartupSnapshot(true);
        startupSyncing.value = false;
        return;
      }
      if (snapshot.status === "idle") startupSyncing.value = false;
    }

    // 分页相关状态
    const PAGE_SIZE = 20; // 每页显示 20 条
    const hasMore = computed(() => {
      return !historyExhausted.value || messagesRef.value.length > displayedMessages.value.length;
    });
    const isLoadingMore = ref(false);
    const loadMoreSentinel = ref<HTMLElement | null>(null);
    const autoLoadSupported = ref(typeof IntersectionObserver !== "undefined");
    let loadMoreObserver: IntersectionObserver | null = null;
    const acceptedFriends = computed(() => friends.getAcceptedList(friendships.isAccepted));

    function clearHomeRuntimeState() {
      storedHistory.value=[]; historyCursor=undefined; historyExhausted.value=false;
      messagesRef.value = [];
      displayedMessages.value = [];
      pendingMessages.value = [];
      readyForPending.value = false;
      lastSeenCreatedAt.value = 0;
      notificationJumpDone.value = false;
      startupSyncing.value = false;
      homeSyncStatus.value = "idle";
      updateRelayNotice("idle");
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
          void markAccountConversationRead(String(conversationId));
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
    async function loadMoreMessages(options: { notifyOnError?: boolean } = {}) {
      if (
        isLoadingMore.value
        || !hasMore.value
        || !readyForPending.value
        || homeAccountPk !== keys.pkHex
      ) return;
      isLoadingMore.value=true;
      const account=keys.pkHex;
      try {
        if (messagesRef.value.length <= displayedMessages.value.length + PAGE_SIZE && !historyExhausted.value) {
          const records=await syncedMessageRepository.listHistoryPage(account,historyCursor);
          if(keys.pkHex!==account)return;
          historyExhausted.value=records.length<100;
          const last=records.at(-1);
          if(last)historyCursor={createdAt:last.createdAt,id:last.id};
          const restored=records.map(syncedMessageRecordToInboxItem);
          storedHistory.value=[...storedHistory.value,...restored];
          rebuildVisibleInbox();
        }
        displayedMessages.value=messagesRef.value.slice(0,displayedMessages.value.length+PAGE_SIZE);
      } catch (error) {
        if (keys.pkHex !== account) return;
        logger.warn("[home] local history page unavailable; will retry", error);
        if (options.notifyOnError) ui.addToast("历史消息加载失败，请重试", 1800, "error");
      }
      finally {isLoadingMore.value=false;}
    }

    function attachLoadMoreObserver() {
      loadMoreObserver?.disconnect();
      loadMoreObserver = null;
      // The sentinel can be visible on first paint. Do not let it race account
      // vault hydration and turn a transient startup state into an error toast.
      if (!readyForPending.value || homeAccountPk !== keys.pkHex) return;
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
        await resumeAccountMessageSync("manual");
        safeUpdateLocalRefs();     // UI 刷新
      }
    });


    // Helper to check if query has notification params
    function hasNotificationParams(query: any): boolean {
      return !!(query.mid || query.iid);
    }


  async function resolveNotificationPost(mid: string) {
    const existing = messagesRef.value.find(message => message.id === mid)
      || displayedMessages.value.find(message => message.id === mid)
      || msgs.inbox.find(message => message.id === mid);
    if (existing) return existing;

    if (!keys.pkHex) return null;
    const record = await syncedMessageRepository.get(keys.pkHex, mid);
    const restored = record ? syncedMessageRecordToInboxItem(record) : null;
    if (!restored || !isHomeRenderable(restored)) return null;
    return restored;
  }

  async function handleNotificationJump() {
    const mid = route.query.mid as string | undefined;
    const targetCommentId = String(route.query.rid || route.query.iid || "") || undefined;
    if (!mid || route.path !== "/") return;

    // Do not race Home initialization. The query stays in place and
    // initializeHomeRuntime invokes this again after the account snapshot is ready.
    if (!readyForPending.value || homeAccountPk !== keys.pkHex) return;

    const targetPost = await resolveNotificationPost(mid);
    if (!targetPost || route.query.mid !== mid) {
      logger.warn("通知跳转失败：目标动态未找到", mid);
      ui.addToast("这条动态暂未同步到本机", 1800, "error");
      return;
    }

    // Notification navigation must not depend on the normal first-page window.
    // Inject the exact post into the current rendered list without loading all
    // intervening history.
    if (!messagesRef.value.some(message => message.id === targetPost.id)) {
      messagesRef.value = insertSortedHomeMessage(messagesRef.value, targetPost);
    }
    if (!displayedMessages.value.some(message => message.id === targetPost.id)) {
      displayedMessages.value = insertSortedHomeMessage(displayedMessages.value, targetPost);
    }

    await nextTick();
    if (route.query.mid !== mid) return;

    const targetIndex = displayedMessages.value.findIndex(message => message.id === mid);
    if (targetIndex < 0) {
      logger.warn("通知跳转失败：目标动态未进入显示窗口", mid);
      return;
    }

    // Pin the virtual window around the exact target before moving the scroll
    // container. This guarantees PostCard mounts before CommentSheet opens.
    virtualStart.value = Math.max(0, targetIndex - 1);
    virtualEnd.value = Math.min(displayedMessages.value.length, targetIndex + 2);
    await nextTick();

    if (scrollContainer && feedElement.value) {
      const targetTop = feedElement.value.offsetTop + rangeHeight(0, targetIndex);
      scrollContainer.scrollTo({ top: Math.max(0, targetTop - SCROLL_SAFE_OFFSET), behavior: "auto" });
    }

    await nextTick();
    if (route.query.mid !== mid) return;

    const postElement = document.getElementById(`msg-${mid}`);
    if (postElement && !targetCommentId) {
      postElement.classList.add("highlight");
      setTimeout(() => postElement.classList.remove("highlight"), 1500);
    }

    // PostCard receives openCommentId reactively. Once its exact card is mounted,
    // CommentSheet owns expansion and comment/reply centering.
    notificationJumpDone.value = true;
  }


   onMounted(async () => {
     stopSyncStatusListener = onAccountMessageSyncStatus(applyAccountSyncStatus);
     applyAccountSyncStatus();
     attachVirtualScroll();
     if (!keys.pkHex || homeAccountPk === keys.pkHex) return;
     try {
       const initialized = await initializeHomeRuntime(keys.pkHex);
       if (initialized) await nextTick(attachLoadMoreObserver);
       await restoreCurrentHomeScroll();
     } catch (err) {
       logger.error("[account] Home initialization failed", err);
     }
   });

   onBeforeUnmount(() => {
     saveCurrentHomeScroll();
     detachLoadMoreObserver();
     detachVirtualScroll();
     stopSyncStatusListener?.();
     stopSyncStatusListener = null;
     clearHomeRuntimeState();
   });
   onActivated(() => {
     attachVirtualScroll();
     if (readyForPending.value && homeAccountPk === keys.pkHex) void nextTick(attachLoadMoreObserver);
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
       if (accountPk === previousPk) return;
       if (previousPk && scrollContainer) saveHomeScroll(previousPk, scrollContainer.scrollTop);
       clearHomeRuntimeState();
       if (!accountPk) return;
       homeSyncStatus.value = "idle";
       startupSyncing.value = false;
       applyAccountSyncStatus();
       logger.info(`[account] Home account switch ${previousPk?.slice(0, 8) || "none"} -> ${accountPk.slice(0, 8)}`);
       try {
         await initializeHomeRuntime(accountPk);
         await restoreCurrentHomeScroll();
       } catch (e) {
         logger.error("[account] switched account initialization failed", e);
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
