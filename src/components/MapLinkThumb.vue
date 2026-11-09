<template>
  <div ref="root" class="map-link-thumb" :class="{ empty: !point }">
    <LocationMapPreview v-if="point" :location="location!" label="链接里的地点" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import LocationMapPreview from "@/components/LocationMapPreview.vue";
import { mapLinkPoint } from "@/services/mapLinkPoints";
import type { MapLinkPoint } from "@/utils/mapLinkLocation";

/**
 * A map thumbnail for a Google/Apple Maps link. Nothing is requested until the
 * card scrolls into view; a link whose place cannot be found shows no map.
 */
const props = defineProps<{ url: string }>();
const root = ref<HTMLElement | null>(null);
const point = ref<MapLinkPoint | null>(null);
const location = computed(() => point.value ? { ...point.value, at: 0 } : null);
let observer: IntersectionObserver | null = null;
let disposed = false;

async function resolve() {
  const found = await mapLinkPoint(props.url);
  if (!disposed) point.value = found;
}

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") return void resolve();
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer?.disconnect();
    observer = null;
    void resolve();
  }, { rootMargin: "200px" });
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
});
</script>

<style scoped>
/* Zero height, not display:none: a hidden element never intersects, so the lookup would never start. */
.map-link-thumb.empty{height:0;overflow:hidden}
.map-link-thumb :deep(.location-map-preview){height:140px;border-radius:0}
</style>
