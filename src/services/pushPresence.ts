// Renew a short visible-device lease without account signatures. Foreground
// message pushes wait in a durable queue; a keepalive hidden report releases
// them immediately, and lease expiry releases them if iOS drops that request.
const HEARTBEAT_MS = 25_000;

type Signer = { pkHex: string; isUnlocked: boolean; signEvent: (event: any) => Promise<any> };

export function installPushPresence(keys: Signer) {
  if (typeof document === "undefined") return { stop: () => undefined, refresh: () => undefined };
  let timer: ReturnType<typeof setInterval> | null = null;
  const report = (foreground: boolean) => {
    const pubkey = keys.pkHex;
    if (!foreground || !pubkey || !keys.isUnlocked) {
      void import("@/services/pushNotifications")
        .then(({ clearCallHandledChallenge }) => clearCallHandledChallenge())
        .catch(() => undefined);
    }
    if (!pubkey || !keys.isUnlocked) return;
    void import("@/services/pushNotifications")
      .then(({ reportPushForeground, prefetchCallHandledChallenge }) => {
        // Warm before a call arrives; periodic presence updates also replenish
        // a consumed/expired one-time challenge while this account is unlocked.
        if (foreground) void prefetchCallHandledChallenge(pubkey).catch(() => undefined);
        return reportPushForeground(pubkey, foreground);
      })
      .catch(() => undefined);
  };
  const update = () => {
    if (document.visibilityState === "visible") {
      report(true);
      timer ??= setInterval(() => report(true), HEARTBEAT_MS);
    } else {
      if (timer) clearInterval(timer);
      timer = null;
      report(false);
    }
  };
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pagehide", update);
  update();
  return {
    /** Call when the signed-in account or its lock state changes. */
    refresh: update,
    stop: () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", update);
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
