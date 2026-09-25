export function buildHeightPrefix(heights: readonly number[]): number[] {
  const prefix = new Array<number>(heights.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    prefix[index + 1] = prefix[index] + heights[index];
  }
  return prefix;
}

export function updateHeightPrefix(prefix: readonly number[], index: number, delta: number): number[] {
  if (!delta || index < 0 || index + 1 >= prefix.length) return [...prefix];
  const updated = [...prefix];
  for (let cursor = index + 1; cursor < updated.length; cursor += 1) {
    updated[cursor] += delta;
  }
  return updated;
}

export function lowerBoundHeight(prefix: readonly number[], target: number): number {
  let low = 0;
  let high = prefix.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (prefix[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function resolveVirtualRange(
  prefix: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): { start: number; end: number } {
  const itemCount = Math.max(0, prefix.length - 1);
  if (itemCount === 0) return { start: 0, end: 0 };

  const lower = Math.max(0, scrollTop - overscan);
  const upper = Math.max(lower, scrollTop + viewportHeight + overscan);
  const lowerBoundary = lowerBoundHeight(prefix, lower);
  const start = Math.min(itemCount - 1, Math.max(0, lowerBoundary - 1));
  const end = Math.min(itemCount, Math.max(start + 1, lowerBoundHeight(prefix, upper)));
  return { start, end };
}
