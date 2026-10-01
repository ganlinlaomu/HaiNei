<template>
  <span
    ref="root"
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
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, profileAvatarInitial, useProfilesStore } from "@/stores/profiles";
import { loadPrivateProfileAvatar } from "@/utils/profileAvatar";
import { observeNearViewport } from "@/utils/nearViewportObserver";

const props = withDefaults(defineProps<{ pubkey: string; localName?: string; size?: number }>(), { size: 38 });
const keys = useKeyStore();
const profiles = useProfilesStore();
const root = ref<HTMLElement | null>(null);
const imageLoaded = ref(false);
const imageFailed = ref(false);
const picture = ref("");
const nearViewport = ref(false);
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
let controller: AbortController | null = null;
let loadedIdentity = "";
let loadingIdentity = "";
let componentActive = true;
let stopObserving: (() => void) | null = null;

function clearObjectUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

function abortPending() {
  generation += 1;
  controller?.abort();
  controller = null;
  loadingIdentity = "";
}

function resetIdentity() {
  abortPending();
  clearObjectUrl();
  picture.value = "";
  imageLoaded.value = false;
  imageFailed.value = false;
  loadedIdentity = "";
}

async function ensureAvatarLoaded() {
  if (!componentActive || !nearViewport.value) return;
  const account = keys.pkHex;
  const pubkey = props.pubkey;
  if (!account || !pubkey) return;

  const checkGeneration = generation;
  if (profiles.loadedFor !== account) {
    await profiles.load(account);
    if (checkGeneration !== generation || !componentActive || !nearViewport.value || keys.pkHex !== account || props.pubkey !== pubkey) return;
  }

  const avatar = privateProfile.value?.avatar;
  if (!avatar) return;
  const identity = account + ":" + pubkey + ":" + avatar;
  if (loadedIdentity === identity && picture.value) return;
  if (loadingIdentity === identity) return;

  const current = ++generation;
  controller?.abort();
  const requestController = new AbortController();
  controller = requestController;
  loadingIdentity = identity;
  imageFailed.value = false;

  try {
    const blob = await loadPrivateProfileAvatar(account, avatar, requestController.signal);
    if (
      requestController.signal.aborted ||
      current !== generation ||
      !componentActive ||
      !nearViewport.value ||
      keys.pkHex !== account ||
      props.pubkey !== pubkey ||
      privateProfile.value?.avatar !== avatar
    ) return;

    clearObjectUrl();
    objectUrl = URL.createObjectURL(blob);
    picture.value = objectUrl;
    loadedIdentity = identity;
  } catch (error) {
    if (requestController.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    if (current === generation) imageFailed.value = true;
  } finally {
    if (controller === requestController) controller = null;
    if (loadingIdentity === identity) loadingIdentity = "";
  }
}

watch([() => keys.pkHex, () => props.pubkey, () => privateProfile.value?.avatar], () => {
  resetIdentity();
  void ensureAvatarLoaded();
});

watch(nearViewport, visible => {
  if (!visible) {
    abortPending();
    return;
  }
  void ensureAvatarLoaded();
});

onMounted(() => {
  componentActive = true;
  const element = root.value;
  if (!element) {
    nearViewport.value = true;
    void ensureAvatarLoaded();
    return;
  }
  stopObserving = observeNearViewport(element, visible => {
    nearViewport.value = visible;
  });
  void ensureAvatarLoaded();
});

onActivated(() => {
  componentActive = true;
  void ensureAvatarLoaded();
});

onDeactivated(() => {
  componentActive = false;
  abortPending();
});

function handleImageError() {
  imageLoaded.value = false;
  imageFailed.value = true;
}

onBeforeUnmount(() => {
  componentActive = false;
  stopObserving?.();
  stopObserving = null;
  abortPending();
  clearObjectUrl();
});
</script>

<style scoped>
.profile-avatar{position:relative;display:inline-grid;place-items:center;width:var(--avatar-size);height:var(--avatar-size);min-width:var(--avatar-size);overflow:hidden;border-radius:50%;background:var(--avatar-color);color:#fff;line-height:1;vertical-align:middle}
.avatar-fallback{font-size:calc(var(--avatar-size) * .39);font-weight:700;text-transform:uppercase}
.avatar-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;background:#e2e8f0}
.avatar-image.ready{opacity:1}
@media(prefers-reduced-motion:no-preference){.avatar-image{transition:opacity .15s ease}}
</style>
