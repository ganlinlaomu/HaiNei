<template>
  <div
    class="voice-message"
    :class="{ loading, failed: !!error, own, peer: !own, played }"
  >
    <div class="voice-shell" :class="{ playing }">
      <button
        type="button"
        class="voice-toggle"
        :class="{ playing }"
        :aria-label="playing ? '暂停语音' : '播放语音'"
        :disabled="loading || suspended"
        @click="toggle"
      >
        <span aria-hidden="true">{{ loading ? "…" : playing ? "Ⅱ" : "▶" }}</span>
      </button>

      <button
        type="button"
        class="waveform-button"
        :class="{ loading }"
        :aria-label="playing ? '暂停语音' : '播放语音'"
        :disabled="loading || suspended"
        @click="toggle"
      >
        <span class="voice-waveform" aria-hidden="true">
          <i
            v-for="(height, index) in waveformBars"
            :key="index"
            :class="{ active: index < playedBarCount }"
            :style="{ height: `${height}px` }"
          ></i>
        </span>
      </button>

      <span class="voice-duration" :class="{ played }">
        {{ formatDuration(playing || currentTime ? currentTime : (playDuration || duration)) }}
      </span>
    </div>

    <audio
      v-if="!suspended"
      ref="audio"
      :src="sourceUrl"
      preload="none"
      @timeupdate="syncPlayback"
      @loadedmetadata="syncMetadata"
      @ended="handleEnded"
    ></audio>

    <button v-if="error" class="voice-retry" type="button" @click="toggle">重试</button>

    <div class="voice-transcription">
      <button
        type="button"
        class="transcription-toggle"
        :disabled="transcribing || suspended"
        @click="transcribe"
      >转文字</button>
      <span v-if="transcriptionError" class="transcription-error">{{ transcriptionError }}</span>
      <p v-if="transcript" class="transcript-text">{{ transcript }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { PrivateAudioMedia } from "@/nostr/messaging/privateMedia";
import { decryptDmAudio } from "@/utils/encryptedDmAudio";
import { transcribeAudioLocally } from "@/utils/localTranscription";
import { getCachedTranscript, setCachedTranscript } from "@/utils/localTranscriptCache";

const WAVEFORM_BAR_COUNT = 32;

const props = withDefaults(defineProps<{
  media?: PrivateAudioMedia | null;
  previewUrl?: string;
  duration?: number;
  accountPubkey?: string;
  transcriptKey?: string;
  suspended?: boolean;
  own?: boolean;
}>(), {
  media: null,
  previewUrl: "",
  duration: 0,
  accountPubkey: "",
  transcriptKey: "",
  suspended: false,
  own: false,
});

const audio = ref<HTMLAudioElement | null>(null);
const decryptedUrl = ref("");
const loading = ref(false);
const error = ref("");
const playing = ref(false);
const played = ref(false);
const currentTime = ref(0);
const playDuration = ref(0);
const transcribing = ref(false);
const transcriptionError = ref("");
const transcript = ref(getCachedTranscript(props.transcriptKey));
let decryptedBlob: Blob | null = null;
let controller: AbortController | null = null;

const sourceUrl = computed(() => props.suspended ? "" : (props.previewUrl || decryptedUrl.value));

const waveformSeed = computed(() =>
  props.transcriptKey
  || props.media?.encryptedRef
  || props.previewUrl
  || `voice:${props.duration}`
);

const waveformBars = computed(() => {
  let state = hashString(waveformSeed.value);
  return Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => {
    state = xorshift32(state + index + 1);
    const normalized = Math.abs(state % 1000) / 1000;
    return Math.round(7 + normalized * 17);
  });
});

const playbackRatio = computed(() => {
  const total = playDuration.value || props.duration || 0;
  if (!total) return 0;
  return Math.min(1, Math.max(0, currentTime.value / total));
});

const playedBarCount = computed(() =>
  Math.min(WAVEFORM_BAR_COUNT, Math.ceil(playbackRatio.value * WAVEFORM_BAR_COUNT))
);

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function xorshift32(value: number) {
  let x = value >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

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
  played.value = false;
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
    await audio.value.play()
      .then(() => { playing.value = true; })
      .catch(() => { error.value = "语音播放失败"; });
  } else {
    audio.value.pause();
    playing.value = false;
  }
}

function syncPlayback() {
  currentTime.value = audio.value?.currentTime || 0;
}

function syncMetadata() {
  playDuration.value = Number.isFinite(audio.value?.duration) ? audio.value?.duration || 0 : 0;
}

function handleEnded() {
  playing.value = false;
  played.value = true;
}

async function transcribe() {
  if (transcribing.value || props.suspended) return;
  transcribing.value = true;
  transcriptionError.value = "";
  try {
    const blob = await ensureAudioBlob();
    const result = await transcribeAudioLocally(blob);
    transcript.value = result.text || "未识别到清晰语音";
    setCachedTranscript(props.transcriptKey, transcript.value);
  } catch (cause) {
    transcriptionError.value = cause instanceof Error ? cause.message : "本机转写失败";
  } finally {
    transcribing.value = false;
  }
}

function restoreTranscription() {
  transcript.value = getCachedTranscript(props.transcriptKey);
  transcriptionError.value = "";
}

watch(
  () => [props.media?.encryptedRef, props.previewUrl, props.accountPubkey, props.transcriptKey],
  () => {
    releaseRuntimeAudio();
    restoreTranscription();
  }
);

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
.voice-message{
  --wave-muted:#bccbd7;
  --wave-active:#557b99;
  --voice-surface:#edf3f8;
  display:grid;
  gap:5px;
  min-width:224px;
  max-width:300px
}
.voice-message.own{
  --wave-muted:rgba(20,91,145,.28);
  --wave-active:#117fce;
  --voice-surface:rgba(255,255,255,.52)
}
.voice-message.peer{
  --wave-muted:#c4d1dc;
  --wave-active:#5e7f98;
  --voice-surface:#edf3f8
}
.voice-shell{
  display:grid;
  grid-template-columns:36px minmax(126px,1fr) 38px;
  align-items:center;
  gap:8px;
  min-height:46px;
  padding:5px 8px 5px 6px;
  border-radius:15px;
  background:var(--voice-surface);
  transition:background 150ms ease,box-shadow 150ms ease
}
.voice-shell.playing{
  box-shadow:inset 0 0 0 1px rgba(29,155,240,.13)
}
.voice-toggle{
  display:grid;
  width:36px;
  height:36px;
  padding:0;
  place-items:center;
  border:0;
  border-radius:50%;
  background:#1d9bf0;
  color:#fff;
  font-size:12px;
  box-shadow:0 1px 2px rgba(15,23,42,.10);
  transition:transform 120ms ease,background 120ms ease,box-shadow 120ms ease
}
.voice-toggle.playing{
  background:#138bd9;
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.20),0 1px 3px rgba(15,23,42,.12);
  transform:scale(.97)
}
.voice-toggle:disabled,
.waveform-button:disabled{opacity:.55}
.waveform-button{
  min-width:0;
  height:34px;
  padding:0;
  border:0;
  background:transparent;
  cursor:pointer
}
.voice-waveform{
  display:flex;
  height:28px;
  align-items:center;
  justify-content:space-between;
  gap:2px;
  overflow:hidden
}
.voice-waveform i{
  width:3px;
  min-width:3px;
  max-height:24px;
  border-radius:999px;
  background:var(--wave-muted);
  transition:background 90ms linear,opacity 120ms ease
}
.voice-waveform i.active{
  background:var(--wave-active)
}
.waveform-button.loading .voice-waveform i{
  animation:voice-wave-loading .8s ease-in-out infinite alternate
}
.waveform-button.loading .voice-waveform i:nth-child(3n+1){animation-delay:.08s}
.waveform-button.loading .voice-waveform i:nth-child(3n+2){animation-delay:.16s}
@keyframes voice-wave-loading{
  from{opacity:.32}
  to{opacity:.86}
}
.voice-duration{
  color:#536471;
  font-size:11px;
  font-variant-numeric:tabular-nums;
  text-align:right;
  transition:color 150ms ease,opacity 150ms ease
}
.voice-duration.played{
  color:#8c9aa6;
  opacity:.68
}
.voice-message audio{display:none}
.voice-retry{
  padding:0 0 0 50px;
  border:0;
  background:transparent;
  color:#dc2626;
  font-size:11px;
  text-align:left
}
.voice-transcription{
  display:flex;
  min-width:0;
  flex-wrap:wrap;
  align-items:center;
  gap:5px 8px;
  padding:0 4px
}
.transcription-toggle{
  padding:0;
  border:0;
  background:transparent;
  color:#1687e8;
  font-size:11px;
  font-weight:650
}
.transcription-toggle:disabled{opacity:.5}
.transcription-error{color:#dc2626;font-size:10px}
.transcript-text{
  width:100%;
  margin:2px 0 0;
  padding:8px 9px;
  border-radius:9px;
  background:rgba(255,255,255,.62);
  color:#334155;
  font-size:13px;
  line-height:1.45;
  white-space:pre-wrap;
  overflow-wrap:anywhere
}
@media(max-width:420px){
  .voice-message{min-width:208px;max-width:270px}
  .voice-shell{grid-template-columns:34px minmax(112px,1fr) 36px;gap:7px}
  .voice-toggle{width:34px;height:34px}
  .voice-waveform{gap:1.5px}
}
</style>
