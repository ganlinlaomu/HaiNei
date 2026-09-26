export type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

async function syncServiceWorkerBadgeState(count: number, target: BadgeNavigator) {
  const serviceWorker = target.serviceWorker;
  if (!serviceWorker) return;
  try {
    const registration = await serviceWorker.ready;
    const worker = serviceWorker.controller || registration.active;
    worker?.postMessage({ type: "SYNC_APP_BADGE", count: Math.max(0, Math.floor(count)) });
  } catch {
    // Foreground badge updates should still succeed if the service worker is unavailable.
  }
}

export async function syncAppBadge(count: number, target: BadgeNavigator = navigator as BadgeNavigator) {
  const normalized = Math.max(0, Math.floor(count));
  if (normalized > 0) await target.setAppBadge?.(normalized);
  else await target.clearAppBadge?.();
  await syncServiceWorkerBadgeState(normalized, target);
}

export function accountBadgeCount(
  accountPubkey: string,
  loadedFor: string,
  unreadCount: number,
  directLoadedFor = accountPubkey,
  directUnreadCount = 0,
) {
  if (!accountPubkey || accountPubkey !== loadedFor) return 0;
  return unreadCount + (accountPubkey === directLoadedFor ? directUnreadCount : 0);
}
