import { defineStore } from "pinia";
import type { HaiNeiProfile } from "@/db/dexie";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { decodeHaiNeiProfileMessage, encodeHaiNeiProfilePayload, HAI_NEI_PROFILE_TAGS } from "@/nostr/messaging/privateProfile";
import { getRelaysFromStorage } from "@/nostr/relays";
import { profileRepository } from "@/repositories/profileRepository";
import { useKeyStore } from "@/stores/keys";
import type { FriendshipRecord } from "@/db/dexie";

function normalized(value: string) { return value.trim().toLowerCase(); }

export const useProfilesStore = defineStore("profiles", {
  state: () => ({ records: [] as HaiNeiProfile[], loadedFor: "", loading: false }),
  getters: {
    getProfile: state => (ownerPubkey: string) =>
      state.records.find(profile => profile.ownerPubkey === normalized(ownerPubkey))
  },
  actions: {
    async load(accountPubkey?: string) {
      const account = normalized(accountPubkey || useKeyStore().pkHex);
      if (!account) return this.reset();
      if (this.loadedFor === account) return;
      this.records = [];
      this.loadedFor = account;
      this.loading = true;
      try {
        const records = await profileRepository.list(account);
        if (this.loadedFor === account) this.records = records.map(({ accountPubkey: _account, ...profile }) => profile);
      } finally {
        if (this.loadedFor === account) this.loading = false;
      }
    },

    reset() {
      this.records = [];
      this.loadedFor = "";
      this.loading = false;
    },

    async putLatest(profile: HaiNeiProfile) {
      const account = this.loadedFor;
      if (!account) return false;
      const clean: HaiNeiProfile = { ...profile, ownerPubkey: normalized(profile.ownerPubkey) };
      const stored = await profileRepository.putLatest(account, clean);
      if (!stored || this.loadedFor !== account) return false;
      const index = this.records.findIndex(item => item.ownerPubkey === clean.ownerPubkey);
      if (index >= 0) this.records[index] = clean;
      else this.records.push(clean);
      return true;
    },

    async saveOwnProfile(input: Pick<HaiNeiProfile, "nickname" | "bio" | "avatar">, updatedAt = Date.now()) {
      const keys = useKeyStore();
      const account = normalized(keys.pkHex);
      if (!account) throw new Error("请先登录");
      if (this.loadedFor !== account) await this.load(account);
      const profile: HaiNeiProfile = {
        ownerPubkey: account,
        nickname: input.nickname?.trim() || undefined,
        bio: input.bio?.trim() || undefined,
        avatar: input.avatar || undefined,
        updatedAt
      };
      await this.putLatest(profile);
      return profile;
    },

    async sendProfile(profile: HaiNeiProfile, recipientPubkeys: string[]) {
      const keys = useKeyStore();
      const account = normalized(keys.pkHex);
      if (!account || profile.ownerPubkey !== account || !keys.supportsNip44) throw new Error("无法发送私密资料");
      const recipients = [...new Set(recipientPubkeys.map(normalized).filter(Boolean))];
      if (!recipients.includes(account)) recipients.push(account);
      return sendDirectMessage({
        recipientPubkeys: recipients,
        content: encodeHaiNeiProfilePayload(profile),
        tags: HAI_NEI_PROFILE_TAGS,
        relays: getRelaysFromStorage("write"),
        context: {
          senderPubkey: account,
          nip44Encrypt: keys.nip44Encrypt.bind(keys),
          signEvent: keys.signEvent.bind(keys)
        }
      });
    },

    async sendCurrentProfileTo(peerPubkey: string) {
      const account = normalized(useKeyStore().pkHex);
      if (!account) return;
      if (this.loadedFor !== account) await this.load(account);
      const own = this.getProfile(account);
      if (own) await this.sendProfile(own, [peerPubkey]);
    },

    async processProfileMessage(message: CanonicalMessage, isAccepted: (pubkey: string) => boolean) {
      const account = this.loadedFor;
      if (!account) return false;
      const profile = validatedProfileForAccount(message, account, isAccepted);
      if (!profile) return false;
      await this.putLatest(profile);
      return true;
    }
  }
});

export function privateProfileDisplayName(profileNickname: string | undefined, pubkey: string, localName?: string) {
  const local = (localName || "").trim();
  if (local && local !== `${pubkey.slice(0, 8)}…` && local !== `${pubkey.slice(0, 8)}...`) return local;
  return profileNickname?.trim() || `${pubkey.slice(0, 8)}…`;
}

export function acceptedProfileRecipients(records: FriendshipRecord[]) {
  return records.filter(record => record.state === "accepted").map(record => record.peerPubkey);
}

export function validatedProfileForAccount(
  message: CanonicalMessage,
  accountPubkey: string,
  isAccepted: (pubkey: string) => boolean
) {
  const profile = decodeHaiNeiProfileMessage(message);
  const account = normalized(accountPubkey);
  if (!profile || profile.ownerPubkey !== message.senderPubkey.toLowerCase()) return null;
  if (profile.ownerPubkey !== account && !isAccepted(profile.ownerPubkey)) return null;
  return profile;
}

export function profileAvatarInitial(profileNickname: string | undefined, pubkey: string, localName?: string) {
  return (privateProfileDisplayName(profileNickname, pubkey, localName).trim()[0] || "?").toUpperCase();
}
