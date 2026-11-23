/**
 * Bottom-anchored chat list: the scroll container is
 * `display:flex; flex-direction:column-reverse` around ONE content element
 * whose rows stay in their normal (oldest-first) DOM order.
 *
 * Distance from the bottom is then what the browser keeps fixed: rows added
 * at the top (older history) do not move what is on screen, so they can go in
 * while iOS is still momentum-scrolling. A top-anchored list must instead
 * correct scrollTop for every insertion above, which iOS drops mid-momentum
 * (the chat waited 1.5–1.8 s on an iPhone for scrolling to stop).
 *
 * In such a container scrollTop is 0 at the bottom and negative above it
 * (current Chrome, Safari, Firefox). Older engines used other conventions,
 * so support is probed once and the chat falls back to the top-anchored list.
 */
let probed: boolean | undefined;

export function supportsReverseScroll(): boolean {
  if (probed !== undefined) return probed;
  probed = false;
  if (typeof document === "undefined" || !document.body) return probed;
  const box = document.createElement("div");
  const content = document.createElement("div");
  box.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:100px;overflow:auto;display:flex;flex-direction:column-reverse;visibility:hidden";
  content.style.cssText = "flex:none;height:300px";
  box.appendChild(content);
  document.body.appendChild(box);
  try {
    // Needs real layout (an engine without one, e.g. a test DOM, just stores
    // whatever scrollTop is set to). Starts at the bottom (0); moving up must
    // read back as negative.
    const scrollable = box.scrollHeight > box.clientHeight + 100;
    const atStart = box.scrollTop;
    box.scrollTop = -50;
    probed = scrollable && atStart === 0 && Math.round(box.scrollTop) === -50;
  } catch {
    probed = false;
  } finally {
    box.remove();
  }
  return probed;
}

/** Scroll position helpers for both layouts. */
export function distanceFromBottom(list: HTMLElement, reversed: boolean) {
  return reversed
    ? Math.max(0, -list.scrollTop)
    : Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop);
}

export function distanceFromTop(list: HTMLElement, reversed: boolean) {
  return reversed
    ? Math.max(0, list.scrollHeight - list.clientHeight + list.scrollTop)
    : Math.max(0, list.scrollTop);
}

export function scrollToListBottom(list: HTMLElement, reversed: boolean) {
  list.scrollTop = reversed ? 0 : list.scrollHeight;
}
