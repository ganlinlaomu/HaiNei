<template>
  <div v-if="items.length" class="mention-menu" :class="{ above: placement === 'above' }" role="listbox" aria-label="选择要提及的用户">
    <button
      v-for="(item, index) in items"
      :key="item.pubkey"
      class="mention-option"
      :class="{ active: index === activeIndex }"
      type="button"
      role="option"
      :aria-selected="index === activeIndex"
      @pointerdown.prevent
      @click="$emit('select', item)"
    >
      <ProfileAvatar :pubkey="item.pubkey" :local-name="item.label" :size="32" />
      <span class="mention-copy">
        <strong>@{{ item.label }}</strong>
        <small v-if="item.secondary">{{ item.secondary }}</small>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import type { MentionCandidate } from "@/utils/mentions";

withDefaults(defineProps<{
  items: readonly MentionCandidate[];
  activeIndex: number;
  placement?: "above" | "below";
}>(), { placement: "below" });

defineEmits<{ select: [item: MentionCandidate] }>();
</script>

<style scoped>
.mention-menu{position:absolute;z-index:40;left:0;right:0;top:calc(100% + 6px);max-height:286px;overflow-y:auto;padding:6px;border:1px solid #dfe5eb;border-radius:14px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.16)}
.mention-menu.above{top:auto;bottom:calc(100% + 6px)}
.mention-option{display:grid;width:100%;min-height:48px;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;padding:7px 9px;border:0;border-radius:10px;background:transparent;color:#0f1419;text-align:left}
.mention-option.active,.mention-option:active{background:#eff6ff}
.mention-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.mention-copy strong,.mention-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mention-copy strong{font-size:14px}.mention-copy small{color:#64748b;font-size:11px}
</style>
