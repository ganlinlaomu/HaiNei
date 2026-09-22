import { reactive } from "vue";
import type { NostrEvent } from "nostr-tools";
import { getRelaysFromStorage, subscribe } from "@/nostr/relays";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import { profileCache } from "@/services/nostrCache";

export type CachedProfile = {
  pubkey: string;
  displayName?: string;
  picture?: string;
  profileUpdatedAt?: number;
  fetchedAt: number;
  failedAt?: number;
  pictureFailedAt?: number;
  pictureFailedUrl?: string;
};

const PROFILE_TTL = 14 * 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN = 30 * 60 * 1000;
const PICTURE_FAILURE_COOLDOWN = 24 * 60 * 60 * 1000;
const MAX_STORED_PROFILES = 1000;
const BATCH_DELAY = 40;
const FETCH_TIMEOUT = 6_000;
const MAX_BATCH_SIZE = 100;

const entries = reactive(new Map<string, CachedProfile>());
const loadedAccounts = new Set<string>();
const pending = new Map<string, Set<string>>();
const batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();

function normalizedPubkey(value?: string | null) {
  const key = (value || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(key) ? key : "";
}

function storageKey(account: string) {
  return `nostr_profiles_${account}`;
}

function entryKey(account: string, pubkey: string) {
  return `${account}:${pubkey}`;
}

function loadAccount(accountValue: string) {
  const account = normalizedPubkey(accountValue);
  if (!account || loadedAccounts.has(account)) return;
  loadedAccounts.add(account);
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(account)) || "[]");
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      const pubkey = normalizedPubkey(item?.pubkey);
      if (!pubkey || typeof item?.fetchedAt !== "number") continue;
      entries.set(entryKey(account, pubkey), { ...item, pubkey });
    }
  } catch {
    // A corrupt profile cache must never affect page rendering.
  }
}

function persistAccount(account: string) {
  try {
    const profiles = [...entries.entries()]
      .filter(([key]) => key.startsWith(`${account}:`))
      .map(([, value]) => value)
      .sort((a, b) => b.fetchedAt - a.fetchedAt)
      .slice(0, MAX_STORED_PROFILES);
    localStorage.setItem(storageKey(account), JSON.stringify(profiles));
  } catch {
    // Storage quota/privacy modes should leave the in-memory cache usable.
  }
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function pictureUrl(value: unknown) {
  const raw = cleanText(value, 2_048);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

export function parseProfileEvent(event: NostrEvent, fetchedAt = Date.now()): CachedProfile {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.content || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {}
  return {
    pubkey: event.pubkey.toLowerCase(),
    displayName: cleanText(metadata.display_name, 100) || cleanText(metadata.name, 100) || undefined,
    picture: pictureUrl(metadata.picture) || undefined,
    profileUpdatedAt: event.created_at,
    fetchedAt
  };
}

function finishBatch(account: string, pubkeys: string[], latest: Map<string, NostrEvent>, successful: boolean) {
  const now = Date.now();
  for (const pubkey of pubkeys) {
    const key = entryKey(account, pubkey);
    const previous = entries.get(key);
    const event = latest.get(pubkey);
    if (event) {
      const next = parseProfileEvent(event, now);
      if (previous && previous.picture === next.picture) {
        next.pictureFailedAt = previous.pictureFailedAt;
        next.pictureFailedUrl = previous.pictureFailedUrl;
      }
      entries.set(key, next);
      profileCache.set(pubkey, event);
    } else if (successful) {
      entries.set(key, { pubkey, fetchedAt: now });
    } else {
      entries.set(key, { ...previous, pubkey, fetchedAt: previous?.fetchedAt || 0, failedAt: now });
    }
    inFlight.delete(key);
  }
  persistAccount(account);
}

function flush(account: string) {
  batchTimers.delete(account);
  const queued = pending.get(account);
  pending.delete(account);
  if (!queued?.size) return;
  const queuedPubkeys = [...queued];
  const pubkeys = queuedPubkeys.slice(0, MAX_BATCH_SIZE).filter(pubkey => {
    const key = entryKey(account, pubkey);
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    return true;
  });
  const remainder = queuedPubkeys.slice(MAX_BATCH_SIZE);
  if (remainder.length) {
    pending.set(account, new Set(remainder));
    batchTimers.set(account, setTimeout(() => flush(account), BATCH_DELAY));
  }
  if (!pubkeys.length) return;

  const relays = [...new Set(getRelaysFromStorage("read").map(normalizeRelayUrl).filter(Boolean))].slice(0, 5);
  if (!relays.length) {
    finishBatch(account, pubkeys, new Map(), false);
    return;
  }

  const latest = new Map<string, NostrEvent>();
  const requested = new Set(pubkeys);
  const sub = subscribe(relays, [{ kinds: [0], authors: pubkeys, limit: pubkeys.length }]);
  let settled = 0;
  let done = false;
  const finish = (successful: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    sub.unsub();
    finishBatch(account, pubkeys, latest, successful);
  };
  sub.on("event", (event: NostrEvent) => {
    const pubkey = normalizedPubkey(event.pubkey);
    if (event.kind !== 0 || !requested.has(pubkey)) return;
    const previous = latest.get(pubkey);
    if (!previous || event.created_at > previous.created_at) latest.set(pubkey, event);
  });
  sub.on("eose", () => {
    settled++;
    if (settled >= relays.length) finish(true);
  });
  const timeout = setTimeout(() => finish(latest.size > 0), FETCH_TIMEOUT);
}

export function getCachedProfile(accountValue: string, pubkeyValue: string) {
  const account = normalizedPubkey(accountValue);
  const pubkey = normalizedPubkey(pubkeyValue);
  if (!account || !pubkey) return undefined;
  loadAccount(account);
  return entries.get(entryKey(account, pubkey));
}

export function ensureProfile(accountValue: string, pubkeyValue: string) {
  const account = normalizedPubkey(accountValue);
  const pubkey = normalizedPubkey(pubkeyValue);
  if (!account || !pubkey) return;
  loadAccount(account);
  const key = entryKey(account, pubkey);
  const cached = entries.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < PROFILE_TTL) return;
  if (cached?.failedAt && now - cached.failedAt < FAILURE_COOLDOWN) return;
  if (inFlight.has(key)) return;
  const queue = pending.get(account) || new Set<string>();
  queue.add(pubkey);
  pending.set(account, queue);
  if (!batchTimers.has(account)) batchTimers.set(account, setTimeout(() => flush(account), BATCH_DELAY));
}

export function profileDisplayName(account: string, pubkey: string, localName?: string) {
  const local = localProfileName(pubkey, localName);
  if (local) return local;
  return getCachedProfile(account, pubkey)?.displayName || `${pubkey.slice(0, 8)}…`;
}

export function localProfileName(pubkey: string, value?: string) {
  const local = (value || "").trim();
  if (local === `${pubkey.slice(0, 8)}…` || local === `${pubkey.slice(0, 8)}...`) return "";
  return local;
}

export function usableProfilePicture(account: string, pubkey: string) {
  const profile = getCachedProfile(account, pubkey);
  if (!profile?.picture) return "";
  if (profile.pictureFailedUrl === profile.picture && profile.pictureFailedAt
    && Date.now() - profile.pictureFailedAt < PICTURE_FAILURE_COOLDOWN) return "";
  return profile.picture;
}

export function markProfilePictureFailed(accountValue: string, pubkeyValue: string, url: string) {
  const account = normalizedPubkey(accountValue);
  const pubkey = normalizedPubkey(pubkeyValue);
  if (!account || !pubkey) return;
  const key = entryKey(account, pubkey);
  const profile = entries.get(key);
  if (!profile || profile.picture !== url) return;
  entries.set(key, { ...profile, pictureFailedAt: Date.now(), pictureFailedUrl: url });
  persistAccount(account);
}
