/**
 * Manual scroll anchoring for a scroll container whose rows change height
 * after they render (images decrypting, link cards, map previews).
 *
 * Chrome and Firefox keep the visible content still by themselves
 * (CSS overflow-anchor). iOS Safari does not: when a message above the
 * viewport grows, everything being read is pushed down, so older chat history
 * "jumps" while it loads. Where native anchoring is missing, this observes the
 * rows and adds the same height change to scrollTop for rows that lie
 * entirely above the visible area.
 */
export function supportsNativeScrollAnchoring() {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
}

export function installManualScrollAnchoring(
  list: HTMLElement,
  options: {
    rowSelector: string;
    /** False while the caller restores its own anchor (e.g. prepending a page). */
    enabled: () => boolean;
    native?: boolean;
    /**
     * A bottom-anchored list (flex-direction: column-reverse, see
     * reverseScroll.ts): rows above the viewport may change height freely;
     * rows wholly below it push the visible content up, so those are
     * compensated. Always manual: native anchoring is off for such a list.
     */
    reversed?: boolean;
  },
) {
  if ((!options.reversed && (options.native ?? supportsNativeScrollAnchoring()))
    || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined;
  }
  const heights = new WeakMap<Element, number>();
  const resize = new ResizeObserver(entries => {
    const listRect = list.getBoundingClientRect();
    const listTop = listRect.top;
    let delta = 0;
    for (const entry of entries) {
      const row = entry.target as HTMLElement;
      const rect = row.getBoundingClientRect();
      const previous = heights.get(row);
      heights.set(row, rect.height);
      if (previous === undefined || previous === rect.height) continue;
      if (options.reversed) {
        // Only rows wholly below the viewport; a visible row may grow upwards.
        if (rect.top >= listRect.bottom - 1) delta += rect.height - previous;
      } else if (rect.bottom <= listTop + 1) {
        // Only rows wholly above the viewport; a visible row may grow downwards.
        delta += rect.height - previous;
      }
    }
    // Reversed: scrollTop counts up from the bottom (0) as negative values.
    if (delta && options.enabled()) list.scrollTop += options.reversed ? -delta : delta;
  });
  const observeRows = (root: ParentNode) => {
    for (const row of root.querySelectorAll(options.rowSelector)) resize.observe(row);
  };
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(options.rowSelector)) resize.observe(node);
        observeRows(node);
      }
      for (const node of record.removedNodes) {
        if (node instanceof Element && node.matches(options.rowSelector)) resize.unobserve(node);
      }
    }
  });
  observeRows(list);
  mutations.observe(list, { childList: true, subtree: true });
  return () => {
    mutations.disconnect();
    resize.disconnect();
  };
}
