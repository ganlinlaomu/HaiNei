<template>
  <span role="timer" aria-live="off">♨ {{ remaining }} 秒后销毁</span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

// Owns the per-second tick so only this label re-renders, not the whole chat.
const props = defineProps<{ deadline: number }>();

const now = ref(Date.now());
let timer: number | null = null;
const remaining = computed(() => Math.max(0, Math.ceil((props.deadline - now.value) / 1000)));

function stop() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

function start() {
  stop();
  now.value = Date.now();
  if (remaining.value <= 0) return;
  timer = window.setInterval(() => {
    now.value = Date.now();
    if (remaining.value <= 0) stop();
  }, 1000);
}

watch(() => props.deadline, start);
onMounted(start);
onBeforeUnmount(stop);
</script>
