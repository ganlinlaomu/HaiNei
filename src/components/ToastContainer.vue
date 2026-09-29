<template>
  <div class="toast-container" v-if="store.toasts.length">
    <div v-for="t in store.toasts" :key="t.id" :class="['toast', t.type]">
      <span class="toast-message">{{ t.message }}</span>
      <button class="close" aria-label="关闭提示" @click="store.removeToast(t.id)">✕</button>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { useUIStore } from "@/stores/ui";

export default defineComponent({
  setup() {
    const store = useUIStore();
    return { store };
  }
});
</script>

<style scoped>
.toast-container{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 10px);z-index:9999;display:flex;max-width:min(92vw,440px);transform:translateX(-50%);flex-direction:column;gap:6px}
.toast{display:flex;min-height:34px;align-items:center;justify-content:space-between;gap:7px;padding:6px 8px 6px 10px;border:1px solid #dbe3ea;border-radius:10px;background:rgba(255,255,255,.96);color:#334155;box-shadow:0 5px 18px rgba(15,23,42,.1);backdrop-filter:blur(12px);font-size:13px;font-weight:500;line-height:1.35;animation:toast-enter 160ms ease-out both}
.toast::before{display:grid;width:15px;height:15px;flex:0 0 15px;place-items:center;border-radius:50%;font-size:11px;font-weight:800}
.toast.success::before{content:"✓";color:#15803d;background:#f0fdf4}
.toast.error{border-color:rgba(220,38,38,.2)}.toast.error::before{content:"!";color:#dc2626;background:#fef2f2}
.toast.bookmark::before{content:"✓";color:#3b82f6;background:#eff6ff}
.toast-message{min-width:0;overflow-wrap:anywhere}
.toast .close{display:grid;width:28px;height:28px;flex:0 0 28px;padding:0;border:0;border-radius:7px;background:transparent;color:#94a3b8;place-items:center;cursor:pointer;font-size:12px}.toast .close:active{background:#f1f5f9}
@keyframes toast-enter{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.toast{animation:none}}
</style>
