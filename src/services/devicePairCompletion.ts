/**
 * Completing a QR handoff is a local login operation. The remote one-time
 * ciphertext acknowledgement is cleanup, not an authentication prerequisite:
 * a slow/offline Worker must never strand an already authenticated device.
 */
export async function completeDevicePairLogin(steps: {
  importAccount: () => Promise<void>;
  accountReady: () => boolean;
  acknowledge: () => Promise<unknown>;
  onSuccess: () => void;
  navigateHome: () => Promise<unknown>;
}): Promise<void> {
  await steps.importAccount();
  if (!steps.accountReady()) throw new Error("pair_login_incomplete");

  // The Worker expires the sealed envelope after five minutes even if this
  // best-effort acknowledgement fails. Do not wait for network cleanup here.
  void Promise.resolve().then(() => steps.acknowledge()).catch(() => {});
  steps.onSuccess();
  await steps.navigateHome();
}
