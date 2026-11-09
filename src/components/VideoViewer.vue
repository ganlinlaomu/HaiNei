<template>
  <Teleport to="body">
    <div
      ref="dialog"
      class="video-viewer"
      role="dialog"
      aria-modal="true"
      :aria-label="`${site} 视频`"
      tabindex="-1"
      @click.self="emit('close')"
    >
      <div class="video-viewer-bar">
        <a class="video-viewer-open" :href="url" target="_blank" rel="noopener noreferrer nofollow">在 {{ site }} 打开</a>
        <button type="button" class="video-viewer-close" aria-label="关闭视频" @click="emit('close')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="video-viewer-frame">
        <!-- The app sends no referrer by default; YouTube refuses to play
             without one, so this tapped-open player sends only our origin. -->
        <iframe
          :src="embedUrl"
          :title="`${site} 播放器`"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useDialogFocus } from "@/composables/useDialogFocus";

/**
 * A chat video played full width over the page. Chat bubbles are too narrow
 * for a player, and their swipe transform would clip a fixed overlay, so the
 * viewer is teleported to <body>.
 */
defineProps<{ embedUrl: string; url: string; site: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
useDialogFocus(dialog, () => true, () => emit("close"));
</script>

<style scoped>
.video-viewer{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000;outline:none}
.video-viewer-bar{position:absolute;top:0;right:0;left:0;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:calc(10px + env(safe-area-inset-top)) 12px 10px calc(14px + env(safe-area-inset-left))}
.video-viewer-open{color:rgba(255,255,255,.78);font-size:13px;text-decoration:none}
.video-viewer-close{display:grid;width:40px;height:40px;place-items:center;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;cursor:pointer}
.video-viewer-close svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
/* As wide as the screen in portrait, as tall as it in landscape. */
.video-viewer-frame{position:relative;z-index:0;width:min(100vw,calc((100vh - 120px) * 16 / 9));aspect-ratio:16/9;background:#000}
.video-viewer-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
/* Phone on its side: keep a gutter on each side for the close button rather
   than covering the player; the player's own logo links to YouTube. */
@media (orientation:landscape) and (max-height:500px){
  .video-viewer-frame{width:min(calc(100vw - 112px),calc(100vh * 16 / 9))}
  .video-viewer-bar{padding:calc(8px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 0 0;justify-content:flex-end;left:auto}
  .video-viewer-open{display:none}
}
</style>
