<template>
  <Teleport to="body">
    <div class="location-map-sheet" role="dialog" aria-modal="true" :aria-label="title">
      <div ref="mapElement" class="location-map" :class="{ unavailable: mapUnavailable }"
        @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerEnd"
        @pointercancel="onPointerEnd" @wheel.prevent="onWheel">
        <div class="location-map-layer" :style="layerStyle">
        <img
          v-for="tile in tiles"
          :key="tile.key"
          class="location-map-tile"
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
        <svg v-if="trailLines.length" class="location-map-trail" :width="width" :height="height" aria-hidden="true">
          <polyline v-for="line in trailLines" :key="line.key" :class="line.kind" :points="line.points" />
        </svg>
        </div>
        <span
          v-for="marker in markers"
          :key="marker.key"
          class="location-map-marker"
          :class="marker.kind"
          :style="{ left: `${marker.left}px`, top: `${marker.top}px` }"
          :aria-label="marker.label"
          role="img"
        >
          <ProfileAvatar v-if="marker.kind === 'peer' && marker.pubkey" :pubkey="marker.pubkey" :size="34" />
        </span>
        <p v-if="mapUnavailable" class="location-map-fallback">地图暂时无法加载，可在下方用系统地图打开。</p>
        <span class="location-map-attribution">© OpenStreetMap</span>
      </div>

      <header class="location-map-header">
        <button type="button" class="location-map-round" aria-label="关闭地图" @click="emit('close')">‹</button>
        <strong>{{ title }}</strong>
      </header>
      <div class="location-map-zoom">
        <button type="button" class="location-map-round" aria-label="放大" :disabled="zoom >= MAX_MAP_ZOOM" @click="setZoom(zoom + 1)">+</button>
        <button type="button" class="location-map-round" aria-label="缩小" :disabled="zoom <= MIN_MAP_ZOOM" @click="setZoom(zoom - 1)">−</button>
        <button type="button" class="location-map-round" aria-label="显示全部位置" @click="resetView">⌖</button>
      </div>

      <section class="location-map-panel" aria-label="位置详情">
        <strong>{{ peerName }}</strong>
        <span class="location-map-status">{{ status }}</span>
        <span class="location-map-coordinates">{{ formatCoordinates(focus) }}</span>
        <a class="location-map-open" :href="mapsUrl(focus)" target="_blank" rel="noopener noreferrer">在「地图」中打开</a>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { formatCoordinates, mapsUrl, type LocationShare } from "@/nostr/messaging/locationShare";
import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import {
  applyGesture, centerOf, fitZoom, LIVE_MAP_ZOOM, MAX_MAP_ZOOM, MIN_MAP_ZOOM, project,
  tilesFor, tileUrl, toScreen, trailPath, trailPoints, type MapPoint,
} from "@/utils/mapTiles";
import { useMapGestures } from "@/composables/useMapGestures";

/**
 * Full-screen map of a shared location, drawn from OpenStreetMap tiles via
 * the HaiNei Worker (OSM sees the Worker, not this device). Follows the
 * props, so a live share moves its marker as updates arrive.
 */
const props = defineProps<{
  peerName: string;
  peerPubkey?: string;
  /** The friend's (or, for our own card, our) shared position. */
  location: LocationShare;
  /** Our position when we are also sharing with this friend. */
  myLocation?: LocationShare;
  /** A live share's walk so far (location's, then myLocation's), oldest first. */
  trail?: LocationShare[];
  myTrail?: LocationShare[];
  /** The primary card belongs to us; the optional second point is the peer. */
  locationIsMine?: boolean;
  status: string;
}>();
const emit = defineEmits<{ close: [] }>();
const workerBase = haineiWorkerBaseUrl();
const title = computed(() => props.locationIsMine ? "我的位置" : `${props.peerName}的位置`);
const focus = computed(() => props.location);

const mapElement = ref<HTMLElement | null>(null);
const width = ref(typeof window === "undefined" ? 390 : window.innerWidth);
const height = ref(typeof window === "undefined" ? 600 : window.innerHeight);
const manualZoom = ref<number | null>(null);
/** Set once the user drags or pinches; until ⌖, the map stops framing everyone. */
const manualFocus = ref<MapPoint | null>(null);
// The whole walk stays in view, so the marker moves instead of the map.
const points = computed(() => [props.location, ...(props.myLocation ? [props.myLocation] : []),
  ...(props.trail ?? []), ...(props.myTrail ?? [])]);
const isLive = computed(() => !!props.trail?.length || !!props.myTrail?.length);
// Leave room for the header above and the details panel below.
const zoom = computed(() => manualZoom.value
  ?? fitZoom(points.value, width.value, Math.max(200, height.value - 260), 56, isLive.value ? LIVE_MAP_ZOOM : 16));
const center = computed(() => manualFocus.value ? project(manualFocus.value, zoom.value) : centerOf(points.value, zoom.value));
const { gesture, onPointerDown, onPointerMove, onPointerEnd, onWheel } = useMapGestures({
  element: mapElement,
  view: () => ({ center: center.value, zoom: zoom.value, width: width.value, height: height.value }),
  settle: (nextZoom, focus) => { manualFocus.value = focus; manualZoom.value = nextZoom; },
});
const tiles = computed(() => tilesFor(center.value, zoom.value, width.value, height.value));
const markers = computed(() => {
  // Markers follow the gesture without scaling (the tiles and trail scale in a layer).
  const place = (location: LocationShare) => applyGesture(toScreen(location, center.value, zoom.value, width.value, height.value), gesture.value);
  if (props.locationIsMine) return [
    { key: "me", kind: "me" as const, label: "我的位置", pubkey: undefined, ...place(props.location) },
    ...(props.myLocation ? [{ key: "peer", kind: "peer" as const, label: `${props.peerName}的位置`, pubkey: props.peerPubkey, ...place(props.myLocation) }] : []),
  ];
  return [
    ...(props.myLocation ? [{ key: "me", kind: "me" as const, label: "我的位置", pubkey: undefined, ...place(props.myLocation) }] : []),
    { key: "peer", kind: "peer" as const, label: title.value, pubkey: props.peerPubkey, ...place(props.location) },
  ];
});

/** The primary person's line is red (as their marker), ours blue. */
const trailLines = computed(() => {
  const line = (key: string, kind: "me" | "peer", trail: LocationShare[] | undefined, current?: LocationShare) => {
    const path = trailPath(trail, current);
    return trail?.length && path.length > 1
      ? [{ key, kind, points: trailPoints(path, center.value, zoom.value, width.value, height.value) }] : [];
  };
  return [
    ...line("primary", props.locationIsMine ? "me" : "peer", props.trail, props.location),
    ...line("other", props.locationIsMine ? "peer" : "me", props.myTrail, props.myLocation),
  ];
});

function setZoom(value: number) {
  manualZoom.value = Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, value));
}
function resetView() {
  manualZoom.value = null;
  manualFocus.value = null;
}

const layerStyle = computed(() => {
  const g = gesture.value;
  if (!g) return undefined;
  return { transform: `translate(${g.dx + g.originX}px, ${g.dy + g.originY}px) scale(${g.scale}) translate(${-g.originX}px, ${-g.originY}px)` };
});

// Tile failures (offline, Worker without the tile route yet) leave the
// coordinates and the system-maps link usable.
const loaded = ref(0);
const failed = ref(0);
const mapUnavailable = computed(() => failed.value > 0 && loaded.value === 0);
function tileLoaded() { loaded.value += 1; }
function tileFailed(event: Event) {
  failed.value += 1;
  (event.target as HTMLImageElement).style.visibility = "hidden";
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  const element = mapElement.value;
  if (!element) return;
  const measure = () => { width.value = element.clientWidth || width.value; height.value = element.clientHeight || height.value; };
  measure();
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.location-map-sheet{position:fixed;inset:0;z-index:40;background:var(--bg-e2e8f0)}
.location-map{position:absolute;inset:0;overflow:hidden;background:#e9eef2;touch-action:none}
.location-map-layer{position:absolute;inset:0;transform-origin:0 0;will-change:transform}
.location-map-tile{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none;pointer-events:none}
.location-map-trail{position:absolute;inset:0;pointer-events:none;overflow:visible}
.location-map-trail polyline{fill:none;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.location-map-trail polyline.peer{stroke:#ef4444}
.location-map-trail polyline.me{stroke:#1687e8}
.location-map-marker{position:absolute;display:grid;place-items:center;transform:translate(-50%,-50%);pointer-events:none}
.location-map-marker.peer{padding:3px;border-radius:50%;background:#fff;box-shadow:0 3px 10px rgba(15,23,42,.3)}
.location-map-marker.me{width:20px;height:20px;box-sizing:border-box;border:4px solid #fff;border-radius:50%;background:#1687e8;box-shadow:0 0 0 10px rgba(22,135,232,.18),0 2px 6px rgba(15,23,42,.3)}
.location-map-fallback{position:absolute;top:42%;left:24px;right:24px;margin:0;padding:12px;border-radius:12px;background:rgba(255,255,255,.92);color:#475569;font-size:14px;text-align:center}
.location-map-attribution{position:absolute;right:6px;bottom:calc(196px + env(safe-area-inset-bottom));padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.8);color:#334155;font-size:10px}
.location-map-header{position:absolute;top:calc(12px + env(safe-area-inset-top));left:12px;right:12px;display:flex;align-items:center;gap:8px;padding:4px 14px 4px 4px;border-radius:26px;background:rgba(255,255,255,.95);color:#0f1419;box-shadow:0 2px 10px rgba(15,23,42,.14)}
.location-map-header strong{overflow:hidden;font-size:16px;text-overflow:ellipsis;white-space:nowrap}
.location-map-round{display:grid;width:44px;height:44px;flex:0 0 44px;place-items:center;padding:0;border:0;border-radius:50%;background:#fff;color:#334155;font-size:24px;line-height:1;box-shadow:0 2px 8px rgba(15,23,42,.14)}
.location-map-header .location-map-round{box-shadow:none;font-size:30px}
.location-map-round:disabled{opacity:.45}
.location-map-zoom{position:absolute;right:12px;top:calc(76px + env(safe-area-inset-top));display:flex;flex-direction:column;gap:8px}
.location-map-panel{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:6px;padding:16px 16px calc(18px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:var(--bg-fff);color:var(--fg-0f1419);box-shadow:0 -4px 20px rgba(15,23,42,.1)}
.location-map-panel strong{font-size:17px}
.location-map-status{color:var(--fg-64748b);font-size:13px}
.location-map-coordinates{color:var(--fg-536471);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.location-map-open{display:grid;min-height:46px;margin-top:6px;place-items:center;border-radius:23px;background:#1687e8;color:#fff;font-size:15px;font-weight:650;text-decoration:none}
</style>
