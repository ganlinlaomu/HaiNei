<template>
  <main class="conversations-page app-page">
    <header class="page-header">
      <h1>私信</h1>
      <span class="conversation-filter">全部<span aria-hidden="true">⌄</span></span>
    </header>

    <label class="conversation-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <input v-model="searchQuery" type="search" placeholder="搜索私信" autocomplete="off" />
    </label>

    <div v-if="conversations.length === 0" class="empty-state">
      <strong>暂无私信</strong>
      <span>开始一段新的私密对话。</span>
    </div>
    <div v-else-if="filteredConversations.length === 0" class="search-empty">未找到相关私信</div>
    <div v-else class="conversation-list">
      <div
        v-for="conversation in filteredConversations"
        :key="conversation.peerPubkey"
        class="conversation-row"
        @touchstart="onTouchStart($event, conversation.peerPubkey)"
        @touchmove="onTouchMove($event, conversation.peerPubkey)"
        @touchend="onTouchEnd(conversation.peerPubkey)"
      >
        <div class="swipe-actions">
          <button class="action hide" type="button" @click.stop="hideConversation(conversation.peerPubkey)">隐藏</button>
          <button class="action delete" type="button" @click.stop="deleteConversation(conversation.peerPubkey)">删除</button>
        </div>
        <button
          class="conversation-main"
          type="button"
          :style="swipeStyle(conversation.peerPubkey)"
          @click="openConversation(conversation.peerPubkey)"
        >
          <ProfileAvatar :pubkey="conversation.peerPubkey" :local-name="localName(conversation.peerPubkey)" :size="48" />
          <span class="conversation-copy">
            <strong>{{ displayName(conversation.peerPubkey) }}</strong>
            <span class="preview">{{ preview(conversation.latest) }}</span>
          </span>
          <span class="conversation-meta">
            <time>{{ formatRelativeTime(conversation.latest.created_at) }}</time>
            <span v-if="conversation.unread" class="unread-badge" :aria-label="`${conversation.unread} 条未读私信`">{{ conversation.unread > 99 ? '99+' : conversation.unread }}</span>
          </span>
        </button>
      </div>
    </div>
    <NewConversationSheet
      :visible="ui.showNewConversation"
      @close="ui.closeNewConversation()"
      @select="openConversation"
    />
  </main>
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import NewConversationSheet from "@/components/NewConversationSheet.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { buildDirectConversationSummaries, useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";
import { formatRelativeTime } from "@/utils/format";
import { loadAccountStoresOnce } from "@/utils/bottomTabActivation";

const router = useRouter();
const keys = useKeyStore();
const messages = useMessagesStore();
const directMessages = useDirectMessagesStore();
const friendships = useFriendshipsStore();
const friends = useFriendsStore();
const profiles = useProfilesStore();
const ui = useUIStore();
const searchQuery = ref("");
const SWIPE_ACTION_WIDTH = 120;
const SWIPE_OPEN_THRESHOLD = 60;
const swipe = reactive<Record<string, number>>({});
const startX = reactive<Record<string, number>>({});
const startY = reactive<Record<string, number>>({});
const swipingPeer = ref("");
const horizontalGesture = ref(false);
const conversations = computed(() => buildDirectConversationSummaries(
  directMessages.conversationItems(),
  keys.pkHex,
  directMessages.unreadByConversation,
  { friendshipRecords: friendships.records, preferencesByPeer: directMessages.preferencesByPeer },
));
const localName = (pubkey: string) => friends.list.find(friend => friend.pubkey === pubkey)?.name;
const displayName = (pubkey: string) => privateProfileDisplayName(profiles.getProfile(pubkey)?.nickname, pubkey, localName(pubkey));
const preview = (message: InboxItem) => {
  if (message.outgoing?.state === "uploading") return "[图片] · 上传中…";
  if (message.outgoing?.state === "sending") return message.outgoing.hasImage ? "[图片] · 发送中…" : "消息发送中…";
  if (message.outgoing?.state === "upload_failed" || message.outgoing?.state === "send_failed") return "发送失败";
  return directMessagePreview(message.content) || "新消息";
};
const filteredConversations = computed(() => {
  const needle = searchQuery.value.trim().toLocaleLowerCase();
  if (!needle) return conversations.value;
  return conversations.value.filter(conversation => {
    const friend = friends.list.find(item => item.pubkey === conversation.peerPubkey);
    const profileName = profiles.getProfile(conversation.peerPubkey)?.nickname || "";
    return [displayName(conversation.peerPubkey), friend?.name, friend?.note, profileName]
      .some(value => value?.toLocaleLowerCase().includes(needle));
  });
});

async function load() {
  const account = keys.pkHex;
  if (!account) return;
  await loadAccountStoresOnce(account, [messages, friendships, friends, profiles]);
}
function closeOtherSwipes(pubkey = "") {
  for (const key of Object.keys(swipe)) {
    if (key !== pubkey && swipe[key]) swipe[key] = 0;
  }
}
function openConversation(pubkey: string) {
  if (swipe[pubkey]) {
    swipe[pubkey] = 0;
    return;
  }
  closeOtherSwipes();
  void router.push(`/messages/${pubkey}`);
}
function onTouchStart(e: TouchEvent, pubkey: string) {
  const touch = e.touches[0];
  startX[pubkey] = touch.clientX;
  startY[pubkey] = touch.clientY;
  swipingPeer.value = pubkey;
  horizontalGesture.value = false;
  closeOtherSwipes(pubkey);
}
function onTouchMove(e: TouchEvent, pubkey: string) {
  if (swipingPeer.value !== pubkey) return;
  const touch = e.touches[0];
  const dx = touch.clientX - startX[pubkey];
  const dy = touch.clientY - startY[pubkey];
  if (!horizontalGesture.value) {
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < 6) return;
    horizontalGesture.value = true;
  }
  if (horizontalGesture.value && e.cancelable) e.preventDefault();
  swipe[pubkey] = Math.min(0, Math.max(dx, -SWIPE_ACTION_WIDTH));
}
function onTouchEnd(pubkey: string) {
  if (swipingPeer.value !== pubkey) return;
  swipe[pubkey] = swipe[pubkey] < -SWIPE_OPEN_THRESHOLD ? -SWIPE_ACTION_WIDTH : 0;
  swipingPeer.value = "";
  horizontalGesture.value = false;
}
function swipeStyle(pubkey: string) {
  return { transform: `translateX(${swipe[pubkey] || 0}px)` };
}
async function hideConversation(pubkey: string) {
  swipe[pubkey] = 0;
  await directMessages.hideConversation(pubkey);
}
async function deleteConversation(pubkey: string) {
  swipe[pubkey] = 0;
  if (!window.confirm("仅删除当前设备/当前账号中的聊天记录，无法撤回对方或 Relay 上的消息。")) return;
  await directMessages.deleteConversation(pubkey);
}

onMounted(load);
onActivated(load);
onDeactivated(() => {
  closeOtherSwipes();
  ui.closeNewConversation();
});
</script>

<style scoped>
.conversations-page{width:100%;min-height:100%;margin:0 auto;box-sizing:border-box;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 28px);background:#fff;color:#0f1419}
.page-header{position:sticky;top:0;z-index:4;display:flex;align-items:center;justify-content:space-between;min-height:54px;padding:0 16px;background:rgba(255,255,255,.97)}.page-header h1{margin:0;font-size:21px;font-weight:750}.conversation-filter{display:flex;align-items:center;gap:2px;color:#536471;font-size:14px;font-weight:600}.conversation-filter span{font-size:16px;line-height:1;transform:translateY(-1px)}
.conversation-search{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;gap:9px;margin:4px 16px 10px;padding:0 13px;border-radius:999px;background:#eff3f4;color:#536471}.conversation-search svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.conversation-search input{width:100%;height:42px;padding:0;border:0;outline:0;background:transparent;color:#0f1419;font-size:15px}.conversation-search input::placeholder{color:#536471}
.conversation-list{display:flex;width:100%;flex-direction:column;border-top:1px solid #eff1f3}.conversation-row{position:relative;width:100%;min-height:72px;overflow:hidden;border-bottom:1px solid #eff1f3;background:#fff;color:#0f1419;touch-action:pan-y}.swipe-actions{position:absolute;inset:0 0 0 auto;display:flex;width:120px}.action{width:60px;border:0;color:#fff;font-size:12px;font-weight:650}.action.hide{background:#536471}.action.delete{background:#f4212e}.conversation-main{position:relative;z-index:1;display:grid;width:100%;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0;min-height:72px;padding:11px 16px;border:0;background:#fff;color:inherit;text-align:left;cursor:pointer;transition:transform .2s ease}.conversation-main:active{background:#f7f9f9}.conversation-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.conversation-copy strong,.preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-copy strong{font-size:15px}.preview{color:#536471;font-size:13px}.conversation-meta{display:flex;align-items:flex-end;gap:7px;flex-direction:column;color:#536471;font-size:11px}.unread-badge{display:grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#1d9bf0;color:#fff;font-size:10px;font-weight:700}
.empty-state{display:flex;min-height:44vh;align-items:center;justify-content:center;flex-direction:column;gap:7px;padding:24px;color:#536471;text-align:center}.empty-state strong{color:#0f1419;font-size:19px}.empty-state span{font-size:14px}.search-empty{padding:48px 20px;color:#536471;font-size:14px;text-align:center}
</style>
