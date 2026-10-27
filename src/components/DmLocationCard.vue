<template>
  <div class="location-card">
    <div class="location-card-head">
      <span class="location-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
      </span>
      <span class="location-card-title">
        <strong>{{ own ? "我的位置" : "位置" }}</strong>
        <small>{{ detail }}</small>
      </span>
    </div>
    <p class="location-card-coordinates">{{ coordinates }}</p>
    <div class="location-card-actions">
      <a class="location-card-open" :href="url" target="_blank" rel="noopener noreferrer" @click.stop>在地图中打开</a>
      <button type="button" class="location-card-copy" @click.stop="copy">{{ copied ? "已复制" : "复制坐标" }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { formatCoordinates, mapsUrl, type LocationShare } from "@/nostr/messaging/locationShare";

/**
 * A one-time location in a chat. It shows coordinates only and loads no map
 * tiles: a tile server would learn the location. "在地图中打开" hands it to
 * the system maps app on an explicit tap.
 */
const props = defineProps<{ location: LocationShare; own: boolean }>();
const coordinates = computed(() => formatCoordinates(props.location));
const url = computed(() => mapsUrl(props.location));
const detail = computed(() => {
  const time = new Date(props.location.at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return props.location.accuracy === undefined ? `${time} 获取` : `${time} 获取 · 精度约 ±${props.location.accuracy} 米`;
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
</script>

<style scoped>
.location-card{display:flex;flex-direction:column;gap:10px;min-width:215px;padding:14px;box-sizing:border-box}
.location-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.location-card-icon{display:grid;width:38px;height:38px;flex:0 0 38px;place-items:center;border-radius:50%;background:var(--bg-e0f2fe);color:#1687e8}
.location-card-icon svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.location-card-title{display:flex;min-width:0;flex-direction:column;gap:3px}
.location-card-title strong{font-size:15px}
.location-card-title small{color:var(--fg-657786);font-size:11px}
.location-card-coordinates{margin:0;color:var(--fg-536471);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.location-card-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.location-card-open,.location-card-copy{display:grid;min-height:38px;place-items:center;padding:0 8px;border-radius:10px;font:inherit;font-size:13px;font-weight:650;text-decoration:none}
.location-card-open{border:0;background:#1687e8;color:#fff}
.location-card-copy{border:1px solid var(--bd-d8e0e8);background:var(--bg-fff);color:var(--fg-334155)}
</style>
