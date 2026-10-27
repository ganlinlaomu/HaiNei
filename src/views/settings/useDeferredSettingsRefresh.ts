import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from "vue";
import { useKeyStore } from "@/stores/keys";
import { runWhenIdle } from "@/utils/bottomTabActivation";

/**
 * The settings page is kept alive. A section's runtime data (cache stats,
 * app version…) refreshes when the page is shown and the browser is idle,
 * never during the route transition, and again after an account switch.
 * `reset` runs first on every account change, including to none.
 */
export function useDeferredSettingsRefresh(options: {
  refresh: () => void;
  reset?: (account: string) => void;
  onHide?: () => void;
}) {
  const keyStore = useKeyStore();
  let active = false;
  let cancelDeferred: (() => void) | null = null;

  function schedule() {
    if (!active || cancelDeferred) return;
    cancelDeferred = runWhenIdle(() => {
      cancelDeferred = null;
      if (!active || !keyStore.pkHex) return;
      options.refresh();
    }, 1_000);
  }
  function stop() {
    active = false;
    cancelDeferred?.();
    cancelDeferred = null;
    options.onHide?.();
  }

  watch(() => keyStore.pkHex, account => {
    options.reset?.(account);
    if (account) schedule();
  }, { immediate: true });
  onMounted(() => { active = true; schedule(); });
  onActivated(() => { active = true; schedule(); });
  onDeactivated(stop);
  onBeforeUnmount(stop);
}
