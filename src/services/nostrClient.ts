import type { NostrEvent } from "nostr-tools";
import { getRelaysFromStorage, publish, subscribe } from "@/nostr/relays";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import {
  dedupeRequest,
  eventCache,
  performanceCounters,
  profileCache,
  relayMetadataCache
} from "@/services/nostrCache";

type QueryOptions = { relays?: string[]; timeoutMs?: number };

function relaySet(input?: string[]) {
  return [...new Set((input || getRelaysFromStorage("read"))
    .map(normalizeRelayUrl).filter(Boolean))].slice(0, 5);
}

/** Unified read/publish facade. Stores can migrate to this incrementally. */
export class NostrClientService {
  subscribe(relays: string[], filters: any[]) {
    return subscribe(relaySet(relays), filters);
  }

  publish(event: NostrEvent, relays?: string[]) {
    return publish(relaySet(relays || getRelaysFromStorage("write")), event);
  }

  /** Account-scoped NIP-17 transport subscription; decode/ingest stays in the
   * existing MessageIngestionPipeline so protocol behavior is unchanged. */
  subscribeDirectMessages(accountPubkey: string, relays?: string[], since = Math.floor(Date.now() / 1000)) {
    return subscribe(relaySet(relays), [{ kinds: [1059], "#p": [accountPubkey.toLowerCase()], since }]);
  }

  fetchEvent(id: string, options: QueryOptions = {}) {
    const cached = eventCache.get(id);
    if (cached) {
      performanceCounters.eventCacheHit++;
      return Promise.resolve(cached);
    }
    performanceCounters.eventCacheMiss++;
    return dedupeRequest(`event:${id}`, () => this.queryOne([{ ids: [id], limit: 1 }], options)
      .then(event => {
        if (event) eventCache.set(event.id, event);
        return event;
      }));
  }

  fetchProfile(pubkey: string, options: QueryOptions = {}) {
    const key = pubkey.toLowerCase();
    const cached = profileCache.get(key);
    if (cached) return Promise.resolve(cached);
    return dedupeRequest(`profile:${key}`, () => this.queryOne([{ kinds: [0], authors: [key], limit: 1 }], options)
      .then(event => {
        if (event) profileCache.set(key, event);
        return event;
      }));
  }

  fetchRelayList(pubkey: string, options: QueryOptions = {}) {
    const key = pubkey.toLowerCase();
    const cached = relayMetadataCache.get(key);
    if (cached) return Promise.resolve(cached);
    return dedupeRequest(`relay-list:${key}`, () => this.queryOne([{ kinds: [10002], authors: [key], limit: 1 }], options)
      .then(event => {
        if (event) relayMetadataCache.set(key, event);
        return event;
      }));
  }

  private queryOne(filters: any[], options: QueryOptions): Promise<NostrEvent | null> {
    const relays = relaySet(options.relays);
    if (!relays.length) return Promise.resolve(null);
    return new Promise(resolve => {
      const sub = subscribe(relays, filters);
      let best: NostrEvent | null = null;
      let settled = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.unsub();
        resolve(best);
      };
      sub.on("event", (event: NostrEvent) => {
        if (!best || event.created_at > best.created_at) best = event;
      });
      sub.on("eose", () => {
        settled++;
        if (settled >= relays.length) finish();
      });
      const timer = setTimeout(finish, options.timeoutMs ?? 8_000);
    });
  }
}

export const nostrClient = new NostrClientService();
