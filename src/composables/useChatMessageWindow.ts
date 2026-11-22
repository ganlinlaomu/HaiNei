import { computed, nextTick, ref, watch, type Ref } from "vue";
import { installManualScrollAnchoring } from "@/utils/scrollAnchor";
import { debugLog } from "@/utils/debugLog";
import type { InboxItem } from "@/stores/messages";
import {
  focusBoundedMessageWindow,
  initialBoundedMessageWindow,
  isNearMessageBottom,
  mergeBoundedMessageIndexes,
  scrollTopAfterAnchorShift,
  scrollTopAfterNewMessages,
  shiftBoundedMessageWindow,
  type MessageScrollMetrics,
} from "@/utils/messageWindow";

export const INITIAL_MESSAGE_COUNT = 60;
/**
 * Older rows go in above the reader only once scrolling is idle (iOS, below),
 * so each insertion is a pause. Few, large batches inserted while there is
 * still plenty to scroll keep a fling from running into the top: 100 rows in
 * batches of 40, inserted only at the very top, felt like loading page by page.
 */
export const OLDER_MESSAGE_BATCH = 120;
export const MAX_RENDERED_MESSAGES = 300;
export const TOP_LOAD_THRESHOLD = 120;
/** Insert older rows while the reader is still this many screens from the top. */
export const OLDER_INSERT_SCREENS = 3;
/**
 * iOS ignores (or momentum overwrites) a scrollTop set while the list is
 * still scrolling. Older rows inserted then left the list at the top of the
 * new rows: the chat "jumped" to long-ago messages. Rows are inserted above
 * only after the scroll has been idle this long.
 */
export const SCROLL_IDLE_MS = 150;
/**
 * Start reading the next older page while the reader is still this many
 * screens from the top, so reaching the top does not wait on the local DB.
 */
export const OLDER_PREFETCH_SCREENS = 6;
export const BOTTOM_FOLLOW_THRESHOLD = 120;

/**
 * The chat's rendered slice of a long conversation and its scroll position:
 * it keeps at most MAX_RENDERED_MESSAGES rows mounted, loads older rows near
 * the top without the visible row jumping, follows new messages only while
 * the reader is at the bottom, and otherwise counts them for "jump to latest".
 */
export function useChatMessageWindow(options: {
  messages: Readonly<Ref<InboxItem[]>>;
  messageList: Readonly<Ref<HTMLElement | null>>;
  peerPubkey: Readonly<Ref<string>>;
  searchContextActive: Readonly<Ref<boolean>>;
  searchContextMessages: Readonly<Ref<InboxItem[]>>;
  sourceFocusReadSuppressed: Readonly<Ref<boolean>>;
  historyExhausted: Readonly<Ref<boolean>>;
  /**
   * Read the next older page. Return a commit function to let the window
   * apply it at the moment it re-anchors (preferred); committing inside the
   * read lets Vue re-render before the anchor is measured.
   */
  fetchOlderPage: () => Promise<void | (() => void)>;
  /** Rows that must stay mounted (open menu, active swipe, highlight). */
  retainedIds: () => string[];
  isDisposed: () => boolean;
  isLoading: () => boolean;
  markRead: () => Promise<void>;
  onScroll?: () => void;
}) {
  const {
    messages, messageList, peerPubkey, searchContextActive, searchContextMessages,
    sourceFocusReadSuppressed, historyExhausted, fetchOlderPage, retainedIds,
    isDisposed, isLoading, markRead, onScroll,
  } = options;
  const initialWindowRange = initialBoundedMessageWindow(messages.value.length, INITIAL_MESSAGE_COUNT);
  const windowStart = ref(initialWindowRange.start);
  const windowEnd = ref(initialWindowRange.end);
  const showJumpToLatest = ref(false);
  const pendingTailCount = ref(0);
  let prependingOlder = false;
  /** A history page read ahead of the scroll; consumed by the next prepend. */
  let prefetchedPage: { peer: string; startedAt: number; promise: Promise<void | (() => void)> } | undefined;
  function prefetchOlderPage() {
    if (prefetchedPage || prependingOlder || historyExhausted.value) return;
    const promise = fetchOlderPage();
    promise.catch(() => undefined);
    prefetchedPage = { peer: peerPubkey.value, startedAt: now(), promise };
  }
  function takePrefetchedPage() {
    const page = prefetchedPage;
    prefetchedPage = undefined;
    return page?.peer === peerPubkey.value ? page : undefined;
  }
  let windowMutationInProgress = false;
  let followLatestTail = true;
  let restoreOverflowAnchorFrame: number | null = null;
  let lastScrollAt = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  async function untilScrollIdle() {
    while (!isDisposed() && now() - lastScrollAt < SCROLL_IDLE_MS) {
      await new Promise(resolve => setTimeout(resolve, Math.max(16, SCROLL_IDLE_MS - (now() - lastScrollAt))));
    }
  }
  let stopScrollAnchoring: () => void = () => undefined;
  // iOS Safari has no native scroll anchoring: keep older history still while
  // its images and cards finish loading above the viewport.
  watch(messageList, list => {
    stopScrollAnchoring();
    stopScrollAnchoring = list
      ? installManualScrollAnchoring(list, { rowSelector: ".message-line[data-message-id]", enabled: () => !windowMutationInProgress })
      : () => undefined;
  }, { immediate: true, flush: "post" });

  const retainedPlaybackMessageId = ref("");
  const retainedMessageIds = computed(() => [...new Set([
    ...retainedIds(),
    retainedPlaybackMessageId.value,
  ].filter(Boolean))]);
  const windowMessages = computed(() => {
    if (searchContextActive.value) return searchContextMessages.value;
    const retainedIndexes = retainedMessageIds.value
      .map(id => messages.value.findIndex(message => message.id === id))
      .filter(index => index >= 0);
    return mergeBoundedMessageIndexes(
      { start: windowStart.value, end: windowEnd.value },
      messages.value.length,
      retainedIndexes,
    )
      .map(index => messages.value[index])
      .filter((message): message is InboxItem => !!message);
  });

  function setMessageListToBottom() {
    const list = messageList.value;
    refreshRetainedPlaybackMessage();
    const range = initialBoundedMessageWindow(
      messages.value.length,
      INITIAL_MESSAGE_COUNT,
    );
    if (windowStart.value !== range.start || windowEnd.value !== range.end) {
      windowStart.value = range.start;
      windowEnd.value = range.end;
      void nextTick(setMessageListToBottom);
      return;
    }
    if (list) list.scrollTop = list.scrollHeight;
    followLatestTail = true;
    showJumpToLatest.value = false;
    pendingTailCount.value = 0;
  }
  function scrollToBottom() {
    void nextTick(setMessageListToBottom);
  }

  function scrollMetrics(element: HTMLElement): MessageScrollMetrics {
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  }

  type MessageDomAnchor = { id: string; offset: number; scrollTop: number };

  function refreshRetainedPlaybackMessage() {
    const playingShell = messageList.value?.querySelector<HTMLElement>(".voice-shell.playing");
    const playingLine = playingShell?.closest<HTMLElement>(".message-line[data-message-id]");
    retainedPlaybackMessageId.value = playingLine?.dataset.messageId || "";
  }

  function captureMessageDomAnchor(list: HTMLElement): MessageDomAnchor | undefined {
    const listTop = list.getBoundingClientRect().top;
    const rows = [...list.querySelectorAll<HTMLElement>(".message-line[data-message-id]")];
    const row = rows.find(candidate => candidate.getBoundingClientRect().bottom > listTop + 1) || rows[0];
    const id = row?.dataset.messageId;
    if (!row || !id) return undefined;
    return { id, offset: row.getBoundingClientRect().top - listTop, scrollTop: list.scrollTop };
  }

  function restoreMessageDomAnchor(list: HTMLElement, anchor?: MessageDomAnchor) {
    if (!anchor) return;
    const row = [...list.querySelectorAll<HTMLElement>(".message-line[data-message-id]")]
      .find(candidate => candidate.dataset.messageId === anchor.id);
    if (!row) return;
    const nextOffset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = scrollTopAfterAnchorShift(anchor.scrollTop, anchor.offset, nextOffset);
  }

  function restoreNativeOverflowAnchor(list: HTMLElement) {
    if (restoreOverflowAnchorFrame !== null) cancelAnimationFrame(restoreOverflowAnchorFrame);
    restoreOverflowAnchorFrame = requestAnimationFrame(() => {
      restoreOverflowAnchorFrame = null;
      list.style.removeProperty("overflow-anchor");
    });
  }

  function resetMessageWindow() {
    prefetchedPage = undefined;
    const range = initialBoundedMessageWindow(
      messages.value.length,
      INITIAL_MESSAGE_COUNT,
    );
    windowStart.value = range.start;
    windowEnd.value = range.end;
  }

  async function prependOlderMessages() {
    const list = messageList.value;
    if (!list || prependingOlder || (windowStart.value === 0 && historyExhausted.value)) return;

    prependingOlder = true;
    const peerAtStart = peerPubkey.value;
    const earlyAnchor = captureMessageDomAnchor(list);
    const needsHistoryPage = windowStart.value === 0 && !historyExhausted.value;

    try {
      // The read is slow (local DB + decrypt) and the user keeps scrolling,
      // often with iOS momentum. Measure the anchor only when the page is
      // applied: an anchor taken before the read threw the list back by
      // twice the distance scrolled meanwhile.
      const startedAt = now();
      const prefetched = needsHistoryPage ? takePrefetchedPage() : undefined;
      const commit = needsHistoryPage ? await (prefetched?.promise ?? fetchOlderPage()) : undefined;
      const waitedMs = Math.round(now() - startedAt);
      if (isDisposed() || peerAtStart !== peerPubkey.value) return;
      // Never insert above while momentum scrolling: iOS would drop the
      // scroll correction below. The page is already read; this only waits.
      await untilScrollIdle();
      if (isDisposed() || peerAtStart !== peerPubkey.value) return;
      const idleMs = Math.round(now() - startedAt) - waitedMs;

      windowMutationInProgress = true;
      list.style.overflowAnchor = "none";
      const anchor = typeof commit === "function" ? captureMessageDomAnchor(list) : earlyAnchor;
      if (typeof commit === "function") commit();
      refreshRetainedPlaybackMessage();
      const anchorIndex = anchor ? messages.value.findIndex(message => message.id === anchor.id) : -1;
      const range = needsHistoryPage && anchorIndex >= 0
        ? focusBoundedMessageWindow(messages.value.length, anchorIndex, OLDER_MESSAGE_BATCH, MAX_RENDERED_MESSAGES)
        : shiftBoundedMessageWindow(
          { start: windowStart.value, end: windowEnd.value },
          messages.value.length,
          "older",
          OLDER_MESSAGE_BATCH,
          MAX_RENDERED_MESSAGES,
        );

      windowStart.value = range.start;
      windowEnd.value = range.end;
      await nextTick();
      if (isDisposed() || peerAtStart !== peerPubkey.value) return;
      restoreMessageDomAnchor(list, anchor);
      verifyScrollKept(list, anchor);
      if (needsHistoryPage) {
        debugLog("ui", "chat_older_page", {
          prefetched: !!prefetched,
          readMs: prefetched ? Math.round(now() - prefetched.startedAt) : waitedMs,
          waitedMs,
          idleMs,
          applyMs: Math.round(now() - startedAt) - waitedMs - idleMs,
          // How close to the top the reader was: near 0 means a fling hit it.
          screensFromTop: list.clientHeight ? Math.round((anchor?.scrollTop ?? list.scrollTop) / list.clientHeight * 10) / 10 : null,
        }, "info");
      }
    } finally {
      windowMutationInProgress = false;
      prependingOlder = false;
      restoreNativeOverflowAnchor(list);
    }
  }

  /** Diagnostics: did the browser keep the scroll position we restored? */
  function verifyScrollKept(list: HTMLElement, anchor?: MessageDomAnchor) {
    if (!anchor) return;
    const expected = list.scrollTop;
    requestAnimationFrame(() => {
      if (isDisposed()) return;
      const drift = Math.round(list.scrollTop - expected);
      if (Math.abs(drift) > 40) debugLog("ui", "chat_prepend_scroll_overridden", { drift, sinceScrollMs: Math.round(now() - lastScrollAt) }, "warn");
    });
  }

  async function appendNewerMessages() {
    const list = messageList.value;
    if (!list || prependingOlder || windowEnd.value >= messages.value.length) return;

    prependingOlder = true;
    const peerAtStart = peerPubkey.value;

    try {
      await untilScrollIdle();
      if (isDisposed() || peerAtStart !== peerPubkey.value) return;
      windowMutationInProgress = true;
      const anchor = captureMessageDomAnchor(list);
      list.style.overflowAnchor = "none";
      refreshRetainedPlaybackMessage();
      const range = shiftBoundedMessageWindow(
        { start: windowStart.value, end: windowEnd.value },
        messages.value.length,
        "newer",
        OLDER_MESSAGE_BATCH,
        MAX_RENDERED_MESSAGES,
      );
      windowStart.value = range.start;
      windowEnd.value = range.end;
      await nextTick();
      if (isDisposed() || peerAtStart !== peerPubkey.value) return;
      restoreMessageDomAnchor(list, anchor);
    } finally {
      windowMutationInProgress = false;
      prependingOlder = false;
      restoreNativeOverflowAnchor(list);
    }
  }

  function handleMessageMediaLoad() {
    const list = messageList.value;
    if (!list || searchContextActive.value || !followLatestTail || windowEnd.value < messages.value.length) return;
    requestAnimationFrame(() => {
      if (!isDisposed() && followLatestTail && windowEnd.value >= messages.value.length) setMessageListToBottom();
    });
  }

  let messageScrollFrame: number | null = null;

  /** Scroll events fire many times per frame on iOS momentum scrolling; the
   * layout reads and window updates below only need to run once per frame. */
  function handleMessageScroll() {
    if (messageScrollFrame !== null) return;
    messageScrollFrame = requestAnimationFrame(() => {
      messageScrollFrame = null;
      if (!isDisposed()) processMessageScroll();
    });
  }

  function processMessageScroll() {
    const list = messageList.value;
    if (!list) return;
    lastScrollAt = now();
    onScroll?.();
    if (searchContextActive.value) {
      followLatestTail = false;
      showJumpToLatest.value = true;
      return;
    }

    if (list.scrollTop <= Math.max(TOP_LOAD_THRESHOLD, list.clientHeight * OLDER_INSERT_SCREENS)) void prependOlderMessages();
    else if (windowStart.value === 0 && list.scrollTop <= list.clientHeight * OLDER_PREFETCH_SCREENS) prefetchOlderPage();
    const metrics = scrollMetrics(list);
    const nearBottom = isNearMessageBottom(metrics, BOTTOM_FOLLOW_THRESHOLD);
    if (nearBottom && windowEnd.value < messages.value.length) void appendNewerMessages();

    const atConversationTail = windowEnd.value >= messages.value.length;
    if (atConversationTail && nearBottom && !sourceFocusReadSuppressed.value) {
      followLatestTail = true;
      showJumpToLatest.value = false;
      pendingTailCount.value = 0;
      if (!isLoading()) void markRead();
    } else {
      followLatestTail = false;
      if (list.scrollHeight > list.clientHeight + BOTTOM_FOLLOW_THRESHOLD || !atConversationTail) {
        showJumpToLatest.value = true;
      }
    }
  }

  function sameIds(left: string[], right: string[] | undefined) {
    if (!right || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
    return true;
  }
  // Compare id lists directly instead of joining thousands of 64-char ids into
  // one string (and splitting it again) on every recompute.
  watch(() => messages.value.map(message => message.id), async (nextIds, previousIdsOrUndefined) => {
    if (sameIds(nextIds, previousIdsOrUndefined)) return;
    if (windowMutationInProgress) return;
    const previousIds = previousIdsOrUndefined ?? [];
    if (isLoading()) {
      resetMessageWindow();
      return;
    }

    const list = messageList.value;
    const previousMetrics = list ? scrollMetrics(list) : undefined;
    const previousWindowEnd = Math.min(windowEnd.value, previousIds.length);
    const previousFirstId = previousIds[windowStart.value];
    const previousWindowLastId = previousIds[Math.max(windowStart.value, previousWindowEnd - 1)];
    const previousConversationLastId = previousIds.at(-1);
    const previousConversationLastIndex = previousConversationLastId ? nextIds.indexOf(previousConversationLastId) : -1;
    const hasNewTail = !!nextIds.length
      && (!previousConversationLastId || previousConversationLastIndex < nextIds.length - 1);
    const newTailCount = hasNewTail
      ? Math.max(1, previousConversationLastIndex >= 0
        ? nextIds.length - previousConversationLastIndex - 1
        : nextIds.length - previousIds.length)
      : 0;

    if (searchContextActive.value) {
      if (hasNewTail) {
        showJumpToLatest.value = true;
        pendingTailCount.value += newTailCount;
      }
      return;
    }

    const wasAtConversationTail = previousWindowEnd >= previousIds.length;
    const followingLatest = !!list && !!previousMetrics && wasAtConversationTail
      && isNearMessageBottom(previousMetrics, BOTTOM_FOLLOW_THRESHOLD);

    if (list && previousMetrics && hasNewTail && followingLatest) {
      refreshRetainedPlaybackMessage();
      const range = initialBoundedMessageWindow(
        nextIds.length,
        INITIAL_MESSAGE_COUNT,
      );
      windowStart.value = range.start;
      windowEnd.value = range.end;
      await nextTick();
      list.scrollTop = scrollTopAfterNewMessages(previousMetrics, list.scrollHeight, BOTTOM_FOLLOW_THRESHOLD);
      followLatestTail = true;
      showJumpToLatest.value = false;
      pendingTailCount.value = 0;
      if (!sourceFocusReadSuppressed.value) await markRead();
      return;
    }

    const preservedStart = previousFirstId ? nextIds.indexOf(previousFirstId) : -1;
    const preservedLast = previousWindowLastId ? nextIds.indexOf(previousWindowLastId) : -1;
    if (preservedStart >= 0 && preservedLast >= preservedStart) {
      windowStart.value = preservedStart;
      windowEnd.value = preservedLast + 1;
    } else {
      resetMessageWindow();
    }

    if (hasNewTail) {
      followLatestTail = false;
      showJumpToLatest.value = true;
      pendingTailCount.value += newTailCount;
    }
  });

  /** Mount the rows around `index` (e.g. a quoted or searched message). */
  async function focusWindowOn(index: number) {
    refreshRetainedPlaybackMessage();
    const range = focusBoundedMessageWindow(
      messages.value.length,
      index,
      6,
      MAX_RENDERED_MESSAGES,
    );
    windowStart.value = range.start;
    windowEnd.value = range.end;
    await nextTick();
  }

  function isTailRendered() {
    return windowEnd.value >= messages.value.length;
  }

  function isListNearBottom() {
    const list = messageList.value;
    return !!list && isNearMessageBottom(scrollMetrics(list), BOTTOM_FOLLOW_THRESHOLD);
  }

  function disposeMessageWindow() {
    stopScrollAnchoring();
    stopScrollAnchoring = () => undefined;
    if (restoreOverflowAnchorFrame !== null) cancelAnimationFrame(restoreOverflowAnchorFrame);
    if (messageScrollFrame !== null) cancelAnimationFrame(messageScrollFrame);
    messageScrollFrame = null;
  }

  return {
    windowStart, windowEnd, windowMessages, showJumpToLatest, pendingTailCount, retainedPlaybackMessageId,
    setMessageListToBottom, scrollToBottom, resetMessageWindow, focusWindowOn,
    handleMessageScroll, handleMessageMediaLoad, isTailRendered, isListNearBottom, disposeMessageWindow,
  };
}
