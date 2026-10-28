<template>
  <div ref="mapElement" class="location-map-preview" :class="{ unavailable: mapUnavailable }">
    <template v-if="tilesReady">
      <img
        v-for="tile in tiles"
        :key="tile.key"
        class="location-map-preview-tile"
        crossorigin="anonymous"
        referrerpolicy="origin"
        :src="tileUrl(workerBase, tile)"
        :style="{ left: `${tile.left}px`, top: `${tile.top}px` }"
        width="256"
        height="256"
        alt=""
        draggable="false"
        @load="tileLoaded"
        @error="tileFailed"
      />
    </template>
    <svg v-if="trailLine || myTrailLine" class="location-map-preview-trail" :width="width" :height="height" aria-hidden="true">
      <polyline v-if="myTrailLine" :class="locationIsMine ? 'peer' : 'me'" :points="myTrailLine" />
      <polyline v-if="trailLine" :class="locationIsMine ? 'me' : 'peer'" :points="trailLine" />
    </svg>
    <span
      class="location-map-preview-marker"
      :class="{ me: locationIsMine, peer: !locationIsMine }"
      :style="{ left: `${peerMarker.left}px`, top: `${peerMarker.top}px` }"
      :aria-label="locationIsMine ? '我的位置' : label"
      role="img"
    >
      <ProfileAvatar v-if="!locationIsMine && peerPubkey" :pubkey="peerPubkey" :size="30" />
    </span>
    <span
      v-if="myLocation"
      class="location-map-preview-marker"
      :class="locationIsMine ? 'peer' : 'me'"
      :style="{ left: `${myMarker.left}px`, top: `${myMarker.top}px` }"
      :aria-label="locationIsMine ? label : '我的位置'"
      role="img"
    >
      <ProfileAvatar v-if="locationIsMine && peerPubkey" :pubkey="peerPubkey" :size="30" />
    </span>
    <span v-if="!tilesReady" class="location-map-preview-loading">地图加载中…</span>
    <span v-else-if="mapUnavailable" class="location-map-preview-loading">地图暂时无法加载</span>
    <span class="location-map-preview-attribution">© OpenStreetMap</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import type { LocationShare } from "@/nostr/messaging/locationShare";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { centerOf, fitZoom, LIVE_MAP_ZOOM, tilesFor, tileUrl, toScreen, trailPath, trailPoints } from "@/utils/mapTiles";

const props = defineProps<{
  location: LocationShare;
  myLocation?: LocationShare;
  /** A live share's walk so far (location's, then myLocation's), oldest first. */
  trail?: LocationShare[];
  myTrail?: LocationShare[];
  peerPubkey?: string;
  label: string;
  /** The primary card belongs to us; the optional second point is the peer. */
  locationIsMine?: boolean;
}>();

const workerBase = haineiWorkerBaseUrl();
const mapElement = ref<HTMLElement | null>(null);
const width = ref(280);
const height = ref(164);
const tilesReady = ref(false);
// Frame the whole walk, not just the newest point: re-centring on the person
// at every update kept the marker fixed mid-map, so moving looked like nothing.
const points = computed(() => [props.location, ...(props.myLocation ? [props.myLocation] : []),
  ...(props.trail ?? []), ...(props.myTrail ?? [])]);
const isLive = computed(() => !!props.trail?.length || !!props.myTrail?.length);
const zoom = computed(() => fitZoom(points.value, width.value, height.value, 34, isLive.value ? LIVE_MAP_ZOOM : 15));
const center = computed(() => centerOf(points.value, zoom.value));
const tiles = computed(() => tilesFor(center.value, zoom.value, width.value, height.value));
const peerMarker = computed(() => toScreen(props.location, center.value, zoom.value, width.value, height.value));
const line = (trail: LocationShare[] | undefined, current?: LocationShare) => {
  const path = trailPath(trail, current);
  return path.length > 1 ? trailPoints(path, center.value, zoom.value, width.value, height.value) : "";
};
const trailLine = computed(() => props.trail?.length ? line(props.trail, props.location) : "");
const myTrailLine = computed(() => props.myTrail?.length && props.myLocation ? line(props.myTrail, props.myLocation) : "");
const myMarker = computed(() => toScreen(props.myLocation ?? props.location, center.value, zoom.value, width.value, height.value));

const loaded = ref(0);
const failed = ref(0);
const mapUnavailable = computed(() => failed.value > 0 && loaded.value === 0);
function tileLoaded() { loaded.value += 1; }
function tileFailed(event: Event) {
  failed.value += 1;
  (event.target as HTMLImageElement).style.visibility = "hidden";
}

let resizeObserver: ResizeObserver | null = null;
let visibilityObserver: IntersectionObserver | null = null;
onMounted(() => {
  const element = mapElement.value;
  if (!element) return;
  const measure = () => {
    width.value = element.clientWidth || width.value;
    height.value = element.clientHeight || height.value;
  };
  measure();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
  }
  if (typeof IntersectionObserver === "undefined") {
    tilesReady.value = true;
    return;
  }
  visibilityObserver = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    tilesReady.value = true;
    visibilityObserver?.disconnect();
    visibilityObserver = null;
  }, { rootMargin: "160px 0px" });
  visibilityObserver.observe(element);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  visibilityObserver?.disconnect();
});
</script>

<style scoped>
.location-map-preview{position:relative;width:100%;height:164px;overflow:hidden;border-radius:12px;background:#e9eef2;isolation:isolate}
.location-map-preview-tile{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none;pointer-events:none}
.location-map-preview-marker{position:absolute;z-index:2;display:grid;place-items:center;transform:translate(-50%,-50%)}
.location-map-preview-marker.peer{min-width:30px;min-height:30px;padding:2px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(15,23,42,.32)}
.location-map-preview-marker.peer:empty{width:16px;height:16px;min-width:0;min-height:0;border:3px solid #fff;background:#ef4444}
.location-map-preview-marker.me{width:16px;height:16px;box-sizing:border-box;border:3px solid #fff;border-radius:50%;background:#1687e8;box-shadow:0 0 0 7px rgba(22,135,232,.18)}
.location-map-preview-trail{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:visible}
.location-map-preview-trail polyline{fill:none;stroke-width:4;stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.location-map-preview-trail polyline.peer{stroke:#ef4444}
.location-map-preview-trail polyline.me{stroke:#1687e8}
.location-map-preview-loading{position:absolute;z-index:1;inset:0;display:grid;place-items:center;color:#64748b;font-size:12px}
.location-map-preview-attribution{position:absolute;right:4px;bottom:4px;z-index:3;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,.82);color:#475569;font-size:9px}
</style>
