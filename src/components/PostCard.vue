<template>
  <article ref="root" :id="`msg-${message.id}`" class="post-card">
    <header class="post-author">
      <div class="author-avatar" :style="{ backgroundColor: avatarColor(message.pubkey) }" aria-hidden="true">{{ avatarInitial(message.pubkey) }}</div>
      <div class="author-copy"><strong>{{ displayName(message.pubkey) }}</strong><time :datetime="new Date(message.created_at * 1000).toISOString()">{{ formatRelativeTime(message.created_at) }}</time></div>
    </header>
    <div v-if="cleanText" class="message-text">
      {{ displayedText }}
      <button v-if="isLong" class="text-button" type="button" @click="expanded = !expanded">{{ expanded ? "收起" : "全文" }}</button>
    </div>
    <PostImagePreview v-if="message.content" :content="message.content" :show-all="true" />
    <VideoPlayer v-if="video" :video-data="video" />
    <div class="actions">
      <button class="action" :class="{ liked }" type="button" :aria-pressed="liked" @click="toggleLike">{{ liked ? "已赞" : "赞" }} <span v-if="likeCount">{{ likeCount }}</span></button>
      <button class="action" type="button" :aria-expanded="commentsOpen" @click="toggleComments">评论 <span v-if="commentCount">{{ commentCount }}</span></button>
      <button v-if="isOwn && message._localMeta?.groupCount" class="action visibility" type="button" :aria-expanded="metaOpen" @click="toggleMeta">{{ visibilityLabel }}</button>
    </div>
    <div v-if="metaOpen" class="panel">
      <div class="muted">对谁可见:</div>
      <div v-for="group in message._localMeta?.groups || []" :key="group.name" class="meta-row"><span>{{ group.name }}</span><span>{{ group.count }} 人</span></div>
    </div>
    <section v-if="commentsOpen" class="comments-section">
      <div class="comments-list">
        <div v-for="comment in rootComments" :key="comment.id" class="thread">
          <div :id="`comment-${comment.id}`" class="comment-item">
            <div class="comment-header"><strong>{{ displayName(comment.author) }}</strong><span class="muted"> · {{ formatRelativeTime(comment.timestamp) }}</span></div>
            <div class="comment-text">{{ comment.text }}</div>
            <span v-if="comment.pending" class="pending">发送中…</span>
            <button class="reply" type="button" @click="startReply(comment.id, comment.author)">回复</button>
          </div>
          <div v-if="replies(comment.id).length" class="replies">
            <div v-for="reply in replies(comment.id)" :key="reply.id" class="comment-item reply-item">
              <div><strong>{{ displayName(reply.author) }}</strong><span class="muted"> · {{ formatRelativeTime(reply.timestamp) }}</span></div>
              <div class="comment-text">{{ reply.text }}</div><span v-if="reply.pending" class="pending">发送中…</span>
            </div>
          </div>
        </div>
        <div v-if="!rootComments.length" class="muted">暂无评论</div>
      </div>
      <div v-if="replyingTo" class="replying"><span>正在回复…</span><button type="button" @click="cancelReply">✕</button></div>
      <div class="input-row"><input v-model="commentInput" :data-message-id="message.id" placeholder="写下你的评论..." @keyup.enter="addComment" /><button type="button" :disabled="!commentInput.trim()" @click="addComment">发送</button></div>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { InboxItem } from "@/stores/messages";
import { useFriendsStore } from "@/stores/friends";
import { useInteractionsStore } from "@/stores/interactions";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { formatRelativeTime } from "@/utils/format";
import { extractVideoData, getVideoUrlRemovalPatterns } from "@/utils/videoUtils";
import PostImagePreview from "./PostImagePreview.vue";
import VideoPlayer from "./VideoPlayer.vue";

const props = defineProps<{ message: InboxItem; openCommentId?: string }>();
const emit = defineEmits<{ height: [id: string, height: number] }>();
const keys = useKeyStore(); const friends = useFriendsStore(); const interactions = useInteractionsStore(); const ui = useUIStore();
const root = ref<HTMLElement | null>(null); const expanded = ref(false); const commentsOpen = ref(false); const metaOpen = ref(false);
const commentInput = ref(""); const replyingTo = ref(""); const replyingAuthor = ref("");
const patterns = getVideoUrlRemovalPatterns();
const cleanText = computed(() => (props.message.content || "")
  .replace(/!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/gi, "")
  .replace(/https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)]*)?/gi, "")
  .replace(/\[video:(\{[^\]]+\})\]/g, "").replace(patterns.youtubePattern, "").replace(patterns.vimeoPattern, "").replace(patterns.directVideoPattern, "")
  .replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
const isLong = computed(() => Array.from(cleanText.value).length > 280 || cleanText.value.split("\n").length > 6);
const displayedText = computed(() => !isLong.value || expanded.value ? cleanText.value : `${Array.from(cleanText.value.split("\n").slice(0, 6).join("\n")).slice(0, 280).join("").trimEnd()}…`);
const video = computed(() => extractVideoData(props.message.content));
const liked = computed(() => !!keys.pkHex && interactions.isLikedByUser(props.message.id, keys.pkHex));
const likeCount = computed(() => interactions.getLikeCount(props.message.id)); const commentCount = computed(() => interactions.getCommentCount(props.message.id));
const rootComments = computed(() => interactions.getComments(props.message.id).filter(comment => !comment.parentCommentId));
const isOwn = computed(() => props.message.pubkey === keys.pkHex);
const visibilityLabel = computed(() => { const groups = props.message._localMeta?.groups || []; return groups.length === 1 && groups[0].name === "全部好友" ? "全部好友" : `${props.message._localMeta?.groupCount || groups.length} 个分组`; });
function displayName(pubkey: string) { if (pubkey === keys.pkHex) return "自己"; return friends.list.find(friend => friend.pubkey === pubkey)?.name || `${pubkey.slice(0, 8)}...`; }
function avatarInitial(pubkey: string) { return (displayName(pubkey).trim()[0] || "?").toUpperCase(); }
function avatarColor(pubkey: string) { let hash = 0; for (const char of pubkey) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return `hsl(${Math.abs(hash) % 360} 48% 48%)`; }
async function toggleLike() { try { liked.value ? await interactions.removeLike(props.message.id, props.message.pubkey) : await interactions.sendLike(props.message.id, props.message.pubkey); } catch { ui.addToast("操作失败，请重试", 1800, "error"); } }
function toggleComments() { metaOpen.value = false; commentsOpen.value = !commentsOpen.value; }
function toggleMeta() { commentsOpen.value = false; metaOpen.value = !metaOpen.value; }
function replies(id: string) { return interactions.getReplies(props.message.id, id); }
function startReply(id: string, author: string) { commentsOpen.value = true; replyingTo.value = id; replyingAuthor.value = author; commentInput.value = `@${displayName(author)} `; }
function cancelReply() { replyingTo.value = ""; replyingAuthor.value = ""; commentInput.value = ""; }
async function addComment() { const text = commentInput.value.trim(); if (!text) return; const previous = commentInput.value; const parent = replyingTo.value || undefined; const recipient = replyingAuthor.value || props.message.pubkey; cancelReply(); try { await interactions.sendComment(props.message.id, recipient, text, parent); } catch { commentInput.value = previous; ui.addToast("评论发送失败", 1800, "error"); } }
watch(() => props.openCommentId, value => { if (value) commentsOpen.value = true; }, { immediate: true });
let observer: ResizeObserver | null = null;
onMounted(() => { if (!root.value || typeof ResizeObserver === "undefined") return; observer = new ResizeObserver(entries => emit("height", props.message.id, entries[0]?.contentRect.height || 0)); observer.observe(root.value); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.post-card{background:#fff;padding:14px;border:1px solid #e8edf3;border-radius:14px;box-shadow:0 2px 8px rgba(15,23,42,.035)}
.post-author{display:flex;align-items:center;gap:10px}.author-avatar{width:38px;height:38px;flex:0 0 38px;display:grid;place-items:center;border-radius:50%;color:#fff;font-size:15px;font-weight:700}.author-copy{display:flex;flex-direction:column;gap:2px}.author-copy strong{font-size:14px}.author-copy time,.muted{color:#94a3b8;font-size:12px}
.message-text{margin-top:10px;color:#202938;font-size:15px;line-height:1.62;white-space:pre-wrap;overflow-wrap:anywhere}.text-button,.reply{display:block;min-height:34px;padding:4px 0 0;border:0;background:transparent;color:#2563eb;font:inherit;font-size:13px}
.actions{display:flex;align-items:center;gap:4px;margin-top:12px;padding-top:9px;border-top:1px solid #f1f5f9}.action{min-height:38px;padding:6px 11px;border:0;border-radius:8px;background:transparent;color:#64748b;font-size:14px}.action span{font-size:12px;color:#94a3b8}.action.liked{color:#ef4444}.visibility{margin-left:auto;color:#475569}
.panel,.comments-section{margin-top:10px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc}.meta-row{display:flex;justify-content:space-between;margin-top:6px;font-size:13px}.comments-list{display:flex;flex-direction:column;gap:8px;max-height:300px;overflow:auto;margin-bottom:10px}.thread{display:flex;flex-direction:column;gap:8px}.comment-item{padding:8px;border-radius:7px;background:#fff}.comment-text{font-size:13px;overflow-wrap:anywhere}.reply{min-height:30px;color:#64748b}.replies{display:flex;flex-direction:column;gap:8px;margin-left:24px;padding-left:12px;border-left:2px solid #e2e8f0}.reply-item{border:1px solid #e2e8f0}.pending{font-size:11px;color:#94a3b8}.replying{display:flex;justify-content:space-between;padding:4px 8px;border-radius:6px;background:#eff6ff;color:#1976d2;font-size:12px}.replying button{border:0;background:transparent}.input-row{display:flex;gap:8px;margin-top:8px}.input-row input{flex:1;min-width:0;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:16px}.input-row button{padding:8px 16px;border:0;border-radius:8px;background:#1976d2;color:#fff}.input-row button:disabled{opacity:.5}
@media(min-width:640px){.post-card{padding:16px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
