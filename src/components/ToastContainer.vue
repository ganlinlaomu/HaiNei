<template>
  <div class="toast-container" v-if="store.toasts.length">
    <div v-for="t in store.toasts" :key="t.id" :class="['toast', t.type]">
      {{ t.message }}
      <button class="close" @click="store.removeToast(t.id)">✕</button>
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
.toast-container {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  top: calc(env(safe-area-inset-top) + 12px);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 92%;
}
.toast {
  background: rgba(15,23,42,0.9);
  color: white;
  padding: 8px 12px;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(15,23,42,0.12);
  display: flex;
  align-items: center;
  justify-content: space-between;
  animation: toast-enter 180ms ease-out both;
}
.toast.success {
  background: #16a34a;
}
.toast.error {
  background: #dc2626;
}
.toast.bookmark {
  border: 1px solid rgba(96,165,250,.28);
  background: rgba(255,255,255,.94);
  color: #1f2937;
  box-shadow: 0 8px 24px rgba(15,23,42,.14);
  backdrop-filter: blur(12px);
}
.toast.bookmark::before { content:"✓";margin-right:8px;color:#60A5FA;font-weight:800 }
.toast.bookmark .close { color:#64748b }
.toast .close {
  background: transparent;
  color: rgba(255,255,255,0.9);
  border: none;
  margin-left: 12px;
  cursor: pointer;
}
@keyframes toast-enter { from { opacity:0;transform:translateY(-6px) } to { opacity:1;transform:translateY(0) } }
@media(prefers-reduced-motion:reduce){.toast{animation:none}}
</style>
