<template>
  <main class="conversations-page">
    <header class="page-header"><h1>私信</h1></header>
    <div v-if="conversations.length === 0" class="empty-state">
      <strong>还没有私信</strong>
      <span>可从好友列表或好友资料页开始对话。</span>
    </div>
    <div v-else class="conversation-list">
      <button
        v-for="conversation in conversations"
        :key="conversation.peerPubkey"
        class="conversation-row"
        type="button"
        @click="openConversation(conversation.peerPubkey)"
      >
        <ProfileAvatar :pubkey="conversation.peerPubkey" :local-name="localName(conversation.peerPubkey)" :size="48" />
        <span class="conversation-copy">
          <strong>{{ displayName(conversation.peerPubkey) }}</strong>
          <span class="preview">{{ preview(conversation.latest.content) }}</span>
        </span>
        <span class="conversation-meta">
          <time>{{ formatRelativeTime(conversation.latest.created_at) }}</time>
          <span v-if="conversation.unread" class="unread-badge" :aria-label="`${conversation.unread} 条未读私信`">{{ conversation.unread > 99 ? '99+' : conversation.unread }}</span>
        </span>
      </button>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { buildDirectConversationSummaries, useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore } from "@/stores/messages";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { formatRelativeTime } from "@/utils/format";

const router = useRouter();
const keys = useKeyStore();
const messages = useMessagesStore();
const directMessages = useDirectMessagesStore();
const friends = useFriendsStore();
const profiles = useProfilesStore();
const conversations = computed(() => buildDirectConversationSummaries(
  messages.inbox,
  keys.pkHex,
  directMessages.unreadByConversation,
));
const localName = (pubkey: string) => friends.list.find(friend => friend.pubkey === pubkey)?.name;
const displayName = (pubkey: string) => privateProfileDisplayName(profiles.getProfile(pubkey)?.nickname, pubkey, localName(pubkey));
const preview = (content: string) => directMessagePreview(content) || "新消息";

async function load() {
  const account = keys.pkHex;
  if (!account) return;
  await Promise.all([messages.load(account), directMessages.refresh(account), friends.load(account), profiles.load(account)]);
}
function openConversation(pubkey: string) {
  void router.push(`/messages/${pubkey}`);
}

onMounted(load);
onActivated(load);
watch(() => `${keys.pkHex}:${messages.inbox.length}:${messages.inbox[0]?.id || ""}`, () => { void directMessages.refresh(keys.pkHex); });
</script>

<style scoped>
.conversations-page{min-height:100vh;max-width:620px;margin:0 auto;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 28px);background:#fff}.page-header{position:sticky;top:0;z-index:4;display:flex;align-items:center;min-height:58px;padding:0 16px;border-bottom:1px solid #edf0f3;background:rgba(255,255,255,.96)}.page-header h1{margin:0;font-size:21px}.conversation-list{display:flex;flex-direction:column}.conversation-row{display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-height:72px;padding:11px 16px;border:0;border-bottom:1px solid #eef1f4;background:#fff;color:#18202c;text-align:left;cursor:pointer}.conversation-row:active{background:#f8fafc}.conversation-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.conversation-copy strong,.preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-copy strong{font-size:15px}.preview{color:#7a8492;font-size:13px}.conversation-meta{display:flex;align-items:flex-end;gap:7px;flex-direction:column;color:#8a94a2;font-size:11px}.unread-badge{display:grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#2997ff;color:#fff;font-size:10px;font-weight:700}.empty-state{display:flex;min-height:48vh;align-items:center;justify-content:center;flex-direction:column;gap:6px;padding:24px;color:#8a94a2;text-align:center}.empty-state strong{color:#334155;font-size:16px}.empty-state span{font-size:13px}
</style>
