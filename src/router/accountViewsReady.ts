import { watch } from "vue";
import type { Router } from "vue-router";

type RestoringAccount = {
  pkHex: string;
  isUnlocked: boolean;
  isRestored: boolean;
  isLoggedIn: boolean;
  accountStoresReadyFor: string;
  restoreSession(): Promise<void>;
};

/**
 * Resolve once account views can render: the restore finished, or this
 * account's vault is unlocked and its local stores are loaded. The rest of
 * the restore (burn purge, DM refresh) then runs while Home paints; DM
 * unread stays behind the read-state barrier set at the start of the
 * restore. If that rest fails and clears the session, leave for /login.
 */
export async function untilAccountViewsCanRender(keyStore: RestoringAccount, router: Pick<Router, "currentRoute" | "replace">) {
  const restore = keyStore.restoreSession().catch(e => {
    console.error("[router] Failed to restore session:", e);
    // Continue with navigation, will be redirected to login if needed
  });
  let localReady = false;
  await new Promise<void>(resolve => {
    let settled = false;
    let stop: (() => void) | null = null;
    const done = () => { settled = true; stop?.(); resolve(); };
    void restore.then(done);
    stop = watch(
      () => !!keyStore.pkHex && keyStore.isUnlocked && keyStore.accountStoresReadyFor === keyStore.pkHex,
      ready => { if (ready) { localReady = true; done(); } },
      { immediate: true },
    );
    // `immediate` may have settled before `stop` existed.
    if (settled) stop();
  });
  if (!localReady || keyStore.isRestored) return;
  void restore.then(() => {
    const current = router.currentRoute.value;
    if (!keyStore.isLoggedIn && current.meta?.requiresAuth) {
      void router.replace({ path: "/login", query: { redirect: current.fullPath } });
    }
  });
}
