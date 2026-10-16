/** Keep IME confirmation and Shift+Enter separate from adding a task. */
export function shouldSubmitTaskOnEnter(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
