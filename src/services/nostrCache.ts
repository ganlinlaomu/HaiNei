import type { NostrEvent } from "nostr-tools";
import type { CanonicalMessage } from "@/nostr/messaging/protocol";

/** Small O(1) bounded cache. Reading promotes an entry to the MRU position. */
export class LruCache<K, V> {
  private readonly values = new Map<K, V>();

  constructor(readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  peek(key: K): V | undefined { return this.values.get(key); }

  has(key: K): boolean { return this.values.has(key); }

  set(key: K, value: V): this {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean { return this.values.delete(key); }
  clear(): void { this.values.clear(); }
  get size(): number { return this.values.size; }
  entries(): IterableIterator<[K, V]> { return this.values.entries(); }
}

export const eventCache = new LruCache<string, NostrEvent>(10_000);
export const profileCache = new LruCache<string, NostrEvent>(3_000);
export const relayMetadataCache = new LruCache<string, NostrEvent>(3_000);
export const conversationCache = new LruCache<string, CanonicalMessage[]>(500);
export const decryptedEventCache = new LruCache<string, CanonicalMessage | null>(5_000);
export const seenOnCache = new LruCache<string, Set<string>>(10_000);
export const verifiedEventCache = new LruCache<string, boolean>(10_000);

const inFlight = new Map<string, Promise<unknown>>();

export const performanceCounters = {
  eventCacheHit: 0,
  eventCacheMiss: 0,
  decryptCacheHit: 0,
  decryptCacheMiss: 0,
  duplicateEventsDropped: 0,
  relayReconnectCount: 0,
  indexedDbQueueSize: 0
};

export function scopedKey(accountPubkey: string, id: string) {
  return `${accountPubkey.toLowerCase()}:${id}`;
}

export function rememberSeenOn(eventId: string, relayUrl?: string) {
  const seen = seenOnCache.get(eventId) || new Set<string>();
  if (relayUrl) seen.add(relayUrl);
  seenOnCache.set(eventId, seen);
  return seen;
}

export function dedupeRequest<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const promise = work().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export function clearAccountScopedCaches(accountPubkey?: string) {
  const prefix = accountPubkey ? `${accountPubkey.toLowerCase()}:` : "";
  for (const cache of [conversationCache, decryptedEventCache] as const) {
    for (const [key] of cache.entries()) {
      if (!prefix || String(key).startsWith(prefix)) cache.delete(key);
    }
  }
  for (const key of [...inFlight.keys()]) {
    if (!prefix || key.includes(prefix)) inFlight.delete(key);
  }
}

export function getPerformanceDiagnostics() {
  return {
    ...performanceCounters,
    eventCacheSize: eventCache.size,
    profileCacheSize: profileCache.size,
    conversationCacheSize: conversationCache.size,
    decryptedEventCacheSize: decryptedEventCache.size,
    seenOnCacheSize: seenOnCache.size,
    inFlightRequests: inFlight.size
  };
}
