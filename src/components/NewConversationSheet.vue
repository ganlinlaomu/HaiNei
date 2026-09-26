<template>
  <Teleport to="body">
    <Transition name="new-conversation">
      <div v-if="visible" class="sheet-backdrop" role="presentation" @click.self="emit('close')">
        <section class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title">
          <header class="sheet-header">
            <button type="button" class="close-button" aria-label="关闭" @click="emit('close')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
            <h2 id="new-conversation-title">新私信</h2>
            <span></span>
          </header>

          <label class="friend-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
            <input v-model="query" type="search" placeholder="搜索已接受的好友" autocomplete="off" />
          </label>

          <div class="friend-list">
            <div v-if="loading" class="sheet-state" role="status" aria-live="polite">
              <span class="loading-spinner" aria-hidden="true"></span>
              <span>正在加载好友…</span>
            </div>
            <div v-else-if="loadError" class="sheet-state error-state" role="alert">
              <strong>好友加载失败</strong>
              <span>{{ loadError }}</span>
              <button type="button" @click="load">重新加载</button>
            </div>
            <template v-else>
              <button
                v-for="friend in filteredFriends"
                :key="friend.pubkey"
                class="friend-row"
                type="button"
                @click="selectFriend(friend.pubkey)"
              >
                <ProfileAvatar :pubkey="friend.pubkey" :local-name="friend.localName" :size="44" />
                <span class="friend-copy">
                  <strong>{{ friend.displayName }}</strong>
                  <small v-if="friend.note">{{ friend.note }}</small>
                </span>
                <svg class="row-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </template>
            <div v-if="!loading && !loadError && filteredFriends.length === 0" class="empty-friends">
              {{ query.trim() ? '未找到匹配的好友' : '暂无已接受的好友' }}
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ close: []; select: [pubkey: string] }>();
const keys = useKeyStore();
const friends = useFriendsStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();
const query = ref("");
const loading = ref(false);
const loadError = ref("");
let loadGeneration = 0;

const acceptedFriends = computed(() => friendships.records
  .filter(record => record.state === "accepted" && record.peerPubkey !== keys.pkHex)
  .map(record => {
    const local = friends.list.find(friend => friend.pubkey === record.peerPubkey);
    const profile = profiles.getProfile(record.peerPubkey);
    const localName = local?.name?.trim() || undefined;
    return {
      pubkey: record.peerPubkey,
      localName,
      note: local?.note?.trim() || "",
      displayName: privateProfileDisplayName(profile?.nickname, record.peerPubkey, localName),
      profileName: profile?.nickname?.trim() || "",
    };
  })
  .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN")));

const filteredFriends = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (!needle) return acceptedFriends.value;
  return acceptedFriends.value.filter(friend => [friend.displayName, friend.localName, friend.note, friend.profileName]
    .some(value => value?.toLocaleLowerCase().includes(needle)));
});

async function load() {
  const generation = ++loadGeneration;
  const account = keys.pkHex;
  if (!account) {
    loading.value = false;
    loadError.value = "当前账号不可用";
    return;
  }
  loading.value = true;
  loadError.value = "";
  try {
    await Promise.all([friends.load(account), friendships.load(account), profiles.load(account)]);
  } catch (error) {
    if (generation === loadGeneration && keys.pkHex === account) {
      loadError.value = error instanceof Error ? error.message : "请稍后重试";
    }
  } finally {
    if (generation === loadGeneration && keys.pkHex === account) loading.value = false;
  }
}

function selectFriend(pubkey: string) {
  emit("close");
  emit("select", pubkey);
}

onMounted(load);
watch(() => props.visible, visible => {
  if (!visible) {
    query.value = "";
    loadError.value = "";
  } else {
    void load();
  }
});
</script>

<style scoped>
.sheet-backdrop{position:fixed;inset:0;z-index:120000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.36)}
.sheet-panel{display:flex;width:100%;max-height:min(72dvh,620px);padding-bottom:env(safe-area-inset-bottom);flex-direction:column;border-radius:20px 20px 0 0;background:#fff;box-shadow:0 -12px 36px rgba(15,23,42,.16);overflow:hidden}
.sheet-header{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;min-height:56px;padding:0 10px;border-bottom:1px solid #eff1f3}.sheet-header h2{margin:0;text-align:center;font-size:18px}.close-button{display:grid;width:40px;height:40px;padding:9px;place-items:center;border:0;border-radius:50%;background:transparent;color:#0f1419}.close-button svg,.friend-search svg,.row-arrow{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.close-button svg{width:22px;height:22px}
.friend-search{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;gap:9px;margin:12px 16px;padding:0 13px;border-radius:999px;background:#eff3f4;color:#536471}.friend-search svg{width:19px;height:19px}.friend-search input{width:100%;height:42px;padding:0;border:0;outline:0;background:transparent;color:#0f1419;font-size:15px}.friend-search input::placeholder{color:#536471}
.friend-list{min-height:120px;overflow-y:auto}.sheet-state{display:flex;min-height:180px;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:28px 20px;color:#536471;font-size:14px;text-align:center}.loading-spinner{width:22px;height:22px;border:2px solid #d7dde3;border-top-color:#1687e8;border-radius:50%;animation:sheet-spin .8s linear infinite}.error-state strong{color:#0f1419;font-size:15px}.error-state>span{max-width:320px;line-height:1.5}.error-state button{min-height:38px;margin-top:4px;padding:0 16px;border:0;border-radius:999px;background:#0f1419;color:#fff;font-weight:650}.friend-row{display:grid;grid-template-columns:44px minmax(0,1fr) 20px;align-items:center;gap:12px;width:100%;min-height:66px;padding:10px 16px;border:0;border-bottom:1px solid #eff1f3;background:#fff;color:#0f1419;text-align:left}.friend-row:active{background:#f7f9f9}.friend-copy{display:flex;min-width:0;flex-direction:column;gap:3px}.friend-copy strong,.friend-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.friend-copy strong{font-size:15px}.friend-copy small{color:#536471;font-size:12px}.row-arrow{width:18px;height:18px;color:#8b98a5}.empty-friends{padding:36px 20px 48px;color:#536471;font-size:14px;text-align:center}
@keyframes sheet-spin{to{transform:rotate(360deg)}}
.new-conversation-enter-active,.new-conversation-leave-active{transition:opacity 160ms ease}.new-conversation-enter-active .sheet-panel,.new-conversation-leave-active .sheet-panel{transition:transform 160ms ease}.new-conversation-enter-from,.new-conversation-leave-to{opacity:0}.new-conversation-enter-from .sheet-panel,.new-conversation-leave-to .sheet-panel{transform:translateY(18px)}
@media (min-width:768px){.sheet-backdrop{align-items:center;padding:24px}.sheet-panel{max-width:620px;margin:0;padding-bottom:0;border-radius:20px}}
</style>
