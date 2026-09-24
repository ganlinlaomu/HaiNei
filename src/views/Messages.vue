<template>
  <main class="chat-page">
    <header class="chat-header">
      <button type="button" class="back-button" aria-label="返回私信列表" @click="router.back()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <ProfileAvatar :pubkey="peerPubkey" :local-name="localName" :size="34" />
      <strong>{{ displayName }}</strong>
    </header>

    <section ref="messageList" class="message-list" aria-live="polite">
      <div v-if="!accepted" class="relationship-notice">已不是已接受的好友，无法发送新消息。</div>
      <div v-if="accepted && messages.length === 0" class="empty-chat">开始一段私密对话</div>
      <template v-for="(message, index) in messages" :key="message.id">
        <time v-if="showTimestamp(index)" class="message-time">{{ formatMessageTime(message.created_at) }}</time>
        <div class="message-line" :class="{ own: isOwn(message) }">
          <span v-if="!isOwn(message)" class="avatar-slot">
            <ProfileAvatar v-if="showAvatar(index)" :pubkey="peerPubkey" :local-name="localName" :size="28" />
          </span>
          <div class="message-stack">
            <div class="message-bubble">
              <span v-if="messageText(message.content)" class="bubble-text">{{ messageText(message.content) }}</span>
              <img v-if="message.outgoing?.imagePreviewUrl" :src="message.outgoing.imagePreviewUrl" class="optimistic-image" alt="待发送私信图片" />
              <PostImagePreview v-else-if="hasImage(message.content)" :content="message.content" :show-all="true" alt-text="私信图片" />
            </div>
            <span v-if="isOwn(message) && message.outgoing" class="message-status" :class="{ failed: isFailed(message) }">
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
    <form class="chat-composer" @submit.prevent="submitMessage">
      <input ref="imageInput" class="image-input" type="file" accept="image/*" @change="selectImage" />
      <button class="image-button" type="button" aria-label="添加图片" :disabled="!accepted || !keys.pkHex" @click="imageInput?.click()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>
      </button>
      <input v-model="draft" type="text" autocomplete="off" :placeholder="accepted ? '输入消息……' : '仅已接受好友可发送私信'" :disabled="!accepted || !keys.pkHex" />
      <button class="send-button" type="submit" :disabled="!canSend">发送</button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import PostImagePreview from "@/components/PostImagePreview.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";

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
const draft = ref("");
const selectedImage = ref<{ file: File; preview: string } | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const messageList = ref<HTMLElement | null>(null);
const canSend = computed(() => !!keys.pkHex && accepted.value && (!!draft.value.trim() || !!selectedImage.value));

const hasImage = (content: string) => /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/i.test(content);
const messageText = (content: string) => directMessagePreview(content) === "[图片]" ? "" : directMessagePreview(content);
const isOwn = (message: InboxItem) => message.pubkey === keys.pkHex;
const isFailed = (message: InboxItem) => message.outgoing?.state === "upload_failed" || message.outgoing?.state === "send_failed";
function statusLabel(message: InboxItem) {
  switch (message.outgoing?.state) {
    case "uploading": return "上传中…";
    case "sending": return "发送中…";
    case "sent": return "✔️ 已发送";
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
function scrollToBottom() { void nextTick(() => { if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight; }); }

async function load() {
  const account = keys.pkHex;
  if (!account || peerPubkey.value === account) return void router.replace("/conversations");
  await Promise.all([messageStore.load(account), directMessages.refresh(account), friendships.load(account), friends.load(account), profiles.load(account)]);
  await directMessages.markPeerRead(peerPubkey.value);
  scrollToBottom();
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
function submitMessage() {
  if (!canSend.value) return;
  const text = draft.value;
  const image = selectedImage.value?.file;
  try {
    directMessages.send(peerPubkey.value, text, image);
    draft.value = "";
    removeSelectedImage();
    scrollToBottom();
  } catch {}
}

onMounted(load);
watch([() => keys.pkHex, peerPubkey], load);
watch(() => `${messageStore.inbox.length}:${messageStore.inbox[0]?.id || ""}`, async () => {
  await directMessages.refresh(keys.pkHex);
  await directMessages.markPeerRead(peerPubkey.value);
  scrollToBottom();
});
onBeforeUnmount(removeSelectedImage);
</script>

<style scoped>
.chat-page{position:fixed;inset:0;z-index:1000;display:grid;width:100%;max-width:none;margin:0;box-sizing:border-box;grid-template-rows:auto minmax(0,1fr) auto auto;background:#fff;color:#0f1419}
.chat-header{display:grid;grid-template-columns:38px 34px minmax(0,1fr);align-items:center;gap:8px;min-height:54px;padding:0 12px;border-bottom:1px solid #eff1f3;background:#fff}.back-button{display:grid;width:38px;height:42px;padding:8px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419}.back-button:active{background:#eff3f4}.back-button svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.chat-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}
.message-list{min-height:0;overflow-y:auto;padding:12px 12px 16px;overscroll-behavior:contain}.relationship-notice,.empty-chat{margin:14px auto;padding:9px 13px;color:#536471;font-size:12px;text-align:center}.message-time{display:block;margin:16px 0 10px;color:#8b98a5;font-size:11px;text-align:center}.message-line{display:flex;align-items:flex-end;gap:6px;margin:3px 0}.message-line.own{justify-content:flex-end}.avatar-slot{display:flex;width:28px;flex:0 0 28px}.message-stack{display:flex;max-width:min(76%,430px);align-items:flex-end;flex-direction:column}.message-line:not(.own) .message-stack{align-items:flex-start}.message-bubble{max-width:100%;padding:9px 12px;border-radius:18px 18px 18px 5px;background:#eff3f4;color:#0f1419;line-height:1.45;overflow:hidden}.message-line.own .message-bubble{border-radius:18px 18px 5px 18px;background:#d9efff}.bubble-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}.optimistic-image{display:block;width:min(260px,65vw);max-height:320px;margin:6px -4px -1px;object-fit:cover;border-radius:12px}.message-status{margin:3px 5px 1px;color:#8b98a5;font-size:10px;line-height:1.3}.message-status.failed{color:#dc2626}.message-status button{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:650}.message-bubble :deep(.post-image-preview){margin:-9px -12px}.message-bubble :deep(.carousel-shell){border-radius:16px}
.selected-image{position:relative;width:70px;height:70px;margin:6px 14px}.selected-image img{width:100%;height:100%;object-fit:cover;border-radius:10px}.selected-image button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:#263241;color:#fff}
.chat-composer{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:8px;padding:6px 12px calc(12px + env(safe-area-inset-bottom));border-top:0;background:transparent}.chat-composer input[type=text]{min-width:0;height:44px;padding:0 16px;border:1px solid #cfd5db;border-radius:999px;outline:0;background:#fff;box-shadow:0 2px 12px rgba(15,23,42,.08);font-size:16px}.chat-composer input[type=text]:focus{border-color:#1d9bf0;box-shadow:0 2px 12px rgba(29,155,240,.13)}.image-input{display:none}.image-button,.send-button{height:44px;color:#1d9bf0;font-weight:700}.image-button{display:grid;width:44px;padding:10px;place-items:center;border:1px solid #cfd5db;border-radius:50%;background:#fff;box-shadow:0 2px 12px rgba(15,23,42,.08)}.image-button svg{display:block;width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.send-button{padding:0 8px;border:0;background:transparent}.chat-composer button:disabled{opacity:.38}
</style>
