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
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch
} from "vue";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, profileAvatarInitial, useProfilesStore } from "@/stores/profiles";
import { loadPrivateProfileAvatar } from "@/utils/profileAvatar";

const props = withDefaults(defineProps<{ pubkey: string; localName?: string; size?: number }>(), { size: 38 });
const keys = useKeyStore();
const profiles = useProfilesStore();
const root = ref<HTMLElement | null>(null);
const nearVisible = ref(false);
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
let controller: AbortController | null = null;
let visibilityObserver: IntersectionObserver | null = null;
let active = true;
let scheduledGeneration = -1;

function clearObjectUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

function cancelPendingLoad() {
  generation += 1;
  scheduledGeneration = -1;
  controller?.abort();
  controller = null;
}

function resetAvatarState() {
  cancelPendingLoad();
  clearObjectUrl();
  picture.value = "";
  imageLoaded.value = false;
  imageFailed.value = false;
}

async function loadVisibleAvatar(targetGeneration: number) {
  const account = keys.pkHex;
  const pubkey = props.pubkey;
  if (!active || !nearVisible.value || !account || targetGeneration !== generation) return;

  if (profiles.loadedFor !== account) await profiles.load(account);
  if (
    !active
    || !nearVisible.value
    || targetGeneration !== generation
    || keys.pkHex !== account
    || props.pubkey !== pubkey
    || profiles.loadedFor !== account
  ) return;

  const avatar = profiles.getProfile(pubkey)?.avatar;
  if (!avatar || picture.value || imageFailed.value) return;

  const requestController = new AbortController();
  controller = requestController;
  try {
    const blob = await loadPrivateProfileAvatar(account, avatar, requestController.signal);
    if (
      requestController.signal.aborted
      || !active
      || !nearVisible.value
      || targetGeneration !== generation
      || keys.pkHex !== account
      || props.pubkey !== pubkey
      || profiles.getProfile(pubkey)?.avatar !== avatar
    ) return;
    const nextObjectUrl = URL.createObjectURL(blob);
    if (
      requestController.signal.aborted
      || targetGeneration !== generation
      || keys.pkHex !== account
      || props.pubkey !== pubkey
    ) {
      URL.revokeObjectURL(nextObjectUrl);
      return;
    }
    objectUrl = nextObjectUrl;
    picture.value = objectUrl;
  } catch (error) {
    if (requestController.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    if (targetGeneration === generation && keys.pkHex === account && props.pubkey === pubkey) imageFailed.value = true;
  } finally {
    if (controller === requestController) controller = null;
  }
}

function requestVisibleAvatar() {
  if (!active || !nearVisible.value || picture.value || imageFailed.value || !keys.pkHex) return;
  const targetGeneration = generation;
  if (scheduledGeneration === targetGeneration) return;
  scheduledGeneration = targetGeneration;
  void loadVisibleAvatar(targetGeneration).finally(() => {
    if (scheduledGeneration === targetGeneration) scheduledGeneration = -1;
  });
}

function disconnectVisibilityObserver() {
  visibilityObserver?.disconnect();
  visibilityObserver = null;
}

function observeVisibility() {
  disconnectVisibilityObserver();
  if (!active || !root.value) return;

  if (typeof IntersectionObserver === "undefined") {
    nearVisible.value = true;
    requestVisibleAvatar();
    return;
  }

  visibilityObserver = new IntersectionObserver(entries => {
    const visible = entries.some(entry => entry.isIntersecting);
    if (nearVisible.value === visible) return;
    nearVisible.value = visible;
    if (visible) requestVisibleAvatar();
    else if (controller) cancelPendingLoad();
  }, { rootMargin: "320px 0px" });
  visibilityObserver.observe(root.value);
}

watch(
  [() => keys.pkHex, () => props.pubkey, () => privateProfile.value?.avatar],
  () => {
    resetAvatarState();
    if (active && nearVisible.value) requestVisibleAvatar();
  },
  { immediate: true },
);

function handleImageError() {
  imageLoaded.value = false;
  imageFailed.value = true;
  picture.value = "";
  clearObjectUrl();
}

onMounted(() => {
  active = true;
  observeVisibility();
});

onActivated(() => {
  active = true;
  observeVisibility();
  if (nearVisible.value) requestVisibleAvatar();
});

onDeactivated(() => {
  active = false;
  disconnectVisibilityObserver();
  nearVisible.value = false;
  cancelPendingLoad();
});

onBeforeUnmount(() => {
  active = false;
  disconnectVisibilityObserver();
  cancelPendingLoad();
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
