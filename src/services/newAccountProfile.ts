import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";
import { uploadPrivateProfileAvatar } from "@/utils/profileAvatar";

/**
 * Save the name (and optional avatar) chosen during sign-up once the new
 * account exists. Runs after navigation; the avatar upload needs the network.
 */
export async function saveNewAccountProfile(account: string, nickname: string, avatar: File | null) {
  const keys = useKeyStore();
  const profiles = useProfilesStore();
  if (keys.pkHex !== account) return;
  const local = await profiles.saveOwnProfile({ nickname });
  if (!avatar || keys.pkHex !== account) return;
  try {
    const ref = await uploadPrivateProfileAvatar(avatar, {
      accountPubkey: account,
      signEvent: keys.signEvent.bind(keys),
    });
    if (keys.pkHex !== account) return;
    await profiles.saveOwnProfile({ nickname, avatar: ref }, Math.max(Date.now(), local.updatedAt + 1));
  } catch {
    if (keys.pkHex === account) useUIStore().addToast("头像暂未上传，可稍后在「我的资料」里重新设置", 3_000, "error");
  }
}
