import { getRelaysFromStorage } from "@/nostr/relays";
import { DEFAULT_RELAY_URLS, normalizeRelayUrl } from "@/services/connectionSettings";

/**
 * Private-message routing. HaiNei does not interoperate with other Nostr
 * clients, so it does not look up a recipient's kind 10050 inbox: every
 * gift wrap goes to the default relays, which every HaiNei account always
 * reads, plus the sender's own write relays. A relay a user adds carries
 * messages once the other side reads it too.
 *
 * The defaults are included even if the user turned them off in settings:
 * they are the one route both sides are guaranteed to share.
 */
function uniqueRelays(values: readonly string[]) {
  return [...new Set(values.map(normalizeRelayUrl).filter(Boolean))];
}

/** Where every gift wrap (messages, reactions, receipts, controls) is published. */
export function dmSendRelays() {
  return uniqueRelays([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage("write")]);
}

/** Where this account's gift wraps are subscribed and caught up from. */
export function dmReceiveRelays() {
  return uniqueRelays([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage("read")]);
}
