import { getRelaysFromStorage, warmRelays } from "@/nostr/relays";
import { dmReceiveRelays } from "@/services/dmRelays";

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

/**
 * Warm the relays private messages are received on while the encrypted read
 * cursor and friendship state are still being restored. This creates only
 * temporary pooled sockets: subscriptions and decryption stay in account sync.
 */
export async function warmDmRelaysForSession(
  accountPubkey: string,
  session: RelayWarmupSession,
  isCurrent: () => boolean,
) {
  if (!accountPubkey || !session.isLoggedIn || !session.isUnlocked || !isCurrent()) return false;
  const relays = dmReceiveRelays();
  if (!relays.length) return false;
  warmRelays(relays);
  return true;
}
