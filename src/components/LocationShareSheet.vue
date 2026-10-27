<template>
  <div class="location-sheet-overlay" @click.self="emit('close')">
    <section class="location-sheet" role="dialog" aria-modal="true" aria-label="发送位置">
      <header class="location-sheet-header">
        <h2>发送位置</h2>
        <button type="button" aria-label="关闭发送位置" @click="emit('close')">×</button>
      </header>
      <p v-if="state === 'locating'" class="location-sheet-status" role="status">正在获取位置…</p>
      <template v-else-if="state === 'error'">
        <p class="location-sheet-status location-sheet-error" role="alert">{{ error }}</p>
        <div class="location-sheet-actions">
          <button type="button" @click="emit('close')">取消</button>
          <button type="button" class="location-sheet-send" @click="locate">重试</button>
        </div>
      </template>
      <template v-else-if="location">
        <div class="location-sheet-preview">
          <strong>当前位置</strong>
          <span>{{ formatCoordinates(location) }}</span>
          <small v-if="location.accuracy !== undefined">精度约 ±{{ location.accuracy }} 米</small>
        </div>
        <p class="location-sheet-note">位置会端到端加密发送给 {{ peerName }}，只发送这一次，不会持续更新。</p>
        <div class="location-sheet-actions">
          <button type="button" @click="emit('close')">取消</button>
          <button type="button" class="location-sheet-send" @click="emit('send', location)">发送</button>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { formatCoordinates, serializeLocationShare, parseLocationShare, type LocationShare } from "@/nostr/messaging/locationShare";
import { getCurrentLocation, LocationUnavailableError } from "@/utils/currentLocation";

/** Reads the location once when opened, shows it, and sends only on confirm. */
defineProps<{ peerName: string }>();
const emit = defineEmits<{ close: []; send: [location: LocationShare] }>();
const state = ref<"locating" | "error" | "ready">("locating");
const location = ref<LocationShare | null>(null);
const error = ref("");
let attempt = 0;

async function locate() {
  const current = ++attempt;
  state.value = "locating";
  error.value = "";
  try {
    const raw = await getCurrentLocation();
    if (current !== attempt) return;
    // Normalize (rounding, bounds) exactly as it will be sent.
    location.value = parseLocationShare(serializeLocationShare(raw));
    state.value = location.value ? "ready" : "error";
    if (!location.value) error.value = "暂时无法获取位置，请稍后重试";
  } catch (cause) {
    if (current !== attempt) return;
    error.value = cause instanceof LocationUnavailableError ? cause.message : "暂时无法获取位置，请稍后重试";
    state.value = "error";
  }
}
onMounted(locate);
</script>

<style scoped>
.location-sheet-overlay{position:fixed;z-index:30;inset:0;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.36)}
.location-sheet{width:100%;max-width:640px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;padding:18px 18px calc(18px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:var(--bg-fff);box-shadow:0 -14px 45px rgba(15,23,42,.12)}
.location-sheet-header{display:flex;justify-content:space-between;align-items:center}
.location-sheet-header h2{font-size:18px;margin:0}
.location-sheet-header button{width:34px;height:34px;border:0;background:var(--bg-f1f5f9);border-radius:50%;font-size:24px;color:var(--fg-475569)}
.location-sheet-status{margin:6px 0;color:var(--fg-64748b);font-size:14px;text-align:center}
.location-sheet-error{color:var(--fg-b91c1c)}
.location-sheet-preview{display:flex;flex-direction:column;gap:4px;padding:14px;border:1px solid var(--bd-e2e8f0);border-radius:15px}
.location-sheet-preview strong{font-size:15px}
.location-sheet-preview span{color:var(--fg-536471);font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.location-sheet-preview small{color:var(--fg-64748b);font-size:12px}
.location-sheet-note{margin:0;color:var(--fg-64748b);font-size:12px;line-height:1.6}
.location-sheet-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.location-sheet-actions button{min-height:44px;border:1px solid var(--bd-cbd5e1);border-radius:12px;background:var(--bg-fff);color:var(--fg-334155);font:inherit;font-weight:650}
.location-sheet-actions .location-sheet-send{border-color:#1687e8;background:#1687e8;color:#fff}
</style>
