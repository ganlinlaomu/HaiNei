<template>
  <div v-for="share in shares" :key="share.id" class="live-location-banner" role="status">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
    <span class="live-location-copy">
      <strong>正在与{{ nameOf(share.peer) }}共享位置</strong>
      <small>剩余 {{ remainingMinutes(share.expiresAt) }} 分钟 · 保持海内打开才会持续更新</small>
    </span>
    <button type="button" :aria-label="`停止与${nameOf(share.peer)}共享位置`" @click="liveLocation.stopSharing(share.peer)">停止</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useLiveLocationStore } from "@/stores/liveLocation";

/** One banner per live share this device is running, each with a stop button. */
defineProps<{ nameOf: (pubkey: string) => string }>();
const liveLocation = useLiveLocationStore();
const shares = computed(() => liveLocation.activeOutgoing);
const remainingMinutes = (expiresAt: number) => Math.max(1, Math.ceil((expiresAt - liveLocation.now / 1000) / 60));
</script>

<style scoped>
.live-location-banner{display:flex;align-items:center;gap:10px;margin:4px 12px 8px;padding:10px 10px 10px 14px;border-radius:14px;background:var(--bg-e0f2fe)}
.live-location-banner>svg{width:20px;height:20px;flex:0 0 20px;fill:none;stroke:#1687e8;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.live-location-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
.live-location-copy strong{overflow:hidden;color:var(--fg-0f1419);font-size:14px;text-overflow:ellipsis;white-space:nowrap}
.live-location-copy small{color:var(--fg-475569);font-size:12px}
.live-location-banner button{min-height:36px;padding:0 12px;border:0;border-radius:18px;background:var(--bg-fff);color:var(--fg-b91c1c);font:inherit;font-size:13px;font-weight:650}
</style>
