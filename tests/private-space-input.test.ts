import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { shouldSubmitTaskOnEnter } from "@/utils/taskInput";
import { vAutoGrow } from "@/directives/autoGrowTextarea";

describe("private space task editing", () => {
  it("limits creation controls to their own tabs", () => {
    const source = readFileSync("src/views/PrivateSpace.vue", "utf8");
    expect(source).toMatch(/<button v-if="filter === 'note'"[^>]*@click="create\('note'\)">＋ 笔记/s);
    expect(source).toMatch(/<button v-if="filter === 'todo'"[^>]*@click="create\('todo'\)">＋ 待办/s);
    expect(source).toContain('v-model="task.text" v-auto-grow="task.text"');
    expect(source).toContain('v-model="newTaskText" v-auto-grow="newTaskText"');
    expect(source).toContain("overflow-wrap:anywhere");
    expect(source).not.toContain('<input type="text" v-model="task.text"');
    expect(source).not.toContain('@keydown.enter.prevent="addTask"');
  });

  it("submits Enter but keeps Shift+Enter and IME confirmation", () => {
    const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
    expect(shouldSubmitTaskOnEnter(enter)).toBe(true);
    expect(shouldSubmitTaskOnEnter({ ...enter, shiftKey: true })).toBe(false);
    expect(shouldSubmitTaskOnEnter({ ...enter, isComposing: true })).toBe(false);
    expect(shouldSubmitTaskOnEnter({ ...enter, keyCode: 229 })).toBe(false);
    expect(shouldSubmitTaskOnEnter({ ...enter, key: "a" })).toBe(false);
  });

  it("fits restored text, grows and shrinks with edits, refits on width change, cleans up", () => {
    let onResize: () => void = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { onResize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    try {
      // Invoke hooks directly: geometry comes from the browser, not a DOM shim.
      const element = { clientWidth: 240, scrollHeight: 92, style: { height: "" } };
      const mounted = vAutoGrow.mounted as Function;
      const updated = vAutoGrow.updated as Function;
      const unmount = vAutoGrow.beforeUnmount as Function;
      mounted(element);
      expect(observe).toHaveBeenCalledWith(element);
      expect(element.style.height).toBe("92px");
      element.scrollHeight = 140;
      updated(element, { value: "longer", oldValue: "long" });
      expect(element.style.height).toBe("140px");
      element.scrollHeight = 44;
      updated(element, { value: "short", oldValue: "longer" });
      expect(element.style.height).toBe("44px");
      element.scrollHeight = 68;
      element.clientWidth = 180;
      onResize();
      expect(element.style.height).toBe("68px");
      element.scrollHeight = 92;
      onResize();
      expect(element.style.height).toBe("68px"); // height-only resize must not loop
      unmount(element);
      expect(disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("private space note media layout", () => {
  it("auto-sizes the note body instead of pushing attached images below a fixed-height input", () => {
    const source = readFileSync("src/views/PrivateSpace.vue", "utf8");
    expect(source).toMatch(/<textarea v-model="editor.body" v-auto-grow="editor.body"[^>]*rows="1"/s);
    const bodyStyle = source.match(/\.body-input\{([^}]+)\}/)?.[1];
    expect(bodyStyle).toBeDefined();
    expect(bodyStyle).toContain("resize:none");
    expect(bodyStyle).toContain("overflow-y:hidden");
    expect(bodyStyle).not.toContain("min-height:35vh");
    expect(source).toContain('v-if="editorImageContent" class="excerpt-media"');
  });
});
