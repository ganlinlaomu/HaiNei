/**
 * Explicit, user-initiated WebKit compatibility fallback. Camera permission
 * can change which local ICE addresses the browser exposes. Never call this
 * during startup, automatic discovery or an ordinary retry.
 */
export async function requestNearbyCameraAccess(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_unavailable");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  // No preview, recording, upload or tracks attached to a peer connection.
  // getUserMedia cannot be aborted: a late permission grant must still release
  // every track after the page/account that requested it has gone away.
  stream.getTracks().forEach(track => track.stop());
  return !signal.aborted;
}
