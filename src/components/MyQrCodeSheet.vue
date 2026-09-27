<template>
  <div v-if="open" class="qr-overlay" role="presentation" @click.self="close">
    <section class="qr-sheet" role="dialog" aria-modal="true" aria-label="我的二维码">
      <div class="sheet-handle" aria-hidden="true"></div>
      <button class="close-button" type="button" aria-label="关闭" @click="close">×</button>
      <ProfileAvatar :pubkey="pubkey" :local-name="nickname" :size="64" />
      <h2>{{ nickname || "我的二维码" }}</h2>
      <p class="hint">让对方使用海内扫描，即可发起好友请求</p>
      <div class="qr-card" v-html="qrSvg"></div>
      <p class="npub">{{ npub }}</p>
      <div class="actions">
        <button type="button" class="copy-button" @click="copyNpub">复制公钥</button>
        <button type="button" class="done-button" @click="close">关闭</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import qrcode from "qrcode-generator";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { useUIStore } from "@/stores/ui";
import { buildNostrProfileQrValue, pubkeyToNpub } from "@/utils/nostrQr";

const props = defineProps<{ open: boolean; pubkey: string; nickname?: string }>();
const emit = defineEmits<{ (event: "close"): void }>();
const ui = useUIStore();

const npub = computed(() => {
  try { return pubkeyToNpub(props.pubkey); } catch { return ""; }
});
const qrSvg = computed(() => {
  if (!props.pubkey) return "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(buildNostrProfileQrValue(props.pubkey), "Byte");
    qr.make();
    return qr.createSvgTag({ cellSize: 7, margin: 4, scalable: true });
  } catch {
    return "";
  }
});

watch(() => props.open, visible => ui.setBlockingOverlay("my-qr-code", visible), { immediate: true });
onBeforeUnmount(() => ui.setBlockingOverlay("my-qr-code", false));

function close() { emit("close"); }

async function copyNpub() {
  if (!npub.value) return;
  try {
    await navigator.clipboard.writeText(npub.value);
    ui.addToast("已复制 npub 公钥", 1_800, "success");
  } catch {
    ui.addToast("复制失败，请稍后重试", 2_000, "error");
  }
}
</script>

<style scoped>
.qr-overlay{position:fixed;inset:0;z-index:12000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.48)}
.qr-sheet{position:relative;width:min(100%,460px);box-sizing:border-box;padding:10px 22px calc(24px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:#fff;text-align:center;box-shadow:0 -12px 36px rgba(15,23,42,.16)}
.sheet-handle{width:40px;height:4px;margin:0 auto 14px;border-radius:999px;background:#cbd5e1}
.close-button{position:absolute;top:14px;right:16px;width:34px;height:34px;border:0;border-radius:50%;background:#f1f5f9;color:#475569;font-size:24px;line-height:1}
h2{margin:9px 0 3px;color:#172033;font-size:20px}.hint{margin:0 0 16px;color:#64748b;font-size:13px}
.qr-card{width:min(78vw,290px);aspect-ratio:1;margin:0 auto;padding:10px;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:16px;background:#fff}
.qr-card :deep(svg){display:block;width:100%;height:100%}.npub{margin:14px auto 16px;max-width:330px;color:#64748b;font-size:12px;overflow-wrap:anywhere}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.actions button{min-height:44px;border-radius:11px;font-weight:700}
.copy-button{border:1px solid #cbd5e1;background:#fff;color:#334155}.done-button{border:0;background:#1687e8;color:#fff}
</style>
