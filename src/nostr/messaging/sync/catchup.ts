import type { NostrEvent } from "nostr-tools";
import { subscribe } from "@/nostr/relays";
import { closeSubscription } from "@/utils/subscriptions";
import { logger } from "@/utils/logger";
import type { SubscriptionLike } from "./types";

export type CatchupPageResult = {
  events: Array<{ event: NostrEvent; relayUrl?: string }>;
  completedRelays: Set<string>;
  allRelaysCompleted: boolean;
  timedOut: boolean;
  aborted: boolean;
};

export type SubscribeForCatchup = (relays: string[], filters: any[]) => SubscriptionLike;

export async function fetchCatchupPage(
  relays: string[],
  filters: any[],
  timeoutMs = 8000,
  subscribeFn: SubscribeForCatchup = subscribe,
  trackSubscription?: (subscription: SubscriptionLike) => (() => void) | void,
  signal?: AbortSignal
): Promise<CatchupPageResult> {
  const expectedRelays = new Set(relays);
  const completedRelays = new Set<string>();
  const events: Array<{ event: NostrEvent; relayUrl?: string }> = [];
  const subscription = subscribeFn(relays, filters);
  const untrack = trackSubscription?.(subscription);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: "eose" | "timeout" | "abort" | "empty") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeSubscription(subscription);
      untrack?.();
      signal?.removeEventListener("abort", abort);
      resolve({
        events,
        completedRelays,
        allRelaysCompleted: completedRelays.size >= expectedRelays.size,
        timedOut: reason === "timeout",
        aborted: reason === "abort",
      });
    };
    const abort = () => finish("abort");
    subscription.on("event", (event: NostrEvent, relayUrl?: string) => events.push({ event, relayUrl }));
    subscription.on("eose", (relayUrl: string) => {
      completedRelays.add(relayUrl);
      logger.debug(`[message-sync] EOSE relay=${relayUrl} count=${completedRelays.size}/${expectedRelays.size}`);
      if (completedRelays.size >= expectedRelays.size) finish("eose");
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
}) {
  const seenEventIds = new Set<string>();
  let currentUntil = options.filters.reduce<number | undefined>((value, filter) => {
    if (typeof filter.until !== "number") return value;
    return value === undefined ? filter.until : Math.min(value, filter.until);
  }, undefined);
  let received = 0;
  let insertedCandidates = 0;
  let completedRelays = new Set<string>();
  let allRelaysCompleted = true;
  let timedOut = false;
  let aborted = false;
  let naturalEnd = false;
  let batches = 0;
  const maxBatches = options.maxBatches ?? 100;

  for (let batch = 0; batch < maxBatches && options.isCurrent(); batch++) {
    batches++;
    const pageFilters = options.filters.map(filter => ({ ...filter, ...(currentUntil === undefined ? {} : { until: currentUntil }) }));
    const page = await fetchCatchupPage(
      options.relays,
      pageFilters,
      options.timeoutMs,
      options.subscribeFn,
      options.trackSubscription,
      options.signal
    );
    for (const relay of page.completedRelays) completedRelays.add(relay);
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
      await options.onEvent(event, relayUrl);
    }
    if (oldest === undefined) { naturalEnd = true; break; }
    const didNotAdvance = currentUntil !== undefined && oldest === currentUntil;
    if (didNotAdvance && newUnique === 0) { naturalEnd = true; break; }
    currentUntil = oldest;
    // Without a full page there cannot be another timestamp boundary hidden by limit.
    const pageLimit = Math.max(...pageFilters.map(filter => Number(filter.limit || 0)));
    if (!pageLimit || page.events.length < pageLimit) { naturalEnd = true; break; }
  }
  const hitMaxBatches = !naturalEnd && batches >= maxBatches;
  const incomplete = aborted || timedOut || !allRelaysCompleted || !options.isCurrent();
  return {
    received,
    unique: insertedCandidates,
    completedRelays,
    allRelaysCompleted,
    exhaustedHistory: naturalEnd && !incomplete,
    naturalEnd,
    hitMaxBatches,
    timedOut,
    aborted,
    incomplete,
  };
}
