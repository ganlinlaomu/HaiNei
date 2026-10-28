import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useSwipeActions } from "@/composables/useSwipeActions";

const touch = (x: number) => ({ touches: [{ clientX: x, clientY: 0 }], cancelable: false } as unknown as TouchEvent);

describe("entry points for sharing a to-do list", () => {
  it("swipe rows can open to a per-row width (to-do rows carry an extra share action)", () => {
    const swipe = useSwipeActions({ actionWidth: 128, openThreshold: 64, actionWidthFor: id => id === "todo" ? 192 : 128 });
    swipe.open("todo");
    expect(swipe.swipeStyle("todo").transform).toBe("translateX(-192px)");
    swipe.open("note");
    expect(swipe.swipeStyle("note").transform).toBe("translateX(-128px)");
    swipe.onTouchStart(touch(300), "todo");
    swipe.onTouchMove(touch(0), "todo");
    expect(swipe.swipeStyle("todo").transform).toBe("translateX(-192px)");
    swipe.onTouchEnd("todo");
    expect(swipe.isOpen("todo")).toBe(true);
  });

  it("私人空间 to-do rows have a swipe share action that opens the share panel", () => {
    const view = readFileSync("src/views/PrivateSpace.vue", "utf8");
    expect(view).toContain('data-action="share"');
    expect(view).toMatch(/v-if="note\.kind === 'todo'"[^>]*data-action="share"/);
    expect(view).toContain('@click.stop="shareFromSwipe(note)"');
    expect(view).toMatch(/async function shareFromSwipe[\s\S]*openShareWithEditor = true;[\s\S]*await open\(note\)/);
    expect(view).toMatch(/shareOpen\.value = openShareWithEditor && editor\.value\?\.kind === "todo"/);
  });

  it("the composer can share a new to-do list, and a failed share keeps it saved privately", () => {
    const editor = readFileSync("src/components/PostEditorModal.vue", "utf8");
    expect(editor).toContain("共享给好友（可选）");
    const save = editor.slice(editor.indexOf("async function saveToPrivateSpace"), editor.indexOf("async function onSend"));
    expect(save).toMatch(/const record = await privateSpaceRepository\.createWithContent[\s\S]*shareTodoList\(keys, record\.id, shareWith\)/);
    expect(save.indexOf("clearPersistentDraft(account)")).toBeLessThan(save.indexOf("shareTodoList("));
    expect(save).toContain("已保存待办，但共享失败，可在私人空间里再共享");
    expect(editor).toMatch(/todoShareWith\.value = \[\];\s*todoShareOpen\.value = false;/);
  });
});
