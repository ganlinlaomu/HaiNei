<template>
  <div v-if="open" class="scanner-overlay" role="presentation" @click.self="close">
    <section class="scanner-sheet" role="dialog" aria-modal="true" aria-label="扫描好友二维码">
      <div class="scanner-header">
        <strong>扫描好友二维码</strong>
        <button type="button" aria-label="关闭" @click="close">×</button>
      </div>
      <div class="camera-frame">
        <video ref="videoEl" muted playsinline></video>
        <div class="scan-frame" aria-hidden="true"></div>
      </div>
      <p v-if="cameraError" class="error">{{ cameraError }}</p>
      <p v-else class="hint">将对方的二维码放入框内</p>
      <div class="scanner-actions">
        <button type="button" @click="fileInput?.click()">从相册选择二维码</button>
        <button type="button" @click="close">取消</button>
      </div>
      <input ref="fileInput" class="hidden-input" type="file" accept="image/*" @change="scanImage" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useUIStore } from "@/stores/ui";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (event: "close"): void;
  (event: "scanned", value: string): void;
}>();

const ui = useUIStore();
const videoEl = ref<HTMLVideoElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const cameraError = ref("");
let controls: any = null;
let reader: any = null;
let handled = false;
let generation = 0;

watch(() => props.open, async visible => {
  ui.setBlockingOverlay("friend-qr-scanner", visible);
  if (visible) {
    await nextTick();
    void startScanner();
  } else {
    stopScanner();
  }
}, { immediate: true });

function stopScanner() {
  generation += 1;
  try { controls?.stop?.(); } catch {}
  controls = null;
  const stream = videoEl.value?.srcObject as MediaStream | null;
  stream?.getTracks().forEach(track => track.stop());
  if (videoEl.value) videoEl.value.srcObject = null;
}

async function startScanner() {
  stopScanner();
  const run = ++generation;
  handled = false;
  cameraError.value = "";
  try {
    const mod = await import("@zxing/browser");
    if (!props.open || run !== generation || !videoEl.value) return;
    reader = new mod.BrowserQRCodeReader();
    const localControls = await reader.decodeFromVideoDevice(
      undefined,
      videoEl.value,
      (result: any, _error: unknown, callbackControls: any) => {
        if (callbackControls && run === generation) controls = callbackControls;
        if (result && !handled && run === generation) complete(result.getText());
      }
    );
    if (!props.open || run !== generation) {
      localControls?.stop?.();
      return;
    }
    controls = localControls;
  } catch {
    if (run !== generation || !props.open) return;
    cameraError.value = "无法打开相机。请允许相机权限，或从相册选择二维码。";
  }
}

function complete(value: string) {
  if (handled) return;
  handled = true;
  stopScanner();
  emit("scanned", value);
}

async function scanImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  cameraError.value = "";
  try {
    const mod = await import("@zxing/browser");
    const imageReader = reader || new mod.BrowserQRCodeReader();
    const url = URL.createObjectURL(file);
    try {
      const result = await imageReader.decodeFromImageUrl(url);
      complete(result.getText());
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    cameraError.value = "没有识别到二维码，请换一张更清晰的图片。";
  }
}

function close() {
  stopScanner();
  emit("close");
}

function handleVisibility() {
  if (!props.open) return;
  if (document.visibilityState === "hidden") stopScanner();
  else void startScanner();
}

document.addEventListener("visibilitychange", handleVisibility);
onBeforeUnmount(() => {
  stopScanner();
  ui.setBlockingOverlay("friend-qr-scanner", false);
  document.removeEventListener("visibilitychange", handleVisibility);
});
</script>

<style scoped>
.scanner-overlay{position:fixed;inset:0;z-index:12500;display:flex;align-items:flex-end;justify-content:center;background:rgba(2,6,23,.72)}
.scanner-sheet{width:min(100%,520px);box-sizing:border-box;padding:16px 16px calc(22px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:#fff}
.scanner-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;color:#172033;font-size:17px}.scanner-header button{width:34px;height:34px;border:0;border-radius:50%;background:#f1f5f9;color:#475569;font-size:24px}
.camera-frame{position:relative;overflow:hidden;width:100%;aspect-ratio:1;border-radius:18px;background:#0f172a}.camera-frame video{width:100%;height:100%;object-fit:cover}.scan-frame{position:absolute;inset:17%;border:2px solid rgba(255,255,255,.92);border-radius:18px;box-shadow:0 0 0 999px rgba(2,6,23,.25)}
.hint,.error{margin:12px 0 0;text-align:center;font-size:13px}.hint{color:#64748b}.error{color:#b91c1c}
.scanner-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.scanner-actions button{min-height:44px;border:1px solid #cbd5e1;border-radius:11px;background:#fff;color:#334155;font-weight:700}.scanner-actions button:first-child{border-color:#1687e8;color:#1687e8}.hidden-input{display:none}
</style>
