// The chat's long-press menu and swipe-to-reply moved out of Messages.vue
// into useMessageGestures and MessageActionMenu.vue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import MessageActionMenu from "@/components/MessageActionMenu.vue";
import { SWIPE_REPLY_THRESHOLD, useMessageGestures } from "@/composables/useMessageGestures";

const message = { id: "m1" } as any;
const touchEvent = (x: number, y: number, target: unknown = null) =>
  ({ touches: [{ clientX: x, clientY: y }], target, cancelable: true, preventDefault: vi.fn() }) as any;

function setup(canReply = true) {
  const onLongPress = vi.fn(), onSwipeReply = vi.fn();
  const gestures = useMessageGestures({ canReplyTo: () => canReply, onLongPress, onSwipeReply });
  return { gestures, onLongPress, onSwipeReply };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useMessageGestures", () => {
  it("opens the action menu after a still hold, and does not also reply", () => {
    const { gestures, onLongPress, onSwipeReply } = setup();
    gestures.handleMessageTouchStart(message, touchEvent(100, 300));
    expect(gestures.swipingMessageId.value).toBe("m1");
    vi.advanceTimersByTime(460);
    expect(onLongPress).toHaveBeenCalledWith(message);
    gestures.handleMessageTouchEnd(message);
    expect(onSwipeReply).not.toHaveBeenCalled();
    expect(gestures.swipingMessageId.value).toBe("");
  });

  it("replies on a long enough right swipe, which also cancels the long press", () => {
    const { gestures, onLongPress, onSwipeReply } = setup();
    gestures.handleMessageTouchStart(message, touchEvent(100, 300));
    const move = touchEvent(100 + SWIPE_REPLY_THRESHOLD + 10, 302);
    gestures.handleMessageTouchMove(message, move);
    expect(move.preventDefault).toHaveBeenCalled();
    expect(gestures.swipeOffset.value).toBe(SWIPE_REPLY_THRESHOLD + 10);
    expect(gestures.swipeReplyIndicatorStyle().opacity).toBe("1");
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    gestures.handleMessageTouchEnd(message);
    expect(onSwipeReply).toHaveBeenCalledWith(message);
  });

  it("ignores short swipes, vertical scrolls and left swipes", () => {
    const { gestures, onSwipeReply } = setup();
    gestures.handleMessageTouchStart(message, touchEvent(100, 300));
    gestures.handleMessageTouchMove(message, touchEvent(130, 302));
    gestures.handleMessageTouchEnd(message);
    gestures.handleMessageTouchStart(message, touchEvent(100, 300));
    gestures.handleMessageTouchMove(message, touchEvent(110, 380));
    gestures.handleMessageTouchEnd(message);
    gestures.handleMessageTouchStart(message, touchEvent(200, 300));
    gestures.handleMessageTouchMove(message, touchEvent(100, 300));
    expect(gestures.swipeOffset.value).toBe(0);
    gestures.handleMessageTouchEnd(message);
    expect(onSwipeReply).not.toHaveBeenCalled();
  });

  it("does nothing for messages that cannot be replied to, and resets on cancel", () => {
    const blocked = setup(false);
    blocked.gestures.handleMessageTouchStart(message, touchEvent(100, 300));
    vi.advanceTimersByTime(1000);
    expect(blocked.onLongPress).not.toHaveBeenCalled();

    const { gestures, onLongPress } = setup();
    gestures.handleMessageTouchStart(message, touchEvent(100, 300));
    gestures.handleMessageTouchCancel(message);
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(gestures.swipingMessageId.value).toBe("");
  });
});

describe("MessageActionMenu", () => {
  const render = (props: Record<string, unknown>) => renderToString(createSSRApp({
    render: () => h(MessageActionMenu, {
      position: { top: 40, left: 12, width: 280 }, author: "你", preview: "晚上见",
      canCopy: true, importable: true, importing: false, ...props,
    }),
  }));

  it("shows the author, preview and only the available actions at its placed position", async () => {
    const html = await render({});
    expect(html).toContain("top:40px;left:12px;width:280px;");
    expect(html).toContain('aria-label="消息操作：晚上见"');
    expect(html).toMatch(/<strong[^>]*>你<\/strong>/);
    for (const label of ["回复", "复制", "摘录到私人空间"]) expect(html).toContain(label);

    const minimal = await render({ canCopy: false, importable: false });
    expect(minimal).toContain("回复");
    expect(minimal).not.toContain("复制");
    expect(minimal).not.toContain("摘录到私人空间");
  });

  it("disables saving while an import is running", async () => {
    const html = await render({ importing: true });
    expect(html).toContain("摘录中…");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?摘录中…/);
  });
});
