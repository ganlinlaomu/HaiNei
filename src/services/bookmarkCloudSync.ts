import { db } from "@/db/dexie";
import type { AccountStateKeys } from "@/services/accountStateSync";
import {
  fetchAndMaterializeAccountState,
  syncAccountStateNamespace,
} from "@/services/accountStateSync";

export const BOOKMARK_CLOUD_SYNC_META_KEY = "bookmark_cloud_sync_v1";
const FOREGROUND_CHECK_COOLDOWN_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000];

export type BookmarkCloudSyncState = {
  dirty: boolean;
  revision: number;
  lastMutationAt: number;
  lastSyncedMutationAt: number;
  lastAttemptAt: number;
  lastSuccessAt: number;
  retryCount: number;
};

const timers = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();
const lastCheckedAt = new Map<string, number>();

function emptyState(): BookmarkCloudSyncState {
  return {
    dirty: false,
    revision: 0,
    lastMutationAt: 0,
    lastSyncedMutationAt: 0,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    retryCount: 0,
  };
}

async function latestBookmarkMutationAt(account: string) {
  const records = await db.accountBookmarks.where("accountPubkey").equals(account).toArray();
  return records.reduce(
    (latest, record) => Math.max(latest, Number(record.updatedAt ?? record.createdAt ?? 0)),
    0,
  );
}

export async function getBookmarkCloudSyncState(account: string): Promise<BookmarkCloudSyncState | null> {
  const record = await db.accountMeta.get([account.toLowerCase(), BOOKMARK_CLOUD_SYNC_META_KEY]);
  return (record?.value as BookmarkCloudSyncState | undefined) || null;
}

async function putState(account: string, state: BookmarkCloudSyncState) {
  await db.accountMeta.put({
    accountPubkey: account.toLowerCase(),
    key: BOOKMARK_CLOUD_SYNC_META_KEY,
    value: state,
  });
  return state;
}

/**
 * Initializes the local sync baseline without uploading pre-existing legacy
 * bookmarks. Once the marker exists, later local mutations are detected even
 * if the app closes between the bookmark write and dirty-marker write.
 */
export async function ensureBookmarkCloudSyncState(account: string) {
  const normalized = account.toLowerCase();
  const latestMutationAt = await latestBookmarkMutationAt(normalized);
  const existing = await getBookmarkCloudSyncState(normalized);
  if (!existing) {
    return putState(normalized, {
      ...emptyState(),
      lastMutationAt: latestMutationAt,
      lastSyncedMutationAt: latestMutationAt,
    });
  }

  if (!existing.dirty && latestMutationAt > Number(existing.lastSyncedMutationAt || 0)) {
    return putState(normalized, {
      ...existing,
      dirty: true,
      revision: Number(existing.revision || 0) + 1,
      lastMutationAt: latestMutationAt,
    });
  }
  return existing;
}

export async function markBookmarkCloudDirty(account: string) {
  const normalized = account.toLowerCase();
  const current = await ensureBookmarkCloudSyncState(normalized);
  const latestMutationAt = await latestBookmarkMutationAt(normalized);
  return putState(normalized, {
    ...current,
    dirty: true,
    revision: Number(current.revision || 0) + 1,
    lastMutationAt: Math.max(Number(current.lastMutationAt || 0), latestMutationAt),
  });
}

function sessionMatches(keys: AccountStateKeys, account: string, generation: number | undefined) {
  return keys.pkHex.toLowerCase() === account
    && keys.sessionGeneration === generation
    && keys.supportsNip44;
}

function retryDelay(retryCount: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, retryCount - 1), RETRY_DELAYS_MS.length - 1)];
}

export function scheduleBookmarkCloudSync(
  keys: AccountStateKeys,
  options: { delayMs?: number } = {},
) {
  if (typeof window === "undefined" || !keys.supportsNip44 || !keys.pkHex) return;
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  const existing = timers.get(account);
  if (existing) window.clearTimeout(existing);
  const delayMs = Math.max(0, Math.min(300_000, Number(options.delayMs ?? 500)));
  timers.set(account, window.setTimeout(() => {
    timers.delete(account);
    if (!sessionMatches(keys, account, generation)) return;
    void flushBookmarkCloudSync(keys).catch(() => undefined);
  }, delayMs));
}

export async function flushBookmarkCloudSync(keys: AccountStateKeys): Promise<boolean> {
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  if (!account || !sessionMatches(keys, account, generation)) return false;

  const active = inFlight.get(account);
  if (active) return active;

  const task = (async () => {
    const state = await ensureBookmarkCloudSyncState(account);
    if (!state.dirty) return true;

    const revision = state.revision;
    const mutationAt = await latestBookmarkMutationAt(account);
    await putState(account, {
      ...state,
      lastAttemptAt: Date.now(),
      lastMutationAt: Math.max(Number(state.lastMutationAt || 0), mutationAt),
    });

    try {
      const synced = await syncAccountStateNamespace(keys, "bookmarks");
      if (!synced || !sessionMatches(keys, account, generation)) return false;

      const current = await getBookmarkCloudSyncState(account) || state;
      if (current.revision !== revision) {
        scheduleBookmarkCloudSync(keys, { delayMs: 0 });
        return true;
      }

      await putState(account, {
        ...current,
        dirty: false,
        lastSyncedMutationAt: Math.max(Number(current.lastSyncedMutationAt || 0), mutationAt),
        lastSuccessAt: Date.now(),
        retryCount: 0,
      });
      return true;
    } catch (error) {
      if (sessionMatches(keys, account, generation)) {
        const current = await getBookmarkCloudSyncState(account) || state;
        const retryCount = Number(current.retryCount || 0) + 1;
        await putState(account, {
          ...current,
          dirty: true,
          retryCount,
          lastAttemptAt: Date.now(),
        });
        scheduleBookmarkCloudSync(keys, { delayMs: retryDelay(retryCount) });
      }
      throw error;
    }
  })();

  inFlight.set(account, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(account) === task) inFlight.delete(account);
  }
}

export async function reconcileBookmarkCloudState(
  keys: AccountStateKeys,
  options: { force?: boolean; now?: number; isCurrent?: () => boolean } = {},
) {
  const account = keys.pkHex.toLowerCase();
  const generation = keys.sessionGeneration;
  if (!account || !sessionMatches(keys, account, generation)) {
    return { restored: false, flushed: false };
  }

  const now = Number(options.now ?? Date.now());
  const state = await ensureBookmarkCloudSyncState(account);
  const lastChecked = Number(lastCheckedAt.get(account) || 0);
  const shouldCheckRemote = options.force || state.dirty || !lastChecked || now - lastChecked >= FOREGROUND_CHECK_COOLDOWN_MS;

  let restored = false;
  if (shouldCheckRemote) {
    const result = await fetchAndMaterializeAccountState(keys, ["bookmarks"], {
      onlyNewer: true,
      isCurrent: () => sessionMatches(keys, account, generation) && (!options.isCurrent || options.isCurrent()),
    });
    restored = result.restored.includes("bookmarks");
    lastCheckedAt.set(account, now);

    // A clean device that merely imported a remote snapshot should not mark the
    // same cloud data dirty again on the next foreground pass.
    const current = await getBookmarkCloudSyncState(account);
    if (restored && current && !current.dirty) {
      const latestMutationAt = await latestBookmarkMutationAt(account);
      await putState(account, {
        ...current,
        lastMutationAt: Math.max(Number(current.lastMutationAt || 0), latestMutationAt),
        lastSyncedMutationAt: Math.max(Number(current.lastSyncedMutationAt || 0), latestMutationAt),
      });
    }
  }

  const current = await ensureBookmarkCloudSyncState(account);
  const flushed = current.dirty ? await flushBookmarkCloudSync(keys) : true;
  return { restored, flushed };
}

export function resetBookmarkCloudSyncForTests() {
  if (typeof window !== "undefined") {
    for (const timer of timers.values()) window.clearTimeout(timer);
  }
  timers.clear();
  inFlight.clear();
  lastCheckedAt.clear();
}
