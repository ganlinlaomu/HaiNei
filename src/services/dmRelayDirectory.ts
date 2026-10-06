import type { EventTemplate, NostrEvent, VerifiedEvent } from "nostr-tools";
import { getRelaysFromStorage, inspectRelays, type RelayRuntimeStatus } from "@/nostr/relays";
import { verifySignedEvent } from "@/nostr/messaging/protocol/common";
import { dmRelayDirectoryRepository } from "@/repositories/dmRelayDirectoryRepository";
import { replaceableEventOutboxRepository } from "@/repositories/replaceableEventOutboxRepository";
import { DEFAULT_RELAY_URLS, normalizeRelayUrl } from "@/services/connectionSettings";
import { nostrClient } from "@/services/nostrClient";
import { closeSubscription } from "@/utils/subscriptions";
import { logger } from "@/utils/logger";

export const DM_RELAY_LIST_KIND = 10050;
export const MAX_DM_RELAYS = 3;
const DM_DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const QUERY_TIMEOUT_MS = 2_500;
const REPUBLISH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DISCOVERY_QUERY_RELAY_LIMIT = 2;
const DISCOVERY_CONFIGURED_RELAY_LIMIT = 2;
const DISCOVERY_HINT_RELAY_LIMIT = 2;
const PUBLICATION_RELAY_LIMIT = 4;
const MAX_CACHED_PEERS = 500;
const OUTBOX_KEY = String(DM_RELAY_LIST_KIND);
const HEX_64 = /^[0-9a-f]{64}$/i;
// Metadata-only discovery; never add this relay to message receive/send routes.
const PUBLIC_DM_DIRECTORY = "wss://purplepag.es";

export type DmRelayRouteSource = "nip17-10050" | "own-10050" | "legacy-fallback";
export type DmRelayResolution = {
  relays: string[];
  source: DmRelayRouteSource;
  eventId?: string;
  cached: boolean;
};

export type DmRelaySigner = (event: EventTemplate) => Promise<VerifiedEvent>;
export type EnsureOwnDmRelayListOptions = {
  // Runtime failures are intentionally opt-in. Normal startup/connection-order
  // changes must not rotate the account's advertised DM inbox relays.
  replaceUnhealthyRelays?: readonly string[];
  // Startup checks may refresh the account-level list from discovery. Health
  // retries skip this extra lookup because they already operate on known state.
  refreshRemote?: boolean;
};

const resolutions = new Map<string, Promise<DmRelayResolution>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const accountGenerations = new Map<string, number>();
const queryCancellations = new Map<string, Set<() => void>>();
const outboxFlushes = new Map<string, Promise<boolean>>();
const ownListUpdates = new Map<string, Promise<boolean>>();
const queryWaiters: Array<() => void> = [];
let activeQueries = 0;

function generationFor(account: string) {
  return accountGenerations.get(account) || 0;
}

function assertCurrent(account: string, generation: number) {
  if (generationFor(account) !== generation) throw new Error("dm_relay_directory_cancelled");
}

async function withQuerySlot<T>(work: () => Promise<T>) {
  if (activeQueries < 2) activeQueries++;
  else await new Promise<void>(resolve => queryWaiters.push(resolve));
  try {
    return await work();
  } finally {
    const next = queryWaiters.shift();
    if (next) next();
    else activeQueries--;
  }
}

function secureRelayUrl(value: string) {
  const normalized = normalizeRelayUrl(value);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "wss:" && !parsed.username && !parsed.password ? normalized : "";
  } catch {
    return "";
  }
}

function uniqueRelays(values: readonly string[], limit = Number.POSITIVE_INFINITY) {
  return [...new Set(values.map(secureRelayUrl).filter(Boolean))].slice(0, limit);
}

function legacyRelays(values: string[]) {
  return [...new Set(values.map(normalizeRelayUrl).filter(Boolean))];
}

function relayStoredEvent(result: { ok: boolean; reason?: unknown }) {
  return result.ok || /^duplicate:/i.test(String(result.reason || "").trim());
}

export function selectOwnDmRelays(
  readRelays = getRelaysFromStorage("read"),
  runtimeStatuses: Record<string, RelayRuntimeStatus> = inspectRelays(),
) {
  const connected = readRelays.filter(relay => {
    const normalized = secureRelayUrl(relay);
    if (!normalized) return false;
    const runtime = runtimeStatuses[normalized];
    return runtime?.state === "connected" || runtime?.ready === true;
  });
  return uniqueRelays(connected, Math.min(2, MAX_DM_RELAYS));
}

function sameRelayList(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileOwnDmRelays(existingRelays: readonly string[], replaceUnhealthyRelays: readonly string[]) {
  const current = uniqueRelays(existingRelays, MAX_DM_RELAYS);
  const configured = uniqueRelays(getRelaysFromStorage("read"));
  const configuredSet = new Set(configured);
  const unhealthy = new Set(uniqueRelays(replaceUnhealthyRelays));
  const removed = current.filter(relay => !configuredSet.has(relay));
  const failed = current.filter(relay => unhealthy.has(relay));

  // Sticky by default: connection ordering, app restarts, and short outages must
  // never rewrite kind 10050. Existing account-level routes remain authoritative.
  if (current.length && !removed.length && !failed.length) return current;

  const retained = current.filter(relay => configuredSet.has(relay) && !unhealthy.has(relay));
  const targetCount = Math.min(Math.max(current.length, 2), MAX_DM_RELAYS);
  const replacements = selectOwnDmRelays(configured)
    .filter(relay => !unhealthy.has(relay) && !retained.includes(relay));

  // A sustained runtime failure alone is not a reason to reduce redundancy.
  // Keep the old advertisement until a healthy replacement actually exists.
  if (failed.length && !removed.length && replacements.length < failed.length) return current;

  return uniqueRelays([...retained, ...replacements], targetCount);
}

export function dmDiscoveryRelays() {
  // One public metadata directory plus a shared HaiNei discovery point. These
  // connections are temporary, not per-contact permanent subscriptions.
  return uniqueRelays([PUBLIC_DM_DIRECTORY, ...DEFAULT_RELAY_URLS], DISCOVERY_QUERY_RELAY_LIMIT);
}

function configuredDiscoveryRelays() {
  const shared = dmDiscoveryRelays();
  const read = getRelaysFromStorage("read");
  const write = getRelaysFromStorage("write");
  return uniqueRelays([
    ...read.slice(0, 1),
    ...write.slice(0, 1),
    ...read,
    ...write,
  ]).filter(relay => !shared.includes(relay)).slice(0, DISCOVERY_CONFIGURED_RELAY_LIMIT);
}

export function parseDmRelayListEvent(event: NostrEvent, ownerPubkey: string) {
  const owner = ownerPubkey.toLowerCase();
  if (
    event?.kind !== DM_RELAY_LIST_KIND
    || event.pubkey?.toLowerCase() !== owner
    || !HEX_64.test(owner)
    || !verifySignedEvent(event)
  ) return null;
  const relays = uniqueRelays(
    event.tags
      .filter(tag => tag[0] === "relay" && typeof tag[1] === "string")
      .map(tag => tag[1]),
    MAX_DM_RELAYS,
  );
  // A valid empty/unsupported list is still an explicit preference. Treating
  // it as "not found" would leak the recipient copy to legacy public relays.
  return { event, relays };
}

function isNewer(candidate: NostrEvent, current: NostrEvent | null) {
  if (!current) return true;
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at;
  return candidate.id.localeCompare(current.id) < 0;
}

type DmDirectoryQuery = {
  found: { event: NostrEvent; relays: string[]; sourceRelays: string[] } | null;
  nip65: NostrEvent | null;
  complete: boolean;
};

async function queryDmRelayList(account: string, generation: number, ownerPubkey: string, relays: string[], includeNip65 = false) {
  const targets = uniqueRelays(relays, includeNip65 ? DISCOVERY_QUERY_RELAY_LIMIT : DISCOVERY_HINT_RELAY_LIMIT);
  if (!targets.length) return { found: null, nip65: null, complete: true } satisfies DmDirectoryQuery;
  return withQuerySlot(async () => {
    assertCurrent(account, generation);
    return subscribeDirectoryQuery(account, generation, ownerPubkey, targets, includeNip65);
  });
}

function subscribeDirectoryQuery(account: string, generation: number, ownerPubkey: string, targets: string[], includeNip65: boolean) {
  return new Promise<DmDirectoryQuery>(resolve => {
    const settled = new Set<string>();
    const completed = new Set<string>();
    const sources = new Set<string>();
    let best: NostrEvent | null = null;
    let bestRelays: string[] = [];
    let relayList: NostrEvent | null = null;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: ReturnType<typeof nostrClient.subscribe> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      closeSubscription(subscription);
      const cancellations = queryCancellations.get(account);
      cancellations?.delete(finish);
      if (!cancellations?.size) queryCancellations.delete(account);
      resolve({
        found: best ? { event: best, relays: bestRelays, sourceRelays: [...sources] } : null,
        nip65: relayList,
        complete: completed.size >= targets.length,
      });
    };
    const cancellations = queryCancellations.get(account) || new Set<() => void>();
    cancellations.add(finish);
    queryCancellations.set(account, cancellations);
    try {
      const filters = [{ kinds: [DM_RELAY_LIST_KIND], authors: [ownerPubkey], limit: 1 }];
      if (includeNip65) filters.push({ kinds: [10002], authors: [ownerPubkey], limit: 1 });
      subscription = nostrClient.subscribe(targets, filters);
      timer = setTimeout(finish, QUERY_TIMEOUT_MS);
      subscription.on("event", (event: NostrEvent, relayUrl?: string) => {
        if (finished || generationFor(account) !== generation) return;
        if (event.kind === DM_RELAY_LIST_KIND) {
          const parsed = parseDmRelayListEvent(event, ownerPubkey);
          if (!parsed) return;
          if (isNewer(event, best)) {
            best = event;
            bestRelays = parsed.relays;
            sources.clear();
          }
          if (best?.id === event.id) {
            const source = secureRelayUrl(relayUrl || "");
            if (source) sources.add(source);
          }
          return;
        }
        if (
          includeNip65
          && event.kind === 10002
          && event.pubkey?.toLowerCase() === ownerPubkey
          && verifySignedEvent(event)
          && isNewer(event, relayList)
        ) relayList = event;
      });
      const markSettled = (relayUrl: string, didComplete: boolean) => {
        const relay = secureRelayUrl(relayUrl);
        if (relay) {
          settled.add(relay);
          if (didComplete) completed.add(relay);
        }
        if (settled.size >= targets.length) finish();
      };
      subscription.on("eose", (relayUrl: string) => markSettled(relayUrl, true));
      subscription.on("failure", (relayUrl: string) => markSettled(relayUrl, false));
    } catch {
      finish();
    }
  });
}

async function queryDiscovery(account: string, generation: number, owner: string, includeNip65 = false) {
  const shared = await queryDmRelayList(account, generation, owner, dmDiscoveryRelays(), includeNip65);
  assertCurrent(account, generation);
  if (shared.found) return shared;
  const configured = await queryDmRelayList(account, generation, owner, configuredDiscoveryRelays(), includeNip65);
  assertCurrent(account, generation);
  return {
    found: configured.found,
    nip65: configured.nip65 && isNewer(configured.nip65, shared.nip65) ? configured.nip65 : shared.nip65,
    complete: shared.complete && configured.complete,
  } satisfies DmDirectoryQuery;
}

function nip65WriteRelays(event: NostrEvent | null, ownerPubkey: string) {
  if (
    !event
    || event.kind !== 10002
    || event.pubkey?.toLowerCase() !== ownerPubkey
    || !verifySignedEvent(event)
  ) return [];
  return uniqueRelays(event.tags.flatMap(tag => {
    if (tag[0] !== "r" || !tag[1]) return [];
    const marker = tag[2]?.toLowerCase();
    return !marker || marker === "write" ? [tag[1]] : [];
  }), DISCOVERY_HINT_RELAY_LIMIT);
}

export async function resolveDmRelays(
  accountPubkey: string,
  ownerPubkey: string,
  fallbackRelays: string[],
  force = false,
): Promise<DmRelayResolution> {
  const account = accountPubkey.toLowerCase();
  const owner = ownerPubkey.toLowerCase();
  const generation = generationFor(account);
  const fallback = legacyRelays(fallbackRelays);
  if (!HEX_64.test(account) || !HEX_64.test(owner)) {
    return { relays: fallback, source: "legacy-fallback", cached: false };
  }
  if (owner === account) {
    const stored = await dmRelayDirectoryRepository.get(account, account);
    assertCurrent(account, generation);
    const own = stored?.source === "own" ? stored.relays : selectOwnDmRelays();
    return { relays: own.length ? own : fallback, source: "own-10050", eventId: stored?.eventId, cached: true };
  }

  const cache = await dmRelayDirectoryRepository.get(account, owner);
  assertCurrent(account, generation);
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) {
    if (cache.source === "nip17") {
      return { relays: cache.relays, source: "nip17-10050", eventId: cache.eventId, cached: true };
    }
    if (cache.source === "negative") {
      return { relays: fallback, source: "legacy-fallback", cached: true };
    }
  }

  const resolutionKey = `${account}:${owner}`;
  const existing = resolutions.get(resolutionKey);
  if (existing) return existing;
  const task = (async () => {
    try {
      const discovery = dmDiscoveryRelays();
      const direct = await queryDiscovery(account, generation, owner, true);
      let found = direct.found;
      if (!found) {
        const hints = nip65WriteRelays(direct.nip65, owner)
          .filter(relay => ![...discovery, ...configuredDiscoveryRelays()].includes(relay));
        if (hints.length) {
          const hinted = await queryDmRelayList(account, generation, owner, hints);
          found = hinted.found;
        }
      }
      assertCurrent(account, generation);
      if (found) {
        // A partial directory result must never downgrade a newer signed list
        // already learned from another relay/device.
        if (cache?.source === "nip17" && cache.eventId && (
          (cache.eventCreatedAt || 0) > found.event.created_at
          || (cache.eventCreatedAt === found.event.created_at && cache.eventId.localeCompare(found.event.id) < 0)
        )) {
          return { relays: cache.relays, source: "nip17-10050" as const, eventId: cache.eventId, cached: true };
        }
        await dmRelayDirectoryRepository.put({
          accountPubkey: account,
          ownerPubkey: owner,
          relays: found.relays,
          eventId: found.event.id,
          eventCreatedAt: found.event.created_at,
          fetchedAt: now,
          expiresAt: now + DM_DIRECTORY_TTL_MS,
          source: "nip17",
          sourceRelays: found.sourceRelays,
        });
        assertCurrent(account, generation);
        await dmRelayDirectoryRepository.prune(account, MAX_CACHED_PEERS, now);
        return {
          relays: found.relays,
          source: "nip17-10050" as const,
          eventId: found.event.id,
          cached: false,
        };
      }

      // EOSE proves only that these relays lack the event, not that the owner
      // stopped using DM relays. Never broaden a known private route on a miss.
      if (cache?.source === "nip17") {
        await dmRelayDirectoryRepository.put({ ...cache, fetchedAt: now, expiresAt: now + NEGATIVE_TTL_MS });
        return { relays: cache.relays, source: "nip17-10050" as const, eventId: cache.eventId, cached: true };
      }
      await dmRelayDirectoryRepository.put({
        accountPubkey: account,
        ownerPubkey: owner,
        relays: [],
        fetchedAt: now,
        expiresAt: now + NEGATIVE_TTL_MS,
        source: "negative",
        sourceRelays: discovery,
      });
      assertCurrent(account, generation);
      await dmRelayDirectoryRepository.prune(account, MAX_CACHED_PEERS, now);
      return { relays: fallback, source: "legacy-fallback" as const, cached: false };
    } catch {
      assertCurrent(account, generation);
      // Directory lookup is an optimization on top of the existing transport;
      // it must never prevent a legacy-compatible message from being queued.
      if (cache?.source === "nip17") {
        return { relays: cache.relays, source: "nip17-10050" as const, eventId: cache.eventId, cached: true };
      }
      return { relays: fallback, source: "legacy-fallback" as const, cached: false };
    }
  })().finally(() => {
    if (resolutions.get(resolutionKey) === task) resolutions.delete(resolutionKey);
  });
  resolutions.set(resolutionKey, task);
  return task;
}

function scheduleOutboxRetry(accountPubkey: string, delay: number) {
  const generation = generationFor(accountPubkey);
  const existing = retryTimers.get(accountPubkey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    retryTimers.delete(accountPubkey);
    if (generationFor(accountPubkey) === generation) {
      void flushOwnDmRelayOutbox(accountPubkey).catch(logDmRelayDirectoryFailure);
    }
  }, Math.max(0, delay));
  (timer as any).unref?.();
  retryTimers.set(accountPubkey, timer);
}

export function flushOwnDmRelayOutbox(accountPubkey: string): Promise<boolean> {
  const account = accountPubkey.toLowerCase();
  const existing = outboxFlushes.get(account);
  if (existing) return existing;
  const task = flushOwnDmRelayOutboxOnce(account, generationFor(account)).finally(() => {
    if (outboxFlushes.get(account) === task) outboxFlushes.delete(account);
  });
  outboxFlushes.set(account, task);
  return task;
}

async function flushOwnDmRelayOutboxOnce(account: string, generation: number) {
  const queued = await replaceableEventOutboxRepository.get(account, OUTBOX_KEY);
  assertCurrent(account, generation);
  if (!queued) return true;
  const now = Date.now();
  if ((queued.nextAttemptAt || 0) > now) {
    scheduleOutboxRetry(account, queued.nextAttemptAt! - now);
    return false;
  }
  const attempts = queued.attempts + 1;
  const advertisedRelays = queued.event.tags
    .filter(tag => tag[0] === "relay" && typeof tag[1] === "string")
    .map(tag => tag[1]);
  const publishRelays = uniqueRelays(
    [...dmDiscoveryRelays(), ...advertisedRelays, ...queued.relays],
    PUBLICATION_RELAY_LIMIT,
  );
  try {
    const results = await nostrClient.publish(queued.event, publishRelays);
    assertCurrent(account, generation);
    const discoveryRelays = new Set(dmDiscoveryRelays());
    const publiclyDiscoverable = results.some(result =>
      relayStoredEvent(result) && discoveryRelays.has(secureRelayUrl(result.relay))
    );
    if (!publiclyDiscoverable) throw new Error("dm_relay_list_discovery_publish_failed");
    const current = await replaceableEventOutboxRepository.get(account, OUTBOX_KEY);
    assertCurrent(account, generation);
    if (current?.event.id === queued.event.id) {
      await replaceableEventOutboxRepository.delete(account, OUTBOX_KEY);
      const own = await dmRelayDirectoryRepository.get(account, account);
      assertCurrent(account, generation);
      if (own?.eventId === queued.event.id) {
        await dmRelayDirectoryRepository.put({ ...own, publishedAt: Date.now() });
      }
    }
    return true;
  } catch (error) {
    assertCurrent(account, generation);
    const delay = Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1_000);
    const current = await replaceableEventOutboxRepository.get(account, OUTBOX_KEY);
    assertCurrent(account, generation);
    if (current?.event.id === queued.event.id) {
      await replaceableEventOutboxRepository.update(account, OUTBOX_KEY, {
        relays: publishRelays,
        attempts,
        nextAttemptAt: Date.now() + delay,
        lastError: error instanceof Error ? error.message : "publish_failed",
        updatedAt: Date.now(),
      });
      assertCurrent(account, generation);
      scheduleOutboxRetry(account, delay);
    }
    return false;
  }
}

export function ensureOwnDmRelayList(
  accountPubkey: string,
  signEvent: DmRelaySigner,
  options: EnsureOwnDmRelayListOptions = {},
): Promise<boolean> {
  const account = accountPubkey.toLowerCase();
  const existing = ownListUpdates.get(account);
  if (existing) return existing;
  const task = ensureOwnDmRelayListOnce(account, signEvent, generationFor(account), options).finally(() => {
    if (ownListUpdates.get(account) === task) ownListUpdates.delete(account);
  });
  ownListUpdates.set(account, task);
  return task;
}

async function ensureOwnDmRelayListOnce(
  account: string,
  signEvent: DmRelaySigner,
  generation: number,
  options: EnsureOwnDmRelayListOptions,
) {
  if (!HEX_64.test(account)) return false;
  let existing = await dmRelayDirectoryRepository.get(account, account);
  assertCurrent(account, generation);
  const pendingBeforeRefresh = await replaceableEventOutboxRepository.get(account, OUTBOX_KEY);
  assertCurrent(account, generation);

  if (!existing || (options.refreshRemote !== false && !pendingBeforeRefresh)) {
    const remote = await queryDiscovery(account, generation, account);
    assertCurrent(account, generation);
    if (remote.found) {
      const remoteIsNewer = !existing?.eventId
        || remote.found.event.created_at > (existing.eventCreatedAt || 0)
        || (
          remote.found.event.created_at === (existing.eventCreatedAt || 0)
          && remote.found.event.id.localeCompare(existing.eventId) < 0
        );
      if (!existing || remoteIsNewer) {
        const observedAt = Date.now();
        existing = {
          accountPubkey: account,
          ownerPubkey: account,
          relays: remote.found.relays,
          eventId: remote.found.event.id,
          eventCreatedAt: remote.found.event.created_at,
          fetchedAt: observedAt,
          expiresAt: Number.MAX_SAFE_INTEGER,
          publishedAt: observedAt,
          source: "own",
          sourceRelays: remote.found.sourceRelays,
        };
        // kind 10050 is account state, not device state. A fresh or returning
        // device adopts the newest already-published inbox list instead of
        // overwriting it from transient local connection order.
        await dmRelayDirectoryRepository.put(existing);
        assertCurrent(account, generation);
        return true;
      }
    }
  }

  const relays = reconcileOwnDmRelays(existing?.source === "own" ? existing.relays : [], options.replaceUnhealthyRelays || []);
  if (!relays.length) return false;

  const unchanged = existing?.source === "own" && sameRelayList(existing.relays, relays);
  const pending = await replaceableEventOutboxRepository.get(account, OUTBOX_KEY);
  assertCurrent(account, generation);
  if (unchanged && pending?.event.id === existing?.eventId) return flushOwnDmRelayOutbox(account);
  if (unchanged && existing?.publishedAt && Date.now() - existing.publishedAt < REPUBLISH_AFTER_MS) return true;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const createdAt = Math.max(nowSeconds, (existing?.eventCreatedAt || 0) + 1);
  const event = await signEvent({
    kind: DM_RELAY_LIST_KIND,
    created_at: createdAt,
    tags: relays.map(relay => ["relay", relay]),
    content: "",
  });
  assertCurrent(account, generation);
  const parsed = parseDmRelayListEvent(event, account);
  if (!parsed || !sameRelayList(parsed.relays, relays)) throw new Error("dm_relay_list_invalid_signature");

  const queuedAt = Date.now();
  const publishRelays = uniqueRelays(
    [...dmDiscoveryRelays(), ...relays],
    PUBLICATION_RELAY_LIMIT,
  );
  await dmRelayDirectoryRepository.put({
    accountPubkey: account,
    ownerPubkey: account,
    relays,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    fetchedAt: queuedAt,
    expiresAt: Number.MAX_SAFE_INTEGER,
    publishedAt: unchanged ? existing?.publishedAt : undefined,
    source: "own",
    sourceRelays: publishRelays,
  });
  assertCurrent(account, generation);
  await replaceableEventOutboxRepository.putLatest({
    accountPubkey: account,
    key: OUTBOX_KEY,
    event,
    relays: publishRelays,
    attempts: 0,
    createdAt: queuedAt,
    updatedAt: queuedAt,
  });
  assertCurrent(account, generation);
  return flushOwnDmRelayOutbox(account);
}

export async function getOwnDmRelayStatus(accountPubkey: string) {
  const account = accountPubkey.toLowerCase();
  const [directory, queued] = await Promise.all([
    dmRelayDirectoryRepository.get(account, account),
    replaceableEventOutboxRepository.get(account, OUTBOX_KEY),
  ]);
  return {
    relays: directory?.relays || selectOwnDmRelays(),
    eventId: directory?.eventId,
    publishedAt: directory?.publishedAt,
    pending: !!queued,
    attempts: queued?.attempts || 0,
    nextAttemptAt: queued?.nextAttemptAt,
    lastError: queued?.lastError,
  };
}

export function cancelDmRelayDirectoryWork(accountPubkey: string) {
  const account = accountPubkey.toLowerCase();
  accountGenerations.set(account, generationFor(account) + 1);
  const timer = retryTimers.get(account);
  if (timer) clearTimeout(timer);
  retryTimers.delete(account);
  for (const finish of [...(queryCancellations.get(account) || [])]) finish();
  outboxFlushes.delete(account);
  ownListUpdates.delete(account);
  for (const key of resolutions.keys()) {
    if (key.startsWith(`${account}:`)) resolutions.delete(key);
  }
}

export function logDmRelayDirectoryFailure(error: unknown) {
  logger.warn("[dm-relays] directory operation failed", error instanceof Error ? error.message : error);
}
