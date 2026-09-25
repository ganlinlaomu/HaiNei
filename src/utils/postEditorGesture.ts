export function canStartPostEditorDrag(scrollTop: number, deltaY: number): boolean {
  return scrollTop <= 0 && deltaY > 0;
}

export function shouldDismissPostEditor(
  distance: number,
  velocity: number,
  sheetHeight: number
): boolean {
  const distanceThreshold = Math.max(96, Math.min(180, sheetHeight * 0.25));
  return distance >= distanceThreshold || (distance >= 36 && velocity >= 0.65);
}
