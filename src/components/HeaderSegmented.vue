<template>
  <div ref="tabBar" class="header-segmented" role="tablist" aria-label="列表筛选">
    <span class="header-segmented-pill" :class="{ 'no-motion': !pillReady }" :style="pillStyle" aria-hidden="true"></span>
    <button v-for="option in options" :key="option.key" :data-segment-key="option.key"
      type="button" role="tab" :class="{ selected: modelValue === option.key }"
      :aria-selected="modelValue === option.key" @click="emit('update:modelValue', option.key)">
      {{ option.label }}<span v-if="option.count && option.count > 0" class="header-segmented-count">{{ option.count > 99 ? '99+' : option.count }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createTabPillObserver, selectedTabPill } from "@/utils/tabPillGeometry";

type SegmentOption = { key: string; label: string; count?: number };
const props = defineProps<{ options: readonly SegmentOption[]; modelValue: string }>();
const emit = defineEmits<{ (event: "update:modelValue", value: string): void }>();
const tabBar = ref<HTMLElement | null>(null);
const pillStyle = ref<Record<string, string>>({ opacity: "0", width: "0px", transform: "translateX(0px)" });
const pillReady = ref(false);
let animationFrame: number | null = null;
let disposed = false;

function measure() {
  if (disposed || !tabBar.value) return;
  const geometries = [...tabBar.value.querySelectorAll<HTMLButtonElement>("[data-segment-key]")].map(node => ({
    key: node.dataset.segmentKey || "", offsetLeft: node.offsetLeft, offsetWidth: node.offsetWidth,
  }));
  const pill = selectedTabPill(geometries, props.modelValue);
  if (!pill) {
    pillStyle.value = { ...pillStyle.value, opacity: "0" };
    return;
  }
  pillStyle.value = { opacity: "1", width: `${pill.width}px`, transform: `translateX(${pill.translateX}px)` };
  if (!pillReady.value && animationFrame === null) {
    animationFrame = requestAnimationFrame(() => {
      animationFrame = null;
      if (!disposed) pillReady.value = true;
    });
  }
}
const observer = createTabPillObserver(measure);
watch(() => [props.modelValue, props.options], () => { void nextTick(measure); }, { flush: "post" });
onMounted(() => {
  observer.attach(tabBar.value);
  window.addEventListener("resize", measure, { passive: true });
  void document.fonts?.ready.then(measure);
});
onBeforeUnmount(() => {
  disposed = true;
  observer.disconnect();
  window.removeEventListener("resize", measure);
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
});
</script>

<style scoped>
.header-segmented{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px;width:min(220px,51vw);height:36px;padding:3px;box-sizing:border-box;border-radius:10px;background:var(--bg-f1f5f9);isolation:isolate}
.header-segmented-pill{position:absolute;top:3px;left:0;height:30px;border-radius:8px;background:var(--bg-dfe8f4);z-index:0;transition:transform 200ms ease,opacity 180ms ease}
.header-segmented-pill.no-motion{transition:none}
.header-segmented button{position:relative;z-index:1;min-width:0;height:30px;border:0;padding:0 4px;border-radius:8px;background:transparent;color:var(--fg-64748b);font:inherit;font-size:12px;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:4px}
.header-segmented button.selected{font-weight:650;color:var(--fg-0f172a)}
.header-segmented-count{display:inline-flex;align-items:center;justify-content:center;min-width:14px;height:14px;border-radius:999px;background:#1d9bf0;color:#fff;font-size:10px;padding:0 3px}
@media(prefers-reduced-motion:reduce){.header-segmented-pill{transition:none}}
</style>
