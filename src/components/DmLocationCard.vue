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
      <p class="location-card-coordinates">{{ coordinates }}</p>
      <div class="location-card-actions">
        <a class="location-card-open" :href="url" target="_blank" rel="noopener noreferrer" @click.stop>在地图中打开</a>
        <button v-if="ownActive" type="button" class="location-card-stop" @click.stop="stop">停止共享</button>
        <button v-else type="button" class="location-card-copy" @click.stop="copy">{{ copied ? "已复制" : "复制坐标" }}</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { formatCoordinates, mapsUrl, type LocationShare } from "@/nostr/messaging/locationShare";
import { useLiveLocationStore } from "@/stores/liveLocation";

/**
 * A location in a chat: a one-time position, or the opening card of a live
 * share that follows the latest in-memory update. It shows coordinates only
 * and loads no map tiles: a tile server would learn the location. "在地图中
 * 打开" hands it to the system maps app on an explicit tap.
 */
const props = defineProps<{ location: LocationShare; own: boolean; peer: string }>();
const liveStore = useLiveLocationStore();
const live = computed(() => props.location.live);
const remainingMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/** Our share is running only on the device that runs it, and only until it ends. */
const ownActive = computed(() => props.own && !!live.value
  && liveStore.outgoingFor(props.peer)?.id === live.value.id
  && live.value.expiresAt > Math.floor(liveStore.now / 1000));
const incoming = computed(() => !props.own && live.value ? liveStore.incomingStatus(live.value.id, props.peer) : null);
const status = computed<"once" | "live" | "stale" | "ended">(() => {
  if (!live.value) return "once";
  if (props.own) return ownActive.value ? "live" : "ended";
  return incoming.value?.state ?? "ended";
});
/** Latest received position for a live share, else the card's own. */
const shown = computed(() => incoming.value && incoming.value.state !== "ended" ? incoming.value.location : props.location);

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
  return `更新于 ${info.ageSeconds < 60 ? "刚刚" : `${Math.floor(info.ageSeconds / 60)} 分钟前`} · ${remaining}`;
});
const coordinates = computed(() => formatCoordinates(shown.value));
const url = computed(() => mapsUrl(shown.value));

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
.location-card{display:flex;flex-direction:column;gap:10px;min-width:215px;padding:14px;box-sizing:border-box}
.location-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.location-card-icon{display:grid;width:38px;height:38px;flex:0 0 38px;place-items:center;border-radius:50%;background:var(--bg-e0f2fe);color:#1687e8}
.location-card.ended .location-card-icon{background:var(--bg-f1f5f9);color:var(--fg-64748b)}
.location-card-icon svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.location-card-title{display:flex;min-width:0;flex-direction:column;gap:3px}
.location-card-title strong{font-size:15px}
.location-card-title small{color:var(--fg-657786);font-size:11px}
.location-card-title small.stale{color:#b45309}
.location-card-coordinates{margin:0;color:var(--fg-536471);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.location-card-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.location-card-open,.location-card-copy,.location-card-stop{display:grid;min-height:38px;place-items:center;padding:0 8px;border-radius:10px;font:inherit;font-size:13px;font-weight:650;text-decoration:none}
.location-card-open{border:0;background:#1687e8;color:#fff}
.location-card-copy{border:1px solid var(--bd-d8e0e8);background:var(--bg-fff);color:var(--fg-334155)}
.location-card-stop{border:0;background:var(--bg-fee2e2);color:var(--fg-b91c1c)}
</style>
