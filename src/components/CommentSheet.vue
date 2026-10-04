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
        <section ref="panel" class="comment-sheet-panel" :class="{ dragging }" :style="panelStyle">
          <div
            class="drag-handle-area"
            aria-hidden="true"
            @pointerdown="startDrag"
            @pointermove="moveDrag"
            @pointerup="endDrag"
            @pointercancel="cancelDrag"
          ><span></span></div>
          <header
            class="comment-sheet-header"
            @pointerdown="startSurfaceDrag"
            @pointermove="moveSurfaceDrag"
            @pointerup="endSurfaceDrag"
            @pointercancel="cancelDrag"
          >
            <h2 id="comment-sheet-title">评论</h2>
            <button type="button" aria-label="关闭评论" @click="close">×</button>
          </header>

          <div
            ref="commentBody"
            class="comment-sheet-body"
            :class="{ empty: !commentCount }"
            @pointerdown="startBodyPointerDrag"
            @pointermove="moveBodyPointerDrag"
            @pointerup="endBodyPointerDrag"
            @pointercancel="cancelBodyPointerDrag"
            @touchstart="startBodyTouchDrag"
            @touchmove="moveBodyTouchDrag"
            @touchend="endBodyTouchDrag"
            @touchcancel="cancelBodyDrag"
          >
            <div v-if="!threads.length" class="empty-comments">
              <strong>还没有评论</strong>
              <span>开始对话。</span>
            </div>
            <template v-for="(thread, index) in threads" :key="thread.root.id">
              <button
                v-if="index === INITIAL_ROOT_COUNT && remainingRootCount"
                class="thread-toggle root-toggle"
                type="button"
                :aria-expanded="commentsExpanded"
                @click="toggleCommentExpansion"
              >
                <span class="toggle-line" aria-hidden="true"></span>
                <span class="toggle-label">{{ commentsExpanded ? "隐藏评论" : `查看 ${remainingRootCount} 条评论` }}</span>
                <span class="toggle-line" aria-hidden="true"></span>
              </button>
              <article v-if="index < INITIAL_ROOT_COUNT || commentsExpanded" class="comment-thread">
                <CommentRow :comment="thread.root" @reply="startReply" />
                <button
                  v-if="thread.replies.length"
                  class="thread-toggle reply-toggle"
                  type="button"
                  :aria-expanded="isReplyThreadExpanded(thread.root.id)"
                  @click="toggleReplyThread(thread.root.id)"
                >
                  <span class="toggle-line" aria-hidden="true"></span>
                  <span class="toggle-label">{{ isReplyThreadExpanded(thread.root.id) ? "隐藏回复" : `查看 ${thread.replies.length} 条回复` }}</span>
                </button>
                <div v-if="isReplyThreadExpanded(thread.root.id)" class="comment-replies">
                  <div v-for="reply in thread.replies" :key="reply.id" class="comment-reply">
                    <CommentRow :comment="reply" is-reply @reply="startReply" />
                  </div>
                </div>
              </article>
            </template>
          </div>

          <div v-if="replyTarget" class="reply-target">
            <span>回复 @{{ displayName(replyTarget.author) }}</span>
            <button type="button" aria-label="取消回复" @click="cancelReply">×</button>
          </div>
          <div v-if="selectedImage" class="selected-image">
            <img :src="selectedImage.preview" alt="待发送的评论图片" />
            <button type="button" aria-label="移除图片" @click="removeSelectedImage">×</button>
          </div>
          <div v-if="sendError" class="send-error" role="alert">{{ sendError }}</div>
          <form class="comment-composer" @submit.prevent="submitComment">
            <textarea
              ref="composer"
              v-model="draft"
              rows="1"
              enterkeyhint="enter"
              autocomplete="off"
              :placeholder="replyTarget ? `回复 @${displayName(replyTarget.author)}` : '添加评论...'"
              aria-label="添加评论"
              @input="onMentionInput"
              @focus="handleCommentComposerFocus"
              @blur="handleCommentComposerBlur"
              @click="onMentionClick"
              @keydown="onMentionKeydown"
            ></textarea>
            <MentionSuggestions
              v-if="mentionOpen"
              :items="mentionMatches"
              :active-index="mentionActiveIndex"
              placement="above"
              @select="selectMention"
            />
            <input ref="imageInput" class="image-input" type="file" accept="image/*" @change="selectImage" />
            <div class="comment-composer-actions">
              <button class="comment-icon-button image-button" type="button" aria-label="添加图片" :disabled="sending" @click="imageInput?.click()">
                <span class="comment-icon-visual" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                </span>
              </button>
              <span class="comment-composer-actions-spacer" aria-hidden="true"></span>
              <button class="comment-icon-button send-button" type="submit" aria-label="发送" :disabled="sending || !canSend">
                <span class="comment-icon-visual send-visual" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="m5 12 14-7-4 14-3-6-7-1Z"/><path d="m12 13 7-8"/></svg>
                </span>
              </button>
            </div>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, defineComponent, getCurrentInstance, h, nextTick, onBeforeUnmount, ref, watch, type PropType } from "vue";
import type { InboxItem } from "@/stores/messages";
import type { Comment, CommentMedia } from "@/stores/interactions";
import { useInteractionsStore } from "@/stores/interactions";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { formatRelativeTime } from "@/utils/format";
import {
  buildCommentSubmission,
  commentDraftAfterSend,
  buildCommentThreads,
  canSubmitComment,
  canStartCommentSheetBodyDrag,
  createCommentSheetDragGesture,
  finishCommentSheetDragGesture,
  updateCommentSheetDragGesture,
  type CommentSheetDragGesture,
} from "@/utils/commentThreads";
import { openProfile } from "@/utils/profileNavigation";
import { uploadEncryptedCommentImage } from "@/utils/commentImage";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import PostImagePreview from "@/components/PostImagePreview.vue";
import MentionSuggestions from "@/components/MentionSuggestions.vue";
import MentionText from "@/components/MentionText.vue";
import { useMentionComposer } from "@/composables/useMentionComposer";
import { resizeComposerTextarea } from "@/utils/composerTextarea";
import type { MentionCandidate } from "@/utils/mentions";
import { useUIStore } from "@/stores/ui";

const props = defineProps<{ visible: boolean; message: InboxItem; targetCommentId?: string }>();
const emit = defineEmits<{ close: [] }>();
const interactions = useInteractionsStore();
const friends = useFriendsStore();
const friendships = useFriendshipsStore();
const keys = useKeyStore();
const profiles = useProfilesStore();
const router = useRouter();
const ui = useUIStore();
const overlayId = `comment-sheet-${getCurrentInstance()?.uid}`;
const dialog = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const commentBody = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const draft = ref("");
const replyTarget = ref<Comment | null>(null);
const sending = ref(false);
const sendError = ref("");
const selectedImage = ref<{ file: File; preview: string } | null>(null);
const dragY = ref(0);
const dragging = ref(false);
const threads = computed(() => buildCommentThreads(interactions.getComments(props.message.id)));
const commentCount = computed(() => interactions.getComments(props.message.id).length);
const INITIAL_ROOT_COUNT = 1;
const commentsExpanded = ref(false);
const expandedReplyRoots = ref(new Set<string>());
const remainingRootCount = computed(() => Math.max(0, threads.value.length - INITIAL_ROOT_COUNT));
const panelStyle = computed(() => dragY.value > 0 ? ({ transform: `translateY(${dragY.value}px)` }) : undefined);
const canSend = computed(() => canSubmitComment(draft.value, !!selectedImage.value));
const mentionCandidates = computed<MentionCandidate[]>(() => {
  const allowed = new Set([
    props.message.pubkey,
    ...(props.message.recipientPubkeys || []),
  ].map(pubkey => pubkey.toLowerCase()).filter(Boolean));
  const priorities = new Map<string, number>();
  priorities.set(props.message.pubkey.toLowerCase(), 0);
  if (replyTarget.value?.author) priorities.set(replyTarget.value.author.toLowerCase(), -1);
  for (const comment of interactions.getComments(props.message.id)) {
    if (!priorities.has(comment.author.toLowerCase())) priorities.set(comment.author.toLowerCase(), 1);
  }
  return friends.getAcceptedList(friendships.isAccepted)
    .filter(friend => allowed.has(friend.pubkey.toLowerCase()))
    .map(friend => {
      const profileName = profiles.getProfile(friend.pubkey)?.nickname?.trim();
      const label = profileName || friend.name?.trim() || `${friend.pubkey.slice(0, 8)}…`;
      return {
        pubkey: friend.pubkey,
        label,
        secondary: profileName && profileName !== label ? profileName : undefined,
        searchText: [friend.name || "", friend.note || "", profileName || ""].join(" "),
      };
    })
    .sort((a, b) => (priorities.get(a.pubkey.toLowerCase()) ?? 2) - (priorities.get(b.pubkey.toLowerCase()) ?? 2));
});
const {
  mentionOpen,
  mentionMatches,
  mentionActiveIndex,
  onMentionInput,
  onMentionFocus,
  onMentionClick,
  onMentionBlur,
  onMentionKeydown,
  selectMention,
  mentionedPubkeys,
  closeMention,
} = useMentionComposer(draft, composer, mentionCandidates);

let commentComposerFocused = false;
function resizeCommentComposer() {
  resizeComposerTextarea(composer.value, commentComposerFocused, {
    minHeight: 36,
    focusedMinHeight: 36,
    maxHeight: 108,
  });
}
watch(draft, () => {
  void nextTick(resizeCommentComposer);
}, { immediate: true });
function handleCommentComposerFocus() {
  commentComposerFocused = true;
  onMentionFocus();
  void nextTick(resizeCommentComposer);
}
function handleCommentComposerBlur() {
  commentComposerFocused = false;
  onMentionBlur();
  void nextTick(resizeCommentComposer);
}

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
  props: {
    comment: { type: Object as PropType<Comment>, required: true },
    isReply: { type: Boolean, default: false }
  },
  emits: ["reply"],
  setup(rowProps, { emit: rowEmit }) {
    return () => h("div", { id: `comment-${rowProps.comment.id}`, class: ["comment-row", { "reply-row": rowProps.isReply, highlight: props.targetCommentId === rowProps.comment.id }] }, [
      h("button", { class: "comment-avatar", type: "button", "aria-label": `查看 ${displayName(rowProps.comment.author)} 的资料`, onClick: (event: Event) => navigateProfile(rowProps.comment.author, event) }, [
        h(ProfileAvatar, { pubkey: rowProps.comment.author, localName: localName(rowProps.comment.author), size: rowProps.isReply ? 32 : 36 })
      ]),
      h("div", { class: "comment-copy" }, [
        h("div", { class: "comment-author-line" }, [
          h("button", { class: "comment-name", type: "button", onClick: (event: Event) => navigateProfile(rowProps.comment.author, event) }, displayName(rowProps.comment.author)),
          h("time", formatRelativeTime(rowProps.comment.timestamp))
        ]),
        rowProps.comment.text ? h("div", { class: "comment-text" }, [h(MentionText, { text: rowProps.comment.text })]) : null,
        rowProps.comment.media?.[0] ? h("div", { class: "comment-image" }, [
          h(PostImagePreview, {
            content: `![](${rowProps.comment.media[0].ref})`,
            max: 1,
            showAll: true,
            altText: "评论图片"
          })
        ]) : null,
        h("div", { class: "comment-actions" }, [
          h("button", { type: "button", onClick: () => rowEmit("reply", rowProps.comment) }, "回复"),
          rowProps.comment.pending ? h("span", { class: "pending" }, "发送中…") : null,
          rowProps.comment.failed ? h("span", { class: "failed" }, "发送失败") : null
        ])
      ])
    ]);
  }
});

function close() { closeMention(); emit("close"); }
function startReply(comment: Comment) {
  replyTarget.value = comment;
  sendError.value = "";
  void nextTick(() => composer.value?.focus());
}
function cancelReply() { replyTarget.value = null; }
function toggleCommentExpansion() {
  commentsExpanded.value = !commentsExpanded.value;
}
function isReplyThreadExpanded(rootId: string) { return expandedReplyRoots.value.has(rootId); }
function toggleReplyThread(rootId: string) {
  const next = new Set(expandedReplyRoots.value);
  next.has(rootId) ? next.delete(rootId) : next.add(rootId);
  expandedReplyRoots.value = next;
}
function revealTargetComment(targetCommentId?: string) {
  if (!targetCommentId) return;
  const rootIndex = threads.value.findIndex(thread =>
    thread.root.id === targetCommentId || thread.replies.some(reply => reply.id === targetCommentId)
  );
  if (rootIndex >= INITIAL_ROOT_COUNT) commentsExpanded.value = true;
  const thread = threads.value[rootIndex];
  if (thread?.replies.some(reply => reply.id === targetCommentId)) {
    expandedReplyRoots.value = new Set([...expandedReplyRoots.value, thread.root.id]);
  }
}
function removeSelectedImage() {
  if (selectedImage.value) URL.revokeObjectURL(selectedImage.value.preview);
  selectedImage.value = null;
  if (imageInput.value) imageInput.value.value = "";
}
function selectImage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    sendError.value = "请选择图片文件";
    return;
  }
  removeSelectedImage();
  selectedImage.value = { file, preview: URL.createObjectURL(file) };
  sendError.value = "";
}
async function submitComment() {
  const text = draft.value.trim();
  if (!canSubmitComment(text, !!selectedImage.value) || sending.value) return;
  sending.value = true;
  sendError.value = "";
  const target = replyTarget.value;
  const submission = buildCommentSubmission(props.message.id, props.message.pubkey, text, target, keys.pkHex);
  try {
    let media: CommentMedia[] | undefined;
    if (selectedImage.value) {
      media = [await uploadEncryptedCommentImage(selectedImage.value.file, {
        accountPubkey: keys.pkHex,
        signEvent: keys.signEvent.bind(keys)
      })];
    }
    await interactions.sendComment(
      submission.messageId,
      submission.recipientPubkey,
      submission.text,
      submission.parentCommentId,
      media,
      mentionedPubkeys()
    );
    draft.value = commentDraftAfterSend(draft.value, true);
    removeSelectedImage();
    replyTarget.value = null;
  } catch (error) {
    draft.value = commentDraftAfterSend(draft.value, false);
    sendError.value = error instanceof Error && /上传|图片|媒体|Blossom/i.test(error.message)
      ? "图片上传失败，草稿已保留，可重试"
      : "发送失败，草稿已保留，可重试";
  } finally {
    sending.value = false;
  }
}

let activeDrag: CommentSheetDragGesture | null = null;
let activePointerId: number | null = null;
let pointerCaptureTarget: HTMLElement | null = null;
let activeTouchId: number | null = null;
let dragFrame: number | null = null;
let pendingDragY = 0;

function currentPanelHeight() {
  return panel.value?.clientHeight || window.innerHeight;
}
function isInteractiveDragTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'button,a[href],input,textarea,select,option,[contenteditable="true"],[role="button"],img,picture,video,audio,canvas,.comment-image,.post-image-preview'
  );
}
function isEligiblePointer(event: PointerEvent) {
  return event.isPrimary && (event.pointerType !== "mouse" || event.button === 0);
}
function queueDragY(value: number) {
  pendingDragY = Math.max(0, value);
  if (dragFrame !== null) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = null;
    dragY.value = pendingDragY;
  });
}
function clearDragFrame() {
  if (dragFrame !== null) cancelAnimationFrame(dragFrame);
  dragFrame = null;
  pendingDragY = 0;
}
function releasePointerCapture() {
  if (pointerCaptureTarget && activePointerId !== null) {
    try {
      if (pointerCaptureTarget.hasPointerCapture(activePointerId)) {
        pointerCaptureTarget.releasePointerCapture(activePointerId);
      }
    } catch {
      // The browser may already have cancelled native pointer ownership.
    }
  }
  pointerCaptureTarget = null;
  activePointerId = null;
}
function resetDragState() {
  releasePointerCapture();
  clearDragFrame();
  activeTouchId = null;
  activeDrag = null;
  dragging.value = false;
  dragY.value = 0;
}
function completeDrag(cancelled = false) {
  const gesture = activeDrag;
  if (!gesture) {
    resetDragState();
    return;
  }
  const result = finishCommentSheetDragGesture(gesture, performance.now(), cancelled);
  resetDragState();
  if (result === "close") void nextTick(close);
}
function capturePointer(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  try {
    target.setPointerCapture(event.pointerId);
    pointerCaptureTarget = target;
  } catch {
    pointerCaptureTarget = null;
  }
}
function beginSurfaceDrag(event: PointerEvent) {
  activePointerId = event.pointerId;
  activeDrag = createCommentSheetDragGesture(
    event.clientX,
    event.clientY,
    performance.now(),
    currentPanelHeight(),
    "dragging",
  );
  dragging.value = true;
  capturePointer(event);
}
function startDrag(event: PointerEvent) {
  if (!isEligiblePointer(event) || isInteractiveDragTarget(event.target)) return;
  beginSurfaceDrag(event);
}
function startSurfaceDrag(event: PointerEvent) {
  if (!isEligiblePointer(event) || isInteractiveDragTarget(event.target)) return;
  beginSurfaceDrag(event);
}
function moveSurfaceDrag(event: PointerEvent) {
  if (!activeDrag || activePointerId !== event.pointerId) return;
  const update = updateCommentSheetDragGesture(activeDrag, event.clientX, event.clientY);
  activeDrag = update.gesture;
  queueDragY(update.dragDistance);
}
function moveDrag(event: PointerEvent) {
  moveSurfaceDrag(event);
}
function endSurfaceDrag(event: PointerEvent) {
  if (!activeDrag || activePointerId !== event.pointerId) return;
  const update = updateCommentSheetDragGesture(activeDrag, event.clientX, event.clientY);
  activeDrag = update.gesture;
  completeDrag(false);
}
function endDrag(event: PointerEvent) {
  endSurfaceDrag(event);
}
function cancelDrag(event?: PointerEvent) {
  if (event && activePointerId !== null && event.pointerId !== activePointerId) return;
  completeDrag(true);
}

function canStartBodyDrag(interactiveTarget: boolean, pointerCount = 1) {
  const body = commentBody.value;
  if (!body) return false;
  return canStartCommentSheetBodyDrag({
    commentCount: commentCount.value,
    scrollTop: body.scrollTop,
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    interactiveTarget,
    pointerCount,
  });
}
function startBodyPointerDrag(event: PointerEvent) {
  if (event.pointerType === "touch" || !isEligiblePointer(event)) return;
  if (!canStartBodyDrag(isInteractiveDragTarget(event.target))) return;
  activePointerId = event.pointerId;
  activeDrag = createCommentSheetDragGesture(
    event.clientX,
    event.clientY,
    performance.now(),
    currentPanelHeight(),
  );
}
function moveBodyPointerDrag(event: PointerEvent) {
  if (!activeDrag || activePointerId !== event.pointerId || event.pointerType === "touch") return;
  const wasPending = activeDrag.phase === "pending";
  const update = updateCommentSheetDragGesture(
    activeDrag,
    event.clientX,
    event.clientY,
    commentBody.value?.scrollTop || 0,
  );
  activeDrag = update.gesture;
  if (wasPending && activeDrag.phase === "dragging") {
    dragging.value = true;
    capturePointer(event);
  }
  if (update.preventDefault) event.preventDefault();
  if (activeDrag.phase === "dragging") queueDragY(update.dragDistance);
}
function endBodyPointerDrag(event: PointerEvent) {
  if (!activeDrag || activePointerId !== event.pointerId || event.pointerType === "touch") return;
  const update = updateCommentSheetDragGesture(
    activeDrag,
    event.clientX,
    event.clientY,
    commentBody.value?.scrollTop || 0,
  );
  activeDrag = update.gesture;
  completeDrag(false);
}
function cancelBodyPointerDrag(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  if (activePointerId !== null && event.pointerId !== activePointerId) return;
  completeDrag(true);
}
function cancelBodyDrag() {
  completeDrag(true);
}

function touchById(touches: TouchList, identifier: number) {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}
function startBodyTouchDrag(event: TouchEvent) {
  if (event.touches.length !== 1 || !canStartBodyDrag(isInteractiveDragTarget(event.target), event.touches.length)) {
    cancelBodyDrag();
    return;
  }
  const touch = event.touches.item(0);
  if (!touch) return;
  activeTouchId = touch.identifier;
  activeDrag = createCommentSheetDragGesture(
    touch.clientX,
    touch.clientY,
    performance.now(),
    currentPanelHeight(),
  );
}
function moveBodyTouchDrag(event: TouchEvent) {
  if (!activeDrag || activeTouchId === null) return;
  if (event.touches.length !== 1) {
    cancelBodyDrag();
    return;
  }
  const touch = touchById(event.touches, activeTouchId);
  if (!touch) {
    cancelBodyDrag();
    return;
  }
  const wasPending = activeDrag.phase === "pending";
  const update = updateCommentSheetDragGesture(
    activeDrag,
    touch.clientX,
    touch.clientY,
    commentBody.value?.scrollTop || 0,
  );
  activeDrag = update.gesture;
  if (wasPending && activeDrag.phase === "dragging") dragging.value = true;
  if (update.preventDefault && event.cancelable) event.preventDefault();
  if (activeDrag.phase === "dragging") queueDragY(update.dragDistance);
}
function endBodyTouchDrag(event: TouchEvent) {
  if (!activeDrag || activeTouchId === null) return;
  const touch = touchById(event.changedTouches, activeTouchId);
  if (touch) {
    const update = updateCommentSheetDragGesture(
      activeDrag,
      touch.clientX,
      touch.clientY,
      commentBody.value?.scrollTop || 0,
    );
    activeDrag = update.gesture;
  }
  completeDrag(false);
}

let targetFocusGeneration = 0;

function nextFrame() {
  return new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

function centerTargetInCommentBody(target: HTMLElement) {
  const body = commentBody.value;
  if (!body) return;
  const bodyRect = body.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTopInBody = body.scrollTop + targetRect.top - bodyRect.top;
  const centeredTop = targetTopInBody - Math.max(0, (body.clientHeight - targetRect.height) / 2);
  body.scrollTo({ top: Math.max(0, centeredTop), behavior: "auto" });
}

async function focusTarget() {
  const targetCommentId = props.targetCommentId;
  const generation = ++targetFocusGeneration;
  await nextTick();
  if (generation !== targetFocusGeneration || !props.visible) return;

  dialog.value?.focus();
  if (!targetCommentId) return;

  // Expand the exact root/reply first, then resolve the target after Vue has
  // rendered that branch. A couple of animation frames is enough for layout
  // without the old multi-second polling.
  revealTargetComment(targetCommentId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await nextTick();
    await nextFrame();
    if (generation !== targetFocusGeneration || !props.visible) return;
    const target = document.getElementById(`comment-${targetCommentId}`);
    if (!target) continue;
    centerTargetInCommentBody(target);
    // One layout correction keeps the target centered if expanding a reply
    // changes heights during the same render cycle.
    await nextFrame();
    if (generation !== targetFocusGeneration || !props.visible) return;
    centerTargetInCommentBody(target);
    return;
  }
}
watch(() => props.visible, visible => {
  ui.setBlockingOverlay(overlayId, visible);
  resetDragState();
  if (visible) {
    commentsExpanded.value = false;
    expandedReplyRoots.value = new Set();
    revealTargetComment(props.targetCommentId);
    void focusTarget();
  }
  else {
    replyTarget.value = null;
    sendError.value = "";
    dragY.value = 0;
  }
}, { immediate: true });
watch([threads, () => props.targetCommentId], ([, targetCommentId]) => {
  revealTargetComment(targetCommentId);
  if (props.visible) void focusTarget();
});
onBeforeUnmount(() => {
  resetDragState();
  ui.setBlockingOverlay(overlayId, false);
  replyTarget.value = null;
  removeSelectedImage();
});
</script>

<style scoped>
.comment-sheet-backdrop{position:fixed;inset:0;z-index:12000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.42);touch-action:pan-y}
.comment-sheet-panel{width:min(100%,720px);height:calc(100dvh - 72px);display:flex;flex-direction:column;border-radius:18px 18px 0 0;background:#fff;box-shadow:0 -12px 38px rgba(15,23,42,.2);transition:transform 260ms cubic-bezier(.22,1,.36,1);overflow:hidden;touch-action:pan-y}.comment-sheet-panel.dragging{transition:none}
.drag-handle-area{display:grid;place-items:center;height:24px;flex:0 0 24px;touch-action:none}.drag-handle-area span{width:38px;height:4px;border-radius:999px;background:#cbd5e1}
.comment-sheet-header{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:44px;padding-left:44px;border-bottom:1px solid #e2e8f0;touch-action:none}.comment-sheet-header h2{margin:0;text-align:center;font-size:16px}.comment-sheet-header button{width:44px;height:44px;border:0;background:transparent;color:#64748b;font-size:24px}
.comment-sheet-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y;scroll-padding-bottom:24px;padding:8px 14px 24px}.comment-sheet-body.empty{cursor:grab}.comment-sheet-body.empty:active{cursor:grabbing}.empty-comments{display:flex;flex-direction:column;align-items:center;gap:4px;padding:54px 0;color:#94a3b8;text-align:center}.empty-comments strong{color:#334155;font-size:14px;font-weight:600}.empty-comments span{font-size:12px}
.comment-thread{padding:5px 0}.comment-replies{margin-top:1px}.comment-reply{margin-left:42px;padding-top:4px}.comment-row{display:flex;align-items:flex-start;gap:10px;padding:4px 2px;border-radius:10px}.comment-row.highlight{animation:comment-highlight 1.6s ease}:deep(.comment-avatar),:deep(.comment-name),:deep(.comment-actions button){appearance:none;-webkit-appearance:none;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;color:inherit;font-family:inherit;cursor:pointer}:deep(.comment-avatar){display:flex;align-items:flex-start;justify-content:center;width:36px;height:36px;min-width:36px;min-height:36px;flex:0 0 36px;align-self:flex-start;border-radius:50%;overflow:hidden}:deep(.reply-row .comment-avatar){width:32px;height:32px;min-width:32px;min-height:32px;flex-basis:32px}:deep(.comment-copy){flex:1;min-width:0;font-size:13px}:deep(.comment-author-line){display:flex;align-items:baseline;gap:6px;min-width:0;line-height:1.25}:deep(.comment-name){min-width:0;color:#1f2937;font-size:13px;font-weight:600;line-height:1.25;text-align:left}:deep(.comment-author-line time){flex-shrink:0;color:#8e8e8e;font-size:11px;font-weight:400;line-height:1.25}:deep(.comment-text){margin-top:3px;color:#1f2937;line-height:1.4;overflow-wrap:anywhere}:deep(.comment-mention){color:#2563eb}:deep(.comment-actions){display:flex;align-items:center;gap:6px;min-height:17px;margin-top:3px;color:#8e8e8e;font-size:11px;line-height:1.25}:deep(.comment-actions button){color:#8e8e8e;font-size:11px;font-weight:600;line-height:1.25}:deep(.pending){margin-left:2px}:deep(.failed){margin-left:2px;color:#dc2626}.thread-toggle{min-height:30px;padding:2px 0;border:0;background:transparent;color:#64748b;font-size:11px;font-weight:500;text-align:left}.toggle-line{display:block;height:1px;background:#cbd5e1}.toggle-label{white-space:nowrap}.root-toggle{display:grid;grid-template-columns:minmax(48px,1fr) auto minmax(48px,1fr);align-items:center;gap:10px;width:100%;margin:3px 0}.root-toggle .toggle-line{width:100%;background:#aeb8c5}.reply-toggle{display:flex;align-items:center;gap:8px;margin:1px 0 0 48px}.reply-toggle .toggle-line{width:24px;flex:0 0 24px}:deep(.comment-image){width:min(260px,100%);max-height:320px;margin-top:6px;overflow:hidden;border-radius:10px}:deep(.comment-image .post-image-preview),:deep(.comment-image .carousel-shell){width:100%;max-width:260px}:deep(.comment-image .carousel-shell){max-height:320px;margin:0;border-radius:10px}:deep(.comment-image .carousel-image){display:block;width:auto;height:auto;max-width:100%;max-height:320px;margin:auto;object-fit:cover;border-radius:10px}:deep(.comment-image .carousel-dots),:deep(.comment-image .carousel-counter),:deep(.comment-image .carousel-nav){display:none}
.reply-target{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;padding:2px 12px;border-top:1px solid #eef2f6;color:#64748b;font-size:11px}.reply-target button{width:28px;height:28px;border:0;background:transparent;color:inherit}
.selected-image{position:relative;width:72px;height:72px;margin:7px 12px 0}.selected-image img{display:block;width:100%;height:100%;object-fit:cover;border-radius:9px}.selected-image button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:rgba(15,23,42,.82);color:#fff;font-size:16px;line-height:22px}.comment-composer{position:sticky;bottom:0;z-index:2;display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;box-sizing:border-box;width:calc(100% - 48px);min-height:48px;flex-shrink:0;margin:8px 24px calc(env(safe-area-inset-bottom) + 10px);padding:2px 8px;border:1px solid #d8dee5;border-radius:24px;background:#fff;box-shadow:0 4px 18px rgba(15,23,42,.11);transition:width 180ms ease,margin 180ms ease,min-height 180ms ease,border-color 180ms ease,box-shadow 180ms ease}.comment-composer:focus-within{width:calc(100% - 32px);min-height:76px;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 34px;align-items:stretch;margin:8px 16px calc(env(safe-area-inset-bottom) + 2px);padding:6px 8px 4px;border-color:#c8d0d9;box-shadow:0 5px 20px rgba(15,23,42,.13)}.comment-composer textarea{grid-column:2;grid-row:1;min-width:0;min-height:36px;max-height:108px;box-sizing:border-box;padding:7px 6px 6px;border:0;outline:0;resize:none;overflow-y:hidden;background:transparent;color:#0f1419;font:inherit;font-size:16px;line-height:22px}.comment-composer:focus-within textarea{grid-column:1;grid-row:1;width:100%;padding:4px 6px 3px}.comment-composer-actions{display:contents}.comment-composer-actions-spacer{display:none}.comment-composer-actions .image-button{grid-column:1;grid-row:1}.comment-composer-actions .send-button{grid-column:3;grid-row:1}.comment-composer:focus-within .comment-composer-actions{display:flex;grid-column:1;grid-row:2;min-width:0;min-height:34px;align-items:center;justify-content:space-between}.comment-composer:focus-within .comment-composer-actions-spacer{display:block;flex:1}.image-input{display:none}.comment-icon-button{display:grid;position:relative;width:44px;height:44px;margin:-5px;padding:5px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419;-webkit-tap-highlight-color:transparent}.comment-icon-visual{display:grid;width:34px;height:34px;place-items:center;border-radius:50%;background:transparent}.comment-icon-visual svg{display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.image-button .comment-icon-visual svg{stroke-width:1.8}.send-button{color:#fff}.send-button .send-visual{background:#0f1419}.send-button .send-visual svg{width:18px;height:18px}.comment-composer button:disabled{opacity:.45}.send-error{flex-shrink:0;padding:3px 14px;color:#dc2626;font-size:11px;text-align:center}
.comment-sheet-enter-active{transition:opacity 320ms cubic-bezier(.22,1,.36,1)}.comment-sheet-leave-active{transition:opacity 260ms cubic-bezier(.22,1,.36,1)}.comment-sheet-enter-active .comment-sheet-panel{transition:transform 320ms cubic-bezier(.22,1,.36,1)}.comment-sheet-leave-active .comment-sheet-panel{transition:transform 260ms cubic-bezier(.22,1,.36,1)}.comment-sheet-enter-from,.comment-sheet-leave-to{opacity:0}.comment-sheet-enter-from .comment-sheet-panel,.comment-sheet-leave-to .comment-sheet-panel{transform:translateY(100%)}
@keyframes comment-highlight{0%,55%{background:#fef3c7}100%{background:transparent}}
@media(min-width:768px){.comment-sheet-backdrop{align-items:center;padding:24px}.comment-sheet-panel{height:min(82vh,760px);border-radius:18px}.drag-handle-area{display:none}}
@media(prefers-reduced-motion:reduce){.comment-sheet-panel,.comment-sheet-enter-active,.comment-sheet-leave-active{transition:none}.comment-row.highlight{animation:none;background:#fef3c7}}
</style>
