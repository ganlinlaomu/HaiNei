<template>
  <transition name="slide-up">
    <div class="editor-overlay" v-if="visible" @keydown.esc="onClose" tabindex="-1" ref="overlay">
      <div class="editor-card" role="dialog" aria-modal="true">
        <header class="editor-header">
          <div class="title">发帖</div>
        </header>

        <main class="editor-body">
          <textarea
            v-model="content"
            ref="textarea"
            class="editor-textarea"
            placeholder="写点什么...（将加密发送给你的好友）"
            rows="8"
            @paste="onPaste"
          ></textarea>

          <!-- 图片/视频上传区域 -->
          <div class="upload-panel">
            <div class="upload-controls">
              <label
                class="upload-btn"
                :class="{ disabled: !uploadEnabled || uploadingAny }"
                :title="uploadEnabled ? (uploadingAny ? '上传中...' : '上传图片/视频') : '未配置媒体服务器'"
              >
                <input type="file" accept="image/*,video/*" multiple @change="onFilesSelected" :disabled="!uploadEnabled || uploadingAny" />
                上传图片/视频
              </label>

              <div class="upload-config-hint small">
                Media:
                <span v-if="uploadEnabled" class="ok">已配置</span>
                <span v-else class="warn">未配置（请在设置中添加媒体服务器）</span>
                <button class="check-btn" type="button" @click="checkBlossom" style="margin-left:8px;">检测配置</button>
              </div>
            </div>

            <div class="previews">
              <div v-for="(item, idx) in uploads" :key="item.id" class="preview-item">
                <div class="thumb-container">
                  <img v-if="item.preview" :src="item.preview" class="thumb-image" />
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
                  <button type="button" class="remove-btn" @click="removeUpload(idx)" :aria-label="`删除图片 ${item.file.name}`" :title="item.file.name">
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
              <div class="video-placeholder">
                <div class="play-icon">▶</div>
                <div class="video-info">
                  <div class="video-provider">{{ videoPreview.provider }}</div>
                  <div class="small">{{ videoPreview.url }}</div>
                </div>
              </div>
              <button type="button" class="remove-btn" @click="removeVideo" title="删除视频">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- recipients chips -->
          <div class="meta-row" style="margin-top:12px;">
            <strong>对谁可见</strong>
            <div class="small">默认全部好友；可点击分组进行多选。</div>
          </div>

          <div class="groups">
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
                  :class="{ 'chip-selected': selectedSet.has(g) && !allFriends }"
                  @click="toggleGroup(g)"
                  :disabled="allFriends"
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

          <!-- 发送和取消按钮移到这里 -->
          <div class="action-buttons">
            <button class="cancel-btn" @click="onClose">取消</button>
            <button class="send-btn" :disabled="sending || !canSend" @click="onSend">
              {{ sending ? "发送中..." : "发送" }}
            </button>
          </div>

          <div v-if="error" class="error">{{ error }}</div>
        </main>

        <footer class="editor-footer">
          <div class="small">提示：发出的消息会被加密并发布到已配置的 relays。</div>
        </footer>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from "vue";
import { useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { usePostsStore } from "@/stores/posts";
import { useMessagesStore } from "@/stores/messages";
import { useUIStore } from "@/stores/ui";
import { uploadImageToBlossomWithFallback, getBlossomConfig } from "@/utils/blossom";
import { resizeImageFile } from "@/utils/imageResize";

// Video metadata format constants
const VIDEO_METADATA_PREFIX = '[video:';
const VIDEO_METADATA_SUFFIX = ']';

type UploadItem = {
  id: string;
  file: File;
  preview: string | null;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  url?: string;
  errorShort?: string;
  errorDetails?: string;
};

export default defineComponent({
  name: "PostEditor",
  setup() {
    const router = useRouter();
    const keys = useKeyStore();
    const friends = useFriendsStore();
    const friendships = useFriendshipsStore();
    const posts = usePostsStore();
    const msgs = useMessagesStore();
    const ui = useUIStore();

    const visible = ref(true);
    const content = ref("");
    const sending = ref(false);
    const error = ref<string | null>(null);
    const textarea = ref<HTMLTextAreaElement | null>(null);
    const overlay = ref<HTMLElement | null>(null);

    // recipients selection state
    const allFriends = ref(true);
    const selectedGroups = ref<Array<string>>([]);

    const canSend = computed(() => {
      const hasText = content.value.trim().length > 0;
      const hasUploadedImages = uploads.value.some(u => u.status === 'done' && u.url);
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

    function gLabel(g: string) {
      return g === "未分组" ? "未分组" : g;
    }

    function toggleAll() {
      allFriends.value = !allFriends.value;
      if (allFriends.value) selectedGroups.value = [];
    }

    function toggleGroup(g: string) {
      if (allFriends.value) return;
      const idx = selectedGroups.value.indexOf(g);
      if (idx === -1) selectedGroups.value.push(g);
      else selectedGroups.value.splice(idx, 1);
    }

    const uploads = ref<UploadItem[]>([]);
    const uploadEnabled = ref(false);
    const uploadingAny = computed(() => uploads.value.some(u => u.status === "uploading"));

    // Video support
    const videoPreview = ref<{
      url: string;
      provider: string;
      embedUrl?: string;
    } | null>(null);

    function parseVideoUrl(url: string): { url: string; provider: string; embedUrl?: string } | null {
      if (!url || !url.trim()) return null;
      
      const trimmedUrl = url.trim();
      
      // YouTube patterns
      const youtubeRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
      const youtubeMatch = trimmedUrl.match(youtubeRegex);
      if (youtubeMatch) {
        const videoId = youtubeMatch[1];
        return {
          url: trimmedUrl,
          provider: 'YouTube',
          embedUrl: `https://www.youtube.com/embed/${videoId}`
        };
      }
      
      // Vimeo patterns
      const vimeoRegex = /(?:vimeo\.com\/)(\d+)/i;
      const vimeoMatch = trimmedUrl.match(vimeoRegex);
      if (vimeoMatch) {
        const videoId = vimeoMatch[1];
        return {
          url: trimmedUrl,
          provider: 'Vimeo',
          embedUrl: `https://player.vimeo.com/video/${videoId}`
        };
      }
      
      // Direct video URL (mp4, webm, ogg)
      const videoExtRegex = /\.(mp4|webm|ogg)(\?.*)?$/i;
      if (videoExtRegex.test(trimmedUrl)) {
        return {
          url: trimmedUrl,
          provider: 'Direct',
          embedUrl: trimmedUrl
        };
      }
      
      // Check if it's a valid URL, otherwise don't treat as video
      try {
        new URL(trimmedUrl);
        // Valid URL but not a recognized video platform - treat as external
        return {
          url: trimmedUrl,
          provider: 'External',
          embedUrl: trimmedUrl
        };
      } catch {
        // Not a valid URL, return null
        return null;
      }
    }

    function removeVideo() {
      videoPreview.value = null;
    }

    async function startVideoUpload(item: UploadItem) {
      updateUploadItem(item.id, { status: "uploading", progress: 0, errorShort: undefined, errorDetails: undefined });

      try {
        // Note: Videos are uploaded directly without resizing (unlike images in startUpload)
        // Video files should not be processed with image resizing logic
        const descriptor = await uploadImageToBlossomWithFallback(item.file, {
          accountPubkey: keys.pkHex || undefined,
          signEvent: signEventWrapper,
          onProgress: (p:number) => { updateUploadItem(item.id, { progress: p }); }
        });
        
        // Set as video preview
        videoPreview.value = {
          url: descriptor.url,
          provider: 'Hosted',
          embedUrl: descriptor.url
        };
        
        updateUploadItem(item.id, { url: descriptor.url, status: "done", progress: 100 });
        
        // Remove from uploads list since we show it in videoPreview
        const idx = uploads.value.findIndex(u => u.id === item.id);
        if (idx !== -1) uploads.value.splice(idx, 1);
      } catch (err:any) {
        console.error("video upload error:", err);
        const errorShort = err && err.message ? String(err.message) : "上传失败";
        let errorDetails: string;
        try { errorDetails = err && err.details ? JSON.stringify(err.details, null, 2) : JSON.stringify(err, Object.getOwnPropertyNames(err), 2); } catch { errorDetails = String(err); }
        updateUploadItem(item.id, { status: "error", errorShort, errorDetails });
        ui.addToast(`视频上传失败: ${errorShort}`, 3000, "error");
      }
    }

    // Immutable update helper for upload items to ensure Vue reactivity
    function updateUploadItem(id: string, patch: Partial<UploadItem>) {
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
          const item: UploadItem = { 
            id: toId(), 
            file: f, 
            preview: null, // Videos don't need local preview
            status: "pending", 
            progress: 0 
          };
          uploads.value.push(item);
          void startVideoUpload(item);
        } else {
          // For image files, use image upload
          const item: UploadItem = { id: toId(), file: f, preview: makePreview(f), status: "pending", progress: 0 };
          uploads.value.push(item);
          void startUpload(item);
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

    async function startUpload(item: UploadItem) {
      updateUploadItem(item.id, { status: "uploading", progress: 0, errorShort: undefined, errorDetails: undefined });

      try {
        // 👇 关键：上传前 resize
        const resizedFile = await resizeImageFile(item.file, {
          maxSize: 1920,
          quality: 0.82
       });
        const descriptor = await uploadImageToBlossomWithFallback(resizedFile, {
          accountPubkey: keys.pkHex || undefined,
          signEvent: signEventWrapper,
          onProgress: (p:number) => { updateUploadItem(item.id, { progress: p }); }
        });
        updateUploadItem(item.id, { url: descriptor.url, status: "done", progress: 100 });
        // Don't automatically insert URL into textarea - just store it
      } catch (err:any) {
        console.error("upload error raw:", err);
        const errorShort = err && err.message ? String(err.message) : "上传失败";
        let errorDetails: string;
        try { errorDetails = err && err.details ? JSON.stringify(err.details, null, 2) : JSON.stringify(err, Object.getOwnPropertyNames(err), 2); } catch { errorDetails = String(err); }
        updateUploadItem(item.id, { status: "error", errorShort, errorDetails });
        ui.addToast(`上传失败: ${errorShort}`, 3000, "error");
      }
    }

    function insertImageUrl(item: UploadItem) {
      if (item.status === "done" && item.url) {
        if (content.value.length>0 && !content.value.endsWith("\n")) content.value += "\n";
        content.value += `![](${item.url})\n`;
      }
    }

    function removeUpload(idx:number) {
      const item = uploads.value[idx];
      if (item && item.preview) { try { URL.revokeObjectURL(item.preview) } catch {} }
      uploads.value.splice(idx, 1);
    }

    function onClose() {
      visible.value = false;
      setTimeout(() => {
        try { router.replace("/"); } catch {}
      }, 220);
    }

    onMounted(async ()=>{
      await checkBlossom();
      // Check pkHex directly instead of isLoggedIn to avoid timing issues where loginMethod might not be set yet
      if (!keys.pkHex) {
        router.replace({ path: "/login", query: { redirect: "/post" } });
        return;
      }
      await friends.load();
      await friendships.load();
      await msgs.load();
      allFriends.value = true;
      selectedGroups.value = [];
      await nextTick();
    });

    onBeforeUnmount(()=>{
      for (const it of uploads.value) {
        if (it.preview) { try { URL.revokeObjectURL(it.preview) } catch {} }
      }
    });

    watch(()=>groups.value, (g)=>{ if (g.length===0) { allFriends.value = true; selectedGroups.value = [] } });

    async function onSend() {
      // Use pkHex check for consistency with onMounted and reliability
      if (!keys.pkHex) { error.value = "请先登录"; return; }
      if (!canSend.value) { error.value = "请输入内容"; return; }
      sending.value = true;
      error.value = null;

      let recips = recipients.value.slice();
      if (keys.pkHex && !recips.includes(keys.pkHex)) recips.push(keys.pkHex);
      recips = Array.from(new Set(recips.filter(Boolean)));

      if (recips.length === 0) { error.value = "未指定收件人"; sending.value = false; return; }

      try {
        // Build content with uploaded images and video appended
        let fullContent = content.value;
        const uploadedImages = uploads.value.filter(u => u.status === 'done' && u.url);
        if (uploadedImages.length > 0) {
          // Add images as markdown at the end
          if (fullContent.length > 0 && !fullContent.endsWith("\n")) fullContent += "\n";
          for (const img of uploadedImages) {
            fullContent += `![](${img.url})\n`;
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
        
        const { message } = await posts.sendDirectMessage(recips, fullContent);
        try { await msgs.load(); msgs.addInbox({ id: message.id, pubkey: keys.pkHex, created_at: message.createdAt, content: fullContent, protocol: message.protocol, transportKind: message.transportKind, transportEventId: message.transportEventId, rumorId: message.rumorId, recipientPubkeys: message.recipientPubkeys, conversationId: message.conversationId, myGroups: allFriends.value ? ["全部好友"] : selectedGroups.value.slice() }); } catch {}
        ui.addToast("发送成功", 1200, "success");
        setTimeout(()=>{ visible.value = false; router.replace("/"); }, 220);
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
      canSend, textarea, overlay, error, onSend, onClose, toggleAll, toggleGroup,
      recipientsCount, selectedSet, gLabel, acceptedFriends, uploads, uploadEnabled, uploadingAny,
      onFilesSelected, insertImageUrl, removeUpload, checkBlossom,
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
  /* Reserve space for bottom navigation (80px height + safe area) */
  bottom: 80px;
  display: flex;
  align-items: flex-end; /* start from bottom */
  justify-content: center;
  background: rgba(0, 0, 0, 0.28);
  z-index: 2000;
  outline: none;
}

.editor-card {
  width: 100%;
  max-width: 720px;
  background: #fff;
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
  box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.12);
  transform: translateY(0);
  box-sizing: border-box;
}

/* header */
.editor-header {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
}
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
  padding: 12px;
  max-height: 70vh;
  overflow-y: auto;
  box-sizing: border-box;
}
.editor-textarea {
  width: 100%;
  min-height: 140px;
  padding: 10px;
  border: 1px solid #e6edf3;
  border-radius: 8px;
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
  padding:8px 10px;
  border-radius:8px;
  cursor:pointer;
  display:inline-block;
  border: 1px solid #3b82f6;
  transition: all 0.2s ease;
}
.upload-btn:hover {
  background: #3b82f6;
  color: white;
  transform: translateY(-1px);
}
.upload-btn input { display:none; }
.upload-btn.disabled { 
  background: transparent; 
  color: #9ca3af; 
  border: 1px solid #cbd5e1; 
  cursor: not-allowed; 
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
.upload-config-hint .ok { color: #16a34a; }
.upload-config-hint .warn { color: #d97706; }

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
  opacity: 0;
  transition: all 0.2s ease;
  padding: 4px;
}

.remove-btn svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
}

.thumb-container:hover .remove-btn {
  opacity: 1;
}

.remove-btn:hover {
  background: #ef4444;
  transform: scale(1.1);
}

/* chips UI */
.groups { margin-top:12px; }
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
  gap: 12px;
  margin-top: 16px;
  justify-content: flex-end;
}

.cancel-btn {
  background: transparent;
  color: #ef4444;
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid #ef4444;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}

.cancel-btn:hover {
  background: #ef4444;
  color: white;
  transform: translateY(-1px);
}

.send-btn {
  background: transparent;
  color: #3b82f6;
  padding: 8px 20px;
  border-radius: 8px;
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

/* slide up animation */
.slide-up-enter-active, .slide-up-leave-active { transition: transform 200ms ease, opacity 200ms ease; }
.slide-up-enter-from, .slide-up-leave-to { transform: translateY(100%); opacity:0; }
.slide-up-enter-to, .slide-up-leave-from { transform: translateY(0%); opacity:1; }

/* responsive */
@media (min-width:720px) {
  .editor-overlay { align-items:center; }
  .editor-card { 
    border-radius:12px; 
    max-height:80vh;
  }
}
.error { margin-top:8px; color:#d00; font-size:13px; }
.small { color:#64748b; font-size:12px; }
</style>
