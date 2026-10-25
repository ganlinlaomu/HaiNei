import { ref, onMounted, onBeforeUnmount } from "vue";
import { logger } from "@/utils/logger";

type PullOptions = {
  onRefresh: () => Promise<void> | void;
  threshold?: number;
  maxPull?: number;
};

export function usePullToRefresh(options: PullOptions) {
  const {
    onRefresh,
    threshold = 60,
    maxPull = 100
  } = options;

  const container = ref<HTMLElement | null>(null);
  const startY = ref(0);
  const startX = ref(0);
  const gestureStarted = ref(false);
  const pullDistance = ref(0);
  const refreshing = ref(false);

  const scrollRoot = () => document.querySelector("body > #app") as HTMLElement | null;
  function onTouchStart(e: TouchEvent) {
    const touch = e.touches[0];
    if (!touch || refreshing.value || (scrollRoot()?.scrollTop || 0) > 0
      || (e.target instanceof Element && e.target.closest("input,textarea,select,[role=dialog]"))) {
      gestureStarted.value = false;
      return;
    }
    startY.value = touch.clientY;
    startX.value = touch.clientX;
    gestureStarted.value = true;
  }

  function onTouchMove(e: TouchEvent) {
    if (!gestureStarted.value || refreshing.value || (scrollRoot()?.scrollTop || 0) > 0) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dy = touch.clientY - startY.value;
    const dx = touch.clientX - startX.value;
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) return;
    pullDistance.value = Math.min(dy, maxPull);
  }

  function onTouchEnd() {
    if (gestureStarted.value && pullDistance.value >= threshold && !refreshing.value) {
      pullDistance.value = threshold;
      void triggerRefresh();
    } else if (!refreshing.value) {
      pullDistance.value = 0;
    }
    gestureStarted.value = false;
  }
  function onTouchCancel() { gestureStarted.value = false; if (!refreshing.value) pullDistance.value = 0; }

  async function triggerRefresh() {
    if (refreshing.value) return;

    refreshing.value = true;
    logger.info("[PWA] pull to refresh");

    try {
      await onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      refreshing.value = false;
      pullDistance.value = 0;
    }
  }

  onMounted(() => {
    const el = container.value;
    if (!el) return;

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchCancel);
  });

  onBeforeUnmount(() => {
    const el = container.value;
    if (!el) return;

    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchCancel);
  });

  return {
    container,
    pullDistance,
    refreshing,
    triggerRefresh // ⭐ 可手动调用（如按钮 / resume）
  };
}