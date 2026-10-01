export type MessageScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function initialMessageWindowStart(total: number, size = 60): number {
  return Math.max(0, total - size);
}

export function prependMessageWindowStart(currentStart: number, batchSize = 40): number {
  return Math.max(0, currentStart - batchSize);
}

export function scrollTopAfterPrepend(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number
): number {
  return previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
}

export function isNearMessageBottom(metrics: MessageScrollMetrics, threshold = 120): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function scrollTopAfterNewMessages(
  previous: MessageScrollMetrics,
  nextScrollHeight: number,
  threshold = 120
): number {
  return isNearMessageBottom(previous, threshold) ? nextScrollHeight : previous.scrollTop;
}


export type BoundedMessageWindow = {
  start: number;
  end: number;
};

export function initialBoundedMessageWindow(
  total: number,
  size = 60,
): BoundedMessageWindow {
  const safeTotal = Math.max(0, total);
  const end = safeTotal;
  const start = Math.max(0, end - Math.max(1, size));
  return { start, end };
}

export function shiftBoundedMessageWindow(
  range: BoundedMessageWindow,
  total: number,
  direction: "older" | "newer",
  batchSize = 40,
  maxSize = 100,
): BoundedMessageWindow {
  const safeTotal = Math.max(0, total);
  const limit = Math.max(1, maxSize);
  const batch = Math.max(1, batchSize);
  let start = Math.max(0, Math.min(range.start, safeTotal));
  let end = Math.max(start, Math.min(range.end, safeTotal));

  if (direction === "older") {
    start = Math.max(0, start - batch);
    end = Math.min(safeTotal, start + limit);
  } else {
    end = Math.min(safeTotal, end + batch);
    start = Math.max(0, end - limit);
  }

  return { start, end };
}

export function focusBoundedMessageWindow(
  total: number,
  targetIndex: number,
  leadingContext = 6,
  maxSize = 100,
): BoundedMessageWindow {
  const safeTotal = Math.max(0, total);
  if (safeTotal === 0) return { start: 0, end: 0 };
  const target = Math.max(0, Math.min(targetIndex, safeTotal - 1));
  const limit = Math.max(1, maxSize);
  let start = Math.max(0, target - Math.max(0, leadingContext));
  let end = Math.min(safeTotal, start + limit);
  if (end - start < limit) start = Math.max(0, end - limit);
  return { start, end };
}

export function mergeBoundedMessageIndexes(
  range: BoundedMessageWindow,
  total: number,
  retainedIndexes: number[] = [],
): number[] {
  const safeTotal = Math.max(0, total);
  const start = Math.max(0, Math.min(range.start, safeTotal));
  const end = Math.max(start, Math.min(range.end, safeTotal));
  const indexes = new Set<number>();

  for (let index = start; index < end; index += 1) indexes.add(index);
  for (const index of retainedIndexes) {
    if (Number.isInteger(index) && index >= 0 && index < safeTotal) indexes.add(index);
  }

  return [...indexes].sort((left, right) => left - right);
}

export function scrollTopAfterAnchorShift(
  previousScrollTop: number,
  previousAnchorOffset: number,
  nextAnchorOffset: number,
): number {
  return Math.max(0, previousScrollTop + (nextAnchorOffset - previousAnchorOffset));
}
