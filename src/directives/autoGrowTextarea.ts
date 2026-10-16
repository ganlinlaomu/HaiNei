import type { ObjectDirective } from "vue";

type GrowState = { observer?: ResizeObserver; resize: () => void };
const states = new WeakMap<HTMLTextAreaElement, GrowState>();

/** Refit after content changes, initial rendering and width changes (e.g. rotation). */
export const vAutoGrow: ObjectDirective<HTMLTextAreaElement, string> = {
  mounted(element) {
    const resize = () => {
      // A hidden control is measured again by ResizeObserver when it becomes visible.
      if (!element.clientWidth) return;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    };
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      const nextWidth = element.clientWidth;
      if (nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    states.set(element, { resize, observer });
    observer?.observe(element);
    resize();
  },
  updated(element, binding) {
    if (binding.value !== binding.oldValue) states.get(element)?.resize();
  },
  beforeUnmount(element) {
    states.get(element)?.observer?.disconnect();
    states.delete(element);
  },
};
