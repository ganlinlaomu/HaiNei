/**
 * Only top-level tabs and settings descendants receive a selected indicator.
 * Other routes retain their existing navigation behavior (no misleading active tab).
 */
export function getBottomNavTabIndex(path: string): number {
  if (path === "/") return 0;
  if (path === "/conversations") return 1;
  if (path === "/notifications") return 2;
  if (path === "/settings" || path.startsWith("/settings/")) return 3;
  return -1;
}
