import { defineStore } from 'pinia';
import { ref } from 'vue';
import { NostrService } from '../utils/nostr';
import { messageRepository } from '@/repositories/messageRepository';
import { useKeyStore } from '@/stores/keys';

type Message = {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
};

const nostr = new NostrService();

export default defineStore('nostr', () => {
  const messages = ref<Message[]>([]);
  const loadedFor = ref("");

  // Account identity is mandatory at the repository boundary.
  const loadCached = async (accountPubkey: string) => {
    const accountAtStart = accountPubkey;
    loadedFor.value = accountAtStart;
    const records = await messageRepository.listLatest(accountAtStart);
    if (loadedFor.value !== accountAtStart) return;
    messages.value = records.map(record => ({
      id: record.id,
      pubkey: record.pubkey,
      content: record.content || "",
      created_at: record.created_at
    }));
  };

  const connect = () => nostr.connect();

  const subscribeByAuthors = (accountPubkey: string, authors: string[]) => {
    const accountAtStart = accountPubkey;
    loadedFor.value = accountAtStart;
    // subscribe with authors filter
    nostr.subscribe({
      authors,
      onEvent: async (evt: any) => {
        const keys = useKeyStore();
        if (keys.pkHex !== accountAtStart || loadedFor.value !== accountAtStart) return;
        const msg: Message = {
          id: evt.id,
          pubkey: evt.pubkey,
          content: evt.content,
          created_at: evt.created_at
        };
        await messageRepository.put(accountAtStart, msg);
        if (keys.pkHex !== accountAtStart || loadedFor.value !== accountAtStart) return;
        if (!messages.value.some(existing => existing.id === msg.id)) {
          messages.value.unshift(msg);
        }
      }
    });
  };

  const reset = () => {
    loadedFor.value = "";
    messages.value = [];
  };

  return {
    messages,
    loadedFor,
    loadCached,
    reset,
    connect,
    subscribeByAuthors
  };
});
