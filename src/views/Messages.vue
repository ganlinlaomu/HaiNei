<template>
  <main class="chat-page">
    <header class="chat-header" :class="{ 'search-mode': searchOpen }">
      <template v-if="searchOpen">
        <button type="button" class="back-button" aria-label="关闭聊天搜索" @click="closeSearch">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <label class="chat-search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input
            ref="searchInput"
            v-model="searchQuery"
            type="search"
            autocomplete="off"
            placeholder="搜索当前聊天"
            aria-label="搜索当前聊天"
            @input="scheduleSearch"
            @keydown.esc="closeSearch"
          />
        </label>
        <span class="search-count">{{ searchStatusText }}</span>
      </template>
      <template v-else>
        <button type="button" class="back-button" aria-label="返回私信列表" @click="router.back()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button class="peer-profile avatar-profile-link" type="button" :aria-label="`查看 ${displayName} 的个人资料`" @click="openPeerProfile">
          <ProfileAvatar :pubkey="peerPubkey" :local-name="localName" :size="34" />
        </button>
        <button class="peer-profile name-profile-link" type="button" @click="openPeerProfile">{{ displayName }}</button>
        <button class="header-search-button" type="button" aria-label="搜索当前聊天" @click="openSearch">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        </button>
      </template>
      <div v-if="searchOpen && searchQuery.trim()" class="chat-search-results">
        <div v-if="searching && searchResults.length === 0" class="search-result-state">正在搜索本机历史消息…</div>
        <div v-else-if="searchComplete && searchResults.length === 0" class="search-result-state">未找到相关消息</div>
        <template v-if="searchResults.length > 0">
          <button
            v-for="result in visibleSearchResults"
            :key="result.id"
            class="chat-search-result"
            type="button"
            @click="selectSearchResult(result.id)"
          >
            <span class="search-result-meta">
              <strong>{{ result.senderPubkey === keys.pkHex ? "你" : displayName }}</strong>
              <time>{{ formatSearchTime(result.createdAt) }}</time>
            </span>
            <span class="search-result-preview">{{ result.preview }}</span>
          </button>
          <button v-if="hiddenSearchResultCount > 0" class="search-result-more" type="button" @click="showMoreSearchResults">
            显示更多结果（剩余 {{ hiddenSearchResultCount }} 条）
          </button>
          <div v-if="searching" class="search-result-state compact">正在继续搜索更早的消息…</div>
          <div v-else-if="searchComplete" class="search-result-state compact">搜索完成</div>
        </template>
      </div>
    </header>

    <section ref="messageList" class="message-list" aria-live="polite" @scroll.passive="handleMessageScroll" @click="attachmentMenuOpen = false">
      <div v-if="!accepted" class="relationship-notice">已不是已接受的好友，无法发送新消息。</div>
      <div v-if="accepted && messages.length === 0" class="empty-chat">开始一段私密对话</div>
      <template v-for="(message, index) in windowMessages" :key="message.id">
        <time v-if="showWindowTimestamp(index)" class="message-time">{{ formatMessageTime(message.created_at) }}</time>
        <div
          class="message-line"
          :class="{ own: isOwn(message), 'message-highlight': highlightedMessageId === message.id, 'action-menu-source': actionMenuMessageId === message.id }"
          :data-message-id="message.id"
          @touchstart="handleMessageTouchStart(message, $event)"
          @touchmove="handleMessageTouchMove(message, $event)"
          @touchend="handleMessageTouchEnd(message)"
          @touchcancel="handleMessageTouchCancel(message)"
          @selectstart.prevent
          @dragstart.prevent
          @contextmenu.prevent="openMessageActionMenu(message, $event)"
        >
          <span v-if="!isOwn(message)" class="avatar-slot">
            <button v-if="showWindowAvatar(index)" class="message-avatar-link" type="button" :aria-label="`查看 ${displayName} 的个人资料`" @click="openPeerProfile">
              <ProfileAvatar :pubkey="peerPubkey" :local-name="localName" :size="28" />
            </button>
          </span>
          <span
            v-if="swipingMessageId === message.id && swipeOffset > SWIPE_INTENT_THRESHOLD && canReplyTo(message)"
            class="swipe-reply-indicator"
            :class="{ active: swipeOffset >= SWIPE_REPLY_THRESHOLD }"
            :style="swipeReplyIndicatorStyle()"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24"><path d="M9 8 4 12l5 4"/><path d="M5 12h8a6 6 0 0 1 6 6"/></svg>
          </span>
          <div class="message-stack">
            <div class="message-bubble" :class="{ 'media-caption-bubble': !isDisappearing(message) && isMediaCaption(message), 'audio-bubble': !isDisappearing(message) && hasAudio(message), 'disappearing-bubble': isDisappearing(message) }">
              <template v-if="isDisappearing(message)">
                <div v-if="isBurned(message)" class="burned-placeholder" role="status">
                  <span aria-hidden="true">✓</span> 临时消息已销毁
                </div>
                <div v-else-if="isOwn(message)" class="temporary-message">
                  <span class="temporary-heading"><span aria-hidden="true">♨</span> 阅后即焚消息</span>
                  <span class="temporary-caption">对方打开后 {{ burnDuration(message) }} 秒销毁</span>
                </div>
                <div v-else-if="canShowTemporaryText(message)" class="temporary-message">
                  <MentionText class="bubble-text" :text="messageText(message.content)" />
                  <span class="temporary-countdown" role="timer" aria-live="off">♨ {{ remainingBurnSeconds(message) }} 秒后销毁</span>
                </div>
                <button v-else class="temporary-reveal" type="button" :disabled="openingMessageId === message.id" @click.stop="revealDisappearing(message)">
                  <strong>♨ 阅后即焚消息</strong>
                  <span>{{ openingMessageId === message.id ? "正在开启…" : "点击查看" }}</span>
                  <small>查看后 {{ burnDuration(message) }} 秒自动销毁</small>
                </button>
              </template>
              <template v-else>
              <button
                v-if="message.replyTo"
                class="quoted-message"
                type="button"
                :aria-label="`跳到引用消息：${quotedPreview(message.replyTo)}`"
                @click.stop="jumpToQuotedMessage(message.replyTo)"
              >
                <strong>{{ quotedAuthor(message.replyTo) }}</strong>
                <span>{{ quotedPreview(message.replyTo) }}</span>
              </button>
              <DmAudioMessage
                v-if="hasAudio(message)"
                :media="audioMedia(message)"
                :preview-url="message.outgoing?.audioPreviewUrl"
                :duration="message.outgoing?.audioDuration || audioMedia(message)?.duration || 0"
                :account-pubkey="keys.pkHex"
                :waveform-key="message.id"
                :own="isOwn(message)"
                :suspended="voiceCaptureOwnsAudioSession"
              />
              <template v-else-if="isMediaCaption(message)">
                <img v-if="message.outgoing?.imagePreviewUrl" :src="message.outgoing.imagePreviewUrl" class="optimistic-image" alt="待发送私信图片" />
                <PostImagePreview v-else :content="message.content" :show-all="true" alt-text="私信图片" />
                <div class="caption-area">
                  <MentionText class="bubble-text" :text="messageText(message.content)" />
                  <span class="caption-meta" :class="{ failed: isFailed(message), read: statusKind(message) === 'read' }">
                    <time>{{ formatBubbleTime(message.created_at) }}</time>
                    <template v-if="isOwn(message)">
                      <span>{{ statusLabel(message) }}</span>
                      <button v-if="message.outgoing && isFailed(message)" type="button" @click="directMessages.retry(message.outgoing.localId)">重试</button>
                    </template>
                  </span>
                </div>
              </template>
              <template v-else>
                <MentionText v-if="messageText(message.content)" class="bubble-text" :text="messageText(message.content)" />
                <img v-if="message.outgoing?.imagePreviewUrl" :src="message.outgoing.imagePreviewUrl" class="optimistic-image" alt="待发送私信图片" />
                <PostImagePreview v-else-if="hasImage(message.content)" :content="message.content" :show-all="true" alt-text="私信图片" />
              </template>
              </template>
            </div>
            <span v-if="!isMediaCaption(message) || isDisappearing(message)" class="message-meta" :class="{ failed: isFailed(message), read: statusKind(message) === 'read' }">
              <time>{{ formatBubbleTime(message.created_at) }}</time>
              <template v-if="isOwn(message)">
                <span>{{ statusLabel(message) }}</span>
                <button v-if="message.outgoing && isFailed(message)" type="button" @click="directMessages.retry(message.outgoing.localId)">重试</button>
              </template>
            </span>
          </div>
        </div>
      </template>
    </section>

    <div v-if="actionMenuMessage" class="message-action-backdrop" @click.self="closeMessageActionMenu">
      <div class="message-action-menu" :style="actionMenuStyle" role="menu" :aria-label="`消息操作：${quotePreview(actionMenuMessage)}`">
        <div class="message-action-preview">
          <strong>{{ isOwn(actionMenuMessage) ? "你" : displayName }}</strong>
          <span>{{ quotePreview(actionMenuMessage) }}</span>
        </div>
        <button type="button" role="menuitem" @click="replyFromActionMenu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8 4 12l5 4"/><path d="M5 12h8a6 6 0 0 1 6 6"/></svg>
          <span>回复</span>
        </button>
        <button v-if="actionMenuCopyText" type="button" role="menuitem" @click="copyFromActionMenu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
          <span>复制</span>
        </button>
      </div>
    </div>

    <button
      v-if="showJumpToLatest"
      class="jump-to-latest"
      type="button"
      :aria-label="pendingTailCount > 0 ? `回到最新消息，${pendingTailCount} 条新消息` : '回到最新消息'"
      @click="jumpToLatest"
    >
      <span aria-hidden="true">↓</span>
      <strong v-if="pendingTailCount > 0">{{ pendingTailCount }} 条新消息</strong>
    </button>

    <div class="composer-region">
      <div v-if="replyingToMessage" class="replying-preview" role="status">
        <div class="replying-copy">
          <strong>回复 {{ isOwn(replyingToMessage) ? "你自己" : displayName }}</strong>
          <span>{{ quotePreview(replyingToMessage) }}</span>
        </div>
        <button type="button" aria-label="取消引用回复" @click="cancelReply">×</button>
      </div>
      <div v-if="selectedImage" class="selected-image">
        <img :src="selectedImage.preview" alt="待发送图片" />
        <button type="button" aria-label="移除图片" @click="removeSelectedImage">×</button>
      </div>
      <p v-if="voiceError" class="voice-error" role="alert">{{ voiceError }}</p>
      <div v-if="attachmentMenuOpen" class="dm-attachment-menu" role="menu" aria-label="添加消息内容">
        <button type="button" role="menuitem" @click="chooseImageFromMenu">
          <span aria-hidden="true">▧</span> 图片
        </button>
        <button type="button" role="menuitem" @click="enableDisappearing">
          <span aria-hidden="true">♨</span> 阅后即焚
        </button>
      </div>
      <div v-if="disappearingSeconds !== null && !voiceCaptureOwnsAudioSession" class="temporary-composer-mode" role="status">
        <span>♨ 阅后即焚</span>
        <label for="temporary-duration">阅后</label>
        <select id="temporary-duration" v-model.number="disappearingSeconds" aria-label="阅后销毁时间">
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
          <option :value="60">60 秒</option>
        </select>
        <button type="button" aria-label="关闭阅后即焚模式" @click="disableDisappearing">×</button>
      </div>
      <form class="chat-composer" @submit.prevent="submitMessage">
        <MentionSuggestions
          v-if="mentionOpen"
          :items="mentionMatches"
          :active-index="mentionActiveIndex"
          placement="above"
          @select="selectMention"
        />
        <div v-if="recordedAudio && !voiceCaptureOwnsAudioSession" class="composer-preview">
          <DmAudioMessage class="composer-voice-preview" :preview-url="recordedAudio.preview" :duration="recordedAudio.duration" :own="true" />
          <button class="composer-icon-button remove-audio" type="button" aria-label="删除录音" @click="clearRecordedAudio">×</button>
          <button class="composer-icon-button send-button" type="submit" aria-label="发送" :disabled="!canSend">
            <span class="composer-icon-visual send-visual" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="m5 12 14-7-4 14-3-6-7-1Z"/><path d="m12 13 7-8"/></svg>
            </span>
          </button>
        </div>

        <div v-else class="composer-normal" :class="{ 'voice-active': voiceCaptureOwnsAudioSession }">
          <div
            v-if="voiceCaptureOwnsAudioSession"
            class="composer-recording"
            :class="{ locked: voiceLocked, cancelling: voiceGestureHint === 'cancel' }"
            role="status"
            aria-live="polite"
          >
            <span class="recording-dot" aria-hidden="true"></span>
            <strong>{{ formatVoiceDuration(recordingElapsed) }}</strong>
            <span class="voice-waveform" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
            <template v-if="finishingRecording">
              <span class="finishing-label">处理中…</span>
            </template>
            <template v-else-if="voiceLocked">
              <span class="voice-lock-label">已锁定</span>
              <button type="button" @click="cancelVoiceRecording">取消</button>
              <button type="button" class="finish-recording" @click="finishVoiceRecording(undefined, true)">发送</button>
            </template>
            <span v-else class="voice-gesture-hint">{{ voiceGestureHint === "cancel" ? "松开取消" : voiceGestureHint === "lock" ? "松开锁定" : "松开发送 · ← 取消 · ↑ 锁定" }}</span>
          </div>
          <template v-else>
            <textarea
              ref="textInput"
              v-model="draft"
              rows="1"
              enterkeyhint="enter"
              autocomplete="off"
              :placeholder="accepted ? (disappearingSeconds !== null ? '输入临时消息……' : '输入消息……') : '仅已接受好友可发送私信'"
              :disabled="!accepted || !keys.pkHex"
              @input="onMentionInput"
              @focus="handleComposerFocus"
              @blur="handleComposerBlur"
              @click="onMentionClick"
              @keydown="onMentionKeydown"
            ></textarea>
            <div class="composer-actions">
              <button
                type="button"
                class="composer-icon-button attachment-button"
                :disabled="!accepted || !keys.pkHex || disappearingSeconds !== null"
                aria-label="添加内容"
                :aria-expanded="attachmentMenuOpen"
                @click="attachmentMenuOpen = !attachmentMenuOpen"
              >
                <span class="composer-icon-visual" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                </span>
              </button>
              <span class="composer-actions-spacer" aria-hidden="true"></span>
              <button
                v-if="draft.trim() || selectedImage"
                class="composer-icon-button send-button"
                type="submit"
                aria-label="发送"
                :disabled="!canSend"
              >
                <span class="composer-icon-visual send-visual" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="m5 12 14-7-4 14-3-6-7-1Z"/><path d="m12 13 7-8"/></svg>
                </span>
              </button>
            </div>
          </template>
          <button
            v-show="voiceCaptureOwnsAudioSession || (!draft.trim() && !selectedImage)"
            class="composer-icon-button microphone-button persistent-microphone"
            :class="{ active: voiceCaptureOwnsAudioSession }"
            type="button"
            aria-label="按住录音"
            :aria-pressed="voiceCaptureOwnsAudioSession"
            :disabled="!accepted || !keys.pkHex || finishingRecording || disappearingSeconds !== null"
            @touchstart.prevent="handleVoiceTouchStart"
            @mousedown.prevent="handleVoiceMouseDown"
            @click.prevent
          >
            <span class="composer-icon-visual" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>
            </span>
          </button>
        </div>
      </form>
      <input ref="imageInput" class="attachment-file-input sr-file-input" type="file" accept="image/*" :disabled="!accepted || !keys.pkHex" @change="selectImage" />
    </div>
  </main>
</template>

<script setup lang="ts">
import { onBeforeAccountLock } from "@/services/accountLifecycle";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import PostImagePreview from "@/components/PostImagePreview.vue";
import DmAudioMessage from "@/components/DmAudioMessage.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import MentionSuggestions from "@/components/MentionSuggestions.vue";
import MentionText from "@/components/MentionText.vue";
import { DIRECT_MESSAGE_TYPE, directMessagePreview } from "@/nostr/messaging/directMessages";
import { disappearingMetadata, hasDisappearingMarker, isExpiredDisappearing, DISAPPEARING_DM_TYPE, type BurnDuration } from "@/nostr/messaging/disappearingMessages";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { parsePrivateAudioMessage } from "@/nostr/messaging/privateMedia";
import { directMessagesForPeer, useDirectMessagesStore, type DmSearchResult } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import {
  focusBoundedMessageWindow,
  initialBoundedMessageWindow,
  isNearMessageBottom,
  mergeBoundedMessageIndexes,
  scrollTopAfterAnchorShift,
  scrollTopAfterNewMessages,
  shiftBoundedMessageWindow,
  type MessageScrollMetrics,
} from "@/utils/messageWindow";
import { classifyVoiceGesture } from "@/utils/voiceGesture";
import { createVoiceRecordingSession, type VoiceRecordingResult, type VoiceRecordingSession } from "@/utils/voiceRecorder";
import { openProfile } from "@/utils/profileNavigation";
import { useMentionComposer } from "@/composables/useMentionComposer";
import { resizeComposerTextarea } from "@/utils/composerTextarea";
import type { MentionCandidate } from "@/utils/mentions";
import { loadAccountStoresOnce, waitForFirstPaint } from "@/utils/bottomTabActivation";

const route = useRoute();
const router = useRouter();
const keys = useKeyStore();
const ui = useUIStore();
const messageStore = useMessagesStore();
const directMessages = useDirectMessagesStore();
const friendships = useFriendshipsStore();
const friends = useFriendsStore();
const profiles = useProfilesStore();
const peerPubkey = computed(() => String(route.params.pubkey || "").trim().toLowerCase());
const accepted = computed(() => friendships.loadedFor === keys.pkHex && friendships.isAccepted(peerPubkey.value));
const localName = computed(() => friends.list.find(friend => friend.pubkey === peerPubkey.value)?.name);
const displayName = computed(() => privateProfileDisplayName(profiles.getProfile(peerPubkey.value)?.nickname, peerPubkey.value, localName.value));
const historyMessages = ref<InboxItem[]>([]);
const historyCursor = ref<{createdAt:number;id:string}>();
const historyExhausted = ref(false);
const messages = computed(() => {
  const peer = peerPubkey.value;
  const existing = directMessages.mergePeerHistory(peer, historyMessages.value);
  const results = new Map(existing.map(message => [message.id, message]));
  // A tombstone is only metadata: do not reconstruct decrypted content.
  for (const [id, info] of Object.entries(directMessages.burnedById)) {
    if (info.peerPubkey !== peer) continue;
    const found = results.get(id);
    if (found) {
      results.set(id, { ...found, content: "" });
    } else if (info.createdAt && info.senderPubkey && info.conversationId && accepted.value) {
      results.set(id, {
        id, pubkey: info.senderPubkey, recipientPubkeys: [info.senderPubkey === keys.pkHex ? peer : keys.pkHex],
        conversationId: info.conversationId, created_at: info.createdAt, content: "",
        protocol: "nip17", transportKind: 1059, tags: [["t", DIRECT_MESSAGE_TYPE], ["t", DISAPPEARING_DM_TYPE]],
      });
    }
  }
  return [...results.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
});
async function fetchOlderPage(reset = false) {
  if (!reset && historyExhausted.value) return;
  const account=keys.pkHex, peer=peerPubkey.value;
  const page=await directMessages.loadPeerHistoryPage(peer,reset ? undefined : historyCursor.value);
  if(account!==keys.pkHex || peer!==peerPubkey.value) return;
  if(reset) historyMessages.value=[];
  historyMessages.value=[...page.items,...historyMessages.value];
  historyCursor.value=page.cursor;
  historyExhausted.value=page.exhausted;
}
const searchContextMessages = ref<InboxItem[]>([]);
const searchContextActive = ref(false);
const initialWindowRange = initialBoundedMessageWindow(messages.value.length, 60);
const windowStart = ref(initialWindowRange.start);
const windowEnd = ref(initialWindowRange.end);
const draft = ref("");
const replyingToId = ref("");
const draftReplyMessage = ref<InboxItem | undefined>();
const lookupMessage = (id?: string) => id
  ? messages.value.find(message => message.id === id) || searchContextMessages.value.find(message => message.id === id)
  : undefined;
const replyingToMessage = computed(() => lookupMessage(replyingToId.value) || (draftReplyMessage.value?.id === replyingToId.value ? draftReplyMessage.value : undefined));
const searchOpen = ref(false);
const searchQuery = ref("");
const searchResults = ref<DmSearchResult[]>([]);
const searching = ref(false);
const searchComplete = ref(false);
const searchRenderLimit = ref(60);
const searchInput = ref<HTMLInputElement | null>(null);
const visibleSearchResults = computed(() => searchResults.value.slice(0, searchRenderLimit.value));
const hiddenSearchResultCount = computed(() => Math.max(0, searchResults.value.length - visibleSearchResults.value.length));
const searchStatusText = computed(() => {
  if (!searchQuery.value.trim()) return "";
  if (searching.value) return `${searchResults.value.length} 条 · 搜索中`;
  return searchComplete.value ? `${searchResults.value.length} 条 · 已完成` : "";
});
const selectedImage = ref<{ file: File; preview: string } | null>(null);
const attachmentMenuOpen = ref(false);
const disappearingSeconds = ref<BurnDuration | null>(null);
const openedDeadlines = ref<Record<string, number>>({});
const clockNow = ref(Date.now());
const openingMessageId = ref("");
const recording = shallowRef<VoiceRecordingSession | null>(null);
const startingRecording = ref(false);
const finishingRecording = ref(false);
const recordingElapsed = ref(0);
const voiceLocked = ref(false);
const voiceGestureHint = ref<"send" | "cancel" | "lock">("send");
const recordedAudio = ref<(VoiceRecordingResult & { preview: string }) | null>(null);
const voiceError = ref("");
const imageInput = ref<HTMLInputElement | null>(null);
const textInput = ref<HTMLTextAreaElement | null>(null);
const mentionCandidates = computed<MentionCandidate[]>(() => {
  const peer = peerPubkey.value;
  return friends.getAcceptedList(friendships.isAccepted)
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
    .sort((a, b) => Number(b.pubkey === peer) - Number(a.pubkey === peer));
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
  closeMention,
} = useMentionComposer(draft, textInput, mentionCandidates);
const messageList = ref<HTMLElement | null>(null);
const showJumpToLatest = ref(false);
const pendingTailCount = ref(0);
const swipingMessageId = ref("");
const swipeOffset = ref(0);
const highlightedMessageId = ref("");
const actionMenuMessageId = ref("");
const retainedPlaybackMessageId = ref("");
const retainedMessageIds = computed(() => [...new Set([
  actionMenuMessageId.value,
  swipingMessageId.value,
  highlightedMessageId.value,
  retainedPlaybackMessageId.value,
].filter(Boolean))]);
const windowMessages = computed(() => {
  if (searchContextActive.value) return searchContextMessages.value;
  const retainedIndexes = retainedMessageIds.value
    .map(id => messages.value.findIndex(message => message.id === id))
    .filter(index => index >= 0);
  return mergeBoundedMessageIndexes(
    { start: windowStart.value, end: windowEnd.value },
    messages.value.length,
    retainedIndexes,
  )
    .map(index => messages.value[index])
    .filter((message): message is InboxItem => !!message);
});
const actionMenuPosition = ref({ top: 0, left: 12, width: 280 });
const actionMenuStyle = computed(() => ({
  top: `${actionMenuPosition.value.top}px`,
  left: `${actionMenuPosition.value.left}px`,
  width: `${actionMenuPosition.value.width}px`,
}));
const actionMenuMessage = computed(() => lookupMessage(actionMenuMessageId.value));
const actionMenuCopyText = computed(() => actionMenuMessage.value ? messageText(actionMenuMessage.value.content) : "");
const voiceCaptureOwnsAudioSession = computed(() => startingRecording.value || !!recording.value || finishingRecording.value);
const canSend = computed(() => !!keys.pkHex && accepted.value && !recording.value && (!!draft.value.trim() || !!selectedImage.value || !!recordedAudio.value));
const INITIAL_MESSAGE_COUNT = 60;
const OLDER_MESSAGE_BATCH = 40;
const MAX_RENDERED_MESSAGES = 100;
const TOP_LOAD_THRESHOLD = 120;
const BOTTOM_FOLLOW_THRESHOLD = 120;
const SWIPE_INTENT_THRESHOLD = 8;
const SWIPE_REPLY_THRESHOLD = 52;
const SWIPE_MAX_DISTANCE = 72;
const LONG_PRESS_MS = 460;
const VOICE_CANCEL_DISTANCE = 68;
const VOICE_LOCK_DISTANCE = 68;
const MIN_VOICE_DURATION_SECONDS = 1;
let messageGesture: {
  id: string;
  startX: number;
  startY: number;
  horizontal: boolean;
  longPressed: boolean;
  allowSwipe: boolean;
} | null = null;
let longPressTimer: number | null = null;
let replyHighlightTimer: number | null = null;
let prependingOlder = false;
let windowMutationInProgress = false;
let followLatestTail = true;
let loadingConversation = false;
let loadGeneration = 0;
let restoreOverflowAnchorFrame: number | null = null;
let disposed = false;
let recordingTimer: number | null = null;
let recordingHealthUnsubscribe: (() => void) | null = null;
let voiceGesture: { kind: "touch" | "mouse"; startX: number; startY: number; touchId?: number } | null = null;
let pendingVoiceGestureAction: "send" | "cancel" | null = null;
let autoSendVoiceOnFinish = false;
let ignoreVoiceMouseUntil = 0;
let composerFocused = false;
let composerFocusSettleTimer: number | null = null;
let searchTimer: number | null = null;
let searchGeneration = 0;
let searchAbortController: AbortController | null = null;
let draftSaveTimer: number | null = null;
let draftReady = false;
let suppressDraftPersistence = false;
let burnTimer: number | null = null;
let burnTimerPeriod = 0;
const burningMessageIds = new Set<string>();

const hasImage = (content: string) => /!\[[^\]]*?\]\(\s*(?:https?:\/\/|blossom\+aesgcm:)[^\s)]+\s*\)/i.test(content);
const messageText = (content: string) => ["[图片]", "[语音]"].includes(directMessagePreview(content)) ? "" : directMessagePreview(content);
const audioMedia = (message: InboxItem) => parsePrivateAudioMessage(message.content)?.media || null;
const hasAudio = (message: InboxItem) => !!message.outgoing?.hasAudio || !!audioMedia(message);
const hasMessageImage = (message: InboxItem) => !!message.outgoing?.imagePreviewUrl || hasImage(message.content);
const isMediaCaption = (message: InboxItem) => hasMessageImage(message) && !!messageText(message.content);
const isOwn = (message: InboxItem) => message.pubkey === keys.pkHex;
const isFailed = (message: InboxItem) => message.outgoing?.state === "upload_failed" || message.outgoing?.state === "send_failed";
function isDisappearing(message: InboxItem) {
  return hasDisappearingMarker(message.tags) || directMessages.burnedById[message.id]?.peerPubkey === peerPubkey.value;
}
function burnDuration(message: InboxItem) {
  return disappearingMetadata(message.tags)?.burnAfterSeconds || 10;
}
function remainingBurnSeconds(message: InboxItem) {
  const deadline = openedDeadlines.value[message.id] || 0;
  return Math.max(0, Math.ceil((deadline - clockNow.value) / 1000));
}
function isBurned(message: InboxItem) {
  return !!directMessages.burnedById[message.id]
    || isExpiredDisappearing(message.tags, Math.floor(clockNow.value / 1000))
    || (openedDeadlines.value[message.id] !== undefined && remainingBurnSeconds(message) === 0);
}
function canShowTemporaryText(message: InboxItem) {
  return !isOwn(message) && !isBurned(message)
    && openedDeadlines.value[message.id] !== undefined && remainingBurnSeconds(message) > 0;
}
async function revealDisappearing(message: InboxItem) {
  if (openingMessageId.value || isOwn(message) || isBurned(message) || !accepted.value
    || !/^[0-9a-f]{64}$/i.test(message.id)) return;
  const account = keys.pkHex;
  const peer = peerPubkey.value;
  openingMessageId.value = message.id;
  try {
    const deadline = await syncedMessageRepository.openDisappearingMessage(account, message.id, peer);
    if (disposed || account !== keys.pkHex || peer !== peerPubkey.value) return;
    clockNow.value = Date.now();
    if (deadline === null) {
      ui.addToast("临时消息已不可查看", 1800, "info");
      void checkBurnDeadlines();
      return;
    }
    openedDeadlines.value = { ...openedDeadlines.value, [message.id]: deadline };
    if (deadline <= Date.now()) void checkBurnDeadlines();
    else startBurnClock();
  } catch {
    if (!disposed && account === keys.pkHex) ui.addToast("临时消息打开失败，请重试", 2100, "error");
  } finally {
    if (openingMessageId.value === message.id) openingMessageId.value = "";
  }
}
function stopBurnClock() {
  if (burnTimer !== null) window.clearInterval(burnTimer);
  burnTimer = null;
  burnTimerPeriod = 0;
}
function startBurnClock() {
  if (document.hidden) return;
  // Unopened DM history requires no high-frequency polling. A live reading
  // countdown needs only second precision; background execution is suspended.
  const active = Object.values(openedDeadlines.value).some(deadline => deadline > Date.now());
  const period = active ? 1000 : 60_000;
  if (burnTimer !== null && burnTimerPeriod === period) return;
  stopBurnClock();
  clockNow.value = Date.now();
  burnTimerPeriod = period;
  burnTimer = window.setInterval(() => {
    clockNow.value = Date.now();
    void checkBurnDeadlines();
  }, period);
}
async function checkBurnDeadlines() {
  if (disposed || !keys.pkHex || !accepted.value) return;
  const account = keys.pkHex;
  const peer = peerPubkey.value;
  const now = Date.now();
  for (const message of messages.value) {
    if (!isDisappearing(message) || directMessages.burnedById[message.id]
      || !/^[0-9a-f]{64}$/i.test(message.id) || burningMessageIds.has(message.id)) continue;
    const deadline = openedDeadlines.value[message.id];
    if (deadline === undefined && !isExpiredDisappearing(message.tags, Math.floor(now / 1000))) continue;
    if (deadline !== undefined && deadline > now && !isExpiredDisappearing(message.tags, Math.floor(now / 1000))) continue;
    burningMessageIds.add(message.id);
    try {
      if (await directMessages.burnDisappearingMessage(peer, message.id)
        && account === keys.pkHex && peer === peerPubkey.value) {
        const next = { ...openedDeadlines.value };
        delete next[message.id];
        openedDeadlines.value = next;
        startBurnClock();
      }
    } catch {
      // Retry on the next visible tick; never reveal expired plaintext again.
    } finally {
      burningMessageIds.delete(message.id);
    }
  }
}
function handleBurnVisibility() {
  clockNow.value = Date.now();
  if (document.hidden) stopBurnClock();
  else {
    startBurnClock();
    void checkBurnDeadlines();
  }
}
function quotePreview(message?: InboxItem) {
  if (!message) return "引用的消息暂不可用";
  if (isDisappearing(message)) return "阅后即焚消息";
  const preview = directMessagePreview(message.content);
  return preview || (hasAudio(message) ? "[语音]" : hasMessageImage(message) ? "[图片]" : "消息");
}
function quotedMessage(replyTo?: string) {
  return lookupMessage(replyTo);
}
function quotedAuthor(replyTo?: string) {
  const quoted = quotedMessage(replyTo);
  return quoted ? (isOwn(quoted) ? "你" : displayName.value) : "引用消息";
}
function quotedPreview(replyTo?: string) {
  return quotePreview(quotedMessage(replyTo));
}
function canReplyTo(message: InboxItem) {
  return !isDisappearing(message) && accepted.value
    && /^[0-9a-f]{64}$/i.test(message.id)
    && (!message.outgoing || message.outgoing.state === "sent");
}
function startReply(message: InboxItem) {
  if (!canReplyTo(message)) return;
  draftReplyMessage.value = message;
  replyingToId.value = message.id;
  void nextTick(() => textInput.value?.focus());
}
function cancelReply() {
  replyingToId.value = "";
  draftReplyMessage.value = undefined;
}
function clearLongPressTimer() {
  if (longPressTimer !== null) window.clearTimeout(longPressTimer);
  longPressTimer = null;
}
function resetMessageGesture() {
  clearLongPressTimer();
  messageGesture = null;
  swipingMessageId.value = "";
  swipeOffset.value = 0;
}
function isInteractiveMessageTarget(target: EventTarget | null) {
  return target instanceof Element
    && !!target.closest("button, a, input, textarea, select, audio, video, [role='slider']");
}
function isMediaGestureTarget(target: EventTarget | null) {
  return target instanceof Element
    && !!target.closest(".post-image-preview, .optimistic-image, .voice-message");
}
function swipeReplyIndicatorStyle() {
  const progress = Math.min(1, swipeOffset.value / SWIPE_REPLY_THRESHOLD);
  return {
    width: `${Math.min(30, swipeOffset.value * 0.5)}px`,
    opacity: String(progress),
    transform: `scale(${0.75 + progress * 0.25})`,
  };
}
function openMessageActionMenu(message: InboxItem, event?: MouseEvent) {
  if (!canReplyTo(message)) return;
  window.getSelection?.()?.removeAllRanges();
  const line = messageList.value?.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
  const anchor = line?.querySelector<HTMLElement>(".message-bubble") || line;
  const rect = anchor?.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const menuWidth = Math.min(300, Math.max(240, viewportWidth - 24));
  const hasCopyAction = !!messageText(message.content);
  const estimatedHeight = 62 + (hasCopyAction ? 104 : 52);
  const edge = 12;
  const gap = 8;

  let left = event?.clientX !== undefined
    ? event.clientX - menuWidth / 2
    : isOwn(message)
      ? (rect?.right || viewportWidth - edge) - menuWidth
      : (rect?.left || edge);
  left = Math.min(viewportWidth - menuWidth - edge, Math.max(edge, left));

  const anchorTop = event?.clientY ?? rect?.top ?? viewportHeight / 2;
  const anchorBottom = event?.clientY ?? rect?.bottom ?? viewportHeight / 2;
  const fitsBelow = anchorBottom + gap + estimatedHeight <= viewportHeight - edge;
  let top = fitsBelow ? anchorBottom + gap : anchorTop - estimatedHeight - gap;
  top = Math.min(viewportHeight - estimatedHeight - edge, Math.max(edge, top));

  resetMessageGesture();
  textInput.value?.blur();
  actionMenuPosition.value = { top, left, width: menuWidth };
  actionMenuMessageId.value = message.id;
}
function closeMessageActionMenu() {
  actionMenuMessageId.value = "";
}
function replyFromActionMenu() {
  const message = actionMenuMessage.value;
  closeMessageActionMenu();
  if (message) startReply(message);
}
async function copyFromActionMenu() {
  const text = actionMenuCopyText.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ui.addToast("已复制", 1_500, "success");
    closeMessageActionMenu();
  } catch {
    ui.addToast("复制失败", 1_800, "error");
  }
}
function handleMessageTouchStart(message: InboxItem, event: TouchEvent) {
  if (!canReplyTo(message) || isInteractiveMessageTarget(event.target)) return;
  const touch = event.touches[0];
  if (!touch) return;
  resetMessageGesture();
  messageGesture = {
    id: message.id,
    startX: touch.clientX,
    startY: touch.clientY,
    horizontal: false,
    longPressed: false,
    allowSwipe: !isMediaGestureTarget(event.target),
  };
  swipingMessageId.value = message.id;
  longPressTimer = window.setTimeout(() => {
    if (!messageGesture || messageGesture.id !== message.id) return;
    messageGesture.longPressed = true;
    openMessageActionMenu(message);
  }, LONG_PRESS_MS);
}
function handleMessageTouchMove(message: InboxItem, event: TouchEvent) {
  const gesture = messageGesture;
  if (!gesture || gesture.id !== message.id) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - gesture.startX;
  const dy = touch.clientY - gesture.startY;
  if (Math.hypot(dx, dy) > SWIPE_INTENT_THRESHOLD) clearLongPressTimer();
  if (!gesture.allowSwipe) return;
  if (!gesture.horizontal) {
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < SWIPE_INTENT_THRESHOLD) return;
    gesture.horizontal = true;
  }
  if (dx <= 0) {
    swipeOffset.value = 0;
    return;
  }
  if (event.cancelable) event.preventDefault();
  swipeOffset.value = Math.min(SWIPE_MAX_DISTANCE, dx);
}
function handleMessageTouchEnd(message: InboxItem) {
  const gesture = messageGesture;
  if (!gesture || gesture.id !== message.id) return;
  const shouldReply = !gesture.longPressed && gesture.horizontal && swipeOffset.value >= SWIPE_REPLY_THRESHOLD;
  resetMessageGesture();
  if (shouldReply) startReply(message);
}
function handleMessageTouchCancel(message: InboxItem) {
  if (messageGesture?.id !== message.id) return;
  resetMessageGesture();
}
async function highlightFocusedMessage(messageId: string) {
  const target = messageList.value?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  highlightedMessageId.value = "";
  await nextTick();
  highlightedMessageId.value = messageId;
  if (replyHighlightTimer !== null) window.clearTimeout(replyHighlightTimer);
  replyHighlightTimer = window.setTimeout(() => {
    if (highlightedMessageId.value === messageId) highlightedMessageId.value = "";
    replyHighlightTimer = null;
  }, 1_250);
  return true;
}
async function focusMessage(messageId: string) {
  const targetIndex = messages.value.findIndex(message => message.id === messageId);
  if (targetIndex >= 0) {
    searchContextActive.value = false;
    searchContextMessages.value = [];
    refreshRetainedPlaybackMessage();
    const range = focusBoundedMessageWindow(
      messages.value.length,
      targetIndex,
      6,
      MAX_RENDERED_MESSAGES,
    );
    windowStart.value = range.start;
    windowEnd.value = range.end;
    await nextTick();
  } else {
    const context = await directMessages.loadPeerMessageContext(peerPubkey.value, messageId, 20);
    if (!context.length) {
      ui.addToast("消息暂不可用", 1_800, "info");
      return false;
    }
    searchContextMessages.value = context;
    searchContextActive.value = true;
    showJumpToLatest.value = true;
    await nextTick();
  }
  if (await highlightFocusedMessage(messageId)) return true;
  ui.addToast("消息暂不可用", 1_800, "info");
  return false;
}
async function jumpToQuotedMessage(replyTo?: string) {
  if (replyTo) await focusMessage(replyTo);
}
function openPeerProfile(event?: Event) {
  return openProfile(router, keys.pkHex, peerPubkey.value, event);
}
function statusKind(message: InboxItem) {
  switch (message.outgoing?.state) {
    case "uploading":
    case "sending":
    case "upload_failed":
    case "send_failed":
      return message.outgoing.state;
    default: {
      const receipt = directMessages.outgoingReceiptStatus(peerPubkey.value, message) || "sent";
      // The normal read cursor must not imply that a sealed message was opened.
      return isDisappearing(message) && receipt === "read" ? "delivered" : receipt;
    }
  }
}
function statusLabel(message: InboxItem) {
  switch (statusKind(message)) {
    case "uploading": return "上传中…";
    case "sending": return "发送中…";
    case "sent": return "✓ Relay 已接受";
    case "delivered": return "✓✓ 已送达";
    case "read": return "✓✓ 已读";
    case "upload_failed": return "上传失败 ·";
    case "send_failed": return "发送失败 ·";
    default: return "";
  }
}
function showWindowAvatar(index: number) {
  const current = windowMessages.value[index];
  if (!current || isOwn(current)) return false;
  const previous = windowMessages.value[index - 1];
  return !previous || previous.pubkey !== current.pubkey || current.created_at - previous.created_at > 300;
}
function showWindowTimestamp(index: number) {
  const current = windowMessages.value[index];
  if (!current) return false;
  const previous = windowMessages.value[index - 1];
  return !previous || current.created_at - previous.created_at > 900;
}
function formatMessageTime(timestamp: number) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatBubbleTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function formatSearchTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function clearSearchTimer() {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = null;
}
function cancelSearchRequest() {
  clearSearchTimer();
  searchAbortController?.abort();
  searchAbortController = null;
  searchGeneration += 1;
}
function resetSearchResults() {
  searchResults.value = [];
  searchRenderLimit.value = 60;
  searching.value = false;
  searchComplete.value = false;
}
function openSearch() {
  textInput.value?.blur();
  searchOpen.value = true;
  void nextTick(() => searchInput.value?.focus());
}
function closeSearch() {
  closeMention();
  searchInput.value?.blur();
  cancelSearchRequest();
  searchOpen.value = false;
  searchQuery.value = "";
  resetSearchResults();
}
function showMoreSearchResults() {
  searchRenderLimit.value += 60;
}
function mergeSearchBatch(batch: DmSearchResult[]) {
  if (!batch.length) return;
  const merged = new Map(searchResults.value.map(result => [result.id, result]));
  for (const result of batch) merged.set(result.id, result);
  searchResults.value = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}
function scheduleSearch() {
  cancelSearchRequest();
  const query = searchQuery.value.trim();
  if (!query) {
    resetSearchResults();
    return;
  }

  const generation = ++searchGeneration;
  const account = keys.pkHex;
  const peer = peerPubkey.value;
  const controller = new AbortController();
  searchAbortController = controller;
  searchResults.value = [];
  searchRenderLimit.value = 60;
  searching.value = true;
  searchComplete.value = false;

  searchTimer = window.setTimeout(async () => {
    searchTimer = null;
    const isCurrent = () => generation === searchGeneration
      && !controller.signal.aborted
      && account === keys.pkHex
      && peer === peerPubkey.value
      && query === searchQuery.value.trim();

    try {
      const results = await directMessages.searchPeerMessages(peer, query, {
        signal: controller.signal,
        onBatch: (batch, progress) => {
          if (!isCurrent()) return;
          mergeSearchBatch(batch);
          searching.value = !progress.complete;
          searchComplete.value = progress.complete;
        },
      });
      if (!isCurrent()) return;
      searchResults.value = results;
      searching.value = false;
      searchComplete.value = true;
    } catch {
      if (!isCurrent()) return;
      searching.value = false;
      searchComplete.value = true;
    } finally {
      if (searchAbortController === controller) searchAbortController = null;
    }
  }, 180);
}
async function selectSearchResult(messageId: string) {
  closeSearch();
  await focusMessage(messageId);
}
function exitSearchContext() {
  searchContextActive.value = false;
  searchContextMessages.value = [];
  resetMessageWindow();
}
function clearDraftSaveTimer() {
  if (draftSaveTimer !== null) window.clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
}
function scheduleDraftSave() {
  if (!draftReady || suppressDraftPersistence) return;
  clearDraftSaveTimer();
  const account = keys.pkHex;
  const peer = peerPubkey.value;
  const text = draft.value;
  const replyTo = replyingToId.value || undefined;
  if (!account || !peer) return;
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = null;
    void directMessages.saveDraft(peer, { text, replyTo }, account);
  }, 300);
}
function flushDraft(account: string = keys.pkHex, peer: string = peerPubkey.value) {
  clearDraftSaveTimer();
  if (!draftReady || suppressDraftPersistence || !account || !peer) return;
  return directMessages.saveDraft(peer, { text: draft.value, replyTo: replyingToId.value || undefined }, account);
}
const stopBeforeLock = onBeforeAccountLock(async account => {
  if (account !== keys.pkHex) return;
  await flushDraft(account);
  draftReady = false;
});
async function restoreDraft(account: string, peer: string) {
  draftReady = false;
  clearDraftSaveTimer();
  const saved = await directMessages.loadDraft(peer, account);
  if (disposed || keys.pkHex !== account || peerPubkey.value !== peer) return;
  draft.value = saved?.text || "";
  replyingToId.value = saved?.replyTo || "";
  draftReplyMessage.value = undefined;
  if (saved?.replyTo && !messages.value.some(message => message.id === saved.replyTo)) {
    const context = await directMessages.loadPeerMessageContext(peer, saved.replyTo, 0);
    if (disposed || keys.pkHex !== account || peerPubkey.value !== peer) return;
    draftReplyMessage.value = context.find(message => message.id === saved.replyTo);
  }
  await nextTick();
  draftReady = true;
}
function setMessageListToBottom() {
  const list = messageList.value;
  refreshRetainedPlaybackMessage();
  const range = initialBoundedMessageWindow(
    messages.value.length,
    INITIAL_MESSAGE_COUNT,
  );
  if (windowStart.value !== range.start || windowEnd.value !== range.end) {
    windowStart.value = range.start;
    windowEnd.value = range.end;
    void nextTick(setMessageListToBottom);
    return;
  }
  if (list) list.scrollTop = list.scrollHeight;
  followLatestTail = true;
  showJumpToLatest.value = false;
  pendingTailCount.value = 0;
}
function scrollToBottom() {
  void nextTick(setMessageListToBottom);
}
function resizeMessageComposer() {
  resizeComposerTextarea(textInput.value, composerFocused, {
    minHeight: 36,
    focusedMinHeight: 36,
    maxHeight: 108,
  });
}
watch(draft, () => {
  void nextTick(resizeMessageComposer);
}, { immediate: true });
function handleComposerFocus() {
  onMentionFocus();
  composerFocused = true;
  void nextTick(resizeMessageComposer);
  scrollToBottom();

  // iOS changes the visual viewport while the keyboard animates in. Re-apply
  // the bottom anchor once immediately and once after the animation as a
  // fallback for builds where VisualViewport resize is delayed or omitted.
  requestAnimationFrame(setMessageListToBottom);
  if (composerFocusSettleTimer !== null) window.clearTimeout(composerFocusSettleTimer);
  composerFocusSettleTimer = window.setTimeout(() => {
    composerFocusSettleTimer = null;
    if (composerFocused) setMessageListToBottom();
  }, 320);
}
function handleComposerBlur() {
  onMentionBlur();
  composerFocused = false;
  void nextTick(resizeMessageComposer);
  if (composerFocusSettleTimer !== null) window.clearTimeout(composerFocusSettleTimer);
  composerFocusSettleTimer = null;
}
function handleVisualViewportResize() {
  if (!composerFocused) return;
  requestAnimationFrame(setMessageListToBottom);
}

function scrollMetrics(element: HTMLElement): MessageScrollMetrics {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
}

type MessageDomAnchor = { id: string; offset: number; scrollTop: number };

function refreshRetainedPlaybackMessage() {
  const playingShell = messageList.value?.querySelector<HTMLElement>(".voice-shell.playing");
  const playingLine = playingShell?.closest<HTMLElement>(".message-line[data-message-id]");
  retainedPlaybackMessageId.value = playingLine?.dataset.messageId || "";
}

function captureMessageDomAnchor(list: HTMLElement): MessageDomAnchor | undefined {
  const listTop = list.getBoundingClientRect().top;
  const rows = [...list.querySelectorAll<HTMLElement>(".message-line[data-message-id]")];
  const row = rows.find(candidate => candidate.getBoundingClientRect().bottom > listTop + 1) || rows[0];
  const id = row?.dataset.messageId;
  if (!row || !id) return undefined;
  return { id, offset: row.getBoundingClientRect().top - listTop, scrollTop: list.scrollTop };
}

function restoreMessageDomAnchor(list: HTMLElement, anchor?: MessageDomAnchor) {
  if (!anchor) return;
  const row = [...list.querySelectorAll<HTMLElement>(".message-line[data-message-id]")]
    .find(candidate => candidate.dataset.messageId === anchor.id);
  if (!row) return;
  const nextOffset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  list.scrollTop = scrollTopAfterAnchorShift(anchor.scrollTop, anchor.offset, nextOffset);
}

function restoreNativeOverflowAnchor(list: HTMLElement) {
  if (restoreOverflowAnchorFrame !== null) cancelAnimationFrame(restoreOverflowAnchorFrame);
  restoreOverflowAnchorFrame = requestAnimationFrame(() => {
    restoreOverflowAnchorFrame = null;
    list.style.removeProperty("overflow-anchor");
  });
}

function resetMessageWindow() {
  const range = initialBoundedMessageWindow(
    messages.value.length,
    INITIAL_MESSAGE_COUNT,
  );
  windowStart.value = range.start;
  windowEnd.value = range.end;
}

async function prependOlderMessages() {
  const list = messageList.value;
  if (!list || prependingOlder || (windowStart.value === 0 && historyExhausted.value)) return;

  prependingOlder = true;
  windowMutationInProgress = true;
  const peerAtStart = peerPubkey.value;
  const anchor = captureMessageDomAnchor(list);
  const needsHistoryPage = windowStart.value === 0 && !historyExhausted.value;
  list.style.overflowAnchor = "none";

  try {
    if (needsHistoryPage) await fetchOlderPage();
    if (disposed || peerAtStart !== peerPubkey.value) return;

    refreshRetainedPlaybackMessage();
    const anchorIndex = anchor ? messages.value.findIndex(message => message.id === anchor.id) : -1;
    const range = needsHistoryPage && anchorIndex >= 0
      ? focusBoundedMessageWindow(messages.value.length, anchorIndex, OLDER_MESSAGE_BATCH, MAX_RENDERED_MESSAGES)
      : shiftBoundedMessageWindow(
        { start: windowStart.value, end: windowEnd.value },
        messages.value.length,
        "older",
        OLDER_MESSAGE_BATCH,
        MAX_RENDERED_MESSAGES,
      );

    windowStart.value = range.start;
    windowEnd.value = range.end;
    await nextTick();
    if (disposed || peerAtStart !== peerPubkey.value) return;
    restoreMessageDomAnchor(list, anchor);
  } finally {
    windowMutationInProgress = false;
    prependingOlder = false;
    restoreNativeOverflowAnchor(list);
  }
}

async function appendNewerMessages() {
  const list = messageList.value;
  if (!list || prependingOlder || windowEnd.value >= messages.value.length) return;

  prependingOlder = true;
  windowMutationInProgress = true;
  const peerAtStart = peerPubkey.value;
  const anchor = captureMessageDomAnchor(list);
  list.style.overflowAnchor = "none";

  try {
    refreshRetainedPlaybackMessage();
    const range = shiftBoundedMessageWindow(
      { start: windowStart.value, end: windowEnd.value },
      messages.value.length,
      "newer",
      OLDER_MESSAGE_BATCH,
      MAX_RENDERED_MESSAGES,
    );
    windowStart.value = range.start;
    windowEnd.value = range.end;
    await nextTick();
    if (disposed || peerAtStart !== peerPubkey.value) return;
    restoreMessageDomAnchor(list, anchor);
  } finally {
    windowMutationInProgress = false;
    prependingOlder = false;
    restoreNativeOverflowAnchor(list);
  }
}

function handleMessageMediaLoad() {
  const list = messageList.value;
  if (!list || searchContextActive.value || !followLatestTail || windowEnd.value < messages.value.length) return;
  requestAnimationFrame(() => {
    if (!disposed && followLatestTail && windowEnd.value >= messages.value.length) setMessageListToBottom();
  });
}

function markVisibleMessagesRead() {
  const latest = messages.value.filter(message => !message.outgoing || message.outgoing.state === "sent").at(-1);
  if (!latest) return Promise.resolve();
  return directMessages.markPeerRead(peerPubkey.value, latest);
}

function handleMessageScroll() {
  const list = messageList.value;
  if (!list) return;
  if (actionMenuMessageId.value) closeMessageActionMenu();
  if (searchContextActive.value) {
    followLatestTail = false;
    showJumpToLatest.value = true;
    return;
  }

  if (list.scrollTop <= TOP_LOAD_THRESHOLD) void prependOlderMessages();
  const metrics = scrollMetrics(list);
  const nearBottom = isNearMessageBottom(metrics, BOTTOM_FOLLOW_THRESHOLD);
  if (nearBottom && windowEnd.value < messages.value.length) void appendNewerMessages();

  const atConversationTail = windowEnd.value >= messages.value.length;
  if (atConversationTail && nearBottom) {
    followLatestTail = true;
    showJumpToLatest.value = false;
    pendingTailCount.value = 0;
    if (!loadingConversation) void markVisibleMessagesRead();
  } else {
    followLatestTail = false;
    if (list.scrollHeight > list.clientHeight + BOTTOM_FOLLOW_THRESHOLD || !atConversationTail) {
      showJumpToLatest.value = true;
    }
  }
}

function jumpToLatest() {
  exitSearchContext();
  scrollToBottom();
  void nextTick(() => markVisibleMessagesRead());
}

async function load() {
  const generation = ++loadGeneration;
  loadingConversation = true;
  showJumpToLatest.value = false;
  pendingTailCount.value = 0;
  resetMessageWindow();
  const account = keys.pkHex;
  const peer = peerPubkey.value;
  if (!account || peer === account) {
    loadingConversation = false;
    return void router.replace("/conversations");
  }

  try {
    // Never make IndexedDB hydration or account-store checks compete with the
    // route transition. Paint the chat shell first, then hydrate local data.
    await waitForFirstPaint();
    if (generation !== loadGeneration || account !== keys.pkHex || peer !== peerPubkey.value) return;

    await loadAccountStoresOnce(account, [messageStore, friendships, friends, profiles]);
    if (generation !== loadGeneration || account !== keys.pkHex || peer !== peerPubkey.value) return;

    // This is an indexed conversation query (and is normally already warmed by
    // the conversation list), so no full inbox scan is needed to render chat.
    await fetchOlderPage(true);
    await directMessages.loadBurnedPeer(peer);
    const openRows = await syncedMessageRepository.listOpenedDisappearing(account, peer);
    if (generation !== loadGeneration || account !== keys.pkHex || peer !== peerPubkey.value) return;
    openedDeadlines.value = Object.fromEntries(openRows.map(row => [row.messageId, row.deadlineAt]));
    startBurnClock();
    clockNow.value = Date.now();
    void checkBurnDeadlines();
    if (generation !== loadGeneration || account !== keys.pkHex || peer !== peerPubkey.value) return;

    resetMessageWindow();
    await nextTick();
    setMessageListToBottom();

    // The visible conversation is usable now. Draft restoration and read-state
    // persistence are local follow-up work and must not block first interaction.
    loadingConversation = false;
    void restoreDraft(account, peer).catch(() => undefined);
    void markVisibleMessagesRead().catch(() => undefined);
  } finally {
    if (generation === loadGeneration) loadingConversation = false;
  }
}
function chooseImageFromMenu() {
  attachmentMenuOpen.value = false;
  if (accepted.value && disappearingSeconds.value === null) imageInput.value?.click();
}
function enableDisappearing() {
  attachmentMenuOpen.value = false;
  if (!accepted.value || !keys.supportsNip44) {
    ui.addToast("当前账号无法发送加密临时消息", 2000, "info");
    return;
  }
  if (selectedImage.value || recordedAudio.value || voiceCaptureOwnsAudioSession.value) {
    ui.addToast("请先移除图片或语音，阅后即焚仅支持文字", 2200, "info");
    return;
  }
  cancelReply();
  disappearingSeconds.value = 10;
  void nextTick(() => textInput.value?.focus());
}
function disableDisappearing() {
  disappearingSeconds.value = null;
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
function formatVoiceDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function stopRecordingTimer() {
  if (recordingTimer !== null) window.clearInterval(recordingTimer);
  recordingTimer = null;
}
function stopRecordingHealthWatch() {
  recordingHealthUnsubscribe?.();
  recordingHealthUnsubscribe = null;
}
function startRecordingTimer(session: VoiceRecordingSession) {
  if (recordingTimer !== null || !session.isActive()) return;
  recordingElapsed.value = Math.min(300, session.elapsedMs() / 1000);
  recordingTimer = window.setInterval(() => {
    if (recording.value !== session || !session.isActive()) {
      stopRecordingTimer();
      return;
    }
    recordingElapsed.value = Math.min(300, session.elapsedMs() / 1000);
  }, 250);
}
function clearRecordedAudio() {
  if (recordedAudio.value?.preview) URL.revokeObjectURL(recordedAudio.value.preview);
  recordedAudio.value = null;
}
function stopVoiceGestureTracking() {
  window.removeEventListener("touchmove", handleVoiceTouchMove);
  window.removeEventListener("touchend", handleVoiceTouchEnd);
  window.removeEventListener("touchcancel", handleVoiceTouchCancel);
  window.removeEventListener("mousemove", handleVoiceMouseMove);
  window.removeEventListener("mouseup", handleVoiceMouseUp);
  voiceGesture = null;
  voiceGestureHint.value = "send";
}
function resetVoiceInteraction() {
  stopVoiceGestureTracking();
  pendingVoiceGestureAction = null;
  autoSendVoiceOnFinish = false;
  voiceLocked.value = false;
}
function cancelVoiceRecording() {
  const active = recording.value;
  if (!active && startingRecording.value) pendingVoiceGestureAction = "cancel";
  recording.value = null;
  finishingRecording.value = false;
  stopRecordingTimer();
  stopRecordingHealthWatch();
  recordingElapsed.value = 0;
  voiceLocked.value = false;
  stopVoiceGestureTracking();
  active?.cancel();
}
function acceptRecordingResult(
  session: VoiceRecordingSession,
  result: VoiceRecordingResult | null,
  account: string,
  peer: string,
) {
  if (!result
    || recording.value !== session
    || disposed
    || keys.pkHex !== account
    || peerPubkey.value !== peer) return;
  clearRecordedAudio();
  recordedAudio.value = { ...result, preview: URL.createObjectURL(result.blob) };
}
function waitForAudioElementsToUnmount() {
  return new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function updateVoiceGesture(clientX: number, clientY: number, event?: Event) {
  if (!voiceGesture || voiceLocked.value) return;
  const dx = clientX - voiceGesture.startX;
  const dy = clientY - voiceGesture.startY;
  voiceGestureHint.value = classifyVoiceGesture(dx, dy, VOICE_CANCEL_DISTANCE, VOICE_LOCK_DISTANCE);
  if (event?.cancelable) event.preventDefault();
}
function completeVoiceGesture() {
  if (!voiceGesture) return;
  const action = voiceGestureHint.value;
  stopVoiceGestureTracking();
  if (action === "lock") {
    voiceLocked.value = true;
    pendingVoiceGestureAction = null;
    return;
  }
  pendingVoiceGestureAction = action === "cancel" ? "cancel" : "send";
  if (pendingVoiceGestureAction === "cancel") cancelVoiceRecording();
  else if (recording.value) void finishVoiceRecording(recording.value, true);
}
function handleVoiceTouchStart(event: TouchEvent) {
  if (voiceGesture || recording.value || startingRecording.value || recordedAudio.value || selectedImage.value || !accepted.value || !keys.pkHex) return;
  const touch = event.changedTouches[0];
  if (!touch) return;
  ignoreVoiceMouseUntil = Date.now() + 800;
  voiceGesture = { kind: "touch", startX: touch.clientX, startY: touch.clientY, touchId: touch.identifier };
  voiceGestureHint.value = "send";
  voiceLocked.value = false;
  pendingVoiceGestureAction = null;
  window.addEventListener("touchmove", handleVoiceTouchMove, { passive: false });
  window.addEventListener("touchend", handleVoiceTouchEnd, { passive: false });
  window.addEventListener("touchcancel", handleVoiceTouchCancel, { passive: false });
  void startVoiceRecording();
}
function handleVoiceTouchMove(event: TouchEvent) {
  if (voiceGesture?.kind !== "touch") return;
  const touch = [...event.touches].find(item => item.identifier === voiceGesture?.touchId);
  if (touch) updateVoiceGesture(touch.clientX, touch.clientY, event);
}
function handleVoiceTouchEnd(event: TouchEvent) {
  if (voiceGesture?.kind !== "touch") return;
  const ended = [...event.changedTouches].some(item => item.identifier === voiceGesture?.touchId);
  if (!ended) return;
  if (event.cancelable) event.preventDefault();
  completeVoiceGesture();
}
function handleVoiceTouchCancel(event: TouchEvent) {
  if (voiceGesture?.kind !== "touch") return;
  if (event.cancelable) event.preventDefault();
  pendingVoiceGestureAction = "cancel";
  cancelVoiceRecording();
}
function handleVoiceMouseDown(event: MouseEvent) {
  if (Date.now() < ignoreVoiceMouseUntil || voiceGesture || recording.value || startingRecording.value || recordedAudio.value || selectedImage.value || !accepted.value || !keys.pkHex) return;
  voiceGesture = { kind: "mouse", startX: event.clientX, startY: event.clientY };
  voiceGestureHint.value = "send";
  voiceLocked.value = false;
  pendingVoiceGestureAction = null;
  window.addEventListener("mousemove", handleVoiceMouseMove);
  window.addEventListener("mouseup", handleVoiceMouseUp);
  void startVoiceRecording();
}
function handleVoiceMouseMove(event: MouseEvent) {
  if (voiceGesture?.kind === "mouse") updateVoiceGesture(event.clientX, event.clientY, event);
}
function handleVoiceMouseUp(event: MouseEvent) {
  if (voiceGesture?.kind !== "mouse") return;
  if (event.cancelable) event.preventDefault();
  completeVoiceGesture();
}

async function startVoiceRecording() {
  if (startingRecording.value || recording.value || recordedAudio.value || selectedImage.value || !accepted.value || !keys.pkHex) return;
  startingRecording.value = true;
  voiceError.value = "";
  const accountAtStart = keys.pkHex;
  const peerAtStart = peerPubkey.value;
  try {
    // iOS 27 can interrupt a fresh microphone capture when an HTMLAudioElement
    // from the conversation still owns the media session. Setting the reactive
    // flag is not enough: Vue has not removed those elements until nextTick.
    await nextTick();
    await waitForAudioElementsToUnmount();
    if (disposed || !accepted.value || keys.pkHex !== accountAtStart || peerPubkey.value !== peerAtStart) return;
    const remainingAudioElements = document.querySelectorAll(".message-list audio, .composer-region audio").length;
    console.info("[voice-recorder]", { event: "pre-capture-audio-elements", count: remainingAudioElements });
    const session = await createVoiceRecordingSession({
      onAutoFinish: () => { autoSendVoiceOnFinish = true; },
    });
    if (disposed || !accepted.value || keys.pkHex !== accountAtStart || peerPubkey.value !== peerAtStart) return session.dispose();
    if (pendingVoiceGestureAction === "cancel") {
      pendingVoiceGestureAction = null;
      session.cancel();
      return;
    }
    recording.value = session;
    finishingRecording.value = false;
    recordingElapsed.value = 0;
    recordingHealthUnsubscribe = session.onStateChange(health => {
      if (recording.value !== session) return;
      if (health.active && !finishingRecording.value) startRecordingTimer(session);
      else stopRecordingTimer();
      if (["finishing", "stopped", "error"].includes(health.state) && !finishingRecording.value) {
        void finishVoiceRecording(session, autoSendVoiceOnFinish);
      }
    });
    startRecordingTimer(session);
    if (pendingVoiceGestureAction === "send") {
      pendingVoiceGestureAction = null;
      void finishVoiceRecording(session, true);
    }
  } catch (error) {
    voiceError.value = error instanceof Error ? error.message : "无法使用麦克风";
  } finally {
    startingRecording.value = false;
  }
}
function sendVoiceRecordingResult(result: VoiceRecordingResult, account: string, peer: string) {
  if (disposed || keys.pkHex !== account || peerPubkey.value !== peer) return;
  if (result.duration < MIN_VOICE_DURATION_SECONDS) {
    ui.addToast("说话时间太短", 1_600, "info");
    return;
  }
  try {
    directMessages.sendAudio(peer, result, replyingToMessage.value?.id);
    cancelReply();
  } catch (error) {
    voiceError.value = error instanceof Error ? error.message : "语音发送失败";
    ui.addToast(voiceError.value, 2_200, "error");
  }
}
async function finishVoiceRecording(target?: VoiceRecordingSession, sendImmediately = false) {
  const session = target || recording.value;
  if (!session || recording.value !== session || finishingRecording.value) return;
  const accountAtFinish = keys.pkHex;
  const peerAtFinish = peerPubkey.value;
  recordingElapsed.value = Math.min(300, session.elapsedMs() / 1000);
  finishingRecording.value = true;
  stopRecordingTimer();
  stopVoiceGestureTracking();
  voiceError.value = "";
  try {
    const result = await session.finish();
    if (result && sendImmediately) sendVoiceRecordingResult(result, accountAtFinish, peerAtFinish);
    else acceptRecordingResult(session, result, accountAtFinish, peerAtFinish);
  } catch (error) {
    if (recording.value === session) voiceError.value = error instanceof Error ? error.message : "录音处理失败";
  } finally {
    if (recording.value === session) {
      recording.value = null;
      recordingElapsed.value = 0;
      stopRecordingHealthWatch();
    }
    finishingRecording.value = false;
    pendingVoiceGestureAction = null;
    autoSendVoiceOnFinish = false;
    voiceLocked.value = false;
  }
}
function submitMessage() {
  if (!canSend.value) return;
  if (disappearingSeconds.value !== null && (recordedAudio.value || selectedImage.value || replyingToId.value)) {
    ui.addToast("阅后即焚仅支持纯文字消息", 2200, "info");
    return;
  }
  if (recordedAudio.value) {
    const audio = recordedAudio.value;
    const replyTo = replyingToMessage.value?.id;
    try {
      directMessages.sendAudio(peerPubkey.value, audio, replyTo);
      clearDraftSaveTimer();
      suppressDraftPersistence = true;
      draft.value = "";
      clearRecordedAudio();
      cancelReply();
      void nextTick(() => {
        suppressDraftPersistence = false;
        if (draft.value || replyingToId.value) scheduleDraftSave();
      });
    } catch (error) {
      voiceError.value = error instanceof Error ? error.message : "语音发送失败";
      ui.addToast(voiceError.value, 2200, "error");
    }
    return;
  }
  const text = draft.value;
  const image = selectedImage.value?.file;
  const replyTo = replyingToMessage.value?.id;
  try {
    directMessages.send(peerPubkey.value, text, image, replyTo, disappearingSeconds.value ?? undefined);
    disappearingSeconds.value = null;
    attachmentMenuOpen.value = false;
    clearDraftSaveTimer();
    suppressDraftPersistence = true;
    draft.value = "";
    removeSelectedImage();
    cancelReply();
    void nextTick(() => {
      suppressDraftPersistence = false;
      if (draft.value || replyingToId.value) scheduleDraftSave();
    });
  } catch (error) {
    ui.addToast(error instanceof Error ? error.message : "发送失败，请稍后重试", 2200, "error");
  }
}

function applyLatestInboxMutation() {
  const mutation = messageStore.lastInboxMutation;
  const account = keys.pkHex.toLowerCase();
  const peer = peerPubkey.value;
  if (!account || !peer || messageStore.loadedFor.toLowerCase() !== account) return;

  if (mutation?.type === "insert" || mutation?.type === "update") {
    const item = mutation.itemId ? messageStore.inbox.find(message => message.id === mutation.itemId) : undefined;
    if (!item) return;
    const matched = directMessagesForPeer([item], account, peer, {
      friendship: friendships.getRecord(peer),
      preference: directMessages.preferencesByPeer[peer],
      enforceAuthorization: true,
    });
    if (!matched.length) return;
    const merged = new Map(historyMessages.value.map(message => [message.id, message]));
    for (const message of matched) merged.set(message.id, message);
    historyMessages.value = [...merged.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return;
  }

  if (mutation?.type === "reset") {
    historyMessages.value = [];
    historyCursor.value = undefined;
    historyExhausted.value = false;
  }
}

function handlePageHide() {
  flushDraft();
  stopBurnClock();
}
watch(() => messageStore.inboxRevision, applyLatestInboxMutation);
// PR1 burns durable rows, but the paginated Vue history may still reference the
// decrypted objects. Scrub that memory mirror immediately on remote or local burn.
watch(() => directMessages.burnedById, burned => {
  const masked = (items: InboxItem[]) => items.map(item => burned[item.id] ? { ...item, content: "" } : item);
  historyMessages.value = masked(historyMessages.value);
  searchContextMessages.value = masked(searchContextMessages.value);
  searchResults.value = searchResults.value.filter(item => !burned[item.id]);
  if (draftReplyMessage.value && burned[draftReplyMessage.value.id]) draftReplyMessage.value = undefined;
});
onMounted(() => {
  document.addEventListener("visibilitychange", handleBurnVisibility);
  window.addEventListener("pageshow", handleBurnVisibility);
  startBurnClock();
  window.visualViewport?.addEventListener("resize", handleVisualViewportResize);
  window.addEventListener("pagehide", handlePageHide);
  messageList.value?.addEventListener("load", handleMessageMediaLoad, true);
  void load();
});
watch([draft, replyingToId], scheduleDraftSave);
watch([() => keys.pkHex, peerPubkey], (_next, previous) => {
  openedDeadlines.value = {};
  disappearingSeconds.value = null;
  attachmentMenuOpen.value = false;
  openingMessageId.value = "";
  if (previous?.[0] && previous?.[1]) flushDraft(previous[0], previous[1]);
  draftReady = false;
  clearDraftSaveTimer();
  closeSearch();
  exitSearchContext();
  cancelVoiceRecording();
  clearRecordedAudio();
  cancelReply();
  closeMessageActionMenu();
  resetMessageGesture();
  retainedPlaybackMessageId.value = "";
  highlightedMessageId.value = "";
  if (replyHighlightTimer !== null) window.clearTimeout(replyHighlightTimer);
  replyHighlightTimer = null;
  void load();
});
watch(() => messages.value.map(message => message.id).join("\0"), async (nextSignature, previousSignature) => {
  if (windowMutationInProgress) return;
  const nextIds = nextSignature ? nextSignature.split("\0") : [];
  const previousIds = previousSignature ? previousSignature.split("\0") : [];
  if (loadingConversation) {
    resetMessageWindow();
    return;
  }

  const list = messageList.value;
  const previousMetrics = list ? scrollMetrics(list) : undefined;
  const previousWindowEnd = Math.min(windowEnd.value, previousIds.length);
  const previousFirstId = previousIds[windowStart.value];
  const previousWindowLastId = previousIds[Math.max(windowStart.value, previousWindowEnd - 1)];
  const previousConversationLastId = previousIds.at(-1);
  const previousConversationLastIndex = previousConversationLastId ? nextIds.indexOf(previousConversationLastId) : -1;
  const hasNewTail = !!nextIds.length
    && (!previousConversationLastId || previousConversationLastIndex < nextIds.length - 1);
  const newTailCount = hasNewTail
    ? Math.max(1, previousConversationLastIndex >= 0
      ? nextIds.length - previousConversationLastIndex - 1
      : nextIds.length - previousIds.length)
    : 0;

  if (searchContextActive.value) {
    if (hasNewTail) {
      showJumpToLatest.value = true;
      pendingTailCount.value += newTailCount;
    }
    return;
  }

  const wasAtConversationTail = previousWindowEnd >= previousIds.length;
  const followingLatest = !!list && !!previousMetrics && wasAtConversationTail
    && isNearMessageBottom(previousMetrics, BOTTOM_FOLLOW_THRESHOLD);

  if (list && previousMetrics && hasNewTail && followingLatest) {
    refreshRetainedPlaybackMessage();
    const range = initialBoundedMessageWindow(
      nextIds.length,
      INITIAL_MESSAGE_COUNT,
    );
    windowStart.value = range.start;
    windowEnd.value = range.end;
    await nextTick();
    list.scrollTop = scrollTopAfterNewMessages(previousMetrics, list.scrollHeight, BOTTOM_FOLLOW_THRESHOLD);
    followLatestTail = true;
    showJumpToLatest.value = false;
    pendingTailCount.value = 0;
    await markVisibleMessagesRead();
    return;
  }

  const preservedStart = previousFirstId ? nextIds.indexOf(previousFirstId) : -1;
  const preservedLast = previousWindowLastId ? nextIds.indexOf(previousWindowLastId) : -1;
  if (preservedStart >= 0 && preservedLast >= preservedStart) {
    windowStart.value = preservedStart;
    windowEnd.value = preservedLast + 1;
  } else {
    resetMessageWindow();
  }

  if (hasNewTail) {
    followLatestTail = false;
    showJumpToLatest.value = true;
    pendingTailCount.value += newTailCount;
  }
});
onBeforeUnmount(() => {
  stopBeforeLock();
  disposed = true;
  flushDraft();
  draftReady = false;
  clearDraftSaveTimer();
  cancelSearchRequest();
  window.removeEventListener("pagehide", handlePageHide);
  document.removeEventListener("visibilitychange", handleBurnVisibility);
  window.removeEventListener("pageshow", handleBurnVisibility);
  stopBurnClock();
  window.visualViewport?.removeEventListener("resize", handleVisualViewportResize);
  messageList.value?.removeEventListener("load", handleMessageMediaLoad, true);
  handleComposerBlur();
  loadGeneration += 1;
  if (restoreOverflowAnchorFrame !== null) cancelAnimationFrame(restoreOverflowAnchorFrame);
  if (replyHighlightTimer !== null) window.clearTimeout(replyHighlightTimer);
  replyHighlightTimer = null;
  closeMessageActionMenu();
  resetMessageGesture();
  messageList.value?.style.removeProperty("overflow-anchor");
  removeSelectedImage();
  cancelVoiceRecording();
  clearRecordedAudio();
});
</script>

<style scoped>
.chat-page{position:fixed;inset:0;z-index:1000;display:grid;width:100%;max-width:none;margin:0;box-sizing:border-box;grid-template-rows:auto minmax(0,1fr) auto;background:#fff;color:#0f1419}
.chat-header{position:relative;z-index:8;display:grid;grid-template-columns:38px 34px minmax(0,1fr) 38px;align-items:center;gap:8px;min-height:54px;padding:0 12px;border-bottom:1px solid #eff1f3;background:#fff}.chat-header.search-mode{grid-template-columns:38px minmax(0,1fr) auto}.header-search-button{display:grid;width:38px;height:42px;padding:8px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419}.header-search-button:active{background:#eff3f4}.header-search-button svg,.chat-search-field svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.chat-search-field{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;gap:7px;height:38px;padding:0 11px;border-radius:999px;background:#eff3f4;color:#536471}.chat-search-field input{min-width:0;width:100%;height:38px;padding:0;border:0;outline:0;background:transparent;color:#0f1419;font-size:16px}.search-count{min-width:32px;color:#657786;font-size:12px;text-align:right;white-space:nowrap}.chat-search-results{position:absolute;top:54px;right:0;left:0;z-index:9;max-height:min(56vh,520px);overflow-y:auto;border-bottom:1px solid #e2e8f0;background:#fff;box-shadow:0 12px 28px rgba(15,23,42,.12)}.search-result-state{padding:28px 18px;color:#657786;font-size:13px;text-align:center}.search-result-state.compact{padding:12px 18px}.search-result-more{display:block;width:100%;padding:12px 16px;border:0;border-top:1px solid #eff1f3;background:#fff;color:#2563eb;font-size:13px;text-align:center}.chat-search-result{display:flex;width:100%;min-height:62px;flex-direction:column;gap:4px;padding:10px 16px;border:0;border-bottom:1px solid #eff1f3;background:#fff;color:#0f1419;text-align:left}.chat-search-result:active{background:#f7f9f9}.search-result-meta{display:flex;align-items:center;justify-content:space-between;gap:12px}.search-result-meta strong{font-size:12px}.search-result-meta time{color:#8b98a5;font-size:11px}.search-result-preview{display:-webkit-box;overflow:hidden;color:#536471;font-size:13px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}.peer-profile,.message-avatar-link{padding:0;border:0;background:transparent;color:inherit;cursor:pointer}.avatar-profile-link,.message-avatar-link{display:grid;place-items:center}.name-profile-link{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:16px;font-weight:700}.peer-profile:focus-visible,.message-avatar-link:focus-visible{outline:2px solid #2563eb;outline-offset:2px;border-radius:6px}.back-button{display:grid;width:38px;height:42px;padding:8px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419}.back-button:active{background:#eff3f4}.back-button svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.message-list{min-height:0;overflow-x:hidden;overflow-y:auto;padding:12px 12px 16px;overscroll-behavior:contain}.relationship-notice,.empty-chat{margin:14px auto;padding:9px 13px;color:#536471;font-size:12px;text-align:center}.message-time{display:block;margin:16px 0 10px;color:#8b98a5;font-size:11px;text-align:center}.message-line{display:flex;align-items:flex-end;gap:6px;margin:3px 0;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.message-line .message-bubble,.message-line .message-bubble *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}
.message-line .bubble-text,.message-line .quoted-message,.message-line .quoted-message *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}.message-line.own{justify-content:flex-end}.avatar-slot{display:flex;width:28px;flex:0 0 28px}.swipe-reply-indicator{display:grid;height:30px;flex:0 0 auto;place-items:center;overflow:hidden;border-radius:50%;color:#657786;transition:color 120ms ease,background 120ms ease}.swipe-reply-indicator.active{background:#e8f4fd;color:#1687e8}.swipe-reply-indicator svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.message-stack{display:flex;max-width:min(76%,430px);align-items:flex-end;flex-direction:column}.message-line:not(.own) .message-stack{align-items:flex-start}.message-bubble{max-width:100%;padding:9px 12px;border-radius:18px 18px 18px 5px;background:#eff3f4;color:#0f1419;line-height:1.45;overflow:hidden}.message-line.own .message-bubble{border-radius:18px 18px 5px 18px;background:#d9efff}.quoted-message{display:flex;width:100%;min-width:0;flex-direction:column;gap:1px;margin:0 0 6px;padding:6px 8px;border:0;border-left:3px solid #1687e8;border-radius:7px;background:rgba(255,255,255,.58);color:inherit;font:inherit;line-height:1.25;text-align:left;cursor:pointer;-webkit-tap-highlight-color:transparent}.quoted-message:active{background:rgba(255,255,255,.88)}.quoted-message strong{overflow:hidden;color:#536471;font-size:11px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.quoted-message span{overflow:hidden;max-width:280px;color:#536471;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.message-line.message-highlight .message-bubble{animation:message-target-highlight 1.25s ease-out}.bubble-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}.optimistic-image{display:block;width:min(260px,65vw);max-height:320px;margin:6px -4px -1px;object-fit:cover;border-radius:12px}.message-meta{display:flex;align-items:center;gap:4px;margin:3px 5px 1px;color:#8b98a5;font-size:9px;font-weight:400;line-height:1.3;opacity:.85;white-space:nowrap;font-variant-numeric:tabular-nums}.message-meta.failed,.caption-meta.failed{color:#dc2626}.message-meta.read,.caption-meta.read{color:#1687e8}.message-meta button,.caption-meta button{padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:650}.message-bubble :deep(.post-image-preview){margin:-9px -12px}.message-bubble :deep(.carousel-shell){border-radius:16px}.media-caption-bubble{width:min(260px,65vw);padding:0}.media-caption-bubble>.quoted-message{margin:8px 10px 6px}.media-caption-bubble .optimistic-image{width:100%;max-height:320px;margin:0;border-radius:0}.media-caption-bubble :deep(.post-image-preview){margin:0}.media-caption-bubble :deep(.carousel-shell){margin:0;border-radius:0}.caption-area{padding:8px 10px 7px}.caption-meta{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:2px;color:#718096;font-size:9px;line-height:1.3;white-space:nowrap}
.audio-bubble{padding:9px 10px}
.message-action-backdrop{position:fixed;inset:0;z-index:20;background:rgba(15,23,42,.12);backdrop-filter:blur(.5px)}
.message-action-menu{position:fixed;overflow:hidden;border:1px solid rgba(203,213,225,.82);border-radius:18px;background:rgba(255,255,255,.98);box-shadow:0 18px 48px rgba(15,23,42,.22);backdrop-filter:blur(18px);transform-origin:center}
.message-action-preview{display:flex;min-width:0;flex-direction:column;gap:2px;padding:11px 14px;border-bottom:1px solid #eef1f4}.message-action-preview strong,.message-action-preview span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.message-action-preview strong{font-size:12px;color:#0f1419}.message-action-preview span{font-size:13px;color:#657786}
.message-action-menu>button{display:flex;width:100%;min-height:52px;align-items:center;gap:12px;padding:0 16px;border:0;border-top:1px solid #f1f3f5;background:transparent;color:#0f1419;font:inherit;font-size:16px;text-align:left}.message-action-menu>button:first-of-type{border-top:0}.message-action-menu>button:active{background:#f4f6f8}.message-action-menu>button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.message-line.action-menu-source .message-bubble{box-shadow:0 0 0 3px rgba(22,135,232,.12)}
@keyframes message-target-highlight{0%{filter:brightness(.92);box-shadow:0 0 0 4px rgba(22,135,232,.24)}55%{filter:brightness(.98);box-shadow:0 0 0 3px rgba(22,135,232,.12)}100%{filter:none;box-shadow:0 0 0 0 rgba(22,135,232,0)}}
.jump-to-latest{position:absolute;right:18px;bottom:calc(94px + env(safe-area-inset-bottom));z-index:4;display:flex;min-width:42px;height:42px;align-items:center;justify-content:center;gap:6px;padding:0 12px;border:1px solid #d8dee5;border-radius:999px;background:#fff;color:#0f1419;box-shadow:0 5px 18px rgba(15,23,42,.16);font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent}.jump-to-latest:active{background:#f7f9f9;transform:scale(.97)}.jump-to-latest>span{font-size:20px;line-height:1}.jump-to-latest strong{font-size:12px;font-weight:650;white-space:nowrap}
.composer-region{position:relative;z-index:3;width:min(100%,720px);margin:0 auto;padding:4px 0 calc(28px + env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(255,255,255,0),#fff 22%);transition:padding-bottom 180ms ease}.composer-region:has(.chat-composer:focus-within){padding-bottom:calc(8px + env(safe-area-inset-bottom))}
.replying-preview{display:flex;min-width:0;align-items:center;gap:10px;margin:0 16px 6px;padding:7px 10px 7px 12px;border-left:3px solid #1687e8;border-radius:10px;background:#f7f9f9}.replying-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:1px}.replying-copy strong,.replying-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.replying-copy strong{color:#0f1419;font-size:12px}.replying-copy span{color:#536471;font-size:12px}.replying-preview>button{width:30px;height:30px;flex:0 0 30px;padding:0;border:0;border-radius:50%;background:transparent;color:#536471;font-size:22px}.replying-preview>button:active{background:#e8ecef}
.selected-image{position:relative;width:64px;height:64px;margin:0 0 8px 24px}.selected-image img{width:100%;height:100%;object-fit:cover;border:1px solid #e2e8f0;border-radius:12px}.selected-image button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:#263241;color:#fff}.voice-error{margin:0 24px 6px;color:#dc2626;font-size:12px}
.chat-composer{position:relative;width:calc(100% - 48px);min-width:0;margin:0 auto;border:1px solid #d8dee5;border-radius:24px;background:#fff;box-shadow:0 4px 18px rgba(15,23,42,.11);transition:width 180ms ease,border-color 180ms ease,box-shadow 180ms ease}.chat-composer:focus-within{width:calc(100% - 32px);border-color:#c8d0d9;box-shadow:0 5px 20px rgba(15,23,42,.13)}.composer-normal{display:grid;box-sizing:border-box;min-width:0;min-height:48px;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;padding:2px 8px;transition:min-height 180ms ease}.composer-normal textarea{grid-column:2;grid-row:1;min-width:0;min-height:36px;max-height:108px;box-sizing:border-box;padding:7px 6px 6px;border:0;outline:0;resize:none;overflow-y:hidden;background:transparent;color:#0f1419;font:inherit;font-size:16px;line-height:22px}.composer-actions{display:contents}.composer-actions-spacer{display:none}.composer-actions .attachment-button{grid-column:1;grid-row:1}.composer-actions .send-button{grid-column:3;grid-row:1}.persistent-microphone{grid-column:3;grid-row:1;align-self:center;justify-self:end;z-index:1}.composer-normal:focus-within{min-height:76px;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 34px;align-items:stretch;padding:6px 8px 4px}.composer-normal:focus-within textarea{grid-column:1;grid-row:1;width:100%;padding:4px 6px 3px}.composer-normal:focus-within .composer-actions{display:flex;grid-column:1;grid-row:2;min-width:0;min-height:34px;align-items:center;justify-content:space-between}.composer-normal:focus-within .composer-actions-spacer{display:block;flex:1}.composer-normal:focus-within .persistent-microphone{grid-column:1;grid-row:2;justify-self:end;align-self:center}.composer-normal.voice-active{display:flex;min-height:48px;align-items:center;gap:4px;padding:2px 8px}.composer-normal.voice-active .persistent-microphone{margin-left:auto}.composer-preview{display:flex;box-sizing:border-box;min-width:0;min-height:48px;align-items:center;gap:4px;padding:2px 8px}.image-input{display:none}.attachment-file-input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:pointer}.attachment-button.disabled{opacity:.36;pointer-events:none}.composer-icon-button{display:grid;position:relative;width:44px;height:44px;flex:0 0 44px;margin:-5px;padding:5px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419;-webkit-tap-highlight-color:transparent}.composer-icon-visual{display:grid;width:34px;height:34px;place-items:center;border-radius:50%;background:transparent}.composer-icon-visual svg{display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.attachment-button .composer-icon-visual svg{width:20px;height:20px;stroke-width:1.8}.microphone-button{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:none}.microphone-button.active .composer-icon-visual{background:#f1f5f9}.send-button{color:#fff}.send-button .send-visual{background:#0f1419}.send-button .send-visual svg{width:18px;height:18px}.chat-composer button:disabled{opacity:.36}
.composer-recording{display:flex;min-width:0;flex:1;height:46px;align-items:center;gap:8px;padding:0 8px;touch-action:none}.recording-dot{width:9px;height:9px;flex:0 0 9px;border-radius:50%;background:#ef4444;animation:recording-pulse 1.2s ease-in-out infinite}.composer-recording.cancelling .recording-dot{animation:none}.composer-recording strong{font-size:14px;font-variant-numeric:tabular-nums}.voice-waveform{display:flex;height:22px;align-items:center;gap:2px}.voice-waveform i{display:block;width:2px;height:8px;border-radius:2px;background:#8b98a5;animation:voice-wave .72s ease-in-out infinite alternate}.voice-waveform i:nth-child(2){animation-delay:-.18s}.voice-waveform i:nth-child(3){animation-delay:-.36s}.voice-waveform i:nth-child(4){animation-delay:-.54s}.voice-waveform i:nth-child(5){animation-delay:-.27s}.voice-gesture-hint{margin-left:auto;color:#657786;font-size:12px;white-space:nowrap}.composer-recording.cancelling .voice-gesture-hint{color:#dc2626}.voice-lock-label{margin-left:auto;color:#657786;font-size:12px}.composer-recording button{min-width:50px;height:38px;border:0;background:transparent;color:#536471;font-weight:600}.composer-recording .finish-recording{color:#1687e8}.finishing-label{margin-left:auto;color:#536471;font-size:14px}.composer-preview{padding-left:10px}.composer-voice-preview{min-width:0;flex:1}.composer-preview :deep(.voice-message){min-width:0;grid-template-columns:34px minmax(70px,1fr) 36px}.remove-audio{font-size:25px;color:#64748b}
@keyframes recording-pulse{50%{opacity:.35}}@keyframes voice-wave{from{height:5px}to{height:19px}}
@media (min-width:768px){.composer-region{padding-bottom:16px}.message-list{width:min(100%,720px);margin:0 auto}}
@media (prefers-reduced-motion:reduce){.message-line.message-highlight .message-bubble{animation:none;box-shadow:0 0 0 3px rgba(22,135,232,.16)}}

/* PR2 disappearing-message UI: small opt-in control without changing composer geometry. */
.dm-attachment-menu{position:absolute;z-index:12;left:24px;bottom:calc(100% + 5px);display:grid;min-width:188px;overflow:hidden;border:1px solid #e5eaf0;border-radius:17px;background:#fff;box-shadow:0 10px 32px rgba(15,23,42,.17)}
.dm-attachment-menu button{display:flex;min-height:48px;align-items:center;gap:12px;padding:0 16px;border:0;border-bottom:1px solid #f0f2f4;background:transparent;color:#0f1419;text-align:left;font:inherit;font-size:14px}
.dm-attachment-menu button:last-child{border-bottom:0}.dm-attachment-menu button:active{background:#f4f6f8}.dm-attachment-menu button span{display:inline-grid;width:23px;place-items:center;font-size:21px;color:#64748b}
.temporary-composer-mode{display:flex;align-items:center;gap:8px;margin:0 24px 7px;padding:6px 9px 6px 12px;border:1px solid #f4ddd9;border-radius:13px;background:#fff8f7;color:#94423c;font-size:12px}
.temporary-composer-mode>span{font-weight:650;flex:1;white-space:nowrap}.temporary-composer-mode label{color:#8d5752}.temporary-composer-mode select{max-width:100px;min-height:30px;padding:3px 6px;border:1px solid #e9c8c3;border-radius:9px;background:#fff;color:#5d342f;font:inherit;font-size:13px}
.temporary-composer-mode button{width:28px;height:30px;flex-shrink:0;padding:0;border:0;background:transparent;color:#8d5752;font-size:23px}
.sr-file-input{position:absolute!important;width:1px!important;height:1px!important;left:-9999px!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important}
.message-line .disappearing-bubble{min-width:154px;max-width:min(76vw,290px);border:1px solid #eae2e0;background:#fcf9f8;color:#3b3030}
.message-line.own .disappearing-bubble{border-color:#e9d0cd;background:#fbebea}
.temporary-message{display:flex;min-width:0;flex-direction:column;gap:5px}
.temporary-heading{font-size:13px;font-weight:650;color:#995950}.temporary-caption{font-size:11px;color:#996b65}
.temporary-countdown{display:block;padding-top:5px;border-top:1px solid #e8dcd9;color:#a55249;font-size:11px;font-variant-numeric:tabular-nums}
.temporary-reveal{display:flex;width:100%;min-width:150px;flex-direction:column;gap:4px;padding:2px 0;border:0;background:transparent;color:#6c403d;text-align:left;cursor:pointer}
.temporary-reveal strong{font-size:13px;font-weight:650}.temporary-reveal>span{font-size:14px;color:#bd584f}.temporary-reveal small{font-size:11px;color:#927370}.temporary-reveal:disabled{opacity:.5}
.burned-placeholder{display:flex;align-items:center;gap:6px;color:#8c8280;font-size:12px;white-space:nowrap}
@media (max-width:360px){.temporary-composer-mode{margin-right:16px;margin-left:16px}.temporary-composer-mode select{max-width:85px}}
</style>
