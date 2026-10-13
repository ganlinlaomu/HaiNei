import { getRelaysFromStorage, warmRelays } from "@/nostr/relays";
import { getOwnDmRelayStatus } from "@/services/dmRelayDirectory";

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
 * Warm the account's already advertised NIP-17 inbox relays while the encrypted
 * read cursor and friendship state are still being restored. This creates only
 * temporary pooled sockets: subscriptions and decryption stay in account sync.
 */
export async function warmDmRelaysForSession(
  accountPubkey: string,
  session: RelayWarmupSession,
  isCurrent: () => boolean,
) {
  if (!accountPubkey || !session.isLoggedIn || !session.isUnlocked || !isCurrent()) return false;
  const { relays } = await getOwnDmRelayStatus(accountPubkey);
  // The IndexedDB lookup can complete after the user locks or switches accounts.
  if (!session.isLoggedIn || !session.isUnlocked || !isCurrent()) return false;
  if (!relays.length) return false;
  warmRelays(relays);
  return true;
}
