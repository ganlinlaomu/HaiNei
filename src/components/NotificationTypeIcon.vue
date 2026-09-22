<template>
  <span class="notification-type-icon" :class="kind" aria-hidden="true">
    <svg v-if="kind === 'like'" viewBox="0 0 24 24">
      <path d="M12 21s-7.2-4.5-9.5-8.4C.4 9.1 2.1 5 6.2 5c2.3 0 3.7 1.3 4.5 2.4C11.5 6.3 12.9 5 15.2 5c4.1 0 5.8 4.1 3.7 7.6C16.6 16.5 12 21 12 21Z" />
    </svg>
    <svg v-else-if="kind === 'friend'" viewBox="0 0 24 24">
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19c.5-3.3 2.4-5 5.5-5s5 1.7 5.5 5M18 7v6M15 10h6" />
    </svg>
    <svg v-else-if="kind === 'reply'" viewBox="0 0 24 24">
      <path d="m9 7-5 5 5 5M5 12h7c4.4 0 7 2.1 7 6" />
    </svg>
    <svg v-else viewBox="0 0 24 24">
      <path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
    </svg>
  </span>
</template>

<script setup lang="ts">
defineProps<{ kind: "like" | "comment" | "reply" | "friend" }>();
</script>

<style scoped>
.notification-type-icon { width:36px;height:36px;flex:0 0 36px;display:grid;place-items:center;border-radius:50%; }
svg { width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round; }
.like { color:#ef476f;background:#fff0f4; }.like svg { fill:currentColor;stroke:none; }
.comment { color:#3b82f6;background:#eff6ff; }
.reply { color:#8b5cf6;background:#f5f3ff; }
.friend { color:#10b981;background:#ecfdf5; }
</style>
