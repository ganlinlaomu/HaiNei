<template>
  <article ref="root" :id="`msg-${message.id}`" class="post-card" :class="{ 'force-flat': flat }">
    <header class="post-author">
      <button class="profile-link avatar-link" type="button" :aria-label="`查看 ${displayName(message.pubkey)} 的资料`" @pointerdown="preloadProfile" @focus="preloadProfile" @click="openAuthor(message.pubkey, $event)">
        <ProfileAvatar :pubkey="message.pubkey" :local-name="localName(message.pubkey)" :size="38" />
      </button>
      <div class="author-copy">
        <button class="profile-link name-link" type="button" @pointerdown="preloadProfile" @focus="preloadProfile" @click="openAuthor(message.pubkey, $event)">{{ displayName(message.pubkey) }}</button>
        <div class="author-meta">
          <time :datetime="new Date(message.created_at * 1000).toISOString()">{{ formatRelativeTime(message.created_at) }}</time>
          <template v-if="isOwn && message._localMeta">
            <span class="meta-separator" aria-hidden="true">·</span>
            <button class="audience-link" type="button" :aria-expanded="metaOpen" @click="toggleMeta">{{ visibilityLabel }}</button>
          </template>
        </div>
      </div>
      <div class="overflow-wrap">
        <button class="overflow-button" type="button" aria-label="动态操作" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">•••</button>
        <div v-if="menuOpen" class="overflow-menu">
          <button v-if="isOwn" type="button" @click="deleteOwnPost">删除此动态</button>
          <button v-else type="button" @click="hidePost">隐藏此动态</button>
          <button v-if="!isOwn" type="button" @click="muteAuthor">不看此人的动态</button>
          <button type="button" @click="copyText">复制文字</button>
        </div>
      </div>
    </header>
    <div v-if="cleanText" class="message-text">
      <MentionText :text="displayedText" /><button v-if="isLong" class="text-button" type="button" @click="expanded = !expanded">{{ expanded ? "收起" : "全文" }}</button>
    </div>
    <PostImagePreview v-if="hasImages" :content="message.content" :show-all="true" @double-like="likeFromImage" />
    <VideoPlayer v-if="video" :video-data="video" />
    <div class="actions">
      <button class="action icon-action" :class="{ liked }" type="button" :aria-label="liked ? '取消点赞' : '点赞'" :aria-pressed="liked" @click="toggleLike">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg>
        <span v-if="likeCount">{{ likeCount }}</span>
      </button>
      <button class="action icon-action" type="button" aria-label="评论" :aria-expanded="commentsOpen" @pointerdown="preloadComments" @focus="preloadComments" @click="toggleComments">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.6 9.6 0 0 1-4-.9L3 21l1.7-4.2A8.2 8.2 0 0 1 3 11.5a8.5 8.5 0 0 1 9-8.5 8.5 8.5 0 0 1 9 8.5Z"/></svg>
        <span v-if="commentCount">{{ commentCount }}</span>
      </button>
      <button class="action icon-action bookmark" :class="{ saved: bookmarked }" type="button" :aria-label="bookmarked ? '取消收藏' : '收藏'" :aria-pressed="bookmarked" @click="toggleBookmark">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>
      </button>
    </div>
    <div v-if="metaOpen" class="panel">
      <div class="muted">对谁可见:</div>
      <div v-for="group in message._localMeta?.groups || []" :key="group.name" class="meta-row"><span>{{ group.name }}</span><span>{{ group.count }} 人</span></div>
    </div>
    <CommentSheet
      v-if="commentsOpen"
      :visible="commentsOpen"
      :message="message"
      :target-comment-id="openCommentId"
      @close="closeComments"
    />
  </article>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { InboxItem } from "@/stores/messages";
import { useFriendsStore } from "@/stores/friends";
import { useInteractionsStore } from "@/stores/interactions";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { formatRelativeTime } from "@/utils/format";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { extractVideoData, getVideoUrlRemovalPatterns } from "@/utils/videoUtils";
import { openProfile } from "@/utils/profileNavigation";
import { useRouter } from "vue-router";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { useBookmarksStore } from "@/stores/bookmarks";
import ProfileAvatar from "./ProfileAvatar.vue";
import MentionText from "./MentionText.vue";
import { shouldSendDoubleTapLike } from "@/utils/feedCarousel";
import { extractImageUrls } from "@/utils/extractImageUrls";
import { loadProfileView } from "@/router/lazyViews";
import { feedScrollAfterSheetClose } from "@/utils/commentThreads";

const loadCommentSheet = () => import("./CommentSheet.vue");
const PostImagePreview = defineAsyncComponent(() => import("./PostImagePreview.vue"));
const VideoPlayer = defineAsyncComponent(() => import("./VideoPlayer.vue"));
const CommentSheet = defineAsyncComponent(loadCommentSheet);

const props = withDefaults(defineProps<{ message: InboxItem; openCommentId?: string; flat?: boolean }>(), { flat: false });
const emit = defineEmits<{ height: [id: string, height: number] }>();
const keys = useKeyStore(); const friends = useFriendsStore(); const interactions = useInteractionsStore(); const ui = useUIStore();
const profiles = useProfilesStore();
const router = useRouter();
const feedPreferences = useFeedPreferencesStore();
const bookmarks = useBookmarksStore();
const root = ref<HTMLElement | null>(null); const expanded = ref(false); const commentsOpen = ref(false); const metaOpen = ref(false);
const menuOpen = ref(false);
const patterns = getVideoUrlRemovalPatterns();
const cleanText = computed(() => (props.message.content || "")
  .replace(/!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi, "")
  .replace(/https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)]*)?/gi, "")
  .replace(/\[video:(\{[^\]]+\})\]/g, "").replace(patterns.youtubePattern, "").replace(patterns.vimeoPattern, "").replace(patterns.directVideoPattern, "")
  .replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
const isLong = computed(() => Array.from(cleanText.value).length > 280 || cleanText.value.split("\n").length > 6);
const displayedText = computed(() => !isLong.value || expanded.value ? cleanText.value : `${Array.from(cleanText.value.split("\n").slice(0, 6).join("\n")).slice(0, 280).join("").trimEnd()}…`);
const hasImages = computed(() => extractImageUrls(props.message.content || "").length > 0);
const video = computed(() => extractVideoData(props.message.content));
const liked = computed(() => !!keys.pkHex && interactions.isLikedByUser(props.message.id, keys.pkHex));
const likeCount = computed(() => interactions.getLikeCount(props.message.id)); const commentCount = computed(() => interactions.getCommentCount(props.message.id));
const isOwn = computed(() => props.message.pubkey === keys.pkHex);
const bookmarked = computed(() => bookmarks.isBookmarked(props.message.id));
const visibilityLabel = computed(() => {
  const groups = props.message._localMeta?.groups || [];
  if (groups.length === 0) return "仅自己可见";
  if (groups.length === 1 && groups[0].name === "全部好友") return "全部好友";
  return `${props.message._localMeta?.groupCount || groups.length} 个分组`;
});
function localName(pubkey: string) { if (pubkey === keys.pkHex) return "自己"; return friends.list.find(friend => friend.pubkey === pubkey)?.name; }
function displayName(pubkey: string) { return privateProfileDisplayName(profiles.getProfile(pubkey)?.nickname, pubkey, localName(pubkey)); }
function preloadProfile() { void loadProfileView(); }
function openAuthor(pubkey: string, event?: Event) {
  preloadProfile();
  return openProfile(router, keys.pkHex, pubkey, event);
}
async function hidePost() { menuOpen.value = false; await feedPreferences.hide(props.message.id); ui.addToast("已在本机隐藏", 1600, "success"); }
async function muteAuthor() { menuOpen.value = false; await feedPreferences.mute(props.message.pubkey); ui.addToast("已在本机隐藏该好友的动态", 1800, "success"); }
async function deleteOwnPost() {
  menuOpen.value = false;
  try { await feedPreferences.tombstoneOwn(props.message); ui.addToast("已发送删除标记", 1800, "success"); }
  catch { ui.addToast("动态已在本机隐藏，删除标记将稍后重试", 2200, "error"); }
}
async function copyText() {
  menuOpen.value = false;
  try { await navigator.clipboard.writeText(cleanText.value); ui.addToast("已复制", 1200, "success"); }
  catch { ui.addToast("复制失败", 1500, "error"); }
}
async function toggleLike() { try { liked.value ? await interactions.removeLike(props.message.id, props.message.pubkey) : await interactions.sendLike(props.message.id, props.message.pubkey); } catch { ui.addToast("操作失败，请重试", 1800, "error"); } }
let imageLikePending = false;
async function likeFromImage() {
  if (!shouldSendDoubleTapLike(liked.value, imageLikePending)) return;
  imageLikePending = true;
  try { await interactions.sendLike(props.message.id, props.message.pubkey); }
  catch { ui.addToast("点赞失败，请重试", 1800, "error"); }
  finally { imageLikePending = false; }
}
async function toggleBookmark() {
  try {
    const saved = await bookmarks.toggle(props.message.id);
    ui.addToast(saved ? "已添加到收藏夹" : "已从收藏夹移除", 1700, "success");
  }
  catch { ui.addToast("收藏失败，请重试", 1800, "error"); }
}
let feedScrollTop = 0;
let sheetRoute = "";
function feedScroller() { return document.querySelector("body > #app") as HTMLElement | null; }
function openComments() {
  if (!commentsOpen.value) {
    feedScrollTop = feedScroller()?.scrollTop || 0;
    sheetRoute = router.currentRoute.value.fullPath;
  }
  metaOpen.value = false;
  commentsOpen.value = true;
}
function preloadComments() { void loadCommentSheet(); }
function toggleComments() { openComments(); }
function closeComments() {
  commentsOpen.value = false;
  void nextTick(() => {
    const scroller = feedScroller();
    if (scroller && router.currentRoute.value.fullPath === sheetRoute) {
      scroller.scrollTop = feedScrollAfterSheetClose(feedScrollTop);
    }
  });
}
function toggleMeta() { if (commentsOpen.value) closeComments(); metaOpen.value = !metaOpen.value; }
watch(() => props.openCommentId, value => { if (value) openComments(); }, { immediate: true });
let observer: ResizeObserver | null = null;
onMounted(() => { if (!root.value || typeof ResizeObserver === "undefined") return; observer = new ResizeObserver(entries => emit("height", props.message.id, entries[0]?.contentRect.height || 0)); observer.observe(root.value); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.post-card{background:#fff;padding:14px 16px 12px;border:0;border-bottom:1px solid #edf1f5;border-radius:0;box-shadow:none}
.post-author{display:flex;align-items:center;gap:10px;position:relative}.author-copy{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.author-meta{display:flex;min-width:0;align-items:center;gap:4px;color:#8b98a5;font-size:12px;line-height:1.25}.author-copy time,.muted{color:#8b98a5;font-size:12px}.meta-separator{color:#b0bac4}.audience-link{max-width:160px;padding:0;border:0;background:transparent;color:#8b98a5;font:inherit;font-size:12px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.audience-link:active{color:#475569}
.profile-link,.comment-author{padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.avatar-link{display:grid;place-items:center;min-width:44px;min-height:44px;margin:-3px}.name-link{min-height:23px;font-size:14px;font-weight:700;text-align:left}.comment-author{min-height:28px;font-weight:700}.profile-link:focus-visible,.comment-author:focus-visible,.audience-link:focus-visible{outline:2px solid #2563eb;outline-offset:2px;border-radius:4px}.overflow-wrap{position:relative;align-self:flex-start}.overflow-button{min-width:40px;min-height:40px;border:0;border-radius:8px;background:transparent;color:#64748b;font-weight:700;letter-spacing:1px}.overflow-menu{position:absolute;z-index:20;top:38px;right:0;min-width:160px;padding:5px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;box-shadow:0 10px 28px rgba(15,23,42,.16)}.overflow-menu button{display:block;width:100%;min-height:42px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:#334155;text-align:left}.overflow-menu button:active{background:#f1f5f9}
.message-text{margin-top:9px;color:#202938;font-size:15px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere}.text-button{display:inline-flex;min-height:28px;align-items:center;margin-left:3px;padding:0 3px;border:0;background:transparent;color:#2563eb;font:inherit;font-size:13px;vertical-align:baseline;cursor:pointer}
.actions{display:flex;align-items:center;gap:10px;margin-top:6px;padding-top:3px;border-top:0}.action{min-width:42px;min-height:42px;padding:7px 8px;border:0;border-radius:9px;background:transparent;color:#334155;font-size:12px}.icon-action{display:inline-flex;align-items:center;justify-content:center;gap:4px}.icon-action svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.action span{font-size:11px;color:#64748b}.action.liked{color:#ef4444}.action.liked svg{fill:currentColor}.action.bookmark.saved{color:#60A5FA}.action.bookmark.saved svg{fill:currentColor}.bookmark{margin-left:auto}
.panel{margin-top:8px;padding:9px 11px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc}.meta-row{display:flex;justify-content:space-between;margin-top:5px;font-size:12px}
@media(min-width:640px){.post-card:not(.force-flat){padding:16px;border:1px solid #e8edf3;border-radius:14px;box-shadow:0 2px 8px rgba(15,23,42,.035)}.post-card:not(.force-flat) .actions{padding-top:6px;border-top:1px solid #f1f5f9}.post-card:not(.force-flat) .message-text{line-height:1.62}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
