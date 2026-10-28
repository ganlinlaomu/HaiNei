import { onScopeDispose, ref, watch } from "vue";
import type { InboxItem } from "@/nostr/messaging/messageViewModel";
import { useKeyStore } from "@/stores/keys";
import { openTodoTasks, privateFeedItems, type OpenTodoTask } from "@/services/privateFeed";
import { startupMark } from "@/utils/debugLog";

/**
 * The signed-in owner's notes (feed cards) and open to-do tasks (to-do bar)
 * for Home, from one read. Reloads when 私人空间
 * changes on this device or arrives from sync. Private-space modules are
 * loaded lazily so they stay out of the startup bundle.
 *
 * Home also pulls shared to-do lists: once when the account is ready (a cold
 * start has no resume event), then every minute while Home is visible and a
 * shared list exists, so a friend's ticks reach the to-do bar.
 */
export function usePrivateFeedCards(onChange: () => void) {
  const keys = useKeyStore();
  const cards = ref<InboxItem[]>([]);
  const todos = ref<OpenTodoTask[]>([]);
  const revision = ref(0);
  let todoMarked = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopSubscription: (() => void) | null = null;
  let disposed = false;
  let hasShared = false;
  let startupSyncedFor = "";

  async function reload() {
    const run = ++generation;
    const pubkey = keys.pkHex;
    const started = Date.now();
    let next: InboxItem[] = [];
    let nextTodos: OpenTodoTask[] = [];
    if (pubkey && keys.isUnlocked) {
      try {
        const { privateSpaceRepository } = await import("@/repositories/privateSpaceRepository");
        const records = await privateSpaceRepository.list(pubkey);
        next = privateFeedItems(records, pubkey);
        nextTodos = openTodoTasks(records);
        hasShared = records.some(record => record.share && !record.deletedAt);
      } catch {
        // Locked or unavailable: keep what is shown rather than flashing empty.
        if (run !== generation) return;
        next = keys.pkHex === pubkey ? cards.value : [];
        nextTodos = keys.pkHex === pubkey ? todos.value : [];
      }
    }
    if (run !== generation || keys.pkHex !== pubkey) return;
    cards.value = next;
    todos.value = nextTodos;
    if (pubkey && keys.isUnlocked && !todoMarked) {
      todoMarked = true;
      startupMark("todo_bar_ready", { durationMs: Date.now() - started, tasks: nextTodos.length });
    }
    revision.value++;
    onChange();
    syncOnceWhenReady();
  }

  /** Friendships must be loaded first: only lists from accepted friends appear. */
  function syncOnceWhenReady() {
    const pubkey = keys.pkHex;
    const session = pubkey + ":" + keys.sessionGeneration;
    if (!pubkey || !keys.isUnlocked || keys.accountStoresReadyFor !== pubkey || startupSyncedFor === session) return;
    startupSyncedFor = session;
    void import("@/services/privateSpaceSync").then(({ schedulePrivateSpaceSync }) => {
      if (!disposed && keys.pkHex === pubkey && keys.isUnlocked) schedulePrivateSpaceSync(keys, 2_000);
    }).catch(() => undefined);
  }

  const SHARED_POLL_MS = 60_000;
  const pollTimer = setInterval(() => {
    if (!hasShared || !keys.isUnlocked || !keys.supportsNip44 || typeof document === "undefined"
        || document.visibilityState !== "visible") return;
    void import("@/services/privateSpaceSync").then(({ syncPrivateSpace }) => {
      if (!disposed && keys.isUnlocked) void syncPrivateSpace(keys);
    }).catch(() => undefined);
  }, SHARED_POLL_MS);

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

  onScopeDispose(() => {
    disposed = true;
    generation++;
    if (timer) clearTimeout(timer);
    clearInterval(pollTimer);
    stopSubscription?.();
  });

  return { cards, todos, revision, reload };
}
