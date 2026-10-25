/** Bottom navigation: Home / DMs / Calls / Contacts / Me. Subroutes do not mislabel the current tab. */
export function getBottomNavTabIndex(path: string): number {
  if (path === "/") return 0;
  if (path === "/conversations") return 1;
  if (path === "/calls") return 2;
  if (path === "/friends") return 3;
  if (path === "/settings" || path.startsWith("/settings/")) return 4;
  return -1;
}
