/**
 * User-facing name for the platform authenticator behind passkey unlock.
 * The credential itself is a WebAuthn passkey; this only picks familiar words.
 */
export function biometricMethodLabel(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0,
) {
  const appleTouch = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (appleTouch) return "Face ID";
  if (/Android/.test(userAgent)) return "指纹";
  return "通行密钥";
}
