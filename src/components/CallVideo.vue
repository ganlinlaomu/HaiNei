<template>
  <!-- Always muted: call audio plays only through the engine's audio element. -->
  <video ref="element" class="call-video" :class="{ mirrored }" autoplay playsinline muted aria-hidden="true"></video>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { startupMark } from "@/utils/debugLog";

const props = defineProps<{
  stream: MediaStream | null;
  mirrored?: boolean;
  /** "remote" logs whether the peer's video actually renders, and retries once. */
  role?: "local" | "remote";
}>();
const element = ref<HTMLVideoElement | null>(null);
const RENDER_CHECK_MS = 3_000;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let rebinds = 0;

function track() {
  return props.stream?.getVideoTracks?.()[0];
}

function play(video: HTMLVideoElement) {
  void video.play().catch(error => {
    if (props.role === "remote") startupMark("call_video_play_failed", { name: error instanceof Error ? error.name : "unknown" });
  });
}

function scheduleRenderCheck() {
  if (props.role !== "remote") return;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const video = element.value;
    if (!video || !props.stream) return;
    const rendering = video.videoWidth > 0 && !video.paused;
    const remote = track();
    startupMark("call_video_render", {
      rendering, width: video.videoWidth, height: video.videoHeight, paused: video.paused,
      readyState: video.readyState, trackMuted: remote?.muted ?? null, trackState: remote?.readyState ?? "none",
      rebinds,
    });
    // WebKit sometimes keeps a black frame until the element is rebound.
    if (!rendering && rebinds < 2) {
      rebinds += 1;
      video.srcObject = null;
      video.srcObject = props.stream;
      play(video);
      scheduleRenderCheck();
    }
  }, RENDER_CHECK_MS);
}

function bind() {
  const video = element.value;
  if (!video) return;
  if (video.srcObject !== props.stream) {
    video.srcObject = props.stream;
    rebinds = 0;
  }
  if (props.stream) {
    play(video);
    scheduleRenderCheck();
  }
}

function onPlaying() {
  const video = element.value;
  if (props.role === "remote" && video) startupMark("call_video_playing", { width: video.videoWidth, height: video.videoHeight });
}

onMounted(() => {
  element.value?.addEventListener("playing", onPlaying);
  bind();
});
watch(() => props.stream, bind);
onBeforeUnmount(() => {
  if (renderTimer) clearTimeout(renderTimer);
  element.value?.removeEventListener("playing", onPlaying);
  if (element.value) element.value.srcObject = null;
});
</script>

<style scoped>
.call-video{display:block;width:100%;height:100%;object-fit:cover;background:#000}
.call-video.mirrored{transform:scaleX(-1)}
</style>
