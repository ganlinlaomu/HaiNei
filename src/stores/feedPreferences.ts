import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { decodeTombstone, encodeTombstone, HAI_NEI_TOMBSTONE_TAGS } from "@/nostr/messaging/feedControl";
import { getRelaysFromStorage } from "@/nostr/relays";
import { metaRepository } from "@/repositories/metaRepository";
import { useKeyStore } from "@/stores/keys";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

const META_KEY = "feed_preferences";
const SYNC_META_KEY = "feed_preferences_v2";

export const useFeedPreferencesStore = defineStore("feedPreferences", {
  state: () => ({
    hiddenMessageIds: new Set<string>(), mutedPubkeys: new Set<string>(), loadedFor: "",
    hiddenPreferences: [] as Array<{ id: string; updatedAt: number; deleted: boolean }>,
    mutedPreferences: [] as Array<{ pubkey: string; updatedAt: number; deleted: boolean }>,
  }),
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
      const [record, synced] = await Promise.all([
        metaRepository.get(account, META_KEY),
        metaRepository.get(account, SYNC_META_KEY),
      ]);
      if (this.loadedFor !== account) return;
      const value = record?.value as { hiddenMessageIds?: string[]; mutedPubkeys?: string[] } | undefined;
      const syncedValue = synced?.value as { hidden?: Array<{ id: string; deleted?: boolean }>; muted?: Array<{ pubkey: string; deleted?: boolean }> } | undefined;
      this.hiddenPreferences = (syncedValue?.hidden || (value?.hiddenMessageIds || []).map(id => ({ id, updatedAt: 0, deleted: false })))
        .map(item => ({ id: item.id, updatedAt: Number((item as any).updatedAt || 0), deleted: !!item.deleted }));
      this.mutedPreferences = (syncedValue?.muted || (value?.mutedPubkeys || []).map(pubkey => ({ pubkey, updatedAt: 0, deleted: false })))
        .map(item => ({ pubkey: item.pubkey.toLowerCase(), updatedAt: Number((item as any).updatedAt || 0), deleted: !!item.deleted }));
      this.hiddenMessageIds = new Set(this.hiddenPreferences.filter(item => !item.deleted).map(item => item.id));
      this.mutedPubkeys = new Set(this.mutedPreferences.filter(item => !item.deleted).map(item => item.pubkey));
    },
    reset() {
      this.hiddenMessageIds = new Set();
      this.mutedPubkeys = new Set();
      this.hiddenPreferences = [];
      this.mutedPreferences = [];
      this.loadedFor = "";
    },
    async persist() {
      if (!this.loadedFor) return;
      await metaRepository.put(this.loadedFor, META_KEY, {
        hiddenMessageIds: [...this.hiddenMessageIds], mutedPubkeys: [...this.mutedPubkeys]
      });
      await metaRepository.put(this.loadedFor, SYNC_META_KEY, {
        hidden: this.hiddenPreferences.map(item => ({ ...item })),
        muted: this.mutedPreferences.map(item => ({ ...item })),
      });
      scheduleAccountStateSync(useKeyStore(), "feed_preferences");
    },
    async hide(messageId: string) {
      const now = Date.now();
      this.hiddenPreferences = [...this.hiddenPreferences.filter(item => item.id !== messageId), { id: messageId, updatedAt: now, deleted: false }];
      this.hiddenMessageIds.add(messageId);
      this.hiddenMessageIds = new Set(this.hiddenMessageIds);
      await this.persist();
    },
    async mute(pubkey: string) {
      const peer = pubkey.toLowerCase();
      this.mutedPreferences = [...this.mutedPreferences.filter(item => item.pubkey !== peer), { pubkey: peer, updatedAt: Date.now(), deleted: false }];
      this.mutedPubkeys.add(peer);
      this.mutedPubkeys = new Set(this.mutedPubkeys);
      await this.persist();
    },
    async unmute(pubkey: string) {
      const peer = pubkey.toLowerCase();
      this.mutedPreferences = [...this.mutedPreferences.filter(item => item.pubkey !== peer), { pubkey: peer, updatedAt: Date.now(), deleted: true }];
      this.mutedPubkeys.delete(peer);
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
