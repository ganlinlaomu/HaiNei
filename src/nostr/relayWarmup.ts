import { getRelaysFromStorage, warmRelays } from "@/nostr/relays";

export type RelayWarmupSession = {
  isLoggedIn: boolean;
  isUnlocked: boolean;
};

/** Preconnect read relays only after account credentials are usable. */
export function warmReadRelaysForSession(session: RelayWarmupSession) {
  if (!session.isLoggedIn || !session.isUnlocked) return false;
  warmRelays(getRelaysFromStorage("read"));
  return true;
}
