import { deviceStorage } from "@/services/deviceStorage";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import { timedJsonFetch } from "@/utils/timedFetch";

const STORAGE_KEY = "hainei_relay_nips";
const CACHE_MS = 24 * 60 * 60_000;
const RETRY_MS = 10 * 60_000;

type Entry = { nips: number[]; checkedAt: number; ttl: number };
let memory: Record<string, Entry> | null = null;
const inflight = new Map<string, Promise<number[]>>();

function cache() {
  if (memory) return memory;
  try {
    const stored = JSON.parse(deviceStorage.getItem(STORAGE_KEY) || "{}");
    memory = stored && typeof stored === "object" ? stored : {};
  } catch {
    memory = {};
  }
  return memory!;
}

function save() {
  try { deviceStorage.setItem(STORAGE_KEY, JSON.stringify(memory || {})); } catch { /* memory cache still applies */ }
}

export function resetRelayCapabilitiesForTests() {
  memory = null;
  inflight.clear();
}

/** NIP numbers a relay advertises in its NIP-11 document; cached a day per device. */
export async function relaySupportedNips(url: string): Promise<number[]> {
  const relay = normalizeRelayUrl(url);
  if (!relay) return [];
  const entry = cache()[relay];
  if (entry && Date.now() - entry.checkedAt < entry.ttl) return entry.nips;
  let pending = inflight.get(relay);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await timedJsonFetch(relay.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"), { headers: { Accept: "application/nostr+json" } }, 2_500);
        const body = response.ok ? await response.json() : null;
        const nips = Array.isArray(body?.supported_nips) ? body.supported_nips.filter(Number.isInteger) : [];
        cache()[relay] = { nips, checkedAt: Date.now(), ttl: CACHE_MS };
      } catch {
        // Offline or slow: assume nothing extra and ask again later.
        cache()[relay] = { nips: [], checkedAt: Date.now(), ttl: RETRY_MS };
      }
      save();
      return cache()[relay].nips;
    })().finally(() => inflight.delete(relay));
    inflight.set(relay, pending);
  }
  return pending;
}

/** The relays among `relays` that advertise NIP-77 negentropy sync. */
export async function negentropyCapableRelays(relays: string[]): Promise<string[]> {
  const support = await Promise.all(relays.map(async url => ((await relaySupportedNips(url)).includes(77) ? url : "")));
  return support.filter(Boolean);
}
