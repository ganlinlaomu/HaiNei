// Presence is advisory only. Push delivery must never depend on the final
// hidden report: iOS can suspend the page before that request leaves. The
// service worker checks live window visibility when a push arrives and closes
// the silent notification when HaiNei is already visible.
// Keep the heartbeat for call-challenge warming and backwards compatibility.
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
        return reportPushForeground(pubkey, keys.signEvent.bind(keys), foreground);
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
