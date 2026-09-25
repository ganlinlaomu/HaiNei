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
