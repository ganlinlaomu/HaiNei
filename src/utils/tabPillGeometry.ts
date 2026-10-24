export type TabGeometry = { key: string; offsetLeft: number; offsetWidth: number };

export function selectedTabPill(
  tabs: readonly TabGeometry[], selected: string,
): { translateX: number; width: number } | null {
  const tab = tabs.find(item => item.key === selected);
  if (!tab || !Number.isFinite(tab.offsetLeft) || !Number.isFinite(tab.offsetWidth)
    || tab.offsetWidth <= 0) return null;
  return { translateX: tab.offsetLeft, width: tab.offsetWidth };
}

/**
 * The tab bar is v-if mounted: reconnect whenever a new DOM node appears,
 * and release the previous observer before touching any new elements.
 */
export function createTabPillObserver(onMeasure: () => void) {
  let observer: ResizeObserver | null = null;
  function attach(bar: HTMLElement | null) {
    observer?.disconnect();
    observer = null;
    if (!bar) return;
    onMeasure();
    if (typeof ResizeObserver === "undefined") return;
    observer = new ResizeObserver(onMeasure);
    observer.observe(bar);
    for (const tab of Array.from(bar.querySelectorAll<HTMLElement>("[data-space-tab]")))
      observer.observe(tab);
  }
  return {
    attach,
    disconnect() {
      observer?.disconnect();
      observer = null;
    },
  };
}
