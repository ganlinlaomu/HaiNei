import type { EventTemplate, NostrEvent, VerifiedEvent } from "nostr-tools";
import { verifySignedEvent } from "@/nostr/messaging/protocol/common";
import { dmRelayDirectoryRepository } from "@/repositories/dmRelayDirectoryRepository";
import { replaceableEventOutboxRepository } from "@/repositories/replaceableEventOutboxRepository";
import { DEFAULT_RELAY_URLS, normalizeRelayUrl } from "@/services/connectionSettings";
import { nostrClient } from "@/services/nostrClient";
import { logger } from "@/utils/logger";

/**
 * This account's kind 10050 (NIP-17 inbox relay list).
 *
 * HaiNei itself never reads a 10050: messages go to fixed relays (see
 * dmRelays.ts). The list is still published, always equal to the default
 * relays, because older HaiNei versions route by the recipient's 10050; a
 * stale one (e.g. listing a since-retired relay) would send their messages
 * where this version no longer reads. Remove once no old version is in use.
 */
export const DM_RELAY_LIST_KIND = 10050;
export const MAX_DM_RELAYS = 3;
const REPUBLISH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_KEY = String(DM_RELAY_LIST_KIND);
const HEX_64 = /^[0-9a-f]{64}$/i;

export type DmRelaySigner = (event: EventTemplate) => Promise<VerifiedEvent>;

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const accountGenerations = new Map<string, number>();
const outboxFlushes = new Map<string, Promise<boolean>>();
const ownListUpdates = new Map<string, Promise<boolean>>();

function generationFor(account: string) {
  return accountGenerations.get(account) || 0;
}

function assertCurrent(account: string, generation: number) {
  if (generationFor(account) !== generation) throw new Error("dm_relay_directory_cancelled");
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

/** The relays this account's 10050 lists: always the defaults. */
export function advertisedDmRelays() {
  return uniqueRelays(DEFAULT_RELAY_URLS, MAX_DM_RELAYS);
}

/** Old versions find a 10050 on the default relays (relay-jp is their shared lookup point). */
function publicationRelays() {
  return uniqueRelays(DEFAULT_RELAY_URLS);
}

function relayStoredEvent(result: { ok: boolean; reason?: unknown }) {
  return result.ok || /^duplicate:/i.test(String(result.reason || "").trim());
}

function sameRelayList(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  return { event, relays };
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
  // A row queued by an older version may list other relays (purplepag.es);
  // publish only where this version's lookups and old versions meet.
  const publishRelays = publicationRelays();
  try {
    const results = await nostrClient.publish(queued.event, publishRelays);
    assertCurrent(account, generation);
    if (!results.some(relayStoredEvent)) throw new Error("dm_relay_list_publish_failed");
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

/**
 * Publishes this account's 10050 as the default relays when the last one
 * published from this device lists anything else (an older version chose it
 * from connected relays), and refreshes it weekly so a list published by an
 * older version on another device is replaced too.
 */
export function ensureOwnDmRelayList(accountPubkey: string, signEvent: DmRelaySigner): Promise<boolean> {
  const account = accountPubkey.toLowerCase();
  const existing = ownListUpdates.get(account);
  if (existing) return existing;
  const task = ensureOwnDmRelayListOnce(account, signEvent, generationFor(account)).finally(() => {
    if (ownListUpdates.get(account) === task) ownListUpdates.delete(account);
  });
  ownListUpdates.set(account, task);
  return task;
}

async function ensureOwnDmRelayListOnce(account: string, signEvent: DmRelaySigner, generation: number) {
  if (!HEX_64.test(account)) return false;
  const relays = advertisedDmRelays();
  if (!relays.length) return false;
  const existing = await dmRelayDirectoryRepository.get(account, account);
  assertCurrent(account, generation);
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
  const publishRelays = publicationRelays();
  await dmRelayDirectoryRepository.put({
    accountPubkey: account,
    ownerPubkey: account,
    relays,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    fetchedAt: queuedAt,
    expiresAt: Number.MAX_SAFE_INTEGER,
    publishedAt: undefined,
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
    relays: directory?.source === "own" && directory.relays.length ? directory.relays : advertisedDmRelays(),
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
  outboxFlushes.delete(account);
  ownListUpdates.delete(account);
}

export function logDmRelayDirectoryFailure(error: unknown) {
  logger.warn("[dm-relays] directory operation failed", error instanceof Error ? error.message : error);
}
