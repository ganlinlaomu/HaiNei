import { ref } from "vue";
import type { InboxItem } from "@/stores/messages";

export const SWIPE_INTENT_THRESHOLD = 8;
export const SWIPE_REPLY_THRESHOLD = 52;
const SWIPE_MAX_DISTANCE = 72;
const LONG_PRESS_MS = 460;

function isInteractiveMessageTarget(target: EventTarget | null) {
  return typeof Element !== "undefined" && target instanceof Element
    && !!target.closest("button, a, input, textarea, select, audio, video, [role='slider']");
}
function isMediaGestureTarget(target: EventTarget | null) {
  return typeof Element !== "undefined" && target instanceof Element
    && !!target.closest(".post-image-preview, .optimistic-image, .voice-message");
}

/**
 * Touch gestures on a chat message: hold to open its action menu, swipe
 * right to reply. A drag cancels the long press; media keeps its own
 * horizontal gestures, and controls inside a bubble are left alone.
 */
export function useMessageGestures(options: {
  canReplyTo: (message: InboxItem) => boolean;
  onLongPress: (message: InboxItem) => void;
  onSwipeReply: (message: InboxItem) => void;
}) {
  const swipingMessageId = ref("");
  const swipeOffset = ref(0);
  let messageGesture: {
    id: string;
    startX: number;
    startY: number;
    horizontal: boolean;
    longPressed: boolean;
    allowSwipe: boolean;
  } | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function clearLongPressTimer() {
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  function resetMessageGesture() {
    clearLongPressTimer();
    messageGesture = null;
    swipingMessageId.value = "";
    swipeOffset.value = 0;
  }
  function swipeReplyIndicatorStyle() {
    const progress = Math.min(1, swipeOffset.value / SWIPE_REPLY_THRESHOLD);
    return {
      width: `${Math.min(30, swipeOffset.value * 0.5)}px`,
      opacity: String(progress),
      transform: `scale(${0.75 + progress * 0.25})`,
    };
  }
  function handleMessageTouchStart(message: InboxItem, event: TouchEvent) {
    if (!options.canReplyTo(message) || isInteractiveMessageTarget(event.target)) return;
    const touch = event.touches[0];
    if (!touch) return;
    resetMessageGesture();
    messageGesture = {
      id: message.id,
      startX: touch.clientX,
      startY: touch.clientY,
      horizontal: false,
      longPressed: false,
      allowSwipe: !isMediaGestureTarget(event.target),
    };
    swipingMessageId.value = message.id;
    longPressTimer = setTimeout(() => {
      if (!messageGesture || messageGesture.id !== message.id) return;
      messageGesture.longPressed = true;
      options.onLongPress(message);
    }, LONG_PRESS_MS);
  }
  function handleMessageTouchMove(message: InboxItem, event: TouchEvent) {
    const gesture = messageGesture;
    if (!gesture || gesture.id !== message.id) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    if (Math.hypot(dx, dy) > SWIPE_INTENT_THRESHOLD) clearLongPressTimer();
    if (!gesture.allowSwipe) return;
    if (!gesture.horizontal) {
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (Math.abs(dx) < SWIPE_INTENT_THRESHOLD) return;
      gesture.horizontal = true;
    }
    if (dx <= 0) {
      swipeOffset.value = 0;
      return;
    }
    if (event.cancelable) event.preventDefault();
    swipeOffset.value = Math.min(SWIPE_MAX_DISTANCE, dx);
  }
  function handleMessageTouchEnd(message: InboxItem) {
    const gesture = messageGesture;
    if (!gesture || gesture.id !== message.id) return;
    const shouldReply = !gesture.longPressed && gesture.horizontal && swipeOffset.value >= SWIPE_REPLY_THRESHOLD;
    resetMessageGesture();
    if (shouldReply) options.onSwipeReply(message);
  }
  function handleMessageTouchCancel(message: InboxItem) {
    if (messageGesture?.id !== message.id) return;
    resetMessageGesture();
  }

  return {
    swipingMessageId,
    swipeOffset,
    swipeReplyIndicatorStyle,
    resetMessageGesture,
    handleMessageTouchStart,
    handleMessageTouchMove,
    handleMessageTouchEnd,
    handleMessageTouchCancel,
  };
}
