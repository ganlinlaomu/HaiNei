import { reactive, ref } from "vue";

export interface SwipeActionsOptions {
  actionWidth?: number;
  openThreshold?: number;
  intentThreshold?: number;
}

export function useSwipeActions(options: SwipeActionsOptions = {}) {
  const actionWidth = options.actionWidth ?? 120;
  const openThreshold = options.openThreshold ?? actionWidth / 2;
  const intentThreshold = options.intentThreshold ?? 6;
  const offsets = reactive<Record<string, number>>({});
  const startX = reactive<Record<string, number>>({});
  const startY = reactive<Record<string, number>>({});
  const activeId = ref("");
  const horizontalGesture = ref(false);

  function close(id: string) {
    offsets[id] = 0;
  }

  function closeOthers(id = "") {
    for (const key of Object.keys(offsets)) {
      if (key !== id && offsets[key]) offsets[key] = 0;
    }
  }

  function onTouchStart(event: TouchEvent, id: string) {
    const touch = event.touches[0];
    if (!touch) return;
    startX[id] = touch.clientX;
    startY[id] = touch.clientY;
    activeId.value = id;
    horizontalGesture.value = false;
    closeOthers(id);
  }

  function onTouchMove(event: TouchEvent, id: string) {
    if (activeId.value !== id) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startX[id];
    const dy = touch.clientY - startY[id];

    if (!horizontalGesture.value) {
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (Math.abs(dx) < intentThreshold) return;
      horizontalGesture.value = true;
    }

    if (event.cancelable) event.preventDefault();
    offsets[id] = Math.min(0, Math.max(dx, -actionWidth));
  }

  function resetGesture() {
    activeId.value = "";
    horizontalGesture.value = false;
  }

  function onTouchEnd(id: string) {
    if (activeId.value !== id) return;
    offsets[id] = offsets[id] < -openThreshold ? -actionWidth : 0;
    resetGesture();
  }

  function onTouchCancel(id: string) {
    if (activeId.value !== id) return;
    offsets[id] = 0;
    resetGesture();
  }

  function swipeStyle(id: string) {
    return { transform: `translateX(${offsets[id] || 0}px)` };
  }

  function isOpen(id: string) {
    return Boolean(offsets[id]);
  }

  return { close, closeOthers, isOpen, onTouchCancel, onTouchEnd, onTouchMove, onTouchStart, swipeStyle };
}
