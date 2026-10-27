<template>
  <span :class="[variant === 'caption' ? 'caption-meta' : 'message-meta', { failed, read }]">
    <time>{{ time }}</time>
    <template v-if="own">
      <span>{{ status }}</span>
      <button v-if="retryable" type="button" :disabled="retrying"
        :aria-label="'重试发送这条私信'" @click="emit('retry')">{{ retrying ? "重试中…" : "重试" }}</button>
    </template>
  </span>
</template>

<script setup lang="ts">
/**
 * Time, delivery status and retry under a chat message: below the bubble
 * ("bubble"), or inside an image's caption area ("caption").
 */
defineProps<{
  variant: "bubble" | "caption";
  time: string;
  own: boolean;
  status: string;
  read: boolean;
  failed: boolean;
  retryable: boolean;
  retrying: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
</script>

<style scoped>
.message-meta{display:flex;align-items:center;gap:4px;margin:3px 5px 1px;color:var(--fg-8b98a5);font-size:9px;font-weight:400;line-height:1.3;opacity:.85;white-space:nowrap;font-variant-numeric:tabular-nums}
.message-meta.failed,.caption-meta.failed{color:var(--fg-dc2626)}
.message-meta.read,.caption-meta.read{color:var(--fg-1687e8)}
.message-meta button,.caption-meta button{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:650}
.caption-meta{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:2px;color:var(--fg-718096);font-size:9px;line-height:1.3;white-space:nowrap}
</style>
