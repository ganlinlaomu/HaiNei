<template>
  <button
    class="dm-file-card"
    :class="{ own, busy: downloading }"
    type="button"
    :disabled="!media || downloading"
    :aria-label="media ? `保存文件 ${displayName}，${sizeLabel}` : `文件 ${displayName}`"
    @click.stop="save"
  >
    <span class="file-badge" aria-hidden="true">{{ badge }}</span>
    <span class="file-copy">
      <strong>{{ displayName }}</strong>
      <small>{{ statusText }}</small>
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { dmFileBadge, formatDmFileSize, type PrivateFileMedia } from "@/nostr/messaging/privateFile";
import { downloadDecryptedDmFile, saveDecryptedDmFile } from "@/utils/encryptedDmFile";
import { useUIStore } from "@/stores/ui";

const props = defineProps<{
  media?: PrivateFileMedia | null;
  /** Shown while the file is still being encrypted or uploaded. */
  pendingName?: string;
  pendingSize?: number;
  own?: boolean;
}>();

const ui = useUIStore();
const downloading = ref(false);
/** Decrypted and waiting for a fresh tap (iOS share needs one). */
const readyFile = shallowRef<File | null>(null);
let controller: AbortController | null = null;

const displayName = computed(() => props.media?.name || props.pendingName || "文件");
const size = computed(() => props.media?.size ?? props.pendingSize ?? 0);
const sizeLabel = computed(() => formatDmFileSize(size.value));
const badge = computed(() => dmFileBadge(displayName.value, props.media?.mime || ""));
const statusText = computed(() => {
  if (downloading.value) return "正在解密…";
  if (!props.media) return sizeLabel.value ? `${sizeLabel.value} · 处理中` : "处理中";
  if (readyFile.value) return `${sizeLabel.value} · 已解密，点击保存`;
  return `${sizeLabel.value} · 点击保存`;
});

async function handOff(file: File) {
  const result = await saveDecryptedDmFile(file);
  readyFile.value = result === "needs-gesture" ? file : null;
  if (result === "downloaded") ui.addToast("文件已开始下载", 1600, "success");
}

async function save() {
  const media = props.media;
  if (!media || downloading.value) return;
  if (readyFile.value) {
    await handOff(readyFile.value);
    return;
  }
  downloading.value = true;
  controller = new AbortController();
  try {
    await handOff(await downloadDecryptedDmFile(media, controller.signal));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      ui.addToast("文件下载失败，请稍后重试", 2200, "error");
    }
  } finally {
    downloading.value = false;
    controller = null;
  }
}

onBeforeUnmount(() => controller?.abort());
</script>

<style scoped>
.dm-file-card{display:flex;align-items:center;gap:10px;width:min(260px,64vw);min-height:56px;padding:8px 10px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dm-file-card:disabled{cursor:default}
.dm-file-card.busy{opacity:.7}
.file-badge{display:grid;place-items:center;flex:0 0 40px;width:40px;height:46px;border-radius:7px;background:#1687e8;color:#fff;font-size:10px;font-weight:800;letter-spacing:.02em}
.file-copy{display:flex;min-width:0;flex-direction:column;gap:3px}
.file-copy strong{overflow:hidden;font-size:14px;font-weight:600;line-height:1.3;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.file-copy small{opacity:.72;font-size:12px}
</style>
