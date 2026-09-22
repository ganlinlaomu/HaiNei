import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { decodeTombstone, encodeTombstone, HAI_NEI_TOMBSTONE_TAGS } from "@/nostr/messaging/feedControl";
import { getRelaysFromStorage } from "@/nostr/relays";
import { metaRepository } from "@/repositories/metaRepository";
import { useKeyStore } from "@/stores/keys";

const META_KEY = "feed_preferences";

export const useFeedPreferencesStore = defineStore("feedPreferences", {
  state: () => ({ hiddenMessageIds: new Set<string>(), mutedPubkeys: new Set<string>(), loadedFor: "" }),
  getters: {
    isHidden: state => (messageId: string) => state.hiddenMessageIds.has(messageId),
    isMuted: state => (pubkey: string) => state.mutedPubkeys.has(pubkey.toLowerCase()),
    isVisible(): (message: { id: string; pubkey: string }) => boolean {
      return message => !this.isHidden(message.id) && !this.isMuted(message.pubkey);
    }
  },
  actions: {
    async load(accountPubkey?: string) {
      const account = (accountPubkey || useKeyStore().pkHex).toLowerCase();
      if (!account) return this.reset();
      if (this.loadedFor === account) return;
      this.reset();
      this.loadedFor = account;
      const record = await metaRepository.get(account, META_KEY);
      if (this.loadedFor !== account) return;
      const value = record?.value as { hiddenMessageIds?: string[]; mutedPubkeys?: string[] } | undefined;
      this.hiddenMessageIds = new Set(value?.hiddenMessageIds || []);
      this.mutedPubkeys = new Set((value?.mutedPubkeys || []).map(item => item.toLowerCase()));
    },
    reset() {
      this.hiddenMessageIds = new Set();
      this.mutedPubkeys = new Set();
      this.loadedFor = "";
    },
    async persist() {
      if (!this.loadedFor) return;
      await metaRepository.put(this.loadedFor, META_KEY, {
        hiddenMessageIds: [...this.hiddenMessageIds], mutedPubkeys: [...this.mutedPubkeys]
      });
    },
    async hide(messageId: string) {
      this.hiddenMessageIds.add(messageId);
      this.hiddenMessageIds = new Set(this.hiddenMessageIds);
      await this.persist();
    },
    async mute(pubkey: string) {
      this.mutedPubkeys.add(pubkey.toLowerCase());
      this.mutedPubkeys = new Set(this.mutedPubkeys);
      await this.persist();
    },
    async unmute(pubkey: string) {
      this.mutedPubkeys.delete(pubkey.toLowerCase());
      this.mutedPubkeys = new Set(this.mutedPubkeys);
      await this.persist();
    },
    async tombstoneOwn(message: { id: string; pubkey: string; recipientPubkeys?: string[] }) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      if (!account || message.pubkey.toLowerCase() !== account) throw new Error("只能删除自己的动态");
      await this.hide(message.id);
      const recipients = [...new Set([...(message.recipientPubkeys || []), account])];
      return sendDirectMessage({
        recipientPubkeys: recipients,
        content: encodeTombstone(message.id),
        tags: HAI_NEI_TOMBSTONE_TAGS,
        relays: getRelaysFromStorage("write"),
        context: {
          senderPubkey: account,
          nip44Encrypt: keys.supportsNip44 ? keys.nip44Encrypt.bind(keys) : undefined,
          signEvent: keys.signEvent.bind(keys)
        }
      });
    },
    async processTombstone(
      message: CanonicalMessage,
      isAccepted: (pubkey: string) => boolean,
      authorOf: (messageId: string) => string | undefined
    ) {
      const account = this.loadedFor;
      const tombstone = decodeTombstone(message);
      const sender = message.senderPubkey.toLowerCase();
      if (!account || !tombstone || (sender !== account && !isAccepted(sender))) return false;
      if (authorOf(tombstone.messageId)?.toLowerCase() !== sender) return false;
      await this.hide(tombstone.messageId);
      return true;
    }
  }
});
