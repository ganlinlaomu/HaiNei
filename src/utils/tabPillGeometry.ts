export type TabGeometry = { key: string; offsetLeft: number; offsetWidth: number };

export function selectedTabPill(
  tabs: readonly TabGeometry[], selected: string,
): { translateX: number; width: number } | null {
  const tab = tabs.find(item => item.key === selected);
  if (!tab || !Number.isFinite(tab.offsetLeft) || !Number.isFinite(tab.offsetWidth)
    || tab.offsetWidth <= 0) return null;
  return { translateX: tab.offsetLeft, width: tab.offsetWidth };
}
