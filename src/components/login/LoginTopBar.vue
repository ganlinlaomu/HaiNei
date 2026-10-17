<template>
  <div class="hn-topbar">
    <button class="hn-icon-button" type="button" aria-label="返回" :disabled="disabled" @click="emit('back')">
      <svg class="hn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <div v-if="progress" class="hn-progress" role="progressbar" :aria-valuenow="progress" aria-valuemin="1" aria-valuemax="2" :aria-label="`第 ${progress} 步，共 2 步`">
      <span class="done"></span>
      <span :class="{ done: progress >= 2 }"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ progress?: 1 | 2; disabled?: boolean }>();
const emit = defineEmits<{ back: [] }>();
</script>
