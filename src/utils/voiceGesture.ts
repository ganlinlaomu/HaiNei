export type VoiceGestureAction = "send" | "cancel" | "lock";

export function classifyVoiceGesture(
  dx: number,
  dy: number,
  cancelDistance = 68,
  lockDistance = 68,
): VoiceGestureAction {
  if (dy <= -lockDistance && Math.abs(dy) > Math.abs(dx)) return "lock";
  if (dx <= -cancelDistance && Math.abs(dx) > Math.abs(dy)) return "cancel";
  return "send";
}
