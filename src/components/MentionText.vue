<template>
  <span class="mention-text">
    <template v-for="(segment, index) in segments" :key="index">
      <button
        v-if="segment.type === 'mention'"
        class="mention-link"
        type="button"
        @click.stop="openMention(segment.pubkey, $event)"
      >{{ segment.text }}</button>
      <template v-else>{{ segment.text }}</template>
    </template>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { splitKnownMentions, type KnownMention } from "@/utils/mentions";
import { HAINEI_BOT_NAME, isHaiNeiBot } from "@/utils/haineiBot";
import { openProfile } from "@/utils/profileNavigation";

const props = defineProps<{ text: string }>();
const router = useRouter();
const keys = useKeyStore();
const friends = useFriendsStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();

const known = computed<KnownMention[]>(() => {
  const peerMentions = friends.getAcceptedList(friendships.isAccepted).map(friend => {
    const profileName = profiles.getProfile(friend.pubkey)?.nickname?.trim();
    const fallback = `${friend.pubkey.slice(0, 8)}…`;
    const labels = [...new Set([isHaiNeiBot(friend.pubkey) ? HAINEI_BOT_NAME : undefined, profileName, friend.name?.trim(), fallback]
      .filter((value): value is string => !!value))];
    return { pubkey: friend.pubkey, labels };
  });
  const account = keys.pkHex.toLowerCase();
  if (!account) return peerMentions;
  const ownName = profiles.getProfile(account)?.nickname?.trim();
  return [
    ...peerMentions,
    { pubkey: account, labels: [...new Set([ownName, `${account.slice(0, 8)}…`].filter((value): value is string => !!value))] },
  ];
});

const segments = computed(() => splitKnownMentions(props.text, known.value));

function openMention(pubkey: string, event: Event) {
  return openProfile(router, keys.pkHex, pubkey, event);
}
</script>

<style scoped>
.mention-text{white-space:inherit}
.mention-link{display:inline;padding:0;border:0;background:transparent;color:#2563eb;font:inherit;line-height:inherit;vertical-align:baseline;cursor:pointer}
.mention-link:focus-visible{outline:2px solid #2563eb;outline-offset:2px;border-radius:3px}
</style>
