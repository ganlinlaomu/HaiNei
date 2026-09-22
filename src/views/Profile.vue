<template>
  <main class="profile-view">
    <header class="profile-topbar">
      <button class="back-button" type="button" aria-label="返回" @click="router.back()">‹</button>
      <h1>个人资料</h1>
    </header>

    <section v-if="!ready" class="unavailable" aria-live="polite">
      <p>正在加载资料…</p>
    </section>

    <section v-else-if="!canView" class="unavailable" aria-live="polite">
      <h2>资料不可用</h2>
      <p>仅自己和已接受的好友可查看私密资料。</p>
    </section>

    <section v-else class="profile-content">
      <ProfileAvatar :pubkey="ownerPubkey" :size="88" />
      <h2>{{ ownerName }}</h2>
      <p v-if="profile?.bio" class="bio">{{ profile.bio }}</p>
      <p v-else class="bio empty">暂无简介</p>
      <div v-if="localNote" class="profile-meta">
        <span>你的备注</span>
        <strong>{{ localNote }}</strong>
      </div>
      <div class="friend-state">已接受的好友</div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { canViewPrivateProfile } from "@/utils/profileNavigation";

const route = useRoute();
const router = useRouter();
const keys = useKeyStore();
const friends = useFriendsStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();
const ready = ref(false);
let loadGeneration = 0;
const ownerPubkey = computed(() => String(route.params.pubkey || "").trim().toLowerCase());
const canView = computed(() => canViewPrivateProfile(
  keys.pkHex,
  ownerPubkey.value,
  pubkey => friendships.loadedFor === keys.pkHex && friendships.isAccepted(pubkey)
));
const profile = computed(() => canView.value && profiles.loadedFor === keys.pkHex
  ? profiles.getProfile(ownerPubkey.value)
  : undefined);
const ownerName = computed(() => profile.value?.nickname?.trim() || `${ownerPubkey.value.slice(0, 8)}…`);
const localNote = computed(() => {
  if (!canView.value) return "";
  const value = friends.list.find(friend => friend.pubkey === ownerPubkey.value)?.name?.trim() || "";
  if (!value || value === ownerName.value || value === `${ownerPubkey.value.slice(0, 8)}…` || value === `${ownerPubkey.value.slice(0, 8)}...`) return "";
  return value;
});

async function load() {
  const generation = ++loadGeneration;
  ready.value = false;
  const account = keys.pkHex;
  if (!account) return;
  if (ownerPubkey.value === account) {
    await router.replace("/settings/profile");
    return;
  }
  await Promise.all([friends.load(account), friendships.load(account), profiles.load(account)]);
  if (generation === loadGeneration && keys.pkHex === account) ready.value = true;
}

onMounted(load);
watch([() => keys.pkHex, ownerPubkey], load);
</script>

<style scoped>
.profile-view{max-width:560px;margin:0 auto;padding:8px 14px calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.profile-topbar{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:48px;margin-bottom:18px}.profile-topbar h1{grid-column:2;margin:0;text-align:center;font-size:18px}.back-button{grid-column:1;width:40px;height:40px;border:0;border-radius:10px;background:transparent;color:#334155;font-size:28px;cursor:pointer}.profile-content{display:flex;flex-direction:column;align-items:center;padding:18px 4px}.profile-content h2{margin:14px 0 8px;font-size:23px;color:#172033}.bio{width:100%;max-width:420px;margin:0;padding:14px 0 20px;color:#475569;line-height:1.65;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere}.bio.empty{color:#94a3b8}.profile-meta{width:100%;max-width:420px;display:flex;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid #e2e8f0;color:#64748b;font-size:14px}.profile-meta strong{color:#334155}.friend-state{margin-top:10px;padding:6px 10px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px}.unavailable{padding:64px 16px;text-align:center}.unavailable h2{margin:0 0 8px;font-size:20px}.unavailable p{margin:0;color:#64748b;font-size:14px}
</style>
