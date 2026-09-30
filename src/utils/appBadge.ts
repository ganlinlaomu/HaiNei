export type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

let generation = 0;
async function syncServiceWorkerBadgeState(count: number, target: BadgeNavigator, account: string, current: number) {
  const serviceWorker = target.serviceWorker;
  if (!serviceWorker) return;
  try {
    const registration = await serviceWorker.ready;
    const worker = serviceWorker.controller || registration.active;
    const accountScope = await accountScopeForBadge(account);
    if (current !== generation) return;
    worker?.postMessage({ type: "SYNC_APP_BADGE", count: Math.max(0, Math.floor(count)), accountScope });
  } catch {
    // Foreground badge updates should still succeed if the service worker is unavailable.
  }
}

async function accountScopeForBadge(account: string) {
  const hash = account ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account)) : null;
  return hash ? Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") : "";
}

export async function syncAppBadgeScope(account: string, target: BadgeNavigator = navigator as BadgeNavigator) {
  const current = ++generation;
  const serviceWorker = target.serviceWorker;
  if (!serviceWorker) return;
  try {
    const registration = await serviceWorker.ready;
    const worker = serviceWorker.controller || registration.active;
    const accountScope = await accountScopeForBadge(account);
    if (current !== generation) return;
    worker?.postMessage({ type: "SYNC_APP_BADGE_SCOPE", accountScope });
  } catch {}
}

export async function syncAppBadge(count: number, target: BadgeNavigator = navigator as BadgeNavigator, account = "") {
  const current = ++generation;
  const normalized = Math.max(0, Math.floor(count));
  // Notification account routing must not depend on optional badge permission.
  await Promise.all([
    syncServiceWorkerBadgeState(normalized, target, account, current),
    (async () => {
      try {
        if (normalized > 0) await target.setAppBadge?.(normalized);
        else await target.clearAppBadge?.();
      } catch { /* Badge APIs may reject while push permission remains valid. */ }
    })(),
  ]);
}

export function accountBadgeCount(
  accountPubkey: string,
  loadedFor: string,
  unreadCount: number,
  directLoadedFor = accountPubkey,
  directUnreadCount = 0,
) {
  if (!accountPubkey) return 0;
  const activityUnread = accountPubkey === loadedFor ? Math.max(0, unreadCount) : 0;
  const directUnread = accountPubkey === directLoadedFor ? Math.max(0, directUnreadCount) : 0;
  return activityUnread + directUnread;
}
