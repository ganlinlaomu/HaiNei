// While HaiNei is on screen it gets messages and calls over its own relay
// connection, so the worker should not push to this device: on iOS a pushed
// system banner stays on top of the open app. Report foreground every 25 s
// (the worker forgets it after 40 s) and report leaving on hide.
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
