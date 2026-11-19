<template>
  <!-- Always muted: call audio plays only through the engine's audio element. -->
  <video ref="element" class="call-video" :class="{ mirrored }" autoplay playsinline muted aria-hidden="true"></video>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ stream: MediaStream | null; mirrored?: boolean }>();
const element = ref<HTMLVideoElement | null>(null);

function bind() {
  const video = element.value;
  if (!video) return;
  if (video.srcObject !== props.stream) video.srcObject = props.stream;
  if (props.stream) void video.play().catch(() => undefined);
}

onMounted(bind);
watch(() => props.stream, bind);
onBeforeUnmount(() => {
  if (element.value) element.value.srcObject = null;
});
</script>

<style scoped>
.call-video{display:block;width:100%;height:100%;object-fit:cover;background:#000}
.call-video.mirrored{transform:scaleX(-1)}
</style>
