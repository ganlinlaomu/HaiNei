<template>
  <main class="profile-page">
    <section class="card">
      <div class="profile-heading">
        <button class="back-button" type="button" @click="router.back()">‹</button>
        <div><h2>我的资料</h2><p>仅自己和已接受的好友可见</p></div>
      </div>

      <form @submit.prevent="save">
        <div class="avatar-row">
          <ProfileAvatar :pubkey="keys.pkHex" :local-name="nickname" :size="72" />
          <label class="avatar-picker">
            <span>{{ avatarFile ? avatarFile.name : "选择头像" }}</span>
            <input type="file" accept="image/*" @change="selectAvatar" />
          </label>
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
.profile-page{max-width:640px;margin:0 auto;padding:12px 12px calc(var(--bottom-nav-height) + 28px)}
.card{padding:18px}.profile-heading{display:flex;align-items:flex-start;gap:10px;margin-bottom:20px}.profile-heading h2{margin:0 0 4px}.profile-heading p{margin:0;color:#64748b;font-size:13px}.back-button{width:36px;height:36px;border:0;border-radius:9px;background:#f1f5f9;font-size:26px;color:#334155}.avatar-row{display:flex;align-items:center;gap:16px;margin-bottom:20px}.avatar-picker{position:relative;display:inline-flex;min-height:40px;align-items:center;padding:0 13px;border:1px solid #cbd5e1;border-radius:9px;color:#334155;font-size:13px;overflow:hidden}.avatar-picker input{position:absolute;inset:0;opacity:0;cursor:pointer}.field{display:grid;gap:7px;margin-bottom:16px;color:#334155;font-size:14px}.bio{min-height:110px;resize:vertical;padding:10px}.save-button{width:100%;min-height:44px}
</style>
