import type { AccountStateNamespace } from "@/db/dexie";
import { fetchAndMaterializeAccountState, type AccountStateKeys } from "@/services/accountStateSync";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";

export const FRIEND_STATE_NAMESPACES: AccountStateNamespace[] = ["friendships", "friend_metadata"];
export const FOREGROUND_FRIEND_SYNC_THROTTLE_MS = 30_000;

const lastCheckedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<AccountStateNamespace[]>>();

export async function reconcileForegroundFriendState(
  keys: AccountStateKeys,
  options: { force?: boolean; now?: number } = {},
): Promise<AccountStateNamespace[]> {
  const account = keys.pkHex.toLowerCase();
  if (!account || !keys.supportsNip44 || typeof indexedDB === "undefined") return [];
  if (typeof navigator !== "undefined" && navigator.onLine === false) return [];

  const existing = inFlight.get(account);
  if (existing) return existing;

  const now = options.now ?? Date.now();
  const lastCheck = lastCheckedAt.get(account) || 0;
  if (!options.force && now - lastCheck < FOREGROUND_FRIEND_SYNC_THROTTLE_MS) return [];
  lastCheckedAt.set(account, now);

  const run = (async () => {
    const result = await fetchAndMaterializeAccountState(keys, FRIEND_STATE_NAMESPACES, { onlyNewer: true });
    if (keys.pkHex.toLowerCase() !== account) return [];

    const restored = result.restored;
    const friendships = useFriendshipsStore();
    if (restored.includes("friendships")
      || friendships.loadedFor !== account
      || !friendships.authorizationReady) {
      if (friendships.loadedFor === account) await friendships.reloadFromStorage(account);
      else await friendships.load(account);
    }
    if (restored.includes("friend_metadata")) {
      await useFriendsStore().reloadFromStorage(account);
    }
    return restored;
  })().finally(() => {
    if (inFlight.get(account) === run) inFlight.delete(account);
  });

  inFlight.set(account, run);
  return run;
}

export function resetForegroundFriendStateSyncForTests() {
  lastCheckedAt.clear();
  inFlight.clear();
}
