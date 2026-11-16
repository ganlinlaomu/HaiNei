import { defineStore } from "pinia";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";
import { sendDirectMessage } from "@/nostr/messaging/service";
import {
  decodeFeedPin, decodeTombstone, encodeFeedPin, encodeTombstone, isFeedPinMessage,
  HAI_NEI_FEED_PIN_TAGS, HAI_NEI_TOMBSTONE_TAGS, type FeedPin,
} from "@/nostr/messaging/feedControl";
import { getRelaysFromStorage } from "@/nostr/relays";
import { metaRepository } from "@/repositories/metaRepository";
import { useKeyStore } from "@/stores/keys";
import { scheduleAccountStateSync } from "@/services/accountStateSync";

const META_KEY = "feed_preferences";
const SYNC_META_KEY = "feed_preferences_v2";
const PIN_META_KEY = "feed_pins_v1";

export const useFeedPreferencesStore = defineStore("feedPreferences", {
  state: () => ({
    hiddenMessageIds: new Set<string>(), mutedPubkeys: new Set<string>(), loadedFor: "",
    hiddenPreferences: [] as Array<{ id: string; updatedAt: number; deleted: boolean }>,
    mutedPreferences: [] as Array<{ pubkey: string; updatedAt: number; deleted: boolean }>,
    revision: 0,
    /** Each author's latest profile pin; messageId null means unpinned. */
    pinsByAuthor: {} as Record<string, FeedPin>,
  }),
  getters: {
    isHidden: state => (messageId: string) => state.hiddenMessageIds.has(messageId),
    isMuted: state => (pubkey: string) => state.mutedPubkeys.has(pubkey.toLowerCase()),
    pinnedPostOf: state => (author: string) => state.pinsByAuthor[author.toLowerCase()]?.messageId || null,
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
      const [record, synced, pins] = await Promise.all([
        metaRepository.get(account, META_KEY),
        metaRepository.get(account, SYNC_META_KEY),
        metaRepository.get(account, PIN_META_KEY),
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
      this.pinsByAuthor = normalizePins(pins?.value);
      this.revision += 1;
    },
    reset() {
      this.hiddenMessageIds = new Set();
      this.mutedPubkeys = new Set();
      this.hiddenPreferences = [];
      this.mutedPreferences = [];
      this.pinsByAuthor = {};
      this.loadedFor = "";
      this.revision += 1;
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
      this.revision += 1;
      await this.persist();
    },
    async mute(pubkey: string) {
      const peer = pubkey.toLowerCase();
      this.mutedPreferences = [...this.mutedPreferences.filter(item => item.pubkey !== peer), { pubkey: peer, updatedAt: Date.now(), deleted: false }];
      this.mutedPubkeys.add(peer);
      this.mutedPubkeys = new Set(this.mutedPubkeys);
      this.revision += 1;
      await this.persist();
    },
    async unmute(pubkey: string) {
      const peer = pubkey.toLowerCase();
      this.mutedPreferences = [...this.mutedPreferences.filter(item => item.pubkey !== peer), { pubkey: peer, updatedAt: Date.now(), deleted: true }];
      this.mutedPubkeys.delete(peer);
      this.mutedPubkeys = new Set(this.mutedPubkeys);
      this.revision += 1;
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
    /** Apply a pin if it is newer than the one already known for that author. */
    async applyPin(author: string, pin: FeedPin) {
      const account = this.loadedFor;
      const key = author.toLowerCase();
      if (!account) return false;
      const current = this.pinsByAuthor[key];
      if (current && current.pinnedAt >= pin.pinnedAt) return false;
      this.pinsByAuthor = { ...this.pinsByAuthor, [key]: { messageId: pin.messageId, pinnedAt: pin.pinnedAt } };
      this.revision += 1;
      await metaRepository.put(account, PIN_META_KEY, Object.fromEntries(Object.entries(this.pinsByAuthor)
        .map(([pinAuthor, value]) => [pinAuthor, { messageId: value.messageId, pinnedAt: value.pinnedAt }])));
      return true;
    },
    /**
     * Pin (or with null, unpin) one of the account's own posts on its profile,
     * then tell every accepted friend. Friends without that post ignore it.
     */
    async pinOwn(message: { id: string; pubkey: string } | null, friendPubkeys: string[]) {
      const keys = useKeyStore();
      const account = keys.pkHex.toLowerCase();
      if (!account || (message && message.pubkey.toLowerCase() !== account)) throw new Error("只能置顶自己的动态");
      if (this.loadedFor !== account) await this.load(account);
      const previous = this.pinsByAuthor[account]?.pinnedAt || 0;
      const pin: FeedPin = { messageId: message?.id || null, pinnedAt: Math.max(Date.now(), previous + 1) };
      await this.applyPin(account, pin);
      const recipients = [...new Set([...friendPubkeys.map(pubkey => pubkey.toLowerCase()), account])];
      return sendDirectMessage({
        recipientPubkeys: recipients,
        content: encodeFeedPin(pin),
        tags: HAI_NEI_FEED_PIN_TAGS,
        relays: getRelaysFromStorage("write"),
        context: {
          senderPubkey: account,
          nip44Encrypt: keys.supportsNip44 ? keys.nip44Encrypt.bind(keys) : undefined,
          signEvent: keys.signEvent.bind(keys)
        }
      });
    },
    async processPin(message: CanonicalMessage, isAccepted: (pubkey: string) => boolean) {
      const account = this.loadedFor;
      const pin = decodeFeedPin(message);
      const sender = message.senderPubkey.toLowerCase();
      if (!account || !pin || (sender !== account && !isAccepted(sender))) return false;
      return this.applyPin(sender, pin);
    },
    /** Route a feed control message (删除 or 置顶) to its handler. */
    async processFeedControl(
      message: CanonicalMessage,
      isAccepted: (pubkey: string) => boolean,
      authorOf: (messageId: string) => string | undefined
    ) {
      if (isFeedPinMessage(message)) return this.processPin(message, isAccepted);
      return this.processTombstone(message, isAccepted, authorOf);
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

function normalizePins(value: unknown): Record<string, FeedPin> {
  const pins: Record<string, FeedPin> = {};
  if (!value || typeof value !== "object") return pins;
  for (const [author, raw] of Object.entries(value as Record<string, unknown>)) {
    const pin = raw as Partial<FeedPin> | null;
    if (!/^[0-9a-f]{64}$/.test(author) || !pin || !Number.isSafeInteger(pin.pinnedAt)) continue;
    if (pin.messageId !== null && typeof pin.messageId !== "string") continue;
    pins[author] = { messageId: pin.messageId ?? null, pinnedAt: pin.pinnedAt as number };
  }
  return pins;
}
