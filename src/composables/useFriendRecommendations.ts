import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { serializeFriendRecommendation, type FriendRecommendation } from "@/nostr/messaging/friendRecommendation";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";
import { shortNpub } from "@/utils/nostrQr";
import { openProfile } from "@/utils/profileNavigation";

/**
 * NIP-17 friend recommendations in one chat: the received card's identity
 * and add/accept/view action, and the picker that sends one of our friends'
 * owner-authored name and bio as an encrypted card to this peer.
 */
export function useFriendRecommendations(options: {
  peer: () => string;
  accepted: () => boolean;
  isDisposed: () => boolean;
}) {
  const router = useRouter();
  const keys = useKeyStore();
  const ui = useUIStore();
  const friends = useFriendsStore();
  const friendships = useFriendshipsStore();
  const profiles = useProfilesStore();
  const directMessages = useDirectMessagesStore();

  const recommendationPickerOpen = ref(false);
  const recommendationQuery = ref("");
  const selectedRecommendation = ref<FriendRecommendation | null>(null);
  const recommendationRequestPubkey = ref("");

  // Only profiles delivered by their own author to this account are trusted as owner-authored.
  function ownKnownRecommendationProfile(pubkey: string) {
    return profiles.loadedFor === keys.pkHex && friendships.isAccepted(pubkey)
      ? profiles.getProfile(pubkey)
      : undefined;
  }
  function recommendationName(card: FriendRecommendation) {
    return ownKnownRecommendationProfile(card.pubkey)?.nickname?.trim() || card.nickname || "未设置昵称";
  }
  function recommendationBio(card: FriendRecommendation) {
    return ownKnownRecommendationProfile(card.pubkey)?.bio?.trim() || card.bio || "";
  }
  function recommendationPickerName(pubkey: string) {
    return ownKnownRecommendationProfile(pubkey)?.nickname?.trim() || shortNpub(pubkey, 13, 8) || "未设置昵称";
  }
  function recommendationPickerBio(pubkey: string) {
    return ownKnownRecommendationProfile(pubkey)?.bio?.trim() || "";
  }
  const recommendableFriends = computed(() => {
    const query = recommendationQuery.value.trim().toLocaleLowerCase();
    return friends.getAcceptedList(friendships.isAccepted)
      .filter(friend => friend.pubkey !== options.peer() && friend.pubkey !== keys.pkHex)
      .filter(friend => !query || [recommendationPickerName(friend.pubkey), friend.pubkey].some(value => value.toLocaleLowerCase().includes(query)))
      .map(friend => ({ pubkey: friend.pubkey, name: recommendationPickerName(friend.pubkey), bio: recommendationPickerBio(friend.pubkey) }));
  });
  function recommendationActionLabel(pubkey: string) {
    if (pubkey === keys.pkHex) return "这是你自己";
    const status = friendships.getState(pubkey);
    if (status === "accepted") return "查看资料";
    if (status === "outgoing_pending") return "申请已保存";
    if (status === "incoming_pending") return "接受好友申请";
    return "添加好友";
  }
  function recommendationActionDisabled(pubkey: string) {
    return !keys.pkHex || pubkey === keys.pkHex || recommendationRequestPubkey.value !== ""
      || friendships.getState(pubkey) === "outgoing_pending"
      || (friendships.getState(pubkey) !== "accepted" && !keys.supportsNip44);
  }
  async function actOnRecommendation(pubkey: string) {
    if (recommendationActionDisabled(pubkey)) return;
    if (friendships.isAccepted(pubkey)) return void openProfile(router, keys.pkHex, pubkey);
    const account = keys.pkHex;
    recommendationRequestPubkey.value = pubkey;
    try {
      if (friendships.getState(pubkey) === "incoming_pending") await friendships.acceptRequest(pubkey);
      else await friendships.sendRequest(pubkey);
      if (!options.isDisposed() && keys.pkHex === account) ui.addToast(friendships.isAccepted(pubkey) ? "已添加好友" : "好友申请已保存，正在发送", 2000, "success");
    } catch (error) {
      if (!options.isDisposed() && keys.pkHex === account) ui.addToast(error instanceof Error ? error.message : "操作失败，请稍后重试", 2200, "error");
    } finally {
      recommendationRequestPubkey.value = "";
    }
  }

  /** Opens an empty picker; the chat checks it may send a card first. */
  function showRecommendationPicker() {
    recommendationQuery.value = "";
    selectedRecommendation.value = null;
    recommendationPickerOpen.value = true;
  }
  function closeRecommendationPicker() {
    recommendationPickerOpen.value = false;
    recommendationQuery.value = "";
    selectedRecommendation.value = null;
  }
  function selectRecommendation(pubkey: string) {
    if (!options.accepted() || !friendships.isAccepted(pubkey)
      || pubkey === options.peer() || pubkey === keys.pkHex) return;
    const profile = ownKnownRecommendationProfile(pubkey);
    selectedRecommendation.value = {
      pubkey,
      ...(profile?.nickname?.trim() ? { nickname: profile.nickname.trim() } : {}),
      ...(profile?.bio?.trim() ? { bio: profile.bio.trim() } : {}),
    };
  }
  function sendRecommendation() {
    const card = selectedRecommendation.value;
    if (!card || !recommendationPickerOpen.value || !options.accepted() || !friendships.isAccepted(card.pubkey)
      || card.pubkey === options.peer() || card.pubkey === keys.pkHex) return;
    try {
      directMessages.send(options.peer(), serializeFriendRecommendation(card.pubkey, card), undefined, undefined, undefined, { preserveDraft: true });
      closeRecommendationPicker();
      ui.addToast("好友名片已加入发送队列", 1800, "success");
    } catch (error) {
      ui.addToast(error instanceof Error ? error.message : "推荐朋友失败", 2200, "error");
    }
  }

  return {
    recommendationPickerOpen,
    recommendationQuery,
    selectedRecommendation,
    recommendableFriends,
    recommendationName,
    recommendationBio,
    recommendationActionLabel,
    recommendationActionDisabled,
    actOnRecommendation,
    showRecommendationPicker,
    closeRecommendationPicker,
    selectRecommendation,
    sendRecommendation,
  };
}
