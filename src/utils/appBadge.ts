export type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export async function syncAppBadge(count: number, target: BadgeNavigator = navigator as BadgeNavigator) {
  if (count > 0) await target.setAppBadge?.(count);
  else await target.clearAppBadge?.();
}

export function accountBadgeCount(accountPubkey: string, loadedFor: string, unreadCount: number) {
  return accountPubkey !== "" && accountPubkey === loadedFor ? unreadCount : 0;
}
