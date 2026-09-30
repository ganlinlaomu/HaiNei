export interface AccountLoadedStore {
  loadedFor: string;
  load(account: string): Promise<unknown>;
}

export async function loadAccountStoresOnce(account: string, stores: readonly AccountLoadedStore[]) {
  if (!account) return;
  await Promise.all(stores
    .filter(store => store.loadedFor !== account)
    .map(store => store.load(account)));
}

export function isAccountResourceStale(
  account: string,
  cachedFor: string,
  updatedAt: number,
  maxAgeMs: number,
  now = Date.now()
) {
  return !account || cachedFor !== account || updatedAt <= 0 || now - updatedAt >= maxAgeMs;
}

export function runAfterFirstPaint(task: () => void) {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(() => task());
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}


export function runWhenIdle(task: () => void, timeoutMs = 1_000) {
  const requestIdle = (globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  const cancelIdle = (globalThis as typeof globalThis & {
    cancelIdleCallback?: (handle: number) => void;
  }).cancelIdleCallback;

  if (typeof requestIdle === "function") {
    const handle = requestIdle(task, { timeout: timeoutMs });
    return () => cancelIdle?.(handle);
  }

  const handle = setTimeout(task, Math.min(160, timeoutMs));
  return () => clearTimeout(handle);
}
