<template>
  <div class="voice-message" :class="{ loading, failed: !!error }">
    <button type="button" class="voice-toggle" :aria-label="playing ? '暂停语音' : '播放语音'" :disabled="loading" @click="toggle">
      <span aria-hidden="true">{{ loading ? "…" : playing ? "Ⅱ" : "▶" }}</span>
    </button>
    <input
      class="voice-progress"
      type="range"
      min="0"
      :max="playDuration || duration || 0"
      step="0.1"
      :value="currentTime"
      aria-label="语音播放进度"
      @input="seek"
    />
    <span class="voice-duration">{{ formatDuration(playing || currentTime ? currentTime : (playDuration || duration)) }}</span>
    <audio ref="audio" :src="sourceUrl" preload="metadata" @timeupdate="syncPlayback" @loadedmetadata="syncMetadata" @ended="playing = false"></audio>
    <button v-if="error" class="voice-retry" type="button" @click="toggle">重试</button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { PrivateAudioMedia } from "@/nostr/messaging/privateMedia";
import { decryptDmAudio } from "@/utils/encryptedDmAudio";

const props = withDefaults(defineProps<{
  media?: PrivateAudioMedia | null;
  previewUrl?: string;
  duration?: number;
  accountPubkey?: string;
}>(), { media: null, previewUrl: "", duration: 0, accountPubkey: "" });

const audio = ref<HTMLAudioElement | null>(null);
const decryptedUrl = ref("");
const loading = ref(false);
const error = ref("");
const playing = ref(false);
const currentTime = ref(0);
const playDuration = ref(0);
let controller: AbortController | null = null;
const sourceUrl = computed(() => props.previewUrl || decryptedUrl.value);

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function releaseRuntimeAudio() {
  controller?.abort();
  controller = null;
  audio.value?.pause();
  playing.value = false;
  currentTime.value = 0;
  playDuration.value = 0;
  if (decryptedUrl.value) URL.revokeObjectURL(decryptedUrl.value);
  decryptedUrl.value = "";
}
async function ensureSource() {
  if (sourceUrl.value) return true;
  if (!props.media?.encryptedRef || !props.accountPubkey) return false;
  loading.value = true;
  error.value = "";
  const account = props.accountPubkey;
  controller = new AbortController();
  try {
    const blob = await decryptDmAudio(props.media.encryptedRef, controller.signal);
    if (controller.signal.aborted || props.accountPubkey !== account) return false;
    decryptedUrl.value = URL.createObjectURL(blob);
    await nextTick();
    return true;
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "AbortError")) error.value = "语音加载失败";
    return false;
  } finally {
    loading.value = false;
  }
}
async function toggle() {
  if (!(await ensureSource())) return;
  if (!audio.value) return;
  if (audio.value.paused) {
    error.value = "";
    await audio.value.play().then(() => { playing.value = true; }).catch(() => { error.value = "语音播放失败"; });
  } else {
    audio.value.pause();
    playing.value = false;
  }
}
function syncPlayback() { currentTime.value = audio.value?.currentTime || 0; }
function syncMetadata() { playDuration.value = Number.isFinite(audio.value?.duration) ? audio.value?.duration || 0 : 0; }
function seek(event: Event) {
  if (!audio.value) return;
  audio.value.currentTime = Number((event.target as HTMLInputElement).value);
  syncPlayback();
}

watch(() => [props.media?.encryptedRef, props.previewUrl, props.accountPubkey], releaseRuntimeAudio);
onBeforeUnmount(releaseRuntimeAudio);
</script>

<style scoped>
.voice-message{display:grid;grid-template-columns:34px minmax(100px,180px) 36px;align-items:center;gap:7px;min-width:210px}.voice-toggle{display:grid;width:34px;height:34px;padding:0;place-items:center;border:0;border-radius:50%;background:#1d9bf0;color:#fff;font-size:13px}.voice-toggle:disabled{opacity:.55}.voice-progress{width:100%;height:3px;margin:0;accent-color:#1d9bf0}.voice-duration{color:#536471;font-size:11px;text-align:right}.voice-message audio{display:none}.voice-retry{grid-column:2 / 4;padding:0;border:0;background:transparent;color:#dc2626;font-size:11px;text-align:left}
</style>
