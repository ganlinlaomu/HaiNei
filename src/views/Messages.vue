<template>
  <main class="chat-page">
    <header class="chat-header">
      <button type="button" class="back-button" aria-label="返回私信列表" @click="router.back()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <ProfileAvatar :pubkey="peerPubkey" :local-name="localName" :size="34" />
      <strong>{{ displayName }}</strong>
    </header>

    <section ref="messageList" class="message-list" aria-live="polite" @scroll.passive="handleMessageScroll">
      <div v-if="!accepted" class="relationship-notice">已不是已接受的好友，无法发送新消息。</div>
      <div v-if="accepted && messages.length === 0" class="empty-chat">开始一段私密对话</div>
      <template v-for="(message, index) in windowMessages" :key="message.id">
        <time v-if="showTimestamp(windowStart + index)" class="message-time">{{ formatMessageTime(message.created_at) }}</time>
        <div class="message-line" :class="{ own: isOwn(message) }">
          <span v-if="!isOwn(message)" class="avatar-slot">
            <ProfileAvatar v-if="showAvatar(windowStart + index)" :pubkey="peerPubkey" :local-name="localName" :size="28" />
          </span>
          <div class="message-stack">
            <div class="message-bubble" :class="{ 'media-caption-bubble': isMediaCaption(message), 'audio-bubble': hasAudio(message) }">
              <DmAudioMessage
                v-if="hasAudio(message)"
                :media="audioMedia(message)"
                :preview-url="message.outgoing?.audioPreviewUrl"
                :duration="message.outgoing?.audioDuration || audioMedia(message)?.duration || 0"
                :account-pubkey="keys.pkHex"
              />
              <template v-else-if="isMediaCaption(message)">
                <img v-if="message.outgoing?.imagePreviewUrl" :src="message.outgoing.imagePreviewUrl" class="optimistic-image" alt="待发送私信图片" />
                <PostImagePreview v-else :content="message.content" :show-all="true" alt-text="私信图片" />
                <div class="caption-area">
                  <span class="bubble-text">{{ messageText(message.content) }}</span>
                  <span class="caption-meta" :class="{ failed: isFailed(message) }">
                    <time>{{ formatBubbleTime(message.created_at) }}</time>
                    <template v-if="isOwn(message) && message.outgoing">
                      <span>{{ statusLabel(message) }}</span>
                      <button v-if="isFailed(message)" type="button" @click="directMessages.retry(message.outgoing.localId)">重试</button>
                    </template>
                  </span>
                </div>
              </template>
              <template v-else>
                <span v-if="messageText(message.content)" class="bubble-text">{{ messageText(message.content) }}</span>
                <img v-if="message.outgoing?.imagePreviewUrl" :src="message.outgoing.imagePreviewUrl" class="optimistic-image" alt="待发送私信图片" />
                <PostImagePreview v-else-if="hasImage(message.content)" :content="message.content" :show-all="true" alt-text="私信图片" />
              </template>
            </div>
            <span v-if="isOwn(message) && message.outgoing && !isMediaCaption(message)" class="message-status" :class="{ failed: isFailed(message) }">
              {{ statusLabel(message) }}
              <button v-if="isFailed(message)" type="button" @click="directMessages.retry(message.outgoing.localId)">重试</button>
            </span>
          </div>
        </div>
      </template>
    </section>

    <div v-if="selectedImage" class="selected-image">
      <img :src="selectedImage.preview" alt="待发送图片" />
      <button type="button" aria-label="移除图片" @click="removeSelectedImage">×</button>
    </div>
    <div v-if="recording" class="recording-panel" role="status" aria-live="polite">
      <span class="recording-dot" aria-hidden="true"></span>
      <strong>录音中 {{ formatVoiceDuration(recordingElapsed) }}</strong>
      <button type="button" @click="cancelVoiceRecording">取消</button>
      <button type="button" class="finish-recording" @click="finishVoiceRecording">完成</button>
    </div>
    <div v-else-if="recordedAudio" class="recorded-audio">
      <DmAudioMessage :preview-url="recordedAudio.preview" :duration="recordedAudio.duration" />
      <button type="button" aria-label="移除语音" @click="clearRecordedAudio">×</button>
    </div>
    <p v-if="voiceError" class="voice-error" role="alert">{{ voiceError }}</p>
    <form class="chat-composer" @submit.prevent="submitMessage">
      <input ref="imageInput" class="image-input" type="file" accept="image/*" @change="selectImage" />
      <button class="image-button" type="button" aria-label="添加图片" :disabled="!accepted || !keys.pkHex || !!recording || !!recordedAudio" @click="imageInput?.click()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>
      </button>
      <button class="microphone-button" type="button" aria-label="录制语音" :disabled="!accepted || !keys.pkHex || startingRecording || !!recording || !!selectedImage || !!recordedAudio" @click="startVoiceRecording">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>
      </button>
      <input v-model="draft" type="text" autocomplete="off" :placeholder="accepted ? '输入消息……' : '仅已接受好友可发送私信'" :disabled="!accepted || !keys.pkHex || !!recording || !!recordedAudio" />
      <button class="send-button" type="submit" :disabled="!canSend">发送</button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import PostImagePreview from "@/components/PostImagePreview.vue";
import DmAudioMessage from "@/components/DmAudioMessage.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { parsePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import {
  initialMessageWindowStart,
  isNearMessageBottom,
  prependMessageWindowStart,
  scrollTopAfterNewMessages,
  scrollTopAfterPrepend,
  type MessageScrollMetrics,
} from "@/utils/messageWindow";
import { createVoiceRecordingSession, type VoiceRecordingResult, type VoiceRecordingSession } from "@/utils/voiceRecorder";

const route = useRoute();
const router = useRouter();
const keys = useKeyStore();
const messageStore = useMessagesStore();
const directMessages = useDirectMessagesStore();
const friendships = useFriendshipsStore();
const friends = useFriendsStore();
const profiles = useProfilesStore();
const peerPubkey = computed(() => String(route.params.pubkey || "").trim().toLowerCase());
const accepted = computed(() => friendships.loadedFor === keys.pkHex && friendships.isAccepted(peerPubkey.value));
const localName = computed(() => friends.list.find(friend => friend.pubkey === peerPubkey.value)?.name);
const displayName = computed(() => privateProfileDisplayName(profiles.getProfile(peerPubkey.value)?.nickname, peerPubkey.value, localName.value));
const messages = computed(() => directMessages.peerMessages(peerPubkey.value));
const windowStart = ref(initialMessageWindowStart(messages.value.length));
const windowMessages = computed(() => messages.value.slice(windowStart.value));
const draft = ref("");
const selectedImage = ref<{ file: File; preview: string } | null>(null);
const recording = ref<VoiceRecordingSession | null>(null);
const startingRecording = ref(false);
const recordingElapsed = ref(0);
const recordedAudio = ref<(VoiceRecordingResult & { preview: string }) | null>(null);
const voiceError = ref("");
const imageInput = ref<HTMLInputElement | null>(null);
const messageList = ref<HTMLElement | null>(null);
const canSend = computed(() => !!keys.pkHex && accepted.value && !recording.value && (!!draft.value.trim() || !!selectedImage.value || !!recordedAudio.value));
const INITIAL_MESSAGE_COUNT = 60;
const OLDER_MESSAGE_BATCH = 40;
const TOP_LOAD_THRESHOLD = 120;
const BOTTOM_FOLLOW_THRESHOLD = 120;
let prependingOlder = false;
let loadingConversation = false;
let loadGeneration = 0;
let restoreOverflowAnchorFrame: number | null = null;
let disposed = false;
let recordingTimer: number | null = null;

const hasImage = (content: string) => /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/i.test(content);
const messageText = (content: string) => ["[图片]", "[语音]"].includes(directMessagePreview(content)) ? "" : directMessagePreview(content);
const audioMedia = (message: InboxItem) => parsePrivateAudioMessage(message.content)?.media || null;
const hasAudio = (message: InboxItem) => !!message.outgoing?.hasAudio || !!audioMedia(message);
const hasMessageImage = (message: InboxItem) => !!message.outgoing?.imagePreviewUrl || hasImage(message.content);
const isMediaCaption = (message: InboxItem) => hasMessageImage(message) && !!messageText(message.content);
const isOwn = (message: InboxItem) => message.pubkey === keys.pkHex;
const isFailed = (message: InboxItem) => message.outgoing?.state === "upload_failed" || message.outgoing?.state === "send_failed";
function statusLabel(message: InboxItem) {
  switch (message.outgoing?.state) {
    case "uploading": return "上传中…";
    case "sending": return "发送中…";
    case "sent": return "✓ 已发送";
    case "upload_failed": return "上传失败 ·";
    case "send_failed": return "发送失败 ·";
    default: return "";
  }
}
function showAvatar(index: number) {
  if (isOwn(messages.value[index])) return false;
  const previous = messages.value[index - 1];
  return !previous || previous.pubkey !== messages.value[index].pubkey || messages.value[index].created_at - previous.created_at > 300;
}
function showTimestamp(index: number) {
  const previous = messages.value[index - 1];
  return !previous || messages.value[index].created_at - previous.created_at > 900;
}
function formatMessageTime(timestamp: number) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatBubbleTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function scrollToBottom() { void nextTick(() => { if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight; }); }

function scrollMetrics(element: HTMLElement): MessageScrollMetrics {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
}

function resetMessageWindow() {
  windowStart.value = initialMessageWindowStart(messages.value.length, INITIAL_MESSAGE_COUNT);
}

async function prependOlderMessages() {
  const list = messageList.value;
  const nextStart = prependMessageWindowStart(windowStart.value, OLDER_MESSAGE_BATCH);
  if (!list || prependingOlder || nextStart === windowStart.value) return;

  prependingOlder = true;
  const peerAtStart = peerPubkey.value;
  const previousScrollTop = list.scrollTop;
  const previousScrollHeight = list.scrollHeight;
  list.style.overflowAnchor = "none";
  windowStart.value = nextStart;
  await nextTick();
  if (disposed || peerAtStart !== peerPubkey.value) {
    list.style.removeProperty("overflow-anchor");
    prependingOlder = false;
    return;
  }
  list.scrollTop = scrollTopAfterPrepend(previousScrollTop, previousScrollHeight, list.scrollHeight);
  prependingOlder = false;

  if (restoreOverflowAnchorFrame !== null) cancelAnimationFrame(restoreOverflowAnchorFrame);
  restoreOverflowAnchorFrame = requestAnimationFrame(() => {
    restoreOverflowAnchorFrame = null;
    list.style.removeProperty("overflow-anchor");
  });
}

function handleMessageScroll() {
  if ((messageList.value?.scrollTop || 0) <= TOP_LOAD_THRESHOLD) void prependOlderMessages();
}

async function load() {
  const generation = ++loadGeneration;
  loadingConversation = true;
  resetMessageWindow();
  const account = keys.pkHex;
  if (!account || peerPubkey.value === account) {
    loadingConversation = false;
    return void router.replace("/conversations");
  }
  try {
    await Promise.all([messageStore.load(account), friendships.load(account), friends.load(account), profiles.load(account)]);
    if (generation !== loadGeneration || account !== keys.pkHex) return;
    resetMessageWindow();
    await directMessages.markPeerRead(peerPubkey.value);
    if (generation !== loadGeneration || account !== keys.pkHex) return;
    scrollToBottom();
  } finally {
    if (generation === loadGeneration) loadingConversation = false;
  }
}
function removeSelectedImage() {
  if (selectedImage.value) URL.revokeObjectURL(selectedImage.value.preview);
  selectedImage.value = null;
  if (imageInput.value) imageInput.value.value = "";
}
function selectImage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file?.type.startsWith("image/")) return;
  removeSelectedImage();
  selectedImage.value = { file, preview: URL.createObjectURL(file) };
}
function formatVoiceDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function stopRecordingTimer() {
  if (recordingTimer !== null) window.clearInterval(recordingTimer);
  recordingTimer = null;
}
function clearRecordedAudio() {
  if (recordedAudio.value?.preview) URL.revokeObjectURL(recordedAudio.value.preview);
  recordedAudio.value = null;
}
function cancelVoiceRecording() {
  const active = recording.value;
  recording.value = null;
  stopRecordingTimer();
  recordingElapsed.value = 0;
  active?.cancel();
}
async function startVoiceRecording() {
  if (startingRecording.value || recording.value || recordedAudio.value || selectedImage.value || !accepted.value || !keys.pkHex) return;
  startingRecording.value = true;
  voiceError.value = "";
  const accountAtStart = keys.pkHex;
  const peerAtStart = peerPubkey.value;
  try {
    const session = await createVoiceRecordingSession();
    if (disposed || !accepted.value || keys.pkHex !== accountAtStart || peerPubkey.value !== peerAtStart) return session.dispose();
    recording.value = session;
    recordingElapsed.value = 0;
    recordingTimer = window.setInterval(() => {
      recordingElapsed.value = Math.min(300, (Date.now() - session.startedAt) / 1000);
    }, 250);
    void session.finished.then(result => {
      if (recording.value !== session) return;
      recording.value = null;
      stopRecordingTimer();
      recordingElapsed.value = 0;
      if (result) recordedAudio.value = { ...result, preview: URL.createObjectURL(result.blob) };
    }).catch(error => {
      if (recording.value !== session) return;
      recording.value = null;
      stopRecordingTimer();
      voiceError.value = error instanceof Error ? error.message : "录音失败";
    });
  } catch (error) {
    voiceError.value = error instanceof Error ? error.message : "无法使用麦克风";
  } finally {
    startingRecording.value = false;
  }
}
function finishVoiceRecording() {
  void recording.value?.finish();
}
function submitMessage() {
  if (!canSend.value) return;
  if (recordedAudio.value) {
    const audio = recordedAudio.value;
    try {
      directMessages.sendAudio(peerPubkey.value, audio);
      draft.value = "";
      clearRecordedAudio();
    } catch (error) {
      voiceError.value = error instanceof Error ? error.message : "语音发送失败";
    }
    return;
  }
  const text = draft.value;
  const image = selectedImage.value?.file;
  try {
    directMessages.send(peerPubkey.value, text, image);
    draft.value = "";
    removeSelectedImage();
  } catch {}
}

onMounted(load);
watch([() => keys.pkHex, peerPubkey], () => {
  cancelVoiceRecording();
  clearRecordedAudio();
  void load();
});
watch(() => messages.value.map(message => message.id).join("\0"), async (nextSignature, previousSignature) => {
  const nextIds = nextSignature ? nextSignature.split("\0") : [];
  const previousIds = previousSignature ? previousSignature.split("\0") : [];
  if (loadingConversation) {
    resetMessageWindow();
    return;
  }

  const list = messageList.value;
  const previousMetrics = list ? scrollMetrics(list) : undefined;
  const previousFirstId = previousIds?.[windowStart.value];
  const preservedStart = previousFirstId ? nextIds.indexOf(previousFirstId) : -1;
  if (preservedStart >= 0) windowStart.value = preservedStart;
  else windowStart.value = Math.min(windowStart.value, initialMessageWindowStart(nextIds.length, INITIAL_MESSAGE_COUNT));

  const previousLastId = previousIds?.at(-1);
  const hasNewTail = !!nextIds.length && (!previousLastId || nextIds.indexOf(previousLastId) < nextIds.length - 1);
  const markRead = directMessages.markPeerRead(peerPubkey.value);
  if (list && previousMetrics && hasNewTail && isNearMessageBottom(previousMetrics, BOTTOM_FOLLOW_THRESHOLD)) {
    await nextTick();
    list.scrollTop = scrollTopAfterNewMessages(previousMetrics, list.scrollHeight, BOTTOM_FOLLOW_THRESHOLD);
  }
  await markRead;
});
onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
  if (restoreOverflowAnchorFrame !== null) cancelAnimationFrame(restoreOverflowAnchorFrame);
  messageList.value?.style.removeProperty("overflow-anchor");
  removeSelectedImage();
  cancelVoiceRecording();
  clearRecordedAudio();
});
</script>

<style scoped>
.chat-page{position:fixed;inset:0;z-index:1000;display:grid;width:100%;max-width:none;margin:0;box-sizing:border-box;grid-template-rows:auto minmax(0,1fr) auto auto auto auto;background:#fff;color:#0f1419}
.chat-header{display:grid;grid-template-columns:38px 34px minmax(0,1fr);align-items:center;gap:8px;min-height:54px;padding:0 12px;border-bottom:1px solid #eff1f3;background:#fff}.back-button{display:grid;width:38px;height:42px;padding:8px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419}.back-button:active{background:#eff3f4}.back-button svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.chat-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}
.message-list{min-height:0;overflow-y:auto;padding:12px 12px 16px;overscroll-behavior:contain}.relationship-notice,.empty-chat{margin:14px auto;padding:9px 13px;color:#536471;font-size:12px;text-align:center}.message-time{display:block;margin:16px 0 10px;color:#8b98a5;font-size:11px;text-align:center}.message-line{display:flex;align-items:flex-end;gap:6px;margin:3px 0}.message-line.own{justify-content:flex-end}.avatar-slot{display:flex;width:28px;flex:0 0 28px}.message-stack{display:flex;max-width:min(76%,430px);align-items:flex-end;flex-direction:column}.message-line:not(.own) .message-stack{align-items:flex-start}.message-bubble{max-width:100%;padding:9px 12px;border-radius:18px 18px 18px 5px;background:#eff3f4;color:#0f1419;line-height:1.45;overflow:hidden}.message-line.own .message-bubble{border-radius:18px 18px 5px 18px;background:#d9efff}.bubble-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}.optimistic-image{display:block;width:min(260px,65vw);max-height:320px;margin:6px -4px -1px;object-fit:cover;border-radius:12px}.message-status{margin:3px 5px 1px;color:#8b98a5;font-size:9px;font-weight:400;line-height:1.3;opacity:.85}.message-status.failed,.caption-meta.failed{color:#dc2626}.message-status button,.caption-meta button{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:650}.message-bubble :deep(.post-image-preview){margin:-9px -12px}.message-bubble :deep(.carousel-shell){border-radius:16px}.media-caption-bubble{width:min(260px,65vw);padding:0}.media-caption-bubble .optimistic-image{width:100%;max-height:320px;margin:0;border-radius:0}.media-caption-bubble :deep(.post-image-preview){margin:0}.media-caption-bubble :deep(.carousel-shell){margin:0;border-radius:0}.caption-area{padding:8px 10px 7px}.caption-meta{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:2px;color:#718096;font-size:9px;line-height:1.3;white-space:nowrap}
.selected-image{position:relative;width:70px;height:70px;margin:6px 14px}.selected-image img{width:100%;height:100%;object-fit:cover;border-radius:10px}.selected-image button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:#263241;color:#fff}
.recording-panel,.recorded-audio{display:flex;align-items:center;gap:10px;margin:6px 12px;padding:9px 12px;border:1px solid #e2e8f0;border-radius:14px;background:#fff}.recording-panel strong{margin-right:auto;font-size:13px}.recording-panel button{border:0;background:transparent;color:#536471}.recording-panel .finish-recording{color:#1d9bf0;font-weight:700}.recording-dot{width:9px;height:9px;border-radius:50%;background:#ef4444;animation:recording-pulse 1.2s ease-in-out infinite}.recorded-audio :deep(.voice-message){flex:1}.recorded-audio>button{width:28px;height:28px;border:0;border-radius:50%;background:#eff3f4;color:#536471}.voice-error{margin:2px 16px;color:#dc2626;font-size:12px}.audio-bubble{padding:9px 10px}
.chat-composer{display:grid;grid-template-columns:44px 44px minmax(0,1fr) auto;align-items:center;gap:8px;padding:6px 12px calc(18px + env(safe-area-inset-bottom));border-top:0;background:transparent}.chat-composer input[type=text]{min-width:0;height:44px;padding:0 16px;border:1px solid #cfd5db;border-radius:999px;outline:0;background:#fff;box-shadow:0 2px 12px rgba(15,23,42,.08);font-size:16px}.chat-composer input[type=text]:focus{border-color:#1d9bf0;box-shadow:0 2px 12px rgba(29,155,240,.13)}.image-input{display:none}.image-button,.microphone-button,.send-button{height:44px;color:#1d9bf0;font-weight:700}.image-button,.microphone-button{display:grid;width:44px;padding:10px;place-items:center;border:1px solid #cfd5db;border-radius:50%;background:#fff;box-shadow:0 2px 12px rgba(15,23,42,.08)}.image-button svg,.microphone-button svg{display:block;width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.send-button{padding:0 8px;border:0;background:transparent}.chat-composer button:disabled{opacity:.38}
@keyframes recording-pulse{50%{opacity:.35}}
</style>
