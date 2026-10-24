/** Direction and scroll gate shared by editor and DM operation sheet. */
export function canBeginVerticalDismissDrag(
  dx: number, dy: number, scrollTop: number, threshold = 6,
): boolean {
  return scrollTop <= 0 && dy > threshold && dy > Math.abs(dx) * 1.15;
}

export function shouldDismissVerticalSheet(
  distance: number, velocity: number, sheetHeight: number,
): boolean {
  const distanceThreshold = Math.max(96, Math.min(180, sheetHeight * 0.25));
  return distance >= distanceThreshold || (distance >= 36 && velocity >= 0.65);
}

/** Backward-compatible API still used by the post editor. */
export function canStartPostEditorDrag(scrollTop: number, deltaY: number): boolean {
  return canBeginVerticalDismissDrag(0, deltaY, scrollTop, 0);
}

export function shouldDismissPostEditor(
  distance: number, velocity: number, sheetHeight: number,
): boolean {
  return shouldDismissVerticalSheet(distance, velocity, sheetHeight);
}
