export const MIN_VIEWER_SCALE = 1;
export const MAX_VIEWER_SCALE = 4;

export function clampViewerScale(value: number) {
  return Math.min(MAX_VIEWER_SCALE, Math.max(MIN_VIEWER_SCALE, value));
}

export function resetViewerTransform() {
  return { scale: 1, x: 0, y: 0 };
}

export function swipeImageDirection(scale: number, deltaX: number, deltaY: number) {
  if (scale > 1 || Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 50) return 0;
  return deltaX > 0 ? -1 : 1;
}

export function shouldCloseViewer(scale: number, deltaX: number, deltaY: number) {
  return scale === 1 && deltaY > 80 && Math.abs(deltaY) > Math.abs(deltaX);
}
