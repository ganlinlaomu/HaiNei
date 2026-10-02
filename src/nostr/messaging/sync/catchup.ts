import type { NostrEvent } from "nostr-tools";
import { subscribe } from "@/nostr/relays";
import type { RelaySubscriptionFailureReason } from "@/nostr/relays";
import { normalizeRelayUrl } from "@/services/connectionSettings";
import { closeSubscription } from "@/utils/subscriptions";
import { logger } from "@/utils/logger";
import type { SubscriptionLike } from "./types";

export type CatchupPageResult = {
  events: Array<{ event: NostrEvent; relayUrl?: string }>;
  completedRelays: Set<string>;
  failedRelays: Map<string, RelaySubscriptionFailureReason>;
  allRelaysCompleted: boolean;
  timedOut: boolean;
  aborted: boolean;
};

export type RelayCatchupProgress = {
  nextUntil?: number;
  naturalEnd: boolean;
  hitMaxBatches: boolean;
  incomplete: boolean;
};

export type SubscribeForCatchup = (relays: string[], filters: any[]) => SubscriptionLike;

function normalizedRelaySet(relays: string[]) {
  return [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))];
}

export async function fetchCatchupPage(
  relays: string[],
  filters: any[],
  timeoutMs = 8000,
  subscribeFn: SubscribeForCatchup = subscribe,
  trackSubscription?: (subscription: SubscriptionLike) => (() => void) | void,
  signal?: AbortSignal
): Promise<CatchupPageResult> {
  const normalizedRelays = normalizedRelaySet(relays);
  const expectedRelays = new Set(normalizedRelays);
  const completedRelays = new Set<string>();
  const failedRelays = new Map<string, RelaySubscriptionFailureReason>();
  const events: Array<{ event: NostrEvent; relayUrl?: string }> = [];
  const subscription = subscribeFn(normalizedRelays, filters);
  const untrack = trackSubscription?.(subscription);

  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: "eose" | "timeout" | "failure" | "abort" | "empty") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (reason === "timeout") {
        for (const relay of expectedRelays) {
          if (!completedRelays.has(relay) && !failedRelays.has(relay)) failedRelays.set(relay, "timeout");
        }
      }
      closeSubscription(subscription);
      untrack?.();
      signal?.removeEventListener("abort", abort);
      resolve({
        events,
        completedRelays,
        failedRelays,
        allRelaysCompleted: expectedRelays.size === completedRelays.size && failedRelays.size === 0,
        timedOut: reason === "timeout",
        aborted: reason === "abort",
      });
    };
    const abort = () => finish("abort");

    subscription.on("event", (event: NostrEvent, relayUrl?: string) => events.push({ event, relayUrl }));
    subscription.on("eose", (rawRelayUrl: string) => {
      const relayUrl = normalizeRelayUrl(rawRelayUrl);
      if (!relayUrl || !expectedRelays.has(relayUrl) || completedRelays.has(relayUrl) || failedRelays.has(relayUrl)) return;
      completedRelays.add(relayUrl);
      logger.debug(`[message-sync] EOSE relay=${relayUrl} count=${completedRelays.size}/${expectedRelays.size}`);
      if (completedRelays.size === expectedRelays.size) finish("eose");
    });
    subscription.on("failure", (rawRelayUrl: string, reason: RelaySubscriptionFailureReason) => {
      const relayUrl = normalizeRelayUrl(rawRelayUrl);
      if (!relayUrl || !expectedRelays.has(relayUrl) || completedRelays.has(relayUrl) || failedRelays.has(relayUrl)) return;
      failedRelays.set(relayUrl, reason);
      logger.warn(`[message-sync] relay catch-up failed relay=${relayUrl} reason=${reason}`);
      finish("failure");
    });

    timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) finish("abort");
    if (expectedRelays.size === 0) finish("empty");
  });
}

export async function runPagedCatchup(options: {
  relays: string[];
  filters: any[];
  onEvent: (event: NostrEvent, relayUrl?: string) => Promise<void>;
  isCurrent: () => boolean;
  timeoutMs?: number;
  maxBatches?: number;
  subscribeFn?: SubscribeForCatchup;
  trackSubscription?: (subscription: SubscriptionLike) => (() => void) | void;
  signal?: AbortSignal;
  initialUntilByRelay?: Record<string, number | undefined>;
  relayConcurrency?: number;
}) {
  const seenEventIds = new Set<string>();
  const defaultUntil = options.filters.reduce<number | undefined>((value, filter) => {
    if (typeof filter.until !== "number") return value;
    return value === undefined ? filter.until : Math.min(value, filter.until);
  }, undefined);
  let received = 0;
  let insertedCandidates = 0;
  const completedRelays = new Set<string>();
  const failedRelays = new Map<string, RelaySubscriptionFailureReason>();
  let allRelaysCompleted = true;
  let timedOut = false;
  let aborted = false;
  const maxBatches = options.maxBatches ?? 100;
  const relayProgress: Record<string, RelayCatchupProgress> = {};
  const relays = normalizedRelaySet(options.relays);

  const runRelay = async (relay: string) => {
    let currentUntil = options.initialUntilByRelay?.[relay] ?? defaultUntil;
    let naturalEnd = false;
    let batches = 0;
    let relayIncomplete = false;

    for (let batch = 0; batch < maxBatches && options.isCurrent(); batch++) {
      batches++;
      const pageUntil = currentUntil;
      const pageFilters = options.filters.map(filter => ({
        ...filter,
        ...(pageUntil === undefined ? {} : { until: pageUntil })
      }));
      const page = await fetchCatchupPage(
        [relay],
        pageFilters,
        options.timeoutMs,
        options.subscribeFn,
        options.trackSubscription,
        options.signal
      );
      for (const completedRelay of page.completedRelays) completedRelays.add(completedRelay);
      for (const [failedRelay, reason] of page.failedRelays) {
        if (!failedRelays.has(failedRelay)) failedRelays.set(failedRelay, reason);
      }
      allRelaysCompleted = allRelaysCompleted && page.allRelaysCompleted;
      timedOut = timedOut || page.timedOut;
      aborted = aborted || page.aborted;
      received += page.events.length;

      let newUnique = 0;
      let oldest: number | undefined;
      for (const { event, relayUrl } of page.events) {
        if (!options.isCurrent()) break;
        oldest = oldest === undefined ? event.created_at : Math.min(oldest, event.created_at);
        if (!event.id || seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);
        newUnique++;
        insertedCandidates++;
        await options.onEvent(event, relayUrl || relay);
      }

      const pageFailed = page.aborted
        || page.timedOut
        || page.failedRelays.size > 0
        || !page.allRelaysCompleted
        || !options.isCurrent();
      if (pageFailed) {
        // Keep this relay at its previous boundary. Other relays continue with
        // their own cursors, so one unavailable server cannot stall the round.
        currentUntil = pageUntil;
        relayIncomplete = true;
        break;
      }

      if (oldest === undefined) { naturalEnd = true; break; }
      const didNotAdvance = currentUntil !== undefined && oldest === currentUntil;
      if (didNotAdvance && newUnique === 0) { naturalEnd = true; break; }
      currentUntil = oldest;
      const pageLimit = Math.max(...pageFilters.map(filter => Number(filter.limit || 0)));
      if (!pageLimit || page.events.length < pageLimit) { naturalEnd = true; break; }
    }

    const hitMaxBatches = !naturalEnd && batches >= maxBatches;
    relayProgress[relay] = {
      nextUntil: currentUntil,
      naturalEnd,
      hitMaxBatches,
      incomplete: relayIncomplete || !options.isCurrent(),
    };
  };

  // A small pool avoids opening every configured relay at once on mobile.
  const concurrency = Math.max(1, Math.min(options.relayConcurrency ?? 2, relays.length || 1));
  let relayIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (relayIndex < relays.length && options.isCurrent()) {
      const relay = relays[relayIndex++];
      await runRelay(relay);
    }
  }));

  const progress = Object.values(relayProgress);
  const naturalEnd = relays.length > 0 && progress.length === relays.length && progress.every(item => item.naturalEnd);
  const hitMaxBatches = progress.some(item => item.hitMaxBatches);
  const incomplete = aborted
    || timedOut
    || failedRelays.size > 0
    || !allRelaysCompleted
    || progress.some(item => item.incomplete)
    || !options.isCurrent();
  const nextUntilByRelay = Object.fromEntries(
    Object.entries(relayProgress).map(([relay, value]) => [relay, value.nextUntil])
  );
  const nextUntilValues = Object.values(nextUntilByRelay).filter((value): value is number => typeof value === "number");
  return {
    received,
    unique: insertedCandidates,
    completedRelays,
    failedRelays,
    allRelaysCompleted,
    exhaustedHistory: naturalEnd && !incomplete,
    naturalEnd,
    hitMaxBatches,
    nextUntil: nextUntilValues.length ? Math.min(...nextUntilValues) : defaultUntil,
    nextUntilByRelay,
    relayProgress,
    timedOut,
    aborted,
    incomplete,
  };
}
