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
          <div class="message-bubble">
            <span v-if="messageText(message.content)" class="bubble-text">{{ messageText(message.content) }}</span>
            <PostImagePreview v-if="hasImage(message.content)" :content="message.content" :show-all="true" alt-text="私信图片" />
          </div>
        </div>
      </template>
    </section>

    <div v-if="selectedImage" class="selected-image">
      <img :src="selectedImage.preview" alt="待发送图片" />
      <button type="button" aria-label="移除图片" @click="removeSelectedImage">×</button>
    </div>
    <div v-if="sendError" class="send-error" role="alert">{{ sendError }}</div>
    <form class="chat-composer" @submit.prevent="submitMessage">
      <input ref="imageInput" class="image-input" type="file" accept="image/*" @change="selectImage" />
      <button class="image-button" type="button" aria-label="添加图片" :disabled="!accepted || sending" @click="imageInput?.click()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>
      </button>
      <input v-model="draft" type="text" autocomplete="off" :placeholder="accepted ? '输入消息……' : '仅已接受好友可发送私信'" :disabled="!accepted || sending" />
      <button class="send-button" type="submit" :disabled="!canSend">{{ sending ? '发送中' : '发送' }}</button>
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
import { uploadEncryptedCommentImage } from "@/utils/commentImage";

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
const sending = ref(false);
const sendError = ref("");
const selectedImage = ref<{ file: File; preview: string } | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const messageList = ref<HTMLElement | null>(null);
const canSend = computed(() => accepted.value && !sending.value && (!!draft.value.trim() || !!selectedImage.value));

const hasImage = (content: string) => /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/i.test(content);
const messageText = (content: string) => directMessagePreview(content) === "[图片]" ? "" : directMessagePreview(content);
const isOwn = (message: InboxItem) => message.pubkey === keys.pkHex;
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
async function submitMessage() {
  if (!canSend.value) return;
  sending.value = true;
  sendError.value = "";
  try {
    let content = draft.value.trim();
    if (selectedImage.value) {
      const media = await uploadEncryptedCommentImage(selectedImage.value.file, {
        accountPubkey: keys.pkHex,
        signEvent: keys.signEvent.bind(keys),
      });
      content = `${content}${content ? "\n" : ""}![](${media.ref})`;
    }
    await directMessages.send(peerPubkey.value, content);
    draft.value = "";
    removeSelectedImage();
    scrollToBottom();
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : "发送失败，请重试";
  } finally {
    sending.value = false;
  }
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
.message-list{min-height:0;overflow-y:auto;padding:12px 12px 16px;overscroll-behavior:contain}.relationship-notice,.empty-chat{margin:14px auto;padding:9px 13px;color:#536471;font-size:12px;text-align:center}.message-time{display:block;margin:16px 0 10px;color:#8b98a5;font-size:11px;text-align:center}.message-line{display:flex;align-items:flex-end;gap:6px;margin:3px 0}.message-line.own{justify-content:flex-end}.avatar-slot{display:flex;width:28px;flex:0 0 28px}.message-bubble{max-width:min(76%,430px);padding:9px 12px;border-radius:18px 18px 18px 5px;background:#eff3f4;color:#0f1419;line-height:1.45;overflow:hidden}.message-line.own .message-bubble{border-radius:18px 18px 5px 18px;background:#d9efff}.bubble-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}.message-bubble :deep(.post-image-preview){margin:-9px -12px}.message-bubble :deep(.carousel-shell){border-radius:16px}
.selected-image{position:relative;width:70px;height:70px;margin:6px 14px}.selected-image img{width:100%;height:100%;object-fit:cover;border-radius:10px}.selected-image button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:#263241;color:#fff}.send-error{padding:4px 14px;color:#dc2626;font-size:11px;text-align:center}
.chat-composer{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:6px;padding:7px 10px calc(15px + env(safe-area-inset-bottom));border-top:1px solid #eff1f3;background:#fff}.chat-composer input[type=text]{min-width:0;height:43px;padding:0 14px;border:1px solid #cfd9de;border-radius:999px;outline:0;font-size:16px}.chat-composer input[type=text]:focus{border-color:#1d9bf0}.image-input{display:none}.image-button,.send-button{height:42px;border:0;background:transparent;color:#1d9bf0;font-weight:700}.image-button{width:38px;padding:8px}.image-button svg{display:block;width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.send-button{padding:0 5px}.chat-composer button:disabled{opacity:.38}
</style>
