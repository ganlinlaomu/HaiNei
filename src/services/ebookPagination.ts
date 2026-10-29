/** Pure pagination arithmetic shared by the iframe reader and its tests. */
export function pageCountForWidth(contentWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1;
  // Ignore subpixel rounding at the end of a CSS multicolumn flow.
  return Math.max(1, Math.ceil(contentWidth / viewportWidth - 0.001));
}

export function pageForPercent(percent: number, count: number): number {
  const pages = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const fraction = Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0;
  return Math.round(fraction * (pages - 1));
}

export function percentForPage(index: number, count: number): number {
  const pages = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  if (pages === 1) return 1;
  return Math.max(0, Math.min(pages - 1, index)) / (pages - 1);
}
