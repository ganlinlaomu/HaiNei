<template>
  <div class="location-card" :class="{ ended: live && status === 'ended' }">
    <div class="location-card-head">
      <span class="location-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
      </span>
      <span class="location-card-title">
        <strong>{{ title }}</strong>
        <small :class="{ stale: status === 'stale' }">{{ detail }}</small>
      </span>
    </div>
    <template v-if="!live || status !== 'ended'">
      <button type="button" class="location-card-map" aria-label="打开全屏地图" @click.stop="mapOpen = true">
        <LocationMapPreview
          :location="shown"
          :my-location="myLocation"
          :trail="trail"
          :my-trail="myTrail"
          :peer-pubkey="peer"
          :label="`${peerName || '对方'}的位置`"
          :location-is-mine="own"
        />
        <span class="location-card-map-expand">查看大图</span>
      </button>
      <p class="location-card-coordinates">{{ coordinates }}</p>
      <div class="location-card-actions">
        <button v-if="ownActive" type="button" class="location-card-stop" @click.stop="stop">停止共享</button>
        <button v-else type="button" class="location-card-copy" @click.stop="copy">{{ copied ? "已复制" : "复制坐标" }}</button>
      </div>
    </template>
    <LocationMapSheet
      v-if="mapOpen"
      :peer-name="peerName || '对方'"
      :peer-pubkey="peer"
      :location="shown"
      :my-location="myLocation"
      :trail="trail"
      :my-trail="myTrail"
      :location-is-mine="own"
      :status="detail"
      @close="mapOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import LocationMapPreview from "@/components/LocationMapPreview.vue";
import LocationMapSheet from "@/components/LocationMapSheet.vue";
import { formatCoordinates, type LocationShare } from "@/nostr/messaging/locationShare";
import { useLiveLocationStore } from "@/stores/liveLocation";

/**
 * A location in a chat: a one-time position, or the opening card of a live
 * share that follows the latest in-memory update. A viewport-lazy preview
 * loads tiles through the HaiNei Worker; tapping it opens LocationMapSheet.
 */
const props = defineProps<{ location: LocationShare; own: boolean; peer: string; peerName: string }>();
const liveStore = useLiveLocationStore();
const mapOpen = ref(false);
const live = computed(() => props.location.live);
const displayName = computed(() => props.own ? "我" : props.peerName || "对方");
// A live card that has not ended yet needs the clock for its countdown and
// staleness, including before the first update has arrived.
let releaseClock: (() => void) | null = null;
onMounted(() => {
  if (!props.own && live.value) liveStore.receiveOpening(props.peer, props.location);
  if (live.value && live.value.expiresAt > Math.floor(Date.now() / 1000)) releaseClock = liveStore.holdClock();
});
onBeforeUnmount(() => releaseClock?.());
const remainingMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/** Our share is running only on the device that runs it, and only until it ends. */
const ownActive = computed(() => props.own && !!live.value
  && liveStore.outgoingFor(props.peer)?.id === live.value.id
  && live.value.expiresAt > Math.floor(liveStore.now / 1000));
const incoming = computed(() => !props.own && live.value ? liveStore.incomingStatus(live.value.id, props.peer, props.location) : null);
const status = computed<"once" | "live" | "stale" | "ended">(() => {
  if (!live.value) return "once";
  if (props.own) return ownActive.value ? "live" : "ended";
  return incoming.value?.state ?? "ended";
});
/**
 * What to show: a friend's newest received position; for our own running
 * share, the newest position we sent (what the friend sees); else the card's.
 */
const shown = computed(() => {
  if (incoming.value && incoming.value.state !== "ended") return incoming.value.location;
  if (ownActive.value) return liveStore.outgoingFor(props.peer)?.last ?? props.location;
  return props.location;
});

const title = computed(() => {
  if (!live.value) return props.own ? "我的位置" : "位置";
  if (status.value === "ended") return "位置共享已结束";
  return props.own ? "我的实时位置" : "实时位置";
});
const detail = computed(() => {
  const nowSeconds = Math.floor(liveStore.now / 1000);
  if (!live.value) {
    const time = new Date(props.location.at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return props.location.accuracy === undefined ? `${time} 获取` : `${time} 获取 · 精度约 ±${props.location.accuracy} 米`;
  }
  if (status.value === "ended") return "位置已不再更新";
  const remaining = `剩余 ${remainingMinutes(live.value.expiresAt - nowSeconds)} 分钟`;
  if (props.own) return `共享中 · ${remaining}`;
  const info = incoming.value;
  if (!info || info.state === "ended") return remaining;
  if (info.state === "stale") return `位置停在 ${Math.floor(info.ageSeconds / 60)} 分钟前 · 对方可能不在前台`;
  // Seconds under a minute, so each arriving update is visible.
  const age = info.ageSeconds < 5 ? "刚刚" : info.ageSeconds < 60 ? `${info.ageSeconds} 秒前` : `${Math.floor(info.ageSeconds / 60)} 分钟前`;
  return `更新于 ${age} · ${remaining}`;
});
const coordinates = computed(() => formatCoordinates(shown.value));
/**
 * The second point on the map. On a friend's card it is our active outgoing
 * share; on our own card it is the friend's newest active incoming share.
 */
const myLocation = computed(() => {
  if (props.own) return liveStore.incomingFor(props.peer)?.location;
  const share = liveStore.outgoingFor(props.peer);
  return share && share.expiresAt > Math.floor(liveStore.now / 1000) ? share.last : undefined;
});
/** Where the shown person has walked during this share. */
const trail = computed(() => {
  if (incoming.value && incoming.value.state !== "ended" && live.value) return liveStore.incoming[live.value.id]?.trail ?? [];
  if (ownActive.value) return liveStore.outgoingFor(props.peer)?.trail ?? [];
  return [];
});
/** The other person's walk, when both of us are sharing. */
const myTrail = computed(() => {
  if (!myLocation.value) return [];
  if (props.own) return liveStore.incomingFor(props.peer)?.trail ?? [];
  return liveStore.outgoingFor(props.peer)?.trail ?? [];
});

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(coordinates.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1_500);
  } catch {
    copied.value = false;
  }
}
function stop() {
  void liveStore.stopSharing(props.peer);
}
</script>

<style scoped>
.location-card{display:flex;flex-direction:column;gap:10px;width:min(320px,calc(100vw - 70px));min-width:215px;padding:14px;box-sizing:border-box}
.location-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.location-card-icon{display:grid;width:38px;height:38px;flex:0 0 38px;place-items:center;border-radius:50%;background:var(--bg-e0f2fe);color:#1687e8}
.location-card.ended .location-card-icon{background:var(--bg-f1f5f9);color:var(--fg-64748b)}
.location-card-icon svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.location-card-title{display:flex;min-width:0;flex-direction:column;gap:3px}
.location-card-title strong{font-size:15px}
.location-card-title small{color:var(--fg-657786);font-size:11px}
.location-card-title small.stale{color:#b45309}
.location-card-map{position:relative;display:block;width:100%;padding:0;border:0;border-radius:12px;background:transparent;overflow:hidden;text-align:initial;cursor:pointer}
.location-card-map-expand{position:absolute;right:8px;top:8px;z-index:4;padding:5px 8px;border-radius:12px;background:rgba(15,23,42,.72);color:#fff;font-size:11px;font-weight:650;line-height:1}
.location-card-coordinates{margin:0;color:var(--fg-536471);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.location-card-actions{display:grid;grid-template-columns:1fr;gap:8px}
.location-card-copy,.location-card-stop{display:grid;min-height:38px;place-items:center;padding:0 8px;border-radius:10px;font:inherit;font-size:13px;font-weight:650;text-decoration:none}
.location-card-copy{border:1px solid var(--bd-d8e0e8);background:var(--bg-fff);color:var(--fg-334155)}
.location-card-stop{border:0;background:var(--bg-fee2e2);color:var(--fg-b91c1c)}
</style>
