type VisibilityCallback = (visible: boolean) => void;

const callbacks = new Map<Element, Set<VisibilityCallback>>();
let observer: IntersectionObserver | null = null;

function sharedObserver() {
  if (typeof IntersectionObserver === "undefined") return null;
  if (observer) return observer;
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const listeners = callbacks.get(entry.target);
      if (!listeners) continue;
      const visible = entry.isIntersecting;
      for (const listener of listeners) listener(visible);
    }
  }, { rootMargin: "240px 0px" });
  return observer;
}

export function observeNearViewport(element: Element, callback: VisibilityCallback) {
  const activeObserver = sharedObserver();
  if (!activeObserver) {
    callback(true);
    return () => undefined;
  }

  let listeners = callbacks.get(element);
  if (!listeners) {
    listeners = new Set();
    callbacks.set(element, listeners);
    activeObserver.observe(element);
  }
  listeners.add(callback);

  return () => {
    const current = callbacks.get(element);
    if (!current) return;
    current.delete(callback);
    if (current.size) return;
    callbacks.delete(element);
    activeObserver.unobserve(element);
  };
}
