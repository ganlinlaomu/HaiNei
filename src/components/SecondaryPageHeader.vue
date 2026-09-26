<template>
  <header class="secondary-page-header">
    <button type="button" :aria-label="backLabel" @click="router.push(backTo)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
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
  backLabel: "返回"
});

const router = useRouter();
</script>

<style scoped>
.secondary-page-header{position:sticky;top:0;z-index:10;display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;min-height:54px;background:rgba(248,250,252,.96);border-bottom:1px solid #e2e8f0;backdrop-filter:blur(10px)}
.secondary-page-header button{display:grid;width:44px;height:44px;padding:0;border:0;background:transparent;color:#334155;place-items:center;cursor:pointer}
.secondary-page-header button svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.secondary-page-header h1{min-width:0;margin:0;overflow:hidden;text-align:center;text-overflow:ellipsis;white-space:nowrap;font-size:17px}
</style>
