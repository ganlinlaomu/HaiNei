<template>
  <transition name="slide-up">
    <div class="editor-overlay" v-if="visible" @keydown.esc="onClose" @click.self="onClose" tabindex="-1" ref="overlay">
      <div
        ref="editorCard"
        class="editor-card"
        :class="{ dragging: sheetDragging }"
        :style="sheetStyle"
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
          <div class="title">发帖</div>
        </header>

        <main ref="editorBody" class="editor-body">
          <textarea
            v-model="content"
            ref="textarea"
            class="editor-textarea"
            placeholder="分享此刻…"
            rows="8"
            @paste="onPaste"
          ></textarea>

          <!-- 图片/视频上传区域 -->
          <div class="upload-panel">
            <div class="upload-controls">
              <label
                class="upload-btn"
                :class="{ disabled: !uploadEnabled || uploadingAny }"
                :title="uploadEnabled ? (uploadingAny ? '上传中…' : '添加照片或视频') : '请先在设置中配置媒体服务'"
              >
                <input type="file" accept="image/*,video/*" multiple @change="onFilesSelected" :disabled="!uploadEnabled || uploadingAny" />
                添加照片或视频
              </label>
              <div v-if="!uploadEnabled" class="upload-config-hint small">请先在设置中配置图片与视频服务</div>
            </div>

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

          <button class="visibility-row" type="button" :aria-expanded="visibilityOpen" @click="visibilityOpen = !visibilityOpen">
            <span>可见范围</span>
            <span class="visibility-value">{{ visibilitySummary }} <span aria-hidden="true">›</span></span>
          </button>

          <div v-if="visibilityOpen" class="groups">
            <div class="chips-row">
              <button
                class="chip"
                :class="{ 'chip-selected': allFriends }"
                @click="toggleAll()"
                type="button"
                :aria-pressed="String(allFriends)"
              >
                全部好友
                <span class="chip-count">{{ acceptedFriends.length }}</span>
              </button>
              <div class="divider"></div>
              <div class="chips-scroll" role="list">
                <button
                  v-for="g in groups"
                  :key="g"
                  class="chip"
                  :class="{ 'chip-selected': selectedSet.has(g) }"
                  @click="toggleGroup(g)"
                  role="listitem"
                  type="button"
                >
                  <span class="group-name">{{ gLabel(g) }}</span>
                  <span class="chip-count">{{ countByGroup[g] || 0 }}</span>
                </button>
              </div>
            </div>

            <div class="recips-info">
              目标人数：<strong>{{ recipientsCount }}</strong>
            </div>
            <div v-if="acceptedFriends.length === 0" class="small recips-empty-hint">
              暂无可发送的好友，当前仅会发送给自己。请先添加并完成好友确认。
            </div>
          </div>

          <!-- 草稿和发送操作 -->
          <div class="action-buttons">
            <button class="discard-btn" type="button" @click="discardDraft">丢弃草稿</button>
            <button class="save-draft-btn" type="button" @click="onClose">保存草稿</button>
            <button class="send-btn" :disabled="sending || uploadingAny || !canSend" @click="onSend">
              {{ sending ? "发送中..." : "发送" }}
            </button>
          </div>

          <div v-if="error" class="error">{{ error }}</div>
        </main>

      </div>
    </div>
  </transition>
</template>

<script lang="ts">
import { defineComponent, ref, onBeforeUnmount, watch, nextTick, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { usePostsStore } from "@/stores/posts";
import { useMessagesStore } from "@/stores/messages";
import { useUIStore } from "@/stores/ui";
import PostImagePreview from "@/components/PostImagePreview.vue";
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
  components: { PostImagePreview },
  setup() {
    const router = useRouter();
    const route = useRoute();
    const keys = useKeyStore();
    const friends = useFriendsStore();
    const friendships = useFriendshipsStore();
    const posts = usePostsStore();
    const msgs = useMessagesStore();
    const ui = useUIStore();

    const visible = computed(() => ui.showPostEditor);
    const content = ref("");
    const sending = ref(false);
    const error = ref<string | null>(null);
    const textarea = ref<HTMLTextAreaElement | null>(null);
    const overlay = ref<HTMLElement | null>(null);
    const editorCard = ref<HTMLElement | null>(null);
    const editorBody = ref<HTMLElement | null>(null);
    const sheetDragging = ref(false);
    const sheetOffset = ref(0);
    const sheetStyle = computed(() => ({ transform: `translateY(${sheetOffset.value}px)` }));
    let dragCandidate = false;
    let dragStartY = 0;
    let dragStartAt = 0;
    let dragPointerId: number | null = null;
    let suppressSheetClick = false;
    let dismissTimer: number | null = null;

    // recipients selection state
    const allFriends = ref(true);
    const selectedGroups = ref<Array<string>>([]);
    const visibilityOpen = ref(false);
    let draftPersistenceEnabled = false;
    let draftAccount = "";

    function persistDraft(account = draftAccount) {
      if (!draftPersistenceEnabled || !account) return;
      savePostDraft(account, {
        content: content.value,
        allFriends: allFriends.value,
        selectedGroups: [...selectedGroups.value],
        images: serializeCompletedDraftImages(uploads.value),
        video: videoPreview.value,
      });
    }

    const canSend = computed(() => {
      const hasText = content.value.trim().length > 0;
      const hasUploadedImages = uploads.value.some(u => u.status === 'done' && u.encryptedRef);
      const hasVideo = videoPreview.value !== null;
      return hasText || hasUploadedImages || hasVideo;
    });

    const acceptedFriends = computed(() => friends.getAcceptedList(friendships.isAccepted));

    // groups derived from accepted friends list
    const groups = computed(() => {
      const list = acceptedFriends.value;
      const order: string[] = [];
      const seen = new Set<string>();
      for (const f of list) {
        const tags = getFriendTags(f);
        for (const g of tags) {
          if (!seen.has(g)) {
            seen.add(g);
            order.push(g);
          }
        }
      }
      return order;
    });

    const countByGroup = computed(() => {
      const map: Record<string, number> = {};
      const list = acceptedFriends.value;
      for (const f of list) {
        const tags = getFriendTags(f);
        for (const g of tags) {
          map[g] = (map[g] || 0) + 1;
        }
      }
      return map;
    });

    const selectedSet = computed(() => new Set(selectedGroups.value || []));

    // Helper function to extract tags from a friend object
    function getFriendTags(friend: { groups?: string[]; group?: string }): string[] {
      return friend.groups && Array.isArray(friend.groups) && friend.groups.length > 0 
        ? friend.groups 
        : (friend.group ? [friend.group] : ["未分组"]);
    }

    const recipients = computed(() => {
      const list = acceptedFriends.value;
      if (list.length === 0) return [] as string[];
      if (allFriends.value) return list.map((f: any) => f.pubkey).filter(Boolean);
      const sel = selectedSet.value;
      // Collect all matching friends, using Set to ensure each person is counted only once
      const uniquePubkeys = new Set<string>();
      for (const f of list) {
        const tags = getFriendTags(f);
        // If any tag of the friend is selected, include this friend
        if (tags.some(tag => sel.has(tag))) {
          uniquePubkeys.add(f.pubkey);
        }
      }
      return Array.from(uniquePubkeys);
    });

    const recipientsCount = computed(() => {
      const set = new Set(recipients.value);
      if (keys.pkHex) set.add(keys.pkHex);
      return set.size;
    });

    const visibilitySummary = computed(() => allFriends.value
      ? "全部好友"
      : selectedGroups.value.length > 0 ? `${selectedGroups.value.length} 个分组` : "仅自己可见");

    function gLabel(g: string) {
      return g === "未分组" ? "未分组" : g;
    }

    function toggleAll() {
      allFriends.value = !allFriends.value;
      selectedGroups.value = [];
    }

    function toggleGroup(g: string) {
      if (allFriends.value) {
        allFriends.value = false;
        selectedGroups.value = [g];
        return;
      }
      const idx = selectedGroups.value.indexOf(g);
      if (idx === -1) selectedGroups.value.push(g);
      else selectedGroups.value.splice(idx, 1);
    }

    const uploads = ref<PostEditorUploadItem[]>([]);
    const discardedUploadIds = new Set<string>();
    const activeUploadAccounts = new Map<string, string>();
    const uploadEnabled = ref(false);
    const uploadingAny = computed(() => uploads.value.some(u => u.status === "uploading"));

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
      activeUploadAccounts.set(item.id, accountAtStart);
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
          }),
          uploadPreparedImage(preparedPreview, accountAtStart, signEventWrapper, progress => {
            previewProgress = progress;
            reportProgress();
          }),
        ]);
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
        console.error("upload error raw:", err);
        const errorShort = err && err.message ? String(err.message) : "上传失败";
        let errorDetails: string;
        try { errorDetails = err && err.details ? JSON.stringify(err.details, null, 2) : JSON.stringify(err, Object.getOwnPropertyNames(err), 2); } catch { errorDetails = String(err); }
        if (keys.pkHex === accountAtStart && ui.showPostEditor) {
          updateUploadItem(item.id, { status: "error", errorShort, errorDetails });
          ui.addToast(`上传失败: ${errorShort}`, 3000, "error");
        }
      } finally {
        activeUploadAccounts.delete(item.id);
      }
    }

    async function startVideoUpload(item: PostEditorUploadItem, accountAtStart: string) {
      const file = item.file;
      if (!accountAtStart || !file) return;
      activeUploadAccounts.set(item.id, accountAtStart);
      updateUploadItem(item.id, { status: "uploading", progress: 0, errorShort: undefined, errorDetails: undefined });

      try {
        const prepared = await prepareEncryptedVideo(file);
        
        // Upload encrypted file with fallback to multiple servers
        const descriptor = await uploadImageToBlossomWithFallback(prepared.encryptedFile, {
          accountPubkey: accountAtStart,
          signEvent: signEventWrapper,
          onProgress: (p:number) => { updateUploadItem(item.id, { progress: p }); }
        });
        
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
        console.error("video upload error:", err);
        const errorShort = err && err.message ? String(err.message) : "上传失败";
        let errorDetails: string;
        try { errorDetails = err && err.details ? JSON.stringify(err.details, null, 2) : JSON.stringify(err, Object.getOwnPropertyNames(err), 2); } catch { errorDetails = String(err); }
        if (keys.pkHex === accountAtStart && ui.showPostEditor) {
          updateUploadItem(item.id, { status: "error", errorShort, errorDetails });
          ui.addToast(`视频上传失败: ${errorShort}`, 3000, "error");
        }
      } finally {
        activeUploadAccounts.delete(item.id);
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
      if (item) discardedUploadIds.add(item.id);
      releaseObjectUrl(item?.preview);
      uploads.value.splice(idx, 1);
    }

    function resetRuntimeEditor() {
      releasePostEditorMediaUrls(uploads.value, videoPreview.value);
      content.value = "";
      error.value = null;
      allFriends.value = true;
      selectedGroups.value = [];
      visibilityOpen.value = false;
      uploads.value = [];
      videoPreview.value = null;
      sheetDragging.value = false;
      sheetOffset.value = 0;
    }

    function onClose() {
      ui.closePostEditor();
    }

    function clearPersistentDraft(account: string) {
      for (const item of uploads.value) discardedUploadIds.add(item.id);
      for (const [id, uploadAccount] of activeUploadAccounts) {
        if (uploadAccount === account) discardedUploadIds.add(id);
      }
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
      if (!cancelled && shouldDismissPostEditor(distance, velocity, editorCard.value?.offsetHeight || 0)) {
        sheetOffset.value = editorCard.value?.offsetHeight || window.innerHeight;
        if (dismissTimer !== null) window.clearTimeout(dismissTimer);
        dismissTimer = window.setTimeout(() => {
          dismissTimer = null;
          onClose();
        }, 220);
      } else {
        sheetOffset.value = 0;
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
        allFriends.value = draft?.allFriends ?? true;
        selectedGroups.value = (draft?.selectedGroups || []).filter(group => groups.value.includes(group));
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

    watch(
      [
        content,
        allFriends,
        selectedGroups,
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
      if (ui.showPostEditor && draftAccount && account !== draftAccount) onClose();
    });

    onBeforeUnmount(()=>{
      openGeneration += 1;
      persistDraft();
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      window.removeEventListener("pagehide", persistOnPageHide);
      document.removeEventListener("visibilitychange", persistOnVisibilityChange);
      document.body.classList.remove("post-editor-open");
      releasePostEditorMediaUrls(uploads.value, videoPreview.value);
    });

    async function onSend() {
      // Use pkHex check for consistency with onMounted and reliability
      if (!keys.pkHex) { error.value = "请先登录"; return; }
      if (!canSend.value) { error.value = "请输入内容"; return; }
      if (uploadingAny.value) { error.value = "请等待媒体上传完成"; return; }
      const accountAtSend = keys.pkHex;
      sending.value = true;
      error.value = null;

      let recips = recipients.value.slice();
      if (keys.pkHex && !recips.includes(keys.pkHex)) recips.push(keys.pkHex);
      recips = Array.from(new Set(recips.filter(Boolean)));

      if (recips.length === 0) { error.value = "未指定收件人"; sending.value = false; return; }

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
        
        // Calculate group metadata before publishing
        const groupsMeta = allFriends.value
          ? [{ name: "全部好友", count: recipientsCount.value }]
          : selectedGroups.value.map(g => ({
              name: g,
              count: countByGroup.value[g] || 0
            }));
        
        // Publish the message to relays
        const { message } = await posts.sendDirectMessage(recips, fullContent);

        // Add message to inbox with _localMeta immediately after publishing
        // This executes as soon as the await resolves, minimizing the race condition
        // window where relay echoes could arrive. The addInbox() method in the store
        // handles duplicate detection and intelligently preserves _localMeta regardless
        // of arrival order.
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
          _localMeta: {
            groupCount: groupsMeta.length,
            groups: groupsMeta
          }
        });

        ui.addToast("发送成功", 1200, "success");
        clearPersistentDraft(accountAtSend);
        onClose();
        // Navigate to home page after modal close animation completes (220ms matches the slide-up-leave-active transition)
        setTimeout(()=>{ router.push('/'); }, 220);
      } catch (e:any) {
        console.error("publish error", e);
        error.value = e && e.message ? e.message : "发送失败";
        ui.addToast("发送失败", 2000, "error");
      } finally {
        sending.value = false;
      }
    }

    return {
      visible, content, sending, allFriends, selectedGroups, groups, countByGroup,
      canSend, textarea, overlay, editorCard, editorBody, error, onSend, onClose, discardDraft, toggleAll, toggleGroup,
      recipientsCount, selectedSet, gLabel, acceptedFriends, uploads, uploadEnabled, uploadingAny,
      visibilityOpen, visibilitySummary,
      onFilesSelected, insertImageUrl, removeUpload, checkBlossom,
      sheetDragging, sheetStyle, onSheetPointerDown, onSheetPointerMove, onSheetPointerEnd,
      onSheetPointerCancel, onSheetClickCapture,
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
</style>
