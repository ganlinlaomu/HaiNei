<template>
  <div class="voice-message" :class="{ loading, failed: !!error }">
    <button type="button" class="voice-toggle" :aria-label="playing ? '暂停语音' : '播放语音'" :disabled="loading || suspended" @click="toggle">
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
    <audio v-if="!suspended" ref="audio" :src="sourceUrl" preload="none" @timeupdate="syncPlayback" @loadedmetadata="syncMetadata" @ended="playing = false"></audio>
    <button v-if="error" class="voice-retry" type="button" @click="toggle">重试</button>
    <div class="voice-transcription">
      <button
        type="button"
        class="transcription-toggle"
        :disabled="transcribing || suspended"
        @click="toggleTranscription"
      >
        {{ transcript ? (transcriptVisible ? "收起文字" : "展开文字") : transcribing ? transcriptionStatus : "转文字" }}
      </button>
      <span v-if="!transcript && !transcribing && !transcriptionError" class="transcription-note">本机转写 · 语音不上传 · 首次使用会下载模型</span>
      <span v-if="transcriptionError" class="transcription-error">{{ transcriptionError }}</span>
      <p v-if="transcript && transcriptVisible" class="transcript-text">{{ transcript }}</p>
      <span v-if="transcript && transcriptVisible && transcriptionElapsedMs" class="transcription-meta">本机完成 · {{ (transcriptionElapsedMs / 1000).toFixed(1) }} 秒</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { PrivateAudioMedia } from "@/nostr/messaging/privateMedia";
import { decryptDmAudio } from "@/utils/encryptedDmAudio";
import { transcribeAudioLocally, type TranscriptionProgress } from "@/utils/localTranscription";

const props = withDefaults(defineProps<{
  media?: PrivateAudioMedia | null;
  previewUrl?: string;
  duration?: number;
  accountPubkey?: string;
  suspended?: boolean;
}>(), { media: null, previewUrl: "", duration: 0, accountPubkey: "", suspended: false });

const audio = ref<HTMLAudioElement | null>(null);
const decryptedUrl = ref("");
const loading = ref(false);
const error = ref("");
const playing = ref(false);
const currentTime = ref(0);
const playDuration = ref(0);
const transcribing = ref(false);
const transcriptionStatus = ref("准备本机转写…");
const transcriptionError = ref("");
const transcript = ref("");
const transcriptVisible = ref(false);
const transcriptionElapsedMs = ref(0);
let decryptedBlob: Blob | null = null;
let controller: AbortController | null = null;
const sourceUrl = computed(() => props.suspended ? "" : (props.previewUrl || decryptedUrl.value));

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
  decryptedBlob = null;
}
async function ensureAudioBlob() {
  if (decryptedBlob) return decryptedBlob;
  if (props.previewUrl) {
    const response = await fetch(props.previewUrl);
    if (!response.ok) throw new Error("语音读取失败");
    decryptedBlob = await response.blob();
    return decryptedBlob;
  }
  if (!props.media?.encryptedRef || !props.accountPubkey) throw new Error("语音暂不可用");
  const account = props.accountPubkey;
  controller = new AbortController();
  const blob = await decryptDmAudio(props.media.encryptedRef, controller.signal);
  if (controller.signal.aborted || props.accountPubkey !== account) throw new DOMException("Aborted", "AbortError");
  decryptedBlob = blob;
  return blob;
}
async function ensureSource() {
  if (sourceUrl.value) return true;
  loading.value = true;
  error.value = "";
  try {
    const blob = await ensureAudioBlob();
    if (!props.previewUrl) decryptedUrl.value = URL.createObjectURL(blob);
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
  if (props.suspended || !(await ensureSource())) return;
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

function updateTranscriptionProgress(progress: TranscriptionProgress) {
  if (progress.stage === "decoding") transcriptionStatus.value = "正在读取语音…";
  else if (progress.stage === "transcribing") transcriptionStatus.value = "正在本机转写…";
  else if (typeof progress.progress === "number" && progress.progress > 0 && progress.progress < 100) {
    transcriptionStatus.value = `下载模型 ${Math.round(progress.progress)}%`;
  } else transcriptionStatus.value = "正在加载本机模型…";
}
async function toggleTranscription() {
  if (transcript.value) {
    transcriptVisible.value = !transcriptVisible.value;
    return;
  }
  if (transcribing.value || props.suspended) return;
  transcribing.value = true;
  transcriptionError.value = "";
  transcriptionStatus.value = "准备本机转写…";
  try {
    const blob = await ensureAudioBlob();
    const result = await transcribeAudioLocally(blob, updateTranscriptionProgress);
    transcript.value = result.text || "未识别到清晰语音";
    transcriptionElapsedMs.value = result.elapsedMs;
    transcriptVisible.value = true;
  } catch (cause) {
    transcriptionError.value = cause instanceof Error ? cause.message : "本机转写失败";
  } finally {
    transcribing.value = false;
  }
}
function resetTranscription() {
  transcript.value = "";
  transcriptVisible.value = false;
  transcriptionElapsedMs.value = 0;
  transcriptionError.value = "";
  transcriptionStatus.value = "准备本机转写…";
}

watch(() => [props.media?.encryptedRef, props.previewUrl, props.accountPubkey], () => {
  releaseRuntimeAudio();
  resetTranscription();
});
watch(() => props.suspended, suspended => {
  if (!suspended) return;
  releaseRuntimeAudio();
  if (audio.value) {
    audio.value.removeAttribute("src");
    audio.value.load();
  }
});
onBeforeUnmount(releaseRuntimeAudio);
</script>

<style scoped>
.voice-message{display:grid;grid-template-columns:34px minmax(100px,180px) 36px;align-items:center;gap:7px;min-width:210px}.voice-toggle{display:grid;width:34px;height:34px;padding:0;place-items:center;border:0;border-radius:50%;background:#1d9bf0;color:#fff;font-size:13px}.voice-toggle:disabled{opacity:.55}.voice-progress{width:100%;height:3px;margin:0;accent-color:#1d9bf0}.voice-duration{color:#536471;font-size:11px;text-align:right}.voice-message audio{display:none}.voice-retry{grid-column:2 / 4;padding:0;border:0;background:transparent;color:#dc2626;font-size:11px;text-align:left}.voice-transcription{grid-column:1 / -1;display:flex;min-width:0;flex-wrap:wrap;align-items:center;gap:5px 8px;padding-top:2px}.transcription-toggle{padding:0;border:0;background:transparent;color:#1687e8;font-size:11px;font-weight:650}.transcription-toggle:disabled{opacity:.5}.transcription-note,.transcription-meta{color:#8b98a5;font-size:10px}.transcription-error{color:#dc2626;font-size:10px}.transcript-text{width:100%;margin:2px 0 0;padding:8px 9px;border-radius:9px;background:rgba(255,255,255,.62);color:#334155;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
