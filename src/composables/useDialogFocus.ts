import { nextTick, onBeforeUnmount, watch, type Ref } from "vue";

const focusable =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function useDialogFocus(
  dialog: Ref<HTMLElement | null>,
  visible: () => boolean,
  close: () => void,
) {
  let trigger: HTMLElement | null = null;
  let generation = 0;
  function keydown(event: KeyboardEvent) {
    const panel = dialog.value;
    if (!panel || !visible()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      panel.querySelectorAll<HTMLElement>(focusable),
    ).filter((el) => el.getClientRects().length > 0);
    const first = controls[0],
      last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const active = document.activeElement;
    if (
      !panel.contains(active) ||
      active === panel ||
      (event.shiftKey && active === first)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
  watch(
    visible,
    async (show) => {
      const current = ++generation;
      if (show) {
        trigger =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        await nextTick();
        if (generation !== current || !visible()) return;
        dialog.value?.focus(); // Keep the mobile keyboard closed until requested.
        document.addEventListener("keydown", keydown, true);
      } else {
        document.removeEventListener("keydown", keydown, true);
        if (trigger?.isConnected) trigger.focus();
        trigger = null;
      }
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    generation++;
    document.removeEventListener("keydown", keydown, true);
    if (trigger?.isConnected) trigger.focus();
  });
}
