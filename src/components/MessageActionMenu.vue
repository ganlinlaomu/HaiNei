<template>
  <div class="message-action-backdrop" @click.self="emit('close')">
    <div ref="menuElement" class="message-action-menu" :class="{ dragging }"
      :style="menuStyle" role="menu" :aria-label="`消息操作：${preview}`">
      <div class="message-action-preview" @touchstart.passive="onTouchStart"
        @touchmove.passive="onTouchMove" @touchend.passive="finishTouch(false)"
        @touchcancel.passive="finishTouch(true)">
        <strong>{{ author }}</strong>
        <span>{{ preview }}</span>
      </div>
      <button type="button" role="menuitem" @click="emit('reply')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8 4 12l5 4"/><path d="M5 12h8a6 6 0 0 1 6 6"/></svg>
        <span>回复</span>
      </button>
      <button v-if="canCopy" type="button" role="menuitem" @click="emit('copy')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2 2v1"/></svg>
        <span>复制</span>
      </button>
      <button v-if="importable" type="button" role="menuitem"
        :disabled="importing" @click="emit('save')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/></svg>
        <span>{{ importing ? "摘录中…" : "摘录到私人空间" }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { canBeginVerticalDismissDrag, shouldDismissVerticalSheet } from "@/utils/postEditorGesture";

/**
 * Long-press menu for one chat message. The chat places it (it measures the
 * message list) and performs the actions; this owns the drag-down-to-close
 * gesture on the preview. Key it by message id so each opening starts fresh.
 */
const props = defineProps<{
  position: { top: number; left: number; width: number };
  author: string;
  preview: string;
  canCopy: boolean;
  importable: boolean;
  importing: boolean;
}>();
const emit = defineEmits<{ close: []; reply: []; copy: []; save: [] }>();

const menuElement = ref<HTMLElement | null>(null);
const dragging = ref(false);
const offset = ref(0);
let touchStart: { x: number; y: number; started: number } | null = null;
const menuStyle = computed(() => ({
  top: `${props.position.top}px`,
  left: `${props.position.left}px`,
  width: `${props.position.width}px`,
  transform: `translateY(${offset.value}px)`,
  opacity: String(Math.max(0.55, 1 - offset.value / 500)),
}));

function onTouchStart(event: TouchEvent) {
  const touch = event.touches[0];
  if (!touch || event.touches.length !== 1 || (menuElement.value?.scrollTop || 0) > 0) {
    touchStart = null;
    return;
  }
  touchStart = { x: touch.clientX, y: touch.clientY, started: performance.now() };
  dragging.value = false;
  offset.value = 0;
}
function onTouchMove(event: TouchEvent) {
  const touch = event.touches[0], gesture = touchStart;
  if (!touch || !gesture || event.touches.length !== 1) return;
  const dy = touch.clientY - gesture.y, dx = touch.clientX - gesture.x;
  const scrollTop = menuElement.value?.scrollTop || 0;
  if (scrollTop > 0) {
    touchStart = null;
    dragging.value = false;
    offset.value = 0;
    return;
  }
  if (!dragging.value) {
    if (dy < -6 || (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy))) {
      touchStart = null; // Allow native scrolling and horizontal gestures.
      return;
    }
    if (!canBeginVerticalDismissDrag(dx, dy, scrollTop)) return;
    dragging.value = true;
  }
  // Passive listeners do not block vertical page/menu scrolling.
  offset.value = Math.max(0, dy);
}
function finishTouch(cancelled: boolean) {
  const gesture = touchStart;
  touchStart = null;
  const dragged = dragging.value;
  const distance = offset.value;
  dragging.value = false;
  offset.value = 0;
  if (!cancelled && dragged && gesture && shouldDismissVerticalSheet(
    distance, distance / Math.max(1, performance.now() - gesture.started),
    menuElement.value?.offsetHeight || 0,
  )) emit("close");
}
</script>

<style scoped>
.message-action-backdrop{position:fixed;inset:0;z-index:20;background:rgba(15,23,42,.12);backdrop-filter:blur(.5px)}
.message-action-menu{position:fixed;max-height:calc(100dvh - 24px);overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain;transition:transform 200ms ease-out,opacity 200ms ease-out;border:1px solid var(--bd-rgba-203-213-225-82);border-radius:18px;background:var(--bg-rgba-255-255-255-98);box-shadow:0 18px 48px rgba(15,23,42,.22);backdrop-filter:blur(18px);transform-origin:center}
.message-action-menu.dragging{transition:none}
@media (prefers-reduced-motion: reduce){.message-action-menu{transition:opacity 150ms ease-out;transform:none!important}}
.message-action-preview{touch-action:pan-y;user-select:none;-webkit-user-select:none;display:flex;min-width:0;flex-direction:column;gap:2px;padding:11px 14px;border-bottom:1px solid var(--bd-eef1f4)}.message-action-preview strong,.message-action-preview span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.message-action-preview strong{font-size:12px;color:var(--fg-0f1419)}.message-action-preview span{font-size:13px;color:var(--fg-657786)}
.message-action-menu>button{display:flex;width:100%;min-height:52px;align-items:center;gap:12px;padding:0 16px;border:0;border-top:1px solid var(--bd-f1f3f5);background:transparent;color:var(--fg-0f1419);font:inherit;font-size:16px;text-align:left}.message-action-menu>button:first-of-type{border-top:0}.message-action-menu>button:active{background:var(--bg-f4f6f8)}.message-action-menu>button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
</style>
