<template>
  <span
    class="profile-avatar"
    :style="avatarStyle"
    role="img"
    :aria-label="`${displayName}的头像`"
  >
    <span class="avatar-fallback" aria-hidden="true">{{ initial }}</span>
    <img
      v-if="picture && !imageFailed"
      class="avatar-image"
      :class="{ ready: imageLoaded }"
      :src="picture"
      :alt="`${displayName}的头像`"
      :width="size"
      :height="size"
      loading="lazy"
      decoding="async"
      @load="imageLoaded = true"
      @error="handleImageError"
    />
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, profileAvatarInitial, useProfilesStore } from "@/stores/profiles";
import { loadPrivateProfileAvatar } from "@/utils/profileAvatar";

const props = withDefaults(defineProps<{ pubkey: string; localName?: string; size?: number }>(), { size: 38 });
const keys = useKeyStore();
const profiles = useProfilesStore();
const imageLoaded = ref(false);
const imageFailed = ref(false);
const picture = ref("");
const privateProfile = computed(() => profiles.getProfile(props.pubkey));
const displayName = computed(() => privateProfileDisplayName(privateProfile.value?.nickname, props.pubkey, props.localName));
const initial = computed(() => profileAvatarInitial(privateProfile.value?.nickname, props.pubkey, props.localName));
const hue = computed(() => {
  let hash = 0;
  for (const char of props.pubkey) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
});
const size = computed(() => Math.max(24, Math.min(64, props.size)));
const avatarStyle = computed(() => ({
  "--avatar-size": `${size.value}px`,
  "--avatar-color": `hsl(${hue.value} 48% 48%)`
}));

let objectUrl = "";
let generation = 0;
function clearObjectUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

watch([() => keys.pkHex, () => props.pubkey, () => privateProfile.value?.avatar], async ([account, _pubkey, avatar]) => {
  const current = ++generation;
  clearObjectUrl();
  picture.value = "";
  imageLoaded.value = false;
  imageFailed.value = false;
  if (!account) return;
  if (profiles.loadedFor !== account) await profiles.load(account);
  if (!avatar || current !== generation || keys.pkHex !== account) return;
  try {
    const blob = await loadPrivateProfileAvatar(account, avatar);
    if (current !== generation || keys.pkHex !== account) return;
    objectUrl = URL.createObjectURL(blob);
    picture.value = objectUrl;
  } catch {
    if (current === generation) imageFailed.value = true;
  }
}, { immediate: true });

function handleImageError() {
  imageLoaded.value = false;
  imageFailed.value = true;
}
onBeforeUnmount(() => { generation++; clearObjectUrl(); });
</script>

<style scoped>
.profile-avatar{position:relative;display:inline-grid;place-items:center;width:var(--avatar-size);height:var(--avatar-size);min-width:var(--avatar-size);overflow:hidden;border-radius:50%;background:var(--avatar-color);color:#fff;line-height:1;vertical-align:middle}
.avatar-fallback{font-size:calc(var(--avatar-size) * .39);font-weight:700;text-transform:uppercase}
.avatar-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;background:#e2e8f0}
.avatar-image.ready{opacity:1}
@media(prefers-reduced-motion:no-preference){.avatar-image{transition:opacity .15s ease}}
</style>
