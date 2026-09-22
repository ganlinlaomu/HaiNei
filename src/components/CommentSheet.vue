<template>
  <Teleport to="body">
    <Transition name="comment-sheet">
      <div
        v-if="visible"
        ref="dialog"
        class="comment-sheet-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comment-sheet-title"
        tabindex="-1"
        @click.self="close"
        @keydown.esc.stop="close"
      >
        <section class="comment-sheet-panel" :style="panelStyle">
          <div
            class="drag-handle-area"
            aria-hidden="true"
            @pointerdown="startDrag"
            @pointermove="moveDrag"
            @pointerup="endDrag"
            @pointercancel="endDrag"
          ><span></span></div>
          <header class="comment-sheet-header">
            <h2 id="comment-sheet-title">评论</h2>
            <button type="button" aria-label="关闭评论" @click="close">×</button>
          </header>

          <div ref="commentBody" class="comment-sheet-body">
            <div v-if="!threads.length" class="empty-comments">暂无评论</div>
            <article v-for="thread in threads" :key="thread.root.id" class="comment-thread">
              <CommentRow :comment="thread.root" @reply="startReply" />
              <div v-for="reply in thread.replies" :key="reply.id" class="comment-reply">
                <CommentRow :comment="reply" @reply="startReply" />
              </div>
            </article>
          </div>

          <div v-if="replyTarget" class="reply-target">
            <span>回复 @{{ displayName(replyTarget.author) }}</span>
            <button type="button" aria-label="取消回复" @click="cancelReply">×</button>
          </div>
          <form class="comment-composer" @submit.prevent="submitComment">
            <ProfileAvatar :pubkey="keys.pkHex" local-name="自己" :size="34" />
            <input
              ref="composer"
              v-model="draft"
              type="text"
              autocomplete="off"
              :placeholder="replyTarget ? `回复 @${displayName(replyTarget.author)}` : '添加评论...'"
              aria-label="添加评论"
            />
            <button type="submit" :disabled="sending || !draft.trim()">{{ sending ? "发送中" : "发送" }}</button>
          </form>
          <div v-if="sendError" class="send-error" role="alert">发送失败，内容已保留，请重试</div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, watch, type PropType } from "vue";
import type { InboxItem } from "@/stores/messages";
import type { Comment } from "@/stores/interactions";
import { useInteractionsStore } from "@/stores/interactions";
import { useFriendsStore } from "@/stores/friends";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { formatRelativeTime } from "@/utils/format";
import { buildCommentSubmission, commentDraftAfterSend, buildCommentThreads } from "@/utils/commentThreads";
import { openProfile } from "@/utils/profileNavigation";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";

const props = defineProps<{ visible: boolean; message: InboxItem; targetCommentId?: string }>();
const emit = defineEmits<{ close: [] }>();
const interactions = useInteractionsStore();
const friends = useFriendsStore();
const keys = useKeyStore();
const profiles = useProfilesStore();
const router = useRouter();
const dialog = ref<HTMLElement | null>(null);
const commentBody = ref<HTMLElement | null>(null);
const composer = ref<HTMLInputElement | null>(null);
const draft = ref("");
const replyTarget = ref<Comment | null>(null);
const sending = ref(false);
const sendError = ref(false);
const dragY = ref(0);
const threads = computed(() => buildCommentThreads(interactions.getComments(props.message.id)));
const panelStyle = computed(() => ({ transform: `translateY(${dragY.value}px)` }));

function localName(pubkey: string) {
  if (pubkey === keys.pkHex) return "自己";
  return friends.list.find(friend => friend.pubkey === pubkey)?.name;
}
function displayName(pubkey: string) {
  return privateProfileDisplayName(profiles.getProfile(pubkey)?.nickname, pubkey, localName(pubkey));
}
function navigateProfile(pubkey: string, event?: Event) {
  close();
  return openProfile(router, keys.pkHex, pubkey, event);
}

const CommentRow = defineComponent({
  props: { comment: { type: Object as PropType<Comment>, required: true } },
  emits: ["reply"],
  setup(rowProps, { emit: rowEmit }) {
    return () => h("div", { id: `comment-${rowProps.comment.id}`, class: ["comment-row", { highlight: props.targetCommentId === rowProps.comment.id }] }, [
      h("button", { class: "comment-avatar", type: "button", "aria-label": `查看 ${displayName(rowProps.comment.author)} 的资料`, onClick: (event: Event) => navigateProfile(rowProps.comment.author, event) }, [
        h(ProfileAvatar, { pubkey: rowProps.comment.author, localName: localName(rowProps.comment.author), size: 34 })
      ]),
      h("div", { class: "comment-copy" }, [
        h("button", { class: "comment-name", type: "button", onClick: (event: Event) => navigateProfile(rowProps.comment.author, event) }, displayName(rowProps.comment.author)),
        h("div", { class: "comment-text" }, rowProps.comment.text),
        h("div", { class: "comment-meta" }, [
          h("span", formatRelativeTime(rowProps.comment.timestamp)),
          h("span", " · "),
          h("button", { type: "button", onClick: () => rowEmit("reply", rowProps.comment) }, "回复"),
          rowProps.comment.pending ? h("span", { class: "pending" }, "发送中…") : null,
          rowProps.comment.failed ? h("span", { class: "failed" }, "发送失败") : null
        ])
      ])
    ]);
  }
});

function close() { emit("close"); }
function startReply(comment: Comment) {
  replyTarget.value = comment;
  sendError.value = false;
  void nextTick(() => composer.value?.focus());
}
function cancelReply() { replyTarget.value = null; }
async function submitComment() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  sendError.value = false;
  const target = replyTarget.value;
  const submission = buildCommentSubmission(props.message.id, props.message.pubkey, text, target);
  try {
    await interactions.sendComment(
      submission.messageId,
      submission.recipientPubkey,
      submission.text,
      submission.parentCommentId
    );
    draft.value = commentDraftAfterSend(draft.value, true);
    replyTarget.value = null;
  } catch {
    draft.value = commentDraftAfterSend(draft.value, false);
    sendError.value = true;
  } finally {
    sending.value = false;
  }
}

let dragStartY = 0;
function startDrag(event: PointerEvent) {
  dragStartY = event.clientY;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function moveDrag(event: PointerEvent) { dragY.value = Math.max(0, event.clientY - dragStartY); }
function endDrag() {
  if (dragY.value > 80) close();
  dragY.value = 0;
}

function focusTarget() {
  void nextTick(() => {
    dialog.value?.focus();
    const target = props.targetCommentId ? document.getElementById(`comment-${props.targetCommentId}`) : null;
    target?.scrollIntoView({ block: "center" });
  });
}
watch(() => props.visible, visible => {
  if (visible) focusTarget();
  else {
    replyTarget.value = null;
    sendError.value = false;
    dragY.value = 0;
  }
});
watch([threads, () => props.targetCommentId], () => { if (props.visible) focusTarget(); });
onBeforeUnmount(() => {
  replyTarget.value = null;
});
</script>

<style scoped>
.comment-sheet-backdrop{position:fixed;inset:0;z-index:12000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.42);touch-action:none}
.comment-sheet-panel{width:min(100%,720px);height:min(82dvh,760px);display:flex;flex-direction:column;border-radius:18px 18px 0 0;background:#fff;box-shadow:0 -12px 38px rgba(15,23,42,.2);transition:transform 160ms ease;overflow:hidden;touch-action:auto}
.drag-handle-area{display:grid;place-items:center;height:24px;flex:0 0 24px;touch-action:none}.drag-handle-area span{width:38px;height:4px;border-radius:999px;background:#cbd5e1}
.comment-sheet-header{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:44px;padding-left:44px;border-bottom:1px solid #e2e8f0}.comment-sheet-header h2{margin:0;text-align:center;font-size:16px}.comment-sheet-header button{width:44px;height:44px;border:0;background:transparent;color:#64748b;font-size:24px}
.comment-sheet-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 14px}.empty-comments{padding:56px 0;text-align:center;color:#94a3b8}
.comment-thread{padding:8px 0}.comment-reply{margin-left:42px}.comment-row{display:grid;grid-template-columns:38px minmax(0,1fr);gap:9px;padding:7px 4px;border-radius:10px}.comment-row.highlight{animation:comment-highlight 1.6s ease}.comment-avatar,.comment-name{padding:0;border:0;background:transparent;color:inherit;cursor:pointer}.comment-avatar{width:38px;height:38px;display:grid;place-items:center}.comment-name{font-weight:700;text-align:left}.comment-copy{min-width:0;font-size:13px}.comment-text{margin-top:2px;line-height:1.45;overflow-wrap:anywhere}.comment-meta{display:flex;align-items:center;gap:2px;margin-top:5px;color:#94a3b8;font-size:11px}.comment-meta button{padding:3px;border:0;background:transparent;color:#64748b;font-weight:600}.pending{margin-left:6px}.failed{margin-left:6px;color:#dc2626}
.reply-target{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 14px;background:#eff6ff;color:#2563eb;font-size:12px}.reply-target button{width:30px;height:30px;border:0;background:transparent;color:inherit}
.comment-composer{display:grid;grid-template-columns:36px minmax(0,1fr) auto;align-items:center;gap:8px;padding:9px 12px calc(9px + env(safe-area-inset-bottom));border-top:1px solid #e2e8f0;background:#fff}.comment-composer input{min-width:0;height:40px;padding:0 13px;border:1px solid #dbe3ec;border-radius:999px;font-size:16px}.comment-composer button{min-width:50px;height:40px;border:0;background:transparent;color:#2563eb;font-weight:700}.comment-composer button:disabled{opacity:.45}.send-error{padding:0 14px calc(6px + env(safe-area-inset-bottom));color:#dc2626;font-size:11px;text-align:center}
.comment-sheet-enter-active,.comment-sheet-leave-active{transition:opacity 180ms ease}.comment-sheet-enter-active .comment-sheet-panel,.comment-sheet-leave-active .comment-sheet-panel{transition:transform 180ms ease}.comment-sheet-enter-from,.comment-sheet-leave-to{opacity:0}.comment-sheet-enter-from .comment-sheet-panel,.comment-sheet-leave-to .comment-sheet-panel{transform:translateY(100%)}
@keyframes comment-highlight{0%,55%{background:#fef3c7}100%{background:transparent}}
@media(min-width:720px){.comment-sheet-backdrop{align-items:center}.comment-sheet-panel{height:min(82vh,760px);border-radius:18px}.drag-handle-area{display:none}}
@media(prefers-reduced-motion:reduce){.comment-sheet-panel,.comment-sheet-enter-active,.comment-sheet-leave-active{transition:none}.comment-row.highlight{animation:none;background:#fef3c7}}
</style>
