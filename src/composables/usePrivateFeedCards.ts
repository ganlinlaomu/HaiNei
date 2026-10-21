import { onBeforeUnmount, ref, watch } from "vue";
import type { InboxItem } from "@/nostr/messaging/messageViewModel";
import { useKeyStore } from "@/stores/keys";
import { privateFeedItems } from "@/services/privateFeed";

/**
 * The signed-in owner's notes and open to-dos for Home. Reloads when 私人空间
 * changes on this device or arrives from sync. Private-space modules are
 * loaded lazily so they stay out of the startup bundle.
 */
export function usePrivateFeedCards(onChange: () => void) {
  const keys = useKeyStore();
  const cards = ref<InboxItem[]>([]);
  const revision = ref(0);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopSubscription: (() => void) | null = null;
  let disposed = false;

  async function reload() {
    const run = ++generation;
    const pubkey = keys.pkHex;
    let next: InboxItem[] = [];
    if (pubkey && keys.isUnlocked) {
      try {
        const { privateSpaceRepository } = await import("@/repositories/privateSpaceRepository");
        next = privateFeedItems(await privateSpaceRepository.list(pubkey), pubkey);
      } catch {
        // Locked or unavailable: keep what is shown rather than flashing empty.
        if (run !== generation) return;
        next = keys.pkHex === pubkey ? cards.value : [];
      }
    }
    if (run !== generation || keys.pkHex !== pubkey) return;
    cards.value = next;
    revision.value++;
    onChange();
  }

  function scheduleReload() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void reload(); }, 250);
  }

  void import("@/services/privateSpaceSync").then(({ subscribePrivateSpaceSync }) => {
    if (disposed) return;
    stopSubscription = subscribePrivateSpaceSync(state => {
      if (state.account === keys.pkHex.toLowerCase() && (state.status === "local" || state.status === "synced")) scheduleReload();
    });
  }).catch(() => undefined);

  watch(() => [keys.pkHex, keys.isUnlocked, keys.accountStoresReadyFor] as const, () => { void reload(); }, { immediate: true });

  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    if (timer) clearTimeout(timer);
    stopSubscription?.();
  });

  return { cards, revision, reload };
}
