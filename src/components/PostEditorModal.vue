<template>
  <transition name="slide-up">
    <div class="editor-overlay" v-if="visible" @click.self="requestCancel" tabindex="-1" ref="overlay">
      <div
        ref="editorCard"
        class="editor-card"
        :class="{ dragging: sheetDragging }"
        :style="sheetStyle"
        tabindex="-1"
        aria-label="发帖"
        role="dialog"
        aria-modal="true"
        @click.stop
        @click.capture="onSheetClickCapture"
        @pointerdown="onSheetPointerDown"
        @pointermove="onSheetPointerMove"
        @pointerup="onSheetPointerEnd"
        @pointercancel="onSheetPointerCancel"
      >
        <header class="editor-header">
          <div class="drag-handle" aria-hidden="true"></div>
          <div class="editor-header-row">
            <button class="header-cancel" type="button" :disabled="sending" @click="requestCancel">取消</button>
            <strong class="title">新建动态</strong>
            <span class="header-balance" aria-hidden="true"></span>
          </div>
        </header>

        <main ref="editorBody" class="editor-body">
          <div class="editor-author">
            <ProfileAvatar :pubkey="keys.pkHex" :size="42" />
            <div class="editor-author-copy"><strong>{{ ownName }}</strong><span>分享此刻的想法</span></div>
          </div>
          <div class="editor-textarea-wrap">
            <textarea v-model="content" ref="textarea" class="editor-textarea"
              placeholder="这一刻，你想分享什么？" rows="6" :disabled="!!pendingPostRetry"
              @paste="onPaste" @input="onMentionInput" @focus="onMentionFocus"
              @blur="onMentionBlur" @click="onMentionClick" @keydown="onMentionKeydown"></textarea>
            <MentionSuggestions v-if="mentionOpen" :items="mentionMatches" :active-index="mentionActiveIndex"
              inline @select="selectMention" />
          </div>

          <!-- 图片/视频上传区域 -->
          <div class="upload-panel">
            <div class="previews">
              <div v-for="(item, idx) in uploads" :key="item.id" class="preview-item">
                <div class="thumb-container">
                  <img v-if="item.preview" :src="item.preview" class="thumb-image" />
                  <PostImagePreview
                    v-else-if="item.encryptedRef"
                    :content="`![](${item.encryptedRef})`"
                    :show-all="true"
                    alt-text="草稿图片"
                  />
                  <div v-else class="thumb-placeholder">图片</div>
                  
                  <!-- Upload progress overlay -->
                  <div v-if="item.status === 'uploading'" class="upload-overlay">
                    <div class="progress-ring">
                      <svg viewBox="0 0 36 36" class="progress-circle">
                        <circle cx="18" cy="18" r="16" fill="none" stroke="#e5e7eb" stroke-width="3"/>
                        <circle cx="18" cy="18" r="16" fill="none" stroke="#3b82f6" stroke-width="3" 
                                :stroke-dasharray="`${item.progress} ${100 - item.progress}`"
                                stroke-dashoffset="25"
                                stroke-linecap="round"/>
                      </svg>
                      <span class="progress-text">{{ item.progress }}%</span>
                    </div>
                  </div>
                  
                  <!-- Error overlay -->
                  <div v-if="item.status === 'error'" class="error-overlay" :title="item.errorShort">
                    ⚠️
                  </div>
                  
                  <!-- Remove button -->
                  <button type="button" class="remove-btn" @click="removeUpload(idx)" :aria-label="`删除图片 ${item.name}`" :title="item.name">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Video preview -->
          <div v-if="videoPreview" class="video-preview-item">
            <div class="video-thumb-container">
              <!-- Show thumbnail if available -->
              <img 
                v-if="videoPreview.thumbnail" 
                :src="videoPreview.thumbnail" 
                class="video-thumbnail-img" 
                :alt="`${videoPreview.provider} 视频缩略图`"
              />
              <!-- Fallback to placeholder -->
              <div v-else class="video-placeholder">
                <div class="play-icon">▶</div>
                <div class="video-info">
                  <div class="video-provider">{{ videoPreview.provider }}</div>
                  <div class="small">{{ videoPreview.url }}</div>
                </div>
              </div>
              <!-- Play icon overlay (always on top) -->
              <div class="video-play-overlay">
                <div class="play-icon-large">▶</div>
              </div>
              <button type="button" class="remove-btn" @click="removeVideo" title="删除视频">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <section ref="visibilityRow" class="audience-section" :class="{ 'audience-section-error': visibilityError }" aria-labelledby="audience-title">
            <div class="audience-heading">
              <h3 id="audience-title">谁可以看到这条动态？</h3>
              <span class="audience-required" :class="{ chosen: audienceChosen }">{{ audienceChosen ? "已选择" : "必选" }}</span>
            </div>
            <div class="audience-cards" role="group" aria-label="可见范围">
              <button type="button" class="audience-card"
                :class="{ selected: audienceChosen && !allFriends && selectedGroups.length === 0 }"
                :aria-pressed="audienceChosen && !allFriends && selectedGroups.length === 0"
                :disabled="!!pendingPostRetry" @click="chooseSelf">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/></svg>
                <span>仅自己</span><small v-if="audienceChosen && !allFriends && selectedGroups.length === 0">✓</small>
              </button>
              <button type="button" class="audience-card"
                :class="{ selected: audienceChosen && !allFriends && selectedGroups.length > 0, expanded: visibilityOpen }"
                :aria-pressed="audienceChosen && !allFriends && selectedGroups.length > 0"
                :aria-expanded="visibilityOpen" :disabled="!!pendingPostRetry" @click="chooseGroups">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M2 20v-2a7 7 0 0 1 14 0v2"/><path d="M17 6a3 3 0 0 1 0 6"/><path d="M18 15a5 5 0 0 1 4 5"/></svg>
                <span>指定分组</span><small v-if="audienceChosen && !allFriends && selectedGroups.length > 0">✓</small>
              </button>
              <button type="button" class="audience-card"
                :class="{ selected: audienceChosen && allFriends }" :aria-pressed="audienceChosen && allFriends"
                :disabled="!!pendingPostRetry || postAudienceFriends.length === 0" @click="toggleAll">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/></svg>
                <span>全部好友</span><small v-if="audienceChosen && allFriends">✓</small>
              </button>
            </div>
            <div v-if="visibilityOpen" class="group-picker">
              <p class="group-picker-title">选择可以看到动态的好友分组</p>
              <div class="group-options">
                <button v-for="g in groups" :key="g" type="button" class="group-option"
                  :class="{ selected: selectedSet.has(g) }" :aria-pressed="selectedSet.has(g)"
                  :disabled="!!pendingPostRetry" @click="toggleGroup(g)">
                  <span>{{ gLabel(g) }}</span><small>{{ countByGroup[g] || 0 }} 人</small>
                </button>
              </div>
              <p v-if="groups.length === 0" class="group-picker-empty">暂无好友分组，可以选择仅自己或全部好友。</p>
            </div>
            <div v-if="visibilityError" id="visibility-error" class="visibility-error" role="alert">请先选择可见范围，再发布动态。</div>
            <p v-if="audienceChosen" class="audience-summary">{{ visibilitySummary }}<template v-if="allFriends || selectedGroups.length"> · {{ recipients.length }} 位好友</template></p>
            <p v-else class="audience-summary muted">发布前请明确选择接收范围。</p>
            <p v-if="botMentioned" class="audience-bot-hint">已 @Hainei Bot：将额外向 Bot 发送这条加密动态。</p>
            <p v-else-if="acceptedFriends.length > postAudienceFriends.length" class="audience-bot-hint">Hainei Bot 默认不接收动态，主动 @ 才会收到。</p>
          </section>

          <div class="composer-toolbar">
            <div class="composer-tools">
              <label class="composer-tool" :class="{ disabled: !uploadEnabled || uploadingAny || !!pendingPostRetry }"
                :title="pendingPostRetry ? '当前贴文待重试' : (uploadEnabled ? '添加照片或视频' : '请先在设置中配置媒体服务')">
                <input type="file" accept="image/*,video/*" multiple @change="onFilesSelected"
                  :disabled="!uploadEnabled || uploadingAny || !!pendingPostRetry" />
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 3 3-4 5 6"/></svg>
                <span class="sr-only">添加照片或视频</span>
              </label>
              <button type="button" class="composer-tool" aria-label="提及好友"
                :disabled="!!pendingPostRetry" @click="insertMentionTrigger">@</button>
            </div>
            <button type="button" class="send-btn"
              :disabled="sending || uploadingAny || (!canSend && !pendingPostRetry)" @click="onSend()">
              {{ sending ? "发送中…" : pendingPostRetry ? "重新发送" : "发布动态" }}
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
            </button>
          </div>
          <p v-if="!uploadEnabled" class="upload-config-hint small">请先在设置中配置图片与视频服务</p>

          <div v-if="error" class="error">{{ error }}</div>
        </main>
        <div v-if="confirmAllFriends" class="audience-confirm-backdrop" @pointerdown.stop @pointermove.stop @pointerup.stop>
          <div class="audience-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="audience-confirm-title" aria-describedby="audience-confirm-description">
            <h3 id="audience-confirm-title">发送给全部好友？</h3>
            <p id="audience-confirm-description">这条动态将发送给 {{ recipients.length }} 位好友。确认可见范围无误后再发布。</p>
            <div class="audience-confirm-actions">
              <button type="button" class="save-draft-btn" @click="cancelAllFriendsConfirmation">返回检查</button>
              <button type="button" class="send-btn" :disabled="sending" @click="onSend(true)">确认发布</button>
            </div>
          </div>
        </div>
        <div v-if="cancelSheetOpen" class="cancel-sheet-backdrop" @pointerdown.stop @pointermove.stop @pointerup.stop @click.self="continueEditing">
          <section class="cancel-sheet" role="alertdialog" aria-modal="true"
            aria-labelledby="cancel-sheet-title" aria-describedby="cancel-sheet-description">
            <h3 id="cancel-sheet-title">退出编辑？</h3>
            <p id="cancel-sheet-description">可以保存草稿，之后继续编辑。</p>
            <button class="cancel-sheet-save" type="button" @click="saveAndClose">保存草稿</button>
            <button class="cancel-sheet-discard" type="button" @click="discardDraft">放弃</button>
            <button ref="cancelContinueButton" class="cancel-sheet-continue" type="button" @click="continueEditing">继续编辑</button>
          </section>
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
import { useDialogFocus } from "@/composables/useDialogFocus";
import { useMentionComposer } from "@/composables/useMentionComposer";
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { defineComponent, ref, onBeforeUnmount, watch, nextTick, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { usePostsStore } from "@/stores/posts";
import { useMessagesStore } from "@/stores/messages";
import { useUIStore } from "@/stores/ui";
import { useProfilesStore } from "@/stores/profiles";
import PostImagePreview from "@/components/PostImagePreview.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import MentionSuggestions from "@/components/MentionSuggestions.vue";
import { mentionTags, type MentionCandidate } from "@/utils/mentions";
import { HAINEI_BOT_NAME, HAINEI_BOT_PUBKEY, isHaiNeiBot } from "@/utils/haineiBot";
import { uploadImageToBlossomWithFallback, getBlossomConfig } from "@/utils/blossom";
import { resizeImageFile } from "@/utils/imageResize";
import { compressImageToTargetSize } from "@/utils/imageCompression";
import {
  encodeEncryptedImageRef,
  variantToEncryptedImageRef,
  type EncryptedImageMetadata,
  type EncryptedImageVariant,
} from "@/utils/encryptedImageRef";
import { encodeEncryptedVideoRef } from "@/utils/encryptedVideoRef";
import { exportKeyToBase64 } from "@/utils/videoCrypto";
import { bytesToBase64 } from "@/nostr/crypto";
import { parseVideoUrl as parseVideoUrlUtil } from "@/utils/videoUtils";
import {
  clearPostDraft,
  loadPostDraft,
  mergeCompletedPostDraftImage,
  mergeCompletedPostDraftVideo,
  savePostDraft,
  type PostDraftImage,
  type PostDraftVideo,
} from "@/utils/postDraft";
import { canStartPostEditorDrag, shouldDismissPostEditor } from "@/utils/postEditorGesture";
import {
  audienceGroupCounts,
  audienceGroupsMeta,
  audienceRecipients,
  isExcludedPostRecipient,
  normalizeSelectedAudienceGroups,
} from "@/utils/friendAudience";
import {
  releaseObjectUrl,
  releasePostEditorMediaUrls,
  restoreDraftImageUploads,
  serializeCompletedDraftImages,
  type PostEditorUploadItem,
} from "@/utils/postEditorMediaDraft";
import {
  cacheEncryptedPreviewBestEffort,
  imageDimensions,
  prepareEncryptedImage,
  prepareEncryptedVideo,
  uploadPreparedImage,
} from "@/utils/postEditorMediaUpload";

// Video metadata format constants
const VIDEO_METADATA_PREFIX = '[video:';
const VIDEO_METADATA_SUFFIX = ']';

export default defineComponent({
  name: "PostEditorModal",
  components: { PostImagePreview, ProfileAvatar, MentionSuggestions },
  setup() {
    const router = useRouter();
    const route = useRoute();
    const keys = useKeyStore();
    const friends = useFriendsStore();
    const friendships = useFriendshipsStore();
    const posts = usePostsStore();
    const msgs = useMessagesStore();
    const ui = useUIStore();
    const profiles = useProfilesStore();

    const visible = computed(() => ui.showPostEditor);
    const content = ref("");
    const sending = ref(false);
    const error = ref<string | null>(null);
    const pendingPostRetry = ref<{ outgoingId: string; groupsMeta: Array<{ name: string; count: number }> } | null>(null);
    const textarea = ref<HTMLTextAreaElement | null>(null);
    const overlay = ref<HTMLElement | null>(null);
    const editorCard = ref<HTMLElement | null>(null);
    useDialogFocus(editorCard, () => ui.showPostEditor, requestCancel);
    const editorBody = ref<HTMLElement | null>(null);
    const sheetDragging = ref(false);
    const sheetOffset = ref(0);
    const sheetStyle = computed(() => ({ transform: `translateY(${sheetOffset.value}px)` }));
    let dragCandidate = false;
    let dragStartY = 0;
    let dragStartAt = 0;
    let dragPointerId: number | null = null;
    let suppressSheetClick = false;


    // recipients selection state
    const allFriends = ref(false);
    const selectedGroups = ref<Array<string>>([]);
    const audienceChosen = ref(false);
    const visibilityError = ref(false);
    const visibilityOpen = ref(true);
    const visibilityRow = ref<HTMLElement | null>(null);
    const cancelSheetOpen = ref(false);
    const cancelContinueButton = ref<HTMLButtonElement | null>(null);
    const ownName = computed(() => profiles.getProfile(keys.pkHex)?.nickname?.trim() || "我");
    const confirmAllFriends = ref(false);
    const confirmationRecipients = ref("");
    let draftPersistenceEnabled = false;
    let draftAccount = "";

    function persistDraft(account = draftAccount) {
      if (!draftPersistenceEnabled || !account) return;
      savePostDraft(account, {
        content: content.value,
        allFriends: allFriends.value,
        selectedGroups: [...selectedGroups.value],
        audienceChosen: audienceChosen.value,
        images: serializeCompletedDraftImages(uploads.value),
        video: videoPreview.value,
      });
    }

    const stopBeforeLock = onBeforeAccountLock(account => {
      cancelUploadsForAccount(account);
      if (draftAccount !== account) return;
      persistDraft(account);
      draftPersistenceEnabled = false;
      ui.closePostEditor();
    });
    const canSend = computed(() => {
      const hasText = content.value.trim().length > 0;
      const hasUploadedImages = uploads.value.some(u => u.status === 'done' && u.encryptedRef);
      const hasVideo = videoPreview.value !== null;
      return hasText || hasUploadedImages || hasVideo;
    });

    const acceptedFriends = computed(() => friends.getAcceptedList(friendships.isAccepted));
    const postAudienceFriends = computed(() => acceptedFriends.value.filter(
      friend => !isExcludedPostRecipient(friend.pubkey)
    ));

    const groupSummary = computed(() => audienceGroupCounts(postAudienceFriends.value));
    const groups = computed(() => groupSummary.value.order);
    const countByGroup = computed(() => groupSummary.value.counts);
    const selectedSet = computed(() => new Set(selectedGroups.value || []));
    const recipients = computed(() => audienceRecipients(
      postAudienceFriends.value,
      allFriends.value,
      selectedGroups.value
    ));
    const mentionCandidates = computed<MentionCandidate[]>(() => {
      const allowed = new Set(recipients.value.map(pubkey => pubkey.toLowerCase()));
      return acceptedFriends.value
        // Only the Bot may be mentioned outside the selected post audience.
        .filter(friend => allowed.has(friend.pubkey.toLowerCase()) || isHaiNeiBot(friend.pubkey))
        .map(friend => {
          const profileName = profiles.getProfile(friend.pubkey)?.nickname?.trim();
          const label = isHaiNeiBot(friend.pubkey)
            ? HAINEI_BOT_NAME
            : profileName || friend.name?.trim() || `${friend.pubkey.slice(0, 8)}…`;
          return {
            pubkey: friend.pubkey,
            label,
            secondary: profileName && profileName !== label ? profileName : undefined,
            searchText: [friend.name || "", friend.note || "", profileName || ""].join(" "),
          };
        });
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
    } = useMentionComposer(content, textarea, mentionCandidates);
    // A deliberate @Hainei Bot adds exactly one Bot copy; ordinary audiences
    // and group counts keep excluding it. Removing the mention removes consent.
    const botMentioned = computed(() =>
      acceptedFriends.value.some(friend => isHaiNeiBot(friend.pubkey))
      && mentionedPubkeys().some(isHaiNeiBot));
    const recipientsCount = computed(() => recipients.value.length + Number(botMentioned.value));

    const visibilitySummary = computed(() => {
      const base = !audienceChosen.value ? "请选择 · 必选" : allFriends.value
        ? "全部好友"
        : selectedGroups.value.length > 0 ? `${selectedGroups.value.length} 个分组` : "仅自己可见";
      if (!audienceChosen.value || !botMentioned.value) return base;
      return base === "仅自己可见" ? "仅自己和 Hainei Bot" : `${base} + Hainei Bot`;
    });

    function gLabel(g: string) {
      return g === "未分组" ? "未分组" : g;
    }

    function dismissAudienceConfirmation() {
      confirmAllFriends.value = false;
      confirmationRecipients.value = "";
    }
    function cancelAllFriendsConfirmation() {
      dismissAudienceConfirmation();
      visibilityOpen.value = true;
    }
    function chooseSelf() {
      closeMention();
      dismissAudienceConfirmation();
      allFriends.value = false;
      selectedGroups.value = [];
      audienceChosen.value = true;
      visibilityOpen.value = false;
      visibilityError.value = false;
    }
    function chooseGroups() {
      closeMention();
      dismissAudienceConfirmation();
      allFriends.value = false;
      // Expanding groups is not itself a visibility choice.
      audienceChosen.value = selectedGroups.value.length > 0;
      visibilityOpen.value = !visibilityOpen.value || !selectedGroups.value.length;
      visibilityError.value = false;
    }
    function toggleAll() {
      closeMention();
      dismissAudienceConfirmation();
      allFriends.value = true;
      selectedGroups.value = [];
      audienceChosen.value = true;
      visibilityOpen.value = false;
      visibilityError.value = false;
    }
    function toggleGroup(g: string) {
      closeMention();
      dismissAudienceConfirmation();
      visibilityOpen.value = true;
      if (allFriends.value || !audienceChosen.value || selectedGroups.value.length === 0) {
        allFriends.value = false;
        selectedGroups.value = [g];
      } else {
        const idx = selectedGroups.value.indexOf(g);
        if (idx === -1) selectedGroups.value.push(g);
        else selectedGroups.value.splice(idx, 1);
      }
      // Deselecting the final group must not silently become a self-only post.
      audienceChosen.value = selectedGroups.value.length > 0;
      visibilityError.value = false;
    }

    const uploads = ref<PostEditorUploadItem[]>([]);
    const discardedUploadIds = new Set<string>();
    const activeUploads = new Map<string, { account: string; controller: AbortController }>();
    const uploadEnabled = ref(false);
    const uploadingAny = computed(() => uploads.value.some(u => u.status === "uploading"));

    function beginUpload(id: string, account: string) {
      activeUploads.get(id)?.controller.abort();
      const controller = new AbortController();
      activeUploads.set(id, { account, controller });
      return controller;
    }

    function cancelUpload(id: string, discardResult = true) {
      if (discardResult) discardedUploadIds.add(id);
      const active = activeUploads.get(id);
      active?.controller.abort();
      activeUploads.delete(id);
    }

    function cancelUploadsForAccount(account: string, discardResult = true) {
      for (const [id, active] of activeUploads) {
        if (active.account !== account) continue;
        if (discardResult) discardedUploadIds.add(id);
        active.controller.abort();
        activeUploads.delete(id);
      }
    }

    function cancelAllUploads(discardResult = true) {
      for (const [id, active] of activeUploads) {
        if (discardResult) discardedUploadIds.add(id);
        active.controller.abort();
        activeUploads.delete(id);
      }
    }

    function uploadWasCancelled(error: unknown) {
      return error instanceof Error && error.name === "AbortError";
    }

    // Video support
    const videoPreview = ref<PostDraftVideo | null>(null);

    function parseVideoUrl(url: string): { url: string; provider: string; embedUrl?: string; thumbnail?: string } | null {
      // Use the shared utility function
      return parseVideoUrlUtil(url);
    }

    function removeVideo() {
      releaseObjectUrl(videoPreview.value?.thumbnail);
      releaseObjectUrl(videoPreview.value?.url);
      releaseObjectUrl(videoPreview.value?.embedUrl);
      videoPreview.value = null;
    }

    // Immutable update helper for upload items to ensure Vue reactivity
    function updateUploadItem(id: string, patch: Partial<PostEditorUploadItem>) {
      const idx = uploads.value.findIndex(u => u.id === id);
      if (idx === -1) return;
      uploads.value.splice(idx, 1, { ...uploads.value[idx], ...patch });
    }

    async function checkBlossom() {
      const cfg = await getBlossomConfig();
      uploadEnabled.value = !!cfg.url;
    }

    function toId() {
      return Math.random().toString(36).slice(2, 9);
    }

    function makePreview(file: File): string | null {
      try { return URL.createObjectURL(file); } catch { return null; }
    }

    function onFilesSelected(e: Event) {
      const input = e.target as HTMLInputElement;
      const files = input.files;
      if (!files || files.length === 0) return;
      for (let i=0;i<files.length;i++){
        const f = files[i];
        // Check if it's a video file
        if (f.type.startsWith('video/')) {
          // For video files, use video upload
          const item: PostEditorUploadItem = {
            id: toId(), 
            name: f.name,
            file: f, 
            preview: null, // Videos don't need local preview
            status: "pending", 
            progress: 0 
          };
          uploads.value.push(item);
          void startVideoUpload(item, keys.pkHex);
        } else {
          // For image files, use image upload
          const item: PostEditorUploadItem = { id: toId(), name: f.name, file: f, preview: makePreview(f), status: "pending", progress: 0 };
          uploads.value.push(item);
          void startUpload(item, keys.pkHex);
        }
      }
      input.value = "";
    }

    function onPaste(e: ClipboardEvent) {
      const text = e.clipboardData?.getData('text');
      if (!text || !text.trim()) return;
      
      // Check if pasted text is a video URL
      const parsed = parseVideoUrl(text);
      if (parsed) {
        // Prevent default paste to avoid pasting the URL in textarea
        e.preventDefault();
        // Set video preview
        videoPreview.value = parsed;
        ui.addToast("已识别视频链接", 1000, "success");
      }
    }
     
    // signEvent wrapper: prefer keys.signEvent -> window.nostr.signEvent -> nostr-tools v2 local signing (skHex)
    async function signEventWrapper(evt: any) {
      // prefer keys store
      if ((keys as any).signEvent && typeof (keys as any).signEvent === "function") {
        return await (keys as any).signEvent(evt);
      }
      // try injected extension
      if ((window as any).nostr && typeof (window as any).nostr.signEvent === "function") {
        return await (window as any).nostr.signEvent(evt);
      }
      // fallback: local nostr-tools v2 using skHex (not recommended on public sites)
      if ((keys as any).skHex && typeof (keys as any).skHex === "string" && (keys as any).skHex.trim().length === 64) {
        try {
          const nt = await import("nostr-tools");
          const sk = (keys as any).skHex as string;
          if (typeof nt.getPublicKey === "function") evt.pubkey = nt.getPublicKey(sk);
          if (typeof nt.getEventHash === "function") evt.id = nt.getEventHash(evt);
          // prefer nt.signEvent if available
          if (typeof nt.signEvent === "function") {
            const maybe = nt.signEvent(evt, sk);
            if (maybe && typeof maybe.then === "function") {
              const res = await maybe;
              return res;
            }
            return maybe;
          }
          // try nt.schnorr.sign (v2)
          if (nt.schnorr && typeof nt.schnorr.sign === "function") {
            const msgHex = evt.id || nt.getEventHash(evt);
            const sig = await nt.schnorr.sign(msgHex, sk);
            evt.sig = typeof sig === "string" ? sig : Array.from(sig).map((b:number)=>b.toString(16).padStart(2,"0")).join("");
            return evt;
          }
          // try nt.secp256k1.sign
          if (nt.secp256k1 && typeof nt.secp256k1.sign === "function") {
            const idHex = evt.id || nt.getEventHash(evt);
            const r = await nt.secp256k1.sign(idHex, sk);
            if (r && typeof r === "object" && (r as any).signature) evt.sig = (r as any).signature;
            else if (typeof r === "string") evt.sig = r;
            else evt.sig = String(r);
            return evt;
          }
          throw new Error("nostr-tools v2 没有可用签名函数");
        } catch (e: any) {
          throw new Error("本地签名失败: " + (e && e.message ? e.message : String(e)));
        }
      }
      throw new Error("未找到可用签名器（keys.signEvent / window.nostr / 本地 skHex）");
    }

    async function startUpload(item: PostEditorUploadItem, accountAtStart: string) {
      const file = item.file;
      if (!accountAtStart || !file) return;
      const uploadController = beginUpload(item.id, accountAtStart);
      updateUploadItem(item.id, { status: "uploading", progress: 0, errorShort: undefined, errorDetails: undefined });

      try {
        // 👇 关键：上传前使用智能压缩，目标大小 200-300KB
        console.log(`开始压缩图片: ${file.name}`);
        const compressionResult = await compressImageToTargetSize(file, {
          minTargetSize: 200 * 1024, // 200KB
          maxTargetSize: 300 * 1024, // 300KB
          maxIterations: 10
        });
        
        console.log(
          `压缩结果: ${(compressionResult.originalSize / 1024).toFixed(1)}KB -> ` +
          `${(compressionResult.compressedSize / 1024).toFixed(1)}KB, ` +
          `压缩率: ${(compressionResult.compressionRatio * 100).toFixed(1)}%, ` +
          `迭代次数: ${compressionResult.iterations}`
        );
        
        if (uploadController.signal.aborted) return;
        const compressedFile = compressionResult.file;
        const previewFile = await resizeImageFile(compressedFile, { maxSize: 960, quality: 0.76 });
        const [width, height] = await imageDimensions(compressedFile);
        const [previewWidth, previewHeight] = await imageDimensions(previewFile);
        const [preparedOriginal, preparedPreview] = await Promise.all([
          prepareEncryptedImage(compressedFile),
          prepareEncryptedImage(previewFile),
        ]);
        let originalProgress = 0;
        let previewProgress = 0;
        const reportProgress = () => updateUploadItem(item.id, {
          progress: Math.round(originalProgress * 0.7 + previewProgress * 0.3),
        });
        const [original, preview] = await Promise.all([
          uploadPreparedImage(preparedOriginal, accountAtStart, signEventWrapper, progress => {
            originalProgress = progress;
            reportProgress();
          }, uploadController.signal),
          uploadPreparedImage(preparedPreview, accountAtStart, signEventWrapper, progress => {
            previewProgress = progress;
            reportProgress();
          }, uploadController.signal),
        ]);
        if (uploadController.signal.aborted || discardedUploadIds.has(item.id)) return;
        const previewMetadata: EncryptedImageVariant = {
          url: preview.url,
          mime: preview.mime,
          alg: "AES-GCM",
          iv: preview.iv,
          key: await exportKeyToBase64(preview.key),
          width: previewWidth,
          height: previewHeight,
        };
        const previewEncryptedRef = variantToEncryptedImageRef(previewMetadata);
        await cacheEncryptedPreviewBestEffort(accountAtStart, previewEncryptedRef, previewFile, preview.mime);

        const metadata: EncryptedImageMetadata = {
          v: 2,
          url: original.url,
          mime: original.mime,
          alg: "AES-GCM",
          iv: original.iv,
          key: await exportKeyToBase64(original.key),
          width,
          height,
          preview: previewMetadata,
        };
        const encryptedRef = encodeEncryptedImageRef(metadata);
        const completedImage: PostDraftImage = {
          id: item.id,
          name: item.name,
          encryptedRef,
          previewEncryptedRef,
          mime: original.mime,
          width,
          height,
        };
        if (discardedUploadIds.has(item.id)) return;
        mergeCompletedPostDraftImage(accountAtStart, completedImage);

        if (keys.pkHex !== accountAtStart || !ui.showPostEditor) return;
        const patch: Partial<PostEditorUploadItem> = {
          url: original.url,
          status: "done",
          progress: 100,
          encryptionKey: original.key,
          encryptionIv: original.iv,
          originalMime: original.mime,
          width,
          height,
          previewUrl: preview.url,
          previewEncryptionKey: preview.key,
          previewEncryptionIv: preview.iv,
          previewMime: preview.mime,
          previewWidth,
          previewHeight,
          previewMetadata,
          previewEncryptedRef,
          encryptedRef,
        };
        if (uploads.value.some(upload => upload.id === item.id)) updateUploadItem(item.id, patch);
        else uploads.value.push({ id: item.id, name: item.name, preview: null, status: "done", progress: 100, ...patch });
        persistDraft(accountAtStart);
      } catch (err:any) {
        if (uploadWasCancelled(err) || uploadController.signal.aborted) return;
        console.error("upload error raw:", err);
        const errorShort = err && err.message ? String(err.message) : "上传失败";
        let errorDetails: string;
        try { errorDetails = err && err.details ? JSON.stringify(err.details, null, 2) : JSON.stringify(err, Object.getOwnPropertyNames(err), 2); } catch { errorDetails = String(err); }
        if (keys.pkHex === accountAtStart && ui.showPostEditor) {
          updateUploadItem(item.id, { status: "error", errorShort, errorDetails });
          ui.addToast(`上传失败: ${errorShort}`, 3000, "error");
        }
      } finally {
        if (activeUploads.get(item.id)?.controller === uploadController) activeUploads.delete(item.id);
      }
    }

    async function startVideoUpload(item: PostEditorUploadItem, accountAtStart: string) {
      const file = item.file;
      if (!accountAtStart || !file) return;
      const uploadController = beginUpload(item.id, accountAtStart);
      updateUploadItem(item.id, { status: "uploading", progress: 0, errorShort: undefined, errorDetails: undefined });

      try {
        const prepared = await prepareEncryptedVideo(file);
        if (uploadController.signal.aborted) return;
        
        // Upload encrypted file with fallback to multiple servers
        const descriptor = await uploadImageToBlossomWithFallback(prepared.encryptedFile, {
          accountPubkey: accountAtStart,
          signEvent: signEventWrapper,
          signal: uploadController.signal,
          onProgress: (p:number) => {
            if (!uploadController.signal.aborted) updateUploadItem(item.id, { progress: p });
          }
        });
        
        if (uploadController.signal.aborted || discardedUploadIds.has(item.id)) return;
        // Export encryption key to base64
        const keyBase64 = await exportKeyToBase64(prepared.key);
        
        // Create encrypted video reference
        const encryptedRef = encodeEncryptedVideoRef({
          v: 1,
          url: descriptor.url,
          mime: prepared.mime,
          alg: "AES-GCM",
          iv: prepared.iv,
          key: keyBase64,
          size: file.size
        });
        const completedVideo: PostDraftVideo = {
          url: encryptedRef,
          provider: 'Encrypted',
          embedUrl: encryptedRef
        };

        if (discardedUploadIds.has(item.id)) return;
        mergeCompletedPostDraftVideo(accountAtStart, completedVideo);
        if (keys.pkHex !== accountAtStart || !ui.showPostEditor) return;
        videoPreview.value = completedVideo;
        updateUploadItem(item.id, { 
          url: descriptor.url, 
          status: "done", 
          progress: 100,
          encryptionKey: prepared.key,
          encryptionIv: prepared.iv,
          originalMime: prepared.mime
        });
        
        // Remove from uploads list since we show it in videoPreview
        const idx = uploads.value.findIndex(u => u.id === item.id);
        if (idx !== -1) uploads.value.splice(idx, 1);
        persistDraft(accountAtStart);
      } catch (err:any) {
        if (uploadWasCancelled(err) || uploadController.signal.aborted) return;
        console.error("video upload error:", err);
        const errorShort = err && err.message ? String(err.message) : "上传失败";
        let errorDetails: string;
        try { errorDetails = err && err.details ? JSON.stringify(err.details, null, 2) : JSON.stringify(err, Object.getOwnPropertyNames(err), 2); } catch { errorDetails = String(err); }
        if (keys.pkHex === accountAtStart && ui.showPostEditor) {
          updateUploadItem(item.id, { status: "error", errorShort, errorDetails });
          ui.addToast(`视频上传失败: ${errorShort}`, 3000, "error");
        }
      } finally {
        if (activeUploads.get(item.id)?.controller === uploadController) activeUploads.delete(item.id);
      }
    }

    function insertImageUrl(item: PostEditorUploadItem) {
      if (item.status === "done" && item.url) {
        if (content.value.length>0 && !content.value.endsWith("\n")) content.value += "\n";
        content.value += `![](${item.url})\n`;
      }
    }

    function removeUpload(idx:number) {
      const item = uploads.value[idx];
      if (item) cancelUpload(item.id);
      releaseObjectUrl(item?.preview);
      uploads.value.splice(idx, 1);
    }

    function resetRuntimeEditor() {
      releasePostEditorMediaUrls(uploads.value, videoPreview.value);
      content.value = "";
      error.value = null;
      pendingPostRetry.value = null;
      allFriends.value = false;
      selectedGroups.value = [];
      audienceChosen.value = false;
      visibilityError.value = false;
      visibilityOpen.value = true;
      dismissAudienceConfirmation();
      cancelSheetOpen.value = false;
      uploads.value = [];
      videoPreview.value = null;
      sheetDragging.value = false;
      sheetOffset.value = 0;
    }

    // Internal navigation/locking/send close. The explicit cancel control uses
    // requestCancel instead, so draft decisions never appear on normal posting.
    function onClose() {
      ui.closePostEditor();
    }

    function continueEditing() {
      cancelSheetOpen.value = false;
    }
    function saveAndClose() {
      cancelSheetOpen.value = false;
      persistDraft();
      onClose();
    }
    function requestCancel() {
      if (sending.value) return;
      sheetOffset.value = 0;
      if (confirmAllFriends.value) {
        cancelAllFriendsConfirmation();
        return;
      }
      if (cancelSheetOpen.value) {
        continueEditing();
        return;
      }
      // Do not create an empty draft when the user cancels an untouched editor.
      const hasDraftContent = content.value.length > 0
        || uploads.value.length > 0
        || videoPreview.value !== null
        || !!pendingPostRetry.value;
      if (!hasDraftContent) {
        discardDraft();
        return;
      }
      cancelSheetOpen.value = true;
    }
    async function insertMentionTrigger() {
      const field = textarea.value;
      if (!field || pendingPostRetry.value) return;
      const start = field.selectionStart ?? content.value.length;
      const end = field.selectionEnd ?? start;
      const prefix = start > 0 && !/\\s/.test(content.value[start - 1]) ? " " : "";
      content.value = content.value.slice(0, start) + prefix + "@" + content.value.slice(end);
      const cursor = start + prefix.length + 1;
      await nextTick();
      field.focus();
      field.setSelectionRange(cursor, cursor);
      onMentionInput();
    }
    watch(cancelSheetOpen, async open => {
      if (!open) return;
      await nextTick();
      cancelContinueButton.value?.focus();
    });

    function clearPersistentDraft(account: string) {
      for (const item of uploads.value) discardedUploadIds.add(item.id);
      cancelUploadsForAccount(account);
      draftPersistenceEnabled = false;
      clearPostDraft(account);
    }

    function discardDraft() {
      const account = draftAccount || keys.pkHex;
      if (account) clearPersistentDraft(account);
      resetRuntimeEditor();
      ui.closePostEditor();
    }

    function onSheetPointerDown(event: PointerEvent) {
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      dragCandidate = (editorBody.value?.scrollTop || 0) <= 0;
      dragStartY = event.clientY;
      dragStartAt = performance.now();
      dragPointerId = event.pointerId;
      sheetOffset.value = 0;
    }

    function onSheetPointerMove(event: PointerEvent) {
      if (!dragCandidate || dragPointerId !== event.pointerId) return;
      const deltaY = event.clientY - dragStartY;
      if (!sheetDragging.value) {
        if (deltaY < -6 || (editorBody.value?.scrollTop || 0) > 0) {
          dragCandidate = false;
          return;
        }
        if (deltaY < 6 || !canStartPostEditorDrag(editorBody.value?.scrollTop || 0, deltaY)) return;
        sheetDragging.value = true;
        editorCard.value?.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      sheetOffset.value = Math.max(0, deltaY);
    }

    function finishSheetDrag(event: PointerEvent, cancelled: boolean) {
      if (dragPointerId !== event.pointerId) return;
      const wasDragging = sheetDragging.value;
      const distance = sheetOffset.value;
      const elapsed = Math.max(1, performance.now() - dragStartAt);
      const velocity = distance / elapsed;
      dragCandidate = false;
      dragPointerId = null;
      sheetDragging.value = false;
      if (!wasDragging) return;

      suppressSheetClick = true;
      window.setTimeout(() => { suppressSheetClick = false; }, 0);
      sheetOffset.value = 0;
      if (!cancelled && shouldDismissPostEditor(distance, velocity, editorCard.value?.offsetHeight || 0)) {
        requestCancel();
      }
    }

    function onSheetPointerEnd(event: PointerEvent) {
      finishSheetDrag(event, false);
    }

    function onSheetPointerCancel(event: PointerEvent) {
      finishSheetDrag(event, true);
    }

    function onSheetClickCapture(event: MouseEvent) {
      if (!suppressSheetClick) return;
      event.preventDefault();
      event.stopPropagation();
    }

    // Store the element that triggered the modal for focus return
    let triggerElement: HTMLElement | null = null;
    let openGeneration = 0;

    // Initialize when modal opens
    watch(() => ui.showPostEditor, async (show) => {
      const generation = ++openGeneration;
      document.body.classList.toggle("post-editor-open", show);
      if (show) {
        // Store currently focused element to return focus later
        triggerElement = document.activeElement as HTMLElement;
        
        const accountAtOpen = keys.pkHex;
        await checkBlossom();
        if (!accountAtOpen) {
          ui.closePostEditor();
          ui.addToast("请先登录", 2000, "error");
          return;
        }
        await friends.load();
        await friendships.load();
        await msgs.load();
        if (generation !== openGeneration || !ui.showPostEditor || keys.pkHex !== accountAtOpen) return;
        draftAccount = accountAtOpen;
        const draft = loadPostDraft(accountAtOpen);
        content.value = draft?.content || "";
        const restoredGroups = normalizeSelectedAudienceGroups(draft?.selectedGroups || [], groups.value);
        allFriends.value = !!draft?.audienceChosen && !!draft.allFriends && postAudienceFriends.value.length > 0;
        selectedGroups.value = allFriends.value ? [] : restoredGroups;
        // Deleted groups must never silently turn a targeted draft into a self-only post.
        audienceChosen.value = !!draft?.audienceChosen && (
          allFriends.value || (draft.selectedGroups.length === 0 && !draft.allFriends) || restoredGroups.length > 0
        );
        visibilityOpen.value = !!audienceChosen.value && !allFriends.value && selectedGroups.value.length > 0;
        uploads.value = restoreDraftImageUploads(draft?.images || []);
        videoPreview.value = draft?.video || null;
        draftPersistenceEnabled = true;
        await nextTick();
        // Focus overlay to enable keyboard events (ESC key)
        if (overlay.value) {
          overlay.value.focus();
        }
        // Don't auto-focus textarea to avoid mobile keyboard popup
        // Users can manually click the textarea when ready to type
      } else {
        closeMention();
        // The editor may also be closed by bottom navigation or another
        // programmatic route change, so cleanup cannot live only in onClose().
        persistDraft();
        draftPersistenceEnabled = false;
        draftAccount = "";
        resetRuntimeEditor();
        // Return focus to trigger element when modal closes
        if (triggerElement && typeof triggerElement.focus === 'function') {
          setTimeout(() => {
            triggerElement?.focus();
          }, 100);
        }
      }
    }, { immediate: true });

    watch(groups, availableGroups => {
      if (allFriends.value || selectedGroups.value.length === 0) return;
      const normalizedGroups = normalizeSelectedAudienceGroups(selectedGroups.value, availableGroups);
      if (normalizedGroups.length !== selectedGroups.value.length
        || normalizedGroups.some((group, index) => group !== selectedGroups.value[index])) {
        selectedGroups.value = normalizedGroups;
        if (!normalizedGroups.length) audienceChosen.value = false;
      }
    });

    watch(postAudienceFriends, list => {
      if (allFriends.value && list.length === 0) {
        allFriends.value = false;
        audienceChosen.value = false;
      }
    });
    watch(
      [
        content,
        allFriends,
        selectedGroups,
        audienceChosen,
        () => uploads.value.map(item => item.encryptedRef || "").join("|"),
        videoPreview,
      ],
      () => persistDraft(),
      { deep: true }
    );
    const persistOnPageHide = () => persistDraft();
    const persistOnVisibilityChange = () => { if (document.visibilityState === "hidden") persistDraft(); };
    window.addEventListener("pagehide", persistOnPageHide);
    document.addEventListener("visibilitychange", persistOnVisibilityChange);

    // PostEditorModal is mounted at App level and otherwise survives route
    // changes. Never leave it covering the destination page.
    watch(() => route.fullPath, () => {
      if (ui.showPostEditor) onClose();
    });
    watch(() => keys.pkHex, account => {
      for (const [id, active] of activeUploads) {
        if (active.account !== account) cancelUpload(id);
      }
      if (ui.showPostEditor && draftAccount && account !== draftAccount) onClose();
    });

    onBeforeUnmount(()=>{
      stopBeforeLock();
      openGeneration += 1;
      cancelAllUploads();
      persistDraft();
      window.removeEventListener("pagehide", persistOnPageHide);
      document.removeEventListener("visibilitychange", persistOnVisibilityChange);
      document.body.classList.remove("post-editor-open");
      releasePostEditorMediaUrls(uploads.value, videoPreview.value);
    });

    async function onSend(confirmedAllFriends = false) {
      if (sending.value) return;
      // Use pkHex check for consistency with onMounted and reliability
      if (!keys.pkHex) { error.value = "请先登录"; return; }
      if (!pendingPostRetry.value && !canSend.value) { error.value = "请输入内容"; return; }
      if (uploadingAny.value) { error.value = "请等待媒体上传完成"; return; }
      if (!pendingPostRetry.value) {
        const validAudience = audienceChosen.value && (
          (!allFriends.value && selectedGroups.value.length === 0)
          || recipients.value.length > 0
        );
        if (!validAudience) {
          dismissAudienceConfirmation();
          visibilityError.value = true;
          visibilityOpen.value = true;
          error.value = "请先选择可见范围";
          await nextTick();
          visibilityRow.value?.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
        if (allFriends.value) {
          const signature = recipients.value.slice().sort().join(",");
          if (!confirmedAllFriends || confirmationRecipients.value !== signature) {
            confirmationRecipients.value = signature;
            confirmAllFriends.value = true;
            return;
          }
        }
      }
      dismissAudienceConfirmation();
      const accountAtSend = keys.pkHex;
      sending.value = true;
      error.value = null;

      if (pendingPostRetry.value) {
        const retry = pendingPostRetry.value;
        try {
          const { message } = await posts.retryDirectMessage(retry.outgoingId);
          msgs.addInbox({
            id: message.id,
            pubkey: accountAtSend,
            created_at: message.createdAt,
            content: message.plaintext || "",
            protocol: message.protocol,
            transportKind: message.transportKind,
            transportEventId: message.transportEventId,
            rumorId: message.rumorId,
            recipientPubkeys: message.recipientPubkeys,
            conversationId: message.conversationId,
            tags: message.tags,
            _localMeta: {
              groupCount: retry.groupsMeta.length,
              groups: retry.groupsMeta
            }
          });
          pendingPostRetry.value = null;
          ui.addToast("已发布", 1_400, "success");
          clearPersistentDraft(accountAtSend);
          onClose();
          setTimeout(()=>{ router.push('/'); }, 220);
        } catch (e:any) {
          console.error("post retry error", e);
          error.value = e && e.message ? e.message : "发送失败";
          ui.addToast("重新发送失败", 2000, "error");
        } finally {
          sending.value = false;
        }
        return;
      }

      let recips = recipients.value.slice();
      if (botMentioned.value) recips.push(HAINEI_BOT_PUBKEY);
      if (keys.pkHex && !recips.includes(keys.pkHex)) recips.push(keys.pkHex);
      recips = Array.from(new Set(recips.filter(Boolean)));

      if (recips.length === 0) { error.value = "未指定收件人"; sending.value = false; return; }

      const groupsMeta = audienceGroupsMeta(
        postAudienceFriends.value,
        allFriends.value,
        selectedGroups.value
      );

      try {
        // Build content with uploaded images appended
        let fullContent = content.value;
        const uploadedImages = uploads.value.filter(u => u.status === 'done' && (u.encryptedRef || u.url));
        if (uploadedImages.length > 0) {
          // Add images as markdown at the end
          if (fullContent.length > 0 && !fullContent.endsWith("\n")) fullContent += "\n";
          for (const img of uploadedImages) {
            if (img.encryptedRef) {
              fullContent += `![](${img.encryptedRef})\n`;
              continue;
            }
            // Create encrypted image reference
            if (img.encryptionKey && img.encryptionIv && img.originalMime) {
              // Export key to raw bytes
              const keyBytes = await crypto.subtle.exportKey("raw", img.encryptionKey);
              const keyBase64 = bytesToBase64(new Uint8Array(keyBytes));
              
              const metadata: EncryptedImageMetadata = {
                v: img.previewUrl && img.previewEncryptionKey && img.previewEncryptionIv ? 2 : 1,
                url: img.url,
                mime: img.originalMime,
                alg: "AES-GCM",
                iv: img.encryptionIv,
                key: keyBase64,
                width: img.width,
                height: img.height,
              };
              if (img.previewMetadata) {
                metadata.preview = img.previewMetadata;
              } else if (img.previewUrl && img.previewEncryptionKey && img.previewEncryptionIv && img.previewMime) {
                metadata.preview = {
                  url: img.previewUrl, mime: img.previewMime, alg: "AES-GCM", iv: img.previewEncryptionIv,
                  key: await exportKeyToBase64(img.previewEncryptionKey), width: img.previewWidth, height: img.previewHeight,
                };
              }
              
              const encryptedRef = encodeEncryptedImageRef(metadata);
              fullContent += `![](${encryptedRef})\n`;
            } else {
              // Fallback to plain URL (shouldn't happen with new code)
              fullContent += `![](${img.url})\n`;
            }
          }
        }
        
        // Add video if present
        if (videoPreview.value) {
          if (fullContent.length > 0 && !fullContent.endsWith("\n")) fullContent += "\n";
          // Store video metadata as JSON in a special format using constants
          const videoData = {
            type: 'video',
            url: videoPreview.value.url,
            provider: videoPreview.value.provider,
            embedUrl: videoPreview.value.embedUrl
          };
          fullContent += `${VIDEO_METADATA_PREFIX}${JSON.stringify(videoData)}${VIDEO_METADATA_SUFFIX}\n`;
        }
        
        // Queue the complete signed NIP-17 message first. This returns after the
        // durable IndexedDB write; DM Relay discovery, publish and ACK continue
        // in the background and no longer block the composer/Home transition.
        const recipientSet = new Set(recips.map(pubkey => pubkey.toLowerCase()));
        const mentionRecipients = mentionedPubkeys().filter(pubkey => recipientSet.has(pubkey.toLowerCase()));
        const { message } = await posts.queuePost(
          recips,
          fullContent,
          undefined,
          mentionTags(mentionRecipients),
        );

        // Render the queued post immediately. Relay state events update this
        // optimistic item to sent/failed without changing its logical message id.
        msgs.addInbox({
          id: message.id,
          pubkey: accountAtSend,
          created_at: message.createdAt,
          content: fullContent,
          protocol: message.protocol,
          transportKind: message.transportKind,
          transportEventId: message.transportEventId,
          rumorId: message.rumorId,
          recipientPubkeys: message.recipientPubkeys,
          conversationId: message.conversationId,
          tags: message.tags,
          outgoing: {
            localId: message.id,
            state: "sending",
            hasImage: uploadedImages.length > 0,
          },
          _localMeta: {
            groupCount: groupsMeta.length,
            groups: groupsMeta
          }
        });

        clearPersistentDraft(accountAtSend);
        posts.startQueuedPostDelivery(message.id);
        ui.addToast("正在发送", 1_200, "info");
        onClose();
        // Do not wait for the sheet animation or Relay ACK before showing Home.
        void router.push('/');
      } catch (e:any) {
        console.error("publish error", e);
        if (e?.outgoingId) {
          pendingPostRetry.value = { outgoingId: String(e.outgoingId), groupsMeta };
        }
        error.value = e && e.message ? e.message : "发送失败";
        ui.addToast(e?.outgoingId ? "发送未完成，可重新发送" : "发送失败", 2200, "error");
      } finally {
        sending.value = false;
      }
    }

    return {
      visible, content, sending, pendingPostRetry, allFriends, selectedGroups, audienceChosen, visibilityError,
      visibilityRow, confirmAllFriends, cancelAllFriendsConfirmation, chooseSelf, chooseGroups, recipients, groups, countByGroup,
      keys, ownName, cancelSheetOpen, cancelContinueButton, requestCancel, saveAndClose, continueEditing, insertMentionTrigger,
      canSend, textarea, overlay, editorCard, editorBody, error, onSend, onClose, discardDraft, toggleAll, toggleGroup,
      recipientsCount, botMentioned, selectedSet, gLabel, acceptedFriends, postAudienceFriends, uploads, uploadEnabled, uploadingAny,
      visibilityOpen, visibilitySummary,
      onFilesSelected, insertImageUrl, removeUpload, checkBlossom,
      sheetDragging, sheetStyle, onSheetPointerDown, onSheetPointerMove, onSheetPointerEnd,
      onSheetPointerCancel, onSheetClickCapture,
      // @ mention composer
      mentionOpen, mentionMatches, mentionActiveIndex,
      onMentionInput, onMentionFocus, onMentionClick, onMentionBlur, onMentionKeydown,
      selectMention,
      // Video support
      videoPreview, removeVideo, onPaste
    };
  }
});
</script>

<style scoped>
/* Global box-sizing for all elements to prevent width issues */
* {
  box-sizing: border-box;
}

/* overlay and modal */
.editor-overlay {
  position: fixed;
  inset: 0;
  /* Reserve space for the mobile bottom navigation. */
  bottom: var(--bottom-nav-height);
  display: flex;
  align-items: flex-end; /* start from bottom */
  justify-content: center;
  background: rgba(15, 23, 42, 0.38);
  z-index: 2000;
  outline: none;
}

.editor-card {
  position: relative;
  width: 100%;
  max-width: 720px;
  background: #fff;
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.12);
  transform: translateY(0);
  box-sizing: border-box;
  contain: layout paint;
  touch-action: pan-y;
  will-change: transform;
  transition: transform 220ms cubic-bezier(.2,.8,.2,1);
}
.editor-card.dragging { transition: none; }

/* header */
.editor-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 16px 12px;
  border-bottom: 1px solid #eee;
  touch-action: none;
  cursor: grab;
}
.editor-card.dragging .editor-header { cursor: grabbing; }
.drag-handle { width: 38px; height: 5px; border-radius: 999px; background: #cbd5e1; }
.icon-btn {
  background: transparent;
  border: none;
  font-size: 18px;
  cursor: pointer;
}
.title {
  font-weight: 600;
}

/* body */
.editor-body {
  padding: 14px 16px 18px;
  max-height: 70vh;
  overflow-y: auto;
  box-sizing: border-box;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.editor-textarea-wrap{position:relative}
.editor-textarea {
  width: 100%;
  min-height: 140px;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  resize: vertical;
  font-size: 16px;
  box-sizing: border-box;
  /* Better mobile input handling */
  -webkit-appearance: none;
  touch-action: manipulation;
}
.meta-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* upload panel */
.upload-panel {
  margin-top: 12px;
}
.upload-controls {
  display:flex;
  align-items:center;
  gap:12px;
  flex-wrap: wrap;
}
.upload-btn {
  background: transparent;
  color: #3b82f6;
  min-height: 42px;
  padding: 10px 13px;
  border-radius: 10px;
  cursor: pointer;
  display: inline-block;
  border: 1px solid #3b82f6;
  transition: all 0.2s ease;
}
.upload-btn:hover {
  background: #3b82f6;
  color: white;
  transform: translateY(-1px);
}
.upload-btn input { display: none; }
.upload-btn.disabled { 
  background: transparent; 
  color: #9ca3af; 
  border: 1px solid #cbd5e1; 
  cursor: not-allowed; 
}
.upload-btn.disabled:hover {
  background: transparent;
  color: #9ca3af;
  transform: none;
}
.check-btn {
  background: transparent;
  color: #3b82f6;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid #3b82f6;
  cursor: pointer;
  transition: all 0.2s ease;
}
.check-btn:hover {
  background: #3b82f6;
  color: white;
  transform: translateY(-1px);
}
.upload-config-hint .ok { color:#16a34a; }
.upload-config-hint .warn { color:#d97706; }

/* previews - horizontal thumbnail layout */
.previews { 
  margin-top: 12px;
  display: flex;
  flex-direction: row;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  -webkit-overflow-scrolling: touch;
}

.preview-item {
  flex-shrink: 0;
}

.thumb-container {
  position: relative;
  width: 100px;
  height: 100px;
  border-radius: 12px;
  overflow: hidden;
  background: #f3f4f6;
  border: 2px solid #e5e7eb;
  transition: all 0.2s ease;
}

.thumb-container:hover {
  border-color: #3b82f6;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15);
}

.thumb-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-container :deep(.post-image-preview),
.thumb-container :deep(.carousel-shell),
.thumb-container :deep(.carousel),
.thumb-container :deep(.carousel-slide) { width:100%; height:100%; margin:0; border-radius:0; }
.thumb-container :deep(.carousel-shell) { max-height:none; aspect-ratio:1 / 1!important; }
.thumb-container :deep(.carousel-image) { width:100%; height:100%; object-fit:cover; }
.thumb-container :deep(.carousel-dots),
.thumb-container :deep(.carousel-counter),
.thumb-container :deep(.carousel-nav) { display:none; }

.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  font-size: 14px;
}

.upload-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.progress-ring {
  position: relative;
  width: 40px;
  height: 40px;
}

.progress-circle {
  transform: rotate(-90deg);
}

.progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 11px;
  font-weight: 600;
}

.error-overlay {
  position: absolute;
  inset: 0;
  background: rgba(239, 68, 68, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
}

.remove-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  transition: all 0.2s ease;
  padding: 4px;
}

.remove-btn svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
}

.remove-btn:hover {
  background: #ef4444;
  transform: scale(1.1);
}

/* Video preview */
.video-preview-item {
  margin-top: 12px;
}

.video-thumb-container {
  position: relative;
  width: 100%;
  min-height: 120px;
  border-radius: 12px;
  overflow: hidden;
  background: #1f2937;
  border: 2px solid #374151;
  transition: all 0.2s ease;
}

.video-thumb-container:hover {
  border-color: #3b82f6;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15);
}

.video-thumbnail-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  min-height: 120px;
}

.video-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.play-icon-large {
  font-size: 48px;
  color: white;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 50%;
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.video-placeholder {
  width: 100%;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #e5e7eb;
  padding: 16px;
  gap: 8px;
}

.play-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.video-info {
  text-align: center;
  width: 100%;
}

.video-provider {
  font-weight: 500;
  font-size: 16px;
  margin-bottom: 4px;
}

.video-info .small {
  color: #9ca3af;
  word-break: break-all;
  font-size: 12px;
}

/* chips UI */
.groups { margin-top:12px; }
.visibility-row {
  width: 100%;
  min-height: 48px;
  margin-top: 14px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 0;
  border-top: 1px solid #edf1f5;
  border-bottom: 1px solid #edf1f5;
  background: transparent;
  color: #1f2937;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.visibility-value { color: #64748b; }
.visibility-required, .visibility-row-error .visibility-value { color: #b91c1c; }
.visibility-error { margin-top: 6px; font-size: 13px; color: #b91c1c; }
.chips-row { 
  display:flex; 
  align-items:center; 
  gap:8px; 
  flex-wrap:nowrap;
}
.chips-scroll { 
  display:flex; 
  gap:8px; 
  overflow-x:auto; 
  padding-bottom:4px;
  flex: 1;
  min-width: 0;
}
.chip { 
  display:inline-flex; 
  align-items:center; 
  gap:8px; 
  padding:6px 10px; 
  background:#f3f6f9; 
  border-radius:999px; 
  border:1px solid transparent; 
  cursor:pointer; 
  font-size:13px; 
  color:#374151; 
  white-space:nowrap;
  flex-shrink: 0;
}
.chip:disabled { opacity:0.5; cursor:default; }
.chip-selected { background: linear-gradient(90deg,#1976d2 0%, #2a9df4 100%); color:white; box-shadow:0 6px 18px rgba(25,118,210,0.12); }
.chip-count { background: rgba(0,0,0,0.06); padding:2px 6px; border-radius:999px; font-size:12px; margin-left:6px; }
.divider { width:1px; height:28px; background: rgba(0,0,0,0.06); margin:0 6px; flex-shrink: 0; }
.recips-info { margin-top:8px; color:#374151; font-size:13px; }
.recips-empty-hint { margin-top: 6px; }
.audience-confirm-backdrop {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: rgba(15, 23, 42, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.audience-confirm-dialog {
  width: min(100%, 360px);
  border-radius: 16px;
  background: white;
  box-shadow: 0 12px 40px rgba(0,0,0,0.18);
  padding: 20px;
  color: #1f2937;
}
.audience-confirm-dialog h3 { font-size: 17px; margin: 0 0 10px; }
.audience-confirm-dialog p { font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
.audience-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }

/* action buttons */
.action-buttons {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}

.discard-btn,
.save-draft-btn {
  background: transparent;
  min-height: 42px;
  padding: 8px 12px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}
.discard-btn { margin-right:auto; border:0; color:#dc2626; }
.save-draft-btn { border:1px solid #94a3b8; color:#475569; }

.discard-btn:hover { background:#fef2f2; }
.save-draft-btn:hover {
  background: #475569;
  color: white;
  transform: translateY(-1px);
}

.send-btn {
  background: transparent;
  color: #3b82f6;
  min-height: 42px;
  padding: 8px 22px;
  border-radius: 10px;
  border: 1px solid #3b82f6;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}
.send-btn:hover {
  background: #3b82f6;
  color: white;
  transform: translateY(-1px);
}
.send-btn[disabled] {
  cursor: not-allowed;
  background: transparent;
  color: #9ca3af;
  border-color: #cbd5e1;
}
.send-btn[disabled]:hover {
  background: transparent;
  color: #9ca3af;
  transform: none;
}

/* footer */
.editor-footer { padding:10px 12px 20px; border-top:1px solid #f3f6f8; }

/* Keep the opening response short and compositor-only on mobile. */
.slide-up-enter-active {
  transition: transform 180ms ease-out, opacity 160ms ease-out;
}

.slide-up-leave-active {
  transition: transform 160ms ease-in, opacity 140ms ease-in;
}

.slide-up-enter-from {
  transform: translateY(100%);
  opacity: 0;
}

.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

.slide-up-enter-to, .slide-up-leave-from {
  transform: translateY(0%);
  opacity: 1;
}

/* responsive */
@media (min-width:768px) {
  .editor-overlay {
    bottom: 0;
    align-items: center;
    padding: 24px;
  }
  .editor-card { 
    border-radius: 16px;
    max-height: calc(100dvh - 48px);
  }
  .editor-body {
    max-height: calc(100dvh - 132px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .slide-up-enter-active,
  .slide-up-leave-active,
  .upload-btn,
  .send-btn,
  .discard-btn,
  .save-draft-btn,
  .editor-card { transition: none; }
}
.error { margin-top:8px; color:#d00; font-size:13px; }
.small { color:#64748b; font-size:12px; }

/* Redesigned dynamic composer: readable, privacy-first, and narrow-screen safe. */
.editor-card {
  display: flex;
  flex-direction: column;
  height: min(86dvh, 800px);
  max-height: calc(100dvh - var(--bottom-nav-height, 64px) - 12px);
  overflow: hidden;
}
.editor-header {
  display: block;
  flex: 0 0 auto;
  padding: 10px 20px 12px;
  background: #fff;
}
.editor-header .drag-handle { margin: 0 auto 12px; }
.editor-header-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 64px;
  align-items: center;
  min-height: 36px;
}
.header-cancel {
  justify-self: start;
  border: 0;
  background: transparent;
  padding: 8px 2px;
  color: #475569;
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}
.header-cancel:disabled { opacity: .45; }
.editor-header .title { text-align: center; font-size: 16px; font-weight: 700; color: #0f172a; }
.editor-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  max-height: none;
  padding: 18px 20px calc(14px + env(safe-area-inset-bottom, 0px));
  overflow-x: hidden;
  overflow-y: auto;
}
.editor-author { display: flex; gap: 12px; align-items: center; min-width: 0; margin-bottom: 12px; }
.editor-author-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.editor-author-copy strong {
  color: #0f172a; font-size: 16px; font-weight: 700;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.editor-author-copy span { color: #64748b; font-size: 13px; }
.editor-textarea-wrap { flex: 1 0 145px; min-height: 145px; min-width: 0; }
.editor-textarea {
  display: block;
  height: 100%;
  min-height: 145px;
  width: 100%;
  resize: none;
  border: 0;
  outline: none;
  border-radius: 0;
  padding: 12px 0;
  color: #0f172a;
  background: transparent;
  font-size: 17px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.editor-textarea::placeholder { color: #94a3b8; }
.editor-textarea:focus-visible { outline: none; }
.upload-panel { margin: 0; }
.upload-panel:has(.previews:empty), .previews:empty { display: none; }
.previews { margin: 0 0 8px; }
.video-preview-item { margin: 0 0 10px; }
.audience-section {
  margin-top: 4px;
  padding-top: 18px;
  border-top: 1px solid #e9edf1;
}
.audience-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.audience-heading h3 { margin: 0; color: #0f172a; font-size: 15px; font-weight: 700; }
.audience-required { color: #b91c1c; font-size: 12px; font-weight: 650; white-space: nowrap; }
.audience-required.chosen { color: #64748b; }
.audience-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.audience-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-width: 0;
  min-height: 102px;
  padding: 10px 3px;
  border: 1px solid #dce2e8;
  border-radius: 15px;
  background: #fff;
  color: #334155;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.audience-card svg {
  width: 22px; height: 22px; fill: none;
  stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
.audience-card span { max-width: 100%; white-space: nowrap; }
.audience-card small {
  position: absolute; top: 6px; right: 8px; color: #2563eb; font-size: 12px;
}
.audience-card.selected { border: 2px solid #2563eb; background: #f1f7ff; color: #1d4ed8; }
.audience-card.expanded:not(.selected) { border-color: #94a3b8; }
.audience-card:disabled { opacity: .4; cursor: not-allowed; }
.group-picker { padding: 12px 0 0; }
.group-picker-title { margin: 0 0 10px; color: #475569; font-size: 12px; }
.group-options { display: flex; flex-wrap: wrap; gap: 8px; }
.group-option {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 100%; padding: 8px 10px; border: 1px solid #dce2e8;
  border-radius: 999px; background: #fff; color: #475569; font-size: 12px;
  cursor: pointer;
}
.group-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-option small { white-space: nowrap; color: inherit; opacity: .7; }
.group-option.selected { color: #1d4ed8; border-color: #2563eb; background: #f1f7ff; }
.group-picker-empty, .audience-summary, .audience-bot-hint {
  margin: 9px 0 0; color: #64748b; font-size: 12px; line-height: 1.5;
}
.audience-summary.muted { color: #94a3b8; }
.audience-bot-hint { font-size: 11px; }
.audience-section-error .audience-heading h3 { color: #991b1b; }
.composer-toolbar {
  position: sticky;
  z-index: 2;
  bottom: -1px;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 58px;
  margin-top: 16px;
  padding: 10px 0 0;
  border-top: 1px solid #eef2f6;
  background: #fff;
}
.composer-tools { display: flex; align-items: center; gap: 5px; }
.composer-tool {
  position: relative;
  display: grid;
  width: 42px; height: 42px;
  flex: 0 0 42px;
  place-items: center;
  overflow: hidden;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #2563eb;
  font: inherit;
  font-size: 26px;
  cursor: pointer;
}
.composer-tool:focus-visible, .audience-card:focus-visible, .group-option:focus-visible, .send-btn:focus-visible {
  outline: 2px solid #2563eb; outline-offset: 2px;
}
.composer-tool svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linejoin: round; }
.composer-tool input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.composer-tool.disabled, .composer-tool:disabled { opacity: .35; pointer-events: none; }
.sr-only {
  position: absolute;
  width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.composer-toolbar .send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 44px;
  padding: 9px 17px;
  border: 1px solid #0f172a;
  border-radius: 999px;
  background: #0f172a;
  color: #fff;
  font-size: 14px;
  font-weight: 650;
  white-space: nowrap;
}
.composer-toolbar .send-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.composer-toolbar .send-btn:hover { background: #1e293b; border-color: #1e293b; }
.composer-toolbar .send-btn:disabled { opacity: .42; background: #0f172a; color: #fff; border-color: #0f172a; }
.cancel-sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 14px;
  background: rgba(15, 23, 42, .42);
}
.cancel-sheet {
  width: min(100%, 460px);
  padding: 20px 18px 18px;
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 16px 48px rgba(15,23,42,.22);
  text-align: center;
}
.cancel-sheet h3 { margin: 0; color: #0f172a; font-size: 17px; }
.cancel-sheet p { margin: 8px 0 16px; color: #64748b; font-size: 13px; }
.cancel-sheet button {
  display: block;
  width: 100%;
  min-height: 48px;
  margin-top: 9px;
  border: 0;
  border-radius: 999px;
  background: #f1f5f9;
  color: #0f172a;
  font: inherit;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
}
.cancel-sheet .cancel-sheet-save { background: #2563eb; color: #fff; }
.cancel-sheet .cancel-sheet-discard { color: #dc2626; }
.cancel-sheet button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
@media (min-width: 768px) {
  .editor-card { height: min(82dvh, 800px); max-height: calc(100dvh - 48px); }
}
@media (max-width: 360px) {
  .editor-body { padding-right: 14px; padding-left: 14px; }
  .audience-cards { gap: 6px; }
  .audience-card { font-size: 12px; min-height: 96px; }
  .composer-toolbar .send-btn { padding: 9px 14px; }
}

</style>
