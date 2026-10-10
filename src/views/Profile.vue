<template>
  <main class="profile-view app-page">
    <SecondaryPageHeader title="个人资料" back-label="返回上一页" back-mode="history" />

    <section v-if="!ready" class="unavailable" aria-live="polite">
      <p>正在加载资料…</p>
    </section>

    <section v-else-if="!canView" class="unavailable" aria-live="polite">
      <h2>资料不可用</h2>
      <p>仅自己和已接受的好友可查看私密资料。</p>
    </section>

    <template v-else>
      <section class="profile-content">
        <ProfileAvatar :pubkey="ownerPubkey" :size="88" />
        <h2>{{ ownerName }}</h2>
        <p v-if="profile?.bio" class="bio">{{ profile.bio }}</p>
        <p v-else class="bio empty">暂无简介</p>
        <div v-if="localNote" class="profile-meta">
          <span>你的备注</span>
          <strong>{{ localNote }}</strong>
        </div>
        <div v-if="!isSelf" class="friend-state">已接受的好友</div>
        <div class="profile-actions">
          <button v-if="isSelf" class="message-button" type="button" @pointerdown="loadMyProfileView" @focus="loadMyProfileView" @click="router.push('/settings/profile')">编辑资料</button>
          <button v-else-if="canMessage" class="message-button" type="button" @pointerdown="loadMessagesView" @focus="loadMessagesView" @click="router.push(`/messages/${ownerPubkey}`)">私信</button>
          <button class="secondary-action" type="button" :aria-label="isSelf ? '复制我的公钥' : '复制用户公钥'" @click="copyPubkey">复制公钥</button>
          <button class="secondary-action" type="button" :aria-label="isSelf ? '打开我的二维码' : '打开用户二维码'" @click="showQr = true">二维码</button>
        </div>
        <button v-if="!isSelf && feedPreferences.isMuted(ownerPubkey)" class="unmute-button" type="button" @click="feedPreferences.unmute(ownerPubkey)">恢复显示此人的动态</button>
      </section>

      <MyQrCodeSheet
        :open="showQr"
        :pubkey="ownerPubkey"
        :nickname="ownerName"
        :dialog-label="isSelf ? '我的二维码' : '用户二维码'"
        :hint="isSelf ? '扫描二维码即可识别我的公钥' : '扫描二维码即可识别此用户'"
        @close="showQr = false"
      />

      <section class="profile-posts" aria-label="用户动态">
        <h3>动态</h3>
        <div v-if="ownerPosts.length" class="post-list">
          <PostCard v-for="post in ownerPosts" :key="post.id" :message="post" flat />
        </div>
        <p v-else class="empty-posts">暂无动态</p>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import PostCard from "@/components/PostCard.vue";
import MyQrCodeSheet from "@/components/MyQrCodeSheet.vue";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { isHaiNeiBot } from "@/utils/haineiBot";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { useUIStore } from "@/stores/ui";
import {
  isFeedRenderableMessage,
  syncedMessageRecordToInboxItem,
} from "@/nostr/messaging/messageViewModel";
import { canViewPrivateProfile } from "@/utils/profileNavigation";
import { useFeedPreferencesStore } from "@/stores/feedPreferences";
import { pubkeyToNpub } from "@/utils/nostrQr";
import { loadMessagesView, loadMyProfileView } from "@/router/lazyViews";
import { loadAccountStoresOnce, storesLoadedForAccount, waitForFirstPaint } from "@/utils/bottomTabActivation";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";

const route = useRoute();
const router = useRouter();
const keys = useKeyStore();
const friends = useFriendsStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();
const messages = useMessagesStore();
const feedPreferences = useFeedPreferencesStore();
const ui = useUIStore();
const ready = ref(storesLoadedForAccount(keys.pkHex, [friends, friendships, profiles, messages, feedPreferences]));
const showQr = ref(false);
let loadGeneration = 0;
const ownerPubkey = computed(() => String(route.params.pubkey || "").trim().toLowerCase());
const isSelf = computed(() => ownerPubkey.value === keys.pkHex);
const canView = computed(() => canViewPrivateProfile(
  keys.pkHex,
  ownerPubkey.value,
  pubkey => friendships.loadedFor === keys.pkHex && friendships.isAccepted(pubkey)
));
const profile = computed(() => canView.value && profiles.loadedFor === keys.pkHex
  ? profiles.getProfile(ownerPubkey.value)
  : undefined);
const ownerName = computed(() => isHaiNeiBot(ownerPubkey.value)
  ? privateProfileDisplayName(
      profile.value?.nickname, ownerPubkey.value,
      friends.list.find(friend => friend.pubkey === ownerPubkey.value)?.name,
    )
  : profile.value?.nickname?.trim() || `${ownerPubkey.value.slice(0, 8)}…`);
const localNote = computed(() => {
  if (!canView.value || isSelf.value) return "";
  const value = friends.list.find(friend => friend.pubkey === ownerPubkey.value)?.name?.trim() || "";
  if (!value || value === ownerName.value || value === `${ownerPubkey.value.slice(0, 8)}…` || value === `${ownerPubkey.value.slice(0, 8)}...`) return "";
  return value;
});
const canMessage = computed(() => ownerPubkey.value !== keys.pkHex
  && friendships.loadedFor === keys.pkHex
  && friendships.isAccepted(ownerPubkey.value));
async function copyPubkey() {
  if (!ownerPubkey.value) return;
  try {
    await navigator.clipboard.writeText(pubkeyToNpub(ownerPubkey.value));
    ui.addToast("已复制 npub 公钥", 1_800, "success");
  } catch {
    ui.addToast("复制失败，请稍后重试", 2_000, "error");
  }
}

const historicalOwnerPosts = ref<InboxItem[]>([]);

function isProfilePost(message: InboxItem) {
  return message.pubkey.toLowerCase() === ownerPubkey.value
    && isFeedRenderableMessage(message)
    && !feedPreferences.isHidden(message.id);
}

function compareProfilePosts(left: InboxItem, right: InboxItem) {
  return (right.created_at || 0) - (left.created_at || 0) || left.id.localeCompare(right.id);
}

const ownerPosts = computed(() => {
  if (!canView.value || messages.loadedFor !== keys.pkHex) return [];
  const merged = new Map<string, InboxItem>();
  for (const message of historicalOwnerPosts.value) merged.set(message.id, message);
  // Current inbox wins so optimistic delivery state and realtime replacements
  // stay identical to the Home card for the same message.
  for (const message of messages.inbox) merged.set(message.id, message);
  return [...merged.values()].filter(isProfilePost).sort(compareProfilePosts);
});

async function load() {
  const generation = ++loadGeneration;
  const account = keys.pkHex;
  const owner = ownerPubkey.value;
  historicalOwnerPosts.value = [];
  if (!account) {
    ready.value = false;
    return;
  }
  const stores = [friends, friendships, profiles, messages, feedPreferences];
  const alreadyLocal = storesLoadedForAccount(account, stores);
  if (!alreadyLocal) {
    ready.value = false;
    await waitForFirstPaint();
  }
  await loadAccountStoresOnce(account, stores);
  if (generation !== loadGeneration || keys.pkHex !== account) return;

  if (owner && canView.value) {
    const records = await syncedMessageRepository.listBySender(account, owner);
    if (generation !== loadGeneration || keys.pkHex !== account || ownerPubkey.value !== owner) return;
    historicalOwnerPosts.value = records.map(syncedMessageRecordToInboxItem);
  }

  if (generation === loadGeneration && keys.pkHex === account) ready.value = true;
}

onMounted(load);
watch([() => keys.pkHex, ownerPubkey], load);
</script>

<style scoped>
.profile-view{width:100%;margin:0 auto;box-sizing:border-box;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.profile-content{display:flex;flex-direction:column;align-items:center;padding:18px}.profile-content h2{margin:14px 0 8px;font-size:23px;color:#172033}.bio{width:100%;max-width:420px;margin:0;padding:14px 0 20px;color:#475569;line-height:1.65;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere}.bio.empty{color:#94a3b8}.profile-meta{width:100%;max-width:420px;display:flex;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid #e2e8f0;color:#64748b;font-size:14px}.profile-meta strong{color:#334155}.friend-state{margin-top:10px;padding:6px 10px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px}.profile-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:14px}.profile-actions button{min-height:42px;padding:0 16px;border-radius:999px;font-weight:700;cursor:pointer}.message-button{min-width:112px;border:0;background:#1687e8;color:#fff}.secondary-action{border:1px solid #cbd5e1;background:#fff;color:#334155}.unmute-button{margin-top:14px;min-height:42px;padding:0 14px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#334155}.profile-posts{width:100%;box-sizing:border-box;padding:4px 0 0}.profile-posts h3{margin:6px 16px 8px;padding-top:14px;border-top:1px solid #e8edf3;color:#172033;font-size:17px}.post-list{display:grid;gap:0}.empty-posts{margin:0;padding:40px 16px 56px;color:#94a3b8;text-align:center;font-size:14px}.unavailable{padding:64px 16px;text-align:center}.unavailable h2{margin:0 0 8px;font-size:20px}.unavailable p{margin:0;color:#64748b;font-size:14px}
@media (min-width:768px){.unavailable{max-width:640px;margin-left:auto;margin-right:auto}}
</style>
