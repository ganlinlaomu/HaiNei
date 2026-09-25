<template>
  <main class="profile-page app-page">
    <header class="profile-topbar">
      <button class="back-button" type="button" aria-label="返回" @click="router.back()">‹</button>
      <h1>我的资料</h1>
    </header>

    <section class="profile-editor">
      <form @submit.prevent="save">
        <div class="avatar-area">
          <label class="avatar-picker" aria-label="选择头像">
            <ProfileAvatar :pubkey="keys.pkHex" :local-name="nickname" :size="84" />
            <span class="avatar-edit" aria-hidden="true">✎</span>
            <input type="file" accept="image/*" @change="selectAvatar" />
          </label>
          <span class="avatar-hint">{{ avatarFile ? avatarFile.name : "点击头像更换" }}</span>
          <p>仅自己和已接受的好友可见</p>
        </div>

        <label class="field">
          <span>昵称</span>
          <input v-model="nickname" class="input" maxlength="100" autocomplete="nickname" />
        </label>
        <label class="field">
          <span>简介</span>
          <textarea v-model="bio" class="input bio" maxlength="500" rows="4"></textarea>
        </label>
        <button class="btn btn-primary save-button" type="submit">保存</button>
      </form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { acceptedProfileRecipients, useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";
import { uploadPrivateProfileAvatar } from "@/utils/profileAvatar";

const router = useRouter();
const keys = useKeyStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();
const ui = useUIStore();
const nickname = ref("");
const bio = ref("");
const avatarFile = ref<File | null>(null);
const draftLoadedFor = ref("");

function populateDraft() {
  const account = keys.pkHex;
  if (!account || profiles.loading || draftLoadedFor.value === account) return;
  const current = profiles.getProfile(account);
  nickname.value = current?.nickname || "";
  bio.value = current?.bio || "";
  avatarFile.value = null;
  draftLoadedFor.value = account;
}

onMounted(async () => {
  await Promise.all([profiles.load(keys.pkHex), friendships.load(keys.pkHex)]);
  populateDraft();
});
watch(() => keys.pkHex, async account => {
  draftLoadedFor.value = "";
  if (account) await Promise.all([profiles.load(account), friendships.load(account)]);
  populateDraft();
});
watch(() => profiles.loading, loading => { if (!loading) populateDraft(); });

function selectAvatar(event: Event) {
  avatarFile.value = (event.target as HTMLInputElement).files?.[0] || null;
}

async function save() {
  const account = keys.pkHex;
  if (!account) return;
  const previous = profiles.getProfile(account);
  const updatedAt = Math.max(Date.now(), (previous?.updatedAt || 0) + 1);
  const local = await profiles.saveOwnProfile({
    nickname: nickname.value,
    bio: bio.value,
    avatar: previous?.avatar
  }, updatedAt);
  ui.addToast("资料已保存，正在私密同步", 2_000, "success");
  const selected = avatarFile.value;
  void (async () => {
    let finalProfile = local;
    let avatarError: unknown;
    try {
      if (selected) {
        try {
          const avatar = await uploadPrivateProfileAvatar(selected, {
            accountPubkey: account,
            signEvent: keys.signEvent.bind(keys)
          });
          if (keys.pkHex !== account) return;
          finalProfile = await profiles.saveOwnProfile({
            nickname: nickname.value,
            bio: bio.value,
            avatar
          }, Math.max(Date.now(), local.updatedAt + 1));
          avatarFile.value = null;
        } catch (error) {
          avatarError = error;
        }
      }
      if (keys.pkHex !== account) return;
      const accepted = acceptedProfileRecipients(friendships.records);
      await profiles.sendProfile(finalProfile, accepted);
      if (keys.pkHex === account) {
        if (avatarError) {
          const reason = avatarError instanceof Error ? avatarError.message : "头像上传失败";
          ui.addToast(`昵称和简介已同步，头像未更新：${reason}`, 3_000, "error");
        } else {
          ui.addToast("资料已同步", 2_000, "success");
        }
      }
    } catch (error) {
      if (keys.pkHex === account) {
        const reason = error instanceof Error ? error.message : "同步失败";
        ui.addToast(`资料已保存在本机：${reason}`, 3_000, "error");
      }
    }
  })();
}
</script>

<style scoped>
.profile-page{width:100%;margin:0 auto;box-sizing:border-box;padding:8px 14px calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.profile-topbar{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:48px}.profile-topbar h1{grid-column:2;margin:0;text-align:center;font-size:18px}.back-button{grid-column:1;width:40px;height:40px;border:0;border-radius:10px;background:transparent;color:#334155;font-size:28px;cursor:pointer}.profile-editor{padding:6px 2px 0}.avatar-area{display:flex;flex-direction:column;align-items:center;margin:8px 0 24px}.avatar-picker{position:relative;display:inline-grid;border-radius:50%;cursor:pointer}.avatar-picker input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.avatar-edit{position:absolute;right:-2px;bottom:1px;display:grid;place-items:center;width:27px;height:27px;border:2px solid #fff;border-radius:50%;background:#2563eb;color:#fff;font-size:14px;pointer-events:none}.avatar-hint{margin-top:8px;max-width:240px;color:#2563eb;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.avatar-area p{margin:5px 0 0;color:#64748b;font-size:12px}.field{display:grid;gap:7px;margin-bottom:15px;color:#334155;font-size:14px}.input{width:100%;box-sizing:border-box}.bio{min-height:104px;resize:vertical;padding:10px}.save-button{width:100%;min-height:46px;margin-top:2px}
@media (min-width:768px){.profile-editor{max-width:560px;margin:0 auto}}
</style>
