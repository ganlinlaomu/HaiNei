<template>
  <header class="secondary-page-header">
    <button type="button" :aria-label="backLabel" @click="router.push(backTo)">
      <span class="back-glyph" aria-hidden="true">‹</span>
    </button>
    <h1>{{ title }}</h1>
    <span aria-hidden="true"></span>
  </header>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";

withDefaults(defineProps<{
  title: string;
  backTo?: string;
  backLabel?: string;
}>(), {
  backTo: "/settings",
  backLabel: "返回我的"
});

const router = useRouter();
</script>

<style scoped>
.secondary-page-header{position:sticky;top:0;z-index:10;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:54px;background:rgba(248,250,252,.96);border-bottom:1px solid #e2e8f0}
.secondary-page-header button{width:44px;height:44px;padding:0;border:0;background:transparent;color:#334155;font-size:30px;line-height:1;cursor:pointer}
.secondary-page-header h1{min-width:0;margin:0;overflow:hidden;text-align:center;text-overflow:ellipsis;white-space:nowrap;font-size:17px}
</style>
