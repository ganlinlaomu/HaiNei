export type ComposerTextareaResizeOptions = {
  minHeight?: number;
  focusedMinHeight?: number;
  maxHeight?: number;
};

/**
 * Keep chat-style composers compact at rest, expand on focus, and grow with
 * multiline content without letting the keyboard push the whole view away.
 */
export function resizeComposerTextarea(
  element: HTMLTextAreaElement | null,
  focused: boolean,
  options: ComposerTextareaResizeOptions = {},
) {
  if (!element) return;
  const minHeight = options.minHeight ?? 40;
  const focusedMinHeight = options.focusedMinHeight ?? 72;
  const maxHeight = options.maxHeight ?? 160;
  const floor = focused ? focusedMinHeight : minHeight;

  element.style.height = "auto";
  const contentHeight = Math.max(element.scrollHeight, minHeight);
  const nextHeight = Math.min(maxHeight, Math.max(floor, contentHeight));
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}
